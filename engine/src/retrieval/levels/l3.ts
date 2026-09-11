/**
 * l3.ts — L3 bi-encoder semantic retrieval level.
 *
 * Uses paraphrase-multilingual-mpnet-base-v2 (WASM ONNX) to compute cosine similarity between
 * the query and all indexed notes.  Latency: ~150 ms.  Cost: $0 (local).
 * Falls back to L2 when the ONNX model fails to load.
 */

// resolveCorpusVectors moved to indexer/embed-index.ts so index-time callers
// (index-rebuild, incremental update, graph code-scan) can share the exact
// same batched/cache-aware embedding path used here at query time, without
// an indexer -> retrieval -> indexer import cycle. Re-exported below so
// existing importers (hybrid.ts) are unaffected.
import { resolveCorpusVectors } from '../../indexer/embed-index.js';
import { isEmbedderUnavailable, topKCosine } from '../../indexer/embeddings.js';
import { listAllWithText } from '../../indexer/fts.js';
import { getLogger } from '../../util/logger.js';
import { embedQueryForRetrieval } from '../hyde.js';
import type { ResolvedHit, SearchInput } from '../router.js';
import { runL2 } from './l2.js';

export { resolveCorpusVectors } from '../../indexer/embed-index.js';

// ---------------------------------------------------------------------------
// L3 retrieval
// ---------------------------------------------------------------------------

/**
 * Run L3 bi-encoder semantic retrieval.
 * Graceful degradation: falls back to L2 when the ONNX model is unavailable.
 */
export async function runL3(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  if (isEmbedderUnavailable()) {
    getLogger().debug({ query: input.query }, 'runL3: embedder unavailable, falling back to L2');
    return runL2(input, topK);
  }

  // Q8: HyDE — when enabled and the query benefits from expansion, embed a
  // hallucinated "memory note" instead of the raw query. Falls back to a
  // plain embedOne(query) when HyDE is disabled or skipped.
  const queryVec = await embedQueryForRetrieval(input.query);

  // B1: fetch corpus WITH text so embeddings reflect facts, not just title+tags.
  // When hard invalidation is enabled, filter out invalidated notes BEFORE scoring
  // to prevent contamination from affecting cosine similarity rankings.
  const hardInvalidate = process.env.LAZYBRAIN_HARD_INVALIDATE === '1';
  const corpus = listAllWithText({
    includeExpired: input.includeExpired,
    excludeInvalidated: hardInvalidate,
  }).filter((n) => {
    if (input.sourcePrefix && !(n.source ?? '').startsWith(input.sourcePrefix)) return false;
    if (input.type && n.type !== input.type) return false;
    if (input.tag && !(n.tags ?? '').includes(input.tag)) return false;
    return true;
  });

  // Speed fix: use SQLite-cached vectors — only embeds query (1 vector).
  const vectors = await resolveCorpusVectors(corpus);
  const ranked = topKCosine(
    queryVec,
    corpus.map((c, i) => ({ id: c.id, vector: vectors[i] })),
    topK * 2, // overfetch for potential L4 re-rank
  );
  const byId = new Map(corpus.map((c) => [c.id, c]));
  return ranked
    .filter((r) => byId.has(r.id))
    .slice(0, topK)
    .map((r) => {
      const n = byId.get(r.id);
      if (!n) throw new Error('unreachable');
      return {
        id: r.id,
        path: n.path,
        score: r.score,
        level: 'L3' as const,
        // B3-friendly: snippet reflects content, not just title — MMR uses it.
        snippet: ((n.text ?? '') || n.title || '').slice(0, 280),
      };
    });
}
