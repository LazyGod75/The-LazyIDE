/**
 * `lazybrain reindex --missing` — idempotent disk-vs-index reconciliation.
 *
 * Background: several write paths persist a note's HTML to disk without
 * ever indexing it (see dream.ts's conversation-ingestion path and
 * synthesize.ts, both fixed alongside this command) or index it but swallow
 * a failure with only a log line (graph.ts's code-scan/aggregate notes,
 * conv-file-enrichment.ts's concept notes) — and nothing ever automatically
 * reconciles the SQLite `notes` table against the note files actually on
 * disk. Once a note is orphaned this way it stays invisible to L2 (FTS) and
 * L3 (embeddings) forever, and it also means structural.ts's
 * indexIsTrustworthy() count check permanently fails, silently downgrading
 * every structural query to a full O(corpus) scan (see structural.ts).
 *
 * This command is the general-purpose repair for that class of drift. It is
 * DIFF-based, not fingerprint-based (contrast with index-update.ts's
 * runIncrementalUpdate, which trusts a separate .fingerprints.json cache and
 * therefore never re-examines a path it once believed it had processed):
 *
 *   1. missing-on-disk: `.html` files under notes/+batches/ that have no row
 *      AT THAT PATH in `notes`. Split further into two disjoint cases (see
 *      classifyMissingPaths()):
 *        a. genuinely missing — the note's id has NO row anywhere → inserted
 *           (insert-only; never deletes a row as a side effect).
 *        b. superseded — the note's id ALREADY has a row, just at a
 *           DIFFERENT (newer) path. This is a STALE DUPLICATE, not a
 *           failure: regeneration (synthesize.ts/graph.ts/etc.) always
 *           stamps `data-cerveau-created` with "now", so once the calendar
 *           month rolls over between two regenerations of the same id, the
 *           previous file is orphaned on disk forever (see
 *           store/reader.ts's distinctNoteIdSlugsCached() doc comment).
 *           These are deliberately NEVER passed to indexNote(): that
 *           function upserts by id with `ON CONFLICT(id) DO UPDATE SET
 *           path=...` (note-index.ts), so blindly reindexing a stale
 *           duplicate would silently REPOINT the canonical row at the OLD
 *           file and overwrite its content with the stale version — a
 *           regression, not a repair. Reported under `superseded_on_disk`
 *           instead. No file is ever deleted by this command.
 *   2. embedding gap: notes present in `notes` but absent from
 *      `note_embeddings` → backfilled via the same embedNotesForIndex() pass
 *      index-time indexing already uses.
 *   3. ghost rows: rows in `notes` whose file no longer exists on disk →
 *      always reported; deleted only when --delete-ghosts is passed
 *      alongside a non-dry-run invocation (never an implicit side effect of
 *      the other two phases).
 *
 * Idempotent and resumable by construction: every phase re-derives its
 * candidate set from the CURRENT live state of disk + SQLite on each call
 * (no separate checkpoint file to go stale or desync), so re-running after
 * an interruption (crash, Ctrl-C, OOM — the exact hazard that created this
 * drift in the first place) simply picks up whatever is still missing.
 * Batched with a small per-batch size (default 200) so a run over
 * thousands of notes never holds the whole corpus's parsed HTML in memory
 * at once, and the embedding pass underneath already internally chunks to
 * EMBED_BATCH_SIZE=8 ONNX inputs (see embeddings.ts) regardless of how many
 * notes a single batch here hands to it — the batching here exists for
 * progress visibility and bounded memory, not to re-solve the OOM fix that
 * already lives in embeddings.ts.
 *
 * --dry-run (default: true) never writes anything, but DOES read every
 * missing file's content to classify it as genuinely-missing vs. superseded
 * — a preview that couldn't tell the two apart would just repeat the bug
 * this command exists to fix. Only the indexNote()/embedNotesForIndex()
 * writes themselves are gated on `!dryRun`.
 *
 * The report reconciles its own arithmetic (rows_before + indexed -
 * ghost_rows_deleted must equal rows_after) and re-diffs disk vs. index
 * after the run so a caller never has to trust a bare "success" claim — see
 * `reconciled` / `remaining_unindexed_after` on ReindexMissingReport.
 */

import { existsSync } from 'node:fs';
import {
  deleteNote,
  embedNotesForIndex,
  getDb,
  indexNote,
  listAllWithText,
  loadAllStoredEmbeddings,
} from '../indexer/fts.js';
import type { IndexedNote } from '../indexer/note-types.js';
import { type NoteFile, listAllNotePaths, readNote } from '../store/reader.js';
import { getLogger } from '../util/logger.js';

const DEFAULT_BATCH_SIZE = 200;

export interface ReindexMissingOptions {
  /** Preview only — no writes. Default: true (safe default). */
  dryRun?: boolean;
  /** Also delete index rows whose file no longer exists on disk. Default: false. */
  deleteGhosts?: boolean;
  /** Notes processed per indexing/embedding batch. Default: 200. */
  batchSize?: number;
}

export interface ReindexMissingReport {
  dryRun: boolean;
  disk_notes: number;
  indexed_notes_before: number;
  missing_on_disk: number;
  /** Missing-on-disk paths that are stale duplicates of an id already indexed under a different path — NOT a failure. See module doc comment. */
  superseded_on_disk: number;
  /** Missing-on-disk paths whose id has no row anywhere yet — the actual insert candidates. */
  genuinely_missing: number;
  indexed: number;
  failed: number;
  failures: string[];
  ghost_rows: number;
  ghost_rows_deleted: number;
  embeddings_missing_before: number;
  embeddings_backfilled: number;
  /** SQLite `notes` row count after this run (== indexed_notes_before for a dry-run). */
  indexed_notes_after: number;
  /** Post-run re-diff: distinct on-disk ids that STILL have no matching row. Should be 0 after a clean apply run. */
  remaining_unindexed_after: number;
  /** rows_before + indexed - ghost_rows_deleted === rows_after. False means the run's own bookkeeping doesn't add up — see reconciliation_note. */
  reconciled: boolean;
  reconciliation_note: string | null;
  duration_ms: number;
}

interface IndexedRow {
  id: string;
  path: string;
}

interface SupersededEntry {
  id: string;
  path: string;
  supersededByPath: string;
}

interface ClassifiedMissing {
  /** One NoteFile per genuinely-new id — the only candidates ever passed to indexNote(). */
  toIndex: NoteFile[];
  superseded: SupersededEntry[];
  /** Paths that could not even be read/parsed enough to determine their id. */
  readFailures: string[];
  /** ids of every readable missing-path note, used to re-diff disk vs. index after the run. */
  allMissingIds: Set<string>;
}

/** Read every (id, path) currently in the SQLite `notes` table — the SQL side of the diff. */
function readIndexedRows(): IndexedRow[] {
  const db = getDb();
  return db.prepare('SELECT id, path FROM notes').all() as IndexedRow[];
}

/**
 * Split `missingPaths` (files with no row at that exact path) into
 * genuinely-new ids to index vs. stale duplicates to leave alone. See the
 * module doc comment's phase-1 description for why superseded paths must
 * never reach indexNote().
 *
 * Reads every missing path's content (readNote) to learn its real id —
 * unavoidable: the on-disk filename is only a lossy slug, and classification
 * requires knowing whether that id already has a row. This runs regardless
 * of dry-run, since an accurate preview is the whole point of this fix.
 */
function classifyMissingPaths(
  missingPaths: readonly string[],
  indexedRowsBefore: readonly IndexedRow[],
  log: ReturnType<typeof getLogger>,
): ClassifiedMissing {
  const indexedPathById = new Map(indexedRowsBefore.map((r) => [r.id, r.path]));
  const readFailures: string[] = [];
  const byId = new Map<string, NoteFile[]>();

  for (const path of missingPaths) {
    let note: NoteFile;
    try {
      note = readNote(path);
    } catch (err) {
      const msg = (err as Error).message;
      readFailures.push(`${path}: ${msg}`);
      log.warn({ path, err: msg }, 'reindex --missing: failed to read for classification');
      continue;
    }
    if (!note.id) {
      readFailures.push(`${path}: no <article id> found — cannot classify`);
      continue;
    }
    const bucket = byId.get(note.id);
    if (bucket) bucket.push(note);
    else byId.set(note.id, [note]);
  }

  const toIndex: NoteFile[] = [];
  const superseded: SupersededEntry[] = [];

  for (const [id, files] of byId) {
    const existingPath = indexedPathById.get(id);
    if (existingPath) {
      // Already indexed under a different path — every orphan copy for this
      // id is a stale duplicate superseded by the indexed one.
      for (const f of files) superseded.push({ id, path: f.path, supersededByPath: existingPath });
      continue;
    }
    // Never indexed under ANY path yet. If more than one orphan copy exists
    // for this id (regeneration ran more than once before the first-ever
    // index), keep only the newest by mtime as the insert candidate; the
    // rest are superseded by it.
    const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
    const [winner, ...losers] = sorted;
    toIndex.push(winner);
    for (const loser of losers) {
      superseded.push({ id, path: loser.path, supersededByPath: winner.path });
    }
  }

  return { toIndex, superseded, readFailures, allMissingIds: new Set(byId.keys()) };
}

/**
 * Index one batch of already-read, genuinely-new NoteFiles, returning the
 * freshly-indexed notes so the caller can immediately batch-embed them
 * (avoids a second full pass over the same notes just to find embedding
 * candidates).
 */
function indexBatch(
  notes: readonly NoteFile[],
  log: ReturnType<typeof getLogger>,
): { indexed: IndexedNote[]; failed: number; failures: string[] } {
  const indexed: IndexedNote[] = [];
  const failures: string[] = [];
  for (const note of notes) {
    try {
      const result = indexNote(note);
      indexed.push(result);
    } catch (err) {
      const msg = (err as Error).message;
      failures.push(`${note.path}: ${msg}`);
      log.warn({ path: note.path, err: msg }, 'reindex --missing: failed to index');
    }
  }
  return { indexed, failed: failures.length, failures };
}

/**
 * Core reconciliation logic (no CLI/stdout formatting — see runReindexMissing
 * for that). Exported directly so tests can assert on the structured report.
 */
export async function reconcileIndex(
  opts: ReindexMissingOptions = {},
): Promise<ReindexMissingReport> {
  const log = getLogger();
  const start = Date.now();
  const dryRun = opts.dryRun !== false; // default true
  const deleteGhosts = opts.deleteGhosts === true;
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH_SIZE;

  // --- Phase 1: missing-on-disk -------------------------------------------
  const diskPaths = listAllNotePaths();
  const indexedRowsBefore = readIndexedRows();
  const indexedPathSet = new Set(indexedRowsBefore.map((r) => r.path));
  const missingPaths = diskPaths.filter((p) => !indexedPathSet.has(p));

  // Classify BEFORE checking dryRun: an accurate preview requires knowing
  // the genuinely-missing/superseded split too, and classification is a
  // read-only operation (see classifyMissingPaths's doc comment).
  const { toIndex, superseded, readFailures, allMissingIds } = classifyMissingPaths(
    missingPaths,
    indexedRowsBefore,
    log,
  );

  // Snapshot the embedding gap BEFORE any phase runs — this is the report's
  // "embeddings_missing_before" baseline. Phase 2 below re-reads the live
  // gap (post phase-1) to build its actual candidate list, since phase 1
  // already embedded whatever it just indexed.
  const embeddingsMissingBefore = Math.max(
    indexedRowsBefore.length - loadAllStoredEmbeddings().size,
    0,
  );

  let indexed = 0;
  let failed = readFailures.length;
  const failures: string[] = [...readFailures];

  if (!dryRun) {
    for (let i = 0; i < toIndex.length; i += batchSize) {
      const batch = toIndex.slice(i, i + batchSize);
      const result = indexBatch(batch, log);
      indexed += result.indexed.length;
      failed += result.failed;
      failures.push(...result.failures);
      if (result.indexed.length > 0) {
        await embedNotesForIndex(result.indexed);
      }
      log.info(
        { done: Math.min(i + batchSize, toIndex.length), total: toIndex.length },
        'reindex --missing: progress',
      );
    }
  }

  // --- Phase 2: embedding backfill for already-indexed notes -------------
  // Re-read the stored-embeddings set AFTER phase 1 so notes just indexed
  // above (already embedded via embedNotesForIndex in their own batch)
  // aren't redundantly counted as still missing here.
  const storedEmbeddingIds = loadAllStoredEmbeddings();

  let embeddingsBackfilled = 0;
  if (!dryRun) {
    const candidates = listAllWithText({ includeExpired: true }).filter(
      (n) => !storedEmbeddingIds.has(n.id),
    );
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      await embedNotesForIndex(batch);
      embeddingsBackfilled += batch.length;
      log.info(
        { done: Math.min(i + batchSize, candidates.length), total: candidates.length },
        'reindex --missing: embedding backfill progress',
      );
    }
  }

  // --- Phase 3: ghost rows (index rows with no file on disk) -------------
  const ghostRows = indexedRowsBefore.filter((r) => !existsSync(r.path));
  let ghostRowsDeleted = 0;
  if (!dryRun && deleteGhosts) {
    for (const row of ghostRows) {
      try {
        deleteNote(row.id);
        ghostRowsDeleted += 1;
      } catch (err) {
        log.warn({ id: row.id, err: (err as Error).message }, 'reindex --missing: ghost delete failed');
      }
    }
  }

  // --- Post-run verification ----------------------------------------------
  // Re-diff disk vs. index against the CURRENT (post-run) state instead of
  // trusting the phase counters above: re-derive the full on-disk id set
  // (every already-indexed id, from indexedRowsBefore, plus every id seen
  // among missingPaths) and check which ones still lack a row. This is what
  // catches the exact failure mode the audit found — a run that claims
  // "Indexed: N, Failed: 0" while N of those were actually silent
  // no-op collisions — because it is computed independently of `indexed`.
  const indexedIdsAfter = new Set(readIndexedRows().map((r) => r.id));
  // "ids that actually have a file on disk": indexedRowsBefore minus its
  // ghost rows (a ghost row's id has NO file — counting it here would wrongly
  // flag a deliberately-deleted ghost as "still unindexed") plus every id
  // found among missingPaths (orphans, which by definition DO have a file).
  const ghostIds = new Set(ghostRows.map((r) => r.id));
  const distinctDiskIds = new Set<string>([
    ...allMissingIds,
    ...indexedRowsBefore.filter((r) => !ghostIds.has(r.id)).map((r) => r.id),
  ]);
  const remainingUnindexedAfter = [...distinctDiskIds].filter(
    (id) => !indexedIdsAfter.has(id),
  ).length;

  const indexedNotesAfter = indexedIdsAfter.size;
  const expectedRowsAfter = indexedRowsBefore.length + indexed - ghostRowsDeleted;
  const reconciled = indexedNotesAfter === expectedRowsAfter;
  const reconciliationNote = reconciled
    ? null
    : `rows_before(${indexedRowsBefore.length}) + indexed(${indexed}) - ghost_rows_deleted(${ghostRowsDeleted}) ` +
      `= ${expectedRowsAfter}, but rows_after = ${indexedNotesAfter} (diff ${indexedNotesAfter - expectedRowsAfter}). ` +
      'This means the run touched the notes table in a way its own counters did not account for — investigate before trusting this run.';

  const report: ReindexMissingReport = {
    dryRun,
    disk_notes: diskPaths.length,
    indexed_notes_before: indexedRowsBefore.length,
    missing_on_disk: missingPaths.length,
    superseded_on_disk: superseded.length,
    genuinely_missing: toIndex.length,
    indexed,
    failed,
    failures,
    ghost_rows: ghostRows.length,
    ghost_rows_deleted: ghostRowsDeleted,
    embeddings_missing_before: embeddingsMissingBefore,
    embeddings_backfilled: embeddingsBackfilled,
    indexed_notes_after: indexedNotesAfter,
    remaining_unindexed_after: remainingUnindexedAfter,
    reconciled,
    reconciliation_note: reconciliationNote,
    duration_ms: Date.now() - start,
  };

  log.info(
    {
      dryRun,
      missing_on_disk: report.missing_on_disk,
      superseded_on_disk: report.superseded_on_disk,
      genuinely_missing: report.genuinely_missing,
      indexed: report.indexed,
      ghost_rows: report.ghost_rows,
      embeddings_missing_before: report.embeddings_missing_before,
      embeddings_backfilled: report.embeddings_backfilled,
      remaining_unindexed_after: report.remaining_unindexed_after,
      reconciled: report.reconciled,
    },
    'reindex --missing: reconciliation complete',
  );

  return report;
}

export interface ReindexCliOptions {
  missing?: boolean;
  dryRun?: boolean;
  deleteGhosts?: boolean;
  batchSize?: number;
  pretty?: boolean;
}

export async function runReindex(opts: ReindexCliOptions): Promise<string> {
  if (!opts.missing) {
    throw new Error('reindex: specify an action, e.g. --missing');
  }
  const report = await reconcileIndex({
    dryRun: opts.dryRun,
    deleteGhosts: opts.deleteGhosts,
    batchSize: opts.batchSize,
  });
  return opts.pretty ? formatReport(report) : JSON.stringify(report, null, 2);
}

function formatReport(report: ReindexMissingReport): string {
  const w: string[] = [];
  w.push('');
  w.push('  Reindex --missing report');
  w.push('  ════════════════════════════════════════════');
  w.push(`  Mode:                    ${report.dryRun ? 'dry-run (nothing written)' : 'APPLIED'}`);
  w.push(`  Disk notes:              ${report.disk_notes}`);
  w.push(`  Indexed before:          ${report.indexed_notes_before}`);
  w.push(`  Missing on disk:         ${report.missing_on_disk}`);
  w.push(`    of which genuinely missing: ${report.genuinely_missing}`);
  w.push(
    `    of which superseded (stale duplicate, already indexed under a newer path): ${report.superseded_on_disk}`,
  );
  if (!report.dryRun) {
    w.push(`  Indexed this run:        ${report.indexed}`);
    w.push(`  Failed:                  ${report.failed}`);
  }
  w.push(`  Embeddings missing:      ${report.embeddings_missing_before}`);
  if (!report.dryRun) {
    w.push(`  Embeddings backfilled:   ${report.embeddings_backfilled}`);
  }
  w.push(`  Ghost rows:              ${report.ghost_rows}`);
  if (!report.dryRun) {
    w.push(`  Ghost rows deleted:      ${report.ghost_rows_deleted}${report.ghost_rows_deleted === 0 && report.ghost_rows > 0 ? ' (pass --delete-ghosts to remove)' : ''}`);
  }
  w.push(`  Indexed rows after:      ${report.indexed_notes_after}`);
  w.push(
    `  Remaining unindexed:     ${report.remaining_unindexed_after}${report.remaining_unindexed_after > 0 ? ' (re-diffed post-run — see failures below)' : ''}`,
  );
  w.push(
    `  Reconciled:              ${report.reconciled ? 'yes' : 'NO — ' + report.reconciliation_note}`,
  );
  w.push(`  Duration:                ${report.duration_ms}ms`);
  w.push('  ════════════════════════════════════════════');
  if (report.failures.length > 0) {
    w.push('');
    w.push('  Failures:');
    for (const f of report.failures.slice(0, 20)) w.push(`    - ${f}`);
    if (report.failures.length > 20) w.push(`    ... and ${report.failures.length - 20} more`);
  }
  if (report.dryRun && (report.genuinely_missing > 0 || report.embeddings_missing_before > 0)) {
    w.push('');
    w.push('  Run with --no-dry-run to apply.');
  }
  w.push('');
  return w.join('\n');
}
