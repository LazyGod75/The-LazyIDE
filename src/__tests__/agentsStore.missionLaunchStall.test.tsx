/**
 * agentsStore.missionLaunchStall.test.tsx
 *
 * P0 real-app QA: creating a mission added the card (setState) then
 * addMission's `await resolveProjectRoot()` never settled because its raw
 * `invoke('get_project_root')` never resolved nor rejected — 6+ minutes,
 * zero journal events, no worktree, mission frozen 'queued' with no
 * statusReason, no console error.
 *
 * Covers the three-layer fix in agentsStore.tsx:
 *   1. resolveProjectRoot — every invoke is now bounded by
 *      PROJECT_ROOT_RESOLVE_TIMEOUT_MS (withTimeout, reused from
 *      brainSearchLoop.ts) and degrades to the caller-supplied fallback root
 *      (addMission passes input.repo) instead of hanging or silently
 *      defaulting to '.'.
 *   2. armQueuedLaunchWatchdog — a mission still 'queued' with no progress
 *      LAUNCH_STALL_WATCHDOG_MS (45s) after launch commit gets an honest
 *      statusReason ('launch_stalled') + a mission.blocked journal event,
 *      instead of freezing silently. A no-op for a mission that actually
 *      starts running.
 *   3. retryMission — clears a stale statusReason on the clone, so retrying
 *      a flagged mission does not carry the old reason onto the fresh
 *      attempt.
 *
 * Mocking mirrors takeover.test.tsx's harness (own @tauri-apps/api/core +
 * runtime + journal mocks) since this suite needs per-test control over
 * invoke/runMission timing that the shared setup.ts default (always resolves
 * immediately) cannot provide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore, resolveProjectRoot } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import type { Mission } from '../lib/agents/types';
import type { MissionUpdate } from '../lib/agents/runtime';

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

// Keep everything else in runtime.ts real (classifyMissionModel, etc. — the
// scheduler depends on it) — mirrors agentsStore.test.tsx's own runtime mock.
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
    title: 'Launch stall repro',
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
  mockInvoke.mockReset().mockImplementation(() => Promise.resolve(undefined));
  mockRunMission.mockReset().mockResolvedValue(undefined);
  mockEmitEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. resolveProjectRoot — timeout + fallback (direct, no React) ─────────

describe('resolveProjectRoot — P0 hang fix', () => {
  it('resolves via the caller-supplied fallback when get_project_root never settles, and warns', async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === 'get_project_root' ? never() : Promise.resolve(undefined)));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      const assertion = expect(resolveProjectRoot('/user/picked/repo')).resolves.toBe('/user/picked/repo');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.some((args) => String(args[0]).includes('/user/picked/repo'));
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  it('still resolves to "." when no usable fallback was supplied (pre-existing behavior unchanged)', async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === 'get_project_root' ? never() : Promise.resolve(undefined)));

    vi.useFakeTimers();
    try {
      const assertion = expect(resolveProjectRoot()).resolves.toBe('.');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a "." fallback (carries no more information than the existing dot-fallback)', async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === 'get_project_root' ? never() : Promise.resolve(undefined)));

    vi.useFakeTimers();
    try {
      const assertion = expect(resolveProjectRoot('.')).resolves.toBe('.');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 2. addMission — the launch proceeds via the fallback ──────────────────

describe('addMission — launch proceeds when resolveProjectRoot falls back', () => {
  it('dispatches runMission with the fallback root instead of hanging when get_project_root never settles', async () => {
    mockInvoke.mockImplementation((cmd: string) => (cmd === 'get_project_root' ? never() : Promise.resolve(undefined)));

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.useFakeTimers();
    let addMissionPromise!: Promise<string>;
    act(() => {
      addMissionPromise = result.current.addMission(
        baseMissionInput({ title: 'Fallback launch', repo: '/user/picked/repo' }),
      );
    });

    // The hung get_project_root invoke only clears once resolveProjectRoot's
    // own withTimeout fires — advance past it before awaiting the launch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    await act(async () => {
      await addMissionPromise;
    });
    vi.useRealTimers();

    expect(mockRunMission).toHaveBeenCalledTimes(1);
    const [, repoPathArg] = mockRunMission.mock.calls[0] as [Mission, string, unknown];
    expect(repoPathArg).toBe('/user/picked/repo');
  });
});

// ── 3. Queued-launch watchdog ──────────────────────────────────────────────

describe('addMission — queued-launch watchdog', () => {
  it('flags a mission that never progresses: statusReason=launch_stalled + mission.blocked at 45s', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'get_project_root' ? Promise.resolve('/real/root') : Promise.resolve(undefined),
    );
    // Simulates a stall somewhere AFTER resolveProjectRoot (e.g. inside
    // runMission itself) — onUpdate never fires, so status never leaves
    // 'queued'.
    mockRunMission.mockImplementation(() => never());

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.addMission(baseMissionInput({ title: 'Stalled launch', repo: '/real/root' }));
    });

    const beforeWatchdog = result.current.missions.find((m) => m.title === 'Stalled launch');
    expect(beforeWatchdog?.status).toBe('queued');
    expect(beforeWatchdog?.statusReason).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    vi.useRealTimers();

    const mission = result.current.missions.find((m) => m.title === 'Stalled launch')!;
    expect(mission.status).toBe('queued');
    expect(mission.statusReason).toBe('launch_stalled');
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.blocked',
        missionId: mission.id,
        payload: { reason: 'launch_stalled' },
      }),
    );
  });

  it('does NOT flag a mission that already started running before 45s', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'get_project_root' ? Promise.resolve('/real/root') : Promise.resolve(undefined),
    );
    mockRunMission.mockImplementation((mission: Mission, _root: string, opts: { onUpdate: (u: MissionUpdate) => void }) => {
      // Mirrors runtime.ts's own early 'status-flip-running' phase.
      opts.onUpdate({ id: mission.id, patch: { status: 'running' } });
      return never(); // stays running indefinitely — a healthy, long mission.
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.addMission(baseMissionInput({ title: 'Healthy launch', repo: '/real/root' }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    vi.useRealTimers();

    const mission = result.current.missions.find((m) => m.title === 'Healthy launch')!;
    expect(mission.status).toBe('running');
    expect(mission.statusReason).toBeUndefined();
    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.blocked', payload: { reason: 'launch_stalled' } }),
    );
  });

  it('does NOT flag a mission already blocked for a different reason (session budget)', async () => {
    localStorage.setItem('lazy.agents.costLimitUsd', '1');
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'get_project_root' ? Promise.resolve('/real/root') : Promise.resolve(undefined),
    );

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.addMission(
        baseMissionInput({
          title: 'Budget-blocked launch',
          repo: '/real/root',
          contract: { quote: { costUsd: [5, 5] } } as never,
        }),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    vi.useRealTimers();

    const mission = result.current.missions.find((m) => m.title === 'Budget-blocked launch')!;
    // The watchdog is only armed once a launch actually commits to dispatch
    // (past the session-cap check) — a budget-blocked mission must keep ITS
    // OWN reason, never be relabeled 'launch_stalled'.
    expect(mission.statusReason).not.toBe('launch_stalled');
    expect(mockEmitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: { reason: 'launch_stalled' } }),
    );
  });
});

// ── 4. retryMission clears a stale reason ─────────────────────────────────

describe('retryMission — clears a stale statusReason on the clone', () => {
  it('does not carry an old statusReason (e.g. launch_stalled) onto the retried clone', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let missionId = '';
    await act(async () => {
      missionId = await result.current.addMission(baseMissionInput({ title: 'Retry-clear source' }));
    });

    act(() => {
      result.current.updateMission({ id: missionId, patch: { statusReason: 'launch_stalled' } });
    });
    expect(result.current.missions.find((m) => m.id === missionId)?.statusReason).toBe('launch_stalled');

    act(() => {
      result.current.retryMission(missionId);
    });

    const clone = result.current.missions[result.current.missions.length - 1];
    expect(clone.title).toBe('Retry-clear source');
    expect(clone.id).not.toBe(missionId);
    expect(clone.status).toBe('queued');
    expect(clone.statusReason).toBeUndefined();
  });
});
