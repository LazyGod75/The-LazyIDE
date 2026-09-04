/**
 * db.ts — SQLite DB lifecycle for the FTS index.
 *
 * Owns the cached DB connections, WAL/busy pragmas, and the
 * public open/close API.  Schema initialisation is handled by
 * schema.ts so this file stays focused on connection management.
 *
 * Multi-tenant note (T0.8): connections are cached in a Map keyed by the
 * resolved index path rather than a single module-level variable. In the
 * default single-brain flow (no active brain-registry context — see
 * server/brain-context.ts) indexPath() always resolves to the same path, so
 * these maps only ever hold one entry each and behave exactly like the old
 * single-slot cache. When a brain-registry request context is active,
 * indexPath() resolves to that specific brain's cache dir, so each hot brain
 * gets its own connection object — closeDbForPath() lets the registry close
 * one brain's handles (LRU demotion) without touching any other brain's.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { indexPath } from '../store/paths.js';
import { initSchema } from './schema.js';

const dbByPath = new Map<string, DB>();
const readonlyDbByPath = new Map<string, DB>();

/**
 * Return (and cache) the writable FTS database for the currently active
 * brain (or the default brain, with no active context).
 * Creates the file and directory on first call; runs schema migration.
 */
export function getDb(): DB {
  const path = indexPath();
  const existing = dbByPath.get(path);
  if (existing) return existing;

  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Give concurrent readers (serve) up to 5 s to release their read lock
  // before the writer gives up. Eliminates SQLITE_BUSY on typical workloads.
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  dbByPath.set(path, db);
  return db;
}

/**
 * Open the FTS database in read-only mode.
 * Used by `lazybrain serve` so a long-running process never holds a write lock
 * and never blocks the incremental index writer (Stop hook / index-update).
 *
 * WAL mode allows concurrent readers + one writer without locking conflicts.
 * The connection is cached for the lifetime of the process (or until the
 * owning brain is demoted — see closeDbForPath()).
 */
export function getReadonlyDb(): DB {
  const path = indexPath();
  const existing = readonlyDbByPath.get(path);
  if (existing) return existing;

  const db = new Database(path, { readonly: true });
  db.pragma('journal_mode = WAL');
  // Give concurrent writers up to 5 s to release their write lock
  // before the reader gives up. Eliminates SQLITE_BUSY on concurrent updates.
  db.pragma('busy_timeout = 5000');
  readonlyDbByPath.set(path, db);
  return db;
}

/**
 * Close every cached DB connection (writable + readonly) and clear the
 * caches. Must be called between tests or before process exit when the DB
 * path changes. In the default single-brain flow this closes "the" one
 * connection, exactly as before this file supported multiple brains.
 */
export function closeDb(): void {
  for (const db of dbByPath.values()) db.close();
  dbByPath.clear();
  for (const db of readonlyDbByPath.values()) db.close();
  readonlyDbByPath.clear();
}

/**
 * Close only the connections associated with one specific index path,
 * leaving every other brain's connections untouched. Used by
 * server/brain-registry.ts to demote a cold brain: the heavy sqlite handles
 * are released, but the next request against that brain's path lazily
 * reopens a fresh connection via getDb()/getReadonlyDb() above — the file on
 * disk (and everything committed to it) is untouched.
 *
 * No-op (never throws) when no connection is cached for `path`.
 */
export function closeDbForPath(path: string): void {
  const writable = dbByPath.get(path);
  if (writable) {
    writable.close();
    dbByPath.delete(path);
  }
  const readonly = readonlyDbByPath.get(path);
  if (readonly) {
    readonly.close();
    readonlyDbByPath.delete(path);
  }
}
