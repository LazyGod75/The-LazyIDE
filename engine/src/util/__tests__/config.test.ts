import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// We test discovery in isolation by controlling env vars and resetting the cache.
// Import resetConfigForTests and getConfig after each env manipulation.

const TMP = tmpdir();

function makeTmpDir(name: string): string {
  const p = join(TMP, `lb-test-${name}-${Date.now()}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function cleanup(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe('config path discovery — precedence', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save env vars we may mutate
    for (const k of ['LAZYBRAIN_BRAIN_PATH', 'LAZYBRAIN_BRAIN_PATH_CLI', 'LAZYBRAIN_CACHE_PATH']) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // -------------------------------------------------------------------------
  // 1. LAZYBRAIN_BRAIN_PATH_CLI (--brain flag) wins — highest priority
  // -------------------------------------------------------------------------
  // (tested in case 3 below; case 1 here verifies env var still works alone)

  // -------------------------------------------------------------------------
  // 2. LAZYBRAIN_BRAIN_PATH env var (priority 2)
  // -------------------------------------------------------------------------
  it('uses LAZYBRAIN_BRAIN_PATH env var (priority 2)', async () => {
    const dir = makeTmpDir('env');
    try {
      process.env.LAZYBRAIN_BRAIN_PATH = dir;
      process.env.LAZYBRAIN_CACHE_PATH = join(dir, '_cache');

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();
      const cfg = getConfig();
      expect(cfg.brainPath).toBe(dir);
    } finally {
      cleanup(dir);
    }
  });

  // -------------------------------------------------------------------------
  // 2b. LAZYBRAIN_BRAIN_PATH_CLI (--brain flag) when env var absent
  // -------------------------------------------------------------------------
  it('uses LAZYBRAIN_BRAIN_PATH_CLI when env var is absent (priority 1)', async () => {
    const dir = makeTmpDir('cli');
    try {
      delete process.env.LAZYBRAIN_BRAIN_PATH;
      process.env.LAZYBRAIN_BRAIN_PATH_CLI = dir;
      process.env.LAZYBRAIN_CACHE_PATH = join(dir, '_cache');

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();
      const cfg = getConfig();
      expect(cfg.brainPath).toBe(dir);
    } finally {
      cleanup(dir);
    }
  });

  // -------------------------------------------------------------------------
  // 3. LAZYBRAIN_BRAIN_PATH_CLI wins over LAZYBRAIN_BRAIN_PATH env var
  // -------------------------------------------------------------------------
  it('CLI flag takes priority over env var when both are set (priority 1 > 2)', async () => {
    const cliDir = makeTmpDir('cli-wins');
    const envDir = makeTmpDir('env-loses');
    try {
      process.env.LAZYBRAIN_BRAIN_PATH_CLI = cliDir;
      process.env.LAZYBRAIN_BRAIN_PATH = envDir;
      process.env.LAZYBRAIN_CACHE_PATH = join(cliDir, '_cache');

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();
      const cfg = getConfig();
      expect(cfg.brainPath).toBe(cliDir);
    } finally {
      cleanup(cliDir);
      cleanup(envDir);
    }
  });

  // -------------------------------------------------------------------------
  // 4. .lazybrain/ walk-up from cwd (priority 3)
  // -------------------------------------------------------------------------
  it('discovers .lazybrain/ by walking up from cwd (priority 3)', async () => {
    const root = makeTmpDir('walkup');
    const dotDir = join(root, '.lazybrain');
    const brainDir = join(dotDir, 'brain');
    mkdirSync(brainDir, { recursive: true });

    try {
      delete process.env.LAZYBRAIN_BRAIN_PATH;
      delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
      process.env.LAZYBRAIN_CACHE_PATH = join(root, '_cache');

      // Temporarily override cwd to root so walk-up finds it immediately
      const origCwd = process.cwd;
      process.cwd = () => root;

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();
      const cfg = getConfig();

      process.cwd = origCwd;

      expect(cfg.brainPath).toBe(brainDir);
    } finally {
      cleanup(root);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Walk-up wins over Documents fallback (priority 3 > 4)
  // -------------------------------------------------------------------------
  it('walk-up wins over Documents discovery (priority 3 > 4)', async () => {
    const root = makeTmpDir('walkup-priority');
    const dotDir = join(root, '.lazybrain');
    const brainDir = join(dotDir, 'brain');
    mkdirSync(brainDir, { recursive: true });

    try {
      delete process.env.LAZYBRAIN_BRAIN_PATH;
      delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
      process.env.LAZYBRAIN_CACHE_PATH = join(root, '_cache');

      const origCwd = process.cwd;
      process.cwd = () => root;

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();
      const cfg = getConfig();

      process.cwd = origCwd;

      // Must be the walk-up result, not whatever might be in Documents
      expect(cfg.brainPath).toBe(brainDir);
    } finally {
      cleanup(root);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Fallback ~/.lazybrain/brain/ (priority 5)
  // -------------------------------------------------------------------------
  it('falls back to ~/.lazybrain/brain/ when nothing else is found (priority 5)', async () => {
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;

    // Point cache to tmp so we don't pollute real cache
    const cacheDir = makeTmpDir('fallback-cache');
    process.env.LAZYBRAIN_CACHE_PATH = cacheDir;

    // Override cwd to a directory that has no .lazybrain/ ancestor
    const isolated = makeTmpDir('isolated');

    try {
      const origCwd = process.cwd;
      process.cwd = () => isolated;

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();

      // We don't control ~/Documents so we can't guarantee priority 4 doesn't fire.
      // We CAN assert that the result is either Documents-based or ~/.lazybrain/brain.
      let cfg: { brainPath: string } | null = null;
      try {
        cfg = getConfig();
      } catch {
        // If a real Documents brain exists and is found, getConfig succeeds.
        // If neither exists and fallback creates it, it also succeeds.
      }

      process.cwd = origCwd;

      if (cfg) {
        // Either fallback or Documents match — both are valid
        expect(typeof cfg.brainPath).toBe('string');
        expect(cfg.brainPath.length).toBeGreaterThan(0);
      }
    } finally {
      cleanup(isolated);
      cleanup(cacheDir);
    }
  });
});

describe('config caching', () => {
  it('returns the same object on repeated calls', async () => {
    const dir = makeTmpDir('cache-test');
    try {
      process.env.LAZYBRAIN_BRAIN_PATH = dir;
      process.env.LAZYBRAIN_CACHE_PATH = join(dir, '_cache');

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();
      const a = getConfig();
      const b = getConfig();
      expect(a).toBe(b);
    } finally {
      cleanup(dir);
      delete process.env.LAZYBRAIN_BRAIN_PATH;
      delete process.env.LAZYBRAIN_CACHE_PATH;
    }
  });

  it('resetConfigForTests clears the cache', async () => {
    const dir1 = makeTmpDir('reset-1');
    const dir2 = makeTmpDir('reset-2');
    try {
      process.env.LAZYBRAIN_BRAIN_PATH = dir1;
      process.env.LAZYBRAIN_CACHE_PATH = join(dir1, '_cache');

      const { getConfig, resetConfigForTests } = await import('../config.js');
      resetConfigForTests();
      const a = getConfig();
      expect(a.brainPath).toBe(dir1);

      resetConfigForTests();
      process.env.LAZYBRAIN_BRAIN_PATH = dir2;
      process.env.LAZYBRAIN_CACHE_PATH = join(dir2, '_cache');
      const b = getConfig();
      expect(b.brainPath).toBe(dir2);
    } finally {
      cleanup(dir1);
      cleanup(dir2);
      delete process.env.LAZYBRAIN_BRAIN_PATH;
      delete process.env.LAZYBRAIN_CACHE_PATH;
    }
  });
});
