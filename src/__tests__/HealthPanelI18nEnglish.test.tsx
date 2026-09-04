/* HealthPanelI18nEnglish.test.tsx — regression test for hardcoded French.

   HealthPanel.tsx used to render its entire Settings > Health tab in raw
   French regardless of the active locale: the summary line ("En attente de
   verification"), the refresh button ("Actualiser" / "Verification..."),
   the hint ("Cliquez sur Actualiser pour lancer une verification de sante
   des composants plateforme." — itself missing accents on "vérification"
   and "santé"), the Eval Harness section ("Lancer le harness",
   "Exécution...", "réussis"), and error strings. This was flagged as a
   known follow-up in af5f474 (i18n: extract hardcoded French strings from
   RulesPanel and SkillsPanel) and observed live by the owner with the
   interface language set to English.

   This renders the panel under an English I18nProvider and asserts the
   known-good English copy appears and none of the previously hardcoded
   French strings leak through.
*/

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { HealthPanel } from '../components/settings/HealthPanel';

function wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe('HealthPanel — renders in English with no hardcoded French', () => {
  it('shows English copy for the summary, refresh button, row labels and hint', async () => {
    localStorage.setItem('lazy.locale', 'en');

    render(<HealthPanel />, { wrapper });

    expect(await screen.findByText('Waiting for check')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Brain')).toBeInTheDocument();
    expect(screen.getByText('Git')).toBeInTheDocument();
    expect(screen.getByText('Terminal')).toBeInTheDocument();
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Agent Runner')).toBeInTheDocument();
    expect(screen.getByText(/Click Refresh to run a health check/)).toBeInTheDocument();
    expect(screen.getByText('Eval harness')).toBeInTheDocument();
    expect(screen.getByText('Run harness')).toBeInTheDocument();

    localStorage.removeItem('lazy.locale');
  });

  it('contains none of the known French strings the panel previously hardcoded (static state)', async () => {
    localStorage.setItem('lazy.locale', 'en');

    const { container } = render(<HealthPanel />, { wrapper });
    await screen.findByText('Waiting for check');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/En attente de verification/);
    expect(text).not.toMatch(/Actualiser/);
    expect(text).not.toMatch(/verification de sante/i);
    expect(text).not.toMatch(/Lancer le harness/);
    expect(text).not.toContain('Tous les composants OK');
    expect(text).not.toContain('Problemes detectes');

    localStorage.removeItem('lazy.locale');
  });

  it('contains none of the known French strings after a refresh click (loading + result state)', async () => {
    localStorage.setItem('lazy.locale', 'en');

    const { container } = render(<HealthPanel />, { wrapper });
    await screen.findByText('Waiting for check');

    fireEvent.click(screen.getByText('Refresh'));

    // Loading state briefly shows "Checking..." (was "Verification...").
    await waitFor(() => {
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/^Verification\.\.\./m);
    });

    // Let the async platform.health() call resolve.
    await waitFor(() => {
      expect(screen.queryByText('Checking...')).toBeNull();
    });

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Verification\.\.\./);
    expect(text).not.toMatch(/Tous les composants OK/);
    expect(text).not.toMatch(/Problemes detectes/);

    localStorage.removeItem('lazy.locale');
  });
});
