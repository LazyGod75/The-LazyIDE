/**
 * teamHeaderPlural.test.ts — W-UX3 addendum: the Team (Lead) header showed
 * « 1 humains » / « 0 départements » — no singular agreement. This flat
 * i18n dict has no ICU plurals, so LeadView now picks a singular- or
 * plural-form key by the count. This pins those keys across every locale
 * (a missing/typo'd key in one locale would fall back to French silently)
 * and proves the singular and plural forms actually differ where the
 * language inflects.
 */

import { describe, it, expect } from 'vitest';
import { fr } from '../i18n/locales/fr';
import { en } from '../i18n/locales/en';

const PLURAL_KEYS = [
  'team.redesign.lead.humansOne',
  'team.redesign.lead.humansMany',
  'team.redesign.lead.deptsOne',
  'team.redesign.lead.deptsMany',
] as const;

describe('Team header pluralization keys (W-UX3 addendum)', () => {
  it('titleMeta no longer hard-codes a plural unit word — just joins the two pre-agreed parts (fr/en)', () => {
    // The old bug baked the unit word (« humains »/« humans ») straight into
    // titleMeta after the raw count; now it only interpolates the already
    // count-agreed {humans}/{depts} parts.
    expect(fr['team.redesign.lead.titleMeta']).toBe('· {humans} · {depts}');
    expect(en['team.redesign.lead.titleMeta']).toBe('· {humans} · {depts}');
  });

  it('every singular/plural key exists and carries the {count} placeholder (fr + en eager dicts)', () => {
    for (const dict of [fr, en]) {
      for (const key of PLURAL_KEYS) {
        expect(dict[key], `${key} present`).toBeDefined();
        expect(dict[key], `${key} has {count}`).toContain('{count}');
      }
    }
  });

  it('the locale CLDR rule (Intl.PluralRules) — which LeadView uses to pick the key — is 0-aware per language', () => {
    // French treats 0 AND 1 as singular (« 0 département », « 1 humain »);
    // English only 1 (« 0 departments », « 1 department »); ja/zh never
    // inflect. This is exactly why LeadView delegates to Intl.PluralRules
    // instead of a naive `count === 1`.
    expect(new Intl.PluralRules('fr').select(0)).toBe('one');
    expect(new Intl.PluralRules('fr').select(1)).toBe('one');
    expect(new Intl.PluralRules('fr').select(2)).toBe('other');
    expect(new Intl.PluralRules('en').select(0)).toBe('other');
    expect(new Intl.PluralRules('en').select(1)).toBe('one');
    expect(new Intl.PluralRules('ja').select(1)).toBe('other');
  });

  it('singular and plural forms actually differ in inflecting languages (fr, en)', () => {
    expect(fr['team.redesign.lead.humansOne']).toBe('{count} humain');
    expect(fr['team.redesign.lead.humansMany']).toBe('{count} humains');
    expect(fr['team.redesign.lead.deptsOne']).toBe('{count} département');
    expect(fr['team.redesign.lead.deptsMany']).toBe('{count} départements');
    expect(en['team.redesign.lead.humansOne']).toBe('{count} human');
    expect(en['team.redesign.lead.humansMany']).toBe('{count} humans');
  });
});
