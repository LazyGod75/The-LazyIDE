/**
 * agentsStore.mergeConflictHonesty.test.tsx
 *
 * Regression coverage for the severe real-user QA bug: clicking "Merger" on
 * a mission's signal card could start a real `git merge <agent-branch>` in
 * the PROJECT'S OWN working tree (not an isolated copy) and, on a conflict,
 * leave it there — MERGE_HEAD, conflict markers, staged files — with ZERO
 * UI feedback (the card looked untouched). git.rs's agent_merge_worktree_inner
 * now always runs `git merge --abort` before returning on a real conflict
 * (see that file's own doc comment) and tags the error "MERGE_CONFLICT: ..."
 * so agentsStore.tsx's approveMission can classify it here — this suite
 * proves the JS-side half of that contract: a conflict throws a
 * MergeConflictError (never a generic Error, never a fabricated success),
 * journals `merge.conflicted`, and leaves the mission in 'review' (never
 * merged) — same mocked-git-layer pattern as agentsStore.mergeHonesty.test.tsx.
 *
 * Also covers the companion honesty fix in the SAME wave: an "Already up to
 * date" result (mergeSha === preMergeHeadSha) now resolves as an honest
 * no-op SUCCESS instead of the old blanket "Rien à merger" error — see
 * agentsStore.vacuousMerge.test.tsx's updated test for the sha-comparison
 * half of that fix (this suite only re-confirms the journal side of it).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { MergeConflictError } from '../components/agents/approveGate';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { mergeWorktree, discardWorktree } from '../lib/agents/runtime';
import * as journal from '../lib/journal/journal';

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

// Spy on the real journal module (keeps emitEvent/serializeEvent etc. real —
// only emitBuffered is intercepted) so this suite can assert the honest
// merge.conflicted / merge.noop_already_merged events fire with the right
// shape, without reaching for the raw Tauri invoke() boundary.
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return { ...actual, emitBuffered: vi.fn() };
});

const mockedMergeWorktree = vi.mocked(mergeWorktree);
const mockedEmitBuffered = vi.mocked(journal.emitBuffered);

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
        judgeVerdict: { score: 90, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() },
      },
    });
  });
  return missionId;
}

describe('approveMission — merge CONFLICT honesty', () => {
  afterEach(() => {
    clearTauriSimulation();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    vi.mocked(discardWorktree).mockReset().mockResolvedValue(undefined);
    mockedEmitBuffered.mockReset();
  });

  it('a MERGE_CONFLICT-tagged rejection throws MergeConflictError (never a generic Error), mission stays review, never merged', async () => {
    simulateTauri();
    mockedMergeWorktree.mockRejectedValueOnce(
      new Error('MERGE_CONFLICT: CONFLICT (content): Merge conflict in agentsStore.tsx'),
    );
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Conflict mission');

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission(missionId, 'C:\\real\\project');
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(MergeConflictError);
    expect((caughtErr as MergeConflictError).message).toContain('CONFLICT (content)');
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.merged).not.toBe(true);
  });

  it('journals merge.conflicted (never a silent path) on a real conflict', async () => {
    simulateTauri();
    mockedMergeWorktree.mockRejectedValueOnce(new Error('MERGE_CONFLICT: Automatic merge failed'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Conflict mission — journal check');

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project').catch(() => {});
    });

    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'merge.conflicted', missionId }),
    );
  });

  it('a plain (non-conflict) merge rejection still propagates as a generic Error — only a MERGE_CONFLICT-tagged failure gets the honest conflict treatment', async () => {
    simulateTauri();
    mockedMergeWorktree.mockRejectedValueOnce(new Error('agent_merge_worktree: git merge failed: no such branch'));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Non-conflict failure mission');

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission(missionId, 'C:\\real\\project');
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).not.toBeInstanceOf(MergeConflictError);
    expect(caughtErr).toBeInstanceOf(Error);
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
  });
});
