/**
 * agentsStore.mergeHonesty.test.tsx
 *
 * Regression coverage for the "Approve & merge is a silent no-op that LIES"
 * defect: approveMission/discardMission used to swallow a REAL merge/discard
 * failure unconditionally and still force the mission to status:'done',
 * merged:true (resp. status:'cancelled') regardless — so the UI showed
 * success while the worktree was never actually merged/discarded. The fix
 * only allows that "no-op success" swallow in web/mock mode (isTauri() ===
 * false, no real backend exists there to act against at all); in a real
 * Tauri runtime, a failure must propagate so the mission stays in its prior
 * status and the caller (MissionDetailControls) can surface a real error —
 * see MissionDetailControls.test.tsx for that half of the coverage.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { mergeWorktree, discardWorktree } from '../lib/agents/runtime';
import { emitBuffered } from '../lib/journal/journal';
import { ApproveBlockedError } from '../components/agents/approveGate';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

// Mock the runtime so runMission doesn't try to invoke Tauri, but keep
// mergeWorktree/discardWorktree as controllable spies (this suite drives
// their resolve/reject behavior per test) — same pattern as
// agentsStore.test.tsx.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

// emitBuffered wrapped in a spy over the REAL implementation (same pattern
// as agentsStore.approvalModes.test.tsx) — needed below to assert the
// mission.approve_blocked journal event without disabling real buffering.
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return {
    ...actual,
    emitBuffered: vi.fn(actual.emitBuffered),
  };
});

const mockedMergeWorktree = vi.mocked(mergeWorktree);
const mockedDiscardWorktree = vi.mocked(discardWorktree);

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

/** Adds a mission and drives it into status 'review' with a passing verdict
 *  and a worktree — the state approveMission/discardMission require. */
async function addReviewMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: 'agent/m-test',
      modelLabel: 'claude-sonnet-5',
      mode: 'agent',
      orchestrator: false,
    });
  });
  const missionId = result.current.missions[result.current.missions.length - 1].id;
  act(() => {
    result.current.updateMission({
      id: missionId,
      patch: {
        status: 'review',
        judgeVerdict: {
          score: 90,
          passed: true,
          risk: 'low',
          reviewers: [],
          createdAt: new Date().toISOString(),
        },
      },
    });
  });
  return missionId;
}

describe('approveMission — honesty fix', () => {
  afterEach(() => {
    clearTauriSimulation();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
  });

  it('Tauri + mergeWorktree resolves -> mission becomes done/merged:true', async () => {
    simulateTauri();
    mockedMergeWorktree.mockResolvedValueOnce('mock-merge-sha');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Approve success');

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project');
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mockedMergeWorktree).toHaveBeenCalledWith('C:\\real\\project', 'agent/m-test');
  });

  it('Tauri + mergeWorktree rejects -> propagates the error, mission stays "review", never merged:true', async () => {
    simulateTauri();
    mockedMergeWorktree.mockRejectedValueOnce(new Error('outside project root'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Approve failure');

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission(missionId, '.');
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message).toBe('outside project root');

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.merged).not.toBe(true);
  });

  it('web/mock mode (non-Tauri) + mergeWorktree rejects -> legitimate no-op success (unchanged pre-existing behavior)', async () => {
    // No simulateTauri() call -> isTauri() is false (no real backend exists
    // to merge against at all in this mode).
    mockedMergeWorktree.mockRejectedValueOnce(new Error('no Tauri backend'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Approve mock mode');

    await act(async () => {
      await result.current.approveMission(missionId, '.');
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });

  // ── Worktree cleanup semantics (only-on-success) ────────────────
  //
  // mergeWorktree (agent_merge_worktree, Rust — see git.rs's
  // agent_merge_worktree_inner / worktree_cleanup.rs) performs the merge AND
  // its post-merge worktree+branch cleanup as ONE atomic server-side call —
  // there is no separate frontend "cleanup" step to spy on independently.
  // These two tests lock in the resulting contract: a successful approve
  // means cleanup was attempted as part of that same call, and a failed
  // merge means cleanup was NEVER reached at all (Rust's Step 3 only runs
  // after merge_out.status.success()), so the UI must never imply otherwise.

  it('approve success -> mergeWorktree (embeds server-side worktree+branch cleanup) is invoked exactly once, mission marked merged', async () => {
    simulateTauri();
    mockedMergeWorktree.mockResolvedValueOnce('mock-merge-sha');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Approve success -> cleanup invoked');

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project');
    });

    expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
    expect(mockedMergeWorktree).toHaveBeenCalledWith('C:\\real\\project', 'agent/m-test');
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });

  it('merge failure -> cleanup is NEVER reached: mission stays "review", never merged, so the UI never implies the worktree was cleaned up', async () => {
    simulateTauri();
    mockedMergeWorktree.mockRejectedValueOnce(new Error('merge conflict'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Merge failure -> cleanup NOT invoked');

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project').catch(() => {
        // Expected — see the "propagates the error" test above for the
        // full assertion on the thrown error itself.
      });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.merged).not.toBe(true);
  });
});

describe('approveMission — unknown/not-in-review guard throws ApproveBlockedError instead of a silent no-op (bug audit wave)', () => {
  afterEach(() => {
    clearTauriSimulation();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    vi.mocked(emitBuffered).mockClear();
  });

  it('throws ApproveBlockedError for an unknown mission id (used to resolve silently, as if nothing were wrong)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission('does-not-exist', 'C:\\real\\project');
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(ApproveBlockedError);
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('throws ApproveBlockedError for a mission that is not yet in review (still queued)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Not yet in review',
        repo: '.',
        worktree: 'agent/m-notready',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission(missionId, 'C:\\real\\project');
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(ApproveBlockedError);
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('emits a mission.approve_blocked journal event (carrying the reason) when the judge gate blocks the approval', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Gate-blocked mission',
        repo: '.',
        worktree: 'agent/m-blocked',
        modelLabel: 'claude-sonnet-5',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1].id;
    // In review with NO judgeVerdict at all -> checkApproveGate blocks it.
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review' } });
    });
    vi.mocked(emitBuffered).mockClear();

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project').catch(() => {
        // Expected — asserted via the caught error in the tests above.
      });
    });

    const blockedCall = vi.mocked(emitBuffered).mock.calls.find(
      ([evt]) => evt.type === 'mission.approve_blocked' && evt.missionId === missionId,
    );
    expect(blockedCall).toBeDefined();
    const payload = blockedCall![0].payload as { reason: string };
    expect(payload.reason.length).toBeGreaterThan(0);
    expect(mockedMergeWorktree).not.toHaveBeenCalled();
  });

  it('does NOT emit mission.approve_blocked on a successful approval', async () => {
    simulateTauri();
    mockedMergeWorktree.mockResolvedValueOnce('mock-merge-sha');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Approve success -> no blocked event');
    vi.mocked(emitBuffered).mockClear();

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project');
    });

    const blockedCall = vi.mocked(emitBuffered).mock.calls.find(([evt]) => evt.type === 'mission.approve_blocked');
    expect(blockedCall).toBeUndefined();
  });

  it('a real (non-conflict) merge failure also emits mission.approve_blocked, carrying the underlying error message', async () => {
    simulateTauri();
    mockedMergeWorktree.mockRejectedValueOnce(new Error('outside project root'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Real merge failure -> blocked event too');
    vi.mocked(emitBuffered).mockClear();

    await act(async () => {
      await result.current.approveMission(missionId, '.').catch(() => {
        // Expected — see agentsStore.mergeHonesty.test.tsx's "propagates the
        // error" test for the full assertion on the thrown error itself.
      });
    });

    const blockedCall = vi.mocked(emitBuffered).mock.calls.find(
      ([evt]) => evt.type === 'mission.approve_blocked' && evt.missionId === missionId,
    );
    expect(blockedCall).toBeDefined();
    expect((blockedCall![0].payload as { reason: string }).reason).toBe('outside project root');
  });
});

describe('discardMission — honesty fix', () => {
  afterEach(() => {
    clearTauriSimulation();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
  });

  it('Tauri + discardWorktree resolves -> mission becomes cancelled', async () => {
    simulateTauri();
    mockedDiscardWorktree.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Discard success');

    await act(async () => {
      await result.current.discardMission(missionId, 'C:\\real\\project');
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('cancelled');
  });

  it('Tauri + discardWorktree rejects -> propagates the error, mission stays "review" (not cancelled)', async () => {
    simulateTauri();
    mockedDiscardWorktree.mockRejectedValueOnce(new Error('outside project root'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Discard failure');

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.discardMission(missionId, '.');
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message).toBe('outside project root');

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
  });

  it('web/mock mode (non-Tauri) + discardWorktree rejects -> legitimate no-op success (unchanged pre-existing behavior)', async () => {
    mockedDiscardWorktree.mockRejectedValueOnce(new Error('no Tauri backend'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Discard mock mode');

    await act(async () => {
      await result.current.discardMission(missionId, '.');
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('cancelled');
  });
});
