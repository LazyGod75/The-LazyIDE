/**
 * managerTurnCost.test.tsx — R4b fix, deliverable #4 (turn cost visibility).
 *
 * Manager exchanges spend real credits (~13 credits observed per exchange in
 * dogfooding) with zero display anywhere in the rail. costStore.ts already
 * accumulates REAL token usage synchronously as part of every provider
 * branch's awaited call (managedProvider.ts/claudeCodeProvider.ts both call
 * addUsage before their stream generator returns) — sendManagerMessage now
 * snapshots getCostState() before/after the exchange and attaches the
 * measured delta (converted via the app's existing cents-per-dollar
 * "credits" convention) to the assistant ManagerMessage as
 * `approxCreditsUsed`, never a fabricated number.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { addUsage, resetCost } from '../lib/models/costStore';

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
  vi.mocked(runManagerTurn).mockReset();
  resetCost();
});

describe('sendManagerMessage — real turn cost visibility (no fabrication)', () => {
  it('attaches a measured approxCreditsUsed when the backend actually reported usage this turn', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockImplementationOnce(async () => {
      // Simulates what managedProvider.ts/claudeCodeProvider.ts really do:
      // addUsage() is called synchronously before the awaited call resolves.
      addUsage({ inputTokens: 200, outputTokens: 3_000, model: 'haiku' });
      return { responseText: 'Done.', actions: [], rawResponse: '' };
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'do something', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.approxCreditsUsed).toBeDefined();
    expect(lastMsg.approxCreditsUsed).toBeGreaterThan(0);
  });

  it('leaves approxCreditsUsed undefined when no measurable usage was reported — never a fabricated number', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Done.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'do something else', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.approxCreditsUsed).toBeUndefined();
  });

  it('only counts usage recorded DURING this exchange, not pre-existing session totals', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // Unrelated prior usage from earlier in the session.
    addUsage({ inputTokens: 100_000, outputTokens: 100_000, model: 'sonnet' });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Done.',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'do something', 'haiku');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.approxCreditsUsed).toBeUndefined();
  });

  it('free model turn (real settled cost 0) shows NO credits — never a fabricated estimate', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockImplementationOnce(async () => {
      // A free-model turn (ox alpha): the settled marker reports costUsd: 0,
      // and the session accumulator must NOT invent a hard-coded estimate.
      addUsage({ inputTokens: 93, outputTokens: 4000, model: 'z-ai/glm-5.2', costUsd: 0 });
      return { responseText: 'Done.', actions: [], rawResponse: '' };
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'do something', 'z-ai/glm-5.2');
    });

    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.approxCreditsUsed).toBeUndefined();
  });

  it('wires a live onPartial hook and leaves a single non-streaming assistant reply', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Hello from the live stream',
      actions: [],
      rawResponse: '',
    });

    await act(async () => {
      await result.current.sendManagerMessage(result.current.activeConversationId, 'hello', 'haiku');
    });

    expect(vi.mocked(runManagerTurn).mock.calls[0][0].onPartial).toEqual(expect.any(Function));
    const lastMsg = result.current.managerMessages[result.current.managerMessages.length - 1];
    expect(lastMsg.isStreaming).toBeUndefined();
    expect(lastMsg.content).toBe('Hello from the live stream');
    expect(result.current.managerMessages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});
