/* previewBackoff.ts — W-PREVIEWFIX: pure backoff schedule for PreviewNode.tsx's
   reachability probe once previewProbe.ts's fast cold-start window
   (PREVIEW_PROBE_TIMEOUT_MS, ~60s) has genuinely given up.

   BEFORE this fix: once previewProbe.ts's state machine reached its terminal
   'unreachable' state, PreviewNode.tsx stopped scheduling any further probe —
   by design, on the assumption a genuinely-dead server needs a human to hit
   refresh. In practice a PERSISTED preview (one reloaded from a saved
   layout, still pointing at a dev server the user never restarted) kept
   re-entering that same fast cold-start cadence on every remount, observed
   in real QA as 11 net::ERR_CONNECTION_REFUSED console lines in ~4 minutes —
   "hammering" a port nothing is listening on.

   AFTER: PreviewNode.tsx now keeps probing past that point on this much
   slower, capped schedule (5s / 15s / 45s / 2min / 5min) instead of the
   cold-start's fast 2-8s cadence — cheap enough to run for a persisted
   node without hammering a dead port. Any successful probe (at any point)
   resets the caller's failure streak, so a LATER failure starts back at
   the fast 5s step rather than resuming from wherever the previous streak
   left off.

   W-PREVIEWFIX-STOP: repeating the 5-minute cap literally forever was
   itself the next problem — a persisted preview left open against a dev
   server the user has no intention of ever restarting would poll it once
   every 5 minutes for as long as the app stays open. `hasGivenUpBackoff`
   gives PreviewNode.tsx a clean stopping point: past
   PREVIEW_BACKOFF_GIVE_UP_MS of continuous failure, it stops scheduling
   ANY further automatic retry — the countdown disappears and the user has
   to act (manual refresh, a new `url`, or `refreshRequestedAtMs`) to
   re-arm it, same as this module's own header already required for the
   "reset on success" case.

   Pure function, no timers/fetch — same "state machine as data" rationale
   previewProbe.ts's own header documents, and unit-tested the same way
   (previewBackoff.test.ts). */

/** 1-based failure-streak -> delay schedule. Index 0 is the delay before the
 *  FIRST backoff retry (i.e. failureStreak === 1). Beyond the schedule's
 *  length, the last (longest) entry repeats — never grows unbounded. */
const BACKOFF_SCHEDULE_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000, 300_000];

/** Longest delay this schedule ever returns — exported so callers/tests can
 *  assert the cap without duplicating the magic number. */
export const PREVIEW_BACKOFF_MAX_DELAY_MS = BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];

/**
 * Delay before the Nth backoff retry, where `failureStreak` is 1 for the
 * first retry after the cold-start window gave up, 2 for the next, etc.
 * Clamps to the schedule's last (capped) entry for any streak beyond its
 * length, and never returns a delay shorter than the first step (a
 * `failureStreak` of 0 or a negative value clamps up to 1's delay, the same
 * defensive clamp previewProbe.ts's own nextProbeDelayMs uses).
 */
export function nextBackoffDelayMs(failureStreak: number): number {
  const index = Math.min(Math.max(1, failureStreak), BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[index];
}

/** W-PREVIEWFIX-STOP — continuous-unreachable wall-clock budget (measured
 *  from the FIRST backoff retry, i.e., from the moment previewProbe.ts's
 *  cold-start window gave up) before the schedule above stops repeating
 *  and PreviewNode.tsx halts automatic polling entirely. Deliberately the
 *  same value as the schedule's own longest step, not a coincidence — once
 *  a failure has survived a full trip down the schedule to its slowest
 *  rung, one more circuit of it is a losing bet. */
export const PREVIEW_BACKOFF_GIVE_UP_MS = PREVIEW_BACKOFF_MAX_DELAY_MS;

/**
 * True once `elapsedSinceFirstBackoffRetryMs` has exceeded
 * {@link PREVIEW_BACKOFF_GIVE_UP_MS} — the caller's signal to stop
 * scheduling any further automatic retry rather than keep repeating the
 * schedule's capped final step forever.
 */
export function hasGivenUpBackoff(elapsedSinceFirstBackoffRetryMs: number): boolean {
  return elapsedSinceFirstBackoffRetryMs >= PREVIEW_BACKOFF_GIVE_UP_MS;
}
