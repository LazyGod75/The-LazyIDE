/**
 * useManagerActionQueue — NEVER DEGRADE IN SILENCE.
 *
 * Real user test (2026-07-28): clicking "Valider" on a mission-charter card
 * while the manager was mid-turn silently dropped the click —
 * LazyManager.tsx's handlers all read `if (!store.busy) void store.send(...)`,
 * so a click made while busy simply never reached the manager, while the
 * card itself still flipped to a false "ACCEPTÉE" (see MissionCharterCard.tsx's
 * own doc comment for the full repro this closes).
 *
 * This hook is the fix: every one of those handlers now goes through
 * `dispatch(key, run)`, which sends immediately when the manager is free or
 * queues (preserving order, deduping a repeated click) for the instant it
 * frees up. These tests cover the three contracts required by the fix:
 *   1. a click made while busy is eventually sent once the manager frees up;
 *   2. a card must never resolve before its action is actually taken in
 *      charge (`isQueued` stays reactive-true until the queued entry flushes);
 *   3. two rapid clicks never produce two sends (dedupe by key), whether
 *      busy or free.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useManagerActionQueue } from '../components/lazyManager/useManagerActionQueue';

describe('useManagerActionQueue', () => {
  it('runs the action immediately when the manager is free', async () => {
    const { result } = renderHook(() => useManagerActionQueue(false));
    const run = vi.fn();

    let outcome: string | undefined;
    // Wrapped in an async act() — round 2's settleOutcome (see module doc
    // comment) fires a follow-up state update once `run`'s result settles,
    // even on this synchronous-looking immediate path.
    await act(async () => {
      outcome = result.current.dispatch('k1', run);
    });

    expect(outcome).toBe('sent');
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.isQueued('k1')).toBe(false);
  });

  it('queues the action while busy — never dropped — and flushes it exactly once the manager frees up', async () => {
    const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
      initialProps: { busy: true },
    });
    const run = vi.fn().mockResolvedValue(undefined);

    let outcome: string | undefined;
    act(() => {
      outcome = result.current.dispatch('k1', run);
    });

    expect(outcome).toBe('queued');
    expect(run).not.toHaveBeenCalled(); // NEVER sent while busy
    expect(result.current.isQueued('k1')).toBe(true);

    // The manager frees up — the queued click must reach it now, on its own,
    // with no further user action.
    rerender({ busy: false });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isQueued('k1')).toBe(false));
  });

  it('never shows the action as taken-in-charge-and-done while merely queued (isQueued stays true until the real flush)', () => {
    const { result } = renderHook(() => useManagerActionQueue(true));
    const run = vi.fn();

    act(() => {
      result.current.dispatch('charter:msg-1', run);
    });

    // Still busy, nothing flushed yet — a card reading this must show its
    // own "waiting to send" state, never a final result.
    expect(result.current.isQueued('charter:msg-1')).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('two rapid clicks on the same action while busy queue it only once and send it only once', async () => {
    const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
      initialProps: { busy: true },
    });
    const run = vi.fn().mockResolvedValue(undefined);

    act(() => {
      result.current.dispatch('k1', run);
      result.current.dispatch('k1', run); // second rapid click, same key
    });

    expect(result.current.isQueued('k1')).toBe(true);

    rerender({ busy: false });

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1)); // never twice
  });

  it('two rapid clicks on the same action while free send it only once', async () => {
    const { result } = renderHook(() => useManagerActionQueue(false));
    const run = vi.fn();

    // Async act() — see the previous test's own comment (round 2's
    // settleOutcome follow-up).
    await act(async () => {
      result.current.dispatch('k1', run);
      result.current.dispatch('k1', run);
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('preserves order across several distinct queued actions and sends each exactly once', async () => {
    const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
      initialProps: { busy: true },
    });
    const order: string[] = [];
    const runA = vi.fn(async () => { order.push('a'); });
    const runB = vi.fn(async () => { order.push('b'); });

    act(() => {
      result.current.dispatch('a', runA);
      result.current.dispatch('b', runB);
    });

    rerender({ busy: false });

    await waitFor(() => expect(runA).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runB).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['a', 'b']);
  });

  it('reset() purges a still-queued (not yet sent) action — a stale click never fires into a conversation the user left', () => {
    const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
      initialProps: { busy: true },
    });
    const run = vi.fn();

    act(() => {
      result.current.dispatch('k1', run);
    });
    expect(result.current.isQueued('k1')).toBe(true);

    act(() => {
      result.current.reset();
    });
    expect(result.current.isQueued('k1')).toBe(false);

    // Even once the manager frees up, the purged entry must never fire.
    rerender({ busy: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('a synchronously-throwing action returns "idle" (not taken in charge) instead of silently succeeding', () => {
    const { result } = renderHook(() => useManagerActionQueue(false));
    const run = vi.fn(() => { throw new Error('boom'); });

    let outcome: string | undefined;
    act(() => {
      outcome = result.current.dispatch('k1', run);
    });

    expect(outcome).toBe('idle');
    expect(result.current.isQueued('k1')).toBe(false);
  });

  /**
   * SILENT-FALSE-POSITIVE FIX (real user test, 2026-07-28, round 2).
   *
   * Measured on the real app: clicking "Valider" on the third mission-
   * charter card while the manager was busy showed "EN FILE D'ATTENTE"
   * (correct — the first fix above). The manager then freed up, the card
   * flipped to "ACCEPTÉE" — but the user-message count in the conversation
   * was IDENTICAL before and after the drain: nothing was ever actually
   * sent. Root cause: `flush()` used to call `markStatus(key, 'sent')`
   * unconditionally right after awaiting `run()`, even when `run()` had
   * thrown or explicitly reported no effect — it promoted the visual state
   * on the mere fact that sending was ATTEMPTED, never on its confirmed
   * result.
   *
   * These tests reproduce the exact measured sequence (busy, click, drain,
   * verify a message was actually emitted) and the variant this fix adds:
   * a refused/failed send must leave the card able to tell "resolved" apart
   * from "refused", never silently reported as resolved.
   */
  describe('real-result confirmation (bug fix, round 2: false "resolved" on mere drain)', () => {
    it('reproduces the exact measured sequence: busy, click, drain — the queued action is truly invoked once the manager frees up, and only THEN reported sent', async () => {
      const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
        initialProps: { busy: true },
      });
      const run = vi.fn().mockResolvedValue(true); // real confirmation: the message was actually emitted

      act(() => {
        result.current.dispatch('charter:msg-3', run);
      });
      expect(result.current.isQueued('charter:msg-3')).toBe(true);
      expect(run).not.toHaveBeenCalled(); // never invoked while busy — nothing sent yet

      // The manager frees up — same measured transition as the real repro.
      rerender({ busy: false });

      await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(result.current.isQueued('charter:msg-3')).toBe(false));
      // Confirmed sent (run resolved true) — never reported as failed.
      expect(result.current.isFailed('charter:msg-3')).toBe(false);
    });

    it('the variant where the send is refused: the queue drains, but the card must NOT show resolved — isFailed flips true instead of a silent "sent"', async () => {
      const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
        initialProps: { busy: true },
      });
      // Real refusal: run settles, but explicitly reports no confirmed effect.
      const run = vi.fn().mockResolvedValue(false);

      act(() => {
        result.current.dispatch('charter:msg-3', run);
      });
      expect(result.current.isQueued('charter:msg-3')).toBe(true);

      rerender({ busy: false });

      await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      // Drained (no longer queued) — but NEVER promoted to a resolved state.
      await waitFor(() => expect(result.current.isQueued('charter:msg-3')).toBe(false));
      expect(result.current.isFailed('charter:msg-3')).toBe(true);
    });

    it('a thrown/rejected queued action is also reported as failed, not silently marked sent', async () => {
      const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
        initialProps: { busy: true },
      });
      const run = vi.fn().mockRejectedValue(new Error('network error'));

      act(() => {
        result.current.dispatch('k1', run);
      });
      rerender({ busy: false });

      await waitFor(() => expect(result.current.isQueued('k1')).toBe(false));
      expect(result.current.isFailed('k1')).toBe(true);
    });

    it('a failed action does not block a retry — a fresh dispatch for the same key clears isFailed and attempts again', async () => {
      const { result, rerender } = renderHook(({ busy }) => useManagerActionQueue(busy), {
        initialProps: { busy: true },
      });
      const firstRun = vi.fn().mockResolvedValue(false);
      act(() => { result.current.dispatch('k1', firstRun); });
      rerender({ busy: false });
      await waitFor(() => expect(result.current.isFailed('k1')).toBe(true));

      // Retry: same key, manager free this time, real send succeeds.
      const secondRun = vi.fn().mockResolvedValue(true);
      act(() => {
        result.current.dispatch('k1', secondRun);
      });

      expect(secondRun).toHaveBeenCalledTimes(1); // not blocked by the prior failure
      await waitFor(() => expect(result.current.isFailed('k1')).toBe(false));
    });

    it('an immediately-sent action (manager free) that later turns out to have failed is corrected from sent to failed', async () => {
      const { result } = renderHook(() => useManagerActionQueue(false));
      const run = vi.fn().mockResolvedValue(false);

      let outcome: string | undefined;
      act(() => {
        outcome = result.current.dispatch('k1', run);
      });

      // Synchronous contract preserved: instant 'sent' feedback.
      expect(outcome).toBe('sent');
      // But the real (asynchronous) result disagrees — corrected the moment
      // it's known, never left standing as a false "resolved".
      await waitFor(() => expect(result.current.isFailed('k1')).toBe(true));
    });
  });
});
