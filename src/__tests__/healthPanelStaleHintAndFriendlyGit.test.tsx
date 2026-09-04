/**
 * healthPanelStaleHintAndFriendlyGit.test.tsx
 *
 * Regression coverage for two of the three Settings > Health defects
 * observed live 2026-08-14 (the third — the git check probing the wrong
 * directory — is covered separately in healthPanelGitCheck.test.ts, since
 * that one lives in the platform layer, not the panel):
 *
 * 1. Stale instruction text: after a check has run, the panel kept
 *    showing "Click Refresh to run a health check..." right alongside the
 *    results, as if no check had happened yet. That line must only show
 *    before the first run.
 *
 * 2. Dev-speak leaking to the user: a raw platform-layer string like
 *    "'.' is outside every registered project root (8 checked)" is not
 *    actionable. The git row must show a plain-language explanation
 *    instead, driven purely by the reported HealthStatus.
 *
 * The first test below (French locale) pins the exact repro reported live
 * with the UI set to French: click "Actualiser", results land, and the
 * "Cliquez sur Actualiser..." hint must not remain underneath them.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { HealthPanel } from '../components/settings/HealthPanel';
import { en } from '../i18n/locales/en';
import { fr } from '../i18n/locales/fr';
import { de } from '../i18n/locales/de';
import { es } from '../i18n/locales/es';
import { ja } from '../i18n/locales/ja';
import { zh } from '../i18n/locales/zh';

function wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe('HealthPanel — stale hint text and friendly git messaging', () => {
  it('French locale: hides the "Cliquez sur Actualiser..." hint once a check has run (live repro)', async () => {
    localStorage.setItem('lazy.locale', 'fr');

    render(<HealthPanel />, { wrapper });

    // Before any check: hint is visible, with correct accents.
    expect(
      screen.getByText('Cliquez sur Actualiser pour lancer une vérification de santé des composants plateforme.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Actualiser'));

    // After the check resolves and a timestamp is showing: hint must be gone.
    await waitFor(() => {
      expect(screen.queryByText('Vérification...')).toBeNull();
    });
    expect(
      screen.queryByText('Cliquez sur Actualiser pour lancer une vérification de santé des composants plateforme.')
    ).toBeNull();
    expect(screen.queryByText(/Cliquez sur Actualiser/)).toBeNull();

    localStorage.removeItem('lazy.locale');
  });

  it('shows the "Click Refresh..." hint before the first check, and hides it once results are showing', async () => {
    localStorage.setItem('lazy.locale', 'en');

    render(<HealthPanel />, { wrapper });

    // Before any check: hint is visible.
    expect(screen.getByText(/Click Refresh to run a health check/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Refresh'));

    // After the check resolves: hint must be gone, results are showing.
    await waitFor(() => {
      expect(screen.queryByText('Checking...')).toBeNull();
    });
    expect(screen.queryByText(/Click Refresh to run a health check/)).toBeNull();

    localStorage.removeItem('lazy.locale');
  });

  it('shows a plain-language message for the Git row instead of raw platform-layer text', async () => {
    localStorage.setItem('lazy.locale', 'en');

    render(<HealthPanel />, { wrapper });
    fireEvent.click(screen.getByText('Refresh'));

    await waitFor(() => {
      expect(screen.queryByText('Checking...')).toBeNull();
    });

    // The web demo platform reports git as 'unknown' — the friendly
    // no-project message must be shown, never dev-speak.
    expect(await screen.findByText('No project is open — open a project to check Git.')).toBeInTheDocument();
    expect(screen.queryByText(/outside every registered project root/)).toBeNull();

    localStorage.removeItem('lazy.locale');
  });

  it('settings.health.errorNotAvailable never names the internal method or workstream codename, in any locale', () => {
    // Regression for a leaked implementation detail found during the
    // 2026-08-15 copy audit: this string used to read literally
    // "platform.health() not yet available — waiting for PLATFORM-C." in
    // all six locales — a raw method reference plus an internal workstream
    // codename shown straight in the Settings > Health error banner.
    const dicts: Array<[string, Record<string, string>]> = [
      ['en', en], ['fr', fr], ['de', de], ['es', es], ['ja', ja], ['zh', zh],
    ];
    for (const [locale, dict] of dicts) {
      const value = dict['settings.health.errorNotAvailable'];
      expect(value, `missing key in ${locale}`).toBeTruthy();
      expect(value, `${locale} leaks platform.health()`).not.toMatch(/platform\.health\(\)/);
      expect(value, `${locale} leaks PLATFORM-C codename`).not.toMatch(/PLATFORM-C/);
    }
  });
});
