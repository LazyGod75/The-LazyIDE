/**
 * Per-brain async write serialisation.
 *
 * Mutating CLI calls (store, index-rebuild) run on the same brain sequentially
 * to avoid SQLite WAL contention. Reads bypass the queue entirely.
 *
 * Design:
 * - A Map<brainPath, Promise<void>> holds the tail of each brain's chain.
 * - New operations are chained onto the tail with .then().
 * - The tail reference is always the last pending operation; completed tails
 *   are replaced when the chain empties.
 * - Generic enough to queue any async thunk, not just CLI calls.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Thunk<T> = () => Promise<T>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const tails = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Queue entry point
// ---------------------------------------------------------------------------

/**
 * Enqueue a mutating operation for a specific brain path.
 * Operations on the same brain run one at a time; operations on different
 * brains run in parallel.
 */
export function enqueue<T>(brainPath: string, thunk: Thunk<T>): Promise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;

  const outer = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const tail = tails.get(brainPath) ?? Promise.resolve();

  const next = tail
    .then(() => thunk().then(resolve, reject))
    .then(
      () => undefined,
      () => undefined,
    );

  tails.set(brainPath, next);

  // Clean up map entry once the chain is fully settled to avoid memory leak
  next.then(() => {
    if (tails.get(brainPath) === next) {
      tails.delete(brainPath);
    }
  });

  return outer;
}

/**
 * Returns true if there is a pending chain for the given brain path.
 * Useful for tests.
 */
export function hasPending(brainPath: string): boolean {
  return tails.has(brainPath);
}

/**
 * Return the current tail promise for a brain (undefined if idle).
 * Useful for flushing in shutdown.
 */
export function drain(brainPath: string): Promise<void> {
  return tails.get(brainPath) ?? Promise.resolve();
}

/**
 * Drain all queues. Waits for every in-flight write to complete.
 */
export function drainAll(): Promise<void> {
  return Promise.all([...tails.values()]).then(() => undefined);
}
