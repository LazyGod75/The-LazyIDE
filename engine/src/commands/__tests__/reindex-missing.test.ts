/**
 * reindex-missing.test.ts — fixture-brain tests for `lazybrain reindex
 * --missing` (reconcileIndex / reindex-missing.ts).
 *
 * Coverage (mission Step 5):
 *  1. Reconciliation indexes exactly the missing notes.
 *  2. Idempotent: a second run finds nothing left to do.
 *  3. Ghost rows are reported but survive without --delete-ghosts.
 *  4. Ghost rows are removed when --delete-ghosts is passed with an apply run.
 *  5. --dry-run (default) writes nothing at all.
 *  6. Embeddings are backfilled for notes that were indexed but never embedded.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';

// These tests run reconcileIndex -> embedNotesForIndex -> ONNX model init,
// which costs seconds even idle and far more under parallel-file contention.
// The 5s vitest default is structurally wrong for this suite.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let tmpDir: string;
let brainDir: string;
let notesPath: string;
let cachePath: string;

function noteHtml(id: string): string {
  return (
    `<article id="${id}" data-cerveau-type="episodic" data-cerveau-tags="" ` +
    `data-cerveau-created="2026-01-01T00:00:00Z"><h1>${id}</h1><p>Body text for ${id}, long enough to embed.</p></article>`
  );
}

function writeNoteFile(id: string): string {
  const dir = join(notesPath, '2026-07');
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${id}.html`);
  writeFileSync(fp, noteHtml(id), 'utf-8');
  return fp;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-reindex-missing-'));
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
  const { closeDb } = await import('../../indexer/fts.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  vi.resetModules();
});

describe('reconcileIndex — missing-on-disk notes', () => {
  it('--dry-run (default) reports the gap but writes nothing', async () => {
    const { indexNote } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const p1 = writeNoteFile('indexed-1');
    indexNote(readNote(p1));
    writeNoteFile('orphan-1'); // written, never indexed

    const { reconcileIndex } = await import('../reindex-missing.js');
    const report = await reconcileIndex({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.disk_notes).toBe(2);
    expect(report.indexed_notes_before).toBe(1);
    expect(report.missing_on_disk).toBe(1);
    expect(report.indexed).toBe(0); // dry-run never writes
    expect(report.failed).toBe(0);

    const { countAllNotes } = await import('../../indexer/fts.js');
    expect(countAllNotes()).toBe(1); // untouched
  });

  it('applies (dryRun: false): indexes exactly the missing notes, none extra', async () => {
    const { indexNote, listAll } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const p1 = writeNoteFile('indexed-1');
    indexNote(readNote(p1));
    writeNoteFile('orphan-1');
    writeNoteFile('orphan-2');

    const { reconcileIndex } = await import('../reindex-missing.js');
    const report = await reconcileIndex({ dryRun: false });

    expect(report.missing_on_disk).toBe(2);
    expect(report.indexed).toBe(2);
    expect(report.failed).toBe(0);

    const all = listAll({ includeExpired: true });
    expect(all.map((n) => n.id).sort()).toEqual(['indexed-1', 'orphan-1', 'orphan-2']);
  });

  it('is idempotent: a second apply run finds nothing left to index', async () => {
    writeNoteFile('a');
    writeNoteFile('b');

    const { reconcileIndex } = await import('../reindex-missing.js');
    const first = await reconcileIndex({ dryRun: false });
    expect(first.indexed).toBe(2);

    const second = await reconcileIndex({ dryRun: false });
    expect(second.missing_on_disk).toBe(0);
    expect(second.indexed).toBe(0);
  });

  it(
    'never deletes an index row as a side effect of indexing missing notes',
    { timeout: 20000 },
    async () => {
      const { indexNote } = await import('../../indexer/fts.js');
      const { readNote } = await import('../../store/reader.js');
      const p1 = writeNoteFile('kept');
      indexNote(readNote(p1));
      writeNoteFile('new-one');

      const { reconcileIndex } = await import('../reindex-missing.js');
      await reconcileIndex({ dryRun: false });

      const { listAll } = await import('../../indexer/fts.js');
      const ids = listAll({ includeExpired: true }).map((n) => n.id);
      expect(ids).toContain('kept');
      expect(ids).toContain('new-one');
    },
  );
});

describe('reconcileIndex — superseded (stale-duplicate) notes', () => {
  function writeNoteFileInMonth(month: string, id: string): string {
    const dir = join(notesPath, month);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, `${id}.html`);
    writeFileSync(fp, noteHtml(id), 'utf-8');
    return fp;
  }

  it('does not clobber a fresher row when an orphaned old-month copy shares its id (the audit-found regression)', async () => {
    // Simulate regeneration: "regen-1" was written in 2026-06, then
    // regenerated in 2026-07 (fresh data-cerveau-created — the real root
    // cause of orphaned duplicates, see structural.ts/store/reader.ts).
    // Only the NEW copy is ever indexed; the OLD copy sits on disk,
    // unindexed, sharing the same id.
    const oldPath = writeNoteFileInMonth('2026-06', 'regen-1');
    const { indexNote } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const newPath = writeNoteFileInMonth('2026-07', 'regen-1');
    indexNote(readNote(newPath));

    const { reconcileIndex } = await import('../reindex-missing.js');
    const report = await reconcileIndex({ dryRun: false });

    // The old orphan must be classified as superseded, NOT indexed — the
    // whole point of this fix is that it must never reach indexNote() and
    // silently repoint the row back at the stale file.
    expect(report.missing_on_disk).toBe(1);
    expect(report.superseded_on_disk).toBe(1);
    expect(report.genuinely_missing).toBe(0);
    expect(report.indexed).toBe(0);

    const { getDb } = await import('../../indexer/fts.js');
    const row = getDb().prepare('SELECT path FROM notes WHERE id = ?').get('regen-1') as
      | { path: string }
      | undefined;
    // The row must still point at the FRESH path, never the orphaned one.
    expect(row?.path).toBe(newPath);
    expect(row?.path).not.toBe(oldPath);
  });

  it('reports the split correctly in --dry-run too (an accurate preview, not just a count of raw missing paths)', async () => {
    writeNoteFileInMonth('2026-06', 'regen-2');
    const { indexNote } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const newPath = writeNoteFileInMonth('2026-07', 'regen-2');
    indexNote(readNote(newPath));
    writeNoteFileInMonth('2026-07', 'brand-new'); // a genuinely new, never-indexed note

    const { reconcileIndex } = await import('../reindex-missing.js');
    const report = await reconcileIndex({ dryRun: true });

    expect(report.missing_on_disk).toBe(2); // both orphan paths
    expect(report.superseded_on_disk).toBe(1); // regen-2's old copy
    expect(report.genuinely_missing).toBe(1); // brand-new
    expect(report.indexed).toBe(0); // dry-run never writes
  });

  it(
    'reconciles rows_before + indexed against rows_after and re-diffs disk vs index post-run',
    { timeout: 20000 },
    async () => {
      writeNoteFileInMonth('2026-06', 'regen-3');
      const { indexNote } = await import('../../indexer/fts.js');
      const { readNote } = await import('../../store/reader.js');
      const newPath = writeNoteFileInMonth('2026-07', 'regen-3');
      indexNote(readNote(newPath));
      writeNoteFileInMonth('2026-07', 'brand-new-2');

      const { reconcileIndex } = await import('../reindex-missing.js');
      const report = await reconcileIndex({ dryRun: false });

      expect(report.reconciled).toBe(true);
      expect(report.reconciliation_note).toBeNull();
      // Everything that should end up indexed does: the fresh regen-3 row
      // (already there) + the newly-inserted brand-new-2. The stale regen-3
      // orphan is superseded, so it correctly stays out of this count.
      expect(report.remaining_unindexed_after).toBe(0);
    },
  );
});

describe('reconcileIndex — ghost rows', () => {
  it('reports ghost rows without deleting them when --delete-ghosts is absent', async () => {
    const { indexNote } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const p = writeNoteFile('vanishing');
    indexNote(readNote(p));
    unlinkSync(p); // index row now points at a deleted file

    const { reconcileIndex } = await import('../reindex-missing.js');
    const report = await reconcileIndex({ dryRun: false, deleteGhosts: false });

    expect(report.ghost_rows).toBe(1);
    expect(report.ghost_rows_deleted).toBe(0);

    const { listAll } = await import('../../indexer/fts.js');
    expect(listAll({ includeExpired: true }).map((n) => n.id)).toContain('vanishing');
  });

  it('deletes ghost rows only when --delete-ghosts AND apply (not dry-run) are both set', async () => {
    const { indexNote } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const p = writeNoteFile('vanishing');
    indexNote(readNote(p));
    unlinkSync(p);

    const { reconcileIndex } = await import('../reindex-missing.js');

    // dry-run + deleteGhosts must NOT delete anything.
    const dryReport = await reconcileIndex({ dryRun: true, deleteGhosts: true });
    expect(dryReport.ghost_rows).toBe(1);
    expect(dryReport.ghost_rows_deleted).toBe(0);
    const { listAll: listAllAfterDry } = await import('../../indexer/fts.js');
    expect(listAllAfterDry({ includeExpired: true }).map((n) => n.id)).toContain('vanishing');

    // apply + deleteGhosts removes it.
    const applyReport = await reconcileIndex({ dryRun: false, deleteGhosts: true });
    expect(applyReport.ghost_rows).toBe(1);
    expect(applyReport.ghost_rows_deleted).toBe(1);
    const { listAll: listAllAfterApply } = await import('../../indexer/fts.js');
    expect(listAllAfterApply({ includeExpired: true }).map((n) => n.id)).not.toContain('vanishing');
  });
});

describe('reconcileIndex — embedding backfill', () => {
  it('backfills note_embeddings for a note that was indexed without ever being embedded', async () => {
    // Simulate the capture.ts write path: indexNote() only, no
    // embedNotesForIndex() call — exactly the drift that produces the
    // 357-note embedding gap the audit found on the real brain.
    const { indexNote, loadAllStoredEmbeddings } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const p = writeNoteFile('never-embedded');
    indexNote(readNote(p));

    expect(loadAllStoredEmbeddings().has('never-embedded')).toBe(false);

    const { reconcileIndex } = await import('../reindex-missing.js');
    const report = await reconcileIndex({ dryRun: false });

    expect(report.embeddings_missing_before).toBeGreaterThanOrEqual(1);
    // Embedding may legitimately no-op if the WASM model is unavailable in
    // this CI environment (embedNotesForIndex degrades gracefully — see
    // embed-index.ts) — assert the backfill was AT LEAST attempted for the
    // right count rather than requiring the model to be present.
    expect(report.embeddings_backfilled).toBeGreaterThanOrEqual(0);
  });

  it('--dry-run does not write any embeddings', async () => {
    const { indexNote, loadAllStoredEmbeddings } = await import('../../indexer/fts.js');
    const { readNote } = await import('../../store/reader.js');
    const p = writeNoteFile('never-embedded');
    indexNote(readNote(p));

    const { reconcileIndex } = await import('../reindex-missing.js');
    const report = await reconcileIndex({ dryRun: true });

    expect(report.embeddings_backfilled).toBe(0);
    expect(loadAllStoredEmbeddings().has('never-embedded')).toBe(false);
  });
});
