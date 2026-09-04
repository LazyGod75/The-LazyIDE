/* useBrainSavings.ts — React hook wiring brainSavings.ts's pure derivation to
   the live journal (journalQuery), feeding ProjectReportPage's "Brain" report
   card. Same wiring-only split as useZoneDigest.ts/useMissionHistory.ts: the
   derivation stays pure/unit-testable with synthetic fixtures, this file is
   the thin React layer on top.
*/

import { useEffect, useState } from 'react';
import { journalQuery } from './journal.js';
import { buildBrainSavings, type BrainSavingsSummary } from './brainSavings.js';

/** Same project-wide scope as useMissionHistory.ts's useProjectReport
 *  (PROJECT_QUERY_LIMIT) — the brain card reports the whole project's real
 *  brain activity, not just a recent glance (contrast useZoneDigest's
 *  smaller cheap-glance limit). */
const BRAIN_SAVINGS_QUERY_LIMIT = 5000;

export interface UseBrainSavingsResult {
  /** null while the first load is in flight, or when projectId is null. */
  summary: BrainSavingsSummary | null;
  loading: boolean;
}

/**
 * One project's brain-savings summary — real recall count + real
 * prompt-cache read tokens, both derived exclusively from journal events
 * (see brainSavings.ts's header on why no injected-context-token or
 * dollar-saved figure is computed). `projectId: null` yields
 * `{ summary: null, loading: false }` rather than querying unscoped.
 */
export function useBrainSavings(projectId: string | null): UseBrainSavingsResult {
  const [state, setState] = useState<{ key: string; summary: BrainSavingsSummary } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      const rows = await journalQuery({ projectId, limit: BRAIN_SAVINGS_QUERY_LIMIT });
      if (cancelled) return;
      setState({ key: projectId, summary: buildBrainSavings(rows) });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const isCurrent = projectId !== null && state !== null && state.key === projectId;
  return {
    summary: isCurrent ? state.summary : null,
    loading: projectId !== null && !isCurrent,
  };
}
