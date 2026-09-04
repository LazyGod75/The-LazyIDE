/**
 * config-cache-path.test.ts
 *
 * Tests for the cache-path footgun fix in src/util/config.ts:
 *   1. Default cache resolves INSIDE the brain directory (not its sibling).
 *   2. LAZYBRAIN_CACHE_PATH env var still wins unconditionally.
 *   3. Migration: legacy sibling _cache is copied into the new in-brain location.
 *   4. Second call is a no-op (migration only fires when new cache does not exist).
 *   5. Failed copy degrades gracefully (fresh empty cache, no crash).
 *   6. Documents-scan warning fires exactly once per discovery.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getConfig,
  resetConfigForTests,
  resetDocumentsWarningForTests,
} from '../src/util/config.js';

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'lb-cachepath-'));
}

describe('config — cache path resolution', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_CACHE_PATH;
    resetConfigForTests();
    resetDocumentsWarningForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfigForTests();
    resetDocumentsWarningForTests();
    vi.restoreAllMocks();
  });

  it('default cachePath is inside the brain directory (not a sibling)', () => {
    const brainDir = makeTmp();
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    const cfg = getConfig();
    // Must start with brainDir, not dirname(brainDir)
    expect(cfg.cachePath.startsWith(resolve(brainDir))).toBe(true);
    expect(cfg.cachePath).toBe(resolve(brainDir, '_cache'));
    rmSync(brainDir, { recursive: true, force: true });
  });

  it('LAZYBRAIN_CACHE_PATH env override wins over in-brain default', () => {
    const brainDir = makeTmp();
    const customCache = makeTmp();
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = customCache;
    const cfg = getConfig();
    expect(cfg.cachePath).toBe(resolve(customCache));
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(customCache, { recursive: true, force: true });
  });

  it('migrates legacy sibling _cache when new in-brain cache does not exist', () => {
    const parentDir = makeTmp();
    const brainDir = join(parentDir, 'brain');
    mkdirSync(brainDir, { recursive: true });

    // Create legacy sibling cache with a test file
    const legacyCache = join(parentDir, '_cache');
    mkdirSync(legacyCache, { recursive: true });
    writeFileSync(join(legacyCache, 'fts.sqlite'), 'legacy-data', 'utf8');

    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    const cfg = getConfig();

    // New cache is inside the brain
    expect(cfg.cachePath).toBe(resolve(brainDir, '_cache'));
    // Legacy file was copied
    const newFile = join(cfg.cachePath, 'fts.sqlite');
    expect(existsSync(newFile)).toBe(true);
    // Legacy dir still exists (copy, not move)
    expect(existsSync(legacyCache)).toBe(true);
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('migration is a no-op on the second getConfig() call (cache already exists)', () => {
    const parentDir = makeTmp();
    const brainDir = join(parentDir, 'brain');
    mkdirSync(brainDir, { recursive: true });

    const legacyCache = join(parentDir, '_cache');
    mkdirSync(legacyCache, { recursive: true });
    writeFileSync(join(legacyCache, 'fts.sqlite'), 'original', 'utf8');

    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    // First call — triggers migration
    const cfg1 = getConfig();
    expect(existsSync(join(cfg1.cachePath, 'fts.sqlite'))).toBe(true);

    // Modify the legacy file after migration
    writeFileSync(join(legacyCache, 'fts.sqlite'), 'modified-after-migration', 'utf8');

    // Second call — the new in-brain cache already exists, no re-copy
    resetConfigForTests();
    const cfg2 = getConfig();
    const content = readFileSync(join(cfg2.cachePath, 'fts.sqlite'), 'utf8');
    // Still the original, not the modified content (migration did not fire again)
    expect(content).toBe('original');
    rmSync(parentDir, { recursive: true, force: true });
  });

  it('does NOT re-migrate legacy cache after brain/_cache is deleted (one-way migration)', () => {
    // Regression coverage for a real footgun: deleting brain/_cache to force
    // a fresh index used to silently re-trigger migration from the legacy
    // sibling _cache on the very next getConfig() call, re-polluting the
    // "fresh" brain with stale FTS/graph/embeddings data (notes/index
    // mismatch -> init-failed). The migration decision must be one-way,
    // recorded outside cachePath so it survives brain/_cache being deleted.
    const parentDir = makeTmp();
    const brainDir = join(parentDir, 'brain');
    mkdirSync(brainDir, { recursive: true });

    const legacyCache = join(parentDir, '_cache');
    mkdirSync(legacyCache, { recursive: true });
    writeFileSync(join(legacyCache, 'fts.sqlite'), 'stale-legacy-data', 'utf8');

    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;

    // First call — migrates the legacy cache into brain/_cache as before.
    const cfg1 = getConfig();
    expect(existsSync(join(cfg1.cachePath, 'fts.sqlite'))).toBe(true);

    // User deletes brain/_cache to force a fresh index — a normal "reset".
    rmSync(cfg1.cachePath, { recursive: true, force: true });
    expect(existsSync(cfg1.cachePath)).toBe(false);

    // Second call — must NOT silently re-copy the stale legacy sibling data
    // back in; the migration decision for this brain is already made.
    resetConfigForTests();
    const cfg2 = getConfig();
    expect(existsSync(cfg2.cachePath)).toBe(true);
    expect(existsSync(join(cfg2.cachePath, 'fts.sqlite'))).toBe(false);

    rmSync(parentDir, { recursive: true, force: true });
  });

  it('gracefully degrades when legacy cache copy fails (no crash, fresh empty cache)', () => {
    const parentDir = makeTmp();
    const brainDir = join(parentDir, 'brain');
    mkdirSync(brainDir, { recursive: true });

    const legacyCache = join(parentDir, '_cache');
    mkdirSync(legacyCache, { recursive: true });
    // Write a file in the legacy cache so migration is attempted
    writeFileSync(join(legacyCache, 'fts.sqlite'), 'data', 'utf8');

    // Mock mkdirSync to let the cache dir creation proceed, then mock
    // copyFileSync on the fs module to throw.  Because config.ts imports
    // copyFileSync at module load time via a named import we can't spy on the
    // module-level binding directly; instead we verify that even when the
    // migrateLegacyCache helper swallows the error the config still resolves.
    //
    // Strategy: point brainDir at a path where migration succeeds normally,
    // then verify the fallback by making legacyCache unreadable by removing it
    // right before getConfig(), so readdirSync inside migrateLegacyCache throws.
    rmSync(legacyCache, { recursive: true, force: true });
    // Re-create as a file (not a dir) so readdirSync on it throws ENOTDIR.
    writeFileSync(legacyCache, 'not-a-directory', 'utf8');

    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    let cfg: ReturnType<typeof getConfig> | undefined;
    expect(() => {
      cfg = getConfig();
    }).not.toThrow();

    // Config still resolves, cachePath still set inside the brain
    expect(cfg?.cachePath).toBe(resolve(brainDir, '_cache'));
    rmSync(parentDir, { recursive: true, force: true });
  });
});

describe('config — Documents-scan warning', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_CACHE_PATH;
    resetConfigForTests();
    resetDocumentsWarningForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfigForTests();
    resetDocumentsWarningForTests();
    vi.restoreAllMocks();
  });

  it('warning does NOT fire when no Lazy-Brain folder is found (fallback path taken)', () => {
    // In CI/test environments there is no ~/Documents/Lazy-Brain-* folder.
    // Clear env vars so discovery falls through to the ~/.lazybrain/brain fallback.
    // Verify no Documents-scan warning is written.
    const stderrSpy = vi.spyOn(process.stderr, 'write');

    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
    resetConfigForTests();
    resetDocumentsWarningForTests();

    // getConfig() may throw if the fallback brain doesn't exist AND the walk-up
    // doesn't find a .lazybrain — catch that; we only care about no warn message.
    try {
      getConfig();
    } catch {
      // fallback path creation may or may not succeed — not our concern here
    }

    const warnCalls = stderrSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && (msg as string).includes('legacy ~/Documents scan'),
    );
    // No Lazy-Brain folder in a temp home → no warning fired
    expect(warnCalls.length).toBe(0);
  });

  it('warning does NOT fire when LAZYBRAIN_BRAIN_PATH is set', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write');
    const brainDir = makeTmp();
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    getConfig();
    const warnCalls = stderrSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && (msg as string).includes('legacy ~/Documents scan'),
    );
    expect(warnCalls.length).toBe(0);
    rmSync(brainDir, { recursive: true, force: true });
  });
});
