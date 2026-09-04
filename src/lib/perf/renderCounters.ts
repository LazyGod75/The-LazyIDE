/* renderCounters.ts — tiny render-churn diagnostic (perf audit 2026-08-15,
   item 3: Cockpit.tsx's un-memoized CanvasView/CockpitLeftRail/ManagerOverlay
   subtree). Exposes a per-component render count on
   `window.__lazyRenderCounts` so a test (or a live debug session) can prove
   a `memo()`-wrapped component actually skipped a re-render, instead of
   trusting "should be memoized" — same "diagnostic marker on window,
   read-only from a test" convention byokProviders.ts's
   `window.__lazyByokVaultReady` already established for this codebase.

   No-op outside a browser/DOM environment (SSR, node scripts). Cheap: one
   property read + one integer increment per render, no allocation on the
   hot path (the `??=` only allocates once, the first time a given
   component name is seen).
*/

declare global {
  interface Window {
    __lazyRenderCounts?: Record<string, number>;
  }
}

/** Call once per render, at the top of a component body (before any early
 *  return), to count how many times React actually executed that
 *  component's function — as opposed to bailing out via `memo()`. */
export function bumpRenderCount(componentName: string): void {
  if (typeof window === 'undefined') return;
  const counts = (window.__lazyRenderCounts ??= {});
  counts[componentName] = (counts[componentName] ?? 0) + 1;
}

/** Current render count for `componentName`, or 0 if never rendered /
 *  outside a DOM environment. */
export function getRenderCount(componentName: string): number {
  if (typeof window === 'undefined') return 0;
  return window.__lazyRenderCounts?.[componentName] ?? 0;
}

/** Test-only: reset all counters so counts don't leak across tests sharing
 *  the same jsdom `window` (vitest reuses one jsdom window per test file
 *  unless configured otherwise). Call in `beforeEach`. */
export function resetRenderCountsForTests(): void {
  if (typeof window !== 'undefined') window.__lazyRenderCounts = {};
}
