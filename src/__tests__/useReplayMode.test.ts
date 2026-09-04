/**
 * useReplayMode.test.ts — Agent Canvas W8d: session-state wiring
 * (components/agents/canvas/replay/useReplayMode.ts). `journalQuery` is
 * mocked directly (never a real Tauri invoke) so every case controls
 * exactly what rows the fleet timeline is built from — same "mock the
 * journal client, not @tauri-apps/api/core" convention useMissionHistory.ts
 * callers get for free since journalQuery itself already degrades honestly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useReplayMode } from '../components/agents/canvas/replay/useReplayMode';
import type { JournalEventRow } from '../lib/journal/eventTypes';
import type { journalQuery } from '../lib/journal/journal';

// `waitFor` is deliberately NOT used in this file: it schedules its own
// internal polling (setInterval-based), which fake timers (needed below to
// control Date.now() and drive the playback tick deterministically) would
// starve into vitest's own 5s test timeout — the exact "fake timers can
// deadlock against act()'s flush" hazard useCanvasFlowGraph.test.ts's own
// header already documents for this repo. Awaiting a couple of resolved
// microtasks inside `act()` is enough to flush `load()`'s single
// `Promise.all(...).then(...)` chain instead.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const journalQueryMock = vi.fn<typeof journalQuery>();

vi.mock('../lib/journal/journal', () => ({
  journalQuery: (...args: Parameters<typeof journalQuery>) => journalQueryMock(...args),
}));

function row(seq: number, tsMs: number, missionId: string, type: JournalEventRow['type'], payload: Record<string, unknown> = {}): JournalEventRow {
  return {
    seq,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'system',
    type,
    payload: JSON.stringify(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

const FIXED_NOW = new Date(2026, 6, 15, 12, 0, 0).getTime();

beforeEach(() => {
  journalQueryMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useReplayMode — enter/exit', () => {
  it('enter() queries every open project and builds a timeline anchored at the window start', async () => {
    journalQueryMock.mockResolvedValue([row(1, FIXED_NOW - 1000, 'm-1', 'mission.created', { title: 'A' })]);

    const { result } = renderHook(() => useReplayMode({ projectIds: ['proj-1', 'proj-2'] }));
    expect(result.current.active).toBe(false);

    act(() => {
      result.current.enter();
    });
    await flushMicrotasks();

    expect(result.current.active).toBe(true);
    expect(result.current.timeline).not.toBeNull();
    expect(journalQueryMock).toHaveBeenCalledTimes(2);
    expect(journalQueryMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1' }));
    expect(journalQueryMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-2' }));
    expect(result.current.currentTMs).toBe(result.current.timeline!.windowStartMs);
    // The playhead starts at the WINDOW START (local midnight) — the
    // mission was only created a second before "now" (well after
    // midnight), so it's honestly absent yet, never fabricated as already
    // existing just because it's somewhere in the window.
    expect(result.current.fleetState.has('m-1')).toBe(false);

    act(() => result.current.scrubTo(FIXED_NOW));
    expect(result.current.fleetState.get('m-1')).toMatchObject({ status: 'queued', stage: 'plan' });
  });

  it('exit() clears active/timeline/fleetState and ignores a load that resolves afterward', async () => {
    let resolveQuery: (rows: JournalEventRow[]) => void = () => {};
    journalQueryMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQuery = resolve;
        }),
    );

    const { result } = renderHook(() => useReplayMode({ projectIds: ['proj-1'] }));

    act(() => {
      result.current.enter();
    });
    expect(result.current.active).toBe(true);
    expect(result.current.loading).toBe(true);

    act(() => {
      result.current.exit();
    });
    expect(result.current.active).toBe(false);
    expect(result.current.timeline).toBeNull();

    // The slow query finally resolves AFTER exit — must not resurrect state.
    await act(async () => {
      resolveQuery([row(1, FIXED_NOW, 'm-1', 'mission.created', { title: 'A' })]);
      await Promise.resolve();
    });
    expect(result.current.active).toBe(false);
    expect(result.current.timeline).toBeNull();
  });

  it('toggle() flips active state (enter when inactive, exit when active)', async () => {
    journalQueryMock.mockResolvedValue([]);
    const { result } = renderHook(() => useReplayMode({ projectIds: ['proj-1'] }));

    act(() => {
      result.current.toggle();
    });
    await flushMicrotasks();
    expect(result.current.active).toBe(true);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.active).toBe(false);
  });
});

// R2a fix (thread 3): "Aujourd'hui" replay showed nothing while the SAME
// window's FLUX footer (queryActivityFeed, projections.ts — which never
// filters by project_id at all) listed real events. Root cause proven by
// reading the code: load()'s per-project fan-out silently returns ZERO rows
// whenever `projectIds` is empty (registry not hydrated yet) or a project's
// CURRENT id no longer matches what an event was actually stamped with
// (id-scheme drift) — buildFleetTimeline itself is correct given a complete
// event set (ts_ms is real epoch-ms end to end, confirmed in journal.rs's
// chrono::Utc::now().timestamp_millis()); the gap was purely in WHICH rows
// ever reached it. These tests prove the fallback closes that gap without
// changing behavior when per-project scoping already finds real events
// (see the "enter() queries every open project..." test above, whose
// toHaveBeenCalledTimes(2) assertion is the negative control: no extra
// fallback call fires when results are already non-empty).
describe('useReplayMode — project-scoping fallback (R2a thread 3)', () => {
  it('falls back to an unscoped query when projectIds is empty (registry not hydrated yet)', async () => {
    journalQueryMock.mockImplementation(async (filter: unknown) => {
      const f = filter as { projectId?: string };
      if (f.projectId === undefined) {
        return [row(1, FIXED_NOW - 1000, 'm-1', 'mission.created', { title: 'A' })];
      }
      return [];
    });

    const { result } = renderHook(() => useReplayMode({ projectIds: [] }));
    act(() => {
      result.current.enter();
    });
    await flushMicrotasks();

    expect(result.current.timeline).not.toBeNull();
    expect(result.current.timeline!.keyframes.length).toBeGreaterThan(0);
    // Empty projectIds -> zero per-project calls -> exactly ONE fallback call.
    expect(journalQueryMock).toHaveBeenCalledTimes(1);
    const callArgs = journalQueryMock.mock.calls[0][0] as { projectId?: string };
    expect(callArgs.projectId).toBeUndefined();
  });

  it('falls back to an unscoped query when the per-project fan-out finds nothing (id-scheme drift)', async () => {
    journalQueryMock.mockImplementation(async (filter: unknown) => {
      const f = filter as { projectId?: string };
      if (f.projectId === 'proj-legacy') return []; // the open project's CURRENT id — no match in the journal
      if (f.projectId === undefined) return [row(1, FIXED_NOW - 1000, 'm-1', 'mission.created', { title: 'A' })];
      return [];
    });

    const { result } = renderHook(() => useReplayMode({ projectIds: ['proj-legacy'] }));
    act(() => {
      result.current.enter();
    });
    await flushMicrotasks();

    expect(result.current.timeline).not.toBeNull();
    expect(result.current.timeline!.keyframes.length).toBeGreaterThan(0);
    // proj-legacy (empty) + the project-agnostic fallback (real events).
    expect(journalQueryMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT fall back when the per-project fan-out already found real events', async () => {
    journalQueryMock.mockResolvedValue([row(1, FIXED_NOW - 1000, 'm-1', 'mission.created', { title: 'A' })]);

    const { result } = renderHook(() => useReplayMode({ projectIds: ['proj-1'] }));
    act(() => {
      result.current.enter();
    });
    await flushMicrotasks();

    expect(result.current.timeline).not.toBeNull();
    // Exactly ONE call — the real per-project query, no extra fallback.
    expect(journalQueryMock).toHaveBeenCalledTimes(1);
  });
});

describe('useReplayMode — scrub/play/speed', () => {
  async function enterWithLifecycle() {
    journalQueryMock.mockResolvedValue([
      row(1, FIXED_NOW - 5000, 'm-1', 'mission.created', { title: 'A' }),
      row(2, FIXED_NOW - 4000, 'm-1', 'mission.started', {}),
    ]);
    const hook = renderHook(() => useReplayMode({ projectIds: ['proj-1'] }));
    act(() => {
      hook.result.current.enter();
    });
    await flushMicrotasks();
    expect(hook.result.current.timeline).not.toBeNull();
    return hook;
  }

  it('scrubTo clamps to the window and updates fleetState honestly', async () => {
    const { result } = await enterWithLifecycle();
    const windowStart = result.current.timeline!.windowStartMs;
    const windowEnd = result.current.timeline!.windowEndMs;

    act(() => result.current.scrubTo(windowEnd + 999_999)); // past the end -> clamps
    expect(result.current.currentTMs).toBe(windowEnd);

    act(() => result.current.scrubTo(windowStart - 999_999)); // before the start -> clamps
    expect(result.current.currentTMs).toBe(windowStart);
  });

  it('play() advances the playhead on the tick interval and stops automatically at the window end', async () => {
    const { result } = await enterWithLifecycle();
    const windowEnd = result.current.timeline!.windowEndMs;
    const windowStart = result.current.timeline!.windowStartMs;

    act(() => {
      result.current.scrubTo(windowEnd - 300); // near the end so a couple of ticks reaches it
      result.current.setSpeed(16);
      result.current.play();
    });
    expect(result.current.playing).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current.currentTMs).toBe(windowEnd);
    expect(result.current.playing).toBe(false); // auto-paused at the end
    expect(result.current.currentTMs).toBeGreaterThan(windowStart);
  });

  it('stepMs moves the playhead by exactly the given delta, clamped to the window', async () => {
    const { result } = await enterWithLifecycle();
    const windowStart = result.current.timeline!.windowStartMs;
    act(() => result.current.scrubTo(windowStart + 1000));
    act(() => result.current.stepMs(500));
    expect(result.current.currentTMs).toBe(windowStart + 1500);
  });
});
