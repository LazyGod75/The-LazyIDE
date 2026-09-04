import { describe, expect, it, vi } from 'vitest';
import {
  applyBudgetCap,
  applyDurationCap,
  classifyBudgetStatus,
  classifyDurationStatus,
  pauseUntilResumed,
  type MissionCapIo,
} from '../lib/agents/managedAgentCaps';

vi.mock('../lib/journal/journal', () => ({
  emitBuffered: vi.fn(),
  emitEvent: vi.fn(),
}));

function io(overrides: Partial<MissionCapIo> = {}): MissionCapIo {
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

describe('classifyBudgetStatus / classifyDurationStatus', () => {
  it('treats a missing or zero cap as unlimited', () => {
    expect(classifyBudgetStatus(99, undefined)).toBe('ok');
    expect(classifyBudgetStatus(99, 0)).toBe('ok');
    expect(classifyDurationStatus(99_000, undefined)).toBe('ok');
  });

  it('warns at 90% and exceeds at 100%', () => {
    expect(classifyBudgetStatus(9, 10)).toBe('warning');
    expect(classifyBudgetStatus(10, 10)).toBe('exceeded');
    expect(classifyDurationStatus(900, 1000)).toBe('warning');
    expect(classifyDurationStatus(1000, 1000)).toBe('exceeded');
  });
});

describe('applyBudgetCap', () => {
  it('hard-stops when spend is at or over the cap', async () => {
    const capIo = io();
    const onExceeded = vi.fn();
    const flow = await applyBudgetCap(capIo, {
      costUsd: 5,
      capUsd: 4,
      warned: false,
      markWarned: vi.fn(),
      onExceeded,
    });
    expect(flow).toBe('stop');
    expect(onExceeded).toHaveBeenCalledOnce();
    expect(capIo.emitMetrics).toHaveBeenCalledWith({ type: 'failed', reason: 'budget_exceeded' });
    expect(capIo.onAction).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Budget dépassé') }),
    );
  });

  it('does not invent a stop when there is no cap', async () => {
    expect(
      await applyBudgetCap(io(), {
        costUsd: 50,
        capUsd: undefined,
        warned: false,
        markWarned: vi.fn(),
      }),
    ).toBe('continue');
  });
});

describe('applyDurationCap', () => {
  it('hard-stops when elapsed wall-clock is at or over the cap', async () => {
    const capIo = io();
    const flow = await applyDurationCap(capIo, {
      elapsedMs: 2000,
      capMs: 1000,
      warned: false,
      markWarned: vi.fn(),
    });
    expect(flow).toBe('stop');
    expect(capIo.emitMetrics).toHaveBeenCalledWith({ type: 'failed', reason: 'duration_exceeded' });
  });
});

describe('pauseUntilResumed', () => {
  it('returns stop when the user hits Stop while paused', async () => {
    let ticks = 0;
    const capIo = io({
      pauseSignal: () => true,
      stopSignal: () => {
        ticks += 1;
        return ticks > 1;
      },
    });
    expect(await pauseUntilResumed(capIo)).toBe('stop');
    expect(capIo.onAction).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Agent stopped by user' }),
    );
  });
});
