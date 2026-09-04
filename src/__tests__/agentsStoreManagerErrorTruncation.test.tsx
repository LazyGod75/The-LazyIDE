/**
 * sendManagerMessage — error message truncation (real repro, 2026-08-12).
 *
 * A DeepSeek-rail rejection surfaced to the user mid-word, no ellipsis:
 * "Error: Error: LazyManager error: Error: There's an issue with the
 * selected model (deepseek-chat). It may not exist or you may n" — the
 * catch-all error path in agentsStore.tsx's sendManagerMessage used a bare
 * `String(err).slice(0, 120)` with no truncation marker at all. Fixed by
 * reusing agentsStore.tsx's OWN existing `truncateLabel` (word-boundary-aware
 * + always-ellipsis, already applied to pendingAction labels for the
 * identical class of bug, 2026-08-01 QA) instead of adding a third
 * truncation helper — NOT src/components/lazyManager/truncateLabel.ts's
 * export of the same name, which would collide with this file's own.
 *
 * New, standalone file (rather than added to an existing agentsStore.*.test
 * file) to avoid colliding with concurrent timer-leak/flaky-test edits
 * elsewhere under src/__tests__/. Mirrors agentsStore.stopManager.test.tsx's
 * mock shape (runManagerTurn rejecting) for the "generic thrown error"
 * branch of the same catch block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { getProviderMode } from '../lib/models/index';
import { truncateLabel } from '../components/agents/agentsStore';
import { formatManagerUserError, MANAGER_ERROR_MAX_CHARS } from '../lib/agents/managerSessionGate';

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
  mockedGetProviderMode.mockReturnValue('claude-code');
  subscriptionState.subscription = null;
  subscriptionState.isPro = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendManagerMessage — error message truncation', () => {
  it('a long thrown error is truncated with a visible ellipsis, never cut mid-word with no marker', async () => {
    // Mirrors the real repro's shape: a rail-rejection message far longer
    // than the 120-char budget, ending well past the cut point.
    const longReason =
      "There's an issue with the selected model (deepseek-chat). It may not exist or you may not have access to it. " +
      'Try selecting a different model or check your configuration.';
    mockedRunManagerTurn.mockRejectedValueOnce(new Error(`LazyManager error: Error: ${longReason}`));

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'salut', 'deepseek-chat');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];

    // The formatted human sentence fits the bubble budget — do not cut it.
    expect(lastMsg.content).toContain('you may not have access');
    expect(lastMsg.content).not.toMatch(/LazyManager error/i);
    const thrown = new Error(`LazyManager error: Error: ${longReason}`);
    const expectedTruncatedMsg = truncateLabel(formatManagerUserError(thrown), MANAGER_ERROR_MAX_CHARS);
    expect(lastMsg.content.endsWith(expectedTruncatedMsg)).toBe(true);
    expect(expectedTruncatedMsg.length).toBeLessThanOrEqual(MANAGER_ERROR_MAX_CHARS);
  });

  it('still ellipsizes a pathologically long error at a word boundary', async () => {
    const huge = `${'word '.repeat(200)}END`;
    mockedRunManagerTurn.mockRejectedValueOnce(new Error(huge));
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'salut', 'deepseek-chat');
    });
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.content).toContain('…');
    expect(lastMsg.content).not.toMatch(/END/);
  });
});
