/**
 * CockpitRailPopover.dismissal.test.tsx — founder bug fix: "quand j'ouvre un
 * des boutons du canva comme KPI impossible à refermer, je devrais pouvoir
 * le refermer en recliquant dessus ou en cliquant à côté."
 *
 * Proves the real, wired-up <Cockpit> tree (same harness as
 * Cockpit.layout.test.tsx/Cockpit.focusAndKpi.test.tsx) now closes the
 * rail's "kpis" popover all three ways: re-clicking its own rail icon,
 * clicking anywhere outside, and Escape. The other four rail icons
 * (fleetMap/objectives/decisions/budget) share the exact same
 * CockpitLeftRail/CockpitRailPopover wiring (openId + activeTriggerRef), so
 * this one popover stands in for all of them.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

installReactFlowTestEnv();

const EMPTY_FLEET: UseFleetMissionsResult = { projects: [], loading: false, error: null };

function renderCockpit() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            {/* Cockpit's ManagerOverlay registers into managerHostRegistry
                instead of instantiating <LazyManager> directly — see
                managerHostRegistry.tsx. Reproduced here (normally provided
                once by AppShell.tsx) so the real Cockpit tree still gets a
                rendered LazyManager. */}
            <ManagerHostRegistryProvider>
              <Cockpit onOpenLibrary={() => {}} onOpenReport={() => {}} fleetOverride={EMPTY_FLEET} objectivesOverride={[]} managerMessagesOverride={[]} />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('CockpitLeftRail — "kpis" popover dismissal (founder bug fix)', () => {
  it('opens on click', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-kpis'));
    expect(screen.getByTestId('cockpit-rail-popover-kpis')).toBeInTheDocument();
  });

  it('re-clicking the same rail icon while open closes it (does not reopen)', () => {
    renderCockpit();
    const icon = screen.getByTestId('cockpit-rail-icon-kpis');

    fireEvent.click(icon);
    expect(screen.getByTestId('cockpit-rail-popover-kpis')).toBeInTheDocument();

    // Real browsers fire pointerdown before click for a single re-click —
    // fire both explicitly (fireEvent.click alone can't reproduce the race
    // this is guarding against, see useDismissable.test.tsx).
    fireEvent.pointerDown(icon);
    fireEvent.click(icon);

    expect(screen.queryByTestId('cockpit-rail-popover-kpis')).not.toBeInTheDocument();
  });

  it('clicking outside the popover closes it', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-kpis'));
    expect(screen.getByTestId('cockpit-rail-popover-kpis')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('cockpit-rail-popover-kpis')).not.toBeInTheDocument();
  });

  it('pressing Escape closes it', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-kpis'));
    expect(screen.getByTestId('cockpit-rail-popover-kpis')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('cockpit-rail-popover-kpis')).not.toBeInTheDocument();
  });

  it('clicking a DIFFERENT rail icon while one is open switches to the new popover instead of leaving both/neither open', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-kpis'));
    expect(screen.getByTestId('cockpit-rail-popover-kpis')).toBeInTheDocument();

    const budgetIcon = screen.getByTestId('cockpit-rail-icon-budget');
    fireEvent.pointerDown(budgetIcon);
    fireEvent.click(budgetIcon);

    expect(screen.queryByTestId('cockpit-rail-popover-kpis')).not.toBeInTheDocument();
    expect(screen.getByTestId('cockpit-rail-popover-budget')).toBeInTheDocument();
  });
});
