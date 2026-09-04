/**
 * l4.ts — L4 cross-encoder re-ranking level.
 *
 * Retrieves top-50 candidates from L3, then applies ms-marco WASM reranking.
 * Latency: L3 latency + ~50 ms.  Cost: $0 (local).  Quality: SOTA on hard queries.
 */

import { getNoteById, getNoteText } from '../../indexer/fts.js';
import { type RerankInput, rerank } from '../../indexer/reranker.js';
import type { ResolvedHit, SearchInput } from '../router.js';
import { runL3 } from './l3.js';

const RERANK_CHAR_LIMIT = 1500;

/**
 * Run L4 cross-encoder re-ranking on top of L3 results.
 */
export async function runL4(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  // Get top 50 from L3
  const l3 = await runL3({ ...input, topK: 50 }, 50);
  if (l3.length === 0) return l3;

  // B2: rerank against full body (truncated), not just title+tags.
  const candidates = buildRerankCandidates(l3);
  const reranked = await rerank(input.query, candidates, topK);

  const byId = new Map(l3.map((h) => [h.id, h]));
  return reranked.map((r) => {
    const base = byId.get(r.id);
    if (!base) throw new Error('unreachable');
    return { ...base, score: r.score, level: 'L4' as const };
  });
}

function buildRerankCandidates(hits: ResolvedHit[]): RerankInput[] {
  const candidates: RerankInput[] = [];
  for (const hit of hits) {
    const n = getNoteById(hit.id);
    if (!n) continue;
    const title = typeof n.title === 'string' ? n.title : '';
    const tags = typeof n.tags === 'string' ? n.tags : '';
    const body = getNoteText(hit.id).slice(0, RERANK_CHAR_LIMIT);
    const text = [title, tags, body].filter(Boolean).join('\n').trim();
    if (text.length === 0) continue;
    candidates.push({ id: hit.id, text });
  }
  return candidates;
}
