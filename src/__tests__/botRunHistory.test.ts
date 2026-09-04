import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  appendBotRunHistory,
  listBotRunHistory,
  setBotRuntimeRoot,
  MAX_BOT_RUN_HISTORY,
} from '../lib/bots/botRuntimeStore';
import type { BotRun } from '../lib/bots/botTypes';

const files = new Map<string, string>();
const readFile = vi.fn(async (path: string) => {
  const content = files.get(path);
  if (content === undefined) throw new Error('ENOENT');
  return content;
});
const writeFile = vi.fn(async (path: string, content: string) => { files.set(path, content); });
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({ fs: { readFile, writeFile, createDir } })),
}));

beforeEach(() => {
  files.clear();
  readFile.mockClear();
  writeFile.mockClear();
  setBotRuntimeRoot('/repo');
});

function doneRun(overrides: Partial<BotRun> = {}): BotRun {
  return {
    id: 'run_M1',
    botId: 'bot_1',
    missionId: 'M1',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    summary: 'Title: Example Domain',
    ...overrides,
  };
}

describe('bot run history (C53)', () => {
  it('persists a completed run with summary and reloads it', async () => {
    await appendBotRunHistory(doneRun());
    expect(await listBotRunHistory('bot_1')).toEqual([doneRun()]);
  });

  it('keeps at most MAX_BOT_RUN_HISTORY newest runs per bot', async () => {
    for (let i = 0; i < MAX_BOT_RUN_HISTORY + 5; i++) {
      await appendBotRunHistory(doneRun({
        id: `run_M${i}`,
        missionId: `M${i}`,
        summary: `report ${i}`,
        startedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      }));
    }
    const hist = await listBotRunHistory('bot_1');
    expect(hist).toHaveLength(MAX_BOT_RUN_HISTORY);
    expect(hist[0]!.missionId).toBe(`M${MAX_BOT_RUN_HISTORY + 4}`);
  });
});
