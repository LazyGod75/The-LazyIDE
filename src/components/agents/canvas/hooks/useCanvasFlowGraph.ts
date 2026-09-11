/* useCanvasFlowGraph.ts â€” reconciliation -> live React Flow graph (W2b
   refactor of CanvasView.tsx â€” deliverable #0). Bundles the "turn fleet +
   canvasStore facts into the ACTUAL React Flow nodes/edges array the
   canvas renders" pipeline that used to live inline in CanvasView.tsx's
   body:
     - `reconcile()` (spec Â§6) with referential-stability (`prevNodes`);
     - the highlightIds/justMergedId "just arrived" overlay AND W2b's
       search/filter dim overlay (both light className overlays, spec
       Â§4.4/Â§5) â€” kept together since both compute the SAME per-node
       className list in one pass;
     - local React Flow node/edge `useState` (smooth drag/select â€” module
       doc comment on CanvasView.tsx's original header still applies
       verbatim: only a drag's FINAL frame is written back to
       canvasStore.setPositions, never every intermediate frame);
     - the live `ReactFlowInstance` ref + `screenToFlowPosition`/zone
       hit-testing helpers every OTHER canvas hook (editing/DnD/keyboard)
       needs to resolve a screen point into "where in which zone".

   Everything downstream (useCanvasEditing/useCanvasDnd/useCanvasKeyboard/
   CanvasView's own JSX) consumes this hook's OUTPUT â€” none of them touch
   `reconcile()` or the RF local state directly anymore.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnMoveEnd, ReactFlowInstance, NodeChange, EdgeChange } from '@xyflow/react';
import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react';
import { reconcile, type BotNodeInput, type CanvasReactFlowEdge, type CanvasReactFlowNode, type MissionLoopMeta, type ReconcileInputs } from '../reconciler';
import { listBots } from '../../../../lib/bots/botStorage';
import { getBotRuntimeState } from '../../../../lib/bots/botEngine';
import { listPendingApprovals } from '../../../../lib/agents/approval/approvalGate';
import { on } from '../../../../lib/bus';
import { isBotVmWindowOpen, getBotVmWindowSize, subscribeBotVmWindows } from '../../../../lib/solari/botVmWindows';
import { canvasStoreVanilla, isPositionsPatchNoop, useCanvasStore, type CanvasViewport } from '../canvasStore';
import { emitLocalCanvasMove } from '../../../../lib/collab/canvasOpBridge';
import { zoneAtPoint, zoneGeometriesFromNodes, toZoneRelative, type FlowPoint, type ZoneGeometry } from '../canvasPlacement';
import { findFreePosition, type Size } from '../placementCollision';
import { makeRef } from '../canvasTypes';
import { decorateEdgesForReplay, decorateNodesForReplay } from '../replay/replayDecoration';
import type { FleetStateEntry } from '../replay/replayModel';

/**
 * React Flow requires a parent node (`type: 'project'`) to appear BEFORE
 * its children in the `nodes` array. reconciler.ts's `buildZone` already
 * pushes each zone's project node before its children â€” this is a cheap
 * invariant guard only: a stable partition (every zone is exactly one
 * level deep) that costs nothing when the input is already correctly
 * ordered and still protects the canvas from RF's "Parent node not found"
 * warning if that invariant is ever broken again upstream.
 */
function orderParentsFirst(nodes: readonly CanvasReactFlowNode[]): CanvasReactFlowNode[] {
  const projects = nodes.filter((n) => n.type === 'project');
  const children = nodes.filter((n) => n.type !== 'project');
  return [...projects, ...children];
}

/**
 * Module-level (not a `useRef`) â€” W5b fix, same precedent as
 * AgentGrid.tsx's `sessionZoom`: AgentsSpace.tsx only renders `<Cockpit/>`
 * (and therefore `<CanvasView/>`) while `activeTab === 'mission-control'`;
 * opening the BibliothÃ¨que tab and coming back FULLY unmounts/remounts
 * CanvasView. A per-instance `useRef` reset to empty on every such
 * remount, which made `displayNodes` below mark EVERY already-existing
 * mission as "just arrived" (`canvas-bounce-once`) each time the user
 * merely switched tabs and back â€” never a genuinely new mission, so never
 * a real "just arrived" pulse (spec Â§6). Module scope survives the
 * remount; it only resets on a real page reload/app restart, which is
 * exactly when "every node is new" is actually true again. */
let seenCanvasNodeIds = new Set<string>();

/** Runs `cb` on the next animation frame, falling back to a ~16ms timer
 *  where `requestAnimationFrame` doesn't exist (jsdom â€” every component test
 *  that mounts a real `<ReactFlow>`, e.g. CanvasView.test.tsx). Returns a
 *  disposer so a `useEffect` can cancel a still-pending frame on cleanup
 *  (rapid reconcile churn, or unmount) â€” see the BUG 2 fix (W6f) below. */
function scheduleFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

export interface UseCanvasFlowGraphParams extends Omit<ReconcileInputs, 'prevNodes' | 'missionLoopMeta'> {
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>;
  highlightIds: ReadonlySet<string>;
  justMergedId: string | null;
  /** True when a search query or status filter is currently active (spec
   *  Â§5) â€” when false, `nodeMatches` is never even consulted (every node
   *  stays full opacity, matching useCanvasFilter's own contract). */
  isFilterActive: boolean;
  nodeMatches: (node: CanvasReactFlowNode) => boolean;
  /**
   * W8d Replay â€” when provided and `active`, the hook's own `nodes`/`edges`
   * output is decorated for the given instant (see
   * ../replay/replayDecoration.ts's module header): historical status/stage
   * overlaid, not-yet-created nodes hidden, drafts/notes dimmed, chain
   * edges pulsed for a historical fire. Absent/`active: false` outside
   * Replay mode â€” zero overhead, `nodes`/`edges` pass through unchanged.
   */
  replay?: {
    active: boolean;
    fleetState: ReadonlyMap<string, FleetStateEntry>;
    firingChainIds: ReadonlySet<string>;
  };
}

export interface UseCanvasFlowGraphResult {
  nodes: CanvasReactFlowNode[];
  edges: CanvasReactFlowEdge[];
  setNodes: React.Dispatch<React.SetStateAction<CanvasReactFlowNode[]>>;
  onNodesChange: (changes: NodeChange<CanvasReactFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasReactFlowEdge>[]) => void;
  onMoveEnd: OnMoveEnd;
  reactFlowInstanceRef: React.RefObject<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> | null>;
  projectZones: readonly ZoneGeometry[];
  resolveFlowPoint: (clientX: number, clientY: number) => FlowPoint | null;
  placeInZoneOrTransverse: (flowPosition: FlowPoint, footprint?: Size) => { projectId?: string; relativePosition: FlowPoint };
}

export function useCanvasFlowGraph(params: UseCanvasFlowGraphParams): UseCanvasFlowGraphResult {
  const { highlightIds, justMergedId, isFilterActive, nodeMatches, replay, ...reconcileInputs } = params;

  const setPositions = useCanvasStore((s) => s.setPositions);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const markSessionDragged = useCanvasStore((s) => s.markSessionDragged);
  const exitingRefs = useCanvasStore((s) => s.exitingRefs);

  const prevReconcileNodesRef = useRef<readonly CanvasReactFlowNode[]>([]);

  // LazyBot wave — load persisted bots + coarse runtime snapshot, feed them
  // into reconcile() so each bot renders as a `bot` node in the LazyBots zone.
  const [botInputs, setBotInputs] = useState<BotNodeInput[]>([]);
  useEffect(() => {
    let cancelled = false;
    const derive = (bots: Awaited<ReturnType<typeof listBots>>): BotNodeInput[] =>
      bots.map((bot) => {
        const activeRuns = getBotRuntimeState(bot.id).activeRuns;
        // A bot is 'waiting' when one of its active runs has a pending
        // approval (approvalGate). Otherwise it is 'working' while it has an
        // active run, else 'idle'.
        const waiting = activeRuns.some((missionId) =>
          listPendingApprovals().some((p) => p.missionId === missionId),
        );
        return {
          bot,
          status: waiting ? 'waiting' : activeRuns.length > 0 ? 'working' : 'idle',
          activeRuns: activeRuns.length,
          activeRunIds: activeRuns,
          ...(isBotVmWindowOpen(bot.id) ? { vmOpen: true, vmSize: getBotVmWindowSize(bot.id) } : {}),
        };
      });
    const load = async () => {
      // listBots() already waits for getCachedProjectRoot() internally
      // (botStorage.rootPath with waitForRoot=true). No need to duplicate
      // the wait here — just call listBots() and let it handle the timing.
      const bots = await listBots().catch(() => []);
      if (cancelled) return;
      setBotInputs(derive(bots));
    };
    void load();
    // Keep status halos honest while the canvas is mounted: refresh when a
    // pending approval appears/resolves, when a bot VM window opens/closes,
    // and on every bot-runtime mutation (botEngine emits
    // 'lazybots:runtimeChanged' at each register/finish/stop/slot site —
    // the 5s polling interval this replaced). A slow 30s safety net stays
    // for the one uncovered case: a run that died by crash/HMR without
    // reaching finishBotRun/stopBotRun (its stale entry gets reaped by the
    // next real event or this net, whichever comes first).
    const offApproval = on('solari:approvalRequest', () => void load());
    const offResolved = on('solari:approvalResolved', () => void load());
    const offRoster = on('lazybots:changed', () => void load());
    const offRuntime = on('lazybots:runtimeChanged', () => void load());
    const offRoot = on('projectRoot:resolved', () => void load());
    const offVmWindows = subscribeBotVmWindows(() => void load());
    const interval = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      offApproval();
      offResolved();
      offRoster();
      offRuntime();
      offRoot();
      offVmWindows();
      clearInterval(interval);
    };
  }, []);

  const reconciled = useMemo(
    () => reconcile({ ...reconcileInputs, bots: botInputs, prevNodes: prevReconcileNodesRef.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      botInputs,
      reconcileInputs.projects,
      reconcileInputs.drafts,
      reconcileInputs.chains,
      reconcileInputs.notes,
      reconcileInputs.scheduled,
      // W9 fix: `routers` was accepted by ReconcileInputs (W8c, additive)
      // but never in this dep list, so even a caller that DID thread it
      // through would only ever see a stale/default reconcile â€” a router
      // add/edit would not re-trigger `reconcile()` until some UNRELATED
      // dep also happened to change.
      reconcileInputs.routers,
      // W-JOIN (additive) â€” same "must be in the dep list or a change never
      // re-triggers reconcile()" fix `routers` needed above.
      reconcileInputs.joins,
      // R7 (living surfaces, additive) â€” same "must be in the dep list or a
      // change never re-triggers reconcile()" fix `routers` needed above
      // (W9's own comment on this exact bug shape).
      reconcileInputs.surfaces,
      // W-CLOSE row 2 (frames, additive) â€” same "must be in the dep list or
      // a change never re-triggers reconcile()" fix routers/surfaces needed
      // above.
      reconcileInputs.frames,
      reconcileInputs.expandedPanels,
      reconcileInputs.positions,
      reconcileInputs.collapsed,
      reconcileInputs.prefs,
      reconcileInputs.activeProjectId,
      reconcileInputs.forceApproveIds,
      reconcileInputs.missionLoopMeta,
      // R10 (persisted-position declutter, additive) â€” same "must be in the
      // dep list" fix routers/surfaces needed above: without this, marking a
      // ref session-dragged mid-session would never actually protect it
      // until some unrelated dep also happened to change.
      reconcileInputs.sessionDraggedRefs,
      // W-DISMISS (additive) â€” same "must be in the dep list or a change
      // never re-triggers reconcile()" fix sessionDraggedRefs needed above:
      // without this, dismissing a mission would never actually hide it
      // until some unrelated dep also happened to change.
      reconcileInputs.dismissedRefs,
    ],
  );

  useEffect(() => {
    prevReconcileNodesRef.current = reconciled.nodes;
  }, [reconciled.nodes]);

  // fix/canvas-ux R10 â€” persists the declutter pass's corrections
  // (reconciler.ts's `declutteredPositions`) back into canvasStore, so a
  // resolved pinned x pinned collision becomes the new (non-colliding) truth
  // instead of being silently re-discovered and re-resolved on every single
  // reconcile.
  //
  // fix(canvas): the non-empty check ALONE is NOT enough (P0 real-app
  // crash â€” "Agents crashed / React error #185, Maximum update depth
  // exceeded", reproduced live). e1b2e60 ("Keep proposed canvas items on
  // hydration") started restoring a leftover proposed plan's drafts/joins
  // and their pinned positions on every hydrate; when two of those restored
  // positions collide, the declutter pass above computes the SAME
  // correction on every single reconcile â€” a non-empty, but VALUE-IDENTICAL
  // patch every time. `setPositions` still spread-merged into a NEW
  // `positions` object even when the values never actually changed, whose
  // changed IDENTITY alone re-triggers this memo (`reconciled` depends on
  // `reconcileInputs.positions`), which recomputes `declutteredPositions`
  // fresh (new object, same values), which re-triggers THIS effect (its dep
  // is that object's identity) â€” forever, with nothing ever really
  // changing. Two layers now stop it: `isPositionsPatchNoop` here skips
  // calling the action at all for the common case (cheap, avoids even
  // touching the store), and `setPositions` itself (canvasStore.ts) is ALSO
  // a no-op for a value-identical patch â€” belt-and-suspenders, since a
  // future call site of `setPositions` could reintroduce the same shape of
  // loop without going through this effect.
  useEffect(() => {
    if (Object.keys(reconciled.declutteredPositions).length === 0) return;
    if (isPositionsPatchNoop(canvasStoreVanilla.getState().positions, reconciled.declutteredPositions)) return;
    setPositions(reconciled.declutteredPositions);
  }, [reconciled.declutteredPositions, setPositions]);

  const displayNodes = useMemo<CanvasReactFlowNode[]>(() => {
    const seen = seenCanvasNodeIds;
    const exitingSet = new Set(exitingRefs.map(String));
    return orderParentsFirst(reconciled.nodes).map((node) => {
      const classes: string[] = [];
      if (highlightIds.has(node.id)) classes.push('canvas-halo-running');
      if (node.id === justMergedId) classes.push('focus-flash');
      if (!seen.has(node.id)) classes.push('canvas-bounce-once');
      if (isFilterActive && !nodeMatches(node)) classes.push('canvas-dim');
      if (exitingSet.has(node.id)) classes.push('canvas-fade-exit');
      if (classes.length === 0) return node;
      return { ...node, className: classes.join(' ') };
    });
  }, [reconciled.nodes, highlightIds, justMergedId, isFilterActive, nodeMatches, exitingRefs]);

  useEffect(() => {
    seenCanvasNodeIds = new Set(reconciled.nodes.map((n) => n.id));
  }, [reconciled.nodes]);

  const [nodes, setNodes] = useState<CanvasReactFlowNode[]>([]);
  const [edges, setEdges] = useState<CanvasReactFlowEdge[]>([]);

  useEffect(() => setNodes(displayNodes), [displayNodes]);

  // BUG 2 fix (W6f real-app repro): committing a brand-new node and a new
  // edge that references it in the SAME React commit races React Flow v12's
  // own per-node measurement â€” a node's handle bounds only exist once its
  // DOM element has reported back through a ResizeObserver, which cannot
  // happen before the node has even painted. If EdgeWrapper's very first
  // position lookup lands before that report, the edge silently renders
  // nothing (@xyflow/system's isNodeInitialized/getEdgePosition, no
  // console error) â€” and because OUR `edges` array reference never changes
  // again on its own afterwards, nothing ever prompts React Flow to look at
  // that same edge a second time. Observed live: a chain existed in the
  // store and on disk, with zero `.react-flow__edge` in the DOM.
  //
  // Deferring the edges commit by one frame relative to the nodes commit
  // sidesteps the race structurally instead of guessing at RF's internal
  // retry behavior: by the time `edges` actually updates, every node this
  // reconcile pass just added has had a full paint (and therefore its first
  // ResizeObserver report) to be measured. `scheduleFrame` falls back to a
  // ~16ms timer where `requestAnimationFrame` doesn't exist (jsdom, in every
  // component test that mounts a real `<ReactFlow>`) instead of throwing.
  useEffect(() => scheduleFrame(() => setEdges(reconciled.edges)), [reconciled.edges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasReactFlowNode>[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      const committed: Record<string, { x: number; y: number }> = {};
      for (const change of changes) {
        if (change.type === 'position' && change.position && change.dragging === false) {
          committed[change.id] = change.position;
        }
      }
      if (Object.keys(committed).length > 0) {
        setPositions(committed);
        // fix/canvas-ux R10 â€” this IS the user actively dragging a node this
        // session (a real drag's FINAL frame, not a programmatic setPositions
        // call elsewhere â€” e.g. CanvasContextMenu.tsx's paste/duplicate) â€”
        // mark it so the persisted-position declutter pass never nudges it,
        // even against a more-recently-updated pinned sibling.
        for (const ref of Object.keys(committed)) markSessionDragged(ref);
        // Live co-editing: broadcast the committed moves to teammates on the
        // org/project Realtime channel (no-op when no live channel is up).
        for (const [ref, pos] of Object.entries(committed)) {
          emitLocalCanvasMove(ref, pos);
        }
      }
    },
    [setPositions, markSessionDragged],
  );

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasReactFlowEdge>[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  const onMoveEnd = useCallback<OnMoveEnd>(
    (_event, viewport: CanvasViewport) => {
      setViewport(viewport);
    },
    [setViewport],
  );

  const reactFlowInstanceRef = useRef<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> | null>(null);

  const projectZones = useMemo(() => zoneGeometriesFromNodes(nodes), [nodes]);

  const resolveFlowPoint = useCallback((clientX: number, clientY: number): FlowPoint | null => {
    const instance = reactFlowInstanceRef.current;
    if (!instance) return null;
    return instance.screenToFlowPosition({ x: clientX, y: clientY });
  }, []);

  // fix/canvas-ux R4a â€” the ONE choke point every interactive creation path
  // (edge-drop picker + the "Lancer un agent" CTA's quick-create, palette
  // drag-drop, note-add, paste â€” see CanvasView.tsx/useCanvasDnd.ts/
  // useCanvasEditing.ts's call sites) already funnels through: previously
  // this returned the raw drop point verbatim, with zero awareness of what
  // else already occupies that zone â€” a router/draft/note could get
  // persisted (setPositions) directly on top of an existing sibling, and
  // since that position is then PINNED forever (reconcilerZones.ts's
  // `assignChildPositions` never moves a stored position), the overlap
  // would never self-heal on a later reconcile either. `footprint` (the new
  // node's real size, DEFAULT_NODE_SIZE from reconciler.ts) is now optional
  // ONLY for source-compat with any caller that hasn't been updated to pass
  // one yet â€” every real call site in this codebase does.
  const placeInZoneOrTransverse = useCallback(
    (flowPosition: FlowPoint, footprint?: Size): { projectId?: string; relativePosition: FlowPoint } => {
      const zone = zoneAtPoint(projectZones, flowPosition);
      if (!zone) return { relativePosition: flowPosition };
      const relativePosition = toZoneRelative(flowPosition, zone);
      if (!footprint) return { projectId: zone.projectId, relativePosition };

      const zoneRef = makeRef('project', zone.projectId);
      const siblingRects = nodes
        .filter((n) => n.parentId === zoneRef)
        .map((n) => ({ x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 }));
      const freePosition = findFreePosition(siblingRects, footprint, relativePosition);
      return { projectId: zone.projectId, relativePosition: freePosition };
    },
    [projectZones, nodes],
  );

  // W8d Replay â€” a RENDER-only overlay on top of the live `nodes`/`edges`
  // state (never a second reconcile, never fed back into `setNodes`/
  // `setEdges`): see ../replay/replayDecoration.ts's module header. `nodes`/
  // `edges` below still drive onNodesChange/onEdgesChange/setNodes exactly
  // as before â€” only the RETURNED (render) arrays differ while replay is
  // active, and exiting replay drops this memo's branch instantly (same
  // "decoration removed" contract `displayNodes` above already documents).
  const renderNodes = useMemo(
    () => (replay?.active ? decorateNodesForReplay(nodes, replay.fleetState) : nodes),
    [nodes, replay],
  );
  const renderEdges = useMemo(
    () => (replay?.active ? decorateEdgesForReplay(edges, replay.firingChainIds) : edges),
    [edges, replay],
  );

  return {
    nodes: renderNodes,
    edges: renderEdges,
    setNodes,
    onNodesChange,
    onEdgesChange,
    onMoveEnd,
    reactFlowInstanceRef,
    projectZones,
    resolveFlowPoint,
    placeInZoneOrTransverse,
  };
}
