/* runMissionSettle — post-Step-B hard stops and recovery.

   Extracted because runMission's measured cyclomatic complexity was 83
   (2026-08-28 ESLint, after launch/worktree/fanout splits). Behavior is
   copied: cancel, budget/duration caps, one recovery retry, then managed
   step-cap fallthrough vs immediate fail. Never retry a cap crossing.
*/

import type { Mission, ActionEvent, AgentMetrics, PlanStep } from './types.js';
import type { TFunc, MissionUpdate } from './runtime.js';
import type { CompiledPlan } from './stageContract.js';
import { evaluateRecovery, delayMs, type RecoveryDecision } from './recovery.js';
import { detectQuotaExhaustion } from './quotaExhaustion.js';
import { translateStatusReason } from './statusReasonLabel.js';
import { isAgentErrorEvent, stripAgentErrorPrefix } from './agentError.js';
import { emitBuffered } from '../journal/journal.js';

export const STEP_CAP_FALLTHROUGH_REASONS = new Set(['max_steps_exhausted', 'consecutive_failures']);

export type SettleResult =
  | { kind: 'stop' }
  | { kind: 'continue'; stepCapFallthroughReason: string | null };

export interface AgentLoopRef {
  get timeline(): ActionEvent[];
  set timeline(v: ActionEvent[]);
  get steps(): PlanStep[];
  set steps(v: PlanStep[]);
  get agentFailed(): boolean;
  set agentFailed(v: boolean);
  get budgetExceeded(): boolean;
  set budgetExceeded(v: boolean);
  get durationExceeded(): boolean;
  set durationExceeded(v: boolean);
  get finalMetrics(): AgentMetrics | undefined;
  set finalMetrics(v: AgentMetrics | undefined);
  managedOutcome: { failed: { reason: string } | null };
}

export type CaptureOutcomeFn = (
  mission: Mission,
  projectId: string,
  status: Mission['status'],
  startedAt: number,
  metrics?: AgentMetrics,
  diffStats?: { filesChanged: number; linesAdded: number; linesRemoved: number },
  error?: { category?: string; message?: string },
) => unknown;

export interface SettleCapFn {
  (kind: 'budget_exceeded' | 'duration_exceeded', message: { text: string; reason: string }): Promise<void>;
}

export interface AfterLoopOpts {
  mission: Mission;
  projectId: string;
  branch: string;
  compiled: CompiledPlan;
  missionStartedAt: number;
  budgetCapUsd?: number;
  maxDurationMs?: number;
  t?: TFunc;
  onUpdate: (update: MissionUpdate) => void;
  stopSignal: () => boolean;
  cleanupWorktree: () => Promise<void>;
  settleCapExceeded: SettleCapFn;
  markSettled: () => void;
  runPass: () => Promise<void>;
  captureOutcome: CaptureOutcomeFn;
  formatBudget: (spentUsd: number, capUsd: number) => { text: string; reason: string };
  formatDuration: (elapsedMs: number, capMs: number) => { text: string; reason: string };
  loop: AgentLoopRef;
}

function clockHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tx(t: TFunc | undefined, key: string, fallback: string, params?: Record<string, string | number>): string {
  return t ? t(key, params) : fallback;
}

async function stopCancelled(opts: AfterLoopOpts): Promise<SettleResult> {
  opts.markSettled();
  await opts.cleanupWorktree();
  opts.onUpdate({
    id: opts.mission.id,
    patch: { status: 'cancelled', liveAction: tx(opts.t, 'agents.runtime.stopped', 'Stoppé') },
  });
  opts.captureOutcome(opts.mission, opts.projectId, 'cancelled', opts.missionStartedAt);
  return { kind: 'stop' };
}

async function stopCap(
  opts: AfterLoopOpts,
  kind: 'budget_exceeded' | 'duration_exceeded',
): Promise<SettleResult> {
  opts.markSettled();
  const message = kind === 'budget_exceeded'
    ? opts.formatBudget(opts.loop.finalMetrics?.costUsd ?? 0, opts.budgetCapUsd ?? 0)
    : opts.formatDuration(Date.now() - opts.missionStartedAt, opts.maxDurationMs ?? 0);
  await opts.settleCapExceeded(kind, message);
  return { kind: 'stop' };
}

function recoveryForFailure(opts: AfterLoopOpts): {
  decision: RecoveryDecision;
  quotaInfo: ReturnType<typeof detectQuotaExhaustion>;
  errorMsg: string;
} {
  const errorEvent = opts.loop.timeline.find((e) => isAgentErrorEvent(e));
  const errorMsg = errorEvent?.text ?? 'Agent error';
  const quotaInfo = detectQuotaExhaustion(errorMsg);
  const implement = opts.compiled.graph.stages.find((s) => s.kind === 'implement') ?? opts.compiled.graph.stages[0];
  const decision = opts.loop.managedOutcome.failed?.reason === 'no_credits'
    ? { action: 'block' as const, delayMs: 0, reason: stripAgentErrorPrefix(errorMsg) }
    : evaluateRecovery(implement, errorMsg, opts.t);
  return { decision, quotaInfo, errorMsg };
}

function reportQuotaBackoff(mission: Mission, resetAtMs: number | undefined): void {
  void (async () => {
    try {
      const { reportQuotaExhausted, resolveProvider } = await import('./scheduler.js');
      reportQuotaExhausted(resolveProvider(mission), resetAtMs);
    } catch {
      // Best-effort — recovery already blocked THIS mission from retrying.
    }
  })();
}

async function failNoRetry(
  opts: AfterLoopOpts,
  fail: {
    reasonText: string;
    category: string;
    statusReason?: string;
    emitFailedEvent?: boolean;
    quotaInfo?: ReturnType<typeof detectQuotaExhaustion>;
  },
): Promise<SettleResult> {
  opts.markSettled();
  await opts.cleanupWorktree();
  const errorTimeline: ActionEvent[] = [
    ...opts.loop.timeline.map((e) => ({ ...e, isLive: false })),
    { time: clockHm(), text: fail.reasonText, isLive: false },
  ];
  opts.onUpdate({
    id: opts.mission.id,
    patch: {
      status: 'failed',
      progress: 100,
      liveAction: undefined,
      ...(fail.statusReason !== undefined ? { statusReason: fail.statusReason } : {}),
      actionTimeline: errorTimeline,
      worktree: opts.branch,
    },
  });
  if (fail.emitFailedEvent !== false) {
    emitBuffered({
      type: 'mission.failed',
      tsMs: Date.now(),
      projectId: opts.projectId,
      missionId: opts.mission.id,
      actor: 'agent',
      payload: { reason: fail.reasonText },
    });
  }
  if (fail.quotaInfo) {
    emitBuffered({
      type: 'mission.quota_exhausted',
      tsMs: Date.now(),
      projectId: opts.projectId,
      missionId: opts.mission.id,
      actor: 'agent',
      payload: { reason: fail.reasonText, resetAtMs: fail.quotaInfo.resetAtMs },
    });
    reportQuotaBackoff(opts.mission, fail.quotaInfo.resetAtMs);
  }
  opts.captureOutcome(opts.mission, opts.projectId, 'failed', opts.missionStartedAt, opts.loop.finalMetrics, undefined, {
    category: fail.category,
    message: fail.reasonText,
  });
  return { kind: 'stop' };
}

async function retryThenResettle(opts: AfterLoopOpts, retryReason: string, delay: number): Promise<SettleResult> {
  opts.onUpdate({
    id: opts.mission.id,
    patch: {
      liveAction: `Retry: ${retryReason}`,
      actionTimeline: [
        ...opts.loop.timeline.map((e) => ({ ...e, isLive: false })),
        { time: clockHm(), text: `↻ ${retryReason}`, isLive: true },
      ],
    },
  });
  await delayMs(delay);
  opts.loop.agentFailed = false;
  await opts.runPass();
  if (opts.loop.budgetExceeded) return stopCap(opts, 'budget_exceeded');
  if (opts.loop.durationExceeded) return stopCap(opts, 'duration_exceeded');
  if (!opts.loop.agentFailed) return { kind: 'continue', stepCapFallthroughReason: null };
  return failNoRetry(opts, {
    reasonText: tx(
      opts.t,
      'agents.runtime.missionFailedAfterRetry',
      'Mission échouée après retry — voir les logs agent',
    ),
    category: 'agent_failed',
  });
}

async function settleAgentFailed(opts: AfterLoopOpts): Promise<SettleResult> {
  const { decision, quotaInfo } = recoveryForFailure(opts);
  const attempts = opts.compiled.graph.stages.find((s) => s.kind === 'implement')?.attemptCount ?? 0;
  if (decision.action === 'retry' && attempts < 3) {
    return retryThenResettle(opts, decision.reason, decision.delayMs);
  }
  const reasonText = tx(
    opts.t,
    'agents.runtime.missionFailedReason',
    `Mission échouée — ${decision.reason}`,
    { reason: decision.reason },
  );
  return failNoRetry(opts, {
    reasonText,
    category: quotaInfo ? 'quota_exhausted' : (decision.action ?? 'blocked'),
    statusReason: reasonText,
    quotaInfo: quotaInfo ?? undefined,
  });
}

async function settleManagedFailed(opts: AfterLoopOpts): Promise<SettleResult> {
  const failed = opts.loop.managedOutcome.failed;
  if (!failed) return { kind: 'continue', stepCapFallthroughReason: null };
  if (!STEP_CAP_FALLTHROUGH_REASONS.has(failed.reason)) {
    const translated = translateStatusReason(failed.reason, opts.t) ?? failed.reason;
    return failNoRetry(opts, {
      reasonText: translated,
      category: failed.reason,
      statusReason: translated,
      emitFailedEvent: false,
    });
  }
  opts.loop.timeline = [
    ...opts.loop.timeline.map((e) => ({ ...e, isLive: false })),
    {
      time: clockHm(),
      text: `Step cap reached (${failed.reason}) — checking worktree for a salvageable deliverable`,
      isLive: false,
    },
  ];
  return { kind: 'continue', stepCapFallthroughReason: failed.reason };
}

/** Returns 'stop' when the caller must return; otherwise continue into Step C. */
export async function settleAfterAgentLoop(opts: AfterLoopOpts): Promise<SettleResult> {
  if (opts.stopSignal()) return stopCancelled(opts);
  if (opts.loop.budgetExceeded) return stopCap(opts, 'budget_exceeded');
  if (opts.loop.durationExceeded) return stopCap(opts, 'duration_exceeded');
  if (opts.loop.agentFailed) {
    const failed = await settleAgentFailed(opts);
    if (failed.kind === 'stop') return failed;
  }
  return settleManagedFailed(opts);
}
