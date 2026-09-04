/* canvasRefIntegrity.ts — P0 crash, round 3: the canvas-side backstop that
   makes "two distinct nodes resolve to the same NodeRef" IMPOSSIBLE BY
   CONSTRUCTION, rather than merely unlikely.

   ── ROOT CAUSE (proven live, 2026-08-01) ───────────────────────────────
   A NodeRef is entirely DERIVED from a node's own `id` (`makeRef(kind, id)`
   — canvasTypes.ts). Nothing ever enforced that two DIFFERENT DraftSpec/
   JoinSpec objects couldn't carry the SAME `id`. In practice they did: the
   manager LLM routinely names plan steps generically ("audit", "verify",
   "fix", "design" — see managerEngine.ts's generate_plan tool spec), and
   TWO SEPARATE plans (generated in different manager turns, possibly
   different app sessions — e1b2e60 made proposed drafts survive hydrate)
   each independently produced a step called "audit". Both decompiled
   (graph/irToCanvas.ts) to a DraftSpec with `id: "audit"` — two objects,
   ONE shared NodeRef `draft:audit`.

   canvasStore's `positions` map is `Record<NodeRef, {x,y}>` — ONE slot per
   ref. Two "different" children that both resolve to that one ref read the
   EXACT SAME position, so `rectsOverlap` reads them as perfectly
   overlapping every single time. The persisted-position declutter pass
   (placementCollision.ts's `declutterPinnedOverlaps`, driven from
   reconcilerZones.ts's `declutterPinnedChildren`) nudges the "loser" to a
   free slot and reconciler.ts persists that correction back — under the
   SAME shared ref key, so BOTH children read the new (still shared, still
   colliding) position on the very next reconcile. Nudge again. Forever:
   `findFreePosition`'s shelf scan steps by `size.width + SCAN_MARGIN` each
   time it re-discovers the "same" collision, which is exactly the
   observed +276px-per-pass drift (draft card width + 16px margin) that
   ran React into "Maximum update depth exceeded" within ~40 passes.

   ── THE FIX ─────────────────────────────────────────────────────────
   `ensureUniqueCanvasRefs` is the ONE place a batch of drafts/joins/chains
   about to land on the live canvas gets checked for id collisions —
   against each other AND against whatever the canvas already carries
   (callers pass the FULL merged arrays, existing-first, so an existing
   node's id always wins and only the newer arrival gets renamed). A
   collision mints a fresh id via `idFactory` (defaults to the SAME
   `generateCanvasId` canvasMacros.ts's `instantiateMacro` already uses to
   guarantee freshness on every macro instantiation — same precedent,
   applied here to the collision case instead of the always-fresh case)
   and rewrites every chain/join reference to the OLD ref onto the NEW one
   in the same pass, so referential integrity never breaks.

   Two call sites, two different failure modes closed:
     - canvasStore.ts's `addProposalPreview` — the ACTUAL crash trigger:
       a second plan's proposal colliding with a first plan's still-
       pending (or already-materialized) draft/join.
     - canvasStore.ts's `hydrate` — a NORMALIZATION/migration pass over
       whatever was persisted or carried across reload, so a REAL user's
       already-corrupted canvas (two "audit" drafts already saved to
       chains.json before this fix existed) self-heals on the next boot
       instead of crashing forever. Repair, never deletion: the renamed
       draft keeps every other field verbatim, only `id` (and whatever
       referenced it) changes.

   `repairPlanSteps` (graph/planStepRepair.ts) is the SIBLING, upstream
   layer: it stops the common case (a manager plan reusing an id already
   live on the canvas) from ever reaching this module's collision branch
   at all, so `id`/accept-by-id identity continuity (canvasTypes.ts's own
   `DraftSpec.proposedPlanId` doc comment: "same id, same object, never a
   delete+recreate") stays intact for the realistic path. This module
   exists for everything that upstream layer cannot see — a corrupted
   persisted file, a future caller that never goes through generate_plan —
   which is why BOTH layers exist rather than either alone (see that
   module's own header).

   Deliberately scoped to drafts + joins — the two kinds this bug's live
   runtime evidence actually showed duplicated, and the two kinds
   `irToProposedCanvas` stamps with `proposedPlanId` (routers are never
   compiled from a plan step today — see that module's own comment — so
   they carry no cross-plan collision risk this wave needs to close).
*/

import { generateCanvasId } from './canvasIds';
import { makeRef, type Chain, type DraftSpec, type JoinSpec, type NodeRef } from './canvasTypes';

export interface CanvasRefBatch {
  drafts: readonly DraftSpec[];
  joins: readonly JoinSpec[];
  chains: readonly Chain[];
}

export interface CanvasRefDedupeResult {
  drafts: DraftSpec[];
  joins: JoinSpec[];
  chains: Chain[];
  /** Old ref -> new ref, for every rename this pass performed. Empty when
   *  nothing collided (the overwhelming common case — every caller should
   *  treat a non-empty map as worth logging, never silently). */
  renamed: ReadonlyMap<NodeRef, NodeRef>;
}

/** One rename this pass performed, plus the `proposedPlanId` (or
 *  `undefined` for a materialized/no-plan item) the RENAMED item itself
 *  carried — see `ensureUniqueCanvasRefs`'s own doc comment for why the
 *  chain/join rewrite below must stay scoped to this same value. */
interface ScopedRename {
  oldRef: NodeRef;
  newRef: NodeRef;
  planId: string | undefined;
}

/**
 * Renames any draft/join whose `id` collides with an EARLIER entry in
 * `input` (array order is significance: pass existing-canvas items before
 * newly-arriving ones so the existing item always keeps its id) and
 * rewrites the chain sourceRef/targetRef and join sourceRefs entries that
 * referenced it. Pure — never mutates `input`, always returns fresh arrays
 * (cheap enough: called only at the two materialization boundaries above,
 * never per-frame/per-reconcile).
 *
 * The chain/join rewrite is SCOPED to `proposedPlanId` (undefined counts as
 * its own scope, matching only another undefined): two DIFFERENT drafts
 * that happened to share the OLD ref string necessarily belonged to
 * DIFFERENT plans/batches (that collision is exactly why one got renamed),
 * and each plan's own chains/joins ALWAYS carry that SAME plan's
 * `proposedPlanId` (irToProposedCanvas stamps every primitive from one
 * compile identically) — so restricting the rewrite to chains/joins
 * sharing the renamed item's own `proposedPlanId` is what keeps an
 * UNRELATED, already-correctly-resolving chain (e.g. an earlier plan's own
 * chain into the id-collision's FIRST, un-renamed occupant) from being
 * incorrectly redirected onto a second, unrelated plan's renamed node —
 * a blanket "any ref-string match" rewrite would get this wrong the moment
 * two colliding drafts both have at least one real chain each.
 */
export function ensureUniqueCanvasRefs(
  input: CanvasRefBatch,
  idFactory: (prefix: string) => string = generateCanvasId,
): CanvasRefDedupeResult {
  const renamed = new Map<NodeRef, NodeRef>();
  const scopedRenames: ScopedRename[] = [];

  const seenDraftIds = new Set<string>();
  const drafts = input.drafts.map((draft) => {
    if (!seenDraftIds.has(draft.id)) {
      seenDraftIds.add(draft.id);
      return draft;
    }
    const newId = idFactory('draft');
    seenDraftIds.add(newId);
    const oldRef = makeRef('draft', draft.id);
    const newRef = makeRef('draft', newId);
    renamed.set(oldRef, newRef);
    scopedRenames.push({ oldRef, newRef, planId: draft.proposedPlanId });
    return { ...draft, id: newId };
  });

  const seenJoinIds = new Set<string>();
  const joins = input.joins.map((join) => {
    if (!seenJoinIds.has(join.id)) {
      seenJoinIds.add(join.id);
      return join;
    }
    const newId = idFactory('join');
    seenJoinIds.add(newId);
    const oldRef = makeRef('join', join.id);
    const newRef = makeRef('join', newId);
    renamed.set(oldRef, newRef);
    scopedRenames.push({ oldRef, newRef, planId: join.proposedPlanId });
    return { ...join, id: newId };
  });

  if (scopedRenames.length === 0) {
    return { drafts, joins, chains: [...input.chains], renamed };
  }

  const renamesByPlan = new Map<string | undefined, Map<NodeRef, NodeRef>>();
  for (const { oldRef, newRef, planId } of scopedRenames) {
    const bucket = renamesByPlan.get(planId) ?? new Map<NodeRef, NodeRef>();
    bucket.set(oldRef, newRef);
    renamesByPlan.set(planId, bucket);
  }

  const chains = input.chains.map((chain) => {
    const bucket = renamesByPlan.get(chain.proposedPlanId);
    if (!bucket) return chain;
    return {
      ...chain,
      sourceRef: bucket.get(chain.sourceRef) ?? chain.sourceRef,
      targetRef: bucket.get(chain.targetRef) ?? chain.targetRef,
    };
  });
  const joinsWithRemappedSources = joins.map((join) => {
    const bucket = renamesByPlan.get(join.proposedPlanId);
    if (!bucket) return join;
    return { ...join, sourceRefs: join.sourceRefs.map((ref) => bucket.get(ref) ?? ref) };
  });

  return { drafts, joins: joinsWithRemappedSources, chains, renamed };
}

/**
 * Sane upper bound (px, either axis) for a PERSISTED canvas coordinate.
 * Generous headroom over the worst realistic auto-placement grid
 * (placementCollision.ts's shelf scan caps at 40 cols x 80 rows of
 * ~290x266px cells — geometry.ts's GRID_CELL_WIDTH/HEIGHT — under
 * ~25,000px in either dimension even at that ceiling) while comfortably
 * BELOW the ~337,000px this exact bug's unbounded declutter drift produced
 * (see this module's own header) — a position past this bound is never a
 * legitimate layout, only crash-drift debris.
 */
export const MAX_SANE_CANVAS_COORD = 100_000;

export interface PositionSanitizeResult {
  positions: Record<NodeRef, { x: number; y: number }>;
  /** Refs whose persisted position was dropped (never invented a
   *  replacement coordinate) — the caller logs these; the normal
   *  auto-placement path (reconcilerZones.ts's `assignChildPositions`,
   *  "no persisted position -> grid slot") re-derives a sane, VISIBLE spot
   *  for each on the very next reconcile. */
  droppedRefs: NodeRef[];
}

/**
 * Drops any persisted position whose x or y is non-finite (NaN/Infinity —
 * never valid, JSON can't even round-trip them, but a corrupted file could
 * still carry a stringified one) or exceeds {@link MAX_SANE_CANVAS_COORD}
 * — repair, not deletion: the referenced node's own content is untouched,
 * only its geometry entry is removed so it becomes reachable again instead
 * of parked off-screen forever at drift debris coordinates.
 */
export function sanitizeCanvasPositions(
  positions: Readonly<Record<NodeRef, { x: number; y: number }>>,
  maxCoord: number = MAX_SANE_CANVAS_COORD,
): PositionSanitizeResult {
  const droppedRefs: NodeRef[] = [];
  const sane: Record<NodeRef, { x: number; y: number }> = {};
  for (const [ref, pos] of Object.entries(positions)) {
    const isSane = Number.isFinite(pos.x) && Number.isFinite(pos.y) && Math.abs(pos.x) <= maxCoord && Math.abs(pos.y) <= maxCoord;
    if (isSane) {
      sane[ref] = pos;
    } else {
      droppedRefs.push(ref);
    }
  }
  if (droppedRefs.length === 0) return { positions: positions as Record<NodeRef, { x: number; y: number }>, droppedRefs };
  return { positions: sane, droppedRefs };
}
