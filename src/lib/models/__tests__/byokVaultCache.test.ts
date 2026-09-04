/**
 * Regression coverage for the 2026-08-12 live-app bug: `hasByokKey`/
 * `loadByokKey` reported no key configured even though the OS vault held a
 * real, valid DeepSeek key and `secret_get`/`secret_presence` proved it was
 * reachable over IPC. Root causes fixed in byokProviders.ts/vaultClient.ts:
 *
 *   1. The vault-mirror cache lived in module scope (`const byokVaultCache
 *      = new Map()`), which resets to empty the instant the module is
 *      re-evaluated (a dev-mode Vite/HMR reload of this file or anything it
 *      depends on) — with nothing to re-run initByokVault() afterwards. It
 *      now lives on `window.__lazyByokVaultCache`, which survives module
 *      re-evaluation.
 *   2. `initByokVault()` used to await migration and warm every provider
 *      with `Promise.all` — ONE provider's failure (unconfigured provider,
 *      transient vault error) aborted the whole thing, so even a validly
 *      keyed provider (like deepseek) never got warmed. It now isolates
 *      migration and every per-provider read (Promise.allSettled + local
 *      try/catch) so a single failure can't take down the rest.
 *
 * This file drives the SAME public API the real app uses (initByokVault,
 * loadByokKey, hasByokKey) — not internals — so it fails the same way the
 * live-app symptom did if either fix regresses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  initByokVault,
  loadByokKey,
  hasByokKey,
  saveByokKey,
  resetByokVaultCacheForTests,
} from '../byokProviders';

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

/** Routes the mocked invoke() the same way the real Rust commands respond:
 *  secret_get -> configured[key] ?? null, secret_set/secret_delete -> void. */
function mockVaultBackend(configured: Record<string, string>, opts?: { failGetFor?: string[] }): void {
  invokeMock.mockImplementation((cmd: string, args?: { key?: string; value?: string }) => {
    if (cmd === 'secret_get') {
      const key = args?.key ?? '';
      if (opts?.failGetFor?.includes(key)) return Promise.reject(new Error(`vault backend error for ${key}`));
      return Promise.resolve(key in configured ? configured[key] : null);
    }
    if (cmd === 'secret_set' || cmd === 'secret_delete') return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  resetByokVaultCacheForTests();
  setTauriRuntime(true);
});

afterEach(() => {
  setTauriRuntime(false);
  resetByokVaultCacheForTests();
});

describe('initByokVault warming — the reported live-app bug', () => {
  it('a validly-keyed provider (deepseek) becomes visible to loadByokKey/hasByokKey after initByokVault resolves', async () => {
    mockVaultBackend({ 'apikey.deepseek': 'sk-deepseek-real-working-key-1234' });

    expect(hasByokKey('deepseek')).toBe(false); // cold cache, honestly reports unconfigured
    await initByokVault();

    expect(hasByokKey('deepseek')).toBe(true);
    expect(loadByokKey('deepseek')).toBe('sk-deepseek-real-working-key-1234');
  });

  it('one provider failing to read from the vault does NOT prevent a different, validly-keyed provider from warming (Promise.allSettled, not Promise.all)', async () => {
    mockVaultBackend(
      { 'apikey.deepseek': 'sk-deepseek-real-working-key-1234' },
      { failGetFor: ['apikey.anthropic', 'apikey.openai'] }, // simulate a vault-backend error for these
    );

    await initByokVault();

    expect(loadByokKey('deepseek')).toBe('sk-deepseek-real-working-key-1234');
    expect(hasByokKey('anthropic')).toBe(false); // failed read -> honestly absent, not a crash
  });

  it('a migration failure does not prevent the cache-warm step from running', async () => {
    // Pre-2026-08-12 leftover in localStorage that the vault write will
    // fail to migrate (simulated transient error) — the warm loop for
    // deepseek (already vault-resident, nothing to migrate) must still run.
    localStorage.setItem('lazy.apikey.openai', 'sk-stale-leftover');
    invokeMock.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === 'secret_set') return Promise.reject(new Error('vault write failed'));
      if (cmd === 'secret_get') {
        return Promise.resolve(args?.key === 'apikey.deepseek' ? 'sk-deepseek-real-working-key-1234' : null);
      }
      return Promise.resolve(undefined);
    });

    await initByokVault();

    expect(loadByokKey('deepseek')).toBe('sk-deepseek-real-working-key-1234');
  });

  it('records a window.__lazyByokVaultReady marker distinguishing warmed vs failed providers (live-verification hook)', async () => {
    mockVaultBackend(
      { 'apikey.deepseek': 'sk-deepseek-real-working-key-1234' },
      { failGetFor: ['apikey.anthropic'] },
    );

    await initByokVault();

    const marker = (window as unknown as { __lazyByokVaultReady?: { ready: boolean; warmed: string[]; failed: string[] } }).__lazyByokVaultReady;
    expect(marker?.ready).toBe(true);
    expect(marker?.warmed).toContain('deepseek');
    expect(marker?.failed).toContain('anthropic');
    // The marker must never carry the secret value itself.
    expect(JSON.stringify(marker)).not.toContain('sk-deepseek-real-working-key-1234');
  });

  it('exposes window.__lazyByokDebugHasKey — a boolean-only live-verification hook wired to the real hasByokKey', async () => {
    mockVaultBackend({ 'apikey.deepseek': 'sk-deepseek-real-working-key-1234' });
    await initByokVault();

    const debugHasKey = (window as unknown as { __lazyByokDebugHasKey?: (p: string) => boolean }).__lazyByokDebugHasKey;
    expect(typeof debugHasKey).toBe('function');
    expect(debugHasKey?.('deepseek')).toBe(true);
    expect(debugHasKey?.('anthropic')).toBe(false);
  });
});

describe('cache survives module re-evaluation (window-backed, not module-scoped)', () => {
  it('a value placed directly on window.__lazyByokVaultCache — simulating state left behind before a module reload — is visible to loadByokKey without calling initByokVault again', () => {
    // No initByokVault() call in this test: this simulates the exact
    // scenario that used to break — the module's own top-level `const`
    // binding would have been wiped by a re-evaluation, but state that
    // lives on `window` is untouched by that.
    (window as unknown as { __lazyByokVaultCache: Map<string, string> }).__lazyByokVaultCache = new Map([
      ['deepseek', 'sk-deepseek-real-working-key-1234'],
    ]);

    expect(loadByokKey('deepseek')).toBe('sk-deepseek-real-working-key-1234');
    expect(hasByokKey('deepseek')).toBe(true);
  });

  it('saveByokKey (e.g. from the settings UI) updates the SAME window-backed cache loadByokKey reads from', () => {
    invokeMock.mockResolvedValue(undefined);
    saveByokKey('deepseek', 'sk-freshly-entered-key');
    expect(loadByokKey('deepseek')).toBe('sk-freshly-entered-key');
  });
});
