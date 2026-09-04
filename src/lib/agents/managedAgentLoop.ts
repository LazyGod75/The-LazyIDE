/* managedAgentLoop.ts — one ReAct loop iteration extracted from
   planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 13
   (ESLint ceiling 12) after turn/action extraction, because stop/retry/next
   were still three branches in the orchestrator. This module owns that
   settle. Does not import managedAgent.ts (cycle). */

import type { TFunc } from './runtime.js';
import { guardManagedLoopStep } from './managedAgentLoopGuard.js';
import type { MissionCapIo } from './managedAgentCaps.js';
import type { ManagedTurnResult } from './managedAgentTurn.js';
import type { ManagedActionResult } from './managedAgentAction.js';

type ChatMessage = { role: string; content: string };

export interface ManagedLoopState {
  messages: ChatMessage[];
  reflections: string[];
  consecutiveFailures: number;
  lastUnparseableSignature: string | null;
  proofNudges: number;
  prmInvocations: number;
  toolCallCount: number;
}

export async function applyManagedLoopStep(opts: {
  state: ManagedLoopState;
  loopIterationCount: number;
  maxLoopIterations: number;
  capIo: MissionCapIo;
  t?: TFunc;
  drainIntervenes: () => string[];
  runTurn: (state: ManagedLoopState) => Promise<ManagedTurnResult>;
  runAction: (
    turn: Extract<ManagedTurnResult, { kind: 'parsed' }>,
    state: ManagedLoopState,
  ) => Promise<ManagedActionResult>;
}): Promise<'stop' | ManagedLoopState> {
  const guarded = await guardManagedLoopStep({
    loopIterationCount: opts.loopIterationCount,
    maxLoopIterations: opts.maxLoopIterations,
    capIo: opts.capIo,
    t: opts.t,
    drainIntervenes: opts.drainIntervenes,
    messages: opts.state.messages,
  });
  if (guarded === 'stop') return 'stop';
  const state = { ...opts.state, messages: guarded.messages };
  const turn = await opts.runTurn(state);
  if (turn === 'stop') return 'stop';
  if (turn.kind === 'retry') return retryLoopState(state, turn);
  const acted = await opts.runAction(turn, state);
  if (acted === 'stop') return 'stop';
  return {
    messages: acted.messages,
    reflections: acted.reflections,
    consecutiveFailures: acted.consecutiveFailures,
    lastUnparseableSignature: null,
    proofNudges: acted.proofNudges,
    prmInvocations: acted.prmInvocations,
    toolCallCount: acted.toolCallCount,
  };
}

function retryLoopState(
  state: ManagedLoopState,
  turn: Extract<ManagedTurnResult, { kind: 'retry' }>,
): ManagedLoopState {
  return {
    ...state,
    messages: turn.messages,
    consecutiveFailures: turn.consecutiveFailures,
    lastUnparseableSignature: turn.lastUnparseableSignature ?? state.lastUnparseableSignature,
  };
}
