/* CockpitRailPopover — the generic "mini-parchemin" shell every
   CockpitLeftRail icon opens (P1-2: rail gauche icônes rondes). Portaled to
   <body>, anchored under the icon that opened it, closes on outside-click
   or Escape — same convention as ApprovalModePopover.tsx / AccountPopover.tsx
   (chrome/popoverPosition.ts's usePopoverPosition for the flip/clamp math).
   Owns no domain data itself: callers pass whichever existing panel
   component (FleetMap, DecisionCenter, BudgetBurn, ProjectReportPage, ...) as
   children, so the underlying data/logic is reused verbatim, never
   re-derived here. `width`/`maxHeight` default to the compact
   "mini-parchemin" size every rail icon uses, but a caller hosting bigger
   content (AgentsSpace.tsx's report popover) can widen it.

   Founder bug fix (2026-07-22): re-clicking a rail icon while its popover
   was already open used to reopen it instantly instead of closing it — this
   component is portaled to `document.body`, so its own outside-pointerdown
   listener saw the rail icon button as "outside" (different DOM subtree),
   closed the popover, and then the button's own onClick toggle (reading the
   now-stale closed state) reopened it. Fixed via useDismissable.ts's shared
   `ignoreRefs` — see that file's header comment for the full race writeup.
   Callers pass the triggering button's ref as `triggerRef` so this
   component can ignore pointerdowns that land on it.

   Size-to-content fix (real user report, 2026-08-14 — Decisions, Budget,
   and KPIs popovers all reported with their own bottom row clipped, and the
   box drawn oversized over the canvas behind it): `usePopoverPosition`
   measures this popover's rendered height ONCE, in a `useLayoutEffect` keyed
   only on the anchor rect's own scalar fields — which never change again
   for a single popover-open session (CockpitLeftRail captures `anchorRect`
   once, at click time). A caller whose content changes size AFTER that one
   measurement (ScorecardPanel's async journal query resolving well after
   its initial "loading" render is what reproduced this live) ends up with
   `top` clamped for a SHORT box while the real, later box is taller — its
   bottom rows render past the visible viewport, not clipped by any CSS
   `overflow`, just literally below the fold. Rather than re-deriving `top`'s
   own accuracy (which would mean re-guessing content height — the exact
   thing that just went stale), `effectiveMaxHeight` below hard-caps the
   box's OWN height to whatever room genuinely exists below `top` right now
   (live `window.innerHeight`, not a stale measurement) — so however tall
   the content wants to be, the box can never extend past the viewport: it
   either fits (the common case, unchanged from before) or the content div's
   own `overflowY:auto` scrolls the remainder into reach. This recomputes on
   every render from `top` + the live viewport, so it self-corrects the
   moment `top` itself updates too — no ResizeObserver needed. Only applied
   when `maxHeight` is a plain number (every CockpitLeftRail popover, the
   480px default): AgentsSpace.tsx's wider report popover passes an explicit
   `"80vh"` string, already viewport-relative and not the surface this bug
   was reported against, so it passes through unchanged. */

import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverPosition } from '../canvas/chrome/popoverPosition';
import { useDismissable } from '../../common/useDismissable';

/** Screen-space rect of whatever the popover is anchored to — a real
 *  DOMRect (getBoundingClientRect on the triggering icon) satisfies this
 *  structurally, but a caller with no clickable element to measure (e.g. a
 *  bus-triggered deep link) can synthesize one instead of needing a real
 *  DOMRect instance. */
export interface PopoverAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CockpitRailPopoverProps {
  title: string;
  /** Rect of the triggering icon button, measured via getBoundingClientRect
   *  at the moment the rail opened this popover (or a synthesized fallback —
   *  see {@link PopoverAnchorRect}). */
  anchorRect: PopoverAnchorRect;
  onClose: () => void;
  /** Distinguishes each icon's popover in tests/DOM, e.g. 'kpis' | 'fleetMap'
   *  | 'decisions' | 'budget'. Used to derive the default data-testid
   *  (`cockpit-rail-popover-${testId}`) unless `dataTestId` overrides it. */
  testId: string;
  /** Overrides the default `cockpit-rail-popover-${testId}` data-testid on
   *  the outer container — for a caller with a pre-existing testid contract
   *  (e.g. AgentsSpace.tsx's report popover, e2e-depended
   *  "project-report-overlay"). */
  dataTestId?: string;
  /** Defaults to the compact 340px "mini-parchemin" size every other rail
   *  icon uses. A caller hosting bigger content (e.g. the report popover)
   *  can widen it — same `min(720px, 92vw)` / `80vh` convention
   *  ArtifactOutputModal.tsx already uses for its own bigger panel. */
  width?: number | string;
  maxHeight?: number | string;
  /** Ref to the rail icon button that opened this popover — ignored by the
   *  outside-pointerdown handler so re-clicking that same button closes the
   *  popover instead of closing-then-reopening it. See useDismissable.ts's
   *  header comment and this file's own doc comment above. Optional so
   *  existing/future callers with no single stable trigger element don't
   *  break; omitting it just means re-clicking a moving/unref'd trigger
   *  falls back to the old (racy) behavior. */
  triggerRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

const POPOVER_WIDTH = 340;
const POPOVER_MAX_HEIGHT = 480;
// Matches popoverPosition.ts's own DEFAULT_MARGIN — the gap this popover's
// `top`/`left` are already clamped to keep from the viewport edge, reused
// here so the height cap agrees with that same clamp (see this file's own
// "Size-to-content fix" doc comment above).
const VIEWPORT_MARGIN = 8;
const MIN_EFFECTIVE_MAX_HEIGHT = 120;

export function CockpitRailPopover({
  title,
  anchorRect,
  onClose,
  testId,
  dataTestId,
  width = POPOVER_WIDTH,
  maxHeight = POPOVER_MAX_HEIGHT,
  triggerRef,
  children,
}: CockpitRailPopoverProps) {
  // `open: true` unconditionally — this component only ever mounts while
  // its popover IS open (CockpitLeftRail conditionally renders it via
  // `openId === 'x' && <CockpitRailPopover .../>`), so mount itself is the
  // open signal; unmount tears the listeners down.
  const containerRef = useDismissable<HTMLDivElement>({
    open: true,
    onClose,
    ignoreRefs: triggerRef ? [triggerRef] : undefined,
  });

  const { left, top } = usePopoverPosition(
    containerRef,
    { anchorTop: anchorRect.top, anchorBottom: anchorRect.bottom, preferredLeft: anchorRect.right + 8 },
    [anchorRect.top, anchorRect.bottom, anchorRect.left, anchorRect.right],
  );

  // Size-to-content fix — see this file's own header doc comment. Only
  // overrides `maxHeight` when it's a plain number (every CockpitLeftRail
  // popover); a caller passing a viewport-relative string (AgentsSpace.tsx's
  // report popover, `"80vh"`) is left exactly as it was.
  const effectiveMaxHeight =
    typeof maxHeight === 'number' && typeof window !== 'undefined'
      ? Math.max(MIN_EFFECTIVE_MAX_HEIGHT, Math.min(maxHeight, window.innerHeight - top - VIEWPORT_MARGIN))
      : maxHeight;

  return createPortal(
    <div
      ref={containerRef}
      data-testid={dataTestId ?? `cockpit-rail-popover-${testId}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        left,
        top,
        width,
        maxHeight: effectiveMaxHeight,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        background: '#1C1C2A',
        border: '1px solid rgba(124,92,255,0.3)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        zIndex: 2200,
        fontFamily: 'var(--font-ui)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--color-text)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}
      >
        {title}
      </div>
      <div style={{ overflowY: 'auto', minHeight: 0 }}>{children}</div>
    </div>,
    document.body,
  );
}
