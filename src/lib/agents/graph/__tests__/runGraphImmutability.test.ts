/* graph/__tests__/runGraphImmutability.test.ts — GraphRun/NodeRun identity
   acceptance test (immut-graphrun-live-mutation fix).

   Real defect (craft review, 2026-08): runGraph.ts used to mutate the SAME
   GraphRun/NodeRun object in place across multiple `await` boundaries, then
   hand that live, still-mutating object straight to `persistRun`/`onRunUpdate`
   — which agentsStore.tsx stores verbatim as `activeGraphRun`. Any consumer
   that later captures a reference to that object (a `persistRun` spy here,
   a memoized selector in the app) would see it silently mutate underneath
   itself: a value captured while a node was still 'running' would read
   'done' by the time the run finished, because it was NEVER a snapshot —
   it was the live object.

   This test captures the run/nodeRun references passed to `persistRun` at
   two distinct points in the SAME execution (while node 'a' is 'running',
   and at the final call) and asserts:
   1. identity differs between the two captured references (no live sharing)
   2. the EARLIER reference still reports the value it had AT CAPTURE TIME,
      not whatever the run had mutated into by the time the test inspects it
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runGraph } from '../runGraph';
import { defaultBrainPolicy, defaultGraphDefaults, defaultStepContract } from '../types';
import type { GraphIR, GraphNode, GraphEdge, TaskNode, StepContract, GraphRun, NodeRun } from '../types';
import type { Mission } from '../../types';
import type { GraphExecutorDeps } from '../runGraph';

vi.mock('../brainBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../brainBus')>();
  return {
    ...actual,
    recallForStep: vi.fn().mockResolvedValue({ contextBlock: '', hitIds: [], citations: [] }),
    noteAfterStep: vi.fn(),
  };
});

function makeTaskNode(id: string, description: string, contractOverrides?: Partial<StepContract>): TaskNode {
  return {
    id,
    kind: 'task',
    label: id,
    description,
    contract: defaultStepContract(contractOverrides),
    brain: defaultBrainPolicy(),
    critical: true,
    maxAttempts: 1,
  };
}

function makeIr(nodes: GraphNode[], edges: GraphEdge[], opts?: Partial<GraphIR>): GraphIR {
  return {
    id: 'test-graph',
    version: 1,
    name: 'Test',
    objective: 'test objective',
    projectId: 'p1',
    defaults: defaultGraphDefaults(),
    nodes,
    edges,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'plan',
    ...opts,
  };
}

function makeMission(id: string, status: Mission['status'], worktree: string): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status,
    model: 'claude-sonnet',
    worktree,
    createdAt: Date.now(),
    progress: 0,
    planSteps: [],
    actionTimeline: [],
  };
}

describe('runGraph — GraphRun/NodeRun immutability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures two DIFFERENT object references across the run, each frozen at its own capture-time value', async () => {
    const nodes = [makeTaskNode('a', 'Do the thing')];
    const edges: GraphEdge[] = [];
    const ir = makeIr(nodes, edges);

    const snapshots: { runRef: GraphRun; nodeRunRef: NodeRun }[] = [];

    const deps: GraphExecutorDeps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => 'm-a'),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done', 'agent/branch-a'))),
      persistRun: vi.fn(async (run: GraphRun) => {
        snapshots.push({ runRef: run, nodeRunRef: run.nodeRuns['a'] });
      }),
      emit: vi.fn(),
    };

    const finalRun = await runGraph(ir, deps);

    expect(finalRun.status).toBe('done');
    expect(finalRun.nodeRuns['a'].status).toBe('done');

    // A snapshot was captured while node 'a' was still 'running' (the
    // "Mark running" persistRun call, well before the mission settles).
    const runningSnapshot = snapshots.find((s) => s.nodeRunRef.status === 'running');
    expect(runningSnapshot).toBeDefined();

    // Identity: the reference captured mid-run must be a DIFFERENT object
    // from the final returned run — never the same live object handed out
    // twice.
    expect(runningSnapshot!.runRef).not.toBe(finalRun);
    expect(runningSnapshot!.nodeRunRef).not.toBe(finalRun.nodeRuns['a']);

    // Value: the EARLIER snapshot must still read 'running' now, after the
    // run has fully completed — proving it was a true point-in-time
    // snapshot, not a live reference that silently mutated to 'done'
    // underneath the test.
    expect(runningSnapshot!.nodeRunRef.status).toBe('running');

    // The two distinct references must never be reference-equal even though
    // they belong to the same run id / node id.
    expect(runningSnapshot!.runRef.runId).toBe(finalRun.runId);
  });
});
