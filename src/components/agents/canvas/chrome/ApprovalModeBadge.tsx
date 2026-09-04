/* ApprovalModeBadge.tsx — W-MODES-ui: the compact zone-header mode badge
   (spec: "« Manuel » (neutral), « Auto ✓ » (green accent, auto_green),
   « Full auto » (amber/warning accent, full_auto)").

   Visual sweep #8 — this badge and the global autonomy bar
   (ManagerAutonomyBar.tsx's Manuel/Supervisé/Yolo) are two UNRELATED
   settings that happen to share vocabulary ("manuel", "auto"): this one is
   a PER-PROJECT merge-approval policy (does a passing mission merge itself
   or wait for a human click?); the global bar is the manager's own
   autonomy level (can it act at all without asking?). Read side by side
   they look like the same control at two granularities, which they are
   not. Labels are now prefixed "Merge :" (i18n'd per locale) and the badge
   carries an explanatory tooltip so the distinction is legible without
   having to already know the two systems apart.

   Pure presentational — no click handling, no store access. Rendered at
   all three ProjectGroupNode.tsx tiers (expanded header, collapsed pill,
   aggregate summary chip) so the mode is legible at every zoom, each
   caller already wrapping it in the SAME LOD-scaled container the rest of
   that tier's zone chrome uses (`--canvas-lod-zone-label-scale` /
   `--canvas-lod-chip-scale` — see lod.ts's header) — this component itself
   never touches those vars, it just needs to be small/light enough to sit
   inside them without pushing that chrome's own layout around.

   SAFETY LEGIBILITY (the "mute test", W-MODES-ui deliverable #3): full_auto
   unattended-merges on a genuinely inconclusive evaluation (behind
   approveGate.ts's safety floor) — it must never read as quiet. Colors are
   deliberately ordered by "how much attention does this deserve": manual
   (neutral/muted, nothing to notice), auto_green (green/success, a calm
   "this is fine"), full_auto (amber/warning, the same accent
   nodeChrome.tsx/StageRail.tsx already reserve for "pay attention here" —
   never downgraded to green or muted for this mode).
*/

import type { ApprovalMode } from '../../../../lib/agents/types';
import { useI18n } from '../../../../i18n';

/** i18n keys per mode — exported so the popover selector (same 3 modes,
 *  same copy) reuses the identical label without duplicating the mapping. */
export const APPROVAL_MODE_LABEL_KEY: Readonly<Record<ApprovalMode, string>> = {
  manual: 'canvas.zone.approvalMode.manual',
  auto_green: 'canvas.zone.approvalMode.autoGreen',
  full_auto: 'canvas.zone.approvalMode.fullAuto',
};

/** One-line descriptions for the popover selector's 3 options (spec's exact
 *  copy) — kept alongside the label map since both are indexed the same way. */
export const APPROVAL_MODE_DESC_KEY: Readonly<Record<ApprovalMode, string>> = {
  manual: 'canvas.zone.approvalMode.manualDesc',
  auto_green: 'canvas.zone.approvalMode.autoGreenDesc',
  full_auto: 'canvas.zone.approvalMode.fullAutoDesc',
};

/** Every ApprovalMode, in the fixed display order every selector/badge
 *  should present them (least to most automated) — single source of truth
 *  so the popover never has to re-derive or hand-sort this list. */
export const APPROVAL_MODES: readonly ApprovalMode[] = ['manual', 'auto_green', 'full_auto'];

interface ApprovalModeColors {
  color: string;
  background: string;
  border: string;
}

/** Full_auto is deliberately the LOUDEST (amber/warning) — never the
 *  quietest — see this module's own "mute test" doc comment above. */
function approvalModeColors(mode: ApprovalMode): ApprovalModeColors {
  if (mode === 'auto_green') {
    return {
      color: 'var(--color-success)',
      background: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
      border: 'color-mix(in srgb, var(--color-success) 45%, transparent)',
    };
  }
  if (mode === 'full_auto') {
    return {
      color: 'var(--color-warning)',
      background: 'color-mix(in srgb, var(--color-warning) 24%, transparent)',
      border: 'color-mix(in srgb, var(--color-warning) 60%, transparent)',
    };
  }
  return {
    color: 'var(--color-text-muted)',
    background: 'var(--color-panel-3)',
    border: 'var(--color-border-3)',
  };
}

export interface ApprovalModeBadgeProps {
  mode: ApprovalMode;
  /** Defaults to a generic testid — callers rendering more than one badge
   *  per page (header + collapsed pill + aggregate chip never render
   *  simultaneously for the SAME zone, but a fixture rendering all three
   *  variants side by side for a screenshot harness needs distinct ids). */
  testId?: string;
}

/** The badge itself — a small pill, never bigger than the running-count
 *  chip beside it (ProjectGroupNode.tsx's own `project-node-running-count`,
 *  same font-mono/panel-3/hairline-border shape this deliberately echoes
 *  for manual mode, diverging into color only for the two auto modes). */
export function ApprovalModeBadge({ mode, testId }: ApprovalModeBadgeProps) {
  const { t } = useI18n();
  const colors = approvalModeColors(mode);
  return (
    <span
      data-testid={testId ?? 'approval-mode-badge'}
      data-approval-mode={mode}
      title={t('canvas.zone.approvalMode.badgeTooltip')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 0.2,
        padding: '1px 6px',
        borderRadius: 5,
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-mono)',
        color: colors.color,
        background: colors.background,
        border: `1px solid ${colors.border}`,
      }}
    >
      {t(APPROVAL_MODE_LABEL_KEY[mode])}
    </span>
  );
}
