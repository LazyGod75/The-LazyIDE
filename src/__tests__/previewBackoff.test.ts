/**
 * Tests for previewBackoff.ts — the W-PREVIEWFIX slow backoff schedule that
 * takes over once previewProbe.ts's fast cold-start window has given up.
 * Pure function only (no timers) — same rationale previewProbe.test.ts's own
 * header documents for testing the schedule independent of PreviewNode.tsx's
 * actual setTimeout/fetch wiring.
 */

import { describe, it, expect } from 'vitest';
import {
  hasGivenUpBackoff,
  nextBackoffDelayMs,
  PREVIEW_BACKOFF_GIVE_UP_MS,
  PREVIEW_BACKOFF_MAX_DELAY_MS,
} from '../components/agents/canvas/nodes/previewBackoff';

describe('nextBackoffDelayMs', () => {
  it('follows the 5s / 15s / 45s / 2min / 5min schedule in order', () => {
    expect(nextBackoffDelayMs(1)).toBe(5_000);
    expect(nextBackoffDelayMs(2)).toBe(15_000);
    expect(nextBackoffDelayMs(3)).toBe(45_000);
    expect(nextBackoffDelayMs(4)).toBe(120_000);
    expect(nextBackoffDelayMs(5)).toBe(300_000);
  });

  it('caps at 5 minutes and never exceeds it, even for a huge failure streak', () => {
    expect(nextBackoffDelayMs(6)).toBe(300_000);
    expect(nextBackoffDelayMs(50)).toBe(300_000);
    expect(nextBackoffDelayMs(6)).toBe(PREVIEW_BACKOFF_MAX_DELAY_MS);
  });

  it('clamps a zero or negative streak up to the first (fastest) step', () => {
    expect(nextBackoffDelayMs(0)).toBe(5_000);
    expect(nextBackoffDelayMs(-3)).toBe(5_000);
  });

  it('verdict consistency: the same failure streak always returns the same delay', () => {
    expect(nextBackoffDelayMs(3)).toBe(nextBackoffDelayMs(3));
  });
});

describe('hasGivenUpBackoff — W-PREVIEWFIX-STOP', () => {
  it('is false before the give-up budget is reached', () => {
    expect(hasGivenUpBackoff(0)).toBe(false);
    expect(hasGivenUpBackoff(PREVIEW_BACKOFF_GIVE_UP_MS - 1)).toBe(false);
  });

  it('is true once the give-up budget is reached or exceeded', () => {
    expect(hasGivenUpBackoff(PREVIEW_BACKOFF_GIVE_UP_MS)).toBe(true);
    expect(hasGivenUpBackoff(PREVIEW_BACKOFF_GIVE_UP_MS + 1)).toBe(true);
  });

  it('the give-up budget is the same value as the schedule\'s own capped final step', () => {
    expect(PREVIEW_BACKOFF_GIVE_UP_MS).toBe(PREVIEW_BACKOFF_MAX_DELAY_MS);
  });
});
