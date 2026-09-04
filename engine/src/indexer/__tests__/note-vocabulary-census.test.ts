/**
 * Coverage for noteVocabularyCensus (note-helpers.ts) — the SQL-only tag/type
 * census that feeds inject-context highlights mode's `[TAGS]` block
 * (sections.ts's buildTagVocabularyBlock).
 *
 * Uses a real, temporary SQLite fixture brain (same pattern as
 * note-read-perf.test.ts) rather than mocks: the whole point of this
 * function is that it is a real `SELECT type, tags FROM notes` against the
 * index, so a mock would not prove the query itself is correct.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-note-vocab-census-test-'));
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
  type: string | null;
  tags: string;
  topic?: string | null;
  valid_until?: string | null;
}

function seedNotes(db: import('better-sqlite3').Database, notes: SeedNote[]): void {
  const insert = db.prepare(`
    INSERT INTO notes
      (id, path, title, type, tags, topic, source, created, importance, valid_from, valid_until, mtime_ms)
    VALUES
      (@id, @path, @title, @type, @tags, @topic, 'test', @created, 1, NULL, @valid_until, @mtime_ms)
  `);
  const tx = db.transaction((rows: SeedNote[]) => {
    for (const n of rows) {
      insert.run({
        id: n.id,
        path: `notes/${n.id}.html`,
        title: n.id,
        type: n.type,
        tags: n.tags,
        topic: n.topic ?? null,
        created: '2026-08-01T00:00:00Z',
        valid_until: n.valid_until ?? null,
        mtime_ms: Date.now(),
      });
    }
  });
  tx(notes);
}

describe('noteVocabularyCensus', () => {
  it('counts distinct types and tags with real populations, sorted descending', async () => {
    const { getDb } = await import('../db.js');
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', type: 'decision', tags: 'auth bug' },
      { id: 'b', type: 'decision', tags: 'auth' },
      { id: 'c', type: 'episodic', tags: 'bug' },
    ]);

    const { types, tags } = noteVocabularyCensus();

    expect(types).toEqual([
      { value: 'decision', count: 2 },
      { value: 'episodic', count: 1 },
    ]);
    expect(tags).toEqual([
      { value: 'auth', count: 2 },
      { value: 'bug', count: 2 },
    ]);
  });

  it('never reports a tag or type with a zero population', async () => {
    const { getDb } = await import('../db.js');
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [{ id: 'a', type: 'decision', tags: '' }]);

    const { types, tags } = noteVocabularyCensus();

    expect(types).toEqual([{ value: 'decision', count: 1 }]);
    expect(tags).toEqual([]);
  });

  it('excludes invalidated notes (valid_until set) from the census', async () => {
    const { getDb } = await import('../db.js');
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', type: 'decision', tags: 'stale', valid_until: '2026-01-01' },
      { id: 'b', type: 'decision', tags: 'fresh' },
    ]);

    const { tags } = noteVocabularyCensus();

    expect(tags).toEqual([{ value: 'fresh', count: 1 }]);
  });

  it('caps the tag list at the given limit, keeping the most frequent first', async () => {
    const { getDb } = await import('../db.js');
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(
      db,
      Array.from({ length: 5 }, (_, i) => ({
        id: `note-${i}`,
        type: 'reference',
        // tag-0 appears 5x, tag-1 4x, ... tag-4 1x
        tags: Array.from({ length: 5 - i }, (_, j) => `tag-${j}`).join(' '),
      })),
    );

    const { tags } = noteVocabularyCensus(undefined, 3);

    expect(tags).toHaveLength(3);
    expect(tags[0]).toEqual({ value: 'tag-0', count: 5 });
    expect(tags[1]).toEqual({ value: 'tag-1', count: 4 });
    expect(tags[2]).toEqual({ value: 'tag-2', count: 3 });
  });

  it('scopes to the given topic (exact match or topic/* prefix), case-insensitively', async () => {
    const { getDb } = await import('../db.js');
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', type: 'decision', tags: 'own-project', topic: 'lazy' },
      { id: 'b', type: 'episodic', tags: 'own-project-sub', topic: 'Lazy/code/typescript' },
      { id: 'c', type: 'reference', tags: 'sibling', topic: 'lazybrain/code' },
      { id: 'd', type: 'reference', tags: 'other', topic: 'trading' },
    ]);

    const { types, tags } = noteVocabularyCensus('lazy');

    expect(types.map((t) => t.value).sort()).toEqual(['decision', 'episodic']);
    expect(tags.map((t) => t.value).sort()).toEqual(['own-project', 'own-project-sub']);
  });

  it('returns an empty census when the brain has no notes', async () => {
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const { types, tags } = noteVocabularyCensus();
    expect(types).toEqual([]);
    expect(tags).toEqual([]);
  });

  it('merges case-variant duplicates into one entry, dominant form + combined count', async () => {
    // Real-brain motivation: CSS attribute selectors (data-cerveau-tags~=)
    // are case-sensitive, but tags are free text — "Lazy" and "lazy" are the
    // SAME concept split into two vocabulary entries. A model that copies
    // the minority-count variant retrieves far fewer notes than exist.
    const { getDb } = await import('../db.js');
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', type: 'decision', tags: 'Lazy' },
      { id: 'b', type: 'decision', tags: 'Lazy' },
      { id: 'c', type: 'decision', tags: 'Lazy' },
      { id: 'd', type: 'episodic', tags: 'lazy' },
    ]);

    const { tags } = noteVocabularyCensus();

    // One merged entry, dominant case form "Lazy" (3 vs 1), combined count 4.
    expect(tags).toEqual([{ value: 'Lazy', count: 4 }]);
  });

  it('merges 3+ case variants of the same tag into one dominant-form entry', async () => {
    const { getDb } = await import('../db.js');
    const { noteVocabularyCensus } = await import('../note-helpers.js');
    const db = getDb();
    seedNotes(db, [
      { id: 'a', type: 'decision', tags: 'TRADING' },
      { id: 'b', type: 'decision', tags: 'trading' },
      { id: 'c', type: 'decision', tags: 'Trading' },
      { id: 'd', type: 'decision', tags: 'Trading' },
      { id: 'e', type: 'decision', tags: 'Trading' },
    ]);

    const { tags } = noteVocabularyCensus();

    // "Trading" (3 occurrences) is the unambiguous dominant form over
    // "trading" (1) and "TRADING" (1); combined count is the sum of all
    // three variants (5).
    expect(tags).toEqual([{ value: 'Trading', count: 5 }]);
  });
});
