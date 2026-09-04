/* managedAgentAction.ts — one parsed ReAct action (FINAL or tool) extracted
   from planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 22
   (ESLint ceiling 12). This module owns the step announcement, V6 FINAL
   gate, tool execution, stall/trace, aftermath. Does not import
   managedAgent.ts (cycle). */

import type { ActionEvent, PlanStep, ProofArtifact, ProofRequirement } from './types.js';
import type { TFunc } from './runtime.js';
import { emitBuffered } from '../journal/journal.js';
import { pruneStaleObservations } from './transcriptCompact.js';
import { dedupKeyFor } from './managedAgentDedup.js';
import { resolveManagedObservation } from './managedAgentExecute.js';
import { recordManagedTraceAndStall } from './managedAgentObserve.js';
import { applyManagedAftermath, type AftermathIo } from './managedAgentAftermath.js';
import { finishManagedFinal, captureManagedMissionEnd } from './managedAgentFinal.js';
import { advanceManagedMilestones } from './managedAgentLoopGuard.js';
import type { TraceBuffer } from './toolTraces.js';
import type { ToolCallRecord } from './loopGuard.js';
import type { AgentStepRecord } from './stuckDetector.js';
import type { ToolPolicy } from './managedAgentPolicy.js';
import type { AgentPermissionMode } from './managedToolPermissions.js';
import { SteeringPipeline } from './lazyReasoningBlocks/index.js';

type ChatMessage = { role: string; content: string };

export type ManagedActionResult =
  | 'stop'
  | {
      kind: 'next';
      messages: ChatMessage[];
      reflections: string[];
      consecutiveFailures: number;
      prmInvocations: number;
      proofNudges: number;
      toolCallCount: number;
    };

export interface ManagedActionOpts {
  action: string;
  args: Record<string, unknown>;
  cleaned: string;
  messages: ChatMessage[];
  reflections: string[];
  consecutiveFailures: number;
  proofNudges: number;
  prmInvocations: number;
  prmMax: number;
  toolCallCount: number;
  step: number;
  maxSteps: number;
  maxProofNudges: number;
  maxConsecutiveFailures: number;
  proofRequirements?: ProofRequirement[];
  attachedProofs: ProofArtifact[];
  executedCallsAtStep: Map<string, number>;
  worktreePath: string;
  policy: ToolPolicy;
  agentMode: AgentPermissionMode;
  missionId: string;
  missionTitle: string;
  agentName?: string;
  projectId: string;
  coreTask: string;
  model: string;
  t?: TFunc;
  nowTime: () => string;
  onAction: (event: ActionEvent) => void;
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onProgress: (pct: number) => void;
  emitMetrics: (outcome: { type: 'completed' } | { type: 'failed'; reason: string }) => void;
  attachProof: (args: Record<string, unknown>) => Promise<string>;
  execute: Parameters<typeof resolveManagedObservation>[0]['execute'];
  traceBuffer: TraceBuffer;
  pipeline: SteeringPipeline;
  toolCallHistory: ToolCallRecord[];
  stepHistory: AgentStepRecord[];
  aftermathIo: AftermathIo;
  initialUserMessage: ChatMessage;
}

export function announceManagedStep(opts: ManagedActionOpts): ChatMessage[] {
  const stepText = `[${opts.step + 1}] ${opts.action}: ${JSON.stringify(opts.args)}`;
  opts.onAction({ time: opts.nowTime(), text: stepText, isLive: true });
  emitBuffered({
    tsMs: Date.now(),
    projectId: opts.projectId,
    missionId: opts.missionId,
    actor: 'agent',
    type: 'mission.step',
    payload: { text: stepText.slice(0, 500) },
  });
  return [...opts.messages, { role: 'assistant', content: opts.cleaned }];
}

export async function runManagedAction(opts: ManagedActionOpts): Promise<ManagedActionResult> {
  const messages = announceManagedStep(opts);
  if (opts.action !== 'FINAL') return runManagedToolAction({ ...opts, messages });
  const finished = await finishManagedFinal({
    proofRequirements: opts.proofRequirements,
    attachedProofs: opts.attachedProofs,
    proofNudges: opts.proofNudges,
    maxProofNudges: opts.maxProofNudges,
    args: opts.args,
    t: opts.t,
    nowTime: opts.nowTime,
    onAction: opts.onAction,
    onStep: opts.onStep,
    onProgress: opts.onProgress,
    emitMetrics: opts.emitMetrics,
    capture: (summary) => captureManagedMissionEnd({
      missionId: opts.missionId,
      missionTitle: opts.missionTitle,
      coreTask: opts.coreTask,
      model: opts.model,
      summary,
      messages,
      processTraces: () => opts.traceBuffer.processAtMissionEnd(),
    }),
  });
  if (finished.flow !== 'continue') return 'stop';
  return {
    kind: 'next',
    messages: [...messages, { role: 'user', content: finished.bounceContent }],
    reflections: opts.reflections,
    consecutiveFailures: opts.consecutiveFailures,
    prmInvocations: opts.prmInvocations,
    proofNudges: finished.proofNudges,
    toolCallCount: opts.toolCallCount,
  };
}

async function runManagedToolAction(opts: ManagedActionOpts): Promise<ManagedActionResult> {
  const dedupKey = dedupKeyFor(opts.action, opts.args);
  const firstRanAtStep = dedupKey ? opts.executedCallsAtStep.get(dedupKey) : undefined;
  const wasDeduped = firstRanAtStep !== undefined;
  const executed = await resolveManagedObservation({ ...opts, wasDeduped, firstRanAtStep });
  const toolCallCount = opts.toolCallCount + executed.toolCallDelta;
  if (executed.recordDedup && dedupKey) opts.executedCallsAtStep.set(dedupKey, opts.step + 1);
  const observationContent = recordManagedTraceAndStall({
    wasDeduped,
    action: opts.action,
    args: opts.args,
    observation: executed.observation,
    traceBuffer: opts.traceBuffer,
    compress: (text) => opts.pipeline.compressOutput(text),
    toolCallHistory: opts.toolCallHistory,
  });
  opts.onAction({
    time: opts.nowTime(),
    text: `Observation: ${observationContent.slice(0, 120)}`,
    isLive: false,
  });
  const after = await applyManagedAftermath({
    io: opts.aftermathIo,
    observation: executed.observation,
    observationContent,
    action: opts.action,
    args: opts.args,
    messages: pruneStaleObservations([
      ...opts.messages,
      { role: 'user', content: `Observation: ${observationContent}` },
    ]),
    reflections: opts.reflections,
    consecutiveFailures: opts.consecutiveFailures,
    maxConsecutiveFailures: opts.maxConsecutiveFailures,
    stepHistory: opts.stepHistory,
    step: opts.step,
    prmInvocations: opts.prmInvocations,
    prmMax: opts.prmMax,
    initialUserMessage: opts.initialUserMessage,
  });
  if (after.flow === 'stop') return 'stop';
  opts.onProgress(Math.min(90, 15 + Math.round((opts.step / opts.maxSteps) * 75)));
  advanceManagedMilestones(opts.step, opts.maxSteps, opts.nowTime, opts.onStep);
  return {
    kind: 'next',
    messages: after.messages,
    reflections: after.reflections,
    consecutiveFailures: after.consecutiveFailures,
    prmInvocations: after.prmInvocations,
    proofNudges: opts.proofNudges,
    toolCallCount,
  };
}
