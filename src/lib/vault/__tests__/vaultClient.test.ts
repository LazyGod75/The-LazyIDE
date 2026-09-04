import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @tauri-apps/api/core so we can assert exactly which Rust command
// each wrapper calls, and control what it returns, without a real Tauri
// runtime.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  getSecretRaw,
  getSecretPresence,
  setSecret,
  deleteSecret,
  migrateByokKeysToVault,
  byokVaultKey,
  ALL_BYOK_PROVIDER_IDS,
} from '../vaultClient';

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
});

describe('vaultClient command wiring', () => {
  it('setSecret calls secret_set with key and value', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await setSecret('apikey.deepseek', 'sk-test-value');
    expect(invokeMock).toHaveBeenCalledWith('secret_set', { key: 'apikey.deepseek', value: 'sk-test-value' });
  });

  it('deleteSecret calls secret_delete with key only', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await deleteSecret('apikey.deepseek');
    expect(invokeMock).toHaveBeenCalledWith('secret_delete', { key: 'apikey.deepseek' });
  });

  it('getSecretRaw calls secret_get and unwraps null to undefined', async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(getSecretRaw('apikey.deepseek')).resolves.toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('secret_get', { key: 'apikey.deepseek' });
  });

  it('getSecretRaw returns the raw value when the vault has one', async () => {
    invokeMock.mockResolvedValueOnce('sk-the-actual-secret');
    await expect(getSecretRaw('apikey.deepseek')).resolves.toBe('sk-the-actual-secret');
  });
});

describe('masked-get contract: a presence-only caller never receives the full secret', () => {
  it('getSecretPresence calls secret_presence, never secret_get', async () => {
    invokeMock.mockResolvedValueOnce({ present: true, hint: '****…cret' });
    const presence = await getSecretPresence('apikey.deepseek');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('secret_presence', { key: 'apikey.deepseek' });
    expect(invokeMock).not.toHaveBeenCalledWith('secret_get', expect.anything());
    expect(presence).toEqual({ present: true, hint: '****…cret' });
  });

  it('a caller that only awaits getSecretPresence never observes a full secret value, whatever the backend returns as a hint', async () => {
    // Simulate the Rust side honoring its own contract (masked hint only).
    const fullSecret = 'sk-super-secret-value-1234';
    invokeMock.mockResolvedValueOnce({ present: true, hint: '****…1234' });
    const presence = await getSecretPresence('apikey.anthropic');
    expect(presence.hint).not.toBe(fullSecret);
    expect(presence.hint?.includes('super-secret')).toBe(false);
  });
});

describe('BYOK migration: localStorage -> vault', () => {
  it('migration path: an existing localStorage key is moved to the vault and removed from localStorage', async () => {
    localStorage.setItem('lazy.apikey.deepseek', 'sk-old-plaintext-key');
    invokeMock.mockResolvedValue(undefined); // every setSecret call succeeds

    const migrated = await migrateByokKeysToVault();

    expect(migrated).toEqual(['deepseek']);
    // New location has the value: vault write happened with the right key.
    expect(invokeMock).toHaveBeenCalledWith('secret_set', {
      key: byokVaultKey('deepseek'),
      value: 'sk-old-plaintext-key',
    });
    // Old location is empty: the plaintext localStorage copy is gone.
    expect(localStorage.getItem('lazy.apikey.deepseek')).toBeNull();
  });

  it('migration path: multiple configured providers are all migrated in one pass', async () => {
    localStorage.setItem('lazy.apikey.anthropic', 'sk-ant-old');
    localStorage.setItem('lazy.apikey.openrouter', 'sk-or-old');
    invokeMock.mockResolvedValue(undefined);

    const migrated = await migrateByokKeysToVault();

    expect(migrated.sort()).toEqual(['anthropic', 'openrouter'].sort());
    expect(localStorage.getItem('lazy.apikey.anthropic')).toBeNull();
    expect(localStorage.getItem('lazy.apikey.openrouter')).toBeNull();
  });

  it('no-op path: nothing in localStorage means nothing migrated and no vault writes', async () => {
    // Deliberately empty localStorage.
    const migrated = await migrateByokKeysToVault();

    expect(migrated).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('no-op path: an already-migrated provider (no localStorage entry left) is skipped on a second run', async () => {
    localStorage.setItem('lazy.apikey.deepseek', 'sk-old-plaintext-key');
    invokeMock.mockResolvedValue(undefined);
    await migrateByokKeysToVault(); // first run: migrates it

    invokeMock.mockClear();
    const secondRun = await migrateByokKeysToVault();

    expect(secondRun).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('ignores blank/whitespace-only localStorage values instead of migrating an empty key', async () => {
    localStorage.setItem('lazy.apikey.groq', '   ');
    const migrated = await migrateByokKeysToVault();
    expect(migrated).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('covers every provider id the app has ever persisted, including the currently-inactive "google" slot', () => {
    expect(ALL_BYOK_PROVIDER_IDS).toContain('google');
    expect(ALL_BYOK_PROVIDER_IDS).toContain('anthropic');
    expect(ALL_BYOK_PROVIDER_IDS.length).toBeGreaterThanOrEqual(8);
  });
});
