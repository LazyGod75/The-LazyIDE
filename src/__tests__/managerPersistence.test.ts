/**
 * managerPersistence — LazyManager rail history (save/load/delete/cap).
 * Mirrors the shape lib/ai/chatPersistence.ts would be tested with, adapted
 * for the manager's global (not per-project) session scope.
 *
 * ID-EAGER SHAPE (multi-conversation LazyManager, wave 1): `saveMessages`
 * takes an explicit `sessionId` supplied by the caller on every call — this
 * hook no longer owns an internal `currentSessionId` slot, mints nothing
 * implicitly, and has no `newSession`/`flushAndSwitch` primitive (see
 * managerPersistence.ts's own module doc comment for why: several
 * conversations are live at once now, each with its OWN id, so there is no
 * single "current session" slot left for this hook to own).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useManagerPersistence,
  mintManagerSessionId,
  capManagerSessions,
  MAX_MANAGER_SESSIONS,
  type ManagerSession,
} from '../lib/agents/managerPersistence';
import { capManagerMessages, MAX_MANAGER_MESSAGES } from '../lib/agents/missionCaps';
import type { ManagerMessage } from '../lib/agents/types';

const STORAGE_KEY = 'lazy.managerSessions';

function makeMessages(count: number): ManagerMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }));
}

beforeEach(() => {
  localStorage.clear();
});

// Every test in this file writes REAL data to localStorage's
// 'lazy.managerSessions' key (via the real useManagerPersistence hook, not a
// mock) — the "caps the total session count" test alone leaves up to
// MAX_MANAGER_SESSIONS real sessions on disk. Without this, that residue
// outlives the file's last test and can leak into whichever OTHER suite
// mounts AgentsStoreProvider next (its mount-only restore effect in
// agentsStore.tsx auto-loads the most recently updated persisted
// conversation), corrupting that suite's message counts/history rows — see
// LazyManagerRail.history.test.tsx's own defensive beforeEach for the victim
// side of this same fix.
afterEach(() => {
  localStorage.clear();
});

describe('mintManagerSessionId', () => {
  it('returns a unique id on every call', () => {
    const a = mintManagerSessionId();
    const b = mintManagerSessionId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('useManagerPersistence — save/load/delete (id-eager)', () => {
  it('starts with no sessions when localStorage is empty', () => {
    const { result } = renderHook(() => useManagerPersistence());
    expect(result.current.sessions).toEqual([]);
  });

  it('saveMessages(id, ...) creates a new session under that exact id on first call, and updates it in place on subsequent calls with the SAME id', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();

    act(() => { result.current.saveMessages(id, makeMessages(1)); });
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe(id);

    act(() => { result.current.saveMessages(id, makeMessages(2)); });
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe(id);
    expect(result.current.sessions[0].messages).toHaveLength(2);
  });

  it('saveMessages with a DIFFERENT id creates a SECOND, independent session — the id-eager multi-conversation shape', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const idA = mintManagerSessionId();
    const idB = mintManagerSessionId();

    act(() => { result.current.saveMessages(idA, makeMessages(1)); });
    act(() => { result.current.saveMessages(idB, makeMessages(2)); });

    expect(result.current.sessions).toHaveLength(2);
    const sessionA = result.current.sessions.find((s) => s.id === idA);
    const sessionB = result.current.sessions.find((s) => s.id === idB);
    expect(sessionA?.messages).toHaveLength(1);
    expect(sessionB?.messages).toHaveLength(2);
  });

  it('saveMessages with an empty array is a no-op (never mints an empty session)', () => {
    const { result } = renderHook(() => useManagerPersistence());
    act(() => { result.current.saveMessages(mintManagerSessionId(), []); });
    expect(result.current.sessions).toEqual([]);
  });

  it('persists to localStorage under lazy.managerSessions', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();
    act(() => { result.current.saveMessages(id, makeMessages(1)); });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as ManagerSession[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(id);
    expect(parsed[0].messages).toHaveLength(1);
  });

  it('loadSession returns the messages and rehydrates across a remount (real localStorage round-trip)', () => {
    const { result, unmount } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();
    act(() => { result.current.saveMessages(id, makeMessages(3)); });
    unmount();

    const { result: second } = renderHook(() => useManagerPersistence());
    expect(second.current.sessions).toHaveLength(1);
    // loadSession returns BOTH the messages and the session's own
    // pendingApprovals (never just messages — see managerPersistence.ts's
    // own doc comment: a restored conversation without its pendingApprovals
    // would show the right chat but never bring back the approval card).
    let loaded: { messages: ManagerMessage[]; pendingApprovals: unknown[] } | null = null;
    act(() => { loaded = second.current.loadSession(id); });
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(3);
    expect(loaded!.pendingApprovals).toEqual([]);
  });

  it('loadSession returns null for an unknown id', () => {
    const { result } = renderHook(() => useManagerPersistence());
    let loaded: { messages: ManagerMessage[] } | null | undefined;
    act(() => { loaded = result.current.loadSession('does-not-exist'); });
    expect(loaded).toBeNull();
  });

  it('deleteSession removes the session from state and localStorage', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();
    act(() => { result.current.saveMessages(id, makeMessages(1)); });

    act(() => { result.current.deleteSession(id); });
    expect(result.current.sessions).toEqual([]);
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    expect(raw).toEqual([]);
  });

  it('saveMessages persists an optional `title` (rename feature) and loadSession returns it back', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();
    act(() => { result.current.saveMessages(id, makeMessages(1), [], 'My renamed chat'); });
    expect(result.current.sessions[0].title).toBe('My renamed chat');

    let loaded: { messages: ManagerMessage[]; pendingApprovals: unknown[]; title?: string } | null = null;
    act(() => { loaded = result.current.loadSession(id); });
    expect(loaded!.title).toBe('My renamed chat');
  });

  it('a later saveMessages call without a title clears a previously-set one (the "empty the rename input" un-rename contract — caller always supplies the authoritative current value)', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();
    act(() => { result.current.saveMessages(id, makeMessages(1), [], 'Named once'); });
    expect(result.current.sessions[0].title).toBe('Named once');

    act(() => { result.current.saveMessages(id, makeMessages(2), [], undefined); });
    expect(result.current.sessions[0].title).toBeUndefined();
  });

  it('saveMessages with the SAME id after deleteSession re-creates a fresh session under that exact id', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();
    act(() => { result.current.saveMessages(id, makeMessages(1)); });
    act(() => { result.current.deleteSession(id); });

    act(() => { result.current.saveMessages(id, makeMessages(2)); });
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe(id);
    expect(result.current.sessions[0].messages).toHaveLength(2);
  });
});

describe('useManagerPersistence — corrupted/hand-edited storage', () => {
  it('drops a session missing required fields instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: 'ok', messages: [], createdAt: 1, updatedAt: 1 },
      { id: 'broken' }, // missing createdAt/updatedAt
      'not-even-an-object',
    ]));
    const { result } = renderHook(() => useManagerPersistence());
    // sanitizeSession always normalizes pendingApprovals to an array (`[]`
    // when the persisted entry never had one — see PersistedPendingApproval's
    // own doc comment on backward compatibility with older sessions).
    expect(result.current.sessions).toEqual([{ id: 'ok', messages: [], createdAt: 1, updatedAt: 1, pendingApprovals: [] }]);
  });

  it('drops individual messages missing required fields but keeps the well-formed ones', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      {
        id: 's1',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          { id: 'a', role: 'user', content: 'hi', timestamp: 't1' },
          { id: 'b', role: 'not-a-role', content: 'bad role', timestamp: 't2' },
          { role: 'user', content: 'missing id', timestamp: 't3' },
        ],
      },
    ]));
    const { result } = renderHook(() => useManagerPersistence());
    expect(result.current.sessions[0].messages).toEqual([
      { id: 'a', role: 'user', content: 'hi', timestamp: 't1' },
    ]);
  });

  it('rehydrates a pending graph proposal with its topology intact', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      {
        id: 's1',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: 'proposal',
            role: 'assistant',
            content: 'Plan ready',
            timestamp: 't1',
            proposal: {
              state: 'pending',
              planId: 'orch-1',
              objective: 'Ship the graph preview',
              steps: [
                { id: 'research', description: 'Research', joinGroup: 'parallel' },
                { id: 'audit', description: 'Audit', joinGroup: 'parallel' },
                { id: 'deliver', description: 'Deliver', dependsOn: ['research', 'audit'] },
              ],
            },
          },
        ],
      },
    ]));

    const { result } = renderHook(() => useManagerPersistence());
    const proposal = result.current.sessions[0].messages[0].proposal;

    expect(proposal).toMatchObject({ state: 'pending', planId: 'orch-1', objective: 'Ship the graph preview' });
    expect(proposal?.steps).toHaveLength(3);
    expect(proposal?.steps[2].dependsOn).toEqual(['research', 'audit']);
  });

  it('rehydrates a persisted `title` (rename feature), and treats a blank/whitespace-only one as absent', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { id: 's1', createdAt: 1, updatedAt: 1, messages: [], title: 'Named session' },
      { id: 's2', createdAt: 1, updatedAt: 1, messages: [], title: '   ' },
      { id: 's3', createdAt: 1, updatedAt: 1, messages: [] },
    ]));
    const { result } = renderHook(() => useManagerPersistence());
    expect(result.current.sessions.find((s) => s.id === 's1')?.title).toBe('Named session');
    expect(result.current.sessions.find((s) => s.id === 's2')?.title).toBeUndefined();
    expect(result.current.sessions.find((s) => s.id === 's3')?.title).toBeUndefined();
  });

  it('returns an empty list rather than throwing when the stored JSON is malformed', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    const { result } = renderHook(() => useManagerPersistence());
    expect(result.current.sessions).toEqual([]);
  });

  it('keeps only known ManagerMessage fields on rehydrate (drops unknown/foreign fields)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      {
        id: 's1',
        createdAt: 1,
        updatedAt: 1,
        messages: [
          {
            id: 'a',
            role: 'assistant',
            content: 'hi',
            timestamp: 't1',
            approxCreditsUsed: 3,
            somethingUnexpected: () => 'a function-like field, never valid JSON in real storage',
            futureField: 'not part of ManagerMessage today',
          },
        ],
      },
    ]));
    const { result } = renderHook(() => useManagerPersistence());
    expect(result.current.sessions[0].messages[0]).toEqual({
      id: 'a',
      role: 'assistant',
      content: 'hi',
      timestamp: 't1',
      approxCreditsUsed: 3,
    });
  });
});

describe('capManagerSessions', () => {
  function makeSessions(count: number): ManagerSession[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      messages: [],
      createdAt: i,
      updatedAt: i,
    }));
  }

  it('is a no-op when within budget', () => {
    const sessions = makeSessions(5);
    expect(capManagerSessions(sessions)).toEqual(sessions);
  });

  it('keeps only the most recently updated MAX_MANAGER_SESSIONS entries', () => {
    const sessions = makeSessions(MAX_MANAGER_SESSIONS + 10);
    const capped = capManagerSessions(sessions);
    expect(capped).toHaveLength(MAX_MANAGER_SESSIONS);
    // The oldest-updated sessions (lowest updatedAt) are the ones dropped.
    expect(capped.map((s) => s.id)).not.toContain('s0');
    expect(capped.map((s) => s.id)).toContain(`s${MAX_MANAGER_SESSIONS + 9}`);
  });

  it('saveMessages caps a session at MAX_MANAGER_MESSAGES (same cap agentsStore.tsx applies live)', () => {
    const { result } = renderHook(() => useManagerPersistence());
    const id = mintManagerSessionId();
    act(() => { result.current.saveMessages(id, makeMessages(MAX_MANAGER_MESSAGES + 20)); });
    expect(result.current.sessions[0].messages).toHaveLength(MAX_MANAGER_MESSAGES);
    // Keep-LAST semantics (matches capManagerMessages directly).
    const expected = capManagerMessages(makeMessages(MAX_MANAGER_MESSAGES + 20));
    expect(result.current.sessions[0].messages.map((m) => m.id)).toEqual(expected.map((m) => m.id));
  });

  it('saveMessages caps the total session count at MAX_MANAGER_SESSIONS', () => {
    const { result } = renderHook(() => useManagerPersistence());
    for (let i = 0; i < MAX_MANAGER_SESSIONS + 5; i++) {
      // Id-eager shape: each iteration mints its OWN distinct id and saves
      // under it directly — no newSession()/currentSessionId reset dance
      // needed (that concept no longer exists, see this file's own header
      // comment), since each id is independent from the start.
      const id = mintManagerSessionId();
      act(() => { result.current.saveMessages(id, makeMessages(1)); });
    }
    expect(result.current.sessions.length).toBeLessThanOrEqual(MAX_MANAGER_SESSIONS);
  });
});
