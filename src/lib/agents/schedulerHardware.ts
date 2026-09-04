/* schedulerHardware — default global agent concurrency from real cores.

   Cursor's default is 8 parallel agents. Lazy's settings input used a
   hardcoded 3. This derives 3–8 from navigator.hardwareConcurrency
   (honest probe, never invented). User-saved lazy.agents.maxParallel
   still wins; an empty/absent key uses this hardware default (never
   Infinity). Explicit 0 / invalid remains unlimited. */

export const MAX_PARALLEL_FLOOR = 3;
export const MAX_PARALLEL_CEILING = 8;
export const MAX_PARALLEL_HARD_MAX = 20;

export function defaultMaxParallelFromHardware(cores: number): number {
  if (!Number.isFinite(cores) || cores < 1) return MAX_PARALLEL_FLOOR;
  const scaled = Math.round(cores / 2);
  return Math.min(MAX_PARALLEL_CEILING, Math.max(MAX_PARALLEL_FLOOR, scaled));
}

export function detectHardwareConcurrency(): number {
  if (typeof navigator === 'undefined') return MAX_PARALLEL_FLOOR;
  const n = navigator.hardwareConcurrency;
  return Number.isFinite(n) && n > 0 ? n : MAX_PARALLEL_FLOOR;
}

/** Resolve lazy.agents.maxParallel. Empty/absent → hardware 3–8 (same
 *  number the settings panel shows). User-saved positive ints win.
 *  0 / NaN stay unlimited (Infinity) — 0 is not a UI value, it is the
 *  explicit sentinel the scheduler historically used for "no cap". */
export function resolveGlobalMaxParallel(
  raw: string | null,
  cores = detectHardwareConcurrency(),
): number {
  if (raw === null || raw.trim() === '') return defaultMaxParallelFromHardware(cores);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}
