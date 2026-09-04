/**
 * init config placement — canonical inside-brain location and back-compat
 * legacy parent-dir detection.
 *
 * Verifies:
 *   1. Fresh init writes config INSIDE <brain>/.lazybrain-config.json.
 *   2. Double init is detected via the canonical in-brain config.
 *   3. Legacy parent-dir-only config is treated as "already initialized".
 *   4. Two sibling brains no longer collide (each gets its own config file).
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/commands/init.js';

vi.mock('../src/util/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
  resetLoggerForTests: vi.fn(),
}));

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'lb-cfg-placement-'));
}

describe('init config placement', () => {
  let stdoutSpy: { mockRestore: () => void };

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('fresh init writes config INSIDE the brain directory', async () => {
    const base = makeTmp();
    const brainDir = join(base, 'brain');

    await runInit({ path: brainDir });

    // Canonical location: inside brain dir
    expect(existsSync(join(resolve(brainDir), '.lazybrain-config.json'))).toBe(true);
    // Legacy parent-dir location must NOT be created
    expect(existsSync(join(base, '.lazybrain-config.json'))).toBe(false);
  });

  it('double init throws when canonical in-brain config exists', async () => {
    const base = makeTmp();
    const brainDir = join(base, 'brain');

    await runInit({ path: brainDir });
    await expect(runInit({ path: brainDir })).rejects.toThrow(/already initialized/);
  });

  it('legacy parent-dir config is recognised as already-initialized', async () => {
    const base = makeTmp();
    const brainDir = join(base, 'brain');

    // Simulate a legacy brain: brain dir exists, config is in PARENT
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    writeFileSync(
      join(base, '.lazybrain-config.json'),
      JSON.stringify({ version: '1.0.0', createdAt: new Date().toISOString() }),
      'utf8',
    );

    // Without --force, must throw "already initialized"
    await expect(runInit({ path: brainDir })).rejects.toThrow(/already initialized/);
  });

  it('two sibling brains get independent config files (no collision)', async () => {
    const base = makeTmp();
    const brainA = join(base, 'brainA');
    const brainB = join(base, 'brainB');

    await runInit({ path: brainA });
    await runInit({ path: brainB });

    // Each brain has its own config
    expect(existsSync(join(resolve(brainA), '.lazybrain-config.json'))).toBe(true);
    expect(existsSync(join(resolve(brainB), '.lazybrain-config.json'))).toBe(true);
    // No shared config in the common parent
    expect(existsSync(join(base, '.lazybrain-config.json'))).toBe(false);
  });

  it('--force re-init succeeds when canonical config exists', async () => {
    const base = makeTmp();
    const brainDir = join(base, 'brain');

    await runInit({ path: brainDir });
    const report = await runInit({ path: brainDir, force: true });

    expect(report.configWritten).toBe(true);
    expect(report.created).toBe(false); // already existed
    expect(existsSync(join(resolve(brainDir), '.lazybrain-config.json'))).toBe(true);
  });
});
