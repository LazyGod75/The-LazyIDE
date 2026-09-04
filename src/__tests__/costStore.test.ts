import { describe, it, expect, beforeEach } from 'vitest';
import {
  addUsage,
  getCostState,
  subscribeCost,
  resetCost,
  recordRecallSaving,
  getRecallSavingsBySource,
} from '../lib/models/costStore';
import { _resetBudgetTrackerForTests } from '../lib/agents/budgetTracker';

// Reset state before each test — costStore uses module-level mutable state
beforeEach(() => {
  resetCost();
  _resetBudgetTrackerForTests();
});

/** Catalog Haiku 4.5 — OPENROUTER_MODELS['anthropic/claude-haiku-4.5'] */
const HAIKU_INPUT_PER_M  = 1;
const HAIKU_OUTPUT_PER_M = 5;
/** Unknown-id fallback — estimateUsageUsd FALLBACK_* */
const FALLBACK_INPUT_PER_M  = 0.80;

describe('costStore', () => {
  it('initial state is all zeros', () => {
    const state = getCostState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
    expect(state.totalCostUsd).toBe(0);
  });

  it('addUsage accumulates input tokens', () => {
    addUsage({ inputTokens: 1000, outputTokens: 0, model: 'claude-haiku-4-5' });
    addUsage({ inputTokens: 500, outputTokens: 0, model: 'claude-haiku-4-5' });
    expect(getCostState().totalInputTokens).toBe(1500);
  });

  it('addUsage accumulates output tokens', () => {
    addUsage({ inputTokens: 0, outputTokens: 200, model: 'claude-haiku-4-5' });
    addUsage({ inputTokens: 0, outputTokens: 300, model: 'claude-haiku-4-5' });
    expect(getCostState().totalOutputTokens).toBe(500);
  });

  it('computes cost correctly for 1M input tokens at Haiku rate', () => {
    addUsage({ inputTokens: 1_000_000, outputTokens: 0, model: 'claude-haiku-4-5' });
    const state = getCostState();
    expect(state.totalCostUsd).toBeCloseTo(HAIKU_INPUT_PER_M, 6);
  });

  it('computes cost correctly for 1M output tokens at Haiku rate', () => {
    addUsage({ inputTokens: 0, outputTokens: 1_000_000, model: 'claude-haiku-4-5' });
    const state = getCostState();
    expect(state.totalCostUsd).toBeCloseTo(HAIKU_OUTPUT_PER_M, 6);
  });

  it('accumulates cost across multiple calls', () => {
    addUsage({ inputTokens: 500_000, outputTokens: 250_000, model: 'claude-haiku-4-5' });
    addUsage({ inputTokens: 500_000, outputTokens: 250_000, model: 'claude-haiku-4-5' });
    const expected =
      (1_000_000 / 1_000_000) * HAIKU_INPUT_PER_M +
      (500_000 / 1_000_000) * HAIKU_OUTPUT_PER_M;
    expect(getCostState().totalCostUsd).toBeCloseTo(expected, 6);
  });

  it('resetCost clears all state', () => {
    addUsage({ inputTokens: 9999, outputTokens: 9999, model: 'test' });
    resetCost();
    const state = getCostState();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
    expect(state.totalCostUsd).toBe(0);
  });

  it('subscribeCost notifies listener on addUsage', () => {
    const calls: number[] = [];
    const unsub = subscribeCost(s => calls.push(s.totalInputTokens));

    addUsage({ inputTokens: 100, outputTokens: 0, model: 'test' });
    addUsage({ inputTokens: 200, outputTokens: 0, model: 'test' });

    expect(calls).toEqual([100, 300]);
    unsub();
  });

  it('subscribeCost unsubscribe stops notifications', () => {
    const calls: number[] = [];
    const unsub = subscribeCost(s => calls.push(s.totalInputTokens));
    unsub();
    addUsage({ inputTokens: 500, outputTokens: 0, model: 'test' });
    expect(calls).toHaveLength(0);
  });

  it('getCostState returns a snapshot (not a reference)', () => {
    addUsage({ inputTokens: 100, outputTokens: 0, model: 'test' });
    const snap1 = getCostState();
    addUsage({ inputTokens: 100, outputTokens: 0, model: 'test' });
    const snap2 = getCostState();
    // snap1 should not have been mutated
    expect(snap1.totalInputTokens).toBe(100);
    expect(snap2.totalInputTokens).toBe(200);
  });

  it('resetCost notifies subscribers', () => {
    const calls: number[] = [];
    const unsub = subscribeCost(s => calls.push(s.totalInputTokens));
    addUsage({ inputTokens: 50, outputTokens: 0, model: 'test' });
    resetCost();
    // After reset, last notification should be 0
    expect(calls[calls.length - 1]).toBe(0);
    unsub();
  });

  it('prices a catalog Sonnet id at $2 per 1M input when costUsd is omitted', () => {
    addUsage({ inputTokens: 1_000_000, outputTokens: 0, model: 'anthropic/claude-sonnet-5' });
    expect(getCostState().totalCostUsd).toBeCloseTo(2, 6);
  });

  it('keeps the historical Haiku fallback only for unknown ids', () => {
    addUsage({ inputTokens: 1_000_000, outputTokens: 0, model: 'unknown-local-cli' });
    expect(getCostState().totalCostUsd).toBeCloseTo(FALLBACK_INPUT_PER_M, 6);
  });
});

// ── Cache fields (prompt caching — ai-proxy settled \x1b[usage] marker) ──
// managedProvider.ts forwards RealUsage.cacheReadTokens/cacheCreationTokens/
// cacheSavingsUsd here when the ai-proxy deployment reports them. Purely
// additive/observational — must never move totalCostUsd, which already
// reflects the real charge (or the local Haiku-rate estimate below, for a
// record that omits the cache fields entirely).
describe('costStore — cache fields', () => {
  it('starts at zero and never assumes cache activity that was not reported', () => {
    const state = getCostState();
    expect(state.totalCacheReadTokens).toBe(0);
    expect(state.totalCacheCreationTokens).toBe(0);
    expect(state.totalCacheSavingsUsd).toBe(0);
  });

  it('accumulates cache fields when present on the record', () => {
    addUsage({
      inputTokens: 6000,
      outputTokens: 180,
      model: 'anthropic/claude-sonnet-5',
      cacheReadTokens: 5400,
      cacheCreationTokens: 0,
      cacheSavingsUsd: 0.061,
    });
    addUsage({
      inputTokens: 6000,
      outputTokens: 180,
      model: 'anthropic/claude-sonnet-5',
      cacheReadTokens: 5400,
      cacheCreationTokens: 0,
      cacheSavingsUsd: 0.061,
    });
    const state = getCostState();
    expect(state.totalCacheReadTokens).toBe(10800);
    expect(state.totalCacheCreationTokens).toBe(0);
    expect(state.totalCacheSavingsUsd).toBeCloseTo(0.122, 6);
  });

  it('a record with no cache fields (BYOK/CLI provider, or an older ai-proxy marker) leaves the cache totals unchanged', () => {
    addUsage({ inputTokens: 1000, outputTokens: 100, model: 'claude-haiku-4-5' });
    const state = getCostState();
    expect(state.totalCacheReadTokens).toBe(0);
    expect(state.totalCacheCreationTokens).toBe(0);
    expect(state.totalCacheSavingsUsd).toBe(0);
    // Catalog Haiku rates — cache fields never perturb totalCostUsd.
    expect(state.totalCostUsd).toBeCloseTo(
      (1000 / 1_000_000) * HAIKU_INPUT_PER_M + (100 / 1_000_000) * HAIKU_OUTPUT_PER_M,
      6,
    );
  });

  it('a cache-priming call is allowed to accumulate a NEGATIVE totalCacheSavingsUsd (write premium, no reads yet)', () => {
    addUsage({
      inputTokens: 50000,
      outputTokens: 100,
      model: 'anthropic/claude-sonnet-5',
      cacheReadTokens: 0,
      cacheCreationTokens: 49000,
      cacheSavingsUsd: -0.031,
    });
    expect(getCostState().totalCacheSavingsUsd).toBeCloseTo(-0.031, 6);
  });

  it('resetCost clears the cache totals too', () => {
    addUsage({
      inputTokens: 6000,
      outputTokens: 180,
      model: 'anthropic/claude-sonnet-5',
      cacheReadTokens: 5400,
      cacheCreationTokens: 100,
      cacheSavingsUsd: 0.06,
    });
    resetCost();
    const state = getCostState();
    expect(state.totalCacheReadTokens).toBe(0);
    expect(state.totalCacheCreationTokens).toBe(0);
    expect(state.totalCacheSavingsUsd).toBe(0);
  });
});

// ── recordRecallSaving — the brain-savings choke point ──────────────
//
// Root-cause coverage for the "CockpitKpiBar always shows 0 tokens saved"
// complaint: normalizeRecall (lib/brain/context.ts) computes a real
// tokensSaved estimate on EVERY recall, but only assistantStore.tsx (Codeur
// chat) ever forwarded it to addBrainSavings. Mission launches, the
// tool-loop's BRAIN_SEARCH directive, and the brain_query/brain_synthesize
// tools all computed a real saving that then evaporated. recordRecallSaving
// is the uniform choke point every one of those call sites now uses.
describe('recordRecallSaving', () => {
  it('forwards a positive tokensSaved to the aggregate (totalBrainTokensSaved)', () => {
    recordRecallSaving({ tokensSaved: 1200 }, 'mission');
    expect(getCostState().totalBrainTokensSaved).toBe(1200);
  });

  it('accumulates across multiple sources into the same honest aggregate', () => {
    recordRecallSaving({ tokensSaved: 100 }, 'codeur');
    recordRecallSaving({ tokensSaved: 200 }, 'mission');
    recordRecallSaving({ tokensSaved: 50 }, 'tool');
    expect(getCostState().totalBrainTokensSaved).toBe(350);
  });

  it('tracks a per-source breakdown for diagnostics', () => {
    recordRecallSaving({ tokensSaved: 100 }, 'codeur');
    recordRecallSaving({ tokensSaved: 300 }, 'mission');
    recordRecallSaving({ tokensSaved: 300 }, 'mission');
    const bySource = getRecallSavingsBySource();
    expect(bySource.codeur).toBe(100);
    expect(bySource.mission).toBe(600);
    expect(bySource.manager).toBe(0);
    expect(bySource.tool).toBe(0);
  });

  it('never floors a genuine zero to a fake non-zero number — no recall means no record', () => {
    recordRecallSaving({ tokensSaved: 0 }, 'mission');
    expect(getCostState().totalBrainTokensSaved).toBe(0);
    expect(getRecallSavingsBySource().mission).toBe(0);
  });

  it('ignores negative and non-finite values (honest-zero, never a fake floor)', () => {
    recordRecallSaving({ tokensSaved: -50 }, 'mission');
    recordRecallSaving({ tokensSaved: NaN }, 'mission');
    recordRecallSaving({ tokensSaved: Infinity }, 'mission');
    expect(getCostState().totalBrainTokensSaved).toBe(0);
  });

  it('ignores a null/undefined recall (discarded candidate, e.g. an unused fallback)', () => {
    recordRecallSaving(null, 'codeur');
    recordRecallSaving(undefined, 'codeur');
    expect(getCostState().totalBrainTokensSaved).toBe(0);
  });

  it('rounds decimal savings', () => {
    recordRecallSaving({ tokensSaved: 10.6 }, 'tool');
    expect(getCostState().totalBrainTokensSaved).toBe(11);
  });

  it('resetCost clears the per-source breakdown too', () => {
    recordRecallSaving({ tokensSaved: 500 }, 'manager');
    resetCost();
    const bySource = getRecallSavingsBySource();
    expect(bySource.manager).toBe(0);
    expect(getCostState().totalBrainTokensSaved).toBe(0);
  });
});
