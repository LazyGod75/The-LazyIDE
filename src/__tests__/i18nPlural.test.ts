/**
 * i18nPlural.test.ts — unit coverage for the shared pluralKey/tPlural helper
 * (src/i18n/plural.ts), extracted from LeadView.tsx's original local
 * implementation so every count-agreement call site (team header, Brain
 * timeline, ...) shares one CLDR-driven implementation instead of
 * re-deriving it.
 */
import { describe, it, expect } from 'vitest';
import { pluralKey, tPlural } from '../i18n/plural';

describe('pluralKey', () => {
  it('picks the One key for count === 1 in English', () => {
    expect(pluralKey('brain.timeline.newSince', 1, 'en')).toBe('brain.timeline.newSinceOne');
  });

  it('picks the Many key for count !== 1 in English (including 0)', () => {
    expect(pluralKey('brain.timeline.newSince', 0, 'en')).toBe('brain.timeline.newSinceMany');
    expect(pluralKey('brain.timeline.newSince', 2, 'en')).toBe('brain.timeline.newSinceMany');
  });

  it('treats 0 AND 1 as singular in French (CLDR fr rule)', () => {
    expect(pluralKey('brain.timeline.newSince', 0, 'fr')).toBe('brain.timeline.newSinceOne');
    expect(pluralKey('brain.timeline.newSince', 1, 'fr')).toBe('brain.timeline.newSinceOne');
    expect(pluralKey('brain.timeline.newSince', 2, 'fr')).toBe('brain.timeline.newSinceMany');
  });

  it('never inflects for Japanese/Chinese (always the Many/other form)', () => {
    expect(pluralKey('brain.timeline.newSince', 1, 'ja')).toBe('brain.timeline.newSinceMany');
    expect(pluralKey('brain.timeline.newSince', 1, 'zh')).toBe('brain.timeline.newSinceMany');
  });

  it('falls back to the count === 1 rule when Intl.PluralRules rejects the locale', () => {
    expect(pluralKey('brain.timeline.newSince', 1, 'not-a-real-locale-tag-xyz')).toBe(
      'brain.timeline.newSinceOne',
    );
  });
});

describe('tPlural', () => {
  it('calls t with the resolved key and count merged into params', () => {
    const calls: Array<[string, Record<string, string | number> | undefined]> = [];
    const t = (key: string, params?: Record<string, string | number>) => {
      calls.push([key, params]);
      return key;
    };
    tPlural(t, 'en', 'brain.timeline.newSince', 1, { extra: 'x' });
    expect(calls).toEqual([['brain.timeline.newSinceOne', { count: 1, extra: 'x' }]]);
  });
});
