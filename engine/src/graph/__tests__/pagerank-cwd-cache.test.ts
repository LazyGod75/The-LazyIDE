/**
 * Regression tests for notesForCwd()'s cwd-index cache (pagerank.ts).
 *
 * Context: notesForCwd() used to call readAllNotes() — a recursive directory
 * walk reading and parsing EVERY note .html file on disk — on every call.
 * It runs from applyPageRank() (retrieval/rankers.ts) on every L3/L4 query.
 * Measured on a realistic 5488-note/6138-file brain: 670ms-4s PER CALL.
 *
 * This test proves, on a synthetic corpus:
 *   1. Equivalence: the cached notesForCwd() returns EXACTLY the same id set
 *      as a naive reference implementation that re-scans the raw files on
 *      every call (same regex, same normalization, same bidirectional-prefix
 *      match) — no change in search results.
 *   2. Performance: a second call against an unchanged corpus is
 *      dramatically faster than the first (no repeated directory walk).
 *   3. Invalidation: adding a new note file + re-indexing it is picked up by
 *      the very next call (never serves stale seeds).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoteFile } from '../../store/reader.js';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let brainDir: string;
let notesDir: string;

/** Same extraction + matching logic notesForCwd() used to run inline on every
 *  call, reproduced here as an independent reference — NOT a call into
 *  production code — so the equivalence check has something to compare
 *  against that cannot regress silently alongside the cached implementation. */
function naiveNotesForCwd(notes: NoteFile[], cwd: string | undefined | null): string[] {
  if (!cwd) return [];
  const normalized = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (!normalized) return [];
  const ids: string[] = [];
  for (const note of notes) {
    const m = note.html.match(/data-cerveau-cwd\s*=\s*"([^"]+)"/);
    if (!m) continue;
    const candidate = m[1].replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (
      candidate === normalized ||
      normalized.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${normalized}/`)
    ) {
      ids.push(note.id);
    }
  }
  return ids;
}

function writeNoteFile(id: string, cwd: string | null, index: number): void {
  const cwdAttr = cwd ? ` data-cerveau-cwd="${cwd}"` : '';
  const html = `<article id="${id}"${cwdAttr} data-cerveau-tags=""><h1>Note ${index}</h1><p>Body ${index}</p></article>`;
  writeFileSync(join(notesDir, `${id}.html`), html, 'utf8');
}

function insertNoteRow(db: import('better-sqlite3').Database, id: string): void {
  db.prepare(
    `INSERT INTO notes (id, path, title, type, tags, source, created, importance, valid_from, valid_until, mtime_ms)
     VALUES (@id, @path, @title, NULL, '', 'test', @created, 1, NULL, NULL, @mtime_ms)`,
  ).run({
    id,
    path: join(notesDir, `${id}.html`),
    title: id,
    created: new Date().toISOString(),
    mtime_ms: Date.now(),
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-cwd-cache-test-'));
  brainDir = join(tmpDir, 'brain');
  notesDir = join(brainDir, 'notes', '2026-01');
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(join(tmpDir, 'cache'), { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, 'cache');
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../../indexer/db.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
});

describe('notesForCwd() cwd-index cache', () => {
  it('matches the naive per-call reference on exact, parent, and child cwd matches', async () => {
    const { readAllNotes } = await import('../../store/reader.js');
    const { notesForCwd } = await import('../pagerank.js');
    const { getDb } = await import('../../indexer/db.js');
    const db = getDb();

    // note-0: exact same dir. note-1: subdirectory of the query cwd.
    // note-2: parent of the query cwd. note-3: unrelated dir. note-4: no cwd at all.
    writeNoteFile('note-0', 'C:/proj/alpha', 0);
    writeNoteFile('note-1', 'C:/proj/alpha/sub', 1);
    writeNoteFile('note-2', 'C:/proj', 2);
    writeNoteFile('note-3', 'C:/proj/beta', 3);
    writeNoteFile('note-4', null, 4);
    for (const id of ['note-0', 'note-1', 'note-2', 'note-3', 'note-4']) insertNoteRow(db, id);

    const cachedResult = new Set(notesForCwd('C:/proj/alpha'));
    const naiveResult = new Set(naiveNotesForCwd(readAllNotes(), 'C:/proj/alpha'));

    expect(cachedResult).toEqual(naiveResult);
    expect(cachedResult).toEqual(new Set(['note-0', 'note-1', 'note-2']));
  });

  it('a second call against an unchanged corpus is dramatically faster (no repeated directory walk)', async () => {
    const { notesForCwd } = await import('../pagerank.js');
    const { getDb } = await import('../../indexer/db.js');
    const db = getDb();

    // Large enough to make the full-directory-walk cost measurable.
    const COUNT = 600;
    for (let i = 0; i < COUNT; i++) {
      const id = `note-${i}`;
      writeNoteFile(id, i % 3 === 0 ? 'C:/proj/alpha' : 'C:/proj/beta', i);
      insertNoteRow(db, id);
    }

    const coldStart = performance.now();
    const first = notesForCwd('C:/proj/alpha');
    const coldMs = performance.now() - coldStart;

    const warmStart = performance.now();
    for (let i = 0; i < 20; i++) notesForCwd('C:/proj/alpha');
    const warmMs = (performance.now() - warmStart) / 20;

    expect(first.length).toBeGreaterThan(0);
    // Generous margin — the point is "dramatically faster", not a precise ratio.
    expect(warmMs * 10).toBeLessThan(Math.max(coldMs, 1));
  }, 30_000);

  it('invalidates when a new matching note is added and indexed', async () => {
    const { notesForCwd } = await import('../pagerank.js');
    const { getDb } = await import('../../indexer/db.js');
    const db = getDb();

    writeNoteFile('note-a', 'C:/proj/alpha', 0);
    insertNoteRow(db, 'note-a');
    expect(new Set(notesForCwd('C:/proj/alpha'))).toEqual(new Set(['note-a']));

    // Simulate the corpus changing: a new note file is captured and indexed
    // (indexNote() would call bumpLocalWriteVersion(); inserting the row
    // directly here already changes the `notes` table row count, which is
    // itself one of the two independent freshness signals the cache checks).
    writeNoteFile('note-b', 'C:/proj/alpha', 1);
    insertNoteRow(db, 'note-b');

    expect(new Set(notesForCwd('C:/proj/alpha'))).toEqual(new Set(['note-a', 'note-b']));
  });
});
