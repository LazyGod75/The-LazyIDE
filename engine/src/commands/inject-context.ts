/**
 * inject-context.ts — Build stripped context for SessionStart / UserPromptSubmit hooks.
 *
 * Implementation is split into focused submodules under inject-context/:
 *   markers.ts  — shortId, warningPassesGate, NudgeStyle + the recall-nudge
 *                 formatters (markerNudge, highlightsRecallNudge, turnRecallHeader)
 *   scoring.ts  — isTrivialPrompt, noteMatchesActiveFile, applyActiveFileBoost,
 *                 detectQueryIntent, selectiveStripForTurn
 *   sections.ts     — runMarkerInject, buildMainPage, compactLine
 *   session-inject.ts — runSessionInject, tryFeatureMapInject, renderFull,
 *                       tryCompressFileNeuron, DEFAULT_TURN_MAX_TOKENS,
 *                       MIN_SCORE_BY_LEVEL
 *
 * This file owns the public entry point (runInjectContext) and turn mode's
 * orchestration: runTurnInjectDetailed (structured — text + levelUsed/tokens/
 * sectionsCount, see TurnInjectResult) and runTurnInject (its thin
 * string-only wrapper, used by the CLI/hooks). server/routes/recall.ts (the
 * warm-sidecar /_api/recall route) calls runTurnInjectDetailed directly so it
 * can report the retrieval level to its caller (src-tauri/src/commands/brain/
 * search.rs's recall_from_warm_sidecar) instead of only formatted text.
 */

import type { RouterResult } from '../retrieval/router.js';
import { route } from '../retrieval/router.js';
import { activeFiles, alreadyInjected, recordInjected } from '../util/session-cache.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { estimateTokenCount } from '../util/tokenize.js';
import {
  DEFAULT_NUDGE_STYLE,
  type NudgeStyle,
  turnRecallHeader,
} from './inject-context/markers.js';
import {
  applyActiveFileBoost,
  detectQueryIntent,
  hitsPassingMinScore,
  isTrivialPrompt,
  selectiveStripForTurn,
} from './inject-context/scoring.js';
import { runMarkerInject } from './inject-context/sections.js';
import {
  DEFAULT_TURN_MAX_TOKENS,
  MIN_SCORE_BY_LEVEL,
  runSessionInject,
  tryCompressFileNeuron,
  tryFeatureMapInject,
} from './inject-context/session-inject.js';

// Re-export the shared helpers that tests and other callers depend on.
export { shortId as shortIdForTest, warningPassesGate } from './inject-context/markers.js';
export { noteMatchesActiveFile, hitsPassingMinScore, isTrivialPrompt, queryLooksLikeCodeSymbol } from './inject-context/scoring.js';
export type { NudgeStyle } from './inject-context/markers.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InjectMode = 'session' | 'turn' | 'marker' | 'highlights';
export type InjectFormat = 'full' | 'compact';

export interface InjectContextCliOptions {
  maxTokens?: number;
  preferRecent?: boolean;
  preferImportant?: boolean;
  pretty?: boolean;
  mode?: InjectMode;
  format?: InjectFormat;
  query?: string;
  minScore?: number;
  cwd?: string;
  /** Q3: when present, the turn-inject will skip notes already shown to this session. */
  sessionId?: string;
  /**
   * How the injected text should tell the model to search memory further —
   * see `NudgeStyle` (inject-context/markers.ts). Defaults to 'skill' so
   * every pre-existing caller (Claude Code hooks, which never pass this
   * flag) sees byte-identical output to before this option existed.
   */
  nudge?: NudgeStyle;
  /**
   * When true, suppresses the 'inject'/'query' telemetry events this call
   * would otherwise log. Used ONLY for synthetic internal calls that are
   * not real user activity — e.g. the sidecar warmup probe
   * (src-tauri/src/commands/brain/sidecar/warmup.rs, routed here via
   * server/routes/recall.ts's `X-Lazy-Warmup` header check) — so
   * Settings > Memory's "Queries (24h)" diagnostic reflects genuine usage,
   * not the app's own cache-priming request. Defaults to false/undefined
   * (logged) for every real caller, including the CLI/hooks.
   */
  skipTelemetry?: boolean;
}

/**
 * Structured result of a turn-mode inject — the formatted `text` plus the
 * retrieval metadata that `text` alone discards. `runInjectContext` (the
 * CLI/hook entry point) only ever needed the formatted string, but a
 * programmatic caller — namely the `/_api/recall` warm-sidecar HTTP route
 * (server/routes/recall.ts) — needs `levelUsed` too, to preserve the same
 * "recall honesty" (semantic vs hybrid vs keyword) signal the UI already
 * surfaces for the `/_api/search` path (see RecallText in
 * src-tauri/src/commands/brain/search.rs). `runTurnInject` (below) is a thin
 * wrapper around this that keeps returning just `.text`, so CLI/hook
 * behavior is byte-for-byte unchanged.
 */
export interface TurnInjectResult {
  text: string;
  /** `null` when short-circuited before `route()` ran (trivial prompt, no
   *  query, or the feature-map fast path answered instead) or when `route()`
   *  ran but produced no hits clearing the score floor. */
  levelUsed: RouterResult['levelUsed'] | null;
  tokens: number;
  sectionsCount: number;
}

// Re-export shortId for sections.ts (sections.ts imports InjectContextCliOptions from here
// and shortId from markers.ts directly, but other callers may import shortId from here).
export { shortId } from './inject-context/markers.js';

/**
 * How many retrieval hits turn-mode should overfetch for a given token
 * budget. Measured 2026-08-28 on a 40 file-neuron L2 corpus
 * (engine/tests/recall-budget-saturation.test.ts):
 *   - hardcoded `topK: 5` always produced 125 tokens / 5 sections whether
 *     maxTokens was 150, 500, 1500, or 3000 — the budget was dead code
 *   - `route()` hit count === topK (5 / 10 / 20 / 40; 13–83 ms)
 *   - ~25 tokens per packed file-neuron section
 * Cap 40 keeps FTS overfetch cheap; floor 5 preserves the previous minimum.
 */
export function turnRecallTopK(budget: number): number {
  const tokensPerHit = 25;
  const min = 5;
  const max = 40;
  if (!Number.isFinite(budget) || budget <= 0) return min;
  return Math.min(max, Math.max(min, Math.ceil(budget / tokensPerHit)));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build a compact stripped-text context to inject into Claude Code hooks.
 *
 * Four modes:
 *   - session (default): used by SessionStart. Stable, large (~3k tokens).
 *   - turn: used by UserPromptSubmit. Tiny (~150 tokens), query-driven.
 *   - marker: ultra-minimal one-liner (~25 tokens).
 *   - highlights: marker + main-page block (~300 tokens).
 */
export async function runInjectContext(opts: InjectContextCliOptions): Promise<string> {
  const nudge = opts.nudge ?? DEFAULT_NUDGE_STYLE;
  if (opts.mode === 'marker') return runMarkerInject(false, opts.cwd, nudge, opts.maxTokens);
  if (opts.mode === 'highlights') return runMarkerInject(true, opts.cwd, nudge, opts.maxTokens);
  if (opts.mode === 'turn') return runTurnInject(opts);
  return runSessionInject(opts);
}

// ---------------------------------------------------------------------------
// Turn inject
// ---------------------------------------------------------------------------

/** Empty-result helper — keeps every early-return in runTurnInjectDetailed honest
 *  about what "nothing to inject" looks like (text/tokens/sectionsCount all zero,
 *  levelUsed null since route() either never ran or produced nothing usable). */
function emptyTurnResult(): TurnInjectResult {
  return { text: '', levelUsed: null, tokens: 0, sectionsCount: 0 };
}

/**
 * Turn-mode inject, structured. See `TurnInjectResult` for why this exists
 * as a separate export from `runTurnInject` (CLI wrapper below) — the
 * `/_api/recall` HTTP route (server/routes/recall.ts) calls this directly so
 * it can report `levelUsed` to the caller instead of only the formatted text.
 */
export async function runTurnInjectDetailed(
  opts: InjectContextCliOptions,
): Promise<TurnInjectResult> {
  const start = Date.now();
  const query = (opts.query ?? '').trim();
  if (!query || isTrivialPrompt(query)) {
    if (!opts.skipTelemetry) {
      logTelemetry({
        event: 'inject',
        ts: nowIso(),
        tokens: 0,
        sections: 0,
        duration_ms: Date.now() - start,
      });
    }
    return emptyTurnResult();
  }

  const budget = opts.maxTokens ?? DEFAULT_TURN_MAX_TOKENS;

  // Feature map injection: if query mentions a known project, return the map
  const featureMap = tryFeatureMapInject(query, opts.cwd);
  if (featureMap) {
    const tokens = estimateTokenCount(featureMap);
    if (tokens <= budget) {
      if (!opts.skipTelemetry) {
        logTelemetry({
          event: 'inject',
          ts: nowIso(),
          tokens,
          sections: 1,
          duration_ms: Date.now() - start,
        });
      }
      const text = opts.pretty ? `# Feature map — ~${tokens} tokens\n\n${featureMap}` : featureMap;
      // Feature-map answers come from a local heuristic scan, not route() —
      // there is no retrieval level to report (see TurnInjectResult's doc
      // comment on `levelUsed`).
      return { text, levelUsed: null, tokens, sectionsCount: 1 };
    }
  }

  // Q3: differential injection — overfetch then drop notes the LLM has already
  // seen earlier in this session, so each turn pays only for net-new context.
  //
  // topK MUST scale with the token budget. Measured 2026-08-28 on a 40
  // file-neuron L2 corpus (engine/tests/recall-budget-saturation.test.ts):
  // hardcoded topK=5 always returned 125 tokens / 5 sections whether
  // maxTokens was 150, 500, 1500, or 3000. route() hit count === topK
  // (5/10/20/40, 13–83ms). ~25 tokens/hit. Without this, raising the
  // sidecar/CLI maxTokens had no effect on injected size.
  const result = await route({
    query,
    topK: turnRecallTopK(budget),
    level: 'auto',
    cwd: opts.cwd,
    hydrateNote: true,
    skipTelemetry: opts.skipTelemetry,
  });

  // Pick the minScore floor that matches the level actually used.
  const minScore = opts.minScore ?? MIN_SCORE_BY_LEVEL[result.levelUsed] ?? 0.45;

  // Feature C: boost notes that belong to session-touched files.
  const sessionActiveFiles = activeFiles(opts.sessionId);
  const rankedHits =
    sessionActiveFiles.length > 0
      ? applyActiveFileBoost(result.hits, sessionActiveFiles)
      : result.hits;

  const seen = alreadyInjected(opts.sessionId);
  const relevant = hitsPassingMinScore(rankedHits, minScore, seen);

  if (relevant.length === 0) {
    if (!opts.skipTelemetry) {
      logTelemetry({
        event: 'inject',
        ts: nowIso(),
        tokens: 0,
        sections: 0,
        duration_ms: Date.now() - start,
      });
    }
    return { text: '', levelUsed: result.levelUsed, tokens: 0, sectionsCount: 0 };
  }

  const { sections, accepted, tokens } = buildTurnSections(relevant, budget, query);
  recordInjected(opts.sessionId, accepted);

  const body = sections.join('\n\n').trim();
  if (!opts.skipTelemetry) {
    logTelemetry({
      event: 'inject',
      ts: nowIso(),
      tokens,
      sections: sections.length,
      duration_ms: Date.now() - start,
    });
  }

  if (!body) return { text: '', levelUsed: result.levelUsed, tokens: 0, sectionsCount: 0 };

  // Recall-first header: one line instructing the agent how to pull deeper
  // context. Prepended only when there are actual memory hits. Wording
  // depends on `opts.nudge` — see NudgeStyle's doc comment (markers.ts).
  const header = turnRecallHeader(opts.nudge ?? DEFAULT_NUDGE_STYLE);
  const headerBlock = header ? `${header}\n\n` : '';

  // NEVER-DEGRADE-IN-SILENCE (2026-08 recall-latency remediation, item 5):
  // when route() fell back from a semantic level to fast keyword-only
  // results because the semantic dispatch blew its internal soft budget
  // (see SEMANTIC_SOFT_BUDGET_MS, retrieval/router.ts), say so explicitly
  // instead of quietly handing back a narrower/lower-recall answer with no
  // indication anything was cut short — the caller (LazyManager) needs this
  // to word its own answer honestly, not present a partial keyword match as
  // if it were the full semantic search.
  const degradedNote = result.degraded
    ? `[NOTE] Semantic search timed out after ${(result.degraded.timeoutMs / 1000).toFixed(0)}s on a large brain — showing fast keyword-only results instead. This may be less complete than a full semantic search.\n\n`
    : '';

  const text = opts.pretty
    ? `# Brain recall — ${sections.length} hits, ~${tokens} tokens\n\n${degradedNote}${headerBlock}${body}`
    : `${degradedNote}${headerBlock}${body}`;

  return { text, levelUsed: result.levelUsed, tokens, sectionsCount: sections.length };
}

/**
 * CLI/hook entry point for turn mode — thin wrapper around
 * `runTurnInjectDetailed` that keeps returning just the formatted string, so
 * every existing caller (the `inject-context` CLI command, Claude Code
 * hooks) is byte-for-byte unaffected by `TurnInjectResult` existing.
 */
async function runTurnInject(opts: InjectContextCliOptions): Promise<string> {
  return (await runTurnInjectDetailed(opts)).text;
}

/**
 * Minimum-usefulness gate for a turn-inject section.
 *
 * A section passes when it satisfies at least one of:
 *   - Is a FILE section (structured file-neuron, always useful)
 *   - Contains a note-id or path reference (e.g. foo/bar.ts or #short-id)
 *   - Contains >= MIN_WORDS_FOR_USEFUL_SECTION words of 3+ alphabetical chars
 *   - Has substantial raw content (>= MIN_CONTENT_LENGTH chars) indicating
 *     non-trivial payload even if word-segmentation doesn't split it further
 *
 * This rejects sections that are purely symbolic noise (e.g. `[ai/ map]` alone,
 * or a line of unicode replacement chars with no real words).
 */
const MIN_WORDS_FOR_USEFUL_SECTION = 2;
const MIN_CONTENT_LENGTH = 20;

function sectionPassesUsefulnessGate(tag: string, content: string): boolean {
  if (tag === '[FILE]') return true;
  // Note-id reference pattern: path fragments or #short-id
  if (/[a-z0-9-]{4,}\/[a-z0-9.-]{4,}|#[a-z0-9-]{4,}/i.test(content)) return true;
  // Count real words (3+ alphabetical chars, excludes pure-symbol lines)
  const words = (content.match(/[a-zA-Zà-ÿÀ-Ÿ]{3,}/g) ?? []).length;
  if (words >= MIN_WORDS_FOR_USEFUL_SECTION) return true;
  // Substantial raw content (handles test fixtures with repeated chars or dense code)
  return content.trim().length >= MIN_CONTENT_LENGTH;
}

function buildTurnSections(
  relevant: import('../retrieval/router.js').ResolvedHit[],
  budget: number,
  query: string,
): { sections: string[]; accepted: string[]; tokens: number } {
  const sections: string[] = [];
  const accepted: string[] = [];
  let tokens = 0;
  const intent = detectQueryIntent(query);

  for (const hit of relevant) {
    if (!hit.note) continue;

    // Attempt compressed file-neuron representation first.
    const compressed = tryCompressFileNeuron(hit.path, 0, 0);
    if (compressed !== null) {
      if (!sectionPassesUsefulnessGate('[FILE]', compressed)) continue;
      const estimated = estimateTokenCount(compressed);
      if (tokens + estimated > budget && sections.length > 0) break;
      sections.push(`[FILE]\n${compressed}`);
      accepted.push(hit.id);
      tokens += estimated;
      if (tokens >= budget) break;
      continue;
    }

    const prompt = selectiveStripForTurn(hit.path, hit.note, intent);
    if (!sectionPassesUsefulnessGate('[RECALL]', prompt)) continue;
    const estimated = estimateTokenCount(prompt);
    if (tokens + estimated > budget && sections.length > 0) break;
    sections.push(`[RECALL]\n${prompt}`);
    accepted.push(hit.id);
    tokens += estimated;
    if (tokens >= budget) break;
  }

  return { sections, accepted, tokens };
}
