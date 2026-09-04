/* canvasPlacement.ts — pure geometry helpers for drag-drop / paste /
   duplicate / alignment-guide placement (spec §5 creation + editing). No
   React, no store: CanvasView.tsx and CanvasContextMenu.tsx call these with
   plain data (the current node list, a flow-space point) and get back a
   placement decision. Kept separate from reconciler.ts (which owns
   AUTOMATIC grid placement for brand-new nodes with no stored position)
   because this module answers a different question: "where did the user
   just drop/paste/drag something, in flow space, relative to what zone".
*/

import type { CanvasReactFlowNode } from './reconciler';

export interface FlowPoint {
  x: number;
  y: number;
}

export interface ZoneGeometry {
  projectId: string;
  /** Absolute flow-space position + size of the zone's OWN node (project
   *  nodes never have a parentId, so `position` is already absolute). */
  position: FlowPoint;
  size: { width: number; height: number };
}

/** Extracts every rendered project zone's absolute geometry from the current
 *  node list — used for hit-testing a drop/paste point against zones. */
export function zoneGeometriesFromNodes(nodes: readonly CanvasReactFlowNode[]): ZoneGeometry[] {
  return nodes
    .filter((n) => n.type === 'project')
    .map((n) => ({
      projectId: (n.data as { projectId: string }).projectId,
      position: n.position,
      size: { width: n.width ?? 0, height: n.height ?? 0 },
    }));
}

/** Finds which zone (if any) contains an absolute flow-space point —
 *  undefined means "outside every zone" (Transverse territory). Collapsed
 *  zones (fixed chip size) are included as-is: their `size` already
 *  reflects the collapsed chip, so a drop onto a collapsed chip is honestly
 *  "inside that zone", not silently ignored. */
export function zoneAtPoint(zones: readonly ZoneGeometry[], point: FlowPoint): ZoneGeometry | undefined {
  return zones.find(
    (z) =>
      point.x >= z.position.x &&
      point.x <= z.position.x + z.size.width &&
      point.y >= z.position.y &&
      point.y <= z.position.y + z.size.height,
  );
}

/** Converts an absolute flow-space point into a zone-relative point (child
 *  node positions are relative to their parent when `extent: 'parent'`). */
export function toZoneRelative(point: FlowPoint, zone: ZoneGeometry): FlowPoint {
  return { x: point.x - zone.position.x, y: point.y - zone.position.y };
}

const PASTE_OFFSET_STEP = 20;
const DUPLICATE_OFFSET: FlowPoint = { x: 24, y: 24 };

/** Calculates perpendicular distance from point P to line segment AB. */
export function distanceToSegment(p: FlowPoint, a: FlowPoint, b: FlowPoint): number {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
}

/** Finds the closest chain edge whose path passes within `threshold` px of `point`.
 *  Generic over `T` (the real call site passes `Chain[]`, canvasTypes.ts) —
 *  constrained only to the fields this function actually reads
 *  (`sourceRef`/`targetRef` for hit-testing, `id` for the returned match);
 *  a chain's `condition` and every other Chain-specific field pass through
 *  untouched via `T` without needing to be named here. */
export function findChainNearPoint<T extends { id: string; sourceRef: string; targetRef: string }>(
  point: FlowPoint,
  chains: readonly T[],
  nodes: readonly CanvasReactFlowNode[],
  threshold = 45,
): T | null {
  const nodePositions = new Map<string, FlowPoint>();
  for (const n of nodes) {
    const parent = n.parentId ? nodes.find((p) => p.id === n.parentId) : null;
    const absX = (parent?.position.x ?? 0) + n.position.x + (n.width ?? 260) / 2;
    const absY = (parent?.position.y ?? 0) + n.position.y + (n.height ?? 160) / 2;
    nodePositions.set(n.id, { x: absX, y: absY });
  }

  let closest: T | null = null;
  let minDistance = Infinity;

  for (const chain of chains) {
    const p1 = nodePositions.get(chain.sourceRef);
    const p2 = nodePositions.get(chain.targetRef);
    if (!p1 || !p2) continue;
    const dist = distanceToSegment(point, p1, p2);
    if (dist <= threshold && dist < minDistance) {
      minDistance = dist;
      closest = chain;
    }
  }

  return closest;
}

/** Positions for N pasted items, staggered so they never perfectly overlap
 *  (spec §5 "paste ... of draft specs" + task's "pastes at cursor with
 *  offset"). Index 0 lands exactly at `basePosition` (the cursor). */
export function pastePositions(basePosition: FlowPoint, count: number): FlowPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: basePosition.x + i * PASTE_OFFSET_STEP,
    y: basePosition.y + i * PASTE_OFFSET_STEP,
  }));
}

/** Position for a single Ctrl+D duplicate — a fixed small offset from the
 *  original so the copy is immediately visible next to its source instead
 *  of stacked exactly on top of it. */
export function duplicatePosition(originalPosition: FlowPoint): FlowPoint {
  return { x: originalPosition.x + DUPLICATE_OFFSET.x, y: originalPosition.y + DUPLICATE_OFFSET.y };
}

// ── Alignment guides (spec §5 "Snap & guides") ────────────────────────

const ALIGN_THRESHOLD = 6;

export interface AlignmentGuides {
  /** Flow-space X of a vertical guide line, when the dragged node's X
   *  aligns with a sibling's X within {@link ALIGN_THRESHOLD}px. */
  x?: number;
  /** Flow-space Y of a horizontal guide line. */
  y?: number;
}

/**
 * Compares a dragged node's CURRENT position against its siblings (same
 * parentId, i.e. same project zone) and returns guide-line coordinates when
 * an edge/position aligns within a small pixel threshold — a lightweight
 * "smart guide" (Figma/n8n-style), not real snapping (snapToGrid is React
 * Flow's own prop, wired separately in CanvasView).
 */
export function computeAlignmentGuides(
  dragged: { id: string; parentId?: string; position: FlowPoint },
  allNodes: readonly CanvasReactFlowNode[],
): AlignmentGuides {
  const siblings = allNodes.filter(
    (n) => n.id !== dragged.id && n.type !== 'project' && n.parentId === dragged.parentId,
  );

  let x: number | undefined;
  let y: number | undefined;
  for (const sibling of siblings) {
    if (x === undefined && Math.abs(sibling.position.x - dragged.position.x) <= ALIGN_THRESHOLD) {
      x = sibling.position.x;
    }
    if (y === undefined && Math.abs(sibling.position.y - dragged.position.y) <= ALIGN_THRESHOLD) {
      y = sibling.position.y;
    }
    if (x !== undefined && y !== undefined) break;
  }
  return { x, y };
}
