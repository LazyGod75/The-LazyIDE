/* UpgradeProPlusButton — Pro (not Pro+) users' in-popover upgrade path.
   Two-step confirm (no separate modal): first click reveals a short
   proration hint, second click actually calls startPlanChange('pro_plus')
   — the existing subscription is charged the prorated difference
   immediately, no checkout redirect. On success the caller's `onUpgraded`
   refreshes the shared subscription state (SubscriptionContext), after
   which the parent's `isPro && !isProPlus` guard stops rendering this
   button — no extra "success" cleanup needed here.
*/

import { useState } from 'react';
import { useI18n } from '../../i18n';
import { startPlanChange } from '../../lib/billing';
import { PopoverButton } from './PopoverButton';

type UpgradeState = 'idle' | 'confirm' | 'pending';

export interface UpgradeProPlusButtonProps {
  /** Called after a successful plan change so the caller can refresh the
   *  shared subscription state (same mechanism AccountChip already uses
   *  for `billing:walletMaybeStale` — see useSubscriptionContext().refresh). */
  onUpgraded: () => void;
}

export function UpgradeProPlusButton({ onUpgraded }: UpgradeProPlusButtonProps) {
  const { t } = useI18n();
  const [state, setState] = useState<UpgradeState>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (state === 'idle') {
      setState('confirm');
      setError(null);
      return;
    }
    setState('pending');
    setError(null);
    const { error: planError } = await startPlanChange('pro_plus');
    if (planError) {
      setError(planError);
      setState('idle');
      return;
    }
    onUpgraded();
    setState('idle');
  }

  const label =
    state === 'pending'
      ? t('account.popover.upgradeToProPlusPending')
      : state === 'confirm'
        ? t('account.popover.upgradeToProPlusConfirm')
        : t('account.popover.upgradeToProPlus');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <PopoverButton testId="upgrade-proplus-btn" onClick={handleClick} disabled={state === 'pending'}>
        {label}
      </PopoverButton>
      {state === 'confirm' && (
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', padding: '0 8px' }}>
          {t('account.popover.upgradeToProPlusHint')}
        </span>
      )}
      {error && (
        <span style={{ fontSize: 10, color: '#FCA5A5', padding: '0 8px' }}>
          {error}
        </span>
      )}
    </div>
  );
}
