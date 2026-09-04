/* previewProbe.ts — R13: pure polling state machine for PreviewNode.tsx's
   local-dev-server reachability probe.

   BEFORE this fix: a single one-shot `fetch` (REACHABILITY_TIMEOUT_MS =
   2500ms) decided "chargement…" vs "serveur injoignable" ONCE. A dev server
   that takes >2.5s to bind its port (a cold `npm run dev` / `vite`/webpack
   first compile is routinely 5-20s) was misreported as permanently
   unreachable — the node never re-checked, and the only recovery was
   deleting and re-creating the surface.

   AFTER: polling continues for up to PREVIEW_PROBE_TIMEOUT_MS (60s) total,
   with an exponential-ish backoff between attempts (2s, 3s, 4.5s, ... capped
   at PREVIEW_PROBE_MAX_DELAY_MS) rather than a fixed 2s forever — cheap
   early retries for the common "just needs one more second" case, without
   hammering a genuinely-dead server 30 times a minute. `reduceProbeResult`
   is a pure function (no timers, no fetch) so the state machine itself is
   fully unit-testable independent of PreviewNode.tsx's actual setTimeout/
   fetch wiring — see this module's own test file.
*/

export const PREVIEW_PROBE_INITIAL_DELAY_MS = 2000;
export const PREVIEW_PROBE_MAX_DELAY_MS = 8000;
/** Total polling window before honestly giving up and reporting unreachable. */
export const PREVIEW_PROBE_TIMEOUT_MS = 60000;
/** Backoff multiplier applied per attempt (exponential-ish, not full 2x). */
const BACKOFF_FACTOR = 1.5;

/**
 * 'checking'    — the very FIRST probe for this URL is in flight (no retry
 *                 has happened yet).
 * 'starting'    — at least one probe failed and this is a scheduled RETRY
 *                 still within the polling window — rendered as "démarrage
 *                 du serveur…" (a cold dev server binding its port), never
 *                 the same "unreachable" wording a genuinely-dead server gets.
 * 'reachable'   — the most recent probe succeeded.
 * 'unreachable' — polling exhausted PREVIEW_PROBE_TIMEOUT_MS without ever
 *                 succeeding — this is the ONLY state a manual retry is
 *                 needed from (the refresh button always re-arms from here
 *                 or from 'reachable', in case the server went back down).
 */
export type PreviewProbeState = 'checking' | 'starting' | 'reachable' | 'unreachable';

export interface PreviewProbeSnapshot {
  state: PreviewProbeState;
  /** Number of probe attempts made so far (the in-flight one, once started, counts). */
  attempt: number;
  /** Total elapsed ms since polling for this URL began. */
  elapsedMs: number;
}

/** Fresh state for a brand-new URL, or right after the manual refresh button. */
export function initialProbeSnapshot(): PreviewProbeSnapshot {
  return { state: 'checking', attempt: 0, elapsedMs: 0 };
}

/**
 * Exponential-ish delay before probe attempt `attempt` (1-based: the delay
 * BEFORE the 2nd attempt, 3rd attempt, ...), capped at
 * PREVIEW_PROBE_MAX_DELAY_MS so a long-hung server doesn't stretch retries
 * out to minutes apart.
 */
export function nextProbeDelayMs(attempt: number): number {
  const raw = PREVIEW_PROBE_INITIAL_DELAY_MS * Math.pow(BACKOFF_FACTOR, Math.max(0, attempt - 1));
  return Math.min(Math.round(raw), PREVIEW_PROBE_MAX_DELAY_MS);
}

export interface ProbeReduction {
  snapshot: PreviewProbeSnapshot;
  /** False once the machine has reached a final state for this window
   *  (reachable, or timed-out unreachable) — the caller should stop
   *  scheduling further probes until a manual refresh or a new URL. */
  shouldContinue: boolean;
  /** Delay to wait before the NEXT probe — meaningless when shouldContinue is false. */
  nextDelayMs: number;
}

/**
 * Pure reducer: given the snapshot BEFORE this probe, whether the probe
 * succeeded, and the total elapsed time AT this probe, computes the next
 * snapshot and whether polling should continue.
 *
 * `elapsedMs` is measured from when polling for this URL STARTED (not
 * per-attempt) — this is what lets the timeout be a real wall-clock budget
 * (PREVIEW_PROBE_TIMEOUT_MS) regardless of how the backoff schedule divided
 * it up, rather than a fixed attempt count that would behave differently
 * depending on the backoff curve.
 */
export function reduceProbeResult(
  snapshot: PreviewProbeSnapshot,
  ok: boolean,
  elapsedMs: number,
): ProbeReduction {
  const attempt = snapshot.attempt + 1;

  if (ok) {
    return { snapshot: { state: 'reachable', attempt, elapsedMs }, shouldContinue: false, nextDelayMs: 0 };
  }

  if (elapsedMs >= PREVIEW_PROBE_TIMEOUT_MS) {
    return { snapshot: { state: 'unreachable', attempt, elapsedMs }, shouldContinue: false, nextDelayMs: 0 };
  }

  return {
    snapshot: { state: 'starting', attempt, elapsedMs },
    shouldContinue: true,
    nextDelayMs: nextProbeDelayMs(attempt),
  };
}
