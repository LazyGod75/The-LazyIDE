/* fleetStage.ts — pure derivation of a mission's coarse pipeline stage
   (plan/code/test/review/merged) from its status + planSteps + judge
   fields, for the cross-project fleet grid (D3, src/lib/agents/fleetMissions.ts).

   No I/O, no React — fully unit-testable in isolation (see
   src/__tests__/fleetStage.test.ts). The Cockpit's agent grid groups
   missions into 5 columns (PLAN / CODE / TEST / REVUE / MERGÉ per the
   design handoff); this module is the single source of truth for mapping
   a Mission onto one of those columns.
*/

import type { Mission, PlanStep } from './types.js';

export type FleetStage = 'plan' | 'code' | 'test' | 'review' | 'merged';

type StageInput = Pick<Mission, 'status' | 'planSteps' | 'judgeVerdict' | 'merged'>;

/**
 * Maps a mission onto one of the 5 pipeline columns:
 *  - status 'done', or `merged` set               -> 'merged'
 *  - status 'review'                                -> 'review' (awaiting a human decision)
 *  - a judge verdict has already been recorded       -> 'test' (evaluators already ran)
 *  - plan steps exist and are ALL done               -> 'test' (implementation finished, awaiting evaluation)
 *  - plan steps exist and some are done/in-progress  -> 'code' (actively implementing)
 *  - otherwise (queued, no progress yet, no plan)     -> 'plan'
 *
 * `status: 'failed'` and `'cancelled'` are NOT special-cased to a fixed
 * column — a failed mission's stage still reflects how far it got (e.g. a
 * test failure lands in 'test', a build failure lands in 'code'), which is
 * more useful for the grid than collapsing every failure into one column.
 */
export function deriveFleetStage(mission: StageInput): FleetStage {
  if (mission.status === 'done' || mission.merged) return 'merged';
  if (mission.status === 'review') return 'review';
  if (mission.judgeVerdict) return 'test';

  const steps: PlanStep[] = mission.planSteps ?? [];
  if (steps.length === 0) return 'plan';

  const allDone = steps.every((step) => step.state === 'done');
  if (allDone) return 'test';

  const anyProgress = steps.some((step) => step.state === 'done' || step.state === 'in_progress');
  return anyProgress ? 'code' : 'plan';
}

/**
 * Coarse "needs your attention" signal for the fleet grid — true when a
 * mission failed or already has a diff sitting in human review.
 *
 * Deliberately simpler than AttentionInbox's richer approval/question/
 * blocked/budget taxonomy (src/components/agents/AttentionInbox.tsx,
 * backed by the journal's queryAttentionInbox projection) — this flag only
 * drives coarse coloring/sorting in the fleet grid; the Cockpit wave can
 * layer AttentionInbox's precise decision-queue logic on top where it
 * needs the finer distinction.
 */
export function isUrgentMission(mission: Pick<Mission, 'status'>): boolean {
  return mission.status === 'failed' || mission.status === 'review';
}
