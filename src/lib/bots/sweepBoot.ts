/* sweepBoot — wires Solari's orphan session sweep to app boot.

   On app startup, calls sweepOrphans() to clean up any Solari sessions
   (browser/desktop/sandbox) that were left open by a crashed previous run.
   This prevents orphaned cloud sessions from accumulating and costing money.

   The sweep is fire-and-forget — it should never block app startup. Errors
   are logged but not thrown.
*/

import { sweepOrphans } from '../solari/solariSessions.js';

let swept = false;

/** Run the orphan sweep once at app boot. Idempotent — calling it multiple
 *  times is safe but only the first call actually sweeps. */
export async function bootSweepOrphans(): Promise<void> {
  if (swept) return;
  swept = true;
  try {
    await sweepOrphans();
  } catch (err) {
    console.error('[sweepBoot] orphan sweep failed:', err);
  }
}

/** Reset the swept flag — tests only. */
export function resetSweepBoot(): void {
  swept = false;
}
