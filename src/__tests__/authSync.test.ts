/**
 * authSync.test.ts
 *
 * Coverage for activateTeamBrainFromOrgContext — the piece that
 * reads brainRepoUrl from the org context and calls
 * activateTeamBrainOnLogin(orgId, brainRepoUrl) after a successful
 * org-context fetch, so the sync daemon (syncDaemon.ts) has a real
 * active brain config to work with for Teams org members from their
 * very first login — never for solo users, and never before a real
 * org-context fetch succeeds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── platform mock ─────────────────────────────────────────────────────
const isTauriMock = vi.fn(() => true);
vi.mock('../lib/platform', () => ({
  isTauri: () => isTauriMock(),
  // Not exercised by any path these tests drive — stubbed only so an
  // unrelated transitive import of getPlatform (e.g. via githubConnect.ts's
  // module graph) never crashes on an undefined call.
  getPlatform: () => ({
    name: 'tauri',
    brain: {
      info: vi.fn(),
      publishGithub: vi.fn(),
      importFromGithub: vi.fn(),
      setConfig: vi.fn(),
    },
    fs: { readFile: vi.fn(), writeFile: vi.fn(), readDir: vi.fn() },
  }),
}));

// ── @tauri-apps/api/path mock (same pattern as teamSearch.test.ts) ────
const appLocalDataDirMock = vi.fn();
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: (...args: unknown[]) => appLocalDataDirMock(...args),
}));

// ── journal mock — no test here asserts on journal events; stubbed only
// to avoid any import-time side effect from the real module. ───────────
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

// ── orgContext mock — the Supabase-touching boundary ──────────────────
const fetchOrgContextDataMock = vi.fn();
const syncOrgContextMock = vi.fn().mockResolvedValue(undefined);
const resyncOrgContextMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/teams/orgContext', () => ({
  fetchOrgContextData: (...args: unknown[]) => fetchOrgContextDataMock(...args),
  syncOrgContext: (...args: unknown[]) => syncOrgContextMock(...args),
  resyncOrgContext: (...args: unknown[]) => resyncOrgContextMock(...args),
}));

// ── activateTeamBrain mock — the Tauri-touching boundary ──────────────
const activateTeamBrainOnLoginMock = vi.fn().mockResolvedValue({
  ok: true,
  localDir: '/mock/brain',
  message: 'Team brain activated',
});
vi.mock('../lib/teams/activateTeamBrain', () => ({
  activateTeamBrainOnLogin: (...args: unknown[]) => activateTeamBrainOnLoginMock(...args),
}));

import { syncTeamsOnLogin, resyncTeams, getTeamsToken, clearTeamsToken } from '../lib/teams/authSync';
import { getTeamRepos } from '../lib/teams/githubConnect';
import type { OrgContextJson } from '../lib/teams/orgContext';

const SAMPLE_CTX: OrgContextJson = {
  userId: 'user-1',
  orgId: 'org-1',
  orgSlug: 'acme-corp',
  isOrgAdmin: false,
  teams: [],
  depts: [
    { id: 'dept-eng', slug: 'eng' },
    { id: 'dept-sales', slug: 'sales' },
  ],
  brainRepoUrl: 'https://github.com/acme-corp/brain.git',
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(true);
  appLocalDataDirMock.mockResolvedValue('C:\\Users\\test\\AppData\\Local');
  fetchOrgContextDataMock.mockResolvedValue(SAMPLE_CTX);
  syncOrgContextMock.mockResolvedValue(undefined);
  resyncOrgContextMock.mockResolvedValue(undefined);
  clearTeamsToken();
});

describe('syncTeamsOnLogin — team repo auto-registration (T6a)', () => {
  it('calls activateTeamBrainOnLogin with ctx.orgId and ctx.brainRepoUrl when brainRepoUrl is set', async () => {
    await syncTeamsOnLogin('user-1', 'token-abc');

    expect(activateTeamBrainOnLoginMock).toHaveBeenCalledWith('org-1', 'https://github.com/acme-corp/brain.git');
  });

  it('stores the access token on success (existing behavior, unchanged by this fix)', async () => {
    await syncTeamsOnLogin('user-1', 'token-abc');
    expect(getTeamsToken()).toBe('token-abc');
  });

  it('does NOT call activateTeamBrainOnLogin when brainRepoUrl is null', async () => {
    fetchOrgContextDataMock.mockResolvedValue({ ...SAMPLE_CTX, brainRepoUrl: null });

    await syncTeamsOnLogin('user-1', 'token-abc');

    expect(activateTeamBrainOnLoginMock).not.toHaveBeenCalled();
  });

  it('is idempotent across repeated logins — activateTeamBrainOnLogin is called each time', async () => {
    await syncTeamsOnLogin('user-1', 'token-abc');
    await syncTeamsOnLogin('user-1', 'token-abc');

    expect(activateTeamBrainOnLoginMock).toHaveBeenCalledTimes(2);
  });

  it('registers nothing outside Tauri (the sync daemon itself is a no-op there)', async () => {
    isTauriMock.mockReturnValue(false);
    await syncTeamsOnLogin('user-1', 'token-abc');
    expect(getTeamRepos()).toEqual([]);
  });

  it('registers nothing when the user has no org membership', async () => {
    fetchOrgContextDataMock.mockResolvedValue(null);
    await syncTeamsOnLogin('user-1', 'token-abc');
    expect(getTeamRepos()).toEqual([]);
  });

  it('is a silent no-op when userId or accessToken is empty', async () => {
    await expect(syncTeamsOnLogin('', 'token')).resolves.toBeUndefined();
    await expect(syncTeamsOnLogin('user-1', '')).resolves.toBeUndefined();
    expect(getTeamRepos()).toEqual([]);
  });
});

describe('resyncTeams — team repo re-registration', () => {
  it('also calls activateTeamBrainOnLogin with the right URL via resyncTeams', async () => {
    await resyncTeams('user-1', 'token-abc');

    expect(activateTeamBrainOnLoginMock).toHaveBeenCalledWith('org-1', 'https://github.com/acme-corp/brain.git');
  });

  it('never constructs convention URLs (brain-trunk, brain-<dept>) — only the brainRepoUrl from context is used', async () => {
    await syncTeamsOnLogin('user-1', 'token-abc');
    await resyncTeams('user-1', 'token-abc');

    const allCalls = activateTeamBrainOnLoginMock.mock.calls;
    for (const call of allCalls) {
      const url = call[1] as string;
      expect(url).not.toContain('brain-trunk');
      expect(url).not.toContain('brain-eng');
      expect(url).not.toContain('brain-sales');
    }
  });

  it('clears the token and registers nothing new when the user lost org membership', async () => {
    await syncTeamsOnLogin('user-1', 'token-abc'); // establish a token first
    fetchOrgContextDataMock.mockResolvedValue(null);

    await resyncTeams('user-1', 'token-def');

    expect(getTeamsToken()).toBeNull();
  });
});
