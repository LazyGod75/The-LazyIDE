/* plural.ts — shared count-agreement helper for the flat i18n dict.

   This dict has no ICU plural support (`t()` in index.tsx is a plain
   key -> string lookup with `{param}` interpolation, nothing more) — so the
   established convention on this repo (first introduced in LeadView.tsx for
   the team-header "1 humain"/"2 humains" fix, W-UX3 addendum) is a
   `<base>One` / `<base>Many` key pair per pluralizable string, picked at
   render time by the ACTIVE locale's CLDR cardinal rule via
   Intl.PluralRules. Extracted here so every call site shares one
   implementation instead of re-deriving the same category logic. */

/**
 * Picks the `<base>One` or `<base>Many` i18n key by the ACTIVE locale's
 * CLDR cardinal rule (Intl.PluralRules) — 'one' -> singular, everything else
 * -> the plural/other form. Locale-correct for fr (0,1 singular), en (1
 * singular), and a no-op for ja/zh (always 'other'). Falls back to the
 * English rule if a locale is somehow unknown to Intl.
 */
export function pluralKey(base: string, count: number, locale: string): string {
  let category: Intl.LDMLPluralRule = count === 1 ? 'one' : 'other';
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    // keep the count === 1 fallback
  }
  return `${base}${category === 'one' ? 'One' : 'Many'}`;
}

/**
 * Convenience wrapper around `t(pluralKey(base, count, locale), { count, ...extraParams })` —
 * the shape every call site needs. Takes `t` and `locale` explicitly (rather
 * than importing `useI18n` itself) so it stays a plain function usable from
 * both components and non-hook contexts.
 */
export function tPlural(
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
  base: string,
  count: number,
  extraParams?: Record<string, string | number>,
): string {
  return t(pluralKey(base, count, locale), { count, ...extraParams });
}
