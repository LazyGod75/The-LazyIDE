/* useOrgUsageSummary — per-member usage since the start of the current
   calendar month, via orgApi.getUsageSummary (org-list's "usage-summary"
   action -> org_usage_summary RPC).

   HONESTY NOTE (D5b, carried from orgApi.ts): this is each member's TOTAL
   consumption (usage_events.org_id/dept_id are never populated), not spend
   attributed specifically to this org. Consumers must label it accordingly.

   ROLE GATE: the backend restricts this to `rows` containing every member
   (org-admin/team-lead) or only the caller's own row (member/viewer) — see
   org-list/index.ts's "usage-summary" action. Consumers rendered for a
   non-admin caller (MemberView) must not assume `rows` covers the whole
   org; find-by-caller-id already degrades correctly either way.
*/

import { useState, useEffect, useCallback } from 'react';
import { getUsageSummary } from './orgApi.js';
import type { MemberUsageRow } from './types.js';

function startOfCurrentMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface UseOrgUsageSummaryState {
  /** Keyed by user_id for O(1) per-member lookups. */
  byUserId: Map<string, MemberUsageRow>;
  rows: MemberUsageRow[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useOrgUsageSummary(orgId: string | null): UseOrgUsageSummaryState {
  const [rows, setRows] = useState<MemberUsageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!orgId) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getUsageSummary(orgId, startOfCurrentMonthIso())
      .then((result) => {
        if (cancelled) return;
        if (result.success) {
          setRows(result.data);
          setError(null);
        } else {
          setRows([]);
          setError(result.error);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId, tick]);

  const byUserId = new Map(rows.map((r) => [r.user_id, r]));

  return { byUserId, rows, loading, error, refetch };
}
