/* managedAgentCaps.ts — budget + wall-clock cap enforcement extracted from
   planAndActManaged (managedAgent.ts).

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 133
   (ESLint ceiling 12). The budget block and the duration block were
   byte-for-byte the same shape (exceeded → hard stop; 90% warning → pause
   on the real pauseFlags cell). This module owns that shared flow so the
   loop does not duplicate it. Does not import managedAgent.ts (cycle). */

import type { PlanStep, ActionEvent } from './types.js';
import type { TFunc } from './runtime.js';
import { emitBuffered, emitEvent } from '../journal/journal.js';

export type CapStatus = 'ok' | 'warning' | 'exceeded';
export type CapFlow = 'continue' | 'stop';

export type MissionCapOutcome = { type: 'completed' } | { type: 'failed'; reason: string };

export interface MissionCapIo {
  projectId: string;
  missionId: string;
  t?: TFunc;
  pauseSignal: () => boolean;
  stopSignal: () => boolean;
  pausePollMs: number;
  onAction: (event: ActionEvent) => void;
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onProgress: (pct: number) => void;
  emitMetrics: (outcome: MissionCapOutcome) => void;
  nowTime: () => string;
  delay: (ms: number) => Promise<void>;
}

/**
 * Pure: classifies cumulative mission spend against a budget cap (T1.3,
 * spec §7.3/§8). 0/absent/negative cap => 'ok' (unlimited). Mirrors
 * runtime.ts's exported `classifyBudget` EXACTLY — kept here (rather than
 * importing it) so managedAgent.ts does not import a runtime.ts value
 * (runtime.ts already imports planAndActManaged).
 */
export function classifyBudgetStatus(costUsd: number, capUsd: number | undefined): CapStatus {
  if (!capUsd || capUsd <= 0) return 'ok';
  const ratio = costUsd / capUsd;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= 0.9) return 'warning';
  return 'ok';
}

/** Pure: classifies elapsed wall-clock against maxDurationMs (W-GUARD). */
export function classifyDurationStatus(elapsedMs: number, capMs: number | undefined): CapStatus {
  if (!capMs || capMs <= 0) return 'ok';
  const ratio = elapsedMs / capMs;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= 0.9) return 'warning';
  return 'ok';
}

/** Poll pauseFlags until resume or user stop. Returns 'stop' if Stop won. */
export async function pauseUntilResumed(io: MissionCapIo): Promise<CapFlow> {
  while (io.pauseSignal()) {
    if (io.stopSignal()) {
      io.onAction({ time: io.nowTime(), text: 'Agent stopped by user', isLive: false });
      return 'stop';
    }
    await io.delay(io.pausePollMs);
  }
  io.onAction({
    time: io.nowTime(),
    text: io.t ? io.t('agents.managedAgent.missionResumed') : 'Reprise de la mission',
    isLive: true,
  });
  return 'continue';
}

function capPct(used: number, cap: number | undefined): number {
  return cap ? Math.round((used / cap) * 100) : 0;
}

export async function applyBudgetCap(
  io: MissionCapIo,
  opts: {
    costUsd: number;
    capUsd: number | undefined;
    warned: boolean;
    markWarned: () => void;
    onExceeded?: () => void;
    onPaused?: () => void;
  },
): Promise<CapFlow> {
  const status = classifyBudgetStatus(opts.costUsd, opts.capUsd);
  if (status === 'ok') return 'continue';
  const pct = capPct(opts.costUsd, opts.capUsd);
  if (status === 'exceeded') {
    emitBuffered({
      tsMs: Date.now(),
      projectId: io.projectId,
      missionId: io.missionId,
      actor: 'system',
      type: 'budget.exceeded',
      payload: { capUsd: opts.capUsd ?? 0, spentUsd: opts.costUsd },
    });
    io.onAction({
      time: io.nowTime(),
      text: io.t
        ? io.t('agents.managedAgent.budgetExceededStop', { pct })
        : `Budget dépassé (${pct}% du plafond) — arrêt de la mission`,
      isLive: false,
    });
    io.onStep(4, 'done', `budget dépassé · ${io.nowTime()}`);
    io.onProgress(100);
    io.emitMetrics({ type: 'failed', reason: 'budget_exceeded' });
    opts.onExceeded?.();
    return 'stop';
  }
  if (opts.warned) return 'continue';
  opts.markWarned();
  emitEvent({
    tsMs: Date.now(),
    projectId: io.projectId,
    missionId: io.missionId,
    actor: 'system',
    type: 'budget.warning',
    payload: { pct, capUsd: opts.capUsd ?? 0 },
  });
  io.onAction({
    time: io.nowTime(),
    text: io.t
      ? io.t('agents.managedAgent.budgetWarningPause', { pct })
      : `Budget à ${pct}% du plafond — mise en pause`,
    isLive: false,
  });
  opts.onPaused?.();
  return pauseUntilResumed(io);
}

export async function applyDurationCap(
  io: MissionCapIo,
  opts: {
    elapsedMs: number;
    capMs: number | undefined;
    warned: boolean;
    markWarned: () => void;
    onExceeded?: () => void;
    onPaused?: () => void;
  },
): Promise<CapFlow> {
  const status = classifyDurationStatus(opts.elapsedMs, opts.capMs);
  if (status === 'ok') return 'continue';
  const pct = capPct(opts.elapsedMs, opts.capMs);
  if (status === 'exceeded') {
    emitBuffered({
      tsMs: Date.now(),
      projectId: io.projectId,
      missionId: io.missionId,
      actor: 'system',
      type: 'duration.exceeded',
      payload: { capMs: opts.capMs ?? 0, elapsedMs: opts.elapsedMs },
    });
    io.onAction({
      time: io.nowTime(),
      text: io.t
        ? io.t('agents.managedAgent.durationExceededStop', { pct })
        : `Délai maximum dépassé (${pct}% du plafond) — arrêt de la mission`,
      isLive: false,
    });
    io.onStep(4, 'done', `délai dépassé · ${io.nowTime()}`);
    io.onProgress(100);
    io.emitMetrics({ type: 'failed', reason: 'duration_exceeded' });
    opts.onExceeded?.();
    return 'stop';
  }
  if (opts.warned) return 'continue';
  opts.markWarned();
  emitEvent({
    tsMs: Date.now(),
    projectId: io.projectId,
    missionId: io.missionId,
    actor: 'system',
    type: 'duration.warning',
    payload: { pct, capMs: opts.capMs ?? 0 },
  });
  io.onAction({
    time: io.nowTime(),
    text: io.t
      ? io.t('agents.managedAgent.durationWarningPause', { pct })
      : `Délai à ${pct}% du plafond — mise en pause`,
    isLive: false,
  });
  opts.onPaused?.();
  return pauseUntilResumed(io);
}

export async function applyMissionCaps(
  io: MissionCapIo,
  budget: Parameters<typeof applyBudgetCap>[1],
  duration: Parameters<typeof applyDurationCap>[1],
): Promise<CapFlow> {
  if ((await applyBudgetCap(io, budget)) === 'stop') return 'stop';
  if ((await applyDurationCap(io, duration)) === 'stop') return 'stop';
  return 'continue';
}
