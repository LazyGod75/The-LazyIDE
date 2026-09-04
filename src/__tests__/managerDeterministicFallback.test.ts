import { describe, expect, it } from 'vitest';
import type { LazyBotSummary } from '../lib/bots/botManagerContext';
import {
  detectDeterministicManagerAction,
  detectLazyBotRunIntent,
} from '../lib/agents/managerLazyBotFallback';

const bots: LazyBotSummary[] = [
  { id: 'bot_1', name: 'SolariTest', description: '', enabled: true, autonomy: 'supervised', capabilities: ['browser'], activeRuns: 0 },
  { id: 'bot_2', name: 'OtherBot', description: '', enabled: true, autonomy: 'yolo', capabilities: ['browser'], activeRuns: 0 },
];

describe('detectDeterministicManagerAction', () => {
  it('still reconstructs a named run_lazybot', () => {
    const intent = detectLazyBotRunIntent('lance SolariTest sur https://example.com', '', bots);
    expect(intent?.bot.id).toBe('bot_1');
    expect(detectDeterministicManagerAction('lance SolariTest sur https://example.com', '', bots)).toEqual({
      type: 'run_lazybot',
      botId: 'bot_1',
      task: 'lance SolariTest sur https://example.com',
    });
  });

  it('reconstructs stop_mission for an explicit M-id', () => {
    expect(detectDeterministicManagerAction('arrête M16', '', bots)).toEqual({
      type: 'stop_mission',
      missionId: 'M16',
    });
  });

  it('reconstructs stop_lazybot when exactly one bot is named', () => {
    expect(detectDeterministicManagerAction('stoppe le bot SolariTest', '', bots)).toEqual({
      type: 'stop_lazybot',
      botId: 'bot_1',
    });
  });

  it('reconstructs create_lazybot when a name is given', () => {
    expect(detectDeterministicManagerAction('crée un bot nommé NightWatch', '', undefined)).toEqual({
      type: 'create_lazybot',
      name: 'NightWatch',
      systemPrompt: '',
    });
  });

  it('reconstructs launch_mission when the task is explicit and no bot is named', () => {
    expect(detectDeterministicManagerAction(
      'lance une mission pour corriger les typos du README',
      '',
      bots,
    )).toEqual({
      type: 'launch_mission',
      task: 'corriger les typos du README',
    });
  });

  it('never guesses between two bots', () => {
    expect(detectDeterministicManagerAction('stoppe le bot', '', bots)).toBeUndefined();
  });

  it('does not invent a launch_mission from a mere "lance une mission"', () => {
    expect(detectDeterministicManagerAction('lance une mission', '', bots)).toBeUndefined();
  });
});
