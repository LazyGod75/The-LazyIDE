/* readinessI18nEnglish.test.ts — regression test for hardcoded French.

   lib/models/readiness.ts used to return every BackendReadiness label /
   reason / howToEnable string as a hardcoded French literal (e.g. "Claude
   Code (abonnement)", "Clé API DeepSeek (BYOK)") regardless of the caller's
   locale — those strings feed straight into ProvidersPanel's "Available
   engines" list in Settings > Models. Observed live with the interface
   language set to English.

   The functions now accept an optional translator (defaulting to the fr
   fallback used by tests that call them directly — see readiness.test.ts,
   whose French-regex assertions keep passing unchanged). This test builds a
   translator from the real `en` locale dictionary and asserts the English
   copy comes out — and that none of the previously hardcoded French leaks
   through when English is the active language.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/models/cliBackendProvider', () => ({
  isCliBackendAvailable: vi.fn().mockReturnValue(null),
  CLI_BACKENDS: [],
  detectAllCliBackends: vi.fn(),
  cliBackendProvider: vi.fn(),
}));

vi.mock('../lib/models/index', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/models/index')>();
  return { ...orig, isManagedActive: vi.fn().mockReturnValue(false) };
});

import {
  claudeCliReadiness,
  codexCliReadiness,
  byokReadiness,
  managedProReadiness,
  getAllBackendsReadiness,
  type Translate,
} from '../lib/models/readiness';
import { resolveByokDef } from '../lib/models/byokProviders';
import { en } from '../i18n/locales/en';

function makeTranslate(dict: Record<string, string>): Translate {
  return (key, params) => {
    let str = dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  };
}

const tEn = makeTranslate(en);

beforeEach(() => {
  localStorage.clear();
});

describe('readiness.ts — labels/reasons localize to English when passed an English translator', () => {
  it('claudeCliReadiness renders an English label and reason', () => {
    const r = claudeCliReadiness(tEn);
    expect(r.label).toBe('Claude Code (subscription)');
    expect(r.label).not.toContain('abonnement');
    expect(r.reason).not.toMatch(/introuvable|en cours/i);
  });

  it('codexCliReadiness renders English copy', () => {
    const r = codexCliReadiness(tEn);
    expect(r.label).toBe('Codex CLI (OpenAI)');
    expect(r.howToEnable).not.toMatch(/Installe|redémarre/i);
  });

  it('byokReadiness renders an English label for DeepSeek — was "Clé API DeepSeek (BYOK)"', () => {
    const r = byokReadiness(resolveByokDef('deepseek')!, tEn);
    expect(r.label).toBe('DeepSeek API key (BYOK)');
    expect(r.label).not.toContain('Clé API');
    expect(r.reason).not.toContain('Aucune clé API');
  });

  it('managedProReadiness renders English copy', () => {
    const r = managedProReadiness(tEn);
    expect(r.label).toBe('Pro · managed by Lazy');
    expect(r.reason).not.toMatch(/Abonnement Pro inactif/);
  });

  it('getAllBackendsReadiness never leaks French labels when passed an English translator', () => {
    const all = getAllBackendsReadiness(tEn);
    for (const backend of all) {
      expect(backend.label).not.toMatch(/abonnement|Clé API|géré par/i);
    }
  });
});
