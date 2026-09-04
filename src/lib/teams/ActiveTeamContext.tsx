/**
 * ActiveTeamContext — single source of truth for hasActiveTeam.
 *
 * Mirrors the pattern of SubscriptionContext: one fetch at the app root,
 * shared via context so any component can read it without a second query.
 *
 * The user's ID (primitive string) is extracted here before being passed
 * to useActiveTeam, preventing object-dep loops.
 */

import { createContext, useContext } from 'react';
import type { User } from '@supabase/supabase-js';
import { useActiveTeam, type ActiveTeamState } from './useActiveTeam.js';

// ── Defaults ──────────────────────────────────────────────────────────

const DEFAULT_STATE: ActiveTeamState = {
  hasActiveTeam: false,
  loading: false,
  refresh: () => {},
};

// ── Context ───────────────────────────────────────────────────────────

const ActiveTeamContext = createContext<ActiveTeamState | null>(null);

// ── Provider ──────────────────────────────────────────────────────────

interface ActiveTeamProviderProps {
  user: User | null;
  children: React.ReactNode;
}

export function ActiveTeamProvider({ user, children }: ActiveTeamProviderProps) {
  // Extract the primitive userId — never pass the User object as a dep.
  const userId: string | null = user?.id ?? null;
  const state = useActiveTeam(userId);

  return (
    <ActiveTeamContext.Provider value={state}>
      {children}
    </ActiveTeamContext.Provider>
  );
}

// ── Consumer ──────────────────────────────────────────────────────────

/**
 * Read the shared active-team state.
 * Falls back to an inert default (hasActiveTeam = false) when no provider
 * is mounted — safe in isolated tests and storybook scenarios.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useActiveTeamContext(): ActiveTeamState {
  return useContext(ActiveTeamContext) ?? DEFAULT_STATE;
}
