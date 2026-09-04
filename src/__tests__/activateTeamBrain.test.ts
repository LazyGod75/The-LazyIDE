/**
 * activateTeamBrain.test.ts
 *
 * Unit tests for the team brain activation lifecycle:
 *   1. activateTeamBrainOnLogin — clones if needed, applies brain config,
 *      persists active.json.
 *   2. publishExistingBrainAsTeam — archives current brain, provisions repo,
 *      pushes the EXISTING brain path (not a new empty dir), saves URL.
 *   3. deactivateTeamBrain — switches to project mode, clears active config.
 *   4. deactivateTeamBrain with archive — switches to the archive path.
 *   5. switchTeamBrain — activates for a different org.
 *
 * Mocks: @tauri-apps/api/core (invoke), @tauri-apps/api/path, platform,
 * provisionOneBrainRepo, setBrainRepo, readGitHubToken, captureAuthor,
 * activeBrainConfig.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (vi.mock factories are hoisted above imports) ───────
const mocks = vi.hoisted(() => {
  return {
    invoke: vi.fn(),
    appLocalDataDir: vi.fn(async () => 'C:\\Users\\test\\AppData\\Local'),
    isTauri: vi.fn(() => true),
    readDir: vi.fn<() => Promise<{ name: string; isDir: boolean }[]>>(async () => []),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async () => undefined),
    createDir: vi.fn(async () => undefined),
    provisionOneBrainRepo: vi.fn(),
    setBrainRepo: vi.fn(async () => ({ success: true, data: {} })),
    leaveOrg: vi.fn(async () => ({ success: true, data: { left: true } })),
    readGitHubToken: vi.fn(),
    resolveCaptureAuthorId: vi.fn(async () => 'user-uuid-1'),
    invalidateCaptureAuthor: vi.fn(),
    writeActiveBrainConfig: vi.fn(),
    clearActiveBrainConfig: vi.fn(),
    readActiveBrainConfig: vi.fn(() => null),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: () => mocks.appLocalDataDir(),
}));

vi.mock('../lib/platform/index.js', () => ({
  isTauri: () => mocks.isTauri(),
  getPlatform: () => ({
    name: 'tauri',
    fs: {
      readDir: mocks.readDir,
      readFile: mocks.readFile,
      writeFile: mocks.writeFile,
      createDir: mocks.createDir,
    },
  }),
}));

vi.mock('../lib/teams/githubConnect.js', () => ({
  provisionOneBrainRepo: mocks.provisionOneBrainRepo,
}));

vi.mock('../lib/teams/orgApi.js', () => ({
  setBrainRepo: mocks.setBrainRepo,
  leaveOrg: mocks.leaveOrg,
}));

vi.mock('../lib/teams/githubOAuth.js', () => ({
  readGitHubToken: mocks.readGitHubToken,
}));

vi.mock('../lib/brain/captureAuthor.js', () => ({
  resolveCaptureAuthorId: mocks.resolveCaptureAuthorId,
  invalidateCaptureAuthor: mocks.invalidateCaptureAuthor,
}));

vi.mock('../lib/teams/activeBrainConfig.js', () => ({
  writeActiveBrainConfig: mocks.writeActiveBrainConfig,
  clearActiveBrainConfig: mocks.clearActiveBrainConfig,
  readActiveBrainConfig: mocks.readActiveBrainConfig,
}));

import {
  activateTeamBrainOnLogin,
  publishExistingBrainAsTeam,
  deactivateTeamBrain,
  switchTeamBrain,
} from '../lib/teams/activateTeamBrain.js';

const ORG_ID = 'org-uuid-1';
const REPO_URL = 'https://github.com/acme/lazy-brain.git';
const TOKEN = 'gho_test_token';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true);
  mocks.invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_brain_info') return Promise.resolve({ path: 'C:\\brain' });
    if (cmd === 'set_brain_config') return Promise.resolve(undefined);
    if (cmd === 'teams_pull_repo') {
      return Promise.resolve({ ok: true, action: 'pulled', message: 'ok', repoUrl: REPO_URL, localDir: 'C:\\dir' });
    }
    if (cmd === 'teams_push_repo') {
      return Promise.resolve({ ok: true, action: 'pushed', message: 'ok', repoUrl: REPO_URL, localDir: 'C:\\brain' });
    }
    if (cmd === 'read_text_file') return Promise.resolve('{}');
    if (cmd === 'write_file') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
  mocks.readGitHubToken.mockResolvedValue({
    token: TOKEN,
    login: 'alice',
    email: 'alice@example.com',
    updatedAt: 0,
  });
  mocks.provisionOneBrainRepo.mockResolvedValue({
    repoUrl: REPO_URL,
    htmlUrl: 'https://github.com/acme/lazy-brain',
  });
  mocks.setBrainRepo.mockResolvedValue({ success: true, data: {} });
  mocks.resolveCaptureAuthorId.mockResolvedValue('user-uuid-1');
  mocks.readDir.mockResolvedValue([]);
  mocks.readFile.mockResolvedValue('');
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.createDir.mockResolvedValue(undefined);
});

// ── activateTeamBrainOnLogin ──────────────────────────────────────────

describe('activateTeamBrainOnLogin', () => {
  it('clones via teams_pull_repo, applies brain config, and persists active.json', async () => {
    const result = await activateTeamBrainOnLogin(ORG_ID, REPO_URL);

    expect(result.ok).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('teams_pull_repo', expect.objectContaining({ repoUrl: REPO_URL, token: TOKEN }));
    expect(mocks.invoke).toHaveBeenCalledWith('set_brain_config', expect.objectContaining({ mode: 'custom' }));
    expect(mocks.writeActiveBrainConfig).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, repoUrl: REPO_URL }));
  });

  it('returns ok:false when GitHub is not connected', async () => {
    mocks.readGitHubToken.mockResolvedValue(null);

    const result = await activateTeamBrainOnLogin(ORG_ID, REPO_URL);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('GitHub');
  });

  it('returns ok:false when the pull fails', async () => {
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'teams_pull_repo') return Promise.resolve({ ok: false, action: 'error', message: 'network down', repoUrl: REPO_URL, localDir: 'C:\\dir' });
      return Promise.resolve(undefined);
    });

    const result = await activateTeamBrainOnLogin(ORG_ID, REPO_URL);

    expect(result.ok).toBe(false);
    expect(result.message).toBe('network down');
  });
});

// ── publishExistingBrainAsTeam ────────────────────────────────────────

describe('publishExistingBrainAsTeam', () => {
  it('archives the current brain, provisions a repo, pushes the EXISTING brain path, and saves the URL', async () => {
    const existingPath = 'C:\\Users\\alice\\brain';
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_brain_info') return Promise.resolve({ path: existingPath });
      if (cmd === 'teams_push_repo') {
        return Promise.resolve({ ok: true, action: 'pushed', message: 'ok', repoUrl: REPO_URL, localDir: existingPath });
      }
      return Promise.resolve(undefined);
    });

    const result = await publishExistingBrainAsTeam({
      orgId: ORG_ID,
      owner: 'acme',
      repoName: 'lazy-brain',
      token: TOKEN,
    });

    expect(result.ok).toBe(true);
    expect(result.localDir).toBe(existingPath);

    // The push MUST use the existing brain path, NOT a new empty dir.
    expect(mocks.invoke).toHaveBeenCalledWith('teams_push_repo', expect.objectContaining({ localDir: existingPath }));

    // The archive copy happens before the push (teams_archive_copy invoke).
    expect(mocks.invoke).toHaveBeenCalledWith('teams_archive_copy', expect.objectContaining({ src: existingPath }));

    // setBrainRepo is called to persist the URL server-side.
    expect(mocks.setBrainRepo).toHaveBeenCalledWith(ORG_ID, REPO_URL, expect.any(String), 'publish-existing');

    // active.json is persisted with the existing path.
    expect(mocks.writeActiveBrainConfig).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, repoUrl: REPO_URL, localDir: existingPath }));
  });

  it('does NOT create an empty brain — uses the existing brain path for the push', async () => {
    const existingPath = 'C:\\Users\\alice\\Documents\\brain';
    const pushCalls: string[] = [];
    mocks.invoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'get_brain_info') return Promise.resolve({ path: existingPath });
      if (cmd === 'teams_push_repo') {
        const a = args as { localDir: string };
        pushCalls.push(a.localDir);
        return Promise.resolve({ ok: true, action: 'pushed', message: 'ok', repoUrl: REPO_URL, localDir: existingPath });
      }
      return Promise.resolve(undefined);
    });

    const result = await publishExistingBrainAsTeam({
      orgId: ORG_ID,
      owner: 'acme',
      repoName: 'lazy-brain',
      token: TOKEN,
    });

    expect(result.ok).toBe(true);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toBe(existingPath);
  });
});

// ── deactivateTeamBrain ───────────────────────────────────────────────

describe('deactivateTeamBrain', () => {
  it('switches to project mode and clears the active config when no archive exists', async () => {
    mocks.readDir.mockResolvedValue([]);

    await deactivateTeamBrain();

    expect(mocks.invoke).toHaveBeenCalledWith('set_brain_config', expect.objectContaining({ mode: 'project' }));
    expect(mocks.clearActiveBrainConfig).toHaveBeenCalled();
    expect(mocks.invalidateCaptureAuthor).toHaveBeenCalled();
  });

  it('switches to the archive path when an archive exists', async () => {
    const archiveDir = '1700000000000';
    mocks.readDir.mockResolvedValue([{ name: archiveDir, isDir: true }]);

    await deactivateTeamBrain();

    expect(mocks.invoke).toHaveBeenCalledWith('set_brain_config', expect.objectContaining({ mode: 'custom', path: expect.stringContaining(archiveDir) }));
    expect(mocks.clearActiveBrainConfig).toHaveBeenCalled();
    expect(mocks.invalidateCaptureAuthor).toHaveBeenCalled();
  });
});

// ── switchTeamBrain ───────────────────────────────────────────────────

describe('switchTeamBrain', () => {
  it('activates the team brain for a different org', async () => {
    const otherOrgId = 'org-uuid-2';
    const otherRepoUrl = 'https://github.com/acme/other-brain.git';

    const result = await switchTeamBrain(otherOrgId, otherRepoUrl, 'member');

    expect(result.ok).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith('teams_pull_repo', expect.objectContaining({ repoUrl: otherRepoUrl, token: TOKEN }));
    expect(mocks.invoke).toHaveBeenCalledWith('set_brain_config', expect.objectContaining({ mode: 'custom' }));
    expect(mocks.writeActiveBrainConfig).toHaveBeenCalledWith(expect.objectContaining({ orgId: otherOrgId, repoUrl: otherRepoUrl, role: 'member' }));
  });
});
