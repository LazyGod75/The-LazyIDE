/**
 * l1.ts — L1 structural retrieval level.
 *
 * CSS-selector-based lookup into the HTML note index.  Zero network cost,
 * < 5 ms per query.  Returns 1.0-scored hits on exact structural matches.
 */

import { structuralQuery } from '../../indexer/structural.js';
import type { ResolvedHit } from '../router.js';

/**
 * Run L1 structural retrieval using the CSS selector query.
 */
export async function runL1(input: {
  query: string;
  topK?: number;
}): Promise<ResolvedHit[]> {
  const hits = structuralQuery(input.query, { limit: input.topK ?? 5 });
  return hits.map((h) => ({
    id: h.noteId,
    path: h.notePath,
    score: 1.0,
    level: 'L1' as const,
    snippet: h.text.slice(0, 240),
  }));
}
