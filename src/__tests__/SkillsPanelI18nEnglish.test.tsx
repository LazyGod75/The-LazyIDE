/* SkillsPanelI18nEnglish.test.tsx — regression test for hardcoded French.
   SkillsPanel.tsx used to render its title, placeholders, buttons and
   empty/loading states as raw French strings regardless of the active
   locale. This renders the panel under an English I18nProvider and
   asserts none of the known French copy leaks through.
*/

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { SkillsPanel } from '../components/agents/SkillsPanel';

vi.mock('../lib/agents/skillInjection', () => ({
  loadAllSkills: vi.fn().mockResolvedValue([]),
  saveSkill: vi.fn().mockResolvedValue(undefined),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

describe('SkillsPanel — renders in English with no hardcoded French', () => {
  it('shows English copy for placeholders, buttons and empty state', async () => {
    localStorage.setItem('lazy.locale', 'en');

    render(<SkillsPanel />, { wrapper });

    expect(await screen.findByText(/No skills in the brain yet\. Create one above\./)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Skill name \(e\.g\. e2e-playwright\)/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Instructions, steps, tool usage/)).toBeInTheDocument();
    expect(screen.getByText('Save skill')).toBeInTheDocument();

    localStorage.removeItem('lazy.locale');
  });

  it('contains none of the known French strings the panel previously hardcoded', async () => {
    localStorage.setItem('lazy.locale', 'en');

    const { container } = render(<SkillsPanel />, { wrapper });
    await screen.findByText(/No skills in the brain yet/);

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Nom du skill/);
    expect(text).not.toMatch(/Enregistrer le skill/);
    expect(text).not.toMatch(/Aucun skill dans le brain/);
    expect(text).not.toMatch(/Chargement des skills/);
    expect(text).not.toMatch(/étapes, usage des outils/);

    localStorage.removeItem('lazy.locale');
  });
});
