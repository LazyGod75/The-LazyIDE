/* canvasGesturePause — module-scope pub/sub for "the canvas viewport is
   mid-pan/zoom". PreviewNode used to call `useViewport()` itself, which
   re-renders EVERY preview card on every RAF tick of a gesture. The Lod
   broadcaster already pays that subscription once; it notifies this store,
   and PreviewNode only re-renders on the paused true/false edges (two
   commits per gesture, not one per frame).

   Deliberately NOT `useOnViewportChange`: that xyflow hook writes a SINGLE
   shared store slot, so N mounted cards would clobber each other — same
   reason previewLiveCoordinator.ts exists. */

import { useSyncExternalStore } from 'react';

/** How long AFTER the viewport last stopped changing before the pause
    lifts. Same debounced-settle idiom CanvasLodBroadcaster already uses. */
export const GESTURE_PAUSE_TAIL_MS = 500;

let paused = false;
let primed = false;
let tailTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  emit();
}

/** Called from CanvasLodBroadcaster on every live viewport tick.
    The first call after a reset is the mount read — not a gesture. */
export function notifyCanvasViewportMoving(): void {
  if (!primed) {
    primed = true;
    return;
  }
  setPaused(true);
  if (tailTimer !== null) clearTimeout(tailTimer);
  tailTimer = setTimeout(() => {
    tailTimer = null;
    setPaused(false);
  }, GESTURE_PAUSE_TAIL_MS);
}

export function subscribeCanvasGesturePause(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => { listeners.delete(onStoreChange); };
}

export function getCanvasGesturePaused(): boolean {
  return paused;
}

export function useCanvasGesturePause(): boolean {
  return useSyncExternalStore(
    subscribeCanvasGesturePause,
    getCanvasGesturePaused,
    () => false,
  );
}

/** Test-only: drop listeners/timers so later cases don't inherit a pause. */
export function _resetCanvasGesturePauseForTests(): void {
  if (tailTimer !== null) clearTimeout(tailTimer);
  tailTimer = null;
  paused = false;
  primed = false;
  listeners.clear();
}
