/**
 * Tests for upsert.ts's richer-body rule and writeNote()'s upsertIfRicher
 * integration — the fix for mission-completion captures silently losing to
 * the sparse kickoff note sharing the same id (see this file's siblings for
 * the full root-cause story: dream.ts's hasNoiseExemptTag, repair.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRicherBody, mergeUpsertHtml } from '../upsert.js';
import { writeNote } from '../writer.js';

function note(id: string, created: string, bodyText: string): string {
  return `<article id="${id}" data-cerveau-version="0.1.0" data-cerveau-created="${created}" data-cerveau-updated="${created}" data-cerveau-type="episodic" data-cerveau-source="test" data-cerveau-tier="working" data-cerveau-importance="0.6" data-cerveau-tags="agent mission">
  <h2>${id}</h2>
  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">${bodyText}</p>
</article>`;
}

describe('isRicherBody', () => {
  it('is true when the candidate has strictly more words than the existing note', () => {
    const existing = note('m1', '2026-01-01T00:00:00Z', 'Modele GPT Worktree wt agent');
    const candidate = note(
      'm1',
      '2026-01-01T00:00:00Z',
      'Mission completed with verdict approved and a much longer detailed summary of everything that happened during the run',
    );
    expect(isRicherBody(existing, candidate)).toBe(true);
  });

  it('is false when the candidate has the same word count (ties never replace)', () => {
    const existing = note('m1', '2026-01-01T00:00:00Z', 'one two three four five');
    const candidate = note('m1', '2026-01-01T00:00:00Z', 'six seven eight nine ten');
    expect(isRicherBody(existing, candidate)).toBe(false);
  });

  it('is false when the candidate is shorter (never downgrades)', () => {
    const existing = note(
      'm1',
      '2026-01-01T00:00:00Z',
      'a long rich completion note with verdict approved and full timeline details included here',
    );
    const candidate = note('m1', '2026-01-01T00:00:00Z', 'Modele GPT Worktree wt');
    expect(isRicherBody(existing, candidate)).toBe(false);
  });
});

describe('mergeUpsertHtml', () => {
  it('preserves the EXISTING data-cerveau-created and refreshes data-cerveau-updated', () => {
    const existing = note('m1', '2026-01-01T09:00:00Z', 'sparse kickoff');
    const candidate = note(
      'm1',
      '2026-01-01T18:00:00Z',
      'rich completion body with lots more detail',
    );
    const merged = mergeUpsertHtml(existing, candidate, '2026-01-01T18:05:00Z');

    expect(merged).toContain('data-cerveau-created="2026-01-01T09:00:00Z"');
    expect(merged).toContain('data-cerveau-updated="2026-01-01T18:05:00Z"');
    expect(merged).toContain('rich completion body with lots more detail');
  });
});

describe('writeNote upsertIfRicher', () => {
  let brainDir: string;

  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'lazybrain-upsert-test-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  });

  afterEach(async () => {
    // writeNote() now consults the SQLite index (resolveExistingNoteLocation
    // in writer.ts, for the regenerated-note fix) even when the test never
    // calls indexNote() itself — that lazily opens and caches a DB
    // connection (indexer/db.ts's getDb()). On Windows, an open handle to
    // _cache/fts.sqlite makes the rmSync below fail with EBUSY, so close it
    // first, same as structural.test.ts / reindex-missing.test.ts do.
    const { closeDb } = await import('../../indexer/db.js');
    closeDb();
    delete process.env.LAZYBRAIN_BRAIN_PATH;
    if (existsSync(brainDir)) rmSync(brainDir, { recursive: true, force: true });
  });

  it('replaces the body and preserves created when the candidate is richer', () => {
    const sparse = note(
      'mission-fix-bug',
      '2026-02-01T00:00:00Z',
      'Modele Sonnet Worktree wt slash fix',
    );
    const first = writeNote(sparse);
    expect(first.unchanged).toBeUndefined();

    const rich = note(
      'mission-fix-bug',
      '2026-02-01T12:00:00Z', // candidate's own (wrong) created — must be overridden
      'Learning insights three generated mission completed verdict approved score ninety detailed summary of the whole run',
    );
    const second = writeNote(rich, { upsertIfRicher: true });

    expect(second.unchanged).toBeUndefined();
    expect(second.path).toBe(first.path);
    const onDisk = readFileSync(second.path, 'utf-8');
    expect(onDisk).toContain('data-cerveau-created="2026-02-01T00:00:00Z"');
    expect(onDisk).toContain('Learning insights three generated');
    expect(onDisk).not.toContain('Modele Sonnet Worktree wt slash fix');
  });

  it('is a no-op and reports unchanged when the candidate is not richer', () => {
    const rich = note(
      'mission-fix-bug-2',
      '2026-02-01T00:00:00Z',
      'Learning insights three generated mission completed verdict approved score ninety detailed summary of the whole run',
    );
    const first = writeNote(rich);

    const sparseRetry = note(
      'mission-fix-bug-2',
      '2026-02-01T12:00:00Z',
      'Modele Sonnet Worktree wt',
    );
    const second = writeNote(sparseRetry, { upsertIfRicher: true });

    expect(second.unchanged).toBe(true);
    const onDisk = readFileSync(first.path, 'utf-8');
    expect(onDisk).toContain('Learning insights three generated');
    expect(onDisk).toContain('data-cerveau-created="2026-02-01T00:00:00Z"');
  });

  it('still throws ConflictError on a plain duplicate write with no upsertIfRicher/overwrite', () => {
    const html = note(
      'mission-fix-bug-3',
      '2026-02-01T00:00:00Z',
      'Modele Sonnet Worktree wt fix bug',
    );
    writeNote(html);
    expect(() => writeNote(html)).toThrow(/already exists/i);
  });
});
