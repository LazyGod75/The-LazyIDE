/**
 * Tests for the in-memory login rate limiter.
 * Uses an injectable fake clock for deterministic time control.
 */

import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/auth/rate-limit.js';

function makeLimiter(startMs = 0): { limiter: RateLimiter; advance: (ms: number) => void } {
  let time = startMs;
  const clock = { now: () => time };
  const limiter = new RateLimiter(clock);
  const advance = (ms: number) => {
    time += ms;
  };
  return { limiter, advance };
}

describe('RateLimiter', () => {
  it('allows attempts with no prior failures', () => {
    const { limiter } = makeLimiter();
    expect(limiter.isAllowed('alice', '1.2.3.4')).toBe(true);
  });

  it('still allows after fewer than 5 failures', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    expect(limiter.isAllowed('alice', '1.2.3.4')).toBe(true);
  });

  it('locks after exactly 5 failures (by username)', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    expect(limiter.isAllowed('alice', '9.9.9.9')).toBe(false);
  });

  it('locks after exactly 5 failures (by IP)', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('user1', '10.0.0.1');
    }
    expect(limiter.isAllowed('other-user', '10.0.0.1')).toBe(false);
  });

  it('unlocks after the 60-second lockout period', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    expect(limiter.isAllowed('alice', '1.2.3.4')).toBe(false);
    advance(60_001);
    expect(limiter.isAllowed('alice', '1.2.3.4')).toBe(true);
  });

  it('resets counter on success', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    limiter.recordSuccess('alice', '1.2.3.4');
    // Now should start fresh — 5 new failures needed to lock
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    expect(limiter.isAllowed('alice', '1.2.3.4')).toBe(true);
  });

  it('lockoutRemainingMs returns positive value while locked', () => {
    const { limiter } = makeLimiter(1000);
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    const remaining = limiter.lockoutRemainingMs('alice', 'username');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it('lockoutRemainingMs returns 0 when not locked', () => {
    const { limiter } = makeLimiter();
    expect(limiter.lockoutRemainingMs('alice', 'username')).toBe(0);
  });

  it('lockoutRemainingMs returns 0 after lock expires', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    advance(60_001);
    expect(limiter.lockoutRemainingMs('alice', 'username')).toBe(0);
  });

  it('different usernames are tracked independently', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('alice', '1.2.3.4');
    }
    expect(limiter.isAllowed('bob', '1.2.3.5')).toBe(true);
  });
});
