/**
 * silenceWatchdog.test.ts — pure unit tests for evaluateSilenceRecovery
 * (lib/agents/silenceWatchdog.ts).
 *
 * Bug this module fixes: a mission that goes silent mid-turn (no error, no
 * further action event) with no `contract.maxDurationMs` cap set used to
 * hang forever (real incident, 1535s/~25.6min observed). See
 * silenceWatchdog.ts's header for the full story and runtimeSilenceWatchdog
 * .test.ts for the end-to-end wiring test (runMission's real timer + the
 * paused/awaiting-approval exemption).
 */

import { describe, it, expect } from 'vitest';
import { evaluateSilenceRecovery, SILENCE_WATCHDOG_THRESHOLD_MS, decideSilenceTimeout } from '../lib/agents/silenceWatchdog';

describe('evaluateSilenceRecovery', () => {
  it('retries on the FIRST silence strike (strikeCount 0) — one free pass before failing', () => {
    const decision = evaluateSilenceRecovery(0, SILENCE_WATCHDOG_THRESHOLD_MS);
    expect(decision.action).toBe('retry');
  });

  it('goes terminal ("block") once a mission has ALREADY been retried once (strikeCount 1)', () => {
    const decision = evaluateSilenceRecovery(1, SILENCE_WATCHDOG_THRESHOLD_MS * 2);
    expect(decision.action).toBe('block');
  });

  it('never allows a third silence strike to retry again — every strike past the first is terminal', () => {
    const third = evaluateSilenceRecovery(2, SILENCE_WATCHDOG_THRESHOLD_MS * 3);
    expect(third.action).toBe('block');
  });

  it('reuses recovery.ts\'s environmental-error classification (the synthetic error message contains "timeout")', () => {
    // Not directly observable from the decision alone, but the reason text
    // on the terminal (block) decision must reflect recovery.ts's own
    // environmentalPolicy wording ("Environmental error persists after max
    // retries") rather than the generic defaultPolicy fallback — proves the
    // silence timeout genuinely routed through isEnvironmentalError.
    const decision = evaluateSilenceRecovery(1, SILENCE_WATCHDOG_THRESHOLD_MS * 2);
    expect(decision.reason.toLowerCase()).toContain('environmental');
  });
});

describe('decideSilenceTimeout', () => {
  it('is a no-op once the mission has already settled', () => {
    const r = decideSilenceTimeout({
      settled: true, final: false, paused: false, awaitingHuman: false, strikeCount: 0,
    });
    expect(r.action).toBe('noop');
    expect(r.strikeCount).toBe(0);
  });

  it('rearms without a strike while paused or waiting on a human', () => {
    expect(decideSilenceTimeout({
      settled: false, final: false, paused: true, awaitingHuman: false, strikeCount: 0,
    }).action).toBe('rearm');
    expect(decideSilenceTimeout({
      settled: false, final: false, paused: false, awaitingHuman: true, strikeCount: 0,
    }).action).toBe('rearm');
  });

  it('waits on the first strike and stops on the second', () => {
    const first = decideSilenceTimeout({
      settled: false, final: false, paused: false, awaitingHuman: false, strikeCount: 0,
    });
    expect(first.action).toBe('waiting');
    expect(first.waitingText).toMatch(/silencieux/);
    const second = decideSilenceTimeout({
      settled: false, final: false, paused: false, awaitingHuman: false, strikeCount: first.strikeCount,
    });
    expect(second.action).toBe('stop');
    expect(second.stopReason).toBeTruthy();
  });
});
