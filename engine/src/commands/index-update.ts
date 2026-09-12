/**
 * Incremental index update command.
 *
 * Compares the SHA/mtime fingerprints of all note files against the stored
 * fingerprint store, then:
 *   - Re-indexes notes whose file changed (indexNote upsert).
 *   - Removes notes that no longer exist on disk (deleteNote).
 *   - Skips unchanged notes entirely.
 *
 * On a 1631-note brain this typically updates < 10 notes in a few seconds,
 * instead of the 15-minute full rebuild that was blocking the Stop hook.
 */

import { existsSync } from 'node:fs';
import { deleteNote, embedNotesForIndex, getDb, indexNote } from '../indexer/fts.js';
import type { IndexedNote } from '../indexer/note-types.js';
import { readAllNotes } from '../store/reader.js';
import {
  type FingerprintStore,
  getChangedFiles,
  getOrphanedFingerprints,
  loadFingerprints,
  recordProcessed,
  saveFingerprints,
} from '../util/fingerprints.js';
import { getLogger } from '../util/logger.js';

export interface IndexUpdateResult {
  indexed: number;
  deleted: number;
  skipped: number;
  failed: number;
  failures: string[];
}

export interface IndexUpdateCliOptions {
  pretty?: boolean;
}

/**
 * Rules version for the FTS text composition produced by indexNote().
 * Bump this when the indexed `text` column's composition changes (e.g.
 * 2026-09: distilled-field injection — tldr/questions/aliases/entities
 * appended to the FTS text in note-index.ts). A mismatch forces ONE full
 * re-index of every note file — file fingerprints are deliberately NOT
 * touched, because the same store also tracks conversation ingestion and
 * discarding it would re-run LLM extraction on every transcript. The
 * re-indexed notes then get re-fingerprinted normally as their rows are
 * rewritten.
 */
const INDEXER_TEXT_VERSION = '2026-09-distilled-v1';

function readIndexerTextVersion(): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM indexer_state WHERE key = 'indexer_text_version'`)
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null; // table may not exist yet on a pre-v12 brain
  }
}

function writeIndexerTextVersion(version: string): void {
  getDb()
    .prepare(
      `INSERT INTO indexer_state (key, value) VALUES ('indexer_text_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(version);
}

/** Error codes / substrings that indicate SQLite file-lock contention. */
const SQLITE_LOCK_PATTERNS = [
  'SQLITE_BUSY',
  'database is locked',
  'disk I/O error',
  'SQLITE_IOERR',
];

function isLockedDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SQLITE_LOCK_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Core incremental update logic.
 *
 * 1. Load fingerprints from disk.
 * 2. Scan all note files on disk.
 * 3. For each file whose fingerprint is missing or stale → re-index.
 * 4. For each file tracked but no longer on disk → delete from index.
 * 5. Persist updated fingerprints.
 */
export async function runIncrementalUpdate(): Promise<IndexUpdateResult> {
  const log = getLogger();
  let store: FingerprintStore = loadFingerprints();

  const allNotes = readAllNotes();
  const allPaths = allNotes.map((n) => n.path);

  // Rules-version gate: when the FTS text composition changed since the
  // last update (see INDEXER_TEXT_VERSION), every note file counts as
  // changed — one forced re-index pass, then the marker is rewritten.
  const textVersionStale = readIndexerTextVersion() !== INDEXER_TEXT_VERSION;
  if (textVersionStale) {
    log.info(
      { stored: readIndexerTextVersion(), current: INDEXER_TEXT_VERSION },
      'index-update: indexer_text_version changed — forcing one full re-index',
    );
  }

  // Determine which files need (re-)indexing
  const changedPaths = new Set(textVersionStale ? allPaths : getChangedFiles(allPaths, store));

  // Determine which tracked paths no longer exist on disk
  const orphanedPaths = getOrphanedFingerprints(store).filter((p) => !existsSync(p));

  let indexed = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  const failures: string[] = [];

  // Delete notes for files that are gone
  for (const orphanPath of orphanedPaths) {
    // Extract the note id from the stored fingerprint's notesCreated list,
    // or fall back to deriving it from the filename.
    const noteIds = store.files[orphanPath]?.notesCreated ?? [];
    const idsToDelete =
      noteIds.length > 0
        ? noteIds
        : [idFromPath(orphanPath)].filter((id): id is string => id !== null);

    for (const id of idsToDelete) {
      try {
        deleteNote(id);
        deleted += 1;
        log.debug({ id, path: orphanPath }, 'incremental: deleted orphaned note');
      } catch (err) {
        failed += 1;
        failures.push(`${orphanPath} (delete ${id}): ${(err as Error).message}`);
      }
    }

    // Remove orphaned entry from fingerprint store (immutable update)
    const { [orphanPath]: _removed, ...remaining } = store.files;
    store = { ...store, files: remaining };
  }

  // Re-index changed and new notes
  const indexedNotes: IndexedNote[] = [];
  for (const note of allNotes) {
    if (!changedPaths.has(note.path)) {
      skipped += 1;
      continue;
    }
    try {
      const result = indexNote(note);
      indexedNotes.push(result);
      store = recordProcessed(note.path, [result.id], store);
      indexed += 1;
      log.debug({ id: note.id, path: note.path }, 'incremental: indexed');
    } catch (err) {
      failed += 1;
      failures.push(`${note.path}: ${(err as Error).message}`);
    }
  }

  saveFingerprints(store);
  if (textVersionStale) writeIndexerTextVersion(INDEXER_TEXT_VERSION);
  log.info({ indexed, deleted, skipped, failed }, 'incremental index update complete');

  // Batch-embed only the notes actually (re)indexed this run — cache-aware
  // and cheap on the common no-op run (indexedNotes is empty, so this
  // returns immediately without touching the embedder). See embed-index.ts.
  await embedNotesForIndex(indexedNotes);

  return { indexed, deleted, skipped, failed, failures };
}

export async function runIndexUpdate(opts: IndexUpdateCliOptions): Promise<string> {
  try {
    const result = await runIncrementalUpdate();
    if (opts.pretty) {
      let out =
        `Incremental update: ${result.indexed} indexed, ${result.deleted} deleted, ` +
        `${result.skipped} skipped, ${result.failed} failed.`;
      if (result.failures.length > 0) {
        out += `\n\nFailures:\n${result.failures.map((f) => `  - ${f}`).join('\n')}`;
      }
      return out;
    }
    return JSON.stringify(result, null, 2);
  } catch (err) {
    if (isLockedDbError(err)) {
      const hint =
        'The SQLite index is locked by another process.\n' +
        'A running `lazybrain serve` or daemon may be holding a write lock.\n' +
        'Stop it first:  lazybrain serve --stop\n' +
        '                lazybrain daemon stop\n' +
        'Then retry:     lazybrain index-update';
      throw new Error(hint, { cause: err });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function idFromPath(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const id = base.replace(/\.html$/, '');
  return id || null;
}
