/* Mission query / alias / cleanup-scope pure helpers extracted from
   agentsStore.tsx (mechanical move, no behavior change). No closure over
   Provider state or module-level mutable variables. */

import type { Mission } from '../../../lib/agents/types';

export function findLoopMission(missions: readonly Mission[], loopId: string): Mission | undefined {
  const needle = loopId.trim().toLowerCase();
  // TOLOWERCASE-ON-UNDEFINED fix (2026-08-05, real prod crash — "Cannot
  // read properties of undefined (reading 'toLowerCase')"): a journal row
  // for an unarchived, sparsely-written mission (M21/M22-class debris) can
  // reach this array with `title` (or other string fields) absent —
  // String(x ?? '') never throws regardless, same guard as
  // resolveMissionQueryTarget's identical fix below.
  return missions.find(
    (m) =>
      m.loopConfig &&
      (String(m.id ?? '').toLowerCase() === needle || String(m.title ?? '').toLowerCase().includes(needle)),
  );
}

// ── Agent Canvas (W6d) — intra-turn alias resolution ─────────────────────
// A manager reply executes its actions IN ORDER (see the `for` loop in
// sendManagerMessage below) — this per-reply `aliasMap` is what lets a
// LATER action in that same reply (chain_agents/focus_canvas/move_node/
// launch_draft) reference a draft an EARLIER action in the SAME reply just
// created via create_draft's `alias` field (types.ts). The map is a plain
// local `Map`, mutated as the loop runs (not React state) — same pattern
// this file already uses for stopFlags/pauseFlags/interveneQueues (per-run
// scratch registries keyed by id, never persisted, never read outside this
// one turn).

export type AliasRefResolution =
  | { ok: true; ref: string; viaAlias: boolean }
  | { ok: false; reasonKey: string; params: Record<string, string> };

/**
 * Resolves a canvas ref given EITHER directly (`direct`, e.g. `action.ref`/
 * `action.sourceRef`) OR via an intra-turn alias (`alias`, e.g.
 * `action.refAlias`/`action.sourceAlias`) registered earlier in the SAME
 * reply by a `create_draft{alias: ...}` action. `direct` always wins when
 * both happen to be set. An alias that was never registered — unknown, or
 * used BEFORE its create_draft ran (aliases resolve strictly backwards,
 * never forwards) — returns an honest `reasonKey` for the caller to toast,
 * rather than silently no-op-ing (this file's existing error-reporting
 * convention, e.g. `canvas.manager.draftNotFound`/`invalidRef`).
 */
export function resolveAliasedRef(
  direct: string | undefined,
  alias: string | undefined,
  aliasMap: ReadonlyMap<string, string>,
): AliasRefResolution {
  if (direct) return { ok: true, ref: direct, viaAlias: false };
  if (alias) {
    const resolved = aliasMap.get(alias);
    if (resolved) return { ok: true, ref: resolved, viaAlias: true };
    return { ok: false, reasonKey: 'canvas.manager.unknownAlias', params: { alias } };
  }
  return { ok: false, reasonKey: 'canvas.manager.invalidRef', params: { ref: '(no ref or alias given)' } };
}

// ── Canvas cleanup (B2/P0-4) — pure planning helpers ─────────────────────
// clear_canvas needs to compute, for an arbitrary scope, exactly which real
// ids across missions/drafts/notes/surfaces/routers/joins/frames are
// affected — factored out as pure functions (no store/React access) so the
// scope logic is trivially unit-testable in isolation from the executor's
// own store wiring, same "small, cohesive, testable" rule as every other
// module-level helper in this file.

/** Real terminal-status check shared by every new cleanup action below —
 *  same three statuses archiveMission/delete_mission's own terminal guard
 *  already use (kept as its own tiny helper here rather than touching those
 *  pre-existing inline checks). Exported so `planClearCanvas`'s own
 *  scope-to-behavior contract is directly unit-testable (see
 *  clearCanvasScopeCoverage.test.ts) without going through the full store. */
export function isTerminalMissionStatus(status: Mission['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** Missions sitting in 'review' — awaiting a human approve/reject decision,
 *  deliberately NOT terminal (see isTerminalMissionStatus above and
 *  terminationSemantics.test.ts) — that a bulk cleanup scope is about to
 *  leave behind. Shared by `planClearCanvas`'s 'all'/'project'/'terminated'
 *  scopes AND `archive_terminated` (its own doc comment calls it a
 *  convenience shorthand for clear_canvas's 'terminated' scope, so the two
 *  must report this the SAME honest way) so the count/refs a real user sees
 *  can never drift between the two call sites.
 *
 *  P0 fix (real user test): the manager used to promise "les missions en
 *  revue seront archivées" then silently exclude them, and a follow-up bulk
 *  request reported "rien à nettoyer" in front of 27 still-visible
 *  missions — this is the real data behind the honest notice that closes
 *  that gap (see clear_canvas's own executor case below). An already
 *  archived mission is invisible on the board already (same rule as
 *  isTerminalMissionStatus's own archived-filter elsewhere in this file) —
 *  never counted here either. */
export function reviewMissionsAwaitingDecision(missions: readonly Mission[]): Mission[] {
  return missions.filter((m) => m.status === 'review' && !m.archived);
}

/** Real hours-since check for clear_canvas's optional `olderThanHours` —
 *  only ever applied to a Mission (the one cleanup entity with a real
 *  creation timestamp in this codebase — see ClearCanvasSnapshot's own doc
 *  comment). An unknown creation time never "qualifies" as old — honest
 *  exclusion, never a guessed match. */
export function isOlderThanHours(createdAtMs: number | undefined, hours: number | undefined, nowMs: number): boolean {
  if (hours === undefined) return true;
  if (createdAtMs === undefined) return false;
  return nowMs - createdAtMs >= hours * 60 * 60 * 1000;
}

/** True when `entityProjectId` is in scope for the requested
 *  `targetProjectId` — `targetProjectId` undefined means "no project
 *  narrowing" (every project AND the Transverse zone match); a defined
 *  `targetProjectId` requires an EXACT match (a Transverse entity, itself
 *  `undefined`, never matches a specific project). */
export function matchesProjectScope(entityProjectId: string | undefined, targetProjectId: string | undefined): boolean {
  return targetProjectId === undefined || entityProjectId === targetProjectId;
}

/** Compact, capped join of real ids/refs for a cleanup toast — genuine,
 *  verifiable refs, never an unbounded wall of text for a large sweep (the
 *  cap is purely a DISPLAY truncation — the underlying action itself has no
 *  functional cap, every match is still cleared). */
export const MAX_CLEANUP_REFS_IN_TOAST = 6;
export function summarizeIds(ids: readonly string[]): string {
  if (ids.length <= MAX_CLEANUP_REFS_IN_TOAST) return ids.join(', ');
  return `${ids.slice(0, MAX_CLEANUP_REFS_IN_TOAST).join(', ')}, +${ids.length - MAX_CLEANUP_REFS_IN_TOAST}`;
}
