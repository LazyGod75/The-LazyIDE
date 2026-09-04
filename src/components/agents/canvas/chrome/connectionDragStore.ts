/* connectionDragStore.ts — R2b connectionUx §2 "type-aware search-light
   handle feedback" (Langflow's own framing: "single biggest usability
   lift, port verbatim").

   A tiny module-level external store (useSyncExternalStore, no extra
   dependency) rather than a new canvasStore slice: this is PURE transient
   drag-UI state (never persisted, never undo/redo-tracked, irrelevant the
   instant the drag ends) — a second zundo-tracked field would be the
   wrong shape for it (canvasStore.ts's own module header: "NEVER a second
   source of truth" for anything that isn't a real canvas fact).

   Updated exactly TWICE per drag (start/end — see CanvasView.tsx's
   onConnectStart/onConnectEnd), never per pointer-move frame: the
   compatible-target set is a static function of the drag's SOURCE node
   (chainValidation.ts's `validateChain` rules don't depend on where the
   cursor currently is), so computing it once at drag-start and reading it
   from every node's own subscription is cheap even with hundreds of nodes
   — recomputing it per mousemove would not be.
*/

import { useSyncExternalStore } from 'react';
import type { NodeRef } from '../canvasTypes';

export interface ConnectionDragState {
  active: boolean;
  /** Every node ref this drag's source may legally connect to right now
   *  (already passed through `validateChain` — see CanvasView.tsx's
   *  `computeCompatibleTargets`). Never includes the source node itself. */
  compatibleRefs: ReadonlySet<NodeRef>;
}

const IDLE_STATE: ConnectionDragState = { active: false, compatibleRefs: new Set() };

let state: ConnectionDragState = IDLE_STATE;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Call once when a connection drag STARTS (CanvasView.tsx's
 *  onConnectStart) — never on every drag-move frame. */
export function beginConnectionDrag(compatibleRefs: ReadonlySet<NodeRef>): void {
  state = { active: true, compatibleRefs };
  notify();
}

/** Call once when the drag ENDS, regardless of outcome (dropped on a
 *  valid handle, an invalid one, or empty pane) — always returns to idle. */
export function endConnectionDrag(): void {
  state = IDLE_STATE;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConnectionDragState {
  return state;
}

/**
 * Per-node subscription: `undefined` while no drag is in progress (render
 * no extra class, the common case), otherwise 'compatible'/'incompatible'
 * for THIS node ref. Every node kind's own React Flow-registered wrapper
 * (MissionNode/LoopNode/ScheduleNode/DraftNode/RouterNode) calls this with
 * its own stable `NodeRef` (e.g. `makeRef('mission', mission.id)`).
 */
export function useConnectionDragHighlight(nodeRef: NodeRef): 'compatible' | 'incompatible' | undefined {
  const dragState = useSyncExternalStore(subscribe, getSnapshot);
  if (!dragState.active) return undefined;
  return dragState.compatibleRefs.has(nodeRef) ? 'compatible' : 'incompatible';
}

/** Test-only reset — mirrors canvasStore.ts's `_resetCanvasStoreForTests`
 *  convention so a test that exercises a connection drag never leaks
 *  active state into the next test. */
export function _resetConnectionDragForTests(): void {
  state = IDLE_STATE;
  listeners.clear();
}
