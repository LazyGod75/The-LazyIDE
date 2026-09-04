/**
 * byokVaultInit.perf.test.ts
 *
 * Measures the actual wall-clock SHAPE of `initByokVault()` — the call
 * `src/main.tsx` awaits before its first `createRoot().render()` (perf
 * audit 2026-08-15, item 2). That call site used to carry a comment
 * asserting the cost was "negligible" without ever measuring it. This test
 * cannot reach real OS-credential-vault IPC latency (no live Tauri desktop
 * process exists in a vitest/CI run — see main.tsx's own updated comment
 * for why that number has to come from a real desktop boot instead), but it
 * CAN and does measure the one thing fully under this codebase's control:
 * whether `initByokVault()` fetches each BYOK provider's secret in PARALLEL
 * (wall time ~= one round trip) or SERIALLY (wall time ~= N round trips).
 * That distinction is the difference between "a few ms regardless of
 * provider count" and "grows linearly with every new BYOK provider added" —
 * exactly the kind of latent regression a future provider addition could
 * introduce silently.
 *
 * Verdict encoded by the assertions below: `initByokVault()` is parallel
 * (Promise.allSettled over BYOK_PROVIDER_DEFS in byokProviders.ts) — wall
 * time stays close to a SINGLE simulated round trip even with real
 * production provider counts, confirming the await in main.tsx does not
 * scale with the provider list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

describe('initByokVault — parallel vs serial shape (no real vault IPC latency available in this suite)', () => {
  const originalTauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

  beforeEach(() => {
    localStorage.clear();
    mocks.invoke.mockReset();
    // Simulate the desktop runtime so byokProviders.ts's isTauriRuntime()
    // check takes the vault path instead of the browser no-op path.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalTauriInternals;
    vi.restoreAllMocks();
  });

  it('fetches every BYOK provider secret in parallel: wall time stays near ONE simulated round trip, not N', async () => {
    const { BYOK_PROVIDER_DEFS } = await import('../lib/models/byokProviders.js');
    const { initByokVault, resetByokVaultCacheForTests } = await import('../lib/models/byokProviders.js');
    resetByokVaultCacheForTests();

    const providerCount = BYOK_PROVIDER_DEFS.length;
    expect(providerCount).toBeGreaterThanOrEqual(7); // sanity: this is measuring a real, non-trivial fan-out

    const SIMULATED_ROUND_TRIP_MS = 20;
    mocks.invoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          setTimeout(() => {
            // secret_get (per-provider vault read) resolves null (no key
            // configured) — same shape as a fresh install with nothing
            // migrated yet.
            resolve(cmd === 'secret_get' ? null : undefined);
          }, SIMULATED_ROUND_TRIP_MS);
        }),
    );

    const start = performance.now();
    await initByokVault();
    const elapsed = performance.now() - start;

    // secret_get is called once per provider (parallel via Promise.allSettled
    // in initByokVault) — confirms the fan-out width this timing claim rests on.
    const secretGetCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === 'secret_get');
    expect(secretGetCalls).toHaveLength(providerCount);

    // eslint-disable-next-line no-console
    console.info(
      `[perf] initByokVault(): ${providerCount} providers, ${SIMULATED_ROUND_TRIP_MS}ms simulated round trip each, ` +
        `measured wall time = ${elapsed.toFixed(1)}ms`,
    );

    // Serial would cost providerCount * SIMULATED_ROUND_TRIP_MS (>= 140ms for
    // 7 providers); parallel stays within ~2 round trips of headroom for
    // event-loop/microtask scheduling jitter.
    const serialWorstCase = providerCount * SIMULATED_ROUND_TRIP_MS;
    const parallelBudget = SIMULATED_ROUND_TRIP_MS * 2;
    expect(elapsed).toBeLessThan(parallelBudget);
    expect(elapsed).toBeLessThan(serialWorstCase);
  });

  it('steady-state migration (nothing left in localStorage) makes zero vault-write IPC calls — only the parallel secret_get reads', async () => {
    const { initByokVault, resetByokVaultCacheForTests } = await import('../lib/models/byokProviders.js');
    resetByokVaultCacheForTests();
    mocks.invoke.mockResolvedValue(null);

    await initByokVault();

    const commandsCalled = new Set(mocks.invoke.mock.calls.map(([cmd]) => cmd));
    expect(commandsCalled.has('secret_set')).toBe(false); // migrateByokKeysToVault: nothing to migrate, no writes
    expect(commandsCalled.has('secret_get')).toBe(true); // the per-provider cache warm still runs
  });
});
