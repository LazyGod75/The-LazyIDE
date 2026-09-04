/* Credits + usage summary for managed Pro (Settings > Account). */

import { useEffect, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { useI18n } from '../../../i18n';
import { formatCredits } from '../../../lib/billing';
import type { Subscription } from '../../../lib/billing';
import { supabase } from '../../../lib/supabase/client';
import { ACCOUNT_PANEL_STYLE } from './accountPanelStyle';
import {
  EMPTY_USAGE,
  summarizeUsageRows,
  type UsageEventRow,
  type UsageSummary,
} from './creditsUsage';

export function CreditsUsageBlock({
  subscription,
  user,
}: {
  subscription: Subscription;
  user: User;
}) {
  const { t } = useI18n();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const included = Number(subscription.credits_included_cents ?? 0);
  const remaining = Number(subscription.credits_remaining_cents ?? 0);
  const used = Math.max(0, included - remaining);
  const pct = included > 0 ? Math.min(100, (remaining / included) * 100) : 0;

  useEffect(() => {
    let cancelled = false;
    void loadUsage(user.id, subscription.period_start).then((summary) => {
      if (cancelled) return;
      setUsage(summary);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user.id, subscription.period_start]);

  return (
    <div data-testid="credits-block" style={ACCOUNT_PANEL_STYLE}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
        {t('settings.billing.creditsManaged')}
      </div>
      <CreditsRemainingRow remaining={remaining} included={included} />
      <CreditsBar pct={pct} />
      <CreditsPeriodStats used={used} loading={loading} usage={usage} />
    </div>
  );
}

async function loadUsage(
  userId: string,
  periodStart: string | null | undefined,
): Promise<UsageSummary> {
  let query = supabase
    .from('usage_events')
    .select('cost_charged_usd, input_tokens, output_tokens')
    .eq('user_id', userId);
  if (periodStart) query = query.gte('ts', periodStart);
  const { data, error } = await query.limit(1000);
  if (error || !data) return EMPTY_USAGE;
  return summarizeUsageRows(data as UsageEventRow[]);
}

function CreditsRemainingRow({
  remaining,
  included,
}: {
  remaining: number;
  included: number;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
      <span style={{ fontSize: 22, fontWeight: 700, color: '#A78BFF' }}>
        {formatCredits(remaining)}
      </span>
      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        {t('settings.billing.creditsLabel')} {t('settings.billing.creditsRemaining')}
      </span>
      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        / {formatCredits(included)} {t('settings.billing.creditsLabel')} {t('settings.billing.creditsIncluded')}
      </span>
    </div>
  );
}

function CreditsBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        height: 6,
        borderRadius: 3,
        background: 'rgba(255,255,255,0.08)',
        overflow: 'hidden',
        marginBottom: 12,
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: 'var(--color-accent)',
          transition: 'width 0.2s',
        }}
      />
    </div>
  );
}

function CreditsPeriodStats({
  used,
  loading,
  usage,
}: {
  used: number;
  loading: boolean;
  usage: UsageSummary | null;
}) {
  const { t } = useI18n();
  const value = (n: number) => (loading ? '…' : n);
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <Stat label={t('settings.billing.usageConsumed')}>
        {formatCredits(used)} {t('settings.billing.creditsLabel')}
      </Stat>
      <Stat label={t('settings.billing.usageRequests')}>
        {value(usage?.count ?? 0)}
      </Stat>
      <Stat label={t('settings.billing.usageTokens')}>
        {loading ? '…' : (usage?.totalTokens ?? 0).toLocaleString()}
      </Stat>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{children}</div>
    </div>
  );
}
