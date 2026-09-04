/**
 * Phase 11 tests — learning pipeline integration + guardrails.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  runLearningPipeline,
  buildLearningContext,
  resetLearningState,
  isLearningInCooldown,
  getCooldownRemaining,
  hasTooManyLessons,
  MAX_LESSONS_PER_PROJECT,
  LEARNING_COOLDOWN_MS,
  MAX_PROPOSALS_PER_RUN,
} from '../lib/agents/lessons/learningPipeline';
import { getProvenLessons, getTrialLessons, upsertLesson } from '../lib/agents/lessons/lessonStore';
import type { TraceEntry } from '../lib/agents/graph/traceJournal';

const PROJECT = 'test-phase11';

beforeEach(() => {
  resetLearningState(PROJECT);
});

function makeEntry(
  runId: string,
  nodeId: string,
  label: string,
  outcome: 'success' | 'failure',
  ts: number,
  agent = 'Coder',
  kind: 'task' | 'contest' = 'task',
): TraceEntry {
  return {
    ts,
    runId,
    graphId: 'g1',
    nodeId,
    nodeKind: kind,
    nodeLabel: label,
    status: outcome === 'success' ? 'done' : 'failed',
    outcome,
    attempt: 1,
    missionIds: [`m-${nodeId}`],
    stepContract: { agent, model: 'sonnet', effort: 'medium' },
  };
}

describe('learningPipeline — integration', () => {
  it('runs all four learners and produces lessons', () => {
    const entries: TraceEntry[] = [
      // Run 1
      makeEntry('r1', 'n1', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r1', 'n2', 'security review', 'success', 2000, 'Reviewer'),
      // Run 2 (same pattern → macro synthesis)
      makeEntry('r2', 'n3', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r2', 'n4', 'security review', 'success', 2000, 'Reviewer'),
      // Extra entries for routing learner
      makeEntry('r3', 'n5', 'auth module', 'failure', 1000, 'Coder'),
      makeEntry('r3', 'n6', 'auth module', 'failure', 2000, 'Coder'),
      makeEntry('r3', 'n7', 'auth module', 'failure', 3000, 'Coder'),
      makeEntry('r3', 'n8', 'auth module', 'failure', 4000, 'Coder'),
    ];

    const result = runLearningPipeline(PROJECT, entries);

    expect(result.guardrailTriggered).toBeNull();
    expect(result.totalEntries).toBe(entries.length);
    // At least some proposals should be produced
    expect(result.routingProposals + result.topologyProposals + result.promptProposals + result.macroTemplates).toBeGreaterThan(0);
    expect(result.lessonsCreated).toBeGreaterThan(0);

    // Verify lessons exist in the store
    const allLessons = [...getProvenLessons(PROJECT), ...getTrialLessons(PROJECT)];
    expect(allLessons.length).toBeGreaterThan(0);
  });

  it('returns empty result for empty entries', () => {
    const result = runLearningPipeline(PROJECT, []);
    expect(result.routingProposals).toBe(0);
    expect(result.topologyProposals).toBe(0);
    expect(result.promptProposals).toBe(0);
    expect(result.macroTemplates).toBe(0);
    expect(result.lessonsCreated).toBe(0);
    expect(result.guardrailTriggered).toBeNull();
  });
});

describe('learningPipeline — guardrails', () => {
  it('triggers cooldown after first run', () => {
    const now = Date.now();
    const entries = [makeEntry('r1', 'n1', 'test task', 'success', now)];

    runLearningPipeline(PROJECT, entries, now);

    expect(isLearningInCooldown(PROJECT, now)).toBe(true); // 0ms elapsed, in cooldown
    expect(isLearningInCooldown(PROJECT, now + 1000)).toBe(true); // 1s later, still in cooldown
    expect(isLearningInCooldown(PROJECT, now + LEARNING_COOLDOWN_MS + 1)).toBe(false); // After cooldown expires
  });

  it('returns cooldown guardrail when run too soon', () => {
    const now = Date.now();
    const entries = [makeEntry('r1', 'n1', 'test task', 'success', now)];

    // First run
    runLearningPipeline(PROJECT, entries, now);

    // Second run 1 second later
    const result = runLearningPipeline(PROJECT, entries, now + 1000);
    expect(result.guardrailTriggered).toBe('cooldown');
    expect(result.lessonsCreated).toBe(0);
  });

  it('getCooldownRemaining returns correct value', () => {
    const now = Date.now();
    const entries = [makeEntry('r1', 'n1', 'test task', 'success', now)];

    runLearningPipeline(PROJECT, entries, now);

    const remaining = getCooldownRemaining(PROJECT, now + 5000);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(LEARNING_COOLDOWN_MS);
  });

  it('triggers max-lessons guardrail when store is full', () => {
    // Directly populate the lesson store to the max
    for (let i = 0; i < MAX_LESSONS_PER_PROJECT; i++) {
      upsertLesson({
        projectId: PROJECT,
        where: 'routing',
        why: `shape-${i}`,
        title: `Lesson ${i}`,
        body: `Body ${i}`,
        provenance: 'learningLoop',
      });
    }

    expect(hasTooManyLessons(PROJECT)).toBe(true);

    const entries = [makeEntry('r1', 'n1', 'test task with words', 'success', 1000)];
    const result = runLearningPipeline(PROJECT, entries, Date.now());
    expect(result.guardrailTriggered).toBe('max-lessons');
    expect(result.lessonsCreated).toBe(0);
  });

  it('respects MAX_PROPOSALS_PER_RUN cap', () => {
    // Create entries that would produce many proposals
    const entries: TraceEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(makeEntry(`r${Math.floor(i / 4)}`, `n${i}`, `task ${i} with unique keywords`, i % 3 === 0 ? 'success' : 'failure', i * 1000, i % 2 === 0 ? 'Coder' : 'Architect'));
    }

    const result = runLearningPipeline(PROJECT, entries);
    // Each learner is capped at MAX_PROPOSALS_PER_RUN
    expect(result.routingProposals).toBeLessThanOrEqual(MAX_PROPOSALS_PER_RUN);
    expect(result.topologyProposals).toBeLessThanOrEqual(MAX_PROPOSALS_PER_RUN);
    expect(result.promptProposals).toBeLessThanOrEqual(MAX_PROPOSALS_PER_RUN);
    expect(result.macroTemplates).toBeLessThanOrEqual(MAX_PROPOSALS_PER_RUN);
  });
});

describe('learningPipeline — context building', () => {
  it('buildLearningContext returns empty when no lessons', () => {
    resetLearningState(PROJECT);
    const ctx = buildLearningContext(PROJECT);
    expect(ctx.combinedContext).toBe('');
    expect(ctx.routingContext).toBe('');
    expect(ctx.macroContext).toBe('');
  });

  it('buildLearningContext includes routing after pipeline run', () => {
    const entries: TraceEntry[] = [
      makeEntry('r1', 'n1', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r1', 'n2', 'auth module', 'success', 2000, 'Architect'),
      makeEntry('r1', 'n3', 'auth module', 'success', 3000, 'Architect'),
      makeEntry('r2', 'n4', 'auth module', 'failure', 1000, 'Coder'),
      makeEntry('r2', 'n5', 'auth module', 'failure', 2000, 'Coder'),
      makeEntry('r2', 'n6', 'auth module', 'failure', 3000, 'Coder'),
      makeEntry('r2', 'n7', 'auth module', 'failure', 4000, 'Coder'),
    ];

    runLearningPipeline(PROJECT, entries);

    const ctx = buildLearningContext(PROJECT);
    expect(ctx.routingContext).toContain('routing');
  });
});

describe('learningPipeline — reset', () => {
  it('resetLearningState clears lessons and cooldown', () => {
    const entries = [makeEntry('r1', 'n1', 'test task with words', 'success', 1000)];
    runLearningPipeline(PROJECT, entries);

    resetLearningState(PROJECT);

    expect(getProvenLessons(PROJECT)).toHaveLength(0);
    expect(getTrialLessons(PROJECT)).toHaveLength(0);
    expect(isLearningInCooldown(PROJECT)).toBe(false);
  });
});
