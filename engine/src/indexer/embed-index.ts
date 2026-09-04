/**
 * embed-index.ts — batched, cache-aware corpus embedding.
 *
 * Single source of truth for turning a note (id/title/tags/text) into a
 * persisted vector in note_embeddings, shared by two callers:
 *
 *   - retrieval/levels/l3.ts (QUERY time, lazy): resolveCorpusVectors() is
 *     called on every L3/hybrid search, re-embedding only notes whose cached
 *     hash/model no longer match.
 *   - indexer/note-index.ts, commands/index-update.ts, commands/graph.ts
 *     (INDEX time, eager): embedNotesForIndex() calls the SAME
 *     resolveCorpusVectors() right after notes are written + FTS-indexed, so
 *     note_embeddings is already populated before any query ever runs —
 *     that is the fix for the "0 rows in note_embeddings after
 *     graph/index-rebuild" defect (embeddings used to be computed ONLY
 *     lazily from the query path).
 *
 * Living in the indexer layer (not retrieval/) lets index-time callers use
 * this without an indexer -> retrieval -> indexer import cycle. l3.ts
 * re-exports resolveCorpusVectors so existing importers (hybrid.ts) are
 * unaffected.
 */

import { getLogger } from '../util/logger.js';
import { MODEL_ID, embed, getEmbedder, hashKey } from './embeddings.js';
import { loadAllStoredEmbeddings, upsertNoteEmbedding } from './embedding-store.js';

const EMBED_CHAR_LIMIT = 1800;

/** Minimal note shape needed to build the text that gets embedded. */
export interface EmbeddableNote {
  id: string;
  title?: string | null;
  tags?: string | null;
  text?: string | null;
}

export function buildEmbedText(n: { title?: string | null; tags?: string | null; text?: string | null }): string {
  const title = (n.title ?? '').trim();
  const tags = (n.tags ?? '').trim();
  const body = (n.text ?? '').slice(0, EMBED_CHAR_LIMIT).trim();
  return [title, tags, body].filter(Boolean).join('\n');
}

/**
 * Resolve corpus vectors: prefer the SQLite-cached embedding for each note
 * (keyed by embed_text_hash == FNV-1a of buildEmbedText output, AND scoped to
 * the embedding model that produced it — see model_id column).
 * Only notes with a stale, model-mismatched, or missing cache entry are
 * re-embedded with the WASM model — and those are then immediately stored
 * back (tagged with the current MODEL_ID) for future queries.
 *
 * Model-swap recovery: when MODEL_ID changes (e.g. bge-base -> mpnet), every
 * stored row's modelId stops matching, so every note is treated as missing
 * on the first query/rebuild after the swap and gets transparently
 * re-embedded with the new model. No stale vector is ever served across a
 * model change — this is the fix for the cross-model cosine-similarity bug.
 *
 * Typical hot-path cost: 1 SQLite SELECT + 1 WASM embedOne(query) ≈ 50–200ms.
 * Cold path (first run after index rebuild, or first run after a model
 * swap): embeds all missing notes once, then stores them — subsequent
 * queries pay only the hot-path cost.
 */
export async function resolveCorpusVectors(
  corpus: ReadonlyArray<{ id: string; title?: string | null; tags?: string | null; text?: string | null }>,
): Promise<Float32Array[]> {
  const stored = loadAllStoredEmbeddings();
  const vectors: Float32Array[] = new Array(corpus.length);
  const missing: Array<{ idx: number; id: string; text: string; hash: string }> = [];
  let modelMismatches = 0;

  for (let i = 0; i < corpus.length; i++) {
    const n = corpus[i];
    const embedText = buildEmbedText(n) || 'untitled';
    const hash = hashKey(embedText);
    const cached = stored.get(n.id);
    if (cached && cached.embedTextHash === hash && cached.modelId === MODEL_ID) {
      vectors[i] = cached.vector;
    } else {
      if (cached && cached.modelId !== MODEL_ID) modelMismatches += 1;
      missing.push({ idx: i, id: n.id, text: embedText, hash });
    }
  }

  // Cheap, self-limiting detection: only fires while stale rows remain. Once
  // this batch re-embeds and upserts them under the current MODEL_ID, the
  // condition naturally stops triggering on subsequent calls (no dedup flag
  // needed — the persisted state itself is the guard).
  if (modelMismatches > 0) {
    getLogger().info(
      { modelMismatches, corpusSize: corpus.length, modelId: MODEL_ID },
      'embedding cache invalidated: stored vectors do not match current embedding model — re-embedding lazily on demand',
    );
  }

  if (missing.length > 0) {
    const log = getLogger();
    log.debug(
      { missing: missing.length, total: corpus.length },
      'resolveCorpusVectors: computing missing embeddings',
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

export interface EmbedIndexPassResult {
  /** Notes handed to the embedding pass (cache-hit notes cost ~nothing; see debug log for the hit/miss split). */
  considered: number;
  /** True when the embedding model could not be loaded — the whole pass was a no-op; keyword search is unaffected. */
  unavailable: boolean;
}

const NOOP_RESULT: EmbedIndexPassResult = { considered: 0, unavailable: false };

/**
 * Eager, batched, cache-aware embedding pass for notes that were JUST
 * written + FTS-indexed (index-rebuild, incremental update, graph code
 * scan). This is what makes note_embeddings non-empty at index time instead
 * of only ever being populated lazily on a user's first L3/hybrid query.
 *
 * Design notes:
 *  - Batched: all notes needing embedding funnel through ONE
 *    resolveCorpusVectors() call, which in turn makes ONE embed() call for
 *    the whole missing set — a single WASM pipeline pass, not N round-trips.
 *  - Cache-aware: resolveCorpusVectors() only recomputes notes whose content
 *    hash (or embedding model) changed since the last time they were
 *    embedded, so re-running this on an unchanged note set costs one SQLite
 *    read and zero WASM calls.
 *  - Resilient: checks getEmbedder() BEFORE doing any work. This is a
 *    positive availability check (not the isEmbedderUnavailable() flag,
 *    which starts false and only flips after a load has actually been
 *    attempted) — it guarantees that if the model is genuinely unavailable,
 *    we skip cleanly instead of letting embed()'s zero-vector fallback get
 *    persisted to SQLite as if it were a real embedding (which would
 *    poison the cache: a zero vector tagged with the current MODEL_ID would
 *    look "fresh" forever). The whole pass is additionally wrapped in
 *    try/catch: FTS indexing has already succeeded by the time this runs
 *    (see call sites), and an embedding failure must never take that down —
 *    keyword search always keeps working.
 */
export async function embedNotesForIndex(notes: ReadonlyArray<EmbeddableNote>): Promise<EmbedIndexPassResult> {
  if (notes.length === 0) return NOOP_RESULT;

  const log = getLogger();
  try {
    const embedder = await getEmbedder();
    if (!embedder) {
      log.debug(
        { notes: notes.length },
        'embedNotesForIndex: embedding model unavailable — index-time embedding skipped (keyword search still works)',
      );
      return { considered: 0, unavailable: true };
    }

    await resolveCorpusVectors(notes);
    log.debug({ notes: notes.length }, 'embedNotesForIndex: corpus vectors resolved');
    return { considered: notes.length, unavailable: false };
  } catch (err) {
    log.warn(
      { err: (err as Error).message, notes: notes.length },
      'embedNotesForIndex: embedding pass failed — continuing without embeddings for this batch (keyword search unaffected)',
    );
    return { considered: 0, unavailable: true };
  }
}
