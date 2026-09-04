import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enqueueRoutineFire,
  drainQueuedRoutineFires,
  resetRoutineQueueForTests,
} from '../lib/bots/botRoutineQueue';
import { WEB_ROUTINES_DISABLED_MESSAGE, startWebRoutineCatcher } from '../lib/bots/botScheduler';
import { SOLARI_PROD_CORS_NOTE } from '../lib/solari/solariClient';
import { BOT_VM_HOST_CANONICAL } from '../lib/solari/botVmState';
import { DESKTOP_PER_BOT_ROADMAP } from '../lib/solari/agentComputer';

vi.mock('../lib/bots/botStorage', () => ({
  listBots: vi.fn().mockResolvedValue([{
    id: 'bot_1', name: 'WebBot', description: '', systemPrompt: 'x', autonomy: 'supervised',
    capabilities: { browser: true, desktop: false, sandbox: false, maxConcurrentSessions: 1 },
    routines: [{
      id: 'rtn_1', name: 'Daily', schedule: '* * * * *',
      task: 'queued task', enabled: true, lastRunAt: null,
    }],
    profileIds: [], enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }]),
  saveBot: vi.fn(),
  getBot: vi.fn(),
}));

beforeEach(() => {
  resetRoutineQueueForTests();
  vi.clearAllMocks();
});

describe('backlog notes (C50/C67/C72/C78)', () => {
  it('documents web routines disability + queue resume', () => {
    expect(WEB_ROUTINES_DISABLED_MESSAGE).toMatch(/Desktop|Tauri/i);
    expect(WEB_ROUTINES_DISABLED_MESSAGE).toMatch(/queue/i);
  });
  it('documents prod CORS Rust proxy', () => {
    expect(SOLARI_PROD_CORS_NOTE).toMatch(/solari_cdp_proxy|Rust/i);
  });
  it('documents canonical VM host with shared stream', () => {
    expect(BOT_VM_HOST_CANONICAL).toMatch(/BotVmSurface/);
    expect(BOT_VM_HOST_CANONICAL).toMatch(/shared stream/i);
  });
  it('documents per-bot desktop via agentComputersByBotId', () => {
    expect(DESKTOP_PER_BOT_ROADMAP).toMatch(/agentComputersByBotId/);
  });
});

describe('web routine queue (C67)', () => {
  it('enqueues and drains without duplicates', () => {
    expect(enqueueRoutineFire({
      botId: 'bot_1', botName: 'WebBot', routineId: 'rtn_1',
      routineName: 'Daily', task: 't', dueAt: new Date().toISOString(),
    })).toBe(true);
    expect(enqueueRoutineFire({
      botId: 'bot_1', botName: 'WebBot', routineId: 'rtn_1',
      routineName: 'Daily', task: 't', dueAt: new Date().toISOString(),
    })).toBe(false);
    const drained = drainQueuedRoutineFires();
    expect(drained).toHaveLength(1);
    expect(drainQueuedRoutineFires()).toHaveLength(0);
  });

  it('web catcher enqueues due routines instead of launching', async () => {
    const handle = startWebRoutineCatcher();
    await handle.tickNow();
    handle.stop();
    const drained = drainQueuedRoutineFires();
    expect(drained.some((r) => r.routineId === 'rtn_1')).toBe(true);
  });
});
