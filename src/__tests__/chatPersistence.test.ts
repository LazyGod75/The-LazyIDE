/**
 * chatPersistence — Code assistant (Codeur) history (save/load/delete/
 * flushAndSwitch). Mirrors managerPersistence.test.ts's shape, adapted for
 * the coder side's own contract.
 *
 * Covers the 3 defects fixed on this module:
 *  - DEFECT 1: saveMessages/projectSessions no longer no-op on a falsy
 *    projectRoot (previously the coder's history was a hard no-op whenever
 *    no project was open, which the cockpit never requires).
 *  - DEFECT 3: flushAndSwitch persists the OUTGOING conversation atomically
 *    with switching sessions, so "Nouvelle conversation" never silently
 *    drops an in-flight exchange.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useChatPersistence,
  capChatSessions,
  MAX_CHAT_SESSIONS,
  MAX_CHAT_MESSAGES,
  type ChatSession,
} from '../lib/ai/chatPersistence';

const STORAGE_KEY = 'lazy.chatSessions';

function makeMessages(count: number): Array<{ id: string; role: 'user' | 'assistant'; content: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
  }));
}

beforeEach(() => {
  localStorage.clear();
});

describe('useChatPersistence — save/load/delete', () => {
  it('starts with no sessions when localStorage is empty', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    expect(result.current.projectSessions).toEqual([]);
  });

  it('saveMessages persists even with a falsy ("") projectRoot (DEFECT 1)', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.saveMessages(makeMessages(1)); });

    expect(result.current.projectSessions).toHaveLength(1);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as ChatSession[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].projectRoot).toBe('');
  });

  it('saveMessages persists even with a null projectRoot (DEFECT 1)', () => {
    const { result } = renderHook(() => useChatPersistence(null));
    act(() => { result.current.saveMessages(makeMessages(1)); });

    expect(result.current.projectSessions).toHaveLength(1);
  });

  it('saveMessages mints a new session on first save and updates it on subsequent saves', () => {
    const { result } = renderHook(() => useChatPersistence(''));

    act(() => { result.current.saveMessages(makeMessages(1)); });
    const firstId = result.current.projectSessions[0].id;

    act(() => { result.current.saveMessages(makeMessages(2)); });
    expect(result.current.projectSessions).toHaveLength(1);
    expect(result.current.projectSessions[0].id).toBe(firstId);
    expect(result.current.projectSessions[0].messages).toHaveLength(2);
  });

  it('saveMessages with an empty array is a no-op (never mints an empty session)', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.saveMessages([]); });
    expect(result.current.projectSessions).toEqual([]);
  });

  it('projectSessions lists ALL sessions regardless of their projectRoot, including a mix of falsy and real project roots (DEFECT 1)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: 'a', projectRoot: '', messages: [], createdAt: 1, updatedAt: 1 },
      { id: 'b', projectRoot: '/some/project', messages: [], createdAt: 2, updatedAt: 2 },
      { id: 'c', projectRoot: '/other/project', messages: [], createdAt: 3, updatedAt: 3 },
    ]));
    const { result } = renderHook(() => useChatPersistence('/some/project'));
    expect(result.current.projectSessions.map(s => s.id).sort()).toEqual(['a', 'b', 'c']);

    // Also true when no project is open at all.
    const { result: noProject } = renderHook(() => useChatPersistence(''));
    expect(noProject.current.projectSessions.map(s => s.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('loadSession returns the messages and rehydrates across a remount (real localStorage round-trip)', () => {
    const { result, unmount } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.saveMessages(makeMessages(3)); });
    const sessionId = result.current.projectSessions[0].id;
    unmount();

    const { result: second } = renderHook(() => useChatPersistence(''));
    expect(second.current.projectSessions).toHaveLength(1);
    let loaded: ReturnType<typeof result.current.loadSession> = null;
    act(() => { loaded = second.current.loadSession(sessionId); });
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(3);
  });

  it('loadSession returns null for an unknown id', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    let loaded: ReturnType<typeof result.current.loadSession> | undefined;
    act(() => { loaded = result.current.loadSession('does-not-exist'); });
    expect(loaded).toBeNull();
  });

  it('deleteSession removes the session from state and localStorage', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.saveMessages(makeMessages(1)); });
    const id = result.current.projectSessions[0].id;

    act(() => { result.current.deleteSession(id); });
    expect(result.current.projectSessions).toEqual([]);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    expect(raw).toEqual([]);
  });

  it('loads an old, backward-compatible stored session shape (truthy projectRoot, no new fields) unchanged', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      {
        id: 'legacy-1',
        projectRoot: '/legacy/project',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        createdAt: 1,
        updatedAt: 1,
      },
    ]));
    const { result } = renderHook(() => useChatPersistence('/legacy/project'));
    expect(result.current.projectSessions).toEqual([
      {
        id: 'legacy-1',
        projectRoot: '/legacy/project',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
  });
});

describe('useChatPersistence — flushAndSwitch (DEFECT 3: no message loss on switch)', () => {
  it('flushes the outgoing conversation into its own session before switching to a fresh one (nextSessionId=null)', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    const outgoing = makeMessages(2);

    act(() => { result.current.flushAndSwitch(outgoing, null); });

    // The outgoing conversation was saved, not dropped.
    expect(result.current.projectSessions).toHaveLength(1);
    expect(result.current.projectSessions[0].messages).toHaveLength(2);
    expect(result.current.currentSessionId).toBeNull();

    // The NEXT save starts a genuinely new session rather than appending.
    act(() => { result.current.saveMessages(makeMessages(1)); });
    expect(result.current.projectSessions).toHaveLength(2);
  });

  it('flushes the outgoing conversation and atomically switches currentSessionId to an existing session (no lost race)', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.saveMessages(makeMessages(1)); });
    const targetId = result.current.projectSessions[0].id;

    act(() => { result.current.newSession(); });
    const outgoing = makeMessages(3);
    act(() => { result.current.flushAndSwitch(outgoing, targetId); });

    // Outgoing conversation persisted into its own (new) session...
    expect(result.current.projectSessions).toHaveLength(2);
    const outgoingSession = result.current.projectSessions.find(s => s.id !== targetId);
    expect(outgoingSession?.messages).toHaveLength(3);
    // ...and currentSessionId now points at the target, in the SAME call.
    expect(result.current.currentSessionId).toBe(targetId);
  });

  it('flushAndSwitch with an empty outgoing conversation just switches, without minting an empty session', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.flushAndSwitch([], null); });
    expect(result.current.projectSessions).toEqual([]);
    expect(result.current.currentSessionId).toBeNull();
  });
});

// ── Caps (mirrors managerPersistence.test.ts's capManagerSessions suite) ──
//
// AssistantStoreProvider is mounted ONCE for the app's whole lifetime with
// no session-count cap and no per-session message cap before this fix — see
// chatPersistence.ts's own module doc comment.

describe('capChatSessions', () => {
  function makeSessions(count: number): ChatSession[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      projectRoot: '',
      messages: [],
      createdAt: i,
      updatedAt: i,
    }));
  }

  it('is a no-op when within budget', () => {
    const sessions = makeSessions(5);
    expect(capChatSessions(sessions)).toEqual(sessions);
  });

  it('keeps only the most recently updated MAX_CHAT_SESSIONS entries', () => {
    const sessions = makeSessions(MAX_CHAT_SESSIONS + 10);
    const capped = capChatSessions(sessions);
    expect(capped).toHaveLength(MAX_CHAT_SESSIONS);
    // The oldest-updated sessions (lowest updatedAt) are the ones dropped.
    expect(capped.map((s) => s.id)).not.toContain('s0');
    expect(capped.map((s) => s.id)).toContain(`s${MAX_CHAT_SESSIONS + 9}`);
  });

  it('saveMessages caps a session at MAX_CHAT_MESSAGES', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.saveMessages(makeMessages(MAX_CHAT_MESSAGES + 20)); });
    expect(result.current.projectSessions[0].messages).toHaveLength(MAX_CHAT_MESSAGES);
    // Keep-LAST semantics — the earliest messages are the ones dropped.
    const ids = result.current.projectSessions[0].messages.map((m) => m.id);
    expect(ids[0]).toBe(`m${20}`);
    expect(ids[ids.length - 1]).toBe(`m${MAX_CHAT_MESSAGES + 19}`);
  });

  it('saveMessages caps the total session count at MAX_CHAT_SESSIONS', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    for (let i = 0; i < MAX_CHAT_SESSIONS + 5; i++) {
      // Two separate act() calls (not one) so the second reads a
      // freshly-rerendered `result.current` with currentSessionId already
      // reset to null by newSession() — otherwise saveMessages would use a
      // stale closure and keep appending to the SAME session (same
      // reasoning as managerPersistence.test.ts's identical loop).
      act(() => { result.current.newSession(); });
      act(() => { result.current.saveMessages(makeMessages(1)); });
    }
    expect(result.current.projectSessions.length).toBeLessThanOrEqual(MAX_CHAT_SESSIONS);
  });

  it('flushAndSwitch also caps the flushed session at MAX_CHAT_MESSAGES', () => {
    const { result } = renderHook(() => useChatPersistence(''));
    act(() => { result.current.flushAndSwitch(makeMessages(MAX_CHAT_MESSAGES + 20), null); });
    expect(result.current.projectSessions).toHaveLength(1);
    expect(result.current.projectSessions[0].messages).toHaveLength(MAX_CHAT_MESSAGES);
  });
});
