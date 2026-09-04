import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  recordUsage,
  recordBrainSavings,
  recordMissionCompleted,
  getWindowMetrics,
  subscribeUsageHistory,
  __resetUsageHistory,
} from '../lib/models/usageHistory';

// Reset all state before each test so tests are fully isolated.
beforeEach(() => {
  vi.useRealTimers();
  __resetUsageHistory();
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('lazy:usageHistory');
  }
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Basic accumulation ─────────────────────────────────────────────

describe('initial state', () => {
  it('returns all zeros when nothing has been recorded', () => {
    const m = getWindowMetrics('today');
    expect(m.inputTokens).toBe(0);
    expect(m.outputTokens).toBe(0);
    expect(m.totalTokens).toBe(0);
    expect(m.costUsd).toBe(0);
    expect(m.brainTokensSaved).toBe(0);
    expect(m.missionsCompleted).toBe(0);
    expect(m.tokenSparkline).toEqual([]);
    expect(m.costSparkline).toEqual([]);
    expect(m.bucketCount).toBe(0);
  });
});

describe('recordUsage', () => {
  it('accumulates input tokens across calls', () => {
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });
    recordUsage({ inputTokens: 200, outputTokens: 0, costUsd: 0, model: 'test' });
    expect(getWindowMetrics('today').inputTokens).toBe(300);
  });

  it('accumulates output tokens across calls', () => {
    recordUsage({ inputTokens: 0, outputTokens: 50, costUsd: 0, model: 'test' });
    recordUsage({ inputTokens: 0, outputTokens: 75, costUsd: 0, model: 'test' });
    expect(getWindowMetrics('today').outputTokens).toBe(125);
  });

  it('computes totalTokens as input + output', () => {
    recordUsage({ inputTokens: 100, outputTokens: 50, costUsd: 0.01, model: 'test' });
    const m = getWindowMetrics('today');
    expect(m.totalTokens).toBe(150);
  });

  it('accumulates costUsd correctly', () => {
    recordUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0.05, model: 'test' });
    recordUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0.03, model: 'test' });
    expect(getWindowMetrics('today').costUsd).toBeCloseTo(0.08);
  });

  it('data recorded now appears in today and all windows', () => {
    recordUsage({ inputTokens: 500, outputTokens: 0, costUsd: 0.001, model: 'test' });
    expect(getWindowMetrics('today').inputTokens).toBe(500);
    expect(getWindowMetrics('7d').inputTokens).toBe(500);
    expect(getWindowMetrics('all').inputTokens).toBe(500);
  });
});

// ── Window boundaries ──────────────────────────────────────────────

describe('window boundaries', () => {
  it('today window excludes data recorded yesterday', () => {
    vi.useFakeTimers();

    // Record yesterday at 10am (local time)
    const yesterday = new Date(2025, 0, 14, 10, 0, 0);
    vi.setSystemTime(yesterday);
    __resetUsageHistory();
    recordUsage({ inputTokens: 999, outputTokens: 0, costUsd: 0, model: 'test' });

    // Advance to today at noon
    vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0));
    recordUsage({ inputTokens: 111, outputTokens: 0, costUsd: 0, model: 'test' });

    expect(getWindowMetrics('today').inputTokens).toBe(111);
    expect(getWindowMetrics('all').inputTokens).toBe(1110);
  });

  it('7d window excludes data older than 7 days', () => {
    vi.useFakeTimers();

    // Jan 7 is 8 days before Jan 15 — outside the 7d window
    vi.setSystemTime(new Date(2025, 0, 7, 10, 0, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 10000, outputTokens: 0, costUsd: 0.5, model: 'test' });

    // Jan 12 is 3 days before Jan 15 — inside the 7d window
    vi.setSystemTime(new Date(2025, 0, 12, 10, 0, 0));
    recordUsage({ inputTokens: 500, outputTokens: 0, costUsd: 0.05, model: 'test' });

    // Set "now" to Jan 15
    vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0));

    expect(getWindowMetrics('7d').inputTokens).toBe(500);
    expect(getWindowMetrics('all').inputTokens).toBe(10500);
  });

  it('all window includes data from multiple past days', () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date(2025, 0, 1, 10, 0, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 123, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0));
    recordUsage({ inputTokens: 456, outputTokens: 0, costUsd: 0, model: 'test' });

    expect(getWindowMetrics('all').inputTokens).toBe(579);
    expect(getWindowMetrics('today').inputTokens).toBe(456);
  });

  it('7d window sums data from multiple days within window', () => {
    vi.useFakeTimers();
    const now = new Date(2025, 0, 15, 12, 0, 0);

    vi.setSystemTime(new Date(2025, 0, 13, 9, 0, 0)); // 2 days ago
    __resetUsageHistory();
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 14, 9, 0, 0)); // yesterday
    recordUsage({ inputTokens: 200, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(now);
    recordUsage({ inputTokens: 300, outputTokens: 0, costUsd: 0, model: 'test' });

    expect(getWindowMetrics('7d').inputTokens).toBe(600);
  });
});

// ── Sparklines ─────────────────────────────────────────────────────

describe('sparklines', () => {
  it('today sparkline has at least 1 and at most 24 hourly points when data exists', () => {
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });
    const m = getWindowMetrics('today');
    expect(m.tokenSparkline.length).toBeGreaterThanOrEqual(1);
    expect(m.tokenSparkline.length).toBeLessThanOrEqual(24);
    expect(m.costSparkline.length).toBe(m.tokenSparkline.length);
  });

  it('today sparkline length matches cost sparkline length', () => {
    recordUsage({ inputTokens: 100, outputTokens: 50, costUsd: 0.01, model: 'test' });
    const m = getWindowMetrics('today');
    expect(m.tokenSparkline.length).toBe(m.costSparkline.length);
  });

  it('7d sparkline has exactly 7 points when data exists', () => {
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0.001, model: 'test' });
    const m = getWindowMetrics('7d');
    expect(m.tokenSparkline).toHaveLength(7);
    expect(m.costSparkline).toHaveLength(7);
  });

  it('all sparkline has at most 30 daily points', () => {
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });
    const m = getWindowMetrics('all');
    expect(m.tokenSparkline.length).toBeLessThanOrEqual(30);
    expect(m.costSparkline.length).toBeLessThanOrEqual(30);
  });

  it('all sparkline capped at 30 when more than 30 days of data exist', () => {
    vi.useFakeTimers();
    __resetUsageHistory();

    // Record in 35 distinct days
    for (let i = 34; i >= 0; i--) {
      vi.setSystemTime(new Date(2025, 0, 15 - i, 10, 0, 0));
      recordUsage({ inputTokens: 10, outputTokens: 0, costUsd: 0, model: 'test' });
    }

    vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0));
    const m = getWindowMetrics('all');
    expect(m.tokenSparkline.length).toBe(30);
  });

  it('empty windows return empty sparklines', () => {
    expect(getWindowMetrics('today').tokenSparkline).toEqual([]);
    expect(getWindowMetrics('7d').tokenSparkline).toEqual([]);
    expect(getWindowMetrics('all').tokenSparkline).toEqual([]);
    expect(getWindowMetrics('today').costSparkline).toEqual([]);
  });

  it('sparkline values reflect token counts per bucket', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15, 10, 0, 0));
    __resetUsageHistory();

    recordUsage({ inputTokens: 100, outputTokens: 50, costUsd: 0.01, model: 'test' });

    const m = getWindowMetrics('today');
    // The last point should contain our bucket's token count
    const lastPoint = m.tokenSparkline[m.tokenSparkline.length - 1];
    expect(lastPoint).toBe(150); // 100 in + 50 out
  });

  it('7d sparkline values sum multi-hour buckets per day', () => {
    vi.useFakeTimers();
    // Two recordings on the same day in different hours
    vi.setSystemTime(new Date(2025, 0, 15, 9, 0, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 15, 14, 0, 0));
    recordUsage({ inputTokens: 200, outputTokens: 0, costUsd: 0, model: 'test' });

    const m = getWindowMetrics('7d');
    // Last point in the 7-day sparkline is today's total
    const todayPoint = m.tokenSparkline[6];
    expect(todayPoint).toBe(300);
  });
});

// ── recordBrainSavings ─────────────────────────────────────────────

describe('recordBrainSavings', () => {
  it('accumulates brain token savings', () => {
    recordBrainSavings(1000);
    recordBrainSavings(500);
    expect(getWindowMetrics('today').brainTokensSaved).toBe(1500);
  });

  it('ignores zero and negative values', () => {
    recordBrainSavings(0);
    recordBrainSavings(-100);
    expect(getWindowMetrics('today').brainTokensSaved).toBe(0);
  });

  it('rounds decimal values', () => {
    recordBrainSavings(10.7);
    expect(getWindowMetrics('today').brainTokensSaved).toBe(11);
  });

  it('notifies subscribers', () => {
    let called = false;
    const unsub = subscribeUsageHistory(() => { called = true; });
    recordBrainSavings(100);
    expect(called).toBe(true);
    unsub();
  });
});

// ── recordMissionCompleted ─────────────────────────────────────────

describe('recordMissionCompleted', () => {
  it('increments missionsCompleted counter', () => {
    recordMissionCompleted();
    recordMissionCompleted();
    recordMissionCompleted();
    expect(getWindowMetrics('today').missionsCompleted).toBe(3);
  });

  it('missions appear in all windows that cover the current time', () => {
    recordMissionCompleted();
    expect(getWindowMetrics('today').missionsCompleted).toBe(1);
    expect(getWindowMetrics('7d').missionsCompleted).toBe(1);
    expect(getWindowMetrics('all').missionsCompleted).toBe(1);
  });

  it('notifies subscribers', () => {
    let called = false;
    const unsub = subscribeUsageHistory(() => { called = true; });
    recordMissionCompleted();
    expect(called).toBe(true);
    unsub();
  });
});

// ── subscribeUsageHistory ──────────────────────────────────────────

describe('subscribeUsageHistory', () => {
  it('notifies subscriber after recordUsage', () => {
    const snapshots: number[] = [];
    const unsub = subscribeUsageHistory(() => {
      snapshots.push(getWindowMetrics('today').inputTokens);
    });

    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });
    recordUsage({ inputTokens: 200, outputTokens: 0, costUsd: 0, model: 'test' });

    expect(snapshots).toEqual([100, 300]);
    unsub();
  });

  it('unsub stops notifications', () => {
    const calls: number[] = [];
    const unsub = subscribeUsageHistory(() => calls.push(1));
    unsub();
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });
    expect(calls).toHaveLength(0);
  });

  it('multiple subscribers each receive notifications', () => {
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = subscribeUsageHistory(() => a.push(getWindowMetrics('today').inputTokens));
    const unsubB = subscribeUsageHistory(() => b.push(getWindowMetrics('today').inputTokens));

    recordUsage({ inputTokens: 50, outputTokens: 0, costUsd: 0, model: 'test' });

    expect(a).toEqual([50]);
    expect(b).toEqual([50]);
    unsubA();
    unsubB();
  });

  it('unsub of one subscriber does not affect others', () => {
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = subscribeUsageHistory(() => a.push(1));
    const unsubB = subscribeUsageHistory(() => b.push(1));

    unsubA();
    recordUsage({ inputTokens: 10, outputTokens: 0, costUsd: 0, model: 'test' });

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
    unsubB();
  });

  it('returns a function that unsubscribes', () => {
    const calls: number[] = [];
    const unsub = subscribeUsageHistory(() => calls.push(1));
    expect(typeof unsub).toBe('function');
    unsub();
    recordUsage({ inputTokens: 10, outputTokens: 0, costUsd: 0, model: 'test' });
    expect(calls).toHaveLength(0);
  });
});

// ── __resetUsageHistory ────────────────────────────────────────────

describe('__resetUsageHistory', () => {
  it('clears all accumulated tokens, cost, savings, and missions', () => {
    recordUsage({ inputTokens: 999, outputTokens: 888, costUsd: 9.99, model: 'test' });
    recordBrainSavings(777);
    recordMissionCompleted();

    __resetUsageHistory();

    const m = getWindowMetrics('all');
    expect(m.inputTokens).toBe(0);
    expect(m.outputTokens).toBe(0);
    expect(m.totalTokens).toBe(0);
    expect(m.costUsd).toBe(0);
    expect(m.brainTokensSaved).toBe(0);
    expect(m.missionsCompleted).toBe(0);
    expect(m.bucketCount).toBe(0);
  });

  it('notifies subscribers on reset', () => {
    let called = false;
    const unsub = subscribeUsageHistory(() => { called = true; });
    __resetUsageHistory();
    expect(called).toBe(true);
    unsub();
  });

  it('allows fresh accumulation after reset', () => {
    recordUsage({ inputTokens: 500, outputTokens: 0, costUsd: 0, model: 'test' });
    __resetUsageHistory();
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });
    expect(getWindowMetrics('today').inputTokens).toBe(100);
  });

  it('empty windows return empty sparklines after reset', () => {
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });
    __resetUsageHistory();
    expect(getWindowMetrics('today').tokenSparkline).toEqual([]);
    expect(getWindowMetrics('7d').tokenSparkline).toEqual([]);
    expect(getWindowMetrics('all').tokenSparkline).toEqual([]);
  });
});

// ── bucketCount ────────────────────────────────────────────────────

describe('bucketCount', () => {
  it('reflects number of distinct hour buckets in the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15, 10, 0, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 10, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 15, 11, 0, 0));
    recordUsage({ inputTokens: 10, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0));
    const m = getWindowMetrics('today');
    expect(m.bucketCount).toBe(2);
  });

  it('two records in same hour count as one bucket', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15, 10, 30, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 10, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 15, 10, 45, 0));
    recordUsage({ inputTokens: 20, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 15, 11, 0, 0));
    expect(getWindowMetrics('today').bucketCount).toBe(1);
    expect(getWindowMetrics('today').inputTokens).toBe(30);
  });
});

// ── 7d window / sparkline alignment ───────────────────────────────

describe('7d aggregate vs sparkline alignment', () => {
  it('aggregate total equals sum of sparkline values at the calendar-day seam', () => {
    vi.useFakeTimers();
    // now = Jan 15 at 23:00 — this is the seam where rolling-168h and
    // calendar-day windows differ (rolling would include Jan 8 23:00, calendar does not).
    const now = new Date(2025, 0, 15, 23, 0, 0);

    // Seed data on Jan 8 at 23:00 — within a rolling 7*24h window from "now"
    // but OUTSIDE the calendar window (D-6 = Jan 9, 00:00).
    vi.setSystemTime(new Date(2025, 0, 8, 23, 0, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0.01, model: 'test' });

    // Seed data on Jan 11 — inside both windows.
    vi.setSystemTime(new Date(2025, 0, 11, 10, 0, 0));
    recordUsage({ inputTokens: 200, outputTokens: 0, costUsd: 0.02, model: 'test' });

    vi.setSystemTime(now);

    const m = getWindowMetrics('7d');
    const sparklineSum = m.tokenSparkline.reduce((acc, v) => acc + v, 0);

    // Aggregate and sparkline must agree — Jan 8 data excluded from both.
    expect(m.totalTokens).toBe(sparklineSum);
    expect(m.totalTokens).toBe(200);
  });

  it('data on D-6 at midnight is included in both aggregate and sparkline', () => {
    vi.useFakeTimers();
    const now = new Date(2025, 0, 15, 12, 0, 0); // Jan 15

    // D-6 = Jan 9, 00:00 — exactly the calendar boundary.
    vi.setSystemTime(new Date(2025, 0, 9, 0, 0, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 50, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(now);

    const m = getWindowMetrics('7d');
    const sparklineSum = m.tokenSparkline.reduce((acc, v) => acc + v, 0);

    expect(m.totalTokens).toBe(50);
    expect(sparklineSum).toBe(50);
    expect(m.tokenSparkline[0]).toBe(50); // first sparkline point = D-6 = Jan 9
  });
});

// ── Cross-window consistency ───────────────────────────────────────

describe('cross-window consistency', () => {
  it('all window total >= today total and >= 7d total', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 7, 10, 0, 0));
    __resetUsageHistory();
    recordUsage({ inputTokens: 100, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 12, 10, 0, 0));
    recordUsage({ inputTokens: 200, outputTokens: 0, costUsd: 0, model: 'test' });

    vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0));
    recordUsage({ inputTokens: 300, outputTokens: 0, costUsd: 0, model: 'test' });

    const today = getWindowMetrics('today');
    const sevenD = getWindowMetrics('7d');
    const all = getWindowMetrics('all');

    expect(all.inputTokens).toBeGreaterThanOrEqual(today.inputTokens);
    expect(all.inputTokens).toBeGreaterThanOrEqual(sevenD.inputTokens);
    expect(all.inputTokens).toBe(600);
    expect(today.inputTokens).toBe(300);
  });
});

// ── Tauri persistence — verbatim-safe path join ──────────────────────
// Regression coverage: saveToStorage/loadFromStorage built the
// '.lazy/usage-history.json' path via string concatenation
// (`${root}/.lazy`, `${lazyDir}/usage-history.json`) instead of the shared
// joinPath() helper. A Windows '\\?\'-prefixed root (get_project_root's
// canonicalize() result) then produces a mixed-separator path the Rust fs
// commands reject as "outside project root" even though '.lazy' exists on
// disk — same bug class as missionQueue.ts/artifacts.ts (see
// src/lib/paths.ts's header comment and src/__tests__/tauriMissionsPath.test.ts).

describe('Tauri persistence — verbatim-safe path join', () => {
  const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    mockedInvoke.mockReset();
  });

  it('saves usage history via fs_create_dir/write_file using a verbatim-safe joined path, never a literal "/"', async () => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};

    const projectRoot = String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project`;
    const calls: Array<{ cmd: string; args: unknown }> = [];
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'get_project_root') return Promise.resolve(projectRoot);
      return Promise.resolve(undefined);
    });

    __resetUsageHistory();
    recordUsage({ inputTokens: 42, outputTokens: 0, costUsd: 0, model: 'test' });

    // Flush the save debounce (SAVE_DEBOUNCE_MS = 800).
    await vi.advanceTimersByTimeAsync(1000);

    const createDirCall = calls.find((c) => c.cmd === 'fs_create_dir');
    const writeFileCall = calls.find((c) => c.cmd === 'write_file');

    expect((createDirCall?.args as { path: string } | undefined)?.path).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy`,
    );
    expect((writeFileCall?.args as { path: string } | undefined)?.path).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy\usage-history.json`,
    );
    expect((writeFileCall?.args as { path: string } | undefined)?.path).not.toContain('/');
  });
});
