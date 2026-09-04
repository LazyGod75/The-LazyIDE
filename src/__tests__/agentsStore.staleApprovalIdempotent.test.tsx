/**
 * agentsStore.staleApprovalIdempotent.test.tsx — "M5" incident regression
 * coverage (real user report, 2026-08-14).
 *
 * A mission merged cleanly through one path (a direct "Merger" click, the
 * auto-merge engine, or an earlier approve_mission call) while a SEPARATE,
 * now-stale approve_mission request for the SAME mission id — e.g. a
 * pendingApprovals entry queued earlier, or a duplicate manager retry — was
 * still in flight or got retried afterward. That second attempt reached
 * approveMission with mission.status already 'done' (genuinely NOT
 * 'review' anymore) and used to throw `canvas.manager.missionNotInReview`,
 * which the approveMission wrapper journals as `mission.approve_blocked`
 * ("merge bloqué" in the activity feed) — forever, on every further retry,
 * even though the mission's own work is already safely merged.
 *
 * Fixed in agentsStore.tsx's approveMissionInner: when the "not in review"
 * guard fires AND the mission is already terminal-successful (status
 * 'done' && merged === true), that is resolved as a genuine no-op success
 * (mirrors the OTHER two already-merged idempotent paths in the same
 * function: the empty-diff M50 shape, and the "Already up to date"
 * preMergeHeadSha shape covered by agentsStore.vacuousMerge.test.tsx) —
 * never an error.
 *
 * Uses the same harness as agentsStore.vacuousMerge.test.tsx (real
 * mergeWorktree/git.log against a controllable invoke() mock) since this
 * exercises the SAME approveMission code path, just entered with a mission
 * already past 'review'.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { ApproveBlockedError } from '../components/agents/approveGate';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import type { JudgeVerdict } from '../lib/agents/types';
import * as journal from '../lib/journal/journal';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return { ...actual, emitBuffered: vi.fn() };
});

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
  };
});

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

const REPO_PATH = 'C:\\real\\project';
const BRANCH = 'agent/m5-test';

function passingVerdict(): JudgeVerdict {
  return { score: 90, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() };
}

function mockInvokeDispatch(handlers: Record<string, (args?: Record<string, unknown>) => unknown>): void {
  vi.mocked(invoke).mockImplementation((cmd: unknown, args?: InvokeArgs) => {
    const handler = handlers[cmd as string];
    if (!handler) return cmd === 'read_dir' ? Promise.resolve([]) : Promise.resolve(undefined);
    return Promise.resolve(handler(args as Record<string, unknown> | undefined));
  });
}

async function addMissionWithPatch(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
  patch: Record<string, unknown>,
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title, repo: '.', worktree: BRANCH, modelLabel: 'claude-sonnet-5', mode: 'agent', orchestrator: false,
    });
  });
  const missionId = result.current.missions[result.current.missions.length - 1].id;
  act(() => {
    result.current.updateMission({ id: missionId, patch });
  });
  return missionId;
}

beforeEach(() => {
  localStorage.setItem('lazy.locale', 'fr');
});

afterEach(() => {
  clearTauriSimulation();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(journal.emitBuffered).mockReset();
  localStorage.removeItem('lazy.locale');
});

describe('approveMission — stale-approval idempotency (real user report, "M5" incident)', () => {
  it('a mission already done+merged resolves as a no-op success, never a "not in review" error', async () => {
    simulateTauri();
    let mergeInvoked = false;
    mockInvokeDispatch({
      agent_merge_worktree: () => { mergeInvoked = true; return 'should-never-run'; },
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithPatch(result, 'Already-merged mission (M5 repro)', {
      status: 'done',
      merged: true,
      judgeVerdict: passingVerdict(),
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    // Idempotent: still done/merged, and the real git merge command was
    // NEVER invoked — there is genuinely nothing left to do.
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mergeInvoked).toBe(false);
  });

  it('journals merge.noop_already_merged (never mission.approve_blocked) for the stale-approval no-op', async () => {
    simulateTauri();
    mockInvokeDispatch({});
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithPatch(result, 'Already-merged mission — journal check', {
      status: 'done',
      merged: true,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    expect(vi.mocked(journal.emitBuffered)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'merge.noop_already_merged', missionId }),
    );
    expect(vi.mocked(journal.emitBuffered)).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mission.approve_blocked', missionId }),
    );
  });

  it('a genuinely NOT-in-review, NOT-yet-merged mission (e.g. still queued/failed) is unaffected — still throws the original error', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithPatch(result, 'Failed mission, never merged', {
      status: 'failed',
      merged: undefined,
    });

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission(missionId, REPO_PATH);
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(ApproveBlockedError);
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('failed');
    expect(mission.merged).not.toBe(true);
  });

  it('status done but merged is NOT true (e.g. the empty-diff "closed without merge" shape) still throws — the idempotent path requires BOTH', async () => {
    simulateTauri();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionWithPatch(result, 'Done but not merged', {
      status: 'done',
      merged: false,
    });

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission(missionId, REPO_PATH);
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(ApproveBlockedError);
  });
});
