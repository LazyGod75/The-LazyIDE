/* Low-credit / out-of-credits banners on Settings > Account (Pro). */

import type { Subscription } from '../../../lib/billing';
import { isLowCredit, isOutOfCredits, formatCredits } from '../../../lib/billing';
import { useI18n } from '../../../i18n';
import type { AccountBilling } from './useAccountBilling';

export function AccountCreditBanners({
  subscription,
  billing,
}: {
  subscription: Subscription | null;
  billing: AccountBilling;
}) {
  if (!subscription) return null;
  const remaining = Number(subscription.credits_remaining_cents ?? 0);
  return (
    <>
      <LowCreditBanner remaining={remaining} status={subscription.status} />
      <OutOfCreditsBanner remaining={remaining} status={subscription.status} billing={billing} />
    </>
  );
}

function LowCreditBanner({ remaining, status }: { remaining: number; status: string }) {
  const { t } = useI18n();
  if (!isLowCredit(remaining, status)) return null;
  return (
    <div
      style={{
        padding: '8px 12px',
        background: 'rgba(246,169,69,0.1)',
        border: '1px solid rgba(246,169,69,0.35)',
        borderRadius: 7,
        fontSize: 12,
        color: '#F6A945',
      }}
    >
      {t('settings.billing.lowCredit').replace('{remaining}', formatCredits(remaining))}
    </div>
  );
}

function OutOfCreditsBanner({
  remaining,
  status,
  billing,
}: {
  remaining: number;
  status: string;
  billing: AccountBilling;
}) {
  const { t } = useI18n();
  if (!isOutOfCredits(remaining, status)) return null;
  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'rgba(239,68,68,0.1)',
        border: '1px solid rgba(239,68,68,0.4)',
        borderRadius: 7,
        fontSize: 12,
        color: '#EF4444',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ fontWeight: 600 }}>{t('settings.billing.noCreditsTitle')}</div>
      <div>{t('settings.billing.noCreditsBody')}</div>
      <button
        onClick={() => billing.handleTopup(5)}
        disabled={billing.topupLoading !== null}
        style={{
          alignSelf: 'flex-start',
          padding: '5px 12px',
          background: 'rgba(239,68,68,0.2)',
          border: '1px solid rgba(239,68,68,0.5)',
          borderRadius: 6,
          color: '#EF4444',
          fontSize: 11,
          fontWeight: 600,
          cursor: billing.topupLoading !== null ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {billing.topupLoading !== null ? '...' : t('settings.billing.topupNow')}
      </button>
    </div>
  );
}
