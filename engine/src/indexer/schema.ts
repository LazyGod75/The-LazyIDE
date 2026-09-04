/**
 * schema.ts — SQLite schema creation and versioned migrations.
 *
 * Versioning contract:
 *   - A `schema_migrations` table (version INTEGER PRIMARY KEY, applied_at TEXT)
 *     tracks which migration steps have been applied.
 *   - Fresh DBs run ALL migration steps in order after creating baseline tables.
 *   - Legacy DBs (notes table exists but schema_migrations absent) are detected
 *     via PRAGMA table_info; missing columns are added idempotently, then all
 *     version rows are recorded.
 *
 * Adding a new migration:
 *   1. Append an entry to MIGRATIONS with the next version number.
 *   2. Use PRAGMA table_info / CREATE INDEX IF NOT EXISTS guards so the step
 *      is always idempotent.
 */

import type { Database as DB } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Base schema — tables that must exist before any migration can run
// ---------------------------------------------------------------------------

const BASE_DDL = `
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

  CREATE INDEX IF NOT EXISTS idx_notes_type    ON notes(type);
  CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created);
  CREATE INDEX IF NOT EXISTS idx_notes_valid_until ON notes(valid_until);
`;

// ---------------------------------------------------------------------------
// Migration steps — ordered, idempotent
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  description: string;
  up: (db: DB) => void;
}

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'P1 relation columns',
    up(db) {
      for (const col of [
        'triples',
        'causes',
        'replaces',
        'replaced_by',
        'supersedes',
        'entities',
      ]) {
        addColumnIfMissing(db, 'notes', col, 'TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_entities ON notes(entities)');
    },
  },
  {
    version: 2,
    description: 'B4 access tracking columns',
    up(db) {
      addColumnIfMissing(db, 'notes', 'access_count', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'notes', 'last_accessed', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_access ON notes(access_count, last_accessed)');
    },
  },
  {
    version: 3,
    description: 'Wikipedia concepts column',
    up(db) {
      addColumnIfMissing(db, 'notes', 'concepts', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_concepts ON notes(concepts)');
    },
  },
  {
    version: 4,
    description: 'Quality and saliency_kind columns',
    up(db) {
      addColumnIfMissing(db, 'notes', 'quality', 'TEXT');
      addColumnIfMissing(db, 'notes', 'saliency_kind', 'TEXT');
    },
  },
  {
    version: 5,
    description: 'Phase 3 pre-computed cosine neighbours',
    up(db) {
      addColumnIfMissing(db, 'notes', 'related', 'TEXT');
    },
  },
  {
    version: 6,
    description: 'Haiku #8 multi-axis indexing columns',
    up(db) {
      for (const col of [
        'questions',
        'error_patterns',
        'aliases',
        'section_summary',
        'section_reasoning',
        'section_qa',
        'section_tool_trace',
      ]) {
        addColumnIfMissing(db, 'notes', col, 'TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_questions      ON notes(questions)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_error_patterns ON notes(error_patterns)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_aliases        ON notes(aliases)');
    },
  },
  {
    version: 7,
    description: 'Anti-pattern warnings column',
    up(db) {
      addColumnIfMissing(db, 'notes', 'warnings', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_warnings ON notes(warnings)');
    },
  },
  {
    version: 8,
    description: 'TLDR and topic columns',
    up(db) {
      addColumnIfMissing(db, 'notes', 'section_tldr', 'TEXT');
      addColumnIfMissing(db, 'notes', 'topic', 'TEXT');
      addColumnIfMissing(db, 'notes', 'tldr', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic)');
    },
  },
  {
    version: 9,
    description: 'note_embeddings table for pre-computed vectors',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS note_embeddings (
          id TEXT PRIMARY KEY,
          embed_text_hash TEXT NOT NULL,
          vector BLOB NOT NULL
        )
      `);
    },
  },
  {
    version: 10,
    description: 'model_id column on note_embeddings — embedding-model cache versioning',
    up(db) {
      // Nullable: existing rows predate model tracking and get SQL NULL, which
      // the read path (embedding-store.ts) treats as "unknown model" — i.e.
      // never matches the current model, so the stale vector is re-embedded
      // instead of silently served. See resolveCorpusVectors() in l3.ts.
      addColumnIfMissing(db, 'note_embeddings', 'model_id', 'TEXT');
    },
  },
  {
    version: 11,
    description: 'Contradiction detection: conflict_with column',
    up(db) {
      // Comma-separated ids of the notes this note contradicts, mirrored from
      // the note's data-cerveau-conflict-with attribute (written by
      // graph/contradictions.ts). Persisted so the /_api/notes and
      // /_api/note-meta routes can surface the contradiction signal to the
      // frontend wiki view without re-parsing note HTML.
      addColumnIfMissing(db, 'notes', 'conflict_with', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notes_conflict_with ON notes(conflict_with)');
    },
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

function ensureMigrationsTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

function appliedVersions(db: DB): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((r) => r.version));
}

/**
 * Detect whether this is a legacy brain: notes table exists but
 * schema_migrations does not.  Returns true when baseline detection applies.
 */
function isLegacyBrain(db: DB): boolean {
  const tables = db.pragma('table_list') as Array<{ name: string }>;
  const hasNotes = tables.some((t) => t.name === 'notes');
  const hasMigrations = tables.some((t) => t.name === 'schema_migrations');
  return hasNotes && !hasMigrations;
}

function runPendingMigrations(db: DB): void {
  const applied = appliedVersions(db);
  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    m.up(db);
    insert.run(m.version, now);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Initialise the schema and run pending migrations.
 *
 * Called once per DB connection by db.ts after opening the file.
 *
 * Flow:
 *   1. Create base tables (notes, notes_fts, base indexes) — idempotent DDL.
 *   2. If legacy brain detected (notes exists, no schema_migrations): create
 *      the migrations table, run all steps idempotently, record versions.
 *   3. Otherwise: create migrations table if missing, then run any steps not
 *      yet recorded (handles fresh DBs and partial upgrades).
 */
export function initSchema(db: DB): void {
  // Step 1: baseline tables
  db.exec(BASE_DDL);

  // Step 2/3: migrations
  if (isLegacyBrain(db)) {
    // Legacy brain — create the tracking table, apply all steps idempotently,
    // then record every version as applied.
    ensureMigrationsTable(db);
    runPendingMigrations(db);
  } else {
    ensureMigrationsTable(db);
    runPendingMigrations(db);
  }
}

// Export for tests
export { MIGRATIONS, columnExists };
