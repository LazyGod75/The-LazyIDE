/**
 * Tests for /_api/tree in-memory cache invalidation behavior.
 *
 * Key scenarios:
 *   - Result is cached for the same fingerprint (no rebuild).
 *   - Cache is invalidated when the fingerprint changes.
 *   - Stale data is never served after a fingerprint change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexVersionedCache, computeNotesFingerprint } from '../cache.js';

// ---------------------------------------------------------------------------
// IndexVersionedCache — invalidation contract
// ---------------------------------------------------------------------------

describe('IndexVersionedCache — tree cache invalidation', () => {
  let cache: IndexVersionedCache<{ projects: unknown[] }>;

  beforeEach(() => {
    cache = new IndexVersionedCache<{ projects: unknown[] }>();
  });

  it('returns cached result for the same fingerprint (no rebuild)', () => {
    const built = { projects: [{ id: 'a', label: 'A' }] };
    cache.set('5:1000', built);
    const cached = cache.get('5:1000');
    expect(cached).toBe(built); // same reference — no rebuild happened
  });

  it('returns null when fingerprint changes (signals rebuild needed)', () => {
    const built = { projects: [{ id: 'a', label: 'A' }] };
    cache.set('5:1000', built);
    // Fingerprint changes after a reindex: 6 notes, newer mtime
    expect(cache.get('6:2000')).toBeNull();
  });

  it('serves new result after rebuild with new fingerprint', () => {
    cache.set('5:1000', { projects: [{ id: 'old' }] });
    // Simulate reindex
    const newResult = { projects: [{ id: 'old' }, { id: 'new' }] };
    cache.set('6:2000', newResult);
    expect(cache.get('6:2000')).toBe(newResult);
  });

  it('does NOT serve old result after fingerprint changes', () => {
    const oldResult = { projects: [{ id: 'old' }] };
    cache.set('5:1000', oldResult);
    // Fingerprint changed
    cache.set('6:2000', { projects: [{ id: 'new' }] });
    // Old fingerprint lookup returns null — stale data not accessible
    expect(cache.get('5:1000')).toBeNull();
  });

  it('invalidate() forces rebuild on next access', () => {
    cache.set('5:1000', { projects: [] });
    cache.invalidate();
    expect(cache.get('5:1000')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeNotesFingerprint — sensitivity to note count and mtime changes
// ---------------------------------------------------------------------------

describe('computeNotesFingerprint — detects index changes', () => {
  it('produces different fingerprints for different note counts', () => {
    const notes5 = Array.from({ length: 5 }, (_, i) => ({ mtime_ms: 1000 + i }));
    const notes6 = Array.from({ length: 6 }, (_, i) => ({ mtime_ms: 1000 + i }));
    expect(computeNotesFingerprint(notes5)).not.toBe(computeNotesFingerprint(notes6));
  });

  it('produces different fingerprints when mtime changes', () => {
    const notesOld = [{ mtime_ms: 1000 }, { mtime_ms: 2000 }];
    const notesNew = [{ mtime_ms: 1000 }, { mtime_ms: 3000 }];
    expect(computeNotesFingerprint(notesOld)).not.toBe(computeNotesFingerprint(notesNew));
  });

  it('produces same fingerprint for same notes (deterministic)', () => {
    const notes = Array.from({ length: 10 }, (_, i) => ({ mtime_ms: (i + 1) * 1000 }));
    expect(computeNotesFingerprint(notes)).toBe(computeNotesFingerprint(notes));
  });

  it('returns "empty" for an empty array', () => {
    expect(computeNotesFingerprint([])).toBe('empty');
  });

  it('handles notes with null mtime_ms', () => {
    const notes = [{ mtime_ms: null as number | null }, { mtime_ms: 500 }];
    const fp = computeNotesFingerprint(notes);
    expect(typeof fp).toBe('string');
    expect(fp).not.toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// Simulated cache lifecycle (as used in tree/hierarchy handlers)
// ---------------------------------------------------------------------------

describe('cache lifecycle — rebuild only when fingerprint changes', () => {
  it('does not rebuild when fingerprint is stable', () => {
    const cache = new IndexVersionedCache<string>();
    const buildFn = vi.fn(() => 'tree-result');

    const fp = '10:5000';

    // First call: miss → build
    let result = cache.get(fp);
    if (!result) {
      result = buildFn();
      cache.set(fp, result);
    }
    expect(buildFn).toHaveBeenCalledTimes(1);

    // Second call: hit → no rebuild
    let result2 = cache.get(fp);
    if (!result2) {
      result2 = buildFn();
      cache.set(fp, result2);
    }
    expect(buildFn).toHaveBeenCalledTimes(1); // still 1

    expect(result2).toBe('tree-result');
  });

  it('rebuilds exactly once when fingerprint changes', () => {
    const cache = new IndexVersionedCache<string>();
    const buildFn = vi.fn((fp: string) => `result-for-${fp}`);

    // Build for fp1
    let fp = '5:1000';
    let result = cache.get(fp);
    if (!result) {
      result = buildFn(fp);
      cache.set(fp, result);
    }

    // Simulate reindex: fp2
    fp = '6:2000';
    let result2 = cache.get(fp);
    if (!result2) {
      result2 = buildFn(fp);
      cache.set(fp, result2);
    }

    expect(buildFn).toHaveBeenCalledTimes(2);
    expect(result2).toBe('result-for-6:2000');

    // Third call with same fp2: no rebuild
    let result3 = cache.get(fp);
    if (!result3) {
      result3 = buildFn(fp);
      cache.set(fp, result3);
    }
    expect(buildFn).toHaveBeenCalledTimes(2); // still 2
  });
});
