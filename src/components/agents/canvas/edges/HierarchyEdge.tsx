/* HierarchyEdge.tsx — thin, dotted, low-contrast parent -> child edge for
   orchestrator sub-missions (spec §4.2 "Orchestrator missions ... render
   as child nodes auto-linked to their parent with a thin hierarchy edge,
   distinct from chain edges"). No label, no condition, no interactivity
   beyond React Flow's default edge selection — deliberately the quietest
   edge on the canvas so it never competes visually with a ChainEdge.
*/

import { memo } from 'react';
import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';

export type HierarchyFlowEdge = Edge<Record<string, never>, 'hierarchy'>;

// W5b memo audit — see ChainEdge.tsx's identical comment.
export const HierarchyEdge = memo(function HierarchyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps<HierarchyFlowEdge>) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: 'var(--color-border)',
        strokeWidth: 1,
        strokeDasharray: '1.5 3',
        opacity: 0.7,
      }}
    />
  );
});
