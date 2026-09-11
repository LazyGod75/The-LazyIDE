import { describe, it, expect } from 'vitest';
import {
  catalogRatesFor,
  estimateUsageUsd,
  FALLBACK_PRICE_INPUT_PER_M,
  FALLBACK_PRICE_OUTPUT_PER_M,
} from '../lib/models/estimateUsageUsd';

describe('catalogRatesFor', () => {
  it('hits the OpenRouter id exactly', () => {
    expect(catalogRatesFor('anthropic/claude-sonnet-5')).toEqual({ priceIn: 2, priceOut: 10 });
  });

  it('maps a native Claude id onto the catalog short name', () => {
    expect(catalogRatesFor('claude-haiku-4-5')).toEqual({ priceIn: 1, priceOut: 5 });
    expect(catalogRatesFor('claude-sonnet-5')).toEqual({ priceIn: 2, priceOut: 10 });
  });

  it('returns null for an unknown id so callers can fall back', () => {
    expect(catalogRatesFor('unknown-local-cli')).toBeNull();
  });
});

describe('estimateUsageUsd', () => {
  it('prices 1M catalog Haiku input tokens at $1', () => {
    expect(estimateUsageUsd('anthropic/claude-haiku-4.5', 1_000_000, 0)).toBe(1);
  });

  it('prices 1M catalog Sonnet input tokens at $2', () => {
    expect(estimateUsageUsd('anthropic/claude-sonnet-5', 1_000_000, 0)).toBe(2);
  });

  it('charges nothing for a free catalog model', () => {
    expect(estimateUsageUsd('google/gemma-4-31b-it:free', 50_000, 2_000)).toBe(0);
  });

  it('bills the paid glm-5.2 route now that its :free sibling is retired (the sibling-zeroing only applied while a real free route existed)', () => {
    expect(estimateUsageUsd('z-ai/glm-5.2', 10_000, 12_000)).toBeCloseTo(0.15 * 0.01 + 0.6 * 0.012, 5);
    expect(catalogRatesFor('z-ai/glm-5.2')).toEqual({ priceIn: 0.15, priceOut: 0.6 });
  });

  it('zeroes the bare short name of a live free route (gemma-4-31b)', () => {
    // 'gemma-4-31b-it' resolves to its :free catalog entry via the short-base
    // match — a free route always prices at 0.
    expect(catalogRatesFor('gemma-4-31b-it')).toEqual({ priceIn: 0, priceOut: 0 });
  });

  it('uses the historical Haiku fallback only when the id is unknown', () => {
    expect(estimateUsageUsd('unknown-local-cli', 1_000_000, 0)).toBe(FALLBACK_PRICE_INPUT_PER_M);
    expect(estimateUsageUsd('unknown-local-cli', 0, 1_000_000)).toBe(FALLBACK_PRICE_OUTPUT_PER_M);
  });
});
