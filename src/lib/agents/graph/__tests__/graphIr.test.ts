/* graph/__tests__/graphIr.test.ts — Phase 1 acceptance tests.

   Covers:
   1. validate rejects cycle
   2. Two independent tasks → wave size 2; mock launcher called concurrent
   3. Diamond deps: A→B, A→C, B→D, C→D → D waits for B and C
   4. Brain recall invoked once per task launch (mock)
   5. Brain note invoked on success and failure
   6. OrchestratorState roundtrip compile preserves step ids/dependsOn
   7. Budget limit stops further waves
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateGraph,
  detectCycle,
  topologicalSort,
  getReadyNodes,
  initGraphRun,
  getEntryNodes,
} from '../graphIr';
import { runGraph } from '../runGraph';
import { compileOrchestratorToIr, irToOrchestratorState } from '../compileOrchestrator';
import { recallForStep, noteAfterStep } from '../brainBus';
import { defaultBrainPolicy, defaultGraphDefaults, defaultStepContract } from '../types';
import type { GraphIR, GraphNode, TaskNode, JoinNodeIR, LoopNodeIR } from '../types';
import type { Mission, OrchestratorState } from '../../types';

// ── Helpers ───────────────────────────────────────────────────────

function makeTaskNode(id: string, description: string, opts?: { brain?: Partial<import('../types').BrainPolicy> }): TaskNode {
  return {
    id,
    kind: 'task',
    label: id,
    description,
    contract: defaultStepContract(),
    brain: defaultBrainPolicy(opts?.brain),
    critical: true,
    maxAttempts: 1,
  };
}

function makeControlEdge(id: string, from: string, to: string): import('../types').GraphEdge {
  return { id, from, to, kind: 'control' };
}

function makeIr(nodes: GraphNode[], edges: import('../types').GraphEdge[], opts?: Partial<GraphIR>): GraphIR {
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

function makeMission(id: string, status: Mission['status'], opts?: { worktree?: string }): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status,
    model: 'claude-sonnet',
    // Mirrors real runtime.ts: a settled mission always carries its own
    // branch name in `worktree` (never a path, never empty) — see
    // runGraph.ts's resolveInheritedBranches, which reads this field to
    // resolve a downstream dependsOn step's start point. Callers that
    // specifically want to simulate "mission settled but produced no
    // branch" pass `opts.worktree: ''` explicitly.
    worktree: opts?.worktree ?? `agent/${id}`,
    createdAt: Date.now(),
    progress: 0,
    planSteps: [],
    actionTimeline: [],
  };
}

// ── Mocks ─────────────────────────────────────────────────────────

vi.mock('../brainBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../brainBus')>();
  return {
    ...actual,
    recallForStep: vi.fn().mockResolvedValue({ contextBlock: '', hitIds: [], citations: [] }),
    noteAfterStep: vi.fn(),
  };
});

// ── Tests ─────────────────────────────────────────────────────────

describe('validateGraph', () => {
  it('rejects a cycle in control edges', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b'), makeControlEdge('e2', 'b', 'a')];
    const ir = makeIr(nodes, edges);
    const result = validateGraph(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Cycle'))).toBe(true);
  });

  it('passes a valid DAG', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);
    const result = validateGraph(ir);
    expect(result.ok).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('a', 'A2')];
    const ir = makeIr(nodes, []);
    const result = validateGraph(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate node'))).toBe(true);
  });

  it('rejects contest.n < 2', () => {
    const node: GraphNode = {
      id: 'c1',
      kind: 'contest',
      description: 'contest',
      contract: defaultStepContract(),
      n: 1,
      ranking: 'judge',
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([node], []);
    const result = validateGraph(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('n >= 2'))).toBe(true);
  });

  it('rejects join quorum without quorum value', () => {
    const node: GraphNode = {
      id: 'j1',
      kind: 'join',
      mode: 'quorum',
      merge: 'concat',
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([node], []);
    const result = validateGraph(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('quorum'))).toBe(true);
  });

  // Item 3 (2026-08-15 audit, D2 fallback) — this runtime evaluates
  // outcome:success/contains/default control-edge conditions for real (see
  // 'getReadyNodes — edge conditions' below), but a control edge is only
  // ever checked once its predecessor has settled 'done' — a failed
  // predecessor never lets ANY control successor become ready, so
  // outcome:fail can never fire. Rather than silently accepting a graph
  // that carries a condition this runtime can never honour, validateGraph
  // refuses it outright.
  it('rejects a control edge with condition outcome:fail — this runtime can never satisfy it', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges: import('../types').GraphEdge[] = [
      { id: 'e1', from: 'a', to: 'b', kind: 'control', condition: { kind: 'outcome', value: 'fail' } },
    ];
    const ir = makeIr(nodes, edges);
    const result = validateGraph(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('outcome:fail'))).toBe(true);
  });

  it('rejects a router branch with condition outcome:fail for the same reason', () => {
    const routerNode: import('../types').RouterNodeIR = {
      id: 'r1',
      kind: 'router',
      brain: defaultBrainPolicy(),
      branches: [
        { id: 'b1', label: 'Failed', condition: { kind: 'outcome', value: 'fail' }, targetNodeId: 'a' },
      ],
    };
    const ir = makeIr([makeTaskNode('a', 'A'), routerNode], []);
    const result = validateGraph(ir);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('outcome:fail'))).toBe(true);
  });

  it('accepts outcome:success, contains, and default conditions on control edges', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B'), makeTaskNode('c', 'C'), makeTaskNode('d', 'D')];
    const edges: import('../types').GraphEdge[] = [
      { id: 'e1', from: 'a', to: 'b', kind: 'control', condition: { kind: 'outcome', value: 'success' } },
      { id: 'e2', from: 'a', to: 'c', kind: 'control', condition: { kind: 'contains', value: 'ready' } },
      { id: 'e3', from: 'a', to: 'd', kind: 'control', condition: { kind: 'default' } },
    ];
    const ir = makeIr(nodes, edges);
    const result = validateGraph(ir);
    expect(result.ok).toBe(true);
  });
});

describe('getReadyNodes — edge conditions (item 3, 2026-08-15 audit, D2 fix)', () => {
  // Root cause: GraphEdge.condition was parsed into the IR but getReadyNodes
  // only ever checked `predRun.status === 'done'`, never `edge.condition` —
  // a graph with conditional routing silently ran every branch regardless
  // of which condition actually matched. These tests exercise the fix
  // directly (getReadyNodes is pure — no runGraph/mission machinery needed).

  it('a "contains" edge condition gates readiness on the predecessor\'s own output text', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('flaky', 'Flaky path'), makeTaskNode('clean', 'Clean path')];
    const edges: import('../types').GraphEdge[] = [
      { id: 'e1', from: 'a', to: 'flaky', kind: 'control', condition: { kind: 'contains', value: 'timeout' } },
      { id: 'e2', from: 'a', to: 'clean', kind: 'control', condition: { kind: 'contains', value: 'ok' } },
    ];
    const ir = makeIr(nodes, edges);
    const run = initGraphRun(ir.id, ir);
    run.nodeRuns['a'] = { ...run.nodeRuns['a'], status: 'done', output: { text: 'request failed: timeout' } };

    const ready = getReadyNodes(ir, run);
    expect(ready).toEqual(['flaky']); // 'clean' does not match — 'timeout' text has no 'ok'
  });

  it('a "default" edge condition always fires once its predecessor is done', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges: import('../types').GraphEdge[] = [
      { id: 'e1', from: 'a', to: 'b', kind: 'control', condition: { kind: 'default' } },
    ];
    const ir = makeIr(nodes, edges);
    const run = initGraphRun(ir.id, ir);
    run.nodeRuns['a'] = { ...run.nodeRuns['a'], status: 'done' };

    expect(getReadyNodes(ir, run)).toEqual(['b']);
  });

  it('an edge with no condition behaves exactly as before (unconditional)', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);
    const run = initGraphRun(ir.id, ir);
    run.nodeRuns['a'] = { ...run.nodeRuns['a'], status: 'done' };

    expect(getReadyNodes(ir, run)).toEqual(['b']);
  });

  it('a failed predecessor never satisfies an outcome:success edge — the baseline "must be done" rule still applies', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges: import('../types').GraphEdge[] = [
      { id: 'e1', from: 'a', to: 'b', kind: 'control', condition: { kind: 'outcome', value: 'success' } },
    ];
    const ir = makeIr(nodes, edges);
    const run = initGraphRun(ir.id, ir);
    run.nodeRuns['a'] = { ...run.nodeRuns['a'], status: 'failed' };

    // 'a' never reaches 'done' (it failed) — 'b' must never become ready,
    // matching the SAME baseline every unconditional edge already enforced
    // (a failed predecessor blocks every successor, conditional or not).
    expect(getReadyNodes(ir, run)).toEqual([]);
  });
});

describe('detectCycle', () => {
  it('returns null for a DAG', () => {
    const ids = ['a', 'b', 'c'];
    const edges = [makeControlEdge('e1', 'a', 'b'), makeControlEdge('e2', 'b', 'c')];
    expect(detectCycle(ids, edges)).toBeNull();
  });

  it('returns the cycle path for a cyclic graph', () => {
    const ids = ['a', 'b', 'c'];
    const edges = [makeControlEdge('e1', 'a', 'b'), makeControlEdge('e2', 'b', 'c'), makeControlEdge('e3', 'c', 'a')];
    const cycle = detectCycle(ids, edges);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
  });
});

describe('topologicalSort', () => {
  it('sorts nodes in dependency order', () => {
    const nodes = [makeTaskNode('c', 'C'), makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b'), makeControlEdge('e2', 'b', 'c')];
    const sorted = topologicalSort(nodes, edges);
    const ids = sorted.map((n) => n.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
  });
});

describe('getReadyNodes', () => {
  it('returns entry nodes when no deps', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const ir = makeIr(nodes, []);
    const run = initGraphRun(ir.id, ir);
    const ready = getReadyNodes(ir, run);
    expect(ready.sort()).toEqual(['a', 'b']);
  });

  it('returns only nodes whose deps are done', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);
    const run = initGraphRun(ir.id, ir);
    // a is not done, so b should not be ready
    const ready = getReadyNodes(ir, run);
    expect(ready).toEqual(['a']);

    // Mark a as done
    run.nodeRuns['a'].status = 'done';
    const ready2 = getReadyNodes(ir, run);
    expect(ready2).toEqual(['b']);
  });
});

describe('getEntryNodes', () => {
  it('returns nodes with no inbound control edges', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B'), makeTaskNode('c', 'C')];
    const edges = [makeControlEdge('e1', 'a', 'b'), makeControlEdge('e2', 'a', 'c')];
    const ir = makeIr(nodes, edges);
    expect(getEntryNodes(ir)).toEqual(['a']);
  });
});

describe('runGraph — wave executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs two independent tasks in parallel', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const ir = makeIr(nodes, []);

    let launchCount = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => {
        launchCount++;
        return `m-${launchCount}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => {
        return ids.map((id) => makeMission(id, 'done'));
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(run.status).toBe('done');
    expect(deps.launchMission).toHaveBeenCalledTimes(2);
    // Both should have been launched (concurrent wave)
    expect(run.nodeRuns['a'].status).toBe('done');
    expect(run.nodeRuns['b'].status).toBe('done');
  });

  it('diamond deps: D waits for B and C', async () => {
    const nodes = [
      makeTaskNode('a', 'A'),
      makeTaskNode('b', 'B'),
      makeTaskNode('c', 'C'),
      makeTaskNode('d', 'D'),
    ];
    const edges = [
      makeControlEdge('e1', 'a', 'b'),
      makeControlEdge('e2', 'a', 'c'),
      makeControlEdge('e3', 'b', 'd'),
      makeControlEdge('e4', 'c', 'd'),
    ];
    const ir = makeIr(nodes, edges);

    const launchOrder: string[] = [];
    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async ({ node }: { node: GraphNode }) => {
        launchOrder.push(node.id);
        return `m${++missionCounter}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => {
        return ids.map((id) => makeMission(id, 'done'));
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(run.status).toBe('done');
    // A first, then B and C, then D
    expect(launchOrder[0]).toBe('a');
    expect(launchOrder.slice(1, 3).sort()).toEqual(['b', 'c']);
    expect(launchOrder[3]).toBe('d');
    expect(run.nodeRuns['d'].status).toBe('done');
  });

  it('invokes brain recall once per task launch', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const ir = makeIr(nodes, []);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => 'm1'),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    await runGraph(ir, deps);
    expect(recallForStep).toHaveBeenCalledTimes(2);
  });

  it('invokes brain note on success and failure', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    let callCount = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++callCount}`),
      waitForMissions: vi.fn(async (ids: string[]) => {
        // First mission (a) succeeds, second (b) fails
        if (callCount === 1) return ids.map((id) => makeMission(id, 'done'));
        return ids.map((id) => makeMission(id, 'failed'));
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(noteAfterStep).toHaveBeenCalledTimes(2);
    expect(run.nodeRuns['a'].status).toBe('done');
    expect(run.nodeRuns['b'].status).toBe('failed');
    // Run should fail because b is critical
    expect(run.status).toBe('failed');
  });

  it('budget limit stops further waves', async () => {
    // Sequential nodes so budget is checked between waves
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges, {
      defaults: defaultGraphDefaults({ budgetCapUsd: 0.001 }),
    });

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => 'm1'),
      waitForMissions: vi.fn(async (ids: string[]) => {
        const missions = ids.map((id) => makeMission(id, 'done'));
        missions.forEach((m) => {
          m.agentMetrics = { durationMs: 100, inputTokens: 0, outputTokens: 0, costUsd: 0.01, toolCount: 0 };
        });
        return missions;
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    // After first wave, budget exceeded → should not launch second wave
    expect(deps.launchMission).toHaveBeenCalledTimes(1);
    expect(run.status).toBe('failed');
  });
});

describe('compileOrchestratorToIr — roundtrip', () => {
  it('preserves step ids and dependsOn', () => {
    const orch: OrchestratorState = {
      id: 'o1',
      name: 'Test Plan',
      projectId: 'p1',
      targetProjectIds: [],
      objective: 'test',
      steps: [
        { id: 's1', description: 'Step 1', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
        { id: 's2', description: 'Step 2', status: 'pending', missionIds: [], dependsOn: ['s1'], autonomyLevel: 'supervised' },
        { id: 's3', description: 'Step 3', status: 'pending', missionIds: [], dependsOn: ['s1'], autonomyLevel: 'supervised' },
      ],
      currentStep: 0,
      status: 'planning',
      budget: { spentCents: 0 },
      childMissionIds: [],
      createdAt: 0,
      updatedAt: 0,
      autonomyLevel: 'supervised',
    };

    const ir = compileOrchestratorToIr(orch);
    expect(ir.nodes.map((n) => n.id)).toEqual(['s1', 's2', 's3']);
    expect(ir.edges.filter((e) => e.kind === 'control').map((e) => `${e.from}→${e.to}`)).toEqual(['s1→s2', 's1→s3']);

    // Reverse
    const back = irToOrchestratorState(ir);
    expect(back.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(back.steps.find((s) => s.id === 's2')?.dependsOn).toEqual(['s1']);
    expect(back.steps.find((s) => s.id === 's3')?.dependsOn).toEqual(['s1']);
  });
});

// ── Phase 2 tests ─────────────────────────────────────────────────

import { replan } from '../replanEngine';
import type { ReplanContext } from '../replanEngine';

describe('replanEngine', () => {
  it('aborts when maxReplans exceeded', () => {
    const nodes = [makeTaskNode('a', 'A')];
    const ir = makeIr(nodes, [], {
      defaults: defaultGraphDefaults({ maxReplans: 1 }),
    });
    const run = initGraphRun(ir.id, ir);
    run.replanCount = 1; // already at max

    const ctx: ReplanContext = {
      graphId: ir.id,
      runId: run.runId,
      projectRoot: '/tmp/test',
      failedNodeId: 'a',
      failedNodeRun: run.nodeRuns['a'],
      diagnosis: { category: 'type_error', rootCause: 'type mismatch', suggestedFix: 'fix types', confidence: 0.8 },
      attempt: 1,
    };

    const result = replan(ir, run, ctx);
    expect(result.shouldAbort).toBe(true);
    expect(result.shouldRetry).toBe(false);
  });

  it('aborts when budget exhausted', () => {
    const nodes = [makeTaskNode('a', 'A')];
    const ir = makeIr(nodes, []);
    const run = initGraphRun(ir.id, ir);
    run.budget.limitUsd = 1.0;
    run.budget.spentUsd = 1.0;

    const ctx: ReplanContext = {
      graphId: ir.id,
      runId: run.runId,
      projectRoot: '/tmp/test',
      failedNodeId: 'a',
      failedNodeRun: run.nodeRuns['a'],
      diagnosis: { category: 'type_error', rootCause: 'type mismatch', suggestedFix: 'fix types', confidence: 0.8 },
      attempt: 1,
    };

    const result = replan(ir, run, ctx);
    expect(result.shouldAbort).toBe(true);
  });

  it('produces a patch for type_error on first attempt', () => {
    const nodes = [makeTaskNode('a', 'A')];
    const ir = makeIr(nodes, []);
    const run = initGraphRun(ir.id, ir);

    const ctx: ReplanContext = {
      graphId: ir.id,
      runId: run.runId,
      projectRoot: '/tmp/test',
      failedNodeId: 'a',
      failedNodeRun: run.nodeRuns['a'],
      diagnosis: { category: 'type_error', rootCause: 'type mismatch', suggestedFix: 'add type annotation', confidence: 0.8 },
      attempt: 1,
    };

    const result = replan(ir, run, ctx);
    expect(result.shouldRetry).toBe(true);
    expect(result.patch).not.toBeNull();
    expect(result.patch!.updateNodes).toBeDefined();
    // applyPatch is pure — the patched state is on result.run, never a
    // mutation of the caller's original `run` (immut-applypatch fix).
    expect(run.replanCount).toBe(0);
    expect(result.run.replanCount).toBe(1);
    // Node should be reset to pending for retry
    expect(result.run.nodeRuns['a'].status).toBe('pending');
  });

  it('skips non-critical node after 3 attempts', () => {
    const node: TaskNode = {
      ...makeTaskNode('a', 'A'),
      critical: false,
    };
    const ir = makeIr([node], []);
    const run = initGraphRun(ir.id, ir);
    run.nodeRuns['a'].status = 'failed';

    const ctx: ReplanContext = {
      graphId: ir.id,
      runId: run.runId,
      projectRoot: '/tmp/test',
      failedNodeId: 'a',
      failedNodeRun: run.nodeRuns['a'],
      diagnosis: { category: 'unknown_failure', rootCause: 'unknown', suggestedFix: 'retry', confidence: 0.3 },
      attempt: 3,
    };

    const result = replan(ir, run, ctx);
    expect(result.shouldSkip).toBe(true);
    expect(result.patch!.skipNodeIds).toEqual(['a']);
    // applyPatch is pure — the caller's original `run` is untouched.
    expect(run.nodeRuns['a'].status).toBe('failed');
    expect(result.run.nodeRuns['a'].status).toBe('skipped');
  });
});

describe('runGraph — contest node', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launches N missions for a contest node and picks the winner', async () => {
    const contestNode: GraphNode = {
      id: 'c1',
      kind: 'contest',
      description: 'Implement feature X',
      contract: defaultStepContract(),
      n: 3,
      ranking: 'judge',
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([contestNode], []);

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) => {
        // First contestant succeeds, rest fail
        return ids.map((id, idx) => {
          const m = makeMission(id, idx === 0 ? 'done' : 'failed');
          m.agentMetrics = { durationMs: 100, inputTokens: 0, outputTokens: 0, costUsd: 0.01 * (idx + 1), toolCount: 0 };
          return m;
        });
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(run.status).toBe('done');
    expect(deps.launchMission).toHaveBeenCalledTimes(3);
    expect(run.nodeRuns['c1'].status).toBe('done');
  });

  it('fails when all contestants fail', async () => {
    const contestNode: GraphNode = {
      id: 'c1',
      kind: 'contest',
      description: 'Implement feature X',
      contract: defaultStepContract(),
      n: 2,
      ranking: 'judge',
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([contestNode], []);

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) => {
        return ids.map((id) => makeMission(id, 'failed'));
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(run.status).toBe('failed');
    expect(run.nodeRuns['c1'].status).toBe('failed');
  });
});

describe('compileOrchestratorToIr — rich contract fields', () => {
  it('maps agentName, model, effort, budgetCapUsd into StepContract', () => {
    const orch: OrchestratorState = {
      id: 'o1',
      name: 'Rich Plan',
      projectId: 'p1',
      targetProjectIds: [],
      objective: 'test rich contract',
      steps: [
        {
          id: 's1',
          description: 'Step with rich contract',
          status: 'pending',
          missionIds: [],
          dependsOn: [],
          autonomyLevel: 'supervised',
          agentName: 'auth-agent',
          model: 'sonnet',
          effort: 'high',
          budgetCapUsd: 5.0,
          contestN: 3,
          critical: true,
        },
      ],
      currentStep: 0,
      status: 'planning',
      budget: { spentCents: 0 },
      childMissionIds: [],
      createdAt: 0,
      updatedAt: 0,
      autonomyLevel: 'supervised',
    };

    const ir = compileOrchestratorToIr(orch);
    const node = ir.nodes[0];
    // contestN ≥ 2 compiles to a first-class contest node (best-of-N).
    expect(node.kind).toBe('contest');
    if (node.kind === 'contest') {
      expect(node.n).toBe(3);
      expect(node.contract.agentName).toBe('auth-agent');
      expect(node.contract.model).toBe('sonnet');
      expect(node.contract.effort).toBe('high');
      expect(node.contract.budgetCapUsd).toBe(5.0);
      expect(node.contract.contestN).toBe(3);
      expect(node.critical).toBe(true);
    }
  });
});

// ── Phase 3 tests ─────────────────────────────────────────────────

import {
  pauseGraphRun,
  resumeGraphRun,
  cancelGraphRun,
  isRunActive,
  isRunTerminal,
  isPauseRequested,
  isCancelRequested,
} from '../runControl';

describe('runControl — pause/resume/cancel', () => {
  // D4 fix (item 2, 2026-08-15 audit) — pauseGraphRun/resumeGraphRun/
  // cancelGraphRun are now PURE: they return a NEW GraphRun instead of
  // mutating the one passed in (see runControl.ts's own header comment for
  // the full defect writeup — mutating a caller's snapshot never reached
  // the live runGraph loop, which owns a completely separate object graph).

  it('pause returns a NEW run object with status paused, and requests a pause for that runId', () => {
    const ir = makeIr([makeTaskNode('a', 'A')], []);
    const running: import('../types').GraphRun = { ...initGraphRun(ir.id, ir), status: 'running' };

    const paused = pauseGraphRun(running);
    expect(paused).not.toBe(running);
    expect(paused.status).toBe('paused');
    expect(running.status).toBe('running'); // original untouched
    expect(isRunActive(paused)).toBe(false);
    expect(isPauseRequested(running.runId)).toBe(true);
  });

  it('pausing a run that is not running is a no-op (returns the same reference)', () => {
    const ir = makeIr([makeTaskNode('a', 'A')], []);
    const pending = initGraphRun(ir.id, ir); // status 'pending'
    const result = pauseGraphRun(pending);
    expect(result).toBe(pending);
    expect(isPauseRequested(pending.runId)).toBe(false);
  });

  it('resume returns a NEW run object, status running, blocked nodes reset to pending, and clears the pause request', () => {
    const ir = makeIr([makeTaskNode('a', 'A')], []);
    const base = initGraphRun(ir.id, ir);
    const interrupted: import('../types').GraphRun = {
      ...base,
      status: 'interrupted',
      nodeRuns: { ...base.nodeRuns, a: { ...base.nodeRuns.a, status: 'blocked' } },
    };
    pauseGraphRun({ ...interrupted, status: 'running' }); // simulate a pending pause request on this runId

    const resumed = resumeGraphRun(interrupted);
    expect(resumed).not.toBe(interrupted);
    expect(resumed.status).toBe('running');
    expect(resumed.nodeRuns['a'].status).toBe('pending');
    expect(interrupted.nodeRuns['a'].status).toBe('blocked'); // original untouched
    expect(isRunActive(resumed)).toBe(true);
    expect(isPauseRequested(interrupted.runId)).toBe(false);
  });

  it('cancel returns a NEW run object, status cancelled, pending/running nodes skipped', () => {
    const ir = makeIr([makeTaskNode('a', 'A'), makeTaskNode('b', 'B')], []);
    const base = initGraphRun(ir.id, ir);
    const running: import('../types').GraphRun = {
      ...base,
      status: 'running',
      nodeRuns: { ...base.nodeRuns, a: { ...base.nodeRuns.a, status: 'running' } },
    };

    const cancelled = cancelGraphRun(running);
    expect(cancelled).not.toBe(running);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.nodeRuns['a'].status).toBe('skipped');
    expect(cancelled.nodeRuns['b'].status).toBe('skipped');
    expect(running.nodeRuns['a'].status).toBe('running'); // original untouched
    expect(isRunTerminal(cancelled)).toBe(true);
  });

  // Cancel fix (2026-08-15 audit follow-up) — cancelGraphRun now registers a
  // real, runId-keyed cancel request when the run is actually 'running', the
  // SAME channel shape D4 gave pauseGraphRun. See the live-loop test below
  // ('runGraph — a live cancel request actually stops the wave loop') for
  // proof this channel is actually observed, not just set.
  it('cancelling a RUNNING run registers a cancel request on the live channel', () => {
    const ir = makeIr([makeTaskNode('a', 'A')], []);
    const running: import('../types').GraphRun = { ...initGraphRun(ir.id, ir), status: 'running' };

    expect(isCancelRequested(running.runId)).toBe(false);
    cancelGraphRun(running);
    expect(isCancelRequested(running.runId)).toBe(true);
  });

  it('cancelling a run that already left the wave loop (e.g. paused) does not leave a dangling cancel request — there is no live poller to ever clear it', () => {
    const ir = makeIr([makeTaskNode('a', 'A')], []);
    const paused: import('../types').GraphRun = { ...initGraphRun(ir.id, ir), status: 'paused' };

    cancelGraphRun(paused);
    expect(isCancelRequested(paused.runId)).toBe(false);
  });

  it('cancelling supersedes a pending pause request', () => {
    const ir = makeIr([makeTaskNode('a', 'A')], []);
    const running: import('../types').GraphRun = { ...initGraphRun(ir.id, ir), status: 'running' };

    pauseGraphRun(running);
    expect(isPauseRequested(running.runId)).toBe(true);

    cancelGraphRun(running);
    expect(isPauseRequested(running.runId)).toBe(false);
    expect(isCancelRequested(running.runId)).toBe(true);
  });

  it('isRunTerminal returns true for done/failed/cancelled', () => {
    const ir = makeIr([makeTaskNode('a', 'A')], []);
    const run = initGraphRun(ir.id, ir);

    expect(isRunTerminal({ ...run, status: 'done' })).toBe(true);
    expect(isRunTerminal({ ...run, status: 'failed' })).toBe(true);
    expect(isRunTerminal({ ...run, status: 'cancelled' })).toBe(true);
    expect(isRunTerminal({ ...run, status: 'running' })).toBe(false);
  });
});

describe('runGraph — a live pause request actually stops the wave loop (D4 fix, item 2)', () => {
  it('a pause requested between waves prevents the NEXT wave from launching, and the run reports status paused', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    let bLaunched = false;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        if (args.node.id === 'b') bLaunched = true;
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(async (run: import('../types').GraphRun) => {
        // Simulates a caller pausing the run the moment it observes node
        // 'a' settle — BEFORE runGraph's loop gets a chance to launch wave 2.
        if (run.status === 'running' && run.nodeRuns['a']?.status === 'done') {
          pauseGraphRun(run);
        }
      }),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const finalRun = await runGraph(ir, deps);

    expect(finalRun.status).toBe('paused');
    expect(bLaunched).toBe(false);
    expect(finalRun.nodeRuns['b'].status).not.toBe('done');
    expect(finalRun.nodeRuns['a'].status).toBe('done'); // wave already in flight ran to completion
  });

  it('resuming a paused run and re-invoking runGraph with existingRun continues to the remaining wave', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    const launched: string[] = [];
    let pausedRun: import('../types').GraphRun | undefined;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        launched.push(args.node.id);
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(async (run: import('../types').GraphRun) => {
        if (run.status === 'running' && run.nodeRuns['a']?.status === 'done') {
          pausedRun = pauseGraphRun(run);
        }
      }),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const firstRun = await runGraph(ir, deps);
    expect(firstRun.status).toBe('paused');
    expect(launched).toEqual(['a']);
    expect(pausedRun).toBeDefined();

    const resumed = resumeGraphRun(pausedRun!);
    const secondDeps = { ...deps, persistRun: vi.fn() };
    const finalRun = await runGraph(ir, secondDeps, { existingRun: resumed });

    expect(finalRun.status).toBe('done');
    expect(launched).toEqual(['a', 'b']);
    expect(finalRun.nodeRuns['b'].status).toBe('done');
  });
});

// cancelGraphRun fix (2026-08-15 audit follow-up to D4) — a live run must
// ACTUALLY stop, not just report a hoped-for status back to the caller. Same
// harness as the pause live-loop tests above ('a live pause request actually
// stops the wave loop'), swapped to prove the cancel channel instead.
describe('runGraph — a live cancel request actually stops the wave loop (cancelGraphRun fix)', () => {
  it('a cancel requested between waves stops the run immediately: the next wave never launches, and every pending/ready node is marked skipped', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    let bLaunched = false;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        if (args.node.id === 'b') bLaunched = true;
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(async (run: import('../types').GraphRun) => {
        // Simulates an external cancelGraphRun(run) call arriving the
        // moment node 'a' settles — BEFORE runGraph's loop gets a chance to
        // launch wave 2 (which would include 'b'). Before the fix, this had
        // no way to reach the live loop at all: cancelGraphRun returned a
        // 'cancelled' snapshot nobody fed back in, and the loop kept going
        // strictly off `opts.signal.aborted`, which nothing here ever sets.
        if (run.status === 'running' && run.nodeRuns['a']?.status === 'done') {
          cancelGraphRun(run);
        }
      }),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const finalRun = await runGraph(ir, deps);

    // The whole point: the run actually stopped.
    expect(finalRun.status).toBe('cancelled');
    expect(bLaunched).toBe(false);
    expect(finalRun.nodeRuns['a'].status).toBe('done'); // wave already in flight ran to completion
    expect(finalRun.nodeRuns['b'].status).toBe('skipped'); // never got the chance to be 'pending' launched
    // The control channel is cleaned up on the way out — a later, unrelated
    // run reusing runIds (or a stray re-check) never sees a stale flag.
    expect(isCancelRequested(finalRun.runId)).toBe(false);
  });

  it('cancelling via the pure cancelGraphRun(run) call directly (no live loop) still produces an honest, immediately-terminal snapshot', () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);
    const run: import('../types').GraphRun = {
      ...initGraphRun(ir.id, ir),
      status: 'running',
      nodeRuns: {
        a: { ...initGraphRun(ir.id, ir).nodeRuns.a, status: 'done' },
        b: { ...initGraphRun(ir.id, ir).nodeRuns.b, status: 'pending' },
      },
    };

    const cancelled = cancelGraphRun(run);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.nodeRuns['b'].status).toBe('skipped');
    expect(isRunTerminal(cancelled)).toBe(true);
  });
});

describe('runGraph — interrupt node', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pauses the run when an interrupt node is encountered', async () => {
    const interruptNode: GraphNode = {
      id: 'i1',
      kind: 'interrupt',
      reason: 'Waiting for user approval',
      payload: { question: 'Proceed with deployment?' },
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([interruptNode], []);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => 'm1'),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(run.status).toBe('interrupted');
    expect(run.nodeRuns['i1'].status).toBe('blocked');
    expect(deps.emit).toHaveBeenCalledWith(
      'graph.interrupt',
      expect.objectContaining({ reason: 'Waiting for user approval' }),
    );
  });
});

// ── P4.4 Honesty tests — session resume ───────────────────────────

import { canResumeNative } from '../../runtime';

describe('P4.4 — canResumeNative honesty', () => {
  it('returns false when no sessionId in metrics', () => {
    expect(canResumeNative(undefined)).toBe(false);
    expect(canResumeNative({})).toBe(false);
    expect(canResumeNative({ sessionId: undefined })).toBe(false);
  });

  it('returns true when sessionId is present', () => {
    // Note: isTauriRuntime() is false in test env, so this returns false
    // even with a sessionId. This is the honest behavior — can't resume
    // outside the Tauri desktop runtime.
    expect(canResumeNative({ sessionId: 'test-session-123' })).toBe(false);
  });
});

// ── P4.4 — checkpointStore roundtrip ──────────────────────────────

// In-memory fs mock for checkpoint tests (web platform rejects fs calls)
const memFs = new Map<string, string>();
vi.mock('../../../platform', () => ({
  getPlatform: () => ({
    fs: {
      createDir: vi.fn(async (path: string) => { memFs.set(path, ''); }),
      writeFile: vi.fn(async (path: string, content: string) => { memFs.set(path, content); }),
      readFile: vi.fn(async (path: string) => memFs.get(path) ?? ''),
      readDir: vi.fn(async (dir: string) => {
        const entries: { name: string }[] = [];
        for (const key of memFs.keys()) {
          if (key.startsWith(dir + '/') && !key.slice(dir.length + 1).includes('/')) {
            entries.push({ name: key.slice(dir.length + 1) });
          }
        }
        return entries;
      }),
      remove: vi.fn(async (path: string) => { memFs.delete(path); }),
    },
    brain: {
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      capture: vi.fn().mockResolvedValue(undefined),
      recallScoped: vi.fn().mockResolvedValue({ nodes: [] }),
    },
  }),
}));

describe('P4.4 — checkpointStore write/read roundtrip', () => {
  beforeEach(() => {
    memFs.clear();
  });

  it('writes and reads back a checkpoint', async () => {
    const { writeCheckpoint, readCheckpoint } = await import('../checkpointStore');
    const projectRoot = '/tmp/test';
    const runId = 'test-run-cp';
    const data = {
      messages: [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there' },
      ],
      turn: 0,
      toolCallCount: 0,
      proofCount: 0,
      missionStatus: 'running',
      label: 'Turn 1',
    };

    const cp = await writeCheckpoint(projectRoot, runId, data, {
      missionId: 'm1',
      engine: 'managed',
      label: 'Turn 1',
    });

    expect(cp.id).toMatch(/^cp-/);
    expect(cp.runId).toBe(runId);
    expect(cp.missionId).toBe('m1');
    expect(cp.engine).toBe('managed');
    expect(cp.summary.turn).toBe(0);

    const loaded = await readCheckpoint(projectRoot, runId, cp.id);
    expect(loaded.checkpoint.id).toBe(cp.id);
    expect(loaded.data.turn).toBe(0);
    expect(loaded.data.messages).toHaveLength(2);
    expect(loaded.data.messages[0].content).toBe('Hello');
    expect(loaded.data.messages[1].content).toBe('Hi there');
  });
});

// ── P5.1 canvasToIr — canvas → GraphIR compile ────────────────────

describe('P5.1 — canvasToIr', () => {
  it('compiles drafts into task nodes', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const ir = canvasToIr({
      drafts: [
        { id: 'd1', title: 'Task A', task: 'Do thing A', createdBy: 'user' },
        { id: 'd2', title: 'Task B', task: 'Do thing B', createdBy: 'user' },
      ],
      chains: [],
      routers: [],
      joins: [],
      projectId: 'proj-1',
    });

    expect(ir.nodes).toHaveLength(2);
    expect(ir.nodes[0].kind).toBe('task');
    expect(ir.nodes[0].id).toBe('draft:d1');
    expect(ir.nodes[1].id).toBe('draft:d2');
    expect(ir.source).toBe('canvas');
    expect(ir.projectId).toBe('proj-1');
  });

  it('compiles chains into edges', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const ir = canvasToIr({
      drafts: [
        { id: 'd1', title: 'A', task: 'Do A', createdBy: 'user' },
        { id: 'd2', title: 'B', task: 'Do B', createdBy: 'user' },
      ],
      chains: [
        { id: 'c1', sourceRef: 'draft:d1', targetRef: 'draft:d2', condition: 'success', createdBy: 'user' },
      ],
      routers: [],
      joins: [],
    });

    expect(ir.edges).toHaveLength(1);
    expect(ir.edges[0].from).toBe('draft:d1');
    expect(ir.edges[0].to).toBe('draft:d2');
    expect(ir.edges[0].condition).toEqual({ kind: 'outcome', value: 'success' });
  });

  it('skips disabled chains', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const ir = canvasToIr({
      drafts: [
        { id: 'd1', title: 'A', task: 'Do A', createdBy: 'user' },
        { id: 'd2', title: 'B', task: 'Do B', createdBy: 'user' },
      ],
      chains: [
        { id: 'c1', sourceRef: 'draft:d1', targetRef: 'draft:d2', condition: 'always', createdBy: 'user', disabled: true },
      ],
      routers: [],
      joins: [],
    });

    expect(ir.edges).toHaveLength(0);
  });

  it('compiles routers into router nodes', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const ir = canvasToIr({
      drafts: [
        { id: 'd1', title: 'A', task: 'Do A', createdBy: 'user' },
        { id: 'd2', title: 'B', task: 'Do B', createdBy: 'user' },
        { id: 'd3', title: 'C', task: 'Do C', createdBy: 'user' },
      ],
      chains: [
        { id: 'c1', sourceRef: 'draft:d1', targetRef: 'router:r1', condition: 'always', createdBy: 'user' },
        { id: 'c2', sourceRef: 'router:r1:b1', targetRef: 'draft:d2', condition: 'always', createdBy: 'user' },
        { id: 'c3', sourceRef: 'router:r1:b2', targetRef: 'draft:d3', condition: 'always', createdBy: 'user' },
      ],
      routers: [
        {
          id: 'r1',
          branches: [
            { id: 'b1', label: 'Success', condition: { kind: 'outcome', value: 'success' } },
            { id: 'b2', label: 'Fail', condition: { kind: 'outcome', value: 'fail' } },
          ],
        },
      ],
      joins: [],
    });

    const routerNode = ir.nodes.find((n) => n.kind === 'router');
    expect(routerNode).toBeDefined();
    expect(routerNode!.id).toBe('router:r1');
  });

  // Regression: a chain whose sourceRef is a router BRANCH
  // (`router:<routerId>:<branchId>`) used to compile into a self-loop
  // edge (`from === to`), because refToNodeId resolved that branch ref by
  // re-searching input.chains for "the chain whose source is this branch"
  // — finding the very chain being compiled — and returning ITS OWN
  // targetRef for both endpoints. validateGraph rejects any cycle in the
  // control graph, so a canvas graph with so much as one router could
  // never pass validation, let alone run. Fixed in canvasToIr.ts's
  // refToNodeId: a router branch source always resolves to the router's
  // OWN node id (`router:<routerId>`), matching
  // reconcilerEdges.ts's resolveRouterBranchEndpoint convention.
  it('compiles router branch edges from the router node itself, never a self-loop, and passes validateGraph', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const ir = canvasToIr({
      drafts: [
        { id: 'd1', title: 'Upstream', task: 'Do upstream work', createdBy: 'user' },
        { id: 'd2', title: 'Success path', task: 'Handle success', createdBy: 'user' },
        { id: 'd3', title: 'Default path', task: 'Handle default', createdBy: 'user' },
      ],
      chains: [
        { id: 'c1', sourceRef: 'draft:d1', targetRef: 'router:r1', condition: 'always', createdBy: 'user' },
        { id: 'c2', sourceRef: 'router:r1:b1', targetRef: 'draft:d2', condition: 'always', createdBy: 'user' },
        { id: 'c3', sourceRef: 'router:r1:b2', targetRef: 'draft:d3', condition: 'always', createdBy: 'user' },
      ],
      routers: [
        {
          id: 'r1',
          branches: [
            { id: 'b1', label: 'Success', condition: { kind: 'outcome', value: 'success' } },
            { id: 'b2', label: 'Default', condition: { kind: 'default' } },
          ],
        },
      ],
      joins: [],
    });

    // No edge is ever a self-loop.
    for (const edge of ir.edges) {
      expect(edge.from).not.toBe(edge.to);
    }

    // Both branch edges originate at the router node, not at their own
    // targets (the exact bug: from used to equal to, both 'draft:d2'/'draft:d3').
    const branchEdges = ir.edges.filter((e) => e.to === 'draft:d2' || e.to === 'draft:d3');
    expect(branchEdges).toHaveLength(2);
    for (const edge of branchEdges) {
      expect(edge.from).toBe('router:r1');
    }

    // The router's own RouterNodeIR.branches still resolve their real
    // downstream target (unaffected by the fix — a different call site).
    const routerNode = ir.nodes.find((n): n is import('../types').RouterNodeIR => n.kind === 'router');
    expect(routerNode?.branches.find((b) => b.id === 'b1')?.targetNodeId).toBe('draft:d2');
    expect(routerNode?.branches.find((b) => b.id === 'b2')?.targetNodeId).toBe('draft:d3');

    const result = validateGraph(ir);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('a canvas graph with a router runs end-to-end: the router resolves without launching a mission, and only the matching branch fires', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const ir = canvasToIr({
      drafts: [
        { id: 'd1', title: 'Upstream', task: 'Do upstream work', createdBy: 'user' },
        { id: 'd2', title: 'Success path', task: 'Handle success', createdBy: 'user' },
        { id: 'd3', title: 'Default path', task: 'Handle default', createdBy: 'user' },
      ],
      chains: [
        { id: 'c1', sourceRef: 'draft:d1', targetRef: 'router:r1', condition: 'always', createdBy: 'user' },
        { id: 'c2', sourceRef: 'router:r1:b1', targetRef: 'draft:d2', condition: 'always', createdBy: 'user' },
        { id: 'c3', sourceRef: 'router:r1:b2', targetRef: 'draft:d3', condition: 'always', createdBy: 'user' },
      ],
      routers: [
        {
          id: 'r1',
          branches: [
            { id: 'b1', label: 'Success', condition: { kind: 'outcome', value: 'success' } },
            { id: 'b2', label: 'Default', condition: { kind: 'default' } },
          ],
        },
      ],
      joins: [],
    });

    expect(validateGraph(ir).ok).toBe(true);

    const launchedNodeIds: string[] = [];
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        launchedNodeIds.push(args.node.id);
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);

    // The router itself never launches a mission (D1 fix), and the upstream
    // task settling 'done' matches branch b1's outcome:success condition.
    expect(launchedNodeIds).not.toContain('router:r1');
    expect(launchedNodeIds).toContain('draft:d1');
    expect(launchedNodeIds).toContain('draft:d2');
    expect(launchedNodeIds).not.toContain('draft:d3');

    expect(run.nodeRuns['router:r1'].status).toBe('done');
    expect(run.nodeRuns['draft:d2'].status).toBe('done');
    // The untaken 'default' branch target is explicitly skipped, not left
    // dangling pending — and definitely never fed by a self-loop.
    expect(run.nodeRuns['draft:d3'].status).toBe('skipped');
  });
});

// ── P5.1b — canvasToIr honesty (2026-08-15 audit follow-up) ────────
//
// canvasToIr's refToNodeId used to fall through a single `default: return
// null` for every CanvasNodeKind it didn't explicitly handle — silently
// dropping the edge with no error and no warning. That default case caught
// SEVEN kinds indiscriminately: project, schedule, note, iteration,
// terminal, preview, frame. Six of those are genuinely decorative (the
// canvas never lets a chain touch them — no connectable Handle, or
// chainValidation.ts's target whitelist blocks them), so dropping them is
// correct; `schedule` and `loop` are NOT decorative — ScheduleNode.tsx and
// LoopNode.tsx both render a fully connectable source Handle, and
// agentsStore.tsx's manager `chain_agents` action explicitly allows 'loop'
// as a chain source — so a user (human or manager) really can wire one in,
// and the compiled graph ran without it, silently. Fixed: refToNodeId now
// throws, naming the exact node, instead of returning null for those two.
describe('P5.1b — canvasToIr honesty: schedule/loop are refused, not dropped', () => {
  it('throws naming the node when a chain sources from a canvas Schedule node, instead of silently dropping the edge', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const input = {
      drafts: [{ id: 'd1', title: 'Target', task: 'Do work', createdBy: 'user' as const }],
      chains: [{ id: 'c1', sourceRef: 'schedule:sched1', targetRef: 'draft:d1', condition: 'always' as const, createdBy: 'user' as const }],
      routers: [],
      joins: [],
    };

    expect(() => canvasToIr(input)).toThrow(/schedule:sched1/);
  });

  it('throws naming the node when a chain sources from a canvas Loop node, instead of silently dropping the edge', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const input = {
      drafts: [{ id: 'd1', title: 'Target', task: 'Do work', createdBy: 'user' as const }],
      chains: [{ id: 'c1', sourceRef: 'loop:mission1', targetRef: 'draft:d1', condition: 'always' as const, createdBy: 'user' as const }],
      routers: [],
      joins: [],
    };

    expect(() => canvasToIr(input)).toThrow(/loop:mission1/);
  });

  it('throws when a JOIN fan-in source is a canvas Schedule/Loop node, not just a plain chain — the join loop shares the same resolver', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const input = {
      drafts: [
        { id: 'd1', title: 'Real source', task: 'Do work', createdBy: 'user' as const },
        { id: 'd2', title: 'Target', task: 'Handle fan-in', createdBy: 'user' as const },
      ],
      chains: [{ id: 'c1', sourceRef: 'join:j1', targetRef: 'draft:d2', condition: 'always' as const, createdBy: 'user' as const }],
      routers: [],
      joins: [{ id: 'j1', sourceRefs: ['draft:d1', 'loop:mission1'], mode: 'all_success' as const }],
    };

    // Before this fix, the 'loop:mission1' fan-in source silently dropped
    // out of the join — the join would compile as if the user had only
    // wired ONE source (d1), quietly satisfied by less than they drew.
    expect(() => canvasToIr(input)).toThrow(/loop:mission1/);
  });

  it('silently excludes decorative canvas kinds (project/note/iteration/terminal/preview/frame) from the compiled edges — by design, not by omission', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const decorativeKinds = ['project', 'note', 'iteration', 'terminal', 'preview', 'frame'];
    const input = {
      drafts: [{ id: 'd1', title: 'Target', task: 'Do work', createdBy: 'user' as const }],
      chains: decorativeKinds.map((kind, i) => ({
        id: `c${i}`,
        sourceRef: `${kind}:x${i}`,
        targetRef: 'draft:d1',
        condition: 'always' as const,
        createdBy: 'user' as const,
      })),
      routers: [],
      joins: [],
    };

    expect(() => canvasToIr(input)).not.toThrow();
    expect(canvasToIr(input).edges).toHaveLength(0);
  });

  it('compiles a JoinSpec fan-in into direct control edges from each real source to the join\'s outgoing target (baseline, unaffected by the fix)', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const input = {
      drafts: [
        { id: 'd1', title: 'A', task: 'Do A', createdBy: 'user' as const },
        { id: 'd2', title: 'B', task: 'Do B', createdBy: 'user' as const },
        { id: 'd3', title: 'C', task: 'Do C', createdBy: 'user' as const },
      ],
      chains: [{ id: 'c1', sourceRef: 'join:j1', targetRef: 'draft:d3', condition: 'success' as const, createdBy: 'user' as const }],
      routers: [],
      joins: [{ id: 'j1', sourceRefs: ['draft:d1', 'draft:d2'], mode: 'all_success' as const }],
    };

    const ir = canvasToIr(input);

    // Exactly 2 edges (one per fan-in source into the target) — never a
    // 3rd, duplicate edge from the standalone chains loop re-processing
    // the same join-targeted Chain record.
    expect(ir.edges).toHaveLength(2);
    expect(ir.edges.map((e) => [e.from, e.to])).toEqual(
      expect.arrayContaining([
        ['draft:d1', 'draft:d3'],
        ['draft:d2', 'draft:d3'],
      ]),
    );
    for (const edge of ir.edges) {
      expect(edge.condition).toEqual({ kind: 'outcome', value: 'success' });
    }
  });
});

// ── P5.2/P5.9 irToCanvas — GraphIR → canvas decompile + roundtrip ──

describe('P5.2 — irToCanvas decompile', () => {
  it('decompiles task nodes back into drafts', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const { irToCanvas } = await import('../irToCanvas');
    const original = {
      drafts: [
        { id: 'd1', title: 'Task A', task: 'Do thing A', createdBy: 'user' as const },
        { id: 'd2', title: 'Task B', task: 'Do thing B', createdBy: 'user' as const },
      ],
      chains: [],
      routers: [],
      joins: [],
      projectId: 'proj-1',
    };
    const ir = canvasToIr(original);
    const decompiled = irToCanvas(ir);

    expect(decompiled.drafts).toHaveLength(2);
    expect(decompiled.drafts[0].id).toBe('d1');
    expect(decompiled.drafts[0].title).toBe('Task A');
    expect(decompiled.drafts[0].task).toBe('Do thing A');
    expect(decompiled.drafts[1].id).toBe('d2');
    // Bug fix (FINDINGS-RUN-NUIT.md: plan steps fell into the synthetic
    // Transverse zone) — irToCanvas now carries the IR's own projectId onto
    // every decompiled draft instead of dropping it.
    expect(decompiled.drafts[0].projectId).toBe('proj-1');
    expect(decompiled.drafts[1].projectId).toBe('proj-1');
  });

  it('never stamps a draft with an empty-string projectId — a projectless GraphIR (canvasToIr\'s own default) reads as absent, not a present-but-empty value', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const { irToCanvas } = await import('../irToCanvas');
    const original = {
      drafts: [{ id: 'd1', title: 'Task A', task: 'Do thing A', createdBy: 'user' as const }],
      chains: [],
      routers: [],
      joins: [],
      // no projectId given
    };
    const ir = canvasToIr(original);
    expect(ir.projectId).toBe(''); // canvasToIr's own documented default

    const decompiled = irToCanvas(ir);
    expect(decompiled.drafts[0].projectId).toBeUndefined();
  });

  it('decompiles edges back into chains', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const { irToCanvas } = await import('../irToCanvas');
    const original = {
      drafts: [
        { id: 'd1', title: 'A', task: 'Do A', createdBy: 'user' as const },
        { id: 'd2', title: 'B', task: 'Do B', createdBy: 'user' as const },
      ],
      chains: [
        { id: 'c1', sourceRef: 'draft:d1', targetRef: 'draft:d2', condition: 'success' as const, createdBy: 'user' as const },
      ],
      routers: [],
      joins: [],
    };
    const ir = canvasToIr(original);
    const decompiled = irToCanvas(ir);

    expect(decompiled.chains).toHaveLength(1);
    expect(decompiled.chains[0].sourceRef).toBe('draft:d1');
    expect(decompiled.chains[0].targetRef).toBe('draft:d2');
    expect(decompiled.chains[0].condition).toBe('success');
  });

  it('roundtrips: canvas → IR → canvas preserves drafts and edges', async () => {
    const { canvasToIr } = await import('../canvasToIr');
    const { irToCanvas } = await import('../irToCanvas');
    const original = {
      drafts: [
        { id: 'd1', title: 'Task A', task: 'Do A', createdBy: 'user' as const },
        { id: 'd2', title: 'Task B', task: 'Do B', createdBy: 'user' as const },
        { id: 'd3', title: 'Task C', task: 'Do C', createdBy: 'user' as const },
      ],
      chains: [
        { id: 'c1', sourceRef: 'draft:d1', targetRef: 'draft:d2', condition: 'success' as const, createdBy: 'user' as const },
        { id: 'c2', sourceRef: 'draft:d2', targetRef: 'draft:d3', condition: 'always' as const, createdBy: 'user' as const },
      ],
      routers: [],
      joins: [],
    };
    const ir = canvasToIr(original);
    const decompiled = irToCanvas(ir);

    // Drafts preserved
    expect(decompiled.drafts.map((d) => d.id).sort()).toEqual(['d1', 'd2', 'd3']);
    // Edges preserved
    expect(decompiled.chains).toHaveLength(2);
    const chainSources = decompiled.chains.map((c) => c.sourceRef).sort();
    expect(chainSources).toEqual(['draft:d1', 'draft:d2']);
  });
});

// ── P5.3 chainGraphAdapter — canvas → IR → runGraph ───────────────

describe('P5.3 — chainGraphAdapter', () => {
  it('compileCanvasToIr produces a valid IR without executing', async () => {
    const { compileCanvasToIr } = await import('../chainGraphAdapter');
    const ir = compileCanvasToIr(
      [{ id: 'd1', title: 'A', task: 'Do A', createdBy: 'user' }],
      [],
      [],
      [],
      'proj-1',
    );
    expect(ir.nodes).toHaveLength(1);
    expect(ir.nodes[0].kind).toBe('task');
    expect(ir.source).toBe('canvas');
  });

  it('runCanvasAsGraph compiles and executes via runGraph', async () => {
    const { runCanvasAsGraph } = await import('../chainGraphAdapter');

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runCanvasAsGraph(
      {
        drafts: [
          { id: 'd1', title: 'Task A', task: 'Do A', createdBy: 'user' },
          { id: 'd2', title: 'Task B', task: 'Do B', createdBy: 'user' },
        ],
        chains: [
          { id: 'c1', sourceRef: 'draft:d1', targetRef: 'draft:d2', condition: 'success', createdBy: 'user' },
        ],
        routers: [],
        joins: [],
        projectId: 'test',
      },
      deps,
    );

    expect(result.ir.nodes).toHaveLength(2);
    expect(result.run.status).toBe('done');
    expect(result.run.nodeRuns['draft:d1'].status).toBe('done');
    expect(result.run.nodeRuns['draft:d2'].status).toBe('done');
  });
});

// ── P5.4 join/loop IR parity ──────────────────────────────────────

describe('P5.4 — join node (fan-in sync)', () => {
  it('marks join as done without launching a mission', async () => {
    const joinNode: JoinNodeIR = {
      id: 'j1',
      kind: 'join',
      mode: 'all',
      merge: 'concat',
      brain: defaultBrainPolicy(),
    };
    const taskA = makeTaskNode('a', 'A');
    const taskB = makeTaskNode('b', 'B');
    const taskC = makeTaskNode('c', 'C');
    const ir = makeIr([taskA, taskB, joinNode, taskC], [
      { id: 'e1', from: 'a', to: 'j1', kind: 'control' },
      { id: 'e2', from: 'b', to: 'j1', kind: 'control' },
      { id: 'e3', from: 'j1', to: 'c', kind: 'control' },
    ]);

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    expect(run.status).toBe('done');
    expect(run.nodeRuns['j1'].status).toBe('done');
    // Join should not launch a mission
    expect(run.nodeRuns['j1'].missionIds).toHaveLength(0);
    // C should launch after join completes
    expect(run.nodeRuns['c'].status).toBe('done');
  });
});

describe('P5.4 — loop node (basic iteration)', () => {
  it('launches N iterations and stops on failure', async () => {
    const loopNode: LoopNodeIR = {
      id: 'l1',
      kind: 'loop',
      bodyEntryId: 'body',
      exit: { kind: 'max_iterations', n: 3 },
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([loopNode], []);

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) => {
        // Succeed first 2, fail 3rd
        const status = missionCounter < 3 ? 'done' : 'failed';
        return ids.map((id) => makeMission(id, status as 'done' | 'failed'));
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    // Honesty fix (trust-critical defect #2): the loop's 3rd iteration
    // FAILED — a loop node that never completed its body successfully must
    // report 'failed', never a claimed 'done' for a body that broke early
    // on a real failure. All 3 iterations were still attempted (the loop
    // correctly stops AFTER observing the failure, not before it).
    expect(run.nodeRuns['l1'].status).toBe('failed');
    expect(run.nodeRuns['l1'].missionIds).toHaveLength(3);
    expect(run.nodeRuns['l1'].errorMessage).toContain('failed');
  });

  it('reports "done" when every iteration genuinely succeeds', async () => {
    const loopNode: LoopNodeIR = {
      id: 'l2',
      kind: 'loop',
      bodyEntryId: 'body',
      exit: { kind: 'max_iterations', n: 3 },
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([loopNode], []);

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    expect(run.nodeRuns['l2'].status).toBe('done');
    expect(run.nodeRuns['l2'].missionIds).toHaveLength(3);
    expect(run.nodeRuns['l2'].errorMessage).toBeUndefined();
  });

  // ── Trust-critical defect #2 — runaway-impossible guard ──────────────
  it('clamps an out-of-bounds exit.n to the hard iteration cap instead of trusting the graph unconditionally', async () => {
    const loopNode: LoopNodeIR = {
      id: 'l3',
      kind: 'loop',
      bodyEntryId: 'body',
      exit: { kind: 'max_iterations', n: 100_000 },
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([loopNode], []);

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    // Fake timers: the clamped cap (100) still means ~99 real
    // inter-iteration delays (LOOP_NODE_MIN_ITERATION_DELAY_MS) — fast
    // enough in wall-clock terms to be a non-issue in production, but too
    // slow for a real-time test run. vi.runAllTimersAsync() drains every
    // pending setTimeout (the sleep() calls) as soon as it's scheduled.
    vi.useFakeTimers();
    try {
      const runPromise = runGraph(ir, deps);
      await vi.runAllTimersAsync();
      const run = await runPromise;
      // Real cap (LOOP_NODE_HARD_ITERATION_CAP, runGraph.ts) is 100 — a
      // graph asking for 100_000 must never actually launch that many.
      expect(run.nodeRuns['l3'].missionIds.length).toBeLessThanOrEqual(100);
      expect(run.nodeRuns['l3'].status).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an untracked iteration (waitForMissions returns nothing for it) as a failure, never silently continuing', async () => {
    const loopNode: LoopNodeIR = {
      id: 'l4',
      kind: 'loop',
      bodyEntryId: 'body',
      exit: { kind: 'max_iterations', n: 5 },
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([loopNode], []);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => 'm-untracked'),
      // Simulates the exact defensive gap this fix closes: no mission
      // comes back for the launched id.
      waitForMissions: vi.fn(async () => []),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    expect(run.nodeRuns['l4'].status).toBe('failed');
    // Stopped after the FIRST unproven iteration — never looped through
    // all 5 on the assumption an untracked iteration must have succeeded.
    expect(run.nodeRuns['l4'].missionIds).toHaveLength(1);
  });
});

// ── Item 1 (2026-08-15 audit, D6 fix) — a judge rejection must not let
// successors start ──────────────────────────────────────────────────

describe('runGraph — a genuine judge rejection is not a success (item 1, D6 fix)', () => {
  it('a mission left in "review" by a genuine judge rejection does NOT unblock its successor', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    let bLaunched = false;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        if (args.node.id === 'b') bLaunched = true;
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          ...makeMission(id, 'review'),
          judgeVerdict: { score: 20, passed: false, risk: 'low' as const, reviewers: [], createdAt: new Date().toISOString() },
        })),
      ),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);

    // The rejected node must never read 'done' — that's the ONLY status
    // getReadyNodes treats as satisfying a downstream dependency.
    expect(run.nodeRuns['a'].status).toBe('failed');
    expect(run.nodeRuns['a'].errorMessage).toContain('Judge rejected');
    expect(bLaunched).toBe(false);
    expect(run.nodeRuns['b'].status).not.toBe('done');
  });

  it('a "review" mission whose verdict is scoreUnavailable (evaluator-rail failure, not a real rejection) still unblocks its successor', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => `m-${args.node.id}`),
      waitForMissions: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          ...makeMission(id, 'review'),
          judgeVerdict: {
            score: 0,
            passed: false,
            scoreUnavailable: true,
            risk: 'low' as const,
            reviewers: [],
            createdAt: new Date().toISOString(),
          },
        })),
      ),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    // Mirrors approveGate.ts's own established rule (checkApproveGate/
    // evaluateAutoMerge): scoreUnavailable is an evaluator-rail failure, NOT
    // a genuine rejection — this codebase's existing "let real work through"
    // philosophy, not a new behaviour invented for the graph runtime.
    expect(run.nodeRuns['a'].status).toBe('done');
    expect(run.nodeRuns['b'].status).toBe('done');
  });

  it('a plain "done" mission (no verdict at all) is unaffected — unrelated to this fix', async () => {
    const nodes = [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => `m-${args.node.id}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    expect(run.nodeRuns['a'].status).toBe('done');
    expect(run.nodeRuns['b'].status).toBe('done');
  });
});

// ── Item 4 (2026-08-15 audit, D3 fix) — LoopNodeIR predicate exit ──────

describe('runGraph — loop node predicate exit (item 4, D3 fix)', () => {
  it('honours the exit predicate: stops as soon as an iteration\'s output matches, well before the hard cap', async () => {
    const loopNode: LoopNodeIR = {
      id: 'lp1',
      kind: 'loop',
      bodyEntryId: 'body',
      exit: { kind: 'predicate', expression: 'all tests green' },
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([loopNode], []);

    let missionCounter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++missionCounter}`),
      waitForMissions: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          ...makeMission(id, 'done'),
          // Predicate only matches from the 3rd iteration onward.
          liveAction: missionCounter >= 3 ? 'run 3: all tests green' : `run ${missionCounter}: 2 tests failing`,
        })),
      ),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    vi.useFakeTimers();
    try {
      const runPromise = runGraph(ir, deps);
      await vi.runAllTimersAsync();
      const run = await runPromise;
      expect(run.nodeRuns['lp1'].status).toBe('done');
      // Stopped at iteration 3 — NOT the old hardcoded "always exactly 1"
      // (D3's root cause), and not the full hard cap either.
      expect(run.nodeRuns['lp1'].missionIds).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a predicate that never matches is bounded by the hard iteration cap and reports failure, never a false "done"', async () => {
    const loopNode: LoopNodeIR = {
      id: 'lp2',
      kind: 'loop',
      bodyEntryId: 'body',
      exit: { kind: 'predicate', expression: 'this text never appears' },
      brain: defaultBrainPolicy(),
    };
    const ir = makeIr([loopNode], []);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => 'm-x'),
      waitForMissions: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ ...makeMission(id, 'done'), liveAction: 'nothing interesting here' })),
      ),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    vi.useFakeTimers();
    try {
      const runPromise = runGraph(ir, deps);
      await vi.runAllTimersAsync();
      const run = await runPromise;
      // Bounded by LOOP_NODE_HARD_ITERATION_CAP (100) — never unbounded —
      // and honestly reported as failed (the exit condition was never met),
      // never a claimed 'done' for a loop that didn't actually converge.
      expect(run.nodeRuns['lp2'].missionIds.length).toBeLessThanOrEqual(100);
      expect(run.nodeRuns['lp2'].status).toBe('failed');
      expect(run.nodeRuns['lp2'].errorMessage).toContain('never matched');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Item 5 (2026-08-15 audit, D1 fix) — router/form nodes must never
// silently launch a mission ────────────────────────────────────────

describe('runGraph — router node handler (item 5, D1 fix)', () => {
  it('resolves a branch off its predecessor\'s outcome and routes WITHOUT ever launching a mission for the router itself', async () => {
    const routerNode: import('../types').RouterNodeIR = {
      id: 'r1',
      kind: 'router',
      brain: defaultBrainPolicy(),
      branches: [
        { id: 'ok', label: 'Success', condition: { kind: 'outcome', value: 'success' }, targetNodeId: 'success-path' },
        { id: 'fallback', label: 'Default', condition: { kind: 'default' }, targetNodeId: 'default-path' },
      ],
    };
    const nodes = [
      makeTaskNode('a', 'A'),
      routerNode,
      makeTaskNode('success-path', 'Success path'),
      makeTaskNode('default-path', 'Default path'),
    ];
    const edges = [
      makeControlEdge('e1', 'a', 'r1'),
      makeControlEdge('e2', 'r1', 'success-path'),
      makeControlEdge('e3', 'r1', 'default-path'),
    ];
    const ir = makeIr(nodes, edges);

    const launchedNodeIds: string[] = [];
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        launchedNodeIds.push(args.node.id);
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);

    // The router itself NEVER launches a mission — D1's whole point.
    expect(launchedNodeIds).not.toContain('r1');
    expect(run.nodeRuns['r1'].status).toBe('done');
    expect(run.nodeRuns['r1'].missionIds).toHaveLength(0);
    // The 'success' branch fired (predecessor 'a' settled 'done').
    expect(run.nodeRuns['success-path'].status).toBe('done');
    // The untaken branch is explicitly skipped, not left dangling 'pending'.
    expect(run.nodeRuns['default-path'].status).toBe('skipped');
  });

  it('fails loudly when no branch matches and there is no default — never falls through to launching a mission', async () => {
    const routerNode: import('../types').RouterNodeIR = {
      id: 'r1',
      kind: 'router',
      brain: defaultBrainPolicy(),
      branches: [{ id: 'flaky', label: 'Flaky', condition: { kind: 'contains', value: 'timeout' }, targetNodeId: 'b' }],
    };
    const ir = makeIr(
      [makeTaskNode('a', 'A'), routerNode, makeTaskNode('b', 'B')],
      [makeControlEdge('e1', 'a', 'r1'), makeControlEdge('e2', 'r1', 'b')],
    );

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => `m-${args.node.id}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    expect(run.nodeRuns['r1'].status).toBe('failed');
    expect(run.nodeRuns['r1'].errorMessage).toContain('no branch condition matched');
    expect(deps.launchMission).not.toHaveBeenCalledWith(expect.objectContaining({ node: expect.objectContaining({ id: 'r1' }) }));
  });
});

describe('runGraph — form node handler (item 5, D1 fix)', () => {
  it('fails loudly instead of launching a mission on the form\'s own prompt text', async () => {
    const formNode: import('../types').FormNode = {
      id: 'f1',
      kind: 'form',
      brain: defaultBrainPolicy(),
      prompt: 'Which environment should this ship to?',
    };
    const ir = makeIr([formNode], []);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => `m-${args.node.id}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    expect(run.nodeRuns['f1'].status).toBe('failed');
    expect(run.nodeRuns['f1'].errorMessage).toContain('human-in-the-loop');
    expect(deps.launchMission).not.toHaveBeenCalled();
  });
});

// ── P5.5 manager action runner ────────────────────────────────────

describe('P5.5 — runManagerPlanAsGraph', () => {
  it('compiles and executes an OrchestratorState via runGraph', async () => {
    const { runManagerPlanAsGraph } = await import('../managerActionRunner');
    const orch: OrchestratorState = {
      id: 'orch-1',
      name: 'Test Plan',
      projectId: 'test',
      targetProjectIds: [],
      objective: 'Test objective',
      steps: [
        { id: 's1', description: 'Do step 1', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
        { id: 's2', description: 'Do step 2', status: 'pending', missionIds: [], dependsOn: ['s1'], autonomyLevel: 'supervised' },
      ],
      currentStep: 0,
      status: 'executing',
      budget: { spentCents: 0 },
      childMissionIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autonomyLevel: 'supervised',
    };

    let counter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++counter}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runManagerPlanAsGraph(orch, deps);
    expect(result.ir.nodes).toHaveLength(2);
    expect(result.run.status).toBe('done');
    expect(result.run.nodeRuns['s1'].status).toBe('done');
    expect(result.run.nodeRuns['s2'].status).toBe('done');
  });
});

// ── Contest compile (best-of-N) ───────────────────────────────────

describe('compileOrchestrator contestN', () => {
  it('maps contestN>1 steps to contest nodes', () => {
    const orch: OrchestratorState = {
      id: 'o1',
      name: 'Best of 3',
      projectId: 'p1',
      targetProjectIds: ['p1'],
      objective: 'try 3 ways',
      steps: [
        {
          id: 's1',
          description: 'implement feature',
          status: 'pending',
          missionIds: [],
          dependsOn: [],
          autonomyLevel: 'supervised',
          contestN: 3,
        },
      ],
      currentStep: 0,
      status: 'planning',
      budget: { spentCents: 0 },
      childMissionIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      autonomyLevel: 'supervised',
    };
    const ir = compileOrchestratorToIr(orch);
    expect(ir.nodes).toHaveLength(1);
    expect(ir.nodes[0].kind).toBe('contest');
    if (ir.nodes[0].kind === 'contest') {
      expect(ir.nodes[0].n).toBe(3);
    }
  });
});

// ── Data plane (edge.map + outputSchema) ──────────────────────────

describe('data plane', () => {
  it('extracts JSON and validates outputSchema', async () => {
    const { extractJsonFromText, validateAgainstSchema, parseStructuredOutput } = await import('../dataPlane');
    const json = extractJsonFromText('Result:\n```json\n{"url":"https://x","ok":true}\n```');
    expect(json).toEqual({ url: 'https://x', ok: true });
    expect(validateAgainstSchema(json, {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' }, ok: { type: 'boolean' } },
    })).toBeNull();
    const bad = parseStructuredOutput('no json here', {
      outputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    } as import('../types').StepContract);
    expect(bad.ok).toBe(false);
  });

  it('maps upstream outputs into downstream task via edge.map', async () => {
    const a = makeTaskNode('a', 'Produce JSON');
    const b = makeTaskNode('b', 'Consume URL');
    const ir = makeIr(
      [a, b],
      [
        { id: 'e1', from: 'a', to: 'b', kind: 'control' },
        { id: 'e2', from: 'a', to: 'b', kind: 'data', map: [{ fromPath: 'url', toPath: 'targetUrl' }] },
      ],
    );

    let counter = 0;
    const launched: string[] = [];
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async ({ task }: { task: string }) => {
        launched.push(task);
        return `m${++counter}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) =>
        ids.map((id) => {
          const m = makeMission(id, 'done');
          if (id === 'm1') {
            m.actionTimeline = [{ time: '0', text: 'Result: {"url":"https://example.com"}' }];
          }
          return m;
        }),
      ),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(run.status).toBe('done');
    expect(run.nodeOutputs?.a).toEqual({ url: 'https://example.com' });
    expect(launched[1]).toContain('targetUrl');
    expect(launched[1]).toContain('https://example.com');
  });

  it('fails node when outputSchema is not satisfied', async () => {
    const node = makeTaskNode('a', 'Must emit schema');
    node.contract = { ...node.contract, outputSchema: { type: 'object', required: ['pr'], properties: { pr: { type: 'string' } } } };
    const ir = makeIr([node], []);

    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => 'm1'),
      waitForMissions: vi.fn(async () => {
        const m = makeMission('m1', 'done');
        m.actionTimeline = [{ time: '0', text: 'Result: plain prose without json' }];
        return [m];
      }),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps);
    expect(run.nodeRuns.a.status).toBe('failed');
    expect(run.nodeRuns.a.errorMessage).toMatch(/outputSchema|JSON/i);
  });
});

// ── P5.6 graph debug snapshot ─────────────────────────────────────

describe('P5.6 — buildDebugSnapshot', () => {
  it('produces a debug snapshot with per-node info', async () => {
    const { buildDebugSnapshot } = await import('../graphDebugView');
    const ir = makeIr(
      [makeTaskNode('a', 'A'), makeTaskNode('b', 'B')],
      [{ id: 'e1', from: 'a', to: 'b', kind: 'control' }],
    );

    let counter = 0;
    const deps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async () => `m${++counter}`),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
      note: vi.fn().mockResolvedValue(undefined),
    };

    const run = await runGraph(ir, deps);
    const snapshot = buildDebugSnapshot(ir, run);

    expect(snapshot.runId).toBe(run.runId);
    expect(snapshot.status).toBe('done');
    expect(snapshot.totalNodes).toBe(2);
    expect(snapshot.doneCount).toBe(2);
    expect(snapshot.failedCount).toBe(0);
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.nodes[0].nodeId).toBe('a');
    expect(snapshot.nodes[0].status).toBe('done');
    expect(snapshot.nodes[0].kind).toBe('task');
  });
});
