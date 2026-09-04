/**
 * fts-search.ts — FTS5/BM25 search, OR-fallback, and spread activation.
 *
 * Owns: searchFts, searchFtsSpread, tokenizeForFts, and the query-builder
 * helpers (ftsQuery, ftsQueryFallback, ftsQueryOr).
 */

import { expandQuery } from '../util/tokenize.js';
import { getDb } from './db.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FtsHit {
  id: string;
  path: string;
  title: string;
  snippet: string;
  bm25: number; // higher is better (negated rank)
}

export interface SearchOptions {
  limit?: number;
  includeExpired?: boolean;
  type?: string;
  tag?: string;
  /** Only notes whose source attribute starts with this prefix (CSMB per-fixture scope). */
  sourcePrefix?: string;
}

// ---------------------------------------------------------------------------
// Internal query builders
// ---------------------------------------------------------------------------

/**
 * Tokenize a free-text query into FTS-safe terms.
 * Splits paths (test_auth.py), punctuation, and keeps alphanumerics.
 */
export function tokenizeForFts(input: string): string[] {
  return input
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u))
    .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter((t) => t.length > 1);
}

/**
 * Convert user query to FTS5 query syntax.
 * - Natural-language questions use OR (higher recall on agent queries)
 * - Short keyword queries use AND
 * - Dots/slashes in paths are split so test_auth.py → test_auth + py
 */
function ftsQuery(input: string): string {
  const tokens = tokenizeForFts(input);
  if (tokens.length === 0) return '';
  const isQuestion =
    /^(?:what|why|how|when|where|which|who|should|can|could|is|are|do|does)\b/i.test(
      input.trim(),
    ) || tokens.length >= 6;
  const parts = tokens.map((t) => {
    const safe = t.replace(/"/g, '""');
    return t.length >= 3 ? `"${safe}"*` : `"${safe}"`;
  });
  return isQuestion ? parts.join(' OR ') : parts.join(' ');
}

/** Minimal OR query when the primary ftsQuery still fails. */
function ftsQueryFallback(input: string): string {
  const tokens = tokenizeForFts(input)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Build an OR query from the input tokens for E1 fallback.
 * Equivalent to ftsQueryFallback but without the 3-char minimum filter,
 * so short meaningful tokens (e.g. "pg", "db") are preserved.
 */
function ftsQueryOr(input: string): string {
  const tokens = tokenizeForFts(input);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ');
}

/**
 * Return true when a zero-hit AND query should be retried as OR.
 * Conditions: 2+ tokens, not a quoted phrase, not a question (already OR in ftsQuery).
 */
function shouldAttemptOrFallback(input: string): boolean {
  const trimmed = input.trim();
  // Already a quoted phrase — respect user intent
  if (trimmed.startsWith('"')) return false;
  const tokens = tokenizeForFts(trimmed);
  return tokens.length >= 2;
}

function sourceFilterClause(opts: SearchOptions): {
  clause: string;
  params: Record<string, string>;
} {
  if (!opts.sourcePrefix) return { clause: '', params: {} };
  return {
    clause: 'AND n.source LIKE @sourcePrefix',
    params: { sourcePrefix: `${opts.sourcePrefix}%` },
  };
}

// ---------------------------------------------------------------------------
// Public search functions
// ---------------------------------------------------------------------------

export function searchFts(query: string, opts: SearchOptions = {}): FtsHit[] {
  const db = getDb();
  const limit = opts.limit ?? 10;
  const where: string[] = [];
  const q = ftsQuery(query);
  if (!q) return [];
  const src = sourceFilterClause(opts);
  const params: Record<string, unknown> = { q, limit, ...src.params };
  if (!opts.includeExpired) where.push(`(n.valid_until IS NULL OR n.valid_until = '')`);
  if (opts.type) {
    where.push('n.type = @type');
    params.type = opts.type;
  }
  if (opts.tag) {
    where.push('n.tags LIKE @tagLike');
    params.tagLike = `%${opts.tag}%`;
  }
  if (src.clause) where.push(src.clause.replace(/^AND /, ''));
  const whereClause = where.length ? `AND ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      n.id AS id,
      n.path AS path,
      n.title AS title,
      snippet(notes_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet,
      -bm25(notes_fts) AS bm25
    FROM notes_fts
    JOIN notes n ON n.id = notes_fts.id
    WHERE notes_fts MATCH @q
      ${whereClause}
    ORDER BY bm25 DESC
    LIMIT @limit
  `;

  let hits: FtsHit[];
  try {
    hits = db.prepare(sql).all(params) as FtsHit[];
  } catch {
    // Malformed FTS5 query — fall back to token-only OR query
    const fallback = ftsQueryFallback(query);
    if (!fallback) return [];
    try {
      hits = db.prepare(sql).all({ ...params, q: fallback }) as FtsHit[];
    } catch {
      return [];
    }
    // Malformed-query fallback is already OR-style; apply same 0.5 scale for
    // consistency (scores are unreliable when the original query was invalid).
    return hits.map((h) => ({ ...h, bm25: h.bm25 * 0.5 }));
  }

  // E1 — Multi-word OR fallback:
  // FTS5 AND semantics return 0 hits when no single note contains all tokens.
  // Retry with OR and halve scores so ranking stays honest relative to AND hits.
  // Only triggered when:
  //   - AND query returned no results
  //   - query has >= 2 tokens
  //   - query is NOT a quoted phrase (starts with ")
  if (hits.length === 0 && shouldAttemptOrFallback(query)) {
    const orQuery = ftsQueryOr(query);
    if (!orQuery) return [];
    try {
      const orHits = db.prepare(sql).all({ ...params, q: orQuery }) as FtsHit[];
      // Scale scores by 0.5 to signal lower confidence vs AND matches.
      return orHits.map((h) => ({ ...h, bm25: h.bm25 * 0.5 }));
    } catch {
      return [];
    }
  }

  return hits;
}

/**
 * RRF-fused spread search.
 *
 * Expands the query into variants (original, split-token, concept-only) using
 * expandQuery(), runs searchFts() on each, then fuses results via Reciprocal
 * Rank Fusion with linearly decreasing variant weights:
 *   original = 1.0, split-token = 0.8, concept-only = 0.5
 *
 * Returns a deduped, score-sorted FtsHit list of at most `opts.limit` entries.
 */
export function searchFtsSpread(query: string, opts: SearchOptions = {}): FtsHit[] {
  const limit = opts.limit ?? 10;
  const variants = expandQuery(query);

  // Assign weights per variant position (decreasing)
  const weights: number[] = [];
  for (let i = 0; i < variants.length; i++) {
    if (i === 0) weights.push(1.0);
    else if (i === 1) weights.push(0.8);
    else weights.push(0.5);
  }

  const RRF_K = 60;
  // Map: id → fused RRF score
  const fused = new Map<string, number>();
  // Map: id → best FtsHit (for snippet / path data)
  const best = new Map<string, FtsHit>();

  for (let vi = 0; vi < variants.length; vi++) {
    const variant = variants[vi];
    const weight = weights[vi] ?? 0.5;
    const variantHits = searchFts(variant, { ...opts, limit: limit * 2 });
    for (let rank = 0; rank < variantHits.length; rank++) {
      const h = variantHits[rank];
      const contrib = weight / (RRF_K + rank);
      fused.set(h.id, (fused.get(h.id) ?? 0) + contrib);
      // Keep the hit with the highest individual bm25 score for display
      const existing = best.get(h.id);
      if (!existing || h.bm25 > existing.bm25) {
        best.set(h.id, h);
      }
    }
  }

  // Sort by fused RRF score descending, then map back to FtsHit with fused score
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const hit = best.get(id);
      if (!hit) return null;
      return { ...hit, bm25: score } satisfies FtsHit;
    })
    .filter((h): h is FtsHit => h !== null);
}
