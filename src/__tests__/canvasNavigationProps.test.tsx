/**
 * canvasNavigationProps.test.tsx — fix/canvas-navigation (CRITICAL
 * regression): user report (real desktop session) was "click-drag pan,
 * wheel zoom, AND trackpad pinch zoom all dead". Root cause (drag pan): R11
 * (commit 0c4a38e, asserted by THIS file until now) had inverted RF's own
 * defaults into a Figma-style scheme — `selectionOnDrag: true` (left-drag
 * ALWAYS marquee-selects) + `panOnDrag: [1]` (ONLY middle-button pans, no
 * discoverable left-drag pan at all without holding an undocumented Space
 * key). Restored to the n8n/Flowise scheme (RF's OWN defaults): plain
 * left-click-drag PANS, Shift+drag marquee-selects. This file proves:
 *   1. the n8n-style pan/select scheme reaches the real `<ReactFlow>`
 *      element by default (panOnDrag=[0,1], selectionOnDrag=false,
 *      selectionKeyCode='Shift'),
 *   2. wheel=ZOOM by default (zoomOnScroll=true/panOnScroll=false,
 *      David's own explicit expectation, unrelated axis from R11 — still
 *      correct and untouched by this fix) and pinch is never disabled,
 *   3. toggling `CanvasPrefs.wheelMode` to 'scroll' (via the toolbar's
 *      overflow-menu toggle) flips ONLY the wheel props — pan/select stay
 *      exactly the n8n scheme regardless of wheelMode.
 *
 * Uses a props-capture spy around the real component (not a full
 * re-implementation mock — `actual.ReactFlow` still mounts), same technique
 * this file used pre-fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanOnScrollMode, SelectionMode } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import type { FleetProject } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';
import { _resetCanvasStoreForTests, canvasStoreVanilla } from '../components/agents/canvas/canvasStore';
import { DEFAULT_CANVAS_PREFS, type CanvasLayoutFileV1 } from '../components/agents/canvas/canvasTypes';

installReactFlowTestEnv();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capturedProps: any[] = [];

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ReactFlow: (props: any) => {
      capturedProps.push(props);
      return <actual.ReactFlow {...props} />;
    },
  };
});

// Imported AFTER the mock so CanvasView's own `import { ReactFlow } from
// '@xyflow/react'` resolves to the spied version above.
const { CanvasView } = await import('../components/agents/canvas/CanvasView');

const FIXTURE_PROJECTS: FleetProject[] = [
  {
    projectId: 'demo-shop',
    root: '/fixtures/demo-shop',
    name: 'demo-shop',
    missions: [
      { id: 'm-1', title: 'Fix checkout bug', status: 'running', stage: 'code', model: 'sonnet', updatedMs: Date.now(), urgent: false },
    ],
  },
];

function renderCanvasView() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <CanvasView
              projects={FIXTURE_PROJECTS}
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

function latestProps() {
  return capturedProps[capturedProps.length - 1];
}

describe('CanvasView — wheel-zoom default + mode toggle (R11)', () => {
  beforeEach(() => {
    capturedProps.length = 0;
    _resetCanvasStoreForTests();
  });

  it('ships the n8n/Flowise navigation scheme by default: left+middle drag pans, Shift+drag selects, wheel zooms, pinch zooms (fix/canvas-navigation)', async () => {
    renderCanvasView();
    await screen.findByTestId('canvas-view');

    expect(capturedProps.length).toBeGreaterThan(0);
    const props = latestProps();

    // Plain wheel/trackpad scroll zooms by default.
    expect(props.zoomOnScroll).toBe(true);
    expect(props.panOnScroll).toBe(false);
    expect(props.panOnScrollMode).toBe(PanOnScrollMode.Free);
    expect(props.panOnScrollSpeed).toBe(0.6);
    // Trackpad pinch / ctrl+wheel zooms too — must never be disabled,
    // regardless of wheelMode.
    expect(props.zoomOnPinch).toBe(true);
    expect(props.zoomOnDoubleClick).toBe(false);
    // THE regression fix: left-click-drag (button 0) on empty canvas pans —
    // no Space-hold, no middle-click required, matching n8n/Flowise. Middle
    // button (1) also pans (task's own "middle-click drag pan should also
    // work"). Marquee selection moves to Shift+drag instead of living on
    // plain left-drag (RF's own `selectionKeyCode` default handles the
    // Shift-modifier detection once `selectionOnDrag` no longer forces it
    // unconditionally).
    expect(props.panOnDrag).toEqual([0, 1]);
    expect(props.selectionOnDrag).toBe(false);
    expect(props.selectionKeyCode).toBe('Shift');
    expect(props.selectionMode).toBe(SelectionMode.Partial);
    expect(props.selectNodesOnDrag).toBe(false);
    expect(props.connectionRadius).toBe(30);
    expect(props.nodeDragThreshold).toBe(1);
    expect(props.deleteKeyCode).toEqual([]);
    expect(props.disableKeyboardA11y).toBe(true);
    expect(props.elevateNodesOnSelect).toBe(true);
    expect(props.elevateEdgesOnSelect).toBe(false);
    // scratch/_canvas-label-design.md §3.2 — `minZoom` is dynamic now
    // (`dynamicMinZoom`, CanvasView.tsx), `min(LOD_FLOOR_ZOOM, natural fit
    // zoom)`. jsdom's own zero-sized container (`getBoundingClientRect`
    // reports 0 here — no real layout engine, this suite's own render
    // harness has no measurable canvas-view rect) makes the natural-fit
    // computation bail out to its own honest fallback: `LOD_FLOOR_ZOOM`
    // itself (0.25) — was a flat, unconditional 0.1.
    expect(props.minZoom).toBe(0.25);
    expect(props.maxZoom).toBe(2);
    // P47 — panel-aware padding (cameraInsets.ts): rendered standalone here
    // (no ManagerOverlay/CockpitLeftRail siblings), so the docked-panel
    // insets read back as 0 and only the default breathing-room gutter
    // (24px) remains on left/right, alongside the pre-existing 0.2
    // vertical fraction on top/bottom.
    expect(props.fitViewOptions).toEqual({ padding: { top: 0.2, bottom: 0.2, left: '24px', right: '24px' } });
    expect(props.proOptions).toEqual({ hideAttribution: true });
  });

  it('toggling the toolbar\'s « Molette : Zoom / Défilement » switch flips zoomOnScroll/panOnScroll to the opt-in scroll-pan scheme, leaving pan/select untouched', async () => {
    renderCanvasView();
    await screen.findByTestId('canvas-view');

    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    const wheelToggle = screen.getByTestId('canvas-toolbar-wheel-mode');
    expect(wheelToggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(wheelToggle);

    const props = latestProps();
    expect(props.zoomOnScroll).toBe(false);
    expect(props.panOnScroll).toBe(true);
    // Untouched by the wheel toggle — pan/select is an orthogonal axis.
    expect(props.zoomOnPinch).toBe(true);
    expect(props.panOnDrag).toEqual([0, 1]);
    expect(props.selectionOnDrag).toBe(false);
    expect(props.selectionKeyCode).toBe('Shift');

    // Toggling again flips back to zoom (round-trip, no persisted drift).
    // The overflow menu stays open across a toggle (same convention as the
    // pre-existing « Masquer mergées » item), so the button is still there.
    fireEvent.click(screen.getByTestId('canvas-toolbar-wheel-mode'));
    expect(latestProps().zoomOnScroll).toBe(true);
    expect(latestProps().panOnScroll).toBe(false);
  });

  it('a stale/invalid persisted wheelMode value can never produce a dead scroll-wheel (sanitized on load)', async () => {
    // Simulates hydrate() loading a corrupted/hand-edited/future-schema
    // layout.json — `isCanvasPrefs` (canvasPersistence.ts) never validated
    // this field's VALUE, only that the `prefs` object exists with the
    // older boolean fields (see canvasTypes.ts's `sanitizeCanvasPrefs` doc
    // comment for the full root-cause). Without sanitizing on load, a value
    // that is neither 'zoom' nor 'scroll' would make BOTH zoomOnScroll and
    // panOnScroll evaluate false simultaneously — a dead scroll-wheel.
    _resetCanvasStoreForTests();
    const corruptLayout: CanvasLayoutFileV1 = {
      version: 1,
      positions: {},
      collapsed: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prefs: { ...DEFAULT_CANVAS_PREFS, wheelMode: 'garbage-legacy-value' as any },
      notes: [],
    };
    canvasStoreVanilla.getState().hydrate(corruptLayout, null);

    renderCanvasView();
    await screen.findByTestId('canvas-view');

    const props = latestProps();
    expect(props.zoomOnScroll).toBe(true);
    expect(props.panOnScroll).toBe(false);
  });
});
