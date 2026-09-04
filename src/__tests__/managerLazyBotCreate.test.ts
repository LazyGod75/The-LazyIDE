import { describe, expect, it } from 'vitest';
import {
  buildBotConfigFromCreateLazybot,
  normalizeProfileIds,
  normalizeRoutines,
  sanitizeLazyBotPatch,
} from '../lib/agents/managerLazyBotCreate';
import { validateManagerAction } from '../lib/agents/managerActionValidator';

describe('normalizeProfileIds', () => {
  it('keeps non-empty string ids', () => {
    expect(normalizeProfileIds(['prof_a', '  prof_b  ', '', 3, null])).toEqual(['prof_a', 'prof_b']);
  });

  it('returns undefined when omitted (so create does not invent [])', () => {
    expect(normalizeProfileIds(undefined)).toBeUndefined();
  });
});

describe('normalizeRoutines', () => {
  it('keeps valid cron routines and drops junk', () => {
    const routines = normalizeRoutines([
      { name: 'morning', schedule: '0 9 * * 1-5', task: 'scrape', enabled: true },
      { name: 'bad' },
      'nope',
    ]);
    expect(routines).toHaveLength(1);
    expect(routines?.[0]).toMatchObject({
      name: 'morning',
      schedule: '0 9 * * 1-5',
      task: 'scrape',
      enabled: true,
      lastRunAt: null,
    });
    expect(routines?.[0].id).toMatch(/^rtn_/);
  });
});

describe('buildBotConfigFromCreateLazybot', () => {
  it('passes profileIds, routines, avatar, budgetCapUsd through (no forced empty profileIds)', () => {
    const bot = buildBotConfigFromCreateLazybot({
      name: 'NightWatch',
      systemPrompt: 'You watch the night.',
      profileIds: ['prof_1', 'prof_2'],
      routines: [{ name: 'tick', schedule: '0 * * * *', task: 'ping', enabled: true }],
      avatar: '🦉',
      budgetCapUsd: 4.5,
    });
    expect(bot.profileIds).toEqual(['prof_1', 'prof_2']);
    expect(bot.routines).toHaveLength(1);
    expect(bot.avatar).toBe('🦉');
    expect(bot.budgetCapUsd).toBe(4.5);
    expect(bot.autonomy).toBe('supervised');
    expect(bot.capabilities.browser).toBe(true);
  });

  it('defaults omitted rich fields to empty arrays / absent optionals', () => {
    const bot = buildBotConfigFromCreateLazybot({
      name: 'Bare',
      systemPrompt: 'hi',
    });
    expect(bot.profileIds).toEqual([]);
    expect(bot.routines).toEqual([]);
    expect(bot.avatar).toBeUndefined();
    expect(bot.budgetCapUsd).toBeUndefined();
  });
});

describe('sanitizeLazyBotPatch', () => {
  it('accepts profileIds / budget / routines / avatar without inventing empty profileIds', () => {
    const patch = sanitizeLazyBotPatch({
      description: 'updated',
      profileIds: ['prof_x'],
      budgetCapUsd: 12,
      avatar: '✨',
      routines: [{ name: 'daily', schedule: '0 8 * * *', task: 'go', enabled: false }],
    });
    expect(patch).toEqual({
      description: 'updated',
      profileIds: ['prof_x'],
      budgetCapUsd: 12,
      avatar: '✨',
      routines: [
        expect.objectContaining({
          name: 'daily',
          schedule: '0 8 * * *',
          task: 'go',
          enabled: false,
        }),
      ],
    });
    expect(patch).not.toHaveProperty('name');
  });

  it('omits profileIds from the patch when the field was absent', () => {
    const patch = sanitizeLazyBotPatch({ autonomy: 'yolo' });
    expect(patch).toEqual({ autonomy: 'yolo' });
    expect(patch).not.toHaveProperty('profileIds');
  });
});

describe('validateManagerAction — create_lazybot rich fields', () => {
  it('accepts create_lazybot with profileIds, routines, avatar, budgetCapUsd', () => {
    const result = validateManagerAction({
      type: 'create_lazybot',
      name: 'Scraper',
      systemPrompt: 'Browse and extract.',
      profileIds: ['prof_1'],
      routines: [{ name: 'hourly', schedule: '0 * * * *', task: 'scrape', enabled: true }],
      avatar: '🕷️',
      budgetCapUsd: 3,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects create_lazybot with non-array profileIds', () => {
    const result = validateManagerAction({
      type: 'create_lazybot',
      name: 'Scraper',
      systemPrompt: 'x',
      profileIds: 'prof_1',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects create_lazybot with non-number budgetCapUsd', () => {
    const result = validateManagerAction({
      type: 'create_lazybot',
      name: 'Scraper',
      systemPrompt: 'x',
      budgetCapUsd: '5',
    });
    expect(result.ok).toBe(false);
  });

  it('accepts update_lazybot patch that carries rich fields', () => {
    const result = validateManagerAction({
      type: 'update_lazybot',
      botId: 'bot_abc',
      patch: { profileIds: ['prof_1'], budgetCapUsd: 8, avatar: 'x' },
    });
    expect(result.ok).toBe(true);
  });
});
