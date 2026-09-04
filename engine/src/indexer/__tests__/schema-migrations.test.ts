/**
 * Tests for the versioned schema migration mechanism in schema.ts.
 *
 * Coverage:
 *   1. Fresh DB: all migration versions recorded, all expected columns present.
 *   2. Legacy DB: notes table exists without schema_migrations — opens cleanly,
 *      acquires all columns, and is fully usable for reads and writes.
 *   3. Idempotency: calling initSchema twice does not throw or duplicate rows.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, columnExists, initSchema } from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All column names that must exist on the notes table after full migration. */
const EXPECTED_COLUMNS = [
  // Base DDL columns
  'id',
  'path',
  'title',
  'type',
  'tags',
  'source',
  'created',
  'importance',
  'valid_from',
  'valid_until',
  'mtime_ms',
  // Migration 1: P1 relation columns
  'triples',
  'causes',
  'replaces',
  'replaced_by',
  'supersedes',
  'entities',
  // Migration 2: B4 access tracking
  'access_count',
  'last_accessed',
  // Migration 3: Wikipedia concepts
  'concepts',
  // Migration 4: Quality and saliency_kind
  'quality',
  'saliency_kind',
  // Migration 5: pre-computed cosine neighbours
  'related',
  // Migration 6: Haiku #8 multi-axis indexing
  'questions',
  'error_patterns',
  'aliases',
  'section_summary',
  'section_reasoning',
  'section_qa',
  'section_tool_trace',
  // Migration 7: Anti-pattern warnings
  'warnings',
  // Migration 8: TLDR and topic
  'section_tldr',
  'topic',
  'tldr',
];

function openInMemoryDb(): InstanceType<typeof Database> {
  return new Database(':memory:');
}

/** Create a legacy brain DB: notes table exists but schema_migrations absent. */
function buildLegacyDb(): InstanceType<typeof Database> {
  const db = openInMemoryDb();
  // Only the original base schema — no migration columns, no schema_migrations.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT,
      type TEXT,
      tags TEXT,
      source TEXT,
      created TEXT,
      importance REAL,
      valid_from TEXT,
      valid_until TEXT,
      mtime_ms REAL NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      id UNINDEXED,
      title,
      text,
      tags,
      tokenize = "porter unicode61"
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Setup: temp dirs for on-disk DB tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-schema-test-'));
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Fresh DB
// ---------------------------------------------------------------------------

describe('initSchema — fresh database', () => {
  it('records all migration versions in schema_migrations', () => {
    const db = openInMemoryDb();
    initSchema(db);

    const rows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{
      version: number;
    }>;
    const recorded = new Set(rows.map((r) => r.version));

    for (const m of MIGRATIONS) {
      expect(recorded.has(m.version), `migration v${m.version} not recorded`).toBe(true);
    }
  });

  it('creates all expected columns on the notes table', () => {
    const db = openInMemoryDb();
    initSchema(db);

    for (const col of EXPECTED_COLUMNS) {
      expect(columnExists(db, 'notes', col), `missing column: ${col}`).toBe(true);
    }
  });

  it('creates the note_embeddings table (migration 9)', () => {
    const db = openInMemoryDb();
    initSchema(db);

    const tables = db.pragma('table_list') as Array<{ name: string }>;
    const hasEmbeddings = tables.some((t) => t.name === 'note_embeddings');
    expect(hasEmbeddings).toBe(true);
  });

  it('adds model_id column to note_embeddings (migration 10)', () => {
    const db = openInMemoryDb();
    initSchema(db);

    expect(columnExists(db, 'note_embeddings', 'model_id')).toBe(true);
  });

  it('is idempotent — calling initSchema twice does not throw', () => {
    const db = openInMemoryDb();
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
  });

  it('adds model_id to a note_embeddings table that predates migration 10 (real-world upgrade path)', () => {
    // Simulate a brain already on migration 9: note_embeddings exists (via the
    // v9 DDL, no model_id column) and schema_migrations already records 1..9.
    const db = openInMemoryDb();
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE note_embeddings (
        id TEXT PRIMARY KEY,
        embed_text_hash TEXT NOT NULL,
        vector BLOB NOT NULL
      );
    `);
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9]) insert.run(v, now);
    // Also lay down the notes table with the pre-migration-10 columns so
    // initSchema's base DDL / addColumnIfMissing calls have something to act on.
    db.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, type TEXT, tags TEXT,
        source TEXT, created TEXT, importance REAL, valid_from TEXT, valid_until TEXT,
        mtime_ms REAL NOT NULL
      );
    `);

    // Row inserted BEFORE migration 10 — no model_id value possible yet.
    db.prepare('INSERT INTO note_embeddings (id, embed_text_hash, vector) VALUES (?, ?, ?)').run(
      'legacy-note',
      'abc123',
      Buffer.alloc(768 * 4),
    );

    expect(() => initSchema(db)).not.toThrow();
    expect(columnExists(db, 'note_embeddings', 'model_id')).toBe(true);

    // Pre-existing row survives the migration with model_id = NULL (not
    // crashed, not fabricated) — exactly the "old format handled gracefully"
    // contract that embedding-store.ts's read path relies on.
    const row = db
      .prepare('SELECT model_id FROM note_embeddings WHERE id = ?')
      .get('legacy-note') as { model_id: string | null };
    expect(row.model_id).toBeNull();
  });

  it('does not record duplicate migration versions on second call', () => {
    const db = openInMemoryDb();
    initSchema(db);
    initSchema(db);

    const rows = db
      .prepare(
        'SELECT version, COUNT(*) as cnt FROM schema_migrations GROUP BY version HAVING cnt > 1',
      )
      .all();
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Legacy DB (notes table without schema_migrations)
// ---------------------------------------------------------------------------

describe('initSchema — legacy database', () => {
  it('opens cleanly without throwing', () => {
    const db = buildLegacyDb();
    expect(() => initSchema(db)).not.toThrow();
  });

  it('adds all migration columns to the legacy notes table', () => {
    const db = buildLegacyDb();
    initSchema(db);

    for (const col of EXPECTED_COLUMNS) {
      expect(columnExists(db, 'notes', col), `missing column after legacy upgrade: ${col}`).toBe(
        true,
      );
    }
  });

  it('records all migration versions after upgrading', () => {
    const db = buildLegacyDb();
    initSchema(db);

    const rows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{
      version: number;
    }>;
    const recorded = new Set(rows.map((r) => r.version));
    expect(recorded.size).toBe(MIGRATIONS.length);
  });

  it('legacy DB is fully usable — can insert and query notes', () => {
    const db = buildLegacyDb();
    initSchema(db);

    db.prepare(
      'INSERT INTO notes (id, path, title, type, tags, mtime_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'test-id',
      '/brain/notes/2026-01/test-id.html',
      'Test Note',
      'episodic',
      'code',
      1234567890,
    );

    const row = db.prepare('SELECT id, title FROM notes WHERE id = ?').get('test-id') as {
      id: string;
      title: string;
    };
    expect(row).toBeDefined();
    expect(row.id).toBe('test-id');
    expect(row.title).toBe('Test Note');
  });

  it('legacy DB upgrade is idempotent — calling initSchema twice does not throw', () => {
    const db = buildLegacyDb();
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. columnExists helper
// ---------------------------------------------------------------------------

describe('columnExists', () => {
  it('returns true for an existing column', () => {
    const db = openInMemoryDb();
    db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    expect(columnExists(db, 't', 'a')).toBe(true);
    expect(columnExists(db, 't', 'b')).toBe(true);
  });

  it('returns false for a missing column', () => {
    const db = openInMemoryDb();
    db.exec('CREATE TABLE t (a TEXT)');
    expect(columnExists(db, 't', 'z')).toBe(false);
  });
});
