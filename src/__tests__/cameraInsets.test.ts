/**
 * Tests for cameraInsets.ts (P47 — panel-aware camera). `visibleCenter` is
 * the explicitly-required pure-math unit under test; `setCenterTarget`/
 * `insetFitViewPadding` are covered too (still pure, deterministic), and
 * `measureDockedPanelInsets`'s real-DOM branch gets a light jsdom check
 * (element lookup + width read) — see that function's own doc comment for
 * why the geometry itself is proven by the e2e harness, not here.
 */

import { describe, it, expect } from 'vitest';
import { getViewportForBounds } from '@xyflow/react';
import {
  visibleCenter,
  setCenterTarget,
  insetFitViewPadding,
  measureDockedPanelInsets,
  resolveArrangeFitTarget,
  usableCanvasRect,
  computeSafeMinZoom,
  FOCUS_MIN_READABLE_ZOOM,
  ARRANGE_MIN_READABLE_ZOOM,
  CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX,
  CANVAS_ZONE_PLAQUE_SCREEN_HEIGHT_PX,
  CANVAS_FIT_TOP_RESERVE_PX,
  type InsetFitViewPadding,
} from '../components/agents/canvas/cameraInsets';

// fix/canvas-manager-camera (round 3 QA, P0-1: "zoom reste bloque a 11%") —
// both floors must sit meaningfully above React Flow's own 0.1 technical
// floor (CanvasView.tsx's `<ReactFlow minZoom={0.1}>`), and the focus floor
// (a small/single-node target) must be the STRICTER of the two (spec ask:
// "typiquement >= 60-80%" for focus_canvas vs. "ne doit jamais retomber sous
// un seuil illisible" — a looser bar — for a whole-canvas arrange fit).
describe('readable zoom floors', () => {
  it('FOCUS_MIN_READABLE_ZOOM sits within the spec\'s 60-80% band', () => {
    expect(FOCUS_MIN_READABLE_ZOOM).toBeGreaterThanOrEqual(0.6);
    expect(FOCUS_MIN_READABLE_ZOOM).toBeLessThanOrEqual(0.8);
  });

  it('ARRANGE_MIN_READABLE_ZOOM is looser than the focus floor but still well above the 0.1 technical floor', () => {
    expect(ARRANGE_MIN_READABLE_ZOOM).toBeLessThan(FOCUS_MIN_READABLE_ZOOM);
    expect(ARRANGE_MIN_READABLE_ZOOM).toBeGreaterThan(0.1);
  });
});

describe('resolveArrangeFitTarget', () => {
  it('targets the scoped zone alone, at the stricter readable floor, when the scope is live', () => {
    expect(resolveArrangeFitTarget('project:p1', true)).toEqual({
      nodeIds: ['project:p1'],
      minZoom: FOCUS_MIN_READABLE_ZOOM,
      maxZoom: 1.1,
    });
  });

  it('falls back to a whole-canvas fit (looser floor) when no scope is given (whole-canvas arrange)', () => {
    expect(resolveArrangeFitTarget(undefined, false)).toEqual({
      nodeIds: undefined,
      minZoom: ARRANGE_MIN_READABLE_ZOOM,
    });
  });

  it('falls back to whole-canvas even with a scope ref when that zone is no longer live (project closed mid-flight)', () => {
    expect(resolveArrangeFitTarget('project:closed', false)).toEqual({
      nodeIds: undefined,
      minZoom: ARRANGE_MIN_READABLE_ZOOM,
    });
  });
});

describe('visibleCenter', () => {
  it('with no panel and no rail, matches the plain full-container center', () => {
    expect(visibleCenter({ width: 1200, height: 800 }, 0, 0)).toEqual({ x: 600, y: 400 });
  });

  it('a right-docked panel shifts the visible center LEFT of the full center', () => {
    const result = visibleCenter({ width: 1200, height: 800 }, 360, 0);
    // visible region spans [0, 840]; its center is 420 — left of 600.
    expect(result).toEqual({ x: 420, y: 400 });
    expect(result.x).toBeLessThan(600);
  });

  it('a left rail alone shifts the visible center RIGHT of the full center', () => {
    const result = visibleCenter({ width: 1200, height: 800 }, 0, 56);
    // visible region spans [56, 1200]; its center is (56+1200)/2 = 628.
    expect(result).toEqual({ x: 628, y: 400 });
    expect(result.x).toBeGreaterThan(600);
  });

  it('panel + rail together compose (both insets applied)', () => {
    // visible region spans [56, 840]; its center is (56+840)/2 = 448.
    expect(visibleCenter({ width: 1200, height: 800 }, 360, 56)).toEqual({ x: 448, y: 400 });
  });

  it('with no top inset (the default), matches the plain height/2 center — neither panel/rail overlay occludes vertically', () => {
    expect(visibleCenter({ width: 1200, height: 900 }, 360, 56).y).toBe(450);
  });

  it('clamps a negative panel/rail width to 0 (defensive, never a wider-than-real visible region)', () => {
    expect(visibleCenter({ width: 1000, height: 600 }, -50, 0)).toEqual(visibleCenter({ width: 1000, height: 600 }, 0, 0));
  });

  it('clamps an oversized panel+rail so visible width never goes negative', () => {
    // panel(700) + rail(700) > width(1000) — visibleWidth floors at 0.
    const result = visibleCenter({ width: 1000, height: 600 }, 700, 700);
    expect(result.x).toBe(700); // rail + 0/2
  });

  // fix/canvas-header-toolbar-overlap — a top-docked floating toolbar
  // (David's verbatim repro: "j'ai toujours des agents sur le titre du
  // cluster projet donc illisible") is the one occlusion that DOES touch
  // the Y axis, unlike the right panel/left rail above.
  describe('topInset (fix/canvas-header-toolbar-overlap)', () => {
    it('a top-docked toolbar shifts the visible center DOWN, below the full center', () => {
      const result = visibleCenter({ width: 1200, height: 800 }, 0, 0, 100);
      // visible region spans [100, 800]; its center is (100+800)/2 = 450.
      expect(result).toEqual({ x: 600, y: 450 });
      expect(result.y).toBeGreaterThan(400);
    });

    it('composes with the panel/rail horizontal insets (all three occlusions applied together)', () => {
      // x: same as the "panel + rail together" case above (unaffected by topInset).
      // y: visible region spans [100, 800]; its center is (100+800)/2 = 450.
      expect(visibleCenter({ width: 1200, height: 800 }, 360, 56, 100)).toEqual({ x: 448, y: 450 });
    });

    it('clamps a negative top inset to 0 (defensive, matches the panel/rail clamp convention)', () => {
      expect(visibleCenter({ width: 1200, height: 800 }, 0, 0, -20)).toEqual(visibleCenter({ width: 1200, height: 800 }, 0, 0, 0));
    });

    it('omitting topInset entirely is identical to passing 0 (backward-compatible default)', () => {
      expect(visibleCenter({ width: 1200, height: 800 }, 360, 56)).toEqual(visibleCenter({ width: 1200, height: 800 }, 360, 56, 0));
    });
  });
});

describe('setCenterTarget', () => {
  const viewport = { width: 1200, height: 800 };

  it('is a no-op (returns the same point) with zero insets', () => {
    const point = { x: 500, y: 300 };
    expect(setCenterTarget(point, viewport, { panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 1)).toEqual(point);
  });

  it('shifts the target RIGHT (in flow space) to compensate for a right-docked panel, at zoom 1', () => {
    const point = { x: 500, y: 300 };
    const target = setCenterTarget(point, viewport, { panelWidth: 360, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 1);
    // containerCenter.x=600, visibleCenter.x=420 -> dx=(600-420)/1=180
    expect(target.x).toBe(680);
    expect(target.y).toBe(300); // unaffected — no toolbar inset in this case
  });

  it('the same screen-space offset requires a proportionally larger flow-space shift at a lower zoom', () => {
    const point = { x: 500, y: 300 };
    const atZoom1 = setCenterTarget(point, viewport, { panelWidth: 360, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 1);
    const atZoomHalf = setCenterTarget(point, viewport, { panelWidth: 360, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.5);
    expect(atZoomHalf.x - point.x).toBeCloseTo((atZoom1.x - point.x) * 2, 5);
  });

  it('actually lands the original point at the visible center once fed back through setCenter\'s own formula', () => {
    const point = { x: 500, y: 300 };
    const insets = { panelWidth: 360, railWidth: 56, toolbarHeight: 0, fluxHeight: 0 };
    const zoom = 0.8;
    const target = setCenterTarget(point, viewport, insets, zoom);
    // Reproduces ReactFlowInstance.setCenter's own pan formula.
    const pan = { x: viewport.width / 2 - target.x * zoom, y: viewport.height / 2 - target.y * zoom };
    const screenPos = { x: point.x * zoom + pan.x, y: point.y * zoom + pan.y };
    const expectedCenter = visibleCenter(viewport, insets.panelWidth, insets.railWidth, insets.toolbarHeight);
    expect(screenPos.x).toBeCloseTo(expectedCenter.x, 5);
    expect(screenPos.y).toBeCloseTo(expectedCenter.y, 5);
  });

  it('falls back to zoom=1 semantics for a zero/negative zoom (never divides by 0)', () => {
    const point = { x: 500, y: 300 };
    const insets = { panelWidth: 360, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 };
    expect(setCenterTarget(point, viewport, insets, 0)).toEqual(setCenterTarget(point, viewport, insets, 1));
    expect(setCenterTarget(point, viewport, insets, -2)).toEqual(setCenterTarget(point, viewport, insets, 1));
  });

  // fix/canvas-header-toolbar-overlap — same coverage as the panel/rail
  // cases above, for the toolbar's own top occlusion.
  describe('toolbarHeight (fix/canvas-header-toolbar-overlap)', () => {
    it('shifts the target DOWN (in flow space) to compensate for the floating toolbar, at zoom 1', () => {
      const point = { x: 500, y: 300 };
      const target = setCenterTarget(point, viewport, { panelWidth: 0, railWidth: 0, toolbarHeight: 100, fluxHeight: 0 }, 1);
      // containerCenter.y=400, visibleCenter.y=450 -> dy=(400-450)/1=-50
      expect(target.y).toBe(250);
      expect(target.x).toBe(500); // unaffected — no horizontal occlusion
    });

    it('actually lands the original point at the visible center once fed back through setCenter\'s own formula', () => {
      const point = { x: 500, y: 300 };
      const insets = { panelWidth: 360, railWidth: 56, toolbarHeight: 100, fluxHeight: 0 };
      const zoom = 0.8;
      const target = setCenterTarget(point, viewport, insets, zoom);
      const pan = { x: viewport.width / 2 - target.x * zoom, y: viewport.height / 2 - target.y * zoom };
      const screenPos = { x: point.x * zoom + pan.x, y: point.y * zoom + pan.y };
      const expectedCenter = visibleCenter(viewport, insets.panelWidth, insets.railWidth, insets.toolbarHeight);
      expect(screenPos.x).toBeCloseTo(expectedCenter.x, 5);
      expect(screenPos.y).toBeCloseTo(expectedCenter.y, 5);
    });
  });
});

describe('insetFitViewPadding', () => {
  it('with no docked panel/rail/toolbar measurement, both sides still carry the default gutter, and top falls back to the plain fraction (never worse than pre-fix)', () => {
    expect(insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.2)).toEqual({
      top: 0.2,
      bottom: 0.2,
      left: '24px',
      right: '24px',
    });
  });

  it('folds the panel width into the RIGHT padding and the rail width into the LEFT padding', () => {
    expect(insetFitViewPadding({ panelWidth: 360, railWidth: 56, toolbarHeight: 0, fluxHeight: 0 }, 0.15)).toEqual({
      top: 0.15,
      bottom: 0.15,
      left: '80px',
      right: '384px',
    });
  });

  it('accepts a custom base gutter', () => {
    expect(insetFitViewPadding({ panelWidth: 100, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.2, 10)).toEqual({
      top: 0.2,
      bottom: 0.2,
      left: '10px',
      right: '110px',
    });
  });

  // fix/canvas-header-toolbar-overlap — David's verbatim repro: "j'ai
  // toujours des agents sur le titre du cluster projet donc illisible",
  // measured live at zoom 0.21 — a zone header title sliding under the
  // floating toolbar after any fitView (boot, fit button, "Rangement
  // auto"). This is the direct fix: once the toolbar is measurable, `top`
  // becomes a real px value that clears its bottom edge, replacing the
  // plain fraction (which carried no relationship to the toolbar's actual
  // size and so could leave a header exposed underneath it).
  describe('toolbarHeight (fix/canvas-header-toolbar-overlap)', () => {
    it('replaces the fractional top padding with a real px value once the toolbar is measurable', () => {
      expect(insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 40, fluxHeight: 0 }, 0.2)).toEqual({
        top: '52px', // 40 + DEFAULT_TOP_GUTTER_PX (12)
        bottom: 0.2, // bottom is untouched — nothing occludes it
        left: '24px',
        right: '24px',
      });
    });

    it('composes with the panel/rail horizontal insets unchanged', () => {
      expect(insetFitViewPadding({ panelWidth: 360, railWidth: 56, toolbarHeight: 40, fluxHeight: 0 }, 0.15)).toEqual({
        top: '52px',
        bottom: 0.15,
        left: '80px',
        right: '384px',
      });
    });

    it('rounds a fractional measured toolbar height to the nearest px', () => {
      expect(insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 39.6, fluxHeight: 0 }, 0.2).top).toBe('52px'); // round(39.6+12)=52
    });
  });

  // fix/canvas-toolbar-fit-floor — David's real-app repro: after "Ranger" +
  // "Fit view" (packaged build, manager collapsed), the first row of zone
  // plaques still landed under the toolbar even though `toolbarHeight`
  // should have reserved room — i.e. the real DOM measurement can silently
  // resolve smaller than the toolbar's true footprint at the moment a fit
  // runs. `minTopReservePx` is the defensive floor a toolbar-aware caller
  // can pass to guarantee a minimum regardless of what the measurement says.
  describe('minTopReservePx (fix/canvas-toolbar-fit-floor)', () => {
    it('is a no-op by default — every pre-existing call site (no 4th arg) keeps its exact prior behavior', () => {
      expect(insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.2)).toEqual({
        top: 0.2,
        bottom: 0.2,
        left: '24px',
        right: '24px',
      });
    });

    it('floors the top padding at the given px value even when the toolbar measured as completely unmeasurable (toolbarHeight: 0) — the exact real-app repro', () => {
      expect(insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.2, 24, 76)).toEqual({
        top: '76px',
        bottom: 0.2,
        left: '24px',
        right: '24px',
      });
    });

    it('floors the top padding even when the toolbar measured to a real but too-small value', () => {
      // measured top would be 40+12=52, below the 76px floor.
      expect(insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 40, fluxHeight: 0 }, 0.2, 24, 76).top).toBe('76px');
    });

    it('never shrinks a LARGER real measurement down to the floor — whichever is bigger wins', () => {
      // measured top = 100+12=112, above the 76px floor.
      expect(insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 100, fluxHeight: 0 }, 0.2, 24, 76).top).toBe('112px');
    });

    it('composes with the horizontal panel/rail insets unchanged', () => {
      expect(insetFitViewPadding({ panelWidth: 360, railWidth: 56, toolbarHeight: 0, fluxHeight: 0 }, 0.2, 24, 76)).toEqual({
        top: '76px',
        bottom: 0.2,
        left: '80px',
        right: '384px',
      });
    });

    it('usableCanvasRect (the underlying single source of truth) exposes the same floor parameter', () => {
      expect(usableCanvasRect({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.2, 24, 76).top).toBe('76px');
    });
  });

  // fix/canvas-toolbar-fit-floor round 2 (David's corrected real-app
  // measurement: `.canvas-zone-header` — the plaque's own box, not the name
  // span inside it — measured top=86 while the toolbar spanned y=79..121,
  // overlapping, even with CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX alone applied).
  // `fitView`'s bbox only knows about REACT FLOW NODES; the plaque floats
  // ABOVE the node box via CSS (`bottom: calc(100% + gap)`), outside that
  // bbox entirely, so a floor sized only against the toolbar still let the
  // plaque poke back up into it. CANVAS_FIT_TOP_RESERVE_PX is the combined
  // floor (toolbar + plaque) every real call site now uses.
  describe('CANVAS_FIT_TOP_RESERVE_PX (fix/canvas-toolbar-fit-floor round 2 — the zone-title plaque)', () => {
    it('is the toolbar floor plus the plaque\'s own screen footprint (band height + gap-above)', () => {
      expect(CANVAS_ZONE_PLAQUE_SCREEN_HEIGHT_PX).toBe(60); // 44 (band) + 16 (gap-above)
      expect(CANVAS_FIT_TOP_RESERVE_PX).toBe(CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX + CANVAS_ZONE_PLAQUE_SCREEN_HEIGHT_PX);
    });

    it('is meaningfully bigger than the toolbar-only floor — the whole point of round 2', () => {
      expect(CANVAS_FIT_TOP_RESERVE_PX).toBeGreaterThan(CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX);
    });

    it('applied via insetFitViewPadding, reserves enough top padding that a plaque floating ZONE_TITLE_GAP_ABOVE + band-height above the node box still clears the toolbar', () => {
      // Mirrors the real geometry: toolbar bottom sits `CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX`
      // below the container top (by construction, once the floor applies).
      // The node box top then lands at exactly that offset; the plaque
      // floats CANVAS_ZONE_PLAQUE_SCREEN_HEIGHT_PX further up from there —
      // landing exactly at the toolbar floor's own offset, i.e. AT or BELOW
      // where the toolbar reservation already guarantees clearance.
      const padding = insetFitViewPadding({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.2, 24, CANVAS_FIT_TOP_RESERVE_PX);
      expect(padding.top).toBe(`${CANVAS_FIT_TOP_RESERVE_PX}px`);
      const nodeBoxTopOffset = CANVAS_FIT_TOP_RESERVE_PX;
      const plaqueTopOffset = nodeBoxTopOffset - CANVAS_ZONE_PLAQUE_SCREEN_HEIGHT_PX;
      expect(plaqueTopOffset).toBeGreaterThanOrEqual(CANVAS_TOOLBAR_MIN_TOP_RESERVE_PX);
    });
  });
});

describe('measureDockedPanelInsets', () => {
  function stubWidth(el: Element, width: number): void {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ width, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }

  function stubRect(el: Element, rect: Partial<DOMRect>): void {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...rect }) as DOMRect;
  }

  it('returns {0,0,0} for a null anchor', () => {
    expect(measureDockedPanelInsets(null)).toEqual({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 });
  });

  it('returns {0,0,0} when neither overlay nor toolbar is mounted anywhere in the anchor\'s tree', () => {
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'cockpit-fullbleed-root');
    const canvas = document.createElement('div');
    root.appendChild(canvas);
    expect(measureDockedPanelInsets(canvas)).toEqual({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 });
  });

  // fix/canvas-overlay-occlusion — ManagerOverlay's width is no longer
  // measured here at all (panelWidth is always 0): CanvasView.tsx now
  // reserves that overlay's live width as real DOM space (reservedRightPx),
  // so nothing this function's callers render can structurally end up under
  // it any more — see measureDockedPanelInsets's own updated doc comment.
  // The left rail measurement is untouched (a deliberately separate,
  // out-of-scope concern — CockpitLeftRail still floats over the canvas).
  it('reads the real rendered width of the left rail as a sibling of the anchor, but never the manager overlay (open) — that space is reserved structurally now, not compensated for here', () => {
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'cockpit-fullbleed-root');
    const canvas = document.createElement('div');
    canvas.setAttribute('data-testid', 'canvas-view');
    const overlay = document.createElement('div');
    overlay.setAttribute('data-testid', 'manager-overlay');
    stubWidth(overlay, 360);
    const rail = document.createElement('div');
    rail.setAttribute('data-testid', 'cockpit-left-rail');
    stubWidth(rail, 56);
    root.append(canvas, overlay, rail);

    expect(measureDockedPanelInsets(canvas)).toEqual({ panelWidth: 0, railWidth: 56, toolbarHeight: 0, fluxHeight: 0 });
  });

  it('still reports panelWidth: 0 when the overlay is collapsed instead of open (same reservation, whichever state is mounted)', () => {
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'cockpit-fullbleed-root');
    const canvas = document.createElement('div');
    const collapsedTab = document.createElement('button');
    collapsedTab.setAttribute('data-testid', 'manager-overlay-expand');
    stubWidth(collapsedTab, 44);
    root.append(canvas, collapsedTab);

    expect(measureDockedPanelInsets(canvas)).toEqual({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 });
  });

  // fix/canvas-header-toolbar-overlap — David's verbatim repro: "j'ai
  // toujours des agents sur le titre du cluster projet donc illisible".
  describe('toolbarHeight (fix/canvas-header-toolbar-overlap)', () => {
    it("measures the toolbar's occlusion height relative to the canvas container's own top edge (not the toolbar's raw height alone)", () => {
      const root = document.createElement('div');
      root.setAttribute('data-testid', 'cockpit-fullbleed-root');
      const canvas = document.createElement('div');
      canvas.setAttribute('data-testid', 'canvas-view');
      // Container's own top sits at viewport y=40 (e.g. chrome above it).
      stubRect(canvas, { top: 40, bottom: 640 });
      const toolbar = document.createElement('div');
      toolbar.setAttribute('data-testid', 'canvas-toolbar');
      // Toolbar (Panel's own default margin below the container top) is
      // 38px tall, bottom edge at viewport y=93.
      stubRect(toolbar, { top: 55, bottom: 93, height: 38 });
      root.append(canvas, toolbar);

      // 93 (toolbar bottom, viewport-relative) - 40 (container top, viewport-relative) = 53
      expect(measureDockedPanelInsets(canvas)).toEqual({ panelWidth: 0, railWidth: 0, toolbarHeight: 53, fluxHeight: 0 });
    });

    it('degrades to 0 when the canvas-view container cannot be found in the anchor\'s tree (never worse than the pre-fix behavior)', () => {
      const root = document.createElement('div');
      root.setAttribute('data-testid', 'cockpit-fullbleed-root');
      const toolbar = document.createElement('div');
      toolbar.setAttribute('data-testid', 'canvas-toolbar');
      stubRect(toolbar, { top: 15, bottom: 53, height: 38 });
      root.append(toolbar);

      expect(measureDockedPanelInsets(toolbar)).toEqual({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 });
    });

    it('clamps a negative delta (toolbar somehow above the container top) to 0', () => {
      const root = document.createElement('div');
      root.setAttribute('data-testid', 'cockpit-fullbleed-root');
      const canvas = document.createElement('div');
      canvas.setAttribute('data-testid', 'canvas-view');
      stubRect(canvas, { top: 100, bottom: 700 });
      const toolbar = document.createElement('div');
      toolbar.setAttribute('data-testid', 'canvas-toolbar');
      stubRect(toolbar, { top: 10, bottom: 48, height: 38 }); // bottom (48) < container top (100)
      root.append(canvas, toolbar);

      expect(measureDockedPanelInsets(canvas).toolbarHeight).toBe(0);
    });
  });

  // fix/canvas-usable-rect — David's explicit ask: "minus the FLUX bar at
  // the bottom". Mirrors the toolbarHeight describe block above exactly
  // (same shape, same edges, same degenerate guards) — the bottom-occlusion
  // analog of the top one.
  describe('fluxHeight (fix/canvas-usable-rect)', () => {
    it("measures FluxFooter's own occlusion height relative to the canvas container's own bottom edge", () => {
      const root = document.createElement('div');
      root.setAttribute('data-testid', 'cockpit-fullbleed-root');
      const canvas = document.createElement('div');
      canvas.setAttribute('data-testid', 'canvas-view');
      stubRect(canvas, { top: 40, bottom: 700 });
      const flux = document.createElement('div');
      flux.setAttribute('data-testid', 'flux-footer');
      // FluxFooter's own top sits at viewport y=660, container bottom is 700.
      stubRect(flux, { top: 660, bottom: 700 });
      root.append(canvas, flux);

      // 700 (container bottom) - 660 (flux top) = 40
      expect(measureDockedPanelInsets(canvas)).toEqual({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 40 });
    });

    it('is 0 when FluxFooter has no real activity and renders nothing (absent from the DOM entirely — FluxFooter.tsx\'s own honest-empty convention)', () => {
      const root = document.createElement('div');
      root.setAttribute('data-testid', 'cockpit-fullbleed-root');
      const canvas = document.createElement('div');
      canvas.setAttribute('data-testid', 'canvas-view');
      stubRect(canvas, { top: 40, bottom: 700 });
      root.append(canvas);

      expect(measureDockedPanelInsets(canvas).fluxHeight).toBe(0);
    });

    it('composes with toolbarHeight — both occlusions measured independently, on opposite edges', () => {
      const root = document.createElement('div');
      root.setAttribute('data-testid', 'cockpit-fullbleed-root');
      const canvas = document.createElement('div');
      canvas.setAttribute('data-testid', 'canvas-view');
      stubRect(canvas, { top: 40, bottom: 700 });
      const toolbar = document.createElement('div');
      toolbar.setAttribute('data-testid', 'canvas-toolbar');
      stubRect(toolbar, { top: 55, bottom: 93 });
      const flux = document.createElement('div');
      flux.setAttribute('data-testid', 'flux-footer');
      stubRect(flux, { top: 660, bottom: 700 });
      root.append(canvas, toolbar, flux);

      expect(measureDockedPanelInsets(canvas)).toEqual({ panelWidth: 0, railWidth: 0, toolbarHeight: 53, fluxHeight: 40 });
    });
  });
});

// fix/canvas-usable-rect — David's explicit ask: "make it one usable canvas
// rect helper so every framing path shares it".
describe('usableCanvasRect', () => {
  it('returns exactly the same shape insetFitViewPadding already returned (a one-line alias, single source of truth)', () => {
    const insets = { panelWidth: 360, railWidth: 56, toolbarHeight: 40, fluxHeight: 30 };
    expect(usableCanvasRect(insets, 0.2)).toEqual(insetFitViewPadding(insets, 0.2));
  });

  it('folds fluxHeight into the bottom padding once measurable, falling back to the plain fraction otherwise', () => {
    expect(usableCanvasRect({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 0 }, 0.2).bottom).toBe(0.2);
    expect(usableCanvasRect({ panelWidth: 0, railWidth: 0, toolbarHeight: 0, fluxHeight: 40 }, 0.2).bottom).toBe('52px'); // 40 + 12
  });
});

// fix/canvas-usable-rect (David's forensics: "fit" clipped content off the
// LEFT edge — a minZoom floor forcing zoom higher than the padded content
// could satisfy, which getViewportForBounds's own asymmetric-padding
// correction cannot resolve on its own). computeSafeMinZoom is a pure
// function over an INJECTED getViewportForBounds-shaped function, so this
// suite proves the actual decision logic without needing a real
// ReactFlowInstance or DOM.
describe('computeSafeMinZoom (fix/canvas-usable-rect)', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 1000 };
  const container = { width: 800, height: 800 };
  const padding = { top: 0.2, bottom: 0.2, left: '24px', right: '24px' } as const;

  it('is a no-op (returns the requested floor unchanged) when the content naturally fits at or above that floor', () => {
    const fakeGetViewportForBounds = () => ({ zoom: 0.5 }); // natural zoom above the floor
    expect(computeSafeMinZoom(bounds, container, padding, 0.35, fakeGetViewportForBounds)).toBe(0.35);
  });

  it('backs off to the content\'s own natural (fully-visible) zoom when the requested floor would force it to zoom in past what actually fits — this is the exact regression fix', () => {
    const fakeGetViewportForBounds = () => ({ zoom: 0.2375 }); // matches the real repro's own measured natural zoom
    expect(computeSafeMinZoom(bounds, container, padding, 0.35, fakeGetViewportForBounds)).toBeCloseTo(0.2375, 6);
  });

  it('never returns a zoom the caller did not ask for as a ceiling — the result is always <= the requested floor', () => {
    for (const natural of [0.01, 0.1, 0.2375, 0.35, 0.5, 1, 2]) {
      const fakeGetViewportForBounds = () => ({ zoom: natural });
      const result = computeSafeMinZoom(bounds, container, padding, 0.35, fakeGetViewportForBounds);
      expect(result).toBeLessThanOrEqual(0.35);
    }
  });

  it('falls back to the requested floor for degenerate bounds/container (zero-size, mount race) rather than dividing by zero or calling the injected function', () => {
    const neverCall = () => {
      throw new Error('must not be called for degenerate input');
    };
    expect(computeSafeMinZoom({ x: 0, y: 0, width: 0, height: 0 }, container, padding, 0.35, neverCall)).toBe(0.35);
    expect(computeSafeMinZoom(bounds, { width: 0, height: 0 }, padding, 0.35, neverCall)).toBe(0.35);
  });

  it('end to end with the REAL @xyflow/react getViewportForBounds: a wide world (needs to zoom out past the floor to stay fully visible) no longer clips off the left edge', () => {
    // Mirrors the real repro's own numbers (left rail inset bigger than the
    // right's, a world bbox wide enough that the natural fit sits below
    // ARRANGE_MIN_READABLE_ZOOM) closely enough to prove the fix holds
    // against the REAL library function, not just an injected stub.
    const wideBounds = { x: 0, y: 0, width: 3200, height: 1096 };
    const realContainer = { width: 848, height: 780 };
    const realPadding: InsetFitViewPadding = { top: '52px', bottom: 0.2, left: '64px', right: '24px' };
    const safeMinZoom = computeSafeMinZoom(wideBounds, realContainer, realPadding, 0.35, getViewportForBounds);
    expect(safeMinZoom).toBeLessThan(0.35);
    const result = getViewportForBounds(wideBounds, realContainer.width, realContainer.height, safeMinZoom, 2, realPadding);
    // The content's own left edge (world x=0) must land at or past the
    // left padding — never negative (off-screen past the viewport's own
    // left edge, the exact "-96"/"-59" clip this fix closes).
    expect(0 * result.zoom + result.x).toBeGreaterThanOrEqual(0);
  });
});
