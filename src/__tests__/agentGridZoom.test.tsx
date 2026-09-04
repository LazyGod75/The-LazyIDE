/* agentGridZoom.test.tsx — proves the AGENTS grid's zoom control (design
   §7/§12.1) genuinely applies a transform:scale to the grid content, via
   the buttons, the reset label, and a Ctrl+wheel gesture — and that it
   persists across an AgentGrid remount within the same module (session),
   per the "persists while navigating within the session" requirement.

   Regression coverage for two real bugs fixed in this pass:
   1. Zoom used to live in a plain useState, reset to 100% every time
      AgentsSpace.tsx unmounted Cockpit (e.g. toggling the Bibliothèque
      tab) — now backed by a module-level variable that survives remounts.
   2. The header's "open-library-chip" button used to declare
      gridColumn:'1 / -1' inside the pipeline header's CSS Grid, which
      pushed the PLAN/CODE/TEST/REVUE/MERGÉ stage labels onto an implicit
      second row, well outside the header's 46px box. */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { AgentGrid } from '../components/agents/cockpit/AgentGrid';
import type { FleetProject } from '../lib/agents/fleetMissions';

const PROJECTS: FleetProject[] = [
  {
    projectId: 'p1',
    root: '/fixtures/p1',
    name: 'p1',
    missions: [
      {
        id: 'm1',
        title: 'demo-mission',
        status: 'running',
        stage: 'code',
        model: 'sonnet',
        liveAction: '▊ writing…',
        progress: 42,
        updatedMs: Date.now(),
        urgent: false,
      },
    ],
  },
];

function renderGrid() {
  return render(
    <I18nProvider>
      <AgentGrid
        projects={PROJECTS}
        collapsedMap={{}}
        onToggleCollapse={() => {}}
        highlightIds={new Set()}
        justMergedId={null}
        rankByMissionId={new Map()}
        forceApproveIds={new Set()}
        onOpenMission={() => {}}
        onUrgentAction={() => {}}
        onOpenLibrary={() => {}}
      />
    </I18nProvider>,
  );
}

function zoomContentTransform(): string {
  const el = screen.getByTestId('agent-grid-zoom-content');
  return el.style.transform;
}

// Zoom is intentionally backed by a MODULE-LEVEL variable in AgentGrid.tsx
// (see its "persists across remounts within the same session" test below),
// not component state — so it survives across unrelated tests in this file
// too unless explicitly reset. Force it back to 100% before every test that
// doesn't specifically exercise persistence.
beforeEach(() => {
  const { unmount } = renderGrid();
  fireEvent.click(screen.getByTestId('grid-zoom-reset'));
  unmount();
});

describe('AgentGrid — zoom', () => {
  it('starts at 100% / scale(1)', () => {
    renderGrid();
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('100%');
    expect(zoomContentTransform()).toBe('scale(1)');
  });

  it('the − button decreases zoom and updates both the label and the transform', () => {
    renderGrid();
    fireEvent.click(screen.getByTestId('grid-zoom-out'));
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('90%');
    expect(zoomContentTransform()).toBe('scale(0.9)');
  });

  it('the + button increases zoom, clamped to the 0.5–1.4 range', () => {
    renderGrid();
    const plus = screen.getByTestId('grid-zoom-in');
    for (let i = 0; i < 10; i += 1) fireEvent.click(plus);
    // 1.0 + 10*0.1 = 2.0, clamped to 1.4
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('140%');
    expect(zoomContentTransform()).toBe('scale(1.4)');
  });

  it('the − button clamps at the 0.5 floor', () => {
    renderGrid();
    const minus = screen.getByTestId('grid-zoom-out');
    for (let i = 0; i < 10; i += 1) fireEvent.click(minus);
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('50%');
    expect(zoomContentTransform()).toBe('scale(0.5)');
  });

  it('clicking the % label resets zoom to 100%', () => {
    renderGrid();
    fireEvent.click(screen.getByTestId('grid-zoom-out'));
    fireEvent.click(screen.getByTestId('grid-zoom-out'));
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('80%');
    fireEvent.click(screen.getByTestId('grid-zoom-reset'));
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('100%');
    expect(zoomContentTransform()).toBe('scale(1)');
  });

  it('Ctrl+wheel over the grid zone zooms in/out by 0.08 steps, and plain wheel (no Ctrl) does nothing', () => {
    renderGrid();
    const zone = screen.getByTestId('agent-grid-zoom-content').parentElement as HTMLElement;

    // Plain wheel (no ctrlKey): must not change zoom (it's a normal scroll).
    fireEvent.wheel(zone, { deltaY: -100, bubbles: true, cancelable: true });
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('100%');

    // Ctrl+wheel up (deltaY < 0) zooms IN.
    fireEvent.wheel(zone, { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('108%');
    expect(zoomContentTransform()).toBe('scale(1.08)');

    // Ctrl+wheel down (deltaY > 0) zooms OUT, back below 100%.
    fireEvent.wheel(zone, { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent.wheel(zone, { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true });
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('92%');
    expect(zoomContentTransform()).toBe('scale(0.92)');
  });

  it('below 100% zoom, the content wrapper widens to keep the row full-bleed (design §8)', () => {
    renderGrid();
    fireEvent.click(screen.getByTestId('grid-zoom-out')); // 90%
    const el = screen.getByTestId('agent-grid-zoom-content');
    expect(el.style.width).toBe('111.11%');
  });

  it('at 100% or above, the content wrapper is exactly 100% wide', () => {
    renderGrid();
    fireEvent.click(screen.getByTestId('grid-zoom-in')); // 110%
    const el = screen.getByTestId('agent-grid-zoom-content');
    expect(el.style.width).toBe('100%');
  });

  it('persists across an AgentGrid remount within the same session (unmount/remount, e.g. leaving and returning to Mission Control)', () => {
    const first = renderGrid();
    fireEvent.click(screen.getByTestId('grid-zoom-out'));
    fireEvent.click(screen.getByTestId('grid-zoom-out'));
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('80%');

    // Simulate AgentsSpace.tsx unmounting Cockpit (and therefore AgentGrid)
    // when the user leaves Mission Control, then remounting it on return.
    first.unmount();
    renderGrid();
    expect(screen.getByTestId('grid-zoom-reset')).toHaveTextContent('80%');
    expect(zoomContentTransform()).toBe('scale(0.8)');

    // Reset for any other test relying on the module-level default.
    fireEvent.click(screen.getByTestId('grid-zoom-reset'));
  });
});

describe('AgentGrid — pipeline header layout', () => {
  it('keeps the library-access button OUT of the pipeline header CSS Grid, so it cannot push the PLAN/CODE/TEST/REVUE/MERGÉ stage labels onto an implicit second row', () => {
    renderGrid();
    // Regression check for a real bug measured in the live app: this button
    // used to declare gridColumn:'1 / -1' as an auto-placed sibling of the
    // 5 stage-label spans inside a single-row CSS Grid — an explicitly-
    // positioned item spanning the full row width forces every subsequent
    // auto-placed sibling onto an implicit row 2, which rendered the stage
    // labels ~34px below the header's own 46px box (verified via
    // getBoundingClientRect in a live-app check: header bottom=273,
    // labels top=281). Taking the button fully out of grid flow
    // (position:absolute) fixes it — this asserts that seam stays in place.
    const libraryChip = screen.getByTestId('open-library-chip');
    expect(libraryChip.style.gridColumn).toBe('');
    expect(libraryChip.style.position).toBe('absolute');
  });
});
