/**
 * viewportSanity.test.ts — W-UX3 finding B ("boot ultra-zoomé"): pure
 * boundary coverage for `isViewportSane` (see that module's own header for
 * the full rationale). useCanvasHydration.test.ts's own "boot viewport
 * sanity guard" describe block covers the hook-level wiring; this file is
 * the pure-function boundary matrix.
 */

import { describe, it, expect } from 'vitest';
import {
  isViewportSane,
  MIN_SANE_ZOOM,
  MAX_SANE_ZOOM,
  MIN_VISIBLE_CONTENT_FRACTION,
} from '../components/agents/canvas/hooks/viewportSanity';
import { FULL_CARD_MAX_HEIGHT, FULL_CARD_WIDTH } from '../components/agents/canvas/geometry';

const SCREEN = { width: 1280, height: 800 };

describe('isViewportSane — zoom-range check (David repro: persisted 188%)', () => {
  it('rejects a zoom above MAX_SANE_ZOOM (the exact 188% repro)', () => {
    expect(isViewportSane({ x: 0, y: 0, zoom: 1.88 }, undefined, SCREEN)).toBe(false);
  });

  it('rejects a zoom below MIN_SANE_ZOOM', () => {
    expect(isViewportSane({ x: 0, y: 0, zoom: 0.05 }, undefined, SCREEN)).toBe(false);
  });

  it('rejects a non-finite zoom (NaN/Infinity guard)', () => {
    expect(isViewportSane({ x: 0, y: 0, zoom: Number.NaN }, undefined, SCREEN)).toBe(false);
    expect(isViewportSane({ x: 0, y: 0, zoom: Number.POSITIVE_INFINITY }, undefined, SCREEN)).toBe(false);
  });

  it('accepts a zoom exactly at each sane boundary with no positions to check', () => {
    expect(isViewportSane({ x: 0, y: 0, zoom: MIN_SANE_ZOOM }, undefined, SCREEN)).toBe(true);
    expect(isViewportSane({ x: 0, y: 0, zoom: MAX_SANE_ZOOM }, undefined, SCREEN)).toBe(true);
  });

  it('accepts a normal zoom (100%) with no positions to check against', () => {
    expect(isViewportSane({ x: 0, y: 0, zoom: 1 }, undefined, SCREEN)).toBe(true);
    expect(isViewportSane({ x: 0, y: 0, zoom: 1 }, {}, SCREEN)).toBe(true);
  });
});

describe('isViewportSane — content-visibility check (in-range zoom, panned to empty space)', () => {
  const positions = { 'mission:m1': { x: 2000, y: 2000 } };

  it('rejects an in-range zoom whose viewport offset puts the only node far off-screen', () => {
    // zoom is fine (1x), but x/y never bring the node's flow position
    // (2000,2000) anywhere near the 1280x800 screen rect.
    expect(isViewportSane({ x: -50000, y: -50000, zoom: 1 }, positions, SCREEN)).toBe(false);
  });

  it('accepts an in-range zoom that centers the node on screen', () => {
    // Places the node's top-left comfortably inside the screen rect.
    const viewport = { x: -2000 + 100, y: -2000 + 100, zoom: 1 };
    expect(isViewportSane(viewport, positions, SCREEN)).toBe(true);
  });

  it('is sensitive right around the MIN_VISIBLE_CONTENT_FRACTION threshold', () => {
    // One node's footprint (card width/height) placed so only a sliver
    // is on-screen — well under the 30% threshold.
    const sliverViewport = { x: -2000 - (FULL_CARD_WIDTH * 0.9), y: -2000, zoom: 1 };
    expect(isViewportSane(sliverViewport, positions, SCREEN)).toBe(false);
  });

  it('skips the content check (accepts) when there are no positions at all', () => {
    expect(isViewportSane({ x: -50000, y: -50000, zoom: 1 }, {}, SCREEN)).toBe(true);
  });

  it('skips the content check (accepts) when the screen size is unknown (0x0)', () => {
    expect(isViewportSane({ x: -50000, y: -50000, zoom: 1 }, positions, { width: 0, height: 0 })).toBe(true);
  });

  it('never throws on non-finite position values — skips check 2 conservatively', () => {
    const badPositions = { 'mission:bad': { x: Number.NaN, y: Number.NaN } };
    expect(() => isViewportSane({ x: 0, y: 0, zoom: 1 }, badPositions, SCREEN)).not.toThrow();
    expect(isViewportSane({ x: 0, y: 0, zoom: 1 }, badPositions, SCREEN)).toBe(true);
  });

  it('a full-fleet bounding box that mostly overlaps the screen is accepted', () => {
    const fleetPositions = {
      'mission:a': { x: 0, y: 0 },
      'mission:b': { x: 300, y: 0 },
      'mission:c': { x: 0, y: 300 },
    };
    // 100% zoom, viewport untranslated — content spans roughly
    // [0, 300+FULL_CARD_WIDTH] x [0, 300+FULL_CARD_MAX_HEIGHT], comfortably
    // inside the 1280x800 screen.
    expect(300 + FULL_CARD_WIDTH).toBeLessThan(SCREEN.width);
    expect(300 + FULL_CARD_MAX_HEIGHT).toBeLessThan(SCREEN.height);
    expect(isViewportSane({ x: 0, y: 0, zoom: 1 }, fleetPositions, SCREEN)).toBe(true);
  });
});

// Sanity-check the exported constant matches the brief's own wording
// ("<30% of content visible") so a future edit to the threshold is caught
// here rather than silently drifting.
describe('isViewportSane — exported thresholds', () => {
  it('MIN_VISIBLE_CONTENT_FRACTION is 0.3 (30%, per the brief)', () => {
    expect(MIN_VISIBLE_CONTENT_FRACTION).toBe(0.3);
  });
  it('sane zoom range is [0.15, 1.5], per the brief', () => {
    expect(MIN_SANE_ZOOM).toBe(0.15);
    expect(MAX_SANE_ZOOM).toBe(1.5);
  });
});
