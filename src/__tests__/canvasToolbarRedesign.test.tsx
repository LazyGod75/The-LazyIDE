/**
 * canvasToolbarRedesign.test.tsx — R1b defect #11 + "tout doit se lire sur
 * le canvas": the toolbar used to wrap onto a second row (status-filter
 * chips + always-visible « Focus pannes » pill + eye/keyboard/Bibliothèque
 * buttons). This file proves the redesigned single row: status chips are
 * GONE, « Focus pannes » is a conditional alert icon (absent at 0 matches,
 * badge-counted otherwise), and hide-merged/shortcuts/library are folded
 * behind one "⋯" overflow menu.
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

describe('CanvasToolbar — single-row redesign (R1b defect #11)', () => {
  it('never renders status-filter chips (removed outright)', () => {
    renderToolbar();
    for (const status of ['running', 'review', 'failed', 'queued', 'done']) {
      expect(screen.queryByTestId(`canvas-toolbar-status-filter-${status}`)).not.toBeInTheDocument();
    }
  });

  it('« Focus pannes » is absent when failureCount is 0 (nothing to focus)', () => {
    renderToolbar({ failureCount: 0 });
    expect(screen.queryByTestId('canvas-toolbar-focus-failures')).not.toBeInTheDocument();
  });

  it('« Focus pannes » appears with a count badge when failureCount > 0, and calls onFocusFailures on click', () => {
    const onFocusFailures = vi.fn();
    renderToolbar({ failureCount: 3, onFocusFailures });
    const button = screen.getByTestId('canvas-toolbar-focus-failures');
    expect(button).toBeInTheDocument();
    expect(screen.getByTestId('canvas-toolbar-count-badge')).toHaveTextContent('3');
    fireEvent.click(button);
    expect(onFocusFailures).toHaveBeenCalledTimes(1);
  });

  it('hide-merged/shortcuts/library are NOT on the main row — only reachable via the "⋯" overflow menu', () => {
    renderToolbar();
    expect(screen.queryByTestId('canvas-toolbar-hide-merged')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-toolbar-shortcuts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-library-chip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-hide-merged')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-toolbar-shortcuts')).toBeInTheDocument();
    expect(screen.getByTestId('open-library-chip')).toBeInTheDocument();
  });

  it('overflow menu: clicking « Bibliothèque » calls onOpenLibrary and closes the menu', () => {
    const onOpenLibrary = vi.fn();
    renderToolbar({ onOpenLibrary });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    fireEvent.click(screen.getByTestId('open-library-chip'));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('open-library-chip')).not.toBeInTheDocument();
  });

  // scratch/_canvas-label-design.md §3.3 item 5 — « Ranger », the lighter,
  // zone-boxes-only sibling of « Rangement auto » (onRunLayout) — lives in
  // the SAME always-in-the-"⋯"-menu autoLayoutGroup entry (static split,
  // fix/canvas-toolbar-oscillation), never in the always-visible row.
  it('overflow menu: exposes « Ranger » next to « Rangement auto », and clicking it calls onTidyZones', () => {
    const onTidyZones = vi.fn();
    renderToolbar({ onTidyZones });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-auto-layout-demoted')).toBeInTheDocument();
    // Same demoted `autoLayoutGroup` cluster as onRunLayout above — that
    // group's own buttons don't auto-close the menu on click either (a
    // toggle-heavy group; see CanvasToolbar.tsx's demotedMenuItems), so this
    // only asserts the callback, not a menu-close side effect.
    fireEvent.click(screen.getByTestId('canvas-toolbar-tidy-zones-demoted'));
    expect(onTidyZones).toHaveBeenCalledTimes(1);
  });

  it('« Ranger » is disabled while replay is active, same as « Rangement auto »', () => {
    renderToolbar({ replayActive: true });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-tidy-zones-demoted')).toBeDisabled();
  });

  // W-CLOSE row 4 ("flow-as-code" v1) — export/import overflow-menu entries.
  it('overflow menu: clicking « Exporter le canvas » calls onExportCanvas and closes the menu', () => {
    const onExportCanvas = vi.fn();
    renderToolbar({ onExportCanvas });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    fireEvent.click(screen.getByTestId('canvas-toolbar-export'));
    expect(onExportCanvas).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('canvas-toolbar-export')).not.toBeInTheDocument();
  });

  it('overflow menu: picking a file via « Importer un canvas » calls onImportCanvasFile with that file', () => {
    const onImportCanvasFile = vi.fn();
    renderToolbar({ onImportCanvasFile });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    const file = new File(['{}'], 'export.json', { type: 'application/json' });
    const input = screen.getByTestId('canvas-toolbar-import-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(onImportCanvasFile).toHaveBeenCalledTimes(1);
    expect(onImportCanvasFile).toHaveBeenCalledWith(file);
  });

  it('« Importer un canvas » is disabled (gated) while replay is active', () => {
    renderToolbar({ replayActive: true });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-import')).toBeDisabled();
  });

  // R11 — wheel-mode toggle: default label reads "Zoom", clicking calls
  // onToggleWheelMode, and the "scroll" mode reads back as pressed/accented.
  it('overflow menu: exposes the wheel-mode toggle, defaulting to "Zoom" and calling onToggleWheelMode on click', () => {
    const onToggleWheelMode = vi.fn();
    renderToolbar({ onToggleWheelMode });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    const toggle = screen.getByTestId('canvas-toolbar-wheel-mode');
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(onToggleWheelMode).toHaveBeenCalledTimes(1);
  });

  it('overflow menu: wheel-mode toggle reflects "scroll" mode as pressed', () => {
    renderToolbar({ wheelMode: 'scroll' });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-wheel-mode')).toHaveAttribute('aria-pressed', 'true');
  });

  it('overflow menu closes on Escape', () => {
    renderToolbar();
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    expect(screen.getByTestId('canvas-toolbar-overflow-menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('canvas-toolbar-overflow-menu')).not.toBeInTheDocument();
  });

  it('the toolbar row never wraps (single-row layout, `flexWrap: nowrap`)', () => {
    renderToolbar();
    const toolbar = screen.getByTestId('canvas-toolbar');
    expect(toolbar.style.flexWrap).toBe('nowrap');
  });

  it('still exposes the kept main-row controls: fit/zoom/legend/zoom-to-selection/follow/replay/search (fix/canvas-toolbar-oscillation Option B — minimap/undo-redo/snap/palette/layout-group moved into the overflow menu, see the dedicated describe block below)', () => {
    renderToolbar();
    for (const testId of [
      'canvas-toolbar-fit',
      'canvas-toolbar-zoom-out',
      'canvas-toolbar-zoom-pct',
      'canvas-toolbar-zoom-in',
      'canvas-toolbar-legend-toggle',
      'canvas-toolbar-zoom-to-selection',
      'canvas-toolbar-follow-active',
      'canvas-toolbar-replay-toggle',
      'canvas-toolbar-search',
      'canvas-toolbar-overflow-toggle',
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });
});

// P47 deliverable #2 — « Suivre l'activité » toggle: always on the main row
// (north-star ask, never buried in the overflow menu), reflects its own
// enabled prop, and calls onToggleFollowActive on click.
describe('CanvasToolbar — « Suivre l\'activité » toggle (P47)', () => {
  it('reflects the disabled state via aria-pressed', () => {
    renderToolbar({ followActiveEnabled: false });
    expect(screen.getByTestId('canvas-toolbar-follow-active')).toHaveAttribute('aria-pressed', 'false');
  });

  it('reflects the enabled state via aria-pressed', () => {
    renderToolbar({ followActiveEnabled: true });
    expect(screen.getByTestId('canvas-toolbar-follow-active')).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onToggleFollowActive on click', () => {
    const onToggleFollowActive = vi.fn();
    renderToolbar({ onToggleFollowActive });
    fireEvent.click(screen.getByTestId('canvas-toolbar-follow-active'));
    expect(onToggleFollowActive).toHaveBeenCalledTimes(1);
  });
});

// fix/canvas-ux R6a BLOQUANT #1c — the contextual « Lancer » chip: reachable
// at every zoom level (including `dot`, where DraftNode.tsx stays a passive
// glyph by design) once exactly one draft node is selected.
describe('CanvasToolbar — contextual "Lancer" chip (fix/canvas-ux R6a BLOQUANT #1c)', () => {
  it('is absent when no draft is selected', () => {
    renderToolbar({ selectedDraftId: null });
    expect(screen.queryByTestId('canvas-toolbar-launch-selected-draft')).not.toBeInTheDocument();
  });

  it('appears once a single draft is selected and calls onLaunchSelectedDraft on click', () => {
    const onLaunchSelectedDraft = vi.fn();
    renderToolbar({ selectedDraftId: 'draft-9', onLaunchSelectedDraft });
    const chip = screen.getByTestId('canvas-toolbar-launch-selected-draft');
    fireEvent.click(chip);
    expect(onLaunchSelectedDraft).toHaveBeenCalledTimes(1);
  });
});

// fix/canvas-toolbar-squeeze (David's measured repro, real packaged app:
// reserving the ManagerOverlay's lane shrank the toolbar's own available
// width from ~1066px to ~848px — with no shrink floor, the fit button
// measured 17px wide (was 28) and text labels wrapped vertically mid-word,
// "Auto-layou / t"). The `flexShrink: 0` / `whiteSpace: nowrap` floor below
// is the surviving half of that original fix.
describe('CanvasToolbar — squeeze hardening (fix/canvas-toolbar-squeeze)', () => {
  it('every remaining main-row button floors at flexShrink: 0 and whiteSpace: nowrap — nothing may ever compress below its natural size or wrap a label mid-word', () => {
    renderToolbar();
    for (const testId of [
      'canvas-toolbar-fit',
      'canvas-toolbar-zoom-out',
      'canvas-toolbar-zoom-in',
      'canvas-toolbar-legend-toggle',
      'canvas-toolbar-zoom-to-selection',
      'canvas-toolbar-follow-active',
      'canvas-toolbar-replay-toggle',
      'canvas-toolbar-overflow-toggle',
    ]) {
      const el = screen.getByTestId(testId);
      expect(el.style.flexShrink).toBe('0');
      expect(el.style.whiteSpace).toBe('nowrap');
    }
    // The search input is the one non-button essential control — same floor.
    expect(screen.getByTestId('canvas-toolbar-search').style.flexShrink).toBe('0');
  });
});

// fix/canvas-toolbar-oscillation Option B — David's own explicit fallback
// after two live fix attempts at a WIDTH-REACTIVE demotion mechanism both
// produced a continuous, zero-interaction oscillation on a real machine
// (instrumented 100ms sampling caught 5 distinct button counts cycling
// forever; the product owner independently confirmed seeing it "buggy and
// flickering"). The toolbar's own overflow split is now a FIXED constant
// (TOOLBAR_ALWAYS_VISIBLE_KEYS in CanvasToolbar.tsx) decided once at module
// load — these tests prove the split is truly static: it does not react to
// container size, real or simulated, in either direction.
describe('CanvasToolbar — static overflow split (fix/canvas-toolbar-oscillation Option B)', () => {
  // legend is ALSO always-visible (see TOOLBAR_ALWAYS_VISIBLE_KEYS's own doc
  // comment: it is the one demotable control with a positioned popover,
  // kept inline for that structural reason, not a width one).
  const ALWAYS_VISIBLE_TESTIDS = [
    'canvas-toolbar-legend-toggle',
    'canvas-toolbar-zoom-to-selection',
    'canvas-toolbar-follow-active',
    'canvas-toolbar-replay-toggle',
  ];
  const ALWAYS_DEMOTED_TESTIDS = [
    'canvas-toolbar-minimap-toggle',
    'canvas-toolbar-undo',
    'canvas-toolbar-redo',
    'canvas-toolbar-snap-toggle',
    'canvas-toolbar-palette-toggle',
    'canvas-toolbar-auto-layout',
    'canvas-toolbar-lane-mode',
    'canvas-toolbar-dry-run',
    'canvas-toolbar-cockpit-mode',
  ];

  it('the always-visible subset renders inline on the main row, unconditionally', () => {
    renderToolbar();
    for (const testId of ALWAYS_VISIBLE_TESTIDS) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it('the rest of the demotable controls never render inline — they exist ONLY inside the "⋯" overflow menu', () => {
    renderToolbar();
    for (const testId of ALWAYS_DEMOTED_TESTIDS) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    for (const testId of ALWAYS_DEMOTED_TESTIDS) {
      expect(screen.getByTestId(`${testId}-demoted`)).toBeInTheDocument();
    }
  });

  it('clicking a demoted control in the overflow menu calls the SAME callback the main-row button used to', () => {
    const onToggleMinimap = vi.fn();
    renderToolbar({ onToggleMinimap });
    fireEvent.click(screen.getByTestId('canvas-toolbar-overflow-toggle'));
    fireEvent.click(screen.getByTestId('canvas-toolbar-minimap-toggle-demoted'));
    expect(onToggleMinimap).toHaveBeenCalledTimes(1);
  });

  // The direct regression guard for the oscillation itself: stubbing the
  // demotable region's (or any element's) measured width — tiny, huge, or
  // anything in between — must never change which buttons render, because
  // nothing in CanvasToolbar.tsx reads that measurement any more. This is
  // the exact stubbing technique the OLD width-reactive tests used to prove
  // demotion happened; here it proves the opposite on purpose.
  describe('immune to container width, real or simulated', () => {
    const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = realGetBoundingClientRect;
    });

    function stubDemotableRegionWidth(widthPx: number): void {
      HTMLElement.prototype.getBoundingClientRect = function stubbedRect(this: HTMLElement): DOMRect {
        const width = this.dataset.testid === 'canvas-toolbar-demotable-region' ? widthPx : 0;
        return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      };
    }

    it('a starved width (40px) does not demote the always-visible subset or promote anything into the main row', () => {
      stubDemotableRegionWidth(40);
      renderToolbar();
      for (const testId of ALWAYS_VISIBLE_TESTIDS) {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      }
      for (const testId of ALWAYS_DEMOTED_TESTIDS) {
        expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      }
    });

    it('an abundant width (2000px) does not pull any always-demoted control into the main row', () => {
      stubDemotableRegionWidth(2000);
      renderToolbar();
      for (const testId of ALWAYS_DEMOTED_TESTIDS) {
        expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      }
      for (const testId of ALWAYS_VISIBLE_TESTIDS) {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      }
    });
  });

  // The re-render/resize proof: the OLD mechanism's failure mode was a
  // live loop — repeated recomputation flipping the same buttons back and
  // forth with zero user interaction. Re-rendering the same tree five times
  // and dispatching a real `resize` event must produce byte-identical
  // output, because there is no effect left anywhere in this component that
  // a resize or a re-render could even trigger a recompute in.
  it('the rendered button set is identical across repeated re-renders and a real window resize event', () => {
    const props = baseProps();
    const { rerender } = render(
      <I18nProvider>
        <ReactFlowProvider>
          <CanvasToolbar {...props} />
        </ReactFlowProvider>
      </I18nProvider>,
    );
    const snapshot = () =>
      Array.from(screen.getByTestId('canvas-toolbar').querySelectorAll('[data-testid]'))
        .map((el) => el.getAttribute('data-testid'))
        .sort();
    const before = snapshot();
    for (let i = 0; i < 5; i++) {
      rerender(
        <I18nProvider>
          <ReactFlowProvider>
            <CanvasToolbar {...props} />
          </ReactFlowProvider>
        </I18nProvider>,
      );
    }
    fireEvent(window, new Event('resize'));
    expect(snapshot()).toEqual(before);
  });
});
