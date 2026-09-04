/**
 * RegimeStatusCard — tests for the three regime lifecycle states and the
 * revert-to-trial / stop gestures.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { RegimeStatusCard } from '../components/lazyManager/RegimeStatusCard';
import type { RegimeStatus } from '../components/lazyManager/missionCharter';

function renderRegime(regime: RegimeStatus, overrides: Partial<React.ComponentProps<typeof RegimeStatusCard>> = {}) {
  const onRevertToTrial = vi.fn();
  const onStop = vi.fn();
  render(
    <I18nProvider>
      <RegimeStatusCard regime={regime} onRevertToTrial={onRevertToTrial} onStop={onStop} {...overrides} />
    </I18nProvider>,
  );
  return { onRevertToTrial, onStop };
}

describe('RegimeStatusCard', () => {
  it('shows the trial state with its approved/threshold counter', () => {
    renderRegime({ id: 'r1', label: 'Daily posting regime', state: 'trial', trialApproved: 2, trialThreshold: 3 });
    expect(screen.getByTestId('regime-state-r1')).toHaveTextContent('2');
    expect(screen.getByTestId('regime-state-r1')).toHaveTextContent('3');
  });

  it('shows the validated state', () => {
    renderRegime({ id: 'r2', label: 'Daily posting regime', state: 'validated', trialApproved: 3, trialThreshold: 3 });
    expect(screen.getByTestId('regime-state-r2')).toBeInTheDocument();
  });

  it('shows the autonomous state', () => {
    renderRegime({ id: 'r3', label: 'Daily posting regime', state: 'autonomous', trialApproved: 3, trialThreshold: 3 });
    expect(screen.getByTestId('regime-state-r3')).toBeInTheDocument();
  });

  it('shows the self-improving state', () => {
    renderRegime({ id: 'r3b', label: 'Daily posting regime', state: 'self_improving', trialApproved: 3, trialThreshold: 3 });
    expect(screen.getByTestId('regime-state-r3b')).toBeInTheDocument();
  });

  it('does not show a revert button while already in trial', () => {
    renderRegime({ id: 'r4', label: 'Daily posting regime', state: 'trial', trialApproved: 1, trialThreshold: 3 });
    expect(screen.queryByTestId('regime-revert-r4')).not.toBeInTheDocument();
    expect(screen.getByTestId('regime-stop-r4')).toBeInTheDocument();
  });

  it('reverts an autonomous regime to trial on click', () => {
    const { onRevertToTrial } = renderRegime({ id: 'r5', label: 'Daily posting regime', state: 'autonomous', trialApproved: 3, trialThreshold: 3 });
    fireEvent.click(screen.getByTestId('regime-revert-r5'));
    expect(onRevertToTrial).toHaveBeenCalledWith('r5');
  });

  it('stops a regime on click regardless of state', () => {
    const { onStop } = renderRegime({ id: 'r6', label: 'Daily posting regime', state: 'validated', trialApproved: 3, trialThreshold: 3 });
    fireEvent.click(screen.getByTestId('regime-stop-r6'));
    expect(onStop).toHaveBeenCalledWith('r6');
  });

  // NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — revert/stop used
  // to silently no-op when clicked while the manager was busy. This card has
  // no resolved/pending concept of its own (both are "always available" —
  // see this file's own module header), so the fix is just: never drop the
  // click, and show why the button is momentarily disabled.
  describe('queued action feedback (bug fix: silent drop while busy)', () => {
    it('disables Stop and shows a queued note while the stop action is queued', () => {
      renderRegime({ id: 'r7', label: 'Daily posting regime', state: 'validated', trialApproved: 3, trialThreshold: 3 }, { isStopQueued: true });
      expect(screen.getByTestId('regime-stop-r7')).toBeDisabled();
      expect(screen.getByTestId('regime-queued-r7')).toBeInTheDocument();
    });

    it('disables Revert and shows a queued note while the revert action is queued', () => {
      renderRegime({ id: 'r8', label: 'Daily posting regime', state: 'autonomous', trialApproved: 3, trialThreshold: 3 }, { isRevertQueued: true });
      expect(screen.getByTestId('regime-revert-r8')).toBeDisabled();
      expect(screen.getByTestId('regime-queued-r8')).toBeInTheDocument();
    });

    it('keeps both buttons enabled and shows no queued note when nothing is queued', () => {
      renderRegime({ id: 'r9', label: 'Daily posting regime', state: 'autonomous', trialApproved: 3, trialThreshold: 3 });
      expect(screen.getByTestId('regime-revert-r9')).not.toBeDisabled();
      expect(screen.getByTestId('regime-stop-r9')).not.toBeDisabled();
      expect(screen.queryByTestId('regime-queued-r9')).not.toBeInTheDocument();
    });
  });
});
