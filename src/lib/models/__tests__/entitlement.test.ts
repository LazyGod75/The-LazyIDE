/**
 * entitlement.test.ts
 *
 * Unit coverage for getEngineReadiness() — the single source of truth for
 * "can the selected engine run right now" (v0.1.5 W2.1). Pure logic: all
 * runtime signals (CLI detection cache, BYOK key presence, Pro subscription
 * bridge) are mocked at their module boundaries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEngineReadiness } from '../entitlement';
import { loadAccessSettings } from '../accessSettings';
import { isCliBackendAvailable } from '../cliBackendProvider';
import { hasAnthropicKey } from '../anthropicProvider';
import { hasManagedCreditsActive, getProPlanState } from '../index';
import { findModelById } from '../registry';

vi.mock('../accessSettings', () => ({
  loadAccessSettings: vi.fn(),
}));

vi.mock('../cliBackendProvider', () => ({
  isCliBackendAvailable: vi.fn(),
}));

vi.mock('../anthropicProvider', () => ({
  hasAnthropicKey: vi.fn(),
}));

vi.mock('../index', () => ({
  hasManagedCreditsActive: vi.fn(),
  getProPlanState: vi.fn(),
}));

vi.mock('../registry', () => ({
  findModelById: vi.fn(),
}));

const mockedLoadAccessSettings = vi.mocked(loadAccessSettings);
const mockedIsCliBackendAvailable = vi.mocked(isCliBackendAvailable);
const mockedHasAnthropicKey = vi.mocked(hasAnthropicKey);
const mockedIsManagedActive = vi.mocked(hasManagedCreditsActive);
const mockedGetProPlanState = vi.mocked(getProPlanState);
const mockedFindModelById = vi.mocked(findModelById);

beforeEach(() => {
  vi.resetAllMocks();
  // Neutral defaults — each test overrides what it cares about. Plan state
  // defaults to the settled 'inactive' shape here (NOT 'unknown') so every
  // pre-existing test that doesn't care about the cold-start window keeps
  // exercising the same "no active plan" baseline as before this fix — the
  // 'unknown' cases are exercised explicitly below (FIX A).
  mockedLoadAccessSettings.mockReturnValue({});
  mockedIsCliBackendAvailable.mockReturnValue(false);
  mockedHasAnthropicKey.mockReturnValue(false);
  mockedIsManagedActive.mockReturnValue(false);
  mockedGetProPlanState.mockReturnValue('inactive');
  mockedFindModelById.mockReturnValue(undefined);
});

describe('getEngineReadiness', () => {
  it('cli mode + CLI detected -> ready', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'cli', cliTool: 'claude' });
    mockedIsCliBackendAvailable.mockReturnValue(true);

    expect(getEngineReadiness()).toEqual({ mode: 'cli', ready: true });
    expect(mockedIsCliBackendAvailable).toHaveBeenCalledWith('claude');
  });

  it('cli mode + CLI not detected -> not ready, reason cli-not-found', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'cli', cliTool: 'claude' });
    mockedIsCliBackendAvailable.mockReturnValue(false);

    expect(getEngineReadiness()).toEqual({
      mode: 'cli',
      ready: false,
      reason: 'cli-not-found',
    });
  });

  it('byok mode + key present -> ready', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'byok' });
    mockedHasAnthropicKey.mockReturnValue(true);

    expect(getEngineReadiness()).toEqual({ mode: 'byok', ready: true });
  });

  it('byok mode + no key -> not ready, reason byok-no-key', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'byok' });
    mockedHasAnthropicKey.mockReturnValue(false);

    expect(getEngineReadiness()).toEqual({
      mode: 'byok',
      ready: false,
      reason: 'byok-no-key',
    });
  });

  it('pro mode + active plan with credits -> ready', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(true);
    mockedGetProPlanState.mockReturnValue('active');

    expect(getEngineReadiness()).toEqual({ mode: 'pro', ready: true });
  });

  it('pro mode + settled no active plan -> not ready, reason pro-inactive', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('inactive');

    expect(getEngineReadiness()).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-inactive',
    });
  });

  it('pro mode + settled plan active but zero credits -> not ready, reason pro-no-credits', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('active');

    expect(getEngineReadiness()).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-no-credits',
    });
  });

  // ── Auto mode (accessMode unset) — resolves to the effective engine ──

  it('auto mode + managed active -> pro ready', () => {
    mockedLoadAccessSettings.mockReturnValue({});
    mockedIsManagedActive.mockReturnValue(true);

    expect(getEngineReadiness()).toEqual({ mode: 'pro', ready: true });
  });

  it('auto mode + claude CLI detected -> cli ready', () => {
    mockedLoadAccessSettings.mockReturnValue({});
    mockedIsCliBackendAvailable.mockImplementation((tool: string) => tool === 'claude');

    expect(getEngineReadiness()).toEqual({ mode: 'cli', ready: true });
  });

  it('auto mode + only BYOK key -> byok ready', () => {
    mockedLoadAccessSettings.mockReturnValue({});
    mockedHasAnthropicKey.mockReturnValue(true);

    expect(getEngineReadiness()).toEqual({ mode: 'byok', ready: true });
  });

  it('auto mode + nothing available -> cli not ready (default recommendation)', () => {
    mockedLoadAccessSettings.mockReturnValue({});

    expect(getEngineReadiness()).toEqual({
      mode: 'cli',
      ready: false,
      reason: 'cli-not-found',
    });
  });

  it('cli mode + detection not yet run (null) -> optimistic ready (startup window)', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'cli' });
    mockedIsCliBackendAvailable.mockReturnValue(null);

    expect(getEngineReadiness()).toEqual({ mode: 'cli', ready: true });
  });

  // ── forMode override (W2.8 — locked managed catalog) ─────────────

  it("getEngineReadiness('pro') reports Pro entitlement even while the user is in cli mode", () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'cli' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('inactive');

    expect(getEngineReadiness('pro')).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-inactive',
    });
  });

  it("getEngineReadiness('pro') is ready when the plan has credits, regardless of the selected mode", () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'byok' });
    mockedIsManagedActive.mockReturnValue(true);
    mockedGetProPlanState.mockReturnValue('active');

    expect(getEngineReadiness('pro')).toEqual({ mode: 'pro', ready: true });
  });
});

// ── Cold-start optimistic window (FIX A) ─────────────────────────────
// Bug: a REAL Pro user's first getEngineReadiness('pro')/auto call landed
// between app mount and useSubscription's fetch resolving. Until then the
// plan bridge defaulted to a plain `false`, indistinguishable from "no plan
// at all" — proReadiness() concluded pro-inactive and could flash a false
// lock. The plan bridge is now a tri-state ('unknown' | 'active' |
// 'inactive'), defaulting to 'unknown'; proReadiness() treats 'unknown' the
// same optimistic way cliReadiness() treats a null CLI-detection result.
describe('proReadiness — cold-start optimistic window (FIX A)', () => {
  it('pro mode + plan state unknown (fetch not settled yet) -> optimistically ready', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('unknown');

    expect(getEngineReadiness()).toEqual({ mode: 'pro', ready: true });
  });

  it('pro mode + settled inactive -> not ready, reason pro-inactive (no lingering optimism)', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('inactive');

    expect(getEngineReadiness()).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-inactive',
    });
  });

  it('pro mode + settled active but no credits -> not ready, reason pro-no-credits', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('active');

    expect(getEngineReadiness()).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-no-credits',
    });
  });

  it('unknown never leaks after settle: the very next read reflects the definite answer', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);

    mockedGetProPlanState.mockReturnValue('unknown');
    expect(getEngineReadiness()).toEqual({ mode: 'pro', ready: true });

    // useSubscription's fetch settles mid-session — the optimistic window
    // must close immediately, never sticking around once we know better.
    mockedGetProPlanState.mockReturnValue('inactive');
    expect(getEngineReadiness()).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-inactive',
    });
  });
});

// ── modelId hint (BUG-4 — per-launch model overrides global mode) ────
describe('getEngineReadiness — modelId hint (BUG-4)', () => {
  it('a catalog-native modelId short-circuits to cli readiness even when global mode is pro with an empty wallet', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro', cliTool: 'claude' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('active');
    mockedIsCliBackendAvailable.mockReturnValue(true);
    mockedFindModelById.mockReturnValue({
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      provider: 'anthropic',
      description: 'Best coding model, orchestration',
    });

    expect(getEngineReadiness(undefined, 'claude-sonnet-5')).toEqual({
      mode: 'cli',
      ready: true,
    });
    expect(mockedFindModelById).toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('a bare tier word that is not a catalog id falls through unchanged to the global-mode switch', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('active');
    mockedFindModelById.mockReturnValue(undefined);

    expect(getEngineReadiness(undefined, 'sonnet')).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-no-credits',
    });
  });

  it('an OpenRouter-shaped modelId is not in ALL_MODELS and falls through unchanged', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'pro' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('active');
    mockedFindModelById.mockReturnValue(undefined);

    expect(getEngineReadiness(undefined, 'anthropic/claude-sonnet-5')).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-no-credits',
    });
  });

  it('an explicit forMode always wins over modelId — the hint is only consulted when forMode is unset', () => {
    mockedLoadAccessSettings.mockReturnValue({ accessMode: 'cli' });
    mockedIsManagedActive.mockReturnValue(false);
    mockedGetProPlanState.mockReturnValue('active');
    mockedFindModelById.mockReturnValue({
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      provider: 'anthropic',
      description: 'Best coding model, orchestration',
    });

    expect(getEngineReadiness('pro', 'claude-sonnet-5')).toEqual({
      mode: 'pro',
      ready: false,
      reason: 'pro-no-credits',
    });
    expect(mockedFindModelById).not.toHaveBeenCalled();
  });
});
