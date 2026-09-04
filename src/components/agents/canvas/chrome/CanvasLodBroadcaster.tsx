/* CanvasLodBroadcaster.tsx — W-UX3 finding A companion (see lod.ts's header
   for the full rationale). Renders nothing: a single child of
   `<ReactFlow>` that taps the live viewport zoom (the SAME kind of
   subscription CanvasToolbar's own zoom% readout already pays for) and
   relays it to every dot/zone-label on the canvas via two CSS custom
   properties written directly onto the canvas container's DOM node —
   never through React state/props, so no node anywhere on the canvas
   re-renders because of this.
*/

import { useEffect, useRef, type RefObject } from 'react';
import { useViewport, useReactFlow } from '@xyflow/react';
import { notifyCanvasViewportMoving } from './canvasGesturePause';
import {
  DOT_LOD_TARGET_PX,
  HOVER_ACTIONS_MIN_ZOOM,
  LOD_FLOOR_ZOOM,
  MISSION_CHIP_CONTENT_WIDTH,
  MISSION_CHIP_LOD_TARGET_PX,
  ZONE_LABEL_CONTENT_PX,
  ZONE_LABEL_LOD_TARGET_PX,
  lodScale,
  titleBandHeight,
} from './lod';
import { DOT_SIZE } from './nodeChrome';
import { ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT } from '../geometry';
import { ZOOM_AGGREGATE } from '../canvasTypes';
import { bucketZoom } from './useZoomLevel';
import { CHIP_CELL_WIDTH, CHIP_PRIORITY, computeChipVisibility, type ChipCandidate } from './chipDeclutter';
import { clearChipVisibility, setChipVisibility } from './chipVisibilityStore';
import type { MissionNodeData } from '../canvasTypes';

/** Re-center the fleet this long after the LAST viewport change — long
 *  enough that it never fights a live wheel/drag gesture (the timer resets
 *  on every tick), short enough to feel like a "snap to frame" once the
 *  user stops. */
const AGGREGATE_CENTER_SETTLE_MS = 550;
/** Skip re-centering when the content's screen center is already within
 *  this fraction of the pane center on both axes (avoids a jitter loop and
 *  needless camera moves). */
const AGGREGATE_OFFCENTER_TOLERANCE = 0.16;

/** fix/canvas-legibility — declutter recompute debounce: same idiom as the
 *  aggregate re-center timer above, but much shorter (this only recomputes
 *  a screen-space grid bucketing, not a camera move) — just enough to
 *  never run on every intra-frame wheel/drag tick. */
const CHIP_DECLUTTER_DEBOUNCE_MS = 250;

export const CANVAS_LOD_DOT_SCALE_VAR = '--canvas-lod-dot-scale';
export const CANVAS_LOD_ZONE_LABEL_SCALE_VAR = '--canvas-lod-zone-label-scale';
/** fix/canvas-title-band-zoom — the zone header ROW's own effective
 *  flow-space height (chrome/lod.ts's `titleBandHeight`, a CSS length
 *  WITH its `px` unit already applied, unlike the other scale-factor vars
 *  above) so `canvas-zone-header`'s `overflow: hidden` never clips the
 *  LOD-scaled title/count-chip/approval-badge it holds (CANVAS_LOD_ZONE_
 *  LABEL_SCALE_VAR keeps THAT content's own screen size constant; this var
 *  is what keeps its CONTAINER big enough to not clip it).
 *  fix/canvas-title-float — the row this sizes now floats ABOVE its zone
 *  frame (`bottom: calc(100% + gap)`) instead of growing down inside it;
 *  this var still does the exact same job (grow the row so its own
 *  content isn't clipped), just applied to a row that now grows UPWARD
 *  into open canvas space instead of downward over mission cards. */
export const CANVAS_LOD_TITLE_BAND_HEIGHT_VAR = '--canvas-lod-title-band-height';
/** Exact inverse-zoom (floored) — the zone summary chip's scale at the
 *  aggregate tier: content authored at natural CSS px renders at EXACTLY
 *  constant screen size at any dezoom down to the floor. */
export const CANVAS_LOD_CHIP_SCALE_VAR = '--canvas-lod-chip-scale';
/** fix/canvas-legibility — the mission billboard chip's own constant-size
 *  compensation (chrome/lod.ts's MISSION_CHIP_CONTENT_WIDTH/TARGET_PX),
 *  distinct from CANVAS_LOD_CHIP_SCALE_VAR above (that one is the ZONE
 *  aggregate summary's scale, a different content size/target). */
export const CANVAS_LOD_MISSION_CHIP_SCALE_VAR = '--canvas-lod-mission-chip-scale';
/** `data-canvas-tier` attribute stamped on the canvas container —
 *  'aggregate' below ZOOM_AGGREGATE, 'normal' otherwise. Drives the
 *  CSS-only dot hiding at the aggregate tier (chrome/canvas.css). */
export const CANVAS_TIER_ATTR = 'data-canvas-tier';
/** fix/canvas-header-overflow — 'hidden' below HOVER_ACTIONS_MIN_ZOOM,
 *  'visible' otherwise. USED to drive a CSS-only hover-action-strip cutoff
 *  in chrome/canvas.css; that rule is now retired (W-CARDS: no semantic
 *  zoom — hover actions stay available at every zoom, see canvas.css's own
 *  doc comment at the old rule's former location). Still stamped here
 *  (harmless, cheap, single-subscription broadcast idiom shared with
 *  CANVAS_TIER_ATTR above) so a future re-enable only needs a CSS rule
 *  added back, not a new JS subscription. */
export const CANVAS_HOVER_CHROME_ATTR = 'data-canvas-hover-chrome';

/** fix/canvas-legibility — coarse priority bucket for a mission's chip
 *  declutter ranking (chipDeclutter.ts's CHIP_PRIORITY) from its real
 *  FleetMission facts — never a fabricated signal. A mission awaiting a
 *  human decision (pendingQuestion, or in review) outranks a merely-running
 *  one; failed always wins; a settled/paused mission is the first to fold. */
function chipPriorityFor(mission: MissionNodeData['mission']): number {
  if (mission.status === 'failed' || mission.status === 'cancelled') return CHIP_PRIORITY.failed;
  if (mission.pendingQuestion || mission.status === 'review') return CHIP_PRIORITY.decision;
  if (mission.status === 'running') return CHIP_PRIORITY.running;
  if (mission.status === 'queued') return CHIP_PRIORITY.queued;
  return CHIP_PRIORITY.done;
}

interface CanvasLodBroadcasterProps {
  /** The canvas' own outer container (CanvasView.tsx's `canvasContainerRef`)
   *  — CSS custom properties set here cascade to every descendant node
   *  card/zone header, which is all this needs (no per-node ref required). */
  containerRef: RefObject<HTMLElement | null>;
}

export function CanvasLodBroadcaster({ containerRef }: CanvasLodBroadcasterProps) {
  const { x, y, zoom } = useViewport();
  const instance = useReactFlow();
  const centerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const declutterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.setProperty(CANVAS_LOD_DOT_SCALE_VAR, String(lodScale(zoom, DOT_SIZE, DOT_LOD_TARGET_PX)));
    el.style.setProperty(
      CANVAS_LOD_ZONE_LABEL_SCALE_VAR,
      String(lodScale(zoom, ZONE_LABEL_CONTENT_PX, ZONE_LABEL_LOD_TARGET_PX)),
    );
    el.style.setProperty(CANVAS_LOD_CHIP_SCALE_VAR, String(1 / Math.max(zoom, LOD_FLOOR_ZOOM)));
    el.style.setProperty(
      CANVAS_LOD_MISSION_CHIP_SCALE_VAR,
      String(lodScale(zoom, MISSION_CHIP_CONTENT_WIDTH, MISSION_CHIP_LOD_TARGET_PX)),
    );
    el.style.setProperty(
      CANVAS_LOD_TITLE_BAND_HEIGHT_VAR,
      // fix/canvas-title-float — clamped against ZONE_TITLE_MAX_FLOW_HEIGHT
      // directly now (440, same number as the old ZONE_HEADER_HEIGHT +
      // ZONE_TITLE_BAND_HEIGHT expression), since that expression's own
      // meaning changed (geometry.ts's ZONE_TITLE_BAND_HEIGHT doc comment).
      `${titleBandHeight(zoom, ZONE_HEADER_HEIGHT, ZONE_TITLE_MAX_FLOW_HEIGHT)}px`,
    );
    el.setAttribute(CANVAS_TIER_ATTR, zoom < ZOOM_AGGREGATE ? 'aggregate' : 'normal');
    el.setAttribute(CANVAS_HOVER_CHROME_ATTR, zoom < HOVER_ACTIONS_MIN_ZOOM ? 'hidden' : 'visible');
  }, [zoom, containerRef]);

  // fix/canvas-legibility — chip declutter recompute (see
  // chipDeclutter.ts's own header): debounced 250ms, same idiom as the
  // aggregate re-center effect below, and ONLY active while the viewport is
  // genuinely in the chip tier — outside it the store is cleared so every
  // mission card reads back as "visible" (useChipVisible's safe default)
  // rather than carrying stale chip-tier folding into the compact/full
  // tiers. Reads node positions/data via the SAME `instance` (useReactFlow)
  // this component already subscribes to — no new RF subscription, and this
  // never runs per-frame (only after the debounce settles).
  useEffect(() => {
    if (declutterTimerRef.current) clearTimeout(declutterTimerRef.current);
    if (bucketZoom(zoom) !== 'chip') {
      clearChipVisibility();
      return;
    }
    declutterTimerRef.current = setTimeout(() => {
      const vp = instance.getViewport();
      const candidates: ChipCandidate[] = [];
      const zoneByMissionId = new Map<string, string>();
      for (const node of instance.getNodes()) {
        if (node.type !== 'mission') continue;
        const internal = instance.getInternalNode(node.id);
        const abs = internal?.internals.positionAbsolute ?? node.position;
        const data = node.data as unknown as MissionNodeData;
        candidates.push({
          id: node.id,
          screenX: abs.x * vp.zoom + vp.x,
          screenY: abs.y * vp.zoom + vp.y,
          priority: chipPriorityFor(data.mission),
        });
        if (data.projectId) zoneByMissionId.set(node.id, data.projectId);
      }
      const visibility = computeChipVisibility(candidates, CHIP_CELL_WIDTH);
      const foldedByZone = new Map<string, number>();
      for (const [id, visible] of visibility) {
        if (visible) continue;
        const projectId = zoneByMissionId.get(id);
        if (!projectId) continue;
        foldedByZone.set(projectId, (foldedByZone.get(projectId) ?? 0) + 1);
      }
      setChipVisibility(visibility, foldedByZone);
    }, CHIP_DECLUTTER_DEBOUNCE_MS);
    return () => {
      if (declutterTimerRef.current) clearTimeout(declutterTimerRef.current);
    };
  }, [zoom, x, y, instance]);

  // W-UX3 audit fix #4 — at aggregate zoom the fleet must use the pane, not
  // sit cramped in a corner (David's own 10% capture). Debounced so it
  // NEVER fights a live gesture: the timer resets on every viewport tick
  // (wheel/drag/programmatic pan alike), and only fires ~550ms after the
  // user has actually stopped — a gentle "snap the fleet to centre" then,
  // panning ONLY (the user's chosen zoom is preserved, so this can never
  // read as "dézoom ne marche pas"). Skips entirely when already centred.
  useEffect(() => {
    if (zoom >= ZOOM_AGGREGATE) return;
    const el = containerRef.current;
    if (!el) return;
    if (centerTimerRef.current) clearTimeout(centerTimerRef.current);
    centerTimerRef.current = setTimeout(() => {
      const projectNodes = instance.getNodes().filter((n) => n.type === 'project');
      if (projectNodes.length === 0) return;
      const bounds = instance.getNodesBounds(projectNodes);
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const vp = instance.getViewport();
      const contentCenterScreenX = (bounds.x + bounds.width / 2) * vp.zoom + vp.x;
      const contentCenterScreenY = (bounds.y + bounds.height / 2) * vp.zoom + vp.y;
      const dx = rect.width / 2 - contentCenterScreenX;
      const dy = rect.height / 2 - contentCenterScreenY;
      if (Math.abs(dx) / rect.width < AGGREGATE_OFFCENTER_TOLERANCE && Math.abs(dy) / rect.height < AGGREGATE_OFFCENTER_TOLERANCE) {
        return; // already framed — no camera move, no jitter loop
      }
      instance.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 400 });
    }, AGGREGATE_CENTER_SETTLE_MS);
    return () => {
      if (centerTimerRef.current) clearTimeout(centerTimerRef.current);
    };
  }, [x, y, zoom, containerRef, instance]);

  // PreviewNode gesture pause — this component is the single useViewport()
  // subscriber. Notify the module store so preview iframes freeze for the
  // settle tail without each card re-rendering every pan frame.
  useEffect(() => {
    notifyCanvasViewportMoving();
  }, [x, y, zoom]);

  return null;
}
