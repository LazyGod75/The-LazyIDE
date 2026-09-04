/* runLazyBotMission — the LazyBot runtime.

   Agent ≠ LazyBot. A local code agent runs in a git worktree with the
   repo's own tools (files, git, tests) through the CLI / Pro / BYOK rails
   and ends in a diff to review and merge. A LazyBot is a Solari cloud
   computer (browser / desktop VM / sandbox): its tools are cloud_browser_* /
   cloud_desktop_* / cloud_sandbox_* (plus the three documented local file
   tools to save a result), and its deliverable is a REPORT — the FINAL
   answer — never a branch. So none of the code-agent lifecycle applies:
   no worktree, no branch, no diff, no review/merge step, no automated
   evaluation, no `claude -p` process. runMission (runtime.ts) diverts every
   mission carrying `botId` here before touching any of that machinery.

   What IS shared is planAndActManaged — Lazy's own ReAct loop, the only
   place the cloud_* tools exist. The LLM behind that loop is whatever rail
   the bot's model resolves to (botRunModel.ts): BYOK (the user's key), CLI
   (claude/codex as a text backend — cliAgentTurnStreamer.ts), Pro (ai-proxy)
   or the free tier. The rail changes the bot's brain, never its runtime.
*/

import type { Mission, ActionEvent, AgentMetrics, PlanStep } from '../agents/types.js';
import type { RunOptions, MissionUpdate, TFunc } from '../agents/runtime.js';
import {
  formatBudgetExceededMessage,
  formatDurationExceededMessage,
} from '../agents/runtime.js';
import { withRunDefaults } from '../agents/runMissionOpts.js';
import { planAndActManaged, type PlanAndActManagedOpts } from '../agents/managedAgent.js';
import { createCliAgentTurnStreamer, resolveCliEngineMode, type AgentTurnStreamer } from '../agents/cliAgentTurnStreamer.js';
import { captureOutcome } from '../agents/captureOutcome.js';
import { translateStatusReason } from '../agents/statusReasonLabel.js';
import { emitEvent } from '../journal/journal.js';
import { projectIdFromRoot } from '../journal/projectId.js';
import { recordBotCost } from './budgetGuard.js';
import { finalizeBotRunLearning } from './botLearning.js';
import { salvageReAct } from './salvageReAct.js';
import { registerBotToolHandlers } from './botToolHandlers.js';
import { openBotVmWindow } from '../solari/botVmWindows.js';
import {
  classifyBotModelRail,
  describeBotRailNotReady,
  firstReadyRailDefault,
  isBotRailReady,
  resolveBotByokStreamer,
  type BotModelRail,
} from './botRunModel.js';

/** Prefix the managed loop's FINAL handler puts on its timeline line (see
 *  managedAgentFinal.ts) — the bot's report is recovered from it. */
const AGENT_DONE_PREFIX = 'Agent done: ';
const AGENT_ERROR_PREFIX = 'Erreur agent:';

/** Managed-loop failure reasons that can mean "the brain never answered"
 *  (provider refused / no credits / every turn errored) rather than "the
 *  task failed". Combined with toolCount === 0 they trigger ONE brain
 *  failover onto another ready rail — a detected CLI whose account is not
 *  entitled, or a BYOK key that just got revoked, must not strand the bot. */
const BRAIN_FAILURE_REASONS = new Set(['consecutive_failures', 'provider_definitive_error', 'no_credits']);

export function isBrainFailure(
  failed: { reason: string } | null,
  metrics: Pick<AgentMetrics, 'toolCount'> | undefined,
): boolean {
  if (failed === null || !BRAIN_FAILURE_REASONS.has(failed.reason)) return false;
  // Provider / credits failures are brain-side even mid-run (C85).
  if (failed.reason === 'provider_definitive_error' || failed.reason === 'no_credits') return true;
  // consecutive_failures: only when no tools ran (otherwise the task itself failed).
  return (metrics?.toolCount ?? 0) === 0;
}

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function label(t: TFunc | undefined, key: string, fallback: string, params?: Record<string, string | number>): string {
  return t ? t(key, params) : fallback;
}

function initialBotSteps(t: TFunc | undefined): PlanStep[] {
  return [
    { label: label(t, 'agents.lazybot.stepSession', 'Ordinateur cloud Solari'), state: 'todo' },
    { label: label(t, 'agents.lazybot.stepRun', 'Exécution de la tâche'), state: 'todo' },
    { label: label(t, 'agents.lazybot.stepReport', 'Rapport final'), state: 'todo' },
  ];
}

// ── Brain rail ─────────────────────────────────────────────────────

interface BotBrain {
  rail: BotModelRail;
  model: string;
  /** undefined → the ai-proxy (Pro / free tier) inside planAndActManaged. */
  streamTurn: AgentTurnStreamer | undefined;
}

function wrapSalvage(stream: AgentTurnStreamer): AgentTurnStreamer {
  return async function* salvaged(opts) {
    let acc = '';
    for await (const chunk of stream(opts)) acc += chunk;
    yield salvageReAct(acc);
  };
}

function brainForRail(rail: BotModelRail, id: string): BotBrain | { error: string } {
  if (!isBotRailReady(rail)) return { error: describeBotRailNotReady(rail, id) };
  if (rail === 'byok') {
    const streamTurn = resolveBotByokStreamer(id);
    if (!streamTurn) return { error: describeBotRailNotReady('byok', id) };
    return { rail, model: id, streamTurn: wrapSalvage(streamTurn) };
  }
  if (rail === 'cli') {
    return { rail, model: id, streamTurn: wrapSalvage(createCliAgentTurnStreamer(resolveCliEngineMode())) };
  }
  return { rail, model: id, streamTurn: undefined };
}

function chargeBot(mission: Mission, metrics: AgentMetrics | undefined): void {
  if (mission.botId && metrics?.costUsd) recordBotCost(mission.botId, metrics.costUsd);
}

/** Resolves the text backend for the bot's model, or a human-readable
 *  reason it cannot run right now. Pure routing — never spawns anything. */
export function resolveBotBrain(model: string | undefined): BotBrain | { error: string } {
  const rail = classifyBotModelRail(model);
  if (!rail) {
    return { error: `Aucun rail de modèle exécutable pour "${model ?? ''}" (clé BYOK, CLI, Lazy Pro ou modèle gratuit).` };
  }
  return brainForRail(rail, model ?? '');
}

/** Another READY rail's default brain, skipping rails that already failed
 *  at run time. undefined when nothing else is available. */
export function resolveFallbackBrain(
  exclude: BotModelRail | ReadonlySet<BotModelRail>,
): BotBrain | undefined {
  const next = firstReadyRailDefault(exclude);
  if (!next) return undefined;
  const brain = brainForRail(next.rail, next.model);
  return 'error' in brain ? undefined : brain;
}

// ── Runtime ────────────────────────────────────────────────────────

export async function runLazyBotMission(
  mission: Mission,
  repoPath: string,
  rawOpts: RunOptions,
): Promise<void> {
  const opts = withRunDefaults(rawOpts);
  registerBotToolHandlers();
  const { onUpdate, stopSignal, signal, pauseSignal, drainIntervenes, getBudgetCapUsd, getMaxDurationMs, t } = opts;
  const projectId = projectIdFromRoot(repoPath);
  const startedAt = Date.now();
  const botName = mission.agentName ?? mission.title;

  let steps = initialBotSteps(t);
  let timeline: ActionEvent[] = [];
  let finalMetrics: AgentMetrics | undefined;
  let report: string | undefined;
  let agentError: string | undefined;
  let budgetExceeded = false;
  let durationExceeded = false;
  const managedOutcome: { failed: { reason: string } | null } = { failed: null };

  const pushTimeline = (text: string, isLive: boolean): void => {
    timeline = [...timeline.map((e) => ({ ...e, isLive: false })), { time: nowTime(), text, isLive }];
  };
  const patch = (p: MissionUpdate['patch']): void => onUpdate({ id: mission.id, patch: p });

  const fail = (reason: string, category: string): void => {
    chargeBot(mission, finalMetrics);
    pushTimeline(reason, false);
    patch({ status: 'failed', progress: 100, liveAction: undefined, statusReason: reason, actionTimeline: [...timeline] });
    captureOutcome(mission, projectId, 'failed', startedAt, finalMetrics, undefined, { category, message: reason });
  };
  const cancel = (): void => {
    pushTimeline(label(t, 'agents.runtime.stopped', 'Stoppé'), false);
    patch({ status: 'cancelled', liveAction: undefined, actionTimeline: [...timeline] });
    captureOutcome(mission, projectId, 'cancelled', startedAt, finalMetrics);
  };

  const brainLabel = (b: BotBrain): string =>
    label(t, 'agents.lazybot.brain', `LazyBot "${botName}" — cerveau ${b.rail} : ${b.model || 'modèle par défaut de la CLI'}`, {
      bot: botName, rail: b.rail, model: b.model || 'CLI',
    });

  const brain = resolveBotBrain(mission.model);
  pushTimeline(
    'error' in brain
      ? label(t, 'agents.lazybot.started', `LazyBot "${botName}" — démarrage…`, { bot: botName })
      : brainLabel(brain),
    false,
  );
  pushTimeline(label(t, 'agents.lazybot.openingSolari', 'Ordinateur cloud Solari — ouverture de session…'), true);
  patch({
    status: 'running',
    progress: 0,
    planSteps: steps.map((s) => ({ ...s })),
    actionTimeline: [...timeline],
    liveAction: label(t, 'agents.lazybot.openingSolari', 'Ordinateur cloud Solari — ouverture de session…'),
  });
  emitEvent({
    type: 'mission.started',
    tsMs: Date.now(),
    projectId,
    missionId: mission.id,
    actor: 'agent',
    payload: { model: mission.model },
  });

  if ('error' in brain) {
    emitEvent({ type: 'mission.failed', tsMs: Date.now(), projectId, missionId: mission.id, actor: 'system', payload: { reason: 'bot_rail_unavailable' } });
    fail(brain.error, 'bot_rail_unavailable');
    return;
  }
  if (mission.botId) openBotVmWindow(mission.botId);
  if (!mission.agentSystemPrompt) {
    emitEvent({ type: 'mission.failed', tsMs: Date.now(), projectId, missionId: mission.id, actor: 'system', payload: { reason: 'bot_persona_missing' } });
    fail(label(t, 'agents.lazybot.personaMissing', 'Persona du LazyBot absente — relance le bot depuis sa fiche.'), 'bot_persona_missing');
    return;
  }
  if (stopSignal()) {
    cancel();
    return;
  }

  const runAttempt = async (b: BotBrain): Promise<void> => {
    const loopOpts: PlanAndActManagedOpts = {
      missionId: mission.id,
      missionTitle: mission.title,
      missionTask: mission.agentTask ?? mission.title,
      agentDisplayName: botName,
      agentSystemPrompt: mission.agentSystemPrompt ?? '',
      autonomy: mission.botAutonomy,
      // The project root is only the bot's LOCAL save location (write_file
      // "scrape-result.txt") — there is no worktree to isolate: a bot writes
      // reports, it does not edit the codebase (see buildBotToolPolicy).
      worktreePath: repoPath,
      projectRoot: repoPath,
      projectId,
      // No repo coding prelude (brain recall / harness / coding skills).
      // D93: prelude 'bot' injects bot-scoped topical recall (lastTime /
      // learning / history) for this botId — still skips harness/lazybrain.
      prelude: 'bot',
      botId: mission.botId,
      steps,
      model: b.model,
      streamTurn: b.streamTurn,
      permissionMode: opts.permissionMode ?? 'acceptEdits',
      allowedTools: opts.allowedTools,
      deniedTools: opts.deniedTools,
      reasoningEffort: mission.contract?.effort,
      stopSignal,
      signal,
      pauseSignal,
      drainIntervenes,
      getBudgetCapUsd,
      onBudgetPaused: opts.onBudgetPaused,
      onBudgetExceeded: () => { budgetExceeded = true; },
      getMaxDurationMs,
      onDurationPaused: opts.onDurationPaused,
      onDurationExceeded: () => { durationExceeded = true; },
      onMetrics: (metrics) => {
        finalMetrics = metrics;
        patch({ agentMetrics: metrics });
      },
      onOutcome: (outcome) => {
        if (outcome.type === 'failed') managedOutcome.failed = { reason: outcome.reason };
      },
      onStep: (stepIdx, state, meta) => {
        steps = steps.map((s, i) => (i === stepIdx ? { ...s, state, meta: meta ?? s.meta } : { ...s }));
        patch({ planSteps: [...steps] });
      },
      onAction: (event) => {
        timeline = [...timeline.map((e) => ({ ...e, isLive: false })), { ...event, isLive: event.isLive ?? false }];
        if (event.text.startsWith(AGENT_DONE_PREFIX)) report = event.text.slice(AGENT_DONE_PREFIX.length).trim();
        if (event.text.startsWith(AGENT_ERROR_PREFIX)) agentError = event.text;
        patch({ actionTimeline: [...timeline], liveAction: event.text });
      },
      onProgress: (pct) => patch({ progress: pct }),
      t,
    };
    await planAndActManaged(loopOpts);
  };

  await runAttempt(brain);

  // Brain failover chain (C85): walk every other READY rail until one works
  // or none remain. Solari runtime/tools stay the same — only the brain changes.
  const interrupted = (): boolean => stopSignal() || signal?.aborted === true || budgetExceeded || durationExceeded;
  const failedRails = new Set<BotModelRail>([brain.rail]);
  while (!interrupted() && isBrainFailure(managedOutcome.failed, finalMetrics)) {
    const next = resolveFallbackBrain(failedRails);
    if (!next) break;
    failedRails.add(next.rail);
    const cause = (agentError ?? managedOutcome.failed?.reason ?? '').replace(/^Erreur agent:\s*/, '').slice(0, 160);
    const failedRail = [...failedRails][failedRails.size - 2] ?? brain.rail;
    pushTimeline(
      label(t, 'agents.lazybot.brainFailover', `Cerveau ${failedRail} indisponible (${cause}) — bascule sur ${next.rail} : ${next.model}`, {
        failedRail, cause, rail: next.rail, model: next.model,
      }),
      false,
    );
    emitEvent({
      type: 'mission.step',
      tsMs: Date.now(),
      projectId,
      missionId: mission.id,
      actor: 'system',
      payload: { text: `brain failover → ${next.rail}:${next.model} (${cause})` },
    });
    managedOutcome.failed = null;
    agentError = undefined;
    report = undefined;
    finalMetrics = undefined;
    steps = initialBotSteps(t).map((s, i) => (i === 0 ? { ...s, state: 'done' as const } : s));
    patch({ model: next.model, status: 'running', planSteps: [...steps], actionTimeline: [...timeline], statusReason: undefined });
    await runAttempt(next);
  }

  if (stopSignal() || signal?.aborted === true) {
    cancel();
    return;
  }
  if (budgetExceeded) {
    fail(formatBudgetExceededMessage(finalMetrics?.costUsd ?? 0, getBudgetCapUsd() ?? 0, t).reason, 'budget_exceeded');
    return;
  }
  if (durationExceeded) {
    fail(formatDurationExceededMessage(Date.now() - startedAt, getMaxDurationMs() ?? 0, t).reason, 'duration_exceeded');
    return;
  }
  if (managedOutcome.failed) {
    const reason = managedOutcome.failed.reason;
    fail(translateStatusReason(reason, t) ?? reason, reason);
    return;
  }
  if (agentError) {
    fail(agentError.replace(/^Erreur agent:\s*/, ''), 'agent_failed');
    return;
  }

  // Timeline stays short; wakeup / lastTime / history keep the FULL report (C60).
  const timelineReport = report ? report.slice(0, 200) : undefined;
  const fullReport = report?.trim() || undefined;
  pushTimeline(
    timelineReport
      ? label(t, 'agents.lazybot.doneWithReport', `LazyBot terminé — ${timelineReport}`, { report: timelineReport })
      : label(t, 'agents.lazybot.done', 'LazyBot terminé'),
    false,
  );
  steps = steps.map((s) => ({ ...s, state: 'done' as const }));
  patch({
    status: 'done',
    progress: 100,
    liveAction: undefined,
    statusReason: undefined,
    planSteps: [...steps],
    actionTimeline: [...timeline],
    emptyDeliverable: false,
  });
  // Wakes the manager up with the bot's own answer — see
  // LazyBotCompletedPayload (eventTypes.ts): no judge verdict ever follows a
  // bot run, so without this the conversation never learns the bot finished.
  // Same projectId as the mission.started above — the wakeup poller only
  // reads the ACTIVE project's rows.
  emitEvent({
    type: 'lazybot.completed',
    tsMs: Date.now(),
    projectId,
    missionId: mission.id,
    actor: 'agent',
    payload: {
      botId: mission.botId,
      botName,
      report: fullReport,
      ...(mission.originConversationId ? { conversationId: mission.originConversationId } : {}),
    },
  });
  chargeBot(mission, finalMetrics);
  if (mission.botId) {
    void finalizeBotRunLearning({
      botId: mission.botId,
      botName,
      missionId: mission.id,
      task: mission.agentTask ?? mission.title,
      report: fullReport ?? '',
      conversationId: mission.originConversationId,
      timelineTexts: timeline.map((e) => e.text),
      run: {
        id: `run_${mission.id}`,
        botId: mission.botId,
        missionId: mission.id,
        status: 'completed',
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        summary: fullReport,
      },
    });
  }
  captureOutcome(mission, projectId, 'done', startedAt, finalMetrics);
}
