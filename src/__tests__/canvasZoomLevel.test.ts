/**
 * canvasZoomLevel.test.ts — pure threshold test for chrome/useZoomLevel.ts's
 * `bucketZoom` (W2b, spec §4.5 semantic zoom, shared by every node kind).
 */

import { describe, it, expect } from 'vitest';
import { bucketZoom, bucketHeaderZoom } from '../components/agents/canvas/chrome/useZoomLevel';
import { ZOOM_AGGREGATE, ZOOM_CHIP, ZOOM_COMPACT } from '../components/agents/canvas/canvasTypes';
import { HEADER_CLAMP_ZOOM, HEADER_MINIMAL_ZOOM } from '../components/agents/canvas/chrome/lod';

describe('locked threshold decisions (fix/canvas-legibility)', () => {
  it('ZOOM_CHIP is 0.55, ZOOM_COMPACT is unchanged at 0.85', () => {
    expect(ZOOM_CHIP).toBe(0.55);
    expect(ZOOM_COMPACT).toBe(0.85);
  });

  // W-CARDS: no semantic zoom (founder standing decision) — the aggregate
  // tier's own zoom-adaptive hiding/replacement of content (zone summary
  // chip swap, CSS-driven note/router/schedule/terminal/preview/frame/edge
  // hiding) is retired by forcing this threshold to 0 rather than deleting
  // the now-permanently-dormant machinery around it — see canvasTypes.ts's
  // own doc comment on ZOOM_AGGREGATE for the full "why". A live zoom is
  // never negative, so `zoom < ZOOM_AGGREGATE` is now permanently false.
  it('ZOOM_AGGREGATE is forced to 0 — the aggregate tier never engages', () => {
    expect(ZOOM_AGGREGATE).toBe(0);
  });
});

describe('bucketZoom', () => {
  it('below ZOOM_CHIP -> chip', () => {
    expect(bucketZoom(0)).toBe('chip');
    expect(bucketZoom(ZOOM_CHIP - 0.01)).toBe('chip');
  });

  it('[ZOOM_CHIP, ZOOM_COMPACT) -> compact', () => {
    expect(bucketZoom(ZOOM_CHIP)).toBe('compact');
    expect(bucketZoom(ZOOM_COMPACT - 0.01)).toBe('compact');
  });

  it('>= ZOOM_COMPACT -> full', () => {
    expect(bucketZoom(ZOOM_COMPACT)).toBe('full');
    expect(bucketZoom(2)).toBe('full');
  });
});

// fix/canvas-header-overflow — project/frame HEADER semantic zoom (a
// separate bucket from bucketZoom above: see useHeaderZoomTier's own doc
// comment for why a zone/frame header needs its own threshold pair).
describe('locked threshold decisions (fix/canvas-header-overflow)', () => {
  it('HEADER_MINIMAL_ZOOM is 0.2, HEADER_CLAMP_ZOOM is 0.35', () => {
    expect(HEADER_MINIMAL_ZOOM).toBe(0.2);
    expect(HEADER_CLAMP_ZOOM).toBe(0.35);
    expect(HEADER_MINIMAL_ZOOM).toBeLessThan(HEADER_CLAMP_ZOOM);
  });
});

describe('bucketHeaderZoom', () => {
  it('below HEADER_MINIMAL_ZOOM -> minimal', () => {
    expect(bucketHeaderZoom(0)).toBe('minimal');
    expect(bucketHeaderZoom(HEADER_MINIMAL_ZOOM - 0.01)).toBe('minimal');
  });

  it('[HEADER_MINIMAL_ZOOM, HEADER_CLAMP_ZOOM) -> reduced', () => {
    expect(bucketHeaderZoom(HEADER_MINIMAL_ZOOM)).toBe('reduced');
    expect(bucketHeaderZoom(HEADER_CLAMP_ZOOM - 0.01)).toBe('reduced');
  });

  it('>= HEADER_CLAMP_ZOOM -> full', () => {
    expect(bucketHeaderZoom(HEADER_CLAMP_ZOOM)).toBe('full');
    expect(bucketHeaderZoom(2)).toBe('full');
  });
});
