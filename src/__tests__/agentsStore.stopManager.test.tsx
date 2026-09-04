/**
 * sendManagerMessage — stop button (W-STOPLLM).
 *
 * Mirrors managerCreditsHonesty.test.tsx's "hard turn timeout" case (same
 * mocks, same mockedRunManagerTurn-rejects-on-abort shape) but triggers the
 * abort via stopManagerMessage() instead of letting MANAGER_TURN_TIMEOUT_MS
 * elapse — proving Stop reuses the SAME AbortController the turn's own
 * timeout owns (agentsStore.tsx's managerAbortRef) and that the rendered
 * message reads as user-interrupted, not as a timeout, even though both
 * observe the identical `timeoutCtrl.signal.aborted === true`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { getProviderMode } from '../lib/models/index';

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

const subscriptionState = {
  subscription: null as { credits_remaining_cents: number; status: string } | null,
  loading: false,
  isPro: false,
  refresh: vi.fn(),
};

vi.mock('../lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/billing')>();
  return {
    ...actual,
    useSubscriptionContext: () => subscriptionState,
  };
});

const mockedRunManagerTurn = runManagerTurn as ReturnType<typeof vi.fn>;
const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;

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
  subscriptionState.subscription = null;
  subscriptionState.isPro = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendManagerMessage — stop button', () => {
  it('stopManagerMessage aborts the in-flight turn and renders it as interrupted, not timed out', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');

    // Rejects the moment its signal aborts — handles the abort firing
    // EITHER before or after this mock is invoked (stopManagerMessage is
    // called synchronously right after sendManagerMessage kicks off, which
    // races ahead of this mock's own invocation in practice).
    mockedRunManagerTurn.mockImplementationOnce(
      (opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
          if (opts.signal?.aborted) onAbort();
          else opts.signal?.addEventListener('abort', onAbort);
        }),
    );

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      const pending = result.current.sendManagerMessage(result.current.activeConversationId, 'longue tâche', 'haiku');
      result.current.stopManagerMessage(result.current.activeConversationId);
      await pending;
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    // Same "Réessayer"-capable card the timeout path uses...
    expect(lastMsg.timedOut).toBe(true);
    expect(lastMsg.retryText).toBe('longue tâche');
    // ...but the copy must read as user-interrupted, never the timeout text.
    expect(lastMsg.content).not.toMatch(/trop de temps|taking too long/i);
    expect(result.current.managerBusy).toBe(false);
  });

  it('stopManagerMessage is a no-op when no turn is in flight', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    expect(() => result.current.stopManagerMessage(result.current.activeConversationId)).not.toThrow();
    expect(result.current.managerMessages).toHaveLength(0);
  });
});
