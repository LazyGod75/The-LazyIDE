import { describe, it, expect, vi, beforeEach } from 'vitest';
import { on } from '../lib/bus';
import { notifySchedulerQueued, notifySchedulerStale } from '../lib/agents/schedulerNotify';

describe('schedulerNotify', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('wakes listeners with the scope_conflict reason', () => {
    const received: Array<{ reason: string; conflictsWith?: string[] }> = [];
    const off = on('scheduler:queued', (p) => received.push(p));
    notifySchedulerQueued({
      missionId: 'M9',
      projectId: 'proj',
      reason: 'scope_conflict',
      pool: 'claude-cli',
      depth: 2,
      conflictsWith: ['M1'],
    });
    off();
    expect(received).toEqual([
      {
        missionId: 'M9',
        projectId: 'proj',
        reason: 'scope_conflict',
        pool: 'claude-cli',
        depth: 2,
        conflictsWith: ['M1'],
      },
    ]);
  });

  it('emits scheduler:stale for a queue entry past policy', () => {
    const received: Array<{ missionId: string; waitedMs: number }> = [];
    const off = on('scheduler:stale', (p) => received.push(p));
    notifySchedulerStale({ missionId: 'M2', waitedMs: 86_400_000 });
    off();
    expect(received[0]).toEqual({ missionId: 'M2', waitedMs: 86_400_000 });
  });
});
