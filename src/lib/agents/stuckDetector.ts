/* stuckDetector.ts — pattern-based stuck-loop detector for the managed
   agent loop (managedAgent.ts).

   2026-08-15 (harness hardening pass, task #4 — see
   scratch/_harness-research.md): a stuck detector runs by
   default over 5 patterns (repeated action-observation >=4x, repeated
   action-error >=3x, consecutive monologues >=3, alternating patterns
   >=6 cycles, context-window errors) and would have caught our M6
   incident ("Could not parse agent response" repeated) in a few
   iterations instead of grinding to MAX_CONSECUTIVE_FAILURES. This module
   implements the two patterns the task calls out as the minimum bar:

     1. repeated-identical-failure — the SAME action keeps producing an
        ERROR observation, `identicalFailureThreshold` times within the
        recent window. Deliberately NOT the same signal as managedAgent.ts's
        own `consecutiveFailures` (V4) counter: that counter resets to 0 on
        ANY successful step, so an agent alternating a failing edit_file
        with an unrelated successful read_file (edit_file error, read_file
        ok, edit_file error, read_file ok, ...) never trips it — the exact
        interleaved-failure shape this pattern catches instead, by counting
        per-ACTION failures across the whole window regardless of what
        happened in between.

     2. repeated-action-observation — the exact same (action, args,
        observation) triple recurs `repeatedObservationThreshold` times —
        the agent is making no forward progress even on calls that
        nominally "succeed" (e.g. re-reading the same file and getting the
        same content back, over and over).

   Deliberately does NOT reimplement loopGuard.ts's stall NUDGE (no file-
   modifying progress in N calls) — that is a softer, still-useful signal
   already wired into managedAgent.ts and stays as a corrective nudge, not
   an abort. This module is for the harder, unambiguous case: abort the
   mission with a clear reason instead of grinding, per the task's explicit
   requirement ("abort the mission with a clear reason rather than
   grinding").

   Pure, dependency-free, fully unit-tested (see
   __tests__/stuckDetector.test.ts).
*/

export interface AgentStepRecord {
  action: string;
  /** Canonicalized args (e.g. JSON.stringify) — used only for the
   *  repeated-action-observation signature, not compared structurally. */
  argsSignature: string;
  observation: string;
  isError: boolean;
}

export type StuckReason = 'repeated_identical_failure' | 'repeated_action_observation';

export interface StuckVerdict {
  stuck: boolean;
  reason?: StuckReason;
  message: string;
}

export interface StuckDetectorOptions {
  /** How many of the most recent steps to inspect (default 10). */
  window?: number;
  /** Per-action ERROR count within the window that trips pattern 1 (default 3). */
  identicalFailureThreshold?: number;
  /** Exact (action, args, observation) repeat count that trips pattern 2 (default 4). */
  repeatedObservationThreshold?: number;
}

/** Length cap on the observation slice used for the repeated-observation
 *  signature — long observations still compare equal on their meaningful
 *  prefix without inflating the signature map with near-duplicates. */
const OBSERVATION_SIGNATURE_LEN = 300;

/**
 * Inspects the most recent step records for either stuck pattern. Returns
 * the FIRST pattern found (identical-failure checked before
 * repeated-observation) — a mission stuck on a hard failure loop should be
 * reported as exactly that, not as a generic "no progress" message.
 */
export function detectStuckPattern(
  history: readonly AgentStepRecord[],
  opts: StuckDetectorOptions = {},
): StuckVerdict {
  const window = opts.window ?? 10;
  const identicalFailureThreshold = opts.identicalFailureThreshold ?? 3;
  const repeatedObservationThreshold = opts.repeatedObservationThreshold ?? 4;

  const recent = history.slice(-window);

  // Pattern 1 — repeated-identical-failure (same ACTION erroring repeatedly,
  // not necessarily consecutively).
  const failureCounts = new Map<string, number>();
  for (const rec of recent) {
    if (!rec.isError) continue;
    failureCounts.set(rec.action, (failureCounts.get(rec.action) ?? 0) + 1);
  }
  for (const [action, count] of failureCounts) {
    if (count >= identicalFailureThreshold) {
      return {
        stuck: true,
        reason: 'repeated_identical_failure',
        message: `"${action}" has failed ${count} times in the last ${recent.length} steps — the same approach keeps not working`,
      };
    }
  }

  // Pattern 2 — repeated-action-observation (no forward progress even on
  // "successful" calls).
  const cycleCounts = new Map<string, { action: string; count: number }>();
  for (const rec of recent) {
    const key = `${rec.action} ${rec.argsSignature} ${rec.observation.slice(0, OBSERVATION_SIGNATURE_LEN)}`;
    const existing = cycleCounts.get(key);
    cycleCounts.set(key, { action: rec.action, count: (existing?.count ?? 0) + 1 });
  }
  for (const { action, count } of cycleCounts.values()) {
    if (count >= repeatedObservationThreshold) {
      return {
        stuck: true,
        reason: 'repeated_action_observation',
        message: `the same "${action}" call and result repeated ${count} times — no forward progress`,
      };
    }
  }

  return { stuck: false, message: '' };
}
