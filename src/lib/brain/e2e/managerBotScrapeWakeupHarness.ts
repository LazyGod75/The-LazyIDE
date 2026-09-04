/* Manager → bot → scrape → wakeup protocol (F108).

   Integrates the real classifyWakeupEvent(`lazybot.completed`) contract from
   managerWakeup.ts so the harness tracks production significance rules —
   still without spinning botEngine / Solari.
*/

import { classifyWakeupEvent } from '../../agents/managerWakeup.js';

export type MgrBotScrapeWakeupStage =
  | 'idle'
  | 'bot_launched'
  | 'bot_scraping'
  | 'scrape_complete'
  | 'wakeup_due'
  | 'wakeup_delivered'
  | 'bot_failed';

export type MgrBotScrapeWakeupEvent =
  | { type: 'manager.launch_bot' }
  | { type: 'bot.started' }
  | { type: 'bot.scrape.done'; title?: string }
  | { type: 'bot.failed' }
  | { type: 'lazybot.completed'; report?: string; botName?: string }
  | { type: 'manager.wakeup.sent' };

export function reduceMgrBotScrapeWakeup(
  stage: MgrBotScrapeWakeupStage,
  event: MgrBotScrapeWakeupEvent,
): MgrBotScrapeWakeupStage {
  switch (event.type) {
    case 'manager.launch_bot':
      return stage === 'idle' ? 'bot_launched' : stage;
    case 'bot.started':
      return stage === 'bot_launched' ? 'bot_scraping' : stage;
    case 'bot.scrape.done':
      return stage === 'bot_scraping' ? 'scrape_complete' : stage;
    case 'bot.failed':
      return stage === 'bot_launched' || stage === 'bot_scraping' || stage === 'scrape_complete'
        ? 'bot_failed'
        : stage;
    case 'lazybot.completed': {
      // F108 — only advance when the real classifier agrees this row is a
      // significant wakeup (bot_completed), matching production.
      if (stage !== 'scrape_complete' && stage !== 'bot_scraping') return stage;
      const candidate = classifyWakeupEvent({
        type: 'lazybot.completed',
        ts_ms: Date.now(),
        mission_id: null,
        payload: JSON.stringify({
          botName: event.botName ?? 'eval-bot',
          report: event.report ?? 'done',
        }),
      });
      return candidate?.kind === 'bot_completed' ? 'wakeup_due' : stage;
    }
    case 'manager.wakeup.sent':
      return stage === 'wakeup_due' ? 'wakeup_delivered' : stage;
    default:
      return stage;
  }
}

export function runMgrBotScrapeWakeupPipeline(
  events: MgrBotScrapeWakeupEvent[],
): MgrBotScrapeWakeupStage {
  return events.reduce<MgrBotScrapeWakeupStage>(
    (stage, event) => reduceMgrBotScrapeWakeup(stage, event),
    'idle',
  );
}

/** Canonical E2E sequence locked by managerBotScrapeWakeup.e2e.test.ts. */
export const MGR_BOT_SCRAPE_WAKEUP_CANONICAL: MgrBotScrapeWakeupEvent[] = [
  { type: 'manager.launch_bot' },
  { type: 'bot.started' },
  { type: 'bot.scrape.done', title: 'Example Domain' },
  { type: 'lazybot.completed', report: 'Example Domain', botName: 'SolariTest' },
  { type: 'manager.wakeup.sent' },
];
