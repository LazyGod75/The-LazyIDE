/**
 * useTeamsSync — React hook that wires Teams auth reconciliation to the
 * Supabase auth state machine.
 *
 * Behavior (team scope only, Tauri desktop build):
 *   - SIGNED_IN   → syncTeamsOnLogin: writes org-context.json + stores JWT
 *   - TOKEN_REFRESHED → resyncTeams: updates org-context.json + refreshes JWT
 *   - SIGNED_OUT  → clearTeamsToken: removes any stored Bearer token
 *
 * Solo / non-team scope / web build: zero behavioral change — all branches
 * are gated on isTauri() and scope === 'team'.
 *
 * TEAMS_ENABLED is false as const (Phase 0).  The dispatch path is dead code
 * until Phase 1 sets it to true. This hook prepares the auth state
 * independently of that flag so the reconciliation is ready for Phase 1.
 *
 * Returns { triggerResync } — call it after org membership changes (accept
 * invite, add/remove member) without waiting for the next auth state event.
 */

import { useEffect, useCallback } from 'react';
import { supabase } from '../supabase/client.js';
import { isTauri } from '../platform/index.js';
import { setOrgScope } from '../entitlements/unifiedEntitlement.js';
import { loadProjectScope } from '../brain/scope.js';
import {
  syncTeamsOnLogin,
  resyncTeams,
  clearTeamsToken,
} from './authSync.js';


// ── Hook ────────────────────────────────────────────────────────────

interface UseTeamsSyncOptions {
  /** Absolute path to the current project root (from AppContext). */
  projectRoot: string;
}

interface UseTeamsSyncResult {
  /**
   * Manually trigger a resync.
   * Call after org membership changes (accept-invite, add/remove member).
   * No-op when not in team scope or no active session.
   */
  triggerResync: () => Promise<void>;
}

export function useTeamsSync({ projectRoot }: UseTeamsSyncOptions): UseTeamsSyncResult {
  // Manual resync: reads the current session and re-syncs
  const triggerResync = useCallback(async (): Promise<void> => {
    if (!isTauri()) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id || !session.access_token) return;

    const scope = await loadProjectScope(projectRoot);
    setOrgScope(scope);

    if (scope === 'solo') return;

    await resyncTeams(session.user.id, session.access_token);
  }, [projectRoot]);

  useEffect(() => {
    // Web build: gate is a pass-through — no auth sync needed
    if (!isTauri()) return;

    // Team repos + org-context must be registered on EVERY app start, not
    // only when Supabase emits SIGNED_IN (which a restored session does NOT
    // re-emit on subsequent launches). Without this, the sync daemon has an
    // empty repo list until the next explicit login event — a silent
    // no-sync on every normal boot.
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id || !session.access_token) return;
      try {
        // syncTeamsOnLogin itself is a no-op when the user has no org
        // membership (fetchOrgContextData returns null) — so this runs on
        // EVERY boot regardless of the current project's scope, ensuring an
        // org member's team repos are registered even when the active
        // project isn't team-scoped.
        await syncTeamsOnLogin(session.user.id, session.access_token);
      } catch {
        // best-effort — a transient session fetch must never block boot
      }
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_OUT') {
          clearTeamsToken();
          setOrgScope('solo');
          return;
        }

        if (event !== 'SIGNED_IN' && event !== 'TOKEN_REFRESHED') return;
        if (!session?.user?.id || !session.access_token) return;

        // Load the full org scope and wire it to the entitlements cache
        const scope = await loadProjectScope(projectRoot);
        setOrgScope(scope);

        // Only sync teams auth if in a team-or-wider scope
        if (scope === 'solo') return;

        if (event === 'SIGNED_IN') {
          await syncTeamsOnLogin(session.user.id, session.access_token);
        } else {
          // TOKEN_REFRESHED
          await resyncTeams(session.user.id, session.access_token);
        }
      },
    );

    return () => subscription.unsubscribe();
  }, [projectRoot]); // re-register when the project root changes

  return { triggerResync };
}
