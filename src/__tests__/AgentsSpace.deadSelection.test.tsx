/* AgentsSpace.deadSelection.test.tsx — regression coverage for the real
   packaged-app "Diff does nothing" report (2026-08-14): the manager rail's
   fleet-signal Diff/Logs buttons (and the canvas node's own action row) set
   `selectedMissionId` via Cockpit.tsx's handleUrgentAction using a mission
   sourced from `fleet.projects` (useFleetMissions' cross-project journal
   poll) — a DIFFERENT source than AgentsSpace.tsx's own `missions`
   (agentsStore's single-active-project list), which `selectedMission` looks
   the id up against before rendering MissionDetailDrawer. See
   fleetMissions.ts's own module doc comment for the documented gap:
   agentsStore's own mission list "is not re-loaded when the active project
   changes after AgentsSpace first mounts".

   Round 2 (code review): a grace-period-then-toast alone still left the
   user without their diff — the thing they actually clicked for. The real
   fix is on the PRODUCER side (Cockpit.tsx actively re-fetches the mission
   via loadMissionsFromJournal and broadcasts it as 'mission:crossProjectLoaded'
   — see Cockpit.crossProjectDiff.test.tsx for that half). This file covers
   the CONSUMER side: AgentsSpace.tsx renders the drawer the instant that
   broadcast lands (no toast, no delay), and the grace-period toast survives
   only as the last-resort path for a mission that is broadcast NEVER (the
   journal genuinely has nothing for it) — proven locale-agnostically (the
   app's i18n default in this test env is English, not French).

   Cockpit is stubbed here (same convention as reportBusDeepLink.test.tsx —
   a real Cockpit needs a full ReactFlow canvas env unrelated to this fix)
   with two buttons standing in for its real handleUrgentAction call sites:
   one sets a ghost id (mirrors a stale cross-project mission), the other
   seeds + selects a genuinely local one (mirrors the ordinary same-project
   path, proving this fix adds no regression there). The cross-project
   broadcast itself is simulated directly via the real bus (`emit`), exactly
   as Cockpit.tsx's own async fetch would fire it. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AgentsUiProvider, AgentsStoreProvider } from '../components/agents';
import { emit } from '../lib/bus';
import type { Mission } from '../lib/agents/types';

vi.mock('../app/AppContext', () => {
  const fixture = {
    projectRoot: '/fixtures/demo-project',
    openProjects: [{ id: 'p1', root: '/fixtures/demo-project', brainId: null, active: true }],
    activeProjectId: 'p1',
    switchProject: vi.fn(),
  };
  return {
    useAppContext: () => fixture,
    useAppContextOptional: () => fixture,
  };
});

vi.mock('../components/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents')>();
  return {
    ...actual,
    // Stands in for the REAL Cockpit's handleUrgentAction 'diff'/'logs'
    // cases (Cockpit.tsx) — both real call sites set selectedMissionId
    // optimistically, from an id that may not (yet) be in agentsStore's own
    // `missions`, exactly what "select ghost" simulates. The real
    // Cockpit.tsx also fires an active loadMissionsFromJournal fetch on
    // that same path (see Cockpit.crossProjectDiff.test.tsx) — this stub
    // leaves that half out deliberately, so this file can drive its arrival
    // (or non-arrival) explicitly via the real bus below.
    Cockpit: () => {
      const { setSelectedMissionId, addMission } = actual.useAgentsStore();
      return (
        <div data-testid="cockpit-stub">
          <button
            data-testid="select-ghost-mission"
            onClick={() => setSelectedMissionId('ghost-mission-id')}
          >
            select ghost
          </button>
          <button
            data-testid="select-real-mission"
            onClick={() => {
              void (async () => {
                const id = await addMission({
                  title: 'Real local mission',
                  repo: '.',
                  worktree: '',
                  modelLabel: 'sonnet',
                  orchestrator: false,
                });
                setSelectedMissionId(id);
              })();
            }}
          >
            select real
          </button>
        </div>
      );
    },
  };
});

vi.mock('../components/agents/library/AgentLibrary', () => ({
  AgentLibrary: () => <div data-testid="library-stub" />,
}));

vi.mock('../components/agents/report', () => ({
  ProjectReportPage: () => <div data-testid="report-page-stub" />,
}));

// Imported AFTER the mocks above so AgentsSpace picks up the stubbed Cockpit.
import { AgentsSpace } from '../spaces/AgentsSpace';

function renderSpace() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AgentsUiProvider>
          <AgentsStoreProvider>
            <AgentsSpace />
          </AgentsStoreProvider>
        </AgentsUiProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

const CROSS_PROJECT_MISSION: Mission = {
  id: 'ghost-mission-id',
  title: 'Cross-project mission',
  status: 'review',
  model: 'sonnet',
  repo: '.',
  worktree: 'agent/ghost',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as unknown as Mission;

describe('AgentsSpace — dead selectedMissionId honesty fix (real user report, 2026-08-14)', () => {
  it('a selectedMissionId that never gets broadcast never opens the drawer, but does NOT stay silent forever: it toasts and clears (last-resort path only)', async () => {
    vi.useFakeTimers();
    try {
      renderSpace();
      fireEvent.click(screen.getByTestId('select-ghost-mission'));

      // Grace period: within the window, honestly nothing yet — this is the
      // legitimate "the active fetch is still in flight" state, not the bug.
      expect(screen.queryByTestId('mission-detail-overlay')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });

      // NEVER DEGRADE IN SILENCE: past the grace period, with nothing ever
      // broadcast, a real, visible error — never just nothing. Assertion is
      // locale-agnostic (the mission id, not a hardcoded-language string —
      // see this suite's own header comment on why).
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('ghost-mission-id');
      expect(screen.queryByTestId('mission-detail-overlay')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a mission:crossProjectLoaded broadcast (Cockpit.tsx\'s real active fetch landing) opens the drawer immediately, with no error toast', async () => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.useFakeTimers();
    try {
      renderSpace();
      fireEvent.click(screen.getByTestId('select-ghost-mission'));

      // Well within the grace period — simulates the fetch resolving fast
      // (the whole point of the round-2 fix: no multi-second wait needed).
      await act(async () => {
        emit('mission:crossProjectLoaded', { missionId: 'ghost-mission-id', mission: CROSS_PROJECT_MISSION });
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(screen.getByTestId('mission-detail-overlay')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // And the grace-period timer that was pending never fires an error
      // for a selection that has since resolved.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('mission-detail-overlay')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a genuinely local mission still opens the real MissionDetailDrawer, with no error toast (no regression)', async () => {
    // jsdom does not implement scrollIntoView (same stub convention as
    // MissionDetail.test.tsx) — MissionDetailTranscript's own mount effect
    // calls it unconditionally.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    renderSpace();
    fireEvent.click(screen.getByTestId('select-real-mission'));

    // addMission resolves through a real resolveProjectRoot() fallback
    // chain (no live Tauri backend here), which can take longer than
    // findByTestId's default 1s window.
    expect(await screen.findByTestId('mission-detail-overlay', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('MissionDetailDrawer exposes role="dialog" + aria-modal (accessibility fix)', async () => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    renderSpace();
    fireEvent.click(screen.getByTestId('select-real-mission'));

    const panel = await screen.findByTestId('mission-detail-panel', {}, { timeout: 5000 });
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-label')).toBeTruthy();
  });
});
