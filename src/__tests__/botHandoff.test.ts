/* botHandoff.test.ts — unit tests for bot-to-bot handoffs.
   Mocks botStorage and botEngine. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildHandoffPrompt, handoffToBot } from '../lib/bots/botHandoff';
import type { BotConfig } from '../lib/bots/botTypes';

vi.mock('../lib/bots/botStorage', () => ({
  listBots: vi.fn().mockResolvedValue([]),
  saveBot: vi.fn().mockResolvedValue(undefined),
  getBot: vi.fn(),
}));

vi.mock('../lib/bots/botEngine', () => ({
  launchBotRun: vi.fn().mockResolvedValue({
    id: 'run_1', botId: 'bot_2', missionId: 'mission_1',
    status: 'running', startedAt: '2026-01-01T00:00:00.000Z',
  }),
  getBotRuntimeState: vi.fn(() => ({ activeRuns: [], lastError: undefined })),
  resetBotEngineState: vi.fn(),
}));

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot_1', name: 'Parent Bot', description: 'test',
    systemPrompt: 'You are a parent bot.', autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [], profileIds: [], enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildHandoffPrompt', () => {
  it('includes the delegated task', () => {
    const prompt = buildHandoffPrompt('Check Amazon prices');
    expect(prompt).toContain('Check Amazon prices');
    expect(prompt).toContain('DELEGATED TASK');
  });

  it('includes context when provided', () => {
    const prompt = buildHandoffPrompt('Check prices', 'I was browsing Amazon for laptops');
    expect(prompt).toContain('HANDOFF CONTEXT');
    expect(prompt).toContain('I was browsing Amazon for laptops');
  });

  it('does not include context section when context is absent', () => {
    const prompt = buildHandoffPrompt('Check prices');
    expect(prompt).not.toContain('HANDOFF CONTEXT');
  });
});

describe('handoffToBot', () => {
  it('returns success when the target bot is found and enabled', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    const targetBot = makeBot({ id: 'bot_2', name: 'Child Bot' });
    vi.mocked(getBot).mockResolvedValue(targetBot);

    const result = await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'bot_2',
      task: 'Check prices',
      createMission: async () => 'M1',
      model: 'test-model',
    });

    expect(result.success).toBe(true);
    expect(result.childBot?.id).toBe('bot_2');
  });

  it('returns an error when the target bot is not found', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    vi.mocked(getBot).mockResolvedValue(undefined);

    const result = await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'nonexistent',
      task: 'Check prices',
      createMission: async () => 'M1',
      model: 'test-model',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns an error when the target bot is paused', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    const targetBot = makeBot({ id: 'bot_2', name: 'Child Bot', enabled: false });
    vi.mocked(getBot).mockResolvedValue(targetBot);

    const result = await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'bot_2',
      task: 'Check prices',
      createMission: async () => 'M1',
      model: 'test-model',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('paused');
  });

  it('launches a run with the handoff prompt as the task', async () => {
    const { getBot } = await import('../lib/bots/botStorage');
    const { launchBotRun } = await import('../lib/bots/botEngine');
    const targetBot = makeBot({ id: 'bot_2', name: 'Child Bot' });
    vi.mocked(getBot).mockResolvedValue(targetBot);

    await handoffToBot({
      fromBot: makeBot(),
      toBotIdOrName: 'bot_2',
      task: 'Check prices',
      context: 'Parent context here',
      createMission: async () => 'M1',
      model: 'test-model',
    });

    expect(launchBotRun).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(launchBotRun).mock.calls[0];
    const taskArg = callArgs[1];
    expect(taskArg).toContain('Check prices');
    expect(taskArg).toContain('Parent context here');
  });
});
