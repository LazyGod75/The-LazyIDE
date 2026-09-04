/* SubscriptionContext — single source of truth for the live subscription.

   Calls useSubscription(user) ONCE at the app root (via SubscriptionProvider,
   mounted by BillingSync in AppShell). This:
     - keeps the managed-backend availability (setManagedAvailability) in sync, and
     - lets any component (e.g. the Omnibar AccountChip) read the subscription
       state without triggering a second Supabase fetch.

   Consumers use useSubscriptionContext(). When no provider is mounted (e.g. in
   isolated tests), it returns a safe, inert default so callers never crash.
*/

import { createContext, useContext } from 'react';
import type { User } from '@supabase/supabase-js';
import { useSubscription, type SubscriptionState } from './useSubscription.js';

const DEFAULT_STATE: SubscriptionState = {
  subscription: null,
  loading: false,
  isPro: false,
  isProPlus: false,
  hasManagedCredits: false,
  refresh: async () => {},
};

const SubscriptionContext = createContext<SubscriptionState | null>(null);

interface SubscriptionProviderProps {
  user: User | null;
  children: React.ReactNode;
}

export function SubscriptionProvider({ user, children }: SubscriptionProviderProps) {
  const state = useSubscription(user);
  return (
    <SubscriptionContext.Provider value={state}>
      {children}
    </SubscriptionContext.Provider>
  );
}

/**
 * Read the shared subscription state. Falls back to an inert default when no
 * provider is mounted so components remain safe to render in isolation.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useSubscriptionContext(): SubscriptionState {
  return useContext(SubscriptionContext) ?? DEFAULT_STATE;
}
