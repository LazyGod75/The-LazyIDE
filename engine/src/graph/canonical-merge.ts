/**
 * canonical-merge: pure function deciding where a knowledge item belongs,
 * based on its evidence distribution across neurons.
 *
 * This is the single source of truth for the "canonical home" rule.
 * No I/O, no side effects — pure computation.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One piece of evidence linking a knowledge item to a neuron. */
export interface EvidenceItem {
  /** ID of the neuron that this item is associated with. */
  neuronId: string;
  /**
   * Confidence weight that this knowledge item belongs to this neuron.
   * Typical values:
   *   - Edit/Write trace → 1.0
   *   - Text mention     → 0.85
   *   - Read trace       → 0.4
   */
  weight: number;
}

/**
 * Possible placement decisions for a knowledge item.
 * - 'section' : the item becomes a section inside a single dominant neuron.
 * - 'concept' : the item becomes a standalone CONCEPT neuron linked to all contributors.
 */
export type Placement = 'section' | 'concept';

/** Result of canonicalMerge. */
export interface CanonicalMergeResult {
  /** Where the knowledge item should live. */
  placement: Placement;
  /**
   * The target neuron ID when placement='section', null otherwise.
   * Task 5 uses this to append a <section> to the identified neuron.
   */
  neuronId: string | null;
  /**
   * The share of the dominant neuron: max(weight) / total.
   * 0 when evidence is empty or all weights are zero.
   */
  maxShare: number;
  /**
   * All contributing neuron IDs, sorted descending by weight then ascending by
   * neuronId (for deterministic tie-breaking).
   * Task 5 uses this to build <a> links in the concept neuron.
   */
  contributors: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Decide where a knowledge item belongs based on its evidence distribution.
 *
 * @param evidence - Array of neuron evidence items (weights >= 0).
 * @param threshold - Minimum share of the dominant neuron required to place
 *   the item as a 'section' inside that neuron. Default: 0.7 (70%).
 * @returns A canonical placement decision with metadata for Task 5.
 */
export function canonicalMerge(
  evidence: ReadonlyArray<EvidenceItem>,
  threshold = 0.7,
): CanonicalMergeResult {
  const EMPTY_RESULT: CanonicalMergeResult = {
    placement: 'concept',
    neuronId: null,
    maxShare: 0,
    contributors: [],
  };

  if (evidence.length === 0) {
    return EMPTY_RESULT;
  }

  const total = evidence.reduce((sum, e) => sum + e.weight, 0);

  if (total <= 0) {
    return EMPTY_RESULT;
  }

  // Sort: descending weight, then ascending neuronId for deterministic ties.
  const sorted = [...evidence].sort((a, b) => {
    const weightDiff = b.weight - a.weight;
    if (weightDiff !== 0) return weightDiff;
    return a.neuronId < b.neuronId ? -1 : a.neuronId > b.neuronId ? 1 : 0;
  });

  const contributors = sorted.map((e) => e.neuronId);
  const dominant = sorted[0];
  const maxShare = dominant.weight / total;

  if (maxShare >= threshold) {
    return {
      placement: 'section',
      neuronId: dominant.neuronId,
      maxShare,
      contributors,
    };
  }

  return {
    placement: 'concept',
    neuronId: null,
    maxShare,
    contributors,
  };
}
