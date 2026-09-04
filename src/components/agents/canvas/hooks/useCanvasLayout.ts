/* useCanvasLayout.ts — auto-layout / lane-mode application glue for the
   Agent Canvas (W2b, spec §4.3 "Lane mode", §5 "Auto-layout"). Wraps the
   PURE `layout.ts` functions (elkjs) with the two things they deliberately
   don't own: applying the result to `canvasStore` (`setPositions`) and a
   one-shot CSS transition so the snap-into-place reads as an animation
   instead of a hard cut (spec's task text: "a one-shot CSS transition on
   node transforms" via a temporary `canvas-animating` class — see
   `canvas-layout.css`, imported once by CanvasView.tsx).

   fix/canvas-manager-camera (round 3 QA, P0-1: "zoom reste bloque a 11%
   apres arrange_canvas") — `fitViewAfterLayout` used to take no argument at
   all, so a SCOPED `arrange_canvas` (one project's zone re-laid-out via
   `layoutZone`) still triggered a blind WHOLE-CANVAS fit afterward: with
   several open projects, that fit-everything view is exactly the "cartes
   minuscules a l'extreme droite" symptom, even though only one zone
   actually changed. `runLayoutAll` now forwards its own `scope` straight
   through to `fitViewAfterLayout(scope)` so the caller (CanvasView.tsx) can
   fit the SCOPED zone specifically — spec ask: "si le contenu ne rentre
   pas, prefere cadrer sur la zone active plutot que sur tout le monde".

   Lane mode (spec §4.3) is a toggle on the EXISTING `prefs.laneMode` pref
   (canvasStore.ts already has the field + `setPrefs` action — no store
   change needed here). Approach, spelled out because it's easy to get
   wrong:
     - ON: snapshot the CURRENT `positions` record into a local ref (NOT
       canvasStore, NOT persisted — a plain in-memory "undo point" for this
       toggle) BEFORE lane positions overwrite them, then flip
       `prefs.laneMode` true. A separate effect (watching the SET of
       non-project node ids, not the full node list — see
       `nodeIdSignature` below) applies `laneLayout` to every zone whenever
       that set changes WHILE laneMode is on, satisfying "recompute on new
       missions arriving while ON" without an infinite loop (see that
       effect's own comment for why the dependency is a signature string,
       not `nodes` itself).
     - OFF: restore the snapshot (if one exists — see the KNOWN GAP below),
       flip `prefs.laneMode` false.
   BOOT GAP — FIXED (W5b, deliverable #4; was the KNOWN GAP documented
   here through W2b): if the canvas MOUNTS with `prefs.laneMode` already
   `true` (restored from a previous session's persisted prefs — see
   canvasStore.ts's `hydrate()`), there is no in-memory snapshot from THIS
   session's own `setLaneMode(true)` call, because lane mode arrived
   already-on from `hydrate()`'s atomic `set()`, never through
   `setLaneMode`. Fix: the very first time the lane-recompute effect below
   observes `laneMode === true` with no snapshot taken yet
   (`freeSnapshotRef.current === null`), it snapshots the CURRENT
   `positions` BEFORE calling `applyLaneLayoutToAllZones()` — those
   positions are the last FREE layout by construction, because lane
   coordinates are never written until that same call runs. This covers
   both paths with one check: a user-driven `setLaneMode(true)` already
   populates `freeSnapshotRef.current` synchronously (see below) before
   this effect's dependency even changes, so the effect's own snapshot
   attempt is always a no-op in that case — only the "arrived ON from
   hydrate" path ever hits it for real.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasStore } from '../canvasStore';
import { layoutAll, layoutZone, laneLayout } from '../layout';
import { packAllZones, type ZonePackEntry } from '../reconcilerZones';
import type { NodeRef } from '../canvasTypes';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../reconciler';

/** Matches canvas-layout.css's `.canvas-animating .react-flow__node`
 *  transition duration (300ms) plus a small buffer so the class never
 *  drops mid-transition on a slow frame. */
const LAYOUT_TRANSITION_MS = 340;

export interface UseCanvasLayoutParams {
  nodes: CanvasReactFlowNode[];
  edges: CanvasReactFlowEdge[];
  /**
   * R13 — « breathing room » fix: called once right after a successful
   * `runLayoutAll` applies its position patch, so every caller (toolbar
   * button, Ctrl+L, CanvasPalette, CanvasContextMenu's pane "Tout ranger")
   * gets the SAME post-arrange fit-to-view for free instead of each needing
   * its own follow-up call. Before this fix, auto-layout tiled every card
   * edge-to-edge with NO subsequent fit — whatever padding the viewport
   * happened to already have (often none) was all that was left, so a
   * freshly-arranged canvas routinely had no empty pane left to right-click
   * on. Optional so a unit test (or a future headless caller) can omit it.
   *
   * fix/canvas-manager-camera — receives `runLayoutAll`'s own `scope` (the
   * project id a scoped `layoutZone` pass just targeted, `undefined` for a
   * whole-canvas `layoutAll`) so the caller can fit that ONE zone instead
   * of always fitting everything — see this file's own header.
   *
   * fix/canvas-manager-camera-race — may return a `Promise` (CanvasView.tsx's
   * real implementation now returns the underlying `instance.fitView()`
   * promise): `runLayoutAll` AWAITS it (see that callback's own doc
   * comment) so its own returned promise only resolves once the
   * post-arrange camera move has genuinely been applied by React Flow, not
   * merely scheduled. A caller that returns `void` (e.g. a test double)
   * still works unchanged — `Promise.resolve(void)` resolves immediately. */
  fitViewAfterLayout?: (scope?: string) => void | Promise<void>;
}

export interface UseCanvasLayoutResult {
  /** Add `canvas-animating` to the React Flow wrapper while true (spec's
   *  task text: "one-shot CSS transition on node transforms"). */
  isAnimating: boolean;
  /**
   * « Ranger » toolbar button / Ctrl+L (spec §5 "Auto-layout"). Optional
   * `scope` (a project id) narrows the elkjs pass to that ONE zone
   * (`layoutZone`) instead of the whole canvas (`layoutAll`) — added for
   * Agent Canvas W4's `arrange_canvas` manager action (spec §8.1), whose
   * `scope` field targets a single project; every pre-existing caller
   * (the toolbar button, Ctrl+L, CanvasContextMenu's pane menu) omits it
   * and keeps the original whole-canvas behavior unchanged.
   */
  runLayoutAll: (scope?: string) => Promise<void>;
  /**
   * scratch/_canvas-label-design.md §3.3 item 5 — « Ranger » toolbar button
   * (CanvasToolbar.tsx's `onTidyZones`). Re-packs every ZONE box (pinned
   * included) via `reconcilerZones.ts`'s `packAllZones` — deliberately
   * lighter than {@link runLayoutAll}'s "Auto-layout": no elkjs, no child
   * repositioning (zone children are zone-relative, so a zone's own move
   * carries them along for free), so it never disturbs a manually-arranged
   * mission layout inside a zone. Synchronous (no `await`) for the same
   * reason. A no-op when there are no zones to pack.
   */
  tidyZones: () => void;
  laneMode: boolean;
  toggleLaneMode: () => void;
  /**
   * Explicit set (not toggle) — Agent Canvas W4's `arrange_canvas` action
   * needs "turn lane mode ON/OFF" semantics (the manager states the target
   * mode, e.g. "lanes"), not "flip whatever it currently is". Shares the
   * exact same snapshot save/restore behavior `toggleLaneMode` uses (see
   * this hook's own module header) — `toggleLaneMode` is now a thin
   * `setLaneMode(!laneMode)` wrapper, kept for every pre-existing caller
   * (CanvasToolbar's lane-mode button).
   */
  setLaneMode: (enabled: boolean) => void;
}

export function useCanvasLayout({ nodes, edges, fitViewAfterLayout }: UseCanvasLayoutParams): UseCanvasLayoutResult {
  const positions = useCanvasStore((s) => s.positions);
  const setPositions = useCanvasStore((s) => s.setPositions);
  const laneMode = useCanvasStore((s) => s.prefs.laneMode);
  const setPrefs = useCanvasStore((s) => s.setPrefs);

  const [isAnimating, setIsAnimating] = useState(false);
  const animTimeoutRef = useRef<number | null>(null);
  const freeSnapshotRef = useRef<Record<NodeRef, { x: number; y: number }> | null>(null);

  useEffect(
    () => () => {
      if (animTimeoutRef.current !== null) window.clearTimeout(animTimeoutRef.current);
    },
    [],
  );

  const playTransition = useCallback(() => {
    setIsAnimating(true);
    if (animTimeoutRef.current !== null) window.clearTimeout(animTimeoutRef.current);
    animTimeoutRef.current = window.setTimeout(() => setIsAnimating(false), LAYOUT_TRANSITION_MS);
  }, []);

  const runLayoutAll = useCallback(
    async (scope?: string) => {
      const patch = scope ? await layoutZone(nodes, edges, scope) : await layoutAll(nodes, edges);
      if (Object.keys(patch).length === 0) return;
      playTransition();
      setPositions(patch);
      // R13 — post-arrange fit (this hook's doc comment): every caller gets
      // this for free. Deferred one tick (rAF) so it fits the just-applied
      // positions rather than racing the setPositions state update.
      // fix/canvas-manager-camera — forwards `scope` so a SCOPED arrange
      // fits just that zone (see this file's own header).
      //
      // fix/canvas-manager-camera-race (round 4, real-app repro: manager
      // turn emits 'canvas:arrange' then 'canvas:highlight'/'canvas:focus'
      // back-to-back — see useCanvasManagerEvents.ts's `pendingArrangeRef`
      // doc comment) — AWAITED, not fire-and-forget. React Flow's own
      // imperative `fitView()` never applies synchronously: it QUEUES
      // `fitViewOptions`/`fitViewResolver` on the ReactFlowInstance's
      // internal store and only actually flushes them on the NEXT
      // setNodes/updateNodeInternals pass (`@xyflow/react`'s own
      // `resolveFitView`), reusing a single shared resolver if one is
      // already pending. This function used to resolve the instant
      // `setPositions` was called — WELL BEFORE the deferred whole-canvas
      // `fitViewAfterLayout` call below had even fired, let alone been
      // flushed — so `useCanvasManagerEvents.ts`'s 'canvas:focus' handler
      // (which awaits `pendingArrangeRef.current`, i.e. THIS function's
      // promise, before firing its own scoped fitView) could queue its own
      // fitView options onto the SAME still-pending, not-yet-flushed
      // arrange request; whichever options were in React Flow's queue at
      // actual-flush time won. Confirmed live: a manager turn that creates
      // several drafts, chains them, then calls `arrange_canvas` — the
      // camera lands on the WHOLE canvas instead of the focused node(s),
      // even though the focus's own `fitView({minZoom: 0.6, ...})` call
      // genuinely ran and resolved. Awaiting `fitViewAfterLayout`'s own
      // returned promise (CanvasView.tsx now returns the real
      // `instance.fitView()` promise) means this function — and therefore
      // `pendingArrangeRef` — only resolves once the arrange's own camera
      // move has ACTUALLY been applied, so a following 'canvas:focus'
      // always gets a clean, uncontended fitView queue slot. Never rejects
      // (resolves either way) so a fitView failure can't hang `runLayoutAll`.
      if (fitViewAfterLayout) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            Promise.resolve(fitViewAfterLayout(scope)).then(() => resolve(), () => resolve());
          });
        });
      }
    },
    [nodes, edges, setPositions, playTransition, fitViewAfterLayout],
  );

  /**
   * scratch/_canvas-label-design.md §3.3 item 5 — « Ranger ». Builds the
   * minimal `ZonePackEntry[]` `packAllZones` needs directly from the live
   * top-level 'project' nodes (their `width`/`height` are always the real,
   * just-reconciled zone size — same source of truth `runLayoutAll`'s own
   * `layoutAll` reads via `nodeSize` in layout.ts), then writes the whole
   * patch through the SAME `setPositions` + `playTransition` + (optional)
   * post-arrange fit every other layout action here already uses — Ctrl+Z
   * undoes it exactly like any other `setPositions` call (zundo tracks
   * `positions`, canvasStore.ts's `partializeCanvasState`).
   */
  const tidyZones = useCallback(() => {
    const zoneEntries: ZonePackEntry[] = nodes
      .filter((node) => node.type === 'project')
      .map((node) => ({
        projectRef: node.id,
        name: (node.data as { name: string }).name,
        size: { width: node.width ?? 0, height: node.height ?? 0 },
      }));
    if (zoneEntries.length === 0) return;
    const packed = packAllZones(zoneEntries);
    const patch: Record<NodeRef, { x: number; y: number }> = {};
    for (const [ref, position] of packed) patch[ref] = position;
    if (Object.keys(patch).length === 0) return;
    playTransition();
    setPositions(patch);
    if (fitViewAfterLayout) void Promise.resolve(fitViewAfterLayout());
  }, [nodes, setPositions, playTransition, fitViewAfterLayout]);

  const applyLaneLayoutToAllZones = useCallback(async () => {
    const zoneIds = nodes
      .filter((n) => n.type === 'project')
      .map((n) => (n.data as { projectId: string }).projectId);
    const patch: Record<NodeRef, { x: number; y: number }> = {};
    for (const zoneId of zoneIds) {
      Object.assign(patch, await laneLayout(nodes, zoneId));
    }
    if (Object.keys(patch).length === 0) return;
    playTransition();
    setPositions(patch);
  }, [nodes, setPositions, playTransition]);

  // A signature of WHICH non-zone nodes exist (not their positions) — the
  // lane-recompute effect below depends on THIS, not on `nodes` itself.
  // `nodes` changes identity every time a position changes too (drag,
  // auto-layout, lane-layout's own setPositions call), so depending on
  // `nodes` directly would re-trigger this effect every time IT just wrote
  // new positions — an infinite loop. The signature only changes when a
  // node is actually added/removed, which is the real "new mission
  // arriving" signal the task asks for.
  const nodeIdSignature = useMemo(
    () =>
      nodes
        .filter((n) => n.type !== 'project')
        .map((n) => n.id)
        .sort()
        .join('|'),
    [nodes],
  );

  useEffect(() => {
    if (!laneMode) return;
    // Boot-gap fix (see module header): the first time this effect ever
    // runs with laneMode true and no snapshot exists yet, `positions` is
    // still the free layout (either just-hydrated from a persisted
    // session, or the pre-lane-mode positions from earlier in this same
    // session) — capture it now, before applyLaneLayoutToAllZones below
    // overwrites it with lane coordinates. A user-driven
    // `setLaneMode(true)` already set `freeSnapshotRef.current`
    // synchronously before laneMode flips, so this is a no-op then.
    if (freeSnapshotRef.current === null) {
      freeSnapshotRef.current = { ...positions };
    }
    void applyLaneLayoutToAllZones();
    // applyLaneLayoutToAllZones/positions intentionally excluded:
    // applyLaneLayoutToAllZones closes over the live `nodes`/
    // `setPositions` and is recreated whenever `nodes` changes, which
    // would defeat the signature-based guard above; `positions` is only
    // read for the one-shot snapshot capture, never as a recompute
    // trigger (this effect must NOT re-run just because a drag or a prior
    // lane-layout pass changed positions).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdSignature, laneMode]);

  const setLaneMode = useCallback(
    (enabled: boolean) => {
      if (enabled === laneMode) return; // already in the requested mode — no-op, no history noise
      if (enabled) {
        freeSnapshotRef.current = { ...positions };
        setPrefs({ laneMode: true });
      } else {
        if (freeSnapshotRef.current) {
          setPositions(freeSnapshotRef.current);
          freeSnapshotRef.current = null;
        }
        setPrefs({ laneMode: false });
      }
    },
    [laneMode, positions, setPositions, setPrefs],
  );

  const toggleLaneMode = useCallback(() => setLaneMode(!laneMode), [laneMode, setLaneMode]);

  return { isAnimating, runLayoutAll, tidyZones, laneMode, toggleLaneMode, setLaneMode };
}
