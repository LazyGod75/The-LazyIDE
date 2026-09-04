/* IterationNode.tsx — W8a deliverable #2 (loop expand-in-place,
   Dify-inspired UX reimplemented): a READ-ONLY mini card projecting one of
   an expanded loop's last-3 iterations as a real canvas node (status dot +
   title + iteration number). Emitted by reconciler.ts only while the
   parent loop is in canvasStore's `expandedLoops`; positioned under the
   loop, non-draggable (reconciler sets `draggable: false`), linked to the
   loop by a hierarchy edge.

   Clicking it opens the iteration's own MissionDetail through the SAME
   real handler the loop's inline chips already use
   (CanvasActionsContext.onOpenIteration) — no new primitive.

   No Handles: an iteration is never a chain endpoint (chainValidation.ts
   rejects the kind), so rendering connection dots would only advertise an
   affordance that always refuses.

   ── W-CARDS (founder, 2026-07-21) — no more zoom-driven dot swap ───────
   The R1b defect #7 "fix" (kept below for history) gave this card a
   `zoom === 'chip'` early-return that swapped it for a constant-size
   status dot below ZOOM_CHIP. That is exactly the "swap to a compact
   variant by zoom" pattern the founder's rule bans: every node must scale
   naturally with the canvas, the same one full layout at every zoom, like
   MissionNode.tsx. Removed — this card no longer reads the viewport zoom
   at all; it shrinks/grows visually with React Flow's own transform like
   any other node, never semantically collapsing.

   ── R1b defect #7 (superseded by the above, kept for history) ──────────
   Real-gesture triage at zoom 0.40 (< ZOOM_DOT 0.45) found a shrunken,
   illegible pill instead of a 20px type+status dot. Root cause: this was
   the ONE node kind that never called `useZoomLevel()` at all. The fix
   at the time gave it a dot branch matching every other kind's; the
   founder's rule above now retires that convention everywhere instead.
*/

import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { IterationNodeData } from '../canvasTypes';
import { useCanvasActions } from '../chrome/CanvasActionsContext';
import { deriveMissionLiveness, statusAccentColor } from '../chrome/nodeChrome';
import type { CanvasZoomLevel } from '../chrome/useZoomLevel';
import { ITERATION_NODE_HEIGHT, ITERATION_NODE_WIDTH } from '../reconciler';

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type IterationFlowNode = Node<IterationNodeData & Record<string, unknown>, 'iteration'>;

interface IterationNodeCardProps {
  data: IterationNodeData;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full
   *  layout regardless of zoom (see this file's own header). */
  zoomLevel?: CanvasZoomLevel;
  selected?: boolean;
}

export function IterationNodeCard({ data, selected }: IterationNodeCardProps) {
  const actions = useCanvasActions();
  const statusColor = statusAccentColor(deriveMissionLiveness({ status: data.status, paused: false }));

  return (
    <button
      type="button"
      data-testid={`iteration-node-${data.missionId}`}
      className="nodrag"
      title={data.title}
      onClick={(e) => {
        e.stopPropagation();
        actions.onOpenIteration(data.missionId);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        width: ITERATION_NODE_WIDTH,
        height: ITERATION_NODE_HEIGHT,
        padding: '0 10px',
        borderRadius: 8,
        border: selected ? '1px solid var(--color-accent)' : '1px solid var(--color-border-3)',
        background: 'var(--color-panel-3)',
        color: 'var(--color-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        textAlign: 'left',
      }}
    >
      <span
        data-testid="iteration-node-status-dot"
        style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }}
      />
      <span
        data-testid="iteration-node-title"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {data.title}
      </span>
      <span
        data-testid="iteration-node-number"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-disabled)', flexShrink: 0 }}
      >
        #{data.iteration}
      </span>
    </button>
  );
}

export const IterationNode = memo(function IterationNode({ data, selected }: NodeProps<IterationFlowNode>) {
  return <IterationNodeCard data={data} selected={selected} />;
});
