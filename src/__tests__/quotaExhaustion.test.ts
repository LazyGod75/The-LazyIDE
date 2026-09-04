/**
 * quotaExhaustion.test.ts — detection for the Claude CLI's own subscription/
 * session quota-exhaustion condition (quotaExhaustion.ts), the real
 * incident's root cause: seven missions (M68-M74) hit the CLI's
 *   "You've hit your session limit · resets 12:30am (Europe/Paris)"
 * and the app classified every one as an ordinary agent failure.
 *
 * Required coverage (see the task brief):
 *   1. the exact incident string is detected, with the reset time parsed.
 *   2. a variant without a reset time is detected too (resetLabel absent).
 *   3. an ordinary mission failure is NOT misclassified.
 *   4. a task whose text merely MENTIONS "session limit" does not
 *      false-positive.
 */

import { describe, it, expect } from 'vitest';
import { detectQuotaExhaustion, formatQuotaExhaustionReason } from '../lib/agents/quotaExhaustion';

describe('detectQuotaExhaustion', () => {
  it('detects the exact incident string, with the reset time parsed', () => {
    const info = detectQuotaExhaustion("You've hit your session limit · resets 12:30am (Europe/Paris)");
    expect(info).not.toBeNull();
    expect(info?.resetLabel).toBe('12:30am (Europe/Paris)');
    expect(typeof info?.resetAtMs).toBe('number');
    expect(info?.resetAtMs).toBeGreaterThan(Date.now());
  });

  it('resolves the reset time to the very next occurrence of that wall-clock time (overnight rollover)', () => {
    // 23:07 Europe/Paris, CLI reports "resets 00:30" (i.e. 00:30 the very
    // next calendar day, ~83 minutes later) — not a whole extra day out.
    const now = Date.UTC(2026, 7, 19, 21, 7); // 2026-08-19T21:07:00Z == 23:07 CEST
    const info = detectQuotaExhaustion(
      "You've hit your session limit · resets 12:30am (Europe/Paris)",
      now,
    );
    expect(info?.resetAtMs).toBeDefined();
    const deltaMs = (info!.resetAtMs as number) - now;
    // ~83 minutes, generously bounded to tolerate DST edge cases.
    expect(deltaMs).toBeGreaterThan(0);
    expect(deltaMs).toBeLessThan(3 * 60 * 60 * 1000);
  });

  it('detects a curly-apostrophe / "you have" variant (CLI phrasing tolerance)', () => {
    expect(detectQuotaExhaustion('You’ve hit your usage limit.')).not.toBeNull();
    expect(detectQuotaExhaustion('You have hit your session limit.')).not.toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectQuotaExhaustion("you've hit your SESSION LIMIT")).not.toBeNull();
  });

  it('detects a variant with no reset time at all — resetLabel/resetAtMs both absent', () => {
    const info = detectQuotaExhaustion("You've hit your session limit.");
    expect(info).not.toBeNull();
    expect(info?.resetLabel).toBeUndefined();
    expect(info?.resetAtMs).toBeUndefined();
  });

  it('does NOT misclassify an ordinary mission/task failure', () => {
    expect(detectQuotaExhaustion('test suite exit code 1: 3 tests failed')).toBeNull();
    expect(detectQuotaExhaustion('ECONNREFUSED: connect failed')).toBeNull();
    expect(detectQuotaExhaustion('TypeError: cannot read property of undefined')).toBeNull();
  });

  it('does NOT false-positive on a task whose text merely mentions "session limit"', () => {
    expect(
      detectQuotaExhaustion('Implement session limit handling for the rate limiter middleware'),
    ).toBeNull();
    expect(
      detectQuotaExhaustion('Add a config option to raise the session limit and document it'),
    ).toBeNull();
    expect(detectQuotaExhaustion('The API returns 429 rate limit exceeded on bursts')).toBeNull();
  });

  it('does NOT false-positive on an unrelated mention of "usage limit" without the CLI construction', () => {
    expect(detectQuotaExhaustion('Our current usage limit is 1000 requests/day')).toBeNull();
  });
});

describe('formatQuotaExhaustionReason', () => {
  it('names both the cause and the reset time when known', () => {
    const reason = formatQuotaExhaustionReason({ resetLabel: '12:30am (Europe/Paris)' });
    expect(reason).toContain('quota');
    expect(reason).toContain('12:30am (Europe/Paris)');
  });

  it('is still honest (never "see agent logs") when no reset time is known', () => {
    const reason = formatQuotaExhaustionReason({});
    expect(reason).toContain('quota');
    expect(reason.toLowerCase()).not.toContain('see agent logs');
  });
});
