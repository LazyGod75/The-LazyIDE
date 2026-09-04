import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistActiveRuns, loadPersistedRuns, recordBotLastTime, loadBotLastTime, setBotRuntimeRoot, formatBotLastTime } from '../lib/bots/botRuntimeStore';
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

function run(overrides: Partial<BotRun> = {}): BotRun {
  return {
    id: 'run_M1', botId: 'bot_1', missionId: 'M1', status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

describe('botRuntimeStore', () => {
  it('persists running runs and reloads them after a crash (completed runs dropped)', async () => {
    await persistActiveRuns([run(), run({ id: 'run_M2', missionId: 'M2', status: 'completed' })]);
    expect(await loadPersistedRuns()).toEqual([run()]);
  });

  it('records last-time so a later run can cite it', async () => {
    const last = { task: 'read example.com', report: 'Title: Example Domain', at: '2026-09-02T00:00:00.000Z' };
    await recordBotLastTime('bot_1', last);
    expect(await loadBotLastTime('bot_1')).toEqual(last);
    expect(formatBotLastTime(last)).toContain('read example.com');
  });
});
