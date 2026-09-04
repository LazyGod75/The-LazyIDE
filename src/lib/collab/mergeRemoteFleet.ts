/* mergeRemoteFleet.ts — fold teammate fleet deltas onto the local
   FleetProject[] so remote agents render as real canvas nodes.

   Pure. Local missions ALWAYS win on id (never overwrite a mission this
   machine actually runs). A remote delta whose projectKey matches no
   open local project is skipped (honest: you cannot place a node in a
   zone that does not exist). Stale deltas (older than TTL) are dropped.
*/

import type { FleetMission, FleetProject } from '../agents/fleetMissions.js';
import type { FleetStage } from '../agents/fleetStage.js';
import type { FleetDelta } from './types.js';

const DEFAULT_TTL_MS = 15_000;

const STAGES: ReadonlySet<FleetStage> = new Set(['plan', 'code', 'test', 'review', 'merged']);

function asStage(value: string | undefined): FleetStage {
  if (value && STAGES.has(value as FleetStage)) return value as FleetStage;
  return 'plan';
}

function asStatus(value: string): FleetMission['status'] {
  switch (value) {
    case 'queued':
    case 'running':
    case 'review':
    case 'done':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'queued';
  }
}

export function remoteDeltaToMission(delta: FleetDelta, nowMs: number): FleetMission {
  return {
    id: delta.missionId,
    title: delta.title && delta.title.length > 0 ? delta.title : delta.missionId,
    status: asStatus(delta.status),
    stage: asStage(delta.stage),
    liveAction: delta.liveAction,
    model: delta.model && delta.model.length > 0 ? delta.model : 'remote',
    updatedMs: delta.updatedAt || nowMs,
    urgent: false,
    contractScopePaths: delta.occupancy && delta.occupancy.length > 0 ? delta.occupancy : undefined,
    originUserId: delta.fromUserId,
    originUserName: delta.fromName,
    remote: true,
    planSteps: delta.planSteps?.map((s) => ({ label: s.label, state: s.state, meta: s.ownerUserId })),
    sessionMembers: delta.sessionMembers,
    sponsorUserId: delta.sponsorUserId,
    sponsorName: delta.sponsorName,
    costCents: delta.costCents,
    worktreeBranch: delta.worktreeBranch,
    worktreeHead: delta.worktreeHead,
  };
}

export interface MergeRemoteFleetOptions {
  nowMs?: number;
  ttlMs?: number;
  selfUserId?: string | null;
}

export function mergeRemoteFleet(
  local: readonly FleetProject[],
  remoteDeltas: ReadonlyMap<string, FleetDelta>,
  options: MergeRemoteFleetOptions = {},
): FleetProject[] {
  if (remoteDeltas.size === 0) return local as FleetProject[];

  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const selfUserId = options.selfUserId ?? null;

  const localIds = new Set<string>();
  const byKey = new Map<string, FleetProject>();
  for (const project of local) {
    byKey.set(project.projectId.toLowerCase(), project);
    for (const mission of project.missions) localIds.add(mission.id);
  }

  const extras = new Map<string, FleetMission[]>();
  for (const delta of remoteDeltas.values()) {
    if (selfUserId && delta.fromUserId === selfUserId) continue;
    if (nowMs - delta.updatedAt > ttlMs) continue;
    if (localIds.has(delta.missionId)) continue;
    const key = delta.projectId.toLowerCase();
    const host = byKey.get(key);
    if (!host) continue;
    const list = extras.get(host.projectId) ?? [];
    list.push(remoteDeltaToMission(delta, nowMs));
    extras.set(host.projectId, list);
  }

  if (extras.size === 0) return local as FleetProject[];

  return local.map((project) => {
    const added = extras.get(project.projectId);
    if (!added || added.length === 0) return project;
    return { ...project, missions: [...project.missions, ...added] };
  });
}
