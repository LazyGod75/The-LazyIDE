/**
 * updateStore.test.ts
 *
 * src/lib/updateStore.ts is the single source of truth for auto-update UI
 * state (AUTOUPDATE-SPEC.md B.2): a dedup guard so two surfaces never fire a
 * concurrent check()/download(), the pure scheduling math the background
 * service (B.3, out of this file's scope — the component owns the actual
 * setTimeout calls) uses to arm its own timers, and the one piece of
 * UI-only persistence (toastShownFor). These tests mock src/lib/updater.ts
 * entirely (the store's only IO boundary) so every action here runs
 * deterministically, without a real Tauri runtime — the same convention
 * seedProgressStore.test.ts uses for its own IO boundary (getPlatform).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/updater', () => ({
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  getUpdaterState: vi.fn(),
  setAutoUpdate: vi.fn(),
  ignoreUpdateVersion: vi.fn(),
  restartAndApplyUpdate: vi.fn(),
  onDownloadProgress: vi.fn(),
  onStaged: vi.fn(),
}));

import {
  checkForUpdate,
  downloadUpdate,
  getUpdaterState,
  setAutoUpdate,
  ignoreUpdateVersion,
  restartAndApplyUpdate,
  onDownloadProgress,
  onStaged,
  type UpdaterCheckResult,
} from '../lib/updater';

import {
  getUpdateState,
  subscribeUpdateStore,
  useUpdateStore,
  check,
  download,
  restartAndApply,
  setAuto,
  ignoreVersion,
  hasShownStagedToast,
  markStagedToastShown,
  CHECK_INTERVAL_MS,
  CHECK_INTERVAL_JITTER_RATIO,
  ERROR_BACKOFF_BASE_MS,
  ERROR_BACKOFF_MULTIPLIER,
  ERROR_BACKOFF_MAX_MS,
  FOCUS_RECHECK_THRESHOLD_MS,
  jitteredCheckIntervalMs,
  errorBackoffDelayMs,
  nextCheckDelayMs,
  shouldRecheckOnFocus,
  _resetUpdateStoreForTests,
} from '../lib/updateStore';

const mockedCheckForUpdate = vi.mocked(checkForUpdate);
const mockedDownloadUpdate = vi.mocked(downloadUpdate);
const mockedGetUpdaterState = vi.mocked(getUpdaterState);
const mockedSetAutoUpdate = vi.mocked(setAutoUpdate);
const mockedIgnoreUpdateVersion = vi.mocked(ignoreUpdateVersion);
const mockedRestartAndApplyUpdate = vi.mocked(restartAndApplyUpdate);
const mockedOnDownloadProgress = vi.mocked(onDownloadProgress);
const mockedOnStaged = vi.mocked(onStaged);

/** Toggles `window.__TAURI_INTERNALS__` — same convention updater.test.ts /
 *  systemPressure.test.ts already use. Only needed for the hydration/event
 *  wiring tests below; every action test mocks '../lib/updater' directly,
 *  so it behaves the same regardless of this flag. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  _resetUpdateStoreForTests();
  vi.clearAllMocks();
  setTauriRuntime(false);
  // Sane defaults mirroring src/__tests__/setup.ts's global invoke/listen
  // defaults — individual tests override with mockResolvedValueOnce.
  mockedGetUpdaterState.mockResolvedValue(null);
  mockedOnDownloadProgress.mockResolvedValue(() => undefined);
  mockedOnStaged.mockResolvedValue(() => undefined);
});

afterEach(() => {
  _resetUpdateStoreForTests();
  setTauriRuntime(false);
  vi.useRealTimers();
});

// ── Initial state ────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts idle with autoUpdate on and no error streak', () => {
    const s = getUpdateState();
    expect(s.phase).toBe('idle');
    expect(s.autoUpdate).toBe(true);
    expect(s.lastCheckAt).toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.ignoredVersion).toBeNull();
    expect(s.errorStreak).toBe(0);
  });
});

// ── check() ──────────────────────────────────────────────────────────

describe('check()', () => {
  it('never fires two concurrent network checks — a second call while one is in flight awaits the same promise', async () => {
    let resolveCheck!: (v: UpdaterCheckResult) => void;
    mockedCheckForUpdate.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));

    const p1 = check();
    const p2 = check();
    expect(mockedCheckForUpdate).toHaveBeenCalledTimes(1);

    resolveCheck({ status: 'up-to-date' });
    await Promise.all([p1, p2]);

    expect(mockedCheckForUpdate).toHaveBeenCalledTimes(1);
  });

  it('fires a fresh network call once the previous check has settled', async () => {
    mockedCheckForUpdate.mockResolvedValue({ status: 'up-to-date' });

    await check();
    await check();

    expect(mockedCheckForUpdate).toHaveBeenCalledTimes(2);
  });

  it('maps status "up-to-date" to phase idle and clears version/notes/error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-25T10:00:00.000Z'));
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'up-to-date' });

    await check();

    const s = getUpdateState();
    expect(s.phase).toBe('idle');
    expect(s.version).toBeUndefined();
    expect(s.notes).toBeUndefined();
    expect(s.lastError).toBeNull();
    expect(s.errorStreak).toBe(0);
    expect(s.lastCheckAt).toBe('2026-07-25T10:00:00.000Z');
  });

  it('maps status "available" to phase available with version/notes', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'available', version: '0.1.12', notes: 'Bug fixes' });

    await check();

    const s = getUpdateState();
    expect(s.phase).toBe('available');
    expect(s.version).toBe('0.1.12');
    expect(s.notes).toBe('Bug fixes');
    expect(s.errorStreak).toBe(0);
  });

  it('maps status "error" to phase error, records the message, and increments errorStreak', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'error', message: 'network unreachable' });

    await check();

    const s = getUpdateState();
    expect(s.phase).toBe('error');
    expect(s.lastError).toBe('network unreachable');
    expect(s.errorStreak).toBe(1);
  });

  it('increments errorStreak again on a second consecutive failure', async () => {
    mockedCheckForUpdate.mockResolvedValue({ status: 'error', message: 'network unreachable' });

    await check();
    await check();

    expect(getUpdateState().errorStreak).toBe(2);
  });

  it('a thrown/rejected checkForUpdate is caught and mapped to phase error, never thrown to the caller', async () => {
    mockedCheckForUpdate.mockRejectedValueOnce(new Error('boom'));

    await expect(check()).resolves.toBeUndefined();

    const s = getUpdateState();
    expect(s.phase).toBe('error');
    expect(s.lastError).toBe('boom');
    expect(s.errorStreak).toBe(1);
  });

  it('a successful check resets an existing error streak back to 0', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'error', message: 'boom' });
    await check();
    expect(getUpdateState().errorStreak).toBe(1);

    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'up-to-date' });
    await check();

    expect(getUpdateState().errorStreak).toBe(0);
  });

  it('resolving null (outside Tauri) returns to idle instead of hanging on "checking"', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce(null);

    await check();

    expect(getUpdateState().phase).toBe('idle');
  });
});

// ── download() ───────────────────────────────────────────────────────

describe('download()', () => {
  it('never fires two concurrent downloads', async () => {
    let resolveDownload!: (v: { version: string }) => void;
    mockedDownloadUpdate.mockImplementation(() => new Promise((resolve) => { resolveDownload = resolve; }));

    const p1 = download();
    const p2 = download();
    expect(mockedDownloadUpdate).toHaveBeenCalledTimes(1);

    resolveDownload({ version: '0.1.12' });
    await Promise.all([p1, p2]);

    expect(mockedDownloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('sets phase to staged with the returned version on success and resets the error streak', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'error', message: 'boom' });
    await check();
    expect(getUpdateState().errorStreak).toBe(1);

    mockedDownloadUpdate.mockResolvedValueOnce({ version: '0.1.12' });
    await download();

    const s = getUpdateState();
    expect(s.phase).toBe('staged');
    expect(s.version).toBe('0.1.12');
    expect(s.errorStreak).toBe(0);
    expect(s.lastError).toBeNull();
  });

  it('maps a rejection to phase error and increments errorStreak', async () => {
    mockedDownloadUpdate.mockRejectedValueOnce(new Error('disk full'));

    await download();

    const s = getUpdateState();
    expect(s.phase).toBe('error');
    expect(s.lastError).toBe('disk full');
    expect(s.errorStreak).toBe(1);
  });

  it('resolving null (outside Tauri) returns to idle', async () => {
    mockedDownloadUpdate.mockResolvedValueOnce(null);

    await download();

    expect(getUpdateState().phase).toBe('idle');
  });
});

// ── restartAndApply() ────────────────────────────────────────────────

describe('restartAndApply()', () => {
  it('calls restartAndApplyUpdate once and does not throw on success', async () => {
    mockedRestartAndApplyUpdate.mockResolvedValueOnce(undefined);

    await expect(restartAndApply()).resolves.toBeUndefined();
    expect(mockedRestartAndApplyUpdate).toHaveBeenCalledTimes(1);
  });

  it('a failure is caught and surfaced as lastError, never thrown — the staged update remains applyable on manual restart', async () => {
    mockedRestartAndApplyUpdate.mockRejectedValueOnce(new Error('restart denied'));

    await expect(restartAndApply()).resolves.toBeUndefined();
    expect(getUpdateState().lastError).toBe('restart denied');
  });
});

// ── setAuto() ────────────────────────────────────────────────────────

describe('setAuto()', () => {
  it('flips autoUpdate optimistically before the IPC call settles', async () => {
    let resolveSet!: () => void;
    mockedSetAutoUpdate.mockImplementation(() => new Promise((resolve) => { resolveSet = resolve; }));

    const promise = setAuto(false);
    expect(getUpdateState().autoUpdate).toBe(false); // optimistic, synchronous

    resolveSet();
    await promise;

    expect(mockedSetAutoUpdate).toHaveBeenCalledWith(false);
    expect(getUpdateState().autoUpdate).toBe(false);
  });

  it('rolls back to the previous value and records lastError on failure', async () => {
    mockedSetAutoUpdate.mockRejectedValueOnce(new Error('write failed'));

    await setAuto(false);

    const s = getUpdateState();
    expect(s.autoUpdate).toBe(true); // rolled back to the initial default
    expect(s.lastError).toBe('write failed');
  });
});

// ── ignoreVersion() ──────────────────────────────────────────────────

describe('ignoreVersion()', () => {
  it('records the ignored version and calls the IPC command', async () => {
    mockedIgnoreUpdateVersion.mockResolvedValueOnce(undefined);

    await ignoreVersion('0.1.12');

    expect(getUpdateState().ignoredVersion).toBe('0.1.12');
    expect(mockedIgnoreUpdateVersion).toHaveBeenCalledWith('0.1.12');
  });

  it('clears the currently available version from view when it matches the ignored one', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'available', version: '0.1.12', notes: 'x' });
    await check();
    expect(getUpdateState().phase).toBe('available');

    mockedIgnoreUpdateVersion.mockResolvedValueOnce(undefined);
    await ignoreVersion('0.1.12');

    const s = getUpdateState();
    expect(s.phase).toBe('idle');
    expect(s.version).toBeUndefined();
  });

  it('does not touch an unrelated available version', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'available', version: '0.1.12', notes: 'x' });
    await check();

    mockedIgnoreUpdateVersion.mockResolvedValueOnce(undefined);
    await ignoreVersion('0.1.10'); // an older version, not the one showing

    const s = getUpdateState();
    expect(s.phase).toBe('available');
    expect(s.version).toBe('0.1.12');
    expect(s.ignoredVersion).toBe('0.1.10');
  });

  it('a failure records lastError but keeps the local dismissal', async () => {
    mockedIgnoreUpdateVersion.mockRejectedValueOnce(new Error('write failed'));

    await ignoreVersion('0.1.12');

    const s = getUpdateState();
    expect(s.ignoredVersion).toBe('0.1.12');
    expect(s.lastError).toBe('write failed');
  });
});

// ── toast-shown-once localStorage persistence ───────────────────────

describe('hasShownStagedToast / markStagedToastShown', () => {
  it('is false before any toast has been shown', () => {
    expect(hasShownStagedToast('0.1.12')).toBe(false);
  });

  it('is true for the exact version marked shown', () => {
    markStagedToastShown('0.1.12');
    expect(hasShownStagedToast('0.1.12')).toBe(true);
  });

  it('is false for a different version, even after marking another one shown', () => {
    markStagedToastShown('0.1.12');
    expect(hasShownStagedToast('0.1.13')).toBe(false);
  });

  it('only remembers the single most recent version', () => {
    markStagedToastShown('0.1.12');
    markStagedToastShown('0.1.13');
    expect(hasShownStagedToast('0.1.12')).toBe(false);
    expect(hasShownStagedToast('0.1.13')).toBe(true);
  });
});

// ── Pure scheduling functions (AUTOUPDATE-SPEC.md B.3) ─────────────────

describe('jitteredCheckIntervalMs — 4h +/- 25% jitter', () => {
  it('stays within [-25%, +25%] of the base interval for a wide range of timestamps', () => {
    const min = CHECK_INTERVAL_MS * (1 - CHECK_INTERVAL_JITTER_RATIO);
    const max = CHECK_INTERVAL_MS * (1 + CHECK_INTERVAL_JITTER_RATIO);

    for (let now = 0; now < 5_000; now += 37) {
      const delay = jitteredCheckIntervalMs(now);
      expect(delay).toBeGreaterThanOrEqual(min);
      expect(delay).toBeLessThanOrEqual(max);
    }
  });

  it('is a pure, deterministic function of `now` — same input always returns the same delay', () => {
    expect(jitteredCheckIntervalMs(1_753_000_000_000)).toBe(jitteredCheckIntervalMs(1_753_000_000_000));
  });

  it('actually varies across different timestamps (not a constant)', () => {
    const samples = new Set<number>();
    for (let now = 0; now < 20; now++) samples.add(jitteredCheckIntervalMs(now * 104_729));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('errorBackoffDelayMs — 15min, doubling, capped at 4h', () => {
  it('follows the 15/30/60/120/240min schedule', () => {
    expect(errorBackoffDelayMs(1)).toBe(15 * 60 * 1000);
    expect(errorBackoffDelayMs(2)).toBe(30 * 60 * 1000);
    expect(errorBackoffDelayMs(3)).toBe(60 * 60 * 1000);
    expect(errorBackoffDelayMs(4)).toBe(120 * 60 * 1000);
    expect(errorBackoffDelayMs(5)).toBe(240 * 60 * 1000);
  });

  it('caps at 4h (ERROR_BACKOFF_MAX_MS) and never exceeds it for a long streak', () => {
    expect(errorBackoffDelayMs(6)).toBe(ERROR_BACKOFF_MAX_MS);
    expect(errorBackoffDelayMs(50)).toBe(ERROR_BACKOFF_MAX_MS);
  });

  it('clamps a zero or negative streak up to the first retry delay', () => {
    expect(errorBackoffDelayMs(0)).toBe(ERROR_BACKOFF_BASE_MS);
    expect(errorBackoffDelayMs(-4)).toBe(ERROR_BACKOFF_BASE_MS);
  });

  it('the constants themselves match the spec (15min base, x2 multiplier, 4h cap)', () => {
    expect(ERROR_BACKOFF_BASE_MS).toBe(15 * 60 * 1000);
    expect(ERROR_BACKOFF_MULTIPLIER).toBe(2);
    expect(ERROR_BACKOFF_MAX_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe('nextCheckDelayMs', () => {
  it('delegates to the jittered periodic interval when there is no error streak', () => {
    const now = 1_753_000_000_000;
    expect(nextCheckDelayMs({ errorStreak: 0 }, now)).toBe(jitteredCheckIntervalMs(now));
  });

  it('delegates to the error backoff schedule once a streak is active, ignoring jitter entirely', () => {
    const now = 1_753_000_000_000;
    expect(nextCheckDelayMs({ errorStreak: 3 }, now)).toBe(errorBackoffDelayMs(3));
  });
});

describe('shouldRecheckOnFocus — 2h threshold', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');

  it('is true when there has never been a check', () => {
    expect(shouldRecheckOnFocus(null, now)).toBe(true);
  });

  it('is false just under the 2h threshold', () => {
    const lastCheckAt = new Date(now - FOCUS_RECHECK_THRESHOLD_MS + 1).toISOString();
    expect(shouldRecheckOnFocus(lastCheckAt, now)).toBe(false);
  });

  it('is false exactly at the 2h threshold (strictly greater-than, not >=)', () => {
    const lastCheckAt = new Date(now - FOCUS_RECHECK_THRESHOLD_MS).toISOString();
    expect(shouldRecheckOnFocus(lastCheckAt, now)).toBe(false);
  });

  it('is true just over the 2h threshold', () => {
    const lastCheckAt = new Date(now - FOCUS_RECHECK_THRESHOLD_MS - 1).toISOString();
    expect(shouldRecheckOnFocus(lastCheckAt, now)).toBe(true);
  });

  it('is true for an unparsable lastCheckAt (defensive)', () => {
    expect(shouldRecheckOnFocus('not-a-date', now)).toBe(true);
  });
});

// ── Rust hydration + live events (Tauri mode only) ──────────────────

describe('hydration from Rust + updater:// events (isTauri() === true)', () => {
  beforeEach(() => {
    setTauriRuntime(true);
  });

  it('hydrates autoUpdate/lastCheckAt/ignoredVersion/staged from updater_state on first use', async () => {
    mockedGetUpdaterState.mockResolvedValueOnce({
      currentVersion: '0.1.11',
      autoUpdate: false,
      staged: { version: '0.1.12', notes: 'Bug fixes' },
      lastCheckAt: '2026-07-25T09:00:00.000Z',
      ignoredVersion: '0.1.10',
      lastError: null,
      updateApplied: null,
    });

    subscribeUpdateStore(() => {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const s = getUpdateState();
    expect(s.autoUpdate).toBe(false);
    expect(s.lastCheckAt).toBe('2026-07-25T09:00:00.000Z');
    expect(s.ignoredVersion).toBe('0.1.10');
    expect(s.phase).toBe('staged');
    expect(s.version).toBe('0.1.12');
    expect(s.notes).toBe('Bug fixes');
  });

  it('normalizes a wire-null staged.notes (Rust\'s StagedOut.notes: Option<String>) to undefined', async () => {
    mockedGetUpdaterState.mockResolvedValueOnce({
      currentVersion: '0.1.11',
      autoUpdate: true,
      staged: { version: '0.1.12', notes: null },
      lastCheckAt: null,
      ignoredVersion: null,
      lastError: null,
      updateApplied: null,
    });

    subscribeUpdateStore(() => {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const s = getUpdateState();
    expect(s.phase).toBe('staged');
    expect(s.version).toBe('0.1.12');
    expect(s.notes).toBeUndefined();
  });

  it('registers a download-progress listener whose events update phase/progress', async () => {
    let captured!: (event: { downloaded: number; total: number | null }) => void;
    mockedOnDownloadProgress.mockImplementation(async (handler) => {
      captured = handler;
      return () => undefined;
    });

    subscribeUpdateStore(() => {});
    await Promise.resolve();
    await Promise.resolve();

    captured({ downloaded: 1024, total: 4096 });

    const s = getUpdateState();
    expect(s.phase).toBe('downloading');
    expect(s.progress).toEqual({ downloaded: 1024, total: 4096 });
  });

  it('registers a staged listener whose events update phase/version and clear any error streak', async () => {
    let captured!: (event: { version: string }) => void;
    mockedOnStaged.mockImplementation(async (handler) => {
      captured = handler;
      return () => undefined;
    });
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'error', message: 'boom' });
    await check();
    expect(getUpdateState().errorStreak).toBe(1);

    subscribeUpdateStore(() => {});
    await Promise.resolve();
    await Promise.resolve();

    captured({ version: '0.1.12' });

    const s = getUpdateState();
    expect(s.phase).toBe('staged');
    expect(s.version).toBe('0.1.12');
    expect(s.errorStreak).toBe(0);
    expect(s.lastError).toBeNull();
  });
});

// ── useUpdateStore hook ──────────────────────────────────────────────

describe('useUpdateStore', () => {
  it('returns the current snapshot and re-renders when the store changes', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'available', version: '0.1.12', notes: 'x' });

    const { result } = renderHook(() => useUpdateStore());
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      await check();
    });

    expect(result.current.phase).toBe('available');
    expect(result.current.version).toBe('0.1.12');
  });

  // Locks in the combined state+actions shape SettingsSpace.tsx's
  // UpdateSection already consumes (`store.phase`, `store.check()`,
  // `store.download()`, `store.setAuto()`, `store.restartAndApply()`) —
  // NOT a bare state object requiring a second import for the actions.
  it('exposes the bound action methods on the same object as the state, and they drive the SAME shared store', async () => {
    mockedCheckForUpdate.mockResolvedValueOnce({ status: 'available', version: '0.1.12', notes: 'y' });
    mockedSetAutoUpdate.mockResolvedValueOnce(undefined);
    mockedRestartAndApplyUpdate.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useUpdateStore());
    expect(typeof result.current.check).toBe('function');
    expect(typeof result.current.download).toBe('function');
    expect(typeof result.current.setAuto).toBe('function');
    expect(typeof result.current.restartAndApply).toBe('function');
    expect(typeof result.current.ignoreVersion).toBe('function');

    await act(async () => {
      await result.current.check();
    });
    expect(result.current.phase).toBe('available');
    expect(result.current.version).toBe('0.1.12');

    await act(async () => {
      await result.current.setAuto(false);
    });
    expect(result.current.autoUpdate).toBe(false);
    expect(mockedSetAutoUpdate).toHaveBeenCalledWith(false);

    await act(async () => {
      await result.current.restartAndApply();
    });
    expect(mockedRestartAndApplyUpdate).toHaveBeenCalledTimes(1);
  });
});
