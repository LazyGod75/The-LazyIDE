import { describe, it, expect, vi } from 'vitest';
import { checkNativeBudget } from '../lib/agents/checkNativeBudget';
import { usdToCredits } from '../lib/billing/credits';

function hooks(overrides: Partial<Parameters<typeof checkNativeBudget>[2]> = {}) {
  return {
    isNativeRail: false,
    budgetCapUsd: 10,
    budgetExceeded: false,
    budgetWarned: false,
    onNativeEquivalent: vi.fn(),
    onExceeded: vi.fn(),
    onWarning: vi.fn(),
    ...overrides,
  };
}

describe('checkNativeBudget', () => {
  it('does nothing when spend is under the warning band', () => {
    const ctx = hooks();
    checkNativeBudget('ok', 1, ctx);
    expect(ctx.onExceeded).not.toHaveBeenCalled();
    expect(ctx.onWarning).not.toHaveBeenCalled();
    expect(ctx.onNativeEquivalent).not.toHaveBeenCalled();
  });

  it('kills BYOK/managed-fallback on exceeded, never native-equivalent', () => {
    const ctx = hooks({ isNativeRail: false });
    checkNativeBudget('exceeded', 12, ctx);
    expect(ctx.onExceeded).toHaveBeenCalledOnce();
    expect(ctx.onExceeded).toHaveBeenCalledWith(12);
    expect(ctx.onNativeEquivalent).not.toHaveBeenCalled();
  });

  it('notes a non-terminal equivalent on the native rail instead of killing', () => {
    const ctx = hooks({ isNativeRail: true });
    checkNativeBudget('exceeded', 12, ctx);
    expect(ctx.onExceeded).not.toHaveBeenCalled();
    expect(ctx.onNativeEquivalent).toHaveBeenCalledWith(usdToCredits(12), 100);
  });

  it('warns BYOK at 90%+ and notes equivalent on native', () => {
    const byok = hooks({ isNativeRail: false });
    checkNativeBudget('warning', 9, byok);
    expect(byok.onWarning).toHaveBeenCalledWith(90, 9);

    const native = hooks({ isNativeRail: true });
    checkNativeBudget('warning', 9, native);
    expect(native.onWarning).not.toHaveBeenCalled();
    expect(native.onNativeEquivalent).toHaveBeenCalledWith(usdToCredits(9), 90);
  });
});
