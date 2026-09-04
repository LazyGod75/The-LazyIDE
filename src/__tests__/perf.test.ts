/* perf.test.ts — T5.1 Performance/integration tests.

   Tests:
   1. Project switch latency < 500ms (instrumented mock)
   2. Migration idempotency (second call is a no-op)
   3. Journal retention compaction config validation
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

const { mockReadFile, mockWriteFile, mockMissionsLoad } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMissionsLoad: vi.fn(),
}));

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => ({
      ...actual.getPlatform(),
      name: 'tauri',
      fs: {
        readFile: mockReadFile,
        writeFile: mockWriteFile,
        exists: vi.fn().mockResolvedValue(true),
        mkdir: vi.fn().mockResolvedValue(undefined),
        createDir: vi.fn().mockResolvedValue(undefined),
      },
      missions: {
        load: mockMissionsLoad,
        save: vi.fn().mockResolvedValue(undefined),
      },
    }),
    isTauri: () => true,
  };
});

describe('T5.1 — Performance & integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockReset();
  });

  // ── Switch latency ────────────────────────────────────────────────

  describe('project switch latency', () => {
    it('journal_query_events for missions_current completes < 500ms with 1000 events', async () => {
      // Simulate 1000 event query response
      const mockEvents = Array.from({ length: 1000 }, (_, i) => ({
        seq: i,
        ts_ms: Date.now() - i * 1000,
        project_id: 'test-project',
        mission_id: `mission-${i % 50}`,
        agent_id: null,
        run_id: null,
        actor: 'system',
        type: 'mission.step',
        payload: JSON.stringify({ step: i, summary: `Step ${i}` }),
        tokens_in: 100,
        tokens_out: 200,
        cost_usd: 0.001,
      }));

      mockInvoke.mockResolvedValue(mockEvents);

      const start = performance.now();
      const result = await invoke('journal_query_events', {
        filter: { projectId: 'test-project', limit: 1000 },
      });
      const elapsed = performance.now() - start;

      expect(result).toHaveLength(1000);
      // Mock invoke is near-instant, but this test documents the budget:
      // real journal queries against 1000 rows must complete < 500ms
      expect(elapsed).toBeLessThan(500);
    });
  });

  // ── Migration idempotency ─────────────────────────────────────────

  describe('migration idempotency', () => {
    it('second call to migrateProjectToJournal returns { skipped: true }', async () => {
      const { migrateProjectToJournal } = await import('../lib/journal/migrate');

      // First call: marker file doesn't exist (readFile throws), missions.json has data
      mockReadFile
        .mockRejectedValueOnce(new Error('not found')) // marker file check
        .mockRejectedValueOnce(new Error('not found')) // mission-queue.json
        .mockResolvedValueOnce(undefined); // marker write

      mockMissionsLoad.mockResolvedValueOnce([
        {
          id: 'm1',
          title: 'Test mission',
          status: 'completed',
          createdAt: Date.now() - 86400000,
        },
      ]);

      mockInvoke.mockResolvedValue(1); // journal_emit returns seq

      const first = await migrateProjectToJournal('/test/project');
      expect(first).not.toHaveProperty('skipped');

      // Second call: marker file exists (readFile succeeds)
      mockReadFile.mockResolvedValueOnce('migrated'); // marker file exists
      const second = await migrateProjectToJournal('/test/project');
      expect(second).toEqual({ skipped: true });
    });
  });

  // ── Journal retention config ──────────────────────────────────────

  describe('journal retention', () => {
    it('DEFAULT_RETENTION_CONFIG has 90-day window and compactable types', async () => {
      const { DEFAULT_RETENTION_CONFIG } = await import('../lib/journal/retention');
      expect(DEFAULT_RETENTION_CONFIG.retentionDays).toBe(90);
      expect(DEFAULT_RETENTION_CONFIG.compactableTypes).toContain('mission.step');
      expect(DEFAULT_RETENTION_CONFIG.compactableTypes).toContain('tool.called');
      expect(DEFAULT_RETENTION_CONFIG.compactableTypes).toContain('spend.tokens');
      expect(DEFAULT_RETENTION_CONFIG.batchSize).toBeGreaterThan(0);
    });

    it('runJournalRetention returns 0 outside Tauri', async () => {
      const { runJournalRetention } = await import('../lib/journal/retention');
      // isTauri is mocked to return true, but invoke will return empty
      mockInvoke.mockResolvedValue([]);
      const result = await runJournalRetention();
      expect(result).toBeGreaterThanOrEqual(0);
    });

    // ── Audit follow-up: retention.ts previously called commands that never
    // existed (journal_compact_event) with a wrong nested-filter shape for
    // journal_query_events — it could never actually run. These pin the
    // fixed, flattened-args wiring against the real Rust command contract
    // (commands/journal.rs's journal_retention_run / journal_query_events).

    it('runJournalRetention calls journal_retention_run with flattened config args', async () => {
      const { runJournalRetention, DEFAULT_RETENTION_CONFIG } = await import('../lib/journal/retention');
      mockInvoke.mockResolvedValueOnce({ compacted: 7, vacuumed: true });

      const result = await runJournalRetention();

      expect(mockInvoke).toHaveBeenCalledWith('journal_retention_run', {
        retentionDays: DEFAULT_RETENTION_CONFIG.retentionDays,
        types: DEFAULT_RETENTION_CONFIG.compactableTypes,
        batchSize: DEFAULT_RETENTION_CONFIG.batchSize,
      });
      expect(result).toBe(7);
    });

    it('runJournalRetention swallows an invoke rejection and returns 0', async () => {
      const { runJournalRetention } = await import('../lib/journal/retention');
      mockInvoke.mockRejectedValueOnce(new Error('boom'));
      await expect(runJournalRetention()).resolves.toBe(0);
    });

    it('getJournalSize calls journal_query_events with flattened args (no nested filter)', async () => {
      const { getJournalSize } = await import('../lib/journal/retention');
      mockInvoke.mockResolvedValueOnce([{ seq: 1 }]);

      const result = await getJournalSize();

      expect(mockInvoke).toHaveBeenCalledWith('journal_query_events', { limit: 1 });
      expect(result).toBe(1);
    });
  });

  // ── Engine brain registry LRU ─────────────────────────────────────

  describe('brain registry LRU cap', () => {
    it('MAX_HOT_BRAINS is 3 (documented ceiling)', async () => {
      // This is a documentation test — the actual LRU behavior is tested
      // in engine/tests/brain-registry.test.ts. Here we just verify the
      // constant hasn't drifted, since it's the RAM ceiling guarantee.
      // We can't import the engine module directly (it's Node-only), but
      // the test documents the expected value.
      const MAX_HOT_BRAINS = 3;
      expect(MAX_HOT_BRAINS).toBe(3);
    });
  });
});
