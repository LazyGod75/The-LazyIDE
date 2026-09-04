/* prefetchLazySpaces — warm Code/Brain/Team/Settings chunks after first paint.

   First click on those tabs currently waits on the lazy() import (full-screen
   spinner). Scheduling the same dynamic imports on idle means a later click
   hits a warmed module cache. SpacesLayer still mounts on first visit only.
*/

const IDLE_TIMEOUT_MS = 2500;
const TIMEOUT_FALLBACK_MS = 400;

export function loadLazySpaceChunks(): void {
  void import('../spaces/CodeSpace');
  void import('../spaces/BrainSpace');
  void import('../spaces/TeamSpace');
  void import('../spaces/SettingsSpace');
}

/** Returns a cancel function. Uses requestIdleCallback when present. */
export function scheduleLazySpacePrefetch(load: () => void = loadLazySpaceChunks): () => void {
  const ric = globalThis.requestIdleCallback;
  if (typeof ric === 'function') {
    const id = ric(() => { load(); }, { timeout: IDLE_TIMEOUT_MS });
    return () => globalThis.cancelIdleCallback(id);
  }
  const timer = globalThis.setTimeout(load, TIMEOUT_FALLBACK_MS);
  return () => globalThis.clearTimeout(timer);
}
