/**
 * smartEdgePath.test.ts — W8a deliverable #4: pure geometry tests for the
 * avoid-nodes chain-edge router (edges/smartEdgePath.ts). No React, no
 * React Flow — plain points/rects in, SVG path + label anchor out.
 */

import { describe, it, expect } from 'vitest';
import {
  computeSmartEdgePath,
  roundedOrthogonalPath,
  segmentIntersectsRect,
  type Point,
  type Rect,
} from '../components/agents/canvas/edges/smartEdgePath';

const SOURCE: Point = { x: 0, y: 100 };
const TARGET: Point = { x: 600, y: 100 };
/** A zone squarely on the straight line between SOURCE and TARGET. */
const BLOCKING_ZONE: Rect = { x: 200, y: 40, width: 200, height: 120 };
/** A zone far away from the segment. */
const FAR_ZONE: Rect = { x: 200, y: 600, width: 200, height: 120 };

describe('segmentIntersectsRect', () => {
  it('detects a straight crossing', () => {
    expect(segmentIntersectsRect(SOURCE, TARGET, BLOCKING_ZONE)).toBe(true);
  });

  it('rejects a segment that misses the rect', () => {
    expect(segmentIntersectsRect(SOURCE, TARGET, FAR_ZONE)).toBe(false);
  });

  it('detects a diagonal crossing and an endpoint inside the rect', () => {
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 500, y: 300 }, BLOCKING_ZONE)).toBe(true);
    expect(segmentIntersectsRect({ x: 250, y: 100 }, { x: 900, y: 100 }, BLOCKING_ZONE)).toBe(true);
  });
});

describe('computeSmartEdgePath', () => {
  it('returns null when nothing blocks the straight line (caller keeps its bezier)', () => {
    expect(computeSmartEdgePath(SOURCE, TARGET, [FAR_ZONE])).toBeNull();
    expect(computeSmartEdgePath(SOURCE, TARGET, [])).toBeNull();
  });

  it('routes around a blocking zone: every path segment clears the obstacle', () => {
    const result = computeSmartEdgePath(SOURCE, TARGET, [BLOCKING_ZONE]);
    expect(result).not.toBeNull();
    // The detour shelf must sit fully outside the obstacle's vertical span.
    const yMatches = [...result!.path.matchAll(/[LM] ([\d.-]+),([\d.-]+)/g)].map((m) => Number(m[2]));
    const shelfY = Math.min(...yMatches);
    // Source/target sit at y=100 inside [40,160]: the cheaper shelf is ABOVE.
    expect(shelfY).toBeLessThan(BLOCKING_ZONE.y);
  });

  it('picks the below detour when source/target are nearer the bottom edge', () => {
    const source: Point = { x: 0, y: 155 };
    const target: Point = { x: 600, y: 155 };
    const result = computeSmartEdgePath(source, target, [BLOCKING_ZONE]);
    expect(result).not.toBeNull();
    const yMatches = [...result!.path.matchAll(/[LM] ([\d.-]+),([\d.-]+)/g)].map((m) => Number(m[2]));
    const shelfY = Math.max(...yMatches);
    expect(shelfY).toBeGreaterThan(BLOCKING_ZONE.y + BLOCKING_ZONE.height);
  });

  it('spans multiple blocking zones with a single shelf clearing them all', () => {
    const secondZone: Rect = { x: 430, y: 80, width: 100, height: 60 };
    const result = computeSmartEdgePath(SOURCE, TARGET, [BLOCKING_ZONE, secondZone]);
    expect(result).not.toBeNull();
    const yMatches = [...result!.path.matchAll(/[LM] ([\d.-]+),([\d.-]+)/g)].map((m) => Number(m[2]));
    const shelfY = Math.min(...yMatches);
    expect(shelfY).toBeLessThan(Math.min(BLOCKING_ZONE.y, secondZone.y));
  });

  it('anchors the label on the longest segment (the shelf), not the bezier midpoint', () => {
    const result = computeSmartEdgePath(SOURCE, TARGET, [BLOCKING_ZONE])!;
    // Longest segment is the horizontal shelf between the two stems — its
    // midpoint x is centered between them, and its y is the shelf y.
    expect(result.labelX).toBeGreaterThan(SOURCE.x);
    expect(result.labelX).toBeLessThan(TARGET.x);
    expect(result.labelY).toBeLessThan(BLOCKING_ZONE.y);
  });

  it('produces a valid SVG path (starts with M, rounded corners as Q curves)', () => {
    const result = computeSmartEdgePath(SOURCE, TARGET, [BLOCKING_ZONE])!;
    expect(result.path.startsWith('M ')).toBe(true);
    expect(result.path).toContain('Q ');
  });
});

describe('roundedOrthogonalPath', () => {
  it('degrades to a straight line for two points and skips rounding on tiny segments', () => {
    expect(roundedOrthogonalPath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M 0,0 L 10,0');
    // A 1px-long middle segment cannot fit a radius — falls back to L.
    const path = roundedOrthogonalPath([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(path).toContain('L');
  });
});
