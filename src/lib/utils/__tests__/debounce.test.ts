import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import debounce from '../debounce';

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call fn before the delay has elapsed', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(99);

    expect(fn).not.toHaveBeenCalled();
  });

  it('calls fn once after delayMs of silence', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resets the delay on repeated calls, only firing after silence', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(99);

    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the latest call arguments to fn', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('first');
    debounced('second');
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('second');
  });

  it('does not mutate any shared/global state between independent debounced instances', () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    const debouncedA = debounce(fnA, 100);
    const debouncedB = debounce(fnB, 50);

    debouncedA();
    debouncedB();
    vi.advanceTimersByTime(50);

    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);

    expect(fnA).toHaveBeenCalledTimes(1);
  });
});
