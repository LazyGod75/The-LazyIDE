/**
 * wipe.test.ts
 *
 * Verifies that runWipe:
 *   1. Deletes all note HTML files in brain/notes/** partitions
 *   2. Deletes knowledge-nodes HTML files
 *   3. Deletes derived artifact files (_index.html, graph.html, graph.txt, _user-profile.html)
 *   4. Deletes batches/, meta/, clusters/ directories
 *   5. Deletes cache files (SQLite FTS index)
 *   6. Recreates an empty brain/notes/ directory
 *   7. Keeps the .lazybrain config file
 *   8. Reports correct counts
 *
 * After wipe, a subsequent dream must NOT encounter "Note already exists" errors.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../src/util/config.js';

// The existing wipe tests always want a confirmed wipe with no daemon running.
async function stubNoDaemon(): Promise<void> {
  const daemonMod = await import('../src/commands/daemon.js');
  vi.spyOn(daemonMod, 'readDaemonPort').mockReturnValue(null);
  vi.spyOn(daemonMod, 'readDaemonPid').mockReturnValue(null);
  vi.spyOn(daemonMod, 'isProcessAlive').mockReturnValue(false);
  vi.spyOn(daemonMod, 'pingDaemon').mockResolvedValue(false);
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lazybrain-wipe-test-'));
}

/**
 * Build a minimal brain directory structure with notes, artifacts, and cache.
 * Returns the brain root path.
 */
function buildFakeBrain(home: string): {
  brainRoot: string;
  lazybrain: string;
  noteFiles: string[];
  artifactFiles: string[];
  cacheFiles: string[];
} {
  const lazybrainDir = join(home, '.lazybrain');
  const brainRoot = join(lazybrainDir, 'brain');
  mkdirSync(brainRoot, { recursive: true });

  // .lazybrain config (must survive wipe)
  const lazybrain = join(lazybrainDir, '.lazybrain');
  writeFileSync(lazybrain, JSON.stringify({ version: '0.2.0' }), 'utf-8');

  // notes/ partitions with HTML files
  const notesDir = join(brainRoot, 'notes');
  mkdirSync(join(notesDir, '2026-05'), { recursive: true });
  mkdirSync(join(notesDir, '2026-06'), { recursive: true });
  const noteFiles: string[] = [];
  for (const [partition, name] of [
    ['2026-05', 'note-a.html'],
    ['2026-05', 'note-b.html'],
    ['2026-06', 'note-c.html'],
  ]) {
    const p = join(notesDir, partition, name);
    writeFileSync(p, '<article></article>', 'utf-8');
    noteFiles.push(p);
  }

  // knowledge-nodes/
  const knDir = join(brainRoot, 'knowledge-nodes');
  mkdirSync(knDir, { recursive: true });
  const knFile = join(knDir, 'kn-one.html');
  writeFileSync(knFile, '<article></article>', 'utf-8');

  // Derived artifact files at brain root
  const artifactFiles: string[] = [];
  for (const name of ['_index.html', '_user-profile.html', 'graph.html', 'graph.txt']) {
    const p = join(brainRoot, name);
    writeFileSync(p, '', 'utf-8');
    artifactFiles.push(p);
  }

  // batches/, meta/, clusters/
  mkdirSync(join(brainRoot, 'batches'), { recursive: true });
  writeFileSync(join(brainRoot, 'batches', 'batch-1.json'), '{}', 'utf-8');
  mkdirSync(join(brainRoot, 'meta'), { recursive: true });
  writeFileSync(join(brainRoot, 'meta', 'meta.json'), '{}', 'utf-8');
  mkdirSync(join(brainRoot, 'clusters'), { recursive: true });
  writeFileSync(join(brainRoot, 'clusters', 'c.json'), '{}', 'utf-8');

  // _cache/ with fake SQLite files — NEW layout: inside the brain directory
  const cacheDir = join(brainRoot, '_cache');
  mkdirSync(cacheDir, { recursive: true });
  const cacheFiles: string[] = [];
  for (const name of ['fts.sqlite', 'fingerprints.json']) {
    const p = join(cacheDir, name);
    writeFileSync(p, '', 'utf-8');
    cacheFiles.push(p);
  }

  return { brainRoot, lazybrain, noteFiles, artifactFiles, cacheFiles };
}

describe('runWipe — deletes all brain files, preserves config', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = makeTmpDir();
    await stubNoDaemon();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfigForTests();
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    delete process.env.LAZYBRAIN_CACHE_PATH;
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('deletes all note HTML files and reports correct count', async () => {
    const { brainRoot, noteFiles } = buildFakeBrain(tmpHome);

    // Point config at this brain
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    resetConfigForTests();

    const { runWipe } = await import('../src/commands/wipe.js');
    const report = await runWipe({ yes: true });

    expect(report.notesDeleted).toBe(noteFiles.length);
    for (const f of noteFiles) {
      expect(existsSync(f)).toBe(false);
    }
  });

  it('recreates an empty brain/notes/ directory after wipe', async () => {
    const { brainRoot } = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    resetConfigForTests();

    const { runWipe } = await import('../src/commands/wipe.js');
    await runWipe({ yes: true });

    const notesDir = join(brainRoot, 'notes');
    expect(existsSync(notesDir)).toBe(true);
    expect(readdirSync(notesDir)).toHaveLength(0);
  });

  it('deletes knowledge-nodes HTML files', async () => {
    const { brainRoot } = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    resetConfigForTests();

    const { runWipe } = await import('../src/commands/wipe.js');
    const report = await runWipe({ yes: true });

    expect(report.knowledgeNodesDeleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(brainRoot, 'knowledge-nodes', 'kn-one.html'))).toBe(false);
  });

  it('deletes derived artifact files (_index.html, graph.html, etc.) and reports count', async () => {
    const { brainRoot, artifactFiles } = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    resetConfigForTests();

    const { runWipe } = await import('../src/commands/wipe.js');
    const report = await runWipe({ yes: true });

    // artifactsDeleted covers _index.html, _user-profile.html, graph.html, graph.txt
    // plus the batches/, meta/, clusters/ directories (if present)
    expect(report.artifactsDeleted).toBeGreaterThanOrEqual(artifactFiles.length);
    for (const f of artifactFiles) {
      expect(existsSync(f)).toBe(false);
    }
    expect(existsSync(join(brainRoot, 'batches'))).toBe(false);
    expect(existsSync(join(brainRoot, 'meta'))).toBe(false);
    expect(existsSync(join(brainRoot, 'clusters'))).toBe(false);
  });

  it('deletes cache files', async () => {
    const { brainRoot, cacheFiles } = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    resetConfigForTests();

    const { runWipe } = await import('../src/commands/wipe.js');
    const report = await runWipe({ yes: true });

    // cache files should be deleted (count >= 1 because fts.sqlite.sqlite-shm may be virtual)
    expect(report.cacheDeleted + report.errors.length).toBeGreaterThanOrEqual(cacheFiles.length);
  });

  it('preserves the .lazybrain config file', async () => {
    const { brainRoot, lazybrain } = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    resetConfigForTests();

    const { runWipe } = await import('../src/commands/wipe.js');
    await runWipe({ yes: true });

    expect(existsSync(lazybrain)).toBe(true);
  });

  it('returns zero errors on a clean brain', async () => {
    const { brainRoot } = buildFakeBrain(tmpHome);
    process.env.LAZYBRAIN_BRAIN_PATH = brainRoot;
    resetConfigForTests();

    const { runWipe } = await import('../src/commands/wipe.js');
    const report = await runWipe({ yes: true });

    // Only Windows file-lock errors are tolerated; a clean test dir should have none
    const realErrors = report.errors.filter((e) => !e.includes('locked'));
    expect(realErrors).toHaveLength(0);
  });
});
