/* smartEdgePath.ts — W8a deliverable #4: lightweight avoid-nodes routing
   for cross-zone chain edges (React Flow Pro's "smart edge" UX pattern,
   REIMPLEMENTED from scratch — no Pro code referenced). Pure geometry, no
   React, no @xyflow import — directly unit-testable
   (src/__tests__/smartEdgePath.test.ts).

   Contract: given a left-to-right edge (source = a node's RIGHT handle,
   target = a node's LEFT handle) and obstacle rects (project zone bounding
   boxes the edge does NOT belong to), decide whether the straight line
   would cut through an obstacle; if so, produce an orthogonal detour path
   (rounded corners) that goes around the blocking rects, plus a label
   anchor on the longest segment. Returns `null` when no detour is needed —
   the caller keeps its default bezier.

   Deliberately single-detour (one horizontal "shelf" above or below the
   blocking rects, whichever is cheaper): a full A-star/visibility-graph
   router is out of scope ("keep it <150 lines, pure"); the failure mode of
   this simplification is an occasional residual crossing in pathological
   layouts, never a crash or a wild path. */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SmartEdgeResult {
  /** SVG path (M/L/Q — orthogonal segments with rounded corners). */
  path: string;
  /** Label anchor — midpoint of the longest segment. */
  labelX: number;
  labelY: number;
}

/** Margin kept between the routed path and any obstacle edge. */
const CLEARANCE = 24;
/** Corner rounding radius. */
const RADIUS = 10;

function inflate(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

/** Segment/rect intersection via the slab (Liang-Barsky style) clip test. */
export function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x - rect.x) &&
    clip(dx, rect.x + rect.width - a.x) &&
    clip(-dy, a.y - rect.y) &&
    clip(dy, rect.y + rect.height - a.y)
  );
}

/** Builds an SVG path through orthogonal waypoints with rounded corners. */
export function roundedOrthogonalPath(points: readonly Point[], radius: number = RADIUS): string {
  if (points.length < 2) return '';
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 1) {
      d += ` L ${corner.x},${corner.y}`;
      continue;
    }
    const inX = corner.x - ((corner.x - prev.x) / inLen) * r;
    const inY = corner.y - ((corner.y - prev.y) / inLen) * r;
    const outX = corner.x + ((next.x - corner.x) / outLen) * r;
    const outY = corner.y + ((next.y - corner.y) / outLen) * r;
    d += ` L ${inX},${inY} Q ${corner.x},${corner.y} ${outX},${outY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x},${last.y}`;
  return d;
}

function longestSegmentMidpoint(points: readonly Point[]): Point {
  let best: Point = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  let bestLen = -1;
  for (let i = 0; i < points.length - 1; i += 1) {
    const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (len > bestLen) {
      bestLen = len;
      best = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    }
  }
  return best;
}

/**
 * Main entry — see module header. `source` is the right-handle point of the
 * source node, `target` the left-handle point of the target node.
 */
export function computeSmartEdgePath(source: Point, target: Point, obstacles: readonly Rect[]): SmartEdgeResult | null {
  const inflated = obstacles.map((rect) => inflate(rect, CLEARANCE / 2));
  const blocking = inflated.filter((rect) => segmentIntersectsRect(source, target, rect));
  if (blocking.length === 0) return null;

  // One shelf above or below every blocking rect — whichever detours less.
  const topY = Math.min(...blocking.map((r) => r.y)) - CLEARANCE;
  const bottomY = Math.max(...blocking.map((r) => r.y + r.height)) + CLEARANCE;
  const costAbove = Math.abs(source.y - topY) + Math.abs(target.y - topY);
  const costBelow = Math.abs(source.y - bottomY) + Math.abs(target.y - bottomY);
  const shelfY = costAbove <= costBelow ? topY : bottomY;

  // Stems leave the handles horizontally before turning (keeps the exit/
  // entry direction consistent with the handles' left/right orientation).
  const x1 = source.x + CLEARANCE;
  const x2 = target.x - CLEARANCE;
  const points: Point[] = [
    source,
    { x: x1, y: source.y },
    { x: x1, y: shelfY },
    { x: x2, y: shelfY },
    { x: x2, y: target.y },
    target,
  ];

  const label = longestSegmentMidpoint(points);
  return { path: roundedOrthogonalPath(points), labelX: label.x, labelY: label.y };
}
