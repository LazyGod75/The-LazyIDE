/* ScorecardPanelI18nEnglish.test.tsx — regression test for hardcoded French.
   ScorecardPanel.tsx used to render its loading/empty-state/footer copy as
   raw French strings regardless of the active locale ("Chargement du
   scorecard…", "Aucune donnée disponible", "Scorecard calculé depuis…").
   This renders the panel under an English I18nProvider (same convention as
   RulesPanelI18nEnglish.test.tsx / HealthPanelI18nEnglish.test.tsx) and
   asserts none of the known French copy leaks through.
*/

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ScorecardPanel } from '../components/agents/cockpit/ScorecardPanel';

// Non-Tauri (jsdom) — ScorecardPanel's effect short-circuits to
// setLoading(false) with no scorecard, landing on the empty-state branch.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, isTauri: () => false };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe('ScorecardPanel — renders in English with no hardcoded French', () => {
  it('shows the English empty-state copy, not the French original', async () => {
    localStorage.setItem('lazy.locale', 'en');

    render(<ScorecardPanel />, { wrapper });

    expect(await screen.findByText('No data available')).toBeInTheDocument();

    localStorage.removeItem('lazy.locale');
  });

  it('contains none of the known French strings the panel previously hardcoded', async () => {
    localStorage.setItem('lazy.locale', 'en');

    const { container } = render(<ScorecardPanel />, { wrapper });
    await screen.findByText('No data available');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Chargement du scorecard/);
    expect(text).not.toMatch(/Aucune donnée disponible/);
    expect(text).not.toMatch(/Scorecard calculé depuis/);
    expect(text).not.toMatch(/événements du journal/);

    localStorage.removeItem('lazy.locale');
  });
});
