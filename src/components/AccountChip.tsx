/* AccountChip — Omnibar chip showing the live subscription status.

   Replaces the old ModelChip + CostMeterChip. Shows:
     - Pro active  → a gold "Pro" badge + remaining credit balance (coin icon),
       tinted amber when credits run low.
     - Signed in, no active sub → neutral "Gratuit" + accent "Passer Pro" CTA.
     - Loading with no data yet → nothing (no flash).

   Clicking opens a popover (portal'd to <body>, anchored under the chip) with
   billing actions: upgrade / manage subscription / top up credits / account.
   The popover itself lives in components/account/AccountPopover.tsx — shared
   with every other clickable credit-balance entry point (QA fix B1: Cockpit
   KPI "CRÉDITS" tile, Home dashboard credits tile).
*/

import { useEffect } from 'react';
import { on } from '../lib/bus';
import { useI18n } from '../i18n';
import {
  useSubscriptionContext,
  isLowCredit,
  isOutOfCredits,
  formatCredits,
} from '../lib/billing';
import { AccountPopover, CoinIcon, useAccountPopoverTrigger } from './account/AccountPopover';

const ACCENT = '#7C5CFF';
const GOLD = '#F6A945';

export function AccountChip() {
  const { t } = useI18n();
  const { subscription, loading, isPro, refresh } = useSubscriptionContext();
  const { elRef: chipRef, anchorRect, toggle, close } = useAccountPopoverTrigger<HTMLDivElement>();

  // BUG-3: refresh the shared subscription state when a no_credits wall was
  // just hit or a mission spend just settled (see managedProvider.ts's
  // notifyWalletMaybeStale, already 5s-coalesced there — no extra throttle
  // needed here, well under the 60s polling floor).
  useEffect(() => on('billing:walletMaybeStale', () => { void refresh(); }), [refresh]);

  // B1: other clickable credit surfaces that are NOT adjacent to this header
  // chip (the Team Solo view's "crédits restants" KPI tile) request the
  // account popover by emitting `nav:openAccountPopover` rather than
  // re-implementing it. The header chip is always mounted (TopNav), so it
  // owns the single shared popover instance; opening it here anchors under
  // the chip. Guarded on anchorRect so a repeat event doesn't toggle it shut.
  useEffect(
    () =>
      on('nav:openAccountPopover', () => {
        if (anchorRect === null) toggle();
      }),
    [anchorRect, toggle],
  );

  // Avoid flashing a chip before the first fetch resolves.
  if (loading && !subscription) return null;

  const lowCredit =
    !!subscription && isLowCredit(subscription.credits_remaining_cents, subscription.status);
  const noCredits =
    !!subscription && isOutOfCredits(subscription.credits_remaining_cents, subscription.status);
  const chipCreditColor = noCredits ? '#EF4444' : lowCredit ? GOLD : 'rgba(255,255,255,0.5)';
  const chipCreditTextColor = noCredits ? '#EF4444' : lowCredit ? GOLD : 'rgba(255,255,255,0.55)';

  // Visual sweep #9 — the chip's coin+number ("Pro ⊙ 0") had no tooltip of
  // its own (just the generic "account.chip.label"), so a bare "0" read as
  // unexplained rather than as an actual credits balance. Same copy the
  // popover already shows for this exact state (account.popover.*) — one
  // source of truth for "what does this number mean", never a duplicated
  // translation.
  const tooltip =
    isPro && subscription
      ? noCredits
        ? t('account.popover.noCredits')
        : t('account.popover.creditsRemaining', { count: formatCredits(subscription.credits_remaining_cents) })
      : t('account.chip.label');

  return (
    <>
      <div
        ref={chipRef}
        role="button"
        tabIndex={0}
        aria-label={tooltip}
        data-tooltip={tooltip}
        data-testid="account-chip"
        onClick={toggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
        style={{
          background: isPro ? 'rgba(246,169,69,0.10)' : 'rgba(124,92,255,0.10)',
          border: `1px solid ${isPro ? 'rgba(246,169,69,0.32)' : 'rgba(124,92,255,0.28)'}`,
          borderRadius: 8,
          padding: '4px 11px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          transition: 'background 0.15s, border-color 0.15s',
          userSelect: 'none',
          whiteSpace: 'nowrap',
        }}
        onMouseEnter={e => {
          const el = e.currentTarget as HTMLDivElement;
          el.style.background = isPro ? 'rgba(246,169,69,0.18)' : 'rgba(124,92,255,0.18)';
          el.style.borderColor = isPro ? 'rgba(246,169,69,0.5)' : 'rgba(124,92,255,0.45)';
        }}
        onMouseLeave={e => {
          const el = e.currentTarget as HTMLDivElement;
          el.style.background = isPro ? 'rgba(246,169,69,0.10)' : 'rgba(124,92,255,0.10)';
          el.style.borderColor = isPro ? 'rgba(246,169,69,0.32)' : 'rgba(124,92,255,0.28)';
        }}
      >
        {isPro && subscription ? (
          <>
            <span style={{ fontSize: 11, color: GOLD, fontWeight: 700, letterSpacing: '0.02em' }}>
              {t('account.chip.pro')}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <CoinIcon color={chipCreditColor} />
              <span style={{ fontSize: 11, color: chipCreditTextColor, fontWeight: 500 }}>
                {noCredits ? '0' : formatCredits(subscription.credits_remaining_cents)}
              </span>
            </span>
          </>
        ) : (
          <>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontWeight: 500 }}>
              {t('account.chip.free')}
            </span>
            <span style={{ fontSize: 11, color: ACCENT, fontWeight: 600 }}>
              {t('account.chip.goPro')}
            </span>
          </>
        )}
      </div>

      {anchorRect && (
        <AccountPopover anchorRect={anchorRect} onClose={close} triggerRef={chipRef} />
      )}
    </>
  );
}
