/* promotionPipeline.ts — Curated promotion pipeline (spec §11).

   Unlike the automatic root trunk promotion in consolidation.ts (T3.3),
   the curated pipeline adds a review gate: candidate neurons are collected,
   scored, and must pass a quality filter before being promoted to the
   root trunk.

   Pipeline stages:
   1. Collect: gather candidate neurons from project brains via scoped search
   2. Score: rank candidates by relevance, recency, and tag quality
   3. Review: filter by score threshold and dedup against existing root trunk
   4. Promote: capture approved candidates into the root trunk

   The pipeline can run autonomously (auto-approve above threshold) or
   in manual mode (candidates queued for human review).
*/

import { getPlatform } from '../platform/index.js';
import type { CaptureEvent, BrainSearchResult } from '../platform/types.js';
import { emitBuffered } from '../journal/journal.js';
import { getEntitlements } from '../entitlements/unifiedEntitlement.js';

// ── Types ───────────────────────────────────────────────────────────

export type PromotionStage = 'collect' | 'score' | 'review' | 'promote';

export interface PromotionCandidate {
  neuron: BrainSearchResult;
  sourceProject: string;
  score: number;
  rank: number;
  approved: boolean;
  rejectionReason?: string;
}

export interface PromotionPipelineResult {
  candidates: PromotionCandidate[];
  promoted: number;
  rejected: number;
  errors: string[];
}

export interface PromotionConfig {
  scoreThreshold: number;
  maxCandidates: number;
  autoApprove: boolean;
  dedupAgainstRoot: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_SCORE_THRESHOLD = 0.65;
const DEFAULT_MAX_CANDIDATES = 20;

export const DEFAULT_PROMOTION_CONFIG: PromotionConfig = {
  scoreThreshold: DEFAULT_SCORE_THRESHOLD,
  maxCandidates: DEFAULT_MAX_CANDIDATES,
  autoApprove: true,
  dedupAgainstRoot: true,
};

// ── Scoring ─────────────────────────────────────────────────────────

/**
 * Score a candidate neuron for promotion eligibility.
 *
 * Combines:
 * - Base relevance score from brain search (0-1)
 * - Tag quality bonus: neurons with 'decision' or 'learning' tags get a boost
 * - Recency is not available from search results, so we rely on the
 *   search engine's own ranking which already factors this in
 */
function scoreCandidate(neuron: BrainSearchResult): number {
  let score = neuron.score;

  // Boost decision-type neurons (high reuse value)
  if (neuron.snippet.toLowerCase().includes('decision')) {
    score += 0.1;
  }

  // Boost learning-type neurons (consolidated knowledge)
  if (neuron.snippet.toLowerCase().includes('learning') || neuron.snippet.toLowerCase().includes('mission complete')) {
    score += 0.05;
  }

  // Boost neurons with success patterns
  if (neuron.snippet.toLowerCase().includes('success') || neuron.snippet.toLowerCase().includes('pattern')) {
    score += 0.05;
  }

  return Math.min(score, 1.0);
}

// ── Dedup check ─────────────────────────────────────────────────────

/**
 * Check if a candidate already exists in the root trunk by title similarity.
 * Returns true if a duplicate is found (candidate should be skipped).
 */
async function isDuplicateInRootTrunk(title: string): Promise<boolean> {
  try {
    const platform = getPlatform();
    const results = await platform.brain.search(title, 5);
    return results.some(
      (r) => r.title.toLowerCase() === title.toLowerCase() && r.score > 0.8,
    );
  } catch {
    return false;
  }
}

// ── Pipeline ────────────────────────────────────────────────────────

/**
 * Run the curated promotion pipeline.
 *
 * 1. Collect candidates via scoped search across all project brains
 * 2. Score and rank them
 * 3. Filter by threshold + dedup
 * 4. Promote approved candidates to the root trunk
 */
export async function runPromotionPipeline(
  config: PromotionConfig = DEFAULT_PROMOTION_CONFIG,
): Promise<PromotionPipelineResult> {
  const errors: string[] = [];
  const candidates: PromotionCandidate[] = [];

  // Gate: only Pro+ users can run the promotion pipeline
  const ents = getEntitlements();
  if (!ents.features.canUseRootTrunk) {
    return {
      candidates: [],
      promoted: 0,
      rejected: 0,
      errors: ['Promotion pipeline requires a Pro+ plan'],
    };
  }

  // Stage 1: Collect — search across all project brains for high-value neurons
  try {
    const platform = getPlatform();
    const searchQueries = [
      'decision architecture pattern',
      'success solution resolved',
      'learning outcome best practice',
    ];

    const allHits: BrainSearchResult[] = [];
    for (const query of searchQueries) {
      try {
        const hits = await platform.brain.searchScoped(query, 'all', config.maxCandidates);
        allHits.push(...hits);
      } catch {
        // Individual query failures are non-fatal
      }
    }

    // Stage 2: Score — rank candidates
    const scored = allHits.map((neuron) => ({
      neuron,
      sourceProject: neuron.sourceProject ?? 'unknown',
      score: scoreCandidate(neuron),
      rank: 0,
      approved: false,
      rejectionReason: undefined as string | undefined,
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Assign ranks and filter by threshold
    for (let i = 0; i < scored.length && i < config.maxCandidates; i++) {
      scored[i].rank = i + 1;

      if (scored[i].score < config.scoreThreshold) {
        scored[i].approved = false;
        scored[i].rejectionReason = 'below threshold';
        continue;
      }

      // Stage 3: Review — dedup check
      if (config.dedupAgainstRoot) {
        const isDup = await isDuplicateInRootTrunk(scored[i].neuron.title);
        if (isDup) {
          scored[i].approved = false;
          scored[i].rejectionReason = 'duplicate in root trunk';
          continue;
        }
      }

      // Auto-approve or queue for manual review
      scored[i].approved = config.autoApprove;
    }

    candidates.push(...scored);

    // Emit review event for each candidate
    for (const candidate of candidates) {
      emitBuffered({
        tsMs: Date.now(),
        projectId: candidate.sourceProject,
        actor: 'system',
        type: 'brain.promoted',
        payload: {
          neuronId: candidate.neuron.id,
          scope: candidate.approved ? 'org' : 'project',
        },
      });
    }
  } catch (err) {
    errors.push(`Collection failed: ${err}`);
  }

  // Stage 4: Promote — capture approved candidates into root trunk
  let promoted = 0;
  let rejected = 0;

  for (const candidate of candidates) {
    if (!candidate.approved) {
      rejected++;
      continue;
    }

    try {
      const event: CaptureEvent = {
        kind: 'learning',
        title: candidate.neuron.title.slice(0, 80),
        text: `Promoted from: ${candidate.sourceProject}\nScore: ${candidate.score.toFixed(2)}\n\n${candidate.neuron.snippet.slice(0, 500)}`,
        tags: ['promoted', 'curated', 'root-trunk', candidate.sourceProject],
        source: 'lazy-ide:promotion-pipeline',
      };

      await getPlatform().brain.capture(event);
      promoted++;
    } catch (err) {
      errors.push(`Failed to promote ${candidate.neuron.id}: ${err}`);
      rejected++;
    }
  }

  return { candidates, promoted, rejected, errors };
}

/**
 * Get pending candidates for manual review (when autoApprove is false).
 * Returns candidates that passed the score threshold but haven't been
 * approved yet.
 */
export function getPendingCandidates(
  candidates: PromotionCandidate[],
): PromotionCandidate[] {
  return candidates.filter(
    (c) => !c.approved && !c.rejectionReason,
  );
}

/**
 * Manually approve a candidate that was queued for review.
 * Returns the updated candidate.
 */
export function approveCandidate(candidate: PromotionCandidate): PromotionCandidate {
  return { ...candidate, approved: true, rejectionReason: undefined };
}

/**
 * Manually reject a candidate with a reason.
 */
export function rejectCandidate(
  candidate: PromotionCandidate,
  reason: string,
): PromotionCandidate {
  return { ...candidate, approved: false, rejectionReason: reason };
}
