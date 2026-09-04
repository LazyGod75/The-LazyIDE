/**
 * onboardingModelStep.test.tsx
 *
 * v0.1.5 W3.3 — onboarding "model" step honesty. The step now presents the
 * 3 real access modes (cli/byok/pro) with LIVE detection via the same
 * getEngineReadiness() used everywhere else (mission/composer preflight,
 * locked managed models), instead of a home-grown binary configured/missing
 * check. CLI is marked "recommended" when detected ready. Picking a mode
 * writes accessMode through the same saveAccessSettings() path Settings uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ModelCheckStep } from '../components/onboarding/steps/ModelCheckStep';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import { getEngineReadiness } from '../lib/models/entitlement';
import { loadAccessSettings } from '../lib/models/accessSettings';

vi.mock('../lib/models/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/entitlement')>();
  return { ...actual, getEngineReadiness: vi.fn() };
});

vi.mock('../lib/models/cliBackendProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/cliBackendProvider')>();
  return { ...actual, detectAllCliBackends: vi.fn().mockResolvedValue(undefined) };
});

const mockedReadiness = vi.mocked(getEngineReadiness);

function readinessFor(mode: string): { mode: 'cli' | 'byok' | 'pro'; ready: boolean; reason?: 'cli-not-found' | 'byok-no-key' | 'pro-inactive' | 'pro-no-credits' } {
  if (mode === 'cli') return { mode: 'cli', ready: true };
  if (mode === 'byok') return { mode: 'byok', ready: false, reason: 'byok-no-key' };
  return { mode: 'pro', ready: false, reason: 'pro-inactive' };
}

function renderStep(onNext = vi.fn(), onBack = vi.fn()) {
  render(
    <I18nProvider>
      <ModelCheckStep onNext={onNext} onBack={onBack} />
    </I18nProvider>,
  );
  return { onNext, onBack };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  mockedReadiness.mockImplementation((forMode) => readinessFor(forMode ?? 'cli'));
});

describe('ModelCheckStep — 3-mode live detection (W3.3)', () => {
  it('renders all 3 modes with their live detection state', async () => {
    renderStep();

    expect(await screen.findByText(fr['onboarding.model.mode.cli'])).toBeInTheDocument();
    expect(screen.getByText(fr['onboarding.model.mode.byok'])).toBeInTheDocument();
    expect(screen.getByText(fr['onboarding.model.mode.pro'])).toBeInTheDocument();

    // CLI is ready -> honest "ready" one-liner, not a blocking reason.
    expect(screen.getByText(fr['onboarding.model.ready'])).toBeInTheDocument();
    // BYOK/Pro are not ready -> the SAME reason copy used by every other
    // preflight surface (mission modal, composer), never bespoke text.
    expect(screen.getByText(fr['engine.reason.byok-no-key'])).toBeInTheDocument();
    expect(screen.getByText(fr['engine.reason.pro-inactive'])).toBeInTheDocument();
  });

  it('marks CLI as "recommended" once it is detected ready', async () => {
    renderStep();
    await screen.findByText(fr['onboarding.model.mode.cli']);
    expect(screen.getAllByText(fr['onboarding.model.recommended'])).toHaveLength(1);
  });

  it('does not recommend any mode when CLI is not detected', async () => {
    mockedReadiness.mockImplementation((forMode) => {
      if (forMode === 'cli') return { mode: 'cli', ready: false, reason: 'cli-not-found' };
      return readinessFor(forMode ?? 'byok');
    });
    renderStep();
    await screen.findByText(fr['onboarding.model.mode.cli']);
    expect(screen.queryByText(fr['onboarding.model.recommended'])).toBeNull();
  });

  it('selecting a mode writes accessMode through saveAccessSettings (same path Settings uses)', async () => {
    renderStep();
    fireEvent.click(await screen.findByText(fr['onboarding.model.mode.byok']));

    await waitFor(() => {
      expect(loadAccessSettings().accessMode).toBe('byok');
    });
  });

  it('never hard-blocks: Continuer always proceeds regardless of readiness', async () => {
    const { onNext } = renderStep();
    fireEvent.click(await screen.findByText(fr['onboarding.model.continue']));
    expect(onNext).toHaveBeenCalled();
  });

  it('Retour calls onBack', async () => {
    const { onBack } = renderStep();
    fireEvent.click(await screen.findByText(fr['onboarding.model.back']));
    expect(onBack).toHaveBeenCalled();
  });
});
