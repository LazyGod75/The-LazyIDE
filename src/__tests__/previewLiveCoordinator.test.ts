/**
 * Tests for previewLiveCoordinator.ts — P59's hard cap "at most ONE live
 * iframe at a time across the canvas". Pure pub/sub, no React/timers — see
 * that module's own header for why this can't be `useOnViewportChange`
 * (single shared store slot, clobbers across instances) or lib/bus.ts
 * (outside this fix's owned-files boundary).
 *
 * The "memory-pressure lockout" describe block below covers the
 * 2026-08-05 addition: `lazy:memory-pressure` (memoryGuardian.ts) coupling
 * — hard releases the slot and blocks every auto-claim, soft keeps the
 * current live preview but blocks new auto-claims (including a later
 * auto-reclaim after that preview steps down — the actual incident), a
 * manual claim always bypasses the lockout, and 5 minutes of silence
 * clears it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  attendPreview,
  unattendPreview,
  subscribePreviewLiveWinner,
  isPreviewLiveWinner,
  isPreviewPressureLockout,
  getPreviewPressureLockoutLevel,
  PREVIEW_PRESSURE_SILENCE_MS,
  _resetPreviewLiveCoordinatorForTests,
} from '../components/agents/canvas/nodes/previewLiveCoordinator';
import { MEMORY_PRESSURE_EVENT, type MemoryPressureLevel } from '../lib/agents/memoryGuardian';

beforeEach(() => {
  _resetPreviewLiveCoordinatorForTests();
});

describe('previewLiveCoordinator — single live slot', () => {
  it('the first attended id wins the live slot', () => {
    attendPreview('a');
    expect(isPreviewLiveWinner('a')).toBe(true);
  });

  it('a later attend demotes the previous winner — only one live at a time', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    subscribePreviewLiveWinner('a', onA);
    subscribePreviewLiveWinner('b', onB);

    attendPreview('a');
    expect(onA).toHaveBeenCalledWith(true);

    attendPreview('b');
    expect(onA).toHaveBeenCalledWith(false);
    expect(onB).toHaveBeenCalledWith(true);
    expect(isPreviewLiveWinner('a')).toBe(false);
    expect(isPreviewLiveWinner('b')).toBe(true);
  });

  it('re-attending the current winner is a no-op (no redundant listener calls)', () => {
    const onA = vi.fn();
    subscribePreviewLiveWinner('a', onA);
    attendPreview('a');
    onA.mockClear();

    attendPreview('a');
    expect(onA).not.toHaveBeenCalled();
  });

  it('when the winner unattends, the next-most-recently-attended id reclaims the slot', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    subscribePreviewLiveWinner('a', onA);
    subscribePreviewLiveWinner('b', onB);

    attendPreview('a'); // a live
    attendPreview('b'); // b live, a paused
    onA.mockClear();
    onB.mockClear();

    unattendPreview('b'); // b steps back (e.g. mouse left, not selected/pinned)

    expect(onB).toHaveBeenCalledWith(false); // b honestly told it lost the slot it held
    expect(onA).toHaveBeenCalledWith(true); // a resumes — "others pause" is never permanent
    expect(isPreviewLiveWinner('a')).toBe(true);
  });

  it('unattending a non-winner does not disturb the current winner', () => {
    const onA = vi.fn();
    subscribePreviewLiveWinner('a', onA);
    attendPreview('a');
    attendPreview('b');
    onA.mockClear();

    unattendPreview('c'); // never attended at all
    expect(onA).not.toHaveBeenCalled();
    expect(isPreviewLiveWinner('b')).toBe(true);
  });

  it('unattending an id that was never attended is a harmless no-op', () => {
    expect(() => unattendPreview('nope')).not.toThrow();
    expect(isPreviewLiveWinner('nope')).toBe(false);
  });

  it('no winner at all once every attended id has unattended', () => {
    attendPreview('a');
    unattendPreview('a');
    expect(isPreviewLiveWinner('a')).toBe(false);
  });

  it('subscribe returns an unsubscribe function that also removes the id from contention', () => {
    const onA = vi.fn();
    const unsubscribe = subscribePreviewLiveWinner('a', onA);
    attendPreview('a');
    attendPreview('b'); // demotes a to non-winner, still "attended" (in the order array)

    unsubscribe();
    // 'a' is now fully out of contention — attending nothing else should leave 'b' as winner,
    // and a later attend('a') starts fresh (wins again, since it's the newest).
    expect(isPreviewLiveWinner('b')).toBe(true);
    attendPreview('a');
    expect(isPreviewLiveWinner('a')).toBe(true);
  });
});

describe('previewLiveCoordinator — memory-pressure lockout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Reset BEFORE restoring real timers: the reset clears any pending
    // fake-timer silence timeout via clearTimeout, which must run while
    // fake timers are still installed.
    _resetPreviewLiveCoordinatorForTests();
    vi.useRealTimers();
  });

  function dispatchPressure(level: MemoryPressureLevel, usedMB: number): void {
    window.dispatchEvent(new CustomEvent(MEMORY_PRESSURE_EVENT, { detail: { level, usedMB } }));
  }

  it('hard pressure releases the live slot and blocks further auto-claims', () => {
    const onA = vi.fn();
    subscribePreviewLiveWinner('a', onA);
    attendPreview('a');
    expect(isPreviewLiveWinner('a')).toBe(true);
    onA.mockClear();

    dispatchPressure('hard', 2300);

    expect(onA).toHaveBeenCalledWith(false);
    expect(isPreviewLiveWinner('a')).toBe(false);
    expect(isPreviewPressureLockout()).toBe(true);
    expect(getPreviewPressureLockoutLevel()).toBe('hard');

    // A brand new automatic claim (no `manual`) must not win the slot.
    attendPreview('b');
    expect(isPreviewLiveWinner('b')).toBe(false);
  });

  it('a manual claim still wins the slot during a hard lockout', () => {
    attendPreview('a');
    dispatchPressure('hard', 2300);

    attendPreview('c', { manual: true });
    expect(isPreviewLiveWinner('c')).toBe(true);
  });

  it('soft pressure keeps the current live preview but blocks new auto-claims', () => {
    attendPreview('a');
    expect(isPreviewLiveWinner('a')).toBe(true);

    dispatchPressure('soft', 1600);
    expect(isPreviewPressureLockout()).toBe(true);
    expect(getPreviewPressureLockoutLevel()).toBe('soft');
    expect(isPreviewLiveWinner('a')).toBe(true); // incumbent untouched

    attendPreview('b'); // a different preview trying to auto-claim
    expect(isPreviewLiveWinner('b')).toBe(false);
    expect(isPreviewLiveWinner('a')).toBe(true);
  });

  it('soft lockout blocks an auto-reclaim after the incumbent itself steps down (the actual incident)', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    subscribePreviewLiveWinner('a', onA);
    subscribePreviewLiveWinner('b', onB);
    attendPreview('a');
    attendPreview('b'); // b is live, a is attended-but-paused underneath it
    expect(isPreviewLiveWinner('b')).toBe(true);

    dispatchPressure('soft', 1600);
    onA.mockClear();
    onB.mockClear();

    unattendPreview('b'); // the incumbent closes/steps back under pressure

    expect(onB).toHaveBeenCalledWith(false); // b honestly loses the slot
    expect(onA).not.toHaveBeenCalled(); // but 'a' must NOT auto-reclaim it
    expect(isPreviewLiveWinner('a')).toBe(false);
    expect(isPreviewLiveWinner('b')).toBe(false);
  });

  it('a manual claim during soft lockout does not leave a stale entry that resurfaces later', () => {
    const onA = vi.fn();
    const onC = vi.fn();
    subscribePreviewLiveWinner('a', onA);
    subscribePreviewLiveWinner('c', onC);
    attendPreview('a');
    dispatchPressure('soft', 1600);

    attendPreview('c', { manual: true }); // manual claim supersedes the incumbent
    expect(isPreviewLiveWinner('c')).toBe(true);
    onA.mockClear();
    onC.mockClear();

    unattendPreview('c'); // the manual claimant steps back, still under soft pressure

    expect(onC).toHaveBeenCalledWith(false);
    expect(onA).not.toHaveBeenCalled(); // 'a' must not resurface from underneath
    expect(isPreviewLiveWinner('a')).toBe(false);
  });

  it('a later soft event never downgrades an active hard lockout', () => {
    attendPreview('a');
    dispatchPressure('hard', 2300);
    dispatchPressure('soft', 1800);

    expect(getPreviewPressureLockoutLevel()).toBe('hard');
    attendPreview('b');
    expect(isPreviewLiveWinner('b')).toBe(false);
  });

  it('5 minutes of silence clears the lockout and restores auto-claiming', () => {
    attendPreview('a');
    dispatchPressure('hard', 2300);
    expect(isPreviewPressureLockout()).toBe(true);

    vi.advanceTimersByTime(PREVIEW_PRESSURE_SILENCE_MS);

    expect(isPreviewPressureLockout()).toBe(false);
    expect(getPreviewPressureLockoutLevel()).toBe('none');

    attendPreview('x');
    expect(isPreviewLiveWinner('x')).toBe(true);
  });

  it('a fresh pressure event resets the 5-minute silence window', () => {
    dispatchPressure('soft', 1600);
    vi.advanceTimersByTime(PREVIEW_PRESSURE_SILENCE_MS - 1000);
    dispatchPressure('soft', 1650); // refreshes the timer just before it would have cleared

    vi.advanceTimersByTime(2000); // total elapsed since the FIRST event now exceeds 5 min
    expect(isPreviewPressureLockout()).toBe(true); // still locked out — only 2s since the refresh

    vi.advanceTimersByTime(PREVIEW_PRESSURE_SILENCE_MS);
    expect(isPreviewPressureLockout()).toBe(false);
  });
});
