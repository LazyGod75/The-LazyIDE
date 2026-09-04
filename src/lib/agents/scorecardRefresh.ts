/* scorecardRefresh.ts — P8.1: Refresh orchestrator scorecard honestly.

   Computes an honest scorecard from journal events — no fabricated metrics,
   no stale cache. Every number is derived from real journal rows or
   explicitly marked as "unavailable" when no data exists.

   The scorecard covers: mission success rate, avg cost, avg duration,
   contest win rate, replan frequency, and brain recall hit rate.

   i18n note (2026-08 pass): entries carry i18n KEYS (labelKey/tooltipKey +
   tooltipParams), not resolved text — same "reasonKey" convention
   chainValidation.ts already established for this codebase (see
   ShortcutsPanel.tsx's own doc comment) — because this is pure, no-I/O,
   no-React code with no `t` access. ScorecardPanel.tsx (the sole renderer,
   already has `t` via useI18n) resolves them at render time.

   Bug fix (real user report, 2026-08-14 — "SUCCESS RATE / No completed
   missions" shown while the canvas plainly had missions labelled `done 5d`,
   `done 4d`, `done 2d`): `groupByMission` used to read `payload?.missionId`
   (camelCase, from inside the parsed JSON payload) and `computeAvgCost` used
   to read `payload?.costCents`. Neither field ever exists at those
   locations — `JournalEventRow` (the REAL shape `queryJournalSince`
   returns) carries the mission id as a top-level `mission_id` column
   (snake_case, never duplicated into the payload — see agentsStore.tsx's
   `mission.updated`/`mission.approved` emitters) and the real spend
   envelope is `SpendTokensPayload.costUsd` (USD, never `costCents` — see
   runtime.ts/managedAgent.ts's `spend.tokens` emitters). So `groupByMission`
   discarded EVERY event (`if (!missionId) continue` always hit) and
   `computeAvgCost` always saw zero costs — success rate, avg cost, replan
   frequency, and brain recall rate were ALL permanently "unavailable",
   regardless of how many missions had actually completed. Fixed to read the
   real row/payload shape (`e.mission_id`, `e.type`, `SpendTokensPayload`'s
   `costUsd`) instead of guessing field names nothing ever wrote to. No test
   previously exercised this against a realistic `JournalEventRow` shape —
   see this module's own test file.
*/

import type { JournalEventRow } from '../journal/eventTypes.js';

export interface ScorecardEntry {
  labelKey: string;
  value: number | null;
  unit: string;
  /** "real" when computed from journal data, "unavailable" when no data. */
  source: 'real' | 'unavailable';
  /** Optional tooltip i18n key explaining the value, resolved with
   *  `tooltipParams` by the renderer. */
  tooltipKey?: string;
  tooltipParams?: Record<string, string | number>;
}

export interface Scorecard {
  entries: ScorecardEntry[];
  generatedAt: number;
  /** Number of journal rows the scorecard was computed from. */
  sampleSize: number;
}

/** Build a scorecard from journal events. */
export function buildScorecard(events: readonly JournalEventRow[]): Scorecard {
  const missions = groupByMission(events);
  const completedMissions = missions.filter((m) => m.hasDone || m.hasFailed);
  const successfulMissions = missions.filter((m) => m.hasDone);
  const failedMissions = missions.filter((m) => m.hasFailed && !m.hasDone);
  const contestEvents = events.filter((e) => e.type === 'contest.completed');
  const replanEvents = events.filter((e) => (e.type as string) === 'graph.replan');
  const brainRecallEvents = events.filter((e) => e.type === 'brain.recalled');

  const entries: ScorecardEntry[] = [];

  // Mission success rate
  entries.push(computeSuccessRate(successfulMissions.length, failedMissions.length));

  // Average cost
  entries.push(computeAvgCost(events));

  // Average duration
  entries.push(computeAvgDuration(missions));

  // Contest win rate
  entries.push(computeContestWinRate(contestEvents));

  // Replan frequency
  entries.push(computeReplanFrequency(replanEvents, completedMissions.length));

  // Brain recall hit rate
  entries.push(computeBrainHitRate(brainRecallEvents, completedMissions.length));

  return {
    entries,
    generatedAt: Date.now(),
    sampleSize: events.length,
  };
}

interface MissionEvents {
  missionId: string;
  events: JournalEventRow[];
  hasDone: boolean;
  hasFailed: boolean;
  startedMs?: number;
  doneMs?: number;
}

/** Groups journal rows by mission using the REAL row-level `mission_id`
 *  column (never `payload.missionId` — see this module's header comment).
 *  A mission counts as "done" the moment either `mission.completed` (the
 *  agent run's own end, reached 'review') or `mission.approved` (a real
 *  merge, which this codebase's journal sometimes emits without a prior
 *  `mission.completed` for older/replayed generations) is seen — whichever
 *  comes first sets `doneMs`, so avg duration measures the agent's own run
 *  time rather than getting pulled later by an eventual human approval. */
function groupByMission(events: readonly JournalEventRow[]): MissionEvents[] {
  const map = new Map<string, MissionEvents>();

  for (const e of events) {
    const missionId = e.mission_id;
    if (!missionId) continue;

    let entry = map.get(missionId);
    if (!entry) {
      entry = {
        missionId,
        events: [],
        hasDone: false,
        hasFailed: false,
      };
      map.set(missionId, entry);
    }
    entry.events.push(e);

    if (e.type === 'mission.started') entry.startedMs = e.ts_ms;
    if (!entry.hasDone && (e.type === 'mission.completed' || e.type === 'mission.approved')) {
      entry.hasDone = true;
      entry.doneMs = e.ts_ms;
    }
    if (e.type === 'mission.failed') entry.hasFailed = true;
  }

  return Array.from(map.values());
}

function computeSuccessRate(success: number, failed: number): ScorecardEntry {
  const total = success + failed;
  if (total === 0) {
    return {
      labelKey: 'cockpit.scorecard.label.successRate',
      value: null,
      unit: '%',
      source: 'unavailable',
      tooltipKey: 'cockpit.scorecard.tooltip.noCompletedMissions',
    };
  }
  return {
    labelKey: 'cockpit.scorecard.label.successRate',
    value: Math.round((success / total) * 1000) / 10,
    unit: '%',
    source: 'real',
    tooltipKey: 'cockpit.scorecard.tooltip.successBreakdown',
    tooltipParams: { success, total },
  };
}

/** Currency-leak fix (real user report, 2026-08-14): this used to render as
 *  `$X.XXXX` (`unit: '$'`) — this app's standing rule is credits, never
 *  currency, for cost-of-work figures. `unit: 'credits'` here means `value`
 *  is ALREADY credits-denominated (this codebase's established
 *  `credits_remaining_cents` convention — 1 credit == 1 USD cent — see
 *  lib/billing/credits.ts) so ScorecardPanel.tsx's renderer can format it
 *  with `formatCredits` directly, no further conversion. Field-shape fix
 *  (same report): real `spend.tokens` rows carry `SpendTokensPayload.costUsd`
 *  (USD), never a `costCents` field — see this module's header comment. */
function computeAvgCost(events: readonly JournalEventRow[]): ScorecardEntry {
  const costs = events
    .filter((e) => e.type === 'spend.tokens')
    .map((e) => parsePayload(e)?.costUsd as number | undefined)
    .filter((c): c is number => typeof c === 'number');

  if (costs.length === 0) {
    return {
      labelKey: 'cockpit.scorecard.label.avgCost',
      value: null,
      unit: 'credits',
      source: 'unavailable',
      tooltipKey: 'cockpit.scorecard.tooltip.noCostData',
    };
  }
  const avgUsd = costs.reduce((a, b) => a + b, 0) / costs.length;
  return {
    labelKey: 'cockpit.scorecard.label.avgCost',
    value: Math.round(avgUsd * 100),
    unit: 'credits',
    source: 'real',
    tooltipKey: 'cockpit.scorecard.tooltip.costEventsCount',
    tooltipParams: { count: costs.length },
  };
}

function computeAvgDuration(missions: MissionEvents[]): ScorecardEntry {
  const durations = missions
    .filter((m) => m.startedMs != null && m.doneMs != null)
    .map((m) => m.doneMs! - m.startedMs!);

  if (durations.length === 0) {
    return {
      labelKey: 'cockpit.scorecard.label.avgDuration',
      value: null,
      unit: 'ms',
      source: 'unavailable',
      tooltipKey: 'cockpit.scorecard.tooltip.noDurationData',
    };
  }
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  return {
    labelKey: 'cockpit.scorecard.label.avgDuration',
    value: Math.round(avg),
    unit: 'ms',
    source: 'real',
    tooltipKey: 'cockpit.scorecard.tooltip.durationMissionsCount',
    tooltipParams: { count: durations.length },
  };
}

function computeContestWinRate(contestEvents: JournalEventRow[]): ScorecardEntry {
  if (contestEvents.length === 0) {
    return {
      labelKey: 'cockpit.scorecard.label.contestWinRate',
      value: null,
      unit: '%',
      source: 'unavailable',
      tooltipKey: 'cockpit.scorecard.tooltip.noContestData',
    };
  }
  const withWinner = contestEvents.filter((e) => {
    const p = parsePayload(e);
    return p?.winnerId != null;
  }).length;
  return {
    labelKey: 'cockpit.scorecard.label.contestWinRate',
    value: Math.round((withWinner / contestEvents.length) * 1000) / 10,
    unit: '%',
    source: 'real',
    tooltipKey: 'cockpit.scorecard.tooltip.contestBreakdown',
    tooltipParams: { withWinner, total: contestEvents.length },
  };
}

function computeReplanFrequency(replanEvents: JournalEventRow[], completedCount: number): ScorecardEntry {
  if (completedCount === 0) {
    return {
      labelKey: 'cockpit.scorecard.label.replanFrequency',
      value: null,
      unit: '/mission',
      source: 'unavailable',
      tooltipKey: 'cockpit.scorecard.tooltip.noCompletedMissions',
    };
  }
  return {
    labelKey: 'cockpit.scorecard.label.replanFrequency',
    value: Math.round((replanEvents.length / completedCount) * 100) / 100,
    unit: '/mission',
    source: 'real',
    tooltipKey: 'cockpit.scorecard.tooltip.replanBreakdown',
    tooltipParams: { count: replanEvents.length, total: completedCount },
  };
}

function computeBrainHitRate(brainEvents: JournalEventRow[], completedCount: number): ScorecardEntry {
  if (completedCount === 0) {
    return {
      labelKey: 'cockpit.scorecard.label.brainRecallRate',
      value: null,
      unit: '%',
      source: 'unavailable',
      tooltipKey: 'cockpit.scorecard.tooltip.noCompletedMissions',
    };
  }
  return {
    labelKey: 'cockpit.scorecard.label.brainRecallRate',
    value: Math.round((brainEvents.length / completedCount) * 1000) / 10,
    unit: '%',
    source: 'real',
    tooltipKey: 'cockpit.scorecard.tooltip.brainRecallBreakdown',
    tooltipParams: { count: brainEvents.length, total: completedCount },
  };
}

function parsePayload(e: JournalEventRow): Record<string, unknown> | null {
  try {
    return JSON.parse(e.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
