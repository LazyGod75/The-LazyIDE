/**
 * teams-dispatch.test.ts
 *
 * Unit-tests for Phase-1 Teams routing:
 *   - _routeCapture: routing logic (solo fallback vs. teams_capture invoke)
 *   - loadTeamsConfig: config parsing and path building
 *   - resolveToken: env-var token resolution
 *
 * The actual dispatch() function stays on the solo path in all tests because
 * TEAMS_ENABLED is false as const.  _routeCapture is tested directly via its
 * injectable configLoader parameter, with @tauri-apps/api/core mocked.
 *
 * No real HTTP is made; the teams_capture Tauri command is intercepted by the
 * vi.mock below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _routeCapture, captureAgentMission } from '../lib/brain/capture';
import { loadTeamsConfig, resolveToken } from '../lib/brain/teams-config';
import type { TeamsConfig } from '../lib/brain/teams-config';
import { WebPlatform } from '../lib/platform/web';
import type { CaptureEvent } from '../lib/platform/types';
import { teamsActive } from '../lib/features';

// ── Mock @tauri-apps/api/core so invoke() never hits a real Tauri runtime ──

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock features.ts so dispatch()'s branch selection is controlled
// directly, independent of the real active-team snapshot lifecycle
// (that lifecycle — fail-closed unhydrated state, dev override — is
// covered in depth by features.test.ts). ──

vi.mock('../lib/features', () => ({
  teamsActive: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────

function makeEvent(kind: CaptureEvent['kind'] = 'episodic'): CaptureEvent {
  return {
    kind,
    title: 'Test capture',
    text:  'Some content',
    source: 'test:teams-dispatch',
  };
}

const mockCaptureResult = { id: 'test-id', path: '/mock.html', sizeBytes: 0, attrsCount: 0 };

// ── Tests: _routeCapture routing ───────────────────────────────────

describe('_routeCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('routes to solo (brain.capture) when teams.json is absent (configLoader returns null)', async () => {
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);

    await _routeCapture(makeEvent(), async () => null);

    expect(captureSpy).toHaveBeenCalledOnce();
    const [event] = captureSpy.mock.calls[0];
    expect(event.kind).toBe('episodic');
  });

  it('solo path does NOT call teams_capture invoke', async () => {
    vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue(mockCaptureResult);
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);

    await _routeCapture(makeEvent(), async () => null);

    expect(mockInvoke).not.toHaveBeenCalledWith('teams_capture', expect.anything());
  });

  it('always routes to platform.brain.capture even when config is valid and token is set (V2 unified dispatch)', async () => {
    process.env['LAZY_TEST_TEAM_TOKEN'] = 'secret-bearer-token-42';

    const config: TeamsConfig = {
      teamSlug: 'my-team',
      tokenRef: 'LAZY_TEST_TEAM_TOKEN',
    };

    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);

    await _routeCapture(makeEvent(), async () => config);

    expect(captureSpy).toHaveBeenCalledOnce();
    expect(mockInvoke).not.toHaveBeenCalledWith('teams_capture', expect.anything());

    delete process.env['LAZY_TEST_TEAM_TOKEN'];
  });

  it('platform.brain.capture receives the event payload (not teams_capture)', async () => {
    process.env['LAZY_TEST_TEAM_TOKEN_2'] = 'tkn-xyz';

    const config: TeamsConfig = {
      teamSlug: 'alpha',
      tokenRef: 'LAZY_TEST_TEAM_TOKEN_2',
    };

    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);
    const ev = makeEvent('decision');

    await _routeCapture(ev, async () => config);

    expect(captureSpy).toHaveBeenCalledOnce();
    const [capturedEvent] = captureSpy.mock.calls[0];
    expect(capturedEvent.kind).toBe('decision');

    delete process.env['LAZY_TEST_TEAM_TOKEN_2'];
  });

  it('ignores serverUrl from config — always uses platform.brain.capture (no sidecar)', async () => {
    process.env['LAZY_TEST_TEAM_TOKEN_3'] = 'token-abc';

    const config: TeamsConfig = {
      teamSlug: 'beta',
      tokenRef: 'LAZY_TEST_TEAM_TOKEN_3',
      serverUrl: 'http://remote.teams.example:9000',
    };

    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);

    await _routeCapture(makeEvent(), async () => config);

    expect(captureSpy).toHaveBeenCalledOnce();
    expect(mockInvoke).not.toHaveBeenCalledWith('teams_capture', expect.anything());

    delete process.env['LAZY_TEST_TEAM_TOKEN_3'];
  });

  it('falls back to solo when tokenRef env var is not set', async () => {
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);

    const config: TeamsConfig = {
      teamSlug: 'gamma',
      tokenRef: 'LAZY_NONEXISTENT_VAR_XYZ_999',
    };

    await _routeCapture(makeEvent(), async () => config);

    // Should fall back to solo
    expect(captureSpy).toHaveBeenCalledOnce();
  });

  it('falls back to solo: does NOT call teams_capture when token is missing', async () => {
    vi.spyOn(WebPlatform.brain, 'capture').mockResolvedValue(mockCaptureResult);
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);

    const config: TeamsConfig = {
      teamSlug: 'delta',
      tokenRef: 'ANOTHER_MISSING_VAR_ABC',
    };

    await _routeCapture(makeEvent(), async () => config);

    expect(mockInvoke).not.toHaveBeenCalledWith('teams_capture', expect.anything());
  });
});

// ── Tests: dispatch() unified path (V2 — no more teamsActive branching) ──
//
// dispatch() itself is not exported — driven here via captureAgentMission,
// the simplest public capture function. After V2, dispatch() no longer
// branches on teamsActive(): it always calls platform.brain.capture.
// The only branching is on readActiveBrainConfig() for viewer role skip
// and orgId stamping. These tests prove that platform.brain.capture is
// always called regardless of teamsActive() state.

describe('dispatch() unified path (via captureAgentMission)', () => {
  const mockedTeamsActive = vi.mocked(teamsActive);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('teamsActive() false -> platform.brain.capture is called, no sidecar invoke', async () => {
    mockedTeamsActive.mockReturnValue(false);
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);

    captureAgentMission('Test mission', 'desc', 'model-x', '/tmp/worktree');

    await vi.waitFor(() => {
      expect(captureSpy).toHaveBeenCalledOnce();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith('teams_capture', expect.anything());
  });

  it('teamsActive() true -> still uses platform.brain.capture (no sidecar branch)', async () => {
    mockedTeamsActive.mockReturnValue(true);
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);
    const { invoke } = await import('@tauri-apps/api/core');
    const mockInvoke = vi.mocked(invoke);

    captureAgentMission('Test mission', 'desc', 'model-x', '/tmp/worktree');

    await vi.waitFor(() => {
      expect(captureSpy).toHaveBeenCalledOnce();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith('teams_capture', expect.anything());
  });

  it('unhydrated/false snapshot (fail-closed default) takes the same unified path', async () => {
    mockedTeamsActive.mockReturnValue(false);
    const captureSpy = vi
      .spyOn(WebPlatform.brain, 'capture')
      .mockResolvedValue(mockCaptureResult);

    captureAgentMission('Another mission', undefined, 'model-y', '/tmp/worktree2');

    await vi.waitFor(() => {
      expect(captureSpy).toHaveBeenCalledOnce();
    });
  });
});

// ── Tests: loadTeamsConfig ─────────────────────────────────────────

describe('loadTeamsConfig', () => {
  it('returns null when teams.json is absent (reader throws)', async () => {
    const reader = () => Promise.reject(new Error('ENOENT'));
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const reader = () => Promise.resolve('{invalid json{{');
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toBeNull();
  });

  it('returns null when teamSlug is missing', async () => {
    const reader = () =>
      Promise.resolve(JSON.stringify({ tokenRef: 'MY_TOKEN' }));
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toBeNull();
  });

  it('returns null when tokenRef is missing', async () => {
    const reader = () =>
      Promise.resolve(JSON.stringify({ teamSlug: 'my-team' }));
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toBeNull();
  });

  it('returns null when JSON is an array', async () => {
    const reader = () => Promise.resolve(JSON.stringify([{ teamSlug: 'a', tokenRef: 'b' }]));
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toBeNull();
  });

  it('returns config when teamSlug and tokenRef are valid strings', async () => {
    const reader = () =>
      Promise.resolve(JSON.stringify({ teamSlug: 'my-team', tokenRef: 'MY_TOKEN' }));
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toEqual({ teamSlug: 'my-team', tokenRef: 'MY_TOKEN' });
  });

  it('includes serverUrl when present', async () => {
    const reader = () =>
      Promise.resolve(
        JSON.stringify({
          teamSlug: 'my-team',
          tokenRef: 'MY_TOKEN',
          serverUrl: 'http://custom:8080',
        }),
      );
    const result = await loadTeamsConfig('/project', reader);
    expect(result?.serverUrl).toBe('http://custom:8080');
  });

  it('omits serverUrl when absent in JSON', async () => {
    const reader = () =>
      Promise.resolve(JSON.stringify({ teamSlug: 'my-team', tokenRef: 'MY_TOKEN' }));
    const result = await loadTeamsConfig('/project', reader);
    expect(result?.serverUrl).toBeUndefined();
  });

  it('builds the config path with trailing slash on projectRoot', async () => {
    let capturedPath = '';
    const reader = (path: string) => {
      capturedPath = path;
      return Promise.reject(new Error('ENOENT'));
    };
    await loadTeamsConfig('/project/', reader);
    expect(capturedPath).toBe('/project/.lazybrain/teams.json');
  });

  it('builds the config path without trailing slash on projectRoot', async () => {
    let capturedPath = '';
    const reader = (path: string) => {
      capturedPath = path;
      return Promise.reject(new Error('ENOENT'));
    };
    await loadTeamsConfig('/project', reader);
    expect(capturedPath).toBe('/project/.lazybrain/teams.json');
  });

  it('returns null when teamSlug is an empty string', async () => {
    const reader = () =>
      Promise.resolve(JSON.stringify({ teamSlug: '', tokenRef: 'MY_TOKEN' }));
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toBeNull();
  });

  it('returns null when tokenRef is an empty string', async () => {
    const reader = () =>
      Promise.resolve(JSON.stringify({ teamSlug: 'my-team', tokenRef: '' }));
    const result = await loadTeamsConfig('/project', reader);
    expect(result).toBeNull();
  });
});

// ── Tests: resolveToken ────────────────────────────────────────────

describe('resolveToken', () => {
  it('returns null when env var is not set', () => {
    const result = resolveToken('LAZY_TEAMS_TOKEN_DEFINITELY_NOT_SET_9999');
    expect(result).toBeNull();
  });

  it('returns the token value when env var is set', () => {
    process.env['LAZY_TEST_RESOLVE_TOKEN_1'] = 'my-secret-token';
    const result = resolveToken('LAZY_TEST_RESOLVE_TOKEN_1');
    expect(result).toBe('my-secret-token');
    delete process.env['LAZY_TEST_RESOLVE_TOKEN_1'];
  });

  it('trims whitespace from the token value', () => {
    process.env['LAZY_TEST_RESOLVE_TOKEN_2'] = '  trimmed-token  ';
    const result = resolveToken('LAZY_TEST_RESOLVE_TOKEN_2');
    expect(result).toBe('trimmed-token');
    delete process.env['LAZY_TEST_RESOLVE_TOKEN_2'];
  });

  it('returns null when the env var is set to an empty string', () => {
    process.env['LAZY_TEST_RESOLVE_TOKEN_3'] = '';
    const result = resolveToken('LAZY_TEST_RESOLVE_TOKEN_3');
    expect(result).toBeNull();
    delete process.env['LAZY_TEST_RESOLVE_TOKEN_3'];
  });

  it('returns null for an empty tokenRef string', () => {
    const result = resolveToken('');
    expect(result).toBeNull();
  });
});
