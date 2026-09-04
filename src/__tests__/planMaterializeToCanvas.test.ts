/**
 * planMaterializeToCanvas.test.ts — Tests that compileOrchestratorToIr + irToCanvas
 * produces the correct canvas primitives (drafts, chains, routers, joins) from
 * an OrchestratorState, matching dependsOn edges and joinGroup parallelism.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { compileOrchestratorToIr } from '../lib/agents/graph/compileOrchestrator';
import { irToCanvas, irToProposedCanvas } from '../lib/agents/graph/irToCanvas';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef } from '../components/agents/canvas/canvasTypes';
import type { OrchestratorState } from '../lib/agents/types';

function makeOrch(overrides?: Partial<OrchestratorState>): OrchestratorState {
  return {
    id: 'orch-test-1',
    name: 'Test Plan',
    projectId: 'proj-1',
    targetProjectIds: [],
    objective: 'Build feature with tests',
    steps: [
      { id: '0', description: 'Write the API endpoint', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
      { id: '1', description: 'Write tests', status: 'pending', missionIds: [], dependsOn: ['0'], autonomyLevel: 'supervised' },
      { id: '2', description: 'Review the code', status: 'pending', missionIds: [], dependsOn: ['1'], autonomyLevel: 'supervised' },
    ],
    currentStep: 0,
    status: 'planning',
    budget: { spentCents: 0 },
    childMissionIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    autonomyLevel: 'supervised',
    ...overrides,
  };
}

describe('planMaterializeToCanvas', () => {
  beforeEach(() => {
    _resetCanvasStoreForTests();
  });

  it('produces N drafts matching the plan steps', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const { drafts } = irToCanvas(ir);

    expect(drafts).toHaveLength(3);
    expect(drafts[0].title).toBe('Write the API endpoint');
    expect(drafts[1].title).toBe('Write tests');
    expect(drafts[2].title).toBe('Review the code');
  });

  it('produces chains matching dependsOn edges', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const { drafts, chains } = irToCanvas(ir);

    // Step 1 depends on step 0, step 2 depends on step 1 → 2 control edges
    expect(chains).toHaveLength(2);
    expect(chains[0].sourceRef).toBe(makeRef('draft', drafts[0].id));
    expect(chains[0].targetRef).toBe(makeRef('draft', drafts[1].id));
    expect(chains[1].sourceRef).toBe(makeRef('draft', drafts[1].id));
    expect(chains[1].targetRef).toBe(makeRef('draft', drafts[2].id));
  });

  it('all drafts have createdBy=manager', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const { drafts } = irToCanvas(ir);

    for (const d of drafts) {
      expect(d.createdBy).toBe('manager');
    }
  });

  it('all chains have createdBy=manager', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const { chains } = irToCanvas(ir);

    for (const c of chains) {
      expect(c.createdBy).toBe('manager');
    }
  });

  it('applies drafts and chains to canvasStore via batch apply', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const { drafts, chains } = irToCanvas(ir);

    const canvasState = canvasStoreVanilla.getState();
    for (const d of drafts) canvasState.addDraft(d);
    for (const c of chains) canvasState.addChain(c);

    const state = canvasStoreVanilla.getState();
    expect(state.drafts).toHaveLength(3);
    expect(state.chains).toHaveLength(2);
    // Verify chain connectivity
    expect(state.chains[0].sourceRef).toBe(makeRef('draft', drafts[0].id));
    expect(state.chains[0].targetRef).toBe(makeRef('draft', drafts[1].id));
  });

  it('handles parallel steps (no mutual deps) as separate drafts', () => {
    const orch = makeOrch({
      steps: [
        { id: 'a', description: 'Task A', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
        { id: 'b', description: 'Task B', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
        { id: 'c', description: 'Join', status: 'pending', missionIds: [], dependsOn: ['a', 'b'], autonomyLevel: 'supervised' },
      ],
    });
    const ir = compileOrchestratorToIr(orch);
    const { drafts, chains } = irToCanvas(ir);

    expect(drafts).toHaveLength(3);
    // Two edges: a→c and b→c
    expect(chains).toHaveLength(2);
    const targets = chains.map((c) => c.targetRef);
    expect(targets.every((t) => t === makeRef('draft', drafts[2].id))).toBe(true);
  });

  it('handles a single-step plan (no edges)', () => {
    const orch = makeOrch({
      steps: [
        { id: 'solo', description: 'Solo task', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
      ],
    });
    const ir = compileOrchestratorToIr(orch);
    const { drafts, chains } = irToCanvas(ir);

    expect(drafts).toHaveLength(1);
    expect(chains).toHaveLength(0);
  });

  it('handles empty plan (no steps)', () => {
    const orch = makeOrch({ steps: [] });
    const ir = compileOrchestratorToIr(orch);
    const { drafts, chains } = irToCanvas(ir);

    expect(drafts).toHaveLength(0);
    expect(chains).toHaveLength(0);
  });

  it('preserves agentName and model from step contract', () => {
    const orch = makeOrch({
      steps: [
        {
          id: '0',
          description: 'Write API',
          status: 'pending',
          missionIds: [],
          dependsOn: [],
          autonomyLevel: 'supervised',
          agentName: 'api-agent',
          model: 'haiku',
        },
      ],
    });
    const ir = compileOrchestratorToIr(orch);
    const { drafts } = irToCanvas(ir);

    expect(drafts[0].agentName).toBe('api-agent');
    expect(drafts[0].model).toBe('haiku');
  });

  it('filtered orchestrator (partial stepIds) produces subset of drafts', () => {
    const orch = makeOrch();
    // Filter to only step 1 and its dependency step 0
    const subset = new Set(['0', '1']);
    const filteredOrch = {
      ...orch,
      steps: orch.steps.filter((s) => subset.has(s.id)),
    };
    const ir = compileOrchestratorToIr(filteredOrch);
    const { drafts, chains } = irToCanvas(ir);

    expect(drafts).toHaveLength(2);
    expect(drafts[0].title).toBe('Write the API endpoint');
    expect(drafts[1].title).toBe('Write tests');
    // One edge: 0→1
    expect(chains).toHaveLength(1);
  });

  // Bug fix (FINDINGS-RUN-NUIT.md QA repro: "une zone projet Transverse
  // apparaît sans avoir été demandée" — irToCanvas never read ir.projectId
  // at all, so every plan-derived draft/router/join carried NO projectId
  // and reconciler.ts's own "absent -> Transverse" convention scattered
  // the plan's own steps away from the project it was drawn up for).
  it('stamps every draft with the plan\'s own projectId — a plan step never lands in the Transverse zone', () => {
    const orch = makeOrch(); // projectId: 'proj-1'
    const ir = compileOrchestratorToIr(orch);
    const { drafts } = irToCanvas(ir);

    expect(drafts).toHaveLength(3);
    for (const d of drafts) {
      expect(d.projectId).toBe('proj-1');
    }
  });

  it('stamps a joinGroup-derived join with the same plan projectId too — the fan-in node stays with its project as well', () => {
    const orch = makeOrch({
      steps: [
        { id: 'a', description: 'Task A', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'b', description: 'Task B', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'c', description: 'After join', status: 'pending', missionIds: [], dependsOn: ['a', 'b'], autonomyLevel: 'supervised' },
      ],
    });
    const ir = compileOrchestratorToIr(orch);
    const { joins, drafts } = irToCanvas(ir);

    expect(joins).toHaveLength(1);
    expect(joins[0].projectId).toBe('proj-1');
    expect(drafts.every((d) => d.projectId === 'proj-1')).toBe(true);
  });

  it('preserves every join source when materializing a parallel cohort so the canvas keeps the real fan-in', () => {
    const orch = makeOrch({
      steps: [
        { id: 'a', description: 'Task A', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'b', description: 'Task B', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'c', description: 'After join', status: 'pending', missionIds: [], dependsOn: ['a', 'b'], autonomyLevel: 'supervised' },
      ],
    });

    const { joins } = irToCanvas(compileOrchestratorToIr(orch));

    expect(joins).toHaveLength(1);
    expect(joins[0].sourceRefs).toEqual([makeRef('draft', 'a'), makeRef('draft', 'b')]);
  });

  it('emits exactly one downstream chain from a synthesized join even when the next step lists every parallel dependency', () => {
    const orch = makeOrch({
      steps: [
        { id: 'a', description: 'Task A', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'b', description: 'Task B', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'c', description: 'After join', status: 'pending', missionIds: [], dependsOn: ['a', 'b'], autonomyLevel: 'supervised' },
      ],
    });

    const { chains } = irToCanvas(compileOrchestratorToIr(orch));
    const downstreamChains = chains.filter((chain) => chain.sourceRef === makeRef('join', 'g1') && chain.targetRef === makeRef('draft', 'c'));

    expect(downstreamChains).toHaveLength(1);
  });

  it('a plan created with a different active project stamps THAT project — never a hardcoded/guessed id', () => {
    const orch = makeOrch({ projectId: 'other-project' });
    const ir = compileOrchestratorToIr(orch);
    const { drafts } = irToCanvas(ir);

    expect(drafts.every((d) => d.projectId === 'other-project')).toBe(true);
  });
});

describe('irToProposedCanvas (chantier 3, plan-first canvas preview)', () => {
  it('stamps every draft/chain/join with proposedPlanId, ids identical to a plain irToCanvas', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);

    const plain = irToCanvas(ir);
    const proposed = irToProposedCanvas(ir, 'plan-xyz');

    expect(proposed.drafts.map((d) => d.id)).toEqual(plain.drafts.map((d) => d.id));
    expect(proposed.chains.map((c) => c.id)).toEqual(plain.chains.map((c) => c.id));
    expect(proposed.drafts.every((d) => d.proposedPlanId === 'plan-xyz')).toBe(true);
    expect(proposed.chains.every((c) => c.proposedPlanId === 'plan-xyz')).toBe(true);
  });

  it('preserves the plan projectId alongside the proposedPlanId stamp — a still-pending proposed step still lands in the right zone, never Transverse', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const proposed = irToProposedCanvas(ir, 'plan-xyz');

    expect(proposed.drafts.every((d) => d.projectId === 'proj-1')).toBe(true);
  });

  it('stamps joinGroup-derived joins too (fan-in preview)', () => {
    const orch = makeOrch({
      steps: [
        { id: 'a', description: 'Task A', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'b', description: 'Task B', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'g1' },
        { id: 'c', description: 'After join', status: 'pending', missionIds: [], dependsOn: ['a', 'b'], autonomyLevel: 'supervised' },
      ],
    });
    const ir = compileOrchestratorToIr(orch);
    const proposed = irToProposedCanvas(ir, 'plan-join');

    expect(proposed.joins).toHaveLength(1);
    expect(proposed.joins[0].proposedPlanId).toBe('plan-join');
  });

  it('never mutates the source GraphIR (immutable — new objects only)', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const nodesBefore = ir.nodes;
    const edgesBefore = ir.edges;

    irToProposedCanvas(ir, 'plan-xyz');

    expect(ir.nodes).toBe(nodesBefore);
    expect(ir.edges).toBe(edgesBefore);
  });
});
