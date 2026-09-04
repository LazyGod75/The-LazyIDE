/* graph/planStepRepair.ts — P0 crash, round 3 (P2): pure repair/validation
   pass for a generate_plan action's `steps` list, run BEFORE
   orchestratorState.ts's `createOrchestrator` persists it and BEFORE it is
   ever rendered on the canvas.

   ── THE GAP ─────────────────────────────────────────────────────────
   managerEngine.ts's generate_plan tool spec (item 45) documents every
   rich contract field a step can carry (agentName/model/effort/dependsOn/
   ...) but never once documents the `id` field itself, let alone a
   uniqueness requirement — yet the model routinely invents short, generic,
   MEMORABLE step ids ("audit", "verify", "fix", "design") specifically so
   `dependsOn` entries can reference them by name. Nothing ever enforced
   that those ids stay unique, either within one plan's own steps or
   (worse) across TWO SEPARATE plans generated in different manager turns —
   orchestratorState.ts's `createOrchestrator` takes `s.id` VERBATIM
   (`id: s.id ?? generateStepId(id, idx)`) with zero collision check. A
   step with NO explicit id at all is broken a different way: the
   generated fallback id (`<orchestratorId>-step-<index>`) is a value the
   MODEL can never predict ahead of time — since the orchestrator id
   doesn't exist until `createOrchestrator` runs — so any `dependsOn` entry
   naming that step (which the model could only have invented from thin
   air) silently resolves to nothing, and compileOrchestrator.ts's edge
   builder still emits a dangling edge for it rather than catching the gap.

   ── THIS REPAIR ─────────────────────────────────────────────────────
   `repairPlanSteps` closes both gaps, pure and side-effect-free:
     1. Any step whose EXPLICIT `id` collides with an earlier step in the
        SAME plan, or with a `takenIds` entry the caller supplies (the
        canonical caller — agentsStore.tsx's `generate_plan` case — passes
        every draft/join id already live on the canvas, proposed or
        materialized, so a plan reusing "audit" while an EARLIER plan's
        "audit" is still pending/live gets caught right here, before
        `createOrchestrator` ever persists the collision) is renamed to a
        fresh id, and every sibling step's `dependsOn` referencing the OLD
        id is rewritten to the new one.
     2. Any `dependsOn` entry that (after the rename above) still does not
        match any step this plan actually defines is dropped — the model
        could never have resolved it to anything real, so keeping it would
        only feed compileOrchestrator.ts a dangling edge.
   Steps with no explicit `id` are left untouched (createOrchestrator's own
   fallback already guarantees THEM a unique id — the collision risk this
   module exists for is specific to EXPLICIT, model-chosen ids).

   This is the layer that stops the realistic case (two plans reusing a
   step name) at the SOURCE, before a colliding id ever reaches the
   canvas — keeping the "same id, same object" identity-continuity
   invariant chantier 3's accept/partial-accept flow relies on
   (canvasTypes.ts's `DraftSpec.proposedPlanId` doc comment) intact for
   the common path. canvasRefIntegrity.ts's `ensureUniqueCanvasRefs` is
   the SIBLING, canvas-side backstop for whatever this layer cannot see
   (a corrupted persisted file, a future caller bypassing generate_plan
   entirely) — see that module's own header for why both exist.
*/

import type { OrchestratorPlanStepInput } from '../types.js';
import { generateCanvasId } from '../../../components/agents/canvas/canvasIds.js';

export interface PlanStepRepairResult {
  steps: OrchestratorPlanStepInput[];
  /** Human-readable one-liners describing exactly what changed — empty
   *  when nothing needed repair (the overwhelming common case). Callers
   *  log/toast these so a repair is never silent (P2's own requirement:
   *  "a repaired plan is still rendered rather than silently broken"). */
  notes: string[];
}

/**
 * Repairs `steps` in place-of-mutation (returns a fresh array; `steps`
 * itself is never touched). `takenIds` seeds the collision set with ids
 * already in use OUTSIDE this plan (e.g. every draft/join id currently
 * live on the canvas) — omit it to only dedupe WITHIN this one plan's own
 * steps.
 */
export function repairPlanSteps(
  steps: readonly OrchestratorPlanStepInput[],
  takenIds: ReadonlySet<string> = new Set(),
  idFactory: (prefix: string) => string = generateCanvasId,
): PlanStepRepairResult {
  const notes: string[] = [];
  const seenIds = new Set<string>(takenIds);
  const renamedIds = new Map<string, string>(); // old id -> new id, this plan only

  const dedupedSteps = steps.map((step) => {
    if (step.id === undefined) return step; // no explicit id — nothing to dedupe here, see module header
    if (!seenIds.has(step.id)) {
      seenIds.add(step.id);
      return step;
    }
    const newId = idFactory('step');
    seenIds.add(newId);
    renamedIds.set(step.id, newId);
    notes.push(`step id "${step.id}" collided with another step id already in use — renamed to "${newId}"`);
    return { ...step, id: newId };
  });

  // `renamedIds` deliberately keeps only the LAST rename recorded for a
  // given old id: a CROSS-plan collision (via `takenIds`) is unambiguous —
  // there is only ever ONE occurrence of that id inside THIS plan, so
  // every dependsOn naming it meant that one step. A same-plan SELF-
  // collision (two steps in this SAME plan reusing an id) has no way to
  // disambiguate which occurrence a sibling's dependsOn meant; applying
  // the rename uniformly keeps that dependency edge ALIVE (pointing at
  // whichever step actually needed it) rather than arbitrarily leaving it
  // on the id that happened to keep its original name — see this
  // function's own test for the exact tradeoff.

  // Every id this plan actually defines, post-rename — the only valid
  // dependsOn targets (see module header: a dependsOn naming anything else
  // was never resolvable by the model in the first place).
  const definedIds = new Set(dedupedSteps.map((s) => s.id).filter((id): id is string => id !== undefined));

  const repairedSteps = dedupedSteps.map((step) => {
    if (!step.dependsOn || step.dependsOn.length === 0) return step;
    const remapped = step.dependsOn.map((dep) => renamedIds.get(dep) ?? dep);
    const dropped = remapped.filter((dep) => !definedIds.has(dep));
    if (dropped.length === 0 && remapped.every((dep, i) => dep === step.dependsOn![i])) {
      return step; // nothing changed for this step
    }
    if (dropped.length > 0) {
      const label = step.id ?? step.description.slice(0, 40);
      notes.push(`step "${label}" dependsOn unknown step id(s) [${dropped.join(', ')}] — dropped`);
    }
    return { ...step, dependsOn: remapped.filter((dep) => definedIds.has(dep)) };
  });

  // 2026-08-04 (UC3 dogfood — M3 `worktree_creation_failed: base branch
  // 'agent/M2-...' does not exist`): the model hallucinated a literal
  // `baseBranch: "agent/M2-..."` onto a step (it mimicked the manager
  // prompt's own "continue from agent/M40-." example). The SGR treats an
  // explicit baseBranch as authoritative and git then refuses a branch
  // name that does not exist — the whole chain downstream stalls. A
  // baseBranch that is OBVIOUSLY not a real branch name (contains an
  // ellipsis/whitespace, or does not look like one of this app's own
  // `agent/...` branches) is dropped here so the SGR falls back to its
  // dependency-inherited inference (resolveInheritedBranches), which is
  // always correct for a plan graph. Real, deliberate baseBranches (the
  // continuation doctrine's "continue from agent/M40-.") survive: they
  // match the `agent/` shape and contain no ellipsis.
  const repairedBaseBranches = repairedSteps.map((step) => {
    if (!step.baseBranch) return step;
    const bb = step.baseBranch.trim();
    if (
      bb.includes('...') ||
      bb.includes(' ') ||
      !/^agent\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bb)
    ) {
      const label = step.id ?? step.description.slice(0, 40);
      notes.push(`step "${label}" carried an invalid baseBranch "${bb}" (not a real branch name) — dropped, the SGR will inherit the dependency branch instead`);
      return { ...step, baseBranch: undefined };
    }
    return step;
  });

  return { steps: repairedBaseBranches, notes };
}
