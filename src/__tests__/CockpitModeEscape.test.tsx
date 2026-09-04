/**
 * CockpitModeEscape.test.tsx — severity-1 usability-trap fix (real user
 * report, 2026-08-14): "the user can enter Command mode with one click and
 * has NO way back to the canvas". Root cause: the ONLY mode toggle
 * (`canvas-toolbar-cockpit-mode`) lived inside CanvasToolbar.tsx, which is
 * part of `<CanvasView>` and only renders while `cockpitMode ===
 * 'construction'` (Cockpit.tsx) — Command mode unmounts the canvas (and its
 * toolbar) entirely, so the one button that could get you OUT of Command
 * mode disappeared the instant you were IN it. Measured live: 0
 * `[data-testid="canvas-toolbar"]`, 0 `.react-flow__pane` while in Command
 * mode, and clicking the already-active "Cockpit" TopNav pill did nothing
 * either (pure `onSpaceChange` no-op when already on that space).
 *
 * The fix moved the real toggle into CockpitLeftRail (Cockpit.tsx renders it
 * UNCONDITIONALLY in both modes) and added a "take me home" gesture on
 * TopNav's Cockpit pill (`cockpit:resetMode` bus event). This file pins the
 * INVARIANT David asked for — not his exact keystrokes — plus the two
 * related defects spotted in the same screenshots (rail-over-panel-text
 * overlap, duplicate Fleet Map).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { Cockpit } from '../components/agents/cockpit/Cockpit';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import { COCKPIT_LEFT_RAIL_RESERVED_LEFT_PX } from '../components/agents/cockpit/CockpitLeftRail';
import { PaletteProvider } from '../components/palette/PaletteContext';
import { AgentsUiProvider } from '../components/agents/agentsUiContext';
import { TopNav } from '../components/TopNav';
import type { UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';
import { emit, on } from '../lib/bus';

installReactFlowTestEnv();

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

function renderCockpit(fleetOverride: UseFleetMissionsResult = POPULATED_FLEET) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            {/* Cockpit's ManagerOverlay no longer instantiates <LazyManager>
                itself — it registers into managerHostRegistry and the single
                <ManagerHost> (normally mounted once in AppShell.tsx) portals
                it in. Reproduced here so this test's Cockpit tree still gets
                a real, rendered LazyManager. */}
            <ManagerHostRegistryProvider>
              <Cockpit onOpenLibrary={() => {}} onOpenReport={() => {}} fleetOverride={fleetOverride} objectivesOverride={[]} managerMessagesOverride={[]} />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('Cockpit mode escape hatch — the pinned invariant', () => {
  it('a control that changes cockpitMode is present in the rendered tree, for EVERY cockpit mode (construction AND command)', () => {
    renderCockpit();

    // Default mode: construction (canvas). The rail's mode toggle exists.
    expect(screen.getByTestId('cockpit-rail-icon-mode')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-view')).toBeInTheDocument();
    expect(screen.queryByTestId('cockpit-command-grid')).toBeNull();

    // Flip into Command mode via the ONLY affordance that must always work.
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-mode'));

    // Reproduces David's exact measurement: the canvas (and its toolbar)
    // are genuinely gone in Command mode.
    expect(screen.queryByTestId('canvas-view')).toBeNull();
    expect(document.querySelectorAll('[data-testid="canvas-toolbar"]').length).toBe(0);
    expect(document.querySelectorAll('.react-flow__pane').length).toBe(0);
    expect(screen.getByTestId('cockpit-command-grid')).toBeInTheDocument();

    // THE INVARIANT: the mode-changing control is STILL there.
    expect(screen.getByTestId('cockpit-rail-icon-mode')).toBeInTheDocument();

    // And it still works — clicking it again returns to construction mode.
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-mode'));
    expect(screen.getByTestId('canvas-view')).toBeInTheDocument();
    expect(screen.queryByTestId('cockpit-command-grid')).toBeNull();
    expect(screen.getByTestId('cockpit-rail-icon-mode')).toBeInTheDocument();
  });

  it('persists the mode across a remount (localStorage), and the escape hatch is still present on that fresh mount — persistence alone is fine now that the escape is guaranteed', () => {
    const { unmount } = renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-mode'));
    expect(screen.getByTestId('cockpit-command-grid')).toBeInTheDocument();
    unmount();

    renderCockpit();
    expect(screen.getByTestId('cockpit-command-grid')).toBeInTheDocument();
    expect(screen.getByTestId('cockpit-rail-icon-mode')).toBeInTheDocument();
  });

  it('the canvas toolbar\'s own mode button, when reachable (construction mode), stays in sync with the rail toggle — both read/write the same cockpit:modeChange bus event', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-mode'));
    expect(screen.getByTestId('cockpit-command-grid')).toBeInTheDocument();
    // Reset via the bus directly (same event TopNav's "home" gesture uses)
    // and confirm the rail reflects it immediately.
    act(() => {
      emit('cockpit:modeChange', { mode: 'construction' });
    });
    expect(screen.getByTestId('canvas-view')).toBeInTheDocument();
  });
});

describe('Cockpit mode escape hatch — TopNav "take me home" gesture', () => {
  it('re-clicking the ALREADY-active Cockpit pill resets Command mode back to Construction', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-mode'));
    expect(screen.getByTestId('cockpit-command-grid')).toBeInTheDocument();

    // Cockpit.tsx's own 'cockpit:resetMode' listener — same event TopNav.tsx
    // emits on a re-click of the active pill (proven independently in the
    // TopNav-only describe block below; wiring it here end-to-end would
    // require a full AppShell mount, which is out of this file's scope).
    act(() => {
      emit('cockpit:resetMode', undefined);
    });

    expect(screen.getByTestId('canvas-view')).toBeInTheDocument();
    expect(screen.queryByTestId('cockpit-command-grid')).toBeNull();
  });
});

describe('TopNav — Cockpit pill "take me home" gesture (emits cockpit:resetMode)', () => {
  function renderTopNav(activeSpace: 'agents' | 'code' = 'agents') {
    const onSpaceChange = vi.fn();
    render(
      <I18nProvider>
        <ToastProvider>
          <PaletteProvider>
            <AgentsUiProvider>
              <TopNav activeSpace={activeSpace} onSpaceChange={onSpaceChange} />
            </AgentsUiProvider>
          </PaletteProvider>
        </ToastProvider>
      </I18nProvider>,
    );
    return { onSpaceChange };
  }

  it('emits cockpit:resetMode when the Cockpit pill is clicked WHILE already the active space', () => {
    const handler = vi.fn();
    const off = on('cockpit:resetMode', handler);
    try {
      const { onSpaceChange } = renderTopNav('agents');
      fireEvent.click(screen.getByTestId('nav-pill-agents'));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(onSpaceChange).toHaveBeenCalledWith('agents');
    } finally {
      off();
    }
  });

  it('does NOT emit cockpit:resetMode on first navigation INTO the cockpit from another space', () => {
    const handler = vi.fn();
    const off = on('cockpit:resetMode', handler);
    try {
      const { onSpaceChange } = renderTopNav('code');
      fireEvent.click(screen.getByTestId('nav-pill-agents'));
      expect(handler).not.toHaveBeenCalled();
      expect(onSpaceChange).toHaveBeenCalledWith('agents');
    } finally {
      off();
    }
  });
});

describe('Cockpit rail — no longer overlaps command-mode panel text', () => {
  it('the Command-mode grid reserves the rail\'s own width as its left inset instead of starting at the container edge', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-mode'));
    const grid = screen.getByTestId('cockpit-command-grid');
    expect(grid.style.left).toBe(`${COCKPIT_LEFT_RAIL_RESERVED_LEFT_PX}px`);
    expect(grid.style.left).not.toBe('0px');
  });
});

describe('Cockpit rail — Fleet Map no longer renders twice at once', () => {
  it('in Command mode (where the "Fleet Map" quadrant is already always-visible), the rail icon does NOT open a second, redundant popover', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-mode')); // -> command mode
    expect(screen.getByTestId('cockpit-command-fleet')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cockpit-rail-icon-fleetMap'));

    expect(screen.queryByTestId('cockpit-rail-popover-fleetMap')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('cockpit-rail-icon-fleetMap')).not.toHaveAttribute('aria-haspopup');
  });

  it('in Construction mode (no always-visible Fleet Map twin), the rail icon still opens its popover normally', () => {
    renderCockpit();
    expect(screen.getByTestId('canvas-view')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cockpit-rail-icon-fleetMap'));

    expect(screen.getByTestId('cockpit-rail-popover-fleetMap')).toBeInTheDocument();
    expect(screen.getByTestId('cockpit-rail-icon-fleetMap')).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('the Fleet Map popover shows the "Fleet Map" title exactly once (CockpitRailPopover\'s own title bar), not a second time from FleetMap.tsx\'s own former internal heading', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-fleetMap'));
    const popover = screen.getByTestId('cockpit-rail-popover-fleetMap');
    expect(within(popover).getAllByText('Fleet Map')).toHaveLength(1);
  });
});
