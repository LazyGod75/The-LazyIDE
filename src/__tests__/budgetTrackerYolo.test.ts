import { describe, it, expect, beforeEach } from 'vitest';
import {
  setMissionLimit,
  setProjectLimit,
  setGlobalLimit,
  spend,
  getGlobalBudget,
  isOverYoloHardStop,
  _resetBudgetTrackerForTests,
} from '../lib/agents/budgetTracker';

beforeEach(() => {
  _resetBudgetTrackerForTests();
});

describe('isOverYoloHardStop — mission level', () => {
  it('returns false when spend is exactly 100% of limit', () => {
    setMissionLimit('yolo-m-100', 100);
    spend('yolo-m-100', 'yolo-p-100', 100);
    expect(isOverYoloHardStop('yolo-m-100', 'yolo-p-100')).toBe(false);
  });

  it('returns false when spend is 119% of limit', () => {
    setMissionLimit('yolo-m-119', 100);
    spend('yolo-m-119', 'yolo-p-119', 119);
    expect(isOverYoloHardStop('yolo-m-119', 'yolo-p-119')).toBe(false);
  });

  it('returns true when spend is 120% of limit', () => {
    setMissionLimit('yolo-m-120', 100);
    spend('yolo-m-120', 'yolo-p-120', 120);
    expect(isOverYoloHardStop('yolo-m-120', 'yolo-p-120')).toBe(true);
  });

  it('returns true when spend is 150% of limit', () => {
    setMissionLimit('yolo-m-150', 100);
    spend('yolo-m-150', 'yolo-p-150', 150);
    expect(isOverYoloHardStop('yolo-m-150', 'yolo-p-150')).toBe(true);
  });

  it('returns false when no limit is set', () => {
    spend('yolo-m-nolimit', 'yolo-p-nolimit', 500);
    expect(isOverYoloHardStop('yolo-m-nolimit', 'yolo-p-nolimit')).toBe(false);
  });
});

describe('isOverYoloHardStop — project level', () => {
  it('returns false when spend is exactly 100% of limit', () => {
    setProjectLimit('yolo-proj-100', 100);
    spend('yolo-m-proj-100', 'yolo-proj-100', 100);
    expect(isOverYoloHardStop('yolo-m-proj-100', 'yolo-proj-100')).toBe(false);
  });

  it('returns true when spend is 120% of limit', () => {
    setProjectLimit('yolo-proj-120', 100);
    spend('yolo-m-proj-120', 'yolo-proj-120', 120);
    expect(isOverYoloHardStop('yolo-m-proj-120', 'yolo-proj-120')).toBe(true);
  });

  it('returns false when no limit is set', () => {
    spend('yolo-m-proj-nolimit', 'yolo-proj-nolimit', 500);
    expect(isOverYoloHardStop('yolo-m-proj-nolimit', 'yolo-proj-nolimit')).toBe(false);
  });
});

describe('isOverYoloHardStop — global level', () => {
  it('returns false when spend is exactly 100% of limit', () => {
    const baseline = getGlobalBudget().spentCents;
    setGlobalLimit(baseline + 1000);
    spend('yolo-g-100-m', 'yolo-g-100-p', 1000);
    expect(isOverYoloHardStop('yolo-g-100-m', 'yolo-g-100-p')).toBe(false);
  });

  it('returns true when spend is 120% of limit', () => {
    const baseline = getGlobalBudget().spentCents;
    const spendAmount = 1200;
    setGlobalLimit(Math.floor((baseline + spendAmount) / 1.2));
    spend('yolo-g-120-m', 'yolo-g-120-p', spendAmount);
    expect(isOverYoloHardStop('yolo-g-120-m', 'yolo-g-120-p')).toBe(true);
  });

  it('returns false when no limit is set', () => {
    setGlobalLimit(undefined);
    spend('yolo-g-nolimit-m', 'yolo-g-nolimit-p', 500);
    expect(isOverYoloHardStop('yolo-g-nolimit-m', 'yolo-g-nolimit-p')).toBe(false);
  });
});
