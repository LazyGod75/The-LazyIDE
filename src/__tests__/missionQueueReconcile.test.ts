/**
 * missionQueueReconcile.test.ts — W-GUARD boot-truth reconcile.
 *
 * Real-world scenario this reproduces: `.lazy/mission-queue.json` held
 * entries (queued <24h ago) whose missions had already moved on to
 * 'review' in `.lazy/missions.json` (their branches already merged) — a
 * truth mismatch nothing ever cleaned up, because no code path removes a
 * queue entry when its mission naturally leaves the queue-relevant
 * lifecycle. Answers the "would boot auto-relaunch these?" question first
 * (dequeue() — the queue's only reader of 'queued' entries — has zero
 * production call sites; see missionQueue.test.ts's own suite, which is
 * the only caller besides this file), then locks in the reconcile fix:
 * reconcileQueueAgainstMissions drops any queue entry whose mission has
 * already left the queue-relevant lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileQueueAgainstMissions, dequeue, type QueueState } from '../lib/agents/missionQueue';
import type { MissionStatus } from '../lib/agents/types';

const createDir = vi.fn().mockResolvedValue(undefined);
const writeFile = vi.fn().mockResolvedValue(undefined);
const readFile = vi.fn().mockRejectedValue(new Error('not found'));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: { createDir, writeFile, readFile },
  })),
}));

function queueState(missions: QueueState['missions']): string {
  return JSON.stringify({ missions, version: '1.0.0' });
}

describe('missionQueue — boot-truth reconcile (W-GUARD)', () => {
  const repoPath = '/repo';

  beforeEach(() => {
    createDir.mockClear().mockResolvedValue(undefined);
    writeFile.mockClear().mockResolvedValue(undefined);
    readFile.mockClear().mockRejectedValue(new Error('not found'));
  });

  it('reproduces the real scenario: queued <24h entries whose missions already reached "review" are dropped, with their real status attached', async () => {
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M39', status: 'queued', enqueuedAt: '2026-07-17T19:19:00.000Z', retryCount: 0, priority: 0 },
        { missionId: 'M41', status: 'queued', enqueuedAt: '2026-07-17T19:30:00.000Z', retryCount: 0, priority: 0 },
        { missionId: 'M42', status: 'queued', enqueuedAt: '2026-07-17T19:40:00.000Z', retryCount: 0, priority: 0 },
        { missionId: 'M43', status: 'queued', enqueuedAt: '2026-07-17T19:47:00.000Z', retryCount: 0, priority: 0 },
      ]),
    );

    const missions: Array<{ id: string; status: MissionStatus }> = [
      { id: 'M39', status: 'review' },
      { id: 'M41', status: 'review' },
      { id: 'M42', status: 'review' },
      { id: 'M43', status: 'review' },
    ];

    const dropped = await reconcileQueueAgainstMissions(repoPath, missions);

    expect(dropped.map((d) => d.missionId).sort()).toEqual(['M39', 'M41', 'M42', 'M43']);
    expect(dropped.every((d) => d.missionStatus === 'review')).toBe(true);

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, writtenContent] = writeFile.mock.calls[0] as [string, string];
    const written = JSON.parse(writtenContent) as QueueState;
    expect(written.missions).toHaveLength(0);
  });

  it('drops entries for done/failed/cancelled missions too (the full non-runnable set)', async () => {
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-done', status: 'queued', enqueuedAt: '2026-07-17T00:00:00.000Z', retryCount: 0, priority: 0 },
        { missionId: 'M-failed', status: 'queued', enqueuedAt: '2026-07-17T00:00:00.000Z', retryCount: 0, priority: 0 },
        { missionId: 'M-cancelled', status: 'queued', enqueuedAt: '2026-07-17T00:00:00.000Z', retryCount: 0, priority: 0 },
      ]),
    );

    const dropped = await reconcileQueueAgainstMissions(repoPath, [
      { id: 'M-done', status: 'done' },
      { id: 'M-failed', status: 'failed' },
      { id: 'M-cancelled', status: 'cancelled' },
    ]);

    expect(dropped.map((d) => d.missionId).sort()).toEqual(['M-cancelled', 'M-done', 'M-failed']);
  });

  it('keeps a queue entry whose mission is still genuinely runnable ("queued" or "running")', async () => {
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-still-queued', status: 'queued', enqueuedAt: '2026-07-17T00:00:00.000Z', retryCount: 0, priority: 0 },
        { missionId: 'M-running', status: 'running', enqueuedAt: '2026-07-17T00:00:00.000Z', retryCount: 0, priority: 0 },
      ]),
    );

    const dropped = await reconcileQueueAgainstMissions(repoPath, [
      { id: 'M-still-queued', status: 'queued' },
      { id: 'M-running', status: 'running' },
    ]);

    expect(dropped).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('keeps a queue entry whose mission id is not in the loaded mission list (not yet known this boot — never guessed non-runnable)', async () => {
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-unknown', status: 'queued', enqueuedAt: '2026-07-17T00:00:00.000Z', retryCount: 0, priority: 0 },
      ]),
    );

    const dropped = await reconcileQueueAgainstMissions(repoPath, []);

    expect(dropped).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('is a no-op write when nothing is dropped (never rewrites the file needlessly)', async () => {
    readFile.mockResolvedValueOnce(
      queueState([{ missionId: 'M1', status: 'queued', enqueuedAt: '2026-07-17T00:00:00.000Z', retryCount: 0, priority: 0 }]),
    );

    await reconcileQueueAgainstMissions(repoPath, [{ id: 'M1', status: 'queued' }]);

    expect(writeFile).not.toHaveBeenCalled();
  });

  // ── Confirms the boot-relaunch question: dequeue() (the only reader of
  // 'queued' entries) has no production call site in this codebase — a
  // stale/orphaned 'queued' entry left behind by the truth bug above is
  // therefore NOT auto-relaunched today. This test locks in that safety
  // property directly: even a fresh (non-stale) 'queued' entry for a
  // mission that has already moved on to 'review' would still be handed
  // back by dequeue() if something ever called it — which is exactly why
  // reconcileQueueAgainstMissions above must run BEFORE any future
  // scheduler wires itself onto dequeue().
  it('defense in depth: without reconcile, dequeue() would still hand back a queued entry whose mission already left the runnable lifecycle', async () => {
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M39', status: 'queued', enqueuedAt: '2026-07-17T19:19:00.000Z', retryCount: 0, priority: 0 },
      ]),
    );

    const next = await dequeue(repoPath);

    // dequeue() alone has no mission-status awareness — this is exactly the
    // gap reconcileQueueAgainstMissions closes by removing the entry first.
    expect(next?.missionId).toBe('M39');
  });
});
