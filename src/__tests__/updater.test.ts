/**
 * updater.test.ts
 *
 * Full rewrite for the staged-update architecture (AUTOUPDATE-SPEC.md):
 * src/lib/updater.ts no longer imports @tauri-apps/plugin-updater or
 * @tauri-apps/plugin-process at all — every exported function is a thin
 * invoke()/listen() wrapper around the Rust-side updater_* commands and the
 * two updater:// events. These tests drive exactly that IPC contract
 * (command names, argument shapes, event names/payloads) using the global
 * @tauri-apps/api/core and @tauri-apps/api/event mocks already installed by
 * src/__tests__/setup.ts, plus the isTauri() no-op contract in web mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  checkForUpdate,
  downloadUpdate,
  getUpdaterState,
  setAutoUpdate,
  ignoreUpdateVersion,
  clearStagedUpdate,
  restartAndApplyUpdate,
  onDownloadProgress,
  onStaged,
  type UpdaterCheckResult,
  type UpdaterStateInfo,
} from '../lib/updater';

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

/** Toggles `window.__TAURI_INTERNALS__` — same convention systemPressure.
 *  test.ts / runtimeDispatch.test.ts already use. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  vi.clearAllMocks();
  setTauriRuntime(false);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('web mode (isTauri() === false) — every function is a safe no-op', () => {
  it('checkForUpdate resolves null and never calls invoke', async () => {
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('downloadUpdate resolves null and never calls invoke', async () => {
    await expect(downloadUpdate()).resolves.toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('getUpdaterState resolves null and never calls invoke', async () => {
    await expect(getUpdaterState()).resolves.toBeNull();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('setAutoUpdate resolves without calling invoke', async () => {
    await expect(setAutoUpdate(false)).resolves.toBeUndefined();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('ignoreUpdateVersion resolves without calling invoke', async () => {
    await expect(ignoreUpdateVersion('0.1.12')).resolves.toBeUndefined();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('clearStagedUpdate resolves without calling invoke', async () => {
    await expect(clearStagedUpdate()).resolves.toBeUndefined();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('restartAndApplyUpdate resolves without calling invoke', async () => {
    await expect(restartAndApplyUpdate()).resolves.toBeUndefined();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('onDownloadProgress resolves a harmless unlisten function and never calls listen', async () => {
    const handler = vi.fn();
    const unlisten = await onDownloadProgress(handler);

    expect(mockedListen).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('onStaged resolves a harmless unlisten function and never calls listen', async () => {
    const handler = vi.fn();
    const unlisten = await onStaged(handler);

    expect(mockedListen).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('tauri mode (isTauri() === true) — commands', () => {
  beforeEach(() => {
    setTauriRuntime(true);
  });

  it('checkForUpdate invokes updater_check with no args and returns the typed result', async () => {
    const result: UpdaterCheckResult = { status: 'available', version: '0.1.12', notes: 'Bug fixes', pubDate: '2026-07-25T00:00:00Z' };
    mockedInvoke.mockResolvedValueOnce(result);

    await expect(checkForUpdate()).resolves.toEqual(result);
    expect(mockedInvoke).toHaveBeenCalledWith('updater_check');
  });

  it('downloadUpdate invokes updater_download with no args and returns the version', async () => {
    mockedInvoke.mockResolvedValueOnce({ version: '0.1.12' });

    await expect(downloadUpdate()).resolves.toEqual({ version: '0.1.12' });
    expect(mockedInvoke).toHaveBeenCalledWith('updater_download');
  });

  it('downloadUpdate propagates a rejection when there is nothing to download', async () => {
    mockedInvoke.mockRejectedValueOnce(new Error('nothing to download'));

    await expect(downloadUpdate()).rejects.toThrow('nothing to download');
  });

  it('getUpdaterState invokes updater_state and returns the full snapshot shape', async () => {
    const state: UpdaterStateInfo = {
      currentVersion: '0.1.11',
      autoUpdate: true,
      staged: { version: '0.1.12', notes: 'Bug fixes' },
      lastCheckAt: '2026-07-25T10:00:00Z',
      ignoredVersion: null,
      lastError: null,
      updateApplied: null,
    };
    mockedInvoke.mockResolvedValueOnce(state);

    await expect(getUpdaterState()).resolves.toEqual(state);
    expect(mockedInvoke).toHaveBeenCalledWith('updater_state');
  });

  it('setAutoUpdate invokes updater_set_auto with { enabled }', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);

    await setAutoUpdate(false);

    expect(mockedInvoke).toHaveBeenCalledWith('updater_set_auto', { enabled: false });
  });

  it('ignoreUpdateVersion invokes updater_ignore_version with { version }', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);

    await ignoreUpdateVersion('0.1.12');

    expect(mockedInvoke).toHaveBeenCalledWith('updater_ignore_version', { version: '0.1.12' });
  });

  it('clearStagedUpdate invokes updater_clear_staged with no args', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);

    await clearStagedUpdate();

    expect(mockedInvoke).toHaveBeenCalledWith('updater_clear_staged');
  });

  it('restartAndApplyUpdate invokes updater_restart_and_apply with no args', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);

    await restartAndApplyUpdate();

    expect(mockedInvoke).toHaveBeenCalledWith('updater_restart_and_apply');
  });
});

describe('tauri mode (isTauri() === true) — events', () => {
  beforeEach(() => {
    setTauriRuntime(true);
  });

  it('onDownloadProgress subscribes to updater://download-progress and maps event.payload through to the handler', async () => {
    let captured: ((event: { payload: unknown }) => void) | undefined;
    mockedListen.mockImplementation(async (name, cb) => {
      expect(name).toBe('updater://download-progress');
      captured = cb as (event: { payload: unknown }) => void;
      return () => undefined;
    });

    const handler = vi.fn();
    await onDownloadProgress(handler);

    captured?.({ payload: { downloaded: 512, total: 2048 } });

    expect(handler).toHaveBeenCalledWith({ downloaded: 512, total: 2048 });
  });

  it('onStaged subscribes to updater://staged and maps event.payload through to the handler', async () => {
    let captured: ((event: { payload: unknown }) => void) | undefined;
    mockedListen.mockImplementation(async (name, cb) => {
      expect(name).toBe('updater://staged');
      captured = cb as (event: { payload: unknown }) => void;
      return () => undefined;
    });

    const handler = vi.fn();
    await onStaged(handler);

    captured?.({ payload: { version: '0.1.12' } });

    expect(handler).toHaveBeenCalledWith({ version: '0.1.12' });
  });

  it('onDownloadProgress returns the real unlisten function listen() resolved', async () => {
    const realUnlisten = vi.fn();
    mockedListen.mockResolvedValueOnce(realUnlisten);

    const unlisten = await onDownloadProgress(vi.fn());
    unlisten();

    expect(realUnlisten).toHaveBeenCalledTimes(1);
  });
});
