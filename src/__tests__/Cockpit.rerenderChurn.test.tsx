/**
 * Cockpit.rerenderChurn.test.tsx — perf audit 2026-08-15, item 3.
 *
 * MEASURES (not asserts-by-assumption) the effect of wrapping
 * CanvasView/CockpitLeftRail/ManagerOverlay in `React.memo()`, using the
 * render-count diagnostic in src/lib/perf/renderCounters.ts (same
 * "diagnostic marker read from a test" convention as byokProviders.ts's
 * `window.__lazyByokVaultReady`).
 *
 * Two scenarios, same mounted tree:
 *
 *  1. A REAL, representative Cockpit-local-only state change: clicking the
 *     "agents" KPI tile (CockpitLeftRail's kpis popover) calls Cockpit's
 *     own `setRunningPulseActive`, which only ever feeds `highlightIds` —
 *     a prop CanvasView alone receives (Cockpit.tsx: `highlightIds` is
 *     passed to `<CanvasView>` only, never to CockpitLeftRail/ManagerOverlay).
 *     This re-renders Cockpit itself (and legitimately CanvasView, since
 *     `highlightIds` really did change), WITHOUT touching AgentsStoreProvider/
 *     AppProvider/etc above it — the same shape a real "unrelated Cockpit
 *     state changed" re-render takes in production. `memo` should let
 *     CockpitLeftRail/ManagerOverlay skip this entirely.
 *
 *     (An earlier version of this test forced a re-render via RTL's
 *     `rerender()` on the WHOLE provider tree, which also re-executes
 *     AgentsStoreProvider/AppProvider/etc — that measured a strictly worse,
 *     unrepresentative number, since it also exercises whatever reference
 *     churn those OTHER providers have on their own context values,
 *     something no real Cockpit-local state change would ever trigger.
 *     Dropped in favor of this realistic, UI-driven scenario.)
 *
 *  2. `fleetOverride` itself changes to a NEW object with equivalent
 *     content — simulating what a real ~2.5s fleet-poll tick does
 *     (useFleetMissions/fleetMissions.ts hands back a fresh `projects`
 *     array every tick regardless of whether the data changed — see that
 *     file's own doc comment, untouched by this change). All three
 *     legitimately DO re-render here, `memo` or not — asserted here as an
 *     honest control, not swept under the rug.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider, Cockpit } from '../components/agents';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import type { FleetProject, UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import { getRenderCount, resetRenderCountsForTests } from '../lib/perf/renderCounters';
import { installReactFlowTestEnv } from './canvasTestEnv';

installReactFlowTestEnv();

const ROOT = '/fixtures/rerender-churn';

function makeFleetOverride(): UseFleetMissionsResult {
  const project: FleetProject = {
    projectId: 'rerender-churn',
    root: ROOT,
    name: 'rerender-churn',
    missions: [
      {
        id: 'm-1',
        title: 'Steady mission',
        status: 'running',
        stage: 'code',
        model: 'sonnet',
        updatedMs: Date.now() - 10_000,
        urgent: false,
      },
    ],
  };
  return { projects: [project], loading: false, error: null };
}

const COMPONENTS = ['CanvasView', 'CockpitLeftRail', 'ManagerOverlay'] as const;

function renderCounts(): Record<(typeof COMPONENTS)[number], number> {
  return {
    CanvasView: getRenderCount('CanvasView'),
    CockpitLeftRail: getRenderCount('CockpitLeftRail'),
    ManagerOverlay: getRenderCount('ManagerOverlay'),
  };
}

function Harness({ fleetOverride }: { fleetOverride: UseFleetMissionsResult }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <ManagerHostRegistryProvider>
              <Cockpit
                onOpenLibrary={() => {}}
                onOpenReport={() => {}}
                fleetOverride={fleetOverride}
                activeProjectRootOverride={ROOT}
              />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  localStorage.setItem('lazy.locale', 'fr');
  resetRenderCountsForTests();
});

describe('Cockpit render churn — memo(CanvasView/CockpitLeftRail/ManagerOverlay), measured', () => {
  it('a Cockpit-local-only state change (agents KPI pulse) does NOT re-render CockpitLeftRail/ManagerOverlay (CanvasView legitimately does, via highlightIds)', async () => {
    const stableFleet = makeFleetOverride();
    const { findByText, getByTestId } = render(<Harness fleetOverride={stableFleet} />);
    await findByText('Steady mission');

    // Open the kpis popover first (CockpitLeftRail's OWN internal state —
    // its render count is expected to move here, not part of what this
    // test measures) and let it settle before taking the baseline.
    fireEvent.click(getByTestId('cockpit-rail-icon-kpis'));
    await findByText('Steady mission');

    const baseline = renderCounts();
    expect(baseline.CanvasView).toBeGreaterThanOrEqual(1);
    expect(baseline.CockpitLeftRail).toBeGreaterThanOrEqual(1);
    expect(baseline.ManagerOverlay).toBeGreaterThanOrEqual(1);

    // The measured action: click "agents" — Cockpit's own
    // handleAgentsKpiClick -> setRunningPulseActive(true) -> Cockpit
    // re-renders. That state ONLY feeds `highlightIds` (CanvasView-only
    // prop) — see this file's header comment.
    fireEvent.click(getByTestId('kpi-agents'));
    await findByText('Steady mission');

    const afterPulseClick = renderCounts();

    // eslint-disable-next-line no-console
    console.info(
      '[perf] Cockpit re-render churn (real UI action: agents KPI click, Cockpit-local state only): ' +
        `baseline=${JSON.stringify(baseline)} after=${JSON.stringify(afterPulseClick)}`,
    );

    // CanvasView legitimately re-renders (highlightIds really changed).
    expect(afterPulseClick.CanvasView).toBeGreaterThan(baseline.CanvasView);
    // CockpitLeftRail/ManagerOverlay's own props did not change — memo must
    // let them skip this render entirely.
    expect(afterPulseClick.CockpitLeftRail).toBe(baseline.CockpitLeftRail);
    expect(afterPulseClick.ManagerOverlay).toBe(baseline.ManagerOverlay);
  });

  it('DOES re-render all three when fleetOverride changes reference (honest control — this is what a real ~2.5s poll tick does, memo or not)', async () => {
    const { rerender, findByText } = render(<Harness fleetOverride={makeFleetOverride()} />);
    await findByText('Steady mission');
    const afterMount = renderCounts();

    // A NEW object, equivalent content — same shape useFleetMissions hands
    // back on every poll tick regardless of whether the underlying mission
    // data changed (fleetMissions.ts's `rows`/`projects` useMemo recomputes
    // on every fresh journal_missions_current query result).
    rerender(<Harness fleetOverride={makeFleetOverride()} />);
    await findByText('Steady mission');
    const afterPollLikeChange = renderCounts();

    // eslint-disable-next-line no-console
    console.info(
      '[perf] Cockpit re-render churn (new fleetOverride reference, simulating one poll tick): ' +
        `mount=${JSON.stringify(afterMount)} after=${JSON.stringify(afterPollLikeChange)}`,
    );

    for (const name of COMPONENTS) {
      expect(afterPollLikeChange[name]).toBeGreaterThan(afterMount[name]);
    }
  });
});
