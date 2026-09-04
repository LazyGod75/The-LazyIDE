/**
 * Unit tests for write-queue.ts
 *
 * Verifies:
 * - Sequential execution per brain (no interleaving within a brain)
 * - Parallel execution across different brains
 * - Rejection propagates correctly without poisoning subsequent operations
 * - drainAll resolves once all queues are empty
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { drainAll, enqueue, hasPending } from '../../src/engine/write-queue.js';

// Reset queue state between tests by draining
beforeEach(async () => {
  await drainAll();
});

describe('write-queue', () => {
  it('serialises operations on the same brain path', async () => {
    const order: number[] = [];
    const brainPath = '/fake/brain/sequential';

    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const p1 = enqueue(brainPath, async () => {
      await delay(20);
      order.push(1);
    });

    const p2 = enqueue(brainPath, async () => {
      await delay(5);
      order.push(2);
    });

    const p3 = enqueue(brainPath, async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs operations on different brains in parallel', async () => {
    const events: string[] = [];
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const p1 = enqueue('/brain/a', async () => {
      await delay(30);
      events.push('a-done');
    });

    const p2 = enqueue('/brain/b', async () => {
      await delay(5);
      events.push('b-done');
    });

    await Promise.all([p1, p2]);

    // b should finish before a (b has shorter delay)
    expect(events[0]).toBe('b-done');
    expect(events[1]).toBe('a-done');
  });

  it('propagates rejection to the caller without poisoning the queue', async () => {
    const brainPath = '/fake/brain/rejection';
    const order: number[] = [];

    const p1 = enqueue(brainPath, async () => {
      throw new Error('intentional failure');
    });

    const p2 = enqueue(brainPath, async () => {
      order.push(2);
    });

    await expect(p1).rejects.toThrow('intentional failure');
    await p2;
    expect(order).toEqual([2]);
  });

  it('hasPending returns true while operation is in flight', async () => {
    const brainPath = '/fake/brain/pending';
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const p = enqueue(brainPath, () => delay(50));
    expect(hasPending(brainPath)).toBe(true);

    await p;
    // After drain, hasPending should be false (map entry cleaned up)
    await drainAll();
    expect(hasPending(brainPath)).toBe(false);
  });

  it('drainAll resolves after all queues complete', async () => {
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const done: string[] = [];

    enqueue('/brain/x', async () => {
      await delay(20);
      done.push('x');
    });

    enqueue('/brain/y', async () => {
      await delay(10);
      done.push('y');
    });

    await drainAll();
    expect(done).toContain('x');
    expect(done).toContain('y');
  });

  it('returns the thunk return value to the caller', async () => {
    const result = await enqueue('/brain/ret', async () => 42);
    expect(result).toBe(42);
  });
});
