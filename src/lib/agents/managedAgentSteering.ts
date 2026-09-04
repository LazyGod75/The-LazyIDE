/* managedAgentSteering.ts — LazyReasoningBlocks post-turn steering extracted
   from planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 51
   (ESLint ceiling 12). This module owns FSM/monitors/E-trace injection,
   the manager stuck event, and the early-exit notice. Non-blocking:
   a pipeline throw leaves messages unchanged. Does not import
   managedAgent.ts (cycle). */

import type { ActionEvent } from './types.js';
import { emit as busEmit } from '../bus.js';
import { SteeringPipeline, type TaskProfile } from './lazyReasoningBlocks/index.js';

type ChatMessage = { role: string; content: string };

export async function applyManagedSteering(opts: {
  pipeline: SteeringPipeline;
  messages: ChatMessage[];
  turnText: string;
  step: number;
  coreTask: string;
  projectId: string;
  missionId: string;
  model: string;
  nowTime: () => string;
  onAction: (event: ActionEvent) => void;
}): Promise<ChatMessage[]> {
  const stepTexts = opts.messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .slice(-10);
  try {
    const steeringResult = await opts.pipeline.run({
      step: opts.step,
      stepText: opts.turnText,
      recentSteps: stepTexts,
      totalSteps: opts.step + 1,
      originalTask: opts.coreTask,
      projectId: opts.projectId,
      model: opts.model,
      profile: 'coding' as TaskProfile,
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });
    let messages = opts.messages;
    if (steeringResult.injection) {
      messages = [...messages, { role: 'user', content: steeringResult.injection }];
    }
    if (steeringResult.earlyExitNudge) {
      messages = [...messages, { role: 'user', content: steeringResult.earlyExitNudge }];
    }
    if (steeringResult.isStuck && steeringResult.stuckDetail) {
      busEmit('lazyreasoning:stuck', {
        missionId: opts.missionId,
        fsmState: steeringResult.stuckDetail.fsmState,
        consecutiveHardSteps: steeringResult.stuckDetail.consecutiveHardSteps,
        failureType: steeringResult.stuckDetail.lastFailureType,
        task: opts.coreTask,
      });
    }
    if (steeringResult.shouldEarlyExit && opts.step >= 5) {
      opts.onAction({
        time: opts.nowTime(),
        text: '[LazyReasoningBlocks] Early-exit triggered — task appears complete',
        isLive: false,
      });
    }
    return messages;
  } catch {
    return opts.messages;
  }
}

export async function maybeWriteManagedCheckpoint(opts: {
  projectRoot?: string;
  onCheckpoint?: (id: string, turn: number) => void;
  missionId: string;
  messages: ChatMessage[];
  step: number;
  costUsd: number;
  proofCount: number;
}): Promise<void> {
  if (!opts.projectRoot || !opts.onCheckpoint) return;
  try {
    const { writeCheckpoint } = await import('./graph/checkpointStore.js');
    const cp = await writeCheckpoint(opts.projectRoot, opts.missionId, {
      messages: opts.messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant' | 'tool',
        content: m.content,
      })),
      turn: opts.step,
      costUsd: opts.costUsd,
      toolCallCount: opts.step,
      proofCount: opts.proofCount,
      missionStatus: 'running',
      label: `Turn ${opts.step + 1}`,
    }, {
      missionId: opts.missionId,
      engine: 'managed',
      label: `Turn ${opts.step + 1}`,
    });
    opts.onCheckpoint(cp.id, opts.step);
  } catch {
    // Checkpoint failure is non-fatal — continue the loop
  }
}
