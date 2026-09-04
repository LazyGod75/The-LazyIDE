/**
 * l2.ts — L2 FTS/BM25 retrieval level.
 *
 * Lexical full-text search with structural field boost applied.
 * Latency: < 30 ms.  Cost: $0.  Recall: high on keyword queries.
 */

import {
  type FtsHit,
  applyStructuralFieldBoost,
  getNoteById,
  searchFts,
  searchFtsSpread,
} from '../../indexer/fts.js';
import type { ResolvedHit, SearchInput } from '../router.js';
import { stripTags } from '../strip.js';

/**
 * Build the FTS hits array with structural field boost applied.
 * Notes whose topic or data-code-file exactly contains a query token are
 * boosted above free-text body matches.
 */
export async function runL2(input: SearchInput, topK: number): Promise<ResolvedHit[]> {
  const opts = {
    limit: topK,
    includeExpired: input.includeExpired,
    type: input.type,
    tag: input.tag,
    sourcePrefix: input.sourcePrefix,
  };
  // Use spread activation for multi-word queries; fall back to plain FTS for single tokens.
  const tokens = input.query.trim().split(/\s+/).filter(Boolean);
  const ftsHits: FtsHit[] =
    tokens.length >= 2 ? searchFtsSpread(input.query, opts) : searchFts(input.query, opts);

  // Build initial hits, then apply structural field boost (Item 2).
  const rawHits = ftsHits.map((h) => {
    const note = getNoteById(h.id);
    return {
      id: h.id,
      path: h.path,
      score: h.bm25,
      level: 'L2' as const,
      snippet: stripTags(h.snippet),
      topic: note?.topic ?? null,
      tags: note?.tags ?? null,
      codeFile: note?.source?.startsWith('code-scanner:') ? (note.title ?? null) : null,
    };
  });

  const boosted = applyStructuralFieldBoost(rawHits, input.query);
  return boosted.map(({ topic: _t, tags: _g, codeFile: _c, ...rest }) => rest);
}
