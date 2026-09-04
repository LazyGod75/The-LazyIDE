/**
 * agentsStore.schedulerPoolRelease.test.tsx
 *
 * Root-cause repro + fix coverage for a real production defect (2026-07-28,
 * see scheduler.ts's own header comment for the full story): a validated
 * plan's next mission (M47) was queued for `scheduler.queued` reason
 * 'pool_full' 15 seconds after the PREVIOUS mission (M46) had already
 * reached 'review' (its `mission.completed` journal event fired normally),
 * then NEVER started again — even 2+ hours later.
 *
 * Root cause: scheduler.ts's launchNow() only released a mission's pool
 * slot once its wrapped launchFn PROMISE settled — but agentsStore.tsx
 * wraps the ENTIRE runMission() call as that launchFn, and runtime.ts keeps
 * running well past the mission reaching 'review' (orchestrator sub-agent
 * fan-out, then the automated tester/reviewer/security/judge evaluation
 * pipeline) before that promise ever resolves. A slow — or, on a stuck
 * sub-agent, permanently hung — tail held the pool slot hostage, starving
 * every unrelated mission waiting on the same pool with nothing to recover
 * it (scheduler.ts previously had no background timer at all).
 *
 * Fix under test here (agentsStore.tsx's half — scheduler.ts's own unit
 * tests in scheduler.test.ts cover the primitives directly):
 *   1. applyRunUpdate calls scheduler.ts's releaseMissionSlot() the MOMENT
 *      a mission's status first leaves 'running' (review/done/failed/
 *      cancelled) — decoupled from runMission's promise ever resolving.
 *   2. updateMission (the UI-action choke point, e.g. stopMission's
 *      cancellation) does the same.
 *   3. A periodic reconciliation effect frees a pool slot for a mission
 *      that vanished from the store entirely (deleteMission) without ever
 *      going through either release path above — the "reverse leak" guard.
 *
 * Harness mirrors agentsStore.missionLaunchStall.test.tsx's own pattern
 * (per-test control over runMission timing via a mocked runtime module).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import type { Mission } from '../lib/agents/types';
import type { MissionUpdate } from '../lib/agents/runtime';
import { LS_AGENTS_POOLS, resetSchedulerForTests } from '../lib/agents/scheduler';

const never = () => new Promise<never>(() => {});

const { mockInvoke, mockRunMission, mockEmitEvent } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunMission: vi.fn(),
  mockEmitEvent: vi.fn((_e: unknown) => Promise.resolve(0)),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: mockRunMission,
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/journal/journal', () => ({
  emitEvent: mockEmitEvent,
  emitBuffered: vi.fn(() => Promise.resolve(0)),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function baseMissionInput(overrides: Partial<Parameters<ReturnType<typeof useAgentsStore>['addMission']>[0]> = {}) {
  return {
    title: 'Pool release repro',
    repo: '.',
    worktree: '',
    modelLabel: 'claude-sonnet-5',
    mode: 'agent' as const,
    orchestrator: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  // Only one concurrent claude-cli slot — makes "does mission #2 launch
  // immediately or queue" an unambiguous signal.
  localStorage.setItem(LS_AGENTS_POOLS, JSON.stringify({ 'claude-cli': 1 }));
  mockInvoke.mockReset().mockImplementation(() => Promise.resolve(undefined));
  mockRunMission.mockReset().mockResolvedValue(undefined);
  mockEmitEvent.mockClear();
  resetSchedulerForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetSchedulerForTests();
});

describe('applyRunUpdate — early scheduler slot release (root-cause fix)', () => {
  it('releases the pool slot the moment a mission reaches review, even though runMission\'s OWN promise is still pending (orchestrator fan-out / evaluation tail) — the NEXT mission launches immediately instead of queuing', async () => {
    // A gate the test opens only once the mission is committed to the store
    // (addMission's setState flushed + stateRef-sync effect ran). Since
    // commit 967318d, addMission resolves `repoPath` BEFORE constructing the
    // mission, so the setState that makes the mission visible happens on a
    // later async tick — if the mock's onUpdate fired on a plain microtask it
    // would reach applyRunUpdate while stateRef.current.missions is still
    // EMPTY (prevMission undefined → the release block is skipped). The gate
    // mirrors production timing where seconds of real agent work separate
    // "mission created" from Step D's onUpdate call.
    let releaseM46!: () => void;
    const m46Ready = new Promise<void>((resolve) => {
      releaseM46 = resolve;
    });
    mockRunMission.mockImplementation(async (mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
      if (mission.title === 'M46 (plan step 1)') {
        // Real runMission does substantial async work (resolveProjectRoot,
        // worktree creation, the actual agent process) before Step D's
        // onUpdate ever fires — the gate stands in for that gap and proves
        // the release does not depend on being in the SAME synchronous tick
        // as launch.
        await m46Ready;
        // Mirrors runtime.ts's real Step D: flips to 'review' (mission.
        // completed's user-visible moment)...
        opts.onUpdate({ id: mission.id, patch: { status: 'review' } });
        // ...then keeps "running" forever — Step E/F (orchestrator fan-out,
        // tester/reviewer/security/judge evaluation) never settles, exactly
        // the real-world stuck-sub-agent scenario this fix protects against.
        return never();
      }
      return never();
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let addMissionPromise!: Promise<string>;
    act(() => {
      addMissionPromise = result.current.addMission(baseMissionInput({ title: 'M46 (plan step 1)' }));
    });
    await act(async () => {
      await addMissionPromise;
    });

    // M46 is created (queued) and its launchFn is parked on the gate — the
    // store is committed and the stateRef-sync effect has run.
    expect(result.current.missions.find((m) => m.title === 'M46 (plan step 1)')?.status).toBe('queued');
    expect(mockRunMission).toHaveBeenCalledTimes(1);

    // Let M46's runMission reach Step D (status 'review') NOW that the
    // mission is committed — applyRunUpdate's release then sees prevMission.
    act(() => {
      releaseM46();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // M46 reached 'review' through its own onUpdate call, while its wrapped
    // runMission() promise never resolves.
    expect(result.current.missions.find((m) => m.title === 'M46 (plan step 1)')?.status).toBe('review');
    expect(mockRunMission).toHaveBeenCalledTimes(1);

    mockEmitEvent.mockClear();

    // M47 — the plan's next step, dispatched right after, exactly like the
    // real incident (15s later in production; timing doesn't matter here).
    await act(async () => {
      await result.current.addMission(baseMissionInput({ title: 'M47 (plan step 2)' }));
    });

    // Before the fix: the claude-cli pool (cap 1) was still counted as
    // occupied by M46's still-pending launchFn promise, so M47 would have
    // been queued (`scheduler.queued`, reason 'pool_full') and runMission
    // would NEVER have been called for it. After the fix: M46's slot was
    // already released at its 'review' transition, so M47 launches
    // immediately.
    expect(mockRunMission).toHaveBeenCalledTimes(2);
    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.queued', payload: expect.objectContaining({ reason: 'pool_full' }) }),
    );
  });

  it('a genuinely full pool (mission #1 still actually running, never reached review) still queues mission #2 — the fix never bypasses the concurrency cap itself', async () => {
    mockRunMission.mockImplementation(() => never()); // never reaches 'review' — genuinely still running

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission(baseMissionInput({ title: 'Still running #1' }));
    });
    mockEmitEvent.mockClear();

    await act(async () => {
      await result.current.addMission(baseMissionInput({ title: 'Still running #2' }));
    });

    // Cap is 1 and mission #1 never left 'running' (no onUpdate at all) —
    // #2 must still queue exactly like today.
    expect(mockRunMission).toHaveBeenCalledTimes(1);
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.queued', payload: expect.objectContaining({ reason: 'pool_full' } )}),
    );
  });
});

describe('updateMission — early scheduler slot release on cancellation', () => {
  it('stopMission (cancellation) frees the slot immediately — the next mission launches right away instead of waiting on the killed run\'s own promise', async () => {
    mockRunMission.mockImplementation(() => never()); // simulates a real agent process that stopMission has to kill out-of-band

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      missionId = await result.current.addMission(baseMissionInput({ title: 'To be cancelled' }));
    });
    expect(mockRunMission).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.stopMission(missionId);
    });
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('cancelled');

    await act(async () => {
      await result.current.addMission(baseMissionInput({ title: 'Next after cancel' }));
    });

    expect(mockRunMission).toHaveBeenCalledTimes(2);
  });
});

describe('periodic reconciliation — reverse-leak guard', () => {
  it('frees a pool slot for a mission that vanished from the store entirely (deleteMission), even though it never went through either release path', async () => {
    mockRunMission.mockImplementation(() => never()); // never calls onUpdate at all — simulates a genuinely crashed/stuck run

    // Fake timers MUST be installed before the component mounts: the
    // reconciliation effect's setInterval is registered on mount, and
    // vi.useFakeTimers() only intercepts setInterval calls made AFTER it is
    // installed — an interval already running under the real clock is
    // untouched by vi.advanceTimersByTimeAsync.
    vi.useFakeTimers();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      const p = result.current.addMission(baseMissionInput({ title: 'Vanishes mid-run' }));
      await vi.advanceTimersByTimeAsync(0);
      missionId = await p;
    });
    expect(mockRunMission).toHaveBeenCalledTimes(1);

    // Removes the mission from React state entirely WITHOUT any status
    // transition — deleteMission bypasses both updateMission and
    // applyRunUpdate, so neither release hook ever fires. The scheduler's
    // OWN bookkeeping (_runningMissionIds/_missionPool) is now stale.
    act(() => {
      result.current.deleteMission(missionId);
    });
    expect(result.current.missions.find((m) => m.id === missionId)).toBeUndefined();

    let addMissionPromise!: Promise<string>;
    act(() => {
      addMissionPromise = result.current.addMission(baseMissionInput({ title: 'After reconciliation' }));
    });
    // The reconciliation effect polls every 20s (RECONCILE_INTERVAL_MS) —
    // advance past one tick so it notices the vanished mission and releases
    // its slot before this second addMission's own dispatch() call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    await act(async () => {
      await addMissionPromise;
    });
    vi.useRealTimers();

    expect(mockRunMission).toHaveBeenCalledTimes(2);
  });
});
