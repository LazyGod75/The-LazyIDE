import { supabase } from '../supabase/client.js';
import { openExternal } from '../platform/openExternal.js';

export async function startTeamsCheckout(
  orgId: string,
  seats: number,
  monthlyCredits: number,
): Promise<{ error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('create-checkout-session-org', {
      body: JSON.stringify({ orgId, seats, monthlyCredits }),
    });

    if (error) {
      return { error: error.message };
    }

    if (!data?.url) {
      return { error: 'URL de paiement manquante' };
    }

    await openExternal(data.url as string);
    return { error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    return { error: message };
  }
}

export async function startTeamsTopup(
  orgId: string,
  amount: number,
): Promise<{ error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('create-checkout-session-org', {
      body: JSON.stringify({ orgId, topup: amount }),
    });

    if (error) {
      return { error: error.message };
    }

    if (!data?.url) {
      return { error: 'URL de paiement manquante' };
    }

    await openExternal(data.url as string);
    return { error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    return { error: message };
  }
}

export async function startProCheckout(plan: 'pro' | 'pro_plus' = 'pro'): Promise<{ error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('create-checkout-session', {
      body: JSON.stringify({ plan }),
    });

    if (error) {
      return { error: error.message };
    }

    if (!data?.url) {
      return { error: 'URL de paiement manquante' };
    }

    await openExternal(data.url as string);
    return { error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    return { error: message };
  }
}

/**
 * Changes the caller's active subscription plan in place (e.g. Pro → Pro+),
 * charging the prorated difference immediately — unlike startProCheckout,
 * this does NOT return a checkout URL to open externally; the edge function
 * mutates the existing subscription and responds with { ok: true, plan }.
 */
export async function startPlanChange(plan: 'pro' | 'pro_plus'): Promise<{ error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('change-plan', {
      body: JSON.stringify({ plan }),
    });

    if (error) {
      return { error: error.message };
    }

    if (!data?.ok) {
      return { error: 'Le changement de forfait a échoué' };
    }

    return { error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    return { error: message };
  }
}

export async function startTopup(amount: number): Promise<{ error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('create-checkout-session', {
      body: JSON.stringify({ topup: amount }),
    });

    if (error) {
      return { error: error.message };
    }

    if (!data?.url) {
      return { error: 'URL de paiement manquante' };
    }

    await openExternal(data.url as string);
    return { error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur inconnue';
    return { error: message };
  }
}
