/**
 * AccountPopover.dismissal.test.tsx — founder bug fix audit (2026-07-22):
 * the same close-then-reopen race CockpitRailPopover.tsx/
 * CanvasFloatingButtons.tsx already got fixed (useDismissable.ts) also
 * affected this shared billing popover — it's portaled to `document.body`,
 * so its own outside-pointerdown listener used to see whichever trigger
 * opened it (AccountChip.tsx's header chip / KpiGroup.tsx's "CRÉDITS" tile /
 * HomeKpiBar.tsx's credits tile) as "outside" (different DOM subtree),
 * closing the popover, followed by the trigger's own onClick toggle
 * (reading the now-stale closed state) reopening it. Now goes through the
 * shared useDismissable hook with a `triggerRef` — every real caller
 * forwards its own useAccountPopoverTrigger() elRef, see AccountChip.tsx/
 * KpiGroup.tsx/HomeKpiBar.tsx.
 *
 * This suite exercises AccountPopover + useAccountPopoverTrigger directly
 * (the shared wrapper, not any one caller's surrounding UI) via a minimal
 * harness, same shape every real trigger uses.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AccountPopover, useAccountPopoverTrigger } from '../components/account/AccountPopover';

afterEach(cleanup);

vi.mock('../lib/billing', () => ({
  useSubscriptionContext: () => ({ subscription: null, isPro: false }),
  startProCheckout: vi.fn(),
  startTopup: vi.fn(),
  openBillingPortal: vi.fn(),
  isLowCredit: () => false,
  isOutOfCredits: () => false,
  formatCredits: (cents: number) => `${cents}`,
}));

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

function renderHarness() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('AccountPopover — dismissal (founder bug fix)', () => {
  it('opens on click', () => {
    renderHarness();
    fireEvent.click(screen.getByTestId('account-trigger'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('re-clicking the same trigger while open closes it (does not reopen)', () => {
    renderHarness();
    const trigger = screen.getByTestId('account-trigger');

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Real browsers fire pointerdown before click for a single re-click —
    // fire both explicitly (fireEvent.click alone can't reproduce the race
    // this is guarding against, see useDismissable.test.tsx).
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking outside the popover closes it', () => {
    renderHarness();
    fireEvent.click(screen.getByTestId('account-trigger'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pressing Escape closes it', () => {
    renderHarness();
    fireEvent.click(screen.getByTestId('account-trigger'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
