/**
 * teamsAuthSync.test.ts
 *
 * Unit tests for:
 *   1. authSync module: token store + syncTeamsOnLogin + resyncTeams
 *   2. _routeCapture: uses getTeamsToken() as fallback when env-var token is absent
 *
 * All tests run outside Tauri (isTauri() === false), so:
 *   - syncOrgContext / resyncOrgContext are no-ops (verified by orgContext.test.ts)
 *   - teams_health / teams_capture Tauri commands are never reached
 *   - token store operations are pure in-memory (no I/O)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────

// Mock orgContext so we can control fetchOrgContextData + verify sync calls
vi.mock('../lib/teams/orgContext', () => ({
  fetchOrgContextData: vi.fn(),
  syncOrgContext:       vi.fn().mockResolvedValue(undefined),
  resyncOrgContext:     vi.fn().mockResolvedValue(undefined),
}));

// Mock @tauri-apps/api/core (teams_health invoke)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('{"ok":true}'),
}));

import {
  getTeamsToken,
  clearTeamsToken,
  syncTeamsOnLogin,
  resyncTeams,
  checkTeamsHealth,
} from '../lib/teams/authSync';
import {
  fetchOrgContextData,
  syncOrgContext,
  resyncOrgContext,
} from '../lib/teams/orgContext';
import { _routeCapture } from '../lib/brain/capture';
import { WebPlatform } from '../lib/platform/web';
import type { CaptureEvent } from '../lib/platform/types';
import type { OrgContextJson } from '../lib/teams/orgContext';

// ── Fixtures ──────────────────────────────────────────────────────────

const MOCK_CTX: OrgContextJson = {
  userId:    'user-uuid-123',
  orgId:     'org-uuid-456',
  orgSlug:   'acme-corp',
  isOrgAdmin: false,
  teams:     [],
  depts:     [],
};

const USER_ID     = 'user-uuid-123';
const ACCESS_TOKEN = 'eyJsupabase.jwt.token';

function makeEvent(kind: CaptureEvent['kind'] = 'episodic'): CaptureEvent {
  return {
    kind,
    title: 'Auth sync test',
    text:  'Test content',
    source: 'test:teams-auth-sync',
  };
}

const mockCaptureResult = { id: 'test-id', path: '/mock.html', sizeBytes: 0, attrsCount: 0 };

// ── Tests: token store ─────────────────────────────────────────────────

describe('teams token store', () => {
  beforeEach(() => {
    clearTeamsToken();
    vi.clearAllMocks();
  });

  it('getTeamsToken returns null before any sync', () => {
    expect(getTeamsToken()).toBeNull();
  });

  it('clearTeamsToken resets the token to null', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);
    // token is now stored
    clearTeamsToken();
    expect(getTeamsToken()).toBeNull();
  });
});

// ── Tests: syncTeamsOnLogin ───────────────────────────────────────────

describe('syncTeamsOnLogin', () => {
  beforeEach(() => {
    clearTeamsToken();
    vi.clearAllMocks();
  });

  it('calls fetchOrgContextData with userId', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);
    expect(fetchOrgContextData).toHaveBeenCalledWith(USER_ID);
  });

  it('calls syncOrgContext with the fetched context', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);
    expect(syncOrgContext).toHaveBeenCalledWith(MOCK_CTX);
  });

  it('stores the access token after successful sync', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);
    expect(getTeamsToken()).toBe(ACCESS_TOKEN);
  });

  it('does NOT store the token when org membership is absent (ctx = null)', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(null);
    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);
    expect(getTeamsToken()).toBeNull();
    expect(syncOrgContext).not.toHaveBeenCalled();
  });

  it('is a no-op (no throw) when userId is empty', async () => {
    await expect(syncTeamsOnLogin('', ACCESS_TOKEN)).resolves.toBeUndefined();
    expect(fetchOrgContextData).not.toHaveBeenCalled();
    expect(getTeamsToken()).toBeNull();
  });

  it('is a no-op (no throw) when accessToken is empty', async () => {
    await expect(syncTeamsOnLogin(USER_ID, '')).resolves.toBeUndefined();
    expect(fetchOrgContextData).not.toHaveBeenCalled();
    expect(getTeamsToken()).toBeNull();
  });

  it('does not throw when fetchOrgContextData rejects (swallows error)', async () => {
    vi.mocked(fetchOrgContextData).mockRejectedValue(new Error('Supabase unavailable'));
    await expect(syncTeamsOnLogin(USER_ID, ACCESS_TOKEN)).resolves.toBeUndefined();
    expect(getTeamsToken()).toBeNull();
  });
});

// ── Tests: resyncTeams ────────────────────────────────────────────────

describe('resyncTeams', () => {
  beforeEach(() => {
    clearTeamsToken();
    vi.clearAllMocks();
  });

  it('calls fetchOrgContextData with userId', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    await resyncTeams(USER_ID, ACCESS_TOKEN);
    expect(fetchOrgContextData).toHaveBeenCalledWith(USER_ID);
  });

  it('calls resyncOrgContext with the fetched context', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    await resyncTeams(USER_ID, ACCESS_TOKEN);
    expect(resyncOrgContext).toHaveBeenCalledWith(MOCK_CTX);
  });

  it('updates the stored access token', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    const newToken = 'eyJnewtoken';
    await resyncTeams(USER_ID, newToken);
    expect(getTeamsToken()).toBe(newToken);
  });

  it('clears the stored token when org membership is lost (ctx = null)', async () => {
    // Simulate token set from a prior login
    vi.mocked(fetchOrgContextData).mockResolvedValueOnce(MOCK_CTX);
    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);
    expect(getTeamsToken()).toBe(ACCESS_TOKEN); // sanity

    // Now membership is revoked
    vi.mocked(fetchOrgContextData).mockResolvedValue(null);
    await resyncTeams(USER_ID, 'eyJnewtoken');

    expect(getTeamsToken()).toBeNull();
    expect(resyncOrgContext).not.toHaveBeenCalled();
  });

  it('is a no-op when userId is empty', async () => {
    await expect(resyncTeams('', ACCESS_TOKEN)).resolves.toBeUndefined();
    expect(fetchOrgContextData).not.toHaveBeenCalled();
  });

  it('is a no-op when accessToken is empty', async () => {
    await expect(resyncTeams(USER_ID, '')).resolves.toBeUndefined();
    expect(fetchOrgContextData).not.toHaveBeenCalled();
  });
});

// ── Tests: checkTeamsHealth ───────────────────────────────────────────

describe('checkTeamsHealth', () => {
  beforeEach(() => {
    clearTeamsToken();
    vi.clearAllMocks();
  });

  it('returns null outside Tauri (isTauri() === false in tests)', async () => {
    // isTauri() always returns false in the test env (setup.ts removes __TAURI_INTERNALS__)
    const result = await checkTeamsHealth();
    expect(result).toBeNull();
  });
});

// ── Tests: _routeCapture always uses platform.brain.capture (no sidecar) ──

describe('_routeCapture — always dispatches to platform.brain.capture', () => {
  beforeEach(() => {
    clearTeamsToken();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearTeamsToken();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dispatches to platform.brain.capture regardless of a team config (no sidecar)', async () => {
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);

    const config = {
      teamSlug: 'acme-team',
      tokenRef:  'LAZY_TEAMS_TOKEN_NOT_SET_IN_ENV_XYZ99',
    };

    await _routeCapture(makeEvent(), async () => config);

    expect(captureSpy).toHaveBeenCalledOnce();
  });

  it('dispatches to platform.brain.capture even with a session token set (no sidecar)', async () => {
    vi.mocked(fetchOrgContextData).mockResolvedValue(MOCK_CTX);
    await syncTeamsOnLogin(USER_ID, ACCESS_TOKEN);
    expect(getTeamsToken()).toBe(ACCESS_TOKEN);

    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);

    const config = {
      teamSlug: 'acme-team',
      tokenRef:  'LAZY_TEAMS_TOKEN_NOT_SET_IN_ENV_XYZ99',
    };

    await _routeCapture(makeEvent(), async () => config);

    expect(captureSpy).toHaveBeenCalledOnce();
  });

  it('falls back to solo when neither env-var nor session token is available', async () => {
    // No session token, no env var
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);

    const config = {
      teamSlug: 'acme-team',
      tokenRef:  'LAZY_TEAMS_TOKEN_COMPLETELY_ABSENT_999',
    };

    await _routeCapture(makeEvent(), async () => config);

    expect(captureSpy).toHaveBeenCalledOnce();
  });

  it('solo path is unchanged when config loader returns null', async () => {
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);

    await _routeCapture(makeEvent(), async () => null);

    expect(captureSpy).toHaveBeenCalledOnce();
  });
});
