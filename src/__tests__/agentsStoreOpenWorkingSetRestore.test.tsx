/**
 * Item 1 fix — open-conversation working-set persistence (real user QA,
 * 2026-08-01, verbatim: "worse than not having tabs" — every open
 * conversation silently vanished on restart while a mission chain launched
 * from one of them kept running unattended in the background).
 *
 * Wave 1 (multi-conversation LazyManager) only ever persisted each
 * conversation's OWN transcript/pendingApprovals (`lazy.managerSessions`,
 * managerPersistence.ts) — WHICH conversations were open, in what order,
 * and which was active never left React state, so `lazy.managerOpenSessions`
 * (the key this fix introduces) simply did not exist and every restart
 * collapsed back to exactly one conversation.
 *
 * These tests seed localStorage directly with EXACTLY the shape a real app
 * instance would have written before closing (both `lazy.managerSessions`
 * and `lazy.managerOpenSessions`), then mount a FRESH AgentsStoreProvider —
 * the same "simulate a reload by seeding storage, then mount fresh" style
 * managerPersistence.test.ts already uses for its own load-path coverage —
 * and assert the live restored state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import type { ManagerAction, ManagerMessage } from '../lib/agents/types';

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

const SESSIONS_KEY = 'lazy.managerSessions';
const OPEN_KEY = 'lazy.managerOpenSessions';

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function msg(id: string, role: ManagerMessage['role'], content: string): ManagerMessage {
  return { id, role, content, timestamp: new Date(2026, 0, 1).toISOString() };
}

// Same residue-leak concern managerPersistence.test.ts's own beforeEach/
// afterEach doc comment calls out: a session left on disk by one test can
// get auto-restored by the NEXT suite's own AgentsStoreProvider mount.
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe('AgentsStoreProvider — open-conversation working-set restore (item 1)', () => {
  it('restores 2+ open conversations on a fresh mount, each with its own transcript and pending approvals', () => {
    const idA = 'manager-100-aaa';
    const idB = 'manager-200-bbb';
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([
      {
        id: idA,
        createdAt: 1,
        updatedAt: 1,
        messages: [
          msg('a1', 'user', 'plan the installer packaging'),
          msg('a2', 'assistant', 'sure, here is a plan'),
        ],
        pendingApprovals: [],
      },
      {
        id: idB,
        createdAt: 2,
        updatedAt: 2,
        messages: [msg('b1', 'user', 'check the brain for X')],
        pendingApprovals: [{
          id: 'pa1',
          action: { type: 'info', message: 'x' } as ManagerAction,
          label: 'Deferred action',
          turnId: 'turn-1',
          messageId: 'b1',
          actionIndex: 0,
          model: 'haiku',
          aliasEntries: [],
          createdAt: new Date(2026, 0, 1).toISOString(),
        }],
      },
    ]));
    // A was mid-turn when the app died (busyIds); B was idle.
    localStorage.setItem(OPEN_KEY, JSON.stringify({ order: [idA, idB], activeId: idB, busyIds: [idA] }));

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    expect(result.current.conversationOrder).toEqual([idA, idB]);
    expect(result.current.activeConversationId).toBe(idB);

    const convA = result.current.conversations[idA]!;
    expect(convA.messages.map((m) => m.content).slice(0, 2)).toEqual([
      'plan the installer packaging',
      'sure, here is a plan',
    ]);
    // Never silently pretends the interrupted turn is still working: comes
    // back idle, with an honest system-chip marker appended.
    expect(convA.busy).toBe(false);
    expect(convA.phase).toBe('idle');
    expect(convA.messages.at(-1)?.role).toBe('system');
    expect(convA.messages.at(-1)?.content.length).toBeGreaterThan(0);

    const convB = result.current.conversations[idB]!;
    expect(convB.messages.map((m) => m.content)).toEqual(['check the brain for X']);
    expect(convB.busy).toBe(false);
    expect(convB.phase).toBe('idle');
    // B was never busy — no interrupted marker for it.
    expect(convB.messages.some((m) => m.role === 'system')).toBe(false);
    // Its own pending approval came back too, not just its transcript.
    expect(convB.pendingApprovals).toHaveLength(1);
    expect(convB.pendingApprovals[0]!.label).toBe('Deferred action');
    expect(convB.pendingApprovals[0]!.messageId).toBe('b1');
  });

  it('never resurrects a conversation whose session was deleted from history', () => {
    const idLive = 'manager-300-live';
    const idDeleted = 'manager-400-deleted';
    localStorage.setItem(SESSIONS_KEY, JSON.stringify([
      { id: idLive, createdAt: 1, updatedAt: 1, messages: [msg('l1', 'user', 'still here')], pendingApprovals: [] },
      // idDeleted intentionally has NO matching session entry here — the
      // user deleted it from history after the working set was last saved.
    ]));
    localStorage.setItem(OPEN_KEY, JSON.stringify({ order: [idDeleted, idLive], activeId: idDeleted, busyIds: [] }));

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    expect(result.current.conversationOrder).toEqual([idLive]);
    expect(Object.keys(result.current.conversations)).not.toContain(idDeleted);
    // The deleted id was the persisted active tab — falls back to the one
    // conversation that actually survived, never a dangling reference.
    expect(result.current.activeConversationId).toBe(idLive);
  });

  it('a first boot with no persisted working set behaves exactly as before this fix: one fresh conversation', () => {
    // No lazy.managerOpenSessions key at all — first boot, or any boot from
    // before this fix ever shipped.
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    expect(result.current.conversationOrder).toHaveLength(1);
    const onlyId = result.current.conversationOrder[0]!;
    expect(result.current.activeConversationId).toBe(onlyId);
    expect(result.current.conversations[onlyId]!.messages).toEqual([]);
  });
});
