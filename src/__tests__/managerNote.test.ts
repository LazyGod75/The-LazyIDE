import { describe, it, expect } from 'vitest';
import { extractLatestScopeConflict } from '../lib/agents/managerNote';
import type { JournalEventRow } from '../lib/journal/eventTypes';

function row(overrides: Partial<JournalEventRow> = {}): JournalEventRow {
  return {
    seq: 1,
    ts_ms: Date.now(),
    project_id: 'p1',
    mission_id: 'm-queued',
    agent_id: null,
    run_id: null,
    actor: 'system',
    type: 'scheduler.queued',
    payload: JSON.stringify({ reason: 'scope_conflict', pool: 'claude-cli', depth: 2, conflictsWith: ['m-running'] }),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

const titles: Record<string, string> = { 'm-queued': 'blog-cms', 'm-running': 'refonte-pricing' };
const titleFor = (id: string) => titles[id] ?? null;

describe('extractLatestScopeConflict', () => {
  it('returns null when there are no rows', () => {
    expect(extractLatestScopeConflict([], titleFor)).toBeNull();
  });

  it('extracts a scope_conflict event into queued/conflict titles', () => {
    const result = extractLatestScopeConflict([row()], titleFor);
    expect(result).toEqual({
      queuedMissionId: 'm-queued',
      queuedTitle: 'blog-cms',
      conflictMissionId: 'm-running',
      conflictTitle: 'refonte-pricing',
      tsMs: expect.any(Number),
    });
  });

  it('ignores pool_full events (not a scope conflict)', () => {
    const poolFull = row({ payload: JSON.stringify({ reason: 'pool_full', pool: 'claude-cli', depth: 1 }) });
    expect(extractLatestScopeConflict([poolFull], titleFor)).toBeNull();
  });

  it('skips a conflict whose mission titles are unresolvable and falls back to an older resolvable one', () => {
    const unresolvable = row({ seq: 2, ts_ms: 2000, mission_id: 'm-unknown' });
    const resolvable = row({ seq: 1, ts_ms: 1000 });
    const result = extractLatestScopeConflict([unresolvable, resolvable], titleFor);
    expect(result?.queuedMissionId).toBe('m-queued');
  });

  it('picks the most recent conflict when several exist', () => {
    const older = row({ seq: 1, ts_ms: 1000 });
    const newer = row({ seq: 2, ts_ms: 5000, mission_id: 'm-queued' });
    const result = extractLatestScopeConflict([older, newer], titleFor);
    expect(result?.tsMs).toBe(5000);
  });

  it('returns null for malformed payload JSON', () => {
    const bad = row({ payload: 'not json' });
    expect(extractLatestScopeConflict([bad], titleFor)).toBeNull();
  });
});
