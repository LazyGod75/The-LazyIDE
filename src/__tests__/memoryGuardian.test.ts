/**
 * memoryGuardian.test.ts
 *
 * Covers:
 * 1. evaluateMemoryLevel — pure hysteresis/rate-limit decision logic
 *    (mirrors crashReporter.test.ts's shouldReport / systemPressureShedding
 *    test conventions: exercise the pure core directly, no timers needed).
 * 2. startMemoryGuardian — integration: fake performance.memory + fake
 *    timers, asserts `lazy:memory-pressure` CustomEvents are dispatched on
 *    `window` with the right detail, rate-limited, re-armed on drop-below,
 *    stop() halts polling, and an absent performance.memory API never
 *    throws and never emits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateMemoryLevel,
  createInitialLevelState,
  startMemoryGuardian,
  MEMORY_PRESSURE_EVENT,
  MEMORY_GUARDIAN_SOFT_THRESHOLD_BYTES,
  MEMORY_GUARDIAN_HARD_THRESHOLD_BYTES,
  MEMORY_GUARDIAN_POLL_INTERVAL_MS,
  MEMORY_GUARDIAN_RATE_LIMIT_MS,
  type MemoryPressureEventDetail,
  type MemoryGuardianHandle,
} from '../lib/agents/memoryGuardian';

// ── Test helpers ─────────────────────────────────────────────────────

/** Sets (or removes) the non-standard performance.memory extension. */
function setUsedJSHeapSize(bytes: number | undefined): void {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
  if (bytes === undefined) {
    delete perf.memory;
    return;
  }
  perf.memory = { usedJSHeapSize: bytes };
}

function collectPressureEvents(): MemoryPressureEventDetail[] {
  const events: MemoryPressureEventDetail[] = [];
  window.addEventListener(MEMORY_PRESSURE_EVENT, ((e: Event) => {
    events.push((e as CustomEvent<MemoryPressureEventDetail>).detail);
  }) as EventListener);
  return events;
}

let activeHandle: MemoryGuardianHandle | null = null;

function start(opts: Parameters<typeof startMemoryGuardian>[0]): MemoryGuardianHandle {
  activeHandle = startMemoryGuardian(opts);
  return activeHandle;
}

afterEach(() => {
  activeHandle?.stop();
  activeHandle = null;
  setUsedJSHeapSize(undefined);
  vi.useRealTimers();
});

// ── evaluateMemoryLevel — pure decision logic ───────────────────────

describe('evaluateMemoryLevel', () => {
  const THRESHOLD = 1000;
  const RATE_LIMIT = 60_000;

  it('does not fire while usage stays below threshold', () => {
    const state = createInitialLevelState();
    const result = evaluateMemoryLevel(state, 500, THRESHOLD, RATE_LIMIT, 0);
    expect(result.fired).toBe(false);
    expect(result.state).toBe(state); // same reference — no gratuitous allocation
  });

  it('fires on first crossing of the threshold', () => {
    const state = createInitialLevelState();
    const result = evaluateMemoryLevel(state, 1000, THRESHOLD, RATE_LIMIT, 1_000);
    expect(result.fired).toBe(true);
    expect(result.state).toEqual({ armed: false, lastFiredAtMs: 1_000 });
  });

  it('does not fire again while usage stays above threshold (armed=false, no cooldown reached)', () => {
    const fired = evaluateMemoryLevel(createInitialLevelState(), 1000, THRESHOLD, RATE_LIMIT, 1_000);
    const again = evaluateMemoryLevel(fired.state, 1500, THRESHOLD, RATE_LIMIT, 1_500);
    expect(again.fired).toBe(false);
    expect(again.state).toBe(fired.state);
  });

  it('re-arms once usage drops back below threshold', () => {
    const fired = evaluateMemoryLevel(createInitialLevelState(), 1000, THRESHOLD, RATE_LIMIT, 1_000);
    const dropped = evaluateMemoryLevel(fired.state, 500, THRESHOLD, RATE_LIMIT, 2_000);
    expect(dropped.fired).toBe(false);
    expect(dropped.state.armed).toBe(true);
  });

  it('does not re-fire immediately after re-arming when still within the rate-limit window', () => {
    const fired = evaluateMemoryLevel(createInitialLevelState(), 1000, THRESHOLD, RATE_LIMIT, 1_000);
    const dropped = evaluateMemoryLevel(fired.state, 500, THRESHOLD, RATE_LIMIT, 1_100);
    // Re-armed AND above threshold again, but only 100ms after the first
    // firing — well inside the 60s rate-limit window (flapping case).
    const flapped = evaluateMemoryLevel(dropped.state, 1000, THRESHOLD, RATE_LIMIT, 1_200);
    expect(flapped.fired).toBe(false);
  });

  it('fires again once BOTH re-armed AND the rate-limit window has elapsed', () => {
    const fired = evaluateMemoryLevel(createInitialLevelState(), 1000, THRESHOLD, RATE_LIMIT, 0);
    const dropped = evaluateMemoryLevel(fired.state, 500, THRESHOLD, RATE_LIMIT, 100);
    const later = evaluateMemoryLevel(dropped.state, 1000, THRESHOLD, RATE_LIMIT, RATE_LIMIT + 1);
    expect(later.fired).toBe(true);
  });

  it('does not fire again while sustained above threshold even after the rate-limit window elapses without a drop-below', () => {
    const fired = evaluateMemoryLevel(createInitialLevelState(), 1000, THRESHOLD, RATE_LIMIT, 0);
    // Never dropped below threshold — armed stays false forever.
    const later = evaluateMemoryLevel(fired.state, 1000, THRESHOLD, RATE_LIMIT, RATE_LIMIT + 1);
    expect(later.fired).toBe(false);
  });
});

// ── startMemoryGuardian — integration (fake timers + fake performance.memory) ──

describe('startMemoryGuardian', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('uses the documented defaults for cadence and thresholds when opts are omitted', () => {
    expect(MEMORY_GUARDIAN_POLL_INTERVAL_MS).toBe(30_000);
    expect(MEMORY_GUARDIAN_SOFT_THRESHOLD_BYTES).toBe(1500 * 1024 * 1024);
    expect(MEMORY_GUARDIAN_HARD_THRESHOLD_BYTES).toBe(2200 * 1024 * 1024);
    expect(MEMORY_GUARDIAN_RATE_LIMIT_MS).toBe(3 * 60_000);
  });

  it('dispatches a soft-level event with correct detail when usage is already above the soft threshold at start', () => {
    setUsedJSHeapSize(1_600 * 1024 * 1024); // above 1500MB soft, below 2200MB hard
    const events = collectPressureEvents();

    start({});

    expect(events).toEqual([{ level: 'soft', usedMB: 1600 }]);
  });

  it('dispatches both soft and hard when usage starts above the hard threshold', () => {
    setUsedJSHeapSize(2_300 * 1024 * 1024);
    const events = collectPressureEvents();

    start({});

    expect(events).toEqual([
      { level: 'soft', usedMB: 2300 },
      { level: 'hard', usedMB: 2300 },
    ]);
  });

  it('does not dispatch anything while usage stays under both thresholds', () => {
    setUsedJSHeapSize(500 * 1024 * 1024);
    const events = collectPressureEvents();

    start({});
    vi.advanceTimersByTime(MEMORY_GUARDIAN_POLL_INTERVAL_MS * 5);

    expect(events).toEqual([]);
  });

  it('polls on the configured cadence and does not re-fire the same level on every tick while sustained above', () => {
    setUsedJSHeapSize(1_600 * 1024 * 1024);
    const events = collectPressureEvents();

    start({ pollIntervalMs: 1_000, rateLimitMs: 60_000 });
    expect(events).toHaveLength(1); // immediate poll on start

    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);

    expect(events).toHaveLength(1); // still armed=false, no drop-below yet
  });

  it('re-arms and fires again after usage drops below and the rate-limit window elapses', () => {
    setUsedJSHeapSize(1_600 * 1024 * 1024);
    const events = collectPressureEvents();

    start({ pollIntervalMs: 1_000, rateLimitMs: 5_000 });
    expect(events).toHaveLength(1);

    setUsedJSHeapSize(500 * 1024 * 1024); // drop below soft — re-arms
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(1); // drop-below never fires by itself

    setUsedJSHeapSize(1_600 * 1024 * 1024); // back above, but still < 5s since last fire
    vi.advanceTimersByTime(1_000);
    expect(events).toHaveLength(1); // rate-limited

    vi.advanceTimersByTime(5_000); // now well past the 5s cooldown
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ level: 'soft', usedMB: 1600 });
  });

  it('respects custom thresholds passed via opts', () => {
    setUsedJSHeapSize(100 * 1024 * 1024);
    const events = collectPressureEvents();

    start({ softThresholdBytes: 50 * 1024 * 1024, hardThresholdBytes: 90 * 1024 * 1024 });

    expect(events).toEqual([
      { level: 'soft', usedMB: 100 },
      { level: 'hard', usedMB: 100 },
    ]);
  });

  it('stop() halts polling — no further events after stop even if usage keeps rising', () => {
    setUsedJSHeapSize(500 * 1024 * 1024);
    const events = collectPressureEvents();

    const handle = start({ pollIntervalMs: 1_000 });
    expect(events).toEqual([]);

    handle.stop();
    setUsedJSHeapSize(3_000 * 1024 * 1024);
    vi.advanceTimersByTime(10_000);

    expect(events).toEqual([]);
  });

  it('stop() is idempotent', () => {
    const handle = start({});
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it('never throws and never emits when performance.memory is absent', () => {
    setUsedJSHeapSize(undefined);
    const events = collectPressureEvents();

    expect(() => {
      start({ pollIntervalMs: 1_000 });
      vi.advanceTimersByTime(10_000);
    }).not.toThrow();

    expect(events).toEqual([]);
  });

  it('never throws when usedJSHeapSize is present but malformed (non-finite)', () => {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
    perf.memory = { usedJSHeapSize: Number.NaN };
    const events = collectPressureEvents();

    expect(() => {
      start({ pollIntervalMs: 1_000 });
      vi.advanceTimersByTime(10_000);
    }).not.toThrow();

    expect(events).toEqual([]);
  });
});
