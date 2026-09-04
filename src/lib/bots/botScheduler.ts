/* botScheduler — drives LazyBot routines on a stable interval.

   Follows the same pattern as loopScheduler.ts: one interval for the caller's
   lifetime, an in-flight guard so two ticks never race, and a serialized
   read-modify-write of the bot store. Due routines fire their task as a bot
   run via launchBotRun, and lastRunAt is advanced BEFORE the run starts so a
   crash never re-fires the same tick.

   Cron parsing is deliberately minimal — we support 5-field cron expressions
   via a small parser. For complex schedules, the user should use a dedicated
   scheduler; this is for "every weekday at 9am" style bot routines.

   C76 — launch/tick failures emit bus + journal (not console.error only).
   C67 — web builds use startWebRoutineCatcher to enqueue due routines for
   Tauri resume instead of silently no-op'ing.
*/

import type { BotConfig, BotMissionInput, BotRoutine } from './botTypes.js';
import { listBots, saveBot } from './botStorage.js';
import { launchBotRun } from './botEngine.js';
import { enqueueRoutineFire } from './botRoutineQueue.js';
import { emit } from '../bus.js';
import { emitEvent } from '../journal/journal.js';
import { getCachedProjectRoot } from '../agents/projectRootCache.js';

export interface BotSchedulerDeps {
  /** Creates the routine's run as a REAL mission in the agents store (the
   *  caller threads addMission here) - see launchBotRun's doc comment. */
  createMission: (input: BotMissionInput) => Promise<string>;
  defaultModelId: () => string;
  /** Called when a routine fires — lets the caller show a toast or update UI. */
  onRoutineFired?: (bot: BotConfig, routine: BotRoutine) => void;
  /** Called when a routine launch fails after lastRunAt was advanced (C76). */
  onRoutineFailed?: (bot: BotConfig, routine: BotRoutine, error: string) => void;
}

/** C67 — clear message when routines cannot run (web / no Tauri). */
export const WEB_ROUTINES_DISABLED_MESSAGE =
  'LazyBot routines require the Lazy Desktop app (Tauri). Web mode queues due routines for the next desktop session and will not fire cron schedules live.';

const TICK_INTERVAL_MS = 60_000;

/** Parse a 5-field cron expression and return the next run time after `from`. */
export function nextCronRun(cron: string, from: Date = new Date()): Date | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const now = new Date(from.getTime() + 60_000);
  now.setSeconds(0, 0);

  for (let i = 0; i < 525600; i++) {
    const candidate = new Date(now.getTime() + i * 60_000);
    if (!matchField(month, candidate.getMonth() + 1)) continue;
    if (!matchField(dayOfMonth, candidate.getDate())) continue;
    if (!matchField(dayOfWeek, candidate.getDay())) continue;
    if (!matchField(hour, candidate.getHours())) continue;
    if (!matchField(minute, candidate.getMinutes())) continue;
    return candidate;
  }
  return null;
}

function matchField(pattern: string, value: number): boolean {
  if (pattern === '*') return true;
  for (const part of pattern.split(',')) {
    if (part === '*') return true;
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      const baseNum = base === '*' ? 0 : parseInt(base, 10);
      if (isNaN(baseNum)) continue;
      if (value >= baseNum && (value - baseNum) % step === 0) return true;
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map((n) => parseInt(n, 10));
      if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && value === num) return true;
    }
  }
  return false;
}

/** Check if a routine is due to run. */
export function isRoutineDue(routine: BotRoutine, now: Date = new Date()): boolean {
  if (!routine.enabled) return false;
  const next = nextCronRun(routine.schedule, routine.lastRunAt ? new Date(routine.lastRunAt) : new Date(0));
  if (!next) return false;
  return next.getTime() <= now.getTime();
}

function reportRoutineFailure(
  bot: BotConfig,
  routine: BotRoutine,
  err: unknown,
  deps: BotSchedulerDeps,
): void {
  const error = err instanceof Error ? err.message : String(err);
  console.error(`[botScheduler] routine "${routine.name}" failed:`, err);
  emit('bot:routineFailed', {
    botId: bot.id,
    botName: bot.name,
    routineId: routine.id,
    routineName: routine.name,
    error,
    at: Date.now(),
  });
  const projectId = getCachedProjectRoot() || 'unknown';
  emitEvent({
    type: 'lazybot.routine_failed',
    tsMs: Date.now(),
    projectId,
    actor: 'system',
    payload: {
      botId: bot.id,
      botName: bot.name,
      routineId: routine.id,
      routineName: routine.name,
      error,
    },
  });
  deps.onRoutineFailed?.(bot, routine, error);
}

export interface BotSchedulerHandle {
  stop: () => void;
  /** Force a tick now (tests). */
  tickNow: () => Promise<void>;
}

/** Start the bot routine scheduler. Returns a stop function. */
export function startBotScheduler(deps: BotSchedulerDeps): BotSchedulerHandle {
  let stopped = false;
  let ticking = false;

  const runTick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const bots = await listBots();
      const now = new Date();
      for (const bot of bots) {
        if (!bot.enabled) continue;
        for (const routine of bot.routines) {
          if (!isRoutineDue(routine, now)) continue;

          // Advance lastRunAt BEFORE launching so a crash doesn't re-fire.
          const updatedRoutine: BotRoutine = { ...routine, lastRunAt: now.toISOString() };
          const updatedBot: BotConfig = {
            ...bot,
            routines: bot.routines.map((r) => (r.id === routine.id ? updatedRoutine : r)),
            updatedAt: now.toISOString(),
          };
          await saveBot(updatedBot);

          // Launch the run (fire-and-forget — the engine tracks it).
          void launchBotRun(updatedBot, routine.task, {
            createMission: deps.createMission,
            model: deps.defaultModelId(),
            routineId: routine.id,
          }).catch((err) => {
            reportRoutineFailure(updatedBot, updatedRoutine, err, deps);
          });

          deps.onRoutineFired?.(updatedBot, updatedRoutine);
        }
      }
    } catch (err) {
      console.error('[botScheduler] tick failed:', err);
      emit('bot:routineFailed', {
        botId: '',
        botName: '',
        routineId: '',
        routineName: '',
        error: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
      emitEvent({
        type: 'lazybot.routine_failed',
        tsMs: Date.now(),
        projectId: getCachedProjectRoot() || 'unknown',
        actor: 'system',
        payload: {
          botName: 'scheduler',
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      ticking = false;
    }
  };

  const interval = setInterval(() => { void runTick(); }, TICK_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    tickNow: runTick,
  };
}

/**
 * C67 — web catcher: when a routine is due, enqueue it for the next Tauri
 * session instead of launching (no always-on desktop runtime on web).
 */
export function startWebRoutineCatcher(): BotSchedulerHandle {
  let stopped = false;
  let ticking = false;

  const runTick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const bots = await listBots();
      const now = new Date();
      for (const bot of bots) {
        if (!bot.enabled) continue;
        for (const routine of bot.routines) {
          if (!isRoutineDue(routine, now)) continue;
          enqueueRoutineFire({
            botId: bot.id,
            botName: bot.name,
            routineId: routine.id,
            routineName: routine.name,
            task: routine.task,
            dueAt: now.toISOString(),
          });
        }
      }
    } catch (err) {
      console.warn('[botScheduler] web catcher tick failed:', err);
    } finally {
      ticking = false;
    }
  };

  // First tick soon so a long-open web tab still captures dues.
  void runTick();
  const interval = setInterval(() => { void runTick(); }, TICK_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    tickNow: runTick,
  };
}
