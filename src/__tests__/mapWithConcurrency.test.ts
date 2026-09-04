/* mapWithConcurrency — B3.3 unbounded-fan-out regression coverage.
   SourceControlPanel.tsx used Promise.all(files.map(f => platform.git.diff(...)))
   to compute the staged diff — with a user-controlled file list (hundreds of
   staged files on a big commit), that launches hundreds of simultaneous git
   subprocesses at once.

   The first test below reproduces that exact unbounded-fan-out shape
   directly (the "current behavior" Lot B requires capturing) and asserts it
   is unsafe — it launches every call synchronously, so peak concurrency
   equals the full list size. The remaining tests cover the actual fix:
   mapWithConcurrency caps concurrent calls at `limit` while preserving
   input order, exactly like Promise.all but bounded.
*/

import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../lib/concurrency';

function trackConcurrency() {
  let active = 0;
  let maxActive = 0;
  const startOrder: number[] = [];
  const fn = async (n: number): Promise<number> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    startOrder.push(n);
    // Yield at least one microtask before "finishing" — long enough for
    // every synchronously-dispatched call in the buggy Promise.all shape
    // to have already incremented `active` before any of them decrement it.
    await Promise.resolve();
    await Promise.resolve();
    active -= 1;
    return n * 10;
  };
  return { fn, getMaxActive: () => maxActive, startOrder };
}

describe('SourceControlPanel staged-diff fan-out (B3.3)', () => {
  it('reproduces the bug: raw Promise.all over a big file list has unbounded peak concurrency', async () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const { fn, getMaxActive } = trackConcurrency();

    await Promise.all(items.map((n) => fn(n)));

    // The unbounded shape launches all 200 calls at once — this is the bug.
    expect(getMaxActive()).toBe(200);
  });
});

describe('mapWithConcurrency (B3.3 fix)', () => {
  it('never runs more than `limit` calls concurrently on a large list', async () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const { fn, getMaxActive } = trackConcurrency();

    await mapWithConcurrency(items, 8, fn);

    expect(getMaxActive()).toBeLessThanOrEqual(8);
    // And the bound is actually exercised, not trivially satisfied.
    expect(getMaxActive()).toBe(8);
  });

  it('returns results in the original input order regardless of completion order', async () => {
    const items = [50, 10, 30, 5, 40, 20, 60, 15, 35, 25];
    // Resolution delay is inversely related to value, so results settle in
    // a different order than the input — order preservation must come from
    // index bookkeeping, not from completion sequence.
    const fn = async (n: number): Promise<number> => {
      const delayTicks = Math.floor(n / 10);
      for (let i = 0; i < delayTicks; i += 1) await Promise.resolve();
      return n;
    };

    const results = await mapWithConcurrency(items, 3, fn);

    expect(results).toEqual(items);
  });

  it('resolves to an empty array for an empty input list', async () => {
    const fn = async (n: number): Promise<number> => n;
    const results = await mapWithConcurrency<number, number>([], 8, fn);
    expect(results).toEqual([]);
  });

  it('behaves like Promise.all when limit exceeds the list size', async () => {
    const items = [1, 2, 3];
    const fn = async (n: number): Promise<number> => n * 2;
    const results = await mapWithConcurrency(items, 100, fn);
    expect(results).toEqual([2, 4, 6]);
  });
});
