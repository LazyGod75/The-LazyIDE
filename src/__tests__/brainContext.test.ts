/* lib/brain/context.ts — classifyRecallLevel (RECALL LEVEL HONESTY) and
   normalizeRecall's level/emptyBrain pass-through.
*/

import { describe, it, expect } from 'vitest';
import { classifyRecallLevel, normalizeRecall } from '../lib/brain/context';
import type { BrainRecallResult } from '../lib/platform/types';

describe('classifyRecallLevel — raw LazyBrain level code -> UI classification', () => {
  it('maps L3 (embedding/cosine search) to "semantic"', () => {
    expect(classifyRecallLevel('L3')).toBe('semantic');
  });

  it('maps L4 (semantic + cross-encoder rerank) to "semantic"', () => {
    expect(classifyRecallLevel('L4')).toBe('semantic');
  });

  it('maps L2_L3_HYBRID (fused keyword+embedding) to "hybrid"', () => {
    expect(classifyRecallLevel('L2_L3_HYBRID')).toBe('hybrid');
  });

  it('maps L2 (FTS/BM25 keyword search) to "keyword"', () => {
    expect(classifyRecallLevel('L2')).toBe('keyword');
  });

  it('maps L1 (structural/exact-match lookup) to "keyword" (closest of the 3 buckets)', () => {
    expect(classifyRecallLevel('L1')).toBe('keyword');
  });

  it('returns undefined for an unrecognized code — never guesses', () => {
    expect(classifyRecallLevel('L99-future-level')).toBeUndefined();
  });

  it('returns undefined for null (e.g. the cold-CLI recall fallback, which has no structured level)', () => {
    expect(classifyRecallLevel(null)).toBeUndefined();
  });

  it('returns undefined for undefined (e.g. zero search results)', () => {
    expect(classifyRecallLevel(undefined)).toBeUndefined();
  });
});

describe('normalizeRecall — preserves level and emptyBrain through the spread', () => {
  function baseRecall(overrides: Partial<BrainRecallResult> = {}): BrainRecallResult {
    return {
      nodes: [],
      tokensSaved: 0,
      injectedContext: '',
      ...overrides,
    };
  }

  it('carries `level` through unchanged', () => {
    const result = normalizeRecall(baseRecall({ level: 'semantic' }));
    expect(result.level).toBe('semantic');
  });

  it('carries `emptyBrain` through unchanged', () => {
    const result = normalizeRecall(baseRecall({ emptyBrain: true }));
    expect(result.emptyBrain).toBe(true);
  });

  it('leaves `level` undefined when the input never set it', () => {
    const result = normalizeRecall(baseRecall());
    expect(result.level).toBeUndefined();
  });

  it('still recomputes tokensInjected/tokensSaved as before (level/emptyBrain are purely additive)', () => {
    const result = normalizeRecall(baseRecall({
      level: 'hybrid',
      nodes: [{ id: 'n1', title: 'Note', snippet: 'some recalled content here', score: 0.8 }],
    }));
    expect(result.level).toBe('hybrid');
    expect(result.tokensInjected).toBeGreaterThan(0);
  });
});
