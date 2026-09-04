import { describe, expect, it, vi } from 'vitest';
import { composeManagedTaskPrompt, buildProofPolicyBlock } from '../lib/agents/managedAgentPrepare';
import { missingRequiredProofKinds, shouldBounceFinal, missingProofNudgeContent } from '../lib/agents/managedAgentFinal';
import { extractToolFiles } from '../lib/agents/managedAgentExecute';
import { fastTrackUnparseable, parseReActActionWithRetry } from '../lib/agents/managedAgentParse';
import { classifyManagedTurnError, applyManagedTurnError } from '../lib/agents/managedAgentTurnError';
import { nextConsecutiveFailures, toolHasTestFailure } from '../lib/agents/managedAgentAftermath';
import { ManagedUnavailableError } from '../lib/models/managedProvider';
import { guardManagedLoopStep, workingMessagesWithReflections, advanceManagedMilestones } from '../lib/agents/managedAgentLoopGuard';
import { applyMissionCaps } from '../lib/agents/managedAgentCaps';
import type { MissionCapIo } from '../lib/agents/managedAgentCaps';
import { collectManagedTurnText, failManagedMaxSteps, runManagedTurn } from '../lib/agents/managedAgentTurn';
import { announceManagedStep } from '../lib/agents/managedAgentAction';
import { applyManagedLoopStep } from '../lib/agents/managedAgentLoop';

describe('composeManagedTaskPrompt', () => {
  it('omits the brain block when recall is empty', () => {
    expect(composeManagedTaskPrompt({
      harnessBlockSuffix: 'HARNESS\n\n',
      startupBlock: '',
      coreTask: 'fix auth',
      worktreePath: '/wt',
      brainContext: '',
      skillContext: '',
    })).toBe('HARNESS\n\nTask: fix auth\nWorking directory: /wt');
  });

  it('appends brain then skills when both are present', () => {
    const text = composeManagedTaskPrompt({
      harnessBlockSuffix: '',
      startupBlock: '',
      coreTask: 'fix auth',
      worktreePath: '/wt',
      brainContext: '[FILE] auth.ts',
      skillContext: 'SKILL: tests',
    });
    expect(text).toBe('Task: fix auth\nWorking directory: /wt\n\n[FILE] auth.ts\n\nSKILL: tests');
  });
});

describe('buildProofPolicyBlock', () => {
  it('is a no-op without requirements', () => {
    expect(buildProofPolicyBlock(undefined)).toBe('');
    expect(buildProofPolicyBlock([])).toBe('');
  });

  it('lists required kinds once', () => {
    const block = buildProofPolicyBlock([
      { kind: 'test_run' },
      { kind: 'test_run' },
      { kind: 'screenshot' },
    ]);
    expect(block).toContain('test_run, screenshot');
    expect(block).toContain('ACTION: attach_proof');
  });
});

describe('shouldBounceFinal', () => {
  it('bounces while a required kind is missing', () => {
    expect(shouldBounceFinal({
      proofRequirements: [{ kind: 'test_run' }],
      attachedProofs: [],
      proofNudges: 0,
      maxProofNudges: 2,
    })).toEqual(['test_run']);
  });

  it('lets FINAL through once the cap of nudges is spent', () => {
    expect(shouldBounceFinal({
      proofRequirements: [{ kind: 'test_run' }],
      attachedProofs: [],
      proofNudges: 2,
      maxProofNudges: 2,
    })).toBeNull();
  });

  it('lets FINAL through when every required kind is attached', () => {
    expect(missingRequiredProofKinds(
      [{ kind: 'test_run' }],
      [{ kind: 'test_run' }],
    )).toEqual([]);
    expect(shouldBounceFinal({
      proofRequirements: [{ kind: 'test_run' }],
      attachedProofs: [{ kind: 'test_run' }],
      proofNudges: 0,
      maxProofNudges: 2,
    })).toBeNull();
  });

  it('keeps the original bounce prompt wording', () => {
    expect(missingProofNudgeContent('test_run')).toContain('ACTION: attach_proof');
    expect(missingProofNudgeContent('test_run')).toContain('test_run');
  });
});

describe('extractToolFiles', () => {
  it('collects path-bearing args and omits empty', () => {
    expect(extractToolFiles({ path: 'a.ts', old_path: 'b.ts' })).toEqual(['a.ts', 'b.ts']);
    expect(extractToolFiles({ paths: ['c.ts', 1, ''] })).toEqual(['c.ts']);
    expect(extractToolFiles({})).toBeUndefined();
  });
});

describe('fastTrackUnparseable', () => {
  it('fast-tracks the cap when the same unparseable shape repeats', () => {
    const first = fastTrackUnparseable('nope', 0, null, 3);
    expect(first.consecutiveFailures).toBe(1);
    expect(first.hitCap).toBe(false);
    const second = fastTrackUnparseable('nope', first.consecutiveFailures, first.lastUnparseableSignature, 3);
    expect(second.consecutiveFailures).toBe(3);
    expect(second.hitCap).toBe(true);
  });

  it('does not fast-track a different failure shape', () => {
    const next = fastTrackUnparseable('other', 1, 'nope', 3);
    expect(next.consecutiveFailures).toBe(2);
    expect(next.hitCap).toBe(false);
  });
});

describe('parseReActActionWithRetry', () => {
  it('does not call retry when the first parse succeeds', async () => {
    const retry = vi.fn(async () => 'ACTION: FINAL\nARGS: {}');
    const parsed = await parseReActActionWithRetry('ACTION: FINAL\nARGS: {}', retry);
    expect(parsed).toEqual({ action: 'FINAL', args: {} });
    expect(retry).not.toHaveBeenCalled();
  });

  it('retries once when the first parse fails', async () => {
    const parsed = await parseReActActionWithRetry('garbage', async () => 'ACTION: FINAL\nARGS: {}');
    expect(parsed).toEqual({ action: 'FINAL', args: {} });
  });
});

describe('classifyManagedTurnError', () => {
  it('treats AbortError as a hard stop, not a retry', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyManagedTurnError(err)).toEqual({ kind: 'abort' });
  });

  it('treats no_credits as a hard stop', () => {
    expect(classifyManagedTurnError(new ManagedUnavailableError('empty', 'no_credits'))).toEqual({ kind: 'no_credits' });
  });

  it('retries a generic network error and escalates at the cap', () => {
    const onAction = vi.fn();
    const escalateAndStop = vi.fn();
    const first = applyManagedTurnError(new Error('net'), {
      consecutiveFailures: 0,
      maxConsecutiveFailures: 3,
      nowTime: () => '12:00',
      onAction,
      stopForNoCredits: vi.fn(),
      stopForDefinitiveProviderError: vi.fn(),
      escalateAndStop,
    });
    expect(first).toEqual({ retry: 1 });
    const last = applyManagedTurnError(new Error('net'), {
      consecutiveFailures: 2,
      maxConsecutiveFailures: 3,
      nowTime: () => '12:00',
      onAction,
      stopForNoCredits: vi.fn(),
      stopForDefinitiveProviderError: vi.fn(),
      escalateAndStop,
    });
    expect(last).toBe('stop');
    expect(escalateAndStop).toHaveBeenCalledOnce();
  });
});

describe('nextConsecutiveFailures', () => {
  it('increments on ERROR observations and resets otherwise', () => {
    expect(nextConsecutiveFailures('ERROR: boom', 1)).toBe(2);
    expect(nextConsecutiveFailures('ok', 2)).toBe(0);
  });

  it('does not count a test-failure observation as a V4 error', () => {
    expect(toolHasTestFailure('3 failed')).toBe(true);
    expect(nextConsecutiveFailures('3 failed', 2)).toBe(0);
  });
});

describe('workingMessagesWithReflections', () => {
  it('pins reflections after the first user turn', () => {
    const out = workingMessagesWithReflections(
      [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'a' }],
      ['missed a semicolon'],
      (msgs) => ({ messages: msgs }),
    );
    expect(out[0]).toEqual({ role: 'user', content: 'task' });
    expect(out[1]?.content).toContain('missed a semicolon');
    expect(out[2]).toEqual({ role: 'assistant', content: 'a' });
  });
});

describe('guardManagedLoopStep', () => {
  function cap(overrides: Partial<MissionCapIo> = {}): MissionCapIo {
    return {
      projectId: 'p1',
      missionId: 'm1',
      pauseSignal: () => false,
      stopSignal: () => false,
      pausePollMs: 1,
      onAction: vi.fn(),
      onStep: vi.fn(),
      onProgress: vi.fn(),
      emitMetrics: vi.fn(),
      nowTime: () => '12:00',
      delay: async () => undefined,
      ...overrides,
    };
  }

  it('stops on the structural iteration cap', async () => {
    const io = cap();
    expect(await guardManagedLoopStep({
      loopIterationCount: 201,
      maxLoopIterations: 200,
      capIo: io,
      drainIntervenes: () => [],
      messages: [],
    })).toBe('stop');
    expect(io.emitMetrics).toHaveBeenCalledWith({ type: 'failed', reason: 'iteration_cap_exceeded' });
  });

  it('injects user interventions as user turns', async () => {
    const out = await guardManagedLoopStep({
      loopIterationCount: 1,
      maxLoopIterations: 200,
      capIo: cap(),
      drainIntervenes: () => ['use the other file'],
      messages: [{ role: 'user', content: 'task' }],
    });
    expect(out).not.toBe('stop');
    if (out === 'stop') return;
    expect(out.messages.at(-1)?.content).toBe('[User intervention] use the other file');
  });
});

describe('advanceManagedMilestones', () => {
  it('flips step 1 then the midpoint', () => {
    const onStep = vi.fn();
    advanceManagedMilestones(1, 100, () => '12:00', onStep);
    expect(onStep).toHaveBeenCalledWith(2, 'in_progress');
    onStep.mockClear();
    advanceManagedMilestones(50, 100, () => '12:00', onStep);
    expect(onStep).toHaveBeenCalledWith(3, 'in_progress');
  });
});

describe('applyMissionCaps', () => {
  it('continues when both caps are absent', async () => {
    const io = {
      projectId: 'p1',
      missionId: 'm1',
      pauseSignal: () => false,
      stopSignal: () => false,
      pausePollMs: 1,
      onAction: vi.fn(),
      onStep: vi.fn(),
      onProgress: vi.fn(),
      emitMetrics: vi.fn(),
      nowTime: () => '12:00',
      delay: async () => undefined,
    };
    expect(await applyMissionCaps(
      io,
      { costUsd: 9, capUsd: undefined, warned: false, markWarned: vi.fn() },
      { elapsedMs: 1, capMs: undefined, warned: false, markWarned: vi.fn() },
    )).toBe('continue');
  });
});

describe('collectManagedTurnText', () => {
  it('concatenates stream chunks in order', async () => {
    async function* chunks() {
      yield 'THOUGHT: go\n';
      yield 'ACTION: FINAL\n';
      yield 'ARGS: {"summary":"ok"}';
    }
    expect(await collectManagedTurnText(chunks())).toBe(
      'THOUGHT: go\nACTION: FINAL\nARGS: {"summary":"ok"}',
    );
  });
});

describe('failManagedMaxSteps', () => {
  it('emits max_steps_exhausted after processing traces', async () => {
    const processTraces = vi.fn().mockResolvedValue(undefined);
    const onAction = vi.fn();
    const emitMetrics = vi.fn();
    await failManagedMaxSteps({
      maxSteps: 100,
      processTraces,
      nowTime: () => '12:00',
      onAction,
      onStep: vi.fn(),
      onProgress: vi.fn(),
      emitMetrics,
    });
    expect(processTraces).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith({
      time: '12:00',
      text: 'Max steps (100) reached — stopping',
      isLive: false,
    });
    expect(emitMetrics).toHaveBeenCalledWith({ type: 'failed', reason: 'max_steps_exhausted' });
  });
});

describe('runManagedTurn', () => {
  it('returns stop when collectTurn throws AbortError', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = await runManagedTurn({
      messages: [{ role: 'user', content: 'task' }],
      reflections: [],
      boundHistory: (msgs) => ({ messages: msgs }),
      collectTurn: async () => { throw err; },
      addTurnTokens: vi.fn(),
      consecutiveFailures: 0,
      lastUnparseableSignature: null,
      maxConsecutiveFailures: 3,
      turnError: {
        consecutiveFailures: 0,
        maxConsecutiveFailures: 3,
        nowTime: () => '12:00',
        onAction: vi.fn(),
        stopForNoCredits: vi.fn(),
        stopForDefinitiveProviderError: vi.fn(),
        escalateAndStop: vi.fn(),
      },
      checkpoint: { missionId: 'm1', messages: [], step: 0, costUsd: 0, proofCount: 0 },
      steering: {
        pipeline: { run: async () => ({ injected: [] }), compressOutput: (t: string) => t } as never,
        step: 0,
        coreTask: 'task',
        projectId: 'p1',
        missionId: 'm1',
        model: 'test',
        nowTime: () => '12:00',
        onAction: vi.fn(),
      },
      capIo: {
        projectId: 'p1',
        missionId: 'm1',
        pauseSignal: () => false,
        stopSignal: () => false,
        pausePollMs: 1,
        onAction: vi.fn(),
        onStep: vi.fn(),
        onProgress: vi.fn(),
        emitMetrics: vi.fn(),
        nowTime: () => '12:00',
        delay: async () => undefined,
      },
      getBudget: () => ({ costUsd: 0, capUsd: undefined, warned: false, markWarned: vi.fn() }),
      getDuration: () => ({ elapsedMs: 1, capMs: undefined, warned: false, markWarned: vi.fn() }),
      retryParse: async () => '',
      step: 0,
      nowTime: () => '12:00',
      onAction: vi.fn(),
      escalateAndStop: vi.fn(),
    });
    expect(result).toBe('stop');
  });
});

describe('announceManagedStep', () => {
  it('appends the assistant turn without mutating the input messages', () => {
    const messages = [{ role: 'user', content: 'task' }];
    const next = announceManagedStep({
      action: 'read_file',
      args: { path: 'a.ts' },
      cleaned: 'ACTION: read_file',
      messages,
      reflections: [],
      consecutiveFailures: 0,
      proofNudges: 0,
      prmInvocations: 0,
      prmMax: 2,
      toolCallCount: 0,
      step: 0,
      maxSteps: 100,
      maxProofNudges: 2,
      maxConsecutiveFailures: 3,
      attachedProofs: [],
      executedCallsAtStep: new Map(),
      worktreePath: '/wt',
      policy: {},
      agentMode: 'default',
      missionId: 'm1',
      missionTitle: 't',
      projectId: 'p1',
      coreTask: 'task',
      model: 'test',
      nowTime: () => '12:00',
      onAction: vi.fn(),
      onStep: vi.fn(),
      onProgress: vi.fn(),
      emitMetrics: vi.fn(),
      attachProof: async () => 'ok',
      execute: async () => 'ok',
      traceBuffer: { processAtMissionEnd: async () => undefined } as never,
      pipeline: { compressOutput: (t: string) => t } as never,
      toolCallHistory: [],
      stepHistory: [],
      aftermathIo: {} as never,
      initialUserMessage: { role: 'user', content: 'task' },
    });
    expect(messages).toHaveLength(1);
    expect(next).toEqual([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'ACTION: read_file' },
    ]);
  });
});

describe('applyManagedLoopStep', () => {
  const capIo = {
    projectId: 'p1',
    missionId: 'm1',
    pauseSignal: () => false,
    stopSignal: () => false,
    pausePollMs: 1,
    onAction: vi.fn(),
    onStep: vi.fn(),
    onProgress: vi.fn(),
    emitMetrics: vi.fn(),
    nowTime: () => '12:00',
    delay: async () => undefined,
  };
  const state = {
    messages: [{ role: 'user', content: 'task' }],
    reflections: [] as string[],
    consecutiveFailures: 0,
    lastUnparseableSignature: null as string | null,
    proofNudges: 0,
    prmInvocations: 0,
    toolCallCount: 0,
  };

  it('returns stop when the turn stops', async () => {
    expect(await applyManagedLoopStep({
      state,
      loopIterationCount: 1,
      maxLoopIterations: 200,
      capIo,
      drainIntervenes: () => [],
      runTurn: async () => 'stop',
      runAction: async () => 'stop',
    })).toBe('stop');
  });

  it('applies retry without touching lastUnparseableSignature when the stream failed', async () => {
    const next = await applyManagedLoopStep({
      state: { ...state, lastUnparseableSignature: 'prev' },
      loopIterationCount: 1,
      maxLoopIterations: 200,
      capIo,
      drainIntervenes: () => [],
      runTurn: async () => ({
        kind: 'retry',
        consecutiveFailures: 1,
        messages: [{ role: 'user', content: 'task' }],
      }),
      runAction: async () => 'stop',
    });
    expect(next).toMatchObject({
      consecutiveFailures: 1,
      lastUnparseableSignature: 'prev',
    });
  });
});
