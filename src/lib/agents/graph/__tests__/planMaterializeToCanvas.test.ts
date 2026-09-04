import { describe, it, expect } from 'vitest';
import { compileOrchestratorToIr } from '../compileOrchestrator';
import { irToCanvas } from '../irToCanvas';
import type { OrchestratorState } from '../../types';

function makeOrch(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    id: 'orch-test',
    name: 'Test Plan',
    projectId: 'test-proj',
    targetProjectIds: ['test-proj'],
    objective: 'Test objective',
    steps: [],
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

describe('compileOrchestratorToIr + irToCanvas roundtrip', () => {
  it('compiles a simple 2-step sequential plan', () => {
    const orch = makeOrch({
      steps: [
        { id: 's1', description: 'Step 1', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
        { id: 's2', description: 'Step 2', status: 'pending', missionIds: [], dependsOn: ['s1'], autonomyLevel: 'supervised' },
      ],
    });

    const ir = compileOrchestratorToIr(orch);
    expect(ir.nodes).toHaveLength(2);
    expect(ir.edges).toHaveLength(1);
    expect(ir.edges[0].from).toBe('s1');
    expect(ir.edges[0].to).toBe('s2');

    const { drafts, chains } = irToCanvas(ir);
    expect(drafts).toHaveLength(2);
    expect(chains).toHaveLength(1);
    // Bare step ids (no 'draft:' prefix) should be handled by nodeIdToRef
    expect(chains[0].sourceRef).toContain('s1');
    expect(chains[0].targetRef).toContain('s2');
  });

  it('compiles joinGroup into a join node', () => {
    const orch = makeOrch({
      steps: [
        { id: 'a', description: 'Branch A', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'fan-out' },
        { id: 'b', description: 'Branch B', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised', joinGroup: 'fan-out' },
        { id: 'c', description: 'After join', status: 'pending', missionIds: [], dependsOn: ['a'], autonomyLevel: 'supervised' },
      ],
    });

    const ir = compileOrchestratorToIr(orch);
    // 3 task nodes + 1 join node
    expect(ir.nodes).toHaveLength(4);
    const joinNode = ir.nodes.find((n) => n.kind === 'join');
    expect(joinNode).toBeDefined();
    expect(joinNode!.id).toBe('join:fan-out');

    // Edges: a→join, b→join, join→c (c depends on 'a' which is in group, so rerouted to join)
    const edgesToJoin = ir.edges.filter((e) => e.to === 'join:fan-out');
    expect(edgesToJoin).toHaveLength(2);

    const edgesFromJoin = ir.edges.filter((e) => e.from === 'join:fan-out');
    expect(edgesFromJoin).toHaveLength(1);
    expect(edgesFromJoin[0].to).toBe('c');
  });

  it('preserves role and onFail on task nodes', () => {
    const orch = makeOrch({
      steps: [
        {
          id: 's1',
          description: 'Implement feature',
          status: 'pending',
          missionIds: [],
          dependsOn: [],
          autonomyLevel: 'supervised',
          role: 'worker',
          onFail: 'fix',
          maxAttempts: 3,
        },
      ],
    });

    const ir = compileOrchestratorToIr(orch);
    const taskNode = ir.nodes.find((n) => n.kind === 'task');
    expect(taskNode).toBeDefined();
    expect(taskNode!.maxAttempts).toBe(3);
    // role and onFail are attached as extra properties
    expect((taskNode as unknown as { role?: string }).role).toBe('worker');
    expect((taskNode as unknown as { onFail?: string }).onFail).toBe('fix');
  });

  it('irToCanvas handles bare step ids without draft: prefix', () => {
    const orch = makeOrch({
      steps: [
        { id: 'step-alpha', description: 'Alpha', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
        { id: 'step-beta', description: 'Beta', status: 'pending', missionIds: [], dependsOn: ['step-alpha'], autonomyLevel: 'supervised' },
      ],
    });

    const ir = compileOrchestratorToIr(orch);
    const { drafts, chains } = irToCanvas(ir);

    expect(drafts).toHaveLength(2);
    expect(drafts[0].id).toBe('step-alpha');
    expect(drafts[1].id).toBe('step-beta');

    expect(chains).toHaveLength(1);
    // The chain should reference the bare ids as draft refs
    expect(chains[0].sourceRef).toBe('draft:step-alpha');
    expect(chains[0].targetRef).toBe('draft:step-beta');
  });

  it('irToCanvas handles prefixed node ids (draft:)', () => {
    const orch = makeOrch({
      steps: [
        { id: 'draft:foo', description: 'Foo', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
        { id: 'draft:bar', description: 'Bar', status: 'pending', missionIds: [], dependsOn: ['draft:foo'], autonomyLevel: 'supervised' },
      ],
    });

    const ir = compileOrchestratorToIr(orch);
    const { drafts, chains } = irToCanvas(ir);

    expect(drafts).toHaveLength(2);
    expect(drafts[0].id).toBe('foo');
    expect(drafts[1].id).toBe('bar');

    expect(chains).toHaveLength(1);
    expect(chains[0].sourceRef).toBe('draft:foo');
    expect(chains[0].targetRef).toBe('draft:bar');
  });
});
