/**
 * missionQueue.test.ts
 *
 * Regression coverage for the real-app QA bug: missionQueue.ts's
 * readQueue/writeQueue built the '.lazy/mission-queue.json' path via string
 * concatenation (`${repoPath}/${QUEUE_FILE}`, `${repoPath}/.lazy`) instead of
 * the shared joinPath() helper. A Windows '\\?\'-prefixed repoPath
 * (get_project_root's canonicalize() result) then produced a mixed-separator
 * path the Rust fs commands (fs_create_dir/write_file/read_file) rejected as
 * "outside project root" even though '.lazy' exists on disk — the real
 * console error was:
 *   "[missionQueue] Failed to persist queue: access denied: path
 *    '\\?\C:\...\qa-project/.lazy' is outside project root
 *    '\\?\C:\...\qa-project'"
 *
 * See src-tauri/src/commands/fs.rs (ensure_write_path_in_project_root) and
 * src/lib/paths.ts's header comment for the full bug-class history. Mirrors
 * src/__tests__/tauriMissionsPath.test.ts's style.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enqueue,
  listQueue,
  dequeue,
  markStaleQueuedMissions,
  purgeAncientStaleQueuedMissions,
  STALE_QUEUE_THRESHOLD_MS,
  STALE_QUEUE_PURGE_MS,
  type QueueState,
} from '../lib/agents/missionQueue';

const createDir = vi.fn().mockResolvedValue(undefined);
const writeFile = vi.fn().mockResolvedValue(undefined);
const readFile = vi.fn().mockRejectedValue(new Error('not found'));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: { createDir, writeFile, readFile },
  })),
}));

describe('missionQueue — verbatim-safe path join', () => {
  beforeEach(() => {
    createDir.mockClear().mockResolvedValue(undefined);
    writeFile.mockClear().mockResolvedValue(undefined);
    readFile.mockClear().mockRejectedValue(new Error('not found'));
  });

  it('enqueue() persists via a verbatim-safe joined path using backslash throughout, never a literal "/"', async () => {
    const repoPath = String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project`;
    await enqueue(repoPath, 'M1');

    expect(createDir).toHaveBeenCalledWith(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy`,
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = writeFile.mock.calls[0] as [string, string];
    expect(writtenPath).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy\mission-queue.json`,
    );
    expect(writtenPath).not.toContain('/');
    expect(JSON.parse(writtenContent).missions[0].missionId).toBe('M1');
  });

  it('listQueue() reads via the same verbatim-safe joined path', async () => {
    const repoPath = String.raw`\\?\C:\repo`;
    readFile.mockResolvedValueOnce(JSON.stringify({ missions: [], version: '1.0.0' }));

    await listQueue(repoPath);

    expect(readFile).toHaveBeenCalledWith(String.raw`\\?\C:\repo\.lazy\mission-queue.json`);
  });

  it('still works with a POSIX repoPath (no behavior change)', async () => {
    await enqueue('/repo', 'M2');

    expect(createDir).toHaveBeenCalledWith('/repo/.lazy');
    expect(writeFile).toHaveBeenCalledWith('/repo/.lazy/mission-queue.json', expect.any(String));
  });

  it('a persistence failure is caught and warned, never thrown (best-effort)', async () => {
    createDir.mockRejectedValueOnce(new Error('access denied: outside project root'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(enqueue('/repo', 'M3')).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith('[missionQueue] Failed to persist queue:', expect.any(Error));
    warnSpy.mockRestore();
  });
});

// ── R4b fix: "ghost queue runs" (real-money incident) ────────────────────
// Stale queued entries (July 4 vintage: M10 resurrected + billed on boot;
// M11/M12/M15/M18/M21 still pending in the real LazySite-internet queue
// file) must never auto-run again. markStaleQueuedMissions flags any
// 'queued' entry older than STALE_QUEUE_THRESHOLD_MS (24h) that never
// started, and dequeue() — the queue's own "give me the next runnable
// mission" API — excludes stale entries from auto-pickup. Status is left
// untouched (still 'queued', nothing force-failed/deleted): this only gates
// automatic pickup, never destroys history.
describe('missionQueue — stale-queue gate (ghost queue runs fix)', () => {
  const repoPath = '/repo';

  function queueState(missions: QueueState['missions']): string {
    return JSON.stringify({ missions, version: '1.0.0' });
  }

  beforeEach(() => {
    createDir.mockClear().mockResolvedValue(undefined);
    writeFile.mockClear().mockResolvedValue(undefined);
    readFile.mockClear().mockRejectedValue(new Error('not found'));
  });

  it('marks a 24h+ old queued entry (no startedAt) as stale, and persists the change', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z');
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M10', status: 'queued', enqueuedAt: '2026-07-04T19:29:33.135Z', retryCount: 0, priority: 0 },
      ]),
    );

    const newlyStale = await markStaleQueuedMissions(repoPath, now);

    expect(newlyStale.map((m) => m.missionId)).toEqual(['M10']);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, writtenContent] = writeFile.mock.calls[0] as [string, string];
    const written = JSON.parse(writtenContent) as QueueState;
    expect(written.missions[0].stale).toBe(true);
    expect(written.missions[0].status).toBe('queued'); // status untouched — never force-failed
  });

  it('does NOT mark a fresh queued entry (under the 24h threshold) as stale', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z');
    const recentEnqueue = new Date(now - (STALE_QUEUE_THRESHOLD_MS - 60_000)).toISOString();
    readFile.mockResolvedValueOnce(
      queueState([{ missionId: 'M50', status: 'queued', enqueuedAt: recentEnqueue, retryCount: 0, priority: 0 }]),
    );

    const newlyStale = await markStaleQueuedMissions(repoPath, now);

    expect(newlyStale).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does NOT mark an entry that already started (startedAt present) even if old', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z');
    readFile.mockResolvedValueOnce(
      queueState([
        {
          missionId: 'M9',
          status: 'queued',
          enqueuedAt: '2026-07-04T19:24:49.702Z',
          startedAt: '2026-07-15T20:12:11.274Z',
          retryCount: 0,
          priority: 0,
        },
      ]),
    );

    const newlyStale = await markStaleQueuedMissions(repoPath, now);

    expect(newlyStale).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('is idempotent — an already-stale entry is left alone on a second call (no repeated writes)', async () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z');
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M11', status: 'queued', enqueuedAt: '2026-07-04T20:21:46.109Z', retryCount: 0, priority: 0, stale: true },
      ]),
    );

    const newlyStale = await markStaleQueuedMissions(repoPath, now);

    expect(newlyStale).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('dequeue() never returns a stale entry, even when it is the only one queued', async () => {
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M10', status: 'queued', enqueuedAt: '2026-07-04T19:29:33.135Z', retryCount: 0, priority: 0, stale: true },
      ]),
    );

    const next = await dequeue(repoPath);

    expect(next).toBeNull();
  });

  it('dequeue() still returns a fresh (non-stale) queued entry ahead of a stale one', async () => {
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-old', status: 'queued', enqueuedAt: '2026-07-04T19:29:33.135Z', retryCount: 0, priority: 0, stale: true },
        { missionId: 'M-fresh', status: 'queued', enqueuedAt: '2026-07-16T00:00:00.000Z', retryCount: 0, priority: 0 },
      ]),
    );

    const next = await dequeue(repoPath);

    expect(next?.missionId).toBe('M-fresh');
  });
});

// ── Self-heal fix (2026-08-02): purge ancient stale entries ──────────────
// Real-world residue observed: mission-queue.json still held entries from
// over two weeks earlier, flagged `stale: true` and never removed — nothing
// in this file ever deleted a stale entry once flagged (markStaleQueuedMissions
// is deliberately non-destructive, see its own doc comment). purgeAncientStaleQueuedMissions
// closes that leak by dropping entries that have been stale for a full extra
// week (STALE_QUEUE_PURGE_MS past the original 24h bar) — this is safe
// specifically BECAUSE dequeue() (the only reader of `stale` at all) has
// zero production call sites, so a stale entry blocks nothing; this only
// removes dead-weight bookkeeping, never real mission history.
describe('missionQueue — self-heal purge of ancient stale entries', () => {
  const repoPath = '/repo';

  function queueState(missions: QueueState['missions']): string {
    return JSON.stringify({ missions, version: '1.0.0' });
  }

  beforeEach(() => {
    createDir.mockClear().mockResolvedValue(undefined);
    writeFile.mockClear().mockResolvedValue(undefined);
    readFile.mockClear().mockRejectedValue(new Error('not found'));
  });

  it('removes a stale entry once it has been stale for a full extra week, and persists the change', async () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const ancientEnqueue = new Date(now - (STALE_QUEUE_PURGE_MS + 60_000)).toISOString();
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-ancient', status: 'queued', enqueuedAt: ancientEnqueue, retryCount: 0, priority: 0, stale: true },
      ]),
    );

    const purged = await purgeAncientStaleQueuedMissions(repoPath, now);

    expect(purged.map((m) => m.missionId)).toEqual(['M-ancient']);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, writtenContent] = writeFile.mock.calls[0] as [string, string];
    const written = JSON.parse(writtenContent) as QueueState;
    expect(written.missions).toEqual([]);
  });

  it('does NOT remove a stale entry that has not yet crossed the purge threshold', async () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const recentStale = new Date(now - (STALE_QUEUE_THRESHOLD_MS + 60_000)).toISOString();
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-recent-stale', status: 'queued', enqueuedAt: recentStale, retryCount: 0, priority: 0, stale: true },
      ]),
    );

    const purged = await purgeAncientStaleQueuedMissions(repoPath, now);

    expect(purged).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('never removes a non-stale entry, no matter how old', async () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const ancientButNeverFlaggedStale = new Date(now - (STALE_QUEUE_PURGE_MS * 2)).toISOString();
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-old-not-stale', status: 'running', enqueuedAt: ancientButNeverFlaggedStale, retryCount: 0, priority: 0 },
      ]),
    );

    const purged = await purgeAncientStaleQueuedMissions(repoPath, now);

    expect(purged).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('keeps a fresh entry and drops only the ancient stale one when both are present', async () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const ancientEnqueue = new Date(now - (STALE_QUEUE_PURGE_MS + 60_000)).toISOString();
    readFile.mockResolvedValueOnce(
      queueState([
        { missionId: 'M-ancient', status: 'queued', enqueuedAt: ancientEnqueue, retryCount: 0, priority: 0, stale: true },
        { missionId: 'M-fresh', status: 'queued', enqueuedAt: new Date(now).toISOString(), retryCount: 0, priority: 0 },
      ]),
    );

    const purged = await purgeAncientStaleQueuedMissions(repoPath, now);

    expect(purged.map((m) => m.missionId)).toEqual(['M-ancient']);
    const [, writtenContent] = writeFile.mock.calls[0] as [string, string];
    const written = JSON.parse(writtenContent) as QueueState;
    expect(written.missions.map((m) => m.missionId)).toEqual(['M-fresh']);
  });
});
