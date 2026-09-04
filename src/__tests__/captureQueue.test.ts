/* captureQueue.test.ts — bounded retry queue for failed brain captures.

   Covers:
   1. Retry with exponential backoff (2s / 8s / 30s) until the transport
      eventually succeeds.
   2. Give-up after MAX_RETRIES exhausted — onCaptureGiveUp notified exactly
      once, console.warn logged, queue entry removed.
   3. Bounded queue (cap 50) — drop-oldest with a warn once full.
   4. FIX 1c — "already exists" ConflictError is treated as success (no
      further retries, onSuccess called, no give-up notification), since it
      means an earlier attempt already landed under the same title+day id.
   5. onCaptureGiveUp subscribe/unsubscribe plumbing.

   The transport is always a mock injected per-call (never the real
   platform), per the task's "mock the transport" requirement.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CaptureEvent, CaptureResult } from '../lib/platform/types';
import {
  enqueueCaptureRetry,
  onCaptureGiveUp,
  getCaptureRetryQueueSize,
  getLastCaptureFailure,
  resetCaptureQueueForTests,
  type CaptureTransport,
} from '../lib/brain/captureQueue';
import { emitBuffered } from '../lib/journal/journal';

// Mocked at the module boundary (never the real Tauri invoke plumbing) so
// these tests exercise captureQueue.ts's OWN give-up logic only — matching
// this suite's existing "mock the transport, never the real platform" rule.
vi.mock('../lib/journal/journal', () => ({
  emitBuffered: vi.fn(),
}));

function makeEvent(title = 'Edit: foo.ts'): CaptureEvent {
  return {
    kind: 'edit',
    title,
    text: 'Fichier sauvegardé : foo.ts',
    source: 'test',
  };
}

const RESULT: CaptureResult = { id: 'foo-2026-07-01', path: '/mock/foo.html', sizeBytes: 42, attrsCount: 3 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetCaptureQueueForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('captureQueue — retry with exponential backoff', () => {
  it('does not call the transport again before the 2s backoff elapses', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('sidecar down'));
    enqueueCaptureRetry(makeEvent(), transport);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport).not.toHaveBeenCalled();
  });

  it('retries at 2s, then 8s, then 30s, then succeeds', async () => {
    const transport: CaptureTransport = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(RESULT);
    const onSuccess = vi.fn();

    enqueueCaptureRetry(makeEvent(), transport, { onSuccess });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(transport).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport).toHaveBeenCalledTimes(3);

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ title: 'Edit: foo.ts' }));
    expect(getCaptureRetryQueueSize()).toBe(0);
  });

  it('succeeding on the very first retry stops the backoff chain (no further calls)', async () => {
    const transport: CaptureTransport = vi.fn().mockResolvedValueOnce(RESULT);
    const onSuccess = vi.fn();

    enqueueCaptureRetry(makeEvent(), transport, { onSuccess });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    // No more timers pending — advancing far past 8s/30s must not call it again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('captureQueue — give-up after retries exhausted', () => {
  it('notifies onCaptureGiveUp exactly once after 3 failed retries, and warns', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('sidecar down'));
    const giveUpListener = vi.fn();
    const unsubscribe = onCaptureGiveUp(giveUpListener);

    enqueueCaptureRetry(makeEvent('Edit: bar.ts'), transport);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(transport).toHaveBeenCalledTimes(3);
    expect(giveUpListener).toHaveBeenCalledTimes(1);
    expect(giveUpListener).toHaveBeenCalledWith(expect.objectContaining({ title: 'Edit: bar.ts' }));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('permanently failed'),
      'Edit: bar.ts',
    );
    expect(getCaptureRetryQueueSize()).toBe(0);

    unsubscribe();
  });

  it('a throwing listener does not prevent other listeners from being notified', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('sidecar down'));
    const badListener = vi.fn(() => { throw new Error('listener bug'); });
    const goodListener = vi.fn();
    onCaptureGiveUp(badListener);
    onCaptureGiveUp(goodListener);

    enqueueCaptureRetry(makeEvent(), transport);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(badListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further notifications', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('sidecar down'));
    const listener = vi.fn();
    const unsubscribe = onCaptureGiveUp(listener);
    unsubscribe();

    enqueueCaptureRetry(makeEvent(), transport);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('captureQueue — bounded size (cap 50, drop-oldest)', () => {
  it('never exceeds 50 tracked entries and warns when dropping the oldest', () => {
    // A transport whose promise never settles — keeps every entry "in flight"
    // (not yet retried) so the queue size reflects exactly what was enqueued.
    const neverSettles: CaptureTransport = () => new Promise<CaptureResult>(() => {});

    for (let i = 0; i < 55; i++) {
      enqueueCaptureRetry(makeEvent(`Edit: file-${i}.ts`), neverSettles);
    }

    expect(getCaptureRetryQueueSize()).toBe(50);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('retry queue full'),
      expect.anything(),
      expect.stringContaining('dropped oldest'),
      'Edit: file-0.ts',
    );
  });
});

describe('captureQueue — FIX 1c: "already exists" is treated as success', () => {
  it('does not retry, calls onSuccess, and never fires a give-up notice', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(
      new Error('brain_capture: store exited 1: lazybrain: Note already exists: /mock/foo.html. Pass overwrite to replace.'),
    );
    const onSuccess = vi.fn();
    const giveUpListener = vi.fn();
    const unsubscribe = onCaptureGiveUp(giveUpListener);

    enqueueCaptureRetry(makeEvent(), transport, { onSuccess });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(getCaptureRetryQueueSize()).toBe(0);

    // Advancing well past every backoff window must not trigger more calls —
    // the entry was removed from the queue on the conflict, not rescheduled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(giveUpListener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('is case-insensitive and matches regardless of surrounding text', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('ALREADY EXISTS: weird casing'));
    const onSuccess = vi.fn();

    enqueueCaptureRetry(makeEvent(), transport, { onSuccess });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('captureQueue — capture honesty (brain.capture_failed + getLastCaptureFailure)', () => {
  it('emits a brain.capture_failed journal event on give-up, correlating missionId from a mission:<id> tag', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('sidecar down'));
    const event: CaptureEvent = {
      ...makeEvent('Learning: Admin dashboard scaffold'),
      kind: 'learning',
      tags: ['agent', 'mission', 'learning', 'mission:m-53'],
    };

    enqueueCaptureRetry(event, transport);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(emitBuffered).toHaveBeenCalledTimes(1);
    expect(emitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'brain.capture_failed',
        missionId: 'm-53',
        actor: 'system',
        payload: { kind: 'learning' },
      }),
    );
  });

  it('leaves missionId undefined for a non-mission capture (no mission:<id> tag)', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('sidecar down'));
    enqueueCaptureRetry(makeEvent('Edit: bar.ts'), transport);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(emitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'brain.capture_failed', missionId: undefined, payload: { kind: 'edit' } }),
    );
  });

  it('getLastCaptureFailure() is null until a give-up occurs, then reflects it', async () => {
    expect(getLastCaptureFailure()).toBeNull();

    const transport: CaptureTransport = vi.fn().mockRejectedValue(new Error('sidecar down'));
    enqueueCaptureRetry(makeEvent('Edit: bar.ts'), transport);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(getLastCaptureFailure()).toMatchObject({ kind: 'edit', missionId: undefined });
  });

  it('does not emit brain.capture_failed for a benign "already exists" conflict', async () => {
    const transport: CaptureTransport = vi.fn().mockRejectedValue(
      new Error('Note already exists: /mock/foo.html. Pass overwrite to replace.'),
    );

    enqueueCaptureRetry(makeEvent(), transport);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(emitBuffered).not.toHaveBeenCalled();
    expect(getLastCaptureFailure()).toBeNull();
  });
});

describe('captureQueue — enqueueCaptureRetry never throws', () => {
  it('swallows a transport that throws synchronously instead of rejecting', async () => {
    const transport: CaptureTransport = vi.fn(() => {
      throw new Error('synchronous boom');
    });

    expect(() => enqueueCaptureRetry(makeEvent(), transport)).not.toThrow();
    // The synchronous throw surfaces as a rejection of the async runAttempt()
    // call — let it settle before asserting no unhandled state remains.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getCaptureRetryQueueSize()).toBe(0);
  });
});
