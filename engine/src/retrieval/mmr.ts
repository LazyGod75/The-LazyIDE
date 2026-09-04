import { cosine } from '../indexer/embeddings.js';

export interface MmrInput {
  id: string;
  vector: Float32Array;
  relevance: number; // initial relevance score to query (e.g. cosine to query)
}

/**
 * Maximum Marginal Relevance — diversify a candidate set by penalising
 * documents that are too similar to already-selected results.
 *
 * lambda = 1.0 → pure relevance (no diversity)
 * lambda = 0.0 → pure diversity (ignore relevance)
 * lambda = 0.7 → balanced (recommended default)
 */
export function mmr(candidates: MmrInput[], k: number, lambda = 0.7): string[] {
  if (candidates.length === 0) return [];
  const selected: MmrInput[] = [];
  const pool = [...candidates];

  // First pick is most relevant
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
