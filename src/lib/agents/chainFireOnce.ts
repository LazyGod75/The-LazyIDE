/* chainFireOnce — exactly-once stamp for chain fires (join reconcile + live).

   A join's outgoing fire stamps lastFiredAtMs with the LAST source's
   journal updatedMs. Re-deriving the same completions must not launch
   again. Live fires use Date.now() which is strictly later than a prior
   stamp, so a genuine later completion still fires.
*/

export function shouldSkipAlreadyFired(lastFiredAtMs: number | undefined, effectiveMs: number): boolean {
  return lastFiredAtMs !== undefined && effectiveMs <= lastFiredAtMs;
}
