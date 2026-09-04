/* retryBaseBranchGuard.ts — the single, shared rule deciding whether a
   `retry_mission` request's baseBranch is a real, refused change.

   Extracted (2026-08-02, "M9/M10 dead-end approval" incident) from
   agentsStore.tsx's retryMission, which previously computed this inline and
   was the ONLY place that ever checked it — meaning a retry_mission action
   requiring human approval (autonomy gate === 'ask') got queued into
   pendingApprovals BLIND, with nobody checking whether it was even
   possible to satisfy. The user would see "Approve"/"Reject", click
   Approve, and only then discover (via retryMission's own throw) that the
   action could never have succeeded — leaving a permanent Reject-only dead
   end (retry_mission failures never set `canForce`, unlike approve_mission,
   so PendingApprovalCard has no recovery button once that failure lands).

   This module is now the ONE place both call sites agree with:
     - agentsStore.tsx's retryMission — throws using this function's result,
       exactly as before (regression-safe: same rule, same message inputs).
     - agentsStore.tsx's manager pending-approval queuing (sendManagerMessage's
       action loop) — pre-checks a retry_mission action's baseBranch BEFORE
       ever queuing it, so a doomed request is refused at the source (same
       treatment as an autonomy `deny`) instead of being offered and then
       failing.

   Chosen fix (option b of two considered): reroute retry_mission to actually
   CHANGE base branch was rejected as too risky to redo correctly in this
   pass — it was deliberately reversed after a real incident where a
   silently-changed base branch shipped the wrong prior work into a mission
   (see this function's own "why blocked" rationale below). Re-opening that
   design here, without redoing the incident's own investigation, risks
   reintroducing it. Refusing at the source keeps the existing, incident-
   tested safety rule intact and only fixes the UX dead end it left behind.
*/

/**
 * True when `requestedBaseBranch` is a REAL change from `originalBaseBranch`
 * (both trimmed; an empty string counts as absent) — the one case
 * retryMission always refuses. Identical (including both absent) is not a
 * change and is never blocked — today's plain-retry behavior.
 */
export function isRetryBaseBranchChangeBlocked(
  originalBaseBranch: string | undefined,
  requestedBaseBranch: string | undefined,
): boolean {
  const requested = requestedBaseBranch?.trim() || undefined;
  const original = originalBaseBranch?.trim() || undefined;
  return requested !== undefined && requested !== original;
}

/**
 * Reads the same two shapes a manager might plausibly emit a requested
 * baseBranch under — `modifications.baseBranch` (the untyped-bag convention
 * every other retry modification uses) and a mistaken top-level `baseBranch`
 * (mirroring launch_mission's own top-level field) — mirroring
 * agentsStore.tsx's retry_mission executor case exactly, so both call sites
 * always agree on what "the requested baseBranch" even means.
 */
export function extractRequestedRetryBaseBranch(action: {
  modifications?: Record<string, unknown>;
  baseBranch?: string;
}): string | undefined {
  const mods = action.modifications ?? {};
  return (
    (typeof mods.baseBranch === 'string' ? mods.baseBranch : undefined) ??
    (typeof action.baseBranch === 'string' ? action.baseBranch : undefined)
  );
}
