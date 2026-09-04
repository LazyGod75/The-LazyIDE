/* useCanvasFilter.ts — search/status-filter/"Focus pannes" state for the
   Agent Canvas (W2b, spec §5 "Search/filter"). Deliberately local
   component state, NOT canvasStore: search/filter is a transient VIEW
   concern (never undoable via Ctrl+Z, never persisted across sessions,
   never a fact the reconciler or any other canvas consumer needs) — the
   task's own instruction ("NOT in canvasStore — not undoable, not
   persisted") matches canvasStore.ts's own documented boundary (positions/
   drafts/chains/notes/prefs only, never a second source of view state).

   The MATCHING helpers (`matchesSearchQuery`/`matchesStatusFilters`/
   `matchesFocusFailures`) are exported as plain pure functions — no React,
   no store — so they're directly unit-testable and reusable by
   CanvasView.tsx's "Focus pannes" handler (which needs to know the matched
   node list BEFORE deciding whether to show the honest empty toast or
   activate the filter + fitView).
*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MissionStatus } from '../../../../lib/agents/types';
import type { DraftSpec, LoopNodeData, MissionNodeData, NoteData, ScheduleNodeData } from '../canvasTypes';
import type { CanvasReactFlowNode } from '../reconciler';

const SEARCH_DEBOUNCE_MS = 150;

/** The status chips the toolbar offers (spec §5: "running/review/failed/
 *  queued/done") — `cancelled` has no dedicated chip (mirrors nodeChrome.ts's
 *  own choice to fold `cancelled` into the `failed` VISUAL bucket; the
 *  underlying MissionStatus value is untouched here, chips just don't
 *  expose it as a separate toggle). */
export const STATUS_FILTER_CHIPS: readonly MissionStatus[] = ['running', 'review', 'failed', 'queued', 'done'];

// Strips Unicode combining diacritical marks (U+0300-U+036F) left behind by
// NFD normalization, so "café"/"cafe" match regardless of accents.
const DIACRITIC_MARKS = /[̀-ͯ]/g;

function normalize(value: string): string {
  return value.normalize('NFD').replace(DIACRITIC_MARKS, '').toLowerCase();
}

/** Every free-text field a node kind exposes to search (spec §5: "title/
 *  agent/model match"). Project zones are never searched directly (a zone
 *  is structure, not content) — see {@link matchesSearchQuery}. */
function searchableFields(node: CanvasReactFlowNode): string[] {
  switch (node.type) {
    case 'mission':
    case 'loop': {
      const data = node.data as MissionNodeData | LoopNodeData;
      return [data.mission.title, data.mission.model];
    }
    case 'draft': {
      const data = node.data as DraftSpec;
      return [data.title, data.agentName ?? '', data.model ?? ''];
    }
    case 'schedule': {
      const data = node.data as ScheduleNodeData;
      return [data.agentName];
    }
    case 'note': {
      const data = node.data as NoteData;
      return [data.text];
    }
    default:
      return [];
  }
}

/** Pure — case/diacritic-insensitive substring match against a node's
 *  title/agent/model fields. An empty/blank query always matches (no
 *  active search). Project zone nodes always match (they're never dimmed
 *  by search — only their children are search targets, spec §5). */
export function matchesSearchQuery(node: CanvasReactFlowNode, query: string): boolean {
  if (node.type === 'project') return true;
  const needle = normalize(query.trim());
  if (!needle) return true;
  return searchableFields(node).some((field) => normalize(field).includes(needle));
}

function missionStatusOf(node: CanvasReactFlowNode): MissionStatus | undefined {
  if (node.type === 'mission' || node.type === 'loop') return (node.data as MissionNodeData | LoopNodeData).mission.status;
  return undefined;
}

/** Pure — multi-select status chip match (spec §5). An empty filter set
 *  always matches (no active filter). A node with no mission status
 *  (draft/schedule/note) never matches an ACTIVE status filter — the
 *  chips filter missions, so a non-mission node correctly dims alongside
 *  every mission that isn't in the selected statuses. */
export function matchesStatusFilters(node: CanvasReactFlowNode, statuses: ReadonlySet<MissionStatus>): boolean {
  if (node.type === 'project') return true;
  if (statuses.size === 0) return true;
  const status = missionStatusOf(node);
  return status !== undefined && statuses.has(status);
}

/** Pure — "Focus pannes" predicate (spec's task text: "filter failed +
 *  judge-rejected review missions across ALL projects"). A judge-rejected
 *  review mission is `status === 'review'` with a recorded verdict whose
 *  `passed` is `false` (an in-flight review with NO verdict yet is not a
 *  panne — it just hasn't been judged). */
export function matchesFocusFailures(node: CanvasReactFlowNode): boolean {
  if (node.type === 'project') return true;
  if (node.type !== 'mission' && node.type !== 'loop') return false;
  const mission = (node.data as MissionNodeData | LoopNodeData).mission;
  if (mission.status === 'failed') return true;
  return mission.status === 'review' && mission.judgeVerdict?.passed === false;
}

export interface UseCanvasFilterResult {
  /** Raw (un-debounced) input value — bind directly to the search box so
   *  typing never feels laggy; matching uses the debounced value. */
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  statusFilters: ReadonlySet<MissionStatus>;
  toggleStatusFilter: (status: MissionStatus) => void;
  focusFailuresActive: boolean;
  /** Turns focus-pannes ON (clearing search/status chips first — mutually
   *  exclusive with them, spec's task text: "one click"). Call
   *  {@link matchesFocusFailures} yourself first to decide whether there's
   *  anything to focus (the honest empty-toast case) — this setter never
   *  toasts, it only flips state. */
  activateFocusFailures: () => void;
  isFilterActive: boolean;
  clear: () => void;
  /** Combined predicate reflecting the CURRENT (debounced) filter state —
   *  recomputed whenever any filter input changes. */
  nodeMatches: (node: CanvasReactFlowNode) => boolean;
}

export function useCanvasFilter(): UseCanvasFilterResult {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilters, setStatusFilters] = useState<ReadonlySet<MissionStatus>>(new Set());
  const [focusFailuresActive, setFocusFailuresActive] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const setSearchQuery = useCallback((query: string) => {
    setSearchInput(query);
    setFocusFailuresActive(false);
  }, []);

  const toggleStatusFilter = useCallback((status: MissionStatus) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
    setFocusFailuresActive(false);
  }, []);

  const activateFocusFailures = useCallback(() => {
    setSearchInput('');
    setDebouncedQuery('');
    setStatusFilters(new Set());
    setFocusFailuresActive(true);
  }, []);

  const clear = useCallback(() => {
    setSearchInput('');
    setDebouncedQuery('');
    setStatusFilters(new Set());
    setFocusFailuresActive(false);
  }, []);

  const isFilterActive = focusFailuresActive || debouncedQuery.trim().length > 0 || statusFilters.size > 0;

  const nodeMatches = useMemo(() => {
    if (focusFailuresActive) return matchesFocusFailures;
    return (node: CanvasReactFlowNode) => matchesSearchQuery(node, debouncedQuery) && matchesStatusFilters(node, statusFilters);
  }, [focusFailuresActive, debouncedQuery, statusFilters]);

  return {
    searchQuery: searchInput,
    setSearchQuery,
    statusFilters,
    toggleStatusFilter,
    focusFailuresActive,
    activateFocusFailures,
    isFilterActive,
    clear,
    nodeMatches,
  };
}
