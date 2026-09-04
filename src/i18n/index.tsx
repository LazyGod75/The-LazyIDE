import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { type Locale, type TranslationDict, DEFAULT_LOCALE, LOCALES } from './types';
import { fr } from './locales/fr';
import { en } from './locales/en';
import { isTauri } from '../lib/platform';

const LS_KEY = 'lazy.locale';

// ── Dictionary loading ───────────────────────────────────────────────
//
// Only fr (DEFAULT_LOCALE — t()'s own missing-key fallback target) and en
// (the practical fallback nearly every non-fr navigator.language / OS
// locale resolves to via mapOsLocale below) are bundled into the eager
// entry chunk. Previously all 6 locale dictionaries (~476KB of source)
// were statically imported here even though detectLocaleSync() only ever
// needs ONE before first render — 4-5 of them were dead weight on every
// session. es/zh/de/ja are now code-split: fetched once, the first time
// they're actually needed (resolved as the active locale, or picked from
// the language switcher), then cached for the rest of the session.
const dictCache = new Map<Locale, TranslationDict>([
  ['fr', fr],
  ['en', en],
]);
const dictPromises = new Map<Locale, Promise<TranslationDict>>();

const LOCALE_LOADERS: Record<Locale, () => Promise<TranslationDict>> = {
  fr: () => Promise.resolve(fr),
  en: () => Promise.resolve(en),
  es: () => import('./locales/es').then((m) => m.es),
  zh: () => import('./locales/zh').then((m) => m.zh),
  de: () => import('./locales/de').then((m) => m.de),
  ja: () => import('./locales/ja').then((m) => m.ja),
};

function getDict(locale: Locale): TranslationDict | undefined {
  return dictCache.get(locale);
}

/** Loads (and caches) a locale's dictionary. Safe to call repeatedly —
    already-resolved and in-flight loads are deduplicated via dictCache /
    dictPromises, so re-visiting a locale never re-fetches its chunk. */
function loadDict(locale: Locale): Promise<TranslationDict> {
  const cached = dictCache.get(locale);
  if (cached) return Promise.resolve(cached);
  const inFlight = dictPromises.get(locale);
  if (inFlight) return inFlight;
  const promise = LOCALE_LOADERS[locale]().then((dict) => {
    dictCache.set(locale, dict);
    return dict;
  });
  dictPromises.set(locale, promise);
  return promise;
}

/**
 * Map a BCP-47 / POSIX locale tag (e.g. "fr-FR", "en_US", "zh-Hans-CN")
 * to one of the app's supported Locale codes, or return DEFAULT_LOCALE.
 */
function mapOsLocale(raw: string | null): Locale {
  if (!raw) return DEFAULT_LOCALE;
  // Normalise: "fr_FR" → "fr-FR", take first segment.
  const lang = raw.replace('_', '-').split('-')[0].toLowerCase();
  const match = LOCALES.find((l) => l.code === lang);
  return match ? match.code : DEFAULT_LOCALE;
}

/**
 * Synchronous locale resolution:
 * 1. User's explicit saved preference (localStorage) — always wins.
 * 2. navigator.language as web fallback (used until async OS check resolves).
 */
function detectLocaleSync(): Locale {
  try {
    const saved = localStorage.getItem(LS_KEY) as Locale | null;
    if (saved && LOCALES.some((l) => l.code === saved)) return saved;
  } catch { /* localStorage may be unavailable in SSR */ }
  // Web fallback — will be overridden asynchronously on Tauri.
  return mapOsLocale(navigator.language);
}

/**
 * Asynchronously fetch the OS locale via Tauri's os plugin.
 * Returns null outside Tauri or when the locale cannot be resolved.
 * Only used on first run (no saved preference).
 *
 * Non-fatal by design: detectLocaleSync()'s navigator.language guess already
 * stands as the fallback, so a failure here must never throw. It is still
 * logged (not silently swallowed) so a genuine regression — e.g. plugin-os
 * becoming unbundleable again, see vite.config.ts's external comment — is
 * diagnosable instead of vanishing.
 */
async function fetchOsLocale(): Promise<Locale | null> {
  if (!isTauri()) return null;
  try {
    const { locale } = await import('@tauri-apps/plugin-os');
    const raw = await locale();
    return mapOsLocale(raw);
  } catch (err: unknown) {
    console.warn('[i18n] OS locale detection failed, keeping navigator.language fallback:', err);
    return null;
  }
}

// ── Missing-key logging dedupe ──────────────────────────────────────
//
// Mirrors crashReporter.ts's dedupe-window pattern (see that file's header)
// rather than inventing a new one: t()'s missing-key console.error used to
// fire unconditionally on every call, so a component re-rendering with the
// same missing key on a timer (e.g. FluxFooter's 8s poll) spammed one line
// per render, forever. Each distinct "locale:key" signature now logs at
// most once per MISSING_KEY_DEDUPE_WINDOW_MS — a real regression is still
// diagnosable (it resurfaces after the window; never muted for the rest of
// the session), but a burst collapses to one line.
const MISSING_KEY_DEDUPE_WINDOW_MS = 30_000;
let loggedMissingKeys: ReadonlyMap<string, number> = new Map();

/** Pure decision: should THIS missing-key occurrence actually log, given
 *  `recent`'s last-logged timestamp per signature? Exported for unit tests;
 *  production code only reaches it through the module-level state below. */
// eslint-disable-next-line react-refresh/only-export-components
export function shouldLogMissingKey(signature: string, now: number, recent: ReadonlyMap<string, number>): boolean {
  const last = recent.get(signature);
  return last === undefined || now - last >= MISSING_KEY_DEDUPE_WINDOW_MS;
}

function logMissingKeyOnce(key: string, locale: Locale, now: number): void {
  const signature = `${locale}:${key}`;
  if (!shouldLogMissingKey(signature, now, loggedMissingKeys)) return;
  loggedMissingKeys = new Map(loggedMissingKeys).set(signature, now);
  console.error(`[i18n] Missing translation key: "${key}" (locale "${locale}", fallback "${DEFAULT_LOCALE}")`);
}

/** Test-only reset — mirrors crashReporter.ts's resetCrashReporterForTests.
 *  Ensures one test's missing-key logging never suppresses the next test's. */
// eslint-disable-next-line react-refresh/only-export-components
export function resetMissingKeyDedupeForTests(): void {
  loggedMissingKeys = new Map();
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  LOCALES: typeof LOCALES;
}

const I18nContext = createContext<I18nContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

/**
 * Safe variant of {@link useI18n} — returns a degraded context instead of
 * throwing when rendered outside an I18nProvider ancestor, same "safe
 * no-op default" convention `useToastSafe` (components/ui/Toast.tsx)
 * already establishes for the sibling ToastProvider case. The degraded
 * `t` echoes the raw key (never a crash, never a fabricated translation) —
 * good enough for a caller that only needs i18n as a defensive extra (e.g.
 * useCanvasAutoComposition.ts's toast wiring, whose own unit tests render
 * the hook standalone with no I18nProvider ancestor).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useI18nSafe(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return { locale: DEFAULT_LOCALE, setLocale: () => {}, t: (key: string) => key, LOCALES };
}

/**
 * Raw optional variant of {@link useI18n} — returns `null` outside an
 * I18nProvider ancestor instead of throwing, for callers on a boot/fallback
 * path that need their OWN hardcoded fallback text rather than
 * {@link useI18nSafe}'s generic "echo the raw key" default (a raw key like
 * "common.loading" is a fine defensive value for most degraded callers, but
 * a poor one to show as e.g. a spinner's accessible label).
 *
 * Boot-time and fallback UI (loading spinners, error-boundary fallbacks,
 * crash-recovery banners) must never assume I18nProvider is mounted — that
 * is exactly the situation such UI renders in. See Skeleton.tsx's Spinner
 * for the reference usage.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useI18nOptional(): I18nContextValue | null {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const detected = detectLocaleSync();
    // Kick off the dictionary fetch as early as structurally possible —
    // synchronously during the initial render, not after first paint in an
    // effect — so a non-eager locale's chunk gets the longest possible
    // head start before t() first needs it. loadDict() is idempotent
    // (checks its cache / in-flight map first), so this stays safe even
    // under StrictMode's double-invoke of lazy initializers.
    void loadDict(detected);
    return detected;
  });

  // Bumped whenever a dictionary finishes loading, to force a re-render so
  // t() picks up the newly cached dict. dictCache is a module-level Map,
  // not React state, so mutating it alone would never trigger a re-render.
  const [, forceRerender] = useState(0);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(LS_KEY, l);
    } catch { /* localStorage may be unavailable */ }
  }, []);

  // On first run (no saved preference), resolve locale from the OS asynchronously.
  useEffect(() => {
    let cancelled = false;
    const hasSaved = (() => {
      try { return !!localStorage.getItem(LS_KEY); } catch { return false; }
    })();
    if (!hasSaved) {
      fetchOsLocale().then((detected) => {
        if (!cancelled && detected) {
          setLocaleState(detected);
          // Do NOT persist to localStorage — user hasn't made an explicit choice yet.
        }
      });
    }
    return () => { cancelled = true; };
  }, []); // run once on mount

  // Ensure the active locale's dictionary is loaded, and re-render once it
  // resolves. No-op whenever it's already cached — true on every render for
  // fr/en (eager) and for any locale revisited later in the session.
  useEffect(() => {
    if (getDict(locale)) return;
    let cancelled = false;
    loadDict(locale).then(() => {
      if (!cancelled) forceRerender((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      // fr (DEFAULT_LOCALE) is always eager/cached — this fallback can
      // never actually miss.
      const fallbackDict = getDict(DEFAULT_LOCALE)!;
      const dict = getDict(locale) ?? fallbackDict;
      const resolved = dict[key] ?? fallbackDict[key];
      // Fail loudly in dev/test when a key is missing from BOTH the active
      // locale and the fr fallback: a raw key rendering as UI text (e.g.
      // "palette.section.files") is otherwise silent and easy to ship — see
      // the command-palette regression this guard was added for (2026-08-14).
      // console.error rather than throw: a missing key must never crash the
      // app for a real user, but it must be impossible to miss in dev
      // console output or vitest's stdout (disableConsoleIntercept is on,
      // see vitest.config.ts) while iterating. Deduped (see
      // logMissingKeyOnce above) so a component re-rendering on a timer with
      // the same missing key doesn't spam the console on every render.
      if (resolved === undefined && import.meta.env.DEV) {
        logMissingKeyOnce(key, locale, Date.now());
      }
      let str = resolved ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return str;
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t, LOCALES }}>
      {children}
    </I18nContext.Provider>
  );
}
