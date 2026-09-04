/* useZoomLevel.ts — shared semantic-zoom bucket hook (spec §4.5, W2b).

   Extracted from MissionNode.tsx (W1b originally inlined this as a private
   `useCanvasZoomLevel`) so every node kind — Mission, Loop, Schedule, Draft,
   Note — buckets the live React Flow viewport zoom into the SAME three
   levels via the SAME `useStore` selector, instead of each node file
   re-deriving its own copy (W2b task: "Factor the zoom-level derivation
   into chrome ... so all nodes share it").

   `bucketZoom` stays a plain exported function (no React) so it's directly
   unit-testable at the threshold boundaries without mounting a component or
   a live ReactFlowProvider — see src/__tests__/canvasZoomLevel.test.ts.
*/

import { useCallback } from 'react';
import { useStore } from '@xyflow/react';
import { ZOOM_AGGREGATE, ZOOM_CHIP, ZOOM_COMPACT } from '../canvasTypes';
import { HEADER_CLAMP_ZOOM, HEADER_MINIMAL_ZOOM } from './lod';

// fix/canvas-legibility — 'dot' renamed to 'chip': this is not merely
// cosmetic, it's the semantic replacement of bare anonymous status dots
// with readable billboard chips (status glyph + type glyph + truncated
// title, MissionNode.tsx's chip tier) — the product's own framing: "today
// when you zoom out you see nothing but dots".
export type CanvasZoomLevel = 'chip' | 'compact' | 'full';

/** Pure zoom -> bucket mapping (spec §4.5 thresholds): `< ZOOM_CHIP` ->
 *  chip, `< ZOOM_COMPACT` -> compact, else full. */
export function bucketZoom(zoom: number): CanvasZoomLevel {
  if (zoom < ZOOM_CHIP) return 'chip';
  if (zoom < ZOOM_COMPACT) return 'compact';
  return 'full';
}

/** Reads the live viewport zoom and returns only the DISCRETE bucket, via
 *  useStore's default `Object.is` equality on the returned string — a node
 *  only re-renders when it crosses a threshold, not on every zoom tick
 *  (perf note from spec §5 "memoized custom nodes"). Must be called from a
 *  component rendered inside `<ReactFlow>` (uses the internal RF store). */
export function useZoomLevel(): CanvasZoomLevel {
  return useStore(useCallback((s) => bucketZoom(s.transform[2]), []));
}

/**
 * W-UX3 three-tier fleet view — `true` below {@link ZOOM_AGGREGATE}
 * (extreme dezoom): project zones swap their normal header/children for a
 * constant-screen-size summary chip (ProjectGroupNode.tsx), while the
 * individual dots hide via CSS (chrome/canvas.css's
 * `[data-canvas-tier='aggregate']` rule — no per-node re-render). Same
 * `Object.is`-on-boolean subscription discipline as {@link useZoomLevel}:
 * a consumer only re-renders when the threshold is CROSSED, and only the
 * handful of zone nodes consume this at all.
 */
export function useIsAggregateZoom(): boolean {
  return useStore(useCallback((s) => s.transform[2] < ZOOM_AGGREGATE, []));
}

/* ── fix/canvas-header-overflow — project/frame HEADER semantic zoom ─────
   A separate bucket from {@link CanvasZoomLevel} above: that one decides
   what a MISSION/LOOP/etc. child card renders as; this one decides how
   much chrome a ZONE/FRAME's own HEADER can afford to carry once it (and
   the frame around it) has shrunk far enough on screen — see chrome/lod.ts's
   own module header for the full "why" (the geometric `max-width` clamp
   alone stops a header from ever overflowing its frame; these DOM-level
   reductions are the legibility follow-through a pure CSS transform can't
   express). */
export type HeaderZoomTier = 'full' | 'reduced' | 'minimal';

/** Pure zoom -> header-tier mapping: `< HEADER_MINIMAL_ZOOM` -> minimal
 *  (title only, no row chrome), `< HEADER_CLAMP_ZOOM` -> reduced (identity
 *  cluster only, secondary badges dropped), else full. */
export function bucketHeaderZoom(zoom: number): HeaderZoomTier {
  if (zoom < HEADER_MINIMAL_ZOOM) return 'minimal';
  if (zoom < HEADER_CLAMP_ZOOM) return 'reduced';
  return 'full';
}

/** Same `Object.is`-on-string subscription discipline as {@link useZoomLevel}
 *  — a zone/frame header only re-renders when a HEADER_CLAMP_ZOOM/
 *  HEADER_MINIMAL_ZOOM threshold is actually crossed, never on every zoom
 *  tick. */
export function useHeaderZoomTier(): HeaderZoomTier {
  return useStore(useCallback((s) => bucketHeaderZoom(s.transform[2]), []));
}
