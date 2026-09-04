import { describe, expect, it } from 'vitest';
import { mapLimit, resolveConcurrencyEnv } from '../concurrency.js';

// ---------------------------------------------------------------------------
// mapLimit
// ---------------------------------------------------------------------------

describe('mapLimit', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Item 0 resolves slowest, item 4 resolves fastest — output must still
    // be [0, 1, 2, 3, 4], matching the ORIGINAL sequential for-loop's
    // ordering guarantee, not completion order.
    const delays = [50, 40, 30, 20, 10];
    const results = await mapLimit(delays, 5, async (delay, i) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('never runs more than `limit` calls concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 11 }, (_, i) => i);

    await mapLimit(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // sanity: concurrency actually happened
  });

  it('processes every item exactly once, even when limit exceeds item count', async () => {
    const items = ['a', 'b', 'c'];
    const seen: string[] = [];
    const results = await mapLimit(items, 50, async (item) => {
      seen.push(item);
      return item.toUpperCase();
    });
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(results).toEqual(['A', 'B', 'C']);
  });

  it('returns [] for an empty input without calling fn', async () => {
    let calls = 0;
    const results = await mapLimit([], 5, async () => {
      calls++;
      return null;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('clamps a non-positive or fractional limit to a safe minimum', async () => {
    const results = await mapLimit([1, 2, 3], 0, async (n) => n * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it('propagates a rejection from fn', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// resolveConcurrencyEnv
// ---------------------------------------------------------------------------

describe('resolveConcurrencyEnv', () => {
  it('uses the fallback when the env value is undefined', () => {
    expect(resolveConcurrencyEnv(undefined, 5, 1, 12)).toBe(5);
  });

  it('uses the fallback when the env value is blank or non-numeric', () => {
    expect(resolveConcurrencyEnv('', 5, 1, 12)).toBe(5);
    expect(resolveConcurrencyEnv('nope', 5, 1, 12)).toBe(5);
  });

  it('parses a valid numeric override', () => {
    expect(resolveConcurrencyEnv('8', 5, 1, 12)).toBe(8);
  });

  it('clamps below the minimum', () => {
    expect(resolveConcurrencyEnv('0', 5, 1, 12)).toBe(1);
    expect(resolveConcurrencyEnv('-3', 5, 1, 12)).toBe(1);
  });

  it('clamps above the maximum', () => {
    expect(resolveConcurrencyEnv('999', 5, 1, 12)).toBe(12);
  });
});
