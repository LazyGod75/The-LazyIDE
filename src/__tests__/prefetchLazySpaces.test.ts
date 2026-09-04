import { describe, it, expect, vi, afterEach } from 'vitest';
import { scheduleLazySpacePrefetch } from '../components/prefetchLazySpaces';

describe('scheduleLazySpacePrefetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses requestIdleCallback when available and cancel drops the callback', () => {
    const load = vi.fn();
    let savedCb: (() => void) | undefined;
    const ric = vi.fn((cb: () => void) => {
      savedCb = cb;
      return 7;
    });
    const cancel = vi.fn();
    vi.stubGlobal('requestIdleCallback', ric);
    vi.stubGlobal('cancelIdleCallback', cancel);

    const stop = scheduleLazySpacePrefetch(load);
    expect(ric).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    savedCb?.();
    expect(load).toHaveBeenCalledOnce();
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('falls back to setTimeout when requestIdleCallback is missing', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const load = vi.fn();
    const stop = scheduleLazySpacePrefetch(load);
    expect(load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(load).toHaveBeenCalledOnce();
    stop();
    vi.useRealTimers();
  });
});
