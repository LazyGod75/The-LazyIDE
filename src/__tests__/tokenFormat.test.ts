/**
 * Tests for tokenFormat.ts's formatTokenCountShort — B4 dedup target.
 * Values pinned here match exactly what the three former duplicate
 * implementations (BrainBanner.tsx, cockpit/KpiGroup.tsx,
 * lib/agents/brainCitations.ts) currently produce, before/after the dedup —
 * non-regression coverage for the values those three call sites display.
 */

import { describe, it, expect } from 'vitest';
import { formatTokenCountShort } from '../lib/agents/tokenFormat';

describe('formatTokenCountShort', () => {
  it('returns the plain integer string below 1000', () => {
    expect(formatTokenCountShort(0)).toBe('0');
    expect(formatTokenCountShort(500)).toBe('500');
    expect(formatTokenCountShort(999)).toBe('999');
  });

  it('formats thousands with one decimal and a "k" suffix', () => {
    expect(formatTokenCountShort(1_000)).toBe('1.0k');
    expect(formatTokenCountShort(1_500)).toBe('1.5k');
    expect(formatTokenCountShort(1_800)).toBe('1.8k'); // brainCitations.test.ts pin
    expect(formatTokenCountShort(999_999)).toBe('1000.0k');
  });

  it('formats millions with one decimal and an "M" suffix', () => {
    expect(formatTokenCountShort(1_000_000)).toBe('1.0M');
    expect(formatTokenCountShort(2_400_000)).toBe('2.4M'); // brainCitations.test.ts pin
    expect(formatTokenCountShort(12_340_000)).toBe('12.3M');
  });

  it('rounds a fractional sub-1000 input (matches former brainCitations.ts behaviour)', () => {
    expect(formatTokenCountShort(4.7)).toBe('5');
  });
});
