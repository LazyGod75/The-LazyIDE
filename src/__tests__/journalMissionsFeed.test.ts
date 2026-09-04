/**
 * journalMissionsFeed.ts — perf audit regression guards (2026-08).
 *
 * Before this module existed, three independent, uncoordinated timers each
 * invoked `journal_missions_current` on their own clock:
 *   - fleetMissions.ts's useFleetMissions        (2.5s, Cockpit-gated)
 *   - SpacesRail.tsx's useRunningMissionCounts   (5s, always mounted)
 *   - useCanvasHydration.ts's safety-net repair  (30s, canvas mounted)
 * At steady state (all three mounted) that was ~38 invokes/minute for
 * IDENTICAL data. This guard proves the shared poller/cache keeps call
 * volume down to the fastest consumer's own cadence (~24/minute) no matter
 * how many consumers subscribe, and that a slower one-off reader
 * (useCanvasHydration's snapshot pattern) can ride the cache for free
 * instead of adding its own invoke. If a future change reintroduces a
 * second independent poller for this command, this test's call count
 * roughly doubles and the assertion catches it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  subscribeJournalMissions,
  getJournalMissionsSnapshot,
  _resetJournalMissionsFeedForTests,
} from '../lib/agents/journalMissionsFeed';

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

describe('journalMissionsFeed', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) =>
      cmd === 'journal_missions_current' ? [] : undefined,
    );
    _resetJournalMissionsFeedForTests();
  });

  afterEach(() => {
    _resetJournalMissionsFeedForTests();
  });

  it('a second concurrent subscriber does NOT trigger a second invoke — both share the one poll', async () => {
    const seen1: unknown[] = [];
    const unsub1 = subscribeJournalMissions((rows) => seen1.push(rows));
    await vi.waitFor(() => expect(seen1.length).toBeGreaterThan(0));

    const callsAfterFirst = mockInvoke.mock.calls.filter((c) => c[0] === 'journal_missions_current').length;
    expect(callsAfterFirst).toBe(1);

    // Second subscriber joins — gets the cached snapshot synchronously, no
    // new invoke.
    const seen2: unknown[] = [];
    const unsub2 = subscribeJournalMissions((rows) => seen2.push(rows));
    expect(seen2.length).toBe(1);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'journal_missions_current').length).toBe(callsAfterFirst);

    unsub1();
    unsub2();
  });

  it('does not re-notify subscribers when a poll returns identical rows', async () => {
    vi.useFakeTimers();
    try {
      const stable = [
        { mission_id: 'm1', project_id: 'p1', status: 'running', data: '{"id":"m1"}', updated_ms: 10 },
      ];
      mockInvoke.mockImplementation(async (cmd: string) =>
        cmd === 'journal_missions_current' ? [...stable] : undefined,
      );
      const seen: unknown[] = [];
      const unsub = subscribeJournalMissions((next) => { seen.push(next); });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.length).toBe(1);
      await vi.advanceTimersByTimeAsync(2500);
      await vi.advanceTimersByTimeAsync(2500);
      expect(seen.length).toBe(1);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it('getJournalMissionsSnapshot piggybacks on a fresh cache instead of firing its own invoke', async () => {
    const unsub = subscribeJournalMissions(() => {});
    await vi.waitFor(() =>
      expect(mockInvoke.mock.calls.filter((c) => c[0] === 'journal_missions_current').length).toBe(1),
    );

    const snapshot = await getJournalMissionsSnapshot();
    expect(snapshot).toEqual([]);
    // Still exactly 1 — the snapshot reader reused the cache (within its
    // maxAge window) rather than invoking again.
    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'journal_missions_current').length).toBe(1);

    unsub();
  });

  it('the shared interval stops once the last subscriber unsubscribes (no polling with nothing listening)', async () => {
    vi.useFakeTimers();
    try {
      const unsub = subscribeJournalMissions(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const callsWhileSubscribed = mockInvoke.mock.calls.filter((c) => c[0] === 'journal_missions_current').length;
      expect(callsWhileSubscribed).toBeGreaterThan(0);

      unsub();
      await vi.advanceTimersByTimeAsync(20_000); // several would-be poll ticks
      expect(mockInvoke.mock.calls.filter((c) => c[0] === 'journal_missions_current').length).toBe(
        callsWhileSubscribed,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('REGRESSION GUARD: 3 concurrent consumers over a simulated 60s window stay near the fastest consumer\'s own cadence (~24 calls), not 3x that', async () => {
    vi.useFakeTimers();
    try {
      const unsub1 = subscribeJournalMissions(() => {}); // fleetMissions-style
      const unsub2 = subscribeJournalMissions(() => {}); // SpacesRail-style
      await vi.advanceTimersByTimeAsync(0);

      for (let elapsed = 0; elapsed < 60_000; elapsed += 2500) {
        await vi.advanceTimersByTimeAsync(2500);
        // useCanvasHydration-style one-off snapshot read every 30s.
        if (elapsed % 30_000 === 0) await getJournalMissionsSnapshot();
      }

      const calls = mockInvoke.mock.calls.filter((c) => c[0] === 'journal_missions_current').length;
      // Pre-fix baseline for the same 60s window with 3 independent timers
      // (2.5s + 5s + 30s) would have been ~38 calls. The shared feed must
      // stay within one tick of the fastest consumer's own 2.5s cadence
      // (24 ticks/60s), proving the other two consumers added ~0 extra
      // calls instead of their own 12 and 2.
      expect(calls).toBeGreaterThanOrEqual(23);
      expect(calls).toBeLessThanOrEqual(25);

      unsub1();
      unsub2();
    } finally {
      vi.useRealTimers();
    }
  });
});
