import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActivityWatchdog, DEFAULT_SILENCE_MS, DEFAULT_CEILING_MS } from '../lib/models/activityWatchdog';
import { StreamTimeoutError } from '../lib/models/streamTimeout';

describe('activityWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not fire while pings keep arriving inside the silence window', async () => {
    const onTimeout = vi.fn();
    const watchdog = createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 100_000, onTimeout });

    // Ping every 7s, well under the 10s silence window, for 30s total —
    // this ALONE would exceed the silence window if pings did not reset it.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(7_000);
      watchdog.ping();
    }

    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.dispose();
  });

  it('fires with phase "silence" when nothing pings for longer than the silence window', async () => {
    const onTimeout = vi.fn();
    createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 100_000, onTimeout });

    await vi.advanceTimersByTimeAsync(10_001);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    const err = onTimeout.mock.calls[0][0];
    expect(err).toBeInstanceOf(StreamTimeoutError);
    expect(err.phase).toBe('silence');
  });

  it('ping() resets the silence window (a ping right before the deadline survives)', async () => {
    const onTimeout = vi.fn();
    const watchdog = createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 100_000, onTimeout });

    await vi.advanceTimersByTimeAsync(9_000);
    watchdog.ping();
    // Total elapsed since creation is now 9s + 9s = 18s > silenceMs, but the
    // ping at t=9s should have reset the window, so no fire until t=19s.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_001);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0].phase).toBe('silence');
  });

  it('fires with phase "ceiling" once the absolute ceiling elapses, even with continuous pings', async () => {
    const onTimeout = vi.fn();
    const watchdog = createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 50_000, onTimeout });

    // Ping every 5s (well inside the silence window) for 60s total, so ONLY
    // the absolute ceiling (50s) can explain a timeout here. ping() is a
    // documented no-op once disposed, so pings after the ceiling fires are
    // harmless.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      watchdog.ping();
    }

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0].phase).toBe('ceiling');
  });

  it('ping() after the ceiling has already fired is a no-op (fires exactly once)', async () => {
    const onTimeout = vi.fn();
    const watchdog = createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 50_000, onTimeout });

    await vi.advanceTimersByTimeAsync(50_001);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    watchdog.ping();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('stop (abort signal) disarms the watchdog without ever calling onTimeout', async () => {
    const onTimeout = vi.fn();
    const ac = new AbortController();
    createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 50_000, signal: ac.signal, onTimeout });

    await vi.advanceTimersByTimeAsync(5_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(100_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('an already-aborted signal at creation time disarms the watchdog immediately', async () => {
    const onTimeout = vi.fn();
    const ac = new AbortController();
    ac.abort();
    createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 50_000, signal: ac.signal, onTimeout });

    await vi.advanceTimersByTimeAsync(100_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('dispose() prevents a pending timeout from firing', async () => {
    const onTimeout = vi.fn();
    const watchdog = createActivityWatchdog({ silenceMs: 10_000, ceilingMs: 50_000, onTimeout });

    await vi.advanceTimersByTimeAsync(9_000);
    watchdog.dispose();
    await vi.advanceTimersByTimeAsync(100_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('defaults match the documented 60s silence / 10min ceiling budget', () => {
    expect(DEFAULT_SILENCE_MS).toBe(60_000);
    expect(DEFAULT_CEILING_MS).toBe(600_000);
  });

  it('survives a long, active CLI turn well past the OLD fixed 40s ceiling (regression guard)', async () => {
    // Reproduces the reported bug's shape: sparse tool-use activity (no
    // text at all) spaced past the OLD 15s-first-token/30s-idle budget, but
    // well inside the new default silence window — must NOT time out.
    const onTimeout = vi.fn();
    const watchdog = createActivityWatchdog({ onTimeout }); // real defaults: 60s / 10min

    for (const gapMs of [20_000, 25_000, 20_000]) { // cumulative: 65s, all still active
      await vi.advanceTimersByTimeAsync(gapMs);
      watchdog.ping();
    }
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.dispose();
  });
});
