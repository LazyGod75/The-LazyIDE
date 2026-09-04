/* captureOutcome — mission-end learning snapshot for runMission.

   Extracted from runtime.ts (mergedAgentMetrics cx 10, captureOutcome cx 10)
   so both sit on the ESLint ratchet. Behavior copied: synthetic diff file
   names when only counts exist, diagnose+capturePattern fire-and-forget.
*/

import type { Mission, MissionOutcome, AgentMetrics } from './types.js';
import { observeMissionOutcome } from './observationEngine.js';
import { diagnose } from './diagnosisEngine.js';
import { capturePattern } from './learningCapture.js';

function syntheticDiffFiles(
  diffStats: { filesChanged: number; linesAdded: number; linesRemoved: number },
): NonNullable<Mission['diffFiles']> {
  const n = Math.max(diffStats.filesChanged, 1);
  return Array.from({ length: diffStats.filesChanged }, (_, i) => ({
    filename: `file-${i}`,
    added: Math.ceil(diffStats.linesAdded / n),
    removed: Math.ceil(diffStats.linesRemoved / n),
  }));
}

function fromBaseMetrics(base: AgentMetrics | undefined, durationMs: number): AgentMetrics {
  if (!base) {
    return { durationMs, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCount: 0 };
  }
  return {
    durationMs,
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
    costUsd: base.costUsd,
    toolCount: base.toolCount,
  };
}

function mergedAgentMetrics(
  mission: Mission,
  metrics: AgentMetrics | undefined,
  durationMs: number,
): AgentMetrics {
  return fromBaseMetrics(metrics ?? mission.agentMetrics, durationMs);
}

function scheduleOutcomeLearning(
  mission: Mission,
  projectId: string,
  status: Mission['status'],
  outcome: MissionOutcome,
): void {
  void (async () => {
    if (status === 'failed' || status === 'cancelled') {
      await diagnose(outcome);
    }
    const task = mission.title?.slice(0, 60) ?? 'unknown';
    capturePattern(`task:${task}`, outcome.agentName ?? 'unknown', outcome, projectId, outcome.agentName);
  })().catch((err: unknown) => {
    console.error('[captureOutcome] failed to capture diagnosis/learning:', err);
  });
}

export function captureOutcome(
  mission: Mission,
  projectId: string,
  status: Mission['status'],
  startedAt: number,
  metrics?: AgentMetrics,
  diffStats?: { filesChanged: number; linesAdded: number; linesRemoved: number },
  error?: { category?: string; message?: string },
): MissionOutcome {
  const durationMs = Date.now() - startedAt;
  const agentMetrics = mergedAgentMetrics(mission, metrics, durationMs);
  const outcome = observeMissionOutcome(
    {
      ...mission,
      agentMetrics,
      statusReason: error?.message ?? mission.statusReason,
      diffAdded: diffStats?.linesAdded,
      diffRemoved: diffStats?.linesRemoved,
      diffFiles: diffStats ? syntheticDiffFiles(diffStats) : undefined,
    },
    projectId,
  );
  if (error?.category) outcome.errorCategory = error.category;
  if (error?.message) outcome.errorMessage = error.message;
  scheduleOutcomeLearning(mission, projectId, status, outcome);
  return outcome;
}
