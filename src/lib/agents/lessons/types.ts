/* lessons/types.ts — Structured cross-run lessons for eval-gated retention. */

export type LessonStatus = 'trial' | 'proven' | 'evicted';

export type LessonProvenance =
  | 'learningLoop'
  | 'diagnosis'
  | 'friction'
  | 'replan'
  | 'user';

export interface Lesson {
  id: string;
  projectId: string;
  status: LessonStatus;
  /** Pathology location, e.g. 'gate:tester' | 'step:implement' | 'topology:missing-join'. */
  where: string;
  /** Short slug cause, e.g. 'missing-tests' | 'type-error'. */
  why: string;
  title: string;
  body: string;
  suggestion?: string;
  evidenceMissionIds: string[];
  evidenceRunIds?: string[];
  timesCited: number;
  timesHelped: number;
  timesHarmed: number;
  /** EMA of metric deltas when cited (−1..+1-ish). */
  scoreDeltaEma: number;
  createdAt: string;
  updatedAt: string;
  lastCitedAt?: string;
  provenance: LessonProvenance;
}

export interface LessonMetricSnapshot {
  passed?: boolean;
  score?: number;
  scoreUnavailable?: boolean;
  status: string;
  costUsd?: number;
  durationMs?: number;
  toolCount?: number;
}

export interface EvalGateResult {
  lessonId: string;
  previousStatus: LessonStatus;
  nextStatus: LessonStatus;
  delta: number;
  reason: string;
}
