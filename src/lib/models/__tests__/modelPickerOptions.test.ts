/**
 * modelPickerOptions.test.ts
 *
 * Unit coverage for the shared entitlement -> model options helper used by
 * LazyManager, the New Mission modal, and the assistant Composer (see
 * modelPickerOptions.ts's header for the bug this replaces: those three
 * pickers used to each derive their option list from getProviderMode() — a
 * single resolved, mutually-exclusive mode — so a user holding BOTH a Claude
 * subscription and an active Lazy Pro plan at once only ever saw one
 * catalog).
 *
 * Two layers are tested separately:
 *   - buildModelPickerOptions() — pure, given a synthetic entitlements
 *     snapshot. Covers the 5 required combinations: claude-only, pro-only,
 *     both, neither, no-credit.
 *   - detectModelEntitlements()/getModelPickerOptions() — live detection,
 *     mirroring entitlement.test.ts's mocking style for the same underlying
 *     signals (CLI detection cache, BYOK localStorage, Pro subscription
 *     bridge).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildModelPickerOptions,
  detectModelEntitlements,
  getModelPickerOptions,
  isSelectablePickerModel,
} from '../modelPickerOptions';
import { ALL_MODELS, DEFAULT_MODEL } from '../registry';
import { OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL_ID, FREE_OPENROUTER_MODEL_ID } from '../openrouterCatalog';
import { getEngineReadiness } from '../entitlement';
import type { EngineReadiness } from '../entitlement';
import { saveAccessSettings } from '../accessSettings';
import { isCliBackendAvailable } from '../cliBackendProvider';
import { hasAnthropicKey } from '../anthropicProvider';
import { setManagedAvailability, setProPlanActive } from '../index';
import { resolveByokDef, saveByokKey, resetByokVaultCacheForTests } from '../byokProviders';

vi.mock('../entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../entitlement')>();
  return { ...actual, getEngineReadiness: vi.fn() };
});

vi.mock('../cliBackendProvider', () => ({
  isCliBackendAvailable: vi.fn(),
}));

vi.mock('../anthropicProvider', () => ({
  hasAnthropicKey: vi.fn(),
}));

const mockedReadiness = vi.mocked(getEngineReadiness);
const mockedIsCliBackendAvailable = vi.mocked(isCliBackendAvailable);
const mockedHasAnthropicKey = vi.mocked(hasAnthropicKey);

const SENTINEL_READINESS: EngineReadiness = { mode: 'cli', ready: false, reason: 'cli-not-found' };

beforeEach(() => {
  localStorage.clear();
  resetByokVaultCacheForTests();
  setManagedAvailability(false);
  setProPlanActive(false);
  mockedReadiness.mockReturnValue(SENTINEL_READINESS);
  mockedIsCliBackendAvailable.mockReturnValue(false);
  mockedHasAnthropicKey.mockReturnValue(false);
});

// ── buildModelPickerOptions — pure, given entitlements ─────────────

describe('buildModelPickerOptions', () => {
  // The FREE tier (ox alpha) is unconditionally present since the free-model
  // wave: every group-id assertion below therefore starts with 'free'.
  it('offers the free group FIRST even with zero entitlements', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'inactive', codexManaged: false });

    expect(result.groups[0].id).toBe('free');
    expect(result.groups[0].models.map((m) => m.id)).toEqual(
      OPENROUTER_MODELS.filter((m) => m.isFree).map((m) => m.id),
    );
    expect(result.hasOptions).toBe(true);
  });

  it('claude-only: offers the Claude subscription group next to the free one', () => {
    const result = buildModelPickerOptions({ claudeSub: true, pro: 'inactive', codexManaged: false });

    expect(result.groups.map((g) => g.id)).toEqual(['free', 'claude-sub']);
    expect(result.groups.find((g) => g.id === 'claude-sub')!.models.map((m) => m.id)).toEqual(ALL_MODELS.map((m) => m.id));
    expect(result.hasOptions).toBe(true);
    expect(result.defaultModelId).toBe(DEFAULT_MODEL.id);
    expect(result.proExhausted).toBe(false);
    expect(result.emptyReadiness).toBeUndefined();
    expect(result.codexManaged).toBe(false);
  });

  it('pro-only: offers the LazyPro/Managed group next to the free one', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'active', codexManaged: false });

    expect(result.groups.map((g) => g.id)).toEqual(['free', 'pro']);
    // The pro group excludes isFree entries — those already live in 'free'
    // (see modelPickerOptions.ts's managedOptions(): without this filter
    // ox alpha rendered TWICE whenever Pro was also active).
    expect(result.groups.find((g) => g.id === 'pro')!.models.map((m) => m.id)).toEqual(
      OPENROUTER_MODELS.filter((m) => !m.isFree).map((m) => m.id),
    );
    expect(result.hasOptions).toBe(true);
    expect(result.defaultModelId).toBe(DEFAULT_OPENROUTER_MODEL_ID);
    expect(result.proExhausted).toBe(false);
    expect(result.emptyReadiness).toBeUndefined();
    expect(result.codexManaged).toBe(false);
  });

  it('both: offers BOTH groups together (the confirmed bug this fixes)', () => {
    const result = buildModelPickerOptions({ claudeSub: true, pro: 'active', codexManaged: false });

    expect(result.groups.map((g) => g.id)).toEqual(['free', 'claude-sub', 'pro']);
    expect(result.groups.flatMap((g) => g.models.map((m) => m.id))).toEqual([
      ...OPENROUTER_MODELS.filter((m) => m.isFree).map((m) => m.id),
      ...ALL_MODELS.map((m) => m.id),
      // The pro group excludes isFree entries — already covered by 'free'.
      ...OPENROUTER_MODELS.filter((m) => !m.isFree).map((m) => m.id),
    ]);
    expect(result.hasOptions).toBe(true);
    // Managed default wins when both are entitled — mirrors getProviderMode()'s
    // own auto-detect priority (managed takes priority in auto mode).
    expect(result.defaultModelId).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('neither: only the free group remains — still usable via ox alpha', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'inactive', codexManaged: false });

    expect(result.groups.map((g) => g.id)).toEqual(['free']);
    expect(result.hasOptions).toBe(true);
    expect(result.proExhausted).toBe(false);
    expect(result.emptyReadiness).toBeUndefined();
    // CRITICAL fix: must be a member of the only group actually offered
    // ('free'), never the native DEFAULT_MODEL.id — that id belongs to a
    // group this user has no entitlement to see, so a caller seeding a form
    // with it (e.g. NewMissionModal) would silently mismatch the rendered
    // <select> and fail the launch preflight even though ox alpha works.
    expect(result.defaultModelId).toBe(OPENROUTER_MODELS.find((m) => m.isFree)!.id);
    expect(result.groups.flatMap((g) => g.models.map((m) => m.id))).toContain(result.defaultModelId);
    expect(result.codexManaged).toBe(false);
  });

  it('codex-managed: the free group still gives hasOptions — codexManaged stays false (the free tier means an empty picker can no longer happen)', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'inactive', codexManaged: true });

    expect(result.hasOptions).toBe(true);
    // codexManaged is gated on !hasOptions; with the free tier always present
    // the honest-Codex empty state is unreachable by construction.
    expect(result.codexManaged).toBe(false);
  });

  it('codexManaged is only ever true when hasOptions is false (claudeSub still wins the group even if codexManaged were somehow also true)', () => {
    const result = buildModelPickerOptions({ claudeSub: true, pro: 'inactive', codexManaged: true });

    expect(result.hasOptions).toBe(true);
    expect(result.codexManaged).toBe(false);
  });

  it('no-credit (Pro only, exhausted): free group remains, Pro-exhausted surfaced distinctly', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'no-credits', codexManaged: false });

    expect(result.groups.map((g) => g.id)).toEqual(['free']);
    expect(result.hasOptions).toBe(true);
    expect(result.proExhausted).toBe(true);
    expect(result.emptyReadiness).toBeUndefined();
    // Same rule as the 'neither' case: 'free' is the only group offered
    // here (Pro is exhausted, not active — no 'pro' group), so the default
    // must come from it, not the native (unoffered) DEFAULT_MODEL.id.
    expect(result.defaultModelId).toBe(OPENROUTER_MODELS.find((m) => m.isFree)!.id);
  });

  it('no-credit + Claude subscription: Claude group stays usable, Pro-exhausted is a secondary notice (not a hard empty state)', () => {
    const result = buildModelPickerOptions({ claudeSub: true, pro: 'no-credits', codexManaged: false });

    expect(result.groups.map((g) => g.id)).toEqual(['free', 'claude-sub']);
    expect(result.hasOptions).toBe(true);
    expect(result.proExhausted).toBe(true);
    expect(result.emptyReadiness).toBeUndefined();
    expect(result.defaultModelId).toBe(DEFAULT_MODEL.id);
  });

  // ── W-MODELSEL: lockedProGroup (upsell rendering) ────────────────

  it('pro inactive (no plan at all): lockedProGroup carries the FULL (non-free) Pro catalog for the disabled upsell group', () => {
    const result = buildModelPickerOptions({ claudeSub: true, pro: 'inactive', codexManaged: false });

    expect(result.lockedProGroup).toBeDefined();
    // isFree entries are excluded — they're already usable, unlocked, in the
    // 'free' group; the upsell is only for the PAID catalog.
    expect(result.lockedProGroup!.models.map((m) => m.id)).toEqual(
      OPENROUTER_MODELS.filter((m) => !m.isFree).map((m) => m.id),
    );
  });

  it('pro no-credits (plan active, wallet empty): lockedProGroup is NOT set — an "upgrade to Pro" pitch would be dishonest here', () => {
    const result = buildModelPickerOptions({ claudeSub: true, pro: 'no-credits', codexManaged: false });

    expect(result.lockedProGroup).toBeUndefined();
  });

  it('pro active: lockedProGroup is NOT set — the real group already covers it', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'active', codexManaged: false });

    expect(result.lockedProGroup).toBeUndefined();
  });

  // ── BYOK wave: the keyed provider's catalog as a pickable group ──

  it('byok-only: offers the BYOK group with the provider catalog', () => {
    const result = buildModelPickerOptions({
      claudeSub: false,
      pro: 'inactive',
      codexManaged: false,
      byok: resolveByokDef('deepseek')!,
    });

    expect(result.groups.map((g) => g.id)).toEqual(['free', 'byok']);
    expect(result.groups.find((g) => g.id === 'byok')!.models.map((m) => m.id)).toContain('deepseek-chat');
    expect(result.hasOptions).toBe(true);
    expect(result.defaultModelId).toBe('deepseek-chat');
    expect(result.byok?.id).toBe('deepseek');
  });

  it('claude-sub + byok + pro active: all three groups coexist in order', () => {
    const result = buildModelPickerOptions({
      claudeSub: true,
      pro: 'active',
      codexManaged: false,
      byok: resolveByokDef('deepseek')!,
    });

    expect(result.groups.map((g) => g.id)).toEqual(['free', 'claude-sub', 'byok', 'pro']);
    // Managed default still wins when Pro is actively usable.
    expect(result.defaultModelId).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('byok is null when no provider is keyed', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'inactive', codexManaged: false });
    expect(result.byok).toBeNull();
    expect(result.groups.map((g) => g.id)).toEqual(['free']);
  });
});

// ── detectModelEntitlements — live detection ───────────────────────

describe('detectModelEntitlements', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  function simulateTauri(): void {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
  }

  it('outside Tauri: does not invent a Claude CLI entitlement (browser cannot run it)', () => {
    expect(detectModelEntitlements()).toEqual({ claudeSub: false, pro: 'inactive', codexManaged: false, byok: null });
  });

  it('outside Tauri + managed credits: Pro is offerable, Claude CLI is not', () => {
    setManagedAvailability(true);
    expect(detectModelEntitlements()).toEqual({ claudeSub: false, pro: 'active', codexManaged: false, byok: null });
  });

  it('Tauri + nothing detected or declared: neither entitlement', () => {
    simulateTauri();
    expect(detectModelEntitlements()).toEqual({ claudeSub: false, pro: 'inactive', codexManaged: false, byok: null });
  });

  it('Tauri + claude CLI detected available: claudeSub true', () => {
    simulateTauri();
    mockedIsCliBackendAvailable.mockImplementation((tool: string) => tool === 'claude');

    expect(detectModelEntitlements().claudeSub).toBe(true);
  });

  it('Tauri + Anthropic BYOK key present: claudeSub true', () => {
    simulateTauri();
    mockedHasAnthropicKey.mockReturnValue(true);

    expect(detectModelEntitlements().claudeSub).toBe(true);
  });

  it('Tauri + accessMode "cli"/"claude" declared (CLI detection not yet confirmed): claudeSub trusted true', () => {
    simulateTauri();
    saveAccessSettings({ accessMode: 'cli', cliTool: 'claude' });

    expect(detectModelEntitlements().claudeSub).toBe(true);
  });

  it('Tauri + accessMode "byok" declared without a key: no Claude group (honest empty state)', () => {
    simulateTauri();
    saveAccessSettings({ accessMode: 'byok' });

    expect(detectModelEntitlements().claudeSub).toBe(false);
  });

  // ── BYOK wave: the keyed provider appears as a selectable group ──

  it('Tauri + DeepSeek key set (selected): byok entitlement is deepseek', () => {
    simulateTauri();
    // Under Tauri, saveByokKey is the source of truth (OS credential vault,
    // mirrored into byokProviders.ts's synchronous in-memory cache) — not
    // localStorage directly, see byokProviders.ts's header comment.
    saveByokKey('deepseek', 'sk-test');
    saveAccessSettings({ accessMode: 'byok', byokProvider: 'deepseek' });

    const e = detectModelEntitlements();
    expect(e.byok?.id).toBe('deepseek');
    // The Claude group disappears: with DeepSeek as the BYOK engine, native
    // Claude models would be listed but never served. The free group stays.
    expect(buildModelPickerOptions(e).groups.map((g) => g.id)).toEqual(['free', 'byok']);
  });

  it('Tauri + key set but no selection: first keyed non-Anthropic provider wins', () => {
    simulateTauri();
    saveByokKey('mistral', 'sk-test');

    expect(detectModelEntitlements().byok?.id).toBe('mistral');
  });

  it('Tauri + Anthropic key only: no byok group (native models already live in claude-sub)', () => {
    simulateTauri();
    mockedHasAnthropicKey.mockReturnValue(true);

    expect(detectModelEntitlements().byok).toBeNull();
  });

  it('Tauri + accessMode "cli" with cliTool "codex": claudeSub stays false — Codex is not a Claude subscription', () => {
    simulateTauri();
    saveAccessSettings({ accessMode: 'cli', cliTool: 'codex' });

    expect(detectModelEntitlements().claudeSub).toBe(false);
  });

  it('Tauri + accessMode "cli" with cliTool "codex": codexManaged is true — the picker must show the honest Codex message, not the generic fallback', () => {
    simulateTauri();
    saveAccessSettings({ accessMode: 'cli', cliTool: 'codex' });

    expect(detectModelEntitlements().codexManaged).toBe(true);
  });

  it('Tauri + Pro credits active: pro "active"', () => {
    simulateTauri();
    setManagedAvailability(true);

    expect(detectModelEntitlements().pro).toBe('active');
  });

  it('Tauri + Pro plan active but no credits: pro "no-credits"', () => {
    simulateTauri();
    setManagedAvailability(false);
    setProPlanActive(true);

    expect(detectModelEntitlements().pro).toBe('no-credits');
  });

  it('Tauri + no Pro plan at all: pro "inactive"', () => {
    simulateTauri();
    setManagedAvailability(false);
    setProPlanActive(false);

    expect(detectModelEntitlements().pro).toBe('inactive');
  });

  it('Tauri + BOTH a Claude subscription and Pro credits: both entitlements report true/active at once', () => {
    simulateTauri();
    mockedIsCliBackendAvailable.mockImplementation((tool: string) => tool === 'claude');
    setManagedAvailability(true);

    expect(detectModelEntitlements()).toEqual({ claudeSub: true, pro: 'active', codexManaged: false, byok: null });
  });
});

describe('getModelPickerOptions', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('wires live entitlement detection into buildModelPickerOptions', () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    setManagedAvailability(true);

    const result = getModelPickerOptions();

    expect(result.pro).toBe('active');
    expect(result.groups.some((g) => g.id === 'pro')).toBe(true);
  });

  it('outside Tauri: only the free group is selectable (no native Claude ids)', () => {
    const result = getModelPickerOptions();
    expect(result.groups.map((g) => g.id)).toEqual(['free']);
    expect(result.defaultModelId).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(result.groups.flatMap((g) => g.models.map((m) => m.id))).not.toContain('claude-sonnet-5');
  });
});

describe('isSelectablePickerModel', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('outside Tauri: native Sonnet and paid GLM 5.2 are not selectable; the free rail is', () => {
    expect(isSelectablePickerModel('claude-sonnet-5')).toBe(false);
    expect(isSelectablePickerModel('z-ai/glm-5.2')).toBe(false);
    expect(isSelectablePickerModel(FREE_OPENROUTER_MODEL_ID)).toBe(true);
    expect(isSelectablePickerModel('stealth/ox-alpha')).toBe(false);
  });

  it('Tauri + Claude CLI: native Sonnet is selectable', () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    mockedIsCliBackendAvailable.mockImplementation((tool: string) => tool === 'claude');
    expect(isSelectablePickerModel('claude-sonnet-5')).toBe(true);
  });
});
