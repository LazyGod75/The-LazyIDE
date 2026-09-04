/**
 * Tests for dream note id uniqueness and idempotency.
 *
 * Regression: two different conversations with identical date+title collided
 * on the same note id because sessionId.slice(0,8) = "dream-XX" (only 2 true
 * hex chars of entropy). Fix: extractSessionHash() strips the prefix and
 * returns 8 genuine hex chars, appended AFTER the title so the slug never
 * truncates the entropy suffix.
 */

import { describe, expect, it, vi } from 'vitest';
import { annotateSession, extractSessionHash } from '../heuristic.js';

// ---------------------------------------------------------------------------
// Mocks for modules that require filesystem / DB access
// ---------------------------------------------------------------------------

vi.mock('../../indexer/fts.js', () => ({
  listAll: () => [],
  topConcepts: () => [],
}));

vi.mock('../entities.js', () => ({
  discoverAndAnnotateEntities: () => ({ keys: [], html: '' }),
}));

// ---------------------------------------------------------------------------
// extractSessionHash unit tests
// ---------------------------------------------------------------------------

describe('extractSessionHash', () => {
  it('strips "dream-" prefix and returns the 8 hex chars that follow', () => {
    expect(extractSessionHash('dream-ab12cd34')).toBe('ab12cd34');
  });

  it('handles a longer hash suffix correctly (takes first 8)', () => {
    expect(extractSessionHash('dream-a1b2c3d4e5f6g7h8')).toBe('a1b2c3d4');
  });

  it('handles "capture-" or other word prefixes generically', () => {
    const h = extractSessionHash('capture-deadbeef');
    expect(h).toBe('deadbeef');
    expect(h).toHaveLength(8);
  });

  it('falls back to SHA-256 for arbitrary / unprefixed sessionIds', () => {
    const h = extractSessionHash('some-arbitrary-session-id');
    // Must be 8 lowercase hex chars
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable: same input always produces same output', () => {
    const id = 'dream-f0e1d2c3';
    expect(extractSessionHash(id)).toBe(extractSessionHash(id));
  });

  it('two different sessionIds produce different hashes', () => {
    const h1 = extractSessionHash('dream-aaaabbbb');
    const h2 = extractSessionHash('dream-ccccdddd');
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// annotateSession note-id collision tests (the real regression)
// ---------------------------------------------------------------------------

const FIXED_DATE = '2026-05-28T10:00:00.000Z';
const COMMON_TITLE_TEXT = 'MODE SWITCH: PROGRESS SUMMARY — switching from implementation to review';

describe('annotateSession note id uniqueness', () => {
  it('two conversations with identical date+title produce DIFFERENT note ids', () => {
    const base = {
      text: COMMON_TITLE_TEXT,
      timestamp: FIXED_DATE,
    };

    const result1 = annotateSession({
      ...base,
      sessionId: 'dream-aaaaaaaa', // conversation A
    });

    const result2 = annotateSession({
      ...base,
      sessionId: 'dream-bbbbbbbb', // conversation B (different file)
    });

    expect(result1.id).not.toBe(result2.id);
    expect(result1.id.length).toBeGreaterThan(0);
    expect(result2.id.length).toBeGreaterThan(0);
  });

  it('same conversation processed twice yields the same note id (idempotent)', () => {
    const input = {
      sessionId: 'dream-c0ffee12',
      text: COMMON_TITLE_TEXT,
      timestamp: FIXED_DATE,
    };

    const result1 = annotateSession(input);
    const result2 = annotateSession(input);

    expect(result1.id).toBe(result2.id);
  });

  it('note id always contains the 8-char session hash to prevent title-only collision', () => {
    const hash = 'deadbeef';
    const result = annotateSession({
      sessionId: `dream-${hash}`,
      text: COMMON_TITLE_TEXT,
      timestamp: FIXED_DATE,
    });

    // The slug must embed the hash (possibly lowercased/hyphenated by slug())
    expect(result.id).toContain(hash);
  });

  it('note id stays within the 80-char slug limit', () => {
    const longTitle = `${'A'.repeat(200)} some very long conversation title that goes on and on`;
    const result = annotateSession({
      sessionId: 'dream-12345678',
      text: longTitle,
      timestamp: FIXED_DATE,
    });
    expect(result.id.length).toBeLessThanOrEqual(80);
  });

  it('100 distinct sessionIds produce 100 distinct note ids (no collisions)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const hex = i.toString(16).padStart(8, '0');
      const result = annotateSession({
        sessionId: `dream-${hex}`,
        text: COMMON_TITLE_TEXT,
        timestamp: FIXED_DATE,
      });
      ids.add(result.id);
    }
    expect(ids.size).toBe(100);
  });
});
