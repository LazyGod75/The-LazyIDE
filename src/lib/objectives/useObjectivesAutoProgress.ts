/* useObjectivesAutoProgress.ts — B9: keeps project-linked CAP objectives'
   currentCount in sync with real MERGED missions (journal event type
   'mission.approved') for their linked project, since the objective's own
   creation timestamp. Manual override (objectivesDerive.ts) freezes a
   linked objective at its last manually-set value.

   Pure I/O glue around objectivesDerive.ts's pure derivation — polls
   journalQuery (the existing fleet/journal read model, see fleetMissions.ts
   and usePersonalKpis.ts for the same 'mission.approved' precedent) and
   writes back through objectivesStore's updateObjective, which already
   persists + notifies subscribers (live ring/status update).
*/

import { useEffect } from 'react';
import { journalQuery } from '../journal/journal.js';
import { updateObjective, type Objective } from './objectivesStore.js';
import { deriveCurrentCount, shouldPersistDerivedCount } from './objectivesDerive.js';

const POLL_MS = 5000;

async function syncOne(objective: Objective): Promise<void> {
  if (!objective.projectId || objective.manualOverride) return;

  const events = await journalQuery({
    projectId: objective.projectId,
    types: ['mission.approved'],
    sinceMs: objective.createdAtMs,
  });

  if (!shouldPersistDerivedCount(objective, events.length)) return;

  await updateObjective(objective.id, {
    currentCount: deriveCurrentCount(objective, events.length),
  });
}

/**
 * Keeps every project-linked, non-overridden objective's currentCount in
 * sync with real merged-mission counts. Safe to call unconditionally — a
 * no-op when `objectives` has nothing linked (the screenshot/test harness
 * path via CapObjectives's objectivesOverride never reaches this hook with
 * real projectIds, so it stays inert there too).
 */
export function useObjectivesAutoProgress(objectives: readonly Objective[]): void {
  useEffect(() => {
    const linked = objectives.filter((o) => o.projectId && !o.manualOverride);
    if (linked.length === 0) return;

    let cancelled = false;

    async function tick() {
      for (const objective of linked) {
        if (cancelled) return;
        await syncOne(objective).catch(() => {
          // best-effort — a transient journal failure must not break the UI
        });
      }
    }

    void tick();
    const intervalId = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-derives its own `linked` list from `objectives` every run; including the derived array itself would re-create it every render
  }, [objectives]);
}
