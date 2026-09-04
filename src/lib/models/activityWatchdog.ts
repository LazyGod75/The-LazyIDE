/* activityWatchdog — kills a long-running CLI turn only on TOTAL silence or
   a hard absolute ceiling, never on a fixed total-turn budget.

   Root cause this replaces (assistant subscription-path ~40s timeout bug):
   claudeCodeProvider's buildRunTurn only fed streamTimeout.ts's idle clock
   from TEXT/THINKING chunks (model://chunk). A native CLI tool_use (Bash/
   Read/Grep — legitimately silent on stdout while the tool itself runs)
   produced a model://action event that never reset that clock, and was
   additionally buffered (streamChatEventsImpl's toolEvents array) until the
   NEXT text chunk before ever reaching the UI layer at all. So a real,
   working CLI turn (e.g. checking a backend's status and counting users,
   which needs a Bash/Read round trip before it can answer) got killed by
   "no response" well before it produced an answer, even though the CLI
   process was alive and actively working the whole time.

   Fix: buildRunTurn (claudeCodeProvider.ts) now owns one of these per turn
   and calls ping() on EVERY raw Tauri event it receives — model://chunk AND
   model://action — so genuine CLI activity of any kind keeps the turn
   alive. Only true silence (nothing at all, from either channel, for
   silenceMs) or the absolute ceiling kills it, by calling queue.reject()
   directly (the same primitive the existing model://error handler already
   uses), which unblocks the consumer immediately instead of leaving it
   waiting on a queue entry that will never arrive.

   Design mirrors agents/runtime.ts's armDurationExceededTimer, used for
   mission runs: a real timer that proactively fires even if the process
   has gone silent (maxDurationMs), because "a single long tool call with no
   intervening tick would otherwise never trip a reactive check" — see that
   function's doc comment. This module adds the silence-window half on top,
   because a chat turn should still fail fast on genuine death/hangs rather
   than wait the full ceiling.

   Mission runs (agents/runtime.ts's runMission, via silenceWatchdog.ts) now
   reuse THIS module too, with its own much larger silenceMs/ceilingMs —
   the assumption once written here ("mission runs don't need it: they
   already tolerate open-ended silence up to their wall-clock cap") turned
   out to be false: `contract.maxDurationMs` is optional, and a mission
   with no cap set that goes silent mid-turn (a real incident: 1535s/
   ~25.6min silent, no error, nothing) had no safety net of any kind. See
   silenceWatchdog.ts's header for the full story.

   Pure: no Tauri/DOM deps beyond the standard AbortSignal/setTimeout —
   fake-timer friendly (vi.useFakeTimers()).
*/

import { StreamTimeoutError } from './streamTimeout.js';

/** Kill the turn after this much TOTAL silence (no chunk, no tool action).
 *  Generous enough to survive a single slow tool call (e.g. a network-bound
 *  Bash/Read step, or the CLI's own ~6-75s cold-start range — see
 *  chat.rs's claude_chat_stream_inner doc comment) without mistaking
 *  legitimate work for a dead CLI. */
export const DEFAULT_SILENCE_MS = 60_000;

/** Hard absolute ceiling regardless of activity — mirrors mission runs'
 *  wall-clock cap (armDurationExceededTimer in agents/runtime.ts). A chat
 *  turn still "active" 10 minutes in is treated as stuck, not patiently
 *  working; the Stop button remains the user's faster way out. */
export const DEFAULT_CEILING_MS = 600_000;

export interface ActivityWatchdogOptions {
  /** Silence window in ms. Defaults to DEFAULT_SILENCE_MS. */
  silenceMs?: number;
  /** Absolute ceiling in ms, measured from watchdog creation. Defaults to DEFAULT_CEILING_MS. */
  ceilingMs?: number;
  /** Aborting (Stop button) disarms the watchdog immediately — no spurious timeout after an intentional stop. */
  signal?: AbortSignal;
  /** Fired at most once, with the reason the watchdog gave up. Never fired after dispose(). */
  onTimeout: (error: StreamTimeoutError) => void;
}

export interface ActivityWatchdog {
  /** Call on ANY sign of life from the CLI (a chunk, a tool action, ...) — resets the silence window. No-op after timeout/dispose. */
  ping(): void;
  /** Stops both timers. Safe to call multiple times (e.g. from a finally block after a normal finish). */
  dispose(): void;
}

/**
 * Starts an activity-based watchdog: `onTimeout` fires once, either when
 * `silenceMs` elapses with no `ping()` call, or when `ceilingMs` elapses
 * from creation regardless of activity — whichever comes first.
 *
 * This module only tracks time; it has no notion of streams/queues/CLIs.
 * Callers own translating `onTimeout` into actually stopping the underlying
 * work (buildRunTurn does this by calling queue.reject(error)).
 */
export function createActivityWatchdog(opts: ActivityWatchdogOptions): ActivityWatchdog {
  const silenceMs = opts.silenceMs ?? DEFAULT_SILENCE_MS;
  const ceilingMs = opts.ceilingMs ?? DEFAULT_CEILING_MS;

  let disposed = false;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  const ceilingTimer: ReturnType<typeof setTimeout> = setTimeout(() => fire('ceiling'), ceilingMs);

  function clearTimers(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = null;
    clearTimeout(ceilingTimer);
  }

  function fire(phase: 'silence' | 'ceiling'): void {
    if (disposed) return;
    disposed = true;
    clearTimers();
    opts.signal?.removeEventListener('abort', onAbort);
    opts.onTimeout(new StreamTimeoutError(phase));
  }

  function onAbort(): void {
    if (disposed) return;
    disposed = true;
    clearTimers();
  }

  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  if (!disposed) {
    silenceTimer = setTimeout(() => fire('silence'), silenceMs);
  }

  return {
    ping(): void {
      if (disposed) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => fire('silence'), silenceMs);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      opts.signal?.removeEventListener('abort', onAbort);
    },
  };
}
