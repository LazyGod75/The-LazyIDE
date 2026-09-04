import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertLesson,
  getLessonById,
  getProvenLessons,
  getTrialLessons,
  getActiveLessons,
  findLessonByPathology,
  citeLesson,
  recordLessonOutcome,
  transitionLessonStatus,
  deleteLesson,
  clearProjectLessons,
  getAllLessons,
} from '../lessonStore';

describe('lessonStore', () => {
  beforeEach(() => {
    clearProjectLessons('test-project');
    // Clear all lessons to ensure a clean slate
    for (const l of getAllLessons()) {
      deleteLesson(l.id);
    }
  });

  it('creates a trial lesson via upsert', () => {
    const id = upsertLesson({
      projectId: 'test-project',
      where: 'gate:tester',
      why: 'missing-tests',
      title: 'Always add tests',
      body: 'The agent forgot to add tests for the new endpoint.',
      suggestion: 'Add a step that runs tests after implementation.',
      provenance: 'learningLoop',
    });

    const lesson = getLessonById(id);
    expect(lesson).toBeDefined();
    expect(lesson!.status).toBe('trial');
    expect(lesson!.title).toBe('Always add tests');
    expect(lesson!.timesCited).toBe(0);
    expect(lesson!.scoreDeltaEma).toBe(0);
  });

  it('merges evidence when upserting an existing pathology', () => {
    const id1 = upsertLesson({
      projectId: 'test-project',
      where: 'gate:tester',
      why: 'missing-tests',
      title: 'Always add tests',
      body: 'Body v1',
      provenance: 'learningLoop',
      evidenceMissionIds: ['m1'],
    });

    const id2 = upsertLesson({
      projectId: 'test-project',
      where: 'gate:tester',
      why: 'missing-tests',
      title: 'Always add tests v2',
      body: 'Body v2',
      provenance: 'learningLoop',
      evidenceMissionIds: ['m2'],
    });

    expect(id2).toBe(id1);
    const lesson = getLessonById(id1);
    expect(lesson!.title).toBe('Always add tests v2');
    expect(lesson!.evidenceMissionIds).toContain('m1');
    expect(lesson!.evidenceMissionIds).toContain('m2');
  });

  it('cites a lesson and increments counter', () => {
    const id = upsertLesson({
      projectId: 'test-project',
      where: 'step:implement',
      why: 'type-error',
      title: 'Run typecheck',
      body: 'Type errors caught late.',
      provenance: 'diagnosis',
    });

    citeLesson(id);
    citeLesson(id);

    const lesson = getLessonById(id);
    expect(lesson!.timesCited).toBe(2);
    expect(lesson!.lastCitedAt).toBeDefined();
  });

  it('records lesson outcome and updates EMA', () => {
    const id = upsertLesson({
      projectId: 'test-project',
      where: 'step:implement',
      why: 'type-error',
      title: 'Run typecheck',
      body: 'Type errors caught late.',
      provenance: 'diagnosis',
    });

    recordLessonOutcome(id, 0.5, true, false);
    let lesson = getLessonById(id);
    expect(lesson!.timesHelped).toBe(1);
    expect(lesson!.scoreDeltaEma).toBeCloseTo(0.15, 5); // 0 * 0.7 + 0.5 * 0.3

    recordLessonOutcome(id, -0.4, false, true);
    lesson = getLessonById(id);
    expect(lesson!.timesHarmed).toBe(1);
    // EMA: 0.15 * 0.7 + (-0.4) * 0.3 = 0.105 - 0.12 = -0.015
    expect(lesson!.scoreDeltaEma).toBeCloseTo(-0.015, 5);
  });

  it('transitions lesson status', () => {
    const id = upsertLesson({
      projectId: 'test-project',
      where: 'topology:missing-join',
      why: 'parallel-fanout',
      title: 'Add join node',
      body: 'Parallel steps need a join.',
      provenance: 'replan',
    });

    transitionLessonStatus(id, 'proven');
    expect(getLessonById(id)!.status).toBe('proven');

    transitionLessonStatus(id, 'evicted');
    expect(getLessonById(id)!.status).toBe('evicted');
  });

  it('filters lessons by project and status', () => {
    upsertLesson({
      projectId: 'proj-a',
      where: 'gate:tester',
      why: 'x',
      title: 'A',
      body: 'Body A',
      provenance: 'learningLoop',
    });
    upsertLesson({
      projectId: 'proj-b',
      where: 'gate:tester',
      why: 'y',
      title: 'B',
      body: 'Body B',
      provenance: 'learningLoop',
    });

    expect(getActiveLessons('proj-a')).toHaveLength(1);
    expect(getActiveLessons('proj-b')).toHaveLength(1);
    expect(getTrialLessons('proj-a')).toHaveLength(1);
    expect(getProvenLessons('proj-a')).toHaveLength(0);
  });

  it('finds lesson by pathology', () => {
    upsertLesson({
      projectId: 'test-project',
      where: 'gate:tester',
      why: 'missing-tests',
      title: 'Test lesson',
      body: 'Body',
      provenance: 'learningLoop',
    });

    const found = findLessonByPathology('test-project', 'gate:tester', 'missing-tests');
    expect(found).toBeDefined();
    expect(found!.title).toBe('Test lesson');

    const notFound = findLessonByPathology('test-project', 'gate:tester', 'wrong-why');
    expect(notFound).toBeUndefined();
  });

  it('deletes a lesson', () => {
    const id = upsertLesson({
      projectId: 'test-project',
      where: 'x',
      why: 'y',
      title: 'To delete',
      body: 'Body',
      provenance: 'user',
    });

    deleteLesson(id);
    expect(getLessonById(id)).toBeUndefined();
  });
});
