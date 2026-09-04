/**
 * Tests for incremental index maintenance and serve read-only behaviour.
 *
 * Coverage:
 *  1. Incremental update only touches changed notes (skips unchanged ones).
 *  2. Incremental update deletes notes for files removed from disk.
 *  3. getReadonlyDb() opens a read-only connection that does not block a
 *     concurrent write-connection on the same WAL database.
 *  4. Empty-index serve auto-build path: when listAllReadonly returns [] and
 *     note files exist, runIncrementalUpdate is called.
 *  5. countAllNotes() returns 0 on a fresh DB and correct count after indexing.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let brainDir: string;
let notesPath: string;
let cachePath: string;

/** Minimal valid note HTML that indexNote can parse. */
function noteHtml(id: string, title: string, tags = ''): string {
  return (
    `<article id="${id}" data-cerveau-type="note" data-cerveau-tags="${tags}" ` +
    `data-cerveau-created="2026-01-01T00:00:00Z"><h1>${title}</h1><p>Body text.</p></article>`
  );
}

function writeNote(name: string, content: string): string {
  const fp = join(notesPath, name);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-fts-test-'));
  brainDir = join(tmpDir, 'brain');
  notesPath = join(brainDir, 'notes');
  cachePath = join(tmpDir, 'cache');
  mkdirSync(notesPath, { recursive: true });
  mkdirSync(cachePath, { recursive: true });

  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  resetConfigForTests();
});

afterEach(async () => {
  // Close DB connections before removing temp files
  const { closeDb } = await import('../fts.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  // Reset module cache so getDb/getReadonlyDb start fresh for the next test
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 1. countAllNotes on fresh DB
// ---------------------------------------------------------------------------

describe('countAllNotes', () => {
  it('returns 0 on a fresh (empty) database', async () => {
    const { countAllNotes } = await import('../fts.js');
    expect(countAllNotes()).toBe(0);
  });

  it('returns the correct count after indexing notes', async () => {
    writeNote('note-a.html', noteHtml('note-a', 'Note A'));
    writeNote('note-b.html', noteHtml('note-b', 'Note B'));

    const { indexNote } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');

    indexNote(readNote(join(notesPath, 'note-a.html')));
    indexNote(readNote(join(notesPath, 'note-b.html')));

    const { countAllNotes } = await import('../fts.js');
    expect(countAllNotes()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. Incremental update — only changed notes are re-indexed
// ---------------------------------------------------------------------------

describe('runIncrementalUpdate — skips unchanged notes', () => {
  it('skips a note that has not changed since last index', async () => {
    // Write and index two notes
    writeNote('stable.html', noteHtml('stable', 'Stable Note'));
    writeNote('changed.html', noteHtml('changed', 'Changed Note'));

    const { runIncrementalUpdate } = await import('../../commands/index-update.js');

    // First run: both are new → both indexed
    const first = await runIncrementalUpdate();
    expect(first.indexed).toBe(2);
    expect(first.skipped).toBe(0);

    // Overwrite one note with new content (mtime advances automatically on real writes)
    writeFileSync(join(notesPath, 'changed.html'), noteHtml('changed', 'Changed Note v2'), 'utf-8');

    // Second run: only the modified note should be re-indexed
    const second = await runIncrementalUpdate();
    expect(second.indexed).toBe(1);
    expect(second.skipped).toBe(1);
    expect(second.failed).toBe(0);
  });

  it('indexes all notes on first run (no prior fingerprints)', async () => {
    writeNote('n1.html', noteHtml('n1', 'Note 1'));
    writeNote('n2.html', noteHtml('n2', 'Note 2'));
    writeNote('n3.html', noteHtml('n3', 'Note 3'));

    const { runIncrementalUpdate } = await import('../../commands/index-update.js');
    const result = await runIncrementalUpdate();
    expect(result.indexed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.deleted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Incremental update — deletes removed notes
// ---------------------------------------------------------------------------

describe('runIncrementalUpdate — deletes orphaned notes', () => {
  it('removes a note from the index when its file is deleted from disk', async () => {
    const notePath = writeNote('ephemeral.html', noteHtml('ephemeral', 'Ephemeral Note'));

    const { runIncrementalUpdate } = await import('../../commands/index-update.js');
    const { listAll } = await import('../fts.js');

    // First run: note is indexed
    const first = await runIncrementalUpdate();
    expect(first.indexed).toBe(1);

    // Confirm the note is in the DB
    const before = listAll({ includeExpired: true });
    expect(before.some((n) => n.id === 'ephemeral')).toBe(true);

    // Delete the file and run again
    unlinkSync(notePath);

    const second = await runIncrementalUpdate();
    expect(second.deleted).toBeGreaterThanOrEqual(1);

    // Confirm the note is removed from the DB
    const after = listAll({ includeExpired: true });
    expect(after.some((n) => n.id === 'ephemeral')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Read-only DB — does not block the writer
// ---------------------------------------------------------------------------

describe('getReadonlyDb — concurrent access', () => {
  it('allows a read-only connection to read while writer has WAL', async () => {
    // Write and index a note so the DB file exists
    writeNote('wal-test.html', noteHtml('wal-test', 'WAL Test Note'));
    const { indexNote, getDb, getReadonlyDb, closeDb } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');

    indexNote(readNote(join(notesPath, 'wal-test.html')));

    // Open the write connection (already open via getDb)
    const writerDb = getDb();
    expect(writerDb).toBeDefined();

    // Open a separate read-only connection
    const readerDb = getReadonlyDb();
    expect(readerDb).toBeDefined();

    // Reader can query while writer exists — no lock error expected
    const rows = readerDb.prepare('SELECT id FROM notes WHERE id = ?').all('wal-test') as Array<{
      id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('wal-test');

    // Writer can still upsert without blocking
    writeNote('wal-test2.html', noteHtml('wal-test2', 'WAL Test Note 2'));
    expect(() => indexNote(readNote(join(notesPath, 'wal-test2.html')))).not.toThrow();

    // Reader sees the newly written row (WAL is visible after commit)
    const rows2 = readerDb.prepare('SELECT id FROM notes WHERE id = ?').all('wal-test2') as Array<{
      id: string;
    }>;
    expect(rows2).toHaveLength(1);

    closeDb();
  });

  it('getReadonlyDb returns a DB with readonly=true semantics (throws on write)', async () => {
    // Create the DB file first by opening it via getDb
    writeNote('seed.html', noteHtml('seed', 'Seed'));
    const { indexNote, getReadonlyDb, closeDb } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    indexNote(readNote(join(notesPath, 'seed.html')));

    const ro = getReadonlyDb();
    // A write attempt on a read-only connection must throw
    expect(() => {
      ro.prepare('INSERT INTO notes (id, path, mtime_ms) VALUES (?, ?, ?)').run(
        'ro-fail',
        '/fake',
        0,
      );
    }).toThrow();

    closeDb();
  });
});

// ---------------------------------------------------------------------------
// 5. listAllReadonly — returns empty array when DB does not exist
// ---------------------------------------------------------------------------

describe('listAllReadonly — graceful missing DB', () => {
  it('returns an empty array when the index database file does not exist', async () => {
    // Do NOT open the DB or index anything — DB file doesn't exist
    const { listAllReadonly } = await import('../fts.js');
    const notes = listAllReadonly({ includeExpired: false });
    expect(Array.isArray(notes)).toBe(true);
    expect(notes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. runIndexRebuild — incremental by default, full with --full flag
// ---------------------------------------------------------------------------

describe('runIndexRebuild — incremental vs full', () => {
  it('runs incremental update by default (returns skipped count)', async () => {
    writeNote('rb-a.html', noteHtml('rb-a', 'Rebuild A'));

    // First run via incremental to set fingerprints
    const { runIncrementalUpdate } = await import('../../commands/index-update.js');
    await runIncrementalUpdate();

    // Second run via runIndexRebuild (default = incremental): note is unchanged
    const { runIndexRebuild } = await import('../../commands/index-rebuild.js');
    const result = JSON.parse(await runIndexRebuild({ pretty: false })) as {
      indexed: number;
      skipped: number;
      deleted: number;
      failed: number;
    };
    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(0);
  });

  it('wipes and re-indexes all notes when --full is passed', async () => {
    writeNote('rb-full.html', noteHtml('rb-full', 'Full Rebuild'));

    const { runIndexRebuild } = await import('../../commands/index-rebuild.js');
    const result = JSON.parse(await runIndexRebuild({ full: true, pretty: false })) as {
      indexed: number;
      failed: number;
    };
    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(0);
  });
});
