/* reconcilerEdges.ts — chain/hierarchy/router edge building (W9 split of
   the original 1146-line reconciler.ts; see reconciler.ts's own module
   header for the full pipeline story, in particular header gap #3:
   `ChainEdgeData` is W1b's canonical render-time shape, imported from
   edges/ChainEdge.tsx rather than redefined here). PURE functions only,
   same contract as reconciler.ts: no React, no I/O.

   Owns every edge kind `reconcile()` emits:
     - hierarchy edges (parent orchestrator -> sub-mission, and loop ->
       iteration-mini, spec §6),
     - chain edges (canvasStore's persisted `Chain[]` -> `ChainFlowEdge[]`,
       including tombstone detection, the `firing` pulse derived from
       `Chain.lastFiredAtMs`, and router-branch/folded-orchestrator endpoint
       resolution).
*/

import { MarkerType, type Edge } from '@xyflow/react';
import type { FleetMission } from '../../../lib/agents/fleetMissions';
import {
  makeRef,
  parseRef,
  parseRouterBranchRef,
  type Chain,
  type IterationNodeData,
  type NodeRef,
  type RouterSpec,
  type SurfaceSpec,
} from './canvasTypes';
import { conditionStrokeProps, type ChainEdgeData, type ChainFlowEdge } from './edges/ChainEdge';
import type { CanvasReactFlowNode } from './reconcilerZones';
import { findVisibleAncestorId, type MissionLoopMeta } from './reconcilerFold';

// ChainEdgeData (condition/disabled/tombstone/firing) already `extends
// Record<string, unknown>`, so no extra intersection is needed here (unlike
// the node data types in reconcilerZones.ts).
export type CanvasReactFlowEdge = Edge<Record<string, unknown>, 'hierarchy'> | ChainFlowEdge;

/** Resolves a mission id to whichever ref it actually rendered as (a loop
 *  parent renders as `loop:<id>`, everything else as `mission:<id>`). */
export function missionNodeRef(missionId: string, missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>): NodeRef {
  const isLoop = missionLoopMeta.get(missionId)?.loopConfig !== undefined;
  return makeRef(isLoop ? 'loop' : 'mission', missionId);
}

export function buildHierarchyEdges(
  allMissions: readonly FleetMission[],
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>,
  renderedIds: ReadonlySet<string>,
): CanvasReactFlowEdge[] {
  const edges: CanvasReactFlowEdge[] = [];
  for (const mission of allMissions) {
    const parentMissionId = missionLoopMeta.get(mission.id)?.parentMissionId;
    if (!parentMissionId) continue;
    const source = missionNodeRef(parentMissionId, missionLoopMeta);
    const target = missionNodeRef(mission.id, missionLoopMeta);
    if (!renderedIds.has(source) || !renderedIds.has(target)) continue;
    edges.push({ id: `hierarchy:${parentMissionId}:${mission.id}`, type: 'hierarchy', source, target, data: {} });
  }
  return edges;
}

/** A chain's traveling-dot animation (ChainEdge.tsx) plays for this long
 *  after `Chain.lastFiredAtMs` — matches the doc comment on
 *  `ChainEdgeData.firing` ("true for exactly the tick a chain fires"),
 *  widened from one poll tick to a fixed window so the animation is visible
 *  regardless of the caller's poll interval (Cockpit polls every 2.5s). */
export const FIRING_WINDOW_MS = 4_000;

/**
 * W8a deliverable #2 — remaps a chain endpoint that points at a mission
 * hidden by a folded orchestrator onto that orchestrator's own rendered ref
 * (spec: "reroutes their edges onto the orchestrator", same principle as
 * zone collapse re-anchoring). Non-mission refs (draft/schedule/note) and
 * visible missions pass through untouched. Returns the original ref when no
 * visible ancestor exists (defensive) — it then tombstones normally.
 */
export function remapHiddenEndpoint(
  ref: NodeRef,
  hiddenMissionIds: ReadonlySet<string>,
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>,
): NodeRef {
  const parsed = parseRef(ref);
  if (!parsed || (parsed.kind !== 'mission' && parsed.kind !== 'loop')) return ref;
  if (!hiddenMissionIds.has(parsed.id)) return ref;
  const ancestorId = findVisibleAncestorId(parsed.id, missionLoopMeta, hiddenMissionIds);
  return ancestorId ? missionNodeRef(ancestorId, missionLoopMeta) : ref;
}

/**
 * W8c — a router BRANCH source ref (`router:<routerId>:<branchId>`) never
 * corresponds to its own rendered React Flow node (only the WHOLE router,
 * `router:<routerId>`, is rendered — see reconcilerZones.ts's
 * `collectZoneChildren` router pass, and canvasTypes.ts's
 * `parseRouterBranchRef` doc comment for why: v1 has no per-branch handle).
 * Resolved down to the router's own ref here so the EDGE's visual endpoint
 * is a real node id (never a spurious `tombstone: true` for a perfectly
 * live branch) — `chainEngine.ts`'s own fire-time logic reads
 * `chain.sourceRef` straight from canvasStore, completely unaffected by
 * this render-only resolution.
 */
export function resolveRouterBranchEndpoint(ref: NodeRef): NodeRef {
  const branch = parseRouterBranchRef(ref);
  return branch ? makeRef('router', branch.routerId) : ref;
}

/**
 * Defect #9 fix ("tombstone rendering"): the pre-fix behavior pushed a
 * tombstoned chain's edge with `source`/`target` refs that may not
 * correspond to ANY rendered node at all — React Flow then has nowhere
 * real to anchor the edge and renders it as a disconnected, floating
 * chip (the "floating crossed chip in the void" the QA triage screenshot
 * caught, t02c-left-drag.png). Two honest outcomes instead, resolved
 * below before the edge is built:
 *
 *   - NEITHER endpoint resolves to a rendered node: there is nothing
 *     sensible left to attach a badge to (both sides of the handoff are
 *     gone) — the chain is dropped from this render pass entirely (the
 *     persisted `Chain` itself is untouched; it reappears the moment
 *     either side comes back, e.g. the source project reopens).
 *   - Exactly one endpoint resolves: the edge collapses to a SELF-LOOP on
 *     the surviving node (`source === target === survivingRef`) instead
 *     of pointing at a nonexistent id. React Flow draws this as a small
 *     loop back onto that one real node (every node type has both a
 *     source and a target handle — see e.g. MissionNode.tsx) — a real,
 *     attached "broken-link" badge rather than a chip floating at a
 *     default/guessed position. ChainEdge.tsx already dims + shows the
 *     `canvas.edge.targetGone` tooltip for `tombstone: true` (its own
 *     existing contract, unchanged here) and CanvasContextMenu.tsx's
 *     existing generic `delete-chain` entry (any selected chain edge ->
 *     `removeChain(edge.id)`) already lets the user remove it by right-
 *     clicking the loop — see this wave's report for the small polish
 *     flagged for that file (a dedicated "Supprimer la chaîne orpheline"
 *     label conditioned on `edge.data.tombstone`, not required for the
 *     removal capability to work).
 */
function resolveTombstoneEndpoints(
  source: NodeRef,
  target: NodeRef,
  renderedIds: ReadonlySet<string>,
): { source: NodeRef; target: NodeRef; tombstone: boolean } | null {
  const sourceRendered = renderedIds.has(source);
  const targetRendered = renderedIds.has(target);
  if (sourceRendered && targetRendered) return { source, target, tombstone: false };
  if (!sourceRendered && !targetRendered) return null; // nothing sensible to attach to
  const survivingRef = sourceRendered ? source : target;
  return { source: survivingRef, target: survivingRef, tombstone: true };
}

export function buildChainEdges(
  chains: readonly Chain[],
  renderedIds: ReadonlySet<string>,
  nowMs: number,
  hiddenMissionIds: ReadonlySet<string>,
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>,
  routers: readonly RouterSpec[],
): ChainFlowEdge[] {
  const edges: ChainFlowEdge[] = [];
  for (const chain of chains) {
    const branchRef = parseRouterBranchRef(chain.sourceRef);
    const branchLabel = branchRef
      ? routers.find((r) => r.id === branchRef.routerId)?.branches.find((b) => b.id === branchRef.branchId)?.label
      : undefined;
    const remappedSource = remapHiddenEndpoint(resolveRouterBranchEndpoint(chain.sourceRef), hiddenMissionIds, missionLoopMeta);
    const remappedTarget = remapHiddenEndpoint(resolveRouterBranchEndpoint(chain.targetRef), hiddenMissionIds, missionLoopMeta);
    // Both endpoints folded into the SAME orchestrator: the whole chain is
    // an internal detail of the folded subtree — emitting a self-loop edge
    // would just draw noise on the badge; drop it for this render pass
    // (the persisted Chain itself is untouched, it reappears on unfold).
    if (remappedSource === remappedTarget && remappedSource !== chain.sourceRef) continue;

    const resolved = resolveTombstoneEndpoints(remappedSource, remappedTarget, renderedIds);
    if (!resolved) continue;
    const { source, target, tombstone } = resolved;

    // W3's chain engine owns Chain.lastFiredAtMs (canvasStore.markChainFired)
    // — this is a pure derivation of the render-only `firing` flag from it,
    // never the other way around (reconciler.ts header gap #3: this
    // reconciler never mutates canvasStore's persisted Chain, only DERIVES a
    // transient per-poll render flag from its lastFiredAtMs).
    const firing = chain.lastFiredAtMs != null && nowMs - chain.lastFiredAtMs < FIRING_WINDOW_MS;
    const data: ChainEdgeData = {
      condition: chain.condition,
      disabled: chain.disabled ?? false,
      tombstone,
      firing: firing || undefined,
      pinned: chain.pinnedContext != null || undefined,
      pinnedContext: chain.pinnedContext,
      branchLabel,
      // Chantier 3 (plan-first canvas) — mirrors Chain.proposedPlanId
      // verbatim, never re-derived (same convention as every other flag here).
      proposed: chain.proposedPlanId != null || undefined,
    };
    // fix/canvas-graph-legibility — "EDGES MUST READ AS A GRAPH": every
    // chain edge now carries a directional arrowhead (ReactFlow's own
    // `markerEnd`, previously never set at all on this app's edges) so a
    // dependency's direction is legible on sight, not just inferable from
    // the traveling-dot animation on the rare tick it fires. Colored per
    // the SAME condition->color mapping the stroke itself uses
    // (conditionStrokeProps, ChainEdge.tsx's own single source of truth)
    // rather than duplicating that table here.
    edges.push({
      id: chain.id,
      type: 'chain',
      source,
      target,
      data,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: conditionStrokeProps(chain.condition, false).stroke },
    });
  }
  return edges;
}

/**
 * R7 (living surfaces, "what talks to what") — a thin dotted edge from a
 * terminal/preview surface's owning mission/zone to the surface node itself,
 * reusing the SAME quiet `hierarchy` edge type/style (HierarchyEdge.tsx)
 * every parent->sub-mission link already uses — a surface is visually
 * "attached to" its owner exactly like a sub-mission is attached to its
 * orchestrator, never a competing new edge style. No-op (nothing emitted)
 * for a surface with no owner, or whose owner isn't currently rendered (e.g.
 * the owning mission was folded/removed) — the surface node itself still
 * renders standalone, it just loses that one visual tether, same "degrade
 * the link, never the node" convention `resolveTombstoneEndpoints`
 * establishes for chain edges.
 *
 * Mission B (proof window) — multi-owner generalization: a surface fed by
 * SEVERAL missions (`SurfaceSpec.ownerRefs`, e.g. a browser-recipe proof
 * surface accumulating runs from more than one mission) gets ONE edge PER
 * entry in that array instead of the single `ownerRef` edge every other
 * surface kind still gets — "which agent produced which proof" needs to be
 * visible for EVERY contributor at a glance, not just the first/last one.
 * `ownerRefs` wins outright over `ownerRef` when both happen to be set
 * (defensive only — real callers set exactly one of the two); each is
 * resolved/skipped independently, so one folded/removed owner among several
 * never hides the edges to the others still rendered.
 */
export function buildSurfaceEdges(surfaces: readonly SurfaceSpec[], renderedIds: ReadonlySet<string>): CanvasReactFlowEdge[] {
  const edges: CanvasReactFlowEdge[] = [];
  for (const surface of surfaces) {
    const owners = surface.ownerRefs ?? (surface.ownerRef ? [surface.ownerRef] : []);
    if (owners.length === 0) continue;
    const target = makeRef(surface.kind, surface.id);
    if (!renderedIds.has(target)) continue;
    const seenOwners = new Set<string>();
    for (const owner of owners) {
      if (seenOwners.has(owner) || !renderedIds.has(owner)) continue;
      seenOwners.add(owner);
      edges.push({ id: `surface:${owner}:${surface.id}`, type: 'hierarchy', source: owner, target, data: {} });
    }
  }
  return edges;
}

/** W8a deliverable #2 — hierarchy edges from an expanded loop onto its
 *  rendered iteration mini nodes (the quiet dotted link that visually ties
 *  the stack to its loop). */
export function buildIterationEdges(renderedIds: ReadonlySet<string>, nodes: readonly CanvasReactFlowNode[]): CanvasReactFlowEdge[] {
  const edges: CanvasReactFlowEdge[] = [];
  for (const node of nodes) {
    if (node.type !== 'iteration') continue;
    const data = node.data as IterationNodeData;
    const source = makeRef('loop', data.loopMissionId);
    if (!renderedIds.has(source)) continue;
    edges.push({ id: `hierarchy:${data.loopMissionId}:iter:${data.missionId}`, type: 'hierarchy', source, target: node.id, data: {} });
  }
  return edges;
}
