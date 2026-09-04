/**
 * useFleetPresence.test.tsx
 *
 * lib/collab/useFleetPresence.ts: the hook PresenceOverlay.tsx relies
 * on for the honest solo/no-org degrade path, channel lifecycle, and
 * fleet-delta diffing. presenceChannel.ts's factory is mocked here (it
 * has its own dedicated integration test, presenceChannel.test.ts) so
 * this suite stays focused on the hook's own gating/throttling/diffing
 * logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { colorForUserId, displayNameFor, useFleetPresence } from '../lib/collab/useFleetPresence';
import type { createPresenceChannel } from '../lib/collab/presenceChannel';
import type { useFleetMissions } from '../lib/agents/fleetMissions';
import type { PresenceUser, FleetDelta, CanvasOp } from '../lib/collab/types';

// ── Mocks ─────────────────────────────────────────────────────────

const trackMock = vi.fn(async () => {});
const untrackMock = vi.fn(async () => {});
const broadcastFleetDeltaMock = vi.fn(async () => {});
const broadcastCanvasOpMock = vi.fn(async () => {});
const broadcastMissionTransferMock = vi.fn(async () => {});
const broadcastSessionEventMock = vi.fn(async () => {});
const closeMock = vi.fn();
let presenceChangeCb: ((users: PresenceUser[]) => void) | null = null;
let fleetDeltaCb: ((delta: FleetDelta) => void) | null = null;
let canvasOpCb: ((op: CanvasOp) => void) | null = null;
let _missionTransferCb: ((transfer: import('../lib/collab/types').MissionTransfer) => void) | null = null;
let _sessionEventCb: ((event: import('../lib/collab/types').SessionEvent) => void) | null = null;

const createPresenceChannelMock = vi.fn<typeof createPresenceChannel>(() => ({
  track: trackMock,
  untrack: untrackMock,
  broadcastFleetDelta: broadcastFleetDeltaMock,
  broadcastCanvasOp: broadcastCanvasOpMock,
  broadcastMissionTransfer: broadcastMissionTransferMock,
  broadcastSessionEvent: broadcastSessionEventMock,
  onPresenceChange: (cb: (users: PresenceUser[]) => void) => {
    presenceChangeCb = cb;
    return () => { presenceChangeCb = null; };
  },
  onFleetDelta: (cb: (delta: FleetDelta) => void) => {
    fleetDeltaCb = cb;
    return () => { fleetDeltaCb = null; };
  },
  onCanvasOp: (cb: (op: CanvasOp) => void) => {
    canvasOpCb = cb;
    return () => { canvasOpCb = null; };
  },
  onMissionTransfer: (cb: (transfer: import('../lib/collab/types').MissionTransfer) => void) => {
    _missionTransferCb = cb;
    return () => { _missionTransferCb = null; };
  },
  onSessionEvent: (cb: (event: import('../lib/collab/types').SessionEvent) => void) => {
    _sessionEventCb = cb;
    return () => { _sessionEventCb = null; };
  },
  close: closeMock,
}));

vi.mock('../lib/collab/presenceChannel', () => ({
  createPresenceChannel: (...args: Parameters<typeof createPresenceChannel>) => createPresenceChannelMock(...args),
}));

vi.mock('../lib/supabase/client', () => ({ supabase: {} }));

vi.mock('../lib/collab/fleetTable', () => ({
  fetchOrgFleet: vi.fn(async () => []),
  upsertFleetHeartbeats: vi.fn(async () => {}),
}));

vi.mock('../lib/collab/remoteOccupancy', () => ({
  setRemoteOccupancySnapshot: vi.fn(),
  getRemoteOccupancySnapshot: vi.fn(() => []),
}));

let mockUser: { id: string; email: string | null } | null = { id: 'user-1', email: 'alice@example.com' };
vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: mockUser }) }));

let mockHasActiveTeam = true;
vi.mock('../lib/teams/ActiveTeamContext', () => ({ useActiveTeamContext: () => ({ hasActiveTeam: mockHasActiveTeam }) }));

vi.mock('../lib/features', () => ({ teamsActive: (live?: boolean) => Boolean(live) }));

let mockOrgId: string | null = 'org-1';
vi.mock('../lib/teams/useOrg', () => ({ loadStoredOrgId: () => mockOrgId }));

let mockActiveProjectId: string | null = 'entry-1';
let mockOpenProjects: Array<{ id: string; root: string }> = [{ id: 'entry-1', root: 'C:/repo' }];
vi.mock('../app/AppContext', () => ({
  useAppContext: () => ({ activeProjectId: mockActiveProjectId, openProjects: mockOpenProjects }),
}));

let mockFleetProjects: Array<{ projectId: string; missions: Array<{ id: string; status: string; stage?: string }> }> = [];
// Deliberately loose fixture shape (not the full FleetProject/FleetMission
// production type — `stage` is always populated in real data via
// deriveFleetStage, see fleetStage.ts) so the "no stage yet" broadcast-diff
// test below can exercise the hook's own optional-stage handling.
const useFleetMissionsMock = vi.fn((_enabled?: boolean) => ({ projects: mockFleetProjects, loading: false, error: null }));
vi.mock('../lib/agents/fleetMissions', () => ({ useFleetMissions: (...args: Parameters<typeof useFleetMissions>) => useFleetMissionsMock(...args) }));

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: 'user-1', email: 'alice@example.com' };
  mockHasActiveTeam = true;
  mockOrgId = 'org-1';
  mockActiveProjectId = 'entry-1';
  mockOpenProjects = [{ id: 'entry-1', root: 'C:/repo' }];
  mockFleetProjects = [];
  presenceChangeCb = null;
  fleetDeltaCb = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('colorForUserId / displayNameFor', () => {
  it('is deterministic for the same userId', () => {
    expect(colorForUserId('user-1')).toBe(colorForUserId('user-1'));
  });

  it('derives a display name from the email local part', () => {
    expect(displayNameFor('alice@example.com', 'user-1')).toBe('alice');
  });

  it('falls back to a short userId prefix when no email is present', () => {
    expect(displayNameFor(null, 'user-12345678')).toBe('user-123');
  });
});

describe('useFleetPresence — honest degrade path', () => {
  it('is inactive with no signed-in user', () => {
    mockUser = null;
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    expect(result.current.active).toBe(false);
    expect(createPresenceChannelMock).not.toHaveBeenCalled();
  });

  it('is inactive with no active org (solo user)', () => {
    mockHasActiveTeam = false;
    mockOrgId = null;
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    expect(result.current.active).toBe(false);
    expect(createPresenceChannelMock).not.toHaveBeenCalled();
  });

  it('is active with no local project but still joins the org channel', () => {
    mockActiveProjectId = null;
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    expect(result.current.active).toBe(true);
    expect(result.current.projectId).toBe(null);
    expect(createPresenceChannelMock).toHaveBeenCalledWith(
      {},
      'org-1',
      '',
      expect.objectContaining({ userId: 'user-1', name: 'alice' }),
    );
  });

  it('is inactive when disabled (canvas not visible)', () => {
    const { result } = renderHook(() => useFleetPresence({ enabled: false }));
    expect(result.current.active).toBe(false);
    expect(createPresenceChannelMock).not.toHaveBeenCalled();
  });
});

describe('useFleetPresence — active lifecycle', () => {
  it('joins the channel and tracks self on mount', () => {
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    expect(result.current.active).toBe(true);
    expect(createPresenceChannelMock).toHaveBeenCalledWith(
      {},
      'org-1',
      'repo',
      expect.objectContaining({ userId: 'user-1', name: 'alice' }),
    );
    expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('surfaces remote presence updates via onPresenceChange', () => {
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    act(() => {
      presenceChangeCb?.([{ userId: 'teammate', name: 'Bob', color: '#111', updatedAt: 1 }]);
    });
    expect(result.current.remoteUsers).toEqual([{ userId: 'teammate', name: 'Bob', color: '#111', updatedAt: 1 }]);
  });

  it('collects incoming fleet deltas keyed by missionId', () => {
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    act(() => {
      fleetDeltaCb?.({ projectId: 'c:/repo', missionId: 'm-1', status: 'review', fromUserId: 'u2', fromName: 'Bob', updatedAt: 1 });
    });
    expect(result.current.remoteDeltasByMission.get('m-1')).toEqual(
      expect.objectContaining({ missionId: 'm-1', status: 'review' }),
    );
  });

  it('collects incoming live canvas moves keyed by nodeId (live co-editing)', () => {
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    act(() => {
      canvasOpCb?.({
        projectId: 'c:/repo',
        kind: 'move',
        nodeId: 'mission:m-9',
        position: { x: 10, y: 20 },
        fromUserId: 'u2',
        fromName: 'Bob',
        updatedAt: 1,
      });
    });
    expect(result.current.remoteCanvasOps.get('mission:m-9')).toEqual(
      expect.objectContaining({ kind: 'move', position: { x: 10, y: 20 } }),
    );
  });

  it('untracks and closes the channel on unmount', () => {
    const { unmount } = renderHook(() => useFleetPresence({ enabled: true }));
    unmount();
    expect(untrackMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });

  it('broadcasts a fleet delta only when a mission status actually changes', () => {
    mockFleetProjects = [{ projectId: 'c:/repo', missions: [{ id: 'm-1', status: 'running' }] }];
    const { rerender } = renderHook(() => useFleetPresence({ enabled: true }));
    expect(broadcastFleetDeltaMock).toHaveBeenCalledTimes(1);
    expect(broadcastFleetDeltaMock).toHaveBeenCalledWith({ projectId: 'repo', missionId: 'm-1', status: 'running', stage: undefined, title: undefined, liveAction: undefined, model: undefined, occupancy: [] });

    // Same status again — a fresh array reference (new poll tick) but no
    // real change — must NOT re-broadcast.
    mockFleetProjects = [{ projectId: 'c:/repo', missions: [{ id: 'm-1', status: 'running' }] }];
    rerender();
    expect(broadcastFleetDeltaMock).toHaveBeenCalledTimes(1);

    // Real status change — broadcasts again.
    mockFleetProjects = [{ projectId: 'c:/repo', missions: [{ id: 'm-1', status: 'review' }] }];
    rerender();
    expect(broadcastFleetDeltaMock).toHaveBeenCalledTimes(2);
  });

  it('reportFocus tracks immediately on the first call, then throttles', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFleetPresence({ enabled: true }));
    trackMock.mockClear(); // ignore the initial mount track()

    result.current.reportFocus('mission-1');
    expect(trackMock).toHaveBeenCalledTimes(1);

    // Immediately calling again is throttled — no second network call yet.
    result.current.reportFocus('mission-2');
    expect(trackMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(trackMock).toHaveBeenLastCalledWith(expect.objectContaining({ focusedRef: 'mission-2' }));
  });
});
