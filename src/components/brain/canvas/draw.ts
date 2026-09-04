/* draw.ts — imperative Canvas2D drawing for the Brain Canvas, ported from
   the design handoff prototype's `loop()` / `drawHud()` (see
   design_handoff_brain_redesign/Lazy IDE.dc.html, class Component).

   Every function here takes a 2D context plus already-computed frame data
   and issues draw calls — no state mutation, no per-frame allocation
   beyond what the Canvas2D API itself requires (gradients cannot be
   preallocated; the API creates them fresh per call, matching the
   prototype). Callers own and reuse all scratch objects/typed arrays.

   Draw order (matches the handoff exactly): backdrop -> ambient cortex
   field -> memory links -> signal pulses -> neurons (far->near) ->
   cluster labels.
*/

import { hexA } from './palettes';
import { ambientStride, projectInto } from './projection';
import type { CameraParams, Point3, ProjectedPoint } from './projection';
import type { AmbientField, Mote } from './ambientField';
import type { PulseState } from './pulses';
import type { ClusterAggregate, RenderEdge, RenderNode } from './types';
import { clusterDisplayLabel } from '../../../lib/brain/brainAdapter';
import { truncateMiddle } from '../../../lib/truncateMiddle';

/**
 * Above this many hero (full-bloom) nodes, additional visible nodes still
 * render and stay clickable, but as a cheap flat dot instead of a gradient
 * bloom — radialGradient per node does not scale to thousands of draw
 * calls at 60fps. The ambient cortex field is what represents "the mass"
 * visually; this cap only protects the interactive layer's worst case.
 */
export const MAX_HERO_NODES = 600;

const CYAN_RGB = '120,180,255';
const AMBIENT_COLOR_RGB = '150,190,255';
const AMBIENT_FADE_THRESHOLD = 0.03;
const AMBIENT_POINT_SIZE = 1.5;
const LABEL_FONT = '600 11px "JetBrains Mono", monospace';
const CLUSTER_LABEL_FONT = '700 11px "JetBrains Mono", monospace';
const CLUSTER_COUNT_FONT = '600 9px "JetBrains Mono", monospace';

// ── Backdrop: nebula halo, containment ring, drifting motes ─────────

export function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  t: number,
  motes: Mote[],
): void {
  const halo = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 1.15);
  halo.addColorStop(0, 'rgba(80,90,180,0.16)');
  halo.addColorStop(0.5, 'rgba(60,70,150,0.05)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 1.15, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 0.96, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${CYAN_RGB},0.07)`;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.globalCompositeOperation = 'lighter';
  for (const mote of motes) {
    mote.angle += mote.speed;
    const r = radius * mote.radiusFactor;
    const x = centerX + Math.cos(mote.angle) * r;
    const y = centerY + Math.sin(mote.angle) * r;
    const twinkle = 0.12 + 0.32 * Math.abs(Math.sin(t * 1.1 + mote.phase));
    ctx.beginPath();
    ctx.arc(x, y, mote.size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${CYAN_RGB},${twinkle})`;
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ── Ambient cortex density field (scalability trick — see MAX_HERO_NODES) ──

export function drawAmbientField(
  ctx: CanvasRenderingContext2D,
  ambient: AmbientField,
  cam: CameraParams,
  scratchPoint: Point3,
  scratchProjected: ProjectedPoint,
  zoom: number,
  t: number,
): void {
  const stride = ambientStride(zoom);
  const { positions, meta, count } = ambient;
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(${AMBIENT_COLOR_RGB},1)`;
  for (let i = 0; i < count; i += stride) {
    scratchPoint.x = positions[i * 3];
    scratchPoint.y = positions[i * 3 + 1];
    scratchPoint.z = positions[i * 3 + 2];
    projectInto(scratchPoint, cam, scratchProjected);
    if (scratchProjected.fade <= AMBIENT_FADE_THRESHOLD) continue;
    const phase = meta[i * 2];
    const amplitude = meta[i * 2 + 1];
    const twinkle = (0.3 + 0.5 * Math.abs(Math.sin(t * 0.8 + phase))) * scratchProjected.fade * amplitude;
    ctx.globalAlpha = twinkle;
    ctx.fillRect(scratchProjected.sx, scratchProjected.sy, AMBIENT_POINT_SIZE, AMBIENT_POINT_SIZE);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ── Memory links ──────────────────────────────────────────────────

export function drawLinks(
  ctx: CanvasRenderingContext2D,
  edges: readonly RenderEdge[],
  selectedId: string | null,
): void {
  for (const edge of edges) {
    const { a, b } = edge;
    if (!(a.visible && b.visible)) continue;
    const depthFade = (a.fade + b.fade) / 2;
    const isSelected = selectedId != null && (a.id === selectedId || b.id === selectedId);
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.strokeStyle = isSelected ? 'rgba(199,182,255,0.6)' : `rgba(150,150,215,${0.07 + 0.12 * depthFade})`;
    ctx.lineWidth = isSelected ? 1.5 : 0.8;
    ctx.stroke();
  }
}

// ── Signal pulses (already advanced by the caller — see pulses.ts) ──

export function drawPulses(
  ctx: CanvasRenderingContext2D,
  edges: readonly RenderEdge[],
  pulses: readonly PulseState[],
): void {
  ctx.globalCompositeOperation = 'lighter';
  for (const pulse of pulses) {
    const edge = edges[pulse.edgeIndex];
    if (!edge) continue;
    const { a, b } = edge;
    if (!(a.visible && b.visible)) continue;
    const px = a.sx + (b.sx - a.sx) * pulse.t;
    const py = a.sy + (b.sy - a.sy) * pulse.t;
    const gradient = ctx.createRadialGradient(px, py, 0, px, py, 5);
    gradient.addColorStop(0, a.color);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ── Neurons (far -> near) ────────────────────────────────────────────

function drawGhostDot(ctx: CanvasRenderingContext2D, node: RenderNode): void {
  ctx.beginPath();
  ctx.arc(node.sx, node.sy, node.r * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = node.color;
  ctx.globalAlpha = 0.08;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * Size curve shared by the cheap dot and hero node renderers: a
 * freshly-(un)revealed node visibly grows in/shrinks out during time-travel
 * scrubbing instead of only fading, while never collapsing all the way to
 * zero (which would make the shrink read as a glitch rather than a
 * transition). See RenderNode.reveal in canvas/types.ts.
 */
function revealSizeFactor(reveal: number): number {
  return 0.55 + 0.45 * reveal;
}

/** Cheap flat dot for visible-but-beyond-MAX_HERO_NODES nodes — still clickable, just no gradient. */
function drawCheapDot(ctx: CanvasRenderingContext2D, node: RenderNode): void {
  const fade = (0.45 + 0.55 * node.fade) * node.reveal;
  const r = node.r * revealSizeFactor(node.reveal);
  ctx.beginPath();
  ctx.arc(node.sx, node.sy, r * 0.7, 0, Math.PI * 2);
  ctx.fillStyle = node.color;
  ctx.globalAlpha = 0.55 * fade;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawHeroNode(
  ctx: CanvasRenderingContext2D,
  node: RenderNode,
  t: number,
  isHover: boolean,
  isSelected: boolean,
): void {
  const breathe = 1 + Math.sin(t * 1.6 + node.breathePhase) * 0.07;
  const fire = node.fire;
  const r = node.r * (isHover || isSelected ? 1.5 : 1) * breathe * revealSizeFactor(node.reveal);
  const fade = (0.45 + 0.55 * node.fade) * node.reveal;

  // bloom halo (additive radial gradient — NOT a per-point arc/shadow trick)
  ctx.globalCompositeOperation = 'lighter';
  const haloR = r * (3.4 + fire * 2.5) * (isHover || isSelected ? 1.4 : 1);
  const gradient = ctx.createRadialGradient(node.sx, node.sy, 0, node.sx, node.sy, haloR);
  const haloAlpha = Math.min(1, (0.5 + fire * 0.5) * fade);
  gradient.addColorStop(0, node.color);
  gradient.addColorStop(0.4, hexA(node.color, 0.35 * haloAlpha));
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = haloAlpha;
  ctx.beginPath();
  ctx.arc(node.sx, node.sy, haloR, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // solid disc
  ctx.beginPath();
  ctx.arc(node.sx, node.sy, r, 0, Math.PI * 2);
  ctx.fillStyle = node.color;
  ctx.globalAlpha = fade;
  ctx.fill();

  // white core
  ctx.beginPath();
  ctx.arc(node.sx, node.sy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.globalAlpha = Math.min(1, fade + fire * 0.5);
  ctx.fill();
  ctx.globalAlpha = 1;

  // firing shockwave
  if (fire > 0.05) {
    ctx.beginPath();
    ctx.arc(node.sx, node.sy, r + (1 - fire) * 16, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(node.color, fire * 0.6);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // selection / hover ring
  if (isSelected || isHover) {
    ctx.beginPath();
    ctx.arc(node.sx, node.sy, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(node.color, isSelected ? 0.85 : 0.5);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // label on hover/select only
  if (isHover || isSelected) {
    ctx.font = LABEL_FONT;
    const textWidth = ctx.measureText(node.title).width;
    const lx = node.sx + r + 8;
    const ly = node.sy + 3.5;
    ctx.fillStyle = 'rgba(8,10,16,0.82)';
    ctx.fillRect(lx - 5, ly - 11, textWidth + 10, 17);
    ctx.fillStyle = node.color;
    ctx.fillRect(lx - 5, ly - 11, 2, 17);
    ctx.fillStyle = '#F4F1FF';
    ctx.fillText(node.title, lx + 2, ly + 3);
  }
}

/** Below this reveal level a node renders as the same faint ghost dot used
 *  for out-of-range time-travel nodes — close enough to 0 that a gradient
 *  bloom would be imperceptible, so skip straight to the cheap draw path. */
const REVEAL_GHOST_THRESHOLD = 0.04;

export function drawNeurons(
  ctx: CanvasRenderingContext2D,
  order: readonly RenderNode[],
  t: number,
  hoverId: string | null,
  selectedId: string | null,
): void {
  for (const node of order) {
    if (node.reveal <= REVEAL_GHOST_THRESHOLD) {
      drawGhostDot(ctx, node);
      continue;
    }
    if (!node.isHero) {
      drawCheapDot(ctx, node);
      continue;
    }
    drawHeroNode(ctx, node, t, hoverId === node.id, selectedId === node.id);
  }
}

// ── Cluster labels ────────────────────────────────────────────────
//
// Every cluster with at least one visible node always gets its small
// glowing anchor dot + connector tick (drawClusterAnchor) — that marker
// never disappears, at any density. Only the TEXT CAPTION next to it is
// collision-aware: bigger clusters (by visible node count) get first pick
// of an unobstructed spot near their centroid, trying a few vertical
// nudges before a smaller/lower-priority cluster's caption is skipped
// rather than stacked illegibly on top of one already placed. This is the
// same trade-off ordinary map/chart label decluttering makes (Apple/Google
// Maps pins, D3 label placement): nothing about the DATA is hidden — every
// node keeps rendering and stays clickable, every cluster keeps its anchor
// — only a redundant, unreadable duplicate text box is dropped, and only
// when the screen area is too dense to fit it anywhere nearby. This is not
// zoom-dependent and does not scale with how far the user has zoomed in —
// it only reacts to actual on-screen crowding at the CURRENT view, so a
// cluster's caption reappears the moment its neighborhood declutters
// (rotate, zoom, filter) rather than being tied to a hidden threshold.

/** Vertical nudges (px) tried in priority order before a caption is skipped. */
const LABEL_NUDGE_OFFSETS = [0, -22, 22, -44];
/** Extra margin (px) added around a candidate box before treating it as overlapping a placed one — keeps captions visually separated, not just non-touching. */
const LABEL_COLLISION_PAD = 6;
/**
 * Caption text is capped to this many characters (middle-ellipsis, see
 * `truncateMiddle`) before it is ever measured or drawn. Without a cap, a
 * raw cluster id such as a scratch-test project name
 * (`LAZY-E2E-CANVAS-SCRATCH-1784851889129`) produces a caption pill wide
 * enough to sprawl across a third of the canvas and starve every
 * neighboring cluster's collision budget. Middle-ellipsis (not end-ellipsis)
 * because David's real cluster/project names are disambiguated by their
 * SUFFIX (`-b`/`-c`/dates) — see `lib/truncateMiddle.ts`'s own header.
 */
const MAX_CLUSTER_LABEL_CHARS = 22;

export interface LabelRect { x0: number; y0: number; x1: number; y1: number }

export function rectsOverlap(a: LabelRect, b: LabelRect, pad: number): boolean {
  return !(a.x1 + pad < b.x0 || b.x1 + pad < a.x0 || a.y1 + pad < b.y0 || b.y1 + pad < a.y0);
}

/** Input to `placeClusterLabels`: one candidate caption per visible cluster, already measured (font metrics happen in the caller, which owns the canvas context — this function stays pure/canvas-free so it is unit-testable without rendering). */
export interface ClusterLabelCandidate {
  clusterId: string;
  /** On-screen visible node count for this cluster — drives placement priority (bigger cluster wins the spot). */
  count: number;
  /** Horizontal center the caption is centered on (cluster centroid). */
  sx: number;
  /** Preferred (undisturbed) vertical anchor for the caption — `LABEL_NUDGE_OFFSETS` are tried relative to this. */
  baseLy: number;
  /** Full measured width (label + count + padding) of the caption pill. */
  totalWidth: number;
}

/** A caption that won a non-colliding spot. Candidates that never found one are simply absent from the result — their cluster still gets its anchor dot (drawn unconditionally by the caller), just no text caption. */
export interface ClusterLabelPlacement {
  clusterId: string;
  /** Left edge of the caption pill. */
  bx: number;
  /** Vertical anchor actually used (one of `baseLy + LABEL_NUDGE_OFFSETS`). */
  ly: number;
}

/**
 * Greedy collision-rejection placement, same trade-off ordinary map/chart
 * label decluttering makes (Apple/Google Maps pins, D3 label placement,
 * Obsidian's graph view, Kumu): sort candidates by on-screen node count
 * descending (bigger clusters get first pick of an unobstructed spot),
 * then for each one try a few vertical nudges near its preferred anchor and
 * take the first that does not intersect any already-placed rect; if none
 * of the nudges is free, the caption is skipped entirely rather than
 * stacked illegibly on top of one already placed. Deterministic tie-break
 * by clusterId so two equally-sized clusters don't flicker priority frame
 * to frame.
 *
 * Pure and canvas-free by design — no `CanvasRenderingContext2D`, no font
 * measurement, so it is directly unit-testable.
 */
export function placeClusterLabels(candidates: readonly ClusterLabelCandidate[]): ClusterLabelPlacement[] {
  const sorted = [...candidates].sort((a, b) => b.count - a.count || a.clusterId.localeCompare(b.clusterId));
  const placedRects: LabelRect[] = [];
  const placements: ClusterLabelPlacement[] = [];

  for (const candidate of sorted) {
    for (const dy of LABEL_NUDGE_OFFSETS) {
      const ly = candidate.baseLy + dy;
      const bx = candidate.sx - candidate.totalWidth / 2;
      const rect: LabelRect = { x0: bx, y0: ly - 9, x1: bx + candidate.totalWidth, y1: ly + 8 };
      if (placedRects.some((r) => rectsOverlap(rect, r, LABEL_COLLISION_PAD))) continue;
      placedRects.push(rect);
      placements.push({ clusterId: candidate.clusterId, bx, ly });
      break;
    }
  }

  return placements;
}

/** The small glowing dot + connector tick that always marks a cluster's centroid, independent of whether its text caption fit. */
function drawClusterAnchor(ctx: CanvasRenderingContext2D, sx: number, ly: number, color: string): void {
  ctx.strokeStyle = `${color}88`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sx, ly + 8);
  ctx.lineTo(sx, ly + 16);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(sx, ly - 0.5, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.shadowBlur = 8;
  ctx.shadowColor = color;
  ctx.fill();
  ctx.shadowBlur = 0;
}

/**
 * Solid (fully opaque) backing plaque color — deliberately NOT translucent.
 * A translucent pill (the previous `rgba(8,10,16,0.62)`) lets the bright
 * additive neuron bloom/halos ('lighter' composite, see drawHeroNode) bleed
 * through underneath the caption text, which is exactly what made labels
 * like ENGINE/UNKNOWN/LAZYBRAIN unreadable when they landed over the dense
 * node cloud. An opaque plaque fully occludes whatever was painted before
 * it, regardless of how bright/dense the cloud beneath is.
 */
const CLUSTER_LABEL_BG = 'rgba(7,9,16,1)';

/** The text caption pill (background + accent bar + label + count), drawn only once a non-colliding spot has been found for it. */
function drawClusterCaption(
  ctx: CanvasRenderingContext2D,
  bx: number,
  ly: number,
  color: string,
  label: string,
  labelWidth: number,
  countText: string,
): void {
  ctx.font = CLUSTER_LABEL_FONT;
  ctx.fillStyle = CLUSTER_LABEL_BG;
  ctx.fillRect(bx, ly - 9, labelWidth + 26, 17);

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(bx, ly - 9, 2, 17);
  ctx.globalAlpha = 1;

  ctx.fillStyle = color;
  ctx.fillText(label, bx + 19, ly + 3.5);

  ctx.font = CLUSTER_COUNT_FONT;
  ctx.fillStyle = 'rgba(232,227,255,0.4)';
  ctx.fillText(countText, bx + 19 + labelWidth + 2, ly + 3.5);
}

/** Per-cluster caption text/metrics, keyed by clusterId, computed once and consulted after `placeClusterLabels` decides which clusters actually get a drawn caption. */
interface ClusterCaptionMeta {
  color: string;
  label: string;
  labelWidth: number;
  countText: string;
}

export function drawClusterLabels(
  ctx: CanvasRenderingContext2D,
  clusterAggregates: ReadonlyMap<string, ClusterAggregate>,
): void {
  const visible: ClusterAggregate[] = [];
  for (const agg of clusterAggregates.values()) {
    if (agg.count > 0) visible.push(agg);
  }

  const candidates: ClusterLabelCandidate[] = [];
  const captionMeta = new Map<string, ClusterCaptionMeta>();

  for (const agg of visible) {
    const sx = agg.sumX / agg.count;
    const baseLy = agg.topY - 20;

    // Anchor is unconditional — every cluster with visible nodes gets one,
    // regardless of whether its caption below finds room. Anchors are cheap
    // and never collide with each other, so they draw in plain iteration
    // order; only captions go through the collision-aware placement pass.
    drawClusterAnchor(ctx, sx, baseLy, agg.color);

    // Cap the label BEFORE measuring/laying it out — an untruncated raw
    // cluster id (e.g. a scratch-test project name) would otherwise size
    // its own caption pill wide enough to eat the placement budget of every
    // neighboring cluster. Middle-ellipsis preserves the discriminating
    // suffix real project names carry (see MAX_CLUSTER_LABEL_CHARS above).
    const label = truncateMiddle(clusterDisplayLabel(agg.clusterId), MAX_CLUSTER_LABEL_CHARS).toUpperCase();
    ctx.font = CLUSTER_LABEL_FONT;
    const labelWidth = ctx.measureText(label).width;
    const countText = String(agg.count);
    ctx.font = CLUSTER_COUNT_FONT;
    const countWidth = ctx.measureText(countText).width;
    const totalWidth = labelWidth + 26 + countWidth + 2;

    candidates.push({ clusterId: agg.clusterId, count: agg.count, sx, baseLy, totalWidth });
    captionMeta.set(agg.clusterId, { color: agg.color, label, labelWidth, countText });
  }

  // Captions are drawn in ONE pass, over the placements `placeClusterLabels`
  // resolved for every candidate at once — never interleaved with anchor or
  // node drawing — and this whole function only ever runs after
  // `drawNeurons` for the frame (see BrainGraph3D's render loop), so a
  // caption is never subsequently painted over by node content.
  for (const placement of placeClusterLabels(candidates)) {
    const meta = captionMeta.get(placement.clusterId);
    if (!meta) continue;
    drawClusterCaption(ctx, placement.bx, placement.ly, meta.color, meta.label, meta.labelWidth, meta.countText);
  }
}
