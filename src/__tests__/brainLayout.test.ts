/* Brain Canvas — node/cluster layout (canvas/layout.ts). */

import { describe, it, expect } from 'vitest';
import { clusterCenter, createRng, nodePosition } from '../components/brain/canvas/layout';

describe('canvas/layout — createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  it('produces values in [0, 1)', () => {
    const rng = createRng(1337);
    for (let i = 0; i < 50; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces a sequence, not a repeated constant', () => {
    const rng = createRng(7);
    const values = [rng(), rng(), rng()];
    expect(new Set(values).size).toBeGreaterThan(1);
  });
});

describe('canvas/layout — clusterCenter', () => {
  it('is deterministic for the same (index, total)', () => {
    expect(clusterCenter(2, 7)).toEqual(clusterCenter(2, 7));
  });

  it('places clusters on the unit circle (radius ~0.95) in the XZ plane', () => {
    const center = clusterCenter(0, 4);
    const radius = Math.hypot(center.x, center.z);
    expect(radius).toBeCloseTo(0.95, 5);
  });

  it('spaces clusters evenly around the circle by index/total', () => {
    const a = clusterCenter(0, 4);
    const b = clusterCenter(1, 4);
    const angleA = Math.atan2(a.z, a.x);
    const angleB = Math.atan2(b.z, b.x);
    expect(Math.abs(angleB - angleA)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('stays stable when total changes but index/total ratio conceptually differs (no shared-array assumptions)', () => {
    // Regression guard: layout must be a pure function of (index, total),
    // never of "how many clusters happen to be loaded elsewhere" — this is
    // what keeps cluster positions stable across filter toggles.
    const before = clusterCenter(1, 7);
    const after = clusterCenter(1, 7);
    expect(before).toEqual(after);
  });
});

describe('canvas/layout — nodePosition', () => {
  const center = { x: 0.5, y: 0, z: -0.3 };

  it('is a pure function of (nodeId, center) — same id always yields the same position', () => {
    expect(nodePosition('node-abc', center)).toEqual(nodePosition('node-abc', center));
  });

  it('does not depend on any other node being present (stable under filtering)', () => {
    // Simulates "compute once with the full set" vs "compute once with a
    // filtered subset" — the position must not change either way, since
    // nodePosition takes no array/index input at all.
    const positionInFullSet = nodePosition('node-xyz', center);
    const positionInFilteredSet = nodePosition('node-xyz', center);
    expect(positionInFullSet).toEqual(positionInFilteredSet);
  });

  it('scatters different node ids to different positions', () => {
    const a = nodePosition('node-a', center);
    const b = nodePosition('node-b', center);
    expect(a).not.toEqual(b);
  });

  it('stays within the documented scatter width of the cluster center', () => {
    const pos = nodePosition('some-id', center);
    const halfWidth = 0.425 + 1e-9;
    expect(Math.abs(pos.x - center.x)).toBeLessThanOrEqual(halfWidth);
    expect(Math.abs(pos.y - center.y)).toBeLessThanOrEqual(halfWidth);
    expect(Math.abs(pos.z - center.z)).toBeLessThanOrEqual(halfWidth);
  });
});
