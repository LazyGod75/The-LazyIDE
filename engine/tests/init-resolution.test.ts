/**
 * init brain-path resolution — three sources:
 *   1. opts.path (--brain flag) — highest priority
 *   1b. LAZYBRAIN_BRAIN_PATH_CLI env (set by global Commander --brain option) — same "flag" tier
 *   2. LAZYBRAIN_BRAIN_PATH env var
 *   3. $CWD/.lazybrain/brain default
 *
 * Also verifies: stdout "Initialized brain at <path>" message and env notice.
 * Includes CLI-plumbing tests via LAZYBRAIN_BRAIN_PATH_CLI to exercise the
 * real Commander global-option forwarding path.
 */

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { resetConfigForTests } from '../src/util/config.js';

vi.mock('../src/util/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
  resetLoggerForTests: vi.fn(),
}));

describe('runInit — brain path resolution', () => {
  const savedEnv = { ...process.env };
  let stdoutOutput: string;
  let stdoutSpy: { mockRestore: () => void };

  beforeEach(() => {
    // Capture stdout to verify the "Initialized brain at" line
    stdoutOutput = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutOutput += String(chunk);
      return true;
    });
    // Clear env vars so tests start clean
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
    resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    resetConfigForTests();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // CLI-plumbing tier: LAZYBRAIN_BRAIN_PATH_CLI
  // This exercises the real path taken when the user runs:
  //   lazybrain init --brain <path>
  // The global Commander option sets LAZYBRAIN_BRAIN_PATH_CLI before the
  // init action handler runs.  resolveBrainTarget must consult this env var
  // as the "flag" tier so the brain lands in the right place.
  // -----------------------------------------------------------------------

  it('CLI-plumbing: LAZYBRAIN_BRAIN_PATH_CLI drives init when opts.path is absent', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-cli-flag-'));
    const targetBrain = join(base, 'cli-brain');

    // Simulate what bin/lazybrain.ts global --brain option coercion does
    process.env.LAZYBRAIN_BRAIN_PATH_CLI = targetBrain;
    // Also set LAZYBRAIN_BRAIN_PATH to confirm it is overridden
    process.env.LAZYBRAIN_BRAIN_PATH = join(base, 'should-not-be-used');

    // opts.path is NOT passed (as in the real CLI: init action opts is empty
    // because Commander consumed --brain at the program level)
    const report = await runInit({});

    expect(report.brainPath).toBe(resolve(targetBrain));
    expect(report.resolvedFrom).toBe('flag');
    expect(existsSync(join(report.brainPath, 'notes'))).toBe(true);
    expect(stdoutOutput).toContain(resolve(targetBrain));
    expect(stdoutOutput).toContain('(from --brain)');
  });

  it('CLI-plumbing: LAZYBRAIN_BRAIN_PATH_CLI wins over LAZYBRAIN_BRAIN_PATH', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-cli-priority-'));
    const flagBrain = join(base, 'flag-brain');
    const envBrain = join(base, 'env-brain');

    process.env.LAZYBRAIN_BRAIN_PATH_CLI = flagBrain;
    process.env.LAZYBRAIN_BRAIN_PATH = envBrain;

    const report = await runInit({});

    expect(report.brainPath).toBe(resolve(flagBrain));
    expect(report.resolvedFrom).toBe('flag');
  });

  it('CLI-plumbing: opts.path wins over LAZYBRAIN_BRAIN_PATH_CLI (direct call takes precedence)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-cli-opts-wins-'));
    const optsBrain = join(base, 'opts-brain');
    const cliBrain = join(base, 'cli-brain');

    process.env.LAZYBRAIN_BRAIN_PATH_CLI = cliBrain;

    const report = await runInit({ path: optsBrain });

    expect(report.brainPath).toBe(resolve(optsBrain));
    expect(report.resolvedFrom).toBe('flag');
  });

  // -----------------------------------------------------------------------
  // Original resolution tests (unchanged semantics)
  // -----------------------------------------------------------------------

  it('resolution 1: opts.path (--brain flag) wins over env and cwd', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-flag-'));
    const targetBrain = join(base, 'my-brain');

    // Set env var — it should be overridden by the flag
    process.env.LAZYBRAIN_BRAIN_PATH = join(base, 'should-not-be-used');

    const report = await runInit({ path: targetBrain });

    expect(report.brainPath).toBe(resolve(targetBrain));
    expect(report.resolvedFrom).toBe('flag');
    expect(existsSync(join(report.brainPath, 'notes'))).toBe(true);
    expect(stdoutOutput).toContain(resolve(targetBrain));
  });

  it('resolution 2: LAZYBRAIN_BRAIN_PATH env var used when no flag', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-env-'));
    const targetBrain = join(base, 'env-brain');
    process.env.LAZYBRAIN_BRAIN_PATH = targetBrain;

    const report = await runInit({});

    expect(report.brainPath).toBe(resolve(targetBrain));
    expect(report.resolvedFrom).toBe('env');
    expect(existsSync(join(report.brainPath, 'notes'))).toBe(true);
    // Stdout should mention "from LAZYBRAIN_BRAIN_PATH"
    expect(stdoutOutput).toContain('LAZYBRAIN_BRAIN_PATH');
  });

  it('resolution 3: $CWD/.lazybrain/brain default when neither flag nor env', async () => {
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;

    // The repo cwd may already have .lazybrain/ — use --force to avoid the
    // "already initialized" guard interfering with the resolution-path test.
    const report = await runInit({ force: true });

    const expectedBrainPath = resolve(process.cwd(), '.lazybrain', 'brain');
    expect(report.brainPath).toBe(expectedBrainPath);
    expect(report.resolvedFrom).toBe('cwd');
    expect(existsSync(join(report.brainPath, 'notes'))).toBe(true);
    expect(stdoutOutput).toContain(expectedBrainPath);
  });

  it('--force overwrites an existing brain without error', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-force-'));
    const targetBrain = join(base, 'brain');
    mkdirSync(join(targetBrain, 'notes'), { recursive: true });

    // First init
    const report1 = await runInit({ path: targetBrain });
    expect(report1.created).toBe(true);

    // Re-init without --force should throw
    await expect(runInit({ path: targetBrain })).rejects.toThrow(/already initialized/);

    // Re-init with --force should succeed
    stdoutOutput = '';
    const report2 = await runInit({ path: targetBrain, force: true });
    expect(report2.created).toBe(false); // already existed
    expect(report2.configWritten).toBe(true);
  });

  it('creates notes/, knowledge-nodes/, _cache/, meta/ subdirectories', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-dirs-'));
    const targetBrain = join(base, 'brain');

    const report = await runInit({ path: targetBrain });

    expect(existsSync(report.notes)).toBe(true);
    expect(existsSync(report.cache)).toBe(true);
    expect(existsSync(report.knowledgeNodes)).toBe(true);
    expect(existsSync(join(report.brainPath, 'meta'))).toBe(true);
    expect(report.configWritten).toBe(true);
  });

  it('stdout prints "Initialized brain at <abs path>" in all resolution modes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-stdout-'));
    const targetBrain = join(base, 'abs-brain');

    await runInit({ path: targetBrain });

    expect(stdoutOutput).toContain('Initialized brain at');
    expect(stdoutOutput).toContain(resolve(targetBrain));
  });
});
