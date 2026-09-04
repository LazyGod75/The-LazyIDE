/* brainCitations.ts — D13 graft (c): captures REAL brain recall results onto
   a mission at launch time.

   runtime.ts already calls getPlatform().brain.recall() once per mission
   launch (for plan compilation — compilePlan's brainAdapted input, see the
   'brain-recall' launch phase). This module only maps that ALREADY-FETCHED
   result onto the Mission-facing brainCitations/tokensSaved fields — no
   extra recall call, no extra latency, no new failure mode. Pure and
   side-effect-free: never fabricates data, returns an honest empty result
   when the recall found nothing or was skipped (soft-fail on brain-recall
   is by design — see runtime.ts's 'brain-recall' phase).
*/

import type { BrainCitation } from './types.js';
import type { BrainRecallResult } from '../platform/types.js';
import { formatTokenCountShort } from './tokenFormat.js';

const MAX_CITATIONS = 6;

export interface CapturedBrainContext {
  citations: BrainCitation[];
  /** Short human-readable label, e.g. "~1.2k tokens économisés" — undefined
   *  when the recall reported no savings (honest empty, not "0"). */
  tokensSavedLabel?: string;
}

/**
 * Map a real BrainRecallResult onto the Mission-facing shapes. Returns an
 * empty result (no citations, no label) when `recall` is absent (brain-
 * recall phase failed/timed out — see runtime.ts) or found no nodes.
 */
export function captureBrainContext(recall: BrainRecallResult | null | undefined): CapturedBrainContext {
  if (!recall || recall.nodes.length === 0) {
    return { citations: [] };
  }

  const citations: BrainCitation[] = recall.nodes.slice(0, MAX_CITATIONS).map((node) => ({
    id: node.id,
    label: node.title || node.id,
  }));

  const tokensSavedLabel = recall.tokensSaved > 0
    ? `~${formatTokenCountShort(recall.tokensSaved)} tokens économisés`
    : undefined;

  return { citations, tokensSavedLabel };
}
