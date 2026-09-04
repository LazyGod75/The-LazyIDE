/* paletteBilling.ts — command-palette billing entries (QA fix B7).
   "Passer à Pro" / "Recharger des crédits" / "Gérer l'abonnement" / "Passer
   à Pro+", wired to the exact same plumbing AccountChip's popover uses.
   "topup" and "upgradeProPlus" open the shared AccountPopover (both now
   need an in-popover amount picker / two-step confirm — see
   AccountPopover.tsx's TopupForm/UpgradeProPlusButton) instead of firing a
   checkout directly; "upgradePro" and "manage" still call the real
   Stripe checkout/portal (single-step, no picker needed). Kept in its own
   file so CommandPalette.tsx stays focused on rendering/keyboard-nav rather
   than billing state.
*/

import { startProCheckout, openBillingPortal } from '../../lib/billing';
import { emit } from '../../lib/bus';
import type { PaletteItem } from './paletteItems';

export type BillingCommandAction = 'upgradePro' | 'topup' | 'manage' | 'upgradeProPlus';

/** i18n translate function shape — see lib/billing/portal.ts's Translate
 *  doc comment for the shared convention. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Builds the billing entries shown in the palette's Commandes section.
 *  Mirrors AccountPopover's own conditional layout: free users see
 *  "Passer à Pro"; Pro users see "Recharger des crédits" + "Gérer
 *  l'abonnement", plus "Passer à Pro+" when they aren't on Pro+ yet. */
export function buildBillingCommandItems(
  isPro: boolean,
  isProPlus: boolean,
  t: (key: string, params?: Record<string, string | number>) => string,
): PaletteItem[] {
  if (!isPro) {
    return [
      {
        id: 'cmd-billing-upgrade',
        kind: 'command',
        label: t('palette.command.upgradePro'),
        icon: '★',
        hint: t('palette.command.billingHint'),
        action: { type: 'billing', billingAction: 'upgradePro' },
      },
    ];
  }

  const items: PaletteItem[] = [
    {
      id: 'cmd-billing-topup',
      kind: 'command',
      label: t('palette.command.topup'),
      icon: '+',
      hint: t('palette.command.billingHint'),
      action: { type: 'billing', billingAction: 'topup' },
    },
    {
      id: 'cmd-billing-manage',
      kind: 'command',
      label: t('palette.command.manageSubscription'),
      icon: '⚙',
      hint: t('palette.command.billingHint'),
      action: { type: 'billing', billingAction: 'manage' },
    },
  ];

  if (!isProPlus) {
    items.push({
      id: 'cmd-billing-upgrade-proplus',
      kind: 'command',
      label: t('palette.command.upgradeProPlus'),
      icon: '★',
      hint: t('palette.command.billingHint'),
      action: { type: 'billing', billingAction: 'upgradeProPlus' },
    });
  }

  return items;
}

/** Runs a billing palette command's real action. Returns the same
 *  `{ error }` shape as the underlying checkout/portal calls so the caller
 *  can toast it exactly like AccountPopover does. 'topup'/'upgradeProPlus'
 *  never error here — they just open the popover, which owns the real
 *  amount-picker / confirm flow (and its own error surfacing). */
export async function runBillingCommand(action: BillingCommandAction, t?: Translate): Promise<{ error: string | null }> {
  switch (action) {
    case 'upgradePro': return startProCheckout('pro');
    case 'manage':      return openBillingPortal(t);
    case 'topup':
    case 'upgradeProPlus':
      emit('nav:openAccountPopover', undefined);
      return { error: null };
  }
}
