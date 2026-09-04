/* Brain Canvas — cluster label legibility (canvas/draw.ts's placeClusterLabels
   + rectsOverlap). Covers the fix for three observed bugs in the packaged
   app: an unbounded-length label sprawling across the canvas, captions
   painted under/inside the dense node cloud, and captions overlapping each
   other. Both functions under test are pure (no CanvasRenderingContext2D),
   so this exercises the real collision-rejection logic directly, with no
   rendering involved. */

import { describe, it, expect } from 'vitest';
import {
  placeClusterLabels,
  rectsOverlap,
  type ClusterLabelCandidate,
  type LabelRect,
} from '../components/brain/canvas/draw';

describe('canvas/draw — rectsOverlap', () => {
  it('detects overlapping rects', () => {
    const a: LabelRect = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const b: LabelRect = { x0: 5, y0: 5, x1: 15, y1: 15 };
    expect(rectsOverlap(a, b, 0)).toBe(true);
  });

  it('does not flag disjoint rects as overlapping', () => {
    const a: LabelRect = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const b: LabelRect = { x0: 20, y0: 20, x1: 30, y1: 30 };
    expect(rectsOverlap(a, b, 0)).toBe(false);
  });

  it('treats rects within `pad` of each other as overlapping (separation, not just non-touching)', () => {
    const a: LabelRect = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const b: LabelRect = { x0: 13, y0: 0, x1: 20, y1: 10 }; // 3px gap
    expect(rectsOverlap(a, b, 0)).toBe(false);
    expect(rectsOverlap(a, b, 6)).toBe(true); // pad closes the 3px gap
  });
});

describe('canvas/draw — placeClusterLabels', () => {
  function candidate(overrides: Partial<ClusterLabelCandidate>): ClusterLabelCandidate {
    return { clusterId: 'x', count: 1, sx: 0, baseLy: 0, totalWidth: 60, ...overrides };
  }

  it('places every candidate when none collide', () => {
    const candidates = [
      candidate({ clusterId: 'engine', count: 500, sx: 0 }),
      candidate({ clusterId: 'brain', count: 300, sx: 400 }),
      candidate({ clusterId: 'unknown', count: 100, sx: 800 }),
    ];
    const placements = placeClusterLabels(candidates);
    expect(placements.map((p) => p.clusterId).sort()).toEqual(['brain', 'engine', 'unknown']);
  });

  it('gives the larger cluster (by count) the undisturbed spot and bumps or drops the smaller one when two collide at the same centroid', () => {
    const big = candidate({ clusterId: 'lib', count: 543, sx: 100, baseLy: 200, totalWidth: 80 });
    const small = candidate({ clusterId: 'code', count: 1, sx: 100, baseLy: 200, totalWidth: 80 });
    // Order in the input array must not matter — sorting is internal to placeClusterLabels.
    const placements = placeClusterLabels([small, big]);

    const bigPlacement = placements.find((p) => p.clusterId === 'lib');
    // The big cluster always wins its undisturbed (dy=0) preferred anchor.
    expect(bigPlacement).toBeDefined();
    expect(bigPlacement?.ly).toBe(200);

    // No two placed rects may actually overlap on screen.
    const rects: LabelRect[] = placements.map((p) => ({
      x0: p.bx,
      y0: p.ly - 9,
      x1: p.bx + 80,
      y1: p.ly + 8,
    }));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(rectsOverlap(rects[i], rects[j], 6)).toBe(false);
      }
    }
  });

  it('skips a caption entirely (rather than stacking it) once every nudge offset is exhausted', () => {
    // Five same-size, same-centroid clusters: only some of the 4 nudge
    // offsets can possibly be collision-free for all of them at once, so at
    // least one must be dropped — never silently overlapped.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate({ clusterId: `cluster-${i}`, count: 5 - i, sx: 100, baseLy: 200, totalWidth: 200 }),
    );
    const placements = placeClusterLabels(candidates);
    expect(placements.length).toBeLessThan(candidates.length);

    const rects: LabelRect[] = placements.map((p) => ({
      x0: p.bx,
      y0: p.ly - 9,
      x1: p.bx + 200,
      y1: p.ly + 8,
    }));
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(rectsOverlap(rects[i], rects[j], 6)).toBe(false);
      }
    }
  });

  it('is deterministic for equal counts (tie-broken by clusterId, not input order)', () => {
    const a = candidate({ clusterId: 'zzz', count: 10, sx: 0, baseLy: 0 });
    const b = candidate({ clusterId: 'aaa', count: 10, sx: 0, baseLy: 0 });
    const result1 = placeClusterLabels([a, b]);
    const result2 = placeClusterLabels([b, a]);
    expect(result1.map((p) => p.clusterId)).toEqual(result2.map((p) => p.clusterId));
  });

  it('returns an empty array for no candidates', () => {
    expect(placeClusterLabels([])).toEqual([]);
  });
});
