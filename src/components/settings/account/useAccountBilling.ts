/* Billing actions for Settings > Account (portal, checkout, top-up, sign-out). */

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { startProCheckout, startTopup, openBillingPortal } from '../../../lib/billing';
import { useToast } from '../../ui/Toast';

export function useAccountBilling(signOut: () => Promise<void>) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [topupLoading, setTopupLoading] = useState<number | null>(null);
  const [topupInput, setTopupInput] = useState('');

  return {
    t,
    toast,
    checkoutLoading,
    portalLoading,
    topupLoading,
    topupInput,
    setTopupInput,
    handlePortal: async () => {
      setPortalLoading(true);
      const { error } = await openBillingPortal(t);
      setPortalLoading(false);
      if (error) toast(t('settings.auth.portalError', { error }), 'error');
      else toast(t('settings.auth.portalRedirect'), 'info');
    },
    handleSignOut: async () => {
      await signOut();
      toast(t('settings.auth.signedOut'), 'info');
    },
    handleCheckout: async (plan: 'pro' | 'pro_plus' = 'pro') => {
      setCheckoutLoading(true);
      const { error } = await startProCheckout(plan);
      setCheckoutLoading(false);
      if (error) toast(t('settings.payment.error', { error }), 'error');
      else toast(t('settings.payment.redirect'), 'info');
    },
    handleTopup: async (amount: number) => {
      if (amount < 1 || amount > 500) {
        toast(t('settings.billing.topupRangeError'), 'error');
        return;
      }
      setTopupLoading(amount);
      setTopupInput('');
      const { error } = await startTopup(amount);
      setTopupLoading(null);
      if (error) toast(t('settings.payment.topupError', { error }), 'error');
      else toast(t('settings.payment.topupRedirect'), 'info');
    },
  };
}

export type AccountBilling = ReturnType<typeof useAccountBilling>;
