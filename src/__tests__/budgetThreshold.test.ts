import { describe, it, expect, vi } from 'vitest';
import { classifyBudgetPct, emitIfOverThreshold } from '../lib/agents/budgetThreshold';

describe('classifyBudgetPct', () => {
  it('is silent below 90%', () => {
    expect(classifyBudgetPct(0)).toBeNull();
    expect(classifyBudgetPct(89)).toBeNull();
  });

  it('warns at 90–99%', () => {
    expect(classifyBudgetPct(90)).toBe('budget.warning');
    expect(classifyBudgetPct(99)).toBe('budget.warning');
  });

  it('exceeds at 100%+', () => {
    expect(classifyBudgetPct(100)).toBe('budget.exceeded');
    expect(classifyBudgetPct(250)).toBe('budget.exceeded');
  });

  it('rejects non-finite pct', () => {
    expect(classifyBudgetPct(Number.NaN)).toBeNull();
    expect(classifyBudgetPct(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('emitIfOverThreshold', () => {
  it('does not emit without a limit', () => {
    const emit = vi.fn();
    emitIfOverThreshold(500, undefined, emit);
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits warning with usd units at 90%', () => {
    const emit = vi.fn();
    emitIfOverThreshold(90, 100, emit);
    expect(emit).toHaveBeenCalledWith('budget.warning', 1, 0.9, 90);
  });
});
