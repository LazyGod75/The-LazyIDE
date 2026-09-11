/* Model gateway — entry point.
   Routing priority (auto mode):
     1. Claude Code CLI (subscription, no API key) — default under Tauri when claude is installed
     2. Anthropic BYOK key (localStorage or ANTHROPIC_API_KEY env var)
     3. mockProvider (browser / no provider available)

   User-overridable via AccessSettings persisted in localStorage.
*/

import { invoke } from '@tauri-apps/api/core';
import { isTauri as isTauriRuntime } from '../platform/index.js';
import type { ModelInfo, ModelProvider } from './types.js';
import { mockProvider } from './mockProvider.js';
import { anthropicProvider, hasAnthropicKey } from './anthropicProvider.js';
import { webAnthropicProvider, hasWebAnthropicKey } from './webAnthropicProvider.js';
import { claudeCodeProvider } from './claudeCodeProvider.js';
import { managedProvider } from './managedProvider.js';
import {
  cliBackendProvider,
  detectAllCliBackends,
  isCliBackendAvailable,
} from './cliBackendProvider.js';
import { loadAccessSettings } from './accessSettings.js';
import { DEFAULT_MODEL, findModelById } from './registry.js';
import { DEFAULT_OPENROUTER_MODEL_ID, findOpenRouterModel, isOpenRouterFreeModel, migrateRetiredOpenRouterId } from './openrouterCatalog.js';
import { DEFAULT_DEVIN_MODEL_ID, findDevinModel, isDevinModel, refreshDevinCatalog } from './devinCatalog.js';
import { withFallback } from './providerFallback.js';
import { localProvider } from './localProvider.js';
import {
  BYOK_PROVIDER_DEFS,
  resolveByokDef,
  hasByokKey,
  effectiveByokModel,
  byokModelInfos,
  findByokModel,
  createOpenAICompatProvider,
} from './byokProviders.js';

export * from './types.js';
export * from './registry.js';
export * from './costStore.js';
export * from './claudeCodeProvider.js';
export * from './cliBackendProvider.js';
export * from './managedProvider.js';
export * from './byokProviders.js';
export { localProvider, isLocalAvailable, detectLocalBaseUrl, listLocalModels } from './localProvider.js';
// Re-export access settings so existing callers (from '../lib/models') keep working.
export * from './accessSettings.js';
// StreamEvent/StreamPart helpers (structured assistant stream) — see
// assistantStore.tsx and MessageList.tsx. No export-name collisions with
// the modules above (stripInvisibleLines stays defined in
// brainSearchLoop.ts, re-exported only via managedProvider.ts as before).
export * from './streamEvents.js';
export * from './devinCatalog.js';

// ── No-model provider (desktop only) ─────────────────────────────
//
// Returned by autoDetectProvider() on Tauri when no LLM is configured so the
// Assistant UI surfaces a clear setup prompt instead of streaming canned French
// responses from mockProvider.
//
// Web demo path continues to use mockProvider (unchanged).

// Key models.noModelConfigured is registered in all i18n locales.
// This constant is yielded outside React; the display layer translates it via t('models.noModelConfigured').
const NO_MODEL_MESSAGE =
  'No model configured. Open Settings > Models to set up a CLI tool (Claude Code / Codex), add a BYOK Anthropic key, or activate a Pro subscription.';

const noModelProvider: ModelProvider = {
  id: 'none',
  label: 'No model configured',
  listModels: () => [],
  async *streamChat(): AsyncIterable<string> {
    yield NO_MODEL_MESSAGE;
  },
};

// ── Runtime state ─────────────────────────────────────────────────

/** Cached claude CLI availability (legacy; now delegates to cliBackendProvider cache). */
let _claudeCodeAvailable: boolean | null = null;

/** Whether the managed (Pro) backend is active for the current user.
    Provider selection is synchronous, so the React layer pushes the
    subscription state here via setManagedAvailability(). */
let _managedActive = false;

/** Called by the billing layer when the subscription state changes. */
export function setManagedAvailability(active: boolean): void {
  _managedActive = active;
}

/** Tri-state read of the Pro plan bridge — 'unknown' until the billing
    layer's first subscription fetch settles, then 'active'/'inactive' for
    the rest of the session (see setProPlanActive). Distinct from a plain
    boolean specifically so a cold-start read (before useSubscription's
    fetch resolves) is NOT indistinguishable from "confirmed no plan". */
export type ProPlanState = 'unknown' | 'active' | 'inactive';

/** Whether the user's Pro PLAN is active (status active/trialing), regardless
    of remaining credits. Pushed by the billing layer alongside
    setManagedAvailability so the entitlement module can distinguish
    "plan active, 0 credits" (pro-no-credits) from "no plan" (pro-inactive).
    Defaults to 'unknown' — see getProPlanState's doc comment for why
    proReadiness() must never treat this default the same as a settled
    "inactive" (that was the false "pro-inactive" cold-start flash a real
    Pro user could see before useSubscription's fetch resolved). */
let _proPlanState: ProPlanState = 'unknown';

/** Called by the billing layer once its subscription fetch has settled —
    with a DEFINITE answer, success or failure/empty alike. Never call this
    to represent "still loading": settling to 'inactive' prematurely is
    exactly the bug this bridge exists to prevent (see _proPlanState). */
export function setProPlanActive(active: boolean): void {
  _proPlanState = active ? 'active' : 'inactive';
}

/** Synchronous boolean read of the Pro plan bridge (see setProPlanActive).
    Collapses 'unknown' to false — callers that need to tell "not settled
    yet" apart from "confirmed inactive" must use getProPlanState() instead
    (this is what entitlement.ts's proReadiness() does). */
export function isProPlanActive(): boolean {
  return _proPlanState === 'active';
}

/** Tri-state read of the Pro plan bridge — see _proPlanState/ProPlanState. */
export function getProPlanState(): ProPlanState {
  return _proPlanState;
}

/** Raw bridge read: Pro plan active AND credits remaining, regardless of the
    user's selected access mode. Contrast isManagedActive(), which also
    requires the mode to be pro/auto — the entitlement module needs the raw
    signal to evaluate the Pro engine even while the user is on cli/byok
    (e.g. the locked managed catalog in Settings). */
export function hasManagedCreditsActive(): boolean {
  return _managedActive;
}

/** True when the managed (Pro) backend should be used.
    - accessMode === 'pro' + active subscription → managed.
    - accessMode unset (auto) + active subscription → managed (auto-route).
    - accessMode === 'cli' or 'byok' → never managed (explicit user choice). */
export function isManagedActive(): boolean {
  if (!_managedActive) return false;
  const { accessMode } = loadAccessSettings();
  return accessMode === 'pro' || accessMode == null;
}

/** Call once at startup to cache all CLI availability + legacy flag. */
export async function initProviderMode(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    // Detect all CLI backends (claude, codex, devin, ...)
    await detectAllCliBackends();
    // Keep legacy flag in sync
    _claudeCodeAvailable = isCliBackendAvailable('claude') ?? false;
    // Devin detected: refresh its live model catalog in the background —
    // one short-lived `devin acp` process, results cached for pickers.
    if (isCliBackendAvailable('devin') === true) {
      void refreshDevinCatalog();
    }
  } catch {
    _claudeCodeAvailable = false;
  }

  // Legacy fallback: try claude_available directly
  if (_claudeCodeAvailable === null) {
    try {
      const available = await invoke<boolean>('claude_available');
      _claudeCodeAvailable = available;
    } catch {
      _claudeCodeAvailable = false;
    }
  }
}

// ── ProviderMode (UI badge) ───────────────────────────────────────

export type ProviderMode =
  | 'claude-code'    // CLI subscription via Claude Code
  | 'codex'         // CLI subscription via Codex
  | 'devin'         // Devin CLI over ACP (SWE-2 + account catalog)
  | 'live-key'      // BYOK Anthropic key
  | 'local'         // Local LLM (Ollama / LM Studio)
  | 'managed'       // Lazy managed Pro — active subscription, serving via ai-proxy
  | 'pro'           // Lazy managed Pro selected but not active (no subscription)
  | 'mock';

export function getProviderMode(): ProviderMode {
  if (!isTauriRuntime()) return 'mock';

  const settings = loadAccessSettings();

  if (settings.accessMode === 'pro') {
    return _managedActive ? 'managed' : 'pro';
  }

  if (settings.accessMode === 'byok') return 'live-key';

  if (settings.accessMode === 'local') return 'local';

  if (settings.accessMode === 'cli') {
    const tool = settings.cliTool ?? 'claude';
    if (tool === 'codex') return 'codex';
    if (tool === 'devin') return 'devin';
    return 'claude-code';
  }

  // Auto-detect: managed subscription takes priority when no explicit mode is set.
  if (_managedActive) return 'managed';

  if (_claudeCodeAvailable === true) return 'claude-code';
  if (isCliBackendAvailable('codex') === true) return 'codex';
  // Devin auto-detect sits after claude/codex so an existing setup's engine
  // never silently changes on upgrade — explicit selection (Settings >
  // Models, or picking a Devin model) is the primary path anyway.
  if (isCliBackendAvailable('devin') === true) return 'devin';
  if (hasAnthropicKey()) return 'live-key';
  if (_claudeCodeAvailable === null) return 'claude-code';
  return 'mock';
}

/**
 * Default model id for a given provider mode — the single source of truth
 * for "which model should we start with before the user picks one".
 *
 * The managed/Pro ai-proxy only accepts OpenRouter-format ids (e.g.
 * 'anthropic/claude-sonnet-5') — see managedProvider.ts's streamProxyBody,
 * which forwards the model string to the proxy as-is with no translation.
 * claude-code/live-key/mock use native Anthropic ids (e.g.
 * 'claude-haiku-4-5'), consumed by the CLI/BYOK path. Mixing the two id
 * families is exactly the "Modèle non supporté" failure this resolves.
 *
 * 'codex' is deliberately NOT folded into the native-id branch: ALL_MODELS/
 * DEFAULT_MODEL are Anthropic-only (see registry.ts's module comment — the
 * OpenAI stubs were removed from the registry), so there is no real "codex
 * default model id" to return here. Returning DEFAULT_MODEL.id used to
 * silently forward an Anthropic model id to the OpenAI Codex CLI via
 * agent_cli_chat_stream (cliBackendProvider.ts) — a genuine cross-provider
 * mismatch. Returns '' instead: buildRunTurn already treats a falsy
 * req.model.id as "omit the model param" (`model: req.model.id || undefined`),
 * so the Codex CLI falls through to its OWN default model, exactly like an
 * absent id would.
 *
 * Mirrors NewMissionModal's getInitialModelId() so every "pick a starting
 * model for the current mode" call site (New Mission form, LazyManager,
 * manager-launched missions) agrees on the same mapping instead of each
 * hardcoding its own default.
 */
export function getDefaultModelIdForMode(mode: ProviderMode): string {
  if (mode === 'managed' || mode === 'pro') return DEFAULT_OPENROUTER_MODEL_ID;
  if (mode === 'codex') return '';
  if (mode === 'devin') return DEFAULT_DEVIN_MODEL_ID;
  if (mode === 'live-key') {
    // BYOK wave: the default model belongs to the SELECTED BYOK provider's
    // catalog (e.g. deepseek-chat for DeepSeek), never an Anthropic id.
    const def = resolveByokDef(loadAccessSettings().byokProvider);
    if (def) return effectiveByokModel(def);
  }
  return DEFAULT_MODEL.id;
}

/**
 * Sentinel returned by getActiveModel() for 'codex' mode — see that
 * function's doc comment. id: '' is intentional, mirroring
 * getDefaultModelIdForMode('codex'): cliBackendProvider.ts's buildRunTurn
 * treats a falsy req.model.id as "omit the model param"
 * (`model: req.model.id || undefined`), letting the Codex CLI use its own
 * default instead of receiving a misrepresented Anthropic id. provider:
 * 'openai' (not 'anthropic') so this is never mistaken for a real
 * ALL_MODELS/registry entry if it ever leaks into UI that expects one.
 */
const CODEX_MANAGED_MODEL: ModelInfo = {
  id: '',
  label: 'Codex (modèle géré par la CLI)',
  provider: 'openai',
  description: "Le CLI Codex choisit lui-même son modèle — aucun id natif ne s'applique.",
};

/**
 * Resolves the model that AI features OUTSIDE the Assistant composer should
 * use — inline edit (Ctrl+K), auto-fix, AI code review, and any future
 * one-shot AI action that isn't wired into assistantStore's React context.
 *
 * Mirrors the exact fallback chain the composer itself already uses (see
 * Composer.tsx's getManagedModelDisplay() and assistantStore's
 * INITIAL_STATE.selectedModel) so every AI feature agrees on "which model
 * is active" instead of each hardcoding its own id:
 *   - managed/pro mode  -> the user's persisted OpenRouter model
 *                          (AccessSettings.model, OpenRouter id namespace),
 *                          falling back to DEFAULT_OPENROUTER_MODEL_ID.
 *   - codex mode        -> CODEX_MANAGED_MODEL (id: ''), never a persisted
 *                          or default native id — see that constant's doc
 *                          comment. getProvider() resolves to
 *                          cliBackendProvider('codex') in this mode (see
 *                          InlineEditBar.tsx/autoFix.ts/AiReview.tsx, which
 *                          pass getActiveModel() straight into
 *                          provider.streamChat's req.model), so returning
 *                          DEFAULT_MODEL here would forward an Anthropic id
 *                          to the Codex CLI — the same cross-provider leak
 *                          getDefaultModelIdForMode('codex') fixes.
 *   - every other mode  -> the user's persisted native model
 *                          (AccessSettings.model, native Anthropic id
 *                          namespace), falling back to DEFAULT_MODEL — the
 *                          same default the Ask composer starts with.
 *
 * Never returns a stale/hardcoded literal: every id returned here comes
 * either from a live registry above or from the user's own persisted
 * choice, resolved through the same accessMode routing getProvider() uses.
 */
export function getActiveModel(): ModelInfo {
  const mode = getProviderMode();
  const settings = loadAccessSettings();

  if (mode === 'managed' || mode === 'pro') {
    const id = migrateRetiredOpenRouterId(settings.model ?? DEFAULT_OPENROUTER_MODEL_ID);
    const entry = findOpenRouterModel(id) ?? findOpenRouterModel(DEFAULT_OPENROUTER_MODEL_ID);
    if (entry) return { id: entry.id, label: entry.label, provider: entry.provider };
  } else if (mode === 'codex') {
    return CODEX_MANAGED_MODEL;
  } else if (mode === 'devin') {
    const entry = findDevinModel(settings.model) ?? findDevinModel(DEFAULT_DEVIN_MODEL_ID);
    if (entry) return entry;
  } else if (mode === 'live-key') {
    // BYOK wave: resolve against the selected provider's own catalog.
    const def = resolveByokDef(settings.byokProvider);
    if (def) {
      const modelId = settings.model || effectiveByokModel(def);
      const found = findByokModel(def, modelId);
      if (found) return found;
      // settings.model may hold a native Anthropic id picked in another
      // mode — fall back to the provider's own default, never leak it.
      return byokModelInfos(def)[0] ?? DEFAULT_MODEL;
    }
  } else if (settings.model) {
    const native = findModelById(settings.model);
    if (native) return native;
  }

  return DEFAULT_MODEL;
}

// ── Provider Readiness ────────────────────────────────────────────

export interface ProviderReadiness {
  ready: boolean;
  reason?: string;
}

/** i18n translate function shape — see byokProviders.ts's Translate doc
 *  comment for why this is a local structural type rather than a shared
 *  import (avoids a circular import with byokProviders.ts, which this file
 *  also imports FROM). Optional everywhere: omitting `t` is never a
 *  behavior change (falls back to the ORIGINAL hardcoded French), same
 *  contract as readiness.ts/runtime.ts/managedAgent.ts. */
type Translate = (key: string, params?: Record<string, string | number>) => string;

export function describeProviderReadiness(mode: ProviderMode = getProviderMode(), t?: Translate): ProviderReadiness {
  if (mode === 'mock') {
    return {
      ready: false,
      reason: t
        ? t('models.readiness.noEngine')
        : 'Aucun moteur détecté. Ajoute une clé API (Réglages > Modèles) ou installe Claude Code.',
    };
  }
  if (mode === 'pro') {
    return {
      ready: false,
      reason: t
        ? t('models.readiness.proRequired')
        : "Abonnement Pro requis — active-le dans Réglages > Compte, puis sélectionne le moteur Pro dans Réglages > Modèles.",
    };
  }
  if (mode === 'live-key') {
    // BYOK wave: readiness follows the SELECTED BYOK provider's key.
    const def = resolveByokDef(loadAccessSettings().byokProvider);
    if (def && !hasByokKey(def.id)) {
      return {
        ready: false,
        reason: t
          ? t('models.byok.noKeyConfigured', { provider: def.label })
          : `Aucune clé API ${def.label} configurée. Ajoute-la dans Réglages > Modèles.`,
      };
    }
  }
  return { ready: true };
}

// ── Provider selector ─────────────────────────────────────────────

/**
 * Returns the active model provider.
 *
 * Routing (explicit settings take priority over auto-detect):
 *  1. accessMode === 'cli' + cliTool   → cliBackendProvider(tool)
 *  2. accessMode === 'byok'            → anthropicProvider (other BYOK TBD)
 *  3. accessMode === 'pro'             → managedProvider (with fallback)
 *  4. Auto: claude available           → cliBackendProvider('claude')
 *  5. Auto: codex available            → cliBackendProvider('codex')
 *  6. Auto: BYOK Anthropic key         → anthropicProvider
 *  7. Fallback                         → mockProvider
 */
/** `t` is optional and threaded through to createOpenAICompatProvider's
 *  label/error copy only — every call site except assistantStore.tsx (the
 *  only caller with live i18n context) omits it, unchanged from before. */
export function getProvider(t?: Translate): ModelProvider {
  if (!isTauriRuntime()) {
    // Web platform: use real Anthropic API if key is available, otherwise mock
    if (hasWebAnthropicKey()) return webAnthropicProvider;
    return mockProvider;
  }

  const settings = loadAccessSettings();

  // FREE tier routing: an explicitly selected free OpenRouter model (ox
  // alpha) ALWAYS goes through the managed provider — the ai-proxy serves
  // free models to any authenticated user with no plan and zero credits.
  // Deliberately NOT wrapped in managedWithFallback: silently rerouting an
  // explicit free-model pick onto the user's other engine would misrepresent
  // which model produced the answer (honesty contract).
  if (isOpenRouterFreeModel(settings.model)) {
    return managedProvider;
  }

  // Devin model routing: a picked Devin-catalog id (e.g. 'swe-2-medium')
  // ALWAYS goes through the Devin backend — same model-driven short-circuit
  // contract as the free-OpenRouter pick above, so the picker's Devin group
  // keeps working even while accessMode still names another engine.
  if (isDevinModel(settings.model)) {
    return cliBackendProvider('devin');
  }

  if (settings.accessMode === 'cli') {
    const tool = settings.cliTool ?? 'claude';
    return cliBackendProvider(tool);
  }

  if (settings.accessMode === 'byok') {
    // Route by the selected BYOK provider: anthropic keeps the Rust bridge
    // (model_chat_stream); every OpenAI-compatible provider (deepseek,
    // openrouter, openai, xai, groq, mistral) streams directly from the
    // WebView to the provider host (CSP-scoped in tauri.conf.json).
    const def = resolveByokDef(settings.byokProvider);
    if (def && def.apiFormat === 'openai') {
      return createOpenAICompatProvider(def, t);
    }
    // google has no wire-format def yet — fall back to the Rust Anthropic
    // bridge (same behaviour as before this wave).
    return anthropicProvider;
  }

  if (settings.accessMode === 'local') {
    return localProvider;
  }

  if (settings.accessMode === 'pro') {
    if (_managedActive) {
      // Managed Pro: serve via ai-proxy, falling back gracefully if the
      // managed key isn't configured server-side (503).
      return managedWithFallback(autoDetectProvider(t));
    }
    // Pro selected but no active subscription — use the user's other backend.
    return autoDetectProvider(t);
  }

  // Auto-detect (no explicit mode set): managed subscription takes priority.
  if (_managedActive) {
    return managedWithFallback(autoDetectProvider(t));
  }

  return autoDetectProvider(t);
}

/** Resolve the best non-managed provider via auto-detection.
 *  Called only on Tauri — web callers never reach this path.
 *  Falls back to noModelProvider (never mockProvider) so desktop users see
 *  an honest "configure a model" message instead of canned demo responses. */
function autoDetectProvider(t?: Translate): ModelProvider {
  if (_claudeCodeAvailable === true) return claudeCodeProvider;
  if (isCliBackendAvailable('codex') === true) return cliBackendProvider('codex');
  if (isCliBackendAvailable('devin') === true) return cliBackendProvider('devin');
  if (hasAnthropicKey()) return anthropicProvider;
  // BYOK wave: any configured OpenAI-compatible BYOK key activates its rail.
  for (const def of BYOK_PROVIDER_DEFS) {
    if (def.apiFormat === 'openai' && hasByokKey(def.id)) {
      return createOpenAICompatProvider(def, t);
    }
  }
  if (_claudeCodeAvailable === null) return claudeCodeProvider;
  // No provider detected on desktop — surface a clear setup message.
  return noModelProvider;
}

/**
 * Wrap the managed provider with combo routing: if the managed backend fails
 * (503, 429, no_credits), transparently fall back to the user's other backend.
 * Uses withFallback for a clean multi-provider chain — combo routing
 * concept, simplified for Lazy's provider model.
 */
function managedWithFallback(fallback: ModelProvider): ModelProvider {
  const provider = withFallback({
    providers: [managedProvider, fallback],
    fallbackStatusCodes: [429, 502, 503],
    maxRetries: 3,
    yieldFallbackNotice: true,
  });
  // Override id/label to maintain backward compatibility — existing tests
  // and UI expect id 'managed' from the getProvider() path.
  return { ...provider, id: 'managed', label: managedProvider.label };
}
