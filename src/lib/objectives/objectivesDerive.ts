/* objectivesDerive.ts — pure derivation for CAP objectives auto-progress (B9).

   No I/O, no React — fully unit-testable in isolation (see
   src/__tests__/objectivesDerive.test.ts). The I/O side (fetching merged
   mission events via journalQuery and persisting the result) lives in
   useObjectivesAutoProgress.ts, which is the only caller of this module.

   Rule (David, explicit): an objective linked to a project (projectId set)
   auto-derives currentCount from that project's MERGED missions (journal
   event type 'mission.approved' — same event usePersonalKpis.ts counts for
   "mergedThisWeek") created since the objective's own creation timestamp.
   Manual override stays possible: once a user has manually corrected the
   count for a linked objective (manualOverride === true), auto-derivation
   is frozen until they explicitly resume it. Unlinked objectives
   (projectId === null) are always manual — there is nothing to derive from.
*/

export interface DerivableObjective {
  projectId: string | null;
  manualOverride?: boolean;
  currentCount: number;
}

/**
 * Given an objective and the count of real MERGED-mission journal events
 * for its linked project since its creation, returns the currentCount that
 * should be persisted.
 *
 *  - No linked project -> always the existing (manual) value, unchanged.
 *  - Linked + manualOverride -> frozen at the existing (manual) value.
 *  - Linked + no override -> the real merged-mission count.
 */
export function deriveCurrentCount(
  objective: DerivableObjective,
  mergedMissionCount: number,
): number {
  if (!objective.projectId) return objective.currentCount;
  if (objective.manualOverride) return objective.currentCount;
  return mergedMissionCount;
}

/**
 * True when the derived count differs from what's currently stored — the
 * caller should persist an update. Kept separate from deriveCurrentCount so
 * callers can skip a write entirely when nothing changed (avoids an
 * infinite notify/re-poll loop in useObjectivesAutoProgress).
 */
export function shouldPersistDerivedCount(
  objective: DerivableObjective,
  mergedMissionCount: number,
): boolean {
  return deriveCurrentCount(objective, mergedMissionCount) !== objective.currentCount;
}
