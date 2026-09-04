/* journalMissions.ts — shared journal snapshot reader, extracted out of
   chainEngine.ts (its Phase 5 "GUTTED" compat-shim state, see that module's
   header) so sgrChainRunner.ts can read the SAME real, journal-sourced
   mission snapshot without importing chainEngine.ts back — chainEngine.ts
   itself imports FROM sgrChainRunner.ts (re-exporting initSgrChainRunner/
   onMissionTerminalSGR under their old names), so a reverse import would be
   a circular module dependency. This file has no runtime dependency on
   either chainEngine.ts or sgrChainRunner.ts — both import it.

   chainEngine.ts still re-exports `fetchAllJournalMissions` from here
   unchanged, so contestEngine.ts's existing import site needs no change.
*/

import type { Mission } from './types.js';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../platform/index.js';

interface MissionCurrentRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

/** One journal-sourced mission fact plus the row's own update timestamp —
 *  the wire shape every reconcile/join/contest consumer in this codebase
 *  reads (contestEngine.ts and joinEngine.ts each keep a structurally
 *  identical local copy of this shape to avoid importing it directly and
 *  risking a cycle; this is the one canonical definition). */
export interface JournalMissionEntry {
  mission: Mission;
  updatedMs: number;
}

function isMissionLike(value: unknown): value is Mission {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string';
}

/** Reads every mission's CURRENT journal-projected state. Never throws —
 *  a Tauri invoke failure or a corrupt row is logged/skipped, never
 *  propagated, since every caller uses this as a best-effort snapshot for
 *  reconciliation, not a source of truth that must succeed. */
export async function fetchAllJournalMissions(): Promise<JournalMissionEntry[]> {
  if (!isTauri()) return [];
  let rows: MissionCurrentRow[];
  try {
    const result = await invoke<MissionCurrentRow[]>('journal_missions_current');
    rows = Array.isArray(result) ? result : [];
  } catch (err: unknown) {
    console.warn('[journalMissions] journal_missions_current failed:', err);
    return [];
  }

  const out: JournalMissionEntry[] = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue; // one corrupt row must never break the whole reconcile
    }
    if (!isMissionLike(parsed)) continue;
    out.push({ mission: parsed, updatedMs: row.updated_ms });
  }
  return out;
}
