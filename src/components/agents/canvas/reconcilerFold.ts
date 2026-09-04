/* reconcilerFold.ts — orchestrator subtree fold + loop expand-in-place /
   iteration nodes (W9 split of the original 1146-line reconciler.ts; see
   reconciler.ts's own module header for the full pipeline story and the
   original W1a contract-gap notes, in particular gap #1: FleetMission does
   not carry loopConfig/loopParentId/loopIteration/parentMissionId, hence
   the `MissionLoopMeta` side-map every function below keys off). PURE
   functions only, same contract as reconciler.ts: no React, no I/O.

   Owns two related-but-distinct W8a deliverable #2 concerns:
     - Orchestrator subtree FOLD: given a set of folded orchestrator ids,
       compute which missions are transitively HIDDEN (computeHiddenMissionIds)
       and, for each, the nearest VISIBLE ancestor a hidden-endpoint chain
       edge should reroute onto (findVisibleAncestorId, consumed by
       reconcilerEdges.ts's remapHiddenEndpoint) — plus the per-orchestrator
       sub-mission count/worst-status aggregate (computeSubMissionAggregates)
       that feeds the fold chevron's badge.
     - Loop EXPAND-in-place: given a set of expanded loop mission ids,
       project each loop's last-3 iterations into read-only `iteration:`
       child candidates (iterationExtrasFor) stacked under the loop card —
       consumed by reconcilerZones.ts's computeZoneLayout BEFORE its
       bounding-box pass, so the zone tint always covers them.

   `MissionLoopMeta` itself (the side-map's per-mission entry shape) is also
   defined here — it's this file's own primary currency, and CanvasView.tsx/
   Cockpit.tsx/useCanvasFlowGraph.ts import it (re-exported by reconciler.ts,
   the sole public barrel every external caller still imports from).
*/

import type { LoopConfig } from '../../../lib/agents/types';
import type { FleetMission } from '../../../lib/agents/fleetMissions';
import { makeRef, type IterationNodeData } from './canvasTypes';
import {
  FULL_CARD_MAX_HEIGHT,
} from './geometry';
import type { ChildCandidate, ZoneBuildContext, ZoneInput } from './reconcilerZones';

// ── Reconciler-local metadata (W1a header gap #1 workaround) ─────────

export interface MissionLoopMeta {
  loopConfig?: LoopConfig;
  loopParentId?: string;
  loopIteration?: number;
  parentMissionId?: string;
}

export type MissionStatusLike = FleetMission['status'];

/** `prefs.foldedOrchestrators`/`prefs.expandedLoops` record -> the id Set
 *  the fold/expand passes consume (only `true` entries count — a toggled-
 *  back-off id stays in the record as `false`). */
const EMPTY_ID_SET: ReadonlySet<string> = new Set();

export function recordToIdSet(record: Record<string, boolean> | undefined): ReadonlySet<string> {
  if (!record) return EMPTY_ID_SET;
  const ids = new Set<string>();
  for (const [id, on] of Object.entries(record)) {
    if (on === true) ids.add(id);
  }
  return ids;
}

// ── Orchestrator subtree fold (W8a deliverable #2) ───────────────────────
//
// Pure helpers over `missionLoopMeta`'s `parentMissionId` links — no
// canvasStore/React import, directly unit-testable via `reconcile()`.

function statusSeverity(status: MissionStatusLike): number {
  switch (status) {
    case 'failed':
    case 'cancelled':
      return 4;
    case 'review':
      return 3;
    case 'running':
      return 2;
    case 'queued':
      return 1;
    case 'done':
    default:
      return 0;
  }
}

/** Direct-children index (mission id -> its direct sub-mission ids), built
 *  once per reconcile from every mission's `parentMissionId` link. */
export function buildChildrenByParent(
  allMissions: readonly FleetMission[],
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>,
): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const mission of allMissions) {
    const parentId = missionLoopMeta.get(mission.id)?.parentMissionId;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(mission.id);
    childrenByParent.set(parentId, list);
  }
  return childrenByParent;
}

/** Per-orchestrator direct sub-mission count + worst-status — feeds
 *  `MissionNodeData.subMissionCount`/`worstSubMissionStatus` (spec: fold
 *  chevron's "N sous-missions · worst-status color dot" badge). */
export function computeSubMissionAggregates(
  childrenByParent: ReadonlyMap<string, string[]>,
  missionById: ReadonlyMap<string, FleetMission>,
): Map<string, { count: number; worstStatus: MissionStatusLike }> {
  const result = new Map<string, { count: number; worstStatus: MissionStatusLike }>();
  for (const [parentId, childIds] of childrenByParent) {
    let worstStatus: MissionStatusLike = 'done';
    let worstSeverity = -1;
    for (const childId of childIds) {
      const status = missionById.get(childId)?.status;
      if (!status) continue;
      const severity = statusSeverity(status);
      if (severity > worstSeverity) {
        worstSeverity = severity;
        worstStatus = status;
      }
    }
    result.set(parentId, { count: childIds.length, worstStatus });
  }
  return result;
}

/** Transitive closure of every mission hidden by a folded orchestrator
 *  (BFS over `childrenByParent`, cycle-safe via a visited guard — the
 *  parentMissionId graph is a tree in practice, but this never trusts
 *  that). */
export function computeHiddenMissionIds(
  foldedOrchestrators: ReadonlySet<string>,
  childrenByParent: ReadonlyMap<string, string[]>,
): Set<string> {
  const hidden = new Set<string>();
  const queue: string[] = [];
  for (const orchestratorId of foldedOrchestrators) {
    for (const childId of childrenByParent.get(orchestratorId) ?? []) queue.push(childId);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (hidden.has(id)) continue;
    hidden.add(id);
    for (const childId of childrenByParent.get(id) ?? []) queue.push(childId);
  }
  return hidden;
}

/** Walks `parentMissionId` up from a hidden mission id until it reaches the
 *  first ancestor NOT in `hiddenMissionIds` (i.e. the folded orchestrator
 *  itself) — capped so a corrupt/cyclic parent chain can never loop
 *  forever. Returns `null` if no such ancestor is found (defensive —
 *  should not happen given `hiddenMissionIds` is always this same
 *  parent-chain's own transitive closure). Consumed by reconcilerEdges.ts's
 *  `remapHiddenEndpoint`. */
export function findVisibleAncestorId(
  hiddenId: string,
  missionLoopMeta: ReadonlyMap<string, MissionLoopMeta>,
  hiddenMissionIds: ReadonlySet<string>,
): string | null {
  let current: string | undefined = missionLoopMeta.get(hiddenId)?.parentMissionId;
  let guard = 0;
  while (current && guard < 64) {
    if (!hiddenMissionIds.has(current)) return current;
    current = missionLoopMeta.get(current)?.parentMissionId;
    guard += 1;
  }
  return null;
}

// ── Loop expand-in-place (W8a deliverable #2) ─────────────────────────
//
// `ITERATION_NODE_WIDTH`/`HEIGHT` are DEFINED here (not reconcilerZones.ts)
// specifically so the dependency between the two sibling files stays
// ONE-WAY at runtime: reconcilerZones.ts's DEFAULT_NODE_SIZE imports these
// two constants (a value import, Zones -> Fold) plus `iterationExtrasFor`
// itself, while everything this file imports back FROM reconcilerZones.ts
// (ChildCandidate/ZoneInput/ZoneBuildContext below) is `import type` —
// erased at compile time, so there is no real circular MODULE dependency,
// only a circular TYPE reference (which TS/bundlers handle natively, the
// same way two files with mutually-recursive interfaces do).
export const ITERATION_NODE_WIDTH = 220;
export const ITERATION_NODE_HEIGHT = 40;
const ITERATION_NODE_GAP = 8;
const ITERATION_NODE_INDENT = 28;

/** W8a deliverable #2 — an EXPANDED loop's last-3 iterations as read-only
 *  `iteration:` child candidates, stacked under the loop card (positions
 *  always DERIVED from the loop's own position, never from `ctx.positions`:
 *  these minis follow their loop wherever it goes). Consumed by
 *  reconcilerZones.ts's `computeZoneLayout`, BEFORE its bounding-box pass —
 *  imports `LoopNodeData` structurally via `ChildCandidate` rather than by
 *  name to avoid a needless extra canvasTypes.ts import here. */
export function iterationExtrasFor(
  placed: ReadonlyArray<ChildCandidate & { position: { x: number; y: number } }>,
  zone: ZoneInput,
  ctx: ZoneBuildContext,
): Array<ChildCandidate & { position: { x: number; y: number } }> {
  const extras: Array<ChildCandidate & { position: { x: number; y: number } }> = [];
  const missionTitleById = new Map(zone.missions.map((m) => [m.id, m.title] as const));
  for (const child of placed) {
    if (child.type !== 'loop') continue;
    const loopData = child.data as { mission: { id: string }; recentIterations: Array<{ id: string; status: FleetMission['status']; iteration: number }> };
    if (!ctx.expandedLoops.has(loopData.mission.id)) continue;
    loopData.recentIterations.forEach((iteration, index) => {
      const data: IterationNodeData = {
        missionId: iteration.id,
        title: missionTitleById.get(iteration.id) ?? `#${iteration.iteration}`,
        status: iteration.status,
        iteration: iteration.iteration,
        loopMissionId: loopData.mission.id,
      };
      extras.push({
        ref: makeRef('iteration', iteration.id),
        type: 'iteration',
        data,
        position: {
          x: child.position.x + ITERATION_NODE_INDENT,
          y: child.position.y + FULL_CARD_MAX_HEIGHT + ITERATION_NODE_GAP + index * (ITERATION_NODE_HEIGHT + ITERATION_NODE_GAP),
        },
      });
    });
  }
  return extras;
}
