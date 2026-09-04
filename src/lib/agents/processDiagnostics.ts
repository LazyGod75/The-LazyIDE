/* processDiagnostics.ts — typed wrappers around Rust process-health
   diagnostic commands. No UI panel consumes these yet (the "process health
   panel" the counter below was always meant to feed does not exist in the
   app today) — this file only exposes the typed call so a future
   diagnostics surface has a real command to reach for instead of needing
   its own plumbing added later.

   Same graceful-degradation posture as systemPressure.ts: never throws,
   never assumes a real Tauri backend is present (a browser/vitest harness
   session has no Rust process to query). */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../platform/index.js';

/**
 * Process-lifetime count of stdout/stderr drain threads abandoned
 * (detached without being joined) after a bounded post-kill wait expired —
 * see `ABANDONED_DRAIN_THREADS`'s doc comment
 * (src-tauri/src/commands/util.rs). Resolves to 0 outside a real Tauri app
 * or if the command is unavailable/rejects.
 */
export async function getAbandonedDrainThreadCount(): Promise<number> {
  if (!isTauri()) return 0;
  try {
    const count = await invoke<number>('get_abandoned_drain_thread_count');
    return typeof count === 'number' ? count : 0;
  } catch {
    return 0;
  }
}
