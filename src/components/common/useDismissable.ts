/* useDismissable — shared "click outside closes / Escape closes" behavior
   for icon-triggered popovers, panels and dropdowns.

   Third occurrence of this exact bug family in the app (the sidebar's
   avatar/⋯ menu and the LazyManager history drawer both hit it separately —
   see LazyManagerHistoryDrawer.tsx's own doc comment for the clearest
   writeup): a naive "global pointerdown outside the panel closes it"
   listener races with the panel's own toggle button when the button lives
   OUTSIDE the panel's DOM subtree (e.g. the panel is portaled to
   `document.body`, or simply rendered as a sibling elsewhere in the tree —
   CockpitRailPopover.tsx / CanvasLibraryPopup.tsx / CanvasMcpPopup.tsx are
   all like this). Sequence when the user re-clicks the SAME toggle button
   to close an already-open panel:
     1. `pointerdown` fires first. The panel's global listener sees the
        click landed outside its own DOM (the toggle button is a different
        subtree) and closes the panel.
     2. `click` fires next, after React has already committed the close.
        The toggle button's own onClick reads the (now stale) "closed"
        state and flips it back open.
   Net effect: the panel appears "impossible to close by re-clicking" — it
   flickers shut and instantly reopens. Passing the toggle button's ref (or
   refs, for panels with more than one) via `ignoreRefs` fixes this: a
   pointerdown that lands on the toggle button is no longer treated as
   "outside", so the button's own onClick becomes the single source of
   truth for toggling, and the panel's outside-click handler only ever
   fires for genuinely-elsewhere clicks.

   Usage — caller owns the open/closed boolean (matches every existing
   popover's shape, e.g. `openId === 'kpis'` in CockpitLeftRail.tsx, or a
   plain `useState` boolean); this hook only wires up the listeners and
   hands back a ref to attach to the dismissable panel's root element:

     const triggerRef = useRef<HTMLButtonElement>(null);
     const panelRef = useDismissable<HTMLDivElement>({
       open,
       onClose: () => setOpen(false),
       ignoreRefs: [triggerRef],
     });

     <button ref={triggerRef} onClick={() => setOpen((v) => !v)}>...</button>
     {open && <div ref={panelRef}>...</div>}
*/

import { useEffect, useRef, type RefObject } from 'react';

export interface UseDismissableOptions {
  /** Whether the dismissable panel is currently open — the hook's window
   *  listeners are only attached while this is true (and torn down the
   *  instant it flips false, or on unmount). */
  open: boolean;
  /** Called on a genuine outside pointerdown, or on Escape. Never called
   *  for clicks inside the panel itself or inside any of `ignoreRefs`. */
  onClose: () => void;
  /** Ref(s) whose subtree should NOT count as "outside" — the toggle
   *  button(s) that open/close this panel. See this file's header comment
   *  for the close-then-reopen race this specifically prevents. Entries
   *  are read via `.current` at event time, so a stable ref object (from
   *  `useRef`) works even if the array literal itself is recreated every
   *  render. */
  ignoreRefs?: Array<RefObject<HTMLElement | null>>;
}

/**
 * Attaches window-level `pointerdown` (outside-click) and `keydown`
 * (Escape) listeners while `open` is true, and returns a ref to attach to
 * the dismissable panel's root element. See this file's header comment for
 * the exact race this prevents and why `ignoreRefs` exists.
 */
export function useDismissable<T extends HTMLElement = HTMLDivElement>({
  open,
  onClose,
  ignoreRefs = [],
}: UseDismissableOptions): RefObject<T | null> {
  const panelRef = useRef<T>(null);

  // Root cause of "Escape doesn't close the popover" (David's repro,
  // 2026-08-15, canvas-legibility legend popover — 100% reproducible with
  // the app hovered/live): every real caller passes an inline lambda for
  // `onClose` (e.g. `onClose={() => setLegendOpen(false)}`), a fresh
  // function identity on EVERY render of the caller. With `onClose` in the
  // effect below's own dependency array, that meant the `window`
  // pointerdown/keydown listeners were torn down and reinstalled on every
  // single re-render of the caller while the panel stayed open — not just
  // on real open/close transitions. This canvas re-renders very often while
  // live (agentsStore mission/status updates), and React's passive-effect
  // flush is not guaranteed to complete inside one synchronous browser task
  // (the Scheduler can spread it across multiple chunks) — so a real
  // Escape keydown could land in a genuine window where the listener was
  // already removed by one render's cleanup but not yet re-added by the
  // next, and was silently dropped. Reading `onClose` through a ref removes
  // the reattach entirely: the effect below now depends only on `open`, so
  // the listeners are installed exactly once per open/close transition,
  // never on an unrelated re-render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    function isIgnored(target: Node): boolean {
      if (panelRef.current?.contains(target)) return true;
      return ignoreRefs.some((ref) => ref.current?.contains(target));
    }

    function handlePointerDown(e: PointerEvent): void {
      if (!isIgnored(e.target as Node)) onCloseRef.current();
    }

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    }

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
    // `ignoreRefs` intentionally excluded: its entries are stable ref
    // objects read via `.current` at call time (not at effect-setup time),
    // so an inline array literal recreated every render never needs to
    // re-attach the listeners. `onClose` is also intentionally excluded now
    // (read via `onCloseRef` above instead) — see this effect's own doc
    // comment just above for why: only `open` identity should ever
    // reattach these listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return panelRef;
}
