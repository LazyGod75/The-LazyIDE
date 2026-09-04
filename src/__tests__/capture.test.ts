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

import { captureEdit, captureAssistant, captureAgentMission, stripLeakedReasoning } from '../lib/brain/capture';
import { WebPlatform } from '../lib/platform/web';
import { resetCaptureQueueForTests, getCaptureRetryQueueSize } from '../lib/brain/captureQueue';

// The capture module calls getPlatform() which returns WebPlatform in non-Tauri mode.
// WebPlatform.brain.capture stores events in _captureStore.
// We spy on it to verify call shape without depending on the internal store.

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resolveCaptureIdentityMock.mockResolvedValue({ author: undefined, authorId: undefined, dept: undefined });
  withCaptureAuthorMock.mockImplementation((event: unknown) => event);
});

afterEach(() => {
  // Drain/clear any pending captureQueue timers before switching timer mode —
  // avoids leaking fake-timer-scheduled retries into the next test.
  resetCaptureQueueForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('captureEdit', () => {
  it('calls brain.capture with kind=edit', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'test-id',
      path: '/mock/test.html',
      sizeBytes: 0,
      attrsCount: 0,
    });

    captureEdit('/project/src/auth.ts', 'auth.ts', 'export const token = ...');

    // Allow the microtask / promise to resolve
    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledOnce();
    const [event] = spy.mock.calls[0];
    expect(event.kind).toBe('edit');
    expect(event.files).toContain('/project/src/auth.ts');
    expect(event.title).toContain('auth.ts');
    expect(event.source).toBe('lazy-ide:editor');
  });

  it('includes firstLine in text when provided', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'id2', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureEdit('/project/src/config.ts', 'config.ts', 'export const config = {');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.text).toContain('export const config = {');
  });

  it('debounces: second call within 15s is ignored', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'id3', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureEdit('/debounce-test.ts', 'debounce-test.ts', 'export function authenticate(token: string)');
    // Advance 5 seconds — still within debounce window
    vi.advanceTimersByTime(5_000);
    captureEdit('/debounce-test.ts', 'debounce-test.ts', 'export function authenticate(token: string)');

    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledOnce();
  });

  it('allows second call after 15s debounce expires', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'id4', path: '', sizeBytes: 0, attrsCount: 0,
    });

    // Use a unique path to avoid state from other tests
    captureEdit('/fresh-file-for-debounce.ts', 'fresh.ts', 'export const config = { apiUrl, timeout, retries }');
    vi.advanceTimersByTime(16_000); // past 15s window
    captureEdit('/fresh-file-for-debounce.ts', 'fresh.ts', 'export const config = { apiUrl, timeout, retries }');

    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('swallows errors from brain.capture without throwing', async () => {
    vi.spyOn(WebPlatform.brain, 'capture').mockRejectedValue(new Error('storage failure'));

    // Should not throw
    expect(() => {
      captureEdit('/error-test.ts', 'error-test.ts');
    }).not.toThrow();

    await vi.runAllTimersAsync();
    // No unhandled rejection propagated to the test
  });

  it('FIX 1: hands a failed capture to the retry queue instead of dropping it (1 initial + 3 retries)', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockRejectedValue(new Error('sidecar down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    captureEdit('/retry-test.ts', 'retry-test.ts', 'export function alwaysFailsToSave() { return 1; }');
    await vi.runAllTimersAsync();

    // 1 original dispatch() attempt + 3 queued retries (2s/8s/30s backoff) = 4 calls total.
    expect(spy).toHaveBeenCalledTimes(4);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('permanently failed'),
      expect.stringContaining('retry-test.ts'),
    );
  });

  it('FIX 1: a capture that fails then succeeds on retry is not lost, and does not give up', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture')
      .mockRejectedValueOnce(new Error('sidecar briefly down'))
      .mockResolvedValueOnce({ id: 'recovered', path: '/mock/recovered.html', sizeBytes: 1, attrsCount: 1 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    captureEdit('/recovers.ts', 'recovers.ts', 'export function eventuallySaves() { return 1; }');
    await vi.runAllTimersAsync();

    // Initial attempt fails, first retry (after 2s) succeeds — no further retries needed.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('permanently failed'),
      expect.anything(),
    );
  });

  it('BUG 3: a "Note already exists" rejection on the very FIRST attempt is a success (already saved by an earlier attempt) — no retry queuing, no failure warning', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockRejectedValue(
      new Error('brain_capture: store exited 1: lazybrain: Note already exists: /mock/dup.html. Pass overwrite to replace.'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    captureEdit('/duplicate-test.ts', 'duplicate-test.ts', 'export function alreadySaved() { return 1; }');
    await vi.runAllTimersAsync();

    // Recognized as success immediately — the FIRST attempt is never queued for
    // retry at all (unlike a genuine transient failure, which the "FIX 1" tests
    // above show DOES get queued and retried).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getCaptureRetryQueueSize()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('capture failed, queuing retry'),
      expect.anything(),
      expect.anything(),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('permanently failed'),
      expect.anything(),
    );
  });
});

describe('dispatch stamps department on team-brain captures', () => {
  it('copies dept from the capture identity onto the event', async () => {
    resolveCaptureIdentityMock.mockResolvedValue({
      author: 'Alice',
      authorId: 'user-uuid-abc',
      dept: 'engineering',
    });
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'dept-1', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureEdit('/project/src/dept-stamp.ts', 'dept-stamp.ts', 'export const token = ...');
    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0].dept).toBe('engineering');
  });
});

describe('captureAssistant', () => {
  it('uses kind=decision for plan mode', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'a1', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAssistant('How should I refactor?', 'Use extract method.', 'plan');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.kind).toBe('decision');
  });

  it('uses kind=episodic for ask mode', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'a2', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAssistant('What does auth.ts do?', 'It handles JWT signing.', 'ask');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.kind).toBe('episodic');
  });

  it('title is truncated to first 80 chars of userMsg', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'a3', path: '', sizeBytes: 0, attrsCount: 0,
    });

    const longMsg = 'How should we refactor the authentication module to improve security and maintainability? '.repeat(2);
    captureAssistant(longMsg, 'Extract the token validation logic into a dedicated service with clear boundaries.', 'ask');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.title.length).toBeLessThanOrEqual(80);
  });

  it('text contains Q: and A: sections', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'a4', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAssistant(
      'How does the authentication middleware handle token expiry and refresh cycles?',
      'The middleware checks the expiry timestamp, refreshes the token silently when within the grace window, and redirects to login only on hard expiry.',
      'ask',
    );
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.text).toContain('Q: How does the authentication middleware');
    expect(event.text).toContain('A: The middleware checks');
  });

  it('tags include "assistant" and the mode', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'a5', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAssistant(
      'What is the recommended approach for handling async errors in the API layer?',
      'Use a centralized error handler that catches all async exceptions, logs them with context, and returns structured error responses to the client.',
      'edit',
    );
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.tags).toContain('assistant');
    expect(event.tags).toContain('edit');
  });

  it('strips a leaked reasoning fragment so only the finalized answer is captured', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'a6', path: '', sizeBytes: 0, attrsCount: 0,
    });

    // Simulates a reasoning-channel leak into the 'text' stream (see
    // stripLeakedReasoning's doc comment in capture.ts): the marker and
    // everything after it on that line is internal reasoning that slipped
    // past the structured thinking/text split upstream, mid-sentence.
    const leaked =
      'Use a centralized error handler for async failures.\x1b[reasoning]the user seems confused about promise rejection semantics, I should keep this simple\n' +
      'Log every error with context before returning a structured response.';

    captureAssistant(
      'How should I handle async errors in the API layer?',
      leaked,
      'ask',
    );
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.text).not.toContain('[reasoning]');
    expect(event.text).not.toContain('confused about promise rejection');
    expect(event.text).toContain('Use a centralized error handler for async failures.');
    expect(event.text).toContain('Log every error with context before returning a structured response.');
  });
});

describe('stripLeakedReasoning', () => {
  it('drops content from the marker to end of line, keeping text before it on the same line', () => {
    const result = stripLeakedReasoning('Visible prefix\x1b[reasoning]hidden reasoning tail');
    expect(result).toBe('Visible prefix');
  });

  it('drops the bare (non-ESC-prefixed) marker form too, when glued to a preceding word character', () => {
    const result = stripLeakedReasoning('Answer starts here[reasoning]internal notes not meant to be seen');
    expect(result).toBe('Answer starts here');
  });

  it('preserves clean multi-line text with no marker untouched (aside from trim)', () => {
    const input = 'First line of the answer.\nSecond line of the answer.';
    expect(stripLeakedReasoning(input)).toBe(input);
  });

  it('is idempotent and returns empty string for reasoning-only input', () => {
    expect(stripLeakedReasoning('\x1b[reasoning]only internal notes, nothing visible')).toBe('');
  });

  // ── FIX 4: tightened to the leak SIGNATURE (glued to a word character,
  // and/or ESC-prefixed), not any literal "[reasoning]" occurrence ────────

  it('strips a mid-word leak glued to the preceding word with no ESC prefix (real observed shape)', () => {
    const result = stripLeakedReasoning('Nous[reasoning] devons continuer.');
    expect(result).toBe('Nous');
  });

  it('strips a leak glued to the FOLLOWING word even when preceded by whitespace', () => {
    const result = stripLeakedReasoning('Reponse: [reasoning]internal notes leak in mid-sentence');
    expect(result).toBe('Reponse:');
  });

  it('keeps a "[reasoning]" mention that reads as normal prose (colon + space before, space after) intact', () => {
    const input = 'The internal marker is: [reasoning] and it separates channels.';
    expect(stripLeakedReasoning(input)).toBe(input);
  });

  it('keeps a backtick-quoted "[reasoning]" mention intact', () => {
    const input = 'The literal marker `[reasoning]` is used internally to split channels.';
    expect(stripLeakedReasoning(input)).toBe(input);
  });
});

describe('captureAgentMission', () => {
  it('calls brain.capture with kind=agent', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'm1', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAgentMission('Refactor Auth', 'Clean up auth module', 'Opus 4.8', 'wt/auth');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.kind).toBe('agent');
    expect(event.title).toContain('Refactor Auth');
  });

  it('text contains model and worktree info', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'm2', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAgentMission('Fix bug', undefined, 'Haiku 4.5', 'wt/fix');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.text).toContain('Haiku 4.5');
    expect(event.text).toContain('wt/fix');
  });

  it('omits empty description from text', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'm3', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAgentMission('Fix bug', undefined, 'Haiku', 'wt/fix');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    // undefined description means no "Description :" line
    expect(event.text).not.toContain('Description');
  });

  it('kickoff enrichment: includes opts.taskText as a "Tache :" line even with no description', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'm4', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAgentMission('Fix bug', undefined, 'Haiku', 'wt/fix', {
      taskText: 'Fix the null pointer in the auth middleware and add a regression test',
    });
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.text).toContain('Fix the null pointer in the auth middleware');
    expect(event.upsertIfRicher).toBeUndefined();
  });

  it('completion path: opts.upsertIfRicher true is forwarded on the CaptureEvent', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'm5', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAgentMission('Fix bug', 'Learning insights: 2 generated', 'Haiku', 'wt/fix', {
      upsertIfRicher: true,
    });
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.upsertIfRicher).toBe(true);
  });

  it('default (no opts): omits upsertIfRicher entirely — no behavior change for the kickoff path', async () => {
    const spy = vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue({
      id: 'm6', path: '', sizeBytes: 0, attrsCount: 0,
    });

    captureAgentMission('Refactor Auth', 'Clean up auth module', 'Opus 4.8', 'wt/auth');
    await vi.runAllTimersAsync();

    const [event] = spy.mock.calls[0];
    expect(event.upsertIfRicher).toBeUndefined();
  });
});
