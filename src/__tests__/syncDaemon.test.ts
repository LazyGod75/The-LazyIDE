/**
 * syncDaemon.test.ts
 *
 * Coverage for the V2 single-repo sync daemon. The outbox system was removed;
 * the daemon now uses `activeBrainConfig` for single-repo pull/push via the
 * Rust transport (`teams_pull_repo` / `teams_push_repo`).
 *
 * Covers:
 *   1. syncStatus() — reports 'no_active_brain' when no config, or
 *      'github-brain' with the active repo's sync timestamps.
 *   2. runTeamPullCycle() — no-op gating (teamsActive false, no config, no
 *      token), real pull via Rust transport, up-to-date, failure backoff.
 *   3. runTeamPushCycle() — no-op gating, real push, nothing-to-push,
 *      failure.
 *   4. schedulePostCapturePush() — debounced push after a capture.
 *   5. startSyncDaemon — no-op gating, immediate pull on start, interval
 *      ticks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { teamsActive } from '../lib/features';

// ── journal mock ───────────────────────────────────────────────────
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

// ── platform mock — isTauri() overridden per test ──────────────────
const isTauriMock = vi.fn(() => true);

vi.mock('../lib/platform', () => ({
  isTauri: () => isTauriMock(),
  getPlatform: () => ({
    name: 'tauri',
    brain: {},
    fs: {},
  }),
}));

// ── features mock (teamsActive) — gates pull/push cycles ──────────
const teamsActiveMock = vi.fn<typeof teamsActive>(() => true);

vi.mock('../lib/features', () => ({
  teamsActive: (...args: Parameters<typeof teamsActive>) => teamsActiveMock(...args),
}));

// ── activeBrainConfig mock — the single-repo config source ────────
const readActiveBrainConfigMock = vi.fn<typeof readActiveBrainConfig>(() => null);
const writeActiveBrainConfigMock = vi.fn();

vi.mock('../lib/teams/activeBrainConfig', () => ({
  readActiveBrainConfig: () => readActiveBrainConfigMock(),
  writeActiveBrainConfig: (...args: unknown[]) => writeActiveBrainConfigMock(...args),
}));

// ── githubOAuth mock — the real transport reads the stored GitHub token ──
const readGitHubTokenMock = vi.fn();

vi.mock('../lib/teams/githubOAuth', () => ({
  readGitHubToken: (...args: unknown[]) => readGitHubTokenMock(...args),
}));

// ── @tauri-apps/api/core mock — teams_pull_repo / teams_push_repo ──
const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ── @tauri-apps/api/event mock — startSyncDaemon listens for push events ──
const listenMock = vi.fn().mockResolvedValue(() => {});

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { emitBuffered } from '../lib/journal/journal';
import {
  syncStatus,
  runTeamPullCycle,
  runTeamPushCycle,
  schedulePostCapturePush,
  startSyncDaemon,
  DEFAULT_SYNC_CONFIG,
} from '../lib/teams/syncDaemon';
import type { ActiveBrainConfig, readActiveBrainConfig } from '../lib/teams/activeBrainConfig';

const mockedEmitBuffered = vi.mocked(emitBuffered);

const SAMPLE_CONFIG: ActiveBrainConfig = {
  orgId: 'org-1',
  repoUrl: 'https://github.com/acme/dept-eng-brain',
  localDir: 'C:\\Users\\test\\AppData\\Local\\lazy\\teams\\dept-eng',
  lastPulledAt: 0,
  lastPushedAt: 0,
  lastError: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(true);
  teamsActiveMock.mockReturnValue(true);
  readActiveBrainConfigMock.mockReturnValue(null);
  writeActiveBrainConfigMock.mockImplementation(() => {});
  readGitHubTokenMock.mockResolvedValue({ token: 'gho_test_token', login: 'alice', email: 'alice@example.com', updatedAt: 0 });
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'teams_pull_repo') {
      return Promise.resolve({ ok: true, action: 'pulled', message: 'merged', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });
    }
    if (cmd === 'teams_push_repo') {
      return Promise.resolve({ ok: true, action: 'pushed', message: 'pushed', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });
    }
    if (cmd === 'brain_rebuild_graph') {
      return Promise.resolve(undefined);
    }
    if (cmd === 'brain_recompose_all') {
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
  listenMock.mockResolvedValue(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

// ── syncStatus ────────────────────────────────────────────────────────

describe('syncStatus', () => {
  it('reports no_active_brain when no config is set', () => {
    readActiveBrainConfigMock.mockReturnValue(null);
    expect(syncStatus()).toEqual({ transport: 'none', reason: 'no_active_brain' });
  });

  it('reports github-brain with the active repo sync timestamps when a config is set', () => {
    readActiveBrainConfigMock.mockReturnValue({ ...SAMPLE_CONFIG, lastPulledAt: 1000, lastPushedAt: 2000 });

    expect(syncStatus()).toEqual({
      transport: 'github-brain',
      repo: {
        repoUrl: SAMPLE_CONFIG.repoUrl,
        orgId: SAMPLE_CONFIG.orgId,
        lastPulledAt: 1000,
        lastPushedAt: 2000,
      },
    });
  });

  it('reports null timestamps for a freshly-configured repo that has never synced', () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);

    const status = syncStatus();
    expect(status.transport).toBe('github-brain');
    if (status.transport === 'github-brain') {
      expect(status.repo.lastPulledAt).toBeNull();
      expect(status.repo.lastPushedAt).toBeNull();
    }
  });
});

// ── runTeamPullCycle ───────────────────────────────────────────────────

describe('runTeamPullCycle', () => {
  it('is a zero-work no-op when no active brain config is set', async () => {
    readActiveBrainConfigMock.mockReturnValue(null);

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 0, skipped: 0, failed: 0 });
    expect(invokeMock).not.toHaveBeenCalledWith('teams_pull_repo', expect.anything());
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
  });

  it('is a zero-work no-op when teamsActive() is false, even with a config', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    teamsActiveMock.mockReturnValue(false);

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 0, skipped: 0, failed: 0 });
    expect(invokeMock).not.toHaveBeenCalledWith('teams_pull_repo', expect.anything());
  });

  it('skips when no GitHub token is connected yet', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    readGitHubTokenMock.mockResolvedValue(null);

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 0, skipped: 1, failed: 0 });
    expect(invokeMock).not.toHaveBeenCalledWith('teams_pull_repo', expect.anything());
  });

  it('pulls via the Rust transport and emits teams.pull on a real change', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockResolvedValue({ ok: true, action: 'pulled', message: 'merged origin/main', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 1, skipped: 0, failed: 0 });
    expect(invokeMock).toHaveBeenCalledWith('teams_pull_repo', {
      repoUrl: SAMPLE_CONFIG.repoUrl,
      localDir: SAMPLE_CONFIG.localDir,
      token: 'gho_test_token',
    });
    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'teams.pull', payload: { commit: SAMPLE_CONFIG.repoUrl } }),
    );
    expect(writeActiveBrainConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ lastPulledAt: expect.any(Number), lastError: null }),
    );
  });

  it('calls brain_rebuild_graph after a real pull with changes', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockResolvedValue({ ok: true, action: 'pulled', message: 'merged', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });

    await runTeamPullCycle();

    expect(invokeMock).toHaveBeenCalledWith('brain_rebuild_graph');
  });

  it('treats an up-to-date repo as success but emits no event and no rebuild', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockResolvedValue({ ok: true, action: 'up-to-date', message: 'no changes', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 1, skipped: 0, failed: 0 });
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('brain_rebuild_graph');
  });

  it('on a pull failure, persists lastError and emits no event', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockResolvedValue({ ok: false, action: 'error', message: 'network unreachable', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 0, skipped: 0, failed: 1 });
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
    expect(writeActiveBrainConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'network unreachable' }),
    );
  });

  it('treats a thrown invoke error as a failure with no event', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockRejectedValue(new Error('invoke crashed'));

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 0, skipped: 0, failed: 1 });
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
  });
});

// ── runTeamPushCycle ───────────────────────────────────────────────────

describe('runTeamPushCycle', () => {
  it('is a zero-work no-op when no active brain config is set', async () => {
    readActiveBrainConfigMock.mockReturnValue(null);

    const result = await runTeamPushCycle();

    expect(result).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(invokeMock).not.toHaveBeenCalledWith('teams_push_repo', expect.anything());
  });

  it('is a zero-work no-op when teamsActive() is false', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    teamsActiveMock.mockReturnValue(false);

    const result = await runTeamPushCycle();

    expect(result).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(invokeMock).not.toHaveBeenCalledWith('teams_push_repo', expect.anything());
  });

  it('skips when no GitHub identity is connected yet', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    readGitHubTokenMock.mockResolvedValue(null);

    const result = await runTeamPushCycle();

    expect(result).toEqual({ pushed: 0, skipped: 1, failed: 0 });
    expect(invokeMock).not.toHaveBeenCalledWith('teams_push_repo', expect.anything());
  });

  it('pushes via the Rust transport and emits teams.push on success', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockResolvedValue({ ok: true, action: 'pushed', message: 'pushed', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });

    const result = await runTeamPushCycle();

    expect(result).toEqual({ pushed: 1, skipped: 0, failed: 0 });
    expect(invokeMock).toHaveBeenCalledWith('teams_push_repo', {
      repoUrl: SAMPLE_CONFIG.repoUrl,
      localDir: SAMPLE_CONFIG.localDir,
      token: 'gho_test_token',
      authorName: 'alice',
      authorEmail: 'alice@example.com',
      message: 'feat(lazybrain): team brain sync',
    });
    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'teams.push', payload: { commit: SAMPLE_CONFIG.repoUrl } }),
    );
    expect(writeActiveBrainConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ lastPushedAt: expect.any(Number), lastError: null }),
    );
  });

  it('treats nothing-to-push as skipped with no event', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockResolvedValue({ ok: true, action: 'nothing-to-push', message: 'no changes', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });

    const result = await runTeamPushCycle();

    expect(result).toEqual({ pushed: 0, skipped: 1, failed: 0 });
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
  });

  it('on a push failure, persists lastError and emits no event', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);
    invokeMock.mockResolvedValue({ ok: false, action: 'error', message: 'push rejected: 401', repoUrl: SAMPLE_CONFIG.repoUrl, localDir: SAMPLE_CONFIG.localDir });

    const result = await runTeamPushCycle();

    expect(result).toEqual({ pushed: 0, skipped: 0, failed: 1 });
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
    expect(writeActiveBrainConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: 'push rejected: 401' }),
    );
  });
});

// ── schedulePostCapturePush ────────────────────────────────────────────

describe('schedulePostCapturePush', () => {
  it('is a no-op outside Tauri', () => {
    isTauriMock.mockReturnValue(false);
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);

    schedulePostCapturePush();

    expect(invokeMock).not.toHaveBeenCalledWith('teams_push_repo', expect.anything());
  });

  it('is a no-op when no active brain config is set', () => {
    readActiveBrainConfigMock.mockReturnValue(null);

    schedulePostCapturePush();

    expect(invokeMock).not.toHaveBeenCalledWith('teams_push_repo', expect.anything());
  });

  it('schedules a push after 3s debounce', async () => {
    vi.useFakeTimers();
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);

    schedulePostCapturePush();

    expect(invokeMock).not.toHaveBeenCalledWith('teams_push_repo', expect.anything());

    await vi.advanceTimersByTimeAsync(3000);

    expect(invokeMock).toHaveBeenCalledWith('teams_push_repo', expect.anything());
  });

  it('debounces: a second call within 3s cancels the first timer', async () => {
    vi.useFakeTimers();
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);

    schedulePostCapturePush();
    schedulePostCapturePush();

    await vi.advanceTimersByTimeAsync(3000);

    expect(invokeMock.mock.calls.filter((c) => c[0] === 'teams_push_repo')).toHaveLength(1);
  });
});

// ── startSyncDaemon ────────────────────────────────────────────────────

describe('startSyncDaemon', () => {
  it('is a no-op when config.enabled is false', () => {
    const stop = startSyncDaemon({ ...DEFAULT_SYNC_CONFIG, enabled: false });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('is a no-op outside Tauri', () => {
    isTauriMock.mockReturnValue(false);
    const stop = startSyncDaemon(DEFAULT_SYNC_CONFIG);
    stop();
  });

  it('is a no-op when teamsActive() is false', () => {
    teamsActiveMock.mockReturnValue(false);
    const stop = startSyncDaemon(DEFAULT_SYNC_CONFIG);
    stop();
  });

  it('pulls immediately on start, then again on every interval tick', async () => {
    vi.useFakeTimers();
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);

    const stop = startSyncDaemon({ enabled: true, intervalMs: 5000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(invokeMock).toHaveBeenCalledWith('teams_pull_repo', expect.objectContaining({ repoUrl: SAMPLE_CONFIG.repoUrl }));

    await vi.advanceTimersByTimeAsync(5000);
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'teams_pull_repo').length).toBeGreaterThanOrEqual(2);

    stop();
  });

  it('does not pull on start when config.enabled is false', async () => {
    readActiveBrainConfigMock.mockReturnValue(SAMPLE_CONFIG);

    const stop = startSyncDaemon({ ...DEFAULT_SYNC_CONFIG, enabled: false });
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalledWith('teams_pull_repo', expect.anything());
    stop();
  });
});
