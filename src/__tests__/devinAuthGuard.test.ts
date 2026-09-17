/* devinAuthGuard — regression coverage for the browser-tab storm: a
   rejected `devin acp` credential made each retrying caller (wakeup,
   routine, catalog refresh) open an OAuth tab. The guard must refuse new
   spawns while a failure is recent — without ever needing the exe rebuild
   the Rust-side breaker waits on. */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import {
  devinAuthBlocked,
  devinAuthBlockedAsync,
  isDevinAuthError,
  noteDevinFailure,
  resetDevinAuthGuard,
} from '../lib/models/devinAuthGuard';

describe('devinAuthGuard', () => {
  beforeEach(() => {
    resetDevinAuthGuard();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isDevinAuthError matches credential-shaped messages only', () => {
    expect(isDevinAuthError('authentication failed')).toBe(true);
    expect(isDevinAuthError('HTTP 401 Unauthorized')).toBe(true);
    expect(isDevinAuthError('invalid credentials')).toBe(true);
    expect(isDevinAuthError('403 forbidden')).toBe(true);
    expect(isDevinAuthError('session/new returned no sessionId')).toBe(false);
    expect(isDevinAuthError('quota exhausted')).toBe(false);
  });

  it('an auth-shaped failure blocks immediately', () => {
    noteDevinFailure(new Error('401 unauthorized'));
    expect(devinAuthBlocked()).toMatch(/devin auth login/);
  });

  it('the auth block lifts after the 15min cooldown', () => {
    noteDevinFailure('invalid credentials');
    expect(devinAuthBlocked()).not.toBeNull();
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(devinAuthBlocked()).toBeNull();
  });

  it('generic failures need 3 inside the window before blocking', () => {
    noteDevinFailure('spawn failed: ENOENT');
    noteDevinFailure('spawn failed: ENOENT');
    expect(devinAuthBlocked()).toBeNull();
    noteDevinFailure('spawn failed: ENOENT');
    expect(devinAuthBlocked()).not.toBeNull();
  });

  it('generic failures older than the window do not count', () => {
    noteDevinFailure('boom');
    vi.advanceTimersByTime(3 * 60 * 1000); // outside the 2min window
    noteDevinFailure('boom');
    noteDevinFailure('boom');
    expect(devinAuthBlocked()).toBeNull();
  });

  it('resetDevinAuthGuard unblocks immediately (post `devin auth login`)', () => {
    noteDevinFailure('401 unauthorized');
    expect(devinAuthBlocked()).not.toBeNull();
    resetDevinAuthGuard();
    expect(devinAuthBlocked()).toBeNull();
  });

  it('the blocked message never contains a credential', () => {
    noteDevinFailure('401 unauthorized — token sk-live-redacted');
    const msg = devinAuthBlocked();
    expect(msg).not.toContain('sk-live');
    expect(msg).toContain('devin auth login');
  });

  it('a rewritten credentials.toml lifts the auth block without cooldown', async () => {
    vi.useRealTimers();
    mockInvoke.mockResolvedValue(1000); // baseline mtime captured on engage
    noteDevinFailure('401 unauthorized');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    expect(devinAuthBlocked()).not.toBeNull();
    mockInvoke.mockResolvedValue(2000); // `devin auth login` rewrote the file
    expect(await devinAuthBlockedAsync()).toBeNull();
  });

  it('an untouched credentials.toml keeps the auth block', async () => {
    vi.useRealTimers();
    mockInvoke.mockResolvedValue(1000);
    noteDevinFailure('401 unauthorized');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    expect(await devinAuthBlockedAsync()).toMatch(/devin auth login/);
  });

  it('a missing tauri runtime keeps the block (fail safe)', async () => {
    vi.useRealTimers();
    mockInvoke.mockRejectedValue(new Error('no tauri'));
    noteDevinFailure('401 unauthorized');
    expect(await devinAuthBlockedAsync()).toMatch(/devin auth login/);
  });

  it('pre-arms the block when the live probe says not logged in — before ANY spawn', async () => {
    vi.useRealTimers();
    // devin_auth_probe=false — mtime probe then returns null baseline.
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'devin_auth_probe' ? false : null));
    expect(devinAuthBlocked()).toBeNull(); // nothing engaged yet
    expect(await devinAuthBlockedAsync()).toMatch(/not logged in/);
    expect(devinAuthBlocked()).toMatch(/not logged in/); // sync readers see it too
  });

  it('pre-arms via the file check when the live probe command is absent (old exe)', async () => {
    vi.useRealTimers();
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'devin_auth_probe'
        ? Promise.reject(new Error('command not found'))
        : Promise.resolve(cmd === 'devin_auth_status' ? false : null));
    expect(await devinAuthBlockedAsync()).toMatch(/not logged in/);
  });

  it('does not pre-arm when a credential is usable', async () => {
    vi.useRealTimers();
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'devin_auth_probe' ? true : 1000));
    expect(await devinAuthBlockedAsync()).toBeNull();
    expect(devinAuthBlocked()).toBeNull();
  });

  it('does not pre-arm when both probes are indeterminate (fail open, reactive path stays)', async () => {
    vi.useRealTimers();
    mockInvoke.mockRejectedValue(new Error('command not found'));
    expect(await devinAuthBlockedAsync()).toBeNull();
  });

  it('lifts a pre-armed block when the credentials file appears', async () => {
    vi.useRealTimers();
    let authed = false;
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === 'devin_auth_probe' ? authed
        : cmd === 'devin_auth_status' ? authed
        : authed ? 2000 : null));
    expect(await devinAuthBlockedAsync()).toMatch(/not logged in/);
    authed = true; // user ran `devin auth login` — file now exists (mtime 2000 ≠ null baseline)
    expect(await devinAuthBlockedAsync()).toBeNull();
    expect(devinAuthBlocked()).toBeNull();
  });
});
