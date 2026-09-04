/**
 * retryMissionBaseBranchApproval.test.tsx — "M9/M10 dead-end approval"
 * incident (real user report): a manager-proposed `retry_mission` action
 * whose requested baseBranch differs from the mission's own is GUARANTEED
 * to be refused (retryMission's own guard — see
 * lib/agents/retryBaseBranchGuard.ts) the instant anyone clicks Approve.
 * Queuing it anyway offered Approve/Reject, let the user click Approve, and
 * only then revealed the refusal — a permanent Reject-only dead end
 * (retry_mission failures never set `canForce`, so PendingApprovalCard has
 * no recovery button once that failure lands).
 *
 * Fix: the doomed action is refused AT THE SOURCE, before ever entering
 * `pendingApprovals` — same treatment `evaluateActionGate`'s `deny` already
 * gets. This file proves: (1) the doomed case never reaches the pending
 * queue and surfaces a clear reason instead, and (2) a legitimate
 * same-branch (or no-baseBranch) retry is NOT affected — it still queues
 * normally, same as before this fix.
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

async function addMissionOnBranch(result: { current: ReturnType<typeof useAgentsStore> }, baseBranch: string | undefined): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title: 'M9',
      repo: '.',
      worktree: '',
      modelLabel: 'sonnet',
      mode: 'agent',
      orchestrator: false,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
    });
  });
  return result.current.missions[result.current.missions.length - 1]!.id;
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

describe('retry_mission requiring approval, requesting a DIFFERENT base branch (doomed)', () => {
  it('is refused at the source — never enters pendingApprovals — under the default supervised mode', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionOnBranch(result, 'main');

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId, baseBranch: 'feat/other' },
    ]);

    // Never offered as an approval — no dead-end Approve-then-fail UX.
    expect(result.current.pendingApprovals).toHaveLength(0);
    const msg = result.current.managerMessages.find((m) => m.actions?.some((a) => a.type === 'retry_mission'));
    expect(msg?.actionStatuses?.[0]).toBe(false);
    // The mission itself is untouched — no doomed clone was ever queued.
    expect(result.current.missions.filter((m) => m.title === 'M9')).toHaveLength(1);
  });
});

describe('retry_mission requiring approval, requesting the SAME base branch (legitimate)', () => {
  it('still queues normally — this fix does not touch a legitimate retry', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionOnBranch(result, 'main');

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId, baseBranch: 'main' },
    ]);

    expect(result.current.pendingApprovals).toHaveLength(1);
    expect(result.current.pendingApprovals[0]!.action.type).toBe('retry_mission');
  });

  it('a retry with no requested baseBranch at all still queues normally', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const missionId = await addMissionOnBranch(result, 'main');

    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'retry_mission', missionId },
    ]);

    expect(result.current.pendingApprovals).toHaveLength(1);
  });
});
