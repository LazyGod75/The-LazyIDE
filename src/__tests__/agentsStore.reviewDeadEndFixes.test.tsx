/**
 * agentsStore.reviewDeadEndFixes.test.tsx — regression coverage for three
 * founder-filed bugs found in the same live QA session (mission M50, a
 * "merge branch agent/M1 into the main branch" mission whose agent
 * performed that merge itself during its own run):
 *
 *   A: approveMissionInner threw "Fusion forcée refusée : aucune
 *      modification à fusionner" on a mission whose worktree diff was
 *      empty BECAUSE its own work was already applied (not because nothing
 *      happened) — the review stayed open forever, no legitimate exit. Now
 *      resolves as a genuine done-without-merge terminal success instead,
 *      UNLESS the judge explicitly rejected the mission (M10's own
 *      fabricated-proof shape, still refused — see
 *      agentsStore.vacuousMerge.test.tsx).
 *   B: rejecting a review with no real feedback used to unconditionally
 *      fold into retryMission, producing a byte-identical clone of the
 *      just-rejected mission. Rejection now means abandon (discardMission
 *      — status 'cancelled', no clone) when there is nothing constructive
 *      to act on; rejection WITH real feedback keeps its existing, tested
 *      relaunch-with-feedback behavior (managerGroundedActions.test.tsx).
 *   C: the manager's launch_draft executor swallowed a resolution failure
 *      as a mere toast + `break` (no throw) — indistinguishable from
 *      success to both callers of executeManagerAction, so a stale draftId
 *      silently dropped the approved action (no mission, no visible
 *      error). Failures now always throw (a visible "Résultat réel"/
 *      actionFailed chat message, same convention as the approve_mission
 *      fix above it), and the lookup falls back to draftAlias even when a
 *      (stale) draftId was given but no longer resolves.
 *
 * Harness mirrors agentsStore.vacuousMerge.test.tsx (Bug A — real
 * mergeWorktree/worktreeDiff against a controllable invoke() mock) and
 * managerGroundedActions.test.tsx / managerCanvasActions.test.tsx (Bugs B/C
 * — the real executeManagerAction dispatch via sendManagerMessage with
 * runManagerTurn mocked per-call).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';
import React from 'react';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { ApproveBlockedError } from '../components/agents/approveGate';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import type { JudgeVerdict } from '../lib/agents/types';
import * as journal from '../lib/journal/journal';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

// Bug A needs the REAL mergeWorktree/worktreeDiff (they must exercise their
// real invoke('agent_merge_worktree'/'agent_worktree_diff') calls against
// the controllable invoke() mock below) — only runMission is stubbed, same
// boundary agentsStore.vacuousMerge.test.tsx already uses. Bugs B/C never
// reach a real merge/discard call in web/mock mode (isTauri() stays false),
// but discardWorktree is still stubbed so Bug B's discardMission call never
// depends on real IPC.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
}));

// Spies on the real journal module (keeps every other export real) so Bug
// A's merge.noop_already_merged emission is directly assertable — same
// convention as agentsStore.vacuousMerge.test.tsx.
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return { ...actual, emitBuffered: vi.fn() };
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
const BRANCH = 'agent/m50';

function passingVerdict(): JudgeVerdict {
  return { score: 90, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() };
}

/** Adds a mission and drives it into 'review' — mirrors
 *  agentsStore.vacuousMerge.test.tsx's own helper of the same shape. */
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
      patch: { status: 'review', ...patch },
    });
  });
  return missionId;
}

/** Seeds a plain mission (no worktree by default) for the reject-flow
 *  tests — mirrors managerGroundedActions.test.tsx's own seedMission. */
async function seedMission(
  result: { current: ReturnType<typeof useAgentsStore> },
  patch: Record<string, unknown> = {},
): Promise<string> {
  let id = '';
  await act(async () => {
    id = await result.current.addMission({
      title: 'Seeded mission',
      agentTask: 'merge branch agent/M1 into the main branch',
      repo: '.',
      worktree: '',
      modelLabel: 'sonnet',
      orchestrator: false,
    });
  });
  if (Object.keys(patch).length > 0) {
    await act(async () => {
      result.current.updateMission({ id, patch: patch as never });
    });
  }
  return id;
}

function mockInvokeDispatch(handlers: Record<string, (args?: Record<string, unknown>) => unknown>): void {
  vi.mocked(invoke).mockImplementation((cmd: unknown, args?: InvokeArgs) => {
    const handler = handlers[cmd as string];
    if (!handler) return Promise.resolve(undefined);
    return Promise.resolve(handler(args as Record<string, unknown> | undefined));
  });
}

async function dispatch(
  sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>,
  conversationId: string,
  actions: unknown[],
) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  localStorage.setItem('lazy.locale', 'fr');
  vi.mocked(runManagerTurn).mockReset();
});

afterEach(() => {
  clearTauriSimulation();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(journal.emitBuffered).mockReset();
  localStorage.removeItem('lazy.locale');
});

// ── Bug A — review dead-end on an already-applied mission ──────────────

describe('approveMission — empty-diff review dead-end fix (founder repro M50)', () => {
  it('force approve, no judge verdict (git-ops-only mission), confirmed-empty real diff -> resolves DONE-WITHOUT-MERGE, never attempts a real merge', async () => {
    simulateTauri();
    let mergeInvoked = false;
    mockInvokeDispatch({
      // WORKTREE-DESTROYED-PRE-MERGE guard (agentsStore.tsx, ahead of the
      // code under test here) probes the worktree via a real `read_dir` —
      // must resolve a non-empty entry list or that earlier guard throws
      // its OWN "worktree missing" error before this test's own empty-diff
      // path ever runs.
      read_dir: () => [{ name: 'x', path: 'x', kind: 'file' }],
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => '',
      agent_merge_worktree: () => {
        mergeInvoked = true;
        return 'sha-B';
      },
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    // M50's real shape: never judged (a pure git-ops mission), diff fields
    // absent/empty.
    const missionId = await addReviewMission(result, 'merge branch agent/M1 into the main branch', {
      judgeVerdict: undefined,
      diffAdded: undefined,
      diffRemoved: undefined,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH, { force: true });
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
    expect(mergeInvoked).toBe(false);
  });

  it('normal (non-force) approve, passing judge verdict, confirmed-empty real diff -> also resolves DONE-WITHOUT-MERGE (no dead end without force either)', async () => {
    simulateTauri();
    mockInvokeDispatch({
      read_dir: () => [{ name: 'x', path: 'x', kind: 'file' }],
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => '',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'merge branch agent/M1 into the main branch', {
      judgeVerdict: passingVerdict(),
      diffAdded: undefined,
      diffRemoved: undefined,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('done');
    expect(mission.merged).toBe(true);
  });

  it('journals merge.noop_already_merged (the same success emission a real "already merged" no-op uses) — chain/wakeup consumers key off this, never a silent close', async () => {
    simulateTauri();
    mockInvokeDispatch({
      read_dir: () => [{ name: 'x', path: 'x', kind: 'file' }],
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => '',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'merge branch agent/M1 into the main branch', {
      judgeVerdict: passingVerdict(),
      diffAdded: undefined,
      diffRemoved: undefined,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    expect(vi.mocked(journal.emitBuffered)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'merge.noop_already_merged', missionId }),
    );
  });

  it('shows the honest "closed without merge" digest, not a generic success message', async () => {
    simulateTauri();
    mockInvokeDispatch({
      read_dir: () => [{ name: 'x', path: 'x', kind: 'file' }],
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => '',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addReviewMission(result, 'merge branch agent/M1 into the main branch', {
      judgeVerdict: passingVerdict(),
      diffAdded: undefined,
      diffRemoved: undefined,
    });

    await act(async () => {
      await result.current.approveMission(missionId, REPO_PATH);
    });

    expect(
      screen.getByText('Mission close sans fusion — son effet est déjà appliqué (aucune modification restante)'),
    ).toBeInTheDocument();
  });

  it('force approve + EXPLICITLY REJECTED judge verdict + confirmed-empty diff -> still refused (M10 fabricated-proof shape unaffected)', async () => {
    simulateTauri();
    let mergeInvoked = false;
    mockInvokeDispatch({
      read_dir: () => [{ name: 'x', path: 'x', kind: 'file' }],
      git_log: () => [{ hash: 'sha-A', subject: 'x', author: 'y', date: 'now' }],
      agent_worktree_diff: () => '',
      agent_merge_worktree: () => {
        mergeInvoked = true;
        return 'sha-B';
      },
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const rejectedVerdict: JudgeVerdict = { score: 0, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString() };
    const missionId = await addReviewMission(result, 'Fabricated-proof mission (M10 repro)', {
      judgeVerdict: rejectedVerdict,
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
    expect(mergeInvoked).toBe(false);
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('review');
    expect(mission.merged).not.toBe(true);
  });
});

// ── Bug B — rejection must not auto-clone ───────────────────────────────

describe('reject_mission — no auto-retry clone on a bare rejection (founder repro M50 -> M51)', () => {
  it('rejecting with NO feedback abandons the mission (status cancelled) and creates NO clone', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'review', worktree: 'agent/wt-m50' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'reject_mission', missionId },
    ]);

    // No clone: the mission count never grows.
    expect(result.current.missions.length).toBe(missionsBefore);
    const mission = result.current.missions.find((m) => m.id === missionId)!;
    expect(mission.status).toBe('cancelled');
    // A cancelled mission can never match the boot-resilience auto-retry
    // effect's own eligibility filter (status === 'failed' only) — this
    // lineage cannot come back on its own; only a genuinely
    // restart-interrupted mission can (bootAutoRetry.test.tsx covers that
    // path, untouched by this fix).
    expect(mission.status).not.toBe('failed');
  });

  it('rejecting with real feedback keeps the existing relaunch-with-feedback behavior unchanged (a deliberate correction, not a blind retry)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await seedMission(result, { status: 'review', worktree: 'agent/wt-1' });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'reject_mission', missionId, feedback: 'wrong branch — target release/1.2 instead' },
    ]);

    expect(result.current.missions.length).toBe(missionsBefore + 1);
    const clone = result.current.missions[result.current.missions.length - 1];
    expect(clone.status).toBe('queued');
    expect(clone.agentTask).toContain('wrong branch — target release/1.2 instead');
    // The ORIGINAL mission is untouched by the clone path (unlike the
    // no-feedback path above, which cancels it) — same as before this fix.
    const original = result.current.missions.find((m) => m.id === missionId)!;
    expect(original.status).toBe('review');
  });
});

// ── Bug C — silent launch_draft executor ────────────────────────────────

describe('launch_draft executor — loud failure + resilient lookup (founder repro)', () => {
  it('unknown draftId (no alias to fall back on) -> visible actionFailed chat message, no mission created', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_draft', draftId: 'draft-step-3c407626-stale' },
    ]);

    expect(result.current.missions.length).toBe(missionsBefore);
    // LOUD, not silent: a real manager-chat message names the honest
    // reason (never just a toast that can be missed/dismissed — see
    // approve_mission's identical precedent, and
    // managerGroundedActions.test.tsx's own "action dispatch failures
    // surface honestly" tests for the same assertion convention).
    const failureMsg = result.current.managerMessages.find(
      (m) => m.role === 'assistant' && m.content.includes('Brouillon introuvable'),
    );
    expect(failureMsg).toBeDefined();
    expect(failureMsg?.content).toContain('renommé au rechargement');
  });

  it('stale draftId but a resolvable draftAlias from the SAME reply -> falls back and launches for real', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'create_draft', alias: 'a', task: 'merge branch agent/M1 into the main branch', title: 'Resilient launch' },
      // draftId intentionally stale/unresolvable (as if captured before a
      // reload re-homed the plan node) — draftAlias still points at the
      // real draft this SAME reply just created.
      { type: 'launch_draft', draftId: 'draft-step-stale-from-before-reload', draftAlias: 'a' },
    ]);

    expect(result.current.missions.length).toBe(missionsBefore + 1);
    expect(result.current.missions.some((m) => m.title === 'Resilient launch')).toBe(true);
    expect(canvasStoreVanilla.getState().drafts).toHaveLength(0);
  });

  it('draft belonging to an inactive project still surfaces its own specific honest reason (not the generic "not found" text) — now loud instead of a silent toast', async () => {
    canvasStoreVanilla.getState().addDraft({
      id: 'draft-cross',
      title: 'Cross project',
      task: 'do the thing',
      createdBy: 'user',
      projectId: 'some-other-project-id',
    });
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'launch_draft', draftId: 'draft-cross' },
    ]);

    expect(result.current.missions.length).toBe(missionsBefore);
    // Still there — never silently launched into the wrong project.
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === 'draft-cross')).toBe(true);
  });
});
