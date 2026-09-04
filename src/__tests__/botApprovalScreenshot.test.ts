import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPendingApproval,
  interceptAction,
  resolveApproval,
} from '../lib/agents/approval/approvalGate';
import { getLastBotVmState } from '../lib/solari/botVmState';

vi.mock('../lib/solari/botVmState', () => ({
  getLastBotVmState: vi.fn(),
}));

vi.mock('../lib/bots/botEngine', () => ({
  botIdForMission: vi.fn((missionId: string) => (missionId === 'm1' ? 'bot_1' : undefined)),
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('approval screenshot producer (C79)', () => {
  beforeEach(() => {
    vi.mocked(getLastBotVmState).mockReturnValue({
      mode: 'browser',
      botId: 'bot_1',
      screenshotDataUrl: 'data:image/png;base64,AAA',
      url: 'https://example.com/pay',
    });
  });

  it('attaches the live bot screenshot to pending approval page context', async () => {
    const { enrichApprovalPageContext } = await import('../lib/bots/botApprovalScreenshot');
    const page = enrichApprovalPageContext('m1', { url: 'https://example.com/pay', targetText: 'Pay' });
    expect(page.screenshotDataUrl).toBe('data:image/png;base64,AAA');

    const pendingPromise = interceptAction({
      missionId: 'm1',
      tool: 'cloud_browser_click',
      args: { text: 'Pay' },
      page,
      autonomy: 'manual',
    });
    await flush();
    const pending = getPendingApproval('m1');
    expect(pending?.page.screenshotDataUrl).toBe('data:image/png;base64,AAA');
    resolveApproval('m1', 'approve');
    await pendingPromise;
  });
});
