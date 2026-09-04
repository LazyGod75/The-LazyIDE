/* systemPressureShedding.ts — Fix 5 (release valve): systemPressure.ts's
   existing consumers (scheduler.ts throttles new mission launches,
   devPreview.ts skips spawning a new dev server, SystemPressureBadge.tsx
   tells the user) only ever DEFER new work on 'high' pressure — nothing
   actively reduces memory the app is ALREADY holding. This module is that
   missing release valve.

   Wired once for the app's whole lifetime (agentsStore.tsx — the one place
   with both the fleet-hygiene sweep and canvasStoreVanilla in scope), it
   reacts to a transition INTO 'high' (edge-triggered — see shouldShed's own
   doc comment: never re-fires on every ~5s sample while pressure STAYS
   high) by running the actions a caller supplies via `ShedActions`.

   Kept side-effect-injectable (never importing canvasStoreVanilla/
   runFleetHygieneSweep/treeSitterScanner directly) so the policy — WHEN to
   shed — is unit-testable without a real store/Tauri runtime, mirroring
   fleetHygiene.ts's own pure-core convention.

   SAFETY FLOOR: nothing here ever touches an attended surface or a running
   mission's terminal — every action passed in must uphold that itself.
   Idle-terminal closure (fleetHygiene.ts's rule (h), Fix 2) already does:
   it fails closed on unknown activity and never fires within
   idleTerminalTtlMs of the last output OR the last focus. Preview-iframe
   unmounting (PreviewNode.tsx) already does too: it only ever unmounts a
   NOT-attended (not selected/hovered/pinned) preview.
*/

import { subscribeSystemPressure, type PressureLevel } from './systemPressure.js';

export interface ShedActions {
  /** Immediately runs the fleet-hygiene sweep (subject to its own existing
   *  MIN_HYGIENE_SWEEP_INTERVAL_MS anti-thrash floor — this is a trigger,
   *  not a bypass), which includes rule (h)'s idle-terminal closure. */
  runHygieneSweepNow: () => void;
  /** Drops any additional reclaimable, rebuild-on-demand caches (e.g. the
   *  tree-sitter parsed-grammar cache) — best-effort, never required for
   *  correctness; a dropped cache simply refills itself on next use. */
  dropReclaimableCaches: () => void;
}

/**
 * True only on the sample that FIRST observes 'high' after not already
 * being 'high' — an edge, not a level — so a machine that STAYS under
 * pressure for an extended period sheds ONCE, not on every ~5s sample
 * (system_pressure.rs's own SAMPLE_INTERVAL). Re-arms once pressure drops
 * back below 'high', so a LATER re-trip sheds again.
 */
export function shouldShed(previous: PressureLevel, next: PressureLevel): boolean {
  return next === 'high' && previous !== 'high';
}

/**
 * Wires the shedding reaction for the app's whole lifetime. Returns the
 * unsubscribe function (mirrors subscribeSystemPressure's own contract) —
 * call-once, idempotent-by-caller-discipline (same convention as
 * scheduler.ts's ensurePressureWatch: the CALLER only ever invokes this
 * once, from a mount-once effect).
 */
export function startSystemPressureShedding(actions: ShedActions): () => void {
  let previousLevel: PressureLevel = 'normal';
  return subscribeSystemPressure((snapshot) => {
    if (shouldShed(previousLevel, snapshot.level)) {
      actions.runHygieneSweepNow();
      actions.dropReclaimableCaches();
    }
    previousLevel = snapshot.level;
  });
}
