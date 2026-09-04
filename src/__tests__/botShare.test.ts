/* botShare.test.ts — unit tests for bot sharing sanitisation and import. */

import { describe, it, expect } from 'vitest';
import { sanitiseBotForShare, importShareableBot, validateShareableBot, SHARE_VERSION } from '../lib/bots/botShare';
import type { BotConfig } from '../lib/bots/botTypes';

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot_1', name: 'My Bot', description: 'A bot',
    systemPrompt: 'You are a bot.', autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [{
      id: 'rtn_1', name: 'Daily', schedule: '0 9 * * *',
      task: 'Check prices', enabled: true, lastRunAt: '2026-01-01T09:00:00Z',
    }],
    profileIds: ['prof_1', 'prof_2'], enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sanitiseBotForShare', () => {
  it('strips profileIds (private data)', () => {
    const shared = sanitiseBotForShare(makeBot());
    expect((shared as unknown as Record<string, unknown>).profileIds).toBeUndefined();
  });

  it('strips lastRunAt from routines', () => {
    const shared = sanitiseBotForShare(makeBot());
    expect((shared.routines[0] as unknown as Record<string, unknown>).lastRunAt).toBeUndefined();
  });

  it('keeps the routine schedule and task (part of the bot value)', () => {
    const shared = sanitiseBotForShare(makeBot());
    expect(shared.routines[0].schedule).toBe('0 9 * * *');
    expect(shared.routines[0].task).toBe('Check prices');
  });

  it('keeps the system prompt, autonomy, and capabilities', () => {
    const shared = sanitiseBotForShare(makeBot());
    expect(shared.systemPrompt).toBe('You are a bot.');
    expect(shared.autonomy).toBe('supervised');
    expect(shared.capabilities.browser).toBe(true);
  });

  it('includes the share version', () => {
    const shared = sanitiseBotForShare(makeBot());
    expect(shared.shareVersion).toBe(SHARE_VERSION);
  });
});

describe('importShareableBot', () => {
  it('creates a new bot with a fresh id', () => {
    const shared = sanitiseBotForShare(makeBot());
    const imported = importShareableBot(shared, () => 'bot_fresh');
    expect(imported.id).toBe('bot_fresh');
  });

  it('starts with empty profileIds', () => {
    const shared = sanitiseBotForShare(makeBot());
    const imported = importShareableBot(shared);
    expect(imported.profileIds).toEqual([]);
  });

  it('resets routine lastRunAt to null', () => {
    const shared = sanitiseBotForShare(makeBot());
    const imported = importShareableBot(shared);
    expect(imported.routines[0].lastRunAt).toBeNull();
  });

  it('preserves the system prompt and capabilities', () => {
    const shared = sanitiseBotForShare(makeBot());
    const imported = importShareableBot(shared);
    expect(imported.systemPrompt).toBe('You are a bot.');
    expect(imported.capabilities.browser).toBe(true);
  });
});

describe('validateShareableBot', () => {
  it('returns null for a valid shareable bot', () => {
    const shared = sanitiseBotForShare(makeBot());
    expect(validateShareableBot(shared)).toBeNull();
  });

  it('returns an error for a non-object', () => {
    expect(validateShareableBot('not an object')).toMatch(/not an object/);
  });

  it('returns an error for an invalid autonomy', () => {
    const shared = sanitiseBotForShare(makeBot());
    (shared as unknown as Record<string, unknown>).autonomy = 'invalid';
    expect(validateShareableBot(shared)).toMatch(/autonomy/);
  });
});
