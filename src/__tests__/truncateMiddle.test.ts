/**
 * truncateMiddle.test.ts — lib/truncateMiddle.ts (canvas zone-title design,
 * scratch/_canvas-label-design.md §3.1). The zone header's own truncator:
 * unlike an end-ellipsis, this must preserve the DISCRIMINATING SUFFIX real
 * project names carry (`-b`/`-c`/dates).
 */

import { describe, it, expect } from 'vitest';
import { truncateMiddle } from '../lib/truncateMiddle';

describe('truncateMiddle', () => {
  it('returns the string unchanged when it already fits', () => {
    expect(truncateMiddle('uc-smoke-b', 20)).toBe('uc-smoke-b');
    expect(truncateMiddle('uc-smoke-b', 10)).toBe('uc-smoke-b'); // exactly at the limit
  });

  it("matches the design doc's own worked example: uc-smoke-2026-08-12 at 11 -> uc-sm…08-12", () => {
    expect(truncateMiddle('uc-smoke-2026-08-12', 11)).toBe('uc-sm…08-12');
  });

  it('always contains exactly one ellipsis when truncation actually happens', () => {
    const result = truncateMiddle('a-very-long-project-name-indeed', 14);
    expect(result).toHaveLength(14);
    expect(result.split('…')).toHaveLength(2);
  });

  it('preserves the discriminating SUFFIX — uc-smoke-b / uc-smoke-c / uc-smoke-2026-08-12 stay mutually distinguishable', () => {
    const a = truncateMiddle('uc-smoke-b', 9);
    const b = truncateMiddle('uc-smoke-c', 9);
    const c = truncateMiddle('uc-smoke-2026-08-12', 9);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    // The whole point: a plain end-ellipsis would collapse a/b to the same
    // "uc-smoke…" prefix — this must not.
    expect(a.endsWith('b')).toBe(true);
    expect(b.endsWith('c')).toBe(true);
  });

  it('degrades safely at the edges (maxLen 0/1/negative) without throwing or producing a negative-length slice', () => {
    expect(truncateMiddle('hello', 0)).toBe('');
    expect(truncateMiddle('hello', 1)).toBe('…');
    expect(truncateMiddle('hello', -5)).toBe('');
  });

  it('never exceeds maxLen for a range of lengths', () => {
    const text = 'training-week-generator-a-very-long-repo-name';
    for (const maxLen of [1, 2, 5, 8, 11, 15, 20, 28]) {
      expect(truncateMiddle(text, maxLen).length).toBeLessThanOrEqual(maxLen);
    }
  });
});
