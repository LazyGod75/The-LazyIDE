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
    // 2026-09-11: fingerprint identifies the orphan CONDITION (phase+step),
    // not the snapshot — a freshly-timed-out dream with a new pid/updatedAt
    // is the same recurring condition, not a new signal.
    expect(opsOrphanFingerprint(orphan)).toBe('timed_out|dream');
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-emit for a new orphan cycle of the same step (the recurring dream/kill spam fix)', async () => {
    const { emitEvent } = await import('../lib/journal/journal');
    const orphan1 = status({ phase: 'timed_out', step: 'dream', pid: 42, updatedAt: '2026-09-03T01:00:00Z' });
    // Next consolidation cycle: a NEW dream run timed out again — new pid,
    // new updatedAt, same condition.
    const orphan2 = status({ phase: 'timed_out', step: 'dream', pid: 99, updatedAt: '2026-09-03T02:00:00Z' });
    const readStatus = vi.fn()
      .mockResolvedValueOnce(orphan1)
      .mockResolvedValueOnce(orphan2);
    await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    expect(vi.mocked(emitEvent)).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-arm on a null read — a flaky status read must not re-emit the same orphan', async () => {
    // Real incident 2026-09-11: the same "dream killed after 600s" (pid 24920)
    // was journaled 5× in 17 minutes — every transient read failure
    // (missing/partial ops-status.json mid-rewrite) reset the dedupe.
    const { emitEvent } = await import('../lib/journal/journal');
    const orphan = status({ phase: 'timed_out', step: 'dream', pid: 24920 });
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(orphan)
      .mockResolvedValueOnce(null) // transient read failure — NOT a recovery
      .mockResolvedValueOnce(orphan)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(orphan);
    for (let i = 0; i < 5; i++) {
      await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    }
    expect(vi.mocked(emitEvent)).toHaveBeenCalledTimes(1);
  });

  it('re-arms the dedupe after a healthy status read (a recovered-then-orphaned dream IS a new signal)', async () => {
    const { emitEvent } = await import('../lib/journal/journal');
    const orphan = status({ phase: 'timed_out', step: 'dream', pid: 42 });
    const healthy = status({ phase: 'idle' });
    const orphanAgain = status({ phase: 'timed_out', step: 'dream', pid: 77 });
    const readStatus = vi.fn()
      .mockResolvedValueOnce(orphan)
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce(orphanAgain);
    await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    await pollBrainOpsOrphan({ projectId: 'proj', readStatus });
    expect(vi.mocked(emitEvent)).toHaveBeenCalledTimes(2);
  });
});
