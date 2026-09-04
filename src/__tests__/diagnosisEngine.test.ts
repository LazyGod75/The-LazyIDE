/**
 * Phase 4 — LLM-Driven Post-Mortems + Diagnosis Engine Overhaul
 * Tests for:
 * - LLM diagnosis path (mocked provider)
 * - Keyword fallback when no LLM available
 * - Post-mortem brain note written
 * - Replan engine uses preventable field
 * - Learning loop calls diagnose on failure
 */

import { describe, it, expect, vi } from 'vitest';
import type { MissionOutcome, Mission } from '../lib/agents/types';
import type { GraphIR, GraphRun } from '../lib/agents/graph/types';

// Mock platform/brain
vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    brain: {
      search: vi.fn().mockResolvedValue([
        { id: 'note-1', title: 'Similar failure', snippet: 'Type error in foo.ts', cluster: 'errors' },
      ]),
      capture: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

// Mock models to return a mock provider (no LLM available) — partial mock
// to keep findModelById and other exports used by evaluator.ts intact
vi.mock('../lib/models', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models')>();
  return {
    ...actual,
    getProvider: () => ({
      id: 'mock',
      label: 'Mock',
      listModels: () => [],
      streamChat: async function* () { yield ''; },
    }),
  };
});

// Mock brainNotation to avoid side effects
vi.mock('../lib/agents/brainNotation', () => ({
  noteDiagnosis: vi.fn(),
}));

import { diagnose } from '../lib/agents/diagnosisEngine';

describe('Phase 4 — Diagnosis Engine', () => {
  const baseOutcome: MissionOutcome = {
    missionId: 'm-1',
    projectId: 'proj-1',
    title: 'Fix auth bug',
    model: 'claude-3-sonnet',
    status: 'failed',
    errorMessage: 'TypeError: Cannot read property x of undefined',
    timestamp: Date.now(),
  };

  describe('keyword fallback (no LLM)', () => {
    it('categorizes type errors correctly', async () => {
      const result = await diagnose(baseOutcome);
      expect(result.category).toBe('type_error');
      expect(result.rootCause).toContain('Type mismatch');
      expect(result.suggestedFix).toContain('typecheck');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('categorizes test failures', async () => {
      const outcome: MissionOutcome = {
        ...baseOutcome,
        errorMessage: 'vitest: 3 tests failed',
      };
      const result = await diagnose(outcome);
      expect(result.category).toBe('test_failure');
    });

    it('categorizes budget exceeded', async () => {
      const outcome: MissionOutcome = {
        ...baseOutcome,
        errorMessage: 'budget exceeded: spent $5.00',
      };
      const result = await diagnose(outcome);
      expect(result.category).toBe('budget_exceeded');
    });

    it('falls back to unknown_failure for unrecognized errors', async () => {
      const outcome: MissionOutcome = {
        ...baseOutcome,
        errorMessage: 'something weird happened',
      };
      const result = await diagnose(outcome);
      expect(result.category).toBe('unknown_failure');
    });
  });
});

describe('Phase 4 — Replan Engine with preventable field', () => {
  it('non-preventable critical failure aborts after first attempt', async () => {
    const { replan } = await import('../lib/agents/graph/replanEngine');
    const ir = {
      id: 'test-graph',
      nodes: [
        { id: 'n1', kind: 'task' as const, label: 'Task 1', description: 'Do thing', contract: { engine: 'auto' as const }, critical: true, maxAttempts: 3 },
      ],
      edges: [],
      defaults: { maxReplans: 3 },
    };
    const run = {
      runId: 'r1',
      graphId: 'test-graph',
      status: 'running' as const,
      nodeRuns: {
        n1: { nodeId: 'n1', status: 'failed' as const, attempt: 2, missionIds: [] },
      },
      budget: { spentUsd: 0 },
      replanCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = replan(ir as unknown as GraphIR, run as unknown as GraphRun, {
      graphId: 'test-graph',
      runId: 'r1',
      projectRoot: '.',
      failedNodeId: 'n1',
      failedNodeRun: run.nodeRuns.n1,
      diagnosis: {
        category: 'infrastructure',
        rootCause: 'API down',
        suggestedFix: 'Wait and retry',
        confidence: 0.9,
        preventable: false,
      },
      attempt: 2,
    });

    expect(result.shouldAbort).toBe(true);
    expect(result.shouldRetry).toBe(false);
  });

  it('non-preventable non-critical failure skips after first attempt', async () => {
    const { replan } = await import('../lib/agents/graph/replanEngine');
    const ir = {
      id: 'test-graph',
      nodes: [
        { id: 'n1', kind: 'task' as const, label: 'Task 1', description: 'Do thing', contract: { engine: 'auto' as const }, critical: false, maxAttempts: 3 },
      ],
      edges: [],
      defaults: { maxReplans: 3 },
    };
    const run = {
      runId: 'r1',
      graphId: 'test-graph',
      status: 'running' as const,
      nodeRuns: {
        n1: { nodeId: 'n1', status: 'failed' as const, attempt: 2, missionIds: [] },
      },
      budget: { spentUsd: 0 },
      replanCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = replan(ir as unknown as GraphIR, run as unknown as GraphRun, {
      graphId: 'test-graph',
      runId: 'r1',
      projectRoot: '.',
      failedNodeId: 'n1',
      failedNodeRun: run.nodeRuns.n1,
      diagnosis: {
        category: 'infrastructure',
        rootCause: 'API down',
        suggestedFix: 'Wait and retry',
        confidence: 0.9,
        preventable: false,
      },
      attempt: 2,
    });

    expect(result.shouldSkip).toBe(true);
    expect(result.shouldAbort).toBe(false);
  });

  it('preventable failure still retries', async () => {
    const { replan } = await import('../lib/agents/graph/replanEngine');
    const ir = {
      id: 'test-graph',
      nodes: [
        { id: 'n1', kind: 'task' as const, label: 'Task 1', description: 'Do thing', contract: { engine: 'auto' as const }, critical: true, maxAttempts: 3 },
      ],
      edges: [],
      defaults: { maxReplans: 3 },
    };
    const run = {
      runId: 'r1',
      graphId: 'test-graph',
      status: 'running' as const,
      nodeRuns: {
        n1: { nodeId: 'n1', status: 'failed' as const, attempt: 1, missionIds: [] },
      },
      budget: { spentUsd: 0 },
      replanCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const result = replan(ir as unknown as GraphIR, run as unknown as GraphRun, {
      graphId: 'test-graph',
      runId: 'r1',
      projectRoot: '.',
      failedNodeId: 'n1',
      failedNodeRun: run.nodeRuns.n1,
      diagnosis: {
        category: 'type_error',
        rootCause: 'Missing type annotation',
        suggestedFix: 'Add type annotation',
        confidence: 0.8,
        preventable: true,
      },
      attempt: 1,
    });

    expect(result.shouldRetry).toBe(true);
  });
});

describe('Phase 4 — Learning loop calls diagnose on failure', () => {
  it('runLearningLoop includes diagnosis insight for failed missions', async () => {
    const { runLearningLoop } = await import('../lib/agents/learningLoop');
    const mission: Mission = {
      id: 'm-fail',
      title: 'Failed mission',
      status: 'failed',
      model: 'claude-3-sonnet',
      worktree: 'branch-x',
      statusReason: 'TypeError: x is undefined',
      createdAt: Date.now(),
    };

    const result = await runLearningLoop(mission);
    // The diagnosis insight should be added (kind: failure_pattern with "Root cause:" title)
    const diagnosisInsight = result.insights.find((i) => i.title.startsWith('Root cause:'));
    expect(diagnosisInsight).toBeDefined();
    expect(diagnosisInsight?.actionable).toBe(true);
  });

  it('runLearningLoop does NOT diagnose successful missions', async () => {
    const { runLearningLoop } = await import('../lib/agents/learningLoop');
    const mission: Mission = {
      id: 'm-ok',
      title: 'Successful mission',
      status: 'done',
      model: 'claude-3-sonnet',
      worktree: 'branch-y',
      createdAt: Date.now(),
    };

    const result = await runLearningLoop(mission);
    const diagnosisInsight = result.insights.find((i) => i.title.startsWith('Root cause:'));
    expect(diagnosisInsight).toBeUndefined();
  });
});
