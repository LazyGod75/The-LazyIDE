/* managerNote.ts — real "manager avoided a conflict" note for the Code
   space sidebar (design-code.md §4.5 "RÈGLE DU MANAGER"). The design mock's
   copy ("Deux agents écrivaient dans src/components — j'ai mis blog-cms en
   file pour éviter un conflit.") is backed here by a REAL journal event:
   scheduler.ts's scheduler.queued event with payload.reason ===
   'scope_conflict' (see preflight.ts's checkConflicts) — emitted only when
   the scheduler itself deferred a mission launch over a real predicted-scope
   overlap with a currently running mission. No synthesized/static copy: a
   project with no such event in its recent journal has no manager note at
   all (the section is omitted entirely — see CodeSidebarBrain.tsx).

   The exact overlapping FILE PATH is not persisted in this event's payload
   (only the conflicting mission ids are — see SchedulerQueuedPayload's doc
   comment in eventTypes.ts), so the note names the two missions rather than
   the design mock's literal path — the honest level of detail this real
   signal actually carries.
*/

import { journalQuery } from '../journal/journal.js';
import type { JournalEventRow, SchedulerQueuedPayload } from '../journal/eventTypes.js';

export interface ManagerNoteData {
  queuedMissionId: string;
  queuedTitle: string;
  conflictMissionId: string;
  conflictTitle: string;
  tsMs: number;
}

/**
 * Pure: scans journal rows (most-recent-first assumed NOT required — this
 * sorts internally) for the latest scope_conflict scheduler.queued event and
 * resolves both mission titles via `titleForMission`. Returns null when no
 * such event exists, or when the queued mission's own title can't be
 * resolved (its id is unknown to the caller's title map) — never fabricates
 * a placeholder title.
 */
export function extractLatestScopeConflict(
  rows: readonly JournalEventRow[],
  titleForMission: (id: string) => string | null,
): ManagerNoteData | null {
  const conflicts = rows
    .filter((r) => r.type === 'scheduler.queued' && r.mission_id)
    .map((r) => {
      let payload: SchedulerQueuedPayload;
      try {
        payload = JSON.parse(r.payload) as SchedulerQueuedPayload;
      } catch {
        return null;
      }
      if (payload.reason !== 'scope_conflict' || !payload.conflictsWith || payload.conflictsWith.length === 0) {
        return null;
      }
      return { row: r, payload };
    })
    .filter((x): x is { row: JournalEventRow; payload: SchedulerQueuedPayload } => x !== null)
    .sort((a, b) => b.row.ts_ms - a.row.ts_ms);

  for (const { row, payload } of conflicts) {
    const queuedTitle = titleForMission(row.mission_id!);
    const conflictId = payload.conflictsWith![0];
    const conflictTitle = titleForMission(conflictId);
    if (queuedTitle && conflictTitle) {
      return {
        queuedMissionId: row.mission_id!,
        queuedTitle,
        conflictMissionId: conflictId,
        conflictTitle,
        tsMs: row.ts_ms,
      };
    }
  }
  return null;
}

const MANAGER_NOTE_LOOKBACK = 30;

/**
 * Fetches the project's recent scheduler.queued events and resolves the
 * latest real scope-conflict, if any. `titleForMission` should be backed by
 * the caller's own live fleet-mission list (missions that already scrolled
 * out of that list resolve to null and are skipped by
 * extractLatestScopeConflict above — an honest "can't attribute this old
 * event to a known mission anymore" rather than a stale/fabricated title).
 */
export async function loadManagerNote(
  projectId: string,
  titleForMission: (id: string) => string | null,
): Promise<ManagerNoteData | null> {
  const rows = await journalQuery({ projectId, types: ['scheduler.queued'], limit: MANAGER_NOTE_LOOKBACK });
  return extractLatestScopeConflict(rows, titleForMission);
}
