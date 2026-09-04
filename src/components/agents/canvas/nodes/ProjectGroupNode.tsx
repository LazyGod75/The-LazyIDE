/* ProjectGroupNode.tsx — one project zone (spec §4.1): a React Flow group
   node (children set `parentId` + `extent: 'parent'` — that wiring is
   the reconciler's job, W1a/W1c; this component only renders the zone's
   own chrome). Expanded: tinted background + colored border, a title
   label (name, collapse chevron, "needs-you" badge) floating just ABOVE
   the frame's own top edge (fix/canvas-title-float — see this file's own
   `canvas-zone-header` doc comment for the full rationale). Collapsed: a
   compact chip (name + status ring + counts), matching the cockpit's own
   "calm" idle-row treatment (ProjectRow.tsx's zero-mission branch) in
   spirit — a project with nothing happening should read as quiet, not
   loud.

   scratch/_canvas-label-design.md §3.1 ("plaque nom-d'abord") — the
   floating plaque above USED TO also carry the running-count chip and the
   approval-mode badge, taxing the plaque's own contre-scaled budget before
   a single character of the NAME was drawn (that design doc's own root
   cause C: "le chrome passe avant le nom" — at the fit zoom a real 8-zone
   profile lands on, that tax alone left a NEGATIVE budget for the name,
   which is why headers rendered "uc"/"Laz" instead of a real name). Those
   two badges, plus the report-icon button and the urgent-count badge, now
   render in `ZoneHeaderBand` below instead — a normal in-flow strip INSIDE
   the frame (the existing `ZONE_HEADER_HEIGHT` top content-inset,
   previously blank), at CANVAS scale like a mission card — never
   contre-scaled, and per the owner's standing "no semantic zoom" rule,
   never conditionally hidden either: they shrink with the canvas like
   everything else, they just never disappear. The plaque itself now
   carries only: the color dot, the chevron, the NAME, and the "needs-you"
   badge (shown only while count > 0) — "c'est tout" (design doc, verbatim).

   No NodeResizer yet (explicitly deferred — spec: "Resizable later").
*/

import { memo, useState } from 'react';
import { type Node, type NodeProps } from '@xyflow/react';
import type { ProjectNodeData } from '../canvasTypes';
import { useIsAggregateZoom, useHeaderZoomTier, type HeaderZoomTier } from '../chrome/useZoomLevel';
import { ZoneMissionDots } from './ZoneMissionDots';
import { ZoneAggregateSummary } from './ZoneAggregateSummary';
import { useI18n } from '../../../../i18n';
import { emit } from '../../../../lib/bus';
import { formatZoneDigestAge, zoneDigestStatusLabelKey } from '../../../../lib/journal/zoneDigest';
import { useZoneDigest } from '../../../../lib/journal/useZoneDigest';
import { useCanvasActions } from '../chrome/CanvasActionsContext';
import { STAGE_COLORS, STAGE_ORDER } from '../chrome/StageRail';
import { STAGE_LABEL_KEYS } from '../../cockpit/ProjectRow';
import {
  LANE_COLUMN_WIDTH,
  LANE_GUTTER_WIDTH,
  LANE_HEADER_STRIP_HEIGHT,
  ZONE_TITLE_BAND_HEIGHT,
  ZONE_TITLE_GAP_ABOVE,
  ZONE_TITLE_RESERVED_NAME_CHARS,
  ZONE_HEADER_HEIGHT,
  laneColumnX,
} from '../geometry';
// scratch/_canvas-label-design.md §3.1 ("ellipsis MÉDIANE, pas finale") —
// David's real project names are distinguished by their own SUFFIX
// (`uc-smoke-b` vs `uc-smoke-c` vs `uc-smoke-2026-08-12`) — an END-ellipsis
// (the former `lazyManager/truncateLabel.ts` import here) destroys exactly
// that discriminating tail once a name needs truncating. See
// `lib/truncateMiddle.ts`'s own header for the full rationale and why this
// is a NEW, separate module rather than a move/rename of that other file.
import { truncateMiddle } from '../../../../lib/truncateMiddle';
import { TRANSVERSE_PROJECT_ID } from '../reconciler';
import { useAgentsStoreOptional } from '../../agentsStore';
import { ApprovalModeBadge } from '../chrome/ApprovalModeBadge';
import { ApprovalModePopover } from '../chrome/ApprovalModePopover';

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type ProjectFlowNode = Node<ProjectNodeData & Record<string, unknown>, 'project'>;

/** `hsl(H, S%, L%)` -> `hsl(H S% L% / alpha)` (CSS Color 4 syntax) for a
 *  low-alpha tint of the deterministic project color (canvasTypes.ts's
 *  `projectColor()`), without needing a color-parsing dependency. Falls
 *  back to the color as-is if it isn't the expected `hsl(...)` shape (e.g.
 *  a future non-hsl color source) — never throws on an unexpected string. */
function withAlpha(color: string, alpha: number): string {
  const match = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(color);
  if (!match) return color;
  const [, h, s, l] = match;
  return `hsl(${h} ${s}% ${l}% / ${alpha})`;
}

function statusRingColor(counts: ProjectNodeData['counts']): string {
  if (counts.urgent > 0 || counts.failed > 0) return 'var(--color-danger)';
  if (counts.running > 0) return 'var(--color-success)';
  return 'var(--color-text-disabled)';
}

/**
 * Lane-mode guides (spec §4.3 CRITICAL 4): a left-gutter separator plus 5
 * PLAN/CODE/TEST/REVUE/MERGE column headers + vertical separators, laid out
 * with the EXACT same x/y offsets `layout.ts`'s `laneLayout` positions
 * nodes at (`geometry.ts`'s `laneColumnX`/`LANE_GUTTER_WIDTH`/
 * `ZONE_HEADER_HEIGHT` — single source of truth, see that module's
 * header). Positioned in the SAME coordinate space as the zone's children
 * (absolute, origin at the zone's own top-left) — `top: ZONE_HEADER_HEIGHT +
 * ZONE_TITLE_BAND_HEIGHT` so the guides start right below the zone's own
 * small top content-inset, matching `reconcilerZones.ts`'s `gridSlotPosition`
 * exactly (both read the identical constants).
 *
 * fix/canvas-title-float — this offset is now just the plain resting
 * `ZONE_HEADER_HEIGHT` (36 + 0 today, see `ZONE_TITLE_BAND_HEIGHT`'s own
 * geometry.ts doc comment): the zone's own title/identity row no longer
 * renders INSIDE this frame at all — it floats ABOVE the frame's top edge
 * (this file's own `canvas-zone-header`, now `position: absolute`) — so
 * these guides no longer need to dodge an in-frame header that can grow
 * live with dezoom; they simply start right below the zone's real top edge,
 * same as every real mission-card child. Still a FIXED constant (never a
 * function of the live zoom) for the same reason as before: a persisted
 * child position must never move mid zoom-gesture.
 * Purely decorative: `pointerEvents: 'none'`, never intercepts a
 * click/drag on the real node cards React Flow renders on top.
 */
function LaneGuides({ color }: { color: string }) {
  const { t } = useI18n();
  return (
    <div
      data-testid="project-lane-guides"
      style={{ position: 'absolute', left: 0, right: 0, top: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT, bottom: 0, pointerEvents: 'none' }}
    >
      <div
        data-testid="lane-guide-gutter-separator"
        style={{ position: 'absolute', left: LANE_GUTTER_WIDTH, top: 0, bottom: 0, width: 1, background: withAlpha(color, 0.2) }}
      />
      {STAGE_ORDER.map((stage, index) => (
        <div key={stage} style={{ position: 'absolute', left: laneColumnX(index), top: 0, width: LANE_COLUMN_WIDTH, height: '100%' }}>
          <div
            data-testid={`lane-header-${stage}`}
            style={{
              height: LANE_HEADER_STRIP_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              padding: '0 10px',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: STAGE_COLORS[stage],
            }}
          >
            {t(STAGE_LABEL_KEYS[stage])}
          </div>
          {index < STAGE_ORDER.length - 1 && (
            <div
              style={{ position: 'absolute', left: LANE_COLUMN_WIDTH, top: 0, bottom: 0, width: 1, background: withAlpha(color, 0.15) }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// fix/canvas-zone-name-flex-ellipsis — the two LOCAL-unit width estimates
// that used to live here (NEEDS_YOU_BADGE_NATURAL_PX = 165, the needs-you
// badge + gap reservation; MIN_ZONE_NAME_READABLE_PX = 120, the name's
// readability floor) fed the name span's old
// `maxWidth: max(FLOOR, calc(width/lodScale - CHROME))` clamp, which is now
// RETIRED: measured live (getBoundingClientRect probe over 8 real zones at
// 26% viewport zoom), the floor overrode the honest budget on narrow zones —
// the span painted past the header box and the header's overflow:hidden did
// a SILENT hard cut ("lazy-backoffice" on screen as "lazy-backo", no
// ellipsis) — and the chrome estimate itself (ZONE_TITLE_CHROME_WIDTH_PX)
// under-counted real leading chrome ≈ 2×. The name span now shrinks against
// the header's REAL width via flexbox (min-width:0 + flex-shrink on the span
// only; badges keep flex-shrink:0), so no width estimate participates in
// layout any more and every cut is announced by the span's own
// text-overflow:ellipsis. geometry.ts's zoneMinWidthForTitle still sizes
// ZONES so the reserved-chars budget fits at practical zoom — that is now
// the only place these magnitudes matter.

/**
 * Attention-hierarchy wave 1 (founder brief, verbatim: "je dois voir pour
 * tout ce qui travaille, en un coup d'oeil sur le canva je dois tout
 * comprendre" — ranked answer to "what must be understood at a glance":
 * (b) WAITING FOR HIM ranks ABOVE (a) RUNNING, because it needs a human
 * decision RIGHT NOW while "running" needs nothing from the user at all).
 * `count` is `counts.review + counts.failed` — a mission sitting in review
 * (merge/reject decision pending) or failed (retry decision pending) is
 * "waiting for you" in exactly the sense the brief means; `counts.done` and
 * `counts.running` are deliberately excluded (neither needs a human right
 * now). Reuses `--canvas-state-review` verbatim (the SAME amber the
 * per-node review ring already uses — chrome/nodeChrome.tsx's
 * `statusAccentColor`) rather than inventing a new color, so this badge
 * reads as "the same signal, one level up" instead of a competing palette.
 * Placed FIRST among the identity cluster's secondary badges (ahead of the
 * running-count chip below) and — like that chip, unlike the urgent badge —
 * INSIDE the LOD-scaled identity span, so it survives dezoom exactly like
 * the title (W-CARDS: no semantic zoom, this is never hidden, only ever
 * demoted by contrast/position when absent).
 */
function NeedsYouBadge({ count }: { count: number }) {
  const { t } = useI18n();
  return (
    <span
      data-testid="project-node-needs-you-badge"
      title={t('canvas.node.projectNeedsYouAriaLabel', { count })}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        fontWeight: 700,
        color: 'var(--canvas-state-review)',
        background: 'color-mix(in srgb, var(--canvas-state-review) 16%, transparent)',
        border: '1px solid color-mix(in srgb, var(--canvas-state-review) 40%, transparent)',
        borderRadius: 5,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span
        className="canvas-blink"
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--canvas-state-review)', flexShrink: 0 }}
      />
      {t('canvas.node.projectNeedsYouCount', { count })}
    </span>
  );
}

/**
 * W-UX3 core deliverable 2 — tiny 3-bar equalizer, animated via CSS only
 * (canvas.css's `canvas-zone-equalizer`, staggered per-bar animation-delay)
 * — renders next to the zone header's "N actifs" chip while N>0, the
 * zone-level counterpart to a running mission's own live-action ticker.
 */
function EqualizerIcon() {
  return (
    <span className="canvas-zone-equalizer" data-testid="project-node-equalizer" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** Small bar-chart glyph for the zone header's « Voir le rapport » link —
 *  plain inline SVG, never an emoji (design-system convention, see
 *  chrome/HoverActionStrip.tsx's identical icon set). */
function ReportIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 13V7M8 13V3M13 13V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface ZoneHeaderBandProps {
  projectId: string;
  counts: ProjectNodeData['counts'];
  approvalMode: ProjectNodeData['approvalMode'];
  hasWork: boolean;
  onOpenApprovalBadge: (rect: DOMRect) => void;
}

/**
 * scratch/_canvas-label-design.md §3.1 ("plaque nom-d'abord") / §3.4
 * ("relation visuelle titres / cartes mission") — the zone's in-frame
 * header band: the running-count chip, the approval-mode badge, the
 * « Voir le rapport » button, and the urgent-count badge all USED TO live
 * inside the floating plaque above (`canvas-zone-header`), taxing that
 * contre-scaled cluster's budget before the NAME got a single character —
 * see ProjectGroupNode.tsx's own module header for the full "why" this
 * moved. This band is a normal IN-FLOW strip occupying the zone's existing
 * top content-inset (`ZONE_HEADER_HEIGHT` — previously blank space real
 * children already start below, `reconcilerZones.ts`'s `gridSlotPosition`),
 * rendered at CANVAS scale like a mission card (no `lodScale` transform).
 * Per the owner's standing "no semantic zoom" rule this is never
 * conditionally hidden by zoom tier any more — it shrinks with the canvas
 * at deep dezoom exactly like every other in-frame element, it simply
 * never disappears (§5 point 3's own explicit trade-off: "ils rétrécissent
 * en dézoomant comme les cartes, sans jamais disparaître").
 */
function ZoneHeaderBand({ projectId, counts, approvalMode, hasWork, onOpenApprovalBadge }: ZoneHeaderBandProps) {
  const { t } = useI18n();
  const isRealProject = projectId !== TRANSVERSE_PROJECT_ID;
  return (
    <div
      data-testid="project-node-header-band"
      className="nodrag"
      style={{
        height: ZONE_HEADER_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '0 12px',
      }}
    >
      {/* R11 UI polish (a) — same chip shape/tokens as nodeChrome.tsx's
          MetaChip. W-UX3 core deliverable 2 — the equalizer renders next to
          it while `hasWork` (counts.running > 0). Unconditional on
          `counts.running` itself (an honest "0 actifs" reads better than a
          chip that silently vanishes once the last mission finishes). */}
      <span
        data-testid="project-node-running-count"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
        color: hasWork ? 'var(--color-success)' : 'var(--color-text-muted)',
          background: 'var(--color-panel-3)',
          border: '1px solid var(--color-border-3)',
          borderRadius: 5,
          padding: '1px 6px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {hasWork && <EqualizerIcon />}
        {t('canvas.node.projectActiveCount', { count: counts.running })}
      </span>
      {/* W-MODES-ui — the ONE clickable badge (see ApprovalModeBadge.tsx/
          ApprovalModePopover.tsx's own doc comments). Absent for the
          synthetic Transverse zone (no real project, `approvalMode` is
          never set there). */}
      {approvalMode && (
        <button
          type="button"
          className="nodrag"
          data-testid="project-node-approval-mode-badge-trigger"
          aria-label={t('canvas.zone.approvalMode.badgeAriaLabel')}
          title={t('canvas.zone.approvalMode.badgeAriaLabel')}
          onClick={(e) => {
            e.stopPropagation();
            onOpenApprovalBadge(e.currentTarget.getBoundingClientRect());
          }}
          style={{ display: 'inline-flex', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', flexShrink: 0 }}
        >
          <ApprovalModeBadge mode={approvalMode} testId="project-node-approval-mode-badge" />
        </button>
      )}
      {/* W9 — « Voir le rapport » zone-header link. Not on the synthetic
          Transverse zone (no real project, no real report). */}
      {isRealProject && (
        <button
          type="button"
          className="nodrag canvas-zone-report-btn"
          data-testid="project-node-open-report"
          aria-label={t('canvas.node.openReport')}
          title={t('canvas.node.openReport')}
          onClick={(e) => {
            e.stopPropagation();
            emit('report:open', { projectId });
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            flexShrink: 0,
            border: 'none',
            borderRadius: 4,
            background: 'transparent',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <ReportIcon />
        </button>
      )}
      {counts.urgent > 0 && (
        <span
          data-testid="project-node-urgent-badge"
          style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'var(--color-danger)', color: '#14141C', flexShrink: 0 }}
        >
          {counts.urgent}
        </span>
      )}
    </div>
  );
}

interface EmptyZoneDigestProps {
  projectId: string;
  onOpenMission: (missionId: string) => void;
}

/**
 * Defect #6 fix ("living empty zones"): a project zone with zero CURRENT
 * missions used to render nothing but a single centered "Dépose un agent
 * ici" hint — dead-looking even for a project with a long, real history.
 * This renders the zone's real journal-derived digest instead (last
 * activity, up to 3 recently-finished missions, merged-today count) plus a
 * real launch CTA, falling back to the old bare hint only when the journal
 * genuinely has nothing for this project (or it is the synthetic
 * Transverse zone, which has no real journal project id — same exclusion
 * the report-icon-button above already applies).
 */
function EmptyZoneDigest({ projectId, onOpenMission }: EmptyZoneDigestProps) {
  const { t } = useI18n();
  const isRealProject = projectId !== TRANSVERSE_PROJECT_ID;
  const { digest } = useZoneDigest(isRealProject ? projectId : null);

  const hasDigestContent =
    digest !== null &&
    (digest.lastActivity !== null || digest.recentMissions.length > 0 || digest.mergedTodayCount > 0);

  return (
    <div
      data-testid="project-node-empty-hint"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        overflow: 'hidden',
      }}
    >
      {hasDigestContent && digest ? (
        <>
          {digest.lastActivity && (
            <div data-testid="zone-digest-last-activity" style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              {t('canvas.zone.digest.lastActivity', {
                when: formatZoneDigestAge(digest.lastActivity.atMs, t),
                type: digest.lastActivity.type,
              })}
            </div>
          )}
          {digest.recentMissions.length > 0 && (
            <div data-testid="zone-digest-recent-missions" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {/* fix/canvas-ux R4d (dogfood defect #7, R4c flag) — a mission
                  id can be RECYCLED across generations (missionHistory.ts's
                  own "generation" concept: a retried/re-run mission keeps
                  the same id but is a distinct terminal row), so two ghost
                  rows here can legitimately share the same `missionId`.
                  `lib/journal/zoneDigest.ts`'s `ZoneDigestMission` does not
                  (yet) surface that generation number to key by — this is
                  the documented fallback for that case ("or index-stable
                  composite"): the array's own index is stable across
                  re-renders of the SAME digest (recomputed whole, never
                  reordered in place), so `${missionId}-${index}` is always
                  unique among current siblings even when two entries share
                  an id. Ideal fix is upstream (zoneDigest.ts emitting
                  `generation`, then keying by (missionId, generation)) —
                  out of this file's reach until that lands. */}
              {digest.recentMissions.map((mission, index) => (
                <button
                  key={`${mission.missionId}-${index}`}
                  type="button"
                  className="nodrag"
                  data-testid="zone-digest-mission-row"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenMission(mission.missionId);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11,
                    padding: '4px 6px',
                    borderRadius: 6,
                    border: '1px solid var(--color-border)',
                    background: 'transparent',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--color-text)',
                    }}
                  >
                    {mission.title ?? mission.missionId}
                  </span>
                  <span style={{ flexShrink: 0 }}>{t(zoneDigestStatusLabelKey(mission.terminalType))}</span>
                  <span style={{ flexShrink: 0, opacity: 0.7 }}>{formatZoneDigestAge(mission.atMs, t)}</span>
                </button>
              ))}
            </div>
          )}
          {digest.mergedTodayCount > 0 && (
            <div data-testid="zone-digest-merged-today" style={{ fontSize: 11, color: 'var(--color-success)' }}>
              {t('canvas.zone.digest.mergedToday', { count: digest.mergedTodayCount })}
            </div>
          )}
        </>
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11.5,
            color: 'var(--color-text-disabled)',
            textAlign: 'center',
          }}
        >
          {t('canvas.empty.emptyZone')}
        </div>
      )}
      {isRealProject && (
        <button
          type="button"
          className="nodrag"
          data-testid="zone-digest-launch-agent"
          onClick={(e) => {
            e.stopPropagation();
            emit('canvas:launchAgentForProject', { projectId });
          }}
          style={{
            marginTop: 'auto',
            fontSize: 11.5,
            fontWeight: 700,
            padding: '6px 10px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: 'var(--color-accent)',
            color: '#14141C',
          }}
        >
          {t('canvas.zone.digest.launchAgent')}
        </button>
      )}
    </div>
  );
}

interface ProjectGroupNodeCardProps {
  data: ProjectNodeData;
  selected?: boolean;
  /** W-UX3 three-tier fleet view — true below ZOOM_AGGREGATE (the RF
   *  wrapper reads useIsAggregateZoom; a prop here so this pure card stays
   *  directly unit-testable without a live viewport). Renders the
   *  constant-size {@link ZoneAggregateSummary} as ADDITIVE header info —
   *  never a replacement for the zone's real body/children (W-CARDS). */
  aggregate?: boolean;
  /** fix/canvas-header-overflow — how much header chrome the identity
   *  cluster can afford at the current zoom (the RF wrapper reads
   *  useHeaderZoomTier; a prop here for the same direct-unit-testability
   *  reason as `aggregate` above). Defaults to 'full' so every pre-existing
   *  fixture render is unaffected. */
  headerTier?: HeaderZoomTier;
  /** fix/canvas-header-overflow — this node's own current flow-space width
   *  (React Flow's `width` node prop, set verbatim from
   *  reconcilerZones.ts's computed zone `size`). fix/canvas-zone-title-overlap
   *  round 2 reinstated an outer clamp against this (`canvas-zone-header`'s
   *  own `maxWidth`/`overflow: hidden` — see its doc comment); fix/canvas-
   *  zone-title-clip additionally bounds the name span's own graceful
   *  ellipsis budget against it (`nameMaxWidthExpr` above). Also read by the
   *  (permanently-unmounted-in-production) {@link ZoneAggregateSummary}
   *  aggregate chip for its own, separate `chipClampMaxWidth`. */
  width?: number;
}

export function ProjectGroupNodeCard({ data, selected, aggregate, headerTier = 'full', width }: ProjectGroupNodeCardProps) {
  const { t } = useI18n();
  const actions = useCanvasActions();
  const agentsStore = useAgentsStoreOptional();
  const { projectId, name, color, collapsed, isActive, counts, hasChildren, laneMode, approvalMode, missions } = data;
  // feat/always-visible-agents — onFocusNode is optional on CanvasActionsValue.
  const handleFocusNode = (ref: string) => actions.onFocusNode?.(ref);
  // W-MODES-ui — the zone-header badge's popover anchor, or null when
  // closed. Only the EXPANDED header wires a click handler that sets this
  // (see ApprovalModeBadge.tsx's own doc comment: the collapsed pill/
  // aggregate chip render the badge as display-only chrome).
  const [modeAnchorRect, setModeAnchorRect] = useState<DOMRect | null>(null);
  // The synthetic Transverse zone's `name` comes from reconciler.ts (a pure,
  // non-React lib module — see canvasTypes.ts's own i18n note on
  // chainValidation.ts's reasonKey convention) as a plain 'Transverse'
  // literal; every REAL project's `name` is already the user's own project
  // name and must never be run through t(). Only the Transverse zone gets
  // the translated `canvas.zone.transverse` label here.
  const displayName = projectId === TRANSVERSE_PROJECT_ID ? t('canvas.zone.transverse') : name;
  // fix/canvas-zone-title-clip-live (coordinator-reported, live packaged app,
  // 36% zoom / 8 real zones: the DOM held every full name — `[data-testid=
  // "project-node-name"]` read "uc-smoke-2026-08-12" verbatim — while the
  // SCREEN showed "uc-sm", no ellipsis, a SILENT clip. Root cause: unit
  // mismatch between where the flow<->screen conversion happens and where
  // the chrome tax gets subtracted.
  //
  // `ZONE_TITLE_CHROME_WIDTH_PX` is a NATURAL/LOCAL (pre-`lodScale`) size —
  // geometry.ts's OWN `zoneMinWidthForTitle` uses it exactly that way:
  // `(chars*charPx + CHROME) * lodScale(...)`, i.e. chrome and chars are
  // summed FIRST, in local units, THEN the whole thing is scaled up. This
  // component used to do the INVERSE operation in the WRONG order:
  // `width - CHROME` (subtracting a LOCAL quantity from `width`, which is an
  // OUTER/on-screen-equivalent quantity) and only THEN divide by scale —
  // the two operations don't commute (`(width-CHROME)/scale !=
  // width/scale-CHROME` for any scale != 1), so at deep dezoom (scale > 1)
  // this systematically under-budgeted the name — worse the smaller the
  // zone. `nameMaxWidthExpr` below fixes the order: divide by scale FIRST
  // (converting `width` into the SAME local coordinate space CHROME already
  // lives in), THEN subtract CHROME — the exact inverse of
  // `zoneMinWidthForTitle`'s own forward formula, expressed as a live CSS
  // `calc()` (scale is a runtime CSS custom property, never known at render
  // time in JS — see chrome/lod.ts's own "one subscription, not one per
  // node" discipline for why this stays a CSS var read, not a new JS zoom
  // subscription). `max(MIN_ZONE_NAME_READABLE_PX, ...)` floors it at a
  // readable ~10-character minimum (see that constant's own doc comment for
  // why the old one-character floor was replaced) so it can never collapse
  // to 0/negative (an invalid CSS width the browser would ignore), nor to
  // an unidentifiable single character. `undefined` `width` (a
  // fixture render with no live zone to bound against) leaves the name
  // unclamped, same as before this fix.
  //
  // The plaque's other LOCAL-unit occupant is the "needs-you" badge
  // (NeedsYouBadge, below) — a variable-width chip (its i18n'd count text,
  // `canvas.node.projectNeedsYouCount`, can run long in some locales, e.g.
  // French "N en attente de vous"), shown only while `needsYouCount > 0`.
  // Unlike the name, it has no ellipsis mechanism of its own (it's a chip,
  // not free text) — if its own width isn't reserved for here too, it can
  // still get silently cut by the OUTER header's `overflow: hidden` even
  // though the NAME itself renders fine (verified live: at 19% canvas zoom
  // with a needs-you badge present, `header.scrollWidth > header.
  // clientWidth` while `nameEl.scrollWidth === nameEl.clientWidth` — the
  // name was never at risk, only the badge's own tail). A conservative,
  // "erring wide" flat local-unit estimate (same discipline as {@link
  // ZONE_TITLE_CHROME_WIDTH_PX} itself) plus its own leading flex gap (8)
  // keeps the name's budget honest about how much room is really left once
  // the badge needs to fit too — same "the name always wins, badges give
  // way first" priority `ZoneHeaderBand`'s own siblings already accept.
  const needsYouCount = counts.review + counts.failed;
  // fix/canvas-zone-name-flex-ellipsis — the old `identityChromeNaturalPx` +
  // `nameMaxWidthExpr` estimate pair that lived here is RETIRED: its 120px
  // floor overrode the honest budget on narrow zones (span painted past the
  // header → silent hard cut, no ellipsis) and ZONE_TITLE_CHROME_WIDTH_PX
  // under-counted real leading chrome ≈ 2×. The name span now shrink-fits
  // against this header's REAL width via flexbox — see the name span's own
  // comment and the header's display:flex note below. No width estimate
  // participates in layout any more.
  // W-UX3 core deliverable 2 — "zone work signal": true while at least one
  // mission is running inside this zone; drives the header equalizer, the
  // border breathing pulse, and the aggregate chip's equalizer.
  const hasWork = counts.running > 0;

  // W-CARDS (product owner, 2026-07-18) — the aggregate tier used to take
  // over an EXPANDED zone's whole render (swapping real children for just
  // this summary chip), relying on canvas.css to hide every individual
  // node underneath. That hid mission cards while zoomed out — the exact
  // bug this retires: an idle-vs-busy `idleZone` read is still useful, but
  // ONLY as ADDITIVE header info layered on top of the zone's real body
  // (below, `{aggregate && <ZoneAggregateSummary ... />}`), never as a
  // replacement for it. A manually-COLLAPSED zone is unaffected either way
  // (it has no real children to lose — checked first, below).
  const idleZone = counts.running === 0 && counts.failed === 0 && counts.review === 0;

  if (collapsed) {
    return (
      <div
        data-testid={`project-node-${projectId}`}
        data-collapsed="true"
        className="nodrag"
        onClick={() => actions.onToggleCollapseProject(projectId, false)}
        style={{
          padding: '6px 12px',
          borderRadius: 20,
          background: withAlpha(color, 0.12),
          border: `1px solid ${withAlpha(color, isActive ? 0.6 : 0.35)}`,
          cursor: 'pointer',
          boxShadow: selected ? '0 0 0 2px var(--color-accent)' : 'none',
        }}
      >
        {/* W-UX3 finding A — the zone label stays readable (~11-12 screen
            px) at any dezoom: see lod.ts's header. `transformOrigin: 'left
            center'` keeps the pill anchored at its own left edge instead of
            growing outward from its center.
            fix/canvas-title-full-name (founder, verbatim: "je veux le titre
            ENTIER tout le temps") — this used to also carry an `overflow:
            hidden` + max-width clamp (`headerClampMaxWidth`) that kept the
            compensation from ballooning past the pill's own fixed footprint
            (COLLAPSED_ZONE_SIZE) at deep dezoom — but that clamp is exactly
            what forced the name span below to ellipsis-truncate down to a
            single letter at low zoom (the same bug class as the EXPANDED
            zone's own floating title — see `canvas-zone-header`'s doc
            comment below for the full story). Removed: `width: max-content`
            below lets this pill grow to fit its own full, untruncated
            content instead — a collapsed pill visually wider than its own
            COLLAPSED_ZONE_SIZE footprint at extreme dezoom is an accepted
            cosmetic trade-off, never a truncated name. */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: 'max-content',
            transform: 'scale(var(--canvas-lod-zone-label-scale, 1))',
            transformOrigin: 'left center',
          }}
        >
          <span data-testid="project-node-status-ring" style={{ width: 8, height: 8, borderRadius: '50%', background: statusRingColor(counts), flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text)', whiteSpace: 'nowrap', flexShrink: 0 }}>{displayName}</span>
          {/* Attention-hierarchy wave 1 — see NeedsYouBadge's own doc
              comment; shown FIRST, even collapsed/at any zoom (feat/
              always-visible-agents already keeps the dot strip visible at
              any zoom on a collapsed zone — this badge follows the same
              rule for the SAME reason: this signal is never hidden). */}
          {needsYouCount > 0 && <NeedsYouBadge count={needsYouCount} />}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {counts.running}/{counts.total}
          </span>
          {counts.urgent > 0 && (
            <span
              data-testid="project-node-urgent-badge"
              style={{ fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--color-danger)', color: '#14141C', whiteSpace: 'nowrap' }}
            >
              {counts.urgent}
            </span>
          )}
          {/* W-MODES-ui — display-only at this tier (see
              ApprovalModeBadge.tsx's doc comment). */}
          {approvalMode && <ApprovalModeBadge mode={approvalMode} testId="project-node-approval-mode-badge" />}
        </span>
        {/* feat/always-visible-agents — collapsed zones show dots at ANY zoom. */}
        <ZoneMissionDots missions={missions ?? []} onFocusNode={handleFocusNode} />
      </div>
    );
  }

  return (
    <div
      data-testid={`project-node-${projectId}`}
      className={hasWork ? 'canvas-zone-active-breathe' : undefined}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        // Design pass — 14 -> 12: closer to the mission/draft card's own
        // 10px radius (chrome/nodeChrome.tsx's CARD_BASE_STYLE) so the zone
        // frame and the cards it contains read as one coherent rounding
        // scale instead of two unrelated values.
        borderRadius: 12,
        // R2b chromePlan §5 — softer zone tint: project hue at ~6% fill,
        // a 1px hue border at ~25% (was 5%/28-50% — close, nudged to the
        // brief's exact values; `isActive` still reads slightly stronger
        // so the active project's zone is still findable at a glance).
        // Design pass — border alpha nudged down again (0.4/0.25 ->
        // 0.32/0.18): a still-legible but visibly quieter zone outline,
        // "epure" per the founder's Cursor/Linear reference rather than a
        // hard-edged rectangle competing with the cards inside it.
        // Visual redo — zone enclosure: 6% fill was invisible on the real
        // canvas (founder's screenshot: children floated on bare black, no
        // read of what belongs to which project). 10% fill + a soft inset
        // wash in the zone's own hue makes the frame read as a CONTAINER
        // while staying quiet enough not to compete with the cards inside.
        background: `linear-gradient(180deg, ${withAlpha(color, 0.11)} 0%, ${withAlpha(color, 0.04)} 100%)`,
        border: `1px solid ${withAlpha(color, isActive ? 0.34 : 0.16)}`,
        boxShadow: selected
          ? '0 0 0 2px var(--color-accent)'
          : `inset 0 1px 0 ${withAlpha(color, 0.14)}, inset 0 0 40px ${withAlpha(color, 0.05)}, 0 8px 24px rgba(0, 0, 0, 0.25)`,
        display: 'flex',
        flexDirection: 'column',
        // Breathing border's own animated color target (canvas.css reads
        // this CSS var, falling back to a fixed violet if absent) — the
        // ZONE's own deterministic color, not a fresh hex, so a busy zone
        // breathes in ITS OWN hue rather than one shared accent for every
        // project.
        ...(hasWork ? { ['--canvas-zone-breathe-color' as string]: withAlpha(color, isActive ? 0.75 : 0.55) } : {}),
      }}
    >
      {/* fix/canvas-title-float (founder, 4th reported occurrence, verbatim:
          "pourquoi je vois des agents sur le titre de la zone projet, je
          peux même pas lire le nom" + the fix he asked for, verbatim: "mets
          le nom et la zone du titre juste AU-DESSUS de la zone") — this row
          (name + its identity row: chevron/dot/count-chip/approval-badge,
          plus the report-button/urgent-badge) is now a FLOATING label
          anchored to this frame's own top-left, positioned entirely OUTSIDE
          the frame's own rectangle (`position: absolute`, no longer an
          in-flow flex child at the top of the box) — see geometry.ts's
          `ZONE_TITLE_BAND_HEIGHT` doc comment for the full "why every prior
          in-frame reservation kept failing".
            - `bottom: calc(100% + ZONE_TITLE_GAP_ABOVE px)` places the row's
              OWN bottom edge `ZONE_TITLE_GAP_ABOVE` (16) flow px above this
              frame's top border, growing UPWARD into open canvas space as
              its own `height` grows (below) — never downward over a real
              child, by construction (nothing below `bottom: 100%+` can ever
              be INSIDE this frame's own box).
            - fix/canvas-title-full-name (founder, verbatim: "je veux le
              titre ENTIER tout le temps" — the FULL project name, always,
              never truncated) — this row USED TO also carry `maxWidth:
              width` (this zone's own live flow-space width), capping its
              on-screen footprint at the frame's own edge. That clamp is
              REMOVED: at low zoom, a narrow zone's width divided by the
              (large) LOD scale factor collapsed the row's available space
              to a few flow px, forcing the name span below to
              ellipsis-truncate down to a single letter ("Transverse" ->
              "T") — the reported bug. `width: 'max-content'` below instead
              sizes this row to whatever its own full, untruncated content
              needs — it can now legitimately grow past its own zone's
              right edge, floating over open canvas. The horizontal
              collision this clamp used to prevent (a title painting over a
              NEIGHBOURING zone's own title/box) is now guarded upstream, in
              the PACKING layer, by a same-row gap wide enough to fit a
              typical-max-length title (geometry.ts's `ZONE_HORIZONTAL_GAP`
              — see that constant's own doc comment for the worked math),
              rather than by truncating the name.
            - the vertical GUARD against a neighbouring zone's own bottom
              edge (this row's worst-case height, at the canvas's real zoom
              floor, landing on the zone ABOVE) lives in the PACKING layer,
              not here: `geometry.ts`'s `ZONE_VERTICAL_GAP` sizes the
              row-to-row gap `reconcilerZones.ts`'s `packAutoPlacedZones`/
              `layout.ts`'s `layoutAll` use to be provably >= this row's own
              worst-case height + its gap-above — see that constant's own
              doc comment for the worked math. */}
      <div
        className="nodrag canvas-zone-header"
        onClick={() => actions.onToggleCollapseProject(projectId, true)}
        style={{
          position: 'absolute',
          left: 0,
          bottom: `calc(100% + ${ZONE_TITLE_GAP_ABOVE}px)`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          // fix/canvas-title-band-zoom — the ONLY zoom-adaptive layout size
          // on the whole canvas (founder's refined W-CARDS rule: "juste le
          // titre et la zone de titre doivent s'adapter"): reads the live
          // CSS var CanvasLodBroadcaster.tsx writes every zoom tick
          // (chrome/lod.ts's `titleBandHeight`, imperative — no React
          // re-render here), falling back to the plain resting
          // `ZONE_HEADER_HEIGHT` when unset (a fixture render outside a live
          // `<ReactFlow>` viewport, e.g. this component's own unit tests).
          // fix/canvas-title-float — grows the row's own flow-space height
          // UPWARD now (this row floats above the frame via `bottom`
          // above), never downward over a real child — capped at
          // `ZONE_TITLE_MAX_FLOW_HEIGHT` (chrome/CanvasLodBroadcaster.tsx),
          // the title's own worst-case footprint the vertical packing gap
          // (`ZONE_VERTICAL_GAP`) is sized against.
          height: `var(--canvas-lod-title-band-height, ${ZONE_HEADER_HEIGHT}px)`,
          flexShrink: 0,
          padding: '0 12px',
          // fix/canvas-zone-title-overlap round 2 (David's measured repro,
          // real packaged app, 12% zoom / 8 zones: two neighbouring headers
          // still overprinted each other — "uc=smokez2(", "Lazy-real-t"
          // colliding with "debounce" — even after the 22-character
          // reserved-name-chars fix. His own diagnosis: that fix was
          // TYPOGRAPHIC (bounds the NAME text's character count) while the
          // invariant that actually matters is GEOMETRIC — "a zone's header
          // must never paint outside its own zone's box, at ANY zoom" — and
          // the character cap alone doesn't bound the BADGES (running-count
          // chip, approval-mode badge), whose own flow-space width is fixed
          // but whose ON-SCREEN footprint still grows with the SAME
          // `lodScale` compensation the name's OWN characters do, at low
          // zoom past what the character-count heuristic accounted for.
          //
          // `maxWidth: width` (this zone's own REAL live flow-space width,
          // `NodeProps.width` threaded through from `ProjectGroupNode`
          // below) + `overflow: hidden` on THIS outer, UNSCALED div is the
          // hard geometric guarantee: this header can never occupy more
          // on-screen width than its own zone's own frame, AT ANY ZOOM,
          // because both this header and its zone scale together under the
          // IDENTICAL React Flow viewport zoom transform — capping this
          // outer box's flow-space width to `width` makes its on-screen
          // width exactly `width * zoom`, i.e. the zone's own on-screen
          // width, by construction. This does NOT reintroduce
          // fix/canvas-title-full-name's OLD "Transverse" -> "T" bug: that
          // bug came from constraining the INNER, `lodScale`-SCALED span's
          // own layout budget (a zone width divided by a large scale factor
          // collapsed to a few px, so the name's OWN text-overflow:ellipsis
          // truncated it aggressively) — here the inner span (below) stays
          // fully UNCONSTRAINED (`width: 'max-content'`), rendering at its
          // full natural size; only THIS outer, untransformed box clips
          // whatever spills past the zone's own real edge. `undefined`
          // width (a fixture render outside a live viewport, e.g. this
          // component's own unit tests) falls back to the pre-existing
          // unbounded behavior — never worse than before this fix for a
          // render this component itself has no zone width to bound
          // against.
          maxWidth: width !== undefined ? `${width}px` : undefined,
          overflow: 'hidden',
          width: 'max-content',
          // fix/canvas-zone-name-flex-ellipsis — this header is now a FLEX
          // container so its identity cluster (below) can SHRINK against the
          // real, final box width instead of a px ESTIMATE of it. History:
          // the name span used to carry `maxWidth: max(FLOOR, calc(width /
          // lodScale - CHROME_ESTIMATE))` — an arithmetic mirror of
          // geometry.ts's zoneMinWidthForTitle. Two compounding defects,
          // measured live at 26% viewport zoom (getBoundingClientRect probe
          // over 8 real zones): (1) the 120px FLOOR overrode the honest
          // budget whenever the zone was narrower than floor+chrome, so the
          // span painted WIDER than this header and this box's own
          // overflow:hidden did a SILENT hard cut — "lazy-backoffice" on
          // screen as "lazy-backo", no ellipsis, indistinguishable from a
          // rendering glitch; (2) CHROME_ESTIMATE (ZONE_TITLE_CHROME_WIDTH_PX)
          // under-counted the real leading chrome (chevron+dot+gaps+padding
          // ≈ 2× the constant), so even floor-less budgets left a residual
          // overflow. Estimates cannot be made exact (padding/gaps live in
          // two coordinate systems joined by a runtime CSS var); flexbox
          // needs no estimates: this box's maxWidth:width is the ONLY
          // geometric constraint, the cluster shrinks to whatever room is
          // REALly left, and the name span — the only shrink-enabled
          // grand-child — ellipsis-truncates exactly at the true boundary.
          // The founder's two hard constraints both hold by construction:
          // "never paint outside the zone" (this maxWidth+overflow:hidden,
          // unchanged) and "any cut must show an ellipsis" (the cut now
          // happens at the name span's OWN text-overflow:ellipsis, never at
          // this box's edge, because the span can always shrink below its
          // content via min-width:0). Content is still truncateMiddle(...)-
          // pre-truncated (JS, char-budget) so the CSS ellipsis is a last
          // resort, and `title` still carries the full name. (The container
          // was ALREADY display:flex — see the top of this style object — so
          // no layout property was added for this fix; the shrink chain is
          // expressed entirely on the cluster span and name span below.)
          // fix/canvas-title-float — a self-contained floating chip (no
          // longer flush against the frame's own top edge, so it no longer
          // shares that edge's rounding/border/divider): same "floating
          // chrome above content" visual language as ZoneAggregateSummary's
          // own aggregate-tier chip (chip background/border/shadow tokens),
          // for visual consistency between this app's two "label floats
          // above its content" treatments.
          border: `1px solid ${withAlpha(color, 0.3)}`,
          borderRadius: 10,
          // Visual redo — the plaque used to be a neutral gray chip that
          // read as DETACHED from the zone it names (screenshot: pills
          // floating over black). Tinting it with the project's own hue at
          // low alpha + the same layered elevation as the mission cards
          // (CARD_BASE_STYLE recipe) visually welds it to its zone.
          background: `color-mix(in srgb, ${color} 14%, var(--color-panel-2))`,
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.45), 0 4px 12px rgba(0,0,0,0.3)',
          cursor: 'pointer',
          // fix/canvas-title-full-name — no `overflow: hidden` any more:
          // this row no longer clamps its own width, so there is nothing
          // left for it to clip — the full name (and its chrome) always
          // paints, never cropped by this box's own edge.
        }}
      >
        {/* W-UX3 finding A — the zone label stays readable (~11-12 screen
            px) at any dezoom: see lod.ts's header. Wraps the plaque's own
            identity cluster (chevron/dot/name/needs-you-badge — see this
            component's own module header for why the count chip/approval
            badge/report button/urgent badge are no longer part of this
            cluster, scratch/_canvas-label-design.md §3.1) so it scales as
            ONE coherent unit/line.

            fix/canvas-zone-title-clip-live (coordinator-reported, live
            packaged app: the DOM held every full name while the SCREEN
            showed a silent, no-ellipsis clip — e.g. "uc-smoke-2026-08-12"
            painted as "uc-sm") — this span used `transform: scale(...)`
            + `transformOrigin: 'left center'` (kept the OUTER header's own
            `overflow: hidden` clip broken, see below). CSS `transform` is
            a PAINT-ONLY operation: it never participates in how an ANCESTOR
            computes a shrink-to-fit size (`width: 'max-content'`, the OUTER
            `canvas-zone-header` div, below) — so that outer div sized
            itself to this span's UNSCALED (pre-transform) layout width,
            while the span then PAINTED at its scaled-up size, which
            overflowed the outer box's own (too-small) clip boundary and got
            silently cut — a self-referential bug, present since this
            span's very first version, that scales EVERY name down to
            roughly `1/scale` of its true content, independent of how wide
            the zone actually is (so widening the zone via
            `zoneMinWidthForTitle`, however correct, could never have fixed
            it on its own).

            Fixed by using `zoom` instead of `transform: scale(...)`: unlike
            `transform`, `zoom` DOES affect layout — an ancestor's
            `width: 'max-content'` correctly measures a `zoom`-ed
            descendant's TRUE rendered size, so the outer div's own
            shrink-to-fit width (and its `maxWidth: ${width}px` +
            `overflow: hidden` clip — below) now bound the SAME thing that
            actually paints, restoring the geometric containment invariant
            ("a header never paints past its own zone's edge") this span's
            own comment already claimed but the `transform` mechanism could
            never deliver. `zoom` has no `transformOrigin` concept (it
            always grows from the normal in-flow position, which for a
            `display:flex` row anchored at the header's own left edge is
            exactly the same "grows rightward from the left" behavior the
            removed `transformOrigin: 'left center'` used to express) — so
            that property is dropped, not replaced.
            CanvasLodBroadcaster.tsx keeps writing
            `--canvas-lod-zone-label-scale` every zoom tick regardless
            (unchanged — only the CSS property consuming it here changed),
            and nothing here reads `headerTier` to gate the zoom itself —
            only individual children's mount condition below does.
            fix/canvas-title-full-name (founder, verbatim: "je veux le titre
            ENTIER tout le temps") — this span USED TO also carry `overflow:
            hidden` + a max-width clamp (`headerClampMaxWidth`) meant to
            keep this cluster from "overflowing its own frame and covering a
            neighbour's title" (fix/canvas-header-overflow's own measured
            bug) — but that clamp is what forced the name span below to
            ellipsis-truncate to a single letter at low zoom instead (a
            narrow zone's width divided by the LOD scale factor collapses to
            a few flow px). Removed: `width: 'max-content'` below sizes this
            span to its own full, untruncated content; the neighbour-overlap
            concern the old clamp guarded against is now handled by the
            OUTER header box's own geometric containment (`maxWidth`/
            `overflow: hidden`, below, NOW actually correct — see this
            span's own comment above) plus a small flat same-row packing gap
            (geometry.ts's `ZONE_PACK_HORIZONTAL_GAP_FLOW_PX`) — not by a
            name-length-proportional gap any more (scratch/_canvas-label-
            design.md §3.3).
            W-CARDS: no semantic zoom — the live `ProjectGroupNode` wrapper
            below now hardcodes `headerTier` to `'full'` (see its own doc
            comment), so in the real app every child in this span always
            mounts: the `headerTier !== 'minimal'` gates below are dead
            through a live viewport, kept only so `ProjectGroupNodeCard`
            stays directly unit-testable at each tier
            (canvasNodes.test.tsx) and so a future revert of the hardcoding
            is a one-line change, not a rewrite. */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            // fix/canvas-zone-name-flex-ellipsis — this cluster is now a
            // SHRINKABLE flex child (flex: 0 1 auto) of the header above, so
            // when the header's real width runs out the cluster itself
            // shrinks — and its only shrink-enabled child (the name span,
            // below) ellipsis-truncates at the TRUE boundary. History: this
            // span used `flexShrink: 0` + the name carried a px-ESTIMATED
            // maxWidth (max(120px FLOOR, calc(width/lodScale -
            // CHROME_ESTIMATE))); two compounding defects measured live
            // (getBoundingClientRect probe over 8 real zones at 26% viewport
            // zoom): (1) the floor overrode the honest budget on narrow
            // zones → the name painted past THIS header's edge → silent hard
            // cut ("lazy-backoffice" as "lazy-backo", no ellipsis); (2)
            // ZONE_TITLE_CHROME_WIDTH_PX under-counted the real leading
            // chrome ≈ 2×. Flex needs no estimates: shrink-to-fit against
            // the header's maxWidth:width is exact by construction. The
            // founder's "name always wins" priority is preserved: badges
            // below keep flexShrink: 0 — they give way LAST, never first.
            flex: '0 1 auto',
            minWidth: 0,
            width: 'max-content',
            zoom: 'var(--canvas-lod-zone-label-scale, 1)',
          }}
        >
          {headerTier !== 'minimal' && (
            <span data-testid="project-node-chevron" style={{ fontSize: 10, color: 'var(--color-text-disabled)', flexShrink: 0 }}>▼</span>
          )}
          {headerTier !== 'minimal' && (
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
          )}
          {/* fix/canvas-title-full-name — USED TO be `flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis'`: a flex item
              allowed to shrink below its own content size, truncating with
              an ellipsis once the row ran out of (clamped) space — exactly
              how "Transverse" rendered as a bare "T" at low zoom.

              fix/canvas-zone-title-overlap — REVERSED by explicit product
              direction (David's measured repro, 2026-08-14: at low zoom
              with several zones open, one zone's title/badges paint directly
              over its neighbour's — the SAME class of bug the removed clamp
              used to guard against, just reintroduced by removing it). The
              hard constraint this time is "no adaptive hiding at zoom" — so
              unlike the old `headerClampMaxWidth` (a flow-space CSS clamp
              that got multiplied by the live LOD scale transform, collapsing
              to a few px at low zoom and truncating "Transverse" to "T"),
              this caps the RAW CHARACTER COUNT before the scale transform
              ever applies — a fixed, zoom-INVARIANT reserved region (see
              geometry.ts's ZONE_TITLE_RESERVED_NAME_CHARS doc comment for
              why a character cap is what actually composes correctly with
              `lodScale`, and why a CSS maxWidth here would not). `title`
              carries the full untruncated name for hover/accessibility.

              fix/canvas-zone-title-clip (David's measured repro, round 3:
              with the outer header's geometric containment live, 8 zone
              headers read "uc"/"La"/"de" etc — 2-3 characters, NO ellipsis,
              indistinguishable from each other; his own requirement, both
              halves: "a header must never paint outside its zone AND must
              stay identifiable ... whatever truncation remains must show an
              ellipsis"). The layout half of that fix is geometry.ts's
              `zoneMinWidthForTitle` (guarantees this SAME reserved-chars cap's
              worth of content fits at ZONE_SPACING_PRACTICAL_ZOOM and
              above — the zoom real multi-project browsing lands on, not the
              absolute technical floor). This is the graceful-degradation
              half, for the documented residual below that zoom: a REAL CSS
              ellipsis (`overflow: hidden` + `textOverflow: ellipsis`) on
              THIS span specifically — never the outer header box's silent,
              no-indicator hard clip — bounded by `nameMaxWidthExpr` above,
              which reads the SAME live `--canvas-lod-zone-label-scale` CSS
              var this span's own parent cluster already scales by (no new
              JS zoom subscription, matching lod.ts's own "one subscription,
              not one per node" discipline — the browser's `calc()` does the
              division for free, every paint). A no-op whenever the name
              already fits (an ellipsis never visually engages unless
              content truly overflows its own box) — this does NOT
              reintroduce the old `headerClampMaxWidth` "Transverse" -> "T"
              bug: that bug had no width floor at all, so a narrow/empty
              zone's budget could collapse to nothing; `zoneMinWidthForTitle`
              now guarantees a real floor before this ellipsis is ever the
              acting constraint.

              scratch/_canvas-label-design.md §3.1 ("ellipsis MÉDIANE, pas
              finale") — `truncateMiddle` (not `truncateLabel`'s end-ellipsis)
              is what the JS-truncated fallback content below actually uses:
              a real project's discriminating suffix (`-b`/`-c`/a trailing
              date) survives truncation instead of being the first thing cut. */}
          <span
            data-testid="project-node-name"
            title={displayName.length > ZONE_TITLE_RESERVED_NAME_CHARS ? displayName : undefined}
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--color-text)',
              whiteSpace: 'nowrap',
              // fix/canvas-zone-name-flex-ellipsis — the ONLY shrink-enabled
              // item in this row (everything else keeps flexShrink: 0): when
              // the header's real width runs out, THIS span absorbs the
              // shortage and its own text-overflow:ellipsis marks the cut —
              // so a truncation can never again happen silently at an outer
              // box's edge. Replaces the old px-ESTIMATED maxWidth
              // (max(120px FLOOR, calc(width/lodScale - CHROME_ESTIMATE))):
              // its floor overrode the honest budget on narrow zones (span
              // painted past the header → silent hard cut, measured live:
              // "lazy-backoffice" → "lazy-backo") and the chrome constant
              // under-counted real leading chrome ≈ 2×. min-width:0 is the
              // load-bearing property — without it a flex item refuses to
              // shrink below its own content size and no ellipsis ever
              // engages. Readability at small budgets is still guaranteed
              // upstream: geometry.ts's zoneMinWidthForTitle sizes the ZONE
              // so the reserved-chars budget fits at practical zoom, and the
              // CONTENT here is already truncateMiddle(...) — the CSS
              // ellipsis is a boundary-exact last resort, not the primary
              // truncation.
              minWidth: 0,
              flexShrink: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {truncateMiddle(displayName, ZONE_TITLE_RESERVED_NAME_CHARS)}
          </span>
          {/* Attention-hierarchy wave 1 — see NeedsYouBadge's own doc
              comment. scratch/_canvas-label-design.md §3.1 — the ONE badge
              that stays inside the plaque alongside the name ("point de
              couleur + nom + badge needs-you ... c'est tout"): it is the
              single highest-priority signal ("waiting for a human decision
              right now"), so it earns the same contre-scaled, never-hidden
              treatment as the name itself. Every other secondary badge
              (running-count, approval-mode, report button, urgent count)
              moved OUT of this cluster into `ZoneHeaderBand` below. */}
          {needsYouCount > 0 && <NeedsYouBadge count={needsYouCount} />}
        </span>
      </div>
      {/* scratch/_canvas-label-design.md §3.1/§3.4 — the running-count chip,
          approval-mode badge, report button, and urgent badge render here
          now, at canvas scale, INSIDE the frame — see ZoneHeaderBand's own
          doc comment for the full "why" and worked math. */}
      <ZoneHeaderBand
        projectId={projectId}
        counts={counts}
        approvalMode={approvalMode}
        hasWork={hasWork}
        onOpenApprovalBadge={setModeAnchorRect}
      />
      {/* fix/canvas-aggregate-title-band — additive header-info chrome
          while zoomed out far enough to cross ZOOM_AGGREGATE, rendered as a
          NORMAL FLOW sibling AFTER the header above (never absolutely
          overlaid on top of it — see ZoneAggregateSummary.tsx's own header
          comment for the full "why"): the zone's real children (mission
          cards etc., separate React Flow nodes RF positions inside this
          zone's bounds) keep rendering underneath, unaffected — see this
          component's own header comment for why the old "replace the whole
          zone" behavior was retired. */}
      {aggregate && (
        <ZoneAggregateSummary name={displayName} counts={counts} hasWork={hasWork} idle={idleZone} approvalMode={approvalMode} width={width} />
      )}
      {laneMode && hasChildren && <LaneGuides color={color} />}
      {!hasChildren && (
        // Living empty zone (defect #6 fix, spec §5 / W5a deliverable #4b
        // superseded): real journal-derived digest content filling the
        // zone body instead of a single static hint — never a fake node
        // (no id, not selectable, not part of `nodes`/`edges`).
        <EmptyZoneDigest projectId={projectId} onOpenMission={actions.onOpenMission} />
      )}
      {/* W-MODES-ui — portaled outside this card entirely (popoverPosition.ts's
          usePopoverPosition/createPortal, same pattern as
          GateFeedbackPopover.tsx), so it's never clipped by this zone's own
          overflow or scaled by canvas zoom. `approvalMode` is guaranteed
          defined here: `modeAnchorRect` is only ever set by the trigger
          button above, which itself only renders when `approvalMode` is. */}
      {modeAnchorRect && approvalMode && (
        <ApprovalModePopover
          anchorRect={modeAnchorRect}
          currentMode={approvalMode}
          testIdPrefix="zone-approval-mode"
          onClose={() => setModeAnchorRect(null)}
          onSelect={(mode) => {
            void agentsStore?.changeApprovalMode(mode, projectId);
          }}
        />
      )}
    </div>
  );
}

export const ProjectGroupNode = memo(function ProjectGroupNode({ data, selected, width }: NodeProps<ProjectFlowNode>) {
  // W-UX3 three-tier fleet view — Object.is-on-boolean subscription: zone
  // nodes only re-render when the ZOOM_AGGREGATE threshold is crossed, not
  // on every zoom tick (see useIsAggregateZoom's own doc comment).
  // ZOOM_AGGREGATE is now forced to 0 (canvasTypes.ts, W-CARDS: no
  // semantic zoom), so this always resolves to `false` — read straight off
  // the hook (not hardcoded here) so this call site can never drift from
  // that single source of truth.
  const aggregate = useIsAggregateZoom();
  // fix/canvas-header-overflow — same Object.is-on-string subscription
  // discipline, one more threshold pair (see useHeaderZoomTier's own doc
  // comment). `width` is React Flow's own live node width (NodeProps),
  // never re-derived — the same value reconcilerZones.ts's buildProjectNode
  // set as this node's `width` field.
  //
  // W-CARDS: no semantic zoom (founder standing decision, restated
  // verbatim after an earlier wave violated it again — see canvasTypes.ts's
  // ZOOM_AGGREGATE doc comment for the full quote) — a zone header must
  // show its title + count chip + approval badge at EVERY zoom, never
  // reduce to a bare title or drop its secondary badges. The hook is kept
  // subscribed (cheap; a one-line revert if this is ever re-enabled) but
  // its result is no longer trusted here: `headerTier` is hardcoded to
  // `'full'` instead.
  useHeaderZoomTier();
  const headerTier: HeaderZoomTier = 'full';
  return <ProjectGroupNodeCard data={data} selected={selected} aggregate={aggregate} headerTier={headerTier} width={width} />;
});
