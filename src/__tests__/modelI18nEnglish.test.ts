/* modelI18nEnglish.test.ts — regression test for hardcoded French.

   2026-08 i18n pass: several lib/models + lib/billing functions used to
   return hardcoded French copy unconditionally (BYOK "no key configured"
   errors, provider readiness reasons, the model-picker group headers and
   empty-state fallback, billing-portal errors) — the exact bug class
   RulesPanelI18nEnglish.test.tsx / HealthPanelI18nEnglish.test.tsx /
   CommandPaletteI18n.test.tsx guard for on the React side, and
   readinessI18nEnglish.test.ts (lib/models/readiness.ts) guards for on the
   non-React side. This file extends that same non-React coverage to the
   functions this pass added an optional `t` translator to.

   Every function under test accepts an optional translator (defaulting to
   the ORIGINAL hardcoded French when omitted — see each module's own doc
   comment). This test builds a translator from the real `en` locale
   dictionary and asserts the English copy comes out, with none of the
   previously-hardcoded French leaking through.
*/

import { describe, it, expect, beforeEach } from 'vitest';
import { en } from '../i18n/locales/en';

function makeTranslate(dict: Record<string, string>) {
  return (key: string, params?: Record<string, string | number>) => {
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

// A few of the previously-hardcoded French words/phrases this pass removed
// from the functions under test — used as a blunt "did French leak back in"
// net across every assertion below.
const FRENCH_LEAK_PATTERN = /Aucun[e]?\s|Réglages|abonnement|Crédits|indisponible|configurée|managé/i;

beforeEach(() => {
  localStorage.clear();
});

describe('byokProviders.ts — createOpenAICompatProvider localizes to English', () => {
  it('label uses the English "(BYOK)" copy', async () => {
    const { createOpenAICompatProvider, resolveByokDef } = await import('../lib/models/byokProviders');
    const def = resolveByokDef('deepseek')!;
    const provider = createOpenAICompatProvider(def, tEn);
    expect(provider.label).toBe('DeepSeek (BYOK)');
    expect(provider.label).not.toMatch(FRENCH_LEAK_PATTERN);
  });

  it('the missing-key streamChat error renders in English, not French', async () => {
    const { createOpenAICompatProvider, resolveByokDef } = await import('../lib/models/byokProviders');
    const def = resolveByokDef('deepseek')!;
    const provider = createOpenAICompatProvider(def, tEn);
    const chunks: string[] = [];
    for await (const c of provider.streamChat({
      mode: 'ask',
      model: { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek' },
      messages: [],
    } as never)) {
      chunks.push(c);
    }
    const text = chunks.join('');
    expect(text).toMatch(/No DeepSeek API key configured/);
    expect(text).not.toMatch(FRENCH_LEAK_PATTERN);
  });
});

describe('models/index.ts — describeProviderReadiness localizes to English', () => {
  it('mock mode reason is English', async () => {
    const { describeProviderReadiness } = await import('../lib/models/index');
    const r = describeProviderReadiness('mock', tEn);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('No engine detected. Add an API key (Settings > Models) or install Claude Code.');
    expect(r.reason).not.toMatch(FRENCH_LEAK_PATTERN);
  });

  it('pro mode reason is English', async () => {
    const { describeProviderReadiness } = await import('../lib/models/index');
    const r = describeProviderReadiness('pro', tEn);
    expect(r.ready).toBe(false);
    expect(r.reason).not.toMatch(FRENCH_LEAK_PATTERN);
    expect(r.reason).toMatch(/Pro subscription required/);
  });
});

describe('modelPickerOptions.ts — group labels and fallback messages localize to English', () => {
  it('buildModelPickerOptions labels the Claude-subscription and Pro groups in English', async () => {
    const { buildModelPickerOptions } = await import('../lib/models/modelPickerOptions');
    const result = buildModelPickerOptions({ claudeSub: true, pro: 'active', codexManaged: false }, tEn);
    const labels = result.groups.map((g) => g.label);
    expect(labels).toContain('Claude Subscription');
    expect(labels).toContain('LazyPro / Managed');
    for (const label of labels) {
      expect(label).not.toMatch(FRENCH_LEAK_PATTERN);
    }
  });

  it('noModelFallbackMessage/modelManagedByCodexMessage render English copy', async () => {
    const { noModelFallbackMessage, modelManagedByCodexMessage } = await import('../lib/models/modelPickerOptions');
    expect(noModelFallbackMessage(tEn)).toBe('No model available — configure a Claude subscription or Lazy Pro.');
    expect(modelManagedByCodexMessage(tEn)).toMatch(/Codex manages its own models/);
    expect(noModelFallbackMessage(tEn)).not.toMatch(FRENCH_LEAK_PATTERN);
    expect(modelManagedByCodexMessage(tEn)).not.toMatch(FRENCH_LEAK_PATTERN);
  });

  it('falls back to the original French when no translator is supplied (unchanged default behavior)', async () => {
    const { noModelFallbackMessage } = await import('../lib/models/modelPickerOptions');
    expect(noModelFallbackMessage()).toMatch(/Aucun modèle disponible/);
  });
});

describe('recovery.ts — noCreditsPolicy reason localizes to English', () => {
  it('blocks a no_credits error and returns an English reason when given an English translator', async () => {
    const { evaluateRecovery } = await import('../lib/agents/recovery');
    const stage = {
      id: 'stage-1', kind: 'implement' as const, label: 'Implement', description: 'test',
      model: 'anthropic/claude-sonnet-5', permissionMode: 'acceptEdits' as const,
      systemPrompt: '', taskPrompt: '', state: 'in_progress' as const,
      attemptCount: 0, maxAttempts: 3, dependsOn: [], onPass: null, onFail: null,
    };
    const decision = evaluateRecovery(
      stage,
      'Erreur agent: Crédits Pro épuisés — recharge ou bascule sur ton abonnement CLI dans Réglages > Modèles.',
      tEn,
    );
    expect(decision.action).toBe('block');
    expect(decision.reason).toMatch(/Pro credits exhausted/);
    expect(decision.reason).not.toMatch(FRENCH_LEAK_PATTERN);
  });
});
