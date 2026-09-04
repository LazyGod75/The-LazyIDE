/**
 * canvasLegend.test.tsx — fix/canvas-legibility: the canvas toolbar's
 * status legend popover (CanvasToolbar.tsx's CanvasLegendPopover), the
 * direct answer to the QA finding "colors have no legend, no icons
 * readable".
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import { CanvasToolbar } from '../components/agents/canvas/CanvasToolbar';

afterEach(cleanup);

function baseProps() {
  return {
    minimapEnabled: true,
    onToggleMinimap: vi.fn(),
    onOpenLibrary: vi.fn(),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    snapEnabled: false,
    onToggleSnap: vi.fn(),
    paletteOpen: false,
    onTogglePalette: vi.fn(),
    onRunLayout: vi.fn(),
    onTidyZones: vi.fn(),
    laneModeEnabled: false,
    onToggleLaneMode: vi.fn(),
    hasSelection: false,
    onZoomToSelection: vi.fn(),
    selectedDraftId: null as string | null,
    onLaunchSelectedDraft: vi.fn(),
    searchQuery: '',
    onSearchChange: vi.fn(),
    failureCount: 0,
    onFocusFailures: vi.fn(),
    onOpenShortcuts: vi.fn(),
    hideMergedEnabled: false,
    onToggleHideMerged: vi.fn(),
    wheelMode: 'zoom' as 'zoom' | 'scroll',
    onToggleWheelMode: vi.fn(),
    replayActive: false,
    onToggleReplay: vi.fn(),
    onExportCanvas: vi.fn(),
    onImportCanvasFile: vi.fn(),
    onExportYaml: vi.fn(),
    onImportYamlFile: vi.fn(),
    onGitExport: vi.fn(),
    onExportMcp: vi.fn(),
    followActiveEnabled: false,
    onToggleFollowActive: vi.fn(),
  };
}

function renderToolbar(overrides: Partial<ReturnType<typeof baseProps>> = {}) {
  const props = { ...baseProps(), ...overrides };
  render(
    <I18nProvider>
      <ReactFlowProvider>
        <CanvasToolbar {...props} />
      </ReactFlowProvider>
    </I18nProvider>,
  );
  return props;
}

describe('CanvasToolbar — status legend popover (fix/canvas-legibility)', () => {
  it('the popover is closed by default', () => {
    renderToolbar();
    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });

  it('opens on click, listing all 6 statuses with an icon + color-coded dot + label', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-legend-title')).toBeInTheDocument();
    for (const status of ['running', 'queued', 'paused', 'review', 'failed', 'merged']) {
      const row = screen.getByTestId(`canvas-legend-status-${status}`);
      expect(row).toBeInTheDocument();
      expect(row.querySelector(`[data-testid="glyph-status-${status}"]`)).toBeInTheDocument();
    }
  });

  // Visual sweep #11 — 'queued' and 'paused' used to share the exact same
  // grey (nodeChrome.tsx's statusAccentColor, both -> --canvas-state-idle),
  // so this legend (and every dot/ring driven by that same function) showed
  // an identical color for "waiting to start" and "stopped mid-run".
  it('gives "queued" and "paused" visually distinct dot colors', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    const queuedDot = screen.getByTestId('canvas-legend-status-queued').querySelectorAll('span')[0];
    const pausedDot = screen.getByTestId('canvas-legend-status-paused').querySelectorAll('span')[0];
    expect(queuedDot.style.background).not.toBe(pausedDot.style.background);
  });

  it('toggles closed on a second click of the trigger', () => {
    renderToolbar();
    const trigger = screen.getByTestId('canvas-toolbar-legend-toggle');
    fireEvent.click(trigger);
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });

  it('closes on an outside click', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();
    // Founder bug fix audit (2026-07-22): this popover's outside-click
    // dismissal now goes through the shared useDismissable hook, which
    // listens for 'pointerdown' (not 'mousedown') — required so a trigger
    // button's own pointerdown can be recognized as "ignored" before its
    // click handler runs, fixing the close-then-reopen race. Real clicks
    // always dispatch pointerdown first, so this is a test-simulation
    // update only, not a behavior change — see useDismissable.ts's header
    // comment and CanvasToolbar.dismissal.test.tsx's own coverage of the
    // fixed race.
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });

  // David's repro (2026-08-15): Escape reliably failed to close this exact
  // popover in the real app. Root cause was useDismissable.ts's effect
  // depending on `onClose` — CanvasLegendPopover is passed
  // `onClose={() => setLegendOpen(false)}`, a fresh lambda on every
  // CanvasToolbar render, so the shared hook's `window` keydown listener
  // was torn down and reinstalled on every one of the toolbar's own
  // re-renders while the popover stayed open (the toolbar re-renders often
  // in the live app — agentsStore mission/status updates — but any
  // unrelated re-render reproduces the same effect churn). This test
  // forces several CanvasToolbar re-renders via an unrelated prop
  // (`searchQuery`) while the popover stays open, then fires Escape —
  // pinning that the fix (useDismissable.ts reading `onClose` through a
  // ref, effect deps trimmed to `[open]`) makes this robust regardless of
  // how many times the toolbar re-rendered in between.
  it('still closes on Escape after several unrelated toolbar re-renders (regression)', () => {
    const props = baseProps();
    const { rerender } = render(
      <I18nProvider>
        <ReactFlowProvider>
          <CanvasToolbar {...props} />
        </ReactFlowProvider>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();

    // Re-renders the SAME mounted tree (not a fresh mount) with an
    // unrelated prop change each time — every pass gives CanvasToolbar (and
    // therefore CanvasLegendPopover's `onClose` prop) a brand-new function
    // identity, matching what happens in the live app on every
    // agentsStore-driven re-render while the popover stays open.
    for (let i = 0; i < 10; i += 1) {
      rerender(
        <I18nProvider>
          <ReactFlowProvider>
            <CanvasToolbar {...props} searchQuery={`q${i}`} />
          </ReactFlowProvider>
        </I18nProvider>,
      );
    }
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });
});
