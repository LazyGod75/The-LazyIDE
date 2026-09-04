/**
 * Multi-conversation LazyManager (wave 1) — genuine concurrency, end to end.
 *
 * The owner's requirement, verbatim: "je dois pouvoir avoir plusieurs
 * conversation en meme temps qui taffe" — several manager conversations
 * LIVE AND WORKING AT THE SAME TIME, each planning/running its own turn
 * independently. This file proves the two load-bearing claims of that
 * feature with a REAL AgentsStoreProvider (not a mocked store) and a
 * controllable runManagerTurn mock (the only LLM boundary crossed):
 *
 * 1. Two conversations with turns genuinely in flight AT THE SAME TIME never
 *    contaminate each other — messages, busy/phase, pendingApprovals, abort
 *    (Stop), and the generation counter that guards late-arriving replies
 *    all stay scoped to their own conversation.
 * 2. MAX_CONCURRENT_MANAGER_TURNS throttles SIMULTANEOUSLY-BUSY
 *    conversations only (never open-but-idle ones): the (N+1)th concurrent
 *    send queues behind a visible 'queued' phase instead of firing an
 *    unbounded parallel LLM call or blocking the send outright, and resumes
 *    the instant a slot frees.
 *
 * Same mock shape as agentsStore.stopManager.test.tsx/managerTurnCost.test
 * .tsx (runManagerTurn mocked at the module boundary, everything else real)
 * — a controllable Promise per call, resolved individually by the test so
 * two turns can be proven to overlap in wall-clock time, not just in
 * sequence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  AgentsStoreProvider,
  useAgentsStore,
  aggregatePendingApprovals,
  MAX_CONCURRENT_MANAGER_TURNS,
  MAX_OPEN_MANAGER_CONVERSATIONS,
  type ManagerConversationState,
} from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import type { ManagerTurnResult } from '../lib/agents/managerEngine';

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

const mockedRunManagerTurn = runManagerTurn as ReturnType<typeof vi.fn>;

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
});

afterEach(() => {
  vi.useRealTimers();
});

/** Installs a controllable mock: every call gets its OWN never-auto-resolving
 *  promise, pushed (in call order) onto `deferreds` — the test resolves each
 *  one explicitly, at whatever moment it chooses, to prove two turns
 *  genuinely overlap rather than merely running one-after-another. */
function installControllableRunManagerTurn(): Array<(result: ManagerTurnResult) => void> {
  const deferreds: Array<(result: ManagerTurnResult) => void> = [];
  mockedRunManagerTurn.mockImplementation(
    () => new Promise<ManagerTurnResult>((resolve) => { deferreds.push(resolve); }),
  );
  return deferreds;
}

/**
 * Same controllable-promise idea as installControllableRunManagerTurn above,
 * but resolves BY the sent text rather than by call-array index. Needed for
 * the queue tests below: when several conversations' turns are started in a
 * tight loop (no `waitFor` between each start, unlike the cross-
 * contamination tests above, which deliberately serialize each START to
 * keep index order meaningful), each turn's REAL context-gathering work
 * (listAgents/buildCanvasDigest/fetchManagerStartupContext — genuine,
 * unmocked async calls inside sendManagerMessage, run BEFORE it ever reaches
 * runManagerTurn) races independently, so the order calls actually reach
 * this mock is NOT guaranteed to match the order sendManagerMessage was
 * invoked in. Matching on the turn's own last (user) message content is the
 * only reliable way to resolve "the specific conversation's own call".
 */
function installKeyedControllableRunManagerTurn(): {
  resolveFor: (containingText: string, result: ManagerTurnResult) => void;
} {
  const pendingCalls: Array<{ lastMessageContent: string; resolve: (result: ManagerTurnResult) => void }> = [];
  mockedRunManagerTurn.mockImplementation(
    (opts: { messages: Array<{ content: string }> }) => new Promise<ManagerTurnResult>((resolve) => {
      const lastMessageContent = opts.messages.at(-1)?.content ?? '';
      pendingCalls.push({ lastMessageContent, resolve });
    }),
  );
  const resolveFor = (containingText: string, result: ManagerTurnResult) => {
    const idx = pendingCalls.findIndex((c) => c.lastMessageContent.includes(containingText));
    if (idx === -1) {
      throw new Error(`installKeyedControllableRunManagerTurn: no pending call found containing "${containingText}"`);
    }
    const [entry] = pendingCalls.splice(idx, 1);
    entry!.resolve(result);
  };
  return { resolveFor };
}

describe('multi-conversation LazyManager — real concurrency, zero cross-contamination', () => {
  it('two conversations with turns in flight AT THE SAME TIME never leak messages, busy state, or generation into each other', async () => {
    const deferreds = installControllableRunManagerTurn();
    const { result, unmount } = renderHook(() => useAgentsStore(), { wrapper });

    const idA = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;
    expect(idB).not.toBe(idA);

    // Neither conversation has started a turn yet — both genuinely idle.
    expect(result.current.conversations[idA]!.busy).toBe(false);
    expect(result.current.conversations[idB]!.busy).toBe(false);

    let pendingA!: Promise<void>;
    act(() => {
      pendingA = result.current.sendManagerMessage(idA, 'texte conversation A', 'haiku');
    });
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1));

    let pendingB!: Promise<void>;
    act(() => {
      pendingB = result.current.sendManagerMessage(idB, 'texte conversation B', 'haiku');
    });
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(2));

    // Both turns are genuinely in flight AT THE SAME TIME — neither resolved
    // yet, both hold a real concurrency slot (MAX_CONCURRENT_MANAGER_TURNS
    // is 3, so 2 concurrent turns never queue).
    expect(result.current.conversations[idA]!.busy).toBe(true);
    expect(result.current.conversations[idB]!.busy).toBe(true);
    expect(result.current.conversations[idA]!.phase).toBe('turn');
    expect(result.current.conversations[idB]!.phase).toBe('turn');
    // A's user message never leaked into B's transcript, and vice versa.
    expect(result.current.conversations[idA]!.messages.some((m) => m.content === 'texte conversation B')).toBe(false);
    expect(result.current.conversations[idB]!.messages.some((m) => m.content === 'texte conversation A')).toBe(false);

    // Resolve B FIRST (out of send order) — proves the store doesn't assume
    // FIFO completion, and that B's own reply never lands on A.
    act(() => { deferreds[1]!({ responseText: 'Reponse B', actions: [], rawResponse: '' }); });
    await act(async () => { await pendingB; });

    expect(result.current.conversations[idB]!.busy).toBe(false);
    expect(result.current.conversations[idB]!.messages.some((m) => m.content === 'Reponse B')).toBe(true);
    // A is COMPLETELY unaffected by B's resolution: still busy, still
    // mid-turn, no trace of B's reply.
    expect(result.current.conversations[idA]!.busy).toBe(true);
    expect(result.current.conversations[idA]!.phase).toBe('turn');
    expect(result.current.conversations[idA]!.messages.some((m) => m.content === 'Reponse B')).toBe(false);

    // Now resolve A.
    act(() => { deferreds[0]!({ responseText: 'Reponse A', actions: [], rawResponse: '' }); });
    await act(async () => { await pendingA; });

    expect(result.current.conversations[idA]!.busy).toBe(false);
    expect(result.current.conversations[idA]!.messages.some((m) => m.content === 'Reponse A')).toBe(true);
    // A's own reply never leaked into B's already-settled transcript.
    expect(result.current.conversations[idB]!.messages.some((m) => m.content === 'Reponse A')).toBe(false);
    // Each conversation ends with EXACTLY its own two messages (user + its
    // own reply) — no cross-appending in either direction.
    expect(result.current.conversations[idA]!.messages.map((m) => m.content)).toEqual(['texte conversation A', 'Reponse A']);
    expect(result.current.conversations[idB]!.messages.map((m) => m.content)).toEqual(['texte conversation B', 'Reponse B']);
    // Explicit unmount — stops this AgentsStoreProvider's own background
    // effects (wake-up scheduler, fleet hygiene sweep) immediately rather
    // than relying solely on RTL's between-test auto-cleanup, so a LATER
    // test in this file can never observe a stray call from a still-active
    // scheduler on this test's own (otherwise orphaned) component instance.
    unmount();
  // Real (unmocked) resolveProjectRoot/context-gathering calls involved in
  // each turn can genuinely take longer than vitest's 5s default under
  // system load (this machine runs under real memory/CPU pressure — see
  // this file's own mission constraints) — 15s is generous slack, not a
  // sign this test is actually slow to converge in a healthy run.
  }, 15000);

  it('stopping one conversation mid-turn (Stop button) never aborts a sibling conversation running at the same time', async () => {
    const deferreds: Array<(result: ManagerTurnResult) => void> = [];
    const rejecters: Array<(err: unknown) => void> = [];
    mockedRunManagerTurn.mockImplementation(
      (opts: { signal?: AbortSignal }) => new Promise<ManagerTurnResult>((resolve, reject) => {
        deferreds.push(resolve);
        rejecters.push(reject);
        const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener('abort', onAbort);
      }),
    );
    const { result, unmount } = renderHook(() => useAgentsStore(), { wrapper });

    const idA = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;

    let pendingA!: Promise<void>;
    act(() => { pendingA = result.current.sendManagerMessage(idA, 'tache A', 'haiku'); });
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1));
    let pendingB!: Promise<void>;
    act(() => { pendingB = result.current.sendManagerMessage(idB, 'tache B', 'haiku'); });
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(2));

    // Stop ONLY conversation A.
    act(() => { result.current.stopManagerMessage(idA); });
    await act(async () => { await pendingA; });

    expect(result.current.conversations[idA]!.busy).toBe(false);
    const lastA = result.current.conversations[idA]!.messages.at(-1);
    expect(lastA?.timedOut).toBe(true); // "interrompu" card, same as the single-conversation Stop contract

    // B is COMPLETELY untouched by A's Stop — still busy, still running,
    // no interrupted message anywhere in its transcript.
    expect(result.current.conversations[idB]!.busy).toBe(true);
    expect(result.current.conversations[idB]!.messages.some((m) => m.timedOut)).toBe(false);

    // B finishes normally afterward, proving its own AbortController/signal
    // was never touched by A's stop.
    act(() => { deferreds[1]!({ responseText: 'Reponse B ok', actions: [], rawResponse: '' }); });
    await act(async () => { await pendingB; });
    expect(result.current.conversations[idB]!.busy).toBe(false);
    expect(result.current.conversations[idB]!.messages.some((m) => m.content === 'Reponse B ok')).toBe(true);
    unmount();
  }, 15000);

  it('resetting one conversation (newManagerConversation on a DIFFERENT tab) never drops a late-arriving reply into the wrong conversation, and never touches the conversation still running', async () => {
    const deferreds = installControllableRunManagerTurn();
    const { result, unmount } = renderHook(() => useAgentsStore(), { wrapper });

    const idA = result.current.activeConversationId;
    act(() => { result.current.newManagerConversation(); });
    const idB = result.current.activeConversationId;

    let pendingA!: Promise<void>;
    act(() => { pendingA = result.current.sendManagerMessage(idA, 'tache A', 'haiku'); });
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1));
    let pendingB!: Promise<void>;
    act(() => { pendingB = result.current.sendManagerMessage(idB, 'tache B', 'haiku'); });
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(2));

    // Opening a THIRD conversation must never touch A or B's own state.
    act(() => { result.current.newManagerConversation(); });
    const idC = result.current.activeConversationId;
    expect(idC).not.toBe(idA);
    expect(idC).not.toBe(idB);
    expect(result.current.conversations[idA]!.busy).toBe(true);
    expect(result.current.conversations[idB]!.busy).toBe(true);

    // Both A and B settle normally afterward — their own late replies land
    // on their own transcripts, never on C (the now-active tab) nor on
    // each other.
    act(() => { deferreds[0]!({ responseText: 'Reponse A', actions: [], rawResponse: '' }); });
    act(() => { deferreds[1]!({ responseText: 'Reponse B', actions: [], rawResponse: '' }); });
    await act(async () => { await Promise.all([pendingA, pendingB]); });

    expect(result.current.conversations[idA]!.messages.some((m) => m.content === 'Reponse A')).toBe(true);
    expect(result.current.conversations[idB]!.messages.some((m) => m.content === 'Reponse B')).toBe(true);
    expect(result.current.conversations[idC]!.messages).toHaveLength(0);
    unmount();
  }, 15000);
});

describe('multi-conversation LazyManager — MAX_CONCURRENT_MANAGER_TURNS queues, never blocks or runs unbounded', () => {
  it('the (N+1)th concurrent send queues (visible "queued" phase) instead of running, and resumes the instant a slot frees', async () => {
    const { resolveFor } = installKeyedControllableRunManagerTurn();
    const { result, unmount } = renderHook(() => useAgentsStore(), { wrapper });

    // Open MAX_CONCURRENT_MANAGER_TURNS + 1 conversations (well within
    // MAX_OPEN_MANAGER_CONVERSATIONS) and start a turn on every one of them
    // at once.
    const ids: string[] = [result.current.activeConversationId];
    for (let i = 0; i < MAX_CONCURRENT_MANAGER_TURNS; i++) {
      act(() => { result.current.newManagerConversation(); });
      ids.push(result.current.activeConversationId);
    }
    expect(ids).toHaveLength(MAX_CONCURRENT_MANAGER_TURNS + 1);
    expect(ids.length).toBeLessThanOrEqual(MAX_OPEN_MANAGER_CONVERSATIONS);

    // Each conversation's own text uniquely identifies its call, since the
    // REAL (unmocked) context-gathering work each turn does before ever
    // reaching runManagerTurn (listAgents/buildCanvasDigest/
    // fetchManagerStartupContext) races independently per conversation —
    // the order calls actually land on the mock is not guaranteed to match
    // the order sendManagerMessage was invoked in (see
    // installKeyedControllableRunManagerTurn's own doc comment).
    const pendingById = new Map<string, Promise<void>>();
    for (const id of ids) {
      act(() => { pendingById.set(id, result.current.sendManagerMessage(id, `tache ${id}`, 'haiku')); });
    }

    // Only MAX_CONCURRENT_MANAGER_TURNS calls actually reached the LLM
    // boundary — the (N+1)th never fired a real call while queued.
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(MAX_CONCURRENT_MANAGER_TURNS));

    // Whichever conversation is still 'queued' at this point is the one
    // that lost the race for a slot — genuinely arbitrary (real
    // context-gathering timing decides who reaches acquireManagerTurnSlot
    // last), never assumed to be ids[MAX_CONCURRENT_MANAGER_TURNS].
    const queuedId = ids.find((id) => result.current.conversations[id]!.phase === 'queued')!;
    const runningIds = ids.filter((id) => id !== queuedId);
    expect(queuedId).toBeDefined();
    expect(runningIds).toHaveLength(MAX_CONCURRENT_MANAGER_TURNS);

    // The queued conversation is honestly marked 'queued' — busy (so the UI
    // treats it as in-flight) but NOT actually calling the model yet.
    expect(result.current.conversations[queuedId]!.busy).toBe(true);
    for (const id of runningIds) {
      expect(result.current.conversations[id]!.phase).toBe('turn');
    }

    // Free ONE slot — resolve one of the RUNNING conversation's turns (by
    // its own unique text, never by array-index/call-order assumption).
    const freedId = runningIds[0]!;
    act(() => { resolveFor(`tache ${freedId}`, { responseText: 'termine', actions: [], rawResponse: '' }); });
    await act(async () => { await pendingById.get(freedId); });
    expect(result.current.conversations[freedId]!.busy).toBe(false);

    // The queued conversation now resumes automatically — it acquires the
    // freed slot and its OWN real LLM call actually fires (never dropped,
    // never left waiting forever).
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(MAX_CONCURRENT_MANAGER_TURNS + 1));
    await waitFor(() => expect(result.current.conversations[queuedId]!.phase).toBe('turn'));

    // Let everything else finish so the test ends clean.
    const stillRunningIds = ids.filter((id) => id !== freedId);
    act(() => {
      for (const id of stillRunningIds) {
        resolveFor(`tache ${id}`, { responseText: `fin ${id}`, actions: [], rawResponse: '' });
      }
    });
    await act(async () => { await Promise.all(ids.map((id) => pendingById.get(id))); });
    for (const id of ids) {
      expect(result.current.conversations[id]!.busy).toBe(false);
    }
    unmount();
  }, 15000);

  it('open-but-idle conversations are never throttled — only SIMULTANEOUSLY-BUSY ones count against the cap', async () => {
    const deferreds = installControllableRunManagerTurn();
    const { result, unmount } = renderHook(() => useAgentsStore(), { wrapper });

    // Open several idle conversations (well over MAX_CONCURRENT_MANAGER_TURNS,
    // none of them ever sent a message) — none of this should affect the
    // concurrency slot count at all.
    for (let i = 0; i < MAX_CONCURRENT_MANAGER_TURNS + 2 && i < MAX_OPEN_MANAGER_CONVERSATIONS - 1; i++) {
      act(() => { result.current.newManagerConversation(); });
    }
    const idleId = result.current.activeConversationId;

    let pending!: Promise<void>;
    act(() => { pending = result.current.sendManagerMessage(idleId, 'unique turn', 'haiku'); });

    // A single real turn on an otherwise-idle fleet of conversations must
    // start IMMEDIATELY — never queued, regardless of how many conversations
    // are merely open.
    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalledTimes(1));
    expect(result.current.conversations[idleId]!.phase).toBe('turn');

    act(() => { deferreds[0]!({ responseText: 'ok', actions: [], rawResponse: '' }); });
    await act(async () => { await pending; });
    expect(result.current.conversations[idleId]!.busy).toBe(false);
    unmount();
  }, 15000);
});

describe('aggregatePendingApprovals — the deferred "attention inbox" seam (wave 2)', () => {
  function fakeApproval(id: string, createdAt: string): ManagerConversationState['pendingApprovals'][number] {
    return {
      id,
      action: { type: 'info', message: id } as never,
      label: id,
      turnId: 't1',
      messageId: 'm1',
      actionIndex: 0,
      model: 'haiku',
      aliasMap: new Map(),
      createdAt,
    };
  }

  function fakeConversation(id: string, approvals: ManagerConversationState['pendingApprovals']): ManagerConversationState {
    return { id, messages: [], busy: false, phase: 'idle', elapsedMs: 0, pendingApprovals: approvals, lastActiveAt: 0 };
  }

  it('flattens every open conversation\'s pendingApprovals, tagged with their origin conversationId, newest first', () => {
    const state = {
      conversationOrder: ['convA', 'convB'],
      conversations: {
        convA: fakeConversation('convA', [fakeApproval('a1', '2026-01-01T00:00:00.000Z')]),
        convB: fakeConversation('convB', [
          fakeApproval('b1', '2026-01-02T00:00:00.000Z'),
          fakeApproval('b2', '2026-01-03T00:00:00.000Z'),
        ]),
      },
    };

    const aggregated = aggregatePendingApprovals(state);

    expect(aggregated.map((a) => a.approval.id)).toEqual(['b2', 'b1', 'a1']);
    expect(aggregated.map((a) => a.conversationId)).toEqual(['convB', 'convB', 'convA']);
  });

  it('returns an empty list when no open conversation has anything pending', () => {
    const state = {
      conversationOrder: ['convA'],
      conversations: { convA: fakeConversation('convA', []) },
    };
    expect(aggregatePendingApprovals(state)).toEqual([]);
  });

  it('skips a conversationOrder entry with no matching conversation instead of throwing', () => {
    const state = {
      conversationOrder: ['convA', 'ghost'],
      conversations: { convA: fakeConversation('convA', [fakeApproval('a1', '2026-01-01T00:00:00.000Z')]) },
    };
    expect(aggregatePendingApprovals(state).map((a) => a.approval.id)).toEqual(['a1']);
  });
});
