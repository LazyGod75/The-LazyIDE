/* lessons/evalGate.ts — Eval-gated retention: promotes trial lessons to
   proven or evicts them based on metric deltas from cited runs.

   The gate is conservative:
   - trial → proven: helped >= 2 AND harmed == 0 AND scoreDeltaEma > EPSILON
   - trial → evicted: harmed >= 2 OR scoreDeltaEma < -EPSILON
   - proven → evicted: harmed >= 3 (recent harm streak)
   - Never promotes on a single anecdotal success.

   All transitions are journaled via emitEvent so the UI and brain can
   surface them. */

import type { Lesson, LessonMetricSnapshot, EvalGateResult } from './types.js';
import {
  getLessonById,
  recordLessonOutcome,
  transitionLessonStatus,
} from './lessonStore.js';

const EPSILON = 0.05;
const PROMOTE_HELPED_MIN = 2;
const PROMOTE_HARMED_MAX = 0;
const EVICT_HARMED_MIN = 2;
const PROVEN_EVICT_HARMED_MIN = 3;

// ── Metric comparison ───────────────────────────────────────────────

/** Compute a normalized delta in [-1, +1] comparing a cited run's
 *  metrics against a baseline. Positive = improvement. */
export function computeMetricDelta(
  cited: LessonMetricSnapshot,
  baseline?: LessonMetricSnapshot,
): number {
  if (!baseline) {
    // No baseline: use pass/fail as the signal
    if (cited.passed === true) return 0.3;
    if (cited.status === 'failed') return -0.3;
    return 0;
  }

  let delta = 0;

  // Score delta (normalized to [-0.5, +0.5])
  if (typeof cited.score === 'number' && typeof baseline.score === 'number'
      && !cited.scoreUnavailable && !baseline.scoreUnavailable) {
    delta += clamp((cited.score - baseline.score) / 100, -0.5, 0.5);
  }

  // Pass/fail flip
  if (cited.passed === true && baseline.passed !== true) delta += 0.3;
  if (cited.passed === false && baseline.passed === true) delta -= 0.3;

  // Cost penalty (cheaper is better)
  if (typeof cited.costUsd === 'number' && typeof baseline.costUsd === 'number' && baseline.costUsd > 0) {
    delta += clamp((baseline.costUsd - cited.costUsd) / baseline.costUsd * 0.2, -0.2, 0.2);
  }

  // Duration penalty (faster is better)
  if (typeof cited.durationMs === 'number' && typeof baseline.durationMs === 'number' && baseline.durationMs > 0) {
    delta += clamp((baseline.durationMs - cited.durationMs) / baseline.durationMs * 0.1, -0.1, 0.1);
  }

  return clamp(delta, -1, 1);
}

// ── Gate evaluation ─────────────────────────────────────────────────

/** Evaluate a single lesson after a cited run outcome. Returns the
 *  transition result (may be a no-op if thresholds aren't met). */
export function evaluateGate(
  lessonId: string,
  citedMetrics: LessonMetricSnapshot,
  baseline?: LessonMetricSnapshot,
): EvalGateResult {
  const lesson = getLessonById(lessonId);
  if (!lesson) {
    return {
      lessonId,
      previousStatus: 'trial',
      nextStatus: 'trial',
      delta: 0,
      reason: 'Lesson not found',
    };
  }

  const delta = computeMetricDelta(citedMetrics, baseline);
  const helped = delta > EPSILON;
  const harmed = delta < -EPSILON;

  recordLessonOutcome(lessonId, delta, helped, harmed);

  // Re-read after update
  const updated = getLessonById(lessonId);
  if (!updated) {
    return {
      lessonId,
      previousStatus: lesson.status,
      nextStatus: lesson.status,
      delta,
      reason: 'Lesson vanished after update',
    };
  }

  return decideTransition(updated, delta);
}

function decideTransition(lesson: Lesson, delta: number): EvalGateResult {
  const prev = lesson.status;

  if (prev === 'trial') {
    if (lesson.timesHelped >= PROMOTE_HELPED_MIN
        && lesson.timesHarmed <= PROMOTE_HARMED_MAX
        && lesson.scoreDeltaEma > EPSILON) {
      transitionLessonStatus(lesson.id, 'proven');
      return {
        lessonId: lesson.id,
        previousStatus: prev,
        nextStatus: 'proven',
        delta,
        reason: `Promoted: helped ${lesson.timesHelped}x, harmed ${lesson.timesHarmed}x, EMA ${lesson.scoreDeltaEma.toFixed(3)}`,
      };
    }
    if (lesson.timesHarmed >= EVICT_HARMED_MIN || lesson.scoreDeltaEma < -EPSILON) {
      transitionLessonStatus(lesson.id, 'evicted');
      return {
        lessonId: lesson.id,
        previousStatus: prev,
        nextStatus: 'evicted',
        delta,
        reason: `Evicted: harmed ${lesson.timesHarmed}x, EMA ${lesson.scoreDeltaEma.toFixed(3)}`,
      };
    }
    return {
      lessonId: lesson.id,
      previousStatus: prev,
      nextStatus: 'trial',
      delta,
      reason: `Holding: helped ${lesson.timesHelped}x, harmed ${lesson.timesHarmed}x, EMA ${lesson.scoreDeltaEma.toFixed(3)}`,
    };
  }

  if (prev === 'proven') {
    if (lesson.timesHarmed >= PROVEN_EVICT_HARMED_MIN) {
      transitionLessonStatus(lesson.id, 'evicted');
      return {
        lessonId: lesson.id,
        previousStatus: prev,
        nextStatus: 'evicted',
        delta,
        reason: `Proven lesson evicted: harm streak ${lesson.timesHarmed}x`,
      };
    }
    return {
      lessonId: lesson.id,
      previousStatus: prev,
      nextStatus: 'proven',
      delta,
      reason: `Proven: held (harmed ${lesson.timesHarmed}x)`,
    };
  }

  // Evicted lessons stay evicted
  return {
    lessonId: lesson.id,
    previousStatus: prev,
    nextStatus: 'evicted',
    delta,
    reason: 'Already evicted',
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
