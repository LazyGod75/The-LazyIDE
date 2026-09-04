import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scheduleSidecarReloadAfterStore,
  SIDECAR_RELOAD_DEBOUNCE_MS,
  _resetSidecarReloadForTests,
  _setSidecarReloadImplForTests,
} from '../lib/agents/sidecarReload';

describe('scheduleSidecarReloadAfterStore (B41)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSidecarReloadForTests();
  });

  afterEach(() => {
    _resetSidecarReloadForTests();
    vi.useRealTimers();
  });

  it('debounces burst store writes into a single sidecar reload', async () => {
    const reload = vi.fn().mockResolvedValue(true);
    _setSidecarReloadImplForTests(reload);

    scheduleSidecarReloadAfterStore();
    scheduleSidecarReloadAfterStore();
    scheduleSidecarReloadAfterStore();
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SIDECAR_RELOAD_DEBOUNCE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never throws when reload rejects', async () => {
    const reload = vi.fn().mockRejectedValue(new Error('sidecar down'));
    _setSidecarReloadImplForTests(reload);
    scheduleSidecarReloadAfterStore();
    await vi.advanceTimersByTimeAsync(SIDECAR_RELOAD_DEBOUNCE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
