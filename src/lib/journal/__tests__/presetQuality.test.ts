import { describe, it, expect } from 'vitest';
import { queryPresetQuality } from '../presetQuality';
import type { JournalEventRow, JournalEventType } from '../eventTypes';
import type { Mission } from '../../agents/types';

function row(overrides: Omit<Partial<JournalEventRow>, 'payload'> & { type: JournalEventType; payload: unknown }): JournalEventRow {
  return {
    seq: overrides.seq ?? 0,
    ts_ms: overrides.ts_ms ?? Date.now(),
    project_id: overrides.project_id ?? 'p1',
    mission_id: overrides.mission_id ?? null,
    agent_id: overrides.agent_id ?? null,
    run_id: overrides.run_id ?? null,
    actor: overrides.actor ?? 'system',
    type: overrides.type,
    payload: JSON.stringify(overrides.payload),
    tokens_in: overrides.tokens_in ?? 0,
    tokens_out: overrides.tokens_out ?? 0,
    cost_usd: overrides.cost_usd ?? 0,
  };
}

function mission(id: string, agentName: string): Mission {
  return { id, title: id, status: 'done', model: 'claude-sonnet', agentName };
}

describe('queryPresetQuality', () => {
  it('returns zero runs and an undefined score for a preset with no history', () => {
    const result = queryPresetQuality('tester-agent', [], []);
    expect(result).toEqual({ agentName: 'tester-agent', runs: 0, avgJudgeScore: undefined, revertedCount: 0 });
  });

  it('counts completed + failed runs scoped to the agent\'s own missions only', () => {
    const missions = [mission('m1', 'tester-agent'), mission('m2', 'other-agent')];
    const events = [
      row({ type: 'mission.completed', mission_id: 'm1', payload: { durationMs: 1000 } }),
      row({ type: 'mission.failed', mission_id: 'm1', payload: { reason: 'x' } }),
      row({ type: 'mission.completed', mission_id: 'm2', payload: { durationMs: 500 } }),
    ];
    const result = queryPresetQuality('tester-agent', missions, events);
    expect(result.runs).toBe(2);
  });

  it('averages real gate.passed scores and never fabricates one when absent', () => {
    const missions = [mission('m1', 'tester-agent')];
    const withScore = queryPresetQuality('tester-agent', missions, [
      row({ type: 'gate.passed', mission_id: 'm1', payload: { role: 'judge', score: 80 } }),
      row({ type: 'gate.passed', mission_id: 'm1', payload: { role: 'tester', score: 90 } }),
    ]);
    expect(withScore.avgJudgeScore).toBe(85);

    const withoutScore = queryPresetQuality('tester-agent', missions, [
      row({ type: 'gate.passed', mission_id: 'm1', payload: { role: 'judge' } }),
    ]);
    expect(withoutScore.avgJudgeScore).toBeUndefined();
  });

  it('counts a reverted-after-merge mission but not a dropped unmerged worktree', () => {
    const missions = [mission('m1', 'tester-agent'), mission('m2', 'tester-agent')];
    const result = queryPresetQuality('tester-agent', missions, [
      row({ type: 'mission.reverted', mission_id: 'm1', payload: { merged: true } }),
      row({ type: 'mission.reverted', mission_id: 'm2', payload: { merged: false } }),
    ]);
    expect(result.revertedCount).toBe(1);
  });

  it('ignores events for missions belonging to a different agent', () => {
    const missions = [mission('m1', 'other-agent')];
    const result = queryPresetQuality('tester-agent', missions, [
      row({ type: 'mission.completed', mission_id: 'm1', payload: {} }),
      row({ type: 'gate.passed', mission_id: 'm1', payload: { role: 'judge', score: 99 } }),
    ]);
    expect(result.runs).toBe(0);
    expect(result.avgJudgeScore).toBeUndefined();
  });
});
