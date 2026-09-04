/* settingsBadgeCasingConsistency.test.ts — regression test for inconsistent
   status-badge casing in Settings > Models.

   Observed live: the "Model access" cards (settings.access.active /
   settings.access.autoActive) rendered a lowercase "active" pill while the
   "Available engines" list (settings.providers.activeBadge) rendered an
   uppercase "ACTIVE" pill for the exact same concept, in the same tab.
   Fixed by uppercasing settings.access.active/autoActive in every
   Latin-script locale to match the settings.providers.activeBadge
   convention (SettingsSpace.tsx's AccessModeSection badges also gained a
   CSS textTransform:uppercase as a second line of defense). CJK locales
   (ja/zh) have no case distinction and were already consistent.

   This guards the dictionary source of truth directly rather than
   depending on jsdom to reflect CSS text-transform (it doesn't — Testing
   Library's textContent returns the literal string, not the
   visually-transformed one).
*/

import { describe, it, expect } from 'vitest';
import { en } from '../i18n/locales/en';
import { fr } from '../i18n/locales/fr';
import { es } from '../i18n/locales/es';
import { de } from '../i18n/locales/de';

const LATIN_LOCALES = { en, fr, es, de };

describe('settings.access.active / settings.providers.activeBadge — same casing convention', () => {
  it.each(Object.entries(LATIN_LOCALES))('%s: both active badges are uppercase', (_name, dict) => {
    const accessActive = dict['settings.access.active'];
    const accessAutoActive = dict['settings.access.autoActive'];
    const providersActive = dict['settings.providers.activeBadge'];

    expect(accessActive).toBe(accessActive.toUpperCase());
    expect(accessAutoActive).toBe(accessAutoActive.toUpperCase());
    expect(providersActive).toBe(providersActive.toUpperCase());
  });
});
