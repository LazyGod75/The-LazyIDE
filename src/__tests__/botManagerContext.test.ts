/* botManagerContext.test.ts — how the manager refers to saved LazyBots:
   the per-turn context block and the tolerant reference resolver every
   *_lazybot executor case goes through. */

import { describe, it, expect } from 'vitest';
import type { BotConfig } from '../lib/bots/botTypes';
import {
  formatLazyBotsContext,
  resolveLazyBotRef,
  summarizeLazyBot,
} from '../lib/bots/botManagerContext';

function bot(id: string, name: string, overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id,
    name,
    description: '',
    systemPrompt: 'persona',
    autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [],
    profileIds: [],
    enabled: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const BOTS = [
  bot('bot_mtk67iicu2vv8b', 'Scraper Web', { description: 'Scrape des pages produit' }),
  bot('bot_mtkasfi67smxk8', 'TestSolari'),
  bot('bot_mtkceoffe9ia46', 'SolariTest'),
];

describe('resolveLazyBotRef', () => {
  it('matches the exact id, the id in any case, and the name in any case', () => {
    expect(resolveLazyBotRef(BOTS, 'bot_mtkceoffe9ia46')?.name).toBe('SolariTest');
    expect(resolveLazyBotRef(BOTS, 'BOT_MTKCEOFFE9IA46')?.name).toBe('SolariTest');
    expect(resolveLazyBotRef(BOTS, 'solaritest')?.id).toBe('bot_mtkceoffe9ia46');
    expect(resolveLazyBotRef(BOTS, 'Scraper Web')?.id).toBe('bot_mtk67iicu2vv8b');
  });

  it('matches the name with separators/accents stripped', () => {
    expect(resolveLazyBotRef(BOTS, 'solari-test')?.id).toBe('bot_mtkceoffe9ia46');
    expect(resolveLazyBotRef(BOTS, 'scraper_web')?.id).toBe('bot_mtk67iicu2vv8b');
    expect(resolveLazyBotRef(BOTS, 'Scràper Wéb')?.id).toBe('bot_mtk67iicu2vv8b');
  });

  // Live repro (DeepSeek as manager, 2026-09-02): the model knew ids look
  // like "bot_…" and slugged the NAME behind the prefix instead of copying
  // the real id from the context block.
  it('matches the name slugged behind a bot_/lazybot_ prefix', () => {
    expect(resolveLazyBotRef(BOTS, 'bot_solaritest')?.id).toBe('bot_mtkceoffe9ia46');
    expect(resolveLazyBotRef(BOTS, 'bot-solari-test')?.id).toBe('bot_mtkceoffe9ia46');
    expect(resolveLazyBotRef(BOTS, 'lazybot_scraper_web')?.id).toBe('bot_mtk67iicu2vv8b');
    expect(resolveLazyBotRef(BOTS, 'bot_testsolari')?.id).toBe('bot_mtkasfi67smxk8');
  });

  it('accepts a UNIQUE prefix of the id or the name, never an ambiguous one', () => {
    expect(resolveLazyBotRef(BOTS, 'bot_mtkce')?.name).toBe('SolariTest');
    expect(resolveLazyBotRef(BOTS, 'scrap')?.name).toBe('Scraper Web');
    // "bot_mtk" prefixes all three ids.
    expect(resolveLazyBotRef(BOTS, 'bot_mtk')).toBeUndefined();
  });

  it('returns undefined for unknown, empty or non-string references', () => {
    expect(resolveLazyBotRef(BOTS, 'bot_nope')).toBeUndefined();
    expect(resolveLazyBotRef(BOTS, 'Crawler')).toBeUndefined();
    expect(resolveLazyBotRef(BOTS, '')).toBeUndefined();
    expect(resolveLazyBotRef(BOTS, '   ')).toBeUndefined();
    expect(resolveLazyBotRef(BOTS, undefined)).toBeUndefined();
    expect(resolveLazyBotRef([], 'bot_solaritest')).toBeUndefined();
  });
});

describe('formatLazyBotsContext', () => {
  it('renders one id-first line per bot with capabilities, autonomy, state and runs', () => {
    const text = formatLazyBotsContext([
      summarizeLazyBot(BOTS[0]!, 1),
      summarizeLazyBot(bot('bot_x', 'Off', { enabled: false, capabilities: { browser: false, desktop: false, sandbox: false, maxConcurrentSessions: 1 } }), 0),
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('botId: "bot_mtk67iicu2vv8b" · name: "Scraper Web" · browser · autonomy: supervised · enabled · active runs: 1');
    expect(lines[0]).toContain('Scrape des pages produit');
    expect(lines[1]).toContain('no cloud capability');
    expect(lines[1]).toContain('DISABLED');
  });

  it('tells the model explicitly when no bot exists yet', () => {
    expect(formatLazyBotsContext([])).toMatch(/no LazyBots saved yet/);
  });
});
