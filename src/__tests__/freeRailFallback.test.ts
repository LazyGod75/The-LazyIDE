/* freeRailFallback — the shared OpenRouter :free quota 429s/404s are
 * provider-scoped: the fix (2026-09-11, live-verified) rotates to the next
 * free catalog entry instead of re-hitting the same saturated route. */

import { describe, it, expect } from 'vitest';
import {
  OPENROUTER_MODELS,
  FREE_OPENROUTER_MODEL_ID,
  nextFreeOpenRouterModelId,
  isOpenRouterFreeModel,
  migrateRetiredOpenRouterId,
} from '../lib/models/openrouterCatalog';

describe('nextFreeOpenRouterModelId', () => {
  it('rotates to a different free catalog entry', () => {
    const next = nextFreeOpenRouterModelId(FREE_OPENROUTER_MODEL_ID);
    expect(next).toBeDefined();
    expect(next).not.toBe(FREE_OPENROUTER_MODEL_ID);
    expect(isOpenRouterFreeModel(next!)).toBe(true);
  });

  it('cycles through every free entry and back to the default', () => {
    const freeIds = OPENROUTER_MODELS.filter((m) => m.isFree).map((m) => m.id);
    let current = FREE_OPENROUTER_MODEL_ID;
    const seen = new Set<string>([current]);
    for (let i = 0; i < freeIds.length - 1; i++) {
      const next = nextFreeOpenRouterModelId(current);
      expect(next).toBeDefined();
      expect(seen.has(next!)).toBe(false);
      seen.add(next!);
      current = next!;
    }
    // After visiting every free entry, the next hop wraps to the default.
    expect(nextFreeOpenRouterModelId(current)).toBe(FREE_OPENROUTER_MODEL_ID);
  });

  it('returns undefined for a non-free model (no silent downgrade)', () => {
    expect(nextFreeOpenRouterModelId('anthropic/claude-sonnet-5')).toBeUndefined();
    expect(nextFreeOpenRouterModelId('not-a-model')).toBeUndefined();
  });
});

describe('free rail catalog health', () => {
  it('every free entry is still a live-looking :free route (not a retired id)', () => {
    for (const m of OPENROUTER_MODELS.filter((x) => x.isFree)) {
      expect(m.id.endsWith(':free')).toBe(true);
      // A retired id must never still be listed as a live catalog entry.
      expect(migrateRetiredOpenRouterId(m.id)).toBe(m.id);
    }
  });

  it('retired free ids migrate to the live default', () => {
    expect(migrateRetiredOpenRouterId('minimax/minimax-m3:free')).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(migrateRetiredOpenRouterId('z-ai/glm-5.2:free')).toBe(FREE_OPENROUTER_MODEL_ID);
    // 2026-09-11 endpoint-verified: listed but zero free-serving endpoints.
    expect(migrateRetiredOpenRouterId('nvidia/nemotron-3-super-120b-a12b:free')).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(migrateRetiredOpenRouterId('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')).toBe(FREE_OPENROUTER_MODEL_ID);
  });
});
