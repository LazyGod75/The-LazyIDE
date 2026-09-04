/**
 * agentsStoreCrossProjectRelaunch.test.ts — coverage for the 2026-08-02
 * fix "queued missions in a project the user is not currently viewing
 * never start".
 *
 * Root cause: 6b57bed's boot-time relaunch (see recoveryReplay.test.ts's
 * own "queued-mission relaunch" describe block) only ever resolves and
 * reconciles ONE project — resolveProjectRoot()'s notion of "active" at
 * the moment agentsStore mounted — and never revisits it. A queued
 * mission belonging to any OTHER open project (AppContext.openProjects)
 * never got a schedulerDispatch call at all: real repro was three
 * projects open, only the active one's queue ever drained, five
 * "lazy-backoffice" missions frozen in 'queued' for hours across many
 * restarts while the user worked in a different project.
 *
 * This file exercises agentsStore.tsx's cross-project sweep effect
 * directly (relaunchQueuedMissionInOpenProject + its useEffect) —
 * useAppContextOptional is mocked (not the real AppProvider/project_list
 * invoke choreography) to supply openProjects deterministically, same
 * "mock only AppContext + agentsStore's own deps, never the logic under
 * test" convention useFleetMissions.test.tsx already establishes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { emitBuffered } from '../lib/journal/journal';
import { runMission } from '../lib/agents/runtime';
import { STALE_QUEUE_THRESHOLD_MS } from '../lib/agents/missionQueue';
import type { Mission } from '../lib/agents/types';

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

const { mockMissionsLoad, mockUseAppContextOptional } = vi.hoisted(() => ({
  mockMissionsLoad: vi.fn(),
  mockUseAppContextOptional: vi.fn(),
}));

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => {
      const real = actual.getPlatform();
      return {
        ...real,
        missions: { ...real.missions, load: mockMissionsLoad, save: vi.fn().mockResolvedValue(undefined) },
      };
    },
  };
});

// Only useAppContextOptional is imported by agentsStore.tsx from this
// module — mocking just that export keeps every OTHER consumer of
// AppContext (none in this file) untouched.
vi.mock('../app/AppContext', () => ({
  useAppContextOptional: mockUseAppContextOptional,
}));

const mockedInvoke = vi.mocked(invoke);
const mockedEmitBuffered = vi.mocked(emitBuffered);
const mockedRunMission = vi.mocked(runMission);

const ACTIVE_ROOT = 'C:/projects/LazySite-internet';
const ACTIVE_PROJECT_ID = 'c:/projects/lazysite-internet';
const OTHER_ROOT = 'C:/projects/lazy-backoffice';
const OTHER_PROJECT_ID = 'c:/projects/lazy-backoffice';

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(ToastProvider, null, React.createElement(AgentsStoreProvider, null, children)),
  );
}

interface MissionCurrentRowFixture {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

function missionRow(mission: Mission, projectId: string): MissionCurrentRowFixture {
  return {
    mission_id: mission.id,
    project_id: projectId,
    status: mission.status,
    data: JSON.stringify(mission),
    updated_ms: Date.now(),
  };
}

/** Wires up 'get_project_root' (the active project — resolveProjectRoot's
 *  boot-load path) and 'journal_missions_current' (branched by the
 *  requested projectId, so the active and "other" project can return
 *  different rows in the same test — the real per-project shape the
 *  cross-project sweep depends on). */
function stubTwoProjectJournals(
  activeRows: MissionCurrentRowFixture[],
  otherRows: MissionCurrentRowFixture[],
): void {
  mockedInvoke.mockImplementation((cmd: unknown, args?: unknown) => {
    if (cmd === 'get_project_root') return Promise.resolve(ACTIVE_ROOT);
    if (cmd === 'journal_missions_current') {
      const projectId = (args as { projectId?: string } | undefined)?.projectId;
      if (projectId === OTHER_PROJECT_ID) return Promise.resolve(otherRows);
      return Promise.resolve(activeRows);
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedInvoke.mockResolvedValue(undefined);
  mockMissionsLoad.mockResolvedValue(null);
  setTauriRuntime(true);
  // Faithful-enough runMission stand-in: the real one's very first act is
  // onUpdate({patch: {status: 'running'}}) (runtime.ts, before Step A) —
  // simulating that here (rather than just resolving silently) is what
  // lets these tests observe relaunchQueuedMissionInOpenProject's own
  // onUpdate -> journal-write wiring, not just "was runMission called".
  mockedRunMission.mockImplementation(async (mission, _repoPath, opts) => {
    opts.onUpdate({ id: mission.id, patch: { status: 'running' } });
  });
  mockUseAppContextOptional.mockReturnValue({
    openProjects: [
      { id: 'p-active', root: ACTIVE_ROOT, brainId: null, active: true },
      { id: 'p-other', root: OTHER_ROOT, brainId: null, active: false },
    ],
    activeProjectId: 'p-active',
  });
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('agentsStore — cross-project queued-mission relaunch (2026-08-02 fix)', () => {
  it('relaunches a queued mission belonging to a NON-active open project, not just the active one', async () => {
    const backofficeMission: Mission = {
      id: 'M14',
      title: 'Frozen in the closed project',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    stubTwoProjectJournals([], [missionRow(backofficeMission, OTHER_PROJECT_ID)]);

    renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(mockedRunMission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'M14' }),
        OTHER_ROOT,
        expect.objectContaining({ permissionMode: expect.any(String) }),
      );
    });

    // The relaunch must publish the running transition to THAT project's
    // own journal (never state.missions — see relaunchQueuedMissionInOpenProject's
    // doc comment) so the Cockpit's cross-project poll (journal-only for a
    // non-active project) actually reflects it.
    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mission.updated',
        projectId: OTHER_PROJECT_ID,
        missionId: 'M14',
        payload: expect.objectContaining({ mission: expect.objectContaining({ status: 'running' }) }),
      }),
    );
  });

  it('relaunches queued missions across MULTIPLE non-active open projects in the same sweep', async () => {
    mockUseAppContextOptional.mockReturnValue({
      openProjects: [
        { id: 'p-active', root: ACTIVE_ROOT, brainId: null, active: true },
        { id: 'p-other', root: OTHER_ROOT, brainId: null, active: false },
        { id: 'p-third', root: 'C:/projects/lazy-marketing', brainId: null, active: false },
      ],
      activeProjectId: 'p-active',
    });
    const backofficeMission: Mission = {
      id: 'M15',
      title: 'Backoffice queued',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    const marketingMission: Mission = {
      id: 'M3',
      title: 'Marketing queued',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    const thirdProjectId = 'c:/projects/lazy-marketing';
    mockedInvoke.mockImplementation((cmd: unknown, args?: unknown) => {
      if (cmd === 'get_project_root') return Promise.resolve(ACTIVE_ROOT);
      if (cmd === 'journal_missions_current') {
        const projectId = (args as { projectId?: string } | undefined)?.projectId;
        if (projectId === OTHER_PROJECT_ID) return Promise.resolve([missionRow(backofficeMission, OTHER_PROJECT_ID)]);
        if (projectId === thirdProjectId) return Promise.resolve([missionRow(marketingMission, thirdProjectId)]);
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });

    renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(mockedRunMission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'M15' }),
        OTHER_ROOT,
        expect.anything(),
      );
      expect(mockedRunMission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'M3' }),
        'C:/projects/lazy-marketing',
        expect.anything(),
      );
    });
  });

  it('does NOT relaunch a queueStale (24h+) queued mission in a non-active project, and stamps an honest statusReason instead', async () => {
    const staleMission: Mission = {
      id: 'M7',
      title: 'Queued over 24h ago, never started',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now() - (STALE_QUEUE_THRESHOLD_MS + 60_000),
    };
    stubTwoProjectJournals([], [missionRow(staleMission, OTHER_PROJECT_ID)]);

    renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(mockedEmitBuffered).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mission.updated',
          projectId: OTHER_PROJECT_ID,
          missionId: 'M7',
          payload: expect.objectContaining({
            mission: expect.objectContaining({ statusReason: expect.any(String) }),
          }),
        }),
      );
    });

    expect(mockedRunMission).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'M7' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('never queries a CLOSED project (not in openProjects) at all — no resurrection, no strand-flagging', async () => {
    // Only the active + "other" (open) projects are wired up — a THIRD,
    // closed project's journal is never even asked for, by construction
    // (the sweep only ever iterates appContext.openProjects).
    const backofficeMission: Mission = {
      id: 'M16',
      title: 'Open project queued mission',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    stubTwoProjectJournals([], [missionRow(backofficeMission, OTHER_PROJECT_ID)]);

    renderHook(() => useAgentsStore(), { wrapper });

    await waitFor(() => {
      expect(mockedRunMission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'M16' }),
        OTHER_ROOT,
        expect.anything(),
      );
    });

    const closedProjectId = 'c:/projects/lazy-closed-project';
    const queriedProjectIds = mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === 'journal_missions_current')
      .map(([, args]) => (args as { projectId?: string } | undefined)?.projectId);
    expect(queriedProjectIds).not.toContain(closedProjectId);
  });

  it('respects the active-project boundary: the ACTIVE project keeps going through the existing state.missions path, not this cross-project one', async () => {
    const activeQueuedMission: Mission = {
      id: 'M60',
      title: 'Active project queued mission',
      status: 'queued',
      model: 'Sonnet 4.6',
      createdAt: Date.now(),
    };
    stubTwoProjectJournals([missionRow(activeQueuedMission, ACTIVE_PROJECT_ID)], []);

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    // The pre-existing (6b57bed) boot relaunch path still owns the active
    // project: the mission surfaces in state.missions (untouched by this
    // fix) and still reaches runMission through the SAME call.
    await waitFor(() => {
      expect(result.current.missions.some((m) => m.id === 'M60')).toBe(true);
    });
    await waitFor(() => {
      expect(mockedRunMission).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'M60' }),
        ACTIVE_ROOT,
        expect.anything(),
      );
    });
  });
});
