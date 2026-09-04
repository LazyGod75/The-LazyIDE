/**
 * agentsStore.vacuousMerge.test.tsx — QA B10 regression coverage.
 *
 * "Force-merge false success": mission M10 (0 diff, judges 0/3, fabricated
 * proof) force-merged in the real app — the UI showed success, the card
 * moved to Mergé, the KPI incremented, but git created NO commit. Two
 * independent gaps compounded:
 *
 *   1. `git merge --no-ff` still exits 0 ("Already up to date") when there
 *      is nothing new to merge, and agent_merge_worktree_inner (Rust)
 *      returns the CURRENT (unchanged) HEAD sha on that path — a real merge
 *      commit and a no-op "success" are indistinguishable from the resolved
 *      value alone. Fixed in approveMission (agentsStore.tsx) by capturing
 *      the repo's HEAD sha via the real git plumbing (platform.git.log)
 *      BEFORE the merge and comparing it against whatever mergeWorktree
 *      reports afterward.
 *   2. checkApproveGate's `force === true` branch bypasses the judge/proof
 *      gates unconditionally (that's what "force" means) but never checked
 *      whether there was anything to merge in the first place. Fixed by
 *      blocking the force path when the mission's own diff fields AND the
 *      REAL worktree git diff both confirm there's nothing to merge.
 *
 * Unlike agentsStore.mergeHonesty.test.tsx (which mocks runtime.ts's
 * mergeWorktree/discardWorktree as controllable spies), this suite keeps
 * mergeWorktree/worktreeDiff REAL and instead controls the underlying
 * `@tauri-apps/api/core` invoke() directly (same boundary
 * runtimeEvalDiff.test.ts uses) — the pre/post HEAD-sha comparison this
 * suite is regression-testing lives partly in runtime.ts's real
 * mergeWorktree/worktreeDiff and partly in platform/tauri.ts's real
 * git.log, so mocking those away would test nothing.
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

// Spies on the real journal module (keeps every other export, e.g.
// emitEvent, real) so the already-merged honesty fix's journal side
// (merge.noop_already_merged) is directly assertable.
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return { ...actual, emitBuffered: vi.fn() };
});

// Only runMission is stubbed (never actually launches an agent for these
// tests) — mergeWorktree/worktreeDiff stay the REAL implementations, so
// they exercise their real invoke('agent_merge_worktree'/'agent_worktree_diff')
// calls against the controllable invoke() mock below.
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
const BRANCH = 'agent/m-test';

function passingVerdict(): JudgeVerdict {
  return { score: 90, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() };
}

function rejectedVerdict(): JudgeVerdict {
  return { score: 0, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString() };
}

/** Adds a mission and drives it into 'review' with a given judge verdict +
 *  diff-stat fields — mirrors agentsStore.mergeHonesty.test.tsx's helper. */
async function addReviewMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  title: string,
  patch: Record<string, unknown> = {},
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: BRANCH,
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
        judgeVerdict: passingVerdict(),
        ...patch,
      },
    });
  });
  return missionId;
}

/** Wires a per-command dispatch table onto the shared invoke() mock;
 *  unregistered commands resolve the same defaults as the untouched global
 *  stub in src/__tests__/setup.ts (`read_dir` -> `[]` so the Tauri
 *  fs.readDir .map() never throws and agentsStore.tsx's worktree existence
 *  probe reads the virtual worktree as present; everything else ->
 *  `undefined`). */
function mockInvokeDispatch(handlers: Record<string, (args?: Record<string, unknown>) => unknown>): void {
  vi.mocked(invoke).mockImplementation((cmd: unknown, args?: InvokeArgs) => {
    const handler = handlers[cmd as string];
    if (!handler) return cmd === 'read_dir' ? Promise.resolve([]) : Promise.resolve(undefined);
    return Promise.resolve(handler(args as Record<string, unknown> | undefined));
  });
}

beforeEach(() => {
  // Deterministic French assertions below regardless of jsdom's
  // navigator.language default (mirrors cockpitKpiBar.test.tsx's explicit
  // locale pin for the same reason).
  localStorage.setItem('lazy.locale', 'fr');
});

afterEach(() => {
  clearTauriSimulation();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(journal.emitBuffered).mockReset();
  localStorage.removeItem('lazy.locale');
});

describe('approveMission — vacuous-merge honesty (QA B10)', () => {
  it('git merge "Already up to date" (post-merge sha === pre-merge HEAD) -> honest ALREADY-MERGED success (QA: M39/M40 fix) — never the old "Rien à merger" error', async () => {
    // BUG FIX (real-user QA, tonight): the OLD behavior below (always an
    // error on a same-sha merge, no matter what) treated a genuinely
    // already-merged mission (its work IS already in the target branch —
    // e.g. a duplicate "Merger" click, or it was merged by an earlier call)
    // exactly the same as a truly fabricated/empty merge (M10's case) —
    // that OTHER case is now caught earlier, before the merge is even
    // attempted, by the force-empty-diff gate below (checkApproveGate +
    // isDiffEmpty). By the time this comparison runs at all, an unchanged
    // HEAD can only honestly mean "already merged" — so it now resolves
    // like a real success (status done, merged true) and journals
    // merge.noop_already_merged instead of throwing.
    simulateTauri();
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      // Rust returns the CURRENT (unchanged) HEAD sha on a vacuous merge.
      agent_merge_worktree: () => 'sha-A',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Already-merged mission');

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });

  it('journals merge.noop_already_merged (never silent) on the already-merged honest no-op', async () => {
    simulateTauri();
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_merge_worktree: () => 'sha-A',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Already-merged mission — journal check');

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    expect(vi.mocked(journal.emitBuffered)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'merge.noop_already_merged', missionId }),
    );
  });

  it('a real merge (post-merge sha differs from pre-merge HEAD) -> marks done/merged as before', async () => {
    simulateTauri();
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_merge_worktree: () => 'sha-B',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Real merge mission');

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });

  it('mergeWorktree resolves no sha at all while the pre-merge HEAD sha IS known -> treated as vacuous too', async () => {
    simulateTauri();
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_merge_worktree: () => '',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'No-sha mission');

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH).catch(() => {});
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.merged).not.toBe(true);
  });

  it('pre-merge HEAD sha unreadable (git_log fails, e.g. a brand-new repo) -> never false-blocks a real merge', async () => {
    simulateTauri();
    mockInvokeDispatch({
      git_log: () => { throw new Error('fatal: your current branch does not have any commits yet'); },
      agent_merge_worktree: () => 'sha-B',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Unknown pre-sha mission');

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });
});

describe('approveMission — force-merge empty-diff gate (QA B10, M10 repro)', () => {
  it('force=true + mission diff fields empty/fabricated + REAL worktree diff also empty -> blocked, merge never attempted', async () => {
    simulateTauri();
    let mergeInvoked = false;
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => '',
      agent_merge_worktree: () => {
        mergeInvoked = true;
        return 'sha-B';
      },
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    // M10's exact shape: judges 0/3 (rejected verdict), no diff.
    const missionId = await addReviewMission(result, 'Fabricated-proof mission (M10 repro)', {
      judgeVerdict: rejectedVerdict(),
      diffAdded: undefined,
      diffRemoved: undefined,
    });

    let caughtErr: unknown;
    await act(async () => {
      try {
        await result.current.approveMission(missionId, REPO_PATH, { force: true });
      } catch (err) {
        caughtErr = err;
      }
    });

    expect(caughtErr).toBeInstanceOf(ApproveBlockedError);
    expect((caughtErr as ApproveBlockedError).reason).toMatch(/[Aa]ucune modification/);
    expect(mergeInvoked).toBe(false);
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.merged).not.toBe(true);
  });

  it('force=true + mission diff fields empty but the REAL worktree diff is non-empty -> allowed (mission fields alone never block)', async () => {
    simulateTauri();
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => 'diff --git a/x.ts b/x.ts\n+real change\n',
      agent_merge_worktree: () => 'sha-B',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Understated mission fields', {
      diffAdded: undefined,
      diffRemoved: undefined,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH, { force: true });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
  });

  it('force=true + mission diff fields already non-empty -> the real-diff check is skipped entirely (no agent_worktree_diff call)', async () => {
    simulateTauri();
    let worktreeDiffInvoked = false;
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => {
        worktreeDiffInvoked = true;
        return '';
      },
      agent_merge_worktree: () => 'sha-B',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Real diff present', {
      judgeVerdict: rejectedVerdict(),
      diffAdded: 12,
      diffRemoved: 3,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH, { force: true });
    });

    expect(worktreeDiffInvoked).toBe(false);
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
  });

  it('force=true + real-diff read fails (unknown, not proven empty) -> does not block, falls through to the merge attempt', async () => {
    simulateTauri();
    mockInvokeDispatch({
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => {
        throw new Error('worktree unreadable');
      },
      agent_merge_worktree: () => 'sha-B',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'Unreadable worktree diff', {
      diffAdded: undefined,
      diffRemoved: undefined,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH, { force: true });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
  });
});
