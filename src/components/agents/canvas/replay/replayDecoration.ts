/* replayDecoration.ts — Agent Canvas W8d: the read-only overlay that turns
   the LIVE React Flow nodes/edges into "the canvas as it was at instant
   T". Pure functions only (no React) so useCanvasFlowGraph.ts's own memo
   can call these directly and so they're independently unit-testable at
   fleet scale (150+ nodes) without mounting anything.

   Deliberately a SHALLOW overlay over reconciler.ts's own output — never a
   second reconcile, never a canvasStore/agentsStore mutation:
     - a mission/loop node whose mission hasn't appeared yet at T gets
       `canvas-replay-hidden` (replay/replay.css) — the underlying node
       object is otherwise untouched (it still exists in React Flow's
       nodeLookup, so an edge referencing it keeps resolving correctly;
       hiding is CSS-only, never array filtering);
     - a mission/loop node whose mission HAS appeared gets its `data.mission`
       shallow-cloned with status/stage/paused overridden from the replay
       fleet snapshot — every other field (title, model, progress, ...)
       stays whatever the LIVE reconcile produced (spec: replay only time-
       travels status/stage, it doesn't fabricate historical progress%,
       live-action text, etc. that the journal never recorded per-instant);
     - draft/note nodes are never historical facts (a draft is armed-but-
       not-launched, a note is a free-standing annotation) — dimmed via
       `canvas-replay-dim`, never hidden (the brief: "dim drafts/notes");
     - project zones, schedule nodes, and iteration mini-nodes are left
       fully untouched (a zone's own honesty comes from its children, not a
       fact this decorator can independently time-travel without a second
       reconcile — out of scope here, same "out of bounds" note W1a's own
       CONTRACT GAP comments use elsewhere in this directory);
     - a `chain` edge gets `data.firing` OVERRIDDEN (not merged) from the
       replay engine's own `firingChainIds` — while replay is active the
       traveling-dot pulse (ChainEdge.tsx's existing `data?.firing`
       rendering, untouched) reflects ONLY historical fires being scrubbed
       through, never a live real-time fire arriving underneath.
*/

import { parseRef } from '../canvasTypes';
import type { LoopNodeData, MissionNodeData } from '../canvasTypes';
import type { ChainEdgeData } from '../edges/ChainEdge';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../reconciler';
import type { FleetStateEntry } from './replayModel';

const HISTORICAL_NODE_KINDS = new Set(['mission', 'loop']);
const NON_HISTORICAL_NODE_KINDS = new Set(['draft', 'note']);

function withClass(existing: string | undefined, extra: string): string {
  const classes = new Set((existing ?? '').split(' ').filter(Boolean));
  classes.add(extra);
  return [...classes].join(' ');
}

function hasMissionData(data: unknown): data is (MissionNodeData | LoopNodeData) & Record<string, unknown> {
  return typeof data === 'object' && data !== null && 'mission' in data;
}

/** Decorates one node for the current replay instant. Returns the SAME
 *  object reference when nothing needs to change (matches
 *  reconciler.ts's/useCanvasFlowGraph.ts's own referential-stability
 *  convention, so an unaffected node never forces a re-render downstream). */
export function decorateNodeForReplay(
  node: CanvasReactFlowNode,
  fleetState: ReadonlyMap<string, FleetStateEntry>,
): CanvasReactFlowNode {
  const parsed = parseRef(node.id);
  if (!parsed) return node;

  if (HISTORICAL_NODE_KINDS.has(parsed.kind)) {
    const snapshot = fleetState.get(parsed.id);
    if (!snapshot) {
      return { ...node, className: withClass(node.className, 'canvas-replay-hidden') };
    }
    if (!hasMissionData(node.data)) return node;
    const { mission } = node.data;
    if (mission.status === snapshot.status && mission.stage === snapshot.stage && mission.paused === snapshot.paused) {
      return node;
    }
    // Cast justified by the two runtime checks above: `parsed.kind` is
    // 'mission' | 'loop' (both carry a `mission: FleetMission` field per
    // canvasTypes.ts) and `hasMissionData` confirmed `node.data` actually
    // has one — TS's own discriminated union (keyed off the FULL
    // `CanvasReactFlowNode`'s `type` literal) can't follow that narrowing
    // through a generic `parseRef` string check the way it would a direct
    // `node.type === 'mission'` comparison.
    return {
      ...node,
      data: {
        ...node.data,
        mission: { ...mission, status: snapshot.status, stage: snapshot.stage, paused: snapshot.paused },
      },
    } as CanvasReactFlowNode;
  }

  if (NON_HISTORICAL_NODE_KINDS.has(parsed.kind)) {
    return { ...node, className: withClass(node.className, 'canvas-replay-dim') };
  }

  return node;
}

export function decorateNodesForReplay(
  nodes: readonly CanvasReactFlowNode[],
  fleetState: ReadonlyMap<string, FleetStateEntry>,
): CanvasReactFlowNode[] {
  return nodes.map((node) => decorateNodeForReplay(node, fleetState));
}

export function decorateEdgeForReplay(
  edge: CanvasReactFlowEdge,
  firingChainIds: ReadonlySet<string>,
): CanvasReactFlowEdge {
  if (edge.type !== 'chain') return edge;
  const data = edge.data as ChainEdgeData | undefined;
  const shouldFire = firingChainIds.has(edge.id);
  if (Boolean(data?.firing) === shouldFire) return edge;
  return { ...edge, data: { ...(data as ChainEdgeData), firing: shouldFire || undefined } };
}

export function decorateEdgesForReplay(
  edges: readonly CanvasReactFlowEdge[],
  firingChainIds: ReadonlySet<string>,
): CanvasReactFlowEdge[] {
  return edges.map((edge) => decorateEdgeForReplay(edge, firingChainIds));
}
