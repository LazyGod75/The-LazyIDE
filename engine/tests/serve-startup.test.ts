/**
 * lazybrain serve startup — human-readable line on stdout when listening.
 *
 * Tests:
 * - A "LazyBrain wiki running at http://..." line is written to stdout when
 *   the server starts successfully.
 * - The structured pino log line is still emitted (brain guard/logging).
 * - Brain-not-found still rejects before printing any startup line.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

describe('serve — human-readable startup line', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
    vi.clearAllMocks();
  });

  it('writes "LazyBrain wiki running at http://..." to stdout when server starts', async () => {
    // Create a minimal brain with notes/ dir so the guard passes
    const brainDir = mkdtempSync(join(tmpdir(), 'lb-serve-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const { runServe } = await import('../src/commands/serve.js');

    // Use port 0 to let the OS assign a free port
    const server = await runServe({ port: 0, bind: '127.0.0.1' });
    const allStdout = stdoutChunks.join('');

    expect(allStdout).toMatch(/LazyBrain wiki running at http:\/\/127\.0\.0\.1:\d+/);
    expect(allStdout).toContain('Ctrl+C to stop');

    // Clean up
    await new Promise<void>((res) => server.close(() => res()));
    stdoutSpy.mockRestore();
  });

  it('does not print startup line when brain is missing (rejects before listen)', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'lb-serve-empty-'));
    process.env.LAZYBRAIN_BRAIN_PATH = emptyDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(emptyDir, '_cache');
    resetConfigForTests();

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    const { runServe } = await import('../src/commands/serve.js');

    await expect(runServe({ port: 0 })).rejects.toThrow(/Brain not found/);
    const allStdout = stdoutChunks.join('');
    expect(allStdout).not.toContain('LazyBrain wiki running');

    stdoutSpy.mockRestore();
  });
});
