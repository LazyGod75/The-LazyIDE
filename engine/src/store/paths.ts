import { join } from 'node:path';
import { getConfig } from '../util/config.js';

export function brainRoot(): string {
  return getConfig().brainPath;
}

export function notesDir(): string {
  return join(brainRoot(), 'notes');
}

export function batchesDir(): string {
  return join(brainRoot(), 'batches');
}

export function knowledgeNodesDir(): string {
  return join(brainRoot(), 'knowledge-nodes');
}

export function metaDir(): string {
  return join(brainRoot(), 'meta');
}

/**
 * Filename of the FTS/notes SQLite index inside a brain's cache dir.
 * Exported so brain-registry.ts can compute a specific (cold) brain's index
 * path directly — without going through the ambient getConfig() — when it
 * needs to close that brain's connections during LRU demotion.
 */
export const FTS_DB_FILENAME = 'fts.sqlite';

export function indexPath(): string {
  return join(getConfig().cachePath, FTS_DB_FILENAME);
}

/**
 * Build canonical filesystem path for a note ID.
 * Notes are organized by YYYY-MM partition for git-friendly small folders.
 */
export function notePath(id: string, createdISO?: string): string {
  const date = createdISO ? new Date(createdISO) : new Date();
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  return join(notesDir(), `${yyyy}-${mm}`, `${slug(id)}.html`);
}

/**
 * Build filesystem path for a hierarchy-node (aggregate or feature-set neuron).
 * These nodes live in their own directory to avoid collisions with source notes.
 */
export function knowledgeNodePath(nodeId: string): string {
  return join(knowledgeNodesDir(), `${slug(nodeId)}.html`);
}

/**
 * Slugify a raw content id into a safe filename component.
 *
 * Idempotent: slug(slug(x)) === slug(x) for every input. This matters
 * because the write path applies slug() twice — writer.ts's writeNote()
 * slugifies the id extracted from the HTML once, then notePath() (below)
 * slugifies its `id` argument again internally — so any code that needs to
 * predict the on-disk filename from a single slug() call must get the same
 * answer a second application would give.
 *
 * The trailing `.replace(/-$/, '')` after `.slice(0, 80)` is what makes this
 * idempotent. Without it, a single application can leave a stray trailing
 * "-": the trim step (`^-|-$`) runs BEFORE the length clamp, so truncating a
 * long id can cut it back open at position 80 if that character lands on a
 * hyphen run's tail. A second slug() call would silently strip that stray
 * hyphen, producing a SHORTER string than the first call — non-idempotent.
 * Stripping any trailing hyphen introduced by truncation, in the same call,
 * closes that gap. (A leading hyphen cannot appear post-slice: the trim
 * before slicing already removed any leading hyphen, and slicing from index
 * 0 cannot introduce one.)
 *
 * Backward compatible with every existing on-disk filename: this function's
 * single-application output is byte-identical to the OLD slug(slug(x)) for
 * every input (verified against all 7793 distinct real note ids in a real,
 * mature brain — see __tests__/paths.test.ts). So notePath()'s internal
 * slug() call, applied to an id already produced by this function, is a
 * true no-op, and writer.ts's existing double-call keeps resolving to
 * exactly the filenames already on disk.
 */
export function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/, '');
}
