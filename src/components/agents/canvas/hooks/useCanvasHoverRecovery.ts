/* useCanvasHoverRecovery.ts — fix/canvas-ux R6a MAJEUR #7: after opening AND
   closing the Rapport overlay, both the 'R' keyboard shortcut and the
   toolbar's own Replay toggle button went dead.

   Root cause: AgentsSpace.tsx renders the Rapport page as a
   `position: fixed; inset: 0` overlay STACKED ON TOP of this view (a
   "never a tree swap" overlay — see that file's own doc comment; CanvasView
   never unmounts). The instant that overlay covers the pointer's position,
   the browser fires a REAL `mouseleave` on this view's own container (the
   hit-test target changed, even with zero mouse movement) — useCanvasKeyboard.ts's
   single window keydown listener bails out immediately whenever
   `hoveredRef.current` is false, so every canvas shortcut ('R' among them)
   goes dead the moment that happens. That part is correct, working as
   designed.

   The bug is what happens when the overlay is REMOVED again: browsers only
   ever dispatch `mouseenter`/`mousemove` in response to actual input-device
   movement — never merely because a DOM mutation now reveals a different
   element under an ALREADY-stationary cursor. Closing Rapport is always a
   real click (its "Fermer" button — ProjectReportPage.tsx has no Escape
   handler), so `hoveredRef` stayed stuck `false` from the moment the
   overlay first appeared, through closing it, until the user happened to
   move the mouse again — which also explains "the toolbar's OWN Replay
   button was dead": that click landed exactly where "Fermer" used to be,
   and Playwright/a real user then has to physically travel across the
   canvas to reach the toolbar, but immediately re-testing 'R' (a very
   plausible next move, no intervening mouse travel) still read the stale
   `false`.

   Fix: recompute the REAL hover state via `document.elementFromPoint` at
   the click's own (clientX, clientY) on every window-level 'click' — this
   listener is a plain native `addEventListener`, so by the time it runs
   (bubble phase, after ProjectReportPage's own onClick already ran and
   React's resulting synchronous re-render already removed the overlay from
   the DOM), the hit-test at that SAME point now correctly resolves to
   whatever is actually there — the canvas underneath, once the overlay is
   gone — self-healing `hoveredRef` immediately, with ZERO extra mouse
   movement required. `resolveHoverFromPoint` is a plain, side-effect-free
   function (bar the `document.elementFromPoint` read) so the hit-test logic
   itself is directly unit-testable — same "pure function + thin effect
   wrapper" convention as chrome/useZoomLevel.ts's `bucketZoom`.
*/

import { useEffect, type RefObject } from 'react';

/** True when the point (clientX, clientY) currently hit-tests to `container`
 *  or one of its descendants. `false` for a `null` container (not yet
 *  mounted) or when nothing is there (point outside the document). */
export function resolveHoverFromPoint(container: HTMLElement | null, clientX: number, clientY: number): boolean {
  if (!container) return false;
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return false;
  const target = document.elementFromPoint(clientX, clientY);
  return !!target && container.contains(target);
}

/**
 * Installs a single window-level 'click' listener that recomputes
 * `hoveredRef.current` via a real hit-test at the click's own screen point —
 * see this module's header for why this specifically (not a `mousemove` or
 * `mouseenter` listener) is what closes the gap. Belt-and-braces alongside
 * CanvasView.tsx's existing `onMouseMove` handler (any actual subsequent
 * mouse movement over the canvas already self-heals `hoveredRef` too; this
 * hook covers the "click Fermer, then immediately press a shortcut, zero
 * mouse travel in between" case that movement-based recovery cannot).
 */
export function useCanvasHoverRecovery(containerRef: RefObject<HTMLElement | null>, hoveredRef: RefObject<boolean>): void {
  useEffect(() => {
    function handleWindowClick(e: MouseEvent): void {
      hoveredRef.current = resolveHoverFromPoint(containerRef.current, e.clientX, e.clientY);
    }
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, [containerRef, hoveredRef]);
}
