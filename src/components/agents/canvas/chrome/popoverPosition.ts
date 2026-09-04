/* popoverPosition.ts — fix/canvas-ux R6a BLOQUANT #2: shared flip/clamp math
   for every screen-space `position: fixed` popover anchored to a canvas
   element (GateFeedbackPopover.tsx, EdgeDropNodePicker.tsx,
   CanvasContextMenu.tsx). Evidence (final dogfood f23/f24): GateFeedbackPopover
   only ever clamped its LEFT edge — `top` was always `anchorRect.bottom + 6`,
   unconditionally — so a gate row near the bottom of a short viewport (the
   real repro: an 844px-tall viewport, anchor row bottom near y=845) rendered
   its submit button at y=851, entirely below the visible viewport and
   unclickable (`elementFromPoint` at that screen point never resolves to it).

   `computePopoverPosition` is a plain, side-effect-free function (same
   "pure math, thin hook wrapper" convention as chrome/useZoomLevel.ts's
   `bucketZoom` — unit-testable directly, no component mount needed, see
   src/__tests__/canvasPopoverPosition.test.ts) that:
     - prefers BELOW the anchor (matches every caller's previous behavior for
       the common case — no visible change when there's room);
     - flips ABOVE the anchor when there isn't enough room below AND there's
       more room above;
     - clamps BOTH axes afterward so the box is always fully on-screen no
       matter what, even in the rare case neither side has room (best
       available position, never fully off-screen).

   `usePopoverPosition` measures the ACTUAL rendered box (content height
   varies — a longer translated label, more picker results, …) via
   `useLayoutEffect` (before paint, no visible flash) and re-clamps. The very
   first render has no element to measure yet, so it starts from the same
   "below, horizontally clamped" guess every caller used before this fix —
   the common case (anchor not near an edge) renders identically to before.
*/

import { useLayoutEffect, useState, type RefObject } from 'react';

export type PopoverPlacement = 'above' | 'below';

export interface PopoverPosition {
  left: number;
  top: number;
  placement: PopoverPlacement;
}

/** What the popover is anchored to — a real element's screen rect
 *  (`anchorTop !== anchorBottom`, e.g. GateFeedbackPopover/CanvasContextMenu's
 *  own trigger row) or a single screen point (`anchorTop === anchorBottom`,
 *  e.g. EdgeDropNodePicker's drop position / a context-menu click point). */
export interface PopoverAnchor {
  anchorTop: number;
  anchorBottom: number;
  /** Preferred (unclamped) left edge — the anchor's own left, or a drop
   *  point re-centered by the caller (half the popover's width). */
  preferredLeft: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

const DEFAULT_GAP = 6;
const DEFAULT_MARGIN = 8;

function currentViewport(): ViewportSize {
  return {
    width: typeof window !== 'undefined' ? window.innerWidth : 1200,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  };
}

/**
 * Pure flip/clamp math — see this module's header. `size` of `{0, 0}` (no
 * element measured yet) always resolves to "below, horizontally clamped"
 * (the pre-fix behavior every caller already had for the common case).
 */
export function computePopoverPosition(
  anchor: PopoverAnchor,
  size: PopoverSize,
  viewport: ViewportSize,
  gap: number = DEFAULT_GAP,
  margin: number = DEFAULT_MARGIN,
): PopoverPosition {
  const { anchorTop, anchorBottom, preferredLeft } = anchor;
  const { width, height } = size;

  const spaceBelow = viewport.height - anchorBottom;
  const spaceAbove = anchorTop;
  // Below unless there's genuinely not enough room below AND above has
  // more room to offer — never flips just because above happens to fit
  // too (matches every caller's original "always below" behavior when
  // there's no real reason to change it).
  const placement: PopoverPlacement = spaceBelow >= height + gap || spaceBelow >= spaceAbove ? 'below' : 'above';
  const rawTop = placement === 'below' ? anchorBottom + gap : anchorTop - height - gap;

  const maxTop = Math.max(margin, viewport.height - height - margin);
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const top = Math.min(Math.max(rawTop, margin), maxTop);
  const left = Math.min(Math.max(preferredLeft, margin), maxLeft);

  return { left, top, placement };
}

/**
 * Measures the ACTUAL rendered popover after mount/anchor-change (via the
 * supplied `ref`) and returns the clamped position — see
 * {@link computePopoverPosition}. `deps` drives WHEN the effect re-measures
 * (the anchor's own scalar fields — callers should NOT pass a fresh object
 * every render, see each call site).
 */
export interface UsePopoverPositionOptions {
  /** Distance between the anchor and the popover — callers keep their own
   *  pre-existing gap (GateFeedbackPopover used 6px, EdgeDropNodePicker
   *  used 12px) so this fix changes ZERO visual spacing for the common
   *  "fits below" case, only the previously-missing overflow handling. */
  gap?: number;
  margin?: number;
}

export function usePopoverPosition(
  ref: RefObject<HTMLElement | null>,
  anchor: PopoverAnchor,
  deps: readonly unknown[],
  options: UsePopoverPositionOptions = {},
): PopoverPosition {
  const { gap = DEFAULT_GAP, margin = DEFAULT_MARGIN } = options;
  const [position, setPosition] = useState<PopoverPosition>(() =>
    computePopoverPosition(anchor, { width: 0, height: 0 }, currentViewport(), gap, margin),
  );

  useLayoutEffect(() => {
    const el = ref.current;
    const size: PopoverSize = { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
    const next = computePopoverPosition(anchor, size, currentViewport(), gap, margin);
    setPosition((prev) =>
      prev.left === next.left && prev.top === next.top && prev.placement === next.placement ? prev : next,
    );
    // `anchor`/`ref` are read fresh via closure every run; `deps` (the
    // anchor's own scalar fields) is what actually drives re-measurement —
    // same "explicit deps, not the object identity" convention as
    // GateFeedbackPopover.tsx's own effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return position;
}
