import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission, ActionEvent, AgentMetrics, PlanStep } from '../lib/agents/types';
import type { CompiledPlan } from '../lib/agents/stageContract';
import type { AgentLoopRef, AfterLoopOpts } from '../lib/agents/runMissionSettle';

vi.mock('../lib/journal/journal', () => ({
  emitBuffered: vi.fn(),
}));

import { emitBuffered } from '../lib/journal/journal';
import { settleAfterAgentLoop } from '../lib/agents/runMissionSettle';

function compiled(): CompiledPlan {
  return {
    graph: {
      stages: [{ kind: 'implement', attemptCount: 0 } as CompiledPlan['graph']['stages'][0]],
    },
  } as CompiledPlan;
}

function mission(): Mission {
  return { id: 'M1', title: 'Fix', status: 'running' } as Mission;
}

function makeLoop(overrides: Partial<{
  timeline: ActionEvent[];
  steps: PlanStep[];
  agentFailed: boolean;
  budgetExceeded: boolean;
  durationExceeded: boolean;
  managedFailed: { reason: string } | null;
}> = {}): AgentLoopRef {
  let timeline = overrides.timeline ?? [];
  let steps: PlanStep[] = overrides.steps ?? [];
  let agentFailed = overrides.agentFailed ?? false;
  let budgetExceeded = overrides.budgetExceeded ?? false;
  let durationExceeded = overrides.durationExceeded ?? false;
  const managedOutcome = { failed: overrides.managedFailed ?? null };
  let finalMetrics: AgentMetrics | undefined = undefined;
  return {
    get timeline() { return timeline; },
    set timeline(v) { timeline = v; },
    get steps() { return steps; },
    set steps(v) { steps = v; },
    get agentFailed() { return agentFailed; },
    set agentFailed(v) { agentFailed = v; },
    get budgetExceeded() { return budgetExceeded; },
    set budgetExceeded(v) { budgetExceeded = v; },
    get durationExceeded() { return durationExceeded; },
    set durationExceeded(v) { durationExceeded = v; },
    get finalMetrics() { return finalMetrics; },
    set finalMetrics(v) { finalMetrics = v; },
    managedOutcome,
  };
}

function opts(partial: Partial<AfterLoopOpts> & { loop: AgentLoopRef }): AfterLoopOpts {
  return {
    mission: mission(),
    projectId: 'p1',
    branch: 'agent/m1',
    compiled: compiled(),
    missionStartedAt: Date.now(),
    onUpdate: vi.fn(),
    stopSignal: () => false,
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    settleCapExceeded: vi.fn().mockResolvedValue(undefined),
    markSettled: vi.fn(),
    runPass: vi.fn().mockResolvedValue(undefined),
    captureOutcome: vi.fn(),
    formatBudget: () => ({ text: 'budget', reason: 'budget' }),
    formatDuration: () => ({ text: 'duration', reason: 'duration' }),
    ...partial,
  };
}

beforeEach(() => {
  vi.mocked(emitBuffered).mockClear();
});

describe('settleAfterAgentLoop', () => {
  it('cancels when stopSignal is already true', async () => {
    const captureOutcome = vi.fn();
    const result = await settleAfterAgentLoop(opts({
      loop: makeLoop(),
      stopSignal: () => true,
      captureOutcome,
    }));
    expect(result).toEqual({ kind: 'stop' });
    expect(captureOutcome).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      'cancelled',
      expect.any(Number),
    );
  });

  it('does not retry no_credits — blocks immediately', async () => {
    const runPass = vi.fn();
    const loop = makeLoop({
      agentFailed: true,
      managedFailed: { reason: 'no_credits' },
      timeline: [{ time: '00:00', text: 'Erreur agent: wallet empty', isLive: false }],
    });
    const result = await settleAfterAgentLoop(opts({ loop, runPass }));
    expect(result.kind).toBe('stop');
    expect(runPass).not.toHaveBeenCalled();
  });

  it('continues with step-cap reason so Step C can salvage a deliverable', async () => {
    const loop = makeLoop({ managedFailed: { reason: 'max_steps_exhausted' } });
    const result = await settleAfterAgentLoop(opts({ loop }));
    expect(result).toEqual({ kind: 'continue', stepCapFallthroughReason: 'max_steps_exhausted' });
    expect(loop.timeline.at(-1)?.text).toMatch(/Step cap reached/);
  });

  it('settles translated Agent error: prefix the same as French', async () => {
    const loop = makeLoop({
      agentFailed: true,
      managedFailed: { reason: 'no_credits' },
      timeline: [{ time: '00:00', text: 'Agent error: wallet empty', isLive: false, kind: 'error' }],
    });
    const result = await settleAfterAgentLoop(opts({ loop }));
    expect(result.kind).toBe('stop');
  });
});
