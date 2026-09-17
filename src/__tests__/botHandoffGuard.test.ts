/* botHandoffGuard.test.ts — guards and blocking behavior for bot-to-bot handoffs.
   Mocks botStorage, botEngine, and botRuntimeStore. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handoffToBot, resetHandoffDepth } from '../lib/bots/botHandoff';
import type { BotConfig } from '../lib/bots/botTypes';

vi.mock('../lib/bots/botStorage', () => ({
  listBots: vi.fn().mockResolvedValue([]),
  saveBot: vi.fn().mockResolvedValue(undefined),
  getBot: vi.fn(),
}));

vi.mock('../lib/bots/botEngine', () => ({
  launchBotRun: vi.fn().mockResolvedValue({
    id: 'run_mission_1',
    botId: 'bot_2',
    missionId: 'mission_1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
  }),
  getBotRuntimeState: vi.fn(() => ({ activeRuns: [], lastError: undefined })),
  resetBotEngineState: vi.fn(),
}));

vi.mock('../lib/bots/botRuntimeStore', () => ({
  listBotRunHistory: vi.fn().mockResolvedValue([]),
}));

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot_1',
    name: 'Parent Bot',
    description: 'test',
    systemPrompt: 'You are a parent bot.',
    autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [],
    profileIds: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHandoffDepth();
});

describe('handoffToBot guards', () => {
  it('refuses to hand off a bot to itself', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    vi.mocked(getBot).mockResolvedValue(makeBot());

    const result = await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'bot_1',
      task: 'Check prices',
      createMission: async () => 'M1',
      model: 'test-model',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('itself');
  });

  it('enforces the handoff depth limit per child bot', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    const { launchBotRun } = await import('../lib/bots/botEngine');
    const childBot = makeBot({ id: 'bot_2', name: 'Child Bot' });
    vi.mocked(getBot).mockResolvedValue(childBot);

    for (let i = 0; i < 4; i += 1) {
      const result = await handoffToBot({
        fromBot: makeBot(),
        toBotIdOrName: 'bot_2',
        task: 'task',
        createMission: async () => 'M1',
        model: 'test-model',
      });
      expect(result.success).toBe(true);
    }

    const blocked = await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'bot_2',
      task: 'one too many',
      createMission: async () => 'M1',
      model: 'test-model',
    });

    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('depth limit');
    expect(vi.mocked(launchBotRun)).toHaveBeenCalledTimes(4);
  });

  it('resolves a target by name using resolveLazyBotRef', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    const { listBots } = await import('../lib/bots/botStorage');
    const { launchBotRun } = await import('../lib/bots/botEngine');

    const childBot = makeBot({ id: 'bot_2', name: 'Child Bot' });
    vi.mocked(getBot).mockResolvedValue(undefined);
    vi.mocked(listBots).mockResolvedValue([childBot]);

    const result = await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'Child Bot',
      task: 'Check prices',
      createMission: async () => 'M1',
      model: 'test-model',
    });

    expect(result.success).toBe(true);
    expect(result.childBot?.id).toBe('bot_2');
    expect(vi.mocked(launchBotRun)).toHaveBeenCalledTimes(1);
  });

  it('returns childReport when a blocking handoff completes', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    const { listBotRunHistory } = await import('../lib/bots/botRuntimeStore');

    const childBot = makeBot({ id: 'bot_2', name: 'Child Bot' });
    vi.mocked(getBot).mockResolvedValue(childBot);
    vi.mocked(listBotRunHistory).mockResolvedValue([
      {
        id: 'run_mission_1',
        botId: 'bot_2',
        missionId: 'mission_1',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        summary: 'Child did the work',
      },
    ]);

    const result = await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'bot_2',
      task: 'Do something',
      createMission: async () => 'M1',
      model: 'test-model',
      blocking: true,
    });

    expect(result.success).toBe(true);
    expect(result.blocking).toBe(true);
    expect(result.childReport).toBe('Child did the work');
  });
});
