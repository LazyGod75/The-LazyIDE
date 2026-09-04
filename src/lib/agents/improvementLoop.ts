/* improvementLoop.ts — Self-improvement loop per project (Pillar D5).
   Observes recent outcomes, diagnoses failures, captures patterns and suggests
   or schedules fix missions based on what the Brain knows.
*/

import { getProject, getAllProjects } from './globalRuntime.js';
import { observeMissionOutcome } from './observationEngine.js';
import { diagnose } from './diagnosisEngine.js';
import { capturePattern } from './learningCapture.js';
import { getEffectiveAutonomy } from './autonomyMode.js';
import { noteDiagnosis } from './brainNotation.js';

export interface ImprovementSuggestion {
  projectId: string;
  task: string;
  confidence: number;
  reason: string;
}

export async function runImprovementLoop(
  projectId: string,
  projectRoot?: string,
  autonomy?: import('./types.js').AutonomyConfig,
): Promise<ImprovementSuggestion[]> {
  const state = getProject(projectId);
  if (!state) return [];

  const config = getEffectiveAutonomy(autonomy);
  const recent = state.missions
    .filter((m) => m.status === 'failed' || m.status === 'done')
    .slice(-20);

  const suggestions: ImprovementSuggestion[] = [];

  for (const mission of recent) {
    const outcome = observeMissionOutcome(mission, projectId, projectRoot);
    capturePattern(`status:${outcome.status}`, outcome.agentName ?? 'unknown', outcome, projectId, outcome.agentName);

    if (outcome.status === 'failed') {
      const diagnosis = await diagnose(outcome, projectRoot);
      noteDiagnosis({ errorCategory: diagnosis.category, rootCause: diagnosis.rootCause, suggestedFix: diagnosis.suggestedFix, confidence: diagnosis.confidence, projectRoot });

      if (diagnosis.confidence > 0.6 && (config.mode === 'supervised' || config.mode === 'yolo')) {
        suggestions.push({
          projectId,
          task: `Fix ${diagnosis.category}: ${diagnosis.suggestedFix}`,
          confidence: diagnosis.confidence,
          reason: `Detected ${diagnosis.rootCause}`,
        });
      }
    }
  }

  return suggestions;
}

export async function runGlobalImprovementLoop(autonomy?: import('./types.js').AutonomyConfig): Promise<ImprovementSuggestion[]> {
  const all: ImprovementSuggestion[] = [];
  for (const project of getAllProjects()) {
    const suggestions = await runImprovementLoop(project.projectId, project.projectRoot, autonomy);
    all.push(...suggestions);
  }
  return all;
}
