/**
 * AccountPopover.topup.test.tsx — inline top-up form + Pro+ upgrade button
 * added to the shared billing popover. Mirrors AccountPopover.dismissal.
 * test.tsx's mocking approach (same Harness shape via useAccountPopoverTrigger)
 * but keeps the real pure helpers (TOPUP_PRESETS_EUR/isValidTopupAmount) from
 * '../lib/billing' via importOriginal, mocking only the I/O-touching calls
 * (checkout/portal/plan-change/subscription state).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AccountPopover, useAccountPopoverTrigger } from '../components/account/AccountPopover';

afterEach(cleanup);

const {
  mockStartTopup,
  mockStartPlanChange,
  mockStartProCheckout,
  mockOpenBillingPortal,
  mockRefresh,
} = vi.hoisted(() => ({
  mockStartTopup: vi.fn(async () => ({ error: null as string | null })),
  mockStartPlanChange: vi.fn(async () => ({ error: null as string | null })),
  mockStartProCheckout: vi.fn(async () => ({ error: null as string | null })),
  mockOpenBillingPortal: vi.fn(async () => ({ error: null as string | null })),
  mockRefresh: vi.fn(async () => {}),
}));

interface MockSubscription {
  credits_remaining_cents: number;
  status: string;
}

let subscriptionState: {
  subscription: MockSubscription | null;
  isPro: boolean;
  isProPlus: boolean;
  refresh: () => Promise<void>;
};

vi.mock('../lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/billing')>();
  return {
    ...actual,
    useSubscriptionContext: () => subscriptionState,
    startProCheckout: mockStartProCheckout,
    startTopup: mockStartTopup,
    startPlanChange: mockStartPlanChange,
    openBillingPortal: mockOpenBillingPortal,
    isLowCredit: () => false,
    isOutOfCredits: () => false,
    formatCredits: (cents: number) => `${cents}`,
  };
});

function Harness() {
  const { elRef, anchorRect, toggle, close } = useAccountPopoverTrigger<HTMLButtonElement>();
  return (
    <>
      <button ref={elRef} data-testid="account-trigger" onClick={toggle}>
        Account
      </button>
      {anchorRect && <AccountPopover anchorRect={anchorRect} onClose={close} triggerRef={elRef} />}
    </>
  );
}

function renderOpenPopover() {
  render(
    <I18nProvider>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </I18nProvider>,
  );
  fireEvent.click(screen.getByTestId('account-trigger'));
}

beforeEach(() => {
  mockStartTopup.mockClear();
  mockStartPlanChange.mockClear();
  mockStartProCheckout.mockClear();
  mockOpenBillingPortal.mockClear();
  mockRefresh.mockClear();
});

describe('AccountPopover — free user section (unchanged)', () => {
  it('shows the two upgrade CTAs and no manage/topup entries', () => {
    subscriptionState = { subscription: null, isPro: false, isProPlus: false, refresh: mockRefresh };
    renderOpenPopover();

    // I18nProvider resolves to English in this test environment (no saved
    // locale preference / matching navigator.language) — assert against the
    // rendered locale rather than assuming French.
    expect(screen.getByText('Upgrade to Pro')).toBeInTheDocument();
    expect(screen.getByText('Upgrade to Pro+')).toBeInTheDocument();
    expect(screen.queryByTestId('topup-expand-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-proplus-btn')).not.toBeInTheDocument();
  });
});

describe('AccountPopover — Pro+ upgrade button', () => {
  it('Pro (not Pro+) sees the upgrade button', () => {
    subscriptionState = {
      subscription: { credits_remaining_cents: 1000, status: 'active' },
      isPro: true,
      isProPlus: false,
      refresh: mockRefresh,
    };
    renderOpenPopover();

    expect(screen.getByTestId('upgrade-proplus-btn')).toBeInTheDocument();
  });

  it('Pro+ does NOT see the upgrade button', () => {
    subscriptionState = {
      subscription: { credits_remaining_cents: 1000, status: 'active' },
      isPro: true,
      isProPlus: true,
      refresh: mockRefresh,
    };
    renderOpenPopover();

    expect(screen.queryByTestId('upgrade-proplus-btn')).not.toBeInTheDocument();
  });

  it('requires two clicks and calls startPlanChange once, then refreshes', async () => {
    subscriptionState = {
      subscription: { credits_remaining_cents: 1000, status: 'active' },
      isPro: true,
      isProPlus: false,
      refresh: mockRefresh,
    };
    renderOpenPopover();

    const btn = screen.getByTestId('upgrade-proplus-btn');
    fireEvent.click(btn);
    expect(mockStartPlanChange).not.toHaveBeenCalled();
    expect(screen.getByText('€60/month — prorated charge billed immediately')).toBeInTheDocument();

    fireEvent.click(btn);

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(mockStartPlanChange).toHaveBeenCalledTimes(1);
    expect(mockStartPlanChange).toHaveBeenCalledWith('pro_plus');
  });

  it('shows the error inline and does not crash on failure', async () => {
    mockStartPlanChange.mockResolvedValueOnce({ error: 'Paiement refusé' });
    subscriptionState = {
      subscription: { credits_remaining_cents: 1000, status: 'active' },
      isPro: true,
      isProPlus: false,
      refresh: mockRefresh,
    };
    renderOpenPopover();

    const btn = screen.getByTestId('upgrade-proplus-btn');
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByText('Paiement refusé')).toBeInTheDocument());
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('AccountPopover — inline top-up form', () => {
  beforeEach(() => {
    subscriptionState = {
      subscription: { credits_remaining_cents: 1000, status: 'active' },
      isPro: true,
      isProPlus: true,
      refresh: mockRefresh,
    };
  });

  it('expands on click and disables confirm for an invalid amount', () => {
    renderOpenPopover();
    fireEvent.click(screen.getByTestId('topup-expand-btn'));

    const input = screen.getByTestId('topup-custom-input');
    fireEvent.change(input, { target: { value: '0' } });

    expect(screen.getByTestId('topup-confirm-btn')).toBeDisabled();
  });

  it('enables confirm on a valid preset click and calls startTopup with that amount', () => {
    renderOpenPopover();
    fireEvent.click(screen.getByTestId('topup-expand-btn'));

    fireEvent.click(screen.getByTestId('topup-preset-50'));
    const confirmBtn = screen.getByTestId('topup-confirm-btn');
    expect(confirmBtn).not.toBeDisabled();

    fireEvent.click(confirmBtn);

    expect(mockStartTopup).toHaveBeenCalledTimes(1);
    expect(mockStartTopup).toHaveBeenCalledWith(50);
  });

  it('inner interactions (typing/clicking) never dismiss the popover', () => {
    renderOpenPopover();
    fireEvent.click(screen.getByTestId('topup-expand-btn'));

    const input = screen.getByTestId('topup-custom-input');
    fireEvent.pointerDown(input);
    fireEvent.change(input, { target: { value: '25' } });
    fireEvent.pointerDown(screen.getByTestId('topup-preset-100'));
    fireEvent.click(screen.getByTestId('topup-preset-100'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
