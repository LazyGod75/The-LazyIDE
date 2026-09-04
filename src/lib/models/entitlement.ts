/* entitlement — single source of truth for "can the selected engine run
   right now" (v0.1.5).

   Every launch surface (mission modal, assistant composer, settings model
   pickers) calls getEngineReadiness() as a synchronous preflight before
   starting work, so a Free user can never launch a mission into a void.

   Pure module: no React, no async. All runtime signals are already cached
   elsewhere and only interpreted here:
     - CLI detection      — isCliBackendAvailable() cache, filled once at
                            startup by initProviderMode() (index.ts).
     - BYOK key presence  — hasAnthropicKey() (localStorage check).
     - Pro entitlement    — isManagedActive() / getProPlanState() module
                            bridge in index.ts, pushed by the billing layer
                            (useSubscription) whenever the subscription
                            state settles (see proReadiness's cold-start
                            'unknown' handling below).
*/

import { loadAccessSettings } from './accessSettings.js';
import type { CliTool } from './accessSettings.js';
import { isCliBackendAvailable } from './cliBackendProvider.js';
import { hasAnthropicKey } from './anthropicProvider.js';
import { hasManagedCreditsActive, getProPlanState } from './index.js';
import { findModelById } from './registry.js';
import { isOpenRouterFreeModel } from './openrouterCatalog.js';
import { hasByokKey, resolveByokDef, BYOK_PROVIDER_DEFS } from './byokProviders.js';

// ── Contract ──────────────────────────────────────────────────────

export type EngineReadinessReason =
  | 'cli-not-found'
  | 'byok-no-key'
  | 'pro-inactive'
  | 'pro-no-credits';

export type EngineReadiness = {
  mode: 'cli' | 'byok' | 'pro' | 'local';
  ready: boolean;
  reason?: EngineReadinessReason;
};

/** i18n key for a not-ready reason — shared by every preflight surface so
    the copy lives in exactly one locale key per reason. */
export function engineReasonKey(reason: EngineReadinessReason): string {
  return `engine.reason.${reason}`;
}

// ── Readiness check ───────────────────────────────────────────────

/**
 * Synchronous readiness of the engine the user selected (or the best
 * auto-detected one when no explicit mode is set). Uses only cached
 * detection — safe to call on every submit/render.
 *
 * @param forMode Evaluate a SPECIFIC engine instead of the selected one —
 *                e.g. the Settings managed catalog asks for 'pro' even while
 *                the user is on cli/byok (W2.8 locked-catalog rendering).
 * @param modelId BUG-4: the concrete model id chosen for THIS launch (e.g. a
 *                canvas draft's model or the mission modal's form.modelId).
 *                Only consulted when forMode is not set — a caller pinning a
 *                specific mode always wins. Only a real native id found in
 *                the ALL_MODELS catalog (findModelById) short-circuits to
 *                'cli' ready; a bare tier word ('sonnet') or an OpenRouter
 *                id never matches, so it falls through to the global-mode
 *                switch below unchanged. This is what stops the mission
 *                preflight/launch gate from mis-reading the GLOBAL access
 *                mode (e.g. 'pro' with an empty wallet) when the user
 *                explicitly picked a CLI-backed native model for this run.
 */
export function getEngineReadiness(
  forMode?: EngineReadiness['mode'],
  modelId?: string,
): EngineReadiness {
  const settings = loadAccessSettings();
  if (!forMode && modelId && findModelById(modelId)) {
    return cliReadiness(settings.cliTool ?? 'claude');
  }
  // FREE tier short-circuit — an explicitly chosen free OpenRouter model
  // (e.g. ox alpha) needs no plan and no credits: the ai-proxy serves it at
  // zero charge. It still requires a Lazy session JWT (ai-proxy getUser) —
  // that gate lives in managerSessionGate.ts, not here. Must sit BEFORE the
  // global-mode switch below so a user whose access mode is unset/'pro' with
  // an inactive plan still passes the launch preflight on the free model.
  if (!forMode && modelId && isOpenRouterFreeModel(modelId)) {
    return { mode: 'pro', ready: true };
  }
  switch (forMode ?? settings.accessMode) {
    case 'cli':
      return cliReadiness(settings.cliTool ?? 'claude');
    case 'byok':
      return byokReadiness();
    case 'pro':
      return proReadiness();
    case 'local':
      return localReadiness();
    default:
      return autoReadiness();
  }
}

function cliReadiness(tool: CliTool): EngineReadiness {
  const available = isCliBackendAvailable(tool);
  // null = startup detection not finished yet — stay optimistic (mirrors
  // getProviderMode's benefit-of-the-doubt) so the first seconds of the app
  // never flash a false "CLI not found". A real launch failure is surfaced
  // loudly by the mission pipeline (statusReason).
  if (available === false) {
    return { mode: 'cli', ready: false, reason: 'cli-not-found' };
  }
  return { mode: 'cli', ready: true };
}

function byokReadiness(): EngineReadiness {
  // BYOK wave: readiness follows the SELECTED provider's key — DeepSeek,
  // OpenRouter, xAI, Groq, Mistral, OpenAI each have their own localStorage
  // slot (lazy.apikey.<provider>). Anthropic kept for backward compat (and
  // because its key slot predates the generic registry).
  const def = resolveByokDef(loadAccessSettings().byokProvider);
  const keyed = def ? hasByokKey(def.id) : hasAnthropicKey();
  if (keyed) return { mode: 'byok', ready: true };
  return { mode: 'byok', ready: false, reason: 'byok-no-key' };
}

function proReadiness(): EngineReadiness {
  // hasManagedCreditsActive = plan active AND credits remaining (raw bridge,
  // mode-independent so the Pro engine can be evaluated from any mode).
  if (hasManagedCreditsActive()) return { mode: 'pro', ready: true };

  const planState = getProPlanState();
  // 'unknown' = useSubscription's first fetch hasn't settled yet — stay
  // optimistic (mirrors cliReadiness's null-detection window) so a real Pro
  // user never sees a false "pro-inactive" flash before the fetch resolves.
  // A real launch failure is still surfaced loudly by the mission pipeline.
  if (planState === 'unknown') return { mode: 'pro', ready: true };
  // Settled: distinguishes the two not-ready shapes — plan active with 0
  // credits vs no active plan at all.
  if (planState === 'active') return { mode: 'pro', ready: false, reason: 'pro-no-credits' };
  return { mode: 'pro', ready: false, reason: 'pro-inactive' };
}

/** No explicit mode chosen — resolve to the effective engine using the same
    priority order as getProviderMode()/autoDetectProvider(). In auto mode the
    managed route is only taken when credits exist, which is exactly the raw
    bridge value (accessMode is null here, so the mode filter is a no-op). */
function localReadiness(): EngineReadiness {
  // No synchronous detection available — isLocalAvailable() is async (HTTP ping).
  // Stay optimistic like cliReadiness's null-detection window; a real launch
  // failure is surfaced loudly by the mission pipeline.
  return { mode: 'local', ready: true };
}

function autoReadiness(): EngineReadiness {
  if (hasManagedCreditsActive()) return { mode: 'pro', ready: true };
  if (isCliBackendAvailable('claude') === true) return { mode: 'cli', ready: true };
  if (isCliBackendAvailable('codex') === true) return { mode: 'cli', ready: true };
  if (hasAnthropicKey()) return { mode: 'byok', ready: true };
  // BYOK wave: any configured non-Anthropic BYOK key (DeepSeek, OpenRouter,
  // ...) makes the byok engine usable in auto mode too.
  const settings = loadAccessSettings();
  const selectedDef = resolveByokDef(settings.byokProvider);
  if ((selectedDef && hasByokKey(selectedDef.id)) || (settings.byokProvider === 'anthropic' && hasAnthropicKey())) {
    return { mode: 'byok', ready: true };
  }
  if (isCliBackendAvailable('claude') === null) {
    // Startup window: detection still running — optimistic, see cliReadiness.
    return { mode: 'cli', ready: true };
  }
  // Nothing usable anywhere — recommend the default (CLI) path.
  return { mode: 'cli', ready: false, reason: 'cli-not-found' };
}

/** True when AT LEAST ONE engine can run right now — Claude CLI detected,
 *  Codex CLI detected, any BYOK key set (Anthropic or the new providers),
 *  or Pro with credits. The cockpit's not-ready banner must hide whenever
 *  this is true: nagging a user who holds several working engines (e.g.
 *  Claude CLI + DeepSeek BYOK) about a broken one makes no sense — the
 *  mission pipeline already falls back to a working engine at launch. */
export function isAnyEngineUsable(): boolean {
  if (hasManagedCreditsActive()) return true;
  if (isCliBackendAvailable('claude') === true) return true;
  if (isCliBackendAvailable('codex') === true) return true;
  if (hasAnthropicKey()) return true;
  for (const def of BYOK_PROVIDER_DEFS) {
    if (def.id !== 'anthropic' && hasByokKey(def.id)) return true;
  }
  return false;
}
