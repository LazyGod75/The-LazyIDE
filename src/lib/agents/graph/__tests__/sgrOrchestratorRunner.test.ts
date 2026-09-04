/* graph/__tests__/sgrOrchestratorRunner.test.ts

   EXECUTE_PLAN REPLAY fix (2026-08-05, real prod incident — re-executing a
   plan already partially run relaunched EVERY step, done ones included:
   three duplicate "structure" missions off the same plan, M25/M26).

   Covers:
   1. seedRunFromSteps returns undefined when nothing is settled yet (a
      plan's first execution is byte-identical to before this fix).
   2. seedRunFromSteps seeds a 'done' node status + preserves missionIds for
      every already-done/skipped step, and leaves the rest 'pending'.
   3. End-to-end via runGraph: a plan with 2 done steps + 2 pending steps
      only ever launches the 2 pending ones (the user's own acceptance
      test) — the 2 done steps' missions are never relaunched.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seedRunFromSteps, startOrchestratorViaSgr, launchOptsFromNode } from '../sgrOrchestratorRunner';
import { compileOrchestratorToIr } from '../compileOrchestrator';
import { runGraph } from '../runGraph';
import type { GraphExecutorDeps } from '../runGraph';
import { addMissionToRegistry, registerProject } from '../../globalRuntime';
import type { Mission, OrchestratorState } from '../../types';
import * as graphRunStore from '../graphRunStore';

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const createDirMock = vi.fn();
const readDirMock = vi.fn();

vi.mock('../../../platform', () => ({
  getPlatform: () => ({
    fs: {
      readFile: readFileMock,
      writeFile: writeFileMock,
      createDir: createDirMock,
      readDir: readDirMock,
    },
  }),
  isTauri: () => false,
}));

function makeMission(id: string, status: Mission['status']): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status,
    model: 'claude-sonnet',
    worktree: `agent/${id}`,
    createdAt: Date.now(),
    progress: 0,
    planSteps: [],
    actionTimeline: [],
  };
}

function makeOrch(overrides?: Partial<OrchestratorState>): OrchestratorState {
  return {
    id: 'orch-1',
    name: 'Replay Test Plan',
    projectId: 'p1',
    targetProjectIds: ['p1'],
    objective: 'test replay skip',
    steps: [
      { id: 's1', description: 'Step 1', status: 'done', missionIds: ['m-s1'], dependsOn: [], autonomyLevel: 'supervised', completedAt: 111 },
      { id: 's2', description: 'Step 2', status: 'done', missionIds: ['m-s2'], dependsOn: ['s1'], autonomyLevel: 'supervised', completedAt: 222 },
      { id: 's3', description: 'Step 3', status: 'pending', missionIds: [], dependsOn: ['s2'], autonomyLevel: 'supervised' },
      { id: 's4', description: 'Step 4', status: 'pending', missionIds: [], dependsOn: ['s2'], autonomyLevel: 'supervised' },
    ],
    currentStep: 0,
    status: 'blocked',
    budget: { spentCents: 0 },
    childMissionIds: ['m-s1', 'm-s2'],
    createdAt: 0,
    updatedAt: 0,
    autonomyLevel: 'supervised',
    ...overrides,
  };
}

describe('seedRunFromSteps', () => {
  it('returns undefined when no step is settled yet — first execution is unaffected', () => {
    const orch = makeOrch({
      steps: [
        { id: 's1', description: 'Step 1', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
      ],
    });
    const ir = compileOrchestratorToIr(orch);
    expect(seedRunFromSteps(ir, orch)).toBeUndefined();
  });

  it('seeds done/skipped steps as resolved (status + missionIds preserved), leaves the rest pending', () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);
    const run = seedRunFromSteps(ir, orch);
    expect(run).toBeDefined();
    expect(run!.nodeRuns['s1'].status).toBe('done');
    expect(run!.nodeRuns['s1'].missionIds).toEqual(['m-s1']);
    expect(run!.nodeRuns['s2'].status).toBe('done');
    expect(run!.nodeRuns['s2'].missionIds).toEqual(['m-s2']);
    expect(run!.nodeRuns['s3'].status).toBe('pending');
    expect(run!.nodeRuns['s3'].missionIds).toEqual([]);
    expect(run!.nodeRuns['s4'].status).toBe('pending');
  });

  it('maps a skipped step to node status skipped (not done)', () => {
    const orch = makeOrch({
      steps: [
        { id: 's1', description: 'Step 1', status: 'skipped', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' },
      ],
    });
    const ir = compileOrchestratorToIr(orch);
    const run = seedRunFromSteps(ir, orch);
    expect(run!.nodeRuns['s1'].status).toBe('skipped');
  });
});

describe('EXECUTE_PLAN REPLAY — end-to-end via runGraph (acceptance test)', () => {
  it('a plan with 2 done steps + 2 pending steps only launches the 2 pending ones', async () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);

    // Real-scenario setup (the reported bug's own scenario — re-executing a
    // plan shortly after a partial run, same session, never an app
    // restart): the settled steps' missions are still tracked in the
    // globalRuntime registry from their ORIGINAL run, exactly as
    // agentsStore.tsx keeps it in sync for every mission it launches — so
    // resolveInheritedBranches (runGraph.ts) can resolve s3/s4's inherited
    // base branch from s2's own real mission branch via seedRunFromSteps's
    // resultBranch lookup.
    registerProject('p1', '/tmp/test', 'Test Project');
    addMissionToRegistry('p1', makeMission('m-s1', 'done'));
    addMissionToRegistry('p1', makeMission('m-s2', 'done'));

    const existingRun = seedRunFromSteps(ir, orch);

    const launched: string[] = [];
    const deps: GraphExecutorDeps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        launched.push(args.node.id);
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    const run = await runGraph(ir, deps, { existingRun });

    expect(launched.sort()).toEqual(['s3', 's4']);
    expect(run.nodeRuns['s1'].status).toBe('done');
    expect(run.nodeRuns['s2'].status).toBe('done');
    expect(run.status).toBe('done');
  });

  it('without the seed (today\'s pre-fix behavior, sanity check), a bare re-run WOULD relaunch every step', async () => {
    const orch = makeOrch();
    const ir = compileOrchestratorToIr(orch);

    const launched: string[] = [];
    const deps: GraphExecutorDeps = {
      projectRoot: '/tmp/test',
      launchMission: vi.fn(async (args: { node: { id: string } }) => {
        launched.push(args.node.id);
        return `m-${args.node.id}`;
      }),
      waitForMissions: vi.fn(async (ids: string[]) => ids.map((id) => makeMission(id, 'done'))),
      persistRun: vi.fn(),
      emit: vi.fn(),
    };

    // No existingRun passed — this is the exact bug: every node starts
    // 'pending' regardless of the orchestrator's own persisted step status.
    await runGraph(ir, deps);

    expect(launched.sort()).toEqual(['s1', 's2', 's3', 's4']);
  });
});

describe('startOrchestratorViaSgr — GraphRun persistence + phantom-run reconciliation wiring (item 6, D7 fix)', () => {
  beforeEach(() => {
    readFileMock.mockReset().mockRejectedValue(new Error('No such file or directory'));
    writeFileMock.mockReset().mockResolvedValue(undefined);
    createDirMock.mockReset().mockResolvedValue(undefined);
    readDirMock.mockReset().mockRejectedValue(new Error('No such file or directory'));
  });

  it('persists the full GraphRun via saveGraphRun on every transition, and reconciles phantom runs before starting', async () => {
    const saveSpy = vi.spyOn(graphRunStore, 'saveGraphRun');
    const reconcileSpy = vi.spyOn(graphRunStore, 'reconcilePhantomGraphRuns');

    registerProject('p-wiring', '/tmp/wiring-test', 'Wiring Test Project');

    const orch = makeOrch({
      id: 'orch-wiring',
      projectId: 'p-wiring',
      targetProjectIds: ['p-wiring'],
      steps: [{ id: 's1', description: 'Step 1', status: 'pending', missionIds: [], dependsOn: [], autonomyLevel: 'supervised' }],
      status: 'planning',
      childMissionIds: [],
    });

    const result = await startOrchestratorViaSgr(orch, {
      projectRoot: '/tmp/wiring-test',
      launchMission: vi.fn(async () => {
        // Register the mission BEFORE returning its id — waitForMission
        // (sgrOrchestratorRunner.ts) checks findMissionById synchronously
        // first, so this avoids needing to simulate a real subscribe event.
        addMissionToRegistry('p-wiring', makeMission('m-wiring-s1', 'done'));
        return 'm-wiring-s1';
      }),
    });

    expect(result.run.status).toBe('done');
    // Reconciliation runs BEFORE the fresh run starts — see this module's
    // own doc comment on why (sweep stale on-disk runs first).
    expect(reconcileSpy).toHaveBeenCalledWith('/tmp/wiring-test');
    // The FULL GraphRun (not just the lossy OrchestratorStep projection)
    // was persisted at least once, carrying a real runId.
    expect(saveSpy).toHaveBeenCalled();
    const lastSavedRun = saveSpy.mock.calls.at(-1)?.[1];
    expect(lastSavedRun?.runId).toBeTruthy();
    // The GraphRun file itself was really written to a graph-runs path —
    // not just orchestrators.json.
    const graphRunWrite = writeFileMock.mock.calls.find(([path]) => String(path).includes('graph-runs'));
    expect(graphRunWrite).toBeDefined();
  });
});

describe('launchOptsFromNode — modelId on task and contest', () => {
  function orchWith(steps: OrchestratorState['steps']): OrchestratorState {
    return {
      id: 'orch-mid',
      name: 'ModelId',
      projectId: 'p1',
      targetProjectIds: ['p1'],
      objective: 'propagate modelId',
      steps,
      currentStep: 0,
      status: 'planning',
      budget: { spentCents: 0 },
      childMissionIds: [],
      createdAt: 0,
      updatedAt: 0,
      autonomyLevel: 'supervised',
    };
  }

  it('copies a task step modelId onto SgrLaunchOpts', () => {
    const ir = compileOrchestratorToIr(orchWith([
      {
        id: 's1',
        description: 'Implement it',
        status: 'pending',
        missionIds: [],
        dependsOn: [],
        autonomyLevel: 'supervised',
        modelId: 'anthropic/claude-sonnet-5',
      },
    ]));
    const node = ir.nodes.find((n) => n.id === 's1');
    expect(node?.kind).toBe('task');
    expect(launchOptsFromNode(node!, 'p1').modelId).toBe('anthropic/claude-sonnet-5');
  });

  it('copies a contest step modelId onto SgrLaunchOpts (launch_best_of_n path)', () => {
    const ir = compileOrchestratorToIr(orchWith([
      {
        id: 'c1',
        description: 'Best of three',
        status: 'pending',
        missionIds: [],
        dependsOn: [],
        autonomyLevel: 'supervised',
        contestN: 3,
        modelId: 'anthropic/claude-haiku-4.5',
      },
    ]));
    const node = ir.nodes.find((n) => n.id === 'c1');
    expect(node?.kind).toBe('contest');
    expect(launchOptsFromNode(node!, 'p1').modelId).toBe('anthropic/claude-haiku-4.5');
  });

  it('does not invent a modelId on a join node', () => {
    const ir = compileOrchestratorToIr(orchWith([
      {
        id: 'a',
        description: 'A',
        status: 'pending',
        missionIds: [],
        dependsOn: [],
        autonomyLevel: 'supervised',
        joinGroup: 'wave',
        modelId: 'anthropic/claude-sonnet-5',
      },
      {
        id: 'b',
        description: 'B',
        status: 'pending',
        missionIds: [],
        dependsOn: [],
        autonomyLevel: 'supervised',
        joinGroup: 'wave',
        modelId: 'anthropic/claude-haiku-4.5',
      },
    ]));
    const join = ir.nodes.find((n) => n.kind === 'join');
    expect(join).toBeDefined();
    expect(launchOptsFromNode(join!, 'p1').modelId).toBeUndefined();
  });
});
