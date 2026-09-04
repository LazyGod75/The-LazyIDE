import { isTauri } from '../platform/index.js';
import { teamsActive } from '../features.js';
import { emitBuffered } from '../journal/journal.js';
import {
  readActiveBrainConfig,
  writeActiveBrainConfig,
} from './activeBrainConfig.js';
import { readGitHubToken } from './githubOAuth.js';

interface TeamGitResult {
  ok: boolean;
  action: string;
  message: string;
  repoUrl: string;
  localDir: string;
}

export interface TeamRepoSyncStatus {
  repoUrl: string;
  orgId: string;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
}

export type SyncStatus =
  | { transport: 'none'; reason: 'no_active_brain' }
  | { transport: 'github-brain'; repo: TeamRepoSyncStatus };

export interface SyncDaemonConfig {
  enabled: boolean;
  intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 60_000;

export const DEFAULT_SYNC_CONFIG: SyncDaemonConfig = {
  enabled: true,
  intervalMs: DEFAULT_INTERVAL_MS,
};

export function syncStatus(): SyncStatus {
  const config = readActiveBrainConfig();
  if (!config) {
    return { transport: 'none', reason: 'no_active_brain' };
  }
  return {
    transport: 'github-brain',
    repo: {
      repoUrl: config.repoUrl,
      orgId: config.orgId,
      lastPulledAt: config.lastPulledAt || null,
      lastPushedAt: config.lastPushedAt || null,
    },
  };
}

async function getSyncGitHubToken(): Promise<string | null> {
  try {
    const stored = await readGitHubToken();
    return stored?.token ?? null;
  } catch {
    return null;
  }
}

async function getGitHubIdentity(): Promise<{
  login: string;
  email: string;
  token: string;
} | null> {
  try {
    const store = await readGitHubToken();
    if (!store) return null;
    return {
      login: store.login,
      email: store.email ?? `${store.login}@users.noreply.github.com`,
      token: store.token,
    };
  } catch {
    return null;
  }
}

export interface TeamPullCycleResult {
  pulled: number;
  skipped: number;
  failed: number;
}

export async function runTeamPullCycle(): Promise<TeamPullCycleResult> {
  try {
    if (!teamsActive()) return { pulled: 0, skipped: 0, failed: 0 };

    const config = readActiveBrainConfig();
    if (!config) return { pulled: 0, skipped: 0, failed: 0 };

    const token = await getSyncGitHubToken();
    if (!token) return { pulled: 0, skipped: 1, failed: 0 };

    const { invoke } = await import('@tauri-apps/api/core');
    let result: TeamGitResult;
    try {
      result = await invoke<TeamGitResult>('teams_pull_repo', {
        repoUrl: config.repoUrl,
        localDir: config.localDir,
        token,
      });
    } catch (err) {
      result = {
        ok: false,
        action: 'error',
        message: err instanceof Error ? err.message : String(err),
        repoUrl: config.repoUrl,
        localDir: config.localDir,
      };
    }

    if (result.ok) {
      writeActiveBrainConfig({
        ...config,
        lastPulledAt: Date.now(),
        lastError: null,
      });
      if (result.action !== 'up-to-date') {
        emitBuffered({
          tsMs: Date.now(),
          projectId: '*',
          actor: 'system',
          type: 'teams.pull',
          payload: { commit: config.repoUrl },
        });
        try {
          await invoke('brain_rebuild_graph');
        } catch {
          // best-effort — index rebuild failure must not undo a real pull
        }
        try {
          await invoke('brain_recompose_all');
        } catch {
          // best-effort — recompose failure must not undo a real pull
        }
      }
      return { pulled: 1, skipped: 0, failed: 0 };
    }

    writeActiveBrainConfig({ ...config, lastError: result.message });
    return { pulled: 0, skipped: 0, failed: 1 };
  } catch {
    return { pulled: 0, skipped: 0, failed: 0 };
  }
}

export interface TeamPushCycleResult {
  pushed: number;
  skipped: number;
  failed: number;
}

export async function runTeamPushCycle(): Promise<TeamPushCycleResult> {
  try {
    if (!teamsActive()) return { pushed: 0, skipped: 0, failed: 0 };

    const config = readActiveBrainConfig();
    if (!config) return { pushed: 0, skipped: 0, failed: 0 };

    const gh = await getGitHubIdentity();
    if (!gh) return { pushed: 0, skipped: 1, failed: 0 };

    const { invoke } = await import('@tauri-apps/api/core');
    let result: TeamGitResult;
    try {
      result = await invoke<TeamGitResult>('teams_push_repo', {
        repoUrl: config.repoUrl,
        localDir: config.localDir,
        token: gh.token,
        authorName: gh.login,
        authorEmail: gh.email,
        message: 'feat(lazybrain): team brain sync',
      });
    } catch (err) {
      result = {
        ok: false,
        action: 'error',
        message: err instanceof Error ? err.message : String(err),
        repoUrl: config.repoUrl,
        localDir: config.localDir,
      };
    }

    if (result.ok && result.action === 'pushed') {
      writeActiveBrainConfig({
        ...config,
        lastPushedAt: Date.now(),
        lastError: null,
      });
      emitBuffered({
        tsMs: Date.now(),
        projectId: '*',
        actor: 'system',
        type: 'teams.push',
        payload: { commit: config.repoUrl },
      });
      return { pushed: 1, skipped: 0, failed: 0 };
    }

    if (result.ok) {
      return { pushed: 0, skipped: 1, failed: 0 };
    }

    writeActiveBrainConfig({ ...config, lastError: result.message });
    return { pushed: 0, skipped: 0, failed: 1 };
  } catch {
    return { pushed: 0, skipped: 0, failed: 0 };
  }
}

let postCaptureTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePostCapturePush(): void {
  if (!isTauri()) return;
  const config = readActiveBrainConfig();
  if (!config) return;

  if (postCaptureTimer !== null) {
    clearTimeout(postCaptureTimer);
  }
  postCaptureTimer = setTimeout(() => {
    postCaptureTimer = null;
    void runTeamPushCycle();
  }, 3000);
}

export function startSyncDaemon(
  config: SyncDaemonConfig = DEFAULT_SYNC_CONFIG,
): () => void {
  if (!config.enabled || !isTauri()) {
    return () => {};
  }

  if (!teamsActive()) {
    return () => {};
  }

  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await runTeamPullCycle();
      await runTeamPushCycle();
    } catch {
      // best-effort
    } finally {
      inFlight = false;
    }
  };

  void runTeamPullCycle();

  const interval = setInterval(() => {
    void tick();
  }, config.intervalMs);

  const onFocus = (): void => {
    if (!stopped) void tick();
  };
  window.addEventListener('focus', onFocus);

  let unlistenPush: (() => void) | null = null;
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlistenPush = await listen('team-brain-needs-push', () => {
        if (!stopped) void runTeamPushCycle();
      });
    } catch {
      // best-effort — event listener is optional
    }
  })();

  return () => {
    stopped = true;
    clearInterval(interval);
    window.removeEventListener('focus', onFocus);
    if (unlistenPush) unlistenPush();
  };
}
