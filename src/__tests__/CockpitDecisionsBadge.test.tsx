/**
 * CockpitDecisionsBadge.test.tsx — regression coverage for the phantom "2"
 * badge (real user report, 2026-08-14): the Decisions rail badge read
 * `countPendingDecisions(fleet.projects)` (real urgent missions —
 * permission/failed/review, cockpitHelpers.ts's rankUrgentMissions) while
 * the popover it opened (DecisionCenter) read
 * `orchestrators.filter(status === 'blocked')` — an unrelated collection
 * this codebase barely ever populates. The badge said "2", the panel said
 * "No pending decisions." Root-caused as a different-source divergence
 * (NOT the earlier `lastSeenAt` stale-default bug class — see this repo's
 * BrainTimeline.tsx fix for that one) and fixed by having both the badge
 * and the panel render the SAME `RankedUrgentMission[]` array
 * (Cockpit.tsx's `ranked`, threaded into CockpitLeftRail as
 * `urgentMissions`) — one selector, two views, provably in agreement.
 *
 * Mounts the real <Cockpit/> tree (same fixture-override seam every other
 * Cockpit.*.test.tsx file uses) so this exercises the actual wiring, not a
 * re-implementation of it.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider, Cockpit } from '../components/agents';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import type { FleetProject, UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';

installReactFlowTestEnv();

const ROOT_A = '/fixtures/project-a';
const ROOT_B = '/fixtures/project-b';

const TWO_URGENT_PROJECTS: FleetProject[] = [
  {
    projectId: 'project-a',
    root: ROOT_A,
    name: 'project-a',
    missions: [
      {
        id: 'm-review',
        title: 'Review-ready mission',
        status: 'review',
        stage: 'review',
        model: 'sonnet',
        updatedMs: Date.now() - 60_000,
        urgent: true,
        judgeVerdict: { score: 95, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() },
      },
    ],
  },
  {
    projectId: 'project-b',
    root: ROOT_B,
    name: 'project-b',
    missions: [
      {
        id: 'm-failed',
        title: 'Failed mission',
        status: 'failed',
        stage: 'code',
        model: 'sonnet',
        updatedMs: Date.now() - 30_000,
        urgent: true,
        statusReason: 'lint failed',
      },
    ],
  },
];

function renderCockpit(fleetOverride: UseFleetMissionsResult, activeProjectRootOverride: string) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <ManagerHostRegistryProvider>
              <Cockpit
                onOpenLibrary={() => {}}
                onOpenReport={() => {}}
                fleetOverride={fleetOverride}
                activeProjectRootOverride={activeProjectRootOverride}
              />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('Cockpit — Decisions rail badge and popover share one source (phantom-badge fix)', () => {
  it('badge count equals the number of urgent-mission cards rendered in the popover', async () => {
    renderCockpit({ projects: TWO_URGENT_PROJECTS, loading: false, error: null }, ROOT_A);

    const badge = await screen.findByTestId('cockpit-rail-badge-decisions');
    expect(badge).toHaveTextContent('2');

    fireEvent.click(screen.getByTestId('cockpit-rail-icon-decisions'));
    const popover = await screen.findByTestId('cockpit-rail-popover-decisions');

    // Every urgent mission from the fixture — and ONLY those — is rendered,
    // matching the badge's own count exactly (same array, not two numbers
    // that merely happen to agree).
    expect(within(popover).getByTestId('urgent-card-m-review')).toBeInTheDocument();
    expect(within(popover).getByTestId('urgent-card-m-failed')).toBeInTheDocument();
    expect(within(popover).getAllByTestId(/^urgent-card-/)).toHaveLength(2);

    // The old, disconnected empty-state text must never appear alongside
    // real cards — DecisionCenter renders cards or nothing, never a
    // leftover "no pending decisions" line (task 3, redundant empty state).
    expect(within(popover).queryByText(/no pending decisions/i)).not.toBeInTheDocument();
  });

  it('zero case: no badge is rendered, and the popover shows no urgent-mission cards', async () => {
    const EMPTY_PROJECT: FleetProject = { projectId: 'project-a', root: ROOT_A, name: 'project-a', missions: [] };
    renderCockpit({ projects: [EMPTY_PROJECT], loading: false, error: null }, ROOT_A);

    // Real, honest badge convention (RailIconButton's own doc comment):
    // omitted entirely when there is nothing to report, never a fabricated
    // "0".
    expect(screen.queryByTestId('cockpit-rail-badge-decisions')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cockpit-rail-icon-decisions'));
    const popover = await screen.findByTestId('cockpit-rail-popover-decisions');

    expect(within(popover).queryAllByTestId(/^urgent-card-/)).toHaveLength(0);
    // One clear empty state (GraphRunPanel's own honest guidance), not a
    // second redundant "No pending decisions." message stacked under it.
    expect(within(popover).queryByText(/no pending decisions/i)).not.toBeInTheDocument();
    expect(within(popover).getByText(/execute a plan via lazymanager/i)).toBeInTheDocument();
  });
});
