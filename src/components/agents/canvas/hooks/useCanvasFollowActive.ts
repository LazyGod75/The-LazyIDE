/* useCanvasFollowActive.ts — P47 deliverable #2: « Suivre l'activité »
   toolbar toggle (default ON for a project with exactly one running
   mission). While enabled, a mission transitioning INTO 'running' or
   'review' in the ACTIVE project smoothly `setCenter`s (panel-aware, see
   cameraInsets.ts — keeps the CURRENT zoom, never a rezoom) onto that
   mission's node, 2s after the last qualifying transition (debounced — a
   burst of several missions changing status together settles on the LATEST
   one rather than yanking the camera once per mission) and only if the
   user hasn't panned/zoomed by hand in the last 30s.

   Mirrors useCanvasAutoComposition.ts's own "diff this render's fleet
   against the previous one" status-transition shape (that hook's own
   module header — "mission status-transition watcher") for a DIFFERENT,
   additive, user-visible behavior (an explicit toggle, not a silent
   auto-nudge) — kept in its own file/own `prevStatusRef` rather than folded
   into that hook, which is outside this wave's file-ownership split (P47's
   brief) and already owns a similar-but-distinct "pan if running and
   fully offscreen" behavior; the two are independent and can co-exist
   (this one recenters exactly on request, following the toggle; that one
   nudges regardless of the toggle, only when a node is fully offscreen). */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import type { FleetMission, FleetProject } from '../../../../lib/agents/fleetMissions';
import { makeRef } from '../canvasTypes';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../reconciler';
import { measureDockedPanelInsets, setCenterTarget } from '../cameraInsets';

/** Settles on the LATEST qualifying transition instead of re-centering once
 *  per mission when several change status together. */
const FOLLOW_DEBOUNCE_MS = 2_000;
/** Any real user pan/zoom (RF's `onMoveStart` with a non-null event) pauses
 *  following for this long — "the user is looking at something else". */
const FOLLOW_PAUSE_AFTER_USER_MOVE_MS = 30_000;
const FOLLOW_SET_CENTER_DURATION_MS = 400;
const FOLLOW_TRANSITION_STATUSES: ReadonlySet<FleetMission['status']> = new Set(['running', 'review']);

export interface UseCanvasFollowActiveParams {
  projects: readonly FleetProject[];
  /** The fleet-shaped project id (`projectIdFromRoot`) of the active
   *  project, or `undefined`/`null` when none is open — same shape
   *  CanvasView already derives for `useCanvasFlowGraph`'s own
   *  `activeProjectId`. */
  activeFleetProjectId: string | null | undefined;
  reactFlowInstanceRef: React.RefObject<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> | null>;
  /** CanvasView's own outer container ref — read for its real client rect
   *  (setCenterTarget's `viewport`) and passed straight through to
   *  `measureDockedPanelInsets` (same ref, same rationale as that
   *  function's own doc comment: a sibling of the two floating overlays
   *  inside `cockpit-fullbleed-root`). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** W8d Replay posture — following is a LIVE-canvas camera nudge; suspended
   *  while scrubbing history, same gate every other live nudge in this
   *  directory (useCanvasManagerEvents/useCanvasAutoComposition) already
   *  takes. */
  replayActive?: boolean;
}

export interface UseCanvasFollowActiveResult {
  enabled: boolean;
  toggle: () => void;
  /** Wire to `<ReactFlow onMoveStart>`. React Flow passes `event: null` for
   *  every PROGRAMMATIC move (fitView/setCenter/setViewport) — including
   *  this hook's own follow pans — and the real DOM event for an actual
   *  user gesture (wheel/drag/pinch), so this only ever pauses on a genuine
   *  user-interaction, never self-pauses on its own centering. */
  onPaneMoveStart: (event: MouseEvent | TouchEvent | null) => void;
}

export function useCanvasFollowActive({
  projects,
  activeFleetProjectId,
  reactFlowInstanceRef,
  containerRef,
  replayActive = false,
}: UseCanvasFollowActiveParams): UseCanvasFollowActiveResult {
  const activeProject = useMemo(
    () => projects.find((p) => p.projectId === activeFleetProjectId) ?? null,
    [projects, activeFleetProjectId],
  );
  const runningCount = useMemo(
    () => activeProject?.missions.filter((m) => m.status === 'running').length ?? 0,
    [activeProject],
  );

  // Default ON exactly once, the FIRST time the active project resolves
  // with exactly one running mission (spec: "default ON for a project with
  // exactly one running mission") — a LATER change in running-mission count
  // never flips this back by itself; only the user's own toggle click does,
  // same "the user's explicit choice always wins" posture every other
  // canvas pref (prefs.snap/minimap/hideMerged, canvasStore.ts) already
  // takes.
  const [enabled, setEnabled] = useState(false);
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current || !activeProject) return;
    initializedRef.current = true;
    setEnabled(runningCount === 1);
  }, [activeProject, runningCount]);

  const toggle = useCallback(() => setEnabled((v) => !v), []);

  const lastUserMoveAtRef = useRef(0);
  const onPaneMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) lastUserMoveAtRef.current = Date.now();
  }, []);

  const debounceTimerRef = useRef<number | null>(null);
  const pendingRefRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current);
    },
    [],
  );

  const runFollow = useCallback(() => {
    debounceTimerRef.current = null;
    const targetRef = pendingRefRef.current;
    pendingRefRef.current = null;
    if (!targetRef) return;
    if (Date.now() - lastUserMoveAtRef.current < FOLLOW_PAUSE_AFTER_USER_MOVE_MS) return;
    const instance = reactFlowInstanceRef.current;
    const container = containerRef.current;
    if (!instance || !container) return;
    const node = instance.getNode(targetRef);
    if (!node) return;
    const width = node.measured?.width ?? node.width ?? 220;
    const height = node.measured?.height ?? node.height ?? 140;
    const focusPoint = { x: node.position.x + width / 2, y: node.position.y + height / 2 };
    const zoom = instance.getZoom();
    const rect = container.getBoundingClientRect();
    const insets = measureDockedPanelInsets(container);
    const target = setCenterTarget(focusPoint, { width: rect.width, height: rect.height }, insets, zoom);
    void instance.setCenter(target.x, target.y, { zoom, duration: FOLLOW_SET_CENTER_DURATION_MS });
  }, [reactFlowInstanceRef, containerRef]);

  const prevStatusRef = useRef<Map<string, FleetMission['status']>>(new Map());

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    const missions = activeProject?.missions ?? [];

    if (replayActive || !enabled) {
      // Still record the latest statuses (without acting on them) so
      // re-enabling later never treats every ALREADY-running mission as a
      // fresh "just started" transition.
      for (const mission of missions) prevStatus.set(mission.id, mission.status);
      return;
    }

    for (const mission of missions) {
      const prev = prevStatus.get(mission.id);
      // `prev !== undefined` excludes a mission's FIRST observation (boot/
      // project-switch snapshot): a project opened with work already
      // running is not "work just started" — following would yank the
      // camera the instant the toggle turns on, exactly the kind of
      // surprise this feature promises never to do (same exclusion
      // useCanvasAutoComposition.ts's own work-auto-focus already applies).
      if (FOLLOW_TRANSITION_STATUSES.has(mission.status) && prev !== undefined && prev !== mission.status) {
        pendingRefRef.current = makeRef('mission', mission.id);
        if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = window.setTimeout(runFollow, FOLLOW_DEBOUNCE_MS);
      }
      prevStatus.set(mission.id, mission.status);
    }
  }, [activeProject, enabled, replayActive, runFollow]);

  return { enabled, toggle, onPaneMoveStart };
}
