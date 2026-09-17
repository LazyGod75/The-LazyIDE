/* seedExtractor — "which rail annotates the brain seed", the onboarding-time
   counterpart of the chat model picker (modelPickerOptions.ts).

   Problem this solves: the brain seed runs in the lazybrain child process
   spawned by Rust, which used to auto-detect its LLM backend (claude CLI on
   PATH → ANTHROPIC_API_KEY env → heuristic) with no input from the app. A
   user who just configured DeepSeek BYOK, or only holds a free Lazy account,
   got heuristic notes even though a perfectly usable rail existed. This
   module turns the SAME entitlements the chat model picker reads into a
   serializable SeedExtractorSpec that crosses IPC into the child's env
   (see SeedExtractorArg in src-tauri/src/commands/brain/history_import.rs).

   Rails offered, in display order:
     free       — the managed free rail (GLM 5.2 / Union Alpha) served by
                  Lazy's ai-proxy; needs a signed-in account, NOT LazyPro.
     pro        — the paid managed catalog through the same proxy, for
                  LazyPro users who want a specific (cheap) model.
     claude-cli — the user's Claude Code subscription via the `claude` CLI.
     anthropic  — a BYOK Anthropic key.
     byok:<id>  — a keyed non-Anthropic BYOK provider (DeepSeek, OpenRouter,
                  Mistral, any OpenAI-compatible endpoint).
     heuristic  — always present; zero-config, zero-cost, lower quality.

   Cost guidance is part of the contract: extraction is a fixed
   "emit a JSON array of facts" task, so every rail resolves to the CHEAPEST
   sensible model by default and the UI label says so. Model ids are always
   resolved from the live catalogs (openrouterCatalog / byokProviders /
   registry) — nothing versioned is hardcoded here, so an upstream model
   retirement is a catalog edit, not a code change.
*/

import { getAiProxyUrl, supabaseAnonKey, supabaseUrl } from '../env.js';
import { isCloudConfigured } from '../envCloud.js';
import { isTauri } from '../platform/index.js';
import type { SeedExtractorSpec } from '../platform/types.js';
import { supabase } from '../supabase/client.js';
import {
  BYOK_PROVIDER_DEFS,
  effectiveByokBaseUrl,
  effectiveByokModel,
  hasByokKey,
  loadByokKey,
} from '../models/byokProviders.js';
import type { ByokProviderDef } from '../models/byokProviders.js';
import { isCliBackendAvailable } from '../models/cliBackendProvider.js';
import { hasAnthropicKey } from '../models/anthropicProvider.js';
import { hasManagedCreditsActive, getProPlanState } from '../models/index.js';
import { OPENROUTER_MODELS } from '../models/openrouterCatalog.js';
import { DEFAULT_MODEL } from '../models/registry.js';

// ── Rail descriptor ─────────────────────────────────────────────

export type SeedRailKind = 'lazy-proxy' | 'claude-cli' | 'anthropic' | 'openai';

export interface SeedRail {
  /** Stable id used as the picker's option value ('free', 'pro',
   *  'claude-cli', 'anthropic', 'byok:deepseek', …). */
  id: string;
  /** Maps to SeedExtractorSpec.kind — what Rust writes to
   *  LAZYBRAIN_EXTRACTOR. */
  kind: SeedRailKind;
  /** Short rail name for the option label ("LazyPro", "Claude Code CLI"). */
  label: string;
  /** Resolved model id this rail would run (cheap default or the user's
   *  configured override). Undefined for rails whose backend picks its own
   *  model (claude-cli without an explicit choice). */
  model?: string;
  /** Display name of `model` when it has one. */
  modelLabel?: string;
  /** i18n key resolved at render time — the one-line cost/quality hint next
   *  to the option ("onboarding.brain.railFree.hint" → "Free — provided by
   *  LazyIDE"). Never a literal string: this module is locale-agnostic. */
  hintKey: string;
  /** For lazy-proxy rails: whether the model is a `:free` catalog entry —
   *  lets the UI say "offert par LazyIDE" vs "sur vos crédits LazyPro". */
  free?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Cheapest paid (non-free) managed catalog entry by input price — the
 *  "modèle pas cher" recommendation for the pro rail. Returns undefined when
 *  the catalog ships zero paid entries (defensive; never happens today). */
function cheapestManagedModel(): (typeof OPENROUTER_MODELS)[number] | undefined {
  let best: (typeof OPENROUTER_MODELS)[number] | undefined;
  for (const m of OPENROUTER_MODELS) {
    if (m.isFree) continue;
    if (!best || m.priceIn < best.priceIn) best = m;
  }
  return best;
}



async function sessionToken(): Promise<string | null> {
  if (!isCloudConfigured(supabaseUrl, supabaseAnonKey)) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

// ── Detection ───────────────────────────────────────────────────

/**
 * List the rails the user can pick RIGHT NOW for a brain seed. Async because
 * the free/pro rails need the Supabase session (getSession() reads the local
 * persisted session — no network call in the common case).
 *
 * Order matters for the UI: free first (zero-config for any signed-in user),
 * then the user's own rails, heuristic implied separately by the caller.
 */
export async function listSeedRails(): Promise<SeedRail[]> {
  const rails: SeedRail[] = [];

  const token = await sessionToken();
  if (token) {
    // One rail per free catalog entry (GLM 5.2, Union Alpha…) — the default
    // first so railList[0] stays the zero-config pick. Each carries its own
    // model id: hiding Union Alpha behind the single 'free' rail made it
    // unreachable in the picker.
    for (const free of OPENROUTER_MODELS.filter((m) => m.isFree)) {
      rails.push({
        id: `free:${free.id}`,
        kind: 'lazy-proxy',
        label: 'LazyIDE Free',
        model: free.id,
        modelLabel: free.label,
        hintKey: 'onboarding.brain.railFree.hint',
        free: true,
      });
    }
    const pro = hasManagedCreditsActive() || getProPlanState() === 'active';
    const cheap = cheapestManagedModel();
    if (pro && cheap) {
      rails.push({
        id: 'pro',
        kind: 'lazy-proxy',
        label: 'LazyPro',
        model: cheap.id,
        modelLabel: cheap.label,
        hintKey: 'onboarding.brain.railPro.hint',
      });
    }
  }

  if (isTauri() && isCliBackendAvailable('claude') === true) {
    rails.push({
      id: 'claude-cli',
      kind: 'claude-cli',
      label: 'Claude Code CLI',
      hintKey: 'onboarding.brain.railClaudeCli.hint',
    });
  }

  if (hasAnthropicKey()) {
    rails.push({
      id: 'anthropic',
      kind: 'anthropic',
      label: 'Anthropic (BYOK)',
      model: DEFAULT_MODEL.id,
      modelLabel: DEFAULT_MODEL.label,
      hintKey: 'onboarding.brain.railAnthropic.hint',
    });
  }

  for (const def of BYOK_PROVIDER_DEFS) {
    if (def.id === 'anthropic' || !hasByokKey(def.id)) continue;
    const model = effectiveByokModel(def);
    rails.push({
      id: `byok:${def.id}`,
      kind: 'openai',
      label: `BYOK · ${def.label}`,
      model,
      modelLabel: model,
      hintKey: 'onboarding.brain.railByok.hint',
    });
  }

  return rails;
}

/**
 * Credential-free spec for seedEstimate — enough for Rust to report the
 * rail's real label in the estimate's `backend` field, without the session
 * JWT or a BYOK key ever crossing IPC for a dry-run. (Rust treats a
 * credential-less lazy-proxy/openai spec as label-only; a real seed
 * resolves the full spec via resolveSeedExtractor below.)
 */
export function railEstimateSpec(rail: SeedRail): SeedExtractorSpec {
  const spec: SeedExtractorSpec = { kind: rail.kind, model: rail.model, label: rail.label };
  if (rail.kind === 'lazy-proxy') spec.baseUrl = getAiProxyUrl();
  if (rail.kind === 'openai' && rail.id.startsWith('byok:')) {
    const def = BYOK_PROVIDER_DEFS.find((d) => d.id === rail.id.slice(5));
    if (def) spec.baseUrl = effectiveByokBaseUrl(def);
  }
  return spec;
}

// ── Resolution ──────────────────────────────────────────────────

/**
 * Turn a picked rail (from listSeedRails) into the spec sent to Rust.
 * Returns null when the rail's credential is missing at resolve time
 * (session expired between list and click, key removed) — callers fall back
 * to a heuristic seed. For 'free'/'pro' rails `modelId` may override the
 * rail's cheap default (advanced model select).
 */
export async function resolveSeedExtractor(rail: SeedRail, modelId?: string): Promise<SeedExtractorSpec | null> {
  switch (rail.kind) {
    case 'lazy-proxy': {
      const token = await sessionToken();
      const url = getAiProxyUrl();
      if (!token || !url) return null;
      const model = modelId ?? rail.model;
      if (!model) return null;
      // Free rails: the OTHER free catalog entries ride along as fallbacks —
      // each :free/stealth route 429s or gets pulled individually, so the
      // child walks the whole group before degrading a note to heuristic.
      const fallbackModels = rail.free
        ? OPENROUTER_MODELS.filter((m) => m.isFree && m.id !== model).map((m) => m.id)
        : undefined;
      return {
        kind: 'lazy-proxy',
        baseUrl: url,
        model,
        fallbackModels: fallbackModels?.length ? fallbackModels : undefined,
        apiKey: token,
        anonKey: supabaseAnonKey || undefined,
        // Backend-facing label (estimate's `backend` field, engine logs) —
        // the friendly model name, not the raw catalog id. The "offert par
        // LazyIDE" message lives in the picker's localized hint, not here.
        label: `${rail.label} · ${rail.modelLabel ?? model}`,
      };
    }
    case 'claude-cli':
      return { kind: 'claude-cli', model: modelId ?? rail.model, label: rail.label };
    case 'anthropic': {
      const key = loadByokKey('anthropic');
      if (!key.trim()) return null;
      return {
        kind: 'anthropic',
        model: modelId ?? rail.model,
        apiKey: key,
        label: rail.label,
      };
    }
    case 'openai': {
      const providerId = rail.id.startsWith('byok:') ? rail.id.slice(5) : rail.id;
      const def: ByokProviderDef | undefined = BYOK_PROVIDER_DEFS.find((d) => d.id === providerId);
      if (!def) return null;
      const key = loadByokKey(def.id);
      if (!key.trim()) return null;
      return {
        kind: 'openai',
        baseUrl: effectiveByokBaseUrl(def),
        model: modelId ?? rail.model ?? effectiveByokModel(def),
        apiKey: key,
        label: rail.label,
      };
    }
  }
}

// ── Deferred-enrichment flag ────────────────────────────────────
// A heuristic-only seed still builds a usable brain; when the user later
// gains a real rail (connects the Claude CLI, adds a BYOK key, subscribes
// LazyPro), a one-shot toast offers to re-run the import with the LLM on.
// The flag doubles as the "was it heuristic" record — it is cleared by an
// LLM-enriched seed or an explicit dismiss, never by time alone (the offer
// stays relevant until acted on).

const HEURISTIC_SEED_FLAG = 'lazy.brainSeedHeuristicOnly';

/** What the deferred offer is about: 'heuristic' = a seed ran without LLM
 *  (re-run to enrich), 'deferred' = the user picked "faire plus tard" and
 *  never seeded at all (import from scratch). */
export type EnrichmentOfferKind = 'heuristic' | 'deferred';

function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Called when a seed completes WITHOUT an LLM backend (useLlm=false, or the
 *  backend resolved to heuristic). Stores the rails available at that moment
 *  so a later offer only fires on a genuinely NEW option. */
export function markHeuristicSeed(railIds: string[]): void {
  ls()?.setItem(HEURISTIC_SEED_FLAG, JSON.stringify({ at: Date.now(), rails: railIds, deferred: false }));
}

/** Called when the user picks "faire plus tard" on the seed step — the brain
 *  was never built; the deferred offer's copy differs (import, not enrich). */
export function markDeferredSeed(railIds: string[]): void {
  ls()?.setItem(HEURISTIC_SEED_FLAG, JSON.stringify({ at: Date.now(), rails: railIds, deferred: true }));
}

/** Called when a seed completes WITH an LLM backend — nothing to offer. */
export function markEnrichedSeed(): void {
  ls()?.removeItem(HEURISTIC_SEED_FLAG);
}

/**
 * Should the "you can now enrich your brain" toast fire — and about what?
 * Returns the offer kind when a past heuristic/deferred seed exists AND at
 * least one rail is available now that did not exist at seed time (a NEWLY
 * gained entitlement — the whole point of the toast). Null when there is
 * nothing to offer. The caller MUST call markEnrichmentOffered when it
 * actually shows the toast — that folds the just-seen rails into the
 * snapshot so the same set of rails can never trigger the toast twice,
 * while a rail appearing later still can.
 */
export async function shouldOfferEnrichment(): Promise<EnrichmentOfferKind | null> {
  const raw = ls()?.getItem(HEURISTIC_SEED_FLAG);
  if (!raw) return null;
  let seedRails: string[] = [];
  let deferred = false;
  try {
    const parsed = JSON.parse(raw) as { rails?: string[]; deferred?: boolean };
    seedRails = Array.isArray(parsed.rails) ? parsed.rails : [];
    deferred = parsed.deferred === true;
  } catch {
    // malformed — treat as "no rails recorded", offer on any current rail
  }
  const now = await listSeedRails();
  return now.some((r) => !seedRails.includes(r.id)) ? (deferred ? 'deferred' : 'heuristic') : null;
}

/** Called when the enrichment toast is actually shown: the current rails
 *  are folded into the snapshot so they count as "seen" — a toast already
 *  displayed for rail X never repeats for X, but rail Y appearing next
 *  month still fires. Preserves the record's `deferred` kind. */
export function markEnrichmentOffered(currentRailIds: string[]): void {
  const raw = ls()?.getItem(HEURISTIC_SEED_FLAG);
  let deferred = false;
  try {
    deferred = raw ? (JSON.parse(raw) as { deferred?: boolean }).deferred === true : false;
  } catch { /* malformed — default to the heuristic copy */ }
  ls()?.setItem(HEURISTIC_SEED_FLAG, JSON.stringify({ at: Date.now(), rails: currentRailIds, deferred }));
}

/** Enrichment was accepted/started — the flag has served its purpose. */
export function clearHeuristicSeedFlag(): void {
  ls()?.removeItem(HEURISTIC_SEED_FLAG);
}
