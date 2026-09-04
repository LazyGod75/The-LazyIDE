import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamStart = vi.fn();

vi.mock('../lib/solari/solariSessions', () => ({
  ensureAgentComputer: vi.fn(async () => ({
    desktop: { stream: { start: streamStart } },
    desktopId: 'dsk_1',
    volumeId: 'vol_1',
  })),
  getBrowserSession: vi.fn(),
  missionIdForBrowserSession: vi.fn(),
}));

vi.mock('../lib/bots/botEngine', () => ({
  botIdForMission: vi.fn(),
  listActiveRunsForBot: vi.fn(() => []),
}));

describe('BotVm stream singleton (C78)', () => {
  beforeEach(async () => {
    streamStart.mockReset();
    streamStart.mockResolvedValue({ streamUrl: 'https://novnc.example/s1', token: 't1' });
    const { resetDesktopStreamState } = await import('../lib/solari/botVmState');
    resetDesktopStreamState();
  });

  it('openDesktopStream reuses one live stream across hosts', async () => {
    const { openDesktopStream } = await import('../lib/solari/botVmState');
    const a = await openDesktopStream('bot_a');
    const b = await openDesktopStream('bot_b');
    expect(a).toEqual({ streamUrl: 'https://novnc.example/s1', token: 't1' });
    expect(b).toEqual(a);
    expect(streamStart).toHaveBeenCalledTimes(1);
  });

  it('BOT_VM_HOST_CANONICAL names BotVmSurface as the only stream owner', async () => {
    const { BOT_VM_HOST_CANONICAL } = await import('../lib/solari/botVmState');
    expect(BOT_VM_HOST_CANONICAL).toMatch(/BotVmSurface/);
    expect(BOT_VM_HOST_CANONICAL).toMatch(/single shared stream/i);
  });
});
