/**
 * panelWidthTier.ts — pins the three named layout tiers the LazyManager
 * panel's header/tab strip render against (real defect, 2026-08-14: at the
 * panel's real ~500px docked width, Row 1 fell back to an accidental
 * `flexWrap` reflow instead of a deliberate layout — see that file's own
 * module doc comment for the full repro).
 */
import { describe, it, expect } from 'vitest';
import { getPanelWidthTier, WIDE_MIN_WIDTH, COMPACT_MIN_WIDTH } from '../components/lazyManager/panelWidthTier';

describe('getPanelWidthTier', () => {
  it('undefined (not yet measured) resolves to "wide" — never a flash of a narrower tier before the first real measurement', () => {
    expect(getPanelWidthTier(undefined)).toBe('wide');
  });

  it('the real observed defect width (~500px docked panel) lands in "compact", not "wide"', () => {
    expect(getPanelWidthTier(500)).toBe('compact');
  });

  it('at and above WIDE_MIN_WIDTH is "wide"', () => {
    expect(getPanelWidthTier(WIDE_MIN_WIDTH)).toBe('wide');
    expect(getPanelWidthTier(WIDE_MIN_WIDTH + 200)).toBe('wide');
  });

  it('just below WIDE_MIN_WIDTH, down to COMPACT_MIN_WIDTH, is "compact"', () => {
    expect(getPanelWidthTier(WIDE_MIN_WIDTH - 1)).toBe('compact');
    expect(getPanelWidthTier(COMPACT_MIN_WIDTH)).toBe('compact');
  });

  it('below COMPACT_MIN_WIDTH is "narrow"', () => {
    expect(getPanelWidthTier(COMPACT_MIN_WIDTH - 1)).toBe('narrow');
    expect(getPanelWidthTier(200)).toBe('narrow');
    expect(getPanelWidthTier(0)).toBe('narrow');
  });

  it('tier boundaries never overlap or leave a gap across the full real width range', () => {
    for (let w = 0; w <= 1000; w += 1) {
      const tier = getPanelWidthTier(w);
      expect(['wide', 'compact', 'narrow']).toContain(tier);
    }
  });
});
