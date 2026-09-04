/* accentTheme — lets the user pick an accent base color from
   Réglages > Apparence (QA fix B3: the swatches used to be dead UI — no
   onClick at all, and the "active" ring was hardcoded to the first swatch
   forever).

   Derives the FULL --color-accent-* token set (hover/active/soft/border/
   light/pale/lighter) from one base hex via simple RGB mixing, so the
   whole app's accent-tinted UI (buttons, borders, badges, KPI highlights…)
   re-themes coherently instead of just the 4 core vars — a partial swap
   would look broken next to every var this file doesn't touch. Applied to
   :root as inline style properties (highest specificity, wins over the
   :root rule in design-system.css) and persisted to localStorage so the
   choice survives a reload — see initAccentOnBoot(), called once from
   main.tsx before the first render.
*/

const STORAGE_KEY = 'lazy.theme.accent';

/** Swatch choices shown in Réglages > Apparence. First entry is the
 *  design system's own default violet (design-system.css's --color-accent). */
export const ACCENT_PRESETS: readonly string[] = [
  '#7C5CFF', '#3B82F6', '#10B981', '#F59E0B', '#EF4444',
];

export const DEFAULT_ACCENT: string = ACCENT_PRESETS[0];

type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

interface AccentTokens {
  accent: string;
  hover: string;
  active: string;
  soft: string;
  border: string;
  light: string;
  pale: string;
  lighter: string;
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b];
}

function rgbToHex([r, g, b]: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

/** Mixes `hex` toward `target` (white or black) by `amount` (0..1). */
function mixToward(hex: string, target: Rgb, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [tr, tg, tb] = target;
  return rgbToHex([r + (tr - r) * amount, g + (tg - g) * amount, b + (tb - b) * amount]);
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Pure — derives every accent token from a single base hex. Exported for
 *  unit testing without touching the DOM/localStorage. */
export function deriveAccentTokens(base: string): AccentTokens {
  return {
    accent: base,
    hover: mixToward(base, WHITE, 0.13),
    active: mixToward(base, BLACK, 0.13),
    soft: hexToRgba(base, 0.12),
    border: hexToRgba(base, 0.3),
    light: mixToward(base, WHITE, 0.35),
    pale: mixToward(base, WHITE, 0.62),
    lighter: mixToward(base, WHITE, 0.83),
  };
}

const TOKEN_VAR_NAMES: Record<keyof AccentTokens, string> = {
  accent: '--color-accent',
  hover: '--color-accent-hover',
  active: '--color-accent-active',
  soft: '--color-accent-soft',
  border: '--color-accent-border',
  light: '--color-accent-light',
  pale: '--color-accent-pale',
  lighter: '--color-accent-lighter',
};

/** Swaps every --color-accent-* custom property on :root. Side-effecting —
 *  call from a browser context only (main.tsx boot, or the swatch's
 *  onClick handler). */
export function applyAccent(base: string): void {
  const tokens = deriveAccentTokens(base);
  const root = document.documentElement.style;
  for (const key of Object.keys(TOKEN_VAR_NAMES) as Array<keyof AccentTokens>) {
    root.setProperty(TOKEN_VAR_NAMES[key], tokens[key]);
  }
}

/** Reads the persisted choice, or the design system's default when none is
 *  stored yet / localStorage is unavailable. Never throws. */
export function loadStoredAccent(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

function persistAccent(base: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, base);
  } catch {
    // best-effort — the accent still applies for this session even if
    // persistence fails (e.g. private-mode storage restrictions)
  }
}

/** User picked a swatch: apply immediately + persist for next boot. */
export function setAccent(base: string): void {
  applyAccent(base);
  persistAccent(base);
}

/** Call once at app boot (before the first render, so there's no flash of
 *  the default violet). No-op when the stored choice IS the default —
 *  design-system.css's own :root values already match it. */
export function initAccentOnBoot(): void {
  const stored = loadStoredAccent();
  if (stored !== DEFAULT_ACCENT) applyAccent(stored);
}
