/* terminalActivity.ts — Fix 2 (idle-terminal auto-close): tracks per-
   terminal-surface last-output / last-focused timestamps OUTSIDE
   canvasStore.ts on purpose.

   canvasStore.ts's `surfaces` persist to layout.json on every change
   (canvasPersistence.ts's autosave subscriber) — writing there on every
   single PTY output chunk (a hot path: a build log, `tail -f`, etc. can
   emit dozens of chunks a second) would thrash that autosave for data
   nobody needs to survive a restart anyway (a freshly reopened terminal has
   no "was it idle" history to protect regardless of how active the OLD
   session looked). A plain module-level Map is the same ephemeral-
   bookkeeping convention agentsStore.tsx's own `previewPlaceholderFirstSeenRef`
   already uses for rule (g)'s TTL tracking — just reachable from a leaf
   component (TerminalNode.tsx) instead of computed inside agentsStore.tsx
   itself, since "PTY produced output" is an event that only ever reaches a
   leaf component, never the store.

   Read by fleetHygiene.ts's rule (h) (planIdleTerminalClosure) via
   agentsStore.tsx's runFleetHygieneSweep wiring; written by
   TerminalNode.tsx's onActivity/selected handlers. `clearTerminalActivity`
   MUST be called wherever a surface is actually removed — wired into
   canvasStore.ts's `removeSurface`, the single choke point every removal
   path (manual close, fleet-hygiene sweep) already goes through — so this
   map never keeps growing past what the canvas itself still has open, the
   exact "own unbounded growth" mistake this whole fix is about avoiding.
*/

export interface TerminalActivitySnapshot {
  lastOutputAtMs?: number;
  lastFocusedAtMs?: number;
}

const lastOutputAtMs = new Map<string, number>();
const lastFocusedAtMs = new Map<string, number>();

/** Records real PTY output (TerminalView.tsx's `onActivity` prop — data
 *  FROM the shell process, never the user's own keystrokes). */
export function recordTerminalOutputActivity(surfaceId: string, atMs: number = Date.now()): void {
  lastOutputAtMs.set(surfaceId, atMs);
}

/** Records the surface becoming the selected canvas node — the best
 *  available "the user is looking at/about to use this" proxy (see
 *  HygienePreviewSurface.lastFocusedAtMs's own doc comment in
 *  fleetHygiene.ts). */
export function recordTerminalFocus(surfaceId: string, atMs: number = Date.now()): void {
  lastFocusedAtMs.set(surfaceId, atMs);
}

/** Snapshot for one surface — both fields absent for a surface never
 *  observed by either recorder above. */
export function getTerminalActivity(surfaceId: string): TerminalActivitySnapshot {
  return {
    lastOutputAtMs: lastOutputAtMs.get(surfaceId),
    lastFocusedAtMs: lastFocusedAtMs.get(surfaceId),
  };
}

/** Drops all tracked activity for a surface — call wherever a surface is
 *  actually removed, so this registry never outlives the canvas surfaces it
 *  describes. */
export function clearTerminalActivity(surfaceId: string): void {
  lastOutputAtMs.delete(surfaceId);
  lastFocusedAtMs.delete(surfaceId);
}

/** Test-only reset — mirrors this codebase's other module-level singletons
 *  (e.g. systemPressure.ts's resetSystemPressureForTests): drops every
 *  tracked entry so one test's activity never leaks into the next. */
export function resetTerminalActivityForTests(): void {
  lastOutputAtMs.clear();
  lastFocusedAtMs.clear();
}
