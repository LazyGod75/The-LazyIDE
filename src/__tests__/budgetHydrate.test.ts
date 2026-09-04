import { describe, it, expect, beforeEach } from 'vitest';
import {
  spend,
  getGlobalBudget,
  hydrateGlobalSpentCents,
  recordUsageSpendCents,
  subscribeBudget,
  _resetBudgetTrackerForTests,
} from '../lib/agents/budgetTracker';
import { addUsage, resetCost } from '../lib/models/costStore';

beforeEach(() => {
  _resetBudgetTrackerForTests();
  resetCost();
});

describe('hydrateGlobalSpentCents', () => {
  it('lifts the live tracker to the durable history total', () => {
    hydrateGlobalSpentCents(420);
    expect(getGlobalBudget().spentCents).toBe(420);
  });

  it('never drops a higher live spend', () => {
    spend('m1', 'p1', 800);
    hydrateGlobalSpentCents(100);
    expect(getGlobalBudget().spentCents).toBe(800);
  });

  it('ignores non-finite history', () => {
    hydrateGlobalSpentCents(Number.NaN);
    hydrateGlobalSpentCents(-12);
    expect(getGlobalBudget().spentCents).toBe(0);
  });
});

describe('recordUsageSpendCents', () => {
  it('is a no-op for free / zero cost', () => {
    recordUsageSpendCents(0);
    expect(getGlobalBudget().spentCents).toBe(0);
  });

  it('notifies subscribers', () => {
    let ticks = 0;
    const unsub = subscribeBudget(() => { ticks += 1; });
    recordUsageSpendCents(15);
    unsub();
    expect(getGlobalBudget().spentCents).toBe(15);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('addUsage → budgetTracker', () => {
  it('records estimated catalog Haiku cents on the session ledger', () => {
    addUsage({ inputTokens: 1_000_000, outputTokens: 0, model: 'claude-haiku-4-5' });
    expect(getGlobalBudget().spentCents).toBe(100);
  });

  it('does not invent spend for a free settled costUsd of 0', () => {
    addUsage({ inputTokens: 9_000, outputTokens: 400, model: 'z-ai/glm-5.2', costUsd: 0 });
    expect(getGlobalBudget().spentCents).toBe(0);
  });
});
