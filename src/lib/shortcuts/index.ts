/* Public API for the window-level keyboard-shortcut registry. */

export { shortcutRegistry, createShortcutRegistry } from './registry.js';
export type { ShortcutRegistry } from './registry.js';
export { useShortcut } from './useShortcut.js';
export type { UseShortcutOptions } from './useShortcut.js';
export type { ShortcutDefinition, ShortcutHandler, ShortcutScope, Unsubscribe } from './types.js';
export { SHORTCUT_PRIORITY } from './priorities.js';
export { parseCombo, matchesCombo, comboIdentity } from './combo.js';
export type { ParsedCombo } from './combo.js';
export { isMacPlatform } from './platform.js';
