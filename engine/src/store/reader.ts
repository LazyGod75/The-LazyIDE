import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { batchesDir, knowledgeNodesDir, notesDir } from './paths.js';

export interface NoteFile {
  path: string;
  id: string;
  html: string;
  sizeBytes: number;
  mtimeMs: number;
}

export function readAllNotes(): NoteFile[] {
  return [...readDir(notesDir()), ...readDir(batchesDir())];
}

/**
 * Count `.html` note files under notes/ + batches/ WITHOUT reading their
 * content (no readFileSync/statSync — just directory-entry names). Used by
 * structural.ts as a cheap freshness check for the SQLite `notes` table: if
 * the indexed row count doesn't match this, the index is missing files (or
 * has stale extras) and structural.ts falls back to the full-scan path
 * rather than risk silently dropping unindexed matches. See countAllNotes()
 * in note-read.ts for the SQL-side count this is compared against.
 */
export function countAllNoteFiles(): number {
  return countDir(notesDir()) + countDir(batchesDir());
}

function countDir(root: string): number {
  let count = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0; // directory may not exist yet
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countDir(join(root, entry.name));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      count += 1;
    }
  }
  return count;
}

/**
 * List every `.html` note file path under notes/ + batches/ WITHOUT reading
 * any file content (directory-entry names only — same cost profile as
 * countAllNoteFiles()). Used by the `reindex --missing` reconciliation
 * command (commands/reindex-missing.ts) to diff disk against the SQLite
 * index without loading the whole corpus's HTML into memory up front: the
 * command reads each note's content lazily, one batch at a time, only for
 * the paths it actually needs to (re-)index.
 */
export function listAllNotePaths(): string[] {
  return [...listDir(notesDir()), ...listDir(batchesDir())];
}

function listDir(root: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // directory may not exist yet
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Per-directory (mtime -> file count) memo for countAllNoteFilesCached().
 * Keyed by absolute directory path. Bounded by the number of YYYY-MM
 * partitions notePath() has ever created (a few dozen at most over years of
 * use) — never grows with note count.
 */
const monthDirCountCache = new Map<string, { mtimeMs: number; count: number }>();

/**
 * Cached, mtime-gated equivalent of countAllNoteFiles() — same result, far
 * cheaper on repeat calls within a long-lived process (see `serve`).
 *
 * countAllNoteFiles() does a full recursive readdir of every note file on
 * every call: ~20-30ms measured on a ~10k-note brain (warm OS file cache).
 * structural.ts's checkIndexTrust() calls it on every structural query,
 * so a long-lived process answering many queries pays that tax repeatedly
 * for an answer that, most of the time, hasn't changed since the last call.
 *
 * notePath() always partitions notes into `notes/<YYYY-MM>/*.html` (one
 * flat level — see store/paths.ts), and on NTFS/ext4/APFS creating or
 * removing a file inside a directory updates THAT directory's own mtime
 * (verified empirically on this repo's target platform; a file's own
 * content changing does not, but content changes don't affect a count).
 * So instead of re-walking every month partition on every call, this:
 *   1. Lists notesDir()'s direct children (cheap: one non-recursive
 *      readdir, ~dozens of entries, not ~10k).
 *   2. For each YYYY-MM subdirectory, stats its mtime (cheap: O(months)
 *      stats). If unchanged since the last check, reuses the memoized file
 *      count for that month untouched. Only a month whose mtime moved gets
 *      re-walked (countDir) to refresh its count.
 *   3. batchesDir() is small (currently a handful of consolidated-batch
 *      files) and counted fresh every call — not worth caching.
 *
 * Known caveat (measured, not theoretical — see reader-cached-count.test.ts):
 * two writes to the same month directory that land within the same
 * sub-millisecond window can get coalesced by NTFS into a single directory
 * mtime update, so a check that races a write by less than ~1ms can still
 * observe the OLD mtime and serve a stale (too low) count. This does not
 * matter for either real caller: a one-shot CLI process only ever calls
 * this once, well after whatever wrote the file exited; `serve`'s callers
 * arrive after a network/IPC round-trip, always several milliseconds behind
 * any write. Every write path in this codebase (capture/dream/graph/
 * synthesize/index-update) also runs indexNote() synchronously in the same
 * step as writeNote(), so a write racing a query by that little would
 * usually be caught by the SQL-side `indexed` count changing too — the
 * pathological case (disk count stale-low AND SQL count already reflects
 * the write) needs both races to land the same way, which is why this is
 * treated as an accepted, extremely narrow gap rather than an unsafe design:
 * worst case is a very rare false EQUAL that resolves itself on the next
 * call once the mtime settles, not a permanent silent failure.
 */
export function countAllNoteFilesCached(): number {
  return countNotesDirCached() + countDir(batchesDir());
}

function countNotesDirCached(): number {
  const root = notesDir();
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0; // directory may not exist yet
  }
  let total = 0;
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      total += countMonthDirCached(full);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      total += 1; // defensive: a stray .html file directly under notes/
    }
  }
  return total;
}

function countMonthDirCached(dir: string): number {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    monthDirCountCache.delete(dir);
    return 0; // directory disappeared between readdir and stat
  }
  const cached = monthDirCountCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.count;
  const count = countDir(dir);
  monthDirCountCache.set(dir, { mtimeMs, count });
  return count;
}

/** Test-only: drop the countAllNoteFilesCached() memo between test brains. */
export function resetNoteFileCountCacheForTests(): void {
  monthDirCountCache.clear();
}

/**
 * Per-directory (mtime -> distinct id-slug list) memo for
 * distinctNoteIdSlugsCached(), mirroring monthDirCountCache's mtime-gated
 * design but caching the slug SET rather than a raw file count.
 *
 * Needed because a raw recursive file count over-counts: notePath() always
 * partitions a note into `notes/<YYYY-MM>/<slug(id)>.html` using the note's
 * OWN `data-cerveau-created` timestamp (see store/paths.ts / store/writer.ts).
 * Several regenerated note types (topic-overview, brain-index, concept-*,
 * aggregate-*, file-neuron) stamp `data-cerveau-created` with the CURRENT
 * time on every regeneration instead of preserving the original, so once the
 * calendar month rolls over between two regenerations of the SAME id,
 * writeNote()'s `overwrite: true` no longer overwrites anything — it targets
 * a brand-new path in the new month folder, leaving the previous file behind
 * on disk forever (indexNote()'s `ON CONFLICT(id) DO UPDATE` then repoints
 * the index row's `path` at the new file, so the old one is never read
 * again by anything except a raw directory walk). On a brain old enough to
 * have regenerated notes, this produces thousands of orphaned duplicate
 * files that will NEVER have a matching index row by content-only diffing —
 * see structural.ts's checkIndexTrust() for why a raw file count
 * permanently breaks the SQL-pushdown trust check as a result.
 *
 * The filename itself (`slug(id)`) is already the correct dedup key: two
 * files with the same basename in different month folders are, by
 * construction, the SAME logical note id at different points in its
 * regeneration history. Grouping by that basename recovers the true
 * "distinct notes on disk" count without reading any file content.
 */
interface DiskNoteEntry {
  readonly slug: string;
  readonly path: string;
}

const monthDirEntriesCache = new Map<
  string,
  { mtimeMs: number; entries: readonly DiskNoteEntry[] }
>();

function entriesInDir(root: string): DiskNoteEntry[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // directory may not exist yet
  }
  const out: DiskNoteEntry[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...entriesInDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push({ slug: entry.name.slice(0, -'.html'.length), path: full });
    }
  }
  return out;
}

function entriesInMonthDirCached(dir: string): readonly DiskNoteEntry[] {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    monthDirEntriesCache.delete(dir);
    return []; // directory disappeared between readdir and stat
  }
  const cached = monthDirEntriesCache.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;
  const entries = entriesInDir(dir);
  monthDirEntriesCache.set(dir, { mtimeMs, entries });
  return entries;
}

/**
 * Every on-disk note entry (slug + path) across notes/ + batches/, per-month
 * mtime-gated — the shared walk behind both distinctNoteIdSlugsCached() (the
 * freshness signal) and diskPathsForSlugs() (the missing-note lookup used by
 * structuralQuery()'s hybrid fallback below). Computing entries instead of
 * bare slug strings costs nothing extra: the directory walk is identical,
 * only one more field is retained per entry.
 */
function allDiskEntriesCached(): DiskNoteEntry[] {
  const out: DiskNoteEntry[] = [];
  const root = notesDir();
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...entriesInMonthDirCached(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      // defensive: a stray .html file directly under notes/
      out.push({ slug: entry.name.slice(0, -'.html'.length), path: full });
    }
  }
  out.push(...entriesInDir(batchesDir()));
  return out;
}

/**
 * Distinct note-id slugs on disk across notes/ + batches/, deduped across
 * month partitions — see allDiskEntriesCached()'s doc comment above for why
 * this, not countAllNoteFilesCached(), is the correct freshness signal for
 * structural.ts's checkIndexTrust(). Cheap: directory-entry names only
 * (same cost profile as countAllNoteFilesCached()), per-month mtime-gated so
 * a long-lived process re-checking on every structural query only re-walks
 * the month partitions that actually changed.
 */
export function distinctNoteIdSlugsCached(): Set<string> {
  const out = new Set<string>();
  for (const entry of allDiskEntriesCached()) out.add(entry.slug);
  return out;
}

/**
 * Resolve the on-disk file path(s) for a small set of slugs — used by
 * structuralQuery()'s hybrid fallback (structural.ts) to read exactly the
 * notes the SQL index is missing, instead of re-scanning the whole corpus.
 * Reuses the same cached walk as distinctNoteIdSlugsCached() (no second
 * readdir). Returns every physical file matching one of the requested slugs:
 * normally exactly one per slug, more than one only in the pathological case
 * of two distinct ids slugifying to the same filename — returning all of
 * them keeps this at least as complete as a full scan would have been.
 */
export function diskPathsForSlugs(slugs: ReadonlySet<string>): string[] {
  if (slugs.size === 0) return [];
  const out: string[] = [];
  for (const entry of allDiskEntriesCached()) {
    if (slugs.has(entry.slug)) out.push(entry.path);
  }
  return out;
}

/** Test-only: drop the distinctNoteIdSlugsCached()/diskPathsForSlugs() memo between test brains. */
export function resetNoteIdSlugCacheForTests(): void {
  monthDirEntriesCache.clear();
}

export function readAllWithKnowledgeNodes(): NoteFile[] {
  return [...readDir(notesDir()), ...readDir(batchesDir()), ...readDir(knowledgeNodesDir())];
}

export function readAllKnowledgeNodes(): NoteFile[] {
  return readDir(knowledgeNodesDir());
}

export function readNote(path: string): NoteFile {
  readNoteCallCount += 1;
  const html = readFileSync(path, 'utf8');
  const stats = statSync(path);
  return {
    path,
    id: idFromHtml(html) ?? '',
    html,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

/**
 * Test-only instrumentation: counts every readNote() call (i.e. every note
 * whose HTML content was actually read from disk). Used by
 * structural.test.ts to prove the SQL-pushdown path in structural.ts reads
 * only the matching candidates, not the whole corpus — a direct call count
 * is more robust than mocking readNote/readAllNotes across the ESM boundary.
 */
let readNoteCallCount = 0;

export function getReadNoteCallCountForTests(): number {
  return readNoteCallCount;
}

export function resetReadNoteCallCountForTests(): void {
  readNoteCallCount = 0;
}

function readDir(root: string): NoteFile[] {
  const out: NoteFile[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // directory may not exist yet
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...readDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(readNote(full));
    }
  }
  return out;
}

/**
 * Bug fix (2026-08): the previous regex — `[^>]*\bid\s*=` — used a GREEDY
 * `[^>]*`, which backtracks from the END of the article's opening tag, so
 * when the tag carries more than one attribute matching `\bid\s*=` (the
 * real `id="..."` PLUS e.g. `data-cerveau-author-id="..."`, the shape a
 * multi-author/team capture note carries), it silently captured the LAST
 * one instead of the real note id. `\b` alone does not exclude "-id"
 * suffixes: a hyphen is a non-word character, so "id" inside "author-id"
 * also starts a word boundary.
 *
 * Fixed two ways, both necessary:
 *   - `[^>]*?` (non-greedy) finds the FIRST matching position in the tag
 *     instead of the last, matching every composer's convention of writing
 *     the bare `id="..."` attribute first.
 *   - `(?<!-)` (negative lookbehind) additionally rules out "-id" SUFFIXES
 *     of a longer attribute name (author-id, item-id, cerveau-id, ...) so
 *     the fix does not merely depend on attribute ORDER — a note where the
 *     bare `id` attribute is written AFTER an `xxx-id` attribute still
 *     resolves correctly.
 *
 * Consequences of the old bug (silent, no thrown error): note.id resolved
 * to the author id instead of the note id, so `[source]` links pointed at
 * the wrong target and dedupByItemId could collapse genuinely distinct
 * facts that merely shared an author — see
 * reader-id-from-html.test.ts for the regression coverage.
 *
 * Bug fix (2026-08, defect-1 acceptance audit): also matches `<memory-batch>`
 * root tags, not just `<article>`. compress.ts writes consolidated-batch
 * notes with `<memory-batch id="...">` as the SOLE top-level element (no
 * `<article>`/`<section>` wrapper — verified against compress.ts's template),
 * but the old article-only regex left note.id === '' for every one of them.
 * Since `id` is a SQL PRIMARY KEY, every batch note indexed this way
 * collided on the same empty string: `indexNote()`'s `ON CONFLICT(id) DO
 * UPDATE` meant each new batch silently overwrote the PREVIOUS batch's row
 * (same failure shape reindex-missing.ts's classifyMissingPaths() now guards
 * against for stale duplicates), leaving all older batches permanently
 * unreachable by id lookup and permanently missing from
 * distinctNoteIdSlugsCached()'s disk/index comparison (see structural.ts's
 * checkIndexTrust()) since no real id was ever recorded for them.
 *
 * Deliberately NOT extending this to `<section>`: synthesize.ts's
 * extractNoteContent() has an explicit, tested guard against idFromHtml
 * accidentally matching a `<section id="...">` that appears BEFORE the
 * real `<article id="...">` in some composer outputs — broadening the
 * regex to `section` here would resurrect exactly that failure mode.
 * `<memory-batch>` carries no such risk: it is always the file's own root,
 * never nested inside another id-bearing element.
 */
function idFromHtml(html: string): string | null {
  const m = html.match(/<(?:article|memory-batch)\b[^>]*?(?<!-)\bid\s*=\s*["']([^"']+)["']/i);
  return m?.[1] ?? null;
}
