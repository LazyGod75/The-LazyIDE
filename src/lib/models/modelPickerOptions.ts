/* modelPickerOptions — single source of truth for "which models can the user
   pick right now", used by every model picker (LazyManager, New Mission
   modal, assistant Composer).

   The bug this fixes: those three pickers used to each derive their option
   list from getProviderMode() — a SINGLE resolved, mutually-exclusive mode
   (accessMode, or an auto-detect priority order when accessMode is unset).
   A user can genuinely hold BOTH entitlements at once (a Claude subscription
   AND an active Lazy Pro plan), but getProviderMode() can only ever report
   one winner (e.g. accessMode === 'cli' always resolves to 'claude-code',
   even while Pro is active in the background) — so whichever picker keyed
   its option list off that single mode silently hid the other family. This
   module computes the two entitlements INDEPENDENTLY instead:
     - claudeSub — a Claude subscription is usable: the claude-code CLI is
       detected, an Anthropic BYOK key is set, or the user has explicitly
       chosen 'cli'/'byok' in Settings (trusted the same way
       getProviderMode() already trusts an explicit accessMode selection).
     - pro       — the Lazy managed (OpenRouter/ai-proxy) backend, tri-state:
       'active' (plan + credits — the managed catalog is usable), 'no-credits'
       (plan active, credits exhausted), or 'inactive' (no plan at all).

   Deliberately NOT a router: getProviderMode()/accessMode still decide which
   backend actually SERVES a request (unchanged, see index.ts). This module
   only answers "what should the picker OFFER" — a separate question from
   "what does the currently active engine happen to be".
*/

import type { ModelInfo } from './types.js';
import { isTauri as isTauriRuntime } from '../platform/index.js';
import { ALL_MODELS, DEFAULT_MODEL } from './registry.js';
import { OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL_ID } from './openrouterCatalog.js';
import { loadAccessSettings } from './accessSettings.js';
import { isCliBackendAvailable } from './cliBackendProvider.js';
import { hasAnthropicKey } from './anthropicProvider.js';
import { hasManagedCreditsActive, getProPlanState, getProviderMode } from './index.js';
import { getEngineReadiness } from './entitlement.js';
import type { EngineReadiness } from './entitlement.js';
import { BYOK_PROVIDER_DEFS, hasByokKey, resolveByokDef, byokModelInfos, effectiveByokModel } from './byokProviders.js';
import type { ByokProviderDef } from './byokProviders.js';

/** i18n translate function shape — see byokProviders.ts's Translate doc
 *  comment for why this is a local structural type rather than a shared
 *  import. Optional everywhere: omitting `t` falls back to the ORIGINAL
 *  hardcoded copy, same contract as the rest of lib/models/lib/agents. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

// ── Contract ──────────────────────────────────────────────────────

export type ModelGroupId = 'free' | 'claude-sub' | 'pro' | 'byok';

/** A single selectable model, normalized to the same shape regardless of
    which catalog (native registry.ts vs openrouterCatalog.ts) it came from. */
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  description?: string;
}

export interface ModelOptionGroup {
  id: ModelGroupId;
  /** Display label for the group header (optgroup / section), e.g.
      "Abonnement Claude" / "LazyPro / Managé". */
  label: string;
  models: ModelOption[];
}

export type ProEntitlementState = 'active' | 'no-credits' | 'inactive';

export interface ModelEntitlements {
  /** Claude subscription usable right now (native CLI or BYOK). */
  claudeSub: boolean;
  pro: ProEntitlementState;
  /** BYOK wave: the non-Anthropic BYOK provider whose key is set (prefers
   *  the explicitly SELECTED provider, else the first keyed one). Anthropic
   *  is intentionally excluded here — its native models already live in the
   *  'claude-sub' group (see detectModelEntitlements). */
  byok?: ByokProviderDef | null;
  /** True when the effective engine is the Codex CLI (getProviderMode()
   *  === 'codex') — a valid, working backend that simply has no in-app
   *  model catalog (see registry.ts's module comment: ALL_MODELS is
   *  Anthropic-only). Lets buildModelPickerOptions tell "Codex is ready but
   *  has nothing to list" apart from "nothing is configured at all", so the
   *  empty-state message stays honest instead of recommending the user
   *  configure a subscription they may already have working. */
  codexManaged: boolean;
}

export interface ModelPickerOptions {
  claudeSub: boolean;
  pro: ProEntitlementState;
  /** BYOK wave: the keyed BYOK provider (null when none). */
  byok: ByokProviderDef | null;
  /** Only the entitled groups — empty when neither entitlement is present. */
  groups: ModelOptionGroup[];
  /** True when at least one group (and therefore at least one model) is
      selectable. False is the "clear empty state" case callers must handle. */
  hasOptions: boolean;
  /** True when Pro is active but out of credits — a secondary notice worth
      surfacing even when hasOptions is true (the Claude group may still be
      usable). Reuses the existing 'pro-no-credits' i18n copy (entitlement.ts). */
  proExhausted: boolean;
  /** Set only when hasOptions is false. Reuses getEngineReadiness()'s
      existing reason codes/copy (already translated in every locale, already
      wired to the "Configurer"/"Passer Pro" actions in NewMissionModal and
      Composer) instead of inventing new empty-state copy. */
  emptyReadiness?: EngineReadiness;
  /** True when the empty state above is Codex's own honest state (ready,
   *  serving chat, simply has no in-app model catalog) rather than a real
   *  "nothing configured" gap. Set only when hasOptions is false — see
   *  MODEL_MANAGED_BY_CODEX_MESSAGE, which callers should show INSTEAD of
   *  NO_MODEL_FALLBACK_MESSAGE when this is true. */
  codexManaged: boolean;
  /** Best default model id for these entitlements, in precedence order:
      the managed catalog's default when Pro is actively usable (mirrors
      getProviderMode()'s own auto-detect priority, which favors managed);
      else the keyed BYOK provider's own default model; else the native
      default when a Claude subscription is usable; else — when NONE of the
      above is entitled — the free tier's own default id (first isFree entry
      in the OpenRouter catalog, see DEFAULT_FREE_MODEL_ID). That last branch
      is what keeps this id always a MEMBER of `groups`: the free group is
      the only one offered to a zero-entitlement user, so returning the
      native DEFAULT_MODEL.id here (the pre-free-tier behavior) handed
      callers — e.g. NewMissionModal's form seed — a model id absent from
      every rendered <option>, which then failed getEngineReadiness's CLI
      preflight even though ox alpha was fully usable. */
  defaultModelId: string;
  /** W-MODELSEL fix: the full Pro catalog to render as a visually distinct,
   *  NON-selectable group with an upsell line — populated ONLY when Pro is
   *  not active AT ALL (entitlements.pro === 'inactive', no plan). Deliberately
   *  NOT populated for 'no-credits': that user already owns Pro, so an
   *  "upgrade to Pro" pitch would be dishonest — see proExhausted instead,
   *  which covers the recharge/wait-for-refill messaging for that case.
   *  Kept separate from `groups` (rather than added to it with a `locked`
   *  flag) so every existing groups-based assertion/consumer is unaffected. */
  lockedProGroup?: ModelOptionGroup;
}

// ── Labels ────────────────────────────────────────────────────────
// 2026-08 i18n pass: buildModelPickerOptions/getModelPickerOptions now
// accept an optional `t` translator (same optional-everywhere contract as
// the rest of lib/models) and compute the group headers below via
// 'models.picker.*' locale keys when it's supplied — see buildModelPickerOptions.
// CLAUDE_SUB_LABEL/PRO_LABEL are kept as the (unchanged, still French)
// DEFAULT fallback text for callers that don't pass `t`, e.g. legacy/direct
// consumers of these constants. noModelFallbackMessage()/
// modelManagedByCodexMessage() below replace the old NO_MODEL_FALLBACK_MESSAGE
// / MODEL_MANAGED_BY_CODEX_MESSAGE constants for translated call sites; those
// two constants are kept UNCHANGED (name, type, value) because they are also
// imported by src/components/agents/NewMissionModal.tsx, which is out of
// scope for this pass (owner's uncommitted work) — see this repo's i18n
// sweep notes. Composer.tsx (the other consumer) now calls the translated
// functions instead.

export const CLAUDE_SUB_LABEL = 'Abonnement Claude';
export const PRO_LABEL = 'LazyPro / Managé';
/** Header of the always-present FREE group (GLM 5.2). No entitlement of any
    kind is required — see openrouterCatalog.ts's free tier block. */
export const FREE_GROUP_LABEL = 'Gratuit · GLM 5.2';
const byokGroupLabel = (def: ByokProviderDef) => `BYOK · ${def.label}`;

/** @deprecated kept verbatim (name/type/value) only for NewMissionModal.tsx's
 *  existing import — see the module comment above. New/translated call sites
 *  should use {@link noModelFallbackMessage} instead. */
export const NO_MODEL_FALLBACK_MESSAGE = 'Aucun modèle disponible — configure un abonnement Claude ou Lazy Pro.';

/** @deprecated kept verbatim (name/type/value) only for NewMissionModal.tsx's
 *  existing import — see the module comment above. New/translated call sites
 *  should use {@link modelManagedByCodexMessage} instead. Honest empty-state
 *  copy for a Codex-only CLI setup: Codex IS a valid, selectable chat engine
 *  (see getProviderMode()'s 'codex' branch and cliBackendProvider.ts) — it
 *  just has no in-app model catalog to list, because the Codex CLI manages
 *  its own model selection (registry.ts's ALL_MODELS is Anthropic-only, see
 *  that module's comment). Shown INSTEAD of NO_MODEL_FALLBACK_MESSAGE
 *  whenever ModelPickerOptions.codexManaged is true, so a working Codex user
 *  is never told to "configure a subscription" they already have. */
export const MODEL_MANAGED_BY_CODEX_MESSAGE =
  "Codex gère ses propres modèles — la sélection de modèle n'est pas applicable ici.";

/** Translated replacement for NO_MODEL_FALLBACK_MESSAGE — pass useI18n().t(). */
export function noModelFallbackMessage(t?: Translate): string {
  return t ? t('models.picker.noModelFallback') : NO_MODEL_FALLBACK_MESSAGE;
}

/** Translated replacement for MODEL_MANAGED_BY_CODEX_MESSAGE — pass useI18n().t(). */
export function modelManagedByCodexMessage(t?: Translate): string {
  return t ? t('models.picker.codexManaged') : MODEL_MANAGED_BY_CODEX_MESSAGE;
}

// ── Detection ─────────────────────────────────────────────────────

/**
 * Live entitlement detection. Pure aside from reading module-level caches
 * (CLI detection, BYOK localStorage, the Pro subscription bridge) — the same
 * caches every other model-routing function in this package reads, so this
 * never re-fetches or re-detects anything itself.
 */
export function detectModelEntitlements(): ModelEntitlements {
  if (!isTauriRuntime()) {
    // Browser: Claude CLI / desktop BYOK cannot run. Pretending claudeSub
    // is true (the old web fallback) listed native Sonnet in LazyManager
    // and every send failed with "Claude CLI n'est pas disponible dans le
    // navigateur" (measured 2026-08-28). Free + real Pro stay offerable —
    // the ai-proxy works in the browser.
    return {
      claudeSub: false,
      pro: hasManagedCreditsActive()
        ? 'active'
        : getProPlanState() === 'active'
          ? 'no-credits'
          : 'inactive',
      codexManaged: false,
      byok: null,
    };
  }

  const settings = loadAccessSettings();
  // BYOK wave: which non-Anthropic BYOK provider has a key? Prefer the
  // explicitly SELECTED provider (settings.byokProvider) when its key is
  // set, else the first keyed one. Anthropic is excluded: its native models
  // already live in the 'claude-sub' group, so a second group would just
  // duplicate them.
  const selected = settings.byokProvider;
  let byok: ByokProviderDef | null = null;
  if (selected && selected !== 'anthropic' && hasByokKey(selected)) {
    byok = resolveByokDef(selected) ?? null;
  }
  if (!byok) {
    for (const def of BYOK_PROVIDER_DEFS) {
      if (def.id !== 'anthropic' && hasByokKey(def.id)) {
        byok = def;
        break;
      }
    }
  }
  // Trusts an explicit accessMode selection the same way getProviderMode()
  // does (no live re-check) — EXCEPT 'cli' only counts when the configured
  // tool is actually claude: a Codex-only CLI setup is not a Claude
  // subscription and must not unlock the Claude model catalog. And BYOK
  // mode only counts when the keyed provider IS Anthropic (its native
  // models are served by the BYOK engine); with a non-Anthropic BYOK
  // provider selected, the Claude group would list models the engine can
  // never serve — the BYOK group above covers that engine instead.
  const cliTool = settings.cliTool ?? 'claude';
  const claudeSub =
    isCliBackendAvailable('claude') === true ||
    hasAnthropicKey() ||
    (settings.accessMode === 'cli' && cliTool === 'claude');

  const pro: ProEntitlementState = hasManagedCreditsActive()
    ? 'active'
    : getProPlanState() === 'active'
      ? 'no-credits'
      : 'inactive';

  // Reuses getProviderMode()'s own resolution (explicit accessMode 'cli' +
  // cliTool 'codex', or auto-detect falling through to codex) instead of
  // re-deriving the same priority order here — a second, drifting copy of
  // that routing logic is exactly the kind of incoherence this fix removes.
  const codexManaged = getProviderMode() === 'codex';

  return { claudeSub, pro, codexManaged, byok };
}

// ── Options builder ───────────────────────────────────────────────

function nativeOptions(): ModelOption[] {
  return ALL_MODELS.map((m: ModelInfo) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    description: m.description,
  }));
}

function managedOptions(): ModelOption[] {
  // Excludes isFree entries — those already live in the always-present
  // 'free' group (see freeOptions()). Without this filter, the free model
  // would render TWICE whenever Pro is also active/inactive-with-upsell:
  // once in 'free', once again here (both 'pro' and lockedProGroup draw from
  // this same function), since both groups source from OPENROUTER_MODELS.
  return OPENROUTER_MODELS.filter((m) => !m.isFree).map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    description: `${m.provider} · ${m.tier}`,
  }));
}

/** The FREE group's models — every isFree entry in the OpenRouter catalog.
    Kept separate from managedOptions() so the free rail stays visible even
    when the paid Pro catalog is locked (no plan / no credits). */
function freeOptions(): ModelOption[] {
  return OPENROUTER_MODELS.filter((m) => m.isFree).map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    description: `${m.provider} · ${m.tier} · gratuit`,
  }));
}

/** The free tier's own default model id (first isFree entry in the
    OpenRouter catalog) — used as buildModelPickerOptions's defaultModelId
    fallback for a user with NO entitlement at all (see that function).
    Derived from the catalog's isFree flag rather than hardcoded so a future
    catalog change (reordering, added/removed free entries) can't silently
    drift this out of sync with freeOptions(). Falls back to
    DEFAULT_OPENROUTER_MODEL_ID in the should-never-happen case the catalog
    ships with zero free entries, so this never resolves to undefined. */
const DEFAULT_FREE_MODEL_ID: string =
  OPENROUTER_MODELS.find((m) => m.isFree)?.id ?? DEFAULT_OPENROUTER_MODEL_ID;

/**
 * Pure builder — given an entitlements snapshot, returns everything a picker
 * needs to render. Separated from detectModelEntitlements() so tests can
 * exercise every combination (claude-only, pro-only, both, neither,
 * no-credit) without mocking CLI/localStorage/subscription internals.
 */
export function buildModelPickerOptions(entitlements: ModelEntitlements, t?: Translate): ModelPickerOptions {
  const claudeSubLabel = t ? t('models.picker.claudeSubLabel') : CLAUDE_SUB_LABEL;
  const proLabel = t ? t('models.picker.proLabel') : PRO_LABEL;
  const freeLabel = t ? t('models.picker.freeLabel') : FREE_GROUP_LABEL;
  const groups: ModelOptionGroup[] = [
    // FREE tier first — visible to EVERYONE, no entitlement check. A user
    // with nothing configured can still pick ox alpha and work immediately
    // (the ai-proxy serves free models without a subscription).
    { id: 'free' as const, label: freeLabel, models: freeOptions() },
    ...(entitlements.claudeSub
      ? [{ id: 'claude-sub' as const, label: claudeSubLabel, models: nativeOptions() }]
      : []),
    ...(entitlements.byok
      ? [{
          id: 'byok' as const,
          label: byokGroupLabel(entitlements.byok),
          models: byokModelInfos(entitlements.byok).map((m) => ({
            id: m.id,
            label: m.label,
            provider: m.provider,
            description: m.description,
          })),
        }]
      : []),
    ...(entitlements.pro === 'active'
      ? [{ id: 'pro' as const, label: proLabel, models: managedOptions() }]
      : []),
  ];

  const hasOptions = groups.length > 0;

  return {
    claudeSub: entitlements.claudeSub,
    pro: entitlements.pro,
    byok: entitlements.byok ?? null,
    groups,
    hasOptions,
    proExhausted: entitlements.pro === 'no-credits',
    // Reuses the existing (already accessMode-aware) preflight readiness —
    // e.g. a user with accessMode explicitly 'pro' and no plan gets
    // 'pro-inactive'/'pro-no-credits'; anyone else gets the generic
    // auto-detect 'cli-not-found' recommendation. No new copy required.
    emptyReadiness: hasOptions ? undefined : getEngineReadiness(),
    // Only meaningful when hasOptions is false — see codexManaged's doc
    // comment on ModelPickerOptions for why callers must check this BEFORE
    // falling back to the generic NO_MODEL_FALLBACK_MESSAGE.
    codexManaged: !hasOptions && entitlements.codexManaged,
    defaultModelId:
      entitlements.pro === 'active'
        ? DEFAULT_OPENROUTER_MODEL_ID
        : entitlements.byok
          ? effectiveByokModel(entitlements.byok)
          : entitlements.claudeSub
            ? DEFAULT_MODEL.id
            // Nothing entitled at all: the free group is the ONLY one
            // offered (see the `groups` array above), so the default must
            // come from it — see DEFAULT_FREE_MODEL_ID's doc comment for the
            // bug this replaces.
            : DEFAULT_FREE_MODEL_ID,
    lockedProGroup:
      entitlements.pro === 'inactive'
        ? { id: 'pro' as const, label: proLabel, models: managedOptions() }
        : undefined,
  };
}

/** Convenience wrapper: live-detects entitlements, then builds options. The
    one call site every real component should use — see buildModelPickerOptions
    for the pure/testable core. */
export function getModelPickerOptions(t?: Translate): ModelPickerOptions {
  return buildModelPickerOptions(detectModelEntitlements(), t);
}

/** True when `id` is in an unlocked picker group (not lockedProGroup). */
export function isSelectablePickerModel(id: string): boolean {
  const opts = getModelPickerOptions();
  return opts.groups.some((g) => g.models.some((m) => m.id === id));
}
