/* graph/__tests__/runGraphBranchInheritance.test.ts — Dependency-branch
   inheritance acceptance tests (chained-steps-restart-from-empty-main fix).

   Real incident (lazy-backoffice, 12-step plan mid-execution): step 1
   declared an explicit baseBranch and started from the real scaffold; steps
   2-3 declared none, so their worktrees were silently created from the
   repo's default branch (an empty seed commit) — a "harden the auth from
   the M40 merge" step ran against a repo with no auth code at all.

   Covers the four cases from the task brief:
   1. B dependsOn A -> B's worktree is created from A's branch
   2. explicit baseBranch on B overrides the inherited default
   3. A produced no branch -> B fails explicitly, naming A, never falls
      back to the repo default
   4. a fan-in (C depends on both A and B) -> starts from the first
      resolved branch and merges the rest in (never silently drops one)
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runGraph } from '../runGraph';
import { defaultBrainPolicy, defaultGraphDefaults, defaultStepContract } from '../types';
import type { GraphIR, GraphNode, GraphEdge, TaskNode, StepContract } from '../types';
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

// ── Helpers ───────────────────────────────────────────────────────

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

function makeControlEdge(id: string, from: string, to: string): GraphEdge {
  return { id, from, to, kind: 'control' };
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

/** Builds deps that: (1) launch a mission id derived from the node id, (2)
 *  settle it to `worktreeByNode[node.id]` (undefined => mission never
 *  produced a branch), (3) record the contract each node was ACTUALLY
 *  launched with — the assertion surface for every test below. */
function makeDeps(worktreeByNode: Record<string, string | undefined>): {
  deps: GraphExecutorDeps;
  launchedContracts: Record<string, StepContract | undefined>;
  launchedNodeIds: string[];
} {
  const launchedContracts: Record<string, StepContract | undefined> = {};
  const launchedNodeIds: string[] = [];
  const missionIdToNodeId = new Map<string, string>();

  const deps: GraphExecutorDeps = {
    projectRoot: '/tmp/test',
    launchMission: vi.fn(async ({ node }: { node: GraphNode }) => {
      launchedNodeIds.push(node.id);
      launchedContracts[node.id] = node.kind === 'task' || node.kind === 'contest' ? node.contract : undefined;
      const missionId = `m-${node.id}`;
      missionIdToNodeId.set(missionId, node.id);
      return missionId;
    }),
    waitForMissions: vi.fn(async (ids: string[]) => {
      return ids.map((id) => {
        const nodeId = missionIdToNodeId.get(id)!;
        const worktree = worktreeByNode[nodeId];
        return makeMission(id, 'done', worktree ?? '');
      });
    }),
    persistRun: vi.fn(),
    emit: vi.fn(),
  };

  return { deps, launchedContracts, launchedNodeIds };
}

describe('runGraph — dependency-branch inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('B dependsOn A: B is launched with baseBranch = A\'s settled branch', async () => {
    const nodes = [makeTaskNode('a', 'Scaffold auth'), makeTaskNode('b', 'Harden auth')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    const { deps, launchedContracts } = makeDeps({ a: 'agent/M6-scaffold', b: 'agent/M7-harden' });

    const run = await runGraph(ir, deps);

    expect(run.status).toBe('done');
    // A is an entry node — unchanged default, no inherited baseBranch.
    expect(launchedContracts.a?.baseBranch).toBeUndefined();
    // B inherits A's real settled branch — never the repo default.
    expect(launchedContracts.b?.baseBranch).toBe('agent/M6-scaffold');
    expect(launchedContracts.b?.mergeBranches).toBeUndefined();
  });

  it('an explicit baseBranch on B wins over the inherited default', async () => {
    const nodes = [
      makeTaskNode('a', 'Scaffold auth'),
      makeTaskNode('b', 'Harden auth', { baseBranch: 'agent/M40-explicit-scaffold' }),
    ];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    const { deps, launchedContracts } = makeDeps({ a: 'agent/M6-scaffold', b: 'agent/M7-harden' });

    const run = await runGraph(ir, deps);

    expect(run.status).toBe('done');
    // The step's own stated intent wins — NOT A's branch.
    expect(launchedContracts.b?.baseBranch).toBe('agent/M40-explicit-scaffold');
  });

  it('a dependency that settled without producing a branch fails B explicitly, never falls back to the repo default', async () => {
    const nodes = [makeTaskNode('a', 'Verification-only step'), makeTaskNode('b', 'Harden auth')];
    const edges = [makeControlEdge('e1', 'a', 'b')];
    const ir = makeIr(nodes, edges);

    // A settles 'done' but produced NO branch (worktree undefined/empty) —
    // the exact case the task brief calls out.
    const { deps, launchedContracts, launchedNodeIds } = makeDeps({ a: undefined, b: 'agent/M7-harden' });

    const run = await runGraph(ir, deps);

    // B must NEVER have been launched — no silent fallback to the repo default.
    expect(launchedNodeIds).toEqual(['a']);
    expect(launchedContracts.b).toBeUndefined();

    expect(run.nodeRuns['b'].status).toBe('failed');
    // The failure reason must explicitly name the missing upstream node.
    expect(run.nodeRuns['b'].errorMessage).toContain('a');
    expect(run.nodeRuns['b'].errorMessage).toMatch(/no branch/i);

    // B is critical by default, so the whole run is honestly reported as failed.
    expect(run.status).toBe('failed');
  });

  it('fan-in (C depends on A AND B): starts from the FIRST resolved branch and merges the rest — never silently drops one', async () => {
    const nodes = [makeTaskNode('a', 'Content'), makeTaskNode('b', 'Design'), makeTaskNode('c', 'Assemble')];
    const edges = [makeControlEdge('e1', 'a', 'c'), makeControlEdge('e2', 'b', 'c')];
    const ir = makeIr(nodes, edges);

    const { deps, launchedContracts } = makeDeps({
      a: 'agent/M-content',
      b: 'agent/M-design',
      c: 'agent/M-assemble',
    });

    const run = await runGraph(ir, deps);

    expect(run.status).toBe('done');
    // Deterministic order (dependsOn/edge order): starts from A's branch...
    expect(launchedContracts.c?.baseBranch).toBe('agent/M-content');
    // ...and merges B's branch in — never silently dropped.
    expect(launchedContracts.c?.mergeBranches).toEqual(['agent/M-design']);
  });
});
