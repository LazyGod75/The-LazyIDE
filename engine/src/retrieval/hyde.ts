/**
 * Q8 — HyDE (Hypothetical Document Embeddings).
 *
 * For fuzzy / underspecified queries, embedding the raw query loses signal
 * (the query and a relevant note speak different vocabularies). HyDE instead
 * asks an LLM to hallucinate a plausible memory-style answer, then embeds
 * that hallucination. The embedding space is now "answer space", much closer
 * to the actual notes.
 *
 * Original paper: Gao et al., "Precise Zero-Shot Dense Retrieval without
 * Relevance Labels", ACL 2023.
 *
 * Opt-in via LAZYBRAIN_HYDE=1. Uses the active Claude Code session via the
 * CLI (no separate API key required). Bypassed when:
 *   - query is a CSS selector
 *   - query is short (≤ 4 words) — keyword retrieval handles those
 *   - query contains digits / hashes / file paths — HyDE drifts on those
 */

import { embedOne } from '../indexer/embeddings.js';
import { callClaudeCli, llmAvailable } from '../util/claude-cli.js';
import { getLogger } from '../util/logger.js';

const HYDE_CACHE_MAX = 256;
const HYDE_CACHE_TTL_MS = 60 * 60_000;

interface HydeCacheEntry {
  vector: Float32Array;
  storedAt: number;
}

const hydeCache = new Map<string, HydeCacheEntry>();

function cacheGet(key: string): Float32Array | null {
  const e = hydeCache.get(key);
  if (!e) return null;
  if (Date.now() - e.storedAt > HYDE_CACHE_TTL_MS) {
    hydeCache.delete(key);
    return null;
  }
  return e.vector;
}

function cacheSet(key: string, vector: Float32Array): void {
  if (hydeCache.size >= HYDE_CACHE_MAX) {
    const oldest = hydeCache.keys().next().value;
    if (oldest !== undefined) hydeCache.delete(oldest);
  }
  hydeCache.set(key, { vector, storedAt: Date.now() });
}

/** Diagnostics only (see server/resource-monitor.ts) — current resident cache size and cap. */
export function hydeCacheStats(): { entries: number; maxEntries: number } {
  return { entries: hydeCache.size, maxEntries: HYDE_CACHE_MAX };
}

export async function isHydeEnabled(): Promise<boolean> {
  return llmAvailable('LAZYBRAIN_HYDE');
}

/**
 * Auto-trigger heuristic: always returns false.
 *
 * HyDE auto-trigger has been disabled because spawning `claude --print` from a
 * subprocess hangs / times-out (12 s per call) when the query path is
 * synchronous, making every L3/L2_L3_HYBRID query catastrophically slow
 * (measured: 90–440 s on a real brain).
 *
 * To opt in to HyDE, set LAZYBRAIN_HYDE=1 explicitly. The explicit path is
 * preserved and still works; it is just never triggered automatically.
 *
 * @returns always false
 */
export async function shouldAutoHyde(_query: string): Promise<boolean> {
  return false;
}

function shouldSkipHyde(query: string): boolean {
  const q = query.trim();
  if (q.length === 0) return true;
  // CSS selector → L1, no need for fuzz
  if (/^[a-z*]+(\[|#|\.|:)/i.test(q) || q.startsWith('[')) return true;
  // Short queries: keyword retrieval is fine, HyDE adds latency + drift risk
  const wordCount = q.split(/\s+/).filter((w) => w.length > 1).length;
  if (wordCount <= 4) return true;
  // Numeric / identifier-heavy: HyDE drifts away from the literal token.
  if (/^\s*#[a-z0-9-]{4,}/i.test(q)) return true;
  return false;
}

/**
 * Embed a query: returns a HyDE-derived vector when applicable, falls back to
 * a plain query embedding otherwise.
 *
 * HyDE fires when either:
 *   1. LAZYBRAIN_HYDE=1 is set (explicit opt-in), OR
 *   2. The auto-heuristic decides the query is a good semantic-gap candidate.
 *
 * In both cases shouldSkipHyde() can still veto (CSS selectors, very short
 * queries, hash-heavy identifiers).
 */
export async function embedQueryForRetrieval(query: string): Promise<Float32Array> {
  if (shouldSkipHyde(query)) {
    return embedOne(query);
  }

  const explicitlyEnabled = await isHydeEnabled();
  const autoEnabled = explicitlyEnabled ? false : await shouldAutoHyde(query);

  if (!explicitlyEnabled && !autoEnabled) {
    return embedOne(query);
  }

  const log = getLogger();
  log.debug(
    { query: query.slice(0, 80), trigger: explicitlyEnabled ? 'explicit' : 'auto' },
    '[HyDE] triggered',
  );

  const cacheKey = query.trim().toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) {
    log.debug({ query: query.slice(0, 80) }, '[HyDE] cache hit');
    return cached;
  }

  const doc = await generateHydeDoc(query);
  if (!doc) {
    log.debug({ query: query.slice(0, 80) }, '[HyDE] generation failed, falling back');
    return embedOne(query);
  }

  log.debug({ query: query.slice(0, 80), docLen: doc.length }, '[HyDE] generated');
  const vec = await embedOne(doc);
  cacheSet(cacheKey, vec);
  return vec;
}

const HYDE_SYSTEM = `You write a short fictional memory note that hypothetically answers the user's search query.
Write 3-5 sentences. Concrete vocabulary: include the named entities, library names, error strings, decisions that a real note on this topic would mention.
Do NOT speculate or invent facts that aren't strongly implied by the query.
Output ONLY the note body. No prose, no preamble, no quotes.`;

async function generateHydeDoc(query: string): Promise<string | null> {
  const raw = await callClaudeCli(query, {
    system: HYDE_SYSTEM,
    model: 'haiku',
    timeoutMs: 12_000,
  });
  if (!raw) return null;
  const clean = raw.trim();
  if (clean.length < 20) return null;
  return clean.slice(0, 1500); // bge-base safe budget
}
