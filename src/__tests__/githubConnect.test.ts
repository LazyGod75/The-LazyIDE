/**
 * githubConnect.test.ts
 *
 * Coverage for:
 *   1. provisionTeamBrainRepo's publish step (the .gitattributes
 *      union-merge write was removed — ensureUnionMergeGitattributes is
 *      now a no-op; these tests verify the publish still works without it)
 *   2. Gating (non-Tauri, missing entitlement) short-circuits before any
 *      fs/brain call.
 *   3. Existing teams.push / teams.pull emission on real publish/import
 *      success (regression guard — intentionally UNCHANGED by this fix:
 *      these already correspond to real Rust git operations via
 *      brain_publish_github/import_brain_from_github, unlike syncDaemon
 *      .ts's removed fabricated events).
 *   4. connectTeamBrainRepo basic gating + happy path (previously
 *      completely uncovered — no test file existed for this module).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── journal mock ──────────────────────────────────────────────────────
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

// ── platform mock — isTauri()/getPlatform() overridden per test ───────
const isTauriMock = vi.fn(() => true);
const infoMock = vi.fn();
const publishGithubMock = vi.fn();
const importFromGithubMock = vi.fn();
const setConfigMock = vi.fn();
const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const readDirMock = vi.fn();

vi.mock('../lib/platform', () => ({
  isTauri: () => isTauriMock(),
  getPlatform: () => ({
    name: 'tauri',
    brain: {
      info: (...args: unknown[]) => infoMock(...args),
      publishGithub: (...args: unknown[]) => publishGithubMock(...args),
      importFromGithub: (...args: unknown[]) => importFromGithubMock(...args),
      setConfig: (...args: unknown[]) => setConfigMock(...args),
    },
    fs: {
      readFile: (...args: unknown[]) => readFileMock(...args),
      writeFile: (...args: unknown[]) => writeFileMock(...args),
      readDir: (...args: unknown[]) => readDirMock(...args),
    },
  }),
}));

// ── entitlements mock ─────────────────────────────────────────────────
const getEntitlementsMock = vi.fn(() => ({
  features: { canUseRootTrunk: true, canUseTeamSearch: true },
}));

vi.mock('../lib/entitlements/unifiedEntitlement', () => ({
  getEntitlements: () => getEntitlementsMock(),
}));

import { emitBuffered } from '../lib/journal/journal';
import {
  provisionTeamBrainRepo,
  connectTeamBrainRepo,
  syncTeamBrainRepo,
  getTeamRepos,
  addTeamRepo,
  updateTeamRepo,
  removeTeamRepo,
  pullTeamRepo,
  type TeamRepoConfig,
} from '../lib/teams/githubConnect';

const mockedEmitBuffered = vi.mocked(emitBuffered);

const SAMPLE_REPO: Pick<TeamRepoConfig, 'orgId' | 'deptId' | 'repoUrl' | 'localDir'> = {
  orgId: 'org-1',
  deptId: 'dept-eng',
  repoUrl: 'https://github.com/acme/dept-eng-brain',
  localDir: 'C:\\Users\\test\\AppData\\Local\\lazy\\teams\\dept-eng',
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  isTauriMock.mockReturnValue(true);
  getEntitlementsMock.mockReturnValue({ features: { canUseRootTrunk: true, canUseTeamSearch: true } });
  infoMock.mockResolvedValue({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
  publishGithubMock.mockResolvedValue({
    ok: true,
    url: 'https://github.com/x/y',
    message: 'Published successfully.',
  });
  importFromGithubMock.mockResolvedValue({ path: '/mock/imported/brain', source: 'ui_config' });
  setConfigMock.mockResolvedValue({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
  readFileMock.mockRejectedValue(new Error('ENOENT: no such file'));
  writeFileMock.mockResolvedValue(undefined);
  readDirMock.mockResolvedValue([]);
});

// ── provisionTeamBrainRepo — gating ───────────────────────────────────

describe('provisionTeamBrainRepo — gating', () => {
  it('returns ok:false outside Tauri without touching fs or brain', async () => {
    isTauriMock.mockReturnValue(false);

    const result = await provisionTeamBrainRepo();

    expect(result.ok).toBe(false);
    expect(infoMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(publishGithubMock).not.toHaveBeenCalled();
  });

  it('returns ok:false without Pro+ entitlement, before any fs/brain call', async () => {
    getEntitlementsMock.mockReturnValue({ features: { canUseRootTrunk: false, canUseTeamSearch: true } });

    const result = await provisionTeamBrainRepo();

    expect(result.ok).toBe(false);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(publishGithubMock).not.toHaveBeenCalled();
  });
});

// ── provisionTeamBrainRepo — publish provisioning ─────────────────────

describe('provisionTeamBrainRepo — publish provisioning', () => {
  it('publishes the brain without writing a .gitattributes union-merge directive', async () => {
    await provisionTeamBrainRepo();

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(publishGithubMock).toHaveBeenCalledWith({ remoteUrl: undefined });
  });

  it('does not modify an existing .gitattributes file', async () => {
    readFileMock.mockResolvedValue('*.png binary\n');

    await provisionTeamBrainRepo();

    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('is a no-op for .gitattributes when the directive is already present (idempotent)', async () => {
    readFileMock.mockResolvedValue('neurons/*.html merge=union\n');

    await provisionTeamBrainRepo();

    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('publishes regardless of brain path shape (non-standard override)', async () => {
    infoMock.mockResolvedValue({ path: '/mock/custom/override-dir', source: 'ui_config' });

    await provisionTeamBrainRepo();

    expect(publishGithubMock).toHaveBeenCalled();
  });

  it('still publishes even when writing .gitattributes fails (best-effort, never blocks the publish)', async () => {
    writeFileMock.mockRejectedValue(new Error('disk full'));

    const result = await provisionTeamBrainRepo();

    expect(publishGithubMock).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});

// ── provisionTeamBrainRepo — publish + teams.push (regression, unchanged) ──

describe('provisionTeamBrainRepo — publish + teams.push (unchanged real-operation behavior)', () => {
  it('emits teams.push with the returned url on a successful real publish', async () => {
    const result = await provisionTeamBrainRepo('https://github.com/x/y', true);

    expect(result).toEqual({
      ok: true,
      url: 'https://github.com/x/y',
      message: 'Published successfully.',
    });
    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'teams.push',
        payload: { commit: 'https://github.com/x/y' },
      }),
    );
  });

  it('emits no event when the publish itself fails', async () => {
    publishGithubMock.mockResolvedValue({ ok: false, message: 'No remote configured.' });

    const result = await provisionTeamBrainRepo();

    expect(result).toEqual({ ok: false, message: 'No remote configured.' });
    expect(mockedEmitBuffered).not.toHaveBeenCalled();
  });
});

// ── syncTeamBrainRepo ──────────────────────────────────────────────────

describe('syncTeamBrainRepo', () => {
  it('delegates to provisionTeamBrainRepo on every re-sync', async () => {
    await syncTeamBrainRepo();

    expect(publishGithubMock).toHaveBeenCalledWith({ remoteUrl: undefined });
  });
});

// ── connectTeamBrainRepo ─────────────────────────────────────────────────

describe('connectTeamBrainRepo', () => {
  it('returns ok:false outside Tauri', async () => {
    isTauriMock.mockReturnValue(false);

    const result = await connectTeamBrainRepo('https://github.com/x/y', '/dest');

    expect(result.ok).toBe(false);
    expect(importFromGithubMock).not.toHaveBeenCalled();
  });

  it('returns ok:false when url/dest are blank', async () => {
    const result = await connectTeamBrainRepo('   ', '   ');

    expect(result.ok).toBe(false);
    expect(importFromGithubMock).not.toHaveBeenCalled();
  });

  it('clones, activates, and emits teams.pull on success', async () => {
    const result = await connectTeamBrainRepo('https://github.com/x/y', '/dest');

    expect(result).toEqual({
      ok: true,
      brainPath: '/mock/imported/brain',
      message: 'Brain connected and activated: /mock/imported/brain',
    });
    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'teams.pull',
        payload: { commit: 'https://github.com/x/y' },
      }),
    );
  });
});

// ── Team repo config CRUD (spec §10, R4-lite) ─────────────────────────

describe('getTeamRepos / addTeamRepo / updateTeamRepo / removeTeamRepo', () => {
  it('starts empty (no repo configured until a connect/provision flow registers one)', () => {
    expect(getTeamRepos()).toEqual([]);
  });

  it('addTeamRepo registers a repo, persisted across calls', () => {
    const result = addTeamRepo(SAMPLE_REPO);

    expect(result).toEqual([SAMPLE_REPO]);
    expect(getTeamRepos()).toEqual([SAMPLE_REPO]);
  });

  it('addTeamRepo is idempotent on repoUrl (second call is a no-op)', () => {
    addTeamRepo(SAMPLE_REPO);
    addTeamRepo({ ...SAMPLE_REPO, deptId: 'dept-other' });

    expect(getTeamRepos()).toEqual([SAMPLE_REPO]);
  });

  it('updateTeamRepo merges a partial patch into the matching repo', () => {
    addTeamRepo(SAMPLE_REPO);

    updateTeamRepo(SAMPLE_REPO.repoUrl, { lastPulledAt: 1000, consecutiveFailures: 0 });

    expect(getTeamRepos()).toEqual([{ ...SAMPLE_REPO, lastPulledAt: 1000, consecutiveFailures: 0 }]);
  });

  it('updateTeamRepo is a no-op when no repo matches the given repoUrl', () => {
    addTeamRepo(SAMPLE_REPO);

    updateTeamRepo('https://github.com/other/repo', { lastPulledAt: 1000 });

    expect(getTeamRepos()).toEqual([SAMPLE_REPO]);
  });

  it('removeTeamRepo drops the matching repo', () => {
    addTeamRepo(SAMPLE_REPO);

    removeTeamRepo(SAMPLE_REPO.repoUrl);

    expect(getTeamRepos()).toEqual([]);
  });
});

// ── pullTeamRepo (spec §10, R4-lite pull transport) ───────────────────

describe('pullTeamRepo — gating', () => {
  it('returns ok:false, skipped:true outside Tauri without touching fs/brain', async () => {
    isTauriMock.mockReturnValue(false);

    const result = await pullTeamRepo(SAMPLE_REPO as TeamRepoConfig);

    expect(result).toEqual({ ok: false, skipped: true, reason: 'requires the desktop app' });
    expect(readDirMock).not.toHaveBeenCalled();
    expect(importFromGithubMock).not.toHaveBeenCalled();
  });

  it('returns ok:false, skipped:true without the team-search entitlement', async () => {
    getEntitlementsMock.mockReturnValue({ features: { canUseRootTrunk: true, canUseTeamSearch: false } });

    const result = await pullTeamRepo(SAMPLE_REPO as TeamRepoConfig);

    expect(result).toEqual({ ok: false, skipped: true, reason: 'missing team-search entitlement' });
    expect(importFromGithubMock).not.toHaveBeenCalled();
  });
});

describe('pullTeamRepo — already cloned (no update transport yet)', () => {
  it('skips without calling importFromGithub when the local dir already has content', async () => {
    readDirMock.mockResolvedValue([{ name: '.git', path: 'x', isDir: true }]);

    const result = await pullTeamRepo(SAMPLE_REPO as TeamRepoConfig);

    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: 'already cloned — no update transport yet',
    });
    expect(infoMock).not.toHaveBeenCalled();
    expect(importFromGithubMock).not.toHaveBeenCalled();
  });
});

describe('pullTeamRepo — personal brain override present', () => {
  it('fails closed (skips) rather than clobbering an active custom/global brain', async () => {
    infoMock.mockResolvedValue({ path: '/custom/personal-brain', source: 'ui_config' });

    const result = await pullTeamRepo(SAMPLE_REPO as TeamRepoConfig);

    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: 'a personal brain override is active',
    });
    expect(importFromGithubMock).not.toHaveBeenCalled();
  });
});

describe('pullTeamRepo — real clone + active-brain restore', () => {
  it('clones into localDir and restores project-scoped resolution on success', async () => {
    infoMock.mockResolvedValue({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    importFromGithubMock.mockResolvedValue({ path: SAMPLE_REPO.localDir, source: 'ui_config' });

    const result = await pullTeamRepo(SAMPLE_REPO as TeamRepoConfig);

    expect(result).toEqual({ ok: true, path: SAMPLE_REPO.localDir });
    expect(importFromGithubMock).toHaveBeenCalledWith({
      url: SAMPLE_REPO.repoUrl,
      dest: SAMPLE_REPO.localDir,
    });
    expect(setConfigMock).toHaveBeenCalledWith({ mode: 'project' });
  });

  it('still reports success even when restoring the active brain afterward fails', async () => {
    infoMock.mockResolvedValue({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    importFromGithubMock.mockResolvedValue({ path: SAMPLE_REPO.localDir, source: 'ui_config' });
    setConfigMock.mockRejectedValue(new Error('sidecar restart failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await pullTeamRepo(SAMPLE_REPO as TeamRepoConfig);

    expect(result).toEqual({ ok: true, path: SAMPLE_REPO.localDir });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns a real (non-skipped) failure when the clone itself fails', async () => {
    infoMock.mockResolvedValue({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    importFromGithubMock.mockRejectedValue(new Error('git clone failed: authentication required'));

    const result = await pullTeamRepo(SAMPLE_REPO as TeamRepoConfig);

    expect(result).toEqual({
      ok: false,
      message: 'git clone failed: authentication required',
    });
    expect(setConfigMock).not.toHaveBeenCalled();
  });
});
