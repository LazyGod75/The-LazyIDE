/**
 * index-rebuild command.
 *
 * DEFAULT (incremental): delegates to runIncrementalUpdate() — uses SHA/mtime
 * fingerprints to re-index only changed notes. Turns the 15-minute full
 * rebuild into a seconds-long update on a live brain.
 *
 * --full: wipes the entire index and re-indexes every note from scratch.
 * Use this when the schema changed, the index is corrupt, or you want a
 * guaranteed clean state.
 */

import { rebuildAll } from '../indexer/fts.js';
import { runIncrementalUpdate } from './index-update.js';

export interface IndexRebuildCliOptions {
  pretty?: boolean;
  /** When true, wipe and re-index all notes. Default: incremental update. */
  full?: boolean;
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

export async function runIndexRebuild(opts: IndexRebuildCliOptions): Promise<string> {
  try {
    if (opts.full) {
      // Full wipe + rebuild — expensive but guaranteed clean.
      const result = await rebuildAll();
      if (opts.pretty) {
        let out = `Full rebuild: ${result.indexed} notes indexed, ${result.failed} failed.`;
        if (result.failures.length > 0) {
          out += `\n\nFailures:\n${result.failures.map((f) => `  - ${f}`).join('\n')}`;
        }
        return out;
      }
      return JSON.stringify(result, null, 2);
    }

    // Default: incremental update — only re-index changed / new notes.
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
        'A running `lazybrain serve` or daemon is holding the index.\n' +
        'Stop it first:  lazybrain serve --stop\n' +
        '                lazybrain daemon stop\n' +
        'Then retry:     lazybrain index-rebuild';
      // Re-throw with an actionable message so the CLI handle() function
      // can print it and exit with a non-zero code.
      throw new Error(hint, { cause: err });
    }
    throw err;
  }
}
