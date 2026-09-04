/**
 * Graded recency boost for retrieval ranking (Feature B).
 *
 * Replaces the binary 7-day cliff in applyCurrentVersionBoost() with a
 * smooth exponential curve so freshly-touched notes rank slightly higher
 * than stale notes of equal base relevance.
 *
 * Formula:
 *   multiplier = 1 + RECENCY_BOOST_MAX * exp(-ageDays / RECENCY_TAU)
 *
 * where ageDays is computed from the most-recent of (last_accessed, created),
 * matching how decay.ts computes the retention reference time.
 *
 * Design invariants:
 * - multiplier >= 1.0 for all ages  (no penalty — only lift).
 * - multiplier <= 1 + RECENCY_BOOST_MAX at age 0  (bounded boost, max ~20%).
 * - Relevance dominates: the boost only breaks near-ties. A relevance gap
 *   larger than RECENCY_BOOST_MAX cannot be overcome by recency alone.
 * - Applied in the post-processing stage (same location as the binary boost
 *   it replaces) and only for semantic levels (L2+); L1 exact-match paths
 *   return early before reaching this stage.
 */

import { getNoteById } from '../indexer/fts.js';
import type { ResolvedHit } from './router.js';

/**
 * Maximum fractional score lift for a brand-new note.
 * A note created right now gets score * (1 + RECENCY_BOOST_MAX).
 * Tuned to be small enough that relevance always dominates: any base-score
 * gap exceeding this value will not be reversed by recency alone.
 */
export const RECENCY_BOOST_MAX = 0.2;

/**
 * Decay time constant in days. At ageDays == RECENCY_TAU the multiplier
 * is 1 + RECENCY_BOOST_MAX * exp(-1) ≈ 1 + 0.074 (using default MAX=0.2).
 * At 3*TAU the boost has decayed to < 1% of MAX.
 */
export const RECENCY_TAU = 30;

const DAY_MS = 86_400_000;

/**
 * Compute the reference timestamp for a note (ms).
 * Prefers last_accessed over created when it is more recent, mirroring
 * the logic in decay.ts retentionScore().
 * Returns 0 when neither field is present or parseable.
 */
function referenceTimeMs(row: { created?: string | null; last_accessed?: string | null }): number {
  const ta = parseIso(row.last_accessed);
  const tb = parseIso(row.created);
  return Math.max(ta, tb);
}

function parseIso(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Apply a graded recency multiplier to each hit and return a new sorted array.
 *
 * @param hits   Retrieval hits to re-score. Never mutated.
 * @param nowMs  Current time in milliseconds (pass Date.now() in production;
 *               inject a fixed value in tests for determinism).
 * @returns      New array of hits with updated scores, sorted descending.
 */
export function applyGradedRecencyBoost(hits: ResolvedHit[], nowMs: number): ResolvedHit[] {
  const rescored = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row) return h;

    const refMs = referenceTimeMs(row);
    if (refMs <= 0) return h;

    const ageDays = Math.max(0, (nowMs - refMs) / DAY_MS);
    const multiplier = 1 + RECENCY_BOOST_MAX * Math.exp(-ageDays / RECENCY_TAU);

    return { ...h, score: h.score * multiplier };
  });

  return [...rescored].sort((a, b) => b.score - a.score);
}
