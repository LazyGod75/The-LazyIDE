/* Shared types for the window-level keyboard-shortcut registry.
   See registry.ts for the dispatch implementation and useShortcut.ts for
   the React lifecycle wrapper. */

/** Handler invoked when a shortcut's combo matches and its scope passes. */
export type ShortcutHandler = (event: KeyboardEvent) => void;

/** A scope predicate decides whether a shortcut is eligible to fire for a
 *  given keydown. `'global'` (or omitting `when`) means always eligible.
 *  A function receives the raw KeyboardEvent and returns whether the
 *  shortcut should be considered — e.g. an editor component can pass a
 *  predicate that checks its own focus state (`() => view.hasFocus`) to
 *  implement scopes like "editor focused" without this generic module
 *  needing to know anything about CodeMirror. */
export type ShortcutScope = 'global' | ((event: KeyboardEvent) => boolean);

export interface ShortcutDefinition {
  /** Unique id, used in dev-mode collision warnings and debugging. */
  id: string;
  /** Normalized combo string, e.g. "Mod+K", "Mod+Shift+O", "Escape".
   *  "Mod" resolves to Meta on macOS and Ctrl elsewhere. Modifiers and key
   *  names are case-insensitive. See combo.ts for the full grammar. */
  combo: string;
  /** Scope predicate. Defaults to 'global' (always eligible). */
  when?: ShortcutScope;
  /** Invoked when this shortcut wins dispatch for a keydown. */
  handler: ShortcutHandler;
  /** Higher priority wins when multiple eligible shortcuts share a combo.
   *  Defaults to 0 (see priorities.ts for shared tiers). Ties break by
   *  registration order (earlier wins) — deterministic, but not something
   *  callers should rely on: a same-priority collision on an overlapping
   *  scope triggers a dev-mode warning so it gets resolved explicitly
   *  (distinct priority or a narrower `when`) instead of depending on
   *  registration order. */
  priority?: number;
  /** Whether to call event.preventDefault() before invoking the handler.
   *  Defaults to true. */
  preventDefault?: boolean;
}

/** Returned by register(); call to remove the shortcut. */
export type Unsubscribe = () => void;
