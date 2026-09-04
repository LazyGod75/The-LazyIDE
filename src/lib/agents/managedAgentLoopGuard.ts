/* managedAgentLoopGuard.ts — top-of-loop structural guards extracted from
   planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 51
   (ESLint ceiling 12). This module owns the pass that MUST run first:
   MAX_LOOP_ITERATIONS, the macrotask yield, stopSignal, pause, user
   intervene. Behavior is copied, not redesigned. Does not import
   managedAgent.ts (cycle). */

import type { TFunc } from './runtime.js';
import { pauseUntilResumed, type MissionCapIo } from './managedAgentCaps.js';

type ChatMessage = { role: string; content: string };

export async function guardManagedLoopStep(opts: {
  loopIterationCount: number;
  maxLoopIterations: number;
  capIo: MissionCapIo;
  t?: TFunc;
  drainIntervenes: () => string[];
  messages: ChatMessage[];
}): Promise<'stop' | { messages: ChatMessage[] }> {
  if (opts.loopIterationCount > opts.maxLoopIterations) {
    opts.capIo.onAction({
      time: opts.capIo.nowTime(),
      text: opts.t
        ? opts.t('agents.managedAgent.iterationCapExceeded', { cap: opts.maxLoopIterations })
        : `agent loop exceeded iteration cap (${opts.maxLoopIterations}) — arrêt de sécurité`,
      isLive: false,
    });
    opts.capIo.onStep(4, 'done', `plafond d'itérations dépassé · ${opts.capIo.nowTime()}`);
    opts.capIo.onProgress(100);
    opts.capIo.emitMetrics({ type: 'failed', reason: 'iteration_cap_exceeded' });
    return 'stop';
  }
  await opts.capIo.delay(0);
  if (opts.capIo.stopSignal()) {
    opts.capIo.onAction({ time: opts.capIo.nowTime(), text: 'Agent stopped by user', isLive: false });
    return 'stop';
  }
  if (opts.capIo.pauseSignal()) {
    opts.capIo.onAction({
      time: opts.capIo.nowTime(),
      text: opts.t ? opts.t('agents.managedAgent.missionPaused') : 'Mission en pause',
      isLive: false,
    });
    if ((await pauseUntilResumed(opts.capIo)) === 'stop') return 'stop';
  }
  let messages = opts.messages;
  for (const interventionText of opts.drainIntervenes()) {
    opts.capIo.onAction({
      time: opts.capIo.nowTime(),
      text: opts.t
        ? opts.t('agents.managedAgent.userIntervention', { text: interventionText })
        : `Intervention utilisateur : ${interventionText}`,
      isLive: false,
    });
    messages = [...messages, { role: 'user', content: `[User intervention] ${interventionText}` }];
  }
  return { messages };
}

export function workingMessagesWithReflections(
  messages: ChatMessage[],
  reflections: string[],
  bound: (msgs: ChatMessage[]) => { messages: ChatMessage[] },
): ChatMessage[] {
  const { messages: windowed } = bound(messages);
  if (reflections.length === 0) return windowed;
  return [
    windowed[0],
    { role: 'user', content: `Previous reflections:\n${reflections.join('\n---\n')}` },
    ...windowed.slice(1),
  ];
}

export function advanceManagedMilestones(
  step: number,
  maxSteps: number,
  nowTime: () => string,
  onStep: MissionCapIo['onStep'],
): void {
  if (step === 1) {
    onStep(1, 'done', `done · ${nowTime()}`);
    onStep(2, 'in_progress');
    return;
  }
  if (step === Math.floor(maxSteps * 0.5)) {
    onStep(2, 'done', `done · ${nowTime()}`);
    onStep(3, 'in_progress');
  }
}
