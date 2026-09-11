/* useFleetMissions — hook-level reactivity lock (fix/canvas-ux R4f defect:
   "0 actifs" zone-header lag).

   fleetMissions.test.ts already proves `mergeLiveMissions` itself (the pure
   function) merges live-over-journal correctly. reconciler.test.ts already
   proves `computeZoneLayout`'s `counts.running` is a pure, fresh derivation
   of whatever `zone.missions` it receives. Neither test exercises the ACTUAL
   `useFleetMissions()` hook wiring those two together across a real React
   render — this file closes that gap: it renders the hook itself (mocking
   only AppContext + agentsStore's context, never fleetMissions.ts's own
   logic) and proves a mission that exists ONLY in the live agentsStore
   (no journal row at all yet — the honest shape of a brand-new mission the
   2.5s poll hasn't flushed) is reflected as `running` in `FleetProject.missions`
   on the very next render, with NO second poll tick required.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useFleetMissions } from '../lib/agents/fleetMissions';
import { setApprovalMode, _resetApprovalModesForTests } from '../lib/agents/approvalMode';
import type { Mission } from '../lib/agents/types';

// invoke is globally mocked in setup.ts (vi.mock('@tauri-apps/api/core', ...))
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

// vi.mock factories are hoisted above module-level code — mock fns they
// reference must be created via vi.hoisted (TDZ otherwise), same pattern
// agentsStore.test.tsx's brain-mock block already uses.
const { mockUseAppContext, mockUseAgentsStoreOptional } = vi.hoisted(() => ({
  mockUseAppContext: vi.fn(),
  mockUseAgentsStoreOptional: vi.fn(),
}));

vi.mock('../app/AppContext', () => ({
  useAppContext: mockUseAppContext,
}));

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: mockUseAgentsStoreOptional,
  // useFleetMissions reads the missions-only context now — derive it from
  // the same per-test mock so `{ missions: [...] }` fixtures keep working.
  useAgentsStoreMissionsOptional: () => mockUseAgentsStoreOptional()?.missions ?? null,
}));

function liveMission(overrides: Partial<Mission> & { id: string; title: string }): Mission {
  return { status: 'queued', model: 'sonnet', ...overrides } as Mission;
}

describe('useFleetMissions — live-store-only running mission reflected within one poll tick', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') return [];
      return undefined;
    });
    mockUseAppContext.mockReturnValue({
      platform: { name: 'tauri' },
      openProjects: [{ id: 'p1', root: 'C:/proj1', brainId: null, active: true }],
      activeProjectId: 'p1',
    });
    mockUseAgentsStoreOptional.mockReset();
  });

  it('counts a brand-new live-store-only mission as running the instant it appears — no second poll tick needed', async () => {
    mockUseAgentsStoreOptional.mockReturnValue({ missions: [] });

    const { result, rerender } = renderHook(() => useFleetMissions(true));

    // Let the first poll tick resolve (journal snapshot = []).
    await act(async () => {});
    expect(result.current.projects.find((p) => p.projectId === 'c:/proj1')?.missions ?? []).toHaveLength(0);

    // The mission now exists ONLY in the live agentsStore — running, with NO
    // journal row anywhere (mergeLiveMissions' "brand-new mission" case) —
    // and NO new poll has fired (mockInvoke call count must not increase).
    const invokeCallsBefore = mockInvoke.mock.calls.length;
    mockUseAgentsStoreOptional.mockReturnValue({
      missions: [liveMission({ id: 'M-live-1', title: 'Fresh mission', status: 'running' })],
    });
    rerender();

    const project = result.current.projects.find((p) => p.projectId === 'c:/proj1');
    expect(project?.missions.some((m) => m.id === 'M-live-1' && m.status === 'running')).toBe(true);
    expect(mockInvoke.mock.calls.length).toBe(invokeCallsBefore);
  });

  it('overlays an EXISTING journal-known mission (queued snapshot) with its live running status the instant the live store updates, without a second poll tick', async () => {
    mockUseAgentsStoreOptional.mockReturnValue({ missions: [] });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: 'M-2',
            project_id: 'c:/proj1',
            status: 'queued',
            data: JSON.stringify({ id: 'M-2', title: 'Queued task', status: 'queued', model: 'sonnet' }),
            updated_ms: 1000,
          },
        ];
      }
      return undefined;
    });

    const { result, rerender } = renderHook(() => useFleetMissions(true));
    await act(async () => {});

    const beforeProject = result.current.projects.find((p) => p.projectId === 'c:/proj1');
    expect(beforeProject?.missions.find((m) => m.id === 'M-2')?.status).toBe('queued');

    const invokeCallsBefore = mockInvoke.mock.calls.length;
    mockUseAgentsStoreOptional.mockReturnValue({
      missions: [liveMission({ id: 'M-2', title: 'Queued task', status: 'running' })],
    });
    rerender();

    const afterProject = result.current.projects.find((p) => p.projectId === 'c:/proj1');
    expect(afterProject?.missions.find((m) => m.id === 'M-2')?.status).toBe('running');
    expect(mockInvoke.mock.calls.length).toBe(invokeCallsBefore);
  });
});

// ── W-MODES: FleetProject.approvalMode read-model ─────────────────────

describe('useFleetMissions — FleetProject.approvalMode (W-MODES read-model)', () => {
  beforeEach(() => {
    _resetApprovalModesForTests();
    // approvalMode.ts falls back to localStorage here (no Tauri sentinel set
    // in this suite) — clear it so a prior test's persisted value can never
    // race AgentsStoreProvider-independent callers of ensureApprovalModesLoaded.
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') return [];
      return undefined;
    });
    mockUseAppContext.mockReturnValue({
      platform: { name: 'tauri' },
      openProjects: [{ id: 'p1', root: 'C:/proj1', brainId: null, active: true }],
      activeProjectId: 'p1',
    });
    mockUseAgentsStoreOptional.mockReset();
    mockUseAgentsStoreOptional.mockReturnValue({ missions: [] });
  });

  afterEach(() => {
    _resetApprovalModesForTests();
    localStorage.clear();
  });

  it('defaults to "manual" (approvalMode.ts default) before anything is configured', async () => {
    const { result } = renderHook(() => useFleetMissions(true));
    await act(async () => {});
    const project = result.current.projects.find((p) => p.projectId === 'c:/proj1');
    expect(project?.approvalMode).toBe('manual');
  });

  it('reflects a per-project override set via approvalMode.ts, without a new poll tick', async () => {
    const { result } = renderHook(() => useFleetMissions(true));
    await act(async () => {});
    expect(result.current.projects.find((p) => p.projectId === 'c:/proj1')?.approvalMode).toBe('manual');

    const invokeCallsBefore = mockInvoke.mock.calls.length;
    await act(async () => {
      await setApprovalMode('full_auto', 'c:/proj1');
    });

    const project = result.current.projects.find((p) => p.projectId === 'c:/proj1');
    expect(project?.approvalMode).toBe('full_auto');
    expect(mockInvoke.mock.calls.length).toBe(invokeCallsBefore);
  });
});

// ── B3: tombstoned + malformed journal rows never surface (2026-08-04) ──

describe('useFleetMissions — journal-first tombstone filtering (B3)', () => {
  beforeEach(() => {
    mockUseAppContext.mockReturnValue({
      platform: { name: 'tauri' },
      openProjects: [{ id: 'p1', root: 'C:/proj1', brainId: null, active: true }],
      activeProjectId: 'p1',
    });
    mockUseAgentsStoreOptional.mockReset();
    mockUseAgentsStoreOptional.mockReturnValue({ missions: [] });
  });

  it('excludes a tombstoned row (archived: true, e.g. from tombstoneJournalMission or a real archiveMission) from the project\'s mission list', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: 'M-live',
            project_id: 'c:/proj1',
            status: 'running',
            data: JSON.stringify({ id: 'M-live', title: 'Still visible', status: 'running', model: 'sonnet' }),
            updated_ms: 1000,
          },
          {
            mission_id: 'M-tombstoned',
            project_id: 'c:/proj1',
            status: 'done',
            data: JSON.stringify({ id: 'M-tombstoned', title: 'Deleted mission', status: 'done', model: 'sonnet', archived: true }),
            updated_ms: 1000,
          },
        ];
      }
      return undefined;
    });

    const { result } = renderHook(() => useFleetMissions(true));
    await act(async () => {});

    const project = result.current.projects.find((p) => p.projectId === 'c:/proj1');
    expect(project?.missions.map((m) => m.id)).toEqual(['M-live']);
  });

  it('silently ignores a malformed placeholder row (data = {missionId} only, e.g. M3-testeur/M4-testeur) instead of surfacing it', async () => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'journal_missions_current') {
        return [
          {
            mission_id: 'M3-testeur',
            project_id: 'c:/proj1',
            status: 'queued',
            data: JSON.stringify({ missionId: 'M3-testeur' }),
            updated_ms: 1000,
          },
        ];
      }
      return undefined;
    });

    const { result } = renderHook(() => useFleetMissions(true));
    await act(async () => {});

    const project = result.current.projects.find((p) => p.projectId === 'c:/proj1');
    expect(project?.missions ?? []).toHaveLength(0);
  });
});
