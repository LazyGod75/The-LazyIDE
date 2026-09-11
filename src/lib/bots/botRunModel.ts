/* botRunModel — which LLM drives a LazyBot run, and on which rail.

   A LazyBot's RUNTIME is always the same (a Solari cloud computer driven by
   Lazy's own ReAct loop — see runLazyBotMission.ts). What varies is the
   BRAIN: the user may hold a BYOK key, a CLI subscription (claude/codex),
   Lazy Pro credits, or nothing but the free tier — and the app must run the
   bot with whichever of those is actually usable, never fail because a
   default id pointed at a rail the user doesn't have (the old
   `getActiveModel().id || 'claude-haiku-4-5'` sent every bot to the CLI
   rail whenever the active model was a Claude id, CLI installed or not).

   Rail detection reuses the runtime's own helpers (classifyMissionModel,
   isNativeModelReady, isManagedModelReady) — nothing is re-invented here.
*/

import {
  classifyMissionModel,
  isManagedModelReady,
  isNativeModelReady,
} from '../agents/runtime.js';
import { resolveCliEngineMode } from '../agents/cliAgentTurnStreamer.js';
import { BYOK_PROVIDER_DEFS, effectiveByokBaseUrl, effectiveByokModel, hasByokKey, loadByokKey, resolveByokAgentTurnStreamer, resolveByokDef, streamAnthropicCompatRaw } from '../models/byokProviders.js';
import { ALL_MODELS, DEFAULT_MODEL } from '../models/registry.js';
import {
  DEFAULT_OPENROUTER_MODEL_ID,
  FREE_OPENROUTER_MODEL_ID,
  OPENROUTER_MODELS,
  isOpenRouterFreeModel,
} from '../models/openrouterCatalog.js';
import { DEFAULT_DEVIN_MODEL_ID, devinModelInfos } from '../models/devinCatalog.js';

/** The four ways a LazyBot's brain can be served. `free` is the ai-proxy's
 *  no-credit tier (same transport as `pro`, no Pro plan required). */
export type BotModelRail = 'byok' | 'cli' | 'pro' | 'free';

export interface ResolvedBotRunModel {
  /** Model id to store on the mission (`Mission.model`). */
  model: string;
  /** Rail that model runs on — undefined when NO rail is usable right now
   *  (web mode, or a desktop with no key / CLI / plan / login). The mission
   *  then fails honestly at launch with `note` as its reason. */
  rail: BotModelRail | undefined;
  /** Human-readable explanation when the resolved model differs from the
   *  requested one, or when nothing is runnable. */
  note?: string;
}

/** Classifies a model id onto a bot rail. Mirrors classifyMissionModel
 *  exactly, plus one bot-specific case: an EMPTY id while the CLI tool is
 *  codex means "the codex CLI's own default model" (getActiveModel() returns
 *  id '' in codex mode by design — see models/index.ts). */
export function classifyBotModelRail(model: string | undefined): BotModelRail | undefined {
  // Anthropic BYOK is a ReAct text rail for LazyBots (streamAnthropicCompatRaw),
  // even though classifyMissionModel routes those ids as 'native' for the
  // local code-agent path. Prefer the user's own key over the CLI.
  if (model && isAnthropicByokModel(model) && hasByokKey('anthropic')) return 'byok';
  const kind = classifyMissionModel(model);
  if (kind === 'byok') return 'byok';
  if (kind === 'managed') return isOpenRouterFreeModel(model) ? 'free' : 'pro';
  if (kind === 'native') return 'cli';
  // Devin-catalog ids serve as a LazyBot brain through the same CLI text
  // streamer — same rail family as claude/codex.
  if (kind === 'devin') return 'cli';
  if (!model && resolveCliEngineMode() === 'codex') return 'cli';
  if (!model && resolveCliEngineMode() === 'devin') return 'cli';
  return undefined;
}

/** Whether a rail can serve a turn RIGHT NOW. `byok` is ready by
 *  construction (classifyMissionModel only yields it when the provider's
 *  key is set); `free` needs nothing but the ai-proxy. */
export function isBotRailReady(rail: BotModelRail): boolean {
  switch (rail) {
    case 'byok': return true;
    case 'cli': return isNativeModelReady();
    case 'pro': return isManagedModelReady();
    case 'free': return true;
  }
}

/** Why a rail is not usable — surfaced as the mission's statusReason. */
export function describeBotRailNotReady(rail: BotModelRail, model: string): string {
  switch (rail) {
    case 'cli': return `Le modèle "${model}" passe par la CLI (claude/codex/devin), qui n'est pas détectée sur ce poste.`;
    case 'pro': return `Le modèle "${model}" passe par Lazy Pro, sans plan actif ni crédits disponibles.`;
    case 'byok': return `Le modèle "${model}" nécessite une clé BYOK qui n'est pas configurée.`;
    case 'free': return `Le modèle gratuit "${model}" est indisponible.`;
  }
}

function isAnthropicByokModel(model: string): boolean {
  const def = BYOK_PROVIDER_DEFS.find((d) => d.id === 'anthropic');
  return !!def?.models.some((m) => m.id === model);
}

function firstReadyByokModel(): string | undefined {
  for (const def of BYOK_PROVIDER_DEFS) {
    if (hasByokKey(def.id)) return effectiveByokModel(def);
  }
  return undefined;
}

/** Anthropic BYOK as a ReAct text streamer (byokProviders skips it because
 *  the code-agent rail uses the Rust live-key bridge). LazyBots need the
 *  HTTP messages API instead. */
export function resolveAnthropicByokStreamer(model: string) {
  if (!isAnthropicByokModel(model) || !hasByokKey('anthropic')) return undefined;
  const def = resolveByokDef('anthropic');
  if (!def) return undefined;
  const apiKey = loadByokKey('anthropic');
  const baseUrl = effectiveByokBaseUrl(def);
  return (opts: { messages: Array<{ role: string; content: string }>; system: string; model: string; signal?: AbortSignal; maxTokens?: number }) =>
    streamAnthropicCompatRaw({
      baseUrl,
      apiKey,
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      maxTokens: opts.maxTokens ?? 8192,
      signal: opts.signal,
      providerId: 'anthropic',
    });
}

/** BYOK streamer for a bot brain, including Anthropic. */
export function resolveBotByokStreamer(model: string) {
  return resolveByokAgentTurnStreamer(model) ?? resolveAnthropicByokStreamer(model);
}

function defaultCliModel(): string {
  const engine = resolveCliEngineMode();
  if (engine === 'codex') return '';
  if (engine === 'devin') return DEFAULT_DEVIN_MODEL_ID;
  return DEFAULT_MODEL.id;
}

/** The first READY rail's default model, in preference order BYOK (the
 *  user's own key) → CLI → Pro → free. `exclude` skips rail(s) that just
 *  proved unusable at run time (see runLazyBotMission's brain failover). */
export function firstReadyRailDefault(
  exclude?: BotModelRail | ReadonlySet<BotModelRail>,
): { model: string; rail: BotModelRail } | undefined {
  const skip = exclude instanceof Set
    ? exclude
    : new Set(exclude ? [exclude] : []);
  const byok = skip.has('byok') ? undefined : firstReadyByokModel();
  if (byok) return { model: byok, rail: 'byok' };
  if (!skip.has('cli') && isNativeModelReady()) return { model: defaultCliModel(), rail: 'cli' };
  if (!skip.has('pro') && isManagedModelReady()) return { model: DEFAULT_OPENROUTER_MODEL_ID, rail: 'pro' };
  // Free shares the ai-proxy with Pro — if Pro just refused, free would too.
  if (!skip.has('free') && !skip.has('pro')) return { model: FREE_OPENROUTER_MODEL_ID, rail: 'free' };
  return undefined;
}

const TIER_WORD = /\b(haiku|sonnet|opus)\b/i;

/** True for an id that names ONE concrete model: an OpenRouter id, a native
 *  registry id, or a BYOK catalog id. False for a bare tier hint ("haiku",
 *  "Claude Sonnet 5") — those are wishes about size/speed, not a rail
 *  choice, and must never drag a bot onto a rail the user isn't using. */
export function isExactBotModelId(model: string | undefined): boolean {
  if (!model) return false;
  if (model.includes('/')) return true;
  if (ALL_MODELS.some((m) => m.id === model)) return true;
  if (devinModelInfos().some((m) => m.id === model)) return true;
  return BYOK_PROVIDER_DEFS.some((d) => d.models.some((m) => m.id === model));
}

/** Resolves a bare tier hint INSIDE a rail's own catalog — the same
 *  "plain tier hints still resolve within this same rail" contract the
 *  manager prompt documents for launch_mission. Rails without tiers (BYOK,
 *  free) keep their model unchanged. */
export function applyTierHintWithinRail(hint: string, base: { model: string; rail: BotModelRail }): string {
  const word = hint.toLowerCase().match(TIER_WORD)?.[1];
  if (!word) return base.model;
  if (base.rail === 'pro') {
    return OPENROUTER_MODELS.find((m) => m.provider === 'Anthropic' && m.id.toLowerCase().includes(word))?.id ?? base.model;
  }
  if (base.rail === 'cli') {
    const pool = resolveCliEngineMode() === 'devin' ? devinModelInfos() : ALL_MODELS;
    return pool.find((m) => m.id.toLowerCase().includes(word))?.id ?? base.model;
  }
  return base.model;
}

function dedupe(candidates: ReadonlyArray<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (c === undefined) continue;
    const key = c.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Picks the model a LazyBot run should use.
 *
 * `requested` (the manager action's `model`, or a saved routine's model) is
 * honored first when it names an EXACT model whose rail is ready. A bare
 * tier hint ("haiku") is NOT a rail choice: the fallbacks (the manager's own
 * model for this conversation, then the app's active model — i.e. the rail
 * the user is actually using) win, and the hint is then applied within that
 * rail's catalog. Otherwise the first READY rail's default (BYOK key → CLI
 * → Pro), otherwise the free tier. A `note` explains every substitution so
 * the manager can relay it honestly.
 */
export function resolveLazyBotRunModel(
  requested: string | undefined,
  fallbacks: ReadonlyArray<string | undefined> = [],
): ResolvedBotRunModel {
  const wanted = requested?.trim() || undefined;
  const exactWanted = wanted && isExactBotModelId(wanted) ? wanted : undefined;
  const hint = wanted && !exactWanted ? wanted : undefined;
  const candidates = dedupe([exactWanted, ...fallbacks, hint]);
  let firstBlocked: { model: string; rail: BotModelRail } | undefined;

  for (const candidate of candidates) {
    const rail = classifyBotModelRail(candidate);
    if (!rail) continue;
    if (isBotRailReady(rail)) {
      const model = hint && candidate !== hint ? applyTierHintWithinRail(hint, { model: candidate, rail }) : candidate;
      let note: string | undefined;
      if (hint && candidate !== hint) {
        note = `indice "${hint}" appliqué sur le rail ${rail} → "${model}"`;
      } else if (wanted && model !== wanted) {
        note = `modèle demandé "${wanted}" indisponible sur ce poste — remplacé par "${model}" (${rail})`;
      }
      return { model, rail, note };
    }
    firstBlocked ??= { model: candidate, rail };
  }

  const fallback = firstReadyRailDefault() ?? { model: FREE_OPENROUTER_MODEL_ID, rail: 'free' as const };
  const blockedNote = firstBlocked
    ? `${describeBotRailNotReady(firstBlocked.rail, firstBlocked.model)} `
    : '';
  const label = fallback.rail === 'free'
    ? `le modèle gratuit "${fallback.model}"`
    : `"${fallback.model}" (${fallback.rail})`;
  return { ...fallback, note: `${blockedNote}Repli sur ${label}.`.trim() };
}
