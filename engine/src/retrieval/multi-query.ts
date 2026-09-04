/**
 * Q4 — RRF multi-query expansion.
 *
 * Generate N paraphrases of the user query via the Claude CLI (cached), run
 * retrieval in parallel on each, then fuse the rankings with Reciprocal Rank
 * Fusion:
 *
 *   score(doc) = Σ over queries  1 / (k + rank(doc, query))
 *
 * k = 60 by convention (Cormack et al.). Documents found by multiple variants
 * get a boost; documents found by only one stay competitive.
 *
 * Opt-in via LAZYBRAIN_MULTI_QUERY=1; uses the active Claude Code session via
 * the CLI (no separate API key required). Falls back to single-query routing
 * when disabled or when the CLI is unavailable. Paraphrases are cached
 * per-query in memory so repeated turns don't pay twice.
 */

import { callClaudeCliJsonArray, llmAvailable } from '../util/claude-cli.js';
import { getLogger } from '../util/logger.js';
import { type ResolvedHit, type RouterResult, type SearchInput, route } from './router.js';

const RRF_K = 60;
const MAX_VARIANTS = 3;
const PARAPHRASE_CACHE_MAX = 256;
const PARAPHRASE_CACHE_TTL_MS = 60 * 60_000; // 1h

interface CacheEntry {
  paraphrases: string[];
  storedAt: number;
}

const paraphraseCache = new Map<string, CacheEntry>();

function cacheGet(key: string): string[] | null {
  const e = paraphraseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.storedAt > PARAPHRASE_CACHE_TTL_MS) {
    paraphraseCache.delete(key);
    return null;
  }
  return e.paraphrases;
}

function cacheSet(key: string, paraphrases: string[]): void {
  if (paraphraseCache.size >= PARAPHRASE_CACHE_MAX) {
    const oldest = paraphraseCache.keys().next().value;
    if (oldest !== undefined) paraphraseCache.delete(oldest);
  }
  paraphraseCache.set(key, { paraphrases, storedAt: Date.now() });
}

export async function isMultiQueryEnabled(): Promise<boolean> {
  return llmAvailable('LAZYBRAIN_MULTI_QUERY');
}

/**
 * Top-level entry: returns a RouterResult whose hits.score reflects RRF
 * fusion across N paraphrases. Falls back to single-query routing when
 * paraphrase generation is unavailable.
 */
export async function routeWithRRF(input: SearchInput): Promise<RouterResult> {
  if (!(await isMultiQueryEnabled())) return route(input);

  const variants = await getParaphrases(input.query);
  if (variants.length <= 1) return route(input);

  const overfetch = (input.topK ?? 5) * 3;
  const perQuery: ResolvedHit[][] = await Promise.all(
    variants.map(async (q) => {
      try {
        const r = await route({ ...input, query: q, topK: overfetch });
        return r.hits;
      } catch (err) {
        getLogger().warn({ err: (err as Error).message, variant: q }, 'multi-query variant failed');
        return [];
      }
    }),
  );

  const fused = fuseRRF(perQuery);
  const sliced = fused.slice(0, input.topK ?? 5);
  // Pick the dominant level from the underlying runs for telemetry.
  const levels = perQuery.flatMap((hits) => hits.map((h) => h.level));
  const dominantLevel = mode(levels) ?? 'L3';
  return { hits: sliced, levelUsed: dominantLevel, totalMs: 0 };
}

function fuseRRF(perQuery: ResolvedHit[][]): ResolvedHit[] {
  const merged = new Map<string, ResolvedHit>();
  const scores = new Map<string, number>();
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

function mode<T>(arr: readonly T[]): T | null {
  if (arr.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

const PARAPHRASE_PROMPT = `Rewrite the user's search query as ${MAX_VARIANTS - 1} short paraphrases for retrieval over a software-engineering memory.
Each paraphrase must:
- preserve all named entities (lib names, file paths, error strings) verbatim
- vary the verbs and connectives (synonyms, voice, syntactic order)
- be 3-20 words, no quotes, no question marks

Output ONLY a JSON array of strings, no prose. Example: ["why postgres slow", "performance regression on postgresql"].`;

async function getParaphrases(query: string): Promise<string[]> {
  const key = query.trim().toLowerCase();
  const cached = cacheGet(key);
  if (cached) return [query, ...cached];

  const arr = await callClaudeCliJsonArray<string>(query, {
    system: PARAPHRASE_PROMPT,
    model: 'haiku',
    timeoutMs: 15_000,
  });
  if (!arr) return [query];

  const paraphrases = arr
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && s.length <= 200)
    .slice(0, MAX_VARIANTS - 1);
  if (paraphrases.length === 0) return [query];
  cacheSet(key, paraphrases);
  return [query, ...paraphrases];
}
