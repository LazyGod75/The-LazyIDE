/**
 * authSyncNoConventionUrl.test.ts
 *
 * Verifies that authSync.ts's activateTeamBrainFromOrgContext does NOT
 * derive convention URLs like https://github.com/<slug>/brain-trunk.
 * Instead it reads brainRepoUrl from the org context:
 *   - brainRepoUrl: null  → activateTeamBrainOnLogin is NOT called.
 *   - brainRepoUrl: set   → activateTeamBrainOnLogin IS called with that URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks (vi.mock factories are hoisted above imports) ───────
const mocks = vi.hoisted(() => {
  return {
    fetchOrgContextData: vi.fn(),
    syncOrgContext: vi.fn(async () => undefined),
    resyncOrgContext: vi.fn(async () => undefined),
    activateTeamBrainOnLogin: vi.fn(async () => ({ ok: true, localDir: 'C:\\dir', message: 'ok' })),
  };
});

vi.mock('../lib/teams/orgContext.js', () => ({
  fetchOrgContextData: mocks.fetchOrgContextData,
  syncOrgContext: mocks.syncOrgContext,
  resyncOrgContext: mocks.resyncOrgContext,
}));

vi.mock('../lib/teams/activateTeamBrain.js', () => ({
  activateTeamBrainOnLogin: mocks.activateTeamBrainOnLogin,
}));

vi.mock('../lib/brain/captureAuthor.js', () => ({
  invalidateCaptureAuthor: vi.fn(),
}));

vi.mock('../lib/platform/index.js', () => ({
  isTauri: () => true,
}));

import { syncTeamsOnLogin, resyncTeams } from '../lib/teams/authSync.js';
import type { OrgContextJson } from '../lib/teams/orgContext.js';

const USER_ID = 'user-uuid-1';
const ACCESS_TOKEN = 'eyJsupabase.jwt.token';

function makeCtx(overrides: Partial<OrgContextJson> = {}): OrgContextJson {
  return {
    userId: USER_ID,
    orgId: 'org-uuid-1',
    orgSlug: 'acme-corp',
    isOrgAdmin: false,
    teams: [],
    depts: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('activateTeamBrainFromOrgContext — no convention URL', () => {
  it('does NOT call activateTeamBrainOnLogin when brainRepoUrl is null', async () => {
    const ctx = makeCtx({ brainRepoUrl: null });
    mocks.fetchOrgContextData.mockResolvedValue(ctx);

    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);

    expect(mocks.activateTeamBrainOnLogin).not.toHaveBeenCalled();
  });

  it('does NOT call activateTeamBrainOnLogin when brainRepoUrl is undefined', async () => {
    const ctx = makeCtx({ brainRepoUrl: undefined });
    mocks.fetchOrgContextData.mockResolvedValue(ctx);

    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);

    expect(mocks.activateTeamBrainOnLogin).not.toHaveBeenCalled();
  });

  it('calls activateTeamBrainOnLogin with the REAL brainRepoUrl from the context', async () => {
    const realUrl = 'https://github.com/acme/lazy-brain.git';
    const ctx = makeCtx({ brainRepoUrl: realUrl });
    mocks.fetchOrgContextData.mockResolvedValue(ctx);

    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);

    expect(mocks.activateTeamBrainOnLogin).toHaveBeenCalledTimes(1);
    expect(mocks.activateTeamBrainOnLogin).toHaveBeenCalledWith('org-uuid-1', realUrl);
  });

  it('never constructs a brain-trunk convention URL', async () => {
    const ctx = makeCtx({ brainRepoUrl: 'https://github.com/acme/lazy-brain.git' });
    mocks.fetchOrgContextData.mockResolvedValue(ctx);

    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);

    const callArgs = mocks.activateTeamBrainOnLogin.mock.calls[0] as unknown[] | undefined;
    const urlArg = callArgs?.[1] as string | undefined;
    expect(urlArg).not.toContain('brain-trunk');
  });

  it('resyncTeams also uses brainRepoUrl (not a convention URL)', async () => {
    const realUrl = 'https://github.com/acme/other-brain.git';
    const ctx = makeCtx({ brainRepoUrl: realUrl });
    mocks.fetchOrgContextData.mockResolvedValue(ctx);

    await resyncTeams(USER_ID, ACCESS_TOKEN);

    expect(mocks.activateTeamBrainOnLogin).toHaveBeenCalledTimes(1);
    expect(mocks.activateTeamBrainOnLogin).toHaveBeenCalledWith('org-uuid-1', realUrl);
  });
});
