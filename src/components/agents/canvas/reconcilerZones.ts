/* reconcilerZones.ts — zone sizing/packing (W9 split of the original
   1146-line reconciler.ts; see reconciler.ts's own module header for the
   full pipeline story and the original W1a contract-gap notes). PURE
   functions only, same contract as reconciler.ts: no React, no I/O.

   Owns: the `CanvasReactFlowNode` React Flow node-shape union, per-zone
   child collection (missions/drafts/schedules/notes/routers ->
   ChildCandidate[]), incremental placement (an existing position is NEVER
   moved; a new child gets the next free grid slot), zone bounding-box
   sizing, shelf-packing of every AUTO-placed zone (no persisted position),
   and the referential-stability helpers (`stableData`/`dataUnchanged` for a
   node's `data` field, `stableNode`/`sameNodeShape` for the WHOLE node
   object) that let React.memo skip re-rendering a node whose derived `data`
   didn't actually change between two reconcile() calls, AND let React
   Flow's own `adoptUserNodes` identity fast-path recognize an unchanged
   node and keep its `measured`/`handleBounds` instead of wiping them.

   `reconciler.ts` is the sole orchestrator: it builds one `ZoneInput` per
   FleetProject (+ the synthetic Transverse zone), calls `computeZoneLayout`
   for each, resolves final positions (persisted verbatim, or
   `packAutoPlacedZones`'s shelf-pack), then `emitZone`s them in order.
*/

import type { Node } from '@xyflow/react';
import type { ApprovalMode, MissionStatus } from '../../../lib/agents/types';
import type { FleetMission } from '../../../lib/agents/fleetMissions';
import {
  EMPTY_ZONE_HEIGHT,
  EMPTY_ZONE_WIDTH,
  FULL_CARD_MAX_HEIGHT,
  FULL_CARD_WIDTH,
  GRID_CELL_HEIGHT,
  GRID_CELL_WIDTH,
  LANE_MODE_ZONE_WIDTH,
  ZONE_TITLE_BAND_HEIGHT,
  ZONE_HEADER_HEIGHT,
  ZONE_PADDING,
  packColumnsForZoneCount,
  zoneMinWidthForTitle,
  zoneRowPackGap,
  zoneSameRowPackGap,
} from './geometry';
import {
  makeRef,
  parseRef,
  projectColor,
  type BotNodeData,
  type CanvasNodeKind,
  type CanvasPrefs,
  type DraftSpec,
  type FrameSpec,
  type IterationNodeData,
  type JoinNodeData,
  type JoinSourceView,
  type JoinSpec,
  type LoopIterationChip,
  type LoopNodeData,
  type MissionNodeData,
  type NodeRef,
  type NoteData,
  type ProjectNodeCounts,
  type ProjectNodeData,
  type RouterNodeData,
  type RouterSpec,
  type ScheduleNodeData,
  type SurfaceSpec,
  type BotVmNodeData,
  type ZoneMissionDot,
} from './canvasTypes';
import { isJoinSourceSatisfied } from '../../../lib/agents/joinEngine';
import { ITERATION_NODE_HEIGHT, ITERATION_NODE_WIDTH, iterationExtrasFor, type MissionLoopMeta, type MissionStatusLike } from './reconcilerFold';
import { declutterPinnedOverlaps, resolveCollisions, rectsOverlap, type PinnedCandidate, type Rect } from './placementCollision';

// ── Node shape ────────────────────────────────────────────────────────

// `& Record<string, unknown>` is required on every node-data type below:
// canvasTypes.ts's node data payloads are plain `interface`s, and TS does
// not synthesize an implicit index signature for interfaces the way it
// does for inline object-literal types — without the intersection,
// `Node<X, ...>` fails @xyflow/react's `NodeData extends Record<string,
// unknown>` constraint even though every real value is perfectly
// assignable. Same fix W1b's node components independently landed on
// (see nodes/MissionNode.tsx's identical comment) — confirms this is a
// canvasTypes.ts-level characteristic, not a one-off.
export type CanvasReactFlowNode =
  | Node<ProjectNodeData & Record<string, unknown>, 'project'>
  | Node<MissionNodeData & Record<string, unknown>, 'mission'>
  | Node<LoopNodeData & Record<string, unknown>, 'loop'>
  | Node<ScheduleNodeData & Record<string, unknown>, 'schedule'>
  | Node<DraftSpec & Record<string, unknown>, 'draft'>
  | Node<NoteData & Record<string, unknown>, 'note'>
  | Node<IterationNodeData & Record<string, unknown>, 'iteration'>
  | Node<RouterNodeData & Record<string, unknown>, 'router'>
  | Node<JoinNodeData & Record<string, unknown>, 'join'>
  | Node<SurfaceSpec & Record<string, unknown>, 'terminal'>
  | Node<SurfaceSpec & Record<string, unknown>, 'preview'>
  | Node<BotNodeData & Record<string, unknown>, 'bot'>
  | Node<BotVmNodeData & Record<string, unknown>, 'botVm'>
  | Node<FrameSpec & Record<string, unknown>, 'frame'>;

// ── Layout constants (spec §6: incremental placement, not full auto-layout
//    — that is W2b's elkjs job). GRID_CELL_WIDTH/HEIGHT/ZONE_PADDING/
//    ZONE_HEADER_HEIGHT/zoneSameRowPackGap come from geometry.ts (W6b — see
//    that module's header for why: this file, layout.ts, and
//    nodes/ProjectGroupNode.tsx must all agree on the same pixel grid). ──

/**
 * scratch/_canvas-label-design.md §3.3 item 4 ("densité interne des zones")
 * — replaces the old flat `GRID_MAX_COLS = 4` with the SAME viewport-aspect
 * column formula {@link packColumnsForZoneCount} already uses for zone-level
 * packing (geometry.ts), just evaluated at a squatter target ratio (1.5, vs.
 * 1.7 for the whole-canvas zone grid — a zone's own body reads a little
 * taller/narrower than the full app window, so a slightly less wide target
 * keeps it looking like a card grid rather than a single wide shelf): a
 * 12-mission zone now wraps to 4 columns x 3 rows (`round(sqrt(12*1.5)) =
 * round(4.24) = 4`) instead of the old fixed-4 grid's 4x3 coincidentally
 * matching by luck at exactly 12, and DIVERGING at other counts (8 missions:
 * old fixed-4 gives 4x2 — already square-ish; 20 missions: old fixed-4 gives
 * 4x5, a tall narrow column, vs. this formula's `round(sqrt(30)) = 5` -> 5x4,
 * staying trapu). Trapu (squat) zones keep each zone's own bounding box
 * closer to square, which is what keeps the WHOLE-canvas bbox (and therefore
 * "fit"'s own zoom) from being dominated by one abnormally tall zone.
 */
const GRID_ASPECT_TARGET = 1.5;
/** See geometry.ts's EMPTY_ZONE_WIDTH/HEIGHT doc comment (defect #6 —
 *  living empty zones need real room for a digest body, not just a hint). */
const EMPTY_ZONE_SIZE = { width: EMPTY_ZONE_WIDTH, height: EMPTY_ZONE_HEIGHT };
const COLLAPSED_ZONE_SIZE = { width: 220, height: 64 };

/** Synthetic project id for the Transverse zone (spec §4.1, §6). */
export const TRANSVERSE_PROJECT_ID = 'transverse';

// W-CLOSE row 2 — 'frame' is deliberately excluded from ChildKind: a frame
// never goes through collectZoneChildren/effectiveChildSize/the collision-
// resolution pipeline below (see canvasTypes.ts's FrameSpec header, "v1
// honest scope" — no bbox participation, no reflow). It has its own sibling
// pipeline (`buildFrameNodes`) instead.
export type ChildKind = Exclude<CanvasNodeKind, 'project' | 'frame'>;

// Mission/loop/schedule/draft all render as the SAME "full card" footprint
// at zoom >= ZOOM_COMPACT (nodeChrome.tsx's NodeCard, geometry.ts's
// FULL_CARD_WIDTH/FULL_CARD_MAX_HEIGHT) — using that exact size here (not
// a smaller guess) is what makes computeBoundingBox's zone bbox an honest
// upper bound of the real rendered content (spec CRITICAL 2/3: full cards
// must never overlap, and the zone tint must cover every child). `note`
// keeps its own small fixed footprint (geometry.ts's header explains why
// it's excluded from the full-card system).
//
// ITERATION_NODE_WIDTH/HEIGHT are IMPORTED (above) and re-exported here
// (not defined here — see reconcilerFold.ts's own doc comment on why they
// live there: keeps the Zones<->Fold runtime dependency one-way) purely so
// every EXTERNAL consumer of this file's constants (reconciler.ts's public
// barrel, nodes/IterationNode.tsx) sees one coherent geometry surface
// regardless of which sibling file actually owns a given constant.
export { ITERATION_NODE_WIDTH, ITERATION_NODE_HEIGHT };

/** W8c — router diamond footprint (small, fixed, never part of the
 *  full-card system — same rationale as `note`/`iteration`: a router shows
 *  N labeled OUTGOING EDGES, not a full mission-shaped card). */
export const ROUTER_NODE_SIZE = { width: 96, height: 96 };

/** W-JOIN — join diamond footprint, same size/rationale as
 *  {@link ROUTER_NODE_SIZE} (its fan-in mirror image). */
export const JOIN_NODE_SIZE = { width: 96, height: 96 };

/** R7 (living surfaces) — default terminal/preview footprints (spec: "~560x360"
 *  terminal, "~520x400" preview) — both user-resizable via NodeResizer
 *  (SurfaceSpec.width/height overrides this default, see `effectiveChildSize`
 *  below), same "default unless a stored override says otherwise" convention
 *  every other resizable/expandable footprint in this file follows. */
export const TERMINAL_NODE_SIZE = { width: 560, height: 360 };
export const PREVIEW_NODE_SIZE = { width: 520, height: 400 };

/** R7 — default live-panel size for an expanded mission card (spec: "~520x420"). */
export const LIVE_PANEL_SIZE = { width: 520, height: 420 };

/** W-CLOSE row 2 — default footprint for a freshly-created empty frame
 *  (the pane-menu "Nouveau cadre ici" path; "Encadrer la sélection" sizes
 *  itself to the selection's own bounding box instead — see
 *  CanvasContextMenu.tsx's `frameSelection`). User-resizable via NodeResizer
 *  afterward (FrameSpec.width/height overrides this default, same
 *  "presence overrides the default" convention as every other resizable
 *  footprint in this file). */
export const DEFAULT_FRAME_SIZE = { width: 360, height: 240 };

/** Every child kind's REAL footprint — the single canonical source both the
 *  reconciler's own collision-resolution pass below AND the interactive
 *  creation paths (useCanvasFlowGraph.ts's `placeInZoneOrTransverse`, fed by
 *  CanvasView.tsx's edge-drop picker + the "Lancer un agent" CTA + palette
 *  drag-drop + paste) key off — exported (fix/canvas-ux R4a) so a creation
 *  path never has to guess a size independently of what the reconciler will
 *  actually render. */
export const DEFAULT_NODE_SIZE: Record<ChildKind, { width: number; height: number }> = {
  mission: { width: FULL_CARD_WIDTH, height: FULL_CARD_MAX_HEIGHT },
  loop: { width: FULL_CARD_WIDTH, height: FULL_CARD_MAX_HEIGHT },
  schedule: { width: FULL_CARD_WIDTH, height: FULL_CARD_MAX_HEIGHT },
  draft: { width: FULL_CARD_WIDTH, height: FULL_CARD_MAX_HEIGHT },
  note: { width: 180, height: 108 },
  // W8a: read-only loop-iteration mini card (loop expand-in-place) — small
  // fixed footprint like `note`, never part of the full-card system.
  iteration: { width: ITERATION_NODE_WIDTH, height: ITERATION_NODE_HEIGHT },
  router: ROUTER_NODE_SIZE,
  join: JOIN_NODE_SIZE,
  terminal: TERMINAL_NODE_SIZE,
  preview: PREVIEW_NODE_SIZE,
  // LazyBot wave — compact card, bigger than a note but smaller than a
  // full mission card (name + halo + autonomy + action line).
  bot: { width: 220, height: 140 },
  // LazyBot wave — connected VM window node (resizable; default ~"340x260").
  botVm: { width: 340, height: 260 },
};

/**
 * R7 — a child's EFFECTIVE footprint, honoring a stored override when one
 * exists: a terminal/preview's own resized `width`/`height` (SurfaceSpec), or
 * an expanded mission's live-panel size (`ctx.expandedPanels`, keyed by the
 * mission's own ref). Every other kind (and a non-expanded mission/non-resized
 * surface) falls back to `DEFAULT_NODE_SIZE` unchanged. This is the ONE place
 * `computeZoneLayout`'s collision-resolution/bbox passes and `buildChildNode`
 * ask "how big does this child actually render" — CRITICAL for the
 * no-overlap invariant (placementCollision.ts's `resolveCollisions` only
 * prevents overlap for whatever size it's TOLD a child is; feeding it the
 * fixed default while an expanded/resized node renders bigger would silently
 * reintroduce overlap for exactly this new feature).
 */
function effectiveChildSize(
  child: { ref: NodeRef; type: ChildKind; data: ChildCandidate['data'] },
  ctx: ZoneBuildContext,
): { width: number; height: number } {
  if (child.type === 'terminal' || child.type === 'preview') {
    const surface = child.data as SurfaceSpec;
    const base = DEFAULT_NODE_SIZE[child.type];
    return { width: surface.width ?? base.width, height: surface.height ?? base.height };
  }
  if (child.type === 'mission') {
    const expanded = ctx.expandedPanels[child.ref];
    if (expanded) return expanded;
  }
  return DEFAULT_NODE_SIZE[child.type];
}

// ── Referential stability (accept prevNodes so React.memo works) ─────
//
// Small self-contained structural comparator — same rationale/approach as
// canvasStore.ts's trackedStateEqual (no deep-equal dependency in
// package.json, and every node `data` payload here is JSON-plain).

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function dataUnchanged(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableData<T>(prevNodeById: ReadonlyMap<string, CanvasReactFlowNode>, ref: string, nextData: T): T {
  const prev = prevNodeById.get(ref);
  if (prev && dataUnchanged(prev.data, nextData)) return prev.data as T;
  return nextData;
}

/** Every field `buildChildNode`/`buildProjectNode`/`buildFrameNodes` below
 *  ever sets on a node object — the full "does this node need a new object
 *  identity" check, one level up from `stableData`'s data-only comparison.
 *  `data` is compared by REFERENCE (`===`), not deep-equal: by the time this
 *  runs, `next.data` already went through `stableData` above, so it's
 *  already the previous object verbatim whenever the underlying fact didn't
 *  change — a reference match here means BOTH the fact and every geometry
 *  field are unchanged. */
function sameNodeShape(prev: CanvasReactFlowNode, next: CanvasReactFlowNode): boolean {
  return (
    prev.type === next.type &&
    prev.parentId === next.parentId &&
    prev.extent === next.extent &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.zIndex === next.zIndex &&
    prev.draggable === next.draggable &&
    prev.connectable === next.connectable &&
    prev.position.x === next.position.x &&
    prev.position.y === next.position.y &&
    prev.data === next.data
  );
}

/**
 * W-CAMERA (defect: fitView-never-moves) — extends `stableData`'s
 * referential-stability idea to the WHOLE node object, not just `data`.
 * Before this, `buildChildNode`/`buildProjectNode` allocated a brand-new
 * node object on EVERY reconcile (~30s poll cadence + every mission
 * update) even when nothing about the node actually changed — React Flow's
 * `adoptUserNodes` identity fast-path (`userNode === internals.userNode`)
 * compares the INCOMING node object's reference against what it stored last
 * time, so a fresh object every reconcile always missed that fast path,
 * which wiped `measured`/`handleBounds` and forced a remeasure. Any
 * `fitView` call landing between the wipe and the next paint frame then
 * resolved against unmeasured nodes (degenerate {0,0,0,0} bbox), so the
 * camera silently never moved. Returning the PREVIOUS node object verbatim
 * whenever `sameNodeShape` holds — allocating a new one only on a real
 * change — is what lets that fast path actually fire. */
function stableNode(prevNodeById: ReadonlyMap<string, CanvasReactFlowNode>, ref: string, next: CanvasReactFlowNode): CanvasReactFlowNode {
  const prev = prevNodeById.get(ref);
  if (prev && sameNodeShape(prev, next)) return prev;
  return next;
}

/** Casts a canvasTypes.ts node/edge data value into the `& Record<string,
 *  unknown>` shape @xyflow/react's generic constraint requires (see the
 *  CanvasReactFlowNode doc comment above) — safe because every field is
 *  already exactly what it claims to be; this only satisfies the
 *  constraint checker, it changes nothing at runtime. */
function widen<T extends object>(value: T): T & Record<string, unknown> {
  return value as T & Record<string, unknown>;
}

// ── Placement ──────────────────────────────────────────────────────

function gridSlotPosition(slot: number, maxCols: number): { x: number; y: number } {
  const col = slot % maxCols;
  const row = Math.floor(slot / maxCols);
  // fix/canvas-title-float — the zone's own title (name + count/approval
  // badges) no longer renders INSIDE this frame at all (it floats ABOVE
  // the frame's top edge, ProjectGroupNode.tsx's `canvas-zone-header` —
  // see geometry.ts's ZONE_TITLE_BAND_HEIGHT doc comment for the full
  // "why"), so row 0 no longer needs a big reserved gap to clear it: this
  // offset is now just ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT = 36 + 0
  // = 36, a small, honest top content-inset (children fill the box from
  // very near its real top), not the previous 440px dead gap.
  return { x: ZONE_PADDING + col * GRID_CELL_WIDTH, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT + row * GRID_CELL_HEIGHT };
}

/**
 * Assigns a position to every child: an existing entry in `positions` is
 * NEVER changed (spec §6 hard requirement); a child with no entry gets the
 * next free grid slot, counted AFTER every already-positioned sibling so
 * new nodes land "below-right of the last sibling" without needing real
 * collision detection.
 *
 * scratch/_canvas-label-design.md §3.3 item 4 — the column count is no
 * longer a flat {@link GRID_MAX_COLS}: it's recomputed on every call from
 * THIS zone's own total child count via {@link packColumnsForZoneCount}
 * (evaluated at {@link GRID_ASPECT_TARGET}), so the internal grid wraps
 * toward a squat ~1.5 aspect instead of an arbitrary fixed width. Computed
 * from `children.length` (every child, not just the newly-slotted ones) —
 * the same "recompute fresh from the current total every pass" convention
 * `packAutoPlacedZones`' own `maxPerRow` already uses one layer up, so a
 * zone's internal density and the whole-canvas zone density both track the
 * SAME live count as the zone grows, never a stale snapshot.
 */
function assignChildPositions<T extends { ref: NodeRef }>(
  children: readonly T[],
  positions: Record<NodeRef, { x: number; y: number }>,
): Array<T & { position: { x: number; y: number } }> {
  const existingCount = children.filter((child) => positions[child.ref] !== undefined).length;
  const maxCols = packColumnsForZoneCount(children.length, GRID_ASPECT_TARGET);
  let nextNewSlot = 0;
  return children.map((child) => {
    const existing = positions[child.ref];
    if (existing) return { ...child, position: existing };
    const slot = existingCount + nextNewSlot;
    nextNewSlot += 1;
    return { ...child, position: gridSlotPosition(slot, maxCols) };
  });
}

// ── Surface tethering (preview-surface-correctness fix, "a persisted, sane
//    position tethered to its owning mission") ─────────────────────────────
//
// A terminal/preview surface that has NEVER been given a stored position
// (never dragged, never previously tethered) used to fall straight through
// to `gridSlotPosition`'s generic queue — the SAME fallback every unrelated
// child kind uses, with zero relation to whatever mission it was actually
// created FROM. Two symptoms this fixed, both flagged in the founder's real
// canvas audit: a preview surface landing wherever the sibling COUNT
// happened to put it that render (never durably remembered — recomputed,
// and therefore able to drift, on every single reconcile), and no visual
// link at all between a surface and the mission it was created to show.

/** Flow px between a freshly-tethered surface and the right edge of its
 *  owner's box — comfortable clearance, matches the general spacing scale
 *  `LAYERED_OPTIONS.elk.spacing.nodeNode` (layout.ts) already uses for the
 *  same "real air between two related cards" concern. */
const SURFACE_TETHER_GAP = 40;

/**
 * For every terminal/preview child with NO stored position (`ctx.positions`
 * has no entry for its ref — the ONLY case this ever touches; a previously
 * persisted/tethered or user-dragged position is NEVER revisited, same hard
 * rule `assignChildPositions` itself already enforces) AND a real
 * `SurfaceSpec.ownerRef` resolvable to another child already positioned in
 * this SAME pass, replaces its `assignChildPositions`-assigned grid-slot
 * fallback with a position immediately to the right of its owner's own box.
 * A surface with no `ownerRef`, or whose owner isn't (yet) a rendered child
 * of this zone (a standalone terminal/preview added from the palette with no
 * owning mission — SurfaceSpec.ownerRef's own doc comment), keeps the
 * existing generic grid-slot fallback unchanged: this only makes the
 * COMMON, ownership-known case honest, it never invents an owner.
 *
 * Returns the (possibly-repositioned) children plus the set of refs this
 * pass actually tethered — the caller (`computeZoneLayout`) is responsible
 * for persisting those into `declutteredPositions` so a surface only ever
 * needs tethering ONCE: the same "computed, then durably remembered"
 * contract every other entry in that map already has (see its own doc
 * comment for why a fresh position that's never written back would just
 * silently re-drift on every subsequent reconcile).
 */
function tetherFreshSurfacesToOwner(
  children: readonly (ChildCandidate & { position: { x: number; y: number } })[],
  ctx: ZoneBuildContext,
): { children: Array<ChildCandidate & { position: { x: number; y: number } }>; tetheredRefs: ReadonlySet<NodeRef> } {
  const byRef = new Map(children.map((child) => [child.ref, child] as const));
  const tetheredRefs = new Set<NodeRef>();

  const nextChildren = children.map((child) => {
    if (child.type !== 'terminal' && child.type !== 'preview') return child;
    if (ctx.positions[child.ref] !== undefined) return child; // already persisted — never re-tether
    const ownerRef = (child.data as SurfaceSpec).ownerRef;
    if (!ownerRef) return child;
    const owner = byRef.get(ownerRef);
    if (!owner) return child; // owner not (yet) a rendered child of this zone
    const ownerSize = effectiveChildSize(owner, ctx);
    tetheredRefs.add(child.ref);
    return { ...child, position: { x: owner.position.x + ownerSize.width + SURFACE_TETHER_GAP, y: owner.position.y } };
  });

  return { children: nextChildren, tetheredRefs };
}

// ── Persisted-position declutter (fix/canvas-ux R10) ──────────────────────
// See placementCollision.ts's `declutterPinnedOverlaps` header for the full
// rule. This section is the reconciler-side glue: deriving each pinned
// child's recency signal, and running the pass over one zone's children.

/** Recency signal for the declutter pass — a mission/loop child's own
 *  `FleetMission.updatedMs` (a real fact, already the fleet-wide "what
 *  changed last" signal). Every other child kind (draft/note/schedule/
 *  router/terminal/preview) has no equivalent timestamp in canvasTypes.ts
 *  today, so it reports 0 (oldest) — deterministic, and never confused with
 *  a real timestamp (`updatedMs` is always > 0 for any mission that has
 *  ever been touched). */
function recencyOfChild(child: ChildCandidate): number {
  if (child.type === 'mission' || child.type === 'loop') {
    return (child.data as MissionNodeData | LoopNodeData).mission.updatedMs;
  }
  return 0;
}

/** Recency signal for `declutterPinnedZones` below — same rationale as
 *  `recencyOfChild`, one granularity up: the most-recently-updated mission
 *  anywhere in the zone (0 for a zone with no missions yet — e.g. a
 *  Transverse zone of pure drafts/notes — deterministic, never confused with
 *  a real timestamp). */
function recencyOfZone(zone: ZoneInput): number {
  let max = 0;
  for (const mission of zone.missions) max = Math.max(max, mission.updatedMs);
  return max;
}

/**
 * Declutters PINNED x PINNED overlaps among `children` (already positioned
 * by `assignChildPositions`, so a pinned child's `.position` is its
 * persisted verbatim position) — run BEFORE the ordinary auto-vs-pinned
 * `resolveCollisions` pass below, which never checks a pinned child against
 * ANOTHER pinned child (see that function's own doc comment) — exactly the
 * gap this closes. A no-op (returns `children` as-is, empty `movedRefs`)
 * whenever fewer than two children are pinned — the common case, kept cheap.
 */
function declutterPinnedChildren(
  children: readonly (ChildCandidate & { position: { x: number; y: number } })[],
  isPinnedChild: (child: ChildCandidate) => boolean,
  sizeOfChild: (child: ChildCandidate) => { width: number; height: number },
  sessionDraggedRefs: ReadonlySet<NodeRef>,
): { children: Array<ChildCandidate & { position: { x: number; y: number } }>; movedRefs: ReadonlySet<NodeRef> } {
  const pinnedChildren = children.filter(isPinnedChild);
  if (pinnedChildren.length < 2) return { children: [...children], movedRefs: new Set() };

  const candidates: PinnedCandidate[] = pinnedChildren.map((child) => ({
    ref: child.ref,
    position: child.position,
    size: sizeOfChild(child),
    recencyMs: recencyOfChild(child),
    immovable: sessionDraggedRefs.has(child.ref),
  }));

  const { items: resolved, movedRefs } = declutterPinnedOverlaps(candidates);
  if (movedRefs.size === 0) return { children: [...children], movedRefs };

  const positionByRef = new Map(resolved.map((item) => [item.ref, item.position] as const));
  const nextChildren = children.map((child) => {
    if (!movedRefs.has(child.ref)) return child;
    return { ...child, position: positionByRef.get(child.ref)! };
  });

  return { children: nextChildren, movedRefs };
}

function computeBoundingBox(
  items: ReadonlyArray<{ position: { x: number; y: number }; size: { width: number; height: number } }>,
): { width: number; height: number } | null {
  if (items.length === 0) return null;
  let maxX = 0;
  let maxY = 0;
  for (const item of items) {
    maxX = Math.max(maxX, item.position.x + item.size.width);
    maxY = Math.max(maxY, item.position.y + item.size.height);
  }
  // Left/top padding is already baked into gridSlotPosition's starting
  // offsets (ZONE_PADDING / ZONE_HEADER_HEIGHT) or preserved verbatim for
  // manually-placed nodes (React Flow's extent:'parent' clamps child drags
  // to non-negative relative coordinates, so this never goes negative) —
  // only right/bottom padding needs adding here.
  return { width: maxX + ZONE_PADDING, height: maxY + ZONE_PADDING };
}

// ── Project counts (spec §4.1 header badge) ───────────────────────────

function computeProjectCounts(missions: readonly FleetMission[]): ProjectNodeCounts {
  let running = 0;
  let urgent = 0;
  let review = 0;
  let failed = 0;
  let done = 0;
  for (const mission of missions) {
    if (mission.status === 'running') running += 1;
    if (mission.urgent) urgent += 1;
    if (mission.status === 'review') review += 1;
    if (mission.status === 'failed') failed += 1;
    if (mission.status === 'done') done += 1;
  }
  return { running, urgent, review, failed, done, total: missions.length };
}

/**
 * feat/always-visible-agents — this zone's per-mission dot-strip roster
 * (see canvasTypes.ts's `ZoneMissionDot` doc comment). Mirrors
 * `missionToChildCandidate`'s own "does this mission get a node of its own"
 * rules (loop-iteration consumed by its parent, hidden by a folded
 * orchestrator ancestor, filtered by `hideMerged`) so every dot's `ref`
 * always resolves to a real rendered node — clicking one can always
 * `fitView` onto something that actually exists on the canvas.
 */
function zoneMissionDots(zone: ZoneInput, ctx: ZoneBuildContext): ZoneMissionDot[] {
  const missionIds = new Set(zone.missions.map((mission) => mission.id));
  const dots: ZoneMissionDot[] = [];
  for (const mission of zone.missions) {
    if (ctx.hiddenMissionIds.has(mission.id)) continue; // folded under an orchestrator ancestor
    const meta = ctx.missionLoopMeta.get(mission.id);
    if (meta?.loopParentId && missionIds.has(meta.loopParentId)) continue; // consumed by its loop parent
    if (ctx.prefs.hideMerged && mission.stage === 'merged') continue;
    const kind: 'mission' | 'loop' = meta?.loopConfig ? 'loop' : 'mission';
    dots.push({
      missionId: mission.id,
      ref: makeRef(kind, mission.id),
      title: mission.title,
      status: mission.status,
      paused: mission.paused ?? false,
    });
  }
  return dots;
}

// ── Loop aggregation (spec §4.2 / §6) ─────────────────────────────────

function recentIterationsFor(
  loopParentId: string,
  missions: readonly FleetMission[],
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>,
): LoopIterationChip[] {
  return missions
    .filter((mission) => missionLoopMeta.get(mission.id)?.loopParentId === loopParentId)
    .sort((a, b) => (missionLoopMeta.get(b.id)?.loopIteration ?? 0) - (missionLoopMeta.get(a.id)?.loopIteration ?? 0))
    .slice(0, 3)
    .map((mission) => ({
      id: mission.id,
      status: mission.status,
      iteration: missionLoopMeta.get(mission.id)?.loopIteration ?? 0,
    }));
}

// ── Zone children ──────────────────────────────────────────────────

export interface ChildCandidate {
  ref: NodeRef;
  type: ChildKind;
  data: MissionNodeData | LoopNodeData | ScheduleNodeData | DraftSpec | NoteData | IterationNodeData | RouterNodeData | JoinNodeData | SurfaceSpec;
}

export interface ZoneInput {
  projectId: string;
  root: string;
  name: string;
  isActive: boolean;
  missions: readonly FleetMission[];
  drafts: readonly DraftSpec[];
  scheduled: readonly ScheduleNodeData[];
  notes: readonly NoteData[];
  /** W8c (additive). */
  routers: readonly RouterSpec[];
  /** W-JOIN (additive). */
  joins: readonly JoinSpec[];
  /** R7 (additive) — terminal/preview surface nodes owned by this zone. */
  surfaces: readonly SurfaceSpec[];
  /** W-CLOSE row 2 (additive) — purely-visual frames owned by this zone.
   *  Deliberately NOT part of {@link ChildCandidate}/`collectZoneChildren`
   *  (see `buildFrameNodes`'s own doc comment): a frame never affects zone
   *  bbox sizing or the no-overlap collision-resolution pass — v1 honest
   *  scope, "purely visual", per canvasTypes.ts's FrameSpec header. */
  frames: readonly FrameSpec[];
  /** W-MODES-ui (additive) — mirrors `FleetProject.approvalMode` verbatim
   *  (reconciler.ts's own `project.approvalMode` read, never re-derived
   *  here). Absent for the synthetic Transverse zone (no real project). */
  approvalMode?: ApprovalMode;
}

export interface ZoneBuildContext {
  positions: Record<NodeRef, { x: number; y: number }>;
  collapsed: Record<string, boolean>;
  prefs: CanvasPrefs;
  forceApproveIds: ReadonlySet<string>;
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>;
  urgentRankByMissionId: ReadonlyMap<string, number>;
  prevNodeById: ReadonlyMap<string, CanvasReactFlowNode>;
  /** W8a deliverable #2 — transitive closure of every mission hidden by a
   *  folded orchestrator ancestor (reconcilerFold.ts's computeHiddenMissionIds). */
  hiddenMissionIds: ReadonlySet<string>;
  /** W8a deliverable #2 — per-orchestrator direct sub-mission count/worst
   *  status (reconcilerFold.ts's computeSubMissionAggregates). */
  subMissionAggregates: ReadonlyMap<string, { count: number; worstStatus: MissionStatusLike }>;
  /** W8a deliverable #2 — loop mission ids expanded in-place. */
  expandedLoops: ReadonlySet<string>;
  /** R7 — live-panel expand state for mission nodes, keyed by ref (see
   *  `effectiveChildSize`). */
  expandedPanels: Record<NodeRef, { width: number; height: number }>;
  /** R10 (persisted-position declutter) — refs the user dragged THIS
   *  session (canvasStore's sessionDragged set) — see
   *  `declutterPinnedChildren`/placementCollision.ts's DeclutterResult doc
   *  comment for why these are never nudged, even against another pinned
   *  sibling. */
  sessionDraggedRefs: ReadonlySet<NodeRef>;
  /**
   * W-JOIN — every mission across EVERY project (not just this zone's own),
   * narrowed to the two fields a join's source-view needs, keyed by mission
   * id. A join's sources can reference a mission in a DIFFERENT zone (chains
   * may cross projects, spec §7), so this must be the GLOBAL lookup
   * reconciler.ts's top-level `missionById` already builds — never re-scoped
   * to `zone.missions`. Absent source resolution (mission vanished, or a
   * `loop:<id>` ref — see `buildJoinSourceViews`'s own doc comment for the
   * loop-source scope cut) falls back to the bare ref as its title and
   * 'pending' as its status, never a crash or a fabricated guess.
   */
  missionById: ReadonlyMap<string, { title: string; status: MissionStatus }>;
}

/** One mission -> zero or one child candidate: a consumed loop-iteration
 *  child (its parent loop is present in the same zone) yields nothing — it
 *  is folded into the parent LoopNode's `recentIterations` instead. A
 *  merged mission is dropped when `prefs.hideMerged` is set. A mission
 *  hidden by an ancestor's fold (W8a deliverable #2) yields nothing either —
 *  its sub-mission badge lives on the orchestrator instead. */
function missionToChildCandidate(
  mission: FleetMission,
  zone: ZoneInput,
  ctx: ZoneBuildContext,
): ChildCandidate | null {
  const meta = ctx.missionLoopMeta.get(mission.id);
  const missionById = new Set(zone.missions.map((m) => m.id));

  if (meta?.loopParentId && missionById.has(meta.loopParentId)) return null; // consumed by its loop parent

  if (ctx.hiddenMissionIds.has(mission.id)) return null; // hidden by a folded orchestrator ancestor

  if (ctx.prefs.hideMerged && mission.stage === 'merged') return null;

  if (meta?.loopConfig) {
    const data: LoopNodeData = {
      mission,
      projectId: zone.projectId,
      isActiveProject: zone.isActive,
      loopConfig: meta.loopConfig,
      recentIterations: recentIterationsFor(mission.id, zone.missions, ctx.missionLoopMeta),
    };
    return { ref: makeRef('loop', mission.id), type: 'loop', data };
  }

  const subMissions = ctx.subMissionAggregates.get(mission.id);
  const data: MissionNodeData = {
    mission,
    projectId: zone.projectId,
    isActiveProject: zone.isActive,
    urgentRank: ctx.urgentRankByMissionId.get(mission.id),
    forceApprove: ctx.forceApproveIds.has(mission.id) ? true : undefined,
    subMissionCount: subMissions && subMissions.count > 0 ? subMissions.count : undefined,
    worstSubMissionStatus: subMissions && subMissions.count > 0 ? subMissions.worstStatus : undefined,
  };
  return { ref: makeRef('mission', mission.id), type: 'mission', data };
}

/**
 * Resolves a join's sourceRefs into display-ready {@link JoinSourceView}
 * rows for JoinNode.tsx — title + live arrival status, never a second
 * source of truth (reuses joinEngine.ts's `isJoinSourceSatisfied`, the SAME
 * predicate the actual firing engine uses, so a dot can never disagree with
 * the engine's own decision).
 *
 * Scope cut (time-boxed wave, documented): only `mission:<id>` refs resolve
 * a REAL live status here — a `loop:<id>` ref shows its parent loop
 * mission's title (still resolvable via `missionById`, since a loop's own
 * ref IS its parent mission's id) but is always rendered 'pending', since
 * "this loop's latest completed iteration's outcome" needs a full scan of
 * every project's missions (not just this one id lookup) that this
 * per-zone pass does not have cheaply available. joinEngine.ts's actual
 * FIRING logic (`resolveSourceEntry`) is NOT affected by this cut — it does
 * do the full per-iteration resolution correctly; only this cosmetic
 * arrival-dot rendering is simplified for a loop source.
 */
function buildJoinSourceViews(join: JoinSpec, missionById: ReadonlyMap<string, { title: string; status: MissionStatus }>): JoinSourceView[] {
  return join.sourceRefs.map((ref) => {
    const parsed = parseRef(ref);
    const resolved = parsed ? missionById.get(parsed.id) : undefined;
    const status = parsed?.kind === 'mission' ? resolved?.status : undefined;
    return {
      ref,
      title: resolved?.title ?? ref,
      status: isJoinSourceSatisfied(join.mode, status) ? 'satisfied' : 'pending',
    };
  });
}

function collectZoneChildren(zone: ZoneInput, ctx: ZoneBuildContext): ChildCandidate[] {
  const children: ChildCandidate[] = [];
  for (const mission of zone.missions) {
    const candidate = missionToChildCandidate(mission, zone, ctx);
    if (candidate) children.push(candidate);
  }
  for (const draft of zone.drafts) {
    children.push({ ref: makeRef('draft', draft.id), type: 'draft', data: draft });
  }
  for (const sched of zone.scheduled) {
    children.push({ ref: makeRef('schedule', sched.scheduleId), type: 'schedule', data: sched });
  }
  for (const note of zone.notes) {
    children.push({ ref: makeRef('note', note.id), type: 'note', data: note });
  }
  for (const router of zone.routers) {
    const data: RouterNodeData = { routerId: router.id, projectId: router.projectId, branches: router.branches };
    children.push({ ref: makeRef('router', router.id), type: 'router', data });
  }
  for (const join of zone.joins) {
    const data: JoinNodeData = {
      joinId: join.id,
      projectId: join.projectId,
      name: join.name,
      mode: join.mode,
      sources: buildJoinSourceViews(join, ctx.missionById),
      proposedPlanId: join.proposedPlanId,
    };
    children.push({ ref: makeRef('join', join.id), type: 'join', data });
  }
  for (const surface of zone.surfaces) {
    children.push({ ref: makeRef(surface.kind, surface.id), type: surface.kind, data: surface });
  }
  return children;
}

function buildChildNode(
  child: ChildCandidate & { position: { x: number; y: number } },
  parentId: NodeRef,
  ctx: ZoneBuildContext,
): CanvasReactFlowNode {
  const size = effectiveChildSize(child, ctx);
  const data = widen(stableData(ctx.prevNodeById, child.ref, child.data));
  const next = {
    id: child.ref,
    type: child.type,
    position: child.position,
    parentId,
    extent: 'parent',
    width: size.width,
    height: size.height,
    data,
    // W8a: iteration mini nodes are READ-ONLY projections whose position is
    // recomputed from their parent loop on every reconcile — letting the
    // user drag one would just snap it back next poll, so it isn't
    // draggable at all (clicking still works: onOpenIteration).
    ...(child.type === 'iteration' ? { draggable: false, connectable: false } : {}),
  } as CanvasReactFlowNode; // union-of-Node discrimination on `type` is not
  // narrowed automatically from a runtime-computed ChildKind — safe: `data`
  // always matches `type` by construction (see collectZoneChildren).
  return stableNode(ctx.prevNodeById, child.ref, next);
}

function buildProjectNode(
  zone: ZoneInput,
  ref: NodeRef,
  position: { x: number; y: number },
  size: { width: number; height: number },
  isCollapsed: boolean,
  counts: ProjectNodeCounts,
  hasChildren: boolean,
  laneMode: boolean,
  ctx: ZoneBuildContext,
): CanvasReactFlowNode {
  const nextData: ProjectNodeData = {
    projectId: zone.projectId,
    root: zone.root,
    name: zone.name,
    color: projectColor(zone.projectId),
    collapsed: isCollapsed,
    isActive: zone.isActive,
    counts,
    hasChildren,
    laneMode,
    approvalMode: zone.approvalMode,
    missions: zoneMissionDots(zone, ctx),
  };
  const next: CanvasReactFlowNode = {
    id: ref,
    type: 'project',
    position,
    width: size.width,
    height: size.height,
    data: widen(stableData(ctx.prevNodeById, ref, nextData)),
  };
  return stableNode(ctx.prevNodeById, ref, next);
}

/** One zone's fully-computed layout, BEFORE its own (absolute) position is
 *  known — every input this needs (children/bbox/size) is independent of
 *  where the zone itself ends up, since children are positioned zone-
 *  RELATIVE (spec §6, `extent: 'parent'`). Splitting "compute a zone's
 *  size" from "place the zone" (spec CRITICAL 1) is what makes real
 *  collision-free packing possible: the packer below needs every zone's
 *  REAL width/height up front, not a guessed constant. */
export interface ZoneLayoutResult {
  zone: ZoneInput;
  projectRef: NodeRef;
  isCollapsed: boolean;
  counts: ProjectNodeCounts;
  placed: Array<ChildCandidate & { position: { x: number; y: number } }>;
  size: { width: number; height: number };
  /** True when `ctx.positions` already has a stored (user-dragged) entry
   *  for this zone's own ref — that position is NEVER touched by the
   *  auto-pack pass below (spec CRITICAL 1 hard requirement, same rule
   *  `assignChildPositions` already enforces for children). */
  hasPersistedPosition: boolean;
  /** R10 (persisted-position declutter) — every child ref whose PERSISTED
   *  position was corrected this pass (a pinned x pinned overlap resolved),
   *  mapped to its new position — reconciler.ts aggregates this across every
   *  zone into `ReconcileResult.declutteredPositions`, which the caller
   *  (useCanvasFlowGraph.ts) persists back into canvasStore so the
   *  correction becomes the new (non-colliding) truth, not something
   *  re-discovered and re-resolved on every single reconcile. Empty when
   *  nothing needed decluttering this pass (the overwhelming common case).
   *
   *  Preview-surface-correctness fix — ALSO includes a terminal/preview
   *  surface's FINAL position the very FIRST time `tetherFreshSurfacesToOwner`
   *  tethers it next to its owner (see that function's own doc comment): not
   *  a second concept, just the same "computed once this pass, persist it so
   *  it never needs re-discovering" contract every other entry here already
   *  has — a surface's first-ever computed spot is exactly as much "the new
   *  truth to remember" as a resolved pinned-x-pinned overlap is. */
  declutteredPositions: Record<NodeRef, { x: number; y: number }>;
}

export function computeZoneLayout(zone: ZoneInput, ctx: ZoneBuildContext): ZoneLayoutResult {
  const projectRef = makeRef('project', zone.projectId);
  const isCollapsed = ctx.collapsed[zone.projectId] === true;
  const counts = computeProjectCounts(zone.missions);
  const hasPersistedPosition = ctx.positions[projectRef] !== undefined;
  const children = collectZoneChildren(zone, ctx);

  if (isCollapsed) {
    // Collapsed zone: children hidden entirely (spec §4.1), fixed chip size.
    return {
      zone,
      projectRef,
      isCollapsed,
      counts,
      placed: [],
      size: COLLAPSED_ZONE_SIZE,
      hasPersistedPosition,
      declutteredPositions: {},
    };
  }

  const rawPlacedChildren = assignChildPositions(children, ctx.positions);
  // Preview-surface-correctness fix — replaces a FRESH (never-persisted)
  // terminal/preview surface's generic grid-slot fallback with a position
  // tethered next to its real owner, when one is resolvable (see
  // tetherFreshSurfacesToOwner's own doc comment). Runs BEFORE the
  // pinned-declutter/collision passes below so a tethered surface still
  // participates in normal no-overlap resolution like any other AUTO
  // (non-pinned) child — `tetheredRefs` is only used at the very end of this
  // function, to persist the FINAL (post-collision) position.
  const { children: tetheredChildren, tetheredRefs } = tetherFreshSurfacesToOwner(rawPlacedChildren, ctx);
  // fix/canvas-ux R4a — PASS 1 of the no-overlap invariant (David's rule:
  // zones are unbounded, so two rendered siblings overlapping is never
  // acceptable). `assignChildPositions`' own grid-slot COUNTER only counts
  // HOW MANY siblings are pinned, never checks WHERE those pinned positions
  // actually are — a pinned position can coincide with the exact pixel a
  // brand-new auto child's counter-derived slot also lands on (W10's
  // observed defect: "y:840 still collided with an auto-placed sibling").
  // `resolveCollisions` fixes this generally: any AUTO child (no stored
  // position) colliding with a PINNED sibling wherever it actually sits, or
  // with another AUTO sibling, is pushed to the nearest free slot —
  // PINNED children are never moved (isFixed = has a stored position).
  const isPinnedChild = (child: { ref: NodeRef }): boolean => ctx.positions[child.ref] !== undefined;
  // R7 — was a fixed `DEFAULT_NODE_SIZE[child.type]` lookup; now honors a
  // stored footprint override (expanded mission live-panel, resized
  // terminal/preview surface) so the no-overlap invariant below is computed
  // against what the child ACTUALLY renders at, never the smaller default.
  const sizeOfChild = (child: ChildCandidate): { width: number; height: number } => effectiveChildSize(child, ctx);

  // fix/canvas-ux R10 — PASS 0: declutter PINNED x PINNED overlaps (David's
  // rule extended — see placementCollision.ts's declutterPinnedOverlaps
  // header). Runs BEFORE PASS 1 below, which never checks a pinned child
  // against another pinned one — two persisted positions from different
  // sessions/runs landing on the same slot were never resolved at all until
  // this pass. `isPinnedChild` still reads `ctx.positions` (unchanged) after
  // this — a decluttered child stays "pinned" for PASS 1, just at its
  // corrected position, so an auto child still treats it as a fixed obstacle.
  const { children: declutteredChildren, movedRefs: declutteredRefs } = declutterPinnedChildren(
    tetheredChildren,
    isPinnedChild,
    sizeOfChild,
    ctx.sessionDraggedRefs,
  );
  const declutteredPositions: Record<NodeRef, { x: number; y: number }> = {};
  for (const child of declutteredChildren) {
    if (declutteredRefs.has(child.ref)) declutteredPositions[child.ref] = child.position;
  }

  const placedChildren = resolveCollisions(declutteredChildren, isPinnedChild, sizeOfChild);
  // W8a: expanded loops grow their zone honestly — iteration minis are
  // derived from each loop's FINAL (pass-1-resolved) position, never
  // re-resolved themselves ABOVE their own loop (their position is fixed
  // relative to the loop — a read-only projection, not a negotiable
  // placement) — but see the very next pass: they CAN still be nudged away
  // from a PINNED sibling, since nothing else is allowed to move for that.
  const rawIterationExtras = iterationExtrasFor(placedChildren, zone, ctx);

  const pinnedRects: Rect[] = placedChildren.filter(isPinnedChild).map((child) => ({ ...child.position, ...sizeOfChild(child) }));
  // fix/canvas-ux R4a — PASS 1.5: a PINNED sibling is truly immovable (spec:
  // "USER-PINNED positions are never moved"), and an iteration mini is
  // never itself pinned — so if a loop's natural "directly under the loop"
  // iteration stack happens to land on top of a pinned sibling, the mini is
  // what has to give way, never the pinned node (this is the one case PASS
  // 2 below can't fix on its own: iteration minis there are OBSTACLES for
  // other auto children, not something PASS 2 itself repositions).
  const iterationExtras = resolveCollisions(
    rawIterationExtras,
    () => false, // iteration minis are never user-pinned
    sizeOfChild,
    pinnedRects,
  );

  // fix/canvas-ux R4a — PASS 2: the (now pinned-safe) iteration minis
  // reserve REAL space (W8a's observed defect: "expanded loop iterations can
  // overlap the row below in dense grids" — a loop's iteration stack can
  // reach well past the fixed grid row height). Treating them as fixed
  // obstacles here means any AUTO sibling that would otherwise land on top
  // of them gets pushed further down/right instead — the zone is unbounded,
  // so there is always room.
  const iterationObstacles: Rect[] = iterationExtras.map((extra) => ({ ...extra.position, ...sizeOfChild(extra) }));
  const finalChildren = resolveCollisions(placedChildren, isPinnedChild, sizeOfChild, iterationObstacles);
  // iteration minis join the placed list BEFORE the bbox pass so the zone
  // tint always covers them (reconcilerFold.ts's iterationExtrasFor) — the
  // bbox growing to cover a pushed-down sibling is how the zone honestly
  // "reserves real space" for an expanded loop (spec: zones are unbounded).
  const placed = [...finalChildren, ...iterationExtras];

  // Preview-surface-correctness fix — persists every tethered surface's
  // FINAL (post-collision) position into the SAME map the caller already
  // writes back to canvasStore (see tetherFreshSurfacesToOwner's own doc
  // comment): a surface only ever needs tethering once, on the reconcile
  // where it was first created with no stored position — every subsequent
  // reconcile finds `ctx.positions[child.ref]` already set and skips
  // straight past `tetherFreshSurfacesToOwner`'s guard entirely.
  for (const ref of tetheredRefs) {
    const finalChild = placed.find((c) => c.ref === ref);
    if (finalChild) declutteredPositions[ref] = finalChild.position;
  }

  const bbox = computeBoundingBox(placed.map((c) => ({ position: c.position, size: effectiveChildSize(c, ctx) })));
  // Lane mode (spec CRITICAL 4): the zone body ALWAYS widens to fit 5 full
  // lane columns + the gutter, regardless of how few children actually
  // occupy them — an empty MERGE lane must still read as a lane. Height is
  // unaffected: laneLayout (layout.ts) already stacks each lane's own
  // content using the real per-child bbox, so the existing bbox-height math
  // stays correct as-is.
  const laneModeMinWidth = ctx.prefs.laneMode ? LANE_MODE_ZONE_WIDTH : 0;
  // fix/canvas-zone-title-clip — a THIRD width floor, alongside lane mode's:
  // this zone's own floating title (ProjectGroupNode.tsx's `canvas-zone-
  // header`) must have real room to paint its (up to `ZONE_TITLE_RESERVED_
  // NAME_CHARS`-character) name without the header's own geometric clip
  // engaging — see `zoneMinWidthForTitle`'s own doc comment for the full
  // "why" and worked math. Computed fresh on every reconcile (never gated
  // by `hasPersistedPosition` — that flag only ever governs this zone's
  // X/Y, size is always live) so an already-open zone with a persisted
  // POSITION still gets widened the next time its content changes, same as
  // any other layout constant tuned in this file.
  const titleMinWidth = zoneMinWidthForTitle(zone.name);
  // + ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT: a small bottom-of-zone
  // breathing margin (36 + 0 = 36 today — fix/canvas-title-float shrank
  // ZONE_TITLE_BAND_HEIGHT to 0, see that constant's own doc comment), on
  // top of `bbox`'s own `ZONE_PADDING` bottom pad — never a tight fit
  // against a fully-packed last row's own card edge.
  const size = bbox
    ? { width: Math.max(bbox.width, laneModeMinWidth, titleMinWidth), height: bbox.height + ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT }
    : { width: Math.max(EMPTY_ZONE_SIZE.width, laneModeMinWidth, titleMinWidth), height: EMPTY_ZONE_SIZE.height };

  return { zone, projectRef, isCollapsed, counts, placed, size, hasPersistedPosition, declutteredPositions };
}

/**
 * Shelf-packs every AUTO-placed zone (no persisted position) left-to-right,
 * wrapping into a new row after {@link packColumnsForZoneCount} (geometry.ts,
 * viewport-aspect-aware — scratch/_canvas-label-design.md §3.3.1; was a flat
 * 3-per-row) zones — using each zone's REAL computed `size` (never a guessed
 * constant) plus a fixed gap between zones (spec CRITICAL 1). Zones WITH a
 * persisted position are
 * skipped entirely (the caller uses `ctx.positions` for those, untouched) —
 * they never occupy a row/column slot here, and the packer never tries to
 * route around them either (out of scope for this fix: the property this
 * wave's test asserts is "no two AUTO-placed zones overlap EACH OTHER", not
 * "an auto-placed zone never overlaps a user-dragged one" — see this wave's
 * report for the full reasoning). Because this recomputes from scratch on
 * every `reconcile()` call (pure function, no memoization), a zone that
 * grows (new children -> bigger `size`) and would now overlap its packed
 * neighbor is automatically re-packed on the very next reconcile — no
 * separate "did anything grow" bookkeeping needed.
 *
 * fix/canvas-title-float — the ROW-TO-ROW cursor advance (wrapping into a
 * new shelf row) originally used the airtight {@link ZONE_VERTICAL_GAP}: a
 * zone's own floating title (ProjectGroupNode.tsx's `canvas-zone-header`)
 * sits ABOVE its frame's top edge, so the zone in the row above must leave
 * enough room for that title to never land on its own bottom edge — see
 * geometry.ts's `ZONE_VERTICAL_GAP` doc comment for the worked math.
 *
 * fix/canvas-fit-fill-ratio — that worst-case gap paid off ONCE per row is
 * fine; paid N-1 times across N stacked rows it inflates the whole-canvas
 * bounding box enough to force "fit" to zoom out far past what the real
 * content needs (QA repro: 8 zones, "fit" collapsing to 18% zoom / 7% fill).
 * The row-to-row advance now uses {@link zoneRowPackGap} instead —
 * scratch/_canvas-label-design.md §3.2's bounded LOD compensation
 * (chrome/lod.ts's `LOD_FLOOR_ZOOM`) shrank {@link ZONE_VERTICAL_GAP} itself
 * from an airtight-at-the-absolute-floor 456 down to 192, small enough to
 * use directly as the routine packing gap — see that function's own doc
 * comment in geometry.ts for the full rationale.
 *
 * fix/canvas-title-full-name — the SAME-ROW column advance below USED TO
 * use the plain {@link ZONE_GAP} (a title's on-screen width was, at the
 * time, clamped to its own zone's frame width, so it could never reach a
 * same-row neighbour). That clamp is now removed (the founder's rule: the
 * FULL project name, always, never truncated — see `canvas-zone-header`'s
 * own doc comment), so the title can legitimately grow past its own zone's
 * right edge — the same-row gap then used geometry.ts's `ZONE_HORIZONTAL_GAP`
 * (sized to fit a typical-MAX-length title at the canvas's absolute zoom
 * floor). `ZONE_GAP` itself is UNCHANGED (still governs only the lane-mode
 * gutter-to-first-lane-column gap, an internal concern the title never
 * reaches).
 *
 * P2-16 fix — that worst-case gap made every real multi-project canvas
 * ~4000+ flow px apart same-row (QA repro: "fit" collapsing to ~17% zoom for
 * just 2 open projects). The same-row column advance now uses {@link
 * zoneSameRowPackGap} instead: THIS zone's own real name length at a
 * practical (not absolute-floor) zoom — see that function's own doc comment
 * in geometry.ts for the full rationale/trade-off. `ZONE_HORIZONTAL_GAP`
 * itself is unchanged (still the fully-airtight bound, still consumed
 * elsewhere) — only this routine packing advance uses the smaller figure.
 */
/**
 * scratch/_canvas-label-design.md §3.3 item 5 ("Ranger"/Tidy,
 * CanvasToolbar.tsx) — the minimal shape the row-shelf packer below
 * actually needs: `packAutoPlacedZones` reduces its own richer
 * `ZoneLayoutResult[]` down to this, and `packAllZones` (the Ranger-only
 * entry point) is fed it directly by the caller (built from live
 * `CanvasReactFlowNode` 'project' nodes — see `useCanvasLayout.ts`'s
 * `tidyZones`), since the toolbar has no `ZoneLayoutResult` to hand it (that
 * type only ever exists mid-reconcile, inside `computeZoneLayout`). One
 * shared shape means one packing algorithm, never two to keep in sync.
 */
export interface ZonePackEntry {
  projectRef: NodeRef;
  name: string;
  size: { width: number; height: number };
}

interface PackRow {
  zones: ZonePackEntry[];
  width: number;
  height: number;
}

/** Groups `zones` into shelf-pack rows of at most `maxPerRow`, in order —
 *  the row-BUILDING half of the packer (widths/heights only; no Y is
 *  committed here), shared by {@link packAutoPlacedZones} and {@link
 *  packAllZones} so both stay byte-for-byte the same algorithm. */
function buildPackRows(zones: readonly ZonePackEntry[], maxPerRow: number): PackRow[] {
  const rows: PackRow[] = [];
  let current: PackRow | null = null;
  for (const zone of zones) {
    if (!current) current = { zones: [], width: 0, height: 0 };
    const gapBefore = current.zones.length > 0 ? zoneSameRowPackGap(zone.name) : 0;
    current.zones.push(zone);
    current.width += gapBefore + zone.size.width;
    current.height = Math.max(current.height, zone.size.height);
    if (current.zones.length >= maxPerRow) {
      rows.push(current);
      current = null;
    }
  }
  if (current) rows.push(current);
  return rows;
}

/** Assigns final (x, y) positions row-by-row, top to bottom — the
 *  Y-COMMITTING half of the packer, shared the same way `buildPackRows` is.
 *  `pinnedRects` is only ever non-empty for `packAutoPlacedZones`'s own
 *  caller (reconciler.ts's real pinned zones); `packAllZones` (Ranger)
 *  always passes `[]` — Ranger is the one path allowed to land ON TOP of
 *  where a pinned zone USED to be, since it's about to give that zone a
 *  brand new position too. */
function assignRowPositions(rows: readonly PackRow[], pinnedRects: readonly Rect[]): Map<NodeRef, { x: number; y: number }> {
  const packed = new Map<NodeRef, { x: number; y: number }>();
  let cursorY = 0;
  for (const row of rows) {
    cursorY = clearPinnedRowObstacles(cursorY, row.width, row.height, pinnedRects);
    let cursorX = 0;
    for (const zone of row.zones) {
      packed.set(zone.projectRef, { x: cursorX, y: cursorY });
      cursorX += zone.size.width + zoneSameRowPackGap(zone.name);
    }
    cursorY += row.height + zoneRowPackGap();
  }
  return packed;
}

/**
 * fix/canvas-auto-pack-avoid-pinned (David's round-6 real-profile finding,
 * same live click that surfaced the row-gap migration bug: even after that
 * fix, his real 8-zone profile still measured ~3771px — barely moved from
 * the original 3767.52 — because the 3 freshly-packed zones ALWAYS start
 * their own shelf-pack at (0, 0), completely independent of where his 5
 * PINNED zones happened to sit (this file's own `packAutoPlacedZones` doc
 * comment already flagged this exact gap: "packAutoPlacedZones itself
 * still never routes AROUND a pinned zone, only avoids other auto zones").
 * With the (then-fixed) 3-per-row cap, exactly 3 fresh zones landed ALL in
 * row 0 — the SAME row his 3 pinned zones already occupied at
 * y:0 — so `declutterPinnedZones`'s reactive PINNED-vs-AUTO nudge
 * (`findFreePosition`'s right-biased shelf scan) then shoves the ENTIRE
 * pinned row far enough right to clear the auto row, reproducing
 * effectively the same bloat the row-gap fix had just removed, just from
 * a different mechanism.
 *
 * Fixed at the source instead of patching the reactive nudge (a shared,
 * general-purpose utility used well beyond this one call site — widening
 * ITS blast radius is a bigger, riskier change than this function, which
 * has exactly one caller): a two-pass pack. Pass 1 groups the AUTO
 * (non-pinned) zones into rows exactly as before (same grouping, same
 * per-row width/height), fully up front, so each row's own real footprint
 * is known BEFORE any Y is committed. Pass 2 assigns each row's Y
 * top-to-bottom, skipping past any `pinnedRects` entry that would
 * overlap that row's own `[0, row.width] x [cursorY, cursorY+row.height]`
 * candidate slot — so a fresh row is never even OFFERED a Y that a pinned
 * zone already occupies, and the reactive declutter nudge downstream never
 * has anything to resolve for this pairing in the first place.
 */
export function packAutoPlacedZones(
  results: readonly ZoneLayoutResult[],
  pinnedRects: readonly Rect[] = [],
): Map<NodeRef, { x: number; y: number }> {
  // scratch/_canvas-label-design.md §3.3.1 — viewport-aspect-aware column
  // count (geometry.ts's `packColumnsForZoneCount`) replaces the old
  // hardcoded "3 per row": computed once, up front, from how many zones
  // this call will actually pack (the AUTO/unpinned subset — a pinned zone
  // never occupies a row slot here, same as before), so 8 zones pack 4+4
  // instead of 3+3+2.
  const autoResults = results.filter((r) => !r.hasPersistedPosition);
  const maxPerRow = packColumnsForZoneCount(autoResults.length);
  const packable: ZonePackEntry[] = autoResults.map((r) => ({ projectRef: r.projectRef, name: r.zone.name, size: r.size }));
  const rows = buildPackRows(packable, maxPerRow);
  return assignRowPositions(rows, pinnedRects);
}

/**
 * scratch/_canvas-label-design.md §3.3 item 5 — "Ranger"/Tidy
 * (CanvasToolbar.tsx's `onTidyZones`, `useCanvasLayout.ts`'s `tidyZones`).
 * Re-packs EVERY zone from scratch, INCLUDING ones with a persisted (pinned)
 * position — the one deliberate exception to "a persisted position is never
 * touched automatically" the rest of this file (and `packAutoPlacedZones`
 * above) otherwise enforces everywhere. Safe here specifically because this
 * is never called from `reconcile()`/any automatic pass — its only caller is
 * a real, explicit, user-triggered toolbar click, and every position it
 * writes lands in `canvasStore.positions`, which zundo tracks in undo/redo
 * history (`canvasStore.ts`'s `partializeCanvasState`) — a misfire is one
 * Ctrl+Z away, same guarantee every other position-mutating action already
 * has (`layout.ts`'s `layoutAll`/"Auto-layout", `resolveCollisions`'s own
 * declutter passes).
 *
 * Reuses the EXACT same row-shelf algorithm {@link packAutoPlacedZones}
 * uses ({@link buildPackRows}/{@link assignRowPositions}, viewport-aspect
 * column count) — never a second packing algorithm to keep in sync — just
 * over the FULL zone list with no `pinnedRects` to avoid (there is nothing
 * left pinned once this returns: every zone gets a fresh position).
 *
 * Deliberately does NOT touch any CHILD position: zone children are
 * zone-RELATIVE (`extent: 'parent'`), so moving a zone's own (x, y) carries
 * every child along for free. This is what makes Ranger the LIGHTER of the
 * canvas's two "clean everything up" actions — unlike the pre-existing,
 * heavier "Auto-layout"/Ctrl+L (`layout.ts`'s `layoutAll`), which ALSO
 * re-lays-out every zone's children via elkjs — Ranger only ever moves zone
 * BOXES, so it never disturbs a manually-arranged mission layout inside a
 * zone. That is also why it can run synchronously (no elkjs, no `await`),
 * unlike `layoutAll`.
 */
export function packAllZones(zones: readonly ZonePackEntry[]): Map<NodeRef, { x: number; y: number }> {
  const maxPerRow = packColumnsForZoneCount(zones.length);
  const rows = buildPackRows(zones, maxPerRow);
  return assignRowPositions(rows, []);
}

/** Advances `startY` past any `pinnedRects` entry whose own rect would
 *  overlap a `width` x `height` candidate slot at `(0, startY)` — same
 *  "keep advancing until clear" idiom as `placementCollision.ts`'s own
 *  `findFreePosition`, Y-only (a fresh auto-pack row always starts at
 *  x:0, so only the vertical axis ever needs resolving here). Bounded to
 *  one skip per pinned rect at most — a real profile carries a small,
 *  bounded number of pinned zones, so this always terminates well short
 *  of the guard. */
function clearPinnedRowObstacles(startY: number, width: number, height: number, pinnedRects: readonly Rect[]): number {
  let y = startY;
  for (let guard = 0; guard <= pinnedRects.length; guard += 1) {
    const collision = pinnedRects.find((rect) => rectsOverlap({ x: 0, y, width, height }, rect));
    if (!collision) return y;
    y = collision.y + collision.height + zoneRowPackGap();
  }
  return y;
}

// ── P2-16 legacy same-row gap migration ───────────────────────────────
// See `migrateBloatedZoneRowPositions`'s own doc comment for the full why —
// short version: a PINNED zone position is never revisited by
// `packAutoPlacedZones` above once persisted, so existing layout.json data
// saved under the OLD (oversized) same-row gap formula would otherwise stay
// stuck at that spacing forever, even after the formula itself is fixed for
// NEW zones going forward.

/** Y-tolerance for grouping PERSISTED zone positions into the same packing
 *  "row" — a same-row shelf-pack advance (`packAutoPlacedZones`'s own loop)
 *  always gives every zone in one row the EXACT same Y; a small tolerance
 *  only absorbs incidental float noise, never merges two genuinely different
 *  rows (whose Y differs by at least a zone's own height plus
 *  `ZONE_VERTICAL_GAP` — hundreds of px, see that constant). */
const LEGACY_ROW_Y_TOLERANCE = 8;

/** How many times bigger than today's practical same-row gap
 *  (`zoneSameRowPackGap` — the SAME "sane envelope relative to a freshly
 *  packed layout" a brand new zone is packed against) an ACTUAL persisted
 *  gap has to be before it is treated as a legacy artifact of an OLDER,
 *  since-tightened formula generation rather than trusted as a deliberate
 *  manual drag — self-healing: this is re-evaluated on every reconcile
 *  against WHATEVER `zoneSameRowPackGap` computes today, so a future
 *  formula tightening keeps unwinding older profiles automatically,
 *  without this migration needing another manual re-tune. Combined with
 *  {@link LEGACY_ROW_GAP_ABSOLUTE_FLOOR} below (both must hold) so a
 *  short-named zone with a modest, genuinely manual gap is never mistaken
 *  for legacy bloat. */
const LEGACY_ROW_GAP_BLOAT_FACTOR = 3;

/**
 * fix/canvas-legacy-row-migration-envelope (David's round-6 report, read
 * DIRECTLY from his own profile's `canvas/layout.json` rather than
 * inferred — his own instruction: "read the real persisted data ... the
 * mismatch will be obvious once both are in front of you"): this migration
 * NEVER fired on his real, months-old profile. Root cause found in the
 * data itself — a real pinned row `["Lazy" x:718, "lazy-backoffice"
 * x:2607.6, "LazySite-internet" x:3253.52]` (y:0, the exact row driving
 * the live 3767.52px bounds) has an actual "Lazy" -> "lazy-backoffice" gap
 * of ~1543.6 flow px against a `zoneSameRowPackGap('Lazy')` of only
 * ~345.9 — a ~4.5x overspend, unmistakable legacy bloat by the SAME
 * {@link LEGACY_ROW_GAP_BLOAT_FACTOR} multiplier already in this file —
 * yet silently passed through, because the OLD floor here (2000) was
 * tuned against a DIFFERENT, more extreme legacy generation (the flat,
 * pre-P2-16 `ZONE_HORIZONTAL_GAP`, 4048+) and happened to sit ABOVE this
 * profile's own, less extreme (but still very real) bloat from an
 * intermediate formula generation in between. A hardcoded floor tuned to
 * one known-bad generation's output range can never be trusted to bound
 * every OTHER generation a multi-month-old profile might carry — exactly
 * David's own framing: "if a persisted zone position would place a zone
 * outside a sane envelope relative to a freshly packed layout, it should
 * be re-packed rather than trusted."
 *
 * scratch/_canvas-label-design.md §3.1/§3.3 — RAISED 300 -> 900 (the inverse
 * direction of this constant's own prior history): `zoneSameRowPackGap`
 * itself changed shape in that design pass — geometric containment
 * (`ProjectGroupNode.tsx`'s round-2 `maxWidth`+`overflow:hidden` clamp) made
 * a title-vs-neighbour collision impossible BY CONSTRUCTION regardless of
 * gap size, so the same-row packing gap collapsed from a name-length-
 * proportional ~300-500px figure down to one small flat constant
 * (`ZONE_PACK_HORIZONTAL_GAP_FLOW_PX`, 64). {@link LEGACY_ROW_GAP_BLOAT_FACTOR}'s
 * multiplier against that now-tiny `practicalGap` (64*3=192) would make this
 * floor the ONLY thing standing between "self-healing bloat detector" and
 * "silently yanks any zone a user manually spaced more than 192px from its
 * neighbour" — the opposite of scratch/_canvas-label-design.md's own explicit
 * direction ("Aucune migration silencieuse de positions: « Ranger » remplace
 * la stratégie des migrations"). Raised so this migration keeps catching the
 * SAME real, documented bloat it was built for (David's own profile: a
 * ~1543.6px "Lazy" -> "lazy-backoffice" gap, comfortably above 900) while no
 * longer silently recompacting an ordinary ~400-800px manual arrangement
 * that was never actually broken — that residual is what "Ranger" (the
 * explicit, undoable auto-layout command) is for now, not a background
 * migration on every reconcile.
 */
const LEGACY_ROW_GAP_ABSOLUTE_FLOOR = 900;

interface PinnedZoneRowEntry {
  ref: NodeRef;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function groupPinnedZonesIntoRows(entries: readonly PinnedZoneRowEntry[]): PinnedZoneRowEntry[][] {
  const rows: PinnedZoneRowEntry[][] = [];
  for (const entry of entries) {
    const row = rows.find((candidate) => Math.abs(candidate[0]!.y - entry.y) <= LEGACY_ROW_Y_TOLERANCE);
    if (row) row.push(entry);
    else rows.push([entry]);
  }
  return rows;
}

/**
 * P2-16 (QA repro, screenshot 002-010-projects-open.png: two projects ~10 000
 * flow px apart, "fit" collapsing to ~17% zoom) — migrates PERSISTED (pinned)
 * zone x-positions that were computed by a past reconcile() under the OLD,
 * oversized same-row gap formula. A pinned zone's own position is otherwise
 * NEVER revisited once persisted (`packAutoPlacedZones`'s own doc comment:
 * "the packer never tries to route around them either") — without this
 * migration, existing layout.json data stays stuck at the old (now-fixed-
 * for-NEW-zones) spacing forever.
 *
 * Detection: groups PINNED zones sharing (near-)identical Y — the unmistakable
 * signature of a same-row shelf-pack advance (a real manual drag essentially
 * never lands there by coincidence) — sorts each group left-to-right, and
 * re-tightens any gap that is BOTH more than {@link LEGACY_ROW_GAP_BLOAT_FACTOR}
 * times today's practical same-row gap (`zoneSameRowPackGap`, sized off THIS
 * zone's own real name) AND past the {@link LEGACY_ROW_GAP_ABSOLUTE_FLOOR}
 * absolute floor, down to exactly that practical gap. A gap already within a
 * sane multiple of the practical figure — or simply not that large in
 * absolute terms — is left completely untouched: this only corrects
 * unmistakable bloat, never a deliberate (even generous) manual arrangement,
 * and it never touches an already-OVERLAPPING pair (a negative "gap") either
 * — that case stays `declutterPinnedZones`'s job, run separately.
 *
 * fix/canvas-legacy-row-migration-envelope (David's round-6 report, root-
 * caused against his own real `canvas/layout.json`, not a synthesised
 * fixture — see {@link LEGACY_ROW_GAP_ABSOLUTE_FLOOR}'s own doc comment for
 * the exact real gap this migration was silently missing) — self-healing:
 * every check here compares an ACTUAL persisted gap against
 * `zoneSameRowPackGap` evaluated FRESH, right now, for THIS zone's real
 * name — never a value captured or cached from whenever the position was
 * first saved. A user who has been running this app for months, across
 * many since-tightened packing-formula generations, self-heals to whatever
 * TODAY's formula considers sane on their very next launch, with no manual
 * reset or one-time migration script required.
 *
 * Idempotent by an EXPLICIT cross-row safety check, not merely by
 * construction (round 2 of this same fix — reconcilerConvergence.test.ts's
 * own 150-seed fuzz property caught the gap directly, seed 69): naively
 * moving a gap to exactly `zoneSameRowPackGap` is only safe when nothing
 * ELSE occupies that space — this function only ever reasons WITHIN one
 * Y-grouped row, so a correction that's perfectly safe for its OWN row can
 * still land the compacted zone on top of an entirely unrelated zone from
 * a DIFFERENT row. Left unguarded, `declutterPinnedZones` (full cross-zone
 * awareness, runs immediately after) would shove it back out via its own
 * WIDTH-based nudge — landing at a position THIS function would flag as
 * "bloated" again on the very next pass (the nudge distance is sized off
 * the colliding zone's own width, unrelated to either zone's name-based
 * practical gap), an unmistakable ping-pong that never reaches an empty
 * declutter patch. Each row's own corrections are therefore validated as a
 * whole against every OTHER pinned zone's rect before being trusted — see
 * the main loop's own comment below for exactly how.
 *
 * Returns a position PATCH (only the zones actually moved) — the caller
 * (reconciler.ts) feeds this into the SAME `declutteredPositions` persistence
 * path the existing pinned-position declutter passes already use, so the
 * correction becomes the new (compact) truth on the very next save, not
 * something re-discovered every reconcile.
 */
export function migrateBloatedZoneRowPositions(
  zoneLayouts: readonly ZoneLayoutResult[],
  positions: Record<NodeRef, { x: number; y: number }>,
): Record<NodeRef, { x: number; y: number }> {
  const pinnedEntries: PinnedZoneRowEntry[] = [];
  for (const result of zoneLayouts) {
    if (!result.hasPersistedPosition) continue;
    const position = positions[result.projectRef];
    if (!position) continue; // defensive: hasPersistedPosition implies this exists
    pinnedEntries.push({
      ref: result.projectRef,
      name: result.zone.name,
      x: position.x,
      y: position.y,
      width: result.size.width,
      height: result.size.height,
    });
  }
  if (pinnedEntries.length < 2) return {};

  const corrections: Record<NodeRef, { x: number; y: number }> = {};
  for (const row of groupPinnedZonesIntoRows(pinnedEntries)) {
    if (row.length < 2) continue;
    const sorted = [...row].sort((a, b) => a.x - b.x);
    let originalRightEdge = sorted[0]!.x + sorted[0]!.width;
    // Total leftward correction applied so far, propagated forward to every
    // zone after the bloated pair that introduced it — see the loop's own
    // comment below for the full "why cascading, not per-pair-isolated" story.
    let cumulativeShift = 0;
    const rowCorrections: Record<NodeRef, { x: number; y: number }> = {};
    for (let i = 1; i < sorted.length; i += 1) {
      const entry = sorted[i]!;
      const practicalGap = zoneSameRowPackGap(entry.name);
      // fix/canvas-legacy-row-migration-envelope (David's round-6 real-profile
      // finding: a row can carry bloat in only ONE internal gap — "Lazy" ->
      // "lazy-backoffice" was ~4.5x over, but "lazy-backoffice" ->
      // "LazySite-internet" was already tight) — `actualGap` is always
      // measured against THIS pair's own UNTOUCHED historical right edge
      // (`originalRightEdge`, never the already-compacted one), so a pair
      // that was never independently bloated is never flagged just because
      // an EARLIER pair in the same row was. Once a shift IS found, though,
      // it must propagate to every zone after it — otherwise compacting only
      // the bloated pair leaves a brand-new, equally large gap on its OTHER
      // side (the very next zone kept its own original absolute x, now far
      // from its freshly-moved neighbour), so the row's overall width would
      // never actually shrink even though one gap looked "fixed" — exactly
      // why the very first version of this fix (a per-pair `compactedRightEdge`
      // reset, discarding the running shift) left `LazySite-internet` at its
      // original x and the row's own bounds unchanged in this profile's real
      // data. `cumulativeShift` instead applies the SAME leftward correction
      // to every zone from the bloated one onward, preserving each
      // downstream pair's own EXACT original relative gap to its neighbour
      // (a real, if incidental, arrangement — never itself flagged as
      // bloat) while still collapsing the row's overall span by exactly the
      // bloat actually found.
      const actualGap = entry.x - originalRightEdge;
      const bloatThreshold = Math.max(practicalGap * LEGACY_ROW_GAP_BLOAT_FACTOR, LEGACY_ROW_GAP_ABSOLUTE_FLOOR);
      if (actualGap > bloatThreshold) {
        cumulativeShift += actualGap - practicalGap;
      }
      if (cumulativeShift > 0) {
        rowCorrections[entry.ref] = { x: entry.x - cumulativeShift, y: entry.y };
      }
      originalRightEdge = entry.x + entry.width;
    }

    // fix/canvas-legacy-row-migration-envelope round 2
    // (reconcilerConvergence.test.ts's own 150-seed fuzz property caught
    // this directly, seed 69: a row's OWN internal gap was correctly
    // identified as bloated and shrunk to `zoneSameRowPackGap` — but this
    // function only ever reasons WITHIN one Y-grouped row, so it had no way
    // to know that shrinking THIS gap would land the compacted zone
    // directly on top of an entirely unrelated zone from a DIFFERENT row.
    // `declutterPinnedZones` (which runs immediately after, with full
    // cross-zone awareness) then had to shove it back out of the way via
    // its own width-based nudge — a NEW position this function would
    // itself see as "bloated" again on the very next pass, since the nudge
    // distance is sized off the colliding zone's own WIDTH, unrelated to
    // either zone's NAME-based practical gap. That is the exact ping-pong
    // the fuzz property measured (never reaching an empty declutter patch).
    // The fix: this function must never be the one to INTRODUCE a new
    // overlap in the first place. Validated whole-ROW, not per-entry — the
    // cascading shift ties every entry in a row to the SAME cumulative
    // correction, so reverting just ONE entry while keeping its neighbours'
    // (computed assuming that entry also moved) would leave the row
    // internally inconsistent, risking a collision WITHIN the row that
    // didn't exist before. If ANY entry's corrected rect would collide with
    // an outside zone, this whole row's corrections are dropped for this
    // pass — conservative (defers the compaction rather than risking an
    // unsafe partial one), never unsafe. Checked against every OTHER
    // pinned entry's own FINAL rect (another row's correction this same
    // pass if it has one, else its untouched original) so two rows
    // correcting toward each other in one call are also caught.
    const rowIsSafe = Object.entries(rowCorrections).every(([ref, correctedPosition]) => {
      const entry = row.find((candidate) => candidate.ref === ref)!;
      const correctedRect = { ...correctedPosition, width: entry.width, height: entry.height };
      return !pinnedEntries.some((other) => {
        if (other.ref === ref || row.some((candidate) => candidate.ref === other.ref)) return false;
        const otherFinal = corrections[other.ref];
        const otherRect = { x: otherFinal?.x ?? other.x, y: otherFinal?.y ?? other.y, width: other.width, height: other.height };
        return rectsOverlap(correctedRect, otherRect);
      });
    });
    if (rowIsSafe) Object.assign(corrections, rowCorrections);
  }
  return corrections;
}

/**
 * fix/persisted-positions-declutter — declutters PINNED x PINNED ZONE-vs-ZONE
 * overlap. Two projects can each carry their OWN persisted (user-dragged, or
 * remembered-from-a-prior-session) position and still collide once a zone's
 * REAL bounding box (this file's own `computeZoneLayout`, sized off
 * geometry.ts's FULL_CARD_WIDTH/FULL_CARD_MAX_HEIGHT) grows bigger than it
 * was when that position was last saved — e.g. positions recorded back when
 * children rendered at a smaller LOD tier (chip/dot), before full cards were
 * the only tier (see this wave's report). `packAutoPlacedZones` above never
 * even looks at a pinned zone (its own doc comment: "the packer never tries
 * to route around them either") — this is the ONE place two PINNED zones
 * are ever checked against each other.
 *
 * Mirrors `declutterPinnedChildren`'s per-zone CHILD pass exactly, one
 * granularity up: same winner rule (session-dragged > recency > original
 * array order — placementCollision.ts's `declutterOrder`), same
 * minimum-displacement nudge (`findFreePosition`'s nearest-free-shelf-slot
 * idiom, same as every other placement in this codebase), same one
 * documented exception (two session-dragged zones colliding with each other
 * are left overlapping — both are the user's own doing this session, see
 * placementCollision.ts's module header). David's invariant, extended one
 * more level: never leave two cards overlapped, even pinned ones, even
 * across a project boundary — a project zone is not a suspension of the
 * no-overlap rule, just a different granularity of it. A no-op (empty
 * result) whenever fewer than two zones are pinned — the common case.
 *
 * `otherObstacles` lets the caller (reconciler.ts) additionally seed every
 * AUTO-packed zone's already-resolved rect, so a decluttered pinned zone is
 * nudged clear of those too — reusing `declutterPinnedOverlaps`'s existing
 * obstacle-seeding parameter rather than inventing a second mechanism. (A
 * decluttered pinned zone landing back on top of an auto-packed one is a
 * known follow-up gap otherwise — `packAutoPlacedZones` itself still never
 * routes AROUND a pinned zone, only avoids other auto zones.)
 *
 * fix/canvas-title-float — KNOWN RESIDUAL GAP (documented, not fixed here,
 * same "v1 honest scope" convention as the paragraph above): the rects fed
 * into `declutterPinnedOverlaps` below are each zone's own bare `result.size`
 * — they do NOT inflate upward by the floating title's own worst-case
 * footprint (geometry.ts's `ZONE_TITLE_MAX_FLOW_HEIGHT` +
 * `ZONE_TITLE_GAP_ABOVE`) the way `ZONE_VERTICAL_GAP` does for the AUTO-pack
 * path (`packAutoPlacedZones`). Two PINNED (user-dragged) zones close enough
 * together vertically can therefore still end up with zone B's floating
 * title overlapping zone A's bottom edge, even though their own bare boxes
 * don't overlap — the case this function DOES still correctly resolve.
 * Closing this fully would mean inflating each candidate's rect for the
 * overlap CHECK only, then deflating a mover's resolved position back before
 * returning it (the winner/untouched path already returns the real
 * position verbatim) — deferred as a follow-up: the common path (freshly
 * placed/auto-packed zones) is fully covered by `ZONE_VERTICAL_GAP` above;
 * this residual only applies once a user has manually dragged BOTH zones
 * into a tight vertical arrangement.
 */
export function declutterPinnedZones(
  results: readonly ZoneLayoutResult[],
  positions: Record<NodeRef, { x: number; y: number }>,
  sessionDraggedRefs: ReadonlySet<NodeRef>,
  otherObstacles: readonly Rect[] = [],
): { positions: ReadonlyMap<NodeRef, { x: number; y: number }>; movedRefs: ReadonlySet<NodeRef> } {
  const pinned = results.filter((result) => result.hasPersistedPosition);
  if (pinned.length < 2) return { positions: new Map(), movedRefs: new Set() };

  const candidates: PinnedCandidate[] = pinned.map((result) => ({
    ref: result.projectRef,
    position: positions[result.projectRef]!,
    size: result.size,
    recencyMs: recencyOfZone(result.zone),
    immovable: sessionDraggedRefs.has(result.projectRef),
  }));

  const { items: resolved, movedRefs } = declutterPinnedOverlaps(candidates, otherObstacles);
  const positionByRef = new Map(resolved.map((item) => [item.ref, item.position] as const));
  return { positions: positionByRef, movedRefs };
}

/**
 * W-CLOSE row 2 — builds this zone's frame nodes, entirely OUTSIDE the
 * ChildCandidate/collision-resolution pipeline above (deliberate: a frame
 * never affects zone bbox sizing, never participates in no-overlap
 * collision resolution, and is never nudged by the declutter pass — see
 * canvasTypes.ts's FrameSpec header, "v1 honest scope"). Position comes
 * straight from `ctx.positions` (zone-relative, same convention as every
 * child) — a frame is always explicitly positioned at creation time
 * (CanvasContextMenu.tsx's `frameSelection`/`addFrameAt`), so the fallback
 * below is defensive only (a hand-edited layout.json missing an entry).
 * `zIndex: -1` is what actually renders it BEHIND every sibling (calculateZ
 * in @xyflow/system: `node.zIndex ?? 0`, plus elevation on select — a
 * negative value is guaranteed below every other node's 0-or-higher default
 * regardless of array order), not the emission order itself.
 */
function buildFrameNodes(zone: ZoneInput, projectRef: NodeRef, ctx: ZoneBuildContext): CanvasReactFlowNode[] {
  return zone.frames.map((frame) => {
    const ref = makeRef('frame', frame.id);
    const position = ctx.positions[ref] ?? { x: ZONE_PADDING, y: ZONE_HEADER_HEIGHT };
    const data = widen(stableData(ctx.prevNodeById, ref, frame));
    const next = {
      id: ref,
      type: 'frame',
      position,
      parentId: projectRef,
      extent: 'parent',
      width: frame.width,
      height: frame.height,
      zIndex: -1,
      data,
    } as CanvasReactFlowNode;
    return stableNode(ctx.prevNodeById, ref, next);
  });
}

/** Emits one already-laid-out zone's group node + children into `out`,
 *  every rendered id recorded into `out.renderedIds` for the edge-building
 *  pass (tombstone detection). `position` is the FINAL (absolute) position
 *  the caller resolved (persisted verbatim, or this reconcile's pack). */
export function emitZone(
  result: ZoneLayoutResult,
  position: { x: number; y: number },
  ctx: ZoneBuildContext,
  out: { nodes: CanvasReactFlowNode[]; renderedIds: Set<string> },
): void {
  const { zone, projectRef, isCollapsed, counts, placed, size } = result;

  if (isCollapsed) {
    out.nodes.push(buildProjectNode(zone, projectRef, position, size, true, counts, false, ctx.prefs.laneMode, ctx));
    out.renderedIds.add(projectRef);
    return;
  }

  // React Flow requires a parent node to appear BEFORE its children in the
  // `nodes` array it's given (W2a fix — was: children pushed first, project
  // node pushed last, which tripped RF's "Parent node not found" warning and
  // could misplace children on first paint; CanvasView.tsx's
  // orderParentsFirst() was added in W1c as a downstream workaround and is
  // now a no-op invariant guard, kept cheap on purpose rather than removed).
  out.nodes.push(buildProjectNode(zone, projectRef, position, size, false, counts, placed.length > 0, ctx.prefs.laneMode, ctx));
  out.renderedIds.add(projectRef);

  // W-CLOSE row 2 — frames next (their negative zIndex is what actually
  // renders them behind every child below, not this emission order — see
  // buildFrameNodes's own doc comment).
  for (const frameNode of buildFrameNodes(zone, projectRef, ctx)) {
    out.nodes.push(frameNode);
    out.renderedIds.add(frameNode.id);
  }

  for (const child of placed) {
    const node = buildChildNode(child, projectRef, ctx);
    out.nodes.push(node);
    out.renderedIds.add(node.id);
  }
}
