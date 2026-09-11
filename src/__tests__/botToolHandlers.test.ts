import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emit, on } from '../lib/bus';
import {
  remapBotDeliverablePath,
  remapBotCloudDeliverablePath,
  registerBotToolHandlers,
  resetBotToolHandlers,
  handleBotRequestIntervention,
} from '../lib/bots/botToolHandlers';
import { getTool } from '../lib/agents/toolRegistry';
import { toolHandlers } from '../lib/tools/handlers/index';
import { botIdForMission, registerBotRun, resetBotEngineState } from '../lib/bots/botEngine';
import { resetInterventions } from '../lib/bots/botRequestIntervention';
import { emitCdpPageView } from '../lib/solari/cdpBrowser';

vi.mock('../lib/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bus')>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

vi.mock('../lib/solari/solariSessions', () => ({
  missionIdForBrowserSession: vi.fn((sessionId: string) => (sessionId === 'sess_1' ? 'M1' : undefined)),
}));

describe('remapBotDeliverablePath', () => {
  it('prefixes relative writes under .lazy/bot-deliverables/<botId>/', () => {
    expect(remapBotDeliverablePath('bot_1', 'scrape-result.txt')).toBe('.lazy/bot-deliverables/bot_1/scrape-result.txt');
    expect(remapBotDeliverablePath('bot_1', 'notes/out.md')).toBe('.lazy/bot-deliverables/bot_1/notes/out.md');
  });

  it('does not double-prefix an already-remapped path', () => {
    const p = '.lazy/bot-deliverables/bot_1/out.txt';
    expect(remapBotDeliverablePath('bot_1', p)).toBe(p);
  });

  it('remaps cloud writes under /workspace/bot-deliverables/<botId>/ (C83)', () => {
    expect(remapBotCloudDeliverablePath('bot_1', 'out.txt')).toBe('/workspace/bot-deliverables/bot_1/out.txt');
    expect(remapBotCloudDeliverablePath('bot_1', '/workspace/bot-deliverables/bot_1/out.txt'))
      .toBe('/workspace/bot-deliverables/bot_1/out.txt');
  });
});

describe('bot_* registry tools', () => {
  it('registers bot_request_intervention and bot_handoff', () => {
    expect(getTool('bot_request_intervention')?.name).toBe('bot_request_intervention');
    expect(getTool('bot_handoff')?.name).toBe('bot_handoff');
  });
});

describe('bot tool handler wiring', () => {
  const originalAskUser = toolHandlers.ask_user;

  beforeEach(() => {
    vi.mocked(emit).mockClear();
    resetBotEngineState();
    resetInterventions();
    resetBotToolHandlers();
    toolHandlers.ask_user = vi.fn(async () => 'Waiting for user input…');
    registerBotRun('bot_1', 'M1');
    registerBotToolHandlers();
  });

  afterEach(() => {
    resetBotToolHandlers();
    toolHandlers.ask_user = originalAskUser;
    resetBotEngineState();
    resetInterventions();
  });

  it('bot_request_intervention emits bot:intervention for the owning bot', async () => {
    const seen: unknown[] = [];
    const off = on('bot:intervention', (p) => { seen.push(p); });
    const msg = await handleBotRequestIntervention(
      { reason: 'login', detail: 'https://example.com/login' },
      { missionId: 'M1' } as never,
    );
    off();
    expect(msg).toMatch(/Intervention requested/);
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'bot:intervention',
      expect.objectContaining({ botId: 'bot_1', reason: 'login', detail: 'https://example.com/login' }),
    );
    expect(seen).toHaveLength(1);
  });

  it('ask_user on a bot mission also lights the manager-header intervention channel', async () => {
    await toolHandlers.ask_user({ question: 'Which account?' }, { missionId: 'M1' } as never);
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'bot:intervention',
      expect.objectContaining({ botId: 'bot_1', reason: 'ask_user', detail: 'Which account?' }),
    );
  });

  it('solari:approvalRequest on a bot mission surfaces approval in the header channel', () => {
    emit('solari:approvalRequest', {
      missionId: 'M1',
      tool: 'cloud_browser_click',
      args: {},
      klass: 'browse',
      reason: 'class',
      page: { url: 'https://example.com/checkout' },
      requestedAt: Date.now(),
    });
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'bot:intervention',
      expect.objectContaining({
        botId: 'bot_1',
        reason: 'approval',
        detail: 'cloud_browser_click @ https://example.com/checkout',
      }),
    );
  });

  it('CDP page views on login walls auto-request intervention', () => {
    emitCdpPageView({ sessionId: 'sess_1', url: 'https://github.com/login', title: 'Sign in to GitHub' });
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'bot:intervention',
      expect.objectContaining({ botId: 'bot_1', reason: 'login', detail: 'https://github.com/login' }),
    );
  });

  it('ignores CDP page views when the session is not a bot mission', () => {
    const before = vi.mocked(emit).mock.calls.length;
    emitCdpPageView({ sessionId: 'sess_other', url: 'https://github.com/login', title: 'Sign in' });
    expect(vi.mocked(emit).mock.calls.length).toBe(before);
    expect(botIdForMission('M1')).toBe('bot_1');
  });
});
