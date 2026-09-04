/* syntheticFleet.ts — builds a synthetic FleetProject[] from remote deltas
   only, for spectator mode (no local clone required).

   P2-6: Watch / siège sans agent. A teammate who hasn't opened the repo
   locally can still see all remote missions on the canvas by grouping
   remote deltas by projectId into synthetic FleetProjects.
*/

import type { FleetProject } from '../agents/fleetMissions.js';
import type { FleetDelta } from './types.js';
import { remoteDeltaToMission } from './mergeRemoteFleet.js';

const SPECTATOR_TTL_MS = 60_000;

export function buildSyntheticFleet(
  remoteDeltas: ReadonlyMap<string, FleetDelta>,
  selfUserId: string | null,
  nowMs: number = Date.now(),
): FleetProject[] {
  const byProject = new Map<string, FleetDelta[]>();

  for (const delta of remoteDeltas.values()) {
    if (selfUserId && delta.fromUserId === selfUserId) continue;
    if (nowMs - delta.updatedAt > SPECTATOR_TTL_MS) continue;
    const list = byProject.get(delta.projectId) ?? [];
    list.push(delta);
    byProject.set(delta.projectId, list);
  }

  if (byProject.size === 0) return [];

  const projects: FleetProject[] = [];
  for (const [projectId, deltas] of byProject) {
    const missions = deltas.map((d) => remoteDeltaToMission(d, nowMs));
    projects.push({
      projectId,
      root: `remote:${projectId}`,
      name: projectId,
      missions,
    });
  }
  return projects;
}
