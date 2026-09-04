/* objectivesStatus.ts — pure status derivation for CAP objectives (D6).

   No I/O, no React — fully unit-testable in isolation (see
   src/__tests__/objectivesStatus.test.ts). Kept separate from
   objectivesStore.ts (persistence) so the pacing logic below can be tested
   without touching Tauri invoke / localStorage at all.
*/

export type ObjectiveStatus = 'on-track' | 'late' | 'no-deadline';

export interface ObjectiveProgressInput {
  /** ISO date/time the objective was created — the pacing baseline. */
  createdAtMs: number;
  /** ISO date/time deadline, or null for a permanent/no-deadline rule
   *  (design mock's "garder main toujours verte" — gauge "∞", no pacing). */
  deadlineMs: number | null;
  /** Denominator the objective is measured against, or null when progress
   *  isn't counted in fixed units (a permanent rule). */
  targetCount: number | null;
  /** Numerator — real count derived from linked data, or user-set. */
  currentCount: number;
}

/**
 * Derives on-track / late / no-deadline from a simple pacing comparison:
 * progress ratio (currentCount/targetCount) vs. time-elapsed ratio
 * (now-createdAt)/(deadline-createdAt), both clamped to [0,1]. A small
 * tolerance (10%) avoids flapping to "late" from rounding noise right at
 * the pace line. Past the deadline with incomplete progress is always
 * 'late', regardless of tolerance.
 */
export function deriveObjectiveStatus(
  input: ObjectiveProgressInput,
  nowMs: number = Date.now(),
): ObjectiveStatus {
  const { createdAtMs, deadlineMs, targetCount, currentCount } = input;

  if (deadlineMs === null) return 'no-deadline';

  const isComplete = targetCount !== null && targetCount > 0 && currentCount >= targetCount;
  if (isComplete) return 'on-track';

  if (nowMs >= deadlineMs) return 'late';

  if (targetCount === null || targetCount <= 0) {
    // No fixed target to pace against — only the deadline itself matters,
    // and it hasn't passed yet.
    return 'on-track';
  }

  const totalSpan = Math.max(deadlineMs - createdAtMs, 1);
  const timeRatio = Math.min(Math.max((nowMs - createdAtMs) / totalSpan, 0), 1);
  const progressRatio = Math.min(Math.max(currentCount / targetCount, 0), 1);

  const TOLERANCE = 0.1;
  return progressRatio + TOLERANCE >= timeRatio ? 'on-track' : 'late';
}
