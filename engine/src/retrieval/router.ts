/**
 * router.ts — Adaptive retrieval dispatcher + re-ranking pipeline.
 *
 * Level implementations live in src/retrieval/levels/:
 *   l1.ts      — CSS structural lookup
 *   l2.ts      — FTS5/BM25 + structural field boost
 *   l3.ts      — Bi-encoder cosine (bge-base WASM)
 *   l4.ts      — Cross-encoder re-rank (ms-marco WASM)
 *   hybrid.ts  — RRF fusion of L2 + L3
 *
 * Route shortcut modules:
 *   nl-routes.ts    — cwd-scope, path-prefix, error, Q-pattern, NL-structural
 *   rankers.ts      — PageRank, invalidation, version, temporal, warning, MMR
 *   nl-structural.ts — NL-to-tag/type resolver
 *   router-types.ts  — Public types (RouterResult, ResolvedHit, SearchInput, RouterLevel)
 */

import { resolveEntityKeysInQuery } from '../annotator/entities.js';
import { loadBacklinks } from '../graph/backlinks.js';
import { notesMentioningEntity, recordAccessMany } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { runL2L3Hybrid } from './levels/hybrid.js';
import { runL1 } from './levels/l1.js';
import { runL2 } from './levels/l2.js';
import { runL3 } from './levels/l3.js';
import { runL4 } from './levels/l4.js';
import {
  logRouteEvent,
  routeCwdScope,
  routeErrorPattern,
  routeNegativeMemory,
  routeNlStructural,
  routePathPrefix,
  routeQuestionPattern,
  routeWhyFixture,
  withSourceScope,
} from './nl-routes.js';
import {
  applyCurrentVersionBoost,
  applyInvalidationPenalty,
  applyMmr,
  applyNoisePenalty,
  applyPageRank,
  applyTemporalEarlierBoost,
  applyWarningBoost,
  dropObviousSuperseded,
} from './rankers.js';
import { applyGradedRecencyBoost } from './recency.js';
import { type StrippedNote, stripNote } from './strip.js';

// Re-export public types so all existing import sites keep working.
export type { ResolvedHit, RouterLevel, RouterResult, SearchInput } from './router-types.js';

// ---------------------------------------------------------------------------
// Level dispatch
// ---------------------------------------------------------------------------

/**
 * Soft internal ceiling for a semantic dispatch (L2_L3_HYBRID/L3/L4) — see
 * dispatchSemanticWithSoftTimeout()'s doc comment for the full rationale.
 *
 * Sized with wide headroom over measured cost: profiling route() end-to-end
 * against a synthetic corpus matching a real reported brain (5254 notes,
 * ~200MB of note text, 28002 backlink edges — see engine's profiling notes)
 * showed L2_L3_HYBRID completing in under 500ms cold and under 300ms warm.
 * 8s leaves >15x headroom for a legitimately large/cold corpus while still
 * degrading far short of the ~30s external ceiling
 * (RECALL_WARM_TIMEOUT_SECS, src-tauri/src/commands/brain/search.rs) —
 * so a genuinely pathological or regressed query returns a fast, honest,
 * partial answer instead of a bare timeout after the user has waited half a
 * minute for nothing.
 *
 * CAVEAT (documented, not silently assumed away): this is a Promise.race,
 * which only pre-empts the STUCK call at its own await points. It protects
 * against slow *async* segments (ONNX embedding calls, i/o) but cannot
 * interrupt a genuinely synchronous CPU-bound stall (e.g. a blocking
 * better-sqlite3 scan with no intervening await) — that class of bug must
 * still be fixed at the source, not papered over by a client-side race. It
 * IS still real, load-bearing protection for the async-bound failure modes
 * (embedder hiccups, future regressions in the async parts of the pipeline)
 * and is the same class of defense the Rust layer already applies one level
 * up (RECALL_WARM_TIMEOUT_SECS) — this one just fires early enough to leave
 * time for a same-request fallback instead of surfacing to the user as
 * nothing at all.
 */
const SEMANTIC_SOFT_BUDGET_MS = 8_000;

interface DispatchResult {
  hits: import('./router-types.js').ResolvedHit[];
  degraded?: { fromLevel: 'L2_L3_HYBRID' | 'L3' | 'L4'; timeoutMs: number };
}

/**
 * Race a semantic dispatch (L2_L3_HYBRID/L3/L4) against SEMANTIC_SOFT_BUDGET_MS.
 * On timeout, falls back to L2 (fast, keyword-only, always available) and
 * marks the result `degraded` so the caller can surface an honest note
 * instead of silently returning fewer/worse results — see item 5 of the
 * 2026-08 recall-latency remediation: "a slow query should degrade to a
 * partial/narrow result with a clear note, not a bare timeout."
 *
 * The losing semantic promise is never cancelled (JS has no true
 * cancellation for in-flight WASM/SQLite work) — it is left to finish in the
 * background with a no-op rejection handler so it cannot surface as an
 * unhandled rejection once this function has already moved on to the L2
 * fallback.
 */
async function dispatchSemanticWithSoftTimeout(
  input: import('./router-types.js').SearchInput,
  topK: number,
  finalLevel: 'L2_L3_HYBRID' | 'L3' | 'L4',
): Promise<DispatchResult> {
  const levelPromise =
    finalLevel === 'L2_L3_HYBRID'
      ? runL2L3Hybrid(input, topK)
      : finalLevel === 'L3'
        ? runL3(input, topK)
        : runL4(input, topK);
  // Silence "unhandled rejection" for the case where we already moved on to
  // the L2 fallback below and the abandoned semantic call rejects later.
  levelPromise.catch(() => {});

  const TIMEOUT = Symbol('semantic-soft-timeout');
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), SEMANTIC_SOFT_BUDGET_MS);
  });

  try {
    const raced = await Promise.race([levelPromise, timeoutPromise]);
    if (raced !== TIMEOUT) {
      return { hits: raced as import('./router-types.js').ResolvedHit[] };
    }
  } finally {
    clearTimeout(timer!);
  }

  getLogger().warn(
    { query: input.query, finalLevel, timeoutMs: SEMANTIC_SOFT_BUDGET_MS },
    'route(): semantic dispatch exceeded soft budget — degrading to keyword-only (L2) results instead of waiting out the full external timeout',
  );
  const hits = await runL2(input, topK);
  return { hits, degraded: { fromLevel: finalLevel, timeoutMs: SEMANTIC_SOFT_BUDGET_MS } };
}

/**
 * Phase 5 — level dispatch.
 * Runs the appropriate retrieval engine (L1/L2/L2_L3_HYBRID/L3/L4).
 * Semantic levels (L2_L3_HYBRID/L3/L4) are bounded by a soft internal
 * timeout — see dispatchSemanticWithSoftTimeout().
 */
async function dispatchLevel(
  input: import('./router-types.js').SearchInput,
  topK: number,
  finalLevel: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
): Promise<DispatchResult> {
  if (finalLevel === 'L1') return { hits: await runL1(input) };
  if (finalLevel === 'L2') return { hits: await runL2(input, topK) };
  return dispatchSemanticWithSoftTimeout(input, topK, finalLevel);
}

// ---------------------------------------------------------------------------
// Post-processing pipeline
// ---------------------------------------------------------------------------

/**
 * Phase 6 — entity-graph expansion.
 * Merges notes mentioning resolved entity keys into the hit list with a
 * prior score of 0.6. Returns a new sorted array — no mutation of input.
 */
function expandEntityGraph(
  hits: import('./router-types.js').ResolvedHit[],
  query: string,
  topK: number,
  finalLevel: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
): {
  hits: import('./router-types.js').ResolvedHit[];
  entityKeys: readonly string[];
} {
  const entityKeys = resolveEntityKeysInQuery(query);
  if (entityKeys.length === 0) return { hits, entityKeys };

  const haveIds = new Set(hits.map((h) => h.id));
  const expanded: import('./router-types.js').ResolvedHit[] = [...hits];
  for (const key of entityKeys) {
    for (const n of notesMentioningEntity(key, 5)) {
      if (haveIds.has(n.id)) continue;
      expanded.push({
        id: n.id,
        path: n.path,
        score: 0.6,
        level: finalLevel,
        snippet: (n.text ?? '').slice(0, 240),
      });
      haveIds.add(n.id);
      if (expanded.length >= topK * 3) break;
    }
    if (expanded.length >= topK * 3) break;
  }
  return {
    hits: [...expanded].sort((a, b) => b.score - a.score),
    entityKeys,
  };
}

/**
 * Phase 7 — re-ranking pipeline.
 * Applies in order: invalidation penalty, warning boost, graded recency,
 * current-version boost, temporal earlier boost, source scope, superseded
 * drop, PageRank, MMR / slice.
 * Returns a new array — no mutation of input.
 */
async function applyReranking(
  hits: import('./router-types.js').ResolvedHit[],
  input: import('./router-types.js').SearchInput,
  topK: number,
  finalLevel: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
  entityKeys: readonly string[],
): Promise<import('./router-types.js').ResolvedHit[]> {
  const log = getLogger();
  let ranked = applyInvalidationPenalty(hits, log);
  ranked = applyNoisePenalty(ranked);
  ranked = applyWarningBoost(ranked, input.query);
  ranked = applyGradedRecencyBoost(ranked, Date.now());

  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    ranked = applyCurrentVersionBoost(ranked);
  }
  if (/\b(originally|previously|at first|initially)\b/i.test(input.query)) {
    ranked = applyTemporalEarlierBoost(ranked);
  }

  ranked = withSourceScope(ranked, input.sourcePrefix);

  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    ranked = dropObviousSuperseded(ranked);
  }

  if ((finalLevel === 'L3' || finalLevel === 'L4') && ranked.length > 1) {
    const weight = input.pageRankWeight ?? 0.25;
    if (weight > 0) {
      ranked = applyPageRank(ranked, input.cwd, weight, entityKeys);
    }
  }

  if (input.diversityLambda !== undefined && ranked.length > topK) {
    ranked = await applyMmr(ranked, input.query, topK, input.diversityLambda);
  } else if (ranked.length > topK) {
    ranked = ranked.slice(0, topK);
  }

  return ranked;
}

/**
 * Phase 8 — note hydration.
 * Populates h.note (stripped content), h.rawHtml, and h.neighbours for each
 * hit. Mutates hits in place — called only on the final, sliced array.
 */
function hydrateHits(hits: import('./router-types.js').ResolvedHit[]): void {
  const backlinks = loadBacklinks();
  for (const h of hits) {
    if (!h.note) {
      try {
        const note = readNote(h.path);
        h.note = stripNote(note.html) as StrippedNote;
        h.rawHtml = note.html;
      } catch {
        // ignore
      }
    }
    if (backlinks) {
      const inbound = backlinks.incoming[h.id] ?? [];
      const outbound = backlinks.outgoing[h.id] ?? [];
      h.neighbours = [
        ...outbound.slice(0, 5).map((e) => ({ id: e.to, type: e.type, direction: 'out' as const })),
        ...inbound.slice(0, 5).map((e) => ({ id: e.from, type: e.type, direction: 'in' as const })),
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function route(
  input: import('./router-types.js').SearchInput,
): Promise<import('./router-types.js').RouterResult> {
  const start = Date.now();
  const topK = input.topK ?? 5;
  const level = input.level ?? 'auto';
  const finalLevel = level === 'auto' ? pickLevel(input.query, topK) : level;

  getLogger().debug({ query: input.query, level: finalLevel, topK }, 'route');

  // Phase 1: cwd-scope fast-path
  const cwdResult = await routeCwdScope(input, topK, start);
  if (cwdResult) return cwdResult;

  // Phase 2: path-prefix routing
  const pathResult = routePathPrefix(input, topK, start);
  if (pathResult) return pathResult;

  // Phase 3: negative-memory routing
  const negResult = routeNegativeMemory(input, topK, start);
  if (negResult) return negResult;

  // Phase 4a: error-pattern routing
  const errResult = routeErrorPattern(input, topK, start);
  if (errResult) return errResult;

  // Phase 4b: why-question fixture routing
  const whyResult = routeWhyFixture(input, topK, start);
  if (whyResult) return whyResult;

  // Phase 4c: Q-pattern routing
  const qResult = routeQuestionPattern(input, topK, start);
  if (qResult) return qResult;

  // Phase 4d: NL-to-structural routing
  const nlResult = routeNlStructural(input, topK, start);
  if (nlResult) return nlResult;

  // Phase 5: level dispatch
  const dispatchResult = await dispatchLevel(input, topK, finalLevel);
  // Truthful level for everything downstream: when the semantic dispatch
  // degraded to its L2 fallback (dispatchSemanticWithSoftTimeout), `hits`
  // actually came from L2 — re-ranking/tagging must reflect that, not the
  // originally-picked finalLevel, or PageRank (gated on L3/L4) would run
  // against hits it was never designed to score, and expandEntityGraph would
  // tag fallback hits with a level they didn't come from.
  const effectiveLevel = dispatchResult.degraded ? 'L2' : finalLevel;
  const rawHits = dispatchResult.hits;

  // Phase 6: entity-graph expansion
  const { hits: expandedHits, entityKeys } = expandEntityGraph(
    rawHits,
    input.query,
    topK,
    effectiveLevel,
  );

  // Phase 7: re-ranking pipeline
  const rankedHits = await applyReranking(expandedHits, input, topK, effectiveLevel, entityKeys);

  // B4: record retrieval hits for Ebbinghaus-style decay scoring (Q6).
  if (rankedHits.length > 0) recordAccessMany(rankedHits.map((h) => h.id));

  // Phase 8: note hydration
  if (input.hydrateNote) hydrateHits(rankedHits);

  const totalMs = Date.now() - start;
  if (!input.skipTelemetry) {
    logTelemetry({
      event: 'query',
      ts: nowIso(),
      level: effectiveLevel as 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
      latency_ms: totalMs,
      results: rankedHits.length,
    });
  }

  return {
    hits: rankedHits,
    levelUsed: effectiveLevel as 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
    totalMs,
    ...(dispatchResult.degraded ? { degraded: dispatchResult.degraded } : {}),
  };
}

// ---------------------------------------------------------------------------
// Level picker
// ---------------------------------------------------------------------------

function pickLevel(query: string, topK: number): 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4' {
  const trimmed = query.trim();
  // CSS selector heuristic: brackets, dot-classes after element, ID hash, attribute selector
  if (/^[a-z*]+(\[|#|\.|:)/i.test(trimmed) || trimmed.startsWith('[')) return 'L1';
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const hasPhrase = /["']/.test(trimmed);
  // Very short queries (1-2 tokens, no phrases) → pure L2 FTS.
  // Narrowed from <=5 to <=2 tokens: short natural-language queries
  // (3-5 tokens, e.g. "how does auth work") were being routed to
  // keyword-only L2 and never reaching semantic search. Keep this narrow —
  // only true keyword/tag lookups (1-2 tokens) stay pure-L2.
  if (tokens.length <= 2 && !hasPhrase) return 'L2';
  // Short-to-medium complexity (3-15 tokens) → hybrid L2+L3 fusion.
  // Widened from 6-15 so short natural-language questions get semantic
  // recall (via RRF fusion with keyword search) instead of being stuck
  // keyword-only. Conservative: still bounded at 15 tokens before falling
  // through to pure semantic/rerank below.
  if (tokens.length >= 3 && tokens.length <= 15) return 'L2_L3_HYBRID';
  // Small topK or default → pure L3 semantic
  if (topK <= 5) return 'L3';
  // Large topK → cross-encoder rerank on top of semantic
  return 'L4';
}

// Re-export logRouteEvent for any callers that may use it.
export { logRouteEvent };
