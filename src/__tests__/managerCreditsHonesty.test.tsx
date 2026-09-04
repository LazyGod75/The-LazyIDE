/**
 * managerCreditsHonesty.test.tsx — W-MGRCREDITS fix.
 *
 * Real bug (proven live): a Pro wallet at 0 credits + the manager model
 * routed through the managed ai-proxy (mode 'managed'/'pro') used to show
 * "Le manager réfléchit…" with no recovery — the missions runtime already
 * had a no-credits recovery policy (recovery.ts's noCreditsPolicy) but the
 * manager chat path (sendManagerMessage, agentsStore.tsx) had none. This
 * covers the three layers of the fix:
 *   1. No-credits preflight — never calls runManagerTurn at all when the
 *      wallet is already known-empty on a managed/pro-routed turn.
 *   2. Hard call timeout (the main call's own per-call AbortController,
 *      MANAGER_LLM_CALL_TIMEOUT_MS — see managerEngine.ts, P0-1 fix) — an
 *      honest "timed out" message with a real Réessayer (retry) action,
 *      instead of the AbortController firing silently.
 *   3. Any other backend rejection still renders an honest message — never
 *      a stuck spinner (managerBusy always resolves to false).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn, MANAGER_TURN_TIMEOUT_MS } from '../lib/agents/managerEngine';
import { getProviderMode } from '../lib/models/index';
import { isNativeModelReady } from '../lib/agents/runtime';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    // STACK fix: defaults to the REAL implementation (false outside Tauri,
    // matching every pre-existing test in this file unchanged — none of them
    // mock this true) — the new "native rescue" describe block below
    // overrides it per-test, same convention as managerEngine.test.ts's
    // BUG-2 mocks.
    isNativeModelReady: vi.fn(actual.isNativeModelReady),
  };
});

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

// Same convention as managerEngine.test.ts: mock only getProviderMode, keep
// everything else in models/index real.
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

interface MockSubscription {
  credits_remaining_cents: number;
  status: string;
  period_end?: string | null;
}

const subscriptionState: {
  subscription: MockSubscription | null;
  loading: boolean;
  isPro: boolean;
  refresh: () => void;
} = {
  subscription: null,
  loading: false,
  isPro: false,
  refresh: vi.fn(),
};

// Real isOutOfCredits/isLowCredit/formatCredits (pure functions, credits.ts)
// stay real — only the shared subscription context is mocked, same
// isolation level AccountChip.test.tsx uses.
vi.mock('../lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/billing')>();
  return {
    ...actual,
    useSubscriptionContext: () => subscriptionState,
  };
});

const mockedRunManagerTurn = runManagerTurn as ReturnType<typeof vi.fn>;
const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;
const mockedIsNativeModelReady = isNativeModelReady as ReturnType<typeof vi.fn>;

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
  // W-MODELSEL fix: pin locale so the noCreditsMessage/WithDate assertions
  // below are deterministic regardless of a previous test file's leftover
  // localStorage locale (same reasoning as LazyManagerRail.signals.test.tsx).
  localStorage.setItem('lazy.locale', 'en');
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.removeItem('lazy.locale');
});

describe('sendManagerMessage — no-credits preflight', () => {
  it('blocks BEFORE any network call and renders an honest card when Pro credits are 0 on a managed-routed turn', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 0, status: 'active' };

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'anthropic/claude-haiku-4.5');
    });

    expect(mockedRunManagerTurn).not.toHaveBeenCalled();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBe(true);
    expect(lastMsg.content.length).toBeGreaterThan(0);
    expect(result.current.managerBusy).toBe(false);
  });

  it('also blocks on the "pro" (selected-but-inactive) mode — same empty wallet, same honest card', async () => {
    mockedGetProviderMode.mockReturnValue('pro');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 0, status: 'active' };

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'haiku');
    });

    expect(mockedRunManagerTurn).not.toHaveBeenCalled();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBe(true);
  });

  it('does NOT block a native CLI-routed turn even with 0 Pro credits — the wallet is irrelevant off the managed path', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 0, status: 'active' };
    mockedRunManagerTurn.mockResolvedValueOnce({ responseText: 'Fait.', actions: [], rawResponse: '' });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'claude-haiku-4-5');
    });

    expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBeFalsy();
  });

  it('W-MODELSEL fix: includes the real renewal date when subscription.period_end is available', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    subscriptionState.isPro = true;
    subscriptionState.subscription = {
      credits_remaining_cents: 0,
      status: 'active',
      period_end: '2026-08-15T00:00:00.000Z',
    };

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'anthropic/claude-haiku-4.5');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBe(true);
    expect(lastMsg.content).toBe(
      'Pro credits exhausted — top up now or wait for the automatic refill on August 15, 2026.',
    );
  });

  it('W-MODELSEL fix: falls back to an honest date-less message when period_end is absent — never invents a date', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 0, status: 'active', period_end: null };

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'anthropic/claude-haiku-4.5');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBe(true);
    expect(lastMsg.content).toBe(
      'Pro credits exhausted — top up now or wait for your next automatic refill.',
    );
  });

  it('does NOT block a managed-routed turn when credits remain', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 500, status: 'active' };
    mockedRunManagerTurn.mockResolvedValueOnce({ responseText: 'Fait.', actions: [], rawResponse: '' });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'haiku');
    });

    expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1);
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBeFalsy();
  });
});

// ── STACK fix: native rescue instead of refusing outright ────────────
// A user can hold both a Claude CLI subscription and an active Lazy Pro plan
// at once. 0 Pro credits on a managed/pro-routed turn used to ALWAYS show
// the "no credits" card, even when a CLI subscription was ready to serve the
// exact same lightweight planning turn — this covers the fix: consult
// isNativeModelReady() before refusing, and route the manager onto the CLI
// (engineOverride: 'cli') instead of a synthetic block.

describe('sendManagerMessage — native rescue when Pro credits are exhausted (STACK fix)', () => {
  it('does NOT block a managed-routed turn at 0 Pro credits when a native CLI subscription is ready — routes to runManagerTurn with engineOverride "cli" instead', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 0, status: 'active' };
    mockedIsNativeModelReady.mockReturnValueOnce(true);
    mockedRunManagerTurn.mockResolvedValueOnce({ responseText: 'Fait.', actions: [], rawResponse: '' });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'anthropic/claude-haiku-4.5');
    });

    expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1);
    expect(mockedRunManagerTurn.mock.calls[0][0]).toMatchObject({ engineOverride: 'cli' });
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBeFalsy();
    expect(result.current.managerBusy).toBe(false);
  });

  it('same rescue applies to the "pro" (selected-but-inactive) mode', async () => {
    mockedGetProviderMode.mockReturnValue('pro');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 0, status: 'active' };
    mockedIsNativeModelReady.mockReturnValueOnce(true);
    mockedRunManagerTurn.mockResolvedValueOnce({ responseText: 'Fait.', actions: [], rawResponse: '' });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'haiku');
    });

    expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1);
    expect(mockedRunManagerTurn.mock.calls[0][0]).toMatchObject({ engineOverride: 'cli' });
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBeFalsy();
  });

  it('still blocks with the honest card when NEITHER rail is usable (native not ready either) — unchanged from before this fix', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 0, status: 'active' };
    mockedIsNativeModelReady.mockReturnValueOnce(false);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'anthropic/claude-haiku-4.5');
    });

    expect(mockedRunManagerTurn).not.toHaveBeenCalled();
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.creditsBlocked).toBe(true);
  });

  it('does not pass an engineOverride when credits are NOT exhausted, even if native happens to be ready too', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    subscriptionState.isPro = true;
    subscriptionState.subscription = { credits_remaining_cents: 500, status: 'active' };
    mockedIsNativeModelReady.mockReturnValueOnce(true);
    mockedRunManagerTurn.mockResolvedValueOnce({ responseText: 'Fait.', actions: [], rawResponse: '' });

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'haiku');
    });

    expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1);
    expect(mockedRunManagerTurn.mock.calls[0][0]).toMatchObject({ engineOverride: undefined });
  });
});

describe('sendManagerMessage — hard turn timeout', () => {
  it('clears the thinking state and renders an honest, retryable timeout message once MANAGER_TURN_TIMEOUT_MS elapses', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    subscriptionState.isPro = false;
    subscriptionState.subscription = null;

    // Mirrors what a real hung fetch/stream does once its AbortController
    // fires: the in-flight promise rejects when the SAME signal passed into
    // runManagerTurn aborts — never resolves on its own. Only faking the
    // timer, not the whole event loop, keeps this close to real await
    // behavior instead of a brittle full-fake-timers simulation.
    mockedRunManagerTurn.mockImplementationOnce(
      (opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );

    vi.useFakeTimers();
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      const pending = result.current.sendManagerMessage(result.current.activeConversationId, 'tâche longue', 'haiku');
      await vi.advanceTimersByTimeAsync(MANAGER_TURN_TIMEOUT_MS);
      await pending;
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.timedOut).toBe(true);
    expect(lastMsg.retryText).toBe('tâche longue');
    expect(lastMsg.content.length).toBeGreaterThan(0);
    expect(result.current.managerBusy).toBe(false);
  });
});

describe('sendManagerMessage — honest error propagation', () => {
  it('renders an honest error message (not a stuck spinner) for a non-timeout backend rejection', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    subscriptionState.isPro = false;
    subscriptionState.subscription = null;
    mockedRunManagerTurn.mockRejectedValueOnce(new Error('Proxy error 500'));

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'lance un agent', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.timedOut).toBeFalsy();
    expect(lastMsg.creditsBlocked).toBeFalsy();
    expect(lastMsg.content).toContain('Proxy error 500');
    expect(result.current.managerBusy).toBe(false);
  });
});
