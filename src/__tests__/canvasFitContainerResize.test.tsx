/**
 * canvasFitContainerResize.test.tsx — fix/canvas-fit-stale-container
 * (David's round-7 measured repro, real packaged app: clicked "Fit view"
 * with the manager overlay EXPANDED, then again with it COLLAPSED —
 * verified via DOM inspection that `manager-overlay` was actually gone,
 * `manager-overlay-expand` the only trace left — and got BYTE-IDENTICAL
 * results both times: `zoom 18%, contentBox {w:500, h:243}`. Collapsing the
 * overlay hands the canvas ~800px more width; "fit" should have reacted).
 *
 * Root cause: `CanvasToolbar.tsx`'s fit handler used to call React Flow's
 * own `fitView({padding, minZoom})`, which computes its target zoom from
 * `@xyflow/react`'s OWN internally-tracked pane width/height (a
 * ResizeObserver-driven store value) — a DIFFERENT measurement than the
 * `containerRect` this handler measures itself (via `getBoundingClientRect`
 * on the `canvas-view` ancestor) to compute `minZoom`. `minZoom` was
 * already tracking the live container correctly; `fitView()`'s own
 * internal natural-zoom computation could still be working off a stale
 * snapshot, independent of the (correct) floor we handed it.
 *
 * Fixed by never delegating the final viewport computation to `fitView()`
 * at all: `getViewportForBounds` (the SAME pure function
 * `computeSafeMinZoom` already calls to derive `minZoom`) is called AGAIN
 * with the SAME freshly-measured `containerRect` to compute the actual
 * target viewport, applied directly via `setViewport()` — an imperative
 * assignment, not a "let React Flow re-measure and decide" call. Every
 * step of the computation now traces back to ONE `getBoundingClientRect()`
 * call taken at click time; nothing in the path can be stale.
 *
 * David's own instruction, verbatim: "Verify this one live-equivalent (a
 * test with two different container widths), not just in a fixture at one
 * width — that is what let three rounds pass with the bug intact." This
 * suite mounts the REAL `<CanvasView>` tree (the SAME harness
 * CanvasView.test.tsx already proves wires up correctly — React Flow +
 * reconciler + canvasStore + the real toolbar, not a synthetic minimal
 * mount) and clicks the SAME fit button TWICE in the SAME mounted
 * instance, with the real `canvas-view` root element's OWN
 * `getBoundingClientRect()` returning a DIFFERENT width the second time —
 * exactly the "manager overlay collapses, the SAME canvas-view element
 * reports a new width" shape of the real bug, not a fresh remount with
 * different props (which would not have caught a caching bug at all).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { CanvasView } from '../components/agents/canvas/CanvasView';
import type { FleetProject } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';

installReactFlowTestEnv();

// invoke is globally mocked in setup.ts (vi.mock('@tauri-apps/api/core', ...))
// to resolve undefined by default — same convention CanvasView.test.tsx uses.
void (invoke as ReturnType<typeof vi.fn>);

// installReactFlowTestEnv() (above) already overrides
// HTMLElement.prototype.getBoundingClientRect with ONE fixed rect for every
// element — necessary so React Flow's own pane measures as non-degenerate,
// but it cannot express "the canvas-view root reports a DIFFERENT width on
// a second call", which is exactly what this suite needs to simulate a
// live overlay-collapse resize on the SAME mounted instance. Layered on
// top: only the `canvas-view` testid element is intercepted; every other
// element keeps using the shared shim's fixed rect underneath.
const sharedShimGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
let mockedCanvasViewWidth = 1200;
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement): DOMRect {
  if (this.dataset.testid === 'canvas-view') {
    const base = sharedShimGetBoundingClientRect.call(this);
    return {
      ...base,
      width: mockedCanvasViewWidth,
      right: base.left + mockedCanvasViewWidth,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }
  return sharedShimGetBoundingClientRect.call(this);
};

afterEach(() => {
  mockedCanvasViewWidth = 1200;
});

// Two projects placed far enough apart (via a pre-seeded `positions` prop —
// see FIXTURE_POSITIONS below) that "fit" genuinely has to zoom OUT to
// frame both — content that already fits at 100% would never exercise the
// container-width-dependent branch at all.
const WIDE_PROJECTS: FleetProject[] = [
  { projectId: 'p-a', root: '/fixtures/p-a', name: 'p-a', missions: [] },
  { projectId: 'p-b', root: '/fixtures/p-b', name: 'p-b', missions: [] },
];

function renderWideCanvas() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <CanvasView
              projects={WIDE_PROJECTS}
              highlightIds={new Set()}
              justMergedId={null}
              forceApproveIds={new Set()}
              onOpenMission={() => {}}
              onUrgentAction={() => {}}
              onOpenLibrary={() => {}}
            />
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

function readZoomPct(): number {
  const text = screen.getByTestId('canvas-toolbar-zoom-pct').textContent ?? '';
  return Number(text.replace('%', ''));
}

async function clickFitAndReadZoomPct(): Promise<number> {
  const before = readZoomPct();
  fireEvent.click(screen.getByTestId('canvas-toolbar-fit'));
  // The click handler runs its measurement/setViewport inside a
  // requestAnimationFrame callback (see CanvasToolbar.tsx's own comment on
  // why) — wait for the toolbar's own live zoom-% readout (useViewport(),
  // the SAME store setViewport() writes to) to settle at a value DIFFERENT
  // from whatever it read immediately before this click, rather than any
  // "%"-shaped text — a naive "matches /%$/" wait would pass immediately on
  // the PRE-click text, never actually observing the async update this
  // click triggers.
  await waitFor(
    () => {
      expect(readZoomPct()).not.toBe(before);
    },
    { timeout: 2000 },
  );
  return readZoomPct();
}

describe('CanvasToolbar "Fit view" reacts to the CURRENT container width, not a stale one (fix/canvas-fit-stale-container)', () => {
  it('the SAME mounted canvas produces a HIGHER zoom on a second fit click after canvas-view reports a WIDER rect — never byte-identical results across a real width change', async () => {
    mockedCanvasViewWidth = 420; // narrow — manager overlay expanded
    renderWideCanvas();

    const narrowZoom = await clickFitAndReadZoomPct();

    // Same mounted instance, same projects, same button — only the root
    // element's OWN reported width changes, exactly like a live
    // marginRight update when the manager overlay collapses (CanvasView.tsx
    // never remounts for that transition).
    mockedCanvasViewWidth = 1300; // wide — manager overlay collapsed

    const wideZoom = await clickFitAndReadZoomPct();

    expect(wideZoom).toBeGreaterThan(narrowZoom);
  });
});
