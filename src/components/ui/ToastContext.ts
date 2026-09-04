/* ToastContext.ts — the ToastContext object + its hooks, deliberately kept
   OUT of Toast.tsx.

   ROOT CAUSE this file fixes: "useToast must be used inside ToastProvider"
   firing during Vite dev HMR even though ToastProvider genuinely wraps the
   whole app (see AppShell.tsx). Toast.tsx used to call `createContext()` at
   its own module top level AND export both a component (ToastProvider) and
   plain functions (useToast, useToastSafe) — exactly the mixed-export shape
   `react-refresh/only-export-components` warns about (the warning was
   silenced with eslint-disable comments instead of fixed).

   React Fast Refresh only guarantees safe, state-preserving hot-swaps for
   files that export components only. When a file also exports non-component
   bindings that other modules import for logic (not just JSX), Vite's
   plugin cannot prove editing it is safe, so on any edit inside Toast.tsx
   (even to unrelated render/animation code) the whole module body,
   including `const ToastContext = createContext(...)`, re-executes and
   produces a NEW context object. Because propagation to importers doesn't
   land perfectly synchronously across the whole module graph, some
   already-mounted consumer could still be holding a `useToast` closure over
   the OLD context object for one render, while ToastProvider re-rendered
   under the NEW one — `useContext(oldContext)` then sees no matching
   Provider and falls back to the `null` default, and `useToast` throws.

   FIX: `createContext()` now lives in this hooks-only module, imported
   unchanged by both ToastProvider (Toast.tsx) and every consumer. Editing
   Toast.tsx's render/animation/JSX no longer touches this file, so the
   context object identity is stable across HMR as long as THIS file itself
   isn't edited (which is rare — it has no UI, no styling, nothing that
   changes during normal iteration). This is the standard remedy for
   "Context created inline in a component file breaks under Fast Refresh."
*/

import { createContext, useContext } from 'react';

// ── Types ─────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
  action?: ToastAction;
}

export interface ToastContextValue {
  toast: (message: string, type?: ToastType, duration?: number, action?: ToastAction) => void;
}

// ── Context (single, stable creation site — see file header) ───────

export const ToastContext = createContext<ToastContextValue | null>(null);

// ── Hooks ────────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

/**
 * Safe wrapper around {@link useToast} — that hook THROWS outside a
 * ToastProvider ancestor, which not every real fixture/harness render wraps
 * (e.g. canvas node card tests, TerminalView.test.tsx). Still calls the SAME
 * hook unconditionally every render (the try/catch only decides whether the
 * throw propagates, not whether the underlying `useContext` call happens) —
 * degrades to a silent no-op outside a provider, same "safe no-op default"
 * convention CanvasActionsContext.tsx already establishes for this exact
 * situation. Originally a private helper duplicated in MissionNode.tsx and
 * TerminalView.tsx (fix/canvas-ux R10 extraction) — factored here so every
 * caller shares one implementation.
 */
export function useToastSafe(): (message: string, type?: ToastType, duration?: number, action?: ToastAction) => void {
  try {
    return useToast().toast;
  } catch {
    return () => {};
  }
}
