/**
 * managerApprovalModeAction.test.tsx — W-MODES manager parity:
 * set_approval_mode parses, is documented in the prompt catalog, and its
 * executor dispatches through the REAL changeApprovalMode primitive (same
 * harness as managerW8cActions.test.tsx's dispatch()/seedMission() helpers).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { parseManagerActions, buildManagerSystemPrompt, runManagerTurn } from '../lib/agents/managerEngine';
import { getApprovalMode, _resetApprovalModesForTests } from '../lib/agents/approvalMode';

const mockInvoke = vi.mocked(invoke);

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
  _resetApprovalModesForTests();
  // approvalMode.ts falls back to localStorage outside Tauri (jsdom here) —
  // AgentsStoreProvider's own boot effect calls ensureApprovalModesLoaded()
  // on every mount, which would otherwise reload a PRIOR test's persisted
  // value the instant it wins the race against this reset.
  localStorage.clear();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockImplementation(async () => undefined);
});

afterEach(() => {
  _resetApprovalModesForTests();
  localStorage.clear();
});

async function dispatch(sendManagerMessage: (conversationId: string, text: string, model: string) => Promise<void>, conversationId: string, actions: unknown[]) {
  vi.mocked(runManagerTurn).mockResolvedValueOnce({ responseText: 'ok', actions: actions as never, rawResponse: '' });
  await act(async () => {
    await sendManagerMessage(conversationId, 'do it', 'haiku');
  });
}

describe('parseManagerActions — set_approval_mode', () => {
  it('parses the global-default form (projectId omitted)', () => {
    const actions = parseManagerActions('<lazy_actions>\n[{"type": "set_approval_mode", "mode": "auto_green"}]\n</lazy_actions>');
    expect(actions).toEqual([{ type: 'set_approval_mode', mode: 'auto_green' }]);
  });

  it('parses the per-project form', () => {
    const json = '{"type": "set_approval_mode", "mode": "full_auto", "projectId": "demo-shop"}';
    const actions = parseManagerActions(`<lazy_actions>\n[${json}]\n</lazy_actions>`);
    expect(actions).toEqual([JSON.parse(json)]);
  });
});

describe('buildManagerSystemPrompt — set_approval_mode catalog entry', () => {
  it('documents the action, its 3 modes, and the retroactive-merge behavior', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('"type": "set_approval_mode"');
    expect(prompt).toContain('manual');
    expect(prompt).toContain('auto_green');
    expect(prompt).toContain('full_auto');
    expect(prompt).toMatch(/re-scans every mission already sitting in review/);
    expect(prompt).toMatch(/switching to manual never merges anything retroactively/);
  });
});

describe('set_approval_mode — executor dispatches through the real changeApprovalMode', () => {
  it('sets the global default when projectId is omitted', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'set_approval_mode', mode: 'auto_green' }]);

    expect(getApprovalMode()).toBe('auto_green');
  });

  it('sets a per-project override without touching the global default', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [
      { type: 'set_approval_mode', mode: 'full_auto', projectId: 'demo-shop' },
    ]);

    expect(getApprovalMode('demo-shop')).toBe('full_auto');
    expect(getApprovalMode('other-project')).toBe('manual');
  });

  it('is a no-op (honest confirmation either way) when the mode already matches', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await dispatch(result.current.sendManagerMessage, result.current.activeConversationId, [{ type: 'set_approval_mode', mode: 'manual' }]);
    expect(getApprovalMode()).toBe('manual');
  });
});
