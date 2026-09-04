/* canvasFrameSelection.ts — W-CLOSE row 2 (canvas scorecard "n8n Canvas
   Groups" parity gap): pure bbox math for "Encadrer la sélection"
   (CanvasContextMenu.tsx). Extracted from the menu component so the actual
   geometry (mixed-zone filtering, padding, title-bar reservation) is
   directly unit-testable without rendering the whole context menu.
*/

/** The minimal shape this module needs from a reconciled React Flow node —
 *  see reconciler.ts's `CanvasReactFlowNode` for the real (superset) type. */
export interface FrameableNode {
  id: string;
  parentId?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
}

export interface FrameSelectionBBox {
  /** Resolved via `resolveProjectId` — `undefined` for a Transverse-owned
   *  frame, same convention as every other canvas-owned fact. */
  projectId?: string;
  /** Zone-relative (or absolute, for Transverse) top-left corner, already
   *  padded and offset up by the title-bar reservation. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Computes the frame's bounding box from a multi-selection. Uses the FIRST
 * selected node's zone as the frame's own zone (same "not specially
 * normalized for a mixed-zone selection" documented limitation
 * canvasMacros.ts's `captureMacro` already established for macro capture) —
 * every OTHER selected node belonging to a different zone is excluded from
 * the bbox math, never crashes, never silently reframes the wrong zone.
 * Returns `null` for an empty selection (nothing to frame).
 */
export function computeFrameSelectionBBox(
  selected: readonly FrameableNode[],
  resolveProjectId: (parentId: string | undefined) => string | undefined,
  padding: number,
  titleBarHeight: number,
): FrameSelectionBBox | null {
  if (selected.length === 0) return null;

  const anchorParentId = selected[0]!.parentId;
  const grouped = selected.filter((n) => n.parentId === anchorParentId);

  const minX = Math.min(...grouped.map((n) => n.position.x));
  const minY = Math.min(...grouped.map((n) => n.position.y));
  const maxX = Math.max(...grouped.map((n) => n.position.x + (n.width ?? 0)));
  const maxY = Math.max(...grouped.map((n) => n.position.y + (n.height ?? 0)));

  return {
    projectId: resolveProjectId(anchorParentId),
    x: minX - padding,
    y: minY - padding - titleBarHeight,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2 + titleBarHeight,
  };
}
