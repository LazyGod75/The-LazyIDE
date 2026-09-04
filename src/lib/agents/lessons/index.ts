/* lessons/index.ts — Barrel exports for the lessons module. */

export type {
  Lesson,
  LessonStatus,
  LessonProvenance,
  LessonMetricSnapshot,
  EvalGateResult,
} from './types.js';

export {
  getAllLessons,
  getLessonsForProject,
  getProvenLessons,
  getTrialLessons,
  getActiveLessons,
  getLessonById,
  findLessonByPathology,
  upsertLesson,
  citeLesson,
  recordLessonOutcome,
  transitionLessonStatus,
  deleteLesson,
  clearProjectLessons,
} from './lessonStore.js';

export type { UpsertLessonInput } from './lessonStore.js';

export {
  computeMetricDelta,
  evaluateGate,
} from './evalGate.js';
