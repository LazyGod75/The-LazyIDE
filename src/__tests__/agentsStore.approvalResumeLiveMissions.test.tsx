/**
 * agentsStore.approvalResumeLiveMissions.test.tsx — the automated
 * post-approval resume turn must see the mission the approval just created.
 *
 * Live QA 2026-09-02 (LazyBot SolariTest): the user approved `run_lazybot`,
 * the store created M96 and immediately fired managerApprovalResume's
 * follow-up turn. That turn's ManagerContext.missions was the snapshot
 * captured by an OLDER sendManagerMessage closure (sendManagerMessageRef is
 * re-pointed by an effect that had not run yet, and the closure read the
 * render-scoped `state.missions`) — so the manager saw no M96 at all, a stale
 * M95, and "honestly" told the user every SolariTest run had failed while
 * M96 was finishing on the canvas.
 *
 * Same harness as agentsStore.silentLaunchMissionFix.test.tsx: simulated
 * Tauri runtime, real approval gate, only runManagerTurn/runMission mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { runMission } from '../lib/agents/runtime';
import { setManagedAvailability } from '../lib/models/index';
import { _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';

const mockInvoke = vi.mocked(invoke);

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    isManagedModelReady: vi.fn(() => true),
    isNativeModelReady: vi.fn(() => true),
  };
});

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
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

beforeEach(() => {
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  vi.mocked(runMission).mockClear();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
  simulateTauri();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  setManagedAvailability(false);
  localStorage.clear();
});

describe('post-approval resume turn — live missions in its context', () => {
  it('the resume turn fired by approving launch_mission sees the mission that approval created', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const countBefore = result.current.missions.length;

    // Turn 1: the manager proposes a launch → supervised gate queues it.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Launching.',
      actions: [{ type: 'launch_mission', agentName: 'coder', task: 'Fix the bug', model: 'sonnet', engine: 'cli' }] as never,
      rawResponse: '',
    });
    // Every later turn (the automated resume) gets a plain acknowledgement.
    vi.mocked(runManagerTurn).mockResolvedValue({ responseText: 'Noted.', actions: [], rawResponse: '' });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance la mission', 'claude-sonnet-5');
    });
    expect(result.current.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.pendingApprovals[0]!.id;

    await act(async () => {
      const outcome = await result.current.approvePendingAction(result.current.activeConversationId, pendingId);
      expect(outcome.ok).toBe(true);
    });
    expect(result.current.missions.length).toBe(countBefore + 1);
    const created = result.current.missions[result.current.missions.length - 1]!;

    // The queue drained → exactly one automated resume turn follows.
    await waitFor(() => expect(vi.mocked(runManagerTurn)).toHaveBeenCalledTimes(2), { timeout: 8_000 });

    const resumeCall = vi.mocked(runManagerTurn).mock.calls[1]![0];
    const ids = resumeCall.context.missions.map((m) => m.id);
    expect(ids).toContain(created.id);
    expect(resumeCall.context.missions).toHaveLength(countBefore + 1);
  });
});
