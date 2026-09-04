/* reconciler.ts — FleetProject[] + canvas geometry -> React Flow nodes/edges
   (W1a, plan §W1a; spec §6). PURE functions only: no React, no I/O. Every
   export here is unit-testable by constructing plain data and asserting on
   the returned { nodes, edges }.

   Mission/agent FACTS come from the existing read-models (FleetMission,
   FleetProject — spec §3 data ownership rule); this module only DERIVES
   React Flow node/edge shapes from them plus the canvas store's geometry
   (positions/collapsed/prefs) and canvas-owned facts (drafts/chains/notes).
   It never mutates any of its inputs.

   ── W9 SPLIT (this file was 1146 lines) ── the pipeline is now three
   cohesive sibling modules plus this orchestrator, which stays the SOLE
   public barrel every external caller imports from (production code AND
   tests) — no import path outside this file needed to change:
     - reconcilerZones.ts — per-zone child collection, incremental
       placement, bounding-box sizing, shelf-packing, referential-stability
       reuse. Owns `CanvasReactFlowNode`.
     - reconcilerFold.ts — orchestrator subtree fold (hidden-mission
       closure, chain-edge reroute target, sub-mission badge aggregate) +
       loop expand-in-place (iteration mini nodes). Owns `MissionLoopMeta`.
     - reconcilerEdges.ts — hierarchy/chain/iteration edge building. Owns
       `CanvasReactFlowEdge`.
   See each file's own header for its slice of the pipeline. ZERO behavior
   change from the pre-split version — every function body moved verbatim.

   ── CONTRACT GAPS found while implementing (canvasTypes.ts is frozen —
   these are worked around locally in the sub-modules above, not fixed
   upstream; see this wave's report for the full writeup) ──

   1. FleetMission (src/lib/agents/fleetMissions.ts), the read-model
      MissionNodeData/LoopNodeData embed verbatim, does NOT carry
      loopConfig / loopParentId / loopIteration / parentMissionId /
      isOrchestrator — only the full `Mission` type does. Loop aggregation
      and hierarchy edges (spec §6) are therefore impossible from
      `FleetProject[]` alone. Worked around via an optional
      `missionLoopMeta` side-map (keyed by mission id, reconcilerFold.ts's
      `MissionLoopMeta`) that {@link ReconcileInputs} accepts in addition to
      the plan's shorthand input list. Absent entries degrade to "plain
      mission node, no loop, no hierarchy edge" — never a crash, never a
      silently dropped mission.

   2. canvasTypes.ts's header comment (spec §6 excerpt) mentions
      `sched:<scheduleId>` as the schedule node's ref prefix, but
      `CanvasNodeKind` only contains the literal `'schedule'` — confirmed
      with the orchestrator: the prose is stale, `schedule:<scheduleId>`
      (via `makeRef('schedule', id)`) is the actual contract, which is what
      this file uses.

   3. `ChainEdgeData` (condition/disabled/tombstone/firing) is NOT part of
      canvasTypes.ts's frozen `Chain` model (which only covers the
      PERSISTED chain: id/sourceRef/targetRef/condition/createdBy/
      disabled) — W1b defined the canonical render-time shape in
      `edges/ChainEdge.tsx` (their file, not W1a's) and reconcilerEdges.ts
      imports it from there per orchestrator arbitration, rather than
      defining its own competing shape. `firing` (true for exactly the
      tick a chain fires) is derived from `Chain.lastFiredAtMs` — W3's
      chain engine owns setting that.

   4. `MissionNodeData.forceApprove` and `ProjectNodeData.isActive` /
      `MissionNodeData.isActiveProject` / `LoopNodeData.isActiveProject`
      need Cockpit's local `forceApproveIds` set and
      `AppContext.activeProjectId` — neither appears in the plan's input
      shorthand either. Added as optional `forceApproveIds` /
      `activeProjectId` fields on {@link ReconcileInputs} (default to
      "none active" / empty set) for the same reason as gap 1.
*/

import type { FleetProject } from '../../../lib/agents/fleetMissions';
import type { StoredAgent } from '../../../lib/agents/agentsStorage';
import { formatCron } from '../../../lib/agents/scheduleUtils';
import { rankUrgentMissions } from '../cockpit/cockpitHelpers';
import { makeRef, type BotNodeData, type BotNodeStatus, type BotVmNodeData, type CanvasPrefs, type Chain, type DraftSpec, type FrameSpec, type JoinSpec, type NodeRef, type NoteData, type ProjectNodeCounts, type ProjectNodeData, type RouterSpec, type ScheduleNodeData, type SurfaceSpec } from './canvasTypes';
import { BOT_VM_WINDOW_DEFAULT_SIZE } from '../../../lib/solari/botVmWindows';
import type { BotConfig } from '../../../lib/bots/botTypes';
import {
  computeZoneLayout,
  declutterPinnedZones,
  emitZone,
  migrateBloatedZoneRowPositions,
  packAutoPlacedZones,
  TRANSVERSE_PROJECT_ID,
  type CanvasReactFlowNode,
  type ZoneBuildContext,
  type ZoneInput,
} from './reconcilerZones';
import {
  buildChildrenByParent,
  computeHiddenMissionIds,
  computeSubMissionAggregates,
  recordToIdSet,
  type MissionLoopMeta,
} from './reconcilerFold';
import {
  buildChainEdges,
  buildHierarchyEdges,
  buildIterationEdges,
  buildSurfaceEdges,
  type CanvasReactFlowEdge,
} from './reconcilerEdges';
import { buildCollisionEdges } from '../../../lib/collab/collisionEdges';

// ── Re-exports (public barrel — see this file's header) ──────────────

export type { CanvasReactFlowNode } from './reconcilerZones';
export {
  DEFAULT_FRAME_SIZE,
  DEFAULT_NODE_SIZE,
  ITERATION_NODE_HEIGHT,
  ITERATION_NODE_WIDTH,
  LIVE_PANEL_SIZE,
  PREVIEW_NODE_SIZE,
  ROUTER_NODE_SIZE,
  JOIN_NODE_SIZE,
  TERMINAL_NODE_SIZE,
  TRANSVERSE_PROJECT_ID,
} from './reconcilerZones';
export type { CanvasReactFlowEdge } from './reconcilerEdges';
export type { MissionLoopMeta } from './reconcilerFold';

/**
 * LazyBot wave — a bot's reconciler input: the persisted BotConfig plus the
 * coarse live runtime snapshot useCanvasFlowGraph derives from botEngine
 * (status halo, active run count, last action).
 */
export interface BotNodeInput {
  bot: BotConfig;
  status: BotNodeStatus;
  activeRuns: number;
  activeRunIds?: string[];
  lastAction?: string;
  /** True when the bot's connected VM window node should be rendered (▶ VM). */
  vmOpen?: boolean;
  /** Current window footprint when vmOpen (user-resizable). */
  vmSize?: { width: number; height: number };
}

export interface ReconcileInputs {
  projects: FleetProject[];
  drafts: DraftSpec[];
  chains: Chain[];
  notes: NoteData[];
  scheduled: ScheduleNodeData[];
  /** W8c (additive, defaults to `[]` — every existing call site stays valid
   *  unchanged): persisted router nodes (canvasStore's `routers` slice). */
  routers?: RouterSpec[];
  /** W-JOIN (additive, defaults to `[]`): persisted join (fan-in) nodes
   *  (canvasStore's `joins` slice). */
  joins?: JoinSpec[];
  /** R7 (additive, defaults to `[]`): persisted terminal/preview surface
   *  nodes (canvasStore's `surfaces` slice). */
  surfaces?: SurfaceSpec[];
  /** W-CLOSE row 2 (additive, defaults to `[]`): persisted purely-visual
   *  frame nodes (canvasStore's `frames` slice). */
  frames?: FrameSpec[];
  /**
   * LazyBot wave (additive, defaults to `[]`): persisted LazyBots (BotConfig
   * from botStorage) plus their coarse live runtime snapshot (status halo,
   * active run count, last action). Rendered inside a dedicated "LazyBots"
   * group zone.
   */
  bots?: BotNodeInput[];
  positions: Record<NodeRef, { x: number; y: number }>;
  collapsed: Record<string, boolean>;
  prefs: CanvasPrefs;
  /** `AppContext.activeProjectId` — see header gap #4. */
  activeProjectId?: string | null;
  /** Cockpit's local `forceApproveIds` — see header gap #4. */
  forceApproveIds?: ReadonlySet<string>;
  /** Per-mission loop/hierarchy metadata — see header gap #1. */
  missionLoopMeta?: ReadonlyMap<string, MissionLoopMeta>;
  /** Previous reconcile's output nodes, for referential data stability. */
  prevNodes?: readonly CanvasReactFlowNode[];
  /**
   * W8a deliverable #2 (additive): orchestrator mission ids currently
   * folded. Every mission transitively reachable from one of these ids
   * via `MissionLoopMeta.parentMissionId` is hidden from `nodes`/
   * `renderedIds`; any chain edge whose endpoint was one of those hidden
   * missions is rerouted onto the nearest non-hidden (folded) ancestor
   * instead of tombstoning (spec: "reroutes their edges onto the
   * orchestrator"). DEFAULTS from `prefs.foldedOrchestrators` (the
   * canvasStore-persisted home of this state — see CanvasPrefs) so live
   * callers that already thread `prefs` need no change; tests/explicit
   * callers may still pass a Set directly to override.
   */
  foldedOrchestrators?: ReadonlySet<string>;
  /**
   * W8a deliverable #2 (additive): loop mission ids currently EXPANDED
   * in-place — each expanded loop's last-3 iterations are emitted as
   * read-only `iteration:<missionId>` mini nodes laid out under the loop
   * inside its zone, linked by a hierarchy edge. DEFAULTS from
   * `prefs.expandedLoops`, same rationale as {@link foldedOrchestrators}.
   */
  expandedLoops?: ReadonlySet<string>;
  /**
   * R7 (additive, defaults to `{}`): live-panel expand state for mission
   * nodes, keyed by NodeRef — presence overrides `DEFAULT_NODE_SIZE.mission`
   * with the stored `{width,height}` for that ONE node (reconcilerZones.ts's
   * `effectiveChildSize`), feeding the real expanded footprint into the
   * no-overlap collision-resolution/bbox passes. Unlike
   * `foldedOrchestrators`/`expandedLoops` this has no `prefs`-resident
   * default to fall back to (it is its own canvasStore facts slice, not
   * nested in `prefs` — see canvasStore.ts's `expandedPanels` doc comment for
   * why: it stores per-node DIMENSIONS, not just a boolean, so the
   * `Record<string, boolean>` shape `recordToIdSet` expects doesn't fit).
   */
  expandedPanels?: Record<NodeRef, { width: number; height: number }>;
  /**
   * "Now", for deriving {@link ChainEdgeData.firing} from
   * `Chain.lastFiredAtMs` (W3, spec §6/§7 — see reconcilerEdges.ts's
   * buildChainEdges). Defaults to `Date.now()` internally when omitted so
   * live callers (W1c's poll loop) don't need to thread it through, but
   * every test passes it explicitly to keep `reconcile()` deterministic
   * (module header's "PURE functions only" contract) — an implicit
   * `Date.now()` default is the one narrow, well-contained exception,
   * exactly like fleetStage-adjacent pure mappers elsewhere in this
   * codebase default a `nowMs` param the same way.
   */
  nowMs?: number;
  /**
   * fix/canvas-ux R10 (persisted-position declutter, additive, defaults to
   * `new Set()`): refs the user dragged THIS session (canvasStore's
   * sessionDragged set) — see reconcilerZones.ts's `declutterPinnedChildren`
   * / placementCollision.ts's `DeclutterResult` doc comment. Threaded
   * through exactly like `foldedOrchestrators`/`expandedLoops` above.
   */
  sessionDraggedRefs?: ReadonlySet<NodeRef>;
  /**
   * W-DISMISS (additive, defaults to `new Set()`): mission ids the user
   * dismissed from the live canvas (canvasStore's `dismissedRefs` slice,
   * see its own doc comment for the "always `mission:`-kind, regardless of
   * loop-ness" ref convention). Filtered alongside `!m.archived` below —
   * same "additive and reversible in the data, only cosmetic on the live
   * board" honesty rule that filter's own R13 doc comment states: neither
   * filter ever touches the underlying Mission record, only this
   * reconciled node list.
   */
  dismissedRefs?: ReadonlySet<NodeRef>;
}

export interface ReconcileResult {
  nodes: CanvasReactFlowNode[];
  edges: CanvasReactFlowEdge[];
  /**
   * fix/canvas-ux R10 — every NodeRef whose PERSISTED position was corrected
   * this pass by the pinned x pinned declutter (reconcilerZones.ts's
   * `declutterPinnedChildren`), mapped to its new position. Empty on every
   * reconcile where nothing needed decluttering (the overwhelming common
   * case). The caller (useCanvasFlowGraph.ts) persists these back into
   * canvasStore via `setPositions`, so the correction becomes the new
   * (non-colliding) truth instead of being silently re-discovered and
   * re-resolved on every single reconcile.
   *
   * fix/persisted-positions-declutter — ALSO includes a PROJECT ref
   * (`project:<id>`) whose persisted position was nudged by the zone-vs-zone
   * declutter (reconcilerZones.ts's `declutterPinnedZones`) — same map, same
   * persistence path; a corrected zone position is not a second concept, just
   * a coarser-grained one. Tradeoff, stated once here rather than at every
   * call site: the no-overlap invariant now holds for EVERY pinned rect this
   * reconciler ever emits (child or zone) — a pinned/persisted position is
   * never a reason to leave two cards visibly overlapped, it only ever means
   * "prefer this spot, move the minimum amount needed if it collides."
   *
   * Preview-surface-correctness fix — ALSO includes a terminal/preview
   * surface's position the very first time it is tethered next to its owning
   * mission (reconcilerZones.ts's `tetherFreshSurfacesToOwner` — see that
   * function's own doc comment): same map, same persistence path, one more
   * "computed once, remember it" case rather than a second concept.
   */
  declutteredPositions: Record<NodeRef, { x: number; y: number }>;
}

const EMPTY_FORCE_APPROVE_IDS: ReadonlySet<string> = new Set();
const EMPTY_MISSION_LOOP_META: ReadonlyMap<string, MissionLoopMeta> = new Map();
const EMPTY_PREV_NODES: readonly CanvasReactFlowNode[] = [];
const EMPTY_ROUTERS: RouterSpec[] = [];
const EMPTY_JOINS: JoinSpec[] = [];
const EMPTY_SURFACES: SurfaceSpec[] = [];
const EMPTY_FRAMES: FrameSpec[] = [];
const EMPTY_BOTS: BotNodeInput[] = [];
const EMPTY_EXPANDED_PANELS: Record<NodeRef, { width: number; height: number }> = {};
const EMPTY_SESSION_DRAGGED_REFS: ReadonlySet<NodeRef> = new Set();
const EMPTY_DISMISSED_REFS: ReadonlySet<NodeRef> = new Set();

// ── Public API ─────────────────────────────────────────────────────

export function reconcile(inputs: ReconcileInputs): ReconcileResult {
  const {
    projects,
    drafts,
    chains,
    notes,
    scheduled,
    positions,
    collapsed,
    prefs,
    activeProjectId = null,
    forceApproveIds = EMPTY_FORCE_APPROVE_IDS,
    missionLoopMeta = EMPTY_MISSION_LOOP_META,
    prevNodes = EMPTY_PREV_NODES,
    routers = EMPTY_ROUTERS,
    joins = EMPTY_JOINS,
    surfaces = EMPTY_SURFACES,
    frames = EMPTY_FRAMES,
    bots = EMPTY_BOTS,
    expandedPanels = EMPTY_EXPANDED_PANELS,
    // Defaults from prefs (their persisted home) — see the ReconcileInputs
    // doc comments. `prefs` is destructured above these, so it is in scope.
    foldedOrchestrators = recordToIdSet(prefs.foldedOrchestrators),
    expandedLoops = recordToIdSet(prefs.expandedLoops),
    nowMs = Date.now(),
    sessionDraggedRefs = EMPTY_SESSION_DRAGGED_REFS,
    dismissedRefs = EMPTY_DISMISSED_REFS,
  } = inputs;

  const prevNodeById = new Map(prevNodes.map((node) => [node.id, node] as const));
  const urgentRankByMissionId = new Map(rankUrgentMissions(projects).map((r) => [r.mission.id, r.rank] as const));

  // W8a deliverable #2 — orchestrator fold derivations (all pure, all from
  // the same parentMissionId links buildHierarchyEdges already walks).
  const allMissionsForFold = projects.flatMap((p) => p.missions);
  const childrenByParent = buildChildrenByParent(allMissionsForFold, missionLoopMeta);
  const missionById = new Map(allMissionsForFold.map((m) => [m.id, m] as const));
  const subMissionAggregates = computeSubMissionAggregates(childrenByParent, missionById);
  const hiddenMissionIds = computeHiddenMissionIds(foldedOrchestrators, childrenByParent);

  const ctx: ZoneBuildContext = {
    positions,
    collapsed,
    prefs,
    forceApproveIds,
    missionLoopMeta,
    urgentRankByMissionId,
    prevNodeById,
    hiddenMissionIds,
    subMissionAggregates,
    expandedLoops,
    expandedPanels,
    sessionDraggedRefs,
    // W-JOIN — the SAME global-by-id map every mission fact in this
    // reconcile already derives from (`missionById` above), narrowed
    // structurally to {title,status} — a join's sources can cross project
    // zones, so this must never be re-scoped to one zone's own missions.
    missionById,
  };

  const out = { nodes: [] as CanvasReactFlowNode[], renderedIds: new Set<string>() };

  // Two passes (spec CRITICAL 1 — see reconcilerZones.ts's
  // computeZoneLayout/packAutoPlacedZones for why): first compute every
  // zone's REAL size independent of where it lands, then resolve final
  // positions (persisted verbatim, or shelf-packed among the auto-placed
  // ones), then emit nodes in order.
  //
  // 2026-08-05 "zones-projet-disparues" incident — INVARIANT, stated once
  // here: this `.map()` is UNCONDITIONAL, one ZoneInput per entry in
  // `projects`, regardless of content (empty missions/drafts/notes/etc — see
  // reconcilerZones.ts's computeZoneLayout, which falls back to
  // EMPTY_ZONE_SIZE rather than ever skipping) or collapsed state (emitZone
  // still pushes a project node when isCollapsed, just at COLLAPSED_ZONE_SIZE
  // — see that function's own early branch). `reconcile()` trusts `projects`
  // as the authoritative "currently open" set and never re-filters it —
  // every open project's zone is ALWAYS rendered, even empty (the empty
  // state with "Lancer un agent" is exactly what an empty-but-emitted zone
  // renders as). If a project zone is ever missing from the live canvas, the
  // defect is in whatever computed the `projects` ARGUMENT passed into this
  // function (the caller's fleet-projects derivation), never a filtering
  // condition in this file or reconcilerZones.ts — see reconciler.test.ts's
  // "renders one zone per OPEN project even with zero content" regression
  // test for the locked-in proof.
  const zoneInputs: ZoneInput[] = projects.map((project) => ({
    projectId: project.projectId,
    root: project.root,
    name: project.name,
    isActive: project.projectId === activeProjectId,
    // R13 — mission lifecycle: an archived TERMINAL mission (Mission.archived,
    // set via the canvas "Archiver" action) is hidden from the LIVE canvas
    // node set here — the ONE place this filter applies. Never touches the
    // underlying journal/history data (Replay/Rapport read the journal
    // directly, not this reconciled node list), so archiving is honest:
    // additive and reversible in the data, only cosmetic on the live board.
    // W-DISMISS — a mission dismissed via the canvas context menu is
    // filtered here alongside `!m.archived` above (see this field's own
    // doc comment): always keyed `mission:<id>` regardless of whether this
    // particular mission currently renders as a plain mission or a loop
    // node, so a dismissal never needs re-deriving per render kind.
    // LazyBot missions (carrying botId) are rendered as bot nodes in the
    // dedicated LazyBots zone, NOT as agent mission nodes here — filtering
    // them avoids the duplicate node (one agent card + one bot card) that
    // confused users into thinking a regular agent was also running.
    missions: project.missions.filter((m) => !m.archived && !m.botId && !dismissedRefs.has(makeRef('mission', m.id))),
    drafts: drafts.filter((d) => d.projectId === project.projectId),
    scheduled: scheduled.filter((s) => s.projectId === project.projectId),
    notes: notes.filter((n) => n.projectId === project.projectId),
    routers: routers.filter((r) => r.projectId === project.projectId),
    joins: joins.filter((j) => j.projectId === project.projectId),
    surfaces: surfaces.filter((s) => s.projectId === project.projectId),
    frames: frames.filter((f) => f.projectId === project.projectId),
    approvalMode: project.approvalMode,
  }));

  // Transverse zone (spec §4.1): everything with no projectId, or whose
  // projectId belongs to a project that isn't currently open — only
  // materialized when it actually has children. Always LAST in
  // `zoneInputs` (matches layout.ts's own layoutAll ordering rule) so a
  // freshly-materialized Transverse zone packs after every real project,
  // never shoving one into a later row just because of array order.
  const openProjectIds = new Set(projects.map((p) => p.projectId));
  const belongsToTransverse = (projectId?: string) => !projectId || !openProjectIds.has(projectId);
  const transverseDrafts = drafts.filter((d) => belongsToTransverse(d.projectId));
  const transverseScheduled = scheduled.filter((s) => belongsToTransverse(s.projectId));
  const transverseNotes = notes.filter((n) => belongsToTransverse(n.projectId));
  const transverseRouters = routers.filter((r) => belongsToTransverse(r.projectId));
  const transverseJoins = joins.filter((j) => belongsToTransverse(j.projectId));
  const transverseSurfaces = surfaces.filter((s) => belongsToTransverse(s.projectId));
  const transverseFrames = frames.filter((f) => belongsToTransverse(f.projectId));

  if (
    transverseDrafts.length +
      transverseScheduled.length +
      transverseNotes.length +
      transverseRouters.length +
      transverseJoins.length +
      transverseSurfaces.length +
      transverseFrames.length >
    0
  ) {
    zoneInputs.push({
      projectId: TRANSVERSE_PROJECT_ID,
      root: '',
      name: 'Transverse',
      isActive: false,
      missions: [],
      drafts: transverseDrafts,
      scheduled: transverseScheduled,
      notes: transverseNotes,
      routers: transverseRouters,
      joins: transverseJoins,
      surfaces: transverseSurfaces,
      frames: transverseFrames,
    });
  }

  const zoneLayouts = zoneInputs.map((zone) => computeZoneLayout(zone, ctx));

  // P2-16 — recompacts PERSISTED same-row zone positions that were computed
  // under the OLD, oversized same-row gap formula (see reconcilerZones.ts's
  // `migrateBloatedZoneRowPositions` doc comment for the detection rule/why
  // this is safe) — a pinned zone's own position is otherwise NEVER revisited
  // once persisted, so existing layout.json data would stay stuck at the old
  // spacing forever. Applied to a LOCAL copy of `positions` (never mutated)
  // so the zone-vs-zone declutter pass right below sees the migrated
  // coordinates as its own starting point, and can still fix up any new
  // overlap the migration itself might introduce. Computed BEFORE
  // `packAutoPlacedZones` below (no dependency the other way) so the
  // auto-pack's own pinned-avoidance check (next) reasons against the
  // FINAL, already-migrated pinned rects, not their stale pre-migration
  // (possibly still bloated) footprint.
  const rowMigration = migrateBloatedZoneRowPositions(zoneLayouts, positions);
  const positionsAfterMigration = Object.keys(rowMigration).length > 0 ? { ...positions, ...rowMigration } : positions;

  // fix/canvas-auto-pack-avoid-pinned (David's round-6 real-profile finding
  // — see reconcilerZones.ts's `packAutoPlacedZones` doc comment for the
  // full "why") — every PINNED zone's own (post-migration) rect, so a
  // freshly shelf-packed row is never even offered a Y a pinned zone
  // already occupies, instead of only reactively nudging the pinned zone
  // out of the way after the fact (the declutter pass right below, which
  // still runs regardless — this is a proactive avoidance, not a
  // replacement for that safety net).
  const pinnedZoneRects = zoneLayouts
    .filter((result) => result.hasPersistedPosition)
    .map((result) => ({ ...(positionsAfterMigration[result.projectRef] ?? { x: 0, y: 0 }), ...result.size }));
  const packedPositions = packAutoPlacedZones(zoneLayouts, pinnedZoneRects);

  // fix/persisted-positions-declutter — PINNED x PINNED zone-vs-zone
  // declutter (reconcilerZones.ts's `declutterPinnedZones` doc comment for
  // the why/how — two projects each with their OWN persisted position can
  // still collide once their real full-card bbox outgrows the gap that
  // existed when those positions were saved).
  //
  // fix/canvas-auto-pack-avoid-pinned — this pass USED TO also seed every
  // already-resolved AUTO-packed zone rect (`packedPositions`, computed
  // just above) as an extra obstacle, so a decluttered PINNED zone would
  // additionally get nudged clear of AUTO zones too. That created a real
  // circular dependency once `packAutoPlacedZones` itself started reading
  // pinned positions (this SAME fix, see that function's own doc comment):
  // pinned position -> auto position (avoids pinned) -> [fed back here] ->
  // pinned correction (avoids auto) -> next reconcile pass sees a NEW
  // pinned position -> a NEW auto position -> a NEW pinned correction ...
  // — reconcilerConvergence.test.ts's own 150-seed fuzz property caught
  // this directly (seed 69: `project:zp1` oscillated between two positions
  // forever, never settling to an empty declutter patch). Removed: auto
  // zones now avoid pinned zones STRUCTURALLY, at the source
  // (`packAutoPlacedZones`'s own pinned-avoidance pass) — an auto zone can
  // never end up on a pinned zone's rect in the first place, so this
  // declutter pass never needs the extra nudge-away-from-auto obstacle to
  // begin with. Restores the one-directional flow that pass's own doc
  // comment explains is what makes it provably convergent: pinned positions
  // only ever depend on OTHER pinned positions (never on auto ones), so this
  // pass's own output can never feed back into `packAutoPlacedZones` on the
  // next call.
  const zoneDeclutter = declutterPinnedZones(zoneLayouts, positionsAfterMigration, sessionDraggedRefs);

  // fix/canvas-ux R10 — aggregate every zone's declutter corrections (see
  // reconcilerZones.ts's `ZoneLayoutResult.declutteredPositions` doc
  // comment) into one flat map for the caller to persist.
  const declutteredPositions: Record<NodeRef, { x: number; y: number }> = {};
  for (const result of zoneLayouts) {
    Object.assign(declutteredPositions, result.declutteredPositions);
  }
  // P2-16 — row-migration corrections persist through the SAME output map
  // (assigned before the declutter loop below so a ref the declutter pass
  // ALSO nudges — e.g. a new overlap the migration itself introduced — ends
  // up with the declutter's own final position, not the pre-declutter one).
  Object.assign(declutteredPositions, rowMigration);
  // fix/persisted-positions-declutter — zone-level corrections join the same
  // output map: the caller (useCanvasFlowGraph.ts) persists a corrected ZONE
  // position exactly like a corrected CHILD position — same NodeRef-keyed
  // mechanism, no separate plumbing needed.
  for (const ref of zoneDeclutter.movedRefs) {
    declutteredPositions[ref] = zoneDeclutter.positions.get(ref)!;
  }

  for (const result of zoneLayouts) {
    const position =
      zoneDeclutter.positions.get(result.projectRef) ??
      rowMigration[result.projectRef] ??
      positions[result.projectRef] ??
      packedPositions.get(result.projectRef) ??
      { x: 0, y: 0 };
    emitZone(result, position, ctx, out);
  }

  // ── LazyBot zone (additive, LazyBot canvas wave) ──────────────────────
  // A dedicated "LazyBots" group zone (mirroring the synthetic Transverse
  // zone) hosting every bot node. Bots are BotConfigs, not FleetMissions, so
  // this is emitted DIRECTLY (not through the project-zone machinery). It is
  // always rendered (even empty) so the surface stays discoverable; bot
  // children sit inside the group at simple grid cells.
  const botVmEdgesFromBots: CanvasReactFlowEdge[] = [];
  // Canvas always passes `bots` (possibly empty) so the LazyBots zone stays
  // visible and distinct from project agent zones. Tests that omit `bots`
  // keep the previous node set (no extra zone).
  if (inputs.bots !== undefined) {
    const LAZYBOTS_PROJECT_ID = 'lazybots';
    const botsZoneRef = makeRef('project', LAZYBOTS_PROJECT_ID);
    const groupCounts: ProjectNodeCounts = {
      running: bots.filter((b) => b.status === 'working').length,
      urgent: 0,
      review: bots.filter((b) => b.status === 'waiting').length,
      failed: bots.filter((b) => b.status === 'failed').length,
      done: bots.filter((b) => b.status === 'done').length,
      total: bots.length,
    };
    const BOT_GUTTER = 28;
    const BOT_COL_W = 248;
    const BOT_ROW_H = 176;
    const BOT_HEADER_H = 80;
    const cols = Math.max(1, Math.ceil(Math.sqrt(bots.length)));
    const rows = Math.max(1, Math.ceil(bots.length / cols));
    const zoneWidth = Math.max(220, cols * BOT_COL_W + BOT_GUTTER);
    const zoneHeight = BOT_HEADER_H + rows * BOT_ROW_H + BOT_GUTTER;
    const persistedBotPos = positions[botsZoneRef];
    const parkedInTheVoid = persistedBotPos?.x === 0 && persistedBotPos?.y === -340;
    let botsGroupPos = parkedInTheVoid ? undefined : persistedBotPos;
    if (!botsGroupPos) {
      // Default used to be (0, -340) — off-canvas for a typical viewport, and
      // `onlyRenderVisibleElements` culled the whole LazyBots zone so bots
      // looked like they didn't exist (they are not local agent missions).
      const siblingProjects = out.nodes.filter((n) => n.type === 'project');
      if (siblingProjects.length > 0) {
        const minX = Math.min(...siblingProjects.map((n) => n.position.x));
        const minY = Math.min(...siblingProjects.map((n) => n.position.y));
        botsGroupPos = { x: minX - zoneWidth - 80, y: minY };
      } else {
        botsGroupPos = { x: 0, y: 0 };
      }
      declutteredPositions[botsZoneRef] = botsGroupPos;
    }
    const groupData: ProjectNodeData = {
      projectId: LAZYBOTS_PROJECT_ID,
      root: '',
      name: 'LazyBots',
      color: '#7C5CFF',
      collapsed: collapsed[LAZYBOTS_PROJECT_ID] === true,
      isActive: false,
      counts: groupCounts,
      hasChildren: bots.length > 0,
      laneMode: prefs.laneMode,
    };
    out.nodes.push({
      id: botsZoneRef,
      type: 'project',
      position: botsGroupPos,
      width: zoneWidth,
      height: zoneHeight,
      data: groupData as ProjectNodeData & Record<string, unknown>,
    });
    out.renderedIds.add(botsZoneRef);
    const botVmEdges: CanvasReactFlowEdge[] = [];
    bots.forEach((b, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const data: BotNodeData = {
        bot: b.bot,
        status: b.status,
        activeRuns: b.activeRuns,
        ...(b.activeRunIds !== undefined ? { activeRunIds: b.activeRunIds } : {}),
        ...(b.lastAction !== undefined ? { lastAction: b.lastAction } : {}),
      };
      const botRef = makeRef('bot', b.bot.id);
      out.nodes.push({
        id: botRef,
        type: 'bot',
        position: {
          x: botsGroupPos.x + BOT_GUTTER + col * BOT_COL_W,
          y: botsGroupPos.y + BOT_HEADER_H + row * BOT_ROW_H,
        },
        width: BOT_COL_W - BOT_GUTTER,
        height: BOT_ROW_H,
        data,
      });
      out.renderedIds.add(botRef);

      // Connected VM window: a `botVm` node shown to the RIGHT of its bot node,
      // tethered by a quiet hierarchy edge (same contract as local agents'
      // connected live windows — TerminalNode/PreviewNode). The node is
      // top-level (draggable away from the LazyBots zone if the user wants).
      if (b.vmOpen) {
        const vmRef = makeRef('botVm', b.bot.id);
        const vmSize = b.vmSize ?? BOT_VM_WINDOW_DEFAULT_SIZE;
        const vmPos = positions[vmRef];
        out.nodes.push({
          id: vmRef,
          type: 'botVm',
          zIndex: 20,
          width: vmSize.width,
          height: vmSize.height,
          position: vmPos ?? {
            x: botsGroupPos.x + BOT_GUTTER + col * BOT_COL_W + BOT_COL_W + 24,
            y: botsGroupPos.y + BOT_HEADER_H + row * BOT_ROW_H,
          },
          data: {
            botId: b.bot.id,
            botName: b.bot.name,
            status: b.status,
            width: vmSize.width,
            height: vmSize.height,
          } as BotVmNodeData,
        });
        out.renderedIds.add(vmRef);
        botVmEdges.push({
          id: `hierarchy:bot:${b.bot.id}:vm`,
          type: 'hierarchy',
          source: botRef,
          target: vmRef,
          data: {},
        });
      }
    });
    botVmEdgesFromBots.push(...botVmEdges);
  }

  const rawEdges = [
    ...botVmEdgesFromBots,
    ...buildHierarchyEdges(allMissionsForFold, missionLoopMeta, out.renderedIds),
    ...buildIterationEdges(out.renderedIds, out.nodes),
    ...buildSurfaceEdges(surfaces, out.renderedIds),
    ...buildChainEdges(chains, out.renderedIds, nowMs, hiddenMissionIds, missionLoopMeta, routers),
    ...buildCollisionEdges(allMissionsForFold, out.renderedIds),
  ];

  // Ghost-edge backstop (2026-08-04 live dogfood: canvas still rendered ~35
  // `ctrl:<from>-><to>` control edges plus some legacy `e-N` edges after
  // every draft from an old plan was deleted, 0 drafts rendered — the
  // deleted drafts' Chain records outlive the drafts themselves, since
  // canvasStore.ts's `removeDraft` filters `state.drafts` only and never
  // cascades into `state.chains`/`state.joins`, unlike the more careful
  // `acceptProposedSteps`/`rejectProposedPlan` cleanup that DOES drop a
  // proposed chain once its draft is gone). Every buildXEdges() above
  // already resolves its OWN endpoints against `out.renderedIds` before
  // emitting (buildChainEdges additionally collapses a HALF-missing chain
  // to a tombstoned self-loop rather than dropping it outright —
  // reconcilerEdges.ts's `resolveTombstoneEndpoints`), so this filter is
  // redundant for every edge kind built above today. It stays a real
  // backstop rather than dead code: the SAME single choke point every edge
  // reaches regardless of which builder produced it (same "hard backstop"
  // precedent as the id-dedup pass right below) — a future edge kind never
  // has to re-derive this invariant correctly on its own, and a
  // hand-rolled or legacy-migrated Chain that somehow skipped
  // `buildChainEdges` can never render dangling. A tombstoned self-loop
  // always passes (source === target === the one surviving, rendered ref),
  // so this can never re-introduce the "floating chip in the void" Defect
  // #9 already fixed — it only drops an edge whose endpoint(s) reference a
  // node that plainly does not exist in THIS render pass.
  const renderableEdges = rawEdges.filter((edge) => out.renderedIds.has(edge.source) && out.renderedIds.has(edge.target));

  // 2026-08-04 (UC3 dogfood — the canvas rendered DUPLICATED edges, e.g.
  // `e-0` three times, the owner's "y a des arêtes partout"): the
  // plan-to-canvas pipeline used to mint per-compile counter ids
  // (`e-0..e-9` restarted per compile — fixed upstream in
  // compileOrchestrator.ts to deterministic endpoint ids), but a canvas
  // can still legally hold TWO chain sets with colliding ids (a leftover
  // superseded preview plus the validated plan, pre-cleanup), and React
  // Flow renders every object of the `edges` array verbatim — duplicate
  // ids render as visually doubled arrows. Hard backstop here, at the
  // single choke point every edge reaches: first occurrence of an id
  // wins, later duplicates are dropped (the persisted Chain[] itself is
  // untouched — only this render pass dedupes).
  const seenEdgeIds = new Set<string>();
  const edges: CanvasReactFlowEdge[] = [];
  for (const edge of renderableEdges) {
    if (seenEdgeIds.has(edge.id)) continue;
    seenEdgeIds.add(edge.id);
    edges.push(edge);
  }

  return { nodes: out.nodes, edges, declutteredPositions };
}

// ── Scheduled agents -> ScheduleNodeData (pure mapper) ────────────────
//
// SEAM for W1c: `listAgents()` (agentsStorage.ts) is async/Tauri-backed —
// this reconciler stays pure, so W1c owns loading `StoredAgent[]` (e.g. on
// an interval or on agent-library changes) and passing the result through
// this mapper before feeding `reconcile()`'s `scheduled` input. No UI is
// built here per the task's instruction.

/**
 * Derives {@link ScheduleNodeData} from every agent-library def that has a
 * cron trigger (`triggers.schedule`). `activeProjectId` is used for
 * project-scope agents (see agentDef.ts's `AgentScope`) — `listAgents()`
 * itself has no per-project filter (it returns whatever the CURRENTLY open
 * project's `.lazy/agents/` + the user-scope `~/.lazy/agents/` contain), so
 * a `scope: 'project'` entry belongs to whichever project was active when
 * it was loaded. `scope: 'user'` agents have no single owning project —
 * `projectId` stays undefined, which places them in the Transverse zone
 * (matches ScheduleNodeData.projectId's own doc comment: "Absent for a
 * cross-project / Transverse-zone schedule").
 */
export function scheduledAgentsToNodeData(
  agents: readonly StoredAgent[],
  activeProjectId: string | undefined,
  nowMs: number = Date.now(),
): ScheduleNodeData[] {
  const result: ScheduleNodeData[] = [];
  for (const stored of agents) {
    const schedule = stored.agent.triggers.schedule;
    if (!schedule) continue;
    result.push({
      scheduleId: stored.agent.id,
      agentName: stored.agent.name,
      cron: schedule.cron,
      cronLabel: formatCron(schedule.cron),
      nextRunMs: schedule.enabled ? computeNextRunMs(schedule.cron, nowMs) : undefined,
      enabled: schedule.enabled,
      projectId: stored.scope === 'project' ? activeProjectId : undefined,
    });
  }
  return result;
}

/**
 * Epoch-ms port of scheduleUtils.ts's `nextCronRun` date math (that module
 * only exposes a formatted STRING, not an epoch — duplicating the small
 * subset needed here rather than reaching into its private helpers; a
 * follow-up could export an epoch-returning variant from scheduleUtils.ts
 * instead). Same deliberately narrow support: 5-part cron, minute/hour
 * exact-or-'*', optional day-of-week filter; anything else -> `undefined`
 * (never a wrong guess).
 */
function computeNextRunMs(cron: string, nowMs: number): number | undefined {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minutePart, hourPart, , , dayOfWeekPart] = parts;

  const minute = minutePart === '*' ? new Date(nowMs).getMinutes() : Number.parseInt(minutePart, 10);
  if (Number.isNaN(minute)) return undefined;

  const next = new Date(nowMs);
  next.setSeconds(0, 0);

  if (hourPart === '*') {
    next.setMinutes(next.getMinutes() + 1);
    return next.getTime();
  }

  const hour = Number.parseInt(hourPart, 10);
  if (Number.isNaN(hour)) return undefined;

  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);

  if (dayOfWeekPart !== '*') {
    const allowedDays = expandDayOfWeek(dayOfWeekPart);
    if (allowedDays.length > 0) {
      let attempts = 0;
      while (!allowedDays.includes(next.getDay()) && attempts < 8) {
        next.setDate(next.getDate() + 1);
        next.setHours(hour, minute, 0, 0);
        attempts += 1;
      }
    }
  }

  return next.getTime();
}

function expandDayOfWeek(part: string): number[] {
  if (part === '*') return [];
  if (part.includes('-')) {
    const [start, end] = part.split('-').map(Number);
    const days: number[] = [];
    for (let d = start; d <= end; d += 1) days.push(d);
    return days;
  }
  return part
    .split(',')
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}
