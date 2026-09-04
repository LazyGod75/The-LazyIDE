/**
 * managerOpenProjectGate.test.tsx — open_project must go through the REAL
 * universal approval gate (actionGate.ts) exactly like launch_mission does,
 * never execute silently — it mutates workspace state (registers a new
 * project, switches the active one). Deliberately does NOT mock actionGate
 * (unlike managerOpenProjectAction.test.tsx, which is about the action's
 * own execution behavior once allowed) — mirrors pendingApprovals.test.tsx's
 * own "exercise the REAL gate" convention.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { AppProvider, useAppContext } from '../app/AppContext';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { classifyAction } from '../lib/agents/actionClassifier';

const mockInvoke = vi.mocked(invoke);

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

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

function appWrapper({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <I18nProvider>
        <ToastProvider>
          <AgentsStoreProvider>{children}</AgentsStoreProvider>
        </ToastProvider>
      </I18nProvider>
    </AppProvider>
  );
}

function useCombined() {
  return { app: useAppContext(), store: useAgentsStore() };
}

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

beforeEach(() => {
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

it('classifies as sensitive — same gating tier as launch_mission', () => {
  expect(classifyAction('open_project')).toBe('sensitive');
});

describe('open_project under the REAL gate', () => {
  beforeEach(() => {
    simulateTauri();
  });

  afterEach(() => {
    clearTauriSimulation();
  });

  it('default (supervised) autonomy DEFERS it — never executes silently', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'project_list' ? [] : undefined));
    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [
      { type: 'open_project', path: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON' },
    ]);

    expect(result.current.store.pendingApprovals).toHaveLength(1);
    expect(result.current.store.pendingApprovals[0]!.action).toEqual({
      type: 'open_project',
      path: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON',
    });
    // Never registered — no project_register invoke fired.
    expect(result.current.app.openProjects).toHaveLength(0);
  });

  it('manual mode also defers it', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'project_list' ? [] : undefined));
    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });
    act(() => {
      result.current.store.setAutonomyLevel('manual');
    });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'open_project', path: 'C:\\some\\path\\here' }]);

    expect(result.current.store.pendingApprovals).toHaveLength(1);
  });

  it('approving the deferred request actually opens the project for real', async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'project_register') {
        const path = (args as { path?: string } | undefined)?.path ?? '';
        return { id: 'reg-new', root: path, brainId: null, active: false };
      }
      if (cmd === 'project_set_active') return undefined;
      if (cmd === 'project_list') {
        return [{ id: 'reg-new', root: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON', brainId: null, active: true }];
      }
      return undefined;
    });
    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [
      { type: 'open_project', path: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON' },
    ]);
    expect(result.current.store.pendingApprovals).toHaveLength(1);
    const pendingId = result.current.store.pendingApprovals[0]!.id;

    await act(async () => {
      await result.current.store.approvePendingAction(result.current.store.activeConversationId, pendingId);
    });

    expect(result.current.store.pendingApprovals).toHaveLength(0);
    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(1));
  });

  it('rejecting the deferred request never opens the project', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === 'project_list' ? [] : undefined));
    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'open_project', path: 'C:\\some\\path\\here' }]);
    const pendingId = result.current.store.pendingApprovals[0]!.id;

    act(() => {
      result.current.store.rejectPendingAction(result.current.store.activeConversationId, pendingId);
    });

    expect(result.current.store.pendingApprovals).toHaveLength(0);
    expect(result.current.app.openProjects).toHaveLength(0);
  });

  it('yolo mode auto-allows it — same treatment as launch_mission', async () => {
    mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'project_register') {
        const path = (args as { path?: string } | undefined)?.path ?? '';
        return { id: 'reg-new', root: path, brainId: null, active: false };
      }
      if (cmd === 'project_set_active') return undefined;
      if (cmd === 'project_list') {
        return [{ id: 'reg-new', root: 'C:\\some\\path\\here', brainId: null, active: true }];
      }
      return undefined;
    });
    const { result } = renderHook(() => useCombined(), { wrapper: appWrapper });
    act(() => {
      result.current.store.setAutonomyLevel('yolo');
    });

    await dispatch(result.current.store.sendManagerMessage, result.current.store.activeConversationId, [{ type: 'open_project', path: 'C:\\some\\path\\here' }]);

    expect(result.current.store.pendingApprovals).toHaveLength(0);
    await waitFor(() => expect(result.current.app.openProjects).toHaveLength(1));
  });
});
