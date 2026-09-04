/* StageRail.tsx — the mission node's "metro line" (spec §4.3): a
   horizontal 5-stop rail (PLAN CODE TEST REVUE MERGE) reusing
   `deriveFleetStage()` verbatim (never re-derives the stage itself — the
   caller always passes an already-computed `FleetStage`).

   STAGE_COLORS provenance: the existing cockpit grid (AgentGrid.tsx) does
   NOT have a per-stage color palette — it renders every stage label in
   `--color-text-disabled` except the last ("MERGÉ", `--color-success`).
   There is nothing to reuse verbatim, so this module DEFINES the 5-hue
   mapping, but every value is itself an EXISTING design-system.css token
   (no fresh hex) chosen to read as a coherent "cool -> warm -> done"
   progression on the dark theme:
     plan   -> --color-cluster-payment (existing "early/cool" cluster hue)
     code   -> --color-accent          (the app's primary violet — "active")
     test   -> --color-warning         (amber — "evaluating")
     review -> --color-cluster-ui      (pink — visually distinct from both
                                         code's violet and merged's green,
                                         and matches UrgentMissionCard's own
                                         'review' kind using warning-adjacent
                                         but NOT identical to avoid two
                                         stages looking the same)
     merged -> --color-success         (green — matches AgentGrid's existing
                                         "MERGÉ" label color, the one stage
                                         color that already existed)
*/

import type { CSSProperties } from 'react';
import type { FleetStage } from '../../../../lib/agents/fleetStage';
import { STAGE_LABEL_KEYS } from '../../cockpit/ProjectRow';
import { useI18n } from '../../../../i18n';
import { PinGlyph } from './nodeChrome';

export const STAGE_ORDER: readonly FleetStage[] = ['plan', 'code', 'test', 'review', 'merged'];

export const STAGE_COLORS: Record<FleetStage, string> = {
  plan: 'var(--color-cluster-payment)',
  code: 'var(--color-accent)',
  test: 'var(--color-warning)',
  review: 'var(--color-cluster-ui)',
  merged: 'var(--color-success)',
};

export type StageRailVariant = 'compact' | 'full';

interface StageRailProps {
  currentStage: FleetStage;
  variant?: StageRailVariant;
  /** W8c (additive, deliverable #1) — true when this mission's node has at
   *  least one PINNED outgoing chain (see canvasStore's `pinChainOutput`).
   *  Renders a small pin dot next to the rail — the source node's half of
   *  "Pin badge glyph on the edge label + on the source node's stage rail". */
  hasPinnedOutgoing?: boolean;
  /**
   * R2b visual overhaul (stage rail v2, chromePlan §2) — true when the
   * mission's overall liveness is 'failed': the CURRENT stop renders the
   * error treatment (red fill + × glyph) instead of the active pulse ring.
   * Every OTHER stop's done/pending treatment is unaffected — a failure at
   * stage N doesn't retroactively mark stages < N as failed, it only means
   * stage N itself didn't complete cleanly. Absent/false = normal active
   * pulse (the pre-existing behavior, unaffected for every caller that
   * doesn't pass this — e.g. LoopNode/ScheduleNode's compact-only rail).
   */
  currentStageErrored?: boolean;
  /**
   * W-UX3 core deliverable 1 — "stage rail current stop pulse stronger"
   * for a genuinely RUNNING mission (the rail's hero-card counterpart to
   * nodeChrome.tsx's `canvas-node-hero` card elevation). Additive: the
   * existing `canvas-stage-stop-active` pulse (queued/review/etc. at their
   * current stop) is UNCHANGED for every caller that doesn't pass this —
   * only a running mission's current stop gets the bigger/faster variant.
   */
  running?: boolean;
}

const DOT_SIZE_COMPACT = 12;
const DOT_SIZE_FULL_LEGACY = 6;
/** nodeSpec's exact stop size for the v2 'full' rail (28px band). */
const STOP_SIZE_FULL = 14;

/** 8px white check glyph, centered inside a 14px done stop (nodeSpec). */
function CheckGlyph() {
  return (
    <svg width={8} height={8} viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, margin: 'auto' }}>
      <path d="M1.5 5.2 3.8 7.5 8.5 2.5" stroke="#0E0E14" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Small white × glyph for an errored stop (nodeSpec). */
function ErrorGlyph() {
  return (
    <svg width={8} height={8} viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, margin: 'auto' }}>
      <path d="M2 2 8 8M8 2 2 8" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The 5-stop metro line. Past stops (index < current) render filled in the
 * CURRENT stage's color family (a completed step, not "this step's own
 * color" — matches a transit line where passed stops read as "done" rather
 * than each keeping its own hue); the current stop glows in its own stage
 * color; future stops render dim/hollow. `compact` is dots-only (used at
 * MissionNode's compact zoom level); `full` is the v2 28px band (nodeSpec
 * §2): 14px stops, a pulsing ring on the active stop, an 8px checkmark on
 * done stops, a red ring + × on an errored current stop, and the track
 * segment between completed stops filled solid — a left-to-right progress
 * read with no text required.
 */
export function StageRail({ currentStage, variant = 'compact', hasPinnedOutgoing, currentStageErrored, running }: StageRailProps) {
  const { t } = useI18n();
  const currentIndex = STAGE_ORDER.indexOf(currentStage);
  const isFull = variant === 'full';
  const dotSize = isFull ? STOP_SIZE_FULL : DOT_SIZE_COMPACT;
  const currentColor = STAGE_COLORS[currentStage];
  const errorColor = 'var(--canvas-node-error)';

  return (
    <div
      data-testid="stage-rail"
      data-current-stage={currentStage}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        ...(isFull ? { minHeight: 28, justifyContent: 'center' } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: isFull ? 0 : 3 }}>
        {hasPinnedOutgoing && (
          <span data-testid="stage-rail-pin-dot" title={t('canvas.edge.pinned')} style={{ display: 'flex', flexShrink: 0, marginRight: 4 }}>
            <PinGlyph size={14} color="var(--color-text-muted)" />
          </span>
        )}
        {STAGE_ORDER.map((stage, i) => {
          const isPast = i < currentIndex;
          const isCurrent = i === currentIndex;
          const isErrored = isCurrent && currentStageErrored;
          const stopFill = isErrored ? errorColor : isPast || isCurrent ? currentColor : 'transparent';

          const dotStyle: CSSProperties = isFull
            ? {
                width: dotSize,
                height: dotSize,
                borderRadius: '50%',
                flexShrink: 0,
                position: 'relative',
                background: stopFill,
                border: isPast || isCurrent ? 'none' : '1.5px solid rgba(255,255,255,0.25)',
                ['--canvas-stage-pulse-color' as string]: `${isErrored ? errorColor : currentColor}73`,
              }
            : {
                width: dotSize,
                height: dotSize,
                borderRadius: '50%',
                flexShrink: 0,
                position: 'relative',
                background: isPast ? currentColor : isCurrent ? currentColor : 'transparent',
                border: isCurrent || isPast ? 'none' : '1.4px solid var(--color-border)',
                opacity: isPast ? 0.55 : 1,
                ['--canvas-stage-pulse-color' as string]: `${currentColor}73`,
              };

          const stopClassName = isCurrent
            ? (isErrored ? undefined : running ? 'canvas-stage-stop-active canvas-stage-stop-active-running' : 'canvas-stage-stop-active')
            : undefined;
          const tooltip = t(STAGE_LABEL_KEYS[stage]);

          return (
            <span
              key={stage}
              style={{ display: 'flex', alignItems: 'center', gap: isFull ? 0 : 3, flex: i < STAGE_ORDER.length - 1 ? 1 : undefined }}
            >
              <span
                data-testid={`stage-dot-${stage}`}
                data-active={isCurrent}
                data-errored={isErrored || undefined}
                data-done={isPast || undefined}
                title={tooltip}
                className={stopClassName}
                style={dotStyle}
              >
                {isFull && isPast && <CheckGlyph />}
                {isFull && isErrored && <ErrorGlyph />}
              </span>
              {i < STAGE_ORDER.length - 1 && (
                <span
                  style={{
                    flex: 1,
                    height: isFull ? 2 : 1,
                    background: isPast ? currentColor : isFull ? 'rgba(255,255,255,0.12)' : 'var(--color-border-3)',
                    opacity: isPast ? (isFull ? 1 : 0.4) : 1,
                    minWidth: 4,
                  }}
                />
              )}
            </span>
          );
        })}
      </div>
      {variant === 'full' && (
        <span
          data-testid="stage-rail-label"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: 1,
            color: currentColor,
            textTransform: 'uppercase',
          }}
        >
          {t(STAGE_LABEL_KEYS[currentStage])}
        </span>
      )}
    </div>
  );
}

// Re-exported so callers that only imported the legacy dot size keep
// compiling (nothing in this repo currently does, but the constant was
// technically part of this module's public surface before this rewrite).
export { DOT_SIZE_FULL_LEGACY };
