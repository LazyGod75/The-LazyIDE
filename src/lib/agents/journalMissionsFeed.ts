/* journalMissionsFeed.ts — single shared poller + cache for the
   `journal_missions_current` Tauri command.

   Perf audit finding (2026-08): three independent, uncoordinated timers
   each re-ran this exact same cross-project IPC call on their own clock:
     - fleetMissions.ts's useFleetMissions   (every 2.5s, Cockpit-gated)
     - SpacesRail.tsx's useRunningMissionCounts (every 5s, always mounted)
     - useCanvasHydration.ts's repairMaterializedPlanProjects safety net
       (its own ad-hoc invoke, every 30s while the canvas is mounted)
   None of them shared a cache, so at steady state (Cockpit + rail + canvas
   all mounted) the app issued ~3 concurrent `journal_missions_current`
   invokes per 2.5s window instead of 1 — extra IPC/main-thread JSON work
   for identical data, and three independently-phased timers that could
   burst close together.

   This module is the single source of truth: ONE interval, running at the
   FASTEST cadence any real consumer needs (2.5s — fleetMissions' cockpit
   grid, the highest-liveness caller, the one thing this audit was told
   never to de-tune), broadcasting to every subscriber. Nothing gets
   staler than it already was for the fastest consumer; slower consumers
   (the 5s rail dots, the 30s canvas safety net) simply get pushed updates
   more often than they used to poll for themselves, for free.

   The interval only runs while at least one consumer is subscribed (see
   `ensurePolling`/`maybeStopPolling`) — a web/non-Tauri session, where no
   consumer ever subscribes, never polls at all, same as before.
*/

import { invoke } from '@tauri-apps/api/core';

const POLL_INTERVAL_MS = 2500;

/** Wire shape of one row from `journal_missions_current` (journal.rs's
 *  `MissionCurrentOut`) — mirrors the identical local type every previous
 *  independent poller declared for itself. */
export interface JournalMissionCurrentRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

type Listener = (rows: readonly JournalMissionCurrentRow[], error: string | null) => void;

let rows: JournalMissionCurrentRow[] = [];
let lastError: string | null = null;
let lastFetchedAtMs = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<readonly JournalMissionCurrentRow[]> | null = null;
const listeners = new Set<Listener>();

function sameJournalRows(
  a: readonly JournalMissionCurrentRow[],
  b: readonly JournalMissionCurrentRow[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.mission_id !== right.mission_id
      || left.project_id !== right.project_id
      || left.status !== right.status
      || left.updated_ms !== right.updated_ms
      || left.data !== right.data
    ) {
      return false;
    }
  }
  return true;
}

function notifyAll(): void {
  for (const listener of listeners) listener(rows, lastError);
}

async function fetchOnce(): Promise<readonly JournalMissionCurrentRow[]> {
  if (inFlight) return inFlight;
  inFlight = invoke<JournalMissionCurrentRow[]>('journal_missions_current')
    .then((next) => {
      const incoming = Array.isArray(next) ? next : [];
      const firstPaint = lastFetchedAtMs === 0;
      lastFetchedAtMs = Date.now();
      lastError = null;
      if (!firstPaint && sameJournalRows(rows, incoming)) return rows;
      rows = incoming;
      notifyAll();
      return rows;
    })
    .catch((err: unknown) => {
      // best-effort — keep the last known rows on a transient failure,
      // surface the error for callers that want to show a hint. Same
      // convention every previous independent poller used individually.
      lastError = err instanceof Error ? err.message : String(err);
      notifyAll();
      return rows;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function ensurePolling(): void {
  if (intervalId !== null) return;
  void fetchOnce();
  intervalId = setInterval(() => void fetchOnce(), POLL_INTERVAL_MS);
}

function maybeStopPolling(): void {
  if (listeners.size > 0) return;
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Subscribe to the shared `journal_missions_current` feed. Starts the one
 * shared poller on the first subscriber; stops it once the last
 * subscriber unsubscribes. Fires synchronously with the current cache IF
 * a fetch has already completed at least once (a second consumer mounting
 * after the first gets instant real data, no wait for the next tick) —
 * otherwise waits for the in-flight/next fetch to resolve so a fresh
 * subscriber never sees a stale/empty snapshot as if it were real.
 */
export function subscribeJournalMissions(listener: Listener): () => void {
  listeners.add(listener);
  ensurePolling();
  if (lastFetchedAtMs > 0) listener(rows, lastError);
  return () => {
    listeners.delete(listener);
    maybeStopPolling();
  };
}

/**
 * One-off read for a consumer that does not want a live subscription (e.g.
 * useCanvasHydration's 30s materialized-plan-repair safety net) — returns
 * the shared cache as-is if it was refreshed within `maxAgeMs` (default:
 * one poll interval), otherwise performs exactly one fresh fetch, deduped
 * against any fetch already in flight from the interval poller itself.
 * Does NOT start or stop the shared interval — a caller that only ever
 * uses this snapshot read (never `subscribeJournalMissions`) causes at
 * most one invoke per call, same as before, just cache-aware.
 */
export async function getJournalMissionsSnapshot(
  maxAgeMs = POLL_INTERVAL_MS,
): Promise<readonly JournalMissionCurrentRow[]> {
  if (lastFetchedAtMs > 0 && Date.now() - lastFetchedAtMs <= maxAgeMs) return rows;
  return fetchOnce();
}

/** Test-only reset (module-level singleton state otherwise leaks between
 *  `it()` blocks in the same test file — see setup.ts's global afterEach,
 *  which calls this after every test, same convention as
 *  approvalMode.ts's `_resetApprovalModesForTests`). */
export function _resetJournalMissionsFeedForTests(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  rows = [];
  lastError = null;
  lastFetchedAtMs = 0;
  inFlight = null;
  listeners.clear();
}
