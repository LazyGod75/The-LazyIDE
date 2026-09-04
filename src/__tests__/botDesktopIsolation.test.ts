import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const desktopCreate = vi.fn();
const desktopConnect = vi.fn();
const files = new Map<string, string>();

vi.mock('../lib/solari/solariClient', () => ({
  getSolariClients: vi.fn(async () => ({
    browser: {},
    desktop: {
      create: desktopCreate,
      connect: desktopConnect,
    },
    sandbox: {
      volumes: {
        create: vi.fn(async () => ({ volumeId: 'vol_shared' })),
      },
    },
  })),
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

function fakeDesktop(id: string) {
  return {
    id,
    connect: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => `snap_${id}`),
  };
}

describe('desktop VM isolation (C50)', () => {
  beforeEach(async () => {
    files.clear();
    desktopCreate.mockReset();
    desktopConnect.mockReset();
    let n = 0;
    desktopCreate.mockImplementation(async () => {
      n += 1;
      return fakeDesktop(`dsk_bot_${n}`);
    });
    desktopConnect.mockImplementation(async (id: string) => fakeDesktop(id));
    const { resetAgentComputerState } = await import('../lib/solari/agentComputer');
    const { setSolariSessionsRoot } = await import('../lib/solari/sessionLedger');
    setSolariSessionsRoot('/repo');
    resetAgentComputerState();
  });

  afterEach(async () => {
    const { resetAgentComputerState } = await import('../lib/solari/agentComputer');
    resetAgentComputerState();
  });

  it('desktopOwnerKey scopes the holder by botId when provided', async () => {
    const { desktopOwnerKey } = await import('../lib/solari/agentComputer');
    expect(desktopOwnerKey('M1')).toBe('M1');
    expect(desktopOwnerKey('M1', 'bot_a')).toBe('bot_a:M1');
  });

  it('ensureAgentComputer(botId) persists a distinct desktop in agentComputersByBotId', async () => {
    const { ensureAgentComputer, resetAgentComputerState } = await import('../lib/solari/agentComputer');
    const { readLedger, setSolariSessionsRoot } = await import('../lib/solari/sessionLedger');
    setSolariSessionsRoot('/repo');
    resetAgentComputerState();

    const a = await ensureAgentComputer('bot_a');
    const b = await ensureAgentComputer('bot_b');
    expect(a.desktopId).not.toBe(b.desktopId);
    expect(desktopCreate).toHaveBeenCalledTimes(2);

    const ledger = await readLedger();
    expect(ledger.agentComputersByBotId?.bot_a?.desktopId).toBe(a.desktopId);
    expect(ledger.agentComputersByBotId?.bot_b?.desktopId).toBe(b.desktopId);

    // Reconnect uses ledger, not a third create
    const a2 = await ensureAgentComputer('bot_a');
    expect(a2.desktopId).toBe(a.desktopId);
    expect(desktopConnect).toHaveBeenCalledWith(a.desktopId);
  });

  it('shared AC (no botId) still uses ledger.agentComputer', async () => {
    const { ensureAgentComputer } = await import('../lib/solari/agentComputer');
    const { readLedger } = await import('../lib/solari/sessionLedger');
    const shared = await ensureAgentComputer();
    const ledger = await readLedger();
    expect(ledger.agentComputer?.desktopId).toBe(shared.desktopId);
  });
});
