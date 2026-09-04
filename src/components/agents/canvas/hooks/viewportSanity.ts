/* viewportSanity.ts — W-UX3 finding B: boot viewport sanity guard.

   A persisted canvas viewport (`canvas/layout.json`'s `viewport` field) can
   be corrupted by an abnormal prior session — an e2e/harness run that
   saved mid-zoom (David's own repro: "my e2e runs saved 188% etc."), or a
   panned-to-empty-space viewport left over after nodes moved/were
   deleted. Blindly restoring it on the NEXT real boot opens the canvas
   "ultra-zoomed" with nothing useful on screen — this module is the guard
   `useCanvasHydration.ts` runs before trusting a persisted viewport at all.

   Two independent checks; either one rejects the persisted viewport (in
   favor of `fitView`, the existing "no persisted viewport" fallback):
     1. `zoom` outside [MIN_SANE_ZOOM, MAX_SANE_ZOOM] — catches the exact
        188% repro directly, no geometry needed.
     2. the persisted viewport would leave less than
        MIN_VISIBLE_CONTENT_FRACTION of the real node bounding box on
        screen — catches an IN-RANGE zoom that's panned onto empty space
        (e.g. a stale position after every node near it moved/was deleted).
   Deliberately conservative: anything uncertain (no positions to measure,
   zero-area content, non-finite numbers) skips check 2 rather than
   guessing — check 1 alone still stands.
*/

import { FULL_CARD_MAX_HEIGHT, FULL_CARD_WIDTH } from '../geometry';
import type { CanvasViewport } from '../canvasStore';

export const MIN_SANE_ZOOM = 0.15;
export const MAX_SANE_ZOOM = 1.5;
export const MIN_VISIBLE_CONTENT_FRACTION = 0.3;

export interface ScreenSize {
  width: number;
  height: number;
}

/**
 * `true` when `viewport` is safe to restore verbatim on boot. `positions`
 * is the persisted layout's raw node position map (top-left corners, flow
 * space) — used only for check 2's bounding box; an empty/absent map skips
 * that check (check 1 still applies).
 */
export function isViewportSane(
  viewport: CanvasViewport,
  positions: Record<string, { x: number; y: number }> | undefined,
  screen: ScreenSize,
): boolean {
  if (!Number.isFinite(viewport.zoom) || viewport.zoom < MIN_SANE_ZOOM || viewport.zoom > MAX_SANE_ZOOM) {
    return false;
  }

  const points = positions ? Object.values(positions) : [];
  if (points.length === 0 || screen.width <= 0 || screen.height <= 0) {
    // Nothing to measure content visibility against — check 1 already
    // passed, and guessing at check 2 would be worse than skipping it.
    return true;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    // Positions are top-left corners, not centers — pad by a full card's
    // own footprint (geometry.ts's single source of truth) so the bounding
    // box approximates real rendered extent, not just a cloud of points.
    maxX = Math.max(maxX, p.x + FULL_CARD_WIDTH);
    maxY = Math.max(maxY, p.y + FULL_CARD_MAX_HEIGHT);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return true;
  }

  const contentWidthPx = (maxX - minX) * viewport.zoom;
  const contentHeightPx = (maxY - minY) * viewport.zoom;
  if (contentWidthPx <= 0 || contentHeightPx <= 0) return true;

  // Content's top-left in SCREEN space, under the persisted viewport
  // transform (React Flow convention: screenX = flowX * zoom + viewport.x).
  const screenX0 = minX * viewport.zoom + viewport.x;
  const screenY0 = minY * viewport.zoom + viewport.y;
  const screenX1 = screenX0 + contentWidthPx;
  const screenY1 = screenY0 + contentHeightPx;

  const visibleWidth = Math.max(0, Math.min(screenX1, screen.width) - Math.max(screenX0, 0));
  const visibleHeight = Math.max(0, Math.min(screenY1, screen.height) - Math.max(screenY0, 0));
  const visibleArea = visibleWidth * visibleHeight;
  const contentArea = contentWidthPx * contentHeightPx;

  return visibleArea / contentArea >= MIN_VISIBLE_CONTENT_FRACTION;
}
