/**
 * embedding-store.ts — SQLite-backed note embedding CRUD.
 *
 * The note_embeddings table stores pre-computed Float32 vectors so the
 * retrieval router avoids re-running the WASM ONNX model for every query.
 * Layout: EMB_DIM * 4 bytes per note, raw little-endian floats.
 *
 * Model-versioning note: this module is intentionally model-agnostic — it
 * just stores whatever (hash, modelId) pair the caller gives it. The
 * "is this vector still valid" decision (comparing modelId against the
 * currently active embedding model) is made by the caller (l3.ts), which is
 * the only place that knows about MODEL_ID. modelId defaults to null so
 * legacy rows (inserted before this column existed) and pre-existing test
 * fixtures degrade to "unknown model" rather than crashing.
 */

import { SnapshotCache, bumpLocalWriteVersion } from './corpus-cache.js';
import { getDb } from './db.js';

const EMB_DIM = 768; // paraphrase-multilingual-mpnet-base-v2 output dimension

export interface StoredNoteEmbedding {
  id: string;
  embedTextHash: string;
  /** Embedding model id the vector was computed with, or null if unknown/legacy. */
  modelId: string | null;
  vector: Float32Array;
}

/**
 * Freshness-gated cache for loadAllStoredEmbeddings() — see corpus-cache.ts
 * for the invalidation design. Single entry per db path (the table has no
 * caller-supplied filter, unlike listAllWithText's shouldExcludeInvalidated).
 */
const embeddingsCache = new SnapshotCache<Map<string, StoredNoteEmbedding>>();

/**
 * Upsert a pre-computed embedding for a note.
 * Called by the indexer after each note is indexed (at build time).
 * embedTextHash: FNV-1a 32-bit hex of the exact text string that was embedded.
 * modelId: id of the embedding model that produced `vector` (e.g. MODEL_ID
 *   from embeddings.ts). Defaults to null for callers that don't track it —
 *   such rows are treated as stale by any model-aware staleness check.
 * vector: Float32Array(768) from the active embedding model.
 */
export function upsertNoteEmbedding(
  id: string,
  embedTextHash: string,
  vector: Float32Array,
  modelId: string | null = null,
): void {
  const db = getDb();
  // Store as raw little-endian bytes (EMB_DIM * 4 bytes = 3072 bytes per note)
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
  // Speed fix: invalidate the loadAllStoredEmbeddings() cache below — see
  // corpus-cache.ts for why same-connection writes must self-report.
  bumpLocalWriteVersion();
}

/**
 * Load all stored note embeddings in one SQLite read.
 * Returns a Map<id, StoredNoteEmbedding> for O(1) lookup per note.
 * Empty Map when no embeddings have been stored yet (triggers fallback compute).
 *
 * Gracefully handles a pre-migration-10 database: if the model_id column is
 * somehow still absent (should not happen — getDb() always runs migrations
 * first) the broad catch below degrades to an empty map rather than
 * throwing, same as the pre-existing "table may not exist yet" case.
 */
export function loadAllStoredEmbeddings(): Map<string, StoredNoteEmbedding> {
  const db = getDb();
  try {
    // Speed fix: this used to deserialize every stored 768-dim vector into a
    // FRESH Map on every call — the hot path for every L3/hybrid query (via
    // resolveCorpusVectors). Cache the resolved Map per db path; see
    // corpus-cache.ts for the invalidation contract. The whole resolve()
    // call stays inside this try so a missing table (cold DB, migrations not
    // yet applied) falls through to the same empty-map degradation as before
    // — readSnapshot()'s COUNT(*) would itself throw in that case.
    return embeddingsCache.resolve(db, 'note_embeddings', 'all', () => {
      const result = new Map<string, StoredNoteEmbedding>();
      const rows = db
        .prepare('SELECT id, embed_text_hash, vector, model_id FROM note_embeddings')
        .all() as Array<{
        id: string;
        embed_text_hash: string;
        vector: Buffer;
        model_id: string | null;
      }>;
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
          vector: vec,
        });
      }
      return result;
    });
  } catch {
    // table (or column, on a not-yet-migrated DB) may not exist yet on a cold
    // DB — return empty map, fallback to compute. Not cached (cheap, cold-only
    // path — the next call succeeds and caches normally once schema exists).
    return new Map();
  }
}

/**
 * Delete stored embedding for a note (called on deleteNote).
 */
export function deleteNoteEmbedding(id: string): void {
  try {
    getDb().prepare('DELETE FROM note_embeddings WHERE id = ?').run(id);
    bumpLocalWriteVersion();
  } catch {
    /* best-effort */
  }
}
