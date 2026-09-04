/* HomeKpiBar — full-width KPI summary bar for the Home dashboard.
   Reuses MetricTile, KpiRow, WindowSelector, useUsageMetrics.
   Shows: tokens, cost, missions done, brain tokens saved.
   Self-contained: manages its own time window state.
*/

import { useState } from 'react';
import { useI18n } from '../../i18n';
import {
  KpiRow,
  MetricTile,
  WindowSelector,
  useUsageMetrics,
  formatTokens,
  formatCost,
} from '../metrics';
import type { UsageWindow } from '../../lib/models/usageHistory';
import { useSubscriptionContext, formatCredits } from '../../lib/billing';
import { AccountPopover, useAccountPopoverTrigger } from '../account/AccountPopover';

export function HomeKpiBar() {
  const { t } = useI18n();
  const [timeWindow, setTimeWindow] = useState<UsageWindow>('today');
  const m = useUsageMetrics(timeWindow);
  const { subscription, isPro } = useSubscriptionContext();
  // QA fix (B1): clicking the credits tile opens the SAME AccountPopover as
  // the header AccountChip and the Cockpit KPI tile — shared trigger +
  // popover, not a re-implementation. Unlike the other 3 tiles in this bar
  // (which show usage/consumption for the selected time window), this one
  // shows the account's real credit BALANCE, so its label says "restants"
  // explicitly — no ambiguity between period consumption and balance.
  const { elRef: creditsRef, anchorRect, toggle, close } = useAccountPopoverTrigger<HTMLDivElement>();

  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <h2
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.3)',
            margin: 0,
          }}
        >
          {t('metrics.bannerTitle')}
        </h2>
        <WindowSelector value={timeWindow} onChange={setTimeWindow} />
      </div>
      <KpiRow>
        <MetricTile
          label={t('metrics.tokens')}
          value={formatTokens(m.totalTokens)}
          sub={t('metrics.inOut')}
          sparkline={m.tokenSparkline}
          sparklineColor="#7C5CFF"
        />
        <MetricTile
          label={t('metrics.cost')}
          value={formatCost(m.costUsd)}
          sparkline={m.costSparkline}
          sparklineColor="#FFC76B"
        />
        <MetricTile
          label={t('metrics.missions')}
          value={String(m.missionsCompleted)}
          sub={t('metrics.missionsDone')}
          accent
          sparklineColor="#66E27A"
        />
        <MetricTile
          label={t('metrics.brainSaved')}
          value={formatTokens(m.brainTokensSaved)}
          sub={t('metrics.vsRawContext')}
          accent
          sparklineColor="#66E27A"
        />
        <MetricTile
          label={t('metrics.creditsBalance')}
          value={isPro && subscription ? formatCredits(subscription.credits_remaining_cents) : t('metrics.creditsBalanceFree')}
          sub={isPro && subscription ? t('metrics.creditsBalanceSub') : undefined}
          accent
          sparklineColor="#F6A945"
          onActivate={toggle}
          testId="home-kpi-credits"
          triggerRef={creditsRef}
        />
      </KpiRow>
      {anchorRect && <AccountPopover anchorRect={anchorRect} onClose={close} triggerRef={creditsRef} />}
    </section>
  );
}
