/* graph/materializedPlanRepair.ts — hydrate-time repair for ALREADY-
   MATERIALIZED (accepted, no longer `proposedPlanId`-tagged) plan drafts/
   joins whose `projectId` disagrees with the project the plan's own
   missions actually ran in.

   Root cause this repairs (2026-08-02 escalation, real founder repro): a
   plan whose canvas preview was mis-homed into the wrong project's zone —
   e.g. canvasProposalCleanup.ts's own documented INCIDENT, the unsafe
   product-NAME re-home heuristic that shipped before 878fef7 disabled it —
   FROZE that wrong `projectId` the instant a step was accepted.
   `acceptProposedSteps` (canvasStore.ts) strips `proposedPlanId` the moment
   a step is accepted, so canvasProposalCleanup.ts's own tag-based repair
   (which only ever touches nodes STILL tagged `proposedPlanId`) can never
   reach it again — there is no surviving link back to the plan on the
   canvas node itself. A plan mid-execution (some steps already launched
   into real missions, `OrchestratorState.childMissionIds`) with its
   remaining un-launched steps' drafts/joins stuck in the wrong zone is
   exactly the reported blocker: the manager reads the canvas digest, finds
   the next-step chain pointing into a project that never ran any of this
   plan's missions, and "loses the chain" — the plan cannot continue past
   whatever step already ran.

   Ground truth used here is NEVER `orch.projectId` alone (that field can
   itself be the exact value the incident corrupted — a plan created while
   the wrong project was active, or re-homed by the old heuristic, has a
   WRONG `projectId` from the moment it was created) and NEVER text/name
   matching (the same class of mistake canvasProposalCleanup.ts's own
   INCIDENT note describes). It is the REAL project the plan's own
   ALREADY-LAUNCHED missions (`childMissionIds`) are recorded under in the
   journal (`journal_missions_current`'s own `project_id` column, stamped
   once at mission-launch time from the REAL root the mission actually ran
   against — see agentsStore.tsx's `addMission`). A plan with zero launched
   missions yet has no such evidence and is left alone: `orch.projectId` is
   already the best available truth for a plan that has not run anything,
   and is already correct end-to-end for any plan created since
   generate_plan's own target-project fix (agentsStore.tsx).

   Expected draft/join ids for a plan are derived by recompiling
   `compileOrchestratorToIr(orch) -> irToCanvas(ir)` — the SAME
   deterministic id space (`step.id` verbatim) executePlan's own B3
   backstop already trusts (agentsStore.tsx's materializeAndExecutePlan),
   never a second, possibly-diverging id derivation.
*/

import type { OrchestratorState } from '../types.js';
import { compileOrchestratorToIr } from './compileOrchestrator.js';
import { irToCanvas } from './irToCanvas.js';
import type { DraftSpec, JoinSpec } from '../../../components/agents/canvas/canvasTypes.js';

export interface OpenProjectHandle {
  projectId: string;
  root: string;
}

export interface MaterializedPlanRepairDeps {
  /** Every currently OPEN project (real backend truth), same directory
   *  canvasProposalCleanup.ts's `listOpenProjects` reads. */
  listOpenProjects: () => Promise<OpenProjectHandle[]>;
  /** Every persisted orchestrator record under one project's own root
   *  (orchestratorState.ts's `listOrchestrators`). */
  listOrchestrators: (root: string) => Promise<OrchestratorState[]>;
  /** missionId -> the REAL project it is journaled under
   *  (`journal_missions_current`'s own `project_id` column). Never derived
   *  from any orchestrator's own `projectId` field — see this module's own
   *  header for why that field can itself be the corrupted value. */
  fetchMissionProjectIds: () => Promise<Map<string, string>>;
  getCanvasState: () => { drafts: readonly DraftSpec[]; joins: readonly JoinSpec[] };
  updateDraft: (id: string, patch: { projectId?: string }) => void;
  updateJoin: (id: string, patch: { projectId?: string }) => void;
}

export interface MaterializedPlanRepairResult {
  repaired: Array<{ planId: string; projectId: string; draftIds: string[]; joinIds: string[] }>;
}

/**
 * Pure — the real project a plan's own already-launched missions belong to,
 * or `undefined` when there is no usable evidence: zero launched missions,
 * none of them resolvable in the journal (not yet flushed, or a web/mock
 * environment), or CONFLICTING evidence across missions (should never
 * happen for a single plan — treated as "never guessed" rather than picking
 * one arbitrarily).
 */
export function resolvePlanRealProjectId(
  orch: Pick<OrchestratorState, 'childMissionIds'>,
  missionProjectIds: ReadonlyMap<string, string>,
): string | undefined {
  const found = new Set(
    orch.childMissionIds
      .map((id) => missionProjectIds.get(id))
      .filter((value): value is string => value !== undefined),
  );
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * Pure — which of a plan's own drafts/joins currently on the canvas
 * disagree with `realProjectId`. A step already launched into a mission has
 * no surviving draft (remapDraftToMission removed it) and is simply absent
 * from `expectedDrafts` intersected with the live canvas — never flagged.
 */
export function findMismatchedPlanNodes(
  orch: OrchestratorState,
  realProjectId: string,
  canvasState: { drafts: readonly DraftSpec[]; joins: readonly JoinSpec[] },
): { draftIds: string[]; joinIds: string[] } {
  const { drafts: expectedDrafts, joins: expectedJoins } = irToCanvas(compileOrchestratorToIr(orch));
  const draftById = new Map(canvasState.drafts.map((d) => [d.id, d] as const));
  const joinById = new Map(canvasState.joins.map((j) => [j.id, j] as const));

  const draftIds = expectedDrafts
    .map((expected) => draftById.get(expected.id))
    .filter((live): live is DraftSpec => live !== undefined && live.projectId !== realProjectId)
    .map((live) => live.id);

  const joinIds = expectedJoins
    .map((expected) => joinById.get(expected.id))
    .filter((live): live is JoinSpec => live !== undefined && live.projectId !== realProjectId)
    .map((live) => live.id);

  return { draftIds, joinIds };
}

/**
 * Orchestration entry point (dependency-injected, same shape as
 * canvasProposalCleanup.ts's `cleanupStaleProposedPreviews` — pure logic
 * factored into the two functions above, this just wires it to real state
 * and applies the fix). Idempotent and safe to call repeatedly: a plan with
 * nothing mismatched is simply absent from the next call's report.
 */
export async function repairMaterializedPlanProjects(
  deps: MaterializedPlanRepairDeps,
): Promise<MaterializedPlanRepairResult> {
  const openProjects = await deps.listOpenProjects().catch(() => [] as OpenProjectHandle[]);
  if (openProjects.length === 0) return { repaired: [] };

  const missionProjectIds = await deps.fetchMissionProjectIds().catch(() => new Map<string, string>());
  const canvasState = deps.getCanvasState();
  const repaired: MaterializedPlanRepairResult['repaired'] = [];

  for (const project of openProjects) {
    let orchestrators: OrchestratorState[];
    try {
      orchestrators = await deps.listOrchestrators(project.root);
    } catch {
      continue; // a read failure is never evidence of anything — skip, retried later
    }

    for (const orch of orchestrators) {
      if (orch.childMissionIds.length === 0) continue; // no launched-mission evidence — never guessed
      const realProjectId = resolvePlanRealProjectId(orch, missionProjectIds);
      if (!realProjectId) continue;

      const { draftIds, joinIds } = findMismatchedPlanNodes(orch, realProjectId, canvasState);
      if (draftIds.length === 0 && joinIds.length === 0) continue;

      for (const id of draftIds) deps.updateDraft(id, { projectId: realProjectId });
      for (const id of joinIds) deps.updateJoin(id, { projectId: realProjectId });
      repaired.push({ planId: orch.id, projectId: realProjectId, draftIds, joinIds });
    }
  }

  if (repaired.length > 0) {
    console.warn('[materializedPlanRepair] re-homed mis-materialized plan node(s):', repaired);
  }
  return { repaired };
}
