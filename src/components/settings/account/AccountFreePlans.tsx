/* Free-plan upgrade cards (Pro / Pro+) on Settings > Account. */

import { useI18n } from '../../../i18n';
import type { AccountBilling } from './useAccountBilling';

export function AccountFreePlans({ billing }: { billing: AccountBilling }) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>
        {t('settings.account.freePlan')}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <PlanCard
          title="Pro"
          price="€20"
          credits="2,000"
          extra=""
          plan="pro"
          billing={billing}
        />
        <PlanCard
          title="Pro+"
          price="€60"
          credits="6,000"
          extra={t('settings.billing.topupsIncluded')}
          plan="pro_plus"
          popular
          billing={billing}
        />
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--color-text-muted)',
          padding: '6px 10px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          marginTop: 4,
        }}
      >
        {t('settings.billing.pricesExclTax')} {t('settings.billing.taxNote')}
      </div>
    </div>
  );
}

function PlanCard({
  title,
  price,
  credits,
  extra,
  plan,
  popular,
  billing,
}: {
  title: string;
  price: string;
  credits: string;
  extra: string;
  plan: 'pro' | 'pro_plus';
  popular?: boolean;
  billing: AccountBilling;
}) {
  const { t } = useI18n();
  const busy = billing.checkoutLoading;
  const creditLine = extra
    ? `${credits} ${t('settings.billing.creditsPerMonth')} + ${extra}`
    : `${credits} ${t('settings.billing.creditsPerMonth')}`;
  return (
    <div
      style={{
        flex: '1 1 200px',
        padding: 14,
        background: 'var(--color-panel-3)',
        border: popular ? '1px solid rgba(167,139,255,0.4)' : '1px solid var(--color-border)',
        borderRadius: 8,
        position: 'relative',
      }}
    >
      {popular && <PopularBadge label={t('settings.billing.popular')} />}
      <div style={{ fontSize: 14, fontWeight: 700, color: '#A78BFF', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>
        {price}
        <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--color-text-muted)' }}>
          {t('settings.billing.perMonth')}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 10 }}>
        {creditLine}
      </div>
      <button
        onClick={() => billing.handleCheckout(plan)}
        disabled={busy}
        data-primary="true"
        style={{
          width: '100%',
          padding: '8px 14px',
          background: busy ? 'rgba(124,92,255,0.4)' : 'var(--color-accent)',
          border: 'none',
          borderRadius: 7,
          color: '#fff',
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {busy ? '...' : t('settings.billing.choosePlan').replace('{plan}', title)}
      </button>
    </div>
  );
}

function PopularBadge({ label }: { label: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: -8,
        right: 10,
        padding: '2px 8px',
        background: '#A78BFF',
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 700,
        color: '#fff',
      }}
    >
      {label}
    </div>
  );
}
