/* pending-enrich.ts — deferred-enrichment marker shared by `store` and `serve`.

   Why this exists: a conversation-eligible `store` used to run
   runIncrementalEnrich() + runRecomposeAll() synchronously — on a mature
   brain (~3k notes) that tail measured ~17s + ~12.6s on top of ~4s of
   write/index work, blowing past the 30s ceiling Rust's brain_capture
   puts on every capture child (src-tauri capture.rs). Every capture then
   timed out, retried, timed out again, and finally gave up — the recurring
   `brain.capture_failed` journal events.

   `store --defer-enrich` instead writes this marker into the brain's cache
   dir and returns after the fast path (wikilinks + write + index +
   contradictions). The long-running `serve` sidecar polls the marker and
   runs the same corpus-wide pass where caches are warm and nothing is
   bounded to seconds. The marker is a pure existence flag — the drain is
   corpus-wide, so payload content is diagnostic only. A marker armed while
   no sidecar runs is drained at the next serve boot (startup check). */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../util/config.js';

const MARKER_FILENAME = 'pending-enrich.json';

export function pendingEnrichMarkerPath(): string {
  return join(getConfig().cachePath, MARKER_FILENAME);
}

/** Write the marker (non-atomic write is fine: existence is the whole signal,
 *  and a torn payload is never parsed). Creates the cache dir if missing.
 *  Callers wrap this in try/catch — a marker failure must fall back to the
 *  synchronous path rather than lose the enrichment entirely. */
export function armPendingEnrich(noteId: string): void {
  const dir = getConfig().cachePath;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    pendingEnrichMarkerPath(),
    JSON.stringify({ armedAt: new Date().toISOString(), noteId }),
    'utf8',
  );
}

/** Remove the marker if present; returns true when a drain should run.
 *  Delete-before-work is correct here: the drain pass is corpus-wide, so any
 *  marker armed while the drain runs re-arms for the next interval. */
export function consumePendingEnrich(): boolean {
  const p = pendingEnrichMarkerPath();
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
