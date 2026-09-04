/* cameraInsets.ts — P47 fix: "panel-aware camera". Every programmatic
   camera move in CanvasView (fitView/setCenter, incl. the minimap click,
   the manager's 'canvas:focus' bus event, the zone mission-roster dot's
   `onFocusNode`) used to center against the FULL container width — with
   the ~360px ManagerOverlay docked right (Cockpit.tsx), a freshly focused
   node landed mostly (David measured ~80%) UNDER that panel: "y a un agent
   invisible". React Flow's own `fitView` supports asymmetric per-side
   `padding` (@xyflow/system's `Padding` — the exact mechanism
   `getViewportForBounds` already uses for its own breathing-room fraction),
   which is the direct fix for every `fitView` call site; `setCenter` has no
   such option, so `setCenterTarget` below derives the manual flow-space
   equivalent.

   ManagerOverlay's collapse state (and CockpitLeftRail's own width) are
   plain LOCAL `useState` in files outside this wave's file-ownership split
   (Cockpit.tsx/ManagerOverlay.tsx) — rather than reaching into those files
   (a second concurrent wave owns them) or threading new props through
   Cockpit, `measureDockedPanelInsets` reads the REAL rendered geometry
   straight off the DOM. This is honest regardless of who owns that state,
   self-heals the instant either panel's width/collapse changes, and adds
   zero coupling — the same "hit-test the real DOM" posture
   useCanvasHoverRecovery.ts already uses in this directory for an
   unrelated defect.

   `visibleCenter` is the one PURE function this module exists to make
   testable (P47's own ask): everything else either wraps it for a specific
   React Flow API (`setCenterTarget` for `setCenter`, `insetFitViewPadding`
   for `fitView`'s `padding` option) or reads the DOM
   (`measureDockedPanelInsets` — proven by the real e2e screenshot harness,
   not unit tests; jsdom has no real layout engine, see CanvasView.test.tsx's
   own "container sizing" caveat for the identical limitation).

   ── fix/canvas-header-toolbar-overlap (David's verbatim: "j'ai toujours
      des agents sur le titre du cluster projet donc illisible", measured
      live at zoom 0.21) ──────────────────────────────────────────────────
   `DockedPanelInsets` gained a THIRD real-DOM measurement, `toolbarHeight`:
   CanvasToolbar.tsx renders as a `<Panel position="top-left">` INSIDE
   `<ReactFlow>`, so after any fitView (boot, the toolbar's own fit button,
   post-arrange "Rangement auto") a zone frame can extend all the way to the
   container's own top edge — and its fixed-size header title then paints
   UNDER the floating toolbar, which sits on top in DOM/paint order. Every
   OTHER programmatic camera move in this file already insets by the
   right-docked ManagerOverlay/left CockpitLeftRail (`panelWidth`/
   `railWidth`) but had NO top inset at all. Same fix shape as those two:
   read the toolbar's REAL rendered bottom edge off the DOM (like
   `measureDockedPanelInsets` already does for the panel/rail widths)
   relative to the canvas container's own top, rather than guessing a
   fraction — the toolbar's actual height (search/overflow menu/legend
   button count all vary) is exactly as unknowable ahead of time as
   ManagerOverlay's collapse state was.
*/

/* ── fix/canvas-manager-camera (round 3 QA, P0-1: "focus_canvas succeeds
   but the camera never moves; zoom stays stuck at 11%") ──────────────────
   `getFitViewNodes`/`getViewportForBounds` (@xyflow/system) clamp a
   `fitView` zoom against `minZoom`/`maxZoom` but otherwise resolve
   whatever the target bounding box computes to — an UNFLOORED `fitView`
   can land anywhere down to React Flow's own technical floor
   (`minZoom={0.1}` on `<ReactFlow>` in CanvasView.tsx), exactly the
   reported "11%, cartes minuscules" symptom. Two distinct floors, not
   one, because the two fits serve different intents (spec's own ask):
   `focus_canvas`/"Voir sur le canvas" must land on something actually
   READABLE (60-80%), while a whole-canvas `arrange_canvas` fit
   legitimately needs more room for many zones at once — its floor only
   guards the illegible extreme; CanvasView.tsx's `fitViewAfterLayout`
   prefers a SCOPED-zone fit (this same readable floor) whenever a scope
   is known, falling back to the whole-canvas floor only when it isn't. */
export const FOCUS_MIN_READABLE_ZOOM = 0.6;
export const ARRANGE_MIN_READABLE_ZOOM = 0.35;

/** Pure decision for `fitViewAfterLayout`'s scoped-vs-whole-canvas branch
 *  (CanvasView.tsx) — `nodeIds: undefined` means "fitView with no `nodes`
 *  filter", i.e. the whole canvas. */
export interface ArrangeFitTarget {
  nodeIds: readonly string[] | undefined;
  minZoom: number;
  maxZoom?: number;
}

/**
 * `scopeRef` is the project zone's {@link NodeRef}-shaped string
 * (`makeRef('project', scope)`) when `useCanvasLayout`'s `runLayoutAll` ran
 * a SCOPED arrange (`layoutZone`, one project); `undefined` for a
 * whole-canvas one (`layoutAll`). `scopeIsLive` is whether that ref
 * currently resolves to a real React Flow node (`ReactFlowInstance.
 * getNode`) — a scope whose project closed/left the canvas between the
 * arrange request and this post-layout fit must fall through to the
 * whole-canvas branch: fitView-ing against zero matching nodes resolves an
 * EMPTY bbox (`getFitViewNodes`, @xyflow/system), not "no scope given".
 *
 * Two distinct floors on purpose (see this module's own header): a scoped
 * fit targets one small zone, so it gets the STRICTER "genuinely readable"
 * floor; a whole-canvas fit legitimately needs more room for many zones, so
 * it only gets the looser "not illegible" floor.
 */
export function resolveArrangeFitTarget(scopeRef: string | undefined, scopeIsLive: boolean): ArrangeFitTarget {
  if (scopeRef && scopeIsLive) {
    return { nodeIds: [scopeRef], minZoom: FOCUS_MIN_READABLE_ZOOM, maxZoom: 1.1 };
  }
  return { nodeIds: undefined, minZoom: ARRANGE_MIN_READABLE_ZOOM };
}

export interface ContainerSize {
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface DockedPanelInsets {
  /**
   * ALWAYS 0 today — see `measureDockedPanelInsets`'s own doc comment.
   * Historically ManagerOverlay's current rendered width (open ~360px, or
   * its collapsed tab ~44px), used to keep every camera move from settling
   * content under the docked panel while it visually overlapped a
   * full-bleed canvas. fix/canvas-overlay-occlusion: CanvasView.tsx now
   * reserves that SAME width as real DOM space (`reservedRightPx` ->
   * `marginRight`, Cockpit.tsx), so the panel structurally cannot overlap
   * the canvas's own box any more — compensating for an overlap that can no
   * longer happen would just double-reserve the same space and needlessly
   * shrink every fit/center computation. Field kept (not removed) so this
   * type's shape — and every existing consumer destructuring it — stays
   * unchanged; a future floating (non-space-reserving) panel could resume
   * populating it.
   */
  panelWidth: number;
  /** CockpitLeftRail's current rendered width (a slim floating icon
   *  column). 0 when absent. */
  railWidth: number;
  /**
   * fix/canvas-header-toolbar-overlap — CanvasToolbar's own rendered
   * bottom edge (`[data-testid="canvas-toolbar"]`), measured relative to
   * the canvas container's (`[data-testid="canvas-view"]`) own top edge —
   * i.e. "how many container-relative px must a camera move reserve at the
   * top so nothing lands under the floating toolbar". 0 when either
   * element can't be found (toolbar not yet mounted, or a standalone
   * render outside the full Cockpit tree — same honest degrade as
   * `panelWidth`/`railWidth` above).
   */
  toolbarHeight: number;
  /**
   * fix/canvas-usable-rect (David's forensics: "fit" clipped content off
   * the LEFT edge because nothing accounted for the left rail in a
   * clamped-zoom scenario — see `computeSafeMinZoom`'s own doc comment for
   * the actual root cause — plus his own explicit ask: "minus the FLUX bar
   * at the bottom, which the minimap also overlaps") — FluxFooter's own
   * rendered height (`[data-testid="flux-footer"]`), measured relative to
   * the canvas container's OWN bottom edge, same "real DOM measurement,
   * not a guess" shape `toolbarHeight` already uses for the top. `0` both
   * when unmeasurable AND when FluxFooter genuinely has nothing to show
   * (it renders `null` with no live activity — FluxFooter.tsx's own doc
   * comment — so the element is simply absent from the DOM, the same
   * honest "nothing to reserve for" case).
   */
  fluxHeight: number;
}

const NO_INSETS: DockedPanelInsets = { panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 };

/** Mirrors `@xyflow/system`'s own `PaddingWithUnit`/`Padding` shape
 *  locally (`@xyflow/system` is a transitive dependency of `@xyflow/react`,
 *  not a direct one in package.json — a structural local type keeps this
 *  module from depending on an undeclared package while staying assignable
 *  wherever React Flow's real `FitViewOptions['padding']` is expected). */
type PaddingWithUnit = `${number}px` | `${number}%` | number;
export interface InsetFitViewPadding {
  top?: PaddingWithUnit;
  right?: PaddingWithUnit;
  bottom?: PaddingWithUnit;
  left?: PaddingWithUnit;
}

/**
 * Real-DOM measurement of the floating cockpit chrome (the left rail + the
 * in-canvas floating toolbar) that occludes the canvas — see this module's
 * own header for why DOM reads (not threaded props) are the right seam
 * here. `anchor` is any element that lives inside the SAME
 * `cockpit-fullbleed-root` as the cockpit overlays (Cockpit.layout.test.tsx's
 * own invariant: canvas-view/manager-overlay/cockpit-left-rail are all
 * direct children of that root; the toolbar itself lives deeper, inside
 * canvas-view's own `<ReactFlow>` tree, but a `querySelector` on the root's
 * subtree finds it regardless of depth) — CanvasView's own outer container
 * ref qualifies. Falls back to all-zero insets outside that DOM shape (no
 * root found, no rail/toolbar mounted, or a non-browser environment) rather
 * than throwing — a missing panel is honestly "no inset needed", not an
 * error.
 *
 * fix/canvas-overlay-occlusion — `panelWidth` (ManagerOverlay) is no longer
 * measured here at all: it is ALWAYS `0` now (see `DockedPanelInsets.
 * panelWidth`'s own doc comment). CanvasView.tsx reserves that overlay's
 * live width as real DOM space (`reservedRightPx`), so nothing this
 * function's CALLERS render can structurally end up under it any more —
 * measuring it here too and folding it into fitView padding/setCenter math
 * would double-reserve the identical space a second time, needlessly
 * shrinking the achievable fit/center for no remaining overlap to guard
 * against. `railWidth` keeps its DOM measurement unchanged: CockpitLeftRail
 * still floats OVER the (now-narrower) canvas, unreserved — a deliberately
 * separate, out-of-scope concern this fix does not touch.
 */
export function measureDockedPanelInsets(anchor: Element | null): DockedPanelInsets {
  if (!anchor || typeof HTMLElement === 'undefined') return NO_INSETS;
  const root = anchor.closest('[data-testid="cockpit-fullbleed-root"]') ?? anchor.parentElement;
  if (!root) return NO_INSETS;
  const rail = root.querySelector('[data-testid="cockpit-left-rail"]');
  // fix/canvas-header-toolbar-overlap — the toolbar's own bottom edge,
  // relative to the CONTAINER's top edge (both read via getBoundingClientRect,
  // always viewport-relative, so the subtraction is correct regardless of
  // whatever chrome sits above the container itself, e.g. a future header
  // bar) — never the toolbar's raw `height` alone, which would miss
  // whatever margin the `<Panel position="top-left">` wrapper itself
  // contributes.
  const container = root.querySelector('[data-testid="canvas-view"]');
  const toolbar = root.querySelector('[data-testid="canvas-toolbar"]');
  let toolbarHeight = 0;
  if (container instanceof HTMLElement && toolbar instanceof HTMLElement) {
    const containerRect = container.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const containerHeight = containerRect.bottom - containerRect.top;
    const rawToolbarHeight = toolbarRect.bottom - containerRect.top;
    // Guard against a degenerate measurement — e.g. canvasTestEnv.ts's
    // shared jsdom shim, which reports the SAME full-pane rect for EVERY
    // element (jsdom has no real layout engine, this module's own header
    // already flags this class of limitation) — where the "toolbar" would
    // otherwise appear to span the ENTIRE container. A real floating
    // toolbar is always comfortably shorter than the whole canvas; falling
    // back to 0 (no top inset) here is the same honest degrade this
    // function already uses for every other missing/unmeasurable element,
    // and matches every pre-existing test built on that shared shim.
    toolbarHeight = rawToolbarHeight > 0 && rawToolbarHeight < containerHeight ? rawToolbarHeight : 0;
  }
  // fix/canvas-usable-rect — FluxFooter's own bottom-occlusion height,
  // mirroring the toolbar's top-occlusion measurement above (both relative
  // to the container's own edges, both degrading to 0 on the same
  // degenerate-jsdom-shim guard). Cockpit.tsx renders FluxFooter's wrapper
  // as a plain sibling of `canvas-view` under the SAME root this function
  // already searches, `position: absolute; bottom: 0` — so its measured
  // `top` (not `height` alone, same rationale as the toolbar's `bottom`)
  // relative to the container's own bottom edge is the real occlusion.
  const flux = root.querySelector('[data-testid="flux-footer"]');
  let fluxHeight = 0;
  if (container instanceof HTMLElement && flux instanceof HTMLElement) {
    const containerRect = container.getBoundingClientRect();
    const fluxRect = flux.getBoundingClientRect();
    const containerHeight = containerRect.bottom - containerRect.top;
    const rawFluxHeight = containerRect.bottom - fluxRect.top;
    fluxHeight = rawFluxHeight > 0 && rawFluxHeight < containerHeight ? rawFluxHeight : 0;
  }
  return {
    panelWidth: 0,
    railWidth: rail instanceof HTMLElement ? rail.getBoundingClientRect().width : 0,
    toolbarHeight,
    fluxHeight,
  };
}

/**
 * The point (container-relative CSS pixels) that reads as "the center of
 * the canvas" to a user once a right-docked panel (`panelWidth`) and/or a
 * left rail (`railWidth`) occlude part of the container. Plain
 * `viewport.width/2, viewport.height/2` — what every un-inset
 * `fitView()`/`setCenter()` call implicitly assumes — is only correct when
 * BOTH are 0; otherwise it lands past the true midpoint of what's actually
 * visible, INTO the occluded strip (P47's bug). Negative/oversized inputs
 * are clamped so a transient 0-size measurement (mount race, panel wider
 * than the container) never yields a center outside the container's own
 * bounds.
 *
 * fix/canvas-header-toolbar-overlap — `topInset` (optional, defaults to `0`
 * so every P47-era caller/test that never passed one keeps its EXACT prior
 * behavior) is the same idea applied to the floating top-left toolbar: the
 * ONLY chrome in Cockpit.tsx that occludes the canvas vertically (P47's
 * panel/rail float near-full-height, never occluding top/bottom — that part
 * of the original doc comment still holds for THOSE two).
 */
export function visibleCenter(
  viewport: ContainerSize,
  panelWidth: number,
  railWidth: number,
  topInset: number = 0,
): ScreenPoint {
  const panel = Math.max(panelWidth, 0);
  const rail = Math.max(railWidth, 0);
  const top = Math.max(topInset, 0);
  const visibleWidth = Math.max(viewport.width - panel - rail, 0);
  const visibleHeight = Math.max(viewport.height - top, 0);
  return {
    x: rail + visibleWidth / 2,
    y: top + visibleHeight / 2,
  };
}

/**
 * `ReactFlowInstance.setCenter(x, y, { zoom })` always places flow point
 * `(x, y)` at the FULL container's geometric center — it has no `padding`
 * option (unlike `fitView`). This derives the adjusted flow-space target to
 * hand `setCenter` instead, so the ORIGINAL `point` ends up at
 * `visibleCenter` (the panel/rail-aware center) rather than the raw
 * midpoint. Math: `setCenter` solves `pan = containerCenter - target*zoom`;
 * we want `point`'s own screen position (`point*zoom + pan`) to land on
 * `visibleCenter`, which — substituting `pan` for the ADJUSTED `target` —
 * resolves to `target = point + (containerCenter - visibleCenter) / zoom`.
 * `zoom` must be the SAME zoom value the `setCenter` call itself will use
 * (its current zoom, when the caller passes it back explicitly — React
 * Flow otherwise defaults `setCenter`'s own missing `zoom` to `maxZoom`,
 * see CanvasView's minimap `onClick` handler for that exact surprise).
 */
export function setCenterTarget(
  point: ScreenPoint,
  viewport: ContainerSize,
  insets: DockedPanelInsets,
  zoom: number,
): ScreenPoint {
  const safeZoom = zoom > 0 ? zoom : 1;
  // fix/canvas-header-toolbar-overlap — `toolbarHeight` folds the same
  // top-inset fix `insetFitViewPadding` applies to `fitView` into this
  // `setCenter`-shaped math too (the minimap click, CanvasView's own
  // `getPanelAwareCenterTarget`): without it, `setCenter` could still land a
  // point directly under the floating toolbar even though every `fitView`
  // call site is fixed.
  const center = visibleCenter(viewport, insets.panelWidth, insets.railWidth, insets.toolbarHeight);
  const containerCenterX = viewport.width / 2;
  const containerCenterY = viewport.height / 2;
  return {
    x: point.x + (containerCenterX - center.x) / safeZoom,
    y: point.y + (containerCenterY - center.y) / safeZoom,
  };
}

/** Default empty-gutter kept on every side even with no docked panel/rail
 *  (matches the pre-existing FIT_VIEW_OPTIONS/POST_ARRANGE_FIT_VIEW_OPTIONS
 *  "breathing room" convention, CanvasView.tsx's own doc comments). Exported
 *  so a caller threading {@link CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX} through
 *  positionally (below) can still pass this exact default for the
 *  horizontal-gutter argument in between, instead of re-declaring a private
 *  copy of the same number. */
export const DEFAULT_HORIZONTAL_GUTTER_PX = 24;

/**
 * fix/canvas-toolbar-fit-floor (David's real-app measurement, packaged
 * build, 1440x844, manager collapsed, after "Ranger" + "Fit view": toolbar's
 * own rendered rect y=79..121 — i.e. Panel's default ~15-16px top margin
 * plus the toolbar's own ~38-42px fixed height, `fix/canvas-toolbar-
 * oscillation`'s now-permanently-static single-row shape — but the FIRST
 * row of zone plaques landed at top=95, INSIDE that range, meaning the
 * measured `toolbarHeight` inset (`measureDockedPanelInsets`, above) did not
 * actually reserve the ~70px `usableCanvasRect` should have computed for
 * that call). A real-DOM measurement can rely on the toolbar/container
 * elements resolving cleanly at the exact instant a fit runs; a plain
 * constant cannot fail that way. Since `fix/canvas-toolbar-oscillation` made
 * the toolbar's own on-screen footprint permanently static (one row, never
 * re-measured, never wrapped), a constant floor is not a workaround for a
 * moving target — it is describing a value that, by design, no longer
 * moves. Applied as a FLOOR on top of (never a replacement for) the real
 * measurement in {@link usableCanvasRect}/{@link insetFitViewPadding} —
 * whichever of the two is bigger wins, so a real future toolbar redesign
 * that measures taller than this is still honored. Deliberately NOT the
 * default for every caller of those two functions (existing callers/tests
 * that have no toolbar in their DOM at all — a standalone render, or the
 * "toolbar absent" unit tests in cameraInsets.test.ts — must keep falling
 * back to the plain fraction padding, unaffected): only the real
 * toolbar-aware call sites (CanvasToolbar.tsx's own "Fit view" button,
 * CanvasView.tsx's `getPanelAwarePadding`/dynamic-min-zoom recompute,
 * useCanvasManagerEvents.ts's focus/arrange fit) pass it explicitly.
 *
 * Sized generously above the ~70px the measured numbers above imply (Panel
 * margin ~15px + toolbar height ~42px + {@link DEFAULT_TOP_GUTTER_PX} 12px
 * ≈ 69px) — a few extra px of top padding costs nothing on an 844px-tall
 * viewport, while being too small would silently reproduce this exact bug.
 */
export const CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX = 76;

/**
 * fix/canvas-toolbar-fit-floor round 2 (David's corrected real-app
 * measurement: his first repro measured `[data-testid="project-node-name"]`
 * — a SPAN that lives INSIDE the plaque, below its own top edge — reading
 * "0px occluded"; the real box is `.canvas-zone-header`, and THAT one
 * measured `top=86` while the toolbar spans `y=79..121` — squarely
 * overlapping, even with {@link CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX} already
 * applied). Root cause: `fitView`'s bbox comes from `getNodesBounds` over
 * REACT FLOW NODES only — the zone title plaque
 * (`ProjectGroupNode.tsx`'s `canvas-zone-header`) is not itself a node, it's
 * a sibling DOM element floating ABOVE the node's own box via `position:
 * absolute; bottom: calc(100% + gap)` (see `scratch/_canvas-label-design.md`
 * §1 / fix/canvas-title-float in geometry.ts's `ZONE_TITLE_BAND_HEIGHT` doc
 * comment). Reserving room only for the toolbar relative to the NODE's own
 * top edge still lets the plaque — which floats further up still — poke
 * back into the toolbar's territory, exactly the measured repro.
 *
 * The fix is the SAME shape as the toolbar floor above: a plain constant,
 * evaluated once per fit call, no DOM measurement of the plaque at all
 * (it isn't even a React Flow node — there's nothing to measure it
 * AGAINST via `getNodesBounds`). Duplicated here as literal numbers rather
 * than imported (this module's own established convention — see
 * geometry.ts's `ZONE_SPACING_PRACTICAL_ZOOM` doc comment: "duplicated as a
 * value, not a cross-import... `cameraInsets.ts` lives one layer up"):
 *   - 44 = chrome/lod.ts's `ZONE_TITLE_BAND_TARGET_PX` — the plaque's own
 *     contre-scaled row height, held at this constant SCREEN px for any
 *     zoom down to `LOD_FLOOR_ZOOM` (0.25) — i.e. genuinely screen-constant
 *     at any fit zoom this floor is meant to guard (well above 0.25 for a
 *     handful-to-dozens of zones).
 *   - 16 = geometry.ts's `ZONE_TITLE_GAP_ABOVE` — the breathing gap between
 *     the plaque's own top edge and whatever sits above it. NOT itself
 *     contre-scaled (shrinks proportionally with zoom), so treating it at
 *     its full FLOW value here is deliberately generous — an
 *     over-reservation at a typical fit zoom (< 16 real screen px once
 *     zoom < 1), never an under one. Same "erring wide" discipline
 *     geometry.ts's own spacing constants already use.
 */
export const CANVAS_ZONE_PLAQUE_SCREEN_HEIGHT_PX = 44 + 16; // 60

/**
 * The actual value every toolbar-aware fit call site passes as
 * `minTopReservePx` — the toolbar's own floor PLUS the plaque's own
 * screen footprint above the node box, so the reserved top padding clears
 * BOTH: the node box lands below the toolbar (as before), and the plaque
 * floating further up from that node box still lands below the toolbar too.
 */
export const CANVAS_FIT_TOP_RESERVE_PX = CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX + CANVAS_ZONE_PLAQUE_SCREEN_HEIGHT_PX; // 136

/** fix/canvas-header-toolbar-overlap — extra breathing room (CSS px) kept
 *  BELOW the floating toolbar's own measured bottom edge, on top of
 *  whatever margin that measurement already includes (the `<Panel>`
 *  wrapper's own default margin) — mirrors
 *  {@link DEFAULT_HORIZONTAL_GUTTER_PX}'s role for the panel/rail sides.
 *  Smaller than the horizontal gutter: the toolbar's own rounded corners/
 *  box-shadow already read as "past the toolbar" a few px before its
 *  literal DOM edge. */
const DEFAULT_TOP_GUTTER_PX = 12;

/**
 * fix/canvas-usable-rect (David's explicit ask: "make it one usable canvas
 * rect helper so every framing path shares it, rather than each caller
 * subtracting what it happens to know about") — the SINGLE source of truth
 * for "how much of the container is actually usable canvas, per side",
 * accounting for the left rail, the right-docked panel (currently always 0
 * — see `DockedPanelInsets.panelWidth`'s own doc comment), the floating top
 * toolbar, and the bottom FLUX bar. Returns the EXACT shape `fitView`'s own
 * `padding` option expects (px string once a side is really measurable,
 * else the caller's plain fraction) so it can be handed to a real
 * `fitView()`/`getViewportForBounds()` call directly — `insetFitViewPadding`
 * below is now a one-line alias kept for every existing call site's own
 * naming; `computeSafeMinZoom` (the natural, unclamped fit zoom used to
 * guard against a readability floor forcing content off-screen) consumes
 * the SAME return value, so the two can never independently drift apart.
 *
 * fix/canvas-toolbar-fit-floor — `minTopReservePx` (optional, defaults to
 * `0` so every pre-existing caller/test keeps its EXACT prior behavior) lets
 * a toolbar-aware caller pass {@link CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX} as a
 * FLOOR under whatever the real DOM measurement computes — see that
 * constant's own doc comment for why a floor, not a replacement.
 */
export function usableCanvasRect(
  insets: DockedPanelInsets,
  verticalPadding: number,
  horizontalGutterPx: number = DEFAULT_HORIZONTAL_GUTTER_PX,
  minTopReservePx: number = 0,
): InsetFitViewPadding {
  const toolbarHeight = Math.max(insets.toolbarHeight, 0);
  const fluxHeight = Math.max(insets.fluxHeight, 0);
  const left = Math.max(insets.railWidth, 0) + horizontalGutterPx;
  const right = Math.max(insets.panelWidth, 0) + horizontalGutterPx;
  const measuredTop = toolbarHeight > 0 ? toolbarHeight + DEFAULT_TOP_GUTTER_PX : 0;
  const effectiveTop = Math.max(measuredTop, Math.max(minTopReservePx, 0));
  return {
    top: effectiveTop > 0 ? `${Math.round(effectiveTop)}px` : verticalPadding,
    // fix/canvas-usable-rect — same treatment as `top`/`toolbarHeight`: a
    // real px value once FluxFooter's occlusion is measurable, falling back
    // to the plain fraction (the ORIGINAL, pre-this-fix behavior) when it
    // isn't — never worse than before this fix existed.
    bottom: fluxHeight > 0 ? `${Math.round(fluxHeight + DEFAULT_TOP_GUTTER_PX)}px` : verticalPadding,
    left: `${Math.round(left)}px`,
    right: `${Math.round(right)}px`,
  };
}

/**
 * `fitView`'s own `padding` option — a one-line alias for
 * `usableCanvasRect` (this module's own single source of truth, see that
 * function's own doc comment) kept under its original, more
 * call-site-familiar name. `getViewportForBounds` resolves asymmetric
 * padding correctly WHEN the resolved zoom is not itself clamped above what
 * the content can actually fit into that padding — see
 * `computeSafeMinZoom`'s own doc comment for the case where it can't:
 * David's measured "fit clips content off the left edge" regression was
 * exactly a `minZoom` floor forcing zoom higher than the padded content
 * could satisfy, which this function alone cannot prevent on its own — a
 * caller passing a floor to `fitView` should run it through
 * `computeSafeMinZoom` first.
 *
 * fix/canvas-toolbar-fit-floor — `minTopReservePx` forwards straight to
 * {@link usableCanvasRect}'s own new parameter (see its doc comment).
 */
export function insetFitViewPadding(
  insets: DockedPanelInsets,
  verticalPadding: number,
  horizontalGutterPx: number = DEFAULT_HORIZONTAL_GUTTER_PX,
  minTopReservePx: number = 0,
): InsetFitViewPadding {
  return usableCanvasRect(insets, verticalPadding, horizontalGutterPx, minTopReservePx);
}

/**
 * fix/canvas-usable-rect (David's forensics: after this session's own
 * ARRANGE_MIN_READABLE_ZOOM floor landed on the toolbar's plain "Fit view"
 * button, a busier canvas whose content genuinely needs to zoom out FURTHER
 * than that floor to fit within the padded usable area got its zoom forced
 * UP to the floor anyway — `getViewportForBounds`'s own asymmetric-padding
 * correction can only PULL a side IN to satisfy padding, never shrink
 * over-sized content to fit both sides at once, so the result centers on
 * the plain (un-padded) viewport instead and the side with the BIGGER
 * padding demand — here, the left rail's inset, bigger than the right's
 * now that the panel reserves real space — spills off-screen. Measured:
 * "-96" reproduced with realistic numbers; David's own repro measured
 * "-59") — a `minZoom` floor must never win over "keep the content
 * actually visible". This computes the NATURAL (fully unclamped) fit zoom
 * for the SAME bounds/container/padding a real `fitView` call will use, and
 * returns `Math.min(requestedFloor, natural)`: when the natural fit is
 * already at or above the floor, this is a no-op (the floor applies exactly
 * as before); when the natural fit needs MORE room than the floor allows,
 * the floor itself is what backs off — content staying fully visible always
 * wins over the softer "stay comfortably readable" preference.
 */
export function computeSafeMinZoom(
  bounds: { x: number; y: number; width: number; height: number },
  containerSize: ContainerSize,
  padding: InsetFitViewPadding,
  requestedFloor: number,
  getViewportForBoundsFn: (
    bounds: { x: number; y: number; width: number; height: number },
    width: number,
    height: number,
    minZoom: number,
    maxZoom: number,
    padding: InsetFitViewPadding,
  ) => { zoom: number },
): number {
  if (bounds.width <= 0 || bounds.height <= 0 || containerSize.width <= 0 || containerSize.height <= 0) {
    return requestedFloor;
  }
  // 0 (not the real technical floor) — this call exists ONLY to learn what
  // zoom the content would naturally settle at with no floor applied at all.
  const natural = getViewportForBoundsFn(bounds, containerSize.width, containerSize.height, 0, 2, padding).zoom;
  if (!Number.isFinite(natural) || natural <= 0) return requestedFloor;
  return Math.min(requestedFloor, natural);
}

/**
 * fix/canvas-transverse-fit-outlier (David's measured regression, live CDP:
 * whole-canvas "Fit view" settled at zoom 0.116 with 8 open project zones —
 * "unreadable thumbnails crammed in a corner of a mostly empty canvas").
 *
 * `computeSafeMinZoom` above is deliberately unfloored on the low end
 * (`Math.min(requestedFloor, natural)` — "content staying fully visible
 * always wins over the softer 'stay comfortably readable' preference", see
 * its own doc comment). That is the right call for LEGITIMATE large
 * content, but it means a single outlier TOP-LEVEL node — a zone whose
 * position is far from the rest of the packed layout — has NO ceiling on
 * how far it can drag the whole canvas's zoom down, because once its
 * `natural` fit drops below the floor, the floor itself backs off to match.
 *
 * Reproduced directly (canvasFit.test.ts): 8 real project zones pack into
 * ~1770x860 (natural fit ~0.79, comfortably above the 0.35 arrange floor).
 * Adding the synthetic Transverse zone (reconciler.ts's
 * `TRANSVERSE_PROJECT_ID` — manager plan drafts/missions with no
 * `projectId`, and leftovers from closed projects) at a STALE/pinned
 * position far from that cluster (the same class of bug
 * `migrateBloatedZoneRowPositions`/`declutterPinnedZones` already guard
 * real project zones against, but never applied to Transverse specifically)
 * collapses the natural fit to ~0.13 — matching the live 0.116 measurement.
 * A handful of realistic Transverse drafts with NO stale position never
 * reproduces this (natural fit degrades gracefully, still >0.3 with 30+
 * items) — the outlier POSITION is the actual defect, not the content
 * volume.
 *
 * Rather than bound "how stale is too stale" (fragile — the exact class of
 * position bug this is already defeated one prior fix), the whole-canvas
 * "Fit view" now targets what a user actually means by "fit": their OPEN
 * PROJECT zones. Transverse holds orphaned/not-yet-assigned content —
 * legitimately real, but not the primary work surface a "Fit view" click is
 * framing, and nothing here removes it from the canvas — the user can pan
 * to it directly. Falls back to every top-level node (including Transverse)
 * when it is the ONLY content, so a fleet with zero open projects still
 * resolves a real bbox instead of an empty one.
 */
export function selectWholeCanvasFitNodes<T extends { id: string; parentId?: string | null }>(
  nodes: readonly T[],
  transverseZoneRef: string,
): T[] {
  const topLevel = nodes.filter((n) => !n.parentId);
  const realZones = topLevel.filter((n) => n.id !== transverseZoneRef);
  return realZones.length > 0 ? realZones : topLevel;
}
