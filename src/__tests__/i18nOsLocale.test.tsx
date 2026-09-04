/**
 * i18nOsLocale.test.tsx
 *
 * Regression test for the same "externalized-but-dynamically-imported" bug
 * class fixed by openExternal.test.ts (see src/__tests__/openExternal.test.ts),
 * applied to @tauri-apps/plugin-os:
 *   - @tauri-apps/plugin-os used to be marked `external` in vite.config.ts, so
 *     `await import('@tauri-apps/plugin-os')` inside fetchOsLocale() threw in
 *     the packaged app (bare specifier, unresolved by the webview). The throw
 *     was caught and silently swallowed, so first-run OS-locale detection
 *     always fell back to navigator.language, even when it disagreed with the
 *     real OS setting.
 *   - Fixed by removing plugin-os from vite.config.ts's external array so
 *     Vite bundles its thin invoke() wrapper (see node_modules/@tauri-apps/
 *     plugin-os/dist-js/index.js — it does nothing but
 *     `invoke('plugin:os|locale')`). No change was needed to the dynamic
 *     import itself, only to how it's bundled.
 *
 * Whether Rollup actually leaves the specifier unresolved in dist/assets/*.js
 * is a build-output fact, not something a unit test can observe (Vitest never
 * runs through Rollup's build) — that half is verified separately with a real
 * `npm run build` + grep. This test instead locks down fetchOsLocale's own
 * call-and-fallback contract: it calls plugin-os's locale() exactly as the
 * packaged app would, correctly maps the result onto a supported Locale, and
 * — the actual regression this test guards — logs (never silently swallows)
 * a genuine failure instead of vanishing it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@tauri-apps/plugin-os', () => ({
  locale: vi.fn(),
}));

import { locale } from '@tauri-apps/plugin-os';
import { I18nProvider, useI18n } from '../i18n';

const mockLocale = vi.mocked(locale);

function setTauriMode(enabled: boolean): void {
  const win = window as unknown as Record<string, unknown>;
  if (enabled) {
    win['__TAURI_INTERNALS__'] = {};
  } else {
    delete win['__TAURI_INTERNALS__'];
  }
}

function LocaleProbe() {
  const { locale: current } = useI18n();
  return <div data-testid="locale">{current}</div>;
}

describe('I18nProvider OS locale detection (plugin-os dynamic import)', () => {
  beforeEach(() => {
    mockLocale.mockReset();
    try {
      window.localStorage.clear();
    } catch {
      /* jsdom always provides localStorage */
    }
  });

  afterEach(() => {
    setTauriMode(false);
  });

  it('web mode: never calls plugin-os, resolves via the navigator.language fallback', async () => {
    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('locale').textContent).toBeTruthy());
    expect(mockLocale).not.toHaveBeenCalled();
  });

  it('tauri mode: resolves the dynamic import and applies the OS locale from plugin-os', async () => {
    setTauriMode(true);
    mockLocale.mockResolvedValueOnce('de-DE');

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('de');
    });
    expect(mockLocale).toHaveBeenCalledTimes(1);
  });

  it('tauri mode: logs instead of silently swallowing when the os plugin fails', async () => {
    setTauriMode(true);
    mockLocale.mockRejectedValueOnce(new Error('os plugin scope validation failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <I18nProvider>
        <LocaleProbe />
      </I18nProvider>,
    );

    await waitFor(() => expect(mockLocale).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(String(warnSpy.mock.calls[0][0])).toContain('[i18n] OS locale detection failed');

    warnSpy.mockRestore();
  });
});
