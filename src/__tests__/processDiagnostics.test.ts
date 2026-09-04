/**
 * processDiagnostics.test.ts — typed wrapper around the
 * get_abandoned_drain_thread_count diagnostic command
 * (src/lib/agents/processDiagnostics.ts). Same graceful-degradation
 * contract as systemPressure.test.ts: never throws, resolves to 0 outside
 * a real Tauri app or when the command rejects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getAbandonedDrainThreadCount } from '../lib/agents/processDiagnostics';

const mockedInvoke = vi.mocked(invoke);

/** Toggles `window.__TAURI_INTERNALS__` — same convention systemPressure.
 *  test.ts's own setTauriRuntime helper uses. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  setTauriRuntime(false);
  vi.clearAllMocks();
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('getAbandonedDrainThreadCount', () => {
  it('resolves to 0 outside a real Tauri app (no __TAURI_INTERNALS__ in jsdom)', async () => {
    await expect(getAbandonedDrainThreadCount()).resolves.toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('returns the backend count inside a real Tauri app', async () => {
    setTauriRuntime(true);
    mockedInvoke.mockResolvedValueOnce(3);
    await expect(getAbandonedDrainThreadCount()).resolves.toBe(3);
    expect(mockedInvoke).toHaveBeenCalledWith('get_abandoned_drain_thread_count');
  });

  it('resolves to 0 when the command rejects (older/absent Rust build)', async () => {
    setTauriRuntime(true);
    mockedInvoke.mockRejectedValueOnce(new Error('command not found'));
    await expect(getAbandonedDrainThreadCount()).resolves.toBe(0);
  });

  it('resolves to 0 when the backend returns a non-numeric payload', async () => {
    setTauriRuntime(true);
    mockedInvoke.mockResolvedValueOnce('not-a-number' as unknown as number);
    await expect(getAbandonedDrainThreadCount()).resolves.toBe(0);
  });
});
