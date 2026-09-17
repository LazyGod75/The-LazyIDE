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
  registerRunArtifactStamper: vi.fn(),
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

  it('openDesktopStream reuses one live stream per bot, never across bots', async () => {
    const { openDesktopStream } = await import('../lib/solari/botVmState');
    const a1 = await openDesktopStream('bot_a');
    expect(a1).toEqual({ streamUrl: 'https://novnc.example/s1', token: 't1' });
    // Same bot, second surface: the cached stream is reused — no restart.
    const a2 = await openDesktopStream('bot_a');
    expect(a2).toEqual(a1);
    expect(streamStart).toHaveBeenCalledTimes(1);
    // A different bot owns a different desktop — its own stream starts.
    await openDesktopStream('bot_b');
    expect(streamStart).toHaveBeenCalledTimes(2);
  });

  it('BOT_VM_HOST_CANONICAL names BotVmSurface as the only stream owner', async () => {
    const { BOT_VM_HOST_CANONICAL } = await import('../lib/solari/botVmState');
    expect(BOT_VM_HOST_CANONICAL).toMatch(/BotVmSurface/);
    expect(BOT_VM_HOST_CANONICAL).toMatch(/single shared stream/i);
  });
});
