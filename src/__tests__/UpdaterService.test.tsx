/**
 * UpdaterService.test.tsx
 *
 * Renamed from UpdaterStartupCheck.tsx (AUTOUPDATE-SPEC.md B.3): a full
 * background scheduler (20s initial delay, periodic recheck, focus recheck,
 * error backoff, autoUpdate-gated background download) plus a "staged"
 * toast shown once per version. The scheduling MATH itself
 * (jitter/backoff/focus-threshold) lives in src/lib/updateStore.ts as pure
 * functions and is covered by updateStore.test.ts — this suite only locks
 * down that UpdaterService calls into that contract correctly (right
 * arguments, right timing) and cleans up every timer/listener on unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../i18n', () => {
  const context = {
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  };
  return {
    useI18n: () => context,
    // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
    useI18nOptional: () => context,
  };
});

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

const { mockIsTauri } = vi.hoisted(() => ({ mockIsTauri: vi.fn(() => true) }));
vi.mock('../lib/platform', () => ({
  isTauri: mockIsTauri,
}));

const {
  mockUseUpdateStore,
  mockGetUpdateState,
  mockCheck,
  mockDownload,
  mockRestartAndApply,
  mockNextCheckDelayMs,
  mockShouldRecheckOnFocus,
  mockHasShownStagedToast,
  mockMarkStagedToastShown,
} = vi.hoisted(() => ({
  mockUseUpdateStore: vi.fn(),
  mockGetUpdateState: vi.fn(),
  mockCheck: vi.fn(),
  mockDownload: vi.fn(),
  mockRestartAndApply: vi.fn(),
  mockNextCheckDelayMs: vi.fn(),
  mockShouldRecheckOnFocus: vi.fn(),
  mockHasShownStagedToast: vi.fn(),
  mockMarkStagedToastShown: vi.fn(),
}));

vi.mock('../lib/updateStore', () => ({
  useUpdateStore: mockUseUpdateStore,
  getUpdateState: mockGetUpdateState,
  check: mockCheck,
  download: mockDownload,
  nextCheckDelayMs: mockNextCheckDelayMs,
  shouldRecheckOnFocus: mockShouldRecheckOnFocus,
  hasShownStagedToast: mockHasShownStagedToast,
  markStagedToastShown: mockMarkStagedToastShown,
}));

import { UpdaterService, _resetUpdaterServiceForTests } from '../components/updater/UpdaterService';

interface FakeState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'staged' | 'error';
  version?: string;
  notes?: string;
  autoUpdate: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  ignoredVersion: string | null;
  errorStreak: number;
}

const IDLE_STATE: FakeState = {
  phase: 'idle',
  autoUpdate: true,
  lastCheckAt: null,
  lastError: null,
  ignoredVersion: null,
  errorStreak: 0,
};

function setHookState(state: FakeState): void {
  mockUseUpdateStore.mockReturnValue({
    ...state,
    check: mockCheck,
    download: mockDownload,
    restartAndApply: mockRestartAndApply,
    setAuto: vi.fn(),
    ignoreVersion: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetUpdaterServiceForTests();
  mockIsTauri.mockReturnValue(true);
  mockCheck.mockResolvedValue(undefined);
  mockDownload.mockResolvedValue(undefined);
  mockGetUpdateState.mockReturnValue(IDLE_STATE);
  mockNextCheckDelayMs.mockReturnValue(60_000);
  mockShouldRecheckOnFocus.mockReturnValue(false);
  mockHasShownStagedToast.mockReturnValue(false);
  setHookState(IDLE_STATE);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UpdaterService — initial + periodic schedule', () => {
  it('does not check before the 20s initial delay elapses', async () => {
    vi.useFakeTimers();
    render(<UpdaterService />);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('checks exactly once at the 20s mark', async () => {
    vi.useFakeTimers();
    render(<UpdaterService />);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it('reschedules the next check using updateStore.nextCheckDelayMs(errorStreak)', async () => {
    vi.useFakeTimers();
    mockGetUpdateState.mockReturnValue({ ...IDLE_STATE, errorStreak: 2 });
    mockNextCheckDelayMs.mockReturnValue(5_000);

    render(<UpdaterService />);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(mockNextCheckDelayMs).toHaveBeenCalledWith({ errorStreak: 2 }, expect.any(Number));

    await vi.advanceTimersByTimeAsync(4_999);
    expect(mockCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  it('does nothing outside Tauri', async () => {
    vi.useFakeTimers();
    mockIsTauri.mockReturnValue(false);

    render(<UpdaterService />);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('the module-level guard prevents a second mount from scheduling a second chain', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<UpdaterService />);
    unmount();
    render(<UpdaterService />); // no _resetUpdaterServiceForTests() in between

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('clears the pending timer and removes the focus listener on unmount', async () => {
    vi.useFakeTimers();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<UpdaterService />);

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));

    await vi.advanceTimersByTimeAsync(25_000);
    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe('UpdaterService — autoUpdate-gated background download', () => {
  it('downloads when autoUpdate is on, a version is available, and it is not ignored', async () => {
    vi.useFakeTimers();
    mockGetUpdateState.mockReturnValue({ ...IDLE_STATE, phase: 'available', version: '0.1.12' });

    render(<UpdaterService />);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('does not auto-download a version the user has ignored', async () => {
    vi.useFakeTimers();
    mockGetUpdateState.mockReturnValue({
      ...IDLE_STATE, phase: 'available', version: '0.1.12', ignoredVersion: '0.1.12',
    });

    render(<UpdaterService />);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('does not auto-download when autoUpdate is disabled', async () => {
    vi.useFakeTimers();
    mockGetUpdateState.mockReturnValue({
      ...IDLE_STATE, phase: 'available', version: '0.1.12', autoUpdate: false,
    });

    render(<UpdaterService />);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('UpdaterService — focus recheck', () => {
  it('re-checks on window focus when updateStore.shouldRecheckOnFocus is true', async () => {
    vi.useFakeTimers();
    mockShouldRecheckOnFocus.mockReturnValue(true);

    render(<UpdaterService />);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it('does not re-check on window focus when the last check is recent', async () => {
    vi.useFakeTimers();
    mockShouldRecheckOnFocus.mockReturnValue(false);

    render(<UpdaterService />);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe('UpdaterService — one-time "staged" toast', () => {
  it('shows a single non-sticky toast the first time phase becomes staged for a version', () => {
    mockHasShownStagedToast.mockReturnValue(false);
    setHookState({ ...IDLE_STATE, phase: 'staged', version: '0.1.12' });

    render(<UpdaterService />);

    expect(mockMarkStagedToastShown).toHaveBeenCalledWith('0.1.12');
    expect(mockToast).toHaveBeenCalledTimes(1);
    const [message, type, duration, action] = mockToast.mock.calls[0];
    expect(message).toContain('0.1.12');
    expect(type).toBe('success');
    expect(duration).toBe(10_000);

    action.onClick();
    expect(mockRestartAndApply).toHaveBeenCalledTimes(1);
  });

  it('never toasts when hasShownStagedToast already returns true for that version', () => {
    mockHasShownStagedToast.mockReturnValue(true);
    setHookState({ ...IDLE_STATE, phase: 'staged', version: '0.1.12' });

    render(<UpdaterService />);

    expect(mockToast).not.toHaveBeenCalled();
    expect(mockMarkStagedToastShown).not.toHaveBeenCalled();
  });

  it('does not toast outside Tauri even if phase is staged', () => {
    mockIsTauri.mockReturnValue(false);
    mockHasShownStagedToast.mockReturnValue(false);
    setHookState({ ...IDLE_STATE, phase: 'staged', version: '0.1.12' });

    render(<UpdaterService />);

    expect(mockToast).not.toHaveBeenCalled();
  });

  it('does not toast while phase is merely "available" (not yet staged)', () => {
    mockHasShownStagedToast.mockReturnValue(false);
    setHookState({ ...IDLE_STATE, phase: 'available', version: '0.1.12' });

    render(<UpdaterService />);

    expect(mockToast).not.toHaveBeenCalled();
  });
});
