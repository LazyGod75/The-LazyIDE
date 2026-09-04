/**
 * Tests for the gate-usability fix (2026-07-28):
 * - the REAL autonomy mode selected via setAutonomyLevel reaches
 *   evaluateActionGate — previously getEffectiveAutonomy() was called with
 *   no config at the dispatch site, which silently defaulted to
 *   DEFAULT_AUTONOMY.mode ('supervised') no matter what the selector
 *   showed. Verified here across all four modes.
 * - a gate-deferred ('ask') action is queued as a pending approval instead
 *   of being discarded with no recourse, and approvePendingAction /
 *   rejectPendingAction resolve it for real.
 *
 * actionGate is intentionally NOT mocked here (unlike managerCanvasActions.
 * test.tsx and siblings) — the whole point of this file is to exercise the
 * REAL gate wired to REAL autonomy state, not a stubbed 'allow'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import type { AutonomyMode, JudgeVerdict } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/agentSessionGate', () => ({
  gateAgentSession: vi.fn(async () => ({ ok: true, rail: 'cli' })),
}));

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

async function addRunningMission(result: { current: ReturnType<typeof useAgentsStore> }): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title: 'Running mission',
      repo: '.',
      worktree: '',
      modelLabel: 'sonnet',
      mode: 'agent',
      orchestrator: false,
    });
  });
  const missionId = result.current.missions[result.current.missions.length - 1]!.id;
  act(() => {
    result.current.updateMission({ id: missionId, patch: { status: 'running' } });
  });
  return missionId;
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

describe('autonomy mode reaches the real gate', () => {
  it.each<[AutonomyMode, boolean]>([
    ['manual', false],
    ['supervised', true],
    ['yolo', true],
    ['custom', true],
  ])('safe action "info" under %s mode allows=%s', async (mode, allows) => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel(mode);
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'info', message: 'hi' }]);

    const msg = result.current.managerMessages.find((m) => m.actions && m.actions.length > 0);
    expect(msg?.actionStatuses?.[0]).toBe(allows);
    expect(result.current.pendingApprovals).toHaveLength(allows ? 0 : 1);
  });

  it.each<[AutonomyMode, boolean]>([
    ['manual', false],
    ['supervised', false],
    ['custom', false],
    ['yolo', true],
  ])('sensitive action "stop_all" under %s mode allows=%s', async (mode, allows) => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel(mode);
    });
    const missionId = await addRunningMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'stop_all' }]);

    const stillRunning = result.current.missions.find((m) => m.id === missionId)?.status === 'running';
    if (allows) {
      expect(stillRunning).toBe(false); // executed for real
      expect(result.current.pendingApprovals).toHaveLength(0);
    } else {
      expect(stillRunning).toBe(true); // deferred, NOT executed
      expect(result.current.pendingApprovals).toHaveLength(1);
    }
  });
});

describe('pending approval resolution', () => {
  async function queueStopAll() {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    // Default mode is 'supervised' -> stop_all (sensitive) asks.
    const missionId = await addRunningMission(result);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'stop_all' }]);
    return { result, missionId };
  }

  it('approving a pending action executes it for real and flips the chip to success', async () => {
    const { result, missionId } = await queueStopAll();
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('cancelled');
    const msg = result.current.managerMessages.find((m) => m.actions?.some((a) => a.type === 'stop_all'));
    expect(msg?.actionStatuses?.[0]).toBe(true);
  });

  it('approving an unknown/already-resolved id is a silent no-op', async () => {
    const { result } = await queueStopAll();
    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, 'does-not-exist');
    });
    // Nothing thrown, nothing changed beyond the original pending entry.
    expect(result.current.pendingApprovals).toHaveLength(1);
  });

  it('rejecting a pending action never executes it and informs the manager on the next turn', async () => {
    const { result, missionId } = await queueStopAll();
    const pendingId = result.current.pendingApprovals[0]!.id;

    act(() => {
      result.current.rejectPendingAction(result.current.activeConversationId, pendingId);
    });

    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('running');
    // Informed on the NEXT turn: a transcript message about the rejection is
    // now part of managerMessages, which feeds straight into the next
    // sendManagerMessage call's conversation history (turnMessages).
    const last = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(last?.content).toContain('stop_all');
  });

  it('approveAllPendingActions resolves every request queued from the same turn', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionA = await addRunningMission(result);
    const missionB = await addRunningMission(result);

    // Two independent sensitive actions in ONE turn -> two pending entries
    // sharing the same turnId.
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'stop_all' },
      { type: 'set_budget', limitUsd: 10 },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(2);
    const turnId = result.current.pendingApprovals[0]!.turnId;
    expect(result.current.pendingApprovals.every((p) => p.turnId === turnId)).toBe(true);

    await act(async () => {
      await result.current.approveAllPendingActions(result.current.activeConversationId, turnId);
    });

    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === missionA)?.status).toBe('cancelled');
    expect(result.current.missions.find((m) => m.id === missionB)?.status).toBe('cancelled');
  });

  it('rejectAllPendingActions drops every request queued from the same turn', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionA = await addRunningMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'stop_all' },
      { type: 'set_budget', limitUsd: 10 },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(2);
    const turnId = result.current.pendingApprovals[0]!.turnId;

    act(() => {
      result.current.rejectAllPendingActions(result.current.activeConversationId, turnId);
    });

    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === missionA)?.status).toBe('running');
  });
});

// ── Défaut 1 (qa-manager-2026-07-25/BILAN-NUIT.md): a mission blocked by a
// legitimate guard-rail (the judge gate) must NEVER be reported as approved.
// Real repro: three approve_mission actions blocked by
// `mission.approve_blocked` still rendered as "Approuvée" in the UI.
// Défaut 2: the manager itself never learned of the refusal (only a toast
// fired, never anything in managerMessages) — fixed by relaying the EXACT
// reason into the transcript, same convention rejectPendingAction already
// uses for a plain rejection.
//
// R14 (live repro, this task, 2026-08-14): the mission built by
// addJudgeBlockedMission below has NO diff (isDiffEmpty === true) and a
// scoreUnavailable verdict with zero reviewers (the evaluator rail never ran
// at all — the exact "score indisponible" shape reported live). Before R14,
// checkApproveGate mislabelled this "Le juge a rejeté cette mission (score
// indisponible)" — claiming a rejection the judge never actually reached.
// It now reports the HONEST "evaluation unavailable" reason instead (still
// blocked, since there is nothing real to merge either), and carries
// `judgeUnavailable: true` so a caller can render it distinctly from a real
// rejection. The jsdom test environment's default locale is 'en'
// (navigator.language), so the reason text is the English i18n string —
// see approveGate.ts's checkApproveGate / i18n/locales/en.ts's
// 'agents.approveGate.scoreUnavailableEmptyDiff'. ──
describe('approvePendingAction — honesty fix: a judge-blocked approve_mission is never reported as approved', () => {
  const EXACT_REASON = 'Evaluation unavailable — no judge was able to produce a score, and there is nothing to merge (empty diff). Check manually, or use "Merge anyway".';

  function rejectedJudgeVerdict(): JudgeVerdict {
    return { score: 0, passed: false, risk: 'low', reviewers: [], createdAt: new Date().toISOString(), scoreUnavailable: true };
  }

  async function addJudgeBlockedMission(result: { current: ReturnType<typeof useAgentsStore> }): Promise<string> {
    await act(async () => {
      await result.current.addMission({
        title: 'Blocked review mission',
        repo: '.',
        worktree: 'agent-blocked-review',
        modelLabel: 'sonnet',
        mode: 'agent',
        orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: rejectedJudgeVerdict() } });
    });
    return missionId;
  }

  it('approving it resolves to {ok:false} with the exact system reason, never {ok:true}', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addJudgeBlockedMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean; reason?: string; canForce?: boolean; judgeUnavailable?: boolean };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(EXACT_REASON);
    expect(outcome.canForce).toBe(true);
    // R14 — never claims a rejection the judge never actually reached.
    expect(outcome.reason).not.toMatch(/rejected|rejeté/i);
    expect(outcome.judgeUnavailable).toBe(true);
  });

  it('the entry NEVER disappears as if resolved-positive — it stays actionable with the real reason attached', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addJudgeBlockedMission(result);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    const pendingId = result.current.pendingApprovals[0]!.id;

    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    // NEVER removed as if resolved positively — still there, still actionable.
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.id).toBe(pendingId);
    expect(result.current.pendingApprovals[0]!.lastFailure?.reason).toBe(EXACT_REASON);
    expect(result.current.pendingApprovals[0]!.lastFailure?.canForce).toBe(true);
    // R14 — the store's own persisted state carries the same honest
    // classification, not just the one-shot outcome.
    expect(result.current.pendingApprovals[0]!.lastFailure?.judgeUnavailable).toBe(true);
    // Same red/strikethrough chip a denied action already gets — never the
    // green "success" chip a real approval gets.
    const msg = result.current.managerMessages.find((m) => m.actions?.some((a) => a.type === 'approve_mission'));
    expect(msg?.actionStatuses?.[0]).toBe(false);
  });

  it('Défaut 2 — the manager reads the EXACT refusal reason on its NEXT turn, never a generic message', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addJudgeBlockedMission(result);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    const pendingId = result.current.pendingApprovals[0]!.id;

    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    // managerMessages feeds straight into the next sendManagerMessage call's
    // conversation history — this is what makes the manager's own
    // pre-existing "you will see this honestly on your next turn" promise
    // (managerEngine.ts) actually true for a refused approval.
    const last = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(last?.content).toContain(EXACT_REASON);
  });

  it('rejecting a blocked entry abandons it for real (the reject/abandon escape hatch)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addJudgeBlockedMission(result);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    const pendingId = result.current.pendingApprovals[0]!.id;
    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });
    expect(result.current.pendingApprovals).toHaveLength(1); // still there, blocked

    act(() => {
      result.current.rejectPendingAction(result.current.activeConversationId, pendingId);
    });
    expect(result.current.pendingApprovals).toHaveLength(0);
  });

  it('retrying with force bypasses the judge gate and actually resolves the approval', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addJudgeBlockedMission(result);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    const pendingId = result.current.pendingApprovals[0]!.id;
    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });
    expect(result.current.pendingApprovals).toHaveLength(1); // still blocked, not forced yet

    let outcome!: { ok: boolean; reason?: string; canForce?: boolean };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId, { force: true });
    });

    expect(outcome.ok).toBe(true);
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('done');
  });

  // R14 (this task) — BEHAVIOUR CHOICE: evaluateAutoMerge's own "lazy floor"
  // (approveGate.ts, same file) already auto-merges a REAL, non-empty
  // deliverable whose verdict is scoreUnavailable for auto_green/full_auto
  // (agentsStore.approvalModes.test.tsx pins that). Blocking the EXPLICIT,
  // human-requested manual approve in that exact same shape would be
  // STRICTER than the unattended automatic path — backwards. checkApproveGate
  // mirrors the same floor for manual approve: a real diff lets the approval
  // through directly, with no "force" needed — there is nothing to force
  // past, since no verdict was ever reached to overrule.
  it('a scoreUnavailable verdict on a REAL, non-empty deliverable approves directly — no force needed (mirrors the auto_green lazy floor)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.addMission({
        title: 'Real deliverable, evaluator rail down', repo: '.', worktree: 'agent-real-deliverable',
        modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;
    act(() => {
      result.current.updateMission({
        id: missionId,
        patch: { status: 'review', judgeVerdict: rejectedJudgeVerdict(), diffAdded: 12, diffRemoved: 0 },
      });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean; reason?: string; canForce?: boolean; judgeUnavailable?: boolean };
    await act(async () => {
      // Deliberately NOT { force: true } — the whole point of this fix.
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeUndefined();
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === missionId)?.status).toBe('done');
  });

  it('approveAllPendingActions surfaces the SAME blocked outcome inside a batch — never a blanket success', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const blockedId = await addJudgeBlockedMission(result);
    const runningId = await addRunningMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'approve_mission', missionId: blockedId },
      { type: 'stop_all' },
    ]);
    expect(result.current.pendingApprovals).toHaveLength(2);
    const turnId = result.current.pendingApprovals[0]!.turnId;

    let results!: Array<{ id: string; ok: boolean; reason?: string; canForce?: boolean }>;
    await act(async () => {
      results = await result.current.approveAllPendingActions(result.current.activeConversationId, turnId);
    });

    const blockedResult = results.find((r) => r.ok === false);
    expect(blockedResult?.reason).toBe(EXACT_REASON);
    expect(blockedResult?.canForce).toBe(true);
    // The blocked one stays queued, still carrying its real reason; the
    // genuinely successful stop_all is gone, never lumped together.
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.lastFailure?.reason).toBe(EXACT_REASON);
    expect(result.current.missions.find((m) => m.id === runningId)?.status).toBe('cancelled');
  });
});

// ── C1 (2026-07-29 closing wave): a retry_mission (or stop_mission) whose
// target mission vanished before approval must NEVER resolve positive —
// same "screen claims a success the system never obtained" family as the
// approve_mission judge-blocked fix above. Real repro: a card read
// "Relancer la mission M44 — Approuvée" while M44 stayed in 'review', no
// retry clone existed, and the approval queue was empty. Root cause:
// retryMission used to silently no-op on an unknown mission id instead of
// throwing, so approvePendingAction's own honesty fix (which only resolves
// an entry positive when the executor it awaits actually throws) could never
// catch the failure.
describe('approvePendingAction — honesty fix: retry_mission/stop_mission never report success once the target mission is gone (C1)', () => {
  async function addFailedMission(result: { current: ReturnType<typeof useAgentsStore> }, title = 'Failed mission'): Promise<string> {
    await act(async () => {
      await result.current.addMission({
        title, repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = result.current.missions[result.current.missions.length - 1]!.id;
    act(() => {
      result.current.updateMission({ id: missionId, patch: { status: 'failed' } });
    });
    return missionId;
  }

  it('retry_mission: approving a retry whose mission vanished before approval resolves {ok:false}, never {ok:true}', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addFailedMission(result);
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'retry_mission', missionId }]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    // Mirrors the real repro: by the time the approval is actually clicked,
    // the mission is gone (archived/pruned/deleted) — retryMission can no
    // longer find it, regardless of why.
    act(() => {
      result.current.deleteMission(missionId);
    });

    let outcome!: { ok: boolean; reason?: string; canForce?: boolean };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain(missionId);
    // NEVER removed as if resolved-positive — stays actionable with the real reason.
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.lastFailure?.reason).toBe(outcome.reason);
    // No phantom retry clone was ever queued.
    expect(result.current.missions.length).toBe(missionsBefore - 1);
    const msg = result.current.managerMessages.find((m) => m.actions?.some((a) => a.type === 'retry_mission'));
    expect(msg?.actionStatuses?.[0]).toBe(false);
  });

  it('stop_mission: approving a stop for a mission that no longer exists resolves {ok:false}, never {ok:true}', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addRunningMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'stop_mission', missionId }]);
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    act(() => {
      result.current.deleteMission(missionId);
    });

    let outcome!: { ok: boolean; reason?: string; canForce?: boolean };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain(missionId);
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.lastFailure?.reason).toBe(outcome.reason);
  });

  it('retry_mission: approving a genuinely resolvable retry still succeeds (no regression)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addFailedMission(result);
    const missionsBefore = result.current.missions.length;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'retry_mission', missionId }]);
    const pendingId = result.current.pendingApprovals[0]!.id;

    let outcome!: { ok: boolean; reason?: string; canForce?: boolean };
    await act(async () => {
      outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(outcome.ok).toBe(true);
    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.length).toBe(missionsBefore + 1);
    // A real clone was queued and picked up — never asserting the exact
    // 'queued' status here since the real (unmocked) runMission chain in
    // this file's harness can advance it to 'running' before this
    // assertion runs; the honest signal is a genuine NEW mission distinct
    // from the original 'failed' one, never still 'failed'.
    const clone = result.current.missions[result.current.missions.length - 1];
    expect(clone.id).not.toBe(missionId);
    expect(clone.status).not.toBe('failed');
  });
});

// ── clear_canvas includeReview — destructive tier, gated even in yolo (P0 fix) ──
// A review-status mission is awaiting a human approve/reject decision;
// sweeping it via includeReview abandons that decision unresolved, so this
// must require approval even in full-auto (yolo) mode — unlike an ordinary
// 'archive'-mode clear_canvas (sensitive, auto-allowed in yolo).

async function addReviewMission(result: { current: ReturnType<typeof useAgentsStore> }): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title: 'In review',
      repo: '.',
      worktree: '',
      modelLabel: 'sonnet',
      mode: 'agent',
      orchestrator: false,
    });
  });
  const missionId = result.current.missions[result.current.missions.length - 1]!.id;
  act(() => {
    result.current.updateMission({ id: missionId, patch: { status: 'review' } });
  });
  return missionId;
}

describe('clear_canvas includeReview — destructive, gated even under yolo mode', () => {
  it('a plain clear_canvas "terminated" (no includeReview) never touches the review mission, even in yolo', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel('yolo');
    });
    const reviewId = await addReviewMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated' }]);

    expect(result.current.missions.find((m) => m.id === reviewId)?.archived).toBeFalsy();
    expect(result.current.pendingApprovals).toHaveLength(0);
  });

  it('clear_canvas "terminated" with includeReview:true asks for approval even under yolo mode', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel('yolo');
    });
    const reviewId = await addReviewMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated', includeReview: true }]);

    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.missions.find((m) => m.id === reviewId)?.archived).toBeFalsy();
  });

  it('approving the deferred includeReview sweep archives the review mission for real', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel('yolo');
    });
    const reviewId = await addReviewMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated', includeReview: true }]);
    const pendingId = result.current.pendingApprovals[0]!.id;

    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });

    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === reviewId)?.archived).toBe(true);
  });

  it('an ordinary archive-mode clear_canvas ("mode" omitted) stays sensitive-tier — auto-allowed in yolo', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    act(() => {
      result.current.setAutonomyLevel('yolo');
    });
    await act(async () => {
      await result.current.addMission({ title: 'Done', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false });
    });
    const doneId = result.current.missions[result.current.missions.length - 1]!.id;
    act(() => {
      result.current.updateMission({ id: doneId, patch: { status: 'done' } });
    });

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'clear_canvas', scope: 'terminated' }]);

    expect(result.current.pendingApprovals).toHaveLength(0);
    expect(result.current.missions.find((m) => m.id === doneId)?.archived).toBe(true);
  });
});
