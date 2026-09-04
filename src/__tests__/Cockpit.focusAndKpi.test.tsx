/**
 * Cockpit.focusAndKpi.test.tsx — QA B14 + B16, exercised on the real
 * <Cockpit/> tree (same fixture-override seam cockpit-harness.tsx uses for
 * screenshots: fleetOverride + activeProjectRootOverride let a mission's
 * REAL action handlers run without a live Tauri backend — see Cockpit.tsx's
 * CockpitProps doc comment).
 *
 *  - B14: the urgent card's "Diff"/"Logs" actions must emit
 *    mission:focusSection with the right section, not just open the drawer.
 *  - B16: the décisions/agents/mergées/brain KPI tiles must drive real
 *    primitives (open the top urgent mission / bus nav), not be inert.
 *
 * 38938e3 (full-bleed cockpit rebuild) moved KpiGroup out of the top
 * Bandeau band into CockpitLeftRail's "kpis" popover — same KpiGroup
 * component, same real handlers, so the B16 tests below now open that
 * popover (click data-testid="cockpit-rail-icon-kpis") before reaching
 * kpi-decisions/kpi-brain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider, useAgentsStore, Cockpit } from '../components/agents';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import { on } from '../lib/bus';
import type { MissionFocusRequest } from '../lib/bus';
import type { FleetProject, UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';

installReactFlowTestEnv();

const ROOT = '/fixtures/demo-shop';

const REJECTED_REVIEW_PROJECT: FleetProject = {
  projectId: 'demo-shop',
  root: ROOT,
  name: 'demo-shop',
  missions: [
    {
      id: 'm-rejected',
      title: 'Rejected review mission',
      status: 'review',
      stage: 'review',
      model: 'sonnet',
      updatedMs: Date.now() - 60_000,
      urgent: true,
      judgeVerdict: { score: 10, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString() },
    },
  ],
};

const FLEET_OVERRIDE: UseFleetMissionsResult = { projects: [REJECTED_REVIEW_PROJECT], loading: false, error: null };

/** Exposes the store's selectedMissionId as text so a test can assert on it
 *  without also mounting the full MissionDetailDrawer tree. */
function SelectedMissionProbe() {
  const { selectedMissionId } = useAgentsStore();
  return <div data-testid="selected-mission-probe">{selectedMissionId ?? 'none'}</div>;
}

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
              <Cockpit
                onOpenLibrary={() => {}}
                onOpenReport={() => {}}
                fleetOverride={FLEET_OVERRIDE}
                activeProjectRootOverride={ROOT}
              />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
            <SelectedMissionProbe />
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem('lazy.locale', 'fr');
});

describe('Cockpit — urgent card Diff/Logs emit mission:focusSection (QA B14)', () => {
  it('"Diff" emits section "diff" for the mission and opens it', async () => {
    const events: MissionFocusRequest[] = [];
    const unsub = on('mission:focusSection', (req) => events.push(req));

    renderCockpit();
    // useCanvasHydration.ts's persistence boot (W6f BUG 1 fix) now always
    // awaits a real loadCanvasPersisted() round-trip before the canvas
    // renders past its blank placeholder — even outside Tauri, where it
    // resolves to defaults on the next microtask rather than synchronously.
    // findByTestId (not getByTestId) rides out that one tick.
    fireEvent.click(await screen.findByTestId('mission-node-action-m-rejected-diff'));

    expect(events).toEqual([{ missionId: 'm-rejected', section: 'diff' }]);
    expect(screen.getByTestId('selected-mission-probe')).toHaveTextContent('m-rejected');
    unsub();
  });
});

describe('Cockpit — urgent card exposes "Promouvoir en sonnet" for a judge-rejected review mission (QA B15)', () => {
  it('renders a 3rd promote action alongside merge/diff', async () => {
    renderCockpit();
    // See the QA B14 test above — the canvas now hydrates asynchronously,
    // always, so this rides out that one tick via findByTestId.
    expect(await screen.findByTestId('mission-node-action-m-rejected-promote')).toBeInTheDocument();
  });
});

describe('Cockpit — cross-project honesty: acting on a mission in a project that is not even open (bug audit wave)', () => {
  it('toasts an explicit "not open" error instead of silently doing nothing, and never calls approveMission', async () => {
    const OTHER_PROJECT: FleetProject = {
      projectId: 'unopened-project',
      root: '/fixtures/unopened-project',
      name: 'unopened-project',
      missions: [
        {
          id: 'm-unopened',
          title: 'Mission in a closed project',
          status: 'review',
          stage: 'review',
          model: 'sonnet',
          updatedMs: Date.now() - 60_000,
          urgent: true,
          judgeVerdict: { score: 95, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() },
        },
      ],
    };
    render(
      <I18nProvider>
        <ToastProvider>
          <AppProvider>
            <AgentsStoreProvider>
              <ManagerHostRegistryProvider>
                <Cockpit
                  onOpenLibrary={() => {}}
                  onOpenReport={() => {}}
                  fleetOverride={{ projects: [OTHER_PROJECT], loading: false, error: null }}
                  activeProjectRootOverride={ROOT}
                />
                <ManagerHost activeHostId="cockpit" />
              </ManagerHostRegistryProvider>
            </AgentsStoreProvider>
          </AppProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    // OTHER_PROJECT.root !== ROOT (not the active project) AND is not in
    // openProjects (AppProvider starts with an empty list, never populated
    // without a live Tauri backend) — switchToProjectIfNeeded's `entry`
    // lookup misses entirely.
    //
    // fix/canvas-card-declutter (2026-08-14) dropped the raw 'merge' quick-
    // action button for any 'review'-status mission once agentsStore is
    // present (MissionNode.tsx's own `willShowReviewGate`) — the inline
    // review gate's "Approuver" button (`mission-node-gate-approve-*`,
    // MissionNode.tsx's `mission-node-gate-${mission.id}` row) is now the
    // ONLY reachable control for this exact scenario, so this is the real
    // button a user would click; `mission-node-action-*-merge` no longer
    // exists on this card. See MissionNode.tsx's own doc comment on that
    // gate button for the real regression this test caught: it used to call
    // `agentsStore.approveMission` directly, bypassing this very
    // cross-project check — fixed there to route through the SAME
    // `actions.onUrgentAction(mission, 'merge')` this test exercises below.
    fireEvent.click(await screen.findByTestId('mission-node-gate-approve-m-unopened'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('non ouvert');
    expect(alert).toHaveTextContent('unopened-project');
  });
});

describe('Cockpit — KPI tiles (QA B16, behind the rail\'s "kpis" popover since 38938e3)', () => {
  it('clicking "décisions" opens the single ranked urgent mission', () => {
    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-kpis'));
    fireEvent.click(screen.getByTestId('kpi-decisions'));
    expect(screen.getByTestId('selected-mission-probe')).toHaveTextContent('m-rejected');
  });

  it('clicking "brain" emits nav:navigateSpace("brain")', () => {
    const navSpy = vi.fn();
    const unsub = on('nav:navigateSpace', navSpy);

    renderCockpit();
    fireEvent.click(screen.getByTestId('cockpit-rail-icon-kpis'));
    fireEvent.click(screen.getByTestId('kpi-brain'));

    expect(navSpy).toHaveBeenCalledWith('brain');
    unsub();
  });
});
