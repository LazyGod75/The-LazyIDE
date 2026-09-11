/**
 * P0-1 — incremental-mode safety net.
 *
 * mergeWithExisting() is what lets runFileNeuronEnrichment be called with
 * only a DELTA of conversation notes (enrich.ts's runIncrementalEnrich)
 * without losing whatever a file-neuron already has attached: it seeds each
 * kind bucket with the node's existing (already-rendered, parsed-back) items,
 * then drops any old item whose text exactly duplicates a fresh one.
 */

import { describe, expect, it } from 'vitest';
import type { EnrichmentItem } from '../../annotator/blocks/composers/file-neuron.js';
import { type TimestampedItem, mergeWithExisting } from '../conv-file-enrichment.js';

function existingItem(text: string, overrides: Partial<EnrichmentItem> = {}): EnrichmentItem {
  return { text, confidence: 0.7, date: '2026-06-01', sourceConvLink: '#conv-old', ...overrides };
}

function freshItem(text: string, overrides: Partial<TimestampedItem> = {}): TimestampedItem {
  return { text, confidence: 0.8, date: '2026-07-02', sourceConvLink: '#conv-new', ...overrides };
}

describe('mergeWithExisting — incremental mode must not lose old enrichment', () => {
  it('returns the fresh items unchanged when there is nothing existing', () => {
    const fresh = [freshItem('New decision')];
    expect(mergeWithExisting(undefined, fresh)).toEqual(fresh);
    expect(mergeWithExisting([], fresh)).toEqual(fresh);
  });

  it("preserves an old item untouched by this run's delta (the core incremental guarantee)", () => {
    const existing = [existingItem('Old decision about auth')];
    const fresh: TimestampedItem[] = []; // this run's delta added nothing new for this kind
    const merged = mergeWithExisting(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('Old decision about auth');
  });

  it('combines old and new when they are genuinely different', () => {
    const existing = [existingItem('Old decision about auth')];
    const fresh = [freshItem('New decision about billing')];
    const merged = mergeWithExisting(existing, fresh);
    expect(merged.map((m) => m.text).sort()).toEqual(
      ['New decision about billing', 'Old decision about auth'].sort(),
    );
  });

  it('drops the OLD copy when a fresh item has the exact same text (case/whitespace-insensitive)', () => {
    const existing = [existingItem('Decided to use Canvas2D for the hero')];
    const fresh = [freshItem('  decided TO use canvas2d for the hero  ')];
    const merged = mergeWithExisting(existing, fresh);
    expect(merged).toHaveLength(1);
    // The surviving copy is the FRESH one (its own confidence/date/source), not the old one.
    expect(merged[0].confidence).toBe(0.8);
    expect(merged[0].sourceConvLink).toBe('#conv-new');
  });

  it('is what makes a FULL (non-incremental) run collapse back to just the fresh set', () => {
    // Full mode passes the entire conv corpus every time, so "existing" and
    // "fresh" both derive from the exact same classification of the exact
    // same conversation notes — every old item's text matches a fresh one.
    const existing = [existingItem('Decision A'), existingItem('Decision B')];
    const fresh = [freshItem('Decision A'), freshItem('Decision B')];
    const merged = mergeWithExisting(existing, fresh);
    expect(merged).toHaveLength(2); // not 4 — no duplication
    expect(merged.every((m) => m.sourceConvLink === '#conv-new')).toBe(true);
  });

  it('keeps multiple distinct old items when only one of them is touched by the delta', () => {
    const existing = [
      existingItem('Decision A — untouched'),
      existingItem('Decision B — will be updated'),
    ];
    const fresh = [freshItem('Decision B — will be updated')];
    const merged = mergeWithExisting(existing, fresh);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.text === 'Decision A — untouched')?.sourceConvLink).toBe(
      '#conv-old',
    );
    expect(merged.find((m) => m.text === 'Decision B — will be updated')?.sourceConvLink).toBe(
      '#conv-new',
    );
  });
});
