/**
 * closeManagerConversation — the tab-strip "close a conversation" affordance
 * (real user report, 2026-08-02 QA, verbatim: "je ne vois pas ... [de bouton
 * pour] fermer quand yen a plusieurs d'ouverte" — 13 tabs open, zero close
 * buttons anywhere). agentsStore.tsx's own doc comment on
 * closeManagerConversation lays out the contract this file pins down:
 *
 *   1. Closing is NOT deleting — the conversation's persisted session
 *      (`lazy.managerSessions`) survives, reachable from history.
 *   2. Closing the ACTIVE tab activates a neighbour, never a blank panel.
 *   3. Closing the LAST open conversation leaves a fresh empty one, never a
 *      dead, tab-less panel.
 *   4. A BUSY conversation is never silently killed: its in-flight turn is
 *      genuinely stopped (real AbortController abort, proven via the mock's
 *      own abort-signal listener, same technique
 *      agentsStoreConcurrentConversations.test.tsx uses for the plain Stop
 *      button), and an honest "interrompu" bubble lands in its (still
 *      reachable) persisted transcript.
 *
 * Real AgentsStoreProvider (not a mocked store), same convention as
 * agentsStoreConcurrentConversations.test.tsx / agentsStoreOpenWorkingSetRestore
 * .test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore, MAX_OPEN_MANAGER_CONVERSATIONS } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import type { ManagerTurnResult } from '../lib/agents/managerEngine';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
  captureConversationSummary: vi.fn(),
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

const mockedRunManagerTurn = runManagerTurn as ReturnType<typeof vi.fn>;
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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  mockedRunManagerTurn.mockReset();
});

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('closeManagerConversation — closing vs. deleting', () => {
  it('removes the tab from the live order but keeps its history reachable in managerSessions and via loadManagerSession', async () => {
    mockedRunManagerTurn.mockResolvedValue({ responseText: 'ok', actions: [], rawResponse: '' } as ManagerTurnResult);
    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    const idA = result.current.activeConversationId;
    await act(async () => {
      await result.current.sendManagerMessage(idA, 'plan the release', 'haiku');
    });
    expect(result.current.conversations[idA]!.messages).toHaveLength(2);

    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;
    expect(idB).not.toBe(idA);

    // Close the BACKGROUND conversation (A) while B stays active — the
    // active tab must be completely unaffected.
    act(() => { result.current.closeManagerConversation(idA); });

    expect(result.current.conversationOrder).not.toContain(idA);
    expect(result.current.conversations[idA]).toBeUndefined();
    expect(result.current.activeConversationId).toBe(idB);

    // History (managerSessions) still knows about A — closing never deletes.
    await waitFor(() => {
      expect(result.current.managerSessions.some((s) => s.id === idA)).toBe(true);
    });

    // Reopening it from history brings back the SAME transcript, live again.
    act(() => { result.current.loadManagerSession(idA); });
    expect(result.current.conversationOrder).toContain(idA);
    expect(result.current.activeConversationId).toBe(idA);
    expect(result.current.conversations[idA]!.messages.map((m) => m.content)).toContain('plan the release');
  });

  it('closing the ACTIVE tab (the last one in the strip) activates its previous neighbour, never a blank panel', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const idA = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idC = result.current.activeConversationId;
    expect(result.current.conversationOrder).toEqual([idA, idB, idC]);

    // C is active and last in the strip.
    act(() => { result.current.closeManagerConversation(idC); });

    expect(result.current.conversationOrder).toEqual([idA, idB]);
    expect(result.current.activeConversationId).toBe(idB);
  });

  it('closing the ACTIVE tab in the MIDDLE of the strip activates the tab that shifts into its slot', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const idA = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idC = result.current.activeConversationId;
    expect(result.current.conversationOrder).toEqual([idA, idB, idC]);

    // Switch active back to B (the middle tab) before closing it.
    act(() => { result.current.setActiveConversationId(idB); });
    act(() => { result.current.closeManagerConversation(idB); });

    expect(result.current.conversationOrder).toEqual([idA, idC]);
    expect(result.current.activeConversationId).toBe(idC);
  });

  it('closing a BACKGROUND (non-active) tab never changes which conversation is active', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const idA = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;

    act(() => { result.current.closeManagerConversation(idA); });

    expect(result.current.conversationOrder).toEqual([idB]);
    expect(result.current.activeConversationId).toBe(idB);
  });

  it('closing the LAST remaining conversation leaves a fresh empty one, never a dead tab-less panel', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const onlyId = result.current.activeConversationId;
    expect(result.current.conversationOrder).toEqual([onlyId]);

    act(() => { result.current.closeManagerConversation(onlyId); });

    expect(result.current.conversationOrder).toHaveLength(1);
    const freshId = result.current.conversationOrder[0]!;
    expect(freshId).not.toBe(onlyId);
    expect(result.current.activeConversationId).toBe(freshId);
    expect(result.current.conversations[freshId]!.messages).toEqual([]);
    expect(result.current.conversations[freshId]!.busy).toBe(false);
  });

  it('a no-op for an id that is not currently open (e.g. already closed)', () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const onlyId = result.current.activeConversationId;
    const orderBefore = result.current.conversationOrder;

    act(() => { result.current.closeManagerConversation('not-a-real-id'); });

    expect(result.current.conversationOrder).toBe(orderBefore);
    expect(result.current.activeConversationId).toBe(onlyId);
  });
});

describe('closeManagerConversation — a BUSY conversation is never silently killed', () => {
  it('genuinely aborts the in-flight call (real AbortController) and leaves an honest "interrompu" bubble in the still-reachable persisted history', async () => {
    let rejectTurn!: (err: unknown) => void;
    mockedRunManagerTurn.mockImplementation(
      (opts: { signal?: AbortSignal }) => new Promise<ManagerTurnResult>((_resolve, reject) => {
        rejectTurn = reject;
        const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener('abort', onAbort);
      }),
    );

    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const idA = result.current.activeConversationId;

    let pending!: Promise<void>;
    act(() => { pending = result.current.sendManagerMessage(idA, 'longue tache', 'haiku'); });
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1));
    expect(result.current.conversations[idA]!.busy).toBe(true);

    act(() => { result.current.closeManagerConversation(idA); });
    await act(async () => { await pending; });

    // Genuinely stopped — never left running invisibly in the background
    // (the mock's own AbortSignal listener is what rejected the promise
    // above; if closeManagerConversation had merely hidden the tab, that
    // listener would never have fired and `pending` would still be
    // unsettled).
    void rejectTurn; // referenced only to document the mock's rejection path

    // The tab is gone from the live strip...
    expect(result.current.conversationOrder).not.toContain(idA);

    // ...but its history is NOT lost: the persisted session carries an
    // honest "interrompu" bubble as its last message, not a dangling
    // question with no reply.
    await waitFor(() => {
      const session = result.current.managerSessions.find((s) => s.id === idA);
      expect(session).toBeDefined();
    });
    act(() => { result.current.loadManagerSession(idA); });
    const reopened = result.current.conversations[idA]!;
    expect(reopened.messages.at(-1)?.content).toBe('Interrompu.');
    expect(reopened.messages.at(-1)?.timedOut).toBe(true);
    expect(reopened.busy).toBe(false);
  });
});

describe('closeManagerConversation — persisted open working set reflects the closure', () => {
  it('saveOpenWorkingSet (lazy.managerOpenSessions) drops the closed id immediately', async () => {
    const { result } = renderHook(() => useAgentsStore(), { wrapper });
    const idA = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;

    act(() => { result.current.closeManagerConversation(idA); });

    await waitFor(() => {
      const raw = localStorage.getItem(OPEN_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.order).toEqual([idB]);
      expect(parsed.order).not.toContain(idA);
    });
  });
});

describe('the open-conversation cap (MAX_OPEN_MANAGER_CONVERSATIONS) survives a restart even from a stale, over-cap persisted working set', () => {
  it('a persisted working set listing MORE ids than the cap (e.g. 13, from before this cap was enforced) is truncated to the cap on restore, never grown unbounded', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `manager-stale-${i}`);
    localStorage.setItem(
      SESSIONS_KEY,
      JSON.stringify(ids.map((id, i) => ({
        id, createdAt: i, updatedAt: i,
        messages: [{ id: `${id}-m1`, role: 'user', content: `msg ${i}`, timestamp: new Date(2026, 0, 1).toISOString() }],
        pendingApprovals: [],
      }))),
    );
    localStorage.setItem(OPEN_KEY, JSON.stringify({ order: ids, activeId: ids[0], busyIds: [] }));

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    expect(result.current.conversationOrder.length).toBeLessThanOrEqual(MAX_OPEN_MANAGER_CONVERSATIONS);
    expect(result.current.conversationOrder).toEqual(ids.slice(0, MAX_OPEN_MANAGER_CONVERSATIONS));
  });
});
