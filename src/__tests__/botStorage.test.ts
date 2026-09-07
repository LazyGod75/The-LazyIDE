/* botStorage.test.ts — unit tests for the local LazyBot config store.
   Mocks the platform file IO with an in-memory map. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listBots, getBot, saveBot, deleteBot, setBotEnabled, setBotsRoot } from '../lib/bots/botStorage';
import { invalidateProjectRootCache, setCachedProjectRoot } from '../lib/agents/projectRootCache';
import type { BotConfig } from '../lib/bots/botTypes';
import { on } from '../lib/bus';

const memFs = new Map<string, string>();
const readFile = vi.fn(async (path: string) => {
  const content = memFs.get(path);
  if (content === undefined) throw new Error(`not found: ${path}`);
  return content;
});
const writeFile = vi.fn(async (path: string, content: string) => {
  memFs.set(path, content);
});
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({ fs: { readFile, writeFile, createDir } })),
}));

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: 'bot_1',
    name: 'Test Bot',
    description: 'A test bot',
    systemPrompt: 'You are a test bot.',
    autonomy: 'supervised',
    capabilities: { browser: true, desktop: true, sandbox: true, maxConcurrentSessions: 1 },
    routines: [],
    profileIds: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  memFs.clear();
  readFile.mockClear();
  writeFile.mockClear();
  createDir.mockClear();
  setBotsRoot('/repo');
});

describe('listBots', () => {
  it('returns [] when the store is missing', async () => {
    const bots = await listBots();
    expect(bots).toEqual([]);
  });

  it('returns saved bots', async () => {
    await saveBot(makeBot());
    await saveBot(makeBot({ id: 'bot_2', name: 'Second Bot' }));
    const bots = await listBots();
    expect(bots).toHaveLength(2);
  });
});

describe('getBot', () => {
  it('returns the bot when it exists', async () => {
    const bot = makeBot();
    await saveBot(bot);
    const found = await getBot('bot_1');
    expect(found?.id).toBe('bot_1');
  });

  it('returns undefined when the bot does not exist', async () => {
    const found = await getBot('nonexistent');
    expect(found).toBeUndefined();
  });
});

describe('saveBot', () => {
  it('updates an existing bot by id', async () => {
    await saveBot(makeBot());
    await saveBot(makeBot({ name: 'Updated Name' }));
    const found = await getBot('bot_1');
    expect(found?.name).toBe('Updated Name');
  });

  it('emits lazybots:changed so the canvas can refresh without a reload', async () => {
    const seen: string[] = [];
    const off = on('lazybots:changed', (p) => {
      if (p.botId) seen.push(p.botId);
    });
    await saveBot(makeBot());
    off();
    expect(seen).toContain('bot_1');
  });
});

describe('saveBot — active root switched mid-operation', () => {
  // Regression: saveBot() re-reads the active root at write time. If the
  // active project changes during the async read-modify-write, the content
  // of project A can be written into project B's bot file. The root must be
  // captured at the START of the operation and reused for both read and write.
  it('writes to the root captured at read time, not the root active at write time', async () => {
    setBotsRoot('/repoA');
    memFs.set('/repoA/.lazy/bots.json', JSON.stringify({ version: '1.0.0', bots: [makeBot({ id: 'bot_a' })] }));

    // Stall readFile so we can switch the active root while saveBot is in
    // flight (after the read resolved /repoA but before writeStore runs).
    let resolveRead!: () => void;
    const readGate = new Promise<void>((r) => {
      resolveRead = r;
    });
    readFile.mockImplementationOnce(async (path: string) => {
      const content = memFs.get(path);
      if (content === undefined) throw new Error(`not found: ${path}`);
      // Hold the read result until the test flips the root.
      await readGate;
      return content;
    });

    const pending = saveBot(makeBot({ id: 'bot_new', name: 'New Bot' }));
    // Let the op start and block on the gated read.
    await Promise.resolve();
    await Promise.resolve();
    // Switch the active root to project B mid-operation.
    setBotsRoot('/repoB');
    memFs.set('/repoB/.lazy/bots.json', JSON.stringify({ version: '1.0.0', bots: [makeBot({ id: 'bot_b' })] }));
    resolveRead();
    await pending;

    // The new bot must land in /repoA (the root captured at read time), and
    // /repoB must be untouched.
    const aRaw = memFs.get('/repoA/.lazy/bots.json');
    const bRaw = memFs.get('/repoB/.lazy/bots.json');
    expect(aRaw).toBeDefined();
    expect(bRaw).toBeDefined();
    const aBots = JSON.parse(aRaw!).bots as BotConfig[];
    const bBots = JSON.parse(bRaw!).bots as BotConfig[];
    expect(aBots.map((b) => b.id).sort()).toEqual(['bot_a', 'bot_new']);
    expect(bBots.map((b) => b.id)).toEqual(['bot_b']);
  });
});

describe('deleteBot', () => {
  it('removes the bot', async () => {
    await saveBot(makeBot());
    await deleteBot('bot_1');
    const found = await getBot('bot_1');
    expect(found).toBeUndefined();
  });

  it('is idempotent when the bot does not exist', async () => {
    await deleteBot('nonexistent');
    const bots = await listBots();
    expect(bots).toEqual([]);
  });
});

describe('setBotEnabled', () => {
  it('updates the enabled flag', async () => {
    await saveBot(makeBot({ enabled: true }));
    await setBotEnabled('bot_1', false);
    const found = await getBot('bot_1');
    expect(found?.enabled).toBe(false);
  });

  it('is a no-op when the bot does not exist', async () => {
    await setBotEnabled('nonexistent', true);
    const bots = await listBots();
    expect(bots).toEqual([]);
  });
});

describe('project root not resolved yet', () => {
  // Live QA regression: right after boot the manager's list_lazybots read a
  // bare ".lazy/bots.json" (root ''), which the native side resolved against
  // the process cwd — another repo's bots — and run_lazybot then failed with
  // "bot not found" once the real root was cached.
  beforeEach(() => {
    invalidateProjectRootCache();
  });

  it('waits for the cached root instead of reading a cwd-relative path', async () => {
    vi.useFakeTimers();
    try {
      setBotsRoot('');
      memFs.set('/late/.lazy/bots.json', JSON.stringify({ version: '1.0.0', bots: [makeBot({ id: 'bot_late' })] }));
      const pending = listBots();
      await vi.advanceTimersByTimeAsync(900);
      expect(readFile).not.toHaveBeenCalled();
      setCachedProjectRoot('/late');
      await vi.advanceTimersByTimeAsync(300);
      const bots = await pending;
      expect(bots.map((b) => b.id)).toEqual(['bot_late']);
      expect(readFile).toHaveBeenCalledWith('/late/.lazy/bots.json');
      expect(readFile.mock.calls.some(([p]) => !String(p).startsWith('/late/'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up with [] (never a relative read) when no root ever shows up, and refuses to save', async () => {
    vi.useFakeTimers();
    try {
      setBotsRoot('');
      const pending = listBots();
      await vi.advanceTimersByTimeAsync(30 * 300 + 10);
      expect(await pending).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();
      const save = expect(saveBot(makeBot())).rejects.toThrow(/no active project root/);
      // saveBot = read (one bounded wait) + write (a second one).
      await vi.advanceTimersByTimeAsync(2 * (30 * 300 + 10));
      await save;
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForRoot:false answers [] immediately (no timer) when no root is cached — the manager-turn read path', async () => {
    vi.useFakeTimers();
    try {
      setBotsRoot('');
      // Resolves without a single timer tick: the manager turn has already
      // awaited resolveProjectRoot() itself, so an empty cache here means
      // "no project", not "not yet".
      const bots = await listBots({ waitForRoot: false });
      expect(bots).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForRoot:false still reads the real file once the root IS cached', async () => {
    setBotsRoot('');
    setCachedProjectRoot('/now');
    memFs.set('/now/.lazy/bots.json', JSON.stringify({ version: '1.0.0', bots: [makeBot({ id: 'bot_now' })] }));
    const bots = await listBots({ waitForRoot: false });
    expect(bots.map((b) => b.id)).toEqual(['bot_now']);
    expect(readFile).toHaveBeenCalledWith('/now/.lazy/bots.json');
  });
});
