/* missionsProjection.ts — boot-time projection: loads the current mission
   list for a project from the event journal's materialized `missions_current`
   table (Rust's `journal_missions_current`, journal.rs) instead of the
   legacy `.lazy/missions.json` snapshot (T0.5, spec §4.3).

   This is deliberately the ONLY thing this module does — the migration that
   populates the journal from legacy data on a project's first boot after
   this feature ships lives in `./migrate.ts`; the boot-order decision
   (journal first, migrate-then-retry, legacy fallback) lives in
   agentsStore.tsx, the sole caller.

   Never throws: a journal read failure (invoke rejection, e.g. the command
   is unavailable outside a real Tauri runtime) is treated identically to
   "no rows yet" — both resolve to `null` — so a boot never hard-fails on a
   journal hiccup and the caller's legacy fallback still gets a chance to
   load something.
*/

import { invoke } from '@tauri-apps/api/core';
import type { Mission } from '../agents/types.js';

/** Wire shape of one row from `journal_missions_current` (journal.rs's
 *  `MissionCurrentOut`, serialized as-is — no camelCase conversion since
 *  Tauri's command return values are NOT auto-converted, only argument
 *  names are). */
interface MissionCurrentRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

/** Guard: a parsed `data` blob must at least look like a Mission (has a
 *  string `id`) before we trust it — mirrors agentsStore.tsx's own
 *  `parseMissionsJson` shape-check for the legacy path. */
function isMissionLike(value: unknown): value is Mission {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

/**
 * Loads every mission currently tracked in the journal for `projectId`.
 *
 * Returns `null` when the journal has ZERO rows for this project — the
 * signal callers use to attempt the one-shot legacy migration (see
 * migrate.ts) before falling back to missions.json entirely. Returns the
 * parsed `Mission[]` otherwise, defensively skipping (with a
 * `console.warn`) any row whose `data` isn't parseable JSON or doesn't look
 * like a Mission — one corrupt row must never take down the whole boot.
 */
export async function loadMissionsFromJournal(projectId: string): Promise<Mission[] | null> {
  let rows: MissionCurrentRow[] | undefined;
  try {
    rows = await invoke<MissionCurrentRow[]>('journal_missions_current', { projectId });
  } catch (err: unknown) {
    console.warn('[missionsProjection] journal_missions_current failed:', err);
    return null;
  }

  if (!rows || rows.length === 0) return null;

  const missions: Mission[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch (err: unknown) {
      console.warn('[missionsProjection] skipping unparseable mission row', row.mission_id, err);
      continue;
    }
    if (!isMissionLike(parsed)) {
      // B3 fix (2026-08-04, real prod rows M3-testeur/M4-testeur): a row
      // shaped `{missionId: X}` with no `id` is journal.rs's OWN
      // INSERT-OR-IGNORE placeholder (apply_mission_projection's
      // `placeholder_data`) for a mission_id that received a status-only
      // event (e.g. mission.step/mission.blocked) before any
      // snapshot-carrying one — an expected, benign shape, not corrupt
      // data, and nothing in this app ever resolves it into a real
      // snapshot on its own. Warning on every single boot for a row that
      // will never change is just noise; only a row that fails to even
      // look like THAT (an object with neither `id` nor `missionId`, or a
      // non-object) is genuinely unexpected and still worth flagging.
      const isKnownPlaceholder =
        typeof parsed === 'object' && parsed !== null && 'missionId' in parsed && !('id' in parsed);
      if (!isKnownPlaceholder) {
        console.warn('[missionsProjection] skipping non-Mission-shaped mission row', row.mission_id);
      }
      continue;
    }
    missions.push(parsed);
  }

  return missions;
}
