/* useMissionHistory.ts — React hooks wiring missionHistory.ts's/
   projectReport.ts's pure derivations to the live journal (journalQuery).
   Kept separate so the derivation logic stays fully pure/unit-testable with
   synthetic fixtures — no React, no mocked invoke needed there; this file is
   the thin (wiring-only) layer on top.

   State shape convention (all three hooks): the fetched result is stored
   WITH the request key it answers (`{ key, ... }`) and staleness is DERIVED
   at render time (`state.key === requestKey`) instead of clearing/resetting
   state synchronously inside the effect — reacting to a prop change with a
   sync setState in an effect is the exact cascading-render pattern
   react-hooks/set-state-in-effect flags; deriving makes the reset free.
*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { journalQuery } from './journal.js';
import type { JournalEventRow } from './eventTypes.js';
import { buildMissionRunHistory, buildProjectArchive, type MissionRunHistory, type ProjectArchiveEntry } from './missionHistory.js';
import { buildProjectReport, type ProjectReport } from './projectReport.js';

/** Hard cap on loop-iteration histories compared side-by-side in the Gantt
 *  (spec: "up to 3 loop iterations") — protects against a runaway loop
 *  config triggering dozens of concurrent journal queries. */
const MAX_COMPARISON_ITERATIONS = 3;
const HISTORY_QUERY_LIMIT = 2000;
const PROJECT_QUERY_LIMIT = 5000;

async function loadOne(missionId: string): Promise<MissionRunHistory> {
  const rows = await journalQuery({ missionId, limit: HISTORY_QUERY_LIMIT });
  return buildMissionRunHistory(missionId, rows);
}

export interface UseMissionRunHistoryResult {
  /** null while the first load is in flight, or when missionId is null. */
  primary: MissionRunHistory | null;
  /** Up to 3 loop-iteration histories, same order as the ids passed in. */
  comparisons: MissionRunHistory[];
  loading: boolean;
  /** Re-runs the query (e.g. the drawer was reopened for a mission that kept running). */
  reload: () => void;
}

interface HistoryState {
  key: string;
  primary: MissionRunHistory;
  comparisons: MissionRunHistory[];
}

/**
 * Loads one mission's run history plus (optionally) up to 3 of its loop
 * iterations' histories for the Gantt's comparison rows. Re-fetches whenever
 * missionId or the iteration id list changes, or when `reload()` is called.
 * Never throws — journalQuery itself already degrades to [] on any journal
 * failure (see journal.ts's doc comment), so a backend hiccup here just
 * yields an honestly-empty history rather than a crash.
 */
export function useMissionRunHistory(
  missionId: string | null,
  iterationMissionIds: readonly string[] = [],
): UseMissionRunHistoryResult {
  const [state, setState] = useState<HistoryState | null>(null);
  const [generation, setGeneration] = useState(0);

  const comparisonIds = useMemo(
    () => iterationMissionIds.slice(0, MAX_COMPARISON_ITERATIONS),
    [iterationMissionIds],
  );
  const comparisonIdsKey = comparisonIds.join(',');
  const requestKey = missionId ? `${missionId}|${comparisonIdsKey}|${generation}` : null;

  const reload = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    if (!requestKey || !missionId) return;
    let cancelled = false;
    void (async () => {
      const [primaryResult, ...comparisonResults] = await Promise.all([
        loadOne(missionId),
        ...comparisonIds.map(loadOne),
      ]);
      if (cancelled) return;
      setState({ key: requestKey, primary: primaryResult, comparisons: comparisonResults });
    })();
    return () => {
      cancelled = true;
    };
    // requestKey already encodes missionId + comparisonIdsKey + generation —
    // comparisonIds itself is a fresh array each render, so depending on it
    // directly would re-fetch on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const isCurrent = state !== null && state.key === requestKey;
  return {
    primary: isCurrent ? state.primary : null,
    comparisons: isCurrent ? state.comparisons : [],
    loading: requestKey !== null && !isCurrent,
    reload,
  };
}

export interface UseProjectRunArchiveResult {
  entries: ProjectArchiveEntry[];
  loading: boolean;
  reload: () => void;
}

const EMPTY_ARCHIVE: ProjectArchiveEntry[] = [];

/**
 * Every mission the journal knows about for `projectId` — including missions
 * no longer present in `missions_current` (see buildProjectArchive's doc
 * comment), newest-first. `projectId: null` yields an empty archive (no
 * project resolved yet) rather than querying unscoped.
 */
export function useProjectRunArchive(projectId: string | null): UseProjectRunArchiveResult {
  const [state, setState] = useState<{ key: string; entries: ProjectArchiveEntry[] } | null>(null);
  const [generation, setGeneration] = useState(0);
  const requestKey = projectId ? `${projectId}|${generation}` : null;

  const reload = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    if (!requestKey || !projectId) return;
    let cancelled = false;
    void (async () => {
      const rows: JournalEventRow[] = await journalQuery({ projectId, limit: PROJECT_QUERY_LIMIT });
      if (cancelled) return;
      setState({ key: requestKey, entries: buildProjectArchive(rows) });
    })();
    return () => {
      cancelled = true;
    };
    // requestKey already encodes projectId + generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const isCurrent = state !== null && state.key === requestKey;
  return {
    entries: isCurrent ? state.entries : EMPTY_ARCHIVE,
    loading: requestKey !== null && !isCurrent,
    reload,
  };
}

export interface UseProjectReportResult {
  /** null while loading or when projectId is null. */
  report: ProjectReport | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Per-project « Rapport » read-model (see projectReport.ts): every COMPLETED
 * mission the journal knows for `projectId` with its artifacts (real
 * Mission.proofs from the last journal snapshot), mergedToday flag, totals
 * and chain fires. Foundation only — the report page UI ships in a later
 * wave; this hook is its single data source.
 */
export function useProjectReport(projectId: string | null): UseProjectReportResult {
  const [state, setState] = useState<{ key: string; report: ProjectReport } | null>(null);
  const [generation, setGeneration] = useState(0);
  const requestKey = projectId ? `${projectId}|${generation}` : null;

  const reload = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    if (!requestKey || !projectId) return;
    let cancelled = false;
    void (async () => {
      const rows: JournalEventRow[] = await journalQuery({ projectId, limit: PROJECT_QUERY_LIMIT });
      if (cancelled) return;
      setState({ key: requestKey, report: buildProjectReport(rows) });
    })();
    return () => {
      cancelled = true;
    };
    // requestKey already encodes projectId + generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const isCurrent = state !== null && state.key === requestKey;
  return {
    report: isCurrent ? state.report : null,
    loading: requestKey !== null && !isCurrent,
    reload,
  };
}
