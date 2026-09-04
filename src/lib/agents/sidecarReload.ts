/* sidecarReload — reload the brain sidecar after an agent store write.

   Auto-index already restarts the warm sidecar (Rust
   reload_sidecar_after_auto_index). Agent learning paths (brainNotation /
   harness rules / patterns) only `brain.capture` — without a reload the
   warm process can keep serving a pre-store index. This module is the
   agent-side equivalent: debounced, best-effort, never throws.
*/

import { getPlatform } from '../platform/index.js';

export const SIDECAR_RELOAD_DEBOUNCE_MS = 1_500;

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let reloadImpl: (() => Promise<boolean>) | null = null;

/** Test seam — inject a fake reload. */
export function _setSidecarReloadImplForTests(fn: (() => Promise<boolean>) | null): void {
  reloadImpl = fn;
}

/** Test seam — clear pending debounce. */
export function _resetSidecarReloadForTests(): void {
  if (reloadTimer !== null) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  reloadImpl = null;
}

async function defaultReload(): Promise<boolean> {
  try {
    const brain = getPlatform()?.brain;
    if (!brain?.retrySidecar) return false;
    return await brain.retrySidecar();
  } catch {
    return false;
  }
}

/**
 * Schedule a sidecar reload after a successful brain store. Coalesces bursts
 * of agent captures (mission end often writes outcome + pattern + diagnosis)
 * into one restart.
 */
export function scheduleSidecarReloadAfterStore(): void {
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const run = reloadImpl ?? defaultReload;
    void (async () => {
      try {
        await run();
      } catch {
        // best-effort — never surface to callers
      }
    })();
  }, SIDECAR_RELOAD_DEBOUNCE_MS);
}
