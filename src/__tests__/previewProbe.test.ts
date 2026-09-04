/**
 * Tests for previewProbe.ts — the R13 polling state machine that replaced
 * PreviewNode.tsx's old one-shot 2.5s reachability probe. Pure functions
 * only (no timers, no fetch) — see previewProbe.ts's own header for why the
 * state machine is factored out this way.
 */

import { describe, it, expect } from 'vitest';
import {
  initialProbeSnapshot,
  nextProbeDelayMs,
  reduceProbeResult,
  PREVIEW_PROBE_INITIAL_DELAY_MS,
  PREVIEW_PROBE_MAX_DELAY_MS,
  PREVIEW_PROBE_TIMEOUT_MS,
} from '../components/agents/canvas/nodes/previewProbe';

describe('initialProbeSnapshot', () => {
  it('starts in "checking" with attempt 0', () => {
    expect(initialProbeSnapshot()).toEqual({ state: 'checking', attempt: 0, elapsedMs: 0 });
  });
});

describe('nextProbeDelayMs', () => {
  it('starts at the initial delay for the first retry', () => {
    expect(nextProbeDelayMs(1)).toBe(PREVIEW_PROBE_INITIAL_DELAY_MS);
  });

  it('grows exponential-ish across subsequent attempts', () => {
    const d1 = nextProbeDelayMs(1);
    const d2 = nextProbeDelayMs(2);
    const d3 = nextProbeDelayMs(3);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it('caps at PREVIEW_PROBE_MAX_DELAY_MS and never exceeds it, even for a large attempt count', () => {
    expect(nextProbeDelayMs(20)).toBe(PREVIEW_PROBE_MAX_DELAY_MS);
    expect(nextProbeDelayMs(100)).toBe(PREVIEW_PROBE_MAX_DELAY_MS);
  });

  it('never returns a delay below the initial delay (attempt 0 clamps to attempt 1 shape)', () => {
    expect(nextProbeDelayMs(0)).toBe(PREVIEW_PROBE_INITIAL_DELAY_MS);
  });
});

describe('reduceProbeResult', () => {
  it('a successful probe from "checking" transitions straight to "reachable" and stops polling', () => {
    const result = reduceProbeResult(initialProbeSnapshot(), true, 500);
    expect(result.snapshot.state).toBe('reachable');
    expect(result.snapshot.attempt).toBe(1);
    expect(result.shouldContinue).toBe(false);
    expect(result.nextDelayMs).toBe(0);
  });

  it('a failed FIRST probe (still well within the timeout) transitions to "starting" and schedules a retry', () => {
    const result = reduceProbeResult(initialProbeSnapshot(), false, 2500);
    expect(result.snapshot.state).toBe('starting');
    expect(result.snapshot.attempt).toBe(1);
    expect(result.shouldContinue).toBe(true);
    expect(result.nextDelayMs).toBeGreaterThan(0);
    expect(result.nextDelayMs).toBeLessThanOrEqual(PREVIEW_PROBE_MAX_DELAY_MS);
  });

  it('a failed probe that just crossed the timeout window transitions to "unreachable" and stops polling', () => {
    const result = reduceProbeResult(initialProbeSnapshot(), false, PREVIEW_PROBE_TIMEOUT_MS);
    expect(result.snapshot.state).toBe('unreachable');
    expect(result.shouldContinue).toBe(false);
    expect(result.nextDelayMs).toBe(0);
  });

  it('a failed probe just BEFORE the timeout window still continues polling', () => {
    const result = reduceProbeResult(initialProbeSnapshot(), false, PREVIEW_PROBE_TIMEOUT_MS - 1);
    expect(result.snapshot.state).toBe('starting');
    expect(result.shouldContinue).toBe(true);
  });

  it('a success AFTER several failed "starting" attempts still reports "reachable" (a late-binding dev server)', () => {
    let snapshot = initialProbeSnapshot();
    let result = reduceProbeResult(snapshot, false, 2000);
    snapshot = result.snapshot;
    result = reduceProbeResult(snapshot, false, 4500);
    snapshot = result.snapshot;
    expect(snapshot.state).toBe('starting');
    expect(snapshot.attempt).toBe(2);

    result = reduceProbeResult(snapshot, true, 7000);
    expect(result.snapshot.state).toBe('reachable');
    expect(result.snapshot.attempt).toBe(3);
    expect(result.shouldContinue).toBe(false);
  });

  it('attempt count increments monotonically across a realistic full failing sequence up to timeout', () => {
    let snapshot = initialProbeSnapshot();
    let elapsed = 0;
    let iterations = 0;
    let last = reduceProbeResult(snapshot, false, elapsed);
    while (last.shouldContinue && iterations < 100) {
      elapsed += last.nextDelayMs;
      snapshot = last.snapshot;
      const prevAttempt = snapshot.attempt;
      last = reduceProbeResult(snapshot, false, elapsed);
      expect(last.snapshot.attempt).toBe(prevAttempt + 1);
      iterations += 1;
    }
    // Must have honestly terminated at 'unreachable', never spun forever.
    expect(last.snapshot.state).toBe('unreachable');
    expect(last.shouldContinue).toBe(false);
    expect(iterations).toBeLessThan(100);
  });

  it('verdict consistency: the SAME (snapshot, ok, elapsedMs) input always reduces to the SAME output', () => {
    const snapshot = { state: 'starting' as const, attempt: 3, elapsedMs: 9000 };
    const a = reduceProbeResult(snapshot, false, 12000);
    const b = reduceProbeResult(snapshot, false, 12000);
    expect(a).toEqual(b);
  });
});
