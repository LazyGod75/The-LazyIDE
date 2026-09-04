/**
 * systemPressure.test.ts — the shared "is this machine under load right
 * now" store (src/lib/agents/systemPressure.ts). Runs entirely outside a
 * real Tauri app (jsdom has no `__TAURI_INTERNALS__`), so getSystemPressure/
 * subscribeSystemPressure never actually call listen()/invoke() here — the
 * graceful-degradation contract itself (an older/absent Rust backend always
 * reads 'normal') is exactly what these tests exercise, plus the test-only
 * direct setter every OTHER suite (scheduler/devPreview/the indicator) relies
 * on to simulate a real pressure event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event } from '@tauri-apps/api/event';
import {
  getSystemPressure,
  subscribeSystemPressure,
  setSystemPressureForTests,
  resetSystemPressureForTests,
} from '../lib/agents/systemPressure';

// @tauri-apps/api/core and @tauri-apps/api/event are globally mocked
// (src/__tests__/setup.ts) — cast here (same convention cliBackendProvider.
// test.ts already uses) only for the real-wire-shape suite below, which
// needs to drive get_system_pressure/`system://pressure` directly.
const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

/** Toggles `window.__TAURI_INTERNALS__` — same convention runtimeDispatch.
 *  test.ts's own setTauriRuntime helper uses. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  resetSystemPressureForTests();
  setTauriRuntime(false);
  vi.clearAllMocks();
});

afterEach(() => {
  resetSystemPressureForTests();
  setTauriRuntime(false);
});

describe('getSystemPressure', () => {
  it('defaults to normal outside a real Tauri app (no __TAURI_INTERNALS__ in jsdom)', () => {
    expect(getSystemPressure()).toEqual({ level: 'normal' });
  });

  it('reflects a level set via the test-only setter', () => {
    setSystemPressureForTests({ level: 'high', availableMemoryMb: 512, cpuPercent: 97 });
    expect(getSystemPressure()).toEqual({ level: 'high', availableMemoryMb: 512, cpuPercent: 97 });
  });
});

describe('subscribeSystemPressure', () => {
  it('notifies subscribers immediately on a change', () => {
    const seen: Array<{ level: string }> = [];
    const unsub = subscribeSystemPressure((s) => seen.push(s));

    setSystemPressureForTests({ level: 'elevated' });
    setSystemPressureForTests({ level: 'high' });

    expect(seen.map((s) => s.level)).toEqual(['elevated', 'high']);
    unsub();
  });

  it('stops notifying once unsubscribed', () => {
    const seen: Array<{ level: string }> = [];
    const unsub = subscribeSystemPressure((s) => seen.push(s));
    unsub();

    setSystemPressureForTests({ level: 'high' });

    expect(seen).toEqual([]);
  });

  it('supports multiple independent subscribers', () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = subscribeSystemPressure((s) => a.push(s.level));
    const unsubB = subscribeSystemPressure((s) => b.push(s.level));

    setSystemPressureForTests({ level: 'high' });

    expect(a).toEqual(['high']);
    expect(b).toEqual(['high']);
    unsubA();
    unsubB();
  });
});

describe('resetSystemPressureForTests', () => {
  it('clears the snapshot back to normal and drops every subscriber', () => {
    const seen: string[] = [];
    subscribeSystemPressure((s) => seen.push(s.level));
    setSystemPressureForTests({ level: 'high' });
    expect(getSystemPressure().level).toBe('high');

    resetSystemPressureForTests();

    expect(getSystemPressure()).toEqual({ level: 'normal' });
    // The old subscriber was dropped by the reset — a later change must not
    // reach it.
    setSystemPressureForTests({ level: 'elevated' });
    expect(seen).toEqual(['high']);
  });
});

// ── Real wire shape (src-tauri/src/commands/system_pressure.rs) ────────
//
// The Rust `SystemPressure` struct serializes `#[serde(rename_all =
// "camelCase")]` field names (availableRamMb/totalRamMb/cpuPct) and its
// `PressureLevel` enum serializes its OWN, separate `#[serde(rename_all =
// "PascalCase")]` variants ('Normal'/'Elevated'/'High') — NOT this module's
// lowercase PressureLevel. These tests drive get_system_pressure/
// `system://pressure` with that exact real shape end to end.

describe('real wire shape — get_system_pressure / system://pressure', () => {
  it('normalizes a PascalCase level + availableRamMb/cpuPct from get_system_pressure', async () => {
    setTauriRuntime(true);
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_system_pressure') {
        return { level: 'High', availableRamMb: 900, totalRamMb: 16000, cpuPct: 92.5 };
      }
      return undefined;
    });

    getSystemPressure(); // triggers ensureInit's lazy fetch
    await Promise.resolve();
    await Promise.resolve();

    expect(getSystemPressure()).toEqual({ level: 'high', availableMemoryMb: 900, cpuPercent: 92.5 });
  });

  it('normalizes a live system://pressure event the same way', async () => {
    setTauriRuntime(true);
    let handler: ((event: Event<unknown>) => void) | undefined;
    mockedListen.mockImplementation(async (_name: string, cb: (event: Event<unknown>) => void) => {
      handler = cb;
      return () => undefined;
    });

    getSystemPressure(); // triggers ensureInit's listen() registration
    await Promise.resolve();
    await Promise.resolve();

    handler?.({
      event: 'system://pressure',
      id: 0,
      payload: { level: 'Elevated', availableRamMb: 2500, totalRamMb: 16000, cpuPct: 70 },
    });

    expect(getSystemPressure()).toEqual({ level: 'elevated', availableMemoryMb: 2500, cpuPercent: 70 });
  });

  it('degrades to normal for an unrecognized level string rather than throwing', async () => {
    setTauriRuntime(true);
    mockedInvoke.mockResolvedValue({ level: 'SomethingUnknown', availableRamMb: 1000, cpuPct: 10 });

    getSystemPressure();
    await Promise.resolve();
    await Promise.resolve();

    expect(getSystemPressure().level).toBe('normal');
  });

  it('normalizes ramLevel from get_system_pressure so a consumer can tell RAM from CPU pressure', async () => {
    setTauriRuntime(true);
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_system_pressure') {
        // Overall High driven by CPU alone (see system_pressure.rs's
        // classify_pressure) — ramLevel must come through as its OWN,
        // independent 'normal', not silently dropped or coerced to match
        // the overall 'high' level.
        return { level: 'High', availableRamMb: 8000, totalRamMb: 16000, cpuPct: 92, ramLevel: 'Normal' };
      }
      return undefined;
    });

    getSystemPressure();
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = getSystemPressure();
    expect(snapshot.level).toBe('high');
    expect(snapshot.ramLevel).toBe('normal');
  });

  it('leaves ramLevel undefined (never a guess) when the backend omits it', async () => {
    setTauriRuntime(true);
    mockedInvoke.mockResolvedValue({ level: 'High', availableRamMb: 900, cpuPct: 10 });

    getSystemPressure();
    await Promise.resolve();
    await Promise.resolve();

    expect(getSystemPressure().ramLevel).toBeUndefined();
  });

  it('never calls listen()/invoke() outside a real Tauri app', async () => {
    setTauriRuntime(false);

    getSystemPressure();
    await Promise.resolve();

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(mockedListen).not.toHaveBeenCalled();
  });
});
