/* budgetGuard.test.ts — unit tests for per-bot budget tracking. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setBotBudgetCap,
  recordBotCost,
  getBotBudget,
  checkBotBudget,
  checkBotBudgetExceeded,
  checkBotBudgetWarning,
  resetBudgetGuard,
} from '../lib/bots/budgetGuard';

beforeEach(() => {
  resetBudgetGuard();
});

describe('setBotBudgetCap', () => {
  it('sets the cap for a bot', () => {
    setBotBudgetCap('bot_1', 5.0);
    const budget = getBotBudget('bot_1');
    expect(budget.capUsd).toBe(5.0);
  });
});

describe('recordBotCost', () => {
  it('accumulates costs across multiple runs', () => {
    recordBotCost('bot_1', 0.5);
    recordBotCost('bot_1', 0.3);
    const budget = getBotBudget('bot_1');
    expect(budget.totalCostUsd).toBeCloseTo(0.8, 4);
    expect(budget.runCount).toBe(2);
  });

  it('returns the updated total', () => {
    const total = recordBotCost('bot_1', 1.2);
    expect(total).toBeCloseTo(1.2, 4);
  });
});

describe('getBotBudget', () => {
  it('returns remaining budget when a cap is set', () => {
    setBotBudgetCap('bot_1', 10.0);
    recordBotCost('bot_1', 3.0);
    const budget = getBotBudget('bot_1');
    expect(budget.remainingUsd).toBeCloseTo(7.0, 4);
    expect(budget.percentUsed).toBeCloseTo(30, 0);
  });

  it('returns null remaining when no cap is set', () => {
    recordBotCost('bot_1', 1.0);
    const budget = getBotBudget('bot_1');
    expect(budget.remainingUsd).toBeNull();
    expect(budget.percentUsed).toBe(0);
  });

  it('returns zeros for an unknown bot', () => {
    const budget = getBotBudget('unknown');
    expect(budget.totalCostUsd).toBe(0);
    expect(budget.runCount).toBe(0);
  });
});

describe('checkBotBudget', () => {
  it('returns null when no cap is set', () => {
    recordBotCost('bot_1', 100);
    expect(checkBotBudget('bot_1')).toBeNull();
  });

  it('returns null when under the cap', () => {
    setBotBudgetCap('bot_1', 10.0);
    recordBotCost('bot_1', 2.0);
    expect(checkBotBudget('bot_1')).toBeNull();
  });

  it('returns a warning at 90% usage', () => {
    setBotBudgetCap('bot_1', 10.0);
    recordBotCost('bot_1', 9.1);
    const msg = checkBotBudgetWarning('bot_1');
    expect(msg).toMatch(/90%/);
    expect(checkBotBudgetExceeded('bot_1')).toBeNull();
  });

  it('returns an exceeded message when over the cap', () => {
    setBotBudgetCap('bot_1', 10.0);
    recordBotCost('bot_1', 10.5);
    const msg = checkBotBudgetExceeded('bot_1');
    expect(msg).toMatch(/Budget exceeded/);
    expect(msg).toMatch(/Raise the cap/);
  });

  it('checkBotBudget still reports the warning for callers that only display it', () => {
    setBotBudgetCap('bot_1', 10.0);
    recordBotCost('bot_1', 9.1);
    expect(checkBotBudget('bot_1')).toMatch(/90%/);
  });
});
