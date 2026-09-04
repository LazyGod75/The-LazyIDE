/* useOnboarding — first-run detection hook, keyed per authenticated account.

   The "onboarded" flag is namespaced by user id (`lazy.onboarded:<userId>`) so a
   brand-new account on an already-onboarded machine still sees onboarding, and a
   returning account is never re-onboarded. The flag is written ONLY when the user
   finishes or explicitly skips — never merely on mount. Onboarding is gated to the
   desktop build with a resolved user (never auto-opens on the public web demo).
*/

import { useState, useCallback, useEffect } from 'react';
import type { User } from '@supabase/supabase-js';
import { useAuth } from '../../lib/auth/useAuth';
import { isTauri } from '../../lib/platform';

const LS_PREFIX = 'lazy.onboarded';
// A signup is considered "new" when the account was created very recently. This
// ONLY drives the Welcome step's greeting copy ("Welcome" vs "Welcome back") —
// it must NOT gate which onboarding steps render. Whether the full wizard
// (Model + Brain steps) or a condensed one shows is decided by first-run-on-
// -device (the same "no local onboarded flag yet" signal behind showOnboarding
// below), not by account age: an existing account installing Lazy on a new
// machine is a first run on THIS device and must still see the Brain step.
const NEW_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

function keyFor(userId: string): string {
  return `${LS_PREFIX}:${userId}`;
}

function readOnboarded(userId: string): boolean {
  try {
    return localStorage.getItem(keyFor(userId)) === '1';
  } catch {
    return true; // If storage is unavailable, don't block the user.
  }
}

function writeOnboarded(userId: string): void {
  try {
    localStorage.setItem(keyFor(userId), '1');
  } catch {
    // localStorage unavailable — silently ignore.
  }
}

/** Clear the onboarding flag. With a userId, clears that account; otherwise
    clears the legacy global flag and every per-account flag. */
export function resetOnboarding(userId?: string): void {
  try {
    if (userId) {
      localStorage.removeItem(keyFor(userId));
      return;
    }
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === LS_PREFIX || k?.startsWith(`${LS_PREFIX}:`)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch {
    // Silently ignore.
  }
}

function isRecentSignup(user: User | null): boolean {
  if (!user?.created_at) return false;
  const created = Date.parse(user.created_at);
  return Number.isFinite(created) && Date.now() - created < NEW_ACCOUNT_WINDOW_MS;
}

interface UseOnboardingResult {
  /** True on first run on this device (no local onboarded flag yet) — the
      signal that should decide which onboarding steps render. */
  showOnboarding: boolean;
  completeOnboarding: () => void;
  rerunOnboarding: () => void;
  userEmail: string | null;
  /** Account created < 1h ago. Greeting copy only — do NOT use this to decide
      the step set (see NEW_ACCOUNT_WINDOW_MS comment above). */
  isNewAccount: boolean;
}

export function useOnboarding(): UseOnboardingResult {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Desktop only, and only once an authenticated user is known. Reading happens
  // here (not on every render) and re-evaluates when the account changes.
  useEffect(() => {
    if (!isTauri() || !userId) {
      setShowOnboarding(false);
      return;
    }
    setShowOnboarding(!readOnboarded(userId));
  }, [userId]);

  const completeOnboarding = useCallback(() => {
    if (userId) writeOnboarded(userId);
    setShowOnboarding(false);
  }, [userId]);

  const rerunOnboarding = useCallback(() => {
    if (userId) resetOnboarding(userId);
    setShowOnboarding(true);
  }, [userId]);

  return {
    showOnboarding,
    completeOnboarding,
    rerunOnboarding,
    userEmail: user?.email ?? null,
    isNewAccount: isRecentSignup(user),
  };
}
