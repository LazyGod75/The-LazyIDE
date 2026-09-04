/* withTimeout — race a promise against a timer.
   Extracted from BrainSpace so graph loading (brainGraphLoad.ts) and the
   space itself share one implementation without a circular import.
   BrainSpace re-exports TimeoutError/withTimeout so existing tests keep
   importing from the space module. */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Races `promise` against a timer; rejects with a TimeoutError if `ms`
    elapses first. Never cancels the underlying `promise` — a late result is
    simply ignored by callers via their own `cancelled` guard. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}
