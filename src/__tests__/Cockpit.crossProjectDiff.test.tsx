/**
 * Cockpit.crossProjectDiff.test.tsx — round-2 fix for the "Diff does
 * nothing" report (2026-08-14): a grace-period-then-toast alone still left
 * the user without their diff, which is the actual thing they clicked for.
 * Cockpit.tsx's handleUrgentAction now actively re-fetches the mission from
 * the SAME real source the fleet signal came from (loadMissionsFromJournal,
 * keyed by the mission's own project) whenever it is not already in
 * agentsStore's own `missions`, and broadcasts the result via
 * 'mission:crossProjectLoaded' (see bus.ts's own doc comment) so
 * AgentsSpace.tsx can render the REAL drawer without a second click.
 *
 * This file proves the PRODUCER side (Cockpit.tsx): the fetch fires with
 * the right project id, and the broadcast carries the real mission. The
 * CONSUMER side (AgentsSpace.tsx applying the broadcast to open the drawer,
 * and the last-resort toast when nothing is ever found) is covered by
 * AgentsSpace.deadSelection.test.tsx.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider, Cockpit } from '../components/agents';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import { on } from '../lib/bus';
import type { MissionCrossProjectLoaded } from '../lib/bus';
import type { Mission } from '../lib/agents/types';
import type { FleetProject, UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import { installReactFlowTestEnv } from './canvasTestEnv';
import { loadMissionsFromJournal } from '../lib/journal/missionsProjection';

installReactFlowTestEnv();

vi.mock('../lib/journal/missionsProjection', () => ({
  loadMissionsFromJournal: vi.fn(),
}));

const ROOT = '/fixtures/uc-smoke-b';
const PROJECT_ID = 'uc-smoke-b';

// Mirrors managerSignals.ts's real shape for a 'review' mission that is
// visible to the fleet's cross-project journal poll but NOT (yet) in
// agentsStore's own single-active-project `missions` — exactly the gap
// fleetMissions.ts's own doc comment documents.
const REVIEW_PROJECT: FleetProject = {
  projectId: PROJECT_ID,
  root: ROOT,
  name: 'uc-smoke-b',
  missions: [
    {
      id: 'M2',
      title: 'Smoke mission',
      status: 'review',
      stage: 'review',
      model: 'sonnet',
      updatedMs: Date.now() - 60_000,
      urgent: true,
    },
  ],
};

const FLEET_OVERRIDE: UseFleetMissionsResult = { projects: [REVIEW_PROJECT], loading: false, error: null };

const REAL_M2: Mission = {
  id: 'M2',
  title: 'Smoke mission',
  status: 'review',
  model: 'sonnet',
  repo: '.',
  worktree: 'agent/m2',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  actionTimeline: [{ time: '10:00', text: 'did the work' }],
  diffSnippet: [{ file: 'src/foo.ts', hunk: '+ real line-level diff content' }],
} as unknown as Mission;

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
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('Cockpit — fleet-signal Diff actively fetches the real mission on demand', () => {
  it('clicking Diff for a mission not yet in agentsStore fetches it from its own project journal and broadcasts the real Mission', async () => {
    vi.mocked(loadMissionsFromJournal).mockResolvedValue([REAL_M2]);

    const broadcasts: MissionCrossProjectLoaded[] = [];
    const unsub = on('mission:crossProjectLoaded', (payload) => broadcasts.push(payload));

    renderCockpit();
    fireEvent.click(await screen.findByTestId('mission-node-action-M2-diff'));

    // loadMissionsFromJournal is called with THIS mission's own project id
    // — the same source the fleet signal itself came from.
    expect(loadMissionsFromJournal).toHaveBeenCalledWith(PROJECT_ID);

    // Broadcast lands once the fetch resolves, carrying the REAL Mission
    // (transcript + line-level diff content — not a degraded projection).
    await vi.waitFor(() => expect(broadcasts).toHaveLength(1));
    expect(broadcasts[0]).toEqual({ missionId: 'M2', mission: REAL_M2 });

    unsub();
  });

  it('never broadcasts when the journal genuinely has nothing for that mission (last-resort path stays the exception)', async () => {
    vi.mocked(loadMissionsFromJournal).mockResolvedValue([]);

    const broadcasts: MissionCrossProjectLoaded[] = [];
    const unsub = on('mission:crossProjectLoaded', (payload) => broadcasts.push(payload));

    renderCockpit();
    fireEvent.click(await screen.findByTestId('mission-node-action-M2-diff'));

    await vi.waitFor(() => expect(loadMissionsFromJournal).toHaveBeenCalled());
    // Give any stray microtask a chance to run, then confirm nothing fired.
    await new Promise((r) => setTimeout(r, 10));
    expect(broadcasts).toHaveLength(0);

    unsub();
  });
});
