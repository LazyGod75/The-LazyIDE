import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractCloudToolTraces,
  recordBotLearning,
  finalizeBotRunLearning,
  indexCloudPlaybooks,
  BOT_LEARNING_KIND,
  BOT_LEARNING_SPACE,
  setBotLearningRoot,
  BOT_PLAYBOOKS_FILE,
} from '../lib/bots/botLearning';
import { emit } from '../lib/bus';

const files = new Map<string, string>();
const capture = vi.fn(async () => ({ ok: true }));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: {
      readFile: vi.fn(async (p: string) => {
        const c = files.get(p);
        if (c === undefined) throw new Error('ENOENT');
        return c;
      }),
      writeFile: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
      createDir: vi.fn().mockResolvedValue(undefined),
    },
    brain: { capture },
  })),
}));

vi.mock('../lib/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bus')>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

vi.mock('../lib/bots/botRuntimeStore', () => ({
  appendBotRunHistory: vi.fn(async () => undefined),
  recordBotLastTime: vi.fn(async () => undefined),
}));

beforeEach(() => {
  files.clear();
  capture.mockClear();
  vi.mocked(emit).mockClear();
  setBotLearningRoot('/repo');
});

describe('botLearning playbooks + LTM (D96/D98)', () => {
  it('extracts cloud_* traces for playbook seeding', () => {
    expect(extractCloudToolTraces([
      'Step 1: cloud_browser_open',
      'ACTION: cloud_browser_navigate',
    ])).toEqual(['cloud_browser_open', 'cloud_browser_navigate']);
  });

  it('indexes cloud_* tools into a playbook file (D96)', async () => {
    await indexCloudPlaybooks('bot_1', ['cloud_browser_open', 'cloud_desktop_screenshot'], {
      task: 'scrape',
      at: '2026-09-02T00:00:00.000Z',
    });
    const path = [...files.keys()].find((p) => p.replace(/\\/g, '/').endsWith(BOT_PLAYBOOKS_FILE));
    expect(path).toBeTruthy();
    const parsed = JSON.parse(files.get(path!)!);
    expect(parsed.byBot.bot_1.tools).toEqual(
      expect.arrayContaining(['cloud_browser_open', 'cloud_desktop_screenshot']),
    );
  });

  it('recordBotLearning emits bus + writes a topical brain neuron when capture exists (D98)', async () => {
    await recordBotLearning({
      space: BOT_LEARNING_SPACE,
      kind: BOT_LEARNING_KIND,
      botId: 'bot_1',
      missionId: 'M1',
      task: 'read example.com',
      report: 'Title: Example Domain',
      at: '2026-09-02T00:00:00.000Z',
      cloudTools: ['cloud_browser_open'],
    });
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'bot:learning',
      expect.objectContaining({ space: 'bot', botId: 'bot_1' }),
    );
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'learning',
        space: 'topical',
        topic: expect.stringMatching(/bot_1|lazybot/i),
        text: expect.stringContaining('Example Domain'),
        tags: expect.arrayContaining(['lazybot', 'bot_1']),
      }),
    );
  });

  it('finalizeBotRunLearning also indexes playbooks from timeline', async () => {
    await finalizeBotRunLearning({
      botId: 'bot_1',
      missionId: 'M1',
      task: 't',
      report: 'r',
      timelineTexts: ['ACTION: cloud_sandbox_exec'],
    });
    const path = [...files.keys()].find((p) => p.replace(/\\/g, '/').endsWith(BOT_PLAYBOOKS_FILE));
    expect(path).toBeTruthy();
    const parsed = JSON.parse(files.get(path!)!);
    expect(parsed.byBot.bot_1.tools).toContain('cloud_sandbox_exec');
  });
});
