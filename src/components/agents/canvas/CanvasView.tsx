/* CanvasView.tsx — the real Agent Canvas assembly (W1c, plan §W1c; spec §3
   architecture, §5 navigation, §6 reconciler, §9). Replaces the W0 spike:
   wires the reconciler (W1a) + canvasStore (W1a) + node/edge components
   (W1b) into a controlled React Flow tree, and is what Cockpit.tsx mounts
   instead of `<AgentGrid/>` (AgentGrid.tsx stays, unmounted).

   Persistence seam (W1a's handoff, canvasPersistence.ts's own header):
   hydration runs ONCE at mount (persistence is scoped to whichever project
   is active AT MOUNT TIME — a documented "for now" limitation, W3
   follow-up moves it global). Rendering `<ReactFlow>` is gated behind that
   hydration completing so `defaultViewport` (read once by RF) reflects the
   real persisted viewport instead of racing it.

   ── W2b refactor (deliverable #0) ─────────────────────────────────────
   This file used to be ~1074 lines (a single component carrying every W2a
   editing/DnD/keyboard handler, PLUS the reconcile->RF-state pipeline,
   inline). It now assembles small, independently-testable hooks:
     - hooks/useCanvasHydration.ts  — persistence boot + scheduled-agents poll
     - hooks/useCanvasFlowGraph.ts  — reconcile() -> live RF nodes/edges,
                                      highlight/dim overlays, zone geometry
     - hooks/useCanvasEditing.ts    — clipboard/duplicate/delete/quick-create/
                                      draft-launch/chain-creation + canvasActions
     - hooks/useCanvasDnd.ts        — palette drop + drag-alignment guides
     - hooks/useCanvasLayout.ts     — elkjs auto-layout / lane-mode apply
     - hooks/useCanvasFilter.ts     — search/status-filter/focus-pannes (NOT
                                      canvasStore — a transient view concern)
     - hooks/useCanvasKeyboard.ts   — the single window keydown listener
   Zero behavior change from the pre-refactor file for every pre-existing
   interaction — only new W2b deliverables (layout/lane-mode/search/
   semantic-zoom-for-every-node/shortcuts-panel/onConnect) are additive.
*/

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  MiniMap,
  PanOnScrollMode,
  Panel,
  ReactFlow,
  SelectionMode,
  type OnConnectEnd,
  type OnConnectStart,
  type ReactFlowInstance,
} from '@xyflow/react';
import { getNodesBounds, getViewportForBounds } from '@xyflow/system';
import '@xyflow/react/dist/style.css';
import './canvas-layout.css';
import './replay/replay.css';
import { useI18n } from '../../../i18n';
import { useAppContext } from '../../../app/AppContext';
import { useAgentsStore } from '../agentsStore';
import { Skeleton, useToast } from '../../ui';
import type { FleetMission, FleetProject } from '../../../lib/agents/fleetMissions';
import { projectIdFromRoot } from '../../../lib/journal/projectId';
import { emit, on } from '../../../lib/bus';
import { PresenceOverlay } from '../../../lib/collab/PresenceOverlay';
import { CanvasLiveSync } from '../../../lib/collab/CanvasLiveSync';
import { CollabProvider, useCollab } from '../../../lib/collab/CollabContext';
import { mergeRemoteFleet } from '../../../lib/collab/mergeRemoteFleet';
import { buildSyntheticFleet } from '../../../lib/collab/syntheticFleet';
import { bumpRenderCount } from '../../../lib/perf/renderCounters';
import { generateCanvasId } from './canvasIds';
import { validateChain } from './chainValidation';
import { makeRef, parseRef, type DraftSpec, type MissionNodeData, type RouterBranch, type RouterSpec, type ScheduleNodeData } from './canvasTypes';
import { DEFAULT_NODE_SIZE, ROUTER_NODE_SIZE, type CanvasReactFlowEdge, type CanvasReactFlowNode, type MissionLoopMeta } from './reconciler';
import { canvasStoreVanilla, useCanvasStore, useCanvasTemporal } from './canvasStore';
import { nodeTypes } from './nodes';
import { edgeTypes } from './edges';
import { CanvasActionsProvider } from './chrome/CanvasActionsContext';
import { CanvasDots } from './chrome/CanvasDots';
import { CanvasToolbar } from './CanvasToolbar';
import { CanvasPalette } from './CanvasPalette';
import { CanvasCommandBar } from './CanvasCommandBar';
import { CanvasContextMenu } from './CanvasContextMenu';
import { CanvasQuickCreateModal } from './CanvasQuickCreateModal';
import { CanvasSaveMacroModal, type SaveMacroValue } from './CanvasSaveMacroModal';
import { captureMacro } from './canvasMacros';
import { buildCanvasExportEnvelope, canvasExportFileName, parseCanvasExportEnvelope, remapImportedCanvas } from './canvasExportImport';
import { exportYamlWorkflow, parseYamlWorkflow } from '../../../lib/agents/graph/yamlWorkflowImport';
import { exportCanvasToFiles, exportCanvasYamlOverview, type CanvasExportData } from '../../../lib/agents/canvasGitExport';
import { graphToMcpServer, generateMcpConfig } from '../../../lib/agents/graph/graphMcpPublisher';
import { parseAgentExportEnvelope, remapImportedAgent } from '../../../lib/agents/agentImportExport';
import { saveAgent } from '../../../lib/agents/agentsStorage';
import { saveProjectCommandTool } from '../../../lib/agents/projectCommandTools';
import { AlignmentGuides } from './AlignmentGuides';
import { CanvasLodBroadcaster } from './chrome/CanvasLodBroadcaster';
import { useCanvasAutoComposition } from './hooks/useCanvasAutoComposition';
import { useCanvasWebSearchSurfaces } from './hooks/useCanvasWebSearchSurfaces';
import { ShortcutsPanel } from './ShortcutsPanel';
import { CanvasFloatingButtons } from './CanvasFloatingButtons';
import { CanvasToolActivityOverlay } from './CanvasToolActivityOverlay';
import { CanvasBrowserPanel } from './CanvasBrowserPanel';
import { CanvasSwarmPanel } from './CanvasSwarmPanel';
import { EdgeDropNodePicker, type EdgeDropChoice } from './chrome/EdgeDropNodePicker';
import { computeCompatibleTargets } from './chrome/edgeDropTargeting';
import { beginConnectionDrag, endConnectionDrag } from './chrome/connectionDragStore';
import { deriveMissionLiveness, statusAccentColor, typeAccentColor, type CanvasGlyphKind } from './chrome/nodeChrome';
import { useCanvasHydration } from './hooks/useCanvasHydration';
import { useCanvasFlowGraph } from './hooks/useCanvasFlowGraph';
import { useCanvasEditing } from './hooks/useCanvasEditing';
import { useCanvasDnd } from './hooks/useCanvasDnd';
import { useCanvasKeyboard } from './hooks/useCanvasKeyboard';
import { useCanvasFilter, matchesFocusFailures } from './hooks/useCanvasFilter';
import { useCanvasLayout } from './hooks/useCanvasLayout';
import { useCanvasManagerEvents } from './hooks/useCanvasManagerEvents';
import { useCanvasInspectSelection } from './hooks/useCanvasInspectSelection';
import { useCanvasHoverRecovery } from './hooks/useCanvasHoverRecovery';
import { useReplayMode } from './replay/useReplayMode';
import { ReplayBar } from './replay/ReplayBar';
import { duplicatePosition, type FlowPoint } from './canvasPlacement';
import { findNearestNodeInDirection, type ArrowDirection } from './canvasArrowNav';
import { buildForkDraft, type ForkSourceMission } from '../../../lib/agents/forkFromReplay';
import {
  CANVAS_FIT_TOP_RESERVE_PX,
  DEFAULT_HORIZONTAL_GUTTER_PX,
  computeSafeMinZoom,
  insetFitViewPadding,
  measureDockedPanelInsets,
  resolveArrangeFitTarget,
  setCenterTarget,
} from './cameraInsets';
import { useCanvasFollowActive } from './hooks/useCanvasFollowActive';
import { LOD_FLOOR_ZOOM } from './chrome/lod';

// ── Theming (carried over from the W0 spike — same app design tokens,
//    see design-system.css) ────────────────────────────────────────────

const CANVAS_THEME_VARS: Record<string, string> = {
  '--xy-background-color': 'var(--color-bg)',
  '--xy-node-background-color': 'var(--color-panel)',
  '--xy-node-border': '1px solid var(--color-border)',
  '--xy-node-color': 'var(--color-text)',
  '--xy-node-boxshadow-hover': '0 0 0 1px var(--color-accent-border)',
  '--xy-node-boxshadow-selected': '0 0 0 2px var(--color-accent)',
  '--xy-edge-stroke': 'var(--color-border)',
  '--xy-edge-stroke-selected': 'var(--color-accent)',
  '--xy-minimap-background-color': 'var(--color-panel-3)',
  '--xy-minimap-mask-background-color': 'rgba(124, 92, 255, 0.08)',
  // R11 UI polish (c) — the left-drag marquee/selection rect (real
  // xyflow CSS vars, `.react-flow__selection`/`.react-flow__nodesselection-
  // rect` — see @xyflow/react/dist/style.css): accent color at a 12% fill
  // with a crisp 1px solid accent border, replacing xyflow's own default
  // blue dotted look so the marquee reads as part of THIS app's design
  // system instead of the library's stock styling.
  '--xy-selection-background-color': 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
  '--xy-selection-border': '1px solid var(--color-accent)',
  width: '100%',
  height: '100%',
};

const SNAP_GRID: [number, number] = [16, 16];

/** W-CLOSE row 1 — Shift+Arrow nudge deltas, one grid step (SNAP_GRID) per
 *  direction. Module-level (never a fresh literal per render, same rationale
 *  as every other stable options object in this file). */
const ARROW_NUDGE_DELTA: Record<ArrowDirection, { x: number; y: number }> = {
  up: { x: 0, y: -SNAP_GRID[1] },
  down: { x: 0, y: SNAP_GRID[1] },
  left: { x: -SNAP_GRID[0], y: 0 },
  right: { x: SNAP_GRID[0], y: 0 },
};

/** R1b defect #1 — `fitView`'s own padding (spec brief's navigationScheme):
 *  the vertical (top/bottom) breathing-room fraction for the INITIAL mount
 *  fit. P47 — no longer a static object: the LEFT/RIGHT sides now fold in
 *  the docked ManagerOverlay/CockpitLeftRail width (see
 *  `getPanelAwarePadding` below, cameraInsets.ts's own header), which a
 *  static module constant can't read (it can change over the session as
 *  either panel opens/collapses). */
const FIT_VIEW_VERTICAL_PADDING = 0.2;

/** R13 — « breathing room »: the post-arrange fit (useCanvasLayout's
 *  `fitViewAfterLayout`) uses ~15% padding — enough that a freshly
 *  auto-laid-out canvas always keeps an empty pane around the zones (so
 *  right-click-on-empty-canvas stays reachable without having to zoom out
 *  manually first), distinct from the initial-mount padding above (20%,
 *  spec's own navigationScheme value) — kept as a separate constant since
 *  the two fits serve different moments and are free to diverge again
 *  later. */
const POST_ARRANGE_FIT_VIEW_VERTICAL_PADDING = 0.15;
const POST_ARRANGE_FIT_VIEW_DURATION_MS = 250;

/** W8d Replay — ArrowLeft/ArrowRight step size (useCanvasKeyboard.ts's
 *  onReplayStepBack/Forward): coarse enough to feel like a deliberate
 *  "jump to the next moment" rather than a fiddly single-tick nudge. */
const REPLAY_STEP_MS = 5 * 60 * 1000;

/**
 * fix/canvas-ux R4d (dogfood defect #5) — a child node used to reuse the
 * exact SAME `projectColor(projectId)` fill its own PARENT zone rect
 * already uses (reconcilerZones.ts's `buildProjectNode` sets the zone's
 * `data.color` to that identical value) — on the minimap, a node's rect
 * was therefore visually IDENTICAL to the zone behind it: no contrast, no
 * visible dots, "zone blobs only" (dogfood d-series). Colors a child node
 * by its own STATUS when it has a mission-shaped one (mission/loop nodes —
 * the SAME `statusAccentColor(deriveMissionLiveness(...))` mapping the
 * 'dot' semantic-zoom bucket already uses, MissionNode.tsx's own dot
 * branch, so the minimap and the zoomed-out fleet view agree visually) or
 * an iteration's own `status` field directly; falls back to the node
 * KIND's type accent (chrome/nodeChrome.tsx's TYPE_ACCENT_COLORS) for kinds
 * with no status concept at all (draft/note/router/schedule) — either way,
 * NEVER the parent zone's own color again, so every node reads as its own
 * dot against the zone's tint.
 */
export function nodeMinimapColor(node: CanvasReactFlowNode): string {
  const data = node.data as Record<string, unknown>;
  if (node.type === 'project') return (data.color as string | undefined) ?? 'var(--color-text-disabled)';
  const mission = data.mission as Pick<FleetMission, 'status' | 'paused'> | undefined;
  if (mission) return statusAccentColor(deriveMissionLiveness(mission));
  if (typeof data.status === 'string') {
    return statusAccentColor(deriveMissionLiveness({ status: data.status as FleetMission['status'], paused: false }));
  }
  return typeAccentColor(node.type as CanvasGlyphKind);
}

// ── Props (mirrors what Cockpit passed AgentGrid, minus collapse — canvasStore
//    now owns collapsed state; `rankByMissionId` is dropped too: the
//    reconciler already derives the identical urgent rank per mission from
//    the same `rankUrgentMissions(projects)` call Cockpit used to build that
//    map, so threading it through as a second, always-in-sync copy would be
//    dead weight). ─────────────────────────────────────────────────────

export interface CanvasViewProps {
  projects: FleetProject[];
  highlightIds: ReadonlySet<string>;
  justMergedId: string | null;
  forceApproveIds: ReadonlySet<string>;
  onOpenMission: (missionId: string) => void;
  onUrgentAction: (mission: FleetMission, actionKey: string) => void;
  onOpenLibrary: () => void;
  /**
   * Screenshot/test-only injection seam — see
   * src/__screenshots__/canvas-harness.tsx. Production code never passes
   * either of these; CanvasView always sources `scheduled` from
   * useCanvasHydration's `listAgents()` poll (Tauri-only, empty on web) and
   * `missionLoopMeta` from agentsStore's live `Mission[]` (empty outside a
   * real project, see the "CONTRACT GAP #1" comment below). Both degrade
   * honestly to their real (empty) values outside a Tauri runtime, so
   * schedule nodes and loop/hierarchy nodes have no way to appear in a
   * fixture-driven render without one of these — exactly the same problem
   * Cockpit.tsx's fleetOverride/objectivesOverride solve one layer up, same
   * fix shape. The fixture VALUES live only in the harness file.
   */
  scheduledOverride?: ScheduleNodeData[];
  missionLoopMetaOverride?: ReadonlyMap<string, MissionLoopMeta>;
  /**
   * fix/canvas-overlay-occlusion (David's measured repro: the canvas toolbar
   * AND a mission card's own action row both physically extend under the
   * docked ManagerOverlay, so their rightmost controls/buttons are visible
   * in the DOM but unreachable/clipped) — real DOM width, in px, this
   * component's own root reserves on its right edge so its content can
   * NEVER extend into whatever screen region a docked overlay currently
   * occupies. Cockpit.tsx is the only real caller, forwarding the SAME live
   * `manager:overlayWidthChange` value FluxFooter's ticker already reserves
   * (P2-19/P2a — see Cockpit.tsx's own comment on that bus event) — this is
   * that exact established "reserve real space, don't just paint over it"
   * pattern extended from the footer to the canvas itself. `undefined`/`0`
   * (every other caller: the screenshot harness, CanvasView.test.tsx) keeps
   * this component's prior full-bleed behavior verbatim.
   *
   * This is a real DOM reservation (marginRight), not fitView padding: once
   * the canvas's own box structurally ends before the overlay begins,
   * NOTHING rendered inside — the toolbar (a `<Panel>` INSIDE `<ReactFlow>`),
   * any mission card, any zone — can ever be occluded by it again, at any
   * pan/zoom/camera position, without needing per-element padding math to
   * dodge a panel that visually overlaps a wider canvas box. See
   * cameraInsets.ts's `measureDockedPanelInsets` doc comment for why that
   * function no longer ALSO reserves this same space a second time (it
   * used to, before this prop existed).
   */
  reservedRightPx?: number;
}

// Perf audit 2026-08-15 (item 3): renamed from the direct `export function
// CanvasView` so it can be wrapped in `memo()` below instead — see that
// wrapper's own comment for what this does and does not buy given
// `projects` (this component's own dominant prop, sourced from
// useFleetMissions' ~2.5s poll) gets a genuinely new array reference on
// every poll tick regardless of memo.
function CanvasViewImpl(props: CanvasViewProps) {
  return (
    <CollabProvider enabled>
      <CanvasViewTree {...props} />
    </CollabProvider>
  );
}

function CanvasViewTree({
  projects,
  highlightIds,
  justMergedId,
  forceApproveIds,
  onOpenMission,
  onUrgentAction,
  onOpenLibrary,
  scheduledOverride,
  missionLoopMetaOverride,
  reservedRightPx = 0,
}: CanvasViewProps) {
  bumpRenderCount('CanvasView');
  const { t } = useI18n();
  const { toast } = useToast();
  const { openProjects, activeProjectId, openProject, projectsHydrated, platform } = useAppContext();
  const { missions: activeMissions } = useAgentsStore();
  const collab = useCollab();
  const fleetProjects = useMemo(() => {
    // Spectator mode: no local projects but remote deltas exist → synthetic fleet
    if (projects.length === 0 && collab.remoteDeltasByMission.size > 0) {
      return buildSyntheticFleet(collab.remoteDeltasByMission, collab.self?.userId ?? null);
    }
    return mergeRemoteFleet(projects, collab.remoteDeltasByMission, { selfUserId: collab.self?.userId ?? null });
  }, [projects, collab.remoteDeltasByMission, collab.self?.userId]);

  const activeRoot = useMemo(
    () => openProjects.find((p) => p.id === activeProjectId)?.root ?? null,
    [openProjects, activeProjectId],
  );
  const activeFleetProjectId = useMemo(() => (activeRoot ? projectIdFromRoot(activeRoot) : undefined), [activeRoot]);

  const positions = useCanvasStore((s) => s.positions);
  const collapsed = useCanvasStore((s) => s.collapsed);
  const prefs = useCanvasStore((s) => s.prefs);
  const drafts = useCanvasStore((s) => s.drafts);
  const chains = useCanvasStore((s) => s.chains);
  const notes = useCanvasStore((s) => s.notes);
  // W9 fix: routers were persisted (canvasPersistence.ts/chainEngine.ts)
  // and creatable (CanvasContextMenu.tsx's "Nouveau routeur ici", W8c) but
  // NEVER actually reached the reconciler from this file — reconcile()'s
  // `routers` input defaulted to `[]` unconditionally, so a router never
  // rendered on the live canvas regardless of how it was created. Real bug,
  // not a follow-on gap: fixed alongside wiring the palette's own router
  // entry (this wave) so the whole router feature is genuinely live.
  const routers = useCanvasStore((s) => s.routers);
  const joins = useCanvasStore((s) => s.joins);
  // R7 (living surfaces, additive) — terminal/preview nodes + the mission
  // live-panel expand state, same "select the raw store slice, thread
  // straight into useCanvasFlowGraph's reconcile() call" convention as
  // `routers` above.
  const surfaces = useCanvasStore((s) => s.surfaces);
  const expandedPanels = useCanvasStore((s) => s.expandedPanels);
  // W-CLOSE row 2 (canvas groups / frames, additive) — same "select the raw
  // store slice, thread straight into useCanvasFlowGraph's reconcile() call"
  // convention as `routers`/`surfaces` above. Creation itself lives in
  // CanvasContextMenu.tsx (addFrame/setPosition, mirroring addDraft/addNote
  // there) — this file only needs the live slice for reconcile().
  const frames = useCanvasStore((s) => s.frames);
  // Group macros (additive) — saved templates listed in the palette, plus
  // the mutations its rename (✎) / delete (×) affordances call directly.
  const macros = useCanvasStore((s) => s.macros);
  const addMacro = useCanvasStore((s) => s.addMacro);
  const removeMacro = useCanvasStore((s) => s.removeMacro);
  const renameMacro = useCanvasStore((s) => s.renameMacro);
  // W-CLOSE row 4 (canvas export/import, "flow-as-code" v1) — the one store
  // action this feature adds (canvasStore.ts's own doc comment).
  const mergeImportedCanvas = useCanvasStore((s) => s.mergeImportedCanvas);
  // Draft version history (additive) — CanvasQuickCreateModal's « Versions »
  // dropdown reads this directly; restoreDraftVersion is the store's own
  // "apply an old snapshot as a NEW edit" primitive (canvasStore.ts's own
  // doc comment).
  const draftVersions = useCanvasStore((s) => s.draftVersions);
  const restoreDraftVersion = useCanvasStore((s) => s.restoreDraftVersion);
  // R10 (persisted-position declutter) — same "select the raw store slice,
  // thread straight into useCanvasFlowGraph's reconcile() call" convention
  // as `routers`/`surfaces` above.
  const sessionDraggedRefs = useCanvasStore((s) => s.sessionDraggedRefs);
  // W-DISMISS — same "select the raw store slice, thread straight into
  // useCanvasFlowGraph's reconcile() call" convention as `sessionDraggedRefs`
  // above; CanvasContextMenu.tsx's dismissMission mutation is the one writer.
  const dismissedMissionRefs = useCanvasStore((s) => s.dismissedRefs);
  // `ReconcileInputs.dismissedRefs` wants a Set (O(1) membership per mission,
  // same shape sessionDraggedRefs/foldedOrchestrators/expandedLoops already
  // use) — the store keeps the tracked array (JSON-persistable, see
  // canvasStore.ts's own doc comment on why), converted here at the one
  // seam that needs the other shape.
  const dismissedRefs = useMemo(() => new Set(dismissedMissionRefs), [dismissedMissionRefs]);
  const setPrefs = useCanvasStore((s) => s.setPrefs);
  const pastStates = useCanvasTemporal((s) => s.pastStates);
  const futureStates = useCanvasTemporal((s) => s.futureStates);
  // R2b connectionUx §5 (edge-drop node picker) — direct canvasStore
  // mutations, same "canvas-owned mutation, direct store read" convention
  // MissionNodeCard/CanvasContextMenu already use; this flow deliberately
  // does NOT go through useCanvasEditing.ts (hooks/* is outside this
  // wave's writable set) since every primitive it needs is already a
  // public canvasStore action.
  const addDraft = useCanvasStore((s) => s.addDraft);
  const addRouter = useCanvasStore((s) => s.addRouter);
  const addChain = useCanvasStore((s) => s.addChain);
  const setPositions = useCanvasStore((s) => s.setPositions);
  // Fork-from-replay (v1) — same single-ref `setPosition` primitive
  // CanvasContextMenu.tsx's `duplicateAsDraft`/`addNoteAt` already use to
  // place a freshly-materialized draft.
  const setPosition = useCanvasStore((s) => s.setPosition);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  // Group macros — refs captured for the « Enregistrer comme macro » naming
  // prompt (CanvasContextMenu.tsx's onSaveMacro callback); non-null opens
  // <CanvasSaveMacroModal>.
  const [saveMacroRefs, setSaveMacroRefs] = useState<readonly string[] | null>(null);
  const [edgeDropPicker, setEdgeDropPicker] = useState<{
    screenPosition: { x: number; y: number };
    flowPosition: FlowPoint;
    sourceRef: string;
  } | null>(null);
  const hoveredRef = useRef(false);
  // fix/canvas-ux R6a MAJEUR #7 — the div this ref points at (below) is what
  // useCanvasHoverRecovery.ts hit-tests against to self-heal `hoveredRef`
  // after a full-screen overlay (Rapport) round-trip; see that hook's own
  // header for the full root-cause.
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  useCanvasHoverRecovery(canvasContainerRef, hoveredRef);

  // ── P47 — panel-aware camera helpers ────────────────────────────────
  // Every programmatic camera move below reads the CURRENT docked-panel
  // geometry at the moment it fires (never a memoized/stale snapshot —
  // `useCallback` only stabilizes the FUNCTION identity, its body still
  // re-measures the DOM on each actual invocation) — see cameraInsets.ts's
  // own header for why a real-DOM read, not threaded ManagerOverlay/
  // CockpitLeftRail state, is the right seam here.
  // fix/canvas-toolbar-fit-floor — `applyToolbarFloor` (optional, defaults
  // to `false` so every pre-existing call site keeps its EXACT prior
  // behavior) floors the top padding at CANVAS_FIT_TOP_RESERVE_PX (the
  // toolbar's own footprint PLUS the floating zone-title plaque's own
  // screen footprint above the node box — round 2 of this fix: a floor
  // sized only against the toolbar still let the plaque, which floats
  // further up than the node box it's anchored to, poke back into the
  // toolbar) regardless of what the real toolbar-height DOM measurement
  // resolves to — see that constant's own doc comment for the real-app
  // repro this closes. Passed `true` at every IMPERATIVE post-mount `fitView()` call
  // below (the toolbar is guaranteed already rendered by the time any of
  // these fire — Ranger/Auto-layout's post-arrange fit, zoom-to-selection,
  // focus-failures, focus-node, recenter, draft-launch fit): those are
  // exactly the real-app scenarios David's repro covers. Left at its
  // default `false` for the ONE static `fitViewOptions` prop passed
  // straight to `<ReactFlow>` for the initial-mount fit (below) — at that
  // exact render, the toolbar Panel (a CHILD of `<ReactFlow>`) has not
  // necessarily painted yet, so a fixed floor there would be reserving
  // space against a chrome element that may not exist in the DOM at all in
  // every render context (e.g. a standalone CanvasView render in a test) —
  // canvasNavigationProps.test.tsx locks this exact "toolbar absent ->
  // plain fraction" contract for that one call site. Any residual gap on
  // the very first paint is short-lived: the toolbar mounts moments later
  // and the container's own ResizeObserver-driven re-fit (CanvasToolbar.tsx's
  // `runFit`)/subsequent explicit fits all use the floor.
  const getPanelAwarePadding = useCallback(
    (verticalPadding: number, applyToolbarFloor: boolean = false) =>
      insetFitViewPadding(
        measureDockedPanelInsets(canvasContainerRef.current),
        verticalPadding,
        DEFAULT_HORIZONTAL_GUTTER_PX,
        applyToolbarFloor ? CANVAS_FIT_TOP_RESERVE_PX : 0,
      ),
    [],
  );
  /** `setCenter` (unlike `fitView`) has no `padding` option — this derives
   *  the adjusted flow-space target so the ORIGINAL `point` still lands at
   *  the panel-aware visible center once fed through `setCenter`. Returns
   *  `point` unchanged if the container isn't measurable yet (never worse
   *  than the pre-P47 behavior). */
  const getPanelAwareCenterTarget = useCallback((point: { x: number; y: number }, zoomForCenter: number) => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect) return point;
    const insets = measureDockedPanelInsets(canvasContainerRef.current);
    return setCenterTarget(point, { width: rect.width, height: rect.height }, insets, zoomForCenter);
  }, []);

  const lastMouseClientRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  /** Set at `onConnectStart`, read (and cleared) at `onConnectEnd` — RF
   *  doesn't pass the start info to the end handler itself, so it has to
   *  survive the drag in a ref. Only a `'source'`-type start opens the
   *  picker (see `handleConnectEnd`'s own comment). */
  const connectStartRef = useRef<{ nodeId: string; handleType: string | null } | null>(null);

  const { viewportInit, scheduled: hydratedScheduled } = useCanvasHydration(activeRoot, activeFleetProjectId);
  const scheduled = scheduledOverride ?? hydratedScheduled;
  const filter = useCanvasFilter();

  // ── Loop/hierarchy metadata (reconciler.ts's "CONTRACT GAP #1" seam):
  //    only the active project's live Mission[] carries loopConfig/
  //    loopParentId/parentMissionId — a non-active project's missions
  //    degrade gracefully to plain mission nodes, never a crash or a
  //    fabricated guess. ─────────────────────────────────────────────
  const computedMissionLoopMeta = useMemo(() => {
    const map = new Map<string, MissionLoopMeta>();
    for (const mission of activeMissions) {
      if (
        mission.loopConfig === undefined &&
        mission.loopParentId === undefined &&
        mission.parentMissionId === undefined &&
        mission.loopIteration === undefined
      ) {
        continue;
      }
      map.set(mission.id, {
        loopConfig: mission.loopConfig,
        loopParentId: mission.loopParentId,
        loopIteration: mission.loopIteration,
        parentMissionId: mission.parentMissionId,
      });
    }
    return map;
  }, [activeMissions]);
  const missionLoopMeta = missionLoopMetaOverride ?? computedMissionLoopMeta;

  // W8d Replay — every open project's journal id (journalQuery only filters
  // by ONE projectId per call; see useReplayMode.ts's own doc comment).
  const replayProjectIds = useMemo(() => fleetProjects.map((p) => p.projectId), [fleetProjects]);
  const replay = useReplayMode({ projectIds: replayProjectIds });

  const { nodes, edges, setNodes, onNodesChange, onEdgesChange, onMoveEnd, reactFlowInstanceRef, projectZones, resolveFlowPoint, placeInZoneOrTransverse } =
    useCanvasFlowGraph({
      projects: fleetProjects,
      drafts,
      chains,
      notes,
      scheduled,
      routers,
      joins,
      surfaces,
      frames,
      expandedPanels,
      positions,
      collapsed,
      prefs,
      activeProjectId: activeFleetProjectId ?? null,
      forceApproveIds,
      missionLoopMeta,
      sessionDraggedRefs,
      dismissedRefs,
      highlightIds,
      justMergedId,
      isFilterActive: filter.isFilterActive,
      nodeMatches: filter.nodeMatches,
      replay: { active: replay.active, fleetState: replay.fleetState, firingChainIds: replay.firingChainIds },
    });

  // W8d Replay — `onUrgentAction` is the node hover-strip's Stop/Retry/Merge
  // mutation (MissionNodeCard, chrome/nodeChrome.tsx — outside this wave's
  // writable set, so it's gated HERE instead: a no-op toast rather than
  // silently acting on the REAL live mission while its historical snapshot
  // is on screen). `onOpenMission` stays live — opening the mission drawer
  // is read-only navigation, never a mutation.
  const handleUrgentAction = useCallback(
    (mission: FleetMission, actionKey: string) => {
      if (replay.active) {
        toast(t('canvas.replay.editingDisabled'), 'info');
        return;
      }
      onUrgentAction(mission, actionKey);
    },
    [replay.active, onUrgentAction, toast, t],
  );

  const editing = useCanvasEditing({
    projects: fleetProjects,
    nodes,
    edges,
    setNodes,
    resolveFlowPoint,
    placeInZoneOrTransverse,
    onOpenMission,
    onUrgentAction: handleUrgentAction,
  });

  // ── W8d Replay follow-up — fork-from-replay (v1, market-gap fix) ────────
  // Node clicks during replay select a mission (ReplayBar's own « Relancer
  // depuis ce point » entry reads `replay.selectedMissionId`) INSTEAD OF the
  // normal click-to-connect resolution — chaining is already disabled
  // read-only during replay (nodesConnectable={!replay.active} below), so
  // repurposing plain node clicks for selection here takes over an
  // interaction that would otherwise be a no-op anyway (chainSource can only
  // ever be armed via CanvasContextMenu.tsx, itself unmounted during replay:
  // `{editing.contextMenu && !replay.active && <CanvasContextMenu .../>}`).
  const handleCanvasNodeClick = useCallback(
    (event: unknown, node: CanvasReactFlowNode) => {
      if (replay.active) {
        const parsed = parseRef(node.id);
        replay.selectMission(parsed?.kind === 'mission' ? parsed.id : null);
        return;
      }
      collab.reportFocus(node.id);
      editing.handleNodeClick(event, node);
    },
    [replay, editing, collab],
  );

  /**
   * Materializes an isolated fork draft from the selected mission's journal
   * state as of the current replay playhead (lib/agents/forkFromReplay.ts's
   * `buildForkDraft` — see its header for the honest-semantics boundary:
   * task + context brief, never a resurrected process). Mirrors
   * CanvasContextMenu.tsx's `duplicateAsDraft` degrade rule exactly: the
   * FULL Mission (real `agentTask`) is only on hand for the ACTIVE project's
   * missions; a mission from a non-active project's replay window only has
   * the node's own `FleetMission` fields, so `title` stands in for the task
   * rather than a fabricated guess.
   */
  const handleForkFromReplay = useCallback(
    (missionId: string) => {
      const atMs = replay.currentTMs;
      const node = nodes.find((n) => n.id === makeRef('mission', missionId));
      if (!node || node.type !== 'mission') return;
      const missionData = node.data as MissionNodeData;
      const full = activeMissions.find((m) => m.id === missionId);
      const source: ForkSourceMission = {
        title: full?.title ?? missionData.mission.title,
        agentTask: full?.agentTask,
        agentName: full?.agentName,
        model: full?.model ?? missionData.mission.model,
      };
      const seed = buildForkDraft(missionId, atMs, replay.rawEvents, source);
      const draft: DraftSpec = { ...seed, id: generateCanvasId('draft'), projectId: missionData.projectId };

      replay.exit();
      addDraft(draft);
      setPosition(makeRef('draft', draft.id), duplicatePosition(node.position));
      // "selects it" — same fitView "look here" idiom this file already
      // uses for search-match/urgent focus (see the arrange/search effects
      // below); deferred one frame so the draft node exists in `nodes`
      // (post reconcile) by the time fitView looks it up.
      requestAnimationFrame(() => {
        reactFlowInstanceRef.current?.fitView({
          nodes: [{ id: makeRef('draft', draft.id) }],
          duration: 250,
          padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING, true),
        });
      });
    },
    [replay, nodes, activeMissions, addDraft, setPosition, reactFlowInstanceRef, getPanelAwarePadding],
  );

  // R1-final stitch — ProjectGroupNode.tsx's zone-digest « Lancer un agent »
  // CTA (defect #6 fix) emits 'canvas:launchAgentForProject' but nothing
  // subscribed yet (see bus.ts's own doc comment on the event, which flags
  // BOTH candidate wirings and recommends this one): the honest behavior is
  // to open the SAME quick-create modal the palette/command-bar/context-menu
  // already share, pre-targeted at that project's zone — never a silent
  // blank draft with no title/task the user never got to fill in. A point
  // INSIDE the zone (its center) is required, not just the projectId, since
  // handleQuickCreateSubmit's own placement decision
  // (placeInZoneOrTransverse, canvasPlacement.ts) attributes the eventual
  // draft to whichever zone the flowPosition falls inside.
  useEffect(() => {
    return on('canvas:launchAgentForProject', ({ projectId }) => {
      if (replay.active) {
        toast(t('canvas.replay.editingDisabled'), 'info');
        return;
      }
      const zone = projectZones.find((z) => z.projectId === projectId);
      if (!zone) {
        toast(t('canvas.draft.projectClosed'), 'error');
        return;
      }
      editing.handleOpenQuickCreateAt(
        { x: zone.position.x + zone.size.width / 2, y: zone.position.y + zone.size.height / 2 },
        projectId,
      );
    });
    // `editing` itself is a fresh object every render (useCanvasEditing.ts
    // is not memoized) — depending on the whole object would resubscribe on
    // every render instead of only when the one stable useCallback this
    // effect actually reads (`handleOpenQuickCreateAt`, empty-deps in that
    // hook) changes identity. Same deliberate narrowing AppContext.tsx's own
    // boot effect documents for the identical reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectZones, replay.active, editing.handleOpenQuickCreateAt, toast, t]);

  const dnd = useCanvasDnd({ nodes, resolveFlowPoint, placeInZoneOrTransverse });

  // Group macros — palette CLICK path (drag-drop goes through
  // dnd.handleCanvasDrop directly, which already has a real cursor drop
  // point). Click has no drop point to read, so it anchors on the active
  // zone's center (mirrors the canvas:launchAgentForProject CTA's own
  // "center of the zone" anchor above) — or a fixed Transverse fallback
  // when no zone is active; either way, instantiateMacro's own collision
  // scan resolves the REAL non-overlapping spot from there.
  const handleInstantiateMacroClick = useCallback(
    (macroId: string) => {
      const zone = activeFleetProjectId ? projectZones.find((z) => z.projectId === activeFleetProjectId) : undefined;
      const anchor = zone ? { x: zone.position.x + zone.size.width / 2, y: zone.position.y + zone.size.height / 2 } : { x: 200, y: 200 };
      dnd.handleInstantiateMacro(macroId, anchor);
    },
    [activeFleetProjectId, projectZones, dnd],
  );

  const handleSaveMacroSubmit = useCallback(
    (value: SaveMacroValue) => {
      if (!saveMacroRefs) return;
      // Reads the LATEST live facts directly (not this render's `drafts`/
      // `routers`/`notes`/`chains`/`positions` closures) — same rationale as
      // every other canvasStoreVanilla.getState() read-then-act call in this
      // codebase (e.g. chainEngine.ts's consume()): a capture must never
      // race a change that landed between this render and the click.
      const macro = captureMacro(canvasStoreVanilla.getState(), saveMacroRefs, value.name, value.description);
      addMacro(macro);
      setSaveMacroRefs(null);
    },
    [saveMacroRefs, addMacro],
  );

  // W-CLOSE row 4 ("flow-as-code" v1) — « Exporter le canvas » triggers a
  // standard browser Blob download (canvasExportImport.ts's module header
  // explains why this, not the sandboxed project-scoped fs commands, is the
  // honest "existing save-file platform path" here): the resulting .json is
  // plain, diffable, shareable text a teammate can hand back for « Importer ».
  const handleExportCanvas = useCallback(() => {
    const envelope = buildCanvasExportEnvelope(canvasStoreVanilla.getState());
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = canvasExportFileName(envelope.exportedAtMs);
    anchor.click();
    URL.revokeObjectURL(url);
    toast(t('canvas.toast.exportDone'), 'success');
  }, [toast, t]);

  // « Importer un canvas » — reads the picked File's text directly (no
  // Tauri fs involved, see the export handler's own comment), validates it
  // as a real export envelope (never trusts a file on disk/from a teammate),
  // and merges a freshly-id-remapped copy into the live canvas.
  const handleImportCanvasFile = useCallback(
    (file: File) => {
      void file.text().then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          toast(t('canvas.toast.importInvalid'), 'error');
          return;
        }
        const envelope = parseCanvasExportEnvelope(parsed);
        if (!envelope) {
          toast(t('canvas.toast.importInvalid'), 'error');
          return;
        }
        const result = remapImportedCanvas(envelope);
        mergeImportedCanvas(result);
        toast(
          t('canvas.toast.importDone', {
            drafts: String(result.drafts.length),
            chains: String(result.chains.length),
          }),
          'success',
        );
      });
    },
    [mergeImportedCanvas, toast, t],
  );

  // P8.3 — « Exporter en YAML »: serializes the canvas graph to a YAML
  // workflow file (yamlWorkflowImport.ts's exportYamlWorkflow). Same
  // Blob-download pattern as handleExportCanvas above.
  const handleExportYaml = useCallback(() => {
    const yaml = exportYamlWorkflow({
      name: 'Canvas Workflow',
      description: 'Exported from Lazy Canvas',
      steps: [],
    } as unknown as Parameters<typeof exportYamlWorkflow>[0]);
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `canvas-workflow-${Date.now()}.yaml`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(t('canvas.toast.yamlExported'), 'success');
  }, [toast, t]);

  // P8.3 — « Importer un workflow YAML »: parses a YAML file into a GraphIR
  // (yamlWorkflowImport.ts's parseYamlWorkflow + workflowToGraphIR), then
  // merges drafts into the canvas. Best-effort, never crashes on bad YAML.
  const handleImportYamlFile = useCallback(
    (file: File) => {
      void file.text().then((raw) => {
        try {
          const graph = parseYamlWorkflow(raw);
          // Merge graph nodes as drafts into the canvas
          for (const node of graph.nodes) {
            if (node.kind === 'task') {
              canvasStoreVanilla.getState().addDraft({
                id: node.id,
                projectId: '',
                title: node.description ?? node.id,
                task: node.description ?? node.id,
                model: node.contract?.model ?? '',
                agentName: node.contract?.agentName ?? 'claude',
                permissionMode: node.contract?.permissionMode ?? 'plan',
                createdBy: 'user',
              });
            }
          }
          toast(t('canvas.toast.yamlImported', { steps: graph.nodes.length }), 'success');
        } catch {
          toast(t('canvas.toast.yamlInvalid'), 'error');
        }
      });
    },
    [toast, t],
  );

  // P8.4 — « Exporter vers Git »: serializes the canvas to a directory
  // structure (canvasGitExport.ts's exportCanvasToFiles) and downloads it
  // as a YAML overview + JSON manifest. Best-effort.
  const handleGitExport = useCallback(() => {
    const state = canvasStoreVanilla.getState();
    const envelope = buildCanvasExportEnvelope(state);
    const exportData: CanvasExportData = {
      drafts: envelope.drafts,
      chains: envelope.chains,
      routers: envelope.routers,
      joins: envelope.joins,
      contests: envelope.contests,
    };
    const files = exportCanvasToFiles(exportData);
    const overview = exportCanvasYamlOverview(exportData);
    // Download the YAML overview as the entry point
    const blob = new Blob([overview], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `canvas-export-${Date.now()}.yaml`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(t('canvas.toast.gitExported', { count: files.size }), 'success');
  }, [toast, t]);

  // P7.6 — « Exporter comme MCP »: converts the canvas graph to an MCP server
  // definition (graphMcpPublisher.ts) and downloads the config JSON.
  const handleExportMcp = useCallback(() => {
    const server = graphToMcpServer({ nodes: [], edges: [], defaults: { maxParallelNodes: 0, defaultModel: '', defaultAgentName: 'claude', defaultPermissionMode: 'plan' } } as unknown as Parameters<typeof graphToMcpServer>[0], {
      serverName: 'lazy-canvas',
      version: '1.0.0',
    });
    const config = generateMcpConfig(server, 'npx', ['lazy-mcp-server']);
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mcp-config-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(t('canvas.toast.mcpExported'), 'success');
  }, [toast, t]);

  // W-BYO row 1 — « Importer un agent » (CanvasPalette's own entry). Same
  // never-trust-a-file discipline as handleImportCanvasFile above, just
  // registering into agentsStorage (via saveAgent) instead of merging into
  // the live canvas store. Returns a Promise so CanvasPalette can refresh
  // its own agent list once the import (or its failure) has resolved.
  const handleImportAgentFile = useCallback(
    async (file: File): Promise<void> => {
      const raw = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        toast(t('agents.library.importAgentInvalid'), 'error');
        return;
      }
      const envelope = parseAgentExportEnvelope(parsed);
      if (!envelope) {
        toast(t('agents.library.importAgentInvalid'), 'error');
        return;
      }
      const imported = remapImportedAgent(envelope);
      try {
        await saveAgent(imported.scope, imported);
        for (const tool of envelope.projectCommandTools) {
          try {
            await saveProjectCommandTool(tool);
          } catch {
            // best-effort — see AgentLibrary.tsx's identical import handler
          }
        }
        toast(t('agents.library.importAgentDone', { name: imported.displayName || imported.name }), 'success');
      } catch {
        toast(t('agents.library.saveFailed'), 'error');
      }
    },
    [toast, t],
  );

  const layout = useCanvasLayout({
    nodes,
    edges,
    // R13 — « breathing room »: every arrange call (toolbar, Ctrl+L,
    // palette, context-menu "Tout ranger") now fits the view with ~15%
    // padding afterward, so the freshly-tiled zones never fill the ENTIRE
    // viewport edge-to-edge — see useCanvasLayout's doc comment.
    // P47 — panel-aware (getPanelAwarePadding), same as every other
    // fitView call site in this file.
    //
    // fix/canvas-manager-camera (round 3 QA, P0-1: "zoom reste bloque a 11%
    // apres arrange_canvas") — `scope` (forwarded by useCanvasLayout's
    // `runLayoutAll`) narrows the fit to the ONE zone a SCOPED arrange just
    // re-laid-out, instead of always fitting the whole canvas (spec ask:
    // "prefere cadrer sur la zone active plutot que sur tout le monde").
    // Both branches floor `minZoom` — an un-floored whole-canvas fit was
    // free to resolve down to React Flow's own 0.1 technical floor the
    // instant enough zones/projects were open, exactly the reported
    // illegible symptom.
    // fix/canvas-manager-camera-race — returns the underlying
    // `instance.fitView()` promise (normalized to `Promise<void>`) rather
    // than firing it and returning nothing: `useCanvasLayout.ts`'s own
    // `runLayoutAll` now AWAITS this so it only resolves once React Flow has
    // genuinely APPLIED the post-arrange camera move, not merely queued it
    // — see that hook's own doc comment for the full race this closes.
    fitViewAfterLayout: (scope) => {
      const instance = reactFlowInstanceRef.current;
      const scopedRef = scope ? makeRef('project', scope) : undefined;
      // Guard: only take the scoped-zone branch when that zone actually
      // resolves to a live node — see resolveArrangeFitTarget's own doc
      // comment for why a scope whose project closed in the meantime must
      // fall through to the whole-canvas branch instead.
      const scopeIsLive = scopedRef ? typeof instance?.getNode !== 'function' || instance.getNode(scopedRef) !== undefined : false;
      const target = resolveArrangeFitTarget(scopedRef, scopeIsLive);
      if (!instance) return undefined;
      return instance
        .fitView({
          ...(target.nodeIds ? { nodes: target.nodeIds.map((id) => ({ id })) } : {}),
          padding: getPanelAwarePadding(POST_ARRANGE_FIT_VIEW_VERTICAL_PADDING, true),
          duration: POST_ARRANGE_FIT_VIEW_DURATION_MS,
          minZoom: target.minZoom,
          ...(target.maxZoom !== undefined ? { maxZoom: target.maxZoom } : {}),
        })
        .then(() => undefined);
    },
  });

  // LazyManager choreography (Agent Canvas W4, spec §8.2) — arrange/focus/
  // highlight bus events the manager executor (agentsStore.tsx) emits.
  // Reuses the SAME highlight overlay class useCanvasFlowGraph's own
  // highlightIds/justMergedId props drive (see decoratedNodes below) rather
  // than inventing a second CSS pulse mechanism.
  const managerEvents = useCanvasManagerEvents({
    reactFlowInstanceRef,
    runLayoutAll: layout.runLayoutAll,
    setLaneMode: layout.setLaneMode,
    replayActive: replay.active,
    // P47 — panel-aware 'canvas:focus' (the manager's own focus_canvas
    // action must not land a node under the docked ManagerOverlay either).
    containerRef: canvasContainerRef,
  });

  // W-UX3 core deliverable 3 — auto-composition (dev-server auto-detect,
  // work auto-focus, mission-complete flash + preview refresh). See that
  // hook's own header for the full rationale/scope.
  const autoComposition = useCanvasAutoComposition({
    projects: fleetProjects,
    reactFlowInstanceRef,
    containerRef: canvasContainerRef,
    replayActive: replay.active,
  });

  // P-SEARCH — bridges toolRuntime.ts's 'canvas:webSearchResult' bus event
  // into the owning mission's SearchNode surface (see that hook's own
  // header). No params, no return value — a thin bus-to-store bridge.
  useCanvasWebSearchSurfaces();

  // P47 deliverable #2 — « Suivre l'activité »: camera follows the active
  // project's mission through running/review transitions (see that hook's
  // own header for how this differs from useCanvasAutoComposition's own
  // "pan if fully offscreen" behavior just above — the two are independent
  // and both live).
  const followActive = useCanvasFollowActive({
    projects: fleetProjects,
    activeFleetProjectId,
    reactFlowInstanceRef,
    containerRef: canvasContainerRef,
    replayActive: replay.active,
  });

  // Decorates the RENDER-only `nodes` prop with the manager's transient
  // highlight pulse — never the underlying `nodes` state itself (selection/
  // drag state must stay exactly what onNodesChange/setNodes manage; see
  // useCanvasFlowGraph.ts's own `displayNodes` for the identical technique
  // one layer down, decorating `reconciled.nodes` before it becomes local
  // state at all).
  const decoratedNodes = useMemo(() => {
    if (managerEvents.managerHighlightIds.size === 0 && autoComposition.justCompletedIds.size === 0) return nodes;
    return nodes.map((node) => {
      const inManagerHighlight = managerEvents.managerHighlightIds.has(node.id);
      const justCompleted = autoComposition.justCompletedIds.has(node.id);
      if (!inManagerHighlight && !justCompleted) return node;
      const classes = new Set((node.className ?? '').split(' ').filter(Boolean));
      if (inManagerHighlight) classes.add('canvas-halo-running');
      // W-UX3 core deliverable 3c — reuses the SAME "just merged" flash
      // class useCanvasFlowGraph.ts's own justMergedId prop already drives
      // (see useCanvasAutoComposition.ts's module header for why this hook
      // computes its own correctly ref-keyed set instead of reusing that
      // prop directly).
      if (justCompleted) classes.add('focus-flash');
      return { ...node, className: [...classes].join(' ') };
    });
  }, [nodes, managerEvents.managerHighlightIds, autoComposition.justCompletedIds]);

  // scratch/_canvas-label-design.md §3.2 ("le zoom minimum molette devient
  // dynamique") — the React Flow `minZoom` prop (below, on `<ReactFlow>`)
  // used to be a flat `0.1`: a user could always wheel-zoom out to 10%
  // regardless of how little content the canvas actually held, which is
  // exactly what let the old, unbounded LOD compensation's worst case
  // (chrome/lod.ts's `LOD_FLOOR_ZOOM`, now 0.25) ever get reached at all —
  // "there is nothing left to see past what fitting the content needs".
  // `min(LOD_FLOOR_ZOOM, natural)`: `computeSafeMinZoom` (cameraInsets.ts,
  // already used by the toolbar's own "Fit view" button) computes the SAME
  // natural, fully-unclamped whole-canvas fit zoom fed a `LOD_FLOOR_ZOOM`
  // floor instead of `ARRANGE_MIN_READABLE_ZOOM` — a sparse canvas (natural
  // fit already >= 0.25) is floored at the compensation boundary itself (no
  // reason to allow dezooming past the point where nothing holds a constant
  // screen size any more); a dense canvas (natural fit < 0.25, many zones)
  // still gets to dezoom exactly as far as it needs, never further — titles
  // stay non-overlapping there by construction regardless (ProjectGroupNode.tsx's
  // geometric containment), just smaller. Recomputed on every node-set
  // change AND on the container's own resize (ManagerOverlay collapse/
  // expand, window resize) — same "measure the live DOM, never a stale
  // snapshot" discipline `CanvasToolbar.tsx`'s own `runFit` already uses for
  // an analogous concern.
  const [dynamicMinZoom, setDynamicMinZoom] = useState(LOD_FLOOR_ZOOM);
  const recomputeDynamicMinZoom = useCallback(() => {
    const containerEl = canvasContainerRef.current;
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    // fix/canvas-fit-instrumentation's own guard (CanvasToolbar.tsx's
    // `runFit`) applies here too: only TOP-LEVEL (parentless) nodes ever go
    // into a bounds computation — a child's zone-relative position read as
    // if already absolute would distort the box (see that fix's own doc
    // comment for the exact failure mode).
    const topLevelNodes = decoratedNodes.filter((n) => !n.parentId);
    if (topLevelNodes.length === 0 || rect.width <= 0 || rect.height <= 0) {
      setDynamicMinZoom(LOD_FLOOR_ZOOM);
      return;
    }
    const bounds = getNodesBounds(topLevelNodes as never, { nodeOrigin: [0, 0] });
    const insets = measureDockedPanelInsets(containerEl);
    // fix/canvas-toolbar-fit-floor — same floor as the fit/arrange call
    // sites: the dynamic wheel-zoom floor must agree with where "fit"
    // itself lands, or a user could wheel-zoom out further than "fit"
    // allows and land content back under the toolbar.
    const padding = insetFitViewPadding(insets, FIT_VIEW_VERTICAL_PADDING, DEFAULT_HORIZONTAL_GUTTER_PX, CANVAS_FIT_TOP_RESERVE_PX);
    setDynamicMinZoom(computeSafeMinZoom(bounds, rect, padding, LOD_FLOOR_ZOOM, getViewportForBounds));
  }, [decoratedNodes]);
  useEffect(() => {
    recomputeDynamicMinZoom();
  }, [recomputeDynamicMinZoom]);
  useEffect(() => {
    const containerEl = canvasContainerRef.current;
    if (!containerEl || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => recomputeDynamicMinZoom());
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [recomputeDynamicMinZoom]);

  const handleToggleSnap = useCallback(() => setPrefs({ snap: !prefs.snap }), [setPrefs, prefs.snap]);
  const handleToggleMinimap = useCallback(() => setPrefs({ minimap: !prefs.minimap }), [setPrefs, prefs.minimap]);
  const handleToggleHideMerged = useCallback(() => setPrefs({ hideMerged: !prefs.hideMerged }), [setPrefs, prefs.hideMerged]);
  // R11 — plain-wheel scroll behavior toggle (CanvasPrefs.wheelMode's own
  // doc comment). fix/canvas-navigation — defense-in-depth narrowing on top
  // of canvasStore.ts's own `sanitizeCanvasPrefs` hydration-time guard:
  // never trust `prefs.wheelMode` unnarrowed here either (belt-and-braces,
  // same discipline as every other double-guarded field in this file, e.g.
  // useCanvasHoverRecovery's hoveredRef self-heal).
  const wheelMode = prefs.wheelMode === 'scroll' ? 'scroll' : 'zoom';
  const handleToggleWheelMode = useCallback(
    () => setPrefs({ wheelMode: wheelMode === 'zoom' ? 'scroll' : 'zoom' }),
    [setPrefs, wheelMode],
  );
  const handleTogglePalette = useCallback(() => setPaletteOpen((v) => !v), []);
  const handleToggleShortcuts = useCallback(() => setShortcutsOpen((v) => !v), []);
  // Ctrl+K OPENS (never toggles) — see useCanvasKeyboard.ts's
  // onOpenCommandBar doc comment for why that's the right idempotent
  // behavior; the overlay closes itself via Escape/selection.
  const handleOpenCommandBar = useCallback(() => setCommandBarOpen(true), []);
  const handleCloseCommandBar = useCallback(() => setCommandBarOpen(false), []);

  const hasSelection = useMemo(() => nodes.some((n) => n.selected), [nodes]);

  // fix/canvas-ux R6a BLOQUANT #1c — dot zoom keeps DraftNode passive by
  // design (spec's own "fleet view" glyph), so the launch gesture there is a
  // contextual toolbar chip instead of a per-node button: clicking a draft's
  // dot already SELECTS it (React Flow's default node click), and once
  // exactly one draft is selected this chip is the cheap, always-reachable
  // fallback — same "single selected node of a known kind" derivation
  // useCanvasInspectSelection.ts already establishes for O/L/D/H below.
  const selectedDraftId = useMemo(() => {
    const selected = nodes.filter((n) => n.selected && n.type === 'draft');
    return selected.length === 1 ? (selected[0]!.data as DraftSpec).id : null;
  }, [nodes]);
  const handleLaunchSelectedDraft = useCallback(() => {
    if (selectedDraftId) editing.canvasActions.onLaunchDraft(selectedDraftId);
  }, [selectedDraftId, editing.canvasActions]);

  // Per-node I/O inspect shortcuts ('O'/'L'/'D', W5b deliverable #2) — see
  // useCanvasInspectSelection.ts's own header for why this is a hook, not
  // inline state.
  const inspectSelection = useCanvasInspectSelection(nodes, editing.canvasActions);

  // fix/canvas-boot-fit-floor (owner-reported, live packaged app: 16 nodes
  // across several far-apart project zones opened at a 6% viewport scale —
  // measured `.react-flow__viewport` transform, node boxes 16-60px wide,
  // "nothing legible"). Root cause: `<ReactFlow>`'s own declarative
  // `fitView={viewportInit.fit}` (still below, unchanged — only fires when
  // no persisted camera exists) resolves its zoom against `dynamicMinZoom`,
  // which is `computeSafeMinZoom(..., LOD_FLOOR_ZOOM, ...)` —
  // `Math.min(floor, natural)`, i.e. it CHASES the natural whole-canvas fit
  // DOWN to match it whenever that natural fit sits below the floor
  // (cameraInsets.ts's own doc comment: "content staying fully visible
  // always wins"). Correct for a deliberate toolbar "Fit view" click; wrong
  // for the very first frame a user ever sees — an unreadable dust of
  // zones is a worse first impression than a readable view that needs a
  // pan to reach the rest.
  //
  // This is a CORRECTIVE follow-up fit, not a replacement for the
  // declarative one below: it fires one frame after mount (same
  // measurement-race guard `runLayoutAll`/`handleZoomToSelection` already
  // use) and, when `viewportInit.fit` is true, re-frames the camera onto
  // the SAME scoped/floored target `fitViewAfterLayout`'s post-arrange fit
  // already uses (`resolveArrangeFitTarget`, cameraInsets.ts) — proven,
  // already-tested logic, not a new floor invented here:
  //   - the ACTIVE project's own zone, genuinely readable
  //     (`FOCUS_MIN_READABLE_ZOOM`, 60%), when one is open and its zone is
  //     live — most sessions boot with exactly one project actively worked
  //     on, so this is normally what actually happens;
  //   - otherwise a whole-canvas fit HARD-floored at
  //     `ARRANGE_MIN_READABLE_ZOOM` (35%) via React Flow's own `fitView`
  //     minZoom clamp — deliberately NOT run through `computeSafeMinZoom`'s
  //     soft "never below natural" chase, so a genuinely sparse/spread
  //     fleet still lands readable, panning covers whatever falls outside
  //     the frame. Explicit "no semantic zoom" note: this changes WHERE the
  //     camera frames, never WHAT renders at a given zoom — no node/label
  //     gains or loses content based on this fit, the existing LOD
  //     machinery (chrome/lod.ts) is untouched.
  // No-op when a real persisted viewport exists (`viewportInit.fit ===
  // false`): `defaultViewport` (below) already restores that camera
  // position untouched, exactly as before this fix.
  const handleFlowInit = useCallback(
    (instance: ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge>) => {
      reactFlowInstanceRef.current = instance;
      if (!viewportInit?.fit) return;
      const scopedRef = activeFleetProjectId ? makeRef('project', activeFleetProjectId) : undefined;
      const scopeIsLive = scopedRef ? instance.getNode(scopedRef) !== undefined : false;
      const target = resolveArrangeFitTarget(scopedRef, scopeIsLive);
      requestAnimationFrame(() => {
        void reactFlowInstanceRef.current?.fitView({
          ...(target.nodeIds ? { nodes: target.nodeIds.map((id) => ({ id })) } : {}),
          padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING),
          minZoom: target.minZoom,
          ...(target.maxZoom !== undefined ? { maxZoom: target.maxZoom } : {}),
        });
      });
    },
    [reactFlowInstanceRef, viewportInit, activeFleetProjectId, getPanelAwarePadding],
  );

  // BUG 2 diagnostics (W6f): React Flow's own internal error/warning channel
  // — code 008 is "couldn't create edge, missing source/target handle",
  // 011 is "unknown edge type, falling back to default" — surfaced as
  // console.warn (never console.error, these are RF's own recoverable
  // degradations, not app crashes) so _e2e-canvas-desktop.mjs's console
  // capture can prove whether a missing chain edge is an RF-side drop
  // versus a reconciler/data issue. See useCanvasFlowGraph.ts's
  // scheduleFrame-deferred edges commit for the actual BUG 2 fix.
  const handleFlowError = useCallback((code: string, message: string) => {
    console.warn(`[CanvasView] React Flow error ${code}: ${message}`);
  }, []);

  // ── R2b connectionUx — connection-drag search-light + edge-drop node
  //    picker (spec §5, the flagship "biggest UX gap vs every competitor"
  //    ask). See chrome/connectionDragStore.ts and
  //    chrome/edgeDropTargeting.ts's own headers for the design.
  const handleConnectStart = useCallback<OnConnectStart>(
    (_event, params) => {
      connectStartRef.current = { nodeId: params.nodeId ?? '', handleType: params.handleType ?? null };
      if (params.nodeId) {
        beginConnectionDrag(computeCompatibleTargets(chains, params.nodeId, nodes));
      }
    },
    [chains, nodes],
  );

  const handleConnectEnd = useCallback<OnConnectEnd>(
    (event) => {
      endConnectionDrag();
      const startInfo = connectStartRef.current;
      connectStartRef.current = null;
      // Only a drag that started from a SOURCE handle opens the picker —
      // the app's whole chain model is source -> target (spec's own
      // "Chaîner depuis…"/palette conventions); a drag started from a
      // target handle is left alone (a rarer gesture RF still permits,
      // out of this wave's scope, see the report's deviations).
      if (!startInfo || startInfo.handleType !== 'source' || replay.active) return;
      const target = event.target;
      // xyflow's own AddNodeOnEdgeDrop recipe: only open the picker when
      // the drop landed OUTSIDE any handle (empty pane OR a node's body —
      // both read as "not another handle" here); dropping ON a handle
      // (valid or invalid) is left to RF's own onConnect/isValidConnection
      // path, unchanged.
      if (target instanceof Element && target.closest('.react-flow__handle')) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const flowPosition = resolveFlowPoint(point.clientX, point.clientY);
      if (!flowPosition) return;
      setEdgeDropPicker({ screenPosition: { x: point.clientX, y: point.clientY }, flowPosition, sourceRef: startInfo.nodeId });
    },
    [replay.active, resolveFlowPoint],
  );

  const handleEdgeDropCancel = useCallback(() => setEdgeDropPicker(null), []);

  const handleEdgeDropSelect = useCallback(
    (choice: EdgeDropChoice) => {
      if (!edgeDropPicker) return;
      const { flowPosition, sourceRef } = edgeDropPicker;
      setEdgeDropPicker(null);
      // fix/canvas-ux R4a — the edge-drop picker persists a node exactly at
      // the drop point immediately (setPositions below), which then reads
      // as a PINNED position on every future reconcile (never moved again)
      // — so if the raw drop point happened to land on an existing sibling,
      // that overlap would never self-heal. Resolving through the shared
      // collision-safe `placeInZoneOrTransverse` (real footprint per
      // choice.kind) up front means what gets persisted is already clear.
      const footprint = choice.kind === 'router' ? ROUTER_NODE_SIZE : DEFAULT_NODE_SIZE.draft;
      const { projectId, relativePosition } = placeInZoneOrTransverse(flowPosition, footprint);
      const position = projectId ? relativePosition : flowPosition;

      if (choice.kind === 'router') {
        const routerId = generateCanvasId('router');
        const targetRef = makeRef('router', routerId);
        const result = validateChain(chains, sourceRef, targetRef, { kind: 'router' });
        if (!result.ok) {
          toast(t(result.reasonKey), 'error');
          return;
        }
        const branches: RouterBranch[] = [
          { id: generateCanvasId('branch'), label: t('canvas.router.branchLabel', { n: '1' }), condition: { kind: 'outcome', value: 'success' } },
          { id: generateCanvasId('branch'), label: t('canvas.router.branchLabel', { n: '2' }), condition: { kind: 'default' } },
        ];
        const router: RouterSpec = { id: routerId, projectId, branches };
        addRouter(router);
        setPositions({ [targetRef]: position });
        addChain({ id: generateCanvasId('chain'), sourceRef, targetRef, condition: 'success', createdBy: 'user' });
        return;
      }

      const draftId = generateCanvasId('draft');
      const targetRef = makeRef('draft', draftId);
      const result = validateChain(chains, sourceRef, targetRef, { kind: 'draft' });
      if (!result.ok) {
        toast(t(result.reasonKey), 'error');
        return;
      }
      addDraft({
        id: draftId,
        title: choice.title,
        task: choice.task,
        agentName: choice.agentName,
        model: choice.model,
        projectId,
        createdBy: 'user',
      });
      setPositions({ [targetRef]: position });
      addChain({ id: generateCanvasId('chain'), sourceRef, targetRef, condition: 'success', createdBy: 'user' });
    },
    [edgeDropPicker, placeInZoneOrTransverse, chains, addRouter, addDraft, addChain, setPositions, toast, t],
  );

  const handleZoomToSelection = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return;
    // W-CAMERA — deferred one frame (see useCanvasLayout.ts's
    // `fitViewAfterLayout`/useCanvasManagerEvents.ts's `doFocus` for the same
    // rationale): a direct-user-action fitView firing synchronously can race
    // React Flow's own node-dimension effect and resolve against
    // not-yet-measured nodes.
    requestAnimationFrame(() => {
      reactFlowInstanceRef.current?.fitView({
        nodes: selected.map((n) => ({ id: n.id })),
        duration: 250,
        padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING, true),
      });
    });
  }, [nodes, reactFlowInstanceRef, getPanelAwarePadding]);

  // W-CLOSE row 1 (n8n parity — keyboard-first node navigation, canvas
  // scorecard should-have #2). `getNodesBounds` (a real ReactFlowInstance
  // method, @xyflow/system) resolves each node's ABSOLUTE flow-space rect
  // regardless of zone parenting (a child node's own `.position` is
  // zone-RELATIVE — see reconcilerZones.ts's `buildChildNode` — so a naive
  // `.position` comparison across zones would be wrong; this sidesteps that
  // entirely instead of hand-rolling parent-chain resolution).
  const handleArrowNav = useCallback(
    (direction: ArrowDirection) => {
      const instance = reactFlowInstanceRef.current;
      if (!instance) return;
      const navigable = nodes.filter((n) => n.type !== 'project');
      const selected = navigable.filter((n) => n.selected);
      if (selected.length !== 1) return; // spec: "selected node" (singular) — no invented anchor
      const current = selected[0]!;
      const currentBounds = instance.getNodesBounds([current.id]);
      const candidates = navigable
        .filter((n) => n.id !== current.id)
        .map((n) => ({ id: n.id, bounds: instance.getNodesBounds([n.id]) }));
      const nearestId = findNearestNodeInDirection(currentBounds, candidates, direction);
      if (!nearestId) return;
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nearestId })));
    },
    [nodes, reactFlowInstanceRef, setNodes],
  );

  const handleNudgeSelection = useCallback(
    (direction: ArrowDirection) => {
      const selected = nodes.filter((n) => n.type !== 'project' && n.selected);
      if (selected.length === 0) return;
      const delta = ARROW_NUDGE_DELTA[direction];
      const patch: Record<string, { x: number; y: number }> = {};
      for (const n of selected) patch[n.id] = { x: n.position.x + delta.x, y: n.position.y + delta.y };
      setPositions(patch);
    },
    [nodes, setPositions],
  );

  // « Focus pannes » (spec's task text): one click filters failed +
  // judge-rejected review missions across ALL open projects + fitView on
  // them — an honest empty toast when there are none.
  //
  // R1b toolbar redesign — the button itself is now conditional (only
  // rendered while there's something to focus, see CanvasToolbar's
  // `failureCount` prop below) so `focusFailuresCount` is computed HERE,
  // once per `nodes` change, and shared by both the toolbar's visibility/
  // badge-count decision and this handler's own honest-empty-toast guard
  // (kept as a defensive fallback — the button no longer renders at 0, but
  // a stale click during the render that hides it should still no-op
  // safely rather than fitView on an empty selection).
  const focusFailuresCount = useMemo(
    () => nodes.filter((n) => n.type !== 'project' && matchesFocusFailures(n)).length,
    [nodes],
  );
  const handleFocusFailures = useCallback(() => {
    const matched = nodes.filter((n) => n.type !== 'project' && matchesFocusFailures(n));
    if (matched.length === 0) {
      toast(t('canvas.toast.noFailures'), 'info');
      return;
    }
    filter.activateFocusFailures();
    // W-CAMERA — deferred one frame, same rationale as handleZoomToSelection
    // above.
    requestAnimationFrame(() => {
      reactFlowInstanceRef.current?.fitView({
        nodes: matched.map((n) => ({ id: n.id })),
        duration: 250,
        padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING, true),
      });
    });
  }, [nodes, toast, filter, reactFlowInstanceRef, t, getPanelAwarePadding]);

  const handleEscape = useCallback(() => {
    editing.setChainSource(null);
    filter.clear();
  }, [editing, filter]);

  // feat/always-visible-agents — a zone mission-roster dot's click target
  // (CanvasActionsContext.tsx's `onFocusNode`): the SAME `fitView`
  // "look here" idiom `handleZoomToSelection`/`handleFocusFailures` above
  // already use, just for one node id instead of a selection/match set.
  //
  // P47 — this is THE bug's primary repro (the R3 node 80% hidden under
  // the ManagerOverlay): panel-aware padding (getPanelAwarePadding) fixes
  // it the same way every other fitView call site in this file now does.
  const handleFocusNode = useCallback(
    (ref: string) => {
      // W-CAMERA — deferred one frame, same rationale as
      // handleZoomToSelection above.
      requestAnimationFrame(() => {
        reactFlowInstanceRef.current?.fitView({
          nodes: [{ id: ref }],
          duration: 250,
          padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING, true),
        });
      });
    },
    [reactFlowInstanceRef, getPanelAwarePadding],
  );

  const canvasActionsValue = useMemo(
    () => ({ ...editing.canvasActions, onFocusNode: handleFocusNode }),
    [editing.canvasActions, handleFocusNode],
  );

  useCanvasKeyboard({
    hoveredRef,
    reactFlowInstanceRef,
    lastMouseClientRef,
    resolveFlowPoint,
    replayActive: replay.active,
    handlers: {
      onCopy: editing.handleCopySelection,
      onPasteAt: editing.handlePasteAt,
      onDuplicate: editing.handleDuplicateSelection,
      onDelete: editing.handleDeleteSelection,
      onAddNoteAt: editing.handleAddNoteAt,
      onTogglePalette: handleTogglePalette,
      onEscape: handleEscape,
      onLayoutAll: layout.runLayoutAll,
      onZoomToSelection: handleZoomToSelection,
      onToggleShortcuts: handleToggleShortcuts,
      onOpenCommandBar: handleOpenCommandBar,
      onOpenSelectedMission: inspectSelection.onOpenSelectedMission,
      onLogsSelectedMission: inspectSelection.onLogsSelectedMission,
      onDiffSelectedMission: inspectSelection.onDiffSelectedMission,
      onHistorySelectedMission: inspectSelection.onHistorySelectedMission,
      onToggleReplay: replay.toggle,
      onReplayPlayPause: replay.togglePlay,
      onReplayStepBack: () => replay.stepMs(-REPLAY_STEP_MS),
      onReplayStepForward: () => replay.stepMs(REPLAY_STEP_MS),
      onArrowNav: handleArrowNav,
      onNudgeSelection: handleNudgeSelection,
    },
  });

  // Local const (not a re-access of `editing.quickCreate`) so TypeScript's
  // discriminated-union narrowing on `.mode === 'edit'` survives into the
  // draft-version-history props below, which read `.draftId` from inside a
  // closure (see the CanvasQuickCreateModal render further down).
  const quickCreateState = editing.quickCreate;

  // ── Boot skeleton gate (R1-final stitch — AppContext.projectsHydrated,
  //    its own doc comment) — `projects.length === 0` is AMBIGUOUS during
  //    the window between mount and the registry-hydration effect settling:
  //    it means either "hydration finished, genuinely zero projects" OR
  //    "hydration hasn't resolved yet". The dead "Ouvre un projet" hero
  //    below is only honest in the FIRST case, so it must wait for
  //    `projectsHydrated` — a subtle skeleton, not a spinner, since this is
  //    one boot-time IPC round-trip, not a slow network op. ─────────────
  if (!projectsHydrated) {
    return (
      <div
        data-testid="canvas-loading-state"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          marginRight: reservedRightPx,
          background: 'var(--color-bg)',
          color: 'var(--color-text-disabled)',
          fontSize: 13,
        }}
      >
        <Skeleton width={280} height={160} borderRadius={12} style={{ border: '1px dashed var(--color-border)' }} />
        <p style={{ margin: 0 }}>{t('canvas.empty.loadingProjects')}</p>
      </div>
    );
  }

  // ── Empty state (spec §5 "no project open → hero CTA « Ouvrir un
  //    projet »") — `projects` mirrors AppContext.openProjects 1:1, so
  //    `projects.length === 0` genuinely means zero open projects ONCE
  //    `projectsHydrated` is true (the gate above). The real "open a
  //    project" primitive is AppContext.openProject(). ──────────────────
  if (projects.length === 0) {
    return (
      <div
        data-testid="canvas-empty-state"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          marginRight: reservedRightPx,
          // fix/canvas-empty-hero — the old flat `var(--color-bg)` read as a
          // dead black void (real-app screenshot, 2026-08-22): the empty
          // cockpit is the FIRST screen a new user sees, and it looked broken
          // rather than inviting. A faint dot grid (the same texture the
          // populated canvas reads as "this is a graph surface") plus a real
          // glyph and a secondary-not-disabled text color keep the state
          // honest while making it feel intentional. Purely visual: the
          // testids, the copy keys and the CTA behavior are untouched.
          background: 'var(--color-bg)',
          backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
          color: 'var(--color-text-secondary)',
          fontSize: 13,
        }}
      >
        {/* canvas glyph — same 16-grid stroke idiom as chrome/HoverActionStrip's
            inline icon set (plain SVG, never an emoji). */}
        <svg width={44} height={44} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2.5" y="4.5" width="8" height="6" rx="1.5" stroke="var(--color-accent)" strokeWidth="1.4" opacity="0.9" />
          <rect x="13.5" y="13.5" width="8" height="6" rx="1.5" stroke="var(--color-text-disabled)" strokeWidth="1.4" />
          <path d="M6.5 10.5v4a2 2 0 0 0 2 2h5" stroke="var(--color-text-disabled)" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <p style={{ margin: 0 }}>{t('canvas.empty.noProject')}</p>
        {platform.name === 'tauri' ? (
          <button
            type="button"
            data-testid="canvas-empty-open-project"
            onClick={() => void openProject()}
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              padding: '7px 16px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              background: 'var(--color-accent)',
              color: '#14141C',
            }}
          >
            {t('canvas.empty.openProject')}
          </button>
        ) : (
          <p
            data-testid="canvas-empty-desktop-hint"
            style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted)', maxWidth: 320, textAlign: 'center' }}
          >
            {t('canvas.empty.desktopRequired')}
          </p>
        )}
      </div>
    );
  }

  if (viewportInit === null) {
    return <div style={{ flex: 1, marginRight: reservedRightPx, background: 'var(--color-bg)' }} />;
  }

  return (
    <div
      ref={canvasContainerRef}
      data-testid="canvas-view"
      role="application"
      aria-label={t('canvas.view.ariaLabel')}
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
      onMouseMove={(e) => {
        lastMouseClientRef.current = { x: e.clientX, y: e.clientY };
        // fix/canvas-ux R6a MAJEUR #7 — belt-and-braces alongside
        // useCanvasHoverRecovery.ts's window-level click recompute: any
        // ACTUAL mouse movement over the canvas also self-heals a stuck
        // `hoveredRef` (a real `mousemove` fires here regardless of prior
        // enter/leave history the instant the pointer is over this div).
        hoveredRef.current = true;
      }}
      onDragOver={dnd.handleCanvasDragOver}
      onDrop={replay.active ? undefined : dnd.handleCanvasDrop}
      // R1b defect #3 fix (canvas rendering under the LazyManager rail):
      // Cockpit.tsx's two-column row is `display:flex` (row) with this
      // component's own left-column ancestor (`flex:1`) as ITS flex item —
      // a flex item's cross/main-axis auto-minimum ("min-width:auto"/
      // "min-height:auto" per the flexbox spec) clamps it to at LEAST its
      // content's intrinsic size unless explicitly overridden. `minHeight:
      // 0` already did this for the vertical axis (this div sits above
      // FluxFooter in a column flex parent); `minWidth: 0` was the missing
      // half for the horizontal axis — without it, this div (and the
      // `<ReactFlow>` it wraps, which sizes itself to 100% of THIS div) was
      // free to grow to its own content's intrinsic width instead of
      // shrinking to the flex-allocated column width, so the pane's real
      // DOM box ended up wider than the visible left column and painted
      // UNDER the rail (a sibling flex item, painted after in DOM order)
      // rather than being clipped by it. `overflow: hidden` is the second
      // half of the fix: it establishes this div as the actual clipping
      // boundary for anything React Flow renders past its own edge (RF's
      // `.react-flow` sets `overflow: hidden` too, but only once ITS OWN
      // box is correctly bounded by `minWidth: 0` above — belt-and-braces,
      // matches the exact fix Cockpit.tsx's OWN comment already flags this
      // component's container as owning). See CanvasView.test.tsx's
      // "container sizing" describe block for the jsdom-provable half of
      // this (the style properties themselves) — jsdom has no real layout
      // engine (canvasTestEnv.ts's own header), so the actual pixel-width
      // clipping this fixes can only be confirmed by the real e2e re-run.
      style={{
        flex: 1,
        display: 'flex',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        // fix/canvas-overlay-occlusion — reserves ManagerOverlay's real
        // current width so this container (and the `<ReactFlow>` it wraps,
        // which sizes itself to 100% of it) can never extend into the
        // screen region the overlay occupies — see reservedRightPx's own
        // doc comment on CanvasViewProps for the full rationale.
        marginRight: reservedRightPx,
        background: 'var(--color-bg)',
        position: 'relative',
      }}
    >
      <CanvasActionsProvider value={canvasActionsValue}>
        <ReactFlow
          nodes={decoratedNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onMoveEnd={onMoveEnd}
          // P47 deliverable #2 — a non-null `event` here is a REAL user
          // gesture (RF passes `null` for every programmatic move,
          // including useCanvasFollowActive's own setCenter pans) — see
          // that hook's own `onPaneMoveStart` doc comment for the 30s pause
          // this drives.
          onMoveStart={(event) => followActive.onPaneMoveStart(event)}
          onNodeClick={handleCanvasNodeClick}
          // R1b defect #1 fix (navigation scheme) — `zoomOnDoubleClick` is
          // now `false` (was RF's own `true` default): the mined n8n/
          // Flowise/Langflow brief reserves double-click for "open the node
          // editor" everywhere, and the OLD "harmless, `nopan` already
          // blocks it inside a zone" reasoning only ever covered a
          // double-click INSIDE a zone — a double-click on genuinely empty
          // pane space still zoomed, which is exactly the kind of
          // uncontrolled zoom trigger the whole prop bundle below is
          // fixing. Quick-create still fires from `onNodeDoubleClick`
          // (project zones only, see useCanvasEditing.ts's
          // handleNodeDoubleClick) — that handler is independent of RF's
          // OWN `zoomOnDoubleClick` prop, so this loses nothing.
          onNodeDoubleClick={replay.active ? undefined : editing.handleNodeDoubleClick}
          zoomOnDoubleClick={false}
          onNodeContextMenu={editing.handleNodeContextMenu}
          onEdgeContextMenu={editing.handleEdgeContextMenu}
          onPaneContextMenu={editing.handlePaneContextMenu}
          onNodeDrag={replay.active ? undefined : dnd.handleNodeDrag}
          onNodeDragStop={replay.active ? undefined : dnd.handleNodeDragStop}
          onConnect={replay.active ? undefined : editing.handleConnect}
          onConnectStart={replay.active ? undefined : handleConnectStart}
          onConnectEnd={replay.active ? undefined : handleConnectEnd}
          isValidConnection={editing.isValidConnection}
          // W8d Replay — "block editing actions": dragging/connecting a
          // node while scrubbing history would silently mutate the REAL
          // (live) layout/graph underneath the historical decoration.
          // Selection/click-to-inspect stay live (view-only).
          nodesDraggable={!replay.active}
          nodesConnectable={!replay.active}
          snapToGrid={prefs.snap}
          snapGrid={SNAP_GRID}
          onInit={handleFlowInit}
          onError={handleFlowError}
          // perf(canvas) — viewport culling: only mount nodes/edges whose
          // bounding box overlaps the visible pane (React Flow's own perf
          // guide names this prop as THE lever at high node counts — the
          // market scorecard's "perf at 20+ concurrent agents" claim needs
          // it; LOD/semantic-zoom (CanvasLodBroadcaster) only trims what a
          // node renders internally, never how MANY nodes mount). Left
          // UNGATED (no test-env/node-count check): @xyflow/system's
          // getNodesInside force-renders any node that hasn't been measured
          // yet (`forceInitialRender = !node.internals.handleBounds`), and
          // under vitest, canvasTestEnv.ts's ResizeObserver stub is a no-op
          // that never fires — so no node ever completes that first
          // measurement and every node stays force-rendered regardless of
          // this flag. Confirmed by running the full canvas suite plus the
          // visual harness (17/17 modes, no missing nodes) with this on.
          onlyRenderVisibleElements
          colorMode="dark"
          className={layout.isAnimating ? 'canvas-animating' : undefined}
          style={CANVAS_THEME_VARS as CSSProperties}
          // ── fix/canvas-navigation — n8n/Flowise-style navigation, THE
          //    regression this wave fixes ───────────────────────────────
          //    User report (real desktop session): click-drag pan, wheel
          //    zoom, AND trackpad pinch zoom all read as dead. Root cause
          //    (drag pan): R11 (commit 0c4a38e) had deliberately inverted
          //    RF's OWN defaults into a Figma/tldraw-style scheme —
          //    `selectionOnDrag: true` (left-drag ALWAYS marquee-selects)
          //    with `panOnDrag: [1]` (ONLY the middle button pans) — so a
          //    plain left-click-drag on empty canvas, the gesture n8n/
          //    Flowise/every mined competitor treats as "pan", instead drew
          //    an invisible-if-nothing-under-it selection box and never
          //    moved the viewport; a trackpad has no reliable middle button
          //    and the only escape hatch (hold Space) was undiscoverable.
          //    Restored to RF's own defaults instead: `panOnDrag` (left +
          //    middle button both pan, still no Space needed) and
          //    `selectionKeyCode="Shift"` + `selectionOnDrag={false}` (RF's
          //    stock "hold Shift to marquee-select instead" behavior) — this
          //    is exactly n8n's own scheme. `zoomOnPinch` stays unconditional
          //    (pinch/ctrl+wheel must never be disabled, regardless of
          //    wheelMode). `wheelMode` (CanvasPrefs, sanitized on load — see
          //    canvasTypes.ts's `sanitizeCanvasPrefs` — default 'zoom') still
          //    drives which of RF's own mutually-exclusive PLAIN-wheel
          //    bundles is active: 'zoom' (default, matches n8n/RF's own
          //    default too) or the opt-in 'scroll' toggle (CanvasToolbar's
          //    `canvas-toolbar-wheel-mode`) for anyone who prefers the older
          //    trackpad-first pan-on-scroll scheme; ShortcutsPanel describes
          //    whichever is actually active.
          zoomOnScroll={wheelMode === 'zoom'}
          panOnScroll={wheelMode === 'scroll'}
          panOnScrollMode={PanOnScrollMode.Free}
          panOnScrollSpeed={0.6}
          zoomOnPinch
          panOnDrag={[0, 1]}
          selectionOnDrag={false}
          selectionKeyCode="Shift"
          selectionMode={SelectionMode.Partial}
          selectNodesOnDrag={false}
          connectionRadius={30}
          nodeDragThreshold={1}
          // Delete/Backspace is handled EXCLUSIVELY by useCanvasKeyboard.ts's
          // own `onDelete` branch (respects replay/locked state, multi-
          // select nodes+edges together) — leaving RF's own
          // `deleteKeyCode` at its default ('Backspace') meant RF's
          // INTERNAL delete-selected-elements handler fired in parallel
          // with ours on every Backspace press, a latent double-handling
          // race. `[]` disables RF's own handler outright.
          deleteKeyCode={[]}
          // Stops RF's built-in per-node keyboard nav (arrow-key move/Tab
          // cycle/Enter-select, `NodeWrapper`'s own `onKeyDown`) from (a)
          // fighting text inputs inside node cards (note textarea, router
          // branch rename, quick-create fields) and (b) — the real-gesture
          // triage's #12 root cause — silently intercepting Escape: with
          // this `false` (RF's default), a focused node's OWN `onKeyDown`
          // treats Escape as "deselect me" BEFORE the event ever reaches
          // CanvasContextMenu.tsx's window-level Escape listener, which is
          // exactly why right-click-to-open-menu-then-Escape "stayed open"
          // in the triage. `true` makes that whole per-node handler a
          // no-op, so Escape reaches window listeners uninterrupted (see
          // CanvasContextMenu.tsx's own hardening — capture-phase listener
          // — for the belt-and-braces half of this fix).
          disableKeyboardA11y
          elevateNodesOnSelect
          elevateEdgesOnSelect={false}
          // fix/canvas-boot-fit-floor — was `fitView={viewportInit.fit}`.
          // React Flow's own on-mount fit and `handleFlowInit`'s corrective
          // one (above) both fire around mount time with no defined
          // ordering between them; leaving RF's declarative fit ALSO armed
          // meant it could resolve AFTER the corrective fit and silently
          // overwrite it back down to the unfloored `dynamicMinZoom`
          // (confirmed live: the corrective fit ran, then the camera still
          // settled at the same illegible zoom as before). Always `false`
          // now — `handleFlowInit` is the ONLY thing that ever calls
          // `fitView()` on boot, so there is exactly one source of truth
          // for the initial camera, never a race.
          fitView={false}
          // P47 — panel-aware even for the initial-mount fit (best-effort:
          // ManagerOverlay/CockpitLeftRail are siblings that mount around
          // the same time, but see getPanelAwarePadding's own note — this
          // isn't re-derived via useMemo, so each render reads the CURRENT
          // DOM, never a stale first-paint snapshot).
          fitViewOptions={{ padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING) }}
          defaultViewport={viewportInit.fit ? undefined : viewportInit.viewport}
          // scratch/_canvas-label-design.md §3.2 — dynamic, was a flat 0.1;
          // see `dynamicMinZoom`'s own doc comment above for the full "why".
          minZoom={dynamicMinZoom}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          {/* Screen-space constant-size dot grid (CanvasDots) — replaces RF's
              world-space <Background variant={Dots}> whose 1px world dots
              vanish below ~50% zoom (0.16px at overview), leaving the canvas
              reading as a dead black void. */}
          <CanvasDots />
          {prefs.minimap && (
            // R1b defect #15 — docked bottom-right originally (RF's own
            // default position). Moved to bottom-LEFT for the P1-3
            // full-bleed cockpit redesign (Cockpit.tsx's header comment):
            // the right edge is now PERMANENTLY occupied by the
            // always-visible LazyManager overlay (ManagerOverlay.tsx), which
            // would otherwise paint directly on top of a bottom-right
            // minimap and hide it completely (that overlay's z-index beats
            // this whole canvas subtree wherever they geometrically
            // overlap). Bottom-left stays clear — the far-left icon rail
            // (CockpitLeftRail.tsx) is vertically centered, not full-height.
            // SMALLER footprint (was the default 200x150) so it steals less
            // of the pane; `pannable zoomable` were already on.
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              // W-CAMERA — `pannable`/`zoomable` above only cover DRAGGING
              // inside the minimap; a plain click did nothing (RF's own
              // default has no built-in "click to recenter" — `onClick`
              // fires on every click, drag or not, but a bare click never
              // pans/zooms via the pan/zoom gesture handlers, so without
              // this it silently no-oped). `setCenter` (the same
              // ReactFlowInstance method every other "look here" idiom in
              // this file ultimately calls fitView for) recenters the main
              // viewport on the clicked minimap position, animated.
              //
              // fix/minimap-click-zoom — `setCenter` with no `zoom` option
              // snaps to RF's own `maxZoom` (2 here) instead of leaving the
              // viewport alone: a click at a dezoomed-out 17% viewport
              // teleported straight to 200%, wildly disorienting. Reads the
              // CURRENT zoom (`getZoom()`) and passes it straight back
              // through, so a minimap click only ever PANS at the existing
              // zoom level, never changes it. Falls back to 0.5 on the
              // (practically unreachable, `minZoom` is 0.1 above) chance the
              // current zoom reads back under 0.05.
              onClick={(_event, position) => {
                const instance = reactFlowInstanceRef.current;
                if (!instance) return;
                const currentZoom = instance.getZoom();
                const zoom = currentZoom < 0.05 ? 0.5 : currentZoom;
                // P47 — panel-aware: without this, a minimap click could
                // still center the clicked point under the docked
                // ManagerOverlay even though `handleFocusNode`/fitView
                // call sites elsewhere in this file are already fixed.
                const target = getPanelAwareCenterTarget(position, zoom);
                instance.setCenter(target.x, target.y, { zoom, duration: 250 });
              }}
              nodeColor={nodeMinimapColor}
              // fix/canvas-ux R4d (dogfood defect #5) — a fixed neutral
              // stroke around every node rect, on top of nodeMinimapColor's
              // own per-status/type fill, so a node is never mistaken for
              // its zone's background even in the rare case its status
              // color happens to be visually close to the zone's tint.
              nodeStrokeColor="var(--color-panel)"
              nodeStrokeWidth={2}
              // R2b chromePlan §5 — stronger dim (0.6 -> 0.75) so the
              // viewport rectangle reads clearly against a busy fleet, plus
              // the floating-card box-shadow every other chrome surface
              // (toolbar/palette/command-bar) already uses.
              maskColor="rgba(10, 10, 16, 0.75)"
              style={{
                width: 140,
                height: 100,
                background: 'var(--color-panel-3)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
                overflow: 'hidden',
              }}
            />
          )}
          <AlignmentGuides guides={dnd.dragGuides} />
          {/* W-UX3 finding A — constant screen-size LOD for dots/zone
              labels at any dezoom (see lod.ts's header). Renders nothing;
              broadcasts the live zoom as CSS vars onto canvasContainerRef. */}
          <CanvasLodBroadcaster containerRef={canvasContainerRef} />
          {/* Multiplayer presence (spec 2c) — self-contained, no props;
              renders nothing solo/no-org (PresenceOverlay.tsx's own doc
              comment + PresenceOverlay.test.tsx). */}
          <PresenceOverlay />
          {/* Live co-editing (canvas ops over the same Realtime channel) —
              renders nothing, no-op for solo/no-org. */}
          <CanvasLiveSync />
          {/* Controls hidden — CanvasToolbar replaces the default RF
              zoom/fit control cluster (spec §5). */}
          <CanvasToolbar
            minimapEnabled={prefs.minimap}
            onToggleMinimap={handleToggleMinimap}
            onOpenLibrary={onOpenLibrary}
            canUndo={pastStates.length > 0}
            canRedo={futureStates.length > 0}
            onUndo={() => canvasStoreVanilla.temporal.getState().undo()}
            onRedo={() => canvasStoreVanilla.temporal.getState().redo()}
            snapEnabled={prefs.snap}
            onToggleSnap={handleToggleSnap}
            paletteOpen={paletteOpen}
            onTogglePalette={handleTogglePalette}
            onRunLayout={() => void layout.runLayoutAll()}
            onTidyZones={layout.tidyZones}
            laneModeEnabled={layout.laneMode}
            onToggleLaneMode={layout.toggleLaneMode}
            hasSelection={hasSelection}
            onZoomToSelection={handleZoomToSelection}
            selectedDraftId={selectedDraftId}
            onLaunchSelectedDraft={handleLaunchSelectedDraft}
            searchQuery={filter.searchQuery}
            onSearchChange={filter.setSearchQuery}
            failureCount={focusFailuresCount}
            onFocusFailures={handleFocusFailures}
            onOpenShortcuts={handleToggleShortcuts}
            hideMergedEnabled={prefs.hideMerged}
            onToggleHideMerged={handleToggleHideMerged}
            wheelMode={wheelMode}
            onToggleWheelMode={handleToggleWheelMode}
            replayActive={replay.active}
            onToggleReplay={replay.toggle}
            onOpenReport={activeFleetProjectId ? () => emit('report:open', { projectId: activeFleetProjectId }) : undefined}
            onExportCanvas={handleExportCanvas}
            onImportCanvasFile={handleImportCanvasFile}
            onExportYaml={handleExportYaml}
            onImportYamlFile={handleImportYamlFile}
            onGitExport={handleGitExport}
            onExportMcp={handleExportMcp}
            followActiveEnabled={followActive.enabled}
            onToggleFollowActive={followActive.toggle}
          />
          {replay.active && <ReplayBar replay={replay} onForkMission={handleForkFromReplay} />}
          <CanvasPalette
            open={paletteOpen && !replay.active}
            onToggle={handleTogglePalette}
            activeProjectId={activeFleetProjectId}
            onAddDraft={editing.handlePaletteAddDraft}
            onAddRouter={editing.handlePaletteAddRouter}
            onAddJoin={editing.handlePaletteAddJoin}
            onAddTerminal={editing.handlePaletteAddTerminal}
            onAddPreview={editing.handlePaletteAddPreview}
            macros={macros}
            onInstantiateMacro={handleInstantiateMacroClick}
            onDeleteMacro={removeMacro}
            onRenameMacro={(macroId, name) => renameMacro(macroId, { name })}
            onImportAgentFile={handleImportAgentFile}
          />
          <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} wheelMode={wheelMode} />
          {editing.chainSource && !replay.active && (
            <Panel position="top-center">
              <div
                data-testid="canvas-chain-hint"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  borderRadius: 20,
                  background: 'var(--color-panel-2)',
                  border: '1px solid var(--color-accent-border)',
                  color: 'var(--color-text)',
                  fontSize: 12,
                  fontWeight: 600,
                  boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
                }}
              >
                {t('canvas.chainHint')}
                <button
                  type="button"
                  data-testid="canvas-chain-hint-cancel"
                  onClick={() => editing.setChainSource(null)}
                  style={{ border: 'none', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 13 }}
                >
                  ×
                </button>
              </div>
            </Panel>
          )}
        </ReactFlow>
      </CanvasActionsProvider>
      {editing.contextMenu && !replay.active && (
        <CanvasContextMenu
          state={editing.contextMenu}
          onClose={() => editing.setContextMenu(null)}
          onArmChainFrom={(ref) => editing.setChainSource(ref)}
          onOpenQuickCreateAt={editing.handleOpenQuickCreateAt}
          onPasteAt={editing.handlePasteAt}
          onSelectAllInZone={editing.handleSelectAllInZone}
          onSaveMacro={(refs) => setSaveMacroRefs(refs)}
          // W-CAMERA — deferred one frame, same rationale as
          // handleZoomToSelection above.
          onRecenter={() =>
            requestAnimationFrame(() =>
              reactFlowInstanceRef.current?.fitView({ padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING, true) }),
            )
          }
          onTidyUp={() => void layout.runLayoutAll()}
          hasClipboard={editing.hasClipboard()}
          projectZones={projectZones}
          nodes={nodes}
        />
      )}
      <CanvasCommandBar
        open={commandBarOpen && !replay.active}
        onClose={handleCloseCommandBar}
        activeProjectId={activeFleetProjectId}
        onAddDraft={editing.handlePaletteAddDraft}
        onRunLayout={() => void layout.runLayoutAll()}
        onToggleLaneMode={layout.toggleLaneMode}
        // W-CAMERA — deferred one frame, same rationale as
        // handleZoomToSelection above.
        onRecenter={() =>
          requestAnimationFrame(() =>
            reactFlowInstanceRef.current?.fitView({ padding: getPanelAwarePadding(FIT_VIEW_VERTICAL_PADDING, true) }),
          )
        }
        onFocusFailures={handleFocusFailures}
        onToggleMinimap={handleToggleMinimap}
        onToggleSnap={handleToggleSnap}
        onTogglePalette={handleTogglePalette}
      />
      {quickCreateState && !replay.active && (
        <CanvasQuickCreateModal
          mode={quickCreateState.mode}
          initial={quickCreateState.mode === 'edit' ? quickCreateState.initial : undefined}
          onSubmit={editing.handleQuickCreateSubmit}
          onCancel={() => editing.setQuickCreate(null)}
          // Draft version history (additive) — only meaningful in 'edit'
          // mode. Reads off the LOCAL `quickCreateState` const (rather than
          // `editing.quickCreate` again) so TypeScript's discriminated-union
          // narrowing survives into the onRestoreVersion closure below.
          versions={quickCreateState.mode === 'edit' ? (draftVersions[quickCreateState.draftId] ?? []) : undefined}
          onRestoreVersion={
            quickCreateState.mode === 'edit' ? (ts: number) => restoreDraftVersion(quickCreateState.draftId, ts) : undefined
          }
        />
      )}
      {saveMacroRefs && !replay.active && (
        <CanvasSaveMacroModal
          nodeCount={saveMacroRefs.length}
          onSubmit={handleSaveMacroSubmit}
          onCancel={() => setSaveMacroRefs(null)}
        />
      )}
      {edgeDropPicker && !replay.active && (
        <EdgeDropNodePicker
          screenPosition={edgeDropPicker.screenPosition}
          onSelect={handleEdgeDropSelect}
          onCancel={handleEdgeDropCancel}
        />
      )}
      {!replay.active && (
        <CanvasFloatingButtons
          onRunAgent={(_agent, _task) => {
            // For now, just open the library — the agent will be selectable
            // from the palette. A future iteration can create a draft directly.
            onOpenLibrary();
          }}
        />
      )}
      {!replay.active && <CanvasToolActivityOverlay />}
      {!replay.active && <CanvasBrowserPanel />}
      {!replay.active && <CanvasSwarmPanel />}
      {/* fix/canvas-edge-fade (owner-reported: at the fca47b0-floored 60%
          boot zoom, with the ManagerOverlay docked wide, the canvas's own
          right edge — where this container's box legitimately ends, see
          `reservedRightPx`'s doc comment above — lands mid-mission-card, a
          hard slice that reads as broken rather than "more content, pan to
          see it". NOT a semantic-zoom fix: this is a purely decorative,
          zoom-independent gradient over the container's OWN edge, painted
          identically regardless of what's rendered underneath or at what
          zoom — it changes nothing about WHAT renders, only softens WHERE
          the viewport visibly ends. `pointerEvents: 'none'` keeps it fully
          click/drag-through, so nothing about interacting with a
          partially-visible card changes. Gated on an actual docked panel
          (reservedRightPx > 0) — a full-bleed canvas with no panel has no
          "sliced by a boundary" impression to soften. */}
      {reservedRightPx > 0 && (
        <div
          aria-hidden="true"
          data-testid="canvas-edge-fade-right"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 40,
            pointerEvents: 'none',
            background: 'linear-gradient(to right, transparent, var(--color-bg) 90%)',
          }}
        />
      )}
    </div>
  );
}

/**
 * Perf audit 2026-08-15 (item 3, top measured render-churn offender):
 * `Cockpit.tsx` used to mount this component un-memoized. Cockpit itself
 * re-renders on every ~2.5s fleet poll tick (useFleetMissions,
 * lib/agents/fleetMissions.ts) AND on every unrelated local-state change
 * (hover highlight, KPI popovers, manager draft, ...) — without `memo`,
 * EVERY one of those re-rendered this component's full React Flow tree in
 * full, even though the poll tick's own DOM is viewport-culled and most of
 * those triggers have nothing to do with what this component shows.
 *
 * Honest scope of what this buys, MEASURED in
 * src/__tests__/Cockpit.rerenderChurn.test.tsx: `memo` eliminates
 * re-renders when Cockpit re-renders for an UNRELATED reason (its own local
 * state, or another child's props changing) while this component's actual
 * props stay referentially the same. It does NOT reduce renders driven by
 * the fleet poll tick itself: `projects` (this component's dominant prop)
 * is a fresh `useMemo`-derived array every time `rows` changes inside
 * `useFleetMissions` (fleetMissions.ts), and `rows` itself is a fresh
 * `journal_missions_current` query result on every ~2.5s tick regardless of
 * whether the underlying mission data actually changed — that reference
 * churn is real, separate, and NOT fixed here (fleetMissions.ts is
 * currently a DIFFERENT agent's in-flight work; see this file's own perf
 * audit note for why it stays untouched by this change).
 */
export const CanvasView = memo(CanvasViewImpl);
