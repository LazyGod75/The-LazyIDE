import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../init.js';

vi.mock('../../util/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
  resetLoggerForTests: vi.fn(),
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lazybrain-init-test-'));
}

describe('runInit', () => {
  let tmpDir: string;
  let stdoutSpy: { mockRestore: () => void };

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Suppress stdout writes so "Initialized brain at" lines don't leak to test output
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_BRAIN_PATH_CLI;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('creates the full directory structure in a temp dir', async () => {
    // opts.path = explicit brain directory path (not a project root)
    const brainDir = join(tmpDir, 'brain');
    const report = await runInit({ path: brainDir });

    expect(report.brainPath).toBe(resolve(brainDir));
    expect(report.notes).toBe(join(resolve(brainDir), 'notes'));
    expect(report.cache).toBe(join(resolve(brainDir), '_cache'));
    expect(report.knowledgeNodes).toBe(join(resolve(brainDir), 'knowledge-nodes'));
    expect(report.configWritten).toBe(true);
    expect(report.created).toBe(true);

    expect(existsSync(join(resolve(brainDir), 'notes'))).toBe(true);
    expect(existsSync(join(resolve(brainDir), 'knowledge-nodes'))).toBe(true);
    expect(existsSync(join(resolve(brainDir), '_cache'))).toBe(true);
    expect(existsSync(join(resolve(brainDir), 'meta'))).toBe(true);
    // Config lives INSIDE the brain dir (canonical location — not in the parent)
    expect(existsSync(join(resolve(brainDir), '.lazybrain-config.json'))).toBe(true);
    // Legacy parent-dir location must NOT be created by init
    expect(existsSync(join(tmpDir, '.lazybrain-config.json'))).toBe(false);
  });

  it('config file is valid JSON with version and createdAt', async () => {
    const brainDir = join(tmpDir, 'brain');
    await runInit({ path: brainDir });

    // Canonical location: inside the brain dir
    const configPath = join(resolve(brainDir), '.lazybrain-config.json');
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as { version: string; createdAt: string };

    expect(config.version).toBe('1.0.0');
    expect(typeof config.createdAt).toBe('string');
    expect(() => new Date(config.createdAt)).not.toThrow();
  });

  it('throws when already initialized and --force is not set', async () => {
    const brainDir = join(tmpDir, 'brain');
    // First init
    await runInit({ path: brainDir });

    // Second init without --force must throw
    await expect(runInit({ path: brainDir })).rejects.toThrow('LazyBrain already initialized');
  });

  it('succeeds when already initialized and --force is set', async () => {
    const brainDir = join(tmpDir, 'brain');
    // First init
    await runInit({ path: brainDir });

    // Second init with --force must not throw
    const report = await runInit({ path: brainDir, force: true });

    expect(report.configWritten).toBe(true);
    // created is false because the directory already existed
    expect(report.created).toBe(false);
  });
});
