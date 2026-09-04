#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/server/brain-context.ts
import { AsyncLocalStorage } from "node:async_hooks";
function runWithBrainContext(context, fn) {
  return storage.run(context, fn);
}
function enterBrainContext(context) {
  storage.enterWith(context);
}
function getActiveBrainContext() {
  return storage.getStore();
}
var storage;
var init_brain_context = __esm({
  "src/server/brain-context.ts"() {
    "use strict";
    storage = new AsyncLocalStorage();
  }
});

// src/util/config.ts
var config_exports = {};
__export(config_exports, {
  getConfig: () => getConfig,
  resetConfigForTests: () => resetConfigForTests,
  resetDocumentsWarningForTests: () => resetDocumentsWarningForTests
});
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
function discoverBrainPath() {
  if (process.env.LAZYBRAIN_BRAIN_PATH_CLI) {
    return process.env.LAZYBRAIN_BRAIN_PATH_CLI;
  }
  if (process.env.LAZYBRAIN_BRAIN_PATH) {
    return process.env.LAZYBRAIN_BRAIN_PATH;
  }
  const lazybrainDir = walkUpForDotDir(process.cwd(), ".lazybrain");
  if (lazybrainDir !== null) {
    return join(lazybrainDir, "brain");
  }
  const docsMatch = findInDocuments();
  if (docsMatch !== null) {
    if (!_documentsWarningEmitted) {
      _documentsWarningEmitted = true;
      process.stderr.write(
        `[lazybrain] WARN: brain discovered via legacy ~/Documents scan (${docsMatch}). Set LAZYBRAIN_BRAIN_PATH or place a .lazybrain/ directory in your project root to silence this.
`
      );
    }
    return docsMatch;
  }
  return join(homedir(), ".lazybrain", "brain");
}
function walkUpForDotDir(startDir, dotDirName) {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, dotDirName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function findInDocuments() {
  const docs = join(homedir(), "Documents");
  if (!existsSync(docs)) return null;
  try {
    const match = readdirSync(docs).find(
      (d) => d.startsWith("Lazy-Brain") && existsSync(join(docs, d, "brain", "notes"))
    );
    return match ? join(docs, match, "brain") : null;
  } catch {
    return null;
  }
}
function getConfig() {
  const base = resolveDefaultConfig();
  const active = getActiveBrainContext();
  if (!active) return base;
  return { ...base, brainPath: active.brainPath, cachePath: active.cachePath };
}
function resolveDefaultConfig() {
  if (cached) return cached;
  const brainPath = discoverBrainPath();
  const resolvedBrain = resolve(brainPath);
  if (!existsSync(resolvedBrain)) {
    const isFallback = resolvedBrain === resolve(join(homedir(), ".lazybrain", "brain")) || process.env.LAZYBRAIN_BRAIN_PATH !== void 0 || process.env.LAZYBRAIN_BRAIN_PATH_CLI !== void 0;
    if (!isFallback) {
      throw new Error(`Brain path does not exist: ${resolvedBrain}`);
    }
    mkdirSync(resolvedBrain, { recursive: true });
  }
  const cachePath3 = process.env.LAZYBRAIN_CACHE_PATH ? resolve(process.env.LAZYBRAIN_CACHE_PATH) : resolve(resolvedBrain, "_cache");
  const modelsPath = process.env.LAZYBRAIN_MODELS_PATH ? resolve(process.env.LAZYBRAIN_MODELS_PATH) : join(homedir(), ".lazybrain", "models");
  if (!process.env.LAZYBRAIN_CACHE_PATH) {
    const markerPath = join(resolvedBrain, CACHE_MIGRATION_MARKER);
    if (!existsSync(markerPath)) {
      if (!existsSync(cachePath3)) {
        const legacyCachePath = resolve(dirname(resolvedBrain), "_cache");
        if (existsSync(legacyCachePath)) {
          migrateLegacyCache(legacyCachePath, cachePath3);
        }
      }
      writeMigrationMarker(markerPath);
    }
  }
  if (!existsSync(cachePath3)) mkdirSync(cachePath3, { recursive: true });
  if (!existsSync(modelsPath)) mkdirSync(modelsPath, { recursive: true });
  const logLevel = process.env.LAZYBRAIN_LOG_LEVEL ?? "info";
  const telemetry = process.env.LAZYBRAIN_TELEMETRY !== "0";
  cached = { brainPath: resolvedBrain, cachePath: cachePath3, modelsPath, logLevel, telemetry };
  return cached;
}
function migrateLegacyCache(legacyDir, newDir) {
  try {
    mkdirSync(newDir, { recursive: true });
    const files = readdirSync(legacyDir);
    for (const file of files) {
      try {
        copyFileSync(join(legacyDir, file), join(newDir, file));
      } catch {
      }
    }
    process.stderr.write(`[lazybrain] INFO: migrated cache from ${legacyDir} to ${newDir}
`);
  } catch (err) {
    process.stderr.write(
      `[lazybrain] WARN: cache migration from ${legacyDir} failed (${err.message}); starting with a fresh cache.
`
    );
  }
}
function writeMigrationMarker(markerPath) {
  try {
    writeFileSync(markerPath, `${(/* @__PURE__ */ new Date()).toISOString()}
`, "utf-8");
  } catch {
  }
}
function resetConfigForTests() {
  cached = null;
}
function resetDocumentsWarningForTests() {
  _documentsWarningEmitted = false;
}
var cached, CACHE_MIGRATION_MARKER, _documentsWarningEmitted;
var init_config = __esm({
  "src/util/config.ts"() {
    "use strict";
    init_brain_context();
    cached = null;
    CACHE_MIGRATION_MARKER = ".cache-migrated";
    _documentsWarningEmitted = false;
  }
});

// src/store/paths.ts
import { join as join2 } from "node:path";
function brainRoot() {
  return getConfig().brainPath;
}
function notesDir() {
  return join2(brainRoot(), "notes");
}
function batchesDir() {
  return join2(brainRoot(), "batches");
}
function knowledgeNodesDir() {
  return join2(brainRoot(), "knowledge-nodes");
}
function metaDir() {
  return join2(brainRoot(), "meta");
}
function indexPath() {
  return join2(getConfig().cachePath, FTS_DB_FILENAME);
}
function notePath(id, createdISO) {
  const date = createdISO ? new Date(createdISO) : /* @__PURE__ */ new Date();
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  return join2(notesDir(), `${yyyy}-${mm}`, `${slug(id)}.html`);
}
function knowledgeNodePath(nodeId) {
  return join2(knowledgeNodesDir(), `${slug(nodeId)}.html`);
}
function slug(id) {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/, "");
}
var FTS_DB_FILENAME;
var init_paths = __esm({
  "src/store/paths.ts"() {
    "use strict";
    init_config();
    FTS_DB_FILENAME = "fts.sqlite";
  }
});

// src/indexer/schema.ts
function columnExists(db, table, column) {
  const rows = db.pragma(`table_info(${table})`);
  return rows.some((r) => r.name === column);
}
function addColumnIfMissing(db, table, column, definition) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}
function appliedVersions(db) {
  const rows = db.prepare("SELECT version FROM schema_migrations").all();
  return new Set(rows.map((r) => r.version));
}
function isLegacyBrain(db) {
  const tables = db.pragma("table_list");
  const hasNotes = tables.some((t) => t.name === "notes");
  const hasMigrations = tables.some((t) => t.name === "schema_migrations");
  return hasNotes && !hasMigrations;
}
function runPendingMigrations(db) {
  const applied = appliedVersions(db);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)"
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    m.up(db);
    insert.run(m.version, now);
  }
}
function initSchema(db) {
  db.exec(BASE_DDL);
  if (isLegacyBrain(db)) {
    ensureMigrationsTable(db);
    runPendingMigrations(db);
  } else {
    ensureMigrationsTable(db);
    runPendingMigrations(db);
  }
}
var BASE_DDL, MIGRATIONS;
var init_schema = __esm({
  "src/indexer/schema.ts"() {
    "use strict";
    BASE_DDL = `
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
    MIGRATIONS = [
      {
        version: 1,
        description: "P1 relation columns",
        up(db) {
          for (const col of [
            "triples",
            "causes",
            "replaces",
            "replaced_by",
            "supersedes",
            "entities"
          ]) {
            addColumnIfMissing(db, "notes", col, "TEXT");
          }
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_entities ON notes(entities)");
        }
      },
      {
        version: 2,
        description: "B4 access tracking columns",
        up(db) {
          addColumnIfMissing(db, "notes", "access_count", "INTEGER DEFAULT 0");
          addColumnIfMissing(db, "notes", "last_accessed", "TEXT");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_access ON notes(access_count, last_accessed)");
        }
      },
      {
        version: 3,
        description: "Wikipedia concepts column",
        up(db) {
          addColumnIfMissing(db, "notes", "concepts", "TEXT");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_concepts ON notes(concepts)");
        }
      },
      {
        version: 4,
        description: "Quality and saliency_kind columns",
        up(db) {
          addColumnIfMissing(db, "notes", "quality", "TEXT");
          addColumnIfMissing(db, "notes", "saliency_kind", "TEXT");
        }
      },
      {
        version: 5,
        description: "Phase 3 pre-computed cosine neighbours",
        up(db) {
          addColumnIfMissing(db, "notes", "related", "TEXT");
        }
      },
      {
        version: 6,
        description: "Haiku #8 multi-axis indexing columns",
        up(db) {
          for (const col of [
            "questions",
            "error_patterns",
            "aliases",
            "section_summary",
            "section_reasoning",
            "section_qa",
            "section_tool_trace"
          ]) {
            addColumnIfMissing(db, "notes", col, "TEXT");
          }
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_questions      ON notes(questions)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_error_patterns ON notes(error_patterns)");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_aliases        ON notes(aliases)");
        }
      },
      {
        version: 7,
        description: "Anti-pattern warnings column",
        up(db) {
          addColumnIfMissing(db, "notes", "warnings", "TEXT");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_warnings ON notes(warnings)");
        }
      },
      {
        version: 8,
        description: "TLDR and topic columns",
        up(db) {
          addColumnIfMissing(db, "notes", "section_tldr", "TEXT");
          addColumnIfMissing(db, "notes", "topic", "TEXT");
          addColumnIfMissing(db, "notes", "tldr", "TEXT");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_topic ON notes(topic)");
        }
      },
      {
        version: 9,
        description: "note_embeddings table for pre-computed vectors",
        up(db) {
          db.exec(`
        CREATE TABLE IF NOT EXISTS note_embeddings (
          id TEXT PRIMARY KEY,
          embed_text_hash TEXT NOT NULL,
          vector BLOB NOT NULL
        )
      `);
        }
      },
      {
        version: 10,
        description: "model_id column on note_embeddings \u2014 embedding-model cache versioning",
        up(db) {
          addColumnIfMissing(db, "note_embeddings", "model_id", "TEXT");
        }
      },
      {
        version: 11,
        description: "Contradiction detection: conflict_with column",
        up(db) {
          addColumnIfMissing(db, "notes", "conflict_with", "TEXT");
          db.exec("CREATE INDEX IF NOT EXISTS idx_notes_conflict_with ON notes(conflict_with)");
        }
      }
    ];
  }
});

// src/indexer/db.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
import Database from "better-sqlite3";
function getDb() {
  const path = indexPath();
  const existing = dbByPath.get(path);
  if (existing) return existing;
  if (!existsSync2(dirname2(path))) mkdirSync2(dirname2(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  initSchema(db);
  dbByPath.set(path, db);
  return db;
}
function getReadonlyDb() {
  const path = indexPath();
  const existing = readonlyDbByPath.get(path);
  if (existing) return existing;
  const db = new Database(path, { readonly: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  readonlyDbByPath.set(path, db);
  return db;
}
function closeDb() {
  for (const db of dbByPath.values()) db.close();
  dbByPath.clear();
  for (const db of readonlyDbByPath.values()) db.close();
  readonlyDbByPath.clear();
}
function closeDbForPath(path) {
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
var dbByPath, readonlyDbByPath;
var init_db = __esm({
  "src/indexer/db.ts"() {
    "use strict";
    init_paths();
    init_schema();
    dbByPath = /* @__PURE__ */ new Map();
    readonlyDbByPath = /* @__PURE__ */ new Map();
  }
});

// src/util/tokenize.ts
function splitIdentifier(ident) {
  const segments = ident.split(/[_\-./\\]+/).filter(Boolean);
  const out = [];
  for (const seg of segments) {
    const camel = seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
    for (const tok of camel.split(/\s+/)) {
      if (tok.length >= 2) out.push(tok);
    }
  }
  return out;
}
function augmentTextForIndex(text) {
  if (!text) return text;
  const existingLower = new Set(text.toLowerCase().split(/\s+/));
  const added = /* @__PURE__ */ new Set();
  IDENT_RE.lastIndex = 0;
  for (let m = IDENT_RE.exec(text); m !== null; m = IDENT_RE.exec(text)) {
    const ident = m[1] ?? m[0];
    const parts = splitIdentifier(ident);
    if (parts.length <= 1) continue;
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low.length < 3) continue;
      if (existingLower.has(low)) continue;
      added.add(p);
    }
  }
  if (added.size === 0) return text;
  return `${text}
[tokens] ${[...added].join(" ")}`;
}
function extractConcepts(text) {
  if (!text) return [];
  const found = /* @__PURE__ */ new Set();
  IDENT_RE.lastIndex = 0;
  for (let m = IDENT_RE.exec(text); m !== null; m = IDENT_RE.exec(text)) {
    const ident = m[1] ?? m[0];
    for (const suf of CONCEPT_SUFFIXES) {
      if (ident.endsWith(suf) && ident.length > suf.length) {
        found.add(suf);
        break;
      }
    }
    for (const pre of CONCEPT_PREFIXES) {
      if (ident.startsWith(pre) && ident.length > pre.length) {
        found.add(pre);
        break;
      }
    }
  }
  return [...found].slice(0, 12);
}
function expandQuery(query) {
  const variants = /* @__PURE__ */ new Set([query]);
  const augmented = augmentTextForIndex(query);
  if (augmented !== query) {
    variants.add(augmented.replace(/\n\[tokens\]\s*/, " "));
  }
  const concepts = extractConcepts(query);
  if (concepts.length > 0) variants.add(concepts.join(" "));
  return [...variants];
}
function estimateTokenCount(text) {
  if (!text) return 0;
  const nonAlpha = text.replace(/[a-zA-Z0-9\s]/g, "").length;
  const ratio = text.length > 0 ? nonAlpha / text.length : 0;
  const tokensPerChar = ratio > 0.3 ? 0.33 : 0.25;
  return Math.ceil(text.length * tokensPerChar);
}
var IDENT_RE, CONCEPT_SUFFIXES, CONCEPT_PREFIXES;
var init_tokenize = __esm({
  "src/util/tokenize.ts"() {
    "use strict";
    IDENT_RE = /\b[A-Za-z][A-Za-z0-9_.\-/]{2,80}\b/g;
    CONCEPT_SUFFIXES = [
      "Repository",
      "Service",
      "Controller",
      "Manager",
      "Adapter",
      "Provider",
      "Builder",
      "Factory",
      "Strategy",
      "Observer",
      "Subject",
      "Visitor",
      "Handler",
      "Wrapper",
      "Decorator",
      "Resolver",
      "Validator",
      "Serializer",
      "Pattern",
      "Convention",
      "Schema",
      "Model",
      "Entity",
      "View",
      "Middleware",
      "Plugin",
      "Hook",
      "Helper",
      "Util",
      "Utils"
    ];
    CONCEPT_PREFIXES = ["Abstract", "Base", "Default"];
  }
});

// src/indexer/fts-search.ts
function tokenizeForFts(input) {
  return input.replace(/["']/g, " ").split(/\s+/).flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u)).map((t) => t.replace(/^[^\w]+|[^\w]+$/g, "")).filter((t) => t.length > 1);
}
function ftsQuery(input) {
  const tokens = tokenizeForFts(input);
  if (tokens.length === 0) return "";
  const isQuestion = /^(?:what|why|how|when|where|which|who|should|can|could|is|are|do|does)\b/i.test(
    input.trim()
  ) || tokens.length >= 6;
  const parts = tokens.map((t) => {
    const safe = t.replace(/"/g, '""');
    return t.length >= 3 ? `"${safe}"*` : `"${safe}"`;
  });
  return isQuestion ? parts.join(" OR ") : parts.join(" ");
}
function ftsQueryFallback(input) {
  const tokens = tokenizeForFts(input).filter((t) => t.length >= 3).slice(0, 8);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
function ftsQueryOr(input) {
  const tokens = tokenizeForFts(input);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}
function shouldAttemptOrFallback(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith('"')) return false;
  const tokens = tokenizeForFts(trimmed);
  return tokens.length >= 2;
}
function sourceFilterClause(opts) {
  if (!opts.sourcePrefix) return { clause: "", params: {} };
  return {
    clause: "AND n.source LIKE @sourcePrefix",
    params: { sourcePrefix: `${opts.sourcePrefix}%` }
  };
}
function searchFts(query, opts = {}) {
  const db = getDb();
  const limit = opts.limit ?? 10;
  const where = [];
  const q = ftsQuery(query);
  if (!q) return [];
  const src = sourceFilterClause(opts);
  const params = { q, limit, ...src.params };
  if (!opts.includeExpired) where.push(`(n.valid_until IS NULL OR n.valid_until = '')`);
  if (opts.type) {
    where.push("n.type = @type");
    params.type = opts.type;
  }
  if (opts.tag) {
    where.push("n.tags LIKE @tagLike");
    params.tagLike = `%${opts.tag}%`;
  }
  if (src.clause) where.push(src.clause.replace(/^AND /, ""));
  const whereClause = where.length ? `AND ${where.join(" AND ")}` : "";
  const sql = `
    SELECT
      n.id AS id,
      n.path AS path,
      n.title AS title,
      snippet(notes_fts, 2, '<mark>', '</mark>', '\u2026', 16) AS snippet,
      -bm25(notes_fts) AS bm25
    FROM notes_fts
    JOIN notes n ON n.id = notes_fts.id
    WHERE notes_fts MATCH @q
      ${whereClause}
    ORDER BY bm25 DESC
    LIMIT @limit
  `;
  let hits;
  try {
    hits = db.prepare(sql).all(params);
  } catch {
    const fallback = ftsQueryFallback(query);
    if (!fallback) return [];
    try {
      hits = db.prepare(sql).all({ ...params, q: fallback });
    } catch {
      return [];
    }
    return hits.map((h) => ({ ...h, bm25: h.bm25 * 0.5 }));
  }
  if (hits.length === 0 && shouldAttemptOrFallback(query)) {
    const orQuery = ftsQueryOr(query);
    if (!orQuery) return [];
    try {
      const orHits = db.prepare(sql).all({ ...params, q: orQuery });
      return orHits.map((h) => ({ ...h, bm25: h.bm25 * 0.5 }));
    } catch {
      return [];
    }
  }
  return hits;
}
function searchFtsSpread(query, opts = {}) {
  const limit = opts.limit ?? 10;
  const variants = expandQuery(query);
  const weights = [];
  for (let i = 0; i < variants.length; i++) {
    if (i === 0) weights.push(1);
    else if (i === 1) weights.push(0.8);
    else weights.push(0.5);
  }
  const RRF_K2 = 60;
  const fused = /* @__PURE__ */ new Map();
  const best = /* @__PURE__ */ new Map();
  for (let vi = 0; vi < variants.length; vi++) {
    const variant = variants[vi];
    const weight = weights[vi] ?? 0.5;
    const variantHits = searchFts(variant, { ...opts, limit: limit * 2 });
    for (let rank = 0; rank < variantHits.length; rank++) {
      const h = variantHits[rank];
      const contrib = weight / (RRF_K2 + rank);
      fused.set(h.id, (fused.get(h.id) ?? 0) + contrib);
      const existing = best.get(h.id);
      if (!existing || h.bm25 > existing.bm25) {
        best.set(h.id, h);
      }
    }
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, score]) => {
    const hit = best.get(id);
    if (!hit) return null;
    return { ...hit, bm25: score };
  }).filter((h) => h !== null);
}
var init_fts_search = __esm({
  "src/indexer/fts-search.ts"() {
    "use strict";
    init_tokenize();
    init_db();
  }
});

// src/indexer/corpus-cache.ts
function bumpLocalWriteVersion() {
  localWriteVersion += 1;
}
function readSnapshot(db, table) {
  const dataVersion = db.pragma("data_version", { simple: true });
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return { dataVersion, rowCount: row?.n ?? 0, localWriteVersion };
}
function sameSnapshot(a, b) {
  return a.dataVersion === b.dataVersion && a.rowCount === b.rowCount && a.localWriteVersion === b.localWriteVersion;
}
var localWriteVersion, SnapshotCache;
var init_corpus_cache = __esm({
  "src/indexer/corpus-cache.ts"() {
    "use strict";
    localWriteVersion = 0;
    SnapshotCache = class {
      entries = /* @__PURE__ */ new Map();
      /**
       * Return the cached value for `key` if the freshness snapshot still
       * matches; otherwise run `load()`, cache the result under the CURRENT
       * snapshot, and return it.
       */
      resolve(db, table, key, load2) {
        const snapshot = readSnapshot(db, table);
        const cacheKey2 = `${db.name}::${key}`;
        const existing = this.entries.get(cacheKey2);
        if (existing && sameSnapshot(existing.snapshot, snapshot)) {
          return existing.value;
        }
        const value = load2();
        this.entries.set(cacheKey2, { snapshot, value });
        return value;
      }
      /** Drop every cached entry. Test-only. */
      clear() {
        this.entries.clear();
      }
    };
  }
});

// src/indexer/embedding-store.ts
function upsertNoteEmbedding(id, embedTextHash, vector, modelId = null) {
  const db = getDb();
  const buf = Buffer.allocUnsafe(EMB_DIM * 4);
  for (let i = 0; i < EMB_DIM; i++) {
    buf.writeFloatLE(vector[i] ?? 0, i * 4);
  }
  db.prepare(`
    INSERT INTO note_embeddings (id, embed_text_hash, vector, model_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      embed_text_hash=excluded.embed_text_hash,
      vector=excluded.vector,
      model_id=excluded.model_id
  `).run(id, embedTextHash, buf, modelId);
  bumpLocalWriteVersion();
}
function loadAllStoredEmbeddings() {
  const db = getDb();
  try {
    return embeddingsCache.resolve(db, "note_embeddings", "all", () => {
      const result = /* @__PURE__ */ new Map();
      const rows = db.prepare("SELECT id, embed_text_hash, vector, model_id FROM note_embeddings").all();
      for (const row of rows) {
        const vec = new Float32Array(EMB_DIM);
        const buf = row.vector;
        for (let i = 0; i < EMB_DIM; i++) {
          vec[i] = buf.readFloatLE(i * 4);
        }
        result.set(row.id, {
          id: row.id,
          embedTextHash: row.embed_text_hash,
          modelId: row.model_id ?? null,
          vector: vec
        });
      }
      return result;
    });
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
var EMB_DIM, embeddingsCache;
var init_embedding_store = __esm({
  "src/indexer/embedding-store.ts"() {
    "use strict";
    init_corpus_cache();
    init_db();
    EMB_DIM = 768;
    embeddingsCache = new SnapshotCache();
  }
});

// src/util/logger.ts
import { createRequire } from "node:module";
import pino from "pino";
function isPinoPrettyAvailable() {
  try {
    const req = createRequire(import.meta.url);
    req.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}
function getLogger() {
  if (cached2) return cached2;
  const cfg = getConfig();
  const usePretty = process.stderr.isTTY && cfg.logLevel === "debug" && isPinoPrettyAvailable();
  cached2 = pino({
    level: cfg.logLevel,
    base: { app: "lazybrain" },
    transport: usePretty ? { target: "pino-pretty", options: { colorize: true } } : void 0
  });
  return cached2;
}
var cached2;
var init_logger = __esm({
  "src/util/logger.ts"() {
    "use strict";
    init_config();
    cached2 = null;
  }
});

// src/util/telemetry.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";
function logTelemetry(event) {
  const cfg = getConfig();
  if (!cfg.telemetry) return;
  try {
    const path = join3(cfg.cachePath, "telemetry.jsonl");
    if (!existsSync3(dirname3(path))) mkdirSync3(dirname3(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}
`, "utf8");
  } catch {
  }
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var init_telemetry = __esm({
  "src/util/telemetry.ts"() {
    "use strict";
    init_config();
  }
});

// src/indexer/embeddings.ts
import { existsSync as existsSync4, readFileSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
import { env, pipeline } from "@huggingface/transformers";
function capCache(map) {
  const overflow = map.size - MAX_CACHE_ENTRIES;
  if (overflow <= 0) return;
  const it = map.keys();
  for (let i = 0; i < overflow; i++) {
    const next = it.next();
    if (next.done) break;
    map.delete(next.value);
  }
}
function embeddingCacheStats() {
  return { entries: cache?.size ?? 0, maxEntries: MAX_CACHE_ENTRIES };
}
function willTriggerRemoteDownload(modelsPath, modelId, allowRemote) {
  if (!allowRemote) return false;
  return !isModelCached(modelsPath, modelId);
}
function isModelCached(modelsPath, modelId) {
  const flatDir = join4(modelsPath, modelId.replace("/", "--"));
  const nestedDir = join4(modelsPath, modelId);
  try {
    return existsSync4(flatDir) || existsSync4(nestedDir);
  } catch {
    return false;
  }
}
function printDownloadNotice(modelId, cacheDir) {
  process.stderr.write(
    `LazyBrain: downloading ${modelId} (~290 MB) to ${cacheDir} \u2014 first semantic-search use only. Set LAZYBRAIN_ALLOW_REMOTE_MODELS=0 to forbid downloads.
`
  );
}
function printOptInHint(cacheDir) {
  process.stderr.write(
    `LazyBrain: Semantic search (L3/L4) needs local ONNX models (~380 MB). Run \`npm run download-models\` once, or set LAZYBRAIN_ALLOW_REMOTE_MODELS=1 to allow on-demand download. Models would be stored in ${cacheDir}. Falling back to keyword search (L2).
`
  );
}
function isEmbeddingsDisabledByEnv() {
  const v = process.env.LAZYBRAIN_EMBEDDINGS;
  return v === "0" || v === "false";
}
async function getEmbedder() {
  if (pipe) return pipe;
  if (embedderUnavailable) return null;
  if (!pipePromise) {
    pipePromise = loadEmbedder().catch((err) => {
      pipePromise = null;
      throw err;
    });
  }
  return pipePromise;
}
async function loadEmbedder() {
  if (isEmbeddingsDisabledByEnv()) {
    embedderUnavailable = true;
    if (!noticePrinted.has(MODEL_ID)) {
      process.stderr.write(
        "LazyBrain: semantic search (L3/L4) disabled via LAZYBRAIN_EMBEDDINGS=0 \u2014 using keyword search (L2) only.\n"
      );
      noticePrinted.add(MODEL_ID);
    }
    return null;
  }
  const cfg = getConfig();
  env.localModelPath = cfg.modelsPath;
  env.cacheDir = cfg.modelsPath;
  const envVal = process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
  const remoteAllowed = envVal === "1";
  const remoteExplicitlyForbidden = envVal === "0";
  const remoteUnset = envVal === void 0 || envVal === "";
  if (remoteUnset) {
    const cached3 = isModelCached(cfg.modelsPath, MODEL_ID);
    if (!cached3) {
      embedderUnavailable = true;
      if (!noticePrinted.has(MODEL_ID)) {
        printOptInHint(cfg.modelsPath);
        noticePrinted.add(MODEL_ID);
      }
      return null;
    }
    env.allowRemoteModels = false;
  } else if (remoteAllowed) {
    env.allowRemoteModels = true;
    if (!noticePrinted.has(MODEL_ID) && willTriggerRemoteDownload(cfg.modelsPath, MODEL_ID, true)) {
      printDownloadNotice(MODEL_ID, cfg.modelsPath);
      noticePrinted.add(MODEL_ID);
    }
  } else if (remoteExplicitlyForbidden) {
    env.allowRemoteModels = false;
    if (!isModelCached(cfg.modelsPath, MODEL_ID)) {
      embedderUnavailable = true;
      return null;
    }
  }
  try {
    pipe = await pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8"
    });
    return pipe;
  } catch (err) {
    embedderUnavailable = true;
    getLogger().warn(
      { err: err.message, modelsPath: cfg.modelsPath },
      "lazybrain: ONNX embedding model unavailable \u2014 L3/L4 search will fall back to FTS (L2). Run `npm run download-models` to enable semantic search."
    );
    return null;
  }
}
async function embed(texts) {
  if (texts.length === 0) return [];
  const log = getLogger();
  const cacheMap = loadCache();
  const start = Date.now();
  const result = new Array(texts.length);
  const todo = [];
  let hits = 0;
  for (let i = 0; i < texts.length; i++) {
    const key = hashKey(texts[i]);
    const cached3 = cacheMap.get(key);
    if (cached3) {
      result[i] = cached3;
      hits += 1;
    } else {
      todo.push({ idx: i, text: texts[i], key });
    }
  }
  if (todo.length > 0) {
    const embedder = await getEmbedder();
    if (!embedder) {
      for (const { idx } of todo) {
        result[idx] = new Float32Array(DIM);
      }
    } else {
      for (let start2 = 0; start2 < todo.length; start2 += EMBED_BATCH_SIZE) {
        const chunk = todo.slice(start2, start2 + EMBED_BATCH_SIZE);
        const batchTexts = chunk.map((t) => t.text);
        const tensor = await embedder(batchTexts, { pooling: "mean", normalize: true });
        const flat = tensor.data;
        for (let i = 0; i < chunk.length; i++) {
          const { idx, key } = chunk[i];
          const arr = new Float32Array(flat.slice(i * DIM, (i + 1) * DIM));
          result[idx] = arr;
          cacheMap.set(key, arr);
        }
      }
      capCache(cacheMap);
      saveCache(cacheMap);
    }
  }
  const duration = Date.now() - start;
  log.debug({ texts: texts.length, todo: todo.length, hits, duration_ms: duration }, "embed batch");
  logTelemetry({
    event: "embed",
    ts: nowIso(),
    texts: texts.length,
    duration_ms: duration,
    cache_hit: hits,
    cache_miss: todo.length
  });
  return result;
}
async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}
function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
function topKCosine(query, corpus, k) {
  const heap = [];
  for (const { id, vector } of corpus) {
    const score = cosine(query, vector);
    if (heap.length < k) {
      heap.push({ id, score });
      heap.sort((a, b) => a.score - b.score);
    } else if (score > heap[0].score) {
      heap[0] = { id, score };
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.reverse();
}
function hashKey(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16);
}
function loadCache() {
  if (cache) return cache;
  const cfg = getConfig();
  cachePath = join4(cfg.cachePath, "embeddings.bin");
  cache = /* @__PURE__ */ new Map();
  if (existsSync4(cachePath)) {
    try {
      const buf = readFileSync(cachePath);
      let offset = 0;
      const hasMagic = buf.length >= CACHE_MAGIC.length && buf.subarray(0, CACHE_MAGIC.length).equals(CACHE_MAGIC);
      if (!hasMagic) {
        getLogger().info(
          { modelId: MODEL_ID },
          "embedding cache invalidated: pre-versioning legacy cache (no model info) \u2014 re-embedding lazily on demand"
        );
        return cache;
      }
      offset += CACHE_MAGIC.length;
      const modelIdLen = buf.readUInt16LE(offset);
      offset += 2;
      const storedModelId = buf.subarray(offset, offset + modelIdLen).toString("utf8");
      offset += modelIdLen;
      if (storedModelId !== MODEL_ID) {
        getLogger().info(
          { previousModelId: storedModelId, modelId: MODEL_ID },
          "embedding cache invalidated: embedding model changed \u2014 re-embedding lazily on demand"
        );
        return cache;
      }
      const count = buf.readUInt32LE(offset);
      offset += 4;
      for (let i = 0; i < count; i++) {
        const keyLen = buf.readUInt8(offset);
        offset += 1;
        const key = buf.subarray(offset, offset + keyLen).toString("utf8");
        offset += keyLen;
        const vec = new Float32Array(DIM);
        for (let j = 0; j < DIM; j++) {
          vec[j] = buf.readFloatLE(offset);
          offset += 4;
        }
        cache.set(key, vec);
      }
      capCache(cache);
    } catch (err) {
      getLogger().warn({ err: err.message }, "corrupt embedding cache, ignoring");
      cache = /* @__PURE__ */ new Map();
    }
  }
  return cache;
}
function saveCache(map) {
  if (!cachePath) return;
  const modelIdBytes = Buffer.from(MODEL_ID, "utf8");
  let size = CACHE_MAGIC.length + 2 + modelIdBytes.length + 4;
  for (const [k] of map) size += 1 + Buffer.byteLength(k, "utf8") + DIM * 4;
  const buf = Buffer.alloc(size);
  let offset = 0;
  CACHE_MAGIC.copy(buf, offset);
  offset += CACHE_MAGIC.length;
  buf.writeUInt16LE(modelIdBytes.length, offset);
  offset += 2;
  modelIdBytes.copy(buf, offset);
  offset += modelIdBytes.length;
  buf.writeUInt32LE(map.size, offset);
  offset += 4;
  for (const [key, vec] of map) {
    const keyBytes = Buffer.from(key, "utf8");
    buf.writeUInt8(keyBytes.length, offset);
    offset += 1;
    keyBytes.copy(buf, offset);
    offset += keyBytes.length;
    for (let j = 0; j < DIM; j++) {
      buf.writeFloatLE(vec[j] ?? 0, offset);
      offset += 4;
    }
  }
  writeFileSync2(cachePath, buf);
}
function isEmbedderUnavailable() {
  return embedderUnavailable;
}
var MODEL_ID, DIM, EMBED_BATCH_SIZE, CACHE_MAGIC, pipe, pipePromise, cache, cachePath, embedderUnavailable, MAX_CACHE_ENTRIES, _allowRemoteEnv, _remoteAllowed, noticePrinted;
var init_embeddings = __esm({
  "src/indexer/embeddings.ts"() {
    "use strict";
    init_config();
    init_logger();
    init_telemetry();
    MODEL_ID = "Xenova/paraphrase-multilingual-mpnet-base-v2";
    DIM = 768;
    EMBED_BATCH_SIZE = 8;
    CACHE_MAGIC = Buffer.from("LBC2", "ascii");
    pipe = null;
    pipePromise = null;
    cache = null;
    cachePath = null;
    embedderUnavailable = false;
    MAX_CACHE_ENTRIES = 2e4;
    env.allowLocalModels = true;
    _allowRemoteEnv = process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
    _remoteAllowed = _allowRemoteEnv === "1";
    env.allowRemoteModels = _remoteAllowed;
    noticePrinted = /* @__PURE__ */ new Set();
  }
});

// src/indexer/embed-index.ts
function buildEmbedText(n) {
  const title = (n.title ?? "").trim();
  const tags = (n.tags ?? "").trim();
  const body = (n.text ?? "").slice(0, EMBED_CHAR_LIMIT).trim();
  return [title, tags, body].filter(Boolean).join("\n");
}
async function resolveCorpusVectors(corpus) {
  const stored = loadAllStoredEmbeddings();
  const vectors = new Array(corpus.length);
  const missing = [];
  let modelMismatches = 0;
  for (let i = 0; i < corpus.length; i++) {
    const n = corpus[i];
    const embedText = buildEmbedText(n) || "untitled";
    const hash = hashKey(embedText);
    const cached3 = stored.get(n.id);
    if (cached3 && cached3.embedTextHash === hash && cached3.modelId === MODEL_ID) {
      vectors[i] = cached3.vector;
    } else {
      if (cached3 && cached3.modelId !== MODEL_ID) modelMismatches += 1;
      missing.push({ idx: i, id: n.id, text: embedText, hash });
    }
  }
  if (modelMismatches > 0) {
    getLogger().info(
      { modelMismatches, corpusSize: corpus.length, modelId: MODEL_ID },
      "embedding cache invalidated: stored vectors do not match current embedding model \u2014 re-embedding lazily on demand"
    );
  }
  if (missing.length > 0) {
    const log = getLogger();
    log.debug(
      { missing: missing.length, total: corpus.length },
      "resolveCorpusVectors: computing missing embeddings"
    );
    const texts = missing.map((m) => m.text);
    const computed = await embed(texts);
    for (let j = 0; j < missing.length; j++) {
      const { idx, id, hash } = missing[j];
      const vec = computed[j];
      vectors[idx] = vec;
      upsertNoteEmbedding(id, hash, vec, MODEL_ID);
    }
  }
  return vectors;
}
async function embedNotesForIndex(notes) {
  if (notes.length === 0) return NOOP_RESULT;
  const log = getLogger();
  try {
    const embedder = await getEmbedder();
    if (!embedder) {
      log.debug(
        { notes: notes.length },
        "embedNotesForIndex: embedding model unavailable \u2014 index-time embedding skipped (keyword search still works)"
      );
      return { considered: 0, unavailable: true };
    }
    await resolveCorpusVectors(notes);
    log.debug({ notes: notes.length }, "embedNotesForIndex: corpus vectors resolved");
    return { considered: notes.length, unavailable: false };
  } catch (err) {
    log.warn(
      { err: err.message, notes: notes.length },
      "embedNotesForIndex: embedding pass failed \u2014 continuing without embeddings for this batch (keyword search unaffected)"
    );
    return { considered: 0, unavailable: true };
  }
}
var EMBED_CHAR_LIMIT, NOOP_RESULT;
var init_embed_index = __esm({
  "src/indexer/embed-index.ts"() {
    "use strict";
    init_logger();
    init_embeddings();
    init_embedding_store();
    EMBED_CHAR_LIMIT = 1800;
    NOOP_RESULT = { considered: 0, unavailable: false };
  }
});

// src/retrieval/strip.ts
import { parseHTML } from "linkedom";
function stripTags(html) {
  if (!html) return "";
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  const root = document.body || document.documentElement;
  const walked = extractText(root);
  if (walked) return walked;
  const text = root?.textContent ?? "";
  return text.replace(/[\t\f\v]+/g, " ").replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function extractText(node) {
  if (!node) return "";
  for (const el of Array.from(node.querySelectorAll("script, style, template, noscript"))) {
    el.remove();
  }
  const out = [];
  walk(node, out);
  return out.join("").replace(/[\t\f\v]+/g, " ").replace(/[ \u00A0]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function walk(node, out) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out.push(child.textContent ?? "");
    } else if (child.nodeType === 1) {
      const el = child;
      const tag = el.tagName.toLowerCase();
      if (LIST_ITEM_TAGS.has(tag)) {
        out.push("\n- ");
        walk(el, out);
      } else if (tag === "section") {
        const sectionName = el.getAttribute("data-section");
        if (sectionName === "see-also") {
          const ids = [];
          for (const a of Array.from(el.querySelectorAll("a[href]"))) {
            const href = a.getAttribute("href") ?? "";
            const id = href.startsWith("#") ? href.slice(1) : href;
            if (id) ids.push(id);
          }
          if (ids.length > 0) {
            out.push(`
See also: [${ids.map((id) => `#${id}`).join(", ")}]
`);
          }
        } else if (sectionName === "references") {
          out.push("\n");
          walk(el, out);
          out.push("\n");
        } else {
          if (sectionName && sectionName !== "summary" && sectionName !== "facts") {
            out.push(`
[${sectionName}]
`);
          } else {
            out.push("\n");
          }
          walk(el, out);
          out.push("\n");
        }
      } else if (tag === "details") {
        const factEl = el.querySelector("[data-cerveau-fact]");
        if (factEl) {
          out.push("\n");
          out.push((factEl.textContent ?? "").trim());
          out.push("\n");
        } else {
          walk(el, out);
        }
      } else if (tag === "summary") {
      } else if (tag === "data") {
        const val = el.getAttribute("value");
        if (val) out.push(val, " ");
        walk(el, out);
      } else if (tag === "aside" && el.classList.contains("disambig")) {
        const choices = [];
        for (const a of Array.from(el.querySelectorAll("a[href]"))) {
          const href = a.getAttribute("href") ?? "";
          const linkId = href.startsWith("#") ? href.slice(1) : href;
          if (linkId) choices.push(`#${linkId}`);
        }
        const title = el.getAttribute("data-disambig-term") ?? "X";
        if (choices.length > 0) {
          out.push(`[${title}? choices: ${choices.join(", ")}]
`);
        }
      } else if (tag === "aside" && el.hasAttribute("role")) {
        const role = el.getAttribute("role") ?? "";
        const prefixMap = {
          "doc-tip": "[TIP]",
          "doc-warning": "[WARNING]",
          "doc-example": "[EXAMPLE]",
          "doc-errata": "[ERRATA]",
          "doc-note": "[DECISION]"
        };
        const prefix = prefixMap[role];
        if (prefix) {
          out.push(`${prefix} `);
          walk(el, out);
          out.push("\n");
        } else {
          walk(el, out);
        }
      } else if (tag === "aside" && el.hasAttribute("data-cerveau-suggested-links")) {
        const ids = [];
        for (const a of Array.from(el.querySelectorAll("a[href]"))) {
          const href = a.getAttribute("href") ?? "";
          const linkId = href.startsWith("#") ? href.slice(1) : href;
          if (linkId) ids.push(`#${linkId}`);
        }
        if (ids.length > 0) {
          out.push(`Mentioned (unlinked): ${ids.join(", ")}
`);
        }
      } else if (tag === "aside" && el.classList.contains("glossary")) {
      } else if (tag === "aside" && el.classList.contains("infobox")) {
        const pairs = [];
        const dts = Array.from(el.querySelectorAll("dt"));
        for (const dt of dts) {
          const dtText = (dt.textContent ?? "").trim();
          const dd = dt.nextElementSibling;
          const ddText = dd ? (dd.textContent ?? "").trim() : "";
          if (dtText && ddText) pairs.push(`${dtText}: ${ddText}`);
        }
        if (pairs.length > 0) {
          out.push(`${pairs.join(" | ")}
`);
        }
      } else if (tag === "header" || tag === "footer") {
        walk(el, out);
      } else if (tag === "nav" && el.classList.contains("categories")) {
        const cats = [];
        for (const a of Array.from(el.querySelectorAll("a"))) {
          const text = a.textContent?.trim();
          if (text) cats.push(text);
        }
        if (cats.length > 0) out.push(`Categories: ${cats.join(", ")}
`);
      } else if (tag === "nav" && el.classList.contains("see-also")) {
      } else if (BLOCK_TAGS.has(tag)) {
        out.push("\n");
        walk(el, out);
        out.push("\n");
      } else if (tag === "a") {
        const href = el.getAttribute("href");
        const redLink = el.getAttribute("data-red-link");
        const rel = el.getAttribute("rel");
        const term = (el.textContent ?? "").trim();
        if (redLink) {
          out.push(`[${term}?]`);
        } else if (href?.startsWith("#") && rel) {
          const id = href.slice(1);
          out.push(`[${term}\u2192#${id}|${rel}]`);
        } else if (href?.startsWith("#")) {
          const id = href.slice(1);
          out.push(`[${term}\u2192#${id}]`);
        } else {
          out.push(term);
          if (href) out.push(` (${href})`);
        }
      } else if (tag === "mark") {
        const status = el.getAttribute("data-cerveau-status");
        const bugStatus = el.getAttribute("data-cerveau-bug-status");
        if (status) {
          out.push(`[${status.toUpperCase()}] `);
        } else if (bugStatus) {
          out.push(`[BUG:${bugStatus}] `);
        }
        walk(el, out);
      } else if (tag === "del") {
        const until = el.getAttribute("data-cerveau-valid-until");
        if (until) {
          out.push(`[DEPRECATED until ${until}] `);
        } else {
          out.push("[DEPRECATED] ");
        }
        walk(el, out);
      } else if (tag === "meter") {
        const progress = el.getAttribute("data-cerveau-progress");
        if (progress) {
          out.push(`${progress}% done`);
        } else {
          const value = el.getAttribute("value") ?? "";
          out.push(value ? `${value} conf` : (el.textContent ?? "").trim());
        }
      } else if (tag === "time") {
        const dt = el.getAttribute("datetime") ?? "";
        if (/^P\d+D$/.test(dt)) {
          const days = dt.replace(/[^0-9]/g, "");
          out.push(`valid ${days}d`);
        } else {
          out.push((el.textContent ?? "").trim());
        }
      } else {
        walk(el, out);
      }
    }
  }
}
function extractLeadText(root) {
  const enrichedParts = [];
  let enrichedLen = 0;
  for (const sectionId of ENRICHMENT_SECTION_IDS) {
    const section = root.querySelector(`section[data-section="${sectionId}"]`);
    if (!section) continue;
    const text = extractText(section).trim();
    if (!text) continue;
    enrichedParts.push(text);
    enrichedLen += text.length;
    if (enrichedLen >= LEAD_TEXT_BUDGET) break;
  }
  if (enrichedParts.length > 0) {
    return enrichedParts.join(" ").slice(0, LEAD_TEXT_BUDGET);
  }
  const tldr = root.querySelector('section[data-section="tldr"]');
  if (tldr) {
    const text = extractText(tldr).trim();
    if (text) return text.slice(0, LEAD_TEXT_BUDGET);
  }
  return extractText(root).trim().slice(0, LEAD_TEXT_BUDGET);
}
function stripNote(html) {
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  const root = document.querySelector("article[data-cerveau-version]") ?? document.querySelector("article") ?? document.body;
  if (!root) {
    return { id: null, text: stripTags(html), tags: [], facts: [], links: [] };
  }
  const tags = (root.getAttribute("data-cerveau-tags") ?? "").split(/\s+/).filter(Boolean);
  const facts = Array.from(root.querySelectorAll("[data-cerveau-fact]")).map(
    (el) => ({
      text: extractText(el).trim(),
      confidence: Number.parseFloat(el.getAttribute("data-cerveau-confidence") ?? "1") || 1,
      extractor: el.getAttribute("data-cerveau-extracted-by") ?? void 0,
      source: el.getAttribute("data-cerveau-source") ?? void 0
    })
  );
  const links = Array.from(
    root.querySelectorAll("a[href][data-cerveau-link-type]")
  ).map((el) => ({
    to: el.getAttribute("href") ?? "",
    type: el.getAttribute("data-cerveau-link-type") ?? void 0,
    text: (el.textContent ?? "").trim(),
    strength: Number.parseFloat(el.getAttribute("data-cerveau-link-strength") ?? "") || void 0
  }));
  const infobox = extractInfobox(root);
  const seeAlso = extractSeeAlso(root);
  const wikilinks = extractWikilinks(root);
  const categories = extractCategories(root);
  const relatedAttr = root.getAttribute("data-cerveau-related") ?? void 0;
  const related = relatedAttr ? relatedAttr.split(",").filter(Boolean) : void 0;
  return {
    id: root.getAttribute("id"),
    text: extractText(root),
    type: root.getAttribute("data-cerveau-type") ?? void 0,
    source: root.getAttribute("data-cerveau-source") ?? void 0,
    created: root.getAttribute("data-cerveau-created") ?? void 0,
    importance: Number.parseFloat(root.getAttribute("data-cerveau-importance") ?? "") || void 0,
    tags,
    facts,
    links,
    valid_from: root.getAttribute("data-cerveau-valid-from") ?? void 0,
    valid_until: root.getAttribute("data-cerveau-valid-until") ?? void 0,
    triples: root.getAttribute("data-cerveau-triples") ?? void 0,
    causes: root.getAttribute("data-cerveau-causes") ?? void 0,
    replaces: root.getAttribute("data-cerveau-replaces") ?? void 0,
    replaced_by: root.getAttribute("data-cerveau-replaced-by") ?? void 0,
    supersedes: root.getAttribute("data-cerveau-supersedes") ?? void 0,
    entities: root.getAttribute("data-cerveau-entities") ?? void 0,
    infobox: Object.keys(infobox).length > 0 ? infobox : void 0,
    seeAlso: seeAlso.length > 0 ? seeAlso : void 0,
    wikilinks: wikilinks.length > 0 ? wikilinks : void 0,
    categories: categories.length > 0 ? categories : void 0,
    related: related && related.length > 0 ? related : void 0,
    author: root.getAttribute("data-cerveau-author") ?? void 0,
    authorId: root.getAttribute("data-cerveau-author-id") ?? void 0,
    kind: root.getAttribute("data-cerveau-kind") ?? void 0,
    about: root.getAttribute("data-cerveau-about") ?? void 0,
    status: root.getAttribute("data-cerveau-status") ?? void 0,
    project: root.getAttribute("data-cerveau-project") ?? void 0,
    orgId: root.getAttribute("data-cerveau-org-id") ?? void 0,
    leadText: extractLeadText(root)
  };
}
function stripSection(html, selector) {
  if (!html || !selector) return "";
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  let matches;
  try {
    matches = Array.from(document.querySelectorAll(selector));
  } catch {
    matches = [];
  }
  if (matches.length > 0) {
    const parts = [];
    for (const el of matches) {
      const text = extractText(el);
      if (text.trim()) parts.push(text.trim());
    }
    const joined = parts.join("\n").trim();
    if (joined.length > 0) return joined;
  }
  const root = document.querySelector("body") ?? document.documentElement;
  if (!root || (root.textContent ?? "").trim().length === 0) return "";
  const tldr = root.querySelector('section[data-section="tldr"]');
  if (tldr) {
    const text = extractText(tldr).trim();
    if (text.length > 0) return text;
  }
  const summarySection = root.querySelector('section[data-section="summary"]');
  if (summarySection) {
    const text = extractText(summarySection).trim();
    if (text.length > 0) return text.slice(0, 240);
  }
  const fullText = extractText(root).trim();
  return fullText.slice(0, 240);
}
function extractInfobox(root) {
  const result = {};
  const aside = root.querySelector("aside.infobox");
  if (!aside) return result;
  const dts = Array.from(aside.querySelectorAll("dt"));
  for (const dt of dts) {
    const key = (dt.textContent ?? "").trim();
    const dd = dt.nextElementSibling;
    if (key && dd) {
      result[key] = (dd.textContent ?? "").trim();
    }
  }
  return result;
}
function extractSeeAlso(root) {
  const ids = [];
  const nav = root.querySelector("nav.see-also") ?? root.querySelector('[data-section="see-also"] nav');
  if (!nav) return ids;
  for (const a of Array.from(nav.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    const id = href.startsWith("#") ? href.slice(1) : href;
    if (id) ids.push(id);
  }
  return ids;
}
function extractWikilinks(root) {
  const result = [];
  for (const a of Array.from(root.querySelectorAll('a[href][data-cerveau-link-type="see-also"]'))) {
    const href = a.getAttribute("href") ?? "";
    const term = (a.textContent ?? "").trim();
    if (term && href) result.push({ term, href });
  }
  return result;
}
function extractCategories(root) {
  const nav = root.querySelector("nav.categories");
  if (!nav) return [];
  return Array.from(nav.querySelectorAll("a")).map((a) => (a.textContent ?? "").trim()).filter(Boolean);
}
function shortNoteId(id) {
  if (!id) return "";
  return id.replace(/^\d{4}-\d{2}-\d{2}-/, "").slice(0, 32);
}
function stripNoteToPrompt(note) {
  const date = (note.created ?? "").slice(0, 10);
  const letter = TYPE_LETTER[note.type ?? ""] ?? "\xB7";
  const id = shortNoteId(note.id);
  const tags = note.tags.length ? ` (${note.tags.slice(0, 4).join(", ")})` : "";
  const head = `${letter} ${date}${id ? ` #${id}` : ""}${tags}`.trim();
  const leadFallback = note.leadText ?? note.text.split("\n").join(" ").slice(0, 240);
  const facts = note.facts.length ? `
${note.facts.map((f) => `  - ${f.text}`).join("\n")}` : leadFallback ? `
  ${leadFallback.split("\n").join(" ")}` : "";
  const links = note.links.length ? `
  links: ${note.links.map((l) => `${l.type ?? "\u2192"}${l.to}`).join(", ")}` : "";
  const rels = relationLine(note);
  const seeAlsoLine = note.seeAlso && note.seeAlso.length > 0 ? `
  See also: ${note.seeAlso.map((id2) => `#${id2}`).join(", ")}` : "";
  const wikiLine = note.wikilinks && note.wikilinks.length > 0 ? `
  \u2192 links: [${note.wikilinks.slice(0, 4).map((w) => `${w.term}\u2192${w.href}`).join(", ")}]` : "";
  const relatedLine = note.related && note.related.length > 0 ? `
  Related: [${note.related.map((id2) => `#${id2}`).join(", ")}]` : "";
  return `${head}${rels}${facts}${links}${seeAlsoLine}${wikiLine}${relatedLine}`;
}
function relationLine(note) {
  const parts = [];
  if (note.replaces) parts.push(`\u21BA${note.replaces.split(",")[0]}`);
  if (note.replaced_by) parts.push(`\u21BB${note.replaced_by.split(",")[0]}`);
  if (note.causes) {
    const first = note.causes.split("|")[0];
    if (first) parts.push(`\u2235${first.slice(0, 32)}`);
  }
  if (note.triples) {
    const first = note.triples.split(";")[0];
    if (first) parts.push(`\u25E6${first}`);
  }
  if (note.entities) {
    const ents = note.entities.split(",").slice(0, 2).join(",");
    if (ents) parts.push(`\u2295${ents}`);
  }
  return parts.length ? ` \xB7 ${parts.join(" \xB7 ")}` : "";
}
var BLOCK_TAGS, LIST_ITEM_TAGS, ENRICHMENT_SECTION_IDS, LEAD_TEXT_BUDGET, TYPE_LETTER;
var init_strip = __esm({
  "src/retrieval/strip.ts"() {
    "use strict";
    BLOCK_TAGS = /* @__PURE__ */ new Set([
      "p",
      "div",
      "section",
      "article",
      "header",
      "footer",
      "aside",
      "main",
      "nav",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "li",
      "tr",
      "dt",
      "dd",
      "blockquote",
      "pre",
      "figure",
      "figcaption",
      "br",
      "hr"
    ]);
    LIST_ITEM_TAGS = /* @__PURE__ */ new Set(["li", "dt", "dd"]);
    ENRICHMENT_SECTION_IDS = [
      "decisions",
      "bugs",
      "rules",
      "warnings",
      "ideas",
      "qa",
      "activity"
    ];
    LEAD_TEXT_BUDGET = 240;
    TYPE_LETTER = {
      decision: "D",
      episodic: "E",
      reference: "R",
      semantic: "S",
      procedural: "P"
    };
  }
});

// src/store/reader.ts
import { readFileSync as readFileSync2, readdirSync as readdirSync2, statSync } from "node:fs";
import { join as join5 } from "node:path";
function readAllNotes() {
  return [...readDir(notesDir()), ...readDir(batchesDir())];
}
function listAllNotePaths() {
  return [...listDir(notesDir()), ...listDir(batchesDir())];
}
function listDir(root) {
  let entries;
  try {
    entries = readdirSync2(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = join5(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDir(full));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}
function entriesInDir(root) {
  let entries;
  try {
    entries = readdirSync2(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = join5(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...entriesInDir(full));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push({ slug: entry.name.slice(0, -".html".length), path: full });
    }
  }
  return out;
}
function entriesInMonthDirCached(dir) {
  let mtimeMs;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    monthDirEntriesCache.delete(dir);
    return [];
  }
  const cached3 = monthDirEntriesCache.get(dir);
  if (cached3 && cached3.mtimeMs === mtimeMs) return cached3.entries;
  const entries = entriesInDir(dir);
  monthDirEntriesCache.set(dir, { mtimeMs, entries });
  return entries;
}
function allDiskEntriesCached() {
  const out = [];
  const root = notesDir();
  let entries;
  try {
    entries = readdirSync2(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const full = join5(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...entriesInMonthDirCached(full));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push({ slug: entry.name.slice(0, -".html".length), path: full });
    }
  }
  out.push(...entriesInDir(batchesDir()));
  return out;
}
function distinctNoteIdSlugsCached() {
  const out = /* @__PURE__ */ new Set();
  for (const entry of allDiskEntriesCached()) out.add(entry.slug);
  return out;
}
function diskPathsForSlugs(slugs) {
  if (slugs.size === 0) return [];
  const out = [];
  for (const entry of allDiskEntriesCached()) {
    if (slugs.has(entry.slug)) out.push(entry.path);
  }
  return out;
}
function readNote(path) {
  readNoteCallCount += 1;
  const html = readFileSync2(path, "utf8");
  const stats = statSync(path);
  return {
    path,
    id: idFromHtml(html) ?? "",
    html,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs
  };
}
function readDir(root) {
  const out = [];
  let entries;
  try {
    entries = readdirSync2(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join5(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...readDir(full));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(readNote(full));
    }
  }
  return out;
}
function idFromHtml(html) {
  const m = html.match(/<(?:article|memory-batch)\b[^>]*?(?<!-)\bid\s*=\s*["']([^"']+)["']/i);
  return m?.[1] ?? null;
}
var monthDirEntriesCache, readNoteCallCount;
var init_reader = __esm({
  "src/store/reader.ts"() {
    "use strict";
    init_paths();
    monthDirEntriesCache = /* @__PURE__ */ new Map();
    readNoteCallCount = 0;
  }
});

// src/util/quality.ts
function noteQuality(n) {
  if (n.factCount <= 1 || n.meanConfidence < 0.5) return "stub";
  const isGoodBase = n.factCount >= 4 && n.meanConfidence > 0.7 && n.hasRelations;
  if (isGoodBase && n.accessCount > 5 && n.inboundWikilinks >= 2) {
    return "featured";
  }
  if (isGoodBase) return "good";
  return "start";
}
var init_quality = __esm({
  "src/util/quality.ts"() {
    "use strict";
  }
});

// src/indexer/note-index.ts
import { parseHTML as parseHTML2 } from "linkedom";
function indexNote(note) {
  const { document } = parseHTML2(`<!doctype html><body>${note.html}</body>`);
  const root = document.querySelector("article, section, memory-batch");
  if (!root) {
    throw new Error(`No root element in note ${note.path}`);
  }
  const title = root.querySelector("h1, h2, h3")?.textContent?.trim() ?? note.id;
  const rawText = stripTags(root.outerHTML);
  const text = augmentTextForIndex(rawText);
  const conceptList = extractConcepts(rawText);
  const concepts = conceptList.length > 0 ? conceptList.join(",") : null;
  const allFacts = Array.from(root.querySelectorAll("[data-cerveau-fact]"));
  const factCount = allFacts.length;
  const meanConfidence = factCount > 0 ? allFacts.reduce(
    (sum, el) => sum + (Number.parseFloat(el.getAttribute("data-cerveau-confidence") ?? "1") || 1),
    0
  ) / factCount : 0;
  const hasRelations = !!(root.getAttribute("data-cerveau-triples") || root.getAttribute("data-cerveau-causes") || root.getAttribute("data-cerveau-replaces"));
  const quality = noteQuality({
    factCount,
    meanConfidence,
    accessCount: 0,
    // access_count not yet set at index time
    inboundWikilinks: 0,
    // backlink graph not consulted here (too expensive)
    hasRelations
  });
  const saliencyKind = root.getAttribute("data-cerveau-saliency-kind") ?? null;
  const conflictWith = root.getAttribute("data-cerveau-conflict-with") ?? null;
  const questions = extractQuestionsFromHtml(document);
  const errorPatterns = extractErrorPatternsFromHtml(document);
  const aliases = extractAliasesFromHtml(document);
  const sectionSummary = extractSectionTextContent(root, "summary", 1500);
  const sectionReasoning = extractSectionTextContent(root, "reasoning", 1500);
  const sectionQa = extractSectionTextContent(root, "qa", 1500);
  const sectionToolTrace = extractSectionTextContent(root, "tool_trace", 1500);
  const sectionTldr = extractSectionTextContent(root, "tldr", 1500);
  const warnings = extractWarningsFromHtml(root);
  const topic = root.getAttribute("data-cerveau-topic");
  const tldr = root.getAttribute("data-cerveau-tldr");
  const indexed = {
    id: note.id,
    path: note.path,
    text,
    title,
    type: root.getAttribute("data-cerveau-type"),
    tags: root.getAttribute("data-cerveau-tags") ?? "",
    source: root.getAttribute("data-cerveau-source"),
    created: root.getAttribute("data-cerveau-created"),
    importance: parseOptionalFloat(root.getAttribute("data-cerveau-importance")),
    valid_from: root.getAttribute("data-cerveau-valid-from"),
    valid_until: root.getAttribute("data-cerveau-valid-until"),
    mtime_ms: note.mtimeMs,
    triples: root.getAttribute("data-cerveau-triples"),
    causes: root.getAttribute("data-cerveau-causes"),
    replaces: root.getAttribute("data-cerveau-replaces"),
    replaced_by: root.getAttribute("data-cerveau-replaced-by"),
    supersedes: root.getAttribute("data-cerveau-supersedes"),
    entities: root.getAttribute("data-cerveau-entities"),
    concepts,
    quality,
    saliency_kind: saliencyKind,
    conflict_with: conflictWith,
    related: root.getAttribute("data-cerveau-related") ?? null,
    questions,
    error_patterns: errorPatterns,
    aliases,
    section_summary: sectionSummary,
    section_reasoning: sectionReasoning,
    section_qa: sectionQa,
    section_tool_trace: sectionToolTrace,
    section_tldr: sectionTldr,
    warnings,
    topic,
    tldr
  };
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO notes (id, path, title, type, tags, source, created, importance,
                       valid_from, valid_until, mtime_ms,
                       triples, causes, replaces, replaced_by, supersedes, entities,
                       concepts, quality, saliency_kind, conflict_with, related,
                       questions, error_patterns, aliases, section_summary, section_reasoning,
                       section_qa, section_tool_trace, section_tldr, warnings, topic, tldr)
    VALUES (@id, @path, @title, @type, @tags, @source, @created, @importance,
            @valid_from, @valid_until, @mtime_ms,
            @triples, @causes, @replaces, @replaced_by, @supersedes, @entities,
            @concepts, @quality, @saliency_kind, @conflict_with, @related,
            @questions, @error_patterns, @aliases, @section_summary, @section_reasoning,
            @section_qa, @section_tool_trace, @section_tldr, @warnings, @topic, @tldr)
    ON CONFLICT(id) DO UPDATE SET
      path=@path, title=@title, type=@type, tags=@tags, source=@source,
      created=@created, importance=@importance, valid_from=@valid_from,
      valid_until=@valid_until, mtime_ms=@mtime_ms,
      triples=@triples, causes=@causes, replaces=@replaces,
      replaced_by=@replaced_by, supersedes=@supersedes, entities=@entities,
      concepts=@concepts, quality=@quality, saliency_kind=@saliency_kind,
      conflict_with=@conflict_with, related=@related,
      questions=@questions, error_patterns=@error_patterns, aliases=@aliases,
      section_summary=@section_summary, section_reasoning=@section_reasoning,
      section_qa=@section_qa, section_tool_trace=@section_tool_trace, section_tldr=@section_tldr,
      warnings=@warnings, topic=@topic, tldr=@tldr
  `);
  upsert.run(indexed);
  db.prepare("DELETE FROM notes_fts WHERE id = ?").run(note.id);
  db.prepare("INSERT INTO notes_fts (id, title, text, tags) VALUES (?, ?, ?, ?)").run(
    note.id,
    title,
    text,
    indexed.tags
  );
  bumpLocalWriteVersion();
  return indexed;
}
function deleteNote(id) {
  const db = getDb();
  db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  db.prepare("DELETE FROM notes_fts WHERE id = ?").run(id);
  try {
    db.prepare("DELETE FROM note_embeddings WHERE id = ?").run(id);
  } catch {
  }
  bumpLocalWriteVersion();
}
async function rebuildAll() {
  const db = getDb();
  db.exec("DELETE FROM notes; DELETE FROM notes_fts;");
  bumpLocalWriteVersion();
  const notes = readAllNotes();
  let indexed = 0;
  let failed = 0;
  const failures = [];
  const indexedNotes = [];
  for (const n of notes) {
    try {
      indexedNotes.push(indexNote(n));
      indexed += 1;
    } catch (err) {
      failed += 1;
      failures.push(`${n.path}: ${err.message}`);
    }
  }
  await embedNotesForIndex(indexedNotes);
  return { indexed, failed, failures };
}
function parseOptionalFloat(v) {
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function extractQuestionsFromHtml(document) {
  const questions = [];
  const answersMeta = document.querySelector('meta[name="answers"]');
  if (answersMeta) {
    const content = answersMeta.getAttribute("content") ?? "";
    if (content) {
      for (const answer of content.split(";").map((s) => s.trim()).filter(Boolean)) {
        questions.push(`Why/How ${answer}?`);
      }
    }
  }
  for (const detail of Array.from(document.querySelectorAll("details[data-q]"))) {
    const attr = detail.getAttribute("data-q");
    if (attr) questions.push(attr.replace(/-/g, " "));
  }
  return questions.length > 0 ? questions.join("|") : null;
}
function extractErrorPatternsFromHtml(document) {
  const patterns = [];
  for (const detail of Array.from(document.querySelectorAll("details[data-error]"))) {
    const attr = detail.getAttribute("data-error");
    if (attr) patterns.push(attr);
  }
  return patterns.length > 0 ? patterns.join("|") : null;
}
function extractAliasesFromHtml(document) {
  const aliasMeta = document.querySelector('meta[name="aliases"]');
  if (aliasMeta) {
    const content = aliasMeta.getAttribute("content") ?? "";
    return content.trim() ? content : null;
  }
  return null;
}
function extractSectionTextContent(root, sectionName, maxChars) {
  const section = root.querySelector(`section[data-section="${sectionName}"]`);
  if (!section) return null;
  const text = section.textContent ?? "";
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}
function extractWarningsFromHtml(root) {
  const warnings = [];
  for (const aside of Array.from(root.querySelectorAll('aside[role="doc-warning"]'))) {
    const text = (aside.textContent ?? "").trim();
    if (text) warnings.push(text);
  }
  return warnings.length > 0 ? warnings.join("|") : null;
}
var init_note_index = __esm({
  "src/indexer/note-index.ts"() {
    "use strict";
    init_strip();
    init_reader();
    init_quality();
    init_tokenize();
    init_corpus_cache();
    init_db();
    init_embed_index();
  }
});

// src/indexer/note-read.ts
function countAllNotes() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) AS n FROM notes").get();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
function listAllNoteIds() {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT id FROM notes").all();
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}
function listAll(opts = {}) {
  const db = getDb();
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  const where = shouldExcludeInvalidated ? `WHERE (valid_until IS NULL OR valid_until = '')` : "";
  return db.prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`).all();
}
function listAllReadonly(opts = {}) {
  let db;
  try {
    db = getReadonlyDb();
  } catch {
    return [];
  }
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  const where = shouldExcludeInvalidated ? `WHERE (valid_until IS NULL OR valid_until = '')` : "";
  try {
    return db.prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`).all();
  } catch {
    return [];
  }
}
function listAllWithText(opts = {}) {
  const db = getDb();
  const shouldExcludeInvalidated = !opts.includeExpired || opts.excludeInvalidated;
  return withTextCache.resolve(db, "notes", String(shouldExcludeInvalidated), () => {
    const where = shouldExcludeInvalidated ? `WHERE (valid_until IS NULL OR valid_until = '')` : "";
    const notes = db.prepare(`SELECT * FROM notes ${where} ORDER BY created DESC`).all();
    const textById = /* @__PURE__ */ new Map();
    const ftsRows = db.prepare("SELECT id, text FROM notes_fts").all();
    for (const row of ftsRows) {
      textById.set(row.id, row.text ?? "");
    }
    return notes.map((n) => ({ ...n, text: textById.get(n.id) ?? "" }));
  });
}
function getNoteText(id) {
  const row = getDb().prepare("SELECT text FROM notes_fts WHERE id = ?").get(id);
  return row?.text ?? "";
}
function recordAccessMany(ids) {
  if (ids.length === 0) return;
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const db = getDb();
  try {
    const stmt = db.prepare(
      "UPDATE notes SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ? WHERE id = ?"
    );
    const tx = db.transaction((batch) => {
      for (const id of batch) stmt.run(ts, id);
    });
    tx(ids);
  } catch {
  }
}
function getNoteById(id) {
  return getDb().prepare("SELECT * FROM notes WHERE id = ?").get(id);
}
function notesByTagOrType(opts) {
  const db = getDb();
  const where = [];
  const params = {};
  if (opts.tag) {
    where.push(`(' ' || tags || ' ') LIKE @tagPattern`);
    params.tagPattern = `% ${opts.tag} %`;
  }
  if (opts.type) {
    where.push("type = @type");
    params.type = opts.type;
  }
  if (!opts.includeExpired) {
    where.push(`(valid_until IS NULL OR valid_until = '')`);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 10;
  return db.prepare(
    `SELECT * FROM notes ${whereClause} ORDER BY importance DESC, created DESC LIMIT @limit`
  ).all({ ...params, limit });
}
function notesMentioningEntity(entityKey, limit = 20) {
  const db = getDb();
  const sql = `
    SELECT * FROM notes
    WHERE entities LIKE @needle
      AND (valid_until IS NULL OR valid_until = '')
    ORDER BY created DESC
    LIMIT @limit
  `;
  const rows = db.prepare(sql).all({ needle: `%${entityKey}%`, limit });
  return rows.filter((r) => {
    const list = (r.entities ?? "").split(",").filter(Boolean);
    return list.includes(entityKey);
  });
}
function notesAnsweringQuestion(query, limit = 10, sourcePrefix) {
  const db = getDb();
  const needle = `%${query.toLowerCase()}%`;
  const src = sourcePrefix ? "AND source LIKE @sourcePrefix" : "";
  const rows = db.prepare(
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
  `
  ).all({
    needle,
    exact: `%${query}%`,
    limit,
    ...sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}
  });
  return rows;
}
function notesForErrorPattern(errorText, limit = 5, sourcePrefix) {
  const db = getDb();
  const normalized = errorText.replace(/:\d+/g, "").replace(/0x[0-9a-f]+/g, "").toLowerCase();
  const afterColon = normalized.split(/fix this error:\s*/i).pop() ?? normalized;
  const key = afterColon.match(
    /(?:operationalerror|typeerror|referenceerror|syntaxerror|eresolve|deadlock|assertionerror|cors)[^?]*/i
  )?.[0]?.slice(0, 80) ?? afterColon.slice(0, 80);
  const needle = `%${key.trim()}%`;
  const src = sourcePrefix ? "AND n.source LIKE @sourcePrefix" : "";
  const rows = db.prepare(
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
  `
  ).all({
    needle,
    limit,
    ...sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}
  });
  return rows;
}
function notesMatchingPathPrefix(pathPrefix, limit = 10, sourcePrefix) {
  const db = getDb();
  const norm = pathPrefix.replace(/\\/g, "/").toLowerCase();
  if (!norm) return [];
  const needle = `%${norm}%`;
  const src = sourcePrefix ? "AND n.source LIKE @sourcePrefix" : "";
  return db.prepare(
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
  `
  ).all({
    needle,
    limit,
    ...sourcePrefix ? { sourcePrefix: `${sourcePrefix}%` } : {}
  });
}
function notesWithWarningsOrNegative(query, limit = 8, sourcePrefix) {
  let candidates = listAllWithText({ includeExpired: false }).filter(
    (n) => Boolean((n.warnings ?? "").trim()) || /\b(do not retry|abandoned|reverted|broke streaming|tried using|do not use)\b/i.test(n.text)
  );
  if (sourcePrefix) {
    candidates = candidates.filter((n) => (n.source ?? "").startsWith(sourcePrefix));
  }
  if (candidates.length === 0) return [];
  const allowed = new Set(candidates.map((c) => c.id));
  const ftsHits = searchFts(query, { limit: limit * 4, sourcePrefix });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out = [];
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
var withTextCache;
var init_note_read = __esm({
  "src/indexer/note-read.ts"() {
    "use strict";
    init_corpus_cache();
    init_db();
    init_fts_search();
    withTextCache = new SnapshotCache();
  }
});

// src/indexer/note-helpers.ts
function allDistinctTags() {
  const now = Date.now();
  if (_tagCache && now - _tagCache.ts < TAG_CACHE_TTL) return _tagCache.tags;
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT tags FROM notes
    WHERE (valid_until IS NULL OR valid_until = '')
      AND tags IS NOT NULL AND tags != ''
  `).all();
  const tagSet = /* @__PURE__ */ new Set();
  for (const row of rows) {
    for (const tag of row.tags.split(/\s+/).filter(Boolean)) {
      tagSet.add(tag.toLowerCase());
    }
  }
  const tags = [...tagSet].sort();
  _tagCache = { tags, ts: now };
  return tags;
}
function getTagNoteCount(tag) {
  const now = Date.now();
  if (_tagCountCache && now - _tagCountCache.ts < TAG_CACHE_TTL) {
    return _tagCountCache.counts.get(tag.toLowerCase()) ?? 0;
  }
  const db = getDb();
  const rows = db.prepare(
    `SELECT tags FROM notes
       WHERE (valid_until IS NULL OR valid_until = '')
         AND tags IS NOT NULL AND tags != ''`
  ).all();
  const counts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    for (const t of row.tags.split(/\s+/).filter(Boolean)) {
      const key = t.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  _tagCountCache = { counts, ts: now };
  return counts.get(tag.toLowerCase()) ?? 0;
}
function topConcepts(limit) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT concepts FROM notes WHERE (valid_until IS NULL OR valid_until = '') AND concepts IS NOT NULL AND concepts != ''`
  ).all();
  const counts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    for (const c of row.concepts.split(",").filter(Boolean)) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([concept, count]) => ({ concept, count }));
}
function activeDecisions(daysBack, limit) {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysBack * 864e5).toISOString().slice(0, 10);
  return db.prepare(
    `SELECT * FROM notes
       WHERE type = 'decision'
         AND (valid_until IS NULL OR valid_until = '')
         AND created >= ?
       ORDER BY COALESCE(importance, 0) DESC
       LIMIT ?`
  ).all(cutoff, limit);
}
function normalizeForCwdMatch(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function containsCwdSegment(field, cwd) {
  const idx = field.indexOf(cwd);
  if (idx === -1) return false;
  const after = field.charAt(idx + cwd.length);
  return after === "" || after === "/";
}
function notesForCwdCount(cwd) {
  const db = getDb();
  const normalizedCwd = normalizeForCwdMatch(cwd);
  if (!normalizedCwd) return notesForCwdCountFallback(db);
  const escaped = `%${normalizedCwd}%`;
  const rawRows = db.prepare(
    `SELECT type, tags, source, id, path FROM notes
       WHERE REPLACE(LOWER(source), '\\', '/') LIKE ?
          OR REPLACE(LOWER(id), '\\', '/') LIKE ?
          OR REPLACE(LOWER(path), '\\', '/') LIKE ?`
  ).all(escaped, escaped, escaped);
  const notes = rawRows.filter(
    (r) => containsCwdSegment(normalizeForCwdMatch(r.source ?? ""), normalizedCwd) || containsCwdSegment(normalizeForCwdMatch(r.id ?? ""), normalizedCwd) || containsCwdSegment(normalizeForCwdMatch(r.path ?? ""), normalizedCwd)
  );
  if (notes.length === 0) {
    return notesForCwdCountFallback(db);
  }
  return buildCwdCountResult(notes);
}
function notesForCwdCountFallback(db) {
  const all = db.prepare(`SELECT type, tags FROM notes WHERE valid_until IS NULL OR valid_until = '' LIMIT 300`).all();
  const counts = /* @__PURE__ */ new Map();
  let decisions = 0;
  for (const n of all) {
    if (n.type === "decision") decisions++;
    for (const t of (n.tags ?? "").split(/\s+/).filter(Boolean)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const topTags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  return { count: all.length, activeDecisions: decisions, topTags };
}
function buildCwdCountResult(notes) {
  const tagCounts = /* @__PURE__ */ new Map();
  let decisions = 0;
  for (const n of notes) {
    if (n.type === "decision") decisions++;
    for (const t of (n.tags ?? "").split(/\s+/).filter(Boolean)) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  return { count: notes.length, activeDecisions: decisions, topTags };
}
function noteVocabularyCensus(topicSlug, tagLimit = 12) {
  const db = getDb();
  const where = [`(valid_until IS NULL OR valid_until = '')`];
  const params = [];
  if (topicSlug) {
    where.push(`(LOWER(topic) = ? OR LOWER(topic) LIKE ?)`);
    params.push(topicSlug.toLowerCase(), `${topicSlug.toLowerCase()}/%`);
  }
  const rows = db.prepare(`SELECT type, tags FROM notes WHERE ${where.join(" AND ")}`).all(...params);
  const typeCounts = /* @__PURE__ */ new Map();
  const tagCounts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.type) typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1);
    for (const tag of (row.tags ?? "").split(/\s+/).filter(Boolean)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const toSorted = (counts, limit) => [...mergeCaseVariants(counts).entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
  return {
    types: toSorted(typeCounts, 24),
    tags: toSorted(tagCounts, tagLimit)
  };
}
function mergeCaseVariants(counts) {
  const grouped = /* @__PURE__ */ new Map();
  for (const [value, count] of counts) {
    const key = value.toLowerCase();
    const variants = grouped.get(key) ?? /* @__PURE__ */ new Map();
    variants.set(value, (variants.get(value) ?? 0) + count);
    grouped.set(key, variants);
  }
  const merged = /* @__PURE__ */ new Map();
  for (const variants of grouped.values()) {
    let dominant = "";
    let dominantCount = -1;
    let total = 0;
    for (const [variant, count] of variants) {
      total += count;
      if (count > dominantCount) {
        dominant = variant;
        dominantCount = count;
      }
    }
    merged.set(dominant, total);
  }
  return merged;
}
function applyStructuralFieldBoost(hits, query) {
  if (hits.length === 0) return hits;
  const STOP = /* @__PURE__ */ new Set([
    "a",
    "an",
    "and",
    "as",
    "at",
    "be",
    "by",
    "do",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "up",
    "we"
  ]);
  const queryTokens = query.toLowerCase().split(/[\s/.,;:?!()[\]{}"'`\\]+/).filter((t) => t.length >= 2 && !STOP.has(t));
  if (queryTokens.length === 0) return hits;
  const boosted = hits.map((h) => {
    const structuralSegments = buildStructuralSegments(h);
    const hasStructuralMatch = queryTokens.some((t) => structuralSegments.has(t));
    if (!hasStructuralMatch) return h;
    return { ...h, score: h.score * STRUCTURAL_EXACT_BOOST };
  });
  return [...boosted].sort((a, b) => b.score - a.score);
}
function buildStructuralSegments(h) {
  const segments = /* @__PURE__ */ new Set();
  for (const seg of (h.topic ?? "").toLowerCase().split(/[\s/._-]+/).filter(Boolean)) {
    segments.add(seg);
  }
  for (const seg of (h.codeFile ?? "").toLowerCase().split(/[\s/._-]+/).filter(Boolean)) {
    segments.add(seg);
  }
  for (const seg of (h.tags ?? "").toLowerCase().split(/\s+/).filter(Boolean)) {
    segments.add(seg);
  }
  return segments;
}
var TAG_CACHE_TTL, _tagCache, _tagCountCache, STRUCTURAL_EXACT_BOOST;
var init_note_helpers = __esm({
  "src/indexer/note-helpers.ts"() {
    "use strict";
    init_db();
    TAG_CACHE_TTL = 6e4;
    _tagCache = null;
    _tagCountCache = null;
    STRUCTURAL_EXACT_BOOST = 1.5;
  }
});

// src/indexer/fts.ts
var init_fts = __esm({
  "src/indexer/fts.ts"() {
    "use strict";
    init_db();
    init_fts_search();
    init_embedding_store();
    init_embed_index();
    init_note_index();
    init_note_read();
    init_note_helpers();
  }
});

// src/util/cwd-normalizer.ts
import { homedir as homedir2, tmpdir } from "node:os";
import { basename as pathBasename } from "node:path";
function canonicalProjectSegment(dirName) {
  return dirName.toLowerCase();
}
function normalizeSeparators(raw) {
  return raw.replace(/\\/g, "/").replace(/\/+/g, "/");
}
function stripUserPrefix(path) {
  let p = normalizeSeparators(path).trim();
  p = p.replace(/^%userprofile%\/?/i, "");
  p = p.replace(/^~\/?/, "");
  const home = normalizeSeparators(homedir2()).toLowerCase();
  const tmp = normalizeSeparators(tmpdir()).toLowerCase();
  const lower = p.toLowerCase();
  if (lower.startsWith(`${home}/`)) {
    p = p.slice(home.length + 1);
  } else if (lower.startsWith(`${tmp}/`) || lower === tmp) {
    return "";
  }
  p = p.replace(/^\//, "");
  p = p.replace(/^[a-z]:\//i, "");
  p = p.replace(/^[a-z]\//i, "");
  p = p.replace(/^\//, "");
  p = p.replace(/^(?:home|users)\/[^/]+\//i, "");
  return p;
}
function splitHyphenated(segment) {
  if (!segment.includes("-")) return [segment];
  return segment.split("-").filter(Boolean);
}
function isSystemPath(segments) {
  return segments.some((s) => SYSTEM_PREFIXES.includes(s.toLowerCase()));
}
function normalizeCwd(rawCwd) {
  if (!rawCwd || !rawCwd.trim()) return null;
  const stripped = stripUserPrefix(rawCwd.trim());
  if (!stripped) return null;
  const parts = stripped.split("/").map((s) => s.toLowerCase().trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (isSystemPath(parts)) return null;
  let start = 0;
  while (start < parts.length && STRIP_SEGMENTS.has(parts[start])) {
    start++;
  }
  const meaningful = parts.slice(start);
  if (meaningful.length === 0) return null;
  const [first, ...rest] = meaningful;
  const firstSegments = splitHyphenated(first);
  const allSegments = [...firstSegments, ...rest].filter(Boolean);
  if (allSegments.length === 0) return null;
  const topicPath = allSegments.join("/");
  const project = allSegments[0];
  return {
    raw: rawCwd,
    topicPath,
    segments: allSegments,
    project
  };
}
function slugifyCwd(cwd) {
  let base = pathBasename(cwd);
  if (["src", "app", "project", "code"].includes(base.toLowerCase())) {
    const parts = cwd.split(/[/\\]+/).filter(Boolean);
    base = parts[parts.length - 2] || base;
  }
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
}
var STRIP_SEGMENTS, SYSTEM_PREFIXES;
var init_cwd_normalizer = __esm({
  "src/util/cwd-normalizer.ts"() {
    "use strict";
    STRIP_SEGMENTS = /* @__PURE__ */ new Set([
      "documents",
      "projects",
      "code",
      "workspace",
      "workspaces",
      "dev",
      "repos",
      "repo",
      "src",
      "source",
      "home",
      "users",
      "user"
    ]);
    SYSTEM_PREFIXES = ["windows", "system32", "program files", "programdata", "appdata"];
  }
});

// src/annotator/entities.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname4, join as join6 } from "node:path";
function entitiesPath() {
  return join6(getConfig().cachePath, ENTITY_FILE);
}
function load() {
  const now = Date.now();
  if (cache2 && now - cacheLoadedAt < 5e3) return cache2;
  const path = entitiesPath();
  if (!existsSync5(path)) {
    cache2 = {};
    cacheLoadedAt = now;
    return cache2;
  }
  try {
    cache2 = JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    cache2 = {};
  }
  cacheLoadedAt = now;
  return cache2;
}
function save(entries) {
  const path = entitiesPath();
  const dir = dirname4(path);
  if (!existsSync5(dir)) mkdirSync4(dir, { recursive: true });
  try {
    writeFileSync3(path, JSON.stringify(entries, null, 2), "utf8");
  } catch {
  }
}
function inferType(name) {
  for (const [re, type] of KNOWN_TYPES) {
    if (re.test(name)) return type;
  }
  return "other";
}
function canonical(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function extractEntityCandidates(text) {
  const seen = /* @__PURE__ */ new Set();
  CANDIDATE_RE.lastIndex = 0;
  for (let m = CANDIDATE_RE.exec(text); m !== null; m = CANDIDATE_RE.exec(text)) {
    const tok = m[1];
    if (tok.length < 3 || tok.length > 40) continue;
    seen.add(tok);
  }
  return [...seen].slice(0, 24);
}
function registerEntity(name, ts) {
  const key = canonical(name);
  if (key.length < 3) return null;
  const entries = load();
  const existing = entries[key];
  if (existing) {
    if (!existing.surfaces.includes(name)) {
      existing.surfaces.push(name);
      save(entries);
    }
    return `${existing.type}:${existing.key}`;
  }
  const type = inferType(name);
  if (type === "other" && !/[-_.]/.test(name) && !/[A-Z][a-z]+[A-Z]/.test(name)) {
    return null;
  }
  entries[key] = {
    key,
    type,
    surfaces: [name],
    firstSeen: ts
  };
  save(entries);
  return `${type}:${key}`;
}
function lookupEntity(name) {
  const key = canonical(name);
  const entries = load();
  const hit = entries[key];
  return hit ? `${hit.type}:${hit.key}` : null;
}
function listEntities() {
  return Object.values(load());
}
function resolveEntityKeysInQuery(query) {
  const candidates = extractEntityCandidates(query);
  const out = /* @__PURE__ */ new Set();
  for (const c of candidates) {
    const key = lookupEntity(c);
    if (key) out.add(key);
  }
  const direct = lookupEntity(query.trim());
  if (direct) out.add(direct);
  return [...out];
}
function discoverAndAnnotateEntities(text, ts) {
  const candidates = extractEntityCandidates(text);
  const keys = /* @__PURE__ */ new Set();
  for (const c of candidates) {
    const k = registerEntity(c, ts);
    if (k) keys.add(k);
  }
  if (keys.size === 0) return { attribute: "", keys: [] };
  const sorted = [...keys].sort();
  const escaped = sorted.join(",").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return {
    attribute: ` data-cerveau-entities="${escaped}"`,
    keys: sorted
  };
}
var ENTITY_FILE, KNOWN_TYPES, cache2, cacheLoadedAt, CANDIDATE_RE;
var init_entities = __esm({
  "src/annotator/entities.ts"() {
    "use strict";
    init_config();
    ENTITY_FILE = "entities.json";
    KNOWN_TYPES = [
      [
        /^(?:postgres|postgresql|mysql|sqlite|mariadb|redis|mongodb|cassandra|dynamodb|neo4j|qdrant|chroma|elasticsearch|chromadb)$/i,
        "db"
      ],
      [
        /^(?:react|next\.?js|vue|svelte|angular|express|fastify|hono|django|flask|fastapi|rails|spring|nest\.?js)$/i,
        "lib"
      ],
      [/^(?:claude|gpt|haiku|sonnet|opus|gemini|llama|mistral|anthropic|openai)/i, "llm"],
      [/^(?:docker|kubernetes|k8s|nginx|traefik|terraform|ansible|helm)$/i, "infra"],
      [/^(?:lazybrain|claude-mem|mem0|letta|graphiti|memgpt)$/i, "project"],
      [/^(?:typescript|javascript|python|rust|go|java|kotlin|swift|ruby|php)$/i, "lang"],
      [/^(?:vitest|jest|playwright|cypress|pytest)$/i, "tool"],
      [/^(?:[A-Z][a-z]+\.?[a-z]+)$/, "concept"]
    ];
    cache2 = null;
    cacheLoadedAt = 0;
    CANDIDATE_RE = /\b((?:[A-Z][a-z]+){2,}|[A-Z][a-z]+[A-Z]\w+|[A-Z]{2,}[a-z]+|[a-z]+(?:-[a-z]+){1,}|[a-z][a-z0-9_]{4,}\.[a-z]{2,4})\b/g;
  }
});

// src/annotator/relations.ts
function normalize(s) {
  return s.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").toLowerCase();
}
function isMeaningful(token) {
  const n = normalize(token);
  return n.length >= 2 && n.length <= 60 && !STOPWORD_OBJECTS.has(n);
}
function extractRelations(text) {
  const triples = /* @__PURE__ */ new Set();
  const causes = /* @__PURE__ */ new Set();
  const replaces = /* @__PURE__ */ new Set();
  const replacedBy = /* @__PURE__ */ new Set();
  const supersedes = /* @__PURE__ */ new Set();
  USES_RE.lastIndex = 0;
  for (let m = USES_RE.exec(text); m !== null; m = USES_RE.exec(text)) {
    const subj = normalize(m[1]);
    const obj = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(obj) && subj !== obj) {
      triples.add(`${subj}|uses|${obj}`);
    }
  }
  USING_RE.lastIndex = 0;
  for (let m = USING_RE.exec(text); m !== null; m = USING_RE.exec(text)) {
    const obj = normalize(m[1]);
    if (isMeaningful(obj)) {
      triples.add(`project|uses|${obj}`);
    }
  }
  IS_RE.lastIndex = 0;
  for (let m = IS_RE.exec(text); m !== null; m = IS_RE.exec(text)) {
    const subj = normalize(m[1]);
    const obj = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(obj) && subj !== obj) {
      triples.add(`${subj}|is-a|${obj}`);
    }
  }
  REQUIRES_RE.lastIndex = 0;
  for (let m = REQUIRES_RE.exec(text); m !== null; m = REQUIRES_RE.exec(text)) {
    const subj = normalize(m[1]);
    const obj = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(obj) && subj !== obj) {
      triples.add(`${subj}|requires|${obj}`);
    }
  }
  CONFIGURED_RE.lastIndex = 0;
  for (let m = CONFIGURED_RE.exec(text); m !== null; m = CONFIGURED_RE.exec(text)) {
    const entity = normalize(m[1]);
    const config = normalize(m[2]);
    if (isMeaningful(entity) && isMeaningful(config)) {
      triples.add(`${entity}|configured-with|${config}`);
    }
  }
  SWITCHED_RE.lastIndex = 0;
  for (let m = SWITCHED_RE.exec(text); m !== null; m = SWITCHED_RE.exec(text)) {
    const first = normalize(m[1]);
    const second = m[2] ? normalize(m[2]) : "";
    if (isMeaningful(first)) {
      if (second && isMeaningful(second)) {
        replaces.add(first);
        triples.add(`${second}|replaces|${first}`);
        supersedes.add(first);
      }
    }
  }
  REPLACES_RE.lastIndex = 0;
  for (let m = REPLACES_RE.exec(text); m !== null; m = REPLACES_RE.exec(text)) {
    const from = m[1] ? normalize(m[1]) : "";
    const to = m[2] ? normalize(m[2]) : "";
    if (from && isMeaningful(from)) {
      replaces.add(from);
      if (to && isMeaningful(to)) {
        triples.add(`${to}|replaces|${from}`);
        supersedes.add(from);
      }
    }
  }
  REPLACES_EXPLICIT_RE.lastIndex = 0;
  for (let m = REPLACES_EXPLICIT_RE.exec(text); m !== null; m = REPLACES_EXPLICIT_RE.exec(text)) {
    const old = normalize(m[1]);
    const newOne = normalize(m[2]);
    if (isMeaningful(old) && isMeaningful(newOne)) {
      replaces.add(old);
      triples.add(`${newOne}|replaces|${old}`);
      supersedes.add(old);
    }
  }
  INSTEAD_OF_RE.lastIndex = 0;
  for (let m = INSTEAD_OF_RE.exec(text); m !== null; m = INSTEAD_OF_RE.exec(text)) {
    const old = normalize(m[1]);
    const newOne = normalize(m[2]);
    if (isMeaningful(old) && isMeaningful(newOne)) {
      replaces.add(old);
      triples.add(`${newOne}|replaces|${old}`);
      supersedes.add(old);
    }
  }
  DEPRECATED_IN_FAVOR_RE.lastIndex = 0;
  for (let m = DEPRECATED_IN_FAVOR_RE.exec(text); m !== null; m = DEPRECATED_IN_FAVOR_RE.exec(text)) {
    const old = normalize(m[1]);
    const newOne = normalize(m[2]);
    if (isMeaningful(old) && isMeaningful(newOne)) {
      replaces.add(old);
      triples.add(`${newOne}|replaces|${old}`);
      supersedes.add(old);
    }
  }
  REPLACED_BY_RE.lastIndex = 0;
  for (let m = REPLACED_BY_RE.exec(text); m !== null; m = REPLACED_BY_RE.exec(text)) {
    const subj = normalize(m[1]);
    const by = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(by)) {
      replacedBy.add(by);
      triples.add(`${by}|replaces|${subj}`);
    }
  }
  PICKED_OVER_RE.lastIndex = 0;
  for (let m = PICKED_OVER_RE.exec(text); m !== null; m = PICKED_OVER_RE.exec(text)) {
    const picked = normalize(m[1]);
    const overOne = normalize(m[2]);
    if (isMeaningful(picked) && isMeaningful(overOne)) {
      triples.add(`${picked}|chosen-over|${overOne}`);
      supersedes.add(overOne);
    }
  }
  CAUSE_RE.lastIndex = 0;
  for (let m = CAUSE_RE.exec(text); m !== null; m = CAUSE_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }
  BECAUSE_RE.lastIndex = 0;
  for (let m = BECAUSE_RE.exec(text); m !== null; m = BECAUSE_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }
  FIXED_BY_RE.lastIndex = 0;
  for (let m = FIXED_BY_RE.exec(text); m !== null; m = FIXED_BY_RE.exec(text)) {
    const solution = m[1].trim();
    if (solution.length >= 6 && solution.length <= 160) {
      causes.add(solution);
    }
  }
  PARCE_QUE_RE.lastIndex = 0;
  for (let m = PARCE_QUE_RE.exec(text); m !== null; m = PARCE_QUE_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }
  REASON_WAS_RE.lastIndex = 0;
  for (let m = REASON_WAS_RE.exec(text); m !== null; m = REASON_WAS_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }
  LED_TO_RE.lastIndex = 0;
  for (let m = LED_TO_RE.exec(text); m !== null; m = LED_TO_RE.exec(text)) {
    const subj = m[1].trim();
    const obj = m[2].trim();
    if (subj.length >= 6 && obj.length >= 6) {
      triples.add(
        `${normalize(subj.split(" ").slice(-3).join(" "))}|caused|${normalize(obj.split(" ").slice(0, 3).join(" "))}`
      );
    }
  }
  return {
    triples: [...triples].slice(0, 6),
    causes: [...causes].slice(0, 3),
    replaces: [...replaces].slice(0, 3),
    replacedBy: [...replacedBy].slice(0, 3),
    supersedes: [...supersedes].slice(0, 3)
  };
}
var USES_RE, USING_RE, REQUIRES_RE, IS_RE, CONFIGURED_RE, SWITCHED_RE, REPLACES_RE, REPLACES_EXPLICIT_RE, INSTEAD_OF_RE, DEPRECATED_IN_FAVOR_RE, REPLACED_BY_RE, PICKED_OVER_RE, CAUSE_RE, BECAUSE_RE, FIXED_BY_RE, PARCE_QUE_RE, REASON_WAS_RE, LED_TO_RE, STOPWORD_OBJECTS;
var init_relations = __esm({
  "src/annotator/relations.ts"() {
    "use strict";
    USES_RE = /\b([A-Z][\w.-]{2,40}|[a-z][\w.-]{2,40})\s+(?:uses|relies on|depends on|is built on|runs on)\s+([A-Z][\w.-]{2,40}|"[^"]+"|'[^']+')/g;
    USING_RE = /\b(?:using|with)\s+([A-Z][\w.-]{2,40}|[a-z][\w.-]{2,40})(?:\s+(?:for|instead of)\s+([A-Z][\w.-]{2,40}|[a-z][\w.-]{2,40}))?/gi;
    REQUIRES_RE = /\b([A-Za-z][\w.-]{2,40})\s+(?:requires?|depends on|needs)\s+([A-Za-z][\w.-]{2,40})/gi;
    IS_RE = /\b([A-Z][\w.-]{2,40})\s+is\s+(?:a|an|the)\s+([\w.-]{2,40})\b/g;
    CONFIGURED_RE = /\b(?:configured?|set|set up)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][\w.-]{2,40})\s+(?:with|to|as)\s+([A-Za-z][\w.-]{2,40}|"[^"]+"|'[^']+')/gi;
    SWITCHED_RE = /\b(?:switched?|migrated?)\s+(?:from|to)\s+([A-Za-z][\w.-]{2,40})(?:\s+(?:to|from)\s+([A-Za-z][\w.-]{2,40}))?/gi;
    REPLACES_RE = /\b(?:replace[ds]?|switch(?:ed)? (?:from|away from)|moved? (?:from|away from)|deprecat(?:ed|ing))\s+(?:from\s+)?([A-Za-z][\w.-]{2,40})(?:\s+(?:to|with|by)\s+([A-Za-z][\w.-]{2,40}))?/gi;
    REPLACES_EXPLICIT_RE = /\b(?:replaced|switched|migrated)\s+(?:the\s+)?(?:old\s+)?([A-Za-z][\w.-]{2,40})\s+(?:with|to|by)\s+([A-Za-z][\w.-]{2,40})/gi;
    INSTEAD_OF_RE = /instead\s+of\s+([A-Za-z][\w.-]{2,40}),?\s+(?:now\s+)?(?:using|going with)\s+([A-Za-z][\w.-]{2,40})/gi;
    DEPRECATED_IN_FAVOR_RE = /(?:deprecated|removed)(?:\s+the\s+old)?(?:\s+the\s+)?(?:\s+old)?\s+([A-Za-z](?:[\w.-]*\s+)?[\w.-]{1,40})\s+(?:in favor of|in favour of|for|replaced by|with)\s+([A-Za-z][\w.-]{2,40})/gi;
    REPLACED_BY_RE = /\b([A-Za-z][\w.-]{2,40})\s+(?:replaced by|superseded by|is replaced (?:by|with))\s+([A-Za-z][\w.-]{2,40})/gi;
    PICKED_OVER_RE = /\b(?:we |i )?(?:picked|chose|went with|selected)\s+([A-Za-z][\w.-]{2,40})\s+(?:over|instead of|rather than)\s+([A-Za-z][\w.-]{2,40})/gi;
    CAUSE_RE = /\b(?:because|reason:|caused by|due to|root cause:|since)\s+(.{6,160}?)(?:[.!?]|$)/gi;
    BECAUSE_RE = /(?:the\s+)?(?:issue|problem|bug|error|failure|crash|reason)\s+(?:was|is|were)\s+(?:caused by|due to|because of|because)\s+([A-Za-z][^.!?\n]{5,120})/gi;
    FIXED_BY_RE = /(?:fixed|resolved|fixed it|solved)\s+(?:by|via|using|with)\s+([A-Za-z][^.!?\n]{5,100})/gi;
    PARCE_QUE_RE = /(?:parce que|car|en raison de|à cause de)\s+([A-Za-z][^.!?\n]{5,120})/gi;
    REASON_WAS_RE = /(?:the\s+)?reason\s+(?:was|is)\s+(.{6,120})/gi;
    LED_TO_RE = /\b(.{6,80}?)\s+(?:led to|resulted in|caused)\s+(.{6,80}?)(?:[.!?]|$)/gi;
    STOPWORD_OBJECTS = /* @__PURE__ */ new Set([
      "the",
      "a",
      "an",
      "it",
      "this",
      "that",
      "these",
      "those",
      "true",
      "false",
      "null",
      "undefined",
      "something",
      "nothing",
      "one",
      "two",
      "three",
      "good",
      "bad",
      "better",
      "fine"
    ]);
  }
});

// src/annotator/saliency.ts
function detectSaliency(text, ctx) {
  if (BREAKTHROUGH_RE.test(text)) return "breakthrough";
  if (PAINFUL_BUG_RE.test(text)) return "painful-bug";
  if (CONTRADICTION_RE.test(text)) return "contradiction";
  const lowerText = text.toLowerCase();
  for (const [tag, count] of ctx.recentTagsCount) {
    if (count >= RECURRING_THRESHOLD && lowerText.includes(tag.toLowerCase())) {
      return "recurring";
    }
  }
  const wordRe = /\b([A-Z][a-zA-Z]{2,}|[a-z]{4,})\b/g;
  wordRe.lastIndex = 0;
  for (let m = wordRe.exec(text); m !== null; m = wordRe.exec(text)) {
    const w = m[1].toLowerCase();
    if (w.length < 4) continue;
    if (!ctx.existingConcepts.has(w)) return "first-time";
  }
  return null;
}
var BREAKTHROUGH_RE, PAINFUL_BUG_RE, CONTRADICTION_RE, RECURRING_THRESHOLD, SALIENCY_GLYPH;
var init_saliency = __esm({
  "src/annotator/saliency.ts"() {
    "use strict";
    BREAKTHROUGH_RE = /\b(finally|fixed it|works now|succeeded|victory|breakthrough|it works|got it working|resolved at last)\b/i;
    PAINFUL_BUG_RE = /\b(broken|blocked|frustrating|regression|kept failing|nothing works|wasted hours|deadlock|infinite loop|hours debugging)\b/i;
    CONTRADICTION_RE = /\b(switching to|rolling back to|instead|deprecated|replaced with|now using|changed from|reverting)\b/i;
    RECURRING_THRESHOLD = 3;
    SALIENCY_GLYPH = {
      breakthrough: "\u26A1",
      // ⚡
      "painful-bug": "\u{1FA79}",
      // 🩹
      contradiction: "\u2298",
      // ⊘
      recurring: "\u{1F501}",
      // 🔁
      "first-time": "\u2728"
      // ✨
    };
  }
});

// src/util/pkg-version.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname5, join as join7 } from "node:path";
import { fileURLToPath } from "node:url";
function readVersion() {
  const base = dirname5(fileURLToPath(import.meta.url));
  for (const rel of [
    "../../package.json",
    // src/util/
    "../../../package.json",
    // dist/src/util/ (esbuild)
    "../../../../package.json"
  ]) {
    try {
      const raw = readFileSync4(join7(base, rel), "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
    }
  }
  return "unknown";
}
var PKG_VERSION;
var init_pkg_version = __esm({
  "src/util/pkg-version.ts"() {
    "use strict";
    PKG_VERSION = readVersion();
  }
});

// src/annotator/blocks/helpers.ts
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeForKbd(s) {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function isTablePattern(text) {
  const lines = text.split("\n").map((l) => l.trim());
  let colonCount = 0;
  for (const line of lines) {
    if (line.includes(":") && line.length > 10) {
      colonCount++;
    }
  }
  return colonCount >= 3;
}
function isCodePattern(text) {
  const trimmed = text.trim();
  if (/^[{[]|^SELECT\s|^INSERT\s|^UPDATE\s|^DELETE\s|^CREATE\s/i.test(trimmed)) {
    return true;
  }
  if (/`[^`]{3,}`/g.test(text)) {
    return true;
  }
  return false;
}
function isQuotePattern(text) {
  return /^["'""]|["'""]$|"[^"]{10,}"/.test(text.trim());
}
function enrichFactWithSemantics(escapedText) {
  const text = escapedText.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  if (/<[a-z]/i.test(text)) return escapedText;
  let out = text;
  out = out.replace(
    /(?:^|(?<=\n))((?:\$\s|(?:git|npm|lazybrain|pytest|docker|node|curl|python|pip|cargo|go|bash|sh)\s)[^\n]*)/g,
    (match) => `<kbd>${escapeForKbd(match)}</kbd>`
  );
  out = out.replace(
    /(?:^|(?<=\n))((?:Output|stderr|stdout):\s[^\n]*|(?:FAILED|PASSED|ERROR|Traceback)[^\n]*)/g,
    (match) => `<samp>${escapeForKbd(match)}</samp>`
  );
  const ACRONYMS = {
    OAuth: "Open Authorization",
    JWT: "JSON Web Token",
    FTS5: "SQLite Full-Text Search v5",
    RRF: "Reciprocal Rank Fusion",
    HyDE: "Hypothetical Document Embeddings",
    BM25: "Best Matching 25 ranking function",
    PKCE: "Proof Key for Code Exchange",
    SSO: "Single Sign-On",
    CORS: "Cross-Origin Resource Sharing",
    CSRF: "Cross-Site Request Forgery",
    XSS: "Cross-Site Scripting",
    "CI/CD": "Continuous Integration / Continuous Deployment",
    ORM: "Object-Relational Mapper",
    SQL: "Structured Query Language",
    REST: "Representational State Transfer",
    JSON: "JavaScript Object Notation",
    API: "Application Programming Interface",
    CLI: "Command-Line Interface",
    IDE: "Integrated Development Environment",
    LLM: "Large Language Model",
    RAG: "Retrieval-Augmented Generation",
    TLS: "Transport Layer Security",
    TTL: "Time To Live",
    UUID: "Universally Unique Identifier",
    TDD: "Test-Driven Development",
    DRY: "Don't Repeat Yourself",
    SOLID: "Single Responsibility, Open-Closed, Liskov, Interface Segregation, Dependency Inversion"
  };
  const wrapped = /* @__PURE__ */ new Set();
  for (const [acronym, expansion] of Object.entries(ACRONYMS)) {
    if (wrapped.has(acronym)) continue;
    const re = new RegExp(`\\b${acronym.replace(/[()]/g, "\\$&")}\\b`);
    if (re.test(out)) {
      out = out.replace(re, `<abbr title="${expansion}">${acronym}</abbr>`);
      wrapped.add(acronym);
    }
  }
  out = out.replace(/(\$\{?[A-Z][A-Z0-9_]{1,}\}?)/g, "<var>$1</var>");
  return out;
}
function renderFactAsHtml(text) {
  const escaped = esc(text);
  if (isCodePattern(text)) {
    return `<pre><code>${escapeForKbd(text)}</code></pre>`;
  }
  if (isTablePattern(text)) {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const rows = lines.map((line) => {
      const parts = line.split(":").map((p) => p.trim());
      return `<tr>${parts.map((p) => `<td>${esc(p)}</td>`).join("")}</tr>`;
    });
    return `<table><tbody>${rows.join("")}</tbody></table>`;
  }
  if (isQuotePattern(text)) {
    return `<blockquote>${enrichFactWithSemantics(escaped)}</blockquote>`;
  }
  return `<p>${enrichFactWithSemantics(escaped)}</p>`;
}
function detectDpubRoleForFact(text) {
  if (/(?:this was wrong|the correct|should be|the fix is|the right way|correction)/i.test(text)) {
    return "doc-errata";
  }
  if (/\b(?:warning|careful|don'?t|avoid|do not|never|failed|crashed?|broken|error|bug)\b/i.test(text)) {
    return "doc-warning";
  }
  if (/\b(?:tip|hint|note|best practice|trick)\b/i.test(text)) {
    return "doc-tip";
  }
  if (/\b(?:example|e\.g\.|for instance|like this|demo)\b/i.test(text)) {
    return "doc-example";
  }
  return null;
}
function addDays(isoDate, days) {
  const date = new Date(isoDate);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}
var init_helpers = __esm({
  "src/annotator/blocks/helpers.ts"() {
    "use strict";
  }
});

// src/annotator/blocks/antipatterns.ts
function hasToolOutputMarkers(text) {
  const count = (text.match(/===/g) ?? []).length;
  return count >= 2;
}
function passesQualityGate(fact) {
  const text = fact.text;
  if (text.length < 20) return false;
  const words = (text.match(/\b[a-zA-Z0-9][a-zA-Z0-9'_-]*\b/g) ?? []).length;
  if (words < 4) return false;
  if (BARE_TIMESTAMP_RE.test(text)) return false;
  if (TOOL_OUTPUT_START_RE.test(text) || hasToolOutputMarkers(text)) return false;
  const hasKeyword = ANTIPATTERN_KEYWORD_RE.test(text);
  if (fact.kind === "error" && !hasKeyword) {
    if (!FAILURE_VERB_RE.test(text)) return false;
  }
  return true;
}
function renderAntipatterns(input) {
  const antiPatterns = input.facts.filter(
    (f) => (f.kind === "error" || ANTIPATTERN_KEYWORD_RE.test(f.text)) && passesQualityGate(f)
  );
  if (antiPatterns.length === 0) return "";
  const items = antiPatterns.slice(0, 3).map((a) => {
    const role = detectDpubRoleForFact(a.text) ?? "doc-warning";
    return `    <p role="${role}">${enrichFactWithSemantics(esc(a.text))}</p>`;
  });
  return [
    `  <aside role="doc-warning" data-section="antipatterns">`,
    `    <strong>Anti-patterns (don't redo):</strong>`,
    ...items,
    "  </aside>"
  ].join("\n");
}
var BARE_TIMESTAMP_RE, TOOL_OUTPUT_START_RE, FAILURE_VERB_RE, ANTIPATTERN_KEYWORD_RE;
var init_antipatterns = __esm({
  "src/annotator/blocks/antipatterns.ts"() {
    "use strict";
    init_helpers();
    BARE_TIMESTAMP_RE = /^\s*\d{1,2}:\d{2}\.?\s*$/;
    TOOL_OUTPUT_START_RE = /^\s*(===|---|>>>|\$\s)/;
    FAILURE_VERB_RE = /\b(?:failed|broke|crashed|error|because|caused|resulted)\b|(?:échoué|cassé|planté|erreur|parce que|causé|entraîné)/i;
    ANTIPATTERN_KEYWORD_RE = /\b(?:don'?t|never|do not|abandoned|reverted|tried using|broke|avoid|skip|rollback|backed out|workaround|mistake|shouldn'?t|was wrong)\b|(?:ne pas|jamais|abandonné|annulé|cassé|éviter|erreur|ne devrait pas|était (?:faux|une erreur))/i;
  }
});

// src/annotator/blocks/categories.ts
function renderCategories(input) {
  if (input.tags.length === 0) return "";
  const catLinks = input.tags.filter((v, i, arr) => arr.indexOf(v) === i).map((t) => `<a href="#/search/${esc(t)}" class="section-link">${esc(t)}</a>`).join(" \xB7 ");
  return [
    "  <footer>",
    `    <nav class="categories">Categories: ${catLinks}</nav>`,
    "  </footer>"
  ].join("\n");
}
var init_categories = __esm({
  "src/annotator/blocks/categories.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/counterfactuals.ts
function renderCounterfactuals(input) {
  const lc = (text) => text.toLowerCase();
  const counterfactuals = input.facts.filter(
    (f) => lc(f.text).includes("considered but") || lc(f.text).includes("alternative") || lc(f.text).includes("tried") || lc(f.text).includes("attempted") || lc(f.text).includes("but it didn't") || lc(f.text).includes("but it did not") || // French mirror (same .includes() style as qa-section.ts's bilingual patterns)
    lc(f.text).includes("envisag\xE9") || lc(f.text).includes("essay\xE9") || lc(f.text).includes("tent\xE9") || lc(f.text).includes("n'a pas fonctionn\xE9") || lc(f.text).includes("n'a pas march\xE9")
  );
  if (counterfactuals.length === 0) return "";
  const items = counterfactuals.slice(0, 3).map((c) => {
    const role = detectDpubRoleForFact(c.text) ?? "doc-note";
    return `    <p role="${role}">${enrichFactWithSemantics(esc(c.text))}</p>`;
  });
  return [
    `  <aside role="doc-note" data-section="counterfactuals">`,
    "    <strong>Considered but rejected:</strong>",
    ...items,
    "  </aside>"
  ].join("\n");
}
var init_counterfactuals = __esm({
  "src/annotator/blocks/counterfactuals.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/errors.ts
function renderErrors(input) {
  const errors = input.facts.filter(
    (f) => f.kind === "error" || /\b(?:error|failed|crash|exception|enoent|eacces|typeerror|syntaxerror|timeout|broken)/i.test(
      f.text
    ) || // French mirror — no \b around the accented alternatives (JS's \b is
    // ASCII-\w-only and would fail right after/before an accented letter).
    /(?:erreur|échec|échoué|planté|plantage|cassé|bogue)/i.test(f.text)
  );
  if (errors.length === 0) return "";
  const items = errors.slice(0, 5).map((e) => {
    const sig = e.text.replace(/:\d+/g, "").slice(0, 80).toLowerCase();
    const role = detectDpubRoleForFact(e.text) ?? "doc-warning";
    return [
      `    <details data-error="${esc(sig)}" aria-expanded="false">`,
      `      <summary>Error: ${e.text.split("\n")[0].slice(0, 50)}...</summary>`,
      `      <p role="${role}">${enrichFactWithSemantics(esc(e.text))}</p>`,
      "    </details>"
    ].join("\n");
  });
  return [`  <section data-section="errors">`, ...items, "  </section>"].join("\n");
}
var init_errors = __esm({
  "src/annotator/blocks/errors.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/facts-section.ts
function renderFactsSection(input) {
  const { facts, tldr } = input;
  const [firstFact, ...restFacts] = facts;
  const tldrText = tldr ?? firstFact?.text ?? "";
  const tldrSection = tldrText ? [
    `  <section data-section="tldr">`,
    `    <p>${enrichFactWithSemantics(esc(tldrText.slice(0, 200)))}</p>`,
    "  </section>"
  ].join("\n") : "";
  const summarySection = firstFact ? [
    `  <section data-section="summary">`,
    `    <details open data-primary aria-expanded="true">`,
    `      <summary>${esc(firstFact.text)}</summary>`,
    `      <div id="fact-0" data-cerveau-fact data-cerveau-confidence="${firstFact.confidence.toFixed(2)}" data-cerveau-kind="${esc(firstFact.kind)}"${firstFact.extractor ? ` data-cerveau-extracted-by="${esc(firstFact.extractor)}"` : ""}>${renderFactAsHtml(firstFact.text)}</div>`,
    "    </details>",
    "  </section>"
  ].join("\n") : "";
  const factsSection = restFacts.length > 0 ? [
    `  <section data-section="facts">`,
    ...restFacts.map(
      (f, idx) => [
        `    <details aria-expanded="false">`,
        `      <summary>${esc(f.text)}</summary>`,
        `      <div id="fact-${idx + 1}" data-cerveau-fact data-cerveau-confidence="${f.confidence.toFixed(2)}" data-cerveau-kind="${esc(f.kind)}"${f.extractor ? ` data-cerveau-extracted-by="${esc(f.extractor)}"` : ""}>${renderFactAsHtml(f.text)}</div>`,
        "    </details>"
      ].join("\n")
    ),
    "  </section>"
  ].join("\n") : "";
  return [tldrSection, summarySection, factsSection].filter(Boolean).join("\n");
}
var init_facts_section = __esm({
  "src/annotator/blocks/facts-section.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/glossary.ts
function renderGlossary(input) {
  if (input.entities.length < 2) return "";
  const items = input.entities.slice(0, 8).map((e) => {
    const colonIdx = e.indexOf(":");
    const typeLabel = colonIdx > -1 ? e.slice(0, colonIdx) : "entity";
    const key = colonIdx > -1 ? e.slice(colonIdx + 1) : e;
    const display = key.replace(/-/g, " ");
    return [
      `    <dt><dfn id="${esc(key)}">${esc(display)}</dfn></dt>`,
      `    <dd>${esc(typeLabel)}</dd>`
    ].join("");
  });
  return [`  <aside class="glossary">`, "    <dl>", ...items, "    </dl>", "  </aside>"].join("\n");
}
var init_glossary = __esm({
  "src/annotator/blocks/glossary.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/meta-head.ts
function renderMetaHead(input) {
  const metas = [];
  if (input.answers) {
    metas.push(`<meta name="answers" content="${esc(input.answers)}">`);
  }
  if (input.aliases) {
    metas.push(`<meta name="aliases" content="${esc(input.aliases)}">`);
  }
  if (input.commitRef) {
    metas.push(`<meta name="commit-ref" content="${esc(input.commitRef)}">`);
  }
  if (input.backlinkCount != null && input.backlinkCount > 0) {
    metas.push(`<meta name="backlinks" content="${input.backlinkCount}">`);
  }
  return metas.length > 0 ? metas.join("\n") : "";
}
var init_meta_head = __esm({
  "src/annotator/blocks/meta-head.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/outcome.ts
function renderOutcome(input) {
  if (!input.replaces || input.replaces.length === 0) return "";
  return [
    `  <aside role="doc-note" data-section="outcome">`,
    `    <p>This note supersedes: ${esc(input.replaces.join(", "))}</p>`,
    "  </aside>"
  ].join("\n");
}
var init_outcome = __esm({
  "src/annotator/blocks/outcome.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/qa-section.ts
function renderQaSection(input) {
  if (input.pairs.length === 0) return "";
  const items = input.pairs.slice(0, 5).map(
    ({ question, answer }) => [
      `    <details data-q="${esc(question.toLowerCase().replace(/\s+/g, "-"))}" aria-expanded="false">`,
      `      <summary>${esc(question)}</summary>`,
      `      <p>${enrichFactWithSemantics(esc(answer))}</p>`,
      "    </details>"
    ].join("\n")
  );
  return [`  <section data-section="qa">`, ...items, "  </section>"].join("\n");
}
function extractQaPatterns(facts) {
  const qa = [];
  for (const f of facts) {
    const text = f.text.toLowerCase();
    if (text.includes("why ")) {
      const prefix = text.split("why ")[0].trim();
      qa.push([`Why ${prefix}?`, f.text]);
    } else if (text.includes("how ")) {
      const prefix = text.split("how ")[0].trim();
      qa.push([`How to ${prefix}?`, f.text]);
    } else if (text.includes("what ")) {
      const prefix = text.split("what ")[0].trim();
      qa.push([`What ${prefix}?`, f.text]);
    } else if (text.includes("when ")) {
      const prefix = text.split("when ")[0].trim();
      qa.push([`When should ${prefix}?`, f.text]);
    } else if (text.includes("pourquoi ")) {
      const prefix = text.split("pourquoi ")[0].trim();
      qa.push([`Pourquoi ${prefix}?`, f.text]);
    } else if (text.includes("comment ")) {
      const prefix = text.split("comment ")[0].trim();
      qa.push([`Comment ${prefix}?`, f.text]);
    } else if (text.includes("quand ")) {
      const prefix = text.split("quand ")[0].trim();
      qa.push([`Quand ${prefix}?`, f.text]);
    }
  }
  return qa.slice(0, 5);
}
var init_qa_section = __esm({
  "src/annotator/blocks/qa-section.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/references.ts
function renderReferences(input) {
  const allFiles = [...input.filesModified ?? [], ...input.filesRead ?? []];
  if (allFiles.length === 0) return "";
  const fileLinks = allFiles.map((f) => {
    const basename3 = f.split(/[\\/]/).pop() ?? f;
    return `<data value="${esc(f)}">${esc(basename3)}</data>`;
  }).join(", ");
  return [`  <section data-section="references">`, `    ${fileLinks}`, "  </section>"].join("\n");
}
var init_references = __esm({
  "src/annotator/blocks/references.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/tool-trace.ts
function renderToolTrace(input) {
  const traces = input.facts.filter(
    (f) => /\b(Bash:|pytest|Output:|FAILED|grep|docker build|npm install|EXPLAIN)\b/i.test(f.text)
  );
  if (traces.length === 0 && !input.tool) return "";
  const body = traces.length > 0 ? traces.map((f) => `    <p>${enrichFactWithSemantics(esc(f.text))}</p>`).join("\n") : `    <p>${esc(input.tool ?? "tool")} run recorded.</p>`;
  return [`  <section data-section="tool_trace">`, body, "  </section>"].join("\n");
}
var init_tool_trace = __esm({
  "src/annotator/blocks/tool-trace.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/template.ts
function emitWikipediaNote(input) {
  const {
    id,
    title,
    type,
    created,
    source,
    tier,
    importance,
    tags,
    facts,
    relations,
    toolMeta,
    saliencyKind,
    validForDays,
    meanConfidence,
    commitRef,
    aliases,
    backlinkCount,
    tldr,
    topic,
    agent,
    sourceKind,
    sessionParent,
    gitBranch
  } = input;
  const tagsAttr = esc(tags.join(" "));
  const dateShort = created.slice(0, 10);
  const qaFacts = extractQaPatterns(facts);
  const relAttrs = buildRelationAttrs(relations);
  const toolAttrs = buildToolAttrs(toolMeta);
  const saliencyAttr = saliencyKind ? `
         data-cerveau-saliency-kind="${esc(saliencyKind)}"` : "";
  const topicAttr = topic ? `
         data-cerveau-topic="${esc(topic)}"` : "";
  const ariaCurrentAttr = (relations?.replaces?.length ?? 0) > 0 && !validForDays ? `
         aria-current="page"` : "";
  const confidenceAttr = meanConfidence != null && meanConfidence > 0 ? `
         data-cerveau-confidence="${meanConfidence.toFixed(2)}"` : "";
  const validFromAttr = `
         data-cerveau-valid-from="${esc(created)}"`;
  const validUntilAttr = validForDays ? `
         data-cerveau-valid-until="${esc(addDays(created, validForDays))}"` : "";
  const typeClass = `type-${type.toLowerCase().replace(/\s+/g, "-")}`;
  const articleOpen = [
    `<article id="${esc(id)}"`,
    `         class="${typeClass}"`,
    `         data-cerveau-version="${PKG_VERSION}"`,
    `         data-cerveau-created="${esc(created)}"`,
    `         data-cerveau-type="${esc(type)}"`,
    `         data-cerveau-source="${esc(source)}"`,
    `         data-cerveau-tier="${tier}"`,
    `         data-cerveau-importance="${importance.toFixed(2)}"`,
    `         data-cerveau-tags="${tagsAttr}"${saliencyAttr}${topicAttr}${ariaCurrentAttr}${confidenceAttr}${validFromAttr}${validUntilAttr}`,
    ...relAttrs,
    ...toolAttrs,
    ...buildProvenanceAttrs({ agent, sourceKind, sessionParent, commitRef, gitBranch }),
    ">"
  ].join("\n");
  const infoboxRows = buildInfoboxRows(
    type,
    tags,
    source,
    relations,
    toolMeta,
    meanConfidence,
    validForDays
  );
  const header = [
    "  <header>",
    `    <h2><time datetime="${esc(created)}">${esc(dateShort)}</time> ${esc(title)}</h2>`,
    `    <aside class="infobox">`,
    "      <dl>",
    ...infoboxRows.map((r) => `        ${r}`),
    "      </dl>",
    "    </aside>",
    "  </header>"
  ].join("\n");
  const glossaryAside = renderGlossary({ entities: relations?.entities ?? [] });
  const factsHtml = renderFactsSection({ facts, tldr });
  const refSection = renderReferences({
    filesModified: toolMeta?.filesModified,
    filesRead: toolMeta?.filesRead
  });
  const footer = renderCategories({ tags: [type, ...tags] });
  const jsonLdData = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `memory://${esc(id)}`,
    name: title,
    dateCreated: created,
    keywords: tags.join(",")
  };
  if ((relations?.entities?.length ?? 0) > 0) {
    jsonLdData.about = relations.entities.map((e) => ({ "@id": `memory://${esc(e)}` }));
  }
  if ((relations?.replaces?.length ?? 0) > 0) {
    jsonLdData.supersedes = relations.replaces.map((r) => ({ "@id": `memory://${esc(r)}` }));
  }
  const jsonLd = `  <script type="application/ld+json">
${JSON.stringify(jsonLdData, null, 2).split("\n").map((line) => `  ${line}`).join("\n")}
  </script>`;
  const answersContent = extractAnswers(facts).join("; ");
  const aliasesContent = (aliases ?? []).join(",");
  const metaHead = renderMetaHead({
    answers: answersContent,
    aliases: aliasesContent,
    commitRef,
    backlinkCount
  });
  const qaSection = renderQaSection({
    pairs: qaFacts.map(([question, answer]) => ({ question, answer }))
  });
  const errorSection = renderErrors({ facts });
  const outcomeSection = renderOutcome({ replaces: relations?.replaces });
  const counterfactualSection = renderCounterfactuals({ facts });
  const antiPatternSection = renderAntipatterns({ facts });
  const toolTraceSection = renderToolTrace({ facts, tool: toolMeta?.tool });
  const charsetMeta = '<meta charset="utf-8">';
  const parts = [
    charsetMeta,
    metaHead,
    articleOpen,
    header,
    glossaryAside,
    qaSection,
    factsHtml,
    toolTraceSection,
    errorSection,
    outcomeSection,
    counterfactualSection,
    antiPatternSection,
    refSection,
    footer,
    jsonLd,
    "</article>"
  ];
  return parts.filter(Boolean).join("\n");
}
function buildRelationAttrs(relations) {
  if (!relations) return [];
  const attrs = [];
  if (relations.replaces?.length) {
    attrs.push(`         data-cerveau-replaces="${esc(relations.replaces.join(","))}"`);
  }
  if (relations.causes?.length) {
    attrs.push(`         data-cerveau-causes="${esc(relations.causes.join("|"))}"`);
  }
  if (relations.triples?.length) {
    attrs.push(`         data-cerveau-triples="${esc(relations.triples.join(";"))}"`);
  }
  if (relations.entities?.length) {
    attrs.push(`         data-cerveau-entities="${esc(relations.entities.join(","))}"`);
  }
  return attrs;
}
function buildProvenanceAttrs(input) {
  const attrs = [];
  if (input.agent) attrs.push(`         data-cerveau-agent="${esc(input.agent)}"`);
  if (input.sourceKind) {
    attrs.push(`         data-cerveau-source-kind="${esc(input.sourceKind)}"`);
  }
  if (input.sessionParent) {
    attrs.push(`         data-cerveau-session-parent="${esc(input.sessionParent)}"`);
  }
  if (input.commitRef) {
    attrs.push(`         data-cerveau-git-commit="${esc(input.commitRef)}"`);
  }
  if (input.gitBranch) {
    attrs.push(`         data-cerveau-git-branch="${esc(input.gitBranch)}"`);
  }
  return attrs;
}
function buildToolAttrs(toolMeta) {
  if (!toolMeta) return [];
  const attrs = [];
  if (toolMeta.cwd) attrs.push(`         data-cerveau-cwd="${esc(toolMeta.cwd)}"`);
  if (toolMeta.tool) attrs.push(`         data-cerveau-tool="${esc(toolMeta.tool)}"`);
  if (toolMeta.filesModified?.length) {
    attrs.push(`         data-cerveau-files-modified="${esc(toolMeta.filesModified.join(","))}"`);
  }
  if (toolMeta.filesRead?.length) {
    attrs.push(`         data-cerveau-files-read="${esc(toolMeta.filesRead.join(","))}"`);
  }
  return attrs;
}
function buildInfoboxRows(type, tags, source, relations, toolMeta, meanConfidence, validForDays) {
  const rows = [];
  rows.push(`<dt>Type</dt><dd>${esc(type)}</dd>`);
  rows.push("<dt>Status</dt><dd>active</dd>");
  if (tags.length > 0) rows.push(`<dt>Tags</dt><dd>${esc(tags.join(", "))}</dd>`);
  rows.push(`<dt>Source</dt><dd>${esc(source)}</dd>`);
  if (relations?.replaces?.length) {
    const links = relations.replaces.map(
      (r) => `<a href="#/note/${encodeURIComponent(r)}" rel="prev" data-cerveau-link-type="replaces">${esc(r)}</a>`
    ).join(", ");
    rows.push(`<dt>Replaces</dt><dd>${links}</dd>`);
  }
  if (toolMeta?.tool) {
    rows.push(`<dt>Tool</dt><dd>${esc(toolMeta.tool)}</dd>`);
  }
  if (meanConfidence != null && meanConfidence > 0) {
    const conf = meanConfidence.toFixed(2);
    rows.push(
      `<dt>Confidence</dt><dd><meter value="${conf}" min="0" max="1" optimum="1">${conf}</meter></dd>`
    );
  }
  if (validForDays != null && validForDays > 0) {
    rows.push(
      `<dt>Valid for</dt><dd><time datetime="P${validForDays}D">${validForDays} days</time></dd>`
    );
  }
  return rows;
}
function extractAnswers(facts) {
  const answers = [];
  for (const f of facts) {
    const qMatch = f.text.match(/^(?:why|how|what|when|where)\s+([^?]+)/i);
    if (qMatch) {
      answers.push(qMatch[1].trim());
    }
  }
  return answers;
}
var init_template = __esm({
  "src/annotator/template.ts"() {
    "use strict";
    init_pkg_version();
    init_antipatterns();
    init_categories();
    init_counterfactuals();
    init_errors();
    init_facts_section();
    init_glossary();
    init_helpers();
    init_meta_head();
    init_outcome();
    init_qa_section();
    init_references();
    init_tool_trace();
  }
});

// src/annotator/heuristic.ts
import { createHash } from "node:crypto";
function extractPathsFromText(text) {
  const paths = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(/<data\s+value="([^"]+)">/gi)) {
    paths.add(m[1].replace(/\\/g, "/"));
  }
  for (const m of text.matchAll(
    /(?:^|[\s'"])(?:(?:src|tests|apps|docs|migrations)\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|py|sql|md|json|html|toml|yaml|yml))(?:\s|$|[,.)])/gi
  )) {
    paths.add(m[0].trim().replace(/^[\s'"]+/, ""));
  }
  return [...paths];
}
function extractSessionHash(sessionId) {
  const dashIdx = sessionId.indexOf("-");
  if (dashIdx >= 0) {
    const afterDash = sessionId.slice(dashIdx + 1);
    const m = afterDash.match(/^([0-9a-f]{8})/i);
    if (m) return m[1].toLowerCase();
  }
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}
function annotateSession(input) {
  const ts = input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
  const fromText = extractPathsFromText(input.text);
  const filesModified = [.../* @__PURE__ */ new Set([...input.filesModified ?? [], ...fromText])];
  const filesRead = input.filesRead ?? [];
  const tags = detectTags(input.text, [...filesModified, ...filesRead], input.tool);
  const facts = extractFacts(input.text);
  const type = inferType2(facts, input.tool);
  const title = buildTitle(input.text, facts, tags, input.tool, filesModified);
  const sessionHash = extractSessionHash(input.sessionId);
  const titlePart = title.slice(0, 60);
  const noteId = slug(`${ts.slice(0, 10)}-${titlePart}-${sessionHash}`);
  const importance = computeImportance(facts, tags, input.tool);
  const topic = detectTopic(tags, input.cwd, filesModified);
  const tldr = buildTldr(facts, title);
  const relations = extractRelations(input.text);
  const entityResult = discoverAndAnnotateEntities(input.text, ts);
  const templateFacts = facts.map((f) => ({
    text: f.text,
    confidence: f.confidence,
    kind: f.kind === "decision" ? "decision" : f.kind === "error" ? "error" : "fact",
    extractor: "heuristic"
  }));
  if (templateFacts.length === 0) {
    const fallbacks = buildToolFallbackFacts(input.text, input.tool, filesModified, filesRead);
    templateFacts.push(...fallbacks);
  }
  const trimmedInput = input.text.trim();
  if (trimmedInput.length > 80) {
    const full = trimmedInput.slice(0, 900);
    const hasFull = templateFacts.some((f) => f.text.length >= full.length * 0.7);
    if (!hasFull) {
      templateFacts.unshift({
        text: full,
        confidence: 0.92,
        kind: /^(?:Fix|Bash:|Output:|FAILED|Error|We tried|Attempted)/i.test(trimmedInput) ? "fact" : "fact",
        extractor: "heuristic-full"
      });
    }
  }
  const saliencyKind = (() => {
    try {
      const existingConcepts = /* @__PURE__ */ new Set();
      const conceptRows = topConcepts(200);
      for (const c of conceptRows) existingConcepts.add(c.concept.toLowerCase());
      const cutoff = Date.now() - 30 * 864e5;
      const recentTagsCount = /* @__PURE__ */ new Map();
      for (const n of listAll({ includeExpired: false })) {
        if (!n.created) continue;
        if (new Date(n.created).getTime() < cutoff) continue;
        for (const t of (n.tags ?? "").split(/\s+/).filter(Boolean)) {
          recentTagsCount.set(t, (recentTagsCount.get(t) ?? 0) + 1);
        }
      }
      return detectSaliency(input.text, { existingConcepts, recentTagsCount });
    } catch {
      return null;
    }
  })();
  const meanConfidence = templateFacts.length > 0 ? templateFacts.reduce((sum, f) => sum + f.confidence, 0) / templateFacts.length : 0;
  const validForDays = type === "decision" ? 90 : void 0;
  const html = emitWikipediaNote({
    id: noteId,
    title,
    type,
    created: ts,
    source: `session:${input.sessionId}`,
    tier: "working",
    importance,
    tags,
    facts: templateFacts,
    relations: {
      replaces: relations.replaces.length ? relations.replaces : void 0,
      causes: relations.causes.length ? relations.causes : void 0,
      triples: relations.triples.length ? relations.triples : void 0,
      entities: entityResult.keys.length ? entityResult.keys : void 0
    },
    toolMeta: {
      tool: input.tool,
      cwd: input.cwd,
      filesModified: filesModified.length ? filesModified : void 0,
      filesRead: filesRead.length ? filesRead : void 0
    },
    saliencyKind,
    topic,
    tldr,
    meanConfidence,
    validForDays,
    agent: input.agent,
    sourceKind: input.sourceKind,
    sessionParent: input.sessionParent,
    commitRef: input.gitCommit ?? void 0,
    gitBranch: input.gitBranch
  });
  return { id: noteId, html, factCount: facts.length, tags, type };
}
function buildToolFallbackFacts(text, tool, modified, read) {
  const facts = [];
  if (modified.length) {
    const names = modified.slice(0, 4).join(", ");
    facts.push({ text: `${tool ?? "modified"}: ${names}`, confidence: 0.5, kind: "action" });
  }
  if (read.length) {
    const names = read.slice(0, 4).join(", ");
    facts.push({ text: `read: ${names}`, confidence: 0.3, kind: "action" });
  }
  if (facts.length === 0 && text.length > 0) {
    facts.push({ text: text.slice(0, 400), confidence: 0.4, kind: "fact", extractor: "heuristic" });
  }
  return facts;
}
function detectTags(text, files = [], tool) {
  const found = /* @__PURE__ */ new Set();
  for (const [pattern, tag] of KEYWORD_TAGS) {
    if (pattern.test(text)) found.add(tag);
  }
  for (const f of files) {
    const ext = /\.([a-z0-9]+)$/i.exec(f)?.[1]?.toLowerCase();
    if (!ext) continue;
    if (["ts", "tsx", "mts", "cts"].includes(ext)) found.add("typescript");
    else if (["js", "jsx", "mjs", "cjs"].includes(ext)) found.add("javascript");
    else if (["py"].includes(ext)) found.add("python");
    else if (["rs"].includes(ext)) found.add("rust");
    else if (["go"].includes(ext)) found.add("go");
    else if (["md", "mdx"].includes(ext)) found.add("docs");
    else if (["css", "scss", "less"].includes(ext)) found.add("frontend");
    else if (["sql"].includes(ext)) found.add("database");
    else if (["json", "yaml", "yml", "toml"].includes(ext)) found.add("config");
    else if (["html", "htm"].includes(ext)) found.add("frontend");
    else if (["sh", "bash", "zsh", "ps1"].includes(ext)) found.add("shell");
  }
  if (tool === "Bash") found.add("shell");
  return [...found].slice(0, 8);
}
function extractFacts(text) {
  const out = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 8 && l.length < 400);
  for (const line of lines) {
    if (out.length >= 12) break;
    const cleaned = line.replace(/^[-*•>\d.)\]\s]+/, "").trim();
    if (cleaned.length < 8) continue;
    for (const pattern of DECISION_PATTERNS) {
      const m = cleaned.match(pattern);
      if (m) {
        out.push({ text: completeSentence(m[1] ?? cleaned), kind: "decision", confidence: 0.8 });
        break;
      }
    }
    if (out.length >= 12) break;
    let hit = false;
    for (const pattern of ERROR_PATTERNS) {
      const m = cleaned.match(pattern);
      if (m) {
        out.push({ text: completeSentence(m[1] ?? cleaned), kind: "error", confidence: 0.7 });
        hit = true;
        break;
      }
    }
    if (hit) continue;
    for (const pattern of FACT_PATTERNS) {
      const m = cleaned.match(pattern);
      if (m) {
        out.push({ text: completeSentence(m[0] ?? cleaned), kind: "fact", confidence: 0.6 });
        break;
      }
    }
  }
  return out;
}
function inferType2(facts, tool) {
  if (facts.some((f) => f.kind === "decision")) return "decision";
  if (facts.some((f) => f.kind === "error")) return "episodic";
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") return "procedural";
  if (tool === "Bash") return "episodic";
  return "reference";
}
function buildTitle(text, facts, tags, tool, filesModified = []) {
  if (facts.length > 0) {
    const candidate = facts[0].text.slice(0, 80).trim();
    if (!/^(must|should|never|always|do not|platform|null|exit code|rate limit|permission|access denied)/i.test(
      candidate
    )) {
      return candidate;
    }
  }
  if (tool && filesModified.length > 0) {
    const names = filesModified.map(basename).slice(0, 2).join(", ");
    return `${tool}: ${names}`.slice(0, 80);
  }
  const firstLine = text.split(/\r?\n/).find((l) => {
    const trimmed = l.trim();
    return trimmed.length > 8 && !/^(must|should|never|always|do not|platform|null|exit code|rate limit|permission|access denied|you |do )/i.test(
      trimmed
    );
  });
  if (firstLine) return firstLine.trim().slice(0, 80);
  if (tags.length) {
    return `${tags.slice(0, 2).join(" ")} session`.slice(0, 80);
  }
  return "Session note";
}
function basename(p) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}
function completeSentence(s) {
  const trimmed = s.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
function computeImportance(facts, tags, tool) {
  let base = 0.4;
  if (facts.some((f) => f.kind === "decision")) base += 0.3;
  if (facts.some((f) => f.kind === "error")) base += 0.15;
  if (tags.length >= 3) base += 0.1;
  if (facts.length >= 4) base += 0.1;
  if (facts.length === 0 && tool && (tool === "Read" || tool === "Bash")) base -= 0.1;
  return Math.min(1, Math.max(0.1, base));
}
function detectTopic(tags, cwd, filesModified) {
  let project = "";
  if (cwd) {
    const normalized = normalizeCwd(cwd);
    if (normalized) {
      project = normalized.project;
    }
  }
  const FEATURE_TAGS = [
    "auth",
    "database",
    "api",
    "deploy",
    "testing",
    "security",
    "frontend",
    "performance"
  ];
  const featureTag = tags.find((t) => FEATURE_TAGS.includes(t));
  let module = "";
  if (filesModified && filesModified.length > 0) {
    const firstFile = filesModified[0].replace(/\\/g, "/");
    const parts = firstFile.split("/");
    const srcIdx = parts.findIndex((p) => p === "src" || p === "lib" || p === "app");
    if (srcIdx >= 0 && srcIdx + 1 < parts.length) {
      module = parts[srcIdx + 1].replace(/\.\w+$/, "");
    }
  }
  const segments = [project, featureTag, module].filter(Boolean);
  return segments.length > 0 ? segments.join("/") : void 0;
}
function buildTldr(facts, title) {
  const decision = facts.find((f) => f.kind === "decision");
  if (decision) return decision.text.slice(0, 200);
  const best = [...facts].sort((a, b) => b.confidence - a.confidence)[0];
  if (best && best.text.length > 10) return best.text.slice(0, 200);
  return title.slice(0, 200);
}
var KEYWORD_TAGS, DECISION_PATTERNS, FACT_PATTERNS, ERROR_PATTERNS;
var init_heuristic = __esm({
  "src/annotator/heuristic.ts"() {
    "use strict";
    init_fts();
    init_paths();
    init_cwd_normalizer();
    init_entities();
    init_relations();
    init_saliency();
    init_template();
    KEYWORD_TAGS = [
      [/\b(auth|oauth|jwt|session|login|signin|token)\b/i, "auth"],
      [/\b(api|endpoint|rest|graphql)\b/i, "api"],
      [/\b(db|database|postgres|sqlite|mysql|migration|schema)\b/i, "database"],
      [/\b(test|vitest|jest|spec|coverage)\b/i, "testing"],
      [/\b(deploy|ci|cd|github actions|workflow)\b/i, "deploy"],
      [/\b(refactor|cleanup|simplif|rewrit)/i, "refactor"],
      [/\b(bug|fix|error|exception|crash|broken)\b/i, "bug"],
      [/\b(perf|performance|latency|optimi[sz])/i, "performance"],
      [/\b(security|vuln|cve|xss|injection|csrf)\b/i, "security"],
      [/\b(typescript|tsconfig|types|d\.ts)\b/i, "typescript"],
      [/\b(react|next\.?js|vue|svelte)\b/i, "frontend"],
      [/\b(claude|llm|gpt|anthropic|openai|prompt|context)\b/i, "llm"],
      [/\b(memory|brain|rag|retrieval|embedding|vector)\b/i, "memory"],
      [/\b(docker|kubernetes|k8s|container)\b/i, "infra"],
      [/\b(git|commit|branch|merge|rebase|push)\b/i, "git"]
    ];
    DECISION_PATTERNS = [
      /^(?:decision|décision)\s*[:.-]?\s*(.+)/i,
      /^(?:we (?:decided|chose|picked|will use|are going to use))\s+(.+)/i,
      /^(?:let'?s|i'?ll|i will)\s+(.+)/i,
      /^(?:going to|going with)\s+(.+)/i,
      /^(?:final|chosen|selected)\s*[:.-]?\s*(.+)/i,
      // French mirrors of the four English patterns above (same capture-group
      // shape: line-start anchor + verb phrase + rest-of-line capture). No \b
      // boundaries are used here — same convention as enrich.ts's CLASSIFIERS —
      // because JS's \b is ASCII-\w-only and would silently fail to match right
      // after an accented final letter (e.g. "décidé", "sélectionné").
      /^(?:on (?:a|va) (?:décidé|choisi|opté pour|opté|utiliser)|nous avons (?:décidé|choisi))\s+(.+)/i,
      /^(?:allons-y(?:\s+avec)?|je vais)\s+(.+)/i,
      /^(?:on part (?:sur|avec)|c'est parti pour)\s+(.+)/i,
      /^(?:choisi|sélectionné|retenu)\s*[:.-]?\s*(.+)/i
    ];
    FACT_PATTERNS = [
      /(?:the |a |an |this )?(?:cause|reason|issue|bug|problem)\s+(?:was|is)\s+(.+)/i,
      /(?:turns out|it turns out|i found that|learned that|noticed that)\s+(.+)/i,
      /(?:must|should|need to|has to)\s+(.+)/i,
      // Negation patterns: use full match (m[0]) so "Do not retry" / "Never use X"
      // preserves the negation keyword — critical for anti-redo memory retrieval.
      /(?:never|always|don'?t|do not|avoid|skip|not recommended)\s+(.+)/i,
      /\btried\s+(?:using|to use|implementing)\s+(.+)/i,
      /(?:broke|broken|broke the|broke)\s+(?:(?:the\s+)?(?:build|streaming|api|deploy))\b(.+)?/i,
      /\b(?:rollback|reverted|backed out)\b(?:\s+(?:to|from))?\s*[:.-]?\s*(.+)?/i,
      /\bworkaround\s*[:.-]?\s*(.+)/i,
      /(?:was|is)\s+(?:wrong|a mistake|bad|incorrect)\b(.+)?/i,
      /shouldn'?t\s+have\s+(.+)/i,
      /\b(?:ne pas faire|eviter|attention|déprécié|deprecated)\b(?:\s+(.+))?/i,
      /pourquoi\s+(.+)/i
    ];
    ERROR_PATTERNS = [
      /error\s*[:.-]?\s*(.+)/i,
      /failed\s*(?:to|with|:)?\s*(.+)/i,
      /\bcrashed?\b(?:\s+with)?\s*[:.-]?\s*(.+)?/i,
      /\bbug\b(?:\s+(?:is|was))?\s*[:.-]?\s*(.+)?/i,
      /\b(?:broken|timeout|timed out)\b(?:\s+(?:during|on))?\s*[:.-]?\s*(.+)?/i,
      /\b(?:rejected|denied)\b(?:\s+(?:due to))?\s*[:.-]?\s*(.+)?/i,
      /exception\s*[:.-]?\s*(.+)/i,
      /traceback\s*[:.-]?\s*(.+)/i,
      /\b(?:operationalerror|typeerror|referenceerror|syntaxerror|eresolve|deadlock|enoent|eacces|segfault)\b[:\s]+(.+)?/i,
      /npm err!\s+(.+)/i,
      /(?:^|[\s])(\d+:\d+)\s+(.+)/,
      /(?:^|[\s])([a-z0-9._-]+\.\w+:\d+)/i
    ];
  }
});

// src/util/json-loose.ts
function parseJsonArrayLoose(raw) {
  let cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  cleaned = cleaned.slice(start, end + 1);
  try {
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}
var init_json_loose = __esm({
  "src/util/json-loose.ts"() {
    "use strict";
  }
});

// src/util/claude-cli.ts
import { spawn } from "node:child_process";
async function callClaudeCli(prompt, opts = {}) {
  if (!prompt || prompt.length === 0) return null;
  const model = opts.model ?? "haiku";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cli = opts.binary ?? process.env.LAZYBRAIN_CLAUDE_BIN ?? "claude";
  const fullPrompt = opts.system ? `${opts.system}

${prompt}` : prompt;
  try {
    const stdout = await spawnClaude(cli, fullPrompt, model, timeoutMs);
    if (!stdout) return null;
    return extractTextFromJsonEnvelope(stdout);
  } catch (err) {
    getLogger().warn({ err: err.message }, "claude-cli failed");
    return null;
  }
}
async function callClaudeCliJsonArray(prompt, opts = {}) {
  const raw = await callClaudeCli(prompt, opts);
  if (!raw) return null;
  return parseJsonArrayLoose(raw);
}
async function isClaudeCliAvailable() {
  const now = Date.now();
  if (cliAvailable !== null && now - cliCheckedAt < CLI_AVAILABILITY_TTL_MS) {
    return cliAvailable;
  }
  cliCheckedAt = now;
  try {
    const cli = process.env.LAZYBRAIN_CLAUDE_BIN ?? "claude";
    cliAvailable = await new Promise((resolve9) => {
      const child = spawn(cli, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32"
      });
      let ok = false;
      child.stdout.on("data", () => {
        ok = true;
      });
      child.once("error", () => resolve9(false));
      child.once("close", (code) => resolve9(ok || code === 0));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        resolve9(false);
      }, 5e3);
    });
  } catch {
    cliAvailable = false;
  }
  return cliAvailable;
}
async function llmAvailable(envFlag) {
  const flag = process.env[envFlag] ?? "";
  const enabled = flag !== "" && flag !== "0" && flag.toLowerCase() !== "false";
  if (!enabled) return false;
  if (process.env.ANTHROPIC_API_KEY) return true;
  return isClaudeCliAvailable();
}
function spawnClaude(cli, prompt, model, timeoutMs) {
  return new Promise((resolve9, reject) => {
    const args = [
      "--print",
      "--output-format",
      "json",
      "--model",
      model,
      "--permission-mode",
      "default",
      // Skip the user's MCP servers, hooks, and global/project CLAUDE.md —
      // this is a single headless text-in/JSON-out call with no tool use, but
      // without these flags `claude` bootstraps a full interactive-equivalent
      // session (every configured MCP server, SessionStart hooks, the whole
      // CLAUDE.md hierarchy) before it even looks at the prompt. Measured
      // impact: ~9.4s wall / $0.11 without these flags vs ~3.7s / $0.02 with
      // them, on a machine with a non-trivial global CLAUDE.md and several
      // MCP servers configured — on a cold cache (no recent identical system
      // prompt to reuse server-side) this gap widens well past the old 20s
      // timeout, which is why every note failed, not just some. Mirrors the
      // same fix already proven in src-tauri/src/commands/chat.rs's
      // claude_chat_stream_inner (see its "ephemeral Q&A call" comment).
      "--strict-mcp-config",
      "--setting-sources",
      "local"
    ];
    const child = spawn(cli, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
      env: { ...process.env, PATH: process.env.PATH }
    });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      const detail = stderr.trim() ? ` \u2014 stderr so far: ${stderr.trim().slice(0, 300)}` : "";
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms${detail}`));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`claude CLI spawn failed: ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve9(stdout);
      else reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 200)}`));
    });
    child.stdin.end(prompt);
  });
}
function extractTextFromJsonEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.content === "string") return parsed.content;
    if (typeof parsed.text === "string") return parsed.text;
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          for (const block of m.content) {
            if (typeof block === "object" && block && "text" in block && typeof block.text === "string") {
              return block.text;
            }
          }
        }
      }
    }
  } catch {
  }
  return trimmed;
}
var DEFAULT_TIMEOUT_MS, cliAvailable, cliCheckedAt, CLI_AVAILABILITY_TTL_MS;
var init_claude_cli = __esm({
  "src/util/claude-cli.ts"() {
    "use strict";
    init_json_loose();
    init_logger();
    DEFAULT_TIMEOUT_MS = 6e4;
    cliAvailable = null;
    cliCheckedAt = 0;
    CLI_AVAILABILITY_TTL_MS = 6e4;
  }
});

// src/util/vibe-cli.ts
var vibe_cli_exports = {};
__export(vibe_cli_exports, {
  callVibeCli: () => callVibeCli,
  callVibeCliJsonArray: () => callVibeCliJsonArray,
  isVibeCliAvailable: () => isVibeCliAvailable,
  parseVibeCliOutput: () => parseVibeCliOutput
});
import { spawn as spawn2 } from "node:child_process";
function parseVibeCliOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\[(?:\/\w*|\w+(?:[ =][^\]]*)?)\]/g, "").trim() || null;
}
async function callVibeCli(prompt, opts = {}) {
  if (!prompt || prompt.length === 0) return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS2;
  const cli = opts.binary ?? process.env.LAZYBRAIN_VIBE_BIN ?? "vibe";
  const fullPrompt = opts.system ? `${opts.system}

${prompt}` : prompt;
  try {
    const stdout = await spawnVibe(cli, fullPrompt, timeoutMs);
    if (!stdout) return null;
    return parseVibeCliOutput(stdout);
  } catch (err) {
    getLogger().warn({ err: err.message }, "vibe-cli failed");
    return null;
  }
}
async function callVibeCliJsonArray(prompt, opts = {}) {
  const raw = await callVibeCli(prompt, opts);
  if (!raw) return null;
  return parseJsonArrayLoose(raw);
}
async function isVibeCliAvailable() {
  const now = Date.now();
  if (cliAvailable2 !== null && now - cliCheckedAt2 < CLI_AVAILABILITY_TTL_MS2) {
    return cliAvailable2;
  }
  cliCheckedAt2 = now;
  try {
    const cli = process.env.LAZYBRAIN_VIBE_BIN ?? "vibe";
    cliAvailable2 = await new Promise((resolve9) => {
      const child = spawn2(cli, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32"
      });
      let ok = false;
      child.stdout.on("data", () => {
        ok = true;
      });
      child.once("error", () => resolve9(false));
      child.once("close", (code) => resolve9(ok || code === 0));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        resolve9(false);
      }, 5e3);
    });
  } catch {
    cliAvailable2 = false;
  }
  return cliAvailable2;
}
function spawnVibe(cli, prompt, timeoutMs) {
  return new Promise((resolve9, reject) => {
    const args = ["--prompt", prompt, "--output", "text", "--max-turns", "1", "--trust"];
    const child = spawn2(cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
      env: { ...process.env, PATH: process.env.PATH }
    });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      reject(new Error(`vibe CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(killTimer);
      reject(new Error(`vibe CLI spawn failed: ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve9(stdout);
      else reject(new Error(`vibe CLI exit ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}
var DEFAULT_TIMEOUT_MS2, cliAvailable2, cliCheckedAt2, CLI_AVAILABILITY_TTL_MS2;
var init_vibe_cli = __esm({
  "src/util/vibe-cli.ts"() {
    "use strict";
    init_json_loose();
    init_logger();
    DEFAULT_TIMEOUT_MS2 = 6e4;
    cliAvailable2 = null;
    cliCheckedAt2 = 0;
    CLI_AVAILABILITY_TTL_MS2 = 6e4;
  }
});

// src/util/openai-client.ts
var openai_client_exports = {};
__export(openai_client_exports, {
  callOpenAi: () => callOpenAi,
  callOpenAiJsonArray: () => callOpenAiJsonArray,
  openAiDefaults: () => openAiDefaults
});
function openAiDefaults() {
  const baseUrl = process.env.LAZYBRAIN_OPENAI_BASE_URL ?? "http://127.0.0.1:8080/v1";
  const model = process.env.LAZYBRAIN_OPENAI_MODEL ?? "devstral";
  const keyEnv = process.env.LAZYBRAIN_OPENAI_API_KEY_ENV ?? "MISTRAL_API_KEY";
  return { baseUrl, model, apiKey: process.env[keyEnv] };
}
async function callOpenAi(prompt, opts = {}) {
  if (!prompt) return null;
  const defaults = openAiDefaults();
  const baseUrl = (opts.baseUrl ?? defaults.baseUrl).replace(/\/$/, "");
  const model = opts.model ?? defaults.model;
  const timeoutMs = opts.timeoutMs ?? 3e4;
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (defaults.apiKey) headers.authorization = `Bearer ${defaults.apiKey}`;
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: 0
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      getLogger().warn({ status: resp.status }, "openai-client: non-200");
      return null;
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  } catch (err) {
    getLogger().warn({ err: err.message }, "openai-client failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function callOpenAiJsonArray(prompt, opts = {}) {
  const raw = await callOpenAi(prompt, opts);
  if (!raw) return null;
  return parseJsonArrayLoose(raw);
}
var init_openai_client = __esm({
  "src/util/openai-client.ts"() {
    "use strict";
    init_json_loose();
    init_logger();
  }
});

// src/annotator/llm.ts
async function annotateWithLlm(input) {
  const heuristic = annotateSession(input);
  const log = getLogger();
  const lowConfidence = heuristic.factCount < 3;
  if (!lowConfidence) return heuristic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  try {
    const backend = resolveExtractorBackend();
    if (backend === "openai") {
      const upgraded = await callOpenAiEnrich(input, heuristic);
      if (upgraded) return upgraded;
      return heuristic;
    }
    if (backend === "vibe") {
      if (await isVibeCliAvailable()) {
        const upgraded = await callVibeEnrich(input, heuristic);
        if (upgraded) return upgraded;
      }
      return heuristic;
    }
    if (backend === "claude-cli") {
      if (await isClaudeCliAvailable()) {
        const upgraded = await callClaudeCliEnrich(input, heuristic);
        if (upgraded) return upgraded;
      }
      return heuristic;
    }
    if (apiKey) {
      const upgraded = await callClaude(input, heuristic, apiKey);
      if (upgraded) return upgraded;
    }
  } catch (err) {
    log.warn({ err: err.message }, "LLM annotator failed, falling back to heuristic");
  }
  return heuristic;
}
async function callClaude(input, heuristic, apiKey) {
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Q2: 1-hour TTL keeps the annotation system prompt hot across the
        // whole session, not just the 5-minute default. Reduces $ on
        // multi-batch sessions where Haiku runs every ~10 captures.
        cache_control: { type: "ephemeral", ttl: "1h" }
      }
    ],
    messages: [
      {
        role: "user",
        content: input.text.slice(0, 8e3)
      }
    ]
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      // Q2: extended cache TTL requires the beta header.
      "anthropic-beta": "extended-cache-ttl-2025-04-11",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const raw = data.content?.find((b) => b.type === "text")?.text;
  if (!raw) return null;
  let facts;
  try {
    const json = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    facts = JSON.parse(json);
    if (!Array.isArray(facts)) return null;
  } catch {
    return null;
  }
  return rebuildHtmlWithFacts(input, heuristic, facts);
}
async function callClaudeCliEnrich(input, heuristic) {
  const facts = await callClaudeCliJsonArray(input.text.slice(0, 8e3), {
    system: SYSTEM_PROMPT,
    model: "haiku",
    // 60s (was 20s): claude-cli.ts's spawnClaude cold-starts a full CLI
    // session (MCP servers, hooks, CLAUDE.md) before the prompt is even
    // read; 20s measured too tight and made every note in a real import run
    // fail with "claude CLI timed out after 20000ms". See spawnClaude's
    // comment for the fix (--strict-mcp-config --setting-sources local) and
    // DEFAULT_TIMEOUT_MS's comment for the timing rationale.
    timeoutMs: 6e4
  });
  if (!facts || facts.length === 0) return null;
  return rebuildHtmlWithFacts(input, heuristic, facts);
}
function rebuildHtmlWithFacts(input, base, facts, extractor = "llm:claude-haiku-4-5") {
  const ts = input.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
  const validFacts = facts.filter((f) => f.text && f.text.length > 4).slice(0, 8);
  const inferredType = validFacts.some((f) => f.kind === "decision") ? "decision" : base.type;
  const title = validFacts[0]?.text.slice(0, 80) ?? base.id;
  const templateFacts = validFacts.map((f) => ({
    text: f.text,
    confidence: Math.max(0, Math.min(1, f.confidence)),
    kind: f.kind,
    extractor
  }));
  const html = emitWikipediaNote({
    id: base.id,
    title,
    type: inferredType,
    created: ts,
    source: `session:${input.sessionId}`,
    tier: "working",
    importance: 0.7,
    tags: base.tags,
    facts: templateFacts
  });
  return { ...base, html, factCount: validFacts.length };
}
function resolveExtractorBackend() {
  const explicit = process.env.LAZYBRAIN_EXTRACTOR;
  if (explicit === "vibe") return "vibe";
  if (explicit === "devstral") return "openai";
  if (explicit === "anthropic" || explicit === "haiku" || explicit === "claude") return "anthropic";
  if (explicit === "claude-cli") return "claude-cli";
  return process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai";
}
async function callOpenAiEnrich(input, heuristic) {
  const { callOpenAiJsonArray: callOpenAiJsonArray2, openAiDefaults: openAiDefaults2 } = await Promise.resolve().then(() => (init_openai_client(), openai_client_exports));
  const facts = await callOpenAiJsonArray2(input.text.slice(0, 8e3), {
    system: SYSTEM_PROMPT,
    timeoutMs: 2e4
  });
  if (!facts || facts.length === 0) return null;
  return rebuildHtmlWithFacts(input, heuristic, facts, `llm:${openAiDefaults2().model}`);
}
async function callVibeEnrich(input, heuristic) {
  const facts = await callVibeCliJsonArray(input.text.slice(0, 8e3), {
    system: SYSTEM_PROMPT,
    timeoutMs: 6e4
  });
  if (!facts || facts.length === 0) return null;
  return rebuildHtmlWithFacts(input, heuristic, facts, "llm:vibe");
}
var SYSTEM_PROMPT;
var init_llm = __esm({
  "src/annotator/llm.ts"() {
    "use strict";
    init_claude_cli();
    init_logger();
    init_vibe_cli();
    init_heuristic();
    init_template();
    SYSTEM_PROMPT = `You extract atomic facts from a software engineering session transcript.

Output ONLY a compact JSON array. No prose. No code fence. Each item:
{"text": "fact in 5-25 words ending with a period",
 "confidence": 0.0-1.0,
 "kind": "decision" | "fact" | "error" | "learning"}

Rules:
- Maximum 8 facts.
- Each fact MUST stand alone (no "this", "it", or anaphora).
- "decision" = an explicit choice or course of action.
- "error" = a problem encountered or root cause.
- "learning" = a generalisable insight.
- "fact" = a stable claim about the system.
- Skip greetings, status updates, code listings.
- If session is empty / trivial, output [].`;
  }
});

// src/capture/payload-parser.ts
function parseToolPayload(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return salvageWithRegex(trimmed);
  }
  const tool = strField(raw, "tool_name") ?? "";
  if (!tool) return null;
  const input = raw.tool_input ?? raw.input ?? {};
  const response = raw.tool_response ?? raw.response ?? raw.result ?? {};
  const filesRead = /* @__PURE__ */ new Set();
  const filesModified = /* @__PURE__ */ new Set();
  const inputPath = strField(input, "file_path") ?? strField(input, "notebook_path");
  if (inputPath) {
    if (TOOLS_THAT_READ.has(tool)) filesRead.add(inputPath);
    else if (TOOLS_THAT_MODIFY.has(tool)) filesModified.add(inputPath);
  }
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    if (inputPath) filesModified.add(inputPath);
  }
  if (tool === "Bash") {
    const cmd = strField(input, "command") ?? "";
    for (const p of extractBashFiles(cmd)) {
      if (/^(?:cat|less|tail|head|grep|find|ls|wc|file|stat)\b/.test(cmd)) filesRead.add(p);
      else filesModified.add(p);
    }
  }
  let prose = "";
  if (typeof response === "string") prose = response;
  else if (response && typeof response === "object") {
    prose = strField(response, "output") ?? strField(response, "stdout") ?? strField(response, "text") ?? "";
  }
  prose = clipProse(prose);
  return {
    tool,
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    prose
  };
}
function strField(obj, key) {
  if (!obj) return void 0;
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
function extractBashFiles(cmd) {
  const out = /* @__PURE__ */ new Set();
  FILE_PATH_REGEX.lastIndex = 0;
  for (let m = FILE_PATH_REGEX.exec(cmd); m !== null; m = FILE_PATH_REGEX.exec(cmd)) {
    out.add(m[1]);
  }
  return [...out];
}
function clipProse(s) {
  const trimmed = s.trim();
  if (trimmed.length === 0) return "";
  const stripped = trimmed.replace(/\u001b\[[0-9;]*m/g, "").replace(/(.)\1{6,}/g, "$1$1$1").replace(/\s+/g, " ").trim();
  return stripped.slice(0, 400);
}
function salvageWithRegex(text) {
  const toolMatch = text.match(/"tool_name"\s*:\s*"([^"]+)"/);
  if (!toolMatch) return null;
  const tool = toolMatch[1];
  const filePathMatch = text.match(/"file_path"\s*:\s*"([^"]+)"/);
  const filesRead = /* @__PURE__ */ new Set();
  const filesModified = /* @__PURE__ */ new Set();
  if (filePathMatch) {
    const path = filePathMatch[1].replace(/\\\\/g, "\\");
    if (TOOLS_THAT_READ.has(tool)) filesRead.add(path);
    else if (TOOLS_THAT_MODIFY.has(tool)) filesModified.add(path);
  }
  return {
    tool,
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    prose: ""
  };
}
var TOOLS_THAT_READ, TOOLS_THAT_MODIFY, FILE_PATH_REGEX;
var init_payload_parser = __esm({
  "src/capture/payload-parser.ts"() {
    "use strict";
    TOOLS_THAT_READ = /* @__PURE__ */ new Set(["Read", "NotebookRead", "Grep", "Glob"]);
    TOOLS_THAT_MODIFY = /* @__PURE__ */ new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
    FILE_PATH_REGEX = /(?:^|[\s'"])((?:[A-Z]:[\\/]|\.{1,2}[\\/]|\/)[^\s'":<>|*?]{2,}\.[a-z0-9]{1,8})/gi;
  }
});

// src/capture/validator.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync6, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join8 } from "node:path";
function hashStorePath() {
  return join8(getConfig().cachePath, HASH_STORE);
}
function loadEntries() {
  const now = Date.now();
  if (cachedEntries && now - cachedAt < 5e3) return cachedEntries;
  const path = hashStorePath();
  if (!existsSync6(path)) {
    cachedEntries = [];
    cachedAt = now;
    return cachedEntries;
  }
  const cutoff = now - DEDUP_WINDOW_DAYS * 864e5;
  const lines = readFileSync5(path, "utf8").split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.ts >= cutoff) entries.push(entry);
    } catch {
    }
  }
  cachedEntries = entries;
  cachedAt = now;
  return entries;
}
function persistEntry(entry, entries) {
  const path = hashStorePath();
  if (entries.length % 50 === 0) {
    writeFileSync4(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}
`, "utf8");
  } else {
    writeFileSync4(
      path,
      `${readFileSync5(path, "utf8").replace(/\n?$/, "\n") + JSON.stringify(entry)}
`,
      "utf8"
    );
  }
}
function normalizeForHash(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
function contentHash(text) {
  return createHash2("sha1").update(normalizeForHash(text)).digest("hex");
}
function isRepetitive(text) {
  return new RegExp(`(.)\\1{${REPETITION_LEN - 1},}`).test(text);
}
function jsonStructuralRatio(text) {
  let structural = 0;
  for (const ch of text) {
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === '"' || ch === ":" || ch === ",") {
      structural += 1;
    }
  }
  return text.length > 0 ? structural / text.length : 0;
}
function isJsonOnlyNoise(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  const markerHits = HOOK_PAYLOAD_MARKERS.filter((re) => re.test(trimmed)).length;
  if (markerHits >= 2) return true;
  if (jsonStructuralRatio(trimmed) > 0.7) return true;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return !hasProseValue(parsed);
}
function hasProseValue(value, depth = 0) {
  if (depth > 4) return false;
  if (typeof value === "string") {
    return value.length >= 50 && /\S\s\S+\s\S+/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((v) => hasProseValue(v, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((v) => hasProseValue(v, depth + 1));
  }
  return false;
}
function isLowValueCapture(text) {
  const trimmed = text.trim();
  const readOnlyMatch = trimmed.match(/^Tool\s+(Read|Grep|Glob|NotebookRead|Bash)\s*\./);
  if (readOnlyMatch && trimmed.length < 150) {
    return true;
  }
  if (/^Tool\s+\w+\.\s+(modified|read)\s+\S+\s*$/.test(trimmed)) {
    return true;
  }
  const lines = trimmed.split("\n").filter(Boolean);
  if (lines.length > 3) {
    const jsonLines = lines.filter(
      (line) => line.trim().startsWith("{") || line.trim().startsWith("[")
    ).length;
    if (jsonLines / lines.length > 0.6) {
      return true;
    }
  }
  if (/^Tool\s+(Bash|Read|Grep)\.\s+(npx|npm|node|tsx|vitest|git|curl|find|grep|ls)\s+\S+/.test(
    trimmed
  ) && trimmed.length < 200) {
    return true;
  }
  return false;
}
function shouldCapture(text) {
  const trimmed = text.trim();
  if (process.env.LAZYBRAIN_BENCH === "1") {
    return { ok: true, hash: contentHash(trimmed) };
  }
  if (trimmed.length < MIN_USEFUL_CHARS) {
    return { ok: false, reason: "too_short" };
  }
  if (isRepetitive(trimmed)) {
    return { ok: false, reason: "repetitive" };
  }
  if (isJsonOnlyNoise(trimmed)) {
    return { ok: false, reason: "json_only_noise" };
  }
  if (isLowValueCapture(trimmed)) {
    return { ok: false, reason: "low_value_tool" };
  }
  const hash = contentHash(trimmed);
  const entries = loadEntries();
  if (entries.some((e) => e.hash === hash)) {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true, hash };
}
function recordCapture(hash) {
  const entries = loadEntries();
  const entry = { hash, ts: Date.now() };
  entries.push(entry);
  cachedEntries = entries;
  cachedAt = Date.now();
  try {
    persistEntry(entry, entries);
  } catch {
  }
}
var MIN_USEFUL_CHARS, REPETITION_LEN, DEDUP_WINDOW_DAYS, HASH_STORE, cachedEntries, cachedAt, HOOK_PAYLOAD_MARKERS;
var init_validator = __esm({
  "src/capture/validator.ts"() {
    "use strict";
    init_config();
    MIN_USEFUL_CHARS = 40;
    REPETITION_LEN = 20;
    DEDUP_WINDOW_DAYS = 7;
    HASH_STORE = "capture-hashes.jsonl";
    cachedEntries = null;
    cachedAt = 0;
    HOOK_PAYLOAD_MARKERS = [
      /"session_id"\s*:/,
      /"tool_name"\s*:/,
      /"tool_response"\s*:/,
      /"transcript_path"\s*:/,
      /"hook_event_name"\s*:/
    ];
  }
});

// src/graph/contradictions.ts
import { existsSync as existsSync7, readFileSync as readFileSync6, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join9 } from "node:path";
import { parseHTML as parseHTML3 } from "linkedom";
function benchFixtureId(source) {
  const m = /^session:bench:csmb:([^:]+):/i.exec(source);
  return m ? m[1] : null;
}
function detectContradictions(newNoteHtml, newNoteId) {
  const { document } = parseHTML3(`<!doctype html><html><body>${newNoteHtml}</body></html>`);
  const newRoot = document.querySelector("article, section, memory-batch");
  if (!newRoot) return [];
  const newFacts = Array.from(newRoot.querySelectorAll("[data-cerveau-fact]")).map((el) => el.textContent?.trim() ?? "").filter(Boolean);
  const newTags = new Set(
    (newRoot.getAttribute("data-cerveau-tags") ?? "").split(/\s+/).filter(Boolean)
  );
  const newFullTextForCandidateFilter = (newRoot.textContent ?? "").toLowerCase();
  const allNotes = listAll({ includeExpired: false });
  const newSource = newRoot.getAttribute("data-cerveau-source") ?? "";
  const newBenchFixture = benchFixtureId(newSource);
  const candidates = allNotes.filter((n) => {
    if (n.id === newNoteId) return false;
    if (newBenchFixture && benchFixtureId(n.source ?? "") && newBenchFixture !== benchFixtureId(n.source ?? "")) {
      return false;
    }
    if (newTags.size > 0 && n.tags) {
      const oldTags = n.tags.split(/\s+/).filter(Boolean);
      if (oldTags.some((t) => newTags.has(t))) return true;
    }
    const oldLower = `${(n.title ?? "").toLowerCase()} ${(n.text ?? "").toLowerCase()}`;
    for (const [a, b] of REPLACEMENT_TOKENS) {
      if (a.length < 4 || b.length < 4) continue;
      const newHasB = newFullTextForCandidateFilter.includes(b);
      const oldHasA = oldLower.includes(a);
      const newHasA = newFullTextForCandidateFilter.includes(a);
      const oldHasB = oldLower.includes(b);
      if (newHasB && oldHasA || newHasA && oldHasB) return true;
    }
    return false;
  });
  const hits = [];
  const newFullText = (newRoot.textContent ?? "").trim();
  const newTextLines = newFullText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 4);
  const newCandidateTexts = [.../* @__PURE__ */ new Set([...newFacts, ...newTextLines])];
  for (const candidate of candidates) {
    let candHtml;
    try {
      candHtml = readNote(candidate.path).html;
    } catch {
      continue;
    }
    const { document: cdoc } = parseHTML3(`<!doctype html><html><body>${candHtml}</body></html>`);
    const oldRoot = cdoc.querySelector("article, section, memory-batch");
    if (!oldRoot) continue;
    const oldFacts = Array.from(oldRoot.querySelectorAll("[data-cerveau-fact]")).map((el) => el.textContent?.trim() ?? "").filter(Boolean);
    const oldFullText = (oldRoot.textContent ?? "").trim();
    const oldBodyLines = oldFullText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 4);
    const oldCandidateTexts = [.../* @__PURE__ */ new Set([...oldFacts, ...oldBodyLines])];
    const overlap = (candidate.tags ?? "").split(/\s+/).filter((t) => newTags.has(t));
    for (const newText of newCandidateTexts) {
      const reason = detectReason(newText, oldCandidateTexts);
      if (!reason) continue;
      const match = oldFacts.find((f) => sharesKeyTokens(newText, f, overlap)) ?? oldFacts[0];
      const oldFact = match ?? oldBodyLines[0] ?? "";
      hits.push({
        newId: newNoteId,
        oldId: candidate.id,
        newFact: newText.slice(0, 200),
        oldFact: oldFact.slice(0, 200),
        overlap,
        reason
      });
      break;
    }
  }
  return hits;
}
function detectReason(text, oldFacts) {
  if (NEGATION_MARKERS.some((re) => re.test(text))) return "negation";
  const lower = text.toLowerCase();
  const oldBody = oldFacts.join(" ").toLowerCase();
  for (const [a, b] of REPLACEMENT_TOKENS) {
    const newHasB = lower.includes(b);
    const newHasA = lower.includes(a);
    if (newHasB && !newHasA && (oldBody.includes(a) || oldFacts.some((f) => f.toLowerCase().includes(a)))) {
      return "replacement";
    }
    if (newHasA && !newHasB && (oldBody.includes(b) || oldFacts.some((f) => f.toLowerCase().includes(b)))) {
      return "switch";
    }
  }
  return null;
}
function sharesKeyTokens(a, b, overlapTags) {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (overlapTags.length > 0) {
    return overlapTags.some((t) => lowerA.includes(t) && lowerB.includes(t));
  }
  for (const [x, y] of REPLACEMENT_TOKENS) {
    if ((lowerA.includes(x) || lowerA.includes(y)) && (lowerB.includes(x) || lowerB.includes(y))) {
      return true;
    }
  }
  return false;
}
function annotateContradictions(notePath2, hits) {
  if (hits.length === 0 || !existsSync7(notePath2)) return 0;
  let html = readFileSync6(notePath2, "utf8");
  const { document } = parseHTML3(`<!doctype html><html><body>${html}</body></html>`);
  const root = document.querySelector("article, section, memory-batch");
  if (!root) return 0;
  const targets = [...new Set(hits.map((h) => h.oldId))].join(",");
  root.setAttribute("data-cerveau-conflict-with", targets);
  const reasons = [...new Set(hits.map((h) => h.reason))].join(",");
  root.setAttribute("data-cerveau-conflict-reason", reasons);
  if (!root.getAttribute("data-cerveau-saliency-kind")) {
    root.setAttribute("data-cerveau-saliency-kind", "contradiction");
  }
  html = root.outerHTML;
  writeFileSync5(notePath2, html, "utf8");
  const autoInvalidate = readAutoInvalidateSetting();
  let invalidated = 0;
  if (autoInvalidate) {
    const today = nowIso().slice(0, 10);
    const newId = hits[0]?.newId ?? "";
    const newNoteType = (root.getAttribute("data-cerveau-type") ?? "").toLowerCase();
    const isNewDecision = newNoteType === "decision";
    const oldIds = [
      ...new Set(
        hits.filter((h) => h.reason === "negation" || h.reason === "replacement" && isNewDecision).map((h) => h.oldId)
      )
    ];
    for (const oldId of oldIds) {
      try {
        invalidated += markInvalidatedById(oldId, today, newId) ? 1 : 0;
      } catch {
      }
    }
  }
  logTelemetry({
    event: "error",
    // generic event we already log
    ts: nowIso(),
    where: "contradictions",
    message: `flagged ${hits.length} conflict(s) on ${hits[0]?.newId ?? "?"}${invalidated ? `, invalidated ${invalidated}` : ""}`
  });
  return hits.length;
}
function backannotateConflictTargets(hits) {
  if (hits.length === 0) return 0;
  const newId = hits[0]?.newId ?? "";
  if (!newId) return 0;
  const oldIds = [...new Set(hits.map((h) => h.oldId))];
  const all = listAll({ includeExpired: true });
  let modified = 0;
  for (const oldId of oldIds) {
    const target = all.find((n) => n.id === oldId);
    if (!target || !existsSync7(target.path)) continue;
    try {
      if (addConflictBacklink(target.path, newId)) modified += 1;
    } catch {
    }
  }
  return modified;
}
function addConflictBacklink(notePath2, newId) {
  const html = readFileSync6(notePath2, "utf8");
  let patched = html;
  const existing = html.match(/data-cerveau-conflict-with\s*=\s*["']([^"']*)["']/i);
  if (existing) {
    const current = existing[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (current.includes(newId)) return false;
    const merged = [...current, newId].join(",");
    patched = patched.replace(
      /(data-cerveau-conflict-with\s*=\s*["'])[^"']*(["'])/i,
      (_m, open2, close) => `${open2}${merged}${close}`
    );
  } else {
    patched = injectRootAttr(patched, `data-cerveau-conflict-with="${newId}"`);
  }
  if (!/data-cerveau-saliency-kind\s*=/i.test(patched)) {
    patched = injectRootAttr(patched, 'data-cerveau-saliency-kind="contradiction"');
  }
  if (patched === html) return false;
  writeFileSync5(notePath2, patched, "utf8");
  try {
    indexNote(readNote(notePath2));
  } catch {
  }
  return true;
}
function injectRootAttr(html, attr) {
  return html.replace(
    /(<(?:article|section|memory-batch)\b.*?)(\s*>)/s,
    (_m, head, tail) => `${head} ${attr}${tail}`
  );
}
function markInvalidatedById(oldId, today, byId) {
  const all = listAll({ includeExpired: true });
  const target = all.find((n) => n.id === oldId);
  if (!target) return false;
  const byTarget = all.find((n) => n.id === byId);
  if (byTarget?.created && target.created) {
    const byCreated = new Date(byTarget.created).getTime();
    const oldCreated = new Date(target.created).getTime();
    if (oldCreated >= byCreated) return false;
  }
  const html = readFileSync6(target.path, "utf8");
  if (/data-cerveau-valid-until\s*=/.test(html)) return false;
  const patched = html.replace(
    /(<(?:article|section|memory-batch)\b.*?)(\s*>)/s,
    (_m, head, tail) => `${head}
         data-cerveau-valid-until="${today}" data-cerveau-invalidated-by="${byId}"${tail}`
  );
  if (patched === html) return false;
  writeFileSync5(target.path, patched, "utf8");
  try {
    indexNote(readNote(target.path));
  } catch {
  }
  return true;
}
function readAutoInvalidateSetting() {
  if (process.env.LAZYBRAIN_AUTO_INVALIDATE === "1") return true;
  try {
    const settingsPath = join9(getConfig().cachePath, "settings.json");
    if (existsSync7(settingsPath)) {
      const raw = readFileSync6(settingsPath, "utf8").replace(/^\uFEFF/, "");
      const settings = JSON.parse(raw);
      return settings.autoInvalidate === true;
    }
  } catch {
  }
  return false;
}
var NEGATION_MARKERS, REPLACEMENT_TOKENS;
var init_contradictions = __esm({
  "src/graph/contradictions.ts"() {
    "use strict";
    init_fts();
    init_reader();
    init_config();
    init_telemetry();
    NEGATION_MARKERS = [
      /\bno longer\b/i,
      /\babandon(?:ed|ing)\b/i,
      /\bswitched? (?:from|away from|to)\b/i,
      /\binstead of\b/i,
      /\breplaced? (?:by|with)\b/i,
      /\bdeprecat(?:ed|ing)\b/i,
      /\babandonn[éeèê]\b/i,
      /\bremplac[éeèê]\b/i,
      /\bremplac(?:e|er|ons|ent)\b/i,
      /\bplus de\b/i,
      /\bdéprécié\b/i,
      // Extended markers for common "switching to" patterns — must be compound phrases
      // to avoid single-word false positives (e.g. bare "instead" matches too much)
      /\bswitching to\b/i,
      /\brolling back to\b/i,
      /\binstead of\b/i,
      /\bnow using\b/i,
      /\breplace\s+\w+\s+with\b/i,
      /\bchanged\s+from\b/i,
      /\bupdate\s*:\s*rolling back\b/i,
      /\bupdate\s*:\s*switching\b/i,
      /\bmigrat(?:ed?|ing)\s+from\b/i
    ];
    REPLACEMENT_TOKENS = [
      ["oauth", "jwt"],
      ["postgres", "mysql"],
      ["postgres", "sqlite"],
      ["typescript", "javascript"],
      ["react", "vue"],
      ["react", "angular"],
      ["npm", "yarn"],
      ["npm", "pnpm"],
      // CSS / framework version switches
      ["tailwind v3", "tailwind v4"],
      ["tailwind v4", "tailwind v3"],
      ["tailwindcss v3", "tailwindcss v4"],
      ["tailwindcss v4", "tailwindcss v3"],
      ["prisma", "kysely"],
      ["kysely", "prisma"],
      ["prisma", "drizzle"],
      ["typeorm", "prisma"],
      ["express", "fastify"],
      ["fastify", "express"],
      ["node", "bun"],
      ["bun", "node"]
    ];
  }
});

// src/schema/validator.ts
import { parseHTML as parseHTML4 } from "linkedom";
function validateNote(html) {
  const issues = [];
  const { document } = parseHTML4(`<!doctype html><body>${html}</body>`);
  const root = document.querySelector("article, section, memory-batch");
  if (!root) {
    issues.push({
      level: "error",
      code: "NO_ROOT",
      message: "No <article>, <section>, or <memory-batch> root element found."
    });
    return { ok: false, issues, attrsCount: 0, factsCount: 0 };
  }
  for (const attr of REQUIRED_ROOT_ATTRS) {
    if (!root.getAttribute(attr)) {
      issues.push({
        level: "error",
        code: "MISSING_REQUIRED_ATTR",
        message: `Required attribute missing: ${attr}`,
        element: root.tagName
      });
    }
  }
  const noteId = root.getAttribute("id") ?? "";
  if (noteId) {
    if (noteId.length < 5) {
      issues.push({
        level: "error",
        code: "INVALID_ID_TOO_SHORT",
        message: `Note id "${noteId}" is too short (min 5 chars). Likely a template variable or sub-topic name.`,
        element: root.tagName
      });
    } else if (noteId.startsWith("$")) {
      issues.push({
        level: "error",
        code: "INVALID_ID_TEMPLATE_VAR",
        message: `Note id "${noteId}" starts with '$', indicating an unresolved template variable.`,
        element: root.tagName
      });
    } else if (/^[a-z]+$/.test(noteId)) {
      issues.push({
        level: "error",
        code: "INVALID_ID_BARE_ALPHA",
        message: `Note id "${noteId}" is bare lowercase letters only \u2014 likely a sub-topic name, not a real note ID. IDs must include digits, hyphens, or other characters.`,
        element: root.tagName
      });
    }
  }
  const type = root.getAttribute("data-cerveau-type");
  if (type && !TYPE_VALUES.has(type)) {
    issues.push({
      level: "warn",
      code: "INVALID_TYPE",
      message: `Unknown data-cerveau-type "${type}" \u2014 preserved for forward-compatibility. Known types: ${[...TYPE_VALUES].join(", ")}`
    });
  }
  const tier = root.getAttribute("data-cerveau-tier");
  if (tier && !TIER_VALUES.has(tier)) {
    issues.push({
      level: "warn",
      code: "INVALID_TIER",
      message: `Unknown data-cerveau-tier "${tier}" \u2014 preserved for forward-compatibility. Known tiers: ${[...TIER_VALUES].join(", ")}`
    });
  }
  for (const dateAttr of [
    "data-cerveau-created",
    "data-cerveau-updated",
    "data-cerveau-valid-from",
    "data-cerveau-valid-until",
    "data-cerveau-last-accessed"
  ]) {
    const v = root.getAttribute(dateAttr);
    if (v && !ISO_DATE.test(v)) {
      issues.push({
        level: "error",
        code: "INVALID_DATE",
        message: `Invalid ISO 8601 date on ${dateAttr}: "${v}"`
      });
    }
  }
  for (const fAttr of ["data-cerveau-importance", "data-cerveau-confidence"]) {
    const v = root.getAttribute(fAttr);
    if (v) {
      const n = Number.parseFloat(v);
      if (Number.isNaN(n) || n < 0 || n > 1) {
        issues.push({
          level: "error",
          code: "OUT_OF_RANGE_FLOAT",
          message: `${fAttr} must be a float in [0,1], got "${v}"`
        });
      }
    }
  }
  for (const a of Array.from(root.querySelectorAll("a[data-cerveau-link-type]"))) {
    const lt = a.getAttribute("data-cerveau-link-type");
    if (lt && !LINK_TYPE_VALUES.has(lt)) {
      issues.push({
        level: "warn",
        code: "INVALID_LINK_TYPE",
        message: `Unknown link type "${lt}". Expected one of ${[...LINK_TYPE_VALUES].join(", ")}`
      });
    }
  }
  const factsCount = root.querySelectorAll("[data-cerveau-fact]").length;
  let attrsCount = 0;
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("data-cerveau-")) attrsCount += 1;
    }
  }
  const fullText = `${root.outerHTML} ${root.textContent ?? ""}`;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(fullText)) {
      issues.push({
        level: "error",
        code: "SECRET_DETECTED",
        message: `Potential secret detected (pattern ${pattern.source}). Refusing to store.`
      });
    }
  }
  checkMdnAntiPatterns(root, issues);
  const hasErrors = issues.some((i) => i.level === "error");
  return { ok: !hasErrors, issues, attrsCount, factsCount };
}
function isInsideTag(el, ancestorTag) {
  let current = el.parentElement;
  while (current) {
    if (current.tagName.toLowerCase() === ancestorTag) return true;
    current = current.parentElement;
  }
  return false;
}
function checkMdnAntiPatterns(root, issues) {
  const allEls = Array.from(root.querySelectorAll("*"));
  for (const el of allEls) {
    const tag = el.tagName.toLowerCase();
    if (tag === "address") {
      const text = el.textContent ?? "";
      if (/[/\\]/.test(text) || /\.(ts|py|js|go|rs|html)\b/.test(text)) {
        issues.push({
          level: "error",
          code: "MDN_MISUSE_ADDRESS",
          message: `<address> must not contain file paths or code references. Use <code> or <data> instead. Found: "${text.slice(0, 60)}"`,
          element: "address"
        });
      }
    }
    if (tag === "cite") {
      const text = el.textContent ?? "";
      if (/[/\\]/.test(text) || /\.(ts|py|js|go|rs)\b/.test(text) || /\b[0-9a-f]{7,40}\b/.test(text)) {
        issues.push({
          level: "error",
          code: "MDN_MISUSE_CITE",
          message: `<cite> is for creative work titles, not file paths or commits. Use <data value="path"> instead. Found: "${text.slice(0, 60)}"`,
          element: "cite"
        });
      }
    }
    if (tag === "map") {
      issues.push({
        level: "error",
        code: "MDN_MISUSE_MAP",
        message: "<map> (image map) has no use case in memory notes. Remove it.",
        element: "map"
      });
    }
    if (tag === "ruby") {
      issues.push({
        level: "error",
        code: "MDN_MISUSE_RUBY",
        message: "<ruby> is for CJK typography only. Use plain text or <abbr> for annotations.",
        element: "ruby"
      });
    }
    if (tag === "fieldset" || tag === "legend") {
      const inForm = isInsideTag(el, "form");
      if (!inForm) {
        issues.push({
          level: "error",
          code: "MDN_MISUSE_FIELDSET",
          message: `<${tag}> must only appear inside <form>. Use <section> or <aside> for grouping.`,
          element: tag
        });
      }
    }
    if (tag === "datalist") {
      issues.push({
        level: "error",
        code: "MDN_MISUSE_DATALIST",
        message: '<datalist> is only valid as companion to <input list="...">. Use <ul> for option lists.',
        element: "datalist"
      });
    }
    if (tag === "search") {
      issues.push({
        level: "error",
        code: "MDN_MISUSE_SEARCH",
        message: "<search> is for search controls (form wrappers), not result content. Use <section> instead.",
        element: "search"
      });
    }
    if (tag === "track") {
      const inMedia = isInsideTag(el, "audio") || isInsideTag(el, "video");
      if (!inMedia) {
        issues.push({
          level: "error",
          code: "MDN_MISUSE_TRACK",
          message: "<track> must be a child of <audio> or <video>.",
          element: "track"
        });
      }
    }
    if (tag === "ol" && el.hasAttribute("reversed")) {
      issues.push({
        level: "error",
        code: "MDN_MISUSE_OL_REVERSED",
        message: "<ol reversed> is semantically misleading in memory notes. Use plain <ol> or <ul>.",
        element: "ol[reversed]"
      });
    }
    if (tag === "dialog" && el.hasAttribute("open")) {
      issues.push({
        level: "error",
        code: "MDN_MISUSE_DIALOG",
        message: "<dialog open> is intended for modal UI, not memory note content. Use <aside> or <section>.",
        element: "dialog[open]"
      });
    }
    if (tag.startsWith("lb-")) {
      issues.push({
        level: "error",
        code: "MDN_MISUSE_CUSTOM_ELEMENT",
        message: `Custom element <${tag}> is not allowed. Use standard HTML tags (aside, section, article, etc.).`,
        element: tag
      });
    }
  }
}
var REQUIRED_ROOT_ATTRS, TYPE_VALUES, TIER_VALUES, LINK_TYPE_VALUES, ISO_DATE, SECRET_PATTERNS;
var init_validator2 = __esm({
  "src/schema/validator.ts"() {
    "use strict";
    REQUIRED_ROOT_ATTRS = [
      "id",
      "data-cerveau-version",
      "data-cerveau-created",
      "data-cerveau-source"
    ];
    TYPE_VALUES = /* @__PURE__ */ new Set([
      // Core types (v0.1.0)
      "episodic",
      "semantic",
      "procedural",
      "decision",
      "reference",
      // Additional types from v0.1.0 dream generation
      "architecture",
      "design",
      "feature",
      "feature-set",
      "process",
      "configuration",
      "integration",
      "methodology",
      "project",
      "task-list",
      "workflow-example",
      "database",
      "tech-stack",
      "content-example",
      "challenge",
      "automation",
      "artifacts",
      // Synthesis page types (v0.2.0)
      "topic-overview",
      "project-summary",
      "brain-index",
      // Code-first neuron types (v0.3.0)
      "file-neuron",
      "aggregate-neuron",
      "concept"
    ]);
    TIER_VALUES = /* @__PURE__ */ new Set(["working", "archival"]);
    LINK_TYPE_VALUES = /* @__PURE__ */ new Set([
      "refines",
      "contradicts",
      "generalizes",
      "cites",
      "replaces",
      "follows-from"
    ]);
    ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
    SECRET_PATTERNS = [
      /sk-[A-Za-z0-9]{20,}/,
      // OpenAI / Anthropic-style
      /AIza[0-9A-Za-z\-_]{30,}/,
      // Google
      /ghp_[A-Za-z0-9]{30,}/,
      // GitHub personal access token
      /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
      // PEM keys
      /xox[baprs]-[A-Za-z0-9-]{10,}/,
      // Slack
      /AKIA[0-9A-Z]{16}/,
      // AWS access key id
      /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
      // JWT
      /npm_[A-Za-z0-9]{36}/,
      // npm token
      /glpat-[A-Za-z0-9_-]{20}/,
      // GitLab PAT
      /sbp_[A-Za-z0-9]{40,}/,
      // Supabase key
      /[Bb]earer\s+[A-Za-z0-9\-_.+/=]{20,}/
      // Bearer auth header
    ];
  }
});

// src/store/upsert.ts
function toPlainText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}
function countWords(text) {
  const words = text.match(/\b[a-zA-Z0-9][a-zA-Z0-9'_-]*\b/g);
  return words ? words.length : 0;
}
function isRicherBody(existingHtml, candidateHtml) {
  const existingWords = countWords(toPlainText(existingHtml));
  const candidateWords = countWords(toPlainText(candidateHtml));
  return candidateWords > existingWords;
}
function stampUpdated(html, updatedAtIso) {
  return UPDATED_ATTR_RE.test(html) ? html.replace(UPDATED_ATTR_RE, `data-cerveau-updated="${updatedAtIso}"`) : html.replace(ROOT_OPEN_TAG_RE, `$1 data-cerveau-updated="${updatedAtIso}">`);
}
function stampCreatedAndUpdated(html, createdIso, updatedAtIso) {
  const withCreated = CREATED_ATTR_RE.test(html) ? html.replace(CREATED_ATTR_RE, `data-cerveau-created="${createdIso}"`) : html.replace(ROOT_OPEN_TAG_RE, `$1 data-cerveau-created="${createdIso}">`);
  return stampUpdated(withCreated, updatedAtIso);
}
function mergeUpsertHtml(existingHtml, candidateHtml, updatedAtIso) {
  const preservedCreated = existingHtml.match(CREATED_ATTR_RE)?.[1];
  return preservedCreated ? stampCreatedAndUpdated(candidateHtml, preservedCreated, updatedAtIso) : stampUpdated(candidateHtml, updatedAtIso);
}
var CREATED_ATTR_RE, UPDATED_ATTR_RE, ROOT_OPEN_TAG_RE;
var init_upsert = __esm({
  "src/store/upsert.ts"() {
    "use strict";
    CREATED_ATTR_RE = /data-cerveau-created\s*=\s*["']([^"']*)["']/i;
    UPDATED_ATTR_RE = /data-cerveau-updated\s*=\s*["']([^"']*)["']/i;
    ROOT_OPEN_TAG_RE = /(<(?:article|section)\b[^>]*)>/i;
  }
});

// src/store/writer.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname6 } from "node:path";
function writeNote(html, opts = {}) {
  const validation = validateNote(html);
  if (!validation.ok) {
    const msgs = validation.issues.filter((i) => i.level === "error").map((i) => `[${i.code}] ${i.message}`).join("\n");
    throw new SchemaError(`Schema validation failed:
${msgs}`);
  }
  const idMatch = html.match(/<(?:article|section)\b[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  if (!idMatch) throw new SchemaError("Note has no id attribute on root element.");
  const id = slug(idMatch[1]);
  const createdMatch = html.match(/data-cerveau-created\s*=\s*["']([^"']+)["']/i);
  const candidateCreated = createdMatch?.[1];
  const existing = resolveExistingNoteLocation(id);
  const target = existing?.path ?? notePath(id, candidateCreated);
  if (existsSync8(target) && opts.upsertIfRicher) {
    return upsertExisting(target, id, html, validation.attrsCount);
  }
  if (existsSync8(target) && !opts.overwrite) {
    throw new ConflictError(`Note already exists: ${target}. Pass overwrite to replace.`);
  }
  const finalHtml = existing ? stampCreatedAndUpdated(html, existing.created, nowIso()) : html;
  mkdirSync5(dirname6(target), { recursive: true });
  writeFileSync6(target, finalHtml, "utf8");
  const sizeBytes = Buffer.byteLength(finalHtml, "utf8");
  logTelemetry({
    event: "store",
    ts: nowIso(),
    note_id: id,
    size_bytes: sizeBytes,
    attrs_count: validation.attrsCount
  });
  return { id, path: target, sizeBytes, attrsCount: validation.attrsCount };
}
function resolveExistingNoteLocation(id) {
  try {
    const row = getNoteById(id);
    if (!row?.path || !row.created) return void 0;
    return { path: row.path, created: row.created };
  } catch {
    return void 0;
  }
}
function upsertExisting(target, id, candidateHtml, candidateAttrsCount) {
  const existingHtml = readFileSync7(target, "utf8");
  if (!isRicherBody(existingHtml, candidateHtml)) {
    const existingValidation = validateNote(existingHtml);
    return {
      id,
      path: target,
      sizeBytes: Buffer.byteLength(existingHtml, "utf8"),
      attrsCount: existingValidation.ok ? existingValidation.attrsCount : 0,
      unchanged: true
    };
  }
  const merged = mergeUpsertHtml(existingHtml, candidateHtml, nowIso());
  writeFileSync6(target, merged, "utf8");
  const sizeBytes = Buffer.byteLength(merged, "utf8");
  logTelemetry({
    event: "store",
    ts: nowIso(),
    note_id: id,
    size_bytes: sizeBytes,
    attrs_count: candidateAttrsCount
  });
  return { id, path: target, sizeBytes, attrsCount: candidateAttrsCount };
}
var SchemaError, ConflictError;
var init_writer = __esm({
  "src/store/writer.ts"() {
    "use strict";
    init_note_read();
    init_validator2();
    init_telemetry();
    init_paths();
    init_upsert();
    SchemaError = class extends Error {
      name = "SchemaError";
    };
    ConflictError = class extends Error {
      name = "ConflictError";
    };
  }
});

// src/util/session-cache.ts
function evictIdle(nowMs) {
  if (sessions.size === 0) return;
  for (const [id, entry] of sessions) {
    if (nowMs - entry.lastSeenMs > IDLE_TTL_MS) sessions.delete(id);
  }
  if (sessions.size > MAX_SESSIONS) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
    const overflow = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < overflow; i++) sessions.delete(sorted[i][0]);
  }
}
function alreadyInjected(sessionId) {
  if (!sessionId) return /* @__PURE__ */ new Set();
  return sessions.get(sessionId)?.injected ?? /* @__PURE__ */ new Set();
}
function recordInjected(sessionId, ids) {
  if (!sessionId || ids.length === 0) return;
  const now = Date.now();
  evictIdle(now);
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { injected: /* @__PURE__ */ new Set(), touchedFiles: [], lastSeenMs: now };
    sessions.set(sessionId, entry);
  }
  for (const id of ids) entry.injected.add(id);
  entry.lastSeenMs = now;
}
function recordTouchedFiles(sessionId, paths) {
  if (!sessionId || paths.length === 0) return;
  const now = Date.now();
  evictIdle(now);
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { injected: /* @__PURE__ */ new Set(), touchedFiles: [], lastSeenMs: now };
    sessions.set(sessionId, entry);
  }
  const existing = new Set(entry.touchedFiles);
  const prepend = [];
  for (const p of paths) {
    if (!existing.has(p)) {
      prepend.push(p);
      existing.add(p);
    }
  }
  const prependSet = new Set(prepend);
  const merged = [...prepend, ...entry.touchedFiles.filter((p) => !prependSet.has(p))];
  entry.touchedFiles = merged.slice(0, ACTIVE_FILES_MAX);
  entry.lastSeenMs = now;
}
function activeFiles(sessionId) {
  if (!sessionId) return [];
  return sessions.get(sessionId)?.touchedFiles ?? [];
}
function sessionCacheStats() {
  let totalInjected = 0;
  let totalTouchedFiles = 0;
  for (const entry of sessions.values()) {
    totalInjected += entry.injected.size;
    totalTouchedFiles += entry.touchedFiles.length;
  }
  return { sessions: sessions.size, totalInjected, totalTouchedFiles };
}
var ACTIVE_FILES_MAX, MAX_SESSIONS, IDLE_TTL_MS, sessions;
var init_session_cache = __esm({
  "src/util/session-cache.ts"() {
    "use strict";
    ACTIVE_FILES_MAX = 20;
    MAX_SESSIONS = 32;
    IDLE_TTL_MS = 6 * 36e5;
    sessions = /* @__PURE__ */ new Map();
  }
});

// src/sources/noise.ts
function isDemoFixtureContent(text) {
  return /acme-conv-/i.test(text) || /acme-project-/i.test(text) || /demo\/data\/notes/i.test(text);
}
function buildIgnorePatterns(rawEnv) {
  const raw = rawEnv ?? process.env.LAZYBRAIN_IGNORE_PATTERNS ?? "";
  if (!raw.trim()) return [];
  const patterns = [];
  for (const part of raw.split(",")) {
    const pattern = part.trim();
    if (!pattern) continue;
    try {
      patterns.push(new RegExp(pattern, "i"));
    } catch {
      process.stderr.write(
        `[lazybrain] LAZYBRAIN_IGNORE_PATTERNS: invalid regex skipped: ${pattern}
`
      );
    }
  }
  return patterns;
}
function getIgnorePatterns() {
  const current = process.env.LAZYBRAIN_IGNORE_PATTERNS;
  if (_cachedIgnorePatterns === null || _cachedIgnorePatternsEnv !== current) {
    _cachedIgnorePatterns = buildIgnorePatterns(current);
    _cachedIgnorePatternsEnv = current;
  }
  return _cachedIgnorePatterns;
}
function matchesIgnorePattern(text) {
  for (const re of getIgnorePatterns()) {
    if (re.test(text)) return true;
  }
  return false;
}
function isConfigurableNoise(text) {
  if (isDemoFixtureContent(text)) return true;
  if (matchesIgnorePattern(text)) return true;
  return false;
}
function isBuildExitDump(text) {
  const matches = text.match(EXIT_CODE_RE);
  if (!matches || matches.length < 3) return false;
  const lines = text.split("\n");
  for (const line of lines) {
    const stripped = line.replace(EXIT_CODE_RE, "");
    if (PROSE_LINE_RE.test(stripped) && PROSE_LONG_WORD_RE.test(stripped)) return false;
  }
  return true;
}
function isNumberedBuildStepDump(text) {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 5) return false;
  let stepLineCount = 0;
  let proseLineCount = 0;
  for (const line of lines) {
    if (BUILD_STEP_LINE_RE.test(line)) {
      stepLineCount++;
      const afterPrefix = line.replace(/^\s*\d+\.\s+[\w-]+/, "").trim();
      if (afterPrefix.length > 0 && PROSE_LINE_RE.test(afterPrefix) && PROSE_LONG_WORD_RE.test(afterPrefix)) {
        proseLineCount++;
      }
    } else if (PROSE_LINE_RE.test(line) && PROSE_LONG_WORD_RE.test(line)) {
      proseLineCount++;
    }
  }
  return stepLineCount >= 5 && proseLineCount === 0;
}
function isBuildOutputNoise(text) {
  return isBuildExitDump(text) || isNumberedBuildStepDump(text);
}
function isShellDiagnosticDump(text) {
  const banners = text.match(DIAGNOSTIC_BANNER_RE);
  if (!banners || banners.length < 1) return false;
  const STRUCTURAL_MIN = 4;
  const BRACE_MIN = 4;
  const PROSE_SHARE_MAX = 0.4;
  const jsonKeys = (text.match(JSON_KEY_RE) ?? []).length;
  const envAssigns = (text.match(ENV_ASSIGN_RE) ?? []).length;
  const braces = (text.match(JSON_BRACE_RE) ?? []).length;
  const structural = jsonKeys + envAssigns;
  if (structural < STRUCTURAL_MIN) return false;
  if (braces < BRACE_MIN) return false;
  let base = text;
  for (const re of INDEX_SCAFFOLDING_RES) base = base.replace(re, " ");
  const totalWords = countAlphanumericWords(base);
  if (totalWords === 0) return false;
  const deDumped = base.replace(DIAGNOSTIC_BANNER_RE, " ").replace(JSON_KEY_RE, " ").replace(ENV_ASSIGN_RE, " ").replace(JSON_BRACE_RE, " ").replace(/[A-Za-z]:[\\/][^\s"']*/g, " ").replace(/(?:[\\/][\w.-]+){2,}/g, " ").replace(/\b[0-9a-f]{6,}\b/gi, " ").replace(/["',:;]/g, " ").replace(/\b\d[\d.]*\b/g, " ");
  const survivingWords = countAlphanumericWords(deDumped);
  return survivingWords / totalWords < PROSE_SHARE_MAX;
}
function countAlphanumericWords(text) {
  const words = text.match(/\b[a-zA-Z0-9][a-zA-Z0-9'_-]*\b/g);
  return words ? words.length : 0;
}
function isMostlyPunctuation(text) {
  const noSpace = text.replace(/\s/g, "");
  if (noSpace.length === 0) return true;
  const alphanumCount = (noSpace.match(/[a-zA-Z0-9]/g) ?? []).length;
  return alphanumCount / noSpace.length < 0.4;
}
function isDominatedByRepetition(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 10);
  if (lines.length < 4) return false;
  const freq = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const key = line.slice(0, 80);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(...freq.values());
  return maxCount / lines.length > 0.6;
}
function hasMeaningfulContent(text) {
  const trimmed = text.trim();
  if (trimmed.length < 30) return false;
  if (countAlphanumericWords(trimmed) < 8) return false;
  if (isMostlyPunctuation(trimmed)) return false;
  if (isDominatedByRepetition(trimmed)) return false;
  return true;
}
function isAgentMetaText(text) {
  const trimmed = text.trim();
  if (/^-{3,}\s*[A-Z][A-Z\s:]+[A-Z]\s*-{3,}/.test(trimmed)) return true;
  if (/^<\/?(observation|thinking|reflection|memory[_-]?update|fact|status|title|summary|entry|note)\s*[\s>/]/i.test(
    trimmed
  ))
    return true;
  if (/^[<>/\s.]*<\/?\s*(fact|status|title|observation|thinking|note|summary|entry)\s*>[.\s]*$/i.test(
    trimmed
  ))
    return true;
  if (/record\s+what\s+was\s+(?:learned|built|fixed|deployed|configured)/i.test(trimmed))
    return true;
  if (/\bhello\s+(memory|brain|agent)\b/i.test(trimmed)) return true;
  if (/\bobserving\s+the\s+primary\b/i.test(trimmed)) return true;
  if (/\bStop hook feedback\b/i.test(trimmed)) return true;
  if (/call the StructuredOutput tool to complete/i.test(trimmed)) return true;
  if (isPlaceholderNoise(trimmed)) return true;
  if (/Source\s+session:[a-z]+-[0-9a-f]{6,}/i.test(trimmed)) return true;
  if (/^(?:\d{4}-\d{2}-\d{2}\s+)?Type\s+(?:episodic|reference|semantic|decision|architecture|feature|feature-set)\s+Status\s+(?:active|deprecated|draft)\b/i.test(
    trimmed
  ))
    return true;
  if (/^\s*Type\s+\w[\w-]*\s+Status\s+\w[\w-]*\s+Tags\b/i.test(trimmed)) return true;
  if (/\bKind\s+\w[\w-]*\s+Files\s+\d+\s+Lines\s+\d+\b/i.test(trimmed)) return true;
  if (/^\s*Type:\s*\S[\w-]*\s*\|\s*Status:\s*\S[\w-]*\b/i.test(trimmed)) return true;
  if (/This\s+is\s+an\s+automated\s+run\s+of\s+a\s+scheduled\s+task/i.test(trimmed)) return true;
  if (/<scheduled-task\s+name=/i.test(trimmed)) return true;
  if (/execute\s+autonomously\s+without\s+asking\s+clarifying\s+questions/i.test(trimmed))
    return true;
  if (/The\s+user\s+is\s+not\s+present\s+to\s+answer\s+questions/i.test(trimmed)) return true;
  if (/<local-command-caveat>/i.test(trimmed)) return true;
  if (/DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to/i.test(
    trimmed
  ))
    return true;
  if (/AUTOMATED\s+TASK\s*[:/]/i.test(trimmed)) return true;
  if (/^["']?\s*:\s*null\.?\s*$/.test(trimmed)) return true;
  if (/You.{0,10}ve\s+hit\s+your\s+.{0,20}limit/i.test(trimmed)) return true;
  if (/resets\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(trimmed)) return true;
  if (/Output\s+(?:a\s+)?JSON\s+array\s+with\s+one\s+object/i.test(trimmed)) return true;
  if (/\{["']?tldr["']?\s*:/i.test(trimmed)) return true;
  if (/Respond\s+with\s+(?:a\s+)?JSON\b/i.test(trimmed)) return true;
  if (/\bNo\s+prose\.\s*$/i.test(trimmed) && trimmed.length < 300) return true;
  if (/compare\s+the\s+gold\s+answer/i.test(trimmed)) return true;
  if (/<observed_from_[a-z_]+\s*>/i.test(trimmed)) return true;
  if (/Base\s+directory\s+for\s+this\s+skill\b/i.test(trimmed)) return true;
  if (/\bSUBAGENT-STOP\b/.test(trimmed)) return true;
  if (/skip\s+this\s+skill\b/i.test(trimmed)) return true;
  if (/If\s+you\s+were\s+dispatched\s+as\s+a\s+subagent\b/i.test(trimmed)) return true;
  if (/you\s+write\s+a\s+short\s+fictional\s+memory\s+note\s+that\s+hypothetically\s+answers/i.test(
    trimmed
  ))
    return true;
  return false;
}
function isPlaceholderNoise(text) {
  if (/a real note on this topic would\s+ment/i.test(text)) return true;
  if (/strings,?\s+decisions that/i.test(text)) return true;
  if (/you write a short fictional\s+(?:memory\s+)?note/i.test(text)) return true;
  if (/output\s+only\s+the\s+note\s+body/i.test(text)) return true;
  if (/hypothetically\s+answers\s+the\s+user.{0,5}s\s+search\s+query/i.test(text)) return true;
  if (/concrete\s+vocabulary:\s+include\s+the\s+named\s+entities/i.test(text)) return true;
  return false;
}
var _cachedIgnorePatterns, _cachedIgnorePatternsEnv, EXIT_CODE_RE, BUILD_STEP_LINE_RE, PROSE_LONG_WORD_RE, PROSE_LINE_RE, DIAGNOSTIC_BANNER_RE, JSON_KEY_RE, ENV_ASSIGN_RE, JSON_BRACE_RE, INDEX_SCAFFOLDING_RES;
var init_noise = __esm({
  "src/sources/noise.ts"() {
    "use strict";
    _cachedIgnorePatterns = null;
    _cachedIgnorePatternsEnv = void 0;
    EXIT_CODE_RE = /\b\w+_exit=\d+\b/g;
    BUILD_STEP_LINE_RE = /^\s*\d+\.\s+[\w-]+/;
    PROSE_LONG_WORD_RE = /\b[a-zA-Z]{7,}\b/;
    PROSE_LINE_RE = /\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b/;
    DIAGNOSTIC_BANNER_RE = /={3,}[^=\n]{1,120}={3,}/g;
    JSON_KEY_RE = /"[^"\n]{1,60}"\s*:/g;
    ENV_ASSIGN_RE = /\b[A-Za-z_][A-Za-z0-9_]*=\S/g;
    JSON_BRACE_RE = /[{}[\]]/g;
    INDEX_SCAFFOLDING_RES = [
      /\[tokens\][^\n]*/gi,
      // synthetic token line: "[tokens] foo bar baz"
      /\[(?:tldr|tool_trace|summary|reasoning|qa|facts|references|see-also)\]/gi,
      /\b(?:Type|Status|Tags|Source|Tool|Confidence|Importance|Categories|Kind|Files|Lines):/gi,
      /Bash run recorded\./gi
    ];
  }
});

// src/annotator/blocks/infobox.ts
function renderInfobox(input) {
  if (input.rows.length === 0) return "";
  const rows = input.rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`);
  return [
    `<aside class="infobox">`,
    "  <dl>",
    ...rows.map((r) => `    ${r}`),
    "  </dl>",
    "</aside>"
  ].join("\n");
}
var init_infobox = __esm({
  "src/annotator/blocks/infobox.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/see-also.ts
function renderSeeAlso(input) {
  if (input.links.length === 0) return "";
  const items = input.links.map((l) => `<li><a href="#/${l.id}" class="section-link">${esc(l.title)}</a></li>`).join("\n    ");
  return `<section data-section="see-also">
  <h2>See also</h2>
  <ul>
    ${items}
  </ul>
</section>`;
}
var init_see_also = __esm({
  "src/annotator/blocks/see-also.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/toc.ts
function renderToc(input) {
  if (input.entries.length === 0) return "";
  let counter = 0;
  const items = input.entries.map((e) => {
    counter++;
    return `<li class="toclevel-${e.level} tocsection-${counter}"><a href="#${e.id}"><span class="tocnumber">${counter}</span> <span class="toctext">${esc(e.text)}</span></a></li>`;
  }).join("\n    ");
  return `<nav class="toc" role="navigation" aria-label="Table of contents">
  <h2>Contents</h2>
  <ol>
    ${items}
  </ol>
</nav>`;
}
var init_toc = __esm({
  "src/annotator/blocks/toc.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/composers/file-neuron.ts
function toAnchorId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function aggregateNoteId(projectName, path) {
  return `aggregate-${projectName}-${path || "root"}`.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").toLowerCase().slice(0, 80);
}
function renderBreadcrumb(projectName, filePath, knownAggregateIds) {
  const segments = [projectName, ...filePath.replace(/\\/g, "/").split("/")];
  const links = segments.slice(0, -1).map((seg, i) => {
    const path = i === 0 ? "" : segments.slice(1, i + 1).join("/");
    const targetId = aggregateNoteId(projectName, path);
    if (knownAggregateIds && !knownAggregateIds.has(targetId)) {
      return esc(seg);
    }
    return `<a href="#${esc(targetId)}">${esc(seg)}</a>`;
  });
  const last = `<span aria-current="page">${esc(segments[segments.length - 1])}</span>`;
  const crumbs = [...links, last].join(" / ");
  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}
function renderTldr(node) {
  const fnCount = node.astFunctions?.length ?? 0;
  const clsCount = node.astClasses?.length ?? 0;
  let text;
  if (fnCount > 0 || clsCount > 0) {
    const parts = [];
    if (fnCount > 0) parts.push(`${fnCount} function${fnCount !== 1 ? "s" : ""}`);
    if (clsCount > 0) parts.push(`${clsCount} class${clsCount !== 1 ? "es" : ""}`);
    text = `${esc(node.language)} file with ${parts.join(", ")} (${node.lineCount} lines)`;
  } else {
    text = `${esc(node.language)} file \u2014 ${node.lineCount} lines, ${node.exports.length} export${node.exports.length !== 1 ? "s" : ""}`;
  }
  return `<section data-section="tldr">
  <p>${text}</p>
</section>`;
}
function renderArchitectureSection(node) {
  const importItems = node.imports.length > 0 ? node.imports.map((imp) => {
    const isInternal = imp.startsWith(".") || imp.startsWith("/");
    const id = isInternal ? `file:${imp}` : imp;
    return isInternal ? `<li><a href="#/${esc(id)}"><code>${esc(imp)}</code></a></li>` : `<li><code>${esc(imp)}</code></li>`;
  }).join("\n      ") : "<li><em>none</em></li>";
  const exportItems = node.exports.length > 0 ? node.exports.map((e) => `<li><code>${esc(e)}</code></li>`).join("\n      ") : "<li><em>none detected</em></li>";
  return [
    '<section data-section="architecture">',
    "  <h3>Imports &amp; Exports</h3>",
    "  <h4>Imports</h4>",
    "  <ul>",
    `      ${importItems}`,
    "  </ul>",
    "  <h4>Exports</h4>",
    "  <ul>",
    `      ${exportItems}`,
    "  </ul>",
    "</section>"
  ].join("\n");
}
function renderJsdocAndExcerpt(jsdoc, excerpt) {
  const parts = [];
  if (jsdoc?.trim()) {
    parts.push(`  <aside data-section="jsdoc"><pre><code>${esc(jsdoc.trim())}</code></pre></aside>`);
  }
  if (excerpt?.trim()) {
    parts.push(`  <pre data-section="excerpt"><code>${esc(excerpt.trim())}</code></pre>`);
  }
  return parts.join("\n");
}
function renderFunctionAnchor(fn) {
  const anchorId = `fn-${toAnchorId(fn.name)}`;
  const params = fn.params.map(esc).join(", ");
  const exportBadge = fn.isExported ? '<span class="export-badge" aria-label="exported">export</span> ' : "";
  const heading = `<h3>${exportBadge}<code>${esc(fn.name)}(${params})</code></h3>`;
  const body = renderJsdocAndExcerpt(fn.jsdoc, fn.excerpt);
  return [
    `<div class="symbol" id="${anchorId}" data-cerveau-symbol="${esc(fn.name)}" data-cerveau-symbol-kind="function">`,
    `  ${heading}`,
    body,
    "</div>"
  ].filter((line) => line.length > 0).join("\n");
}
function renderClassAnchor(cls) {
  const anchorId = `cls-${toAnchorId(cls.name)}`;
  const extendsPart = cls.extends ? ` extends ${esc(cls.extends)}` : "";
  const exportBadge = cls.isExported ? '<span class="export-badge" aria-label="exported">export</span> ' : "";
  const methodList = cls.methods.length > 0 ? `<ul class="method-list">${cls.methods.map((m) => `<li><code>${esc(m)}()</code></li>`).join("")}</ul>` : "";
  const body = renderJsdocAndExcerpt(cls.jsdoc, cls.excerpt);
  return [
    `<div class="symbol" id="${anchorId}" data-cerveau-symbol="${esc(cls.name)}" data-cerveau-symbol-kind="class">`,
    `  <h3>${exportBadge}<code>${esc(cls.name)}${extendsPart}</code></h3>`,
    methodList ? `  ${methodList}` : "",
    body,
    "</div>"
  ].filter(Boolean).join("\n");
}
function renderBindingAnchor(bind) {
  const anchorId = `bind-${toAnchorId(bind.name)}`;
  const exportBadge = bind.isExported ? '<span class="export-badge" aria-label="exported">export</span> ' : "";
  const body = renderJsdocAndExcerpt(bind.jsdoc, bind.excerpt);
  return [
    `<div class="symbol" id="${anchorId}" data-cerveau-symbol="${esc(bind.name)}" data-cerveau-symbol-kind="${esc(bind.kind)}">`,
    `  <h3>${exportBadge}<code>${esc(bind.name)}</code></h3>`,
    body,
    "</div>"
  ].filter(Boolean).join("\n");
}
function renderChildrenSection(node) {
  const fnAnchors = (node.astFunctions ?? []).map(renderFunctionAnchor);
  const clsAnchors = (node.astClasses ?? []).map(renderClassAnchor);
  const bindAnchors = (node.astBindings ?? []).map(renderBindingAnchor);
  const all = [...clsAnchors, ...fnAnchors, ...bindAnchors];
  if (all.length === 0) return "";
  return [
    '<section data-section="children">',
    "  <h3>Symbols</h3>",
    ...all.map((a) => `  ${a}`),
    "</section>"
  ].join("\n");
}
function buildTocEntries(node, enrichment, hasSeeAlso2) {
  const entries = [
    { level: 1, id: "architecture", text: "Imports & Exports" }
  ];
  const hasSymbols = (node.astFunctions?.length ?? 0) > 0 || (node.astClasses?.length ?? 0) > 0;
  if (hasSymbols) {
    entries.push({ level: 1, id: "children", text: "Symbols" });
    for (const cls of node.astClasses ?? []) {
      entries.push({ level: 2, id: `cls-${toAnchorId(cls.name)}`, text: cls.name });
    }
    for (const fn of node.astFunctions ?? []) {
      entries.push({ level: 2, id: `fn-${toAnchorId(fn.name)}`, text: fn.name });
    }
    for (const bind of node.astBindings ?? []) {
      entries.push({ level: 2, id: `bind-${toAnchorId(bind.name)}`, text: bind.name });
    }
  }
  if (enrichment) {
    if ((enrichment.decisions?.length ?? 0) > 0)
      entries.push({ level: 1, id: "decisions", text: "Decisions" });
    if ((enrichment.bugs?.length ?? 0) > 0) entries.push({ level: 1, id: "bugs", text: "Bugs" });
    if ((enrichment.ideas?.length ?? 0) > 0) entries.push({ level: 1, id: "ideas", text: "Ideas" });
    if ((enrichment.rules?.length ?? 0) > 0) entries.push({ level: 1, id: "rules", text: "Rules" });
    if ((enrichment.qa?.length ?? 0) > 0) entries.push({ level: 1, id: "qa", text: "Q & A" });
    if ((enrichment.warnings?.length ?? 0) > 0)
      entries.push({ level: 1, id: "warnings", text: "Warnings" });
    if ((enrichment.activities?.length ?? 0) > 0)
      entries.push({ level: 1, id: "activity", text: "Referenced in Conversations" });
  }
  if (hasSeeAlso2) {
    entries.push({ level: 1, id: "see-also", text: "See also" });
  }
  return entries;
}
function normalizeItemText(text) {
  const withoutComplete = text.replace(/\[([^\]→]+)→#[^\]]*\]/g, "$1");
  const withoutDangling = withoutComplete.replace(/\[(?=[^\]]*$)/g, "").replace(/\s+in\s*$/i, "").trimEnd();
  const withoutOrphan = withoutDangling.replace(/\S*→#[^\]\s]*\]\s*/g, "").trimEnd();
  return withoutOrphan;
}
function renderEnrichmentItem(item) {
  const supersededAttrs = item.superseded ? ` data-cerveau-superseded="true" data-cerveau-valid-until="${esc(item.validUntil ?? "")}"` : "";
  const authorAttrs = [
    item.authorId ? ` data-cerveau-author-id="${esc(item.authorId)}"` : "",
    item.author ? ` data-cerveau-author="${esc(item.author)}"` : "",
    item.kind ? ` data-cerveau-kind="${esc(item.kind)}"` : "",
    item.itemId ? ` data-cerveau-item-id="${esc(item.itemId)}"` : "",
    item.about ? ` data-cerveau-about="${esc(item.about)}"` : "",
    item.project ? ` data-cerveau-project="${esc(item.project)}"` : ""
  ].join("");
  const link = item.sourceConvLink ? ` <a href="${esc(item.sourceConvLink)}" class="conv-source">[source]</a>` : "";
  const cleanText = normalizeItemText(item.text);
  return `<li${supersededAttrs}${authorAttrs} data-cerveau-confidence="${item.confidence}" data-cerveau-date="${esc(item.date)}">${esc(cleanText)}${link}</li>`;
}
function renderEnrichmentSection(sectionId, heading, items) {
  if (!items || items.length === 0) return "";
  const listItems = items.map(renderEnrichmentItem).join("\n    ");
  return [
    `<section data-section="${sectionId}">`,
    `  <h3>${heading}</h3>`,
    "  <ul>",
    `    ${listItems}`,
    "  </ul>",
    "</section>"
  ].join("\n");
}
function buildArticleId(projectName, filePath) {
  const sanitized = `${projectName}-${filePath}`.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").toLowerCase().slice(0, 80);
  return `file-${sanitized}`;
}
function fileNeuronArticleId(node) {
  const projectName = node.projectRoot.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project";
  return buildArticleId(projectName, node.filePath);
}
function computeFileNeuronImportance(inbound, exportCount) {
  const inboundFraction = Math.min(inbound, INBOUND_CAP) / INBOUND_CAP;
  const exportFraction = Math.min(exportCount, EXPORT_CAP) / EXPORT_CAP;
  const raw = IMPORTANCE_BASE + INBOUND_BONUS * inboundFraction + EXPORT_BONUS * exportFraction;
  return Math.min(1, Math.max(0, raw));
}
function composeFileNeuron(node, inbound = 0, enrichment, seeAlso, knownAggregateIds) {
  const now = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const projectName = node.projectRoot.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project";
  const canonicalProject = canonicalProjectSegment(projectName);
  const articleId = fileNeuronArticleId(node);
  const importance = computeFileNeuronImportance(inbound, node.exports.length);
  const infobox = renderInfobox({
    rows: [
      { label: "Language", value: node.language },
      { label: "Lines", value: String(node.lineCount) },
      { label: "Inbound", value: String(inbound) },
      { label: "Exports", value: String(node.exports.length) }
    ]
  });
  const seeAlsoLinks = seeAlso ?? [];
  const seeAlsoSection = renderSeeAlso({
    links: seeAlsoLinks.map((l) => ({ id: l.id, title: l.title }))
  });
  const tocEntries = buildTocEntries(node, enrichment, seeAlsoLinks.length > 0);
  const toc = tocEntries.length > TOC_MIN_ENTRIES_TO_RENDER ? renderToc({ entries: tocEntries }) : "";
  const usedBy = inbound > 0 ? `<section data-section="used-by">
  <h3>Used by</h3>
  <p>Imported by ${inbound} file${inbound !== 1 ? "s" : ""}.</p>
</section>` : "";
  const decisionsSection = renderEnrichmentSection("decisions", "Decisions", enrichment?.decisions);
  const bugsSection = renderEnrichmentSection("bugs", "Bugs", enrichment?.bugs);
  const ideasSection = renderEnrichmentSection("ideas", "Ideas", enrichment?.ideas);
  const rulesSection = renderEnrichmentSection("rules", "Rules", enrichment?.rules);
  const qaSection = renderEnrichmentSection("qa", "Q & A", enrichment?.qa);
  const warningsSection = renderEnrichmentSection("warnings", "Warnings", enrichment?.warnings);
  const activitySection = renderEnrichmentSection(
    "activity",
    "Touched in Conversations",
    enrichment?.activities
  );
  const parts = [
    "<article",
    `  id="${esc(articleId)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-type="file-neuron"`,
    `  data-cerveau-created="${now}T00:00:00Z"`,
    `  data-cerveau-source="code-scanner:${esc(node.projectRoot)}"`,
    `  data-cerveau-tags="code ${esc(node.language)} ${esc(projectName)} file-neuron"`,
    `  data-cerveau-topic="${esc(canonicalProject)}/code/${esc(node.language)}"`,
    `  data-cerveau-project="${esc(canonicalProject)}"`,
    `  data-cerveau-importance="${importance.toFixed(4)}"`,
    `  data-code-file="${esc(node.filePath)}"`,
    `  data-code-project="code-${esc(projectName)}"`,
    `  data-code-language="${esc(node.language)}"`,
    `  data-code-lines="${node.lineCount}"`,
    `  data-code-inbound="${inbound}"`,
    `  data-code-exports="${node.exports.length}"`,
    ">",
    renderBreadcrumb(projectName, node.filePath, knownAggregateIds),
    `<h1>${esc(node.filePath)}</h1>`,
    infobox,
    renderTldr(node),
    toc,
    renderArchitectureSection(node),
    renderChildrenSection(node),
    usedBy,
    // Enrichment sections placed after code/structure, before see-also
    decisionsSection,
    bugsSection,
    ideasSection,
    rulesSection,
    qaSection,
    warningsSection,
    // Activity section is last among enrichment: least important, most honest
    activitySection,
    seeAlsoSection,
    "</article>"
  ];
  return parts.filter((p) => p.trim().length > 0).join("\n");
}
var IMPORTANCE_BASE, INBOUND_BONUS, INBOUND_CAP, EXPORT_BONUS, EXPORT_CAP, TOC_MIN_ENTRIES_TO_RENDER;
var init_file_neuron = __esm({
  "src/annotator/blocks/composers/file-neuron.ts"() {
    "use strict";
    init_cwd_normalizer();
    init_pkg_version();
    init_helpers();
    init_infobox();
    init_see_also();
    init_toc();
    IMPORTANCE_BASE = 0.55;
    INBOUND_BONUS = 0.35;
    INBOUND_CAP = 20;
    EXPORT_BONUS = 0.1;
    EXPORT_CAP = 10;
    TOC_MIN_ENTRIES_TO_RENDER = 4;
  }
});

// src/annotator/blocks/composers/concept-neuron.ts
function buildArticleId2(descriptorId) {
  const slug2 = descriptorId.replace(/^concept:/, "").replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").toLowerCase().slice(0, 74);
  return `concept-${slug2}`;
}
function renderBreadcrumb2(projectName, cleanTitle) {
  const canonical2 = canonicalProjectSegment(projectName);
  const projectHref = `#/${esc(canonical2)}`;
  const conceptsHref = `#/${esc(canonical2)}/concepts`;
  const crumbs = [
    `<a href="${projectHref}">${esc(projectName)}</a>`,
    `<a href="${conceptsHref}">Concepts</a>`,
    `<span aria-current="page">${esc(cleanTitle)}</span>`
  ].join(" / ");
  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}
function renderTldr2(kind, cleanTitle) {
  const text = `${esc(kind)} concept \u2014 ${esc(cleanTitle)}`;
  return `<section data-section="tldr">
  <p>${text}</p>
</section>`;
}
function renderBody(body) {
  return [
    '<section data-section="body">',
    `  <p>${esc(normalizeItemText(body))}</p>`,
    "</section>"
  ].join("\n");
}
function renderRelated(related) {
  if (related.length === 0) return "";
  const items = related.map((r) => `<li><a href="#/${r.id}">${esc(normalizeItemText(r.title))}</a></li>`).join("\n    ");
  return [
    '<section data-section="related">',
    "  <h3>Related neurons</h3>",
    "  <ul>",
    `    ${items}`,
    "  </ul>",
    "</section>"
  ].join("\n");
}
function buildTocEntries2(hasRelated, hasSeeAlso2) {
  const entries = [
    { level: 1, id: "body", text: "Content" }
  ];
  if (hasRelated) {
    entries.push({ level: 1, id: "related", text: "Related neurons" });
  }
  if (hasSeeAlso2) {
    entries.push({ level: 1, id: "see-also", text: "See also" });
  }
  return entries;
}
function composeConceptNeuron(descriptor) {
  const {
    id: descriptorId,
    title: rawTitle,
    projectName,
    kind,
    body,
    confidence,
    date,
    related,
    seeAlso = [],
    supersededDate
  } = descriptor;
  const title = normalizeItemText(rawTitle);
  const articleId = buildArticleId2(descriptorId);
  const createdAttr = date.includes("T") ? date : `${date}T00:00:00Z`;
  const infobox = renderInfobox({
    rows: [
      { label: "Kind", value: kind },
      // Round to 2 decimal places for human-readable display;
      // the raw precision is preserved in data-cerveau-confidence on the root element.
      { label: "Confidence", value: confidence.toFixed(2) },
      { label: "Date", value: date }
    ]
  });
  const hasRelated = related.length > 0;
  const hasSeeAlso2 = seeAlso.length > 0;
  const tocEntries = buildTocEntries2(hasRelated, hasSeeAlso2);
  const toc = renderToc({ entries: tocEntries });
  const seeAlsoSection = hasSeeAlso2 ? renderSeeAlso({
    links: seeAlso.map((l) => ({ id: l.id, title: normalizeItemText(l.title) }))
  }) : "";
  const breadcrumb = projectName !== void 0 ? renderBreadcrumb2(projectName, title) : "";
  const validUntilAttr = supersededDate !== void 0 ? `
  data-cerveau-valid-until="${esc(supersededDate)}"` : "";
  const parts = [
    "<article",
    `  id="${esc(articleId)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-type="concept"`,
    `  data-cerveau-created="${createdAttr}"`,
    `  data-cerveau-updated="${createdAttr}"`,
    `  data-cerveau-source="concept-composer"`,
    `  data-cerveau-confidence="${confidence}"${validUntilAttr}`,
    `  data-cerveau-tags="concept ${esc(kind)}${projectName !== void 0 ? ` ${esc(projectName)}` : ""}"`,
    `  data-cerveau-topic="${projectName !== void 0 ? `${esc(canonicalProjectSegment(projectName))}/concepts` : "concepts"}"`,
    ">",
    breadcrumb,
    `<h1>${esc(title)}</h1>`,
    infobox,
    renderTldr2(kind, title),
    toc,
    renderBody(body),
    renderRelated(related),
    seeAlsoSection,
    "</article>"
  ];
  return parts.filter((p) => p.trim().length > 0).join("\n");
}
var init_concept_neuron = __esm({
  "src/annotator/blocks/composers/concept-neuron.ts"() {
    "use strict";
    init_cwd_normalizer();
    init_pkg_version();
    init_helpers();
    init_infobox();
    init_see_also();
    init_toc();
    init_file_neuron();
  }
});

// src/graph/canonical-merge.ts
function canonicalMerge(evidence, threshold = 0.7) {
  const EMPTY_RESULT = {
    placement: "concept",
    neuronId: null,
    maxShare: 0,
    contributors: []
  };
  if (evidence.length === 0) {
    return EMPTY_RESULT;
  }
  const total = evidence.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) {
    return EMPTY_RESULT;
  }
  const sorted = [...evidence].sort((a, b) => {
    const weightDiff = b.weight - a.weight;
    if (weightDiff !== 0) return weightDiff;
    return a.neuronId < b.neuronId ? -1 : a.neuronId > b.neuronId ? 1 : 0;
  });
  const contributors = sorted.map((e) => e.neuronId);
  const dominant = sorted[0];
  const maxShare = dominant.weight / total;
  if (maxShare >= threshold) {
    return {
      placement: "section",
      neuronId: dominant.neuronId,
      maxShare,
      contributors
    };
  }
  return {
    placement: "concept",
    neuronId: null,
    maxShare,
    contributors
  };
}
var init_canonical_merge = __esm({
  "src/graph/canonical-merge.ts"() {
    "use strict";
  }
});

// src/graph/file-neuron-parse.ts
function parseImportsFromHtml(html) {
  const archMatch = html.match(/<section\s+data-section="architecture">([\s\S]*?)<\/section>/i);
  if (!archMatch) return [];
  const archHtml = archMatch[1];
  const importsMatch = archHtml.match(/<h4>Imports<\/h4>([\s\S]*?)(?:<h4>Exports<\/h4>|$)/i);
  if (!importsMatch) return [];
  const importsHtml = importsMatch[1];
  const imports = [];
  const codeRe = /<code>([^<]+)<\/code>/g;
  for (let m = codeRe.exec(importsHtml); m !== null; m = codeRe.exec(importsHtml)) {
    const val = m[1].trim();
    if (val && val !== "none") imports.push(val);
  }
  return imports;
}
function parseExportsFromHtml(html) {
  const archMatch = html.match(/<section\s+data-section="architecture">([\s\S]*?)<\/section>/i);
  if (!archMatch) return [];
  const archHtml = archMatch[1];
  const exportsMatch = archHtml.match(/<h4>Exports<\/h4>([\s\S]*)$/i);
  if (!exportsMatch) return [];
  const exportsHtml = exportsMatch[1];
  const exports = [];
  const codeRe2 = /<code>([^<]+)<\/code>/g;
  for (let m = codeRe2.exec(exportsHtml); m !== null; m = codeRe2.exec(exportsHtml)) {
    const val = m[1].trim();
    if (val && val !== "none detected") exports.push(val);
  }
  return exports;
}
function parseAstFunctionsFromHtml(html) {
  const childrenMatch = html.match(/<section\s+data-section="children">([\s\S]*?)<\/section>/i);
  if (!childrenMatch) return [];
  const childrenHtml = childrenMatch[1];
  const fns = [];
  const fnRe = /<(?:h3|div)[^>]*\sid="fn-([^"]+)"[^>]*>([\s\S]*?)<\/(?:h3|div)>/gi;
  for (let m = fnRe.exec(childrenHtml); m !== null; m = fnRe.exec(childrenHtml)) {
    const headingContent = m[2];
    const isExported = headingContent.includes('class="export-badge"');
    const codeMatch = headingContent.match(/<code>([^(]+)\(([^)]*)\)<\/code>/);
    if (!codeMatch) continue;
    const name = codeMatch[1].trim();
    const rawParams = codeMatch[2].trim();
    const params = rawParams ? rawParams.split(",").map((p) => p.trim()).filter(Boolean) : [];
    fns.push({ name, startLine: 0, endLine: 0, params, isExported });
  }
  return fns;
}
function parseAstClassesFromHtml(html) {
  const childrenMatch = html.match(/<section\s+data-section="children">([\s\S]*?)<\/section>/i);
  if (!childrenMatch) return [];
  const childrenHtml = childrenMatch[1];
  const classes = [];
  const clsRe = /<div[^>]*\sid="cls-([^"]+)"[^>]*>([\s\S]*?)<\/div>|<h3[^>]*\sid="cls-([^"]+)"[^>]*>([\s\S]*?)<\/h3>(?:\s*<ul\s+class="method-list">([\s\S]*?)<\/ul>)?/gi;
  for (let m = clsRe.exec(childrenHtml); m !== null; m = clsRe.exec(childrenHtml)) {
    const headingContent = m[2] ?? m[4] ?? "";
    const methodsHtml = (headingContent.match(/<ul\s+class="method-list">([\s\S]*?)<\/ul>/i) || [null, m[5] ?? ""])[1];
    const isExported = headingContent.includes('class="export-badge"');
    const codeMatch = headingContent.match(/<h3[\s\S]*?<code>([^<]+)<\/code>|id="cls-[^"]+"[^>]*>[\s\S]*?<code>([^<]+)<\/code>/i) ?? headingContent.match(/<code>([^<]+)<\/code>/);
    if (!codeMatch) continue;
    const codeText = (codeMatch[1] ?? codeMatch[2] ?? "").trim();
    const extendsMatch = codeText.match(/^(\S+)\s+extends\s+(\S+)$/);
    const name = extendsMatch ? extendsMatch[1] : codeText;
    const extendsVal = extendsMatch ? extendsMatch[2] : void 0;
    const methods = [];
    const methodRe = /<code>([A-Za-z_][\w]*)\(\)<\/code>/g;
    for (let mm = methodRe.exec(methodsHtml); mm !== null; mm = methodRe.exec(methodsHtml)) {
      methods.push(mm[1].trim());
    }
    classes.push({ name, methods, isExported, ...extendsVal ? { extends: extendsVal } : {} });
  }
  return classes;
}
function parseSeeAlsoFromHtml(html) {
  const secMatch = html.match(/<section\s+data-section="see-also">([\s\S]*?)<\/section>/i);
  if (!secMatch) return [];
  const links = [];
  const linkRe = /<a\s+href="#\/([^"]+)"\s+class="section-link">([^<]*)<\/a>/gi;
  for (let m = linkRe.exec(secMatch[1]); m !== null; m = linkRe.exec(secMatch[1])) {
    const id = m[1];
    const title = unescapeHtml(m[2]).trim();
    if (id && title) links.push({ id, title });
  }
  return links;
}
function unescapeHtml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function parseEnrichmentSectionFromHtml(html, sectionId) {
  const secRe = new RegExp(`<section\\s+data-section="${sectionId}">([\\s\\S]*?)<\\/section>`, "i");
  const secMatch = html.match(secRe);
  if (!secMatch) return [];
  const items = [];
  const liRe = /<li([^>]*)>([\s\S]*?)<\/li>/gi;
  for (let m = liRe.exec(secMatch[1]); m !== null; m = liRe.exec(secMatch[1])) {
    const attrs = m[1];
    const inner = m[2];
    const confidenceMatch = attrs.match(/data-cerveau-confidence="([^"]*)"/i);
    const dateMatch = attrs.match(/data-cerveau-date="([^"]*)"/i);
    const isSuperseded = /data-cerveau-superseded="true"/i.test(attrs);
    const validUntilMatch = attrs.match(/data-cerveau-valid-until="([^"]*)"/i);
    const linkMatch = inner.match(/<a href="([^"]*)" class="conv-source">\[source\]<\/a>\s*$/i);
    const sourceConvLink = linkMatch ? unescapeHtml(linkMatch[1]) : "";
    const textHtml = linkMatch ? inner.slice(0, linkMatch.index).trim() : inner.trim();
    const text = unescapeHtml(textHtml);
    if (!text) continue;
    items.push({
      text,
      confidence: Number.parseFloat(confidenceMatch?.[1] ?? "") || 0.5,
      date: dateMatch?.[1] ?? "",
      sourceConvLink,
      ...isSuperseded ? { superseded: true } : {},
      ...validUntilMatch?.[1] ? { validUntil: validUntilMatch[1] } : {}
    });
  }
  return items;
}
function parseEnrichmentFromHtml(html) {
  const decisions = parseEnrichmentSectionFromHtml(html, "decisions");
  const bugs = parseEnrichmentSectionFromHtml(html, "bugs");
  const ideas = parseEnrichmentSectionFromHtml(html, "ideas");
  const rules = parseEnrichmentSectionFromHtml(html, "rules");
  const qa = parseEnrichmentSectionFromHtml(html, "qa");
  const warnings = parseEnrichmentSectionFromHtml(html, "warnings");
  const activities = parseEnrichmentSectionFromHtml(html, "activity");
  return {
    ...decisions.length > 0 ? { decisions } : {},
    ...bugs.length > 0 ? { bugs } : {},
    ...ideas.length > 0 ? { ideas } : {},
    ...rules.length > 0 ? { rules } : {},
    ...qa.length > 0 ? { qa } : {},
    ...warnings.length > 0 ? { warnings } : {},
    ...activities.length > 0 ? { activities } : {}
  };
}
function extractFileNeuronStubsFromHtml(notes) {
  const stubs = [];
  for (const note of notes) {
    if (!note.html.includes('data-cerveau-type="file-neuron"')) continue;
    const fileMatch = note.html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
    const langMatch = note.html.match(/data-code-language\s*=\s*["']([^"']+)["']/i);
    const linesMatch = note.html.match(/data-code-lines\s*=\s*["']([^"']+)["']/i);
    const srcMatch = note.html.match(/data-cerveau-source\s*=\s*["']code-scanner:([^"']+)["']/i);
    if (!fileMatch || !srcMatch) continue;
    const filePath = fileMatch[1];
    const projectRoot = srcMatch[1];
    const language = langMatch?.[1] ?? "unknown";
    const lineCount = Number.parseInt(linesMatch?.[1] ?? "0", 10) || 0;
    const imports = parseImportsFromHtml(note.html);
    const exports = parseExportsFromHtml(note.html);
    const astFunctions = parseAstFunctionsFromHtml(note.html);
    const astClasses = parseAstClassesFromHtml(note.html);
    const enrichment = parseEnrichmentFromHtml(note.html);
    stubs.push({
      id: `file:${filePath}`,
      title: filePath,
      type: "file",
      filePath,
      projectRoot,
      language,
      lineCount,
      imports,
      exports,
      ...astFunctions.length > 0 ? { astFunctions } : {},
      ...astClasses.length > 0 ? { astClasses } : {},
      ...enrichment
    });
  }
  return stubs;
}
function parseFileNeuronHtml(html) {
  if (!html.includes('data-cerveau-type="file-neuron"')) return null;
  const fileMatch = html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
  const srcMatch = html.match(/data-cerveau-source\s*=\s*["']code-scanner:([^"']+)["']/i);
  if (!fileMatch || !srcMatch) return null;
  const filePath = fileMatch[1];
  const projectRoot = srcMatch[1];
  const langMatch = html.match(/data-code-language\s*=\s*["']([^"']+)["']/i);
  const linesMatch = html.match(/data-code-lines\s*=\s*["']([^"']+)["']/i);
  const language = langMatch?.[1] ?? "unknown";
  const lineCount = Number.parseInt(linesMatch?.[1] ?? "0", 10) || 0;
  const imports = parseImportsFromHtml(html);
  const exports = parseExportsFromHtml(html);
  const astFunctions = parseAstFunctionsFromHtml(html);
  const astClasses = parseAstClassesFromHtml(html);
  const enrichment = parseEnrichmentFromHtml(html);
  return {
    id: `file:${filePath}`,
    title: filePath,
    type: "file",
    filePath,
    projectRoot,
    language,
    lineCount,
    imports,
    exports,
    ...astFunctions.length > 0 ? { astFunctions } : {},
    ...astClasses.length > 0 ? { astClasses } : {},
    ...enrichment
  };
}
var init_file_neuron_parse = __esm({
  "src/graph/file-neuron-parse.ts"() {
    "use strict";
  }
});

// src/commands/conv-file-enrichment.ts
function textOverlap(a, b) {
  const bigrams = (s) => {
    const tokens = s.toLowerCase().split(/\s+/).filter(Boolean);
    const result = /* @__PURE__ */ new Set();
    for (let i = 0; i < tokens.length - 1; i++) {
      result.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return result;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1;
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  for (const gram of ba) {
    if (bb.has(gram)) intersection++;
  }
  return intersection / (ba.size + bb.size - intersection);
}
function buildEvidenceFromTags(input) {
  const { filesModified, filesRead, itemText, filesBodyMentions } = input;
  const weightMap = /* @__PURE__ */ new Map();
  const add = (neuronId, weight) => {
    const existing = weightMap.get(neuronId) ?? 0;
    if (weight > existing) weightMap.set(neuronId, weight);
  };
  for (const path of filesModified) {
    add(`file:${path}`, WEIGHT_MODIFIED);
  }
  for (const path of filesRead) {
    add(`file:${path}`, WEIGHT_READ);
  }
  for (const path of filesBodyMentions ?? []) {
    add(`file:${path}`, WEIGHT_TEXT_MENTION);
  }
  const FILE_PATH_RE = /(?:^|[\s(["'])([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})(?=$|[\s),"'])/g;
  for (let match = FILE_PATH_RE.exec(itemText); match !== null; match = FILE_PATH_RE.exec(itemText)) {
    const rawPath = match[1].replace(/\\/g, "/").replace(/^\.\//, "");
    if (rawPath?.includes("/")) {
      add(`file:${rawPath}`, WEIGHT_TEXT_MENTION);
    }
  }
  return Array.from(weightMap.entries()).map(([neuronId, weight]) => ({ neuronId, weight }));
}
function applyRecencySuperseding(items) {
  if (items.length <= 1) return items.map((i) => ({ ...i }));
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  const result = sorted.map((i) => ({ ...i }));
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const older = result[i];
      const newer = result[j];
      if (older.superseded) continue;
      const overlap = textOverlap(older.text, newer.text);
      if (overlap > CONTRADICTION_OVERLAP_THRESHOLD) {
        result[i] = { ...older, superseded: true, validUntil: newer.date };
        break;
      }
    }
  }
  return result;
}
function normalizeForDedup(text) {
  return text.trim().toLowerCase();
}
function mergeWithExisting(existing, fresh) {
  if (!existing || existing.length === 0) return fresh;
  const freshTextSet = new Set(fresh.map((i) => normalizeForDedup(i.text)));
  const survivingOld = existing.filter((i) => !freshTextSet.has(normalizeForDedup(i.text)));
  return [...survivingOld, ...fresh];
}
function emptyKindBuckets() {
  return { decisions: [], bugs: [], ideas: [], rules: [], qa: [], warnings: [], activities: [] };
}
function addItemToBucket(buckets, kind, item) {
  switch (kind) {
    case "decision":
      buckets.decisions.push(item);
      break;
    case "bug":
      buckets.bugs.push(item);
      break;
    case "idea":
      buckets.ideas.push(item);
      break;
    case "rule":
      buckets.rules.push(item);
      break;
    case "qa":
      buckets.qa.push(item);
      break;
    case "warning":
      buckets.warnings.push(item);
      break;
    case "activity":
      buckets.activities.push(item);
      break;
  }
}
function buildConceptDescriptor(item, contributors, confidence, date, projectRoot) {
  const projectName = projectRoot.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "project";
  const cleanText = normalizeItemText(item.text);
  const idSlug = slug(`${item.kind}-${cleanText.slice(0, 60)}`);
  const conceptId = `concept:${idSlug}`;
  const related = contributors.map((neuronId) => ({
    id: neuronId,
    title: neuronId.replace(/^file:/, "")
  }));
  const kindMap = {
    decision: "decision",
    bug: "bug",
    idea: "idea",
    rule: "rule",
    qa: "qa",
    warning: "bug",
    activity: "fact"
  };
  return {
    id: conceptId,
    title: cleanText.slice(0, 80),
    projectName,
    kind: kindMap[item.kind],
    body: item.text,
    confidence,
    date,
    related,
    seeAlso: []
  };
}
function parseInboundFromHtml(html) {
  const m = html.match(/data-code-inbound\s*=\s*["'](\d+)["']/i);
  return m ? Number.parseInt(m[1], 10) || 0 : 0;
}
function resolveExistingFileNeuronMeta(node) {
  const empty = { inbound: 0, seeAlso: [] };
  try {
    const indexed = getNoteById(fileNeuronArticleId(node));
    if (!indexed) return empty;
    const file = readNote(indexed.path);
    return {
      inbound: parseInboundFromHtml(file.html),
      seeAlso: parseSeeAlsoFromHtml(file.html)
    };
  } catch {
    return empty;
  }
}
async function runFileNeuronEnrichment(input) {
  const log = getLogger();
  const report = {
    fileNeuronsEnriched: 0,
    conceptNeuronsCreated: 0,
    errors: []
  };
  const nodeById = /* @__PURE__ */ new Map();
  for (const node of input.fileNodes) {
    nodeById.set(node.id, node);
  }
  const fileBuckets = /* @__PURE__ */ new Map();
  const getOrCreateBucket = (neuronId) => {
    if (!fileBuckets.has(neuronId)) fileBuckets.set(neuronId, emptyKindBuckets());
    return fileBuckets.get(neuronId);
  };
  for (const conv of input.convNotes) {
    for (const item of conv.classifiedItems) {
      const evidence = buildEvidenceFromTags({
        filesModified: conv.filesModified,
        filesRead: conv.filesRead,
        itemText: item.text,
        filesBodyMentions: conv.filesBodyMentions
      });
      const filteredEvidence = evidence.filter((e) => nodeById.has(e.neuronId));
      if (filteredEvidence.length === 0) {
        continue;
      }
      const mergeResult = canonicalMerge(filteredEvidence);
      const confidence = mergeResult.maxShare > 0 ? mergeResult.maxShare : 0.5;
      const timestampedItem = {
        text: item.text,
        confidence,
        date: conv.timestamp,
        sourceConvLink: `#${item.sourceId}`
      };
      if (mergeResult.placement === "section" && mergeResult.neuronId !== null) {
        const bucket = getOrCreateBucket(mergeResult.neuronId);
        addItemToBucket(bucket, item.kind, timestampedItem);
      } else {
        if (isAgentMetaText(item.text)) {
          log.debug(
            { text: item.text.slice(0, 60) },
            "conv-enrich: skipping concept neuron \u2014 item text is metadata residue"
          );
          continue;
        }
        const conceptProjectRoot = (() => {
          for (const contributor of mergeResult.contributors) {
            const contributorNode = nodeById.get(contributor);
            if (contributorNode) return contributorNode.projectRoot;
          }
          return input.projectRoot;
        })();
        try {
          const descriptor = buildConceptDescriptor(
            item,
            mergeResult.contributors,
            confidence,
            conv.timestamp,
            conceptProjectRoot
          );
          const html = composeConceptNeuron(descriptor);
          const written = writeNote(html, { overwrite: true });
          try {
            indexNote(readNote(written.path));
          } catch (err) {
            log.warn(
              { path: written.path, err: err.message },
              "conv-enrich: concept reindex"
            );
          }
          report.conceptNeuronsCreated += 1;
        } catch (err) {
          const msg = err.message;
          report.errors.push(`concept for "${item.text.slice(0, 40)}": ${msg}`);
          log.warn({ err: msg }, "conv-enrich: concept write failed");
        }
      }
    }
  }
  for (const [neuronId, buckets] of fileBuckets.entries()) {
    const node = nodeById.get(neuronId);
    if (!node) continue;
    try {
      const enrichment = {
        decisions: applyRecencySuperseding(mergeWithExisting(node.decisions, buckets.decisions)),
        bugs: applyRecencySuperseding(mergeWithExisting(node.bugs, buckets.bugs)),
        ideas: applyRecencySuperseding(mergeWithExisting(node.ideas, buckets.ideas)),
        rules: applyRecencySuperseding(mergeWithExisting(node.rules, buckets.rules)),
        qa: applyRecencySuperseding(mergeWithExisting(node.qa, buckets.qa)),
        warnings: applyRecencySuperseding(mergeWithExisting(node.warnings, buckets.warnings)),
        activities: mergeWithExisting(node.activities, buckets.activities)
      };
      const { inbound, seeAlso } = resolveExistingFileNeuronMeta(node);
      const html = composeFileNeuron(node, inbound, enrichment, seeAlso);
      const written = writeNote(html, { overwrite: true });
      try {
        indexNote(readNote(written.path));
      } catch (err) {
        log.warn(
          { path: written.path, err: err.message },
          "conv-enrich: file-neuron reindex"
        );
      }
      report.fileNeuronsEnriched += 1;
    } catch (err) {
      const msg = err.message;
      report.errors.push(`${neuronId}: ${msg}`);
      log.warn({ neuronId, err: msg }, "conv-enrich: file-neuron write failed");
    }
  }
  log.debug(
    {
      fileNeuronsEnriched: report.fileNeuronsEnriched,
      conceptNeuronsCreated: report.conceptNeuronsCreated,
      errors: report.errors.length
    },
    "conv-enrich: done"
  );
  return report;
}
var WEIGHT_MODIFIED, WEIGHT_TEXT_MENTION, WEIGHT_READ, CONTRADICTION_OVERLAP_THRESHOLD;
var init_conv_file_enrichment = __esm({
  "src/commands/conv-file-enrichment.ts"() {
    "use strict";
    init_concept_neuron();
    init_file_neuron();
    init_canonical_merge();
    init_file_neuron_parse();
    init_fts();
    init_paths();
    init_reader();
    init_writer();
    init_logger();
    init_dream();
    WEIGHT_MODIFIED = 1;
    WEIGHT_TEXT_MENTION = 0.85;
    WEIGHT_READ = 0.4;
    CONTRADICTION_OVERLAP_THRESHOLD = 0.3;
  }
});

// src/commands/enrich.ts
var enrich_exports = {};
__export(enrich_exports, {
  buildBasenameIndex: () => buildBasenameIndex,
  buildBodyMentions: () => buildBodyMentions,
  buildConvNotesFromHtml: () => buildConvNotesFromHtml,
  classifyChunk: () => classifyChunk,
  emptyBucket: () => emptyBucket,
  extractFileNeuronStubs: () => extractFileNeuronStubs,
  isConvEligibleNoteHtml: () => isConvEligibleNoteHtml,
  isNoteMetadataResidue: () => isNoteMetadataResidue,
  resetEnrichStateForTests: () => resetEnrichStateForTests,
  runEnrich: () => runEnrich,
  runIncrementalEnrich: () => runIncrementalEnrich,
  splitIntoSentenceChunks: () => splitIntoSentenceChunks,
  validateTldr: () => validateTldr
});
import { existsSync as existsSync9, readFileSync as readFileSync8, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join10 } from "node:path";
function validateTldr(candidate) {
  if (!candidate) return void 0;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return void 0;
  if (/^\d{4}-\d{2}/.test(trimmed)) return void 0;
  if (FILE_EXTENSIONS.test(trimmed)) return void 0;
  if (TOOL_ECHO_PREFIXES.test(trimmed)) return void 0;
  return trimmed;
}
function isNoteMetadataResidue(text) {
  const trimmed = text.trim();
  if (/Source\s+session:[a-z]+-[0-9a-f]{6,}/i.test(trimmed)) return true;
  if (/^(?:\d{4}-\d{2}-\d{2}\s+)?Type\s+(?:episodic|reference|semantic|decision|architecture|feature|feature-set)\s+Status\s+(?:active|deprecated|draft)\b/i.test(
    trimmed
  ))
    return true;
  if (/^\s*Type\s+\w[\w-]*\s+Status\s+\w[\w-]*\s+Tags\b/i.test(trimmed)) return true;
  if (/^\s*Type:\s*\S[\w-]*\s*\|\s*Status:\s*\S[\w-]*\b/i.test(trimmed)) return true;
  if (/\bKind\s+\w[\w-]*\s+Files\s+\d+\s+Lines\s+\d+\b/i.test(trimmed)) return true;
  return false;
}
function emptyBucket() {
  return { decisions: [], bugs: [], ideas: [], rules: [], facts: [], qa: [], warnings: [] };
}
function classifyChunk(chunk, sourceId, bucket) {
  const trimmed = chunk.trim();
  if (trimmed.length < 20 || trimmed.length > 500) return;
  if (isAgentMetaText(trimmed) || isNoteMetadataResidue(trimmed)) return;
  for (const { kind, pattern } of CLASSIFIERS) {
    if (!pattern.test(trimmed)) continue;
    const text = trimmed.slice(0, 300);
    switch (kind) {
      case "decision":
        bucket.decisions.push({ text, sourceId });
        break;
      case "bug":
        bucket.bugs.push({ text, sourceId });
        break;
      case "idea":
        bucket.ideas.push({ text, sourceId });
        break;
      case "rule":
        bucket.rules.push({ text, sourceId });
        break;
      case "qa":
        bucket.qa.push({ question: text, sourceId });
        break;
      case "warning":
        bucket.warnings.push({ text, sourceId });
        break;
    }
    return;
  }
}
async function runEnrich(opts) {
  const log = getLogger();
  const report = { errors: [] };
  log.info({ topic: opts.topic ?? "all" }, "enrich: starting (file-neuron pipeline)");
  const allNotes = readAllNotes();
  try {
    const fileNeuronResult = await runConvFileNeuronEnrichment(allNotes, opts);
    report.fileNeuronsEnriched = fileNeuronResult.fileNeuronsEnriched;
    report.conceptNeuronsCreated = fileNeuronResult.conceptNeuronsCreated;
    if (fileNeuronResult.errors.length > 0) {
      report.errors.push(...fileNeuronResult.errors.map((e) => `[file-neuron] ${e}`));
    }
    log.debug(
      {
        fileNeuronsEnriched: fileNeuronResult.fileNeuronsEnriched,
        conceptNeuronsCreated: fileNeuronResult.conceptNeuronsCreated
      },
      "enrich: conv\u2192file-neuron enrichment done"
    );
  } catch (err) {
    const msg = err.message;
    log.warn({ err: msg }, "enrich: conv\u2192file-neuron enrichment failed");
    report.errors.push(`[file-neuron] ${msg}`);
  }
  log.info(
    {
      fileNeuronsEnriched: report.fileNeuronsEnriched ?? 0,
      conceptNeuronsCreated: report.conceptNeuronsCreated ?? 0,
      errors: report.errors.length
    },
    "enrich: done"
  );
  return report;
}
function extractFileNeuronStubs(notes) {
  return extractFileNeuronStubsFromHtml(notes);
}
function buildBasenameIndex(relPaths) {
  const index = /* @__PURE__ */ new Map();
  for (const rel of relPaths) {
    const base = rel.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
    if (!base) continue;
    const existing = index.get(base) ?? [];
    existing.push(rel);
    index.set(base, existing);
  }
  return index;
}
function buildBodyMentions(bodyText, relPathSet, basenameIndex) {
  const resolved = /* @__PURE__ */ new Set();
  BODY_PATH_RE.lastIndex = 0;
  for (let match = BODY_PATH_RE.exec(bodyText); match !== null; match = BODY_PATH_RE.exec(bodyText)) {
    const raw = match[1];
    if (!raw) continue;
    const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
    if (!norm.includes("/")) continue;
    const lowerNorm = norm.toLowerCase();
    let found = null;
    for (const rel of relPathSet) {
      if (rel.toLowerCase() === lowerNorm) {
        found = rel;
        break;
      }
    }
    if (found) {
      resolved.add(found);
      continue;
    }
    const suffixMatches = [];
    for (const rel of relPathSet) {
      const lowerRel = rel.toLowerCase();
      if (lowerRel === lowerNorm || lowerRel.endsWith(`/${lowerNorm}`)) {
        suffixMatches.push(rel);
      }
    }
    if (suffixMatches.length === 1) {
      resolved.add(suffixMatches[0]);
      continue;
    }
    const base = lowerNorm.split("/").pop() ?? "";
    if (base) {
      const baseCandidates = basenameIndex.get(base) ?? [];
      if (baseCandidates.length === 1) {
      }
    }
  }
  return Array.from(resolved);
}
function splitIntoSentenceChunks(text) {
  const protectedTokens = [];
  const protect = (input, re) => {
    re.lastIndex = 0;
    return input.replace(re, (match) => {
      const token = `${PATH_PLACEHOLDER_TAG}${protectedTokens.length}${PATH_PLACEHOLDER_TAG}`;
      protectedTokens.push(match);
      return token;
    });
  };
  const protectedText = protect(protect(text, BODY_PATH_RE), IDENTIFIER_DOT_RE);
  if (protectedTokens.length === 0) {
    return protectedText.split(/[.!\n]+/);
  }
  const placeholderRe = new RegExp(`${PATH_PLACEHOLDER_TAG}(\\d+)${PATH_PLACEHOLDER_TAG}`, "g");
  return protectedText.split(/[.!\n]+/).map(
    (chunk) => chunk.replace(placeholderRe, (_full, idx) => protectedTokens[Number(idx)] ?? "")
  );
}
function isConvEligibleNoteHtml(html) {
  if (html.includes('data-cerveau-type="file-neuron"')) return false;
  if (html.includes('data-cerveau-type="concept"')) return false;
  if (html.includes('data-cerveau-source="synthesize-nodes"')) return false;
  if (html.includes('data-cerveau-source="concept-composer"')) return false;
  return true;
}
function buildConvNotesFromHtml(notes, projectRoots, fileNodes) {
  return buildConvNotes(notes, projectRoots, fileNodes);
}
function buildConvNotes(notes, projectRoots, fileNodes) {
  const convNotes = [];
  const normRoot = (root) => root.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const sortedRoots = [...projectRoots].sort((a, b) => b.length - a.length);
  const relativiseAgainstRoots = (normPath4) => {
    const lowerPath = normPath4.toLowerCase();
    for (const root of sortedRoots) {
      const nr = normRoot(root);
      const lowerRoot = nr.toLowerCase();
      if (lowerPath.startsWith(`${lowerRoot}/`) || lowerPath === lowerRoot) {
        return normPath4.slice(nr.length).replace(/^\//, "") || null;
      }
    }
    return null;
  };
  const relPathSet = /* @__PURE__ */ new Set();
  let basenameIndex = /* @__PURE__ */ new Map();
  if (fileNodes && fileNodes.length > 0) {
    const relPaths = fileNodes.map((n) => n.filePath.replace(/\\/g, "/"));
    for (const p of relPaths) relPathSet.add(p);
    basenameIndex = buildBasenameIndex(relPaths);
  }
  for (const note of notes) {
    if (!isConvEligibleNoteHtml(note.html)) continue;
    const modifiedRaw = note.html.match(/data-cerveau-files-modified\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    const readRaw = note.html.match(/data-cerveau-files-read\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    const createdRaw = note.html.match(/data-cerveau-created\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    const timestamp = createdRaw.slice(0, 10) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const cwdRaw = note.html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
    const normCwd = cwdRaw ? normRoot(cwdRaw) : "";
    const resolveStoredPath = (stored) => {
      const normPath4 = stored.replace(/\\/g, "/").replace(/\/+/g, "/");
      const direct = relativiseAgainstRoots(normPath4);
      if (direct !== null) return direct;
      const isAbsolute2 = /^[A-Za-z]:\//.test(normPath4) || normPath4.startsWith("/");
      if (!isAbsolute2 && normCwd) {
        const reconstructed = `${normCwd}/${normPath4}`;
        return relativiseAgainstRoots(reconstructed);
      }
      return null;
    };
    const filesModified = modifiedRaw.split(",").map((p) => p.trim()).filter(Boolean).map(resolveStoredPath).filter((p) => p !== null);
    const filesRead = readRaw.split(",").map((p) => p.trim()).filter(Boolean).map(resolveStoredPath).filter((p) => p !== null);
    const plainText = stripTags(note.html);
    const filesBodyMentions = relPathSet.size > 0 ? buildBodyMentions(plainText, relPathSet, basenameIndex) : [];
    if (filesModified.length === 0 && filesRead.length === 0 && filesBodyMentions.length === 0)
      continue;
    const bucket = emptyBucket();
    const chunks = splitIntoSentenceChunks(plainText).filter(
      (s) => s.trim().length > 20 && s.trim().length < 500
    );
    for (const chunk of chunks.slice(0, 30)) {
      classifyChunk(chunk, note.id, bucket);
    }
    const items = [
      ...bucket.decisions.map((d) => ({
        kind: "decision",
        text: d.text,
        sourceId: d.sourceId
      })),
      ...bucket.bugs.map((b) => ({ kind: "bug", text: b.text, sourceId: b.sourceId })),
      ...bucket.ideas.map((i) => ({
        kind: "idea",
        text: i.text,
        sourceId: i.sourceId
      })),
      ...bucket.rules.map((r) => ({
        kind: "rule",
        text: r.text,
        sourceId: r.sourceId
      })),
      ...bucket.qa.map((q) => ({ kind: "qa", text: q.question, sourceId: q.sourceId })),
      ...bucket.warnings.map((w) => ({
        kind: "warning",
        text: w.text,
        sourceId: w.sourceId
      }))
    ];
    const hasAnyFileEvidence = filesModified.length > 0 || filesBodyMentions.length > 0;
    if (items.length === 0 && hasAnyFileEvidence) {
      const firstChunk = chunks.find((c) => c.trim().length >= 20);
      if (firstChunk && !isAgentMetaText(firstChunk.trim()) && !isNoteMetadataResidue(firstChunk.trim())) {
        items.push({
          kind: "activity",
          text: firstChunk.trim().slice(0, 300),
          sourceId: note.id
        });
      }
    }
    if (items.length === 0) continue;
    convNotes.push({
      id: note.id,
      filesModified,
      filesRead,
      filesBodyMentions,
      timestamp,
      classifiedItems: items
    });
  }
  return convNotes;
}
async function runConvFileNeuronEnrichment(allNotes, _opts) {
  const fileNodes = extractFileNeuronStubs(allNotes);
  if (fileNodes.length === 0) {
    return { fileNeuronsEnriched: 0, conceptNeuronsCreated: 0, errors: [] };
  }
  const projectRoots = [...new Set(fileNodes.map((n) => n.projectRoot))];
  const convNotes = buildConvNotes(allNotes, projectRoots, fileNodes);
  if (convNotes.length === 0) {
    return { fileNeuronsEnriched: 0, conceptNeuronsCreated: 0, errors: [] };
  }
  const projectRoot = projectRoots[0];
  return runFileNeuronEnrichment({ projectRoot, fileNodes, convNotes });
}
function enrichStatePath() {
  return join10(getConfig().cachePath, "enrich-state.json");
}
function loadEnrichState() {
  try {
    const raw = readFileSync8(enrichStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    return { lastRunMs: typeof parsed.lastRunMs === "number" ? parsed.lastRunMs : 0 };
  } catch {
    return { lastRunMs: 0 };
  }
}
function saveEnrichState(state) {
  try {
    writeFileSync7(enrichStatePath(), JSON.stringify(state), "utf8");
  } catch {
  }
}
async function runIncrementalEnrich(opts = {}) {
  const log = getLogger();
  try {
    const state = loadEnrichState();
    const runStartedMs = Date.now();
    if (!opts.force && runStartedMs - state.lastRunMs < MIN_INCREMENTAL_INTERVAL_MS) {
      return NOOP_REPORT("throttled");
    }
    const allNotes = readAllNotes();
    const fileNodes = extractFileNeuronStubs(allNotes);
    if (fileNodes.length === 0) {
      saveEnrichState({ lastRunMs: runStartedMs });
      return NOOP_REPORT("skipped");
    }
    const projectRoots = [...new Set(fileNodes.map((n) => n.projectRoot))];
    const deltaNotes = allNotes.filter((n) => n.mtimeMs > state.lastRunMs);
    const convNotes = buildConvNotes(deltaNotes, projectRoots, fileNodes);
    if (convNotes.length === 0) {
      saveEnrichState({ lastRunMs: runStartedMs });
      return NOOP_REPORT("skipped");
    }
    const projectRoot = projectRoots[0];
    const result = await runFileNeuronEnrichment({ projectRoot, fileNodes, convNotes });
    saveEnrichState({ lastRunMs: runStartedMs });
    if (result.errors.length > 0) {
      log.warn({ errors: result.errors }, "incremental enrich: completed with errors");
    }
    log.debug(
      {
        fileNeuronsEnriched: result.fileNeuronsEnriched,
        conceptNeuronsCreated: result.conceptNeuronsCreated,
        deltaNotes: deltaNotes.length
      },
      "incremental enrich: done"
    );
    return { status: "ok", ...result };
  } catch (err) {
    const msg = err.message;
    log.warn({ err: msg }, "incremental enrich: failed (non-fatal, capture unaffected)");
    return { ...NOOP_REPORT("skipped"), errors: [msg] };
  }
}
function resetEnrichStateForTests() {
  try {
    if (existsSync9(enrichStatePath())) {
      writeFileSync7(enrichStatePath(), JSON.stringify({ lastRunMs: 0 }), "utf8");
    }
  } catch {
  }
}
var FILE_EXTENSIONS, TOOL_ECHO_PREFIXES, CLASSIFIERS, BODY_PATH_RE, PATH_PLACEHOLDER_TAG, IDENTIFIER_SEGMENT, IDENTIFIER_INDEX, IDENTIFIER_DOT_RE, MIN_INCREMENTAL_INTERVAL_MS, NOOP_REPORT;
var init_enrich = __esm({
  "src/commands/enrich.ts"() {
    "use strict";
    init_strip();
    init_reader();
    init_config();
    init_logger();
    init_conv_file_enrichment();
    init_dream();
    init_file_neuron_parse();
    FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|html|htm|css|scss|sass|less|json|yaml|yml|toml|xml|md|txt|sh|bash|zsh|fish|ps1|psm1|env|sql|graphql|proto|dockerfile|lock)$/i;
    TOOL_ECHO_PREFIXES = /^(?:Bash|Read|Write|Edit|Glob|Grep|Task(?:Create|Get|List|Update|Stop)|WebFetch|WebSearch|Monitor|Skill):/i;
    CLASSIFIERS = [
      {
        kind: "decision",
        // French accent-optional stems: real conversations are frequently typed
        // without accents (missing keyboard layout, fast typing, ASCII-only tool
        // output), and "décidé"/"décision" without their accents literally become
        // "decide"/"decision" — the un-accented "decide" family previously matched
        // NOTHING (the old pattern required the literal accented "décidé"), so a
        // note saying "on a decide d'utiliser X" was silently misclassified as a
        // keyword-less 'activity' instead of a 'decision'. `d[ée]cid[ée]e?s?`
        // matches decide/decidé/décide/décidé (+ plural/feminine e/s suffix) and
        // `d[ée]cisions?` matches decision/décision — both accent directions.
        pattern: /(?:decided|d[ée]cisions?|chose|chosen|went\s+with|opted|choisi|d[ée]cid[ée]e?s?|on\s+(?:a|va)\s+(?:pris|fait|choisi|utilis[ée]))/i
      },
      {
        kind: "bug",
        // Bug-indicative action verbs (fix/fixed/broke/broken/crash/throws/regression) and
        // unambiguous runtime-defect class nouns (TypeError, ReferenceError, ENOENT, cassé,
        // plantage). Pure state-nouns like "failed/failure/error" are intentionally excluded:
        // they appear in forward-looking idea phrases ("should handle failed payments") and are
        // caught by the idea classifier instead. The classifyChunk loop is first-match-wins,
        // so a text containing both a bug verb AND an intent marker (e.g. "should fix the bug")
        // is still classified here because bug comes before idea in the classifier list — that
        // is the intended behavior for explicit remediation requests.
        pattern: /(?:bug|crash(?:ed)?|broke|broken|throws\s+(?:a|an)\s+\w|regression|cassé|plantage|TypeError|ReferenceError|ENOENT|fix(?:ed)\b)/i
      },
      {
        kind: "warning",
        pattern: /(?:warning|anti-pattern|gotcha|pitfall|caution|danger)/i
      },
      {
        kind: "idea",
        // Accent-optional for the same reason as the decision classifier above:
        // "idée"/"améliorer" typed without accents ("idee"/"ameliorer") previously
        // matched nothing.
        pattern: /(?:idea|should|could\s+we|todo|improve|enhancement|id[ée]e|am[ée]liorer|pourrait|faudrait|on\s+devrait)/i
      },
      {
        kind: "rule",
        pattern: /(?:always|never|must(?:\s+not)?|rule|convention|obligat|interdit|jamais|toujours|ne\s+(?:pas|jamais))/i
      },
      {
        kind: "qa",
        pattern: /(?:^|\s)(?:why|how|what|when|pourquoi|comment|quoi|qu['']est)[^.]{5,}\?/i
      }
    ];
    BODY_PATH_RE = /(?:^|[\s(["'])([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})(?=$|[\s),"'])/g;
    PATH_PLACEHOLDER_TAG = "LBPATHPLACEHOLDER";
    IDENTIFIER_SEGMENT = "(?:#?[A-Za-z_$][\\w$]*|\\d+)";
    IDENTIFIER_INDEX = "(?:\\[\\d+\\])?";
    IDENTIFIER_DOT_RE = new RegExp(
      `${IDENTIFIER_SEGMENT}${IDENTIFIER_INDEX}(?:\\.${IDENTIFIER_SEGMENT}${IDENTIFIER_INDEX})+(?:\\(\\))?`,
      "g"
    );
    MIN_INCREMENTAL_INTERVAL_MS = 1e4;
    NOOP_REPORT = (status) => ({
      status,
      fileNeuronsEnriched: 0,
      conceptNeuronsCreated: 0,
      errors: []
    });
  }
});

// src/commands/prune.ts
import {
  existsSync as existsSync10,
  readFileSync as readFileSync9,
  readdirSync as readdirSync3,
  rmSync,
  statSync as statSync2,
  unlinkSync
} from "node:fs";
import { join as join11 } from "node:path";
function isObserverNote(html) {
  const sourceMatch = html.match(/data-cerveau-source\s*=\s*["']([^"']+)["']/i);
  if (sourceMatch && OBSERVER_SOURCE_PATTERN.test(sourceMatch[1])) return true;
  for (const pattern of OBSERVER_CONTENT_PATTERNS) {
    if (pattern.test(html)) return true;
  }
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const textContent = articleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    if (isAgentMetaText(textContent)) return true;
    if (isNoteMetadataResidue(textContent)) return true;
  }
  return false;
}
function isPlaceholderNote(html) {
  if (isPlaceholderNoise(html)) return true;
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const stripped = articleMatch[1].replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 2e3);
    if (isPlaceholderNoise(stripped)) return true;
  }
  return false;
}
function isSessionDreamNote(html) {
  const sourceMatch = html.match(/data-cerveau-source\s*=\s*["']([^"']+)["']/i);
  return sourceMatch ? /^session:dream-/i.test(sourceMatch[1]) : false;
}
function hasEmptyTldr(html) {
  const tldrSectionMatch = html.match(/data-section="tldr"[^>]*>([\s\S]*?)<\/section>/i);
  let tldrText = "";
  if (tldrSectionMatch) {
    tldrText = tldrSectionMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  } else {
    const cerveauTldr = html.match(/data-cerveau-tldr\s*=\s*["']([^"']*)["']/i);
    if (cerveauTldr) {
      tldrText = cerveauTldr[1].trim();
    }
  }
  if (!html.includes('data-section="tldr"') && !html.includes("data-cerveau-tldr")) {
    return true;
  }
  if (!tldrText) return true;
  if (/^\d{4}-\d{2}/.test(tldrText)) return true;
  if (FILE_EXTENSION_PATTERN.test(tldrText)) return true;
  return false;
}
function collectHtmlFiles(dir) {
  const results = [];
  if (!existsSync10(dir)) return results;
  let entries;
  try {
    entries = readdirSync3(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const name = entry.name;
    const full = join11(dir, name);
    if (entry.isDirectory()) {
      results.push(...collectHtmlFiles(full));
    } else if (entry.isFile() && name.endsWith(".html")) {
      results.push(full);
    }
  }
  return results;
}
function collectBackupDirs(root) {
  if (!existsSync10(root)) return [];
  let entries;
  try {
    entries = readdirSync3(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && /^notes_backup_/.test(e.name)).map((e) => join11(root, e.name));
}
function matchPolicy(filePath, html, policy) {
  switch (policy) {
    case "claude-mem-observer":
      return isObserverNote(html) ? { policy, path: filePath, reason: "observer-residue content detected" } : null;
    case "placeholder-noise":
      return isPlaceholderNote(html) ? {
        policy,
        path: filePath,
        reason: "placeholder/template prompt-injection residue detected"
      } : null;
    case "session-dream":
      return isSessionDreamNote(html) ? { policy, path: filePath, reason: "data-cerveau-source matches session:dream- prefix" } : null;
    case "empty-tldr":
      return hasEmptyTldr(html) ? {
        policy,
        path: filePath,
        reason: "TLDR section missing, empty, or filename/timestamp echo"
      } : null;
    case "backup-dirs":
      return null;
  }
}
function parsePolicies(raw) {
  if (!raw) return ALL_POLICIES;
  if (Array.isArray(raw)) return raw.length === 0 ? ALL_POLICIES : raw;
  const parts = raw.split(",").map((p) => p.trim());
  return parts.length === 0 ? ALL_POLICIES : parts;
}
function runPrune(opts = {}) {
  const log = getLogger();
  const dryRun = opts.dryRun !== false;
  const policies = parsePolicies(opts.policy);
  const resolvedRoot = opts.brainPath ?? brainRoot();
  const resolvedNotesDir = join11(resolvedRoot, "notes");
  const resolvedKnDir = join11(resolvedRoot, "knowledge-nodes");
  const counts = {
    "claude-mem-observer": 0,
    "placeholder-noise": 0,
    "session-dream": 0,
    "empty-tldr": 0,
    "backup-dirs": 0
  };
  const candidates = [];
  const filePolicies = policies.filter((p) => p !== "backup-dirs");
  if (filePolicies.length > 0) {
    const noteFiles = [...collectHtmlFiles(resolvedNotesDir), ...collectHtmlFiles(resolvedKnDir)];
    for (const filePath of noteFiles) {
      let html;
      try {
        html = readFileSync9(filePath, "utf-8");
      } catch {
        continue;
      }
      for (const policy of filePolicies) {
        const candidate = matchPolicy(filePath, html, policy);
        if (candidate) {
          candidates.push(candidate);
          counts[policy] += 1;
          break;
        }
      }
    }
  }
  if (policies.includes("backup-dirs")) {
    const backupDirs = collectBackupDirs(resolvedRoot);
    for (const dir of backupDirs) {
      candidates.push({
        policy: "backup-dirs",
        path: dir,
        reason: "matches notes_backup_* pattern"
      });
      counts["backup-dirs"] += 1;
    }
  }
  const totalFiles = candidates.filter((c) => c.policy !== "backup-dirs").length;
  const totalDirs = candidates.filter((c) => c.policy === "backup-dirs").length;
  let deleted = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        if (candidate.policy === "backup-dirs") {
          const stat = statSync2(candidate.path);
          if (stat.isDirectory()) {
            rmSync(candidate.path, { recursive: true, force: true });
          }
        } else {
          unlinkSync(candidate.path);
        }
        deleted += 1;
        log.debug({ path: candidate.path, policy: candidate.policy }, "prune: deleted");
      } catch (err) {
        log.warn({ path: candidate.path, err: err.message }, "prune: deletion failed");
      }
    }
  }
  log.info({ dryRun, policies, totalFiles, totalDirs, deleted }, "prune: complete");
  return {
    dryRun,
    policies,
    counts,
    totalFiles,
    totalDirs,
    deleted,
    candidates
  };
}
var OBSERVER_CONTENT_PATTERNS, OBSERVER_SOURCE_PATTERN, FILE_EXTENSION_PATTERN, ALL_POLICIES;
var init_prune = __esm({
  "src/commands/prune.ts"() {
    "use strict";
    init_paths();
    init_logger();
    init_dream();
    init_enrich();
    OBSERVER_CONTENT_PATTERNS = [
      /observed_from_primary_session/i,
      /hello.{0,20}memory.{0,20}agent/i,
      /Record.{0,10}what.{0,10}was.{0,10}LEARNED/i
    ];
    OBSERVER_SOURCE_PATTERN = /\bobserver\b/i;
    FILE_EXTENSION_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|html|htm|css|scss|json|yaml|yml|toml|xml|md|txt|sh|sql|graphql|proto|dockerfile|lock)$/i;
    ALL_POLICIES = [
      "claude-mem-observer",
      "placeholder-noise",
      "session-dream",
      "empty-tldr",
      "backup-dirs"
    ];
  }
});

// src/commands/repair.ts
import { readFileSync as readFileSync10, writeFileSync as writeFileSync8 } from "node:fs";
import { join as join12 } from "node:path";
function extractTags(html) {
  const m = html.match(/data-cerveau-tags\s*=\s*["']([^"']*)["']/i);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}
function extractId(html, fallback) {
  const m = html.match(/<(?:article|section)\b[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : fallback;
}
function wasInvalidatedByNoiseCleanup(html) {
  return INVALIDATED_BY_NOISE_RE.test(html);
}
function repairFileIfEligible(filePath, html, tags, dryRun, log) {
  if (!wasInvalidatedByNoiseCleanup(html)) return null;
  const fileTags = extractTags(html);
  if (!tags.some((t) => fileTags.includes(t))) return null;
  if (!dryRun) {
    const repaired = html.replace(INVALIDATED_BY_NOISE_RE, "").replace(VALID_UNTIL_RE, "");
    writeFileSync8(filePath, repaired, "utf-8");
    try {
      indexNote(readNote(filePath));
    } catch (err) {
      log.warn({ path: filePath, err: err.message }, "repair: reindex failed");
    }
  }
  return { id: extractId(html, filePath), path: filePath, tags: fileTags };
}
function runRepairUnInvalidateNoise(opts = {}) {
  const log = getLogger();
  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : DEFAULT_REPAIR_TAGS;
  const dryRun = opts.dryRun === true;
  const root = opts.brainPath ?? brainRoot();
  const files = [
    ...collectHtmlFiles(join12(root, "notes")),
    ...collectHtmlFiles(join12(root, "knowledge-nodes"))
  ];
  const candidates = [];
  for (const filePath of files) {
    let html;
    try {
      html = readFileSync10(filePath, "utf-8");
    } catch {
      continue;
    }
    const candidate = repairFileIfEligible(filePath, html, tags, dryRun, log);
    if (candidate) candidates.push(candidate);
  }
  log.info(
    { action: "un-invalidate-noise", dryRun, tags, count: candidates.length },
    "repair: complete"
  );
  return {
    action: "un-invalidate-noise",
    dryRun,
    tags,
    candidates,
    repaired: dryRun ? 0 : candidates.length
  };
}
function healNoiseExemptNotes(tags = DEFAULT_REPAIR_TAGS, dryRun = false) {
  const log = getLogger();
  const invalidated = listAll({ includeExpired: true }).filter((n) => !!n.valid_until);
  const candidates = [];
  for (const n of invalidated) {
    let html;
    try {
      html = readFileSync10(n.path, "utf-8");
    } catch {
      continue;
    }
    const candidate = repairFileIfEligible(n.path, html, tags, dryRun, log);
    if (candidate) candidates.push(candidate);
  }
  const healed = dryRun ? 0 : candidates.length;
  if (healed > 0) {
    log.info({ healedNotes: healed, tags }, "repair: maintenance auto-heal complete");
  }
  return { tags, candidates, healed };
}
var DEFAULT_REPAIR_TAGS, INVALIDATED_BY_NOISE_RE, VALID_UNTIL_RE;
var init_repair = __esm({
  "src/commands/repair.ts"() {
    "use strict";
    init_fts();
    init_reader();
    init_paths();
    init_logger();
    init_prune();
    DEFAULT_REPAIR_TAGS = ["mission", "agent", "skill"];
    INVALIDATED_BY_NOISE_RE = /\s*data-cerveau-invalidated-by\s*=\s*["']dream-noise-cleanup["']/i;
    VALID_UNTIL_RE = /\s*data-cerveau-valid-until\s*=\s*["'][^"']*["']/i;
  }
});

// src/util/fingerprints.ts
var fingerprints_exports = {};
__export(fingerprints_exports, {
  computeHash: () => computeHash,
  getChangedFiles: () => getChangedFiles,
  getOrphanedFingerprints: () => getOrphanedFingerprints,
  hasChanged: () => hasChanged,
  loadFingerprints: () => loadFingerprints,
  recordProcessed: () => recordProcessed,
  saveFingerprints: () => saveFingerprints
});
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync11, mkdirSync as mkdirSync6, readFileSync as readFileSync11, statSync as statSync3, writeFileSync as writeFileSync9 } from "node:fs";
import { dirname as dirname7, join as join13 } from "node:path";
function storePath() {
  try {
    const { cachePath: cachePath3 } = getConfig();
    return join13(cachePath3, ".fingerprints.json");
  } catch {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
    return join13(home, ".lazybrain", ".fingerprints.json");
  }
}
function loadFingerprints() {
  const path = storePath();
  if (!existsSync11(path)) {
    return emptyStore();
  }
  try {
    const raw = readFileSync11(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== "1.0.0" || typeof parsed.files !== "object") {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}
function saveFingerprints(store) {
  const path = storePath();
  const dir = dirname7(path);
  mkdirSync6(dir, { recursive: true });
  const updated = { ...store, generatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeFileSync9(path, JSON.stringify(updated, null, 2), "utf-8");
}
function computeHash(filePath) {
  const content = readFileSync11(filePath);
  return createHash3("sha256").update(content).digest("hex");
}
function hasChanged(filePath, store) {
  const stored = store.files[filePath];
  if (!stored) return true;
  let stat;
  try {
    stat = statSync3(filePath);
  } catch {
    return true;
  }
  if (stat.mtimeMs === stored.mtimeMs && stat.size === stored.size) {
    return false;
  }
  try {
    const hash = computeHash(filePath);
    return hash !== stored.contentHash;
  } catch {
    return true;
  }
}
function recordProcessed(filePath, notesCreated, store) {
  let stat;
  let contentHash2;
  try {
    stat = statSync3(filePath);
    contentHash2 = computeHash(filePath);
  } catch {
    return store;
  }
  const fingerprint = {
    filePath,
    contentHash: contentHash2,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    processedAt: (/* @__PURE__ */ new Date()).toISOString(),
    notesCreated
  };
  return {
    ...store,
    files: { ...store.files, [filePath]: fingerprint }
  };
}
function getChangedFiles(filePaths, store) {
  return filePaths.filter((fp) => hasChanged(fp, store));
}
function getOrphanedFingerprints(store) {
  return Object.keys(store.files).filter((fp) => !existsSync11(fp));
}
function emptyStore() {
  return {
    version: "1.0.0",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    files: {}
  };
}
var init_fingerprints = __esm({
  "src/util/fingerprints.ts"() {
    "use strict";
    init_config();
  }
});

// src/annotator/blocks/json-ld.ts
function renderJsonLd(input) {
  const jsonLdData = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `memory://${esc(input.title)}`,
    name: input.title,
    dateCreated: input.dateCreated,
    keywords: input.tags.join(",")
  };
  if (input.description) {
    jsonLdData.description = input.description;
  }
  const jsonLd = `  <script type="application/ld+json">
${JSON.stringify(jsonLdData, null, 2).split("\n").map((line) => `  ${line}`).join("\n")}
  </script>`;
  return jsonLd;
}
var init_json_ld = __esm({
  "src/annotator/blocks/json-ld.ts"() {
    "use strict";
    init_helpers();
  }
});

// src/annotator/blocks/composers/brain-index.ts
function renderTypeBadges(typeBreakdown) {
  if (!typeBreakdown) return "";
  return Object.entries(typeBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `<span class="type-badge ${esc(k)}">${v} ${esc(k)}</span>`).join(" ");
}
function composeBrainIndex(input) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const infobox = renderInfobox({
    rows: [
      { label: "Total notes", value: String(input.stats.totalNotes) },
      { label: "Total topics", value: String(input.stats.totalTopics) }
    ]
  });
  const lead = `<section data-section="lead">
  <p><b>This brain</b> ${esc(input.leadText)}</p>
</section>`;
  const topicSections = input.topics.map((t) => {
    const topicSlug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const desc = t.description ? `<p>${esc(t.description)}</p>` : "";
    const typeBadges = renderTypeBadges(
      t.typeBreakdown
    );
    return `<section class="wiki-section" id="project-${esc(topicSlug)}">
  <h2><a href="#/${esc(topicSlug)}" class="section-link">${esc(t.name)}</a></h2>
  <div class="section-content">
    <div class="project-meta">
      <span class="note-count">${t.noteCount} note${t.noteCount !== 1 ? "s" : ""}</span>
      ${typeBadges}
    </div>
    ${desc}
  </div>
</section>`;
  }).join("\n");
  const projectsSection = `<section id="topics">
  <h2>Topics</h2>
  ${topicSections}
</section>`;
  const categories = renderCategories({ tags: input.tags });
  const jsonLd = renderJsonLd({
    title: input.title,
    type: "brain-index",
    dateCreated: input.created,
    tags: input.tags,
    description: input.leadText
  });
  const parts = [
    `<article id="${esc(input.id)}" data-cerveau-version="${PKG_VERSION}" data-cerveau-created="${esc(input.created)}" data-cerveau-type="brain-index" data-cerveau-source="synthesize" data-cerveau-tier="working" data-cerveau-generated="dream-synthesize" data-cerveau-synthesized-at="${now}" data-cerveau-tags="${esc(input.tags.join(","))}">`,
    jsonLd,
    `<header class="wiki-header">`,
    `  <h1>${esc(input.title)}</h1>`,
    `  ${infobox}`,
    "</header>",
    lead,
    projectsSection,
    input.graphSection ?? "",
    categories,
    "</article>"
  ];
  return parts.filter((p) => p.trim().length > 0).join("\n");
}
var init_brain_index = __esm({
  "src/annotator/blocks/composers/brain-index.ts"() {
    "use strict";
    init_pkg_version();
    init_categories();
    init_helpers();
    init_infobox();
    init_json_ld();
  }
});

// src/annotator/blocks/composers/graph-embed.ts
function toSlug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
function renderClusterTable(clusters) {
  const rows = clusters.map((c) => {
    const slug2 = toSlug(c.label);
    const hubTitles = c.hubs.map((h) => esc(h.title)).join(", ");
    const connected = c.connectedClusters.map(esc).join(", ");
    return [
      "      <tr>",
      `        <td><a href="#/topic-overview-${esc(slug2)}">${esc(c.label)}</a></td>`,
      `        <td>${c.nodeCount}</td>`,
      `        <td>${hubTitles || "\u2014"}</td>`,
      `        <td>${connected || "\u2014"}</td>`,
      "      </tr>"
    ].join("\n");
  }).join("\n");
  return [
    `  <table class="wikitable">`,
    "    <caption>Cluster Map</caption>",
    "    <thead><tr><th>Cluster</th><th>Notes</th><th>Key Nodes</th><th>Connected to</th></tr></thead>",
    "    <tbody>",
    rows,
    "    </tbody>",
    "  </table>"
  ].join("\n");
}
function renderHubList(hubs, tag) {
  const items = hubs.map((h) => {
    const isBrain = tag === "ol";
    const inner = isBrain ? `<a href="#/${esc(h.id)}">${esc(h.title)}</a> (${esc(h.topic)}) \u2014 ${h.inbound}\u2193 ${h.outbound}\u2191` : `<a href="#/${esc(h.id)}">${esc(h.title)}</a> \u2014 ${h.inbound + h.outbound} connections`;
    return `      <li data-node="${esc(h.id)}">${inner}</li>`;
  }).join("\n");
  return [`    <${tag}>`, items, `    </${tag}>`].join("\n");
}
function renderAdjacencyList(edges, hubIds) {
  const truncated = edges.length > EDGE_LIMIT;
  const visible = truncated ? edges.slice(0, EDGE_LIMIT) : edges;
  const lines = visible.map((e) => {
    const prefix = hubIds.has(e.source) ? "[HUB " : "[";
    return `${prefix}${e.source}] --${e.type}--> [${e.target}]`;
  });
  if (truncated) {
    lines.push(`...and ${edges.length - EDGE_LIMIT} more`);
  }
  return lines.join("\n");
}
function renderLayersTable(layers) {
  const rows = layers.filter((l) => l.nodeCount > 0).map(
    (l) => [
      "      <tr>",
      `        <td>${esc(l.name)}</td>`,
      `        <td>${l.nodeCount}</td>`,
      `        <td>${esc(l.description)}</td>`,
      "      </tr>"
    ].join("\n")
  ).join("\n");
  return [
    `  <table class="wikitable">`,
    "    <caption>Knowledge Layers</caption>",
    "    <thead><tr><th>Layer</th><th>Notes</th><th>Description</th></tr></thead>",
    "    <tbody>",
    rows,
    "    </tbody>",
    "  </table>"
  ].join("\n");
}
function renderTour(tour, headingTag) {
  if (tour.length === 0) return "";
  const sorted = [...tour].sort((a, b) => a.order - b.order);
  const items = sorted.map(
    (t) => `      <li><a href="#/${esc(t.noteId)}">${esc(t.title)}</a> \u2014 ${esc(t.description)}</li>`
  ).join("\n");
  return [
    `  <section data-section="graph-tour">`,
    `    <${headingTag}>Guided Tour</${headingTag}>`,
    "    <ol>",
    items,
    "    </ol>",
    "  </section>"
  ].join("\n");
}
function renderBrainGraph(input) {
  const { stats, clusters, hubs, edges, layers, tour } = input;
  const hubIds = new Set(hubs.map((h) => h.id));
  const clusterTable = renderClusterTable(clusters);
  const layersTable = layers && layers.length > 0 ? renderLayersTable(layers) : "";
  const hubList = renderHubList(hubs, "ol");
  const tourSection = tour && tour.length > 0 ? renderTour(tour, "h3") : "";
  const adjacency = renderAdjacencyList(edges, hubIds);
  return [
    `<section data-section="graph" data-graph-scope="brain">`,
    "  <h2>Knowledge Graph</h2>",
    `  <p><data value="${stats.nodes}">${stats.nodes}</data> notes connected by <data value="${stats.edges}">${stats.edges}</data> relationships across <data value="${stats.clusters}">${stats.clusters}</data> clusters.</p>`,
    clusterTable,
    layersTable,
    `  <section data-section="graph-hubs">`,
    "    <h3>Hub Nodes</h3>",
    hubList,
    "  </section>",
    tourSection,
    "  <details>",
    `    <summary>Edge map (${stats.edges} edges)</summary>`,
    `    <pre data-graph-format="adjacency">`,
    adjacency,
    "    </pre>",
    "  </details>",
    "</section>"
  ].filter((p) => p.length > 0).join("\n");
}
function renderProjectGraph(input) {
  const { stats, hubs, edges, crossProjectEdges = [], project, tour } = input;
  const projectAttr = project ? ` data-graph-project="${esc(project)}"` : "";
  const hubIds = new Set(hubs.map((h) => h.id));
  const hubList = renderHubList(hubs, "ul");
  const tourSection = tour && tour.length > 0 ? renderTour(tour, "h4") : "";
  const adjacency = renderAdjacencyList(edges, hubIds);
  const crossSection = crossProjectEdges.length === 0 ? "" : [
    "  <details>",
    `    <summary>Cross-project links (${crossProjectEdges.length})</summary>`,
    `    <pre data-graph-format="adjacency">`,
    crossProjectEdges.map((e) => `[${e.source}] --${e.type}--> [${e.targetProject}:${e.target}]`).join("\n"),
    "    </pre>",
    "  </details>"
  ].join("\n");
  return [
    `<section data-section="graph" data-graph-scope="project"${projectAttr}>`,
    "  <h3>Project Graph</h3>",
    `  <p><data value="${stats.nodes}">${stats.nodes}</data> notes, <data value="${stats.edges}">${stats.edges}</data> edges, <data value="${crossProjectEdges.length}">${crossProjectEdges.length}</data> cross-project links.</p>`,
    `  <section data-section="graph-hubs">`,
    "    <h4>Key Nodes</h4>",
    hubList,
    "  </section>",
    tourSection,
    "  <details>",
    `    <summary>Internal edges (${stats.edges})</summary>`,
    `    <pre data-graph-format="adjacency">`,
    adjacency,
    "    </pre>",
    "  </details>",
    crossSection,
    "</section>"
  ].filter((p) => p.length > 0).join("\n");
}
function composeGraphSection(input) {
  return input.scope === "brain" ? renderBrainGraph(input) : renderProjectGraph(input);
}
var EDGE_LIMIT;
var init_graph_embed = __esm({
  "src/annotator/blocks/composers/graph-embed.ts"() {
    "use strict";
    init_helpers();
    EDGE_LIMIT = 200;
  }
});

// src/annotator/blocks/composers/topic-overview.ts
function extractSectionHeadings(sectionsHtml) {
  const headings = [];
  const sectionRe = /<section[^>]*\s+id="([^"]+)"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  for (let match = sectionRe.exec(sectionsHtml); match !== null; match = sectionRe.exec(sectionsHtml)) {
    const id = match[1];
    const rawTitle = match[2].replace(/<[^>]+>/g, "").trim();
    if (id && rawTitle) {
      headings.push({ id, title: rawTitle });
    }
  }
  return headings;
}
function buildTOC(headings) {
  if (headings.length === 0) return "";
  const items = headings.map(
    (h, i) => `<li><a href="#${esc(h.id)}"><span class="tocnumber">${i + 1}</span> ${esc(h.title)}</a></li>`
  ).join("\n");
  return `<nav class="toc" role="navigation">
  <h2>Contents</h2>
  <ol>${items}</ol>
</nav>`;
}
function buildRichInfobox(stats, subTopics) {
  const typeBadges = Object.entries(stats.typeBreakdown).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="type-badge ${esc(k)}">${v} ${esc(k)}</span>`).join(" ");
  const subTopicsStr = subTopics.length > 0 ? esc(subTopics.join(", ")) : "\u2014";
  return `<aside class="infobox">
  <dl>
    <dt>Notes</dt><dd>${stats.noteCount}</dd>
    <dt>Sub-topics</dt><dd>${subTopicsStr}</dd>
    <dt>Types</dt><dd>${typeBadges}</dd>
  </dl>
</aside>`;
}
function composeTopicOverview(input) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const sectionHeadings = extractSectionHeadings(input.sections);
  const subTopicNames = sectionHeadings.map((h) => h.title);
  const infobox = buildRichInfobox(input.stats, subTopicNames);
  const toc = buildTOC(sectionHeadings);
  const lead = `<section data-section="lead">
  <p><b>${esc(input.title)}</b> ${input.leadText}</p>
</section>`;
  const seeAlso = renderSeeAlso({ links: input.relatedTopics });
  const categories = renderCategories({ tags: input.tags });
  const leadTextPlain = input.leadText.replace(/<[^>]+>/g, "");
  const jsonLd = renderJsonLd({
    title: input.title,
    type: "topic-overview",
    dateCreated: input.created,
    tags: input.tags,
    description: leadTextPlain
  });
  const parts = [
    `<article id="${esc(input.id)}" data-cerveau-version="${PKG_VERSION}" data-cerveau-created="${esc(input.created)}" data-cerveau-type="topic-overview" data-cerveau-source="synthesize" data-cerveau-tier="working" data-cerveau-generated="dream-synthesize" data-cerveau-synthesized-at="${now}" data-cerveau-tags="${esc(input.tags.join(","))}"${input.topic ? ` data-cerveau-topic="${esc(input.topic)}"` : ""}>`,
    jsonLd,
    `<header class="wiki-header">`,
    `  <h1>${esc(input.title)}</h1>`,
    `  ${infobox}`,
    "</header>",
    toc,
    lead,
    input.sections,
    seeAlso,
    categories,
    "</article>"
  ];
  return parts.filter((p) => p.trim().length > 0).join("\n");
}
var init_topic_overview = __esm({
  "src/annotator/blocks/composers/topic-overview.ts"() {
    "use strict";
    init_pkg_version();
    init_categories();
    init_helpers();
    init_json_ld();
    init_see_also();
  }
});

// src/graph/backlinks.ts
import { existsSync as existsSync12, mkdirSync as mkdirSync7, readFileSync as readFileSync12, statSync as statSync4, writeFileSync as writeFileSync10 } from "node:fs";
import { join as join14 } from "node:path";
import { parseHTML as parseHTML5 } from "linkedom";
function buildBacklinks(notes) {
  const all = notes ?? readAllNotes();
  const knownIds = new Set(all.map((n) => n.id).filter(Boolean));
  const outgoing = {};
  const incoming = {};
  let total = 0;
  for (const note of all) {
    if (!note.id) continue;
    const { document } = parseHTML5(`<!doctype html><html><body>${note.html}</body></html>`);
    const root = document.body || document.documentElement;
    if (!root) continue;
    const anchors = Array.from(root.querySelectorAll("a[href]"));
    for (const a of anchors) {
      const href = a.getAttribute("href") ?? "";
      const targetId = parseTargetId(href);
      if (!targetId || targetId === note.id) continue;
      if (!knownIds.has(targetId)) continue;
      const autoFlag = a.getAttribute("data-cerveau-link-auto") === "1";
      const confAttr = a.getAttribute("data-cerveau-link-confidence");
      const confidence = confAttr ?? (autoFlag ? "inferred" : "extracted");
      const confidenceScore = confidence === "extracted" ? 1 : confidence === "inferred" ? 0.5 : 0.2;
      const entry = {
        from: note.id,
        to: targetId,
        type: a.getAttribute("data-cerveau-link-type") ?? "link",
        auto: autoFlag,
        surface: (a.textContent ?? "").trim().slice(0, 120) || void 0,
        confidence,
        confidenceScore
      };
      if (!outgoing[note.id]) outgoing[note.id] = [];
      outgoing[note.id].push(entry);
      if (!incoming[targetId]) incoming[targetId] = [];
      incoming[targetId].push(entry);
      total += 1;
    }
  }
  return {
    outgoing,
    incoming,
    generated: (/* @__PURE__ */ new Date()).toISOString(),
    total_edges: total
  };
}
function saveBacklinks(idx) {
  const cfg = getConfig();
  if (!existsSync12(cfg.cachePath)) mkdirSync7(cfg.cachePath, { recursive: true });
  const path = join14(cfg.cachePath, BACKLINKS_FILENAME);
  writeFileSync10(path, JSON.stringify(idx, null, 2), "utf8");
  try {
    const stats = statSync4(path);
    cachedBacklinks = { path, mtimeMs: stats.mtimeMs, size: stats.size, value: idx };
  } catch {
    cachedBacklinks = null;
  }
  return path;
}
function loadBacklinks() {
  const cfg = getConfig();
  const path = join14(cfg.cachePath, BACKLINKS_FILENAME);
  let stats;
  try {
    stats = statSync4(path);
  } catch {
    return null;
  }
  if (cachedBacklinks && cachedBacklinks.path === path && cachedBacklinks.mtimeMs === stats.mtimeMs && cachedBacklinks.size === stats.size) {
    return cachedBacklinks.value;
  }
  try {
    const value = JSON.parse(readFileSync12(path, "utf8"));
    cachedBacklinks = { path, mtimeMs: stats.mtimeMs, size: stats.size, value };
    return value;
  } catch {
    cachedBacklinks = null;
    return null;
  }
}
function parseTargetId(href) {
  if (!href.startsWith("#")) return null;
  const routedMatch = href.match(/^#\/(?:note|wiki)\/([a-z0-9_%-]+)$/i);
  if (routedMatch) return decodeTargetId(routedMatch[1]);
  if (href.startsWith("#/")) return null;
  const bareId = href.slice(1);
  if (!bareId || /^(fn|cls)-/i.test(bareId)) return null;
  if (!/^[a-z0-9_%-]+$/i.test(bareId)) return null;
  return decodeTargetId(bareId);
}
function decodeTargetId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
var BACKLINKS_FILENAME, cachedBacklinks;
var init_backlinks = __esm({
  "src/graph/backlinks.ts"() {
    "use strict";
    init_reader();
    init_config();
    BACKLINKS_FILENAME = "backlinks.json";
    cachedBacklinks = null;
  }
});

// src/graph/analysis.ts
function buildGraphTopologySummary(backlinks) {
  if (!backlinks || backlinks.total_edges === 0) return "";
  const nodeSet = /* @__PURE__ */ new Set([
    ...Object.keys(backlinks.outgoing),
    ...Object.keys(backlinks.incoming)
  ]);
  const hubRanked = [...Object.entries(backlinks.incoming)].map(([id, edges]) => ({ id, count: edges.length })).sort((a, b) => b.count - a.count).slice(0, 5).filter((h) => h.count >= 2);
  const hubStr = hubRanked.map((h) => `#${h.id}(${h.count})`).join(", ");
  const hubPart = hubStr ? `. Top hubs: ${hubStr}` : "";
  return `[GRAPH] ${nodeSet.size} nodes, ${backlinks.total_edges} edges${hubPart}.`;
}
function findGodNodes(graph, topN = 10) {
  const inbound = /* @__PURE__ */ new Map();
  const outbound = /* @__PURE__ */ new Map();
  for (const edge of graph.edges) {
    outbound.set(edge.source, (outbound.get(edge.source) ?? 0) + 1);
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
  }
  return graph.nodes.filter((n) => n.type !== "brain-index").map((n) => {
    const inn = inbound.get(n.id) ?? 0;
    const out = outbound.get(n.id) ?? 0;
    return {
      id: n.id,
      title: n.title,
      totalDegree: inn + out,
      inbound: inn,
      outbound: out,
      topic: n.topic
    };
  }).sort((a, b) => b.totalDegree - a.totalDegree).slice(0, topN);
}
function findBridgeNodes(graph, topN = 10) {
  const nodeCluster = new Map(graph.nodes.map((n) => [n.id, n.cluster]));
  const bridgeMap = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    bridgeMap.set(node.id, { clusters: /* @__PURE__ */ new Set(), crossEdges: 0 });
  }
  for (const edge of graph.edges) {
    const srcCluster = nodeCluster.get(edge.source);
    const tgtCluster = nodeCluster.get(edge.target);
    if (!srcCluster || !tgtCluster || srcCluster === tgtCluster) continue;
    const srcEntry = bridgeMap.get(edge.source);
    const tgtEntry = bridgeMap.get(edge.target);
    if (srcEntry) {
      srcEntry.clusters.add(tgtCluster);
      srcEntry.crossEdges += 1;
    }
    if (tgtEntry) {
      tgtEntry.clusters.add(srcCluster);
      tgtEntry.crossEdges += 1;
    }
  }
  const totalEdges = graph.edges.length || 1;
  return graph.nodes.map((n) => {
    const entry = bridgeMap.get(n.id) ?? { clusters: /* @__PURE__ */ new Set(), crossEdges: 0 };
    const clusterPairs = entry.clusters.size;
    const betweennessCentrality = entry.crossEdges * clusterPairs / totalEdges;
    return {
      id: n.id,
      title: n.title,
      clustersConnected: Array.from(entry.clusters),
      crossClusterEdges: entry.crossEdges,
      betweennessCentrality
    };
  }).filter((n) => n.clustersConnected.length > 0).sort((a, b) => b.betweennessCentrality - a.betweennessCentrality).slice(0, topN);
}
function findSurprisingConnections(graph, topN = 10) {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const degree = /* @__PURE__ */ new Map();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return graph.edges.map((edge) => {
    const src = nodeMap.get(edge.source);
    const tgt = nodeMap.get(edge.target);
    let score = 0;
    const reasons = [];
    if (src && tgt) {
      if (src.cluster !== tgt.cluster) {
        score += 2;
        reasons.push(`cross-cluster (${src.cluster} \u2194 ${tgt.cluster})`);
      }
      if (src.topic !== tgt.topic) {
        score += 2;
        reasons.push(`cross-topic (${src.topic} \u2194 ${tgt.topic})`);
      }
    }
    if (edge.confidence === "ambiguous") {
      score += 3;
      reasons.push("ambiguous confidence");
    } else if (edge.confidence === "inferred") {
      score += 1;
      reasons.push("inferred confidence");
    }
    const srcDegree = degree.get(edge.source) ?? 0;
    const tgtDegree = degree.get(edge.target) ?? 0;
    if (srcDegree <= 3 && tgtDegree <= 3) {
      score += 1;
      reasons.push("low-degree endpoints");
    }
    return {
      source: edge.source,
      target: edge.target,
      type: edge.type,
      score,
      reason: reasons.join(", ") || "none"
    };
  }).filter((e) => e.score > 0).sort((a, b) => b.score - a.score).slice(0, topN);
}
function assessClusterQuality(graph) {
  const totalEdges = graph.edges.length || 1;
  return graph.clusters.map((cluster) => {
    const n = cluster.nodeCount;
    const possibleInternal = n > 1 ? n * (n - 1) / 2 : 1;
    const cohesion = cluster.internalEdges / possibleInternal;
    const totalEdgesForCluster = cluster.internalEdges + cluster.externalEdges;
    const separation = totalEdgesForCluster > 0 ? 1 - cluster.externalEdges / totalEdgesForCluster : 1;
    const expectedFraction = (n / (graph.nodes.length || 1)) ** 2;
    const actualFraction = cluster.internalEdges / totalEdges;
    const modularity = actualFraction - expectedFraction;
    return {
      clusterId: cluster.id,
      label: cluster.label,
      cohesion,
      separation,
      modularity,
      nodeCount: n
    };
  });
}
function generateQuestions(graph) {
  const questions = [];
  const bridges = findBridgeNodes(graph, 5);
  for (const bridge of bridges) {
    if (bridge.clustersConnected.length >= 2) {
      const [topicA, topicB] = bridge.clustersConnected;
      questions.push({
        question: `How does "${bridge.title}" connect the "${topicA}" and "${topicB}" clusters?`,
        relatedNodeIds: [bridge.id],
        reason: `Bridge node connecting ${bridge.clustersConnected.length} clusters`
      });
    }
  }
  const godNodes = findGodNodes(graph, 5);
  for (const god of godNodes) {
    questions.push({
      question: `What role does "${god.title}" play across the codebase?`,
      relatedNodeIds: [god.id],
      reason: `High-degree node (${god.totalDegree} connections)`
    });
  }
  const degree = /* @__PURE__ */ new Map();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const isolated = graph.nodes.filter((n) => (degree.get(n.id) ?? 0) <= 1 && n.type !== "brain-index").slice(0, 5);
  for (const node of isolated) {
    questions.push({
      question: `Is "${node.title}" properly integrated? It has very few connections.`,
      relatedNodeIds: [node.id],
      reason: "Isolated node with degree \u2264 1"
    });
  }
  const clusterQuality = assessClusterQuality(graph);
  const weakClusters = clusterQuality.filter((c) => c.cohesion < 0.1 && c.nodeCount > 2).sort((a, b) => a.cohesion - b.cohesion).slice(0, 3);
  for (const wc of weakClusters) {
    const clusterObj = graph.clusters.find((c) => c.id === wc.clusterId);
    questions.push({
      question: `Should cluster "${wc.label}" be split or merged? It has low internal cohesion (${wc.cohesion.toFixed(2)}).`,
      relatedNodeIds: clusterObj?.nodeIds.slice(0, 5) ?? [],
      reason: `Weak cluster cohesion (${wc.cohesion.toFixed(2)})`
    });
  }
  return questions;
}
function findOrphanNodes(graph) {
  const connected = /* @__PURE__ */ new Set();
  for (const edge of graph.edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  return graph.nodes.filter((n) => !connected.has(n.id)).map((n) => ({ id: n.id, title: n.title }));
}
function buildEdgeTypeDistribution(graph) {
  const dist = {};
  for (const edge of graph.edges) {
    dist[edge.type] = (dist[edge.type] ?? 0) + 1;
  }
  return dist;
}
function buildConfidenceDistribution(graph) {
  const dist = {};
  for (const edge of graph.edges) {
    dist[edge.confidence] = (dist[edge.confidence] ?? 0) + 1;
  }
  return dist;
}
function analyzeGraph(graph) {
  return {
    godNodes: findGodNodes(graph),
    bridgeNodes: findBridgeNodes(graph),
    surprisingEdges: findSurprisingConnections(graph),
    clusterQuality: assessClusterQuality(graph),
    suggestedQuestions: generateQuestions(graph),
    orphanNodes: findOrphanNodes(graph),
    edgeTypeDistribution: buildEdgeTypeDistribution(graph),
    confidenceDistribution: buildConfidenceDistribution(graph)
  };
}
var init_analysis = __esm({
  "src/graph/analysis.ts"() {
    "use strict";
  }
});

// src/graph/dedup.ts
function trigrams(text) {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const tg = /* @__PURE__ */ new Set();
  for (let i = 0; i < words.length - 2; i++) {
    tg.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return tg;
}
function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}
function findDuplicates(notes, threshold = 0.7) {
  const result = { duplicatePairs: [], mergedCount: 0 };
  const noteGrams = notes.map((n) => ({
    id: n.id,
    grams: trigrams(`${n.title} ${n.tldr ?? ""} ${n.section_tldr ?? ""}`)
  }));
  const cap = Math.min(noteGrams.length, 1e3);
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      const sim = jaccardSimilarity(noteGrams[i].grams, noteGrams[j].grams);
      if (sim >= threshold) {
        result.duplicatePairs.push({
          noteA: noteGrams[i].id,
          noteB: noteGrams[j].id,
          similarity: sim
        });
      }
    }
  }
  result.mergedCount = result.duplicatePairs.length;
  return result;
}
var init_dedup = __esm({
  "src/graph/dedup.ts"() {
    "use strict";
  }
});

// src/graph/layout.ts
function seededPrng(seed) {
  let state = (Math.abs(Math.floor(seed)) || 1) % 2147483647;
  return () => {
    state = state * 16807 % 2147483647;
    return (state - 1) / 2147483646;
  };
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function initPositions(nodes, rand) {
  const clusters = /* @__PURE__ */ new Map();
  nodes.forEach((n, i) => {
    const existing = clusters.get(n.cluster) ?? [];
    clusters.set(n.cluster, [...existing, i]);
  });
  const clusterList = Array.from(clusters.keys());
  const clusterCount = clusterList.length;
  const positions = /* @__PURE__ */ new Map();
  const outerRadius = CANVAS_HALF * 0.55;
  const clusterCentres = /* @__PURE__ */ new Map();
  clusterList.forEach((label, ci) => {
    const angle = 2 * Math.PI * ci / Math.max(clusterCount, 1);
    clusterCentres.set(label, {
      cx: outerRadius * Math.cos(angle),
      cy: outerRadius * Math.sin(angle)
    });
  });
  for (const [label, indices] of clusters) {
    const centre = clusterCentres.get(label) ?? { cx: 0, cy: 0 };
    const r = Math.min(CANVAS_HALF * 0.35, 300 + indices.length * 12);
    indices.forEach((i, li) => {
      const angle = 2 * Math.PI * li / Math.max(indices.length, 1);
      const jitter = (rand() - 0.5) * r * 0.25;
      positions.set(nodes[i].id, {
        x: centre.cx + r * Math.cos(angle) + jitter,
        y: centre.cy + r * Math.sin(angle) + jitter,
        vx: 0,
        vy: 0
      });
    });
  }
  return positions;
}
function applyRepulsionDirect(nodes, state) {
  for (let i = 0; i < nodes.length; i++) {
    const a = state.get(nodes[i].id);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = state.get(nodes[j].id);
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist2 = dx * dx + dy * dy || 1;
      const f = REPULSION_K / dist2;
      const dist = Math.sqrt(dist2);
      const nx = dx / dist;
      const ny = dy / dist;
      a.vx += nx * f;
      a.vy += ny * f;
      b.vx -= nx * f;
      b.vy -= ny * f;
    }
  }
}
function buildGrid(nodes, state, cellSize) {
  const grid = /* @__PURE__ */ new Map();
  nodes.forEach((n, i) => {
    const pos = state.get(n.id);
    const gx = Math.floor(pos.x / cellSize);
    const gy = Math.floor(pos.y / cellSize);
    const key = `${gx},${gy}`;
    const existing = grid.get(key) ?? { indices: [] };
    grid.set(key, { indices: [...existing.indices, i] });
  });
  return { grid, cellSize };
}
function applyRepulsionGrid(nodes, state) {
  const cellSize = Math.sqrt(REPULSION_K) * 0.7;
  const { grid } = buildGrid(nodes, state, cellSize);
  nodes.forEach((n, i) => {
    const a = state.get(n.id);
    const gx = Math.floor(a.x / cellSize);
    const gy = Math.floor(a.y / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx},${gy + dy}`);
        if (!cell) continue;
        for (const j of cell.indices) {
          if (j <= i) continue;
          const b = state.get(nodes[j].id);
          const ddx = a.x - b.x;
          const ddy = a.y - b.y;
          const dist2 = ddx * ddx + ddy * ddy || 1;
          const f = REPULSION_K / dist2;
          const dist = Math.sqrt(dist2);
          a.vx += ddx / dist * f;
          a.vy += ddy / dist * f;
          const bState = state.get(nodes[j].id);
          bState.vx -= ddx / dist * f;
          bState.vy -= ddy / dist * f;
        }
      }
    }
  });
}
function applyAttraction(edges, state) {
  for (const edge of edges) {
    const a = state.get(edge.source);
    const b = state.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const f = dist * ATTRACTION_K;
    const nx = dx / dist;
    const ny = dy / dist;
    a.vx += nx * f;
    a.vy += ny * f;
    b.vx -= nx * f;
    b.vy -= ny * f;
  }
}
function integrate(nodes, state) {
  for (const node of nodes) {
    const s = state.get(node.id);
    s.vx = s.vx * DAMPING + (0 - s.x) * CENTER_GRAVITY;
    s.vy = s.vy * DAMPING + (0 - s.y) * CENTER_GRAVITY;
    s.x = clamp(s.x + s.vx, -CANVAS_HALF, CANVAS_HALF);
    s.y = clamp(s.y + s.vy, -CANVAS_HALF, CANVAS_HALF);
  }
}
function normalise(positions) {
  if (positions.size === 0) return positions;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = 2e3 / Math.max(rangeX, rangeY);
  const result = /* @__PURE__ */ new Map();
  for (const [id, pos] of positions) {
    result.set(id, {
      x: Math.round((pos.x - (minX + maxX) / 2) * scale / 10) * 10,
      y: Math.round((pos.y - (minY + maxY) / 2) * scale / 10) * 10
    });
  }
  return result;
}
function computeLayout(nodes, edges, opts = {}) {
  const t0 = Date.now();
  const seed = opts.seed ?? LAYOUT_SEED;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  if (nodes.length === 0) {
    return { positions: /* @__PURE__ */ new Map(), elapsedMs: 0 };
  }
  const rand = seededPrng(seed);
  const state = initPositions(nodes, rand);
  const useGrid = nodes.length > GRID_BUCKET_THRESHOLD;
  for (let iter = 0; iter < iterations; iter++) {
    if (useGrid) {
      applyRepulsionGrid(nodes, state);
    } else {
      applyRepulsionDirect(nodes, state);
    }
    applyAttraction(edges, state);
    integrate(nodes, state);
  }
  const rawPositions = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const s = state.get(node.id);
    rawPositions.set(node.id, { x: s.x, y: s.y });
  }
  const positions = normalise(rawPositions);
  return { positions, elapsedMs: Date.now() - t0 };
}
var LAYOUT_SEED, DEFAULT_ITERATIONS, REPULSION_K, ATTRACTION_K, DAMPING, CENTER_GRAVITY, CANVAS_HALF, GRID_BUCKET_THRESHOLD;
var init_layout = __esm({
  "src/graph/layout.ts"() {
    "use strict";
    LAYOUT_SEED = 3735928559;
    DEFAULT_ITERATIONS = 130;
    REPULSION_K = 4e4;
    ATTRACTION_K = 0.05;
    DAMPING = 0.85;
    CENTER_GRAVITY = 3e-3;
    CANVAS_HALF = 5e3;
    GRID_BUCKET_THRESHOLD = 1200;
  }
});

// src/graph/structural-edges.ts
function buildHierarchyEdges(notes, nodeMap) {
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  const addEdge = (source, target) => {
    if (source === target) return;
    const key = `${source}::${target}::hierarchy`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      source,
      target,
      type: "hierarchy",
      strength: 0.8,
      confidence: "inferred",
      confidenceScore: 0.8
    });
  };
  const aggregateByPath = /* @__PURE__ */ new Map();
  for (const node of nodeMap.values()) {
    if (node.type === "aggregate-neuron" || node.type === "topic-overview") {
      aggregateByPath.set(node.topicPath, node.id);
    }
  }
  for (const note of notes) {
    const topicPath = note.topic ?? "";
    if (!topicPath || topicPath === "unknown") continue;
    const segments = topicPath.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let childId = note.id;
    for (let depth = segments.length; depth >= 1; depth--) {
      const parentPath = segments.slice(0, depth).join("/");
      const parentId = aggregateByPath.get(parentPath);
      if (parentId && nodeMap.has(parentId) && parentId !== childId) {
        addEdge(childId, parentId);
        childId = parentId;
      }
    }
  }
  return edges;
}
function parseEntities(raw) {
  if (!raw) return [];
  return raw.split(",").map((e) => e.trim().toLowerCase()).filter((e) => e.length >= 3);
}
function buildSharedEntityEdges(notes, nodeIds) {
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  const entityToNotes = /* @__PURE__ */ new Map();
  for (const note of notes) {
    if (!nodeIds.has(note.id)) continue;
    for (const entity of parseEntities(note.entities)) {
      const arr = entityToNotes.get(entity) ?? [];
      arr.push(note.id);
      entityToNotes.set(entity, arr);
    }
  }
  const totalNotes = notes.length;
  const tooGenericThreshold = Math.max(2, Math.floor(totalNotes * TOO_GENERIC_RATIO));
  const pairScore = /* @__PURE__ */ new Map();
  for (const [_entity, noteList] of entityToNotes) {
    if (noteList.length > tooGenericThreshold) continue;
    if (noteList.length < 2) continue;
    const sorted = [...noteList].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const mapA = pairScore.get(a) ?? /* @__PURE__ */ new Map();
        mapA.set(b, (mapA.get(b) ?? 0) + 1);
        pairScore.set(a, mapA);
        const mapB = pairScore.get(b) ?? /* @__PURE__ */ new Map();
        mapB.set(a, (mapB.get(a) ?? 0) + 1);
        pairScore.set(b, mapB);
      }
    }
  }
  for (const [sourceId, targets] of pairScore) {
    const sorted = [...targets.entries()].sort(([idA, cntA], [idB, cntB]) => {
      if (cntB !== cntA) return cntB - cntA;
      return idA < idB ? -1 : idA > idB ? 1 : 0;
    }).slice(0, K_ENTITY_PER_NOTE);
    for (const [targetId] of sorted) {
      const [lo, hi] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
      const key = `${lo}::${hi}::shared-entity`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: lo,
        target: hi,
        type: "shared-entity",
        strength: 0.5,
        confidence: "inferred",
        confidenceScore: 0.5
      });
    }
  }
  return edges;
}
function buildSameFileEdges(notes, nodeIds) {
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  const sourceToNotes = /* @__PURE__ */ new Map();
  for (const note of notes) {
    if (!nodeIds.has(note.id)) continue;
    if (!note.source) continue;
    const src = note.source.replace(/^code-scanner:/i, "").toLowerCase().trim();
    if (!src || src.length < 4) continue;
    const arr = sourceToNotes.get(src) ?? [];
    arr.push(note.id);
    sourceToNotes.set(src, arr);
  }
  for (const noteList of sourceToNotes.values()) {
    if (noteList.length < 2) continue;
    const sorted = [...noteList].sort();
    const countPerNote = /* @__PURE__ */ new Map();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if ((countPerNote.get(a) ?? 0) >= K_ENTITY_PER_NOTE) continue;
        if ((countPerNote.get(b) ?? 0) >= K_ENTITY_PER_NOTE) continue;
        const key = `${a}::${b}::same-file`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: a,
          target: b,
          type: "same-file",
          strength: 0.7,
          confidence: "inferred",
          confidenceScore: 0.7
        });
        countPerNote.set(a, (countPerNote.get(a) ?? 0) + 1);
        countPerNote.set(b, (countPerNote.get(b) ?? 0) + 1);
      }
    }
  }
  return edges;
}
function cwdGroupKey(note) {
  if (note.source && !note.source.startsWith("code-scanner:") && note.source.length > 4) {
    return note.source.toLowerCase().trim();
  }
  if (note.topic) {
    return note.topic.split("/")[0].toLowerCase().trim();
  }
  return null;
}
function buildTemporalEdges(notes, nodeIds) {
  const edges = [];
  const groups = /* @__PURE__ */ new Map();
  for (const note of notes) {
    if (!nodeIds.has(note.id)) continue;
    const key = cwdGroupKey(note);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(note);
    groups.set(key, arr);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const ca = a.created ?? "";
      const cb = b.created ?? "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    let added = 0;
    for (let i = 0; i < sorted.length - 1 && added < TEMPORAL_CHAIN_CAP; i++) {
      const src = sorted[i].id;
      const tgt = sorted[i + 1].id;
      if (src === tgt) continue;
      edges.push({
        source: src,
        target: tgt,
        type: "temporal",
        strength: 0.3,
        confidence: "inferred",
        confidenceScore: 0.3
      });
      added++;
    }
  }
  return edges;
}
function enforceDegreeCap(candidates, existingDegree) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    const keyA = `${a.source}::${a.target}`;
    const keyB = `${b.source}::${b.target}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  const structDegree = /* @__PURE__ */ new Map();
  const kept = [];
  let dropped = 0;
  for (const edge of sorted) {
    const srcExisting = existingDegree.get(edge.source) ?? 0;
    const tgtExisting = existingDegree.get(edge.target) ?? 0;
    const srcStruct = structDegree.get(edge.source) ?? 0;
    const tgtStruct = structDegree.get(edge.target) ?? 0;
    const srcTotal = srcExisting + srcStruct;
    const tgtTotal = tgtExisting + tgtStruct;
    if (srcTotal >= MAX_STRUCTURAL_DEGREE || tgtTotal >= MAX_STRUCTURAL_DEGREE) {
      dropped++;
      continue;
    }
    kept.push(edge);
    structDegree.set(edge.source, srcStruct + 1);
    structDegree.set(edge.target, tgtStruct + 1);
  }
  return { kept, dropped };
}
function buildStructuralEdges(input, existingEdges) {
  const { notes, nodes } = input;
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const existingDegree = /* @__PURE__ */ new Map();
  for (const e of existingEdges) {
    existingDegree.set(e.source, (existingDegree.get(e.source) ?? 0) + 1);
    existingDegree.set(e.target, (existingDegree.get(e.target) ?? 0) + 1);
  }
  const hierarchyEdges = buildHierarchyEdges(notes, nodeMap);
  const sharedEntityEdges = buildSharedEntityEdges(notes, nodeIds);
  const sameFileEdges = buildSameFileEdges(notes, nodeIds);
  const temporalEdges = buildTemporalEdges(notes, nodeIds);
  const allCandidates = [
    ...hierarchyEdges,
    ...sharedEntityEdges,
    ...sameFileEdges,
    ...temporalEdges
  ];
  const dedupSeen = /* @__PURE__ */ new Set();
  const deduped = allCandidates.filter((e) => {
    const key = `${e.source}::${e.target}::${e.type}`;
    if (dedupSeen.has(key)) return false;
    dedupSeen.add(key);
    return true;
  });
  const valid = deduped.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const { kept, dropped } = enforceDegreeCap(valid, existingDegree);
  return {
    edges: kept,
    stats: {
      hierarchy: hierarchyEdges.length,
      sharedEntity: sharedEntityEdges.length,
      sameFile: sameFileEdges.length,
      temporal: temporalEdges.length,
      degreeCapDropped: dropped
    }
  };
}
var K_ENTITY_PER_NOTE, TOO_GENERIC_RATIO, TEMPORAL_CHAIN_CAP, MAX_STRUCTURAL_DEGREE;
var init_structural_edges = __esm({
  "src/graph/structural-edges.ts"() {
    "use strict";
    K_ENTITY_PER_NOTE = 5;
    TOO_GENERIC_RATIO = 0.08;
    TEMPORAL_CHAIN_CAP = 30;
    MAX_STRUCTURAL_DEGREE = 60;
  }
});

// src/graph/knowledge-graph.ts
import { existsSync as existsSync13, mkdirSync as mkdirSync8, readFileSync as readFileSync13, writeFileSync as writeFileSync11 } from "node:fs";
import { join as join15 } from "node:path";
function firstTopicSegment(topic) {
  if (!topic) return "unknown";
  const seg = topic.split("/")[0].trim();
  return seg || "unknown";
}
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function buildNode(note, pagerankScores, clusters) {
  const clusterIndex = clusters.members[note.id];
  const clusterLabel = clusterIndex !== void 0 ? clusters.labels[clusterIndex] ?? `cluster-${clusterIndex}` : "unknown";
  const tldrRaw = note.tldr ?? note.section_tldr ?? note.section_summary ?? note.title;
  return {
    id: note.id,
    title: note.title,
    type: note.type ?? "unknown",
    topic: firstTopicSegment(note.topic),
    topicPath: note.topic ?? "unknown",
    tags: (note.tags ?? "").split(/\s+/).filter(Boolean),
    importance: note.importance ?? 0,
    tldr: stripHtml(tldrRaw).slice(0, 200),
    pagerank: pagerankScores[note.id] ?? 0,
    cluster: clusterLabel,
    validUntil: note.valid_until ?? void 0
  };
}
function buildEdgesFromBacklinks(backlinks, nodeIds) {
  const seen = /* @__PURE__ */ new Set();
  const edges = [];
  for (const entries of Object.values(backlinks.outgoing ?? {})) {
    for (const entry of entries) {
      if (!nodeIds.has(entry.from) || !nodeIds.has(entry.to)) continue;
      const key = `${entry.from}::${entry.to}::${entry.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: entry.from,
        target: entry.to,
        type: entry.type,
        strength: entry.auto ? 0.5 : 1,
        confidence: entry.confidence,
        confidenceScore: entry.confidenceScore
      });
    }
  }
  return edges;
}
function buildClusters(nodes, edges) {
  const clusterMap = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const existing = clusterMap.get(node.cluster) ?? [];
    clusterMap.set(node.cluster, [...existing, node.id]);
  }
  const nodeToCluster = new Map(nodes.map((n) => [n.id, n.cluster]));
  return Array.from(clusterMap.entries()).map(([label, nodeIds]) => {
    const nodeSet = new Set(nodeIds);
    let internalEdges = 0;
    let externalEdges = 0;
    const connectedSet = /* @__PURE__ */ new Set();
    for (const edge of edges) {
      const srcInCluster = nodeSet.has(edge.source);
      const tgtInCluster = nodeSet.has(edge.target);
      if (srcInCluster && tgtInCluster) {
        internalEdges += 1;
      } else if (srcInCluster || tgtInCluster) {
        externalEdges += 1;
        const otherId = srcInCluster ? edge.target : edge.source;
        const otherCluster = nodeToCluster.get(otherId);
        if (otherCluster && otherCluster !== label) {
          connectedSet.add(otherCluster);
        }
      }
    }
    return {
      id: label,
      label,
      nodeIds,
      nodeCount: nodeIds.length,
      internalEdges,
      externalEdges,
      connectedClusters: Array.from(connectedSet)
    };
  });
}
function buildHubs(nodes, edges) {
  const inbound = /* @__PURE__ */ new Map();
  const outbound = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    outbound.set(edge.source, (outbound.get(edge.source) ?? 0) + 1);
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
  }
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return nodes.map((node) => ({
    id: node.id,
    title: node.title,
    topic: node.topic,
    inbound: inbound.get(node.id) ?? 0,
    outbound: outbound.get(node.id) ?? 0,
    pagerank: node.pagerank
  })).sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound)).slice(0, HUB_COUNT).filter(() => nodeMap.size > 0);
}
function buildStats(nodes, edges, clusters, hubs) {
  const totalImportance = nodes.reduce((sum, n) => sum + n.importance, 0);
  const avgImportance = nodes.length > 0 ? totalImportance / nodes.length : 0;
  const topTypes = {};
  for (const node of nodes) {
    topTypes[node.type] = (topTypes[node.type] ?? 0) + 1;
  }
  const topTopics = {};
  for (const node of nodes) {
    topTopics[node.topic] = (topTopics[node.topic] ?? 0) + 1;
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    clusters: clusters.length,
    hubs: hubs.length,
    avgImportance,
    topTypes,
    topTopics
  };
}
function buildLayers(nodes) {
  const layerMap = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const existing = layerMap.get(node.type) ?? [];
    layerMap.set(node.type, [...existing, node.id]);
  }
  return Array.from(layerMap.entries()).map(([type, nodeIds]) => ({
    id: type,
    name: type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: LAYER_DESCRIPTIONS[type] ?? `Notes of type ${type}`,
    nodeIds,
    nodeCount: nodeIds.length
  }));
}
function buildTour(nodes, hubs, clusters) {
  const steps = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const brainIndex = nodes.find((n) => n.type === "brain-index");
  if (brainIndex) {
    steps.push({
      order: steps.length + 1,
      title: brainIndex.title,
      noteId: brainIndex.id,
      description: "Start here for a global overview",
      topic: brainIndex.topic
    });
  }
  const addedTopics = /* @__PURE__ */ new Set();
  for (const cluster of clusters) {
    if (steps.length >= MAX_TOUR_STEPS) break;
    const overview = nodes.find((n) => n.type === "topic-overview" && n.cluster === cluster.id);
    if (overview && !addedTopics.has(overview.topic)) {
      addedTopics.add(overview.topic);
      steps.push({
        order: steps.length + 1,
        title: overview.title,
        noteId: overview.id,
        description: `Overview of ${overview.topic}`,
        topic: overview.topic
      });
    }
  }
  const addedIds = new Set(steps.map((s) => s.noteId));
  for (const hub of hubs.slice(0, MAX_TOUR_HUBS)) {
    if (steps.length >= MAX_TOUR_STEPS) break;
    if (addedIds.has(hub.id)) continue;
    addedIds.add(hub.id);
    const connections = hub.inbound + hub.outbound;
    steps.push({
      order: steps.length + 1,
      title: hub.title,
      noteId: hub.id,
      description: `Key node: ${hub.title} \u2014 connects ${connections} topics`,
      topic: hub.topic
    });
  }
  const decisions = nodes.filter((n) => n.type === "decision").sort((a, b) => b.importance - a.importance).slice(0, MAX_TOUR_DECISIONS);
  for (const decision of decisions) {
    if (steps.length >= MAX_TOUR_STEPS) break;
    if (addedIds.has(decision.id)) continue;
    addedIds.add(decision.id);
    const node = nodeMap.get(decision.id);
    steps.push({
      order: steps.length + 1,
      title: decision.title,
      noteId: decision.id,
      description: `Critical decision: ${decision.title}`,
      topic: node?.topic ?? decision.topic
    });
  }
  return steps;
}
function collectHubIdsForPath(hubs, path, nodes) {
  const nodeIdsUnderPath = new Set(
    nodes.filter((n) => n.topicPath === path || n.topicPath.startsWith(`${path}/`)).map((n) => n.id)
  );
  return hubs.filter((h) => nodeIdsUnderPath.has(h.id)).map((h) => h.id);
}
function insertIntoTree(root, segments, fullPath) {
  if (segments.length === 0) return;
  const [head, ...rest] = segments;
  const currentPath = fullPath.split("/").slice(0, fullPath.split("/").length - rest.length).join("/");
  if (!root.has(head)) {
    root.set(head, { name: head, path: currentPath, noteCount: 0, children: [], hubIds: [] });
  }
  if (rest.length > 0) {
    const childMap = new Map(root.get(head).children.map((c) => [c.name, c]));
    insertIntoTree(childMap, rest, fullPath);
    root.get(head).children = Array.from(childMap.values());
  }
}
function countNotesInTree(node, nodes) {
  const noteCount = nodes.filter(
    (n) => n.topicPath === node.path || n.topicPath.startsWith(`${node.path}/`)
  ).length;
  const children = node.children.map((c) => countNotesInTree(c, nodes));
  return { ...node, noteCount, children };
}
function buildTopicTree(graph) {
  const rootMap = /* @__PURE__ */ new Map();
  for (const node of graph.nodes) {
    const path = node.topicPath === "unknown" ? "unknown" : node.topicPath;
    const segments = path.split("/").filter(Boolean);
    if (segments.length > 0) {
      insertIntoTree(rootMap, segments, path);
    }
  }
  return Array.from(rootMap.values()).map((root) => countNotesInTree(root, graph.nodes)).map((root) => ({
    ...root,
    hubIds: collectHubIdsForPath(graph.hubs, root.path, graph.nodes),
    children: root.children.map((child) => ({
      ...child,
      hubIds: collectHubIdsForPath(graph.hubs, child.path, graph.nodes),
      children: child.children.map((grandchild) => ({
        ...grandchild,
        hubIds: collectHubIdsForPath(graph.hubs, grandchild.path, graph.nodes)
      }))
    }))
  }));
}
function buildKnowledgeGraph(notes, backlinks, clusters, pagerank) {
  const now = /* @__PURE__ */ new Date();
  const activeNotes = notes.filter((n) => {
    if (!n.valid_until) return true;
    const until = new Date(n.valid_until);
    return Number.isNaN(until.getTime()) || until > now;
  });
  const nodes = activeNotes.map((n) => buildNode(n, pagerank.scores, clusters));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const backlinkEdges = buildEdgesFromBacklinks(backlinks, nodeIds);
  const structuralResult = buildStructuralEdges({ notes: activeNotes, nodes }, backlinkEdges);
  const edgeSeen = /* @__PURE__ */ new Set();
  const mergedEdges = [];
  for (const e of [...backlinkEdges, ...structuralResult.edges]) {
    const key = `${e.source}::${e.target}::${e.type}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    mergedEdges.push(e);
  }
  const edges = mergedEdges;
  const degreeMap = /* @__PURE__ */ new Map();
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  }
  const nodesWithDegree = nodes.map((n) => ({
    ...n,
    degree: degreeMap.get(n.id) ?? 0
  }));
  const layoutNodes = nodesWithDegree.map((n) => ({
    id: n.id,
    cluster: n.cluster,
    degree: n.degree ?? 0
  }));
  const layoutEdges = edges.map((e) => ({ source: e.source, target: e.target }));
  const { positions } = computeLayout(layoutNodes, layoutEdges);
  const nodesWithLayout = nodesWithDegree.map((n) => {
    const pos = positions.get(n.id);
    return pos ? { ...n, x: pos.x, y: pos.y } : n;
  });
  const clusterObjects = buildClusters(nodesWithLayout, edges);
  const hubs = buildHubs(nodesWithLayout, edges);
  const stats = buildStats(nodesWithLayout, edges, clusterObjects, hubs);
  const layers = buildLayers(nodesWithLayout);
  const tour = buildTour(nodesWithLayout, hubs, clusterObjects);
  const partialGraph = {
    version: "1.0.0",
    generated: now.toISOString(),
    stats,
    nodes: nodesWithLayout,
    edges,
    clusters: clusterObjects,
    hubs,
    layers,
    tour,
    topicTree: []
  };
  const withTopicTree = { ...partialGraph, topicTree: buildTopicTree(partialGraph) };
  const withAnalysis = { ...withTopicTree, analysis: analyzeGraph(withTopicTree) };
  const duplicates = findDuplicates(activeNotes);
  return { ...withAnalysis, duplicates };
}
function rebuildStatsForSubset(nodes, edges, clusters, hubs) {
  return buildStats(nodes, edges, clusters, hubs);
}
function extractSubGraph(graph, topic, opts) {
  const matchPrefix = opts?.matchPrefix ?? false;
  const coreNodes = matchPrefix ? graph.nodes.filter((n) => n.topicPath === topic || n.topicPath.startsWith(`${topic}/`)) : graph.nodes.filter((n) => n.topic === topic);
  const coreIds = new Set(coreNodes.map((n) => n.id));
  const crossEdges = [];
  const internalEdges = [];
  const externalIds = /* @__PURE__ */ new Set();
  for (const edge of graph.edges) {
    const srcIn = coreIds.has(edge.source);
    const tgtIn = coreIds.has(edge.target);
    if (srcIn && tgtIn) {
      internalEdges.push(edge);
    } else if (srcIn || tgtIn) {
      crossEdges.push({ ...edge, type: `cross-project:${edge.type}` });
      externalIds.add(srcIn ? edge.target : edge.source);
    }
  }
  const externalNodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const externalNodes = Array.from(externalIds).map((id) => externalNodeMap.get(id)).filter((n) => n !== void 0).map((n) => ({
    id: n.id,
    title: n.title,
    topic: n.topic,
    topicPath: n.topicPath,
    type: "external",
    tags: [],
    importance: 0,
    tldr: "",
    pagerank: n.pagerank,
    cluster: n.cluster
  }));
  const allNodes = [...coreNodes, ...externalNodes];
  const allEdges = [...internalEdges, ...crossEdges];
  const allIds = new Set(allNodes.map((n) => n.id));
  const safeEdges = allEdges.filter((e) => allIds.has(e.source) && allIds.has(e.target));
  const subClusters = buildClusters(allNodes, safeEdges);
  const subHubs = buildHubs(allNodes, safeEdges);
  const stats = rebuildStatsForSubset(allNodes, safeEdges, subClusters, subHubs);
  const layers = buildLayers(allNodes);
  const tour = buildTour(allNodes, subHubs, subClusters);
  const subGraph = {
    version: graph.version,
    generated: (/* @__PURE__ */ new Date()).toISOString(),
    stats,
    nodes: allNodes,
    edges: safeEdges,
    clusters: subClusters,
    hubs: subHubs,
    layers,
    tour,
    topicTree: []
  };
  return { ...subGraph, topicTree: buildTopicTree(subGraph) };
}
function saveKnowledgeGraph(graph) {
  const cfg = getConfig();
  if (!existsSync13(cfg.cachePath)) mkdirSync8(cfg.cachePath, { recursive: true });
  const path = join15(cfg.cachePath, GRAPH_FILENAME);
  writeFileSync11(path, JSON.stringify(graph, null, 2), "utf8");
  return path;
}
function loadKnowledgeGraph() {
  const cfg = getConfig();
  const path = join15(cfg.cachePath, GRAPH_FILENAME);
  if (!existsSync13(path)) return null;
  try {
    const data = JSON.parse(readFileSync13(path, "utf8"));
    if (!data.version || !data.nodes || !data.edges) return null;
    return data;
  } catch {
    return null;
  }
}
function buildKnowledgeGraphFromIndex(backlinks, clusters, pagerank) {
  const notes = listAll({ includeExpired: false });
  return buildKnowledgeGraph(notes, backlinks, clusters, pagerank);
}
var GRAPH_FILENAME, HUB_COUNT, LAYER_DESCRIPTIONS, MAX_TOUR_STEPS, MAX_TOUR_HUBS, MAX_TOUR_DECISIONS;
var init_knowledge_graph = __esm({
  "src/graph/knowledge-graph.ts"() {
    "use strict";
    init_fts();
    init_config();
    init_analysis();
    init_dedup();
    init_layout();
    init_structural_edges();
    GRAPH_FILENAME = "brain-graph.json";
    HUB_COUNT = 20;
    LAYER_DESCRIPTIONS = {
      decision: "Technical and strategic decisions with reasoning and outcomes",
      episodic: "Bug reports, incidents, and debugging sessions",
      semantic: "Conceptual knowledge, definitions, and explanations",
      procedural: "Step-by-step processes, workflows, and how-tos",
      reference: "Configuration, documentation, and reference material",
      "topic-overview": "Synthesized wiki pages covering entire topics",
      "brain-index": "Global brain navigation index",
      "project-summary": "Project-level summaries and metadata"
    };
    MAX_TOUR_STEPS = 15;
    MAX_TOUR_HUBS = 5;
    MAX_TOUR_DECISIONS = 3;
  }
});

// src/commands/synthesize.ts
import { parseHTML as parseHTML6 } from "linkedom";
function groupNotesByFullTopic(notes) {
  const groups = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const { document } = parseHTML6(note.html);
    const article = document.querySelector("article");
    if (!article) continue;
    const type = article.getAttribute("data-cerveau-type") ?? "";
    if (SYNTHESIS_TYPES.has(type)) continue;
    const topicAttr = article.getAttribute("data-cerveau-topic") ?? "";
    if (!topicAttr.trim()) continue;
    const segments = topicAttr.split("/").filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join("/");
      const existing = groups.get(path) ?? [];
      existing.push(note);
      groups.set(path, existing);
    }
  }
  return groups;
}
function buildBreadcrumb(topicPath) {
  const segments = topicPath.split("/").filter(Boolean);
  const parts = ['<a href="#/brain-index">Brain</a>'];
  for (let i = 0; i < segments.length; i++) {
    const path = segments.slice(0, i + 1).join("/");
    const name = segments[i].charAt(0).toUpperCase() + segments[i].slice(1);
    if (i === segments.length - 1) {
      parts.push(`<span>${name}</span>`);
    } else {
      parts.push(`<a href="#/topic-overview-${path.replace(/\//g, "-")}">${name}</a>`);
    }
  }
  return `<nav class="breadcrumb">${parts.join(" \u203A ")}</nav>`;
}
function buildChildTopicsSection(topicPath, fullGroups) {
  const prefix = `${topicPath}/`;
  const children = [];
  for (const [path, notes] of fullGroups) {
    if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
      children.push({
        name: path.slice(prefix.length),
        path,
        count: notes.length
      });
    }
  }
  if (children.length === 0) return "";
  const rows = children.sort((a, b) => b.count - a.count).map((c) => {
    const slug2 = c.path.replace(/\//g, "-");
    const title = c.name.charAt(0).toUpperCase() + c.name.slice(1);
    return `<li><a href="#/topic-overview-${slug2}">${title}</a> (${c.count} notes)</li>`;
  }).join("\n");
  return `<section data-section="sub-topics">
  <h2>Sub-topics</h2>
  <ul class="sub-topic-list">${rows}</ul>
</section>`;
}
function groupNotesByTopic(notes) {
  const groups = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const { document } = parseHTML6(note.html);
    const article = document.querySelector("article");
    if (!article) continue;
    const type = article.getAttribute("data-cerveau-type") ?? "";
    if (SYNTHESIS_TYPES.has(type)) continue;
    const topicAttr = article.getAttribute("data-cerveau-topic") ?? "";
    const topicTag = topicAttr.split("/")[0]?.trim();
    if (!topicTag) continue;
    const existing = groups.get(topicTag) ?? [];
    existing.push(note);
    groups.set(topicTag, existing);
  }
  return groups;
}
function aggregateTopicStats(notes) {
  const typeBreakdown = {};
  let totalImportance = 0;
  let earliest = "";
  let latest = "";
  for (const note of notes) {
    const { document } = parseHTML6(note.html);
    const article = document.querySelector("article");
    if (!article) continue;
    const type = article.getAttribute("data-cerveau-type") ?? "unknown";
    typeBreakdown[type] = (typeBreakdown[type] ?? 0) + 1;
    const importanceRaw = article.getAttribute("data-cerveau-importance") ?? "0.5";
    totalImportance += Number.parseFloat(importanceRaw);
    const created = article.getAttribute("data-cerveau-created") ?? "";
    if (created) {
      if (!earliest || created < earliest) earliest = created;
      if (!latest || created > latest) latest = created;
    }
  }
  return {
    noteCount: notes.length,
    typeBreakdown,
    dateRange: [earliest, latest],
    avgImportance: notes.length > 0 ? totalImportance / notes.length : 0
  };
}
function isStale(synthHtml, latestNoteMtimeMs) {
  if (!synthHtml) return true;
  const { document } = parseHTML6(synthHtml);
  const article = document.querySelector("article");
  const synthAt = article?.getAttribute("data-cerveau-synthesized-at");
  if (!synthAt) return true;
  return new Date(synthAt).getTime() < latestNoteMtimeMs;
}
function wrapTechTerms(text) {
  if (!text) return text;
  const sorted = [...TECH_TERMS].sort((a, b) => b.length - a.length);
  let result = text;
  for (const term of sorted) {
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<!value="|>)\\b(${escapedTerm})\\b(?![^<]*>)`, "g");
    result = result.replace(re, `<data value="${term}">$1</data>`);
  }
  return result;
}
function wrapFirstMention(text, term) {
  if (!text || !term) return text;
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b(${escapedTerm})\\b`);
  return text.replace(re, "<dfn>$1</dfn>");
}
function isNoise(t) {
  return isAgentMetaText(t) || isNoteMetadataResidue(t);
}
function extractNoteContent(note) {
  const { document } = parseHTML6(note.html);
  const article = document.querySelector("article");
  const rawArticleId = article?.getAttribute("id") ?? "";
  const articleId = rawArticleId.startsWith("$") || rawArticleId.length < 5 || /^[a-z]+$/.test(rawArticleId) ? "" : rawArticleId;
  const noteId = articleId || note.id;
  const h2 = article?.querySelector("h2");
  const title = (h2?.textContent ?? "").trim() || noteId;
  const tldrSection = article?.querySelector('[data-section="tldr"]');
  const tldrRaw = (tldrSection?.textContent ?? "").trim();
  const tldr = isNoise(tldrRaw) ? "" : tldrRaw;
  const tldrHtml = tldrSection?.innerHTML ?? "";
  const summarySection = article?.querySelector('[data-section="summary"]');
  const summaryRaw = (summarySection?.textContent ?? "").trim();
  const summaryText = isNoise(summaryRaw) ? "" : summaryRaw;
  const summaryHtml = summarySection?.innerHTML ?? "";
  const factElements = article?.querySelectorAll("[data-cerveau-fact]") ?? [];
  const facts = Array.from(factElements).map((f) => (f.textContent ?? "").trim()).filter((x) => Boolean(x) && !isNoise(x));
  const topicAttr = article?.getAttribute("data-cerveau-topic") ?? "";
  const segments = topicAttr.split("/").filter(Boolean);
  const subTopic = segments[1] ?? "general";
  const type = article?.getAttribute("data-cerveau-type") ?? "reference";
  const tipElements = article?.querySelectorAll('aside[role="doc-tip"]') ?? [];
  const tips = Array.from(tipElements).map((el) => (el.textContent ?? "").trim()).filter((x) => Boolean(x) && !isNoise(x));
  const warnElements = article?.querySelectorAll('aside[role="doc-warning"]') ?? [];
  const warnings = Array.from(warnElements).map((el) => (el.textContent ?? "").trim()).filter((x) => Boolean(x) && !isNoise(x));
  const dlEl = article?.querySelector("dl");
  const specsHtml = dlEl ? dlEl.outerHTML ?? "" : "";
  const statusAttr = article?.getAttribute("data-cerveau-status") ?? "";
  const statusMarkEl = article?.querySelector("mark[data-cerveau-status]");
  const status = statusAttr || (statusMarkEl?.getAttribute("data-cerveau-status") ?? "");
  const decisionEl = article?.querySelector(
    'aside[role="doc-note"], aside.decision-record, aside.decision-block'
  );
  const decisionOutcomeRaw = (decisionEl?.querySelector(".decision-outcome")?.textContent ?? "").trim() || (decisionEl?.querySelector("p")?.textContent ?? "").trim();
  const decisionOutcome = isNoise(decisionOutcomeRaw) ? "" : decisionOutcomeRaw;
  const decisionReasoning = (decisionEl?.querySelector(".decision-reasoning")?.textContent ?? "").trim();
  const bugEl = article?.querySelector('aside[role="doc-errata"]');
  const bugSymptomRaw = (bugEl?.querySelector(".bug-symptom")?.textContent ?? "").replace(/^symptom:\s*/i, "").trim() || (bugEl?.querySelector("p")?.textContent ?? "").trim();
  const bugSymptom = isNoise(bugSymptomRaw) ? "" : bugSymptomRaw;
  const bugFix = (bugEl?.querySelector(".bug-fix")?.textContent ?? "").replace(/^fix:\s*/i, "").trim();
  return {
    id: noteId,
    title,
    tldr,
    tldrHtml,
    summaryText,
    summaryHtml,
    facts,
    subTopic,
    type,
    tips,
    warnings,
    specsHtml,
    status,
    decisionOutcome,
    decisionReasoning,
    bugSymptom,
    bugFix
  };
}
function renderFactHighlights(facts) {
  if (facts.length === 0) return "";
  const items = facts.slice(0, 4).map((fact) => {
    const enriched = wrapTechTerms(fact);
    return `<div class="fact-item"><span class="fact-bullet"></span>${enriched}</div>`;
  }).join("\n");
  return `<div class="fact-highlights">
${items}
</div>`;
}
function renderCallouts(tips, warnings) {
  const parts = [];
  for (const tip of tips.slice(0, 2)) {
    parts.push(`<aside role="doc-tip">${wrapTechTerms(tip)}</aside>`);
  }
  for (const warn of warnings.slice(0, 2)) {
    parts.push(`<aside role="doc-warning">${wrapTechTerms(warn)}</aside>`);
  }
  return parts.join("\n");
}
function renderSpecs(specsHtml) {
  if (!specsHtml) return "";
  if (specsHtml.trimStart().startsWith("<dl")) {
    return specsHtml.replace(/^<dl([^>]*)>/, '<dl class="specs"$1>');
  }
  return "";
}
function renderStatusBadge(status) {
  if (!status) return "";
  const normalized = status.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `<mark data-cerveau-status="${normalized}" class="status-badge ${normalized}">${status}</mark>`;
}
function renderDecisionBox(outcome, reasoning) {
  if (!outcome) return "";
  const reasoningHtml = reasoning ? `<p class="decision-reasoning">${wrapTechTerms(reasoning)}</p>` : "";
  return `<aside role="doc-note" class="decision-box">
  <strong>Decision:</strong> ${wrapTechTerms(outcome)}
  ${reasoningHtml}
</aside>`;
}
function renderBugCard(symptom, fix) {
  if (!symptom) return "";
  const fixHtml = fix ? `<p class="bug-fix">Fix: ${wrapTechTerms(fix)}</p>` : "";
  return `<aside role="doc-errata" class="bug-card">
  <strong>Bug:</strong> ${wrapTechTerms(symptom)}
  ${fixHtml}
</aside>`;
}
function renderMetricRow(noteCount, subTopicCount, decisionCount) {
  const cards = [
    { value: noteCount, label: "notes" },
    { value: subTopicCount, label: "sub-topics" }
  ];
  if (decisionCount > 0) {
    cards.push({ value: decisionCount, label: "decisions" });
  }
  const cardHtml = cards.map(
    (c) => `<div class="metric-card">
  <data value="${c.value}" class="metric-value">${c.value}</data>
  <span class="metric-label">${c.label}</span>
</div>`
  ).join("\n");
  return `<div class="metric-row">
${cardHtml}
</div>`;
}
function renderSubTopicsTable(bySubTopic, topicSlug) {
  if (bySubTopic.size < 2) return "";
  const rows = Array.from(bySubTopic.entries()).map(([subTopic, items]) => {
    const sectionId = subTopic.replace(/[^a-z0-9]+/g, "-").toLowerCase();
    const typeSet = new Set(items.map((i) => i.type));
    const types = Array.from(typeSet).map(
      (t) => `<span class="type-badge ${t}">${items.filter((i) => i.type === t).length} ${t}</span>`
    ).join(" ");
    return `<tr>
  <td><a href="#/${topicSlug}/${sectionId}" class="section-link">${subTopic.charAt(0).toUpperCase() + subTopic.slice(1)}</a></td>
  <td>${items.length}</td>
  <td>${types}</td>
</tr>`;
  }).join("\n");
  return `<table class="wikitable compact">
  <caption>Sub-topic Distribution</caption>
  <thead><tr><th>Area</th><th>Notes</th><th>Types</th></tr></thead>
  <tbody>
    ${rows}
  </tbody>
</table>`;
}
function renderRelatedNotes(items) {
  if (items.length === 0) return "";
  const chips = items.slice(0, 6).filter((item) => item.id.length >= 5 && !item.id.startsWith("$") && !/^[a-z]+$/.test(item.id)).map((item) => {
    const typeClass = item.type.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const tooltip = (item.tldr || item.title).replace(/"/g, "&quot;").slice(0, 120);
    return `<a href="#/note/${item.id}" class="note-chip ${typeClass}" title="${tooltip}">${item.title}</a>`;
  }).join("\n");
  if (!chips) return "";
  return `<div class="related-notes">
  <span class="related-label">Articles:</span>
  ${chips}
</div>`;
}
function buildArticleSections(topicName, notes) {
  const contents = notes.map((n) => extractNoteContent(n));
  const bySubTopic = /* @__PURE__ */ new Map();
  for (const c of contents) {
    const group = bySubTopic.get(c.subTopic) ?? [];
    bySubTopic.set(c.subTopic, [...group, c]);
  }
  const allTldrs = contents.map((c) => c.tldr).filter(Boolean);
  const rawLead = allTldrs.slice(0, 3).join(" ") || `Overview of ${topicName}.`;
  const leadText = wrapTechTerms(rawLead);
  const topicSlug = topicName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const sectionParts = [];
  const decisionCount = contents.filter((c) => c.type === "decision").length;
  const metricRowHtml = renderMetricRow(contents.length, bySubTopic.size, decisionCount);
  for (const [subTopic, items] of bySubTopic) {
    const sectionTitle = subTopic.charAt(0).toUpperCase() + subTopic.slice(1);
    const sectionId = subTopic.replace(/[^a-z0-9]+/g, "-").toLowerCase();
    const proseParts = items.map((item) => {
      const base = item.summaryText || item.tldr;
      return base;
    }).filter(Boolean);
    let prose = proseParts.length > 0 ? proseParts.join(" ") : "";
    prose = wrapTechTerms(prose);
    prose = wrapFirstMention(prose, sectionTitle);
    const allFacts = items.flatMap((item) => item.facts);
    const allTips = items.flatMap((item) => item.tips);
    const allWarnings = items.flatMap((item) => item.warnings);
    const specsHtmlRaw = items.map((item) => item.specsHtml).find((s) => s) ?? "";
    const specsHtml = renderSpecs(specsHtmlRaw);
    const decisionBoxes = items.filter((item) => item.type === "decision" && (item.decisionOutcome || item.tldr)).map((item) => renderDecisionBox(item.decisionOutcome || item.tldr, item.decisionReasoning)).filter(Boolean).slice(0, 3).join("\n");
    const bugCards = items.filter((item) => item.type === "episodic" && (item.bugSymptom || item.tldr)).map((item) => renderBugCard(item.bugSymptom || item.tldr, item.bugFix)).filter(Boolean).slice(0, 3).join("\n");
    const statusBadges = items.filter((item) => item.status).map((item) => renderStatusBadge(item.status)).filter(Boolean).join(" ");
    const proseParagraph = prose ? `<p>${prose}${statusBadges ? ` ${statusBadges}` : ""}</p>` : statusBadges ? `<p>${statusBadges}</p>` : "";
    const calloutsHtml = renderCallouts(allTips, allWarnings);
    const factsHtml = renderFactHighlights(allFacts);
    const relatedHtml = renderRelatedNotes(items);
    const innerParts = [
      proseParagraph,
      decisionBoxes,
      bugCards,
      calloutsHtml,
      specsHtml,
      factsHtml,
      relatedHtml
    ].filter(Boolean).join("\n    ");
    sectionParts.push(
      `<section class="wiki-section" id="${sectionId}">
  <h2><a href="#/${topicSlug}/${sectionId}" class="section-link">${sectionTitle}</a></h2>
  <div class="section-content">
    ${innerParts}
  </div>
</section>`
    );
  }
  const subTopicsTable = renderSubTopicsTable(bySubTopic, topicSlug);
  const allSections = [metricRowHtml, ...sectionParts, subTopicsTable].filter(Boolean).join("\n");
  return { leadText, sections: allSections };
}
function findRelatedTopics(topic, backlinks, groups) {
  if (!backlinks) return [];
  const topicNoteIds = new Set((groups.get(topic) ?? []).map((n) => n.id));
  const relatedTopicNames = /* @__PURE__ */ new Set();
  for (const noteId of topicNoteIds) {
    const outEdges = backlinks.outgoing[noteId] ?? [];
    const inEdges = backlinks.incoming[noteId] ?? [];
    for (const edge of [...outEdges, ...inEdges]) {
      const otherId = edge.from === noteId ? edge.to : edge.from;
      for (const [otherTopic, otherNotes] of groups) {
        if (otherTopic === topic) continue;
        if (otherNotes.some((n) => n.id === otherId)) {
          relatedTopicNames.add(otherTopic);
        }
      }
    }
  }
  return Array.from(relatedTopicNames).map((name) => ({
    id: name,
    title: name.charAt(0).toUpperCase() + name.slice(1)
  }));
}
function findExistingSynthesis(topic, allNotes) {
  for (const note of allNotes) {
    const { document } = parseHTML6(note.html);
    const article = document.querySelector("article");
    if (!article) continue;
    const type = article.getAttribute("data-cerveau-type");
    if (type !== "topic-overview") continue;
    const topicAttr = article.getAttribute("data-cerveau-topic") ?? "";
    const firstSegment = topicAttr.split("/")[0]?.trim();
    if (firstSegment === topic) return note;
  }
  return null;
}
function findExistingBrainIndex(allNotes) {
  for (const note of allNotes) {
    const { document } = parseHTML6(note.html);
    const article = document.querySelector("article");
    const type = article?.getAttribute("data-cerveau-type");
    if (type === "brain-index") return note;
  }
  return null;
}
function graphToEmbedInput(graph, scope, project) {
  const crossProjectEdges = scope === "project" ? graph.edges.filter((e) => e.type.startsWith("cross-project:")).map((e) => {
    const targetNode = graph.nodes.find((n) => n.id === e.target);
    return {
      source: e.source,
      target: e.target,
      targetProject: targetNode?.topic ?? "unknown",
      type: e.type.replace("cross-project:", "")
    };
  }) : void 0;
  return {
    scope,
    project,
    stats: {
      nodes: graph.stats.nodes,
      edges: graph.stats.edges,
      clusters: graph.stats.clusters,
      hubs: graph.stats.hubs
    },
    clusters: graph.clusters.map((c) => ({
      id: c.id,
      label: c.label,
      nodeCount: c.nodeCount,
      hubs: graph.hubs.filter((h) => c.nodeIds.includes(h.id)).map((h) => ({ id: h.id, title: h.title })),
      connectedClusters: c.connectedClusters
    })),
    hubs: graph.hubs.map((h) => ({
      id: h.id,
      title: h.title,
      topic: h.topic,
      inbound: h.inbound,
      outbound: h.outbound
    })),
    edges: graph.edges.filter((e) => !e.type.startsWith("cross-project:")).map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type
    })),
    crossProjectEdges,
    layers: graph.layers?.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      nodeCount: l.nodeCount
    })),
    tour: graph.tour?.map((t) => ({
      order: t.order,
      title: t.title,
      noteId: t.noteId,
      description: t.description
    }))
  };
}
async function runSynthesize(opts) {
  const log = getLogger();
  const report = { synthesized: [], skipped: [], errors: [] };
  const allNotes = readAllNotes();
  const groups = groupNotesByTopic(allNotes);
  const fullGroups = groupNotesByFullTopic(allNotes);
  const backlinks = loadBacklinks();
  const knowledgeGraph = loadKnowledgeGraph();
  const now = nowIso();
  const topicsToProcess = opts.topic ? opts.topic in Object.fromEntries(groups) ? [opts.topic] : [...groups.keys()].filter((k) => k === opts.topic) : [...groups.keys()];
  if (opts.topic && !groups.has(opts.topic)) {
    log.warn({ topic: opts.topic }, "synthesize: topic not found in notes");
    return report;
  }
  for (const topic of topicsToProcess) {
    const topicNotes = groups.get(topic) ?? [];
    if (topicNotes.length === 0) continue;
    const existingSynth = findExistingSynthesis(topic, allNotes);
    const latestMtime = Math.max(...topicNotes.map((n) => n.mtimeMs));
    if (!isStale(existingSynth?.html ?? null, latestMtime)) {
      report.skipped.push(topic);
      continue;
    }
    try {
      const stats = aggregateTopicStats(topicNotes);
      const relatedTopics = findRelatedTopics(topic, backlinks, groups);
      const topicTitle = topic.charAt(0).toUpperCase() + topic.slice(1);
      const { leadText, sections } = buildArticleSections(topicTitle, topicNotes);
      const breadcrumb = buildBreadcrumb(topic);
      const childSection = buildChildTopicsSection(topic, fullGroups);
      let sectionsWithGraph = `${breadcrumb}
${childSection}
${sections}`;
      if (knowledgeGraph) {
        const subGraph = extractSubGraph(knowledgeGraph, topic);
        if (subGraph.nodes.length > 0) {
          const graphHtml = composeGraphSection(graphToEmbedInput(subGraph, "project", topic));
          sectionsWithGraph = `${sectionsWithGraph}
${graphHtml}`;
        }
      }
      const html = composeTopicOverview({
        id: `topic-overview-${topic}`,
        title: topicTitle,
        created: now,
        leadText,
        sections: sectionsWithGraph,
        stats,
        relatedTopics,
        tags: [topic, "synthesis"],
        topic
      });
      if (!opts.dryRun) {
        const written = writeNote(html, { overwrite: true });
        try {
          indexNote(readNote(written.path));
        } catch (err) {
          log.warn({ path: written.path, err: err.message }, "synthesize: topic overview reindex");
        }
      }
      report.synthesized.push(topic);
      log.debug({ topic, noteCount: stats.noteCount }, "synthesize: topic overview generated");
    } catch (err) {
      const msg = err.message;
      report.errors.push(`${topic}: ${msg}`);
      log.warn({ topic, err: msg }, "synthesize: topic overview failed");
    }
  }
  for (const [topicPath, topicNotes] of fullGroups) {
    const depth = topicPath.split("/").length;
    if (depth < 2) continue;
    if (topicNotes.length === 0) continue;
    if (opts.topic && !topicPath.startsWith(opts.topic)) continue;
    const pageId = `topic-overview-${topicPath.replace(/\//g, "-")}`;
    const existingPage = allNotes.find((n) => {
      const { document } = parseHTML6(n.html);
      const article = document.querySelector("article");
      return article?.getAttribute("id") === pageId;
    });
    const latestMtime = Math.max(...topicNotes.map((n) => n.mtimeMs));
    if (!isStale(existingPage?.html ?? null, latestMtime)) {
      report.skipped.push(topicPath);
      continue;
    }
    try {
      const topicTitle = topicPath.split("/").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" / ");
      const stats = aggregateTopicStats(topicNotes);
      const relatedTopics = findRelatedTopics(topicPath.split("/")[0], backlinks, groups);
      const breadcrumb = buildBreadcrumb(topicPath);
      const childSection = buildChildTopicsSection(topicPath, fullGroups);
      const directNotes = topicNotes.filter((n) => {
        const { document } = parseHTML6(n.html);
        const topic = document.querySelector("article")?.getAttribute("data-cerveau-topic") ?? "";
        return topic === topicPath || topic.startsWith(`${topicPath}/`);
      });
      const { leadText, sections } = buildArticleSections(topicTitle, directNotes);
      let sectionsWithGraph = `${breadcrumb}
${childSection}
${sections}`;
      if (knowledgeGraph) {
        const subGraph = extractSubGraph(knowledgeGraph, topicPath, { matchPrefix: true });
        if (subGraph.nodes.length > 0) {
          const graphHtml = composeGraphSection(graphToEmbedInput(subGraph, "project", topicPath));
          sectionsWithGraph = `${sectionsWithGraph}
${graphHtml}`;
        }
      }
      const html = composeTopicOverview({
        id: pageId,
        title: topicTitle,
        created: now,
        leadText,
        sections: sectionsWithGraph,
        stats,
        relatedTopics,
        tags: [topicPath.split("/")[0], ...topicPath.split("/").slice(1), "synthesis"],
        topic: topicPath
      });
      if (!opts.dryRun) {
        const written = writeNote(html, { overwrite: true });
        try {
          indexNote(readNote(written.path));
        } catch (err) {
          log.warn(
            { path: written.path, err: err.message },
            "synthesize: sub-topic overview reindex"
          );
        }
      }
      report.synthesized.push(topicPath);
      log.debug(
        { topicPath, noteCount: topicNotes.length },
        "synthesize: sub-topic overview generated"
      );
    } catch (err) {
      const msg = err.message;
      report.errors.push(`${topicPath}: ${msg}`);
      log.warn({ topicPath, err: msg }, "synthesize: sub-topic overview failed");
    }
  }
  if (!opts.topic) {
    const existingIndex = findExistingBrainIndex(allNotes);
    const latestNoteOverall = allNotes.length > 0 ? Math.max(...allNotes.map((n) => n.mtimeMs)) : 0;
    if (isStale(existingIndex?.html ?? null, latestNoteOverall)) {
      try {
        let globalEarliest = "";
        let globalLatest = "";
        let totalNotesCount = 0;
        const topicEntries = [...groups.entries()].map(([topicName, topicNotes]) => {
          totalNotesCount += topicNotes.length;
          const mtimes = topicNotes.map((n) => n.mtimeMs);
          const lastMtime = Math.max(...mtimes);
          const lastActivity = new Date(lastMtime).toISOString().slice(0, 10);
          for (const n of topicNotes) {
            const { document } = parseHTML6(n.html);
            const created = document.querySelector("article")?.getAttribute("data-cerveau-created") ?? "";
            if (created) {
              if (!globalEarliest || created < globalEarliest) globalEarliest = created;
              if (!globalLatest || created > globalLatest) globalLatest = created;
            }
          }
          const firstContent = extractNoteContent(topicNotes[0]);
          const description = firstContent.tldr || firstContent.summaryText || "";
          return {
            name: topicName.charAt(0).toUpperCase() + topicName.slice(1),
            id: `topic-overview-${topicName}`,
            noteCount: topicNotes.length,
            lastActivity,
            description
          };
        });
        const topicNames = topicEntries.map((t) => t.name).join(", ");
        const leadText = `This brain covers ${groups.size} main topic${groups.size !== 1 ? "s" : ""}: ${topicNames}. It contains ${totalNotesCount} notes with detailed architecture, decisions, and operational knowledge.`;
        const graphSection = knowledgeGraph ? composeGraphSection(graphToEmbedInput(knowledgeGraph, "brain")) : "";
        const html = composeBrainIndex({
          id: "brain-index",
          title: "Brain Index",
          created: now,
          leadText,
          stats: {
            totalNotes: totalNotesCount,
            totalTopics: groups.size,
            dateRange: [globalEarliest, globalLatest]
          },
          topics: topicEntries,
          tags: ["index", "synthesis"],
          graphSection
        });
        if (!opts.dryRun) {
          const written = writeNote(html, { overwrite: true });
          try {
            indexNote(readNote(written.path));
          } catch (err) {
            log.warn({ path: written.path, err: err.message }, "synthesize: brain index reindex");
          }
        }
        report.synthesized.push("__brain-index__");
        log.debug({ topics: groups.size }, "synthesize: brain index generated");
      } catch (err) {
        const msg = err.message;
        report.errors.push(`brain-index: ${msg}`);
        log.warn({ err: msg }, "synthesize: brain index failed");
      }
    } else {
      report.skipped.push("__brain-index__");
    }
  }
  return report;
}
var SYNTHESIS_TYPES, TECH_TERMS;
var init_synthesize = __esm({
  "src/commands/synthesize.ts"() {
    "use strict";
    init_brain_index();
    init_graph_embed();
    init_topic_overview();
    init_backlinks();
    init_knowledge_graph();
    init_fts();
    init_reader();
    init_writer();
    init_logger();
    init_telemetry();
    init_dream();
    init_enrich();
    SYNTHESIS_TYPES = /* @__PURE__ */ new Set(["topic-overview", "project-summary", "brain-index"]);
    TECH_TERMS = [
      "React Native",
      "Expo",
      "Supabase",
      "TypeScript",
      "JavaScript",
      "Next.js",
      "Tailwind",
      "Stripe",
      "MT5",
      "MetaTrader",
      "Blender",
      "MCP",
      "Python",
      "Node.js",
      "PostgreSQL",
      "NativeWind",
      "TanStack Query",
      "expo-router",
      "FCM",
      "Notifee",
      "Electron",
      "GPT",
      "OpenAI",
      "Render",
      "Vercel",
      "GitHub",
      "Prisma",
      "Redis",
      "Docker",
      "Zod"
    ];
  }
});

// src/util/tool-trace.ts
function toolUseBlockToHookJson(block) {
  return JSON.stringify({
    tool_name: block.name,
    tool_input: block.input ?? {},
    tool_response: {}
  });
}
function relativise(filePath, projectRoot) {
  const normPath4 = filePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const normRoot = projectRoot.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const lowerPath = normPath4.toLowerCase();
  const lowerRoot = normRoot.toLowerCase();
  if (!lowerPath.startsWith(`${lowerRoot}/`) && lowerPath !== lowerRoot) {
    return null;
  }
  const rel = normPath4.slice(normRoot.length).replace(/^\//, "");
  return rel || null;
}
function extractToolTraceFiles(jsonl, projectRoot) {
  const modifiedSet = /* @__PURE__ */ new Set();
  const readSet = /* @__PURE__ */ new Set();
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msgType = obj.type ?? obj.role ?? "";
    if (msgType !== "assistant") continue;
    const message = obj.message ?? obj;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") {
        continue;
      }
      const hookJson = toolUseBlockToHookJson(block);
      const parsed = parseToolPayload(hookJson);
      if (!parsed) continue;
      for (const absPath of parsed.filesModified) {
        const rel = relativise(absPath, projectRoot);
        if (rel) modifiedSet.add(rel);
      }
      for (const absPath of parsed.filesRead) {
        const rel = relativise(absPath, projectRoot);
        if (rel) readSet.add(rel);
      }
    }
  }
  return {
    filesModified: [...modifiedSet],
    filesRead: [...readSet]
  };
}
var init_tool_trace2 = __esm({
  "src/util/tool-trace.ts"() {
    "use strict";
    init_payload_parser();
  }
});

// src/sources/claude-code.ts
import { createHash as createHash4 } from "node:crypto";
import { existsSync as existsSync14, readdirSync as readdirSync4, statSync as statSync5 } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join as join16 } from "node:path";
function makeConversationSessionId(filePath) {
  const hash = createHash4("sha256").update(filePath).digest("hex").slice(0, 8);
  return `dream-${hash}`;
}
function decodeProjectPath(dirName) {
  return dirName.replace(/^([A-Za-z])--/, "$1:/").replace(/-/g, "/");
}
function findConversationFiles(dir) {
  const files = [];
  try {
    for (const entry of readdirSync4(dir, { withFileTypes: true })) {
      const full = join16(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
        files.push(full);
      } else if (entry.isDirectory()) {
        try {
          for (const sub of readdirSync4(full, { withFileTypes: true })) {
            if (sub.isFile() && (sub.name.endsWith(".jsonl") || sub.name.endsWith(".json"))) {
              files.push(join16(full, sub.name));
            }
          }
        } catch {
        }
      }
    }
  } catch {
  }
  return files;
}
function extractTextFromMessage(obj) {
  if (typeof obj.content === "string") return obj.content;
  if (!Array.isArray(obj.content)) return null;
  const texts = [];
  for (const block of obj.content) {
    const b = block;
    if (b.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
    }
  }
  return texts.join(" ").trim() || null;
}
function categorizeMessage(text, decisions, errors, facts, general) {
  if (/\b(decided|decision|chose|choosing|switched|migration|use .+ instead|we('ll| will) use|going with|opted for)\b/i.test(
    text
  )) {
    decisions.push(text);
  } else if (/\b(error|bug|fix|broken|failed|crash|issue|exception|traceback)\b/i.test(text)) {
    errors.push(text);
  } else if (/\b(because|reason|important|always|never|warning|careful|don't|avoid|must|should|need to|has to)\b/i.test(
    text
  )) {
    facts.push(text);
  } else if (text.length > 40) {
    general.push(text);
  }
}
function extractConversationChunks(content, projectRoot, maxChunks = 25, targetCharsPerChunk = 6e3) {
  const lines = content.split("\n").filter(Boolean);
  const segments = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const msgType = obj.type ?? obj.role ?? "";
      const isUser = msgType === "user" || msgType === "human";
      const isAssistant = msgType === "assistant";
      if (!isUser && !isAssistant) continue;
      const message = obj.message;
      const textSource = message ?? obj;
      const text = extractTextFromMessage(textSource);
      if (!text || text.length < 20) continue;
      if (isAgentMetaText(text)) continue;
      const truncated = isUser ? text.slice(0, 500) : text.slice(0, 600);
      if (isAssistant) {
        if (truncated.startsWith("{") || truncated.startsWith("[") || truncated.startsWith("```"))
          continue;
        if (/^(Running|Reading|Searching|Checking|Let me)/i.test(truncated)) continue;
      }
      const decisions = [];
      const errors = [];
      const facts = [];
      const general = [];
      categorizeMessage(truncated, decisions, errors, facts, general);
      for (const t of decisions) segments.push({ text: t, category: "decision" });
      for (const t of errors) segments.push({ text: t, category: "error" });
      for (const t of facts) segments.push({ text: t, category: "fact" });
      for (const t of general) segments.push({ text: t, category: "general" });
    } catch {
    }
  }
  if (segments.length === 0) return [];
  const { filesModified, filesRead } = extractToolTraceFiles(content, projectRoot);
  const chunks = [];
  let currentBucket = [];
  let currentChars = 0;
  const flushChunk = () => {
    if (currentBucket.length === 0) return;
    const text = currentBucket.join("\n\n").slice(0, 4e3);
    if (text.length > 50 && !isAgentMetaText(text) && hasMeaningfulContent(text) && !isConfigurableNoise(text) && !isBuildOutputNoise(text)) {
      chunks.push({ text, filesModified, filesRead });
    }
    currentBucket = [];
    currentChars = 0;
  };
  for (const seg of segments) {
    if (currentChars + seg.text.length > targetCharsPerChunk && currentBucket.length > 0) {
      flushChunk();
      if (chunks.length >= maxChunks) break;
    }
    currentBucket.push(seg.text);
    currentChars += seg.text.length + 2;
  }
  if (chunks.length < maxChunks) {
    flushChunk();
  }
  return chunks;
}
async function readConversationContentBounded(filePath, maxBytes = MAX_CONVERSATION_READ_BYTES) {
  const size = statSync5(filePath).size;
  if (size <= maxBytes) {
    return readFile(filePath, "utf-8");
  }
  const start = size - maxBytes;
  const handle5 = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await handle5.read(buf, 0, maxBytes, start);
    const text = buf.toString("utf-8");
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle5.close();
  }
}
var MAX_CONVERSATION_READ_BYTES, ClaudeCodeSource;
var init_claude_code = __esm({
  "src/sources/claude-code.ts"() {
    "use strict";
    init_tool_trace2();
    init_noise();
    MAX_CONVERSATION_READ_BYTES = (() => {
      const override = Number(process.env.LAZYBRAIN_MAX_CONVERSATION_BYTES);
      return Number.isFinite(override) && override > 0 ? override : 6 * 1024 * 1024;
    })();
    ClaudeCodeSource = class {
      agent = "claude-code";
      userProfile;
      constructor(opts = {}) {
        this.userProfile = opts.userProfile;
      }
      resolveUserProfile() {
        return this.userProfile ?? process.env.USERPROFILE ?? process.env.HOME ?? "";
      }
      listConversations() {
        const claudeDir = join16(this.resolveUserProfile(), ".claude", "projects");
        if (!existsSync14(claudeDir)) return [];
        const includeSelf = (process.env.LAZYBRAIN_DREAM_INCLUDE_SELF ?? "").trim() === "1";
        const refs = [];
        for (const proj of readdirSync4(claudeDir, { withFileTypes: true })) {
          if (!proj.isDirectory()) continue;
          const projectRoot = decodeProjectPath(proj.name);
          if (/lazybrain/i.test(proj.name) && !includeSelf) {
            continue;
          }
          const projPath = join16(claudeDir, proj.name);
          for (const f of findConversationFiles(projPath)) {
            try {
              const stat = statSync5(f);
              refs.push({
                path: f,
                mtimeMs: stat.mtimeMs,
                projectRoot,
                agent: "claude-code",
                kind: "transcript"
              });
            } catch {
            }
          }
        }
        return refs;
      }
      async readConversation(ref) {
        const content = await readConversationContentBounded(ref.path);
        const chunks = extractConversationChunks(content, ref.projectRoot);
        if (chunks.length === 0) return [];
        const baseSessionId = makeConversationSessionId(ref.path);
        const timestamp = new Date(ref.mtimeMs).toISOString();
        return chunks.map((chunk, index) => ({
          // Each chunk gets a unique sessionId so notes don't collide.
          // Chunk 0 keeps the original id for backward compat with existing fingerprints.
          sessionId: index === 0 ? baseSessionId : `${baseSessionId}-c${index}`,
          text: chunk.text,
          timestamp,
          cwd: ref.projectRoot,
          filesModified: chunk.filesModified,
          filesRead: chunk.filesRead,
          agent: "claude-code",
          sourceKind: "transcript"
        }));
      }
    };
  }
});

// src/sources/types.ts
import { createHash as createHash5 } from "node:crypto";
function makeSourceSessionId(agent, filePath) {
  const hash = createHash5("sha256").update(filePath).digest("hex").slice(0, 8);
  return `${agent}-${hash}`;
}
var init_types = __esm({
  "src/sources/types.ts"() {
    "use strict";
  }
});

// src/sources/summarize.ts
function summarizeMessages(items) {
  const decisions = [];
  const errors = [];
  const facts = [];
  const general = [];
  for (const item of items) {
    const text = item.text.trim();
    if (!text || text.length < 20) continue;
    if (isAgentMetaText(text)) continue;
    if (item.role === "assistant") {
      if (text.startsWith("{") || text.startsWith("[") || text.startsWith("```")) continue;
      if (/^(Running|Reading|Searching|Checking|Let me)/i.test(text)) continue;
    }
    const clipped = item.role === "user" ? text.slice(0, 500) : text.slice(0, 600);
    categorize(clipped, decisions, errors, facts, general);
  }
  const parts = [
    ...decisions.slice(0, 8),
    ...errors.slice(0, 5),
    ...facts.slice(0, 5),
    ...general.slice(-3)
  ];
  return parts.join("\n\n").slice(0, 4e3);
}
function categorize(text, decisions, errors, facts, general) {
  if (/\b(decided|decision|chose|choosing|switched|migration|use .+ instead|we('ll| will) use|going with|opted for)\b/i.test(
    text
  )) {
    decisions.push(text);
  } else if (/\b(error|bug|fix|broken|failed|crash|issue|exception|traceback)\b/i.test(text)) {
    errors.push(text);
  } else if (/\b(because|reason|important|always|never|warning|careful|don't|avoid|must|should|need to|has to)\b/i.test(
    text
  )) {
    facts.push(text);
  } else if (text.length > 40) {
    general.push(text);
  }
}
var init_summarize = __esm({
  "src/sources/summarize.ts"() {
    "use strict";
    init_noise();
  }
});

// src/sources/vibe-parser.ts
function parseVibeMessages(jsonl) {
  const out = [];
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object" && typeof obj.role === "string") out.push(obj);
    } catch {
    }
  }
  return out;
}
function parseVibeMeta(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}
function isCompactionSummary(msg) {
  return msg.role === "user" && msg.injected === true && typeof msg.content === "string" && // Trim leading whitespace to tolerate minor formatting drift in Vibe's
  // injected message serialization while still matching the literal prefix
  // from vibe/core/prompts/compact_summary_prefix.md.
  msg.content.trimStart().startsWith(VIBE_COMPACT_SUMMARY_PREFIX);
}
function findCompactionSummary(messages) {
  for (const msg of messages) {
    if (!isCompactionSummary(msg)) continue;
    const content = (msg.content ?? "").trimStart();
    const idx = content.indexOf("\n");
    const body = idx >= 0 ? content.slice(idx + 1) : content;
    const cleaned = body.trim();
    return cleaned.length > 0 ? cleaned : null;
  }
  return null;
}
function extractVibeToolFiles(messages, projectRoot) {
  const modified = /* @__PURE__ */ new Set();
  const read = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      const name = call.function?.name ?? "";
      const rawArgs = call.function?.arguments;
      if (!name || typeof rawArgs !== "string") continue;
      let args;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        continue;
      }
      const readKey = VIBE_READ_TOOLS[name];
      const writeKey = VIBE_WRITE_TOOLS[name];
      const pick = (key) => {
        if (!key) return null;
        const v = args[key];
        return typeof v === "string" && v.length > 0 ? v : null;
      };
      const readPath = pick(readKey);
      if (readPath) {
        const rel = projectRoot ? relativise(readPath, projectRoot) : readPath;
        if (rel) read.add(rel);
      }
      const writePath = pick(writeKey);
      if (writePath) {
        const rel = projectRoot ? relativise(writePath, projectRoot) : writePath;
        if (rel) modified.add(rel);
      }
    }
  }
  return { filesModified: [...modified], filesRead: [...read] };
}
function extractVibeSummary(messages) {
  const items = [];
  for (const msg of messages) {
    if (msg.injected === true) continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (typeof msg.content !== "string" || msg.content.length === 0) continue;
    items.push({ role: msg.role, text: msg.content });
  }
  return summarizeMessages(items);
}
var VIBE_COMPACT_SUMMARY_PREFIX, VIBE_READ_TOOLS, VIBE_WRITE_TOOLS;
var init_vibe_parser = __esm({
  "src/sources/vibe-parser.ts"() {
    "use strict";
    init_tool_trace2();
    init_summarize();
    VIBE_COMPACT_SUMMARY_PREFIX = "Another language model started to solve this problem";
    VIBE_READ_TOOLS = { read: "file_path" };
    VIBE_WRITE_TOOLS = {
      edit: "file_path",
      search_replace: "file_path",
      // pre-v2.14 alias
      write_file: "path"
    };
  }
});

// src/sources/vibe.ts
import { existsSync as existsSync15, readFileSync as readFileSync14, readdirSync as readdirSync5, statSync as statSync6 } from "node:fs";
import { readFile as readFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname8, isAbsolute, join as join17, resolve as resolve2 } from "node:path";
import { parse as parseToml } from "smol-toml";
function vibeHome() {
  return process.env.VIBE_HOME ? resolve2(process.env.VIBE_HOME) : join17(homedir3(), ".vibe");
}
function vibeSessionLogDir(home) {
  const fallback = join17(home, "logs", "session");
  const configPath = join17(home, "config.toml");
  if (!existsSync15(configPath)) return fallback;
  try {
    const config = parseToml(readFileSync14(configPath, "utf8"));
    const section = config.session_logging;
    const saveDir = section?.save_dir;
    if (typeof saveDir === "string" && saveDir.trim().length > 0) {
      return isAbsolute(saveDir) ? saveDir : join17(home, saveDir);
    }
  } catch {
  }
  return fallback;
}
async function readPlan(ref) {
  const content = (await readFile2(ref.path, "utf-8")).trim();
  if (content.length <= 50) return [];
  return [
    {
      sessionId: makeSourceSessionId("vibe", ref.path),
      text: content.slice(0, 4e3),
      timestamp: new Date(ref.mtimeMs).toISOString(),
      cwd: "",
      filesModified: [],
      filesRead: [],
      agent: "vibe",
      sourceKind: "plan"
    }
  ];
}
async function readHistory(ref) {
  const raw = await readFile2(ref.path, "utf-8");
  const prompts = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      prompts.push(typeof parsed === "string" ? parsed : String(parsed));
    } catch {
      prompts.push(trimmed);
    }
  }
  if (prompts.length === 0) return [];
  const text = `Recurring user prompts (Vibe history):
${prompts.join("\n")}`.slice(0, 4e3);
  return [
    {
      sessionId: makeSourceSessionId("vibe", ref.path),
      text,
      timestamp: new Date(ref.mtimeMs).toISOString(),
      cwd: "",
      filesModified: [],
      filesRead: [],
      agent: "vibe",
      sourceKind: "history"
    }
  ];
}
function payloadBase(ref, meta, cwd) {
  return {
    timestamp: meta?.start_time ?? new Date(ref.mtimeMs).toISOString(),
    cwd,
    agent: "vibe",
    gitCommit: meta?.git_commit ?? void 0,
    gitBranch: meta?.git_branch ?? void 0
  };
}
function pushRef(refs, path, projectRoot, kind) {
  if (!existsSync15(path)) return;
  try {
    const stat = statSync6(path);
    refs.push({ path, mtimeMs: stat.mtimeMs, projectRoot, agent: "vibe", kind });
  } catch {
  }
}
function safeReaddir(dir) {
  try {
    return readdirSync5(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
}
function readWorkingDirectory(metaPath) {
  try {
    const meta = parseVibeMeta(readFileSync14(metaPath, "utf8"));
    return meta?.environment?.working_directory ?? "";
  } catch {
    return "";
  }
}
async function safeRead(path) {
  try {
    return await readFile2(path, "utf-8");
  } catch {
    return "";
  }
}
var SELF_INGEST_GUARD, VibeSource;
var init_vibe = __esm({
  "src/sources/vibe.ts"() {
    "use strict";
    init_types();
    init_vibe_parser();
    SELF_INGEST_GUARD = /cerveau|lazybrain/i;
    VibeSource = class {
      agent = "vibe";
      homeOverride;
      constructor(opts = {}) {
        this.homeOverride = opts.home;
      }
      /** Resolved lazily so tests can change VIBE_HOME between instances. */
      home() {
        return this.homeOverride ?? vibeHome();
      }
      listConversations() {
        const home = this.home();
        if (!existsSync15(home)) return [];
        const refs = [];
        const sessionDir = vibeSessionLogDir(home);
        if (existsSync15(sessionDir)) {
          for (const entry of safeReaddir(sessionDir)) {
            const dir = join17(sessionDir, entry);
            const transcript = join17(dir, "messages.jsonl");
            const projectRoot = readWorkingDirectory(join17(dir, "meta.json"));
            pushRef(refs, transcript, projectRoot, "transcript");
            const agentsDir = join17(dir, "agents");
            if (existsSync15(agentsDir)) {
              for (const sub of safeReaddir(agentsDir)) {
                pushRef(refs, join17(agentsDir, sub, "messages.jsonl"), projectRoot, "subagent");
              }
            }
          }
        }
        const plansDir = join17(home, "plans");
        if (existsSync15(plansDir)) {
          for (const f of safeReaddir(plansDir)) {
            if (f.endsWith(".md")) pushRef(refs, join17(plansDir, f), "", "plan");
          }
        }
        pushRef(refs, join17(home, "vibehistory"), "", "history");
        return refs;
      }
      async readConversation(ref) {
        switch (ref.kind) {
          case "transcript":
          case "subagent":
            return this.readTranscript(ref);
          case "plan":
            return readPlan(ref);
          case "history":
            return readHistory(ref);
          default:
            return [];
        }
      }
      async readTranscript(ref) {
        const meta = parseVibeMeta(await safeRead(join17(dirname8(ref.path), "meta.json")));
        const cwd = meta?.environment?.working_directory ?? ref.projectRoot ?? "";
        if (cwd && SELF_INGEST_GUARD.test(cwd)) return [];
        const messages = parseVibeMessages(await readFile2(ref.path, "utf-8"));
        if (messages.length === 0) return [];
        const base = payloadBase(ref, meta, cwd);
        const payloads = [];
        const text = extractVibeSummary(messages);
        if (text && text.length > 50) {
          const { filesModified, filesRead } = extractVibeToolFiles(messages, cwd);
          payloads.push({
            ...base,
            sessionId: makeSourceSessionId("vibe", ref.path),
            text,
            filesModified,
            filesRead,
            sourceKind: ref.kind
          });
        }
        const compaction = findCompactionSummary(messages);
        if (compaction && compaction.length > 50) {
          payloads.push({
            ...base,
            sessionId: makeSourceSessionId("vibe", `${ref.path}#compaction`),
            text: compaction,
            filesModified: [],
            filesRead: [],
            sourceKind: "compaction-summary",
            sessionParent: meta?.parent_session_id ?? void 0
          });
        }
        return payloads;
      }
    };
  }
});

// src/sources/registry.ts
var registry_exports = {};
__export(registry_exports, {
  getSources: () => getSources
});
function getSources(agent) {
  const all = [new ClaudeCodeSource(), new VibeSource()];
  if (!agent) return all;
  return all.filter((s) => s.agent === agent);
}
var init_registry = __esm({
  "src/sources/registry.ts"() {
    "use strict";
    init_claude_code();
    init_vibe();
  }
});

// src/commands/dream.ts
import { existsSync as existsSync16, readFileSync as readFileSync15, statSync as statSync7, writeFileSync as writeFileSync12 } from "node:fs";
import { freemem } from "node:os";
import { join as join18 } from "node:path";
import { parseHTML as parseHTML7 } from "linkedom";
function isStubDatetimeHexId(id) {
  const lower = id.trim().toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}/.test(lower)) return false;
  if (!/[0-9a-f]{8}$/.test(lower)) return false;
  const inner = lower.slice(10, lower.length - 9);
  const tokens = inner.split("-").filter((t) => t.length > 0);
  const hasAlphaWord = tokens.some((t) => /^[a-z]+$/i.test(t));
  return !hasAlphaWord;
}
function legacyTrackingFilePath() {
  try {
    const root = brainRoot();
    const cacheDir = join18(root, "..", "_cache");
    return join18(cacheDir, "dream-processed.json");
  } catch {
    return join18(
      process.env.USERPROFILE ?? process.env.HOME ?? ".",
      ".lazybrain-dream-processed.json"
    );
  }
}
function migrateLegacyTrackedFiles(store) {
  const legacyPath = legacyTrackingFilePath();
  if (!existsSync16(legacyPath)) return store;
  let legacyPaths = [];
  try {
    const data = JSON.parse(readFileSync15(legacyPath, "utf-8"));
    if (Array.isArray(data)) legacyPaths = data;
  } catch {
    return store;
  }
  let migrated = store;
  for (const fp of legacyPaths) {
    if (migrated.files[fp]) continue;
    if (!existsSync16(fp)) continue;
    try {
      const s = statSync7(fp);
      migrated = {
        ...migrated,
        files: {
          ...migrated.files,
          [fp]: {
            filePath: fp,
            contentHash: "",
            // empty → slow path will rehash
            mtimeMs: s.mtimeMs,
            size: s.size,
            processedAt: (/* @__PURE__ */ new Date()).toISOString(),
            notesCreated: []
          }
        }
      };
    } catch {
    }
  }
  return migrated;
}
function showProgress(current, total, label) {
  const pct = total > 0 ? Math.round(current / total * 100) : 0;
  const barLen = 20;
  const filled = Math.floor(pct / (100 / barLen));
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
  const labelStr = label.slice(0, 40).padEnd(40);
  process.stderr.write(
    `\r  ${bar} ${pct.toString().padStart(3)}% [${current}/${total}] ${labelStr}`
  );
}
function clearProgress() {
  process.stderr.write(`\r${" ".repeat(80)}\r`);
}
function backoffSleepMs() {
  const override = Number(process.env.LAZYBRAIN_TEST_BACKOFF_MS);
  return Number.isFinite(override) && override >= 0 ? override : 2e3;
}
function availableMemoryMb() {
  const override = Number(process.env.LAZYBRAIN_TEST_FREE_MB);
  if (Number.isFinite(override) && override > 0) return override;
  return freemem() / (1024 * 1024);
}
function resolveIngestionConcurrency() {
  const override = Number(process.env.LAZYBRAIN_DREAM_CONCURRENCY);
  const baseline = Number.isFinite(override) && override > 0 ? override : DEFAULT_INGESTION_CONCURRENCY;
  return availableMemoryMb() < LOW_MEMORY_THRESHOLD_MB ? Math.max(MIN_INGESTION_CONCURRENCY, Math.floor(baseline / 4)) : baseline;
}
async function waitForCriticalMemoryToClear() {
  for (let attempt = 0; attempt < CRITICAL_BACKOFF_MAX_RETRIES; attempt++) {
    if (availableMemoryMb() >= CRITICAL_MEMORY_THRESHOLD_MB) return true;
    await new Promise((resolve9) => setTimeout(resolve9, backoffSleepMs()));
  }
  return availableMemoryMb() >= CRITICAL_MEMORY_THRESHOLD_MB;
}
async function processConversationBatch(source, batch, store, log) {
  const results = await Promise.all(
    batch.map(async (ref) => {
      const noteIds = [];
      const indexedNotes2 = [];
      try {
        const payloads = await source.readConversation(ref);
        for (const p of payloads) {
          if (!p.text || p.text.length <= 50) continue;
          const result = annotateSession({
            sessionId: p.sessionId,
            text: p.text.slice(0, 4e3),
            timestamp: p.timestamp,
            cwd: p.cwd || void 0,
            filesModified: p.filesModified.length > 0 ? p.filesModified : void 0,
            filesRead: p.filesRead.length > 0 ? p.filesRead : void 0,
            agent: p.agent,
            sourceKind: p.sourceKind,
            sessionParent: p.sessionParent,
            gitCommit: p.gitCommit,
            gitBranch: p.gitBranch
          });
          if (!result.html) continue;
          if (detectNoise(result.html.slice(0, 500))) continue;
          if (result.factCount <= 1 && isStubDatetimeHexId(result.id)) continue;
          const written = writeNote(result.html);
          noteIds.push(result.id);
          try {
            indexedNotes2.push(indexNote(readNote(written.path)));
          } catch (err) {
            log.warn(
              { path: written.path, err: err.message },
              "dream: conversation note reindex failed"
            );
          }
        }
      } catch (err) {
        log.warn(
          { file: ref.path, err: err.message },
          "dream: conversation processing failed"
        );
      }
      return { filePath: ref.path, noteIds, indexedNotes: indexedNotes2 };
    })
  );
  let nextStore = store;
  let createdDelta = 0;
  const indexedNotes = [];
  for (const result of results) {
    nextStore = recordProcessed(result.filePath, result.noteIds, nextStore);
    if (result.noteIds.length > 0) createdDelta++;
    indexedNotes.push(...result.indexedNotes);
  }
  return { store: nextStore, createdDelta, indexedNotes };
}
function checkpointFingerprints(store, log) {
  try {
    saveFingerprints(store);
  } catch (err) {
    log.warn(
      { err: err.message },
      "dream: incremental fingerprint checkpoint failed"
    );
  }
}
async function processUnreadConversations(opts) {
  const log = getLogger();
  const { getSources: getSources2 } = await Promise.resolve().then(() => (init_registry(), registry_exports));
  const sources = getSources2(opts.agent);
  let store = opts.force ? { version: "1.0.0", generatedAt: (/* @__PURE__ */ new Date()).toISOString(), files: {} } : loadFingerprints();
  if (!opts.force) store = migrateLegacyTrackedFiles(store);
  let created = 0;
  let skippedTotal = 0;
  for (const source of sources) {
    let refs;
    try {
      refs = source.listConversations();
    } catch (err) {
      log.warn({ agent: source.agent, err: err.message }, "dream: source scan failed");
      continue;
    }
    if (refs.length === 0) continue;
    const changedUnsorted = opts.force ? refs : refs.filter((r) => hasChanged(r.path, store));
    skippedTotal += refs.length - changedUnsorted.length;
    const changed = [...changedUnsorted].sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (opts.pretty) {
      process.stderr.write(
        `
  [${source.agent}] ${refs.length} conversations: ${changed.length} new/changed, ${refs.length - changed.length} unchanged (skipped)

`
      );
    }
    if (opts.dryRun) {
      for (const ref of changed) {
        store = recordProcessed(ref.path, [], store);
        created++;
      }
      continue;
    }
    let progressCount = 0;
    let batchStart = 0;
    while (batchStart < changed.length) {
      if (availableMemoryMb() < CRITICAL_MEMORY_THRESHOLD_MB) {
        const recovered = await waitForCriticalMemoryToClear();
        if (!recovered) {
          log.warn(
            {
              source: source.agent,
              processed: progressCount,
              remaining: changed.length - progressCount
            },
            "dream: ingestion paused \u2014 free memory still critical after backoff; checkpointed progress so far, deferring the rest to the next run"
          );
          break;
        }
      }
      const concurrency = resolveIngestionConcurrency();
      const batch = changed.slice(batchStart, batchStart + concurrency);
      batchStart += concurrency;
      const batchResult = await processConversationBatch(source, batch, store, log);
      store = batchResult.store;
      created += batchResult.createdDelta;
      if (batchResult.indexedNotes.length > 0) {
        await embedNotesForIndex(batchResult.indexedNotes);
      }
      if (!opts.dryRun) checkpointFingerprints(store, log);
      progressCount += batch.length;
      if (opts.pretty) {
        showProgress(progressCount, changed.length, source.agent);
      }
    }
    if (opts.pretty) clearProgress();
  }
  if (!opts.dryRun) checkpointFingerprints(store, log);
  return { created, skipped: skippedTotal };
}
function extractText2(html) {
  try {
    return stripNote(html).text;
  } catch {
    return "";
  }
}
function hasTldr(html) {
  return html.includes('data-section="tldr"') || html.includes("data-cerveau-tldr");
}
function injectTldr(html, tldr) {
  const { document } = parseHTML7(`<!doctype html><body>${html}</body>`);
  const article = document.querySelector("article");
  if (!article) return html;
  const tldrSection = document.createElement("section");
  tldrSection.setAttribute("data-section", "tldr");
  const p = document.createElement("p");
  p.textContent = tldr;
  tldrSection.appendChild(p);
  const firstHeading = article.querySelector("h1, h2, h3");
  if (firstHeading?.nextSibling) {
    firstHeading.nextSibling.parentElement?.insertBefore(tldrSection, firstHeading.nextSibling);
  } else {
    article.appendChild(tldrSection);
  }
  return article.outerHTML;
}
function detectNoise(text) {
  const trimmed = text.trim();
  if (trimmed.length < 60) return true;
  if (isConfigurableNoise(trimmed)) return true;
  if (isBuildOutputNoise(trimmed)) return true;
  if (isAgentMetaText(trimmed)) return true;
  if (countAlphanumericWords(trimmed) < 8) return true;
  if (isMostlyPunctuation(trimmed)) return true;
  const lines = trimmed.split("\n").filter(Boolean);
  const jsonLines = lines.filter(
    (l) => l.trim().startsWith("{") || l.trim().startsWith("[")
  ).length;
  if (lines.length > 2 && jsonLines / lines.length > 0.5) return true;
  if (trimmed.includes("session_id") && trimmed.includes("transcript_path")) return true;
  if (trimmed.includes("tool_name") && trimmed.includes("tool_input")) return true;
  if (/^(Edit|Write|Read|Grep|Glob|Bash):?\s+\S+\s*$/m.test(trimmed) && trimmed.length < 200)
    return true;
  if (/^(npx|npm|node|tsx|vitest|git)\s/m.test(trimmed) && trimmed.length < 150) return true;
  const uniqueLines = new Set(lines.map((l) => l.trim().slice(0, 50)));
  if (lines.length > 5 && uniqueLines.size < lines.length * 0.3) return true;
  if (isDominatedByRepetition(trimmed)) return true;
  if (lines.length <= 2 && countAlphanumericWords(trimmed) < 25 && /^(create|make|write|add|delete|remove|run|execute|open|close|touch|copy|move|rename|set|get|fetch|install|update|upgrade|build|start|stop|restart|deploy|send|push|pull|list|show|print|echo|cat|ls|mkdir|rm|cp|mv)\s+/i.test(
    trimmed
  ))
    return true;
  return false;
}
async function runSynthesizeOnlyShortcut(opts, report, start) {
  if (!opts.synthesizeOnly) return null;
  const log = getLogger();
  log.info({ topic: opts.topic }, "dream: synthesize-only mode");
  const synthReport = await runSynthesize({ dryRun: opts.dryRun, topic: opts.topic });
  log.info(
    { synthesized: synthReport.synthesized.length, skipped: synthReport.skipped.length },
    "dream: synthesize done"
  );
  if (synthReport.errors.length > 0) {
    log.warn({ errors: synthReport.errors }, "dream: synthesize errors");
  }
  return { ...report, duration_ms: Date.now() - start };
}
async function runConversationIngestion(opts, report) {
  const { created, skipped } = await processUnreadConversations(opts);
  return { ...report, conversationsProcessed: created, conversationsSkipped: skipped };
}
function hasNoiseExemptTag(tags) {
  if (!tags) return false;
  const set = new Set(tags.split(/\s+/).filter(Boolean));
  return NOISE_EXEMPT_TAGS.some((t) => set.has(t));
}
async function runNoiseCleanup(opts) {
  const log = getLogger();
  const refreshedNotes = listAll({ includeExpired: false });
  let noiseCount = 0;
  for (let i = 0; i < refreshedNotes.length; i++) {
    const n = refreshedNotes[i];
    if (opts.pretty && i % 50 === 0)
      showProgress(i, refreshedNotes.length, "Checking note quality");
    try {
      const note = readNote(n.path);
      const text = stripNote(note.html).text;
      if ((n.importance ?? 0) >= 0.7 || n.type === "decision") continue;
      if (hasNoiseExemptTag(n.tags)) continue;
      if (!detectNoise(text)) continue;
      if (!opts.dryRun) {
        const invalidated = note.html.replace(
          /data-cerveau-tier="working"/,
          `data-cerveau-tier="working" data-cerveau-valid-until="${nowIso()}" data-cerveau-invalidated-by="dream-noise-cleanup"`
        );
        writeFileSync12(n.path, invalidated, "utf-8");
      }
      noiseCount++;
    } catch {
      log.debug("dream: skipping unreadable note during noise cleanup");
    }
  }
  if (noiseCount > 0) {
    log.info({ invalidatedNotes: noiseCount }, "dream: invalidated noise notes this pass");
  }
  if (opts.pretty) {
    clearProgress();
    if (noiseCount > 0) process.stderr.write(`  Cleaned ${noiseCount} noise notes
`);
  }
  return noiseCount;
}
async function expandOneStub(stub, opts) {
  const log = getLogger();
  const note = readNote(stub.path);
  const text = extractText2(note.html);
  if (text.length < 50) return false;
  const result = await callClaudeCliJsonArray(
    `Summarize this note in one sentence (tldr) and infer a topic path (e.g. "project/feature/module"):

${text.slice(0, 2e3)}`,
    {
      system: 'Output a JSON array with one object: {"tldr": "one sentence summary", "topic": "hierarchical/topic/path"}. No prose.',
      model: "haiku",
      timeoutMs: 15e3
    }
  );
  if (!result?.[0]?.tldr) return false;
  const updated = injectTldr(note.html, result[0].tldr);
  if (!opts.dryRun) writeFileSync12(stub.path, updated, "utf8");
  log.debug({ id: stub.id, tldr: result[0].tldr }, "dream: stub expanded");
  return true;
}
async function runStubExpansion(opts, allNotes, isCliAvailable) {
  const log = getLogger();
  const stubs = allNotes.filter((n) => n.quality === "stub").slice(0, opts.maxNotes ?? 20);
  if (stubs.length === 0) return 0;
  if (opts.pretty) process.stderr.write(`
  Expanding ${stubs.length} stubs

`);
  log.info({ count: stubs.length }, "dream: processing stubs");
  const CIRCUIT_BREAKER = 3;
  let consecutiveFailures = 0;
  let expanded = 0;
  for (let i = 0; i < stubs.length; i++) {
    if (consecutiveFailures >= CIRCUIT_BREAKER) {
      log.warn(
        { failures: consecutiveFailures },
        "dream: enrichment unavailable, skipping stub expansion phase"
      );
      if (opts.pretty) {
        process.stderr.write(
          `
  Warning: enrichment unavailable after ${consecutiveFailures} consecutive failures, skipping stub expansion.
`
        );
      }
      break;
    }
    if (opts.pretty) showProgress(i + 1, stubs.length, "Stub expansion");
    try {
      if (isCliAvailable && !opts.dryRun) {
        const ok = await expandOneStub(stubs[i], opts);
        if (ok) {
          expanded++;
          consecutiveFailures = 0;
        } else consecutiveFailures++;
      }
    } catch (err) {
      consecutiveFailures++;
      log.warn({ id: stubs[i].id, err: err.message }, "dream: stub expansion failed");
    }
  }
  if (opts.pretty) clearProgress();
  return expanded;
}
function resolveEnrichFlag(opts, noTldrCount) {
  if (opts.enrich) return true;
  if (noTldrCount > 0 && noTldrCount <= 200) {
    if (opts.pretty) {
      process.stderr.write(
        `
  Auto-enriching ${noTldrCount} notes with Haiku (~$${(noTldrCount * 25e-5).toFixed(2)})

`
      );
    }
    return true;
  }
  if (noTldrCount > 200 && opts.pretty) {
    process.stderr.write(
      `
  ${noTldrCount} notes need TLDRs. Run with --enrich to process (~$${(noTldrCount * 25e-5).toFixed(2)})
`
    );
  }
  return false;
}
async function generateOneTldr(note, opts) {
  const log = getLogger();
  const content = readNote(note.path);
  const text = extractText2(content.html);
  if (text.length < 50) return false;
  const result = await callClaudeCliJsonArray(
    `Create a one-sentence TLDR for this note:

${text.slice(0, 1500)}`,
    {
      system: 'Output a JSON array with one object: {"tldr": "one sentence summary"}. No prose.',
      model: "haiku",
      timeoutMs: 15e3
    }
  );
  if (!result?.[0]?.tldr) return false;
  if (!opts.dryRun) {
    const updated = injectTldr(content.html, result[0].tldr);
    writeFileSync12(note.path, updated, "utf8");
  }
  log.debug({ id: note.id }, "dream: TLDR generated");
  return true;
}
async function runTldrGeneration(opts, allNotes, isCliAvailable) {
  const log = getLogger();
  const noTldr = allNotes.filter((n) => {
    try {
      return !hasTldr(readNote(n.path).html);
    } catch {
      return false;
    }
  });
  const shouldEnrich = resolveEnrichFlag(opts, noTldr.length);
  if (!shouldEnrich || !isCliAvailable) return 0;
  const toProcess = noTldr.slice(0, opts.maxNotes ?? 200);
  log.info({ count: toProcess.length }, "dream: generating missing TLDRs");
  const CIRCUIT_BREAKER = 3;
  let consecutiveFailures = 0;
  let generated = 0;
  for (let i = 0; i < toProcess.length; i++) {
    if (consecutiveFailures >= CIRCUIT_BREAKER) {
      log.warn(
        { failures: consecutiveFailures },
        "dream: enrichment unavailable, skipping TLDR generation phase"
      );
      if (opts.pretty) {
        process.stderr.write(
          `
  Warning: enrichment unavailable after ${consecutiveFailures} consecutive failures, skipping TLDR generation.
`
        );
      }
      break;
    }
    if (opts.pretty) showProgress(i + 1, toProcess.length, "Enriching with Haiku");
    try {
      const ok = await generateOneTldr(toProcess[i], opts);
      if (ok) {
        generated++;
        consecutiveFailures = 0;
      } else consecutiveFailures++;
    } catch (err) {
      consecutiveFailures++;
      log.warn(
        { id: toProcess[i].id, err: err.message },
        "dream: TLDR generation failed"
      );
    }
  }
  if (opts.pretty) clearProgress();
  return generated;
}
function runContradictionDetection(allNotes, maxNotes) {
  const log = getLogger();
  const decisions = allNotes.filter((n) => n.type === "decision" && !n.valid_until).slice(0, maxNotes);
  if (decisions.length <= 1) return 0;
  const tagGroups = /* @__PURE__ */ new Map();
  for (const d of decisions) {
    const tags = (d.tags ?? "").split(/\s+/).filter(Boolean);
    for (const tag of tags) {
      const group = tagGroups.get(tag) ?? [];
      tagGroups.set(tag, [...group, d]);
    }
  }
  let found = 0;
  for (const [tag, group] of tagGroups) {
    if (group.length > 1) {
      found++;
      log.info({ tag, count: group.length }, "dream: potential contradiction in decisions");
    }
  }
  return found;
}
async function collectEmbeddings(candidates) {
  const textsToEmbed = [];
  const ids = [];
  for (const candidate of candidates) {
    try {
      const content = readNote(candidate.path);
      const text = extractText2(content.html);
      if (text.length >= 100) {
        textsToEmbed.push(text.slice(0, 1e3));
        ids.push(candidate.id);
      }
    } catch {
    }
  }
  if (textsToEmbed.length <= 1) return { ids: [], vectors: [] };
  const embeds = await embed(textsToEmbed);
  if (!embeds || embeds.length === 0) return { ids: [], vectors: [] };
  return { ids, vectors: embeds };
}
async function runDuplicateDetection(allNotes, maxNotes) {
  const log = getLogger();
  if (allNotes.length <= 1) return 0;
  try {
    const candidates = allNotes.slice(0, Math.min(maxNotes * 2, allNotes.length));
    const { ids, vectors } = await collectEmbeddings(candidates);
    if (ids.length <= 1) return 0;
    const duplicates = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const sim = cosineSimilarity(vectors[i], vectors[j]);
        if (sim > 0.85) duplicates.push({ id1: ids[i], id2: ids[j], similarity: sim });
      }
    }
    if (duplicates.length > 0) {
      log.info({ count: duplicates.length }, "dream: found potential duplicates");
    }
    return duplicates.length;
  } catch (err) {
    log.warn({ err: err.message }, "dream: duplicate detection failed");
    return 0;
  }
}
async function runSynthesizePhase(opts) {
  const log = getLogger();
  log.info("dream: phase 5 \u2014 synthesize wiki pages");
  try {
    const synthReport = await runSynthesize({ dryRun: opts.dryRun });
    log.info(
      { synthesized: synthReport.synthesized.length, skipped: synthReport.skipped.length },
      "dream: synthesize done"
    );
    if (synthReport.errors.length > 0)
      log.warn({ errors: synthReport.errors }, "dream: synthesize errors");
    if (opts.pretty) {
      process.stderr.write(`
  Synthesized: ${synthReport.synthesized.length} pages`);
      process.stderr.write(`
  Skipped (fresh): ${synthReport.skipped.length}
`);
      if (synthReport.errors.length > 0)
        process.stderr.write(`  Errors: ${synthReport.errors.join(", ")}
`);
    }
  } catch (err) {
    log.warn({ err: err.message }, "dream: synthesize phase failed");
  }
}
function printPrettyReport(report, allNotes, opts) {
  const w = (s) => process.stderr.write(s);
  w("\n");
  w("  Dream report\n");
  w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  w(`  Conversations read:    ${report.conversationsProcessed}
`);
  w(`  Conversations skipped: ${report.conversationsSkipped} (unchanged, fingerprint match)
`);
  w(`  Notes healed:          ${report.healedNotes} (wrongly invalidated by a past noise-cleanup bug)
`);
  w(`  Noise cleaned:         ${report.noiseCleanedUp}
`);
  w(`  Notes enriched:        ${report.tldrsGenerated}
`);
  w(`  Stubs expanded:        ${report.stubsExpanded}
`);
  w(`  Contradictions found:  ${report.contradictionsFound}
`);
  w(`  Duplicates detected:   ${report.duplicatesMerged}
`);
  w(`  Duration:              ${(report.duration_ms / 1e3).toFixed(1)}s
`);
  w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  const remainingNoTldr = allNotes.filter((n) => {
    try {
      return !hasTldr(readNote(n.path).html);
    } catch {
      return false;
    }
  }).length;
  if (remainingNoTldr > 0 && !opts.enrich) {
    const cost = (remainingNoTldr * 25e-5).toFixed(2);
    w("\n");
    w("  Next steps:\n");
    w(`  ${remainingNoTldr} notes still need TLDRs for better recall.
`);
    w("  Run: lazybrain dream --enrich --pretty\n");
    w(`  Cost: ~$${cost} (Haiku via your Claude subscription)
`);
    w("  This generates 1-sentence summaries and topic paths.\n");
  }
  if (report.contradictionsFound > 0) {
    w(`
  ${report.contradictionsFound} potential contradictions found.
`);
    w(
      `  Run: lazybrain query 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])' --pretty
`
    );
    w("  to review active decisions and resolve conflicts.\n");
  }
  w("\n");
}
function makeEmptyReport() {
  return {
    startedAt: nowIso(),
    duration_ms: 0,
    conversationsProcessed: 0,
    conversationsSkipped: 0,
    healedNotes: 0,
    noiseCleanedUp: 0,
    invalidatedNotes: 0,
    stubsExpanded: 0,
    tldrsGenerated: 0,
    contradictionsFound: 0,
    duplicatesMerged: 0
  };
}
function emitDreamTelemetry(noteCount) {
  logTelemetry({
    event: "compress",
    ts: nowIso(),
    in_count: noteCount,
    out_size_bytes: 0,
    compression_ratio: 0,
    model: "dream"
  });
}
async function runDream(opts) {
  const log = getLogger();
  const start = Date.now();
  const baseReport = makeEmptyReport();
  const maxNotes = opts.maxNotes ?? 20;
  const allNotes = listAll({ includeExpired: false });
  log.info({ total: allNotes.length, maxNotes }, "dream: starting");
  const shortcutResult = await runSynthesizeOnlyShortcut(opts, baseReport, start);
  if (shortcutResult) return shortcutResult;
  const isCliAvailable = await isClaudeCliAvailable();
  const reportAfterIngestion = await runConversationIngestion(opts, baseReport);
  const healReport = healNoiseExemptNotes(NOISE_EXEMPT_TAGS, opts.dryRun === true);
  const noiseCount = await runNoiseCleanup(opts);
  const stubsExpanded = await runStubExpansion(opts, allNotes, isCliAvailable);
  const tldrsGenerated = await runTldrGeneration(opts, allNotes, isCliAvailable);
  const contradictionsFound = runContradictionDetection(allNotes, maxNotes);
  const duplicatesMerged = await runDuplicateDetection(allNotes, maxNotes);
  await runSynthesizePhase(opts);
  const report = {
    ...reportAfterIngestion,
    healedNotes: healReport.healed,
    noiseCleanedUp: noiseCount,
    invalidatedNotes: noiseCount,
    stubsExpanded,
    tldrsGenerated,
    contradictionsFound,
    duplicatesMerged,
    duration_ms: Date.now() - start
  };
  log.info(
    { healedNotes: report.healedNotes, invalidatedNotes: report.invalidatedNotes },
    "dream: maintenance summary"
  );
  emitDreamTelemetry(allNotes.length);
  if (opts.pretty) printPrettyReport(report, allNotes, opts);
  return report;
}
function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}
var DEFAULT_INGESTION_CONCURRENCY, MIN_INGESTION_CONCURRENCY, LOW_MEMORY_THRESHOLD_MB, CRITICAL_MEMORY_THRESHOLD_MB, CRITICAL_BACKOFF_MAX_RETRIES, NOISE_EXEMPT_TAGS;
var init_dream = __esm({
  "src/commands/dream.ts"() {
    "use strict";
    init_heuristic();
    init_embeddings();
    init_fts();
    init_strip();
    init_noise();
    init_paths();
    init_reader();
    init_writer();
    init_claude_cli();
    init_repair();
    init_fingerprints();
    init_logger();
    init_telemetry();
    init_synthesize();
    init_noise();
    init_claude_code();
    DEFAULT_INGESTION_CONCURRENCY = 12;
    MIN_INGESTION_CONCURRENCY = 2;
    LOW_MEMORY_THRESHOLD_MB = 1500;
    CRITICAL_MEMORY_THRESHOLD_MB = 700;
    CRITICAL_BACKOFF_MAX_RETRIES = 5;
    NOISE_EXEMPT_TAGS = ["mission", "agent", "skill"];
  }
});

// src/commands/capture.ts
import {
  existsSync as existsSync17,
  mkdirSync as mkdirSync9,
  readFileSync as readFileSync16,
  readdirSync as readdirSync6,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync13
} from "node:fs";
import { join as join19 } from "node:path";
async function runCapture(opts) {
  if (opts.flushSync) {
    const result2 = await flushQueue(opts);
    await runIncrementalEnrich({ force: true });
    return result2;
  }
  let text;
  if (opts.fromFile) {
    text = readFileSync16(opts.fromFile, "utf8");
  } else {
    text = await readStdin();
  }
  text = text.trim();
  if (!text) {
    return JSON.stringify({ status: "noop", reason: "empty input" });
  }
  if (opts.async) {
    return enqueue(text, opts);
  }
  const result = await processOne(text, opts);
  await runIncrementalEnrich();
  return result;
}
async function processOne(text, opts) {
  const sessionId = opts.session ?? `unknown-${Date.now()}`;
  const start = Date.now();
  const log = getLogger();
  if (isAgentMetaText(text)) {
    log.debug({ session: sessionId }, "capture: skipped \u2014 agent-meta text (denoise gate)");
    logTelemetry({
      event: "capture_skipped",
      ts: nowIso(),
      session: sessionId,
      reason: "agent_meta",
      tokens_in: estimateTokenCount(text)
    });
    return JSON.stringify({ status: "skipped", reason: "agent_meta" });
  }
  const parsed = parseToolPayload(text);
  if (parsed && (parsed.filesModified.length > 0 || parsed.filesRead.length > 0)) {
    recordTouchedFiles(sessionId, [...parsed.filesModified, ...parsed.filesRead]);
  }
  const validationText = synthesizeProse(parsed, text);
  const validation = shouldCapture(validationText);
  if (!validation.ok) {
    logTelemetry({
      event: "capture_skipped",
      ts: nowIso(),
      session: sessionId,
      reason: validation.reason,
      tokens_in: estimateTokenCount(text)
    });
    return JSON.stringify({ status: "skipped", reason: validation.reason });
  }
  const annotated = opts.useLlm ? await annotateWithLlm({ sessionId, text, cwd: opts.cwd }) : annotateSession({
    sessionId,
    text: parsed?.prose && parsed.prose.length > 0 ? parsed.prose : text,
    cwd: opts.cwd,
    tool: parsed?.tool,
    filesModified: parsed?.filesModified,
    filesRead: parsed?.filesRead
  });
  const result = writeNote(annotated.html, { overwrite: true });
  indexNote(readNote(result.path));
  recordCapture(validation.hash);
  let conflicts = 0;
  try {
    const hits = detectContradictions(annotated.html, result.id);
    if (hits.length > 0) {
      conflicts = annotateContradictions(result.path, hits);
      indexNote(readNote(result.path));
    }
  } catch {
  }
  logTelemetry({
    event: "capture",
    ts: nowIso(),
    session: sessionId,
    tokens_in: estimateTokenCount(text),
    tokens_out_html: estimateTokenCount(annotated.html),
    strip_ratio: 0,
    duration_ms: Date.now() - start
  });
  return opts.pretty ? `Captured ${result.id} (${annotated.factCount} facts, tags: ${annotated.tags.join(",")}${conflicts ? `, conflicts: ${conflicts}` : ""})` : JSON.stringify({
    id: result.id,
    facts: annotated.factCount,
    tags: annotated.tags,
    conflicts
  });
}
function enqueue(text, opts) {
  const cfg = getConfig();
  const dir = join19(cfg.cachePath, QUEUE_DIRNAME);
  if (!existsSync17(dir)) mkdirSync9(dir, { recursive: true });
  const file = join19(dir, `${Date.now()}-${(opts.session ?? "na").slice(0, 8)}.txt`);
  const payload = JSON.stringify({ session: opts.session, cwd: opts.cwd, text });
  writeFileSync13(file, payload, "utf8");
  return JSON.stringify({ status: "queued", file });
}
async function flushQueue(opts) {
  const cfg = getConfig();
  const dir = join19(cfg.cachePath, QUEUE_DIRNAME);
  if (!existsSync17(dir)) return JSON.stringify({ status: "noop", flushed: 0 });
  const files = readdirSync6(dir).filter((f) => f.endsWith(".txt")).sort();
  let flushed = 0;
  const errors = [];
  const log = getLogger();
  for (const f of files) {
    const path = join19(dir, f);
    try {
      const raw = readFileSync16(path, "utf8");
      const { session, cwd, text } = JSON.parse(raw);
      await processOne(text, { ...opts, session, cwd, async: false });
      unlinkSync2(path);
      flushed += 1;
    } catch (err) {
      const msg = err.message;
      log.error({ file: f, err: msg }, "flush capture error");
      errors.push(`${f}: ${msg}`);
    }
  }
  return JSON.stringify({ status: "ok", flushed, errors });
}
function readStdin() {
  return new Promise((resolve9) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve9(Buffer.concat(chunks).toString("utf8")));
  });
}
function synthesizeProse(parsed, fallback) {
  if (!parsed) return fallback;
  const parts = [];
  parts.push(`Tool ${parsed.tool}`);
  if (parsed.filesModified.length) parts.push(`modified ${parsed.filesModified.join(", ")}`);
  if (parsed.filesRead.length) parts.push(`read ${parsed.filesRead.join(", ")}`);
  if (parsed.prose) parts.push(parsed.prose);
  const synthetic = parts.join(". ");
  return synthetic.length >= 40 ? synthetic : fallback;
}
var QUEUE_DIRNAME;
var init_capture = __esm({
  "src/commands/capture.ts"() {
    "use strict";
    init_heuristic();
    init_llm();
    init_payload_parser();
    init_validator();
    init_contradictions();
    init_fts();
    init_reader();
    init_writer();
    init_config();
    init_logger();
    init_session_cache();
    init_telemetry();
    init_tokenize();
    init_dream();
    init_enrich();
    QUEUE_DIRNAME = "capture-queue";
  }
});

// src/commands/compress.ts
import { existsSync as existsSync18, mkdirSync as mkdirSync10, readFileSync as readFileSync17, unlinkSync as unlinkSync3, writeFileSync as writeFileSync14 } from "node:fs";
import { join as join20 } from "node:path";
function runCompress(opts) {
  if (opts.purgeNoise) {
    return runPurgeNoise(opts);
  }
  if (opts.purgeSource) {
    return runPurgeSource(opts.purgeSource, opts);
  }
  const notes = readAllNotes();
  const olderThanMs = (opts.olderThanDays ?? 7) * 864e5;
  const cutoff = Date.now() - olderThanMs;
  const candidates = notes.filter((n) => {
    if (n.path.includes("batches")) return false;
    const ageOk = n.mtimeMs < cutoff;
    if (opts.session) {
      return n.html.includes(`session:${opts.session}`) && ageOk;
    }
    return ageOk;
  });
  if (candidates.length === 0) {
    return JSON.stringify({ status: "noop", reason: "no candidates" });
  }
  const stripped = candidates.map((n) => ({ id: n.id, note: stripNote(n.html) }));
  const tags = /* @__PURE__ */ new Set();
  for (const s of stripped) for (const t of s.note.tags) tags.add(t);
  const allFacts = stripped.flatMap((s) => s.note.facts.map((f) => ({ ...f, from: s.id })));
  const keptFacts = [...allFacts].sort((a, b) => b.confidence - a.confidence).slice(0, Math.min(12, Math.ceil(allFacts.length / 3)));
  const batchId = `batch-${nowIso().slice(0, 10)}-${(opts.session ?? "all").slice(0, 8)}`;
  const factsHtml = keptFacts.map(
    (f) => `  <p data-cerveau-fact data-cerveau-confidence="${f.confidence.toFixed(2)}" data-cerveau-source="#${f.from}">${htmlEscape(f.text)}</p>`
  ).join("\n");
  const periodStart = new Date(Math.min(...candidates.map((c) => c.mtimeMs))).toISOString().slice(0, 10);
  const periodEnd = nowIso().slice(0, 10);
  const html = `<memory-batch id="${batchId}"
              data-cerveau-version="${PKG_VERSION}"
              data-cerveau-created="${nowIso()}"
              data-cerveau-type="semantic"
              data-cerveau-source="batch:${batchId}"
              data-cerveau-tier="archival"
              data-cerveau-batch-size="${candidates.length}"
              data-cerveau-batch-period="${periodStart}/${periodEnd}"
              data-cerveau-consolidated-from="${candidates.map((c) => c.id).join(",")}"
              data-cerveau-compression-ratio="${(keptFacts.length / Math.max(1, allFacts.length)).toFixed(2)}"
              data-cerveau-dreamed-at="${nowIso()}"
              data-cerveau-dreamer="heuristic"
              data-cerveau-tags="${[...tags].join(" ")}">
  <h2>Consolidated batch ${batchId}</h2>
  <p data-cerveau-summary>${candidates.length} notes from ${periodStart} to ${periodEnd} \u2192 ${keptFacts.length} salient facts.</p>
${factsHtml}
</memory-batch>`;
  if (opts.dryRun) {
    return JSON.stringify({
      status: "dry-run",
      batch_id: batchId,
      candidates: candidates.length,
      facts_kept: keptFacts.length,
      ratio: keptFacts.length / Math.max(1, allFacts.length),
      html
    });
  }
  const dir = batchesDir();
  if (!existsSync18(dir)) mkdirSync10(dir, { recursive: true });
  const path = join20(dir, `${batchId}.html`);
  writeFileSync14(path, html, "utf8");
  indexNote(readNote(path));
  logTelemetry({
    event: "compress",
    ts: nowIso(),
    session: opts.session,
    in_count: candidates.length,
    out_size_bytes: Buffer.byteLength(html, "utf8"),
    compression_ratio: keptFacts.length / Math.max(1, allFacts.length),
    model: "heuristic"
  });
  return opts.pretty ? `Compressed ${candidates.length} notes \u2192 ${batchId} (${keptFacts.length} facts kept)` : JSON.stringify({
    batch_id: batchId,
    path,
    candidates: candidates.length,
    facts_kept: keptFacts.length
  });
}
function runPurgeNoise(opts) {
  const start = Date.now();
  const notes = readAllNotes();
  const today = nowIso().slice(0, 10);
  const noisy = [];
  for (const note of notes) {
    if (/data-cerveau-valid-until\s*=/.test(note.html)) continue;
    let text;
    try {
      text = stripNote(note.html).text;
    } catch {
      continue;
    }
    if (!text) continue;
    const v = shouldCapture(text);
    if (!v.ok && v.reason !== "duplicate") {
      noisy.push({ id: note.id, path: note.path, reason: v.reason });
    }
  }
  if (opts.dryRun) {
    return JSON.stringify({
      status: "dry-run",
      scanned: notes.length,
      noisy: noisy.length,
      samples: noisy.slice(0, 5)
    });
  }
  let invalidated = 0;
  for (const item of noisy) {
    try {
      const html = readFileSync17(item.path, "utf8");
      const patched = html.replace(
        /(<(?:article|section|memory-batch)\b[^>]*?)(\s*>)/,
        (_match, head, tail) => `${head} data-cerveau-valid-until="${today}" data-cerveau-invalidated-by="purge-noise:${item.reason}"${tail}`
      );
      if (patched !== html) {
        writeFileSync14(item.path, patched, "utf8");
        try {
          indexNote(readNote(item.path));
        } catch {
        }
        invalidated += 1;
      }
    } catch {
    }
  }
  logTelemetry({
    event: "compress",
    ts: nowIso(),
    in_count: invalidated,
    out_size_bytes: 0,
    compression_ratio: notes.length ? invalidated / notes.length : 0,
    model: "purge-noise"
  });
  const payload = {
    status: "ok",
    scanned: notes.length,
    invalidated,
    duration_ms: Date.now() - start
  };
  return opts.pretty ? `Purged ${invalidated}/${notes.length} noisy notes in ${payload.duration_ms}ms` : JSON.stringify(payload);
}
function runPurgeSource(prefix, opts) {
  const start = Date.now();
  const notes = readAllNotes();
  const matches = [];
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`data-cerveau-source="(?:session:)?${escapedPrefix}`);
  for (const n of notes) {
    if (pattern.test(n.html)) matches.push({ id: n.id, path: n.path });
  }
  if (opts.dryRun) {
    return JSON.stringify({
      status: "dry-run",
      prefix,
      candidates: matches.length,
      samples: matches.slice(0, 5).map((m) => m.id)
    });
  }
  let deleted = 0;
  for (const m of matches) {
    try {
      unlinkSync3(m.path);
      deleteNote(m.id);
      deleted += 1;
    } catch {
    }
  }
  const payload = {
    status: "ok",
    prefix,
    scanned: notes.length,
    deleted,
    duration_ms: Date.now() - start
  };
  return opts.pretty ? `Purged ${deleted}/${matches.length} notes matching source prefix "${prefix}" in ${payload.duration_ms}ms` : JSON.stringify(payload);
}
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var init_compress = __esm({
  "src/commands/compress.ts"() {
    "use strict";
    init_validator();
    init_fts();
    init_strip();
    init_paths();
    init_reader();
    init_pkg_version();
    init_telemetry();
  }
});

// src/commands/extract.ts
import { spawn as spawn3 } from "node:child_process";
import { readFileSync as readFileSync18, writeFileSync as writeFileSync15 } from "node:fs";
function openAiModelName() {
  return process.env.LAZYBRAIN_OPENAI_MODEL ?? "devstral";
}
async function runExtract(opts) {
  const start = Date.now();
  const enabled = Boolean(process.env.LAZYBRAIN_EXTRACTOR);
  const backend = resolveExtractorBackend();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!enabled) {
    return JSON.stringify({
      status: "disabled",
      reason: "LAZYBRAIN_EXTRACTOR not set (try LAZYBRAIN_EXTRACTOR=devstral or vibe)"
    });
  }
  if (backend === "anthropic" && !apiKey) {
    return JSON.stringify({
      status: "disabled",
      reason: "backend=anthropic requires ANTHROPIC_API_KEY"
    });
  }
  const batchSize = opts.batchSize ?? 10;
  const pending = selectPending(batchSize);
  if (pending.length === 0) {
    return JSON.stringify({ status: "noop", reason: "nothing to extract" });
  }
  if (opts.dryRun) {
    return JSON.stringify({ status: "dry-run", backend, candidates: pending.map((p) => p.id) });
  }
  let upgraded = 0;
  try {
    const facts = backend === "anthropic" && apiKey ? await callHaikuBatch(pending, apiKey) : backend === "openai" ? await callOpenAiBatch(pending) : backend === "vibe" ? await callVibeBatch(pending) : await callClaudeCli2(pending);
    if (facts.length === 0) {
      return JSON.stringify({ status: "ok", upgraded: 0, processed: pending.length });
    }
    const byNote = /* @__PURE__ */ new Map();
    for (const f of facts) {
      const list = byNote.get(f.for) ?? [];
      list.push(f);
      byNote.set(f.for, list);
    }
    for (const note of pending) {
      const noteFacts = byNote.get(note.id) ?? [];
      if (noteFacts.length === 0) continue;
      try {
        const extractedBy = backend === "openai" ? `llm:${openAiModelName()}` : backend === "vibe" ? "llm:vibe" : "llm:claude-haiku-4-5";
        patchNoteWithFacts(note.path, noteFacts, extractedBy);
        indexNote(readNote(note.path));
        upgraded += 1;
      } catch {
      }
    }
  } catch (err) {
    logTelemetry({
      event: "error",
      ts: nowIso(),
      where: "extract",
      message: err.message
    });
    return JSON.stringify({ status: "error", message: err.message });
  }
  const payload = {
    status: "ok",
    processed: pending.length,
    upgraded,
    duration_ms: Date.now() - start
  };
  return opts.pretty ? `Extracted ${upgraded}/${pending.length} notes (Haiku batch, ${payload.duration_ms}ms)` : JSON.stringify(payload);
}
function selectPending(limit) {
  const all = listAll({ includeExpired: false });
  const out = [];
  for (const n of all) {
    if (n.path.includes("batches")) continue;
    if (out.length >= limit) break;
    try {
      const html = readFileSync18(n.path, "utf8");
      if (/data-cerveau-extracted-by="llm:/.test(html)) continue;
      const stripped = stripNote(html);
      const lowQuality = stripped.facts.length === 0 || stripped.facts.every((f) => f.confidence < 0.6 && f.extractor === "heuristic");
      if (!lowQuality) continue;
      const text = stripped.text || stripped.facts.map((f) => f.text).join("\n");
      if (text.length < 40) continue;
      out.push({ id: n.id, path: n.path, text: text.slice(0, 1200) });
    } catch {
    }
  }
  return out;
}
async function callHaikuBatch(notes, apiKey) {
  const userBlocks = notes.map((n) => `--- note id: ${n.id}
${n.text}`).join("\n\n");
  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT2,
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [
      {
        role: "user",
        content: userBlocks
      }
    ]
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const raw = data.content?.find((b) => b.type === "text")?.text;
  if (!raw) return [];
  let parsed;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }
  logTelemetry({
    event: "capture",
    ts: nowIso(),
    tokens_in: data.usage?.input_tokens ?? 0,
    tokens_out_html: data.usage?.output_tokens ?? 0,
    duration_ms: 0
  });
  return parsed.filter(
    (f) => typeof f.for === "string" && typeof f.text === "string" && f.text.length >= 4
  );
}
async function callOpenAiBatch(notes) {
  const { callOpenAiJsonArray: callOpenAiJsonArray2 } = await Promise.resolve().then(() => (init_openai_client(), openai_client_exports));
  const userBlocks = notes.map((n) => `--- note id: ${n.id}
${n.text}`).join("\n\n");
  const parsed = await callOpenAiJsonArray2(
    `INPUT:
${userBlocks}

Return ONLY the JSON array, no prose.`,
    { system: SYSTEM_PROMPT2, maxTokens: 2048 }
  );
  if (!parsed) return [];
  logTelemetry({
    event: "capture",
    ts: nowIso(),
    tokens_in: Math.ceil(userBlocks.length / 4),
    tokens_out_html: 0,
    duration_ms: 0
  });
  return parsed.filter(
    (f) => typeof f.for === "string" && typeof f.text === "string" && f.text.length >= 4
  );
}
async function callVibeBatch(notes) {
  const { callVibeCliJsonArray: callVibeCliJsonArray2 } = await Promise.resolve().then(() => (init_vibe_cli(), vibe_cli_exports));
  const userBlocks = notes.map((n) => `--- note id: ${n.id}
${n.text}`).join("\n\n");
  const prompt = `INPUT:
${userBlocks}

Return ONLY the JSON array, no prose.`;
  const parsed = await callVibeCliJsonArray2(prompt, {
    system: SYSTEM_PROMPT2,
    timeoutMs: 6e4
  });
  if (!parsed) return [];
  logTelemetry({
    event: "capture",
    ts: nowIso(),
    tokens_in: Math.ceil((SYSTEM_PROMPT2.length + prompt.length) / 4),
    tokens_out_html: 0,
    duration_ms: 0
  });
  return parsed.filter(
    (f) => typeof f.for === "string" && typeof f.text === "string" && f.text.length >= 4
  );
}
async function callClaudeCli2(notes) {
  const userBlocks = notes.map((n) => `--- note id: ${n.id}
${n.text}`).join("\n\n");
  const prompt = `${SYSTEM_PROMPT2}

INPUT:
${userBlocks}

Return ONLY the JSON array, no prose.`;
  const stdout = await runClaudeCli(prompt);
  if (!stdout) return [];
  let textPayload = stdout;
  try {
    const parsed2 = JSON.parse(stdout);
    textPayload = parsed2.result ?? parsed2.content ?? parsed2.text ?? stdout;
  } catch {
  }
  let raw = textPayload.trim();
  raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "");
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  const arrSrc = raw.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(arrSrc);
    if (!Array.isArray(parsed)) return [];
  } catch {
    return [];
  }
  logTelemetry({
    event: "capture",
    ts: nowIso(),
    tokens_in: Math.ceil(prompt.length / 4),
    tokens_out_html: Math.ceil(arrSrc.length / 4),
    duration_ms: 0
  });
  return parsed.filter(
    (f) => typeof f.for === "string" && typeof f.text === "string" && f.text.length >= 4
  );
}
function runClaudeCli(prompt) {
  return new Promise((resolve9, reject) => {
    const cli = process.env.LAZYBRAIN_CLAUDE_BIN ?? "claude";
    const args = [
      "--print",
      "--output-format",
      "json",
      "--model",
      "haiku",
      "--permission-mode",
      "plan"
    ];
    const child = spawn3(cli, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      reject(new Error(`claude CLI spawn failed: ${err.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) resolve9(stdout);
      else reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 200)}`));
    });
    child.stdin.end(prompt);
  });
}
function patchNoteWithFacts(path, facts, extractedBy = "llm:claude-haiku-4-5") {
  const html = readFileSync18(path, "utf8");
  const cleanedFacts = facts.slice(0, 3);
  const factsHtml = cleanedFacts.map((f) => {
    const conf = Math.max(0, Math.min(1, f.confidence ?? 0.7)).toFixed(2);
    return `  <p data-cerveau-fact data-cerveau-confidence="${conf}" data-cerveau-extracted-by="${extractedBy}" data-cerveau-kind="${f.kind}">${escapeHtml(f.text)}</p>`;
  }).join("\n");
  const patched = html.replace(/(<\/(article|section)>\s*)$/, `${factsHtml}
$1`);
  writeFileSync15(path, patched, "utf8");
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var SYSTEM_PROMPT2;
var init_extract = __esm({
  "src/commands/extract.ts"() {
    "use strict";
    init_llm();
    init_fts();
    init_fts();
    init_strip();
    init_reader();
    init_telemetry();
    SYSTEM_PROMPT2 = `You extract atomic facts from short engineering notes for a persistent memory system.

Output ONLY a JSON array. No prose. No code fence. Schema per item:
{"for":"<note-id>","text":"fact in 5-25 words ending with a period","kind":"decision|fact|error|learning","confidence":0.0-1.0}

Rules:
- Up to 3 facts per note. Skip a note entirely when nothing meaningful can be extracted.
- "decision" = explicit choice ("we picked X").
- "error" = problem or root cause.
- "learning" = generalisable insight.
- "fact" = stable claim about the system.
- Each fact MUST stand alone (no "it", "this", "we" without referent).
- Skip code, file paths, command output unless it's a decision or error.`;
  }
});

// src/retrieval/hyde.ts
function cacheGet(key) {
  const e = hydeCache.get(key);
  if (!e) return null;
  if (Date.now() - e.storedAt > HYDE_CACHE_TTL_MS) {
    hydeCache.delete(key);
    return null;
  }
  return e.vector;
}
function cacheSet(key, vector) {
  if (hydeCache.size >= HYDE_CACHE_MAX) {
    const oldest = hydeCache.keys().next().value;
    if (oldest !== void 0) hydeCache.delete(oldest);
  }
  hydeCache.set(key, { vector, storedAt: Date.now() });
}
function hydeCacheStats() {
  return { entries: hydeCache.size, maxEntries: HYDE_CACHE_MAX };
}
async function isHydeEnabled() {
  return llmAvailable("LAZYBRAIN_HYDE");
}
async function shouldAutoHyde(_query) {
  return false;
}
function shouldSkipHyde(query) {
  const q = query.trim();
  if (q.length === 0) return true;
  if (/^[a-z*]+(\[|#|\.|:)/i.test(q) || q.startsWith("[")) return true;
  const wordCount = q.split(/\s+/).filter((w) => w.length > 1).length;
  if (wordCount <= 4) return true;
  if (/^\s*#[a-z0-9-]{4,}/i.test(q)) return true;
  return false;
}
async function embedQueryForRetrieval(query) {
  if (shouldSkipHyde(query)) {
    return embedOne(query);
  }
  const explicitlyEnabled = await isHydeEnabled();
  const autoEnabled = explicitlyEnabled ? false : await shouldAutoHyde(query);
  if (!explicitlyEnabled && !autoEnabled) {
    return embedOne(query);
  }
  const log = getLogger();
  log.debug(
    { query: query.slice(0, 80), trigger: explicitlyEnabled ? "explicit" : "auto" },
    "[HyDE] triggered"
  );
  const cacheKey2 = query.trim().toLowerCase();
  const cached3 = cacheGet(cacheKey2);
  if (cached3) {
    log.debug({ query: query.slice(0, 80) }, "[HyDE] cache hit");
    return cached3;
  }
  const doc = await generateHydeDoc(query);
  if (!doc) {
    log.debug({ query: query.slice(0, 80) }, "[HyDE] generation failed, falling back");
    return embedOne(query);
  }
  log.debug({ query: query.slice(0, 80), docLen: doc.length }, "[HyDE] generated");
  const vec = await embedOne(doc);
  cacheSet(cacheKey2, vec);
  return vec;
}
async function generateHydeDoc(query) {
  const raw = await callClaudeCli(query, {
    system: HYDE_SYSTEM,
    model: "haiku",
    timeoutMs: 12e3
  });
  if (!raw) return null;
  const clean = raw.trim();
  if (clean.length < 20) return null;
  return clean.slice(0, 1500);
}
var HYDE_CACHE_MAX, HYDE_CACHE_TTL_MS, hydeCache, HYDE_SYSTEM;
var init_hyde = __esm({
  "src/retrieval/hyde.ts"() {
    "use strict";
    init_embeddings();
    init_claude_cli();
    init_logger();
    HYDE_CACHE_MAX = 256;
    HYDE_CACHE_TTL_MS = 60 * 6e4;
    hydeCache = /* @__PURE__ */ new Map();
    HYDE_SYSTEM = `You write a short fictional memory note that hypothetically answers the user's search query.
Write 3-5 sentences. Concrete vocabulary: include the named entities, library names, error strings, decisions that a real note on this topic would mention.
Do NOT speculate or invent facts that aren't strongly implied by the query.
Output ONLY the note body. No prose, no preamble, no quotes.`;
  }
});

// src/retrieval/levels/l2.ts
async function runL2(input, topK) {
  const opts = {
    limit: topK,
    includeExpired: input.includeExpired,
    type: input.type,
    tag: input.tag,
    sourcePrefix: input.sourcePrefix
  };
  const tokens = input.query.trim().split(/\s+/).filter(Boolean);
  const ftsHits = tokens.length >= 2 ? searchFtsSpread(input.query, opts) : searchFts(input.query, opts);
  const rawHits = ftsHits.map((h) => {
    const note = getNoteById(h.id);
    return {
      id: h.id,
      path: h.path,
      score: h.bm25,
      level: "L2",
      snippet: stripTags(h.snippet),
      topic: note?.topic ?? null,
      tags: note?.tags ?? null,
      codeFile: note?.source?.startsWith("code-scanner:") ? note.title ?? null : null
    };
  });
  const boosted = applyStructuralFieldBoost(rawHits, input.query);
  return boosted.map(({ topic: _t, tags: _g, codeFile: _c, ...rest }) => rest);
}
var init_l2 = __esm({
  "src/retrieval/levels/l2.ts"() {
    "use strict";
    init_fts();
    init_strip();
  }
});

// src/retrieval/levels/l3.ts
async function runL3(input, topK) {
  if (isEmbedderUnavailable()) {
    getLogger().debug({ query: input.query }, "runL3: embedder unavailable, falling back to L2");
    return runL2(input, topK);
  }
  const queryVec = await embedQueryForRetrieval(input.query);
  const hardInvalidate = process.env.LAZYBRAIN_HARD_INVALIDATE === "1";
  const corpus = listAllWithText({
    includeExpired: input.includeExpired,
    excludeInvalidated: hardInvalidate
  }).filter((n) => {
    if (input.sourcePrefix && !(n.source ?? "").startsWith(input.sourcePrefix)) return false;
    if (input.type && n.type !== input.type) return false;
    if (input.tag && !(n.tags ?? "").includes(input.tag)) return false;
    return true;
  });
  const vectors = await resolveCorpusVectors(corpus);
  const ranked = topKCosine(
    queryVec,
    corpus.map((c, i) => ({ id: c.id, vector: vectors[i] })),
    topK * 2
    // overfetch for potential L4 re-rank
  );
  const byId = new Map(corpus.map((c) => [c.id, c]));
  return ranked.filter((r) => byId.has(r.id)).slice(0, topK).map((r) => {
    const n = byId.get(r.id);
    if (!n) throw new Error("unreachable");
    return {
      id: r.id,
      path: n.path,
      score: r.score,
      level: "L3",
      // B3-friendly: snippet reflects content, not just title — MMR uses it.
      snippet: ((n.text ?? "") || n.title || "").slice(0, 280)
    };
  });
}
var init_l3 = __esm({
  "src/retrieval/levels/l3.ts"() {
    "use strict";
    init_embeddings();
    init_embed_index();
    init_fts();
    init_logger();
    init_hyde();
    init_l2();
    init_embed_index();
  }
});

// src/retrieval/levels/hybrid.ts
async function runL2L3Hybrid(input, topK) {
  if (isEmbedderUnavailable()) {
    getLogger().debug({ query: input.query }, "runL2L3Hybrid: embedder unavailable, using L2 only");
    return runL2(input, topK);
  }
  const opts = {
    limit: topK * 2,
    // Overfetch for fusion
    includeExpired: input.includeExpired,
    type: input.type,
    tag: input.tag,
    sourcePrefix: input.sourcePrefix
  };
  const [l2Hits, l3Hits] = await Promise.all([
    buildL2Hits(input, opts),
    buildL3Hits(input, opts, topK)
  ]);
  return fuseAndBoost(l2Hits, l3Hits, input, topK);
}
async function buildL2Hits(input, opts) {
  const tokens = input.query.trim().split(/\s+/).filter(Boolean);
  const ftsHits = tokens.length >= 2 ? searchFtsSpread(input.query, opts) : searchFts(input.query, opts);
  return ftsHits.map((hit, rank) => ({ hit, rank }));
}
async function buildL3Hits(input, _opts, topK) {
  const queryVec = await embedQueryForRetrieval(input.query);
  const corpus = listAllWithText({ includeExpired: input.includeExpired }).filter((n) => {
    if (input.sourcePrefix && !(n.source ?? "").startsWith(input.sourcePrefix)) return false;
    if (input.type && n.type !== input.type) return false;
    if (input.tag && !(n.tags ?? "").includes(input.tag)) return false;
    return true;
  });
  const vectors = await resolveCorpusVectors(corpus);
  const ranked = topKCosine(
    queryVec,
    corpus.map((c, i) => ({ id: c.id, vector: vectors[i] })),
    topK * 2
  );
  const byId = new Map(corpus.map((c) => [c.id, c]));
  return ranked.filter((r) => byId.has(r.id)).map((r, rank) => {
    const n = byId.get(r.id);
    if (!n) throw new Error("unreachable");
    return {
      hit: {
        id: r.id,
        path: n.path,
        title: n.title ?? "",
        snippet: ((n.text ?? "") || n.title || "").slice(0, 280),
        bm25: r.score
      },
      rank
    };
  });
}
function fuseAndBoost(l2Hits, l3Hits, input, topK) {
  const RRF_K2 = 60;
  const fused = /* @__PURE__ */ new Map();
  const best = /* @__PURE__ */ new Map();
  for (const { hit, rank } of l2Hits) {
    const rrfScore = 1 / (RRF_K2 + rank);
    fused.set(hit.id, (fused.get(hit.id) ?? 0) + rrfScore);
    if (!best.has(hit.id)) {
      best.set(hit.id, { id: hit.id, path: hit.path, snippet: stripTags(hit.snippet) });
    }
  }
  for (const { hit, rank } of l3Hits) {
    const rrfScore = 1 / (RRF_K2 + rank);
    fused.set(hit.id, (fused.get(hit.id) ?? 0) + rrfScore);
    if (!best.has(hit.id)) {
      best.set(hit.id, { id: hit.id, path: hit.path, snippet: hit.snippet });
    }
  }
  const preFused = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  const fusedForBoost = preFused.map(([id, score]) => {
    const hit = best.get(id);
    const note = getNoteById(id);
    return {
      id,
      path: hit.path,
      score,
      level: "L2_L3_HYBRID",
      snippet: hit.snippet,
      topic: note?.topic ?? null,
      tags: note?.tags ?? null,
      codeFile: note?.source?.startsWith("code-scanner:") ? note.title ?? null : null
    };
  });
  const boosted = applyStructuralFieldBoost(fusedForBoost, input.query);
  return boosted.map(({ topic: _t, tags: _g, codeFile: _c, ...rest }) => rest);
}
var init_hybrid = __esm({
  "src/retrieval/levels/hybrid.ts"() {
    "use strict";
    init_embeddings();
    init_fts();
    init_logger();
    init_hyde();
    init_strip();
    init_l2();
    init_l3();
  }
});

// src/indexer/structural.ts
import { parseHTML as parseHTML8 } from "linkedom";
function withTagCaseInsensitivity(selector) {
  return selector.replace(TAGS_CI_ATTR_RE, (match, quote, value, flag) => {
    if (flag) return match;
    return `[data-cerveau-tags~=${quote}${value}${quote} i]`;
  });
}
function extractPushdownFilter(selector) {
  const trimmed = selector.trim();
  if (hasTopLevelComma(trimmed)) return null;
  const typeMatch = trimmed.match(TYPE_PUSHDOWN_RE);
  if (typeMatch) return { kind: "type", value: typeMatch[2] };
  const tagsMatch = trimmed.match(TAGS_PUSHDOWN_RE);
  if (tagsMatch) return { kind: "tag", value: tagsMatch[2] };
  return null;
}
function hasTopLevelComma(selector) {
  const withoutQuotedStrings = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
  return withoutQuotedStrings.includes(",");
}
function checkIndexTrust() {
  try {
    const indexedCount = countAllNotes();
    const indexedSlugs = new Set(listAllNoteIds().map((id) => slug(id)));
    const diskSlugs = distinctNoteIdSlugsCached();
    const missingSlugs = /* @__PURE__ */ new Set();
    for (const s of diskSlugs) {
      if (!indexedSlugs.has(s)) missingSlugs.add(s);
    }
    if (missingSlugs.size === 0) return { trustworthy: true, missingSlugs: /* @__PURE__ */ new Set() };
    if (!untrustworthyWarned) {
      getLogger().warn(
        { indexed: indexedCount, onDisk: diskSlugs.size, missing: missingSlugs.size },
        "lazybrain: SQLite note index does not match notes on disk \u2014 structural queries are falling back to a full scan (slower, but complete) instead of the indexed fast path. Run `lazybrain reindex --missing` to repair."
      );
      untrustworthyWarned = true;
    }
    logTelemetry({
      event: "index_untrustworthy",
      ts: nowIso(),
      indexed_notes: indexedCount,
      disk_notes: diskSlugs.size,
      missing: missingSlugs.size
    });
    return { trustworthy: false, missingSlugs };
  } catch {
    return { trustworthy: false, missingSlugs: null };
  }
}
function candidatePathsForPushdown(filter) {
  const rows = notesByTagOrType({
    type: filter.kind === "type" ? filter.value : void 0,
    tag: filter.kind === "tag" ? filter.value : void 0,
    includeExpired: true,
    // parity with the full scan, which never filters by valid_until
    limit: Number.MAX_SAFE_INTEGER
  });
  return rows.map((r) => r.path);
}
function* lazyReadNotes(paths) {
  for (const path of paths) {
    try {
      yield readNote(path);
    } catch {
      continue;
    }
  }
}
function matchSelectorInNotes(selector, notes, limit, attribute) {
  const out = [];
  const iterator = notes[Symbol.iterator]();
  while (out.length < limit) {
    const next = iterator.next();
    if (next.done) break;
    const note = next.value;
    let document;
    try {
      ({ document } = parseHTML8(`<!doctype html><body>${note.html}</body>`));
    } catch {
      continue;
    }
    let matches;
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    for (const el of matches) {
      if (out.length >= limit) break;
      const fragment = el.outerHTML;
      const text = stripTags(fragment);
      const attr = attribute ? el.getAttribute(attribute) ?? "" : void 0;
      out.push({
        noteId: note.id,
        notePath: note.path,
        fragment,
        text,
        attribute: attr
      });
    }
  }
  return out;
}
function structuralQuery(selector, opts = {}) {
  const normalized = withTagCaseInsensitivity(selector);
  validateSelector(normalized);
  const limit = opts.limit ?? 100;
  const filter = extractPushdownFilter(normalized);
  if (filter) {
    const trust = checkIndexTrust();
    if (trust.trustworthy) {
      const indexedPaths = candidatePathsForPushdown(filter);
      return matchSelectorInNotes(normalized, lazyReadNotes(indexedPaths), limit, opts.attribute);
    }
    if (trust.missingSlugs !== null) {
      const indexedPaths = candidatePathsForPushdown(filter);
      const missingPaths = diskPathsForSlugs(trust.missingSlugs);
      return matchSelectorInNotes(
        normalized,
        lazyReadNotes([...indexedPaths, ...missingPaths]),
        limit,
        opts.attribute
      );
    }
  }
  return matchSelectorInNotes(normalized, readAllNotes(), limit, opts.attribute);
}
function validateSelector(selector) {
  try {
    const { document } = parseHTML8("<!doctype html><body></body>");
    document.querySelectorAll(selector);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid CSS selector: ${selector} \u2014 ${reason}`, { cause: err });
  }
}
var ROOT_TAG, TYPE_PUSHDOWN_RE, TAGS_PUSHDOWN_RE, TAGS_CI_ATTR_RE, untrustworthyWarned;
var init_structural = __esm({
  "src/indexer/structural.ts"() {
    "use strict";
    init_strip();
    init_paths();
    init_logger();
    init_telemetry();
    init_note_read();
    init_reader();
    ROOT_TAG = "(?:article|section|memory-batch)";
    TYPE_PUSHDOWN_RE = new RegExp(`^${ROOT_TAG}?\\[data-cerveau-type\\s*=\\s*(["'])([^"']*)\\1\\]`);
    TAGS_PUSHDOWN_RE = new RegExp(
      `^${ROOT_TAG}?\\[data-cerveau-tags\\s*~=\\s*(["'])([^"']*)\\1(?:\\s+[iIsS])?\\]`
    );
    TAGS_CI_ATTR_RE = /\[data-cerveau-tags\s*~=\s*(["'])([^"']*)\1(\s+[iIsS])?\]/g;
    untrustworthyWarned = false;
  }
});

// src/retrieval/levels/l1.ts
async function runL1(input) {
  const hits = structuralQuery(input.query, { limit: input.topK ?? 5 });
  return hits.map((h) => ({
    id: h.noteId,
    path: h.notePath,
    score: 1,
    level: "L1",
    snippet: h.text.slice(0, 240)
  }));
}
var init_l1 = __esm({
  "src/retrieval/levels/l1.ts"() {
    "use strict";
    init_structural();
  }
});

// src/indexer/reranker.ts
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env as env2
} from "@huggingface/transformers";
function isRerankerCached(modelsPath) {
  return isModelCached(modelsPath, MODEL_ID2);
}
async function getReranker() {
  if (crossEncoder) return crossEncoder;
  if (!pipePromise2) {
    pipePromise2 = loadReranker().catch((err) => {
      pipePromise2 = null;
      throw err;
    });
  }
  return pipePromise2;
}
async function loadReranker() {
  if (isEmbeddingsDisabledByEnv()) {
    throw new Error(
      "Reranker disabled via LAZYBRAIN_EMBEDDINGS=0. Semantic rerank (L4) unavailable."
    );
  }
  const cfg = getConfig();
  env2.localModelPath = cfg.modelsPath;
  env2.cacheDir = cfg.modelsPath;
  const envVal = process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
  const remoteAllowed = envVal === "1";
  const remoteUnset = envVal === void 0 || envVal === "";
  if (remoteUnset && !isRerankerCached(cfg.modelsPath)) {
    throw new Error(
      "Reranker model not in local cache. Run `npm run download-models` or set LAZYBRAIN_ALLOW_REMOTE_MODELS=1."
    );
  }
  env2.allowRemoteModels = remoteAllowed;
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL_ID2),
    AutoModelForSequenceClassification.from_pretrained(MODEL_ID2, { dtype: "q8" })
  ]);
  crossEncoder = { tokenizer, model };
  return crossEncoder;
}
async function scorePairs(ce, query, texts) {
  const tokenize = ce.tokenizer;
  const forward = ce.model;
  const inputs = tokenize(
    texts.map(() => query),
    { text_pair: texts, padding: true, truncation: true }
  );
  const { logits } = await forward(inputs);
  const numLabels = logits.dims[1] ?? 1;
  if (numLabels !== 1) {
    throw new Error(
      `reranker model returned ${numLabels} labels per pair, expected 1 (single relevance logit)`
    );
  }
  const data = logits.data;
  return texts.map((_, i) => Number(data[i]));
}
function hasDistinctTexts(items) {
  if (items.length < 2) return false;
  const first = items[0].text;
  return items.some((c) => c.text !== first);
}
function allScoresIdentical(scores) {
  if (scores.length < 2) return true;
  return scores.every((s) => s === scores[0]);
}
function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function rerankFallback(filtered, topK, reason) {
  if (!fallbackWarned) {
    getLogger().warn(
      { reason },
      "lazybrain: cross-encoder reranker (L4) unavailable \u2014 falling back to identity ranking (L3 order returned unchanged, no semantic rerank applied). Run `npm run download-models` or check LAZYBRAIN_ALLOW_REMOTE_MODELS / LAZYBRAIN_EMBEDDINGS."
    );
    fallbackWarned = true;
  }
  logTelemetry({
    event: "rerank_fallback",
    ts: nowIso(),
    reason,
    candidates: filtered.length
  });
  return filtered.slice(0, topK).map((c, i) => ({ id: c.id, score: 1 - i / filtered.length }));
}
async function rerank(query, candidates, topK) {
  if (candidates.length === 0) return [];
  const safeQuery = typeof query === "string" && query.length > 0 ? query : " ";
  const filtered = candidates.filter((c) => typeof c.text === "string" && c.text.length > 0).map((c) => ({ id: c.id, text: String(c.text) }));
  if (filtered.length === 0) return [];
  let ce;
  try {
    ce = await getReranker();
  } catch (err) {
    return rerankFallback(filtered, topK, getErrorMessage(err));
  }
  let scores;
  try {
    scores = await scorePairs(ce, safeQuery, filtered.map((c) => c.text));
  } catch (err) {
    return rerankFallback(filtered, topK, getErrorMessage(err));
  }
  if (hasDistinctTexts(filtered) && allScoresIdentical(scores)) {
    return rerankFallback(
      filtered,
      topK,
      "reranker returned identical scores for distinct candidates"
    );
  }
  const out = filtered.map((c, i) => ({
    id: c.id,
    score: scores[i] ?? 0
  }));
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, topK);
}
var MODEL_ID2, crossEncoder, pipePromise2, fallbackWarned;
var init_reranker = __esm({
  "src/indexer/reranker.ts"() {
    "use strict";
    init_config();
    init_logger();
    init_telemetry();
    init_embeddings();
    MODEL_ID2 = "Xenova/ms-marco-MiniLM-L-6-v2";
    crossEncoder = null;
    pipePromise2 = null;
    fallbackWarned = false;
  }
});

// src/retrieval/levels/l4.ts
async function runL4(input, topK) {
  const l3 = await runL3({ ...input, topK: 50 }, 50);
  if (l3.length === 0) return l3;
  const candidates = buildRerankCandidates(l3);
  const reranked = await rerank(input.query, candidates, topK);
  const byId = new Map(l3.map((h) => [h.id, h]));
  return reranked.map((r) => {
    const base = byId.get(r.id);
    if (!base) throw new Error("unreachable");
    return { ...base, score: r.score, level: "L4" };
  });
}
function buildRerankCandidates(hits) {
  const candidates = [];
  for (const hit of hits) {
    const n = getNoteById(hit.id);
    if (!n) continue;
    const title = typeof n.title === "string" ? n.title : "";
    const tags = typeof n.tags === "string" ? n.tags : "";
    const body = getNoteText(hit.id).slice(0, RERANK_CHAR_LIMIT);
    const text = [title, tags, body].filter(Boolean).join("\n").trim();
    if (text.length === 0) continue;
    candidates.push({ id: hit.id, text });
  }
  return candidates;
}
var RERANK_CHAR_LIMIT;
var init_l4 = __esm({
  "src/retrieval/levels/l4.ts"() {
    "use strict";
    init_fts();
    init_reranker();
    init_l3();
    RERANK_CHAR_LIMIT = 1500;
  }
});

// src/retrieval/nl-structural.ts
function tryNlToStructural(query, topK, _sourcePrefix) {
  const lower = query.toLowerCase();
  const KNOWN_TAGS = allDistinctTags().filter((t) => !TAG_BLOCKLIST.has(t));
  let matchedType;
  for (const [keyword, type] of Object.entries(TYPE_MAP)) {
    if (lower.includes(keyword)) {
      matchedType = type;
      break;
    }
  }
  const matchedTags = [];
  for (const tag of KNOWN_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(query)) {
      matchedTags.push(tag);
    }
  }
  if (matchedTags.length === 0 && !matchedType) return [];
  const isComplex = /\b(why|how|explain|compare|difference|versus|vs)\b/i.test(lower);
  if (isComplex && !matchedType) return [];
  if (!passesSelectivityGate(query, matchedTags, matchedType)) return [];
  const results = notesByTagOrType({
    tag: matchedTags[0],
    type: matchedType,
    limit: topK * 2,
    includeExpired: false
  });
  if (results.length === 0) return [];
  return scoreAndSlice(results, matchedTags, topK);
}
function passesSelectivityGate(query, matchedTags, matchedType) {
  if (matchedTags.length === 0 || matchedType) return true;
  const meaningfulTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  if (meaningfulTokens.length > STRUCTURAL_MAX_QUERY_TOKENS) return false;
  for (const tag of matchedTags) {
    if (getTagNoteCount(tag) >= STRUCTURAL_TAG_MAX_NOTES) return false;
  }
  return true;
}
function scoreAndSlice(results, matchedTags, topK) {
  const scored = results.map((n) => {
    const noteTags = (n.tags ?? "").toLowerCase();
    let tagScore = 0;
    for (const tag of matchedTags) {
      if (noteTags.includes(tag)) tagScore++;
    }
    return { note: n, tagScore };
  });
  scored.sort((a, b) => {
    if (b.tagScore !== a.tagScore) return b.tagScore - a.tagScore;
    return (b.note.importance ?? 0) - (a.note.importance ?? 0);
  });
  return scored.slice(0, topK).map(({ note }) => ({
    id: note.id,
    path: note.path,
    score: 1,
    level: "L1",
    snippet: (note.title ?? "").slice(0, 280)
  }));
}
var STRUCTURAL_TAG_MAX_NOTES, STRUCTURAL_MAX_QUERY_TOKENS, TYPE_MAP, TAG_BLOCKLIST, STOP_WORDS;
var init_nl_structural = __esm({
  "src/retrieval/nl-structural.ts"() {
    "use strict";
    init_fts();
    STRUCTURAL_TAG_MAX_NOTES = 50;
    STRUCTURAL_MAX_QUERY_TOKENS = 2;
    TYPE_MAP = {
      decision: "decision",
      decisions: "decision",
      d\u00E9cision: "decision",
      d\u00E9cisions: "decision",
      episodic: "episodic",
      reference: "reference",
      r\u00E9f\u00E9rences: "reference",
      procedural: "procedural",
      procedure: "procedural",
      proc\u00E9dure: "procedural"
    };
    TAG_BLOCKLIST = /* @__PURE__ */ new Set(["bug", "test", "fix", "config", "docs", "next"]);
    STOP_WORDS = /* @__PURE__ */ new Set([
      "a",
      "an",
      "and",
      "are",
      "as",
      "at",
      "be",
      "by",
      "for",
      "from",
      "has",
      "he",
      "in",
      "is",
      "it",
      "its",
      "of",
      "on",
      "that",
      "the",
      "to",
      "was",
      "were",
      "will",
      "with",
      "all",
      "my",
      "me",
      "i",
      "we",
      "our",
      "us",
      "show",
      "list",
      "find",
      "get",
      "give",
      "tell",
      "about",
      "notes",
      "tagged"
    ]);
  }
});

// src/graph/pagerank.ts
import { existsSync as existsSync19, mkdirSync as mkdirSync11, readFileSync as readFileSync19, writeFileSync as writeFileSync16 } from "node:fs";
import { join as join21 } from "node:path";
function computePageRank(opts = {}) {
  const alpha = opts.alpha ?? 0.85;
  const maxIters = opts.maxIters ?? 30;
  const tol = opts.tol ?? 1e-4;
  const cacheKey2 = opts.cacheKey ?? "global";
  if (!opts.noCache) {
    const cached3 = loadCached(cacheKey2);
    if (cached3) return cached3;
  }
  const notes = listAllWithText({ includeExpired: false });
  if (notes.length === 0) {
    return {
      scores: {},
      alpha,
      iterations: 0,
      seeded_by: cacheKey2,
      generated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  const ids = notes.map((n2) => n2.id);
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const backlinks = loadBacklinks();
  const outDeg = new Array(n).fill(0);
  const outList = Array.from({ length: n }, () => []);
  if (backlinks) {
    for (const edges of Object.values(backlinks.outgoing ?? {})) {
      for (const e of edges) {
        const a = idx.get(e.from);
        const b = idx.get(e.to);
        if (a === void 0 || b === void 0) continue;
        outList[a].push(b);
        outDeg[a] += 1;
      }
    }
  }
  const seedsRaw = opts.seeds ?? ids;
  const seedIdx = seedsRaw.map((id) => idx.get(id)).filter((i) => i !== void 0);
  const personalization = new Array(n).fill(0);
  const seedWeight = 1 / Math.max(1, seedIdx.length);
  for (const i of seedIdx) personalization[i] += seedWeight;
  let r = new Array(n).fill(1 / n);
  let iterations = 0;
  for (let it = 0; it < maxIters; it++) {
    iterations += 1;
    const rNext = new Array(n).fill(0);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outDeg[i] === 0) {
        danglingMass += r[i];
      } else {
        const share = r[i] / outDeg[i];
        for (const j of outList[i]) rNext[j] += share;
      }
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const teleport = (1 - alpha) * personalization[i] + alpha * (danglingMass * personalization[i]);
      rNext[i] = teleport + alpha * rNext[i];
      delta += Math.abs(rNext[i] - r[i]);
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rNext[i];
    if (sum > 0) {
      for (let i = 0; i < n; i++) rNext[i] /= sum;
    }
    r = rNext;
    if (delta < tol) break;
  }
  const scores = {};
  for (let i = 0; i < n; i++) scores[ids[i]] = r[i];
  const result = {
    scores,
    alpha,
    iterations,
    seeded_by: cacheKey2,
    generated: (/* @__PURE__ */ new Date()).toISOString()
  };
  saveCached(cacheKey2, result);
  return result;
}
function buildCwdIndex() {
  const map = /* @__PURE__ */ new Map();
  for (const note of readAllNotes()) {
    const m = note.html.match(/data-cerveau-cwd\s*=\s*"([^"]+)"/);
    if (m) map.set(note.id, m[1]);
  }
  return map;
}
function notesForCwd(cwd) {
  if (!cwd) return [];
  const normalized = cwd.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  if (!normalized) return [];
  const cwdIndex = cwdIndexCache.resolve(getDb(), "notes", "cwd-index", buildCwdIndex);
  const ids = [];
  for (const [id, rawCwd] of cwdIndex) {
    const candidate = rawCwd.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    if (candidate === normalized || normalized.startsWith(`${candidate}/`) || candidate.startsWith(`${normalized}/`)) {
      ids.push(id);
    }
  }
  return ids;
}
function recentNotes(notes, days) {
  const cutoff = Date.now() - days * 864e5;
  return notes.filter((n) => {
    if (!n.created) return false;
    const t = new Date(n.created).getTime();
    return Number.isFinite(t) && t >= cutoff;
  }).map((n) => n.id);
}
function cachePath2(key) {
  const cfg = getConfig();
  if (!existsSync19(cfg.cachePath)) mkdirSync11(cfg.cachePath, { recursive: true });
  const safeKey = key.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "global";
  return join21(cfg.cachePath, `${CACHE_FILENAME.replace(".json", "")}-${safeKey}.json`);
}
function loadCached(key) {
  const path = cachePath2(key);
  if (!existsSync19(path)) return null;
  try {
    const data = JSON.parse(readFileSync19(path, "utf8"));
    if (Date.now() - new Date(data.generated).getTime() > 6 * 36e5) return null;
    return data;
  } catch {
    return null;
  }
}
function saveCached(key, result) {
  writeFileSync16(cachePath2(key), JSON.stringify(result, null, 2), "utf8");
}
var CACHE_FILENAME, cwdIndexCache;
var init_pagerank = __esm({
  "src/graph/pagerank.ts"() {
    "use strict";
    init_corpus_cache();
    init_fts();
    init_reader();
    init_config();
    init_backlinks();
    CACHE_FILENAME = "pagerank.json";
    cwdIndexCache = new SnapshotCache();
  }
});

// src/retrieval/mmr.ts
function mmr(candidates, k, lambda = 0.7) {
  if (candidates.length === 0) return [];
  const selected = [];
  const pool = [...candidates];
  pool.sort((a, b) => b.relevance - a.relevance);
  const first = pool.shift();
  if (!first) return [];
  selected.push(first);
  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = cosine(c.vector, s.vector);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * c.relevance - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return selected.map((s) => s.id);
}
var init_mmr = __esm({
  "src/retrieval/mmr.ts"() {
    "use strict";
    init_embeddings();
  }
});

// src/retrieval/rankers.ts
function applyNoisePenalty(hits) {
  let penalized = 0;
  const adjusted = hits.map((h) => {
    const text = getNoteText(h.id);
    const row = getNoteById(h.id);
    const isBuildNoise = isBuildOutputNoise(text);
    const isMetaNoise = isAgentMetaText(text);
    const isShellDump = isShellDiagnosticDump(text);
    const isEpisodicShortLowImportance = row?.type === "episodic" && countAlphanumericWords(text) < 12 && (row.importance == null || row.importance < 0.2);
    if (isBuildNoise || isMetaNoise || isShellDump || isEpisodicShortLowImportance) {
      penalized++;
      return { ...h, score: h.score * NOISE_PENALTY_FACTOR };
    }
    return { ...h };
  });
  if (penalized > 0) {
    logTelemetry({ event: "rerank_noise_penalty", ts: nowIso(), penalized });
  }
  return [...adjusted].sort((a, b) => b.score - a.score);
}
function applyPageRank(hits, cwd, weight, entityKeys = []) {
  const all = listAllWithText({ includeExpired: false });
  const cwdSeeds = notesForCwd(cwd);
  const recent = recentNotes(all, 7);
  const entitySeeds = buildEntitySeeds(entityKeys);
  const seeds = [.../* @__PURE__ */ new Set([...cwdSeeds, ...recent, ...entitySeeds, ...hits.map((h) => h.id)])];
  const entitySig = entityKeys.length ? `:ent:${[...entityKeys].sort().join(",")}` : "";
  const cacheKey2 = `${cwd ? `cwd:${cwd}` : "recent"}${entitySig}`;
  const pr = computePageRank({ seeds, cacheKey: cacheKey2 });
  if (!pr.scores || Object.keys(pr.scores).length === 0) return hits;
  const max = Math.max(...hits.map((h) => h.score), 1e-9);
  const min = Math.min(...hits.map((h) => h.score), 0);
  const range = Math.max(1e-9, max - min);
  return hits.map((h) => {
    const base = (h.score - min) / range;
    const prScore = pr.scores[h.id] ?? 0;
    return { ...h, score: base * (1 - weight) + prScore * weight };
  }).sort((a, b) => b.score - a.score);
}
function buildEntitySeeds(entityKeys) {
  if (entityKeys.length === 0) return [];
  const seeds = [];
  for (const key of entityKeys) {
    for (const n of notesMentioningEntity(key, 8)) seeds.push(n.id);
  }
  return seeds;
}
function applyInvalidationPenalty(hits, log) {
  const hardInvalidate = process.env.LAZYBRAIN_HARD_INVALIDATE === "1";
  let penalized = 0;
  let boosted = 0;
  const adjusted = hits.flatMap((h) => {
    const row = getNoteById(h.id);
    if (!row) return [h];
    const isInvalidated2 = !!(row.valid_until && row.valid_until.trim().length > 0);
    const isReplacement = !!(row.replaces && row.replaces.trim().length > 0) && !isInvalidated2;
    if (isInvalidated2) {
      if (hardInvalidate) {
        penalized++;
        return [];
      }
      penalized++;
      return [{ ...h, score: h.score * 0.15 }];
    }
    if (isReplacement) {
      boosted++;
      return [{ ...h, score: h.score * 1.4 }];
    }
    return [h];
  });
  if (penalized > 0 || boosted > 0) {
    logTelemetry({
      event: "rerank_invalidation",
      ts: nowIso(),
      penalized,
      boosted,
      hard: hardInvalidate
    });
    log.debug({ penalized, boosted, hard: hardInvalidate }, "rerank_invalidation");
  }
  return [...adjusted].sort((a, b) => b.score - a.score);
}
function dropObviousSuperseded(hits) {
  const replacedNoteIds = /* @__PURE__ */ new Set();
  for (const h of hits) {
    const row = getNoteById(h.id);
    if (!row) continue;
    if (row.replaces && row.replaces.trim().length > 0) {
      replacedNoteIds.add(row.replaces);
    }
  }
  return hits.filter((h) => {
    const row = getNoteById(h.id);
    if (!row) return true;
    const isExpired = !!(row.valid_until && row.valid_until.trim().length > 0);
    const isSuperseded = replacedNoteIds.has(h.id);
    return !isExpired && !isSuperseded;
  });
}
function applyTemporalEarlierBoost(hits) {
  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    const text = getNoteText(h.id).toLowerCase();
    const failed = /\b(failed|error|401|assertionerror|exception)\b/i.test(text);
    const created = row?.created ? new Date(row.created).getTime() : Date.now();
    let score = h.score;
    if (failed) score *= 1.6;
    return { ...h, score, _ts: created };
  });
  return [...adjusted].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
    return a._ts - b._ts;
  });
}
function applyCurrentVersionBoost(hits) {
  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row) return h;
    let score = h.score;
    const isReplacement = !!row.replaces?.trim() && !row.valid_until;
    if (isReplacement) {
      score *= 1.6;
    }
    const isExpired = !!row.valid_until?.trim();
    if (isExpired) {
      score *= 0.5;
    }
    return { ...h, score };
  });
  return [...adjusted].sort((a, b) => b.score - a.score);
}
function applyWarningBoost(hits, query) {
  const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row?.warnings) return h;
    const warningText = row.warnings.toLowerCase();
    const hasMatch = queryTokens.some((token) => warningText.includes(token));
    if (hasMatch) {
      return { ...h, score: h.score * 1.8 };
    }
    return h;
  });
  return [...adjusted].sort((a, b) => b.score - a.score);
}
async function applyMmr(hits, query, k, lambda) {
  const queryVec = await embedOne(query);
  const texts = hits.map((h) => h.snippet ?? "");
  const vectors = await embed(texts);
  const inputs = hits.map((h, i) => ({
    id: h.id,
    vector: vectors[i],
    relevance: h.score
  }));
  void queryVec;
  const order = mmr(inputs, k, lambda);
  const byId = new Map(hits.map((h) => [h.id, h]));
  return order.map((id) => byId.get(id)).filter((h) => Boolean(h));
}
var NOISE_PENALTY_FACTOR;
var init_rankers = __esm({
  "src/retrieval/rankers.ts"() {
    "use strict";
    init_pagerank();
    init_embeddings();
    init_fts();
    init_noise();
    init_telemetry();
    init_mmr();
    NOISE_PENALTY_FACTOR = 0.25;
  }
});

// src/retrieval/nl-routes.ts
function withSourceScope(hits, sourcePrefix) {
  if (!sourcePrefix) return hits;
  return hits.filter((h) => (getNoteById(h.id)?.source ?? "").startsWith(sourcePrefix));
}
function logRouteEvent(level, latency_ms, results, skipTelemetry) {
  if (skipTelemetry) return;
  logTelemetry({
    event: "query",
    ts: nowIso(),
    level,
    latency_ms,
    results
  });
}
async function routeCwdScope(input, topK, start) {
  if (!input.sourcePrefix) return null;
  const scoped = listAllWithText({ includeExpired: false }).filter(
    (n) => (n.source ?? "").startsWith(input.sourcePrefix)
  );
  if (scoped.length === 0 || scoped.length > Math.max(topK, 8)) return null;
  const ftsOrder = searchFts(input.query, {
    limit: scoped.length + 4,
    sourcePrefix: input.sourcePrefix
  });
  const scoreById = new Map(ftsOrder.map((h, i) => [h.id, ftsOrder.length - i]));
  const sorted = [...scoped].sort(
    (a, b) => (scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0)
  );
  const scopedHits = sorted.map((n) => ({
    id: n.id,
    path: n.path,
    score: scoreById.get(n.id) ?? 0.5,
    level: "L2",
    snippet: (n.text ?? "").slice(0, 280)
  }));
  const totalMs = Date.now() - start;
  logRouteEvent("L2", totalMs, scopedHits.length, input.skipTelemetry);
  if (input.hydrateNote) {
    for (const h of scopedHits) {
      try {
        h.note = stripNote(readNote(h.path).html);
      } catch {
      }
    }
  }
  let finalScoped = scopedHits;
  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    finalScoped = applyCurrentVersionBoost(finalScoped);
    finalScoped = dropObviousSuperseded(finalScoped);
  }
  return { hits: finalScoped, levelUsed: "L2", totalMs };
}
function routePathPrefix(input, topK, start) {
  const pathPrefixes = extractPathPrefixesFromQuery(input.query);
  if (pathPrefixes.length === 0) return null;
  const seen = /* @__PURE__ */ new Set();
  const pathHits = [];
  for (const prefix of pathPrefixes) {
    for (const n of notesMatchingPathPrefix(prefix, topK * 2, input.sourcePrefix)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      pathHits.push({
        id: n.id,
        path: n.path,
        score: 1,
        level: "L1",
        snippet: (n.section_summary ?? n.text ?? "").slice(0, 280)
      });
    }
  }
  if (pathHits.length === 0) return null;
  const totalMs = Date.now() - start;
  logRouteEvent("L1", totalMs, pathHits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(pathHits, input.sourcePrefix).slice(0, topK),
    levelUsed: "L1",
    totalMs
  };
}
function routeNegativeMemory(input, topK, start) {
  if (!/^(?:should|can|could|would)\s/i.test(input.query.trim())) return null;
  let negHits = notesWithWarningsOrNegative(input.query, topK * 2, input.sourcePrefix);
  if (negHits.length === 0 && input.sourcePrefix) {
    negHits = listAllWithText({ includeExpired: false }).filter((n) => (n.source ?? "").startsWith(input.sourcePrefix)).slice(0, topK * 2);
  }
  if (negHits.length === 0) return null;
  const hits = negHits.map((n) => ({
    id: n.id,
    path: n.path,
    score: 1,
    level: "L1",
    snippet: (n.warnings ?? n.text ?? "").slice(0, 280)
  }));
  const totalMs = Date.now() - start;
  logRouteEvent("L1", totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: "L1",
    totalMs
  };
}
function routeErrorPattern(input, topK, start) {
  const isError = /^(?:fix:|error:|how to fix)/i.test(input.query) || /\bhow (?:do i|to) fix\b/i.test(input.query) || /TraceError|Exception|FAILED|Traceback|OperationalError|TypeError|ERESOLVE|deadlock|CORS/i.test(
    input.query
  );
  if (!isError) return null;
  const errHits = notesForErrorPattern(input.query, topK, input.sourcePrefix);
  if (errHits.length === 0) return null;
  const hits = errHits.map((n) => ({
    id: n.id,
    path: n.path,
    score: 1,
    level: "L1",
    snippet: (n.section_summary ?? n.text ?? "").slice(0, 240)
  }));
  const totalMs = Date.now() - start;
  logRouteEvent("L1", totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: "L1",
    totalMs
  };
}
function routeWhyFixture(input, topK, start) {
  if (!/^why\s/i.test(input.query) || !input.sourcePrefix) return null;
  const ftsHits = searchFts(input.query, { limit: topK, sourcePrefix: input.sourcePrefix });
  if (ftsHits.length === 0) return null;
  const hits = ftsHits.map((h) => ({
    id: h.id,
    path: h.path,
    score: h.bm25,
    level: "L2",
    snippet: stripTags(h.snippet)
  }));
  const totalMs = Date.now() - start;
  logRouteEvent("L2", totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: "L2",
    totalMs
  };
}
function routeQuestionPattern(input, topK, start) {
  if (!/^(why|how|what|when|should|can|is)\s/i.test(input.query)) return null;
  const qHits = notesAnsweringQuestion(input.query, topK, input.sourcePrefix);
  if (qHits.length === 0) return null;
  const hits = qHits.map((n) => ({
    id: n.id,
    path: n.path,
    score: 1,
    level: "L1",
    snippet: (n.section_summary ?? n.text ?? "").slice(0, 240)
  }));
  const totalMs = Date.now() - start;
  logRouteEvent("L1", totalMs, hits.length, input.skipTelemetry);
  return {
    hits: withSourceScope(hits, input.sourcePrefix).slice(0, topK),
    levelUsed: "L1",
    totalMs
  };
}
function routeNlStructural(input, topK, start) {
  const nlStructural = tryNlToStructural(input.query, topK, input.sourcePrefix);
  if (nlStructural.length === 0) return null;
  const totalMs = Date.now() - start;
  logRouteEvent("L1", totalMs, nlStructural.length, input.skipTelemetry);
  return {
    hits: withSourceScope(nlStructural, input.sourcePrefix).slice(0, topK),
    levelUsed: "L1",
    totalMs
  };
}
function extractPathPrefixesFromQuery(query) {
  const found = /* @__PURE__ */ new Set();
  for (const m of query.matchAll(
    /(?:^|[\s'"(),])([\w.-]+(?:\/[\w.-]+)+\/?|[\w.-]+\.(?:ts|tsx|js|jsx|py|sql|md|json|html|toml|yaml|yml))(?=[\s'"(),.?]|$)/gi
  )) {
    const p = m[1].replace(/\\/g, "/");
    if (p.length >= 4) found.add(p);
  }
  for (const m of query.matchAll(
    /(?:the\s+)?((?:src|tests|apps|docs|migrations)\/[\w./-]+\/?)/gi
  )) {
    found.add(m[1].replace(/\\/g, "/"));
  }
  return [...found];
}
var init_nl_routes = __esm({
  "src/retrieval/nl-routes.ts"() {
    "use strict";
    init_fts();
    init_fts();
    init_fts();
    init_reader();
    init_telemetry();
    init_nl_structural();
    init_rankers();
    init_strip();
  }
});

// src/retrieval/recency.ts
function referenceTimeMs(row) {
  const ta = parseIso(row.last_accessed);
  const tb = parseIso(row.created);
  return Math.max(ta, tb);
}
function parseIso(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}
function applyGradedRecencyBoost(hits, nowMs) {
  const rescored = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row) return h;
    const refMs = referenceTimeMs(row);
    if (refMs <= 0) return h;
    const ageDays = Math.max(0, (nowMs - refMs) / DAY_MS);
    const multiplier = 1 + RECENCY_BOOST_MAX * Math.exp(-ageDays / RECENCY_TAU);
    return { ...h, score: h.score * multiplier };
  });
  return [...rescored].sort((a, b) => b.score - a.score);
}
var RECENCY_BOOST_MAX, RECENCY_TAU, DAY_MS;
var init_recency = __esm({
  "src/retrieval/recency.ts"() {
    "use strict";
    init_fts();
    RECENCY_BOOST_MAX = 0.2;
    RECENCY_TAU = 30;
    DAY_MS = 864e5;
  }
});

// src/retrieval/router.ts
async function dispatchSemanticWithSoftTimeout(input, topK, finalLevel) {
  const levelPromise = finalLevel === "L2_L3_HYBRID" ? runL2L3Hybrid(input, topK) : finalLevel === "L3" ? runL3(input, topK) : runL4(input, topK);
  levelPromise.catch(() => {
  });
  const TIMEOUT = Symbol("semantic-soft-timeout");
  let timer;
  const timeoutPromise = new Promise((resolve9) => {
    timer = setTimeout(() => resolve9(TIMEOUT), SEMANTIC_SOFT_BUDGET_MS);
  });
  try {
    const raced = await Promise.race([levelPromise, timeoutPromise]);
    if (raced !== TIMEOUT) {
      return { hits: raced };
    }
  } finally {
    clearTimeout(timer);
  }
  getLogger().warn(
    { query: input.query, finalLevel, timeoutMs: SEMANTIC_SOFT_BUDGET_MS },
    "route(): semantic dispatch exceeded soft budget \u2014 degrading to keyword-only (L2) results instead of waiting out the full external timeout"
  );
  const hits = await runL2(input, topK);
  return { hits, degraded: { fromLevel: finalLevel, timeoutMs: SEMANTIC_SOFT_BUDGET_MS } };
}
async function dispatchLevel(input, topK, finalLevel) {
  if (finalLevel === "L1") return { hits: await runL1(input) };
  if (finalLevel === "L2") return { hits: await runL2(input, topK) };
  return dispatchSemanticWithSoftTimeout(input, topK, finalLevel);
}
function expandEntityGraph(hits, query, topK, finalLevel) {
  const entityKeys = resolveEntityKeysInQuery(query);
  if (entityKeys.length === 0) return { hits, entityKeys };
  const haveIds = new Set(hits.map((h) => h.id));
  const expanded = [...hits];
  for (const key of entityKeys) {
    for (const n of notesMentioningEntity(key, 5)) {
      if (haveIds.has(n.id)) continue;
      expanded.push({
        id: n.id,
        path: n.path,
        score: 0.6,
        level: finalLevel,
        snippet: (n.text ?? "").slice(0, 240)
      });
      haveIds.add(n.id);
      if (expanded.length >= topK * 3) break;
    }
    if (expanded.length >= topK * 3) break;
  }
  return {
    hits: [...expanded].sort((a, b) => b.score - a.score),
    entityKeys
  };
}
async function applyReranking(hits, input, topK, finalLevel, entityKeys) {
  const log = getLogger();
  let ranked = applyInvalidationPenalty(hits, log);
  ranked = applyNoisePenalty(ranked);
  ranked = applyWarningBoost(ranked, input.query);
  ranked = applyGradedRecencyBoost(ranked, Date.now());
  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    ranked = applyCurrentVersionBoost(ranked);
  }
  if (/\b(originally|previously|at first|initially)\b/i.test(input.query)) {
    ranked = applyTemporalEarlierBoost(ranked);
  }
  ranked = withSourceScope(ranked, input.sourcePrefix);
  if (/\b(current|now|today|latest)\b/i.test(input.query)) {
    ranked = dropObviousSuperseded(ranked);
  }
  if ((finalLevel === "L3" || finalLevel === "L4") && ranked.length > 1) {
    const weight = input.pageRankWeight ?? 0.25;
    if (weight > 0) {
      ranked = applyPageRank(ranked, input.cwd, weight, entityKeys);
    }
  }
  if (input.diversityLambda !== void 0 && ranked.length > topK) {
    ranked = await applyMmr(ranked, input.query, topK, input.diversityLambda);
  } else if (ranked.length > topK) {
    ranked = ranked.slice(0, topK);
  }
  return ranked;
}
function hydrateHits(hits) {
  const backlinks = loadBacklinks();
  for (const h of hits) {
    if (!h.note) {
      try {
        const note = readNote(h.path);
        h.note = stripNote(note.html);
        h.rawHtml = note.html;
      } catch {
      }
    }
    if (backlinks) {
      const inbound = backlinks.incoming[h.id] ?? [];
      const outbound = backlinks.outgoing[h.id] ?? [];
      h.neighbours = [
        ...outbound.slice(0, 5).map((e) => ({ id: e.to, type: e.type, direction: "out" })),
        ...inbound.slice(0, 5).map((e) => ({ id: e.from, type: e.type, direction: "in" }))
      ];
    }
  }
}
async function route(input) {
  const start = Date.now();
  const topK = input.topK ?? 5;
  const level = input.level ?? "auto";
  const finalLevel = level === "auto" ? pickLevel(input.query, topK) : level;
  getLogger().debug({ query: input.query, level: finalLevel, topK }, "route");
  const cwdResult = await routeCwdScope(input, topK, start);
  if (cwdResult) return cwdResult;
  const pathResult = routePathPrefix(input, topK, start);
  if (pathResult) return pathResult;
  const negResult = routeNegativeMemory(input, topK, start);
  if (negResult) return negResult;
  const errResult = routeErrorPattern(input, topK, start);
  if (errResult) return errResult;
  const whyResult = routeWhyFixture(input, topK, start);
  if (whyResult) return whyResult;
  const qResult = routeQuestionPattern(input, topK, start);
  if (qResult) return qResult;
  const nlResult = routeNlStructural(input, topK, start);
  if (nlResult) return nlResult;
  const dispatchResult = await dispatchLevel(input, topK, finalLevel);
  const effectiveLevel = dispatchResult.degraded ? "L2" : finalLevel;
  const rawHits = dispatchResult.hits;
  const { hits: expandedHits, entityKeys } = expandEntityGraph(
    rawHits,
    input.query,
    topK,
    effectiveLevel
  );
  const rankedHits = await applyReranking(expandedHits, input, topK, effectiveLevel, entityKeys);
  if (rankedHits.length > 0) recordAccessMany(rankedHits.map((h) => h.id));
  if (input.hydrateNote) hydrateHits(rankedHits);
  const totalMs = Date.now() - start;
  if (!input.skipTelemetry) {
    logTelemetry({
      event: "query",
      ts: nowIso(),
      level: effectiveLevel,
      latency_ms: totalMs,
      results: rankedHits.length
    });
  }
  return {
    hits: rankedHits,
    levelUsed: effectiveLevel,
    totalMs,
    ...dispatchResult.degraded ? { degraded: dispatchResult.degraded } : {}
  };
}
function pickLevel(query, topK) {
  const trimmed = query.trim();
  if (/^[a-z*]+(\[|#|\.|:)/i.test(trimmed) || trimmed.startsWith("[")) return "L1";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const hasPhrase = /["']/.test(trimmed);
  if (tokens.length <= 2 && !hasPhrase) return "L2";
  if (tokens.length >= 3 && tokens.length <= 15) return "L2_L3_HYBRID";
  if (topK <= 5) return "L3";
  return "L4";
}
var SEMANTIC_SOFT_BUDGET_MS;
var init_router = __esm({
  "src/retrieval/router.ts"() {
    "use strict";
    init_entities();
    init_backlinks();
    init_fts();
    init_reader();
    init_logger();
    init_telemetry();
    init_hybrid();
    init_l1();
    init_l2();
    init_l3();
    init_l4();
    init_nl_routes();
    init_rankers();
    init_recency();
    init_strip();
    SEMANTIC_SOFT_BUDGET_MS = 8e3;
  }
});

// src/commands/inject-context/markers.ts
function shortId(id) {
  const slug2 = id.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  if (slug2.length < 32) return slug2;
  const sliced = slug2.slice(0, 32);
  const trimmed = sliced.replace(/-[^-]*$/, "");
  if (!trimmed) return sliced;
  return trimmed;
}
function warningPassesGate(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^\d{1,2}:\d{2}\.?$/.test(trimmed)) return false;
  if (trimmed.startsWith("===") || trimmed.startsWith("---")) return false;
  const wordCount = (trimmed.match(/\b[a-zA-Z0-9]{2,}\b/g) ?? []).length;
  return wordCount >= 4;
}
function parseNudgeStyle(raw) {
  return raw === "tool" || raw === "none" || raw === "skill" ? raw : DEFAULT_NUDGE_STYLE;
}
function markerNudge(style) {
  if (style === "none") return "";
  if (style === "tool") {
    return " Use brain_query_css (or brain_query for a fuzzy search) before answering questions about prior work.";
  }
  return " INVOKE the lazybrain-recall skill (Skill tool) before answering questions about prior work. CLI fallback: `lazybrain search <query>` / `lazybrain query #<id>`.";
}
function highlightsRecallNudge(style) {
  if (style === "none") return "";
  if (style === "tool") {
    return '\n[RECALL] For any question about prior work or "how is X built": prefer brain_query_css with a data-cerveau-type/data-cerveau-tags~= selector drawn from the [TAGS] vocabulary above \u2014 exact and cheap. Use brain_query for a fuzzy topic search only when nothing above fits. Do not re-query what is already injected in this context.';
  }
  return '\n[RECALL] For any question about prior work or "how is X built": INVOKE the lazybrain-recall skill (Skill tool) before answering. CLI fallback: `lazybrain search "<topic>" --top 5`';
}
function turnRecallHeader(style) {
  if (style === "none") return "";
  if (style === "tool") {
    return "[LAZYBRAIN] Memory hits below \u2014 for deeper context, use the brain_search tool (or emit BRAIN_SEARCH: <query>).";
  }
  return "[LAZYBRAIN] Memory hits below \u2014 for deeper context invoke the lazybrain-recall skill.";
}
var DEFAULT_NUDGE_STYLE;
var init_markers = __esm({
  "src/commands/inject-context/markers.ts"() {
    "use strict";
    DEFAULT_NUDGE_STYLE = "skill";
  }
});

// src/commands/inject-context/scoring.ts
function queryLooksLikeCodeSymbol(text) {
  const token = text.trim();
  if (!token) return false;
  if (/[\\/]/.test(token) && /\.\w{1,8}$/.test(token)) return true;
  if (/[A-Z][a-z]+[A-Z]/.test(token)) return true;
  if (/_/.test(token) && /[A-Za-z]/.test(token)) return true;
  return false;
}
function isTrivialPrompt(prompt) {
  const trimmed = prompt.trim();
  const norm = trimmed.toLowerCase().replace(/[!?.,;:]+$/g, "");
  if (MARKER_TRIVIAL_PROMPTS.has(norm)) return true;
  for (const re of MEMORY_TRIGGERS) {
    if (re.test(trimmed)) return false;
  }
  for (const re of SELF_CONTAINED_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  if (queryLooksLikeCodeSymbol(trimmed) || trimmed.split(/\s+/).some(queryLooksLikeCodeSymbol)) {
    return false;
  }
  if (norm.length < 12) return true;
  const wordCount = norm.split(/\s+/).filter((w) => /[a-zà-ÿ]{2,}/i.test(w)).length;
  if (wordCount < 3 && trimmed.length < 80) return true;
  return false;
}
function hitsPassingMinScore(hits, minScore, seen) {
  const unseen = hits.filter((h) => !seen.has(h.id));
  if (unseen.length === 0) return [];
  let maxScore = 0;
  for (const h of unseen) {
    if (h.score > maxScore) maxScore = h.score;
  }
  if (maxScore <= 0) return [];
  const collapsed = maxScore < minScore * 0.01;
  const floor = collapsed ? maxScore * 0.5 : minScore;
  return unseen.filter((h) => h.score >= floor);
}
function normalizePath(p) {
  return p.toLowerCase().replace(/\\/g, "/");
}
function noteMatchesActiveFile(rawHtml, activePaths) {
  if (!rawHtml || activePaths.length === 0) return false;
  const cwdMatch = rawHtml.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
  const codeFileMatch = rawHtml.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
  const noteCwd = cwdMatch ? normalizePath(cwdMatch[1]) : null;
  const noteCodeFile = codeFileMatch ? normalizePath(codeFileMatch[1]) : null;
  const noteBasename = noteCodeFile ? noteCodeFile.split("/").pop() ?? "" : null;
  for (const active of activePaths) {
    const norm = normalizePath(active);
    if (noteCwd && norm.startsWith(noteCwd.endsWith("/") ? noteCwd : `${noteCwd}/`)) {
      return true;
    }
    if (noteBasename) {
      const activeBasename = norm.split("/").pop() ?? "";
      if (activeBasename && activeBasename === noteBasename) return true;
    }
  }
  return false;
}
function applyActiveFileBoost(hits, activePaths) {
  const boosted = hits.map((hit) => {
    let rawHtml = hit.rawHtml ?? "";
    if (!rawHtml) {
      try {
        rawHtml = readNote(hit.path).html;
      } catch {
      }
    }
    const multiplier = noteMatchesActiveFile(rawHtml, activePaths) ? ACTIVE_FILE_BOOST : 1;
    return { ...hit, score: hit.score * multiplier };
  });
  return boosted.sort((a, b) => b.score - a.score);
}
function detectQueryIntent(query) {
  const lower = query.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);
  if (/^(why|how|explain|pourquoi|comment)\b/i.test(lower)) return "reasoning";
  if (/^(should|can|could|avoid|risk|danger|warning|attention|est-ce que)\b/i.test(lower))
    return "warning";
  if (/\b(safe|careful|pitfall|anti.?pattern|don'?t)\b/i.test(lower)) return "warning";
  if (words.length <= 4 && !/\?$/.test(lower)) return "quick";
  return "detailed";
}
function selectiveStripForTurn(hitPath, note, intent) {
  if (intent === "detailed") {
    return stripNoteToPrompt(note);
  }
  let rawHtml;
  try {
    const noteFile = readNote(hitPath);
    rawHtml = noteFile.html;
  } catch {
    return stripNoteToPrompt(note);
  }
  const TYPE_LETTER2 = {
    decision: "D",
    episodic: "E",
    reference: "R",
    semantic: "S",
    procedural: "P"
  };
  const header = `${TYPE_LETTER2[note.type ?? ""] ?? "\xB7"} ${(note.created ?? "").slice(0, 10)} #${(note.id ?? "").replace(/^\d{4}-\d{2}-\d{2}-/, "").slice(0, 32)}`;
  if (intent === "quick") {
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    if (tldr) return `${header}
  ${tldr}`;
    const summary = stripSection(rawHtml, "details[open] summary");
    if (summary) return `${header}
  ${summary}`;
    return stripNoteToPrompt(note);
  }
  if (intent === "reasoning") {
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    const reasoning = stripSection(rawHtml, 'section[data-section="reasoning"]');
    const parts = [header];
    if (tldr) parts.push(`  ${tldr}`);
    if (reasoning) parts.push(`  [reasoning] ${reasoning}`);
    if (parts.length > 1) return parts.join("\n");
    return stripNoteToPrompt(note);
  }
  if (intent === "warning") {
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    const warnings = stripSection(rawHtml, 'aside[role="doc-warning"]');
    const tips = stripSection(rawHtml, 'aside[role="doc-tip"]');
    const parts = [header];
    if (tldr) parts.push(`  ${tldr}`);
    if (warnings) parts.push(`  [WARNING] ${warnings}`);
    if (tips) parts.push(`  [TIP] ${tips}`);
    if (parts.length > 1) return parts.join("\n");
    return stripNoteToPrompt(note);
  }
  return stripNoteToPrompt(note);
}
var MARKER_TRIVIAL_PROMPTS, MEMORY_TRIGGERS, SELF_CONTAINED_PATTERNS, ACTIVE_FILE_BOOST;
var init_scoring = __esm({
  "src/commands/inject-context/scoring.ts"() {
    "use strict";
    init_strip();
    init_reader();
    MARKER_TRIVIAL_PROMPTS = /* @__PURE__ */ new Set([
      "ok",
      "okay",
      "yes",
      "no",
      "continue",
      "go",
      "next",
      "merci",
      "thanks",
      "thx",
      "oui",
      "non",
      "cool",
      "parfait",
      "good",
      "nice",
      "stop",
      "wait",
      "super",
      "sure",
      "fine",
      "great",
      "allez",
      "vas-y",
      "go ahead",
      "roger",
      "done",
      "noted",
      "understood",
      "compris",
      "ack",
      "k",
      "kk",
      "yep",
      "nope"
    ]);
    MEMORY_TRIGGERS = [
      /\b(did we|have we|what did we|we discussed|we decided|earlier|previously|last time|before)\b/i,
      /\b(rappel|rappelle|on a vu|on a déjà|on a fait|déjà parlé|déjà vu|on avait|tu te souviens)\b/i,
      /\b(remember|recall|past|history|context)\b/i,
      /#[a-z0-9-]{4,}/
      // references to a short id from prior inject
    ];
    SELF_CONTAINED_PATTERNS = [
      /^\s*[{[]/,
      // JSON / array dumps
      /^\s*\$\s/,
      // shell prompt prefix
      /^\s*(?:error|warning|exception|traceback|stderr|stdout):/i,
      /^\s*\/[a-z-]+(?:\s|$)/i
      // slash command at start of line
    ];
    ACTIVE_FILE_BOOST = 1.4;
  }
});

// src/store/profile.ts
import { existsSync as existsSync20, readFileSync as readFileSync20 } from "node:fs";
import { join as join22 } from "node:path";
function profilePath() {
  return join22(brainRoot(), PROFILE_FILE);
}
function profileTextForInjection() {
  const path = profilePath();
  if (!existsSync20(path)) return null;
  try {
    const html = readFileSync20(path, "utf8");
    return stripTags(html);
  } catch {
    return null;
  }
}
var PROFILE_FILE;
var init_profile = __esm({
  "src/store/profile.ts"() {
    "use strict";
    init_strip();
    init_paths();
    PROFILE_FILE = "_user-profile.html";
  }
});

// src/commands/inject-context/sections.ts
import { existsSync as existsSync21, readFileSync as readFileSync21 } from "node:fs";
import { join as join23 } from "node:path";
function abbreviateTag(tag) {
  const map = {
    typescript: "ts",
    javascript: "js",
    python: "py",
    shell: "sh",
    database: "db",
    frontend: "fe",
    docs: "doc",
    config: "cfg",
    refactor: "rf",
    performance: "perf",
    security: "sec",
    testing: "test"
  };
  return map[tag] ?? tag;
}
function stripRedundantDate(title, isoDate) {
  return title.replace(new RegExp(`^${isoDate}\\s+`), "").trim();
}
function relationHints(n) {
  const parts = [];
  if (n.replaces) parts.push(`\u21BA${n.replaces.split(",")[0]}`);
  if (n.causes) {
    const first = n.causes.split("|")[0];
    if (first && first.length > 0) parts.push(`\u2235${first.slice(0, 28)}`);
  }
  if (n.triples) {
    const t = n.triples.split(";")[0];
    if (t) parts.push(`\u25E6${t}`);
  }
  return parts.length ? ` \xB7 ${parts.join(" ")}` : "";
}
function compactLine(n) {
  const isoDate = (n.created ?? "").slice(0, 10);
  const md = isoDate.slice(5);
  const icon = TYPE_ICON[n.type ?? ""] ?? "\xB7";
  const importance = n.importance != null && (n.importance < 0.4 || n.importance >= 0.8) ? ` [${n.importance.toFixed(1)}]` : "";
  const tagList = n.tags ? n.tags.split(/\s+/).slice(0, 3).map(abbreviateTag).join(",") : "";
  const tags = tagList ? ` (${tagList})` : "";
  const rawTitle = (n.title ?? n.id).slice(0, 60);
  const title = stripRedundantDate(rawTitle, isoDate);
  const rels = relationHints(n);
  const saliency = n.saliency_kind ? SALIENCY_GLYPH[n.saliency_kind] ?? "" : "";
  const iconWithSaliency = saliency ? `${icon}${saliency}` : icon;
  return `${md} ${iconWithSaliency} #${shortId(n.id)} ${title}${tags}${importance}${rels}`.replace(/\s+/g, " ").trim();
}
function clusterSummary(notes) {
  const counts = /* @__PURE__ */ new Map();
  for (const n of notes) {
    if (!n.tags) continue;
    for (const tag of n.tags.split(/\s+/).filter(Boolean)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return "";
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `clusters: ${sorted.map(([t, c]) => `${abbreviateTag(t)}=${c}`).join(" ")}`;
}
function renderTopicTree(nodes, indent = "") {
  const lines = [];
  const sorted = [...nodes].sort((a, b) => b.noteCount - a.noteCount);
  for (const node of sorted) {
    if (node.noteCount === 0) continue;
    const hubInfo = node.hubIds.length > 0 ? ` [${node.hubIds.length} hubs]` : "";
    lines.push(`${indent}${node.name}/ (${node.noteCount})${hubInfo}`);
    if (node.children.length > 0 && indent.length < 4) {
      lines.push(renderTopicTree(node.children, `${indent}  `));
    }
  }
  return lines.filter(Boolean).join("\n");
}
function deriveProjectSlug(cwd) {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].toLowerCase();
    if (seg.length < 2 || /^[a-z]:?$/.test(seg) || CWD_SLUG_SKIP.has(seg)) continue;
    return seg.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  }
  return "";
}
function topicBelongsToProject(topic, slug2) {
  const t = topic.toLowerCase();
  return t === slug2 || t.startsWith(`${slug2}/`);
}
function buildMainPage(_notes, cwd) {
  const parts = [];
  const projects = /* @__PURE__ */ new Map();
  const uncategorized = [];
  for (const n of _notes) {
    const topic = n.topic;
    if (!topic) {
      uncategorized.push(n);
      continue;
    }
    const segments = topic.split("/");
    const project = segments[0];
    const feature = segments[1] || "_general";
    if (!projects.has(project)) projects.set(project, /* @__PURE__ */ new Map());
    const proj = projects.get(project);
    if (!proj.has(feature)) proj.set(feature, []);
    proj.get(feature).push(n);
  }
  const slug2 = cwd ? deriveProjectSlug(cwd) : "";
  const matchedKey = slug2 ? [...projects.keys()].find((k) => k.toLowerCase() === slug2) : void 0;
  const scopedProjects = matchedKey ? /* @__PURE__ */ new Map([[matchedKey, projects.get(matchedKey)]]) : projects;
  buildProjectSummaries(scopedProjects, parts);
  if (matchedKey && projects.size > 1) {
    parts.push(`(+${projects.size - 1} other projects in brain \u2014 brain_query to explore)`);
  }
  if (uncategorized.length > 5) parts.push(`_other/ (${uncategorized.length} notes)`);
  buildScopedWarnings(scopedProjects, parts);
  buildScopedDecisions(scopedProjects, parts);
  buildStubsBlock(parts);
  return parts.join("\n");
}
function buildProjectSummaries(projects, parts) {
  for (const [projectName, features] of [...projects.entries()].sort((a, b) => {
    const aCount = [...a[1].values()].reduce((s, arr) => s + arr.length, 0);
    const bCount = [...b[1].values()].reduce((s, arr) => s + arr.length, 0);
    return bCount - aCount;
  })) {
    const totalNotes = [...features.values()].reduce((s, arr) => s + arr.length, 0);
    const featureLines = [];
    for (const [featureName, featureNotes] of [...features.entries()].sort(
      (a, b) => b[1].length - a[1].length
    )) {
      if (featureName === "_general") continue;
      const best = [...featureNotes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
      const tldr = (best?.title ?? "").slice(0, 50);
      const dCount = featureNotes.filter((n) => n.type === "decision").length;
      const wCount = featureNotes.filter((n) => n.warnings?.trim()).length;
      const eCount = featureNotes.filter(
        (n) => (n.tags ?? "").includes("bug") || (n.tags ?? "").includes("error") || (n.tags ?? "").includes("critical")
      ).length;
      const counts = [];
      if (dCount > 0) counts.push(`D:${dCount}`);
      if (wCount > 0) counts.push(`W:${wCount}`);
      if (eCount > 0) counts.push(`E:${eCount}`);
      featureLines.push(
        `  ${featureName}: ${tldr}${counts.length > 0 ? ` | ${counts.join(" ")}` : ""}`
      );
    }
    if (featureLines.length > 0) {
      parts.push(`${projectName}/ (${totalNotes} notes)
${featureLines.slice(0, 8).join("\n")}`);
    } else {
      parts.push(`${projectName}/ (${totalNotes} notes)`);
    }
  }
}
function buildScopedWarnings(projects, parts) {
  const allWarnings = [];
  for (const [projectName, features] of projects) {
    let projectWarningCount = 0;
    for (const [featureName, featureNotes] of features) {
      if (projectWarningCount >= 3) break;
      const sortedNotes = [...featureNotes].sort(
        (a, b) => (b.importance ?? 0) - (a.importance ?? 0)
      );
      for (const n of sortedNotes) {
        if (projectWarningCount >= 3) break;
        const w = n.warnings;
        if (!w?.trim()) continue;
        for (const rawWarning of w.split("|")) {
          const text = rawWarning.trim();
          if (!warningPassesGate(text)) continue;
          const scope = featureName !== "_general" ? `${projectName}/${featureName}` : projectName;
          allWarnings.push(`  ! ${scope}: ${text.slice(0, 80)}`);
          projectWarningCount += 1;
          break;
        }
      }
    }
  }
  if (allWarnings.length > 0) parts.push(`[WARNINGS]
${allWarnings.slice(0, 5).join("\n")}`);
}
function buildScopedDecisions(projects, parts) {
  const allDecisions = [];
  for (const [projectName, features] of projects) {
    for (const [featureName, featureNotes] of features) {
      for (const n of featureNotes) {
        if (n.type !== "decision" || n.valid_until) continue;
        const scope = featureName !== "_general" ? `${projectName}/${featureName}` : projectName;
        allDecisions.push(`  D ${scope}: ${(n.title ?? "").slice(0, 60)}`);
      }
    }
  }
  if (allDecisions.length > 0) parts.push(`[DECISIONS]
${allDecisions.slice(0, 5).join("\n")}`);
}
function uniqueShortIds(fullIds, limit) {
  const picked = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of fullIds) {
    if (picked.length >= limit) break;
    const short = shortId(id);
    if (seen.has(short)) continue;
    seen.add(short);
    picked.push(short);
  }
  return picked;
}
function buildStubsBlock(parts) {
  try {
    const allNotes = listAll({ includeExpired: false });
    const stubIds = allNotes.filter((n) => n.quality === "stub").map((n) => n.id);
    const ids = uniqueShortIds(stubIds, 5);
    if (ids.length > 0) {
      parts.push(`[STUBS] ${ids.length} notes need expansion: ${ids.map((id) => `#${id}`).join(", ")}`);
    }
  } catch {
  }
}
function buildProfileBlock(cwd) {
  const profile = profileTextForInjection();
  if (!profile) return "";
  const slug2 = cwd ? deriveProjectSlug(cwd) : "";
  if (!slug2) return `[USER PROFILE]
${profile}
`;
  const heading = "Stable decisions / preferences";
  const idx = profile.indexOf(heading);
  if (idx === -1) return "";
  const decisionsText = profile.slice(idx + heading.length).trim();
  if (!decisionsText || /no recurring decisions yet/i.test(decisionsText)) return "";
  return `[USER PROFILE]
${heading}
${decisionsText}
`;
}
function buildTagVocabularyBlock(cwd) {
  try {
    const slug2 = cwd ? deriveProjectSlug(cwd) : "";
    const { types, tags } = noteVocabularyCensus(slug2 || void 0);
    const typesLine = types.map((t) => `${t.value}:${t.count}`).join(" ");
    const tagsLine = tags.map((t) => `${t.value}:${t.count}`).join(" ");
    const segments = [];
    if (typesLine) segments.push(`types: ${typesLine}`);
    if (tagsLine) segments.push(`tags: ${tagsLine}`);
    return segments.length > 0 ? `[TAGS] ${segments.join(" | ")}` : "";
  } catch {
    return "";
  }
}
function buildGraphLines(cwd) {
  let graphLines = "";
  try {
    const graph = loadKnowledgeGraph();
    if (graph?.topicTree && graph.topicTree.length > 0) {
      const slug2 = cwd ? deriveProjectSlug(cwd) : "";
      const scopedTree = slug2 ? graph.topicTree.filter((n) => n.name.toLowerCase() === slug2) : [];
      const treeNodes = scopedTree.length > 0 ? scopedTree : graph.topicTree;
      const treeText = renderTopicTree(treeNodes);
      if (treeText) graphLines += `
${treeText}`;
    }
    const backlinks = loadBacklinks();
    const topologySummary = buildGraphTopologySummary(backlinks);
    const compactTopology = topologySummary.replace(/\. Top hubs:.*$/, ".");
    if (compactTopology) graphLines += `
${compactTopology}`;
  } catch {
  }
  return graphLines;
}
function runMarkerInject(highlights = false, cwd, nudge = DEFAULT_NUDGE_STYLE, maxTokens) {
  const start = Date.now();
  const all = listAll({ includeExpired: false });
  const notes = all.filter((n) => !n.path.endsWith("_user-profile.html"));
  const marker = `[BRAIN] ${notes.length} notes available.${markerNudge(nudge)}`;
  const graphLines = buildGraphLines(cwd);
  let body;
  if (highlights) {
    body = `${marker}${graphLines}`;
    if (notes.length > 0) body = appendHighlights(body, notes, cwd, nudge, maxTokens);
  } else {
    const profile = profileTextForInjection();
    const profileLine = profile ? `[USER PROFILE]
${profile}
` : "";
    body = `${profileLine}${marker}${graphLines}`;
  }
  logTelemetry({
    event: "inject",
    ts: nowIso(),
    tokens: estimateTokenCount(body),
    sections: notes.length > 0 ? highlights ? 2 : 1 : 0,
    duration_ms: Date.now() - start
  });
  return body;
}
function appendHighlights(body, notes, cwd, nudge = DEFAULT_NUDGE_STYLE, maxTokens) {
  let result = body;
  const rawBudget = maxTokens ?? Number.POSITIVE_INFINITY;
  let footer = "";
  try {
    footer = highlightsRecallNudge(nudge);
  } catch {
  }
  const budget = Number.isFinite(rawBudget) ? Math.max(0, rawBudget - estimateTokenCount(footer)) : rawBudget;
  const underBudget = () => estimateTokenCount(result) < budget;
  if (underBudget()) {
    if (process.env.LAZYBRAIN_INJECT_MAINPAGE !== "0") {
      const mainPage = buildMainPage(notes, cwd);
      if (mainPage) result += `
${mainPage}`;
    } else {
      const cluster = clusterSummary(notes);
      if (cluster) result += `
${cluster}`;
    }
  }
  if (underBudget()) {
    const tagsBlock = buildTagVocabularyBlock(cwd);
    if (tagsBlock) result += `
${tagsBlock}`;
  }
  if (cwd && underBudget()) result = appendClusterBlock(result, cwd);
  if (cwd && underBudget()) result = appendProjectBlock(result, cwd);
  if (cwd && underBudget()) result = appendRecentNotesBlock(result, notes, cwd, budget);
  if (underBudget()) {
    const profileBlock = buildProfileBlock(cwd);
    if (profileBlock) result += `
${profileBlock}`;
  }
  result += footer;
  return result;
}
function appendClusterBlock(body, cwd) {
  try {
    const slug2 = slugifyCwd(cwd);
    const clusterPath = join23(brainRoot(), "clusters", slug2, "_cluster.html");
    if (!existsSync21(clusterPath)) return body;
    const clusterHtml = readFileSync21(clusterPath, "utf-8");
    const noteCountMatch = clusterHtml.match(/name="cluster-note-count"\s+content="(\d+)"/);
    const activeDecMatch = clusterHtml.match(/name="cluster-active-decisions"\s+content="(\d+)"/);
    const hubsMatch = clusterHtml.match(/name="cluster-hubs"\s+content="([^"]+)"/);
    const noteCount = noteCountMatch ? noteCountMatch[1] : "?";
    const activeDec = activeDecMatch ? activeDecMatch[1] : "0";
    const hubs = hubsMatch ? hubsMatch[1].split(", ").slice(0, 2).join(", ") : "";
    let clusterLine = `[CLUSTER ${slug2}] ${noteCount} neurons \xB7 ${activeDec} active decisions`;
    if (hubs) clusterLine += ` \xB7 hubs: ${hubs}`;
    return `${body}
${clusterLine}`;
  } catch {
    return body;
  }
}
function appendProjectBlock(body, cwd) {
  try {
    const cwdNotes = notesForCwdCount(cwd);
    if (cwdNotes.count > 0) {
      const decisions = cwdNotes.activeDecisions ? ` \xB7 active: ${cwdNotes.activeDecisions}` : "";
      return `${body}
[PROJECT]
  ${cwd}
  ${cwdNotes.count} notes (by path)${decisions}`;
    }
    return body;
  } catch {
    return body;
  }
}
function appendRecentNotesBlock(body, notes, cwd, budget) {
  try {
    const projectSlug2 = deriveProjectSlug(cwd);
    if (!projectSlug2) return body;
    const projectNotes = notes.filter(
      (n) => topicBelongsToProject(n.topic ?? "", projectSlug2)
    ).filter((n) => !GENERATED_INDEX_TYPES.has(n.type ?? "")).sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
    let result = appendLastThreeNotes(body, projectNotes, budget);
    result = appendKeyFeatures(result, projectNotes, projectSlug2, budget);
    return result;
  } catch {
    return body;
  }
}
function looksLikeProse(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^contents$/im.test(trimmed)) return false;
  if (/\[[^\]]*→#[^\]]*\]/.test(trimmed)) return false;
  if (/"[^"]*"\s*"[^"]*"\s*\|/.test(trimmed)) return false;
  if ((trimmed.match(/[{}]/g)?.length ?? 0) >= 2) return false;
  return true;
}
function summaryLineFor(note) {
  const tldr = (note.section_tldr ?? "").trim();
  return tldr && looksLikeProse(tldr) ? tldr.slice(0, 250) : "";
}
function appendLastThreeNotes(body, projectNotes, budget) {
  const conversations = projectNotes.filter((n) => n.source === CONVERSATION_SUMMARY_SOURCE);
  const usingConversations = conversations.length > 0;
  const pool = usingConversations ? conversations : projectNotes;
  const picked = [];
  for (const note of pool) {
    if (picked.length >= 3) break;
    const summary = summaryLineFor(note);
    if (!summary) continue;
    picked.push({ note, summary });
  }
  if (picked.length === 0) return body;
  const header = usingConversations ? "[RECENT CONVERSATIONS]" : "[RECENT NOTES]";
  let result = `${body}
${header}`;
  for (const { note, summary } of picked) {
    if (estimateTokenCount(result) >= budget) break;
    const title = (note.title ?? "").slice(0, 80);
    const date = (note.created ?? "").slice(0, 10);
    result += `
  ${date} ${title}
    ${summary}`;
  }
  return result;
}
function appendKeyFeatures(body, projectNotes, projectSlug2, budget) {
  const groupedBySubTopic = /* @__PURE__ */ new Map();
  for (const n of projectNotes) {
    const topic = (n.topic ?? "").toLowerCase();
    const parts = topic.split("/");
    const subTopic = parts.length > 1 ? parts.slice(1).join("/") : "_general";
    if (!groupedBySubTopic.has(subTopic)) groupedBySubTopic.set(subTopic, []);
    groupedBySubTopic.get(subTopic).push(n);
  }
  const header = `

[KEY FEATURES ${projectSlug2}]`;
  const keyFeatureLines = [];
  for (const [subTopic, subNotes] of [...groupedBySubTopic.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    if (keyFeatureLines.length >= 15) break;
    const soFar = `${body}${header}
${keyFeatureLines.join("\n")}`;
    if (estimateTokenCount(soFar) >= budget) break;
    const best = [...subNotes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
    if (!best) continue;
    const tldrText = summaryLineFor(best) || (best.title ?? "").slice(0, 80);
    const fullPath = subTopic === "_general" ? projectSlug2 : `${projectSlug2}/${subTopic}`;
    keyFeatureLines.push(`  ${fullPath}: ${tldrText.slice(0, 150)}`);
  }
  if (keyFeatureLines.length > 0) {
    return `${body}${header}
${keyFeatureLines.join("\n")}`;
  }
  return body;
}
var TYPE_ICON, CWD_SLUG_SKIP, CONVERSATION_SUMMARY_SOURCE, GENERATED_INDEX_TYPES;
var init_sections = __esm({
  "src/commands/inject-context/sections.ts"() {
    "use strict";
    init_saliency();
    init_analysis();
    init_backlinks();
    init_knowledge_graph();
    init_fts();
    init_paths();
    init_profile();
    init_cwd_normalizer();
    init_telemetry();
    init_tokenize();
    init_markers();
    TYPE_ICON = {
      decision: "D",
      episodic: "E",
      reference: "R",
      semantic: "S",
      procedural: "P"
    };
    CWD_SLUG_SKIP = /* @__PURE__ */ new Set([
      "documents",
      "users",
      "home",
      "desktop",
      "projects",
      "repos",
      "src",
      "dev",
      "code",
      "workspace"
    ]);
    CONVERSATION_SUMMARY_SOURCE = "lazy-manager:conversation-summary";
    GENERATED_INDEX_TYPES = /* @__PURE__ */ new Set(["topic-overview", "concept"]);
  }
});

// src/graph/clusters.ts
import { existsSync as existsSync22, mkdirSync as mkdirSync12, readFileSync as readFileSync22, writeFileSync as writeFileSync17 } from "node:fs";
import { join as join24 } from "node:path";
function louvainPhase1(graph, community, sumTot, sumIn, maxIters) {
  const { n, adj, degree } = graph;
  const m = graph.totalWeight;
  let improved = false;
  let iter = 0;
  let changed = true;
  while (changed && iter < maxIters) {
    changed = false;
    iter++;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const seed = iter * 1103515245 + i + 12345 & 2147483647;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const i of order) {
      const currentComm = community[i];
      const ki = degree[i];
      const neighborComms = /* @__PURE__ */ new Map();
      for (const edge of adj[i]) {
        const nc = community[edge.target];
        neighborComms.set(nc, (neighborComms.get(nc) ?? 0) + edge.weight);
      }
      const kiInCurrent = neighborComms.get(currentComm) ?? 0;
      sumTot[currentComm] -= ki;
      sumIn[currentComm] -= 2 * kiInCurrent;
      let bestComm = currentComm;
      let bestDeltaQ = 0;
      for (const [comm, kiIn] of neighborComms) {
        const deltaQ = kiIn / m - sumTot[comm] * ki / (2 * m * m);
        if (deltaQ > bestDeltaQ) {
          bestDeltaQ = deltaQ;
          bestComm = comm;
        }
      }
      community[i] = bestComm;
      const kiInBest = neighborComms.get(bestComm) ?? 0;
      sumTot[bestComm] += ki;
      sumIn[bestComm] += 2 * kiInBest;
      if (bestComm !== currentComm) {
        changed = true;
        improved = true;
      }
    }
  }
  return improved;
}
function buildSuperGraph(graph, community, numCommunities) {
  const { n, adj, degree } = graph;
  const superDegree = new Array(numCommunities).fill(0);
  const edgeMap = /* @__PURE__ */ new Map();
  for (let i = 0; i < n; i++) {
    const ci = community[i];
    superDegree[ci] += degree[i];
    for (const edge of adj[i]) {
      const cj = community[edge.target];
      if (ci === cj) continue;
      const key = ci < cj ? `${ci}:${cj}` : `${cj}:${ci}`;
      edgeMap.set(key, (edgeMap.get(key) ?? 0) + edge.weight);
    }
  }
  const superAdj = Array.from({ length: numCommunities }, () => []);
  let superTotalWeight = 0;
  for (const [key, w] of edgeMap) {
    const [a, b] = key.split(":").map(Number);
    superAdj[a].push({ target: b, weight: w });
    superAdj[b].push({ target: a, weight: w });
    superTotalWeight += w;
  }
  return {
    n: numCommunities,
    adj: superAdj,
    degree: superDegree,
    totalWeight: superTotalWeight > 0 ? superTotalWeight : graph.totalWeight
  };
}
function compactCommunities(community, n) {
  const remap = /* @__PURE__ */ new Map();
  let next = 0;
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (!remap.has(c)) remap.set(c, next++);
  }
  return { remap, count: next };
}
function runFullLouvain(graph, maxIters) {
  const { n } = graph;
  let community = Array.from({ length: n }, (_, i) => i);
  let sumTot = new Float64Array(n);
  let sumIn = new Float64Array(n);
  for (let i = 0; i < n; i++) sumTot[i] = graph.degree[i];
  let originalToSuper = Array.from({ length: n }, (_, i) => i);
  let currentGraph = graph;
  let globalIter = 0;
  while (globalIter < 10) {
    globalIter++;
    louvainPhase1(currentGraph, community, sumTot, sumIn, maxIters);
    const { remap, count } = compactCommunities(community, currentGraph.n);
    for (let i = 0; i < currentGraph.n; i++) {
      community[i] = remap.get(community[i]) ?? 0;
    }
    const prevToNew = community.slice();
    originalToSuper = originalToSuper.map((s) => prevToNew[s]);
    if (count === currentGraph.n) break;
    const superGraph = buildSuperGraph(currentGraph, community, count);
    community = Array.from({ length: count }, (_, i) => i);
    sumTot = new Float64Array(count);
    sumIn = new Float64Array(count);
    for (let i = 0; i < count; i++) sumTot[i] = superGraph.degree[i];
    currentGraph = superGraph;
    if (currentGraph.totalWeight === 0) break;
  }
  return originalToSuper;
}
function splitOversizedCommunities(communities, graph, totalNodes, maxIters) {
  const threshold = Math.max(10, Math.floor(totalNodes * 0.25));
  const communityMembers = /* @__PURE__ */ new Map();
  for (let i = 0; i < totalNodes; i++) {
    const c = communities[i];
    const arr = communityMembers.get(c) ?? [];
    arr.push(i);
    communityMembers.set(c, arr);
  }
  const result = communities.slice();
  let nextClusterId = Math.max(...communities) + 1;
  for (const [comm, members] of communityMembers) {
    if (members.length <= threshold) continue;
    const localIndex = new Map(members.map((n, i) => [n, i]));
    const subN = members.length;
    const subAdj = Array.from({ length: subN }, () => []);
    const subDegree = new Array(subN).fill(0);
    let subTotalWeight = 0;
    for (const orig of members) {
      const li = localIndex.get(orig);
      for (const edge of graph.adj[orig]) {
        const lj = localIndex.get(edge.target);
        if (lj === void 0) continue;
        subAdj[li].push({ target: lj, weight: edge.weight });
        subDegree[li] += edge.weight;
        subTotalWeight += edge.weight;
      }
    }
    if (subTotalWeight === 0) continue;
    const subGraph = {
      n: subN,
      adj: subAdj,
      degree: subDegree,
      totalWeight: subTotalWeight
    };
    const subCommunities = runFullLouvain(subGraph, maxIters);
    const { remap, count } = compactCommunities(subCommunities, subN);
    if (count <= 1) continue;
    const subCommToGlobal = /* @__PURE__ */ new Map();
    for (const [rawSub, compactSub] of remap) {
      if (compactSub === 0) {
        subCommToGlobal.set(rawSub, comm);
      } else {
        subCommToGlobal.set(rawSub, nextClusterId++);
      }
    }
    for (let li = 0; li < subN; li++) {
      const orig = members[li];
      result[orig] = subCommToGlobal.get(subCommunities[li]) ?? comm;
    }
  }
  return result;
}
function stableIdRemap(ids, newCommunities, previous) {
  if (!previous || Object.keys(previous.members).length === 0) {
    return newCommunities;
  }
  const newToIds = /* @__PURE__ */ new Map();
  for (let i = 0; i < ids.length; i++) {
    const c = newCommunities[i];
    const s = newToIds.get(c) ?? /* @__PURE__ */ new Set();
    s.add(ids[i]);
    newToIds.set(c, s);
  }
  const oldToIds = /* @__PURE__ */ new Map();
  for (const [id, c] of Object.entries(previous.members)) {
    const s = oldToIds.get(c) ?? /* @__PURE__ */ new Set();
    s.add(id);
    oldToIds.set(c, s);
  }
  const usedOldIds = /* @__PURE__ */ new Set();
  const newToStable = /* @__PURE__ */ new Map();
  let nextFreeId = Math.max(...Array.from(oldToIds.keys()), -1) + 1;
  const sortedNew = [...newToIds.keys()].sort(
    (a, b) => (newToIds.get(b)?.size ?? 0) - (newToIds.get(a)?.size ?? 0)
  );
  for (const newComm of sortedNew) {
    const newSet = newToIds.get(newComm);
    let bestOld = -1;
    let bestOverlap = 0;
    for (const [oldComm, oldSet] of oldToIds) {
      if (usedOldIds.has(oldComm)) continue;
      let overlap = 0;
      for (const id of newSet) {
        if (oldSet.has(id)) overlap++;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestOld = oldComm;
      }
    }
    if (bestOld >= 0 && bestOverlap > 0) {
      newToStable.set(newComm, bestOld);
      usedOldIds.add(bestOld);
    } else {
      newToStable.set(newComm, nextFreeId++);
    }
  }
  const stableIds = newCommunities.map((c) => newToStable.get(c) ?? c);
  const seen = /* @__PURE__ */ new Map();
  let idx = 0;
  const compact = stableIds.map((c) => {
    if (!seen.has(c)) seen.set(c, idx++);
    return seen.get(c);
  });
  return compact;
}
function detectClusters(notes, backlinks, maxIters = 20, previousClusters = null) {
  const ids = notes.map((n2) => n2.id);
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const adj = Array.from({ length: n }, () => []);
  const degree = new Array(n).fill(0);
  let totalWeight = 0;
  for (const edges of Object.values(backlinks.outgoing ?? {})) {
    for (const e of edges) {
      const from = idIndex.get(e.from);
      const to = idIndex.get(e.to);
      if (from === void 0 || to === void 0 || from === to) continue;
      adj[from].push({ target: to, weight: 1 });
      adj[to].push({ target: from, weight: 1 });
      degree[from] += 1;
      degree[to] += 1;
      totalWeight += 1;
    }
  }
  const tagBuckets = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const idx = idIndex.get(note.id);
    if (idx === void 0) continue;
    for (const t of (note.tags ?? "").split(/\s+/).filter(Boolean)) {
      (tagBuckets.get(t) ?? tagBuckets.set(t, []).get(t)).push(idx);
    }
  }
  for (const bucket of tagBuckets.values()) {
    const cap = Math.min(bucket.length, 40);
    for (let i = 0; i < cap; i++) {
      for (let j = i + 1; j < cap; j++) {
        adj[bucket[i]].push({ target: bucket[j], weight: 0.3 });
        adj[bucket[j]].push({ target: bucket[i], weight: 0.3 });
        degree[bucket[i]] += 0.3;
        degree[bucket[j]] += 0.3;
        totalWeight += 0.3;
      }
    }
  }
  if (totalWeight === 0) {
    const members2 = {};
    ids.forEach((id, i) => {
      members2[id] = i;
    });
    const labels2 = {};
    ids.forEach((_, i) => {
      labels2[i] = `cluster-${i}`;
    });
    return {
      node_count: n,
      cluster_count: n,
      members: members2,
      labels: labels2,
      generated: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  const graph = { n, adj, degree, totalWeight };
  let communities = runFullLouvain(graph, maxIters);
  communities = splitOversizedCommunities(communities, graph, n, maxIters);
  communities = stableIdRemap(ids, communities, previousClusters);
  const finalRemap = /* @__PURE__ */ new Map();
  let nextId = 0;
  for (let i = 0; i < n; i++) {
    const c = communities[i];
    if (!finalRemap.has(c)) finalRemap.set(c, nextId++);
  }
  const members = {};
  for (let i = 0; i < n; i++) {
    members[ids[i]] = finalRemap.get(communities[i]) ?? 0;
  }
  const tagFreqByCluster = /* @__PURE__ */ new Map();
  const topicFreqByCluster = /* @__PURE__ */ new Map();
  const idsByCluster = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const cluster = members[note.id];
    if (cluster === void 0) continue;
    const tagFreq = tagFreqByCluster.get(cluster) ?? /* @__PURE__ */ new Map();
    for (const t of (note.tags ?? "").split(/\s+/).filter(Boolean)) {
      tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
    tagFreqByCluster.set(cluster, tagFreq);
    const rawTopic = note.topic ?? note.id;
    const topicSeg = deriveTopicSegment(rawTopic);
    const topicFreq = topicFreqByCluster.get(cluster) ?? /* @__PURE__ */ new Map();
    topicFreq.set(topicSeg, (topicFreq.get(topicSeg) ?? 0) + 1);
    topicFreqByCluster.set(cluster, topicFreq);
    const clusterIds = idsByCluster.get(cluster) ?? [];
    clusterIds.push(note.id);
    idsByCluster.set(cluster, clusterIds);
  }
  const globalTagCount = /* @__PURE__ */ new Map();
  for (const note of notes) {
    for (const t of (note.tags ?? "").split(/\s+/).filter(Boolean)) {
      globalTagCount.set(t, (globalTagCount.get(t) ?? 0) + 1);
    }
  }
  const labels = {};
  const usedLabels = /* @__PURE__ */ new Set();
  for (let c = 0; c < nextId; c++) {
    const tagFreq = tagFreqByCluster.get(c);
    const topicFreq = topicFreqByCluster.get(c);
    const clusterIds = idsByCluster.get(c) ?? [];
    const sortedTags = tagFreq ? [...tagFreq.entries()].sort((a, b) => b[1] - a[1]) : [];
    const sortedTopics = topicFreq ? [...topicFreq.entries()].sort((a, b) => b[1] - a[1]) : [];
    const bestTag = pickBestTag(sortedTags, globalTagCount, notes.length);
    if (bestTag !== null) {
      const { tag, isGeneric } = bestTag;
      const topicDisambiguator = sortedTopics[0]?.[0] ?? commonIdPrefix(clusterIds);
      if (isGeneric && topicDisambiguator) {
        const combined = `${topicDisambiguator}/${tag}`;
        labels[c] = resolveLabel(combined, usedLabels, c);
      } else {
        labels[c] = resolveLabel(tag, usedLabels, c);
      }
    } else {
      const idDerived = sortedTopics[0]?.[0] ?? commonIdPrefix(clusterIds);
      labels[c] = resolveLabel(idDerived || `cluster-${c}`, usedLabels, c);
    }
    usedLabels.add(labels[c]);
  }
  return {
    node_count: n,
    cluster_count: nextId,
    members,
    labels,
    generated: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function deriveTopicSegment(raw) {
  const slashParts = raw.split("/").filter(Boolean);
  if (slashParts.length >= 2) {
    return slashParts.slice(-2).join("/");
  }
  if (slashParts.length === 1) {
    const hyphenParts = slashParts[0].split("-").filter(Boolean);
    if (hyphenParts.length >= 2) {
      return hyphenParts.slice(0, 2).join("-");
    }
    return slashParts[0];
  }
  return raw || "misc";
}
function commonIdPrefix(ids) {
  if (ids.length === 0) return "";
  const segCount = /* @__PURE__ */ new Map();
  for (const id of ids) {
    const segments = id.split(/[-/]/).filter((s) => s.length > 2);
    const seen = /* @__PURE__ */ new Set();
    for (const seg of segments) {
      if (!seen.has(seg)) {
        segCount.set(seg, (segCount.get(seg) ?? 0) + 1);
        seen.add(seg);
      }
    }
  }
  const threshold = Math.max(1, ids.length * 0.4);
  const dominant = [...segCount.entries()].filter(([, count]) => count >= threshold).sort((a, b) => b[1] - a[1]).map(([seg]) => seg);
  if (dominant.length === 0) return "";
  return dominant.slice(0, 2).join("-");
}
function pickBestTag(sortedTags, globalTagCount, totalNotes) {
  if (sortedTags.length === 0) return null;
  for (const [tag] of sortedTags) {
    const ratio = (globalTagCount.get(tag) ?? 0) / totalNotes;
    if (ratio <= 0.6) {
      return { tag, isGeneric: false };
    }
  }
  return { tag: sortedTags[0][0], isGeneric: true };
}
function resolveLabel(candidate, usedLabels, clusterIndex) {
  if (!usedLabels.has(candidate)) return candidate;
  const suffixed = `${candidate}-${clusterIndex}`;
  if (!usedLabels.has(suffixed)) return suffixed;
  return `${candidate}-c${clusterIndex}`;
}
function saveClusters(c) {
  const cfg = getConfig();
  if (!existsSync22(cfg.cachePath)) mkdirSync12(cfg.cachePath, { recursive: true });
  const path = join24(cfg.cachePath, CLUSTERS_FILENAME);
  writeFileSync17(path, JSON.stringify(c, null, 2), "utf8");
  return path;
}
function loadClusters() {
  const cfg = getConfig();
  const path = join24(cfg.cachePath, CLUSTERS_FILENAME);
  if (!existsSync22(path)) return null;
  try {
    return JSON.parse(readFileSync22(path, "utf8"));
  } catch {
    return null;
  }
}
var CLUSTERS_FILENAME;
var init_clusters = __esm({
  "src/graph/clusters.ts"() {
    "use strict";
    init_config();
    CLUSTERS_FILENAME = "clusters.json";
  }
});

// src/retrieval/compress-file-neuron.ts
function buildEnrichmentSummary(node, tokenBudget) {
  if (tokenBudget <= 0) return "";
  const candidates = [];
  for (const kind of ENRICHMENT_KINDS) {
    const items = node[kind] ?? [];
    for (const item of items) {
      if (item.superseded) continue;
      const text = item.text.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_TEXT_CHARS);
      if (!text) continue;
      candidates.push({
        line: `${KIND_LABEL[kind]}: ${text}`,
        confidence: item.confidence,
        date: item.date
      });
    }
  }
  if (candidates.length === 0) return "";
  candidates.sort((a, b) => b.confidence - a.confidence || b.date.localeCompare(a.date));
  const kept = [];
  let used = 0;
  for (const candidate of candidates) {
    const cost = estimateTokenCount(candidate.line);
    if (used + cost > tokenBudget && kept.length > 0) break;
    kept.push(candidate.line);
    used += cost;
  }
  return kept.join("\n");
}
function compressFileNeuron(node, opts = {}) {
  const { skeletonOnly = false, enrichmentTokenBudget = DEFAULT_ENRICHMENT_TOKEN_BUDGET } = opts;
  const lines = [];
  const lineInfo = node.lineCount > 0 ? `${node.lineCount}L` : "?L";
  lines.push(`${node.filePath} (${lineInfo}, ${node.language})`);
  if (skeletonOnly) {
    if (node.exports.length > 0) {
      lines.push(`exports: ${node.exports.join(", ")}`);
    }
    const fnNames = (node.astFunctions ?? []).map((f) => f.name);
    if (fnNames.length > 0) {
      lines.push(`fns: ${fnNames.join(", ")}`);
    }
    const clsNames = (node.astClasses ?? []).map((c) => c.name);
    if (clsNames.length > 0) {
      lines.push(`cls: ${clsNames.join(", ")}`);
    }
    if (fnNames.length === 0 && clsNames.length === 0 && node.exports.length === 0) {
    }
  } else {
    if (node.imports.length > 0) {
      lines.push(`imports: ${node.imports.join(", ")}`);
    }
    if (node.exports.length > 0) {
      lines.push(`exports: ${node.exports.join(", ")}`);
    }
    const fns = node.astFunctions ?? [];
    if (fns.length > 0) {
      lines.push("functions:");
      for (const fn of fns) {
        const params = fn.params.length > 0 ? fn.params.join(", ") : "";
        const lineRef = fn.startLine > 0 ? ` :${fn.startLine}` : "";
        lines.push(`  ${fn.name}(${params})${lineRef}`);
      }
    }
    const classes = node.astClasses ?? [];
    if (classes.length > 0) {
      lines.push("classes:");
      for (const cls of classes) {
        const base = cls.extends ? ` extends ${cls.extends}` : "";
        const methods = cls.methods.length > 0 ? ` { ${cls.methods.join(", ")} }` : "";
        lines.push(`  ${cls.name}${base}${methods}`);
      }
    }
  }
  const enrichmentSummary = buildEnrichmentSummary(node, enrichmentTokenBudget);
  if (enrichmentSummary) {
    lines.push("knowledge:");
    for (const line of enrichmentSummary.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}
var ENRICHMENT_KINDS, KIND_LABEL, DEFAULT_ENRICHMENT_TOKEN_BUDGET, MAX_LINE_TEXT_CHARS;
var init_compress_file_neuron = __esm({
  "src/retrieval/compress-file-neuron.ts"() {
    "use strict";
    init_tokenize();
    ENRICHMENT_KINDS = ["decisions", "bugs", "rules", "qa", "ideas"];
    KIND_LABEL = {
      decisions: "Decision",
      bugs: "Bug",
      rules: "Rule",
      qa: "Q&A",
      ideas: "Idea"
    };
    DEFAULT_ENRICHMENT_TOKEN_BUDGET = 200;
    MAX_LINE_TEXT_CHARS = 140;
  }
});

// src/retrieval/decay.ts
function retentionScore(n, nowMs = Date.now()) {
  const importance = clamp2(n.importance ?? 0.5, 0, 1);
  const refTime = mostRecentMs(n.last_accessed, n.created);
  const ageDays = refTime > 0 ? Math.max(0, (nowMs - refTime) / DAY_MS2) : 0;
  const decay = Math.exp(-LAMBDA * ageDays);
  const access = Math.log2(Math.max(0, n.access_count ?? 0) + 2);
  return importance * decay * access;
}
function mostRecentMs(a, b) {
  const ta = toMs(a);
  const tb = toMs(b);
  return Math.max(ta, tb);
}
function toMs(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}
function clamp2(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
var HALF_LIFE_DAYS, LAMBDA, DAY_MS2;
var init_decay = __esm({
  "src/retrieval/decay.ts"() {
    "use strict";
    HALF_LIFE_DAYS = 30;
    LAMBDA = Math.LN2 / HALF_LIFE_DAYS;
    DAY_MS2 = 864e5;
  }
});

// src/commands/inject-context/session-inject.ts
function tryCompressFileNeuron(notePath2, normalizedPr, skeletonThreshold) {
  try {
    const file = readNote(notePath2);
    const codeNode = parseFileNeuronHtml(file.html);
    if (!codeNode) return null;
    const skeletonOnly = normalizedPr < skeletonThreshold;
    return compressFileNeuron(codeNode, { skeletonOnly });
  } catch {
    return null;
  }
}
function renderFull(n, backlinks, clusters) {
  try {
    const file = readNote(n.path);
    const stripped = stripNote(file.html);
    let prompt = stripNoteToPrompt(stripped);
    const inbound = backlinks?.incoming[n.id]?.length ?? 0;
    const outbound = backlinks?.outgoing[n.id]?.length ?? 0;
    const links = inbound + outbound;
    const cluster = clusters?.members[n.id];
    const clusterLabel = cluster !== void 0 ? clusters?.labels[cluster] : void 0;
    if (links >= 2 || links >= 1 && clusterLabel) {
      const parts = [];
      if (clusterLabel) parts.push(`c=${clusterLabel}`);
      parts.push(`l:${inbound}/${outbound}`);
      prompt += ` \xB7 ${parts.join(" ")}`;
    }
    return prompt;
  } catch {
    return null;
  }
}
function runSessionInject(opts) {
  const start = Date.now();
  const budget = opts.maxTokens ?? 3e3;
  const format = opts.format ?? "full";
  const all = listAll({ includeExpired: false });
  const batches = all.filter((n) => n.path.includes("batches")).slice(0, 5);
  const notes = all.filter((n) => !n.path.includes("batches")).filter((n) => !n.path.endsWith("_user-profile.html"));
  const { normalizedPr, cwdMatchSet } = buildPrScores(notes, opts.cwd);
  const now = Date.now();
  const scored = notes.map((n) => {
    const retention = retentionScore(n, now);
    const pr = normalizedPr.get(n.id) ?? 0;
    const base = retention * (1 + PAGERANK_BLEND_WEIGHT * pr);
    const combined = cwdMatchSet.has(n.id) ? base * CWD_AFFINITY_BOOST : base;
    return { note: n, score: combined, pr };
  });
  scored.sort((a, b) => b.score - a.score);
  const skeletonPrThreshold = computeSkeletonThreshold(scored);
  const sections = [];
  let tokens = 0;
  const profile = profileTextForInjection();
  if (profile) {
    const profileBlock = `[USER PROFILE]
${profile}`;
    sections.push(profileBlock);
    tokens += estimateTokenCount(profileBlock);
  }
  const headlineLimit = format === "compact" ? 3 : scored.length;
  const headlineSet = new Set(scored.slice(0, headlineLimit).map((s) => s.note.id));
  const backlinks = loadBacklinks();
  const clusters = loadClusters();
  for (const b of batches) {
    if (tokens >= budget) break;
    const piece = renderFull(b, backlinks, clusters);
    if (!piece) continue;
    const estimated = estimateTokenCount(piece);
    if (tokens + estimated > budget && sections.length > 0) continue;
    sections.push(`[BATCH]
${piece}`);
    tokens += estimated;
  }
  const headlineNotes = notes.filter((n) => headlineSet.has(n.id));
  headlineNotes.sort((a, b) => a.id.localeCompare(b.id));
  for (const n of headlineNotes) {
    if (tokens >= budget) break;
    const compressed = tryCompressFileNeuron(
      n.path,
      normalizedPr.get(n.id) ?? 0,
      skeletonPrThreshold
    );
    if (compressed !== null) {
      const estimated2 = estimateTokenCount(compressed);
      if (tokens + estimated2 > budget && sections.length > 0) continue;
      sections.push(`[FILE]
${compressed}`);
      tokens += estimated2;
      continue;
    }
    const piece = renderFull(n, backlinks, clusters);
    if (!piece) continue;
    const estimated = estimateTokenCount(piece);
    if (tokens + estimated > budget && sections.length > 0) continue;
    sections.push(`[NOTE]
${piece}`);
    tokens += estimated;
  }
  if (format === "compact") {
    const tail = notes.filter((n) => !headlineSet.has(n.id));
    tail.sort((a, b) => a.id.localeCompare(b.id));
    const lines = tail.map(compactLine).filter(Boolean);
    if (lines.length > 0) {
      const indexBlock = `[INDEX]
${COMPACT_LEGEND}
${lines.join("\n")}`;
      const estimated = estimateTokenCount(indexBlock);
      if (tokens + estimated <= budget || sections.length === 0) {
        sections.push(indexBlock);
        tokens += estimated;
      }
    }
  }
  const output = sections.join("\n\n").trim();
  const duration = Date.now() - start;
  logTelemetry({
    event: "inject",
    ts: nowIso(),
    tokens,
    sections: sections.length,
    duration_ms: duration
  });
  if (opts.pretty) {
    return `# Brain context \u2014 ${sections.length} blocks, ~${tokens} tokens (${duration}ms, format=${format})

${output}`;
  }
  return output;
}
function buildPrScores(notes, cwd) {
  let pagerankScores = {};
  try {
    const pr = computePageRank({ noCache: false });
    pagerankScores = pr.scores;
  } catch {
  }
  const prValues = notes.map((n) => pagerankScores[n.id] ?? 0);
  const prMax = Math.max(...prValues, 1e-9);
  const normalizedPr = new Map(
    notes.map((n, i) => [n.id, (prValues[i] ?? 0) / prMax])
  );
  const cwdMatchSet = new Set(cwd ? notesForCwd(cwd) : []);
  return { normalizedPr, cwdMatchSet };
}
function computeSkeletonThreshold(scored) {
  const fileNeuronPrValues = scored.filter((s) => s.note.type === "file-neuron").map((s) => s.pr).sort((a, b) => a - b);
  const thresholdIdx = Math.floor(fileNeuronPrValues.length * SKELETON_PAGERANK_PERCENTILE);
  return fileNeuronPrValues[thresholdIdx] ?? 0;
}
function tryFeatureMapInject(query, _cwd) {
  const lower = query.toLowerCase().trim();
  const allNotes = listAll({ includeExpired: false });
  const projects = /* @__PURE__ */ new Map();
  for (const n of allNotes) {
    const topic = n.topic;
    if (!topic) continue;
    const parts = topic.split("/");
    const proj = parts[0];
    const feat = parts[1] || "_general";
    if (!projects.has(proj)) projects.set(proj, /* @__PURE__ */ new Map());
    const p = projects.get(proj);
    if (!p.has(feat)) p.set(feat, []);
    p.get(feat).push(n);
  }
  for (const [projName, features] of projects) {
    if (!lower.includes(projName)) continue;
    const overview = buildProjectOverviewText(projName, features, lower);
    if (overview === null) return null;
    return overview;
  }
  return null;
}
function buildProjectOverviewText(projName, features, lower) {
  const featureLines = [];
  for (const [featName, featNotes] of [...features.entries()].sort(
    (a, b) => b[1].length - a[1].length
  )) {
    if (featName === "_general") continue;
    const decisions = featNotes.filter((n) => n.type === "decision" && !n.valid_until);
    const warnings = featNotes.filter((n) => n.warnings);
    const best = [...featNotes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
    const tldr = (best?.title ?? "").slice(0, 60);
    let line = `  ${featName}: ${tldr}`;
    const counts = [];
    if (decisions.length) counts.push(`D:${decisions.length}`);
    if (warnings.length) counts.push(`W:${warnings.length}`);
    if (counts.length) line += ` | ${counts.join(" ")}`;
    featureLines.push(line);
    for (const d of decisions.slice(0, 2)) {
      featureLines.push(`    D ${(d.title ?? "").slice(0, 50)}`);
    }
    for (const w of warnings.slice(0, 1)) {
      const wText = (w.warnings ?? "").split("|")[0].slice(0, 60);
      featureLines.push(`    ! ${wText}`);
    }
  }
  if (featureLines.length < FEATURE_MAP_MIN_LINES) return null;
  const lines = [`[${projName}/ map]`, ...featureLines];
  for (const [featName, featNotes] of features) {
    if (lower.includes(featName) && featName !== "_general") {
      lines.push(`
  [${projName}/${featName} detail]`);
      for (const n of [...featNotes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)).slice(0, 5)) {
        const type = n.type === "decision" ? "D" : n.type === "reference" ? "R" : "E";
        lines.push(`    ${type} ${(n.title ?? "").slice(0, 60)}`);
      }
    }
  }
  return lines.join("\n");
}
var DEFAULT_TURN_MAX_TOKENS, MIN_SCORE_BY_LEVEL, COMPACT_LEGEND, SKELETON_PAGERANK_PERCENTILE, PAGERANK_BLEND_WEIGHT, CWD_AFFINITY_BOOST, FEATURE_MAP_MIN_LINES;
var init_session_inject = __esm({
  "src/commands/inject-context/session-inject.ts"() {
    "use strict";
    init_backlinks();
    init_clusters();
    init_file_neuron_parse();
    init_pagerank();
    init_fts();
    init_compress_file_neuron();
    init_decay();
    init_strip();
    init_profile();
    init_reader();
    init_telemetry();
    init_tokenize();
    init_sections();
    DEFAULT_TURN_MAX_TOKENS = 150;
    MIN_SCORE_BY_LEVEL = {
      L1: 0.5,
      L2: 0.01,
      L2_L3_HYBRID: 0.01,
      L3: 0.45,
      L4: 0
    };
    COMPACT_LEGEND = "Brain idx [MM-DD T #id title (tags)] D=decision E=episodic R=reference S=semantic P=procedural \xB7 `lazybrain query #id` for full.";
    SKELETON_PAGERANK_PERCENTILE = 0.4;
    PAGERANK_BLEND_WEIGHT = 0.5;
    CWD_AFFINITY_BOOST = 1.5;
    FEATURE_MAP_MIN_LINES = 2;
  }
});

// src/commands/inject-context.ts
function turnRecallTopK(budget) {
  const tokensPerHit = 25;
  const min = 5;
  const max = 40;
  if (!Number.isFinite(budget) || budget <= 0) return min;
  return Math.min(max, Math.max(min, Math.ceil(budget / tokensPerHit)));
}
async function runInjectContext(opts) {
  const nudge = opts.nudge ?? DEFAULT_NUDGE_STYLE;
  if (opts.mode === "marker") return runMarkerInject(false, opts.cwd, nudge, opts.maxTokens);
  if (opts.mode === "highlights") return runMarkerInject(true, opts.cwd, nudge, opts.maxTokens);
  if (opts.mode === "turn") return runTurnInject(opts);
  return runSessionInject(opts);
}
function emptyTurnResult() {
  return { text: "", levelUsed: null, tokens: 0, sectionsCount: 0 };
}
async function runTurnInjectDetailed(opts) {
  const start = Date.now();
  const query = (opts.query ?? "").trim();
  if (!query || isTrivialPrompt(query)) {
    if (!opts.skipTelemetry) {
      logTelemetry({
        event: "inject",
        ts: nowIso(),
        tokens: 0,
        sections: 0,
        duration_ms: Date.now() - start
      });
    }
    return emptyTurnResult();
  }
  const budget = opts.maxTokens ?? DEFAULT_TURN_MAX_TOKENS;
  const featureMap = tryFeatureMapInject(query, opts.cwd);
  if (featureMap) {
    const tokens2 = estimateTokenCount(featureMap);
    if (tokens2 <= budget) {
      if (!opts.skipTelemetry) {
        logTelemetry({
          event: "inject",
          ts: nowIso(),
          tokens: tokens2,
          sections: 1,
          duration_ms: Date.now() - start
        });
      }
      const text2 = opts.pretty ? `# Feature map \u2014 ~${tokens2} tokens

${featureMap}` : featureMap;
      return { text: text2, levelUsed: null, tokens: tokens2, sectionsCount: 1 };
    }
  }
  const result = await route({
    query,
    topK: turnRecallTopK(budget),
    level: "auto",
    cwd: opts.cwd,
    hydrateNote: true,
    skipTelemetry: opts.skipTelemetry
  });
  const minScore = opts.minScore ?? MIN_SCORE_BY_LEVEL[result.levelUsed] ?? 0.45;
  const sessionActiveFiles = activeFiles(opts.sessionId);
  const rankedHits = sessionActiveFiles.length > 0 ? applyActiveFileBoost(result.hits, sessionActiveFiles) : result.hits;
  const seen = alreadyInjected(opts.sessionId);
  const relevant = hitsPassingMinScore(rankedHits, minScore, seen);
  if (relevant.length === 0) {
    if (!opts.skipTelemetry) {
      logTelemetry({
        event: "inject",
        ts: nowIso(),
        tokens: 0,
        sections: 0,
        duration_ms: Date.now() - start
      });
    }
    return { text: "", levelUsed: result.levelUsed, tokens: 0, sectionsCount: 0 };
  }
  const { sections, accepted, tokens } = buildTurnSections(relevant, budget, query);
  recordInjected(opts.sessionId, accepted);
  const body = sections.join("\n\n").trim();
  if (!opts.skipTelemetry) {
    logTelemetry({
      event: "inject",
      ts: nowIso(),
      tokens,
      sections: sections.length,
      duration_ms: Date.now() - start
    });
  }
  if (!body) return { text: "", levelUsed: result.levelUsed, tokens: 0, sectionsCount: 0 };
  const header = turnRecallHeader(opts.nudge ?? DEFAULT_NUDGE_STYLE);
  const headerBlock = header ? `${header}

` : "";
  const degradedNote = result.degraded ? `[NOTE] Semantic search timed out after ${(result.degraded.timeoutMs / 1e3).toFixed(0)}s on a large brain \u2014 showing fast keyword-only results instead. This may be less complete than a full semantic search.

` : "";
  const text = opts.pretty ? `# Brain recall \u2014 ${sections.length} hits, ~${tokens} tokens

${degradedNote}${headerBlock}${body}` : `${degradedNote}${headerBlock}${body}`;
  return { text, levelUsed: result.levelUsed, tokens, sectionsCount: sections.length };
}
async function runTurnInject(opts) {
  return (await runTurnInjectDetailed(opts)).text;
}
function sectionPassesUsefulnessGate(tag, content) {
  if (tag === "[FILE]") return true;
  if (/[a-z0-9-]{4,}\/[a-z0-9.-]{4,}|#[a-z0-9-]{4,}/i.test(content)) return true;
  const words = (content.match(/[a-zA-Zà-ÿÀ-Ÿ]{3,}/g) ?? []).length;
  if (words >= MIN_WORDS_FOR_USEFUL_SECTION) return true;
  return content.trim().length >= MIN_CONTENT_LENGTH;
}
function buildTurnSections(relevant, budget, query) {
  const sections = [];
  const accepted = [];
  let tokens = 0;
  const intent = detectQueryIntent(query);
  for (const hit of relevant) {
    if (!hit.note) continue;
    const compressed = tryCompressFileNeuron(hit.path, 0, 0);
    if (compressed !== null) {
      if (!sectionPassesUsefulnessGate("[FILE]", compressed)) continue;
      const estimated2 = estimateTokenCount(compressed);
      if (tokens + estimated2 > budget && sections.length > 0) break;
      sections.push(`[FILE]
${compressed}`);
      accepted.push(hit.id);
      tokens += estimated2;
      if (tokens >= budget) break;
      continue;
    }
    const prompt = selectiveStripForTurn(hit.path, hit.note, intent);
    if (!sectionPassesUsefulnessGate("[RECALL]", prompt)) continue;
    const estimated = estimateTokenCount(prompt);
    if (tokens + estimated > budget && sections.length > 0) break;
    sections.push(`[RECALL]
${prompt}`);
    accepted.push(hit.id);
    tokens += estimated;
    if (tokens >= budget) break;
  }
  return { sections, accepted, tokens };
}
var MIN_WORDS_FOR_USEFUL_SECTION, MIN_CONTENT_LENGTH;
var init_inject_context = __esm({
  "src/commands/inject-context.ts"() {
    "use strict";
    init_router();
    init_session_cache();
    init_telemetry();
    init_tokenize();
    init_markers();
    init_scoring();
    init_sections();
    init_session_inject();
    init_markers();
    init_scoring();
    init_markers();
    MIN_WORDS_FOR_USEFUL_SECTION = 2;
    MIN_CONTENT_LENGTH = 20;
  }
});

// src/commands/neighbours.ts
function runNeighbours(opts) {
  const id = opts.id.replace(/^#/, "");
  const note = getNoteById(id);
  if (!note) {
    return JSON.stringify({ status: "noop", reason: `unknown id: ${id}` });
  }
  const edges = collectEdges(note);
  if (opts.pretty) {
    const lines = edges.map((e) => `  ${e.kind}${e.via ? ` (${e.via})` : ""} \u2192 ${e.to}`);
    return `${id}
${lines.join("\n") || "  (no neighbours)"}`;
  }
  return JSON.stringify({ id, edges });
}
function collectEdges(note) {
  const edges = [];
  for (const target of split(note.replaces)) {
    edges.push({ to: target, kind: "replaces" });
  }
  for (const target of split(note.replaced_by)) {
    edges.push({ to: target, kind: "replaced-by" });
  }
  for (const target of split(note.supersedes)) {
    edges.push({ to: target, kind: "supersedes" });
  }
  for (const t of split(note.triples, ";")) {
    const parts = t.split("|");
    if (parts.length === 3) {
      edges.push({ to: parts[2], kind: "triple", via: parts[1] });
    }
  }
  const ents = split(note.entities);
  if (ents.length) {
    const seen = /* @__PURE__ */ new Set();
    for (const e of ents.slice(0, 3)) {
      for (const other of notesMentioningEntity(e, 5)) {
        if (other.id === note.id || seen.has(other.id)) continue;
        seen.add(other.id);
        edges.push({ to: other.id, kind: "shares-entity", via: e });
      }
    }
  }
  if (edges.length < 3 && note.tags) {
    const tagSet = new Set(note.tags.split(/\s+/).filter(Boolean));
    const peers = listAll({ includeExpired: false }).filter(
      (n) => n.id !== note.id && n.tags && shareAnyTag(n.tags, tagSet)
    );
    for (const p of peers.slice(0, 4)) {
      edges.push({ to: p.id, kind: "shares-cluster" });
    }
  }
  return edges.slice(0, 12);
}
function split(s, sep = ",") {
  if (!s) return [];
  return s.split(sep).map((x) => x.trim()).filter(Boolean);
}
function shareAnyTag(tagsStr, set) {
  if (!tagsStr) return false;
  for (const t of tagsStr.split(/\s+/)) {
    if (set.has(t)) return true;
  }
  return false;
}
var init_neighbours = __esm({
  "src/commands/neighbours.ts"() {
    "use strict";
    init_fts();
  }
});

// src/commands/profile-update.ts
var profile_update_exports = {};
__export(profile_update_exports, {
  isCwdPlausible: () => isCwdPlausible,
  normalizeCwd: () => normalizeCwd2,
  profileExists: () => profileExists,
  profileTextForInjection: () => profileTextForInjection,
  runProfileUpdate: () => runProfileUpdate
});
import { existsSync as existsSync23, mkdirSync as mkdirSync13, readFileSync as readFileSync25, writeFileSync as writeFileSync20 } from "node:fs";
import { dirname as dirname9, join as join25 } from "node:path";
import { parseHTML as parseHTML11 } from "linkedom";
function runProfileUpdate(opts) {
  const root = brainRoot();
  const notesPath = join25(root, PROFILE_FILE2);
  const minOcc = opts.minOccurrences ?? 3;
  const all = listAll({ includeExpired: false });
  if (all.length === 0) {
    return JSON.stringify({ status: "noop", reason: "no notes" });
  }
  const tagFreq = /* @__PURE__ */ new Map();
  for (const n of all) {
    for (const t of (n.tags ?? "").split(/\s+/).filter(Boolean)) {
      tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
  }
  const stableTags = [...tagFreq.entries()].filter(([, c]) => c >= minOcc).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const decisionFacts = [];
  for (const n of all.slice(0, 200)) {
    if (n.type !== "decision") continue;
    try {
      const html2 = readNote(n.path).html;
      const { document } = parseHTML11(`<!doctype html><html><body>${html2}</body></html>`);
      const facts = Array.from(document.querySelectorAll("[data-cerveau-fact]")).map((el) => (el.textContent ?? "").trim()).filter((t) => t.length > 10 && t.length < 200);
      if (facts.length) decisionFacts.push(facts[0]);
    } catch {
    }
  }
  const topDecisions = uniqueByPrefix(decisionFacts).slice(0, 12);
  const cwdFreq = /* @__PURE__ */ new Map();
  const log = getLogger();
  const platform = process.platform;
  for (const note of readAllNotes()) {
    try {
      const cwdMatch = note.html.match(/data-cerveau-cwd\s*=\s*"([^"]+)"/);
      if (!cwdMatch) continue;
      const raw = cwdMatch[1];
      const normalized = normalizeCwd2(raw);
      if (!isCwdPlausible(normalized, platform)) {
        log.debug({ raw, platform }, "profile-update: skipping implausible cwd");
        continue;
      }
      cwdFreq.set(normalized, (cwdFreq.get(normalized) ?? 0) + 1);
    } catch {
    }
  }
  const topCwds = [...cwdFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cwd, n]) => `${cwd} (${n})`);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const html = `<article id="${PROFILE_ID}"
         data-cerveau-version="${PKG_VERSION}"
         data-cerveau-created="${now}"
         data-cerveau-updated="${now}"
         data-cerveau-type="reference"
         data-cerveau-source="auto:profile"
         data-cerveau-tier="archival"
         data-cerveau-importance="1.0"
         data-cerveau-tags="profile user preferences">

  <h2>User profile (auto)</h2>

  <section>
    <h3>Recurring interests (stable tags)</h3>
    <ul>
${stableTags.map(([t, c]) => `      <li><code>${t}</code> \u2014 ${c} notes</li>`).join("\n")}
    </ul>
  </section>

  <section>
    <h3>Active projects (frequent working dirs)</h3>
    <ul>
${topCwds.length === 0 ? "      <li>(no cwd metadata captured yet)</li>" : topCwds.map((s) => `      <li><code>${htmlEscape2(s)}</code></li>`).join("\n")}
    </ul>
  </section>

  <section>
    <h3>Stable decisions / preferences</h3>
    <ul>
${topDecisions.length === 0 ? "      <li>(no recurring decisions yet)</li>" : topDecisions.map((d) => `      <li>${htmlEscape2(d)}</li>`).join("\n")}
    </ul>
  </section>
</article>`;
  if (!existsSync23(dirname9(notesPath))) mkdirSync13(dirname9(notesPath), { recursive: true });
  writeFileSync20(notesPath, html, "utf8");
  try {
    indexNote({
      path: notesPath,
      id: PROFILE_ID,
      html,
      sizeBytes: Buffer.byteLength(html),
      mtimeMs: Date.now()
    });
  } catch {
  }
  const payload = {
    path: notesPath,
    stable_tags: stableTags.length,
    decisions_kept: topDecisions.length,
    cwds_kept: topCwds.length,
    notes_analysed: all.length
  };
  return opts.pretty ? `User profile rebuilt:
  ${stableTags.length} stable tags, ${topDecisions.length} decisions, ${topCwds.length} cwds
  \u2192 ${notesPath}` : JSON.stringify(payload, null, 2);
}
function normalizeCwd2(cwd) {
  let s = cwd.replace(/\\/g, "/");
  s = s.replace(/\/+/g, "/");
  s = s.replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(s)) {
    s = s.toLowerCase();
  }
  return s;
}
function isCwdPlausible(cwd, platform) {
  if (platform === "win32") {
    return !/^\/(home|usr|tmp|var)\b/.test(cwd);
  }
  return !/^[a-z]:\//i.test(cwd);
}
function uniqueByPrefix(items) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const it of items) {
    const key = it.slice(0, 40).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}
function htmlEscape2(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function profileExists() {
  const path = join25(brainRoot(), PROFILE_FILE2);
  if (!existsSync23(path)) return false;
  try {
    const html = readFileSync25(path, "utf8");
    return html.includes(`id="${PROFILE_ID}"`);
  } catch {
    return false;
  }
}
var PROFILE_ID, PROFILE_FILE2;
var init_profile_update = __esm({
  "src/commands/profile-update.ts"() {
    "use strict";
    init_fts();
    init_paths();
    init_reader();
    init_logger();
    init_pkg_version();
    init_profile();
    PROFILE_ID = "_user-profile";
    PROFILE_FILE2 = "_user-profile.html";
  }
});

// src/util/brain-guard.ts
import { existsSync as existsSync24 } from "node:fs";
import { join as join26 } from "node:path";
function assertBrainExists() {
  const root = brainRoot();
  if (!existsSync24(root) || !existsSync24(join26(root, "notes"))) {
    throw new Error(
      `Brain not found at ${root}. Run 'lazybrain init' first (or set LAZYBRAIN_BRAIN_PATH).`
    );
  }
}
var init_brain_guard = __esm({
  "src/util/brain-guard.ts"() {
    "use strict";
    init_paths();
  }
});

// src/retrieval/multi-query.ts
function cacheGet2(key) {
  const e = paraphraseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.storedAt > PARAPHRASE_CACHE_TTL_MS) {
    paraphraseCache.delete(key);
    return null;
  }
  return e.paraphrases;
}
function cacheSet2(key, paraphrases) {
  if (paraphraseCache.size >= PARAPHRASE_CACHE_MAX) {
    const oldest = paraphraseCache.keys().next().value;
    if (oldest !== void 0) paraphraseCache.delete(oldest);
  }
  paraphraseCache.set(key, { paraphrases, storedAt: Date.now() });
}
async function isMultiQueryEnabled() {
  return llmAvailable("LAZYBRAIN_MULTI_QUERY");
}
async function routeWithRRF(input) {
  if (!await isMultiQueryEnabled()) return route(input);
  const variants = await getParaphrases(input.query);
  if (variants.length <= 1) return route(input);
  const overfetch = (input.topK ?? 5) * 3;
  const perQuery = await Promise.all(
    variants.map(async (q) => {
      try {
        const r = await route({ ...input, query: q, topK: overfetch });
        return r.hits;
      } catch (err) {
        getLogger().warn({ err: err.message, variant: q }, "multi-query variant failed");
        return [];
      }
    })
  );
  const fused = fuseRRF(perQuery);
  const sliced = fused.slice(0, input.topK ?? 5);
  const levels = perQuery.flatMap((hits) => hits.map((h) => h.level));
  const dominantLevel = mode(levels) ?? "L3";
  return { hits: sliced, levelUsed: dominantLevel, totalMs: 0 };
}
function fuseRRF(perQuery) {
  const merged = /* @__PURE__ */ new Map();
  const scores = /* @__PURE__ */ new Map();
  for (const hits of perQuery) {
    hits.forEach((h, idx) => {
      const rank = idx + 1;
      const inc = 1 / (RRF_K + rank);
      scores.set(h.id, (scores.get(h.id) ?? 0) + inc);
      if (!merged.has(h.id)) merged.set(h.id, h);
    });
  }
  const out = [...merged.values()].map((h) => ({ ...h, score: scores.get(h.id) ?? 0 }));
  out.sort((a, b) => b.score - a.score);
  return out;
}
function mode(arr) {
  if (arr.length === 0) return null;
  const counts = /* @__PURE__ */ new Map();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}
async function getParaphrases(query) {
  const key = query.trim().toLowerCase();
  const cached3 = cacheGet2(key);
  if (cached3) return [query, ...cached3];
  const arr = await callClaudeCliJsonArray(query, {
    system: PARAPHRASE_PROMPT,
    model: "haiku",
    timeoutMs: 15e3
  });
  if (!arr) return [query];
  const paraphrases = arr.filter((s) => typeof s === "string").map((s) => s.trim()).filter((s) => s.length >= 3 && s.length <= 200).slice(0, MAX_VARIANTS - 1);
  if (paraphrases.length === 0) return [query];
  cacheSet2(key, paraphrases);
  return [query, ...paraphrases];
}
var RRF_K, MAX_VARIANTS, PARAPHRASE_CACHE_MAX, PARAPHRASE_CACHE_TTL_MS, paraphraseCache, PARAPHRASE_PROMPT;
var init_multi_query = __esm({
  "src/retrieval/multi-query.ts"() {
    "use strict";
    init_claude_cli();
    init_logger();
    init_router();
    RRF_K = 60;
    MAX_VARIANTS = 3;
    PARAPHRASE_CACHE_MAX = 256;
    PARAPHRASE_CACHE_TTL_MS = 60 * 6e4;
    paraphraseCache = /* @__PURE__ */ new Map();
    PARAPHRASE_PROMPT = `Rewrite the user's search query as ${MAX_VARIANTS - 1} short paraphrases for retrieval over a software-engineering memory.
Each paraphrase must:
- preserve all named entities (lib names, file paths, error strings) verbatim
- vary the verbs and connectives (synonyms, voice, syntactic order)
- be 3-20 words, no quotes, no question marks

Output ONLY a JSON array of strings, no prose. Example: ["why postgres slow", "performance regression on postgresql"].`;
  }
});

// src/commands/search.ts
async function runSearch(opts) {
  assertBrainExists();
  const routeInput = {
    query: opts.query,
    topK: opts.top ?? 5,
    level: opts.mode && opts.mode.toLowerCase() !== "auto" ? opts.mode.toUpperCase() : "auto",
    diversityLambda: opts.diversity,
    includeExpired: opts.includeExpired,
    type: opts.type,
    tag: opts.tag,
    cwd: opts.cwd ?? process.env.LAZYBRAIN_CWD ?? process.cwd(),
    pageRankWeight: opts.pageRankWeight,
    sourcePrefix: opts.sourcePrefix,
    hydrateNote: true
  };
  const result = await isMultiQueryEnabled() ? await routeWithRRF(routeInput) : await route(routeInput);
  if (opts.strip) {
    if (result.hits.length === 0) {
      return `[No results for: ${opts.query}]`;
    }
    return result.hits.map((h) => h.note ? stripNoteToPrompt(h.note) : h.snippet ?? h.id).join("\n\n");
  }
  if (opts.pretty) {
    const lines = [
      `[${result.levelUsed}] ${result.hits.length} hits in ${result.totalMs}ms
`,
      ...result.hits.map(formatPretty)
    ];
    return lines.join("\n");
  }
  return JSON.stringify(
    {
      level: result.levelUsed,
      total_ms: result.totalMs,
      hits: result.hits.map((h) => ({
        id: h.id,
        path: h.path,
        score: h.score,
        level: h.level,
        note: h.note
      }))
    },
    null,
    2
  );
}
function formatPretty(h) {
  const head = `  \u2022 ${h.id}  score=${h.score.toFixed(3)}  [${h.level}]`;
  const body = h.note?.facts.length ? h.note.facts.slice(0, 2).map((f) => `      - ${f.text}`).join("\n") : `      ${(h.snippet ?? "").slice(0, 160)}`;
  return `${head}
${body}`;
}
var init_search = __esm({
  "src/commands/search.ts"() {
    "use strict";
    init_multi_query();
    init_router();
    init_strip();
    init_brain_guard();
  }
});

// src/annotator/wikilinks.ts
import { parseHTML as parseHTML13 } from "linkedom";
function resetFanInCounts() {
  autoFanInCounts.clear();
}
function isOverFanInCap(targetId) {
  const current = autoFanInCounts.get(targetId) ?? 0;
  if (current >= MAX_AUTO_FAN_IN) return true;
  autoFanInCounts.set(targetId, current + 1);
  return false;
}
function resolveLink(term, termLower, ctx) {
  if (ctx.knownEntities.has(term) || ctx.knownEntities.has(termLower)) {
    const surface = ctx.knownEntities.has(term) ? term : termLower;
    for (const [id, ref] of ctx.knownNoteIds) {
      if (ref.entities.some((e) => e.includes(surface.replace(/[^a-z0-9]/gi, "-").toLowerCase()))) {
        return { id, redLink: false };
      }
    }
  }
  for (const [id, ref] of ctx.knownNoteIds) {
    if (id === termLower || id === term.toLowerCase()) {
      return { id, redLink: false };
    }
    const noteType = ref.tags.find((t) => SUBSTRING_MATCH_EXCLUDED_TYPES.has(t));
    if (!noteType) {
      if (id.includes(termLower) || id.includes(term.toLowerCase())) {
        return { id, redLink: false };
      }
    }
    if (ref.concepts.some((c) => c.toLowerCase() === termLower)) {
      return { id, redLink: false };
    }
    if (ref.tags.some((t) => t.toLowerCase() === termLower)) {
      return { id, redLink: false };
    }
  }
  if (ctx.knownConcepts.has(term) || ctx.knownConcepts.has(termLower)) {
    const concept = ctx.knownConcepts.has(term) ? term : termLower;
    return { concept, redLink: true };
  }
  return null;
}
function hasSkipAncestor(node) {
  let parent = node.parentElement ?? null;
  while (parent) {
    if (SKIP_ANCESTORS.has(parent.tagName.toLowerCase())) return true;
    parent = parent.parentElement ?? null;
  }
  return false;
}
function isInsideEnrichmentSection(node) {
  let parent = node.parentElement ?? null;
  while (parent) {
    if (parent.tagName.toLowerCase() === "section") {
      const sectionId = parent.getAttribute("data-section") ?? "";
      if (ENRICHMENT_SECTION_IDS2.has(sectionId)) return true;
    }
    parent = parent.parentElement ?? null;
  }
  return false;
}
function extractCandidateTerms(text, ctx) {
  const terms = /* @__PURE__ */ new Set();
  const camelRe = /\b[A-Z][a-zA-Z0-9]{2,40}\b/g;
  let m;
  while (true) {
    m = camelRe.exec(text);
    if (m === null) break;
    const tok = m[0];
    const parts = splitIdentifier(tok);
    if (parts.length > 1) {
      terms.add(tok);
      for (const p of parts) {
        if (p.length >= 3 && /^[A-Z]/.test(p)) terms.add(p);
      }
    } else {
      terms.add(tok);
    }
  }
  for (const e of ctx.knownEntities) {
    if (text.includes(e)) terms.add(e);
  }
  for (const c of ctx.knownConcepts) {
    if (text.includes(c)) terms.add(c);
  }
  return [...terms];
}
function collectTextNodes(node, out) {
  for (const child of Array.from(node.childNodes)) {
    const typed = child;
    if (typed.nodeType === 3) {
      const parent = typed.parentElement ?? node;
      out.push({ node: child, parent });
    } else if (typed.nodeType === 1) {
      const el = child;
      if (!SKIP_ANCESTORS.has(el.tagName.toLowerCase())) {
        collectTextNodes(el, out);
      }
    }
  }
}
function replaceTextNodeWithLink(document, textNode, parent, matchIndex, matchLength, resolved) {
  const node = textNode;
  const text = node.textContent ?? "";
  const beforeText = text.slice(0, matchIndex);
  const matchText = text.slice(matchIndex, matchIndex + matchLength);
  const afterText = text.slice(matchIndex + matchLength);
  const anchor = document.createElement("a");
  if (resolved.redLink) {
    anchor.setAttribute("data-red-link", resolved.concept);
  } else {
    anchor.setAttribute("href", `#/note/${encodeURIComponent(resolved.id)}`);
    anchor.setAttribute("data-cerveau-link-type", "see-also");
  }
  anchor.setAttribute("data-cerveau-link-auto", "true");
  anchor.textContent = matchText;
  const afterNode = document.createTextNode(afterText);
  const beforeNode = document.createTextNode(beforeText);
  parent.replaceChild(afterNode, textNode);
  parent.insertBefore(anchor, afterNode);
  parent.insertBefore(beforeNode, anchor);
}
function findWholeWordIndex(text, term) {
  let start = 0;
  while (start <= text.length - term.length) {
    const idx = text.indexOf(term, start);
    if (idx === -1) return -1;
    const before = idx > 0 ? text[idx - 1] : " ";
    const after = idx + term.length < text.length ? text[idx + term.length] : " ";
    const isBoundaryChar = (ch) => /[a-zA-Z0-9_.\-/]/.test(ch);
    if (!isBoundaryChar(before) && !isBoundaryChar(after)) {
      return idx;
    }
    start = idx + 1;
  }
  return -1;
}
function injectWikilinks(html, ctx) {
  if (!html || ctx.knownNoteIds.size === 0) return html;
  resetFanInCounts();
  const { document } = parseHTML13(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body;
  const linkedTerms = /* @__PURE__ */ new Set();
  let linkCount = 0;
  const textNodes = [];
  if (document.createTreeWalker) {
    const walker = document.createTreeWalker(
      body,
      4
      /* NodeFilter.SHOW_TEXT */
    );
    let node = walker.nextNode();
    while (node) {
      const typed = node;
      const parent = typed.parentElement;
      if (parent) textNodes.push({ node, parent });
      node = walker.nextNode();
    }
  } else {
    collectTextNodes(body, textNodes);
  }
  const safeTextNodes = textNodes.filter(
    ({ parent }) => !hasSkipAncestor(parent) && !isInsideEnrichmentSection(parent)
  );
  for (const { node, parent } of safeTextNodes) {
    if (linkCount >= MAX_LINKS) break;
    if (SKIP_ANCESTORS.has(parent.tagName.toLowerCase())) continue;
    const textNodeTyped = node;
    const text = textNodeTyped.textContent ?? "";
    if (!text.trim()) continue;
    const candidates = extractCandidateTerms(text, ctx);
    for (const term of candidates) {
      if (linkCount >= MAX_LINKS) break;
      if (linkedTerms.has(term.toLowerCase())) continue;
      const matchIndex = findWholeWordIndex(text, term);
      if (matchIndex === -1) continue;
      const resolved = resolveLink(term, term.toLowerCase(), ctx);
      if (!resolved) continue;
      if (!resolved.redLink && isOverFanInCap(resolved.id)) continue;
      linkedTerms.add(term.toLowerCase());
      linkCount++;
      replaceTextNodeWithLink(
        document,
        node,
        parent,
        matchIndex,
        term.length,
        resolved
      );
      break;
    }
  }
  return body.innerHTML;
}
function buildWikilinkContext(notes) {
  const knownNoteIds = /* @__PURE__ */ new Map();
  const knownEntities = /* @__PURE__ */ new Set();
  const knownConcepts = /* @__PURE__ */ new Set();
  for (const n of notes) {
    const concepts = (n.concepts ?? "").split(",").filter(Boolean);
    const entities = (n.entities ?? "").split(",").filter(Boolean);
    const tags = (n.tags ?? "").split(/\s+/).filter(Boolean);
    knownNoteIds.set(n.id, { id: n.id, concepts, entities, tags });
    for (const e of entities) {
      const surface = e.split(":").pop() ?? e;
      knownEntities.add(surface.replace(/-/g, ""));
      knownEntities.add(surface);
    }
    for (const c of concepts) {
      knownConcepts.add(c);
    }
  }
  return { knownNoteIds, knownEntities, knownConcepts };
}
var SKIP_ANCESTORS, ENRICHMENT_SECTION_IDS2, MAX_LINKS, SUBSTRING_MATCH_EXCLUDED_TYPES, MAX_AUTO_FAN_IN, autoFanInCounts;
var init_wikilinks = __esm({
  "src/annotator/wikilinks.ts"() {
    "use strict";
    init_tokenize();
    SKIP_ANCESTORS = /* @__PURE__ */ new Set([
      "code",
      "pre",
      "a",
      "cite",
      "kbd",
      "script",
      "style",
      "summary",
      "details",
      "blockquote"
    ]);
    ENRICHMENT_SECTION_IDS2 = /* @__PURE__ */ new Set(["decisions", "bugs", "ideas", "rules", "qa", "activity"]);
    MAX_LINKS = 5;
    SUBSTRING_MATCH_EXCLUDED_TYPES = /* @__PURE__ */ new Set(["file-neuron", "aggregate-neuron"]);
    MAX_AUTO_FAN_IN = 50;
    autoFanInCounts = /* @__PURE__ */ new Map();
  }
});

// src/commands/build-clusters.ts
var build_clusters_exports = {};
__export(build_clusters_exports, {
  runBuildClusters: () => runBuildClusters,
  slugifyCwd: () => slugifyCwd
});
import { existsSync as existsSync26, mkdirSync as mkdirSync14, writeFileSync as writeFileSync21 } from "node:fs";
import { join as join28 } from "node:path";
function extractTopEntities(notes, limit = 10) {
  const entityCounts = /* @__PURE__ */ new Map();
  for (const note of notes) {
    if (!note.entities) continue;
    const ents = note.entities.split(/[,\s]+/).filter(Boolean);
    for (const e of ents) {
      entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
    }
  }
  return [...entityCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([e]) => e);
}
function extractHubs(notes, backlinks, limit = 3) {
  const hubMap = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const inbound = backlinks.incoming?.[note.id] ?? [];
    hubMap.set(note.id, inbound.length);
  }
  return [...hubMap.entries()].map(([id, count]) => {
    const note = notes.find((n) => n.id === id);
    return {
      id,
      title: note?.title ?? id,
      backlinks: count
    };
  }).sort((a, b) => b.backlinks - a.backlinks).slice(0, limit);
}
function buildClusterHtml(slug2, cwd, notes, hubs, entities, activeDecCount) {
  const notesHtml = notes.slice(0, 20).map(
    (n) => `<li><a href="../../notes/${n.path.split("/").slice(-2).join("/")}#${n.id}">#${n.id}</a> ${n.title}</li>`
  ).join("\n");
  const hubsHtml = hubs.map(
    (h) => `<li><a href="../../notes/.../${h.id}.html">#${h.id} ${h.title}</a> (${h.backlinks})</li>`
  ).join("\n");
  const entitiesHtml = entities.map(
    (e) => `<dt><dfn id="${e.replace(/[:/]/g, "-")}">${e}</dfn></dt><dd>Referenced in cluster</dd>`
  ).join("\n");
  const tagsHtml = notes.filter((n) => n.tags).flatMap((n) => n.tags?.split(/\s+/) ?? []).filter(Boolean).reduce((m, tag) => m.set(tag, (m.get(tag) ?? 0) + 1), /* @__PURE__ */ new Map());
  const tagsListHtml = Array.from(tagsHtml.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map((entry) => `<li><a href="#tag-${entry[0]}">${entry[0]}</a> (${entry[1]})</li>`).join("\n");
  const edgesHint = Math.max(1, Math.floor(notes.length * 1.5));
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cluster: ${slug2}</title>
  <meta name="cluster-cwd" content="${cwd}">
  <meta name="cluster-note-count" content="${notes.length}">
  <meta name="cluster-entities" content="${entities.join(", ")}">
  <meta name="cluster-hubs" content="${hubs.map((h) => h.id).join(", ")}">
  <meta name="cluster-active-decisions" content="${activeDecCount}">
  <meta name="cluster-generated-at" content="${nowIso()}">
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #333; }
    h1 { font-size: 2rem; margin: 0; }
    .cluster-summary { color: #666; font-size: 0.95rem; margin: 0.5rem 0; }
    details { margin: 1.5rem 0; }
    summary { cursor: pointer; font-weight: 600; }
    ol, ul { margin: 0.5rem 0 0 1.5rem; }
    li { margin: 0.25rem 0; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .categories { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ddd; font-size: 0.9rem; }
    footer { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #eee; color: #999; font-size: 0.85rem; }
  </style>
</head>
<body>
  <header>
    <hgroup>
      <h1>Cluster: ${slug2}</h1>
      <p class="cluster-summary">${notes.length} neurons \xB7 ${entities.length} entities \xB7 ${activeDecCount} active decisions</p>
    </hgroup>
  </header>

  <nav class="cluster-atlas" aria-label="Neurons">
    <details open>
      <summary>Hubs (top backlinks, ${hubs.length})</summary>
      <ol>
${hubsHtml}
      </ol>
    </details>

    <details open>
      <summary>Active decisions (${activeDecCount})</summary>
      <ul>
        <li>Use 'lazybrain search "decision"' to find all active decisions</li>
      </ul>
    </details>

    <details open>
      <summary>Tags by frequency</summary>
      <ol>
${tagsListHtml}
      </ol>
    </details>

    <details>
      <summary>Entities (canonical refs, ${entities.length})</summary>
      <dl>
${entitiesHtml}
      </dl>
    </details>

    <details>
      <summary>Topology summary</summary>
      <p>This cluster has ${notes.length} nodes, ~${edgesHint} edges, avg connectivity ${(edgesHint / Math.max(1, notes.length)).toFixed(1)}. Top hub neurons share core concepts.</p>
    </details>

    <details>
      <summary>All neurons (${notes.length})</summary>
      <ol>
${notesHtml}
      </ol>
    </details>
  </nav>

  <footer>
    <nav class="categories">
      Categories: <a href="../../_index.html">brain global</a> \xB7 Generated ${nowIso()}
    </nav>
  </footer>
</body>
</html>`;
}
function buildTopologyJson(slug2, cwd, notes, hubs, entities, edgesCount) {
  return {
    cluster_id: slug2,
    cwd,
    note_ids: notes.map((n) => n.id),
    entities,
    hubs,
    edges_count: edgesCount,
    generated_at: nowIso()
  };
}
async function runBuildClusters(opts) {
  try {
    const allNotes = listAll({ includeExpired: false });
    if (allNotes.length === 0) {
      return { status: "ok", clusters: 0, totalNotes: 0, paths: [] };
    }
    const cwdGroups = /* @__PURE__ */ new Map();
    for (const note of allNotes) {
      const source = note.source || "unknown";
      if (!cwdGroups.has(source)) {
        cwdGroups.set(source, []);
      }
      cwdGroups.get(source).push(note);
    }
    const backlinks = loadBacklinks();
    const activeDecs = activeDecisions(30, 1e3);
    const activeDecsBySource = /* @__PURE__ */ new Map();
    for (const dec of activeDecs) {
      const source = dec.source || "unknown";
      activeDecsBySource.set(source, (activeDecsBySource.get(source) ?? 0) + 1);
    }
    const clustersDir = join28(brainRoot(), "clusters");
    if (!existsSync26(clustersDir)) {
      mkdirSync14(clustersDir, { recursive: true });
    }
    const paths = [];
    let clusterCount = 0;
    for (const [cwd, notes] of cwdGroups) {
      if (notes.length < 3) continue;
      const slug2 = slugifyCwd(cwd);
      const clusterDir = join28(clustersDir, slug2);
      if (!existsSync26(clusterDir)) {
        mkdirSync14(clusterDir, { recursive: true });
      }
      const entities = extractTopEntities(notes, 10);
      const hubs = backlinks ? extractHubs(notes, backlinks, 3) : [];
      const activeDecCount = activeDecsBySource.get(cwd) ?? 0;
      const edgesCount = Math.max(1, Math.floor(notes.length * 1.5));
      const htmlContent = buildClusterHtml(slug2, cwd, notes, hubs, entities, activeDecCount);
      const htmlPath = join28(clusterDir, "_cluster.html");
      writeFileSync21(htmlPath, htmlContent, "utf-8");
      paths.push(htmlPath);
      const topology = buildTopologyJson(slug2, cwd, notes, hubs, entities, edgesCount);
      const jsonPath = join28(clusterDir, "_topology.json");
      writeFileSync21(jsonPath, JSON.stringify(topology, null, opts.pretty ? 2 : 0), "utf-8");
      paths.push(jsonPath);
      clusterCount++;
    }
    return {
      status: "ok",
      clusters: clusterCount,
      totalNotes: allNotes.length,
      paths
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      clusters: 0,
      totalNotes: 0,
      error: message
    };
  }
}
var init_build_clusters = __esm({
  "src/commands/build-clusters.ts"() {
    "use strict";
    init_backlinks();
    init_fts();
    init_paths();
    init_cwd_normalizer();
    init_telemetry();
  }
});

// src/commands/build-index.ts
var build_index_exports = {};
__export(build_index_exports, {
  runBuildIndex: () => runBuildIndex
});
import { writeFileSync as writeFileSync22 } from "node:fs";
import { join as join29 } from "node:path";
function extractTopTags(notes) {
  const tagCounts = /* @__PURE__ */ new Map();
  for (const note of notes) {
    if (!note.tags) continue;
    for (const tag of note.tags.split(/\s+/).filter(Boolean)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 15);
}
function extractCwds(notes) {
  const cwds = /* @__PURE__ */ new Set();
  for (const note of notes) {
    if (note.source) {
      cwds.add(note.source);
    }
  }
  return Array.from(cwds).sort();
}
function buildJsonLdGraph(_notes, entities) {
  const entityTerms = entities.map((e) => ({
    "@type": "DefinedTerm",
    "@id": `memory://${e.key}`,
    name: e.surfaces[0] ?? e.key,
    termCode: e.key,
    inDefinedTermSet: "memory://entities"
  }));
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dataset",
        "@id": "memory://lazybrain",
        name: "LazyBrain Atlas",
        size: _notes.length,
        dateModified: nowIso()
      },
      {
        "@type": "DefinedTermSet",
        "@id": "memory://entities",
        name: "Entities",
        hasDefinedTerm: entityTerms
      }
    ]
  };
}
function buildHeader(noteCount, activeDecisionCount, _entityCount, topTags, cwds) {
  const tagMetaContent = topTags.slice(0, 10).map((t) => t.tag).join(", ");
  const cwdMetaContent = cwds.join(", ") || "unknown";
  const stubCount = Math.ceil(noteCount * 0.1);
  const jsonLdGraph = buildJsonLdGraph(listAll(), listEntities());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>LazyBrain Atlas</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="cerveau-corpus-version" content="0.5.0">
  <meta name="cerveau-note-count" content="${noteCount}">
  <meta name="cerveau-active-decisions" content="${activeDecisionCount}">
  <meta name="cerveau-stub-count" content="${stubCount}">
  <meta name="cerveau-cwds" content="${cwdMetaContent}">
  <meta name="cerveau-top-tags" content="${tagMetaContent}">
  <meta name="cerveau-generated-at" content="${nowIso()}">
  <meta name="description" content="Global atlas of ${noteCount} notes across LazyBrain knowledge base">

  <!-- Canonical entity links -->
  ${listEntities().slice(0, 50).map((e) => `  <link rel="canonical" href="#${e.key}" data-entity="${e.type}:${e.key}">`).join("\n")}

  <!-- Global JSON-LD graph -->
  <script type="application/ld+json">
${JSON.stringify(jsonLdGraph, null, 2)}
  </script>

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 2rem;
    }
    header {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      margin-bottom: 2rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h1 { font-size: 2.5rem; margin-bottom: 1rem; }
    .infobox {
      background: #f9f9f9;
      border-left: 4px solid #0066cc;
      padding: 1.5rem;
      margin-top: 1.5rem;
      border-radius: 4px;
    }
    .infobox dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .infobox dt { font-weight: bold; color: #0066cc; }
    .infobox dd { color: #666; }
    .atlas {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .atlas h2 { font-size: 1.3rem; margin-bottom: 1.5rem; border-bottom: 2px solid #0066cc; padding-bottom: 0.5rem; }
    details {
      margin-bottom: 1.5rem;
    }
    summary {
      cursor: pointer;
      font-weight: bold;
      color: #0066cc;
      padding: 0.75rem;
      background: #f0f7ff;
      border-radius: 4px;
      user-select: none;
    }
    summary:hover {
      background: #e0eeff;
    }
    details[open] summary {
      background: #e0eeff;
    }
    ul {
      list-style: none;
      padding-left: 2rem;
      margin-top: 1rem;
    }
    li {
      padding: 0.5rem 0;
    }
    a {
      color: #0066cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    time {
      color: #999;
      font-size: 0.9rem;
    }
    .categories {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
    footer {
      margin-top: 3rem;
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      text-align: center;
      color: #666;
    }
    dfn {
      font-weight: bold;
      color: #0066cc;
      font-style: normal;
    }
  </style>
</head>
<body>`;
}
function buildContent(notes, topTags, entities) {
  const activeDecisions2 = notes.filter((n) => n.type === "decision");
  const stubs = notes.filter((n) => n.quality === "stub");
  const recent = notes.filter((n) => {
    if (!n.created) return false;
    const noteDate = new Date(n.created);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1e3);
    return noteDate >= weekAgo;
  });
  const formatNoteLink = (note) => {
    const shortId2 = note.id.slice(0, 8);
    const title = note.title || note.id;
    const safeTitle = escapeHtml2(title);
    const time = note.created ? `<time datetime="${note.created}">${new Date(note.created).toLocaleDateString()}</time>` : "";
    return `<li><a href="notes/${note.created?.slice(0, 7) ?? "unknown"}/${note.id}.html">#${shortId2} ${safeTitle}</a> ${time}</li>`;
  };
  let html = `
  <header>
    <h1>LazyBrain Atlas</h1>
    <aside class="infobox">
      <dl>
        <dt>Notes</dt><dd>${notes.length} total, ${notes.filter((n) => !n.valid_until).length} active</dd>
        <dt>Decisions (active)</dt><dd>${activeDecisions2.length}</dd>
        <dt>Stubs to enrich</dt><dd>${stubs.length}</dd>
        <dt>Entities registered</dt><dd>${entities.length}</dd>
        <dt>Last updated</dt><dd><time datetime="${nowIso()}">${(/* @__PURE__ */ new Date()).toLocaleString()}</time></dd>
      </dl>
    </aside>
  </header>

  <nav class="atlas" aria-label="Atlas">
    <h2>Notes by Category</h2>`;
  if (activeDecisions2.length > 0) {
    html += `
    <details open>
      <summary>Active Decisions (${activeDecisions2.length})</summary>
      <ul>
        ${activeDecisions2.slice(0, 20).map(formatNoteLink).join("\n        ")}
      </ul>
    </details>`;
  }
  for (const { tag, count } of topTags) {
    const notesWithTag = notes.filter((n) => n.tags?.includes(tag));
    html += `
    <details>
      <summary>Tag: ${escapeHtml2(tag)} (${count} notes)</summary>
      <ul>
        ${notesWithTag.slice(0, 15).map(formatNoteLink).join("\n        ")}
      </ul>
    </details>`;
  }
  if (recent.length > 0) {
    html += `
    <details>
      <summary>Recent (last 7 days)</summary>
      <ul>
        ${recent.slice(0, 15).map(formatNoteLink).join("\n        ")}
      </ul>
    </details>`;
  }
  if (stubs.length > 0) {
    html += `
    <details>
      <summary>Stubs to Enrich (${stubs.length})</summary>
      <ul>
        ${stubs.slice(0, 15).map(formatNoteLink).join("\n        ")}
      </ul>
    </details>`;
  }
  if (entities.length > 0) {
    html += `
    <details>
      <summary>Entities (${entities.length})</summary>
      <dl>`;
    for (const e of entities.slice(0, 30)) {
      const notes_mentioning = notes.filter((n) => n.entities?.includes(e.key));
      const canonical2 = notes_mentioning[0];
      const link = canonical2 ? `<a href="notes/${canonical2.created?.slice(0, 7) ?? "unknown"}/${canonical2.id}.html">#${canonical2.id.slice(0, 8)}</a>` : "<em>no notes</em>";
      html += `
        <dt><dfn id="${escapeHtml2(e.key)}">${escapeHtml2(e.surfaces[0] ?? e.key)}</dfn> <span style="color:#999">(${e.type})</span></dt>
        <dd>${link}</dd>`;
    }
    html += `
      </dl>
    </details>`;
  }
  html += `
  </nav>

  <footer>
    <nav class="categories">
      Categories: ${topTags.slice(0, 10).map((t) => `<a href="#tag-${escapeHtml2(t.tag)}">${escapeHtml2(t.tag)}</a>`).join(" \xB7 ")}
    </nav>
    <p style="margin-top: 1rem; font-size: 0.9rem;">Generated by <strong>LazyBrain</strong> \u2022 <code>lazybrain build-index</code></p>
  </footer>
</body>
</html>`;
  return html;
}
function escapeHtml2(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
async function runBuildIndex(_opts) {
  try {
    const cfg = getConfig();
    const notes = listAll({ includeExpired: false });
    const entities = listEntities();
    const topTags = extractTopTags(notes);
    const cwds = extractCwds(notes);
    const activeDecisionCount = notes.filter((n) => n.type === "decision").length;
    const content = buildContent(notes, topTags, entities);
    const html = buildHeader(notes.length, activeDecisionCount, entities.length, topTags, cwds) + content;
    const indexPath2 = join29(cfg.brainPath, "_index.html");
    writeFileSync22(indexPath2, html, "utf8");
    const sizeKB = Math.ceil(Buffer.byteLength(html, "utf8") / 1024);
    return {
      status: "ok",
      path: indexPath2,
      noteCount: notes.length,
      entityCount: entities.length,
      tagCount: topTags.length,
      activeDecisions: activeDecisionCount,
      sizeKB
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error: msg
    };
  }
}
var init_build_index = __esm({
  "src/commands/build-index.ts"() {
    "use strict";
    init_entities();
    init_fts();
    init_config();
    init_telemetry();
  }
});

// src/annotator/blocks/composers/aggregate-neuron.ts
function renderBreadcrumb3(projectName, path) {
  const normalizedPath = path.replace(/\\/g, "/");
  const pathSegments = normalizedPath ? normalizedPath.split("/").filter(Boolean) : [];
  const allSegments = [projectName, ...pathSegments];
  const links = allSegments.slice(0, -1).map((seg, i) => {
    const href = allSegments.slice(0, i + 1).join("/");
    return `<a href="#/${esc(href)}">${esc(seg)}</a>`;
  });
  const lastSegment = allSegments[allSegments.length - 1];
  const last = `<span aria-current="page">${esc(lastSegment)}</span>`;
  const crumbs = [...links, last].join(" / ");
  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}
function renderTldr3(descriptor) {
  const { kind, title, stats } = descriptor;
  const langList = stats.languages.join(", ");
  let text;
  if (kind === "project") {
    const langPart = stats.languages.length > 0 ? ` across ${stats.languages.length} language${stats.languages.length !== 1 ? "s" : ""} (${esc(langList)})` : "";
    text = `Project ${esc(title)} \u2014 ${stats.fileCount} file${stats.fileCount !== 1 ? "s" : ""}, ${stats.totalLines} lines${langPart}.`;
  } else {
    const langPart = stats.languages.length > 0 ? ` \u2014 ${esc(langList)}` : "";
    text = `Module ${esc(title)} \u2014 ${stats.fileCount} file${stats.fileCount !== 1 ? "s" : ""}, ${stats.totalLines} lines${langPart}.`;
  }
  return `<section data-section="tldr">
  <p>${text}</p>
</section>`;
}
function renderChildrenSection2(children) {
  if (children.length === 0) return "";
  const items = children.map((child) => {
    const href = `#/${esc(child.id)}`;
    const typeLabel = child.kind === "module" ? "[module]" : "[file]";
    return `<li><a href="${href}">${esc(child.title)}</a> <small>${typeLabel}</small></li>`;
  }).join("\n    ");
  return [
    '<section data-section="children">',
    "  <h3>Contents</h3>",
    "  <ul>",
    `    ${items}`,
    "  </ul>",
    "</section>"
  ].join("\n");
}
function buildTocEntries3(hasChildren, hasSeeAlso2) {
  const entries = [];
  if (hasChildren) {
    entries.push({ level: 1, id: "children", text: "Contents" });
  }
  if (hasSeeAlso2) {
    entries.push({ level: 1, id: "see-also", text: "See also" });
  }
  return entries;
}
function buildArticleId3(projectName, path) {
  const sanitized = `aggregate-${projectName}-${path || "root"}`.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").toLowerCase().slice(0, 80);
  return sanitized;
}
function composeAggregateNeuron(descriptor) {
  const now = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const { kind, title, path, projectName, children, stats, seeAlso = [] } = descriptor;
  const articleId = buildArticleId3(projectName, path);
  const infobox = renderInfobox({
    rows: [
      { label: "Kind", value: kind },
      { label: "Files", value: String(stats.fileCount) },
      { label: "Lines", value: String(stats.totalLines) },
      { label: "Languages", value: stats.languages.join(", ") }
    ]
  });
  const hasSeeAlso2 = seeAlso.length > 0;
  const hasChildren = children.length > 0;
  const tocEntries = buildTocEntries3(hasChildren, hasSeeAlso2);
  const toc = tocEntries.length > 0 ? renderToc({ entries: tocEntries }) : "";
  const seeAlsoSection = hasSeeAlso2 ? renderSeeAlso({ links: seeAlso.map((l) => ({ id: l.id, title: l.title })) }) : "";
  const canonicalProject = canonicalProjectSegment(projectName);
  const topicPath = path ? `${esc(canonicalProject)}/code/${esc(path.replace(/\\/g, "/"))}` : `${esc(canonicalProject)}/code`;
  const parts = [
    "<article",
    `  id="${esc(articleId)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-type="aggregate-neuron"`,
    `  data-cerveau-created="${now}T00:00:00Z"`,
    `  data-cerveau-source="code-scanner:aggregate"`,
    `  data-cerveau-tags="code ${esc(kind)} ${esc(projectName)} aggregate-neuron"`,
    `  data-cerveau-topic="${topicPath}"`,
    `  data-code-project="code-${esc(projectName)}"`,
    `  data-code-kind="${esc(kind)}"`,
    `  data-code-path="${esc(path.replace(/\\/g, "/"))}"`,
    ">",
    renderBreadcrumb3(projectName, path),
    `<h1>${esc(title)}</h1>`,
    infobox,
    renderTldr3(descriptor),
    toc,
    renderChildrenSection2(children),
    seeAlsoSection,
    "</article>"
  ];
  return parts.filter((p) => p.trim().length > 0).join("\n");
}
var init_aggregate_neuron = __esm({
  "src/annotator/blocks/composers/aggregate-neuron.ts"() {
    "use strict";
    init_cwd_normalizer();
    init_pkg_version();
    init_helpers();
    init_infobox();
    init_see_also();
    init_toc();
  }
});

// src/graph/symbol-excerpt.ts
function excerptFromSource(source, startLine, endLine) {
  if (!source || startLine < 1 || endLine < startLine) {
    return { jsdoc: "", excerpt: "" };
  }
  const lines = source.split("\n");
  const jsdoc = extractPrecedingJsdoc(lines, startLine);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  const body = lines.slice(from, to).join("\n");
  return { jsdoc, excerpt: capHeadTail(body, EXCERPT_HEAD_LINES, EXCERPT_TAIL_LINES) };
}
function capHeadTail(text, head, tail) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= head + tail) return text;
  return [...lines.slice(0, head), "// \u2026", ...lines.slice(-tail)].join("\n");
}
function extractPrecedingJsdoc(lines, startLine) {
  let i = startLine - 2;
  while (i >= 0 && /^\s*$/.test(lines[i])) i--;
  if (i < 0 || !lines[i].includes("*/")) return "";
  const end = i;
  while (i >= 0 && !lines[i].includes("/*")) i--;
  if (i < 0) return "";
  const block = lines.slice(i, end + 1);
  if (block.length <= JSDOC_MAX_LINES) return block.join("\n");
  return block.slice(0, JSDOC_MAX_LINES).join("\n");
}
function attachExcerpt(source, symbol) {
  const { jsdoc, excerpt } = excerptFromSource(source, symbol.startLine, symbol.endLine);
  return { ...symbol, jsdoc, excerpt };
}
var EXCERPT_HEAD_LINES, EXCERPT_TAIL_LINES, JSDOC_MAX_LINES;
var init_symbol_excerpt = __esm({
  "src/graph/symbol-excerpt.ts"() {
    "use strict";
    EXCERPT_HEAD_LINES = 30;
    EXCERPT_TAIL_LINES = 20;
    JSDOC_MAX_LINES = 20;
  }
});

// src/graph/ast-parser.ts
import { readFileSync as readFileSync29 } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { extname, join as join30 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function getWasmDir() {
  const require2 = createRequire2(import.meta.url);
  try {
    const pkg = require2.resolve("tree-sitter-wasms/package.json");
    return join30(pkg, "..", "out");
  } catch {
    const thisDir = fileURLToPath2(new URL(".", import.meta.url));
    return join30(thisDir, "..", "..", "node_modules", "tree-sitter-wasms", "out");
  }
}
function getTreeSitterWasm() {
  const require2 = createRequire2(import.meta.url);
  try {
    const pkg = require2.resolve("web-tree-sitter/package.json");
    return join30(pkg, "..", "tree-sitter.wasm");
  } catch {
    const thisDir = fileURLToPath2(new URL(".", import.meta.url));
    return join30(thisDir, "..", "..", "node_modules", "web-tree-sitter", "tree-sitter.wasm");
  }
}
async function ensureInit() {
  if (ParserClass !== null) return;
  if (initPromise !== null) {
    await initPromise;
    return;
  }
  initPromise = (async () => {
    const mod = await import("web-tree-sitter");
    const P = mod.default ?? mod;
    const wasmBinary = readFileSync29(getTreeSitterWasm());
    await P.init({ wasmBinary });
    ParserClass = P;
  })();
  await initPromise;
}
async function getParser(language) {
  if (parserCache.has(language)) {
    return parserCache.get(language);
  }
  try {
    await ensureInit();
    if (ParserClass === null) return null;
    const wasmFile = join30(getWasmDir(), LANGUAGE_TO_WASM[language]);
    const wasmBinary = readFileSync29(wasmFile);
    const lang = await ParserClass.Language.load(wasmBinary);
    const parser = new ParserClass();
    parser.setLanguage(lang);
    const entry = { parser, language };
    parserCache.set(language, entry);
    return entry;
  } catch {
    return null;
  }
}
function findAll(root, nodeType) {
  const results = [];
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.type === nodeType) results.push(node);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }
  return results;
}
function findFirst(root, nodeType) {
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node.type === nodeType) return node;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }
  return null;
}
function extractTSParams(paramsNode) {
  if (!paramsNode) return [];
  const params = [];
  const paramTypes = ["required_parameter", "optional_parameter", "rest_parameter", "identifier"];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child || !child.isNamed) continue;
    if (paramTypes.includes(child.type)) {
      const pattern = child.childForFieldName("pattern") ?? child;
      const name = pattern.type === "identifier" ? pattern.text : pattern.childForFieldName("name")?.text;
      if (name && name !== "," && name !== ")" && name !== "(") {
        params.push(name);
      }
    }
  }
  return params;
}
function isNodeExported(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "export_statement") return true;
  for (let i = 0; i < parent.childCount; i++) {
    const sib = parent.child(i);
    if (sib?.text === "export") return true;
  }
  return false;
}
function extractTSFunctions(root) {
  const results = [];
  const visited = /* @__PURE__ */ new Set();
  const funcNodes = findAll(root, "function_declaration");
  for (const fn of funcNodes) {
    if (visited.has(fn.startPosition.row)) continue;
    visited.add(fn.startPosition.row);
    const nameNode = fn.childForFieldName("name");
    if (!nameNode) continue;
    const paramsNode = fn.childForFieldName("parameters");
    const isExported = isNodeExported(fn);
    results.push({
      name: nameNode.text,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      params: extractTSParams(paramsNode),
      isExported
    });
  }
  const lexDecls = findAll(root, "lexical_declaration");
  for (const decl of lexDecls) {
    const exported = isNodeExported(decl);
    const declarators = findAll(decl, "variable_declarator");
    for (const declarator of declarators) {
      const nameNode = declarator.childForFieldName("name");
      const valueNode = declarator.childForFieldName("value");
      if (nameNode && valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression")) {
        if (visited.has(declarator.startPosition.row)) continue;
        visited.add(declarator.startPosition.row);
        const paramsNode = valueNode.childForFieldName("parameters");
        results.push({
          name: nameNode.text,
          startLine: declarator.startPosition.row + 1,
          endLine: declarator.endPosition.row + 1,
          params: extractTSParams(paramsNode),
          isExported: exported
        });
      }
    }
  }
  return results;
}
function extractTSBindings(root) {
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (name, kind, node) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    results.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: isNodeExported(node)
    });
  };
  for (const node of findAll(root, "type_alias_declaration")) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) push(nameNode.text, "type", node);
  }
  for (const node of findAll(root, "interface_declaration")) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) push(nameNode.text, "interface", node);
  }
  const arrowRows = /* @__PURE__ */ new Set();
  for (const decl of findAll(root, "lexical_declaration")) {
    for (const declarator of findAll(decl, "variable_declarator")) {
      const value = declarator.childForFieldName("value");
      if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
        arrowRows.add(declarator.startPosition.row);
      }
    }
  }
  for (const decl of findAll(root, "lexical_declaration")) {
    for (const declarator of findAll(decl, "variable_declarator")) {
      if (arrowRows.has(declarator.startPosition.row)) continue;
      const nameNode = declarator.childForFieldName("name");
      if (!nameNode) continue;
      push(nameNode.text, "const", decl);
    }
  }
  return results;
}
function extractTSClasses(root) {
  const results = [];
  const classNodes = findAll(root, "class_declaration");
  for (const cls of classNodes) {
    const nameNode = cls.childForFieldName("name");
    if (!nameNode) continue;
    let extendsClause;
    const heritage = findFirst(cls, "class_heritage");
    if (heritage) {
      const extendsNode = findFirst(heritage, "extends_clause");
      if (extendsNode) {
        for (let i = 0; i < extendsNode.childCount; i++) {
          const child = extendsNode.child(i);
          if (child?.isNamed) {
            extendsClause = child.text;
            break;
          }
        }
      }
    }
    const body = cls.childForFieldName("body");
    const methods = [];
    if (body) {
      const methodNodes = findAll(body, "method_definition");
      for (const m of methodNodes) {
        const mName = m.childForFieldName("name");
        if (mName) methods.push(mName.text);
      }
    }
    results.push({
      name: nameNode.text,
      startLine: cls.startPosition.row + 1,
      endLine: cls.endPosition.row + 1,
      methods,
      isExported: isNodeExported(cls),
      extends: extendsClause
    });
  }
  return results;
}
function extractTSImports(root) {
  const results = [];
  const importNodes = findAll(root, "import_statement");
  for (const imp of importNodes) {
    const sourceNode = imp.childForFieldName("source");
    if (!sourceNode) continue;
    const rawSource = sourceNode.text;
    const source = rawSource.slice(1, -1);
    const isRelative = source.startsWith(".") || source.startsWith("/");
    const specifiers = [];
    const clause = findFirst(imp, "import_clause");
    if (clause) {
      const firstChild = clause.child(0);
      if (firstChild?.type === "identifier") {
        specifiers.push("default");
      } else {
        const namedImports = findFirst(clause, "named_imports");
        if (namedImports) {
          const specs = findAll(namedImports, "import_specifier");
          for (const s of specs) {
            const name = s.childForFieldName("name");
            if (name) specifiers.push(name.text);
          }
        }
        const nsImport = findFirst(clause, "namespace_import");
        if (nsImport) specifiers.push("*");
      }
    }
    results.push({
      source,
      specifiers,
      line: imp.startPosition.row + 1,
      isRelative
    });
  }
  return results;
}
function extractTSExports(root) {
  const exports = [];
  const exportStmts = findAll(root, "export_statement");
  for (const stmt of exportStmts) {
    let hasDefault = false;
    for (let i = 0; i < stmt.childCount; i++) {
      if (stmt.child(i)?.text === "default") {
        hasDefault = true;
        break;
      }
    }
    if (hasDefault) {
      exports.push("default");
      continue;
    }
    const namedExports = findFirst(stmt, "export_clause");
    if (namedExports) {
      const specs = findAll(namedExports, "export_specifier");
      for (const s of specs) {
        const name = s.childForFieldName("name");
        if (name) exports.push(name.text);
      }
      continue;
    }
    for (let i = 0; i < stmt.childCount; i++) {
      const child = stmt.child(i);
      if (!child?.isNamed) continue;
      if (child.type === "function_declaration" || child.type === "class_declaration" || child.type === "interface_declaration" || child.type === "type_alias_declaration" || child.type === "enum_declaration") {
        const name = child.childForFieldName("name");
        if (name) exports.push(name.text);
      } else if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
        const declarators = findAll(child, "variable_declarator");
        for (const d of declarators) {
          const name = d.childForFieldName("name");
          if (name) exports.push(name.text);
        }
      }
    }
  }
  return [...new Set(exports)];
}
function extractPyParams(paramsNode) {
  if (!paramsNode) return [];
  const params = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child?.isNamed) continue;
    if (child.type === "identifier") {
      if (child.text !== "self" && child.text !== "cls") {
        params.push(child.text);
      }
    } else if (child.type === "typed_parameter" || child.type === "default_parameter" || child.type === "typed_default_parameter" || child.type === "list_splat_pattern" || child.type === "dictionary_splat_pattern") {
      for (let j = 0; j < child.childCount; j++) {
        const sub = child.child(j);
        if (sub?.isNamed && sub.type === "identifier") {
          if (sub.text !== "self" && sub.text !== "cls") {
            params.push(sub.text);
          }
          break;
        }
      }
    }
  }
  return params;
}
function extractPyFunctions(root) {
  const results = [];
  const funcNodes = findAll(root, "function_definition");
  for (const fn of funcNodes) {
    if (fn.parent?.type !== "module") continue;
    const nameNode = fn.childForFieldName("name");
    if (!nameNode) continue;
    const paramsNode = fn.childForFieldName("parameters");
    results.push({
      name: nameNode.text,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      params: extractPyParams(paramsNode),
      isExported: !nameNode.text.startsWith("_")
    });
  }
  return results;
}
function extractPyClasses(root) {
  const results = [];
  const classNodes = findAll(root, "class_definition");
  for (const cls of classNodes) {
    const nameNode = cls.childForFieldName("name");
    if (!nameNode) continue;
    const superclasses = cls.childForFieldName("superclasses");
    let extendsClause;
    if (superclasses) {
      extendsClause = superclasses.text.replace(/^\(|\)$/g, "").trim() || void 0;
    }
    const body = cls.childForFieldName("body");
    const methods = [];
    if (body) {
      const methodNodes = findAll(body, "function_definition");
      for (const m of methodNodes) {
        const mName = m.childForFieldName("name");
        if (mName) methods.push(mName.text);
      }
    }
    results.push({
      name: nameNode.text,
      startLine: cls.startPosition.row + 1,
      endLine: cls.endPosition.row + 1,
      methods,
      isExported: !nameNode.text.startsWith("_"),
      extends: extendsClause
    });
  }
  return results;
}
function extractPyImports(root) {
  const results = [];
  const importNodes = findAll(root, "import_statement");
  for (const imp of importNodes) {
    const names = findAll(imp, "dotted_name");
    for (const name of names) {
      const source = name.text.replace(/\./g, "/");
      results.push({
        source,
        specifiers: [],
        line: imp.startPosition.row + 1,
        isRelative: false
      });
    }
  }
  const fromNodes = findAll(root, "import_from_statement");
  for (const imp of fromNodes) {
    const modNode = imp.childForFieldName("module_name");
    if (!modNode) continue;
    const source = modNode.text.replace(/\./g, "/");
    const isRelative = modNode.text.startsWith(".");
    const names = findAll(imp, "dotted_name").slice(1);
    const specifiers = names.map((n) => n.text);
    const wildcard = findFirst(imp, "wildcard_import");
    if (wildcard) specifiers.push("*");
    results.push({
      source,
      specifiers,
      line: imp.startPosition.row + 1,
      isRelative
    });
  }
  return results;
}
function extractPyExports(root) {
  const exports = [];
  const funcs = findAll(root, "function_definition").filter((f) => f.parent?.type === "module");
  for (const fn of funcs) {
    const name = fn.childForFieldName("name");
    if (name && !name.text.startsWith("_")) exports.push(name.text);
  }
  const classes = findAll(root, "class_definition").filter((c) => c.parent?.type === "module");
  for (const cls of classes) {
    const name = cls.childForFieldName("name");
    if (name && !name.text.startsWith("_")) exports.push(name.text);
  }
  const assignments = findAll(root, "assignment");
  for (const assign of assignments) {
    const left = assign.childForFieldName("left");
    if (left?.text === "__all__") {
      const right = assign.childForFieldName("right");
      if (right) {
        const strings = findAll(right, "string");
        for (const s of strings) {
          const content = s.text.slice(1, -1);
          if (content) exports.push(content);
        }
      }
    }
  }
  return [...new Set(exports)];
}
function resolveNodeName(node) {
  const fieldNames = ["name", "identifier"];
  for (const field of fieldNames) {
    const candidate = node.childForFieldName(field);
    if (candidate?.type === "identifier" || candidate?.type === "type_identifier" || candidate?.type === "simple_identifier" || candidate?.type === "constant") {
      return candidate.text;
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && child.type === "type_spec") {
      const name = resolveNodeName(child);
      if (name) return name;
    }
  }
  const identTypes = /* @__PURE__ */ new Set([
    "identifier",
    "type_identifier",
    "simple_identifier",
    "constant",
    "field_identifier"
  ]);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && identTypes.has(child.type)) {
      return child.text;
    }
  }
  return null;
}
function extractGenericFunctions(root, config) {
  const results = [];
  for (const nodeType of config.nodeTypes.function) {
    const nodes = findAll(root, nodeType);
    for (const fn of nodes) {
      const name = resolveNodeName(fn);
      if (!name) continue;
      results.push({
        name,
        startLine: fn.startPosition.row + 1,
        endLine: fn.endPosition.row + 1,
        params: [],
        // param extraction is grammar-specific; omitted for generics
        isExported: true
        // conservative default — caller can filter
      });
    }
  }
  return results;
}
function extractGenericClasses(root, config) {
  const results = [];
  for (const nodeType of config.nodeTypes.class) {
    const nodes = findAll(root, nodeType);
    for (const cls of nodes) {
      const name = resolveNodeName(cls);
      if (!name) continue;
      const methods = [];
      for (const fnType of config.nodeTypes.function) {
        const methodNodes = findAll(cls, fnType);
        for (const m of methodNodes) {
          const mName = resolveNodeName(m);
          if (mName) methods.push(mName);
        }
      }
      results.push({
        name,
        startLine: cls.startPosition.row + 1,
        endLine: cls.endPosition.row + 1,
        methods,
        isExported: true
        // conservative default
      });
    }
  }
  return results;
}
function resolveImportSource(node) {
  const pathField = node.childForFieldName("path");
  if (pathField) return pathField.text.replace(/^["']|["']$/g, "");
  const sourceField = node.childForFieldName("source");
  if (sourceField) return sourceField.text.replace(/^["']|["']$/g, "");
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "string_literal" || child.type === "raw_string_literal" || child.type === "string" || child.type === "scoped_identifier" || child.type === "qualified_identifier") {
      return child.text.replace(/^["']|["']$/g, "");
    }
    if (child.type === "interpreted_string_literal") {
      return child.text.replace(/^"|"$/g, "");
    }
    if (child.type === "system_lib_string") {
      return child.text.replace(/^<|>$/g, "");
    }
    if (child.type === "string_content") {
      return child.text;
    }
  }
  return null;
}
function extractGenericImports(root, config) {
  const results = [];
  for (const nodeType of config.nodeTypes.import) {
    const nodes = findAll(root, nodeType);
    for (const imp of nodes) {
      const source = resolveImportSource(imp);
      if (!source) continue;
      const cleanSource = source.replace(/^<|>$/g, "");
      const isRelative = cleanSource.startsWith(".") || cleanSource.startsWith("/");
      results.push({
        source: cleanSource,
        specifiers: [],
        line: imp.startPosition.row + 1,
        isRelative
      });
    }
  }
  return results;
}
function extractGenericExports(root, config, language) {
  const exports = [];
  const allNodeTypes = [...config.nodeTypes.function, ...config.nodeTypes.class];
  for (const nodeType of allNodeTypes) {
    const nodes = findAll(root, nodeType);
    for (const node of nodes) {
      const name = resolveNodeName(node);
      if (!name) continue;
      const exported = isGenericNodeExported(node, name, language);
      if (exported) exports.push(name);
    }
  }
  return [...new Set(exports)];
}
function isGenericNodeExported(node, name, language) {
  switch (language) {
    case "go":
      return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
    case "rust": {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === "visibility_modifier") return true;
        if (child.text === "pub") return true;
      }
      return false;
    }
    case "ruby":
      return !name.startsWith("_");
    case "java":
    case "csharp":
    case "kotlin":
    case "swift":
    case "php": {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.text === "public") return true;
      }
      const modifiers = node.childForFieldName("modifiers");
      if (modifiers) {
        for (let i = 0; i < modifiers.childCount; i++) {
          if (modifiers.child(i)?.text === "public") return true;
        }
      }
      return false;
    }
    case "c":
    case "cpp":
      return true;
    default:
      return true;
  }
}
async function parseFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  const language = EXTENSION_TO_LANGUAGE[ext];
  if (!language) return null;
  let content;
  try {
    content = readFileSync29(filePath, "utf8");
  } catch {
    return null;
  }
  const entry = await getParser(language);
  if (!entry) return null;
  let tree;
  try {
    tree = entry.parser.parse(content);
  } catch {
    return null;
  }
  try {
    const root = tree.rootNode;
    const lineCount = content.split("\n").length;
    const isTS = language === "typescript" || language === "tsx" || language === "javascript";
    const isPython = language === "python";
    let functions;
    let classes;
    let bindings = [];
    let imports;
    let exports;
    if (isTS) {
      functions = extractTSFunctions(root);
      classes = extractTSClasses(root);
      bindings = extractTSBindings(root);
      imports = extractTSImports(root);
      exports = extractTSExports(root);
    } else if (isPython) {
      functions = extractPyFunctions(root);
      classes = extractPyClasses(root);
      imports = extractPyImports(root);
      exports = extractPyExports(root);
    } else {
      const config = LANGUAGE_CONFIGS[language];
      functions = extractGenericFunctions(root, config);
      classes = extractGenericClasses(root, config);
      imports = extractGenericImports(root, config);
      exports = extractGenericExports(root, config, language);
    }
    const withExcerpts = (items) => items.map((item) => attachExcerpt(content, item));
    return {
      path: filePath,
      language,
      lineCount,
      functions: withExcerpts(functions),
      classes: withExcerpts(classes),
      bindings: withExcerpts(bindings),
      imports,
      exports
    };
  } finally {
    if (tree && typeof tree.delete === "function") {
      tree.delete();
    }
  }
}
var EXTENSION_TO_LANGUAGE, LANGUAGE_TO_WASM, LANGUAGE_CONFIGS, ParserClass, initPromise, parserCache;
var init_ast_parser = __esm({
  "src/graph/ast-parser.ts"() {
    "use strict";
    init_symbol_excerpt();
    EXTENSION_TO_LANGUAGE = {
      ".ts": "typescript",
      ".tsx": "tsx",
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".py": "python",
      ".go": "go",
      ".rs": "rust",
      ".java": "java",
      ".rb": "ruby",
      ".c": "c",
      ".h": "c",
      ".cpp": "cpp",
      ".hpp": "cpp",
      ".cc": "cpp",
      ".php": "php",
      ".cs": "csharp",
      ".swift": "swift",
      ".kt": "kotlin",
      ".kts": "kotlin"
    };
    LANGUAGE_TO_WASM = {
      typescript: "tree-sitter-typescript.wasm",
      tsx: "tree-sitter-tsx.wasm",
      javascript: "tree-sitter-javascript.wasm",
      python: "tree-sitter-python.wasm",
      go: "tree-sitter-go.wasm",
      rust: "tree-sitter-rust.wasm",
      java: "tree-sitter-java.wasm",
      ruby: "tree-sitter-ruby.wasm",
      c: "tree-sitter-c.wasm",
      cpp: "tree-sitter-cpp.wasm",
      php: "tree-sitter-php.wasm",
      csharp: "tree-sitter-c_sharp.wasm",
      swift: "tree-sitter-swift.wasm",
      kotlin: "tree-sitter-kotlin.wasm"
    };
    LANGUAGE_CONFIGS = {
      typescript: {
        wasmFile: "tree-sitter-typescript.wasm",
        nodeTypes: {
          function: ["function_declaration"],
          class: ["class_declaration"],
          import: ["import_statement"]
        }
      },
      tsx: {
        wasmFile: "tree-sitter-tsx.wasm",
        nodeTypes: {
          function: ["function_declaration"],
          class: ["class_declaration"],
          import: ["import_statement"]
        }
      },
      javascript: {
        wasmFile: "tree-sitter-javascript.wasm",
        nodeTypes: {
          function: ["function_declaration"],
          class: ["class_declaration"],
          import: ["import_statement"]
        }
      },
      python: {
        wasmFile: "tree-sitter-python.wasm",
        nodeTypes: {
          function: ["function_definition"],
          class: ["class_definition"],
          import: ["import_statement", "import_from_statement"]
        }
      },
      go: {
        wasmFile: "tree-sitter-go.wasm",
        nodeTypes: {
          function: ["function_declaration", "method_declaration"],
          class: ["type_declaration"],
          // import_spec is the leaf node that actually holds the path string;
          // import_declaration / import_spec_list are containers
          import: ["import_spec"]
        }
      },
      rust: {
        wasmFile: "tree-sitter-rust.wasm",
        nodeTypes: {
          function: ["function_item"],
          class: ["struct_item", "enum_item", "trait_item", "impl_item"],
          import: ["use_declaration"]
        }
      },
      java: {
        wasmFile: "tree-sitter-java.wasm",
        nodeTypes: {
          function: ["method_declaration", "constructor_declaration"],
          class: ["class_declaration", "interface_declaration", "enum_declaration"],
          import: ["import_declaration"]
        }
      },
      ruby: {
        wasmFile: "tree-sitter-ruby.wasm",
        nodeTypes: {
          function: ["method", "singleton_method"],
          class: ["class", "module"],
          import: ["call"]
          // require / require_relative are method calls in Ruby grammar
        }
      },
      c: {
        wasmFile: "tree-sitter-c.wasm",
        nodeTypes: {
          function: ["function_definition"],
          class: ["struct_specifier", "union_specifier", "enum_specifier"],
          import: ["preproc_include"]
        }
      },
      cpp: {
        wasmFile: "tree-sitter-cpp.wasm",
        nodeTypes: {
          function: ["function_definition"],
          class: ["class_specifier", "struct_specifier"],
          import: ["preproc_include"]
        }
      },
      php: {
        wasmFile: "tree-sitter-php.wasm",
        nodeTypes: {
          function: ["function_definition", "method_declaration"],
          class: ["class_declaration", "interface_declaration", "trait_declaration"],
          import: ["namespace_use_declaration"]
        }
      },
      csharp: {
        wasmFile: "tree-sitter-c_sharp.wasm",
        nodeTypes: {
          function: ["method_declaration", "constructor_declaration", "local_function_statement"],
          class: [
            "class_declaration",
            "interface_declaration",
            "struct_declaration",
            "record_declaration"
          ],
          import: ["using_directive"]
        }
      },
      swift: {
        wasmFile: "tree-sitter-swift.wasm",
        nodeTypes: {
          function: ["function_declaration"],
          class: [
            "class_declaration",
            "struct_declaration",
            "protocol_declaration",
            "enum_declaration"
          ],
          import: ["import_declaration"]
        }
      },
      kotlin: {
        wasmFile: "tree-sitter-kotlin.wasm",
        nodeTypes: {
          function: ["function_declaration", "anonymous_function"],
          class: ["class_declaration", "object_declaration", "interface_declaration"],
          import: ["import_header"]
        }
      }
    };
    ParserClass = null;
    initPromise = null;
    parserCache = /* @__PURE__ */ new Map();
  }
});

// src/graph/code-scanner.ts
import { existsSync as existsSync27, readFileSync as readFileSync30, readdirSync as readdirSync7, statSync as statSync9 } from "node:fs";
import { basename as basename2, extname as extname2, join as join31, relative } from "node:path";
function classifyFile(ext, filePath) {
  if (filePath.includes("test") || filePath.includes("spec") || filePath.includes("__tests__"))
    return "test";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  if (DOC_EXTENSIONS.has(ext)) return "document";
  if (CODE_EXTENSIONS.has(ext)) return "file";
  return "file";
}
function detectLanguage(ext) {
  const map = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".c": "c",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".dart": "dart",
    ".php": "php",
    ".lua": "lua"
  };
  return map[ext] ?? "unknown";
}
function extractImports(content, language) {
  const imports = [];
  if (language === "typescript" || language === "javascript") {
    const esm = content.matchAll(/(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g);
    for (const m of esm) imports.push(m[1]);
    const cjs = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of cjs) imports.push(m[1]);
  } else if (language === "python") {
    const py = content.matchAll(/(?:from\s+(\S+)\s+import|^import\s+(\S+))/gm);
    for (const m of py) imports.push(m[1] ?? m[2]);
  }
  return [...new Set(imports.filter((i) => i.startsWith(".") || i.startsWith("/")))];
}
function extractExports(content, language) {
  const exports = [];
  if (language === "typescript" || language === "javascript") {
    const named = content.matchAll(
      /export\s+(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g
    );
    for (const m of named) exports.push(m[1]);
    if (/export\s+default/.test(content)) exports.push("default");
  }
  return [...new Set(exports)];
}
function resolveImport(fromPath, importPath, nodes) {
  const dir = fromPath.split("/").slice(0, -1).join("/");
  const parts = importPath.split("/");
  let resolved = dir;
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      resolved = resolved.split("/").slice(0, -1).join("/");
    } else {
      resolved = resolved ? `${resolved}/${part}` : part;
    }
  }
  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.jsx`,
    `${resolved}.py`,
    `${resolved}/index.ts`,
    `${resolved}/index.js`
  ];
  for (const candidate of candidates) {
    if (nodes.has(candidate)) return candidate;
  }
  return null;
}
function guessTestedFile(testPath, nodes) {
  const stripped = testPath.replace(/\.test\.(ts|tsx|js|jsx)$/, ".$1").replace(/\.spec\.(ts|tsx|js|jsx)$/, ".$1").replace(/__tests__\//, "").replace(/tests?\//, "");
  if (nodes.has(stripped) && stripped !== testPath) return stripped;
  return null;
}
function scanProject(projectRoot) {
  if (!existsSync27(projectRoot)) return null;
  const projectName = basename2(projectRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const nodes = [];
  const edges = [];
  const languages = {};
  function walk2(dir, depth) {
    if (nodes.length >= MAX_FILES) return;
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync7(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!entries) return;
    for (const entry of entries) {
      if (nodes.length >= MAX_FILES) break;
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue;
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk2(join31(dir, entry.name), depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname2(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext) && !CONFIG_EXTENSIONS.has(ext)) continue;
      const fullPath = join31(dir, entry.name);
      let stat;
      try {
        stat = statSync9(fullPath);
      } catch {
        continue;
      }
      if (!stat || stat.size > MAX_FILE_SIZE) continue;
      const relPath = relative(projectRoot, fullPath).replace(/\\/g, "/");
      const type = classifyFile(ext, relPath);
      const language = detectLanguage(ext);
      let content;
      try {
        content = readFileSync30(fullPath, "utf8");
      } catch {
        continue;
      }
      const lineCount = content.split("\n").length;
      const imports = extractImports(content, language);
      const fileExports = extractExports(content, language);
      nodes.push({
        id: `file:${relPath}`,
        title: relPath,
        type,
        filePath: relPath,
        projectRoot,
        language,
        lineCount,
        imports,
        exports: fileExports
      });
      languages[language] = (languages[language] ?? 0) + 1;
    }
  }
  walk2(projectRoot, 0);
  const fileNodesByPath = new Map(nodes.map((n) => [n.filePath, n]));
  for (const node of nodes) {
    for (const imp of node.imports) {
      const resolved = resolveImport(node.filePath, imp, fileNodesByPath);
      if (resolved) {
        edges.push({
          source: node.id,
          target: `file:${resolved}`,
          type: "imports",
          confidence: "extracted",
          confidenceScore: 1
        });
      }
    }
    if (node.type === "test") {
      const testedFile = guessTestedFile(node.filePath, fileNodesByPath);
      if (testedFile) {
        edges.push({
          source: `file:${testedFile}`,
          target: node.id,
          type: "tested-by",
          confidence: "extracted",
          confidenceScore: 1
        });
      }
    }
  }
  return {
    projectRoot,
    projectName,
    nodes,
    edges,
    stats: {
      files: nodes.length,
      modules: nodes.filter((n) => n.type === "file").length,
      languages
    }
  };
}
function buildFileNeuronSeeAlso(node, allNodes, edges) {
  const seen = /* @__PURE__ */ new Set([node.id]);
  const result = [];
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    if (result.length >= MAX_SEE_ALSO_LINKS) break;
    let peerId = null;
    if ((edge.type === "imports" || edge.type === "tested-by" || edge.type === "configures") && edge.source === node.id) {
      peerId = edge.target;
    } else if ((edge.type === "imports" || edge.type === "tested-by" || edge.type === "configures") && edge.target === node.id) {
      peerId = edge.source;
    }
    if (peerId !== null && !seen.has(peerId)) {
      const peer = nodeById.get(peerId);
      if (peer && (peer.type === "file" || peer.type === "test")) {
        seen.add(peerId);
        result.push({ id: peerId, title: peer.filePath });
      }
    }
  }
  if (result.length < MAX_SEE_ALSO_LINKS) {
    const normalizedPath = node.filePath.replace(/\\/g, "/");
    const lastSlash = normalizedPath.lastIndexOf("/");
    const parentDir = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : "";
    for (const sibling of allNodes) {
      if (result.length >= MAX_SEE_ALSO_LINKS) break;
      if (seen.has(sibling.id)) continue;
      if (sibling.type !== "file" && sibling.type !== "test") continue;
      const siblingPath = sibling.filePath.replace(/\\/g, "/");
      const siblingSlash = siblingPath.lastIndexOf("/");
      const siblingDir = siblingSlash >= 0 ? siblingPath.slice(0, siblingSlash) : "";
      if (siblingDir === parentDir) {
        seen.add(sibling.id);
        result.push({ id: sibling.id, title: sibling.filePath });
      }
    }
  }
  return result;
}
function codeNodesToNotes(result, existingEnrichmentById) {
  const { nodes, edges } = result;
  if (nodes.length === 0) return [];
  const fanIn = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    if (edge.type === "imports") {
      fanIn.set(edge.target, (fanIn.get(edge.target) ?? 0) + 1);
    }
  }
  const sourceNodes = nodes.filter((n) => n.type === "file" || n.type === "test");
  const sorted = [...sourceNodes].sort((a, b) => {
    const fanA = fanIn.get(a.id) ?? 0;
    const fanB = fanIn.get(b.id) ?? 0;
    if (fanB !== fanA) return fanB - fanA;
    return b.exports.length - a.exports.length;
  });
  const capped = sorted.slice(0, MAX_FILE_NEURONS_PER_PROJECT);
  if (sorted.length > MAX_FILE_NEURONS_PER_PROJECT) {
    const log = getLogger();
    log.warn(
      {
        total: sorted.length,
        cap: MAX_FILE_NEURONS_PER_PROJECT,
        projectRoot: nodes[0]?.projectRoot ?? "unknown"
      },
      "codeNodesToNotes: file-neuron count exceeds cap \u2014 keeping highest-importance files"
    );
  }
  return capped.map((node) => {
    const inbound = fanIn.get(node.id) ?? 0;
    const seeAlso = buildFileNeuronSeeAlso(node, capped, edges);
    const enrichment = existingEnrichmentById?.get(node.id);
    return composeFileNeuron(node, inbound, enrichment, seeAlso);
  });
}
function buildAggregateNeuronSeeAlso(dir, allDirs, dirToFiles, edges) {
  if (dir === "") return [];
  const seen = /* @__PURE__ */ new Set([dir]);
  const result = [];
  const fileToDir = /* @__PURE__ */ new Map();
  for (const [d, files] of dirToFiles) {
    for (const f of files) {
      fileToDir.set(f.id, d);
    }
  }
  const ownFiles = new Set((dirToFiles.get(dir) ?? []).map((n) => n.id));
  for (const edge of edges) {
    if (result.length >= MAX_AGGREGATE_SEE_ALSO_LINKS) break;
    if (edge.type !== "imports") continue;
    const srcDir = fileToDir.get(edge.source);
    const tgtDir = fileToDir.get(edge.target);
    let peerDir;
    if (ownFiles.has(edge.source) && tgtDir !== void 0 && tgtDir !== dir) {
      peerDir = tgtDir;
    } else if (ownFiles.has(edge.target) && srcDir !== void 0 && srcDir !== dir) {
      peerDir = srcDir;
    }
    if (peerDir !== void 0 && !seen.has(peerDir) && allDirs.has(peerDir)) {
      seen.add(peerDir);
      result.push({
        id: `module:${peerDir}`,
        title: peerDir.split("/").pop() ?? peerDir
      });
    }
  }
  if (result.length < MAX_AGGREGATE_SEE_ALSO_LINKS) {
    const lastSlash = dir.lastIndexOf("/");
    const parentDir = lastSlash >= 0 ? dir.slice(0, lastSlash) : "";
    for (const candidate of allDirs) {
      if (result.length >= MAX_AGGREGATE_SEE_ALSO_LINKS) break;
      if (seen.has(candidate) || candidate === "" || candidate === dir) continue;
      const candidateLastSlash = candidate.lastIndexOf("/");
      const candidateParent = candidateLastSlash >= 0 ? candidate.slice(0, candidateLastSlash) : "";
      if (candidateParent === parentDir) {
        seen.add(candidate);
        result.push({
          id: `module:${candidate}`,
          title: candidate.split("/").pop() ?? candidate
        });
      }
    }
  }
  return result;
}
function buildAggregateNeurons(result) {
  const { nodes, edges, projectName } = result;
  const sourceNodes = nodes.filter((n) => n.type === "file" || n.type === "test");
  if (sourceNodes.length === 0) return [];
  const dirToFiles = /* @__PURE__ */ new Map();
  for (const node of sourceNodes) {
    const normalized = node.filePath.replace(/\\/g, "/");
    const slashIdx = normalized.lastIndexOf("/");
    const dir = slashIdx >= 0 ? normalized.slice(0, slashIdx) : "";
    const existing = dirToFiles.get(dir);
    if (existing) {
      existing.push(node);
    } else {
      dirToFiles.set(dir, [node]);
    }
  }
  const allDirs = new Set(dirToFiles.keys());
  for (const dir of [...allDirs]) {
    let current = dir;
    while (current.includes("/")) {
      current = current.slice(0, current.lastIndexOf("/"));
      allDirs.add(current);
    }
    if (current !== "") allDirs.add("");
  }
  const sortedDirs = [...allDirs].sort((a, b) => {
    const depthA = a === "" ? 0 : a.split("/").length;
    const depthB = b === "" ? 0 : b.split("/").length;
    return depthB - depthA;
  });
  const dirToDescriptor = /* @__PURE__ */ new Map();
  const aggregates = [];
  for (const dir of sortedDirs) {
    const filesInDir = dirToFiles.get(dir) ?? [];
    const isRoot = dir === "";
    const subDirs = [...dirToDescriptor.keys()].filter((d) => {
      if (d === "" || d === dir) return false;
      const normalized = d.replace(/\\/g, "/");
      if (isRoot) {
        return !normalized.includes("/");
      }
      const prefix = `${dir}/`;
      if (!normalized.startsWith(prefix)) return false;
      const remainder = normalized.slice(prefix.length);
      return !remainder.includes("/");
    });
    const directFileCount = filesInDir.length;
    const directLines = filesInDir.reduce((sum, n) => sum + n.lineCount, 0);
    const directLangs = [...new Set(filesInDir.map((n) => n.language))];
    const fileChildren = filesInDir.map((n) => ({
      id: n.id,
      title: n.filePath.replace(/\\/g, "/").split("/").pop() ?? n.filePath,
      kind: "file"
    }));
    const subModuleChildren = subDirs.map((d) => ({
      id: `module:${d}`,
      title: d.split("/").pop() ?? d,
      kind: "module"
    }));
    const children = [...subModuleChildren, ...fileChildren];
    const totalFileCount = isRoot ? sourceNodes.length : directFileCount;
    const totalLines = isRoot ? sourceNodes.reduce((sum, n) => sum + n.lineCount, 0) : directLines;
    const allLangs = isRoot ? [...new Set(sourceNodes.map((n) => n.language))] : directLangs;
    const id = isRoot ? `project:${projectName}` : `module:${dir}`;
    const kind = isRoot ? "project" : "module";
    const title = isRoot ? projectName : dir;
    const seeAlso = buildAggregateNeuronSeeAlso(dir, allDirs, dirToFiles, edges);
    const descriptor = {
      id,
      kind,
      title,
      path: dir,
      projectName,
      children,
      stats: {
        fileCount: totalFileCount,
        totalLines,
        languages: allLangs
      },
      ...seeAlso.length > 0 ? { seeAlso } : {},
      ...isRoot && subDirs.length > 0 ? {
        subModules: subDirs.map((d) => ({
          id: `module:${d}`,
          title: d.split("/").pop() ?? d
        }))
      } : {}
    };
    dirToDescriptor.set(dir, descriptor);
    aggregates.push(descriptor);
  }
  return aggregates;
}
async function scanProjectAsync(projectRoot) {
  const base = scanProject(projectRoot);
  if (!base) return null;
  const CONCURRENCY = 8;
  const enrichNode = async (node) => {
    const fullPath = join31(node.projectRoot, node.filePath);
    try {
      const parsed = await parseFile(fullPath);
      if (!parsed) return node;
      const astImports = parsed.imports.filter((imp) => imp.isRelative).map((imp) => imp.source);
      return {
        ...node,
        imports: astImports.length > 0 || parsed.imports.length > 0 ? astImports : node.imports,
        exports: parsed.exports.length > 0 ? parsed.exports : node.exports,
        astFunctions: parsed.functions,
        astClasses: parsed.classes,
        astBindings: parsed.bindings.length > 0 ? parsed.bindings : void 0,
        astParsed: true
      };
    } catch {
      return node;
    }
  };
  const updatedNodes = [];
  for (let i = 0; i < base.nodes.length; i += CONCURRENCY) {
    const batch = base.nodes.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(batch.map(enrichNode));
    updatedNodes.push(...enriched);
  }
  const fileNodesByPath = new Map(updatedNodes.map((n) => [n.filePath, n]));
  const astEdges = base.edges.filter((e) => e.type !== "imports");
  for (const node of updatedNodes) {
    for (const imp of node.imports) {
      const resolved = resolveImport(node.filePath, imp, fileNodesByPath);
      if (resolved) {
        astEdges.push({
          source: node.id,
          target: `file:${resolved}`,
          type: "imports",
          confidence: "extracted",
          confidenceScore: 1
        });
      }
    }
  }
  return {
    ...base,
    nodes: updatedNodes,
    edges: astEdges
  };
}
var MAX_FILE_NEURONS_PER_PROJECT, CODE_EXTENSIONS, CONFIG_EXTENSIONS, DOC_EXTENSIONS, IGNORE_DIRS, MAX_FILES, MAX_FILE_SIZE, MAX_DEPTH, MAX_SEE_ALSO_LINKS, MAX_AGGREGATE_SEE_ALSO_LINKS;
var init_code_scanner = __esm({
  "src/graph/code-scanner.ts"() {
    "use strict";
    init_file_neuron();
    init_logger();
    init_ast_parser();
    MAX_FILE_NEURONS_PER_PROJECT = Number.parseInt(process.env.LAZYBRAIN_MAX_FILE_NEURONS ?? "400", 10) || 400;
    CODE_EXTENSIONS = /* @__PURE__ */ new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".rb",
      ".go",
      ".rs",
      ".java",
      ".kt",
      ".c",
      ".cpp",
      ".h",
      ".hpp",
      ".cs",
      ".swift",
      ".dart",
      ".lua",
      ".php"
    ]);
    CONFIG_EXTENSIONS = /* @__PURE__ */ new Set([
      ".json",
      ".yaml",
      ".yml",
      ".toml",
      ".ini",
      ".env",
      ".xml",
      ".graphql",
      ".prisma",
      ".sql"
    ]);
    DOC_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".txt", ".rst", ".adoc"]);
    IGNORE_DIRS = /* @__PURE__ */ new Set([
      "node_modules",
      ".git",
      ".next",
      "dist",
      "build",
      "__pycache__",
      ".expo",
      ".cache",
      "coverage",
      ".turbo",
      ".vercel",
      "vendor",
      "target",
      "venv",
      ".venv",
      "env",
      ".env"
    ]);
    MAX_FILES = 500;
    MAX_FILE_SIZE = 1e5;
    MAX_DEPTH = 20;
    MAX_SEE_ALSO_LINKS = 5;
    MAX_AGGREGATE_SEE_ALSO_LINKS = 5;
  }
});

// src/graph/entities.ts
import { parseHTML as parseHTML14 } from "linkedom";
function buildEntityIndex(notes) {
  const log = getLogger();
  const byId = /* @__PURE__ */ new Map();
  const bySurface = /* @__PURE__ */ new Map();
  const sortedNotes = [...notes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const tagDocFreq = /* @__PURE__ */ new Map();
  for (const n of sortedNotes) {
    for (const t of (n.tags ?? "").split(/\s+/).filter(Boolean)) {
      const key = t.toLowerCase();
      tagDocFreq.set(key, (tagDocFreq.get(key) ?? 0) + 1);
    }
  }
  const tooGenericThreshold = Math.max(2, Math.floor(sortedNotes.length * TOO_GENERIC_RATIO));
  for (const n of sortedNotes) {
    const aliases = [];
    if (n.title && n.title.length >= 4) aliases.push(n.title);
    for (const t of (n.tags ?? "").split(/\s+/).filter(Boolean)) {
      const lower = t.toLowerCase();
      if (t.length < 4 || STOP_WORDS2.has(lower)) continue;
      if ((tagDocFreq.get(lower) ?? 0) > tooGenericThreshold) continue;
      aliases.push(t);
    }
    const slugWords = n.id.replace(/-/g, " ");
    if (slugWords.length >= 6) aliases.push(slugWords);
    byId.set(n.id, { id: n.id, title: n.title, aliases });
    for (const alias of aliases) {
      const key = alias.toLowerCase().trim();
      const existingId = bySurface.get(key);
      if (existingId === void 0) {
        bySurface.set(key, n.id);
      } else if (existingId !== n.id) {
        log.debug(
          { surface: key, keptId: existingId, droppedId: n.id },
          "entities: alias collision \u2014 first-writer-wins (id-sorted order)"
        );
      }
    }
  }
  return { byId, bySurface };
}
function detectMentions(text, index, selfId) {
  const out = [];
  const surfaces = [...index.bySurface.keys()].sort((a, b) => b.length - a.length);
  const claimed = [];
  for (const surface of surfaces) {
    if (surface.length < 4) continue;
    if (STOP_WORDS2.has(surface.toLowerCase())) continue;
    const id = index.bySurface.get(surface);
    if (!id || id === selfId) continue;
    const lowerText = text.toLowerCase();
    let from = 0;
    while (from < lowerText.length) {
      const found = lowerText.indexOf(surface, from);
      if (found === -1) break;
      const end = found + surface.length;
      const before = found === 0 ? " " : text[found - 1];
      const after = end >= text.length ? " " : text[end];
      const isBoundary = /[^a-zA-Z0-9_-]/.test(before) && /[^a-zA-Z0-9_-]/.test(after);
      const overlap = claimed.some(([s, e]) => !(end <= s || found >= e));
      if (isBoundary && !overlap) {
        out.push({ id, surface: text.slice(found, end), start: found, end });
        claimed.push([found, end]);
      }
      from = end;
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
function detectEdgeType(text, start, end) {
  const contextStart = Math.max(0, start - 100);
  const contextEnd = Math.min(text.length, end + 100);
  const context = text.slice(contextStart, contextEnd);
  for (const { pattern, type, confidence } of EDGE_TYPE_PATTERNS) {
    if (pattern.test(context)) {
      return { type, confidence };
    }
  }
  return { type: "mentions", confidence: "inferred" };
}
function applyAutoLinks(html, noteId, index) {
  const { document } = parseHTML14(`<!doctype html><html><body>${html}</body></html>`);
  const root = document.body || document.documentElement;
  if (!root) return { html, linksAdded: 0 };
  const skipTags = /* @__PURE__ */ new Set(["a", "script", "style", "code", "pre"]);
  let linksAdded = 0;
  const MAX_AUTO_LINKS = 10;
  const walker = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (!child) continue;
      if (linksAdded >= MAX_AUTO_LINKS) break;
      if (child.nodeType === 3) {
        const original = child.textContent ?? "";
        if (!original || original.length < 6) continue;
        const mentions = detectMentions(original, index, noteId);
        if (mentions.length === 0) continue;
        const frag = document.createDocumentFragment();
        let cursor = 0;
        for (const m of mentions) {
          if (linksAdded >= MAX_AUTO_LINKS) break;
          if (m.start > cursor) {
            frag.appendChild(document.createTextNode(original.slice(cursor, m.start)));
          }
          const { type: edgeType, confidence } = detectEdgeType(original, m.start, m.end);
          const a = document.createElement("a");
          a.setAttribute("href", `#${m.id}`);
          a.setAttribute("data-cerveau-link-type", edgeType);
          a.setAttribute("data-cerveau-link-confidence", confidence);
          a.setAttribute("data-cerveau-link-auto", "1");
          a.textContent = m.surface;
          frag.appendChild(a);
          cursor = m.end;
          linksAdded += 1;
        }
        if (cursor < original.length) {
          frag.appendChild(document.createTextNode(original.slice(cursor)));
        }
        child.parentNode?.replaceChild(frag, child);
      } else if (child.nodeType === 1) {
        const el = child;
        if (!skipTags.has(el.tagName.toLowerCase())) walker(el);
      }
    }
  };
  walker(root);
  return { html: root.innerHTML, linksAdded };
}
var STOP_WORDS2, EDGE_TYPE_PATTERNS;
var init_entities2 = __esm({
  "src/graph/entities.ts"() {
    "use strict";
    init_strip();
    init_logger();
    init_structural_edges();
    STOP_WORDS2 = /* @__PURE__ */ new Set([
      "the",
      "and",
      "with",
      "from",
      "into",
      "about",
      "note",
      "this",
      "that",
      "when",
      "what",
      "where",
      "which",
      "their",
      "there",
      "these",
      "those",
      "pour",
      "avec",
      "dans",
      "sans",
      "sous",
      "cette",
      "cela",
      "mais",
      // Common technical terms that are too generic for auto-linking
      "status",
      "categories",
      "data",
      "config",
      "type",
      "source",
      "project",
      "session",
      "working",
      "active",
      "error",
      "output",
      "input",
      "value",
      "state",
      "action",
      "event",
      "result",
      "field",
      "object",
      "string",
      "number",
      "array",
      "props",
      "params",
      "args"
    ]);
    EDGE_TYPE_PATTERNS = [
      // Dependency relationships
      {
        pattern: /(?:depends?\s+on|requires?|needs?|uses?)\s+/i,
        type: "depends-on",
        confidence: "inferred"
      },
      { pattern: /(?:import(?:s|ed)?|from)\s+/i, type: "imports", confidence: "extracted" },
      // Replacement/evolution
      {
        pattern: /(?:replac(?:e[ds]?|ing)|migrat(?:e[ds]?|ing)\s+(?:from|to))\s+/i,
        type: "replaces",
        confidence: "inferred"
      },
      {
        pattern: /(?:upgrad(?:e[ds]?|ing)|updat(?:e[ds]?|ing))\s+/i,
        type: "refines",
        confidence: "inferred"
      },
      // Issues
      {
        pattern: /(?:fix(?:e[ds]?|ing)?|bug\s+in|issue\s+(?:with|in)|broke[n]?|crash(?:e[ds]?|ing)?)\s+/i,
        type: "fixes",
        confidence: "inferred"
      },
      { pattern: /(?:conflict|contradict|inconsisten)/i, type: "contradicts", confidence: "inferred" },
      // Testing
      {
        pattern: /(?:test(?:s|ed|ing)?|spec\s+for|coverage)\s+/i,
        type: "tested-by",
        confidence: "inferred"
      },
      // Configuration
      {
        pattern: /(?:config(?:ur)?(?:e[ds]?|ing)?|set(?:ting|up))\s+/i,
        type: "configures",
        confidence: "inferred"
      },
      // Documentation
      {
        pattern: /(?:document(?:s|ed|ing)?|describes?|explains?)\s+/i,
        type: "documents",
        confidence: "inferred"
      }
    ];
  }
});

// src/graph/global-graph.ts
import { existsSync as existsSync28, mkdirSync as mkdirSync15, readFileSync as readFileSync31, writeFileSync as writeFileSync23 } from "node:fs";
import { join as join32 } from "node:path";
function projectOf(node) {
  return node.topic ?? node.topicPath.split("/")[0] ?? "unknown";
}
function groupByProject(nodes) {
  const groups = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    const project = projectOf(node);
    const existing = groups.get(project) ?? [];
    groups.set(project, [...existing, node]);
  }
  return groups;
}
function entityKeysOf(node) {
  const keys = [];
  const tags = node.tags.filter((t) => t.length >= 3);
  keys.push(...tags);
  const STOP_WORDS3 = /* @__PURE__ */ new Set(["with", "from", "that", "this", "have", "will", "been", "also"]);
  const titleWords = node.title.toLowerCase().split(/\W+/).filter((w) => w.length >= 4 && !STOP_WORDS3.has(w));
  keys.push(...titleWords);
  return [...new Set(keys)];
}
function findSharedEntities(nodesByProject) {
  const entityToProjects = /* @__PURE__ */ new Map();
  const entityTypes = /* @__PURE__ */ new Map();
  for (const [project, nodes] of nodesByProject) {
    for (const node of nodes) {
      const keys = entityKeysOf(node);
      for (const key of keys) {
        const existing = entityToProjects.get(key) ?? /* @__PURE__ */ new Set();
        existing.add(project);
        entityToProjects.set(key, existing);
        if (!entityTypes.has(key)) {
          entityTypes.set(key, node.type === "decision" ? "decision" : "concept");
        }
      }
    }
  }
  const shared = [];
  for (const [name, projects] of entityToProjects) {
    if (projects.size >= 2) {
      shared.push({
        name,
        type: entityTypes.get(name) ?? "concept",
        projects: Array.from(projects).sort()
      });
    }
  }
  return shared.sort((a, b) => b.projects.length - a.projects.length);
}
function buildCrossEdgesFromGraph(edges, nodeMap) {
  const crossEdges = [];
  const seen = /* @__PURE__ */ new Set();
  for (const edge of edges) {
    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    if (!srcNode || !tgtNode) continue;
    const srcProject = projectOf(srcNode);
    const tgtProject = projectOf(tgtNode);
    if (srcProject === tgtProject) continue;
    const key = `${edge.source}::${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    crossEdges.push({
      source: edge.source,
      target: edge.target,
      sourceProject: srcProject,
      targetProject: tgtProject,
      type: "cross-references",
      confidence: edge.confidence,
      evidence: `Direct edge of type '${edge.type}' in brain graph (strength=${edge.strength.toFixed(2)})`
    });
  }
  return crossEdges;
}
function buildCoMentionedEdges(sharedEntities, nodesByProject) {
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entity of sharedEntities) {
    const projects = entity.projects;
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const projectA = projects[i];
        const projectB = projects[j];
        const nodesA = nodesByProject.get(projectA) ?? [];
        const nodesB = nodesByProject.get(projectB) ?? [];
        const nodeA = nodesA.filter((n) => entityKeysOf(n).includes(entity.name)).sort((a, b) => b.importance - a.importance)[0];
        const nodeB = nodesB.filter((n) => entityKeysOf(n).includes(entity.name)).sort((a, b) => b.importance - a.importance)[0];
        if (!nodeA || !nodeB) continue;
        const key = `${nodeA.id}::${nodeB.id}::co-mentioned`;
        const reverseKey = `${nodeB.id}::${nodeA.id}::co-mentioned`;
        if (seen.has(key) || seen.has(reverseKey)) continue;
        seen.add(key);
        edges.push({
          source: nodeA.id,
          target: nodeB.id,
          sourceProject: projectA,
          targetProject: projectB,
          type: "co-mentioned",
          confidence: "inferred",
          evidence: `Both projects mention entity '${entity.name}'`
        });
      }
    }
  }
  return edges;
}
function buildSharedCodeEdges(hierarchy, nodesByProject) {
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  const projects = Array.from(nodesByProject.keys());
  const projectModules = /* @__PURE__ */ new Map();
  for (const project of projects) {
    const modules = /* @__PURE__ */ new Set();
    for (const [id, node] of hierarchy.byId) {
      if (node.level >= 2 && id.startsWith(`${project}/`)) {
        modules.add(node.segment.toLowerCase());
      }
    }
    projectModules.set(project, modules);
  }
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const projectA = projects[i];
      const projectB = projects[j];
      const modulesA = projectModules.get(projectA) ?? /* @__PURE__ */ new Set();
      const modulesB = projectModules.get(projectB) ?? /* @__PURE__ */ new Set();
      const sharedModules = [...modulesA].filter((m) => modulesB.has(m));
      if (sharedModules.length === 0) continue;
      const nodesA = nodesByProject.get(projectA) ?? [];
      const nodesB = nodesByProject.get(projectB) ?? [];
      const nodeA = nodesA.sort((a, b) => b.pagerank - a.pagerank)[0];
      const nodeB = nodesB.sort((a, b) => b.pagerank - a.pagerank)[0];
      if (!nodeA || !nodeB) continue;
      const key = `${projectA}::${projectB}::shared-code`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: nodeA.id,
        target: nodeB.id,
        sourceProject: projectA,
        targetProject: projectB,
        type: "shared-code",
        confidence: "inferred",
        evidence: `Shared module segments: ${sharedModules.slice(0, 3).join(", ")}`
      });
    }
  }
  return edges;
}
function computeDensestPair(crossEdges, projects) {
  const pairCounts = /* @__PURE__ */ new Map();
  for (const edge of crossEdges) {
    const pair = [edge.sourceProject, edge.targetProject].sort().join("::");
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }
  if (pairCounts.size === 0) {
    const [projectA2 = "unknown", projectB2 = "unknown"] = projects;
    return { projectA: projectA2, projectB: projectB2, edgeCount: 0 };
  }
  const [densestPairKey, edgeCount] = [...pairCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const [projectA, projectB] = densestPairKey.split("::");
  return { projectA: projectA ?? "unknown", projectB: projectB ?? "unknown", edgeCount };
}
function buildGlobalGraph(graph, hierarchy) {
  const nodesByProject = groupByProject(graph.nodes);
  const projects = Array.from(nodesByProject.keys()).sort();
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const directCrossEdges = buildCrossEdgesFromGraph(graph.edges, nodeMap);
  const sharedEntities = findSharedEntities(nodesByProject);
  const coMentionedEdges = buildCoMentionedEdges(sharedEntities, nodesByProject);
  const sharedCodeEdges = buildSharedCodeEdges(hierarchy, nodesByProject);
  const seen = /* @__PURE__ */ new Set();
  const allCrossEdges = [];
  for (const edge of [...directCrossEdges, ...coMentionedEdges, ...sharedCodeEdges]) {
    const key = `${edge.source}::${edge.target}::${edge.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      allCrossEdges.push(edge);
    }
  }
  const densestPair = computeDensestPair(allCrossEdges, projects);
  return {
    version: "1.0.0",
    generated: (/* @__PURE__ */ new Date()).toISOString(),
    projects,
    crossEdges: allCrossEdges,
    sharedEntities,
    stats: {
      totalProjects: projects.length,
      totalCrossEdges: allCrossEdges.length,
      densestPair
    }
  };
}
function saveGlobalGraph(g) {
  const cfg = getConfig();
  if (!existsSync28(cfg.cachePath)) mkdirSync15(cfg.cachePath, { recursive: true });
  const path = join32(cfg.cachePath, GLOBAL_GRAPH_FILENAME);
  writeFileSync23(path, JSON.stringify(g, null, 2), "utf8");
  return path;
}
function loadGlobalGraph() {
  const cfg = getConfig();
  const path = join32(cfg.cachePath, GLOBAL_GRAPH_FILENAME);
  if (!existsSync28(path)) return null;
  try {
    const data = JSON.parse(readFileSync31(path, "utf8"));
    if (!data.version || !data.projects || !data.crossEdges) return null;
    return data;
  } catch {
    return null;
  }
}
var GLOBAL_GRAPH_FILENAME;
var init_global_graph = __esm({
  "src/graph/global-graph.ts"() {
    "use strict";
    init_config();
    GLOBAL_GRAPH_FILENAME = "global-graph.json";
  }
});

// src/graph/hierarchy.ts
function extractCwd(html) {
  const m = html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
  return m?.[1] ?? null;
}
function makeNode(id, level, segment, parent) {
  return {
    id,
    level,
    segment,
    parent,
    children: [],
    noteIds: [],
    conversationCount: 0
  };
}
function ensureNode(byId, id, level, segment, parent) {
  const existing = byId.get(id);
  if (existing) return existing;
  const node = makeNode(id, level, segment, parent);
  byId.set(id, node);
  return node;
}
function buildAncestors(byId, segments) {
  for (let depth = 1; depth <= segments.length; depth++) {
    const id = segments.slice(0, depth).join("/");
    const segment = segments[depth - 1];
    const parentId = depth === 1 ? ROOT_ID : segments.slice(0, depth - 1).join("/");
    const level = depth;
    ensureNode(byId, id, level, segment, parentId);
    const parent = byId.get(parentId);
    if (parent && !parent.children.includes(id)) {
      parent.children = [...parent.children, id];
    }
  }
}
function extractHierarchy(notes) {
  const byId = /* @__PURE__ */ new Map();
  const root = makeNode(ROOT_ID, 0, "_root", null);
  byId.set(ROOT_ID, root);
  for (const note of notes) {
    const rawCwd = extractCwd(note.html);
    if (!rawCwd) continue;
    const normalized = normalizeCwd(rawCwd);
    if (!normalized) continue;
    const { segments } = normalized;
    if (segments.length === 0) continue;
    buildAncestors(byId, segments);
    const leafId = segments.join("/");
    const leafNode = byId.get(leafId);
    if (!leafNode) continue;
    const noteId = note.id || note.path;
    if (noteId && !leafNode.noteIds.includes(noteId)) {
      leafNode.noteIds = [...leafNode.noteIds, noteId];
    }
  }
  for (const [id, node] of byId) {
    if (id === ROOT_ID) continue;
    if (node.level === 1 && !root.children.includes(id)) {
      root.children = [...root.children, id];
    }
  }
  function countConversations(nodeId) {
    const node = byId.get(nodeId);
    if (!node) return 0;
    const ownCount = node.noteIds.length;
    const childCount = node.children.reduce((sum, cid) => sum + countConversations(cid), 0);
    return ownCount + childCount;
  }
  for (const [, node] of byId) {
    node.conversationCount = countConversations(node.id);
  }
  const projects = root.children.slice();
  const totalNodes = byId.size;
  return { root, byId, projects, totalNodes };
}
var ROOT_ID;
var init_hierarchy = __esm({
  "src/graph/hierarchy.ts"() {
    "use strict";
    init_cwd_normalizer();
    ROOT_ID = "_root";
  }
});

// src/commands/graph.ts
import {
  existsSync as existsSync29,
  mkdirSync as mkdirSync16,
  readFileSync as readFileSync32,
  realpathSync,
  statSync as statSync10,
  writeFileSync as writeFileSync24
} from "node:fs";
import { join as join33 } from "node:path";
async function runGraph(opts) {
  const log = getLogger();
  const startedAt = Date.now();
  const format = opts.format ?? "both";
  const indexedNotes = listAll({ includeExpired: false }).map((n) => ({
    id: n.id,
    title: n.title,
    tags: n.tags,
    topic: n.title || n.id
  }));
  const entityIndex = buildEntityIndex(indexedNotes);
  log.debug({ entities: indexedNotes.length }, "entity index built");
  let linksAdded = 0;
  let notesTouched = 0;
  if (!opts.skipAutolink) {
    const notes = readAllNotes();
    for (const note of notes) {
      if (!note.id) continue;
      const before = note.html;
      const { html: after, linksAdded: added } = applyAutoLinks(before, note.id, entityIndex);
      if (added > 0 && after !== before) {
        writeFileSync24(note.path, after, "utf8");
        try {
          indexNote(readNote(note.path));
        } catch (err) {
          log.warn({ path: note.path, err: err.message }, "reindex after autolink");
        }
        linksAdded += added;
        notesTouched += 1;
      }
    }
  }
  let codeFilesAdded = 0;
  let codeProjects = 0;
  if (!opts.skipCodeScan) {
    const codeResults = await runCodeScan(
      listAll({ includeExpired: false }).map((n) => n.path),
      opts.cwd
    );
    codeProjects = codeResults.length;
    const existingEnrichmentById = /* @__PURE__ */ new Map();
    for (const n of extractFileNeuronStubsFromHtml(readAllNotes())) {
      const enrichment = {
        decisions: n.decisions,
        bugs: n.bugs,
        ideas: n.ideas,
        rules: n.rules,
        qa: n.qa,
        activities: n.activities
      };
      if (Object.values(enrichment).some((items) => items && items.length > 0)) {
        existingEnrichmentById.set(n.id, enrichment);
      }
    }
    const codeIndexedNotes = [];
    for (const result2 of codeResults) {
      const noteHtmls = codeNodesToNotes(result2, existingEnrichmentById);
      for (const html of noteHtmls) {
        try {
          const written = writeNote(html, { overwrite: true });
          try {
            codeIndexedNotes.push(indexNote(readNote(written.path)));
          } catch (err) {
            log.warn({ path: written.path, err: err.message }, "code note reindex");
          }
          codeFilesAdded += 1;
        } catch (err) {
          log.debug({ err: err.message }, "code note write skipped");
        }
      }
    }
    let codeAggregatesAdded = 0;
    for (const result2 of codeResults) {
      const descriptors = buildAggregateNeurons(result2);
      for (const descriptor of descriptors) {
        try {
          const html = composeAggregateNeuron(descriptor);
          const written = writeNote(html, { overwrite: true });
          try {
            codeIndexedNotes.push(indexNote(readNote(written.path)));
          } catch (err) {
            log.warn({ path: written.path, err: err.message }, "aggregate note reindex");
          }
          codeAggregatesAdded += 1;
        } catch (err) {
          log.debug({ err: err.message }, "aggregate note write skipped");
        }
      }
    }
    await embedNotesForIndex(codeIndexedNotes);
    if (codeProjects > 0) {
      log.info(
        { projects: codeProjects, notes: codeFilesAdded, aggregates: codeAggregatesAdded },
        "code scan complete"
      );
    }
  }
  const backlinks = buildBacklinks();
  const backlinksPath = saveBacklinks(backlinks);
  let clusterCount = 0;
  let clustersPath = "";
  if (!opts.skipClusters) {
    const previousClusters = loadClusters();
    const clusters = detectClusters(indexedNotes, backlinks, 20, previousClusters);
    clustersPath = saveClusters(clusters);
    clusterCount = clusters.cluster_count;
  }
  let knowledgeGraphPath = "";
  let globalGraphPath = "";
  let globalGraphStats = { projects: 0, crossEdges: 0, sharedEntities: 0 };
  const loadedClusters = loadClusters();
  if (loadedClusters) {
    const pagerank = computePageRank();
    const knowledgeGraph = buildKnowledgeGraphFromIndex(backlinks, loadedClusters, pagerank);
    knowledgeGraphPath = saveKnowledgeGraph(knowledgeGraph);
    const cfg = getConfig();
    const topTopics = Object.keys(knowledgeGraph.stats.topTopics);
    for (const topic of topTopics) {
      const subGraph = extractSubGraph(knowledgeGraph, topic);
      if (subGraph.nodes.length >= 3) {
        const safeTopic = topic.replace(/[^a-z0-9-_]/gi, "_");
        const subPath = join33(cfg.cachePath, `brain-graph-${safeTopic}.json`);
        writeFileSync24(subPath, JSON.stringify(subGraph, null, 2), "utf8");
        log.info(
          { topic, nodes: subGraph.nodes.length, edges: subGraph.edges.length },
          "sub-graph saved"
        );
      }
    }
    try {
      const allNoteFiles = readAllNotes();
      const hierarchy = extractHierarchy(allNoteFiles);
      const globalGraph = buildGlobalGraph(knowledgeGraph, hierarchy);
      globalGraphPath = saveGlobalGraph(globalGraph);
      globalGraphStats = {
        projects: globalGraph.stats.totalProjects,
        crossEdges: globalGraph.stats.totalCrossEdges,
        sharedEntities: globalGraph.sharedEntities.length
      };
      log.info(
        {
          projects: globalGraph.stats.totalProjects,
          crossEdges: globalGraph.stats.totalCrossEdges,
          sharedEntities: globalGraph.sharedEntities.length,
          densestPair: globalGraph.stats.densestPair
        },
        "global graph saved"
      );
    } catch (err) {
      log.warn({ err: err.message }, "global graph build failed");
    }
    const allNotes = listAll({ includeExpired: false });
    const dedupResult = findDuplicates(allNotes);
    if (dedupResult.duplicatePairs.length > 0) {
      log.info(
        { duplicates: dedupResult.duplicatePairs.length },
        "potential duplicate notes detected"
      );
      for (const pair of dedupResult.duplicatePairs.slice(0, 10)) {
        log.debug(
          { noteA: pair.noteA, noteB: pair.noteB, similarity: pair.similarity.toFixed(3) },
          "duplicate pair"
        );
      }
    }
  }
  let viewPath = "";
  if (!opts.skipView && (format === "html" || format === "both")) {
    viewPath = renderGraphView(indexedNotes, backlinks, clusterCount);
  }
  let textPath = "";
  if (format === "text" || format === "both") {
    textPath = renderGraphText(backlinks);
  }
  const result = {
    notes: indexedNotes.length,
    auto_links_added: linksAdded,
    notes_touched: notesTouched,
    code_projects_scanned: codeProjects,
    code_notes_added: codeFilesAdded,
    backlinks_total: backlinks.total_edges,
    cluster_count: clusterCount,
    backlinks_path: backlinksPath,
    clusters_path: clustersPath,
    view_path: viewPath,
    text_path: textPath,
    knowledge_graph_path: knowledgeGraphPath,
    global_graph_path: globalGraphPath,
    global_graph_projects: globalGraphStats.projects,
    global_graph_cross_edges: globalGraphStats.crossEdges,
    global_graph_shared_entities: globalGraphStats.sharedEntities,
    duration_ms: Date.now() - startedAt
  };
  if (opts.pretty) {
    return [
      `Graph built in ${result.duration_ms}ms`,
      "\u2500".repeat(40),
      `Notes:          ${result.notes}`,
      `Auto-links:     ${result.auto_links_added} added across ${result.notes_touched} notes`,
      `Code scan:      ${result.code_projects_scanned} projects \u2192 ${result.code_notes_added} notes added`,
      `Backlinks:      ${result.backlinks_total} edges  \u2192 ${result.backlinks_path}`,
      `Clusters:       ${result.cluster_count}  \u2192 ${result.clusters_path}`,
      `Graph view:     ${result.view_path || "(skipped)"}`,
      `Graph text:     ${result.text_path || "(skipped)"}`,
      `Knowledge graph: ${result.knowledge_graph_path || "(skipped)"}`,
      `Global graph:   ${result.global_graph_projects} projects, ${result.global_graph_cross_edges} cross-edges, ${result.global_graph_shared_entities} shared entities`
    ].join("\n");
  }
  return JSON.stringify(result, null, 2);
}
async function runCodeScan(notePaths, explicitCwd) {
  const rawCandidates = /* @__PURE__ */ new Set();
  if (explicitCwd) rawCandidates.add(explicitCwd);
  for (const notePath2 of notePaths) {
    let html;
    try {
      html = readFileSync32(notePath2, "utf8");
    } catch {
      continue;
    }
    const cwdMatch = html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
    if (cwdMatch?.[1]) rawCandidates.add(cwdMatch[1]);
    const srcMatch = html.match(/data-cerveau-source\s*=\s*["']([^"']+)["']/i);
    if (srcMatch?.[1]) {
      const src = srcMatch[1];
      if ((src.startsWith("/") || /^[A-Z]:\\/i.test(src)) && existsSync29(src)) {
        try {
          const s = statSync10(src);
          if (s.isDirectory()) rawCandidates.add(src);
        } catch {
        }
      }
    }
  }
  const cwds = /* @__PURE__ */ new Set();
  for (const raw of rawCandidates) {
    const normalized = normalizeCwd3(raw);
    if (normalized) cwds.add(normalized);
  }
  const results = [];
  for (const cwd of cwds) {
    try {
      const result = await scanProjectAsync(cwd);
      if (result && result.nodes.length > 0) {
        results.push(result);
      }
    } catch {
      const result = scanProject(cwd);
      if (result && result.nodes.length > 0) {
        results.push(result);
      }
    }
  }
  return results;
}
function normalizeCwd3(raw) {
  try {
    if (!existsSync29(raw)) return null;
    if (!statSync10(raw).isDirectory()) return null;
    return realpathSync(raw);
  } catch {
    return null;
  }
}
function renderGraphText(backlinks) {
  const root = brainRoot();
  if (!existsSync29(root)) mkdirSync16(root, { recursive: true });
  const outPath = join33(root, "graph.txt");
  const nodeSet = /* @__PURE__ */ new Set([
    ...Object.keys(backlinks.outgoing),
    ...Object.keys(backlinks.incoming)
  ]);
  const lines = [
    `# Brain graph \u2014 ${nodeSet.size} nodes, ${backlinks.total_edges} edges`,
    `# Generated: ${backlinks.generated}`,
    ""
  ];
  const sortedNodes = [...nodeSet].sort((a, b) => {
    const inA = (backlinks.incoming[a] ?? []).length;
    const inB = (backlinks.incoming[b] ?? []).length;
    if (inB !== inA) return inB - inA;
    return a.localeCompare(b);
  });
  for (const nodeId of sortedNodes) {
    const outEdges = backlinks.outgoing[nodeId] ?? [];
    const inEdges = backlinks.incoming[nodeId] ?? [];
    const inCount = inEdges.length;
    const outCount = outEdges.length;
    if (inCount === 0 && outCount === 0) continue;
    const isHub = inCount >= 5;
    const hubPrefix = isHub ? "[HUB] " : "";
    lines.push(`${hubPrefix}[#${nodeId}] \xB7 ${inCount} inbound, ${outCount} outbound`);
    for (const edge of outEdges) {
      const strength = edge.auto ? "" : " (s=1.0)";
      lines.push(`  [#${nodeId}] \u2014${edge.type}\u2192 [#${edge.to}]${strength}`);
    }
    if (inCount >= 3) {
      const sampleIds = inEdges.slice(0, 5).map((e) => `#${e.from}`).join(", ");
      const extra = inCount > 5 ? ` +${inCount - 5} more` : "";
      lines.push(`  [#${nodeId}] \u2190cited-by\u2014 ${inCount} notes [${sampleIds}${extra}]`);
    } else {
      for (const edge of inEdges) {
        lines.push(`  [#${edge.from}] \u2014${edge.type}\u2192 [#${nodeId}]`);
      }
    }
    lines.push("");
  }
  writeFileSync24(outPath, lines.join("\n"), "utf8");
  return outPath;
}
function renderGraphView(notes, backlinks, clusterCount) {
  void clusterCount;
  const root = brainRoot();
  if (!existsSync29(root)) mkdirSync16(root, { recursive: true });
  const outPath = join33(root, "graph.html");
  const nodes = notes.map((n) => ({ id: n.id, label: n.title || n.id, tags: n.tags }));
  const seen = /* @__PURE__ */ new Set();
  const edges = [];
  for (const list of Object.values(backlinks.outgoing ?? {})) {
    for (const e of list) {
      const key = `${e.from}\u2192${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: e.from, to: e.to, type: e.type, auto: e.auto });
    }
  }
  const dataJson = JSON.stringify({ nodes, edges });
  const html = buildGraphHtml(dataJson);
  writeFileSync24(outPath, html, "utf8");
  return outPath;
}
function buildGraphHtml(dataJson) {
  for (const tplPath of VIEW_TEMPLATE_PATHS) {
    try {
      const tpl = readFileSync32(tplPath, "utf8");
      return tpl.replace('"__DATA__"', dataJson);
    } catch {
    }
  }
  return FALLBACK_TEMPLATE.replace('"__DATA__"', dataJson);
}
var VIEW_TEMPLATE_PATHS, FALLBACK_TEMPLATE;
var init_graph = __esm({
  "src/commands/graph.ts"() {
    "use strict";
    init_aggregate_neuron();
    init_backlinks();
    init_analysis();
    init_clusters();
    init_code_scanner();
    init_dedup();
    init_entities2();
    init_file_neuron_parse();
    init_global_graph();
    init_hierarchy();
    init_knowledge_graph();
    init_pagerank();
    init_fts();
    init_paths();
    init_reader();
    init_writer();
    init_config();
    init_logger();
    VIEW_TEMPLATE_PATHS = [
      new URL("../graph/view-template.html", import.meta.url),
      new URL("../../src/graph/view-template.html", import.meta.url)
    ];
    FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Brain graph</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html,body{margin:0;background:#0e0f12;color:#e6e8ee;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden}
  #info{position:fixed;top:12px;left:12px;background:#16181d;border:1px solid #262a33;border-radius:8px;padding:10px 14px;max-width:340px;z-index:10}
  #info h2{margin:0 0 6px;font-size:15px;color:#7dd3fc}
  #info p{margin:2px 0;font-size:12px;color:#8a93a6}
  canvas{display:block;cursor:grab}
  canvas:active{cursor:grabbing}
</style>
</head><body>
<div id="info"><h2>Brain graph</h2><p id="hover">Hover a node to inspect.</p><p id="stats"></p></div>
<canvas id="c"></canvas>
<script>
const data = "__DATA__";
const W = window.innerWidth, H = window.innerHeight;
const c = document.getElementById('c'); c.width = W; c.height = H;
const ctx = c.getContext('2d');
const nodes = data.nodes.map((n,i)=>({...n, x: Math.cos(i)*200+W/2, y: Math.sin(i*0.7)*200+H/2, vx:0, vy:0}));
const idx = new Map(nodes.map(n=>[n.id,n]));
const edges = data.edges.filter(e=>idx.has(e.from)&&idx.has(e.to));
document.getElementById('stats').textContent = nodes.length+' nodes, '+edges.length+' edges';
// Simple force-directed layout
function step(){
  // Repulsion
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
    const a=nodes[i], b=nodes[j];
    let dx=a.x-b.x, dy=a.y-b.y, d=Math.hypot(dx,dy)||0.01;
    const f = 600/(d*d);
    dx/=d; dy/=d;
    a.vx+=dx*f; a.vy+=dy*f; b.vx-=dx*f; b.vy-=dy*f;
  }
  // Attraction along edges
  for(const e of edges){
    const a=idx.get(e.from), b=idx.get(e.to);
    let dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy)||0.01;
    const f=(d-80)*0.02;
    dx/=d; dy/=d;
    a.vx+=dx*f; a.vy+=dy*f; b.vx-=dx*f; b.vy-=dy*f;
  }
  // Integrate + center pull
  for(const n of nodes){
    n.vx*=0.85; n.vy*=0.85;
    n.x+=n.vx; n.y+=n.vy;
    n.vx += (W/2-n.x)*0.002; n.vy += (H/2-n.y)*0.002;
  }
}
let hover=null;
c.addEventListener('mousemove',(ev)=>{
  let best=null, bd=20;
  for(const n of nodes){ const d=Math.hypot(n.x-ev.offsetX,n.y-ev.offsetY); if(d<bd){bd=d;best=n;}}
  hover=best;
  document.getElementById('hover').textContent = best ? best.label+' ('+best.tags+')' : 'Hover a node to inspect.';
});
function draw(){
  ctx.fillStyle='#0e0f12'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='#262a33'; ctx.lineWidth=1;
  for(const e of edges){
    const a=idx.get(e.from), b=idx.get(e.to);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  }
  for(const n of nodes){
    ctx.fillStyle = n===hover ? '#f0abfc' : '#7dd3fc';
    ctx.beginPath(); ctx.arc(n.x,n.y,6,0,Math.PI*2); ctx.fill();
    if(n===hover){
      ctx.fillStyle='#e6e8ee'; ctx.font='12px sans-serif';
      ctx.fillText(n.label, n.x+10, n.y+4);
    }
  }
}
function loop(){ step(); draw(); requestAnimationFrame(loop); }
loop();
</script></body></html>`;
  }
});

// src/commands/interlink.ts
var interlink_exports = {};
__export(interlink_exports, {
  runInterlink: () => runInterlink
});
import { writeFileSync as writeFileSync27 } from "node:fs";
import { parseHTML as parseHTML15 } from "linkedom";
function noteToEmbedText(html) {
  const { document } = parseHTML15(`<!doctype html><body>${html}</body>`);
  const root = document.querySelector("article") ?? document.body;
  const text = (root.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, EMBED_CHAR_LIMIT2);
}
function hasSeeAlso(html) {
  return html.includes('class="see-also"') || html.includes('data-section="see-also"');
}
function hasUnlinkedMentions(html) {
  return html.includes("data-cerveau-suggested-links");
}
function buildTitleIndex(allFiles) {
  const entries = [];
  for (const f of allFiles) {
    if (!f.id || f.id.length < 4) continue;
    const m = f.html.match(/<h[123][^>]*>([^<]{4,80})<\/h[123]>/i);
    const rawTitle = m ? m[1].trim() : "";
    const idSurface = f.id.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
    const candidates = /* @__PURE__ */ new Set();
    if (rawTitle.length >= 4) candidates.add(rawTitle);
    if (idSurface.length >= 4) candidates.add(idSurface);
    for (const surface of candidates) {
      try {
        const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        entries.push({
          id: f.id,
          title: surface,
          pattern: new RegExp(`\\b${escaped}\\b`, "gi")
        });
      } catch {
      }
    }
  }
  return entries;
}
function findUnlinkedMentions(html, noteId, titleIndex) {
  const plainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const existingLinks = /* @__PURE__ */ new Set();
  for (const m of html.matchAll(/href="#\/note\/([^"]+)"/g)) {
    existingLinks.add(decodeURIComponent(m[1]));
  }
  for (const m of html.matchAll(/href="#(?!\/note\/)([^"]+)"/g)) {
    existingLinks.add(m[1]);
  }
  const found = [];
  const seenIds = /* @__PURE__ */ new Set([noteId]);
  for (const entry of titleIndex) {
    if (seenIds.has(entry.id)) continue;
    if (existingLinks.has(entry.id)) continue;
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(plainText)) {
      found.push({ id: entry.id, title: entry.title });
      seenIds.add(entry.id);
    }
    if (found.length >= 5) break;
  }
  return found;
}
function injectRelatedAttr(html, ids) {
  if (ids.length === 0) return html;
  const value = ids.join(",");
  if (/data-cerveau-related="[^"]*"/.test(html)) {
    return html.replace(/data-cerveau-related="[^"]*"/, `data-cerveau-related="${value}"`);
  }
  return html.replace(/(<article\b[^>]*?)(>)/, `$1 data-cerveau-related="${value}"$2`);
}
function injectSuggestedLinks(html, mentions) {
  if (mentions.length === 0) return html;
  const links = mentions.map(
    (m) => `<a href="#/note/${encodeURIComponent(m.id)}">${m.title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</a>`
  ).join(", ");
  const aside = `
  <aside data-cerveau-suggested-links>
    Mentioned without link: ${links}
  </aside>`;
  const withoutOld = html.replace(
    /\n?\s*<aside data-cerveau-suggested-links>[\s\S]*?<\/aside>/,
    ""
  );
  if (withoutOld.includes("</article>")) {
    return withoutOld.replace("</article>", `${aside}
</article>`);
  }
  return withoutOld + aside;
}
function isInvalidated(html) {
  const m = html.match(/data-cerveau-valid-until="([^"]*)"/);
  return !!m?.[1];
}
function injectSeeAlso(html, ids) {
  if (ids.length === 0) return html;
  const links = ids.map((id) => `<a href="#/note/${encodeURIComponent(id)}">${id}</a>`).join(", ");
  const seeAlsoHtml = `
  <section data-section="see-also">
    <nav class="see-also">See also: ${links}</nav>
  </section>`;
  if (html.includes("<footer>")) {
    return html.replace("<footer>", `${seeAlsoHtml}
  <footer>`);
  }
  return html.replace("</article>", `${seeAlsoHtml}
</article>`);
}
function buildDisambigAside(surface, instanceIds) {
  if (instanceIds.length < 2) return "";
  const links = instanceIds.slice(0, 6).map((id) => `<a href="#/note/${encodeURIComponent(id)}">${id}</a>`).join(", ");
  return `
  <aside class="disambig" data-disambig-term="${surface.replace(/"/g, "&quot;")}">
    <p>${surface} \u2014 multiple instances: ${links}</p>
  </aside>`;
}
function buildAmbiguousEntities(allFiles) {
  const entities = listEntities();
  const surfaceToKeys = /* @__PURE__ */ new Map();
  for (const e of entities) {
    for (const s of e.surfaces) {
      const low = s.toLowerCase();
      const keys = surfaceToKeys.get(low) ?? [];
      keys.push(`${e.type}:${e.key}`);
      surfaceToKeys.set(low, keys);
    }
  }
  const ambig = /* @__PURE__ */ new Map();
  for (const [surface, keys] of surfaceToKeys) {
    if (keys.length >= 2) {
      ambig.set(surface, [...new Set(keys)]);
    }
  }
  const result = /* @__PURE__ */ new Map();
  for (const f of allFiles) {
    const html = f.html.toLowerCase();
    for (const [surface, keys] of ambig) {
      if (html.includes(surface)) {
        const existing = result.get(surface) ?? [];
        for (const k of keys) {
          if (!existing.includes(k)) existing.push(k);
        }
        result.set(surface, existing);
      }
    }
  }
  return result;
}
async function runInterlink(opts) {
  const log = getLogger();
  const start = Date.now();
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? 200;
  const allIndexed = listAll({ includeExpired: true });
  const ctx = buildWikilinkContext(
    allIndexed.map((n) => ({
      id: n.id,
      concepts: n.concepts ?? null,
      entities: n.entities ?? null,
      tags: n.tags ?? ""
    }))
  );
  const allFiles = readAllNotes();
  const ambigEntities = buildAmbiguousEntities(allFiles);
  const disambigInjected = /* @__PURE__ */ new Set();
  const titleIndex = buildTitleIndex(allFiles.filter((f) => !isInvalidated(f.html)));
  const todo = allFiles.filter((f) => {
    if (!f.html || f.html.trim().length < 10) return false;
    if (f.path.endsWith("_user-profile.html")) return false;
    if (isInvalidated(f.html)) return false;
    if (hasSeeAlso(f.html)) return false;
    if (!/<article|<section/i.test(f.html)) return false;
    return true;
  });
  const todoSuggest = allFiles.filter((f) => {
    if (!f.html || f.html.trim().length < 10) return false;
    if (f.path.endsWith("_user-profile.html")) return false;
    if (isInvalidated(f.html)) return false;
    if (hasUnlinkedMentions(f.html)) return false;
    if (!hasSeeAlso(f.html)) return false;
    if (!/<article|<section/i.test(f.html)) return false;
    return true;
  });
  const batch = todo.slice(0, limit);
  log.info(
    { total: allFiles.length, todo: todo.length, processing: batch.length },
    "interlink start"
  );
  if (batch.length === 0 && todoSuggest.length === 0) {
    const msg = "interlink: nothing to do (all notes already linked)";
    return opts.pretty ? msg : JSON.stringify({ status: "noop", reason: "all linked" });
  }
  const corpusFiles = allFiles.filter((f) => !isInvalidated(f.html));
  const corpusTexts = corpusFiles.map((f) => noteToEmbedText(f.html) || f.id);
  const corpusVectors = await embed(corpusTexts);
  let touched = 0;
  let failed = 0;
  for (const noteFile of batch) {
    try {
      let html = noteFile.html;
      const { document } = parseHTML15(`<!doctype html><body>${html}</body>`);
      const article = document.querySelector("article");
      if (article) {
        if (ctx.knownNoteIds.size > 1) {
          const innerLinked = injectWikilinks(article.innerHTML, ctx);
          if (innerLinked !== article.innerHTML) {
            article.innerHTML = innerLinked;
          }
        }
        const noteHtmlLower = html.toLowerCase();
        for (const [surface, keys] of ambigEntities) {
          if (disambigInjected.has(surface)) continue;
          if (!noteHtmlLower.includes(surface)) continue;
          const aside = buildDisambigAside(surface, keys);
          if (aside) {
            article.innerHTML = aside + article.innerHTML;
            disambigInjected.add(surface);
          }
        }
        html = article.outerHTML;
      }
      const noteText = noteToEmbedText(html) || noteFile.id;
      const [noteVec] = await embed([noteText]);
      const corpus = corpusFiles.filter((f) => f.id !== noteFile.id).map((f, i) => ({ id: f.id, vector: corpusVectors[i] })).filter((c) => c.vector !== void 0);
      const nearest = topKCosine(noteVec, corpus, 3).filter((h) => h.score >= 0.5).map((h) => h.id);
      if (nearest.length > 0) {
        html = injectSeeAlso(html, nearest);
        html = injectRelatedAttr(html, nearest);
      }
      const mentions = findUnlinkedMentions(html, noteFile.id, titleIndex);
      if (mentions.length > 0) {
        html = injectSuggestedLinks(html, mentions);
      }
      if (!dryRun) {
        writeFileSync27(noteFile.path, html, "utf8");
        try {
          indexNote({ ...noteFile, html });
        } catch (indexErr) {
          log.warn(
            { id: noteFile.id, err: indexErr.message },
            "interlink: FTS index update failed, continuing"
          );
        }
      }
      touched++;
    } catch (err) {
      log.warn({ id: noteFile.id, err: err.message }, "interlink: failed note");
      failed++;
    }
  }
  const suggestBatch = todoSuggest.slice(0, limit);
  let suggestTouched = 0;
  for (const noteFile of suggestBatch) {
    try {
      const mentions = findUnlinkedMentions(noteFile.html, noteFile.id, titleIndex);
      if (mentions.length === 0) continue;
      const newHtml = injectSuggestedLinks(noteFile.html, mentions);
      if (!dryRun) {
        writeFileSync27(noteFile.path, newHtml, "utf8");
        try {
          indexNote({ ...noteFile, html: newHtml });
        } catch {
        }
      }
      suggestTouched++;
    } catch (err) {
      log.warn({ id: noteFile.id, err: err.message }, "interlink: suggest pass failed");
    }
  }
  const duration = Date.now() - start;
  const summary = {
    status: dryRun ? "dry-run" : "done",
    touched,
    suggest_touched: suggestTouched,
    failed,
    skipped: todo.length - batch.length,
    duration_ms: duration
  };
  log.info(summary, "interlink complete");
  if (opts.pretty) {
    return [
      `interlink: ${touched} notes updated (+${suggestTouched} suggest-only), ${failed} failed, ${todo.length - batch.length} skipped`,
      `duration: ${duration}ms`
    ].join("\n");
  }
  return JSON.stringify(summary);
}
var EMBED_CHAR_LIMIT2;
var init_interlink = __esm({
  "src/commands/interlink.ts"() {
    "use strict";
    init_entities();
    init_wikilinks();
    init_embeddings();
    init_fts();
    init_reader();
    init_logger();
    EMBED_CHAR_LIMIT2 = 1200;
  }
});

// src/commands/hierarchy-node-composer.ts
function esc3(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function nodeSlug(id) {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
function renderBreadcrumb4(node, tree) {
  if (node.level === 0)
    return '<nav class="breadcrumb"><span aria-current="page">Brain</span></nav>';
  const crumbs = [
    '<a href="#/node/_root" data-cerveau-link-type="parent" data-cerveau-link-confidence="extracted">Brain</a>'
  ];
  const segments = [];
  let cursor = node;
  while (cursor && cursor.level > 0) {
    segments.unshift(cursor);
    cursor = cursor.parent ? tree.byId.get(cursor.parent) : void 0;
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (isLast) {
      crumbs.push(`<span aria-current="page">${esc3(seg.segment)}</span>`);
    } else {
      crumbs.push(
        `<a href="#/node/${esc3(nodeSlug(seg.id))}" data-cerveau-link-type="parent" data-cerveau-link-confidence="extracted">${esc3(seg.segment)}</a>`
      );
    }
  }
  return `<nav class="breadcrumb">${crumbs.join(" / ")}</nav>`;
}
function renderChildrenSection3(node, tree) {
  if (node.children.length === 0) return "";
  const levelLabel = node.level === 0 ? "Projects" : node.level === 1 ? "Modules" : "Features";
  const items = node.children.map((childId) => {
    const child = tree.byId.get(childId);
    if (!child) return "";
    const convLabel = child.conversationCount === 1 ? "1 conversation" : `${child.conversationCount} conversations`;
    return `<li><a href="#/node/${esc3(nodeSlug(child.id))}" data-cerveau-link-type="contains" data-cerveau-link-confidence="extracted">${esc3(child.segment)}</a> <small>${esc3(convLabel)}</small></li>`;
  }).filter(Boolean);
  return `<section data-section="children"><h3>${esc3(levelLabel)}</h3><ul class="edge-list">${items.join("\n")}</ul></section>`;
}
function renderCodeFilesSection(codeFiles, title = "Architecture") {
  if (codeFiles.length === 0) return "";
  const items = codeFiles.slice(0, 20).map(
    (f) => `<li><data value="file:${esc3(f.path)}" data-cerveau-entity-type="file">${esc3(f.path)}</data> <small>${esc3(f.language)}, ${f.lineCount}L</small></li>`
  );
  const list = codeFiles.length > 5 ? `<details><summary>${codeFiles.length} files</summary><ul>${items.join("\n")}</ul></details>` : `<ul>${items.join("\n")}</ul>`;
  return `<section data-section="architecture"><h3>${esc3(title)}</h3>${list}</section>`;
}
function renderDecisionsSection(decisions) {
  if (decisions.length === 0) return "";
  const items = decisions.slice(0, 10).map(
    (d) => `<aside role="doc-note" class="decision-box"><strong>Decision:</strong> ${esc3(d.text)}
<p class="source"><a href="#/note/${esc3(d.sourceId)}" data-cerveau-link-type="documents" data-cerveau-link-confidence="inferred">source</a></p></aside>`
  ).join("\n");
  return `<section data-section="decisions"><h3>Decisions</h3>${items}</section>`;
}
function renderBugsSection(bugs) {
  if (bugs.length === 0) return "";
  const items = bugs.slice(0, 10).map(
    (b) => `<aside role="doc-errata"><strong data-cerveau-kind="bug">Bug:</strong> ${esc3(b.text)}
<p class="source"><a href="#/note/${esc3(b.sourceId)}" data-cerveau-link-type="fixes" data-cerveau-link-confidence="inferred">source</a></p></aside>`
  ).join("\n");
  return `<section data-section="bugs"><h3>Bugs &amp; Issues</h3>${items}</section>`;
}
function renderIdeasSection(ideas) {
  if (ideas.length === 0) return "";
  const items = ideas.slice(0, 10).map(
    (i) => `<li data-cerveau-fact data-cerveau-kind="idea">${esc3(i.text)} <a href="#/note/${esc3(i.sourceId)}" data-cerveau-link-type="mentions" data-cerveau-link-confidence="inferred">source</a></li>`
  );
  return `<section data-section="ideas"><h3>Ideas</h3><ul>${items.join("\n")}</ul></section>`;
}
function renderRulesSection(rules) {
  if (rules.length === 0) return "";
  const items = rules.slice(0, 10).map((r) => `<aside role="doc-tip">${esc3(r.text)}</aside>`).join("\n");
  return `<section data-section="rules"><h3>Rules</h3>${items}</section>`;
}
function renderFactsSection2(facts) {
  if (facts.length === 0) return "";
  const items = facts.slice(0, 15).map(
    (f) => `<li data-cerveau-fact>${esc3(f.text)} <a href="#/note/${esc3(f.sourceId)}" data-cerveau-link-type="mentions" data-cerveau-link-confidence="inferred">source</a></li>`
  );
  const list = facts.length > 5 ? `<details open><summary>${facts.length} facts</summary><ul>${items.join("\n")}</ul></details>` : `<ul>${items.join("\n")}</ul>`;
  return `<section data-section="facts"><h3>Facts</h3>${list}</section>`;
}
function renderQaSection2(qa) {
  if (qa.length === 0) return "";
  const items = qa.slice(0, 10).map(
    (q) => `<div class="qa-pair" data-cerveau-kind="qa"><p class="question"><strong>Q:</strong> ${esc3(q.question)}</p><p class="source"><a href="#/note/${esc3(q.sourceId)}" data-cerveau-link-type="documents" data-cerveau-link-confidence="inferred">source</a></p></div>`
  ).join("\n");
  return `<section data-section="qa"><h3>Q&amp;A</h3>${items}</section>`;
}
function renderConversationSourcesSection(noteIds) {
  if (noteIds.length === 0) return "";
  const items = noteIds.slice(0, 20).map(
    (id) => `<li><a href="#/note/${esc3(id)}" data-cerveau-link-type="source" data-cerveau-link-confidence="extracted">${esc3(id)}</a></li>`
  );
  const list = noteIds.length > 5 ? `<details><summary>${noteIds.length} conversations</summary><ul>${items.join("\n")}</ul></details>` : `<ul>${items.join("\n")}</ul>`;
  return `<section data-section="sources"><h3>Conversation Sources</h3>${list}</section>`;
}
function buildTldr2(node, _tree) {
  if (node.level === 0) {
    const projectCount = node.children.length;
    const totalConvs = node.conversationCount;
    return `Brain index \u2014 ${projectCount} project${projectCount !== 1 ? "s" : ""}, ${totalConvs} conversation${totalConvs !== 1 ? "s" : ""}.`;
  }
  if (node.level === 1) {
    const moduleCount = node.children.length;
    const convCount2 = node.conversationCount;
    return `Project ${node.segment} \u2014 ${moduleCount} module${moduleCount !== 1 ? "s" : ""}, ${convCount2} conversation${convCount2 !== 1 ? "s" : ""}.`;
  }
  if (node.level === 2) {
    const featureCount = node.children.length;
    const convCount2 = node.conversationCount;
    return `Module ${node.segment} \u2014 ${featureCount} feature${featureCount !== 1 ? "s" : ""}, ${convCount2} conversation${convCount2 !== 1 ? "s" : ""}.`;
  }
  const convCount = node.conversationCount;
  return `Feature ${node.segment} \u2014 ${convCount} conversation${convCount !== 1 ? "s" : ""}.`;
}
function buildTitle2(node) {
  if (node.level === 0) return "Brain Index";
  return node.id.split("/").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" / ");
}
function renderRootStats(tree) {
  const totalNodes = tree.totalNodes;
  const projectCount = tree.projects.length;
  let moduleCount = 0;
  let featureCount = 0;
  for (const [, node] of tree.byId) {
    if (node.level === 2) moduleCount += 1;
    if (node.level >= 3) featureCount += 1;
  }
  const rows = [
    `<tr><td>Total nodes</td><td>${totalNodes}</td></tr>`,
    `<tr><td>Projects</td><td>${projectCount}</td></tr>`,
    `<tr><td>Modules</td><td>${moduleCount}</td></tr>`,
    `<tr><td>Features</td><td>${featureCount}</td></tr>`
  ];
  return `<section data-section="stats"><h3>Stats</h3><table class="wikitable compact"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></section>`;
}
function composeHierarchyNode(input) {
  const { node, tree } = input;
  const now = nowIso();
  const id = nodeSlug(node.id);
  const title = buildTitle2(node);
  const tldr = buildTldr2(node, tree);
  const project = node.level === 0 ? "_root" : node.id.split("/")[0];
  const sections = [];
  sections.push(`<section data-section="tldr"><p>${esc3(tldr)}</p></section>`);
  if (node.level === 0) {
    sections.push(renderRootStats(tree));
    sections.push(renderChildrenSection3(node, tree));
  }
  if (node.level === 1) {
    sections.push(renderChildrenSection3(node, tree));
    sections.push(renderCodeFilesSection(input.codeFiles, "Architecture"));
    sections.push(renderDecisionsSection(input.decisions));
    sections.push(renderBugsSection(input.bugs));
    sections.push(renderIdeasSection(input.ideas));
    sections.push(renderRulesSection(input.rules));
  }
  if (node.level === 2) {
    sections.push(renderChildrenSection3(node, tree));
    sections.push(renderCodeFilesSection(input.codeFiles, "Architecture"));
    sections.push(renderDecisionsSection(input.decisions));
    sections.push(renderBugsSection(input.bugs));
    sections.push(renderIdeasSection(input.ideas));
    sections.push(renderRulesSection(input.rules));
  }
  if (node.level >= 3) {
    sections.push(renderChildrenSection3(node, tree));
    sections.push(renderCodeFilesSection(input.codeFiles, "Code Files"));
    sections.push(renderDecisionsSection(input.decisions));
    sections.push(renderBugsSection(input.bugs));
    sections.push(renderIdeasSection(input.ideas));
    sections.push(renderRulesSection(input.rules));
    sections.push(renderFactsSection2(input.facts));
    sections.push(renderQaSection2(input.qa));
    sections.push(renderConversationSourcesSection(node.noteIds));
  }
  const sectionCount = sections.filter(Boolean).length;
  const levelLabel = node.level === 0 ? "root" : node.level === 1 ? "project" : node.level === 2 ? "module" : "feature";
  const article = [
    `<article id="${esc3(id)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-created="${esc3(input.created)}"`,
    `  data-cerveau-synthesized-at="${esc3(now)}"`,
    `  data-cerveau-type="hierarchy-node"`,
    `  data-cerveau-source="build-hierarchy"`,
    `  data-cerveau-level="${node.level}"`,
    `  data-cerveau-level-label="${esc3(levelLabel)}"`,
    `  data-cerveau-topic="${esc3(node.id)}"`,
    `  data-cerveau-project="${esc3(project)}"`,
    `  data-cerveau-conv-count="${node.conversationCount}"`,
    `  data-cerveau-child-count="${node.children.length}"`,
    `  data-cerveau-section-count="${sectionCount}"`,
    ">",
    `<header class="wiki-header">`,
    `  <h1>${esc3(title)}</h1>`,
    `  <aside class="infobox"><dl>`,
    `    <dt>Level</dt><dd><span class="type-badge ${esc3(levelLabel)}">${esc3(levelLabel)}</span></dd>`,
    `    <dt>Topic</dt><dd>${esc3(node.id)}</dd>`,
    `    <dt>Conversations</dt><dd>${node.conversationCount}</dd>`,
    `    <dt>Children</dt><dd>${node.children.length}</dd>`,
    "  </dl></aside>",
    "</header>",
    renderBreadcrumb4(node, tree),
    ...sections.filter(Boolean),
    "</article>"
  ];
  return article.join("\n");
}
var init_hierarchy_node_composer = __esm({
  "src/commands/hierarchy-node-composer.ts"() {
    "use strict";
    init_pkg_version();
    init_telemetry();
  }
});

// src/commands/build-hierarchy.ts
var build_hierarchy_exports = {};
__export(build_hierarchy_exports, {
  runBuildHierarchy: () => runBuildHierarchy
});
import { existsSync as existsSync40, mkdirSync as mkdirSync20, writeFileSync as writeFileSync30 } from "node:fs";
import { dirname as dirname12 } from "node:path";
function nodeExists(nodeSlugId) {
  return existsSync40(knowledgeNodePath(nodeSlugId));
}
function writeNode(nodeSlugId, html) {
  const targetPath = knowledgeNodePath(nodeSlugId);
  mkdirSync20(dirname12(targetPath), { recursive: true });
  writeFileSync30(targetPath, html, "utf8");
}
function buildInput(node, tree, created) {
  return {
    node,
    tree,
    decisions: [],
    bugs: [],
    ideas: [],
    rules: [],
    facts: [],
    qa: [],
    codeFiles: [],
    created
  };
}
async function runBuildHierarchy(opts) {
  const log = getLogger();
  const report = {
    rootCreated: false,
    projectsCreated: 0,
    modulesCreated: 0,
    featuresCreated: 0,
    totalCreated: 0,
    errors: []
  };
  const notes = readAllNotes();
  log.debug({ noteCount: notes.length }, "build-hierarchy: notes loaded");
  const tree = extractHierarchy(notes);
  log.debug(
    { totalNodes: tree.totalNodes, projects: tree.projects.length },
    "build-hierarchy: hierarchy extracted"
  );
  const created = nowIso();
  for (const [, node] of tree.byId) {
    const nodeSlugId = slug(node.id);
    if (!opts.force && nodeExists(nodeSlugId)) {
      log.debug({ nodeId: node.id }, "build-hierarchy: skipped (exists)");
      continue;
    }
    try {
      const input = buildInput(node, tree, created);
      const html = composeHierarchyNode(input);
      writeNode(nodeSlugId, html);
      if (node.level === 0) {
        report.rootCreated = true;
      } else if (node.level === 1) {
        report.projectsCreated += 1;
      } else if (node.level === 2) {
        report.modulesCreated += 1;
      } else {
        report.featuresCreated += 1;
      }
      report.totalCreated += 1;
      log.debug({ nodeId: node.id, level: node.level }, "build-hierarchy: created");
    } catch (err) {
      const msg = err.message;
      report.errors.push(`${node.id}: ${msg}`);
      log.warn({ nodeId: node.id, err: msg }, "build-hierarchy: node failed");
    }
  }
  log.debug(
    {
      rootCreated: report.rootCreated,
      projects: report.projectsCreated,
      modules: report.modulesCreated,
      features: report.featuresCreated,
      errors: report.errors.length
    },
    "build-hierarchy: done"
  );
  return report;
}
var init_build_hierarchy = __esm({
  "src/commands/build-hierarchy.ts"() {
    "use strict";
    init_hierarchy();
    init_paths();
    init_reader();
    init_logger();
    init_telemetry();
    init_hierarchy_node_composer();
  }
});

// src/commands/enrich-hierarchy.ts
var enrich_hierarchy_exports = {};
__export(enrich_hierarchy_exports, {
  runEnrichHierarchy: () => runEnrichHierarchy
});
import { existsSync as existsSync41, mkdirSync as mkdirSync21, writeFileSync as writeFileSync31 } from "node:fs";
import { dirname as dirname13 } from "node:path";
function emptyBucket2() {
  return { decisions: [], bugs: [], ideas: [], rules: [], facts: [], qa: [] };
}
function countPopulatedSections(b) {
  return [b.decisions, b.bugs, b.ideas, b.rules, b.facts, b.qa].filter((a) => a.length > 0).length;
}
function dedupeByPrefix(items) {
  const seen = /* @__PURE__ */ new Set();
  return items.filter((item) => {
    const prefix = (item.text ?? item.question ?? "").slice(0, 80);
    if (seen.has(prefix)) return false;
    seen.add(prefix);
    return true;
  });
}
function deduplicateBucket(b) {
  return {
    decisions: dedupeByPrefix(b.decisions),
    bugs: dedupeByPrefix(b.bugs),
    ideas: dedupeByPrefix(b.ideas),
    rules: dedupeByPrefix(b.rules),
    facts: dedupeByPrefix(b.facts),
    qa: dedupeByPrefix(b.qa)
  };
}
function classifyChunk2(chunk, sourceId, bucket) {
  const trimmed = chunk.trim();
  if (trimmed.length < 20 || trimmed.length > 500) return;
  for (const { kind, pattern } of CLASSIFIERS2) {
    if (!pattern.test(trimmed)) continue;
    const text = trimmed.slice(0, 300);
    switch (kind) {
      case "decision":
        bucket.decisions.push({ text, sourceId });
        break;
      case "bug":
        bucket.bugs.push({ text, sourceId });
        break;
      case "idea":
        bucket.ideas.push({ text, sourceId });
        break;
      case "rule":
        bucket.rules.push({ text, sourceId });
        break;
      case "qa":
        bucket.qa.push({ question: text, sourceId });
        break;
    }
    return;
  }
}
function matchesNode(notePath2, node) {
  if (node.level === 0) return true;
  const nodeId = node.id;
  return notePath2 === nodeId || notePath2.startsWith(`${nodeId}/`);
}
function sectionCapForLevel(level) {
  if (level === 0) return 15;
  if (level === 1) return 12;
  if (level === 2) return 10;
  return 8;
}
function isAlreadyEnriched(html) {
  return html.includes('data-section="decisions"') || html.includes('data-section="bugs"') || html.includes('data-section="ideas"') || html.includes('data-section="rules"') || html.includes('data-section="facts"') || html.includes('data-section="qa"');
}
function extractCwdFromHtml(html) {
  const m = html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
  return m?.[1] ?? null;
}
async function runEnrichHierarchy(opts) {
  const log = getLogger();
  const report = {
    nodesEnriched: 0,
    sectionsPopulated: 0,
    conversationsScanned: 0,
    errors: []
  };
  const allNotes = readAllNotes();
  log.debug({ noteCount: allNotes.length }, "enrich-hierarchy: notes loaded");
  const tree = extractHierarchy(allNotes);
  log.debug(
    { totalNodes: tree.totalNodes, projects: tree.projects.length },
    "enrich-hierarchy: hierarchy extracted"
  );
  const contributions = [];
  for (const note of allNotes) {
    if (note.html.includes('data-cerveau-source="build-hierarchy"') || note.html.includes('data-cerveau-source="synthesize-nodes"') || note.html.includes('data-cerveau-type="hierarchy-node"')) {
      continue;
    }
    const rawCwd = extractCwdFromHtml(note.html);
    if (!rawCwd) continue;
    const normalized = normalizeCwd(rawCwd);
    if (!normalized) continue;
    const { topicPath } = normalized;
    if (!topicPath) continue;
    const plainText = note.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (plainText.length < 30) continue;
    const chunks = plainText.split(/[.!\n]+/).filter((s) => s.trim().length > 20 && s.trim().length < 500);
    const noteId = note.id || note.path;
    const bucket = emptyBucket2();
    for (const chunk of chunks.slice(0, 50)) {
      classifyChunk2(chunk, noteId, bucket);
    }
    const firstChunk = chunks[0]?.trim();
    if (firstChunk && firstChunk.length > 20) {
      bucket.facts.push({ text: firstChunk.slice(0, 200), sourceId: noteId });
    }
    contributions.push({ topicPath, bucket });
    report.conversationsScanned += 1;
  }
  log.debug({ contributions: contributions.length }, "enrich-hierarchy: contributions classified");
  const created = nowIso();
  for (const [, node] of tree.byId) {
    if (opts.topic) {
      const topicFilter = opts.topic;
      if (node.id !== topicFilter && !node.id.startsWith(`${topicFilter}/`) && node.level !== 0) {
        continue;
      }
    }
    const nodeSlugId = slug(node.id);
    const targetPath = knowledgeNodePath(nodeSlugId);
    if (!opts.force && existsSync41(targetPath)) {
      try {
        const { readFileSync: readFileSync46 } = await import("node:fs");
        const existingHtml = readFileSync46(targetPath, "utf8");
        if (isAlreadyEnriched(existingHtml)) {
          log.debug({ nodeId: node.id }, "enrich-hierarchy: skipped (already enriched)");
          continue;
        }
      } catch {
      }
    }
    try {
      const merged = emptyBucket2();
      for (const contrib of contributions) {
        if (!matchesNode(contrib.topicPath, node)) continue;
        for (const d of contrib.bucket.decisions) merged.decisions.push(d);
        for (const b of contrib.bucket.bugs) merged.bugs.push(b);
        for (const i of contrib.bucket.ideas) merged.ideas.push(i);
        for (const r of contrib.bucket.rules) merged.rules.push(r);
        for (const f of contrib.bucket.facts) merged.facts.push(f);
        for (const q of contrib.bucket.qa) merged.qa.push(q);
      }
      const deduped = deduplicateBucket(merged);
      const cap = sectionCapForLevel(node.level);
      const html = composeHierarchyNode({
        node,
        tree,
        decisions: deduped.decisions.slice(0, cap),
        bugs: deduped.bugs.slice(0, cap),
        ideas: deduped.ideas.slice(0, cap),
        rules: deduped.rules.slice(0, cap),
        facts: deduped.facts.slice(0, cap),
        qa: deduped.qa.slice(0, cap),
        codeFiles: [],
        created
      });
      mkdirSync21(dirname13(targetPath), { recursive: true });
      writeFileSync31(targetPath, html, "utf8");
      const populated = countPopulatedSections(deduped);
      report.nodesEnriched += 1;
      report.sectionsPopulated += populated;
      log.debug(
        {
          nodeId: node.id,
          level: node.level,
          sections: populated,
          decisions: deduped.decisions.length,
          bugs: deduped.bugs.length,
          ideas: deduped.ideas.length,
          rules: deduped.rules.length,
          facts: deduped.facts.length,
          qa: deduped.qa.length
        },
        "enrich-hierarchy: node enriched"
      );
    } catch (err) {
      const msg = err.message;
      report.errors.push(`${node.id}: ${msg}`);
      log.warn({ nodeId: node.id, err: msg }, "enrich-hierarchy: node failed");
    }
  }
  log.debug(
    {
      nodesEnriched: report.nodesEnriched,
      sectionsPopulated: report.sectionsPopulated,
      conversationsScanned: report.conversationsScanned,
      errors: report.errors.length
    },
    "enrich-hierarchy: done"
  );
  return report;
}
var CLASSIFIERS2;
var init_enrich_hierarchy = __esm({
  "src/commands/enrich-hierarchy.ts"() {
    "use strict";
    init_hierarchy();
    init_paths();
    init_reader();
    init_cwd_normalizer();
    init_logger();
    init_telemetry();
    init_hierarchy_node_composer();
    CLASSIFIERS2 = [
      {
        kind: "decision",
        pattern: /(?:decided|decision|chose|chosen|went\s+with|opted|choisi|décidé|on\s+(?:a|va)\s+(?:pris|fait|choisi|utilisé))/i
      },
      {
        kind: "bug",
        pattern: /(?:bug|error|crash|fix(?:ed)?|broken|cassé|erreur|TypeError|ReferenceError|ENOENT|failed|plantage)/i
      },
      {
        kind: "idea",
        pattern: /(?:idea|should|could\s+we|todo|improve|enhancement|idée|améliorer|pourrait|faudrait|on\s+devrait)/i
      },
      {
        kind: "rule",
        pattern: /(?:always|never|must(?:\s+not)?|rule|convention|obligat|interdit|jamais|toujours|ne\s+(?:pas|jamais))/i
      },
      {
        kind: "qa",
        pattern: /(?:^|\s)(?:why|how|what|when|pourquoi|comment|quoi|qu['']est)[^.]{5,}\?/i
      }
    ];
  }
});

// src/commands/export-agents-md.ts
var export_agents_md_exports = {};
__export(export_agents_md_exports, {
  LB_BEGIN_MARKER: () => LB_BEGIN_MARKER,
  LB_END_MARKER: () => LB_END_MARKER,
  runExportAgentsMd: () => runExportAgentsMd
});
import { existsSync as existsSync42, readFileSync as readFileSync39, writeFileSync as writeFileSync32 } from "node:fs";
import { join as join40, resolve as resolve3 } from "node:path";
import { parseHTML as parseHTML19 } from "linkedom";
async function runExportAgentsMd(opts) {
  const maxTokens = opts.maxTokens ?? 1200;
  const outFile = opts.outFile ?? (opts.target === "user" ? join40(vibeHome(), "AGENTS.md") : join40(resolve3(opts.cwd ?? process.cwd()), "AGENTS.md"));
  const block = opts.target === "user" ? renderUserBlock() : renderProjectBlock(resolve3(opts.cwd ?? process.cwd()), maxTokens);
  const existing = existsSync42(outFile) ? readFileSync39(outFile, "utf8") : "";
  const beginCount = countOccurrences(existing, LB_BEGIN_MARKER);
  const endCount = countOccurrences(existing, LB_END_MARKER);
  if (beginCount !== endCount || beginCount > 1) {
    return {
      written: false,
      outFile,
      tokens: 0,
      items: 0,
      reason: `unbalanced lazybrain markers in ${outFile} (begin=${beginCount}, end=${endCount}) \u2014 fix manually`
    };
  }
  if (beginCount === 1 && existing.indexOf(LB_END_MARKER) < existing.indexOf(LB_BEGIN_MARKER)) {
    return {
      written: false,
      outFile,
      tokens: 0,
      items: 0,
      reason: `lazybrain markers out of order in ${outFile} (end before begin) \u2014 fix manually`
    };
  }
  const wrapped = `${LB_BEGIN_MARKER}
${block.text}
${LB_END_MARKER}`;
  let next;
  if (beginCount === 1) {
    const start = existing.indexOf(LB_BEGIN_MARKER);
    const end = existing.indexOf(LB_END_MARKER) + LB_END_MARKER.length;
    next = existing.slice(0, start) + wrapped + existing.slice(end);
  } else if (existing.trim().length > 0) {
    next = `${existing.replace(/\s*$/, "")}

${wrapped}
`;
  } else {
    next = `${wrapped}
`;
  }
  if (next !== existing) writeFileSync32(outFile, next, "utf8");
  return {
    written: true,
    outFile,
    tokens: estimateTokenCount(block.text),
    items: block.items
  };
}
function renderUserBlock() {
  const lines = [
    "## Persistent memory (LazyBrain)",
    "",
    "This machine has a LazyBrain HTML memory brain. Before re-deciding anything,",
    "recall settled knowledge with the CLI (deterministic, <30ms, $0):",
    "",
    "```bash",
    'lazybrain search "<topic>" --top 5 --strip',
    `lazybrain query 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])'`,
    "```",
    "",
    "Project-scoped facts live in each project's own AGENTS.md (generated)."
  ];
  return { text: lines.join("\n"), items: 1 };
}
function renderProjectBlock(cwd, maxTokens) {
  const needle = cwd.replace(/\\/g, "/").toLowerCase();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const candidates = listAll({ includeExpired: true }).filter((n) => {
    const vu = n.valid_until;
    if (vu && vu.trim() !== "" && vu < now) return false;
    return n.type === "decision" || (n.importance ?? 0) >= 0.7;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const decisions = [];
  const warnings = [];
  let scanned = 0;
  for (const n of candidates) {
    if (scanned >= 300) break;
    scanned += 1;
    let html;
    try {
      html = readNote(n.path).html;
    } catch {
      continue;
    }
    const noteCwd = extractAttr(html, "data-cerveau-cwd");
    if (!noteCwd || !noteCwd.replace(/\\/g, "/").toLowerCase().startsWith(needle)) continue;
    const { document } = parseHTML19(`<!doctype html><body>${html}</body>`);
    const tldr = document.querySelector('section[data-section="tldr"] p')?.textContent?.trim() ?? document.querySelector("details[open] summary")?.textContent?.trim() ?? "";
    if (tldr && n.type === "decision") decisions.push(`- ${tldr} \`[#${n.id}]\``);
    for (const aside of Array.from(document.querySelectorAll('aside[role="doc-warning"]'))) {
      const w = aside.textContent?.trim();
      if (w) warnings.push(`- ${w.slice(0, 200)} \`[#${n.id}]\``);
    }
  }
  return assembleProjectBlock(dedupe(decisions), dedupe(warnings), maxTokens);
}
function assembleProjectBlock(decisions, warnings, maxTokens) {
  const build = (d2, w2) => {
    const lines = ["## Project memory (LazyBrain \u2014 generated, do not edit)"];
    if (d2.length > 0) lines.push("", "### Settled decisions (do not re-litigate)", ...d2);
    if (w2.length > 0) lines.push("", "### Warnings / anti-patterns", ...w2);
    if (d2.length === 0 && w2.length === 0) {
      lines.push("", "_No settled project facts yet. Run `lazybrain dream` after a few sessions._");
    }
    lines.push("", 'Recall more: `lazybrain search "<topic>" --top 5 --strip`');
    return lines.join("\n");
  };
  const d = [...decisions];
  const w = [...warnings];
  let text = build(d, w);
  while (estimateTokenCount(text) > maxTokens && (d.length > 0 || w.length > 0)) {
    if (w.length > 0) w.pop();
    else d.pop();
    text = build(d, w);
  }
  return { text, items: d.length + w.length };
}
function extractAttr(html, attr) {
  const m = html.match(new RegExp(`${attr}="([^"]*)"`));
  return m ? m[1] : null;
}
function dedupe(items) {
  return [...new Set(items)];
}
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
var LB_BEGIN_MARKER, LB_END_MARKER;
var init_export_agents_md = __esm({
  "src/commands/export-agents-md.ts"() {
    "use strict";
    init_fts();
    init_vibe();
    init_reader();
    init_tokenize();
    LB_BEGIN_MARKER = "<!-- lazybrain:begin generated:do-not-edit -->";
    LB_END_MARKER = "<!-- lazybrain:end -->";
  }
});

// src/commands/capture-vibe.ts
var capture_vibe_exports = {};
__export(capture_vibe_exports, {
  runCaptureVibe: () => runCaptureVibe
});
import { existsSync as existsSync43, readFileSync as readFileSync40, writeFileSync as writeFileSync33 } from "node:fs";
import { dirname as dirname14, join as join41 } from "node:path";
function cursorPath() {
  return join41(getConfig().cachePath, "vibe-cursors.json");
}
function loadCursors() {
  try {
    const raw = readFileSync40(cursorPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveCursors(store) {
  writeFileSync33(cursorPath(), JSON.stringify(store, null, 2), "utf8");
}
function safeReadSync(path) {
  try {
    return readFileSync40(path, "utf8");
  } catch {
    return "";
  }
}
async function runCaptureVibe(opts) {
  const log = getLogger();
  const start = Date.now();
  if (!opts.transcriptPath || !existsSync43(opts.transcriptPath)) {
    return JSON.stringify({ status: "noop", reason: "missing transcript" });
  }
  const messages = parseVibeMessages(readFileSync40(opts.transcriptPath, "utf8"));
  const cursors = loadCursors();
  const processed = cursors[opts.transcriptPath]?.processedCount ?? 0;
  const fresh = messages.slice(processed);
  if (fresh.length === 0) {
    return JSON.stringify({ status: "noop", reason: "no new messages" });
  }
  const meta = parseVibeMeta(safeReadSync(join41(dirname14(opts.transcriptPath), "meta.json")));
  const cwd = opts.cwd ?? meta?.environment?.working_directory ?? void 0;
  if (cwd && /cerveau|lazybrain/i.test(cwd)) {
    cursors[opts.transcriptPath] = { processedCount: messages.length };
    saveCursors(cursors);
    return JSON.stringify({ status: "skipped", reason: "self_ingest_guard" });
  }
  const text = extractVibeSummary(fresh);
  const { filesModified, filesRead } = extractVibeToolFiles(fresh, cwd ?? "");
  const effectiveText = text.length >= 40 ? text : filesModified.length > 0 || filesRead.length > 0 ? [
    filesModified.length ? `vibe edit: modified ${filesModified.join(", ")}` : "",
    filesRead.length ? `read ${filesRead.join(", ")}` : ""
  ].filter(Boolean).join(". ") : "";
  cursors[opts.transcriptPath] = { processedCount: messages.length };
  saveCursors(cursors);
  if (!effectiveText) {
    return JSON.stringify({ status: "skipped", reason: "no_substance" });
  }
  const validation = shouldCapture(effectiveText);
  if (!validation.ok) {
    logTelemetry({
      event: "capture_skipped",
      ts: nowIso(),
      session: opts.sessionId ?? "vibe",
      reason: validation.reason,
      tokens_in: estimateTokenCount(effectiveText)
    });
    return JSON.stringify({ status: "skipped", reason: validation.reason });
  }
  const sessionKey = meta?.session_id ?? opts.sessionId ?? opts.transcriptPath;
  const annotated = annotateSession({
    sessionId: makeSourceSessionId("vibe", `${opts.transcriptPath}#${processed}`),
    text: effectiveText.slice(0, 4e3),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    cwd,
    filesModified: filesModified.length ? filesModified : void 0,
    filesRead: filesRead.length ? filesRead : void 0,
    agent: "vibe",
    sourceKind: "transcript",
    sessionParent: meta?.parent_session_id ?? void 0,
    gitCommit: meta?.git_commit ?? void 0,
    gitBranch: meta?.git_branch ?? void 0
  });
  const result = writeNote(annotated.html, { overwrite: true });
  indexNote(readNote(result.path));
  recordCapture(validation.hash);
  logTelemetry({
    event: "capture",
    ts: nowIso(),
    session: sessionKey,
    tokens_in: estimateTokenCount(effectiveText),
    tokens_out_html: estimateTokenCount(annotated.html),
    strip_ratio: 0,
    duration_ms: Date.now() - start
  });
  log.debug({ id: result.id, fresh: fresh.length }, "capture-vibe: stored note");
  await runIncrementalEnrich();
  scheduleAgentsMdRefresh(cwd);
  return JSON.stringify({
    status: "ok",
    id: result.id,
    processedMessages: fresh.length,
    facts: annotated.factCount
  });
}
function scheduleAgentsMdRefresh(cwd) {
  if (!cwd) return;
  try {
    const intervalS = Number(process.env.LAZYBRAIN_VIBE_REFRESH_SECONDS ?? "300");
    const marker = join41(getConfig().cachePath, "vibe-agentsmd-refresh.txt");
    const nowEpoch = Math.floor(Date.now() / 1e3);
    let last = 0;
    try {
      last = Number(readFileSync40(marker, "utf8").trim()) || 0;
    } catch {
    }
    if (nowEpoch - last < intervalS) return;
    writeFileSync33(marker, String(nowEpoch), "utf8");
    void Promise.resolve().then(() => (init_export_agents_md(), export_agents_md_exports)).then(({ runExportAgentsMd: runExportAgentsMd2 }) => runExportAgentsMd2({ target: "project", cwd })).catch(() => {
    });
  } catch {
  }
}
var init_capture_vibe = __esm({
  "src/commands/capture-vibe.ts"() {
    "use strict";
    init_heuristic();
    init_validator();
    init_fts();
    init_types();
    init_vibe_parser();
    init_reader();
    init_writer();
    init_config();
    init_logger();
    init_telemetry();
    init_tokenize();
    init_enrich();
  }
});

// src/commands/daemon.ts
import { createHash as createHash11 } from "node:crypto";
import {
  existsSync as existsSync44,
  mkdirSync as mkdirSync22,
  readFileSync as readFileSync41,
  readdirSync as readdirSync10,
  statSync as statSync12,
  unlinkSync as unlinkSync4,
  writeFileSync as writeFileSync34
} from "node:fs";
import { createServer } from "node:http";
import { join as join42 } from "node:path";
function computeBrainMtime() {
  const now = Date.now();
  if (brainMtimeCache && now - brainMtimeCache.computedAt < BRAIN_MTIME_CACHE_MS) {
    return brainMtimeCache.value;
  }
  const root = join42(getConfig().brainPath, "notes");
  let maxMtime = 0;
  if (existsSync44(root)) {
    for (const month of readdirSync10(root)) {
      const monthDir = join42(root, month);
      try {
        for (const f of readdirSync10(monthDir)) {
          const s = statSync12(join42(monthDir, f));
          if (s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
        }
      } catch {
      }
    }
  }
  brainMtimeCache = { value: maxMtime, computedAt: now };
  return maxMtime;
}
function invalidateBrainMtime() {
  brainMtimeCache = { value: Date.now(), computedAt: Date.now() };
  responseCache.clear();
}
function cacheGet3(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  responseCache.delete(key);
  responseCache.set(key, entry);
  return entry.value;
}
function cacheSet3(key, value) {
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey !== void 0) responseCache.delete(oldestKey);
  }
  responseCache.set(key, { value, storedAt: Date.now() });
}
function cacheKey(endpoint, parts) {
  const raw = `${endpoint}|${parts.map((p) => p === void 0 ? "" : String(p)).join("|")}`;
  return createHash11("sha1").update(raw).digest("hex");
}
function pidPath() {
  return join42(getConfig().cachePath, "daemon.pid");
}
function portPath() {
  return join42(getConfig().cachePath, "daemon.port");
}
function lockPath() {
  return join42(getConfig().cachePath, "daemon.lock");
}
function readDaemonPort() {
  try {
    const raw = readFileSync41(portPath(), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function readDaemonPid() {
  try {
    const raw = readFileSync41(pidPath(), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function pingDaemon(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
async function startDaemonForeground(opts) {
  const cfg = getConfig();
  const log = getLogger();
  if (!existsSync44(cfg.cachePath)) mkdirSync22(cfg.cachePath, { recursive: true });
  const existingPort = readDaemonPort();
  const existingPid = readDaemonPid();
  if (existingPort && existingPid && isProcessAlive(existingPid)) {
    const alive = await pingDaemon(existingPort, 500);
    if (alive) {
      log.warn({ port: existingPort, pid: existingPid }, "daemon already running");
      return;
    }
  }
  const port = opts.port ?? DEFAULT_PORT;
  const idle = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const state = {
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    hits: 0,
    cacheHits: 0,
    cacheMisses: 0,
    port
  };
  const server = createServer((req, res) => handleRequest(req, res, state));
  await new Promise((resolve9, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      writeFileSync34(pidPath(), String(process.pid), "utf8");
      writeFileSync34(portPath(), String(port), "utf8");
      log.info({ port, pid: process.pid }, "lazybrain daemon listening");
      resolve9();
    });
  });
  const cleanup = () => {
    server.close();
    try {
      unlinkSync4(pidPath());
    } catch {
    }
    try {
      unlinkSync4(portPath());
    } catch {
    }
    try {
      unlinkSync4(lockPath());
    } catch {
    }
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  const idleTimer = setInterval(() => {
    if (Date.now() - state.lastActivityAt > idle) {
      log.info({ hits: state.hits }, "daemon idle, shutting down");
      cleanup();
    }
  }, 6e4);
  idleTimer.unref();
  await new Promise(() => {
  });
}
async function handleRequest(req, res, state) {
  state.lastActivityAt = Date.now();
  state.hits += 1;
  const url = req.url ?? "/";
  if (req.method === "GET" && url === "/health") {
    const cacheTotal = state.cacheHits + state.cacheMisses;
    let brainStats = null;
    try {
      const root = join42(getConfig().brainPath, "notes");
      let count = 0;
      if (existsSync44(root)) {
        for (const month of readdirSync10(root)) {
          try {
            for (const f of readdirSync10(join42(root, month))) {
              if (f.endsWith(".html")) count += 1;
            }
          } catch {
          }
        }
      }
      brainStats = { notes: count, mtime_ms: computeBrainMtime() };
    } catch {
    }
    return sendJson2(res, 200, {
      ok: true,
      port: state.port,
      uptime_ms: Date.now() - state.startedAt,
      hits: state.hits,
      cache_hits: state.cacheHits,
      cache_misses: state.cacheMisses,
      cache_hit_ratio: cacheTotal ? +(state.cacheHits / cacheTotal).toFixed(3) : 0,
      cache_size: responseCache.size,
      brain: brainStats
    });
  }
  if (req.method !== "POST") {
    return sendJson2(res, 405, { error: "method not allowed" });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson2(res, 400, { error: `invalid body: ${err.message}` });
  }
  try {
    switch (url) {
      case "/inject-context": {
        const mode2 = optStrField(body, "mode") ?? "session";
        const format = optStrField(body, "format") ?? "full";
        const maxTokens = numField(body, "max_tokens", mode2 === "turn" ? 150 : 3e3);
        const query = optStrField(body, "query") ?? "";
        const minScore = typeof body.min_score === "number" ? body.min_score : void 0;
        const cwd = optStrField(body, "cwd");
        const sessionId = optStrField(body, "session_id");
        const useCache = mode2 !== "turn" || !sessionId;
        const key = cacheKey("inject", [
          mode2,
          format,
          maxTokens,
          query,
          minScore,
          cwd,
          computeBrainMtime()
        ]);
        if (useCache) {
          const cached3 = cacheGet3(key);
          if (cached3 !== null) {
            state.cacheHits += 1;
            logTelemetry({
              event: "cache_hit",
              ts: nowIso(),
              endpoint: "inject-context",
              key_hash: key.slice(0, 8)
            });
            return sendText(res, 200, cached3);
          }
        }
        state.cacheMisses += 1;
        const text = await runInjectContext({
          maxTokens,
          preferRecent: !!body.prefer_recent,
          preferImportant: !!body.prefer_important,
          mode: mode2,
          format,
          query,
          minScore,
          cwd,
          sessionId
        });
        if (useCache) cacheSet3(key, text);
        return sendText(res, 200, text);
      }
      case "/search": {
        const query = strField2(body, "query");
        const top = numField(body, "top", 5);
        const strip = !!body.strip;
        const searchMode = body.mode ?? "auto";
        const cwd = optStrField(body, "cwd");
        const sourcePrefix = optStrField(body, "source_prefix");
        const key = cacheKey("search", [
          query,
          top,
          strip ? 1 : 0,
          searchMode,
          cwd,
          sourcePrefix,
          computeBrainMtime()
        ]);
        const cached3 = cacheGet3(key);
        if (cached3 !== null) {
          state.cacheHits += 1;
          logTelemetry({
            event: "cache_hit",
            ts: nowIso(),
            endpoint: "search",
            key_hash: key.slice(0, 8)
          });
          return sendText(res, 200, cached3);
        }
        state.cacheMisses += 1;
        const text = await runSearch({
          query,
          top,
          strip,
          mode: searchMode,
          cwd,
          sourcePrefix: sourcePrefix ?? void 0
        });
        cacheSet3(key, text);
        return sendText(res, 200, text);
      }
      case "/capture": {
        const raw = optStrField(body, "raw") ?? "";
        const session = optStrField(body, "session");
        const async = !!body.async;
        const flushSync = !!body.flush_sync;
        const out = await runCaptureInProcess(raw, session, { async, flushSync });
        invalidateBrainMtime();
        return sendText(res, 200, out);
      }
      case "/compress": {
        const out = runCompress({
          session: optStrField(body, "session"),
          olderThanDays: numField(body, "older_than_days", 7),
          purgeNoise: !!body.purge_noise,
          purgeSource: optStrField(body, "purge_source")
        });
        return sendText(res, 200, out);
      }
      case "/maintenance": {
        const compressOut = runCompress({ olderThanDays: 7 });
        const purgeOut = runCompress({ purgeNoise: true });
        const { runProfileUpdate: runProfileUpdate2 } = await Promise.resolve().then(() => (init_profile_update(), profile_update_exports));
        const profileOut = runProfileUpdate2({});
        const graphOut = await runGraph({});
        const { runEnrich: runEnrich2 } = await Promise.resolve().then(() => (init_enrich(), enrich_exports));
        const enrichOut = await runEnrich2({});
        const { runInterlink: runInterlink2 } = await Promise.resolve().then(() => (init_interlink(), interlink_exports));
        const interlinkOut = await runInterlink2({ limit: 50 });
        const { runBuildIndex: runBuildIndex2 } = await Promise.resolve().then(() => (init_build_index(), build_index_exports));
        const indexOut = await runBuildIndex2({});
        const { runBuildClusters: runBuildClusters2 } = await Promise.resolve().then(() => (init_build_clusters(), build_clusters_exports));
        const clustersOut = await runBuildClusters2({});
        invalidateBrainMtime();
        const tryParse = (s) => {
          try {
            return JSON.parse(s);
          } catch {
            return s;
          }
        };
        return sendJson2(res, 200, {
          compress: tryParse(compressOut),
          purge_noise: tryParse(purgeOut),
          profile: tryParse(profileOut),
          graph: tryParse(graphOut),
          enrich: enrichOut,
          interlink: tryParse(interlinkOut),
          build_index: indexOut,
          build_clusters: clustersOut
        });
      }
      case "/graph": {
        const out = await runGraph({});
        return sendText(res, 200, out);
      }
      case "/extract": {
        const batchSize = numField(body, "batch_size", 10);
        const out = await runExtract({ batchSize });
        invalidateBrainMtime();
        return sendText(res, 200, out);
      }
      case "/neighbours":
      case "/graph-id": {
        const id = strField2(body, "id");
        return sendText(res, 200, runNeighbours({ id }));
      }
      case "/capture-vibe": {
        const transcriptPath = optStrField(body, "transcript_path") ?? "";
        const cwd = optStrField(body, "cwd");
        const sessionId = optStrField(body, "session_id");
        const { runCaptureVibe: runCaptureVibe2 } = await Promise.resolve().then(() => (init_capture_vibe(), capture_vibe_exports));
        const out = await runCaptureVibe2({ transcriptPath, cwd, sessionId });
        invalidateBrainMtime();
        return sendText(res, 200, out);
      }
      case "/shutdown": {
        sendJson2(res, 200, { ok: true });
        setImmediate(() => process.exit(0));
        return;
      }
      default:
        return sendJson2(res, 404, { error: "unknown endpoint" });
    }
  } catch (err) {
    if (mapDbError2(res, err)) return;
    const msg = err instanceof Error ? err.message : String(err);
    return sendJson2(res, 500, { error: msg });
  }
}
async function runCaptureInProcess(raw, session, opts) {
  if (opts.flushSync) {
    return await runCapture({ flushSync: true, session });
  }
  if (!raw) {
    return JSON.stringify({ status: "noop", reason: "empty input" });
  }
  const tmpDir = join42(getConfig().cachePath, "capture-queue");
  if (!existsSync44(tmpDir)) mkdirSync22(tmpDir, { recursive: true });
  const tmpFile = join42(
    tmpDir,
    `inflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  writeFileSync34(tmpFile, raw, "utf8");
  try {
    return await runCapture({ fromFile: tmpFile, session, async: opts.async });
  } finally {
    try {
      unlinkSync4(tmpFile);
    } catch {
    }
  }
}
function readJsonBody(req) {
  return new Promise((resolve9, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      chunks.push(c);
      total += c.length;
      if (total > 5e6) {
        req.destroy(new Error("body too large"));
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      if (!raw) return resolve9({});
      try {
        resolve9(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
function sendJson2(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function sendText(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}
function mapDbError2(res, err) {
  const code = err != null ? err.code : void 0;
  if (code === "SQLITE_BUSY") {
    res.writeHead(503, {
      "content-type": "application/json",
      "retry-after": "3"
    });
    res.end(JSON.stringify({ error: "Index is being rebuilt \u2014 retry in a few seconds" }));
    return true;
  }
  return false;
}
function strField2(body, key) {
  const v = body[key];
  if (typeof v !== "string") throw new Error(`missing string field "${key}"`);
  return v;
}
function optStrField(body, key) {
  const v = body[key];
  return typeof v === "string" ? v : void 0;
}
function numField(body, key, fallback) {
  const v = body[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fallback;
}
function runDaemonStatus(opts) {
  const port = readDaemonPort();
  const pid = readDaemonPid();
  const alive = pid !== null && isProcessAlive(pid);
  const payload = { port, pid, alive };
  if (opts.pretty) {
    return alive ? `daemon: running pid=${pid} port=${port}` : "daemon: not running";
  }
  return JSON.stringify(payload, null, 2);
}
async function runDaemonStop(opts) {
  const port = readDaemonPort();
  if (!port) return JSON.stringify({ status: "noop", reason: "no port file" });
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
  } catch {
  }
  try {
    unlinkSync4(pidPath());
  } catch {
  }
  try {
    unlinkSync4(portPath());
  } catch {
  }
  return opts.pretty ? "daemon stopped" : JSON.stringify({ status: "stopped" });
}
var DEFAULT_PORT, DEFAULT_IDLE_MS, CACHE_MAX_ENTRIES, CACHE_TTL_MS, BRAIN_MTIME_CACHE_MS, responseCache, brainMtimeCache;
var init_daemon = __esm({
  "src/commands/daemon.ts"() {
    "use strict";
    init_config();
    init_logger();
    init_telemetry();
    init_capture();
    init_compress();
    init_extract();
    init_graph();
    init_inject_context();
    init_neighbours();
    init_search();
    DEFAULT_PORT = 37788;
    DEFAULT_IDLE_MS = 30 * 60 * 1e3;
    CACHE_MAX_ENTRIES = 64;
    CACHE_TTL_MS = 6e4;
    BRAIN_MTIME_CACHE_MS = 5e3;
    responseCache = /* @__PURE__ */ new Map();
    brainMtimeCache = null;
  }
});

// src/commands/init-vibe.ts
var init_vibe_exports = {};
__export(init_vibe_exports, {
  runInitVibe: () => runInitVibe
});
import { copyFileSync as copyFileSync3, existsSync as existsSync50, mkdirSync as mkdirSync25, readFileSync as readFileSync44, writeFileSync as writeFileSync36 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join47, resolve as resolve7 } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";
import { parse as parseToml2, stringify as stringifyToml } from "smol-toml";
function pluginRoot() {
  return fileURLToPath5(new URL("../../plugins/lazybrain/", import.meta.url));
}
async function runInitVibe(opts = {}) {
  const log = getLogger();
  const warnings = [];
  const vibeHome2 = resolve7(opts.vibeHome ?? process.env.VIBE_HOME ?? join47(homedir5(), ".vibe"));
  const agentsHome = resolve7(opts.agentsHome ?? join47(homedir5(), ".agents"));
  const lazyBrainHome = resolve7(opts.lazyBrainHome ?? join47(homedir5(), ".lazybrain"));
  if (!existsSync50(vibeHome2)) {
    throw new Error(
      `Vibe home not found at ${vibeHome2}. Install mistral-vibe and run it once first (or set VIBE_HOME).`
    );
  }
  const hookInstalled = installHook(vibeHome2, lazyBrainHome, warnings);
  const experimentalHooksEnabled = opts.enableHooks ? enableExperimentalHooks(vibeHome2, warnings) : false;
  if (!opts.enableHooks && hookInstalled) {
    warnings.push(
      "Hooks stay dormant until enable_experimental_hooks=true in config.toml. Re-run with --enable-hooks to set it, or set it manually."
    );
  }
  const skillsInstalled = installSkills(agentsHome, warnings);
  const toolsInstalled = opts.tools ? installTool(vibeHome2, warnings) : false;
  const exploreInstalled = opts.explore ? installExplore(vibeHome2, warnings) : false;
  log.info({ vibeHome: vibeHome2, hookInstalled, skillsInstalled }, "init --agent vibe complete");
  return {
    vibeHome: vibeHome2,
    hookInstalled,
    experimentalHooksEnabled,
    skillsInstalled,
    toolsInstalled,
    exploreInstalled,
    warnings
  };
}
function installHook(vibeHome2, lazyBrainHome, warnings) {
  const hooksPath = join47(vibeHome2, "hooks.toml");
  const packageShimPath = join47(pluginRoot(), "vibe", "vibe-hook.mjs");
  const stableHooksDir = join47(lazyBrainHome, "hooks");
  const stableShimPath = join47(stableHooksDir, "vibe-hook.mjs");
  let shimPath = packageShimPath;
  try {
    mkdirSync25(stableHooksDir, { recursive: true });
    copyFileSync3(packageShimPath, stableShimPath);
    shimPath = stableShimPath;
  } catch (err) {
    warnings.push(
      `Could not copy hook shim to ${stableShimPath} (${err.message}). Falling back to package path \u2014 re-run after npm reinstall to refresh.`
    );
  }
  let doc = {};
  if (existsSync50(hooksPath)) {
    try {
      doc = parseToml2(readFileSync44(hooksPath, "utf8"));
    } catch (err) {
      warnings.push(
        `hooks.toml is not valid TOML (${err.message}) \u2014 hook NOT installed. Add it manually.`
      );
      return false;
    }
  }
  const hooks = Array.isArray(doc.hooks) ? doc.hooks : [];
  const kept = hooks.filter((h) => h.name !== HOOK_NAME);
  kept.push({
    name: HOOK_NAME,
    type: "post_agent_turn",
    command: `node "${shimPath}"`,
    timeout: 15,
    description: "LazyBrain incremental memory capture (always exits 0)"
  });
  const next = { ...doc, hooks: kept };
  writeFileSync36(hooksPath, `${stringifyToml(next)}
`, "utf8");
  return true;
}
function enableExperimentalHooks(vibeHome2, warnings) {
  const configPath = join47(vibeHome2, "config.toml");
  let doc = {};
  if (existsSync50(configPath)) {
    try {
      doc = parseToml2(readFileSync44(configPath, "utf8"));
    } catch (err) {
      warnings.push(
        `config.toml is not valid TOML (${err.message}) \u2014 flag NOT set. Set enable_experimental_hooks = true manually.`
      );
      return false;
    }
  }
  const next = { ...doc, enable_experimental_hooks: true };
  writeFileSync36(configPath, `${stringifyToml(next)}
`, "utf8");
  return true;
}
function installSkills(agentsHome, warnings) {
  const sourceDir = join47(pluginRoot(), "skills");
  const installed = [];
  for (const name of SKILLS_TO_PORT) {
    const sourceFile = join47(sourceDir, `${name}.SKILL.md`);
    if (!existsSync50(sourceFile)) {
      warnings.push(`skill source missing: ${sourceFile}`);
      continue;
    }
    const targetDir = join47(agentsHome, "skills", name);
    mkdirSync25(targetDir, { recursive: true });
    copyFileSync3(sourceFile, join47(targetDir, "SKILL.md"));
    installed.push(name);
  }
  return installed;
}
function installTool(vibeHome2, warnings) {
  const source = join47(pluginRoot(), "vibe", "tools", "lazybrain_read.py");
  if (!existsSync50(source)) {
    warnings.push(`tool source missing: ${source} (ships in a later task)`);
    return false;
  }
  const targetDir = join47(vibeHome2, "tools");
  mkdirSync25(targetDir, { recursive: true });
  copyFileSync3(source, join47(targetDir, "lazybrain_read.py"));
  return true;
}
function installExplore(vibeHome2, warnings) {
  const agentSource = join47(pluginRoot(), "vibe", "agents", "explore.toml");
  const promptSource = join47(pluginRoot(), "vibe", "prompts", "explore.md");
  if (!existsSync50(agentSource) || !existsSync50(promptSource)) {
    warnings.push("explore override sources missing (ships in a later task)");
    return false;
  }
  mkdirSync25(join47(vibeHome2, "agents"), { recursive: true });
  mkdirSync25(join47(vibeHome2, "prompts"), { recursive: true });
  copyFileSync3(agentSource, join47(vibeHome2, "agents", "explore.toml"));
  copyFileSync3(promptSource, join47(vibeHome2, "prompts", "explore.md"));
  return true;
}
var HOOK_NAME, SKILLS_TO_PORT;
var init_init_vibe = __esm({
  "src/commands/init-vibe.ts"() {
    "use strict";
    init_logger();
    HOOK_NAME = "lazybrain-capture";
    SKILLS_TO_PORT = [
      "lazybrain-recall",
      "lazybrain-search",
      "lazybrain-query",
      "lazybrain-summary",
      "lazybrain-time-travel"
    ];
  }
});

// src/commands/init.ts
var init_exports = {};
__export(init_exports, {
  runInit: () => runInit
});
import { existsSync as existsSync51, mkdirSync as mkdirSync26, writeFileSync as writeFileSync37 } from "node:fs";
import { join as join48, resolve as resolve8 } from "node:path";
function ensureDir(dirPath) {
  if (!existsSync51(dirPath)) {
    mkdirSync26(dirPath, { recursive: true });
  }
}
function resolveConfigPaths(brainPath) {
  return {
    canonical: resolve8(join48(brainPath, CONFIG_FILENAME)),
    legacy: resolve8(join48(brainPath, "..", CONFIG_FILENAME))
  };
}
function detectExistingInit(canonical2, legacy) {
  if (existsSync51(canonical2)) return "canonical";
  if (existsSync51(legacy)) return "legacy";
  return null;
}
function resolveBrainTarget(opts) {
  if (opts.path !== void 0 && opts.path !== "") {
    return {
      brainPath: resolve8(opts.path),
      resolvedFrom: "flag"
    };
  }
  if (process.env.LAZYBRAIN_BRAIN_PATH_CLI) {
    return {
      brainPath: resolve8(process.env.LAZYBRAIN_BRAIN_PATH_CLI),
      resolvedFrom: "flag"
    };
  }
  if (process.env.LAZYBRAIN_BRAIN_PATH) {
    return {
      brainPath: resolve8(process.env.LAZYBRAIN_BRAIN_PATH),
      resolvedFrom: "env"
    };
  }
  return {
    brainPath: resolve8(process.cwd(), ".lazybrain", "brain"),
    resolvedFrom: "cwd"
  };
}
async function runInit(opts) {
  const log = getLogger();
  const { brainPath, resolvedFrom } = resolveBrainTarget(opts);
  const notesPath = join48(brainPath, "notes");
  const knowledgeNodesPath = join48(brainPath, "knowledge-nodes");
  const cachePath3 = join48(brainPath, "_cache");
  const metaPath = join48(brainPath, "meta");
  const { canonical: canonicalConfigPath, legacy: legacyConfigPath } = resolveConfigPaths(brainPath);
  const existingKind = detectExistingInit(canonicalConfigPath, legacyConfigPath);
  if (existingKind !== null && !opts.force) {
    if (existingKind === "legacy") {
      log.info(
        { brainPath, legacyConfigPath },
        "lazybrain init: legacy config found in parent dir \u2014 brain is initialized. Re-run with --force or move to canonical location."
      );
    }
    throw new Error(`LazyBrain already initialized at ${brainPath}. Use --force to overwrite.`);
  }
  ensureDir(brainPath);
  ensureDir(notesPath);
  ensureDir(knowledgeNodesPath);
  ensureDir(cachePath3);
  ensureDir(metaPath);
  const config = {
    version: "1.0.0",
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  writeFileSync37(canonicalConfigPath, JSON.stringify(config, null, 2), "utf8");
  const fromLabel = resolvedFrom === "flag" ? " (from --brain)" : resolvedFrom === "env" ? " (from LAZYBRAIN_BRAIN_PATH)" : "";
  log.info(
    { brainPath, resolvedFrom, force: !!opts.force },
    `lazybrain init complete \u2014 brain at ${brainPath}${fromLabel}`
  );
  process.stdout.write(`Initialized brain at ${brainPath}${fromLabel}
`);
  return {
    brainPath,
    created: existingKind === null,
    notes: notesPath,
    cache: cachePath3,
    knowledgeNodes: knowledgeNodesPath,
    configWritten: true,
    resolvedFrom
  };
}
var CONFIG_FILENAME;
var init_init = __esm({
  "src/commands/init.ts"() {
    "use strict";
    init_logger();
    CONFIG_FILENAME = ".lazybrain-config.json";
  }
});

// src/commands/wipe.ts
var wipe_exports = {};
__export(wipe_exports, {
  runWipe: () => runWipe
});
import {
  existsSync as existsSync52,
  mkdirSync as mkdirSync27,
  readdirSync as readdirSync11,
  rmSync as rmSync4,
  statSync as statSync14,
  unlinkSync as unlinkSync6,
  writeFileSync as writeFileSync38
} from "node:fs";
import { join as join49 } from "node:path";
async function isDaemonRunning() {
  const port = readDaemonPort();
  const pid = readDaemonPid();
  if (!port || !pid) return false;
  if (!isProcessAlive(pid)) return false;
  return await pingDaemon(port, 500);
}
function buildDryRunSummary(cfg) {
  const notes = notesDir();
  let noteCount = 0;
  if (existsSync52(notes)) {
    for (const partition of readdirSync11(notes)) {
      const partPath = join49(notes, partition);
      try {
        noteCount += readdirSync11(partPath).filter((f) => f.endsWith(".html")).length;
      } catch {
      }
    }
  }
  const dirs = [batchesDir(), metaDir(), join49(brainRoot(), "clusters"), cfg.cachePath].filter(
    (d) => existsSync52(d)
  );
  return `Would delete: ${noteCount} notes, ${dirs.length} dirs (batches, meta, clusters, cache), cache at ${cfg.cachePath}.
Re-run with --yes to confirm.`;
}
function deleteWithRetry(filePath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (statSync14(filePath).isDirectory()) {
        rmSync4(filePath, { recursive: true, force: true });
      } else {
        unlinkSync6(filePath);
      }
      return true;
    } catch (err) {
      const code = err.code;
      const isLocked = code === "EBUSY" || code === "EPERM";
      if (!isLocked) throw err;
      if (attempt < 2) {
        const ms = 10 * 5 ** attempt;
        const until = Date.now() + ms;
        while (Date.now() < until) {
        }
      }
    }
  }
  try {
    writeFileSync38(filePath, "");
    return true;
  } catch {
    return false;
  }
}
async function runWipe(opts) {
  const log = getLogger();
  const cfg = getConfig();
  if (await isDaemonRunning()) {
    const msg = "A LazyBrain daemon is running \u2014 stop it first: lazybrain daemon stop";
    log.warn(msg);
    throw new Error(msg);
  }
  if (!opts.yes) {
    const summary = buildDryRunSummary(cfg);
    process.stdout.write(`${summary}
`);
    const exitErr = new Error("Wipe aborted: re-run with --yes to confirm.");
    exitErr.code = "WIPE_NO_CONFIRM";
    throw exitErr;
  }
  const report = {
    notesDeleted: 0,
    knowledgeNodesDeleted: 0,
    artifactsDeleted: 0,
    cacheDeleted: 0,
    errors: []
  };
  const notesPath = notesDir();
  if (existsSync52(notesPath)) {
    const partitions = readdirSync11(notesPath).filter((d) => {
      const full = join49(notesPath, d);
      try {
        return readdirSync11(full).length >= 0;
      } catch {
        return false;
      }
    });
    for (const partition of partitions) {
      const partPath = join49(notesPath, partition);
      try {
        const files = readdirSync11(partPath).filter((f) => f.endsWith(".html"));
        for (const file of files) {
          unlinkSync6(join49(partPath, file));
          report.notesDeleted++;
        }
        try {
          rmSync4(partPath, { recursive: true, force: true });
        } catch {
        }
      } catch (err) {
        report.errors.push(`${partition}: ${err.message}`);
      }
    }
  }
  const knDir = knowledgeNodesDir();
  if (existsSync52(knDir)) {
    try {
      const files = readdirSync11(knDir).filter((f) => f.endsWith(".html"));
      for (const file of files) {
        try {
          unlinkSync6(join49(knDir, file));
          report.knowledgeNodesDeleted++;
        } catch (err) {
          report.errors.push(`knowledge-nodes/${file}: ${err.message}`);
        }
      }
    } catch (err) {
      report.errors.push(`knowledge-nodes: ${err.message}`);
    }
  }
  const batchesPath = batchesDir();
  if (existsSync52(batchesPath)) {
    try {
      rmSync4(batchesPath, { recursive: true, force: true });
      report.artifactsDeleted++;
    } catch (err) {
      report.errors.push(`batches: ${err.message}`);
    }
  }
  const metaPath = metaDir();
  if (existsSync52(metaPath)) {
    try {
      rmSync4(metaPath, { recursive: true, force: true });
      report.artifactsDeleted++;
    } catch (err) {
      report.errors.push(`meta: ${err.message}`);
    }
  }
  const root = brainRoot();
  const clustersPath = join49(root, "clusters");
  if (existsSync52(clustersPath)) {
    try {
      rmSync4(clustersPath, { recursive: true, force: true });
      report.artifactsDeleted++;
    } catch (err) {
      report.errors.push(`clusters: ${err.message}`);
    }
  }
  const brainArtifacts = ["_index.html", "_user-profile.html", "graph.html", "graph.txt"];
  for (const artifact of brainArtifacts) {
    const artifactPath = join49(root, artifact);
    if (existsSync52(artifactPath)) {
      try {
        unlinkSync6(artifactPath);
        report.artifactsDeleted++;
      } catch (err) {
        report.errors.push(`${artifact}: ${err.message}`);
      }
    }
  }
  if (!existsSync52(notesPath)) {
    try {
      mkdirSync27(notesPath, { recursive: true });
    } catch (err) {
      report.errors.push(`notes dir recreate: ${err.message}`);
    }
  }
  closeDb();
  const cacheDir = cfg.cachePath;
  if (existsSync52(cacheDir)) {
    const files = readdirSync11(cacheDir);
    for (const file of files) {
      const filePath = join49(cacheDir, file);
      try {
        const deleted = deleteWithRetry(filePath);
        if (deleted) {
          report.cacheDeleted++;
        } else {
          report.errors.push(`cache/${file}: locked \u2014 could not delete (truncated instead)`);
        }
      } catch (err) {
        report.errors.push(`cache/${file}: ${err.message}`);
      }
    }
  }
  log.info(
    report,
    "wipe complete \u2014 conversation fingerprints reset; the next dream will reprocess all conversations"
  );
  return report;
}
var init_wipe = __esm({
  "src/commands/wipe.ts"() {
    "use strict";
    init_fts();
    init_paths();
    init_paths();
    init_config();
    init_logger();
    init_daemon();
  }
});

// bin/lazybrain.ts
import { readFileSync as readFileSync45 } from "node:fs";
import { dirname as dirname16, join as join50 } from "node:path";
import { fileURLToPath as fileURLToPath6 } from "node:url";
import { Command } from "commander";

// src/cli/register-core.ts
init_capture();
init_compress();
init_extract();
init_inject_context();
init_markers();

// src/commands/invalidate.ts
init_fts();
init_reader();
import { readFileSync as readFileSync23, writeFileSync as writeFileSync18 } from "node:fs";
import { parseHTML as parseHTML9 } from "linkedom";
function runInvalidate(opts) {
  const note = getNoteById(opts.id);
  if (!note) throw new Error(`Note not found: ${opts.id}`);
  const html = readFileSync23(note.path, "utf8");
  const { document } = parseHTML9(`<!doctype html><body>${html}</body>`);
  const root = document.querySelector(`#${cssEscape(opts.id)}`) ?? document.querySelector("article");
  if (!root) throw new Error(`Root element with id="${opts.id}" not found in ${note.path}`);
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  root.setAttribute("data-cerveau-valid-until", today);
  root.setAttribute("data-cerveau-updated", (/* @__PURE__ */ new Date()).toISOString());
  if (opts.replacedBy) {
    root.setAttribute("data-cerveau-invalidated-by", `#${opts.replacedBy}`);
    root.setAttribute("data-cerveau-superseded-by", `#${opts.replacedBy}`);
  }
  if (opts.reason) {
    root.setAttribute("data-cerveau-invalidate-reason", opts.reason);
  }
  const updated = root.outerHTML;
  writeFileSync18(note.path, updated, "utf8");
  indexNote(readNote(note.path));
  const payload = {
    id: opts.id,
    path: note.path,
    valid_until: today,
    invalidated_by: opts.replacedBy ? `#${opts.replacedBy}` : null
  };
  return opts.pretty ? `Invalidated ${opts.id} on ${today}${opts.replacedBy ? ` (replaced by #${opts.replacedBy})` : ""}` : JSON.stringify(payload, null, 2);
}
function cssEscape(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// src/commands/link.ts
init_fts();
init_reader();
import { readFileSync as readFileSync24, writeFileSync as writeFileSync19 } from "node:fs";
import { parseHTML as parseHTML10 } from "linkedom";
var VALID_TYPES = /* @__PURE__ */ new Set([
  "refines",
  "contradicts",
  "generalizes",
  "cites",
  "replaces",
  "follows-from"
]);
function runLink(opts) {
  if (opts.type && !VALID_TYPES.has(opts.type)) {
    throw new Error(
      `Invalid link type "${opts.type}". Expected one of: ${[...VALID_TYPES].join(", ")}`
    );
  }
  const from = getNoteById(opts.fromId);
  const to = getNoteById(opts.toId);
  if (!from) throw new Error(`Source note not found: ${opts.fromId}`);
  if (!to) throw new Error(`Target note not found: ${opts.toId}`);
  const href = `${relativeHref(from.path, to.path)}#${opts.toId}`;
  const html = readFileSync24(from.path, "utf8");
  const { document } = parseHTML10(`<!doctype html><body>${html}</body>`);
  const root = document.querySelector(`#${cssEscape2(opts.fromId)}`) ?? document.querySelector("article");
  if (!root) throw new Error(`Cannot find root element in ${from.path}`);
  let linksSection = root.querySelector("section[data-cerveau-links]");
  if (!linksSection) {
    linksSection = document.createElement("section");
    linksSection.setAttribute("data-cerveau-links", "");
    const heading = document.createElement("h3");
    heading.textContent = "Liens";
    linksSection.appendChild(heading);
    const ul2 = document.createElement("ul");
    linksSection.appendChild(ul2);
    root.appendChild(linksSection);
  }
  const ul = linksSection.querySelector("ul");
  if (!ul) throw new Error("links section malformed");
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.setAttribute("href", href);
  if (opts.type) a.setAttribute("data-cerveau-link-type", opts.type);
  if (opts.strength !== void 0) {
    a.setAttribute("data-cerveau-link-strength", opts.strength.toFixed(2));
  }
  a.textContent = to.title || opts.toId;
  li.appendChild(a);
  ul.appendChild(li);
  writeFileSync19(from.path, root.outerHTML, "utf8");
  indexNote(readNote(from.path));
  const payload = {
    from: opts.fromId,
    to: opts.toId,
    type: opts.type ?? null,
    strength: opts.strength ?? null,
    href
  };
  return opts.pretty ? `Linked ${opts.fromId} \u2014[${opts.type ?? "link"}]\u2192 ${opts.toId}` : JSON.stringify(payload, null, 2);
}
function cssEscape2(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
function relativeHref(fromPath, toPath) {
  const fromParts = fromPath.replace(/\\/g, "/").split("/");
  const toParts = toPath.replace(/\\/g, "/").split("/");
  fromParts.pop();
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.slice(i).map(() => "..");
  const down = toParts.slice(i);
  const rel = [...up, ...down].join("/");
  return rel || `./${toParts[toParts.length - 1]}`;
}

// src/cli/register-core.ts
init_neighbours();
init_profile_update();
init_prune();
init_repair();

// src/commands/query.ts
init_structural();
init_brain_guard();
function runQuery(opts) {
  assertBrainExists();
  const hits = structuralQuery(opts.selector, {
    attribute: opts.attribute,
    limit: opts.limit ?? 50
  });
  if (opts.strip) {
    return hits.map((h) => h.text).join("\n\n");
  }
  if (opts.pretty) {
    if (hits.length === 0) return "0 matches";
    return hits.map((h) => `${h.noteId}${h.attribute ? ` [${h.attribute}]` : ""}
  ${h.text}`).join("\n\n");
  }
  return JSON.stringify({ count: hits.length, hits }, null, 2);
}

// src/commands/recompose.ts
import { readFileSync as readFileSync26 } from "node:fs";

// src/annotator/blocks/composers/recompose.ts
init_file_neuron();
import { parseHTML as parseHTML12 } from "linkedom";
var SECTION_META = [
  { kind: "decision", sectionId: "decisions", heading: "Decisions" },
  { kind: "bug", sectionId: "bugs", heading: "Bugs" },
  { kind: "idea", sectionId: "ideas", heading: "Ideas" },
  { kind: "rule", sectionId: "rules", heading: "Rules" },
  { kind: "qa", sectionId: "qa", heading: "Q & A" },
  { kind: "warning", sectionId: "warnings", heading: "Warnings" },
  { kind: "activity", sectionId: "activity", heading: "Touched in Conversations" }
];
function sortByDateDesc(items) {
  return [...items].sort((a, b) => b.date.localeCompare(a.date));
}
function dedupByItemId(items) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of items) {
    if (item.itemId) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
    }
    out.push(item);
  }
  return out;
}
function buildLi(document, item) {
  const li = document.createElement("li");
  li.setAttribute("data-cerveau-confidence", String(item.confidence));
  li.setAttribute("data-cerveau-date", item.date);
  if (item.superseded) {
    li.setAttribute("data-cerveau-superseded", "true");
    li.setAttribute("data-cerveau-valid-until", item.validUntil ?? "");
  }
  if (item.authorId) li.setAttribute("data-cerveau-author-id", item.authorId);
  if (item.author) li.setAttribute("data-cerveau-author", item.author);
  if (item.kind) li.setAttribute("data-cerveau-kind", item.kind);
  if (item.itemId) li.setAttribute("data-cerveau-item-id", item.itemId);
  if (item.about) li.setAttribute("data-cerveau-about", item.about);
  if (item.project) li.setAttribute("data-cerveau-project", item.project);
  li.textContent = normalizeItemText(item.text);
  if (item.sourceConvLink) {
    const a = document.createElement("a");
    a.setAttribute("href", item.sourceConvLink);
    a.setAttribute("class", "conv-source");
    a.textContent = "[source]";
    li.appendChild(document.createTextNode(" "));
    li.appendChild(a);
  }
  return li;
}
function buildSection(document, meta, items) {
  const section = document.createElement("section");
  section.setAttribute("data-section", meta.sectionId);
  const h3 = document.createElement("h3");
  h3.textContent = meta.heading;
  section.appendChild(h3);
  const ul = document.createElement("ul");
  for (const item of items) {
    ul.appendChild(buildLi(document, item));
  }
  section.appendChild(ul);
  return section;
}
function recomposeFileNeuronEnrichment(existingHtml, items) {
  const { document } = parseHTML12(`<!doctype html><html><body>${existingHtml}</body></html>`);
  const article = document.querySelector('article[data-cerveau-type="file-neuron"]');
  if (!article) return existingHtml;
  const grouped = /* @__PURE__ */ new Map();
  for (const item of items) {
    const list = grouped.get(item.kind) ?? [];
    list.push(item);
    grouped.set(item.kind, list);
  }
  for (const meta of SECTION_META) {
    const raw = grouped.get(meta.kind) ?? [];
    const processed = dedupByItemId(sortByDateDesc(raw));
    const existing = article.querySelector(`section[data-section="${meta.sectionId}"]`);
    if (existing) {
      existing.remove();
    }
    if (processed.length === 0) continue;
    const newSection = buildSection(document, meta, processed);
    const seeAlso = article.querySelector('section[data-section="see-also"]');
    if (seeAlso) {
      article.insertBefore(newSection, seeAlso);
    } else {
      article.appendChild(newSection);
    }
  }
  return article.outerHTML;
}

// src/commands/recompose.ts
init_fts();
init_reader();
init_writer();
init_logger();
async function runRecompose(opts) {
  const log = getLogger();
  const indexed = getNoteById(opts.noteId);
  if (!indexed) {
    throw new Error(`Note not found: ${opts.noteId}`);
  }
  const file = readNote(indexed.path);
  const existingHtml = file.html;
  let itemsRaw;
  if (opts.itemsFile) {
    itemsRaw = readFileSync26(opts.itemsFile, "utf8");
  } else {
    itemsRaw = await readStdin2();
  }
  const items = JSON.parse(itemsRaw);
  if (!Array.isArray(items)) {
    throw new Error("Items payload must be a JSON array");
  }
  const patched = recomposeFileNeuronEnrichment(existingHtml, items);
  const written = writeNote(patched, { overwrite: true });
  try {
    indexNote(readNote(written.path));
  } catch (err) {
    log.warn(
      { path: written.path, err: err.message },
      "recompose: reindex failed"
    );
  }
  return JSON.stringify({ noteId: written.id, itemsApplied: items.length, path: written.path });
}
function readStdin2() {
  return new Promise((resolve9) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      resolve9(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

// src/commands/recompose-all.ts
init_fts();
init_reader();
init_writer();
init_logger();
var TAG_KIND_PRIORITY = ["bug", "warning", "idea", "rule", "qa", "activity"];
function deriveAuthoredKind(html) {
  const explicit = html.match(/data-cerveau-kind\s*=\s*["']([^"']+)["']/i)?.[1];
  if (explicit) return explicit;
  const type = html.match(/data-cerveau-type\s*=\s*["']([^"']+)["']/i)?.[1];
  if (type === "decision") return "decision";
  const tagsAttr = html.match(/data-cerveau-tags\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
  const tagWords = new Set(tagsAttr.toLowerCase().split(/\s+/).filter(Boolean));
  for (const candidate of TAG_KIND_PRIORITY) {
    if (tagWords.has(candidate)) return candidate;
  }
  return void 0;
}
function extractAuthoredItem(html, noteId) {
  const authorId = html.match(/data-cerveau-author-id\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!authorId) return null;
  const about = html.match(/data-cerveau-about\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!about) return null;
  const kind = deriveAuthoredKind(html);
  if (!kind) return null;
  const author = html.match(/data-cerveau-author\s*=\s*["']([^"']+)["']/i)?.[1];
  const project = html.match(/data-cerveau-project\s*=\s*["']([^"']+)["']/i)?.[1];
  const orgId = html.match(/data-cerveau-org-id\s*=\s*["']([^"']+)["']/i)?.[1];
  const created = html.match(/data-cerveau-created\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
  const date = created.slice(0, 10) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const factMatch = html.match(/<p\s+data-cerveau-fact[^>]*>([\s\S]*?)<\/p>/i);
  const rawText = factMatch ? factMatch[1].replace(/<[^>]+>/g, "").trim() : "";
  if (!rawText) return null;
  const confidenceMatch = html.match(/data-cerveau-confidence\s*=\s*["']([\d.]+)["']/i);
  const confidence = confidenceMatch ? Number.parseFloat(confidenceMatch[1]) : 1;
  return {
    text: rawText,
    confidence,
    date,
    sourceConvLink: `#${noteId}`,
    kind,
    about,
    project,
    authorId,
    author,
    itemId: noteId,
    orgId
  };
}
function filePathFromAbout(about) {
  const match = about.match(/^file:(.+)$/i);
  if (!match) return null;
  return match[1].replace(/\\/g, "/").replace(/^\.\//, "");
}
async function runRecomposeAll() {
  const log = getLogger();
  const report = {
    fileNeuronsRecomposed: 0,
    authoredItemsFound: 0,
    skipped: false,
    errors: []
  };
  let allNotes;
  try {
    allNotes = readAllNotes();
  } catch (err) {
    report.errors.push(err.message);
    return report;
  }
  const authoredItemsByPath = /* @__PURE__ */ new Map();
  for (const note of allNotes) {
    if (!note.html.includes("data-cerveau-author-id")) continue;
    if (note.html.includes('data-cerveau-type="file-neuron"')) continue;
    if (note.html.includes('data-cerveau-type="concept"')) continue;
    const item = extractAuthoredItem(note.html, note.id);
    if (!item) continue;
    const filePath = filePathFromAbout(item.about ?? "");
    if (!filePath) continue;
    const list = authoredItemsByPath.get(filePath) ?? [];
    list.push(item);
    authoredItemsByPath.set(filePath, list);
    report.authoredItemsFound += 1;
  }
  if (report.authoredItemsFound === 0) {
    report.skipped = true;
    return report;
  }
  for (const note of allNotes) {
    if (!note.html.includes('data-cerveau-type="file-neuron"')) continue;
    const fileMatch = note.html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
    if (!fileMatch) continue;
    const neuronFilePath = fileMatch[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const items = authoredItemsByPath.get(neuronFilePath);
    if (!items || items.length === 0) continue;
    try {
      const file = readNote(note.path);
      const patched = recomposeFileNeuronEnrichment(file.html, items);
      if (patched === file.html) continue;
      const written = writeNote(patched, { overwrite: true });
      try {
        indexNote(readNote(written.path));
      } catch (err) {
        log.warn(
          { path: written.path, err: err.message },
          "recompose-all: reindex failed"
        );
      }
      report.fileNeuronsRecomposed += 1;
    } catch (err) {
      const msg = err.message;
      report.errors.push(`${neuronFilePath}: ${msg}`);
      log.warn({ filePath: neuronFilePath, err: msg }, "recompose-all: file-neuron patch failed");
    }
  }
  log.debug(
    {
      authoredItemsFound: report.authoredItemsFound,
      fileNeuronsRecomposed: report.fileNeuronsRecomposed,
      errors: report.errors.length
    },
    "recompose-all: done"
  );
  return report;
}

// src/cli/register-core.ts
init_search();

// src/commands/stats.ts
init_fts();
init_config();
import { existsSync as existsSync25, readFileSync as readFileSync27, statSync as statSync8 } from "node:fs";
import { join as join27 } from "node:path";
function runStats(opts) {
  const cfg = getConfig();
  const db = getDb();
  const allActive = listAll({ includeExpired: false });
  const allInc = listAll({ includeExpired: true });
  const totals = {
    notes_total: allInc.length,
    notes_active: allActive.length,
    notes_invalidated: allInc.length - allActive.length
  };
  const byType = db.prepare(
    `SELECT COALESCE(type, 'unknown') AS type, COUNT(*) AS n
       FROM notes WHERE valid_until IS NULL OR valid_until = ''
       GROUP BY type ORDER BY n DESC`
  ).all();
  const telemetryPath = join27(cfg.cachePath, "telemetry.jsonl");
  const window = opts.windowHours ?? 24;
  const events = readRecentEvents(telemetryPath, window);
  const queries = events.filter((e) => e.event === "query");
  const captures = events.filter((e) => e.event === "capture");
  const injects = events.filter((e) => e.event === "inject");
  const levelDist = { L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const q of queries) levelDist[q.level] = (levelDist[q.level] ?? 0) + 1;
  const totalQueries = queries.length || 1;
  const latencyP50 = byLevel(queries);
  const l1RoutingRate = levelDist.L1 / totalQueries * 100;
  const avgInjectTokens = injects.length === 0 ? 0 : injects.reduce((s, e) => s + (e.tokens ?? 0), 0) / injects.length;
  const stats = {
    window_hours: window,
    totals,
    by_type: byType,
    queries_total: queries.length,
    routing_distribution_pct: Object.fromEntries(
      Object.entries(levelDist).map(([k, v]) => [k, (v / totalQueries * 100).toFixed(1)])
    ),
    l1_routing_rate_pct: l1RoutingRate.toFixed(1),
    latency_p50_ms_by_level: latencyP50,
    captures_count: captures.length,
    avg_inject_tokens: Math.round(avgInjectTokens)
  };
  if (opts.pretty) {
    return formatPretty2(stats);
  }
  return JSON.stringify(stats, null, 2);
}
function readRecentEvents(path, windowHours) {
  if (!existsSync25(path)) return [];
  const stat = statSync8(path);
  if (stat.size === 0) return [];
  const raw = readFileSync27(path, "utf8");
  const cutoff = Date.now() - windowHours * 3600 * 1e3;
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (!e.ts) continue;
      if (new Date(e.ts).getTime() >= cutoff)
        out.push(e);
    } catch {
    }
  }
  return out;
}
function byLevel(queries) {
  const groups = {};
  for (const q of queries) {
    groups[q.level] ??= [];
    groups[q.level].push(q.latency_ms);
  }
  const out = {};
  for (const [level, arr] of Object.entries(groups)) {
    arr.sort((a, b) => a - b);
    out[level] = arr[Math.floor(arr.length / 2)] ?? 0;
  }
  return out;
}
function formatPretty2(s) {
  return [
    `LazyBrain stats (window ${s.window_hours}h)`,
    "\u2500".repeat(50),
    `Notes:           ${s.totals.notes_active} active / ${s.totals.notes_total} total`,
    `Queries:         ${s.queries_total}`,
    `Captures:        ${s.captures_count}`,
    `L1 routing rate: ${s.l1_routing_rate_pct}%`,
    `Avg inject:     ${s.avg_inject_tokens} tokens`,
    "",
    "Routing distribution (% of queries):",
    ...Object.entries(s.routing_distribution_pct).map(
      ([k, v]) => `  ${k}: ${v}%`
    ),
    "",
    "Latency p50 by level (ms):",
    ...Object.entries(s.latency_p50_ms_by_level).map(
      ([k, v]) => `  ${k}: ${v}ms`
    )
  ].join("\n");
}

// src/commands/store.ts
init_wikilinks();
init_contradictions();
init_fts();
init_reader();
init_writer();
init_logger();
init_enrich();
import { readFileSync as readFileSync28 } from "node:fs";
async function runStore(opts) {
  const log = getLogger();
  let html = opts.html;
  if (!html && opts.fromFile) {
    html = readFileSync28(opts.fromFile, "utf8");
  }
  if (!html) {
    html = await readStdin3();
  }
  if (!html.trim()) {
    throw new Error("Empty HTML input");
  }
  try {
    const indexedNotes = listAll({ includeExpired: false });
    if (indexedNotes.length > 0) {
      const ctx = buildWikilinkContext(
        indexedNotes.map((n) => ({
          id: n.id,
          concepts: n.concepts ?? null,
          entities: n.entities ?? null,
          tags: n.tags ?? ""
        }))
      );
      if (ctx.knownNoteIds.size >= 2) {
        html = injectWikilinks(html, ctx);
        log.debug({ noteCount: ctx.knownNoteIds.size }, "wikilinks injected during store");
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, "wikilinks injection failed, continuing without it");
  }
  const result = writeNote(html, {
    overwrite: opts.overwrite,
    upsertIfRicher: opts.upsertIfRicher
  });
  const note = readNote(result.path);
  indexNote(note);
  if (isConvEligibleNoteHtml(html)) {
    try {
      const hits = detectContradictions(note.html, result.id);
      if (hits.length > 0) {
        annotateContradictions(result.path, hits);
        backannotateConflictTargets(hits);
        indexNote(readNote(result.path));
        log.debug({ note: result.id, conflicts: hits.length }, "store: contradiction(s) flagged");
      }
    } catch (err) {
      log.warn({ err: err.message }, "store: contradiction detection failed (non-fatal)");
    }
    await runIncrementalEnrich();
    try {
      await runRecomposeAll();
    } catch (err) {
      log.warn({ err: err.message }, "store: recompose-all failed (non-fatal)");
    }
  }
  if (opts.pretty) {
    return `Stored: ${result.id}
  path: ${result.path}
  size: ${result.sizeBytes}B
  attrs: ${result.attrsCount}`;
  }
  return JSON.stringify(result, null, 2);
}
function readStdin3() {
  return new Promise((resolve9) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      const raw = Buffer.concat(chunks);
      resolve9(decodeBufferAsUtf8(raw));
    });
  });
}
function decodeBufferAsUtf8(buf) {
  if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) {
    return buf.slice(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 254 && buf[1] === 255) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length - 1; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
    return buf.slice(3).toString("utf8");
  }
  return buf.toString("utf8");
}

// src/cli/register-core.ts
function handle(err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}
`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === "debug" && err instanceof Error) {
    process.stderr.write(`${err.stack}
`);
  }
  const code = msg.includes("Schema validation") ? 4 : msg.includes("not found") ? 5 : 1;
  process.exit(code);
}
function registerCore(program2) {
  program2.command("search <query>").description("Adaptive retrieval (router L1-L4). Default mode is auto.").option("-t, --top <n>", "top K results", (v) => Number.parseInt(v, 10), 5).option("-m, --mode <mode>", "l1|l2|l3|l4|auto", "auto").option("--strip", "output stripped text only (for LLM injection)").option("--pretty", "human-readable output").option("--diversity <lambda>", "MMR lambda [0..1]", Number.parseFloat).option("--include-expired", "include invalidated notes").option("--type <type>", "filter by data-cerveau-type").option("--tag <tag>", "filter by tag").option("--cwd <path>", "bias PageRank toward notes captured in this working directory").option("--page-rank-weight <w>", "blend factor for PageRank in [0..1]", Number.parseFloat).action(async (query, opts) => {
    try {
      const out = await runSearch({ query, ...opts });
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("query <selector>").description("CSS selector query (L1, deterministic, < 5ms).").option("-a, --attribute <name>", "extract a specific attribute").option("-l, --limit <n>", "limit results", (v) => Number.parseInt(v, 10), 50).option("--strip", "output stripped text only").option("--pretty", "human-readable output").action((selector, opts) => {
    try {
      process.stdout.write(`${runQuery({ selector, ...opts })}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("store").description("Store a new HTML note. Reads from stdin or --from-file.").option("--from-file <path>").option("--from-stdin", "read HTML from stdin (default)").option("--overwrite").option(
    "--upsert-if-richer",
    "if a note with the same id exists, replace it only when the new body is richer (preserves created, refreshes updated)"
  ).option("--pretty").action(async (opts) => {
    try {
      const out = await runStore(opts);
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("link <fromId> <toId>").description("Create a bidirectional link with optional type and strength.").option("-t, --type <type>", "refines|contradicts|generalizes|cites|replaces|follows-from").option("-s, --strength <value>", "link strength 0..1", Number.parseFloat).option("--pretty").action((fromId, toId, opts) => {
    try {
      process.stdout.write(`${runLink({ fromId, toId, ...opts })}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("recompose <noteId>").description("Patch enrichment sections of a file-neuron from a JSON items list (no code rescan).").option("--items-file <path>", "read items JSON from file (default: stdin)").option("--items-stdin", "read items JSON from stdin").action(async (noteId, opts) => {
    try {
      const out = await runRecompose({ noteId, ...opts });
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("recompose-all").description("Patch authored items into every file-neuron that has them (no code rescan).").action(async () => {
    try {
      const report = await runRecomposeAll();
      process.stdout.write(`${JSON.stringify(report)}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("invalidate <id>").description("Mark a note as invalidated (sets data-cerveau-valid-until).").option("--replaced-by <id>").option("--reason <text>").option("--pretty").action((id, opts) => {
    try {
      process.stdout.write(`${runInvalidate({ id, ...opts })}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("capture").description("Capture a session transcript into the brain.").option("--from-file <path>").option("--from-stdin").option("--session <id>").option("--cwd <path>").option("--async", "queue without processing (PostToolUse)").option("--flush-sync", "flush queued captures synchronously (PreCompact)").option("--use-llm", "use LLM augmentation when heuristic confidence is low").option("--pretty").action(async (opts) => {
    try {
      const out = await runCapture(opts);
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("compress").description("Consolidate working-tier notes into a <memory-batch>.").option("--session <id>").option(
    "--older-than-days <n>",
    "compress notes older than N days",
    (v) => Number.parseInt(v, 10),
    7
  ).option("--dry-run").option("--purge-noise", "retroactively invalidate notes that fail the capture validator").option(
    "--purge-source <prefix>",
    'hard-delete notes whose data-cerveau-source starts with prefix (e.g. "bench:locomo")'
  ).option("--pretty").action((opts) => {
    try {
      process.stdout.write(`${runCompress(opts)}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("neighbours").description("1-hop graph neighbours for a note id (supersession, triples, shared entities).").argument("<id>", "note id (with or without leading #)").option("--pretty").action((id, opts) => {
    try {
      process.stdout.write(`${runNeighbours({ id, ...opts })}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("extract").description(
    "Batch LLM extraction (Haiku) for low-quality notes. Opt-in via LAZYBRAIN_EXTRACTOR=haiku."
  ).option("--batch-size <n>", "max notes per call", (v) => Number.parseInt(v, 10), 10).option("--dry-run").option("--pretty").action(async (opts) => {
    try {
      const out = await runExtract(opts);
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("inject-context").description("Generate stripped context for SessionStart / UserPromptSubmit injection.").option("--max-tokens <n>", "token budget", (v) => Number.parseInt(v, 10), 3e3).option("--prefer-recent").option("--prefer-important").option("--mode <mode>", "session | turn | marker | highlights", "session").option("--format <fmt>", "full (default) or compact (headline+index)", "full").option("--query <q>", "query (required when --mode=turn)").option("--min-score <n>", "relevance threshold for turn mode", (v) => Number.parseFloat(v)).option("--cwd <path>", "working directory hint").option(
    "--session-id <id>",
    "Q3 differential injection: skip notes already shown to this session (turn mode)"
  ).option(
    "--nudge <style>",
    "skill|tool|none \u2014 how to tell the model to search memory further (default: skill)"
  ).option("--pretty").action(async (opts) => {
    try {
      const out = await runInjectContext({ ...opts, nudge: parseNudgeStyle(opts.nudge) });
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("stats").description("Show live telemetry stats.").option("--window-hours <n>", "window size in hours", (v) => Number.parseInt(v, 10), 24).option("--pretty").action((opts) => {
    try {
      process.stdout.write(`${runStats(opts)}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("profile-update").description("Rebuild the auto-generated user profile note from recent activity.").option(
    "--min-occurrences <n>",
    "min note count for a tag to be considered stable",
    (v) => Number.parseInt(v, 10),
    3
  ).option("--force").option("--pretty").action((opts) => {
    try {
      process.stdout.write(`${runProfileUpdate(opts)}
`);
    } catch (err) {
      handle(err);
    }
  });
  program2.command("prune").description(
    "Remove noise notes and backup directories from the brain. Dry-run by default \u2014 use --apply to actually delete."
  ).option(
    "--policy <policies>",
    "comma-separated list of policies: claude-mem-observer,session-dream,empty-tldr,backup-dirs (default: all)"
  ).option("--dry-run", "preview candidates without deleting (default)").option("--apply", "actually delete the matched files and directories").option("--pretty", "human-readable output").action((opts) => {
    try {
      const dryRun = !opts.apply;
      const report = runPrune({ policy: opts.policy, dryRun });
      if (opts.pretty) {
        printPruneReport(report);
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
      }
    } catch (err) {
      handle(err);
    }
  });
  program2.command("repair").description(
    "Targeted, tag-scoped undo for notes damaged by a known bug (see engine/src/commands/repair.ts). Applies immediately unless --dry-run is passed."
  ).option(
    "--un-invalidate-noise",
    "remove dream-noise-cleanup invalidation stamps from notes carrying --tags"
  ).option(
    "--tags <tags>",
    "comma-separated tags to scope the repair (default: mission,agent,skill)"
  ).option("--dry-run", "preview candidates without modifying anything").option("--pretty", "human-readable output").action((opts) => {
    try {
      if (!opts.unInvalidateNoise) {
        throw new Error("repair: specify an action, e.g. --un-invalidate-noise");
      }
      const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : void 0;
      const report = runRepairUnInvalidateNoise({ tags, dryRun: Boolean(opts.dryRun) });
      if (opts.pretty) {
        printRepairReport(report);
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
      }
    } catch (err) {
      handle(err);
    }
  });
}
function printRepairReport(report) {
  const w = (s) => process.stdout.write(s);
  w("\n");
  w("  Repair report\n");
  w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  w(`  Action:            ${report.action}
`);
  w(`  Mode:              ${report.dryRun ? "dry-run (nothing modified)" : "APPLIED"}
`);
  w(`  Tags:              ${report.tags.join(", ")}
`);
  w(`  Candidates:        ${report.candidates.length}
`);
  if (!report.dryRun) {
    w(`  Repaired:          ${report.repaired}
`);
  }
  w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  if (report.candidates.length > 0) {
    w(report.dryRun ? "\n  Candidates (dry-run \u2014 nothing modified):\n" : "\n  Repaired:\n");
    for (const c of report.candidates.slice(0, 50)) {
      w(`    ${c.id} [${c.tags.join(",")}]
`);
    }
    if (report.candidates.length > 50) {
      w(`    ... and ${report.candidates.length - 50} more
`);
    }
  }
  w("\n");
}
function printPruneReport(report) {
  const w = (s) => process.stdout.write(s);
  w("\n");
  w("  Prune report\n");
  w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  w(
    `  Mode:              ${report.dryRun ? "dry-run (no files deleted)" : "APPLY (files deleted)"}
`
  );
  w(`  Policies:          ${report.policies.join(", ")}
`);
  w("\n  Candidates by policy:\n");
  for (const policy of report.policies) {
    w(`    ${policy.padEnd(24)} ${report.counts[policy]}
`);
  }
  w("\n");
  w(`  Total file candidates: ${report.totalFiles}
`);
  w(`  Total dir candidates:  ${report.totalDirs}
`);
  if (!report.dryRun) {
    w(`  Deleted:               ${report.deleted}
`);
  }
  w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
  if (report.candidates.length > 0 && report.dryRun) {
    w("\n  Candidates (dry-run \u2014 nothing deleted):\n");
    for (const c of report.candidates.slice(0, 50)) {
      w(`    [${c.policy}] ${c.path}
`);
      w(`      Reason: ${c.reason}
`);
    }
    if (report.candidates.length > 50) {
      w(`    ... and ${report.candidates.length - 50} more
`);
    }
    w("\n  Run with --apply to delete these files.\n");
  }
  w("\n");
}

// src/cli/register-pipeline.ts
init_build_clusters();
init_build_index();
init_dream();
init_graph();

// src/commands/health-detail.ts
init_backlinks();
init_fts();
var HEALTH_DETAIL_LIMIT = 200;
function noteTitle(n) {
  return (n.title ?? "").trim() || n.id;
}
function computeOrphans(notes) {
  const backlinks = loadBacklinks();
  const hasInbound = new Set(Object.keys(backlinks?.incoming ?? {}));
  const hasOutbound = new Set(Object.keys(backlinks?.outgoing ?? {}));
  return notes.filter((n) => !hasInbound.has(n.id) && !hasOutbound.has(n.id)).map((n) => ({ id: n.id, title: noteTitle(n) }));
}
function computeBrokenLinks(notes) {
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const backlinks = loadBacklinks();
  const out = [];
  for (const [fromId, edges] of Object.entries(backlinks?.outgoing ?? {})) {
    for (const edge of edges) {
      if (!noteById.has(edge.to)) {
        out.push({
          fromId,
          fromTitle: noteTitle(noteById.get(fromId) ?? { id: fromId }),
          toId: edge.to
        });
      }
    }
  }
  return out;
}
function computeDuplicateGroups(notes) {
  const byTitle = /* @__PURE__ */ new Map();
  for (const n of notes) {
    const title = (n.title ?? "").trim();
    if (title.length < 5) continue;
    const key = title.toLowerCase();
    const group = byTitle.get(key) ?? [];
    group.push(n);
    byTitle.set(key, group);
  }
  const groups = [];
  for (const group of byTitle.values()) {
    if (group.length > 1) {
      groups.push({ title: noteTitle(group[0]), noteIds: group.map((n) => n.id) });
    }
  }
  return groups;
}
function computeHealthDetail(category) {
  const notes = listAll({ includeExpired: false });
  if (category === "orphans") {
    const items = computeOrphans(notes);
    return {
      category,
      total: items.length,
      shown: Math.min(items.length, HEALTH_DETAIL_LIMIT),
      truncated: items.length > HEALTH_DETAIL_LIMIT,
      orphans: items.slice(0, HEALTH_DETAIL_LIMIT)
    };
  }
  if (category === "brokenLinks") {
    const items = computeBrokenLinks(notes);
    return {
      category,
      total: items.length,
      shown: Math.min(items.length, HEALTH_DETAIL_LIMIT),
      truncated: items.length > HEALTH_DETAIL_LIMIT,
      brokenLinks: items.slice(0, HEALTH_DETAIL_LIMIT)
    };
  }
  const groups = computeDuplicateGroups(notes);
  const total = groups.reduce((sum, g) => sum + (g.noteIds.length - 1), 0);
  const shownGroups = groups.slice(0, HEALTH_DETAIL_LIMIT);
  return {
    category,
    total,
    shown: shownGroups.reduce((sum, g) => sum + (g.noteIds.length - 1), 0),
    truncated: groups.length > HEALTH_DETAIL_LIMIT,
    duplicates: shownGroups
  };
}

// src/commands/health-score.ts
init_backlinks();
init_pagerank();
init_fts();
init_logger();
import { existsSync as existsSync30, readFileSync as readFileSync33, writeFileSync as writeFileSync25 } from "node:fs";
import { join as join34 } from "node:path";
var DAY_MS3 = 864e5;
var STALE_DAYS = 90;
var STALE_PAGERANK_THRESHOLD = 0.01;
function daysSince(isoDate) {
  if (!isoDate) return 0;
  const t = Date.parse(isoDate);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / DAY_MS3);
}
function writeHealthMeta(brainPath, result) {
  const indexPath2 = join34(brainPath, "_index.html");
  if (!existsSync30(indexPath2)) return;
  try {
    let html = readFileSync33(indexPath2, "utf8");
    const escapedContent = JSON.stringify(result).replace(/"/g, "&quot;");
    const metaTag = `<meta name="cerveau-health" content="${escapedContent}">`;
    if (/name="cerveau-health"/.test(html)) {
      html = html.replace(/<meta name="cerveau-health"[^>]*>/, metaTag);
    } else {
      html = html.replace("</head>", `  ${metaTag}
</head>`);
    }
    writeFileSync25(indexPath2, html, "utf8");
  } catch (err) {
    getLogger().warn(
      { err: err.message },
      "computeHealthScore: could not write health meta to _index.html"
    );
  }
}
async function computeHealthScore(brainPath) {
  const log = getLogger();
  const notes = listAll({ includeExpired: false });
  const totalNotes = notes.length;
  if (totalNotes === 0) {
    const result2 = {
      score: 100,
      orphans: 0,
      brokenLinks: 0,
      stale: 0,
      dupes: 0,
      totalNotes: 0,
      totalLinks: 0
    };
    writeHealthMeta(brainPath, result2);
    return result2;
  }
  const noteIds = new Set(notes.map((n) => n.id));
  const backlinks = loadBacklinks();
  const pr = computePageRank({ cacheKey: "global" });
  const prScores = pr.scores;
  const hasInbound = new Set(Object.keys(backlinks?.incoming ?? {}));
  const hasOutbound = new Set(Object.keys(backlinks?.outgoing ?? {}));
  let orphans = 0;
  for (const note of notes) {
    if (!hasInbound.has(note.id) && !hasOutbound.has(note.id)) {
      orphans += 1;
    }
  }
  let brokenLinks = 0;
  for (const edges of Object.values(backlinks?.outgoing ?? {})) {
    for (const edge of edges) {
      if (!noteIds.has(edge.to)) {
        brokenLinks += 1;
      }
    }
  }
  let stale = 0;
  for (const note of notes) {
    const days = daysSince(note.created);
    const prScore = prScores[note.id] ?? 0;
    if (prScore < STALE_PAGERANK_THRESHOLD && days > STALE_DAYS) {
      stale += 1;
    }
  }
  const titleCount = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const title = (note.title ?? "").trim().toLowerCase();
    if (title.length < 5) continue;
    titleCount.set(title, (titleCount.get(title) ?? 0) + 1);
  }
  let dupes = 0;
  for (const count of titleCount.values()) {
    if (count > 1) dupes += count - 1;
  }
  const orphanRate = orphans / totalNotes;
  const totalEdges = Object.values(backlinks?.outgoing ?? {}).reduce(
    (sum, edges) => sum + edges.length,
    0
  );
  const brokenRate = totalEdges > 0 ? brokenLinks / totalEdges : 0;
  const staleRate = stale / totalNotes;
  const dupeRate = dupes / totalNotes;
  const orphanPenalty = Math.min(25, Math.round(orphanRate * 80));
  const brokenPenalty = Math.min(25, Math.round(brokenRate * 200));
  const stalePenalty = Math.min(25, Math.round(staleRate * 60));
  const dupePenalty = Math.min(25, Math.round(dupeRate * 200));
  const score = Math.max(0, 100 - orphanPenalty - brokenPenalty - stalePenalty - dupePenalty);
  const result = {
    score,
    orphans,
    brokenLinks,
    stale,
    dupes,
    totalNotes,
    totalLinks: totalEdges
  };
  writeHealthMeta(brainPath, result);
  log.info(
    { score, orphans, brokenLinks, stale, dupes, totalNotes, totalLinks: totalEdges },
    "computeHealthScore: done"
  );
  return result;
}

// src/commands/import.ts
init_heuristic();
init_llm();
import { existsSync as existsSync35, mkdirSync as mkdirSync17, readFileSync as readFileSync37, writeFileSync as writeFileSync26 } from "node:fs";
import { dirname as dirname10, join as join37 } from "node:path";

// src/importers/adapter-claude-export.ts
import { createHash as createHash6 } from "node:crypto";
import { existsSync as existsSync31, readFileSync as readFileSync34 } from "node:fs";

// src/importers/scrub.ts
var SCRUB_PATTERNS = [
  {
    label: "sk- API key",
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: "[API_KEY]"
  },
  {
    label: "Google API key",
    pattern: /AIza[0-9A-Za-z\-_]{30,}/g,
    replacement: "[GOOGLE_KEY]"
  },
  {
    label: "GitHub PAT",
    pattern: /ghp_[A-Za-z0-9]{30,}/g,
    replacement: "[GITHUB_TOKEN]"
  },
  {
    label: "PEM private key block",
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: "[PRIVATE_KEY]"
  },
  {
    label: "Slack token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: "[SLACK_TOKEN]"
  },
  {
    label: "AWS access key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "[AWS_KEY]"
  },
  {
    label: "JWT token",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "[JWT]"
  },
  {
    label: "npm token",
    pattern: /npm_[A-Za-z0-9]{36}/g,
    replacement: "[NPM_TOKEN]"
  },
  {
    label: "Supabase key",
    pattern: /sbp_[A-Za-z0-9]{40,}/g,
    replacement: "[SUPABASE_KEY]"
  },
  {
    label: "Bearer token",
    pattern: /[Bb]earer\s+[A-Za-z0-9\-_.+/=]{20,}/g,
    replacement: "Bearer [TOKEN]"
  }
];
function scrubText(text) {
  let result = text;
  for (const { pattern, replacement } of SCRUB_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// src/importers/adapter-claude-export.ts
var ClaudeExportAdapter = class {
  source = "claude-export";
  inputPath;
  constructor(inputPath) {
    this.inputPath = inputPath;
  }
  isAvailable() {
    return existsSync31(this.inputPath);
  }
  list(since) {
    if (!existsSync31(this.inputPath)) return [];
    const sinceMs = since ? new Date(since).getTime() : 0;
    let rawData;
    try {
      rawData = JSON.parse(readFileSync34(this.inputPath, "utf-8"));
    } catch {
      return [];
    }
    const conversations = normalizeTopLevel(rawData);
    const results = [];
    for (const conv of conversations) {
      const updatedMs = conv.updated_at ? new Date(conv.updated_at).getTime() : conv.created_at ? new Date(conv.created_at).getTime() : 0;
      if (updatedMs > 0 && updatedMs < sinceMs) continue;
      const text = extractConversationText(conv);
      if (!text || text.length < 30) continue;
      const scrubbed = scrubText(text);
      const contentHash2 = createHash6("sha256").update(scrubbed).digest("hex");
      const timestamp = conv.updated_at ?? conv.created_at ?? (/* @__PURE__ */ new Date()).toISOString();
      const title = (conv.name ?? "Claude conversation").slice(0, 80);
      results.push({
        contentHash: contentHash2,
        title,
        text: scrubbed.slice(0, 4e3),
        timestamp,
        source: "import:claude-export",
        topic: "import/claude"
      });
    }
    return results;
  }
};
function normalizeTopLevel(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw;
    if (Array.isArray(obj.conversations)) return obj.conversations;
  }
  return [];
}
function extractConversationText(conv) {
  const messages = conv.chat_messages ?? [];
  const texts = [];
  for (const msg of messages) {
    if (msg.sender !== "human" && msg.sender !== "assistant") continue;
    const text = extractMessageText(msg);
    if (text && text.length > 10) {
      texts.push(text.slice(0, 600));
    }
  }
  return texts.join("\n\n").slice(0, 4e3);
}
function extractMessageText(msg) {
  if (typeof msg.text === "string" && msg.text.length > 0) return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(" ").trim();
  }
  return "";
}

// src/importers/adapter-chatgpt-export.ts
import { createHash as createHash7 } from "node:crypto";
import { existsSync as existsSync32, readFileSync as readFileSync35 } from "node:fs";
var ChatGptExportAdapter = class {
  source = "chatgpt-export";
  inputPath;
  constructor(inputPath) {
    this.inputPath = inputPath;
  }
  isAvailable() {
    return existsSync32(this.inputPath);
  }
  list(since) {
    if (!existsSync32(this.inputPath)) return [];
    const sinceMs = since ? new Date(since).getTime() : 0;
    let rawData;
    try {
      rawData = JSON.parse(readFileSync35(this.inputPath, "utf-8"));
    } catch {
      return [];
    }
    const conversations = normalizeTopLevel2(rawData);
    const results = [];
    for (const conv of conversations) {
      const updatedMs = (conv.update_time ?? conv.create_time ?? 0) * 1e3;
      if (updatedMs > 0 && updatedMs < sinceMs) continue;
      const text = extractConversationText2(conv);
      if (!text || text.length < 30) continue;
      const scrubbed = scrubText(text);
      const contentHash2 = createHash7("sha256").update(scrubbed).digest("hex");
      const timestamp = updatedMs > 0 ? new Date(updatedMs).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
      const title = (conv.title ?? "ChatGPT conversation").slice(0, 80);
      results.push({
        contentHash: contentHash2,
        title,
        text: scrubbed.slice(0, 4e3),
        timestamp,
        source: "import:chatgpt-export",
        topic: "import/chatgpt"
      });
    }
    return results;
  }
};
function normalizeTopLevel2(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw;
    if (Array.isArray(obj.conversations)) return obj.conversations;
  }
  return [];
}
function extractConversationText2(conv) {
  const mapping = conv.mapping;
  if (!mapping) return conv.title ?? "";
  const nodes = Object.values(mapping);
  const root = nodes.find((n) => !n.parent || !mapping[n.parent]);
  if (!root) return conv.title ?? "";
  const texts = [];
  walkNode(root.id, mapping, texts, 0);
  return texts.join("\n\n").slice(0, 4e3);
}
function walkNode(nodeId, mapping, texts, depth) {
  if (depth > 200) return;
  const node = mapping[nodeId];
  if (!node) return;
  if (node.message) {
    const role = node.message.author?.role;
    if (role === "user" || role === "assistant") {
      const text = extractPartText(node.message.content);
      if (text && text.length > 10) {
        texts.push(text.slice(0, 600));
      }
    }
  }
  const lastChild = node.children[node.children.length - 1];
  if (lastChild) {
    walkNode(lastChild, mapping, texts, depth + 1);
  }
}
function extractPartText(content) {
  if (typeof content.text === "string") return content.text;
  if (!Array.isArray(content.parts)) return "";
  return content.parts.map((p) => typeof p === "string" ? p : "").join(" ").trim();
}

// src/importers/adapter-claude-code.ts
init_claude_code();
import { createHash as createHash8 } from "node:crypto";
import { existsSync as existsSync33, readdirSync as readdirSync8, statSync as statSync11 } from "node:fs";
import { readFileSync as readFileSync36 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join35 } from "node:path";
var ClaudeCodeImportAdapter = class {
  source = "claude-code";
  claudeDir() {
    const profile = process.env.USERPROFILE ?? process.env.HOME ?? homedir4();
    return join35(profile, ".claude", "projects");
  }
  isAvailable() {
    return existsSync33(this.claudeDir());
  }
  list(since) {
    const dir = this.claudeDir();
    if (!existsSync33(dir)) return [];
    const sinceMs = since ? new Date(since).getTime() : 0;
    const results = [];
    for (const proj of readdirSync8(dir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projectRoot = decodeProjectPath(proj.name);
      const projPath = join35(dir, proj.name);
      for (const filePath of findConversationFiles(projPath)) {
        try {
          const stat = statSync11(filePath);
          if (stat.mtimeMs < sinceMs) continue;
          const content = readFileSync36(filePath, "utf-8");
          const { humanTurn, substantiveChars } = scanTranscriptSignal(content);
          if (!humanTurn || substantiveChars < MIN_SUBSTANTIVE_CHARS) continue;
          const chunks = extractConversationChunks(content, projectRoot, 25, 6e3);
          if (chunks.length === 0) continue;
          const baseSessionId = makeConversationSessionId(filePath);
          const timestamp = new Date(stat.mtimeMs).toISOString();
          const topic = deriveTopic(projectRoot);
          const humanTitle = deriveTitle(humanTurn, baseSessionId);
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const text = scrubText(stripHarnessMarkup(chunk.text));
            const contentHash2 = hashContent(text);
            results.push({
              contentHash: contentHash2,
              title: i === 0 ? humanTitle : `${humanTitle} (part ${i + 1})`,
              text,
              timestamp,
              source: `import:claude-code`,
              topic,
              cwd: projectRoot,
              filesModified: chunk.filesModified,
              filesRead: chunk.filesRead
            });
          }
        } catch {
        }
      }
    }
    return results;
  }
};
function hashContent(text) {
  return createHash8("sha256").update(text).digest("hex");
}
var HARNESS_TAGS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "system-reminder",
  "task-notification"
];
var HARNESS_TAG_PATTERNS = HARNESS_TAGS.flatMap((tag) => [
  new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"),
  new RegExp(`</?${tag}[^>]*>`, "gi")
]);
function stripHarnessMarkup(text) {
  let result = text;
  for (const pattern of HARNESS_TAG_PATTERNS) {
    result = result.replace(pattern, " ");
  }
  return result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
var SCAFFOLDING_PROMPT_RE = /^(?:\[system\]\s*)?you are an? autonomous\b/i;
function isScaffoldingPrompt(text) {
  return SCAFFOLDING_PROMPT_RE.test(text.trimStart());
}
var MIN_SUBSTANTIVE_CHARS = 150;
function scanTranscriptSignal(content) {
  const lines = content.split("\n").filter(Boolean);
  let humanTurn = null;
  let substantiveChars = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msgType = obj.type ?? obj.role ?? "";
    const isUser = msgType === "user" || msgType === "human";
    const isAssistant = msgType === "assistant";
    if (!isUser && !isAssistant) continue;
    const message = obj.message;
    const rawText = extractTextFromMessage(message ?? obj);
    if (!rawText) continue;
    const cleaned = scrubText(stripHarnessMarkup(rawText)).trim();
    if (cleaned.length < 10 || isScaffoldingPrompt(cleaned)) continue;
    substantiveChars += cleaned.length;
    if (isUser && humanTurn === null) humanTurn = cleaned;
  }
  return { humanTurn, substantiveChars };
}
function deriveTitle(text, fallback) {
  const first = text.split("\n").find((l) => l.trim().length > 10);
  if (!first) return fallback;
  return first.trim().slice(0, 80);
}
function deriveTopic(projectRoot) {
  if (!projectRoot) return "import/claude-code";
  const parts = projectRoot.replace(/\\/g, "/").split("/").filter(Boolean);
  const lastTwo = parts.slice(-2).join("/");
  return lastTwo ? `import/claude-code/${lastTwo}` : "import/claude-code";
}

// src/importers/adapter-cursor.ts
import { createHash as createHash9 } from "node:crypto";
import { existsSync as existsSync34 } from "node:fs";
import { createRequire as createRequire3 } from "node:module";
import { join as join36 } from "node:path";
var _require = createRequire3(import.meta.url);
function loadSqlite() {
  try {
    return _require("better-sqlite3");
  } catch {
    return null;
  }
}
var CursorImportAdapter = class {
  source = "cursor";
  dbPath() {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    const p = join36(appdata, "Cursor", "User", "globalStorage", "state.vscdb");
    return existsSync34(p) ? p : null;
  }
  isAvailable() {
    return this.dbPath() !== null;
  }
  list(since) {
    const dbPath = this.dbPath();
    if (!dbPath) return [];
    const sinceMs = since ? new Date(since).getTime() : 0;
    const Database2 = loadSqlite();
    if (!Database2) return [];
    let db;
    try {
      db = new Database2(dbPath, { readonly: true });
    } catch {
      return [];
    }
    try {
      return this.readComposers(db, sinceMs);
    } finally {
      db.close();
    }
  }
  readComposers(db, sinceMs) {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
    if (!row) return [];
    const raw = Buffer.isBuffer(row.value) ? row.value.toString("utf8") : String(row.value);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    const composers = data.allComposers ?? [];
    const results = [];
    for (const composer of composers) {
      const updatedAt = composer.lastUpdatedAt ?? composer.createdAt ?? 0;
      if (updatedAt < sinceMs) continue;
      const title = sanitizeTitle(composer.name ?? composer.subtitle ?? composer.composerId);
      const subtitle = composer.subtitle ?? "";
      const text = this.loadComposerText(db, composer.composerId, title, subtitle);
      if (!text || text.length < 30) continue;
      const scrubbed = scrubText(text);
      const contentHash2 = createHash9("sha256").update(scrubbed).digest("hex");
      const timestamp = new Date(updatedAt || Date.now()).toISOString();
      results.push({
        contentHash: contentHash2,
        title: title.slice(0, 80),
        text: scrubbed.slice(0, 4e3),
        timestamp,
        source: "import:cursor",
        topic: "import/cursor"
      });
    }
    return results;
  }
  loadComposerText(db, composerId, title, subtitle) {
    try {
      const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`);
      if (!row?.value) return buildFallback(title, subtitle);
      const raw = Buffer.isBuffer(row.value) ? row.value.toString("utf8") : String(row.value);
      const data = JSON.parse(raw);
      const convMap = data.conversationMap;
      if (convMap && typeof convMap === "object") {
        const texts = extractTextsFromConversationMap(convMap);
        if (texts.length > 0) return texts.join("\n\n").slice(0, 4e3);
      }
      if (typeof data.text === "string" && data.text.length > 10) {
        return data.text.slice(0, 4e3);
      }
    } catch {
    }
    return buildFallback(title, subtitle);
  }
};
function buildFallback(title, subtitle) {
  const parts = [title, subtitle].filter(Boolean);
  return parts.join("\n").trim();
}
function sanitizeTitle(raw) {
  return raw.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 80) || "Cursor conversation";
}
function extractTextsFromConversationMap(convMap) {
  const texts = [];
  for (const conv of Object.values(convMap)) {
    if (!conv || typeof conv !== "object") continue;
    const c = conv;
    const messages = c.conversation;
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg;
      const role = m.role ?? m.type;
      if (role !== "user" && role !== "human" && role !== "assistant") continue;
      const content = extractMessageText2(m);
      if (content && content.length > 20) {
        texts.push(content.slice(0, 600));
      }
    }
  }
  return texts;
}
function extractMessageText2(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (typeof msg.text === "string") return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((b) => typeof b === "object" && b !== null).map((b) => typeof b.text === "string" ? b.text : "").join(" ").trim() || null;
  }
  return null;
}

// src/commands/import.ts
init_writer();
init_config();

// src/util/concurrency.ts
async function mapLimit(items, limit, fn) {
  const boundedLimit = Math.max(1, Math.trunc(limit) || 1);
  const results = [];
  for (let start = 0; start < items.length; start += boundedLimit) {
    const chunk = items.slice(start, start + boundedLimit);
    const chunkResults = await Promise.all(chunk.map((item, offset) => fn(item, start + offset)));
    results.push(...chunkResults);
  }
  return results;
}
function resolveConcurrencyEnv(rawValue, fallback, min, max) {
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, base));
}

// src/commands/import.ts
init_tokenize();
var IMPORT_CONCURRENCY_DEFAULT = 5;
var IMPORT_CONCURRENCY_MIN = 1;
var IMPORT_CONCURRENCY_MAX = 12;
function resolveImportConcurrency() {
  return resolveConcurrencyEnv(
    process.env.LAZYBRAIN_IMPORT_CONCURRENCY,
    IMPORT_CONCURRENCY_DEFAULT,
    IMPORT_CONCURRENCY_MIN,
    IMPORT_CONCURRENCY_MAX
  );
}
function dedupStorePath() {
  try {
    return join37(getConfig().cachePath, ".import-hashes.json");
  } catch {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
    return join37(home, ".lazybrain", ".import-hashes.json");
  }
}
function loadDedupHashes() {
  const path = dedupStorePath();
  if (!existsSync35(path)) return /* @__PURE__ */ new Set();
  try {
    const raw = JSON.parse(readFileSync37(path, "utf-8"));
    if (Array.isArray(raw)) return new Set(raw);
  } catch {
  }
  return /* @__PURE__ */ new Set();
}
function saveDedupHashes(hashes) {
  try {
    const path = dedupStorePath();
    mkdirSync17(dirname10(path), { recursive: true });
    writeFileSync26(path, JSON.stringify([...hashes]), "utf-8");
  } catch {
  }
}
function buildAdapter(source, input) {
  switch (source) {
    case "claude-code":
      return new ClaudeCodeImportAdapter();
    case "cursor":
      return new CursorImportAdapter();
    case "chatgpt-export":
      if (!input) throw new Error("--input <path> is required for chatgpt-export");
      return new ChatGptExportAdapter(input);
    case "claude-export":
      if (!input) throw new Error("--input <path> is required for claude-export");
      return new ClaudeExportAdapter(input);
    default:
      throw new Error(
        `Unknown source "${source}". Use: claude-code|cursor|chatgpt-export|claude-export|auto`
      );
  }
}
function buildAutoAdapters(input) {
  const adapters = [new ClaudeCodeImportAdapter(), new CursorImportAdapter()];
  if (input && existsSync35(input)) {
    const peek = safeReadStart(input, 200);
    if (peek.includes("chat_messages")) {
      adapters.push(new ClaudeExportAdapter(input));
    } else if (peek.includes('"mapping"') || peek.includes('"gizmo_id"')) {
      adapters.push(new ChatGptExportAdapter(input));
    } else {
      adapters.push(new ChatGptExportAdapter(input));
      adapters.push(new ClaudeExportAdapter(input));
    }
  }
  return adapters;
}
function safeReadStart(filePath, chars) {
  try {
    return readFileSync37(filePath, "utf-8").slice(0, chars);
  } catch {
    return "";
  }
}
async function conversationToNote(conv, useLlm) {
  try {
    const input = {
      sessionId: `import-${conv.contentHash.slice(0, 8)}`,
      text: conv.text.slice(0, 4e3),
      timestamp: conv.timestamp,
      cwd: conv.cwd,
      filesModified: conv.filesModified,
      filesRead: conv.filesRead,
      agent: conv.source,
      sourceKind: "history"
    };
    const result = useLlm ? await annotateWithLlm(input) : annotateSession(input);
    if (!result.html) return null;
    return result.html.replace(/data-cerveau-source="[^"]*"/, `data-cerveau-source="${esc2(conv.source)}"`).replace(
      /(<article[^>]*)>/,
      `$1 data-cerveau-fingerprint="${conv.contentHash.slice(0, 16)}">`
    );
  } catch {
    return null;
  }
}
function esc2(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
async function runImport(opts) {
  const { source, input, dryRun = false, useLlm = false, since, limit } = opts;
  const adapters = source === "auto" ? buildAutoAdapters(input) : [buildAdapter(source, input)];
  const dedupHashes = loadDedupHashes();
  const newHashes = new Set(dedupHashes);
  const allConvs = [];
  for (const adapter of adapters) {
    if (!adapter.isAvailable()) continue;
    const convs = adapter.list(since);
    allConvs.push(...convs);
  }
  const candidates = limit != null ? allConvs.slice(0, limit) : allConvs;
  const scanned = candidates.length;
  const totalText = candidates.map((c) => c.text).join("");
  const estTokens = estimateTokenCount(totalText);
  let importedCount = 0;
  let skippedCount = 0;
  const sampleTitles = [];
  const backend = !dryRun && useLlm ? resolveExtractorBackend() : void 0;
  const needsWork = [];
  for (const conv of candidates) {
    if (dedupHashes.has(conv.contentHash)) {
      skippedCount++;
      continue;
    }
    if (dryRun) {
      importedCount++;
      if (sampleTitles.length < 5) sampleTitles.push(conv.title);
      continue;
    }
    needsWork.push(conv);
  }
  await mapLimit(needsWork, resolveImportConcurrency(), async (conv) => {
    const html = await conversationToNote(conv, useLlm);
    if (!html) {
      skippedCount++;
      return;
    }
    try {
      writeNote(html, { overwrite: false });
      newHashes.add(conv.contentHash);
      importedCount++;
      if (sampleTitles.length < 5) sampleTitles.push(conv.title);
    } catch (err) {
      const msg = err.message ?? "";
      if (msg.includes("already exists")) {
        newHashes.add(conv.contentHash);
      }
      skippedCount++;
    }
  });
  if (!dryRun) {
    saveDedupHashes(newHashes);
  }
  return {
    source: adapters.map((a) => a.source).join("+"),
    scanned,
    imported: importedCount,
    skipped: skippedCount,
    estItems: scanned,
    estTokens,
    sampleTitles,
    ...backend ? { backend } : {}
  };
}

// src/commands/index-rebuild.ts
init_fts();

// src/commands/index-update.ts
init_fts();
init_reader();
init_fingerprints();
init_logger();
import { existsSync as existsSync36 } from "node:fs";
async function runIncrementalUpdate() {
  const log = getLogger();
  let store = loadFingerprints();
  const allNotes = readAllNotes();
  const allPaths = allNotes.map((n) => n.path);
  const changedPaths = new Set(getChangedFiles(allPaths, store));
  const orphanedPaths = getOrphanedFingerprints(store).filter((p) => !existsSync36(p));
  let indexed = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  for (const orphanPath of orphanedPaths) {
    const noteIds = store.files[orphanPath]?.notesCreated ?? [];
    const idsToDelete = noteIds.length > 0 ? noteIds : [idFromPath(orphanPath)].filter((id) => id !== null);
    for (const id of idsToDelete) {
      try {
        deleteNote(id);
        deleted += 1;
        log.debug({ id, path: orphanPath }, "incremental: deleted orphaned note");
      } catch (err) {
        failed += 1;
        failures.push(`${orphanPath} (delete ${id}): ${err.message}`);
      }
    }
    const { [orphanPath]: _removed, ...remaining } = store.files;
    store = { ...store, files: remaining };
  }
  const indexedNotes = [];
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
      log.debug({ id: note.id, path: note.path }, "incremental: indexed");
    } catch (err) {
      failed += 1;
      failures.push(`${note.path}: ${err.message}`);
    }
  }
  saveFingerprints(store);
  log.info({ indexed, deleted, skipped, failed }, "incremental index update complete");
  await embedNotesForIndex(indexedNotes);
  return { indexed, deleted, skipped, failed, failures };
}
function idFromPath(filePath) {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  const id = base.replace(/\.html$/, "");
  return id || null;
}

// src/commands/index-rebuild.ts
var SQLITE_LOCK_PATTERNS = [
  "SQLITE_BUSY",
  "database is locked",
  "disk I/O error",
  "SQLITE_IOERR"
];
function isLockedDbError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return SQLITE_LOCK_PATTERNS.some((p) => msg.includes(p));
}
async function runIndexRebuild(opts) {
  try {
    if (opts.full) {
      const result2 = await rebuildAll();
      if (opts.pretty) {
        let out = `Full rebuild: ${result2.indexed} notes indexed, ${result2.failed} failed.`;
        if (result2.failures.length > 0) {
          out += `

Failures:
${result2.failures.map((f) => `  - ${f}`).join("\n")}`;
        }
        return out;
      }
      return JSON.stringify(result2, null, 2);
    }
    const result = await runIncrementalUpdate();
    if (opts.pretty) {
      let out = `Incremental update: ${result.indexed} indexed, ${result.deleted} deleted, ${result.skipped} skipped, ${result.failed} failed.`;
      if (result.failures.length > 0) {
        out += `

Failures:
${result.failures.map((f) => `  - ${f}`).join("\n")}`;
      }
      return out;
    }
    return JSON.stringify(result, null, 2);
  } catch (err) {
    if (isLockedDbError(err)) {
      const hint = "The SQLite index is locked by another process.\nA running `lazybrain serve` or daemon is holding the index.\nStop it first:  lazybrain serve --stop\n                lazybrain daemon stop\nThen retry:     lazybrain index-rebuild";
      throw new Error(hint, { cause: err });
    }
    throw err;
  }
}

// src/cli/register-pipeline.ts
init_interlink();

// src/commands/publish.ts
init_fts();
import { existsSync as existsSync38, mkdirSync as mkdirSync19, rmSync as rmSync3, writeFileSync as writeFileSync29 } from "node:fs";
import { join as join39 } from "node:path";

// src/publish/site.ts
init_backlinks();
init_knowledge_graph();
init_fts();
import {
  copyFileSync as copyFileSync2,
  existsSync as existsSync37,
  mkdirSync as mkdirSync18,
  readFileSync as readFileSync38,
  readdirSync as readdirSync9,
  rmSync as rmSync2,
  writeFileSync as writeFileSync28
} from "node:fs";
import { dirname as dirname11, join as join38 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/schema/scrubber.ts
import { parseHTML as parseHTML16 } from "linkedom";
var PUBLIC_SAFE_ATTRS = /* @__PURE__ */ new Set([
  "id",
  "class",
  "href",
  "src",
  "alt",
  "title",
  "lang",
  "dir",
  "datetime",
  "data-cerveau-version",
  "data-cerveau-created",
  "data-cerveau-updated",
  "data-cerveau-type",
  "data-cerveau-tier",
  "data-cerveau-tags",
  "data-cerveau-importance",
  "data-cerveau-source",
  "data-cerveau-valid-from",
  "data-cerveau-valid-until",
  "data-cerveau-fact",
  "data-cerveau-confidence",
  "data-cerveau-kind",
  "data-cerveau-link-type",
  "data-cerveau-link-strength",
  "data-cerveau-link-direction",
  "data-cerveau-link-auto",
  "data-cerveau-batch-size",
  "data-cerveau-batch-period",
  "data-cerveau-compression-ratio",
  // Relations and metadata
  "data-cerveau-entities",
  "data-cerveau-triples",
  "data-cerveau-causes",
  "data-cerveau-replaces",
  "data-cerveau-replaced-by",
  "data-cerveau-supersedes",
  // Extraction metadata
  "data-cerveau-extracted-by",
  "data-cerveau-saliency-kind",
  "data-cerveau-topic",
  "data-cerveau-tool",
  "data-cerveau-cwd",
  "data-cerveau-files-modified",
  "data-cerveau-files-read",
  // Provenance (multi-agent backends, v0.3.0)
  "data-cerveau-agent",
  "data-cerveau-source-kind",
  "data-cerveau-session-parent",
  "data-cerveau-git-commit",
  "data-cerveau-git-branch",
  "data-cerveau-session-id",
  // Access and validity tracking
  "data-cerveau-access-count",
  "data-cerveau-last-accessed",
  "data-cerveau-invalidated-by",
  // Attributes for links in infobox and semantic HTML
  "rel",
  "data-q",
  "data-error",
  "data-section",
  "data-primary",
  "aria-current",
  "aria-expanded",
  "value",
  "min",
  "max",
  "optimum",
  "role",
  "reversed"
]);
var PROVENANCE_ATTRS_STRICT = [
  "data-cerveau-cwd",
  "data-cerveau-files-modified",
  "data-cerveau-files-read",
  "data-cerveau-git-branch",
  "data-cerveau-git-commit",
  "data-cerveau-session-parent",
  "data-cerveau-session-id",
  "data-cerveau-source"
];
var FORBIDDEN_TAGS = /* @__PURE__ */ new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "template",
  "form",
  "input",
  "textarea",
  "button"
]);
var SECRET_PATTERNS2 = [
  // Existing patterns
  { label: "OpenAI/Anthropic key (sk-)", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { label: "Google API key (AIza)", pattern: /AIza[0-9A-Za-z\-_]{30,}/ },
  { label: "GitHub PAT (ghp_)", pattern: /ghp_[A-Za-z0-9]{30,}/ },
  { label: "PEM private key", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { label: "Slack token (xox)", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "Email address", pattern: /[A-Za-z0-9_]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // New patterns
  { label: "AWS access key id (AKIA)", pattern: /AKIA[0-9A-Z]{16}/ },
  {
    label: "JWT token",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
  },
  { label: "npm token (npm_)", pattern: /npm_[A-Za-z0-9]{36}/ },
  { label: "GitLab PAT (glpat-)", pattern: /glpat-[A-Za-z0-9_-]{20}/ },
  { label: "Supabase key (sbp_)", pattern: /sbp_[A-Za-z0-9]{40,}/ },
  {
    label: "Bearer auth header",
    // Matches "Bearer <token>" where token is 20+ non-whitespace chars.
    // Excludes short words like "Bearer true" that appear in prose.
    pattern: /[Bb]earer\s+[A-Za-z0-9\-_.+/=]{20,}/
  },
  {
    label: "Private IPv4 (10.x / 192.168.x / 172.16-31.x)",
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/
  },
  {
    label: "International phone number",
    // Conservative: requires explicit country code prefix (+1..+999) followed by
    // at least two groups of 2+ digits with common separators (space, dash, dot).
    // Requires the match is not preceded by a dot or digit (avoids version strings).
    // Examples matched: +1-555-867-5309, +44 20 1234 5678, +49 30 1234 5678.
    // Examples NOT matched: +1.0.0, 2026-05-26, "version 0.2.0".
    pattern: /(?<![.\d])\+[1-9]\d{0,2}(?:[\s.-]\(?\d{2,4}\)?){2,5}(?!\d)/
  }
];
var PRIVATE_PATH_PATTERN = /(?:[A-Z]:[\\/]|\/Users\/|\/home\/)/i;
function scrubForPublic(html, opts = {}) {
  const removed = [];
  const warnings = [];
  const detectedPatterns = [];
  const strippedProvenanceAttrs = [];
  let pathsScrubbed = 0;
  const profile = opts.profile ?? "default";
  for (const { label, pattern } of SECRET_PATTERNS2) {
    if (pattern.test(html)) {
      detectedPatterns.push(label);
    }
  }
  if (detectedPatterns.length > 0) {
    return {
      cleaned: "",
      removedAttrs: removed,
      warnings,
      detectedPatterns,
      strippedProvenanceAttrs,
      pathsScrubbed,
      blockedReason: `Secret/PII pattern detected: ${detectedPatterns.join("; ")}`
    };
  }
  const { document } = parseHTML16(`<!doctype html><body>${html}</body>`);
  for (const tag of Array.from(document.querySelectorAll([...FORBIDDEN_TAGS].join(",")))) {
    tag.remove();
    warnings.push(`Removed <${tag.tagName.toLowerCase()}>`);
  }
  const strictProvenanceSet = profile === "public-strict" ? new Set(PROVENANCE_ATTRS_STRICT) : null;
  for (const el of Array.from(document.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        removed.push(`${name} (event handler)`);
        continue;
      }
      if (strictProvenanceSet?.has(name)) {
        el.removeAttribute(attr.name);
        strippedProvenanceAttrs.push(name);
        continue;
      }
      if (!PUBLIC_SAFE_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        removed.push(name);
      } else if (name === "data-cerveau-source" || name === "href" || name === "src") {
        const value = attr.value;
        if (PRIVATE_PATH_PATTERN.test(value)) {
          warnings.push(`Private path replaced in ${name}: ${value}`);
          el.setAttribute(attr.name, "[scrubbed]");
          pathsScrubbed += 1;
        }
      }
    }
  }
  const root = document.querySelector("article, section, memory-batch");
  return {
    cleaned: root?.outerHTML ?? document.body.innerHTML,
    removedAttrs: [...new Set(removed)],
    warnings,
    detectedPatterns,
    strippedProvenanceAttrs: [...new Set(strippedProvenanceAttrs)],
    pathsScrubbed
  };
}

// src/server/routes/graph.ts
init_backlinks();
init_global_graph();
init_knowledge_graph();
init_fts();
init_logger();

// src/server/cache.ts
import { createHash as createHash10 } from "node:crypto";
import { gzip } from "node:zlib";
function computeETag(body) {
  const hash = createHash10("sha1").update(body, "utf8").digest("hex").slice(0, 16);
  return `"${hash}"`;
}
function handleConditionalGet(req, res, etag) {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === "*")) {
    res.writeHead(304, { etag });
    res.end();
    return true;
  }
  return false;
}
var COMPRESSION_MIN_BYTES = 512;
function acceptsGzip(req) {
  const ae = req.headers["accept-encoding"] ?? "";
  return ae.includes("gzip");
}
function maybeGzip(body) {
  if (Buffer.byteLength(body, "utf8") < COMPRESSION_MIN_BYTES) {
    return Promise.resolve(null);
  }
  return new Promise((resolve9, reject) => {
    gzip(Buffer.from(body, "utf8"), (err, compressed) => {
      if (err) reject(err);
      else resolve9(compressed);
    });
  });
}
async function sendJsonCached(req, res, status, data, opts = {}) {
  const body = JSON.stringify(data);
  const etag = computeETag(body);
  if (handleConditionalGet(req, res, etag)) return;
  const headers = {
    "content-type": "application/json",
    "cache-control": opts.cacheControl ?? "no-cache, must-revalidate",
    etag
  };
  if (opts.csp) headers["content-security-policy"] = opts.csp;
  if (opts.extra) Object.assign(headers, opts.extra);
  if (acceptsGzip(req)) {
    try {
      const compressed = await maybeGzip(body);
      if (compressed) {
        headers["content-encoding"] = "gzip";
        headers["content-length"] = String(compressed.byteLength);
        res.writeHead(status, headers);
        res.end(compressed);
        return;
      }
    } catch {
    }
  }
  headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
  res.writeHead(status, headers);
  res.end(body);
}
function computeNotesFingerprint(notes) {
  if (notes.length === 0) return "empty";
  let xor = 0;
  let sum = 0;
  for (const n of notes) {
    const m = n.mtime_ms ?? 0;
    xor ^= m;
    sum += m;
  }
  return `${notes.length}:${(xor >>> 0).toString(16)}:${(sum >>> 0).toString(16)}`;
}
var IndexVersionedCache = class {
  entry = null;
  /** Retrieve cached value if fingerprint matches, otherwise return null. */
  get(fingerprint) {
    if (this.entry && this.entry.fingerprint === fingerprint) {
      return this.entry.value;
    }
    return null;
  }
  /** Store a value associated with the given fingerprint. */
  set(fingerprint, value) {
    this.entry = { fingerprint, value };
  }
  /** Manually invalidate the cache. */
  invalidate() {
    this.entry = null;
  }
};

// src/server/security.ts
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8"
};
var CSP_API = "default-src 'self'";
var CSP_UI = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
var CSP_NOTE = "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'";
var CSP_STATIC = "default-src 'self'; script-src 'none'";
function sendJson(res, status, data, csp) {
  const headers = { "content-type": "application/json" };
  if (csp) headers["content-security-policy"] = csp;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}
function sendError(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
function mapDbError(res, err) {
  const code = err != null ? err.code : void 0;
  if (code === "SQLITE_BUSY") {
    res.writeHead(503, {
      "content-type": "application/json",
      "retry-after": "3"
    });
    res.end(JSON.stringify({ error: "Index is being rebuilt \u2014 retry in a few seconds" }));
    return true;
  }
  return false;
}

// src/server/routes/graph.ts
function buildGraphPayload() {
  const allNotes = listAllReadonly({ includeExpired: false });
  const backlinksIdx = loadBacklinks();
  const knowledgeGraph = loadKnowledgeGraph();
  const posMap = /* @__PURE__ */ new Map();
  if (knowledgeGraph) {
    for (const n of knowledgeGraph.nodes) {
      if (n.x !== void 0 && n.y !== void 0) {
        posMap.set(n.id, {
          x: n.x,
          y: n.y,
          degree: n.degree ?? 0,
          cluster: n.cluster
        });
      }
    }
  }
  const nodes = allNotes.map((n) => {
    const pos = posMap.get(n.id);
    return {
      id: n.id,
      title: n.title,
      type: n.type,
      topic: n.topic || null,
      importance: n.importance || 0.5,
      created: n.created ?? null,
      ...pos ? { x: pos.x, y: pos.y, degree: pos.degree, cluster: pos.cluster } : {}
    };
  });
  const edges = [];
  if (knowledgeGraph && knowledgeGraph.edges.length > 0) {
    for (const edge of knowledgeGraph.edges) {
      edges.push({
        from: edge.source,
        to: edge.target,
        type: edge.type,
        auto: edge.confidence !== "extracted"
      });
    }
  } else if (backlinksIdx) {
    for (const outgoingEdges of Object.values(backlinksIdx.outgoing)) {
      for (const edge of outgoingEdges) {
        edges.push({
          from: edge.from,
          to: edge.to,
          type: edge.type,
          auto: edge.auto
        });
      }
    }
  }
  return { nodes, edges };
}
var PARTIAL_POSITIONS_THRESHOLD = 0.6;
function makeLcgPrng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = Math.imul(s, 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
function placeUnpositionedNodes(nodes, clusterCentroids) {
  const byCluster = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    if (n.x === 0 && n.y === 0) {
      const arr = byCluster.get(n.c) ?? [];
      arr.push(n);
      byCluster.set(n.c, arr);
    }
  }
  if (byCluster.size === 0) return;
  const originCentroid = { x: 0, y: 0 };
  const RING_RADIUS = 60;
  const ORIGIN_RING = 80;
  const prng = makeLcgPrng(2870097135);
  for (const [cIdx, unposNodes] of byCluster) {
    const centroid = clusterCentroids.get(cIdx) ?? originCentroid;
    const radius = cIdx === 0 && !clusterCentroids.has(0) ? ORIGIN_RING : RING_RADIUS;
    const count = unposNodes.length;
    for (let i = 0; i < count; i++) {
      const angle = i / Math.max(count, 1) * 2 * Math.PI;
      const jitter = (prng() - 0.5) * radius * 0.4;
      unposNodes[i].x = centroid.x + Math.cos(angle) * (radius + jitter);
      unposNodes[i].y = centroid.y + Math.sin(angle) * (radius + jitter);
    }
  }
}
function computeClusterCentroids(nodes, positionedIds) {
  const sums = /* @__PURE__ */ new Map();
  for (const n of nodes) {
    if (!positionedIds.has(n.id)) continue;
    const entry = sums.get(n.c) ?? { sx: 0, sy: 0, count: 0 };
    entry.sx += n.x;
    entry.sy += n.y;
    entry.count += 1;
    sums.set(n.c, entry);
  }
  const centroids = /* @__PURE__ */ new Map();
  for (const [cIdx, { sx, sy, count }] of sums) {
    if (count > 0) {
      centroids.set(cIdx, { x: sx / count, y: sy / count });
    }
  }
  return centroids;
}
function buildSlimLayoutFromPersistedGraph(graph, liveNoteCount) {
  const log = getLogger();
  if (liveNoteCount !== void 0 && liveNoteCount > graph.stats.nodes * 1.2 && graph.stats.nodes > 0) {
    log.debug(
      { liveNoteCount, graphNodeCount: graph.stats.nodes },
      "Brain has grown significantly since last graph run \u2014 consider re-running: lazybrain graph"
    );
  }
  const clusterToIdx = /* @__PURE__ */ new Map();
  const clusters = [];
  const getClusterIdx = (label) => {
    if (clusterToIdx.has(label)) return clusterToIdx.get(label);
    const idx = clusters.length;
    clusters.push(label);
    clusterToIdx.set(label, idx);
    return idx;
  };
  const nodeClusterLabel = (n) => {
    if (n.topic && n.topic !== "unknown") return n.topic.split("/")[0].toLowerCase();
    return "_default";
  };
  const HUB_COUNT_SLIM2 = 20;
  const sortedByDegree = [...graph.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  const hubIds = new Set(sortedByDegree.slice(0, HUB_COUNT_SLIM2).map((n) => n.id));
  const positionedIds = /* @__PURE__ */ new Set();
  const slimNodes = [];
  const nodeIdToIdx = /* @__PURE__ */ new Map();
  for (const n of graph.nodes) {
    const idx = slimNodes.length;
    nodeIdToIdx.set(n.id, idx);
    const clusterLabel = nodeClusterLabel(n);
    const cIdx = getClusterIdx(clusterLabel);
    const hasCoords = typeof n.x === "number" && typeof n.y === "number";
    if (hasCoords) positionedIds.add(n.id);
    const sn = {
      id: n.id,
      x: hasCoords ? n.x : 0,
      y: hasCoords ? n.y : 0,
      c: cIdx,
      d: n.degree ?? 0,
      t: n.type === "file-neuron" ? "f" : n.type === "aggregate-neuron" ? "a" : n.type === "concept" ? "c" : "n"
    };
    if (hubIds.has(n.id)) {
      sn.l = n.title.slice(0, 22);
    }
    slimNodes.push(sn);
  }
  const positionedCount = positionedIds.size;
  const totalCount = slimNodes.length;
  const positionedFraction = totalCount > 0 ? positionedCount / totalCount : 0;
  const hasPositions = positionedFraction >= PARTIAL_POSITIONS_THRESHOLD;
  if (hasPositions && positionedCount < totalCount) {
    const centroids = computeClusterCentroids(slimNodes, positionedIds);
    placeUnpositionedNodes(slimNodes, centroids);
  }
  const slimEdges = [];
  for (const e of graph.edges) {
    const si = nodeIdToIdx.get(e.source);
    const ti = nodeIdToIdx.get(e.target);
    if (si !== void 0 && ti !== void 0) {
      slimEdges.push([si, ti]);
    }
  }
  return {
    nodes: slimNodes,
    edges: slimEdges,
    clusters,
    hasPositions,
    generatedAt: graph.generated,
    nodeCountAtBuild: graph.stats.nodes
  };
}
function bfsSubgraph(payload, rootId, depth) {
  const effectiveDepth = depth < 0 ? 0 : depth;
  const adjacency = /* @__PURE__ */ new Map();
  for (const edge of payload.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, /* @__PURE__ */ new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, /* @__PURE__ */ new Set());
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }
  const visited = /* @__PURE__ */ new Set([rootId]);
  let frontier = /* @__PURE__ */ new Set([rootId]);
  for (let d = 0; d < effectiveDepth; d++) {
    const next = /* @__PURE__ */ new Set();
    for (const nodeId of frontier) {
      for (const neighbour of adjacency.get(nodeId) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          next.add(neighbour);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  const nodes = payload.nodes.filter((n) => visited.has(n.id));
  const edges = payload.edges.filter((e) => visited.has(e.from) && visited.has(e.to));
  return { nodes, edges };
}
function handleGraph(req, res, routeLabel) {
  const log = getLogger();
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rootParam = url.searchParams.get("root");
    const depthParam = url.searchParams.get("depth");
    const payload = buildGraphPayload();
    let result;
    if (rootParam) {
      const depth = depthParam !== null ? Math.max(0, Number.parseInt(depthParam, 10) || 0) : 2;
      result = bfsSubgraph(payload, rootParam, depth);
    } else {
      result = payload;
    }
    sendJsonCached(req, res, 200, result, { csp: CSP_API }).catch((err) => {
      log.error({ err }, `Compression error in ${routeLabel}`);
    });
  } catch (err) {
    log.error({ err }, `API error in ${routeLabel}`);
    sendError(res, 500, "Failed to load graph data");
  }
}
var HUB_COUNT_SLIM = 20;
function buildSlimLayout(payload) {
  const clusterToIdx = /* @__PURE__ */ new Map();
  const clusters = [];
  const getClusterIdx = (label) => {
    if (clusterToIdx.has(label)) return clusterToIdx.get(label);
    const idx = clusters.length;
    clusters.push(label);
    clusterToIdx.set(label, idx);
    return idx;
  };
  const nodeCluster = (n) => {
    if (n.topic) return n.topic.split("/")[0].toLowerCase();
    return "_default";
  };
  const hasPositions = payload.nodes.some((n) => n.x !== void 0 && n.y !== void 0);
  const sortedByDegree = [...payload.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  const hubIds = new Set(sortedByDegree.slice(0, HUB_COUNT_SLIM).map((n) => n.id));
  const nodeIdToIdx = /* @__PURE__ */ new Map();
  const slimNodes = [];
  for (const n of payload.nodes) {
    const idx = slimNodes.length;
    nodeIdToIdx.set(n.id, idx);
    const clusterLabel = nodeCluster(n);
    const cIdx = getClusterIdx(clusterLabel);
    const sn = {
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      c: cIdx,
      d: n.degree ?? 0,
      t: n.type === "file-neuron" ? "f" : n.type === "aggregate-neuron" ? "a" : n.type === "concept" ? "c" : "n"
    };
    if (hubIds.has(n.id)) {
      sn.l = n.title.slice(0, 22);
    }
    slimNodes.push(sn);
  }
  const slimEdges = [];
  for (const e of payload.edges) {
    const si = nodeIdToIdx.get(e.from);
    const ti = nodeIdToIdx.get(e.to);
    if (si !== void 0 && ti !== void 0) {
      slimEdges.push([si, ti]);
    }
  }
  return { nodes: slimNodes, edges: slimEdges, clusters, hasPositions };
}
function handleGraphLayout(req, res) {
  const log = getLogger();
  try {
    const persistedGraph = loadKnowledgeGraph();
    if (persistedGraph) {
      const liveNotes = listAllReadonly({ includeExpired: false });
      const slim = buildSlimLayoutFromPersistedGraph(persistedGraph, liveNotes.length);
      sendJsonCached(req, res, 200, slim, { csp: CSP_API }).catch((err) => {
        log.error({ err }, "Compression error in /_api/graph-layout.json");
      });
    } else {
      const payload = buildGraphPayload();
      const slim = buildSlimLayout(payload);
      sendJsonCached(req, res, 200, slim, { csp: CSP_API }).catch((err) => {
        log.error({ err }, "Compression error in /_api/graph-layout.json (fallback)");
      });
    }
  } catch (err) {
    log.error({ err }, "API error in /_api/graph-layout.json");
    sendError(res, 500, "Failed to build slim graph layout");
  }
}
function handleGlobalGraph(req, res) {
  const log = getLogger();
  try {
    const globalGraph = loadGlobalGraph();
    if (!globalGraph) {
      sendError(res, 404, "Global graph not available. Run: lazybrain graph");
      return;
    }
    sendJsonCached(req, res, 200, globalGraph, { csp: CSP_API }).catch((err) => {
      log.error({ err }, "Compression error in /_api/global-graph");
    });
  } catch (err) {
    log.error({ err }, "API error in /_api/global-graph");
    sendError(res, 500, "Failed to load global graph");
  }
}

// src/publish/site.ts
init_paths();
init_reader();
init_logger();

// src/publish/manifest.ts
import { parseHTML as parseHTML17 } from "linkedom";
function safeSlug(id) {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}
function extractSnippet(html) {
  if (!html) return "";
  try {
    const { document } = parseHTML17(`<!doctype html><body>${html}</body>`);
    const body = document.querySelector("body");
    const text = ((body ?? document.documentElement)?.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.slice(0, 160);
  } catch {
    return html.replace(/<[^>]+>/g, "").slice(0, 160);
  }
}
function noteResourcePaths(id) {
  const s = safeSlug(id);
  return {
    html: `notes/${s}.html`,
    backlinks: `backlinks/${s}.json`,
    neighbors: `neighbors/${s}.json`,
    meta: `meta/${s}.json`
  };
}
function normPath(raw, brainRoot2) {
  return raw.replace(/\\/g, "/").replace(brainRoot2.replace(/\\/g, "/"), "").replace(/^\//, "");
}
function buildManifest(accepted, brainRoot2) {
  return accepted.map(({ indexed, cleaned, paths }) => {
    const snippet = extractSnippet(cleaned);
    return {
      id: indexed.id,
      path: normPath(indexed.path, brainRoot2),
      title: indexed.title,
      type: indexed.type,
      tags: indexed.tags ?? "",
      topic: indexed.topic ?? null,
      created: indexed.created ?? null,
      importance: indexed.importance ?? 0.5,
      snippet,
      html: paths.html,
      backlinks: paths.backlinks,
      neighbors: paths.neighbors,
      meta: paths.meta
    };
  });
}
function buildBacklinksJson(noteId, backlinksIndex, inScopeIds) {
  const incoming = backlinksIndex?.incoming[noteId] ?? [];
  const scoped = inScopeIds ? incoming.filter((b) => inScopeIds.has(b.from)) : incoming;
  return {
    noteId,
    total: scoped.length,
    backlinks: scoped.map((b) => ({
      from: b.from,
      type: b.type,
      surface: b.surface,
      auto: b.auto
    }))
  };
}
function buildNeighborsJson(noteId, backlinksIndex, inScopeIds) {
  const inbound = backlinksIndex?.incoming[noteId] ?? [];
  const outbound = backlinksIndex?.outgoing[noteId] ?? [];
  const scopedInbound = inScopeIds ? inbound.filter((b) => inScopeIds.has(b.from)) : inbound;
  const scopedOutbound = inScopeIds ? outbound.filter((b) => inScopeIds.has(b.to)) : outbound;
  return {
    noteId,
    inbound: {
      count: scopedInbound.length,
      notes: scopedInbound.map((b) => ({ id: b.from, type: b.type }))
    },
    outbound: {
      count: scopedOutbound.length,
      notes: scopedOutbound.map((b) => ({ id: b.to, type: b.type }))
    }
  };
}
function buildMetaJson(indexed, brainRoot2) {
  return {
    id: indexed.id,
    path: normPath(indexed.path, brainRoot2),
    type: indexed.type,
    title: indexed.title,
    topic: indexed.topic ?? null,
    tags: indexed.tags ?? "",
    importance: indexed.importance ?? 0.5,
    created: indexed.created ?? null
  };
}

// src/publish/search-index.ts
import { parseHTML as parseHTML18 } from "linkedom";
function stripToText(html) {
  if (!html) return "";
  try {
    const { document } = parseHTML18(`<!doctype html><body>${html}</body>`);
    const body = document.querySelector("body");
    return ((body ?? document.documentElement)?.textContent ?? "").replace(/\s+/g, " ").trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}
function buildSearchText(indexed, cleanedHtml) {
  const parts = [];
  if (indexed.title) parts.push(indexed.title);
  if (indexed.tags) parts.push(indexed.tags);
  if (indexed.topic) parts.push(indexed.topic.replace(/\//g, " "));
  const bodyText = stripToText(cleanedHtml);
  if (bodyText) parts.push(bodyText);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function buildSearchIndex(accepted) {
  return accepted.map(({ indexed, cleaned }) => ({
    id: indexed.id,
    title: indexed.title,
    type: indexed.type,
    tags: indexed.tags ?? "",
    topic: indexed.topic ?? null,
    created: indexed.created ?? null,
    text: buildSearchText(indexed, cleaned)
  }));
}

// src/publish/sitemap.ts
function buildSitemap(baseUrl, entries) {
  const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const sanitized = baseUrl.replace(/\/$/, "");
  const urls = [
    // Root index
    `  <url>
    <loc>${sanitized}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>`,
    // One URL per note — using fragment routing so crawlers can discover them
    ...entries.map(
      (e) => `  <url>
    <loc>${sanitized}/#/${encodeURIComponent(e.id)}</loc>
    <lastmod>${e.created ? e.created.slice(0, 10) : today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`
    )
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    ""
  ].join("\n");
}
function buildRobotsTxt(baseUrl) {
  const sanitized = baseUrl.replace(/\/$/, "");
  return ["User-agent: *", "Allow: /", "", `Sitemap: ${sanitized}/sitemap.xml`, ""].join("\n");
}

// src/publish/topic-filter.ts
function matchesTopic(topic, prefix) {
  if (!prefix) return true;
  if (!topic) return false;
  return topic.toLowerCase().startsWith(prefix.toLowerCase());
}
var MIN_TEXT_CHARS = 20;
function isEmptyAggregate(note) {
  if (note.type !== "aggregate-neuron") return false;
  const raw = note.cleaned ?? note.html ?? "";
  if (!raw) return true;
  const hasChildren = /<li[^>]*>/.test(raw);
  const textContent = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const isTooShort = textContent.length < MIN_TEXT_CHARS;
  return !hasChildren && isTooShort;
}

// src/publish/site.ts
var STATIC_META_TAG = '<meta name="lazybrain-static" content="true">';
var CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'self'">`;
function brainUiRoot() {
  const base = dirname11(fileURLToPath3(import.meta.url));
  const candidates = [
    join38(base, "..", "..", "examples", "brain-ui"),
    join38(base, "..", "..", "..", "examples", "brain-ui"),
    join38(base, "..", "..", "..", "..", "examples", "brain-ui")
  ];
  for (const candidate of candidates) {
    if (existsSync37(candidate)) return candidate;
  }
  throw new Error(`brain-ui directory not found. Looked in:
${candidates.join("\n")}`);
}
function copyDir(src, dest) {
  mkdirSync18(dest, { recursive: true });
  const entries = readdirSync9(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join38(src, entry.name);
    const destPath = join38(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync2(srcPath, destPath);
    }
  }
}
function injectStaticMeta(html, opts) {
  const ogBlock = [
    CSP_META_TAG,
    STATIC_META_TAG,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeAttr(opts.siteTitle)}">`,
    `<meta property="og:description" content="${escapeAttr(opts.siteDescription)}">`,
    `<meta property="og:url" content="${escapeAttr(opts.baseUrl)}">`,
    `<meta name="generator" content="LazyBrain">`
  ].join("\n  ");
  return html.replace(/(<head[^>]*>)/, `$1
  ${ogBlock}`);
}
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildGraphPayload2(allNotes, inScopeIds) {
  const backlinksIdx = loadBacklinks();
  const knowledgeGraph = loadKnowledgeGraph();
  const posMap = /* @__PURE__ */ new Map();
  if (knowledgeGraph) {
    for (const n of knowledgeGraph.nodes) {
      if (n.x !== void 0 && n.y !== void 0) {
        posMap.set(n.id, {
          x: n.x,
          y: n.y,
          degree: n.degree ?? 0,
          cluster: n.cluster
        });
      }
    }
  }
  const nodes = allNotes.filter((n) => inScopeIds.has(n.id)).map((n) => {
    const pos = posMap.get(n.id);
    return {
      id: n.id,
      title: n.title,
      type: n.type,
      topic: n.topic ?? null,
      importance: n.importance ?? 0.5,
      ...pos ? { x: pos.x, y: pos.y, degree: pos.degree, cluster: pos.cluster } : {}
    };
  });
  const edges = [];
  if (knowledgeGraph && knowledgeGraph.edges.length > 0) {
    for (const edge of knowledgeGraph.edges) {
      if (inScopeIds.has(edge.source) && inScopeIds.has(edge.target)) {
        edges.push({
          from: edge.source,
          to: edge.target,
          type: edge.type,
          auto: edge.confidence !== "extracted"
        });
      }
    }
  } else if (backlinksIdx) {
    for (const outgoingEdges of Object.values(backlinksIdx.outgoing)) {
      for (const edge of outgoingEdges) {
        if (inScopeIds.has(edge.from) && inScopeIds.has(edge.to)) {
          edges.push({
            from: edge.from,
            to: edge.to,
            type: edge.type,
            auto: edge.auto
          });
        }
      }
    }
  }
  return { nodes, edges };
}
function normSeg(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "-");
}
function buildTreePayload(allNotes, inScopeIds) {
  const scopedNotes = allNotes.filter((n) => inScopeIds.has(n.id));
  const aggregates = scopedNotes.filter((n) => n.type === "aggregate-neuron");
  const fileNeurons = scopedNotes.filter((n) => n.type === "file-neuron");
  const projectSlug2 = (note) => normSeg((note.topic ?? "").split("/")[0] ?? "") || note.id;
  const byProject = /* @__PURE__ */ new Map();
  const ensureBucket = (key, label) => {
    if (!byProject.has(key)) {
      byProject.set(key, { label, rootAgg: null, subAggs: [], files: [] });
    }
    return byProject.get(key);
  };
  for (const agg of aggregates) {
    const key = projectSlug2(agg);
    const label = (agg.topic ?? "").split("/")[0] ?? agg.id;
    const bucket = ensureBucket(key, label);
    const depth = (agg.topic ?? "").split("/").filter(Boolean).length;
    if (depth <= 1 && !bucket.rootAgg) {
      bucket.rootAgg = agg;
    } else {
      bucket.subAggs.push(agg);
    }
  }
  for (const file of fileNeurons) {
    const key = projectSlug2(file);
    const label = (file.topic ?? "").split("/")[0] ?? "_unknown";
    ensureBucket(key, label).files.push(file);
  }
  const projects = [...byProject.entries()].filter(([k]) => k !== "" && k !== "_unknown").sort(([a], [b]) => a.localeCompare(b)).map(([, { label, rootAgg, subAggs, files }]) => {
    const children = [
      ...subAggs.map((a) => ({
        id: a.id,
        label: a.title || a.id,
        noteId: a.id,
        type: "aggregate-neuron",
        children: []
      })),
      ...files.map((f) => ({
        id: f.id,
        label: f.title || f.id,
        noteId: f.id,
        type: f.type,
        children: []
      }))
    ].sort((a, b) => a.label.localeCompare(b.label));
    return {
      id: rootAgg?.id ?? label,
      label,
      noteId: rootAgg?.id ?? null,
      type: "project",
      children
    };
  });
  return { projects };
}
function writeJson(filePath, data) {
  mkdirSync18(dirname11(filePath), { recursive: true });
  writeFileSync28(filePath, JSON.stringify(data), "utf8");
}
function scrubNotes(profile, excludeTier, topicPrefix) {
  const notes = readAllNotes();
  const allIndex = listAll({ includeExpired: false });
  const failures = [];
  const accepted = [];
  let totalProvenanceStripped = 0;
  let totalPathsScrubbed = 0;
  const allDetectedPatterns = /* @__PURE__ */ new Set();
  for (const note of notes) {
    if (!note.id) continue;
    if (excludeTier) {
      const indexEntry = allIndex.find((n) => n.id === note.id);
      if (indexEntry) {
        const isArchival = indexEntry.path.includes("batches");
        const shouldExclude2 = excludeTier === "archival" && isArchival || excludeTier === "working" && !isArchival;
        if (shouldExclude2) continue;
      }
    }
    if (topicPrefix) {
      const indexEntry = allIndex.find((n) => n.id === note.id);
      const noteTopic = indexEntry?.topic ?? null;
      if (!noteTopic) continue;
      if (!noteTopic.toLowerCase().startsWith(topicPrefix.toLowerCase())) continue;
    }
    const indexed = allIndex.find((n) => n.id === note.id);
    if (!indexed) continue;
    const result = scrubForPublic(note.html, { profile });
    for (const p of result.detectedPatterns) {
      allDetectedPatterns.add(p);
    }
    if (result.blockedReason) {
      failures.push({ id: note.id, reason: result.blockedReason });
      continue;
    }
    if (isEmptyAggregate({ type: indexed.type, cleaned: result.cleaned })) continue;
    totalProvenanceStripped += result.strippedProvenanceAttrs.length;
    totalPathsScrubbed += result.pathsScrubbed;
    accepted.push({
      indexed,
      cleaned: result.cleaned,
      paths: noteResourcePaths(note.id)
    });
  }
  return {
    failures,
    accepted,
    totalProvenanceStripped,
    totalPathsScrubbed,
    allDetectedPatterns
  };
}
function collectSynthesisData(profile, topicPrefix) {
  const allNotes = readAllNotes();
  let index = null;
  const topics = [];
  for (const note of allNotes) {
    if (/data-cerveau-type="brain-index"/.test(note.html)) {
      if (!topicPrefix) {
        const r = scrubForPublic(note.html, { profile });
        if (!r.blockedReason) index = r.cleaned;
      }
      continue;
    }
    if (/data-cerveau-type="topic-overview"/.test(note.html)) {
      const topicMatch = note.html.match(/data-cerveau-topic="([^"]*)"/);
      if (!topicMatch) continue;
      const noteTopic = topicMatch[1];
      if (!matchesTopic(noteTopic, topicPrefix)) continue;
      const topic = noteTopic.split("/")[0]?.trim() ?? "";
      if (!topic) continue;
      const r = scrubForPublic(note.html, { profile });
      if (!r.blockedReason) topics.push({ topic, html: r.cleaned });
    }
  }
  return { index, topics };
}
function generateSite(opts = {}) {
  const root = brainRoot();
  const target = opts.outDir ?? join38(root, "..", "public-site");
  const profile = opts.profile ?? "public-strict";
  const baseUrl = opts.baseUrl ?? "https://example.github.io/brain";
  const siteTitle = opts.siteTitle ?? "LazyBrain Wiki";
  const siteDescription = opts.siteDescription ?? "Exported knowledge base";
  const isDryRun = opts.dryRun ?? true;
  const { failures, accepted, totalProvenanceStripped, totalPathsScrubbed, allDetectedPatterns } = scrubNotes(profile, opts.excludeTier, opts.topic);
  if (isDryRun) {
    return {
      dryRun: true,
      result: null,
      wouldPublish: accepted.length,
      blockedCount: failures.length
    };
  }
  if (failures.length > 0) {
    return {
      dryRun: false,
      result: {
        outputDir: target,
        notesPublished: 0,
        notesBlocked: failures.length,
        blockedReasons: failures,
        provenanceAttrsStripped: totalProvenanceStripped,
        pathsScrubbed: totalPathsScrubbed,
        sensitivePatternsDetected: [...allDetectedPatterns]
      }
    };
  }
  const backlinksIndex = loadBacklinks();
  const allIndexed = listAll({ includeExpired: false });
  const inScopeIds = new Set(accepted.map((a) => a.indexed.id));
  const manifest = buildManifest(accepted, root);
  const searchIndex = buildSearchIndex(accepted);
  const graph = buildGraphPayload2(allIndexed, inScopeIds);
  const tree = buildTreePayload(allIndexed, inScopeIds);
  const sitemap = buildSitemap(baseUrl, manifest);
  const robots = buildRobotsTxt(baseUrl);
  const synthesis = collectSynthesisData(profile, opts.topic);
  const uiRoot = brainUiRoot();
  const originalIndex = readFileSync38(join38(uiRoot, "index.html"), "utf8");
  const patchedIndex = injectStaticMeta(originalIndex, { siteTitle, siteDescription, baseUrl });
  const scrubReport = {
    notesPublished: accepted.length,
    notesBlocked: failures.length,
    blockedReasons: failures,
    provenanceAttrsStripped: totalProvenanceStripped,
    pathsScrubbed: totalPathsScrubbed,
    sensitivePatternsDetected: [...allDetectedPatterns]
  };
  if (existsSync37(target)) rmSync2(target, { recursive: true, force: true });
  mkdirSync18(target, { recursive: true });
  const uiEntries = readdirSync9(uiRoot, { withFileTypes: true });
  for (const entry of uiEntries) {
    if (entry.name === "index.html") continue;
    const srcPath = join38(uiRoot, entry.name);
    const destPath = join38(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync2(srcPath, destPath);
    }
  }
  writeFileSync28(join38(target, "index.html"), patchedIndex, "utf8");
  const dataDir = join38(target, "data");
  writeJson(join38(dataDir, "notes.json"), manifest);
  writeJson(join38(dataDir, "graph.json"), graph);
  writeJson(join38(dataDir, "graph-layout.json"), buildSlimLayout(graph));
  writeJson(join38(dataDir, "tree.json"), tree);
  writeJson(join38(dataDir, "search-index.json"), searchIndex);
  for (const { indexed, cleaned, paths } of accepted) {
    const htmlPath = join38(dataDir, paths.html);
    mkdirSync18(dirname11(htmlPath), { recursive: true });
    writeFileSync28(htmlPath, cleaned, "utf8");
    writeJson(
      join38(dataDir, paths.backlinks),
      buildBacklinksJson(indexed.id, backlinksIndex, inScopeIds)
    );
    writeJson(
      join38(dataDir, paths.neighbors),
      buildNeighborsJson(indexed.id, backlinksIndex, inScopeIds)
    );
    writeJson(join38(dataDir, paths.meta), buildMetaJson(indexed, root));
  }
  if (synthesis.index !== null) {
    writeFileSync28(join38(dataDir, "synthesis-index.html"), synthesis.index, "utf8");
  }
  for (const { topic, html } of synthesis.topics) {
    const safeTopicName = topic.replace(/[^a-z0-9_-]/gi, "-").slice(0, 60);
    writeFileSync28(join38(dataDir, `synthesis-${safeTopicName}.html`), html, "utf8");
  }
  writeFileSync28(join38(target, "sitemap.xml"), sitemap, "utf8");
  writeFileSync28(join38(target, "robots.txt"), robots, "utf8");
  const scrubReportPath = `${target}.scrub-report.json`;
  writeJson(scrubReportPath, scrubReport);
  getLogger().info(`scrub report written to: ${scrubReportPath}`);
  return {
    dryRun: false,
    result: {
      outputDir: target,
      notesPublished: accepted.length,
      notesBlocked: failures.length,
      blockedReasons: failures,
      provenanceAttrsStripped: totalProvenanceStripped,
      pathsScrubbed: totalPathsScrubbed,
      sensitivePatternsDetected: [...allDetectedPatterns]
    }
  };
}

// src/commands/publish.ts
init_paths();
init_reader();
function runPublish(opts) {
  if (opts.site) {
    return runPublishSite(opts);
  }
  return runPublishRaw(opts);
}
function runPublishSite(opts) {
  const profile = opts.profile ?? "public-strict";
  const isDryRun = opts.dryRun || !opts.confirm;
  const { dryRun, result, wouldPublish, blockedCount } = generateSite({
    outDir: opts.outDir,
    profile,
    excludeTier: opts.excludeTier,
    baseUrl: opts.baseUrl,
    siteTitle: opts.siteTitle,
    dryRun: isDryRun,
    topic: opts.topic
  });
  if (dryRun) {
    return JSON.stringify({
      status: "dry-run",
      mode: "site",
      profile,
      would_publish: wouldPublish,
      blocked: blockedCount
    });
  }
  if (!result) {
    return JSON.stringify({ status: "error", message: "Site generation failed unexpectedly." });
  }
  if (result.notesBlocked > 0) {
    return JSON.stringify({
      status: "blocked",
      mode: "site",
      message: `${result.notesBlocked} note(s) blocked. Fix or exclude them.`,
      failures: result.blockedReasons
    });
  }
  if (opts.pretty) {
    return buildSitePrettyReport(result);
  }
  return JSON.stringify({
    status: "ok",
    mode: "site",
    out_dir: result.outputDir,
    published: result.notesPublished
  });
}
function buildSitePrettyReport(result) {
  const lines = [
    `Site generated: ${result.notesPublished} notes \u2192 ${result.outputDir}`,
    "",
    "SCRUB REPORT",
    `  Notes published          : ${result.notesPublished}`,
    `  Notes blocked            : ${result.notesBlocked}`,
    `  Provenance attrs stripped: ${result.provenanceAttrsStripped}`,
    `  Private paths scrubbed   : ${result.pathsScrubbed}`,
    `  Sensitive patterns found : ${result.sensitivePatternsDetected.length > 0 ? result.sensitivePatternsDetected.join(", ") : "none"}`
  ];
  return lines.join("\n");
}
function runPublishRaw(opts) {
  const target = opts.outDir ?? join39(brainRoot(), "..", "public");
  const profile = opts.profile ?? "public-strict";
  const notes = readAllNotes();
  const allIndex = listAll({ includeExpired: false });
  const failures = [];
  const accepted = [];
  const allDetectedPatterns = /* @__PURE__ */ new Set();
  let totalProvenanceStripped = 0;
  let totalPathsScrubbed = 0;
  for (const note of notes) {
    if (shouldExclude(note, opts, allIndex)) continue;
    if (shouldExcludeByTopic(note, opts.topic, allIndex)) continue;
    const result = scrubForPublic(note.html, { profile });
    for (const p of result.detectedPatterns) {
      allDetectedPatterns.add(p);
    }
    if (result.blockedReason) {
      failures.push({ id: note.id, reason: result.blockedReason });
      continue;
    }
    totalProvenanceStripped += result.strippedProvenanceAttrs.length;
    totalPathsScrubbed += result.pathsScrubbed;
    accepted.push({
      id: note.id,
      path: note.path,
      cleaned: result.cleaned,
      warnings: result.warnings,
      provenanceAttrsStripped: result.strippedProvenanceAttrs.length,
      pathsScrubbed: result.pathsScrubbed
    });
  }
  const report = {
    notesPublished: accepted.length,
    notesBlocked: failures.length,
    blockedReasons: failures,
    provenanceAttrsStripped: totalProvenanceStripped,
    pathsScrubbed: totalPathsScrubbed,
    sensitivePatternsDetected: [...allDetectedPatterns]
  };
  if (failures.length > 0) {
    return JSON.stringify({
      status: "blocked",
      message: `${failures.length} note(s) blocked. Fix or pass --exclude flags.`,
      failures,
      report
    });
  }
  if (opts.dryRun || !opts.confirm) {
    return JSON.stringify({
      status: "dry-run",
      out_dir: target,
      profile,
      would_publish: accepted.length,
      warnings_total: accepted.reduce((s, a) => s + a.warnings.length, 0),
      preview: accepted.slice(0, 3).map((a) => ({ id: a.id, warnings: a.warnings })),
      report
    });
  }
  if (existsSync38(target)) rmSync3(target, { recursive: true, force: true });
  mkdirSync19(target, { recursive: true });
  const indexEntries = [];
  for (const a of accepted) {
    const relPath = resolveRelPath(a.path, a.id);
    const outFile = join39(target, relPath);
    mkdirSync19(join39(outFile, ".."), { recursive: true });
    writeFileSync29(outFile, wrapPage(a.id, a.cleaned), "utf8");
    indexEntries.push(`  <li><a href="${relPath.replace(/\\/g, "/")}">${a.id}</a></li>`);
  }
  const indexHtml = buildIndexHtml(indexEntries);
  writeFileSync29(join39(target, "index.html"), indexHtml, "utf8");
  writeFileSync29(join39(target, "style.css"), defaultCss(), "utf8");
  if (opts.pretty) {
    return buildPrettyReport(accepted.length, target, report);
  }
  return JSON.stringify({ status: "ok", out_dir: target, published: accepted.length, report });
}
function shouldExclude(note, opts, allIndex) {
  if (!opts.excludeTier) return false;
  const indexEntry = allIndex.find((n) => n.id === note.id);
  if (!indexEntry) return false;
  const isArchival = indexEntry.path.includes("batches");
  const isWorking = !isArchival;
  return opts.excludeTier === "archival" && isArchival || opts.excludeTier === "working" && isWorking;
}
function shouldExcludeByTopic(note, topicPrefix, allIndex) {
  if (!topicPrefix) return false;
  const indexEntry = allIndex.find((n) => n.id === note.id);
  const noteTopic = indexEntry?.topic ?? null;
  if (!noteTopic) return true;
  return !noteTopic.toLowerCase().startsWith(topicPrefix.toLowerCase());
}
function resolveRelPath(notePath2, id) {
  if (notePath2.startsWith(notesDir())) {
    return notePath2.slice(notesDir().length + 1);
  }
  if (notePath2.startsWith(batchesDir())) {
    return join39("batches", notePath2.slice(batchesDir().length + 1));
  }
  return `${id}.html`;
}
function buildPrettyReport(published, target, report) {
  const lines = [
    `Published ${published} notes to ${target}`,
    "",
    "SCRUB REPORT",
    `  Notes published          : ${report.notesPublished}`,
    `  Notes blocked            : ${report.notesBlocked}`,
    `  Provenance attrs stripped: ${report.provenanceAttrsStripped}`,
    `  Private paths scrubbed   : ${report.pathsScrubbed}`,
    `  Sensitive patterns found : ${report.sensitivePatternsDetected.length > 0 ? report.sensitivePatternsDetected.join(", ") : "none"}`
  ];
  if (report.blockedReasons.length > 0) {
    lines.push("  Blocked notes:");
    for (const b of report.blockedReasons) {
      lines.push(`    - ${b.id}: ${b.reason}`);
    }
  }
  return lines.join("\n");
}
function wrapPage(id, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${id}</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self';">
  <link rel="stylesheet" href="../style.css">
</head>
<body>
${body}
</body>
</html>`;
}
function buildIndexHtml(indexEntries) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Brain \u2014 public index</title>
  <meta name="generator" content="LazyBrain">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self';">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Brain \u2014 index</h1>
  <ul>
${indexEntries.join("\n")}
  </ul>
</body>
</html>`;
}
function defaultCss() {
  return `body { max-width: 760px; margin: 2em auto; padding: 0 1em; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #222; background: #fafafa; }
h1, h2, h3 { line-height: 1.2; }
a { color: #036; }
[data-cerveau-fact] { padding-left: 1em; border-left: 3px solid #ccc; }
[data-cerveau-fact][data-cerveau-confidence="1.00"] { border-color: #2a2; }
memory-batch { display: block; background: #fff; border: 1px solid #ddd; padding: 1em; }
`;
}

// src/commands/reindex-missing.ts
init_fts();
init_reader();
init_logger();
import { existsSync as existsSync39 } from "node:fs";
var DEFAULT_BATCH_SIZE = 200;
function readIndexedRows() {
  const db = getDb();
  return db.prepare("SELECT id, path FROM notes").all();
}
function classifyMissingPaths(missingPaths, indexedRowsBefore, log) {
  const indexedPathById = new Map(indexedRowsBefore.map((r) => [r.id, r.path]));
  const readFailures = [];
  const byId = /* @__PURE__ */ new Map();
  for (const path of missingPaths) {
    let note;
    try {
      note = readNote(path);
    } catch (err) {
      const msg = err.message;
      readFailures.push(`${path}: ${msg}`);
      log.warn({ path, err: msg }, "reindex --missing: failed to read for classification");
      continue;
    }
    if (!note.id) {
      readFailures.push(`${path}: no <article id> found \u2014 cannot classify`);
      continue;
    }
    const bucket = byId.get(note.id);
    if (bucket) bucket.push(note);
    else byId.set(note.id, [note]);
  }
  const toIndex = [];
  const superseded = [];
  for (const [id, files] of byId) {
    const existingPath = indexedPathById.get(id);
    if (existingPath) {
      for (const f of files) superseded.push({ id, path: f.path, supersededByPath: existingPath });
      continue;
    }
    const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
    const [winner, ...losers] = sorted;
    toIndex.push(winner);
    for (const loser of losers) {
      superseded.push({ id, path: loser.path, supersededByPath: winner.path });
    }
  }
  return { toIndex, superseded, readFailures, allMissingIds: new Set(byId.keys()) };
}
function indexBatch(notes, log) {
  const indexed = [];
  const failures = [];
  for (const note of notes) {
    try {
      const result = indexNote(note);
      indexed.push(result);
    } catch (err) {
      const msg = err.message;
      failures.push(`${note.path}: ${msg}`);
      log.warn({ path: note.path, err: msg }, "reindex --missing: failed to index");
    }
  }
  return { indexed, failed: failures.length, failures };
}
async function reconcileIndex(opts = {}) {
  const log = getLogger();
  const start = Date.now();
  const dryRun = opts.dryRun !== false;
  const deleteGhosts = opts.deleteGhosts === true;
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH_SIZE;
  const diskPaths = listAllNotePaths();
  const indexedRowsBefore = readIndexedRows();
  const indexedPathSet = new Set(indexedRowsBefore.map((r) => r.path));
  const missingPaths = diskPaths.filter((p) => !indexedPathSet.has(p));
  const { toIndex, superseded, readFailures, allMissingIds } = classifyMissingPaths(
    missingPaths,
    indexedRowsBefore,
    log
  );
  const embeddingsMissingBefore = Math.max(
    indexedRowsBefore.length - loadAllStoredEmbeddings().size,
    0
  );
  let indexed = 0;
  let failed = readFailures.length;
  const failures = [...readFailures];
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
        "reindex --missing: progress"
      );
    }
  }
  const storedEmbeddingIds = loadAllStoredEmbeddings();
  let embeddingsBackfilled = 0;
  if (!dryRun) {
    const candidates = listAllWithText({ includeExpired: true }).filter(
      (n) => !storedEmbeddingIds.has(n.id)
    );
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      await embedNotesForIndex(batch);
      embeddingsBackfilled += batch.length;
      log.info(
        { done: Math.min(i + batchSize, candidates.length), total: candidates.length },
        "reindex --missing: embedding backfill progress"
      );
    }
  }
  const ghostRows = indexedRowsBefore.filter((r) => !existsSync39(r.path));
  let ghostRowsDeleted = 0;
  if (!dryRun && deleteGhosts) {
    for (const row of ghostRows) {
      try {
        deleteNote(row.id);
        ghostRowsDeleted += 1;
      } catch (err) {
        log.warn({ id: row.id, err: err.message }, "reindex --missing: ghost delete failed");
      }
    }
  }
  const indexedIdsAfter = new Set(readIndexedRows().map((r) => r.id));
  const ghostIds = new Set(ghostRows.map((r) => r.id));
  const distinctDiskIds = /* @__PURE__ */ new Set([
    ...allMissingIds,
    ...indexedRowsBefore.filter((r) => !ghostIds.has(r.id)).map((r) => r.id)
  ]);
  const remainingUnindexedAfter = [...distinctDiskIds].filter(
    (id) => !indexedIdsAfter.has(id)
  ).length;
  const indexedNotesAfter = indexedIdsAfter.size;
  const expectedRowsAfter = indexedRowsBefore.length + indexed - ghostRowsDeleted;
  const reconciled = indexedNotesAfter === expectedRowsAfter;
  const reconciliationNote = reconciled ? null : `rows_before(${indexedRowsBefore.length}) + indexed(${indexed}) - ghost_rows_deleted(${ghostRowsDeleted}) = ${expectedRowsAfter}, but rows_after = ${indexedNotesAfter} (diff ${indexedNotesAfter - expectedRowsAfter}). This means the run touched the notes table in a way its own counters did not account for \u2014 investigate before trusting this run.`;
  const report = {
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
    duration_ms: Date.now() - start
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
      reconciled: report.reconciled
    },
    "reindex --missing: reconciliation complete"
  );
  return report;
}
async function runReindex(opts) {
  if (!opts.missing) {
    throw new Error("reindex: specify an action, e.g. --missing");
  }
  const report = await reconcileIndex({
    dryRun: opts.dryRun,
    deleteGhosts: opts.deleteGhosts,
    batchSize: opts.batchSize
  });
  return opts.pretty ? formatReport(report) : JSON.stringify(report, null, 2);
}
function formatReport(report) {
  const w = [];
  w.push("");
  w.push("  Reindex --missing report");
  w.push("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  w.push(`  Mode:                    ${report.dryRun ? "dry-run (nothing written)" : "APPLIED"}`);
  w.push(`  Disk notes:              ${report.disk_notes}`);
  w.push(`  Indexed before:          ${report.indexed_notes_before}`);
  w.push(`  Missing on disk:         ${report.missing_on_disk}`);
  w.push(`    of which genuinely missing: ${report.genuinely_missing}`);
  w.push(
    `    of which superseded (stale duplicate, already indexed under a newer path): ${report.superseded_on_disk}`
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
    w.push(`  Ghost rows deleted:      ${report.ghost_rows_deleted}${report.ghost_rows_deleted === 0 && report.ghost_rows > 0 ? " (pass --delete-ghosts to remove)" : ""}`);
  }
  w.push(`  Indexed rows after:      ${report.indexed_notes_after}`);
  w.push(
    `  Remaining unindexed:     ${report.remaining_unindexed_after}${report.remaining_unindexed_after > 0 ? " (re-diffed post-run \u2014 see failures below)" : ""}`
  );
  w.push(
    `  Reconciled:              ${report.reconciled ? "yes" : "NO \u2014 " + report.reconciliation_note}`
  );
  w.push(`  Duration:                ${report.duration_ms}ms`);
  w.push("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  if (report.failures.length > 0) {
    w.push("");
    w.push("  Failures:");
    for (const f of report.failures.slice(0, 20)) w.push(`    - ${f}`);
    if (report.failures.length > 20) w.push(`    ... and ${report.failures.length - 20} more`);
  }
  if (report.dryRun && (report.genuinely_missing > 0 || report.embeddings_missing_before > 0)) {
    w.push("");
    w.push("  Run with --no-dry-run to apply.");
  }
  w.push("");
  return w.join("\n");
}

// src/cli/register-pipeline.ts
init_config();
function handle2(err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}
`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === "debug" && err instanceof Error) {
    process.stderr.write(`${err.stack}
`);
  }
  const code = msg.includes("Schema validation") ? 4 : msg.includes("not found") ? 5 : 1;
  process.exit(code);
}
function registerPipeline(program2) {
  program2.command("index-rebuild").description("Rebuild FTS5 index from the HTML files.").option("--pretty").action(async (opts) => {
    try {
      process.stdout.write(`${await runIndexRebuild(opts)}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("reindex").description(
    "Diff-based reconciliation between note files on disk and the SQLite index (see commands/reindex-missing.ts). Dry-run by default."
  ).option("--missing", "index disk files with no index row, backfill missing embeddings, report ghost rows").option("--dry-run", "preview counts without writing (default: true)", true).option("--no-dry-run", "actually apply the reconciliation").option("--delete-ghosts", "also delete index rows whose file no longer exists on disk (requires --no-dry-run)").option("--batch-size <n>", "notes indexed/embedded per batch", (v) => Number.parseInt(v, 10), 200).option("--pretty", "human-readable output").action(async (opts) => {
    try {
      const out = await runReindex(opts);
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("interlink").description("Wikipedia layer: inject wikilinks + see-also into all notes (sleep-time job).").option("--dry-run", "preview changes without writing").option("--limit <n>", "max notes to process per run", (v) => Number.parseInt(v, 10), 200).option("--pretty", "human-readable output").action(async (opts) => {
    try {
      const out = await runInterlink(opts);
      process.stdout.write(`${out}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("dream").description(
    "Offline brain maintenance: read conversations, expand stubs, enrich with Haiku, detect contradictions."
  ).option("--dry-run", "preview what would be done without writing", false).option(
    "--enrich",
    "use Haiku to generate better TLDRs and topics (uses your Claude subscription)",
    false
  ).option(
    "--max-notes <n>",
    "max notes to process per enrichment phase",
    (v) => Number.parseInt(v, 10),
    200
  ).option("--pretty", "human-readable output with progress bars", false).option("--synthesize", "Only run the synthesize phase (generate wiki overview pages)").option("--topic <name>", "Synthesize only this topic").option("--force", "ignore fingerprints and reprocess all conversations", false).option("--agent <name>", "restrict ingestion to one source: claude-code | vibe").option(
    "--include-cwd-project",
    "include the engine's own project (cerveau/lazybrain) \u2014 disabled by default to avoid self-referential noise. Useful to demo code+conversation fusion on the engine itself.",
    false
  ).action(async (opts) => {
    try {
      if (opts.includeCwdProject) {
        process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = "1";
      }
      const report = await runDream({
        dryRun: opts.dryRun,
        enrich: opts.enrich,
        maxNotes: opts.maxNotes,
        pretty: opts.pretty,
        synthesizeOnly: !!opts.synthesize,
        topic: opts.topic,
        force: opts.force,
        agent: opts.agent
      });
      if (!opts.pretty) {
        process.stdout.write(`${JSON.stringify(report)}
`);
      }
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("synthesize-nodes").description("[REMOVED] use `graph` + `build-hierarchy`").action(() => {
    console.log("synthesize-nodes was removed; use `graph` + `build-hierarchy`.");
  });
  program2.command("graph").description(
    "Build the brain graph: auto-link mentions, backlinks index, clusters, view HTML + text."
  ).option("--skip-autolink").option("--skip-clusters").option("--skip-view").option("--format <fmt>", "html|text|both (default: both)", "both").option("--topic <name>", "filter sub-graph generation to this topic").option(
    "--cwd <path>",
    "explicit project directory to code-scan (works even with no pre-existing notes)"
  ).option("--pretty").action(async (opts) => {
    try {
      process.stdout.write(`${await runGraph(opts)}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("build-index").description("Regenerate brain/_index.html (atlas, metadata, JSON-LD global graph).").option("--pretty").action(async (opts) => {
    try {
      const out = await runBuildIndex(opts);
      process.stdout.write(`${JSON.stringify(out, null, opts.pretty ? 2 : 0)}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("build-clusters").description("Generate brain/clusters/<slug>/_cluster.html for each cwd.").option("--pretty").action(async (opts) => {
    try {
      const out = await runBuildClusters(opts);
      process.stdout.write(`${JSON.stringify(out, null, opts.pretty ? 2 : 0)}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("build-hierarchy").description("Build hierarchical knowledge-nodes (root \u2192 projects \u2192 modules \u2192 features)").option("--force", "Overwrite existing nodes").option("--pretty", "Pretty output").action(async (opts) => {
    try {
      const { runBuildHierarchy: runBuildHierarchy2 } = await Promise.resolve().then(() => (init_build_hierarchy(), build_hierarchy_exports));
      const report = await runBuildHierarchy2(opts);
      if (opts.pretty) {
        console.log(
          `Built hierarchy: 1 root + ${report.projectsCreated} projects + ${report.modulesCreated} modules + ${report.featuresCreated} features = ${report.totalCreated} nodes`
        );
        if (report.errors.length > 0)
          console.log(`Errors: ${report.errors.slice(0, 5).join("; ")}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("enrich-hierarchy").description("Aggregate conversation content into hierarchy knowledge-nodes").option("--force", "Re-enrich all nodes").option("--topic <name>", "Only enrich nodes under this topic").option("--pretty", "Pretty output").action(async (opts) => {
    try {
      const { runEnrichHierarchy: runEnrichHierarchy2 } = await Promise.resolve().then(() => (init_enrich_hierarchy(), enrich_hierarchy_exports));
      const report = await runEnrichHierarchy2(opts);
      if (opts.pretty) {
        console.log(
          `Enriched ${report.nodesEnriched} hierarchy nodes, ${report.sectionsPopulated} sections from ${report.conversationsScanned} convs`
        );
        if (report.errors.length > 0)
          console.log(`Errors: ${report.errors.slice(0, 5).join("; ")}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("enrich").description(
    "Enrich canonical code-first neurons (file-neuron, concept-neuron) from conversation tool-traces"
  ).option(
    "--topic <name>",
    "Only enrich neurons for this topic (no-op: enrichment is file-trace driven)"
  ).option("--force", "Re-enrich already populated neurons").option("--pretty", "Pretty output").action(async (opts) => {
    try {
      const { runEnrich: runEnrich2 } = await Promise.resolve().then(() => (init_enrich(), enrich_exports));
      const report = await runEnrich2(opts);
      if (opts.pretty) {
        console.log(
          `File-neurons enriched: ${report.fileNeuronsEnriched ?? 0}, concept neurons created: ${report.conceptNeuronsCreated ?? 0}`
        );
        if (report.errors.length > 0)
          console.log(`Errors: ${report.errors.slice(0, 5).join("; ")}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("export-agents-md").description("Project the brain into an AGENTS.md section (Vibe auto-loads it).").option("--target <t>", "user | project", "project").option("--cwd <path>", "project root (project target)").option("--out-file <path>", "override output file").option(
    "--max-tokens <n>",
    "token budget for the generated block",
    (v) => Number.parseInt(v, 10),
    1200
  ).option("--pretty").action(async (opts) => {
    try {
      const { runExportAgentsMd: runExportAgentsMd2 } = await Promise.resolve().then(() => (init_export_agents_md(), export_agents_md_exports));
      const report = await runExportAgentsMd2({
        target: opts.target === "user" ? "user" : "project",
        cwd: opts.cwd,
        outFile: opts.outFile,
        maxTokens: opts.maxTokens,
        pretty: opts.pretty
      });
      process.stdout.write(`${JSON.stringify(report)}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("health-score").description(
    "Compute brain health score [0..100]: orphans, broken links, stale notes, duplicates. Writes cerveau-health meta to _index.html."
  ).option("--pretty", "human-readable output").action(async (opts) => {
    try {
      const result = await computeHealthScore(getConfig().brainPath);
      if (opts.pretty) {
        process.stdout.write(
          `Health score: ${result.score}/100
  Orphans:      ${result.orphans}
  Broken links: ${result.brokenLinks}
  Stale:        ${result.stale}
  Dupes:        ${result.dupes}
`
        );
      } else {
        process.stdout.write(`${JSON.stringify(result)}
`);
      }
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("health-detail").description(
    `Read-only breakdown for one health-score category (orphans, brokenLinks, duplicates) \u2014 the dry-run list behind Settings > Memory's "view details" action. Never writes to the brain.`
  ).requiredOption("--category <category>", "orphans | brokenLinks | duplicates").action((opts) => {
    try {
      const category = opts.category;
      if (category !== "orphans" && category !== "brokenLinks" && category !== "duplicates") {
        throw new Error(
          `invalid --category: ${opts.category} (expected orphans | brokenLinks | duplicates)`
        );
      }
      const result = computeHealthDetail(category);
      process.stdout.write(`${JSON.stringify(result)}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("import").description(
    "Batch-import conversation history from Claude Code, Cursor, ChatGPT, or Claude.ai exports."
  ).requiredOption(
    "--source <source>",
    "claude-code | cursor | chatgpt-export | claude-export | auto"
  ).option("--input <path>", "path to export file (required for chatgpt-export and claude-export)").option("--dry-run", "count and estimate without writing", false).option("--use-llm", "use LLM augmentation for enrichment (ignored in dry-run)", false).option("--since <iso>", "only import conversations updated after this ISO timestamp").option(
    "--limit <n>",
    "max conversations to import per run",
    (v) => Number.parseInt(v, 10)
  ).action(async (opts) => {
    try {
      const result = await runImport({
        source: opts.source,
        input: opts.input,
        dryRun: !!opts.dryRun,
        useLlm: !!opts.useLlm,
        since: opts.since,
        limit: opts.limit
      });
      process.stdout.write(`${JSON.stringify(result)}
`);
    } catch (err) {
      handle2(err);
    }
  });
  program2.command("publish").description("Publish a scrubbed copy of the brain (dry-run by default).").option(
    "--out-dir <path>",
    "output directory (default: ../public or ../public-site for --site)"
  ).option("--out <path>", "alias for --out-dir").option("--dry-run", "report what would be generated without writing (default)").option("--confirm", "actually write the output folder").option("--exclude-tier <tier>", "archival|working").option("--pretty", "human-readable output").option(
    "--profile <profile>",
    "scrub profile: public-strict (default, strips provenance) | default (keeps provenance)",
    "public-strict"
  ).option("--site", "generate a self-contained static SPA site (GitHub Pages ready)").option("--base-url <url>", "site base URL for sitemap.xml and OpenGraph (--site mode)").option("--site-title <title>", "site <title> and og:title (--site mode)").option(
    "--topic <prefix>",
    "include ONLY notes whose data-cerveau-topic starts with this prefix (case-insensitive)"
  ).action((opts) => {
    try {
      const validProfiles = ["default", "public-strict"];
      if (opts.profile && !validProfiles.includes(opts.profile)) {
        throw new Error(
          `Invalid --profile "${opts.profile}". Accepted values: ${validProfiles.join(", ")}`
        );
      }
      const mergedOpts = { ...opts, outDir: opts.outDir ?? opts.out };
      process.stdout.write(`${runPublish(mergedOpts)}
`);
    } catch (err) {
      handle2(err);
    }
  });
}

// src/cli/register-serve.ts
init_daemon();

// src/commands/serve.ts
init_embeddings();
init_fts();
import { existsSync as existsSync49 } from "node:fs";
import { createServer as createServer2 } from "node:http";
import { dirname as dirname15, join as join46, resolve as resolve6 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";

// src/server/auth.ts
function checkAuth(req, res, token) {
  if (!token) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("Unauthorized");
    return false;
  }
  return true;
}

// src/server/brain-registry.ts
init_db();
init_paths();
init_logger();
init_brain_context();
import { createHash as createHash12 } from "node:crypto";
import { existsSync as existsSync45, mkdirSync as mkdirSync23 } from "node:fs";
import { join as join43, resolve as resolve4 } from "node:path";
var MAX_HOT_BRAINS = 3;
var VALID_BRAIN_LABELS = /* @__PURE__ */ new Set(["project", "team", "trunk"]);
function normalizeBrainLabel(raw) {
  return typeof raw === "string" && VALID_BRAIN_LABELS.has(raw) ? raw : void 0;
}
var BrainNotFoundError = class extends Error {
  constructor(brainId) {
    super(`Unknown brainId: ${brainId}`);
    this.name = "BrainNotFoundError";
  }
};
var brains = /* @__PURE__ */ new Map();
var brainIdByPath = /* @__PURE__ */ new Map();
function normalizeBrainPath(brainPath) {
  return resolve4(brainPath);
}
function computeBrainId(absPath) {
  return createHash12("sha1").update(absPath).digest("hex").slice(0, 16);
}
function cachePathFor(absBrainPath) {
  return resolve4(absBrainPath, "_cache");
}
function ftsDbPathFor(cachePath3) {
  return join43(cachePath3, FTS_DB_FILENAME);
}
function toContext(entry) {
  return { brainId: entry.brainId, brainPath: entry.brainPath, cachePath: entry.cachePath };
}
function toHandle(entry) {
  return {
    brainId: entry.brainId,
    brainPath: entry.brainPath,
    cachePath: entry.cachePath,
    label: entry.label,
    hot: entry.hot,
    lastUsedMs: entry.lastUsedMs
  };
}
function hotCount() {
  let n = 0;
  for (const entry of brains.values()) if (entry.hot) n += 1;
  return n;
}
function demoteLru(except) {
  let victim;
  for (const entry of brains.values()) {
    if (!entry.hot || entry.brainId === except) continue;
    if (!victim || entry.lastUsedMs < victim.lastUsedMs) victim = entry;
  }
  if (!victim) return;
  victim.hot = false;
  closeDbForPath(ftsDbPathFor(victim.cachePath));
  getLogger().info(
    { brainId: victim.brainId, brainPath: victim.brainPath },
    "brain-registry: demoted LRU brain (closed heavy handles; entry kept for lazy reopen)"
  );
}
function promote(entry) {
  entry.lastUsedMs = Date.now();
  if (entry.hot) return;
  if (hotCount() >= MAX_HOT_BRAINS) demoteLru(entry.brainId);
  entry.hot = true;
}
async function openBrain(brainPath, opts = {}) {
  const absPath = normalizeBrainPath(brainPath);
  const existingId = brainIdByPath.get(absPath);
  if (existingId) {
    const entry2 = brains.get(existingId);
    if (entry2) {
      if (opts.label) entry2.label = opts.label;
      promote(entry2);
      return { brainId: existingId, label: entry2.label };
    }
  }
  const brainId = computeBrainId(absPath);
  const cachePath3 = cachePathFor(absPath);
  if (!existsSync45(absPath)) mkdirSync23(absPath, { recursive: true });
  if (!existsSync45(cachePath3)) mkdirSync23(cachePath3, { recursive: true });
  const entry = {
    brainId,
    brainPath: absPath,
    cachePath: cachePath3,
    label: opts.label ?? "project",
    hot: false,
    lastUsedMs: 0
  };
  brains.set(brainId, entry);
  brainIdByPath.set(absPath, brainId);
  promote(entry);
  return { brainId, label: entry.label };
}
function listBrains() {
  return [...brains.values()].map(toHandle).sort((a, b) => b.lastUsedMs - a.lastUsedMs);
}
function withBrain(brainId, fn) {
  if (!brainId) return fn();
  const entry = brains.get(brainId);
  if (!entry) throw new BrainNotFoundError(brainId);
  promote(entry);
  return runWithBrainContext(toContext(entry), fn);
}
function enterBrain(brainId) {
  if (!brainId) return;
  const entry = brains.get(brainId);
  if (!entry) throw new BrainNotFoundError(brainId);
  promote(entry);
  enterBrainContext(toContext(entry));
}

// src/server/cors.ts
var ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost$/,
  /^tauri:\/\/localhost$/,
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/
];
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}
function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

// src/server/pid.ts
init_config();
import { existsSync as existsSync46, mkdirSync as mkdirSync24, readFileSync as readFileSync42, unlinkSync as unlinkSync5, writeFileSync as writeFileSync35 } from "node:fs";
import { join as join44 } from "node:path";
function servePidPath() {
  return join44(getConfig().cachePath, "serve.pid");
}
function servePortPath() {
  return join44(getConfig().cachePath, "serve.port");
}
function writeServeFiles(port) {
  const cachePath3 = getConfig().cachePath;
  if (!existsSync46(cachePath3)) mkdirSync24(cachePath3, { recursive: true });
  writeFileSync35(servePidPath(), String(process.pid), "utf8");
  writeFileSync35(servePortPath(), String(port), "utf8");
}
function cleanServeFiles() {
  for (const path of [servePidPath(), servePortPath()]) {
    try {
      unlinkSync5(path);
    } catch {
    }
  }
}
function readServePort() {
  try {
    const raw = readFileSync42(servePortPath(), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
async function stopServe(timeoutMs = 3e3) {
  const port = readServePort();
  if (!port) return "no-server";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`http://127.0.0.1:${port}/_api/shutdown`, {
      method: "POST",
      signal: controller.signal
    });
    return "stopped";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("aborted") || msg.includes("fetch failed")) {
      return "stopped";
    }
    return `error:${msg}`;
  } finally {
    clearTimeout(timer);
    cleanServeFiles();
  }
}

// src/server/resource-monitor.ts
init_embeddings();
init_hyde();
init_logger();
init_session_cache();
var RESOURCE_SNAPSHOT_INTERVAL_MS = 5 * 6e4;
function toMb(bytes) {
  return Math.round(bytes / (1024 * 1024) * 10) / 10;
}
function logResourceSnapshot() {
  const mem = process.memoryUsage();
  const brains2 = listBrains();
  getLogger().info(
    {
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      externalMb: toMb(mem.external),
      arrayBuffersMb: toMb(mem.arrayBuffers),
      embeddingCache: embeddingCacheStats(),
      hydeCache: hydeCacheStats(),
      sessions: sessionCacheStats(),
      brains: { total: brains2.length, hot: brains2.filter((b) => b.hot).length }
    },
    "serve: resource snapshot"
  );
}
function startResourceMonitor(intervalMs = RESOURCE_SNAPSHOT_INTERVAL_MS) {
  const timer = setInterval(logResourceSnapshot, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// src/server/routes/brains.ts
init_logger();
var MAX_BODY_BYTES = 1e6;
function readJsonBody2(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
async function handleOpenBrain(req, res) {
  const log = getLogger();
  try {
    const body = await readJsonBody2(req);
    const brainPath = typeof body.brainPath === "string" ? body.brainPath.trim() : "";
    if (!brainPath) {
      sendError(res, 400, "Missing brainPath");
      return;
    }
    const label = normalizeBrainLabel(body.label);
    const { brainId, label: resolvedLabel } = await openBrain(brainPath, { label });
    sendJson(res, 200, { brainId, label: resolvedLabel });
  } catch (err) {
    log.error({ err }, "API error in POST /brains/open");
    sendError(res, 500, "Failed to open brain");
  }
}
function handleListBrains(_req, res) {
  const log = getLogger();
  try {
    const brains2 = listBrains().map((b) => ({
      brainId: b.brainId,
      brainPath: b.brainPath,
      label: b.label,
      hot: b.hot,
      lastUsedMs: b.lastUsedMs
    }));
    sendJson(res, 200, { brains: brains2 });
  } catch (err) {
    log.error({ err }, "API error in GET /brains");
    sendError(res, 500, "Failed to list brains");
  }
}

// src/server/routes/notes.ts
init_backlinks();
init_fts();
init_paths();
init_logger();
import { existsSync as existsSync47, readFileSync as readFileSync43 } from "node:fs";
function normPath2(raw) {
  return raw.replace(/\\/g, "/").replace(/^.*[/\\]brain[/\\]/, "");
}
function parseConflictWith(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
var handleNotes = (req, res, url) => {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const mapped = allNotes.map((n) => ({
      id: n.id,
      path: normPath2(n.path),
      title: n.title,
      type: n.type,
      tags: n.tags,
      topic: n.topic || null,
      created: n.created,
      importance: n.importance,
      // Contradiction-detection signal (graph/contradictions.ts) — surfaced so
      // the frontend wiki view can render a "contradicts a past decision"
      // warning without re-parsing note HTML.
      saliencyKind: n.saliency_kind ?? null,
      conflictWith: parseConflictWith(n.conflict_with)
    }));
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    const hasPagination = rawLimit !== null || rawOffset !== null;
    let slice = mapped;
    let extra;
    if (hasPagination) {
      const limit = Math.max(1, Number.parseInt(rawLimit ?? "20", 10) || 20);
      const offset = Math.max(0, Number.parseInt(rawOffset ?? "0", 10) || 0);
      slice = mapped.slice(offset, offset + limit);
      extra = { "x-total-count": String(mapped.length) };
    }
    sendJsonCached(req, res, 200, slice, { csp: CSP_API, extra }).catch((err) => {
      log.error({ err }, "Compression error in /_api/notes");
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, "API error in /_api/notes");
    sendError(res, 500, "Index not ready");
  }
};
function handleBacklinks(_req, res, noteId) {
  const log = getLogger();
  try {
    const idx = loadBacklinks();
    if (!idx) {
      sendError(res, 404, "Backlinks index not available");
      return;
    }
    const incoming = idx.incoming[noteId] ?? [];
    sendJson(res, 200, {
      noteId,
      total: incoming.length,
      backlinks: incoming.map((b) => ({
        from: b.from,
        type: b.type,
        surface: b.surface,
        auto: b.auto
      }))
    });
  } catch (err) {
    log.error({ err }, "API error in /_api/notes/:id/backlinks");
    sendError(res, 500, "Failed to load backlinks");
  }
}
function handleNeighbors(_req, res, noteId) {
  const log = getLogger();
  try {
    const idx = loadBacklinks();
    if (!idx) {
      sendError(res, 404, "Backlinks index not available");
      return;
    }
    const inbound = idx.incoming[noteId] ?? [];
    const outbound = idx.outgoing[noteId] ?? [];
    sendJson(res, 200, {
      noteId,
      inbound: {
        count: inbound.length,
        notes: inbound.map((b) => ({ id: b.from, type: b.type }))
      },
      outbound: {
        count: outbound.length,
        notes: outbound.map((b) => ({ id: b.to, type: b.type }))
      }
    });
  } catch (err) {
    log.error({ err }, "API error in /_api/notes/:id/neighbors");
    sendError(res, 500, "Failed to load neighbors");
  }
}
function handleNoteById(_req, res, noteId) {
  const log = getLogger();
  try {
    const allIndexed = listAllReadonly({ includeExpired: false });
    const indexed = allIndexed.find((n) => n.id === noteId);
    if (indexed && existsSync47(indexed.path)) {
      const html = readFileSync43(indexed.path, "utf-8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP_NOTE
      });
      res.end(html);
      return;
    }
    const sluggedId = slug(noteId);
    const slugMatch = allIndexed.find((n) => n.id === sluggedId || slug(n.id) === sluggedId);
    if (slugMatch && existsSync47(slugMatch.path)) {
      const html = readFileSync43(slugMatch.path, "utf-8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP_NOTE
      });
      res.end(html);
      return;
    }
    sendError(res, 404, `Note not found: ${noteId}`);
  } catch (err) {
    log.error({ err }, "API error in /_api/note/:id");
    sendError(res, 500, "Failed to load note");
  }
}
function handleNodeById(_req, res, nodeId) {
  const log = getLogger();
  try {
    const nodePath = knowledgeNodePath(slug(nodeId));
    if (!existsSync47(nodePath)) {
      sendError(res, 404, `Knowledge node not found: ${nodeId}`);
      return;
    }
    const html = readFileSync43(nodePath, "utf-8");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP_NOTE
    });
    res.end(html);
  } catch (err) {
    log.error({ err }, "API error in /_api/node/:id");
    sendError(res, 500, "Failed to load knowledge node");
  }
}
function handleNoteMeta(_req, res, noteId) {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const found = allNotes.find((n) => n.id === noteId);
    if (!found) {
      sendError(res, 404, `Note not found: ${noteId}`);
      return;
    }
    sendJson(res, 200, {
      id: found.id,
      path: normPath2(found.path),
      type: found.type,
      title: found.title,
      topic: found.topic ?? null,
      tags: found.tags ?? "",
      importance: found.importance ?? 0.5,
      created: found.created ?? null,
      // Contradiction-detection signal (graph/contradictions.ts) — lets the
      // wiki note panel render a "contradicts a past decision" warning that
      // links to the conflicting note(s).
      saliencyKind: found.saliency_kind ?? null,
      conflictWith: parseConflictWith(found.conflict_with)
    });
  } catch (err) {
    log.error({ err }, "API error in /_api/note-meta/:id");
    sendError(res, 500, "Failed to look up note metadata");
  }
}
var handleResolve = (_req, res, url) => {
  const log = getLogger();
  try {
    const href = url.searchParams.get("href");
    if (!href) {
      sendError(res, 400, "Missing href parameter");
      return;
    }
    const allNotes = listAllReadonly({ includeExpired: false });
    let found;
    if (href.startsWith("file:")) {
      const codePath = href.slice("file:".length).replace(/\\/g, "/");
      const sluggedPath = slug(codePath);
      found = allNotes.find(
        (n) => n.type === "file-neuron" && (n.id.endsWith(sluggedPath) || n.id.includes(sluggedPath))
      );
      if (!found) {
        const parts = codePath.split("/").map((p) => slug(p));
        found = allNotes.find(
          (n) => n.type === "file-neuron" && parts.every((p) => n.id.includes(p))
        );
      }
    } else {
      const hrefSlug = slug(href);
      found = allNotes.find((n) => n.id === hrefSlug || slug(n.id) === hrefSlug);
    }
    if (!found) {
      sendError(res, 404, `No note found for href: ${href}`);
      return;
    }
    sendJson(res, 200, {
      id: found.id,
      path: normPath2(found.path),
      type: found.type,
      title: found.title
    });
  } catch (err) {
    log.error({ err }, "API error in /_api/resolve");
    sendError(res, 500, "Failed to resolve href");
  }
};

// src/server/routes/recall.ts
init_inject_context();
init_markers();
init_logger();
var handleRecall = (req, res, url) => {
  const log = getLogger();
  try {
    const q = url.searchParams.get("q");
    if (!q) {
      sendError(res, 400, "Missing q parameter");
      return;
    }
    const cwd = url.searchParams.get("cwd") ?? void 0;
    const sessionId = url.searchParams.get("sessionId") ?? void 0;
    const maxTokens = Number.parseInt(url.searchParams.get("maxTokens") ?? "1500", 10);
    const nudge = parseNudgeStyle(url.searchParams.get("nudge"));
    const skipTelemetry = req.headers["x-lazy-warmup"] === "1";
    runTurnInjectDetailed({
      query: q,
      cwd,
      sessionId,
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : void 0,
      nudge,
      skipTelemetry
    }).then((result) => {
      const data = {
        query: q,
        text: result.text,
        level: result.levelUsed,
        tokens: result.tokens
      };
      return sendJsonCached(req, res, 200, data);
    }).catch((err) => {
      if (mapDbError(res, err)) return;
      log.error({ err }, "API error in /_api/recall");
      sendError(res, 500, "Recall failed");
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, "API error in /_api/recall");
    sendError(res, 500, "Recall error");
  }
};

// src/server/routes/search.ts
init_router();
init_logger();
function selectBrainsForScope(brains2, scope) {
  if (scope === "team") {
    return brains2.filter((b) => b.label === "team" || b.label === "trunk");
  }
  return brains2;
}
async function federatedSearch(query, topK, scope) {
  const brains2 = selectBrainsForScope(listBrains(), scope);
  if (brains2.length === 0) return { hits: [], totalMs: 0 };
  const perBrain = await Promise.allSettled(
    brains2.map(async (brain) => {
      try {
        const result = await withBrain(brain.brainId, () => route({ query, topK }));
        return result.hits.map((h) => ({
          id: h.id,
          path: h.path.replace(/\\/g, "/").replace(/^.*[/\\]brain[/\\]/, ""),
          score: h.score,
          snippet: h.snippet ?? "",
          brainId: brain.brainId,
          brainPath: brain.brainPath
        }));
      } catch {
        return [];
      }
    })
  );
  const allHits = [];
  for (const outcome of perBrain) {
    if (outcome.status === "fulfilled") allHits.push(...outcome.value);
  }
  allHits.sort((a, b) => b.score - a.score);
  return { hits: allHits.slice(0, topK), totalMs: 0 };
}
var handleSearch = (req, res, url) => {
  const log = getLogger();
  try {
    const q = url.searchParams.get("q");
    if (!q) {
      sendError(res, 400, "Missing q parameter");
      return;
    }
    const topK = Math.min(Math.max(Number.parseInt(url.searchParams.get("top") ?? "5", 10), 1), 50);
    const scope = url.searchParams.get("scope") ?? "current";
    if (scope === "all-open" || scope === "team") {
      federatedSearch(q, topK, scope).then(({ hits, totalMs }) => {
        const data = {
          query: q,
          topK,
          scope,
          results: hits.map((h) => ({
            id: h.id,
            path: h.path,
            score: h.score,
            snippet: h.snippet,
            brainId: h.brainId,
            brainPath: h.brainPath
          })),
          totalMs
        };
        return sendJsonCached(req, res, 200, data);
      }).catch((err) => {
        if (mapDbError(res, err)) return;
        log.error({ err }, "API error in /_api/search (federated)");
        sendError(res, 500, "Federated search failed");
      });
      return;
    }
    route({ query: q, topK }).then((result) => {
      const data = {
        query: q,
        topK,
        scope,
        results: result.hits.map((h) => ({
          id: h.id,
          path: h.path.replace(/\\/g, "/").replace(/^.*[/\\]brain[/\\]/, ""),
          score: h.score,
          level: result.levelUsed,
          snippet: h.snippet
        })),
        totalMs: result.totalMs
      };
      return sendJsonCached(req, res, 200, data);
    }).catch((err) => {
      if (mapDbError(res, err)) return;
      log.error({ err }, "API error in /_api/search");
      sendError(res, 500, "Search failed");
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, "API error in /_api/search");
    sendError(res, 500, "Search error");
  }
};

// src/server/routes/static.ts
import { createReadStream, existsSync as existsSync48, statSync as statSync13 } from "node:fs";
import { extname as extname3, join as join45, normalize as normalize2, resolve as resolve5 } from "node:path";
var STATIC_CACHE_CONTROL = "public, max-age=60, must-revalidate";
function fileETag(mtimeMs, size) {
  return `"${mtimeMs.toString(36)}-${size.toString(36)}"`;
}
var UI_ASSET_PREFIXES = ["/styles/", "/components/", "/lib/"];
function handleUiRoute(_req, res, rel, ui) {
  if ((rel === "/" || rel === "") && ui.uiIndexExists) {
    res.writeHead(200, { "content-type": MIME[".html"], "content-security-policy": CSP_UI });
    createReadStream(ui.uiIndexPath).pipe(res);
    return true;
  }
  if (rel === "/graph.html") {
    const graphPath = join45(ui.uiDir, "graph.html");
    if (existsSync48(graphPath)) {
      res.writeHead(200, { "content-type": MIME[".html"], "content-security-policy": CSP_UI });
      createReadStream(graphPath).pipe(res);
      return true;
    }
  }
  const ROOT_ASSETS = ["/favicon.svg", "/favicon.ico"];
  if (ROOT_ASSETS.includes(rel)) {
    const assetPath = join45(ui.uiDir, rel.replace(/^\//, ""));
    if (existsSync48(assetPath)) {
      const assetStat = statSync13(assetPath);
      const assetETag = fileETag(assetStat.mtimeMs, assetStat.size);
      if (handleConditionalGet(_req, res, assetETag)) return true;
      const assetMime = MIME[extname3(assetPath).toLowerCase()] ?? "image/svg+xml";
      res.writeHead(200, {
        "content-type": assetMime,
        "content-security-policy": CSP_UI,
        "cache-control": STATIC_CACHE_CONTROL,
        etag: assetETag
      });
      createReadStream(assetPath).pipe(res);
      return true;
    }
  }
  if (UI_ASSET_PREFIXES.some((prefix) => rel.startsWith(prefix))) {
    if (rel.includes("..")) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return true;
    }
    const assetRelPath = rel.replace(/^\//, "");
    const assetPath = resolve5(ui.uiDir, assetRelPath);
    if (!assetPath.startsWith(resolve5(ui.uiDir))) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return true;
    }
    if (!existsSync48(assetPath)) {
      res.writeHead(404);
      res.end("Not Found");
      return true;
    }
    const assetStat = statSync13(assetPath);
    const assetETag = fileETag(assetStat.mtimeMs, assetStat.size);
    if (handleConditionalGet(_req, res, assetETag)) return true;
    const assetMime = MIME[extname3(assetPath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": assetMime,
      "content-security-policy": CSP_UI,
      "cache-control": STATIC_CACHE_CONTROL,
      etag: assetETag
    });
    createReadStream(assetPath).pipe(res);
    return true;
  }
  return false;
}
function handleBrainFile(_req, res, rel, root) {
  const safeRel = normalize2(rel).replace(/^[/\\]+/, "");
  const resolved = resolve5(root, safeRel);
  if (!resolved.startsWith(resolve5(root))) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  let target = resolved;
  if (existsSync48(resolved) && statSync13(resolved).isDirectory()) {
    target = join45(resolved, "index.html");
  }
  if (!existsSync48(target)) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const targetStat = statSync13(target);
  const etag = fileETag(targetStat.mtimeMs, targetStat.size);
  if (handleConditionalGet(_req, res, etag)) return;
  const mime = MIME[extname3(target).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": mime,
    "content-security-policy": CSP_STATIC,
    "cache-control": STATIC_CACHE_CONTROL,
    etag
  });
  createReadStream(target).pipe(res);
}

// src/server/routes/synthesis.ts
init_reader();
init_logger();
function handleSynthesisIndex(_req, res) {
  const log = getLogger();
  try {
    const allNotes = readAllNotes();
    const brainIndex = allNotes.find((n) => /data-cerveau-type="brain-index"/.test(n.html));
    if (!brainIndex) {
      sendError(res, 404, "No brain index found. Run: lazybrain dream --synthesize");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(brainIndex.html);
  } catch (err) {
    log.error({ err }, "API error in /_api/synthesis/index");
    sendError(res, 500, "Failed to load brain index");
  }
}
function matchesExactTopic(html, topic) {
  const topicMatch = html.match(/data-cerveau-topic="([^"]*)"/);
  return topicMatch != null && topicMatch[1].trim() === topic;
}
function matchesTopLevelTopic(html, topic) {
  const topicMatch = html.match(/data-cerveau-topic="([^"]*)"/);
  if (topicMatch != null && topicMatch[1].split("/")[0]?.trim() === topic) return true;
  const tagMatch = html.match(/data-cerveau-tags="([^"]*)"/);
  return tagMatch != null && tagMatch[1].split(",")[0]?.trim() === topic;
}
function handleSynthesisTopic(_req, res, topic) {
  const log = getLogger();
  try {
    const overviews = readAllNotes().filter((n) => /data-cerveau-type="topic-overview"/.test(n.html));
    const overview = overviews.find((n) => matchesExactTopic(n.html, topic)) ?? overviews.find((n) => matchesTopLevelTopic(n.html, topic));
    if (!overview) {
      sendError(res, 404, `No synthesis found for topic: ${topic}`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(overview.html);
  } catch (err) {
    log.error({ err }, "API error in /_api/synthesis/:topic");
    sendError(res, 500, "Failed to load topic overview");
  }
}

// src/server/routes/tree.ts
init_fts();
init_paths();
init_logger();
function normPath3(raw) {
  return raw.replace(/\\/g, "/").replace(/^.*[/\\]brain[/\\]/, "");
}
var hierarchyCache = new IndexVersionedCache();
var treeCache = new IndexVersionedCache();
function addTotals(node) {
  let total = node.count;
  for (const child of Object.values(node.children)) {
    total += addTotals(child);
  }
  node.total = total;
  return total;
}
function buildHierarchy(allNotes) {
  const root = { children: {}, count: 0 };
  for (const note of allNotes) {
    const parts = (note.topic || "_uncategorized").split("/").filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { children: {}, count: 0 };
      }
      node = node.children[part];
    }
    node.count += 1;
  }
  addTotals(root);
  return root;
}
function handleHierarchy(req, res) {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const fingerprint = computeNotesFingerprint(allNotes);
    let result = hierarchyCache.get(fingerprint);
    if (!result) {
      result = buildHierarchy(allNotes);
      hierarchyCache.set(fingerprint, result);
    }
    sendJsonCached(req, res, 200, result, { csp: CSP_API }).catch((err) => {
      log.error({ err }, "Compression error in /_api/hierarchy");
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, "API error in /_api/hierarchy");
    sendError(res, 500, "Failed to build hierarchy");
  }
}
function handleTopics(_req, res, topicPath) {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const topicNotes = allNotes.filter((n) => (n.topic ?? "").startsWith(topicPath));
    const topicDecisions = topicNotes.filter((n) => n.type === "decision");
    const tagCounts = /* @__PURE__ */ new Map();
    for (const n of topicNotes) {
      const tags = (n.tags ?? "").split(/\s+/).filter(Boolean);
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag);
    const avgImportance = topicNotes.length > 0 ? topicNotes.reduce((sum, n) => sum + (n.importance ?? 0), 0) / topicNotes.length : 0;
    sendJson(res, 200, {
      topic: topicPath,
      stats: {
        totalNotes: topicNotes.length,
        activeDecisions: topicDecisions.length,
        topTags,
        avgImportance: Math.round(avgImportance * 100) / 100
      },
      notes: topicNotes.map((n) => ({
        id: n.id,
        path: normPath3(n.path),
        title: n.title,
        type: n.type,
        importance: n.importance
      })),
      decisions: topicDecisions.map((d) => ({
        id: d.id,
        title: d.title,
        created: d.created,
        importance: d.importance
      }))
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, "API error in /_api/topics/:path");
    sendError(res, 500, "Failed to load topic");
  }
}
function normSeg2(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "-");
}
function normTopic(t) {
  return t.split("/").map(normSeg2).join("/");
}
function projectSlug(note) {
  const first = (note.topic || "").split("/")[0];
  return normSeg2(first ?? "") || slug(note.id);
}
function buildProjectMap(aggregates, fileNeurons) {
  const projectMap = /* @__PURE__ */ new Map();
  function ensureProject(key, label) {
    if (!projectMap.has(key)) {
      projectMap.set(key, { label, rootAgg: null, subAggs: [], files: [] });
    }
  }
  for (const agg of aggregates) {
    const key = projectSlug(agg);
    const label = (agg.topic || "").split("/")[0] || agg.id;
    ensureProject(key, label);
    const entry = projectMap.get(key);
    const topicDepth = (agg.topic || "").split("/").filter(Boolean).length;
    if (topicDepth <= 1 && !entry.rootAgg) {
      entry.rootAgg = agg;
    } else {
      entry.subAggs.push(agg);
    }
  }
  for (const entry of projectMap.values()) {
    if (entry.rootAgg === null && entry.subAggs.length > 0) {
      const best = entry.subAggs.reduce(
        (prev, cur) => (cur.importance ?? 0) > (prev.importance ?? 0) ? cur : prev,
        entry.subAggs[0]
      );
      entry.rootAgg = best;
      entry.subAggs = entry.subAggs.filter((a) => a.id !== best.id);
    }
  }
  for (const file of fileNeurons) {
    const key = projectSlug(file);
    const label = (file.topic || "").split("/")[0] || "_unknown";
    ensureProject(key, label);
    projectMap.get(key).files.push(file);
  }
  return projectMap;
}
function buildModuleChildren(subAggs, files) {
  return subAggs.sort((a, b) => (a.topic || "").localeCompare(b.topic || "")).map((agg) => {
    const topicParts = (agg.topic || "").split("/").filter(Boolean);
    const moduleLabel = topicParts.slice(1).join("/") || agg.title || agg.id;
    const normAggTopic = normTopic(agg.topic || "");
    const moduleFiles = files.filter((f) => {
      const nft = normTopic(f.topic || "");
      return nft === normAggTopic || nft.startsWith(`${normAggTopic}/`);
    }).map((f) => ({
      id: f.id,
      label: f.title || f.id,
      noteId: f.id,
      type: f.type,
      children: []
    }));
    return {
      id: agg.id,
      label: moduleLabel,
      noteId: agg.id,
      type: "aggregate-neuron",
      children: moduleFiles
    };
  });
}
var KNOWLEDGE_EXCLUDED_TYPES = /* @__PURE__ */ new Set([
  "aggregate-neuron",
  "file-neuron",
  "topic-overview",
  "brain-index",
  "hierarchy-node",
  "project-summary"
]);
function isKnowledgeNote(n) {
  return !KNOWLEDGE_EXCLUDED_TYPES.has(n.type ?? "") && (n.topic ?? "").trim() !== "";
}
function noteLeaf(note) {
  return { id: note.id, label: note.title || note.id, noteId: note.id, type: note.type, children: [] };
}
function nestKnowledgeNotes(notes, depth) {
  const direct = [];
  const bySegment = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const segments = (note.topic ?? "").split("/").filter(Boolean);
    if (segments.length <= depth) {
      direct.push(note);
      continue;
    }
    const seg = segments[depth];
    const group = bySegment.get(seg) ?? [];
    group.push(note);
    bySegment.set(seg, group);
  }
  const branches = [...bySegment.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([seg, group]) => {
    const path = (group[0]?.topic ?? "").split("/").filter(Boolean).slice(0, depth + 1).join("/");
    return { id: path, label: seg, noteId: null, type: "topic", children: nestKnowledgeNotes(group, depth + 1) };
  });
  const leaves = direct.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id)).map(noteLeaf);
  return [...branches, ...leaves];
}
function buildKnowledgeProjects(allNotes) {
  const byProject = /* @__PURE__ */ new Map();
  for (const note of allNotes) {
    if (!isKnowledgeNote(note)) continue;
    const first = (note.topic ?? "").split("/")[0] ?? "";
    const key = normSeg2(first);
    if (!key) continue;
    const group = byProject.get(key) ?? [];
    group.push(note);
    byProject.set(key, group);
  }
  const result = /* @__PURE__ */ new Map();
  for (const [key, notes] of byProject) {
    const label = (notes[0]?.topic ?? "").split("/")[0] || key;
    result.set(key, { label, children: nestKnowledgeNotes(notes, 1) });
  }
  return result;
}
function buildCodeChildren(entry, label) {
  const normProjectTopic = normTopic((entry.rootAgg?.topic || label).split("/")[0] || label);
  const moduleChildren = buildModuleChildren(entry.subAggs, entry.files);
  const assignedFileIds = new Set(moduleChildren.flatMap((m) => m.children.map((f) => f.id)));
  const topFiles = entry.files.filter((f) => {
    if (assignedFileIds.has(f.id)) return false;
    return normTopic(f.topic || "").split("/")[0] === normProjectTopic;
  }).map((f) => ({ id: f.id, label: f.title || f.id, noteId: f.id, type: f.type, children: [] }));
  return [...moduleChildren, ...topFiles];
}
function buildProjectNode(codeEntry, knowledgeEntry, fallbackKey) {
  const label = codeEntry?.label ?? knowledgeEntry?.label ?? fallbackKey;
  const codeChildren = codeEntry ? buildCodeChildren(codeEntry, label) : [];
  const children = [...codeChildren, ...knowledgeEntry?.children ?? []].sort(
    (a, b) => a.label.localeCompare(b.label)
  );
  const rootAgg = codeEntry?.rootAgg ?? null;
  return { id: rootAgg?.id ?? label, label, noteId: rootAgg?.id ?? null, type: "project", children };
}
function isActive(note, nowIso2) {
  const until = note.valid_until;
  return !until || until.trim() === "" || until > nowIso2;
}
function buildTree(allNotes, nowIso2 = (/* @__PURE__ */ new Date()).toISOString()) {
  const activeNotes = allNotes.filter((n) => isActive(n, nowIso2));
  const aggregates = activeNotes.filter((n) => n.type === "aggregate-neuron");
  const fileNeurons = activeNotes.filter((n) => n.type === "file-neuron");
  const projectMap = buildProjectMap(aggregates, fileNeurons);
  const knowledgeMap = buildKnowledgeProjects(activeNotes);
  const keys = /* @__PURE__ */ new Set([...projectMap.keys(), ...knowledgeMap.keys()]);
  const projects = [...keys].filter((k) => k !== "" && k !== "_unknown").sort((a, b) => {
    const aRank = knowledgeMap.has(a) ? 0 : 1;
    const bRank = knowledgeMap.has(b) ? 0 : 1;
    return aRank !== bRank ? aRank - bRank : a.localeCompare(b);
  }).map((key) => buildProjectNode(projectMap.get(key), knowledgeMap.get(key), key));
  return { projects };
}
function handleTree(req, res) {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: true });
    const fingerprint = computeNotesFingerprint(allNotes);
    let result = treeCache.get(fingerprint);
    if (!result) {
      result = buildTree(allNotes);
      treeCache.set(fingerprint, result);
    }
    sendJsonCached(req, res, 200, result, { csp: CSP_API }).catch((err) => {
      log.error({ err }, "Compression error in /_api/tree");
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, "API error in /_api/tree");
    sendError(res, 500, "Failed to build tree");
  }
}

// src/commands/serve.ts
init_paths();
init_brain_guard();
init_logger();
var __filename = fileURLToPath4(import.meta.url);
var __dirname = dirname15(__filename);
function runServe(opts) {
  return new Promise((resolveServer, reject) => {
    const port = opts.port ?? 4242;
    const bind = opts.bind ?? "127.0.0.1";
    const root = brainRoot();
    const log = getLogger();
    try {
      assertBrainExists();
    } catch (err) {
      reject(err);
      return;
    }
    const uiDir = resolve6(__dirname, "..", "..", "examples", "brain-ui");
    const uiIndexPath = join46(uiDir, "index.html");
    const uiIndexExists = existsSync49(uiIndexPath);
    if (!existsSync49(uiDir)) {
      log.error(
        { uiDir },
        'brain-ui directory not found \u2014 the UI will be unavailable. If running from npm, ensure "examples/" is listed in package.json "files". If running from source, check that examples/brain-ui/ exists.'
      );
    }
    const ui = { uiDir, uiIndexPath, uiIndexExists };
    const server = createServer2((req, res) => {
      applyCorsHeaders(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!checkAuth(req, res, opts.token)) return;
      const url = new URL(req.url ?? "/", `http://${bind}:${port}`);
      const rel = decodeURIComponent(url.pathname);
      try {
        enterBrain(url.searchParams.get("brainId") ?? void 0);
      } catch (err) {
        if (err instanceof BrainNotFoundError) {
          sendError(res, 404, err.message);
          return;
        }
        throw err;
      }
      if (rel === "/_api/shutdown" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        setImmediate(() => {
          server.close();
          cleanServeFiles();
        });
        return;
      }
      if (rel === "/brains/open" && req.method === "POST") {
        void handleOpenBrain(req, res);
        return;
      }
      if (rel === "/brains" && req.method === "GET") {
        handleListBrains(req, res);
        return;
      }
      if (rel === "/_api/notes") {
        handleNotes(req, res, url);
        return;
      }
      const backlinksMatch = rel.match(/^\/_api\/notes\/([^/]+)\/backlinks$/);
      if (backlinksMatch) {
        handleBacklinks(req, res, decodeURIComponent(backlinksMatch[1]));
        return;
      }
      const neighborsMatch = rel.match(/^\/_api\/notes\/([^/]+)\/neighbors$/);
      if (neighborsMatch) {
        handleNeighbors(req, res, decodeURIComponent(neighborsMatch[1]));
        return;
      }
      if (rel === "/_api/hierarchy") {
        handleHierarchy(req, res);
        return;
      }
      if (rel.startsWith("/_api/search")) {
        handleSearch(req, res, url);
        return;
      }
      if (rel.startsWith("/_api/recall")) {
        handleRecall(req, res, url);
        return;
      }
      if (rel === "/_api/global-graph") {
        handleGlobalGraph(req, res);
        return;
      }
      if (rel === "/_api/graph") {
        handleGraph(req, res, "/_api/graph");
        return;
      }
      if (rel === "/_api/graph.json") {
        handleGraph(req, res, "/_api/graph.json");
        return;
      }
      if (rel === "/_api/graph-layout.json") {
        handleGraphLayout(req, res);
        return;
      }
      const topicsMatch = rel.match(/^\/_api\/topics\/(.+)$/);
      if (topicsMatch) {
        handleTopics(req, res, decodeURIComponent(topicsMatch[1]));
        return;
      }
      if (rel === "/_api/tree") {
        handleTree(req, res);
        return;
      }
      if (rel === "/_api/synthesis/index") {
        handleSynthesisIndex(req, res);
        return;
      }
      if (rel.startsWith("/_api/synthesis/")) {
        const topic = decodeURIComponent(rel.slice("/_api/synthesis/".length));
        handleSynthesisTopic(req, res, topic);
        return;
      }
      if (rel === "/_api/resolve") {
        handleResolve(req, res, url);
        return;
      }
      const noteMetaMatch = rel.match(/^\/_api\/note-meta\/(.+)$/);
      if (noteMetaMatch) {
        handleNoteMeta(req, res, decodeURIComponent(noteMetaMatch[1]));
        return;
      }
      const noteByIdMatch = rel.match(/^\/_api\/note\/(.+)$/);
      if (noteByIdMatch) {
        handleNoteById(req, res, decodeURIComponent(noteByIdMatch[1]));
        return;
      }
      const nodeMatch = rel.match(/^\/_api\/node\/([^/]+)$/);
      if (nodeMatch) {
        handleNodeById(req, res, decodeURIComponent(nodeMatch[1]));
        return;
      }
      if (handleUiRoute(req, res, rel, ui)) return;
      handleBrainFile(req, res, rel, brainRoot());
    });
    server.listen(port, bind, () => {
      const boundPort = server.address().port;
      writeServeFiles(boundPort);
      log.info({ port: boundPort, bind, root }, "lazybrain serve listening");
      process.stdout.write(
        `LazyBrain wiki running at http://${bind}:${boundPort} \u2014 Ctrl+C to stop.
`
      );
      const embedderWarmupStart = Date.now();
      getEmbedder().then((embedder) => {
        if (embedder) {
          const ms = Date.now() - embedderWarmupStart;
          log.info({ ms }, `[serve] embedder warmed in ${ms}ms`);
        }
      }).catch(() => {
      });
      setImmediate(() => {
        try {
          const indexedNotes = listAllReadonly({ includeExpired: true });
          if (indexedNotes.length === 0) {
            const hasNoteFiles = existsSync49(notesDir()) || existsSync49(batchesDir());
            if (hasNoteFiles) {
              log.info(
                "serve: index is empty but note files exist \u2014 running incremental index update"
              );
              runIncrementalUpdate().then((result) => {
                log.info(
                  { indexed: result.indexed, failed: result.failed },
                  "serve: auto index-update complete"
                );
              }).catch((buildErr) => {
                log.warn(
                  { err: buildErr.message },
                  "serve: auto index-update failed \u2014 run `lazybrain index-rebuild` manually"
                );
              });
            }
          }
        } catch {
        }
      });
      const onExit = () => {
        cleanServeFiles();
      };
      const onSigInt = () => {
        cleanServeFiles();
        server.close();
      };
      const onSigTerm = () => {
        cleanServeFiles();
        server.close();
      };
      process.on("exit", onExit);
      process.on("SIGINT", onSigInt);
      process.on("SIGTERM", onSigTerm);
      const stopResourceMonitor = startResourceMonitor();
      server.once("close", () => {
        stopResourceMonitor();
        process.removeListener("exit", onExit);
        process.removeListener("SIGINT", onSigInt);
        process.removeListener("SIGTERM", onSigTerm);
      });
      resolveServer(server);
    });
    server.on("error", reject);
  });
}

// src/cli/register-serve.ts
function handle3(err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}
`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === "debug" && err instanceof Error) {
    process.stderr.write(`${err.stack}
`);
  }
  const code = msg.includes("Schema validation") ? 4 : msg.includes("not found") ? 5 : 1;
  process.exit(code);
}
function registerServe(program2) {
  program2.command("serve").description(
    "Local HTTP server for the brain (read-only). Use --stop to stop a running server."
  ).option("-p, --port <n>", "port", (v) => Number.parseInt(v, 10), 4242).option("--bind <host>", "bind address", "127.0.0.1").option("--token <token>", "require Bearer auth").option("--stop", "stop a running lazybrain serve instance and exit").action(async (opts) => {
    try {
      if (opts.stop) {
        const result = await stopServe();
        if (result === "no-server") {
          process.stdout.write("lazybrain serve: no running server found (no serve.port file)\n");
        } else if (result === "stopped") {
          process.stdout.write("lazybrain serve: server stopped\n");
        } else {
          process.stderr.write(`lazybrain serve --stop: ${result}
`);
          process.exit(1);
        }
        return;
      }
      await runServe(opts);
    } catch (err) {
      handle3(err);
    }
  });
  const daemon = program2.command("daemon").description("Long-running HTTP daemon for ultra-fast hook calls (claude-mem-style).");
  daemon.command("start").description("Start the daemon (foreground by default; auto-spawned from hooks).").option("--foreground", "block until shutdown (default for hook-spawned daemons)").option("-p, --port <n>", "port", (v) => Number.parseInt(v, 10), 37788).option(
    "--idle-timeout-ms <ms>",
    "auto-shutdown after this many ms idle",
    (v) => Number.parseInt(v, 10),
    30 * 60 * 1e3
  ).action(async (opts) => {
    try {
      await startDaemonForeground(opts);
    } catch (err) {
      handle3(err);
    }
  });
  daemon.command("status").description("Show daemon status (pid, port, alive).").option("--pretty").action((opts) => {
    try {
      process.stdout.write(`${runDaemonStatus(opts)}
`);
    } catch (err) {
      handle3(err);
    }
  });
  daemon.command("stop").description("Stop the daemon.").option("--pretty").action(async (opts) => {
    try {
      process.stdout.write(`${await runDaemonStop(opts)}
`);
    } catch (err) {
      handle3(err);
    }
  });
  program2.command("init").description(
    'Bootstrap a new LazyBrain brain, or install an agent integration with --agent.\n\nBrain target resolution order (highest priority first):\n  1. --brain <path>         explicit path (e.g. --brain /my/project/brain)\n  2. LAZYBRAIN_BRAIN_PATH   environment variable\n  3. $CWD/.lazybrain/brain  local project default\n\nPrints "Initialized brain at <path>" on stdout so you always know where it landed.'
  ).option("--brain <path>", "explicit brain directory path (overrides env var and cwd default)").option("--agent <name>", "install integration for an agent: vibe").option("--enable-hooks", "(vibe) set enable_experimental_hooks=true in config.toml").option("--tools", "(vibe) install the LazybrainRead spatial-recall tool").option("--explore", "(vibe) install the brain-aware explore subagent override").option("--force", "Overwrite if already initialized").option("--pretty", "Human-readable output").action(async (opts) => {
    try {
      if (opts.agent === "vibe") {
        const { runInitVibe: runInitVibe2 } = await Promise.resolve().then(() => (init_init_vibe(), init_vibe_exports));
        const report2 = await runInitVibe2({
          enableHooks: !!opts.enableHooks,
          tools: !!opts.tools,
          explore: !!opts.explore,
          pretty: !!opts.pretty
        });
        if (opts.pretty) {
          console.log(`Vibe integration installed at ${report2.vibeHome}`);
          console.log(
            `  hook: ${report2.hookInstalled} | experimental flag: ${report2.experimentalHooksEnabled}`
          );
          console.log(`  skills: ${report2.skillsInstalled.join(", ") || "none"}`);
          for (const w of report2.warnings) console.log(`  WARNING: ${w}`);
        } else {
          console.log(JSON.stringify(report2));
        }
        return;
      }
      if (opts.agent && opts.agent !== "vibe") {
        throw new Error(`Unknown agent "${opts.agent}". Supported: vibe`);
      }
      const { runInit: runInit2 } = await Promise.resolve().then(() => (init_init(), init_exports));
      const path = typeof opts.brain === "string" ? opts.brain : void 0;
      const report = await runInit2({ force: !!opts.force, pretty: !!opts.pretty, path });
      if (opts.pretty) {
        console.log("Next steps:");
        console.log("  npx lazybrain dream --enrich");
        console.log("  npx lazybrain index-rebuild");
        console.log("  npx lazybrain graph --format both");
        console.log(
          "  npx lazybrain enrich --pretty          # attach conversation decisions/bugs/ideas to each file page"
        );
        console.log("  npx lazybrain build-hierarchy --force");
        console.log("  npx lazybrain enrich-hierarchy --force");
        console.log("  npx lazybrain index-rebuild");
        console.log("  npx lazybrain serve");
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      handle3(err);
    }
  });
  program2.command("wipe").description(
    "Delete all brain notes, artifacts and cache.\n  Without --yes: prints what WOULD be deleted and exits (no deletion).\n  With --yes: performs the deletion after verifying no daemon is running.\n  After wipe the next `dream` reprocesses all conversations from scratch."
  ).option("-y, --yes", "Confirm deletion (required to actually delete anything)").option("--pretty", "Pretty output").action(async (opts) => {
    try {
      const { runWipe: runWipe2 } = await Promise.resolve().then(() => (init_wipe(), wipe_exports));
      const report = await runWipe2(opts);
      if (opts.pretty) {
        console.log(
          `Wiped: ${report.notesDeleted} notes, ${report.knowledgeNodesDeleted} hierarchy nodes, ${report.artifactsDeleted} artifacts, ${report.cacheDeleted} cache files`
        );
        console.log(
          "Conversation fingerprints reset \u2014 the next `dream` will reprocess all conversations."
        );
        if (report.errors.length > 0) console.log(`Errors: ${report.errors.join("; ")}`);
      } else {
        console.log(JSON.stringify(report));
      }
    } catch (err) {
      const code = err.code;
      if (code === "WIPE_NO_CONFIRM") {
        process.exit(1);
      }
      handle3(err);
    }
  });
  const fingerprintsCmd = program2.command("fingerprints").description("Manage the fingerprint store used for incremental dream processing.");
  fingerprintsCmd.command("stats").description("Show fingerprint store statistics.").option("--pretty", "human-readable output").action(async (opts) => {
    try {
      await printFingerprintStats(opts);
    } catch (err) {
      handle3(err);
    }
  });
  fingerprintsCmd.command("clean").description("Remove orphaned fingerprints (for files that no longer exist).").option("--pretty", "human-readable output").option("--dry-run", "show what would be removed without writing").action(async (opts) => {
    try {
      await cleanFingerprints(opts);
    } catch (err) {
      handle3(err);
    }
  });
}
async function printFingerprintStats(opts) {
  const { loadFingerprints: loadFingerprints2, getOrphanedFingerprints: getOrphanedFingerprints2 } = await Promise.resolve().then(() => (init_fingerprints(), fingerprints_exports));
  const { statSync: statSync15, existsSync: existsSync53 } = await import("node:fs");
  const store = loadFingerprints2();
  const tracked = Object.keys(store.files).length;
  const orphaned = getOrphanedFingerprints2(store).length;
  let storeSize = 0;
  try {
    const { getConfig: getConfig2 } = await Promise.resolve().then(() => (init_config(), config_exports));
    const { join: join51 } = await import("node:path");
    const { cachePath: cachePath3 } = getConfig2();
    const storePath2 = join51(cachePath3, ".fingerprints.json");
    if (existsSync53(storePath2)) {
      storeSize = statSync15(storePath2).size;
    }
  } catch {
  }
  const sizeFmt = storeSize >= 1024 ? `${(storeSize / 1024).toFixed(1)} KB` : `${storeSize} B`;
  if (opts.pretty) {
    const w = (s) => process.stdout.write(s);
    w("\n  Fingerprint Store\n");
    w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");
    w(`  Tracked files:  ${tracked}
`);
    w(`  Orphaned:       ${orphaned}
`);
    w(`  Last updated:   ${store.generatedAt}
`);
    w(`  Store size:     ${sizeFmt}
`);
    w("  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n\n");
  } else {
    process.stdout.write(
      `${JSON.stringify({
        tracked,
        orphaned,
        generatedAt: store.generatedAt,
        storeSizeBytes: storeSize
      })}
`
    );
  }
}
async function cleanFingerprints(opts) {
  const { loadFingerprints: loadFingerprints2, saveFingerprints: saveFingerprints2, getOrphanedFingerprints: getOrphanedFingerprints2 } = await Promise.resolve().then(() => (init_fingerprints(), fingerprints_exports));
  const store = loadFingerprints2();
  const orphans = getOrphanedFingerprints2(store);
  if (!opts.dryRun && orphans.length > 0) {
    const cleaned = {
      ...store,
      files: Object.fromEntries(Object.entries(store.files).filter(([k]) => !orphans.includes(k)))
    };
    saveFingerprints2(cleaned);
  }
  if (opts.pretty) {
    process.stdout.write(
      `  ${opts.dryRun ? "[dry-run] Would remove" : "Removed"} ${orphans.length} orphaned fingerprints.
`
    );
  } else {
    process.stdout.write(`${JSON.stringify({ removed: orphans.length, dryRun: !!opts.dryRun })}
`);
  }
}

// bin/lazybrain.ts
function _readPkgVersion() {
  const base = dirname16(fileURLToPath6(import.meta.url));
  for (const rel of ["../../package.json", "../package.json", "./package.json"]) {
    try {
      const raw = readFileSync45(join50(base, rel), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.name === "lazybrain" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
    }
  }
  return "unknown";
}
var _cliVersion = _readPkgVersion();
var program = new Command();
program.name("lazybrain").description("HTML-first persistent memory for LLM agents.").version(_cliVersion).option("--brain <path>", "override brain path (sets LAZYBRAIN_BRAIN_PATH_CLI)", (p) => {
  process.env.LAZYBRAIN_BRAIN_PATH_CLI = p;
  return p;
});
registerCore(program);
registerPipeline(program);
registerServe(program);
program.parseAsync(process.argv).catch(handle4);
function handle4(err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}
`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === "debug" && err instanceof Error) {
    process.stderr.write(`${err.stack}
`);
  }
  const code = msg.includes("Schema validation") ? 4 : msg.includes("not found") ? 5 : 1;
  process.exit(code);
}
