import { supabase } from '../supabase/client.js';
import { openExternal } from '../platform/openExternal.js';

/** i18n translate function shape — see byokProviders.ts's Translate doc
 *  comment for the shared convention. Optional everywhere: omitting `t`
 *  falls back to the ORIGINAL hardcoded French. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

export async function openBillingPortal(t?: Translate): Promise<{ error: string | null }> {
  return openPortalSession({}, t);
}

/**
 * B31 — "Gérer les sièges": opens the ORG's Stripe billing portal (its
 * subscription's seat quantity is managed there, not via a custom API this
 * wave). Caller must be an org-admin of orgId (enforced server-side by
 * create-portal-session). Honest failure when the org has never checked
 * out a seats subscription (org.stripe_customer_id is null) — surfaces the
 * same 'no_customer' case as the personal portal, worded for a team.
 */
export async function openOrgBillingPortal(orgId: string, t?: Translate): Promise<{ error: string | null }> {
  return openPortalSession({ orgId }, t);
}

async function openPortalSession(body: { orgId?: string }, t?: Translate): Promise<{ error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('create-portal-session', { body });

    if (error) {
      return { error: error.message };
    }

    if (data?.code === 'no_customer') {
      return {
        error: body.orgId
          ? (t
              ? t('billing.portal.noOrgSubscription')
              : "Aucun abonnement Stripe actif pour cette équipe — passez d'abord par « Créer une team » / le paiement des sièges.")
          : (t ? t('billing.portal.noActiveSubscription') : 'Aucun abonnement actif.'),
      };
    }

    if (!data?.url) {
      return { error: t ? t('billing.portal.missingUrl') : 'URL du portail manquante' };
    }

    await openExternal(data.url as string);
    return { error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : (t ? t('billing.portal.unknownError') : 'Erreur inconnue');
    return { error: message };
  }
}
