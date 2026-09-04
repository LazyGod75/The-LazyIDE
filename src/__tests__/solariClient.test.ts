/* solariClient.test.ts — unit tests for the lazy Solari SDK client
   singletons (src/lib/solari/solariClient.ts).

   All three SDK packages, the vault and the event bus are mocked so nothing
   is ever constructed for real, no IPC happens and no network is dialed.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/vault/vaultClient', () => ({
  getSecretRaw: vi.fn(),
  getSecretPresence: vi.fn(),
}));

vi.mock('@solarisdk/desktop', () => ({ DesktopClient: vi.fn() }));
vi.mock('@solarisdk/sandbox', () => ({ SandboxClient: vi.fn() }));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

import { DesktopClient } from '@solarisdk/desktop';
import { SandboxClient } from '@solarisdk/sandbox';
import { getSecretPresence, getSecretRaw } from '../lib/vault/vaultClient';
import { emit } from '../lib/bus';
import {
  SOLARI_VAULT_KEY,
  CloudSolariBrowserClient,
  SolariNotConfiguredError,
  SolariApiError,
  assertSolariConfigured,
  emitSolariConfiguredChange,
  getSolariClients,
  isSolariConfigured,
  mapSolariError,
  resetSolariClients,
} from '../lib/solari/solariClient';

beforeEach(() => {
  vi.clearAllMocks();
  resetSolariClients();
  vi.mocked(getSecretRaw).mockResolvedValue(undefined);
  vi.mocked(getSecretPresence).mockResolvedValue({ present: false });
});

describe('assertSolariConfigured', () => {
  it('throws SolariNotConfiguredError when the key is missing', async () => {
    vi.mocked(getSecretPresence).mockResolvedValue({ present: false });
    await expect(assertSolariConfigured()).rejects.toBeInstanceOf(SolariNotConfiguredError);
  });

  it('resolves when a key is configured', async () => {
    vi.mocked(getSecretPresence).mockResolvedValue({ present: true, hint: 'sk-…abcd' });
    await expect(assertSolariConfigured()).resolves.toBeUndefined();
  });
});

describe('getSolariClients', () => {
  it('constructs all three clients once with apiKey/baseUrl and caches', async () => {
    vi.mocked(getSecretRaw).mockResolvedValue('sk-solari-test');
    const first = await getSolariClients();
    const second = await getSolariClients();
    expect(first).toBe(second);
    expect(first.browser).toBeInstanceOf(CloudSolariBrowserClient);
    expect(first.desktop).toBeInstanceOf(DesktopClient);
    expect(first.sandbox).toBeInstanceOf(SandboxClient);
    expect(DesktopClient).toHaveBeenCalledTimes(1);
    expect(SandboxClient).toHaveBeenCalledTimes(1);
    expect(getSecretRaw).toHaveBeenCalledWith(SOLARI_VAULT_KEY);
  });

  it('throws SolariNotConfiguredError when no key is stored', async () => {
    vi.mocked(getSecretRaw).mockResolvedValue(undefined);
    await expect(getSolariClients()).rejects.toBeInstanceOf(SolariNotConfiguredError);
  });

  it('resetSolariClients forces reconstruction on the next call', async () => {
    vi.mocked(getSecretRaw).mockResolvedValue('sk-solari-test');
    await getSolariClients();
    resetSolariClients();
    const third = await getSolariClients();
    expect(third.browser).toBeInstanceOf(CloudSolariBrowserClient);
    expect(DesktopClient).toHaveBeenCalledTimes(2);
    expect(SandboxClient).toHaveBeenCalledTimes(2);
  });

  it('a changed vault key invalidates the cached clients', async () => {
    vi.mocked(getSecretRaw).mockResolvedValue('sk-solari-test');
    const first = await getSolariClients();
    vi.mocked(getSecretRaw).mockResolvedValue('sk-solari-other');
    const second = await getSolariClients();
    expect(first).not.toBe(second);
    expect(second.browser).toBeInstanceOf(CloudSolariBrowserClient);
    expect(DesktopClient).toHaveBeenCalledTimes(2);
  });
});



describe('mapSolariError', () => {
  it('maps a 401 to auth', () => {
    const err = mapSolariError({ status: 401, code: 'BadApiKey' });
    expect(err).toBeInstanceOf(SolariApiError);
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.code).toBe('BadApiKey');
    expect(err.retryable).toBe(false);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('maps a 402 to credit', () => {
    const err = mapSolariError({ status: 402 });
    expect(err.kind).toBe('credit');
    expect(err.retryable).toBe(false);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('maps a 402 FeatureRequiresPlan to plan (not credits)', () => {
    const err = mapSolariError({ status: 402, code: 'FeatureRequiresPlan' });
    expect(err.kind).toBe('plan');
    expect(err.status).toBe(402);
    expect(err.code).toBe('FeatureRequiresPlan');
    expect(err.userMessage).toMatch(/paid plan/i);
  });

  it('maps a 409 to conflict', () => {
    const err = mapSolariError({ status: 409 });
    expect(err.kind).toBe('conflict');
    expect(err.retryable).toBe(false);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('maps a 429 to concurrency with retryable false', () => {
    const err = mapSolariError({ status: 429 });
    expect(err.kind).toBe('concurrency');
    expect(err.retryable).toBe(false);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('maps code ConcurrencyLimitExceeded to concurrency even without a status', () => {
    const err = mapSolariError({ code: 'ConcurrencyLimitExceeded' });
    expect(err.kind).toBe('concurrency');
    expect(err.retryable).toBe(false);
  });

  it('a 429 with a random prose message still maps to concurrency', () => {
    const err = mapSolariError({ status: 429, message: 'totally unrelated prose that must never drive branching' });
    expect(err.kind).toBe('concurrency');
    expect(err.retryable).toBe(false);
  });

  it('maps a 400 to badRequest', () => {
    const err = mapSolariError({ status: 400 });
    expect(err.kind).toBe('badRequest');
    expect(err.retryable).toBe(false);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('maps an error with retryable true to transient', () => {
    const err = mapSolariError({ retryable: true });
    expect(err.kind).toBe('transient');
    expect(err.retryable).toBe(true);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('maps anything unrecognized to unknown', () => {
    const err = mapSolariError({ status: 503 });
    expect(err.kind).toBe('unknown');
    expect(err.retryable).toBe(false);
    expect(err.userMessage.length).toBeGreaterThan(0);
  });

  it('accepts a numeric string status for safety', () => {
    const err = mapSolariError({ status: '401' });
    expect(err.kind).toBe('auth');
  });
});

describe('emitSolariConfiguredChange', () => {
  it('emits solari:configuredChange with the current configured state', async () => {
    vi.mocked(getSecretPresence).mockResolvedValue({ present: true, hint: 'sk-…abcd' });
    await emitSolariConfiguredChange();
    expect(emit).toHaveBeenCalledWith('solari:configuredChange', { configured: true });

    vi.mocked(getSecretPresence).mockResolvedValue({ present: false });
    await emitSolariConfiguredChange();
    expect(emit).toHaveBeenCalledWith('solari:configuredChange', { configured: false });
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('isSolariConfigured', () => {
  it('is false when the vault key is missing', async () => {
    vi.mocked(getSecretPresence).mockResolvedValue({ present: false });
    expect(await isSolariConfigured()).toBe(false);
    expect(getSecretPresence).toHaveBeenCalledWith(SOLARI_VAULT_KEY);
  });

  it('is false when the vault key is empty', async () => {
    vi.mocked(getSecretPresence).mockResolvedValue({ present: true, hint: '' });
    expect(await isSolariConfigured()).toBe(false);
  });

  it('is true when the vault key is present and non-empty', async () => {
    vi.mocked(getSecretPresence).mockResolvedValue({ present: true, hint: 'sk-…abcd' });
    expect(await isSolariConfigured()).toBe(true);
  });
});
