/* BrainGraph3D — Night Signal graph.

   is3D=true (default): WebGL vault (3d-force-graph + Three + bloom), lazy-
   loaded so the Canvas2D engine and jsdom tests never pull WebGL.

   is3D=false: hand-rolled Canvas2D engine. Manual 3D projection/rotation,
   ambient cortex field, bloom via radial gradients, pulses, orbit/zoom.
   Pure math lives in ./canvas/*.ts; this file is the React glue for that
   fallback plus the is3D switch.

   Accepts data as props (AdaptedBrainData) — works with real or mock data,
   same external contract as before (data / onSelectNode / focusedNodeId),
   plus palette / 3D-2D / time-travel / zoom from BrainControls.tsx.
*/

import { useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react';
import type { AdaptedBrainData, AdaptedNode } from '../../lib/brain/brainAdapter';
import type { PaletteId } from './canvas/palettes';
import { DEFAULT_PALETTE } from './canvas/palettes';
import { TIME_BUCKET_COUNT } from './canvas/dateBucketing';
import {
  AUTO_ROTATE_SPEED,
  buildCameraParams,
  clampZoom,
  hitTest,
  projectInto,
} from './canvas/projection';
import type { Point3, ProjectedPoint } from './canvas/projection';
import { buildAmbientField } from './canvas/ambientField';
import type { AmbientField } from './canvas/ambientField';
import { advancePulse } from './canvas/pulses';
import { buildScene, applyPalette } from './canvas/scene';
import type { Scene } from './canvas/types';
import {
  drawAmbientField,
  drawBackdrop,
  drawClusterLabels,
  drawLinks,
  drawNeurons,
  drawPulses,
} from './canvas/draw';
import { Spinner } from '../ui/Skeleton';

const BrainGraphWebGL = lazy(() =>
  import('./BrainGraphWebGL').then((m) => ({ default: m.BrainGraphWebGL })),
);

// ── Props ─────────────────────────────────────────────────────────

interface BrainGraph3DProps {
  data: AdaptedBrainData;
  onSelectNode: (node: AdaptedNode) => void;
  /** When set, programmatically focus this node id (from bus nav:focusBrainNode). */
  focusedNodeId?: string | null;
  /** Active color palette — see canvas/palettes.ts. Defaults to 'spectre'. */
  paletteId?: PaletteId;
  /** 3D orbit projection vs flattened 2D. Defaults to true. */
  is3D?: boolean;
  /** Time-travel bucket 0..7 — nodes with dateIdx > timeIdx render dimmed. Defaults to the max (show everything). */
  timeIdx?: number;
  /** Zoom factor, clamped to [0.45, 4]. Defaults to 1. */
  zoom?: number;
  /** Fires when the user zooms via the mouse wheel inside the canvas, so the parent can keep its own zoom state (and the +/- HUD buttons) in sync. */
  onZoomChange?: (zoom: number) => void;
}

// ── Tunables (ported from the handoff prototype) ────────────────────

const DEFAULT_TIME_IDX = TIME_BUCKET_COUNT - 1;
const FIRE_DECAY = 0.92;
/** Per-frame easing rate for RenderNode.reveal toward its 0/1 target — see canvas/types.ts. */
const REVEAL_LERP_SPEED = 0.14;
const NODE_RADIUS_BASE = 2.6;
const NODE_RADIUS_PER_IMPORTANCE = 0.8;
const HALO_RADIUS_FACTOR = 0.47;
const WHEEL_ZOOM_SENSITIVITY = 0.0012;
const DRAG_ROTATE_SENSITIVITY = 0.007;
const DRAG_TILT_CLAMP = 1.3;
const DRAG_THRESHOLD_PX = 4;
const FOCUS_ANIM_DURATION_MS = 700;

interface Size {
  width: number;
  height: number;
}

interface FocusAnimation {
  active: boolean;
  fromUserRY: number;
  toUserRY: number;
  startTime: number;
}

function easeInOutQuad(progress: number): number {
  return progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** requestIdleCallback with a setTimeout fallback (Safari has no requestIdleCallback). */
function scheduleWhenIdle(fn: () => void): void {
  const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(fn);
  } else {
    setTimeout(fn, 0);
  }
}

/**
 * Reads the OS "reduce motion" preference. Defensive against test/older
 * environments where matchMedia is unavailable (jsdom does not implement it
 * by default) or throws — both degrade to "motion is fine" (false), never
 * to a thrown error that would break the mount-once effect below.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Subscribes to live prefers-reduced-motion changes (a user can flip the OS
 * setting mid-session). Returns a cleanup function, or null when matchMedia
 * is unavailable/throws (older test environments) — callers should treat a
 * null return as "nothing to clean up" rather than an error.
 */
function watchReducedMotion(onChange: (matches: boolean) => void): (() => void) | null {
  try {
    if (typeof window.matchMedia !== 'function') return null;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = (e: MediaQueryListEvent) => onChange(e.matches);
    // Legacy Safari (<14) only supports addListener/removeListener.
    const legacy = query as unknown as {
      addListener?: (cb: (e: MediaQueryListEvent) => void) => void;
      removeListener?: (cb: (e: MediaQueryListEvent) => void) => void;
    };
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    }
    if (typeof legacy.addListener === 'function') {
      legacy.addListener(listener);
      return () => legacy.removeListener?.(listener);
    }
    return null;
  } catch {
    return null;
  }
}

/** Resizes the canvas's backing pixel buffer to match its CSS size * DPR — only when it actually changed, since resizing clears the context transform. */
function syncCanvasSize(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  size: Size,
  dpr: number,
): void {
  const targetW = Math.max(1, Math.round(size.width * dpr));
  const targetH = Math.max(1, Math.round(size.height * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

// ── Component ─────────────────────────────────────────────────────

function BrainGraphCanvas2D({
  data,
  onSelectNode,
  focusedNodeId,
  paletteId = DEFAULT_PALETTE,
  is3D = true,
  timeIdx = DEFAULT_TIME_IDX,
  zoom = 1,
  onZoomChange,
}: BrainGraph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Animation-only state (never triggers a re-render) ────────────
  const zoomRef = useRef(clampZoom(zoom));
  const rotYRef = useRef(0);
  const userRYRef = useRef(0);
  const userRXRef = useRef(0);
  const hoverIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const draggingRef = useRef(false);
  const dragMovedRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const focusAnimRef = useRef<FocusAnimation>({ active: false, fromUserRY: 0, toUserRY: 0, startTime: 0 });
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const ambientRef = useRef<AmbientField | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const activityRef = useRef({ tabVisible: typeof document === 'undefined' || !document.hidden, intersecting: true });
  // Time-travel reveal easing respects prefers-reduced-motion — see
  // REVEAL_LERP_SPEED usage in the render loop below. Re-read on mount and
  // kept fresh by a media-query change listener (a user can flip the OS
  // setting mid-session without reloading the app).
  const reducedMotionRef = useRef(prefersReducedMotion());

  // Reusable scratch objects for the render loop — never reallocated per frame.
  const scratchPointRef = useRef<Point3>({ x: 0, y: 0, z: 0 });
  const scratchProjectedRef = useRef<ProjectedPoint>({ sx: 0, sy: 0, z: 0, persp: 0, fade: 0 });

  // ── Latest-prop mirrors (read fresh every frame without re-wiring listeners) ──
  const onSelectRef = useRef(onSelectNode);
  const onZoomChangeRef = useRef(onZoomChange);
  const paletteIdRef = useRef(paletteId);
  const is3DRef = useRef(is3D);
  const timeIdxRef = useRef(timeIdx);
  useLayoutEffect(() => {
    onSelectRef.current = onSelectNode;
    onZoomChangeRef.current = onZoomChange;
    paletteIdRef.current = paletteId;
    is3DRef.current = is3D;
    timeIdxRef.current = timeIdx;
    zoomRef.current = clampZoom(zoom);
  });

  // ── Scene: rebuilt when the node/edge set changes, re-tinted (in place) on palette change ──
  // Seeded from the `paletteId` prop directly (not the ref above) so the
  // initial value never reads a ref during render.
  const sceneRef = useRef<Scene>(buildScene(data, paletteId));
  const nodeIdsKey = data.nodes.map((n) => n.id).join('|');
  const edgeCountKey = data.links.length;

  useEffect(() => {
    sceneRef.current = buildScene(data, paletteIdRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdsKey, edgeCountKey]);

  useEffect(() => {
    // Skipped on the very first render (the scene above was already built
    // with the current palette) — subsequent palette switches retint in
    // place without relaying out the graph.
    applyPalette(sceneRef.current, paletteId);
  }, [paletteId]);

  // ── Focus animation: rotate to face a node selected from outside the canvas (search / wiki links) ──
  useEffect(() => {
    if (!focusedNodeId) return;
    const node = sceneRef.current.nodeById.get(focusedNodeId);
    if (!node) return;
    selectedIdRef.current = focusedNodeId;
    node.fire = 1;

    // Approximate "face the camera" target: rotate so the node's own angle
    // around the Y axis ends up on the near side. Ignores the X tilt's
    // second-order effect on the exact facing angle — good enough for a
    // "look roughly here" flourish, not a precision requirement.
    const nodeAngle = Math.atan2(node.x, node.z);
    const targetRY = nodeAngle + Math.PI;
    const currentRY = rotYRef.current + userRYRef.current;
    const delta = wrapAngle(targetRY - currentRY);
    focusAnimRef.current = {
      active: true,
      fromUserRY: userRYRef.current,
      toUserRY: userRYRef.current + delta,
      startTime: performance.now(),
    };
  }, [focusedNodeId]);

  // ── Mount-once: event wiring, resize/visibility observers, render loop ──
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');

    canvas.style.cursor = 'grab';

    // Build the (potentially large) ambient field after first paint so the
    // small, interactive memory-neuron graph shows up instantly.
    scheduleWhenIdle(() => {
      ambientRef.current = buildAmbientField();
    });

    // Keep the reduced-motion preference live — see watchReducedMotion.
    const unwatchReducedMotion = watchReducedMotion((matches) => {
      reducedMotionRef.current = matches;
    });

    // ── Interactions (ported from the prototype's componentDidMount) ──

    const onPointerDown = (e: MouseEvent) => {
      draggingRef.current = true;
      dragMovedRef.current = false;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    };

    const onCanvasMouseMove = (e: MouseEvent) => {
      if (draggingRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      hoverIdRef.current = hitTest(sceneRef.current.nodes, mx, my);
      canvas.style.cursor = hoverIdRef.current != null ? 'pointer' : 'grab';
    };

    const onWindowMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) dragMovedRef.current = true;
      userRYRef.current += dx * DRAG_ROTATE_SENSITIVITY;
      userRXRef.current = Math.max(
        -DRAG_TILT_CLAMP,
        Math.min(DRAG_TILT_CLAMP, userRXRef.current + dy * DRAG_ROTATE_SENSITIVITY),
      );
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };

    const onWindowMouseUp = (e: MouseEvent) => {
      if (draggingRef.current && !dragMovedRef.current) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = hitTest(sceneRef.current.nodes, mx, my);
        if (hit != null) {
          const node = sceneRef.current.nodeById.get(hit);
          if (node) {
            selectedIdRef.current = hit;
            onSelectRef.current(node.source);
          }
        }
      }
      draggingRef.current = false;
      canvas.style.cursor = hoverIdRef.current != null ? 'pointer' : 'grab';
    };

    const onMouseLeave = () => {
      hoverIdRef.current = null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      const next = clampZoom(zoomRef.current * factor);
      zoomRef.current = next;
      onZoomChangeRef.current?.(next);
    };

    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);

    // ── Resize (explicit canvas pixel size — avoids the flex/aspect-ratio ballooning footgun) ──

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      sizeRef.current = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    resizeObserver.observe(container);

    // ── Pause the loop when hidden (background tab) or scrolled out of view ──

    function updateLoopActivity() {
      const shouldRun = activityRef.current.tabVisible && activityRef.current.intersecting;
      if (shouldRun) {
        if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(renderFrame);
      } else if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    }

    const onVisibilityChange = () => {
      activityRef.current.tabVisible = !document.hidden;
      updateLoopActivity();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    let intersectionObserver: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry) activityRef.current.intersecting = entry.isIntersecting;
        updateLoopActivity();
      });
      intersectionObserver.observe(container);
    }

    // ── Render loop ────────────────────────────────────────────────

    function renderFrame() {
      rafIdRef.current = requestAnimationFrame(renderFrame);
      if (!ctx) return;
      const size = sizeRef.current;
      if (size.width <= 0 || size.height <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      syncCanvasSize(canvas!, ctx, size, dpr);
      ctx.clearRect(0, 0, size.width, size.height);

      const t = performance.now() / 1000;
      const scene = sceneRef.current;

      // Focus-animation easing (rotate to face an externally-focused node).
      const anim = focusAnimRef.current;
      if (anim.active) {
        const progress = Math.min(1, (performance.now() - anim.startTime) / FOCUS_ANIM_DURATION_MS);
        userRYRef.current = anim.fromUserRY + (anim.toUserRY - anim.fromUserRY) * easeInOutQuad(progress);
        if (progress >= 1) anim.active = false;
      }

      // Gentle auto-rotate only when fully idle — matches the prototype's
      // "hover pauses rotation so clicks land reliably" behavior.
      const rotating =
        is3DRef.current &&
        !draggingRef.current &&
        !anim.active &&
        hoverIdRef.current == null &&
        selectedIdRef.current == null;
      if (rotating) rotYRef.current += AUTO_ROTATE_SPEED;

      const cam = buildCameraParams({
        width: size.width,
        height: size.height,
        rotY: rotYRef.current + userRYRef.current,
        userRX: userRXRef.current,
        zoom: zoomRef.current,
        is3D: is3DRef.current,
      });

      drawBackdrop(ctx, cam.centerX, cam.centerY, Math.min(size.width, size.height) * HALO_RADIUS_FACTOR, t, scene.motes);

      // Reset per-frame cluster label accumulators.
      for (const agg of scene.clusterAggregates.values()) {
        agg.sumX = 0;
        agg.count = 0;
        agg.topY = Infinity;
      }

      const timeIdx = timeIdxRef.current;
      const scratchProjected = scratchProjectedRef.current;
      for (const node of scene.nodes) {
        projectInto(node, cam, scratchProjected);
        node.sx = scratchProjected.sx;
        node.sy = scratchProjected.sy;
        node.z2 = scratchProjected.z;
        node.persp = scratchProjected.persp;
        node.fade = scratchProjected.fade;
        node.r = (NODE_RADIUS_BASE + node.importance * NODE_RADIUS_PER_IMPORTANCE) * node.persp;
        node.visible = node.dateIdx <= timeIdx;

        // Ease reveal toward its 0/1 target (see canvas/types.ts) instead of
        // snapping — the growth/fade transition is what makes scrubbing the
        // timeline read as the brain visibly growing rather than a hard
        // cut. Snap straight to the target under reduced motion.
        const revealTarget = node.visible ? 1 : 0;
        if (reducedMotionRef.current) {
          node.reveal = revealTarget;
        } else {
          node.reveal += (revealTarget - node.reveal) * REVEAL_LERP_SPEED;
          if (Math.abs(revealTarget - node.reveal) < 0.005) node.reveal = revealTarget;
        }

        if (node.visible) {
          const agg = scene.clusterAggregates.get(node.cluster);
          if (agg) {
            agg.sumX += node.sx;
            agg.count += 1;
            if (node.sy < agg.topY) agg.topY = node.sy;
          }
        }
      }

      // Far -> near draw order (in place — `order` holds the same node objects as `nodes`).
      scene.order.sort((a, b) => a.z2 - b.z2);

      const ambient = ambientRef.current;
      if (ambient) {
        drawAmbientField(ctx, ambient, cam, scratchPointRef.current, scratchProjected, zoomRef.current, t);
      }

      drawLinks(ctx, scene.edges, selectedIdRef.current);

      // Advance signal pulses; a wrap fires the target neuron's arrival shockwave.
      for (const pulse of scene.pulses) {
        const edge = scene.edges[pulse.edgeIndex];
        const arrived = advancePulse(pulse);
        if (arrived && edge && edge.b.visible) edge.b.fire = 1;
      }
      // Decay AFTER this frame's new arrivals — matches the prototype's own
      // ordering (a node that just fired shows fire=0.92, not 1.0, the very
      // same frame; keeps the decay curve identical to the handoff).
      for (const node of scene.nodes) {
        node.fire *= FIRE_DECAY;
      }

      drawPulses(ctx, scene.edges, scene.pulses);
      drawNeurons(ctx, scene.order, t, hoverIdRef.current, selectedIdRef.current);
      drawClusterLabels(ctx, scene.clusterAggregates);
    }

    rafIdRef.current = requestAnimationFrame(renderFrame);

    return () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.removeEventListener('mousedown', onPointerDown);
      canvas.removeEventListener('mousemove', onCanvasMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
      unwatchReducedMotion?.();
    };
    // Mount-once: all mutable inputs (data, palette, is3D, timeIdx, zoom,
    // callbacks) are read through refs kept fresh by the effects above, so
    // this effect has no reactive dependencies to list.
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minWidth: 0,
        position: 'relative',
        background: '#04040A',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}

function GraphFallback() {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#030308',
      }}
    >
      <Spinner size={22} color="#7C5CFF" />
    </div>
  );
}

export function BrainGraph3D(props: BrainGraph3DProps) {
  if (props.is3D === false) {
    return <BrainGraphCanvas2D {...props} />;
  }
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative', display: 'flex' }}>
      <Suspense fallback={<GraphFallback />}>
        <BrainGraphWebGL {...props} />
      </Suspense>
    </div>
  );
}
