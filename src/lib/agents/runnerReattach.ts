/* runnerReattach.ts — P6.c: UI re-attach handshake for lazy-runnerd.

   When the UI boots (or reboots after a crash), this module reconciles
   the UI's mission list with any missions still owned by the runner daemon.

   The handshake (per DETACHED-RUNTIME-SPEC §2):
   1. Call runner_status → check if runner is alive
   2. If alive: GET /missions → list of { id, lastSeq } still live
   3. For each live mission also in the UI's persisted list,
      call journalQuery({ missionId, sinceSeq: lastKnownSeq }) to backfill
   4. Re-subscribe to live updates via polling

   This module is intentionally pure (no React/store coupling) — it returns
   a reconciliation plan that the caller (agentsStore boot sequence) applies.
*/

import { invoke } from '@tauri-apps/api/core';
import { journalQuery } from '../journal/journal.js';
import type { JournalEventRow } from '../journal/eventTypes.js';

/** A mission the runner reports as still live. */
export interface RunnerMission {
  id: string;
  pid?: number;
  lastSeq?: number;
}

/** Result of the re-attach reconciliation. */
export interface ReattachResult {
  /** Whether the runner daemon is enabled and running. */
  runnerActive: boolean;
  /** Missions the runner owns that the UI should track. */
  liveMissions: RunnerMission[];
  /** Journal events backfilled for each live mission (keyed by missionId). */
  backfilledEvents: Map<string, JournalEventRow[]>;
  /** Missions the runner has that the UI doesn't know about (orphaned). */
  orphanedMissions: RunnerMission[];
}

/**
 * Perform the re-attach handshake.
 *
 * @param knownMissionIds — mission IDs the UI already has in its persisted list
 * @param lastKnownSeqs — optional map of missionId → last journal seq the UI saw
 */
export async function reattachToRunner(
  knownMissionIds: string[],
  lastKnownSeqs?: Map<string, number>,
): Promise<ReattachResult> {
  // Step 1: Check runner status
  let runnerPort: number;
  let runnerToken: string;
  try {
    const status = await invoke<{
      enabled: boolean;
      running: boolean;
      port?: number;
    }>('runner_status');

    if (!status.enabled || !status.running) {
      return {
        runnerActive: false,
        liveMissions: [],
        backfilledEvents: new Map(),
        orphanedMissions: [],
      };
    }
    runnerPort = status.port ?? 0;
    runnerToken = '';
  } catch {
    return {
      runnerActive: false,
      liveMissions: [],
      backfilledEvents: new Map(),
      orphanedMissions: [],
    };
  }

  // Step 2: GET /missions from the runner
  const baseUrl = `http://127.0.0.1:${runnerPort}`;
  let runnerMissions: RunnerMission[] = [];
  try {
    const resp = await fetch(`${baseUrl}/missions`, {
      headers: { Authorization: `Bearer ${runnerToken}` },
    });
    if (resp.ok) {
      runnerMissions = await resp.json();
    }
  } catch {
    // Runner unreachable despite status saying it's up — treat as inactive
    return {
      runnerActive: false,
      liveMissions: [],
      backfilledEvents: new Map(),
      orphanedMissions: [],
    };
  }

  // Step 3: Partition into known vs orphaned
  const knownSet = new Set(knownMissionIds);
  const liveKnown = runnerMissions.filter((m) => knownSet.has(m.id));
  const orphaned = runnerMissions.filter((m) => !knownSet.has(m.id));

  // Step 4: Backfill journal events for known live missions
  const backfilled = new Map<string, JournalEventRow[]>();
  for (const mission of liveKnown) {
    const sinceSeq = lastKnownSeqs?.get(mission.id) ?? 0;
    try {
      const events = await journalQuery({
        missionId: mission.id,
        sinceSeq,
        limit: 10000,
      }) as JournalEventRow[];
      if (events.length > 0) {
        backfilled.set(mission.id, events);
      }
    } catch {
      // Journal query failure for one mission shouldn't block others
    }
  }

  return {
    runnerActive: true,
    liveMissions: liveKnown,
    backfilledEvents: backfilled,
    orphanedMissions: orphaned,
  };
}

/**
 * Start polling the runner for live updates on a specific mission.
 * Returns an unsubscribe function.
 *
 * @param missionId — the mission to poll
 * @param onUpdate — callback when the mission's status changes
 * @param intervalMs — poll interval (default 1000ms)
 */
export function pollRunnerMission(
  missionId: string,
  onUpdate: (stillRunning: boolean) => void,
  intervalMs = 1000,
): () => void {
  let active = true;
  let wasRunning = true;

  (async () => {
    while (active) {
      try {
        const status = await invoke<{
          enabled: boolean;
          running: boolean;
          port?: number;
        }>('runner_status');

        if (!status.enabled || !status.running) {
          if (wasRunning) {
            wasRunning = false;
            onUpdate(false);
          }
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }

        const baseUrl = `http://127.0.0.1:${status.port ?? 0}`;
        const resp = await fetch(`${baseUrl}/missions`, {
          headers: { Authorization: '' },
        });

        if (resp.ok) {
          const missions: RunnerMission[] = await resp.json();
          const stillRunning = missions.some((m) => m.id === missionId);
          if (stillRunning !== wasRunning) {
            wasRunning = stillRunning;
            onUpdate(stillRunning);
          }
        }
      } catch {
        // Non-fatal — keep polling
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  return () => { active = false; };
}
