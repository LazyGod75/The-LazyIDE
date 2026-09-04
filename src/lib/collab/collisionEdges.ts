/* collisionEdges.ts — red canvas edges between missions whose claimed
   files overlap. Pure; occupancy comes from FleetMission.contractScopePaths
   (local declared scope OR a remote delta's occupancy[]).
*/

import { MarkerType, type Edge } from '@xyflow/react';
import type { FleetMission } from '../agents/fleetMissions.js';
import { pathsOverlap } from '../agents/preflight.js';
import { makeRef } from '../../components/agents/canvas/canvasTypes.js';

export interface OccupancyCollision {
  a: string;
  b: string;
  paths: string[];
}

export function findOccupancyCollisions(missions: readonly FleetMission[]): OccupancyCollision[] {
  const claimed = missions
    .map((mission) => ({
      id: mission.id,
      scope: (mission.contractScopePaths ?? []).filter((p) => p.length > 0),
    }))
    .filter((entry) => entry.scope.length > 0);

  const out: OccupancyCollision[] = [];
  for (let i = 0; i < claimed.length; i += 1) {
    for (let j = i + 1; j < claimed.length; j += 1) {
      const matched = new Set<string>();
      for (const a of claimed[i].scope) {
        for (const b of claimed[j].scope) {
          if (pathsOverlap(a, b)) {
            matched.add(a);
            matched.add(b);
          }
        }
      }
      if (matched.size > 0) {
        out.push({ a: claimed[i].id, b: claimed[j].id, paths: Array.from(matched).sort() });
      }
    }
  }
  return out;
}

export function buildCollisionEdges(
  missions: readonly FleetMission[],
  renderedIds: ReadonlySet<string>,
): Array<Edge<Record<string, unknown>, 'hierarchy'>> {
  const edges: Array<Edge<Record<string, unknown>, 'hierarchy'>> = [];
  for (const hit of findOccupancyCollisions(missions)) {
    const source = makeRef('mission', hit.a);
    const target = makeRef('mission', hit.b);
    if (!renderedIds.has(source) || !renderedIds.has(target)) continue;
    edges.push({
      id: `collision:${hit.a}:${hit.b}`,
      type: 'hierarchy',
      source,
      target,
      data: { collision: true, paths: hit.paths },
      style: { stroke: '#F87171', strokeWidth: 2, strokeDasharray: '6 4' },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: '#F87171' },
    });
  }
  return edges;
}
