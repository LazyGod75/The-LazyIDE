/* useAllocations — fetches allocations (and members) for an org via org-list.
   Exposes mutation helpers setAllocation and removeAllocation backed by org-set-allocation.
*/

import { useState, useEffect, useCallback } from 'react';
import { listOrg, setAllocation as apiSetAllocation } from './orgApi.js';
import type { OrgAllocation, OrgMember } from './types.js';

// ── Types ─────────────────────────────────────────────────────────

export interface MutationResult {
  success: boolean;
  error?: string;
}

export interface UseAllocationsState {
  allocations: OrgAllocation[];
  members: OrgMember[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  setAllocation: (
    entityType: 'member' | 'dept',
    entityId: string,
    limitCents: number,
    period: string,
  ) => Promise<MutationResult>;
  removeAllocation: (
    entityType: 'member' | 'dept',
    entityId: string,
    period: string,
  ) => Promise<MutationResult>;
}

// ── Hook ──────────────────────────────────────────────────────────

export function useAllocations(orgId: string): UseAllocationsState {
  const [allocations, setAllocations] = useState<OrgAllocation[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!orgId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    listOrg(orgId)
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setAllocations(result.data.allocations);
          setMembers(result.data.members);
          setError(null);
        } else {
          setError(result.error);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, tick]);

  const setAllocation = useCallback(
    async (
      entityType: 'member' | 'dept',
      entityId: string,
      limitCents: number,
      period: string,
    ): Promise<MutationResult> => {
      const result = await apiSetAllocation(orgId, entityType, entityId, limitCents, period);
      if (result.success) {
        refetch();
        return { success: true };
      }
      return { success: false, error: result.error };
    },
    [orgId, refetch],
  );

  const removeAllocation = useCallback(
    async (
      entityType: 'member' | 'dept',
      entityId: string,
      period: string,
    ): Promise<MutationResult> => {
      return setAllocation(entityType, entityId, 0, period);
    },
    [setAllocation],
  );

  return { allocations, members, loading, error, refetch, setAllocation, removeAllocation };
}
