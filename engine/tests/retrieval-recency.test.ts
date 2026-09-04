/**
 * TDD tests for graded recency signal in retrieval ranking (Feature B).
 *
 * The graded recency boost applies a smooth exponential curve:
 *
 *   multiplier = 1 + RECENCY_BOOST_MAX * exp(-ageDays / RECENCY_TAU)
 *
 * where ageDays uses the most-recent of (last_accessed, created), matching how
 * decay.ts computes retention age.
 *
 * Invariants:
 * - multiplier >= 1.0 for any age (no penalty, only lift).
 * - multiplier <= 1 + RECENCY_BOOST_MAX for age = 0 (bounded boost).
 * - Relevance dominates: a gap > RECENCY_BOOST_MAX in base score cannot be
 *   overcome by the boost alone.
 * - Deterministic: same inputs -> same outputs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock getNoteById so the pure recency module can look up note dates.
// The recency module calls getNoteById(id) to read created / last_accessed.
// ---------------------------------------------------------------------------

vi.mock('../src/indexer/fts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/fts.js')>();
  return {
    ...actual,
    getNoteById: vi.fn((id: string) => {
      const store: Record<string, { created?: string; last_accessed?: string }> = {
        'brand-new': { created: '2026-06-08T00:00:00Z' }, // age 0
        'one-day-old': { created: '2026-06-07T00:00:00Z' }, // age 1
        'tau-old': { created: '' }, // set per-test
        ancient: { created: '2020-01-01T00:00:00Z' }, // ~6 years old
        'accessed-recently': {
          created: '2026-01-01T00:00:00Z',
          last_accessed: '2026-06-07T00:00:00Z',
        },
        'only-old': { created: '2026-01-01T00:00:00Z' },
        a: { created: '2026-03-01T00:00:00Z' },
        b: { created: '2026-05-01T00:00:00Z' },
        c: { created: '2026-01-01T00:00:00Z' },
        'relevant-old': { created: '2026-01-01T00:00:00Z' },
        'irrelevant-new': { created: '2026-06-07T00:00:00Z' },
        immutable: { created: '2026-06-01T00:00:00Z' },
        'no-date': {},
      };
      return store[id] ?? null;
    }),
  };
});

import {
  RECENCY_BOOST_MAX,
  RECENCY_TAU,
  applyGradedRecencyBoost,
} from '../src/retrieval/recency.js';
import type { ResolvedHit } from '../src/retrieval/router.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal ResolvedHit for testing
// ---------------------------------------------------------------------------

function makeHit(id: string, score: number): ResolvedHit {
  return {
    id,
    path: `notes/${id}.html`,
    score,
    level: 'L3',
    snippet: 'test snippet',
  };
}

// Fixed "now" for determinism: 2026-06-08T00:00:00Z
const NOW_ISO = '2026-06-08T00:00:00Z';
const NOW_MS = new Date(NOW_ISO).getTime();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RECENCY_BOOST_MAX and RECENCY_TAU constants', () => {
  it('exports RECENCY_BOOST_MAX as a number in (0, 0.25]', () => {
    expect(typeof RECENCY_BOOST_MAX).toBe('number');
    expect(RECENCY_BOOST_MAX).toBeGreaterThan(0);
    expect(RECENCY_BOOST_MAX).toBeLessThanOrEqual(0.25); // bounded: max 25% lift
  });

  it('exports RECENCY_TAU as a positive number', () => {
    expect(typeof RECENCY_TAU).toBe('number');
    expect(RECENCY_TAU).toBeGreaterThan(0);
  });
});

describe('applyGradedRecencyBoost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('newer note ranks higher than older note with identical base relevance', () => {
    const hits = [
      makeHit('ancient', 1.0), // ~6 years old
      makeHit('one-day-old', 1.0), // 1 day old
    ];

    const result = applyGradedRecencyBoost(hits, NOW_MS);

    const newIdx = result.findIndex((h) => h.id === 'one-day-old');
    const oldIdx = result.findIndex((h) => h.id === 'ancient');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('clearly more-relevant old note still outranks barely-relevant new note', () => {
    // Make relevance gap larger than RECENCY_BOOST_MAX to guarantee old wins
    const relevantOld = makeHit('relevant-old', 1.0 + RECENCY_BOOST_MAX + 0.05);
    const irrelevantNew = makeHit('irrelevant-new', 1.0);

    const result = applyGradedRecencyBoost([relevantOld, irrelevantNew], NOW_MS);

    expect(result[0].id).toBe('relevant-old');
  });

  it('old note absolute score is not reduced (multiplier >= 1.0 for any age)', () => {
    const hit = makeHit('ancient', 0.8);
    const result = applyGradedRecencyBoost([hit], NOW_MS);

    // Score must be >= original (no penalty)
    expect(result[0].score).toBeGreaterThanOrEqual(hit.score);
    // For very old notes the multiplier approaches 1.0: score ~ original
    expect(result[0].score).toBeCloseTo(hit.score, 5);
  });

  it('brand-new note (age 0) gets the maximum boost of 1 + RECENCY_BOOST_MAX', () => {
    const hit = makeHit('brand-new', 1.0);
    const result = applyGradedRecencyBoost([hit], NOW_MS);

    const expected = 1.0 * (1 + RECENCY_BOOST_MAX);
    expect(result[0].score).toBeCloseTo(expected, 5);
  });

  it('~TAU-day-old note gets approximately 1 + RECENCY_BOOST_MAX * exp(-1) boost', async () => {
    // We dynamically set the tau-old note's created date in the mock store by
    // overriding the mock for this specific id.
    const { getNoteById } = vi.mocked(await import('../src/indexer/fts.js'));
    const tauAgoIso = new Date(NOW_MS - RECENCY_TAU * 24 * 3600 * 1000).toISOString();
    getNoteById.mockImplementation((id: string) => {
      if (id === 'tau-old') return { created: tauAgoIso } as ReturnType<typeof getNoteById>;
      return undefined;
    });

    const hit = makeHit('tau-old', 1.0);
    const result = applyGradedRecencyBoost([hit], NOW_MS);

    const expectedMultiplier = 1 + RECENCY_BOOST_MAX * Math.exp(-1);
    expect(result[0].score).toBeCloseTo(1.0 * expectedMultiplier, 4);
  });

  it('prefers last_accessed over created when last_accessed is more recent', () => {
    const hits = [
      makeHit('accessed-recently', 1.0), // created old, last_accessed recent
      makeHit('only-old', 1.0), // created old, no access
    ];

    const result = applyGradedRecencyBoost(hits, NOW_MS);

    // accessed-recently should rank higher because last_accessed is recent
    expect(result[0].id).toBe('accessed-recently');
  });

  it('is deterministic: same inputs produce the same output order', () => {
    const hits = [makeHit('a', 0.9), makeHit('b', 0.8), makeHit('c', 0.85)];

    const result1 = applyGradedRecencyBoost(hits, NOW_MS);
    const result2 = applyGradedRecencyBoost(hits, NOW_MS);

    expect(result1.map((h) => h.id)).toEqual(result2.map((h) => h.id));
  });

  it('handles notes with no created date (defaults to multiplier 1.0, no boost)', () => {
    const hit = makeHit('no-date', 1.0);

    expect(() => applyGradedRecencyBoost([hit], NOW_MS)).not.toThrow();
    const result = applyGradedRecencyBoost([hit], NOW_MS);
    expect(result[0].score).toBe(1.0);
  });

  it('handles notes not found in index (defaults to multiplier 1.0, no boost)', () => {
    const hit: ResolvedHit = {
      id: 'unknown-id-xyz',
      path: 'notes/unknown.html',
      score: 0.7,
      level: 'L2',
    };
    expect(() => applyGradedRecencyBoost([hit], NOW_MS)).not.toThrow();
    const result = applyGradedRecencyBoost([hit], NOW_MS);
    expect(result[0].score).toBe(0.7);
  });

  it('does not mutate input hit objects (immutable pattern)', () => {
    const hit = makeHit('immutable', 0.5);
    const originalScore = hit.score;
    applyGradedRecencyBoost([hit], NOW_MS);
    expect(hit.score).toBe(originalScore);
  });

  it('returns a new array (does not return the same reference)', () => {
    const hits = [makeHit('one-day-old', 1.0)];
    const result = applyGradedRecencyBoost(hits, NOW_MS);
    expect(result).not.toBe(hits);
  });

  it('returns hits sorted by descending score after boost', () => {
    const hits = [
      makeHit('ancient', 0.5), // old, low base score -> still low after boost
      makeHit('one-day-old', 0.9), // new, high base score -> highest
      makeHit('a', 0.7), // mid-age, mid score
    ];
    const result = applyGradedRecencyBoost(hits, NOW_MS);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].score).toBeGreaterThanOrEqual(result[i + 1].score);
    }
  });
});
