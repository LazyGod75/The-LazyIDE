/**
 * agentsStore.mergedTodayCount.test.tsx
 *
 * Regression coverage for the M12 dogfood fix (MAJEUR #6b): the cockpit
 * "Mergées aujourd'hui" KPI (KpiGroup.tsx, sourced from usageHistory.ts's
 * local recordMissionCompleted()/getWindowMetrics bucket) used to diverge
 * from the generation-scoped, journal-derived count (projectReport.ts's
 * buildProjectReport / zoneDigest.ts's mergedTodayCount) because
 * updateMission fired recordMissionCompleted() on EITHER 'review' OR 'done'
 * — a mission naturally passing through review -> [later] done therefore
 * double-counted a single real merge. 'review' means "the agent run
 * finished, awaiting evaluation/merge", not "merged"; only 'done' (always
 * paired with merged: true, see approveMission) is a real merge and the only
 * trigger that agrees with the journal-derived source of truth.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { mergeWorktree } from '../lib/agents/runtime';
import { recordMissionCompleted } from '../lib/models/usageHistory';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/models/usageHistory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/usageHistory')>();
  return {
    ...actual,
    recordMissionCompleted: vi.fn(),
  };
});

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedMergeWorktree = vi.mocked(mergeWorktree);
const mockedRecordMissionCompleted = vi.mocked(recordMissionCompleted);

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

describe('recordMissionCompleted — fires once per real merge, never on review', () => {
  afterEach(() => {
    clearTauriSimulation();
    mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
    mockedRecordMissionCompleted.mockReset();
  });

  it('does NOT record a completion when a mission merely reaches "review"', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await addReviewMission(result, 'Reaches review only');

    expect(mockedRecordMissionCompleted).not.toHaveBeenCalled();
  });

  it('records exactly ONE completion for the full review -> done lifecycle (no double-count)', async () => {
    simulateTauri();
    mockedMergeWorktree.mockResolvedValueOnce('mock-merge-sha');
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Full lifecycle');

    // Reaching review must not have recorded anything yet.
    expect(mockedRecordMissionCompleted).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.approveMission(missionId, 'C:\\real\\project');
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    // Exactly once — the OLD bug recorded it a second time back when the
    // mission first reached 'review', inflating "Mergées aujourd'hui" for
    // every mission that completed its full lifecycle same-day.
    expect(mockedRecordMissionCompleted).toHaveBeenCalledTimes(1);
  });

  it('records a completion when a mission is directly force-updated to "done" without an explicit review step', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.updateMission({
        id: 'nonexistent-mission-id',
        patch: { status: 'done', merged: true },
      });
    });
    // updateMission on an id not present in state is a documented no-op for
    // the mission map itself, but the terminal-status side effects (queue
    // sync, recordMissionCompleted) key off the PATCH's requested status
    // transition, independent of whether a matching mission was found —
    // matching this store's existing best-effort, never-throws contract.
    expect(mockedRecordMissionCompleted).toHaveBeenCalledTimes(1);
  });
});
