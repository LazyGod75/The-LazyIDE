import { describe, it, expect } from 'vitest';
import {
  BRAIN_REACHABLE_NEGATIVE_TTL_MS,
  BRAIN_REACHABLE_POSITIVE_TTL_MS,
  readBrainReachableCache,
} from '../lib/platform/brainReachableCache';

describe('readBrainReachableCache', () => {
  it('misses when there is no entry', () => {
    expect(readBrainReachableCache(null, 1_000)).toBeNull();
  });

  it('force always misses so retrySidecar re-probes', () => {
    expect(readBrainReachableCache({ value: false, atMs: 1_000 }, 1_100, true)).toBeNull();
    expect(readBrainReachableCache({ value: true, atMs: 1_000 }, 1_100, true)).toBeNull();
  });

  it('keeps a negative result only for the short TTL', () => {
    const entry = { value: false, atMs: 1_000 };
    expect(readBrainReachableCache(entry, 1_000 + BRAIN_REACHABLE_NEGATIVE_TTL_MS - 1)).toBe(false);
    expect(readBrainReachableCache(entry, 1_000 + BRAIN_REACHABLE_NEGATIVE_TTL_MS)).toBeNull();
  });

  it('keeps a positive result for the longer TTL', () => {
    const entry = { value: true, atMs: 1_000 };
    expect(readBrainReachableCache(entry, 1_000 + BRAIN_REACHABLE_POSITIVE_TTL_MS - 1)).toBe(true);
    expect(readBrainReachableCache(entry, 1_000 + BRAIN_REACHABLE_POSITIVE_TTL_MS)).toBeNull();
  });
});
