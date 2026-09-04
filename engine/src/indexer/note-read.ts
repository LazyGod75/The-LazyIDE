/**
 * note-read.ts — Note read operations: listing, single-note fetch, access tracking,
 *               tag helpers, entity lookup, multi-axis retrieval.
 *
 * All functions are pure DB reads (or best-effort access writes).
 * No HTML parsing here — that lives in note-index.ts.
 */

import { SnapshotCache } from './corpus-cache.js';
import { getDb, getReadonlyDb } from './db.js';
import { searchFts } from './fts-search.js';
import type { IndexedNote, ListAllOptions } from './note-types.js';

/**
 * Freshness-gated cache for listAllWithText() — see corpus-cache.ts for the
 * invalidation design. Keyed by `shouldExcludeInvalidated` (the only input
 * that changes the query's WHERE clause; `includeExpired`/`excludeInvalidated`
 * always collapse to that one boolean — see listAllWithText below), so this
 * holds at most 2 entries per db path.
 */
const withTextCache = new SnapshotCache<Array<IndexedNote & { text: string }>>();

/**
 * Count active notes in the index. Fast O(1) SQLite query.
 * Returns 0 when the DB or table does not exist yet.
 */
export function countAllNotes(): number {
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch every indexed note's raw id (not slug). Cheap: single-column scan of
 * the `notes` table's primary key, no joins. Used by structural.ts's
 * checkIndexTrust() to build the indexed-id set it compares against disk
 * — see distinctNoteIdSlugsCached() in store/reader.ts for the disk side of
 * that comparison and why it must be slug-based, not a raw count.
 */
export function listAllNoteIds(): string[] {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id FROM notes').all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

export function listAll(opts: ListAllOptions = {}): IndexedNote[] {
  const db = getDb();
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  const where = shouldExcludeInvalidated ? `WHERE (valid_until IS NULL OR valid_until = '')` : '';
  return db.prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`).all() as IndexedNote[];
}

/**
 * Same as listAll() but uses the read-only database connection.
 * Safe to call from a long-running serve process without blocking the writer.
 * Returns an empty array when the index database does not exist yet.
 */
export function listAllReadonly(opts: ListAllOptions = {}): IndexedNote[] {
  let db: ReturnType<typeof getReadonlyDb>;
  try {
    db = getReadonlyDb();
  } catch {
    return [];
  }
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  const where = shouldExcludeInvalidated ? `WHERE (valid_until IS NULL OR valid_until = '')` : '';
  try {
    return db.prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`).all() as IndexedNote[];
  } catch {
    return [];
  }
}

/**
 * B1/B2: same as listAll but attaches notes_fts.text so retrieval levels can
 * embed and rerank against the full stripped body, not just title+tags.
 * Falls back to empty text if the FTS row is missing (defensive; FTS sync
 * issues shouldn't crash retrieval).
 *
 * When excludeInvalidated is true, filters out notes with valid_until set,
 * BEFORE embedding scoring (critical for avoiding contamination in L3/L4).
 *
 * Perf note (see corpus-cache.ts's module doc for the surrounding cache):
 * this used to be a single `notes LEFT JOIN notes_fts ON fts.id = n.id`
 * query. `id` is declared UNINDEXED in the notes_fts FTS5 table (see
 * schema.ts) — SQLite has no B-tree it can use for an equality lookup on
 * that column, so the query planner degraded to "SCAN fts VIRTUAL TABLE ...
 * LEFT-JOIN": a fresh full scan of the ENTIRE notes_fts virtual table for
 * EVERY row of `notes`. Measured on a realistic 5488-note/324 MB brain: the
 * join alone took ~230s, versus ~130ms for `notes` and ~500ms for a plain
 * unjoined `notes_fts` scan. Since `withTextCache` below only caches the
 * RESULT per process (a fresh sidecar pays this once, on whichever query
 * runs first), that one-time cost was exactly the measured 40-177s cold /
 * first-turn recall penalty. Fetching both tables independently (no join
 * condition — each is one linear, index-friendly scan) and merging them
 * with a plain in-memory Map produces byte-identical output at a fraction
 * of the cost.
 */
export function listAllWithText(opts: ListAllOptions = {}): Array<IndexedNote & { text: string }> {
  const db = getDb();
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  // Speed fix: this is the hot corpus read for every L3/hybrid query (see
  // retrieval/levels/l3.ts, hybrid.ts) — cache the resolved array per
  // (db path, shouldExcludeInvalidated) instead of re-querying + re-joining
  // notes_fts on every single call. See corpus-cache.ts for the
  // invalidation contract (data_version + row count + local write counter).
  return withTextCache.resolve(db, 'notes', String(shouldExcludeInvalidated), () => {
    const where = shouldExcludeInvalidated
      ? `WHERE (valid_until IS NULL OR valid_until = '')`
      : '';
    const notes = db
      .prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`)
      .all() as IndexedNote[];

    const textById = new Map<string, string>();
    const ftsRows = db.prepare('SELECT id, text FROM notes_fts').all() as Array<{
      id: string;
      text: string | null;
    }>;
    for (const row of ftsRows) {
      textById.set(row.id, row.text ?? '');
    }

    return notes.map((n) => ({ ...n, text: textById.get(n.id) ?? '' }));
  });
}

/**
 * B1/B2: fetch the indexed full text for a single note, useful for the reranker.
 */
export function getNoteText(id: string): string {
  const row = getDb().prepare('SELECT text FROM notes_fts WHERE id = ?').get(id) as
    | { text?: string }
    | undefined;
  return row?.text ?? '';
}

/**
 * B4: register a retrieval hit. Tracks access_count + last_accessed for
 * Ebbinghaus-style decay scoring downstream. No-op on missing id.
 *
 * Deliberately does NOT call corpus-cache.ts's bumpLocalWriteVersion(): this
 * runs after EVERY retrieval (router.ts calls recordAccessMany on every
 * query's hits), so invalidating the corpus cache here would force a full
 * reload on the very next query, every time — defeating the cache. See
 * corpus-cache.ts's module doc for the full rationale.
 */
export function recordAccess(id: string, isoTs?: string): void {
  const ts = isoTs ?? new Date().toISOString();
  try {
    getDb()
      .prepare(
        'UPDATE notes SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ? WHERE id = ?',
      )
      .run(ts, id);
  } catch {
    // never block retrieval on access tracking failure
  }
}

/** Batch form of recordAccess() — same "no cache invalidation" contract, see above. */
export function recordAccessMany(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const ts = new Date().toISOString();
  const db = getDb();
  try {
    const stmt = db.prepare(
      'UPDATE notes SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ? WHERE id = ?',
    );
    const tx = db.transaction((batch: readonly string[]) => {
      for (const id of batch) stmt.run(ts, id);
    });
    tx(ids);
  } catch {
    // best-effort
  }
}

export function getNoteById(id: string): IndexedNote | undefined {
  return getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as IndexedNote | undefined;
}

export function notesByTagOrType(opts: {
  tag?: string;
  type?: string;
  limit?: number;
  includeExpired?: boolean;
}): IndexedNote[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.tag) {
    // Use word boundary matching for space-separated tags.
    //
    // Case sensitivity: deliberately relies on SQLite's LIKE operator being
    // ASCII-case-insensitive BY DEFAULT (no COLLATE NOCASE needed) — verified
    // against a real ~6300-note brain: `LIKE '% Lazy %'`, `'% lazy %'`, and
    // `'% LAZY %'` all returned the identical row count, and this codebase
    // never issues `PRAGMA case_sensitive_like`. That makes this WHERE clause
    // already return a case-insensitive SUPERSET of candidates regardless of
    // which case the caller passes — a required property for
    // structural.ts's SQL-pushdown fast path to stay in parity with its
    // full-scan fallback (see withTagCaseInsensitivity() there for the full
    // design: the fast path's final result is narrowed by a case-insensitive
    // CSS match against this same superset, so over-fetching here is safe,
    // under-fetching would not be). If SQLite's LIKE default ever changes
    // (e.g. a future PRAGMA case_sensitive_like=ON added elsewhere), this
    // silently reintroduces the case-sensitivity bug the fast path was fixed
    // for — see structural.test.ts's case-insensitivity parity tests, which
    // exercise this exact path and would catch that regression.
    where.push(`(' ' || tags || ' ') LIKE @tagPattern`);
    params.tagPattern = `% ${opts.tag} %`;
  }
  if (opts.type) {
    where.push('type = @type');
    params.type = opts.type;
  }
  if (!opts.includeExpired) {
    where.push(`(valid_until IS NULL OR valid_until = '')`);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts.limit ?? 10;

  return db
    .prepare(
      `SELECT * FROM notes ${whereClause} ORDER BY importance DESC, created DESC LIMIT @limit`,
    )
    .all({ ...params, limit }) as IndexedNote[];
}

/**
 * P2: entity-graph lookup. Returns all notes whose `entities` column contains
 * the given canonical key (e.g. "db:postgres-prod"). Used by query expansion
 * and the `/graph #id` endpoint.
 */
export function notesMentioningEntity(entityKey: string, limit = 20): IndexedNote[] {
  const db = getDb();
  const sql = `
    SELECT * FROM notes
    WHERE entities LIKE @needle
      AND (valid_until IS NULL OR valid_until = '')
    ORDER BY created DESC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all({ needle: `%${entityKey}%`, limit }) as IndexedNote[];
  // Re-filter to avoid LIKE false positives on substring collisions
  return rows.filter((r) => {
    const list = (r.entities ?? '').split(',').filter(Boolean);
    return list.includes(entityKey);
  });
}

/**
 * Retrieve notes that answer a given question.
 * Matches against questions column using LIKE with ranking.
 */
export function notesAnsweringQuestion(
  query: string,
  limit = 10,
  sourcePrefix?: string,
): IndexedNote[] {
  const db = getDb();
  const needle = `%${query.toLowerCase()}%`;
  const src = sourcePrefix ? 'AND source LIKE @sourcePrefix' : '';
  const rows = db
    .prepare(
      `
    SELECT n.*, COALESCE(fts.text, '') AS text
    FROM notes n
    LEFT JOIN notes_fts fts ON fts.id = n.id
    WHERE questions LIKE @needle
      AND (n.valid_until IS NULL OR n.valid_until = '')
      ${src}
    ORDER BY
      CASE WHEN questions LIKE @exact THEN 0 ELSE 1 END,
      n.created DESC
    LIMIT @limit
  `,
    )
    .all({
      needle,
      exact: `%${query}%`,
      limit,
      ...(sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}),
    }) as IndexedNote[];
  return rows;
}

/**
 * Retrieve notes for a given error pattern.
 * Normalizes the error text (strips line numbers, stack addresses) and matches.
 */
export function notesForErrorPattern(
  errorText: string,
  limit = 5,
  sourcePrefix?: string,
): IndexedNote[] {
  const db = getDb();
  // Normalize: strip line numbers and common stack address patterns
  const normalized = errorText
    .replace(/:\d+/g, '')
    .replace(/0x[0-9a-f]+/g, '')
    .toLowerCase();

  // Distinctive slice: after "fix this error:" or the exception name
  const afterColon = normalized.split(/fix this error:\s*/i).pop() ?? normalized;
  const key =
    afterColon
      .match(
        /(?:operationalerror|typeerror|referenceerror|syntaxerror|eresolve|deadlock|assertionerror|cors)[^?]*/i,
      )?.[0]
      ?.slice(0, 80) ?? afterColon.slice(0, 80);
  const needle = `%${key.trim()}%`;

  const src = sourcePrefix ? 'AND n.source LIKE @sourcePrefix' : '';
  const rows = db
    .prepare(
      `
    SELECT n.*, COALESCE(fts.text, '') AS text
    FROM notes n
    LEFT JOIN notes_fts fts ON fts.id = n.id
    WHERE (
      n.error_patterns LIKE @needle
      OR n.title LIKE @needle
      OR n.section_summary LIKE @needle
      OR fts.text LIKE @needle
    )
    AND (n.valid_until IS NULL OR n.valid_until = '')
    ${src}
    ORDER BY
      CASE WHEN fts.text LIKE '%fix%' OR fts.text LIKE '%Fix%' THEN 0 ELSE 1 END,
      n.created DESC
    LIMIT @limit
  `,
    )
    .all({
      needle,
      limit,
      ...(sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}),
    }) as IndexedNote[];
  return rows;
}

/**
 * Notes whose indexed text mentions a file or directory path prefix.
 * Used for filetree-scope queries (src/auth/, tests/, package.json).
 */
export function notesMatchingPathPrefix(
  pathPrefix: string,
  limit = 10,
  sourcePrefix?: string,
): IndexedNote[] {
  const db = getDb();
  const norm = pathPrefix.replace(/\\/g, '/').toLowerCase();
  if (!norm) return [];
  const needle = `%${norm}%`;
  const src = sourcePrefix ? 'AND n.source LIKE @sourcePrefix' : '';
  return db
    .prepare(
      `
    SELECT n.*, COALESCE(fts.text, '') AS text
    FROM notes n
    LEFT JOIN notes_fts fts ON fts.id = n.id
    WHERE (
      n.title LIKE @needle
      OR n.section_summary LIKE @needle
      OR n.section_tool_trace LIKE @needle
      OR fts.text LIKE @needle
    )
    AND (n.valid_until IS NULL OR n.valid_until = '')
    ${src}
    ORDER BY n.created DESC
    LIMIT @limit
  `,
    )
    .all({
      needle,
      limit,
      ...(sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}),
    }) as IndexedNote[];
}

/**
 * Notes with anti-pattern warnings or explicit negation in body text.
 */
export function notesWithWarningsOrNegative(
  query: string,
  limit = 8,
  sourcePrefix?: string,
): IndexedNote[] {
  let candidates = listAllWithText({ includeExpired: false }).filter(
    (n) =>
      Boolean((n.warnings ?? '').trim()) ||
      /\b(do not retry|abandoned|reverted|broke streaming|tried using|do not use)\b/i.test(n.text),
  );
  if (sourcePrefix) {
    candidates = candidates.filter((n) => (n.source ?? '').startsWith(sourcePrefix));
  }
  if (candidates.length === 0) return [];
  const allowed = new Set(candidates.map((c) => c.id));
  const ftsHits = searchFts(query, { limit: limit * 4, sourcePrefix });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: IndexedNote[] = [];
  for (const h of ftsHits) {
    if (!allowed.has(h.id)) continue;
    const n = byId.get(h.id);
    if (n) out.push(n);
    if (out.length >= limit) break;
  }
  if (out.length < limit) {
    for (const c of candidates) {
      if (out.some((o) => o.id === c.id)) continue;
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}
