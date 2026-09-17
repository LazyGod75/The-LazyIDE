/**
 * Tests for managerRailFailover: recoverable-error classification, fallback
 * rail ordering/availability gates, and the bounded runWithRailFailover loop
 * that keeps a manager turn alive when its resolved rail dies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsManagedActive = vi.fn<() => boolean>(() => false);
const mockCliAvailable = vi.fn<(tool: string) => boolean | null>(() => null);
const mockDevinBlocked = vi.fn<() => string | null>(() => null);
const mockHasByokKey = vi.fn<() => boolean>(() => false);

// isDesktopRuntime reads the '__TAURI_INTERNALS__' sentinel on window —
// toggle it directly (the module deliberately does NOT import platform).
function setDesktopRuntime(v: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (v) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    isManagedActive: () => mockIsManagedActive(),
    loadAccessSettings: () => ({ byokProvider: 'deepseek' }),
  };
});
vi.mock('../lib/models/cliBackendProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/cliBackendProvider')>();
  return { ...actual, isCliBackendAvailable: (t: string) => mockCliAvailable(t) };
});
vi.mock('../lib/models/devinAuthGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/devinAuthGuard')>();
  return { ...actual, devinAuthBlocked: () => mockDevinBlocked() };
});
vi.mock('../lib/models/byokProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/byokProviders')>();
  return { ...actual, hasByokKey: () => mockHasByokKey() };
});

import {
  fallbackModeRails,
  isRailRecoverableError,
  railAttemptLabel,
  railFailoverNotice,
  runWithRailFailover,
} from '../lib/agents/managerRailFailover';
import type { ManagerRailAttempt } from '../lib/agents/managerRailFailover';
import { BYOK_PROVIDER_DEFS } from '../lib/models/byokProviders';

const modeAttempt = (mode: 'managed' | 'claude-code' | 'codex' | 'devin' | 'live-key'): ManagerRailAttempt =>
  ({ kind: 'mode', mode, model: 'm' });

beforeEach(() => {
  mockIsManagedActive.mockReturnValue(false);
  setDesktopRuntime(true);
  mockCliAvailable.mockReturnValue(null);
  mockDevinBlocked.mockReturnValue(null);
  mockHasByokKey.mockReturnValue(false);
});

describe('isRailRecoverableError', () => {
  it('never fails over on user abort (signal)', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isRailRecoverableError(new Error('x'), controller.signal)).toBe(false);
  });

  it('never fails over on AbortError even without an aborted signal', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isRailRecoverableError(err, undefined)).toBe(false);
  });

  it('treats ordinary rail failures as recoverable (bounded by rail count)', () => {
    expect(isRailRecoverableError(new Error('spawn devin ENOENT'), undefined)).toBe(true);
    expect(isRailRecoverableError(new TypeError('fetch failed'), undefined)).toBe(true);
  });
});

describe('fallbackModeRails', () => {
  it('excludes the failed primary mode and preserves auto-detect order', () => {
    mockIsManagedActive.mockReturnValue(true);
    mockCliAvailable.mockReturnValue(true);
    mockHasByokKey.mockReturnValue(true);
    const rails = fallbackModeRails(modeAttempt('claude-code'));
    expect(rails.map((r) => (r.kind === 'mode' ? r.mode : r.kind))).toEqual(
      ['managed', 'codex', 'devin', 'live-key'],
    );
  });

  it('skips CLI rails off-Tauri even when availability is unprobed (null)', () => {
    setDesktopRuntime(false);
    mockIsManagedActive.mockReturnValue(true);
    const rails = fallbackModeRails(modeAttempt('managed'));
    expect(rails).toEqual([]);
  });

  it('skips devin while the auth breaker is engaged', () => {
    mockCliAvailable.mockReturnValue(true);
    mockDevinBlocked.mockReturnValue('devin auth required');
    const rails = fallbackModeRails(modeAttempt('managed'));
    expect(rails.map((r) => (r.kind === 'mode' ? r.mode : r.kind))).not.toContain('devin');
  });

  it('skips live-key without a configured BYOK key', () => {
    mockCliAvailable.mockReturnValue(true);
    mockHasByokKey.mockReturnValue(false);
    const rails = fallbackModeRails(modeAttempt('managed'));
    expect(rails.map((r) => (r.kind === 'mode' ? r.mode : r.kind))).not.toContain('live-key');
  });

  it('never offers mock/pro/local as failover targets', () => {
    mockIsManagedActive.mockReturnValue(true);
    mockCliAvailable.mockReturnValue(true);
    mockHasByokKey.mockReturnValue(true);
    const modes = fallbackModeRails(modeAttempt('managed')).map((r) => (r.kind === 'mode' ? r.mode : r.kind));
    for (const m of modes) expect(['claude-code', 'codex', 'devin', 'live-key']).toContain(m);
  });

  it('excludes the devin mode rail when the failed primary was a devin-model pick', () => {
    mockCliAvailable.mockReturnValue(true);
    // No auth breaker — the exclusion must come from same-backend dedup,
    // not from the breaker gate.
    const modes = fallbackModeRails({ kind: 'devin-model', model: 'swe-2-medium' })
      .map((r) => (r.kind === 'mode' ? r.mode : r.kind));
    expect(modes).not.toContain('devin');
    expect(modes).toContain('claude-code');
  });

  it('excludes live-key when the failed keyed-BYOK pick IS the selected provider', () => {
    mockIsManagedActive.mockReturnValue(true);
    mockCliAvailable.mockReturnValue(true);
    mockHasByokKey.mockReturnValue(true);
    const deepseek = BYOK_PROVIDER_DEFS.find((d) => d.id === 'deepseek');
    expect(deepseek).toBeTruthy();
    const modes = fallbackModeRails({ kind: 'keyed-byok', def: deepseek!, model: 'deepseek-chat' })
      .map((r) => (r.kind === 'mode' ? r.mode : r.kind));
    expect(modes).not.toContain('live-key');
  });
});

describe('runWithRailFailover', () => {
  it('returns on the first successful rail without calling onFallback', async () => {
    const onFallback = vi.fn();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    await runWithRailFailover([modeAttempt('managed'), modeAttempt('codex')], dispatch, { onFallback });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls over to the next rail on failure and reports it via onFallback', async () => {
    const seen: string[] = [];
    const onFallback = vi.fn();
    await runWithRailFailover(
      [modeAttempt('devin'), modeAttempt('codex')],
      async (a) => {
        seen.push(a.kind === 'mode' ? a.mode : a.kind);
        if (seen.length === 1) throw new Error('devin acp exited 1');
      },
      { onFallback },
    );
    expect(seen).toEqual(['devin', 'codex']);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toMatchObject({ kind: 'mode', mode: 'devin' });
    expect(onFallback.mock.calls[0][1]).toMatchObject({ kind: 'mode', mode: 'codex' });
  });

  it('rethrows the LAST error when every rail fails', async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('last'));
    await expect(
      runWithRailFailover([modeAttempt('devin'), modeAttempt('codex')], dispatch),
    ).rejects.toThrow('last');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('rethrows abort immediately without touching the next rail', async () => {
    const controller = new AbortController();
    const dispatch = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    await expect(
      runWithRailFailover([modeAttempt('devin'), modeAttempt('codex')], dispatch, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('notice + labels', () => {
  it('names the NEXT rail and the failed rail with its reason', () => {
    const notice = railFailoverNotice(modeAttempt('codex'), [
      { label: 'Devin swe-2-medium', reason: 'devin acp exited 1' },
    ]);
    expect(notice).toContain('Codex');
    expect(notice).toContain('Devin swe-2-medium');
    expect(notice).toContain('devin acp exited 1');
  });

  it('keeps the full dead-rail chain so earlier notices survive the accumulator reset', () => {
    const notice = railFailoverNotice(modeAttempt('managed'), [
      { label: 'Devin swe-2-medium', reason: 'blocked' },
      { label: 'Claude Code', reason: 'OAuth session expired' },
    ]);
    expect(notice).toContain('Devin swe-2-medium (blocked)');
    expect(notice).toContain('Claude Code (OAuth session expired)');
    expect(notice).toContain('Lazy Pro');
  });

  it('truncates very long notices', () => {
    const notice = railFailoverNotice(modeAttempt('managed'), [
      { label: 'X', reason: 'x'.repeat(300) },
    ]);
    expect(notice.length).toBeLessThanOrEqual(420);
    expect(notice).toContain('Lazy Pro');
  });

  it('labels each attempt kind distinctly', () => {
    expect(railAttemptLabel({ kind: 'devin-model', model: 'swe-2-medium' })).toContain('swe-2-medium');
    expect(railAttemptLabel(modeAttempt('claude-code'))).toBe('Claude Code');
  });
});
