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
    expect(estimateUsageUsd('z-ai/glm-5.2', 50_000, 2_000)).toBe(0);
    expect(estimateUsageUsd('z-ai/glm-5.2:free', 50_000, 2_000)).toBe(0);
  });

  it('does not bill the paid glm-5.2 route when the :free sibling exists (10k/12k used to be $0.0087)', () => {
    expect(estimateUsageUsd('z-ai/glm-5.2', 10_000, 12_000)).toBe(0);
    expect(catalogRatesFor('z-ai/glm-5.2')).toEqual({ priceIn: 0, priceOut: 0 });
  });

  it('uses the historical Haiku fallback only when the id is unknown', () => {
    expect(estimateUsageUsd('unknown-local-cli', 1_000_000, 0)).toBe(FALLBACK_PRICE_INPUT_PER_M);
    expect(estimateUsageUsd('unknown-local-cli', 0, 1_000_000)).toBe(FALLBACK_PRICE_OUTPUT_PER_M);
  });
});
