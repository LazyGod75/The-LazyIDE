/* botTypes.test.ts — type compilation and shape tests for bot types. */

import { describe, it, expect } from 'vitest';
import type { BotConfig, BotCapabilities, BotRoutine, BotRun, BotRuntimeState } from '../lib/bots/botTypes';
import { DEFAULT_CAPABILITIES } from '../lib/bots/botTypes';

describe('BotConfig', () => {
  it('can be constructed with all required fields', () => {
    const bot: BotConfig = {
      id: 'bot_1',
      name: 'My Bot',
      description: 'A bot',
      systemPrompt: 'You are a bot.',
      autonomy: 'supervised',
      capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
      routines: [],
      profileIds: [],
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(bot.id).toBe('bot_1');
    expect(bot.autonomy).toBe('supervised');
  });
});

describe('BotCapabilities', () => {
  it('DEFAULT_CAPABILITIES has browser=true and others false', () => {
    const caps: BotCapabilities = DEFAULT_CAPABILITIES;
    expect(caps.browser).toBe(true);
    expect(caps.desktop).toBe(false);
    expect(caps.sandbox).toBe(false);
    expect(caps.maxConcurrentSessions).toBe(1);
  });
});

describe('BotRoutine', () => {
  it('can be constructed with a cron schedule', () => {
    const routine: BotRoutine = {
      id: 'rtn_1',
      name: 'Daily check',
      schedule: '0 9 * * *',
      task: 'Check the dashboard',
      enabled: true,
      lastRunAt: null,
    };
    expect(routine.schedule).toBe('0 9 * * *');
    expect(routine.lastRunAt).toBeNull();
  });
});

describe('BotRun', () => {
  it('tracks status and timing', () => {
    const run: BotRun = {
      id: 'run_1',
      botId: 'bot_1',
      missionId: 'mission_1',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(run.status).toBe('running');
    expect(run.completedAt).toBeUndefined();
  });
});

describe('BotRuntimeState', () => {
  it('tracks active runs for a bot', () => {
    const state: BotRuntimeState = {
      botId: 'bot_1',
      activeRuns: ['mission_1'],
    };
    expect(state.activeRuns).toHaveLength(1);
  });
});
