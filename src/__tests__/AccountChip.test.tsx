/**
 * AccountChip.test.tsx
 *
 * BUG-3(b)/(c): the header credits badge must refresh the shared
 * subscription context when a `billing:walletMaybeStale` bus event fires —
 * emitted (5s-coalesced, see managedProvider.ts's notifyWalletMaybeStale)
 * whenever a no_credits wall is hit or a mission spend settles. Before this
 * fix the badge only refreshed on its own fetch's polling cadence, so it
 * could show a stale "Pro 1155" for tens of minutes after the real balance
 * hit 0 while the Compte page already showed the truth.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { emit } from '../lib/bus';

const mockRefresh = vi.fn();
const subscriptionState = {
  subscription: { credits_remaining_cents: 1155, status: 'active' } as unknown as {
    credits_remaining_cents: number;
    status: string;
  },
  loading: false,
  isPro: true,
  refresh: mockRefresh,
};

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({ t: (key: string) => key }),
}));

vi.mock('../lib/billing', () => ({
  useSubscriptionContext: () => subscriptionState,
  isLowCredit: () => false,
  isOutOfCredits: () => false,
  formatCredits: (cents: number) => `${cents}`,
}));

vi.mock('../components/account/AccountPopover', () => ({
  AccountPopover: () => null,
  CoinIcon: () => null,
  useAccountPopoverTrigger: () => ({
    elRef: { current: null },
    anchorRect: null,
    toggle: vi.fn(),
    close: vi.fn(),
  }),
}));

import { AccountChip } from '../components/AccountChip';

beforeEach(() => {
  mockRefresh.mockClear();
});

describe('AccountChip — billing:walletMaybeStale refresh (BUG-3)', () => {
  it('calls refresh() when the wallet-maybe-stale event fires on the bus', () => {
    render(<AccountChip />);

    emit('billing:walletMaybeStale', undefined);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call refresh() on mount, before any event fires', () => {
    render(<AccountChip />);

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount — a later event does not call a stale refresh handle', () => {
    const { unmount } = render(<AccountChip />);
    unmount();

    emit('billing:walletMaybeStale', undefined);

    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
