/* managerModelResolve — exact catalog id + tier hint → rail-valid model id.

   Measured 2026-08-28: resolveManagerModelId cyclomatic complexity was 42
   (ESLint ratchet ceiling 12). Lives here so managerEngine.ts stays the
   LLM turn loop, not a rail catalog matcher.
*/

import { getDefaultModelIdForMode, loadAccessSettings } from '../models/index.js';
import type { ProviderMode } from '../models/index.js';
import {
  resolveByokDef,
  byokModelInfos,
  effectiveByokModel,
  BYOK_PROVIDER_DEFS,
  hasByokKey,
} from '../models/byokProviders.js';
import { isManagedModelReady, isNativeModelReady } from './runtime.js';
import { ALL_MODELS } from '../models/registry.js';
import { OPENROUTER_MODELS, findOpenRouterModel, isOpenRouterFreeModel } from '../models/openrouterCatalog.js';
import { isDevinModel, devinModelInfos } from '../models/devinCatalog.js';
import { isCliBackendAvailable } from '../models/cliBackendProvider.js';
import type { ManagerEngineChoice } from './types.js';

const TIER_WORD = /haiku|sonnet|opus/;

/**
 * Thrown by resolveManagerModelId when an action names an exact `modelId`
 * (ManagerModelId, types.ts) that does not exist in the catalog for the rail
 * actually in effect this turn — NEVER caught here and silently swapped for
 * a default (NEVER DEGRADE IN SILENCE). Left to propagate out of
 * executeManagerAction: the per-action try/catch in sendManagerMessage
 * (agentsStore.tsx) already turns any thrown Error into an honest, visible
 * `agents.manager.actionFailed` message carrying `.message` — the same idiom
 * every other honest-failure case in that executor already uses (e.g.
 * delete_mission's "mission not found" throw) — so no new error-handling
 * plumbing is needed at the call sites.
 *
 * `hint` (tolerant-normalization wave, 2026-08-05): an optional extra
 * sentence appended after the base per-rail message — used ONLY when the id
 * could not be silently normalized (see resolveBareRailModelId /
 * findOpenRouterAliasHint / findByokHomeHint below) but a plausible OTHER
 * home for it was found anyway, so the rejection stays actionable instead of
 * a dead end. Omitted (the default) keeps the base message byte-identical to
 * before this wave — a genuinely unknown id is rejected UNCHANGED.
 */
export class UnknownManagerModelIdError extends Error {
  /** The exact id the action requested that was not found in the effective rail's catalog. */
  readonly modelId: string;
  /** Which rail's catalog was actually checked against. */
  readonly rail: 'cli' | 'pro' | 'byok';

  constructor(modelId: string, rail: 'cli' | 'pro' | 'byok', hint?: string) {
    const base =
      rail === 'cli'
        ? `Model id "${modelId}" is not available on the Claude CLI/BYOK rail — that rail only understands native Anthropic ids (registry.ts's ALL_MODELS), never an OpenRouter-style id. Pick an id from ALL_MODELS, switch this action's "engine" to "pro", or use a tier hint instead.`
        : rail === 'byok'
          ? `Model id "${modelId}" is not available on the selected BYOK rail — that rail only understands ids from its own provider catalog (byokProviders.ts). Pick an id from the provider's model list, or use a tier hint instead.`
          : `Model id "${modelId}" is not in the OpenRouter catalog the Lazy Pro rail accepts (openrouterCatalog.ts's OPENROUTER_MODELS). Pick a real catalog id, or use a tier hint instead.`;
    super(hint ? `${base} ${hint}` : base);
    this.name = 'UnknownManagerModelIdError';
    this.modelId = modelId;
    this.rail = rail;
  }
}

// ── Tolerant modelId normalization (2026-08-05 night-bug fix) ──────────
//
// Real prod incident: the manager routinely names a launch_mission/
// create_loop step's model using an OpenRouter-STYLE id
// ("anthropic/claude-sonnet-5", "deepseek/deepseek-chat") even when the
// EFFECTIVE rail this turn is a bare-id one (native CLI, or a BYOK
// provider's own catalog) — resolveManagerModelId's exact-match-only lookup
// (`ALL_MODELS.some(...)`, `catalog.some(...)`) rejected every one of these
// outright via UnknownManagerModelIdError, and because modelId is checked
// BEFORE the tier-hint fallback, there was no recovery: the action just
// failed. Since the SAME default-model resolution path is shared by actions
// that never even named a specific model, one malformed default was enough
// to take down unrelated launches too — for one night, NO mission launch
// got through. Fixed with a strictly-scoped tolerant lookup: an id is only
// ever silently accepted when it is TRIVIALLY safe to do so (same rail, same
// model, cosmetic prefix only) — anything more speculative (a different
// vendor claimed, or the model living on an entirely different rail) is
// still a hard rejection, just a more actionable one.

/**
 * Curated native/BYOK-id -> OpenRouter-id aliases for the rare case where
 * the two catalogs spell the SAME underlying model differently (as opposed
 * to the common case — a bare id plus a "vendor/" prefix — which is a plain
 * strip-and-retry, no table needed; see resolveBareRailModelId). Sourced
 * directly from byokProviders.ts's own DeepSeek labels ("DeepSeek Chat (V4
 * Flash)", "DeepSeek Reasoner (R1)"), which already document this exact
 * pairing. Deliberately short and hand-curated — extend from real QA
 * verbatims, never widen into fuzzy/substring matching (same policy as
 * ANNOUNCEMENT_MARKERS further down this file).
 */
const NATIVE_TO_OPENROUTER_ALIAS: ReadonlyMap<string, string> = new Map([
  ['deepseek-chat', 'deepseek/deepseek-v4-flash'],
  // 'deepseek-reasoner' has no managed counterpart since R1 left the curated
  // catalog. Aliasing it to V4 Pro would silently run a DIFFERENT model, which
  // is exactly what this table must never do — so it stays out and the lookup
  // rejects with an actionable error instead.
]);

/** Case/hyphen/dot-insensitive comparison key for a vendor token — lets
 *  "x-ai" and "xAI"-derived tokens compare equal without a hand-maintained
 *  synonym table. Used only to decide whether a supplied "vendor/" prefix
 *  plausibly agrees with a rail's own provider, never to look anything up
 *  by itself. */
function normalizeVendorToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Discriminated result of resolveBareRailModelId. `ok: true` carries the
 *  RESOLVED catalog id (which may differ from what was requested, once
 *  normalized). `ok: false` optionally carries a `hint` for
 *  UnknownManagerModelIdError's message — undefined means "genuinely
 *  unknown, keep the rejection unchanged" (see the call sites below). */
export type BareRailLookup =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly hint?: string };

/**
 * Tolerant lookup for a BARE-id rail — the native CLI/Anthropic catalog, or
 * one BYOK provider's own catalog (both index by an unprefixed id, e.g.
 * 'claude-sonnet-5' / 'deepseek-chat', unlike the Pro rail's OpenRouter
 * catalog, whose ids already carry their vendor prefix). Two tries:
 *
 *  1. Exact match against `catalogIds` — today's behavior, unchanged.
 *  2. Vendor-prefix strip: when `requestedId` looks like "vendor/rest" AND
 *     "rest" is an exact catalog match, accept it ONLY when `vendor`
 *     (compared via normalizeVendorToken) agrees with `ownVendorToken` —
 *     e.g. "anthropic/claude-sonnet-5" on the native rail (ownVendorToken
 *     'anthropic') strips and matches safely: a trivial, cosmetic rename of
 *     a real model. A DISAGREEING vendor ("openai/claude-sonnet-5" on that
 *     same rail) is a red flag, not a typo — the bare id is real, but
 *     something asserted the wrong maker for it, which is far more likely
 *     to be the model confusing itself than an innocent slip. That case
 *     returns `ok: false` with an explanatory `hint` instead of guessing —
 *     an ambiguous collision is a rejection, never a silent pick.
 *
 * Pure — takes the rail's own catalog ids and vendor token as plain
 * arguments instead of reaching into ALL_MODELS/byokModelInfos itself, so
 * the same function serves both bare-id rails. Exported for direct unit
 * testing.
 */
export function resolveBareRailModelId(
  requestedId: string,
  catalogIds: readonly string[],
  ownVendorToken: string,
): BareRailLookup {
  if (catalogIds.includes(requestedId)) return { ok: true, id: requestedId };

  const slash = requestedId.indexOf('/');
  if (slash === -1) return { ok: false };

  const vendor = requestedId.slice(0, slash);
  const stripped = requestedId.slice(slash + 1);
  if (!catalogIds.includes(stripped)) return { ok: false };

  if (normalizeVendorToken(vendor) === normalizeVendorToken(ownVendorToken)) {
    return { ok: true, id: stripped };
  }
  return {
    ok: false,
    hint: `"${requestedId}" strips to a real id on this rail ("${stripped}"), but its "${vendor}/" prefix does not match this rail's own provider ("${ownVendorToken}") — drop the prefix if you meant "${stripped}", otherwise double-check which model you meant.`,
  };
}

/**
 * Cross-rail alias hint for the Pro (OpenRouter) branch — real incident
 * example: the manager asked for "deepseek/deepseek-chat" on the Pro rail,
 * an id that exists NOWHERE in OPENROUTER_MODELS verbatim (its DeepSeek ids
 * are "deepseek/deepseek-v4-flash" etc. — "deepseek-chat" is the
 * DeepSeek-native/BYOK id, see byokProviders.ts). Strips a vendor prefix (if
 * any) and checks NATIVE_TO_OPENROUTER_ALIAS for the resulting bare id;
 * returns a ready-to-use suggestion when a curated equivalent exists on THIS
 * rail, or undefined when it doesn't (the caller then tries
 * findByokHomeHint, and finally falls back to the unchanged rejection — see
 * resolveManagerModelId's Pro branch). Exported for direct unit testing.
 */
export function findOpenRouterAliasHint(requestedId: string): string | undefined {
  const slash = requestedId.indexOf('/');
  const bare = slash === -1 ? requestedId : requestedId.slice(slash + 1);
  const equivalent = NATIVE_TO_OPENROUTER_ALIAS.get(bare);
  if (!equivalent || !findOpenRouterModel(equivalent)) return undefined;
  return `The closest match on this rail is "${equivalent}" — pick that id, or use a tier hint instead.`;
}

/**
 * "It already exists on your own BYOK rail" hint — checked by BOTH the Pro
 * branch (only once findOpenRouterAliasHint finds nothing, mirroring the
 * task's own "if an OpenRouter equivalent exists, suggest it — ELSE IF the
 * BYOK rail has it, say so" fallback order) and the CLI branch (a bare id
 * that isn't a real Anthropic id might still be real on some OTHER BYOK
 * provider's catalog). Strips a vendor prefix (if any) and scans every BYOK
 * provider's own catalog for an exact bare-id match. Static-catalog lookup
 * only (no key/localStorage read) — it never claims a BYOK rail is actually
 * USABLE right now (key configured, provider selected), only that the id is
 * a real one, somewhere; the message is worded accordingly. Exported for
 * direct unit testing.
 */
export function findByokHomeHint(requestedId: string): string | undefined {
  const slash = requestedId.indexOf('/');
  const bare = slash === -1 ? requestedId : requestedId.slice(slash + 1);
  const def = BYOK_PROVIDER_DEFS.find((d) => d.models.some((m) => m.id === bare));
  if (!def) return undefined;
  return `"${bare}" already exists on your ${def.label} BYOK rail — activate ${def.label} under Settings > Models to use it there, or pick a real id from this rail's own catalog.`;
}

/** Tagged, developer-only trace for a successful tolerant normalization
 *  (resolveBareRailModelId's vendor-prefix-strip branch) — a greppable
 *  prefix so this specific fix's activity is easy to spot in the console
 *  during QA. Purely observability: the resolved id itself already flows
 *  through as the function's normal return value, this never gates
 *  behavior. Called exactly once per accepted normalization, never for a
 *  plain exact match (which was already silent before this wave). */
function warnModelIdNormalized(requestedId: string, resolvedId: string, rail: 'cli' | 'byok'): void {
  console.warn(`[manager-model-id-normalize] "${requestedId}" -> "${resolvedId}" accepted on the ${rail} rail`);
}

// ── Inferred model rail (2026-08-05 night 2) ────────────────────────────
//
// Real prod incident: the manager keeps naming a model/engine combination
// that is simply on the WRONG rail — "deepseek/deepseek-chat" while engine
// is "pro" (that id lives on the DeepSeek BYOK catalog, not OpenRouter's),
// "claude-sonnet-5" while engine is a non-Anthropic BYOK provider, and so
// on. Until now every one of these was a hard rejection (see
// UnknownManagerModelIdError above) even though the id is REAL — it just
// exists on a DIFFERENT rail than the one requested this turn. When that
// other rail is the user's ONLY plausible other home for the id (exactly
// one match, not two or more), rejecting is strictly worse than just
// running it there: the fix below silently switches the EFFECTIVE rail
// instead. This is safe specifically because dispatch never re-reads
// resolveManagerModelId's `mode`/`engineOverride` inputs afterwards — the
// mission is routed downstream purely from the RETURNED id's own shape
// (classifyMissionModel, runtime.ts: a '/' means managed/pro, a bare id on a
// configured non-Anthropic BYOK catalog means byok, everything else means
// native) — so returning the OTHER rail's id here is already the complete
// switch; there is no separate "engine" flag anywhere downstream left
// pointing at the old, wrong rail. Ambiguity (2+ rails carry the id) or a
// genuinely unknown id (0 rails) both keep today's honest rejection, now
// optionally enriched with a hint naming what WAS found.

/** One rail where `requestedId` was found to unambiguously exist, other than
 *  the rail actually requested this turn — see findAlternateRailMatches.
 *  `id` is already in the shape that rail's own dispatch expects (bare for
 *  'cli'/'byok', vendor-prefixed for 'pro') so the caller can return it
 *  directly. `label` is a human-readable rail tag for logging/hints — 'cli',
 *  'pro', or 'byok:<provider id>' (e.g. 'byok:deepseek'). */
interface AlternateRailMatch {
  readonly rail: 'cli' | 'pro' | 'byok';
  readonly id: string;
  readonly label: string;
}

/**
 * Cross-rail candidate search: scans every rail OTHER than `requestedRail`
 * for an exact, real home for `requestedId` (already established NOT to
 * belong to `requestedRail` itself by the time this is called).
 *
 *  - 'cli' (native/ALL_MODELS, bare ids) — vendor-tolerant, reusing the same
 *    resolveBareRailModelId helper the same-rail cosmetic case above uses (a
 *    matching or absent vendor prefix strips cleanly; a DISAGREEING vendor
 *    prefix is never treated as a match here either — see that function's
 *    own doc comment).
 *  - 'pro' (OPENROUTER_MODELS, vendor-prefixed ids) — exact match on the id
 *    AS GIVEN; a bare id can never match here by construction, mirroring the
 *    rail's own real shape (openrouterCatalog.ts).
 *  - 'byok' — one candidate per CONFIGURED provider (hasByokKey: an
 *    unconfigured provider is not a rail the user can actually use right
 *    now, so it is never offered as a silent switch target), excluding
 *    `requestedByokProvider` (the provider already checked and already
 *    failed, when the requested rail was itself byok) and always excluding
 *    'anthropic' — mirroring classifyMissionModel's (runtime.ts) own
 *    exclusion of that def from BYOK routing: a native Claude id always
 *    means the 'cli' rail, never a same-vendor BYOK "duplicate", so this
 *    never manufactures a false cli/byok ambiguity for a plain Claude id.
 *    'openrouter' is checked like the Pro rail (exact, unstripped id) since
 *    its own catalog already carries vendor prefixes (see
 *    toNativeByokModelId's own def.id === 'openrouter' special case,
 *    byokProviders.ts); every other BYOK provider is checked bare and
 *    vendor-tolerant, like the CLI rail.
 *
 * Pure aside from the per-provider key-presence check (hasByokKey), which is
 * what "configured" means here — this never re-validates CLI-install or
 * Pro-plan readiness (that stays classifyMissionModel/isManagedModelReady/
 * isNativeModelReady's job downstream, same division of labor as
 * resolveManagerModelId's own engineOverride paragraph above). Exported for
 * direct unit testing.
 */
/** BYOK-provider loop of findAlternateRailMatches, extracted to keep that
 *  dispatcher under the complexity ratchet: checks each KEYED provider's
 *  catalog (skipping the rail the request already lives on and the
 *  anthropic pseudo-provider, which resolves through the cli check above). */
function byokAlternateRailMatches(
  requestedId: string,
  requestedByokProvider: string | undefined,
): AlternateRailMatch[] {
  const matches: AlternateRailMatch[] = [];
  for (const def of BYOK_PROVIDER_DEFS) {
    if (def.id === 'anthropic' || def.id === requestedByokProvider || !hasByokKey(def.id)) continue;
    const catalogIds = byokModelInfos(def).map((m) => m.id);
    if (def.id === 'openrouter') {
      if (catalogIds.includes(requestedId)) matches.push({ rail: 'byok', id: requestedId, label: `byok:${def.id}` });
      continue;
    }
    const lookup = resolveBareRailModelId(requestedId, catalogIds, def.id);
    if (lookup.ok) matches.push({ rail: 'byok', id: lookup.id, label: `byok:${def.id}` });
  }
  return matches;
}

export function findAlternateRailMatches(
  requestedId: string,
  requestedRail: 'cli' | 'pro' | 'byok',
  requestedByokProvider?: string,
): AlternateRailMatch[] {
  const matches: AlternateRailMatch[] = [];

  if (requestedRail !== 'cli') {
    const lookup = resolveBareRailModelId(requestedId, ALL_MODELS.map((m) => m.id), 'anthropic');
    if (lookup.ok) matches.push({ rail: 'cli', id: lookup.id, label: 'cli' });
  }

  if (requestedRail !== 'pro' && findOpenRouterModel(requestedId)) {
    matches.push({ rail: 'pro', id: requestedId, label: 'pro' });
  }

  matches.push(...byokAlternateRailMatches(requestedId, requestedByokProvider));

  // Devin ids (swe-2-medium, ...) live on the cli family but a distinct
  // sub-rail — offered as a switch target only when the devin CLI is
  // actually detected, same "only plausible homes" contract as the keyed
  // BYOK check above.
  if (requestedRail !== 'cli' && isDevinModel(requestedId) && isCliBackendAvailable('devin') === true) {
    matches.push({ rail: 'cli', id: requestedId, label: 'cli:devin' });
  }

  return matches;
}

/** Tagged, developer-only trace for a successful CROSS-RAIL switch — a
 *  distinct tag from warnModelIdNormalized's '[manager-model-id-normalize]'
 *  (a same-rail cosmetic fix) since this is a materially bigger change: the
 *  ENGINE actually dispatching the mission changes, not just the id's
 *  spelling. Called exactly once per accepted switch. */
function warnModelRailSwitched(requestedId: string, requestedRail: string, match: AlternateRailMatch): void {
  console.warn(
    `[manager-model-rail-switch] "${requestedId}" not available on the ${requestedRail} rail — silently switched to the ${match.label} rail as "${match.id}" (unambiguous match)`,
  );
}

/** Discriminated outcome of the inferred-rail-switch decision — mirrors
 *  BareRailLookup's shape/spirit but adds the 'ambiguous' case (2+ rails),
 *  which a plain ok/hint pair cannot distinguish from "no match at all". */
type RailSwitchOutcome =
  | { readonly kind: 'switched'; readonly id: string }
  | { readonly kind: 'ambiguous'; readonly hint: string }
  | { readonly kind: 'none' };

/**
 * Applies the "exactly one other rail" rule to findAlternateRailMatches'
 * result: a single match silently switches (tagged console.warn, returns
 * that rail's id); zero or 2+ matches leave the decision to the caller's
 * EXISTING rejection path, optionally enriched with an ambiguity hint here.
 * Centralizes the "exactly one" rule and the warn call so the three call
 * sites in resolveManagerModelId (pro/byok/cli) below stay identical.
 */
function tryInferredRailSwitch(
  requestedId: string,
  requestedRail: 'cli' | 'pro' | 'byok',
  requestedByokProvider: string | undefined,
): RailSwitchOutcome {
  const matches = findAlternateRailMatches(requestedId, requestedRail, requestedByokProvider);
  if (matches.length === 1) {
    warnModelRailSwitched(requestedId, requestedRail, matches[0]);
    return { kind: 'switched', id: matches[0].id };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      hint: `"${requestedId}" exists on ${matches.length} different rails (${matches.map((m) => m.label).join(', ')}) — ambiguous, so name the one you mean explicitly (the action's "engine" field, or a rail-specific id) instead of leaving it to guesswork.`,
    };
  }
  return { kind: 'none' };
}

/** Concrete native ProviderMode for a deliberate "cli" engine choice —
 *  respects the user's configured CLI tool (Settings > Models) the same way
 *  getProviderMode()'s own 'cli' branch and entitlement.ts's cliReadiness()
 *  default do, rather than assuming claude-code is always the one actually
 *  installed. Shared by resolveManagerModelId's engineOverride branch and
 *  runManagerTurn's own (STACK fix). */
export function nativeEngineMode(): ProviderMode {
  const tool = loadAccessSettings().cliTool;
  if (tool === 'codex') return 'codex';
  if (tool === 'devin') return 'devin';
  return 'claude-code';
}

/** BUG-2: empty Pro wallet + native CLI ready → native pool, unless this
 *  is an explicit free-model (ox alpha) request — those stay on ai-proxy.
 *  BYOK: engine "cli" without a modelId must NOT yank a live-key rail. */
function pickEffectiveManagerMode(
  mode: ProviderMode,
  engineOverride: ManagerEngineChoice | undefined,
  modelId: string | undefined,
): ProviderMode {
  const managedRequested = mode === 'managed' || mode === 'pro';
  const fallbackToNative =
    !engineOverride &&
    managedRequested &&
    !isManagedModelReady() &&
    !isOpenRouterFreeModel(modelId) &&
    isNativeModelReady();
  if (engineOverride === 'cli' && !(mode === 'live-key' && modelId === undefined)) {
    return nativeEngineMode();
  }
  if (engineOverride === 'pro') return 'managed';
  if (fallbackToNative) return nativeEngineMode();
  return mode;
}

function byokDefaultForMode(effectiveMode: ProviderMode): string | null {
  if (effectiveMode !== 'live-key') return null;
  const def = resolveByokDef(loadAccessSettings().byokProvider);
  return def ? effectiveByokModel(def) : null;
}

function resolveExactOnManagedRail(modelId: string): string {
  if (findOpenRouterModel(modelId)) return modelId;
  const switched = tryInferredRailSwitch(modelId, 'pro', undefined);
  if (switched.kind === 'switched') return switched.id;
  const hint =
    switched.kind === 'ambiguous' ? switched.hint : (findOpenRouterAliasHint(modelId) ?? findByokHomeHint(modelId));
  throw new UnknownManagerModelIdError(modelId, 'pro', hint);
}

function resolveExactOnByokRail(modelId: string): string {
  const def = resolveByokDef(loadAccessSettings().byokProvider);
  const catalog = def ? byokModelInfos(def) : [];
  if (catalog.some((m) => m.id === modelId)) return modelId;
  const lookup = def ? resolveBareRailModelId(modelId, catalog.map((m) => m.id), def.id) : undefined;
  if (lookup?.ok) {
    warnModelIdNormalized(modelId, lookup.id, 'byok');
    return lookup.id;
  }
  const switched = tryInferredRailSwitch(modelId, 'byok', def?.id);
  if (switched.kind === 'switched') return switched.id;
  const hint = switched.kind === 'ambiguous' ? switched.hint : lookup?.ok === false ? lookup.hint : undefined;
  throw new UnknownManagerModelIdError(modelId, 'byok', hint);
}

function resolveExactOnCliRail(modelId: string): string {
  if (ALL_MODELS.some((m) => m.id === modelId)) return modelId;
  // Devin-catalog ids belong to the CLI rail family (devin is a cliTool):
  // accepting them here lets classifyMissionModel route the mission to the
  // devin branch downstream — the id itself carries the engine switch.
  if (isDevinModel(modelId)) return modelId;
  const lookup = resolveBareRailModelId(modelId, ALL_MODELS.map((m) => m.id), 'anthropic');
  if (lookup.ok) {
    warnModelIdNormalized(modelId, lookup.id, 'cli');
    return lookup.id;
  }
  const switched = tryInferredRailSwitch(modelId, 'cli', undefined);
  if (switched.kind === 'switched') return switched.id;
  const hint = switched.kind === 'ambiguous' ? switched.hint : lookup.hint;
  throw new UnknownManagerModelIdError(modelId, 'cli', hint);
}

function resolveExactManagerModelId(modelId: string, effectiveMode: ProviderMode): string {
  if (effectiveMode === 'managed' || effectiveMode === 'pro') return resolveExactOnManagedRail(modelId);
  if (effectiveMode === 'live-key') return resolveExactOnByokRail(modelId);
  return resolveExactOnCliRail(modelId);
}

function tierPoolForMode(effectiveMode: ProviderMode): readonly { id: string }[] {
  if (effectiveMode === 'managed' || effectiveMode === 'pro') return OPENROUTER_MODELS;
  // Devin's own catalog holds its tier words (medium/high/max + the
  // account's claude/gpt/... variants) — resolve against it so a hint
  // lands on an id --model actually accepts.
  if (effectiveMode === 'devin') return devinModelInfos();
  if (effectiveMode !== 'live-key') return ALL_MODELS;
  const def = resolveByokDef(loadAccessSettings().byokProvider);
  return def ? byokModelInfos(def) : ALL_MODELS;
}

function resolveTierOrDefault(
  word: string | undefined,
  effectiveMode: ProviderMode,
  byokDefault: string | null,
): string {
  if (!word) return byokDefault ?? getDefaultModelIdForMode(effectiveMode);
  const matched = tierPoolForMode(effectiveMode).find((m) => m.id.toLowerCase().includes(word));
  if (matched) return matched.id;
  if (byokDefault) return byokDefault;
  return getDefaultModelIdForMode(effectiveMode);
}

/**
 * Resolve a launch_mission/create_loop/create_draft/spawn_submissions/
 * generate_plan-step model request to a model id valid for the CURRENT
 * provider mode. Falls back to the mode's default model
 * (getDefaultModelIdForMode) when neither `modelId` nor `tier` is given, or
 * `tier` doesn't match any catalog entry.
 *
 * @param engineOverride STACK fix (a user can hold both a Claude CLI
 *   subscription and an active Lazy Pro plan at once — see
 *   modelPickerOptions.ts's module doc comment): a deliberate per-mission
 *   "cli"/"pro" choice (the action's own `engine` field) always wins over
 *   both the ambient `mode` and the automatic BUG-2 rescue below — this is
 *   what makes the function bidirectional (managed mode can still target the
 *   native pool deliberately, AND a native mode can target the managed pool
 *   deliberately), not just a one-directional managed->native rescue.
 *   Readiness for the deliberately chosen family is NOT re-checked here:
 *   classifyMissionModel + isManagedModelReady/isNativeModelReady already
 *   gate the actual mission dispatch downstream (runtime.ts's planAndAct)
 *   and report an honest mismatch if the chosen engine turns out not to be
 *   ready — resolving an id here always succeeds. Omitted (the default)
 *   keeps today's mode-based behavior, including the BUG-2 rescue.
 * @param modelId Exact catalog id (ManagerModelId, types.ts) — checked
 *   BEFORE `tier` and validated against the CURRENT effective rail's real
 *   catalog (ALL_MODELS on the native/CLI rail, OPENROUTER_MODELS on the
 *   managed/Pro rail). Throws UnknownManagerModelIdError, never silently
 *   substitutes a DEFAULT, when the id does not belong to that rail's
 *   family — the two id spaces stay deliberately incompatible in what gets
 *   STORED/dispatched (see openrouterCatalog.ts's module comment). Tolerant
 *   normalization wave (2026-08-05): a COSMETIC mismatch — an OpenRouter-
 *   style "vendor/rest" id whose "rest" is a real id on THIS rail, vendor
 *   agreeing — is silently rewritten to the rail's own bare id instead of
 *   rejected (see resolveBareRailModelId); a genuine cross-rail id, or a
 *   disagreeing vendor prefix, is still an honest rejection, just enriched
 *   with a hint when one is available (findOpenRouterAliasHint /
 *   findByokHomeHint). Inferred-rail-switch wave (2026-08-05 night 2): when
 *   the id is not on the requested rail at all (even after the cosmetic
 *   normalization above) but is real on EXACTLY ONE other rail the user can
 *   plausibly run on right now (a configured BYOK provider, the CLI rail, or
 *   the Pro rail), the EFFECTIVE rail is silently switched to that one
 *   instead of rejecting — see tryInferredRailSwitch/findAlternateRailMatches
 *   above. Two or more candidate rails, or none at all, still fall through
 *   to the honest rejection. Absent (the default) keeps today's tier-only
 *   behavior unchanged.
 */
export function resolveManagerModelId(
  tier: string | undefined,
  mode: ProviderMode,
  engineOverride?: ManagerEngineChoice,
  modelId?: string,
): string {
  const word = tier?.toLowerCase().match(TIER_WORD)?.[0];
  const effectiveMode = pickEffectiveManagerMode(mode, engineOverride, modelId);
  if (modelId) return resolveExactManagerModelId(modelId, effectiveMode);
  return resolveTierOrDefault(word, effectiveMode, byokDefaultForMode(effectiveMode));
}
