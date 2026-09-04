/* Pro subscription block: renewal, credit banners, top-up, Stripe portal. */

import type { Subscription } from '../../../lib/billing';
import { useI18n } from '../../../i18n';
import { AccountCreditBanners } from './AccountCreditBanners';
import { AccountTopupRow } from './AccountTopupRow';
import type { AccountBilling } from './useAccountBilling';

export function AccountProBilling({
  isProPlus,
  subscription,
  billing,
}: {
  isProPlus: boolean;
  subscription: Subscription | null;
  billing: AccountBilling;
}) {
  const { t } = useI18n();
  const periodEnd = subscription?.current_period_end;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#A78BFF', marginBottom: 4 }}>
        {isProPlus ? t('settings.account.proPlus.active') : t('settings.account.pro.active')}
      </div>
      {periodEnd && (
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          {t('settings.account.renewal')} {new Date(periodEnd).toLocaleDateString()}
        </div>
      )}
      <AccountCreditBanners subscription={subscription} billing={billing} />
      <AccountTopupRow billing={billing} />
      <TaxNote />
      <PortalButton billing={billing} />
    </div>
  );
}

function TaxNote() {
  const { t } = useI18n();
  return (
    <div
      style={{
        fontSize: 11,
        color: 'var(--color-text-muted)',
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
      }}
    >
      {t('settings.billing.taxNote')}
    </div>
  );
}

function PortalButton({ billing }: { billing: AccountBilling }) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <button
        onClick={billing.handlePortal}
        disabled={billing.portalLoading}
        style={{
          alignSelf: 'flex-start',
          padding: '7px 14px',
          background: 'transparent',
          border: '1px solid var(--color-accent-border)',
          borderRadius: 7,
          color: 'var(--color-accent-light)',
          fontSize: 12,
          fontWeight: 500,
          cursor: billing.portalLoading ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
          opacity: billing.portalLoading ? 0.6 : 1,
        }}
      >
        {billing.portalLoading ? '...' : t('settings.billing.manageSub')}
      </button>
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
        {t('billing.manageHint')}
      </span>
    </div>
  );
}
