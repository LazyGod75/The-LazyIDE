/**
 * agentsStore.archiveCleanup.test.tsx
 *
 * Regression coverage for "worktrees leak: archiving a mission never removes
 * its worktree" — `archiveMission` used to only ever patch the `archived`
 * flag (R13 lifecycle) and stop a registered loop (ZOMBIE LOOP fix); it
 * never reclaimed the mission's git worktree, so EVERY archived mission left
 * its worktree directory (and branch) on disk forever. The automatic P58
 * fleet-hygiene sweep only ever calls `archiveMission` to archive a mission,
 * so nothing downstream ever reclaimed the disk either — confirmed for real
 * in this exact repo's own `.lazy/worktrees/` before this fix (a handful of
 * archived/failed missions with a live worktree field and no cleanup ever
 * attempted).
 *
 * Mirrors agentsStore.stopCleanup.test.tsx's exact mocking/assertion
 * conventions: `archiveMission` reuses the SAME killAgentRun ->
 * resolveProjectRoot -> cleanupStoppedWorktree chain stopMission/stopAll are
 * already covered by there — this suite proves archiveMission is wired to
 * that same real pipeline, never a second implementation, and proves the
 * new terminal-only guard (never review/running) holds even when a caller
 * invokes archiveMission directly without pre-filtering.
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
import type { MissionStatus } from '../lib/agents/types';

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
 *  agentsStore.stopCleanup.test.tsx's local helper of the same name. */
function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

/** Adds a mission and drives it to `status` with `worktree` (branch) set —
 *  the minimum state an "Archiver" click can target in the real UI. Absent
 *  `worktree` mirrors a mission that never actually reached "running" (no
 *  worktree ever created). */
async function addMissionWithStatus(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
  status: MissionStatus,
  worktree?: string,
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
    result.current.updateMission({ id: missionId, patch: { status, worktree } });
  });
  return missionId;
}

describe('archiveMission — worktree cleanup', () => {
  afterEach(() => {
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
    mockedInvoke.mockReset().mockResolvedValue(undefined);
    clearTauriSimulation();
  });

  it('discards the worktree for a FAILED mission — the primary leak this fix targets (nothing else ever cleaned up a failed mission\'s worktree)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithStatus(result, 'Failed mission', 'failed', 'agent/m-archive-failed');

    act(() => {
      result.current.archiveMission(missionId);
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.archived).toBe(true);

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));

    const [calledRepoPath, calledWorktreePath, calledBranch] = mockedDiscardWorktree.mock.calls[0];
    expect(calledBranch).toBe('agent/m-archive-failed');
    // Invariant this fix guarantees: worktreePath is ALWAYS derived via the
    // exact same helper discardMission/stopMission already use — never a
    // hand-rolled or hardcoded join, and never a second implementation.
    expect(calledWorktreePath).toBe(resolveDiscardWorktreePath(calledRepoPath as string, calledBranch as string));
  });

  it('discards the worktree for a DONE mission (harmless idempotent no-op in practice — the merge itself already cleaned it up, same as cleanup_worktree_and_branch\'s own idempotence)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithStatus(result, 'Done mission', 'done', 'agent/m-archive-done');

    act(() => {
      result.current.archiveMission(missionId);
    });

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));
    expect(mockedDiscardWorktree.mock.calls[0][2]).toBe('agent/m-archive-done');
  });

  it('discards the worktree for a CANCELLED mission (harmless idempotent no-op in practice — Stop/Reject already cleaned it up)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithStatus(result, 'Cancelled mission', 'cancelled', 'agent/m-archive-cancelled');

    act(() => {
      result.current.archiveMission(missionId);
    });

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));
    expect(mockedDiscardWorktree.mock.calls[0][2]).toBe('agent/m-archive-cancelled');
  });

  it('does NOT attempt a discard for a REVIEW mission, even though archiveMission itself has no external caller pre-filtering it in this test (structural guard, not a trust-the-caller convention)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithStatus(result, 'In review', 'review', 'agent/m-archive-review');

    act(() => {
      result.current.archiveMission(missionId);
    });

    // archiving itself (the `archived` flag) still applies — only the
    // worktree-cleanup half is guarded.
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.archived).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalled();
  });

  it('does NOT attempt a discard for a RUNNING mission', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithStatus(result, 'Still running', 'running', 'agent/m-archive-running');

    act(() => {
      result.current.archiveMission(missionId);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalled();
  });

  it('does NOT attempt a discard when a terminal mission has no worktree (nothing to clean up)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithStatus(result, 'Terminal, no worktree', 'failed', undefined);

    act(() => {
      result.current.archiveMission(missionId);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalled();
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.archived).toBe(true);
  });

  it('archiving an unknown mission id is a safe no-op (no crash, no discard)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    act(() => {
      result.current.archiveMission('M-does-not-exist');
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalled();
  });

  it('kills the native agent process (agent_run_kill) BEFORE the worktree discard — same Windows file-lock race fix stopMission already applies', async () => {
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
    const missionId = await addMissionWithStatus(result, 'Failed, native', 'failed', 'agent/m-archive-kill-order');

    act(() => {
      result.current.archiveMission(missionId);
    });

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1));
    expect(callOrder).toEqual(['agent_run_kill', 'discardWorktree']);
  });
});

describe('archiveMission — frees the heavy in-memory payload (memory fix)', () => {
  afterEach(() => {
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
    mockedInvoke.mockReset().mockResolvedValue(undefined);
  });

  it('drops actionTimeline/diffSnippet/judgeVerdict/compiledPlan/learningInsights while keeping their light backward-compat summaries', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    // No worktree (see addMissionWithStatus's own doc comment) — this test
    // is about the in-memory field cleanup, not worktree discard (already
    // covered by the "archiveMission — worktree cleanup" suite above); a
    // worktree here would kick off that SAME async discard chain without
    // this test ever draining it, leaking an unawaited mockedDiscardWorktree
    // call into whichever test runs next.
    const missionId = await addMissionWithStatus(result, 'Heavy mission', 'done');

    // Seed every heavy field this fix targets, plus the lighter
    // backward-compat summaries (judgesApproved/planSteps) that must survive
    // archival untouched.
    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: {
          actionTimeline: [
            { time: 't0', text: 'step 0' },
            { time: 't1', text: 'step 1' },
          ],
          diffSnippet: ['+ added line', '- removed line'],
          judgesApproved: '2/2 judges approved',
          judgeVerdict: {
            score: 0.9,
            passed: true,
            risk: 'low',
            reviewers: [{ role: 'judge', verdict: 'approve', summary: 'looks good' }],
            createdAt: new Date().toISOString(),
          },
          planSteps: [{ label: 'Step 1', state: 'done' }],
          compiledPlan: {
            graph: { stages: [], entryStageId: 'start', completionStageId: 'end' },
            createdAt: new Date().toISOString(),
            brainAdapted: false,
            adaptations: [],
          },
          learningInsights: [
            {
              id: 'li1',
              kind: 'success_pattern',
              title: 'insight',
              description: 'detail',
              actionable: false,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    });

    act(() => {
      result.current.archiveMission(missionId);
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.archived).toBe(true);
    expect(mission.actionTimeline).toEqual([]);
    expect(mission.diffSnippet).toEqual([]);
    expect(mission.judgeVerdict).toBeUndefined();
    expect(mission.compiledPlan).toBeUndefined();
    expect(mission.learningInsights).toEqual([]);
    // Light backward-compat summaries survive — a collapsed card still has
    // something to show (see Mission.judgeVerdict/compiledPlan's own doc
    // comments on why judgesApproved/planSteps are the derived summaries).
    expect(mission.judgesApproved).toBe('2/2 judges approved');
    expect(mission.planSteps).toEqual([{ label: 'Step 1', state: 'done' }]);
  });

  it('does not resurrect the heavy fields for a mission that never had any set (nothing to drop, still a safe no-op)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    // No worktree — same reasoning as the test above.
    const missionId = await addMissionWithStatus(result, 'Plain mission', 'failed');

    act(() => {
      result.current.archiveMission(missionId);
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.archived).toBe(true);
    expect(mission.actionTimeline).toEqual([]);
    expect(mission.diffSnippet).toEqual([]);
    expect(mission.judgeVerdict).toBeUndefined();
    expect(mission.compiledPlan).toBeUndefined();
    expect(mission.learningInsights).toEqual([]);
  });
});

describe('archiveTerminalMissions — "Nettoyer les terminées" bulk action funnels through archiveMission', () => {
  afterEach(() => {
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
    mockedInvoke.mockReset().mockResolvedValue(undefined);
  });

  it('reclaims the worktree of every terminal mission passed in — proving the manual bulk-clear button (CanvasToolbar\'s archiveTerminalMissions call) gets the worktree fix for free', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const failedId = await addMissionWithStatus(result, 'Bulk failed', 'failed', 'agent/bulk-failed');
    const doneId = await addMissionWithStatus(result, 'Bulk done', 'done', 'agent/bulk-done');
    const runningId = await addMissionWithStatus(result, 'Bulk running (never terminal)', 'running', 'agent/bulk-running');

    act(() => {
      result.current.archiveTerminalMissions([failedId, doneId, runningId]);
    });

    await waitFor(() => expect(mockedDiscardWorktree).toHaveBeenCalledTimes(2));

    const branches = mockedDiscardWorktree.mock.calls.map((call) => call[2]).sort();
    expect(branches).toEqual(['agent/bulk-done', 'agent/bulk-failed']);

    expect(result.current.missions.find((m) => m.id === failedId)!.archived).toBe(true);
    expect(result.current.missions.find((m) => m.id === doneId)!.archived).toBe(true);
    // Running mission: archiveTerminalMissions itself already filters it
    // out (status check before ever calling archiveMission) — never
    // archived, never a discard attempt.
    expect(result.current.missions.find((m) => m.id === runningId)!.archived).toBeFalsy();
  });
});
