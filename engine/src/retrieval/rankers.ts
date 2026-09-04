/**
 * rankers.ts — Re-ranking helpers for the retrieval router.
 *
 * Owns: PageRank blending, invalidation penalty, version boost,
 *       temporal boost, warning boost, MMR application.
 *
 * All functions return NEW arrays — no mutation of input arrays.
 * Extracted from router.ts for size reduction.
 */

import { computePageRank, notesForCwd, recentNotes } from '../graph/pagerank.js';
import { embed, embedOne } from '../indexer/embeddings.js';
import {
  getNoteById,
  getNoteText,
  listAllWithText,
  notesMentioningEntity,
} from '../indexer/fts.js';
import {
  countAlphanumericWords,
  isAgentMetaText,
  isBuildOutputNoise,
  isShellDiagnosticDump,
} from '../sources/noise.js';
import type { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { type MmrInput, mmr } from './mmr.js';
import type { ResolvedHit } from './router-types.js';

// ---------------------------------------------------------------------------
// Noise penalty (recall-time demotion of low-signal episodic notes)
// ---------------------------------------------------------------------------

/** Score multiplier applied to notes identified as retrieval-time noise. */
const NOISE_PENALTY_FACTOR = 0.25;

/**
 * Demote notes that are identified as low-signal noise at recall time.
 *
 * A note is penalized when it matches ANY of the following:
 *   - isBuildOutputNoise: CI/build exit-code dumps or numbered step dumps
 *   - isAgentMetaText: agent scaffolding, harness boilerplate, prompt residue
 *   - isShellDiagnosticDump: banner-delimited shell/JSON diagnostic output with
 *     no substantive prose (captured stdout of a diagnostic command)
 *   - type=episodic AND very short content (< 12 alphanumeric words) AND low
 *     importance (< 0.2) — catches "session log" captures with no real content
 *
 * The gate deliberately avoids penalizing episodic notes solely for being
 * episodic — only noise-heuristic hits get the penalty.  Genuine episodic
 * facts (decisions narrated in conversation, error root-causes) pass through
 * unless they also match a noise heuristic.
 *
 * Returns a new sorted array — no mutation of input.
 */
export function applyNoisePenalty(hits: ResolvedHit[]): ResolvedHit[] {
  let penalized = 0;

  const adjusted = hits.map((h) => {
    const text = getNoteText(h.id);
    const row = getNoteById(h.id);

    const isBuildNoise = isBuildOutputNoise(text);
    const isMetaNoise = isAgentMetaText(text);
    const isShellDump = isShellDiagnosticDump(text);

    const isEpisodicShortLowImportance =
      row?.type === 'episodic' &&
      countAlphanumericWords(text) < 12 &&
      (row.importance == null || row.importance < 0.2);

    if (isBuildNoise || isMetaNoise || isShellDump || isEpisodicShortLowImportance) {
      penalized++;
      return { ...h, score: h.score * NOISE_PENALTY_FACTOR };
    }

    return { ...h };
  });

  if (penalized > 0) {
    logTelemetry({ event: 'rerank_noise_penalty', ts: nowIso(), penalized });
  }

  return [...adjusted].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// PageRank blending
// ---------------------------------------------------------------------------

export function applyPageRank(
  hits: ResolvedHit[],
  cwd: string | undefined,
  weight: number,
  entityKeys: readonly string[] = [],
): ResolvedHit[] {
  // Build PR seeds: cwd-matched notes + 7-day recent + current hits + entity-1-hop.
  // Speed fix: applyPageRank() only runs for finalLevel L3/L4 (see router.ts),
  // and both of those already called listAllWithText({includeExpired:false})
  // moments earlier in this same query (runL3 in levels/l3.ts) — reusing the
  // WithText variant here hits that warm cache instead of running a second,
  // redundant `SELECT * FROM notes`. Only `.id`/`.created` are read below, so
  // the extra `.text` field this variant carries is unused but harmless.
  const all = listAllWithText({ includeExpired: false });
  const cwdSeeds = notesForCwd(cwd);
  const recent = recentNotes(all, 7);
  const entitySeeds = buildEntitySeeds(entityKeys);
  const seeds = [...new Set([...cwdSeeds, ...recent, ...entitySeeds, ...hits.map((h) => h.id)])];
  const entitySig = entityKeys.length ? `:ent:${[...entityKeys].sort().join(',')}` : '';
  const cacheKey = `${cwd ? `cwd:${cwd}` : 'recent'}${entitySig}`;
  const pr = computePageRank({ seeds, cacheKey });
  if (!pr.scores || Object.keys(pr.scores).length === 0) return hits;

  // Normalise the original hit scores to [0,1] for blending
  const max = Math.max(...hits.map((h) => h.score), 1e-9);
  const min = Math.min(...hits.map((h) => h.score), 0);
  const range = Math.max(1e-9, max - min);

  // Immutable: return a new array of new hit objects — never mutate the input.
  return hits
    .map((h) => {
      const base = (h.score - min) / range;
      const prScore = pr.scores[h.id] ?? 0;
      return { ...h, score: base * (1 - weight) + prScore * weight };
    })
    .sort((a, b) => b.score - a.score);
}

function buildEntitySeeds(entityKeys: readonly string[]): string[] {
  if (entityKeys.length === 0) return [];
  const seeds: string[] = [];
  for (const key of entityKeys) {
    for (const n of notesMentioningEntity(key, 8)) seeds.push(n.id);
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// Invalidation penalty
// ---------------------------------------------------------------------------

/**
 * Soft-penalize or hard-drop notes whose valid_until is set (invalidated).
 * Boost notes that actively replace an older note (replaces set, not invalidated).
 * Returns a new sorted array — no mutation of the input.
 */
export function applyInvalidationPenalty(
  hits: ResolvedHit[],
  log: ReturnType<typeof getLogger>,
): ResolvedHit[] {
  const hardInvalidate = process.env.LAZYBRAIN_HARD_INVALIDATE === '1';
  let penalized = 0;
  let boosted = 0;

  const adjusted = hits.flatMap((h) => {
    const row = getNoteById(h.id);
    if (!row) return [h];

    const isInvalidated = !!(row.valid_until && row.valid_until.trim().length > 0);
    const isReplacement = !!(row.replaces && row.replaces.trim().length > 0) && !isInvalidated;

    if (isInvalidated) {
      if (hardInvalidate) {
        penalized++;
        return []; // drop entirely
      }
      penalized++;
      return [{ ...h, score: h.score * 0.15 }];
    }

    if (isReplacement) {
      boosted++;
      return [{ ...h, score: h.score * 1.4 }];
    }

    return [h];
  });

  if (penalized > 0 || boosted > 0) {
    logTelemetry({
      event: 'rerank_invalidation',
      ts: nowIso(),
      penalized,
      boosted,
      hard: hardInvalidate,
    });
    log.debug({ penalized, boosted, hard: hardInvalidate }, 'rerank_invalidation');
  }

  return [...adjusted].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Version and temporal boosts
// ---------------------------------------------------------------------------

/** Remove older-version notes from hit list when a newer sibling is also present. */
export function dropObviousSuperseded(hits: ResolvedHit[]): ResolvedHit[] {
  const replacedNoteIds = new Set<string>();

  for (const h of hits) {
    const row = getNoteById(h.id);
    if (!row) continue;
    if (row.replaces && row.replaces.trim().length > 0) {
      replacedNoteIds.add(row.replaces);
    }
  }

  return hits.filter((h) => {
    const row = getNoteById(h.id);
    if (!row) return true;
    const isExpired = !!(row.valid_until && row.valid_until.trim().length > 0);
    const isSuperseded = replacedNoteIds.has(h.id);
    return !isExpired && !isSuperseded;
  });
}

/** Prefer earlier notes when the query asks about original / first outcomes. */
export function applyTemporalEarlierBoost(hits: ResolvedHit[]): ResolvedHit[] {
  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    const text = getNoteText(h.id).toLowerCase();
    const failed = /\b(failed|error|401|assertionerror|exception)\b/i.test(text);
    const created = row?.created ? new Date(row.created).getTime() : Date.now();
    let score = h.score;
    if (failed) score *= 1.6;
    return { ...h, score, _ts: created };
  });
  return [...adjusted].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
    return (a as ResolvedHit & { _ts: number })._ts - (b as ResolvedHit & { _ts: number })._ts;
  });
}

/** Boost notes that explicitly mark themselves as the current/active version. */
export function applyCurrentVersionBoost(hits: ResolvedHit[]): ResolvedHit[] {
  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row) return h;

    let score = h.score;

    // Active replacement (replaces set, not expired)
    const isReplacement = !!row.replaces?.trim() && !row.valid_until;
    if (isReplacement) {
      score *= 1.6;
    }

    // Expired note (has valid_until)
    const isExpired = !!row.valid_until?.trim();
    if (isExpired) {
      score *= 0.5;
    }

    return { ...h, score };
  });

  return [...adjusted].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Warning boost
// ---------------------------------------------------------------------------

export function applyWarningBoost(hits: ResolvedHit[], query: string): ResolvedHit[] {
  const queryTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const adjusted = hits.map((h) => {
    const row = getNoteById(h.id);
    if (!row?.warnings) return h;
    const warningText = row.warnings.toLowerCase();
    const hasMatch = queryTokens.some((token) => warningText.includes(token));
    if (hasMatch) {
      return { ...h, score: h.score * 1.8 };
    }
    return h;
  });

  return [...adjusted].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance)
// ---------------------------------------------------------------------------

export async function applyMmr(
  hits: ResolvedHit[],
  query: string,
  k: number,
  lambda: number,
): Promise<ResolvedHit[]> {
  const queryVec = await embedOne(query);
  const texts = hits.map((h) => h.snippet ?? '');
  const vectors = await embed(texts);
  const inputs: MmrInput[] = hits.map((h, i) => ({
    id: h.id,
    vector: vectors[i],
    relevance: h.score,
  }));
  // queryVec used implicitly through h.score (already cosine to query for L3+)
  void queryVec;
  const order = mmr(inputs, k, lambda);
  const byId = new Map(hits.map((h) => [h.id, h]));
  return order.map((id) => byId.get(id)).filter((h): h is ResolvedHit => Boolean(h));
}
