/* silenceWatchdog.ts — Silence watchdog for RUNNING missions.

   Real incident (M72, observed 2026-08-07): a mission ran `next build` in
   its worktree (managed engine, toolRuntime.ts's Bash tool), the build
   exited 1, the observation was appended to the mission's actionTimeline
   ("Observation: [exit 1] ... Compiled successfully ... Linting and
   chec…"), and then the agent's NEXT model turn never returned — no error,
   no further action event, nothing. The mission stayed `running` at 34%
   progress for 1535s (~25.6min) until a human noticed and stopped it
   manually.

   Two existing pieces already understood "silence" — neither of them acted
   on it:
     1. The UI's own display heartbeat — MissionNode.tsx's
        `isHeartbeatStale`/`HEARTBEAT_STALE_THRESHOLD_MS` (90s), keyed off
        `mission.updatedMs` (bumped by every journal write, itself
        downstream of every `onUpdate` call in runtime.ts's runMission). It
        literally renders "agent silent · Ns" — a soft visual cue, not a
        fault threshold; nothing consumed it to actually stop the mission.
     2. `activityWatchdog.ts` (lib/models) — a real, tested silence+ceiling
        timer already used for the assistant chat path (claudeCodeProvider's
        buildRunTurn). Its own doc comment explicitly says mission runs
        don't need it, "they already tolerate open-ended silence up to
        their wall-clock cap" — an assumption this incident falsifies:
        `contract.maxDurationMs` is optional and, in the observed case,
        unset, so there was NO cap of any kind once the agent went silent.

   This module builds on (2) directly — reuses `createActivityWatchdog`
   rather than inventing a parallel timer primitive — and adds the
   mission-specific piece: a threshold tuned for agent-turn silence (not
   chat-turn silence) and a recovery decision that reuses recovery.ts's
   evaluateRecovery instead of inventing a parallel retry-counting rule.
   See runtime.ts's runMission for the wiring (ping()/dispose(), the
   pause/awaiting-approval eligibility check, and the onTimeout handler).
*/

import { evaluateRecovery, type RecoveryDecision } from './recovery.js';
import type { PermissionMode } from './runtime.js';
import type { StageContract } from './stageContract.js';

/**
 * How long a RUNNING mission may go with no activity (no `onUpdate` call —
 * see runtime.ts's wiring) before the watchdog treats it as stalled.
 *
 * Chosen from the observed incident: the mission sat silent for 1535s
 * (~25.6min) before a human intervened. A normal agent turn can
 * legitimately take minutes (a large tool call, a slow model backend), so
 * this must stay well above:
 *   - the UI's own 90s "agent silent" heartbeat label
 *     (HEARTBEAT_STALE_THRESHOLD_MS in MissionNode.tsx) — a soft visual
 *     cue shown the moment things go quiet, not a fault threshold;
 *   - activityWatchdog.ts's own DEFAULT_SILENCE_MS (60s) — tuned for a
 *     CHAT turn, where a human is watching live and expects sub-minute
 *     responsiveness; an autonomous mission turn (a build, a test suite,
 *     a large refactor) has no such expectation.
 * Firing at either of those would be trigger-happy and would abort
 * perfectly healthy long tool calls.
 *
 * 10 minutes is generous enough to absorb a genuinely slow-but-alive turn
 * while still bounding the wasted-slot window: on the FIRST strike the
 * watchdog gives the mission one more full window rather than failing
 * outright (see evaluateSilenceRecovery), so the worst case is two
 * threshold windows (~20min) before the mission is forced to a terminal
 * state — a large cut from the observed ~25.6min unbounded hang, without
 * being so short it fires mid-build.
 */
export const SILENCE_WATCHDOG_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Absolute outer ceiling passed to createActivityWatchdog's `ceilingMs`
 * (its default, 10min, is tuned for a chat turn and would be actively
 * harmful here — a healthy mission legitimately runs far longer than
 * that). 24h is not expected to ever fire in practice: it exists only as
 * a defensive backstop against a `ping()` call site being missed, well
 * outside setTimeout's ~24.8-day signed-32-bit ceiling.
 */
export const SILENCE_WATCHDOG_CEILING_MS = 24 * 60 * 60 * 1000;

export type SilenceDecision = RecoveryDecision;

/**
 * Pure: decides what the watchdog does on a silence strike, reusing
 * recovery.ts's evaluateRecovery instead of inventing a parallel
 * retry-counting rule. The synthetic stage's error message contains
 * "timeout" so it lands on evaluateRecovery's environmentalPolicy (bounded
 * retry then block) rather than its generic defaultPolicy — a silence
 * timeout genuinely IS an environmental failure (network hang, wedged
 * backend), not a task-shaped one.
 *
 * `strikeCount` is the number of PRIOR silence strikes already recorded
 * for this mission (0 on the first strike, 1 on the second, …). maxAttempts
 * is fixed at 1: exactly one retry ("wait one more window") is allowed
 * before the decision becomes terminal — see runtime.ts's wiring for why a
 * watchdog firing mid-run cannot safely do more than that (no way to
 * cancel and relaunch an in-flight managed turn without risking two
 * concurrent loops writing the same worktree — "retry" here means giving
 * the existing run one more silence window, never a fresh relaunch).
 */
export function evaluateSilenceRecovery(strikeCount: number, silentMs: number): SilenceDecision {
  const minutes = Math.round(silentMs / 60000);
  const syntheticStage: StageContract = {
    id: 'silence-watchdog',
    kind: 'implement',
    label: 'Silence watchdog',
    description: "Synthetic stage — reuses recovery.ts's environmental-error policy for a silence timeout",
    model: '',
    permissionMode: 'plan' as PermissionMode,
    systemPrompt: '',
    taskPrompt: '',
    state: 'in_progress',
    attemptCount: strikeCount,
    maxAttempts: 1,
    dependsOn: [],
    onPass: null,
    onFail: null,
  };
  return evaluateRecovery(syntheticStage, `Agent silence timeout — no output for ${minutes}min`);
}

export type SilenceTimeoutAction = 'noop' | 'rearm' | 'waiting' | 'stop';

export interface SilenceTimeoutInput {
  settled: boolean;
  final: boolean;
  paused: boolean;
  awaitingHuman: boolean;
  strikeCount: number;
  t?: (key: string, params?: Record<string, string | number>) => string;
}

export interface SilenceTimeoutResult {
  action: SilenceTimeoutAction;
  strikeCount: number;
  waitingText?: string;
  stopText?: string;
  stopReason?: string;
}

function silenceMinutes(strikes: number): number {
  return Math.round((SILENCE_WATCHDOG_THRESHOLD_MS * strikes) / 60000);
}

/** Pure decision for runMission's silence-watchdog onTimeout (cx 9 nested
 *  arrow). Side effects (timeline, kill, rearm) stay in runtime.ts. */
export function decideSilenceTimeout(input: SilenceTimeoutInput): SilenceTimeoutResult {
  if (input.settled || input.final) {
    return { action: 'noop', strikeCount: input.strikeCount };
  }
  if (input.paused || input.awaitingHuman) {
    return { action: 'rearm', strikeCount: input.strikeCount };
  }
  const silentMs = SILENCE_WATCHDOG_THRESHOLD_MS * (input.strikeCount + 1);
  const decision = evaluateSilenceRecovery(input.strikeCount, silentMs);
  const strikeCount = input.strikeCount + 1;
  const minutes = silenceMinutes(strikeCount);
  if (decision.action === 'retry') {
    const waitingText = input.t
      ? input.t('agents.runtime.silenceWatchdogWaiting', { minutes })
      : `Agent silencieux depuis ${minutes}min — nouvelle fenêtre d'attente avant arrêt`;
    return { action: 'waiting', strikeCount, waitingText };
  }
  const stopText = input.t
    ? input.t('agents.runtime.silenceWatchdogStop', { minutes })
    : `Mission arrêtée — agent silencieux depuis ${minutes}min, aucune réponse`;
  const stopReason = input.t
    ? input.t('agents.runtime.silenceWatchdogReason', { minutes })
    : `${stopText}.`;
  return { action: 'stop', strikeCount, stopText, stopReason };
}
