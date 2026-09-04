import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isOpsOrphan,
  opsOrphanFingerprint,
  pollBrainOpsOrphan,
  resetOpsOrphanDedupe,
} from '../lib/brain/opsOrphanWatch';
import type { BrainOpsStatus } from '../lib/brain/opsStatus';

vi.mock('../lib/bus', () => ({ emit: vi.fn() }));
vi.mock('../lib/journal/journal', () => ({ emitEvent: vi.fn() }));

function status(partial: Partial<BrainOpsStatus>): BrainOpsStatus {
  return {
    updatedAt: '2026-09-03T00:00:00Z',
    phase: 'idle',
    step: null,
    pid: null,
    timeoutSecs: null,
    detail: null,
    brainPath: null,
    ...partial,
  };
}

describe('isOpsOrphan', () => {
  it('flags timed_out immediately', () => {
    expect(isOpsOrphan(status({ phase: 'timed_out', step: 'dream' }))).toBe(true);
  });

  it('flags running past 1.25× timeout budget', () => {
    const updatedAt = '2026-09-03T00:00:00Z';
    const updatedMs = Date.parse(updatedAt);
    expect(
      isOpsOrphan(
        status({ phase: 'running', step: 'dream', updatedAt, timeoutSecs: 60 }),
        updatedMs + 60 * 1250 + 1,
      ),
    ).toBe(true);
  });

  it('does not flag a fresh running ops', () => {
    const updatedAt = '2026-09-03T00:00:00Z';
    const updatedMs = Date.parse(updatedAt);
    expect(
      isOpsOrphan(
        status({ phase: 'running', step: 'dream', updatedAt, timeoutSecs: 600 }),
        updatedMs + 10_000,
      ),
    ).toBe(false);
  });
});

describe('pollBrainOpsOrphan', () => {
  beforeEach(() => {
    resetOpsOrphanDedupe();
  });

  it('emits once per fingerprint then dedupes', async () => {
    const orphan = status({
      phase: 'timed_out',
      step: 'dream',
      pid: 42,
      detail: 'dream killed after 600s',
      updatedAt: '2026-09-03T01:00:00Z',
    });
    const readStatus = vi.fn().mockResolvedValue(orphan);
    const first = await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    const second = await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    expect(first).toEqual(orphan);
    expect(second).toEqual(orphan);
    expect(opsOrphanFingerprint(orphan)).toContain('timed_out|dream|42');
    expect(readStatus).toHaveBeenCalledTimes(2);
  });
});
