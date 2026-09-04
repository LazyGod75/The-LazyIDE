/* observationEngine.ts — Capture mission outcomes for learning (Pillar D2).
   Builds a MissionOutcome from a Mission and writes it into the Brain.
*/

import type { Mission, MissionOutcome } from './types.js';
import { noteMissionOutcome, missionToOutcome } from './brainNotation.js';

export function observeMissionOutcome(mission: Mission, projectId: string, projectRoot?: string): MissionOutcome {
  const outcome = missionToOutcome(mission, projectId);
  outcome.durationMs = mission.agentMetrics?.durationMs;
  if (mission.agentMetrics?.costUsd) {
    outcome.costCents = Math.round(mission.agentMetrics.costUsd * 100);
  }
  noteMissionOutcome(outcome, projectRoot);
  return outcome;
}
