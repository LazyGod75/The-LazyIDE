import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const launch = vi.fn();
const release = vi.fn();
const files = new Map<string, string>();

vi.mock('../lib/solari/solariClient', () => ({
  getSolariClients: vi.fn(async () => ({
    browser: { launch, release },
    desktop: {},
    sandbox: { volumes: { create: vi.fn() } },
  })),
  solariCdpProxyBase: () => 'ws://proxy',
}));

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
  })),
}));

vi.mock('../lib/agents/projectRootCache', () => ({
  getCachedProjectRoot: () => '/repo',
}));

function fakeBrowser(id: string) {
  return {
    id,
    contexts: () => [{ pages: () => [] }],
    pages: [],
    close: vi.fn(),
  };
}

describe('long-lived persona browser sessions (C49)', () => {
  beforeEach(async () => {
    files.clear();
    launch.mockReset();
    release.mockReset();
    launch.mockImplementation(async () => fakeBrowser(`ses_${launch.mock.calls.length}`));
    const { resetSolariSessionsState, setSolariSessionsRoot } = await import('../lib/solari/solariSessions');
    setSolariSessionsRoot('/repo');
    resetSolariSessionsState();
  });

  afterEach(async () => {
    const { resetSolariSessionsState } = await import('../lib/solari/solariSessions');
    resetSolariSessionsState();
  });

  it('reuses the same CDP session across missions for the same botId+profile', async () => {
    const {
      openBrowserSession,
      releaseBrowser,
      getBrowserSession,
      readLedger,
    } = await import('../lib/solari/solariSessions');

    const h1 = await openBrowserSession('m1', {
      profileId: 'prof_a',
      botId: 'bot_1',
      longLived: true,
    });
    expect(h1.sessionId).toBe('ses_1');
    expect(launch).toHaveBeenCalledTimes(1);

    // Mission end parks the persona session — does not destroy CDP
    await releaseBrowser('m1');
    expect(getBrowserSession('m1')).toBeUndefined();

    const h2 = await openBrowserSession('m2', {
      profileId: 'prof_a',
      botId: 'bot_1',
      longLived: true,
    });
    expect(h2.sessionId).toBe('ses_1');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(getBrowserSession('m2')?.sessionId).toBe('ses_1');

    const ledger = await readLedger();
    const entry = ledger.browserSessions.find((s) => s.id === 'ses_1');
    expect(entry?.botId).toBe('bot_1');
    expect(entry?.longLived).toBe(true);
    expect(entry?.missionId).toBe('m2');
  });

  it('hard-releases when longLived is false (ephemeral mission session)', async () => {
    const { openBrowserSession, releaseBrowser, readLedger } = await import('../lib/solari/solariSessions');
    const h = await openBrowserSession('m1', { profileId: 'prof_a', botId: 'bot_1' });
    await releaseBrowser('m1');
    const ledger = await readLedger();
    expect(ledger.browserSessions.find((s) => s.id === h.sessionId)).toBeUndefined();
  });
});
