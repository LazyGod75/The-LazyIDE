/**
 * crashReporter.test.ts — pure dedupe/rate-limit decision logic
 * (shouldReport) plus a jsdom-level integration check that the real
 * window.onerror / unhandledrejection listeners installed by
 * installCrashReporter() funnel through that same logic and deliver via
 * invoke('journal_frontend_error', ...) exactly once per accepted report.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  shouldReport,
  createEmptyCrashHistory,
  installCrashReporter,
  resetCrashReporterForTests,
  reportReactBoundaryError,
  shouldFilterBenignError,
  DEDUPE_WINDOW_MS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  type CrashRecord,
} from '../lib/crashReporter';

// @tauri-apps/api/core is globally mocked (src/__tests__/setup.ts).
const mockedInvoke = vi.mocked(invoke);

/** Toggles `window.__TAURI_INTERNALS__` — same convention updater.test.ts /
 *  systemPressure.test.ts already use for simulating isTauri() === true. */
function setTauriMode(enabled: boolean): void {
  const win = window as unknown as Record<string, unknown>;
  if (enabled) win['__TAURI_INTERNALS__'] = {};
  else delete win['__TAURI_INTERNALS__'];
}

function record(message: string, source: CrashRecord['source'] = 'window.onerror'): CrashRecord {
  return { level: 'error', message, stack: `Error: ${message}\n  at fn (a.ts:1:1)`, source };
}

// ── Pure logic ───────────────────────────────────────────────────────

describe('shouldFilterBenignError', () => {
  it('filters ResizeObserver loop completed with undelivered notifications', () => {
    const message = 'ResizeObserver loop completed with undelivered notifications.';
    expect(shouldFilterBenignError(message)).toBe(true);
  });

  it('filters ResizeObserver loop limit exceeded', () => {
    const message = 'ResizeObserver loop limit exceeded';
    expect(shouldFilterBenignError(message)).toBe(true);
  });

  it('matches ResizeObserver messages as substrings (partial match)', () => {
    const message = 'Some prefix ResizeObserver loop completed with undelivered notifications. suffix';
    expect(shouldFilterBenignError(message)).toBe(true);
  });

  it('does not filter unrelated error messages', () => {
    expect(shouldFilterBenignError('boom')).toBe(false);
    expect(shouldFilterBenignError('TypeError: Cannot read properties')).toBe(false);
    expect(shouldFilterBenignError('Network error')).toBe(false);
  });

  it('does not filter messages that merely contain "Resize" but are not ResizeObserver warnings', () => {
    expect(shouldFilterBenignError('Window resize event failed')).toBe(false);
  });
});

describe('shouldReport', () => {
  it('accepts the first occurrence of a signature', () => {
    const result = shouldReport(record('boom'), createEmptyCrashHistory(), 1000);
    expect(result.report).toBe(true);
    expect(Array.from(result.nextState.recent.values())).toEqual([1000]);
    expect(result.nextState.windowTimestamps).toEqual([1000]);
  });

  it('drops an identical message+stack within the dedupe window', () => {
    const first = shouldReport(record('boom'), createEmptyCrashHistory(), 1000);
    const second = shouldReport(record('boom'), first.nextState, 1000 + DEDUPE_WINDOW_MS - 1);
    expect(second.report).toBe(false);
    // Unchanged state: a suppressed duplicate never resets the dedupe anchor.
    expect(second.nextState).toBe(first.nextState);
  });

  it('accepts again once the dedupe window has fully elapsed', () => {
    const first = shouldReport(record('boom'), createEmptyCrashHistory(), 1000);
    const second = shouldReport(record('boom'), first.nextState, 1000 + DEDUPE_WINDOW_MS);
    expect(second.report).toBe(true);
  });

  it('does not dedupe two different messages', () => {
    const first = shouldReport(record('boom-a'), createEmptyCrashHistory(), 1000);
    const second = shouldReport(record('boom-b'), first.nextState, 1000);
    expect(second.report).toBe(true);
  });

  it('does not dedupe the same message with a different stack', () => {
    const a: CrashRecord = { level: 'error', message: 'boom', stack: 'stack-a', source: 'window.onerror' };
    const b: CrashRecord = { level: 'error', message: 'boom', stack: 'stack-b', source: 'window.onerror' };
    const first = shouldReport(a, createEmptyCrashHistory(), 1000);
    const second = shouldReport(b, first.nextState, 1000);
    expect(second.report).toBe(true);
  });

  it('caps at RATE_LIMIT_MAX accepted reports within the sliding window', () => {
    let state = createEmptyCrashHistory();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const result = shouldReport(record(`err-${i}`), state, 1000 + i);
      expect(result.report).toBe(true);
      state = result.nextState;
    }
    // The (RATE_LIMIT_MAX + 1)th DISTINCT message is rejected purely by the
    // global cap — dedupe alone would never have caught it.
    const overflow = shouldReport(record('err-overflow'), state, 1000 + RATE_LIMIT_MAX);
    expect(overflow.report).toBe(false);
  });

  it('a rate-limited signature is still eligible later once the window has room', () => {
    let state = createEmptyCrashHistory();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      state = shouldReport(record(`err-${i}`), state, 1000 + i).nextState;
    }
    const rejected = shouldReport(record('err-late'), state, 1000 + RATE_LIMIT_MAX);
    expect(rejected.report).toBe(false);
    state = rejected.nextState;

    // Once the window slides fully past the original 20 timestamps, room
    // reopens and the SAME signature that was just rejected is accepted.
    const accepted = shouldReport(record('err-late'), state, 1000 + RATE_LIMIT_WINDOW_MS + 1);
    expect(accepted.report).toBe(true);
  });
});

// ── window.onerror / unhandledrejection integration ─────────────────

describe('installCrashReporter (jsdom integration)', () => {
  beforeEach(() => {
    resetCrashReporterForTests();
    setTauriMode(true);
    mockedInvoke.mockClear();
    mockedInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetCrashReporterForTests();
    setTauriMode(false);
  });

  it('reports exactly once via invoke on a window error event', async () => {
    installCrashReporter();

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));

    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1));
    expect(mockedInvoke).toHaveBeenCalledWith('journal_frontend_error', expect.objectContaining({
      level: 'error',
      message: 'boom',
      source: 'window.onerror',
    }));
  });

  it('suppresses an identical duplicate error event', async () => {
    installCrashReporter();
    // Same Error instance reused for both dispatches — a fresh `new
    // Error('boom')` per call would carry a DIFFERENT `.stack` (distinct
    // call-site line/col), which is a legitimately different signature and
    // would defeat the point of this test (real-world identical repeats
    // come from the SAME throwing code path, hence the same stack).
    const err = new Error('boom');

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: err }));
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: err }));
    // Give any (incorrect) second delivery a turn to happen before asserting
    // the count never grew.
    await Promise.resolve();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it('reports an unhandled promise rejection', async () => {
    installCrashReporter();

    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new Error('rejected-boom'), configurable: true });
    window.dispatchEvent(event);

    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1));
    expect(mockedInvoke).toHaveBeenCalledWith('journal_frontend_error', expect.objectContaining({
      message: 'rejected-boom',
      source: 'unhandledrejection',
    }));
  });

  it('silently filters benign ResizeObserver warnings and never invokes journal_frontend_error', async () => {
    installCrashReporter();

    // Dispatch a ResizeObserver warning — should be silently filtered, no invoke call.
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'ResizeObserver loop completed with undelivered notifications.',
      error: new Error('ResizeObserver loop completed with undelivered notifications.'),
    }));
    await Promise.resolve();

    expect(mockedInvoke).not.toHaveBeenCalled();

    // Dispatch a real error — should be invoked as normal.
    window.dispatchEvent(new ErrorEvent('error', { message: 'real-boom', error: new Error('real-boom') }));
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1));
    expect(mockedInvoke).toHaveBeenCalledWith('journal_frontend_error', expect.objectContaining({
      message: 'real-boom',
    }));
  });

  it('never calls invoke outside a Tauri context', async () => {
    setTauriMode(false);
    installCrashReporter();

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));
    await Promise.resolve();

    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('logs the command-unavailable case exactly once per session, never throws', async () => {
    mockedInvoke.mockRejectedValue(new Error('command not found'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    installCrashReporter();

    window.dispatchEvent(new ErrorEvent('error', { message: 'boom-1', error: new Error('boom-1') }));
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom-2', error: new Error('boom-2') }));
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(2));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('[crashReporter]');
    errorSpy.mockRestore();
  });

  it('reportReactBoundaryError delivers through the same path with a react-boundary source', async () => {
    reportReactBoundaryError('RootErrorBoundary', new Error('render blew up'), 'in <Foo>');

    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledTimes(1));
    expect(mockedInvoke).toHaveBeenCalledWith('journal_frontend_error', expect.objectContaining({
      message: 'render blew up',
      source: 'react-boundary:RootErrorBoundary',
    }));
  });
});
