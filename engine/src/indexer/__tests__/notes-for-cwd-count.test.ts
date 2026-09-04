/**
 * Coverage for notesForCwdCount (note-helpers.ts) — the `[PROJECT]` block's
 * note count in inject-context highlights mode (sections.ts's
 * appendProjectBlock).
 *
 * Two real bugs fixed here (2026-08-16, measured against a real ~6000-note
 * shared brain — see note-helpers.ts's notesForCwdCount doc comment):
 *   1. The raw `source LIKE '%' || cwd || '%'` compared an un-normalized cwd
 *      (forward-slashed, as passed by inject-context's --cwd flag) against
 *      backslash-separated stored paths on Windows
 *      (`source = "code-scanner:C:\Users\...\Lazy"`), so the match was
 *      ALWAYS empty for every real Windows project — silently falling back
 *      to the brain-wide, LIMIT-300-capped scan and reporting exactly 300
 *      (the LIMIT, not a real count) whenever the brain has more than 300
 *      active notes.
 *   2. A naive separator-only fix would then let cwd "…/lazy" match sibling
 *      project "…/lazybrain" as a bare substring — the boundary check
 *      (containsCwdSegment) guards against that.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-cwd-count-test-'));
  const brainDir = join(tmpDir, 'brain');
  const cachePath = join(tmpDir, 'cache');
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

interface SeedNote {
  id: string;
  source: string;
  type?: string | null;
  tags?: string;
}

function seedNotes(db: import('better-sqlite3').Database, notes: SeedNote[]): void {
  const insert = db.prepare(`
    INSERT INTO notes (id, path, title, type, tags, source, created, importance, valid_from, valid_until, mtime_ms)
    VALUES (@id, @path, @title, @type, @tags, @source, @created, 1, NULL, NULL, @mtime_ms)
  `);
  const tx = db.transaction((rows: SeedNote[]) => {
    for (const n of rows) {
      insert.run({
        id: n.id,
        path: `notes/${n.id}.html`,
        title: n.id,
        type: n.type ?? null,
        tags: n.tags ?? '',
        source: n.source,
        created: '2026-08-01T00:00:00Z',
        mtime_ms: Date.now(),
      });
    }
  });
  tx(notes);
}

describe('notesForCwdCount', () => {
  it('matches a Windows backslash-separated stored source against a forward-slash cwd', async () => {
    const { getDb } = await import('../db.js');
    const { notesForCwdCount } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\Lazy', type: 'file-neuron' },
      { id: 'b', source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\Lazy', type: 'file-neuron' },
    ]);

    const result = notesForCwdCount('C:/Users/user/Documents/cerveau/Lazy');

    expect(result.count).toBe(2);
  });

  it('matches notes recorded under a subdirectory of the cwd', async () => {
    const { getDb } = await import('../db.js');
    const { notesForCwdCount } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\Lazy', type: 'file-neuron' },
      {
        id: 'b',
        source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\Lazy\\engine',
        type: 'file-neuron',
      },
    ]);

    const result = notesForCwdCount('C:/Users/user/Documents/cerveau/Lazy');

    expect(result.count).toBe(2);
  });

  it('does NOT match a sibling project whose name is a bare prefix extension (Lazy vs LazyBrain)', async () => {
    const { getDb } = await import('../db.js');
    const { notesForCwdCount } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\Lazy', type: 'file-neuron' },
      {
        id: 'sibling-1',
        source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\LazyBrain',
        type: 'file-neuron',
      },
      {
        id: 'sibling-2',
        source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\LazySite-internet',
        type: 'file-neuron',
      },
    ]);

    const result = notesForCwdCount('C:/Users/user/Documents/cerveau/Lazy');

    expect(result.count).toBe(1);
  });

  it('is not truncated by an arbitrary row limit for a project with many notes', async () => {
    const { getDb } = await import('../db.js');
    const { notesForCwdCount } = await import('../note-helpers.js');
    const db = getDb();
    // Prior implementation capped the matched-project query at LIMIT 200 —
    // a real project's exact count must not be silently clamped.
    seedNotes(
      db,
      Array.from({ length: 350 }, (_, i) => ({
        id: `note-${i}`,
        source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\Lazy',
        type: 'file-neuron',
      })),
    );

    const result = notesForCwdCount('C:/Users/user/Documents/cerveau/Lazy');

    expect(result.count).toBe(350);
  });

  it('falls back to a brain-wide sample when the cwd matches nothing', async () => {
    const { getDb } = await import('../db.js');
    const { notesForCwdCount } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', source: 'code-scanner:C:\\Users\\user\\Documents\\cerveau\\Trading', type: 'file-neuron' },
    ]);

    const result = notesForCwdCount('C:/Users/user/Documents/cerveau/UnknownProject');

    expect(result.count).toBe(1);
  });
});
