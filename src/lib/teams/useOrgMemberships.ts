/* useOrgMemberships — lists every org the current user belongs to, with
   their role and the org's live status, for the Multi-team viewpoint (D5d).

   FAIL-CLOSED: returns an empty list while loading or on any error, so a
   transient failure can never fabricate a false "you have N teams" signal.
   Two-step query (org_members -> organizations), same precedent as
   useActiveTeam.ts's queryActiveTeam — no Edge Function needed, both tables
   already have member-scoped RLS SELECT policies (see teams_tables.sql).
*/

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../supabase/client.js';
import type { OrgRole } from './types.js';
import { withTimeout } from '../brain/withTimeout.js';
import { TEAM_FETCH_TIMEOUT_MS } from './useOrg.js';

export interface OrgMembership {
  orgId: string;
  orgName: string;
  role: OrgRole;
  status: string;
  seats: number;
  memberCount: number;
  brainRepoUrl: string | null;
}

async function queryMemberships(userId: string): Promise<OrgMembership[]> {
  const { data: rows, error: memberErr } = await supabase
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId);

  if (memberErr || !rows || rows.length === 0) return [];

  const orgIds = rows.map((r) => (r as { org_id: string }).org_id);
  const roleByOrg = new Map(rows.map((r) => [(r as { org_id: string; role: string }).org_id, (r as { role: string }).role as OrgRole]));

  const { data: orgs, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name, status, seats_paid, brain_repo_url')
    .in('id', orgIds);

  if (orgErr || !orgs) return [];

  // Member counts per org — one query per org kept simple (org counts are
  // typically small); fails soft to 0 rather than blocking the whole list.
  const counts = await Promise.all(
    orgIds.map(async (orgId) => {
      const { count } = await supabase
        .from('org_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('org_id', orgId);
      return [orgId, count ?? 0] as const;
    }),
  );
  const countByOrg = new Map(counts);

  return (orgs as Array<{ id: string; name: string; status: string; seats_paid: number | null; brain_repo_url: string | null }>).map((org) => ({
    orgId: org.id,
    orgName: org.name,
    role: roleByOrg.get(org.id) ?? 'member',
    status: org.status,
    seats: org.seats_paid ?? 0,
    memberCount: countByOrg.get(org.id) ?? 0,
    brainRepoUrl: org.brain_repo_url ?? null,
  }));
}

export interface UseOrgMembershipsState {
  memberships: OrgMembership[];
  loading: boolean;
  refresh: () => void;
}

// Module-level cache of the last resolved memberships list, keyed by user.
// Survives across TeamSpace mount/unmount within the same session (e.g. the
// user switches spaces away from Team and back) so a later mount can render
// the previously-resolved list immediately instead of flashing the loading
// state again while the background query below re-validates it. Deliberately
// NOT localStorage/disk persistence — just a cheap in-memory field, cleared
// on full app reload like the rest of this hook's state.
let cachedMemberships: { userId: string; list: OrgMembership[] } | null = null;

export function useOrgMemberships(userId: string | null): UseOrgMembershipsState {
  const cached = userId && cachedMemberships?.userId === userId ? cachedMemberships.list : null;
  const [memberships, setMemberships] = useState<OrgMembership[]>(cached ?? []);
  // Starts true whenever a userId is already known AND we have no cached
  // list for it yet (lazy initializer, same pattern as fleetMissions.ts's
  // useState(isTauri && enabled)) so callers that gate a decision on "have
  // we resolved membership count yet" never see a false "loading: false,
  // memberships: []" on the very first render.
  const [loading, setLoading] = useState(() => !!userId && !cached);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!userId) {
      setMemberships([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Only flip the loading flag on if this exact user has no cached list —
    // otherwise this effect would flash loading=true right after a cache-hit
    // render already showed the cached (correct) content.
    if (cachedMemberships?.userId !== userId) {
      setLoading(true);
    }

    withTimeout(queryMemberships(userId), TEAM_FETCH_TIMEOUT_MS, 'org memberships')
      .then((result) => {
        if (cancelled) return;
        setMemberships(result);
        setLoading(false);
        cachedMemberships = { userId, list: result };
      })
      .catch(() => {
        if (cancelled) return;
        setMemberships([]); // fail-closed
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, tick]);

  return { memberships, loading, refresh };
}
