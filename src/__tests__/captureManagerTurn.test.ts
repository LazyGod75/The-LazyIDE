/**
 * D91 — conversation capture on manager turn-end (debounced), not only on close.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolveCaptureIdentityMock = vi.fn();
const withCaptureAuthorMock = vi.fn();

vi.mock('../lib/brain/captureAuthor', () => ({
  resolveCaptureIdentity: (...args: unknown[]) => resolveCaptureIdentityMock(...args),
  withCaptureAuthor: (...args: unknown[]) => withCaptureAuthorMock(...args),
}));

vi.mock('../lib/teams/activeBrainConfig', () => ({
  readActiveBrainConfig: vi.fn(() => null),
}));

vi.mock('../lib/teams/syncDaemon', () => ({
  schedulePostCapturePush: vi.fn(),
}));

import {
  maybeCaptureManagerConversation,
  resetManagerTurnCaptureForTests,
  MANAGER_TURN_CAPTURE_DEBOUNCE_MS,
} from '../lib/brain/capture';
import { scheduleManagerTurnCapture } from '../lib/agents/managerTurnCapture';
import { WebPlatform } from '../lib/platform/web';
import { resetCaptureQueueForTests } from '../lib/brain/captureQueue';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resolveCaptureIdentityMock.mockResolvedValue({ author: undefined, authorId: undefined, dept: undefined });
  withCaptureAuthorMock.mockImplementation((event: unknown) => event);
  resetManagerTurnCaptureForTests();
  resetCaptureQueueForTests();
});

afterEach(() => {
  resetCaptureQueueForTests();
  resetManagerTurnCaptureForTests();
  vi.useRealTimers();
});

const twoTurns = [
  { role: 'user' as const, content: 'Plan the auth rewrite' },
  { role: 'assistant' as const, content: 'I will draft a charter for JWT vs sessions.' },
];

describe('maybeCaptureManagerConversation (D91)', () => {
  it('captures a qualifying conversation at turn-end', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'c1', path: '', sizeBytes: 0, attrsCount: 0,
    });

    const captured = maybeCaptureManagerConversation({
      conversationId: 'conv-turn-1',
      turns: twoTurns,
    });
    expect(captured).toBe(true);
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0].source).toBe('lazy-manager:conversation-summary');
    expect(spy.mock.calls[0][0].stableId).toBe('conv-turn-1');
  });

  it('skips a conversation with fewer than two qualifying turns', () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'c0', path: '', sizeBytes: 0, attrsCount: 0,
    });
    expect(maybeCaptureManagerConversation({
      conversationId: 'conv-short',
      turns: [{ role: 'user', content: 'hi' }],
    })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('debounces a second capture of the same conversation', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'c2', path: '', sizeBytes: 0, attrsCount: 0,
    });
    maybeCaptureManagerConversation({ conversationId: 'conv-deb', turns: twoTurns, now: 1_000 });
    const again = maybeCaptureManagerConversation({
      conversationId: 'conv-deb',
      turns: [...twoTurns, { role: 'user', content: 'go' }, { role: 'assistant', content: 'launched' }],
      now: 1_000 + MANAGER_TURN_CAPTURE_DEBOUNCE_MS - 1,
    });
    expect(again).toBe(false);
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('captures again after the debounce window', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'c3', path: '', sizeBytes: 0, attrsCount: 0,
    });
    maybeCaptureManagerConversation({ conversationId: 'conv-later', turns: twoTurns, now: 1_000 });
    const later = maybeCaptureManagerConversation({
      conversationId: 'conv-later',
      turns: [...twoTurns, { role: 'user', content: 'status?' }, { role: 'assistant', content: 'M12 running' }],
      now: 1_000 + MANAGER_TURN_CAPTURE_DEBOUNCE_MS + 1,
    });
    expect(later).toBe(true);
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleManagerTurnCapture', () => {
  it('no-ops without a conversation id', () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'x', path: '', sizeBytes: 0, attrsCount: 0,
    });
    scheduleManagerTurnCapture({
      messages: twoTurns,
      responseText: 'done',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('appends the assistant reply before capturing', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'c4', path: '', sizeBytes: 0, attrsCount: 0,
    });
    scheduleManagerTurnCapture({
      conversationId: 'conv-append',
      messages: [{ role: 'user', content: 'Plan the auth rewrite' }],
      responseText: 'I will draft a charter for JWT vs sessions.',
    });
    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0].text)).toContain('JWT vs sessions');
  });
});
