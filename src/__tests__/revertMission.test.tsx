/**
 * revertMission.test.tsx
 *
 * Coverage for T1.7 "one-click mission revert" (spec §8: "Revert mission" —
 * if unmerged: drop the worktree; if merged: `git revert` the merge commit,
 * delete produced artifacts, emit `mission.reverted`; one click, always
 * visible on Done missions).
 *
 *   - Merged mission (approveMission already captured a mergeSha, see
 *     agentsStore.tsx's approveMission/git.rs's agent_merge_worktree):
 *     revertMission calls gitRevertMerge with that sha, best-effort deletes
 *     the mission's proof-artifact directory, flags reverted:true (status
 *     stays 'done' — MissionStatus has no 'reverted' value), and emits
 *     mission.reverted.
 *   - Unmerged mission (never approved, or failed with a live worktree):
 *     revertMission routes straight into discardMission's existing flow
 *     (drop the worktree, status -> 'cancelled') — no separate code path.
 *   - A merged/done mission missing a recorded mergeSha (approved before
 *     this shipped, or in web/mock mode where no real merge ever produced a
 *     sha) throws a clear, user-facing error instead of crashing or
 *     silently no-op'ing.
 *
 * Mocking follows agentsStore.mergeHonesty.test.tsx's own harness pattern
 * (importOriginal + controllable spies for the Tauri-backed calls).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore, type RevertableMission } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { mergeWorktree, discardWorktree } from '../lib/agents/runtime';
import { gitRevertMerge } from '../lib/platform/tauri';
import { emitEvent } from '../lib/journal/journal';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

// Mock the runtime so runMission doesn't try to invoke Tauri, but keep
// mergeWorktree/discardWorktree as controllable spies — same pattern as
// agentsStore.mergeHonesty.test.tsx.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

// gitRevertMerge (tauri.ts, additive T1.7 wrapper) as a controllable spy.
vi.mock('../lib/platform/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform/tauri')>();
  return {
    ...actual,
    gitRevertMerge: vi.fn(),
  };
});

// platform.fs.remove (artifact-directory cleanup) as a controllable spy —
// everything else on the real platform (web or native, whichever isTauri()
// resolves to in this test) stays untouched.
const mockFsRemove = vi.fn();
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => {
      const real = actual.getPlatform();
      return { ...real, fs: { ...real.fs, remove: mockFsRemove } };
    },
  };
});

// Journal emission as spies so this suite can assert directly on
// mission.reverted rather than relying on journal.ts's own fail-safe
// swallow-and-warn behavior (see journal.ts's header comment).
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return {
    ...actual,
    emitEvent: vi.fn().mockResolvedValue(undefined),
    emitBuffered: vi.fn(),
  };
});

const mockedMergeWorktree = vi.mocked(mergeWorktree);
const mockedDiscardWorktree = vi.mocked(discardWorktree);
const mockedGitRevertMerge = vi.mocked(gitRevertMerge);
const mockedEmitEvent = vi.mocked(emitEvent);

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
 *  and a worktree — the state approveMission/discardMission require (mirrors
 *  agentsStore.mergeHonesty.test.tsx's own addReviewMission helper). */
async function addReviewMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
  branch: string,
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: branch,
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

/**
 * Approves a review mission with mergeWorktree resolving `mergeSha`,
 * producing a mission with status:'done', merged:true, mergeSha:<sha> — the
 * exact state revertMission's merged path needs. Exercises the REAL
 * approveMission mergeSha-capture path (T1.7) rather than hand-constructing
 * the mission shape.
 */
async function addApprovedMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
  branch: string,
  repoPath: string,
  mergeSha: string | undefined,
): Promise<string> {
  const missionId = await addReviewMission(result, title, branch);
  // mergeWorktree's real (corrected) return type is Promise<string> — the
  // Rust side always resolves a real sha or rejects (see runtime.ts's
  // mergeWorktree doc comment). Forcing `undefined` here deliberately
  // exercises approveMission's defensive `typeof mergeOutcome === 'string'`
  // narrowing against an unexpected/degenerate resolution (mock drift, or a
  // pre-T1.7 caller), the same case a stale IPC contract could produce.
  mockedMergeWorktree.mockResolvedValueOnce(mergeSha as string);
  await act(async () => {
    await result.current.approveMission(missionId, repoPath);
  });
  return missionId;
}

describe('revertMission — merged mission (git revert path)', () => {
  afterEach(() => {
    clearTauriSimulation();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
    mockedGitRevertMerge.mockReset();
    mockFsRemove.mockReset().mockResolvedValue(undefined);
    mockedEmitEvent.mockReset().mockResolvedValue(undefined);
  });

  it('calls gitRevertMerge with the recorded merge sha, deletes the artifact directory, flags reverted:true, and emits mission.reverted', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const repoPath = 'C:\\real\\project';
    const missionId = await addApprovedMission(
      result,
      'Merged mission',
      'agent/m-revert',
      repoPath,
      'deadbeef00000000000000000000000000000001',
    );

    // Sanity: approveMission really captured the sha additively.
    const approved = result.current.missions.find((m) => m.id === missionId) as RevertableMission;
    expect(approved.mergeSha).toBe('deadbeef00000000000000000000000000000001');
    expect(approved.status).toBe('done');
    expect(approved.merged).toBe(true);

    mockedGitRevertMerge.mockResolvedValueOnce('feedface00000000000000000000000000000002');

    await act(async () => {
      await result.current.revertMission(missionId, repoPath);
    });

    expect(mockedGitRevertMerge).toHaveBeenCalledTimes(1);
    expect(mockedGitRevertMerge).toHaveBeenCalledWith(repoPath, 'deadbeef00000000000000000000000000000001');

    expect(mockFsRemove).toHaveBeenCalledTimes(1);
    const removedPath = mockFsRemove.mock.calls[0][0] as string;
    expect(removedPath).toContain('.lazy');
    expect(removedPath).toContain('artifacts');
    expect(removedPath).toContain(missionId);

    const mission = result.current.missions.find((m) => m.id === missionId) as RevertableMission;
    // status stays 'done' — reverted is an additive flag, not a new status
    // (MissionStatus has no 'reverted' value; mirrors the existing `paused`
    // flag-not-a-status convention already in this codebase).
    expect(mission.status).toBe('done');
    expect(mission.reverted).toBe(true);

    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.reverted', missionId, payload: { merged: true } }),
    );
  });

  it('a failed artifact-directory deletion does not prevent the revert from succeeding (best-effort cleanup)', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const repoPath = 'C:\\real\\project';
    const missionId = await addApprovedMission(
      result,
      'Merged mission, cleanup fails',
      'agent/m-revert-cleanup-fails',
      repoPath,
      'aaaaaaaa00000000000000000000000000000003',
    );

    mockedGitRevertMerge.mockResolvedValueOnce('bbbbbbbb00000000000000000000000000000004');
    mockFsRemove.mockRejectedValueOnce(new Error('locked file'));

    await act(async () => {
      await result.current.revertMission(missionId, repoPath);
    });

    const mission = result.current.missions.find((m) => m.id === missionId) as RevertableMission;
    expect(mission.reverted).toBe(true);
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.reverted', missionId }),
    );
  });

  it('missing mergeSha on a merged/done mission throws a clear error instead of crashing', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const repoPath = 'C:\\real\\project';
    // mergeWorktree resolving undefined (web/mock-mode style, or a pre-T1.7
    // approval) never captures a mergeSha — see approveMission's own
    // defensive narrowing.
    const missionId = await addApprovedMission(
      result,
      'Merged, no sha recorded',
      'agent/m-no-sha',
      repoPath,
      undefined,
    );

    const approved = result.current.missions.find((m) => m.id === missionId) as RevertableMission;
    expect(approved.status).toBe('done');
    expect(approved.merged).toBe(true);
    expect(approved.mergeSha).toBeUndefined();

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.revertMission(missionId, repoPath);
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as Error).message.length).toBeGreaterThan(0);
    expect(mockedGitRevertMerge).not.toHaveBeenCalled();
    expect(mockFsRemove).not.toHaveBeenCalled();

    // No crash, no silent mutation — status/reverted left exactly as before.
    const mission = result.current.missions.find((m) => m.id === missionId) as RevertableMission;
    expect(mission.status).toBe('done');
    expect(mission.reverted).not.toBe(true);
  });
});

describe('revertMission — unmerged mission (routes to discardMission)', () => {
  afterEach(() => {
    clearTauriSimulation();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    mockedDiscardWorktree.mockReset().mockResolvedValue(undefined);
    mockedGitRevertMerge.mockReset();
    mockFsRemove.mockReset().mockResolvedValue(undefined);
  });

  it('a mission still in review (never merged) is dropped via the same discardWorktree path as Reject', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const repoPath = 'C:\\real\\project';
    const missionId = await addReviewMission(result, 'Unmerged mission', 'agent/m-unmerged');

    await act(async () => {
      await result.current.revertMission(missionId, repoPath);
    });

    expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1);
    expect(mockedGitRevertMerge).not.toHaveBeenCalled();
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('cancelled');
  });

  it('a failed mission with a live worktree also routes to discardMission', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const repoPath = 'C:\\real\\project';
    const missionId = await addReviewMission(result, 'Failed mission with worktree', 'agent/m-failed-revert');
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'failed' } });
    });

    await act(async () => {
      await result.current.revertMission(missionId, repoPath);
    });

    expect(mockedDiscardWorktree).toHaveBeenCalledTimes(1);
    expect(mockedGitRevertMerge).not.toHaveBeenCalled();
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('cancelled');
  });

  it('a nonexistent mission id is a safe no-op (no throw)', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.revertMission('does-not-exist', 'C:\\real\\project');
    });

    expect(mockedDiscardWorktree).not.toHaveBeenCalled();
    expect(mockedGitRevertMerge).not.toHaveBeenCalled();
  });
});
