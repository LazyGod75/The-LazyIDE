/* planAndActLiveSupport — native agent_run loop extracted from runtime.ts.

   Measured 2026-08-28: planAndActLive cyclomatic complexity was 36 (ESLint
   ceiling 12). Behavior is copied: listeners before invoke, brain/harness
   prompt, poll-stop, proof scrape. Nested step/done handlers are separate
   functions so the orchestrator stays under the ratchet.
*/

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ActionEvent, PlanStep, ProofArtifact, ProofRequirement } from './types.js';
import type { AgentMetrics, PermissionMode, TFunc } from './runtime.js';
import { parseProofBlocks, buildProofContractBlock } from './proofs.js';
import { getPlatform } from '../platform/index.js';
import { buildPromptBrainContext, normalizeRecall } from '../brain/context.js';
import { recordRecallSaving } from '../models/costStore.js';
import { federatedRecall, buildCrossProjectContext } from '../brain/federatedRecall.js';
import { RECALL_TEACHING } from '../models/systemPrompts.js';
import { loadHarnessSessionBlock } from './harnessRules.js';
import { emitEvent, emitBuffered } from '../journal/journal.js';
import { projectIdFromRoot } from '../journal/projectId.js';
import { armAbortListener, isNativeStopRequested } from './nativeAbort.js';
import { shouldTreatNativeExitAsPause } from './nativePause.js';
import { agentErrorEvent } from './agentError.js';
import { normalizeRepoPathForGit } from '../paths.js';

interface AgentStepEvent {
  kind: 'tool' | 'text' | 'result' | 'system';
  name?: string;
  summary?: string;
  text?: string;
}

interface AgentDoneEvent {
  result: string;
  exit_code: number;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  tool_count?: number;
  cache_read_input_tokens?: number | null;
  session_id?: string | null;
}

export interface PlanAndActLiveOpts {
  missionId: string;
  missionTitle: string;
  missionTask?: string;
  agentName?: string;
  worktreePath: string;
  steps: PlanStep[];
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onAction: (event: ActionEvent) => void;
  onProgress: (pct: number) => void;
  onMetrics?: (metrics: AgentMetrics) => void;
  stopSignal: () => boolean;
  /** Mid-run abort — same AbortSignal the managed rail already honours. */
  abortSignal?: AbortSignal;
  tool: string;
  model: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
  extraReadableRoots?: string[];
  projectId?: string;
  proofRequirements?: ProofRequirement[];
  projectRoot?: string;
  onProofsAttached?: (proofs: ProofArtifact[]) => void;
  t?: TFunc;
  /** Native pause is stop-then-resume: SIGINT the CLI, wait, `--resume`. */
  pauseSignal?: () => boolean;
  /** Claude CLI `--resume` session from a previous agent_run done event. */
  resumeSessionId?: string;
  /** Fired when a pause kill captured a session id — store should mark paused. */
  onPaused?: (sessionId?: string) => void;
  /** Fired when the user resumes after a native pause. */
  onResumed?: () => void;
}

interface LiveRunState {
  toolCount: number;
  lastSummary: string;
  agentDone: boolean;
  agentError: string | null;
  paused: boolean;
  stopped: boolean;
  sessionId?: string;
}

function clockHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pauseRequested(opts: PlanAndActLiveOpts): boolean {
  return Boolean(opts.pauseSignal?.());
}

function handleToolStep(
  opts: PlanAndActLiveOpts,
  state: LiveRunState,
  step: AgentStepEvent,
): void {
  state.toolCount += 1;
  const toolName = step.name ?? 'tool';
  const summary = step.summary ?? toolName;
  opts.onAction({ time: clockHm(), text: `${toolName}: ${summary}`, isLive: true });
  emitBuffered({
    type: 'tool.called',
    tsMs: Date.now(),
    projectId: opts.projectId ?? '',
    missionId: opts.missionId,
    actor: 'agent',
    payload: { name: toolName },
  });
  if (state.toolCount === 1) {
    opts.onStep(1, 'done', `fait · ${clockHm()}`);
    opts.onStep(2, 'in_progress');
  }
  opts.onProgress(Math.min(85, 30 + Math.floor(Math.log2(state.toolCount + 1) * 15)));
}

function emitStepText(opts: PlanAndActLiveOpts, text: string, isLive: boolean): void {
  opts.onAction({ time: clockHm(), text, isLive });
  emitBuffered({
    type: 'mission.step',
    tsMs: Date.now(),
    projectId: opts.projectId ?? '',
    missionId: opts.missionId,
    actor: 'agent',
    payload: { text: text.slice(0, 500) },
  });
}

function dispatchLiveStep(opts: PlanAndActLiveOpts, state: LiveRunState, step: AgentStepEvent): void {
  if (step.kind === 'tool') {
    handleToolStep(opts, state, step);
    return;
  }
  if (step.kind === 'text' && step.text && step.text.length > 0) {
    state.lastSummary = step.summary ?? step.text;
    emitStepText(opts, step.summary ?? step.text, true);
    return;
  }
  if (step.kind === 'result') {
    state.lastSummary = step.summary ?? state.lastSummary;
    const resultText = opts.t
      ? opts.t('agents.runtime.resultLine', { summary: state.lastSummary })
      : `Résultat: ${state.lastSummary}`;
    emitStepText(opts, resultText, false);
    return;
  }
  if (step.kind === 'system') {
    emitStepText(opts, `[agent] ${step.summary ?? 'init'}`, true);
  }
}

function orZero(n: number | undefined): number {
  return n ?? 0;
}

function applyLiveDoneMetrics(opts: PlanAndActLiveOpts, payload: AgentDoneEvent): void {
  if (!opts.onMetrics || payload.duration_ms === undefined) return;
  const tokensIn = orZero(payload.input_tokens);
  const tokensOut = orZero(payload.output_tokens);
  const costUsd = orZero(payload.cost_usd);
  opts.onMetrics({
    durationMs: orZero(payload.duration_ms),
    inputTokens: tokensIn,
    outputTokens: tokensOut,
    costUsd,
    toolCount: orZero(payload.tool_count),
    cacheReadInputTokens: payload.cache_read_input_tokens ?? undefined,
    sessionId: payload.session_id ?? undefined,
  });
  emitBuffered({
    type: 'spend.tokens',
    tsMs: Date.now(),
    projectId: opts.projectId ?? '',
    missionId: opts.missionId,
    actor: 'agent',
    payload: {
      tokensIn,
      tokensOut,
      costUsd,
      source: 'real',
      cacheReadInputTokens: payload.cache_read_input_tokens ?? undefined,
    },
  });
}

function applyLiveDone(opts: PlanAndActLiveOpts, state: LiveRunState, payload: AgentDoneEvent): void {
  state.agentDone = true;
  state.lastSummary = payload.result ?? state.lastSummary;
  if (payload.session_id) state.sessionId = payload.session_id;
  if (payload.exit_code !== 0) {
    const stopRequested = isNativeStopRequested(opts.stopSignal, opts.abortSignal);
    if (stopRequested) {
      state.stopped = true;
      state.agentError = null;
    } else if (shouldTreatNativeExitAsPause({
      pauseRequested: pauseRequested(opts),
      stopRequested,
    })) {
      state.paused = true;
      state.agentError = null;
    } else {
      state.agentError = state.lastSummary.trim().length > 0
        ? state.lastSummary
        : `Agent exited with code ${payload.exit_code}`;
    }
  }
  applyLiveDoneMetrics(opts, payload);
}

async function collectBrainContext(
  coreTask: string,
  missionId: string,
  worktreePath: string,
  agentName?: string,
): Promise<{ brainContext: string; startupCtx: string; harnessBlock: string }> {
  let brainContext = '';
  try {
    const recall = normalizeRecall(await getPlatform().brain.recall(coreTask, missionId));
    brainContext = buildPromptBrainContext(recall);
    recordRecallSaving(recall, 'mission');
  } catch { /* brain recall optional */ }
  try {
    const crossCtx = buildCrossProjectContext(await federatedRecall(coreTask));
    if (crossCtx) brainContext = brainContext ? `${brainContext}\n${crossCtx}` : crossCtx;
  } catch { /* federated recall optional */ }
  let startupCtx = '';
  try {
    startupCtx = await getPlatform().brain.startupContext(worktreePath);
  } catch { /* startup context optional */ }
  let harnessBlock = '';
  try {
    harnessBlock = await loadHarnessSessionBlock({
      project: projectIdFromRoot(worktreePath),
      agentName,
      mode: 'mission',
      activePaths: [worktreePath],
    }, { projectRoot: worktreePath });
  } catch { /* harness optional */ }
  return { brainContext, startupCtx, harnessBlock };
}

function extraRootsPromptLine(roots: string[] | undefined): string {
  if (roots && roots.length > 0) {
    return ` You may ALSO read files under these additional project root(s), explicitly granted for this mission: ${roots.join(', ')} — but they are READ-ONLY for you: editing or writing anywhere outside the current working directory above is blocked, including under these additional roots.`;
  }
  return ' No other directory is readable for this mission — if the task genuinely needs another project\'s source and no additional root was granted, say so instead of guessing or fabricating its contents.';
}

async function buildNativeTaskPrompt(opts: PlanAndActLiveOpts): Promise<string> {
  const coreTask = opts.missionTask ?? opts.missionTitle;
  const { brainContext, startupCtx, harnessBlock } = await collectBrainContext(
    coreTask, opts.missionId, opts.worktreePath, opts.agentName,
  );
  const agentHeader = opts.agentName ? `Agent: ${opts.agentName}\n` : '';
  const startupBlock = startupCtx
    ? `<brain_startup_context>\n${startupCtx}\n</brain_startup_context>\n\n`
    : '';
  const brainToolHint =
    'If a brain_search tool is available, use it whenever you need more memory ' +
    'context mid-task than what is provided above (related code, prior mission ' +
    'notes, past decisions) — it searches this project\'s persistent brain. ' +
    'For DETERMINISTIC structural questions (every decision still active, every ' +
    'warning, notes touching a file path, contradictions) prefer brain_query_css ' +
    'with a CSS selector over data-cerveau-* (e.g. ' +
    'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])), and ' +
    'follow a hit\'s graph with brain_neighbours.\n';
  const harnessBlockSuffix = harnessBlock ? `${harnessBlock}\n\n` : '';
  return `${agentHeader}Task: ${coreTask}
Working directory: ${opts.worktreePath}

${harnessBlockSuffix}${startupBlock}${brainContext ? brainContext + '\n' : ''}${brainToolHint}${RECALL_TEACHING}
${buildProofContractBlock(opts.proofRequirements)}
Do the task. Be autonomous and complete the task fully. Do not ask for clarification.

IMPORTANT WORKTREE RULE (2026-08-03, real-user mission M1; cross-project read access added 2026-08-18): every file you create or edit MUST be inside the current working directory above — anything you write outside it never enters the diff, is never reviewed or merged, and will NOT be part of your mission's result, even though the write itself may quietly succeed (only the worktree's own diff is ever reviewed and merged). Reading is different: you may always read files under the current working directory itself.${extraRootsPromptLine(opts.extraReadableRoots)} If the task text mentions an absolute path (e.g. "C:\\Users\\...\\project") for something you need to WRITE, that path refers to THIS working directory — map it to the equivalent path under the current directory and write there. When in doubt, use relative paths for writes.`;
}

async function pollUntilAgentStop(opts: PlanAndActLiveOpts, state: LiveRunState): Promise<void> {
  while (!state.agentDone && state.agentError === null) {
    if (isNativeStopRequested(opts.stopSignal, opts.abortSignal) || pauseRequested(opts)) {
      await invoke('agent_run_kill', { id: opts.missionId }).catch(() => undefined);
      break;
    }
    await delay(200);
  }
}

async function waitWhilePaused(opts: PlanAndActLiveOpts): Promise<'resume' | 'stop'> {
  while (pauseRequested(opts)) {
    if (isNativeStopRequested(opts.stopSignal, opts.abortSignal)) return 'stop';
    await delay(200);
  }
  if (isNativeStopRequested(opts.stopSignal, opts.abortSignal)) return 'stop';
  return 'resume';
}

async function attachTranscriptProofs(opts: PlanAndActLiveOpts, lastSummary: string): Promise<void> {
  if (!opts.proofRequirements?.length || !opts.projectRoot) return;
  try {
    const parsedProofs = await parseProofBlocks(lastSummary, opts.projectRoot, opts.missionId);
    if (parsedProofs.length === 0) return;
    for (const proof of parsedProofs) {
      emitEvent({
        type: 'mission.proof_attached',
        tsMs: Date.now(),
        projectId: opts.projectId ?? '',
        missionId: opts.missionId,
        actor: 'agent',
        payload: proof,
      });
    }
    opts.onProofsAttached?.(parsedProofs);
  } catch { /* non-fatal */ }
}

function cleanupUnlisteners(unlisteners: Array<() => void>): void {
  for (const unsub of unlisteners) {
    try { unsub(); } catch { /* ignore */ }
  }
}

function optionalList(values: string[] | undefined): string[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function fireNativeAgentRun(
  opts: PlanAndActLiveOpts,
  state: LiveRunState,
  taskPrompt: string,
  resumeSessionId: string | undefined,
  resolveFinished: () => void,
): void {
  invoke('agent_run', {
    req: {
      id: opts.missionId,
      worktreePath: normalizeRepoPathForGit(opts.worktreePath),
      tool: opts.tool,
      model: opts.model,
      task: taskPrompt,
      system: 'You are an autonomous coding agent. You MUST use the write_file tool to create or modify files. NEVER claim you have created or modified a file without actually calling write_file. After writing a file, use read_file to verify it exists. If you cannot write files, report the error explicitly. Do not summarize actions you did not take. Be autonomous and complete the task fully.',
      permissionMode: opts.permissionMode ?? 'default',
      allowedTools: optionalList(opts.allowedTools),
      deniedTools: optionalList(opts.deniedTools),
      extraReadableRoots: optionalList(opts.extraReadableRoots),
      session_id: resumeSessionId,
    },
  }).catch((err: unknown) => {
    state.agentError = String(err);
    state.agentDone = true;
    resolveFinished();
  });
}

function announceLiveError(opts: PlanAndActLiveOpts, agentError: string): void {
  opts.onAction(agentErrorEvent(clockHm(), agentError, opts.t));
  const stamp = `erreur · ${clockHm()}`;
  opts.onStep(2, 'done', stamp);
  opts.onStep(3, 'done', stamp);
  opts.onStep(4, 'done', stamp);
  opts.onProgress(100);
}

function announceLiveSuccess(opts: PlanAndActLiveOpts, lastSummary: string): void {
  opts.onStep(2, 'done', `fait · ${clockHm()}`);
  opts.onStep(3, 'done', `fait · ${clockHm()}`);
  opts.onStep(4, 'in_progress');
  opts.onProgress(90);
  const text = lastSummary
    ? (opts.t ? opts.t('agents.runtime.agentDone', { summary: lastSummary.slice(0, 100) }) : `Agent terminé: ${lastSummary.slice(0, 100)}`)
    : (opts.t ? opts.t('agents.runtime.agentDoneNoSummary') : 'Agent terminé');
  opts.onAction({ time: clockHm(), text, isLive: false });
}

async function runOneNativePass(
  opts: PlanAndActLiveOpts,
  resumeSessionId: string | undefined,
  announceStart: boolean,
): Promise<LiveRunState> {
  if (announceStart) {
    const startText = opts.t
      ? opts.t('agents.runtime.startingAgent', { tool: opts.tool, model: opts.model })
      : `Démarrage agent ${opts.tool} (${opts.model})…`;
    opts.onStep(0, 'in_progress');
    opts.onAction({ time: clockHm(), text: startText, isLive: true });
    opts.onProgress(5);
    opts.onStep(1, 'in_progress');
  }

  const state: LiveRunState = {
    toolCount: 0,
    lastSummary: '',
    agentDone: false,
    agentError: null,
    paused: false,
    stopped: false,
  };
  const unlisteners: Array<() => void> = [];
  let resolveFinished!: () => void;
  const agentFinished = new Promise<void>((resolve) => { resolveFinished = resolve; });

  const [stepUnsub, doneUnsub, errorUnsub] = await Promise.all([
    listen<AgentStepEvent>(`agent://step/${opts.missionId}`, (event) => {
      if (!isNativeStopRequested(opts.stopSignal, opts.abortSignal)) {
        dispatchLiveStep(opts, state, event.payload);
      }
    }),
    listen<AgentDoneEvent>(`agent://done/${opts.missionId}`, (event) => {
      applyLiveDone(opts, state, event.payload);
      cleanupUnlisteners(unlisteners);
      resolveFinished();
    }),
    listen<string>(`agent://error/${opts.missionId}`, (event) => {
      state.agentError = event.payload ?? 'Agent error';
      cleanupUnlisteners(unlisteners);
      resolveFinished();
    }),
  ]);
  unlisteners.push(stepUnsub, doneUnsub, errorUnsub);

  const taskPrompt = await buildNativeTaskPrompt(opts);
  fireNativeAgentRun(opts, state, taskPrompt, resumeSessionId, resolveFinished);

  const disarmAbort = armAbortListener(opts.abortSignal, () => {
    void invoke('agent_run_kill', { id: opts.missionId }).catch(() => undefined);
  });
  if (announceStart) opts.onProgress(15);
  await Promise.race([agentFinished, pollUntilAgentStop(opts, state)]);
  disarmAbort();
  cleanupUnlisteners(unlisteners);
  return state;
}

export async function runPlanAndActLive(opts: PlanAndActLiveOpts): Promise<void> {
  let resumeSessionId = opts.resumeSessionId;

  for (let pass = 0; ; pass += 1) {
    const state = await runOneNativePass(opts, resumeSessionId, pass === 0);

    if (state.stopped) {
      const stopText = opts.t ? opts.t('agents.runtime.stopped') : 'Stoppé';
      opts.onAction({ time: clockHm(), text: stopText, isLive: false });
      return;
    }

    if (state.paused) {
      opts.onPaused?.(state.sessionId);
      const outcome = await waitWhilePaused(opts);
      if (outcome === 'stop') {
        const stopText = opts.t ? opts.t('agents.runtime.stopped') : 'Stoppé';
        opts.onAction({ time: clockHm(), text: stopText, isLive: false });
        return;
      }
      opts.onResumed?.();
      resumeSessionId = state.sessionId;
      const resumeText = opts.t
        ? opts.t('agents.runtime.nativeResumed')
        : 'Reprise de la mission';
      opts.onAction({ time: clockHm(), text: resumeText, isLive: true });
      continue;
    }

    if (state.agentError) {
      announceLiveError(opts, state.agentError);
      return;
    }

    announceLiveSuccess(opts, state.lastSummary);
    await attachTranscriptProofs(opts, state.lastSummary);
    opts.onStep(4, 'done', `fait · ${clockHm()}`);
    opts.onProgress(100);
    return;
  }
}
