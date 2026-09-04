/* Bounded-concurrency helpers.
   Promise.all fans every item out at once — fine for a handful of calls,
   dangerous when the list size is user-controlled (e.g. hundreds of staged
   git files triggering hundreds of simultaneous `git diff` subprocesses).
   mapWithConcurrency caps how many calls to `fn` are ever in flight at once
   while still returning results in the original input order, same contract
   as Promise.all.
*/

/**
 * Maps over `items` with at most `limit` concurrent in-flight calls to
 * `fn`. Results are returned in the same order as `items`, regardless of
 * which call settles first — same ordering contract as `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
