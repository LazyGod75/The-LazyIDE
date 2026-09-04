import { describe, it, expect } from 'vitest';
import {
  summarizeLazyBot,
  formatLazyBotLines,
  formatBotLastTimeDigest,
} from '../lib/bots/botManagerContext';
import type { BotConfig } from '../lib/bots/botTypes';
import type { BotLastTime } from '../lib/bots/botRuntimeStore';

function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot_1',
    name: 'SolariTest',
    description: 'reads pages',
    systemPrompt: 'You are SolariTest',
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

describe('bot manager digest last-time (D97)', () => {
  it('formatBotLastTimeDigest exports "last time this bot found X"', () => {
    const last: BotLastTime = {
      task: 'read example.com',
      report: 'Title: Example Domain',
      at: '2026-09-02T00:00:00.000Z',
    };
    expect(formatBotLastTimeDigest('SolariTest', last)).toContain('SolariTest');
    expect(formatBotLastTimeDigest('SolariTest', last)).toContain('Title: Example Domain');
    expect(formatBotLastTimeDigest('SolariTest', last)).toContain('read example.com');
  });

  it('summarizeLazyBot still works without lastTime', () => {
    expect(summarizeLazyBot(bot(), 0).name).toBe('SolariTest');
    expect(formatLazyBotLines([summarizeLazyBot(bot(), 1)])[0]).toContain('bot_1');
  });
});
