/* nightShift.ts — Standing loops for autonomous brain maintenance (spec §8, §7.3).

   The "night shift" is a set of standing loops that run periodically to:
   1. Consolidate completed missions into brain neurons (T3.3 pipeline)
   2. Promote high-value neurons to the root trunk (T3.3 pipeline)
   3. Review and optionally retry failed missions
   4. Emit scheduler.queued events for auditability

   Unlike the loop scheduler (loopScheduler.ts) which fires user-defined
   agent missions, the night shift runs system-level maintenance tasks
   that don't require human interaction. It's designed to run during idle
   periods (hence "night shift") but can also be triggered on demand.

   The scheduler emits `scheduler.queued` events for each task it enqueues,
   providing a journal trail of autonomous activity.

   ── Idle + budget contract (T3.4 audit follow-up) ─────────────────────
   The automatic standing loop (startNightShift's tick()) only actually runs
   a cycle when ALL of these hold:
     1. Cadence: at least one hour since the last cycle actually ran,
        persisted across app restarts (see NightShiftPersistedState's
        lastRunAtIso) — the interval below still polls every intervalMs,
        but only a subset of polls turn into real work.
     2. Idle: no journal event with actor 'user' in the trailing
        `idleMinutes` (default 30) window — the journal, not a DOM
        listener, is this app's single source of "is the user around"
        (spec's journal-truth principle).
     3. No mission running: no 'mission.started' event without a matching
        terminal event (completed/failed/cancelled/reverted) yet. This
        reuses journalQuery, the only dependency night shift already had
        on "missions" (see runReviewFailedTask below) — no new coupling to
        agentsStore/scheduler was introduced for this check.
     4. Budget: the current night window (22:00-08:00 local, rolling — see
        currentWindowStartIso) has not yet spent >= config.budgetUsd.
        Spend is measured as the real delta of costStore's
        getCostState().totalCostUsd across a cycle — the same session-wide
        cost accumulator every model call already feeds
        (src/lib/models/costStore.ts) — and persisted per-window to
        localStorage ('lazy.nightshift.window') so it survives restarts
        and resets automatically the moment a new night starts.

   loopEngine.ts integration: loopEngine.ts is a persistent scheduler for
   USER-registered loops (a PersistedLoop always carries a Mission-shaped
   agentTask/model — see its own header contrasting itself with this
   file); it has no loop-TYPE registry or hook a system-maintenance loop
   like this one could plug into without changing loopEngine.ts itself,
   which is out of this fix's touched-files scope (owned by concurrent
   work on the same plan item). Night shift therefore keeps its own
   self-timer (setInterval in startNightShift), now gated by the
   idle/budget/cadence contract above instead of firing unconditionally.

   Results are tagged for the morning briefing (spec §9): each completed
   task run now ALSO emits `loop.iteration` with a `summary` — the exact
   shape src/lib/agents/briefing.ts's buildBriefingDigest reads into its
   nightShift section. Previously this only emitted `loop.tick`, which
   briefing.ts does not read, so night-shift results never reached the
   briefing; the `loop.tick` heartbeat is kept alongside it unchanged.
*/

import { runConsolidationPipeline } from './consolidation.js';
import { journalQuery, emitBuffered } from '../journal/journal.js';
import { getCostState } from '../models/costStore.js';
import { isTauri } from '../platform/index.js';

// ── Types ───────────────────────────────────────────────────────────

export type NightShiftTask = 'consolidate' | 'promote' | 'review-failed';

export interface NightShiftConfig {
  enabled: boolean;
  intervalMs: number;
  tasks: NightShiftTask[];
  /** Max USD the standing loop may spend per night window (22:00-08:00
   *  local, rolling). Default 5 — see DEFAULT_BUDGET_USD. */
  budgetUsd: number;
  /** Minutes of no user-actor journal activity required before an
   *  automatic tick may run a cycle. Default 30 — see DEFAULT_IDLE_MINUTES. */
  idleMinutes: number;
}

export interface NightShiftRunResult {
  task: NightShiftTask;
  success: boolean;
  detail: string;
}

export interface NightShiftReport {
  runs: NightShiftRunResult[];
  timestamp: number;
}

/** Why an automatic tick declined to run a cycle this time (see logSkipOnce). */
export type NightShiftSkipReason = 'cadence' | 'user-active' | 'mission-running' | 'budget';

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
// Root trunk promotion disabled for initial release — capture() has no
// brainId-targeting parameter yet, so promoted neurons land in the wrong
// brain. Re-add 'promote' when Rust-side brainId targeting is implemented.
const DEFAULT_TASKS: NightShiftTask[] = ['consolidate', 'review-failed'];

export const DEFAULT_BUDGET_USD = 5;
export const DEFAULT_IDLE_MINUTES = 30;

/** Hard floor regardless of config: an automatic tick never launches more
 *  than one cycle per hour (audit finding — the 30min interval alone let it
 *  fire unconditionally every 30min). */
const MIN_CADENCE_MS = 60 * 60 * 1000;

export const DEFAULT_NIGHT_SHIFT_CONFIG: NightShiftConfig = {
  enabled: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  tasks: DEFAULT_TASKS,
  budgetUsd: DEFAULT_BUDGET_USD,
  idleMinutes: DEFAULT_IDLE_MINUTES,
};

// ── Task runners ────────────────────────────────────────────────────

async function runConsolidateTask(): Promise<NightShiftRunResult> {
  try {
    const result = await runConsolidationPipeline();
    const detail = `Consolidated ${result.consolidation.missionsProcessed} missions (${result.consolidation.neuronsCaptured} neurons)`;
    return { task: 'consolidate', success: true, detail };
  } catch (err) {
    return { task: 'consolidate', success: false, detail: String(err) };
  }
}

async function runPromoteTask(): Promise<NightShiftRunResult> {
  try {
    const { promoteToRootTrunk } = await import('./consolidation.js');
    const result = await promoteToRootTrunk();
    return {
      task: 'promote',
      success: result.errors.length === 0,
      detail: `Promoted ${result.neuronsPromoted} neurons${result.errors.length > 0 ? `, errors: ${result.errors.join('; ')}` : ''}`,
    };
  } catch (err) {
    return { task: 'promote', success: false, detail: String(err) };
  }
}

async function runReviewFailedTask(): Promise<NightShiftRunResult> {
  try {
    const failedEvents = await journalQuery({
      types: ['mission.failed'],
      limit: 20,
    });

    if (failedEvents.length === 0) {
      return { task: 'review-failed', success: true, detail: 'No failed missions to review' };
    }

    let reviewed = 0;
    for (const event of failedEvents) {
      try {
        // Emit loop.tick for auditability of failed mission review

        emitBuffered({
          tsMs: Date.now(),
          projectId: event.project_id,
          missionId: event.mission_id ?? undefined,
          actor: 'system',
          type: 'loop.tick',
          payload: {
            iteration: reviewed + 1,
          },
        });
        reviewed++;
      } catch {
        // Skip unparseable events
      }
    }

    return {
      task: 'review-failed',
      success: true,
      detail: `Reviewed ${reviewed} failed missions`,
    };
  } catch (err) {
    return { task: 'review-failed', success: false, detail: String(err) };
  }
}

const TASK_RUNNERS: Record<NightShiftTask, () => Promise<NightShiftRunResult>> = {
  consolidate: runConsolidateTask,
  promote: runPromoteTask,
  'review-failed': runReviewFailedTask,
};

// ── Cycle (mechanism — always unconditional, callable on demand) ────

/**
 * Run a single night shift cycle: execute all configured tasks in sequence,
   collect results, and return a report.

   This is the raw mechanism, not the policy — it never checks idle/budget/
   cadence (see tick() inside startNightShift for that). An on-demand caller
   (e.g. a future Settings "run now" button) can call this directly and
   always gets a real run, regardless of what the automatic loop's own gates
   would say.
*/
export async function runNightShiftCycle(
  config: NightShiftConfig = DEFAULT_NIGHT_SHIFT_CONFIG,
): Promise<NightShiftReport> {
  const runs: NightShiftRunResult[] = [];

  for (const task of config.tasks) {
    const runner = TASK_RUNNERS[task];
    if (!runner) continue;

    emitBuffered({
      tsMs: Date.now(),
      projectId: '*',
      actor: 'system',
      type: 'loop.tick',
      payload: {
        iteration: runs.length + 1,
      },
    });

    const result = await runner();
    runs.push(result);

    // Tag the result for the morning briefing (spec §9) — briefing.ts's
    // buildBriefingDigest reads loop.iteration/payload.summary, not
    // loop.tick, into its nightShift section (see file header).
    emitBuffered({
      tsMs: Date.now(),
      projectId: '*',
      actor: 'system',
      type: 'loop.iteration',
      payload: {
        summary: `${task}: ${result.detail}`.slice(0, 300),
      },
    });
  }

  return { runs, timestamp: Date.now() };
}

// ── Idle / budget / cadence contract (policy) ────────────────────────

interface NightShiftPersistedState {
  windowStartIso: string;
  missionIds: string[];
  spentUsd: number;
  /** Independent of window resets — enforces MIN_CADENCE_MS across nights. */
  lastRunAtIso?: string;
}

const WINDOW_STORAGE_KEY = 'lazy.nightshift.window';
const NIGHT_WINDOW_START_HOUR = 22; // 22:00 local

/** ISO start of the night window containing `now` (22:00-08:00 local,
 *  rolling): before 22:00 local belongs to the window that started the
 *  PREVIOUS calendar day at 22:00; at/after 22:00 belongs to today's. */
function currentWindowStartIso(now: Date): string {
  const start = new Date(now);
  if (start.getHours() < NIGHT_WINDOW_START_HOUR) {
    start.setDate(start.getDate() - 1);
  }
  start.setHours(NIGHT_WINDOW_START_HOUR, 0, 0, 0);
  return start.toISOString();
}

function isPersistedState(value: unknown): value is NightShiftPersistedState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.windowStartIso === 'string' &&
    Array.isArray(v.missionIds) &&
    typeof v.spentUsd === 'number'
  );
}

function readWindowState(): NightShiftPersistedState | null {
  try {
    const raw = localStorage.getItem(WINDOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeWindowState(state: NightShiftPersistedState): void {
  try {
    localStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage full/unavailable — best-effort only (mirrors brainDocs.ts)
  }
}

/**
 * The current night window's persisted state. Resets spentUsd/missionIds
 * (fresh window) the moment `now` has rolled into a new window — but
 * carries `lastRunAtIso` forward, since the hourly cadence cap is an
 * independent invariant, not a per-window one.
 */
function getOrResetWindowState(now: Date): NightShiftPersistedState {
  const windowStartIso = currentWindowStartIso(now);
  const existing = readWindowState();
  if (existing && existing.windowStartIso === windowStartIso) return existing;

  const fresh: NightShiftPersistedState = {
    windowStartIso,
    missionIds: [],
    spentUsd: 0,
    lastRunAtIso: existing?.lastRunAtIso,
  };
  writeWindowState(fresh);
  return fresh;
}

/** Any journal event with actor 'user' inside the trailing `idleMinutes`
 *  window means the user is around — night shift must not fire. */
async function isUserActive(idleMinutes: number, now: number): Promise<boolean> {
  const rows = await journalQuery({ sinceMs: now - idleMinutes * 60 * 1000, limit: 200 });
  return rows.some((row) => row.actor === 'user');
}

const MISSION_TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'mission.completed',
  'mission.failed',
  'mission.cancelled',
  'mission.reverted',
]);

/**
 * True when some mission has a 'mission.started' event with no terminal
 * event yet. Reuses journalQuery — the only dependency night shift already
 * had on "missions" (runReviewFailedTask's `mission.failed` query above) —
 * rather than adding a new coupling to agentsStore/scheduler.
 */
async function hasRunningMission(): Promise<boolean> {
  const rows = await journalQuery({
    types: ['mission.started', ...MISSION_TERMINAL_TYPES],
    limit: 500,
  });

  const started = new Set<string>();
  const ended = new Set<string>();
  for (const row of rows) {
    if (!row.mission_id) continue;
    if (row.type === 'mission.started') started.add(row.mission_id);
    else if (MISSION_TERMINAL_TYPES.has(row.type)) ended.add(row.mission_id);
  }

  for (const id of started) {
    if (!ended.has(id)) return true;
  }
  return false;
}

// ── Skip-reason logging (once per reason, not spammed every poll) ──────

let _lastLoggedSkipReason: NightShiftSkipReason | null = null;

function logSkipOnce(reason: NightShiftSkipReason, message: string): void {
  if (_lastLoggedSkipReason === reason) return;
  _lastLoggedSkipReason = reason;
  console.warn(`[nightShift] ${message}`);
}

function clearSkipLog(): void {
  _lastLoggedSkipReason = null;
}

/** Test-only: clears the skip-reason log guard. Call from afterEach()
 *  alongside localStorage.clear(). */
export function resetNightShiftForTests(): void {
  clearSkipLog();
}

// ── Standing loop ───────────────────────────────────────────────────

/**
 * Start the night shift standing loop. Returns a stop function.
 *
 * The timer polls every `config.intervalMs` milliseconds, but each poll
 * only turns into a real cycle when the idle/budget/cadence contract
 * documented at the top of this file is satisfied — see the module header
 * for the full rationale. Only one cycle runs at a time (guarded by an
 * in-flight flag).
 *
 * In non-Tauri (web/demo) mode, the loop is a no-op — brain maintenance
 * requires the Tauri backend.
 */
export function startNightShift(
  config: NightShiftConfig = DEFAULT_NIGHT_SHIFT_CONFIG,
): () => void {
  if (!config.enabled || !isTauri()) {
    return () => {};
  }

  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const now = Date.now();
      const windowState = getOrResetWindowState(new Date(now));

      if (windowState.lastRunAtIso) {
        const elapsedSinceLastRun = now - new Date(windowState.lastRunAtIso).getTime();
        if (elapsedSinceLastRun < MIN_CADENCE_MS) {
          logSkipOnce('cadence', 'skipping tick — last cycle ran less than an hour ago');
          return;
        }
      }

      if (await isUserActive(config.idleMinutes, now)) {
        logSkipOnce('user-active', `skipping tick — user active within the last ${config.idleMinutes}min`);
        return;
      }

      if (await hasRunningMission()) {
        logSkipOnce('mission-running', 'skipping tick — a mission is currently running');
        return;
      }

      if (windowState.spentUsd >= config.budgetUsd) {
        // eventTypes.ts's BudgetWarningPayload has no `scope` field to tag
        // this as a night-shift-internal signal (only pct/capUsd) — emitting
        // it as-is would let Briefing.tsx's asks section surface a
        // fleet-wide "budget warning" for what is really just this
        // autonomous loop pausing itself, so we log honestly instead of
        // emitting a misleading journal event.
        logSkipOnce('budget', `skipping tick — night window budget ($${config.budgetUsd}) reached`);
        return;
      }

      clearSkipLog();

      const spentBefore = getCostState().totalCostUsd;
      await runNightShiftCycle(config);
      const spentAfter = getCostState().totalCostUsd;
      const delta = Math.max(0, spentAfter - spentBefore);

      writeWindowState({
        windowStartIso: windowState.windowStartIso,
        // Night shift's tasks are internal function calls, not agentsStore
        // Mission objects — these are per-cycle run ids, not Mission ids,
        // kept ready for the day a real mission-launching task is added.
        missionIds: [...windowState.missionIds, `cycle-${now}`],
        spentUsd: windowState.spentUsd + delta,
        lastRunAtIso: new Date(now).toISOString(),
      });
    } catch {
      // Night shift is best-effort — never throw into the interval
    } finally {
      inFlight = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, config.intervalMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
