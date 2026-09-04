/**
 * managerSessionHonesty.test.tsx — unsigned free GLM must not call the proxy.
 *
 * Measured 2026-08-28: send with a free OpenRouter id hit
 * ManagedUnavailableError: Session requise pour le mode géré (agent).
 * Same preflight shape as managerCreditsHonesty (no spinner, card, CTA).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { getProviderMode } from '../lib/models/index';
import { hasManagedSession } from '../lib/agents/managerSessionGate';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

vi.mock('../lib/agents/managerSessionGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerSessionGate')>();
  return {
    ...actual,
    hasManagedSession: vi.fn(),
  };
});

const mockedRunManagerTurn = runManagerTurn as ReturnType<typeof vi.fn>;
const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;
const mockedHasManagedSession = hasManagedSession as ReturnType<typeof vi.fn>;

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
  mockedRunManagerTurn.mockReset();
  mockedGetProviderMode.mockReset();
  mockedHasManagedSession.mockReset();
  mockedGetProviderMode.mockReturnValue('mock');
  localStorage.setItem('lazy.locale', 'en');
});

describe('sendManagerMessage — unsigned free-model session preflight', () => {
  it('blocks BEFORE runManagerTurn and sets sessionBlocked when there is no JWT', async () => {
    mockedHasManagedSession.mockResolvedValue(false);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(
        result.current.activeConversationId,
        'ping',
        'z-ai/glm-5.2:free',
      );
    });

    expect(mockedRunManagerTurn).not.toHaveBeenCalled();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.sessionBlocked).toBe(true);
    expect(lastMsg.content).toMatch(/Lazy account|Sign in/i);
    expect(lastMsg.content).not.toMatch(/ManagedUnavailableError/i);
  });

  it('calls runManagerTurn when a session exists', async () => {
    mockedHasManagedSession.mockResolvedValue(true);
    mockedRunManagerTurn.mockResolvedValue({
      responseText: 'pong',
      actions: [],
      rawResponse: 'pong',
    });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(
        result.current.activeConversationId,
        'ping',
        'z-ai/glm-5.2:free',
      );
    });

    expect(mockedRunManagerTurn).toHaveBeenCalled();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.sessionBlocked).toBeFalsy();
  });
});
