/**
 * i18nLazyLoad.test.tsx
 *
 * Regression tests for the i18n lazy-loading refactor (src/i18n/index.tsx):
 * previously all 6 locale dictionaries (~476KB of source) were statically
 * imported into the eager entry chunk even though detectLocaleSync()
 * resolves exactly ONE locale before first render. Now only fr
 * (DEFAULT_LOCALE) and en (the practical fallback for most non-fr
 * navigator.language values, including jsdom's own default "en-US" used
 * across this test suite) are eager; es/zh/de/ja are code-split and
 * fetched on first use.
 *
 * Two contracts must hold:
 *   1. Key parity — all 6 dictionaries expose the exact same key set, so
 *      switching locale (or falling back to DEFAULT_LOCALE mid-load) never
 *      silently drops a translation.
 *   2. No flash of untranslated keys — even before a lazy locale's chunk
 *      has loaded, t() must return a real DEFAULT_LOCALE string, never the
 *      raw key. Eager locales (fr/en) must resolve with zero gap at all
 *      (this is the regression guard for the ~11 existing test files that
 *      render the real I18nProvider and assert real fr/en copy).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fr } from '../i18n/locales/fr';
import { en } from '../i18n/locales/en';
import { es } from '../i18n/locales/es';
import { zh } from '../i18n/locales/zh';
import { de } from '../i18n/locales/de';
import { ja } from '../i18n/locales/ja';
import { I18nProvider, useI18n } from '../i18n';
import type { Locale } from '../i18n/types';
import { WAKEUP_MARKER_PREFIX } from '../lib/agents/managerWakeup';

const DICTS: Record<Locale, Record<string, string>> = { fr, en, es, zh, de, ja };

function LocaleProbe({ testKey = 'nav.home' }: { testKey?: string }) {
  const { t, locale } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="value">{t(testKey)}</span>
    </div>
  );
}

function setSavedLocale(locale: Locale): void {
  localStorage.setItem('lazy.locale', locale);
}

beforeEach(() => {
  localStorage.clear();
});

describe('i18n locale dictionaries — 6-way key parity', () => {
  const localeCodes = Object.keys(DICTS) as Locale[];

  it('every locale exposes the exact same key set as fr (DEFAULT_LOCALE)', () => {
    const baseline = new Set(Object.keys(DICTS.fr));
    expect(baseline.size).toBeGreaterThan(0);

    for (const code of localeCodes) {
      if (code === 'fr') continue;
      const keys = new Set(Object.keys(DICTS[code]));
      const missing = [...baseline].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !baseline.has(k));
      expect({ locale: code, missing, extra }).toEqual({ locale: code, missing: [], extra: [] });
    }
  });

  it('no dictionary contains an empty translation string', () => {
    for (const code of localeCodes) {
      const emptyKeys = Object.entries(DICTS[code])
        .filter(([, value]) => value.trim().length === 0)
        .map(([key]) => key);
      expect({ locale: code, emptyKeys }).toEqual({ locale: code, emptyKeys: [] });
    }
  });
});

describe('I18nProvider — eager locales resolve with zero gap', () => {
  it('fr (DEFAULT_LOCALE) renders its real string on the very first synchronous render', () => {
    setSavedLocale('fr');
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    // No await/waitFor — fr is statically imported, so this must be correct
    // synchronously, exactly like before the lazy-loading refactor.
    expect(screen.getByTestId('value')).toHaveTextContent(fr['nav.home']);
  });

  it('en renders its real string on the very first synchronous render (jsdom default locale)', () => {
    setSavedLocale('en');
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('value')).toHaveTextContent(en['nav.home']);
  });
});

describe('I18nProvider — lazy (code-split) locales', () => {
  it('never flashes a raw untranslated key while a lazy locale is loading', () => {
    setSavedLocale('es');
    render(
      <I18nProvider>
        <LocaleProbe testKey="nav.home" />
      </I18nProvider>,
    );
    // Synchronously (before any await lets the es chunk's dynamic import
    // resolve), the rendered value must be a REAL dictionary string — the
    // fr fallback — never the bare key "nav.home".
    const immediateValue = screen.getByTestId('value').textContent;
    expect(immediateValue).not.toBe('nav.home');
    expect(Object.values(DICTS).map((d) => d['nav.home'])).toContain(immediateValue);
  });

  it('eventually applies the lazy locale once its chunk resolves', async () => {
    setSavedLocale('es');
    render(
      <I18nProvider>
        <LocaleProbe testKey="nav.home" />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('value')).toHaveTextContent(es['nav.home']);
    });
    expect(screen.getByTestId('locale')).toHaveTextContent('es');
  });

  it('loads a different lazy locale (zh) correctly, independent of es', async () => {
    setSavedLocale('zh');
    render(
      <I18nProvider>
        <LocaleProbe testKey="nav.home" />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('value')).toHaveTextContent(zh['nav.home']);
    });
  });

  it('loads de and ja correctly as well (full 6-locale coverage)', async () => {
    setSavedLocale('de');
    const { unmount } = render(
      <I18nProvider>
        <LocaleProbe testKey="nav.home" />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('value')).toHaveTextContent(de['nav.home']);
    });
    unmount();

    setSavedLocale('ja');
    render(
      <I18nProvider>
        <LocaleProbe testKey="nav.home" />
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('value')).toHaveTextContent(ja['nav.home']);
    });
  });
});

// ── Manager wakeup — reply-language directive (regression) ──────────────
//
// Bug fixed here: managerEngine.ts's system prompt carries no locale-aware
// rule of its own, so the LazyManager's free-text reply to a proactive
// wakeup turn could come back in English even in a non-English app (real
// user report: French app, English "Action needed: ..." reply). Since
// managerWakeup.ts is deliberately i18n-free (see its own header) and the
// actual formatWakeupMessage template lives in agentsStore.tsx (out of this
// module's reach), the fix lives entirely in the translated
// `lazyManager.wakeup.instruction` string: each locale now appends an
// explicit in-language "reply in <language>" directive, so the wakeup
// turn's own input text (built from these keys) tells the LLM which
// language to answer in regardless of prior chat history. This test pins
// that content contract down so it cannot silently regress.
describe('lazyManager.wakeup.instruction — explicit reply-language directive', () => {
  // One recognizable substring per locale, in that locale's own language —
  // deliberately NOT the whole sentence, so unrelated copy edits to the
  // rest of the instruction don't break this test.
  const EXPECTED_DIRECTIVE: Record<Locale, string> = {
    fr: 'Réponds en français',
    en: 'Reply in English',
    es: 'Responde en español',
    de: 'Antworte auf Deutsch',
    zh: '请用中文回复',
    ja: '日本語で返信してください',
  };

  for (const locale of Object.keys(EXPECTED_DIRECTIVE) as Locale[]) {
    it(`${locale}: instruction embeds its own explicit reply-language directive`, () => {
      expect(DICTS[locale]['lazyManager.wakeup.instruction']).toContain(EXPECTED_DIRECTIVE[locale]);
    });
  }

  // Mirrors formatWakeupMessage's exact template (agentsStore.tsx) — that
  // function is not exported, so this reproduces its composition rule to
  // verify the directive survives concatenation into the real wakeup chip
  // text the LLM actually receives as its "user" turn input.
  function composeWakeupText(locale: Locale, body: string): string {
    const dict = DICTS[locale];
    return `${WAKEUP_MARKER_PREFIX}${dict['lazyManager.wakeup.label']} : ${body} — ${dict['lazyManager.wakeup.instruction']}`;
  }

  it('the composed wakeup message keeps the language directive and the wakeup marker for every locale', () => {
    for (const locale of Object.keys(EXPECTED_DIRECTIVE) as Locale[]) {
      const composed = composeWakeupText(locale, 'Mission M43 …');
      expect(composed.startsWith(WAKEUP_MARKER_PREFIX)).toBe(true);
      expect(composed).toContain(EXPECTED_DIRECTIVE[locale]);
    }
  });
});
