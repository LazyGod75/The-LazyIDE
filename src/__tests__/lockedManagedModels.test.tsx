/**
 * lockedManagedModels.test.tsx
 *
 * v0.1.5 W2.8 — the managed (Pro) model catalog locks honestly without
 * entitlement. When getEngineReadiness('pro') is not ready, the catalog
 * stays VISIBLE but every entry is disabled (lock glyph + Pro chip) and a
 * single callout above the list explains why, with a "Passer Pro" action
 * navigating to Settings > Account. With entitlement, everything stays
 * selectable exactly as before.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ModelPicker } from '../components/settings/ModelPicker';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import { getEngineReadiness } from '../lib/models/entitlement';
import { emit } from '../lib/bus';

vi.mock('../lib/models/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/entitlement')>();
  return { ...actual, getEngineReadiness: vi.fn() };
});

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
}));

const mockedReadiness = vi.mocked(getEngineReadiness);
const mockedEmit = vi.mocked(emit);

function renderPicker() {
  render(
    <I18nProvider>
      <ModelPicker />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  mockedReadiness.mockReturnValue({ mode: 'pro', ready: true });
});

describe('ModelPicker — locked managed catalog', () => {
  it('checks the Pro entitlement specifically (forMode pro)', () => {
    renderPicker();
    expect(mockedReadiness).toHaveBeenCalledWith('pro');
  });

  it('not entitled: catalog stays visible but every entry is disabled', () => {
    mockedReadiness.mockReturnValue({ mode: 'pro', ready: false, reason: 'pro-inactive' });
    renderPicker();

    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(0);
    expect(radios.every((r) => (r as HTMLInputElement).disabled)).toBe(true);
  });

  it('not entitled: a single callout above the list states the reason with the Passer Pro action', () => {
    mockedReadiness.mockReturnValue({ mode: 'pro', ready: false, reason: 'pro-no-credits' });
    renderPicker();

    const callouts = screen.getAllByTestId('managed-locked-callout');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]).toHaveTextContent(fr['engine.reason.pro-no-credits']);
    expect(screen.getByText(fr['engine.preflight.goPro'])).toBeInTheDocument();
  });

  it('"Passer Pro" navigates to Settings > Account', () => {
    mockedReadiness.mockReturnValue({ mode: 'pro', ready: false, reason: 'pro-inactive' });
    renderPicker();

    fireEvent.click(screen.getByText(fr['engine.preflight.goPro']));

    expect(mockedEmit).toHaveBeenCalledWith('nav:navigateSpace', 'account');
  });

  it('not entitled: clicking an entry never persists a model selection', () => {
    mockedReadiness.mockReturnValue({ mode: 'pro', ready: false, reason: 'pro-inactive' });
    renderPicker();

    const radios = screen.getAllByRole('radio');
    fireEvent.click(radios[radios.length - 1]);

    expect(localStorage.getItem('lazy.accessSettings')).toBeNull();
  });

  it('entitled: no callout, entries stay enabled and selectable (unchanged behavior)', () => {
    mockedReadiness.mockReturnValue({ mode: 'pro', ready: true });
    renderPicker();

    expect(screen.queryByTestId('managed-locked-callout')).not.toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.some((r) => (r as HTMLInputElement).disabled)).toBe(false);

    // Pick the LAST entry — never the default selection, so the change
    // event actually fires and persists.
    fireEvent.click(radios[radios.length - 1]);
    expect(localStorage.getItem('lazy.accessSettings')).not.toBeNull();
  });
});
