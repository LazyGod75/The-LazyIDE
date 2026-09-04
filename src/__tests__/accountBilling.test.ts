import { describe, it, expect, vi } from 'vitest';
import { EMPTY_USAGE, summarizeUsageRows } from '../components/settings/account/creditsUsage';
import { submitCustomTopup } from '../components/settings/account/submitCustomTopup';
import type { AccountBilling } from '../components/settings/account/useAccountBilling';

describe('summarizeUsageRows', () => {
  it('returns empty for no rows', () => {
    expect(summarizeUsageRows([])).toEqual(EMPTY_USAGE);
  });

  it('sums charged USD and tokens', () => {
    expect(
      summarizeUsageRows([
        { cost_charged_usd: '0.4', input_tokens: 10, output_tokens: 5 },
        { cost_charged_usd: 0.1, input_tokens: null, output_tokens: 2 },
      ]),
    ).toEqual({ count: 2, totalChargedUsd: 0.5, totalTokens: 17 });
  });
});

function billingStub(overrides: Partial<AccountBilling> = {}): AccountBilling {
  return {
    t: (key: string) => key,
    toast: vi.fn(),
    checkoutLoading: false,
    portalLoading: false,
    topupLoading: null,
    topupInput: '',
    setTopupInput: vi.fn(),
    handlePortal: vi.fn(),
    handleSignOut: vi.fn(),
    handleCheckout: vi.fn(),
    handleTopup: vi.fn(),
    ...overrides,
  } as AccountBilling;
}

describe('submitCustomTopup', () => {
  it('rejects non-numeric and out-of-range amounts', () => {
    const billing = billingStub({ topupInput: 'abc' });
    submitCustomTopup(billing);
    expect(billing.handleTopup).not.toHaveBeenCalled();
    expect(billing.toast).toHaveBeenCalledWith('settings.billing.topupRangeError', 'error');
  });

  it('forwards a valid euro amount', () => {
    const billing = billingStub({ topupInput: '12' });
    submitCustomTopup(billing);
    expect(billing.handleTopup).toHaveBeenCalledWith(12);
  });
});
