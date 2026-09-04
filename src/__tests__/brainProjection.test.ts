/* Brain Canvas — 3D->2D projection math and hit-testing (canvas/projection.ts). */

import { describe, it, expect } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ambientStride,
  buildCameraParams,
  clampZoom,
  hitTest,
  project,
  projectInto,
} from '../components/brain/canvas/projection';
import type { ProjectedPoint } from '../components/brain/canvas/projection';

describe('canvas/projection — clampZoom', () => {
  it('clamps below the minimum', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
  });

  it('clamps above the maximum', () => {
    expect(clampZoom(100)).toBe(ZOOM_MAX);
  });

  it('passes through values already in range', () => {
    expect(clampZoom(1)).toBe(1);
  });
});

describe('canvas/projection — buildCameraParams', () => {
  it('derives center from width/height using the handoff offsets (w/2-18, h/2+14)', () => {
    const cam = buildCameraParams({ width: 200, height: 100, rotY: 0, userRX: 0, zoom: 1, is3D: true });
    expect(cam.centerX).toBe(200 / 2 - 18);
    expect(cam.centerY).toBe(100 / 2 + 14);
  });

  it('forces zero tilt in 2D mode regardless of userRX', () => {
    const cam2D = buildCameraParams({ width: 200, height: 100, rotY: 0, userRX: 0.9, zoom: 1, is3D: false });
    expect(cam2D.cosX).toBe(1);
    expect(cam2D.sinX).toBe(0);
  });

  it('applies the base tilt + drag offset in 3D mode', () => {
    const cam3D = buildCameraParams({ width: 200, height: 100, rotY: 0, userRX: 0, zoom: 1, is3D: true });
    expect(cam3D.cosX).toBeCloseTo(Math.cos(0.34), 10);
    expect(cam3D.sinX).toBeCloseTo(Math.sin(0.34), 10);
  });

  it('scales with zoom and clamps out-of-range zoom internally', () => {
    const base = buildCameraParams({ width: 200, height: 200, rotY: 0, userRX: 0, zoom: 1, is3D: true });
    const zoomedOut = buildCameraParams({ width: 200, height: 200, rotY: 0, userRX: 0, zoom: 0.01, is3D: true });
    expect(zoomedOut.scale).toBeCloseTo(base.scale * (ZOOM_MIN / 1), 10);
  });
});

describe('canvas/projection — projectInto / project', () => {
  it('projects the origin to the camera center regardless of rotation', () => {
    const cam = buildCameraParams({ width: 200, height: 100, rotY: 1.23, userRX: 0.2, zoom: 1, is3D: true });
    const p = project({ x: 0, y: 0, z: 0 }, cam);
    expect(p.sx).toBeCloseTo(cam.centerX, 10);
    expect(p.sy).toBeCloseTo(cam.centerY, 10);
    expect(p.persp).toBeCloseTo(1, 10); // fov/(fov+0) === 1
  });

  it('matches a hand-derived value for a simple 2D-mode case', () => {
    const cam = buildCameraParams({ width: 200, height: 100, rotY: 0, userRX: 0, zoom: 1, is3D: false });
    const p = project({ x: 1, y: 0, z: 999 /* ignored in 2D mode */ }, cam);
    // is3D=false => fl=0, persp=1, scale = min(200,100)*0.265 = 26.5
    expect(p.sx).toBeCloseTo(cam.centerX + 1 * 26.5, 10);
    expect(p.sy).toBeCloseTo(cam.centerY, 10);
    expect(p.z).toBe(0);
  });

  it('ignoring z in 2D mode means two points differing only in z project identically', () => {
    const cam = buildCameraParams({ width: 300, height: 300, rotY: 0.7, userRX: 0, zoom: 1.5, is3D: false });
    const near = project({ x: 0.3, y: -0.2, z: -5 }, cam);
    const far = project({ x: 0.3, y: -0.2, z: 5 }, cam);
    expect(near).toEqual(far);
  });

  it('produces a fade in [0, 1]', () => {
    const cam = buildCameraParams({ width: 300, height: 300, rotY: 0, userRX: 0, zoom: 1, is3D: true });
    for (const z of [-3, -1, 0, 1, 5, 20]) {
      const p = project({ x: 0.1, y: 0.1, z }, cam);
      expect(p.fade).toBeGreaterThanOrEqual(0);
      expect(p.fade).toBeLessThanOrEqual(1);
    }
  });

  it('projectInto writes into the provided output object without allocating a new one', () => {
    const cam = buildCameraParams({ width: 200, height: 200, rotY: 0, userRX: 0, zoom: 1, is3D: true });
    const out: ProjectedPoint = { sx: -1, sy: -1, z: -1, persp: -1, fade: -1 };
    projectInto({ x: 0.2, y: 0.1, z: -0.4 }, cam, out);
    expect(out.sx).not.toBe(-1);
    expect(out.persp).not.toBe(-1);
  });

  it('is safe to call with the output object also used as the input point (in-place hot path pattern)', () => {
    const cam = buildCameraParams({ width: 200, height: 200, rotY: 0.4, userRX: 0.1, zoom: 1, is3D: true });
    const point = { x: 0.3, y: -0.1, z: 0.2 };
    const viaSeparateOut = project(point, cam);

    const inPlace: ProjectedPoint & { x: number; y: number; z: number } = { ...point, sx: 0, sy: 0, persp: 0, fade: 0 };
    projectInto(inPlace, cam, inPlace);

    expect(inPlace.sx).toBeCloseTo(viaSeparateOut.sx, 10);
    expect(inPlace.sy).toBeCloseTo(viaSeparateOut.sy, 10);
    expect(inPlace.persp).toBeCloseTo(viaSeparateOut.persp, 10);
  });
});

describe('canvas/projection — ambientStride (LOD)', () => {
  it('thins the ambient field to every other point once zoomed out past the threshold', () => {
    expect(ambientStride(0.5)).toBe(2);
    expect(ambientStride(0.74)).toBe(2);
  });

  it('draws every point at or above the threshold zoom', () => {
    expect(ambientStride(0.75)).toBe(1);
    expect(ambientStride(2)).toBe(1);
  });
});

describe('canvas/projection — hitTest', () => {
  const candidates = [
    { id: 'a', sx: 100, sy: 100, r: 5, visible: true },
    { id: 'b', sx: 104, sy: 100, r: 5, visible: true }, // close to `a`, but farther from the click point below
    { id: 'c', sx: 300, sy: 300, r: 5, visible: true },
    { id: 'hidden', sx: 100, sy: 100, r: 5, visible: false },
  ];

  it('returns the nearest visible candidate within range', () => {
    expect(hitTest(candidates, 101, 101)).toBe('a');
  });

  it('ignores non-visible candidates even when closest', () => {
    const onlyHidden = [{ id: 'hidden', sx: 50, sy: 50, r: 20, visible: false }];
    expect(hitTest(onlyHidden, 50, 50)).toBeNull();
  });

  it('returns null when nothing is within range', () => {
    expect(hitTest(candidates, 900, 900)).toBeNull();
  });

  it('respects each candidate radius + margin, not just the fixed search distance', () => {
    const tiny = [{ id: 'tiny', sx: 0, sy: 0, r: 1, visible: true }];
    // 14px away: within the fixed 16px search radius, but beyond r(1)+margin(9)=10.
    expect(hitTest(tiny, 14, 0)).toBeNull();
    expect(hitTest(tiny, 9, 0)).toBe('tiny');
  });
});
