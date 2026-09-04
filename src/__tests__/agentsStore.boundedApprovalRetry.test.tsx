/**
 * agentsStore.boundedApprovalRetry.test.tsx — "M4/M5 zombie approval loop"
 * incident regression coverage (real user report, 2026-08-14).
 *
 * SYMPTOM observed live: the pending-approval queue ACCUMULATED — "2
 * actions en attente d'approbation", both `approve_mission` rows for the
 * SAME mission — and clicking "Tout approuver" repeatedly never cleared
 * them, because each click only ever resolved ONE of the duplicates while
 * the manager kept re-proposing approve_mission for the same still-stuck
 * mission on later turns, queuing ANOTHER entry every time. The activity
 * feed flooded with repeated `mission.approve_blocked` ("merge bloqué")
 * journal lines as a result.
 *
 * Fixed at the SOURCE (sendManagerMessage's action-queuing loop,
 * agentsStore.tsx): an approve_mission proposal for a mission that ALREADY
 * has an unresolved pendingApprovals entry (still awaiting a decision, or
 * already recorded as blocked via `lastFailure`) is refused immediately —
 * same treatment retryMission's own 2026-08-02 baseBranch refuse-at-source
 * fix already established for a different doomed-approval shape — instead
 * of queuing a second, independent row. This bounds how many LIVE rows a
 * single stuck mission can ever occupy to exactly one, and stops the
 * `mission.approve_blocked` journal flood: a refused-at-source duplicate
 * never reaches approveMission at all, so it never journals anything.
 *
 * Same harness as pendingApprovals.test.tsx's own approve_mission honesty
 * suite (real gate wired to real autonomy state, runManagerTurn mocked to
 * return a fixed action list per call).
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
import type { JudgeVerdict } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return { ...actual, runManagerTurn: vi.fn() };
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

function rejectedJudgeVerdict(): JudgeVerdict {
  return { score: 0, passed: false, risk: 'low', reviewers: [], createdAt: new Date().toISOString(), scoreUnavailable: true };
}

async function addBlockedReviewMission(result: { current: ReturnType<typeof useAgentsStore> }, title = 'M4-repro'): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title, repo: '.', worktree: 'agent-blocked-review', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
    });
  });
  const missionId = result.current.missions[result.current.missions.length - 1]!.id;
  act(() => {
    result.current.updateMission({ id: missionId, patch: { status: 'review', judgeVerdict: rejectedJudgeVerdict() } });
  });
  return missionId;
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

describe('bounded approval retries — refuse-at-source dedup (real user report, "M4/M5 zombie approval loop")', () => {
  it('a second approve_mission proposal for a mission with an already-queued (unresolved) approval is refused, not duplicated', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addBlockedReviewMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    expect(result.current.pendingApprovals).toHaveLength(1);

    // The manager proposes the SAME approve_mission again on a later turn
    // (the realistic shape: it still sees the mission stuck in review and
    // tries again) — must NOT create a second row.
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    expect(result.current.pendingApprovals).toHaveLength(1);

    const approveMissionMsgs = result.current.managerMessages.filter((m) => m.actions?.some((a) => a.type === 'approve_mission'));
    expect(approveMissionMsgs).toHaveLength(2);
    // First turn: genuinely queued (pending approval, not yet resolved) —
    // actionStatuses[0] false only means "not yet executed", same as every
    // other gate-deferred action.
    expect(approveMissionMsgs[0]?.actionStatuses?.[0]).toBe(false);
    // Second turn: refused AT THE SOURCE — same false status, but backed by
    // a real actionFailures reason (see the next test) instead of a fresh
    // pendingApprovals entry.
    expect(approveMissionMsgs[1]?.actionStatuses?.[0]).toBe(false);
  });

  it('a second proposal AFTER the first attempt already failed is still refused, and its reason mentions the existing failure', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addBlockedReviewMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    const pendingId = result.current.pendingApprovals[0]!.id;
    await act(async () => {
      await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
    });
    expect(result.current.pendingApprovals[0]!.lastFailure).toBeDefined();
    const originalReason = result.current.pendingApprovals[0]!.lastFailure!.reason;

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);

    // Still exactly ONE entry — the existing (now-failed) one, never a
    // second independent row alongside it.
    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.id).toBe(pendingId);

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg?.content).toContain(originalReason);
  });

  it('does NOT refuse a SECOND, DIFFERENT mission\'s approve_mission proposal (dedup is keyed by missionId, never global)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionA = await addBlockedReviewMission(result, 'M4-repro');
    const missionB = await addBlockedReviewMission(result, 'M5-repro');

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId: missionA }]);
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId: missionB }]);

    expect(result.current.pendingApprovals).toHaveLength(2);
    expect(result.current.pendingApprovals.map((p) => (p.action as { missionId: string }).missionId).sort())
      .toEqual([missionA, missionB].sort());
  });

  it('after the existing entry is rejected (abandoned), a FRESH approve_mission proposal for the same mission is queued again (dedup never permanently locks a mission out)', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addBlockedReviewMission(result);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    const pendingId = result.current.pendingApprovals[0]!.id;
    act(() => {
      result.current.rejectPendingAction(result.current.activeConversationId, pendingId);
    });
    expect(result.current.pendingApprovals).toHaveLength(0);

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'approve_mission', missionId }]);
    expect(result.current.pendingApprovals).toHaveLength(1);
  });
});
