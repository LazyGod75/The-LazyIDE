/* useManagerActionQueue — NEVER DEGRADE IN SILENCE for every card action in
   LazyManager.tsx (Validate/Reject a charter, answer a decision, pick/reject
   an artifact variant, accept/modify/reject a graph proposal, revert/stop a
   regime, retry a timed-out turn).

   BUG FIXED (real user test, 2026-07-28): every one of those call sites used
   to read `if (!store.busy) void store.send(...)` — clicking "Valider" (or
   any other card action) while the manager was mid-turn simply dropped the
   click on the floor. Worse, MissionCharterCard's own local-optimistic-
   resolution fix (see that file's doc comment) then flipped the card to
   "ACCEPTÉE" regardless, so the user believed their validation had gone
   through when the manager never received anything.

   This hook is the single mechanism every one of those call sites now goes
   through: `dispatch(key, run)` sends `run` immediately if the manager is
   free, or QUEUES it (preserving order, deduping a repeated click on the
   same action) to run the instant the manager frees up. Callers use the
   returned `ActionDispatchOutcome` to decide what to show:
   - 'sent'   — taken in charge immediately, safe to show the final result.
   - 'queued' — taken in charge, but not sent yet; show an explicit
                "waiting to send" state, NEVER the final result.
   - 'idle'   — could not be taken in charge (defensive: `run` itself threw
                synchronously) — the caller must stay actionable.

   SECOND BUG FIXED (real user test, 2026-07-28, round 2 — measured: third
   charter card clicked while busy shows "EN FILE D'ATTENTE", the manager
   frees up, the card flips to "ACCEPTÉE", but the user-message count in the
   conversation is IDENTICAL before and after the drain — nothing was ever
   received): the first fix above moved the drop from "click time" to
   "drain time" instead of removing it. `flush()` used to call
   `markStatus(key, 'sent')` unconditionally right after awaiting `run()`,
   even when `run()` had thrown (the surrounding try/catch swallowed it) —
   i.e. it promoted the VISUAL state on the mere fact that sending was
   ATTEMPTED, never confirming it actually SUCCEEDED. A card reading
   `isQueued(key)` flip to false has no way to tell "flushed and confirmed"
   apart from "flushed and silently failed".

   The fix: `run` now returns (sync or via Promise) `false` to explicitly
   report "no real effect happened" — every pre-existing caller that returns
   `void`/`undefined` (nothing explicit) still counts as success, so this is
   purely additive for any caller that predates the contract. Both the
   immediate-dispatch path and the queued-flush path route the settled
   result through `settleOutcome`, which records 'sent' ONLY when `run`
   neither threw/rejected nor explicitly returned `false`, and 'failed'
   otherwise. `isQueued(key)` never flips straight to a false "resolved" —
   for the QUEUED path specifically, the entry stays 'queued' (never
   optimistically promoted) until the real result is known, so a card can
   never observe "not queued anymore" without ALSO being able to check
   `isFailed(key)` to tell resolved apart from refused. The immediate path
   keeps its existing synchronous 'sent' return (every caller/test relies on
   this instant feedback when the manager is free) but is still corrected
   asynchronously via the same `settleOutcome` the instant the real result
   disagrees — see `isFailed`'s own doc comment.

   `isQueued(key)` is the reactive read side: a card's `queued` visual state
   should be recomputed from this on every render (not cached), so the
   instant the queued entry actually flushes, the card falls through to its
   own final (accepted/rejected) state on its very next render — no separate
   "promote" transition needed.

   `reset()` purges every not-yet-sent entry and forgets every recorded
   status — call it whenever the underlying conversation changes (new
   session, a different session loaded, mode switched to the other role) so
   a stale queued action never fires into a conversation the user is no
   longer looking at. */

import { useCallback, useEffect, useReducer, useRef } from 'react';

export type ActionDispatchOutcome = 'sent' | 'queued' | 'idle';

type QueueStatus = 'queued' | 'sent' | 'failed';

/** `false` is the only explicit failure signal a caller can return — a
 *  refused/no-op send. `true` or `void`/`undefined` (every pre-existing
 *  caller that predates this contract) both count as a confirmed success —
 *  see this module's own doc comment. */
type ActionRunResult = boolean | void;

interface QueueEntry {
  key: string;
  run: () => ActionRunResult | Promise<ActionRunResult>;
}

export interface ManagerActionQueue {
  /** Runs `run` now if the manager is free, otherwise queues it for the
   *  instant it frees up. `key` dedupes: once an action has been taken in
   *  charge (queued or sent), a repeated call with the same key is a no-op
   *  that just returns the existing status — a second rapid click never
   *  produces a second send. A key previously recorded as `isFailed` does
   *  NOT block a fresh attempt — see `isFailed`'s own doc comment. */
  dispatch: (key: string, run: () => ActionRunResult | Promise<ActionRunResult>) => ActionDispatchOutcome;
  /** Reactive: true while `key` is queued (taken in charge, not yet sent).
   *  Read this on every render rather than caching it — it flips to false
   *  the moment the entry actually flushes (either confirmed sent or
   *  confirmed failed — see `isFailed`). */
  isQueued: (key: string) => boolean;
  /** Reactive: true once `key`'s own action has SETTLED and its real result
   *  says it did NOT produce its effect (`run` returned `false`, or threw /
   *  its returned promise rejected). NEVER DEGRADE IN SILENCE (real user
   *  test, 2026-07-28, round 2): a card must treat this the same as `run`
   *  returning 'idle' synchronously — revert to its own actionable state
   *  and show why — instead of trusting `isQueued(key)` turning false to
   *  mean "resolved". Cleared the instant a fresh `dispatch` call is made
   *  for the same key (a retry is a brand new attempt, not blocked by the
   *  previous failure). */
  isFailed: (key: string) => boolean;
  /** Clears every queued entry and every recorded status — see this
   *  module's own doc comment for when to call it. */
  reset: () => void;
}

function buildKeyedKey(...parts: Array<string | number>): string {
  return parts.join(':');
}

export function charterActionKey(messageId: string): string {
  return buildKeyedKey('charter', messageId);
}

export function decisionActionKey(messageId: string, index: number): string {
  return buildKeyedKey('decision', messageId, index);
}

export function artifactActionKey(messageId: string): string {
  return buildKeyedKey('artifact', messageId);
}

export function proposalActionKey(planId: string): string {
  return buildKeyedKey('proposal', planId);
}

export function regimeActionKey(regimeId: string, action: 'revert' | 'stop'): string {
  return buildKeyedKey('regime', regimeId, action);
}

export function retryActionKey(messageId: string): string {
  return buildKeyedKey('retry', messageId);
}

/** Wraps a (possibly synchronously-throwing) `run` into a single Promise so
 *  both the immediate and queued paths can settle it through the exact same
 *  `settleOutcome` — a synchronous throw and an async rejection must be
 *  treated identically (both mean "no confirmed effect"). */
function invokeSafely(run: () => ActionRunResult | Promise<ActionRunResult>): Promise<ActionRunResult> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error as unknown);
  }
}

export function useManagerActionQueue(busy: boolean): ManagerActionQueue {
  // Refs, not state — the queue's own bookkeeping must never itself trigger
  // a render; `bump()` is the one deliberate signal that something visible
  // (a status a card reads) actually changed.
  const statusRef = useRef<Map<string, QueueStatus>>(new Map());
  const pendingRef = useRef<QueueEntry[]>([]);
  const flushingRef = useRef(false);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const markStatus = useCallback((key: string, status: QueueStatus) => {
    statusRef.current.set(key, status);
    bump();
  }, []);

  // SILENT-FALSE-POSITIVE FIX (see module doc comment): the ONLY place that
  // ever records 'sent' or 'failed' — never optimistic, always driven by
  // the real settled result of `pending`.
  const settleOutcome = useCallback(
    async (key: string, pending: Promise<ActionRunResult>): Promise<void> => {
      try {
        const result = await pending;
        markStatus(key, result === false ? 'failed' : 'sent');
      } catch {
        // Thrown/rejected — same "already surfaces via the store's own
        // error handling" convention this queue always had for failures;
        // this queue's own job is only to stop CLAIMING a success it
        // cannot back up.
        markStatus(key, 'failed');
      }
    },
    [markStatus],
  );

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      // Sequential, not Promise.all — the manager processes one turn at a
      // time, so a second queued send must wait for the first to actually
      // settle rather than racing it.
      while (pendingRef.current.length > 0) {
        const [next, ...rest] = pendingRef.current;
        pendingRef.current = rest;
        // The entry stays 'queued' (see dispatch below — nothing marks it
        // otherwise) for this entire await: a card reading isQueued(key)
        // keeps showing its own "waiting to send" state for the whole
        // in-flight window, then falls through, on the very next render,
        // to EITHER the resolved state (isQueued false, isFailed false) OR
        // the failure state (isQueued false, isFailed true) — never a false
        // "resolved" in between, regardless of how the real send turns out.
        await settleOutcome(next.key, invokeSafely(next.run));
      }
    } finally {
      flushingRef.current = false;
    }
  }, [settleOutcome]);

  // The moment the manager frees up, drain everything queued while it was
  // busy — this is the actual fix: a click made while busy reaches the
  // manager as soon as it can, instead of being dropped.
  useEffect(() => {
    if (!busy) void flush();
  }, [busy, flush]);

  const dispatch = useCallback(
    (key: string, run: () => ActionRunResult | Promise<ActionRunResult>): ActionDispatchOutcome => {
      const existing = statusRef.current.get(key);
      if (existing === 'queued' || existing === 'sent') return existing;
      // A recorded failure never blocks a retry — a fresh click is a brand
      // new attempt, not a repeat of the one that already failed. Clearing
      // it here (rather than leaving it until settleOutcome overwrites it)
      // means isFailed(key) drops immediately, in the SAME tick as the
      // retry click, instead of lagging behind.
      if (existing === 'failed') statusRef.current.delete(key);

      if (!busy) {
        let result: ActionRunResult | Promise<ActionRunResult>;
        try {
          result = run();
        } catch {
          return 'idle'; // could not be taken in charge — caller stays actionable
        }
        // Optimistic synchronous 'sent' — the pre-existing contract every
        // caller/test relies on for instant feedback when the manager is
        // free. `settleOutcome` still runs (fire-and-forget) so a send that
        // LOOKED like it went out but actually failed/refused downstream
        // gets corrected to 'failed' the instant the real result is known,
        // even though this click already returned 'sent' synchronously.
        markStatus(key, 'sent');
        void settleOutcome(key, Promise.resolve(result));
        return 'sent';
      }

      pendingRef.current = [...pendingRef.current, { key, run }];
      markStatus(key, 'queued');
      return 'queued';
    },
    [busy, markStatus, settleOutcome],
  );

  const isQueued = useCallback((key: string) => statusRef.current.get(key) === 'queued', []);
  const isFailed = useCallback((key: string) => statusRef.current.get(key) === 'failed', []);

  const reset = useCallback(() => {
    pendingRef.current = [];
    statusRef.current.clear();
    bump();
  }, []);

  return { dispatch, isQueued, isFailed, reset };
}
