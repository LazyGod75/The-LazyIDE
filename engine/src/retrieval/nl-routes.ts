/**
 * nl-routes.ts — Phase routing shortcuts for the retrieval router.
 *
 * Each function attempts a fast-path for a specific query pattern.
 * Returns a RouterResult when the shortcut applies, or null to fall through
 * to the full level-dispatch pipeline.
 *
 * Imported exclusively by router.ts.
 */

import {
  listAllWithText,
  notesAnsweringQuestion,
  notesForErrorPattern,
  notesMatchingPathPrefix,
  notesWithWarningsOrNegative,
} from '../indexer/fts.js';
import { searchFts } from '../indexer/fts.js';
import { getNoteById } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { tryNlToStructural } from './nl-structural.js';
import { applyCurrentVersionBoost, dropObviousSuperseded } from './rankers.js';
import type { ResolvedHit, RouterResult, SearchInput } from './router-types.js';
import { type StrippedNote, stripNote, stripTags } from './strip.js';

// ---------------------------------------------------------------------------
// Internal helpers shared across phase functions
// ---------------------------------------------------------------------------

/** Filter hits to only those whose source starts with sourcePrefix (no-op when undefined). */
export function withSourceScope(
  hits: ResolvedHit[],
  sourcePrefix: string | undefined,
): ResolvedHit[] {
  if (!sourcePrefix) return hits;
  return hits.filter((h) => (getNoteById(h.id)?.source ?? '').startsWith(sourcePrefix));
}

export function logRouteEvent(
  level: string,
  latency_ms: number,
  results: number,
  skipTelemetry?: boolean,
): void {
  if (skipTelemetry) return;
  logTelemetry({
    event: 'query',
    ts: nowIso(),
    level: level as 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4',
    latency_ms,
    results,
  });
}

// ---------------------------------------------------------------------------
// Phase routing shortcuts
// ---------------------------------------------------------------------------

/**
 * Phase 1 — cwd-scope fast-path.
 * When sourcePrefix is set and the fixture is small (≤ max(topK, 8) notes),
 * return the entire fixture ranked by FTS score.
 * Returns null when the fast-path does not apply.
 */
export async function routeCwdScope(
  input: SearchInput,
  topK: number,
  start: number,
): Promise<RouterResult | null> {
  if (!input.sourcePrefix) return null;
  const scoped = listAllWithText({ includeExpired: false }).filter((n) =>
    (n.source ?? '').startsWith(input.sourcePrefix!),
  );
  if (scoped.length === 0 || scoped.length > Math.max(topK, 8)) return null;

  const ftsOrder = searchFts(input.query, {
    limit: scoped.length + 4,
    sourcePrefix: input.sourcePrefix,
  });
  const scoreById = new Map(ftsOrder.map((h, i) => [h.id, ftsOrder.length - i]));
  const sorted = [...scoped].sort(
    (a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0),
  );
  const scopedHits: ResolvedHit[] = sorted.map((n) => ({
    id: n.id,
    path: n.path,
    score: scoreById.get(n.id) ?? 0.5,
    level: 'L2' as const,
    snippet: (n.text ?? '').slice(0, 280),
  }));
  const totalMs = Date.now() - start;
  logRouteEvent('L2', totalMs, scopedHits.length, input.skipTelemetry);

  if (input.hydrateNote) {
    for (const h of scopedHits) {
      try {
        h.note = stripNote(readNote(h.path).html) as StrippedNote;
      } catch {
        /* ignore */
      }
    }
  }

  let finalScoped = scopedHits;
  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    finalScoped = applyCurrentVersionBoost(finalScoped);
    finalScoped = dropObviousSuperseded(finalScoped);
  }
  return { hits: finalScoped, levelUsed: 'L2', totalMs };
}

/**
 * Phase 2 — path-prefix routing.
 * Extracts file/directory paths from the query and looks up matching notes.
 * Returns null when no path prefixes are found or no notes match.
 */
export function routePathPrefix(
  input: SearchInput,
  topK: number,
  start: number,
): RouterResult | null {
  const pathPrefixes = extractPathPrefixesFromQuery(input.query);
  if (pathPrefixes.length === 0) return null;

  const seen = new Set<string>();
  const pathHits: ResolvedHit[] = [];
  for (const prefix of pathPrefixes) {
    for (const n of notesMatchingPathPrefix(prefix, topK * 2, input.sourcePrefix)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      pathHits.push({
        id: n.id,
        path: n.path,
        score: 1.0,
        level: 'L1',
        snippet: (n.section_summary ?? n.text ?? '').slice(0, 280),
      });
    }
  }
  if (pathHits.length === 0) return null;

  const totalMs = Date.now() - start;
  logRouteEvent('L1', totalMs, pathHits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(pathHits, input.sourcePrefix).slice(0, topK),
    levelUsed: 'L1',
    totalMs,
  };
}

/**
 * Phase 3 — negative-memory routing.
 * Routes should/can/could/would questions to warning and negation notes.
 * Returns null when the query does not match or no hits are found.
 */
export function routeNegativeMemory(
  input: SearchInput,
  topK: number,
  start: number,
): RouterResult | null {
  if (!/^(?:should|can|could|would)\s/i.test(input.query.trim())) return null;

  let negHits = notesWithWarningsOrNegative(input.query, topK * 2, input.sourcePrefix);
  if (negHits.length === 0 && input.sourcePrefix) {
    negHits = listAllWithText({ includeExpired: false })
      .filter((n) => (n.source ?? '').startsWith(input.sourcePrefix!))
      .slice(0, topK * 2);
  }
  if (negHits.length === 0) return null;

  const hits: ResolvedHit[] = negHits.map((n) => ({
    id: n.id,
    path: n.path,
    score: 1.0,
    level: 'L1' as const,
    snippet: (n.warnings ?? n.text ?? '').slice(0, 280),
  }));
  const totalMs = Date.now() - start;
  logRouteEvent('L1', totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: 'L1',
    totalMs,
  };
}

/**
 * Phase 4a — error-pattern routing.
 * Routes fix:/error:/Traceback/Exception queries to error-pattern notes.
 * Returns null when the query does not match or no hits are found.
 */
export function routeErrorPattern(
  input: SearchInput,
  topK: number,
  start: number,
): RouterResult | null {
  const isError =
    /^(?:fix:|error:|how to fix)/i.test(input.query) ||
    /\bhow (?:do i|to) fix\b/i.test(input.query) ||
    /TraceError|Exception|FAILED|Traceback|OperationalError|TypeError|ERESOLVE|deadlock|CORS/i.test(
      input.query,
    );
  if (!isError) return null;

  const errHits = notesForErrorPattern(input.query, topK, input.sourcePrefix);
  if (errHits.length === 0) return null;

  const hits: ResolvedHit[] = errHits.map((n) => ({
    id: n.id,
    path: n.path,
    score: 1.0,
    level: 'L1' as const,
    snippet: (n.section_summary ?? n.text ?? '').slice(0, 240),
  }));
  const totalMs = Date.now() - start;
  logRouteEvent('L1', totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: 'L1',
    totalMs,
  };
}

/**
 * Phase 4b — why-question fixture routing.
 * Routes "why …" queries inside a fixture scope via FTS on full bodies.
 * Returns null when not applicable or no hits are found.
 */
export function routeWhyFixture(
  input: SearchInput,
  topK: number,
  start: number,
): RouterResult | null {
  if (!/^why\s/i.test(input.query) || !input.sourcePrefix) return null;

  const ftsHits = searchFts(input.query, { limit: topK, sourcePrefix: input.sourcePrefix });
  if (ftsHits.length === 0) return null;

  const hits: ResolvedHit[] = ftsHits.map((h) => ({
    id: h.id,
    path: h.path,
    score: h.bm25,
    level: 'L2' as const,
    snippet: stripTags(h.snippet),
  }));
  const totalMs = Date.now() - start;
  logRouteEvent('L2', totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: 'L2',
    totalMs,
  };
}

/**
 * Phase 4c — Q-pattern routing.
 * Routes why/how/what/when/should/can/is questions to notes answering questions.
 * Returns null when the query does not match or no hits are found.
 */
export function routeQuestionPattern(
  input: SearchInput,
  topK: number,
  start: number,
): RouterResult | null {
  if (!/^(why|how|what|when|should|can|is)\s/i.test(input.query)) return null;

  const qHits = notesAnsweringQuestion(input.query, topK, input.sourcePrefix);
  if (qHits.length === 0) return null;

  const hits: ResolvedHit[] = qHits.map((n) => ({
    id: n.id,
    path: n.path,
    score: 1.0,
    level: 'L1' as const,
    snippet: (n.section_summary ?? n.text ?? '').slice(0, 240),
  }));
  const totalMs = Date.now() - start;
  logRouteEvent('L1', totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: 'L1',
    totalMs,
  };
}

/**
 * Phase 4d — NL-to-structural routing.
 * Routes queries mentioning a known tag or type to SQL-indexed lookups.
 * Returns null when no structural match applies.
 */
export function routeNlStructural(
  input: SearchInput,
  topK: number,
  start: number,
): RouterResult | null {
  const nlStructural = tryNlToStructural(input.query, topK, input.sourcePrefix);
  if (nlStructural.length === 0) return null;

  const totalMs = Date.now() - start;
  logRouteEvent('L1', totalMs, nlStructural.length, input.skipTelemetry);
  return {
    hits: withSourceScope(nlStructural, input.sourcePrefix).slice(0, topK),
    levelUsed: 'L1',
    totalMs,
  };
}

// ---------------------------------------------------------------------------
// Path-prefix extraction helper
// ---------------------------------------------------------------------------

/** Extract path-like tokens from natural-language queries. */
export function extractPathPrefixesFromQuery(query: string): string[] {
  const found = new Set<string>();
  for (const m of query.matchAll(
    /(?:^|[\s'"(),])([\w.-]+(?:\/[\w.-]+)+\/?|[\w.-]+\.(?:ts|tsx|js|jsx|py|sql|md|json|html|toml|yaml|yml))(?=[\s'"(),.?]|$)/gi,
  )) {
    const p = m[1].replace(/\\/g, '/');
    if (p.length >= 4) found.add(p);
  }
  // Directory questions: "the src/auth/ directory"
  for (const m of query.matchAll(
    /(?:the\s+)?((?:src|tests|apps|docs|migrations)\/[\w./-]+\/?)/gi,
  )) {
    found.add(m[1].replace(/\\/g, '/'));
  }
  return [...found];
}
