import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mission } from '../lib/agents/types';
import { emitEvent } from '../lib/journal/journal';

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  journalQuery: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/agents/budgetTracker', () => ({
  isOverBudget: vi.fn(),
  wouldExceedBudget: vi.fn(),
  estimateMissionCostCents: vi.fn().mockReturnValue(10),
}));

vi.mock('../lib/agents/runtime', () => ({
  classifyMissionModel: vi.fn().mockReturnValue('managed'),
}));

import { dispatch, resetSchedulerForTests } from '../lib/agents/scheduler';
import { isOverBudget, wouldExceedBudget, estimateMissionCostCents } from '../lib/agents/budgetTracker';
import { classifyMissionModel } from '../lib/agents/runtime';
import { resetSystemPressureForTests } from '../lib/agents/systemPressure';

const mockedEmitEvent = vi.mocked(emitEvent);
const mockedIsOverBudget = vi.mocked(isOverBudget);
const mockedWouldExceedBudget = vi.mocked(wouldExceedBudget);
const mockedEstimateMissionCostCents = vi.mocked(estimateMissionCostCents);
const mockedClassifyMissionModel = vi.mocked(classifyMissionModel);

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Test mission',
    status: 'queued',
    model: 'anthropic/claude-sonnet-5',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetSchedulerForTests();
  resetSystemPressureForTests();
  vi.clearAllMocks();
  mockedEstimateMissionCostCents.mockReturnValue(10);
  mockedClassifyMissionModel.mockReturnValue('managed');
});

afterEach(() => {
  resetSchedulerForTests();
  resetSystemPressureForTests();
  vi.useRealTimers();
});

describe('dispatch — budget gate', () => {
  it('queues a mission whose budget is already exceeded, instead of launching it', async () => {
    mockedIsOverBudget.mockReturnValue(true);
    const launchFn = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M1' }), launchFn, { projectId: 'proj-1' });

    expect(launchFn).not.toHaveBeenCalled();
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scheduler.queued',
        missionId: 'M1',
        payload: expect.objectContaining({ reason: 'pool_full' }),
      }),
    );
  });

  it('queues a mission whose estimated cost would exceed budget, instead of launching it', async () => {
    mockedIsOverBudget.mockReturnValue(false);
    mockedWouldExceedBudget.mockReturnValue(true);
    const launchFn = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M2' }), launchFn, { projectId: 'proj-2' });

    expect(launchFn).not.toHaveBeenCalled();
    expect(mockedEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scheduler.queued',
        missionId: 'M2',
      }),
    );
    expect(mockedEstimateMissionCostCents).toHaveBeenCalled();
  });

  it('launches a mission with budget remaining', async () => {
    mockedIsOverBudget.mockReturnValue(false);
    mockedWouldExceedBudget.mockReturnValue(false);
    const launchFn = vi.fn().mockReturnValue(new Promise<void>(() => {}));

    await dispatch(makeMission({ id: 'M3' }), launchFn, { projectId: 'proj-3' });

    expect(launchFn).toHaveBeenCalledTimes(1);
    expect(mockedEmitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler.queued' }),
    );
  });
});
