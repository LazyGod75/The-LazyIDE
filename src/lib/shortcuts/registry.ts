/* Central registry for window-level keyboard shortcuts.
   One `keydown` listener is attached to `window`; every registered
   shortcut is matched against it here instead of components installing
   their own ad-hoc `window.addEventListener('keydown', ...)` plus manual
   collision guards (see the Mod+K palette-vs-editor case this module was
   built to replace — AppShell.tsx and EditorPane.tsx). */

import { comboIdentity, matchesCombo, parseCombo, type ParsedCombo } from './combo.js';
import { isMacPlatform } from './platform.js';
import type { ShortcutDefinition, ShortcutScope, Unsubscribe } from './types.js';

interface RegisteredShortcut extends ShortcutDefinition {
  parsedCombo: ParsedCombo;
  /** Registration sequence — deterministic tiebreaker when priorities match. */
  order: number;
}

export interface ShortcutRegistry {
  /** Registers a shortcut and attaches the shared window listener on first
   *  use. Returns an unsubscribe function; always call it on cleanup (see
   *  useShortcut.ts, which does this automatically). */
  register(definition: ShortcutDefinition): Unsubscribe;
  /** Currently registered shortcuts — read-only, for debugging/tests. */
  getAll(): readonly ShortcutDefinition[];
  /** Removes the shared window listener and clears all registrations. Not
   *  needed in the app (the registry lives for the process lifetime);
   *  exists so tests can get a clean slate without leaking listeners
   *  across test files. */
  destroy(): void;
}

function isScopeActive(when: ShortcutScope | undefined, event: KeyboardEvent): boolean {
  if (when === undefined || when === 'global') return true;
  return when(event);
}

/** Two scopes are considered "overlapping" for the dev-mode duplicate
 *  warning when either is global (always active, so it overlaps with
 *  anything) or when they are the exact same predicate reference. Two
 *  distinct custom predicates are assumed non-overlapping — proving real
 *  overlap would require evaluating them, which the registry can't do
 *  ahead of time. This keeps the warning focused on the case it exists to
 *  catch: two shortcuts silently competing for the same combo with no
 *  scope/priority differentiation at all (the original 14-files problem). */
function scopesOverlap(a: ShortcutScope | undefined, b: ShortcutScope | undefined): boolean {
  const aGlobal = a === undefined || a === 'global';
  const bGlobal = b === undefined || b === 'global';
  if (aGlobal || bGlobal) return true;
  return a === b;
}

function pickWinner(candidates: readonly RegisteredShortcut[]): RegisteredShortcut {
  return [...candidates].sort((a, b) => {
    const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
    return byPriority !== 0 ? byPriority : a.order - b.order;
  })[0];
}

/** Creates an isolated registry instance. The app uses the `shortcutRegistry`
 *  singleton below; tests can call this directly for isolation. */
export function createShortcutRegistry(): ShortcutRegistry {
  let shortcuts: readonly RegisteredShortcut[] = [];
  let orderCounter = 0;
  let listening = false;

  function handleKeyDown(event: KeyboardEvent): void {
    const byCombo = shortcuts.filter((s) => matchesCombo(event, s.parsedCombo));
    if (byCombo.length === 0) return;

    const eligible = byCombo.filter((s) => isScopeActive(s.when, event));
    if (eligible.length === 0) return;

    const winner = pickWinner(eligible);
    if (winner.preventDefault !== false) event.preventDefault();
    winner.handler(event);
  }

  function warnIfDuplicate(candidate: RegisteredShortcut): void {
    if (!import.meta.env.DEV) return;
    const comboKey = comboIdentity(candidate.parsedCombo);
    const collision = shortcuts.find(
      (existing) =>
        existing.id !== candidate.id &&
        comboIdentity(existing.parsedCombo) === comboKey &&
        (existing.priority ?? 0) === (candidate.priority ?? 0) &&
        scopesOverlap(existing.when, candidate.when),
    );
    if (collision) {
      console.warn(
        `[shortcuts] "${candidate.id}" registers combo "${candidate.combo}" which collides with ` +
          `"${collision.id}" (same priority ${candidate.priority ?? 0}, overlapping scope). ` +
          'Give one a higher priority or a narrower "when" scope to make the winner explicit.',
      );
    }
  }

  function register(definition: ShortcutDefinition): Unsubscribe {
    const registered: RegisteredShortcut = {
      ...definition,
      parsedCombo: parseCombo(definition.combo, isMacPlatform()),
      order: orderCounter,
    };
    orderCounter = orderCounter + 1;

    warnIfDuplicate(registered);
    shortcuts = [...shortcuts, registered];

    if (!listening && typeof window !== 'undefined') {
      window.addEventListener('keydown', handleKeyDown);
      listening = true;
    }

    return () => {
      shortcuts = shortcuts.filter((s) => s !== registered);
    };
  }

  function getAll(): readonly ShortcutDefinition[] {
    return shortcuts;
  }

  function destroy(): void {
    if (listening && typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKeyDown);
    }
    listening = false;
    shortcuts = [];
    orderCounter = 0;
  }

  return { register, getAll, destroy };
}

/** App-wide singleton. Components register through useShortcut(), which
 *  wraps this in a React lifecycle. Advanced/bulk call sites (e.g.
 *  registering a table of related combos from one effect) may call
 *  `.register()` directly — see the space-switcher table in AppShell.tsx. */
export const shortcutRegistry: ShortcutRegistry = createShortcutRegistry();
