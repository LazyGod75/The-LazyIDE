import { useState, useEffect, useCallback, useRef } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../supabase/client.js';
import { setManagedAvailability, setProPlanActive } from '../models/index.js';
import { setPlanTier } from '../entitlements/unifiedEntitlement.js';
import { getUpdaterState } from '../updater.js';
import { loadVersionTelemetryEnabled } from './telemetryPrefs.js';

export interface Subscription {
  id: string;
  status: 'active' | 'canceled' | 'past_due' | 'trialing' | string;
  plan: string;
  current_period_end: string | null;
  credits_included_cents: number;
  credits_remaining_cents: number;
  period_start: string | null;
  period_end: string | null;
}

export interface SubscriptionState {
  subscription: Subscription | null;
  loading: boolean;
  isPro: boolean;
  isProPlus: boolean;
  /** True when Pro is active AND there are credits left to spend. */
  hasManagedCredits: boolean;
  refresh: () => Promise<void>;
}

// ── Version telemetry (AUTOUPDATE-SPEC.md section D) ────────────────
// Piggybacks on this hook's existing per-user sync cadence (mount, window
// focus, SIGNED_IN/TOKEN_REFRESHED/INITIAL_SESSION) instead of opening a
// new network path. Reports which build is running and, once per launch,
// which version this client just auto-updated FROM.

// Injected at build/test time via the `define` block in vite.config.ts /
// vitest.config.ts — same pattern as SettingsSpace.tsx's UpdateSection.
// The literal below is a type-safe last-resort default only.
const APP_VERSION: string = import.meta.env.__APP_VERSION__ ?? '0.1.19';

// Module-level guard: `updated_from` is only meaningful once per app
// launch (Rust's BootAction::UpdateApplied fires at most once at boot),
// but fetchSubscription itself can run many times in the same session —
// look it up at most once so a resolved "no update just applied" isn't
// re-checked on every focus/token-refresh.
let updatedFromChecked = false;

/** Resolves the version this client just auto-updated FROM, at most once
 *  per launch. Returns null outside Tauri, before any update has been
 *  applied, or if the IPC call itself fails (never throws). */
async function resolveUpdatedFromOnce(): Promise<string | null> {
  if (updatedFromChecked) return null;
  updatedFromChecked = true;
  try {
    const state = await getUpdaterState();
    return state?.updateApplied?.fromVersion ?? null;
  } catch (err: unknown) {
    console.warn('[billing/useSubscription] getUpdaterState failed:', err);
    return null;
  }
}

/**
 * Best-effort version ping: reports the running app version (and, once per
 * launch, `updated_from`) via the `record_app_version` RPC — the client no
 * longer has UPDATE rights on `public.profiles` directly (locked down by
 * supabase/migrations/20260724235553_revoke_public_execute_and_lock_profile_writes.sql),
 * so the RPC's SECURITY DEFINER body writes the caller's own row via
 * auth.uid(); no user id is sent on the wire. Fire-and-forget — must never
 * throw or block the billing fetch it runs alongside, and must fire even
 * when the caller has no `subscriptions` row (a free user still needs to
 * report their version). The server stamps `app_version_at` itself. See
 * supabase/migrations/20260724235542_app_version_telemetry.sql for the RPC.
 *
 * User-controllable: gated on loadVersionTelemetryEnabled() (Settings >
 * General — see telemetryPrefs.ts), checked FIRST and synchronously so that
 * when it's off nothing happens at all — no RPC call, no discarded
 * response, and resolveUpdatedFromOnce()'s once-per-launch guard is not
 * even consulted (so re-enabling later in the same session still reports
 * updated_from correctly on the next call).
 */
export async function reportAppVersion(_userId: string): Promise<void> {
  if (!loadVersionTelemetryEnabled()) return;

  // The RPC rejects a version over 32 chars server-side (never truncated
  // client-side) — only guard against sending nothing at all.
  if (!APP_VERSION) return;

  const updatedFrom = await resolveUpdatedFromOnce();

  try {
    const { error } = await supabase.rpc('record_app_version', {
      p_version: APP_VERSION,
      p_updated_from: updatedFrom,
    });
    if (error) {
      console.warn('[billing/useSubscription] reportAppVersion failed:', error.message);
    }
  } catch (err: unknown) {
    console.warn('[billing/useSubscription] reportAppVersion failed:', err);
  }
}

export function useSubscription(user: User | null): SubscriptionState {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(false);

  // Push a DEFINITE answer into the synchronous entitlement bridge
  // (setManagedAvailability/setProPlanActive — see lib/models/index.ts).
  // Called only from fetchSubscription's own settle points (success AND the
  // no-subscription/error/signed-out branches below) — never from a generic
  // effect keyed on derived state, which used to fire on the FIRST render
  // (before the fetch ever ran) with the initial subscription=null values,
  // prematurely settling a real Pro user's plan to "inactive" and causing a
  // false cold-start "pro-inactive" flash (FIX A). Until this is called at
  // least once, the bridge stays at its 'unknown' default.
  const settleEntitlementBridge = useCallback((sub: Subscription | null) => {
    const pro = sub?.status === 'active' || sub?.status === 'trialing';
    const credits = pro && Number(sub?.credits_remaining_cents ?? 0) > 0;
    setManagedAvailability(credits);
    setProPlanActive(pro);
  }, []);

  const fetchSubscription = useCallback(async () => {
    if (!user) {
      // Signed out is a definite answer, not a pending fetch — settle now
      // so a signed-out/free user isn't stuck in the optimistic 'unknown'
      // window forever (they'd otherwise never see the Pro lock).
      setSubscription(null);
      settleEntitlementBridge(null);
      return;
    }
    setLoading(true);
    void reportAppVersion(user.id); // fire-and-forget — see doc comment above
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select(
          'id, status, plan, current_period_end, credits_included_cents, credits_remaining_cents, period_start, period_end',
        )
        .eq('user_id', user.id)
        .single();
      if (!error && data) {
        setSubscription(data as Subscription);
        settleEntitlementBridge(data as Subscription);
      } else {
        // No subscription row (or a query error) is ALSO a definite "not
        // Pro" answer — must settle here too, same reasoning as !user above.
        setSubscription(null);
        settleEntitlementBridge(null);
      }
    } finally {
      setLoading(false);
    }
  }, [user, settleEntitlementBridge]);

  useEffect(() => {
    fetchSubscription(); // eslint-disable-line react-hooks/set-state-in-effect
  }, [fetchSubscription]);

  // Re-fetch on window focus
  useEffect(() => {
    const handler = () => { fetchSubscription(); };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [fetchSubscription]);

  // Re-fetch whenever auth state changes (SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION).
  // This ensures _managedActive is set immediately after sign-in, even when
  // the hook mounts before the session is established or the Supabase token
  // is refreshed in the background.
  const fetchSubscriptionRef = useRef(fetchSubscription);
  useEffect(() => { fetchSubscriptionRef.current = fetchSubscription; }, [fetchSubscription]);
  useEffect(() => {
    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
        fetchSubscriptionRef.current();
      }
    });
    return () => authSub.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isPro =
    subscription?.status === 'active' || subscription?.status === 'trialing';
  const isProPlus = isPro && subscription?.plan === 'pro_plus';
  const hasManagedCredits =
    isPro && Number(subscription?.credits_remaining_cents ?? 0) > 0;

  // Push plan tier to the unified entitlement module so feature gates
  // across the app can read it synchronously without each component
  // independently checking the subscription.
  useEffect(() => {
    setPlanTier(isProPlus ? 'pro_plus' : isPro ? 'pro' : 'free');
  }, [isPro, isProPlus]);

  // NOTE: the managed-backend/entitlement bridge (setManagedAvailability /
  // setProPlanActive) is pushed from fetchSubscription's own settle points
  // above, not from an effect derived from isPro/hasManagedCredits — see
  // settleEntitlementBridge's doc comment for why (that used to fire with
  // the initial null-subscription values before the fetch ever ran).

  return {
    subscription,
    loading,
    isPro,
    isProPlus,
    hasManagedCredits,
    refresh: fetchSubscription,
  };
}
