/* botVmWindows.test.ts — the ephemeral open/close state of the bot's canvas
   VM window node. Module-scope singleton state, so every test resets first. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  toggleBotVmWindow,
  openBotVmWindow,
  isBotVmWindowOpen,
  resetBotVmWindows,
  subscribeBotVmWindows,
  _openBotVmWindowsForTests,
} from '../lib/solari/botVmWindows';

beforeEach(() => {
  resetBotVmWindows();
});

describe('openBotVmWindow', () => {
  it('opens the window and emits a changed event', () => {
    const events: Array<{ botId: string; open: boolean }> = [];
    const off = subscribeBotVmWindows((e) => events.push(e));
    try {
      const opened = openBotVmWindow('bot_a');
      expect(opened).toBe(true);
      expect(isBotVmWindowOpen('bot_a')).toBe(true);
      expect(events).toEqual([{ botId: 'bot_a', open: true }]);
    } finally {
      off();
    }
  });

  it('is idempotent — a second call is a no-op and emits nothing', () => {
    const events: Array<{ botId: string; open: boolean }> = [];
    const off = subscribeBotVmWindows((e) => events.push(e));
    try {
      openBotVmWindow('bot_a');
      events.length = 0;
      const opened = openBotVmWindow('bot_a');
      expect(opened).toBe(false);
      expect(isBotVmWindowOpen('bot_a')).toBe(true);
      expect(events).toEqual([]);
    } finally {
      off();
    }
  });

  it('never closes an already-open window (unlike toggle)', () => {
    openBotVmWindow('bot_a');
    openBotVmWindow('bot_a');
    expect(isBotVmWindowOpen('bot_a')).toBe(true);
    // toggle still closes it — openBotVmWindow is a strict superset of "open".
    toggleBotVmWindow('bot_a');
    expect(isBotVmWindowOpen('bot_a')).toBe(false);
  });

  it('independent bots do not interfere', () => {
    openBotVmWindow('bot_a');
    openBotVmWindow('bot_b');
    expect(isBotVmWindowOpen('bot_a')).toBe(true);
    expect(isBotVmWindowOpen('bot_b')).toBe(true);
    expect(_openBotVmWindowsForTests().size).toBe(2);
  });
});
