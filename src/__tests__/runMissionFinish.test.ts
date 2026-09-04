import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission } from '../lib/agents/types';
import type { CompiledPlan } from '../lib/agents/stageContract';
import type { FinishAfterLoopOpts } from '../lib/agents/runMissionFinish';
import type { MissionDiffSlice } from '../lib/agents/runMissionReview';

vi.mock('../lib/agents/runMissionFanout', () => ({
  fanOutOrchestratorSubAgents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/agents/runMissionReview', () => ({
  failEmptyStepCapDeliverable: vi.fn().mockResolvedValue(undefined),
  announceReviewReady: vi.fn().mockReturnValue([]),
  runAutomatedEvaluation: vi.fn().mockResolvedValue(undefined),
}));

import { fanOutOrchestratorSubAgents } from '../lib/agents/runMissionFanout';
import {
  failEmptyStepCapDeliverable,
  announceReviewReady,
  runAutomatedEvaluation,
} from '../lib/agents/runMissionReview';
import { finishMissionAfterAgentLoop } from '../lib/agents/runMissionFinish';

const emptyDiff: MissionDiffSlice = {
  diffSnippet: [],
  diffAdded: 0,
  diffRemoved: 0,
  diffFiles: [],
  diffIncompleteFiles: [],
  emptyDeliverable: true,
};

function base(partial: Partial<FinishAfterLoopOpts> = {}): FinishAfterLoopOpts {
  return {
    afterLoop: { kind: 'continue', stepCapFallthroughReason: null },
    mission: { id: 'M1', title: 'Fix' } as Mission,
    repoPath: '/repo',
    worktreePath: '/repo/.lazy/worktrees/M1',
    projectId: 'p1',
    branch: 'agent/M1-fix',
    compiled: { graph: { stages: [] } } as unknown as CompiledPlan,
    missionStartedAt: 1,
    timeline: [],
    onUpdate: vi.fn(),
    tool: 'claude',
    model: 'sonnet',
    captureOutcome: vi.fn(),
    computeDiff: vi.fn().mockResolvedValue(emptyDiff),
    markSettled: vi.fn(),
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    ...partial,
  };
}

beforeEach(() => {
  vi.mocked(failEmptyStepCapDeliverable).mockClear();
  vi.mocked(announceReviewReady).mockClear();
  vi.mocked(runAutomatedEvaluation).mockClear();
  vi.mocked(fanOutOrchestratorSubAgents).mockClear();
});

describe('finishMissionAfterAgentLoop', () => {
  it('returns immediately when settle already stopped the mission', async () => {
    const computeDiff = vi.fn();
    await finishMissionAfterAgentLoop(base({
      afterLoop: { kind: 'stop' },
      computeDiff,
    }));
    expect(computeDiff).not.toHaveBeenCalled();
    expect(announceReviewReady).not.toHaveBeenCalled();
  });

  it('fails an empty step-cap deliverable instead of opening review', async () => {
    await finishMissionAfterAgentLoop(base({
      afterLoop: { kind: 'continue', stepCapFallthroughReason: 'max_steps_exhausted' },
    }));
    expect(failEmptyStepCapDeliverable).toHaveBeenCalledOnce();
    expect(announceReviewReady).not.toHaveBeenCalled();
    expect(fanOutOrchestratorSubAgents).not.toHaveBeenCalled();
  });

  it('announces review, fans out, then evaluates when there is a deliverable', async () => {
    const diff: MissionDiffSlice = { ...emptyDiff, emptyDeliverable: false, diffAdded: 4 };
    await finishMissionAfterAgentLoop(base({
      computeDiff: vi.fn().mockResolvedValue(diff),
    }));
    expect(failEmptyStepCapDeliverable).not.toHaveBeenCalled();
    expect(announceReviewReady).toHaveBeenCalledOnce();
    expect(fanOutOrchestratorSubAgents).toHaveBeenCalledOnce();
    expect(runAutomatedEvaluation).toHaveBeenCalledOnce();
  });
});
