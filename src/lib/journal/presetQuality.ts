/* presetQuality.ts — Per-preset (agentName) quality projection (Pillar D5 v1
   / Layer-3 preset-evolution feed). Pure TS-side join of journal
   gate.passed{score}/mission.completed/failed/reverted events against
   Missions by `agentName` — unlike projections.ts's fleet/attention/activity
   wrappers (which call a dedicated Rust aggregation command), there is no
   `journal_preset_quality` command: a journal event carries `mission_id`,
   never `agentName`, and Mission.agentName is only known client-side — so
   this join has to happen here, not in Rust. No UI consumes this yet.
*/

import type { GatePassedPayload, JournalEventRow, MissionRevertedPayload } from './eventTypes.js';
import type { Mission } from '../agents/types.js';

export interface PresetQuality {
  agentName: string;
  /** mission.completed + mission.failed events for this agent's missions. */
  runs: number;
  /**
   * Average of every real `gate.passed` score seen for this agent's
   * missions. Undefined — never 0 or a fabricated guess — when no
   * `gate.passed` event carried a score (GatePassedPayload.score is itself
   * optional; see eventTypes.ts).
   */
  avgJudgeScore?: number;
  /** mission.reverted{merged: true} only — a dropped UNMERGED worktree
   *  (merged: false) never shipped, so it is not a quality signal about
   *  what this preset actually merged (same interpretation frictionMiner.ts
   *  uses for its own 'merge' pathology candidate). */
  revertedCount: number;
}

function parsePayload<T>(row: JournalEventRow): T | undefined {
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return undefined;
  }
}

/**
 * Joins `events` against `missions` by `agentName`. Pure — no I/O; callers
 * fetch `missions`/`events` themselves (globalRuntime.ts / journalQuery).
 */
export function queryPresetQuality(
  agentName: string,
  missions: readonly Mission[],
  events: readonly JournalEventRow[],
): PresetQuality {
  const ownedMissionIds = new Set(missions.filter((m) => m.agentName === agentName).map((m) => m.id));

  let runs = 0;
  let revertedCount = 0;
  const scores: number[] = [];

  for (const row of events) {
    if (!row.mission_id || !ownedMissionIds.has(row.mission_id)) continue;

    if (row.type === 'mission.completed' || row.type === 'mission.failed') {
      runs += 1;
    } else if (row.type === 'mission.reverted') {
      if (parsePayload<MissionRevertedPayload>(row)?.merged) revertedCount += 1;
    } else if (row.type === 'gate.passed') {
      const score = parsePayload<GatePassedPayload>(row)?.score;
      if (typeof score === 'number') scores.push(score);
    }
  }

  return {
    agentName,
    runs,
    avgJudgeScore: scores.length > 0 ? scores.reduce((sum, s) => sum + s, 0) / scores.length : undefined,
    revertedCount,
  };
}
