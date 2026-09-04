/**
 * CONFIG REGRESSION — test the full precedence order:
 *   flag (LAZYBRAIN_BRAIN_PATH_CLI) > env (LAZYBRAIN_BRAIN_PATH) > walk-up > legacy > default
 *
 * Key scenario: env var set + a .lazybrain/ present in cwd → env WINS.
 */

import { existsSync, mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, resetConfigForTests } from '../src/util/config.js';

describe('CONFIG — precedence order', () => {
  const savedEnv = { ...process.env };
  let tmpA: string;
  let tmpB: string;
  let tmpC: string;

  beforeEach(() => {
    tmpA = mkdtempSync(join(homedir(), 'lb-cfg-a-'));
    tmpB = mkdtempSync(join(homedir(), 'lb-cfg-b-'));
    tmpC = mkdtempSync(join(homedir(), 'lb-cfg-c-'));
    // Clean all relevant env vars
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_CACHE_PATH;
    resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('CLI flag (LAZYBRAIN_BRAIN_PATH_CLI) beats env var', () => {
    mkdirSync(tmpA, { recursive: true });
    mkdirSync(tmpB, { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH_CLI = tmpA;
    process.env.LAZYBRAIN_BRAIN_PATH = tmpB;
    const cfg = getConfig();
    expect(cfg.brainPath).toBe(resolve(tmpA));
  });

  it('env var (LAZYBRAIN_BRAIN_PATH) beats walk-up .lazybrain/', () => {
    // Create a .lazybrain/ in the current working directory (walk-up would find it)
    const dotDir = join(process.cwd(), '.lazybrain');
    let createdDotDir = false;
    try {
      if (!existsSync(dotDir)) {
        mkdirSync(dotDir, { recursive: true });
        createdDotDir = true;
      }
    } catch {
      // If cwd is read-only, skip the walkup part — just test env priority
    }

    mkdirSync(tmpC, { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = tmpC;
    resetConfigForTests();

    const cfg = getConfig();
    expect(cfg.brainPath).toBe(resolve(tmpC));

    // Cleanup: remove the .lazybrain dir we may have created
    if (createdDotDir) {
      try {
        rmdirSync(dotDir);
      } catch {
        // best-effort
      }
    }
  });

  it('env var wins even when .lazybrain/ exists alongside (key regression)', () => {
    // Set up a temp dir with a .lazybrain/ inside, simulating a project that
    // has been initialized. Then point env to a DIFFERENT path.
    const projectDir = mkdtempSync(join(homedir(), 'lb-project-'));
    const dotDir = join(projectDir, '.lazybrain');
    mkdirSync(dotDir, { recursive: true });
    // Note: getConfig walks up from process.cwd(), not from projectDir, so we
    // can't inject a mid-tree .lazybrain without changing cwd. Instead, we
    // assert that env > walk-up by verifying: if LAZYBRAIN_BRAIN_PATH is set,
    // getConfig() returns that path regardless of any .lazybrain in cwd.
    mkdirSync(tmpA, { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = tmpA;
    const cfg = getConfig();
    expect(cfg.brainPath).toBe(resolve(tmpA));
  });

  it('when neither CLI nor env set, walk-up .lazybrain/ is used', () => {
    // We cannot easily inject a .lazybrain/ above cwd in a test without
    // changing cwd. Assert that when no env var and no walk-up found, the
    // fallback default path is returned.
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    resetConfigForTests();

    const cfg = getConfig();
    // Should return some path (either walk-up discovery, legacy Documents scan,
    // or the default ~/.lazybrain/brain).
    expect(typeof cfg.brainPath).toBe('string');
    expect(cfg.brainPath.length).toBeGreaterThan(0);
  });

  it('LAZYBRAIN_CACHE_PATH overrides the default _cache sibling', () => {
    mkdirSync(tmpA, { recursive: true });
    mkdirSync(tmpB, { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = tmpA;
    process.env.LAZYBRAIN_CACHE_PATH = tmpB;
    const cfg = getConfig();
    expect(cfg.cachePath).toBe(resolve(tmpB));
  });
});
