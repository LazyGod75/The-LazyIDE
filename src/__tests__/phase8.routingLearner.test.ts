/**
 * Phase 8 tests — routing learner, proposal gate, lesson bridge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeTaskShape,
  runRoutingLearner,
  proposalsToLessons,
  evalRoutingLesson,
  getActiveRoutingOverrides,
  buildRoutingContext,
  type RoutingProposal,
} from '../lib/agents/lessons/routingLearner';
import { clearProjectLessons, getTrialLessons } from '../lib/agents/lessons/lessonStore';
import type { TraceEntry } from '../lib/agents/graph/traceJournal';

// ── Helpers ────────────────────────────────────────────────────────

function makeTraceEntry(
  nodeId: string,
  label: string,
  agent: string,
  outcome: 'success' | 'failure' | 'skipped' | 'contested',
  model?: string,
  effort?: string,
): TraceEntry {
  return {
    ts: Date.now(),
    runId: 'r1',
    graphId: 'g1',
    nodeId,
    nodeKind: 'task',
    nodeLabel: label,
    status: outcome === 'success' ? 'done' : outcome === 'failure' ? 'failed' : 'skipped',
    outcome,
    attempt: 1,
    missionIds: [`m-${nodeId}`],
    stepContract: { agent, model, effort },
  };
}

const PROJECT = 'test-phase8';

beforeEach(() => {
  clearProjectLessons(PROJECT);
});

// ── normalizeTaskShape ─────────────────────────────────────────────

describe('normalizeTaskShape', () => {
  it('lowercases and removes stop words', () => {
    expect(normalizeTaskShape('Implement the auth module')).toBe('auth module');
  });

  it('handles empty input', () => {
    expect(normalizeTaskShape('')).toBe('');
  });

  it('sorts keywords alphabetically', () => {
    expect(normalizeTaskShape('write tests for security')).toBe('security tests');
  });

  it('limits to 5 keywords', () => {
    const result = normalizeTaskShape('alpha beta gamma delta epsilon zeta eta');
    const words = result.split(' ');
    expect(words.length).toBeLessThanOrEqual(5);
  });
});

// ── runRoutingLearner ──────────────────────────────────────────────

describe('runRoutingLearner', () => {
  it('returns empty proposals for empty entries', () => {
    const result = runRoutingLearner([]);
    expect(result.proposals).toHaveLength(0);
    expect(result.totalEntries).toBe(0);
  });

  it('returns empty proposals when all entries have same config', () => {
    const entries = [
      makeTraceEntry('n1', 'auth module', 'Coder', 'success'),
      makeTraceEntry('n2', 'auth module', 'Coder', 'success'),
      makeTraceEntry('n3', 'auth module', 'Coder', 'failure'),
    ];
    const result = runRoutingLearner(entries);
    expect(result.proposals).toHaveLength(0);
  });

  it('produces a proposal when one config outperforms baseline', () => {
    const entries = [
      // Coder: 1 success, 3 failures = 25% success
      makeTraceEntry('n1', 'auth module', 'Coder', 'success'),
      makeTraceEntry('n2', 'auth module', 'Coder', 'failure'),
      makeTraceEntry('n3', 'auth module', 'Coder', 'failure'),
      makeTraceEntry('n4', 'auth module', 'Coder', 'failure'),
      // Architect: 3 successes, 0 failures = 100% success
      makeTraceEntry('n5', 'auth module', 'Architect', 'success'),
      makeTraceEntry('n6', 'auth module', 'Architect', 'success'),
      makeTraceEntry('n7', 'auth module', 'Architect', 'success'),
    ];
    const result = runRoutingLearner(entries);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].agentName).toBe('Architect');
    expect(result.proposals[0].successRate).toBe(1);
    expect(result.proposals[0].lift).toBeGreaterThan(0);
  });

  it('does not produce proposals with insufficient samples', () => {
    const entries = [
      makeTraceEntry('n1', 'auth module', 'Coder', 'failure'),
      makeTraceEntry('n2', 'auth module', 'Architect', 'success'),
    ];
    const result = runRoutingLearner(entries);
    expect(result.proposals).toHaveLength(0);
  });

  it('groups by normalized task shape', () => {
    const entries = [
      makeTraceEntry('n1', 'Implement the auth module', 'Coder', 'failure'),
      makeTraceEntry('n2', 'Implement the auth module', 'Coder', 'failure'),
      makeTraceEntry('n3', 'Implement the auth module', 'Coder', 'failure'),
      makeTraceEntry('n4', 'Implement the auth module', 'Coder', 'failure'),
      makeTraceEntry('n5', 'auth module', 'Architect', 'success'),
      makeTraceEntry('n6', 'auth module', 'Architect', 'success'),
      makeTraceEntry('n7', 'auth module', 'Architect', 'success'),
    ];
    const result = runRoutingLearner(entries);
    expect(result.taskShapes).toBe(1);
    expect(result.proposals).toHaveLength(1);
  });
});

// ── proposalsToLessons ─────────────────────────────────────────────

describe('proposalsToLessons', () => {
  it('creates trial lessons from proposals', () => {
    const proposals: RoutingProposal[] = [
      {
        taskShape: 'auth module',
        agentName: 'Architect',
        model: 'sonnet',
        effort: 'high',
        successRate: 0.9,
        sampleCount: 5,
        baselineSuccessRate: 0.3,
        lift: 0.6,
      },
    ];

    const ids = proposalsToLessons(PROJECT, proposals);
    expect(ids).toHaveLength(1);

    const trials = getTrialLessons(PROJECT);
    expect(trials).toHaveLength(1);
    expect(trials[0].where).toBe('routing');
    expect(trials[0].why).toBe('auth module');
  });

  it('does not duplicate lessons for same pathology', () => {
    const proposals: RoutingProposal[] = [
      {
        taskShape: 'auth module',
        agentName: 'Architect',
        successRate: 0.9,
        sampleCount: 5,
        baselineSuccessRate: 0.3,
        lift: 0.6,
      },
    ];

    proposalsToLessons(PROJECT, proposals);
    proposalsToLessons(PROJECT, proposals);

    const trials = getTrialLessons(PROJECT);
    expect(trials).toHaveLength(1);
  });
});

// ── evalRoutingLesson ──────────────────────────────────────────────

describe('evalRoutingLesson', () => {
  it('does nothing when no lesson exists', () => {
    const result = evalRoutingLesson(PROJECT, 'nonexistent', true, false, 0.1);
    expect(result.action).toBe('none');
  });

  it('cites lesson and records outcome', () => {
    // Create a lesson first
    proposalsToLessons(PROJECT, [
      { taskShape: 'auth module', agentName: 'Architect', successRate: 0.9, sampleCount: 5, baselineSuccessRate: 0.3, lift: 0.6 },
    ]);

    const result = evalRoutingLesson(PROJECT, 'auth module', true, false, 0.2);
    expect(result.action).toBe('none'); // Not enough citations yet
    expect(result.lessonId).toBeDefined();

    const trials = getTrialLessons(PROJECT);
    expect(trials[0].timesCited).toBe(1);
  });
});

// ── buildRoutingContext ────────────────────────────────────────────

describe('buildRoutingContext', () => {
  it('returns empty string when no routing lessons', () => {
    expect(buildRoutingContext(PROJECT)).toBe('');
  });

  it('includes trial routing suggestions', () => {
    proposalsToLessons(PROJECT, [
      { taskShape: 'auth module', agentName: 'Architect', successRate: 0.9, sampleCount: 5, baselineSuccessRate: 0.3, lift: 0.6 },
    ]);

    const ctx = buildRoutingContext(PROJECT);
    expect(ctx).toContain('Trial routing suggestions');
    expect(ctx).toContain('auth module');
    expect(ctx).toContain('Architect');
  });
});

// ── getActiveRoutingOverrides ──────────────────────────────────────

describe('getActiveRoutingOverrides', () => {
  it('returns empty array when no proven lessons', () => {
    expect(getActiveRoutingOverrides(PROJECT)).toHaveLength(0);
  });
});
