/* ZoneAggregateSummary.tsx — the AGGREGATE-tier zone summary chip (extreme
   dezoom, zoom < ZOOM_AGGREGATE), extracted from ProjectGroupNode.tsx (W9
   split, same rationale as reconciler.ts's own W9 split: that file was
   nearing this repo's 800-line file cap). See git history for this
   component's full design rationale (W-UX3 three-tier fleet view /
   fix/canvas-legibility "unified chrome" — David's own 10% capture showed
   "colored dots visible but ANONYMOUS"): project name + per-status counts
   with status-colored + status-glyphed dots + the animated equalizer while
   work runs, at CONSTANT screen size, anchored to the zone's top-left. An
   idle zone stays in the SAME bordered chrome (never a bare label) but
   recedes via opacity.

   W-CARDS (product owner, 2026-07-18) — this now renders ADDITIVELY on top
   of an EXPANDED zone's real mission cards (never a replacement — see
   ProjectGroupNode.tsx's own header for why the old "aggregate tier hides
   every card" behavior was retired) purely as header-info chrome. The
   per-mission dot strip this used to also render here (feat/
   always-visible-agents) is gone: it existed only to compensate for cards
   disappearing at this tier, which no longer happens, so a duplicate dot
   roster next to the now-always-visible real cards would just be
   confusing noise. ZoneMissionDots.tsx itself is unchanged and still used
   by a manually-COLLAPSED zone (ProjectGroupNode.tsx's `collapsed` branch),
   which has no real cards to show at any zoom.

   W-DIGESTFIX (2026-07-18, product owner: "attention à pas tout
   superposé") — W-CARDS's own "additive overlay" design let this chip's
   variable height (up to 4 status lines + approval badge) grow past the
   36px zone header and paint straight over row 0's mission cards at far
   zoom (real-session 20% zoom screenshot). Fixed on two fronts: (1)
   reconcilerZones.ts/layout.ts now reserve a fixed ZONE_AGGREGATE_BAND_
   HEIGHT world-space band below the header, unconditionally (see that
   constant's own doc comment for why "unconditional" beats a smaller but
   zoom-reflowing reservation); (2) this component's own
   AGGREGATE_CHIP_MAX_SCALE caps its LOD compensation so its footprint can
   never outgrow that band even at the canvas's zoom floor. Neither half
   alone is sufficient — the reserved band without the cap still overflows
   at extreme dezoom (the compensation is unbounded-ish, ~10x at the
   floor), and the cap without the band still overlaps a header sized for
   the OLD (uncapped, unreserved) chip.

   fix/canvas-aggregate-title-band (3rd reported occurrence, 2026-07-22) —
   W-DIGESTFIX above only ever reasoned about row 0's REAL mission-card
   children (reconcilerZones.ts's own, separate React Flow node tree). It
   never accounted for THIS component itself: this chip rendered as a
   `position: absolute; top: 6; left: 6` OVERLAY inside the SAME zone
   container ProjectGroupNode.tsx's own 36px header row also occupies —
   i.e. this chip's name/count/approval-badge stack painted directly on
   top of the header's own (always-additive, never-replaced — see
   ProjectGroupNode.tsx's W-CARDS comment) LOD-scaled title, at ANY
   `aggregate` zoom. That is the actual bug behind David's repeated repro
   ("zone titles overlap the count chips / approval badge / '0 actif(s)'
   labels") — the two AGGREGATE_CHIP_MAX_SCALE-capped/reserved-band fixes
   above were both real and necessary, but neither one touched this
   completely separate collision (chip vs. header, not chip vs. row 0).
   Fixed structurally rather than with more magic-number coordination: this
   component's own root is now a plain in-flow block (never absolutely
   positioned), rendered by ProjectGroupNode.tsx AFTER its header row —
   two sequential flow siblings can never occupy the same pixels, by
   construction, so no zoom-dependent offset math is needed to keep them
   apart. The outer element below reserves ZONE_TITLE_BAND_HEIGHT of real
   (untransformed) flow space — the same amount reconcilerZones.ts already
   reserves for row 0 — so a childless zone's real EmptyZoneDigest body
   (which DOES render in this same normal flow, unlike row 0's mission
   cards) still can't start before this chip's own max-scaled footprint
   could reach either (verifies the brief's "Transverse / 0 actif(s)"
   pairing, which is exactly the childless-zone case).

   W-CARDS: no semantic zoom (founder standing decision, canvasTypes.ts's
   ZOOM_AGGREGATE doc comment) — ZOOM_AGGREGATE is forced to 0, so this
   whole component is now PERMANENTLY UNMOUNTED in the live app (its own
   `aggregate` prop is never `true` through a real viewport again). Left
   fully implemented, still directly unit-tested via its own props
   (canvasNodes.test.tsx), for two reasons: a clean one-line revert, and
   because deleting a component that still has direct test coverage would
   be a bigger diff for zero behavior change. Given that permanent
   dormancy, `AGGREGATE_CHIP_MAX_SCALE` below is now a SELF-CONTAINED
   legacy constant instead of being derived from the real (and now much
   smaller) `ZONE_TITLE_BAND_HEIGHT` reservation — see that constant's own
   doc comment for why re-deriving from the shrunk band would silently
   break this file's own math (a scale of 0).
*/

import { useI18n } from '../../../../i18n';
import type { ApprovalMode } from '../../../../lib/agents/types';
import type { ProjectNodeCounts } from '../canvasTypes';
import { ApprovalModeBadge } from '../chrome/ApprovalModeBadge';
import { StatusGlyph, statusAccentColor } from '../chrome/nodeChrome';
import { ZONE_TITLE_BAND_HEIGHT } from '../geometry';

/** This chip's own tallest REAL content (name row + approval-mode badge row
 *  + 4 status lines, plus vertical padding/gaps) at native (scale-1) size —
 *  the number {@link AGGREGATE_CHIP_MAX_SCALE} is derived against (its own
 *  `margin: 6` is accounted for separately, see that constant's doc
 *  comment). A generous estimate (real content measures smaller in every
 *  observed case), not a live measurement — see that constant's own doc
 *  comment for why erring high here is the safe direction. */
const AGGREGATE_CHIP_NATIVE_MAX_HEIGHT = 140;

/**
 * W-CARDS — this component is permanently unmounted in the live app
 * (`ZOOM_AGGREGATE` is forced to 0, see this file's own module header), so
 * the real world-space reservation it would need is no longer this file's
 * concern — `geometry.ts`'s `ZONE_TITLE_BAND_HEIGHT` shrank from 300 to a
 * plain title-protection margin once this chip stopped being the reason it
 * was that big. Re-deriving {@link AGGREGATE_CHIP_MAX_SCALE} from that
 * shrunk constant today would silently floor to `Math.floor(56 / 140) ===
 * 0` — a permanently invisible chip (and a divide-by-zero in this file's
 * own `chipClampMaxWidth` unit tests) — so this is now a SELF-CONTAINED
 * legacy value instead: the exact reservation (300) this component was
 * ORIGINALLY built and tested against, decoupled from the real (shrunk)
 * layout constant on purpose. If this component is ever re-enabled,
 * `ZONE_TITLE_BAND_HEIGHT` (or a new dedicated reservation) must be widened
 * back first — this decoupling is dead-code preservation, not a claim that
 * re-enabling today would be safe as-is.
 */
const AGGREGATE_CHIP_LEGACY_RESERVED_HEIGHT = 300;

/**
 * W-DIGESTFIX — hard ceiling on the shared inverse-zoom compensation
 * (`--canvas-lod-chip-scale`, chrome/lod.ts), LOCAL to this chip only.
 * Uncapped, that compensation grows to a ~10x multiple at the canvas's own
 * zoom floor (chrome/lod.ts's LOD_FLOOR_ZOOM = 0.1, matching CanvasView's
 * minZoom) — comfortably legible, but this chip's WORLD-space footprint
 * would then grow past its own reserved room and back onto row 0's mission
 * cards — the overlap this fix removes. Derived from
 * {@link AGGREGATE_CHIP_LEGACY_RESERVED_HEIGHT} (not a second hardcoded
 * number) so the two constants can never silently drift apart from EACH
 * OTHER: floored, so `AGGREGATE_CHIP_NATIVE_MAX_HEIGHT *
 * AGGREGATE_CHIP_MAX_SCALE` is GUARANTEED <=
 * AGGREGATE_CHIP_LEGACY_RESERVED_HEIGHT (300 / 140 = 2.14, floored to 2;
 * 140 * 2 = 280 <= 300, comfortable margin for the outer band's own
 * `margin: 6` too). Below
 * the zoom where this cap engages, the chip keeps shrinking like any other
 * flow-space element instead of holding a perfectly constant screen size
 * all the way to the floor — a deliberate trade: the "never paints over a
 * card" guarantee wins over maximum legibility at extreme dezoom.
 * Exported (alongside {@link chipClampMaxWidth}) purely so that function's
 * own unit tests can assert the real, live cap value rather than
 * re-deriving a duplicate copy of this arithmetic.
 */
export const AGGREGATE_CHIP_MAX_SCALE = Math.floor(AGGREGATE_CHIP_LEGACY_RESERVED_HEIGHT / AGGREGATE_CHIP_NATIVE_MAX_HEIGHT);

/**
 * fix/canvas-aggregate-title-band — same algebra as chrome/lod.ts's
 * `headerClampMaxWidth`, applied to THIS chip's own (separately capped)
 * `--canvas-lod-chip-scale` instead of the header's `--canvas-lod-zone-
 * label-scale`: setting the pre-scale element's `max-width` to
 * `zoneWidthPx / effectiveScale` guarantees `maxWidth * effectiveScale <=
 * zoneWidthPx` at any live zoom, so this chip's SCALED footprint can never
 * spill past its own zone's right edge either (a narrow single-child zone
 * could otherwise let the fixed 168px guard's post-scale ~336px width
 * spill past a zone barely wider than that). `min(168px, ...)` keeps the
 * pre-existing fixed guard (W-UX3 audit fix #1's own "never sprawling into
 * a neighbour's lane") as a floor on top of this — whichever constraint is
 * tighter wins. Exported for direct unit coverage (see canvasNodes.test.tsx's
 * own `chipClampMaxWidth` describe block, mirroring chrome/lod.ts's
 * `headerClampMaxWidth` test pattern) — pure, no React, safe to test without
 * mounting a component. */
export function chipClampMaxWidth(zoneWidthPx: number): string {
  return `min(168px, calc(${Math.max(0, zoneWidthPx)}px / min(var(--canvas-lod-chip-scale, 1), ${AGGREGATE_CHIP_MAX_SCALE})))`;
}

/** Tiny 3-bar equalizer, animated via CSS only (canvas.css's
 *  `canvas-zone-equalizer`) — a private copy of ProjectGroupNode.tsx's own
 *  identical icon (that file's expanded-header chrome needs it too; kept as
 *  a small duplicated presentational atom rather than introducing a
 *  circular import between the two sibling node files for 8 lines of SVG-
 *  free markup). */
function EqualizerIcon() {
  return (
    <span className="canvas-zone-equalizer" data-testid="project-node-equalizer" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

interface ZoneAggregateSummaryProps {
  name: string;
  counts: ProjectNodeCounts;
  hasWork: boolean;
  idle: boolean;
  /** W-MODES-ui — badge chrome only at this tier (display, never clickable:
   *  see ApprovalModeBadge.tsx's own module header). Absent for the
   *  synthetic Transverse zone. */
  approvalMode?: ApprovalMode;
  /** fix/canvas-aggregate-title-band — this zone's own current flow-space
   *  width (React Flow's `width` node prop, threaded down from
   *  ProjectGroupNode.tsx the same way `headerClampMaxWidth` already reads
   *  it for the header) — see `chipClampMaxWidth`'s own doc comment.
   *  Absent only in a fixture render that doesn't pass it (defensive
   *  fallback: the fixed 168px guard alone, matching pre-fix behavior). */
  width?: number;
}

export function ZoneAggregateSummary({ name, counts, hasWork, idle, approvalMode, width }: ZoneAggregateSummaryProps) {
  const { t } = useI18n();

  const parts: Array<{ key: string; liveness: Parameters<typeof statusAccentColor>[0]; count: number }> = [
    { key: 'running', liveness: 'running', count: counts.running },
    { key: 'failed', liveness: 'failed', count: counts.failed },
    { key: 'review', liveness: 'review', count: counts.review },
    { key: 'done', liveness: 'merged', count: counts.done },
  ];

  return (
    // fix/canvas-aggregate-title-band — outer "band": a plain in-flow
    // block (never `position: absolute`), rendered by ProjectGroupNode.tsx
    // right after its own header row. `minHeight` reserves REAL layout
    // space (this element's own untransformed box) equal to the same
    // ZONE_TITLE_BAND_HEIGHT reconcilerZones.ts already reserves for row
    // 0's real mission-card children, so whatever else renders next in
    // THIS SAME flow (a childless zone's real EmptyZoneDigest body) can
    // never start before this point — see this module's own header comment
    // for the full "why", and for why this component's OWN chip-scale cap
    // ({@link AGGREGATE_CHIP_MAX_SCALE}) is no longer derived from this
    // same (now much smaller) constant — this component never mounts today,
    // so there is no live footprint to actually reach anything.
    <div data-testid="zone-aggregate-summary-band" style={{ position: 'relative', flexShrink: 0, minHeight: ZONE_TITLE_BAND_HEIGHT, pointerEvents: 'none' }}>
      <div
        data-testid="zone-aggregate-summary"
        data-idle={idle ? 'true' : undefined}
        style={{
          transform: `scale(min(var(--canvas-lod-chip-scale, 1), ${AGGREGATE_CHIP_MAX_SCALE}))`,
          transformOrigin: 'top left',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          margin: 6,
          // Bounded so an active chip stays within a readable, predictable
          // footprint (never sprawling into a neighbour's lane) — W-UX3
          // audit fix #1, now ALSO width-clamped to this zone's own live
          // on-screen width (chipClampMaxWidth) — see that function's own
          // doc comment.
          maxWidth: width !== undefined ? chipClampMaxWidth(width) : 168,
          padding: '7px 10px',
          borderRadius: 8,
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-border-3)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
          // fix/canvas-legibility — idle zones stay in the SAME bordered
          // chrome (never vanish to a bare label) but recede via opacity, so
          // the eye still jumps to the working zone without any zone reading
          // as a "ghost" (the QA-flagged inconsistency this fix removes).
          opacity: idle ? 0.55 : 1,
          pointerEvents: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <StatusGlyph liveness={hasWork ? 'running' : 'queued'} size={10} color={idle ? 'var(--color-text-disabled)' : 'var(--color-text-muted)'} />
          {hasWork && <EqualizerIcon />}
          <span
            data-testid={idle ? 'zone-agg-idle' : undefined}
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: idle ? 'var(--color-text-muted)' : 'var(--color-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              // W-UX3 audit fix #1 — CLAMP + truncate: a long zone name
              // (David's « lazy-e2e-soak-scratch-1784236548334 », 211px) ran
              // straight into the neighbouring « Transverse » label at 10%.
              maxWidth: 128,
            }}
          >
            {name}
          </span>
          {counts.urgent > 0 && (
            <span
              data-testid="zone-agg-urgent"
              style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--color-danger)', color: '#14141C', flexShrink: 0 }}
            >
              {counts.urgent}
            </span>
          )}
        </div>
        {approvalMode && (
          <div>
            <ApprovalModeBadge mode={approvalMode} testId="zone-agg-approval-mode-badge" />
          </div>
        )}
        {/* One status per LINE (not one wide row): keeps the chip NARROW —
            adjacent zones' constant-size chips were observed overlapping/
            clipping each other at 10% with the wide single-row variant
            (fleet-10pct harness audit), exactly the anonymity the tier
            exists to fix. An idle zone shows a single honest "0 actifs" line
            instead of every status line at zero (never "0 échecs · 0 en
            revue · ..." noise). */}
        {idle ? (
          <span
            data-testid="zone-agg-idle-count"
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-disabled)' }}
          >
            {t('canvas.zone.agg.idle', { count: 0 })}
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {parts
              .filter((part) => part.count > 0)
              .map((part) => (
                <span key={part.key} data-testid={`zone-agg-${part.key}`} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                  <StatusGlyph liveness={part.liveness} size={9} color={statusAccentColor(part.liveness)} />
                  {t(`canvas.zone.agg.${part.key}`, { count: part.count })}
                </span>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
