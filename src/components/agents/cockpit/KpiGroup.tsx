/* KpiGroup — 5 real-data KPI tiles (design §5's bandeau KPI group, extended
   from 4 to 5 per the Wave 2 spec's explicit "crédits restants" card).
   Every number below is derived from a real source — see each tile's
   comment for exactly which one. */

import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useUsageMetrics } from '../../metrics';
import { getCostState, subscribeCost, type CostState } from '../../../lib/models/costStore';
import { useSubscriptionContext, formatCredits } from '../../../lib/billing';
import { AccountPopover, useAccountPopoverTrigger } from '../../account/AccountPopover';
import type { FleetProject } from '../../../lib/agents/fleetMissions';
import { countActiveByModelFamily } from './cockpitHelpers';
import { formatTokenCountShort } from '../../../lib/agents/tokenFormat';

interface KpiTileProps {
  label: string;
  value: string;
  valueColor?: string;
  sub?: string;
  subColor?: string;
  last?: boolean;
  /** QA fix (B1/B16): when set, the tile becomes a real clickable control
   *  (role="button", hover state, keyboard-activatable) instead of a plain
   *  read-only stat. Every caller wires this to a real store/nav primitive —
   *  see KpiGroup's own doc comments per tile; never a placeholder. */
  onClick?: () => void;
  testId?: string;
  /** B1: anchor ref for the credits tile's shared AccountPopover trigger. */
  triggerRef?: React.RefObject<HTMLDivElement | null>;
  /** fix/canvas-ux R9 MAJEUR — native hover tooltip (HTML `title`) making a
   *  tile's real SCOPE explicit (e.g. "mergées" is fleet-wide here vs the
   *  Rapport's per-project equivalent) instead of showing a bare number
   *  that can legitimately diverge from a same-named number elsewhere with
   *  no explanation. */
  tooltip?: string;
}

function KpiTile({ label, value, valueColor, sub, subColor, last, onClick, testId, triggerRef, tooltip }: KpiTileProps) {
  const [hover, setHover] = useState(false);
  const clickable = onClick !== undefined;

  return (
    <div
      ref={triggerRef}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      data-testid={testId}
      title={tooltip}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      onMouseEnter={clickable ? () => setHover(true) : undefined}
      onMouseLeave={clickable ? () => setHover(false) : undefined}
      style={{
        padding: last ? '0 0 0 18px' : '0 18px',
        borderRight: last ? 'none' : '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
        cursor: clickable ? 'pointer' : undefined,
        borderRadius: clickable ? 6 : undefined,
        background: clickable && hover ? 'rgba(124,92,255,0.08)' : undefined,
        outline: 'none',
        transition: clickable ? 'background 0.15s' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: valueColor ?? 'var(--color-text)', fontFamily: 'var(--font-ui)', lineHeight: 1 }}>
          {value}
        </span>
        {sub && (
          <span style={{ fontSize: 13.5, fontWeight: 600, color: subColor ?? 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
            {sub}
          </span>
        )}
      </div>
      <span style={{ fontSize: 11.5, letterSpacing: 1, color: 'var(--color-text-disabled)', fontWeight: 700, whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
  );
}

interface KpiGroupProps {
  projects: FleetProject[];
  pendingDecisions: number;
  /**
   * QA B16 — the other 4 KPI tiles were entirely non-clickable (the 5th,
   * "crédits", is B1's separate scope — see AccountChip.tsx/AccountPopover
   * for that one). Each handler here is optional purely so the
   * screenshot/test harness (cockpit-harness.tsx) can keep mounting
   * KpiGroup without wiring live store/nav primitives — Cockpit.tsx's real
   * render always passes all four. Sensible real targets per tile (owner
   * spec): décisions -> focus the first urgent card; agents -> briefly
   * highlight the running mission cards; mergées -> the real FLUX activity
   * ticker (GlobalFeed.tsx is orphaned/unrouted, see FluxFooter.tsx's doc
   * comment — flashing the live ticker is the honest "history" target,
   * never a fabricated page); brain -> the Brain space.
   */
  onDecisionsClick?: () => void;
  onAgentsClick?: () => void;
  onMergedClick?: () => void;
  onBrainClick?: () => void;
}

export function KpiGroup({ projects, pendingDecisions, onDecisionsClick, onAgentsClick, onMergedClick, onBrainClick }: KpiGroupProps) {
  const { t } = useI18n();
  const metrics = useUsageMetrics('today');
  const { subscription, isPro } = useSubscriptionContext();
  const [cost, setCost] = useState<CostState>(getCostState);
  // QA fix (B1): the credits tile opens the SAME AccountPopover as the
  // header AccountChip — real shared trigger + popover, not a re-implementation.
  const { elRef: creditsRef, anchorRect, toggle, close } = useAccountPopoverTrigger<HTMLDivElement>();

  useEffect(() => subscribeCost(setCost), []);

  const modelCounts = countActiveByModelFamily(projects, ['running']);
  const activeCount = modelCounts.sonnet + modelCounts.haiku + modelCounts.opus + modelCounts.other;
  const modelChipParts = [
    modelCounts.sonnet > 0 ? t('cockpit.kpi.sonnetCount', { count: modelCounts.sonnet }) : null,
    modelCounts.haiku > 0 ? t('cockpit.kpi.haikuCount', { count: modelCounts.haiku }) : null,
    modelCounts.opus > 0 ? t('cockpit.kpi.opusCount', { count: modelCounts.opus }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
      <KpiTile
        testId="kpi-decisions"
        label={t('cockpit.kpi.decisionsLabel')}
        value={String(pendingDecisions)}
        valueColor={pendingDecisions > 0 ? '#FCD34D' : undefined}
        onClick={onDecisionsClick}
      />
      <KpiTile
        testId="kpi-agents"
        label={t('cockpit.kpi.agentsLabel')}
        value={String(activeCount)}
        sub={modelChipParts.length > 0 ? modelChipParts.join(' · ') : undefined}
        subColor="var(--color-success)"
        onClick={onAgentsClick}
      />
      <KpiTile
        testId="kpi-merged"
        label={t('cockpit.kpi.mergedTodayLabel')}
        value={String(metrics.missionsCompleted)}
        onClick={onMergedClick}
        tooltip={t('cockpit.kpi.mergedTodayScope')}
      />
      <KpiTile
        testId="kpi-brain"
        label={t('cockpit.kpi.brainSavedLabel')}
        value={formatTokenCountShort(cost.totalBrainTokensSaved)}
        valueColor="var(--color-accent-pale)"
        sub={t('cockpit.kpi.brainSavedSub')}
        onClick={onBrainClick}
      />
      <KpiTile
        label={t('cockpit.kpi.creditsLabel')}
        value={isPro && subscription ? formatCredits(subscription.credits_remaining_cents) : t('cockpit.kpi.creditsFree')}
        last
        onClick={toggle}
        testId="cockpit-kpi-credits"
        triggerRef={creditsRef}
      />
      {anchorRect && <AccountPopover anchorRect={anchorRect} onClose={close} triggerRef={creditsRef} />}
    </div>
  );
}
