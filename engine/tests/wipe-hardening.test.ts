/**
 * wipe-hardening.test.ts
 *
 * Tests for the wipe hardening changes in src/commands/wipe.ts:
 *   1. Without --yes: nothing deleted, stdout summary written, throws with WIPE_NO_CONFIRM.
 *   2. With --yes on a temp brain: deletes as before.
 *   3. Daemon running mock: runWipe refuses before any deletion.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../src/util/config.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lb-wipe-hard-'));
}

function buildFakeBrain(home: string): string {
  const brainRoot = join(home, 'brain');
  mkdirSync(join(brainRoot, 'notes', '2026-06'), { recursive: true });
  writeFileSync(join(brainRoot, 'notes', '2026-06', 'note-a.html'), '<article></article>', 'utf8');
  // In-brain _cache (new layout)
  mkdirSync(join(brainRoot, '_cache'), { recursive: true });
  writeFileSync(join(brainRoot, '_cache', 'fts.sqlite'), '', 'utf8');
  return brainRoot;
}

// ---------------------------------------------------------------------------
// Helpers to mock daemon detection
// ---------------------------------------------------------------------------

async function mockDaemonAlive(alive: boolean): Promise<void> {
  // We mock the daemon module imports used by wipe.ts
  const daemonMod = await import('../src/commands/daemon.js');
  vi.spyOn(daemonMod, 'readDaemonPort').mockReturnValue(alive ? 37788 : null);
  vi.spyOn(daemonMod, 'readDaemonPid').mockReturnValue(alive ? 12345 : null);
  vi.spyOn(daemonMod, 'isProcessAlive').mockReturnValue(alive);
  vi.spyOn(daemonMod, 'pingDaemon').mockResolvedValue(alive);
}

describe('runWipe — hardening', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = makeTmpDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfigForTests();
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_CACHE_PATH;
  });

  it('without --yes: throws WIPE_NO_CONFIRM and does NOT delete any files', async () => {
    const brainRoot = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainRoot, '_cache');
    resetConfigForTests();

    await mockDaemonAlive(false);

    const { runWipe } = await import('../src/commands/wipe.js');

    let threw = false;
    try {
      await runWipe({});
    } catch (err) {
      threw = true;
      expect((err as NodeJS.ErrnoException).code).toBe('WIPE_NO_CONFIRM');
    }
    expect(threw).toBe(true);

    // Notes must still exist
    expect(existsSync(join(brainRoot, 'notes', '2026-06', 'note-a.html'))).toBe(true);
  });

  it('without --yes: prints a dry-run summary to stdout', async () => {
    const brainRoot = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainRoot, '_cache');
    resetConfigForTests();

    await mockDaemonAlive(false);

    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    const { runWipe } = await import('../src/commands/wipe.js');

    try {
      await runWipe({});
    } catch {
      // expected
    }

    const written = stdoutSpy.mock.calls.map(([m]) => (typeof m === 'string' ? m : '')).join('');
    expect(written).toMatch(/Would delete/);
    expect(written).toMatch(/Re-run with --yes/);
  });

  it('with --yes on a temp brain: deletes notes and reports correct count', async () => {
    const brainRoot = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainRoot, '_cache');
    resetConfigForTests();

    await mockDaemonAlive(false);

    const { runWipe } = await import('../src/commands/wipe.js');
    const report = await runWipe({ yes: true });

    expect(report.notesDeleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(brainRoot, 'notes', '2026-06', 'note-a.html'))).toBe(false);
    // notes/ directory is recreated
    expect(existsSync(join(brainRoot, 'notes'))).toBe(true);
  });

  it('daemon running: refuses wipe with a daemon-specific error message', async () => {
    const brainRoot = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainRoot, '_cache');
    resetConfigForTests();

    await mockDaemonAlive(true);

    const { runWipe } = await import('../src/commands/wipe.js');

    await expect(runWipe({ yes: true })).rejects.toThrow(/daemon is running/i);

    // Notes must still exist — nothing was deleted
    expect(existsSync(join(brainRoot, 'notes', '2026-06', 'note-a.html'))).toBe(true);
  });
});
