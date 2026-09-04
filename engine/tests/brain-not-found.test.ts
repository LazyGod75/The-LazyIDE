/**
 * BRAIN-NOT-FOUND — commands against a missing brain must fail clearly.
 *
 * Tests:
 * - search: throws "Brain not found at <path>..." when notes/ dir missing
 * - query: throws "Brain not found at <path>..." when notes/ dir missing
 * - serve: refuses to start (throws) when brain path has no notes/ directory.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

vi.mock('../src/retrieval/router.js', () => ({
  route: vi.fn().mockResolvedValue({ hits: [], levelUsed: 'L2', totalMs: 1 }),
}));

vi.mock('../src/retrieval/multi-query.js', () => ({
  isMultiQueryEnabled: vi.fn().mockResolvedValue(false),
  routeWithRRF: vi.fn(),
}));

import { runQuery } from '../src/commands/query.js';
import { runSearch } from '../src/commands/search.js';

describe('BRAIN-NOT-FOUND — search', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Point to a directory that exists but has no notes/ subdirectory
    const emptyDir = mkdtempSync(join(tmpdir(), 'lb-empty-'));
    process.env.LAZYBRAIN_BRAIN_PATH = emptyDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(emptyDir, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
    vi.clearAllMocks();
  });

  it('throws with "Brain not found" when notes/ directory is absent', async () => {
    await expect(runSearch({ query: 'anything' })).rejects.toThrow(/Brain not found/);
  });

  it('error message includes the brain path', async () => {
    try {
      await runSearch({ query: 'test' });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/Brain not found at .+/);
    }
  });

  it('error message mentions init command', async () => {
    try {
      await runSearch({ query: 'test' });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('lazybrain init');
    }
  });
});

describe('BRAIN-NOT-FOUND — query', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Point to a directory that exists but has no notes/ subdirectory
    const emptyDir = mkdtempSync(join(tmpdir(), 'lb-query-empty-'));
    process.env.LAZYBRAIN_BRAIN_PATH = emptyDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(emptyDir, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
    vi.clearAllMocks();
  });

  it('throws with "Brain not found" when notes/ directory is absent', () => {
    expect(() => runQuery({ selector: 'article' })).toThrow(/Brain not found/);
  });

  it('error message includes the brain path', () => {
    try {
      runQuery({ selector: 'article' });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/Brain not found at .+/);
    }
  });

  it('error message mentions init command', () => {
    try {
      runQuery({ selector: 'article' });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('lazybrain init');
    }
  });

  it('succeeds when brain directory with notes/ exists', () => {
    // Create a brain dir with a notes/ subdirectory so the guard passes
    const brainDir = mkdtempSync(join(tmpdir(), 'lb-query-brain-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();

    // Empty brain — valid selector returns no matches (not an error)
    const result = runQuery({ selector: 'article' });
    const parsed = JSON.parse(result) as { count: number };
    expect(parsed.count).toBe(0);
  });
});

describe('BRAIN-NOT-FOUND — serve guard', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'lb-serve-empty-'));
    process.env.LAZYBRAIN_BRAIN_PATH = emptyDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(emptyDir, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
    vi.clearAllMocks();
  });

  it('runServe rejects when brain has no notes/ directory', async () => {
    const { runServe } = await import('../src/commands/serve.js');
    await expect(runServe({ port: 0 })).rejects.toThrow(/Brain not found/);
  });
});
