/* canvasArrowNav.ts — W-CLOSE row 1 (canvas scorecard "should-have #2,
   keyboard-first node navigation", n8n parity gap). Pure spatial-navigation
   math only: no React, no React Flow, no store — callers (useCanvasKeyboard.ts
   via CanvasView.tsx) resolve each candidate's real ABSOLUTE bounds via
   ReactFlowInstance.getNodesBounds(id) first (handles zone-relative child
   coordinates correctly, including nested parenting) and pass plain
   { id, bounds } pairs in here.

   This is the row the scorecard flagged as "not fixed this pass" (the prior
   wave's own note: "re-enabling risks reintroducing the documented Escape
   bug" — CanvasContextMenu's right-click-then-Escape regression, tied to
   React Flow's OWN built-in arrow-key node move via `disableKeyboardA11y`).
   That regression risk is specific to flipping the blanket a11y flag back on
   — this module does NOT touch it (CanvasView.tsx still sets
   `disableKeyboardA11y`, unchanged): arrow-key nav here is a SEPARATE,
   hand-rolled implementation living entirely in useCanvasKeyboard.ts's own
   single window-level keydown listener, gated the same way every other
   mutation/selection shortcut in that file already is (isEditableTarget bail,
   replay gating for the mutating Shift+Arrow nudge — see that hook's own
   wiring). Nothing here re-enables React Flow's native keyboard handling.
*/

export type ArrowDirection = 'up' | 'down' | 'left' | 'right';

/** Absolute flow-space bounds (ReactFlowInstance.getNodesBounds' own return
 *  shape — a plain axis-aligned rect, already resolved past any parent
 *  nesting). */
export interface NavBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NavCandidate {
  id: string;
  bounds: NavBounds;
}

/** How much a candidate's off-axis (perpendicular) offset counts against it
 *  relative to its on-axis distance — tuned so a node roughly "in line"
 *  wins over a much-closer node that's mostly off to the side, without
 *  needing a hard 45-degree cone (which would leave gaps in a loosely
 *  aligned grid — real canvas layouts are never perfectly gridded). */
const SECONDARY_AXIS_PENALTY = 2;

function centerOf(bounds: NavBounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/**
 * Finds the candidate nearest `current` in the given cardinal `direction`,
 * using a simple weighted primary/secondary-axis distance heuristic. Only
 * candidates strictly on the correct side of `current` along the primary
 * axis are considered (a candidate exactly level, dx/dy === 0, never
 * matches — there is no "nearest" among ties on the wrong axis). Returns
 * `null` when no candidate qualifies (nothing that way, or an empty list).
 * Deterministic: the first strictly-lowest-scoring candidate in input order
 * wins ties.
 */
export function findNearestNodeInDirection(
  current: NavBounds,
  candidates: readonly NavCandidate[],
  direction: ArrowDirection,
): string | null {
  const from = centerOf(current);
  let bestId: string | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const to = centerOf(candidate.bounds);
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    let primary: number;
    let secondary: number;
    if (direction === 'right') {
      if (dx <= 0) continue;
      primary = dx;
      secondary = dy;
    } else if (direction === 'left') {
      if (dx >= 0) continue;
      primary = -dx;
      secondary = dy;
    } else if (direction === 'down') {
      if (dy <= 0) continue;
      primary = dy;
      secondary = dx;
    } else {
      if (dy >= 0) continue;
      primary = -dy;
      secondary = dx;
    }

    const score = primary + Math.abs(secondary) * SECONDARY_AXIS_PENALTY;
    if (score < bestScore) {
      bestScore = score;
      bestId = candidate.id;
    }
  }

  return bestId;
}
