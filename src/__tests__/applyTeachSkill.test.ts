import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyTeachSkillToPersona, TEACH_SKILL_MARKER } from '../lib/bots/applyTeachSkill';
import type { BotConfig } from '../lib/bots/botTypes';

const bots = new Map<string, BotConfig>();

vi.mock('../lib/bots/botStorage', () => ({
  getBot: vi.fn(async (id: string) => bots.get(id)),
  saveBot: vi.fn(async (bot: BotConfig) => { bots.set(bot.id, bot); }),
}));

beforeEach(() => {
  bots.clear();
  bots.set('bot_1', {
    id: 'bot_1',
    name: 'T',
    description: '',
    systemPrompt: 'You are T.',
    autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [],
    profileIds: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
});

describe('applyTeachSkillToPersona (C81)', () => {
  it('appends the teach overlay into systemPrompt and replaces a prior teach block', async () => {
    const first = await applyTeachSkillToPersona('bot_1', '1. Click Buy');
    expect(first!.systemPrompt).toContain(TEACH_SKILL_MARKER);
    expect(first!.systemPrompt).toContain('1. Click Buy');
    const second = await applyTeachSkillToPersona('bot_1', '1. Click Cart');
    expect(second!.systemPrompt.match(new RegExp(TEACH_SKILL_MARKER, 'g'))).toHaveLength(1);
    expect(second!.systemPrompt).toContain('1. Click Cart');
    expect(second!.systemPrompt).not.toContain('1. Click Buy');
  });
});
