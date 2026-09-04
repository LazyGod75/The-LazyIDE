/* graph/runControl.ts — Plan-level pause/resume/cancel API for the SGR.

   Provides external control over a running graph execution:
   - pauseGraphRun: requests a pause, stops the live loop from launching a
     new wave at its next safe boundary (between waves)
   - resumeGraphRun: marks the run as running again, clears interrupt nodes
   - cancelGraphRun: marks the run as cancelled, aborts all pending nodes

   D4 fix (2026-08-15 audit, item 2) — root cause: `pauseGraphRun` used to
   mutate the SAME `GraphRun` object the CALLER happened to be holding
   in place, then return `void`. Two things made this a no-op against a
   real, in-flight run:
     1. `runGraph.ts`'s while-loop owns its OWN internal `RunRef` box
        (see that module's header comment) — it is a completely separate
        object graph from whatever `run` reference a caller (a future UI
        action, a test) passes to `pauseGraphRun`. Mutating the caller's
        copy never touches the loop's own state.
     2. Even setting that aside, the loop itself never re-read `run.status`
        at all between waves — it only ever checked `opts.signal.aborted`
        (cancellation). There was no channel from "something called
        pauseGraphRun" to "the live loop learns about it", mutation or not.
     3. In-place mutation also directly contradicts this file's neighbours
        (runGraph.ts's own `withRun`/`withNodeRun` — see that module's
        "Immutable run helpers" section) — a `pauseGraphRun(run)` call could
        hand a caller's React state object back mutated-in-place instead of
        a fresh object to `setState`.

   The fix is a real channel: a module-level pause-request registry, keyed
   by runId. `pauseGraphRun`/`resumeGraphRun` write to it; `runGraph.ts`'s
   wave loop polls `isPauseRequested(runId)` at the exact same safe boundary
   it already checks `opts.signal.aborted` (top of the loop, between waves
   — a wave already in flight is never interrupted mid-flight, only the
   NEXT wave is prevented from launching). Both functions are now pure —
   they return a NEW `GraphRun`, never mutate the one passed in — so a
   caller can pass the returned value straight to `setState`/`persistRun`.

   Resuming a run that runGraph.ts already returned from (because it saw
   the pause request and stopped) requires the caller to re-invoke
   `runGraph(ir, deps, { existingRun: resumeGraphRun(pausedRun) })` — the
   SAME re-entry pattern already used for an interrupted (HITL) run; see
   sgrOrchestratorRunner.ts's own `existingRun` usage.

   Cancel fix (2026-08-15 audit follow-up — the live-loop blindness
   `pauseGraphRun` had, now closed on `cancelGraphRun` too) — root cause:
   `cancelGraphRun` had the exact same "mutates/returns a snapshot the live
   loop never re-reads" shape D4 fixed for pause, EXCEPT the live loop's
   real cancellation channel is `opts.signal.aborted` (an `AbortSignal`
   passed into `runGraph` at CALL TIME by whoever started the run) —
   `cancelGraphRun(run)` is invoked later, elsewhere, by a caller that only
   ever has the `GraphRun` object, never that `AbortController`. Calling it
   against a live run computed a "what cancellation would look like" object
   and handed it to `setState`/`persistRun`, but the wave loop kept running
   regardless — it never saw a signal fire.
   Fixed with the SAME channel pause already has: `cancelRequests`, a
   second runId-keyed registry alongside `pauseRequests`. `cancelGraphRun`
   registers a request (only when the run was actually `running`, mirroring
   `pauseGraphRun`'s own guard — a run that already exited the loop has no
   live poller to signal) and `runGraph.ts`'s loop polls
   `isCancelRequested(runId)` at the exact same safe boundary it already
   polls `opts.signal.aborted`/`isPauseRequested` — between waves, checked
   BEFORE the pause check (cancel is the stronger, terminal action). Both
   channels can still coexist: a caller with a real `AbortController` keeps
   using `opts.signal`; a caller that only has the `GraphRun` (the UI
   action, `resume_graph_run`'s abort button, a test) now has a channel
   that actually reaches a live run too.
*/

import type { GraphRun } from './types.js';
import { emit as busEmit } from '../../bus.js';

// ── Live pause control channel ──────────────────────────────────────
// Module-level, keyed by runId — the one thing a caller reliably has and
// the one thing runGraph.ts's wave loop reliably has too (`runRef.current.
// runId`), even though the two sides never share the same `GraphRun`
// object. See this module's header comment for the full defect writeup.
const pauseRequests = new Set<string>();

/** Same shape as {@link pauseRequests}, for `cancelGraphRun` — see this
 *  file's header comment ("Cancel fix") for the full defect writeup. Kept
 *  as a separate Set (not folded into `pauseRequests`) so a pending pause
 *  request and a pending cancel request can never be confused by a caller
 *  polling one when it meant the other. */
const cancelRequests = new Set<string>();

/** True once `pauseGraphRun` has requested a pause for this runId and it
 *  has not since been cleared by `resumeGraphRun`/`clearRunControl`.
 *  Polled by runGraph.ts's wave loop at the top of each iteration. */
export function isPauseRequested(runId: string): boolean {
  return pauseRequests.has(runId);
}

/** True once `cancelGraphRun` has requested a cancellation for this runId
 *  and it has not since been cleared by `clearRunControl`. Polled by
 *  runGraph.ts's wave loop at the top of each iteration, checked BEFORE
 *  the pause request (cancel is the stronger, terminal action — a run
 *  that's both requested to pause and to cancel should end up
 *  'cancelled', never 'paused'). */
export function isCancelRequested(runId: string): boolean {
  return cancelRequests.has(runId);
}

/** Drop all control-channel state for a run — call once a run reaches a
 *  terminal status (done/failed/cancelled) so a stale flag can never leak
 *  onto a later, unrelated run. Safe to call even if no request was ever
 *  registered (Set.delete on a missing key is a no-op). */
export function clearRunControl(runId: string): void {
  pauseRequests.delete(runId);
  cancelRequests.delete(runId);
}

/** Request a pause — the live wave loop for this run (if any is actually
 *  executing) stops launching new waves at its next safe boundary. Returns
 *  a NEW `GraphRun` (never mutates `run`) with `status: 'paused'` when the
 *  run was `running`; returns `run` unchanged otherwise (pausing a run
 *  that isn't running is a no-op, same as before). The returned object
 *  reflects the REQUEST, not proof the live loop has actually stopped yet
 *  — the loop itself is the one that persists the authoritative `'paused'`
 *  status once it observes the request (see runGraph.ts). */
export function pauseGraphRun(run: GraphRun): GraphRun {
  if (run.status !== 'running') return run;
  pauseRequests.add(run.runId);
  busEmit('graph.interrupt', {
    runId: run.runId,
    nodeId: '',
    reason: 'paused by user',
    resumeToken: `${run.runId}:pause:${Date.now()}`,
  });
  return { ...run, status: 'paused', updatedAt: Date.now() };
}

/** Resume a paused/interrupted graph run — clears the pause request (so a
 *  freshly-resumed run doesn't immediately re-pause itself the moment it's
 *  handed to a new `runGraph(...)` call) and returns a NEW `GraphRun` with
 *  `status: 'running'` and every `blocked` node reset to `pending` so it
 *  can be re-evaluated. Returns `run` unchanged if it wasn't
 *  paused/interrupted. */
export function resumeGraphRun(run: GraphRun): GraphRun {
  if (run.status !== 'interrupted' && run.status !== 'paused') return run;
  clearRunControl(run.runId);

  let nodeRuns = run.nodeRuns;
  for (const nodeId of Object.keys(run.nodeRuns)) {
    const nr = run.nodeRuns[nodeId];
    if (nr.status === 'blocked') {
      nodeRuns = { ...nodeRuns, [nodeId]: { ...nr, status: 'pending', errorMessage: undefined } };
    }
  }

  return { ...run, status: 'running', nodeRuns, updatedAt: Date.now() };
}

/** Cancel a graph run — returns a NEW `GraphRun` (status 'cancelled', every
 *  pending/running/ready node marked 'skipped'). If the run is currently
 *  `running`, this also registers a cancel request on the live channel
 *  (`cancelRequests`, see this file's header comment) BEFORE clearing
 *  control state for it, so a wave loop actually still polling this runId
 *  observes the request on its very next iteration and stops itself
 *  honestly (status 'cancelled', persisted, `graph.run_cancelled` emitted
 *  from `runGraph.ts` itself — this function's OWN emit below covers the
 *  case where no live loop exists at all, e.g. cancelling an already-
 *  paused run, so the event still fires exactly once either way). Every
 *  other pending control state (a stale pause request) is cleared after,
 *  same as before — cancellation always wins and leaves nothing behind. */
export function cancelGraphRun(run: GraphRun): GraphRun {
  // A pending pause request is superseded by cancellation — dropped
  // directly (NOT via clearRunControl, which would also wipe the cancel
  // request registered just below it).
  pauseRequests.delete(run.runId);

  if (run.status === 'running') {
    // A live wave loop may still be polling this runId — register the
    // request so its very next iteration observes it and stops itself
    // honestly. runGraph.ts calls clearRunControl once it does, same as
    // every other terminal exit from the loop (see the abort/budget/failed
    // branches it already has).
    cancelRequests.add(run.runId);
  } else {
    // No live loop can ever observe this request (the run already exited
    // the wave loop, or never entered it) — nothing to leave pending.
    cancelRequests.delete(run.runId);
  }

  let nodeRuns = run.nodeRuns;
  for (const nodeId of Object.keys(run.nodeRuns)) {
    const nr = run.nodeRuns[nodeId];
    if (nr.status === 'pending' || nr.status === 'running' || nr.status === 'ready') {
      nodeRuns = { ...nodeRuns, [nodeId]: { ...nr, status: 'skipped', completedAt: Date.now() } };
    }
  }

  busEmit('graph.run_cancelled', { runId: run.runId });
  return { ...run, status: 'cancelled', nodeRuns, updatedAt: Date.now() };
}

/** Check if a run should continue executing (not paused/cancelled/done). */
export function isRunActive(run: GraphRun): boolean {
  return run.status === 'running';
}

/** Check if a run is in a terminal state. */
export function isRunTerminal(run: GraphRun): boolean {
  return run.status === 'done' || run.status === 'failed' || run.status === 'cancelled';
}

/** Check if a run is paused (user pause or interrupt node). */
export function isRunPaused(run: GraphRun): boolean {
  return run.status === 'paused' || run.status === 'interrupted';
}
