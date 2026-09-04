/* planMaterialize — missing-draft policy for executePlan.

   A single draft that failed to land on the canvas must not cancel the
   whole plan. Launch the surviving steps; report the missing ids so the
   UI can warn without reverting to pending.
*/

export interface MaterializeDraftCheck {
  expectedIds: string[];
  survivingIds: ReadonlySet<string>;
}

export interface MaterializeDraftResult {
  missingIds: string[];
  launchIds: string[];
  /** True when at least one expected draft landed — the plan may proceed. */
  canLaunch: boolean;
}

export function partitionMaterializedDrafts(check: MaterializeDraftCheck): MaterializeDraftResult {
  const missingIds = check.expectedIds.filter((id) => !check.survivingIds.has(id));
  const launchIds = check.expectedIds.filter((id) => check.survivingIds.has(id));
  return {
    missingIds,
    launchIds,
    canLaunch: launchIds.length > 0,
  };
}
