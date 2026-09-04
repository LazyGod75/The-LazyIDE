/* brainReachableCache — TTL for the web sidecar reachability probe.

   A sticky `false` after the first failed fetch made `brain.recall` /
   `retrySidecar` permanently empty even after `lazybrain serve` came up.
   Negative cache is short so a sidecar that starts mid-session is seen;
   positive cache is longer so a healthy sidecar is not re-probed every call.
   `force` (retrySidecar) always re-probes.
*/

export const BRAIN_REACHABLE_NEGATIVE_TTL_MS = 2_000;
export const BRAIN_REACHABLE_POSITIVE_TTL_MS = 5_000;

export interface BrainReachableEntry {
  value: boolean;
  atMs: number;
}

/** Cached boolean if still fresh; `null` means the caller must probe. */
export function readBrainReachableCache(
  entry: BrainReachableEntry | null,
  nowMs: number,
  force = false,
): boolean | null {
  if (force || entry === null) return null;
  const ttl = entry.value
    ? BRAIN_REACHABLE_POSITIVE_TTL_MS
    : BRAIN_REACHABLE_NEGATIVE_TTL_MS;
  if (nowMs - entry.atMs >= ttl) return null;
  return entry.value;
}
