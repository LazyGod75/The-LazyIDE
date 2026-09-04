/* placementCollision.ts — shared no-overlap placement primitives (fix/canvas-ux
   R4a wave). David's invariant, verbatim: "le canvas pour chaque projet n'a
   pas vraiment de limite en taille donc AUCUN agent ne doit être superposé ou
   l'un sur l'autre" — zones are effectively unbounded, so there is never a
   good reason for two rendered sibling nodes to overlap.

   This module is the ONE place that answers "does this rect collide with
   what's already there, and if so, where's the nearest free spot" — both
   reconcilerZones.ts's AUTO-PLACED collision-resolution pass (grid slots,
   pinned coordinates, loop-expansion iteration minis) and the interactive
   creation paths (edge-drop picker, quick-create CTA, palette drag-drop,
   paste — all funneled through useCanvasFlowGraph.ts's
   `placeInZoneOrTransverse`) call into this same `findFreePosition` /
   `resolveCollisions` pair, instead of duplicating an ad-hoc placement guess
   per call site.

   Pure functions only: no React, no store, no reconciler import — kept a
   leaf dependency exactly like geometry.ts/canvasPlacement.ts, so either
   "pure geometry" layer (reconciler-side or interactive-side) can import
   this without creating a cycle.
*/

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** Standard axis-aligned-rectangle overlap test — strict on both axes (two
 *  rects that merely TOUCH at an edge, `a.x === b.x + b.width`, do NOT
 *  count as overlapping). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function rectAt(position: Point, size: Size): Rect {
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function collidesAny(candidate: Rect, occupied: readonly Rect[]): boolean {
  return occupied.some((rect) => rectsOverlap(candidate, rect));
}

/** Extra breathing room added on top of a node's own footprint when
 *  stepping the scan below — without this, two full cards placed on
 *  adjacent scan steps would sit pixel-flush against each other (technically
 *  non-overlapping per `rectsOverlap`'s strict test, but visually touching);
 *  same rationale as geometry.ts's own `CELL_MARGIN` ("two adjacent slots'
 *  cards never touch at any zoom"), just a smaller value since this scan
 *  also has to work for the small note/iteration/router footprints. */
const SCAN_MARGIN = 16;
/** How far the shelf scan searches right (`maxCols`) and down (`maxRows`)
 *  from the preferred point before giving up and falling back — generous
 *  enough for any real zone's child count (a zone with hundreds of nodes is
 *  not a realistic fixture), never actually exhausted in practice. */
const DEFAULT_MAX_COLS = 40;
const DEFAULT_MAX_ROWS = 80;

export interface FindFreePositionOptions {
  /** Floor for the returned x/y (default 0 — React Flow's `extent: 'parent'`
   *  clamps zone-relative children to non-negative coordinates anyway, so a
   *  caller handing in a raw drop point at the zone's left/top edge never
   *  gets pushed into negative space). */
  minX?: number;
  minY?: number;
  maxCols?: number;
  maxRows?: number;
}

/**
 * Finds a position for a box of `size` that doesn't intersect any rect in
 * `occupied`, starting the search at `preferred` and scanning outward in a
 * deterministic SHELF pattern (right across the row first, then down to the
 * next row) — never randomness, so the same fixture always resolves to the
 * same free slot. Biased right-and-down only (never left/up of `preferred`):
 * matches this codebase's existing row-major reading order (assignChildPositions'
 * own grid slots, packAutoPlacedZones' shelf-pack, laneLayout's row stacking
 * all read left-to-right/top-to-bottom already), and matches the spec's own
 * "shift the below-rows down" framing for the loop-expansion case — a pushed
 * node should read as "the next free slot after this one", not jump
 * somewhere above/left of where it started.
 *
 * Because the canvas is unbounded (David's rule), this never truly fails —
 * worst case it steps far enough right/down that nothing is left to collide
 * with; the `maxCols`/`maxRows` bound plus fallback below is just a sane
 * circuit-breaker, not a real limitation.
 */
export function findFreePosition(
  occupied: readonly Rect[],
  size: Size,
  preferred: Point,
  options: FindFreePositionOptions = {},
): Point {
  const minX = options.minX ?? 0;
  const minY = options.minY ?? 0;
  const maxCols = options.maxCols ?? DEFAULT_MAX_COLS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const startX = Math.max(minX, preferred.x);
  const startY = Math.max(minY, preferred.y);
  const stepX = size.width + SCAN_MARGIN;
  const stepY = size.height + SCAN_MARGIN;

  for (let row = 0; row <= maxRows; row += 1) {
    for (let col = 0; col <= maxCols; col += 1) {
      const candidate = { x: startX + col * stepX, y: startY + row * stepY };
      if (!collidesAny(rectAt(candidate, size), occupied)) return candidate;
    }
  }

  // Unreachable in any real fixture (the bound above covers a 40x80 shelf —
  // far more slots than any real zone's child count) — an honest fallback
  // rather than a crash: stack below everything currently occupied.
  const fallbackY = occupied.reduce((max, rect) => Math.max(max, rect.y + rect.height), startY) + stepY;
  return { x: startX, y: fallbackY };
}

export interface PositionedItem {
  position: Point;
}

// ── Persisted-position declutter (fix/canvas-ux R10) ──────────────────────
//
// David's golden rule extended: NO overlap EVER, PINNED x PINNED included.
// Before this wave, `resolveCollisions` above treated every persisted
// (pinned) position as fully immovable — correct for a SINGLE session's own
// deliberate drag, but wrong across successive runs: two different missions
// each independently auto-placed (and then persisted) at the same grid slot
// in two different sessions collide forever, since neither was ever a
// "pinned x pinned" case `resolveCollisions` even looks at (both branches
// return a fixed item untouched, never checking it against another fixed
// item — see that function's own doc comment).
//
// The extended rule: a persisted position is preferred, but when two
// persisted-position nodes collide, one of them yields — the winner is
// decided by (1) session-dragged status (a user actively repositioning a
// node THIS session is never touched, full stop — an "immovable" flag, see
// canvasStore.ts's sessionDragged tracking) then (2) recency (`recencyMs` —
// e.g. FleetMission.updatedMs; ties, or a candidate with no real recency
// signal, use array order as a stable tiebreak). The loser is nudged via
// findFreePosition and the caller persists its new position (see
// reconcilerZones.ts's `declutterPinnedChildren` / reconciler.ts's
// `declutteredPositions` output).

export interface PinnedCandidate extends PositionedItem {
  ref: string;
  size: Size;
  /** Higher = more recently updated. 0 for a node kind with no real recency
   *  signal (see reconcilerZones.ts's `recencyOfChild`) — such a candidate
   *  always loses to one with a real timestamp, and ties are broken by
   *  array order (earlier wins, matching `resolveCollisions`' own
   *  first-come-first-served convention). */
  recencyMs: number;
  /** True when the user dragged this node THIS session (canvasStore's
   *  session-dragged set) — never nudged, and wins any collision it's part
   *  of outright, regardless of recency. Two immovable candidates that
   *  happen to collide with EACH OTHER are left overlapping on purpose
   *  (both are the user's own doing this session — see this module's
   *  header) rather than one arbitrarily winning. */
  immovable: boolean;
}

/** Orders declutter processing: immovable candidates first (in their
 *  original relative order), then by descending recency, ties broken by
 *  original array order — see {@link PinnedCandidate.recencyMs}'s doc
 *  comment. Processing highest-priority first means a lower-priority
 *  candidate is the one that discovers (and yields to) the collision, never
 *  the reverse. */
function declutterOrder(items: readonly PinnedCandidate[]): number[] {
  return items
    .map((_, index) => index)
    .sort((indexA, indexB) => {
      const a = items[indexA]!;
      const b = items[indexB]!;
      if (a.immovable !== b.immovable) return a.immovable ? -1 : 1;
      if (a.recencyMs !== b.recencyMs) return b.recencyMs - a.recencyMs;
      return indexA - indexB;
    });
}

export interface DeclutterResult<T extends PinnedCandidate> {
  /** Same items, same order as the input — a loser's `position` is replaced
   *  with its nudged free slot; every other field (including a winner's
   *  original `position`) is untouched. */
  items: T[];
  /** Refs whose `position` was changed — the caller persists exactly these
   *  (reconciler.ts's `declutteredPositions` output) so the corrected
   *  position becomes the new (non-colliding) truth on the next reconcile,
   *  instead of re-discovering — and re-resolving — the same collision
   *  every single pass. */
  movedRefs: ReadonlySet<string>;
}

/**
 * Resolves every PINNED x PINNED overlap in `items` (see this section's
 * header for the winner/loser rule) plus any collision against
 * `otherObstacles` (already-resolved rects from a different pass, e.g. a
 * sibling zone — empty by default: reconcilerZones.ts's caller only ever
 * declutters within one zone's own children, matching the existing
 * sibling-only no-overlap invariant). Pure — no mutation of `items`.
 */
export function declutterPinnedOverlaps<T extends PinnedCandidate>(
  items: readonly T[],
  otherObstacles: readonly Rect[] = [],
): DeclutterResult<T> {
  if (items.length < 2) return { items: [...items], movedRefs: new Set() };

  const order = declutterOrder(items);
  const occupied: Rect[] = [...otherObstacles];
  const resolved = new Array<T>(items.length);
  const movedRefs = new Set<string>();

  for (const index of order) {
    const item = items[index]!;
    const rect = rectAt(item.position, item.size);

    if (item.immovable) {
      // Never checked for collision, never moved — but still an obstacle
      // for every lower-priority candidate processed after it.
      occupied.push(rect);
      resolved[index] = item;
      continue;
    }

    if (!collidesAny(rect, occupied)) {
      occupied.push(rect);
      resolved[index] = item;
      continue;
    }

    const freePosition = findFreePosition(occupied, item.size, item.position);
    occupied.push(rectAt(freePosition, item.size));
    resolved[index] = { ...item, position: freePosition };
    movedRefs.add(item.ref);
  }

  return { items: resolved, movedRefs };
}

/**
 * Two-phase collision-resolution pass over `items` — reconcilerZones.ts's
 * AUTO-PLACED grid/loop-expansion pass runs this twice (see that module's
 * own comment); the two phases here are what make BOTH passes correct
 * regardless of `items`' own array order:
 *
 *   Phase 1 seeds `occupied` with EVERY item `isFixed` calls true on, in
 *   `items`' own order — order-independent from the CALLER's perspective:
 *   a fixed item is an obstacle to every auto item regardless of where it
 *   sits in the array, which is exactly what fixes the "grid auto-layout
 *   doesn't reserve space around an arbitrary pinned coordinate" defect —
 *   without this upfront seeding, an auto item processed BEFORE a
 *   later-in-array fixed item would place itself unaware that obstacle
 *   exists at all.
 *
 *   Phase 2 walks `items` in their ORIGINAL order, returning every fixed
 *   item untouched and pushing any auto item that collides with an
 *   already-registered rect (a fixed item's, or a previously-resolved auto
 *   sibling's) to {@link findFreePosition}'s nearest free slot — then
 *   registers that new rect too, so a third colliding item avoids both.
 *
 * `initialObstacles` seeds phase 1 further (reconcilerZones.ts's second
 * pass uses this for the loop-expansion iteration minis, which are never
 * themselves part of `items` — they're a fixed, non-negotiable obstacle
 * derived separately, see reconcilerFold.ts's `iterationExtrasFor`).
 */
export function resolveCollisions<T extends PositionedItem>(
  items: readonly T[],
  isFixed: (item: T) => boolean,
  sizeOf: (item: T) => Size,
  initialObstacles: readonly Rect[] = [],
): T[] {
  const occupied: Rect[] = [...initialObstacles];
  for (const item of items) {
    if (isFixed(item)) occupied.push(rectAt(item.position, sizeOf(item)));
  }

  return items.map((item) => {
    if (isFixed(item)) return item;
    const size = sizeOf(item);
    const candidate = rectAt(item.position, size);
    if (!collidesAny(candidate, occupied)) {
      occupied.push(candidate);
      return item;
    }
    const freePosition = findFreePosition(occupied, size, item.position);
    occupied.push(rectAt(freePosition, size));
    return { ...item, position: freePosition };
  });
}
