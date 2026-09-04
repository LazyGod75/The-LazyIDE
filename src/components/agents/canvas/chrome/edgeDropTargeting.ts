/* edgeDropTargeting.ts — pure helpers shared by the two connectionUx
   features that both need "which existing nodes can THIS source legally
   chain to right now": the search-light highlight (chrome/
   connectionDragStore.ts) and the edge-drop node picker's own validation
   of the freshly-created target (CanvasView.tsx's `handleEdgeDropSelect`
   still calls the real `validateChain` for the ACTUAL new node — this
   module only covers the "highlight existing nodes" half).

   Zero React, zero canvasStore — same "pure lib, caller wires it to
   state" convention chainValidation.ts itself already establishes, so
   this is independently unit-testable against plain fixture nodes/chains.
*/

import { validateChain, type ChainTargetInfo } from '../chainValidation';
import type { Chain, MissionNodeData, NodeRef } from '../canvasTypes';

/** The minimal shape this module needs from a live React Flow node —
 *  deliberately narrower than `CanvasReactFlowNode` (reconciler.ts) so
 *  this file has no reconciler/React Flow import at all. */
export interface TargetableNode {
  id: NodeRef;
  type?: string;
  data: unknown;
}

function targetInfoFor(node: TargetableNode): ChainTargetInfo {
  if (node.type === 'mission') {
    return { kind: 'mission', missionStatus: (node.data as MissionNodeData).mission.status };
  }
  return { kind: (node.type ?? 'draft') as ChainTargetInfo['kind'] };
}

/**
 * Every node ref `sourceRef` may legally chain to right now, given the
 * existing `chains` graph — same `validateChain` rules the real connect
 * handlers already enforce (useCanvasChainConnect.ts), just evaluated
 * against every live node up front instead of one hovered handle at a
 * time. `sourceRef` itself is never included (self-chains are always
 * rejected by `validateChain`, so it would never appear anyway, but this
 * is explicit rather than relying on that side effect).
 */
export function computeCompatibleTargets(
  chains: readonly Chain[],
  sourceRef: NodeRef,
  nodes: readonly TargetableNode[],
): ReadonlySet<NodeRef> {
  const compatible = new Set<NodeRef>();
  for (const node of nodes) {
    if (node.id === sourceRef) continue;
    if (validateChain(chains, sourceRef, node.id, targetInfoFor(node)).ok) {
      compatible.add(node.id);
    }
  }
  return compatible;
}
