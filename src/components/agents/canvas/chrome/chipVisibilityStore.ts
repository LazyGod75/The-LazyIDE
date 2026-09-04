/* chipVisibilityStore.ts — fix/canvas-legibility: tiny module-level
   external store (useSyncExternalStore, no extra dependency) holding which
   mission billboard chips are currently visible vs. folded into their
   zone's "N replié(e)s" counter (chipDeclutter.ts's computeChipVisibility
   result). Same rationale as chrome/connectionDragStore.ts's identical
   pattern: this is PURE derived UI state (recomputed from the live
   viewport, never persisted, never undo/redo-tracked) — a zustand/
   canvasStore slice would be the wrong shape for it.

   Per-KEY subscription (not one big object) so only the chip whose own
   visibility actually flipped re-renders — CanvasLodBroadcaster.tsx
   recomputes the whole Map on its debounced effect, but `notify()` only
   fires listeners whose id's visibility value actually changed between the
   previous and next Map (see `setVisibility` below), same discipline
   useZoomLevel's Object.is-on-bucket subscription already follows.
*/

import { useSyncExternalStore } from 'react';

let visibility: ReadonlyMap<string, boolean> = new Map();
/** Folded (hidden) chip count per zone (projectId) — the zone header's
 *  "N repliés" badge reads this directly rather than recomputing it from
 *  `visibility` + a separate id->projectId lookup on every render. */
let foldedCountByZone: ReadonlyMap<string, number> = new Map();
const listeners = new Map<string, Set<() => void>>();

function notifyChanged(changedIds: ReadonlySet<string>): void {
  for (const id of changedIds) {
    const set = listeners.get(id);
    if (!set) continue;
    for (const listener of set) listener();
  }
}

/**
 * Replaces the whole visibility snapshot (CanvasLodBroadcaster.tsx's
 * debounced declutter effect, chip tier only) — only listeners for an id
 * whose boolean actually flipped are notified.
 */
export function setChipVisibility(next: ReadonlyMap<string, boolean>, foldedByZone: ReadonlyMap<string, number>): void {
  const changed = new Set<string>();
  for (const [id, value] of next) {
    if (visibility.get(id) !== value) changed.add(id);
  }
  for (const id of visibility.keys()) {
    if (!next.has(id)) changed.add(id);
  }
  for (const [projectId, count] of foldedByZone) {
    if (foldedCountByZone.get(projectId) !== count) changed.add(zoneListenerKey(projectId));
  }
  for (const projectId of foldedCountByZone.keys()) {
    if (!foldedByZone.has(projectId)) changed.add(zoneListenerKey(projectId));
  }
  visibility = next;
  foldedCountByZone = foldedByZone;
  notifyChanged(changed);
}

/** Namespaced listener key for a zone's folded-count subscription — mission
 *  chip ids are already NodeRef-shaped (`mission:<id>`, set by the
 *  broadcaster's `node.id`), so a raw project id can never collide with one
 *  in practice; this prefix makes that guarantee explicit rather than
 *  implicit. */
function zoneListenerKey(projectId: string): string {
  return `zone-folded:${projectId}`;
}

/** Clears every stored entry (e.g. leaving the chip tier entirely) — every
 *  mission reads back as "visible" (the safe default: `useChipVisible`
 *  treats an absent id as visible, see below) once nothing is tracked. */
export function clearChipVisibility(): void {
  const changed = new Set(visibility.keys());
  visibility = new Map();
  foldedCountByZone = new Map();
  notifyChanged(changed);
}

function subscribe(id: string, listener: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(id);
  };
}

/**
 * Per-mission subscription: `true` (visible) whenever the store has no
 * opinion for this id (outside the chip tier, or a chip the declutter pass
 * hasn't evaluated yet — never hide a mission by default) or the last
 * computed visibility was true; `false` only when the declutter pass
 * explicitly folded it into its zone's counter.
 */
export function useChipVisible(missionId: string): boolean {
  return useSyncExternalStore(
    (listener) => subscribe(missionId, listener),
    () => visibility.get(missionId) ?? true,
  );
}

/** Folded chip count for a zone's header badge (ZoneChipFoldBadge) — 0 when
 *  nothing is folded there (or the declutter pass hasn't run for this
 *  zone), never negative. */
export function getFoldedCountForZone(projectId: string): number {
  return foldedCountByZone.get(projectId) ?? 0;
}

/** Reactive per-zone subscription — ZoneChipFoldBadge re-renders only when
 *  ITS OWN zone's folded count actually changes, same per-key discipline as
 *  {@link useChipVisible}. */
export function useFoldedChipCount(projectId: string): number {
  return useSyncExternalStore(
    (listener) => subscribe(zoneListenerKey(projectId), listener),
    () => foldedCountByZone.get(projectId) ?? 0,
  );
}

/** Test-only reset — mirrors connectionDragStore.ts's
 *  `_resetConnectionDragForTests` convention. */
export function _resetChipVisibilityForTests(): void {
  visibility = new Map();
  foldedCountByZone = new Map();
  listeners.clear();
}
