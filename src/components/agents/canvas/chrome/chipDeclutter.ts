/* chipDeclutter.ts — fix/canvas-legibility: pure declutter algorithm for
   the mission billboard-chip tier (MissionNode.tsx's 'chip' zoom bucket,
   see canvasTypes.ts's ZOOM_CHIP). At extreme dezoom every mission chip is
   rendered at a CONSTANT screen size (chrome/lod.ts's
   MISSION_CHIP_LOD_TARGET_PX) — a dense zone can pack more chips than the
   screen has room to show without them visually overlapping. Rather than
   hiding chips by fleet-wide urgent rank (the OLD behavior this plan
   explicitly replaces — "3 labels visible out of 12" is exactly the
   legibility bug), this buckets chips into a coarse screen-space grid and
   keeps at most one chip per cell, picking the highest-PRIORITY occupant —
   every mission still gets a chance to be the one shown, not just the
   fleet's top-3 urgent.

   Pure, no React/DOM — directly unit-testable (see
   src/__tests__/chipDeclutter.test.ts) independent of CanvasLodBroadcaster's
   own viewport-reading glue.
*/

export interface ChipCandidate {
  id: string;
  screenX: number;
  screenY: number;
  priority: number;
}

/** Lower number = higher priority (kept first on a cell collision). A
 *  mission awaiting a human decision (failed / pendingQuestion) must never
 *  lose a screen-space fight to a merely-running one. */
export const CHIP_PRIORITY = {
  failed: 0,
  decision: 1,
  running: 2,
  queued: 3,
  done: 4,
} as const;

export type ChipPriorityKind = keyof typeof CHIP_PRIORITY;

/** Screen-space footprint one chip claims for collision purposes — the
 *  billboard chip's own constant on-screen size (chrome/lod.ts's
 *  MISSION_CHIP_LOD_TARGET_PX) plus a little breathing room, and a fixed
 *  row height (chips are short/wide, not square). */
export const CHIP_CELL_WIDTH = 140;
export const CHIP_CELL_HEIGHT = 32;

/**
 * Buckets `candidates` into a `cellPx`-wide (x) / CHIP_CELL_HEIGHT-tall (y)
 * screen-space grid; within a colliding cell, the LOWEST-priority-number
 * candidate wins and every other occupant of that cell is marked hidden.
 * Deterministic (stable sort by priority, ties broken by input order) —
 * calling this twice with the same input always yields the same result, no
 * randomness/Date.now dependency.
 */
export function computeChipVisibility(
  candidates: readonly ChipCandidate[],
  cellPx: number = CHIP_CELL_WIDTH,
): Map<string, boolean> {
  const sorted = [...candidates].sort((a, b) => a.priority - b.priority);
  const claimed = new Map<string, boolean>();
  const cells = new Set<string>();
  for (const c of sorted) {
    const key = `${Math.round(c.screenX / cellPx)}:${Math.round(c.screenY / CHIP_CELL_HEIGHT)}`;
    if (cells.has(key)) {
      claimed.set(c.id, false);
      continue;
    }
    cells.add(key);
    claimed.set(c.id, true);
  }
  return claimed;
}
