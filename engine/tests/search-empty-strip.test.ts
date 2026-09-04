/**
 * E2 — search --strip with 0 hits must print "[No results for: <query>]".
 * BRAIN-NOT-FOUND — search against a nonexistent brain exits with an error message.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

// We need to mock the route() call so tests do not actually hit the SQLite DB
// for E2. For BRAIN-NOT-FOUND we use a path that has no notes/ directory.

vi.mock('../src/retrieval/router.js', () => ({
  route: vi.fn().mockResolvedValue({ hits: [], levelUsed: 'L2', totalMs: 1 }),
}));

vi.mock('../src/retrieval/multi-query.js', () => ({
  isMultiQueryEnabled: vi.fn().mockResolvedValue(false),
  routeWithRRF: vi.fn(),
}));

import { runSearch } from '../src/commands/search.js';

describe('E2 — search --strip with 0 hits', () => {
  const savedEnv = { ...process.env };
  let brainDir: string;

  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'lb-e2-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
    vi.clearAllMocks();
  });

  it('prints "[No results for: <query>]" on stdout when --strip and 0 hits', async () => {
    const result = await runSearch({ query: 'bogus-nonexistent-term', strip: true });
    expect(result).toBe('[No results for: bogus-nonexistent-term]');
  });

  it('does not print nothing (empty string) on 0 hits with --strip', async () => {
    const result = await runSearch({ query: 'nonexistent', strip: true });
    expect(result.trim()).not.toBe('');
  });

  it('--pretty mode shows 0 hits line (not empty)', async () => {
    const result = await runSearch({ query: 'nonexistent', pretty: true });
    expect(result).toContain('0 hits');
  });

  it('JSON mode shows empty hits array (no change needed)', async () => {
    const result = await runSearch({ query: 'nonexistent' });
    const parsed = JSON.parse(result) as { hits: unknown[] };
    expect(parsed.hits).toHaveLength(0);
  });
});

describe('BRAIN-NOT-FOUND — search against missing brain', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Point to a path that does not exist on disk at all
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpdir(), `lb-missing-brain-${Date.now()}`);
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
    vi.clearAllMocks();
  });

  it('runSearch throws with brain-not-found message for missing brain', async () => {
    await expect(runSearch({ query: 'anything', strip: true })).rejects.toThrow(/Brain not found/);
  });
});
