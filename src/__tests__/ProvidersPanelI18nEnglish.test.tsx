/* ProvidersPanelI18nEnglish.test.tsx — regression test for hardcoded French
   leaking into Settings > Models > "Available engines".

   ProvidersPanel renders one BackendCard per lib/models/readiness.ts
   descriptor. Those descriptors used to hardcode their label/reason/
   howToEnable strings in French regardless of locale (e.g. "Claude Code
   (abonnement)", "Clé API DeepSeek (BYOK)") — observed live with the
   interface language set to English. ProvidersPanel now passes its own
   useI18n().t into getAllBackendsReadiness(t); this test mounts the real
   component under an English I18nProvider and asserts none of the
   previously hardcoded French leaks through the wiring.
*/

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ProvidersPanel } from '../components/settings/ProvidersPanel';

function wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe('ProvidersPanel — "Available engines" renders in English with no hardcoded French', () => {
  it('shows the English section title and card labels', async () => {
    localStorage.setItem('lazy.locale', 'en');

    render(<ProvidersPanel />, { wrapper });

    expect(await screen.findByText('Available engines')).toBeInTheDocument();
    expect(screen.getByText('Claude Code (subscription)')).toBeInTheDocument();
    expect(screen.getByText(/DeepSeek API key \(BYOK\)/)).toBeInTheDocument();

    localStorage.removeItem('lazy.locale');
  });

  it('contains none of the known French strings the panel previously hardcoded', async () => {
    localStorage.setItem('lazy.locale', 'en');

    const { container } = render(<ProvidersPanel />, { wrapper });
    await screen.findByText('Available engines');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/abonnement/i);
    expect(text).not.toMatch(/Clé API/i);
    expect(text).not.toMatch(/géré par Lazy/i);
    expect(text).not.toMatch(/introuvable sur PATH/i);
    expect(text).not.toMatch(/Réglages >/);

    localStorage.removeItem('lazy.locale');
  });
});
