/* reportPeriod.test.ts — pure unit coverage for
   components/agents/report/reportPeriod.ts's filterMissionsByPeriod. */

import { describe, it, expect } from 'vitest';
import { filterMissionsByPeriod } from '../components/agents/report/reportPeriod';
import type { CompletedMissionReport } from '../lib/journal/projectReport';

const NOW = new Date(2026, 6, 14, 12, 0, 0).getTime(); // 2026-07-14 local noon
const TODAY_10AM = new Date(2026, 6, 14, 10, 0, 0).getTime();
const YESTERDAY = new Date(2026, 6, 13, 10, 0, 0).getTime();
const TEN_DAYS_AGO = NOW - 10 * 24 * 60 * 60 * 1000;

function mission(missionId: string, completedAtMs: number, mergedToday: boolean): CompletedMissionReport {
  return {
    missionId,
    generation: 0,
    title: missionId,
    terminalType: 'mission.completed',
    completedAtMs,
    mergedToday,
    durationMs: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    tokensSource: 'unknown',
    cacheReadInputTokens: null,
    artifacts: [],
    chainFires: [],
  };
}

const MISSIONS = [
  mission('m-today', TODAY_10AM, true),
  mission('m-yesterday', YESTERDAY, false),
  mission('m-old', TEN_DAYS_AGO, false),
];

describe('filterMissionsByPeriod', () => {
  it('"all" returns every mission unfiltered', () => {
    expect(filterMissionsByPeriod(MISSIONS, 'all', NOW).map((m) => m.missionId)).toEqual([
      'm-today',
      'm-yesterday',
      'm-old',
    ]);
  });

  it('"today" keeps only missions with mergedToday === true', () => {
    expect(filterMissionsByPeriod(MISSIONS, 'today', NOW).map((m) => m.missionId)).toEqual(['m-today']);
  });

  it('"week" keeps missions within the last 7*24h, excluding the 10-day-old one', () => {
    expect(filterMissionsByPeriod(MISSIONS, 'week', NOW).map((m) => m.missionId)).toEqual([
      'm-today',
      'm-yesterday',
    ]);
  });

  it('returns [] when nothing matches the period', () => {
    expect(filterMissionsByPeriod([], 'today', NOW)).toEqual([]);
    expect(filterMissionsByPeriod([mission('m-old', TEN_DAYS_AGO, false)], 'today', NOW)).toEqual([]);
  });
});
