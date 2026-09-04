/* projection.ts — 3D -> 2D projection math + hit-testing for the Brain
   Canvas. Ported near-verbatim from the design handoff prototype's
   `project` closure inside `loop()` (see design_handoff_brain_redesign/
   Lazy IDE.dc.html, class Component).

   `projectInto` writes into a caller-supplied output object instead of
   allocating one, so the per-frame render loop (looping over every visible
   node) does zero allocations. `project` is a convenience wrapper that
   allocates — used by tests and any non-hot-path caller.
*/

export interface CameraInput {
  width: number;
  height: number;
  /** Combined auto-rotation + user drag Y offset, radians. */
  rotY: number;
  /** User drag X tilt offset (added to the fixed base tilt when is3D). */
  userRX: number;
  /** 0.45..4, per the handoff's zoom clamp range. */
  zoom: number;
  is3D: boolean;
}

export interface CameraParams {
  centerX: number;
  centerY: number;
  cosY: number;
  sinY: number;
  cosX: number;
  sinX: number;
  scale: number;
  fov: number;
  is3D: boolean;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface ProjectedPoint {
  sx: number;
  sy: number;
  /** Depth after rotation (camera-space z) — used for far->near sort order. */
  z: number;
  /** Perspective factor (fov / (fov + z)) — drives on-screen scale. */
  persp: number;
  /** 0..1 depth-of-field fade derived from `persp`. */
  fade: number;
}

const BASE_TILT = 0.34;
const FOV = 3.0;
const SCALE_FACTOR = 0.265;
const FADE_NEAR = 0.62;
const FADE_RANGE = 1.5;

/** Zoom range allowed by the handoff's wheel-zoom clamp. */
export const ZOOM_MIN = 0.45;
export const ZOOM_MAX = 4;

/** Auto-rotation speed applied per frame while idle (no drag/hover/selection). */
export const AUTO_ROTATE_SPEED = 0.0012;

export function clampZoom(zoom: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
}

/** Precomputes the trig/scale terms shared by every point projected this frame. */
export function buildCameraParams(input: CameraInput): CameraParams {
  const { width, height, rotY, userRX, zoom, is3D } = input;
  const tiltX = is3D ? BASE_TILT + userRX : 0;
  return {
    centerX: width / 2 - 18,
    centerY: height / 2 + 14,
    cosY: Math.cos(rotY),
    sinY: Math.sin(rotY),
    cosX: Math.cos(tiltX),
    sinX: Math.sin(tiltX),
    scale: Math.min(width, height) * SCALE_FACTOR * clampZoom(zoom),
    fov: FOV,
    is3D,
  };
}

/** Zero-allocation projection — writes results into `out`. Use in the render hot path. */
export function projectInto(point: Point3, cam: CameraParams, out: ProjectedPoint): void {
  const fl = cam.is3D ? point.z : 0;
  const x1 = point.x * cam.cosY - fl * cam.sinY;
  const z1 = point.x * cam.sinY + fl * cam.cosY;
  const y1 = point.y * cam.cosX - z1 * cam.sinX;
  const z2 = point.y * cam.sinX + z1 * cam.cosX;
  const persp = cam.is3D ? cam.fov / (cam.fov + z2) : 1;
  out.sx = cam.centerX + x1 * persp * cam.scale;
  out.sy = cam.centerY + y1 * persp * cam.scale;
  out.z = z2;
  out.persp = persp;
  out.fade = Math.max(0, Math.min(1, (persp - FADE_NEAR) / FADE_RANGE));
}

/** Allocating convenience wrapper around `projectInto` — fine outside the render loop (tests, one-offs). */
export function project(point: Point3, cam: CameraParams): ProjectedPoint {
  const out: ProjectedPoint = { sx: 0, sy: 0, z: 0, persp: 0, fade: 0 };
  projectInto(point, cam, out);
  return out;
}

/** LOD stride for the ambient cortex field: thin out points once zoomed far out. */
export function ambientStride(zoom: number): number {
  return zoom < 0.75 ? 2 : 1;
}

export interface HitCandidate {
  id: string;
  sx: number;
  sy: number;
  /** On-screen radius of the node's disc. */
  r: number;
  visible: boolean;
}

const HIT_MAX_DISTANCE = 16;
const HIT_RADIUS_MARGIN = 9;

/**
 * Nearest-node hit test for click/hover, ported from the prototype's
 * `hitTest`. Returns the closest visible candidate within both the fixed
 * search radius and the node's own (importance-scaled) radius + margin, or
 * null when nothing qualifies.
 */
export function hitTest(candidates: readonly HitCandidate[], mx: number, my: number): string | null {
  let best: string | null = null;
  let bestDist = HIT_MAX_DISTANCE;
  for (const candidate of candidates) {
    if (!candidate.visible) continue;
    const dx = candidate.sx - mx;
    const dy = candidate.sy - my;
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist && dist < candidate.r + HIT_RADIUS_MARGIN) {
      bestDist = dist;
      best = candidate.id;
    }
  }
  return best;
}
