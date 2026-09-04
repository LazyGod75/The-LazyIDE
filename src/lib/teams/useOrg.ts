/* useOrg — fetches org data for the active org.
   Returns loading/error/data state and a refetch function.
   orgId stored in localStorage under 'lazy.teams.orgId'.
*/

import { useState, useEffect, useCallback } from 'react';
import { listOrg } from './orgApi.js';
import type { OrgData } from './types.js';
import { withTimeout } from '../brain/withTimeout.js';

/** Measured 2026-08-28: Team tab could spin forever on a hung org-list /
 *  memberships query. Settle so the space can show retry instead. */
export const TEAM_FETCH_TIMEOUT_MS = 5_000;

const LS_ORG_KEY = 'lazy.teams.orgId';

export function loadStoredOrgId(): string | null {
  try {
    return localStorage.getItem(LS_ORG_KEY);
  } catch {
    return null;
  }
}

export function saveOrgId(orgId: string): void {
  try {
    localStorage.setItem(LS_ORG_KEY, orgId);
  } catch {
    // localStorage unavailable — silently ignore
  }
}

export function clearOrgId(): void {
  try {
    localStorage.removeItem(LS_ORG_KEY);
  } catch {
    // silently ignore
  }
}

// ── Hook ──────────────────────────────────────────────────────────

export interface UseOrgState {
  orgId: string | null;
  data: OrgData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  setOrgId: (id: string) => void;
  /** B26: clears the locally-remembered active org (localStorage + state) —
   *  call after the caller has left or deleted it, so TeamSpace re-derives
   *  the right viewpoint instead of re-fetching a defunct/departed org. */
  clearActiveOrg: () => void;
}

// Module-level cache of the last successfully loaded org, keyed by orgId.
// Survives across TeamSpace mount/unmount within the same session so a later
// mount (e.g. switching spaces away from Team and back) can render the
// previously-loaded org immediately instead of flashing loading while this
// hook re-fetches. Deliberately NOT localStorage/disk persistence — just a
// cheap in-memory field, cleared on full app reload like the rest of this
// hook's state.
let cachedOrg: { orgId: string; data: OrgData } | null = null;

export function useOrg(): UseOrgState {
  const [orgId, setOrgIdState] = useState<string | null>(loadStoredOrgId);
  const initialCached = orgId && cachedOrg?.orgId === orgId ? cachedOrg.data : null;
  const [data, setData] = useState<OrgData | null>(initialCached);
  // Lazy-initialized against the stored orgId (same pattern as
  // useOrgMemberships' loading init): an already-known orgId with no cached
  // data means a fetch is about to start, so `loading` must start true — a
  // stale `false` here is exactly what let TeamSpace derive a role of `null`
  // (data not loaded yet, but not "loading" either) on the very first
  // render, flashing the "no team" empty state before the real org lands.
  const [loading, setLoading] = useState(() => !!orgId && !initialCached);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  const setOrgId = useCallback((id: string) => {
    saveOrgId(id);
    setOrgIdState(id);
    setData(null);
    setError(null);
  }, []);

  const clearActiveOrg = useCallback(() => {
    clearOrgId();
    setOrgIdState(null);
    setData(null);
    setError(null);
    cachedOrg = null;
  }, []);

  useEffect(() => {
    if (!orgId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    // Only flip loading on if this exact org has no cached data — otherwise
    // this effect would flash loading=true right after a cache-hit render
    // already showed the cached (correct) content.
    if (cachedOrg?.orgId !== orgId) {
      setLoading(true);
    }
    setError(null);

    withTimeout(listOrg(orgId), TEAM_FETCH_TIMEOUT_MS, 'listOrg').then((result) => {
      if (cancelled) return;
      if (result.success) {
        setData(result.data);
        setError(null);
        cachedOrg = { orgId, data: result.data };
      } else {
        setError(result.error);
        setData(null);
      }
      setLoading(false);
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [orgId, tick]);

  return { orgId, data, loading, error, refetch, setOrgId, clearActiveOrg };
}
