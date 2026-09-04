/* AccountPopover — the shared billing popover (upgrade / manage subscription /
   top up credits / account / team). Portal'd to <body>, anchored under
   whatever element triggered it.

   QA fix (B1): extracted out of AccountChip.tsx so every credit-balance
   entry point (the header AccountChip, the Cockpit KPI "CRÉDITS" tile, the
   Home dashboard credits tile) opens the exact SAME popover implementation
   instead of each growing its own copy. Use useAccountPopoverTrigger() to
   wire a new clickable trigger: it owns the anchor ref + open/close state,
   this component renders the popover itself once `anchorRect` is set.
*/

import { useRef, useState, useCallback, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { emit } from '../../lib/bus';
import { useToast } from '../ui';
import { useDismissable } from '../common/useDismissable';
import {
  useSubscriptionContext,
  startProCheckout,
  startTopup,
  openBillingPortal,
  isLowCredit,
  isOutOfCredits,
  formatCredits,
} from '../../lib/billing';
import { PopoverButton } from './PopoverButton';
import { TopupForm } from './TopupForm';
import { UpgradeProPlusButton } from './UpgradeProPlusButton';
// Team button hidden for initial release — team brain transport incomplete.

const GOLD = '#F6A945';

export { PopoverButton };

// ── Coin / credits icon (inline SVG, no emoji) ────────────────────

export function CoinIcon({ color }: { color: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="6.25" stroke={color} strokeWidth="1.4" />
      <path d="M8 4.6v6.8M6.2 6.3h2.6a1.3 1.3 0 0 1 0 2.6H6.2M6.2 8.9h2.8" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Trigger hook — anchors the popover to any clickable element ────

export interface AccountPopoverTrigger<T extends HTMLElement> {
  /** Attach to the element that should open the popover on click. */
  elRef: React.RefObject<T | null>;
  /** Non-null while the popover is open; pass straight through as
   *  AccountPopover's `anchorRect` prop. */
  anchorRect: DOMRect | null;
  /** Click handler: opens on first call, closes on the next (toggle). */
  toggle: () => void;
  close: () => void;
}

export function useAccountPopoverTrigger<T extends HTMLElement = HTMLElement>(): AccountPopoverTrigger<T> {
  const elRef = useRef<T>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const toggle = useCallback(() => {
    setAnchorRect((prev) => (prev ? null : (elRef.current?.getBoundingClientRect() ?? null)));
  }, []);

  const close = useCallback(() => setAnchorRect(null), []);

  return { elRef, anchorRect, toggle, close };
}

// ── Popover ───────────────────────────────────────────────────────

export interface AccountPopoverProps {
  anchorRect: DOMRect;
  onClose: () => void;
  /** Ref to the trigger element (AccountChip.tsx's chip / KpiGroup.tsx's
   *  "CRÉDITS" tile / HomeKpiBar.tsx's credits tile — whichever
   *  useAccountPopoverTrigger() caller opened this popover) — ignored by
   *  the outside-pointerdown handler so re-clicking that same trigger
   *  closes this popover instead of closing-then-reopening it (this
   *  popover is portaled to `document.body`, so the naive listener sees
   *  the trigger as "outside"). See useDismissable.ts's header comment for
   *  the exact race this prevents. Optional so a future caller with no
   *  single stable trigger element doesn't break; omitting it just means
   *  re-clicking falls back to the old (racy) behavior. */
  triggerRef?: RefObject<HTMLElement | null>;
}

export function AccountPopover({ anchorRect, onClose, triggerRef }: AccountPopoverProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { subscription, isPro, isProPlus, refresh } = useSubscriptionContext();
  // Team button hidden for initial release.
  const ref = useDismissable<HTMLDivElement>({
    open: true,
    onClose,
    ignoreRefs: triggerRef ? [triggerRef] : undefined,
  });

  async function runAction(action: () => Promise<{ error: string | null }>) {
    onClose();
    const { error } = await action();
    if (error) toast(error, 'error');
  }

  function openSettings() {
    onClose();
    emit('nav:navigateSpace', 'settings');
  }

  // Team button hidden for initial release — team brain transport incomplete.

  const width = 260;
  const style: React.CSSProperties = {
    position: 'fixed',
    top: anchorRect.bottom + 8,
    left: Math.min(anchorRect.right - width, window.innerWidth - width - 8),
    width,
  };

  const lowCredit =
    !!subscription && isLowCredit(subscription.credits_remaining_cents, subscription.status);
  const noCredits =
    !!subscription && isOutOfCredits(subscription.credits_remaining_cents, subscription.status);
  const creditColor = noCredits ? '#EF4444' : lowCredit ? GOLD : 'rgba(255,255,255,0.5)';
  const creditTextColor = noCredits ? '#EF4444' : lowCredit ? GOLD : 'rgba(255,255,255,0.55)';

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      style={{
        ...style,
        background: '#1C1C2A',
        border: '1px solid rgba(124,92,255,0.3)',
        borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 1000,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
      }}
    >
      {/* Header */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: isPro ? GOLD : 'rgba(255,255,255,0.85)' }}>
            {isPro ? t('account.popover.proActive') : t('account.popover.free')}
          </span>
        </div>
        {isPro && subscription && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6 }}>
            <CoinIcon color={creditColor} />
            <span style={{ fontSize: 11, color: creditTextColor }}>
              {noCredits
                ? t('account.popover.noCredits')
                : t('account.popover.creditsRemaining', { count: formatCredits(subscription.credits_remaining_cents) })}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {!isPro ? (
          <>
            <PopoverButton primary onClick={() => runAction(() => startProCheckout('pro'))}>
              {t('account.popover.upgradePro')}
            </PopoverButton>
            <PopoverButton onClick={() => runAction(() => startProCheckout('pro_plus'))}>
              {t('account.popover.upgradeProPlus')}
            </PopoverButton>
          </>
        ) : (
          <>
            <PopoverButton primary onClick={() => runAction(() => openBillingPortal(t))}>
              {t('account.popover.manage')}
            </PopoverButton>
            {/* QA fix (B2): cancel-subscription discoverability — the portal
                also covers payments/invoices/cancellation, not just plan
                changes; make that explicit instead of leaving it implicit. */}
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', padding: '0 8px', marginTop: -2 }}>
              {t('billing.manageHint')}
            </span>
            {isPro && !isProPlus && (
              <UpgradeProPlusButton onUpgraded={() => { void refresh(); }} />
            )}
            <TopupForm onConfirm={(amount) => runAction(() => startTopup(amount))} />
          </>
        )}
        {/* Team button hidden for initial release. */}
        <button
          onClick={openSettings}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 11,
            fontFamily: 'inherit',
            cursor: 'pointer',
            padding: '6px 8px',
            textAlign: 'left',
            borderRadius: 6,
            transition: 'color 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#D5D8E0'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.4)'; }}
        >
          {t('account.popover.account')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
