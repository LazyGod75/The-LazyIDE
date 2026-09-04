/**
 * Ebbinghaus-inspired retention score (Q6).
 *
 * Formula:
 *   retention(n) = importance × exp(-λ · Δdays) × log₂(access_count + 2)
 *
 * where Δdays is days since the most recent of (last_accessed, created), and
 * λ chosen so a never-touched note's retention halves every ~30 days. The
 * access term uses log₂(c + 2) so a single hit boosts ≈ 58% over zero hits
 * but diminishing returns kick in fast — heavily-accessed notes don't drown
 * the budget.
 *
 * Returns a score in [0, ~1.4], used as a relative ranking, not a probability.
 */

const HALF_LIFE_DAYS = 30;
const LAMBDA = Math.LN2 / HALF_LIFE_DAYS;
const DAY_MS = 86_400_000;

export interface DecayInput {
  importance?: number | null;
  created?: string | null;
  last_accessed?: string | null;
  access_count?: number | null;
}

export function retentionScore(n: DecayInput, nowMs: number = Date.now()): number {
  const importance = clamp(n.importance ?? 0.5, 0, 1);
  const refTime = mostRecentMs(n.last_accessed, n.created);
  const ageDays = refTime > 0 ? Math.max(0, (nowMs - refTime) / DAY_MS) : 0;
  const decay = Math.exp(-LAMBDA * ageDays);
  const access = Math.log2(Math.max(0, n.access_count ?? 0) + 2);
  return importance * decay * access;
}

function mostRecentMs(a: string | null | undefined, b: string | null | undefined): number {
  const ta = toMs(a);
  const tb = toMs(b);
  return Math.max(ta, tb);
}

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
