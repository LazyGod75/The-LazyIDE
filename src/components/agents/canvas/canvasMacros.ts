/* canvasMacros.ts — pure capture/instantiate transforms for group macros
   (Langflow parity, MIT-inspired, reimplemented). No React, no store: the
   UI (CanvasContextMenu.tsx's "Enregistrer comme macro", CanvasPalette.tsx's
   Macros section via useCanvasDnd.ts) and the manager executor
   (agentsStore.tsx's save_macro/instantiate_macro cases) both call these
   same two functions with plain data and get back plain data — one real
   implementation, never a duplicated ad-hoc transform per caller.

   Capture is deliberately "pending-only": a macro freezes drafts/routers/
   notes (canvas-owned facts with no independent lifecycle) plus the chains
   directly wiring them together — a mission/loop is LIVE fleet state (spec's
   own multi-select rule: "missions excluded, they're live state") and is
   never captured, so a saved macro is always safe to instantiate any number
   of times without ever re-triggering something that already ran.

   Instantiate always mints brand-new ids (never reuses the template's own
   captured ids, which would collide with a second instantiation of the SAME
   macro) and places the fresh copies collision-safe via the SAME shared
   placement primitive (placementCollision.ts's `findFreePosition`) every
   other interactive creation path in this codebase already funnels through.
*/

import {
  makeRef,
  parseRef,
  parseRouterBranchRef,
  type Chain,
  type DraftSpec,
  type MacroSpec,
  type NodeRef,
  type NoteData,
  type RouterSpec,
} from './canvasTypes';
import { generateCanvasId } from './canvasIds';
import type { FlowPoint } from './canvasPlacement';
import { findFreePosition, type Rect, type Size } from './placementCollision';
import { DEFAULT_NODE_SIZE, ROUTER_NODE_SIZE, type CanvasReactFlowNode } from './reconciler';

// ── Capture ────────────────────────────────────────────────────────────

export interface CaptureMacroSource {
  drafts: readonly DraftSpec[];
  routers: readonly RouterSpec[];
  notes: readonly NoteData[];
  chains: readonly Chain[];
  /** Same coordinate space as canvasStore's own `positions` record — zone-
   *  relative for a selection entirely inside one project zone, absolute
   *  for a Transverse-only selection. A macro captured from a MIXED-zone
   *  selection is not specially normalized (an accepted, documented
   *  limitation — the common gesture is selecting siblings inside one
   *  zone, or several Transverse nodes together, never a cross-zone mix). */
  positions: Readonly<Record<NodeRef, FlowPoint>>;
}

/** Filters `selectedRefs` down to the pending-only subgraph (draft/router/
 *  note kinds only — see this module's header) — exported so callers that
 *  need to know the count BEFORE opening a naming prompt (e.g. to gate a
 *  context-menu entry's visibility) can reuse the exact same rule. */
export function pendingOnlyRefs(selectedRefs: readonly NodeRef[]): NodeRef[] {
  return selectedRefs.filter((ref) => {
    const parsed = parseRef(ref);
    return parsed !== null && (parsed.kind === 'draft' || parsed.kind === 'router' || parsed.kind === 'note');
  });
}

/**
 * Captures a {@link MacroSpec} from the current live canvas facts + a
 * multi-selection of refs. Non-pending refs (missions, loops, projects,
 * schedules, surfaces…) are silently dropped rather than rejected outright
 * — the caller (context menu) is expected to have already filtered the
 * selection for gating purposes via {@link pendingOnlyRefs}, but this
 * function degrades honestly even if it hasn't.
 */
export function captureMacro(
  source: CaptureMacroSource,
  selectedRefs: readonly NodeRef[],
  name: string,
  description: string | undefined,
  idFactory: (prefix: string) => string = generateCanvasId,
): MacroSpec {
  const pendingRefs = pendingOnlyRefs(selectedRefs);
  const refSet = new Set(pendingRefs);

  const drafts = source.drafts.filter((d) => refSet.has(makeRef('draft', d.id)));
  const routers = source.routers.filter((r) => refSet.has(makeRef('router', r.id)));
  const notes = source.notes.filter((n) => refSet.has(makeRef('note', n.id)));

  function refIsCaptured(ref: NodeRef): boolean {
    if (refSet.has(ref)) return true;
    const branch = parseRouterBranchRef(ref);
    return branch !== null && refSet.has(makeRef('router', branch.routerId));
  }
  const chains = source.chains.filter((c) => refIsCaptured(c.sourceRef) && refIsCaptured(c.targetRef));

  const knownPositions = pendingRefs
    .map((ref) => ({ ref, pos: source.positions[ref] }))
    .filter((entry): entry is { ref: NodeRef; pos: FlowPoint } => entry.pos !== undefined);
  const minX = knownPositions.length > 0 ? Math.min(...knownPositions.map((e) => e.pos.x)) : 0;
  const minY = knownPositions.length > 0 ? Math.min(...knownPositions.map((e) => e.pos.y)) : 0;
  const positions: Record<NodeRef, FlowPoint> = {};
  for (const { ref, pos } of knownPositions) {
    positions[ref] = { x: pos.x - minX, y: pos.y - minY };
  }

  return {
    id: idFactory('macro'),
    name,
    description,
    drafts,
    routers,
    notes,
    chains,
    positions,
    createdAtMs: Date.now(),
  };
}

// ── Instantiate ────────────────────────────────────────────────────────

export interface InstantiateMacroResult {
  drafts: DraftSpec[];
  routers: RouterSpec[];
  notes: NoteData[];
  chains: Chain[];
  positions: Record<NodeRef, FlowPoint>;
}

function sizeForKind(kind: 'draft' | 'router' | 'note'): Size {
  if (kind === 'router') return ROUTER_NODE_SIZE;
  if (kind === 'note') return DEFAULT_NODE_SIZE.note;
  return DEFAULT_NODE_SIZE.draft;
}

/**
 * Instantiates a fresh, independent copy of `macro` at `dropPoint` (same
 * coordinate space as `occupied` — zone-relative when targeting a project
 * zone, absolute for Transverse; the caller resolves that via the same
 * `placeInZoneOrTransverse` zone hit-test every other creation path uses).
 * Every draft/router/note gets a brand-new id; every internal chain is
 * remapped onto those new ids (a chain whose endpoint fails to remap —
 * should never happen for a well-formed macro captured by this same
 * module — is dropped rather than left dangling). Placement is
 * collision-safe: each item's relative offset from `macro.positions` is
 * applied to `dropPoint`, then resolved via {@link findFreePosition}
 * against a GROWING obstacle set seeded with `occupied` — so instantiated
 * siblings never overlap each other or anything already on the canvas
 * (David's no-overlap invariant, placementCollision.ts's own header).
 */
export function instantiateMacro(
  macro: MacroSpec,
  dropPoint: FlowPoint,
  projectId: string | undefined,
  occupied: readonly Rect[],
  idFactory: (prefix: string) => string = generateCanvasId,
): InstantiateMacroResult {
  const draftIdMap = new Map(macro.drafts.map((d) => [d.id, idFactory('draft')]));
  const routerIdMap = new Map(macro.routers.map((r) => [r.id, idFactory('router')]));
  const noteIdMap = new Map(macro.notes.map((n) => [n.id, idFactory('note')]));

  function remapRef(ref: NodeRef): NodeRef | null {
    const parsed = parseRef(ref);
    if (!parsed) return null;
    if (parsed.kind === 'draft') {
      const newId = draftIdMap.get(parsed.id);
      return newId ? makeRef('draft', newId) : null;
    }
    if (parsed.kind === 'note') {
      const newId = noteIdMap.get(parsed.id);
      return newId ? makeRef('note', newId) : null;
    }
    if (parsed.kind === 'router') {
      const branch = parseRouterBranchRef(ref);
      const routerId = branch ? branch.routerId : parsed.id;
      const newRouterId = routerIdMap.get(routerId);
      if (!newRouterId) return null;
      return branch ? makeRef('router', `${newRouterId}:${branch.branchId}`) : makeRef('router', newRouterId);
    }
    return null;
  }

  const newDrafts: DraftSpec[] = macro.drafts.map((d) => ({ ...d, id: draftIdMap.get(d.id)!, projectId }));
  // Branch ids are kept verbatim — they only need to be unique WITHIN a
  // router (canvasTypes.ts's RouterBranch), and the router's own id already
  // changed above, so no collision risk from reusing them.
  const newRouters: RouterSpec[] = macro.routers.map((r) => ({ ...r, id: routerIdMap.get(r.id)!, projectId }));
  const newNotes: NoteData[] = macro.notes.map((n) => ({ ...n, id: noteIdMap.get(n.id)!, projectId }));

  const newChains: Chain[] = [];
  for (const chain of macro.chains) {
    const sourceRef = remapRef(chain.sourceRef);
    const targetRef = remapRef(chain.targetRef);
    if (!sourceRef || !targetRef) continue; // degrade gracefully — never a dangling chain
    newChains.push({
      id: idFactory('chain'),
      sourceRef,
      targetRef,
      condition: chain.condition,
      createdBy: chain.createdBy,
      disabled: chain.disabled,
      // A fresh copy always starts clean — lastFiredAtMs/pinnedContext are
      // per-instance engine bookkeeping, never copied from the template.
    });
  }

  const localOccupied: Rect[] = [...occupied];
  const positions: Record<NodeRef, FlowPoint> = {};

  function place(originalRef: NodeRef, newRef: NodeRef, size: Size): void {
    const relative = macro.positions[originalRef] ?? { x: 0, y: 0 };
    const preferred = { x: dropPoint.x + relative.x, y: dropPoint.y + relative.y };
    const resolved = findFreePosition(localOccupied, size, preferred);
    localOccupied.push({ x: resolved.x, y: resolved.y, width: size.width, height: size.height });
    positions[newRef] = resolved;
  }

  for (const d of macro.drafts) place(makeRef('draft', d.id), makeRef('draft', draftIdMap.get(d.id)!), sizeForKind('draft'));
  for (const r of macro.routers) place(makeRef('router', r.id), makeRef('router', routerIdMap.get(r.id)!), sizeForKind('router'));
  for (const n of macro.notes) place(makeRef('note', n.id), makeRef('note', noteIdMap.get(n.id)!), sizeForKind('note'));

  return { drafts: newDrafts, routers: newRouters, notes: newNotes, chains: newChains, positions };
}

// ── Occupancy helpers (collision obstacles for the placement pass above) ──

/** Sibling rects for one zone (or Transverse, when `projectId` is
 *  undefined) derived from the LIVE, already-reconciled React Flow node
 *  list — used by the UI paths (palette click/drag), which always have a
 *  real `nodes` list on hand. */
export function siblingRectsInZone(nodes: readonly CanvasReactFlowNode[], projectId: string | undefined): Rect[] {
  const zoneRef = projectId ? makeRef('project', projectId) : undefined;
  return nodes
    .filter((n) => n.type !== 'project' && n.parentId === zoneRef)
    .map((n) => ({ x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 }));
}

export interface StoreOccupancySource {
  drafts: readonly DraftSpec[];
  routers: readonly RouterSpec[];
  notes: readonly NoteData[];
  positions: Readonly<Record<NodeRef, FlowPoint>>;
}

/**
 * Approximates occupied rects for a zone (or Transverse) directly from
 * canvasStore's raw facts, for callers with no live reconciled React Flow
 * node list to read (the manager executor, agentsStore.tsx, runs outside
 * any component). Sizes are the same {@link DEFAULT_NODE_SIZE}/
 * {@link ROUTER_NODE_SIZE} defaults reconciler.ts renders every draft/
 * router/note at absent an explicit resize override — a real card never
 * renders smaller than this, so this is a safe (if occasionally slightly
 * conservative) collision estimate.
 */
export function storeOccupancyRects(source: StoreOccupancySource, projectId: string | undefined): Rect[] {
  const rects: Rect[] = [];
  function collect(items: readonly { id: string; projectId?: string }[], kind: 'draft' | 'router' | 'note'): void {
    const size = sizeForKind(kind);
    for (const item of items) {
      if (item.projectId !== projectId) continue;
      const pos = source.positions[makeRef(kind, item.id)];
      if (!pos) continue;
      rects.push({ x: pos.x, y: pos.y, width: size.width, height: size.height });
    }
  }
  collect(source.drafts, 'draft');
  collect(source.routers, 'router');
  collect(source.notes, 'note');
  return rects;
}
