/* Parses and matches normalized keyboard-shortcut combo strings, e.g.
   "Mod+K", "Mod+Shift+O", "Shift+Alt+F", or a bare key like "Escape".
   "Mod" is resolved once at parse time (see isMacPlatform) to Meta on
   macOS or Ctrl elsewhere — every other modifier/key token is matched
   literally and case-insensitively. Matching is exact: an unspecified
   modifier must be up, so "Mod+K" never fires for "Mod+Shift+K". */

export interface ParsedCombo {
  /** Lowercased key, compared against event.key case-insensitively. */
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

type ModifierToken = 'mod' | 'ctrl' | 'meta' | 'shift' | 'alt';

const MODIFIER_ALIASES: Record<string, ModifierToken> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  win: 'meta',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
};

// event.key spells some keys differently than we'd like to type in a combo
// string; extend as new bare keys are needed.
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
};

function normalizeKey(rawKey: string): string {
  const lower = rawKey.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/** Parses a combo string into a normalized descriptor for matchesCombo(). */
export function parseCombo(combo: string, isMac: boolean): ParsedCombo {
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid shortcut combo: "${combo}"`);
  }

  const descriptor = { ctrl: false, meta: false, shift: false, alt: false };
  let keyToken: string | null = null;

  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()];
    if (!alias) {
      keyToken = part;
      continue;
    }
    if (alias === 'mod') {
      if (isMac) descriptor.meta = true;
      else descriptor.ctrl = true;
    } else {
      descriptor[alias] = true;
    }
  }

  if (!keyToken) {
    throw new Error(`Shortcut combo "${combo}" has no non-modifier key`);
  }

  return { ...descriptor, key: normalizeKey(keyToken) };
}

/** Exact match: every modifier must match precisely. */
export function matchesCombo(event: KeyboardEvent, combo: ParsedCombo): boolean {
  return (
    normalizeKey(event.key) === combo.key &&
    event.ctrlKey === combo.ctrl &&
    event.metaKey === combo.meta &&
    event.shiftKey === combo.shift &&
    event.altKey === combo.alt
  );
}

/** Stable string key for a parsed combo — used to detect two registrations
 *  that target the same physical key combination. */
export function comboIdentity(combo: ParsedCombo): string {
  return `${combo.ctrl ? 1 : 0}${combo.meta ? 1 : 0}${combo.shift ? 1 : 0}${combo.alt ? 1 : 0}:${combo.key}`;
}
