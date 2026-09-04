/**
 * Phase 9 tests — topology learner and prompt learner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runTopologyLearner, topologyProposalsToLessons } from '../lib/agents/lessons/topologyLearner';
import { runPromptLearner, promptProposalsToLessons } from '../lib/agents/lessons/promptLearner';
import { clearProjectLessons, getTrialLessons } from '../lib/agents/lessons/lessonStore';
import type { TraceEntry } from '../lib/agents/graph/traceJournal';

const PROJECT = 'test-phase9';

beforeEach(() => {
  clearProjectLessons(PROJECT);
});

function makeEntry(
  nodeId: string,
  label: string,
  kind: 'task' | 'contest',
  outcome: 'success' | 'failure' | 'skipped' | 'contested',
  graphId = 'g1',
  durationMs?: number,
  costUsd?: number,
): TraceEntry {
  return {
    ts: Date.now(),
    runId: 'r1',
    graphId,
    nodeId,
    nodeKind: kind,
    nodeLabel: label,
    status: outcome === 'success' ? 'done' : outcome === 'failure' ? 'failed' : 'skipped',
    outcome,
    attempt: 1,
    missionIds: [`m-${nodeId}`],
    durationMs,
    costUsd,
    stepContract: { agent: 'Coder', model: 'sonnet', effort: 'medium' },
  };
}

// ── Topology learner ───────────────────────────────────────────────

describe('topologyLearner', () => {
  it('returns empty for no entries', () => {
    const result = runTopologyLearner([]);
    expect(result.proposals).toHaveLength(0);
  });

  it('proposes contest pattern when contest outperforms task', () => {
    const entries = [
      // Task nodes: 1 success, 3 failures = 25%
      makeEntry('t1', 'Task A', 'task', 'success'),
      makeEntry('t2', 'Task B', 'task', 'failure'),
      makeEntry('t3', 'Task C', 'task', 'failure'),
      makeEntry('t4', 'Task D', 'task', 'failure'),
      // Contest nodes: 3 successes, 0 failures = 100%
      makeEntry('c1', 'Contest A', 'contest', 'success'),
      makeEntry('c2', 'Contest B', 'contest', 'success'),
      makeEntry('c3', 'Contest C', 'contest', 'success'),
    ];
    const result = runTopologyLearner(entries);
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);
    const contestProposal = result.proposals.find((p) => p.pattern === 'contest');
    expect(contestProposal).toBeDefined();
    expect(contestProposal!.lift).toBeGreaterThan(0);
  });

  it('does not propose when sample sizes are too small', () => {
    const entries = [
      makeEntry('t1', 'Task A', 'task', 'failure'),
      makeEntry('c1', 'Contest A', 'contest', 'success'),
    ];
    const result = runTopologyLearner(entries);
    expect(result.proposals).toHaveLength(0);
  });

  it('creates lessons from proposals', () => {
    const entries = [
      makeEntry('t1', 'Task A', 'task', 'success'),
      makeEntry('t2', 'Task B', 'task', 'failure'),
      makeEntry('t3', 'Task C', 'task', 'failure'),
      makeEntry('t4', 'Task D', 'task', 'failure'),
      makeEntry('c1', 'Contest A', 'contest', 'success'),
      makeEntry('c2', 'Contest B', 'contest', 'success'),
      makeEntry('c3', 'Contest C', 'contest', 'success'),
    ];
    const result = runTopologyLearner(entries);
    const ids = topologyProposalsToLessons(PROJECT, result.proposals);
    expect(ids.length).toBeGreaterThan(0);

    const trials = getTrialLessons(PROJECT);
    expect(trials.length).toBeGreaterThan(0);
    expect(trials.some((t) => t.where === 'topology')).toBe(true);
  });
});

// ── Prompt learner ─────────────────────────────────────────────────

describe('promptLearner', () => {
  it('returns empty for no entries', () => {
    const result = runPromptLearner([]);
    expect(result.proposals).toHaveLength(0);
  });

  it('proposes too-short when short prompts underperform', () => {
    const entries = [
      // Short prompts: 1 success, 3 failures = 25%
      makeEntry('s1', 'Fix bug', 'task', 'success'),
      makeEntry('s2', 'Add tests', 'task', 'failure'),
      makeEntry('s3', 'Refactor X', 'task', 'failure'),
      makeEntry('s4', 'Update Y', 'task', 'failure'),
      // Adequate prompts: 3 successes, 1 failure = 75%
      makeEntry('a1', 'Fix the authentication bug in the login flow by updating the token validation logic', 'task', 'success'),
      makeEntry('a2', 'Add comprehensive unit tests for the payment module covering edge cases and error paths', 'task', 'success'),
      makeEntry('a3', 'Refactor the database connection layer to use connection pooling and retry logic', 'task', 'success'),
      makeEntry('a4', 'Update the API response format to include proper error codes and detailed messages', 'task', 'failure'),
    ];
    const result = runPromptLearner(entries);
    const tooShort = result.proposals.find((p) => p.issue === 'too-short');
    expect(tooShort).toBeDefined();
    expect(tooShort!.lift).toBeGreaterThan(0);
  });

  it('proposes missing-keyword when keyword presence improves outcomes', () => {
    const entries = [
      // Without "test": 1 success, 3 failures
      makeEntry('w1', 'Implement the auth module with proper validation', 'task', 'success'),
      makeEntry('w2', 'Implement the payment module with validation', 'task', 'failure'),
      makeEntry('w3', 'Build the notification system with validation', 'task', 'failure'),
      makeEntry('w4', 'Create the user profile page with validation', 'task', 'failure'),
      // With "test": 3 successes, 1 failure
      makeEntry('t1', 'Implement the auth module with test coverage and validation', 'task', 'success'),
      makeEntry('t2', 'Implement the payment module with test coverage and validation', 'task', 'success'),
      makeEntry('t3', 'Build the notification system with test coverage and validation', 'task', 'success'),
      makeEntry('t4', 'Create the user profile page with test coverage and validation', 'task', 'failure'),
    ];
    const result = runPromptLearner(entries);
    const keywordProposal = result.proposals.find((p) => p.issue === 'missing-keyword' && p.missingKeyword === 'test');
    expect(keywordProposal).toBeDefined();
    expect(keywordProposal!.lift).toBeGreaterThan(0);
  });

  it('does not propose with insufficient samples', () => {
    const entries = [
      makeEntry('s1', 'Fix bug', 'task', 'failure'),
      makeEntry('a1', 'Fix the authentication bug in the login flow properly', 'task', 'success'),
    ];
    const result = runPromptLearner(entries);
    expect(result.proposals).toHaveLength(0);
  });

  it('creates lessons from proposals', () => {
    const entries = [
      makeEntry('s1', 'Fix bug', 'task', 'success'),
      makeEntry('s2', 'Add tests', 'task', 'failure'),
      makeEntry('s3', 'Refactor X', 'task', 'failure'),
      makeEntry('s4', 'Update Y', 'task', 'failure'),
      makeEntry('a1', 'Fix the authentication bug in the login flow by updating the token validation logic', 'task', 'success'),
      makeEntry('a2', 'Add comprehensive unit tests for the payment module covering edge cases and error paths', 'task', 'success'),
      makeEntry('a3', 'Refactor the database connection layer to use connection pooling and retry logic', 'task', 'success'),
      makeEntry('a4', 'Update the API response format to include proper error codes and detailed messages', 'task', 'failure'),
    ];
    const result = runPromptLearner(entries);
    const ids = promptProposalsToLessons(PROJECT, result.proposals);
    expect(ids.length).toBeGreaterThan(0);

    const trials = getTrialLessons(PROJECT);
    expect(trials.some((t) => t.where === 'prompt')).toBe(true);
  });
});
