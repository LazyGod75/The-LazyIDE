/* dryRunWalk.ts — W8a deliverable #3 (Activepieces-inspired dry-run; the
   UX idea is adapted, the implementation is original): PURE topological
   walk over the chain graph. No React, no store, no I/O — directly
   unit-testable (src/__tests__/canvasDryRun.test.tsx).

   Given the canvas's current nodes + chain edges, produces a deterministic
   animation timeline: every chain-connected draft/mission/loop node gets a
   sequenced highlight step (STAGGER_MS apart, in topological order from
   every root), and every chain edge gets a firing step halfway between its
   source's and target's slots. chainValidation.ts guarantees the persisted
   chain graph is acyclic, but this still guards (Kahn's algorithm — a
   cycle simply leaves its members out and flags `truncated`).
*/

import type { ChainCondition } from '../canvasTypes';

export const STAGGER_MS = 400;

/** The minimal node/edge shape the walk needs — callers project React Flow
 *  nodes/edges down to this (keeps the walk testable with plain objects). */
export interface DryRunNodeInput {
  id: string;
  type?: string;
}

export interface DryRunEdgeInput {
  id: string;
  source: string;
  target: string;
  condition: ChainCondition;
}

export interface DryRunNodeStep {
  id: string;
  /** ms offset from the preview's start. */
  at: number;
}

export interface DryRunEdgeStep {
  id: string;
  source: string;
  target: string;
  condition: ChainCondition;
  at: number;
}

export interface DryRunTimeline {
  nodeSteps: DryRunNodeStep[];
  edgeSteps: DryRunEdgeStep[];
  /** Total ms until the last step lands (for the "done" steady state). */
  totalMs: number;
  /** True when a cycle was detected and its members were left out. */
  truncated: boolean;
}

const CHAINABLE_KINDS = new Set(['draft', 'mission', 'loop']);

/**
 * Kahn's algorithm over the chain subgraph. Roots (no incoming chain edge)
 * are processed in id order for determinism; each processed node takes the
 * next STAGGER_MS slot; an edge fires half a slot after its source.
 */
export function computeDryRunTimeline(
  nodes: readonly DryRunNodeInput[],
  edges: readonly DryRunEdgeInput[],
): DryRunTimeline {
  const chainable = new Set(nodes.filter((n) => CHAINABLE_KINDS.has(n.type ?? '')).map((n) => n.id));
  const participantIds = new Set<string>();
  const validEdges = edges.filter((e) => chainable.has(e.source) && chainable.has(e.target));
  for (const edge of validEdges) {
    participantIds.add(edge.source);
    participantIds.add(edge.target);
  }

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, DryRunEdgeInput[]>();
  for (const id of participantIds) indegree.set(id, 0);
  for (const edge of validEdges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const queue = [...participantIds].filter((id) => (indegree.get(id) ?? 0) === 0).sort();
  const nodeSteps: DryRunNodeStep[] = [];
  const edgeSteps: DryRunEdgeStep[] = [];
  let slot = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    const at = slot * STAGGER_MS;
    nodeSteps.push({ id, at });
    slot += 1;
    for (const edge of outgoing.get(id) ?? []) {
      edgeSteps.push({ id: edge.id, source: edge.source, target: edge.target, condition: edge.condition, at: at + STAGGER_MS / 2 });
      const remaining = (indegree.get(edge.target) ?? 0) - 1;
      indegree.set(edge.target, remaining);
      if (remaining === 0) {
        // Sorted insert keeps sibling order deterministic without a heap.
        const index = queue.findIndex((queued) => queued > edge.target);
        if (index === -1) queue.push(edge.target);
        else queue.splice(index, 0, edge.target);
      }
    }
  }

  const truncated = nodeSteps.length < participantIds.size;
  const lastAt = Math.max(0, ...nodeSteps.map((s) => s.at), ...edgeSteps.map((s) => s.at));
  return { nodeSteps, edgeSteps, totalMs: lastAt + STAGGER_MS, truncated };
}
