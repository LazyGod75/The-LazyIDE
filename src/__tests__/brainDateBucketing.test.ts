/* Brain Canvas — time-travel date bucketing (canvas/dateBucketing.ts). */

import { describe, it, expect } from 'vitest';
import {
  TIME_BUCKET_COUNT,
  assignDateBuckets,
  buildDateAxis,
  hashDateBucket,
  hashString,
  visibleAtTimeIdx,
} from '../components/brain/canvas/dateBucketing';

describe('canvas/dateBucketing — hashString', () => {
  it('is deterministic for the same input', () => {
    expect(hashString('note-123')).toBe(hashString('note-123'));
  });

  it('differs for different inputs (not a constant function)', () => {
    expect(hashString('note-123')).not.toBe(hashString('note-124'));
  });

  it('always returns a non-negative 32-bit integer', () => {
    const h = hashString('some/real/looking-id-with-slashes.ts');
    expect(h).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('canvas/dateBucketing — hashDateBucket', () => {
  it('always falls within [0, TIME_BUCKET_COUNT)', () => {
    for (let i = 0; i < 200; i++) {
      const bucket = hashDateBucket(`node-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(TIME_BUCKET_COUNT);
    }
  });

  it('is stable across calls for the same id', () => {
    expect(hashDateBucket('decision-oauth-migration')).toBe(hashDateBucket('decision-oauth-migration'));
  });

  it('spreads a reasonably sized id set across more than one bucket', () => {
    const buckets = new Set(Array.from({ length: 64 }, (_, i) => hashDateBucket(`item-${i}`)));
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe('canvas/dateBucketing — assignDateBuckets', () => {
  it('falls back to hashDateBucket for every item when none carry a timestamp', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const buckets = assignDateBuckets(items);
    for (const item of items) {
      expect(buckets.get(item.id)).toBe(hashDateBucket(item.id));
    }
  });

  it('spreads dated items across the full bucket range by chronological rank (oldest -> bucket 0, newest -> last bucket)', () => {
    // 16 items spanning just over a year, evenly spaced.
    const items = Array.from({ length: 16 }, (_, i) => ({
      id: `n${i}`,
      createdAt: new Date(2025, 0, 1 + i * 24).toISOString(),
    }));
    const buckets = assignDateBuckets(items);

    expect(buckets.get('n0')).toBe(0);
    expect(buckets.get('n15')).toBe(TIME_BUCKET_COUNT - 1);

    // Monotonic non-decreasing bucket as chronology advances.
    let previous = -1;
    for (const item of items) {
      const bucket = buckets.get(item.id)!;
      expect(bucket).toBeGreaterThanOrEqual(previous);
      previous = bucket;
    }
  });

  it('handles a mixed batch: dated items ordered by quantile, undated items via hash fallback', () => {
    const items = [
      { id: 'old', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'new', createdAt: '2026-06-01T00:00:00.000Z' },
      { id: 'undated-1' },
      { id: 'undated-2', createdAt: null },
      { id: 'unparseable', createdAt: 'not-a-date' },
    ];
    const buckets = assignDateBuckets(items);

    expect(buckets.get('old')).toBe(0);
    expect(buckets.get('new')).toBe(TIME_BUCKET_COUNT - 1);
    expect(buckets.get('undated-1')).toBe(hashDateBucket('undated-1'));
    expect(buckets.get('undated-2')).toBe(hashDateBucket('undated-2'));
    expect(buckets.get('unparseable')).toBe(hashDateBucket('unparseable'));
  });

  it('returns an empty map for an empty input', () => {
    expect(assignDateBuckets([]).size).toBe(0);
  });
});

// ── TimelineScrubber support: buildDateAxis + visibleAtTimeIdx ──────────

describe('canvas/dateBucketing — buildDateAxis', () => {
  it('reports hasRealDates=false and a fully-null bucketDates array for a dateless batch (mock/demo path)', () => {
    const axis = buildDateAxis([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(axis.hasRealDates).toBe(false);
    expect(axis.minCreatedAt).toBeNull();
    expect(axis.maxCreatedAt).toBeNull();
    expect(axis.isSingleDay).toBe(false);
    expect(axis.bucketDates).toHaveLength(TIME_BUCKET_COUNT);
    expect(axis.bucketDates.every((d) => d === null)).toBe(true);
  });

  it('reports the true min/max range for a batch spanning many months', () => {
    const items = Array.from({ length: 16 }, (_, i) => ({
      id: `n${i}`,
      createdAt: new Date(2025, 0, 1 + i * 24).toISOString(),
    }));
    const axis = buildDateAxis(items);
    expect(axis.hasRealDates).toBe(true);
    expect(axis.isSingleDay).toBe(false);
    expect(axis.minCreatedAt).toBe(items[0].createdAt);
    expect(axis.maxCreatedAt).toBe(items[15].createdAt);
    // Newest bucket must resolve to the true newest date (the scrubber's
    // "Tout" position always reveals the real chronological extreme).
    expect(axis.bucketDates[TIME_BUCKET_COUNT - 1]).toBe(items[15].createdAt);
    // bucketDates is cumulative — never regresses as the bucket index grows.
    let previous = '';
    for (const date of axis.bucketDates) {
      if (date === null) continue;
      expect(date >= previous).toBe(true);
      previous = date;
    }
  });

  it('flags isSingleDay=true when every dated item falls on the same calendar day (fresh brain)', () => {
    const axis = buildDateAxis([
      { id: 'a', createdAt: '2026-07-08T08:00:00.000Z' },
      { id: 'b', createdAt: '2026-07-08T14:30:00.000Z' },
      { id: 'c', createdAt: '2026-07-08T23:59:00.000Z' },
    ]);
    expect(axis.hasRealDates).toBe(true);
    expect(axis.isSingleDay).toBe(true);
  });

  it('flags isSingleDay=true for a single dated item (degenerate zero-span case)', () => {
    const axis = buildDateAxis([{ id: 'solo', createdAt: '2026-07-08T08:00:00.000Z' }]);
    expect(axis.isSingleDay).toBe(true);
  });

  it('flags isSingleDay=false once dated items cross a calendar-day boundary', () => {
    const axis = buildDateAxis([
      { id: 'a', createdAt: '2026-07-08T23:00:00.000Z' },
      { id: 'b', createdAt: '2026-07-09T01:00:00.000Z' },
    ]);
    expect(axis.isSingleDay).toBe(false);
  });

  it('derives min/max from the dated subset only, ignoring mixed-in undated items', () => {
    const axis = buildDateAxis([
      { id: 'old', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: 'new', createdAt: '2026-06-01T00:00:00.000Z' },
      { id: 'undated' },
    ]);
    expect(axis.hasRealDates).toBe(true);
    expect(axis.minCreatedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(axis.maxCreatedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('canvas/dateBucketing — visibleAtTimeIdx', () => {
  it('includes only items whose dateIdx is <= the given threshold', () => {
    const items = [
      { id: 'a', dateIdx: 0 },
      { id: 'b', dateIdx: 3 },
      { id: 'c', dateIdx: 7 },
    ];
    expect(visibleAtTimeIdx(items, 0)).toEqual(new Set(['a']));
    expect(visibleAtTimeIdx(items, 3)).toEqual(new Set(['a', 'b']));
    expect(visibleAtTimeIdx(items, 7)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns an empty set when timeIdx is below every item\'s dateIdx', () => {
    const items = [{ id: 'a', dateIdx: 2 }, { id: 'b', dateIdx: 5 }];
    expect(visibleAtTimeIdx(items, -1).size).toBe(0);
  });

  it('mirrors the exact BrainGraph3D render-loop gate: dateIdx <= timeIdx', () => {
    const items = Array.from({ length: TIME_BUCKET_COUNT }, (_, i) => ({ id: `n${i}`, dateIdx: i }));
    for (let timeIdx = 0; timeIdx < TIME_BUCKET_COUNT; timeIdx++) {
      const visible = visibleAtTimeIdx(items, timeIdx);
      for (const item of items) {
        expect(visible.has(item.id)).toBe(item.dateIdx <= timeIdx);
      }
    }
  });

  it('returns an empty set for an empty input', () => {
    expect(visibleAtTimeIdx([], 5).size).toBe(0);
  });
});
