/**
 * CanvasToolbar.dismissal.test.tsx — founder bug fix audit (2026-07-22):
 * the same close-then-reopen race CockpitRailPopover.tsx/
 * CanvasFloatingButtons.tsx already got fixed (useDismissable.ts) also
 * affected two toolbar surfaces where the toggle button and its panel are
 * DOM siblings (not nested), so the panel's own outside-pointerdown
 * listener used to see the toggle button as "outside":
 *   - the status-legend popover (`canvas-toolbar-legend-toggle` /
 *     `canvas-legend-popover`)
 *   - the "⋯" overflow menu (`canvas-toolbar-overflow-toggle` /
 *     `canvas-toolbar-overflow-menu`) — the founder's day-one "⋯ Plus
 *     d'outils" complaint.
 * Both now go through the shared useDismissable hook with a `triggerRef`.
 * baseProps/renderToolbar mirror canvasToolbarRedesign.test.tsx's own
 * harness verbatim.
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

describe('CanvasToolbar — status legend popover dismissal (founder bug fix)', () => {
  it('opens on click', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();
  });

  it('re-clicking the same toggle button while open closes it (does not reopen)', () => {
    renderToolbar();
    const toggle = screen.getByTestId('canvas-toolbar-legend-toggle');

    fireEvent.click(toggle);
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();

    // Real browsers fire pointerdown before click for a single re-click —
    // fire both explicitly (fireEvent.click alone can't reproduce the race
    // this is guarding against, see useDismissable.test.tsx).
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);

    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });

  it('clicking outside the popover closes it', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });

  it('pressing Escape closes it', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-legend-toggle'));
    expect(screen.getByTestId('canvas-legend-popover')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('canvas-legend-popover')).not.toBeInTheDocument();
  });
});

describe('CanvasToolbar — "⋯" overflow menu dismissal (founder bug fix, day-one complaint)', () => {
  it('opens on click', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-overflow-menu')).toBeInTheDocument();
  });

  it('re-clicking the same toggle button while open closes it (does not reopen)', () => {
    renderToolbar();
    const toggle = screen.getByTestId('canvas-toolbar-overflow-toggle');

    fireEvent.click(toggle);
    expect(screen.getByTestId('canvas-toolbar-overflow-menu')).toBeInTheDocument();

    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);

    expect(screen.queryByTestId('canvas-toolbar-overflow-menu')).not.toBeInTheDocument();
  });

  it('clicking outside the menu closes it', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-overflow-menu')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('canvas-toolbar-overflow-menu')).not.toBeInTheDocument();
  });
});
