import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';

// Exported so callers that persist vectors elsewhere (note_embeddings SQLite
// table, see l3.ts/embedding-store.ts) can tag rows with the model that
// produced them — the basis of the cache-versioning scheme below.
export const MODEL_ID = 'Xenova/paraphrase-multilingual-mpnet-base-v2';
const DIM = 768; // paraphrase-multilingual-mpnet-base-v2 output dimension (same as bge-base)

// Memory fix: max texts handed to a single embedder() forward pass.
//
// The OUTPUT tensor ([N, DIM]) is not the constraint — that's ~196KB even at
// N=64. The real cost is the onnxruntime-node CPU arena used DURING the
// forward pass: the tokenizer pads every text in a batch to the batch's
// longest sequence (padding: true, see FeatureExtractionPipeline._call in
// @huggingface/transformers), and self-attention activations scale with
// batch x seq_len^2 x num_heads per layer, not with N x DIM. That arena also
// never shrinks back down for the lifetime of the process (it is sized to
// its high-water mark and reused, not freed) — reproduced empirically with a
// throwaway probe script (batches of 200 real notes, up to the
// EMBED_CHAR_LIMIT of 1800 chars each): batch=64 peaked at ~5.2GB RSS,
// batch=16 at ~1.48GB, batch=8 at ~1.24GB and stayed flat for 25 consecutive
// batches at that size (the peak is a function of batch SHAPE, not corpus
// size — running more batches of the same size does not grow it further).
// 8 keeps a full 586-note rebuild comfortably under the ~1.5GB target while
// costing nothing in throughput (smaller batches pad less-dissimilar text
// lengths together, so wall-clock time per note is roughly unchanged).
const EMBED_BATCH_SIZE = 8;

// Magic bytes at the start of a versioned embeddings.bin file ("LBC2" ascii).
// Presence gates whether the file carries a model-id header (see loadCache).
// A legacy (pre-versioning) file's first 4 bytes are a raw entry-count u32,
// which would have to equal ~860,046,600 to collide with this magic — not
// realistic for an actual note count, so this is a safe, cheap format check.
const CACHE_MAGIC = Buffer.from('LBC2', 'ascii');

let pipe: FeatureExtractionPipeline | null = null;
// In-flight load, memoized separately from the resolved `pipe`. Without this,
// two calls to getEmbedder() that both land before the first pipeline() load
// resolves (e.g. the serve.ts boot warmup racing the user's first recall)
// each start their own ~283MB ONNX pipeline() load — double allocation and
// double CPU during the exact cold-start window this is meant to avoid.
// Concurrent callers now await the SAME promise; see getEmbedder() below.
let pipePromise: Promise<FeatureExtractionPipeline | null> | null = null;
let cache: Map<string, Float32Array> | null = null;
let cachePath: string | null = null;
/** Set to true after the first load failure so the warning is logged only once. */
let embedderUnavailable = false;

// Memory fix (P41 — sidecar RSS growth, observed 726MB->3.7GB over 3h
// near-idle and +2.4GB in 30min under load).
//
// `cache` is keyed by exact-text hash, not note id, so it captures every
// text ever handed to embed() for the life of the process — including every
// one-off QUERY (and HyDE-hallucinated document) embedded via embedOne(),
// see retrieval/hyde.ts and retrieval/rankers.ts. Note text is bounded by
// corpus size and already has a durable, note-id-keyed cache in SQLite (the
// note_embeddings table, see embedding-store.ts) that resolveCorpusVectors()
// checks BEFORE ever calling embed() — so this map's only real job for notes
// is a same-call dedup. Query text, by contrast, is natural language that
// essentially never repeats verbatim, so every query permanently grew this
// Map with an entry that would never again be read. Worse, saveCache()
// serializes the WHOLE map on every miss, so the write cost of a single
// query scaled with the total historical unique-text count, not corpus size.
//
// Capped with the same FIFO-eviction pattern hyde.ts's hydeCache already
// uses: Map preserves insertion order, so the oldest entries are dropped
// first once the cap is exceeded. Sized well above realistic corpus counts
// (thousands of notes) so legitimate note-embedding reuse is unaffected —
// eviction only engages once one-off query noise accumulates.
const MAX_CACHE_ENTRIES = 20_000;

/** Drop the oldest entries (Map insertion order) until at or under the cap. */
function capCache(map: Map<string, Float32Array>): void {
  const overflow = map.size - MAX_CACHE_ENTRIES;
  if (overflow <= 0) return;
  const it = map.keys();
  for (let i = 0; i < overflow; i++) {
    const next = it.next();
    if (next.done) break;
    map.delete(next.value);
  }
}

/** Diagnostics only (see server/resource-monitor.ts) — current resident cache size and cap. */
export function embeddingCacheStats(): { entries: number; maxEntries: number } {
  return { entries: cache?.size ?? 0, maxEntries: MAX_CACHE_ENTRIES };
}

env.allowLocalModels = true;
// Remote download policy — three states:
//
//   LAZYBRAIN_ALLOW_REMOTE_MODELS=1   → downloads allowed (existing behaviour)
//   LAZYBRAIN_ALLOW_REMOTE_MODELS=0   → downloads forbidden (sovereign/airgap mode)
//   LAZYBRAIN_ALLOW_REMOTE_MODELS     → unset (new default): downloads are NOT attempted
//                                        during queries. If the model is already in the
//                                        local cache it is used normally (offline). If it
//                                        is absent, the embedder reports unavailable so the
//                                        L3→L2 fallback kicks in and a one-time hint is
//                                        printed to stderr.
//
// The download-models script always sets allowRemoteModels=true before loading
// (it IS the explicit user consent); that happens inside the script itself.
const _allowRemoteEnv = process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
// Opt-in flag: true only when explicitly set to '1'
const _remoteAllowed = _allowRemoteEnv === '1';
// When env is unset we still allow LOCAL models; remote is blocked by default.
env.allowRemoteModels = _remoteAllowed;

/**
 * Determine whether a remote download would be triggered for a given model.
 *
 * Returns true when all of the following hold:
 *  - allowRemote is true (env === '1')
 *  - the expected local model directory does not exist or is empty
 *
 * Extracted as a pure function so it can be unit-tested without a live model.
 */
export function willTriggerRemoteDownload(
  modelsPath: string,
  modelId: string,
  allowRemote: boolean,
): boolean {
  if (!allowRemote) return false;
  return !isModelCached(modelsPath, modelId);
}

/**
 * Returns true when the ONNX model directory already exists in the local cache.
 * Used to distinguish "absent, would download" from "absent, opt-in needed".
 *
 * Transformers.js stores models in two possible layouts depending on version:
 *   - Flat:   <cacheDir>/Xenova--model-name/           (old style, replace / with --)
 *   - Nested: <cacheDir>/Xenova/model-name/            (new style, mirrors HF repo path)
 * Both are checked so the correct result is returned regardless of which layout was used.
 */
export function isModelCached(modelsPath: string, modelId: string): boolean {
  const flatDir = join(modelsPath, modelId.replace('/', '--'));
  const nestedDir = join(modelsPath, modelId); // e.g. <cacheDir>/Xenova/model-name
  try {
    return existsSync(flatDir) || existsSync(nestedDir);
  } catch {
    return false;
  }
}

/**
 * Print a one-time consent notice to stderr before a remote model download
 * (env === '1' path).
 * Never writes to stdout (JSON consumers). Never prints on subsequent runs.
 */
export function printDownloadNotice(modelId: string, cacheDir: string): void {
  process.stderr.write(
    `LazyBrain: downloading ${modelId} (~290 MB) to ${cacheDir} — first semantic-search use only. Set LAZYBRAIN_ALLOW_REMOTE_MODELS=0 to forbid downloads.\n`,
  );
}

/**
 * Print a one-time opt-in hint to stderr when the model is absent and
 * LAZYBRAIN_ALLOW_REMOTE_MODELS is unset (new default).
 * Never writes to stdout (JSON consumers). Never prints on subsequent runs.
 */
export function printOptInHint(cacheDir: string): void {
  process.stderr.write(
    `LazyBrain: Semantic search (L3/L4) needs local ONNX models (~380 MB). Run \`npm run download-models\` once, or set LAZYBRAIN_ALLOW_REMOTE_MODELS=1 to allow on-demand download. Models would be stored in ${cacheDir}. Falling back to keyword search (L2).\n`,
  );
}

/** Tracks which models have already had their notice printed in this process. */
const noticePrinted = new Set<string>();

/**
 * Real kill switch for LAZYBRAIN_EMBEDDINGS. This env var is set at every
 * Rust sidecar/CLI spawn site (src-tauri/src/commands/brain/*.rs) but was
 * never read anywhere in the engine — a dead flag. '0' or 'false'
 * (case-sensitive, matching LAZYBRAIN_ALLOW_REMOTE_MODELS's own '0'/'1'
 * convention above) now disables semantic search/rerank entirely; any other
 * value (including unset, the current hardcoded '1') leaves existing
 * behavior untouched.
 */
export function isEmbeddingsDisabledByEnv(): boolean {
  const v = process.env.LAZYBRAIN_EMBEDDINGS;
  return v === '0' || v === 'false';
}

/**
 * Load the feature-extraction pipeline.
 *
 * Returns `null` (instead of throwing) when the ONNX models are absent or
 * fail to load — callers must handle the null case and degrade gracefully
 * (e.g. fall back to FTS/L2 search).  The warning is logged only once to
 * avoid flooding the log on every query.
 *
 * Three env states:
 *   '1'   → downloads allowed; print download notice before fetching.
 *   '0'   → downloads forbidden; if model absent → null (silent degradation).
 *   unset → downloads NOT attempted; if model cached → use it; if absent →
 *           print one-time opt-in hint and return null.
 *
 * Concurrency: the resolved pipeline is cached in `pipe`, but a cold-start
 * caller (e.g. the serve.ts boot warmup) can race a second caller (e.g. the
 * user's first recall) that both arrive before the first pipeline() load
 * resolves. To avoid each of them starting an independent ~283MB ONNX load,
 * the in-flight promise itself is memoized in `pipePromise` — every caller
 * that arrives while a load is already underway awaits that SAME promise
 * instead of calling pipeline() again. If the load fails with an error that
 * escapes the try/catch below (e.g. getConfig() throwing), `pipePromise` is
 * reset so the next call retries rather than replaying a cached rejection
 * forever.
 */
export async function getEmbedder(): Promise<FeatureExtractionPipeline | null> {
  if (pipe) return pipe;
  if (embedderUnavailable) return null;
  if (!pipePromise) {
    pipePromise = loadEmbedder().catch((err: unknown) => {
      pipePromise = null;
      throw err;
    });
  }
  return pipePromise;
}

/**
 * Resolve the feature-extraction pipeline: config/env policy setup followed
 * by the actual pipeline() load. Split out of getEmbedder() purely so the
 * promise it returns can be memoized in `pipePromise` — see getEmbedder()
 * for the concurrency contract. Behavior (env states, fallback, logging) is
 * unchanged from before that split.
 */
async function loadEmbedder(): Promise<FeatureExtractionPipeline | null> {
  if (isEmbeddingsDisabledByEnv()) {
    // Real kill switch: behave exactly like the "model absent, no opt-in"
    // degraded path below (embedderUnavailable + one-time stderr notice +
    // null) — same graceful L3->L2 fallback, just triggered by explicit
    // user choice instead of a missing model directory.
    embedderUnavailable = true;
    if (!noticePrinted.has(MODEL_ID)) {
      process.stderr.write(
        'LazyBrain: semantic search (L3/L4) disabled via LAZYBRAIN_EMBEDDINGS=0 — using keyword search (L2) only.\n',
      );
      noticePrinted.add(MODEL_ID);
    }
    return null;
  }

  const cfg = getConfig();
  env.localModelPath = cfg.modelsPath;
  env.cacheDir = cfg.modelsPath;

  const envVal = process.env.LAZYBRAIN_ALLOW_REMOTE_MODELS;
  const remoteAllowed = envVal === '1';
  const remoteExplicitlyForbidden = envVal === '0';
  const remoteUnset = envVal === undefined || envVal === '';

  // When env is unset: block downloads but allow cached models.
  // We need to set allowRemoteModels before pipeline() is called.
  if (remoteUnset) {
    const cached = isModelCached(cfg.modelsPath, MODEL_ID);
    if (!cached) {
      // Model absent and downloads not opted-in — degrade to L2.
      embedderUnavailable = true;
      if (!noticePrinted.has(MODEL_ID)) {
        printOptInHint(cfg.modelsPath);
        noticePrinted.add(MODEL_ID);
      }
      return null;
    }
    // Model is cached locally — use it (no download needed).
    env.allowRemoteModels = false;
  } else if (remoteAllowed) {
    env.allowRemoteModels = true;
    // Print download notice only if a download would actually occur.
    if (!noticePrinted.has(MODEL_ID) && willTriggerRemoteDownload(cfg.modelsPath, MODEL_ID, true)) {
      printDownloadNotice(MODEL_ID, cfg.modelsPath);
      noticePrinted.add(MODEL_ID);
    }
  } else if (remoteExplicitlyForbidden) {
    env.allowRemoteModels = false;
    // If model is absent and downloads are forbidden, degrade silently.
    if (!isModelCached(cfg.modelsPath, MODEL_ID)) {
      embedderUnavailable = true;
      return null;
    }
  }

  try {
    pipe = (await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
    })) as unknown as FeatureExtractionPipeline;
    return pipe;
  } catch (err) {
    embedderUnavailable = true;
    getLogger().warn(
      { err: (err as Error).message, modelsPath: cfg.modelsPath },
      'lazybrain: ONNX embedding model unavailable — L3/L4 search will fall back to FTS (L2). ' +
        'Run `npm run download-models` to enable semantic search.',
    );
    return null;
  }
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const log = getLogger();
  const cacheMap = loadCache();
  const start = Date.now();
  const result: Float32Array[] = new Array(texts.length);
  const todo: { idx: number; text: string; key: string }[] = [];

  let hits = 0;
  for (let i = 0; i < texts.length; i++) {
    const key = hashKey(texts[i]);
    const cached = cacheMap.get(key);
    if (cached) {
      result[i] = cached;
      hits += 1;
    } else {
      todo.push({ idx: i, text: texts[i], key });
    }
  }

  if (todo.length > 0) {
    const embedder = await getEmbedder();
    if (!embedder) {
      // Model unavailable: fill missing slots with zero vectors so callers that
      // rely on embed() for optional features (e.g. MMR diversity) degrade
      // gracefully rather than crashing.
      for (const { idx } of todo) {
        result[idx] = new Float32Array(DIM);
      }
    } else {
      // Memory/speed fix: chunk the `todo` list into EMBED_BATCH_SIZE-sized
      // pieces instead of handing the WHOLE list to embedder() in one call —
      // a fresh project scan / full rebuild can miss thousands of chunks at
      // once. The constraint is NOT the [todo.length, DIM] output tensor
      // (trivially small); it's the onnxruntime-node CPU arena used DURING
      // the forward pass, which scales with batch x seq_len^2 (self
      // attention) and is sized to its high-water mark for the life of the
      // process (see EMBED_BATCH_SIZE doc comment above for measurements).
      // Each chunk is still a single native inference pass over up to
      // EMBED_BATCH_SIZE texts (not todo.length sequential round-trips), so
      // this keeps the original "batch beats one-at-a-time" perf win while
      // bounding the arena's peak size. Output order and caching semantics
      // are unchanged: every result still lands at its original `todo`
      // index, and every computed vector is still cached.
      for (let start = 0; start < todo.length; start += EMBED_BATCH_SIZE) {
        const chunk = todo.slice(start, start + EMBED_BATCH_SIZE);
        const batchTexts = chunk.map((t) => t.text);
        const tensor = await embedder(batchTexts, { pooling: 'mean', normalize: true });
        const flat = tensor.data as Float32Array;
        for (let i = 0; i < chunk.length; i++) {
          const { idx, key } = chunk[i];
          // Tensor is row-major [chunk.length, DIM]; slice() copies so each
          // cached vector owns its own buffer (no aliasing into `flat`).
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
  log.debug({ texts: texts.length, todo: todo.length, hits, duration_ms: duration }, 'embed batch');
  logTelemetry({
    event: 'embed',
    ts: nowIso(),
    texts: texts.length,
    duration_ms: duration,
    cache_hit: hits,
    cache_miss: todo.length,
  });
  return result;
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embed([text]);
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  // Vectors are already L2-normalized → dot product = cosine
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export interface VectorHit {
  id: string;
  score: number; // cosine similarity in [-1, 1]
}

export function topKCosine(
  query: Float32Array,
  corpus: { id: string; vector: Float32Array }[],
  k: number,
): VectorHit[] {
  const heap: VectorHit[] = [];
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

export function hashKey(text: string): string {
  // FNV-1a 32-bit, fast and stable
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/**
 * Load the on-disk vector cache.
 *
 * Format (versioned, "LBC2"):
 *   [4 bytes magic "LBC2"] [u16 modelIdLen] [modelId utf8 bytes]
 *   [u32 count] [for each: u8 keyLen, keyBytes, DIM * f32 LE]
 *
 * Model versioning: the header records which embedding model produced the
 * vectors that follow. On load:
 *   - magic absent            -> pre-versioning legacy file (no model info
 *                                 at all). Cannot verify safety -> discard.
 *   - magic present, modelId
 *     != current MODEL_ID     -> file predates a model switch. Every vector
 *                                 in it is unsafe (same dim, wrong semantic
 *                                 space) -> discard without parsing entries.
 *   - modelId == MODEL_ID     -> trust and parse entries as before.
 *
 * "Discard" means: log once, return an empty map, and let embed() repopulate
 * it lazily on cache miss. The stale file itself is only overwritten the
 * next time saveCache() runs (opportunistic prune) — nothing eagerly deletes
 * it, but it is never read from again after MODEL_ID changes back.
 *
 * Any parse error (truncated/corrupt file) is caught by the existing
 * try/catch below and degrades to an empty cache with a warning, same as
 * before this change.
 */
function loadCache(): Map<string, Float32Array> {
  if (cache) return cache;
  const cfg = getConfig();
  cachePath = join(cfg.cachePath, 'embeddings.bin');
  cache = new Map();
  if (existsSync(cachePath)) {
    try {
      const buf = readFileSync(cachePath);
      let offset = 0;

      const hasMagic =
        buf.length >= CACHE_MAGIC.length && buf.subarray(0, CACHE_MAGIC.length).equals(CACHE_MAGIC);
      if (!hasMagic) {
        getLogger().info(
          { modelId: MODEL_ID },
          'embedding cache invalidated: pre-versioning legacy cache (no model info) — re-embedding lazily on demand',
        );
        return cache;
      }
      offset += CACHE_MAGIC.length;

      const modelIdLen = buf.readUInt16LE(offset);
      offset += 2;
      const storedModelId = buf.subarray(offset, offset + modelIdLen).toString('utf8');
      offset += modelIdLen;

      if (storedModelId !== MODEL_ID) {
        getLogger().info(
          { previousModelId: storedModelId, modelId: MODEL_ID },
          'embedding cache invalidated: embedding model changed — re-embedding lazily on demand',
        );
        return cache;
      }

      // Format: [u32 count] [for each: u8 keyLen, keyBytes, DIM * f32 LE]
      const count = buf.readUInt32LE(offset);
      offset += 4;
      for (let i = 0; i < count; i++) {
        const keyLen = buf.readUInt8(offset);
        offset += 1;
        const key = buf.subarray(offset, offset + keyLen).toString('utf8');
        offset += keyLen;
        const vec = new Float32Array(DIM);
        for (let j = 0; j < DIM; j++) {
          vec[j] = buf.readFloatLE(offset);
          offset += 4;
        }
        cache.set(key, vec);
      }
      // Trim a pre-fix on-disk cache that already grew past the cap (see
      // MAX_CACHE_ENTRIES above) — recovers an already-bloated embeddings.bin
      // instead of only capping growth from this point forward.
      capCache(cache);
    } catch (err) {
      getLogger().warn({ err: (err as Error).message }, 'corrupt embedding cache, ignoring');
      cache = new Map();
    }
  }
  return cache;
}

function saveCache(map: Map<string, Float32Array>): void {
  if (!cachePath) return;
  const modelIdBytes = Buffer.from(MODEL_ID, 'utf8');
  // Header: magic (4) + modelIdLen (u16) + modelId bytes + count (u32)
  let size = CACHE_MAGIC.length + 2 + modelIdBytes.length + 4;
  for (const [k] of map) size += 1 + Buffer.byteLength(k, 'utf8') + DIM * 4;
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
    const keyBytes = Buffer.from(key, 'utf8');
    buf.writeUInt8(keyBytes.length, offset);
    offset += 1;
    keyBytes.copy(buf, offset);
    offset += keyBytes.length;
    for (let j = 0; j < DIM; j++) {
      buf.writeFloatLE(vec[j] ?? 0, offset);
      offset += 4;
    }
  }
  writeFileSync(cachePath, buf);
}

export function resetEmbedderForTests(): void {
  pipe = null;
  pipePromise = null;
  cache = null;
  cachePath = null;
  embedderUnavailable = false;
  noticePrinted.clear();
}

/**
 * Returns true when the embedding model has already failed to load.
 * Callers can use this to skip the L3 path without triggering another
 * load attempt (which would also fail and produce the warning again).
 */
export function isEmbedderUnavailable(): boolean {
  return embedderUnavailable;
}

/** Force the "model unavailable" state for unit tests that exercise L3→L2 fallback. */
export function forceEmbedderUnavailableForTests(): void {
  pipe = null;
  pipePromise = null;
  embedderUnavailable = true;
}
