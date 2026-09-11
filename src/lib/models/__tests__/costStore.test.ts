/* costStore.test.ts — regression for the per-call rounding bug in the
   costStore.addUsage → budgetTracker.recordUsageSpendCents chain.

   Reproduction from audit: "1000 settled calls at $0.004 total $4, but the
   live budget tracker records 0 cents." Root cause: addUsage fed
   usdToCredits(cost) (Math.round(usd * 100)) per call, so each $0.004 call
   rounded 0.4¢ down to 0¢ and evaporated — 1000 × 0 == 0 instead of ~400.
*/
import { describe, it, expect, beforeEach } from 'vitest';
import { addUsage, resetCost } from '../costStore';
import {
  getGlobalBudget,
  _resetBudgetTrackerForTests,
} from '../../agents/budgetTracker';

beforeEach(() => {
  _resetBudgetTrackerForTests();
  resetCost();
});

describe('addUsage → budgetTracker (sub-cent accumulation)', () => {
  it('records ~400 cents for 1000 settled calls at $0.004 each ($4 total)', () => {
    for (let i = 0; i < 1000; i++) {
      addUsage({ inputTokens: 0, outputTokens: 0, model: 'any', costUsd: 0.004 });
    }
    // $4 == 400 cents (credits). Tolerate ±1¢ for float drift.
    expect(getGlobalBudget().spentCents).toBeGreaterThanOrEqual(399);
    expect(getGlobalBudget().spentCents).toBeLessThanOrEqual(401);
  });

  it('still records a single whole-cent call exactly', () => {
    addUsage({ inputTokens: 0, outputTokens: 0, model: 'any', costUsd: 0.05 });
    expect(getGlobalBudget().spentCents).toBe(5);
  });

  it('still does not invent spend for a free settled costUsd of 0', () => {
    addUsage({ inputTokens: 9_000, outputTokens: 400, model: 'z-ai/glm-5.2', costUsd: 0 });
    expect(getGlobalBudget().spentCents).toBe(0);
  });
});
