/**
 * hybrid.ts — L2_L3_HYBRID retrieval level.
 *
 * RRF fusion of FTS (BM25) and semantic (cosine) results.
 * Runs L2 and L3 in parallel, fuses via Reciprocal Rank Fusion (K=60).
 * Suitable for medium-complexity queries (5–15 tokens).
 */

import { isEmbedderUnavailable, topKCosine } from '../../indexer/embeddings.js';
import {
  type FtsHit,
  applyStructuralFieldBoost,
  getNoteById,
  listAllWithText,
  searchFts,
  searchFtsSpread,
} from '../../indexer/fts.js';
import { getLogger } from '../../util/logger.js';
import { embedQueryForRetrieval } from '../hyde.js';
import type { ResolvedHit, SearchInput } from '../router.js';
import { stripTags } from '../strip.js';
import { runL2 } from './l2.js';
import { resolveCorpusVectors } from './l3.js';

/**
 * L2_L3_HYBRID: RRF fusion of FTS (BM25) and semantic (cosine) results.
 *
 * Graceful degradation: if the ONNX embedding model is unavailable, returns
 * pure FTS results so the user still gets a response.
 */
export async function runL2L3Hybrid(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  if (isEmbedderUnavailable()) {
    getLogger().debug({ query: input.query }, 'runL2L3Hybrid: embedder unavailable, using L2 only');
    return runL2(input, topK);
  }

  const opts = {
    limit: topK * 2, // Overfetch for fusion
    includeExpired: input.includeExpired,
    type: input.type,
    tag: input.tag,
    sourcePrefix: input.sourcePrefix,
  };

  // Run L2 and L3 in parallel
  const [l2Hits, l3Hits] = await Promise.all([
    buildL2Hits(input, opts),
    buildL3Hits(input, opts, topK),
  ]);

  return fuseAndBoost(l2Hits, l3Hits, input, topK);
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

async function buildL2Hits(
  input: SearchInput,
  opts: {
    limit: number;
    includeExpired?: boolean;
    type?: string;
    tag?: string;
    sourcePrefix?: string;
  },
): Promise<Array<{ hit: FtsHit; rank: number }>> {
  const tokens = input.query.trim().split(/\s+/).filter(Boolean);
  const ftsHits: FtsHit[] =
    tokens.length >= 2 ? searchFtsSpread(input.query, opts) : searchFts(input.query, opts);
  return ftsHits.map((hit, rank) => ({ hit, rank }));
}

async function buildL3Hits(
  input: SearchInput,
  _opts: {
    limit: number;
    includeExpired?: boolean;
    type?: string;
    tag?: string;
    sourcePrefix?: string;
  },
  topK: number,
): Promise<
  Array<{
    hit: { id: string; path: string; title: string; snippet: string; bm25: number };
    rank: number;
  }>
> {
  const queryVec = await embedQueryForRetrieval(input.query);
  const corpus = listAllWithText({ includeExpired: input.includeExpired }).filter((n) => {
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
    topK * 2,
  );
  const byId = new Map(corpus.map((c) => [c.id, c]));
  return ranked
    .filter((r) => byId.has(r.id))
    .map((r, rank) => {
      const n = byId.get(r.id);
      if (!n) throw new Error('unreachable');
      return {
        hit: {
          id: r.id,
          path: n.path,
          title: n.title ?? '',
          snippet: ((n.text ?? '') || n.title || '').slice(0, 280),
          bm25: r.score,
        },
        rank,
      };
    });
}

function fuseAndBoost(
  l2Hits: Array<{ hit: FtsHit; rank: number }>,
  l3Hits: Array<{
    hit: { id: string; path: string; title: string; snippet: string; bm25: number };
    rank: number;
  }>,
  input: SearchInput,
  topK: number,
): ResolvedHit[] {
  // RRF fusion: K=60, score = 1/(K+rank_l2) + 1/(K+rank_l3)
  const RRF_K = 60;
  const fused = new Map<string, number>();
  const best = new Map<string, { id: string; path: string; snippet: string }>();

  // Add L2 contributions
  for (const { hit, rank } of l2Hits) {
    const rrfScore = 1 / (RRF_K + rank);
    fused.set(hit.id, (fused.get(hit.id) ?? 0) + rrfScore);
    if (!best.has(hit.id)) {
      best.set(hit.id, { id: hit.id, path: hit.path, snippet: stripTags(hit.snippet) });
    }
  }

  // Add L3 contributions
  for (const { hit, rank } of l3Hits) {
    const rrfScore = 1 / (RRF_K + rank);
    fused.set(hit.id, (fused.get(hit.id) ?? 0) + rrfScore);
    if (!best.has(hit.id)) {
      best.set(hit.id, { id: hit.id, path: hit.path, snippet: hit.snippet });
    }
  }

  // Sort by fused RRF score, apply structural field boost, then slice to topK
  const preFused = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
  const fusedForBoost = preFused.map(([id, score]) => {
    const hit = best.get(id)!;
    const note = getNoteById(id);
    return {
      id,
      path: hit.path,
      score,
      level: 'L2_L3_HYBRID' as const,
      snippet: hit.snippet,
      topic: note?.topic ?? null,
      tags: note?.tags ?? null,
      codeFile: note?.source?.startsWith('code-scanner:') ? (note.title ?? null) : null,
    };
  });

  const boosted = applyStructuralFieldBoost(fusedForBoost, input.query);
  return boosted.map(({ topic: _t, tags: _g, codeFile: _c, ...rest }) => rest);
}
