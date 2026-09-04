/**
 * Wikipedia-style quality classification for brain notes.
 *
 * Mirrors the stub/start/good/featured taxonomy from the spec (brain-leviers-v2.md §Levier 3).
 *
 * Thresholds:
 *   stub:     1 fact OR mean confidence < 0.5
 *   start:    2-3 facts, confidence 0.5-0.7 (default)
 *   good:     4+ facts, confidence > 0.7, has at least 1 relation
 *   featured: good + access_count > 5 + ≥ 2 inbound wikilinks
 */

export type Quality = 'stub' | 'start' | 'good' | 'featured';

export interface QualityInput {
  factCount: number;
  meanConfidence: number;
  accessCount: number;
  inboundWikilinks: number;
  hasRelations: boolean;
}

/**
 * Classify a note's quality level. Returns a new Quality value — no mutation.
 */
export function noteQuality(n: QualityInput): Quality {
  // stub: only one fact or very low confidence
  if (n.factCount <= 1 || n.meanConfidence < 0.5) return 'stub';

  // featured: good conditions met plus access and inbound link thresholds
  const isGoodBase = n.factCount >= 4 && n.meanConfidence > 0.7 && n.hasRelations;

  if (isGoodBase && n.accessCount > 5 && n.inboundWikilinks >= 2) {
    return 'featured';
  }

  // good: high fact count, high confidence, has relations
  if (isGoodBase) return 'good';

  // start: everything else (2-3 facts with decent confidence)
  return 'start';
}
