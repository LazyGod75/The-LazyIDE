/**
 * onboardingStepSet.test.tsx
 *
 * Regression test for the "existing account, new device" onboarding gap: an
 * existing account installing Lazy on a brand-new machine sees onboarding
 * (local "onboarded" flag absent on this device), but previously got the
 * condensed Welcome->Finish flow instead of the full wizard — so it never
 * saw the Brain step, which is the whole point of first-run onboarding.
 *
 * Fix: OnboardingModal's FULL_STEPS vs CONDENSED_STEPS choice now keys off
 * `isFirstRunOnDevice` (default true), not `isNewAccount` (created_at-based).
 * The only production call site (AppShell) mounts this modal exclusively
 * when useOnboarding().showOnboarding is true — i.e. exactly when there is
 * no local onboarded flag for this device — so leaving `isFirstRunOnDevice`
 * at its default reproduces that real "first run on this device" condition.
 * `isNewAccount` now only affects the Welcome step's greeting copy.
 *
 * Note: the "Brain" step-indicator label and the Welcome step's own "Brain"
 * feature-list item share the same translated string ("Brain"), so presence
 * of the Brain STEP is asserted via occurrence count (2 = indicator + feature
 * card, 1 = feature card only) rather than a single getByText lookup. The
 * "Model" step label has no such collision and is used as the primary,
 * unambiguous signal for which step set is active.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { OnboardingModal } from '../components/onboarding/OnboardingModal';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';

type OnboardingModalProps = React.ComponentProps<typeof OnboardingModal>;

function renderModal(props: Partial<OnboardingModalProps> = {}) {
  const onComplete = vi.fn();
  render(
    <I18nProvider>
      <OnboardingModal onComplete={onComplete} {...props} />
    </I18nProvider>,
  );
  return { onComplete };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'en');
});

describe('OnboardingModal — step set follows first-run-on-device, not account age', () => {
  it('shows the full wizard (incl. the Brain step) for an existing account, as long as it is a first run on this device', async () => {
    // isNewAccount=false simulates an existing (old) account. No
    // isFirstRunOnDevice override simulates the real AppShell call site,
    // which only ever mounts this modal when showOnboarding — i.e. first
    // run on this device — is true.
    renderModal({ isNewAccount: false });

    expect(await screen.findByText(en['onboarding.welcome'])).toBeInTheDocument();
    expect(screen.getByText(en['onboarding.model'])).toBeInTheDocument();
    expect(screen.getAllByText(en['onboarding.brain'])).toHaveLength(2); // step label + feature card
    expect(screen.getByText(en['onboarding.finish'])).toBeInTheDocument();
  });

  it('still shows the full wizard for a brand-new account (unchanged behavior)', async () => {
    renderModal({ isNewAccount: true });

    expect(await screen.findByText(en['onboarding.model'])).toBeInTheDocument();
    expect(screen.getAllByText(en['onboarding.brain'])).toHaveLength(2);
  });

  it('keeps the condensed Welcome->Finish path reachable for a caller that explicitly opts out', async () => {
    renderModal({ isNewAccount: false, isFirstRunOnDevice: false });

    expect(await screen.findByText(en['onboarding.welcome'])).toBeInTheDocument();
    expect(screen.queryByText(en['onboarding.model'])).toBeNull();
    expect(screen.getAllByText(en['onboarding.brain'])).toHaveLength(1); // feature card only, no step label
    expect(screen.getByText(en['onboarding.finish'])).toBeInTheDocument();
  });
});
