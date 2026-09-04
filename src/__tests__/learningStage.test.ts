import { describe, it, expect, vi } from 'vitest';
import { compilePlan, formatCompiledPlanGuide, isLearningReady } from '../lib/agents/stageContract';
import { executeLearningStage, markExecutionStagesDone } from '../lib/agents/learningStage';
import type { Mission } from '../lib/agents/types';

vi.mock('../lib/agents/learningLoop', () => ({
  runLearningLoop: vi.fn(async () => ({
    insights: [{ id: 'i1', kind: 'success_pattern', title: 'ok', description: 'd', actionable: false, createdAt: '2026-09-03' }],
    brainCaptured: false,
    summary: '1 insight',
  })),
}));

function baseMission(): Mission {
  return {
    id: 'm1',
    title: 'Add feature',
    status: 'done',
    agentName: 'coder',
    model: 'anthropic/claude-sonnet-4',
    createdAt: Date.now(),
  } as Mission;
}

describe('learning stage (B37)', () => {
  it('isLearningReady is false until execution stages are done', () => {
    const plan = compilePlan({
      mission: { id: 'm1', title: 'Add feature', agentTask: 'implement', agentName: 'coder', model: 'x' },
      brainRecall: null,
    });
    expect(isLearningReady(plan)).toBe(false);
    const marked = markExecutionStagesDone(plan);
    expect(isLearningReady(marked)).toBe(true);
  });

  it('executeLearningStage runs learning and completes the stage', async () => {
    const plan = compilePlan({
      mission: { id: 'm1', title: 'Add feature', agentTask: 'implement', agentName: 'coder', model: 'x' },
      brainRecall: null,
    });
    const result = await executeLearningStage(plan, baseMission());
    expect(result.ran).toBe(true);
    expect(result.insights).toHaveLength(1);
    const learning = result.plan?.graph.stages.find((s) => s.kind === 'learning');
    expect(learning?.state).toBe('done');
  });
});

describe('formatCompiledPlanGuide (B38)', () => {
  it('emits an ordered ReAct soft guide from compiled stages', () => {
    const plan = compilePlan({
      mission: { id: 'm1', title: 'Add feature', agentTask: 'implement', agentName: 'coder', model: 'x' },
      brainRecall: null,
    });
    const guide = formatCompiledPlanGuide(plan);
    expect(guide).toContain('<compiled_plan_guide>');
    expect(guide).toContain('[implement]');
    expect(guide).toContain('ReAct');
    expect(guide).not.toContain('[learning]');
  });
});
