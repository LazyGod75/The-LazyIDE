import { describe, it, expect, vi } from 'vitest';
import { armAbortListener, isNativeStopRequested } from '../lib/agents/nativeAbort';

describe('isNativeStopRequested', () => {
  it('is false when neither stop nor abort fired', () => {
    expect(isNativeStopRequested(() => false)).toBe(false);
    expect(isNativeStopRequested(() => false, new AbortController().signal)).toBe(false);
  });

  it('honours stopSignal even without an AbortSignal', () => {
    expect(isNativeStopRequested(() => true)).toBe(true);
  });

  it('honours an already-aborted AbortSignal', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(isNativeStopRequested(() => false, ctrl.signal)).toBe(true);
  });
});

describe('armAbortListener', () => {
  it('fires immediately when the signal is already aborted', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const onAbort = vi.fn();
    const disarm = armAbortListener(ctrl.signal, onAbort);
    expect(onAbort).toHaveBeenCalledTimes(1);
    disarm();
  });

  it('fires once when abort happens later', () => {
    const ctrl = new AbortController();
    const onAbort = vi.fn();
    const disarm = armAbortListener(ctrl.signal, onAbort);
    expect(onAbort).not.toHaveBeenCalled();
    ctrl.abort();
    expect(onAbort).toHaveBeenCalledTimes(1);
    disarm();
  });

  it('is a no-op without a signal', () => {
    const onAbort = vi.fn();
    const disarm = armAbortListener(undefined, onAbort);
    expect(onAbort).not.toHaveBeenCalled();
    disarm();
  });
});
