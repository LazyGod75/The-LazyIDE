/* RulesPanelI18nEnglish.test.tsx — regression test for hardcoded French.
   RulesPanel.tsx used to render its header, buttons, placeholders and
   status notes as raw French strings regardless of the active locale
   (useI18n() was imported but only wired to a single `t('common.refresh')`
   call). This renders the panel under an English I18nProvider and asserts
   none of the known French copy leaks through.
*/

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { RulesPanel } from '../components/agents/RulesPanel';

vi.mock('../lib/agents/harnessRules', () => ({
  listRules: vi.fn().mockResolvedValue([]),
  captureRule: vi.fn().mockResolvedValue(null),
  importProjectOnboardingFile: vi.fn().mockResolvedValue(0),
  writeAgentsMdProjection: vi.fn().mockResolvedValue({ written: false, reason: 'no project' }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe('RulesPanel — renders in English with no hardcoded French', () => {
  it('shows English copy for header, buttons and empty state', async () => {
    localStorage.setItem('lazy.locale', 'en');

    render(<RulesPanel />, { wrapper });

    expect(await screen.findByText('Harness rules')).toBeInTheDocument();
    expect(screen.getByText(/Import \(\.cursorrules/)).toBeInTheDocument();
    expect(screen.getByText('Generate AGENTS.md')).toBeInTheDocument();
    expect(await screen.findByText(/No rules yet\. Add one manually/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/New rule \(e\.g\. always run tests/)).toBeInTheDocument();
    expect(screen.getByText('Add')).toBeInTheDocument();

    localStorage.removeItem('lazy.locale');
  });

  it('contains none of the known French strings the panel previously hardcoded', async () => {
    localStorage.setItem('lazy.locale', 'en');

    const { container } = render(<RulesPanel />, { wrapper });
    await screen.findByText('Harness rules');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Règles de harness/);
    expect(text).not.toMatch(/Générer AGENTS\.md/);
    expect(text).not.toMatch(/Aucune règle/);
    expect(text).not.toMatch(/Chargement des règles/);
    expect(text).not.toContain('Ajouter');

    localStorage.removeItem('lazy.locale');
  });
});
