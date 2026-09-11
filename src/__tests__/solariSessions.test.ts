/* solariSessions.test.ts — unit tests for the Solari session registry
   (src/lib/solari/solariSessions.ts + agentComputer.ts + sessionLedger.ts).

   The three SDK packages, the solariClient layer and the platform file IO
   are mocked: the ledger (.lazy/solari-sessions.json) lives in an in-memory
   map, so no disk and no network is touched.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { BrowserSession } from '@solarisdk/browser';
import type { Desktop } from '@solarisdk/desktop';
import type { Sandbox } from '@solarisdk/sandbox';
import { joinPath } from '../lib/paths';
import { getSolariClients } from '../lib/solari/solariClient';
import type { SolariClients } from '../lib/solari/solariClient';
import {
  getBrowserSession,
  getSandbox,
  openBrowserSession,
  openSandbox,
  readLedger,
  releaseAll,
  releaseBrowser,
  releaseSandbox,
  resetSolariSessionsState,
  setSolariSessionsRoot,
  sweepOrphans,
} from '../lib/solari/solariSessions';
import type { LedgerState } from '../lib/solari/solariSessions';
import {
  acquireAgentComputer,
  ensureAgentComputer,
  isAgentComputerHeldBy,
  snapshotAgentComputer,
} from '../lib/solari/agentComputer';

// ── Mocks ──────────────────────────────────────────────────────────

const files = new Map<string, string>();
const readFile = vi.fn();
const writeFile = vi.fn();
const createDir = vi.fn();
const browserLaunch = vi.fn();
const browserReleaseAndWait = vi.fn();
const desktopConnect = vi.fn();
const desktopCreate = vi.fn();
const sandboxCreate = vi.fn();
const sandboxKill = vi.fn();
const volumeCreate = vi.fn();

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({ fs: { readFile, writeFile, createDir } })),
}));

vi.mock('../lib/solari/solariClient', () => ({
  getSolariClients: vi.fn(),
}));

vi.mock('@solarisdk/browser', () => ({ Solari: vi.fn() }));
vi.mock('@solarisdk/desktop', () => ({ DesktopClient: vi.fn() }));
vi.mock('@solarisdk/sandbox', () => ({ SandboxClient: vi.fn() }));

const mockClients = {
  browser: { launch: browserLaunch, sessions: { releaseAndWait: browserReleaseAndWait, release: vi.fn() } },
  desktop: { connect: desktopConnect, create: desktopCreate, volumes: { create: volumeCreate } },
  sandbox: { create: sandboxCreate, kill: sandboxKill, volumes: { create: volumeCreate } },
} as unknown as SolariClients;

const LEDGER_PATH = joinPath('/repo', '.lazy/solari-sessions.json');

function seedLedger(state: LedgerState): void {
  files.set(LEDGER_PATH, JSON.stringify(state));
}

// ── SDK fakes ──────────────────────────────────────────────────────

function fakeBrowser(id: string, close: Mock = vi.fn().mockResolvedValue(undefined)): BrowserSession {
  return { id, session: { id }, close, newPage: vi.fn(), isConnected: vi.fn(() => true) } as unknown as BrowserSession;
}

function fakeSandbox(id: string, kill: Mock = vi.fn().mockResolvedValue(undefined)): Sandbox {
  return { id, sandboxId: id, kill } as unknown as Sandbox;
}

function fakeDesktop(id: string, snapshot: Mock = vi.fn().mockResolvedValue(`snap_${id}`)): Desktop & { connect: Mock } {
  return {
    id,
    sessionId: id,
    snapshot,
    connect: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  } as unknown as Desktop & { connect: Mock };
}

function fakeVolume(volumeId: string) {
  return { volumeId, name: 'lazybot-workspace', createdAt: '2026-01-01T00:00:00Z' };
}

beforeEach(() => {
  files.clear();
  vi.mocked(getSolariClients).mockReset();
  readFile.mockReset();
  writeFile.mockReset();
  createDir.mockReset();
  browserLaunch.mockReset();
  browserReleaseAndWait.mockReset();
  desktopConnect.mockReset();
  desktopCreate.mockReset();
  sandboxCreate.mockReset();
  sandboxKill.mockReset();
  volumeCreate.mockReset();

  readFile.mockImplementation(async (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error('ENOENT: no such file');
    return content;
  });
  writeFile.mockImplementation(async (path: string, content: string) => {
    files.set(path, content);
  });
  createDir.mockImplementation(async () => undefined);
  browserLaunch.mockResolvedValue(fakeBrowser('ses_default'));
  browserReleaseAndWait.mockResolvedValue(undefined);
  desktopConnect.mockResolvedValue(fakeDesktop('dsk_connect'));
  desktopCreate.mockResolvedValue(fakeDesktop('dsk_create'));
  sandboxCreate.mockResolvedValue(fakeSandbox('sbx_default'));
  sandboxKill.mockResolvedValue(undefined);
  volumeCreate.mockResolvedValue(fakeVolume('vol_1'));
  vi.mocked(getSolariClients).mockResolvedValue(mockClients);

  setSolariSessionsRoot('/repo');
  resetSolariSessionsState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('browser sessions', () => {
  it('queues a second mission on the same profile until the first closes', async () => {
    browserLaunch
      .mockResolvedValueOnce(fakeBrowser('ses_1'))
      .mockResolvedValueOnce(fakeBrowser('ses_2'));
    const h1 = await openBrowserSession('m1', { profileId: 'prof_1' });
    expect(h1.sessionId).toBe('ses_1');

    vi.useFakeTimers();
    let secondSettled = false;
    const second = openBrowserSession('m2', { profileId: 'prof_1' }).then((h) => {
      secondSettled = true;
      return h;
    });
    await vi.runAllTimersAsync();
    expect(secondSettled).toBe(false);
    expect(browserLaunch).toHaveBeenCalledTimes(1);

    await h1.close();
    await vi.runAllTimersAsync();
    const h2 = await second;
    expect(secondSettled).toBe(true);
    expect(h2.sessionId).toBe('ses_2');
    expect(browserLaunch).toHaveBeenCalledTimes(2);
  });

  it('reuses the existing session when a mission re-opens with the same profile', async () => {
    browserLaunch.mockResolvedValueOnce(fakeBrowser('ses_1'));
    const h1 = await openBrowserSession('m1', { profileId: 'prof_1' });
    const h2 = await openBrowserSession('m1', { profileId: 'prof_1' });
    expect(h2).toBe(h1);
    expect(getBrowserSession('m1')).toBe(h1);
    expect(browserLaunch).toHaveBeenCalledTimes(1);
  });

  it('replaces a mission session when re-opening with a different profile', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    browserLaunch
      .mockResolvedValueOnce(fakeBrowser('ses_1', close))
      .mockResolvedValueOnce(fakeBrowser('ses_2'));
    await openBrowserSession('m1', { profileId: 'prof_1' });
    const h2 = await openBrowserSession('m1', { profileId: 'prof_2' });
    expect(h2.sessionId).toBe('ses_2');
    expect(close).toHaveBeenCalledTimes(1);
    expect(browserLaunch).toHaveBeenCalledTimes(2);
    const ledger = await readLedger();
    expect(ledger.browserSessions.map((s) => s.id)).toEqual(['ses_2']);
  });

  it('maps proxyCountry to a stealth-enabled managed proxy launch', async () => {
    browserLaunch.mockResolvedValueOnce(fakeBrowser('ses_1'));
    await openBrowserSession('m1', {
      profileId: 'prof_1',
      proxyCountry: 'gb',
      captcha: true,
      recording: true,
    });
    expect(browserLaunch).toHaveBeenCalledWith({
      profileId: 'prof_1',
      stealth: true,
      proxy: { country: 'gb' },
      captcha: true,
      recording: true,
    });
  });

  it('releaseBrowser is idempotent and cleans the ledger', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    browserLaunch.mockResolvedValueOnce(fakeBrowser('ses_1', close));
    const h1 = await openBrowserSession('m1', { profileId: 'prof_1' });
    await h1.close();
    await h1.close();
    await releaseBrowser('m1');
    expect(close).toHaveBeenCalledTimes(1);
    expect(getBrowserSession('m1')).toBeUndefined();
    const ledger = await readLedger();
    expect(ledger.browserSessions).toHaveLength(0);
  });
});

describe('sandboxes', () => {
  it('creates the shared workspace volume once and reuses it', async () => {
    sandboxCreate
      .mockResolvedValueOnce(fakeSandbox('sbx_1'))
      .mockResolvedValueOnce(fakeSandbox('sbx_2'));
    const h1 = await openSandbox('m1');
    const h2 = await openSandbox('m2');
    expect(h1.sandbox.id).toBe('sbx_1');
    expect(h2.sandbox.id).toBe('sbx_2');
    expect(volumeCreate).toHaveBeenCalledTimes(1);
    expect(volumeCreate).toHaveBeenCalledWith({ name: 'lazybot-workspace' });
    expect(sandboxCreate).toHaveBeenCalledTimes(2);
    expect(sandboxCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        timeoutMs: 15 * 60 * 1000,
        lifecycle: { onTimeout: 'pause' },
        volumes: [{ volumeId: 'vol_1', path: '/workspace' }],
      }),
    );
    expect(getSandbox('m1')).toBe(h1);
  });

  it('releaseSandbox kills and cleans up idempotently', async () => {
    const kill = vi.fn().mockResolvedValue(undefined);
    sandboxCreate.mockResolvedValueOnce(fakeSandbox('sbx_1', kill));
    const h = await openSandbox('m1');
    await h.close();
    await h.close();
    await releaseSandbox('m1');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(getSandbox('m1')).toBeUndefined();
    expect((await readLedger()).sandboxes).toHaveLength(0);
  });
});

describe('agent computer mutex', () => {
  it('grants the Agent Computer mutex FIFO', async () => {
    const release1 = await acquireAgentComputer('m1');
    vi.useFakeTimers();
    let m2Settled = false;
    let m3Settled = false;
    const p2 = acquireAgentComputer('m2').then((r) => {
      m2Settled = true;
      return r;
    });
    const p3 = acquireAgentComputer('m3').then((r) => {
      m3Settled = true;
      return r;
    });
    await vi.runAllTimersAsync();
    expect(m2Settled).toBe(false);
    expect(m3Settled).toBe(false);

    release1();
    await vi.runAllTimersAsync();
    expect(m2Settled).toBe(true);
    expect(m3Settled).toBe(false);
    const release2 = await p2;

    release2();
    await vi.runAllTimersAsync();
    expect(m3Settled).toBe(true);
    const release3 = await p3;
    release3();
    expect(isAgentComputerHeldBy('m3')).toBe(false);
  });

  it('lets the holding mission re-enter without queueing', async () => {
    const release1 = await acquireAgentComputer('m1');
    const release2 = await acquireAgentComputer('m1');
    release1();
    release2();
    const release3 = await acquireAgentComputer('m2');
    expect(isAgentComputerHeldBy('m2')).toBe(true);
    release3();
  });
});

describe('agent computer desktop', () => {
  it('creates the Agent Computer once with the shared volume and never records', async () => {
    desktopCreate.mockResolvedValue(fakeDesktop('dsk_new'));
    const handle = await ensureAgentComputer();
    expect(handle.desktopId).toBe('dsk_new');
    expect(desktopCreate).toHaveBeenCalledWith({
      template: 'default',
      timeoutMs: 15 * 60 * 1000,
      lifecycle: { onTimeout: 'pause' },
      volumes: [{ volumeId: 'vol_1', path: '/workspace' }],
    });
    expect(desktopCreate.mock.calls[0][0]).not.toHaveProperty('record');
    const ledger = await readLedger();
    expect(ledger.agentComputer?.desktopId).toBe('dsk_new');
    expect(ledger.agentComputer?.volumeId).toBe('vol_1');
  });

  it('dials desktop.connect() after create and after connect-by-id', async () => {
    const created = fakeDesktop('dsk_new');
    desktopCreate.mockResolvedValue(created);
    await ensureAgentComputer();
    expect(created.connect).toHaveBeenCalledTimes(1);

    const attached = fakeDesktop('dsk_new');
    desktopConnect.mockResolvedValue(attached);
    await ensureAgentComputer();
    expect(desktopConnect).toHaveBeenCalledWith('dsk_new');
    expect(attached.connect).toHaveBeenCalledTimes(1);
    expect(desktopCreate).toHaveBeenCalledTimes(1);
  });

  it('does not wipe the ledger or create a blank VM when control connect fails', async () => {
    seedLedger({
      version: '1.0.0',
      browserSessions: [],
      sandboxes: [],
      agentComputer: { desktopId: 'dsk_pause', volumeId: 'vol_1', lastSnapshotId: 'snap_keep' },
      agentComputersByBotId: {},
    });
    const attached = fakeDesktop('dsk_pause');
    attached.connect.mockRejectedValue(new Error('Not connected — call connect() first'));
    desktopConnect.mockResolvedValue(attached);
    await expect(ensureAgentComputer()).rejects.toThrow(/Not connected|timed out|control/);
    expect(desktopCreate).not.toHaveBeenCalled();
    expect(await readLedger()).toMatchObject({
      agentComputer: { desktopId: 'dsk_pause', volumeId: 'vol_1', lastSnapshotId: 'snap_keep' },
    });
  });

  it('snapshotAgentComputer stores lastSnapshotId in the ledger', async () => {
    desktopCreate.mockResolvedValue(fakeDesktop('dsk_1'));
    const snapshotId = await snapshotAgentComputer('checkpoint');
    expect(snapshotId).toBe('snap_dsk_1');
    const ledger = await readLedger();
    expect(ledger.agentComputer?.lastSnapshotId).toBe('snap_dsk_1');
  });
});

describe('releaseAll', () => {
  it('snapshots the Agent Computer before releasing the mutex', async () => {
    const snapshot = vi.fn().mockResolvedValue('snap_post');
    desktopCreate.mockResolvedValue(fakeDesktop('dsk_1', snapshot));
    const release = await acquireAgentComputer('m1');
    let heldDuringSnapshot: boolean | null = null;
    snapshot.mockImplementation(async () => {
      heldDuringSnapshot = isAgentComputerHeldBy('m1');
      return 'snap_post';
    });
    await releaseAll('m1');
    expect(snapshot).toHaveBeenCalledWith('post-run');
    expect(heldDuringSnapshot).toBe(true);
    expect(isAgentComputerHeldBy('m1')).toBe(false);
    expect(release).toBeDefined();
  });
});

describe('sweepOrphans and ledger resilience', () => {
  it('releases orphaned ledger sessions and preserves the Agent Computer', async () => {
    seedLedger({
      version: '1.0.0',
      browserSessions: [
        { id: 'ses_orphan_1', missionId: 'gone_1', profileId: 'prof_x', openedAt: 1 },
        { id: 'ses_orphan_2', missionId: 'gone_2', openedAt: 2 },
      ],
      sandboxes: [{ id: 'sbx_orphan_1', missionId: 'gone_3', openedAt: 3 }],
      agentComputer: { desktopId: 'dsk_persist', volumeId: 'vol_1', lastSnapshotId: 'snap_old' },
      agentComputersByBotId: {},
    });
    desktopConnect.mockResolvedValue(fakeDesktop('dsk_persist'));
    await sweepOrphans();
    expect(browserReleaseAndWait).toHaveBeenCalledTimes(2);
    expect(browserReleaseAndWait).toHaveBeenCalledWith('ses_orphan_1');
    expect(browserReleaseAndWait).toHaveBeenCalledWith('ses_orphan_2');
    expect(sandboxKill).toHaveBeenCalledWith('sbx_orphan_1');
    expect(desktopConnect).toHaveBeenCalledWith('dsk_persist');
    const ledger = await readLedger();
    expect(ledger.browserSessions).toHaveLength(0);
    expect(ledger.sandboxes).toHaveLength(0);
    expect(ledger.agentComputer).toEqual({
      desktopId: 'dsk_persist',
      volumeId: 'vol_1',
      lastSnapshotId: 'snap_old',
    });
  });

  it('drops unreachable orphan ids from the ledger with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    seedLedger({
      version: '1.0.0',
      browserSessions: [{ id: 'ses_gone', missionId: 'gone', openedAt: 1 }],
      sandboxes: [],
      agentComputer: null,
      agentComputersByBotId: {},
    });
    browserReleaseAndWait.mockRejectedValue(new Error('unreachable'));
    await sweepOrphans();
    expect(warn).toHaveBeenCalled();
    expect((await readLedger()).browserSessions).toHaveLength(0);
    warn.mockRestore();
  });

  it('tolerates a missing ledger and starts fresh', async () => {
    expect(await readLedger()).toEqual({
      version: '1.0.0',
      browserSessions: [],
      sandboxes: [],
      agentComputer: null,
      agentComputersByBotId: {},
    });
  });

  it('tolerates a corrupt ledger and starts fresh', async () => {
    files.set(LEDGER_PATH, '{ definitely not valid json');
    const ledger = await readLedger();
    expect(ledger.browserSessions).toEqual([]);
    expect(ledger.agentComputer).toBeNull();
  });
});



