/**
 * migrate.test.ts — T0.5 coverage for the one-shot legacy migration
 * (src/lib/journal/migrate.ts) that replays a project's `.lazy/missions.json`
 * (+ `.lazy/mission-queue.json`) snapshot into the event journal as
 * synthetic mission.created/mission.updated events.
 *
 * getPlatform() is mocked so `fs` (marker + mission-queue.json reads,
 * marker write) and `missions.load` (missions.json read) are fully
 * controlled per test. `invoke` is the same globally-mocked
 * '@tauri-apps/api/core' every other journal test uses (see journal.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { migrateProjectToJournal } from '../lib/journal/migrate';
import type { Mission } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);

const { mockReadFile, mockWriteFile, mockCreateDir, mockMissionsLoad } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockCreateDir: vi.fn(),
  mockMissionsLoad: vi.fn(),
}));

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => {
      const real = actual.getPlatform();
      return {
        ...real,
        fs: { ...real.fs, readFile: mockReadFile, writeFile: mockWriteFile, createDir: mockCreateDir },
        missions: { ...real.missions, load: mockMissionsLoad, save: vi.fn().mockResolvedValue(undefined) },
      };
    },
  };
});

const ROOT = 'C:\\proj';

function missionFixture(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Do the thing',
    status: 'done',
    model: 'Sonnet 4.6',
    ...overrides,
  };
}

/** Every mock rejects "file not found" by default — tests override
 *  individual paths (marker / mission-queue.json) as needed. */
function rejectAllReads(): void {
  mockReadFile.mockRejectedValue(new Error('ENOENT'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockCreateDir.mockResolvedValue(undefined);
  mockMissionsLoad.mockResolvedValue(null);
  rejectAllReads();
});

/** Extracts the `journal_emit_batch` invoke call's `events` argument. */
function emittedEvents(): Array<Record<string, unknown>> {
  const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'journal_emit_batch');
  if (!call) return [];
  return (call[1] as { events: Array<Record<string, unknown>> }).events;
}

describe('migrateProjectToJournal', () => {
  it('returns {skipped:true} and touches neither missions.json nor the journal when the marker already exists', async () => {
    mockReadFile.mockImplementation((path: string) =>
      path.includes('journal-migrated')
        ? Promise.resolve('2026-01-01T00:00:00.000Z')
        : Promise.reject(new Error('ENOENT')),
    );

    const result = await migrateProjectToJournal(ROOT);

    expect(result).toEqual({ skipped: true });
    expect(mockMissionsLoad).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('writes the marker and returns {imported:0} when missions.json has nothing to migrate', async () => {
    mockMissionsLoad.mockResolvedValue(null);

    const result = await migrateProjectToJournal(ROOT);

    expect(result).toEqual({ imported: 0 });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('journal-migrated'),
      expect.any(String),
    );
  });

  it('emits mission.created + mission.updated per mission with payload.imported and the best-known original timestamp, then writes the marker', async () => {
    const withCreatedAt = missionFixture({ id: 'M1', title: 'Has createdAt', createdAt: 1_000_000 });
    const withoutCreatedAt = missionFixture({ id: 'M2', title: 'Legacy, no createdAt' });
    mockMissionsLoad.mockResolvedValue([withCreatedAt, withoutCreatedAt]);
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes('journal-migrated')) return Promise.reject(new Error('ENOENT'));
      if (path.includes('mission-queue.json')) {
        return Promise.resolve(
          JSON.stringify({
            version: '1.0.0',
            missions: [
              {
                missionId: 'M2',
                status: 'completed',
                enqueuedAt: '2020-01-01T00:00:00.000Z',
                retryCount: 0,
                priority: 0,
              },
            ],
          }),
        );
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await migrateProjectToJournal(ROOT);

    expect(result).toEqual({ imported: 2 });

    const events = emittedEvents();
    expect(events).toHaveLength(4);

    const m1Created = events.find((e) => e.mission_id === 'M1' && e.type === 'mission.created')!;
    const m1Updated = events.find((e) => e.mission_id === 'M1' && e.type === 'mission.updated')!;
    const m2Created = events.find((e) => e.mission_id === 'M2' && e.type === 'mission.created')!;
    const m2Updated = events.find((e) => e.mission_id === 'M2' && e.type === 'mission.updated')!;
    expect(m1Created).toBeDefined();
    expect(m1Updated).toBeDefined();
    expect(m2Created).toBeDefined();
    expect(m2Updated).toBeDefined();

    // M1 carries its own createdAt (epoch ms) verbatim.
    expect(m1Created.ts_ms).toBe(1_000_000);
    expect(m1Updated.ts_ms).toBe(1_000_000);

    // M2 has no createdAt — falls back to mission-queue.json's enqueuedAt.
    const expectedM2Ts = Date.parse('2020-01-01T00:00:00.000Z');
    expect(m2Created.ts_ms).toBe(expectedM2Ts);

    // Every event is 'system'-authored (a replay, not a live user action).
    expect(events.every((e) => e.actor === 'system')).toBe(true);

    const m1CreatedPayload = JSON.parse(m1Created.payload as string);
    expect(m1CreatedPayload.imported).toBe(true);
    expect(m1CreatedPayload.mission).toEqual(withCreatedAt);
    expect(m1CreatedPayload.title).toBe('Has createdAt');

    const m1UpdatedPayload = JSON.parse(m1Updated.payload as string);
    expect(m1UpdatedPayload.mission).toEqual(withCreatedAt);
    expect(m1UpdatedPayload.imported).toBeUndefined();

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('journal-migrated'),
      expect.any(String),
    );
  });

  it('is idempotent: a second call after a successful migration skips without emitting again', async () => {
    mockMissionsLoad.mockResolvedValue([missionFixture()]);

    const first = await migrateProjectToJournal(ROOT);
    expect(first).toEqual({ imported: 1 });
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    // Simulate the marker file this call just wrote now being present.
    mockReadFile.mockReset();
    mockReadFile.mockResolvedValue('2026-01-01T00:00:00.000Z');

    const second = await migrateProjectToJournal(ROOT);
    expect(second).toEqual({ skipped: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1); // no additional emit
  });

  it('propagates a journal_emit_batch failure and does NOT write the marker, so the next boot retries', async () => {
    mockMissionsLoad.mockResolvedValue([missionFixture()]);
    mockInvoke.mockRejectedValueOnce(new Error('sqlite is locked'));

    await expect(migrateProjectToJournal(ROOT)).rejects.toThrow('sqlite is locked');

    expect(mockWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('journal-migrated'),
      expect.any(String),
    );
  });
});
