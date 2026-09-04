/**
 * Regression test for listAllWithText()'s corpus fetch.
 *
 * Context: a diagnostic on a realistic 5881-note/324 MB brain measured
 * turn-mode recall (`/_api/recall`, the per-assistant-turn memory pipeline)
 * taking 40-177s from a fresh sidecar process vs. 0.6-1s once warm, growing
 * with corpus size. Root cause: `listAllWithText()` (this module) used to
 * run `notes LEFT JOIN notes_fts ON fts.id = n.id` — `notes_fts.id` is
 * declared UNINDEXED in the FTS5 virtual table (see schema.ts), so SQLite
 * has no B-tree it can use for that equality lookup and instead re-scans
 * the ENTIRE notes_fts virtual table once per `notes` row ("SCAN fts
 * VIRTUAL TABLE ... LEFT-JOIN" per EXPLAIN QUERY PLAN). Measured on the
 * real brain: ~230s for that single query. Because the in-process
 * `withTextCache` (corpus-cache.ts) only caches the RESULT per sidecar
 * process, that cost landed in full on whichever query ran first — exactly
 * the measured cold/first-turn penalty.
 *
 * The fix replaces the join with two independent, index-friendly scans
 * (`notes`, `notes_fts`) merged via a plain in-memory Map — same output,
 * no per-row cross-table lookup. This test proves the fix on a large
 * synthetic corpus: it times the RETIRED join shape as a local reference
 * query (not a call into production code — that code no longer exists) and
 * asserts the current `listAllWithText()` is both dramatically faster in
 * relative terms and fast in absolute terms.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;
let brainDir: string;
let cachePath: string;

/** Large enough to make the retired JOIN shape's cost obvious (seconds, not
 *  ms) without making the test suite itself slow. */
const CORPUS_SIZE = 1200;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-note-read-perf-test-'));
  brainDir = join(tmpDir, 'brain');
  cachePath = join(tmpDir, 'cache');
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  mkdirSync(cachePath, { recursive: true });

  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../db.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
});

/** Populate `notes` + `notes_fts` directly via SQL (bypassing the full
 *  HTML-note indexing pipeline, which is unnecessary to exercise this
 *  purely SQL-level regression and would make the test far slower). */
function seedSyntheticCorpus(db: import('better-sqlite3').Database, count: number): void {
  const insertNote = db.prepare(`
    INSERT INTO notes
      (id, path, title, type, tags, source, created, importance, valid_from, valid_until, mtime_ms)
    VALUES
      (@id, @path, @title, @type, @tags, @source, @created, @importance, @valid_from, @valid_until, @mtime_ms)
  `);
  const insertFts = db.prepare(`
    INSERT INTO notes_fts (id, title, text, tags) VALUES (@id, @title, @text, @tags)
  `);
  const insertAll = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `note-${i}`;
      insertNote.run({
        id,
        path: `notes/2026-01/note-${i}.html`,
        title: `Note ${i}`,
        type: 'note',
        tags: '',
        source: 'test',
        created: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        importance: 1,
        valid_from: null,
        valid_until: null,
        mtime_ms: Date.now(),
      });
      // Realistic-ish body size (~1 KB) — the retired JOIN's cost scales
      // with content size too (FTS5 must decode each candidate row's
      // stored text during the repeated scan), not just row count.
      insertFts.run({
        id,
        title: `Note ${i}`,
        text: `Body text for note ${i}. `.repeat(40),
        tags: '',
      });
    }
  });
  insertAll();

  // One note deliberately left WITHOUT a matching notes_fts row, so the test
  // also covers the documented "FTS row missing -> falls back to ''"
  // fallback (an FTS sync issue must never crash retrieval).
  db.prepare(
    `
    INSERT INTO notes
      (id, path, title, type, tags, source, created, importance, valid_from, valid_until, mtime_ms)
    VALUES
      ('note-missing-fts', 'notes/2026-01/note-missing-fts.html', 'Missing FTS', 'note', '', 'test', @created, 1, NULL, NULL, @mtime_ms)
  `,
  ).run({ created: new Date(2026, 0, 2).toISOString(), mtime_ms: Date.now() });
}

describe('listAllWithText perf regression (no more notes/notes_fts JOIN)', () => {
  // Explicit generous timeout (default is 5s): the reference JOIN query
  // below is DELIBERATELY slow (that is the entire point of this test) and
  // can take several seconds on a loaded CI worker running many suites in
  // parallel.
  it('is correct and dramatically faster than the retired JOIN shape on a large corpus', async () => {
    const { getDb } = await import('../db.js');
    const db = getDb();
    seedSyntheticCorpus(db, CORPUS_SIZE);

    // Reference timing only: the EXACT shape listAllWithText() used to run,
    // reproduced here as a local query so this test does not depend on the
    // retired code still existing anywhere.
    const joinStart = Date.now();
    const joinRows = db
      .prepare(
        `
        SELECT n.*, COALESCE(fts.text, '') AS text
        FROM notes n
        LEFT JOIN notes_fts fts ON fts.id = n.id
        WHERE (n.valid_until IS NULL OR n.valid_until = '')
        ORDER BY n.created DESC
      `,
      )
      .all() as Array<{ id: string; text: string }>;
    const joinMs = Date.now() - joinStart;

    const { listAllWithText } = await import('../note-read.js');
    const fixedStart = Date.now();
    const result = listAllWithText();
    const fixedMs = Date.now() - fixedStart;

    // --- Correctness: same rows, text correctly attached per note. ---
    expect(joinRows.length).toBe(CORPUS_SIZE + 1);
    expect(result.length).toBe(CORPUS_SIZE + 1);
    const sample = result.find((n) => n.id === 'note-42');
    expect(sample?.text).toContain('Body text for note 42.');
    // Defensive fallback: a note with no matching notes_fts row gets '',
    // never undefined/null and never a crash.
    const missingFts = result.find((n) => n.id === 'note-missing-fts');
    expect(missingFts?.text).toBe('');

    // --- Performance: the fix must be fast in both absolute and relative terms. ---
    // Generous absolute ceiling — measured well under 100ms on this corpus
    // size outside of CI contention; 2000ms leaves ample headroom for a
    // loaded CI worker without weakening the regression signal.
    expect(fixedMs).toBeLessThan(2000);
    // The retired JOIN shape must be at least 5x slower on this corpus —
    // if this ever fails, the JOIN itself got fast again (e.g. a future
    // SQLite/FTS5 change), which is worth noticing on its own.
    expect(fixedMs * 5).toBeLessThan(joinMs);
  }, 60_000);
});
