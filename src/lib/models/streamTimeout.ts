/* streamTimeout — guards an async chunk stream against hangs.
   Raises StreamTimeoutError if the first chunk is late, or the stream
   goes idle between chunks for too long. Pure: no Tauri/DOM deps.
   Generic over the yielded value <T> — used with plain string chunks
   (most callers) and with StreamEvent objects (assistantStore's
   structured stream); the timeout/idle logic itself never looks at the
   value, so genericizing is a pure type-level change. */

export const FIRST_TOKEN_TIMEOUT_MS = 15_000;
export const IDLE_TIMEOUT_MS = 30_000;

// 'silence' / 'ceiling' are raised by activityWatchdog.ts (subscription/CLI
// turns) rather than by this file's own streamTimeout() generator below —
// added here so both timeout designs share one error type, letting every
// existing `err instanceof StreamTimeoutError` check (e.g.
// assistantStore.tsx's catch block) recognize either without change.
export type TimeoutPhase = 'first-token' | 'idle' | 'silence' | 'ceiling';

const PHASE_MESSAGES: Record<TimeoutPhase, string> = {
  'first-token': 'No response from the model within the time limit.',
  'idle': 'The model stopped responding mid-stream.',
  'silence': 'No activity from the CLI within the silence window.',
  'ceiling': 'The turn exceeded the maximum allowed duration.',
};

export class StreamTimeoutError extends Error {
  readonly phase: TimeoutPhase;
  constructor(phase: TimeoutPhase) {
    super(PHASE_MESSAGES[phase]);
    this.name = 'StreamTimeoutError';
    this.phase = phase;
  }
}

interface StreamTimeoutOpts {
  firstTokenMs?: number;
  idleMs?: number;
  signal?: AbortSignal;
}

export async function* streamTimeout<T>(
  source: AsyncIterable<T>,
  opts: StreamTimeoutOpts = {},
): AsyncIterable<T> {
  const firstTokenMs = opts.firstTokenMs ?? FIRST_TOKEN_TIMEOUT_MS;
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS;
  const iterator = source[Symbol.asyncIterator]();
  let seenFirst = false;

  const signal = opts.signal;
  // One abort listener for the whole stream (not per-iteration). Resolves to a
  // done result so the race below returns immediately when aborted.
  const aborted: Promise<IteratorResult<T>> | null = signal
    ? new Promise(resolve => {
        const onAbort = () => resolve({ value: undefined as unknown as T, done: true });
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  try {
    while (true) {
      if (opts.signal?.aborted) return;
      const limit = seenFirst ? idleMs : firstTokenMs;
      const phase: TimeoutPhase = seenFirst ? 'idle' : 'first-token';

      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamTimeoutError(phase)), limit);
      });

      let result: IteratorResult<T>;
      try {
        const racers: Array<Promise<IteratorResult<T>>> = aborted
          ? [iterator.next(), timeout, aborted]
          : [iterator.next(), timeout];
        result = await Promise.race(racers);
      } finally {
        clearTimeout(timer!);
      }

      if (result.done) return;
      seenFirst = true;
      yield result.value;
    }
  } finally {
    // Fire-and-forget cleanup: never block on the source's teardown. A hung
    // source must not prevent the timeout error from propagating.
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}
