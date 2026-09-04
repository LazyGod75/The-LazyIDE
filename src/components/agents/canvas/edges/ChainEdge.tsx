/* ChainEdge.tsx — a chain handoff edge (spec §4.4/§7): bezier path, style
   keyed off `condition` (success/fail/always), a small condition chip at
   the midpoint, dimmed when `disabled`, dimmed + a "target gone" tooltip
   (canvas.edge.targetGone) when `tombstone` (spec §6 — the target mission
   vanished from the journal but the chain reference is kept so a draft doesn't dangle
   silently), and a traveling-dot animation that plays once while `firing`
   is true (CSS `offset-path`, no JS timers — see chrome/canvas.css).

   `ChainEdgeData` (condition/disabled/tombstone/firing) is NOT part of
   canvasTypes.ts's frozen `Chain` model — that interface only covers the
   PERSISTED chain (id/sourceRef/targetRef/condition/createdBy/disabled).
   `tombstone` and `firing` are transient RENDER flags the reconciler (W1a)
   derives per-poll (tombstone: target ref no longer resolves to a live
   node; firing: a chain just fired this tick) — defined here since
   they're this edge component's own data contract, not shared canvas
   state. Flagged as a canvasTypes gap in the W1b handoff: W1a's reconciler
   must produce `edge.data` matching this shape when it builds `chain:`
   edges.
*/

import { memo, useCallback, type CSSProperties } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type Edge,
  type EdgeProps,
  type ReactFlowState,
} from '@xyflow/react';
import { useI18n } from '../../../../i18n';
import { parseRef, type ChainCondition } from '../canvasTypes';
import { useCanvasStore } from '../canvasStore';
import { PinGlyph, TYPE_ACCENT_COLORS } from '../chrome/nodeChrome';
import { computeSmartEdgePath, type Rect } from './smartEdgePath';

/** edgeSpec — per-edge gradient stop color, looked up from the endpoint
 *  node's own TYPE accent (chrome/nodeChrome.tsx's TYPE_ACCENT_COLORS).
 *  Falls back to the generic edge-default color for a ref whose kind has
 *  no accent entry (project/iteration — never actually a chain endpoint
 *  in practice, but defensive rather than crashing on a malformed ref). */
function accentForRef(ref: string): string {
  const parsed = parseRef(ref);
  if (!parsed) return 'var(--color-accent)';
  const accent = (TYPE_ACCENT_COLORS as Record<string, string | undefined>)[parsed.kind];
  return accent ?? 'var(--color-accent)';
}

/** SVG linearGradient degenerates to a solid color on a zero-length axis
 *  (Flowise gotcha) — nudge one coordinate by an imperceptible amount when
 *  source/target share the same x AND y. */
function nudgeIfDegenerate(x1: number, y1: number, x2: number, y2: number): [number, number, number, number] {
  if (x1 === x2 && y1 === y2) return [x1, y1, x2 + 0.0001, y2];
  return [x1, y1, x2, y2];
}

export interface ChainEdgeData extends Record<string, unknown> {
  condition: ChainCondition;
  /** Mirrors `Chain.disabled` — turned off without deleting, never fires. */
  disabled?: boolean;
  /** Target ref no longer resolves to a live node (spec §6). */
  tombstone?: boolean;
  /** True for exactly the tick a chain fires — mounts the traveling-dot
   *  animation once, then the reconciler clears it back to false/absent. */
  firing?: boolean;
  /** W8c (additive) — mirrors `Chain.pinnedContext != null`: this chain's
   *  firing injects a FROZEN snapshot instead of live output. Drives the pin
   *  glyph on the edge label (deliverable #1). */
  pinned?: boolean;
  /** Data payload snapshot injected across this edge. */
  pinnedContext?: { text: string; pinnedAtMs: number; sourceTitle: string };
  /** W8c (additive) — set when this edge's source is a router BRANCH
   *  (`router:<id>:<branchId>` — see canvasTypes.ts's `parseRouterBranchRef`):
   *  the branch's own label, shown INSTEAD of the plain condition chip so the
   *  N labeled outputs stay distinguishable even though every branch edge
   *  visually emanates from the same router node (v1 simplification — no
   *  per-branch React Flow handle). */
  branchLabel?: string;
  /** Chantier 3 (plan-first canvas) — mirrors `Chain.proposedPlanId != null`:
   *  this edge is part of a still-pending plan proposal, not yet validated.
   *  Renders a distinctly dimmer, tighter-dashed stroke plus a "Proposé"
   *  prefix on the condition label so a proposed dependsOn edge never reads
   *  as an already-wired, live chain. */
  proposed?: boolean;
}

export type ChainFlowEdge = Edge<ChainEdgeData, 'chain'>;

// fix/canvas-graph-legibility (founder, verbatim: "l'edge y a écrit en
// ligne mais on voit rien ... les edges sont en pointillés fins labellisés
// 'Toujours'") — 'always' (the DEFAULT chain condition — most edges on a
// real canvas) used to render as a near-invisible 1px-dash/4px-gap hairline
// in a low-contrast grey: a plain-language "just go to the next step no
// matter what" link read as barely-there noise instead of the graph's own
// backbone. Now a solid line in `--canvas-edge-default` (chrome/canvas.css
// — a higher-contrast alias of `--color-text-secondary`), same "solid unless
// there's a real reason to dash" treatment `success`/`fail` already got.
const CONDITION_STYLE: Record<ChainCondition, { stroke: string; dashArray?: string }> = {
  success: { stroke: 'var(--color-accent)' },
  fail: { stroke: 'var(--color-danger)', dashArray: '5 4' },
  always: { stroke: 'var(--canvas-edge-default)' },
};

/** Pure — stroke color/dash/opacity for a condition + disabled/tombstone
 *  state. Exported so tests can assert the per-condition mapping without
 *  mounting the SVG edge (BaseEdge/EdgeLabelRenderer need to be inside a
 *  live React Flow edge-rendering pass to portal correctly). */
export function conditionStrokeProps(
  condition: ChainCondition,
  muted: boolean,
): { stroke: string; strokeDasharray?: string; opacity: number } {
  const base = CONDITION_STYLE[condition];
  return { stroke: base.stroke, strokeDasharray: base.dashArray, opacity: muted ? 0.35 : 1 };
}

/** Pure — condition chip i18n KEY (not translated text): this helper is
 *  independently unit-tested outside any React render (see
 *  canvasNodes.test.tsx), so it cannot call `useI18n()` itself — same
 *  key-returning convention as chainValidation.ts's `reasonKey` /
 *  lib/models/entitlement.ts's `engineReasonKey`. The one render call site
 *  (below) resolves it via `t(conditionLabelKey(condition))`. */
export function conditionLabelKey(condition: ChainCondition): string {
  if (condition === 'success') return 'canvas.edge.conditionSuccess';
  if (condition === 'fail') return 'canvas.edge.conditionFail';
  return 'canvas.edge.conditionAlways';
}

/** Visual sweep #4 (P47) — the condition chip ("Succès"/…) used to render
 *  dead-center on the edge's own raw midpoint, with a z-index (1002, R4d's
 *  own fix below) high enough to clear the connection-line/selected-node
 *  stacking ceiling — but React Flow gives EVERY node an explicit numeric
 *  `zIndex` (0 for a plain unselected one, never CSS `auto`), so a
 *  POSITIVE label z-index unavoidably paints above ordinary node cards too,
 *  not just the elevated selected one the fix targeted (CSS stacking:
 *  there is no value that clears 1001/1000 while staying under a sibling's
 *  explicit 0 — see this file's own git history for the full stacking-order
 *  derivation). For a short chain edge between vertically stacked cards —
 *  the common case, one zone's own drafts/missions — that raw midpoint can
 *  sit squarely inside the NEIGHBORING card's header, so the label paints
 *  straight over live node text ("Succ…" clipping a title mid-word). A
 *  fixed vertical nudge off the raw midpoint (deterministic, same
 *  direction/magnitude every time) moves the chip into the gap ABOVE the
 *  line instead of directly on the seam where a card's own edge sits —
 *  matching the hover-only delete button's own `-14` offset just below (see
 *  its `foreignObject` `y` prop) so the two float together instead of
 *  drifting apart. */
export const CHAIN_EDGE_LABEL_Y_NUDGE_PX = 14;

/** Pure — the label's rendered (x, y) given the edge path's raw midpoint;
 *  independently unit-tested (see canvasNodes.test.tsx's own "ChainEdge
 *  condition mapping" describe block, alongside conditionLabelKey/
 *  conditionStrokeProps above) without mounting the SVG edge. */
export function chainEdgeLabelPosition(labelX: number, labelY: number): { x: number; y: number } {
  return { x: labelX, y: labelY - CHAIN_EDGE_LABEL_Y_NUDGE_PX };
}

// ── Smart routing (W8a deliverable #4) ─────────────────────────────────
//
// Obstacles = every project ZONE rect except the source's and target's own
// parent zones (an edge may legitimately overlap the zones it starts/ends
// in). Read straight from React Flow's internal nodeLookup — absolute
// positions + measured sizes, no reconciler change and no per-edge data
// bloat. The custom equality below keeps the memo'd edge from re-rendering
// on unrelated store ticks (only a zone's own move/resize invalidates).

function obstacleRectsEqual(a: readonly Rect[], b: readonly Rect[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].width !== b[i].width || a[i].height !== b[i].height) {
      return false;
    }
  }
  return true;
}

function useObstacleZoneRects(sourceNodeId: string, targetNodeId: string): Rect[] {
  return useStore(
    useCallback(
      (s: ReactFlowState) => {
        const sourceParent = s.nodeLookup.get(sourceNodeId)?.parentId;
        const targetParent = s.nodeLookup.get(targetNodeId)?.parentId;
        const rects: Rect[] = [];
        for (const [nodeId, node] of s.nodeLookup) {
          if (node.type !== 'project') continue;
          if (nodeId === sourceParent || nodeId === targetParent) continue;
          const width = node.measured.width ?? node.width ?? 0;
          const height = node.measured.height ?? node.height ?? 0;
          if (width <= 0 || height <= 0) continue;
          rects.push({ x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y, width, height });
        }
        return rects;
      },
      [sourceNodeId, targetNodeId],
    ),
    obstacleRectsEqual,
  );
}

// W5b memo audit: every node component in nodes/*.tsx was already
// React.memo'd (see e.g. MissionNode's identical `memo(function ...)`
// shape) but the two edge components were not — an edge re-renders on
// every reconcile pass otherwise, even when its own props are unchanged
// (reconciler.ts's `dataUnchanged`/`stableData` already keeps `data`
// referentially stable across polls, so memo actually pays off here).
export const ChainEdge = memo(function ChainEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps<ChainFlowEdge>) {
  const { t } = useI18n();
  const removeChain = useCanvasStore((s) => s.removeChain);
  // W8a deliverable #4 — opt-in smart routing pref (default ON: a persisted
  // prefs object written before the field exists reads as `undefined`).
  const smartEdgesEnabled = useCanvasStore((s) => s.prefs.smartEdges !== false);
  const obstacles = useObstacleZoneRects(source, target);
  const condition = data?.condition ?? 'success';
  const muted = Boolean(data?.disabled || data?.tombstone);
  const proposed = Boolean(data?.proposed);
  const strokeProps = conditionStrokeProps(condition, muted);
  // Chantier 3 — a proposed edge is dimmer than even a `disabled` one (it
  // was never wired by a real decision yet) and always tight-dashed,
  // regardless of `condition`'s own dash pattern, so a proposed dependsOn
  // edge is unmistakable next to a live chain of the same condition.
  // fix/canvas-graph-legibility — denser than the old '2 3' (more ink than
  // gap) so "proposed" still reads clearly as a real line, not a scatter of
  // dots, alongside this wave's other legibility fixes.
  const proposedStrokeDasharray = '4 3';
  const [bezierPath, bezierLabelX, bezierLabelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const smart =
    smartEdgesEnabled && obstacles.length > 0
      ? computeSmartEdgePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, obstacles)
      : null;
  const edgePath = smart ? smart.path : bezierPath;
  const labelX = smart ? smart.labelX : bezierLabelX;
  const labelY = smart ? smart.labelY : bezierLabelY;
  // Sweep #4 — see chainEdgeLabelPosition's own doc comment: the RENDERED
  // chip position nudges off the raw midpoint so it doesn't paint over a
  // neighboring node's card; `labelX`/`labelY` themselves stay the true
  // midpoint (still used by the hover delete button/traveling dot above).
  const labelPos = chainEdgeLabelPosition(labelX, labelY);

  // ── edgeSpec — per-edge gradient (Flowise pattern, the single highest-
  //    impact legibility fix per the brief): ONLY for a live, un-muted
  //    'success' link — fail/always keep their own condition-color
  //    semantics (module header's CONDITION_STYLE), which the brief also
  //    asks to preserve ("chain conditions keep color semantics").
  const useGradient = condition === 'success' && !muted;
  const sourceAccent = accentForRef(source);
  const targetAccent = accentForRef(target);
  const [gx1, gy1, gx2, gy2] = nudgeIfDegenerate(sourceX, sourceY, targetX, targetY);
  const gradientId = `edge-gradient-${id}`;
  const strokeColor = useGradient ? `url(#${gradientId})` : strokeProps.stroke;
  // "Running/active" (edgeSpec) — the real, already-computed signal for
  // "this chain is actively delivering" is the reconciler's own `firing`
  // tick (never a fabricated independent endpoint-liveness re-check).
  const flowing = Boolean(data?.firing) && !muted;

  // fix/canvas-graph-legibility — "REPLACE the 'Toujours' label": the
  // DEFAULT condition ('always', with no router branch label) is now a
  // plain solid edge with NO floating chip at all — the jargon-y "Toujours"
  // text on every single default edge was pure noise (founder: "on
  // comprend rien"). A non-default condition (success/fail) or a router
  // branch label still gets its compact badge — that text carries real
  // information. `pinned`/`proposed` are independent, meaningful flags
  // (never "just the default"), so either keeps the chip alive even on an
  // otherwise-label-less default edge — losing the ONLY on-edge pin
  // indicator would trade one legibility bug for another.
  const hasBranchLabel = Boolean(data?.branchLabel);
  const isDefaultCondition = condition === 'always' && !hasBranchLabel;
  const showLabelChip = !isDefaultCondition || proposed || Boolean(data?.pinned);

  const contextSnippet = data?.pinnedContext?.text
    ? data.pinnedContext.text.slice(0, 140).replace(/\s+/g, ' ')
    : undefined;
  const flowTooltip = data?.tombstone
    ? t('canvas.edge.targetGone')
    : contextSnippet
      ? `Transfert de contexte (${data?.pinnedContext?.sourceTitle ?? 'Amont'}): "${contextSnippet}..."`
      : undefined;

  return (
    <>
      {useGradient && (
        <defs>
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={gx1} y1={gy1} x2={gx2} y2={gy2}>
            <stop offset="0%" stopColor={sourceAccent} />
            <stop offset="100%" stopColor={targetAccent} />
          </linearGradient>
        </defs>
      )}
      <g className="canvas-edge-group">
        <BaseEdge
          id={id}
          path={edgePath}
          markerEnd={markerEnd}
          interactionWidth={16}
          className={flowing ? 'canvas-edge-flowing' : undefined}
          style={{
            stroke: strokeColor,
            // fix/canvas-graph-legibility — 2/3px base -> 3/4px: the whole
            // graph read as a scatter of hairlines rather than a connected
            // structure (founder: "on comprend rien"). Selected keeps its
            // +1px delta over the resting width.
            strokeWidth: selected ? 4 : 3,
            // fix/canvas-zoom-visuals — non-scaling stroke: 3/4px stays 3/4
            // SCREEN px at every zoom level. Before this, the SVG transform
            // multiplied the stroke by the viewport zoom, so a selected edge
            // at 200% rendered as a fat 8px band with a drop shadow (review-
            // gate screenshot), while at 27% overview the same edge shrank
            // back to the hairline scatter this width bump was meant to fix.
            // Constant screen-px weight gives both ends of the zoom range the
            // legible graph structure the 3px bump was after.
            vectorEffect: 'non-scaling-stroke',
            strokeDasharray: proposed ? proposedStrokeDasharray : strokeProps.strokeDasharray,
            opacity: selected ? 1 : proposed ? Math.min(strokeProps.opacity, 0.5) : strokeProps.opacity,
            filter: selected ? 'drop-shadow(0 0 3px rgba(0,0,0,0.5))' : undefined,
          }}
        />
        {data?.firing && (
          <circle
            data-testid={`chain-edge-dot-${id}`}
            r={4}
            fill={useGradient ? targetAccent : 'var(--color-accent)'}
            className="canvas-chain-dot"
            style={{ offsetPath: `path('${edgePath}')` } as CSSProperties}
          />
        )}
        {/* edgeSpec — hover delete button, CSS-reveal only (no React hover
            state, see chrome/canvas.css's `.canvas-edge-group:hover` rule). */}
        {!muted && (
          <foreignObject x={labelX - 18} y={labelY - 18 - 14} width={36} height={36} style={{ overflow: 'visible', pointerEvents: 'none' }}>
            <button
              type="button"
              data-testid={`chain-edge-delete-${id}`}
              className="nodrag nopan canvas-edge-delete-btn"
              title={t('canvas.contextMenu.delete')}
              aria-label={t('canvas.contextMenu.delete')}
              onClick={(e) => {
                e.stopPropagation();
                removeChain(id);
              }}
              style={{
                pointerEvents: 'all',
                width: 36,
                height: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: `linear-gradient(to right, ${sourceAccent}, ${targetAccent})`,
                  boxShadow: '0 0 4px rgba(0,0,0,0.5)',
                }}
              >
                <svg width={8} height={8} viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 2 8 8M8 2 2 8" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
            </button>
          </foreignObject>
        )}
      </g>
      {showLabelChip && (
      <EdgeLabelRenderer>
        <div
          data-testid={`chain-edge-label-${id}`}
          data-condition={condition}
          data-smart-routed={smart ? 'true' : undefined}
          data-tooltip={data?.tombstone ? t('canvas.edge.targetGone') : undefined}
          title={flowTooltip}
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelPos.x}px, ${labelPos.y}px)`,
            pointerEvents: 'all',
            // fix/canvas-ux R4d (dogfood defect #4) — `.react-flow__edgelabel-
            // renderer` (this label's portal container, @xyflow/react's own
            // base.css) carries NO z-index of its own, while an individual
            // `.react-flow__node` gets one assigned inline whenever it's
            // elevated (CanvasView.tsx's `elevateNodesOnSelect` raises a
            // selected node's stacking to 1000) — an explicit z-index on a
            // positioned element always paints above a plain z-index:auto
            // sibling regardless of DOM order, so a short edge between two
            // adjacent cards could end up with its label PAINTED BEHIND the
            // neighboring card (orchestrator's d17 review: "Succè…" clipped).
            // 1002 clears both that elevated-node ceiling and
            // `.react-flow__connectionline`'s own 1001 (the in-progress
            // connection-drag preview line), so the label is never
            // ambiguous about which surface wins.
            zIndex: 1002,
            fontSize: 9.5,
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 5,
            background: 'var(--color-panel-2)',
            border: `1px solid ${strokeProps.stroke}`,
            color: strokeProps.stroke,
            opacity: proposed ? Math.min(strokeProps.opacity, 0.6) : strokeProps.opacity,
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'nowrap',
          }}
        >
          {proposed && (
            <span style={{ marginRight: 4, color: 'var(--color-warning, #f5b942)' }}>
              {t('canvas.edge.proposed')}
            </span>
          )}
          {!isDefaultCondition && (data?.branchLabel ?? t(conditionLabelKey(condition)))}
          {data?.pinned && (
            <span
              data-testid={`chain-edge-pin-${id}`}
              title={t('canvas.edge.pinned')}
              aria-label={t('canvas.edge.pinned')}
              style={{
                marginLeft: 4,
                display: 'inline-flex',
                alignItems: 'center',
                verticalAlign: 'middle',
                background: 'var(--color-accent)',
                borderRadius: 5,
                padding: '2px 3px',
              }}
            >
              <PinGlyph size={15} color="#fff" />
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
      )}
    </>
  );
});
