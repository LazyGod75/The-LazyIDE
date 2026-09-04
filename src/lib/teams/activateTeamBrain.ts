import { isTauri, getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import {
  writeActiveBrainConfig,
  clearActiveBrainConfig,
  type ActiveBrainConfig,
} from './activeBrainConfig.js';
import { provisionOneBrainRepo } from './githubConnect.js';
import { setBrainRepo, leaveOrg } from './orgApi.js';
import { readGitHubToken } from './githubOAuth.js';
import { resolveCaptureAuthorId, invalidateCaptureAuthor } from '../brain/captureAuthor.js';
import type { OrgRole } from './types.js';

export type BrainSeedMode = 'publish-existing' | 'empty' | 'clone-existing';

export interface ActivateTeamBrainResult {
  ok: boolean;
  localDir: string;
  message: string;
}

interface TeamGitResult {
  ok: boolean;
  action: string;
  message: string;
  repoUrl: string;
  localDir: string;
}

async function resolveTeamLocalDir(orgId: string): Promise<string> {
  const { appLocalDataDir } = await import('@tauri-apps/api/path');
  const base = await appLocalDataDir();
  return joinPath(base, 'lazy', 'teams', orgId, 'brain');
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

async function applyBrainConfig(mode: 'project' | 'custom', path?: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_brain_config', { mode, path });
}

async function pullRepo(
  repoUrl: string,
  localDir: string,
  token: string,
): Promise<TeamGitResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<TeamGitResult>('teams_pull_repo', { repoUrl, localDir, token });
  } catch (err) {
    return {
      ok: false,
      action: 'error',
      message: err instanceof Error ? err.message : String(err),
      repoUrl,
      localDir,
    };
  }
}

async function pushRepo(
  repoUrl: string,
  localDir: string,
  token: string,
  authorName: string,
  authorEmail: string,
  message: string,
): Promise<TeamGitResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<TeamGitResult>('teams_push_repo', {
      repoUrl,
      localDir,
      token,
      authorName,
      authorEmail,
      message,
    });
  } catch (err) {
    return {
      ok: false,
      action: 'error',
      message: err instanceof Error ? err.message : String(err),
      repoUrl,
      localDir,
    };
  }
}

function persistActiveConfig(orgId: string, repoUrl: string, localDir: string, role?: OrgRole): void {
  const config: ActiveBrainConfig = {
    orgId,
    repoUrl,
    localDir,
    lastPulledAt: Date.now(),
    lastPushedAt: 0,
    lastError: null,
    ...(role ? { role } : {}),
  };
  writeActiveBrainConfig(config);
}

async function archiveCurrentBrain(userId: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ path: string }>('get_brain_info');
    const { appLocalDataDir } = await import('@tauri-apps/api/path');
    const base = await appLocalDataDir();
    const archiveDir = joinPath(base, 'lazy', 'archives', userId, String(Date.now()));
    await invoke('teams_archive_copy', { src: info.path, dst: archiveDir });
  } catch (err) {
    console.warn('[activateTeamBrain] archive copy failed (best-effort):', err);
  }
}

export async function activateTeamBrainOnLogin(
  orgId: string,
  repoUrl: string,
): Promise<ActivateTeamBrainResult> {
  if (!isTauri()) {
    return { ok: false, localDir: '', message: 'Requires the desktop app' };
  }
  try {
    const localDir = await resolveTeamLocalDir(orgId);
    const gh = await getGitHubIdentity();
    if (!gh) {
      return { ok: false, localDir, message: 'GitHub not connected' };
    }
    const result = await pullRepo(repoUrl, localDir, gh.token);
    if (!result.ok) {
      return { ok: false, localDir, message: result.message };
    }
    await applyBrainConfig('custom', localDir);
    persistActiveConfig(orgId, repoUrl, localDir);
    return { ok: true, localDir, message: 'Team brain activated' };
  } catch (err) {
    return {
      ok: false,
      localDir: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function publishExistingBrainAsTeam(opts: {
  orgId: string;
  owner: string;
  repoName: string;
  token: string;
  isOrg?: boolean;
}): Promise<ActivateTeamBrainResult> {
  if (!isTauri()) {
    return { ok: false, localDir: '', message: 'Requires the desktop app' };
  }
  try {
    const { orgId, owner, repoName, token, isOrg } = opts;
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ path: string }>('get_brain_info');
    const currentBrainPath = info.path;

    const userId = await resolveCaptureAuthorId();
    if (userId) {
      await archiveCurrentBrain(userId);
    }

    const provisioned = await provisionOneBrainRepo({ owner, name: repoName, token, isOrg });
    const repoUrl = provisioned.repoUrl;
    const htmlUrl = provisioned.htmlUrl;

    const gh = await getGitHubIdentity();
    const authorName = gh?.login ?? owner;
    const authorEmail = gh?.email ?? `${owner}@users.noreply.github.com`;

    const pushResult = await pushRepo(
      repoUrl,
      currentBrainPath,
      token,
      authorName,
      authorEmail,
      'feat(lazybrain): publish existing brain as team brain',
    );
    if (!pushResult.ok) {
      return { ok: false, localDir: currentBrainPath, message: pushResult.message };
    }

    await applyBrainConfig('custom', currentBrainPath);

    const repoResult = await setBrainRepo(orgId, repoUrl, htmlUrl, 'publish-existing');
    if (!repoResult.success) {
      console.warn('[activateTeamBrain] setBrainRepo failed:', repoResult.error);
    }

    persistActiveConfig(orgId, repoUrl, currentBrainPath);
    return { ok: true, localDir: currentBrainPath, message: 'Brain published as team brain' };
  } catch (err) {
    return {
      ok: false,
      localDir: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function createEmptyTeamBrain(opts: {
  orgId: string;
  owner: string;
  repoName: string;
  token: string;
  isOrg?: boolean;
}): Promise<ActivateTeamBrainResult> {
  if (!isTauri()) {
    return { ok: false, localDir: '', message: 'Requires the desktop app' };
  }
  try {
    const { orgId, owner, repoName, token, isOrg } = opts;
    const localDir = await resolveTeamLocalDir(orgId);

    const platform = getPlatform();
    try {
      await platform.fs.createDir(localDir);
    } catch {
      // may already exist
    }

    await applyBrainConfig('custom', localDir);

    const provisioned = await provisionOneBrainRepo({ owner, name: repoName, token, isOrg });
    const repoUrl = provisioned.repoUrl;
    const htmlUrl = provisioned.htmlUrl;

    const gh = await getGitHubIdentity();
    const authorName = gh?.login ?? owner;
    const authorEmail = gh?.email ?? `${owner}@users.noreply.github.com`;

    const pushResult = await pushRepo(
      repoUrl,
      localDir,
      token,
      authorName,
      authorEmail,
      'feat(lazybrain): init empty team brain',
    );
    if (!pushResult.ok) {
      return { ok: false, localDir, message: pushResult.message };
    }

    const repoResult = await setBrainRepo(orgId, repoUrl, htmlUrl, 'empty');
    if (!repoResult.success) {
      console.warn('[activateTeamBrain] setBrainRepo failed:', repoResult.error);
    }

    persistActiveConfig(orgId, repoUrl, localDir);
    return { ok: true, localDir, message: 'Empty team brain created' };
  } catch (err) {
    return {
      ok: false,
      localDir: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function cloneExistingTeamBrain(opts: {
  orgId: string;
  repoUrl: string;
  token: string;
}): Promise<ActivateTeamBrainResult> {
  if (!isTauri()) {
    return { ok: false, localDir: '', message: 'Requires the desktop app' };
  }
  try {
    const { orgId, repoUrl, token } = opts;
    const localDir = await resolveTeamLocalDir(orgId);

    const result = await pullRepo(repoUrl, localDir, token);
    if (!result.ok) {
      return { ok: false, localDir, message: result.message };
    }

    await applyBrainConfig('custom', localDir);

    const htmlUrl = repoUrl.replace(/\.git$/, '');
    const repoResult = await setBrainRepo(orgId, repoUrl, htmlUrl, 'clone-existing');
    if (!repoResult.success) {
      console.warn('[activateTeamBrain] setBrainRepo failed:', repoResult.error);
    }

    persistActiveConfig(orgId, repoUrl, localDir);
    return { ok: true, localDir, message: 'Existing team brain cloned' };
  } catch (err) {
    return {
      ok: false,
      localDir: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function joinTeamBrain(
  orgId: string,
  repoUrl: string,
  token: string,
): Promise<ActivateTeamBrainResult> {
  if (!isTauri()) {
    return { ok: false, localDir: '', message: 'Requires the desktop app' };
  }
  try {
    const localDir = await resolveTeamLocalDir(orgId);
    const result = await pullRepo(repoUrl, localDir, token);
    if (!result.ok) {
      return { ok: false, localDir, message: result.message };
    }
    await applyBrainConfig('custom', localDir);
    persistActiveConfig(orgId, repoUrl, localDir);
    return { ok: true, localDir, message: 'Joined team brain' };
  } catch (err) {
    return {
      ok: false,
      localDir: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function findLatestArchive(userId: string): Promise<string | null> {
  try {
    const { appLocalDataDir } = await import('@tauri-apps/api/path');
    const base = await appLocalDataDir();
    const archivesBase = joinPath(base, 'lazy', 'archives', userId);
    const platform = getPlatform();
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = await platform.fs.readDir(archivesBase);
    } catch {
      return null;
    }
    const dirs = entries.filter((e) => e.isDir).map((e) => e.name);
    if (dirs.length === 0) return null;
    dirs.sort((a, b) => Number(b) - Number(a));
    return joinPath(archivesBase, dirs[0]);
  } catch {
    return null;
  }
}

export async function deactivateTeamBrain(): Promise<void> {
  try {
    if (!isTauri()) return;
    const userId = await resolveCaptureAuthorId();
    if (userId) {
      const archivePath = await findLatestArchive(userId);
      if (archivePath) {
        await applyBrainConfig('custom', archivePath);
        clearActiveBrainConfig();
        invalidateCaptureAuthor();
        return;
      }
    }
    await applyBrainConfig('project');
    clearActiveBrainConfig();
    invalidateCaptureAuthor();
  } catch (err) {
    console.warn('[activateTeamBrain] deactivateTeamBrain failed:', err);
  }
}

export async function switchTeamBrain(
  orgId: string,
  repoUrl: string,
  role?: OrgRole,
): Promise<ActivateTeamBrainResult> {
  if (!isTauri()) {
    return { ok: false, localDir: '', message: 'Requires the desktop app' };
  }
  try {
    const localDir = await resolveTeamLocalDir(orgId);
    const gh = await getGitHubIdentity();
    if (!gh) {
      return { ok: false, localDir, message: 'GitHub not connected' };
    }
    const result = await pullRepo(repoUrl, localDir, gh.token);
    if (!result.ok) {
      return { ok: false, localDir, message: result.message };
    }
    await applyBrainConfig('custom', localDir);
    persistActiveConfig(orgId, repoUrl, localDir, role);
    return { ok: true, localDir, message: 'Switched to team brain' };
  } catch (err) {
    return {
      ok: false,
      localDir: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface LeaveTeamBrainResult {
  ok: boolean;
  message: string;
  remindRevokeGithub: boolean;
}

export async function leaveTeamBrain(orgId: string): Promise<LeaveTeamBrainResult> {
  try {
    await deactivateTeamBrain();
    const result = await leaveOrg(orgId);
    if (!result.success) {
      return { ok: false, message: result.error, remindRevokeGithub: false };
    }
    return { ok: true, message: 'Left team brain', remindRevokeGithub: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      remindRevokeGithub: false,
    };
  }
}
