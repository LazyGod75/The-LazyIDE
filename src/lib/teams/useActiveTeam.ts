/**
 * useActiveTeam — checks whether the current user is a member of at least
 * one organization with status 'active' or 'trialing'.
 *
 * Design decisions:
 *   - FAIL-CLOSED: hasActiveTeam is false while loading and on any error.
 *   - Primitive deps only in useEffect: userId (string | null) + tick (number).
 *     This prevents the object-dep infinite-loop bug.
 *   - Pure logic helpers are exported for deterministic unit tests (no React).
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase/client.js';

// ── Pure logic (exported for unit tests) ─────────────────────────────

/** Minimal row shape needed for the active-team check. */
export interface OrgStatusRow {
  status: string;
}

/**
 * Returns true if at least one row has status 'active' or 'trialing'.
 * Returns false for null (fail-closed: called on Supabase error or no data).
 */
export function deriveHasActiveTeam(
  rows: OrgStatusRow[] | null,
): boolean {
  if (!rows || rows.length === 0) return false;
  return rows.some(
    (r) => r.status === 'active' || r.status === 'trialing',
  );
}

/**
 * Whether the Team tab should be shown.
 * Requires BOTH the global build kill-switch AND per-user active membership.
 */
export function computeShowTeamTab(
  teamsEnabled: boolean,
  hasActiveTeam: boolean,
): boolean {
  return teamsEnabled && hasActiveTeam;
}

// ── Supabase query ────────────────────────────────────────────────────

/**
 * Two-step query via RLS (no edge function required):
 *   1. org_members WHERE user_id = userId  → list of org_ids
 *   2. organizations WHERE id IN [org_ids] → filter by status
 *
 * Returns false on any error (fail-closed).
 */
async function queryActiveTeam(userId: string): Promise<boolean> {
  const { data: memberships, error: memberErr } = await supabase
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId);

  if (memberErr || !memberships || memberships.length === 0) {
    return false;
  }

  const orgIds = memberships.map(
    (m) => (m as { org_id: string }).org_id,
  );

  const { data: orgs, error: orgErr } = await supabase
    .from('organizations')
    .select('status')
    .in('id', orgIds);

  if (orgErr || !orgs) {
    return false;
  }

  return deriveHasActiveTeam(orgs as OrgStatusRow[]);
}

// ── Hook ──────────────────────────────────────────────────────────────

export interface ActiveTeamState {
  hasActiveTeam: boolean;
  loading: boolean;
  refresh: () => void;
}

/**
 * @param userId  Primitive string (or null) extracted from the User object.
 *                Never pass the whole User object — avoids object-dep loops.
 */
export function useActiveTeam(userId: string | null): ActiveTeamState {
  const [hasActiveTeam, setHasActiveTeam] = useState(false);
  const [loading, setLoading] = useState(false);
  // tick is a number — incrementing it re-triggers the effect (safe dep).
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!userId) {
      setHasActiveTeam(false);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setHasActiveTeam(false); // fail-closed during loading

    queryActiveTeam(userId)
      .then((result) => {
        if (cancelled) return;
        setHasActiveTeam(result);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setHasActiveTeam(false); // fail-closed on error
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, tick]); // string | null + number — no objects, no loops

  return { hasActiveTeam, loading, refresh };
}
