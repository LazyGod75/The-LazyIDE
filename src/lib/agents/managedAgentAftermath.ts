/* managedAgentAftermath.ts — post-observation Reflexion / PRM / handoff
   extracted from planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 71
   (ESLint ceiling 12). This module owns R6 Reflexion, R8 PRM, R7 context
   handoff, V4 consecutive-error counting, and the stuck-detector check.
   Behavior is copied, not redesigned. Does not import managedAgent.ts (cycle). */

import type { ActionEvent } from './types.js';
import { emitBuffered } from '../journal/journal.js';
import { getToolNames } from './toolRegistry.js';
import { detectStuckPattern, type AgentStepRecord } from './stuckDetector.js';
import { estimateMessagesTokens, parsePrmVerdict, parseReflectBlock, shouldHandoff } from './managedAgentPure.js';

type ChatMessage = { role: string; content: string };

export function nextConsecutiveFailures(observation: string, prev: number): number {
  return observation.startsWith('ERROR:') ? prev + 1 : 0;
}

export function toolHasTestFailure(observation: string): boolean {
  const failedMatch = /(\d+) failed/.exec(observation);
  return failedMatch !== null && parseInt(failedMatch[1], 10) > 0;
}

export interface AftermathIo {
  projectId: string;
  missionId: string;
  model: string;
  cheapModel: string;
  systemPrompt: string;
  nowTime: () => string;
  onAction: (event: ActionEvent) => void;
  runTurn: (messages: ChatMessage[], system: string, model: string) => Promise<string>;
  escalateAndStop: () => void;
  stopForStuckPattern: (reason: string, detail: string) => void;
}

async function maybeReflect(opts: {
  io: AftermathIo;
  observation: string;
  messages: ChatMessage[];
  reflections: string[];
}): Promise<{ messages: ChatMessage[]; reflections: string[] }> {
  const isError = opts.observation.startsWith('ERROR:');
  if (!isError && !toolHasTestFailure(opts.observation)) {
    return { messages: opts.messages, reflections: opts.reflections };
  }
  const reflectText = await opts.io.runTurn(
    [
      ...opts.messages,
      { role: 'user', content: 'Tool result indicates an issue. Please diagnose what went wrong and what to change next. Respond with <reflect>your diagnosis in ≤150 tokens</reflect> and nothing else.' },
    ],
    opts.io.systemPrompt,
    opts.io.cheapModel,
  );
  const reflection = parseReflectBlock(reflectText);
  if (!reflection) return { messages: opts.messages, reflections: opts.reflections };
  emitBuffered({
    tsMs: Date.now(),
    projectId: opts.io.projectId,
    missionId: opts.io.missionId,
    actor: 'agent',
    type: 'mission.step',
    payload: { text: reflection.slice(0, 500), marker: 'reflexion' },
  });
  return {
    messages: opts.messages,
    reflections: [...opts.reflections, reflection].slice(-3),
  };
}

async function maybePrm(opts: {
  io: AftermathIo;
  step: number;
  prmInvocations: number;
  prmMax: number;
  messages: ChatMessage[];
}): Promise<{ messages: ChatMessage[]; prmInvocations: number }> {
  if (!(opts.step % 5 === 0 && opts.step > 0 && opts.prmInvocations < opts.prmMax)) {
    return { messages: opts.messages, prmInvocations: opts.prmInvocations };
  }
  const prmInvocations = opts.prmInvocations + 1;
  const validActions = [...getToolNames(), 'attach_proof', 'FINAL'].join(', ');
  const prmText = await opts.io.runTurn(
    [
      ...opts.messages.slice(-5),
      { role: 'user', content: `Classify this agent trajectory. The agent's valid tools/actions are: ${validActions} — never flag one of these as a non-existent tool. Respond with one of:\n- OK\n- (S) Specification error: <1 corrective sentence>\n- (R) Reasoning error: <1 corrective sentence>\n- (C) Coordination error: <1 corrective sentence>` },
    ],
    opts.io.systemPrompt,
    opts.io.cheapModel,
  );
  const verdict = parsePrmVerdict(prmText);
  const prmVerdictText = `[PRM] ${verdict.ok ? 'OK' : verdict.correction ?? 'issue detected'}`;
  opts.io.onAction({ time: opts.io.nowTime(), text: prmVerdictText, isLive: false });
  emitBuffered({
    tsMs: Date.now(),
    projectId: opts.io.projectId,
    missionId: opts.io.missionId,
    actor: 'agent',
    type: 'mission.step',
    payload: { text: prmVerdictText.slice(0, 500), marker: 'prm' },
  });
  if (verdict.ok || !verdict.correction) {
    return { messages: opts.messages, prmInvocations };
  }
  return {
    messages: [...opts.messages, { role: 'user', content: `<correction>${verdict.correction}</correction>` }],
    prmInvocations,
  };
}

async function maybeHandoff(opts: {
  io: AftermathIo;
  messages: ChatMessage[];
  reflections: string[];
  initialUserMessage: ChatMessage;
}): Promise<{ messages: ChatMessage[]; reflections: string[] }> {
  if (!shouldHandoff(opts.messages)) return { messages: opts.messages, reflections: opts.reflections };
  const contextTokensAtHandoff = estimateMessagesTokens(opts.messages);
  const summaryText = await opts.io.runTurn(
    [
      ...opts.messages,
      { role: 'user', content: 'Summarize this agent session in ≤200 tokens: task, files touched, progress, open questions.' },
    ],
    opts.io.systemPrompt,
    opts.io.cheapModel,
  );
  opts.io.onAction({
    time: opts.io.nowTime(),
    text: '[Handoff] Context compacted — continuing with summary',
    isLive: false,
  });
  emitBuffered({
    tsMs: Date.now(),
    projectId: opts.io.projectId,
    missionId: opts.io.missionId,
    actor: 'agent',
    type: 'agent.handoff',
    payload: { from: opts.io.model, to: opts.io.model, contextTokens: contextTokensAtHandoff },
  });
  return {
    messages: [
      opts.initialUserMessage,
      { role: 'user', content: `[Context handoff summary]\n${summaryText}` },
    ],
    reflections: [],
  };
}

export type AftermathResult =
  | { flow: 'stop' }
  | {
      flow: 'continue';
      messages: ChatMessage[];
      reflections: string[];
      consecutiveFailures: number;
      prmInvocations: number;
    };

export async function applyManagedAftermath(opts: {
  io: AftermathIo;
  observation: string;
  observationContent: string;
  action: string;
  args: Record<string, unknown>;
  messages: ChatMessage[];
  reflections: string[];
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  stepHistory: AgentStepRecord[];
  step: number;
  prmInvocations: number;
  prmMax: number;
  initialUserMessage: ChatMessage;
}): Promise<AftermathResult> {
  const consecutiveFailures = nextConsecutiveFailures(opts.observation, opts.consecutiveFailures);
  if (consecutiveFailures >= opts.maxConsecutiveFailures) {
    opts.io.escalateAndStop();
    return { flow: 'stop' };
  }
  opts.stepHistory.push({
    action: opts.action,
    argsSignature: JSON.stringify(opts.args),
    observation: opts.observationContent,
    isError: opts.observation.startsWith('ERROR:'),
  });
  const stuckVerdict = detectStuckPattern(opts.stepHistory);
  if (stuckVerdict.stuck && stuckVerdict.reason) {
    opts.io.stopForStuckPattern(stuckVerdict.reason, stuckVerdict.message);
    return { flow: 'stop' };
  }
  const reflected = await maybeReflect(opts);
  const prm = await maybePrm({ ...opts, messages: reflected.messages });
  const handoff = await maybeHandoff({
    ...opts,
    messages: prm.messages,
    reflections: reflected.reflections,
  });
  return {
    flow: 'continue',
    messages: handoff.messages,
    reflections: handoff.reflections,
    consecutiveFailures,
    prmInvocations: prm.prmInvocations,
  };
}
