/* learningStage — execute the compiled plan's learning stage after
   the ReAct / review pipeline finishes.

   compilePlan always appends a `kind: 'learning'` stage, but the live
   engine is ReAct (not a stage runner). This module bridges them: mark
   execution stages done, gate on isLearningReady, run runLearningLoop,
   then completeStage(learning). */

import type { Mission } from './types.js';
import type { TFunc } from './runtime.js';
import {
  completeStage,
  isLearningReady,
  type CompiledPlan,
} from './stageContract.js';
import { runLearningLoop, type LearningInsight, type LearningResult } from './learningLoop.js';

/** Mark every non-learning stage done so isLearningReady can fire after
 *  the ReAct loop (which does not advance stage.state itself). */
export function markExecutionStagesDone(plan: CompiledPlan): CompiledPlan {
  const now = new Date().toISOString();
  return {
    ...plan,
    graph: {
      ...plan.graph,
      stages: plan.graph.stages.map((s) =>
        s.kind === 'learning' || s.state === 'done' || s.state === 'skipped'
          ? s
          : { ...s, state: 'done', completedAt: now },
      ),
    },
  };
}

export interface LearningStageResult {
  plan?: CompiledPlan;
  insights: LearningInsight[];
  learningResult: LearningResult | null;
  ran: boolean;
}

/**
 * Run the compiled learning stage when ready. Always returns an updated
 * plan (execution stages marked done even if learning was already done
 * or absent) so callers can persist compiledPlan honestly.
 */
export async function executeLearningStage(
  plan: CompiledPlan | undefined,
  mission: Mission,
  t?: TFunc,
): Promise<LearningStageResult> {
  if (!plan) {
    const learningResult = await runLearningLoop(mission, undefined, t);
    return {
      insights: learningResult.insights,
      learningResult,
      ran: true,
    };
  }

  let next = markExecutionStagesDone(plan);
  if (!isLearningReady(next)) {
    return { plan: next, insights: [], learningResult: null, ran: false };
  }

  const learning = next.graph.stages.find((s) => s.kind === 'learning');
  const learningResult = await runLearningLoop(mission, next, t);
  if (learning) {
    next = completeStage(next, learning.id);
  }
  return {
    plan: next,
    insights: learningResult.insights,
    learningResult,
    ran: true,
  };
}
