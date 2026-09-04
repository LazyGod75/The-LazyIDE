/**
 * reportAppVersion.test.ts
 *
 * Unit tests for src/lib/billing/useSubscription.ts's reportAppVersion —
 * the fire-and-forget version-telemetry ping. It now calls the
 * `record_app_version` RPC instead of `.from('profiles').update(...)`:
 * direct client UPDATE on public.profiles is revoked (see
 * supabase/migrations/20260724235553_revoke_public_execute_and_lock_profile_writes.sql),
 * so the RPC (SECURITY DEFINER, auth.uid()-scoped) is now the only write
 * path. Mocks the Supabase client at the module boundary and asserts
 * the exact RPC name + params.
 *
 * The "updated_from reported at most once per launch" guard lives in
 * module-level state (updatedFromChecked in useSubscription.ts), so each
 * test gets a fresh module instance via vi.resetModules() + a dynamic
 * import — except the dedicated "only once" test below, which calls
 * reportAppVersion twice against the SAME module instance on purpose.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const getUpdaterStateMock = vi.fn();
const telemetryEnabledMock = vi.fn();

vi.mock('../lib/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('../lib/updater', () => ({
  getUpdaterState: (...args: unknown[]) => getUpdaterStateMock(...args),
}));

// Task A (2026-08-12 privacy audit): reportAppVersion is now gated on a
// user-controllable opt-out (telemetryPrefs.ts). Mocked at the module
// boundary, same convention as the two mocks above — see the dedicated
// "telemetry opt-out" describe block below.
vi.mock('../lib/billing/telemetryPrefs', () => ({
  loadVersionTelemetryEnabled: (...args: unknown[]) => telemetryEnabledMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  // Default to enabled so the pre-existing tests below (written before the
  // opt-out existed) keep exercising the "telemetry on" path unchanged.
  telemetryEnabledMock.mockReturnValue(true);
});

async function loadReportAppVersion() {
  const mod = await import('../lib/billing/useSubscription');
  return mod.reportAppVersion;
}

describe('reportAppVersion', () => {
  it('calls record_app_version with the running version and no updated_from when no update was just applied', async () => {
    getUpdaterStateMock.mockResolvedValue({ updateApplied: null });
    rpcMock.mockResolvedValue({ data: null, error: null });

    const reportAppVersion = await loadReportAppVersion();
    await reportAppVersion('user-1');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('record_app_version', {
      p_version: expect.any(String),
      p_updated_from: null,
    });
  });

  it('includes updated_from on the first call after a boot-time update was applied', async () => {
    getUpdaterStateMock.mockResolvedValue({ updateApplied: { fromVersion: '0.1.10' } });
    rpcMock.mockResolvedValue({ data: null, error: null });

    const reportAppVersion = await loadReportAppVersion();
    await reportAppVersion('user-1');

    expect(rpcMock).toHaveBeenCalledWith('record_app_version', {
      p_version: expect.any(String),
      p_updated_from: '0.1.10',
    });
  });

  it('sends updated_from only once per launch — a second call in the same session omits it', async () => {
    getUpdaterStateMock.mockResolvedValue({ updateApplied: { fromVersion: '0.1.10' } });
    rpcMock.mockResolvedValue({ data: null, error: null });

    const reportAppVersion = await loadReportAppVersion();
    await reportAppVersion('user-1');
    await reportAppVersion('user-1');

    expect(rpcMock).toHaveBeenNthCalledWith(1, 'record_app_version', {
      p_version: expect.any(String),
      p_updated_from: '0.1.10',
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, 'record_app_version', {
      p_version: expect.any(String),
      p_updated_from: null,
    });
    // getUpdaterState is consulted at most once per launch, not once per call.
    expect(getUpdaterStateMock).toHaveBeenCalledTimes(1);
  });

  it('never propagates an RPC error response — warns and resolves', async () => {
    getUpdaterStateMock.mockResolvedValue({ updateApplied: null });
    rpcMock.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reportAppVersion = await loadReportAppVersion();
    await expect(reportAppVersion('user-1')).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('never propagates a thrown/rejected RPC call — warns and resolves', async () => {
    getUpdaterStateMock.mockResolvedValue({ updateApplied: null });
    rpcMock.mockRejectedValue(new Error('network down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reportAppVersion = await loadReportAppVersion();
    await expect(reportAppVersion('user-1')).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('never propagates a getUpdaterState failure — warns, still reports the version without updated_from', async () => {
    getUpdaterStateMock.mockRejectedValue(new Error('IPC unavailable'));
    rpcMock.mockResolvedValue({ data: null, error: null });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reportAppVersion = await loadReportAppVersion();
    await expect(reportAppVersion('user-1')).resolves.toBeUndefined();

    expect(rpcMock).toHaveBeenCalledWith('record_app_version', {
      p_version: expect.any(String),
      p_updated_from: null,
    });
    warnSpy.mockRestore();
  });
});

// ── Task A: user-controllable telemetry opt-out ─────────────────────────
//
// Settings > General's "Report app version" toggle (SettingsSpace.tsx's
// TelemetrySection) writes through telemetryPrefs.ts's
// saveVersionTelemetryEnabled(); reportAppVersion reads it back via
// loadVersionTelemetryEnabled() — mocked above — as the very first thing it
// does, before even resolveUpdatedFromOnce(), so a disabled toggle produces
// zero side effects at all.
describe('reportAppVersion — telemetry opt-out', () => {
  it('never calls record_app_version when telemetry is disabled', async () => {
    telemetryEnabledMock.mockReturnValue(false);
    getUpdaterStateMock.mockResolvedValue({ updateApplied: null });
    rpcMock.mockResolvedValue({ data: null, error: null });

    const reportAppVersion = await loadReportAppVersion();
    await reportAppVersion('user-1');

    expect(rpcMock).not.toHaveBeenCalled();
    // Not just "no RPC" — nothing downstream of the guard runs either, so
    // there is no discarded response and no wasted IPC call.
    expect(getUpdaterStateMock).not.toHaveBeenCalled();
  });

  it('calls record_app_version when telemetry is enabled (the default)', async () => {
    telemetryEnabledMock.mockReturnValue(true);
    getUpdaterStateMock.mockResolvedValue({ updateApplied: null });
    rpcMock.mockResolvedValue({ data: null, error: null });

    const reportAppVersion = await loadReportAppVersion();
    await reportAppVersion('user-1');

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('record_app_version', {
      p_version: expect.any(String),
      p_updated_from: null,
    });
  });

  it('checks the toggle on every call, not just the first', async () => {
    getUpdaterStateMock.mockResolvedValue({ updateApplied: null });
    rpcMock.mockResolvedValue({ data: null, error: null });
    const reportAppVersion = await loadReportAppVersion();

    telemetryEnabledMock.mockReturnValue(false);
    await reportAppVersion('user-1');
    expect(rpcMock).not.toHaveBeenCalled();

    // Flipped back on mid-session (the toggle is read live, not cached) —
    // the very next call must fire.
    telemetryEnabledMock.mockReturnValue(true);
    await reportAppVersion('user-1');
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});
