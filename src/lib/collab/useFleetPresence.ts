/* useFleetPresence.ts — joins (or stays out of) the org Realtime channel,
   tracks this user's presence (throttled 2s), mirrors local fleet
   mission deltas to/from teammates, and heartbeats org_fleet_missions.

   Honest degrade: `active` is false — and nothing is joined — for any
   of: `enabled` false, no signed-in user, no active org. Project is
   NOT required to join (watchers with no local clone still see presence);
   projectKey is only used when broadcasting THIS machine's missions.

   Channel is org-wide (presenceChannel.channelName). Project identity
   travels on the payload as the repo basename (projectKeyFromRoot).
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase/client.js';
import { useAppContext } from '../../app/AppContext.js';
import { useAuth } from '../auth/index.js';
import { useActiveTeamContext } from '../teams/ActiveTeamContext.js';
import { teamsActive } from '../features.js';
import { loadStoredOrgId } from '../teams/useOrg.js';
import { useFleetMissions } from '../agents/fleetMissions.js';
import { createPresenceChannel, type OrgPresenceChannel } from './presenceChannel.js';
import { projectKeyFromRoot } from './projectKey.js';
import { fetchOrgFleet, upsertFleetHeartbeats } from './fleetTable.js';
import { setRemoteOccupancySnapshot } from './remoteOccupancy.js';
import type { PresenceUser, FleetDelta, CanvasOp, SelfIdentity, MissionTransfer, SessionEvent } from './types.js';

const THROTTLE_MS = 2000;

/** Deterministic per-user color (HSL hue from a cheap string hash). */
export function colorForUserId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

export function displayNameFor(email: string | null | undefined, userId: string): string {
  if (email && email.includes('@')) return email.split('@')[0];
  return userId.slice(0, 8);
}

export interface UseFleetPresenceOptions {
  enabled: boolean;
}

export interface UseFleetPresenceResult {
  active: boolean;
  self: SelfIdentity | null;
  remoteUsers: PresenceUser[];
  remoteDeltasByMission: Map<string, FleetDelta>;
  /** Shared project key (repo basename) of the active local project. */
  projectId: string | null;
  remoteCanvasOps: Map<string, CanvasOp>;
  broadcastCanvasOp: (op: Omit<CanvasOp, 'fromUserId' | 'fromName' | 'updatedAt'>) => void;
  reportFocus: (focusedRef?: string, viewportCenter?: { x: number; y: number }) => void;
  /** P2 — mission handoff. Transfers ownership to another teammate. */
  broadcastMissionTransfer: (transfer: Omit<MissionTransfer, 'fromUserId' | 'fromName' | 'updatedAt'>) => void;
  /** P2 — session event (join/leave/claim-step/spectate). */
  broadcastSessionEvent: (event: Omit<SessionEvent, 'fromUserId' | 'fromName' | 'updatedAt'>) => void;
  /** P2 — incoming mission transfers, keyed by missionId. */
  remoteTransfersByMission: Map<string, MissionTransfer>;
  /** P2 — incoming session events, keyed by `${missionId}:${kind}:${stepLabel ?? ''}`. */
  remoteSessionEvents: Map<string, SessionEvent>;
}

function snapshotKey(mission: {
  status: string;
  stage?: string;
  liveAction?: string;
  occupancy?: string[];
}): string {
  return `${mission.status}|${mission.stage ?? ''}|${mission.liveAction ?? ''}|${(mission.occupancy ?? []).join(',')}`;
}

export function useFleetPresence({ enabled }: UseFleetPresenceOptions): UseFleetPresenceResult {
  const { user } = useAuth();
  const { hasActiveTeam } = useActiveTeamContext();
  const { activeProjectId, openProjects } = useAppContext();

  const orgId = teamsActive(hasActiveTeam) ? loadStoredOrgId() : null;

  const activeRoot = useMemo(
    () => openProjects.find((p) => p.id === activeProjectId)?.root ?? null,
    [openProjects, activeProjectId],
  );
  const projectId = activeRoot ? projectKeyFromRoot(activeRoot) : null;

  const { projects: fleetProjects } = useFleetMissions(enabled && Boolean(orgId));

  const self: SelfIdentity | null = user
    ? { userId: user.id, name: displayNameFor(user.email, user.id), color: colorForUserId(user.id) }
    : null;

  const active = enabled && Boolean(orgId) && Boolean(self);

  const [remoteUsers, setRemoteUsers] = useState<PresenceUser[]>([]);
  const [remoteDeltasByMission, setRemoteDeltasByMission] = useState<Map<string, FleetDelta>>(new Map());
  const [remoteCanvasOps, setRemoteCanvasOps] = useState<Map<string, CanvasOp>>(new Map());
  const [remoteTransfersByMission, setRemoteTransfersByMission] = useState<Map<string, MissionTransfer>>(new Map());
  const [remoteSessionEvents, setRemoteSessionEvents] = useState<Map<string, SessionEvent>>(new Map());

  const channelRef = useRef<OrgPresenceChannel | null>(null);
  const lastTrackedAtRef = useRef(0);
  const pendingFocusRef = useRef<{ focusedRef?: string; viewportCenter?: { x: number; y: number } } | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setRemoteUsers([]);
    setRemoteDeltasByMission(new Map());
    setRemoteCanvasOps(new Map());

    if (!active || !orgId || !self) {
      channelRef.current = null;
      setRemoteOccupancySnapshot([]);
      return;
    }

    const channel = createPresenceChannel(supabase, orgId, projectId ?? '', self);
    channelRef.current = channel;
    void channel.track({ userId: self.userId, name: self.name, color: self.color });

    void fetchOrgFleet(orgId).then((rows) => {
      if (channelRef.current !== channel) return;
      setRemoteDeltasByMission((prev) => {
        const next = new Map(prev);
        for (const row of rows) {
          if (row.fromUserId === self.userId) continue;
          next.set(row.missionId, row);
        }
        return next;
      });
    });

    const offPresence = channel.onPresenceChange(setRemoteUsers);
    const offDelta = channel.onFleetDelta((delta) => {
      if (delta.fromUserId === self.userId) return;
      setRemoteDeltasByMission((prev) => {
        const next = new Map(prev);
        next.set(delta.missionId, delta);
        return next;
      });
    });
    const offCanvasOp = channel.onCanvasOp((op) => {
      const key = op.kind === 'note' ? `note:${op.noteId ?? op.nodeId ?? ''}` : (op.nodeId ?? '');
      if (!key) return;
      setRemoteCanvasOps((prev) => {
        const next = new Map(prev);
        next.set(key, op);
        return next;
      });
    });
    const offTransfer = channel.onMissionTransfer((transfer) => {
      if (transfer.fromUserId === self.userId) return;
      setRemoteTransfersByMission((prev) => {
        const next = new Map(prev);
        next.set(transfer.missionId, transfer);
        return next;
      });
    });
    const offSession = channel.onSessionEvent((event) => {
      if (event.fromUserId === self.userId) return;
      const key = `${event.missionId}:${event.kind}:${event.stepLabel ?? ''}`;
      setRemoteSessionEvents((prev) => {
        const next = new Map(prev);
        next.set(key, event);
        return next;
      });
    });

    return () => {
      offPresence();
      offDelta();
      offCanvasOp();
      offTransfer();
      offSession();
      void channel.untrack();
      channel.close();
      channelRef.current = null;
      setRemoteOccupancySnapshot([]);
      if (throttleTimerRef.current) {
        clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, orgId, self?.userId, self?.name, self?.color]);

  const reportFocus = useCallback(
    (focusedRef?: string, viewportCenter?: { x: number; y: number }) => {
      if (!self) return;
      pendingFocusRef.current = { focusedRef, viewportCenter };

      const flush = () => {
        const channel = channelRef.current;
        const pending = pendingFocusRef.current;
        if (!channel || !pending || !self) return;
        lastTrackedAtRef.current = Date.now();
        void channel.track({ userId: self.userId, name: self.name, color: self.color, ...pending });
        pendingFocusRef.current = null;
      };

      const elapsed = Date.now() - lastTrackedAtRef.current;
      if (elapsed >= THROTTLE_MS) {
        flush();
      } else if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null;
          flush();
        }, THROTTLE_MS - elapsed);
      }
    },
    [self],
  );

  const prevSnapshotRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel || !self) return;

    const prev = prevSnapshotRef.current;
    const next = new Map<string, string>();
    const heartbeats: Array<{
      projectKey: string;
      missionId: string;
      title: string;
      status: string;
      stage?: string;
      liveAction?: string;
      model?: string;
      occupancy: string[];
    }> = [];

    for (const fleetProject of fleetProjects) {
      const key = projectKeyFromRoot(fleetProject.root || fleetProject.projectId);
      for (const mission of fleetProject.missions) {
        if (mission.remote) continue;
        const occupancy = mission.contractScopePaths ?? [];
        const planSteps = mission.planSteps?.map((s) => ({
          label: s.label,
          state: s.state,
          ownerUserId: s.meta,
        }));
        const snap = snapshotKey({
          status: mission.status,
          stage: mission.stage,
          liveAction: mission.liveAction,
          occupancy,
        }) + `|${planSteps?.map((s) => `${s.label}:${s.state}:${s.ownerUserId ?? ''}`).join(',') ?? ''}`;
        next.set(mission.id, snap);
        const before = prev.get(mission.id);
        if (before !== snap) {
          void channel.broadcastFleetDelta({
            projectId: key,
            missionId: mission.id,
            status: mission.status,
            stage: mission.stage,
            title: mission.title,
            liveAction: mission.liveAction,
            model: mission.model,
            occupancy,
            planSteps,
            sessionMembers: mission.sessionMembers,
            sponsorUserId: mission.sponsorUserId,
            sponsorName: mission.sponsorName,
            costCents: mission.costCents,
            worktreeBranch: mission.worktreeBranch,
            worktreeHead: mission.worktreeHead,
          });
        }
        heartbeats.push({
          projectKey: key,
          missionId: mission.id,
          title: mission.title,
          status: mission.status,
          stage: mission.stage,
          liveAction: mission.liveAction,
          model: mission.model,
          occupancy,
        });
      }
    }
    prevSnapshotRef.current = next;

    if (orgId && heartbeats.length > 0) {
      void upsertFleetHeartbeats(orgId, self.userId, self.name, heartbeats);
    }
  }, [fleetProjects, orgId, self]);

  useEffect(() => {
    const scopes = Array.from(remoteDeltasByMission.values())
      .filter((d) => (d.occupancy?.length ?? 0) > 0)
      .map((d) => ({ id: `remote:${d.missionId}`, scope: d.occupancy ?? [] }));
    setRemoteOccupancySnapshot(scopes);
  }, [remoteDeltasByMission]);

  const broadcastCanvasOp = useCallback(
    (op: Omit<CanvasOp, 'fromUserId' | 'fromName' | 'updatedAt'>) => {
      const channel = channelRef.current;
      if (!channel || !self) return;
      void channel.broadcastCanvasOp(op);
    },
    [self],
  );

  const broadcastMissionTransfer = useCallback(
    (transfer: Omit<MissionTransfer, 'fromUserId' | 'fromName' | 'updatedAt'>) => {
      const channel = channelRef.current;
      if (!channel || !self) return;
      void channel.broadcastMissionTransfer(transfer);
    },
    [self],
  );

  const broadcastSessionEvent = useCallback(
    (event: Omit<SessionEvent, 'fromUserId' | 'fromName' | 'updatedAt'>) => {
      const channel = channelRef.current;
      if (!channel || !self) return;
      void channel.broadcastSessionEvent(event);
    },
    [self],
  );

  return {
    active,
    self,
    remoteUsers,
    remoteDeltasByMission,
    projectId,
    remoteCanvasOps,
    broadcastCanvasOp,
    reportFocus,
    broadcastMissionTransfer,
    broadcastSessionEvent,
    remoteTransfersByMission,
    remoteSessionEvents,
  };
}
