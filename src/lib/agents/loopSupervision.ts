/* loopSupervision.ts — Rule (i) of the fleet-hygiene sweep: autonomous-loop
   supervision (spec §4.4 "Supervision continue"). Extracted from
   fleetHygiene.ts to keep that file under this codebase's file-size
   convention (200-400 lines typical, 800 max) — re-exported from there so
   every existing `import ... from './fleetHygiene'` call site (and test)
   keeps working unchanged.

   The founder's own framing: "le LazyManager doit pouvoir revoir
   périodiquement ses boucles autonomes (tournent-elles, une étape échoue-
   t-elle en boucle, la mesure décroche-t-elle) et intervenir ou alerter." —
   this rule is deliberately meant to run inside the SAME fleet-hygiene sweep
   (planFleetHygiene) rather than a second timer/poll, per the task's own
   instruction to branch onto the existing fleet-signal cadence instead of
   building a competing mechanism (see agentsStore.tsx's
   `runLoopSupervisionSweep` wiring).

   Pure function over plain data — no I/O, no journal/canvas imports — same
   "unit-testable in isolation" convention as every other fleetHygiene.ts
   rule (see src/__tests__/fleetHygiene.test.ts's `planLoopSupervision`
   describe block).
*/

/** A registered loop's hygiene-relevant fields — mirrors loopEngine.ts's
 *  `PersistedLoop` structurally (a real one satisfies this by structural
 *  typing) plus caller-computed derived signals this pure module has no way
 *  to derive itself (consecutive failures need the mission list; metric
 *  decline needs loopMetrics.ts's synthesis) — see agentsStore.tsx's wiring
 *  for how a real loop is mapped onto this shape. */
export interface HygieneLoop {
  missionId: string;
  title: string;
  enabled: boolean;
  /** Epoch ms this loop was next due to fire, when known. */
  nextRunAtMs?: number;
  /** The loop's own cadence, in ms — the unit "how overdue" is measured
   *  against. */
  cadenceMs: number;
  /** Iteration missions immediately preceding now that ended 'failed', most
   *  recent streak only (resets to 0 the instant a non-failed iteration
   *  intervenes) — the caller's own real signal for "une étape échoue-t-elle
   *  en boucle". */
  consecutiveFailures: number;
  /** True when the caller's own metric synthesis (loopMetrics.ts) found a
   *  real decline for this loop's named learning measure. Absent (no
   *  measure declared, or not enough history yet) is never treated as a
   *  decline — same "unknown -> never guess" convention as every other rule
   *  in fleetHygiene.ts. */
  metricDeclined?: boolean;
}

export type LoopSupervisionReason = 'stalled' | 'repeated_failure' | 'metric_decline';

export interface LoopSupervisionAlert {
  missionId: string;
  title: string;
  reason: LoopSupervisionReason;
  detail: string;
}

/** A loop is considered "stalled" once it has sat overdue for this many
 *  multiples of its own cadence — deliberately generous (never flags a loop
 *  that is merely running a little behind, e.g. the fleet was momentarily
 *  saturated) — the same "never a false positive" posture as fleetHygiene.ts
 *  rule (a)'s grace period. */
export const STALLED_OVERDUE_CADENCE_MULTIPLIER = 3;

/** How many consecutive failed iterations count as "échoue en boucle" —
 *  one bad run is noise, three in a row with no success between them is a
 *  real pattern worth surfacing. */
export const REPEATED_FAILURE_THRESHOLD = 3;

/**
 * Rule (i): which enabled, registered loops deserve the manager's attention
 * right now. At most ONE alert per loop per sweep, most-actionable reason
 * first (a loop that is both failing repeatedly AND technically overdue is
 * reported as 'repeated_failure' — the more informative diagnosis) —
 * mirrors fleetHygiene.ts rule (b)/(c)'s own "one reason wins" convention
 * for failed missions. A disabled loop is never inspected (nothing to
 * supervise in an already-paused regime).
 */
export function planLoopSupervision(
  loops: readonly HygieneLoop[],
  nowMs: number,
): LoopSupervisionAlert[] {
  const alerts: LoopSupervisionAlert[] = [];
  for (const loop of loops) {
    if (!loop.enabled) continue;

    if (loop.consecutiveFailures >= REPEATED_FAILURE_THRESHOLD) {
      alerts.push({
        missionId: loop.missionId,
        title: loop.title,
        reason: 'repeated_failure',
        detail: `${loop.consecutiveFailures} echecs consecutifs`,
      });
      continue;
    }

    if (loop.metricDeclined) {
      alerts.push({ missionId: loop.missionId, title: loop.title, reason: 'metric_decline', detail: 'mesure apprise en baisse' });
      continue;
    }

    if (loop.nextRunAtMs !== undefined && loop.cadenceMs > 0) {
      const overdueMs = nowMs - loop.nextRunAtMs;
      if (overdueMs >= loop.cadenceMs * STALLED_OVERDUE_CADENCE_MULTIPLIER) {
        alerts.push({
          missionId: loop.missionId,
          title: loop.title,
          reason: 'stalled',
          detail: `en retard de ${Math.round(overdueMs / loop.cadenceMs)}x sa cadence`,
        });
      }
    }
  }
  return alerts;
}
