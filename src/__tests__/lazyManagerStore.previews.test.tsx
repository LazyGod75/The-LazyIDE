/**
 * lazyManagerStore — unified session previews (bug fix: old coder
 * conversations always showed as "Untitled" because assistantStore's own
 * chatSessions summary carries no preview text, unlike agentsStore's
 * managerSessions which already derives one from the first user message).
 * Both sources must now get a first-user-message preview, truncated the
 * same way (~60 chars), not just the orchestrator side.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { LazyManagerStoreProvider, useLazyManagerStore } from '../components/lazyManager/lazyManagerStore';

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: vi.fn(),
}));
vi.mock('../components/assistant/assistantStore', () => ({
  useAssistantStoreOptional: vi.fn(),
}));

import { useAgentsStoreOptional } from '../components/agents/agentsStore';
import { useAssistantStoreOptional } from '../components/assistant/assistantStore';

// Must match chatPersistence.ts's STORAGE_KEY and lazyManagerStore.tsx's
// CHAT_SESSIONS_STORAGE_KEY.
const CHAT_SESSIONS_KEY = 'lazy.chatSessions';

function wrapper({ children }: { children: React.ReactNode }) {
  return <LazyManagerStoreProvider>{children}</LazyManagerStoreProvider>;
}

describe('lazyManagerStore — session previews', () => {
  afterEach(() => {
    vi.mocked(useAgentsStoreOptional).mockReset();
    vi.mocked(useAssistantStoreOptional).mockReset();
    localStorage.removeItem(CHAT_SESSIONS_KEY);
  });

  it('derives a coder session preview from its first user message (was always blank/"Untitled")', () => {
    vi.mocked(useAgentsStoreOptional).mockReturnValue(null);
    // @ts-expect-error — partial store value, only the fields the provider reads
    vi.mocked(useAssistantStoreOptional).mockReturnValue({
      chatSessions: [{ id: 'chat-1', createdAt: 1, updatedAt: 2, messageCount: 2 }],
    });
    localStorage.setItem(
      CHAT_SESSIONS_KEY,
      JSON.stringify([
        {
          id: 'chat-1',
          projectRoot: '/p',
          messages: [
            { id: 'm1', role: 'user', content: 'How do I fix the auth bug?', timestamp: 1 },
            { id: 'm2', role: 'assistant', content: 'Sure, let me look.', timestamp: 2 },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    );

    const { result } = renderHook(() => useLazyManagerStore(), { wrapper });
    const found = result.current.sessions.find((s) => s.id === 'chat-1');
    expect(found?.preview).toBe('How do I fix the auth bug?');
  });

  it('truncates long previews to ~60 chars for BOTH orchestrator and coder sessions', () => {
    const longText = 'x'.repeat(90);
    // @ts-expect-error — partial store value
    vi.mocked(useAgentsStoreOptional).mockReturnValue({
      managerSessions: [{ id: 'mgr-1', createdAt: 1, updatedAt: 3, messageCount: 1, preview: longText }],
    });
    // @ts-expect-error — partial store value
    vi.mocked(useAssistantStoreOptional).mockReturnValue({
      chatSessions: [{ id: 'chat-2', createdAt: 1, updatedAt: 2, messageCount: 1 }],
    });
    localStorage.setItem(
      CHAT_SESSIONS_KEY,
      JSON.stringify([
        {
          id: 'chat-2',
          projectRoot: '/p',
          messages: [{ id: 'm1', role: 'user', content: longText, timestamp: 1 }],
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    );

    const { result } = renderHook(() => useLazyManagerStore(), { wrapper });
    const expected = `${'x'.repeat(60)}...`;
    expect(result.current.sessions.find((s) => s.id === 'mgr-1')?.preview).toBe(expected);
    expect(result.current.sessions.find((s) => s.id === 'chat-2')?.preview).toBe(expected);
  });

  it('falls back to an empty preview (not a crash) when no matching localStorage entry exists', () => {
    vi.mocked(useAgentsStoreOptional).mockReturnValue(null);
    // @ts-expect-error — partial store value
    vi.mocked(useAssistantStoreOptional).mockReturnValue({
      chatSessions: [{ id: 'chat-3', createdAt: 1, updatedAt: 2, messageCount: 0 }],
    });

    const { result } = renderHook(() => useLazyManagerStore(), { wrapper });
    expect(result.current.sessions.find((s) => s.id === 'chat-3')?.preview).toBe('');
  });

  it('ignores malformed localStorage content instead of throwing', () => {
    vi.mocked(useAgentsStoreOptional).mockReturnValue(null);
    // @ts-expect-error — partial store value
    vi.mocked(useAssistantStoreOptional).mockReturnValue({
      chatSessions: [{ id: 'chat-4', createdAt: 1, updatedAt: 2, messageCount: 0 }],
    });
    localStorage.setItem(CHAT_SESSIONS_KEY, '{not json');

    expect(() => renderHook(() => useLazyManagerStore(), { wrapper })).not.toThrow();
  });
});
