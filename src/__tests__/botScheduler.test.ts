/* botScheduler.test.ts - unit tests for the bot routine scheduler.
   Mocks botStorage and botEngine. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextCronRun, isRoutineDue, startBotScheduler } from '../lib/bots/botScheduler';
import type { BotConfig, BotRoutine } from '../lib/bots/botTypes';

vi.mock('../lib/bots/botStorage', () => ({
  listBots: vi.fn().mockResolvedValue([]),
  saveBot: vi.fn().mockResolvedValue(undefined),
  getBot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/bots/botEngine', () => ({
  launchBotRun: vi.fn().mockResolvedValue({
    id: 'run_1', botId: 'bot_1', missionId: 'mission_1',
    status: 'running', startedAt: '2026-01-01T00:00:00.000Z',
  }),
  getBotRuntimeState: vi.fn(() => ({ activeRuns: [], lastError: undefined })),
  resetBotEngineState: vi.fn(),
}));

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn(),
}));

vi.mock('../lib/agents/projectRootCache', () => ({
  getCachedProjectRoot: () => '/tmp/proj',
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('nextCronRun', () => {
  it('returns a Date for a valid 5-field cron', () => {
    const result = nextCronRun('0 9 * * 1-5', new Date('2026-01-01T00:00:00Z'));
    expect(result).toBeInstanceOf(Date);
  });

  it('returns null for an invalid cron expression', () => {
    expect(nextCronRun('not a cron')).toBeNull();
  });

  it('returns null for a 4-field cron', () => {
    expect(nextCronRun('0 9 * *')).toBeNull();
  });

  it('handles */5 step patterns', () => {
    const result = nextCronRun('*/5 * * * *', new Date('2026-01-01T00:00:00Z'));
    expect(result).toBeInstanceOf(Date);
    expect(result!.getMinutes() % 5).toBe(0);
  });
});

describe('isRoutineDue', () => {
  function makeRoutine(overrides: Partial<BotRoutine> = {}): BotRoutine {
    return {
      id: 'rtn_1',
      name: 'Daily',
      schedule: '0 9 * * *',
      task: 'Check prices',
      enabled: true,
      lastRunAt: null,
      ...overrides,
    };
  }

  it('returns false when the routine is disabled', () => {
    const routine = makeRoutine({ enabled: false });
    expect(isRoutineDue(routine, new Date('2026-01-01T09:00:00Z'))).toBe(false);
  });

  it('returns true when the schedule matches and lastRunAt is null', () => {
    const routine = makeRoutine({ lastRunAt: null });
    expect(isRoutineDue(routine, new Date('2026-01-01T09:00:00Z'))).toBe(true);
  });

  it('returns false when the schedule does not match the current time', () => {
    const routine = makeRoutine({ lastRunAt: '2026-01-01T09:00:00.000Z' });
    expect(isRoutineDue(routine, new Date('2026-01-01T10:00:00Z'))).toBe(false);
  });
});

describe('startBotScheduler', () => {
  it('returns a handle with stop and tickNow functions', () => {
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
    });
    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.tickNow).toBe('function');
    handle.stop();
  });

  it('tickNow does not throw when there are no bots', async () => {
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
    });
    await expect(handle.tickNow()).resolves.toBeUndefined();
    handle.stop();
  });

  it('fires due routines and calls onRoutineFired', async () => {
    const { listBots } = await import('../lib/bots/botStorage');
    const bot: BotConfig = {
      id: 'bot_1', name: 'Test', description: 'test',
      systemPrompt: 'You are a bot.', autonomy: 'supervised',
      capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
      routines: [{
        id: 'rtn_1', name: 'Daily', schedule: '* * * * *',
        task: 'Run task', enabled: true, lastRunAt: null,
      }],
      profileIds: [], enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listBots).mockResolvedValue([bot]);

    const onRoutineFired = vi.fn();
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
      onRoutineFired,
    });
    await handle.tickNow();
    expect(onRoutineFired).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('persists lastRunAt for ALL due routines in the same tick (no stale-snapshot overwrite)', async () => {
    const { listBots } = await import('../lib/bots/botStorage');
    const { saveBot } = await import('../lib/bots/botStorage');
    const bot: BotConfig = {
      id: 'bot_1', name: 'Test', description: 'test',
      systemPrompt: 'You are a bot.', autonomy: 'supervised',
      capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
      routines: [
        { id: 'r1', name: 'R1', schedule: '* * * * *', task: 't1', enabled: true, lastRunAt: null },
        { id: 'r2', name: 'R2', schedule: '* * * * *', task: 't2', enabled: true, lastRunAt: null },
      ],
      profileIds: [], enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listBots).mockResolvedValue([bot]);

    const onRoutineFired = vi.fn();
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
      onRoutineFired,
    });
    await handle.tickNow();
    handle.stop();

    expect(onRoutineFired).toHaveBeenCalledTimes(2);
    // The final persisted bot must carry lastRunAt for BOTH routines —
    // saving r2 must not erase the lastRunAt just saved for r1.
    const lastSave = vi.mocked(saveBot).mock.calls.at(-1)?.[0] as BotConfig;
    const r1 = lastSave.routines.find((r) => r.id === 'r1');
    const r2 = lastSave.routines.find((r) => r.id === 'r2');
    expect(r1?.lastRunAt).not.toBeNull();
    expect(r2?.lastRunAt).not.toBeNull();
  });

  it('surfaces launch failures via onRoutineFailed (C76)', async () => {
    const { listBots } = await import('../lib/bots/botStorage');
    const { launchBotRun } = await import('../lib/bots/botEngine');
    const bot: BotConfig = {
      id: 'bot_1', name: 'Test', description: 'test',
      systemPrompt: 'You are a bot.', autonomy: 'supervised',
      capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
      routines: [{
        id: 'rtn_1', name: 'Daily', schedule: '* * * * *',
        task: 'Run task', enabled: true, lastRunAt: null,
      }],
      profileIds: [], enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listBots).mockResolvedValue([bot]);
    vi.mocked(launchBotRun).mockRejectedValueOnce(new Error('boom'));

    const onRoutineFailed = vi.fn();
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
      onRoutineFailed,
    });
    await handle.tickNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(onRoutineFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bot_1' }),
      expect.objectContaining({ id: 'rtn_1' }),
      'boom',
    );
    handle.stop();
  });

  it('fires a git_commit-triggered routine when HEAD changes (event, no cron)', async () => {
    const { listBots, saveBot } = await import('../lib/bots/botStorage');
    const bot: BotConfig = {
      id: 'bot_1', name: 'Reviewer', description: 'test',
      systemPrompt: 'You are a bot.', autonomy: 'supervised',
      capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
      routines: [{
        id: 'rtn_1', name: 'On commit', schedule: '',
        task: 'Review the new commit', enabled: true, lastRunAt: null,
        trigger: { kind: 'git_commit' }, lastTriggerToken: 'aaa111',
      }],
      profileIds: [], enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listBots).mockResolvedValue([bot]);

    const onRoutineFired = vi.fn();
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
      onRoutineFired,
      getTriggerContext: async () => ({ headSha: 'bbb222', terminalMissions: [] }),
    });
    await handle.tickNow();
    handle.stop();

    expect(onRoutineFired).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveBot).mock.calls.at(-1)?.[0] as BotConfig;
    expect(saved.routines[0].lastTriggerToken).toBe('bbb222');
  });

  it('does not re-fire a git_commit routine for the already-seen HEAD', async () => {
    const { listBots } = await import('../lib/bots/botStorage');
    const bot: BotConfig = {
      id: 'bot_1', name: 'Reviewer', description: 'test',
      systemPrompt: 'You are a bot.', autonomy: 'supervised',
      capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
      routines: [{
        id: 'rtn_1', name: 'On commit', schedule: '',
        task: 'Review', enabled: true, lastRunAt: null,
        trigger: { kind: 'git_commit' }, lastTriggerToken: 'aaa111',
      }],
      profileIds: [], enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listBots).mockResolvedValue([bot]);

    const onRoutineFired = vi.fn();
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
      onRoutineFired,
      getTriggerContext: async () => ({ headSha: 'aaa111', terminalMissions: [] }),
    });
    await handle.tickNow();
    handle.stop();
    expect(onRoutineFired).not.toHaveBeenCalled();
  });

  it('fires a mission_done routine on a fresh terminal mission', async () => {
    const { listBots } = await import('../lib/bots/botStorage');
    const bot: BotConfig = {
      id: 'bot_1', name: 'Notifier', description: 'test',
      systemPrompt: 'You are a bot.', autonomy: 'supervised',
      capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
      routines: [{
        id: 'rtn_1', name: 'On failure', schedule: '',
        task: 'Investigate the failure', enabled: true, lastRunAt: null,
        trigger: { kind: 'mission_done', status: 'failed' },
      }],
      profileIds: [], enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(listBots).mockResolvedValue([bot]);

    const onRoutineFired = vi.fn();
    const handle = startBotScheduler({
      createMission: async () => 'M1',
      defaultModelId: () => 'test-model',
      onRoutineFired,
      getTriggerContext: async () => ({
        headSha: null,
        terminalMissions: [
          { id: 'M50', status: 'done' },
          { id: 'M51', status: 'failed' },
        ],
      }),
    });
    await handle.tickNow();
    handle.stop();
    expect(onRoutineFired).toHaveBeenCalledTimes(1);
  });
});
