/* QA fix (B3) — accent-color swatches now wired for real (deriveAccentTokens
   is the pure core: given one base hex, derive the full --color-accent-*
   token set). applyAccent/setAccent/loadStoredAccent are exercised too,
   since jsdom gives us a real document + localStorage in this test env. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  deriveAccentTokens,
  applyAccent,
  loadStoredAccent,
  setAccent,
  initAccentOnBoot,
} from '../lib/theme/accentTheme';

describe('deriveAccentTokens', () => {
  it('base token equals the input hex verbatim', () => {
    expect(deriveAccentTokens('#7C5CFF').accent).toBe('#7C5CFF');
  });

  it('hover/light/pale/lighter each lighten progressively toward white', () => {
    const t = deriveAccentTokens('#7C5CFF');
    // Loosely: later steps in the "toward white" ladder should have a
    // higher green channel value than earlier ones (green is 0 in the
    // base and 255 in white, so it's monotonic under this mix function).
    const g = (hex: string) => parseInt(hex.slice(3, 5), 16);
    expect(g(t.hover)).toBeGreaterThan(g(t.accent));
    expect(g(t.light)).toBeGreaterThan(g(t.hover));
    expect(g(t.pale)).toBeGreaterThan(g(t.light));
    expect(g(t.lighter)).toBeGreaterThan(g(t.pale));
  });

  it('active mixes toward black (darker than the base)', () => {
    const t = deriveAccentTokens('#7C5CFF');
    const g = (hex: string) => parseInt(hex.slice(3, 5), 16);
    expect(g(t.active)).toBeLessThan(g(t.accent));
  });

  it('soft/border are low-alpha rgba of the exact base color', () => {
    const t = deriveAccentTokens('#3B82F6');
    expect(t.soft).toBe('rgba(59, 130, 246, 0.12)');
    expect(t.border).toBe('rgba(59, 130, 246, 0.3)');
  });

  it('every preset produces valid 6-digit hex tokens (no NaN from a bad parse)', () => {
    for (const preset of ACCENT_PRESETS) {
      const tokens = deriveAccentTokens(preset);
      for (const key of ['accent', 'hover', 'active', 'light', 'pale', 'lighter'] as const) {
        expect(tokens[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });
});

describe('applyAccent / setAccent / loadStoredAccent (DOM + localStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--color-accent');
    document.documentElement.style.removeProperty('--color-accent-hover');
  });

  it('applyAccent sets every --color-accent-* custom property on :root', () => {
    applyAccent('#EF4444');
    const root = document.documentElement.style;
    // The base token is stored verbatim (case preserved); the derived
    // ones (soft/border/etc.) are always lowercase (rgbToHex's own output).
    expect(root.getPropertyValue('--color-accent').trim()).toBe('#EF4444');
    expect(root.getPropertyValue('--color-accent-hover').trim()).not.toBe('');
    expect(root.getPropertyValue('--color-accent-soft').trim()).toBe('rgba(239, 68, 68, 0.12)');
  });

  it('loadStoredAccent falls back to the default when nothing is persisted', () => {
    expect(loadStoredAccent()).toBe(DEFAULT_ACCENT);
  });

  it('setAccent persists the choice so a later loadStoredAccent picks it up', () => {
    setAccent('#10B981');
    expect(loadStoredAccent()).toBe('#10B981');
  });

  it('initAccentOnBoot re-applies a persisted non-default choice', () => {
    localStorage.setItem('lazy.theme.accent', '#F59E0B');
    initAccentOnBoot();
    expect(document.documentElement.style.getPropertyValue('--color-accent').trim()).toBe('#F59E0B');
  });
});
