/* runMissionFinish — Steps C, E, F after the agent loop settles.

   Extracted because these branches counted toward runMission's measured
   cyclomatic complexity (15 after the route split, 2026-08-28 ESLint).
*/

import type { Mission, ActionEvent, AgentMetrics } from './types.js';
import type { PermissionMode, TFunc, MissionUpdate } from './runtime.js';
import type { CompiledPlan } from './stageContract.js';
import type { CaptureOutcomeFn, SettleResult } from './runMissionSettle.js';
import { fanOutOrchestratorSubAgents } from './runMissionFanout.js';
import {
  failEmptyStepCapDeliverable,
  announceReviewReady,
  runAutomatedEvaluation,
  type MissionDiffSlice,
} from './runMissionReview.js';

export interface FinishAfterLoopOpts {
  afterLoop: SettleResult;
  mission: Mission;
  repoPath: string;
  worktreePath: string;
  projectId: string;
  branch: string;
  compiled: CompiledPlan;
  missionStartedAt: number;
  finalMetrics?: AgentMetrics;
  timeline: ActionEvent[];
  t?: TFunc;
  onUpdate: (update: MissionUpdate) => void;
  permissionMode?: PermissionMode;
  tool: string;
  model: string;
  captureOutcome: CaptureOutcomeFn;
  computeDiff: (worktreePath: string, mission: Mission) => Promise<MissionDiffSlice>;
  markSettled: () => void;
  cleanupWorktree: () => Promise<void>;
}

export async function finishMissionAfterAgentLoop(opts: FinishAfterLoopOpts): Promise<void> {
  if (opts.afterLoop.kind === 'stop') return;
  opts.markSettled();
  const diff = await opts.computeDiff(opts.worktreePath, opts.mission);
  const stepCap = opts.afterLoop.stepCapFallthroughReason;
  if (stepCap && diff.emptyDeliverable) {
    await failEmptyStepCapDeliverable({
      mission: opts.mission,
      projectId: opts.projectId,
      branch: opts.branch,
      timeline: opts.timeline,
      stepCapFallthroughReason: stepCap,
      missionStartedAt: opts.missionStartedAt,
      finalMetrics: opts.finalMetrics,
      t: opts.t,
      onUpdate: opts.onUpdate,
      cleanupWorktree: opts.cleanupWorktree,
      captureOutcome: opts.captureOutcome,
    });
    return;
  }
  const finalTimeline = announceReviewReady({
    mission: opts.mission,
    projectId: opts.projectId,
    branch: opts.branch,
    timeline: opts.timeline,
    diff,
    stepCapFallthroughReason: stepCap,
    missionStartedAt: opts.missionStartedAt,
    finalMetrics: opts.finalMetrics,
    t: opts.t,
    onUpdate: opts.onUpdate,
    captureOutcome: opts.captureOutcome,
  });
  await fanOutOrchestratorSubAgents({
    mission: opts.mission,
    repoPath: opts.repoPath,
    parentWorktreePath: opts.worktreePath,
    projectId: opts.projectId,
    tool: opts.tool,
    model: opts.model,
    permissionMode: opts.permissionMode,
    onUpdate: opts.onUpdate,
  });
  await runAutomatedEvaluation({
    mission: opts.mission,
    repoPath: opts.repoPath,
    worktreePath: opts.worktreePath,
    compiled: opts.compiled,
    diff,
    finalTimeline,
    t: opts.t,
    onUpdate: opts.onUpdate,
  });
}
