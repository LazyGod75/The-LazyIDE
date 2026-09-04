/**
 * openExternal.test.ts
 *
 * Regression test for the "Passer à Pro does nothing" bug:
 *   - @tauri-apps/plugin-shell is marked `external` in vite.config.ts, so
 *     `await import('@tauri-apps/plugin-shell')` throws in the packaged app
 *     (bare specifier, unresolved by the webview) and silently fell back to
 *     window.open, which WebView2 does not escalate to the system browser.
 *   - The fix invokes the shell plugin command directly via
 *     @tauri-apps/api/core's invoke(), which is NOT externalized and is
 *     proven to bundle/work in the packaged app.
 *
 * @tauri-apps/api/core is globally mocked in src/__tests__/setup.ts
 * (invoke: vi.fn().mockResolvedValue(undefined)), and window.__TAURI_INTERNALS__
 * is deleted before each test file so isTauri() defaults to false (web mode).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openExternal } from '../lib/platform/openExternal';

const mockInvoke = vi.mocked(invoke);

function setTauriMode(enabled: boolean): void {
  const win = window as unknown as Record<string, unknown>;
  if (enabled) {
    win['__TAURI_INTERNALS__'] = {};
  } else {
    delete win['__TAURI_INTERNALS__'];
  }
}

describe('openExternal', () => {
  const originalWindowOpen = window.open;
  let windowOpenSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    windowOpenSpy = vi.fn();
    window.open = windowOpenSpy as unknown as typeof window.open;
  });

  afterEach(() => {
    setTauriMode(false);
    window.open = originalWindowOpen;
  });

  describe('web mode (isTauri() === false)', () => {
    it('falls back to window.open and never calls invoke', async () => {
      await openExternal('https://lazy.app/en/terms');

      expect(windowOpenSpy).toHaveBeenCalledWith(
        'https://lazy.app/en/terms',
        '_blank',
        'noopener,noreferrer',
      );
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe('tauri mode (isTauri() === true)', () => {
    beforeEach(() => {
      setTauriMode(true);
    });

    it('invokes plugin:shell|open with { path: url } instead of window.open', async () => {
      const stripeUrl = 'https://checkout.stripe.com/c/pay/cs_live_abc123';

      await openExternal(stripeUrl);

      expect(mockInvoke).toHaveBeenCalledWith('plugin:shell|open', { path: stripeUrl });
      expect(windowOpenSpy).not.toHaveBeenCalled();
    });

    it('throws instead of silently falling back to window.open when invoke fails', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('shell scope validation failed'));

      await expect(openExternal('https://lazy.app/pro')).rejects.toThrow(
        /shell plugin failed to open/,
      );
      expect(windowOpenSpy).not.toHaveBeenCalled();
    });
  });
});
