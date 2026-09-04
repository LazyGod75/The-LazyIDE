/**
 * Cockpit — full-bleed layout (38938e3 rebuild: "feat(cockpit): rebuild
 * page — full-bleed canvas, left round-icon rail + popovers, right
 * always-visible manager overlay"). Replaces this file's old assertions
 * against the pre-38938e3 "cockpit2" layout.
 *
 * "Poste d'analyse" (SWOT/dette/risques/audit) was already removed
 * entirely in a prior wave and stays gone. 38938e3 then replaced the old
 * "full-width Bandeau + full-width CAP objectifs band, THEN a two-column
 * agents-grid/manager-rail row" layout with: the canvas (CanvasView) fills
 * the ENTIRE page edge to edge (no top band, no 2-column split), while
 * everything else floats OVER it as absolutely-positioned overlays
 * anchored to the cockpit's own position:relative root
 * (data-testid="cockpit-fullbleed-root") — a far-left round-icon rail
 * (CockpitLeftRail) whose popovers carry the old Bandeau/CapObjectives/
 * KpiGroup/decisions content verbatim (nothing dropped, just relocated),
 * and an always-visible right manager overlay (ManagerOverlay). This file
 * proves the relocation and the presence of every remaining real section,
 * plus the NEW stacking invariants (explicit position:absolute + z-index
 * on the overlays) that replace the old DOM-order-based ones — not pixel
 * geometry (covered by the screenshot harness instead).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { Cockpit } from '../components/agents/cockpit/Cockpit';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import type { UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';
import { emit } from '../lib/bus';

// fix/canvas-collapse-reservation (David's round-8 report: collapsing the
// manager overlay left the canvas container exactly as narrow as before —
// `reservedRightPx` never actually shrank, so "fit" stayed cramped until a
// second, separate click). Two jsdom gaps this suite's own real-integration
// test needs, neither of which `canvasTestEnv.ts`'s shared shim provides:
//   1. `canvas-view`'s own `getBoundingClientRect` must actually REFLECT
//      whatever `marginRight` CanvasView.tsx currently has it styled with —
//      the shared shim returns one fixed rect for every element regardless
//      of style, which can never observe a real reservedRightPx change.
//   2. A CONTROLLABLE `ResizeObserver` — jsdom has no real layout engine, so
//      nothing ever fires a REAL resize callback; `installReactFlowTestEnv`'s
//      own stub is a true no-op (observe/unobserve/disconnect all empty),
//      which is exactly right for every OTHER suite (no accidental refits)
//      but cannot exercise CanvasToolbar.tsx's new auto-refit-on-resize
//      effect at all. This one is installed BEFORE `installReactFlowTestEnv()`
//      below so that shim's own `if (typeof ResizeObserver === 'undefined')`
//      guard leaves it in place instead of overwriting it with the no-op.
const FALLBACK_PANE_WIDTH = 1200;
const FALLBACK_PANE_HEIGHT = 800;
// fix/canvas-toolbar-oscillation — CanvasToolbar.tsx now registers TWO
// independent ResizeObservers on the SAME canvas-view element (the
// pre-existing round-8 runFit one, plus this fix's own toolbarMaxWidthPx
// one) — a Map<Element, single callback> silently drops the FIRST
// registration the moment the second one calls `.observe()` on the same
// target, so `triggerResizeObserved` would only ever reach whichever
// observer happened to register last. `Map<Element, Set<callback>>`
// supports any number of independent observers per target, matching a
// real browser's own ResizeObserver semantics.
//
// fix/canvas-collapse-reservation round 3 (this suite's own flake hunt,
// 2026-08-15) — the ADD half of that fix landed, but `unobserve`/
// `disconnect` never got the matching per-instance treatment: both called
// `resizeObservers.delete(target)` outright, wiping the WHOLE shared Set for
// that target — every OTHER observer's own registration on the same
// element, not just this instance's. A real `ResizeObserver.disconnect()`
// only ever un-registers ITS OWN observations, never another instance's.
// This stayed latent as long as only one observer at a time ever actually
// happened to disconnect/reconnect on `canvas-view` mid-test; CanvasView.tsx
// gained a SECOND independent one today (`dynamicMinZoom`'s own
// ResizeObserver, recomputed whenever `decoratedNodes` changes identity) —
// the moment ITS effect re-runs (any nodes-identity change) and its cleanup
// calls `disconnect()`, CanvasToolbar's own `runFit` registration on the
// SAME target was silently erased too, permanently (CanvasToolbar's own
// effect has no reason to re-run and re-`observe()` afterward) — exactly
// why every `triggerResizeObserved` call AFTER that point stopped reaching
// `runFit` at all, while the toolbar's own "Fit view" button (a direct
// call, not routed through this observer) kept working. Each instance now
// tracks its OWN wrapped callback per target (`#entries`) and only ever
// removes that — the SAME add/remove symmetry a real browser's
// `ResizeObserver` guarantees, and what lets any number of independent
// observers share one target without clobbering each other's lifecycle.
const resizeObservers = new Map<Element, Set<() => void>>();

class ControllableResizeObserver {
  #callback: ResizeObserverCallback;
  #entries = new Map<Element, () => void>();
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element): void {
    if (this.#entries.has(target)) return; // already observing — matches real ResizeObserver's own idempotent re-observe
    const wrapped = () => this.#callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
    this.#entries.set(target, wrapped);
    let set = resizeObservers.get(target);
    if (!set) {
      set = new Set();
      resizeObservers.set(target, set);
    }
    set.add(wrapped);
  }
  unobserve(target: Element): void {
    const wrapped = this.#entries.get(target);
    if (!wrapped) return;
    this.#entries.delete(target);
    const set = resizeObservers.get(target);
    if (!set) return;
    set.delete(wrapped);
    if (set.size === 0) resizeObservers.delete(target);
  }
  disconnect(): void {
    for (const target of this.#entries.keys()) this.unobserve(target);
  }
}
globalThis.ResizeObserver = ControllableResizeObserver as unknown as typeof ResizeObserver;

/** Simulates the browser actually detecting a resize on `target` — invokes
 *  EVERY callback any `ResizeObserver.observe(target)` call registered for
 *  it, exactly the "browser notices canvas-view's box changed" step
 *  nothing in jsdom does automatically. */
function triggerResizeObserved(target: Element): void {
  for (const callback of resizeObservers.get(target) ?? []) callback();
}

// `installReactFlowTestEnv()` itself unconditionally REASSIGNS
// `HTMLElement.prototype.getBoundingClientRect` (no "already overridden"
// check) — so the width-reflecting override below must run AFTER it, or
// the shared shim's own fixed-rect-for-everything version wins instead.
installReactFlowTestEnv();

// cameraInsets.ts's `measureDockedPanelInsets` measures the REAL rail's
// `getBoundingClientRect().width` to compute how much left padding "fit"
// must reserve — under the shared shim's own "one fixed rect for every
// element" fallback (FALLBACK_PANE_WIDTH, 1200), the rail would measure as
// 1200px wide too, producing a left padding so large it swallows nearly the
// entire container and pins the computed zoom to ARRANGE_MIN_READABLE_ZOOM
// regardless of canvas-view's own width — exactly masking the difference
// this suite exists to prove. A realistic, small width (matching
// CockpitLeftRail.tsx's own real `COCKPIT_LEFT_RAIL_WIDTH_PX`) keeps that
// inset honest.
const REALISTIC_RAIL_WIDTH = 40;

const sharedShimGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement): DOMRect {
  if (this.dataset.testid === 'canvas-view') {
    // Real box-model behavior: marginRight shrinks this element's own
    // rendered width inside its (assumed full-window) flex parent — the
    // SAME relationship a real browser produces, so this reflects whatever
    // reservedRightPx CanvasView.tsx is CURRENTLY styled with, live.
    const marginRight = Number.parseFloat(this.style.marginRight || '0') || 0;
    const width = Math.max(0, FALLBACK_PANE_WIDTH - marginRight);
    return {
      width,
      height: FALLBACK_PANE_HEIGHT,
      top: 0,
      left: 0,
      right: width,
      bottom: FALLBACK_PANE_HEIGHT,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }
  if (this.dataset.testid === 'cockpit-left-rail') {
    return {
      width: REALISTIC_RAIL_WIDTH,
      height: FALLBACK_PANE_HEIGHT,
      top: 0,
      left: 0,
      right: REALISTIC_RAIL_WIDTH,
      bottom: FALLBACK_PANE_HEIGHT,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }
  return sharedShimGetBoundingClientRect.call(this);
};

// ── fix/canvas-ux R9 BLOQUANT #1b fixture — a non-empty fleet so CanvasView
//    mounts its REAL `data-testid="canvas-view"` wrapper (mirrors
//    CanvasView.test.tsx's own FIXTURE_PROJECTS) instead of the empty-state
//    hero the EMPTY_FLEET tests above exercise. ───────────────────────────
const POPULATED_FLEET: UseFleetMissionsResult = {
  projects: [
    {
      projectId: 'demo-shop',
      root: '/fixtures/demo-shop',
      name: 'demo-shop',
      missions: [
        { id: 'm-1', title: 'Fix checkout bug', status: 'running', stage: 'code', model: 'sonnet', liveAction: 'Bash: npm test', progress: 42, updatedMs: Date.now(), urgent: false },
      ],
    },
  ],
  loading: false,
  error: null,
};

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));
// Partial mock (importOriginal) rather than a hand-maintained stub list —
// MissionNode.tsx now also pulls classifyMissionModel from this module (see
// its own "rail-aware cost chip" comment), and a hand-copied export list
// breaks again every time runtime.ts grows a new real export a rendered
// component starts using.
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../lib/agents/loopEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/loopEngine')>();
  return { ...actual, listLoops: vi.fn().mockResolvedValue([]) };
});

const EMPTY_FLEET: UseFleetMissionsResult = { projects: [], loading: false, error: null };

function renderCockpit(fleetOverride: UseFleetMissionsResult = EMPTY_FLEET, onOpenReport: () => void = () => {}) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            {/* Cockpit's ManagerOverlay registers into managerHostRegistry
                instead of instantiating <LazyManager> directly — see
                managerHostRegistry.tsx. Reproduced here (normally provided
                once by AppShell.tsx) so the real Cockpit tree still gets a
                rendered LazyManager (this file asserts on manager-input). */}
            <ManagerHostRegistryProvider>
              <Cockpit onOpenLibrary={() => {}} onOpenReport={onOpenReport} fleetOverride={fleetOverride} objectivesOverride={[]} managerMessagesOverride={[]} />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('Cockpit — layout (cockpit2)', () => {
  it('no longer renders "Poste d\'analyse" (AnalysisDesk removed entirely)', () => {
    renderCockpit();
    expect(screen.queryByTestId('analysis-run')).toBeNull();
    expect(screen.queryByTestId('analysis-preset-swot')).toBeNull();
    expect(screen.queryByText("POSTE D'ANALYSE")).toBeNull();
  });

  it('renders the full-bleed canvas and the always-visible manager overlay by default; CAP objectifs is no longer a permanent band but is still reachable, unchanged, via the rail\'s "objectives" popover (38938e3: nothing dropped, just relocated)', () => {
    renderCockpit();
    // Agent canvas — fills the whole page by default. EMPTY_FLEET has no
    // open projects, so CanvasView renders its empty-state hero rather than
    // the React Flow toolbar (see CanvasView.test.tsx for the populated case).
    expect(screen.getByTestId('canvas-empty-state')).toBeInTheDocument();
    // LazyManager overlay — always visible, no click required.
    expect(screen.getByTestId('manager-input')).toBeInTheDocument();
    // CAP objectifs is NOT a permanent full-width band anymore — it only
    // exists inside the left rail's "objectives" popover now.
    expect(screen.queryByTestId('cap-add-toggle')).toBeNull();

    fireEvent.click(screen.getByTestId('cockpit-rail-icon-objectives'));
    expect(screen.getByTestId('cap-add-toggle')).toBeInTheDocument();
  });

  it('CockpitLeftRail and ManagerOverlay float as position:absolute overlays (explicit z-index) anchored directly to the cockpit-fullbleed-root — replaces the old "manager rail starts at the grid/pipeline-header level, not the page top" DOM-order check, which assumed a top band that no longer exists (the manager overlay is now deliberately pinned near the page top from the start)', () => {
    renderCockpit();
    const root = screen.getByTestId('cockpit-fullbleed-root');
    expect(root.style.position).toBe('relative');

    const rail = screen.getByTestId('cockpit-left-rail');
    expect(rail.parentElement).toBe(root);
    expect(rail.style.position).toBe('absolute');
    expect(Number(rail.style.zIndex)).toBeGreaterThan(0);

    const overlay = screen.getByTestId('manager-overlay');
    expect(overlay.parentElement).toBe(root);
    expect(overlay.style.position).toBe('absolute');
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(0);
  });
});

// ── fix/canvas-ux R9 BLOQUANT #1b — "header click interception" root cause.
//
// R8's e2e capture showed a draft node's ▶ Lancer button, once on-screen,
// intercepted by a click landing on the CAP objectifs band's empty-state
// div instead. Live geometry probing (getBoundingClientRect against the
// real running app — see _e2e-geometry-probe.mjs / the R9 report) proved
// this was NEVER a CSS containment bug: canvas-view's real box (y≈318)
// sits cleanly BELOW CapObjectives' real box (ends y≈302) at rest — the
// two never overlap. The actual chain was (a) 'canvas:focus' racing ahead
// of 'canvas:arrange's async elk layout (fixed in
// useCanvasManagerEvents.ts — see its own test file) left the camera
// aimed at a STALE position; that bad viewport then persists across app
// restarts (canvasPersistence.ts's onMoveEnd), so a node can end up
// genuinely positioned ABOVE canvas-view's own `overflow:hidden` clip top
// — invisible (clipped) but still geometrically present there — so
// clicking its own (unclipped) reported rect naturally hits whatever IS
// actually painted at that point instead: CapObjectives, which legitimately
// occupies that screen region. And (b) the one manual recovery an operator
// had — the command bar's "Recentrer"/Ctrl+0 entry — had a STALE hint
// (fixed in CanvasCommandBar.tsx): Ctrl+0 was repurposed by R1b to "reset
// zoom to 100%" (no pan change at all), while the real fitView recenter
// moved to Ctrl+1 — so pressing what the UI told you was "recenter" never
// actually panned back to content.
//
// This suite proves the STRUCTURAL invariants that guarantee canvas-view's
// box can never overlap CapObjectives' box regardless of either one's
// content (jsdom has no real layout engine — see CanvasView.test.tsx's own
// "container sizing" describe block's identical caveat — so this is a
// style/DOM-order proof, not a pixel one; the live pixel proof is the
// geometry probe + e2e re-run cited above).
describe('CanvasView — canvas pane never overlaps the floating overlays (38938e3 full-bleed rebuild; formerly "never overlaps the CAP objectifs band", fix/canvas-ux R9 BLOQUANT #1b)', () => {
  it('canvas-view carries no elevated stacking (position:relative, no explicit z-index) while every floating overlay (rail, manager overlay) declares position:absolute + a positive z-index — canvas can never paint over them regardless of DOM order (replaces the old DOM-order proxy, which assumed flow-based stacking that no longer applies now that the overlays are absolutely positioned)', async () => {
    renderCockpit(POPULATED_FLEET);
    const canvas = await screen.findByTestId('canvas-view');
    expect(canvas.style.position).toBe('relative');
    expect(canvas.style.zIndex).toBe('');

    const rail = screen.getByTestId('cockpit-left-rail');
    const overlay = screen.getByTestId('manager-overlay');
    expect(rail.style.position).toBe('absolute');
    expect(overlay.style.position).toBe('absolute');
    expect(Number(rail.style.zIndex)).toBeGreaterThan(0);
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(0);
  });

  it('CapObjectives (same unchanged component, now reached via the rail\'s "objectives" popover) still never shrinks below its own content height (flexShrink:0), so it always reserves real space instead of collapsing', async () => {
    renderCockpit(POPULATED_FLEET);
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-objectives'));
    const toggle = await screen.findByTestId('cap-add-toggle');
    // toggle -> title row div -> CapObjectives root (see CapObjectives.tsx's
    // own JSX: the button is a direct child of the title row, itself a
    // direct child of the component's root div) — unchanged by 38938e3.
    const capRoot = toggle.parentElement?.parentElement as HTMLElement;
    expect(capRoot.style.flexShrink).toBe('0');
  });

  it('canvas-view mounts as a DIRECT child of cockpit-fullbleed-root (zero intermediate wrapper divs), so nothing can silently insert a fixed/absolute ancestor between them (replaces the old N-levels-up normal-flow walk, which assumed a multi-level two-column wrapper chain that no longer exists — there are now zero levels to walk)', async () => {
    renderCockpit(POPULATED_FLEET);
    const canvas = await screen.findByTestId('canvas-view');
    const root = screen.getByTestId('cockpit-fullbleed-root');
    expect(canvas.parentElement).toBe(root);
    expect(root.style.position).toBe('relative');
  });

  // fix/canvas-overlay-occlusion (David's measured repro: the canvas
  // toolbar AND a mission card's own action row both extended under the
  // docked ManagerOverlay — several toolbar controls unreachable, a review
  // card's reject button clipped) — canvas-view now reserves the overlay's
  // OWN real current width as real DOM space (marginRight), the SAME "P2a"
  // live-tracking pattern this file's own FluxFooter reservation already
  // used (Cockpit.tsx's `manager:overlayWidthChange` listener) — proves the
  // wiring end to end: a real mounted ManagerOverlay emits its own width,
  // Cockpit.tsx forwards it, canvas-view's own DOM node reserves it.
  it('canvas-view reserves the live ManagerOverlay width as marginRight (the SAME manager:overlayWidthChange bus event FluxFooter\'s own reservation already tracks — P2a), stays a DIRECT child with position:relative unchanged, and updates live on every subsequent width change (resize-drag, expand/collapse)', async () => {
    renderCockpit(POPULATED_FLEET);
    const canvas = await screen.findByTestId('canvas-view');
    // Real layout reservation, not a new stacking/positioning mechanism —
    // the pre-existing occlusion-avoidance invariants above still hold.
    expect(canvas.parentElement).toBe(screen.getByTestId('cockpit-fullbleed-root'));
    expect(canvas.style.position).toBe('relative');
    expect(canvas.style.zIndex).toBe('');

    // Every width this overlay can report (normal/expanded/collapsed/
    // drag-resized) is forwarded verbatim, live — proves the wiring bus
    // event -> Cockpit.tsx state -> CanvasView's reservedRightPx prop -> DOM
    // marginRight, for more than just whatever value happened to be current
    // at mount.
    for (const width of [360, 44, 720, 300]) {
      act(() => {
        emit('manager:overlayWidthChange', { width });
      });
      await waitFor(() => {
        expect(canvas.style.marginRight).toBe(`${width + 16}px`); // + OVERLAY_RIGHT_OFFSET
      });
    }
  });

  // fix/canvas-legibility — defensive regression: the empty-state CAP
  // banner must never intercept a pointer event meant for the canvas
  // underneath, regardless of the geometry mechanism above staying correct.
  // Same unchanged component/assertion as before 38938e3 — only the entry
  // point moved (now behind the rail's "objectives" popover).
  it('the empty-state CAP banner (now inside the objectives popover) carries pointerEvents: none (defensive, in addition to the stacking proofs above)', async () => {
    renderCockpit(POPULATED_FLEET);
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-objectives'));
    const banner = await screen.findByTestId('cap-empty-banner');
    expect(banner.style.pointerEvents).toBe('none');
  });
});

// ── W-CHROME — product feedback: "Rapport" becomes a round rail icon above
// 'kpis' (replacing AgentsSpace.tsx's old standalone header row below
// TopNav — see AgentsSpace.tsx/CockpitLeftRail.tsx's own header comments for
// that relocation); the 'kpis' popover drops LiveFeed (live activity) down
// to KPI tiles only; the rail's icon-name tooltips no longer get clipped.
describe('CockpitLeftRail — "Rapport" round icon (W-CHROME)', () => {
  it('renders the report icon ABOVE the kpis icon, both direct children of the rail root', () => {
    renderCockpit();
    const rail = screen.getByTestId('cockpit-left-rail');
    const report = screen.getByTestId('cockpit-rail-icon-report');
    const kpis = screen.getByTestId('cockpit-rail-icon-kpis');
    expect(report.parentElement).toBe(rail);
    expect(kpis.parentElement).toBe(rail);
    const children = Array.from(rail.children);
    expect(children.indexOf(report)).toBeLessThan(children.indexOf(kpis));
  });

  it('clicking it calls onOpenReport (same destination the old header-row button drove) without opening any rail popover', () => {
    const onOpenReport = vi.fn();
    renderCockpit(EMPTY_FLEET, onOpenReport);

    fireEvent.click(screen.getByTestId('cockpit-rail-icon-report'));

    expect(onOpenReport).toHaveBeenCalledTimes(1);
    // Pure navigation, not a popover trigger — no dialog attribute, no
    // cockpit-rail-popover-* mounted as a side effect of this click.
    expect(screen.getByTestId('cockpit-rail-icon-report')).not.toHaveAttribute('aria-haspopup');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the kpis popover renders the real KPI tiles and NOT the live-activity feed (product feedback: "just the KPIs, not the live activity")', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-kpis'));

    expect(screen.getByTestId('kpi-decisions')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-agents')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-merged')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-brain')).toBeInTheDocument();
    // LiveFeed.tsx has no testid of its own; its unique heading text is the
    // real, honest signal that it's gone from this popover (component
    // itself is untouched/still importable — see CockpitLeftRail.tsx's
    // header comment — just no longer mounted here).
    expect(screen.queryByText('Live Feed')).toBeNull();
  });

  it('the rail root never sets a non-visible overflow (regression: overflow-y auto used to silently force overflow-x to auto too, clipping every icon\'s [data-tooltip] name bubble on both left and right — see CockpitLeftRail.tsx\'s inline comment)', () => {
    renderCockpit();
    const rail = screen.getByTestId('cockpit-left-rail');
    expect(rail.style.overflow).toBe('');
    expect(rail.style.overflowX).toBe('');
    expect(rail.style.overflowY).toBe('');
  });
});

// fix/canvas-collapse-reservation — David's own instruction, verbatim:
// "Test it as a state transition on one mounted tree: expanded -> collapsed
// -> the container's reserved width shrinks -> fit yields a materially
// higher zoom." This is the real end-to-end chain, not a fixture at one
// width: the REAL Cockpit tree (ManagerOverlay's own collapse control ->
// its real `manager:overlayWidthChange` emit -> Cockpit.tsx's own listener
// -> CanvasView's real `marginRight` style -> CanvasToolbar's own
// ResizeObserver-driven auto-refit), on ONE mounted instance, no remount.
//
// Exactly 2 zones — a single shelf row under the CURRENT packer
// (`geometry.ts`'s `packColumnsForZoneCount`, viewport-aspect-aware:
// `packColumnsForZoneCount(2) = round(sqrt(2*1.7)) = 2` columns, so both
// zones land in row 0), so the whole-canvas bounding box stays
// WIDTH-dominant (one row's height, both zones' combined width) rather than
// growing tall across multiple wrapped rows. A wider fixture (more zones,
// more rows) was tried first and produced a Y-AXIS-bound natural zoom that
// landed at the SAME ARRANGE_MIN_READABLE_ZOOM floor regardless of
// container WIDTH — masking the very difference this test exists to prove,
// since collapsing the manager overlay only ever changes the container's
// WIDTH, never its height. A single row keeps width the binding constraint,
// so a wider container reliably yields a materially higher natural zoom.
//
// fix/canvas-toolbar-fit-floor round 2 — this fixture originally used 3
// zones (`AUTO_PACK_MAX_PER_ROW`, a hardcoded 3-per-row constant that no
// longer exists — superseded by `packColumnsForZoneCount`, e8a8e16). For 3
// zones that packer now yields `packColumnsForZoneCount(3) = round(sqrt(3*
// 1.7)) = 2` columns, i.e. TWO rows (2 + 1) — already a taller, less
// width-dominant box than this test intends, and CANVAS_FIT_TOP_RESERVE_PX's
// growth (the toolbar-floor's own round 2, reserving room for the floating
// zone-title plaque too, not just the toolbar) was enough extra height
// pressure to flip this specific fixture into the exact Y-axis-bound trap
// the comment above already warns about. 2 zones is the smallest count that
// still exercises "collapsing widens the container" at all, and is
// guaranteed single-row by the packer's own formula for any viewport aspect
// >= 1 (never a coincidence of the current 1.7 default).
const WIDE_FLEET_ZONE_COUNT = 2;
const WIDE_FLEET: UseFleetMissionsResult = {
  projects: Array.from({ length: WIDE_FLEET_ZONE_COUNT }, (_, i) => ({
    projectId: `p-${i}`,
    root: `/fixtures/p-${i}`,
    name: `p-${i}`,
    missions: [],
  })),
  loading: false,
  error: null,
};

function readZoomPct(): number {
  const text = screen.getByTestId('canvas-toolbar-zoom-pct').textContent ?? '';
  return Number(text.replace('%', ''));
}

describe('Cockpit — canvas auto-refit when the manager overlay collapses (fix/canvas-collapse-reservation)', () => {
  it('collapsing the SAME mounted overlay shrinks canvas-view\'s real width and the toolbar auto-refits to a materially higher zoom, with no second click', async () => {
    renderCockpit(WIDE_FLEET);
    const canvas = await screen.findByTestId('canvas-view');

    // "Warm-up" resize observation(s) — a real ResizeObserver.observe()
    // fires its callback once immediately with the CURRENT size;
    // CanvasToolbar.tsx deliberately skips that first call after ANY
    // (re)connect (never an unsolicited refit right when the observer is
    // freshly attached, see its own `isFirstResizeRef` comment) — this
    // mock's `observe()` does not auto-fire, so this stands in for that
    // "not a real change yet" call. Fired a few times, spaced across
    // `act()` flushes, since a `runFit` identity change (a fresh
    // `useReactFlow()` snapshot) tears down and reconnects the observer,
    // re-arming the "skip the next one" guard — this only needs to
    // over-cover that, never under-cover it.
    for (let i = 0; i < 3; i += 1) {
      act(() => triggerResizeObserved(canvas));
    }

    fireEvent.click(screen.getByTestId('canvas-toolbar-fit'));
    await waitFor(() => expect(readZoomPct()).toBeGreaterThan(0));
    const expandedZoom = readZoomPct();
    const expandedMarginRight = canvas.style.marginRight;

    // The real collapse control — same handler `handleCollapse` the M
    // keyboard shortcut also runs, no shortcut/synthetic bus event.
    fireEvent.click(screen.getByTestId('manager-overlay-collapse-trigger'));

    await waitFor(() => {
      expect(canvas.style.marginRight).not.toBe(expandedMarginRight);
    });

    // The browser detecting canvas-view's own box actually changed size —
    // the ONE step jsdom cannot do on its own (no real layout engine). Same
    // "trigger a few times across act() flushes" robustness as the warm-up
    // above — the assertion below is what actually proves the auto-refit,
    // not how many trigger calls it took to land.
    for (let i = 0; i < 3; i += 1) {
      act(() => triggerResizeObserved(canvas));
    }

    await waitFor(() => {
      expect(readZoomPct()).toBeGreaterThan(expandedZoom);
    });
  });
});

// fix/canvas-collapse-reservation round 2 (David's round-9 report, real
// packaged app containing 527d3ac — verified branch tip, binary built
// after it — a FRESH LAUNCH, not a transition on an already-mounted tree):
//
//   localStorage: lazy.manager.overlayWidth = "collapsed"
//                 lazy.manager.overlayWidth.custom = "836"
//                 lazy.manager.overlayWidth.lastOpen = "normal"
//   DOM: manager-overlay absent, manager-overlay-expand present (IS collapsed)
//   .react-flow / canvas-view: 504 x 780 in a 1440px window
//   zoom after fit: 15%
//
// "1440 - 836 (the custom width) - ~80 (rail) ~= 524" — the canvas
// container was still being reserved against the STALE custom width, even
// though the persisted state says collapsed, on the very FIRST paint. His
// own diagnosis: "the cockpit must be deriving its initial reservedRightPx
// from somewhere else ... Make both paths use one function that resolves
// the effective width from (state, custom, expanded) so they cannot
// disagree — and have the overlay emit its effective width once on mount."
// His own instruction on HOW to test it: "seed localStorage with exactly
// the three values above, mount the real Cockpit tree, and assert the
// canvas container's reserved width is the collapsed one. Your round-8
// test drove a transition on an already-mounted tree, which is why this
// survived" — this describe block is that exact MOUNT case, not a
// transition on an already-mounted one.
describe('Cockpit — initial mount reservation matches a persisted COLLAPSED state, not a stale custom width (fix/canvas-collapse-reservation round 2)', () => {
  it('seeding localStorage with collapsed + a stale custom width BEFORE the first render reserves the COLLAPSED width from the very first paint — no transition, no prior interaction on this mounted instance', async () => {
    localStorage.setItem('lazy.manager.overlayWidth', 'collapsed');
    localStorage.setItem('lazy.manager.overlayWidth.custom', '836');
    localStorage.setItem('lazy.manager.overlayWidth.lastOpen', 'normal');

    renderCockpit(WIDE_FLEET);

    // Confirms the SAME real signal David verified live: the overlay
    // itself renders collapsed (its own tab, not the full panel).
    expect(await screen.findByTestId('manager-overlay-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-overlay')).toBeNull();

    // The actual bug: canvas-view's OWN reserved width on this very first
    // render — never mind what the overlay itself renders, this is what
    // the canvas was ACTUALLY given to work with. COLLAPSED_WIDTH (44) +
    // OVERLAY_RIGHT_OFFSET (16) = 60, matching the SAME "+16" the live bus
    // listener already applies (Cockpit.tsx's own `manager:overlayWidthChange`
    // handler) — never 836 (the stale custom width) nor
    // MANAGER_OVERLAY_MAX_RESERVED_WIDTH's own old default (952).
    const canvas = await screen.findByTestId('canvas-view');
    expect(canvas.style.marginRight).toBe('60px');
  });
});
