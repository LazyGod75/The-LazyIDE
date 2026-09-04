/* settingsGeneralTabConsistency.test.ts — regression test for two copy
   inconsistencies observed live in Settings > General (SettingsSpace.tsx's
   GeneralTab):

   1. The "Re-run onboarding" row label and its own button read
      differently in English ("Re-run onboarding" vs "Rerun onboarding") —
      the other five locales already used the identical string for both,
      so this pins that same "label and action always match" convention
      for every locale, not just the ones that already happened to get it
      right.
   2. Every General-tab setting's description was inconsistently
      punctuated: some ended with a sentence-ending mark, some did not, in
      every locale identically (a straight translation of the same
      inconsistency, not just an English-only slip). Fixed by always
      terminating these descriptions with the locale's own sentence-ending
      punctuation (a period for Latin-script locales, "。" for ja/zh).

   Same "guard the dictionary source of truth directly" approach as
   settingsBadgeCasingConsistency.test.ts (jsdom/Testing Library can't
   observe copy content any more reliably than it observes CSS
   text-transform, so this asserts on the raw dictionaries instead of a
   rendered DOM). */

import { describe, it, expect } from 'vitest';
import { en } from '../i18n/locales/en';
import { fr } from '../i18n/locales/fr';
import { es } from '../i18n/locales/es';
import { de } from '../i18n/locales/de';
import { ja } from '../i18n/locales/ja';
import { zh } from '../i18n/locales/zh';

const ALL_LOCALES = { en, fr, es, de, ja, zh };
const CJK_LOCALES = new Set(['ja', 'zh']);

describe('settings.rerunOnboarding / settings.rerunOnboarding.action — same text in every locale', () => {
  it.each(Object.entries(ALL_LOCALES))('%s: the row label and its button read identically', (_name, dict) => {
    expect(dict['settings.rerunOnboarding']).toBe(dict['settings.rerunOnboarding.action']);
  });
});

// Every description shown in the General tab's grouped sections (Brain,
// Agents, Preferences, Privacy, Updates — see SettingsSpace.tsx's
// GeneralTab) — the full set, not just the four that were caught
// inconsistent, so a future new setting's description is held to the same
// bar automatically.
const GENERAL_TAB_DESCRIPTION_KEYS = [
  'settings.general.autoMemory.desc',
  'settings.general.tokenSaverBadge.desc',
  'settings.general.dualJudge.desc',
  'settings.general.agentNotifications.desc',
  'settings.language.desc',
  'settings.rerunOnboarding.desc',
  'settings.general.versionTelemetry.desc',
  'settings.update.autoUpdateHint',
] as const;

describe('General tab descriptions — consistently terminated with the locale\'s own sentence punctuation', () => {
  for (const [localeName, dict] of Object.entries(ALL_LOCALES)) {
    const terminator = CJK_LOCALES.has(localeName) ? '。' : '.';

    it.each(GENERAL_TAB_DESCRIPTION_KEYS)(`${localeName}: %s ends with "${terminator}"`, (key) => {
      expect(dict[key].endsWith(terminator)).toBe(true);
    });
  }
});

// The General tab's five section labels (SettingsSpace.tsx's
// <SettingsSection>) — every locale must define all five, non-empty, so
// the grouped layout never silently falls back to a raw i18n key.
const GENERAL_TAB_SECTION_KEYS = [
  'settings.section.brain',
  'settings.section.agents',
  'settings.section.preferences',
  'settings.section.privacy',
  'settings.section.updates',
] as const;

describe('General tab section labels — defined in every locale', () => {
  it.each(Object.entries(ALL_LOCALES))('%s: every section label is a non-empty string', (_name, dict) => {
    for (const key of GENERAL_TAB_SECTION_KEYS) {
      expect(typeof dict[key]).toBe('string');
      expect(dict[key].length).toBeGreaterThan(0);
    }
  });
});
