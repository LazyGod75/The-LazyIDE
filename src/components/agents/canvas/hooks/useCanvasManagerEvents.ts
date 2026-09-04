/* useCanvasManagerEvents.ts — LazyManager choreography listeners (Agent
   Canvas W4, spec §8.2 "manager-initiated canvas mutations animate
   visibly"). Subscribes to the three bus events the manager executor
   (agentsStore.tsx) emits and turns them into REAL canvas effects, using
   the exact same primitives a human's own toolbar/menu clicks use:

     - 'canvas:arrange' {scope?, mode?} -> useCanvasLayout's real
       runLayoutAll(scope)/setLaneMode(enabled) — never a duplicated
       reconcile (see lib/bus.ts's own doc comment on why this is bus-routed
       at all: only CanvasView owns the LIVE nodes/edges elkjs needs).
     - 'canvas:focus' {ref} -> fitView on that one node (400ms glide, spec
       §8.2) + the SAME highlight pulse 'canvas:highlight' drives.
     - 'canvas:highlight' {refs} -> a transient ref set merged into
       CanvasView's `highlightIds` (reuses useCanvasFlowGraph's existing
       `canvas-halo-running` overlay class — no new CSS, no second pulse
       mechanism), auto-cleared after its own duration.

   A ref-of-latest-params pattern (`paramsRef`) keeps the bus subscription
   itself mounted exactly ONCE (empty effect deps) even though
   `runLayoutAll`/`setLaneMode` are recreated on every render (they close
   over the live `nodes`/`edges` — see useCanvasLayout.ts) — the same
   "subscribe once, read live callbacks via a ref" shape
   useCanvasKeyboard.ts's own hoveredRef/lastMouseClientRef already
   establish in this directory, so re-subscribing on every render (and
   therefore missing/duplicating an event during the gap) never happens.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import { on } from '../../../../lib/bus';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../reconciler';
import {
  CANVAS_FIT_TOP_RESERVE_PX,
  DEFAULT_HORIZONTAL_GUTTER_PX,
  FOCUS_MIN_READABLE_ZOOM,
  insetFitViewPadding,
  measureDockedPanelInsets,
} from '../cameraInsets';

/** P47 — 'canvas:focus' fitView's own vertical breathing-room fraction
 *  (top/bottom), matching CanvasView.tsx's own FIT_VIEW_VERTICAL_PADDING
 *  (0.2); left/right fold in the ManagerOverlay/CockpitLeftRail insets
 *  instead (see cameraInsets.ts's own header for why a manager-driven
 *  focus needs this as much as every user-driven one — it's the SAME
 *  `fitView`, just a different trigger). */
const FOCUS_FIT_VERTICAL_PADDING = 0.2;

/** Spawn/note/chain choreography pulse (spec §8.2: "keep it subtle"). */
const HIGHLIGHT_PULSE_MS = 2_500;
/** focus_canvas's own shorter pulse (spec §8.1: "camera pans/zooms ...
 *  highlight pulse"; deliverable #3's "2s highlight pulse"). */
const FOCUS_PULSE_MS = 2_000;
const FOCUS_FIT_DURATION_MS = 400;

/** fix/canvas-manager-camera — a 'canvas:focus' arriving within this many ms
 *  of a 'canvas:highlight' batch that (a) includes the focus ref and (b)
 *  names MORE than one ref is treated as "focus the whole ensemble this turn
 *  just created", not just the single ref (spec ask: "la camera doit se
 *  poser sur l'ENSEMBLE des noeuds crees dans ce tour"). agentsStore.tsx's
 *  own multi-draft materialization emits both bus events back-to-back,
 *  synchronously, in the SAME reply (`emit('canvas:highlight', {refs:
 *  allNewRefs}); emit('canvas:focus', {ref: allNewRefs[0]})`) — generous
 *  enough to survive the scheduleFrame hops below without ever reusing a
 *  genuinely stale highlight from an unrelated earlier turn. */
const ENSEMBLE_WINDOW_MS = 500;

/** fix/canvas-manager-camera — bounded retries (one rAF apart) for the
 *  "target not yet reconciled" race: a 'canvas:focus' whose ref names a
 *  node the reconciler hasn't applied to React Flow's own internal node
 *  lookup yet (draft/router/join just created this same turn) used to fire
 *  `fitView({nodes: [{id: ref}]})` against zero matching nodes — React
 *  Flow's `getFitViewNodes` then resolves an EMPTY bbox, not "do nothing"
 *  (see cameraInsets.ts's own header) — silently jumping the camera to the
 *  flow origin instead of the intended target, or (once the arrange's own
 *  whole-canvas post-layout fit has already run first, see
 *  camera-after-arrange race below) reading as "nothing happened" because
 *  that whole-canvas fit was already what the user saw. Small (each retry
 *  only costs one frame) and only engages when the instance actually
 *  supports `getNode` (real React Flow) — see `nodeIsReady` below. */
const FOCUS_TARGET_RETRY_FRAMES = 6;

/** Runs `cb` on the next animation frame, falling back to a ~16ms timer
 *  where `requestAnimationFrame` doesn't exist (jsdom — every test that
 *  renders this hook, see useCanvasManagerEvents.test.tsx's arrange-then-
 *  focus race case below). Same helper/shape as
 *  useCanvasFlowGraph.ts's own `scheduleFrame` (private to each file —
 *  neither hooks/* module imports from a sibling, same convention every
 *  other hook in this directory already follows). */
function scheduleFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(cb);
  } else {
    setTimeout(cb, 16);
  }
}

/** fix/canvas-manager-camera — `true` when `id` currently resolves to a
 *  real node on `instance`, i.e. it is SAFE to fitView on. Every unit test
 *  in this file mocks `reactFlowInstanceRef.current` down to just
 *  `{ fitView }` (no `getNode`) — rather than require every call site to
 *  extend that mock, an instance that doesn't expose `getNode` is treated
 *  as "can't check, so don't block on it" (the same honest degrade
 *  cameraInsets.ts's own `measureDockedPanelInsets` uses for a missing
 *  DOM element: never worse than the pre-fix behavior). */
function nodeIsReady(
  instance: Pick<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge>, 'getNode'> | null | undefined,
  id: string,
): boolean {
  if (!instance || typeof instance.getNode !== 'function') return true;
  return instance.getNode(id) !== undefined;
}

export interface UseCanvasManagerEventsParams {
  reactFlowInstanceRef: React.RefObject<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> | null>;
  runLayoutAll: (scope?: string) => Promise<void>;
  setLaneMode: (enabled: boolean) => void;
  /** P47 — CanvasView's own outer container ref, read at focus-time via
   *  `measureDockedPanelInsets` so 'canvas:focus' insets its `fitView` by
   *  the docked ManagerOverlay/CockpitLeftRail exactly like every
   *  user-triggered camera move (CanvasView.tsx's own `handleFocusNode`/
   *  `handleZoomToSelection`/etc.). Optional + defaults to "no insets"
   *  (`measureDockedPanelInsets(null)`) so every pre-existing caller/test
   *  that doesn't pass it keeps its exact prior behavior. */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** W8d Replay — 'canvas:arrange' is a real layout MUTATION (auto-layout/
   *  lane-mode toggle); it's dropped while replay is active so the manager
   *  loop can't silently rearrange the live canvas underneath a historical
   *  scrub. 'canvas:focus'/'canvas:highlight' stay live (view-only pan +
   *  pulse). Defaults to `false` (every pre-existing caller keeps its
   *  current behavior). */
  replayActive?: boolean;
}

export interface UseCanvasManagerEventsResult {
  /** Refs currently pulsing from a manager-initiated action — union this
   *  into CanvasView's own `highlightIds` prop before it reaches
   *  useCanvasFlowGraph (see CanvasView.tsx). */
  managerHighlightIds: ReadonlySet<string>;
}

export function useCanvasManagerEvents({ replayActive = false, ...params }: UseCanvasManagerEventsParams): UseCanvasManagerEventsResult {
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  });

  const [managerHighlightIds, setManagerHighlightIds] = useState<ReadonlySet<string>>(new Set());
  const clearTimeoutsRef = useRef<Set<number>>(new Set());
  const replayActiveRef = useRef(replayActive);
  useEffect(() => {
    replayActiveRef.current = replayActive;
  }, [replayActive]);

  const pulse = useCallback((refs: readonly string[], durationMs: number) => {
    if (refs.length === 0) return;
    setManagerHighlightIds((prev) => new Set([...prev, ...refs]));
    const timeoutId = window.setTimeout(() => {
      clearTimeoutsRef.current.delete(timeoutId);
      setManagerHighlightIds((prev) => {
        const next = new Set(prev);
        for (const ref of refs) next.delete(ref);
        return next;
      });
    }, durationMs);
    clearTimeoutsRef.current.add(timeoutId);
  }, []);

  useEffect(() => {
    const timeouts = clearTimeoutsRef.current;
    return () => {
      for (const id of timeouts) window.clearTimeout(id);
      timeouts.clear();
    };
  }, []);

  // fix/canvas-ux R9 BLOQUANT #1a — camera-after-arrange race: the manager
  // emits 'canvas:arrange' then 'canvas:focus' back-to-back in the SAME
  // reply (agentsStore.tsx's action loop `await`s each executor call, but
  // neither arrange_canvas's nor focus_canvas's own case body has an
  // await — see that file's switch — so the two bus events fire on
  // consecutive ticks of the SAME synchronous loop). `runLayoutAll`
  // (useCanvasLayout.ts) IS genuinely async (elkjs computation via
  // `await layoutAll/layoutZone`) and only calls `setPositions` once that
  // resolves; a fire-and-forget `void runLayoutAll(...)` here meant
  // 'canvas:focus' — arriving before that promise settles — called
  // `fitView` against whatever positions React Flow's internal node
  // lookup still held from BEFORE the layout, i.e. the STALE pre-arrange
  // coordinates (the camera "centers" on where the node used to be, which
  // reads as an empty viewport once the node has actually moved). Tracked
  // here as `pendingArrangeRef` so 'canvas:focus' can await the outstanding
  // layout before fitting — and, since `runLayoutAll`'s own promise only
  // guarantees `canvasStore.setPositions` was CALLED, not that React has
  // re-rendered CanvasView / that RF's controlled `nodes` prop has flowed
  // into RF's internal store yet, one `scheduleFrame` (RF's per-node
  // dimension effect, `useCanvasFlowGraph.ts`'s OWN identical
  // "wait a frame for RF to catch up" precedent) after the promise
  // resolves before calling `fitView`. When focus arrives with NO pending
  // arrange (the common case — most focus_canvas calls aren't preceded by
  // one), it still fits immediately against the CURRENT position, exactly
  // as before.
  const pendingArrangeRef = useRef<Promise<void> | null>(null);

  // fix/canvas-manager-camera — the most recent 'canvas:highlight' batch,
  // read by 'canvas:focus' to detect "this focus is part of the SAME
  // multi-node creation turn" (see ENSEMBLE_WINDOW_MS's own doc comment).
  const lastHighlightRef = useRef<{ refs: readonly string[]; at: number } | null>(null);

  useEffect(() => {
    const offArrange = on('canvas:arrange', ({ scope, mode }) => {
      if (replayActiveRef.current) return; // W8d — layout mutation, gated during replay
      const { runLayoutAll, setLaneMode } = paramsRef.current;
      if (mode === 'lanes') {
        setLaneMode(true);
        pendingArrangeRef.current = null;
      } else if (mode === 'free') {
        setLaneMode(false);
        pendingArrangeRef.current = null;
      } else {
        pendingArrangeRef.current = runLayoutAll(scope);
      }
    });

    const offFocus = on('canvas:focus', ({ ref, minZoom }) => {
      // fix/canvas-manager-camera — "land on the ENSEMBLE of nodes created
      // this turn", not just the single ref: when a 'canvas:highlight' batch
      // JUST arrived (same synchronous reply), names MORE than one ref, and
      // includes this exact ref, fit on that whole batch instead.
      const recentHighlight = lastHighlightRef.current;
      const targetRefs: readonly string[] =
        recentHighlight &&
        Date.now() - recentHighlight.at <= ENSEMBLE_WINDOW_MS &&
        recentHighlight.refs.length > 1 &&
        recentHighlight.refs.includes(ref)
          ? recentHighlight.refs
          : [ref];

      const doFocus = (retriesLeft: number) => {
        const instance = paramsRef.current.reactFlowInstanceRef.current;
        // fix/canvas-manager-camera — "cible introuvable parce que la ref
        // pointe sur un noeud pas encore reconcilie": a freshly-created
        // draft/router/join can still be missing from React Flow's own
        // internal node lookup for a few frames after canvasStore's write
        // (see nodeIsReady's own doc comment) — fitView-ing against zero
        // matching nodes resolves an EMPTY bbox (cameraInsets.ts's header),
        // not "wait" or "no-op", so this retries a bounded number of frames
        // instead of ever firing on a target we can positively tell isn't
        // there yet.
        if (retriesLeft > 0 && !targetRefs.some((id) => nodeIsReady(instance, id))) {
          scheduleFrame(() => doFocus(retriesLeft - 1));
          return;
        }
        const readyRefs = targetRefs.filter((id) => nodeIsReady(instance, id));
        // Retries exhausted with NONE ready — forward the original refs
        // anyway (honest "we tried"; matches fitView's own pre-existing
        // behavior for an unresolvable ref, never a NEW failure mode).
        const fitRefs = readyRefs.length > 0 ? readyRefs : targetRefs;
        // P47 — panel-aware: without this, the manager's own focus_canvas
        // action lands a node under the docked ManagerOverlay exactly like
        // the bug report's manual "click a zone dot" repro.
        const insets = measureDockedPanelInsets(paramsRef.current.containerRef?.current ?? null);
        instance?.fitView({
          nodes: fitRefs.map((id) => ({ id })),
          duration: FOCUS_FIT_DURATION_MS,
          maxZoom: 1.1,
          // fix/canvas-manager-camera — floored to a genuinely READABLE
          // zoom by default (spec ask: "typiquement >= 60-80%, pas un fit
          // global"), never the un-floored bbox zoom that let a degenerate
          // (empty/near-empty) bbox resolve all the way down to React
          // Flow's own 0.1 technical floor. An explicit caller-provided
          // `minZoom` (e.g. start_preview's PREVIEW_FOCUS_MIN_ZOOM) still
          // wins outright.
          minZoom: minZoom ?? FOCUS_MIN_READABLE_ZOOM,
          // fix/canvas-toolbar-fit-floor — same floor as every other fit
          // call site (CanvasToolbar.tsx's "Fit view", CanvasView.tsx's
          // getPanelAwarePadding): the manager's own focus_canvas/arrange
          // fit must not land a node under the toolbar either.
          padding: insetFitViewPadding(insets, FOCUS_FIT_VERTICAL_PADDING, DEFAULT_HORIZONTAL_GUTTER_PX, CANVAS_FIT_TOP_RESERVE_PX),
        });
        pulse(fitRefs, FOCUS_PULSE_MS);
      };
      const runDoFocus = () => doFocus(FOCUS_TARGET_RETRY_FRAMES);
      const pendingArrange = pendingArrangeRef.current;
      if (pendingArrange) {
        // Consumed once — a LATER arrange (this reply's or a future one)
        // gets its own fresh wait rather than this same stale promise.
        pendingArrangeRef.current = null;
        void pendingArrange.finally(() => scheduleFrame(() => scheduleFrame(runDoFocus)));
      } else {
        // W-CAMERA — deferred one frame even with no pending arrange (same
        // rationale as useCanvasLayout.ts's post-arrange `fitViewAfterLayout`
        // call): reconcile's node-identity fix means an unchanged node keeps
        // its RF-internal `measured`/`handleBounds`, but a focus arriving in
        // the SAME tick as a just-applied reconcile/setNodes can still race
        // React Flow's own node-dimension effect before this call.
        scheduleFrame(runDoFocus);
      }
    });

    const offHighlight = on('canvas:highlight', ({ refs }) => {
      lastHighlightRef.current = { refs, at: Date.now() };
      pulse(refs, HIGHLIGHT_PULSE_MS);
    });

    // Collab — 'canvas:followViewport' jumps the camera to a teammate's
    // last reported pan/zoom (PresenceOverlay chip click with no focused
    // node). setCenter is the React Flow primitive for an absolute camera
    // move; we honour the teammate's zoom if provided, else keep current.
    const offFollowViewport = on('canvas:followViewport', ({ x, y, zoom }) => {
      const instance = paramsRef.current.reactFlowInstanceRef.current;
      if (!instance || typeof instance.setCenter !== 'function') return;
      const currentZoom = instance.getViewport?.()?.zoom ?? 1;
      instance.setCenter(x, y, { duration: FOCUS_FIT_DURATION_MS, zoom: zoom ?? currentZoom });
    });

    // J: Live run visualization — pulse nodes when graph execution starts/finishes.
    // graph.node_started highlights the node with a running pulse; graph.node_finished
    // flashes green (done) or red (failed). The nodeId maps to a canvas ref via
    // the orchestrator's step id, which irToCanvas uses as the draft id.
    type GraphNodePayload = { nodeId?: string; attempt?: number; status?: string };
    const offNodeStarted = on(
      'graph.node_started' as unknown as Parameters<typeof on>[0],
      ((payload: GraphNodePayload) => {
        if (payload?.nodeId) {
          pulse([`draft:${payload.nodeId}`], HIGHLIGHT_PULSE_MS);
        }
      }) as unknown as Parameters<typeof on>[1],
    );
    const offNodeFinished = on(
      'graph.node_finished' as unknown as Parameters<typeof on>[0],
      ((payload: GraphNodePayload) => {
        if (payload?.nodeId) {
          pulse([`draft:${payload.nodeId}`], HIGHLIGHT_PULSE_MS);
        }
      }) as unknown as Parameters<typeof on>[1],
    );

    return () => {
      offArrange();
      offFocus();
      offHighlight();
      offFollowViewport();
      offNodeStarted();
      offNodeFinished();
    };
  }, [pulse]);

  return { managerHighlightIds };
}
