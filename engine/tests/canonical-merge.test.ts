/**
 * TDD tests for Task 4.1: canonical-merge decision logic.
 *
 * canonicalMerge(evidence, threshold?) returns the placement of a knowledge item:
 * - 'section': belongs inside a single neuron (dominant neuron >= threshold share)
 * - 'concept': standalone CONCEPT neuron linked to all contributors
 */

import { describe, expect, it } from 'vitest';
import { canonicalMerge } from '../src/graph/canonical-merge.js';
import type { CanonicalMergeResult, EvidenceItem } from '../src/graph/canonical-merge.js';

// ---------------------------------------------------------------------------
// Empty / trivial cases
// ---------------------------------------------------------------------------

describe('canonicalMerge — empty evidence', () => {
  it('empty array → placement=concept, neuronId=null', () => {
    const result = canonicalMerge([]);
    expect(result.placement).toBe('concept');
    expect(result.neuronId).toBeNull();
  });

  it('empty array → maxShare = 0', () => {
    const result = canonicalMerge([]);
    expect(result.maxShare).toBe(0);
  });

  it('empty array → contributors is empty', () => {
    const result = canonicalMerge([]);
    expect(result.contributors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Single neuron
// ---------------------------------------------------------------------------

describe('canonicalMerge — single neuron', () => {
  it('single neuron with any weight → placement=section (maxShare=1.0)', () => {
    const evidence: EvidenceItem[] = [{ neuronId: 'file:src/auth.ts', weight: 1.0 }];
    const result = canonicalMerge(evidence);
    expect(result.placement).toBe('section');
    expect(result.neuronId).toBe('file:src/auth.ts');
    expect(result.maxShare).toBe(1);
  });

  it('single neuron with small weight → still section (sole contributor)', () => {
    const evidence: EvidenceItem[] = [{ neuronId: 'file:src/index.ts', weight: 0.1 }];
    const result = canonicalMerge(evidence);
    expect(result.placement).toBe('section');
    expect(result.neuronId).toBe('file:src/index.ts');
  });

  it('single neuron → contributors has that neuronId', () => {
    const evidence: EvidenceItem[] = [{ neuronId: 'file:src/auth.ts', weight: 0.5 }];
    const result = canonicalMerge(evidence);
    expect(result.contributors).toEqual(['file:src/auth.ts']);
  });
});

// ---------------------------------------------------------------------------
// Dominant neuron >= threshold
// ---------------------------------------------------------------------------

describe('canonicalMerge — dominant neuron (>= threshold)', () => {
  it('70% share on one neuron (threshold=0.7) → placement=section', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.7 },
      { neuronId: 'file:src/utils.ts', weight: 0.3 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.placement).toBe('section');
    expect(result.neuronId).toBe('file:src/auth.ts');
  });

  it('80% share → placement=section with correct neuronId', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.8 },
      { neuronId: 'file:src/utils.ts', weight: 0.1 },
      { neuronId: 'file:src/index.ts', weight: 0.1 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.placement).toBe('section');
    expect(result.neuronId).toBe('file:src/auth.ts');
  });

  it('dominant neuron returns correct maxShare', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.8 },
      { neuronId: 'file:src/utils.ts', weight: 0.2 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.maxShare).toBeCloseTo(0.8);
  });

  it('contributors sorted descending by weight', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/utils.ts', weight: 0.1 },
      { neuronId: 'file:src/auth.ts', weight: 0.8 },
      { neuronId: 'file:src/index.ts', weight: 0.1 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.contributors[0]).toBe('file:src/auth.ts');
  });
});

// ---------------------------------------------------------------------------
// Spread across neurons → concept
// ---------------------------------------------------------------------------

describe('canonicalMerge — spread evidence (concept placement)', () => {
  it('3 neurons with equal weights → placement=concept', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 1 },
      { neuronId: 'file:src/utils.ts', weight: 1 },
      { neuronId: 'file:src/index.ts', weight: 1 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.placement).toBe('concept');
    expect(result.neuronId).toBeNull();
  });

  it('2 neurons split 60/40 below default threshold → concept', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.6 },
      { neuronId: 'file:src/utils.ts', weight: 0.4 },
    ];
    const result = canonicalMerge(evidence); // default threshold = 0.7
    expect(result.placement).toBe('concept');
    expect(result.neuronId).toBeNull();
  });

  it('spread → contributors includes all contributing neuronIds', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 1 },
      { neuronId: 'file:src/utils.ts', weight: 1 },
      { neuronId: 'file:src/index.ts', weight: 1 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.contributors).toContain('file:src/auth.ts');
    expect(result.contributors).toContain('file:src/utils.ts');
    expect(result.contributors).toContain('file:src/index.ts');
  });

  it('spread → maxShare = 1/3 approximately', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 1 },
      { neuronId: 'file:src/utils.ts', weight: 1 },
      { neuronId: 'file:src/index.ts', weight: 1 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.maxShare).toBeCloseTo(1 / 3);
  });
});

// ---------------------------------------------------------------------------
// Exact threshold boundary
// ---------------------------------------------------------------------------

describe('canonicalMerge — exact threshold boundary', () => {
  it('maxShare exactly equals threshold → placement=section (>= is inclusive)', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.7 },
      { neuronId: 'file:src/utils.ts', weight: 0.3 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.placement).toBe('section');
  });

  it('maxShare just below threshold (0.699) → placement=concept', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.699 },
      { neuronId: 'file:src/utils.ts', weight: 0.301 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.placement).toBe('concept');
  });

  it('custom threshold=0.5: 60% share → section', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.6 },
      { neuronId: 'file:src/utils.ts', weight: 0.4 },
    ];
    const result = canonicalMerge(evidence, 0.5);
    expect(result.placement).toBe('section');
    expect(result.neuronId).toBe('file:src/auth.ts');
  });

  it('custom threshold=0.9: 80% share → concept', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0.8 },
      { neuronId: 'file:src/utils.ts', weight: 0.2 },
    ];
    const result = canonicalMerge(evidence, 0.9);
    expect(result.placement).toBe('concept');
  });
});

// ---------------------------------------------------------------------------
// Tie determinism
// ---------------------------------------------------------------------------

describe('canonicalMerge — tie determinism', () => {
  it('equal-weight tie: winner is the lexicographically first neuronId', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/z-utils.ts', weight: 1 },
      { neuronId: 'file:src/a-auth.ts', weight: 1 },
    ];
    // 50% share each — below 0.7 threshold → concept; but contributors[0] is the tie-winner
    const result = canonicalMerge(evidence, 0.7);
    // Tie-winner is lexicographically first: file:src/a-auth.ts
    expect(result.contributors[0]).toBe('file:src/a-auth.ts');
  });

  it('same weight, different ids: contributors order is stable (desc weight then asc id)', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/c.ts', weight: 0.5 },
      { neuronId: 'file:src/a.ts', weight: 0.5 },
      { neuronId: 'file:src/b.ts', weight: 0.5 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.contributors).toEqual(['file:src/a.ts', 'file:src/b.ts', 'file:src/c.ts']);
  });

  it('mixed weights: higher weight wins regardless of id order', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/z.ts', weight: 0.9 },
      { neuronId: 'file:src/a.ts', weight: 0.1 },
    ];
    const result = canonicalMerge(evidence, 0.7);
    expect(result.placement).toBe('section');
    expect(result.neuronId).toBe('file:src/z.ts');
    expect(result.contributors[0]).toBe('file:src/z.ts');
  });
});

// ---------------------------------------------------------------------------
// Zero-weight evidence
// ---------------------------------------------------------------------------

describe('canonicalMerge — zero weights', () => {
  it('all weights zero → total=0, placement=concept', () => {
    const evidence: EvidenceItem[] = [
      { neuronId: 'file:src/auth.ts', weight: 0 },
      { neuronId: 'file:src/utils.ts', weight: 0 },
    ];
    const result = canonicalMerge(evidence);
    expect(result.placement).toBe('concept');
    expect(result.neuronId).toBeNull();
  });

  it('all weights zero → maxShare = 0', () => {
    const evidence: EvidenceItem[] = [{ neuronId: 'file:src/auth.ts', weight: 0 }];
    const result = canonicalMerge(evidence);
    expect(result.maxShare).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Return type completeness
// ---------------------------------------------------------------------------

describe('canonicalMerge — return type', () => {
  it('always returns placement, neuronId, maxShare, contributors', () => {
    const result: CanonicalMergeResult = canonicalMerge([
      { neuronId: 'file:src/auth.ts', weight: 1 },
    ]);
    expect(result).toHaveProperty('placement');
    expect(result).toHaveProperty('neuronId');
    expect(result).toHaveProperty('maxShare');
    expect(result).toHaveProperty('contributors');
  });
});
