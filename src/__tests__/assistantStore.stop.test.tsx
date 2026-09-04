/**
 * assistantStore — stop button (W-STOPLLM).
 *
 * Covers the assistant chat's Stop button / Escape path: clicking Stop
 * (abortStream) mid-stream must abort the in-flight turn, keep whatever
 * partial text already accumulated, flag the message `interrupted` (the
 * subtle "— interrompu" suffix marker MessageList.tsx renders from it), and
 * return the store to idle — never leaving isStreaming stuck true and never
 * silently discarding the partial answer.
 *
 * Same mock boilerplate as assistantStore.test.tsx (brain/platform/provider
 * isolation) — only the mocked stream itself differs: it yields one chunk
 * then hangs forever, so the test can exercise abortStream() against a
 * genuinely in-flight turn instead of one that would finish on its own.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AssistantStoreProvider, useAssistantStore } from '../components/assistant/assistantStore';
import { I18nProvider } from '../i18n';

vi.mock('../lib/brain/capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/brain/capture')>();
  return {
    ...actual,
    captureAssistant: vi.fn(),
    captureChatLearning: vi.fn(),
  };
});

vi.mock('../app/AppContext', () => ({
  useAppContext: vi.fn(() => ({ projectRoot: '' })),
}));

vi.mock('../lib/ai/lazyRules', () => ({
  useLazyRules: vi.fn(() => ({ rules: null, loading: false, reload: vi.fn() })),
  buildRulesSystemPrompt: vi.fn(() => ''),
}));

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: vi.fn(() => ({
      brain: {
        recallScoped: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensSaved: 0 }),
        startupContext: vi.fn().mockResolvedValue(''),
      },
    })),
  };
});

// Yields one chunk, then hangs forever without the outer streamTimeout's
// abort race (wired via req.signal in assistantStore.send()) — a real hung
// generation never resolves its next chunk on its own either.
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      id: 'mock',
      label: 'Mock',
      listModels: () => actual.ALL_MODELS,
      streamChat: async function* () {
        yield 'Partial answer';
        await new Promise(() => {});
      },
    })),
    describeProviderReadiness: vi.fn(() => ({ ready: true })),
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <AssistantStoreProvider>{children}</AssistantStoreProvider>
    </I18nProvider>
  );
}

describe('assistantStore — stop button', () => {
  it('abortStream stops an in-flight turn, keeps the partial text, flags it interrupted, and returns to idle', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = result.current.send('Explain the recall loop');
    });

    // Let the first chunk flush into state — FLUSH_INTERVAL_MS's "first
    // chunk always flushes immediately" guarantee (assistantStore.tsx).
    // send() awaits real work before the stream loop even starts (brain
    // recall, and a genuine dynamic `import()` of skillInjection.ts that
    // Vite/vitest must actually transform on first load) — real macrotask
    // ticks, not just microtasks, so poll with waitFor (real timers)
    // instead of a fixed number of `await Promise.resolve()` hops or a
    // fixed setTimeout, either of which would be a brittle guess at how
    // many ticks the current call graph happens to need.
    await waitFor(() => {
      const streamingMsg = result.current.messages.find((m) => m.role === 'assistant');
      expect(streamingMsg?.content).toContain('Partial answer');
    });

    expect(result.current.isStreaming).toBe(true);

    act(() => {
      result.current.abortStream();
    });

    // Instant feedback (abortStream's own synchronous setState) — never
    // waits on send()'s own async unwind.
    expect(result.current.isStreaming).toBe(false);

    await act(async () => {
      await sendPromise;
    });

    expect(result.current.isStreaming).toBe(false);
    const finalMsg = result.current.messages.find((m) => m.role === 'assistant');
    expect(finalMsg?.content).toContain('Partial answer');
    expect(finalMsg?.interrupted).toBe(true);
    expect(finalMsg?.isStreaming).toBe(false);
  });
});
