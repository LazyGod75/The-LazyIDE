/* palettes.ts — Brain Canvas color palettes (pure data + color math).
   Exact swatch arrays ported from the design handoff prototype
   (design_handoff_brain_redesign/Lazy IDE.dc.html, `PALETTES` on the
   Component class). Each palette is 5 index-ordered colors matching the
   5 semantic cluster slots used across the app (see brainAdapter.ts's
   resolveClusterColors, which maps real/mock cluster names onto these
   slots). This module intentionally carries no display strings (i18n
   labels live in the locale files via `brain.palette.<id>`) and no React
   — it stays pure TS so it is trivially unit-testable.
*/

export type PaletteId = 'spectre' | 'hologramme' | 'neon' | 'aurore';

export interface PaletteDef {
  id: PaletteId;
  /** 5 index-ordered colors — slot order: editor/auth, agents/paiement, brain/tests, tauri/infra, models/ui. */
  colors: readonly string[];
}

export const PALETTES: Record<PaletteId, PaletteDef> = {
  spectre: {
    id: 'spectre',
    colors: ['#9B7CFF', '#4FC3F7', '#66E27A', '#FFC76B', '#FF7BB0'],
  },
  hologramme: {
    id: 'hologramme',
    colors: ['#6FD0FF', '#3FA0F5', '#56E0CE', '#9AD8FF', '#C2ECFF'],
  },
  neon: {
    id: 'neon',
    colors: ['#9B7CFF', '#7C5CFF', '#B47CFF', '#FF7BD5', '#D682FF'],
  },
  aurore: {
    id: 'aurore',
    colors: ['#7C5CFF', '#33D6C0', '#66E27A', '#5BD6FF', '#B07CFF'],
  },
};

export const PALETTE_IDS: readonly PaletteId[] = ['spectre', 'hologramme', 'neon', 'aurore'];

export const DEFAULT_PALETTE: PaletteId = 'spectre';

/** Type guard — narrows an arbitrary string (e.g. from persisted UI state) to a known PaletteId. */
export function isPaletteId(value: string): value is PaletteId {
  return (PALETTE_IDS as readonly string[]).includes(value);
}

/**
 * Converts a `#RRGGBB` hex color into an `rgba(r,g,b,alpha)` string.
 * Ported from the prototype's `hexA(hex, a)` helper — used throughout the
 * draw layer for bloom halos, selection rings and firing shockwaves where
 * only the alpha channel varies frame to frame.
 */
export function hexA(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
