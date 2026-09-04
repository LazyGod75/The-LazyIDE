/**
 * Tests for sgrChainRunner.ts (Phase 5) — SGR-based chain execution,
 * replacing chainEngine.ts's reactive fire-per-chain logic.
 *
 * Covers: onMissionTerminalSGR fires downstream via runGraph, condition
 * matrix (success/fail/always), isolated mission skip, no downstream = no-op,
 * and init/reset lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, type Chain, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import type { Mission } from '../lib/agents/types';
import {
  initSgrChainRunner,
  onMissionTerminalSGR,
  _resetSgrChainRunnerForTests,
  type SgrChainRunnerDeps,
} from '../lib/agents/sgrChainRunner';

// ── Helpers ────────────────────────────────────────────────────────

function mission(overrides: Partial<Mission> & { id: string }): Mission {
  return {
    title: 'Test mission',
    status: 'done',
    model: 'claude-sonnet',
    agentTask: 'Do something',
    ...overrides,
  } as Mission;
}

function draft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return {
    title: 'Test draft',
    task: 'Do the thing',
    createdBy: 'user',
    ...overrides,
  } as DraftSpec;
}

function chain(overrides: Partial<Chain> & { id: string }): Chain {
  return {
    sourceRef: makeRef('mission', 'm1'),
    targetRef: makeRef('draft', 'd1'),
    condition: 'success',
    createdBy: 'user',
    ...overrides,
  } as Chain;
}

function makeDeps(overrides?: Partial<SgrChainRunnerDeps>): SgrChainRunnerDeps {
  return {
    addMission: vi.fn(async () => 'new-mission-id'),
    getActiveProjectId: vi.fn(async () => 'proj-1'),
    defaultModelId: vi.fn(() => 'claude-sonnet'),
    waitForMissions: vi.fn(async (ids: string[]) =>
      ids.map((id) => mission({ id, status: 'done' })),
    ),
    projectRoot: '/tmp/test',
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetSgrChainRunnerForTests();
});

afterEach(() => {
  _resetSgrChainRunnerForTests();
  _resetCanvasStoreForTests();
});

// ── Tests ──────────────────────────────────────────────────────────

describe('sgrChainRunner — lifecycle', () => {
  it('onMissionTerminalSGR is a no-op before initSgrChainRunner', () => {
    expect(() => onMissionTerminalSGR(mission({ id: 'm1', status: 'done' }))).not.toThrow();
  });

  it('initSgrChainRunner is idempotent (second call returns same dispose)', () => {
    const deps = makeDeps();
    const dispose1 = initSgrChainRunner(deps);
    const dispose2 = initSgrChainRunner(deps);
    expect(dispose1).toBe(dispose2);
    dispose1();
  });
});

describe('sgrChainRunner — no downstream = no-op', () => {
  it('does not launch anything when no chains reference the mission', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    // No chains at all

    onMissionTerminalSGR(mission({ id: 'm1', status: 'done' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.addMission).not.toHaveBeenCalled();
  });
});

describe('sgrChainRunner — isolated mission skip', () => {
  it('does not fire downstream for an isolated mission', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'always' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'done', isolated: true }));
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.addMission).not.toHaveBeenCalled();
  });
});

describe('sgrChainRunner — cancelled mission skip', () => {
  it('does not fire downstream for a cancelled mission', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'always' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'cancelled' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.addMission).not.toHaveBeenCalled();
  });
});

describe('sgrChainRunner — condition matrix', () => {
  it('condition=success fires on done', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', task: 'Downstream task' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'success' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'done', title: 'Source mission' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    const call = (deps.addMission as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.agentTask).toContain('## CONTEXTE AMONT');
    expect(call.agentTask).toContain('Source mission');
  });

  it('condition=success does NOT fire on failed', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'success' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'failed' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.addMission).not.toHaveBeenCalled();
  });

  it('condition=fail fires on failed', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'fail' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'failed' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));
  });

  it('condition=always fires on done', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'always' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'done' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));
  });

  it('condition=always fires on failed', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'always' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'failed' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));
  });
});

describe('sgrChainRunner — context injection', () => {
  it('appends CONTEXTE AMONT block with source mission title to downstream task', async () => {
    const deps = makeDeps();
    initSgrChainRunner(deps);

    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', task: 'Write tests' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', condition: 'success' }),
    );

    onMissionTerminalSGR(mission({ id: 'm1', status: 'done', title: 'Implement feature' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    const call = (deps.addMission as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.agentTask).toContain('Write tests');
    expect(call.agentTask).toContain('## CONTEXTE AMONT');
    expect(call.agentTask).toContain('Implement feature');
    expect(call.agentTask).toContain('done');
  });
});
