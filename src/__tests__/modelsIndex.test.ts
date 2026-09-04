import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// NOTE: models/index.ts imports Tauri directly at the top-level via invoke.
// The global setup.ts already mocks @tauri-apps/api/core, so imports succeed.
// We test the pure/stateless helpers; getProvider() uses module-level state
// so we test routing logic by checking the exported pure functions.

import {
  loadAccessSettings,
  saveAccessSettings,
  getProviderMode,
  getProvider,
  isManagedActive,
  setManagedAvailability,
  describeProviderReadiness,
  getDefaultModelIdForMode,
  getActiveModel,
} from '../lib/models/index';
import { DEFAULT_MODEL, findModelById } from '../lib/models/registry';
import { DEFAULT_OPENROUTER_MODEL_ID, findOpenRouterModel } from '../lib/models/openrouterCatalog';

// localStorage is provided by jsdom
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // Reset managed availability to false before each test
  setManagedAvailability(false);
});

describe('loadAccessSettings / saveAccessSettings', () => {
  it('loadAccessSettings returns empty object when nothing is stored', () => {
    const settings = loadAccessSettings();
    expect(settings).toEqual({});
  });

  it('saveAccessSettings + loadAccessSettings roundtrip', () => {
    saveAccessSettings({ accessMode: 'byok', byokProvider: 'anthropic' });
    const loaded = loadAccessSettings();
    expect(loaded.accessMode).toBe('byok');
    expect(loaded.byokProvider).toBe('anthropic');
  });

  it('saveAccessSettings overwrites previous value', () => {
    saveAccessSettings({ accessMode: 'cli', cliTool: 'claude' });
    saveAccessSettings({ accessMode: 'byok' });
    const loaded = loadAccessSettings();
    expect(loaded.accessMode).toBe('byok');
    expect(loaded.cliTool).toBeUndefined();
  });
});

describe('getProviderMode', () => {
  it('returns "mock" when not in Tauri runtime (jsdom)', () => {
    // No __TAURI_INTERNALS__ in jsdom → should return "mock"
    const mode = getProviderMode();
    expect(mode).toBe('mock');
  });

  it('returns "mock" regardless of accessSettings when not in Tauri', () => {
    saveAccessSettings({ accessMode: 'cli', cliTool: 'claude' });
    const mode = getProviderMode();
    expect(mode).toBe('mock');
  });
});

describe('cliBackendProvider factory', () => {
  it('claude backend listModels returns only anthropic models', async () => {
    // Import dynamically to get the actual function (Tauri already mocked)
    const { cliBackendProvider } = await import('../lib/models/cliBackendProvider');
    const provider = cliBackendProvider('claude');
    const models = provider.listModels();
    expect(models.every(m => m.provider === 'anthropic')).toBe(true);
    // Non-emptiness guard: `every()` on an empty array is vacuously true, so
    // without this an accidental empty ALL_MODELS/claude filter would still
    // pass the assertion above. This is the exact shape of bug that let the
    // codex assertion below stay green while listModels('codex') silently
    // always returned [] (see that test's comment).
    expect(models.length).toBeGreaterThan(0);
  });

  it('codex backend listModels returns [] — Codex has no in-app model catalog', async () => {
    const { cliBackendProvider } = await import('../lib/models/cliBackendProvider');
    const provider = cliBackendProvider('codex');
    const models = provider.listModels();
    // Documented, intentional contract (see cliBackendProvider.ts's
    // listModels doc comment and modelPickerOptions.ts's
    // MODEL_MANAGED_BY_CODEX_MESSAGE) — NOT a bug: ALL_MODELS is
    // Anthropic-only (registry.ts's module comment), so there is no OpenAI
    // catalog to filter down to; the Codex CLI manages its own model
    // selection. The PREVIOUS assertion here was
    // `models.every(m => m.provider === 'openai')`, which is vacuously true
    // for an empty array — it could never fail even while this always
    // silently returned []. Asserting the exact expected value instead means
    // this test actually fails if someone changes the contract (e.g. by
    // fabricating fake OpenAI entries in the registry).
    expect(models).toEqual([]);
  });

  it('isCliBackendAvailable returns null before detectAllCliBackends is called', async () => {
    const { isCliBackendAvailable } = await import('../lib/models/cliBackendProvider');
    // Before detection, should be null (not yet checked)
    const result = isCliBackendAvailable('claude');
    // Either null (not checked) or false (Tauri invoke mock returned undefined)
    expect(result === null || result === false).toBe(true);
  });
});

describe('describeProviderReadiness', () => {
  it('is not ready in a non-Tauri (mock) context', () => {
    const r = describeProviderReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/moteur|clé API|Claude Code/i);
  });

  it('is not ready in pro mode (subscription required)', () => {
    const r = describeProviderReadiness('pro');
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/Abonnement Pro/i);
  });

  it('pro mode readiness text mentions Modèles for engine selection', () => {
    const r = describeProviderReadiness('pro');
    expect(r.reason).toMatch(/Modèles/i);
  });

  it('is ready when an engine mode is active', () => {
    const r = describeProviderReadiness('live-key');
    expect(r.ready).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

// ── isManagedActive ───────────────────────────────────────────────

describe('isManagedActive', () => {
  it('returns false when _managedActive is false, accessMode unset', () => {
    setManagedAvailability(false);
    localStorage.clear();
    expect(isManagedActive()).toBe(false);
  });

  it('returns true when _managedActive is true and accessMode is unset (auto)', () => {
    setManagedAvailability(true);
    localStorage.clear();
    expect(isManagedActive()).toBe(true);
  });

  it('returns true when _managedActive is true and accessMode is "pro"', () => {
    setManagedAvailability(true);
    saveAccessSettings({ accessMode: 'pro' });
    expect(isManagedActive()).toBe(true);
  });

  it('returns false when _managedActive is true but accessMode is "cli"', () => {
    setManagedAvailability(true);
    saveAccessSettings({ accessMode: 'cli' });
    expect(isManagedActive()).toBe(false);
  });

  it('returns false when _managedActive is true but accessMode is "byok"', () => {
    setManagedAvailability(true);
    saveAccessSettings({ accessMode: 'byok' });
    expect(isManagedActive()).toBe(false);
  });
});

// ── getProviderMode with Tauri runtime ───────────────────────────

describe('getProviderMode (Tauri runtime simulation)', () => {
  afterEach(() => {
    // Remove the Tauri marker we added
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    setManagedAvailability(false);
    localStorage.clear();
  });

  function simulateTauri(): void {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
  }

  it('returns "managed" when _managedActive is true and accessMode is unset', () => {
    simulateTauri();
    setManagedAvailability(true);
    localStorage.clear();
    expect(getProviderMode()).toBe('managed');
  });

  it('returns "claude-code" when accessMode is "cli" even if _managedActive is true', () => {
    simulateTauri();
    setManagedAvailability(true);
    saveAccessSettings({ accessMode: 'cli', cliTool: 'claude' });
    expect(getProviderMode()).toBe('claude-code');
  });

  it('returns "live-key" when accessMode is "byok" even if _managedActive is true', () => {
    simulateTauri();
    setManagedAvailability(true);
    saveAccessSettings({ accessMode: 'byok' });
    expect(getProviderMode()).toBe('live-key');
  });

  it('returns "managed" when accessMode is "pro" and _managedActive is true', () => {
    simulateTauri();
    setManagedAvailability(true);
    saveAccessSettings({ accessMode: 'pro' });
    expect(getProviderMode()).toBe('managed');
  });

  it('returns "pro" when accessMode is "pro" and _managedActive is false', () => {
    simulateTauri();
    setManagedAvailability(false);
    saveAccessSettings({ accessMode: 'pro' });
    expect(getProviderMode()).toBe('pro');
  });
});

// ── getProvider with Tauri runtime ───────────────────────────────

describe('getProvider (Tauri runtime simulation)', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    setManagedAvailability(false);
    localStorage.clear();
  });

  function simulateTauri(): void {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
  }

  it('returns managed provider (id "managed") when _managedActive is true and accessMode is unset', () => {
    simulateTauri();
    setManagedAvailability(true);
    localStorage.clear();
    const provider = getProvider();
    expect(provider.id).toBe('managed');
  });

  it('returns cli provider when accessMode is "cli" even if _managedActive is true', () => {
    simulateTauri();
    setManagedAvailability(true);
    saveAccessSettings({ accessMode: 'cli', cliTool: 'claude' });
    const provider = getProvider();
    // cliBackendProvider('claude') has id 'cli-claude'
    expect(provider.id).toBe('cli-claude');
  });
});

// ── getDefaultModelIdForMode ──────────────────────────────────────
// The BLOCKER this resolves: LazyManager (and manager-launched missions)
// used to always default to a native Anthropic id, which the managed/Pro
// ai-proxy rejects with "Modèle non supporté" (400). The default must be
// mode-aware — OpenRouter id for managed/pro, native id everywhere else.

describe('getDefaultModelIdForMode', () => {
  it('returns the OpenRouter default id in "managed" mode', () => {
    expect(getDefaultModelIdForMode('managed')).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('returns the OpenRouter default id in "pro" mode (selected but not yet active)', () => {
    expect(getDefaultModelIdForMode('pro')).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('the managed/pro default is a real OpenRouter-format id (contains a provider prefix)', () => {
    expect(getDefaultModelIdForMode('managed')).toContain('/');
  });

  it('returns the native Anthropic default id in "claude-code" mode', () => {
    expect(getDefaultModelIdForMode('claude-code')).toBe(DEFAULT_MODEL.id);
  });

  // 'codex' is deliberately NOT the same as claude-code/live-key/mock: the
  // registry (ALL_MODELS/DEFAULT_MODEL) is Anthropic-only (see registry.ts's
  // module comment — the OpenAI/Google stubs were removed), so there is no
  // real "codex default model id" in there. Returning DEFAULT_MODEL.id used
  // to silently forward an Anthropic model id to the OpenAI Codex CLI via
  // agent_cli_chat_stream (cliBackendProvider.ts) — a genuine cross-provider
  // mismatch this resolves.
  it('returns an empty id (never an Anthropic id) in "codex" mode — the Codex CLI picks its own default', () => {
    expect(getDefaultModelIdForMode('codex')).toBe('');
  });

  it('the "codex" empty id is never one of the Anthropic registry ids', () => {
    const anthropicIds = new Set(
      ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    );
    const codexId = getDefaultModelIdForMode('codex');
    expect(codexId === undefined || !anthropicIds.has(codexId)).toBe(true);
  });

  it('returns the native Anthropic default id in "live-key" mode', () => {
    expect(getDefaultModelIdForMode('live-key')).toBe(DEFAULT_MODEL.id);
  });

  it('returns the native Anthropic default id in "mock" mode', () => {
    expect(getDefaultModelIdForMode('mock')).toBe(DEFAULT_MODEL.id);
  });

  it('never returns an OpenRouter id (with a provider prefix) for a non-managed mode', () => {
    for (const mode of ['claude-code', 'codex', 'live-key', 'mock'] as const) {
      expect(getDefaultModelIdForMode(mode)).not.toContain('/');
    }
  });
});

// ── getActiveModel ──────────────────────────────────────────────────
// The fix for DEFECT #1 (real-app QA): InlineEditBar, autoFix, AiReview and
// SettingsPanel used to hardcode 'claude-sonnet-4-20250514' — a stale id the
// Claude Code CLI subscription path rejects outright ("may not exist or you
// may not have access to it"), so Ctrl+K inline-edit never produced a diff.
// getActiveModel() replaces every one of those literals; it must resolve
// exactly like the working Ask composer does (assistantStore's
// INITIAL_STATE.selectedModel / Composer's getManagedModelDisplay()) so
// every AI feature agrees on "the active model" instead of each hardcoding
// its own id.

describe('getActiveModel', () => {
  it('defaults to DEFAULT_MODEL (Haiku) when no override is persisted — the same default the Ask composer starts with', () => {
    expect(getActiveModel()).toEqual(DEFAULT_MODEL);
  });

  it('never returns the stale hardcoded literal that broke inline-edit under Claude Code CLI', () => {
    expect(getActiveModel().id).not.toBe('claude-sonnet-4-20250514');
  });

  it('honors a persisted native model id (CLI/BYOK/auto id namespace)', () => {
    saveAccessSettings({ model: 'claude-opus-5' });
    expect(getActiveModel()).toEqual(findModelById('claude-opus-5'));
  });

  it('falls back to DEFAULT_MODEL when the persisted id is unknown (e.g. removed from the registry)', () => {
    saveAccessSettings({ model: 'gpt-999-does-not-exist' });
    expect(getActiveModel()).toEqual(DEFAULT_MODEL);
  });

  describe('managed/pro mode (Tauri runtime simulation)', () => {
    afterEach(() => {
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
      setManagedAvailability(false);
      localStorage.clear();
    });

    function simulateTauri(): void {
      (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    }

    it('resolves the OpenRouter catalog default when managed is active and no model is persisted', () => {
      simulateTauri();
      setManagedAvailability(true);
      const active = getActiveModel();
      expect(active.id).toBe(DEFAULT_OPENROUTER_MODEL_ID);
      expect(findOpenRouterModel(active.id)).toBeDefined();
    });

    it('honors a persisted OpenRouter model id when accessMode is "pro"', () => {
      simulateTauri();
      setManagedAvailability(false);
      saveAccessSettings({ accessMode: 'pro', model: 'anthropic/claude-opus-5' });
      const active = getActiveModel();
      expect(active.id).toBe('anthropic/claude-opus-5');
      expect(active.label).toBe('Claude Opus 5');
    });

    it('never leaks a native id into the managed/OpenRouter namespace — falls back to the OpenRouter default instead', () => {
      simulateTauri();
      setManagedAvailability(true);
      // A native id left over from CLI mode must not be forwarded to the
      // managed ai-proxy, which only understands OpenRouter-format ids.
      saveAccessSettings({ model: 'claude-opus-5' });
      const active = getActiveModel();
      expect(active.id).toBe(DEFAULT_OPENROUTER_MODEL_ID);
    });
  });
});
