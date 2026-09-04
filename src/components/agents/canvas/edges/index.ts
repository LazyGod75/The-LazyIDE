/* edges/index.ts — the React Flow `edgeTypes` map (W1c wires this into
   `<ReactFlow edgeTypes={edgeTypes} .../>`), keyed 'chain' | 'hierarchy'
   per the plan (§ "nodes/index.ts + edges/index.ts export nodeTypes/
   edgeTypes maps ... for W1c").
*/

import type { EdgeTypes } from '@xyflow/react';
import { ChainEdge, conditionLabelKey, conditionStrokeProps, type ChainEdgeData, type ChainFlowEdge } from './ChainEdge';
import { HierarchyEdge, type HierarchyFlowEdge } from './HierarchyEdge';

export { ChainEdge, conditionLabelKey, conditionStrokeProps, HierarchyEdge };
export type { ChainEdgeData, ChainFlowEdge, HierarchyFlowEdge };

export type CanvasFlowEdge = ChainFlowEdge | HierarchyFlowEdge;

export const edgeTypes: EdgeTypes = {
  chain: ChainEdge,
  hierarchy: HierarchyEdge,
};
