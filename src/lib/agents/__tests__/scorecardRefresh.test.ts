/**
 * scorecardRefresh.test.ts — regression coverage for the real-user report
 * (2026-08-14): "SUCCESS RATE — No completed missions" / "AVG. COST — No
 * cost data" rendered even though the canvas plainly showed completed
 * missions. Root cause: `groupByMission` read `payload?.missionId`
 * (camelCase, inside the parsed JSON payload) and `computeAvgCost` read
 * `payload?.costCents` — neither field is ever written there. The real
 * `JournalEventRow` shape (`queryJournalSince`'s return type) carries the
 * mission id as a top-level `mission_id` column, and real `spend.tokens`
 * rows carry `SpendTokensPayload.costUsd` (USD), never `costCents`. These
 * tests build realistic rows (top-level `mission_id`, real event `type`s
 * this codebase actually emits — see runtime.ts/agentsStore.tsx) and assert
 * `buildScorecard` reports real numbers instead of "unavailable" for all of
 * them — no test previously exercised this against a realistic row shape.
 */
import { describe, it, expect } from 'vitest';
import { buildScorecard } from '../scorecardRefresh';
import type { JournalEventRow, JournalActor, JournalEventType } from '../../journal/eventTypes.js';

let seq = 0;

function row(
  type: JournalEventType,
  missionId: string | null,
  tsMs: number,
  payload: Record<string, unknown> = {},
  actor: JournalActor = 'agent',
): JournalEventRow {
  seq += 1;
  return {
    seq,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor,
    type,
    payload: JSON.stringify(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

describe('buildScorecard — realistic JournalEventRow shapes', () => {
  it('counts a mission.started + mission.completed pair as one successful, completed mission', () => {
    const events: JournalEventRow[] = [
      row('mission.started', 'm1', 1000),
      row('mission.completed', 'm1', 5000, { durationMs: 4000, costUsd: 0.07 }),
    ];

    const scorecard = buildScorecard(events);

    const successRate = scorecard.entries.find((e) => e.labelKey === 'cockpit.scorecard.label.successRate');
    expect(successRate?.source).toBe('real');
    expect(successRate?.value).toBe(100);

    const avgDuration = scorecard.entries.find((e) => e.labelKey === 'cockpit.scorecard.label.avgDuration');
    expect(avgDuration?.source).toBe('real');
    expect(avgDuration?.value).toBe(4000);
  });

  it('counts a mission.failed row as a failure, not a silent no-op', () => {
    const events: JournalEventRow[] = [
      row('mission.started', 'm1', 1000),
      row('mission.failed', 'm1', 2000, { reason: 'timeout' }),
    ];

    const scorecard = buildScorecard(events);
    const successRate = scorecard.entries.find((e) => e.labelKey === 'cockpit.scorecard.label.successRate');
    expect(successRate?.source).toBe('real');
    expect(successRate?.value).toBe(0);
  });

  it('a mission.approved-only mission (no prior mission.completed, e.g. an older generation) still counts as done', () => {
    const events: JournalEventRow[] = [row('mission.approved', 'm1', 3000, { approvedBy: 'user' })];

    const scorecard = buildScorecard(events);
    const successRate = scorecard.entries.find((e) => e.labelKey === 'cockpit.scorecard.label.successRate');
    expect(successRate?.source).toBe('real');
    expect(successRate?.value).toBe(100);
  });

  it('averages real spend.tokens costUsd rows into credits (currency-leak fix: never dollars)', () => {
    const events: JournalEventRow[] = [
      row('mission.started', 'm1', 1000),
      row('spend.tokens', 'm1', 1500, { tokensIn: 100, tokensOut: 50, costUsd: 0.1, source: 'real' }),
      row('spend.tokens', 'm1', 2000, { tokensIn: 200, tokensOut: 80, costUsd: 0.3, source: 'real' }),
      row('mission.completed', 'm1', 3000, { durationMs: 2000, costUsd: 0.4 }),
    ];

    const scorecard = buildScorecard(events);
    const avgCost = scorecard.entries.find((e) => e.labelKey === 'cockpit.scorecard.label.avgCost');
    expect(avgCost?.source).toBe('real');
    expect(avgCost?.unit).toBe('credits');
    // avg of 0.1 and 0.3 USD = 0.2 USD = 20 credits (1 credit == 1 USD cent)
    expect(avgCost?.value).toBe(20);
  });

  it('events with no mission_id (project-level events) are ignored, not silently mis-grouped', () => {
    const events: JournalEventRow[] = [row('project.opened', null, 500, { root: '/repo' })];

    const scorecard = buildScorecard(events);
    const successRate = scorecard.entries.find((e) => e.labelKey === 'cockpit.scorecard.label.successRate');
    expect(successRate?.source).toBe('unavailable');
  });

  it('an empty journal reports every entry as honestly unavailable, never a fabricated zero', () => {
    const scorecard = buildScorecard([]);
    for (const entry of scorecard.entries) {
      expect(entry.source).toBe('unavailable');
      expect(entry.value).toBeNull();
    }
  });
});
