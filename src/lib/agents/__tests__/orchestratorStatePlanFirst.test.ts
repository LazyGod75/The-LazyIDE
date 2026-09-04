/* orchestratorStatePlanFirst.test.ts — Integration coverage for the
   plan-first path's two cross-module contracts audited 2026-07-28:

   1. modelId end-to-end: an exact catalog id set on a generate_plan step
      must survive createOrchestrator (orchestratorState.ts) ->
      compileOrchestratorToIr (graph/compileOrchestrator.ts's StepContract)
      -> launchOptsFromNode (graph/sgrOrchestratorRunner.ts) unchanged, so
      the mission the manager actually launches gets the model the user (or
      a proven lesson) named — not a tier default silently substituted.

   2. Identifier continuity under PARTIAL plan validation: when a user
      accepts several, NOT necessarily mutually-dependent steps at once
      (GraphProposalCard's checkbox partial-accept), every accepted step
      must actually run — closeStepDependencies (orchestratorState.ts) is
      the single helper both the canvas materialization step and the
      execute_plan action handler call, so the two can never diverge.
*/

import { describe, it, expect } from 'vitest';
import { createOrchestrator, closeStepDependencies } from '../orchestratorState';
import { compileOrchestratorToIr } from '../graph/compileOrchestrator';
import { launchOptsFromNode } from '../graph/sgrOrchestratorRunner';
import { validateManagerAction } from '../managerActionValidator';
import type { OrchestratorPlanStepInput, OrchestratorPlanStep, ManagerAction } from '../types';
import type { TaskNode } from '../graph/types';

// ── modelId end-to-end (plan-first path) ────────────────────────────

describe('modelId thread: createOrchestrator -> compileOrchestratorToIr -> launchOptsFromNode', () => {
  function makeStepInput(overrides: Partial<OrchestratorPlanStepInput> = {}): OrchestratorPlanStepInput {
    return { description: 'Implement the feature', ...overrides };
  }

  it('carries an exact modelId from the plan step all the way to SgrLaunchOpts', async () => {
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: 'Test plan',
      objective: 'Test objective',
      steps: [makeStepInput({ id: 's1', modelId: 'openai/gpt-5.4-mini' })],
    });

    // Leg 1: persisted onto OrchestratorPlanStep (not silently dropped by
    // createOrchestrator's explicit field-by-field map).
    expect(orch.steps[0].modelId).toBe('openai/gpt-5.4-mini');

    // Leg 2: compiled into the IR node's StepContract.
    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes.find((n) => n.kind === 'task') as TaskNode;
    expect(node).toBeDefined();
    expect(node.contract.modelId).toBe('openai/gpt-5.4-mini');

    // Leg 3: read back out for the actual launchMission call.
    const opts = launchOptsFromNode(node, orch.projectId);
    expect(opts.modelId).toBe('openai/gpt-5.4-mini');
    // The tier hint (absent here) must not silently reappear/override.
    expect(opts.model).toBeUndefined();
  });

  it('leaves modelId undefined end-to-end when the step only carries a tier hint', async () => {
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: 'Test plan',
      objective: 'Test objective',
      steps: [makeStepInput({ id: 's1', model: 'sonnet' })],
    });

    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes.find((n) => n.kind === 'task') as TaskNode;
    const opts = launchOptsFromNode(node, orch.projectId);

    expect(opts.model).toBe('sonnet');
    expect(opts.modelId).toBeUndefined();
  });

  it('carries modelId through a best-of-n contest step (contestN >= 2) the same way', async () => {
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: 'Test plan',
      objective: 'Test objective',
      steps: [makeStepInput({ id: 's1', contestN: 3, modelId: 'anthropic/claude-opus-4' })],
    });

    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes.find((n) => n.kind === 'contest');
    expect(node).toBeDefined();
    const opts = launchOptsFromNode(node!, orch.projectId);
    expect(opts.modelId).toBe('anthropic/claude-opus-4');
  });
});

// ── extraReadableProjectIds end-to-end (plan-first path) ────────────
//
// Cross-project READ access (confirmed gap, live run): a mission rooted at
// project B had NO way to read project A's source at all. launch_mission's
// own executor already resolved this field, but the GRAPH path
// (generate_plan -> execute_plan, the manager's primary multi-step planning
// surface) had no wiring — see OrchestratorPlanStepInput.extraReadableProjectIds's
// doc comment (../types.ts) for the full thread this proves, mirroring the
// modelId thread tests above exactly. The actual RESOLUTION of a declared
// id/name to a real root happens one layer further out, where the
// `launchMission` dep is implemented (agentsStore.tsx's SGR launchMission
// callback) — see agentsStore.test.tsx's "plan-first cross-project READ
// access" describe block for that leg.

describe('extraReadableProjectIds thread: createOrchestrator -> compileOrchestratorToIr -> launchOptsFromNode', () => {
  function makeStepInput(overrides: Partial<OrchestratorPlanStepInput> = {}): OrchestratorPlanStepInput {
    return { description: 'Implement the feature', ...overrides };
  }

  it('carries declared extraReadableProjectIds from the plan step all the way to SgrLaunchOpts', async () => {
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: 'Test plan',
      objective: 'Test objective',
      steps: [makeStepInput({ id: 's1', extraReadableProjectIds: ['other-project'] })],
    });

    // Leg 1: persisted onto OrchestratorPlanStep (not silently dropped by
    // createOrchestrator's explicit field-by-field map — the exact class of
    // bug that already happened once with modelId, see that field's own
    // comment in orchestratorState.ts).
    expect(orch.steps[0].extraReadableProjectIds).toEqual(['other-project']);

    // Leg 2: compiled into the IR node's StepContract.
    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes.find((n) => n.kind === 'task') as TaskNode;
    expect(node).toBeDefined();
    expect(node.contract.extraReadableProjectIds).toEqual(['other-project']);

    // Leg 3: read back out for the actual launchMission call — still the
    // UNRESOLVED id/name at this point (resolution to a real root happens
    // one layer further out, in the launchMission dep implementation).
    const opts = launchOptsFromNode(node, orch.projectId);
    expect(opts.extraReadableProjectIds).toEqual(['other-project']);
  });

  it('leaves extraReadableProjectIds undefined end-to-end when a step declares none — no regression', async () => {
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: 'Test plan',
      objective: 'Test objective',
      steps: [makeStepInput({ id: 's1' })],
    });

    expect(orch.steps[0].extraReadableProjectIds).toBeUndefined();

    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes.find((n) => n.kind === 'task') as TaskNode;
    expect(node.contract.extraReadableProjectIds).toBeUndefined();

    const opts = launchOptsFromNode(node, orch.projectId);
    expect(opts.extraReadableProjectIds).toBeUndefined();
  });

  it('carries extraReadableProjectIds through a best-of-n contest step (contestN >= 2) the same way', async () => {
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: 'Test plan',
      objective: 'Test objective',
      steps: [makeStepInput({ id: 's1', contestN: 3, extraReadableProjectIds: ['other-project'] })],
    });

    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes.find((n) => n.kind === 'contest');
    expect(node).toBeDefined();
    const opts = launchOptsFromNode(node!, orch.projectId);
    expect(opts.extraReadableProjectIds).toEqual(['other-project']);
  });

  it('round-trips through the reverse direction (irToOrchestratorState / nodeToStep) without dropping the field', async () => {
    const { irToOrchestratorState } = await import('../graph/compileOrchestrator');
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: 'Test plan',
      objective: 'Test objective',
      steps: [makeStepInput({ id: 's1', extraReadableProjectIds: ['other-project'] })],
    });

    const ir = compileOrchestratorToIr(orch);
    const roundTripped = irToOrchestratorState(ir);
    expect(roundTripped.steps[0].extraReadableProjectIds).toEqual(['other-project']);
  });

  it('survives validateManagerAction on a real generate_plan action and reaches the compiled step contract', async () => {
    // The whole point of this test: managerActionValidator.ts's generate_plan
    // validator only checks the top-level "objective" string (see its own
    // comment: per-step shape/repair is deliberately out of its scope, owned
    // by graph/planStepRepair.ts instead) — it must NEVER reconstruct or
    // otherwise touch `steps`, or a field like extraReadableProjectIds that
    // the model legitimately emitted on a step would be silently stripped
    // before createOrchestrator ever saw it, exactly the kind of gap this
    // whole thread (see the module header above) was written to close.
    const rawAction: unknown = {
      type: 'generate_plan',
      objective: 'Document project A the way project B calls it',
      steps: [
        { id: 's1', description: 'Document the API', extraReadableProjectIds: ['other-project'] },
      ],
    };

    const result = validateManagerAction(rawAction);
    expect(result.ok).toBe(true);

    const action = rawAction as Extract<ManagerAction, { type: 'generate_plan' }>;
    expect(action.steps?.[0].extraReadableProjectIds).toEqual(['other-project']);

    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test',
      projectId: 'proj-1',
      name: action.objective.slice(0, 80),
      objective: action.objective,
      steps: action.steps ?? [],
    });
    expect(orch.steps[0].extraReadableProjectIds).toEqual(['other-project']);

    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes.find((n) => n.kind === 'task') as TaskNode;
    expect(node.contract.extraReadableProjectIds).toEqual(['other-project']);
  });
});

// ── Identifier continuity under partial plan validation ─────────────

describe('closeStepDependencies — partial validation identifier continuity', () => {
  function makeStep(id: string, dependsOn: string[] = []): OrchestratorPlanStep {
    return {
      id,
      description: `Step ${id}`,
      status: 'pending',
      missionIds: [],
      dependsOn,
      autonomyLevel: 'supervised',
    };
  }

  it('keeps EVERY explicitly selected step, even when they are mutually independent', () => {
    // A -> B -> C (chain), D and E are independent single steps.
    const steps = [
      makeStep('A'),
      makeStep('B', ['A']),
      makeStep('C', ['B']),
      makeStep('D'),
      makeStep('E'),
    ];

    // User checks B and D — two steps with NO dependency relationship
    // between them. The old bug seeded the closure from stepIds[0] only
    // (here 'B'), so 'D' silently never ran despite being checked.
    const result = closeStepDependencies(steps, ['B', 'D']);
    const ids = result.map((s) => s.id).sort();

    expect(ids).toContain('B');
    expect(ids).toContain('D');
    // B's own dependency (A) must also be included so B is actually runnable.
    expect(ids).toContain('A');
    // C and E were never selected and are not a dependency of anything
    // selected — must NOT be pulled in.
    expect(ids).not.toContain('C');
    expect(ids).not.toContain('E');
  });

  it('resolves a MULTI-LEVEL transitive dependency chain (not just one hop)', () => {
    // A <- B <- C <- D (D depends on C depends on B depends on A).
    const steps = [
      makeStep('A'),
      makeStep('B', ['A']),
      makeStep('C', ['B']),
      makeStep('D', ['C']),
    ];

    // Only D is explicitly selected — A and B must still be pulled in via
    // C, not just C itself (the pre-fix materialization code only walked
    // ONE level of dependsOn, so a 3-deep chain like this would have
    // dropped A silently).
    const result = closeStepDependencies(steps, ['D']);
    const ids = result.map((s) => s.id).sort();
    expect(ids).toEqual(['A', 'B', 'C', 'D']);
  });

  it('is the SAME closure execute_plan and canvas materialization must both use — a real fixture round trip', async () => {
    const orch = await createOrchestrator({
      projectRoot: '/tmp/plan-first-test-2',
      projectId: 'proj-2',
      name: 'Partial validation plan',
      objective: 'Test objective',
      steps: [
        { description: 'Branch 1' },
        { description: 'Branch 2' },
        { description: 'Branch 3, depends on Branch 1' },
      ],
    });
    // Rewire dependsOn onto the real generated ids (createOrchestrator mints
    // its own step ids when none are supplied).
    const [b1, b2, b3] = orch.steps;
    const wired = { ...orch, steps: [b1, b2, { ...b3, dependsOn: [b1.id] }] };

    // User accepts Branch 2 and Branch 3 (skips Branch 1 directly, but
    // Branch 3 needs it).
    const materialized = closeStepDependencies(wired.steps, [b2.id, b3.id]);
    const materializedIds = new Set(materialized.map((s) => s.id));

    // What execute_plan would separately compute for the SAME seed set must
    // be identical — this is the actual continuity guarantee.
    const executed = closeStepDependencies(wired.steps, [b2.id, b3.id]);
    expect(new Set(executed.map((s) => s.id))).toEqual(materializedIds);
    expect(materializedIds.has(b1.id)).toBe(true); // pulled in as b3's dep
    expect(materializedIds.has(b2.id)).toBe(true);
    expect(materializedIds.has(b3.id)).toBe(true);
  });
});
