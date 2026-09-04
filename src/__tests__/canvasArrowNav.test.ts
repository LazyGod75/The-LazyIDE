/**
 * Tests for canvasArrowNav.ts (W-CLOSE row 1 — n8n parity, keyboard-first
 * spatial navigation). Pure geometry: plain rects in, an id or null out.
 */

import { describe, it, expect } from 'vitest';
import { findNearestNodeInDirection, type NavBounds } from '../components/agents/canvas/canvasArrowNav';

function box(x: number, y: number, width = 100, height = 60): NavBounds {
  return { x, y, width, height };
}

describe('findNearestNodeInDirection', () => {
  const current = box(200, 200);

  it('finds the nearest candidate directly to the right', () => {
    const candidates = [
      { id: 'far-right', bounds: box(800, 200) },
      { id: 'near-right', bounds: box(400, 200) },
      { id: 'left', bounds: box(0, 200) },
    ];
    expect(findNearestNodeInDirection(current, candidates, 'right')).toBe('near-right');
  });

  it('finds the nearest candidate directly below', () => {
    const candidates = [
      { id: 'above', bounds: box(200, 0) },
      { id: 'far-below', bounds: box(200, 900) },
      { id: 'near-below', bounds: box(200, 400) },
    ];
    expect(findNearestNodeInDirection(current, candidates, 'down')).toBe('near-below');
  });

  it('excludes candidates on the wrong side of the primary axis', () => {
    const candidates = [{ id: 'to-the-left', bounds: box(-500, 200) }];
    expect(findNearestNodeInDirection(current, candidates, 'right')).toBeNull();
  });

  it('excludes a candidate exactly level (zero delta) on the primary axis', () => {
    const candidates = [{ id: 'same-x', bounds: box(200, 200) }];
    expect(findNearestNodeInDirection(current, candidates, 'right')).toBeNull();
  });

  it('penalizes off-axis offset — a closer-but-off-axis candidate can lose to a farther aligned one', () => {
    // "aligned" is directly right, same y; "offset" is much closer in raw
    // primary-axis distance but far off the secondary axis.
    const aligned = { id: 'aligned', bounds: box(500, 200) };
    const offset = { id: 'offset', bounds: box(250, 900) };
    expect(findNearestNodeInDirection(current, [offset, aligned], 'right')).toBe('aligned');
  });

  it('returns null for an empty candidate list', () => {
    expect(findNearestNodeInDirection(current, [], 'up')).toBeNull();
  });

  it('is deterministic on an exact score tie (first candidate in input order wins)', () => {
    const a = { id: 'a', bounds: box(400, 200) };
    const b = { id: 'b', bounds: box(400, 200) };
    expect(findNearestNodeInDirection(current, [a, b], 'right')).toBe('a');
  });

  it('supports all four cardinal directions from the same origin', () => {
    const candidates = [
      { id: 'up', bounds: box(200, 0) },
      { id: 'down', bounds: box(200, 500) },
      { id: 'left', bounds: box(0, 200) },
      { id: 'right', bounds: box(500, 200) },
    ];
    expect(findNearestNodeInDirection(current, candidates, 'up')).toBe('up');
    expect(findNearestNodeInDirection(current, candidates, 'down')).toBe('down');
    expect(findNearestNodeInDirection(current, candidates, 'left')).toBe('left');
    expect(findNearestNodeInDirection(current, candidates, 'right')).toBe('right');
  });
});
