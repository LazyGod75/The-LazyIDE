/* managedAgentTurn.ts — one ReAct model-turn (stream → parse) extracted from
   planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 22
   (ESLint ceiling 12). This module owns stream, abort/credits/provider
   retry, checkpoint, steering, budget/duration caps, and ACTION/ARGS parse.
   Does not import managedAgent.ts (cycle). */

import type { ActionEvent } from './types.js';
import type { TFunc } from './runtime.js';
import { applyManagedTurnError } from './managedAgentTurnError.js';
import { maybeWriteManagedCheckpoint, applyManagedSteering } from './managedAgentSteering.js';
import { applyMissionCaps, type MissionCapIo } from './managedAgentCaps.js';
import { parseReActActionWithRetry, applyUnparseableStep, stripManagedTurnText } from './managedAgentParse.js';
import { workingMessagesWithReflections } from './managedAgentLoopGuard.js';

type ChatMessage = { role: string; content: string };

export type ManagedTurnResult =
  | 'stop'
  | {
      kind: 'retry';
      consecutiveFailures: number;
      messages: ChatMessage[];
      lastUnparseableSignature?: string;
    }
  | {
      kind: 'parsed';
      action: string;
      args: Record<string, unknown>;
      cleaned: string;
      messages: ChatMessage[];
    };

export interface ManagedTurnOpts {
  messages: ChatMessage[];
  reflections: string[];
  boundHistory: (msgs: ChatMessage[]) => { messages: ChatMessage[] };
  collectTurn: (working: ChatMessage[]) => Promise<string>;
  addTurnTokens: (working: ChatMessage[], turnText: string) => void;
  consecutiveFailures: number;
  lastUnparseableSignature: string | null;
  maxConsecutiveFailures: number;
  turnError: Parameters<typeof applyManagedTurnError>[1];
  checkpoint: Parameters<typeof maybeWriteManagedCheckpoint>[0];
  steering: Omit<Parameters<typeof applyManagedSteering>[0], 'messages' | 'turnText'>;
  capIo: MissionCapIo;
  /** Read AFTER addTurnTokens — costUsdAccum must include this turn. */
  getBudget: () => Parameters<typeof applyMissionCaps>[1];
  getDuration: () => Parameters<typeof applyMissionCaps>[2];
  retryParse: (working: ChatMessage[], cleaned: string) => Promise<string>;
  step: number;
  t?: TFunc;
  nowTime: () => string;
  onAction: (event: ActionEvent) => void;
  escalateAndStop: () => void;
}

export async function collectManagedTurnText(stream: AsyncIterable<string>): Promise<string> {
  let turnText = '';
  for await (const chunk of stream) turnText += chunk;
  return turnText;
}

export async function runManagedTurn(opts: ManagedTurnOpts): Promise<ManagedTurnResult> {
  const workingMessages = workingMessagesWithReflections(opts.messages, opts.reflections, opts.boundHistory);
  let turnText: string;
  try {
    turnText = await opts.collectTurn(workingMessages);
  } catch (err) {
    const handled = applyManagedTurnError(err, opts.turnError);
    if (handled === 'stop') return 'stop';
    return { kind: 'retry', consecutiveFailures: handled.retry, messages: opts.messages };
  }
  opts.addTurnTokens(workingMessages, turnText);
  await maybeWriteManagedCheckpoint(opts.checkpoint);
  const messages = await applyManagedSteering({ ...opts.steering, messages: opts.messages, turnText });
  if ((await applyMissionCaps(opts.capIo, opts.getBudget(), opts.getDuration())) === 'stop') return 'stop';
  return parseManagedTurn(opts, workingMessages, messages, turnText);
}

async function parseManagedTurn(
  opts: ManagedTurnOpts,
  workingMessages: ChatMessage[],
  messages: ChatMessage[],
  turnText: string,
): Promise<ManagedTurnResult> {
  const cleaned = stripManagedTurnText(turnText);
  const parsed = await parseReActActionWithRetry(cleaned, () => opts.retryParse(workingMessages, cleaned));
  if (parsed) return { kind: 'parsed', action: parsed.action, args: parsed.args, cleaned, messages };
  const unparsed = applyUnparseableStep({
    cleaned,
    consecutiveFailures: opts.consecutiveFailures,
    lastUnparseableSignature: opts.lastUnparseableSignature,
    maxConsecutiveFailures: opts.maxConsecutiveFailures,
    step: opts.step,
    t: opts.t,
    nowTime: opts.nowTime,
    onAction: opts.onAction,
    escalateAndStop: opts.escalateAndStop,
    messages,
  });
  if (unparsed === 'stop') return 'stop';
  return {
    kind: 'retry',
    consecutiveFailures: unparsed.consecutiveFailures,
    messages: unparsed.messages,
    lastUnparseableSignature: unparsed.lastUnparseableSignature,
  };
}

export async function failManagedMaxSteps(opts: {
  maxSteps: number;
  processTraces: () => Promise<void>;
  nowTime: () => string;
  onAction: (event: ActionEvent) => void;
  onStep: (stepIdx: number, state: 'done', meta?: string) => void;
  onProgress: (pct: number) => void;
  emitMetrics: (outcome: { type: 'failed'; reason: string }) => void;
}): Promise<void> {
  try { await opts.processTraces(); } catch { /* non-blocking */ }
  opts.onAction({
    time: opts.nowTime(),
    text: `Max steps (${opts.maxSteps}) reached — stopping`,
    isLive: false,
  });
  opts.onStep(4, 'done', `max steps · ${opts.nowTime()}`);
  opts.onProgress(100);
  opts.emitMetrics({ type: 'failed', reason: 'max_steps_exhausted' });
}
