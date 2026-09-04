import { describe, it, expect, beforeEach } from 'vitest';
import { upsertLesson, getLessonById, deleteLesson, getAllLessons, citeLesson } from '../lessonStore';
import { computeMetricDelta, evaluateGate } from '../evalGate';
import type { LessonMetricSnapshot } from '../types';

describe('evalGate', () => {
  beforeEach(() => {
    for (const l of getAllLessons()) {
      deleteLesson(l.id);
    }
  });

  describe('computeMetricDelta', () => {
    it('returns positive delta when cited passes and baseline did not', () => {
      const cited: LessonMetricSnapshot = { status: 'done', passed: true, score: 80 };
      const baseline: LessonMetricSnapshot = { status: 'failed', passed: false, score: 40 };
      const delta = computeMetricDelta(cited, baseline);
      expect(delta).toBeGreaterThan(0);
    });

    it('returns negative delta when cited fails and baseline passed', () => {
      const cited: LessonMetricSnapshot = { status: 'failed', passed: false, score: 30 };
      const baseline: LessonMetricSnapshot = { status: 'done', passed: true, score: 70 };
      const delta = computeMetricDelta(cited, baseline);
      expect(delta).toBeLessThan(0);
    });

    it('returns positive delta when cost decreases', () => {
      const cited: LessonMetricSnapshot = { status: 'done', passed: true, costUsd: 0.5 };
      const baseline: LessonMetricSnapshot = { status: 'done', passed: true, costUsd: 1.0 };
      const delta = computeMetricDelta(cited, baseline);
      expect(delta).toBeGreaterThan(0);
    });

    it('returns 0.3 for pass with no baseline', () => {
      const cited: LessonMetricSnapshot = { status: 'done', passed: true };
      const delta = computeMetricDelta(cited);
      expect(delta).toBeCloseTo(0.3, 5);
    });

    it('clamps delta to [-1, 1]', () => {
      const cited: LessonMetricSnapshot = { status: 'done', passed: true, score: 100, costUsd: 0.01, durationMs: 1 };
      const baseline: LessonMetricSnapshot = { status: 'failed', passed: false, score: 0, costUsd: 10, durationMs: 60000 };
      const delta = computeMetricDelta(cited, baseline);
      expect(delta).toBeLessThanOrEqual(1);
      expect(delta).toBeGreaterThanOrEqual(-1);
    });
  });

  describe('evaluateGate', () => {
    it('promotes trial to proven after 2 helped with 0 harmed', () => {
      const id = upsertLesson({
        projectId: 'test-proj',
        where: 'gate:tester',
        why: 'missing-tests',
        title: 'Add tests',
        body: 'Always add tests.',
        provenance: 'learningLoop',
      });

      // First cite + helped
      citeLesson(id);
      evaluateGate(id, { status: 'done', passed: true, score: 80 }, { status: 'failed', passed: false, score: 40 });

      // Second cite + helped
      citeLesson(id);
      const result = evaluateGate(id, { status: 'done', passed: true, score: 90 }, { status: 'failed', passed: false, score: 50 });

      expect(result.nextStatus).toBe('proven');
      expect(result.previousStatus).toBe('trial');
      expect(getLessonById(id)!.status).toBe('proven');
    });

    it('evicts trial after 2 harmed', () => {
      const id = upsertLesson({
        projectId: 'test-proj',
        where: 'step:impl',
        why: 'bad-pattern',
        title: 'Bad lesson',
        body: 'This lesson hurts.',
        provenance: 'diagnosis',
      });

      citeLesson(id);
      evaluateGate(id, { status: 'failed', passed: false, score: 20 }, { status: 'done', passed: true, score: 80 });

      citeLesson(id);
      const result = evaluateGate(id, { status: 'failed', passed: false, score: 10 }, { status: 'done', passed: true, score: 70 });

      expect(result.nextStatus).toBe('evicted');
      expect(getLessonById(id)!.status).toBe('evicted');
    });

    it('holds trial when only 1 helped', () => {
      const id = upsertLesson({
        projectId: 'test-proj',
        where: 'gate:x',
        why: 'y',
        title: 'Hold me',
        body: 'Not enough evidence yet.',
        provenance: 'learningLoop',
      });

      citeLesson(id);
      const result = evaluateGate(id, { status: 'done', passed: true, score: 85 }, { status: 'failed', passed: false, score: 40 });

      expect(result.nextStatus).toBe('trial');
      expect(getLessonById(id)!.status).toBe('trial');
    });

    it('evicts proven lesson after 3 harmed', () => {
      const id = upsertLesson({
        projectId: 'test-proj',
        where: 'gate:x',
        why: 'y',
        title: 'Was good',
        body: 'Used to help.',
        provenance: 'learningLoop',
      });

      // Promote first
      citeLesson(id);
      evaluateGate(id, { status: 'done', passed: true, score: 80 }, { status: 'failed', passed: false, score: 40 });
      citeLesson(id);
      evaluateGate(id, { status: 'done', passed: true, score: 85 }, { status: 'failed', passed: false, score: 40 });
      expect(getLessonById(id)!.status).toBe('proven');

      // Now harm it 3 times
      citeLesson(id);
      evaluateGate(id, { status: 'failed', passed: false, score: 20 }, { status: 'done', passed: true, score: 80 });
      citeLesson(id);
      evaluateGate(id, { status: 'failed', passed: false, score: 10 }, { status: 'done', passed: true, score: 70 });
      citeLesson(id);
      const result = evaluateGate(id, { status: 'failed', passed: false, score: 5 }, { status: 'done', passed: true, score: 75 });

      expect(result.nextStatus).toBe('evicted');
      expect(getLessonById(id)!.status).toBe('evicted');
    });

    it('returns not-found result for unknown lesson id', () => {
      const result = evaluateGate('nonexistent', { status: 'done', passed: true });
      expect(result.nextStatus).toBe('trial');
      expect(result.reason).toContain('not found');
    });
  });
});
