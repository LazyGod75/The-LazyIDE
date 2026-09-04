/* botShareLink.test.ts — unit tests for deep-link encoding/decoding. */

import { describe, it, expect } from 'vitest';
import {
  encodeBotShareLink,
  decodeBotShareLink,
  importFromShareLink,
  isBotShareLink,
} from '../lib/bots/botShareLink';
import { sanitiseBotForShare } from '../lib/bots/botShare';
import type { BotConfig } from '../lib/bots/botTypes';

function makeBot(): BotConfig {
  return {
    id: 'bot_1', name: 'Shared Bot', description: 'A shared bot',
    systemPrompt: 'You are a shared bot.', autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [], profileIds: ['prof_1'], enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('encodeBotShareLink', () => {
  it('produces a link with the lazy://bot/ prefix', () => {
    const shared = sanitiseBotForShare(makeBot());
    const link = encodeBotShareLink(shared);
    expect(link.startsWith('lazy://bot/')).toBe(true);
  });

  it('produces a URL-safe base64 payload (no +, /, or =)', () => {
    const shared = sanitiseBotForShare(makeBot());
    const link = encodeBotShareLink(shared);
    const payload = link.slice('lazy://bot/'.length);
    expect(payload).not.toMatch(/[+/=]/);
  });
});

describe('decodeBotShareLink', () => {
  it('round-trips a shared bot', () => {
    const shared = sanitiseBotForShare(makeBot());
    const link = encodeBotShareLink(shared);
    const result = decodeBotShareLink(link);
    expect('bot' in result).toBe(true);
    if ('bot' in result) {
      expect(result.bot.name).toBe('Shared Bot');
      expect(result.bot.systemPrompt).toBe('You are a shared bot.');
    }
  });

  it('returns an error for a non-lazy link', () => {
    const result = decodeBotShareLink('https://example.com/bot');
    if ('error' in result) {
      expect(result.error).toMatch(/must start with/);
    } else {
      throw new Error('expected an error result');
    }
  });

  it('returns an error for corrupted base64', () => {
    const result = decodeBotShareLink('lazy://bot/!!!invalid!!!');
    expect('error' in result).toBe(true);
  });
});

describe('importFromShareLink', () => {
  it('imports a shared bot with a fresh id', () => {
    const shared = sanitiseBotForShare(makeBot());
    const link = encodeBotShareLink(shared);
    const result = importFromShareLink(link);
    expect('bot' in result).toBe(true);
    if ('bot' in result) {
      expect(result.bot.id).not.toBe('bot_1');
      expect(result.bot.name).toBe('Shared Bot');
      expect(result.bot.profileIds).toEqual([]);
    }
  });

  it('returns an error for an invalid link', () => {
    const result = importFromShareLink('not a link');
    expect('error' in result).toBe(true);
  });
});

describe('isBotShareLink', () => {
  it('returns true for a valid link prefix', () => {
    expect(isBotShareLink('lazy://bot/abc123')).toBe(true);
  });

  it('returns false for a non-matching string', () => {
    expect(isBotShareLink('https://example.com')).toBe(false);
  });
});
