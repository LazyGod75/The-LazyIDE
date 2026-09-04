import { describe, it, expect } from 'vitest';
import {
  runMgrBotScrapeWakeupPipeline,
  reduceMgrBotScrapeWakeup,
  MGR_BOT_SCRAPE_WAKEUP_CANONICAL,
} from '../lib/brain/e2e/managerBotScrapeWakeupHarness';
import { classifyWakeupEvent } from '../lib/agents/managerWakeup';

describe('manager → bot → scrape → wakeup (F108 E2E harness)', () => {
  it('delivers a wakeup only after scrape completes and lazybot.completed fires', () => {
    expect(runMgrBotScrapeWakeupPipeline(MGR_BOT_SCRAPE_WAKEUP_CANONICAL)).toBe('wakeup_delivered');
  });

  it('wires the real classifyWakeupEvent(lazybot.completed) contract', () => {
    const candidate = classifyWakeupEvent({
      type: 'lazybot.completed',
      ts_ms: 1,
      mission_id: 'M97',
      payload: JSON.stringify({ botName: 'SolariTest', report: 'Example Domain' }),
    });
    expect(candidate?.kind).toBe('bot_completed');
    expect(candidate?.report).toBe('Example Domain');
  });

  it('does not wake the manager from a launch alone', () => {
    expect(runMgrBotScrapeWakeupPipeline([{ type: 'manager.launch_bot' }])).toBe('bot_launched');
  });

  it('still wakes if scrape.done is skipped but lazybot.completed arrives mid-run', () => {
    const stage = runMgrBotScrapeWakeupPipeline([
      { type: 'manager.launch_bot' },
      { type: 'bot.started' },
      { type: 'lazybot.completed', report: 'done without a scrape event' },
    ]);
    expect(stage).toBe('wakeup_due');
  });

  it('ignores out-of-order wakeup.sent', () => {
    expect(reduceMgrBotScrapeWakeup('idle', { type: 'manager.wakeup.sent' })).toBe('idle');
  });

  it('does not wake from scrape.done without a launch', () => {
    expect(reduceMgrBotScrapeWakeup('idle', { type: 'bot.scrape.done' })).toBe('idle');
  });

  it('does not deliver wakeup after a bot failure', () => {
    expect(runMgrBotScrapeWakeupPipeline([
      { type: 'manager.launch_bot' },
      { type: 'bot.started' },
      { type: 'bot.failed' },
      { type: 'manager.wakeup.sent' },
    ])).toBe('bot_failed');
  });
});
