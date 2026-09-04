/* projectReportCostEquivalent.test.ts — src/lib/journal/projectReport.ts's
   CompletedMissionReport.costIsApiEquivalent derivation (cost-honesty wave):
   native claude-code/codex CLI missions (bare model id, no '/') report an
   API-list-price EQUIVALENT never billed by Lazy; managed/OpenRouter
   missions (model id with '/') report a real ai-proxy-billed cost. Synthetic
   JournalEventRow fixtures only (no I/O). */

import { describe, it, expect } from 'vitest';
import { buildProjectReport } from '../lib/journal/projectReport';
import type { JournalEventRow, JournalEventType } from '../lib/journal/eventTypes';

let seqCounter = 0;

function row(
  type: JournalEventType,
  tsMs: number,
  payload: Record<string, unknown> = {},
  overrides: Partial<JournalEventRow> = {},
): JournalEventRow {
  seqCounter += 1;
  return {
    seq: seqCounter,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: 'm-1',
    agent_id: null,
    run_id: null,
    actor: 'system',
    type,
    payload: JSON.stringify(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

describe('buildProjectReport — costIsApiEquivalent (cost-honesty wave)', () => {
  it('is true for a native mission (bare model id, no "/") — cost is a CLI-reported API-equivalent, never billed', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Native run' }, { mission_id: 'm-native' }),
      row('mission.started', 1_500, { model: 'claude-sonnet-5' }, { mission_id: 'm-native' }),
      row(
        'spend.tokens',
        2_000,
        { tokensIn: 100, tokensOut: 40, costUsd: 0.5, source: 'real' },
        { mission_id: 'm-native', tokens_in: 100, tokens_out: 40, cost_usd: 0.5 },
      ),
      row('mission.completed', 3_000, {}, { mission_id: 'm-native' }),
    ];
    const report = buildProjectReport(events, 10_000);
    expect(report.completedMissions).toHaveLength(1);
    expect(report.completedMissions[0].costIsApiEquivalent).toBe(true);
  });

  it('is false for a managed/OpenRouter mission (model id carries "/") — cost is real ai-proxy billing', () => {
    const events = [
      row('mission.created', 1_000, { title: 'Managed run' }, { mission_id: 'm-managed' }),
      row('mission.started', 1_500, { model: 'anthropic/claude-sonnet-5' }, { mission_id: 'm-managed' }),
      row(
        'spend.tokens',
        2_000,
        { tokensIn: 100, tokensOut: 40, costUsd: 0.5, source: 'settled' },
        { mission_id: 'm-managed', tokens_in: 100, tokens_out: 40, cost_usd: 0.5 },
      ),
      row('mission.completed', 3_000, {}, { mission_id: 'm-managed' }),
    ];
    const report = buildProjectReport(events, 10_000);
    expect(report.completedMissions).toHaveLength(1);
    expect(report.completedMissions[0].costIsApiEquivalent).toBe(false);
  });

  it('is undefined (honest absence) when the mission never emitted a mission.started event', () => {
    const events = [
      row('mission.created', 1_000, { title: 'No started event' }, { mission_id: 'm-nostart' }),
      row('mission.completed', 3_000, {}, { mission_id: 'm-nostart' }),
    ];
    const report = buildProjectReport(events, 10_000);
    expect(report.completedMissions).toHaveLength(1);
    expect(report.completedMissions[0].costIsApiEquivalent).toBeUndefined();
  });
});
