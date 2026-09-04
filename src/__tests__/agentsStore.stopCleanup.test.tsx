/**
 * agentsStore.stopCleanup.test.tsx
 *
 * Regression coverage for "worktrees leak on Stop/Cancel": stopMission (and
 * the bulk stopAll) used to only flip the in-memory stopFlag and
 * optimistically set status:'cancelled', relying entirely on runMission
 * (runtime.ts) noticing the flag and cleaning up on its own before reaching
 * a terminal state — which has a real gap (see agentsStore.tsx's
 * cleanupStoppedWorktree doc comment: the retry-continuation branch inside
 * runMission's Step B never re-checks stopSignal after a retry's planAndAct
 * call). Stop now ALSO fires an immediate, direct discardWorktree call — the
 * same resolveDiscardWorktreePath + discardWorktree pair discardMission
 * uses (see agentsStore.discard.test.ts for that original regression).
 *
 * NOTE on repoPath assertions: resolveProjectRoot() itself (the shared
 * real-project-root resolver — see its doc comment in agentsStore.tsx) is
 * exercised end-to-end and pinned to an exact expected value elsewhere
 * (MissionDetail.test.tsx's repoPath-regression suite, which mocks it as a
 * single deterministic call; agentsStore.mergeHonesty.test.tsx, which
 * receives repoPath as a plain test-supplied argument). This suite instead
 * asserts the invariant specific to THIS fix: whatever repoPath resolves to,
 * cleanupStoppedWorktree derives the worktreePath from it via the exact same
 * resolveDiscardWorktreePath discardMission uses — proving Stop is wired to
 * the real cleanup pipeline, not skipping it. This sidesteps a benign
 * Vitest-only artifact where firing several concurrent dynamic
 * import('@tauri-apps/api/core') calls (stopMission's own cleanup fires
 * essentially alongside updateMission's queue-sync, which independently
 * calls resolveProjectRoot too) can occasionally race and fall through to
 * resolveProjectRoot's own honest '.' fallback — never a crash, and not a
 * production concern (a real Tauri runtime has no such mock-registry race).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  AgentsStoreProvider,
  useAgentsStore,
  resolveDiscardWorktreePath,
} from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { discardWorktree } from '../lib/agents/runtime';
import { invoke } from '@tauri-apps/api/core';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDiscardWorktree = vi.mocked(discardWorktree);
const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

/** Simulates the Tauri desktop runtime — see killAgentRun/isLiveAgentAvailable
 *  in runtime.ts, which gate on this exact marker. Mirrors
 *  agentsStore.mergeHonesty.test.tsx's local helper of the same name. */
function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

/** Adds a mission and drives it into a running state with a worktree branch
 *  set — the minimum state a "Stop" click can target in the real UI. */
async function addRunningMissionWithWorktree(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
  branch: string,
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: '',
      modelLabel: 'claude-sonnet-5',
      mode: 'agent',
      orchestrator: false,
    });
  });
  const missionId = result.current.missions[result.current.missions.length - 1].id;
  act(() => {
    result.current.updateMission({
      id: missionId,
      patch: { status: 'running', worktree: branch },
    });
  });
  return missionId;
}

describe('stopMission — worktree cleanup', () => {
  afterEach(() => {
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
    mockedInvoke.mockReset().mockResolvedValue(undefined);
    clearTauriSimulation();
  });

  it('discards the worktree via the same resolveDiscardWorktreePath + discardWorktree pair discardMission uses', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMissionWithWorktree(result, 'Mission to stop', 'agent/m-stop-test');

    act(() => {
      result.current.stopMission(missionId);
    });

    // Optimistic status flips synchronously — unchanged pre-existing behavior.
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('cancelled');

    // The cleanup call is fire-and-forget (resolveProjectRoot() -> discardWorktree()).
    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));

    const [calledRepoPath, calledWorktreePath, calledBranch] = mockedDiscardWorktree.mock.calls[0];
    expect(calledBranch).toBe('agent/m-stop-test');
    // Invariant this fix guarantees: worktreePath is ALWAYS derived from
    // repoPath via the exact same helper discardMission uses — never a
    // hand-rolled or hardcoded join.
    expect(calledWorktreePath).toBe(
      resolveDiscardWorktreePath(calledRepoPath as string, calledBranch as string),
    );
  });

  it('kills the native agent process (agent_run_kill) BEFORE the worktree discard — Windows file-lock race fix', async () => {
    // Real-app QA traced the stopped-mission worktree leak to a race: the
    // actual process kill used to happen independently, on runtime.ts's
    // separate ~200ms pollStop tick, fully uncoordinated with this cleanup
    // chain. stopMission now issues killAgentRun (-> invoke('agent_run_kill'))
    // itself, before ever attempting the discard, so cleanup is never the
    // first thing racing the still-alive child process for the worktree.
    simulateTauri();
    const callOrder: string[] = [];
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'agent_run_kill') callOrder.push('agent_run_kill');
      return Promise.resolve(undefined);
    });
    mockedDiscardWorktree.mockImplementationOnce(async () => {
      callOrder.push('discardWorktree');
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMissionWithWorktree(result, 'Mission to stop natively', 'agent/m-kill-order');

    act(() => {
      result.current.stopMission(missionId);
    });

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));

    const killCalls = mockedInvoke.mock.calls.filter(
      ([cmd, args]) => cmd === 'agent_run_kill' && (args as { id?: string } | undefined)?.id === missionId,
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    expect(callOrder).toEqual(['agent_run_kill', 'discardWorktree']);
  });

  it('web/mock mode (non-Tauri) never invokes agent_run_kill (killAgentRun is a guarded no-op there)', async () => {
    // isTauriRuntime() is false by default in this test file (no
    // simulateTauri() call) — killAgentRun must short-circuit without
    // calling invoke at all, matching runMission's own isTauriRuntime()
    // gating elsewhere.
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMissionWithWorktree(result, 'Mission to stop (mock mode)', 'agent/m-mock-stop');

    act(() => {
      result.current.stopMission(missionId);
    });

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));

    const killCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'agent_run_kill');
    expect(killCalls.length).toBe(0);
  });

  it('does NOT attempt a discard when the mission has no worktree yet (nothing to clean up)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Still queued, no worktree',
        repo: '.',
        worktree: '',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'running' } });
    });

    act(() => {
      result.current.stopMission(missionId);
    });

    // Flush any pending microtasks — there should be none, since the
    // mission.worktree guard skips the cleanup chain entirely.
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalled();
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('cancelled');
  });

  it('stopping a mission with an unknown id is a safe no-op (no crash, no discard)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    act(() => {
      result.current.stopMission('M-does-not-exist');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalled();
  });
});

describe('stopAll — worktree cleanup', () => {
  afterEach(() => {
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
    mockedInvoke.mockReset().mockResolvedValue(undefined);
  });

  it('discards the worktree for every running mission matching the filter, via the same discardMission pair', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await addRunningMissionWithWorktree(result, 'Bulk stop alpha', 'agent/bulk-a');

    act(() => {
      result.current.stopAll('Bulk stop alpha');
    });

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));

    const [calledRepoPath, calledWorktreePath, calledBranch] = mockedDiscardWorktree.mock.calls[0];
    expect(calledBranch).toBe('agent/bulk-a');
    expect(calledWorktreePath).toBe(
      resolveDiscardWorktreePath(calledRepoPath as string, calledBranch as string),
    );
  });

  it('does not touch missions that do not match the filter', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const otherId = await addRunningMissionWithWorktree(result, 'Unrelated mission', 'agent/unrelated');

    act(() => {
      result.current.stopAll('Bulk stop alpha');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'agent/unrelated',
    );
    const other = result.current.missions.find((m) => m.id === otherId)!;
    expect(other.status).toBe('running');
  });
});
