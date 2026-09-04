/**
 * brainCitations.test.ts — D13 graft (c): captureBrainContext pure helper.
 * Verifies the mapping from a real BrainRecallResult onto the Mission-facing
 * brainCitations/tokensSavedLabel shapes, and the honest-empty paths (no
 * recall, empty recall, zero tokensSaved).
 */

import { describe, it, expect } from 'vitest';
import { captureBrainContext } from '../lib/agents/brainCitations';
import type { BrainRecallResult, BrainSearchResult } from '../lib/platform/types';

function makeNode(overrides: Partial<BrainSearchResult> = {}): BrainSearchResult {
  return {
    id: 'note-1',
    title: 'Pricing table pattern',
    snippet: 'Reuse the PricingCard layout from M7…',
    score: 0.92,
    ...overrides,
  };
}

function makeRecall(overrides: Partial<BrainRecallResult> = {}): BrainRecallResult {
  return {
    nodes: [makeNode()],
    tokensSaved: 1200,
    injectedContext: 'some context',
    ...overrides,
  };
}

describe('captureBrainContext', () => {
  it('returns an honest empty result when recall is null', () => {
    expect(captureBrainContext(null)).toEqual({ citations: [] });
  });

  it('returns an honest empty result when recall is undefined', () => {
    expect(captureBrainContext(undefined)).toEqual({ citations: [] });
  });

  it('returns an honest empty result when recall found no nodes', () => {
    const recall = makeRecall({ nodes: [], tokensSaved: 0 });
    expect(captureBrainContext(recall)).toEqual({ citations: [] });
  });

  it('maps real recall nodes onto citations with id + label', () => {
    const recall = makeRecall({
      nodes: [makeNode({ id: 'a', title: 'Neuron A' }), makeNode({ id: 'b', title: 'Neuron B' })],
    });
    const result = captureBrainContext(recall);
    expect(result.citations).toEqual([
      { id: 'a', label: 'Neuron A' },
      { id: 'b', label: 'Neuron B' },
    ]);
  });

  it('falls back to the node id as label when title is missing', () => {
    const recall = makeRecall({ nodes: [makeNode({ id: 'note-42', title: '' })] });
    const result = captureBrainContext(recall);
    expect(result.citations).toEqual([{ id: 'note-42', label: 'note-42' }]);
  });

  it('caps citations at 6 even when more nodes are returned', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode({ id: `n${i}`, title: `Neuron ${i}` }));
    const result = captureBrainContext(makeRecall({ nodes }));
    expect(result.citations).toHaveLength(6);
    expect(result.citations[0]).toEqual({ id: 'n0', label: 'Neuron 0' });
  });

  it('produces a formatted tokensSavedLabel when tokensSaved > 0', () => {
    const result = captureBrainContext(makeRecall({ tokensSaved: 1834 }));
    expect(result.tokensSavedLabel).toBe('~1.8k tokens économisés');
  });

  it('formats large token counts in millions', () => {
    const result = captureBrainContext(makeRecall({ tokensSaved: 2_400_000 }));
    expect(result.tokensSavedLabel).toBe('~2.4M tokens économisés');
  });

  it('omits tokensSavedLabel (honest empty) when tokensSaved is 0', () => {
    const result = captureBrainContext(makeRecall({ tokensSaved: 0 }));
    expect(result.tokensSavedLabel).toBeUndefined();
  });
});
