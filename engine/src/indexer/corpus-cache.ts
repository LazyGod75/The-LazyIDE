/**
 * corpus-cache.ts — in-process freshness-gated cache for the notes corpus
 * and the stored-embeddings map.
 *
 * Problem: L3/hybrid retrieval (every normal assistant turn — see
 * retrieval/levels/l3.ts and retrieval/levels/hybrid.ts) called
 * listAllWithText()/loadAllStoredEmbeddings() on EVERY query. Each call ran
 * an unbounded `SELECT n.* ... ORDER BY n.created DESC` and deserialized
 * every stored 768-dim float32 vector into a brand-new JS array/Map. In the
 * long-lived `serve` sidecar (one process per app session) this meant the
 * full notes corpus — thousands of rows with per-file neurons from
 * auto-index — was re-allocated on every single assistant message, a major
 * contributor to the sidecar's memory growth.
 *
 * Design: keep exactly ONE resident copy per (db file, cache key) and reuse
 * it across queries. An entry is considered fresh as long as a cheap
 * "freshness snapshot" is unchanged since it was built:
 *
 *   - `PRAGMA data_version` increments when the database file is modified
 *     by ANY OTHER connection. This is what makes the cache correct across
 *     the common split where the sidecar only reads (`getDb()` inside the
 *     long-lived `serve` process) while indexing runs as a separate
 *     `node lazybrain.js ...` process (index-update, capture, etc.) with
 *     its own connection.
 *   - Row count guards the same table as a second, independent signal —
 *     cheap (COUNT(*)), much cheaper than the full corpus reload it
 *     protects, and catches edge cases in data_version semantics across
 *     better-sqlite3/SQLite versions.
 *   - `localWriteVersion` covers writes made through the SAME connection —
 *     SQLite's data_version does not reliably reflect a connection's own
 *     writes. The sidecar CAN write through its own connection (e.g.
 *     serve.ts's boot auto-build calls runIncrementalUpdate() in-process
 *     when the index is empty but note files exist), so every write path
 *     in this process (indexNote/deleteNote/rebuildAll in note-index.ts,
 *     upsertNoteEmbedding/deleteNoteEmbedding in embedding-store.ts) calls
 *     bumpLocalWriteVersion() to invalidate immediately instead of serving
 *     a stale corpus until the next restart.
 *
 * Deliberately NOT bumped by recordAccess()/recordAccessMany()
 * (note-read.ts): those run after every single retrieval (router.ts) to
 * update access_count/last_accessed. Invalidating on every access record
 * would defeat the cache entirely — every query would force a reload
 * triggered by the query that just ran. Their UPDATEs don't change row
 * count and, being same-connection, don't move data_version either, so
 * they are correctly ignored here: the cached corpus may lag on
 * access_count/last_accessed by up to one query (fine for decay scoring,
 * see retrieval/decay.ts) but is never wrong about content (title/text/
 * tags/embeddings).
 *
 * Memory shape: a new snapshot REPLACES the previous value for that key
 * (old array/map becomes eligible for GC) and the key space is bounded (one
 * key per db path per distinct filter combination — at most a handful) —
 * this does not grow unbounded over time.
 */

import type { Database as DB } from 'better-sqlite3';

/** Bumped by every write that goes through this process's own connection. */
let localWriteVersion = 0;

/**
 * Call after any write to `notes` or `note_embeddings` made on the writable
 * connection (getDb()) — see note-index.ts and embedding-store.ts. Never
 * call this from recordAccess()/recordAccessMany() (see module doc above).
 */
export function bumpLocalWriteVersion(): void {
  localWriteVersion += 1;
}

interface Snapshot {
  dataVersion: number;
  rowCount: number;
  localWriteVersion: number;
}

function readSnapshot(db: DB, table: 'notes' | 'note_embeddings'): Snapshot {
  const dataVersion = db.pragma('data_version', { simple: true }) as number;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return { dataVersion, rowCount: row?.n ?? 0, localWriteVersion };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.dataVersion === b.dataVersion &&
    a.rowCount === b.rowCount &&
    a.localWriteVersion === b.localWriteVersion
  );
}

/**
 * Freshness-gated cache, one resident value per key. `db.name` (the file
 * path the connection was opened with) is folded into every internal key so
 * a DB-path switch (e.g. tests closing and reopening against a different
 * temp path) never serves an entry left over from a previous database.
 *
 * Bounded key space by construction: callers pass a small discriminator
 * (e.g. a boolean filter flag) — there is no per-query or per-text key, so
 * this never grows with corpus size or query volume.
 */
export class SnapshotCache<T> {
  private entries = new Map<string, { snapshot: Snapshot; value: T }>();

  /**
   * Return the cached value for `key` if the freshness snapshot still
   * matches; otherwise run `load()`, cache the result under the CURRENT
   * snapshot, and return it.
   */
  resolve(db: DB, table: 'notes' | 'note_embeddings', key: string, load: () => T): T {
    const snapshot = readSnapshot(db, table);
    const cacheKey = `${db.name}::${key}`;
    const existing = this.entries.get(cacheKey);
    if (existing && sameSnapshot(existing.snapshot, snapshot)) {
      return existing.value;
    }
    const value = load();
    this.entries.set(cacheKey, { snapshot, value });
    return value;
  }

  /** Drop every cached entry. Test-only. */
  clear(): void {
    this.entries.clear();
  }
}

/** Test-only: reset the shared local write counter (does not touch db.ts). */
export function resetLocalWriteVersionForTests(): void {
  localWriteVersion = 0;
}
