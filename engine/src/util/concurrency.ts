/**
 * Small bounded-concurrency helpers — no external dependency (no p-limit /
 * p-map in package.json), just enough to run async work in capped batches.
 */

/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight calls,
 * resolving to results in the SAME order as `items` (independent of
 * completion order).
 *
 * Implementation: fixed-size chunking, `limit` items per chunk, one chunk
 * fully awaited (`Promise.all`) before the next chunk starts. This mirrors
 * the bounded-concurrency idiom already used in
 * graph/code-scanner.ts (scanProjectAsync) rather than a continuous
 * worker-pool, so:
 *   - concurrency never exceeds `limit`, and is trivially auditable (no
 *     partial-batch interleaving with the next batch to reason about);
 *   - a caller whose `fn` has a synchronous side effect (e.g. persisting a
 *     result to disk) gets that side effect applied as soon as that item's
 *     own async work resolves — NOT deferred until the whole chunk (or the
 *     whole list) finishes, since `Promise.all` runs its members
 *     independently. Only the START of the next chunk waits on the current
 *     one, which bounds how much in-flight work can be lost to a crash to
 *     at most `limit` items instead of the entire list.
 *
 * Never mutates `items`. `limit` is clamped to >= 1.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const boundedLimit = Math.max(1, Math.trunc(limit) || 1);
  const results: R[] = [];
  for (let start = 0; start < items.length; start += boundedLimit) {
    const chunk = items.slice(start, start + boundedLimit);
    const chunkResults = await Promise.all(chunk.map((item, offset) => fn(item, start + offset)));
    results.push(...chunkResults);
  }
  return results;
}

/**
 * Parse an integer concurrency level from an environment variable, falling
 * back to `fallback` when unset/blank/non-numeric, then clamping to
 * [min, max] either way. Shared by any caller that exposes a
 * `LAZYBRAIN_*_CONCURRENCY`-style override.
 */
export function resolveConcurrencyEnv(
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, base));
}
