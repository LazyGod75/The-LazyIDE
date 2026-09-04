/* useZoneDigest.ts — React hook wiring zoneDigest.ts's pure derivation to
   the live journal (journalQuery), feeding ProjectGroupNode's living-empty-
   zone body (defect #6 fix). Same wiring-only split useMissionHistory.ts
   already established for missionHistory.ts/projectReport.ts: the
   derivation stays pure/unit-testable with synthetic fixtures, this file
   is the thin React layer on top.

   Poll-free by design (explicit constraint on this fix): a single
   on-mount / on-projectId-change query, no setInterval, no subscription to
   the fleet's own mission-poll loop. A relative "il y a 2h" label going a
   little stale between full canvas re-renders is an acceptable trade for
   not adding a second live polling loop next to the canvas's already-
   established one.
*/

import { useEffect, useState } from 'react';
import { journalQuery } from './journal.js';
import { buildZoneDigest, type ZoneDigest } from './zoneDigest.js';

/** A zone's empty-state hint only ever needs the last handful of events —
 *  smaller than useProjectReport's PROJECT_QUERY_LIMIT (5000) on purpose,
 *  this is a cheap glance, not a full report. */
const ZONE_DIGEST_QUERY_LIMIT = 500;

export interface UseZoneDigestResult {
  /** null while the first load is in flight, or when projectId is null. */
  digest: ZoneDigest | null;
  loading: boolean;
}

/**
 * One project's living-zone digest — last activity, recent terminal
 * missions, merged-today count. `projectId: null` (the synthetic
 * Transverse zone, or no zone rendered yet) yields `{ digest: null,
 * loading: false }` rather than querying unscoped.
 */
export function useZoneDigest(projectId: string | null): UseZoneDigestResult {
  const [state, setState] = useState<{ key: string; digest: ZoneDigest } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      const rows = await journalQuery({ projectId, limit: ZONE_DIGEST_QUERY_LIMIT });
      if (cancelled) return;
      setState({ key: projectId, digest: buildZoneDigest(rows) });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const isCurrent = projectId !== null && state !== null && state.key === projectId;
  return {
    digest: isCurrent ? state.digest : null,
    loading: projectId !== null && !isCurrent,
  };
}
