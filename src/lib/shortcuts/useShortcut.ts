/* React hook wrapper around the shared shortcut registry — keeps
   components declarative: register on mount, clean up on unmount, without
   hand-rolled window.addEventListener boilerplate. */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { shortcutRegistry } from './registry.js';
import type { ShortcutHandler, ShortcutScope } from './types.js';

export interface UseShortcutOptions {
  /** Unique id, used in dev-mode collision warnings and debugging. */
  id: string;
  /** Normalized combo string, e.g. "Mod+K". See combo.ts for the grammar. */
  combo: string;
  /** Scope predicate. Defaults to 'global' (always eligible). */
  when?: ShortcutScope;
  /** Higher priority wins when multiple eligible shortcuts share a combo.
   *  Defaults to 0 — see priorities.ts for shared tiers. */
  priority?: number;
  /** Whether to call event.preventDefault() before invoking the handler.
   *  Defaults to true. */
  preventDefault?: boolean;
  /** Skips registration entirely while false. Defaults to true. */
  enabled?: boolean;
}

/** Registers a window-level shortcut for the lifetime of the component.
 *  `when` and `handler` are read through refs on every dispatch, so callers
 *  can pass fresh inline closures each render (e.g. a `when` that reads a
 *  live ref) without causing an unregister+register cycle — only
 *  `id` / `combo` / `priority` / `preventDefault` / `enabled` (and whether
 *  `when` is 'global' vs a custom predicate) trigger re-registration. */
export function useShortcut(options: UseShortcutOptions, handler: ShortcutHandler): void {
  const { id, combo, when, priority, preventDefault, enabled = true } = options;

  const handlerRef = useRef(handler);
  const whenRef = useRef(when);

  // Refs must be updated from an effect rather than directly in the render
  // body (see EditorPane.tsx's setDiagnosticsRef/pathRef/filenameRef for the
  // same convention already used elsewhere in this codebase). useLayoutEffect
  // (no deps — runs after every render) keeps both refs current before any
  // real keydown could possibly be dispatched.
  useLayoutEffect(() => {
    handlerRef.current = handler;
    whenRef.current = when;
  });

  const isGlobalScope = when === undefined || when === 'global';

  useEffect(() => {
    if (!enabled) return undefined;

    const unsubscribe = shortcutRegistry.register({
      id,
      combo,
      priority,
      preventDefault,
      // Passing 'global' through literally (rather than always wrapping in
      // a function) keeps the registry's dev-duplicate-warning able to
      // recognize the common "two unscoped shortcuts on the same combo"
      // case — a fresh wrapper function identity every render would defeat
      // that check even though the underlying scope never changed.
      when: isGlobalScope
        ? 'global'
        : (event: KeyboardEvent) => {
            const scope = whenRef.current;
            return scope === undefined || scope === 'global' ? true : scope(event);
          },
      handler: (event) => handlerRef.current(event),
    });

    return unsubscribe;
  }, [id, combo, priority, preventDefault, enabled, isGlobalScope]);
}
