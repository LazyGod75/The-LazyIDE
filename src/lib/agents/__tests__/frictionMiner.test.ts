import { describe, it, expect } from 'vitest';
import { mineFrictionsFromJournal, mineFrictions } from '../frictionMiner';
import type { JournalEventRow, JournalEventType } from '../../journal/eventTypes';

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

describe('mineFrictionsFromJournal', () => {
  it('returns no candidates for an empty journal', () => {
    expect(mineFrictionsFromJournal('p1', [])).toEqual([]);
  });

  it('aggregates recurring mission.failed by reason', () => {
    const events = [
      row({ type: 'mission.failed', mission_id: 'm1', payload: { reason: 'tests broke' } }),
      row({ type: 'mission.failed', mission_id: 'm2', payload: { reason: 'tests broke' } }),
    ];
    const candidates = mineFrictionsFromJournal('p1', events);
    const failure = candidates.find((c) => c.where === 'mission-execution');
    expect(failure).toBeDefined();
    expect(failure?.evidence).toEqual(expect.arrayContaining(['m1', 'm2', 'mission.failed']));
    expect(failure?.severity).toBe('medium');
  });

  it('flags a merged-then-reverted mission as a merge pathology', () => {
    const events = [row({ type: 'mission.reverted', mission_id: 'm3', payload: { merged: true } })];
    const candidates = mineFrictionsFromJournal('p1', events);
    const reverted = candidates.find((c) => c.where === 'merge');
    expect(reverted).toBeDefined();
    expect(reverted?.why).toBe('reverted-after-merge');
    expect(reverted?.evidence).toContain('m3');
  });

  it('ignores a reverted-but-not-merged mission (never a merge pathology)', () => {
    const events = [row({ type: 'mission.reverted', mission_id: 'm4', payload: { merged: false } })];
    const candidates = mineFrictionsFromJournal('p1', events);
    expect(candidates.find((c) => c.where === 'merge')).toBeUndefined();
  });

  it('flags a mission with 2+ interventions as an autonomy pathology', () => {
    const events = [
      row({ type: 'mission.intervened', mission_id: 'm5', payload: { note: 'clarify scope' } }),
      row({ type: 'mission.intervened', mission_id: 'm5', payload: { note: 'clarify again' } }),
    ];
    const candidates = mineFrictionsFromJournal('p1', events);
    const intervened = candidates.find((c) => c.where === 'autonomy');
    expect(intervened).toBeDefined();
    expect(intervened?.evidence).toContain('m5');
  });

  it('never flags a single, isolated intervention', () => {
    const events = [row({ type: 'mission.intervened', mission_id: 'm6', payload: { note: 'one-off' } })];
    expect(mineFrictionsFromJournal('p1', events).find((c) => c.where === 'autonomy')).toBeUndefined();
  });

  it('aggregates gate.failed by reviewer role', () => {
    const events = [
      row({ type: 'gate.failed', mission_id: 'm7', payload: { role: 'tester', reason: 'missing coverage' } }),
      row({ type: 'gate.failed', mission_id: 'm8', payload: { role: 'tester', reason: 'missing coverage' } }),
      row({ type: 'gate.failed', mission_id: 'm9', payload: { role: 'security', reason: 'hardcoded secret' } }),
    ];
    const candidates = mineFrictionsFromJournal('p1', events);
    const tester = candidates.find((c) => c.where === 'gate:tester');
    const security = candidates.find((c) => c.where === 'gate:security');
    expect(tester?.evidence).toEqual(expect.arrayContaining(['m7', 'm8']));
    expect(security?.evidence).toContain('m9');
  });

  it('aggregates budget and duration cap warnings into one sizing candidate', () => {
    const events = [
      row({ type: 'budget.warning', payload: { pct: 90, capUsd: 5 } }),
      row({ type: 'duration.exceeded', payload: { capMs: 60_000, elapsedMs: 65_000 } }),
    ];
    const candidates = mineFrictionsFromJournal('p1', events);
    expect(candidates.find((c) => c.where === 'sizing')).toBeDefined();
  });

  it('ranks candidates by severity, highest first', () => {
    const events = [
      row({ type: 'mission.failed', mission_id: 'a', payload: { reason: 'r1' } }),
      row({ type: 'mission.failed', mission_id: 'b', payload: { reason: 'r2' } }),
      row({ type: 'mission.failed', mission_id: 'c', payload: { reason: 'r2' } }),
      row({ type: 'mission.failed', mission_id: 'd', payload: { reason: 'r2' } }),
      row({ type: 'mission.failed', mission_id: 'e', payload: { reason: 'r2' } }),
      row({ type: 'mission.failed', mission_id: 'f', payload: { reason: 'r2' } }),
    ];
    const candidates = mineFrictionsFromJournal('p1', events);
    const severities = candidates.map((c) => c.severity);
    // r2 (5 occurrences -> high) must be ranked before r1 (1 occurrence -> low).
    expect(severities[0]).toBe('high');
    expect(severities).toContain('low');
    expect(severities.indexOf('high')).toBeLessThan(severities.lastIndexOf('low'));
  });

  it('tolerates an unparsable payload without throwing', () => {
    const malformed: JournalEventRow = {
      seq: 1,
      ts_ms: Date.now(),
      project_id: 'p1',
      mission_id: 'm-bad',
      agent_id: null,
      run_id: null,
      actor: 'system',
      type: 'mission.failed',
      payload: '{not json',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
    expect(() => mineFrictionsFromJournal('p1', [malformed])).not.toThrow();
  });
});

describe('mineFrictions (orchestration)', () => {
  it('combines diagnosis-engine suggestions (empty for an unregistered project) with journal-vocabulary mining', async () => {
    const events = [
      row({ type: 'gate.failed', mission_id: 'm1', payload: { role: 'reviewer', reason: 'style' } }),
      row({ type: 'gate.failed', mission_id: 'm2', payload: { role: 'reviewer', reason: 'style' } }),
    ];
    // 'unknown-project' is never registered in globalRuntime, so
    // runImprovementLoop's own contract (orchestrator.test.ts) returns [] —
    // the merged result here must be journal-only, never throw or fabricate
    // a diagnosis-based candidate for a project the runtime has never seen.
    const candidates = await mineFrictions('unknown-project', undefined, undefined, events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].where).toBe('gate:reviewer');
  });

  it('returns [] when there is nothing to mine', async () => {
    const candidates = await mineFrictions('unknown-project', undefined, undefined, []);
    expect(candidates).toEqual([]);
  });
});
