/* lessons/lessonStore.ts — In-memory project-scoped lesson store with
   persistence to localStorage. Holds structured cross-run lessons that
   flow through the eval-gate (trial → proven | evicted).

   Not a Zustand store — a plain module singleton accessed via get/set.
   The store is project-scoped: lessons are keyed by projectId so they
   don't leak across projects. */

import type { Lesson, LessonStatus, LessonProvenance } from './types.js';

const STORAGE_KEY = 'lazy.lessons.v1';
const EMA_ALPHA = 0.3;

// ── Store state ─────────────────────────────────────────────────────

let lessons: Lesson[] = loadFromStorage();

function loadFromStorage(): Lesson[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Lesson[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lessons));
  } catch {
    // Non-fatal — in-memory still works
  }
}

// ── Public API ──────────────────────────────────────────────────────

export function getAllLessons(): Lesson[] {
  return [...lessons];
}

export function getLessonsForProject(projectId: string): Lesson[] {
  return lessons.filter((l) => l.projectId === projectId);
}

export function getProvenLessons(projectId: string): Lesson[] {
  return lessons.filter((l) => l.projectId === projectId && l.status === 'proven');
}

export function getTrialLessons(projectId: string): Lesson[] {
  return lessons.filter((l) => l.projectId === projectId && l.status === 'trial');
}

export function getActiveLessons(projectId: string): Lesson[] {
  return lessons.filter(
    (l) => l.projectId === projectId && (l.status === 'proven' || l.status === 'trial'),
  );
}

export function getLessonById(id: string): Lesson | undefined {
  return lessons.find((l) => l.id === id);
}

/** Find an existing lesson matching the same where×why pathology key. */
export function findLessonByPathology(
  projectId: string,
  where: string,
  why: string,
): Lesson | undefined {
  return lessons.find(
    (l) => l.projectId === projectId && l.where === where && l.why === why,
  );
}

export interface UpsertLessonInput {
  projectId: string;
  where: string;
  why: string;
  title: string;
  body: string;
  suggestion?: string;
  evidenceMissionIds?: string[];
  evidenceRunIds?: string[];
  provenance: LessonProvenance;
}

/** Create a new trial lesson or merge evidence into an existing one
 *  matching the same pathology key. Returns the lesson id. */
export function upsertLesson(input: UpsertLessonInput): string {
  const existing = findLessonByPathology(input.projectId, input.where, input.why);
  const now = new Date().toISOString();

  if (existing) {
    const updated: Lesson = {
      ...existing,
      title: input.title,
      body: input.body,
      suggestion: input.suggestion ?? existing.suggestion,
      evidenceMissionIds: dedupe([
        ...existing.evidenceMissionIds,
        ...(input.evidenceMissionIds ?? []),
      ]),
      evidenceRunIds: dedupe([
        ...(existing.evidenceRunIds ?? []),
        ...(input.evidenceRunIds ?? []),
      ]),
      updatedAt: now,
    };
    lessons = lessons.map((l) => (l.id === existing.id ? updated : l));
    persist();
    return existing.id;
  }

  const id = `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const lesson: Lesson = {
    id,
    projectId: input.projectId,
    status: 'trial',
    where: input.where,
    why: input.why,
    title: input.title,
    body: input.body,
    suggestion: input.suggestion,
    evidenceMissionIds: input.evidenceMissionIds ?? [],
    evidenceRunIds: input.evidenceRunIds,
    timesCited: 0,
    timesHelped: 0,
    timesHarmed: 0,
    scoreDeltaEma: 0,
    createdAt: now,
    updatedAt: now,
    provenance: input.provenance,
  };
  lessons = [...lessons, lesson];
  persist();
  return id;
}

/** Record that a lesson was cited in a run. */
export function citeLesson(id: string): void {
  lessons = lessons.map((l) =>
    l.id === id
      ? { ...l, timesCited: l.timesCited + 1, lastCitedAt: new Date().toISOString() }
      : l,
  );
  persist();
}

/** Update a lesson's EMA and helped/harmed counters after a run outcome. */
export function recordLessonOutcome(
  id: string,
  delta: number,
  helped: boolean,
  harmed: boolean,
): void {
  lessons = lessons.map((l) =>
    l.id === id
      ? {
          ...l,
          scoreDeltaEma: l.scoreDeltaEma * (1 - EMA_ALPHA) + delta * EMA_ALPHA,
          timesHelped: l.timesHelped + (helped ? 1 : 0),
          timesHarmed: l.timesHarmed + (harmed ? 1 : 0),
          updatedAt: new Date().toISOString(),
        }
      : l,
  );
  persist();
}

/** Transition a lesson's status (trial → proven | evicted, etc). */
export function transitionLessonStatus(id: string, nextStatus: LessonStatus): void {
  lessons = lessons.map((l) =>
    l.id === id
      ? { ...l, status: nextStatus, updatedAt: new Date().toISOString() }
      : l,
  );
  persist();
}

/** Delete a lesson entirely (user action). */
export function deleteLesson(id: string): void {
  lessons = lessons.filter((l) => l.id !== id);
  persist();
}

/** Clear all lessons for a project (user action). */
export function clearProjectLessons(projectId: string): void {
  lessons = lessons.filter((l) => l.projectId !== projectId);
  persist();
}

// ── Helpers ─────────────────────────────────────────────────────────

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
