/* managerEngine.ts — LazyManager LLM engine.
   Interprets natural language commands from the user and emits structured
   actions (create_agent, launch_mission, create_loop, stop_mission, etc.)
   that the UI executes via agentsStore.

   Routes the single planning turn through whichever backend matches the
   current provider mode (claude-code CLI, codex CLI, or the managed/pro
   ai-proxy) so it works regardless of which engine the user has configured.

   The manager has NO file tools — it reasons about the current state
   (agents, missions, brain) and outputs actions in a JSON block.
*/

import { getProviderMode, getDefaultModelIdForMode } from '../models/index.js';
import type { ProviderMode } from '../models/index.js';
import { ALL_MODELS } from '../models/registry.js';
import { OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL_ID, isOpenRouterFreeModel } from '../models/openrouterCatalog.js';
import type { ModelTier } from '../models/openrouterCatalog.js';
import type { ModelEntitlements } from '../models/modelPickerOptions.js';
import type { ManagerAction, ManagerEngineChoice, ManagerMessage, Mission, Effort } from './types.js';
import type { StoredAgent } from './agentsStorage.js';
import { ECC_AGENTS } from './eccAgents.js';
import { buildEccAgentCatalog } from './managerEccCatalog.js';
import { stripReasoningLines } from './reasoningLeak.js';
import { stripArtifactEnvelope } from './artifactEnvelopeLeak.js';
import { buildFleetContext, buildTemplateOrchestratorContext, formatAutonomyContext, buildLessonsContext, buildOtherProjectsDigest } from './managerContext.js';
import { buildExplicitBrainQueryNudge, enrichManagerContextForTurn } from './managerAmbientRecall.js';
import { maybeFederatedRecallForManager } from './managerFederatedRecall.js';
import { scheduleManagerTurnCapture } from './managerTurnCapture.js';
import { RECALL_TEACHING } from '../models/systemPrompts.js';
// billing/credits is pure (no side effects, no imports — see its own header)
// so importing it here never pulls in React/Supabase, unlike the billing
// barrel (lib/billing/index.ts), which re-exports SubscriptionContext.tsx.
import { formatCredits } from '../billing/credits.js';
import { validateManagerAction, KNOWN_ACTION_TYPES } from './managerActionValidator.js';
import { buildManagerCorePrompt } from './managerCorePrompt.js';
import { compactTranscriptWithMeta } from './transcriptCompact.js';
import { extractBareActionObjectSpans } from './bareActionSpans.js';
import { nativeEngineMode } from './managerModelResolve.js';
import {
  streamManagerCompletion,
} from './managerStreamCompletion.js';
export {
  ACTION_FORMAT_REMINDER,
  accumulateManagerChunks,
} from './managerStreamCompletion.js';
import {
  presentSection,
  groundedResultBlock,
  formatVisibleMissionLines,
} from './managerDynamicContext.js';
import { formatLazyBotsContext } from '../bots/botManagerContext.js';
import type { LazyBotSummary } from '../bots/botManagerContext.js';
import {
  detectDeterministicManagerAction,
  formatDeterministicFallbackNotice,
} from './managerLazyBotFallback.js';
import {
  appendTurnRetryMessages,
  applyRepairedActions,
  assembleManagerTurnResponseText,
  collectInvalidActionReasons,
  eligibleRepairMode,
  firstTurnPartial,
  formatZeroActionNudgeLog,
  nudgeFailedOutcome,
  resolveManagerTurnMode,
  isSubstantialInformationalReply,
  shouldNudgeZeroActions,
  shouldRetryInvalidActions,
  showNudgeFailureNotice,
  zeroActionNudgeUserContent,
} from './managerTurnRetry.js';

export {
  formatMissionDetail,
  formatMissionNotFound,
} from './formatMissionDetail.js';
export type { MissionDetailOptions } from './formatMissionDetail.js';

// ── Model resolution (mode-aware) ───────────────────────────────────
// launch_mission / create_loop actions carry a tier hint — "haiku" | "sonnet"
// | "opus" (see the action contract in buildManagerSystemPrompt below) — OR,
// since the modelId catalog wave, an exact catalog id (ManagerModelId,
// types.ts) naming one model precisely. The concrete id must belong to
// whichever id family the CURRENT provider mode's backend accepts: native
// Anthropic ids for claude-code/codex, the FULL OpenRouter catalog for the
// managed/Pro ai-proxy (see managedProvider.ts — it forwards the model
// string to the proxy as-is, with no tier translation, and managedAgent.ts's
// own model mapping, toNativeClaudeModel, only maps TOWARD native ids, never
// toward OpenRouter ids). Resolving the tier against the wrong family is
// exactly the "Modèle non supporté" blocker this fixes.
//
// modelId catalog wave (2026-07-28): the Pro rail used to be artificially
// narrowed to the 4 Anthropic entries (managedAnthropicModels in
// managerStreamCompletion.ts, used by toManagedModelId for the MANAGER'S
// OWN reasoning-model selection, a separate concern) — a model choosing e.g. "openai/gpt-5.4-mini" for a
// step was silently ignored and replaced by the tier default. Fixed by (1)
// widening the tier-word pool to the full OPENROUTER_MODELS catalog (only
// Anthropic ids ever contain "haiku"/"sonnet"/"opus" as a substring, so this
// is a pure widening, not a behavior change for existing tier hints), and
// (2) accepting an exact `modelId` ahead of the tier hint, validated against
// the CURRENT rail's real catalog — never silently substituted when unknown
// (see UnknownManagerModelIdError in managerModelResolve.ts).
// Implementation of resolveManagerModelId lives there (extracted 2026-08-28:
// cyclomatic complexity was 42, ratchet ceiling 12). Re-exported below.
//
// modelId is threaded through for: launch_mission, launch_best_of_n
// (its contest step), create_loop, create_draft, spawn_submissions'
// per-modification bag, and generate_plan steps — createOrchestrator,
// compileOrchestratorToIr, and launchOptsFromNode carry the field to
// the launched mission (see StepContract.modelId).

export {
  UnknownManagerModelIdError,
  resolveBareRailModelId,
  findOpenRouterAliasHint,
  findByokHomeHint,
  findAlternateRailMatches,
  resolveManagerModelId,
  nativeEngineMode,
} from './managerModelResolve.js';
export type { BareRailLookup } from './managerModelResolve.js';

/** Hard cap on buildCompactModelCatalog's output — token efficiency is a
 *  core product value (see this task's own instructions): the full catalog
 *  is ~20 ids across ~11 providers, so a naive per-id listing would run
 *  several thousand characters every single turn. Grouping by ModelTier
 *  instead of provider keeps this well under budget with room for catalog
 *  growth. 2026-09-02: the catalog outgrew the original 600-char cap (the
 *  free tier gained z-ai/glm-5.2:free + nvidia/nemotron-3-ultra-550b-a55b:
 *  free), and a TRUNCATED id is actively harmful (the manager copies one
 *  verbatim into a modelId field), so the cap was raised to keep every id
 *  exact — revisit it the next time the catalog grows past this.
 *  Exported so the tests assert against the real value, never a drifted
 *  hardcoded copy. */
export const MODEL_CATALOG_MAX_CHARS = 1000;

const TIER_GROUP_LABEL: Record<ModelTier, string> = {
  fast: 'fast',
  balanced: 'balanced',
  max: 'max-reasoning',
  free: 'free',
};

/**
 * Build a compact listing of the FULL OpenRouter catalog for the manager's
 * dynamic context (see buildManagerDynamicContext's proModelCatalogBlock) —
 * injected ONLY when the Lazy Pro rail is actually usable this turn
 * (ManagerContext.proRailActive), since the CLI rail can never route to any
 * of these ids anyway (see UnknownManagerModelIdError's 'cli' branch).
 *
 * Grouped by ModelTier rather than one line per id-with-prose: a real,
 * existing catalog field that already doubles as a compact "specialty" —
 * fast = cheap/mechanical, balanced = default workhorse, max-reasoning =
 * hardest problems, free = zero-cost — shared across a whole group instead
 * of repeated per id, which is what keeps this under MODEL_CATALOG_MAX_CHARS
 * without truncating the id list itself (every id is kept EXACT and
 * complete — the manager must copy one verbatim into a `modelId` field, so
 * abbreviating an id here would make the catalog actively harmful). The
 * trailing slice is a pure safety net (never observed to trigger against
 * today's catalog) should the catalog grow before this cap is revisited.
 */
export function buildCompactModelCatalog(): string {
  const groups: Record<ModelTier, string[]> = { fast: [], balanced: [], max: [], free: [] };
  for (const m of OPENROUTER_MODELS) groups[m.tier].push(m.id);
  const lines = (Object.keys(TIER_GROUP_LABEL) as ModelTier[])
    .filter((tier) => groups[tier].length > 0)
    .map((tier) => `${TIER_GROUP_LABEL[tier]}: ${groups[tier].join(', ')}`);
  const joined = lines.join('\n');
  return joined.length > MODEL_CATALOG_MAX_CHARS
    ? `${joined.slice(0, MODEL_CATALOG_MAX_CHARS - 1)}…`
    : joined;
}

/** Native Anthropic id the manager should start on for claude-code/live-key/
 *  mock modes. Resolved by id from ALL_MODELS (never a bare string literal),
 *  the same defensive lookup registry.ts's own DEFAULT_MODEL uses, so a future
 *  catalog reorder/removal can't silently break this the way a fixed array
 *  index once did (see registry.ts's DEFAULT_ANTHROPIC_MODEL_ID comment).
 *
 *  Sonnet is the right default for the manager's orchestration role
 *  (see getManagerDefaultModelId's doc comment below). The user's
 *  manually-picked model (localStorage 'lazy.manager.model') always wins. */
const MANAGER_NATIVE_MODEL_ID = 'claude-sonnet-5';

/**
 * Default model id for the MANAGER's own reasoning turn (decomposing a
 * request into a multi-agent graph), as opposed to
 * getDefaultModelIdForMode's general-purpose default — used by loop/chain
 * worker missions, the New Mission modal, and inline AI actions (Ctrl+K,
 * auto-fix), where Haiku's cost-efficiency is the right call for
 * mechanical/well-specified work.
 *
 * On a fresh profile the manager used to start on Haiku — the catalog's
 * cheapest/weakest tier — which is a direct handicap for a role whose whole
 * job is planning and orchestration. Only the native-id branch's target
 * model changes here; managed/pro/codex are delegated to
 * getDefaultModelIdForMode UNCHANGED:
 *  - managed/pro -> DEFAULT_OPENROUTER_MODEL_ID (already Sonnet — no fix
 *    needed, and no risk of breaking the existing Pro-credits fallback).
 *  - codex       -> '' sentinel (Codex CLI picks its own default).
 *  - claude-code/live-key -> MANAGER_NATIVE_MODEL_ID (Sonnet) instead
 *    of DEFAULT_MODEL (Haiku).
 *  - mock (browser) -> first isFree OpenRouter id. Native Sonnet cannot
 *    run outside Tauri (measured 2026-08-28 LazyManager CLI error).
 *
 * Callers must still let a persisted user choice win over this default (see
 * agentsStore.tsx's loadManagerModel, which only falls back here when
 * nothing valid was ever explicitly selected).
 */
export function getManagerDefaultModelId(mode: ProviderMode): string {
  if (mode === 'managed' || mode === 'pro' || mode === 'codex') {
    return getDefaultModelIdForMode(mode);
  }
  if (mode === 'mock') {
    return OPENROUTER_MODELS.find((m) => m.isFree)?.id ?? DEFAULT_OPENROUTER_MODEL_ID;
  }
  return ALL_MODELS.find((m) => m.id === MANAGER_NATIVE_MODEL_ID)?.id ?? getDefaultModelIdForMode(mode);
}

// ── generate_plan step cost/duration estimate (Mission B, "draw before you
// build") ────────────────────────────────────────────────────────────────
// Feeds GraphProposalCard's per-plan cost/duration totals (agentsStore.tsx's
// generate_plan proposal construction) — the numbers the user sees on the
// mini-DAG proposal BEFORE validating it. Previously a flat per-tier
// estimate that ignored a step's `effort`: a "high"/"max" reasoning-effort
// step spends materially more tokens than "medium" on the SAME model tier,
// so the old estimate under-quoted exactly the steps most likely to matter
// (hard reasoning, opus/high). Kept here (not inlined in agentsStore.tsx) so
// the single formula backs both the total shown pre-validation and any
// future per-step breakdown, without two copies drifting apart.

/** Minimal step shape the estimators need — decoupled from the full
 *  OrchestratorPlanStepInput so a caller building a synthetic/partial step
 *  (e.g. a test fixture) never has to fill in unrelated contract fields. */
export interface PlanStepEstimateInput {
  model?: string;
  effort?: Effort;
  maxAttempts?: number;
}

type PlanModelTier = 'haiku' | 'sonnet' | 'opus';

function planStepTier(model: string | undefined): PlanModelTier {
  return model === 'opus' ? 'opus' : model === 'sonnet' ? 'sonnet' : 'haiku';
}

/** True when a plan step targets a FREE OpenRouter model (ox alpha) — its
 *  whole plan contributes ZERO USD to the estimate (it is really free) and
 *  gets a duration hint (execution happens upstream, still wall-clock time),
 *  not a hard-coded paid-tier blank. Kept here so estimatePlanStepCostUsd
 *  and estimatePlanStepDurationMs agree on the free case. */
function isFreePlanStep(model: string | undefined): boolean {
  return isOpenRouterFreeModel(model);
}

const PLAN_TIER_BASE_COST_USD: Record<PlanModelTier, number> = { haiku: 0.5, sonnet: 1.5, opus: 3 };
// Free-model plan steps still take wall-clock time upstream (they're free,
// not instant) — same effort multiplier as a fast-tier step, but the cost
// side stays 0 (see estimatePlanStepCostUsd).
const PLAN_FREE_BASE_DURATION_MIN = 1.5;
const PLAN_TIER_BASE_DURATION_MIN: Record<PlanModelTier, number> = { haiku: 3, sonnet: 5, opus: 8 };

/** Reasoning-effort multiplier — "low" trims the flat tier estimate down
 *  (mechanical/quick), "medium" leaves it unchanged (the old baseline),
 *  "high"/"max" scale it up (deeper reasoning, more tokens/time). Applied to
 *  both cost and duration, at slightly different rates: effort inflates
 *  wall-clock time a bit less than it inflates token spend, mirroring how
 *  reasoning tokens dominate cost more than they dominate latency. */
const PLAN_EFFORT_COST_MULTIPLIER: Record<Effort, number> = { low: 0.6, medium: 1, high: 1.6, max: 2.2 };
const PLAN_EFFORT_DURATION_MULTIPLIER: Record<Effort, number> = { low: 0.7, medium: 1, high: 1.5, max: 2 };

/** Estimated USD cost for one generate_plan step, tier + effort + retry
 *  count combined — see the module comment above for why effort matters. */
export function estimatePlanStepCostUsd(step: PlanStepEstimateInput): number {
  // A step targeting a FREE model (ox alpha): the cost side is exactly 0 —
  // never a hard-coded paid tier estimate. A duration hint still applies (it really
  // does take wall-clock time upstream), see PLAN_FREE_BASE_DURATION_MIN.
  if (isFreePlanStep(step.model)) {
    return 0;
  }
  const base = PLAN_TIER_BASE_COST_USD[planStepTier(step.model)];
  const effortMul = PLAN_EFFORT_COST_MULTIPLIER[step.effort ?? 'medium'];
  return base * effortMul * (step.maxAttempts ?? 1);
}

/** Estimated wall-clock duration (ms) for one generate_plan step — same
 *  tier + effort + retry-count reasoning as estimatePlanStepCostUsd. Free
 *  steps use their own (shorter) base — free ≠ instant, but lighter. */
export function estimatePlanStepDurationMs(step: PlanStepEstimateInput): number {
  const effortMul = PLAN_EFFORT_DURATION_MULTIPLIER[step.effort ?? 'medium'];
  const baseMin = isFreePlanStep(step.model)
    ? PLAN_FREE_BASE_DURATION_MIN
    : PLAN_TIER_BASE_DURATION_MIN[planStepTier(step.model)];
  return baseMin * 60_000 * effortMul * (step.maxAttempts ?? 1);
}

// ── System prompt builder ──────────────────────────────────────────

export interface ManagerContext {
  agents: StoredAgent[];
  missions: Mission[];
  /**
   * REMOVED as an ambient, auto-populated field (2026-07-28 perf/architecture
   * audit): runManagerTurn no longer calls brain.recall() on every turn to
   * fill this in — see that function's own doc comment for the measured
   * cost (a full engine search, including an uncached 44MB backlinks.json
   * re-read, on literally every reply) and why it was pure duplication of
   * the explicit brain_query action below. Kept only as an optional
   * pass-through: a caller (or a test) that already has recall text may
   * still supply it directly and buildManagerDynamicContext will render it,
   * but nothing in the manager's own turn loop populates it anymore. Prefer
   * brainQueryResult below for anything grounded.
   */
  brainRecall?: string;
  /**
   * Grounded REAL data for one mission, injected when the manager needs to
   * answer a question about an agent's actual output (query_mission /
   * get_agent_output). Built by formatMissionDetail/formatMissionNotFound
   * from the mission's real actionTimeline + result + diff + metrics —
   * never fabricated, and already truncated to a safe prompt size.
   */
  missionDetail?: string;
  /**
   * Grounded REAL memory recall for the manager's own brain_query action,
   * injected on the follow-up turn (see runGroundedFollowUp in
   * agentsStore.tsx) so the manager answers from actual brain results
   * instead of guessing. Built via recallForDirective (brainSearchLoop.ts)
   * — the same 'current'-scope, bounded-timeout, never-throws recall path
   * the assistant's BRAIN_SEARCH loop uses. This is now the ONLY brain
   * recall path the manager's turn loop feeds — triggered exclusively by
   * the model's own brain_query action, with a model-extracted topic query
   * (never the user's raw sentence).
   */
  brainQueryResult?: string;
  /**
   * Grounded REAL structural recall for the manager's brain_query_css /
   * brain_neighbours actions, injected on the follow-up turn (see
   * runGroundedFollowUp in agentsStore.tsx). Built via runBrainQueryCss /
   * runBrainNeighbours (brainTool.ts) — the same deterministic CSS-selector /
   * graph-hop recall the agent surfaces use, and the same never-throws
   * contract as brainQueryResult above. Distinct from brainQueryResult
   * (semantic recall) because the query shape and result are structural.
   */
  structuralQueryResult?: string;
  /**
   * Grounded REAL web search/fetch results for the manager's web_search /
   * web_fetch actions, injected on the follow-up turn (see
   * runGroundedFollowUp in agentsStore.tsx). Built via the shared
   * toolRuntime's executeTool — the same web_search/web_fetch the agent
   * surfaces use. Distinct from brainQueryResult (brain memory) and
   * structuralQueryResult (CSS/graph queries).
   */
  webQueryResult?: string;
  /**
   * Startup snapshot from the brain's highlights mode (recent sessions +
   * salient notes), injected on the FIRST manager turn only — mirrors the
   * main assistant chat's one-time startup-context injection (see
   * systemPrompts.ts's opts.startupContext / assistantStore.tsx's
   * startupContextRef). Fetched by sendManagerMessage (agentsStore.tsx),
   * gated on state.managerMessages being empty.
   */
  startupContext?: string;
  /**
   * Grounded REAL briefing digest for the manager's briefing_query action,
   * injected on the follow-up turn (see runGroundedFollowUp in
   * agentsStore.tsx). Built via buildBriefingDigest (briefing.ts) from real
   * journal events — shipped, asks, learned, spent, night shift.
   */
  briefingDigestResult?: string;
  /**
   * Grounded REAL decision lookup result for the manager's decision_lookup
   * action, injected on the follow-up turn. Built via lookupDecision
   * (decisions.ts) from the project brain's decision neurons.
   */
  decisionLookupResult?: string;
  /**
   * PROMISE-STALL fix (2026-08-05 — see the module-level bug note above
   * runManagerTurn for the full repro): honest note that a grounding
   * round-trip in THIS exchange (brain_query/briefing_query/decision_lookup/
   * scan_project/query_mission/...) failed or timed out — e.g. the exact
   * text describeBrainRecallFailure (brainSearchLoop.ts) already produces
   * for a timeout, or a runGroundedFollowUp failureReason (agentsStore.tsx).
   * Rendered as its own labeled block (groundingFailureBlock,
   * buildManagerDynamicContext) that tells the model this is a REAL failure
   * — not empty results — and that it must still decide and act (or ask a
   * clarifying question) instead of quietly repeating an unactioned
   * announcement.
   *
   * INTEGRATION NOTE: this field and its prompt block are the "inject the
   * error honestly into the context" half of the promise-stall fix, fully
   * implemented here. The other half — setting this field before RETRYING
   * the continuation turn when the grounding round-trip's own LLM call fails
   * — belongs to runGroundedFollowUp's catch block (agentsStore.tsx, around
   * "grounding turn ${turnCount + 1} failed"), which currently returns
   * immediately instead of looping again. That call site is outside this
   * fix's file perimeter (managerEngine.ts + brainSearchLoop.ts only); wiring
   * it is the one remaining step to close the loop end-to-end. Until then,
   * this field is reachable by any caller that already has a grounding
   * failure string on hand (e.g. a future agentsStore.tsx change, or a
   * caller that pre-flights a grounding action itself).
   */
  groundingFailureNote?: string;
  /**
   * Real per-turn signal for the Mission Charter convergence rule (Defect 2,
   * 2026-07-28 test session: the manager proposed THREE successive charters
   * for the same mission, each restating/improving the last, never advancing
   * to propose_artifact/generate_plan). The ONLY place a charter validation
   * actually lands today is the plain-text Validate message
   * (missionCharter.ts's formatCharterValidationMessage, components/lazyManager
   * — there is no dedicated store method flipping `charterProposal.state`,
   * see that module's own INTEGRATION GAP doc comment) buried somewhere in
   * the conversation transcript; nothing told the manager, IN ITS OWN
   * STRUCTURED CONTEXT, that this had already happened, so it had no
   * reliable way to know a charter it just proposed was already settled.
   * Built by deriveCharterStatusContext (agentsStore.tsx) purely from the
   * transcript already in state.managerMessages — undefined only when no
   * charter was ever proposed in this conversation (nothing to report).
   */
  charterStatusContext?: string;
  /**
   * Real subscription/credit summary (e.g. "combien ai-je de crédits ?"),
   * built by formatCreditsSummary from the SAME shared subscription state
   * the credits KPI tile / AccountChip display (AgentsStoreProvider reads
   * useSubscriptionContext(), no second Supabase fetch). Present on every
   * turn, not follow-up-gated — unlike brain/mission/web lookups there is
   * no action round-trip to wait for, so it costs nothing extra to embed.
   */
  creditsSummary?: string;
  /**
   * STACK fix: live status of the two INDEPENDENT engine rails (a Claude
   * CLI/BYOK subscription and Lazy Pro managed credits can both be active at
   * once — see modelPickerOptions.ts's module doc comment), built by
   * formatEntitlementsSummary from the SAME detectModelEntitlements()
   * snapshot every model picker (LazyManager, New Mission, Composer) already
   * uses — no new detection. Present on every turn, same reasoning as
   * `creditsSummary` above (no action round-trip to wait for). Distinct from
   * `creditsSummary`: that block answers "how many credits", this block
   * answers "which rail(s) can actually serve a mission right now" — see the
   * Rules section (buildManagerCorePrompt) for how the manager must read the
   * two together (0 Pro credits never blocks a CLI-routed mission).
   */
  entitlementsSummary?: string;
  /**
   * Real, per-turn Brain status line — the fix for the "silent degradation"
   * QA finding: a manager running on a 0-neuron test brain answered "le
   * brain n'a rien de pertinent" every turn, never distinguishing that from
   * a real brain with nothing on-topic, and kept guessing task sizes
   * instead of flagging it. Built by formatBrainStatus (below) from a
   * BrainInfo snapshot (get_brain_info's noteCount/isEmpty — the SAME fast,
   * filesystem-only primitive assistantStore.tsx's fetchBrainIsEmpty already
   * uses) fetched by the caller (agentsStore.tsx's fetchManagerBrainInfo).
   * undefined input means the call itself failed/timed out (state:
   * unavailable) — never confused with a resolved, genuinely empty brain.
   */
  brainStatus?: string;
  /**
   * Compact real-time digest of the Agent Canvas (projects/nodes/chains/
   * drafts) — the manager's own view of the cockpit surface, spec §8.2:
   * "managerEngine.ts system prompt gains ... a compact canvas digest each
   * turn ... so the manager reasons about the real board." Built by
   * canvas/canvasDigest.ts's `buildCanvasDigest()` (the SAME serializer the
   * `canvas_overview` action's grounding reuses) and injected on EVERY
   * turn — not follow-up-gated, same reasoning as `creditsSummary` above:
   * there is no action round-trip to wait for, the real canvasStoreVanilla
   * + journal state is always available synchronously-ish (one Tauri
   * round-trip) at prompt-build time.
   */
  canvasDigest?: string;
  /** Fleet-wide runtime summary (projects, missions, budgets, orchestrators). */
  fleetContext?: string;
  /** Agent templates + orchestrators (D88 — not LazyBrain recall). */
  brainDrivenContext?: string;
  /**
   * D87 — opt-in light ambient recall. Default undefined/false: runManagerTurn
   * does not call brain.recall (perf filet). When true, a bounded-timeout
   * recall may fill brainRecall for a memory-seeking, non-trivial turn.
   */
  ambientRecallEnabled?: boolean;
  /**
   * D92 — read-only cross-project brain digest. Injected when the user
   * message looks cross-project, or when a caller already fetched it.
   */
  federatedRecallDigest?: string;
  /** Current autonomy mode and policies. */
  autonomyContext?: string;
  /** Proven + trial lessons for the active project (eval-gated retention). */
  lessonsContext?: string;
  /**
   * Current UI locale (e.g. "fr", "en", "es", "de", "ja", "zh") — the SAME
   * value useI18n() resolves every other UI string from (agentsStore.tsx
   * threads it in as a plain string here, not i18n/types.ts's Locale union,
   * so this module carries no import dependency on the i18n package — same
   * decoupling convention as CreditsSnapshot above). Round-3 QA finding: the
   * manager answered in English inside a French-locale app because no
   * per-turn signal ever told it which language the UI is actually in — see
   * buildManagerDynamicContext's localeLine and the Rules section's
   * LANGUAGE rule (buildManagerCorePrompt). Round-2026-08 QA finding: that
   * signal was then over-weighted into a hardcoded "default to French" rule
   * that answered an English-speaking user in French inside an
   * English-locale app — the LANGUAGE rule now treats this field as a
   * FALLBACK hint only; the user's own message this turn is the PRIMARY
   * signal.
   */
  locale?: string;
  /**
   * True when the Lazy Pro rail's managed credits are actually usable this
   * turn (detectModelEntitlements().pro === 'active', modelPickerOptions.ts
   * — the SAME primitive every model picker already uses, no new detection).
   * Gates whether buildManagerDynamicContext injects the compact full
   * OpenRouter catalog block (buildCompactModelCatalog) — the CLI-only rail
   * can never route to any of those ids (see UnknownManagerModelIdError's
   * 'cli' branch), so listing them there would cost tokens for zero benefit.
   * Distinct from `entitlementsSummary` (a formatted status STRING for both
   * rails) — this is a plain boolean the caller (agentsStore.tsx) already
   * has on hand from the SAME detectModelEntitlements() call.
   */
  proRailActive?: boolean;
  /**
   * The saved LazyBots (Solari cloud bots) as seen at prompt-build time —
   * built by agentsStore.tsx from listBots() + botEngine's runtime state via
   * summarizeLazyBot (botManagerContext.ts). Injected EVERY turn (a handful
   * of one-line entries, no round-trip to wait for) so the model has the
   * real "bot_..." ids in front of it and can emit run_lazybot directly,
   * without the list_lazybots → grounded follow-up dance that weaker
   * models (DeepSeek/MiniMax, live repro 2026-09-02) kept failing. Also
   * feeds the LAYER 2 repair call (so it can fill "botId") and the LAYER 3
   * deterministic LazyBot fallback (managerLazyBotFallback.ts). undefined
   * only for callers that don't supply it (tests, mainly) — the block is
   * then omitted entirely, never rendered as a fake "no bots" claim.
   */
  lazyBots?: LazyBotSummary[];
  /**
   * The current turn's raw user message text — threaded through so
   * buildManagerDynamicContext can narrow buildEccAgentCatalog's relevance
   * filter (managerEccCatalog.ts, token-efficiency wave 2026-08-01) to the
   * domain the user is actually asking about, instead of always rendering
   * every named agent group in full. Same source as brainDrivenContext's
   * userMsg.content (agentsStore.tsx already threads that one in) — no new
   * fetch, just reused for a second purpose. Undefined only for callers
   * that don't supply it (existing tests, mainly): buildEccAgentCatalog
   * treats that identically to an empty string — full detail, never
   * narrowed on missing information.
   */
  lastUserMessage?: string;
  /**
   * GOAL LOOP (founder directive — see the "GOAL LOOP" section above
   * runManagerTurn for the full rationale). Raw content (never pre-wrapped
   * with a header — buildManagerDynamicContext's goalStatusBlock adds that,
   * same convention as charterStatusContext above) for the active per-
   * conversation goal's evaluate/escalate/anti-procrastination instruction,
   * built by buildGoalStatusContext from a ConversationGoal. Set ONLY on a
   * wakeup turn for a terminal mission event (mission merged/failed) when
   * the conversation already has an ACTIVE goal — see agentsStore.tsx's
   * sendManagerMessage wiring for the exact gating. undefined on every
   * ordinary turn (no active goal, or not a qualifying wakeup) — zero
   * behavior change otherwise.
   */
  goalStatusContext?: string;
  /**
   * Compact per-mission digest of OTHER open projects (A11) — missions
   * whose id is not on the active board. Built by buildOtherProjectsDigest
   * from the existing fleet registry (globalRuntime.getSnapshot), never
   * from bots/solari. Undefined when the registry has nothing extra.
   */
  otherProjectsDigest?: string;
  /**
   * Active LazyManager conversation / session id (D91). When the model
   * emits brain_query without sessionId, runManagerTurn stamps this value
   * so recall stays scoped to the conversation the user is actually in.
   */
  conversationId?: string;
}

/** Minimal, provider-agnostic snapshot of the fields formatCreditsSummary
 *  needs — decoupled from billing/useSubscription.ts's Subscription type so
 *  this module has no runtime dependency on the billing package (only the
 *  pure billing/credits.ts formatter). Built by the caller (agentsStore.tsx)
 *  from useSubscriptionContext()'s real state. */
export interface CreditsSnapshot {
  isPro: boolean;
  status?: string;
  creditsRemainingCents?: number;
  creditsIncludedCents?: number;
  periodEnd?: string | null;
}

/** Format a real credits/subscription snapshot into the one-line summary
 *  embedded in the manager's system prompt (buildManagerSystemPrompt's
 *  creditsBlock) so "combien ai-je de crédits ?" is answered from actual
 *  account state — same formatCredits()/credits_remaining_cents source as
 *  KpiGroup.tsx/AccountChip.tsx, never a fabricated number. undefined only
 *  when no snapshot was supplied at all (a caller that deliberately opts
 *  out of threading subscription state into this turn). */
export function formatCreditsSummary(snapshot: CreditsSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  if (!snapshot.isPro || snapshot.creditsRemainingCents === undefined) {
    return 'Free plan — no managed Lazy credit balance; the user pays via their own CLI subscription or API key, not Lazy credits.';
  }
  const remaining = formatCredits(snapshot.creditsRemainingCents);
  const included = snapshot.creditsIncludedCents !== undefined
    ? ` of ${formatCredits(snapshot.creditsIncludedCents)} included`
    : '';
  const period = snapshot.periodEnd ? `, current billing period ends ${snapshot.periodEnd}` : '';
  return `Pro plan (${snapshot.status ?? 'active'}): ${remaining} credits remaining${included} this billing period${period}.`;
}

/** Format a real ModelEntitlements snapshot (detectModelEntitlements(),
 *  modelPickerOptions.ts — the SAME primitive every model picker already
 *  uses, no new detection) into the compact two-line status embedded in the
 *  manager's system prompt (buildManagerDynamicContext's entitlementsBlock).
 *  Deliberately terse (token cost, injected every turn) — the "both rails
 *  can stack, 0 Pro credits never blocks a CLI mission" EXPLANATION lives
 *  once in the static Rules section (buildManagerCorePrompt) instead of
 *  being repeated here per turn. `creditsRemainingCents` mirrors the SAME
 *  figure formatCreditsSummary reports (no second source of truth) — passed
 *  separately because ModelEntitlements itself only carries the tri-state
 *  'active'/'no-credits'/'inactive', not the amount. undefined only when no
 *  snapshot was supplied (a caller that deliberately opts out). */
export function formatEntitlementsSummary(
  entitlements: ModelEntitlements | undefined,
  creditsRemainingCents: number | undefined,
): string | undefined {
  if (!entitlements) return undefined;
  const claudeLine = `- Claude subscription (CLI/BYOK): ${entitlements.claudeSub ? 'ready' : 'not detected'}`;
  const proLine =
    entitlements.pro === 'active'
      ? `- Lazy Pro (managed credits): active, ${formatCredits(creditsRemainingCents ?? 0)} remaining`
      : entitlements.pro === 'no-credits'
        ? '- Lazy Pro (managed credits): active plan, 0 credits left'
        : '- Lazy Pro (managed credits): no active plan';
  return `${claudeLine}\n${proLine}`;
}

/** Minimal shape formatBrainStatus needs from a real BrainInfo snapshot
 *  (get_brain_info) — decoupled from platform/tauri.ts's BrainInfo so this
 *  module carries no import dependency on it (same convention as
 *  CreditsSnapshot/ModelEntitlements above). */
export interface BrainStatusInput {
  noteCount: number;
  isEmpty: boolean;
}

/**
 * Format the manager's per-turn Brain status line — the THREE real states a
 * silent-degradation QA finding proved the manager could not tell apart:
 * unavailable (the info() call itself failed/timed out — `info` is
 * undefined), NOT indexed for this project (a brain resolved but has 0
 * notes), or indexed with a real note count. Never guessed: `info` is
 * undefined only when the caller's own fetch genuinely could not reach the
 * brain, distinct from a resolved-but-empty one. See the "NEVER DEGRADE IN
 * SILENCE" rule (buildManagerCorePrompt) for how this line must be used.
 *
 * `sidecarReachable` (GRAPH/RECALL DIVERGENCE FIX): an INDEPENDENT live
 * signal — see fetchManagerBrainSidecarReachable's doc comment
 * (agentsStore.tsx) — that a real-user report proved can DISAGREE with
 * `info`: `info` is a fast, filesystem-only note count at a LOCALLY
 * recomputed path that can diverge from whatever brain the sidecar is
 * ACTUALLY serving, so `info.isEmpty`/`info === undefined` alone is not
 * proof the brain is really unreachable — the Brain space showed a live,
 * populated graph for the exact project `info` reported as unindexed. When
 * the sidecar IS reachable but `info` disagrees, this downgrades the
 * unavailable/NOT-indexed claim into an honest "unconfirmed" state that
 * tells the manager to verify with brain_query before declaring defeat or
 * recommending indexing — never silently trusts the possibly-stale local
 * count, and never silently drops the disagreement either.
 */
export function formatBrainStatus(info: BrainStatusInput | undefined, sidecarReachable?: boolean): string {
  if (!info) {
    if (sidecarReachable) {
      return 'Brain: the local index check failed, but the brain sidecar IS reachable — do not tell the user no brain exists; try a brain_query before concluding anything.';
    }
    return 'Brain: unavailable (no brain reachable right now).';
  }
  if (info.isEmpty) {
    if (sidecarReachable) {
      return 'Brain: local index reports 0 notes, but the brain sidecar IS reachable and answering — this local count may be stale or scoped to the wrong path; try a brain_query before telling the user the brain is empty or unindexed.';
    }
    return 'Brain: NOT indexed for this project (0 notes) — offer to index it.';
  }
  return `Brain: indexed, ${info.noteCount} notes for this project.`;
}

export { buildManagerCorePrompt };

/**
 * Build the DYNAMIC context block for the manager system prompt — all
 * per-turn state: current agents, missions, ECC library, credits, canvas
 * digest, fleet context, brain recall, grounded results, etc. This changes
 * every turn and must NOT be cached.
 *
 * Measured 2026-08-28: cyclomatic complexity 25. Optional blocks now go
 * through presentSection/groundedResultBlock (managerDynamicContext.ts).
 */
export function buildManagerDynamicContext(ctx: ManagerContext): string {
  const agentLines = ctx.agents.map(
    (s) => `- @${s.agent.name} (${s.scope}): ${s.agent.displayName} — ${s.agent.description.slice(0, 80)}`,
  );
  const eccCatalog = buildEccAgentCatalog(ECC_AGENTS, ctx.lastUserMessage);
  const missionLines = formatVisibleMissionLines(ctx.missions);
  const agentList = agentLines.length > 0 ? agentLines.join('\n') : '(none yet)';
  const missionList = missionLines.length > 0 ? missionLines.join('\n') : '(no missions)';

  const tail = [
    presentSection(ctx.creditsSummary, (v) => `\n\n### Account & Credits (real, from the user's subscription)\n${v}`),
    presentSection(ctx.entitlementsSummary, (v) => `\n\n### Engines (real, live — both rails below are independent and can be active at once)\n${v}`),
    presentSection(ctx.proRailActive ? buildCompactModelCatalog() : undefined, (v) => `\n\n### Pro Model Catalog (real, exact ids — set "modelId" on launch_mission/launch_best_of_n/create_loop/create_draft/spawn_submissions/generate_plan steps to target one precisely; plain tier hints still resolve within this same rail otherwise)\n${v}`),
    presentSection(ctx.lazyBots ? formatLazyBotsContext(ctx.lazyBots) : undefined, (v) => `\n\n### LazyBots (real, saved Solari cloud bots — the ONLY valid "botId" values)\n${v}\n\nThis list is already grounded: to run one of these bots, emit run_lazybot with its exact botId (its name is accepted too) IN THE SAME REPLY as your announcement — never emit list_lazybots just to find an id that is already here, and never announce "je lance le bot" without the <lazy_actions> block.`),
    groundedResultBlock('Agent Canvas (real, live board state)', ctx.canvasDigest, 'This is the REAL current state of the Agent Canvas — the cockpit surface the user is looking at. Use real refs (e.g. "mission:M12", "draft:abc-123") from this digest when emitting canvas actions (chain_agents, launch_draft, focus_canvas, move_node, unchain, collapse_project) — never invent a ref that is not listed here. When the user asks "how many nodes/elements are on the canvas", answer with the digest\'s own "Canvas total" line (sums every kind: missions/loops + drafts + notes + routers + joins + terminals/previews + frames) — never the "Nodes (N)" line alone, which counts missions/loops only and will under-report what the user actually sees on the board.'),
    groundedResultBlock('Fleet Runtime (real, all projects)', ctx.fleetContext, 'This is the REAL runtime state across all open projects — use it when the user asks about the fleet, budgets, or cross-project work.'),
    presentSection(ctx.otherProjectsDigest, (v) => `\n\n### Other projects (compact — missions not on the active board)\n${v}\nUse this when orchestrating across projects; the Current State missions list above is the ACTIVE board only.`),
    groundedResultBlock('Agent templates & orchestrators (not LazyBrain recall)', ctx.brainDrivenContext, 'Use these learned patterns and active orchestrators to inform decisions. This is NOT LazyBrain memory — emit brain_query for real recall.'),
    groundedResultBlock('Federated recall (read-only, other project brains)', ctx.federatedRecallDigest, 'These are REAL memories from OTHER project brains, labeled with provenance. Read-only — never write or overwrite them. Cite #id + source project when relevant.'),
    presentSection(buildExplicitBrainQueryNudge({
      lastUserMessage: ctx.lastUserMessage,
      brainQueryResult: ctx.brainQueryResult,
      structuralQueryResult: ctx.structuralQueryResult,
      brainRecall: ctx.brainRecall,
    }), (v) => `\n\n### Brain recall nudge\n${v}`),
    presentSection(ctx.autonomyContext, (v) => `\n\n### Autonomy Settings\n${v}`),
    groundedResultBlock('Learned Lessons (eval-gated — proven lessons improved past runs; trial lessons are candidates)', ctx.lessonsContext, 'Apply proven lessons when building generate_plan steps. If a lesson\'s pathology matches the current objective, incorporate its suggestion into the step description or add a step that addresses it.'),
    presentSection(ctx.startupContext, (v) => `\n\nRecent project context (recent sessions + salient notes):\n<brain_startup_context>\n${v}\n</brain_startup_context>`, true),
    presentSection(ctx.brainRecall, (v) => `\n\nProject brain context:\n${v}`),
    groundedResultBlock('Mission Detail (grounded — real data fetched for the user\'s last request)', ctx.missionDetail, 'This section, when present, is REAL data fetched from the mission\'s actual transcript/result — not a guess. Answer the user\'s last question now using ONLY this data. Never invent details that are not present here. Do not emit another query_mission or get_agent_output action this turn.'),
    groundedResultBlock('Brain Query Result (grounded — real memory recall for your last brain_query action)', ctx.brainQueryResult, 'This section, when present, is REAL data recalled from the project brain — not a guess. Cite facts with their #id and answer the user\'s last question now using it. Do not emit another brain_query action this turn.'),
    groundedResultBlock('Structural Recall Result (grounded — real CSS-query / graph-hop hits for your last brain_query_css / brain_neighbours action)', ctx.structuralQueryResult, 'This section, when present, is REAL data queried from the project brain — not a guess. Cite facts with their #id and answer the user\'s last question now using it. Do not emit another brain_query_css or brain_neighbours action this turn.'),
    groundedResultBlock('Web Search/Fetch Result (grounded — real web results for your last web_search / web_fetch action)', ctx.webQueryResult, 'This section, when present, is REAL data fetched from the web — not a guess. Answer the user\'s last question now using it. Do not emit another web_search or web_fetch action this turn.'),
    groundedResultBlock('Briefing Digest (grounded — real journal events for your last briefing_query action)', ctx.briefingDigestResult, 'This section, when present, is REAL data from the journal — not a guess. Summarize what happened concretely, citing mission ids and projects. Do not emit another briefing_query action this turn.'),
    groundedResultBlock('Decision Lookup Result (grounded — real brain search for your last decision_lookup action)', ctx.decisionLookupResult, 'This section, when present, is REAL data from the project brain\'s decision neurons — not a guess. Cite the decision #id and answer the user\'s last question now using it. Do not emit another decision_lookup action this turn.'),
    groundedResultBlock('Grounding Failure (honest — a lookup in this exchange failed or timed out)', ctx.groundingFailureNote, 'This is a REAL failure, not empty results. Tell the user honestly that the lookup was slow/unavailable, then still decide and act on what you already know, or ask a clarifying question. Never end your reply on an announcement ("je lance...", "I will...") without either emitting the matching <lazy_actions> block or explaining why you are not acting.'),
    presentSection(ctx.charterStatusContext, (v) => `\n\n### Mission Charter Status (grounded — real conversation state, not your own recollection)\n${v}`),
    presentSection(ctx.goalStatusContext, (v) => `\n\n### Goal Evaluation (active goal for this conversation — founder's goal-loop directive: evaluate, act, or honestly stop)\n${v}`),
  ].join('');

  const localeLine = presentSection(ctx.locale, (v) => `\nLocale (fallback hint only — the user's own message this turn takes priority): ${v}.`);
  const brainStatusLine = presentSection(ctx.brainStatus, (v) => `\n${v}`);

  return `## Current State
${localeLine}${brainStatusLine}
### Available Agents (user and project scope)
${agentList}

### Available Agents (built-in library, ${ECC_AGENTS.length} total — grouped by category below; every Content/Creative and generalist agent is named, long-tail language clusters are summarized; list_agents for the full roster)
${eccCatalog}

### Current Missions
${missionList}${tail}`;
}


export function buildManagerSystemPrompt(ctx: ManagerContext): string {
  return `${buildManagerCorePrompt()}\n\n${buildManagerDynamicContext(ctx)}`;
}

// ── Action parsing ─────────────────────────────────────────────────

/** Parse <lazy_actions>[...]</lazy_actions> from the manager response.
 *  Each parsed action is validated via validateManagerAction (per-type field
 *  checks). Actions that fail validation are dropped with a console.warn
 *  explaining the reason — never silently passed through to the executor. */
/** Try to JSON.parse `raw` as a JSON array — returns null (never throws) on
 *  a parse failure or a non-array result. Shared by every salvage attempt
 *  below so each one is a one-line try. */
function tryParseJsonArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw.trim());
    // Alias folding happens HERE, in the one parse primitive every path
    // shares (tagged block, trailing-prose salvage, bare-JSON salvage, the
    // display stripper, the parse-failure describer) — so what executes and
    // what is stripped from the bubble can never disagree about an action.
    return Array.isArray(parsed) ? parsed.map(normalizeLazyBotActionAliases) : null;
  } catch {
    return null;
  }
}

/**
 * LAYER 1 salvage (2026-08-07, DeepSeek FORMAT-compliance fix — see the
 * module comment above runManagerTurn's PROMISE-STALL guard): the block-aware
 * parse in parseLazyActionsJson below already tolerates a <lazy_actions>
 * block that is present but unclosed or closed with a typo'd tag (its own
 * trailing-prose salvage regex still finds the real array inside whatever
 * text follows the opening tag). What it cannot recover is the dominant real
 * repro — the model narrates the action in prose ("Je lance start_preview...")
 * and never opens a <lazy_actions> tag AT ALL, sometimes still emitting the
 * actions as a bare JSON array or a ```json fence out of habit. Only called
 * when the block-aware parse above found nothing — tries, in order: (1) a
 * fenced ```json array, (2) a naked `[{...}]` array anywhere in the text.
 *
 * Deliberately CONSERVATIVE, unlike parseManagerActions' own per-element
 * drop policy for a genuine <lazy_actions> block: a bare JSON blob floating
 * in prose is a much weaker signal that it was ever meant to be an actions
 * array (it could just as easily be an unrelated code sample or a JSON blob
 * the user pasted), so a candidate is accepted ONLY when EVERY element
 * already passes validateManagerAction — one bad element means the whole
 * candidate is ignored rather than guessed at partially. Returns [] when
 * nothing salvageable is found.
 */
function salvageBareActionsJson(text: string): unknown[] {
  const candidates: unknown[][] = [];

  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJsonArray(fenced[1]);
    if (parsed) candidates.push(parsed);
  }

  const naked = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (naked) {
    const parsed = tryParseJsonArray(naked[0]);
    if (parsed) candidates.push(parsed);
  }

  // Bare SINGLE-object shape (`{"type": ...}` with no array wrapper and no
  // <lazy_actions> tags) — observed live from ox alpha (free tier): it
  // half-remembers the protocol and emits one action object directly. Same
  // conservative policy as above: only accepted when it fully validates.
  // CRITICAL guard: skipped entirely when a bare ARRAY was already found
  // (even one that failed the every-element validation) — diving into that
  // array to cherry-pick a single valid element would violate the "never a
  // partial guess" contract the array path just enforced (see the LAYER 1
  // test "does NOT salvage a bare array when even ONE element fails").
  if (!naked) {
    for (const span of extractBareActionObjectSpans(text)) {
      const obj = normalizeLazyBotActionAliases(span.obj);
      if (validateManagerAction(obj).ok) candidates.push([obj]);
    }
  }

  for (const candidate of candidates) {
    if (candidate.length > 0 && candidate.every((a) => validateManagerAction(a).ok)) {
      return candidate;
    }
  }
  return [];
}

/** Extract the JSON payload of the manager's <lazy_actions> convention.
 *  Tolerant by design (BYOK-wave, non-Claude models): DeepSeek-class models
 *  sometimes forget the closing </lazy_actions> tag, or append trailing
 *  prose after the array. Handles: complete block, unclosed block (parse
 *  everything after the opening tag), and trailing-prose salvage (first
 *  complete JSON array). When no block was opened (or its content still
 *  isn't salvageable) at all, falls back to salvageBareActionsJson's
 *  conservative bare-JSON recovery (LAYER 1 fix) instead of giving up. */
function parseLazyActionsJson(text: string): unknown[] {
  const complete = text.match(/<lazy_actions>\s*([\s\S]*?)\s*<\/lazy_actions>/);
  const raw = complete
    ? complete[1].trim()
    : (text.match(/<lazy_actions>\s*([\s\S]*)$/)?.[1].trim() ?? null);
  if (raw) {
    const direct = tryParseJsonArray(raw);
    if (direct) return direct;
    const arr = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arr) {
      const salvaged = tryParseJsonArray(arr[0]);
      if (salvaged) return salvaged;
    }
  }
  // LAYER 1 fix: no <lazy_actions> wrapper found, or its content still
  // wasn't parseable — try the conservative bare-JSON salvage before
  // concluding there are zero actions.
  return salvageBareActionsJson(text);
}

const LAZYBOT_REF_ACTION_TYPES = new Set(['run_lazybot', 'stop_lazybot', 'update_lazybot']);

/**
 * Weaker models reference a bot the way a human does — `"botName": "SolariTest"`,
 * `"bot": "SolariTest"`, or even `"name"` on a run/stop/update action —
 * instead of the schema's `"botId"`. The executor resolves a NAME as well as
 * an id (resolveLazyBotRef, botManagerContext.ts), so the only thing that
 * used to make such an action fail was the field name itself: the validator
 * dropped it ("missing or non-string botId"), the retry burned a call, and
 * the bot never ran. Folds the alias into `botId` when `botId` is absent;
 * `create_lazybot` (where `name` IS the new bot's name) is untouched.
 */
function normalizeLazyBotActionAliases(a: unknown): unknown {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return a;
  const obj = a as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !LAZYBOT_REF_ACTION_TYPES.has(obj.type)) return a;
  if (typeof obj.botId === 'string' && obj.botId.length > 0) return a;
  for (const alias of ['botName', 'bot_name', 'bot', 'name', 'id'] as const) {
    const v = obj[alias];
    if (typeof v === 'string' && v.length > 0) {
      const rest: Record<string, unknown> = { ...obj };
      delete rest[alias];
      return { ...rest, botId: v };
    }
  }
  return a;
}

/**
 * Bug 2a fix (LazyManager QA, 2026-08-07, "generic nudge / no schema
 * feedback" repro): the PROMISE-STALL corrective nudge below
 * (ANNOUNCEMENT_NUDGE_MESSAGE) fires whenever a turn produces zero
 * validated actions — but that covers TWO structurally different failures
 * with the exact same static message: (1) the model announced an action in
 * prose and never opened a <lazy_actions> tag at all, and (2) the model DID
 * open the tag but its content was not valid/salvageable JSON (the "Dropped
 * malformed action" / unparseable-block case — see the module's own
 * parseManagerActions warning). Case 2 needs the model told WHAT was wrong
 * with the JSON it already tried to write, not a generic "you announced but
 * didn't act" reminder that doesn't even acknowledge the block existed.
 * Returns null for case 1 (no tag opened — nothing to diagnose) or when the
 * block DID parse (a genuine failure lies elsewhere, e.g. a per-field
 * validation miss already handled by the separate invalidReasons path in
 * runManagerTurn). Deliberately mirrors parseLazyActionsJson's own
 * tag-extraction + salvage attempts so this never reports "unparseable" for
 * a block that parseManagerActions would actually have recovered.
 */
function describeLazyActionsParseFailure(text: string): string | null {
  const complete = text.match(/<lazy_actions>\s*([\s\S]*?)\s*<\/lazy_actions>/);
  const raw = complete
    ? complete[1].trim()
    : (text.match(/<lazy_actions>\s*([\s\S]*)$/)?.[1].trim() ?? null);
  if (raw === null) return null; // no tag opened at all — not this function's case
  if (tryParseJsonArray(raw)) return null; // parses fine as-is
  const arr = raw.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arr && tryParseJsonArray(arr[0])) return null; // salvageable — not a real failure
  if (raw.length === 0) return 'the block was empty';
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? null // shouldn't reach here (tryParseJsonArray would have matched) — defensive
      : 'its content parsed as JSON but was not an array';
  } catch (err) {
    return `its content is not valid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
}

export function parseManagerActions(text: string): ManagerAction[] {
  const parsed = parseLazyActionsJson(text);
  if (parsed.length === 0) return [];

  const valid: ManagerAction[] = [];
  for (const a of parsed) {
    const result = validateManagerAction(a);
    if (result.ok) {
      valid.push(a as ManagerAction);
    } else {
      const typeStr = typeof a === 'object' && a !== null && 'type' in a
        ? String((a as Record<string, unknown>).type)
        : '(unknown)';
      const reason = (result as { ok: false; reason: string }).reason;
      console.warn(`[parseManagerActions] Dropped malformed action "${typeStr}": ${reason}`);
    }
  }
  return valid;
}

/** D91 — when the model emits brain_query without sessionId, stamp the
 *  conversation the user is actually in so recall stays scoped. Leaves an
 *  explicit sessionId untouched. */
export function stampOmittedBrainQuerySession(
  actions: ManagerAction[],
  sessionId: string | undefined,
): ManagerAction[] {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return actions;
  let changed = false;
  const next = actions.map((action) => {
    if (action.type !== 'brain_query') return action;
    if (typeof action.sessionId === 'string' && action.sessionId.length > 0) return action;
    changed = true;
    return { ...action, sessionId };
  });
  return changed ? next : actions;
}

/**
 * Mirrors salvageBareActionsJson's own conservative detection (LAYER 1 fix,
 * see its doc comment) for STRIPPING purposes: a bare (fenced or naked) JSON
 * array is only ever removed from the DISPLAY text under the EXACT same
 * condition it is extracted as real actions under — every element must
 * independently pass validateManagerAction. This keeps parseManagerActions
 * (what actually executes) and stripActionBlock/sanitizeManagerDisplayText
 * (what the user sees) in permanent agreement: nothing recognized as a real
 * action is ever left leaking as raw JSON in the bubble, and an unrelated
 * JSON-looking blob the user might be discussing (see the "never strips an
 * unrelated bare JSON blob" test) is never touched.
 */
function stripBareActionsJsonForDisplay(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJsonArray(fenced[1]);
    if (parsed && parsed.length > 0 && parsed.every((a) => validateManagerAction(a).ok)) {
      return text.replace(fenced[0], '').trim();
    }
  }
  const naked = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (naked) {
    const parsed = tryParseJsonArray(naked[0]);
    if (parsed && parsed.length > 0 && parsed.every((a) => validateManagerAction(a).ok)) {
      return text.replace(naked[0], '').trim();
    }
  }
  // Bare single-object actions (ox alpha live shape) — same validate-before-
  // strip contract as the array cases above: only a REAL action is ever
  // removed from the display text, never an unrelated JSON blob. Skipped when
  // a bare array was already found (same conservative guard as
  // salvageBareActionsJson): don't cherry-pick a valid element out of an
  // otherwise-invalid array.
  if (!naked) {
    let out = text;
    for (const span of extractBareActionObjectSpans(out)) {
      if (validateManagerAction(span.obj).ok) {
        out = out.replace(span.raw, '').trim();
      }
    }
    return out;
  }
  return text;
}

/**
 * Strip the manager's own <lazy_actions> convention from the response text
 * for display — never leaves raw JSON or a bare tag fragment visible to the
 * user, in every malformed shape the underlying provider is known to
 * produce (mirrors parseLazyActionsJson's own tolerance so a turn's ACTIONS
 * and its DISPLAY TEXT are always derived from the same read of the wrapper):
 *
 *  - a complete `<lazy_actions>...</lazy_actions>` pair (the common case);
 *  - an OPENED but unclosed block (model forgot the closing tag, or the
 *    stream was cut) — trimmed from the opening tag to the end of the text;
 *  - a CLOSING tag with the OPENING tag missing or mismatched (2026-08-12
 *    QA, real observed leak, verbatim): `[{"type": "info", "message":
 *    "..."}] </lazy_actions>` used to render as the raw JSON payload plus
 *    the stray tag, as the ENTIRE visible assistant bubble — the bare JSON
 *    array immediately preceding a stray closing tag is stripped together
 *    with the tag itself, and any closing tag left over with nothing
 *    JSON-shaped right before it is dropped on its own;
 *  - a bare JSON array of action objects with NO wrapper at all — stripped
 *    only when it actually validates as real actions (see
 *    stripBareActionsJsonForDisplay's own doc comment above).
 *
 * Idempotent: running this twice never changes the result of the first pass.
 */
export function stripActionBlock(text: string): string {
  let out = text.replace(/<lazy_actions>\s*[\s\S]*?\s*<\/lazy_actions>/g, '');
  out = out.replace(/<lazy_actions>\s*[\s\S]*$/, '');
  // Non-greedy so a stray closing tag's own JSON is matched right up to
  // ITS true end, never gobbling unrelated text spanning into a SECOND,
  // independent stray block later in the same text.
  out = out.replace(/\[\s*\{[\s\S]*?\}\s*\]\s*<\/lazy_actions>/g, '');
  // Any closing tag still left over (no JSON-shaped content immediately
  // before it) must never leak as raw markup either.
  out = out.replace(/<\/lazy_actions>/g, '');
  out = stripBareActionsJsonForDisplay(out);
  return out.trim();
}

// ── Display sanitization (B13: raw tool-call XML leaks) ─────────────
// stripActionBlock above only strips the manager's OWN <lazy_actions> JSON
// convention. It never accounted for a distinct leak class: the underlying
// CLI transport's native tool-calling XML (<function_calls>/<invoke> —
// Claude Code CLI's own function-calling protocol) rendering as visible text
// when the model emits a tool_use block outside a structured stream event
// (observed defect: the SWOT analysis overlay showed raw <function_calls>
// markup). sanitizeManagerDisplayText strips BOTH classes at the single
// choke point where responseText is produced (runManagerTurn below), so
// every manager-facing surface — chat bubbles, the analysis overlay, "Plan
// de rattrapage" (itself just a manager chat turn) — is covered for free.

/** Tag names for native tool-call XML that must never reach a manager-facing
 *  surface. Distinct from <lazy_actions> (the manager's own convention). */
const LEAKED_TOOL_CALL_TAGS = ['function_calls', 'invoke'] as const;

// stripReasoningLines (reasoning-channel `[reasoning]…` line leak) now lives
// in reasoningLeak.ts (fix/canvas-ux R10 extraction) — evaluator.ts's
// reviewer/security/judge summaries hit the exact same leak class from the
// same managed-provider raw text, so both call sites share one rule instead
// of two copies silently drifting apart. See that module's header for the
// full rationale (unchanged from this file's original doc comment).

/** Remove every complete `<tag ...>...</tag>` block for the given tag name. */
function stripCompleteTagBlocks(text: string, tag: string): string {
  return text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'), '');
}

/** Defensive: an unterminated block (stream cut off before the closing tag,
 *  e.g. hit a token limit) must not leak the raw opening tag + partial
 *  XML/JSON either — trim from the first unmatched opening tag onward. */
function stripUnclosedTrailingTag(text: string, tag: string): string {
  return text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`), '');
}

// ── P2-13/P2-14 fix: self-repeated leading narration ────────────────
// Real user test, verbatim: "Carrousel d'images ou vraie vidéo Remotion
// rendue ?Carrousel d'images ou vraie vidéo Remotion rendue ? Ça détermine
// tout le pipeline..." — the SAME opening restated, then immediately extended
// with more detail, glued together with no separator. chat.rs's own
// extract_text_from_stream_json doc comment documents the analogous leak
// class this mirrors on the raw-transport side (a CLI harness re-prompt, or
// the model's own two-pass narration, landing in the same visible text
// stream one after another) — this is the TypeScript-side backstop at the
// single choke point every manager-facing surface already flows through
// (sanitizeManagerDisplayText), so it catches the symptom regardless of
// which upstream mechanism produced it. Deliberately conservative: it only
// ever looks at the text's OWN leading edge (never mid-text, where a
// legitimately repeated short phrase is common and must never be touched),
// and only collapses an EXACT literal repeat — never a fuzzy/semantic one —
// keeping the LONGER (more complete) occurrence.
const MIN_SELF_REPEAT_CHARS = 12;

/** If `text` starts with some chunk P (at least MIN_SELF_REPEAT_CHARS long)
 *  immediately followed by that SAME chunk P again (only whitespace allowed
 *  in between), returns the text from the second occurrence onward — i.e.
 *  drops the shorter, redundant first pass and keeps the more complete
 *  second one. Returns the (trimmed) input unchanged when no such repeat is
 *  found. Tries the LONGEST possible P first so a genuine repeat is never
 *  under-collapsed. */
function collapseLeadingSelfRepeat(text: string): string {
  const trimmed = text.trim();
  const maxCut = Math.floor(trimmed.length / 2);
  for (let cut = maxCut; cut >= MIN_SELF_REPEAT_CHARS; cut--) {
    const head = trimmed.slice(0, cut);
    const rest = trimmed.slice(cut).replace(/^\s+/, '');
    if (rest.startsWith(head)) return rest;
  }
  return trimmed;
}

// ── P0-2 fix: multi-pass stutter (round 3 QA finding) ───────────────────
// Real user test, verbatim (2026-07-28): the manager's bubble contained THREE
// back-to-back formulations of the same plan, glued with NO separator
// ("...ouvre le navigateur dessus.Je me corrige — en tant que LazyManager je
// n'ai pas d'accès shell direct, seule la palette d'actions structurées
// compte. Je lance donc le chaînage : ... Je pars donc sur ce graphe : ...").
// Root cause (confirmed by tracing the assembly path): runManagerTurn's
// `for await (const chunk of streamClaudeCodeTurn(...)) { rawResponse +=
// chunk; }` (and the managed/codex branches beside it) blindly concatenates
// every `model://chunk` event the underlying CLI transport emits for a
// SINGLE turn — there is exactly one call per turn here (no internal ReAct
// loop, see this file's "standalone agent/manager turn streaming" section),
// so the duplication is not two separate LLM calls being glued (that path,
// runGroundedFollowUp, already returns only the LAST turn's text — see
// turnDisplayText in agentsStore.tsx). It is the model's OWN generated text
// for its single response literally narrating its plan more than once
// (an interrupted self-correction, "wait/actually" style), which the raw
// chunk stream then renders verbatim with no paragraph break at the seam
// (chat.rs's stream-json -> chunk-event bridge does not insert one either).
// collapseLeadingSelfRepeat above only ever catches a LITERAL repeat at the
// text's own leading edge (at most one repetition, within the first half of
// the string) — it cannot catch a repeat anywhere else, a THIRD restatement,
// or a self-correction sentence sitting between two paraphrased passes (not
// a literal copy, so no exact/prefix match exists at all). This pass adds
// the missing coverage: split the display text into sentence/paragraph
// segments (never crossing a genuinely different paragraph — see
// tokenizeSegments), then (a) drop any segment recognized as a self-
// correction/restart marker ("Je me corrige — ...") — the internal-monologue
// artifact itself must never reach the bubble — discarding everything
// accumulated before it in the same breath (it announces the prior text is
// being superseded), and (b) collapse an EXACT duplicate or prefix/superset
// pair of segments anywhere in the text down to the single most complete
// one. Deliberately conservative: segments shorter than
// MIN_DEDUP_SEGMENT_CHARS are NEVER compared (avoids false positives on
// short, generically-shared openings like "Je lance" or "M12."), and two
// segments that are merely thematically similar but not a literal
// exact/prefix match are left untouched — this is a structural guard plus a
// lightweight n-gram fingerprint (A6), not a full embedder. A 3rd paraphrase
 // that shares neither word tokens nor character trigrams can still slip
 // through; that residual needs semantic similarity, not string overlap.

/** Below this length, a segment is NEVER used for exact/prefix comparison —
 *  guards against collapsing two independent sentences that merely happen to
 *  share a short, generic opening (e.g. "Je lance" or an id like "M12."). */
const MIN_DEDUP_SEGMENT_CHARS = 20;

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenizeForOverlap(text: string): Set<string> {
  return new Set(
    normalizeForDedup(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

/** Character trigrams over alphanumerics only — catches paraphrases that swap
 *  synonyms while keeping the same phonetic/orthographic skeleton (A6). */
function charTrigramFingerprint(text: string): Set<string> {
  const compact = normalizeForDedup(text).replace(/[^a-z0-9]+/g, '');
  const grams = new Set<string>();
  if (compact.length < 3) return grams;
  for (let i = 0; i <= compact.length - 3; i++) {
    grams.add(compact.slice(i, i + 3));
  }
  return grams;
}

function jaccardOfSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

const DEDUP_JACCARD_THRESHOLD = 0.58;
/** Slightly lower than word Jaccard — trigrams are denser and more stable
 *  across synonym swaps ("actuellement" ↔ "maintenant", "via" ↔ "dans"). */
const DEDUP_TRIGRAM_THRESHOLD = 0.48;
const DEDUP_MIN_TOKENS = 3;
const DEDUP_MIN_TRIGRAMS = 8;
const DEDUP_MAX_LENGTH_RATIO = 2.2;

function mentionedMissionIds(text: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bM\d+\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) ids.add(match[0].toUpperCase());
  return ids;
}

/** True when both segments name missions and share NONE — a legitimate
 *  dual-mission restatement must never collapse into one. */
function disjointMissionMentions(a: string, b: string): boolean {
  const ia = mentionedMissionIds(a);
  const ib = mentionedMissionIds(b);
  if (ia.size === 0 || ib.size === 0) return false;
  for (const id of ia) if (ib.has(id)) return false;
  return true;
}

function nearParaphrase(a: string, b: string): boolean {
  if (disjointMissionMentions(a, b)) return false;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter > 0 && longer / shorter > DEDUP_MAX_LENGTH_RATIO) return false;
  const wa = tokenizeForOverlap(a);
  const wb = tokenizeForOverlap(b);
  const wordOverlap =
    wa.size >= DEDUP_MIN_TOKENS && wb.size >= DEDUP_MIN_TOKENS
      ? jaccardOfSets(wa, wb)
      : 0;
  if (wordOverlap >= DEDUP_JACCARD_THRESHOLD) return true;
  // A6 — second signal: character-trigram fingerprint catches a 3rd
  // paraphrase that dilutes word Jaccard below threshold by synonym swaps.
  const ta = charTrigramFingerprint(a);
  const tb = charTrigramFingerprint(b);
  if (ta.size < DEDUP_MIN_TRIGRAMS || tb.size < DEDUP_MIN_TRIGRAMS) return false;
  return jaccardOfSets(ta, tb) >= DEDUP_TRIGRAM_THRESHOLD;
}

/** Segment boundary: either one-or-more sentence-ending punctuation marks
 *  (greedily eating any trailing whitespace, including a blank line right
 *  after — e.g. ".\n\n" collapses to one boundary) OR a bare blank-line run
 *  with NO preceding punctuation (a paragraph break the model inserted
 *  between two un-punctuated restatements). Alternation order matters: the
 *  punctuation branch is tried first at each position so it always wins when
 *  applicable, leaving the blank-line branch only for the punctuation-free
 *  case. */
const SEGMENT_BOUNDARY_RE = /[.!?]+\s*|\s*\n\s*\n\s*/g;

/** A handful of curated, START-anchored self-correction/restart openers —
 *  deliberately narrow (checked at a whole segment's own leading edge only)
 *  to keep the false-positive rate near zero; extend this list from future
 *  real QA verbatims rather than broadening the match itself. */
const SELF_CORRECTION_MARKERS: readonly RegExp[] = [
  /^je me corrige\b/i,
  /^correction\s*:/i,
  /^en fait,?\s*je me (corrige|reprends|trompe)\b/i,
  /^actually,?\s*(correction|i was wrong|let me correct)\b/i,
  /^let me correct (myself|that)\b/i,
  /^i need to correct myself\b/i,
];

function isSelfCorrectionMarker(segmentText: string): boolean {
  return SELF_CORRECTION_MARKERS.some((re) => re.test(segmentText));
}

/** One sentence/paragraph unit plus the exact separator text that followed
 *  it in the source — carrying the separator alongside its own segment
 *  (rather than as a shared array) is what lets dropping a segment cleanly
 *  drop its trailing separator too, with no reconstruction-side bookkeeping. */
interface TextSegment {
  text: string;
  sepAfter: string;
}

/** Split `text` into segments at SEGMENT_BOUNDARY_RE positions. Lossless: for
 *  any segment list this produces, `segments.map(s => s.text + s.sepAfter).join('')`
 *  reconstructs the exact original string (verified by the "leaves clean
 *  text unchanged" tests below), so dropping zero segments is always a
 *  no-op. */
function tokenizeSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  SEGMENT_BOUNDARY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT_BOUNDARY_RE.exec(text))) {
    segments.push({ text: text.slice(lastIndex, match.index), sepAfter: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), sepAfter: '' });
  }
  return segments;
}

/**
 * Collapse repeated/self-corrected segments anywhere in `text` — the general
 * counterpart to collapseLeadingSelfRepeat above (see the P0-2 doc comment
 * for the full root-cause story and worked reconstruction).
 *
 * For each segment, in order:
 *  - a recognized self-correction marker (see SELF_CORRECTION_MARKERS) is
 *    NEVER shown, and discards every segment kept so far — UNLESS it is the
 *    very last segment (nothing follows to replace it with), in which case
 *    it is kept rather than leaving the user with an empty bubble.
 *  - a segment at least MIN_DEDUP_SEGMENT_CHARS long that is an EXACT match
 *    of an already-kept segment, or a SUPERSET (the already-kept one is a
 *    prefix of it), REPLACES that kept segment (the later/longer occurrence
 *    is the more complete one — see the "keep the later, more complete
 *    restatement" test below for why order matters here).
 *  - a segment that is itself a prefix of an already-kept (longer) segment
 *    adds nothing and is dropped.
 *  - anything else (below the length floor, or genuinely distinct content)
 *    is kept as-is, in order — this is what preserves the separator between
 *    two legitimately different paragraphs untouched.
 */
export function dedupeRepeatedSegments(text: string): string {
  const segments = tokenizeSegments(text);
  if (segments.length <= 1) return text;

  const kept: TextSegment[] = [];
  segments.forEach((segment, index) => {
    const trimmed = segment.text.trim();
    const isLast = index === segments.length - 1;

    if (trimmed.length > 0 && isSelfCorrectionMarker(trimmed) && !isLast) {
      kept.length = 0; // everything before this point is superseded, and the
      return;           // correction narration itself must never be shown.
    }

    if (trimmed.length < MIN_DEDUP_SEGMENT_CHARS) {
      kept.push(segment);
      return;
    }

    for (let i = 0; i < kept.length; i++) {
      const keptTrimmed = kept[i].text.trim();
      if (keptTrimmed.length < MIN_DEDUP_SEGMENT_CHARS) continue;
      if (keptTrimmed === trimmed || trimmed.startsWith(keptTrimmed)) {
        kept[i] = segment; // this occurrence is the same or more complete — supersede it.
        return;
      }
      if (keptTrimmed.startsWith(trimmed)) {
        return; // redundant prefix of an already-kept, longer segment — drop it.
      }
      if (nearParaphrase(keptTrimmed, trimmed)) {
        // A6 — later restatement always wins (a 3rd paraphrase can be
        // shorter after synonym compression; dropping it left the 2nd
        // paraphrase on screen).
        kept[i] = segment;
        return;
      }
    }
    kept.push(segment);
  });

  return kept.map((s) => s.text + s.sepAfter).join('').trim();
}

/** Strip the manager's own <lazy_actions> block AND any leaked native
 *  tool-call XML (complete or unterminated) for display. Idempotent. */
export function sanitizeManagerDisplayText(text: string): string {
  let out = stripActionBlock(text);
  for (const tag of LEAKED_TOOL_CALL_TAGS) {
    out = stripCompleteTagBlocks(out, tag);
  }
  for (const tag of LEAKED_TOOL_CALL_TAGS) {
    out = stripUnclosedTrailingTag(out, tag);
  }
  out = stripArtifactEnvelope(out);
  out = stripReasoningLines(out);
  out = collapseLeadingSelfRepeat(out);
  out = dedupeRepeatedSegments(out);
  return out.trim();
}

// ── Manager turn execution ─────────────────────────────────────────

export interface ManagerTurnOptions {
  messages: ManagerMessage[];
  context: ManagerContext;
  model: string;
  signal?: AbortSignal;
  /**
   * STACK fix (agentsStore.tsx's sendManagerMessage preflight): forces this
   * turn onto the "cli" (native CLI/BYOK) or "pro" (managed ai-proxy) rail,
   * overriding the ambient getProviderMode() read below — used ONLY for the
   * case where the ambient mode resolves to managed/pro with an empty Pro
   * wallet but a Claude CLI subscription is ready, so the manager's OWN
   * planning turn is rescued onto the CLI instead of being refused outright
   * (see agentsStore.tsx's isNativeModelReady() preflight check) or silently
   * sent to the managed proxy where it would fail for real. Deliberately a
   * MODE-level override (not a model-id/format inspection) — see the NOTE a
   * few lines below this option's consumption for why branching on the
   * model id itself was tried and reverted (BUG-6). Omitted keeps today's
   * behavior (pure getProviderMode() read).
   */
  engineOverride?: ManagerEngineChoice;
  /** Maximum number of LLM call attempts when actions fail validation (default 3). */
  maxTurns?: number;
  /**
   * C3 fix (inactivity timeout, real-log root cause): invoked once per
   * streamed fragment received from the underlying CLI/managed transport,
   * for EVERY provider branch below (claude-code, codex, managed). The
   * caller (agentsStore.tsx's createManagerCallController) uses this to
   * rearm its own per-call inactivity deadline, so a generation that is
   * genuinely progressing — just slowly, e.g. under host CPU/RAM contention
   * — is never killed by a fixed wall-clock budget as long as SOMETHING keeps
   * arriving. Never throws, never awaited — a plain synchronous hook. Omitted
   * (e.g. MissionManagerAdvice.tsx's direct, unbounded call) simply means no
   * activity is reported, which is harmless: it has no controller to rearm.
   */
  onChunk?: () => void;
  /**
   * Live UI stream: invoked with the accumulated RAW completion so far
   * after every transport fragment. The caller (sendManagerMessage) paints
   * a sanitized preview in the chat bubble instead of waiting for the
   * whole turn. Never awaited. Repair / salvage completions MUST omit this
   * so their constrained JSON never flashes in the transcript.
   */
  onPartial?: (accumulatedRaw: string) => void;
}

export interface ManagerTurnResult {
  responseText: string;
  actions: ManagerAction[];
  rawResponse: string;
  /**
   * PROMISE-STALL guard (see the section above runManagerTurn): true when
   * the user clearly asked for an action this turn (detectUserActionRequest)
   * and the raw response emitted zero <lazy_actions> without itself asking
   * the user a clarifying question back, so runManagerTurn issued ONE
   * corrective nudge (ANNOUNCEMENT_NUDGE_MESSAGE) asking the model to either
   * emit the action or explain why it isn't acting. False for every ordinary
   * turn. QUIET RECOVERY (2026-08-07): true does NOT by itself mean
   * responseText carries a visible notice anymore — a nudge that ultimately
   * recovered real actions (directly, via LAYER 1 salvage, or via the LAYER 2
   * repair call) is silent in responseText; only a TRUE failure (see
   * nudgeFailed at the call site) still prepends buildAnnouncementNudgeFailureNotice.
   * This field exists so a caller that wants to handle/log the "a nudge fired"
   * event distinctly (e.g. a dedicated journal event type) doesn't have to
   * string-match responseText. Optional (not required)
   * so every existing caller/test that already builds a ManagerTurnResult
   * literal (e.g. agentsStore.test.tsx's runManagerTurn mocks) keeps
   * type-checking unchanged — runManagerTurn itself always sets it
   * explicitly (true or false), this is only about callers/tests that
   * construct the shape independently.
   */
  announcementNudged?: boolean;
  /**
   * Set when compactTranscript actually folded older turns for this API
   * call. Callers may surface it in the UI; it is not sent back to the model.
   */
  compacted?: { foldedTurns: number; charsBefore: number; charsAfter: number };
}

/**
 * INACTIVITY budget for a SINGLE LLM call made on behalf of the manager —
 * either the main planning call (runManagerTurn) or its grounded follow-up
 * call (runGroundedFollowUp, agentsStore.tsx). Each call gets its OWN
 * AbortController armed with this deadline (see agentsStore.tsx's
 * createManagerCallController) instead of every call in an exchange sharing
 * ONE ceiling.
 *
 * P0-1 fix (real user test, 3/3 non-trivial requests failed): a composite
 * order ("write a script then have it tested", "chain a coder then a
 * reviewer", ...) makes the manager emit a query/grounding action on its
 * first turn, which triggers a SECOND full LLM call (runGroundedFollowUp).
 * Two sequential CLI cold starts (6-8s each — chat.rs) plus generation each
 * had to fit inside the SAME shared 90s window (see MANAGER_TURN_TIMEOUT_MS
 * below) that used to cover the whole exchange — any turn heavy enough to
 * need real work on both calls reliably blew through it with ZERO nodes
 * created. Each call now gets its own full 300s, so the second call is never
 * starved by however long the first one took.
 *
 * C3 fix (real-log root cause, 2026-07): this used to be a pure WALL-CLOCK
 * deadline, armed once and never touched again — a generation that was
 * genuinely progressing (real fragments arriving, just slowly) under host
 * contention (observed live: <1.5GB free RAM, 85-96% CPU with six evaluator
 * CLI processes running at once) still died at exactly 300s, while other
 * calls with a LARGER prompt finished fine once contention eased. Prompt
 * size was ruled out as the cause; only contention correlated. This budget
 * is now an INACTIVITY deadline: createManagerCallController's
 * `reportActivity()` rearms it on every streamed fragment (see
 * ManagerTurnOptions.onChunk, invoked once per chunk in every provider
 * branch of runManagerTurn below), so it only fires after this many ms with
 * NO fragment at all — a stalled/dead call, not merely a slow one. See
 * MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS below for the separate hard ceiling
 * that still bounds a call which never stops sending fragments.
 */
export const MANAGER_LLM_CALL_TIMEOUT_MS = 300_000;

/**
 * C3 fix — ABSOLUTE wall-clock ceiling for a SINGLE LLM call, independent of
 * MANAGER_LLM_CALL_TIMEOUT_MS's inactivity deadline above: even a call that
 * keeps sending fragments forever (never idle long enough to trip the
 * inactivity deadline) must still end eventually. Deliberately generous —
 * well above the inactivity budget — so it never interferes with a
 * legitimately slow-but-progressing generation under contention (the exact
 * case the inactivity fix above exists for); it only exists as a backstop
 * against a runaway/looping stream. createManagerCallController arms both
 * deadlines side by side and reports which one actually fired (see
 * ManagerCallController.getTimeoutReason), so the user-facing message can
 * honestly distinguish "no response for Ns" from "max duration reached"
 * instead of one generic timeout line for both.
 *
 * Deliberately kept BELOW MANAGER_TURN_TIMEOUT_MS (the exchange-wide
 * backstop, 600s): a per-call ceiling that could only ever be preempted by
 * the exchange-wide one would never actually fire in sendManagerMessage's
 * own flow, defeating its purpose as an independently observable safeguard
 * (and the one every OTHER direct caller of runManagerTurn without an
 * exchange-wide backstop of its own, e.g. MissionManagerAdvice.tsx, relies
 * on if it is ever wired through createManagerCallController).
 */
export const MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS = 480_000;

/**
 * Wall-clock BACKSTOP for the WHOLE manager exchange (the main call, its
 * optional grounded follow-up, and the action-execution pass between them) —
 * a safety ceiling so an exchange can never hang indefinitely even though
 * each individual LLM call is already separately bounded by
 * MANAGER_LLM_CALL_TIMEOUT_MS above. Shared by every manager entry point —
 * chat, presets, the 4 analysis-desk presets + free input, and "Plan de
 * rattrapage".
 *
 * History: B12 originally introduced this as the single, ONLY ceiling
 * (shared by both calls at once), tightened by W-MGRCREDITS from 300_000
 * (5min) to 90_000 (90s) for the single-call case. P0-1 (see
 * MANAGER_LLM_CALL_TIMEOUT_MS above) replaced "one ceiling shared by every
 * call" with "one ceiling per call" — this constant now plays a narrower,
 * purely defensive role (never fires before either per-call budget would),
 * so it is widened to comfortably outlast two sequential 300s calls plus
 * context-fetch/action-execution overhead.
 */
export const MANAGER_TURN_TIMEOUT_MS = 600_000;

// ── PROMISE-STALL guard (2026-08-05, generalized night 2) ────────────
//
// BUG (real prod repro, dozens of times overnight): the manager replies with
// PROSE that announces an action ("Je supprime M16 et je jette son
// worktree.", "Je lance list_missions pour te donner l'état réel.") but
// emits NO <lazy_actions> block at all — the turn just ends there: nothing
// executes, nothing follows up. Once one exchange contains such a turn, the
// conversation HISTORY now contains an assistant message that "announced but
// never acted" — later turns visibly imitate that pattern (4 consecutive
// unactioned announcements observed live), because the model pattern-matches
// on its own prior turns. First occurrence correlated with grounded-lookup
// failures (journal.ts's journalQuery timing out, brain recall timing out —
// see ManagerContext.groundingFailureNote above for the "inject the error
// honestly" half of this fix); the SPECIFIC mechanism that turns a slow/failed
// lookup into a silently-abandoned exchange is runGroundedFollowUp's own
// catch block (agentsStore.tsx, "grounding turn ${turnCount + 1} failed"):
// when the grounded CONTINUATION call itself fails/times out, it returns
// `responseText: turnDisplayText(currentTurn)` — the text of the LAST
// turn that completed, which on the very first grounding round is just the
// announcement-only main turn — with no corresponding action ever emitted.
// That call site is in agentsStore.tsx, outside this fix's file perimeter
// (managerEngine.ts + brainSearchLoop.ts only — see the mission this fix
// shipped under).
//
// NIGHT-2 GENERALIZATION: the guard originally fired by pattern-matching the
// MANAGER's own response against a curated ANNOUNCEMENT_MARKERS list of
// French/English commitment openers ("Je lance", "Je supprime", ...). Every
// new phrasing the model happened to use ("Je place", "J'annule", "Je passe
// au merge", "Je force les approbations", ...) was a fresh miss to patch —
// guessing how the manager might phrase a commitment is an UNBOUNDED list by
// construction, and every miss cost the user a silently-dropped turn. Fixed
// by reading the USER's request instead of guessing the manager's prose: the
// user's own message for this turn (detectUserActionRequest below) is a
// much smaller, much more reliable signal — when the user clearly asked for
// an action ("lance la mission", "supprime M16", "peux-tu merge la PR ?")
// and the reply contains ZERO <lazy_actions>, something is wrong regardless
// of how (or whether) the reply narrates what it's doing: either the action
// should have been emitted, or the manager owes the user an explicit reason
// it isn't acting. The one carve-out (isClarifyingQuestion below): a reply
// that is itself asking the user something back is a legitimate zero-action
// turn and is never nudged. What IS fully fixed here, in the one place every
// manager turn (main turn AND every grounding round — both call
// runManagerTurn) funnels through: a turn that ends with ZERO actions after
// the user clearly asked for one never reaches the caller as-is —
// runManagerTurn itself spends one extra retry forcing the model to either
// emit the action for real or explicitly say why it isn't acting, so an
// unactioned request never gets a chance to enter conversation history and
// seed the imitation pattern in the first place.

/**
 * FR/EN action-verb lemmas checked ANYWHERE in the user's message (word
 * boundary, case/diacritic-insensitive) — the primary half of
 * detectUserActionRequest below. Deliberately broader than the OLD
 * response-side ANNOUNCEMENT_MARKERS list this replaces, and — critically —
 * checked against the USER's own words instead of guessing the manager's
 * phrasing (see the module comment above): a single verb anywhere in the
 * sentence is enough to recognize an order ("lance la mission", "peux-tu
 * supprimer M2 ?", "on passe au merge"), so these are plain word-boundary
 * matches, never START-anchored. Covers imperative, infinitive AND
 * present-tense forms since French conjugates the same verb differently
 * depending on how the user addressed it ("supprime" vs "supprimer" vs "tu
 * supprimes"). Extend from real QA verbatims same as before — the "begins
 * with a verb" fallback in startsWithLikelyVerb below is what keeps this
 * list from being a single point of failure again.
 */
const USER_ACTION_VERBS: readonly string[] = [
  // FR — mission/agent lifecycle vocabulary (imperative/infinitive/present).
  'lance', 'lancer', 'lances', 'lancez',
  'supprime', 'supprimer', 'supprimes', 'supprimez',
  'ferme', 'fermer', 'fermes', 'fermez',
  'merge', 'merger', 'merges', 'mergez', 'fusionne', 'fusionner',
  'relance', 'relancer', 'relances', 'relancez',
  'refais', 'refaire', 'refaites',
  'redo', 'relaunch',
  'ex[ée]cute', 'ex[ée]cuter', 'ex[ée]cutes', 'ex[ée]cutez',
  'annule', 'annuler', 'annules', 'annulez',
  'stoppe', 'stopper', 'stoppes', 'stoppez',
  'arr[êe]te', 'arr[êe]ter', 'arr[êe]tes', 'arr[êe]tez',
  'nettoie', 'nettoyer', 'nettoies', 'nettoyez',
  'red[ée]marre', 'red[ée]marrer',
  'd[ée]marre', 'd[ée]marrer',
  'cr[ée]e', 'cr[ée]er', 'cr[ée]es',
  'ajoute', 'ajouter', 'ajoutes', 'ajoutez',
  'corrige', 'corriger', 'corriges', 'corrigez',
  'teste', 'tester', 'testes', 'testez',
  'd[ée]ploie', 'd[ée]ployer',
  'force', 'forcer', 'forces', 'forcez',
  'valide', 'valider', 'valides', 'validez',
  'approuve', 'approuver', 'approuves', 'approuvez',
  'rejette', 'rejeter', 'rejettes', 'rejetez',
  'place', 'placer', 'places', 'placez',
  'archive', 'archiver', 'archives', 'archivez',
  'tranche', 'trancher', 'tranches', 'tranchez',
  'proc[èe]de', 'proc[ée]der',
  'jette', 'jeter', 'jettes', 'jetez',
  'passe', 'passer', 'passes', 'passez',
  'reprends', 'reprendre',
  'relis', 'relire',
  // EN — imperative/base-form mirrors.
  'run', 'delete', 'launch', 'stop', 'clean', 'restart', 'execute',
  'cancel', 'close', 'merge', 'kill', 'create', 'add', 'fix', 'test',
  'deploy', 'force', 'validate', 'approve', 'reject', 'place', 'archive',
  'decide', 'proceed', 'start', 'retry', 'revert', 'rollback', 'pause',
  'resume', 'push', 'pull',
];

const USER_ACTION_VERB_RE = new RegExp(`\\b(?:${USER_ACTION_VERBS.join('|')})\\b`, 'i');

/**
 * French avoir/être auxiliary forms — used only to recognize a COMPOUND-PAST
 * construction ("l'a corrigé", "j'ai lancé", "n'a pas supprimé") immediately
 * before a USER_ACTION_VERBS match, so that match can be excluded (see
 * hasStandaloneActionVerb below). Deliberately just the auxiliary forms most
 * likely to precede a past participle in normal usage, not an exhaustive
 * avoir/être conjugation table.
 */
const COMPOUND_PAST_AUX_TOKENS: readonly string[] = [
  'ai', 'as', 'a', 'avons', 'avez', 'ont',
  'suis', 'es', 'est', 'sommes', 'êtes', 'sont',
  'avais', 'avait', 'avions', 'aviez', 'avaient',
  'étais', 'était', 'étions', 'étiez', 'étaient',
];

/** Matches when `text` ENDS with a compound-past auxiliary (optionally
 *  elided with an apostrophe, e.g. "l'a", "j'ai", "n'a") followed by an
 *  optional "pas" negation — i.e. `text` is everything BEFORE a
 *  USER_ACTION_VERBS match, and this tests whether that immediately
 *  preceding context reads as an avoir/être auxiliary rather than an
 *  imperative/infinitive subject. See hasStandaloneActionVerb's own doc
 *  comment for the real repro this exists for. */
const COMPOUND_PAST_AUX_RE = new RegExp(
  `\\b(?:${COMPOUND_PAST_AUX_TOKENS.join('|')})['’]?\\s+(?:pas\\s+)?$`,
  'i',
);

/**
 * True when `text` contains at least one USER_ACTION_VERBS match that is NOT
 * immediately preceded by a French avoir/être auxiliary — i.e. a genuine
 * imperative/infinitive/present-tense command use, not a COMPOUND-PAST
 * participle reference to something already done.
 *
 * 2026-08-16 fix (real repro, LazyManager Bug 1): "D'après ton brain, quel
 * composant capturait la molette... et quel prop l'a corrigé ?" is a pure
 * QUESTION about a past fix, not a command — but plain USER_ACTION_VERB_RE.
 * test() matched "corrige" inside "l'a corrigé" (any pipeline that drops the
 * accent — observed live via the QA driver's argv path, and plausibly for
 * any user typing without diacritics — makes "corrigé" byte-identical to the
 * imperative "corrige" already in USER_ACTION_VERBS), so
 * detectUserActionRequest returned true for an informational question.
 * runManagerTurn's PROMISE-STALL guard then fired a corrective nudge, and —
 * see runManagerTurn's retry loop — the model's own CORRECT first-turn
 * answer was discarded once the loop moved to the nudge's retry turn,
 * surfacing "[système] Aucune action exécutable..." instead of the real
 * answer. Fixed at the ROOT: a bare verb lemma immediately preceded by an
 * avoir/être auxiliary ("l'a", "j'ai", "n'a pas", ...) is a compound-past
 * reference to something already done, never an imperative — exclude it, but
 * keep scanning: a message that ALSO contains a genuine standalone imperative
 * elsewhere must still return true (never a blanket "any auxiliary anywhere
 * disables detection").
 */
/** True when the verb match is an explicit refusal ("Ne lance pas",
 *  "don't launch") rather than an order. */
function verbMatchIsNegated(text: string, matchIndex: number, matchLen: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 48), matchIndex);
  const after = text.slice(matchIndex + matchLen, matchIndex + matchLen + 28);
  if (/\bne\b/i.test(before) && /^\s+(?:pas|rien|aucune|aucun)\b/i.test(after)) return true;
  if (/\bn['’]/.test(before) && /\b(?:pas|rien)\b/i.test(after)) return true;
  if (/\b(?:don['’]?t|do not)\s+$/i.test(before)) return true;
  return false;
}

function hasStandaloneActionVerb(text: string): boolean {
  const globalVerbRe = new RegExp(USER_ACTION_VERB_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = globalVerbRe.exec(text)) !== null) {
    const before = text.slice(0, match.index);
    if (verbMatchIsNegated(text, match.index, match[0].length)) continue;
    if (!COMPOUND_PAST_AUX_RE.test(before)) return true;
    // Zero-width-safe advance (defensive — USER_ACTION_VERBS entries are
    // never empty, but a global regex with a zero-length match would
    // otherwise loop forever).
    if (match[0].length === 0) globalVerbRe.lastIndex += 1;
  }
  return false;
}

/**
 * Common non-command message openers (pronouns, articles, question words
 * used to ASK rather than order, greetings, politeness, affirmations/
 * negations) — used only by startsWithLikelyVerb's "begins with a verb"
 * fallback below, to keep it from firing on ordinary chat. Deliberately a
 * DENYLIST of what a command does NOT look like, rather than an allowlist of
 * every verb it might be — an allowlist is exactly the unbounded-list
 * failure mode this whole fix replaces (see the module comment above).
 *
 * FALSE-POSITIVE fix (2026-08-15, founder repro, real prod build): a fresh
 * conversation's ONLY message was "Réponds uniquement par OK." — the model
 * correctly replied "OK" with no <lazy_actions> block (there was nothing to
 * execute), but startsWithLikelyVerb still classified "Réponds" as an
 * imperative (it is verb-shaped and was missing from this denylist), so
 * detectUserActionRequest wrongly read the message as an action order. That
 * fired the PROMISE-STALL nudge on a turn that never needed one, which in
 * turn drove the Layer 2 repair call, which also produced nothing usable —
 * and the model's honest "OK" was discarded in favor of the "[system]
 * nothing was done" notice (see the QUIET RECOVERY responseText assembly in
 * runManagerTurn, and its own 2026-08-15 fix note, for the other half of
 * this bug: even a genuine nudgeFailed case must no longer discard real
 * text). The fix here is narrow and structural, not a one-off patch for this
 * exact sentence: verbs whose direct object is SPEECH/TEXT ("answer me",
 * "explain X", "tell me Y") ask for a conversational reply, never a system
 * action, so — like "peux-tu"/"pourrais-tu" already denylisted just above —
 * they belong in this denylist alongside the other non-command openers,
 * covering the whole class of "respond with words" imperatives rather than
 * just the one verb the founder happened to type.
 */
const NON_VERB_MESSAGE_STARTERS = new Set([
  'je', 'j', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
  'ce', 'cet', 'cette', 'ces', 'ca', 'ça',
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'l',
  'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses',
  'notre', 'nos', 'votre', 'vos', 'leur', 'leurs',
  'pourquoi', 'comment', 'quand', 'ou', 'où', 'qui', 'quoi',
  'quel', 'quelle', 'quels', 'quelles', 'combien', 'est-ce',
  'mais', 'et', 'donc', 'or', 'ni', 'car', 'si', 'parce',
  'salut', 'bonjour', 'bonsoir', 'coucou', 'merci', 'ok', 'okay',
  'oui', 'non', 'ne', 'n', 'super', 'cool', 'parfait', 'top',
  'peux', 'peux-tu', 'pourrais', 'pourrais-tu', 'stp', 'svp',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'this', 'that', 'these', 'those',
  'what', 'why', 'when', 'where', 'who', 'which', 'how',
  'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'hi', 'hello', 'hey', 'thanks', 'please', 'yes', 'no', 'great', 'awesome',
  // "Respond with words, not an action" imperatives (2026-08-15 fix above).
  'réponds', 'répond', 'répondre', 'repond', 'repondre',
  'dis', 'dites', 'dire',
  'explique', 'expliquer', 'expliques', 'expliquez',
  'raconte', 'raconter', 'racontes', 'racontez',
  'résume', 'résumer', 'résumes', 'résumez', 'resume', 'resumer',
  'décris', 'décrire', 'decris', 'decrire',
  'traduis', 'traduire', 'traduisez',
  'answer', 'reply', 'respond', 'tell', 'explain', 'describe',
  'summarize', 'summarise', 'translate', 'say',
  // Speech/restore verbs — "Continue", "Colle le livrable" ask for prose,
  // never a canvas/mission action (2026-08-31 comparatif-only false positive).
  'continue', 'continuez', 'continuer',
  'colle', 'coller', 'recolle', 'recoller',
  'ignore', 'ignorez', 'ignorer',
  'comparatif', 'comparaison', 'analyse', 'analysis', 'veille', 'livrable',
]);

/**
 * True when the FIRST word of `text` is verb-shaped by elimination: not one
 * of NON_VERB_MESSAGE_STARTERS. The generalized half of
 * detectUserActionRequest below — covers an imperative the curated
 * USER_ACTION_VERBS list doesn't happen to name ("Publie le rapport",
 * "Redéploie le worker") without needing to keep extending that list forever
 * (the exact failure mode this fix replaces — see the module comment
 * above). Deliberately conservative: only the FIRST word is inspected, so
 * this never fires on a verb buried mid-sentence (USER_ACTION_VERBS already
 * covers that case explicitly via a plain word-boundary scan).
 */
function startsWithLikelyVerb(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const trimmed = text.trim();
  if (/^don['’]?t\b/i.test(trimmed)) return false;
  const match = trimmed.toLowerCase().match(/^[a-zàâäéèêëïîôöùûüÿçœ]+/i);
  if (!match) return false;
  const firstWord = match[0];
  return firstWord.length > 1 && !NON_VERB_MESSAGE_STARTERS.has(firstWord);
}

/**
 * True when `userText` (the user's OWN message for this turn — see
 * runManagerTurn's PROMISE-STALL guard, which reads it from `messages`, the
 * unmutated original argument, never from the retry loop's own
 * `apiMessages`) reads as a clear action request — either it names a known
 * action verb anywhere (USER_ACTION_VERBS) or it simply opens on a
 * verb-shaped word (startsWithLikelyVerb). Replaces the old response-side
 * detectUnactionedAnnouncement (see the module comment above for why).
 * Exported for direct unit testing.
 */
export function isAnalysisOnlyUserText(userText: string): boolean {
  if (typeof userText !== 'string') return false;
  const trimmed = userText.trim();
  if (!trimmed) return false;
  return (
    /\b(comparatif|analyse|livrable|veille)\b/i.test(trimmed)
    && /\b(?:n['’]?impl[eé]mente|ne lance pas|ne lance aucune|sans mission|aucune mission|do not implement|don't implement|analysis only)\b/i.test(trimmed)
  );
}

export function detectUserActionRequest(userText: string): boolean {
  if (typeof userText !== 'string') return false;
  const trimmed = userText.trim();
  if (!trimmed) return false;
  if (isAnalysisOnlyUserText(trimmed)) return false;
  return hasStandaloneActionVerb(trimmed) || startsWithLikelyVerb(trimmed);
}

/** Greetings / short questions skip canvas digest + sidecar probes on the
 *  TTFT path (measured 2s+ when those ran on every "bonjour"). Action
 *  requests still get the full board even when the text is under this
 *  length — "lance M9" is 8 chars and must never skip. */
export const MANAGER_HEAVY_CONTEXT_SKIP_MAX_CHARS = 80;

const BOARD_CONTINUATION_RE = /^(ok|okay|oui|yes|vas[- ]y|go(?:\s+ahead)?|continue|continues?|go on|relance(?:[rz]? ça)?|do it)\b/i;

export function isBoardContinuation(userText: string): boolean {
  if (typeof userText !== 'string') return false;
  return BOARD_CONTINUATION_RE.test(userText.trim());
}

export function shouldSkipHeavyManagerContext(userText: string): boolean {
  if (typeof userText !== 'string') return false;
  if (isBoardContinuation(userText)) return false;
  if (isAnalysisOnlyUserText(userText)) return true;
  return !detectUserActionRequest(userText) && userText.trim().length < MANAGER_HEAVY_CONTEXT_SKIP_MAX_CHARS;
}

/** Whether this turn may wait on `brain.startupContext` (self-bounded 5s).
    Greetings skip the wait — a prewarm cache hit can still inject. The
    first action turn of a conversation still fetches if nothing was
    injected yet (so a "bonjour" opener does not starve later turns). */
export function shouldBlockOnManagerStartupContext(
  skipHeavyContext: boolean,
  alreadyInjected: boolean,
): boolean {
  return !skipHeavyContext && !alreadyInjected;
}

const COMPACT_CORE_MODEL_RE = /deepseek|llama|qwen|minimax|glm|haiku|gemma|mistral-small|phi-|gpt-4o-mini/i;

/** Wakeup turns use the same visible prefix as managerWakeup.WAKEUP_MARKER_PREFIX
 *  (🔔 ) — inlined here to avoid a managerEngine ↔ managerWakeup import cycle. */
function isWakeupFollowUpText(userText: string): boolean {
  return userText.trimStart().startsWith('\u{1F514}');
}

/** Compact the static core for weak models AND follow-up turns (ok / continue /
 *  wakeup). Greetings like "salut" on sonnet stay on the full core so the
 *  cache-control prefix (`buildManagerCorePrompt()` with no opts) is unchanged. */
export function shouldUseCompactManagerCore(model: string | undefined, userText?: string): boolean {
  if (typeof model === 'string' && COMPACT_CORE_MODEL_RE.test(model)) return true;
  if (typeof userText === 'string' && userText.length > 0) {
    if (isBoardContinuation(userText)) return true;
    if (isWakeupFollowUpText(userText)) return true;
  }
  return false;
}

/**
 * True when `text` reads as the manager asking the USER something back — a
 * legitimate reason for a zero-action turn that must never be nudged (see
 * the module comment above). A '?' anywhere is treated as "contains an
 * interrogative": simpler and far more robust across FR/EN than an
 * interrogative-word list, and a reply that asks ANYTHING back is exactly
 * the case this guard must never second-guess. Exported for direct unit
 * testing.
 */
export function isClarifyingQuestion(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed.includes('?')) return false;
  const sentences = trimmed.split(/(?<=[.!])\s+/);
  const last = (sentences[sentences.length - 1] ?? trimmed).trim();
  const stripped = last.replace(/["'\])]+$/g, '').trim();
  return stripped.endsWith('?');
}

// ── GOAL LOOP: evaluate → act → re-evaluate until the objective is reached ──
// FOUNDER DIRECTIVE (verbatim): "le LazyIDE doit être capable de lancer un
// plan, et en temps réel voir si le plan suffit ou s'il faut rajouter des
// étapes, des agents, corriger des choses jusqu'à arriver à l'objectif — il
// doit lui-même comprendre quand relancer d'autres agents jusqu'à atteindre
// l'objectif." Two real failure modes motivated this (2026-08-07 dogfood):
// (1) after a mission merges, the manager checks the aftermath ONCE on the
// wakeup turn and goes silent — the user's original goal is never
// re-pursued; (2) a goal-relevant ask dissolves into endless brain-search/
// query turns with no progress action ("procrastination by research" — the
// zero-action PROMISE-STALL guard above never fires here because actions
// ARE being emitted, just never ones that advance anything).
//
// This section is the pure, unit-testable core: capturing a goal
// (createConversationGoal), building the per-turn instruction block
// (buildGoalStatusContext — evaluation, escalation, or the anti-
// procrastination addendum), classifying an action batch as research-only
// (isResearchOnlyActionSet), and folding one evaluation turn's real result
// back into the next ConversationGoal (applyGoalEvaluationOutcome). The
// STATEFUL half — WHEN a goal is captured/evaluated, and where the record
// lives across turns — belongs to agentsStore.tsx's sendManagerMessage
// (module-level `conversationGoals` Map there — see its own doc comment for
// why this is best-effort/in-memory only, not full disk persistence).

export type ConversationGoalStatus = 'active' | 'exhausted' | 'achieved-claimed';

/** Per-conversation goal record — one active goal per conversation at a
 *  time (a fresh action-request user message REPLACES it, never merges). */
export interface ConversationGoal {
  /** The triggering user message, verbatim, truncated to
   *  GOAL_TEXT_MAX_CHARS (see the internal truncateGoalText). */
  goalText: string;
  createdAt: number;
  /** Incremented once per goal-evaluation turn that emits at least one
   *  non-research action (see applyGoalEvaluationOutcome) — capped at
   *  MAX_GOAL_EXTENSIONS, after which the NEXT evaluation turn escalates
   *  instead of evaluating again. */
  extensionsUsed: number;
  status: ConversationGoalStatus;
  /** Consecutive goal-evaluation turns whose ONLY actions were read-only/
   *  research types (READ_ONLY_ACTION_TYPES) — reset to 0 the moment an
   *  evaluation turn emits any non-research action. Drives the anti-
   *  procrastination clause in buildGoalStatusContext once it reaches
   *  RESEARCH_ONLY_STREAK_BUDGET. */
  researchOnlyStreak: number;
}

/** Hard cap on goal-evaluation turns that may advance the goal before the
 *  manager must stop and honestly report instead of trying again —
 *  exported so both the prompt text and agentsStore.tsx's gating read the
 *  SAME number. */
export const MAX_GOAL_EXTENSIONS = 5;

/** How many consecutive research-only evaluation turns are tolerated before
 *  the anti-procrastination clause is injected into the NEXT one. */
export const RESEARCH_ONLY_STREAK_BUDGET = 2;

/** A goal is a trigger sentence, never a full brief — truncated so a very
 *  long user message can never balloon every subsequent evaluation turn's
 *  prompt (same "keep it short" spirit as missionCaps.ts's caps). */
export const GOAL_TEXT_MAX_CHARS = 500;

/** Read-only/research action types (brain/search/query/scan lookups — see
 *  managerActionValidator.ts's KNOWN_ACTION_TYPES for the full catalog):
 *  these gather information but never advance a goal on their own. Kept
 *  deliberately small and literal to the founder's own "brain/search/
 *  query/scan" naming heuristic — NOT the broader "safe to auto-execute
 *  during a pending proposal" set (agentsStore.tsx's PROPOSAL_SAFE_ACTIONS),
 *  which also includes real progress actions like generate_plan/set_budget
 *  on a different axis entirely (safe-to-run-early, not read-only). */
export const READ_ONLY_ACTION_TYPES: ReadonlySet<string> = new Set([
  'brain_query',
  'brain_query_css',
  'brain_neighbours',
  'web_search',
  'web_fetch',
  'query_mission',
  'get_agent_output',
  'scan_project',
  'briefing_query',
  'decision_lookup',
  'list_agents',
  'list_missions',
  'canvas_overview',
]);

/** True when `actions` is non-empty and EVERY action is a read-only/
 *  research type — the "procrastination by research" signature: actions ARE
 *  being emitted (so the zero-action PROMISE-STALL guard never fires), but
 *  none of them advance the goal. An EMPTY action list is deliberately NOT
 *  research-only — that is the separate "achieved" heuristic, see
 *  applyGoalEvaluationOutcome below. */
export function isResearchOnlyActionSet(actions: readonly ManagerAction[]): boolean {
  return actions.length > 0 && actions.every((a) => READ_ONLY_ACTION_TYPES.has(a.type));
}

function truncateGoalText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > GOAL_TEXT_MAX_CHARS ? `${trimmed.slice(0, GOAL_TEXT_MAX_CHARS)}…` : trimmed;
}

/** Fresh goal record for a just-detected action-request user message — see
 *  agentsStore.tsx's sendManagerMessage for the detectUserActionRequest
 *  gating this is paired with. Always status 'active', always a clean 0/0
 *  budget — capturing a new goal REPLACES whatever was tracked before. */
export function createConversationGoal(userText: string, nowMs: number): ConversationGoal {
  return {
    goalText: truncateGoalText(userText),
    createdAt: nowMs,
    extensionsUsed: 0,
    status: 'active',
    researchOnlyStreak: 0,
  };
}

/** Builds the RAW content (no header — buildManagerDynamicContext's
 *  goalStatusBlock adds that, same convention as charterStatusContext) for
 *  the active goal's per-turn instruction: the evaluate/act/re-evaluate
 *  block, or — once the budget is exhausted — the honest-report-and-stop
 *  escalation instead, optionally with the anti-procrastination addendum
 *  appended. English throughout (consistent with every other programmatic
 *  prompt block in this file, e.g. ANNOUNCEMENT_NUDGE_MESSAGE below) — the
 *  model still answers the USER in their own locale via the separate
 *  LANGUAGE rule (buildManagerCorePrompt) / locale block. */
export function buildGoalStatusContext(input: {
  goal: ConversationGoal;
  /** true when goal.extensionsUsed had already reached MAX_GOAL_EXTENSIONS
   *  BEFORE this turn started (agentsStore.tsx checks this while building
   *  the turn's context, i.e. based on the outcome of the PREVIOUS
   *  evaluation turn). */
  budgetExhausted: boolean;
  /** true when goal.researchOnlyStreak >= RESEARCH_ONLY_STREAK_BUDGET. */
  researchBudgetExhausted: boolean;
}): string {
  const { goal, budgetExhausted, researchBudgetExhausted } = input;
  if (budgetExhausted) {
    return (
      `Active goal: "${goal.goalText}"\n` +
      `You have used all ${MAX_GOAL_EXTENSIONS} extensions available for this goal. ` +
      'Honestly report status now: what was done so far, what remains, and why you ' +
      'are stopping. Do not launch or plan any further action for this goal — this ' +
      'is a final report, not another attempt.'
    );
  }
  const remaining = Math.max(0, MAX_GOAL_EXTENSIONS - goal.extensionsUsed);
  const base =
    `Active goal: "${goal.goalText}"\n` +
    'Evaluate: is this goal now FULLY achieved with concrete evidence? If yes, emit ' +
    'a final report message stating the evidence and no further action. If no, emit ' +
    'the SINGLE next concrete action (mission/step/fix) that most advances the goal ' +
    `— never just research. You have ${remaining} extension(s) left.`;
  return researchBudgetExhausted
    ? `${base}\n\nResearch budget exhausted for this goal — your next reply MUST include a non-research action or an honest final report.`
    : base;
}

export type GoalEvaluationOutcomeKind = 'exhausted' | 'achieved-claimed' | 'research-streak' | 'advanced';

export interface GoalEvaluationOutcome {
  kind: GoalEvaluationOutcomeKind;
  goal: ConversationGoal;
}

/**
 * Folds one goal-evaluation turn's REAL result (the actions it actually
 * emitted) into the next ConversationGoal — pure, so the full budget/
 * escalation/anti-procrastination state machine is unit-testable with no
 * LLM call. Call ONLY for a turn that buildGoalStatusContext was actually
 * built for (agentsStore.tsx's own gating) — never on an ordinary turn.
 *
 *  - `wasBudgetExhausted` true (the escalation instruction was the one
 *    injected this turn): the goal is DONE regardless of what the model
 *    emitted — 'exhausted' is terminal, extensionsUsed is left as-is.
 *  - zero actions: the "achieved" heuristic (keep it simple/observable per
 *    the founder brief — no action + a real evaluation turn just ran means
 *    the model is claiming the goal is done, not silently stalling; the
 *    OTHER zero-action case, a genuine stall, is already covered by the
 *    unrelated PROMISE-STALL guard elsewhere in this file). Terminal.
 *  - every action is read-only/research (isResearchOnlyActionSet): bump the
 *    streak, never the budget — "just research" never counts as progress.
 *    Status stays 'active'.
 *  - anything else (at least one non-research action): spends one extension
 *    and resets the research streak — this IS progress. Status stays
 *    'active' (the CALLER checks extensionsUsed >= MAX_GOAL_EXTENSIONS
 *    before the NEXT evaluation turn to decide whether to escalate instead).
 */
export function applyGoalEvaluationOutcome(input: {
  goal: ConversationGoal;
  wasBudgetExhausted: boolean;
  actionsThisTurn: readonly ManagerAction[];
}): GoalEvaluationOutcome {
  const { goal, wasBudgetExhausted, actionsThisTurn } = input;
  if (wasBudgetExhausted) {
    return { kind: 'exhausted', goal: { ...goal, status: 'exhausted' } };
  }
  if (actionsThisTurn.length === 0) {
    return { kind: 'achieved-claimed', goal: { ...goal, status: 'achieved-claimed' } };
  }
  if (isResearchOnlyActionSet(actionsThisTurn)) {
    return { kind: 'research-streak', goal: { ...goal, researchOnlyStreak: goal.researchOnlyStreak + 1 } };
  }
  return {
    kind: 'advanced',
    goal: { ...goal, extensionsUsed: goal.extensionsUsed + 1, researchOnlyStreak: 0 },
  };
}

function truncateForGoalNotice(text: string, maxChars = 80): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

/** First non-empty line of the model's own response, truncated — used as
 *  the "evidence" one-liner in buildGoalAchievedNotice. Never fabricated:
 *  it is literally the model's own claim, just trimmed for display. */
function firstResponseLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return truncateForGoalNotice(line, 140);
}

/** Short, user-visible notice prepended to the assistant's reply when a
 *  goal is first captured/refreshed — same FR/EN-by-locale, `[tag]`-prefixed
 *  convention as buildAnnouncementNudgeFailureNotice below. */
export function buildGoalTrackedNotice(goalText: string, locale: string | undefined): string {
  const short = truncateForGoalNotice(goalText);
  return locale?.toLowerCase().startsWith('fr')
    ? `[objectif] Suivi activé : « ${short} »`
    : `[goal] Tracking enabled: "${short}"`;
}

/** `responseText` is the model's OWN reply for the turn that just claimed
 *  the goal achieved (zero actions — see applyGoalEvaluationOutcome's
 *  'achieved-claimed' branch) — its first line is used as the evidence
 *  one-liner so the notice never invents evidence the model didn't state. */
export function buildGoalAchievedNotice(responseText: string, locale: string | undefined): string {
  const evidence = firstResponseLine(responseText);
  return locale?.toLowerCase().startsWith('fr')
    ? `[objectif] Atteint — ${evidence}`
    : `[goal] Achieved — ${evidence}`;
}

export function buildGoalExhaustedNotice(locale: string | undefined): string {
  return locale?.toLowerCase().startsWith('fr')
    ? '[objectif] Budget épuisé — rapport final ci-dessous.'
    : '[goal] Budget exhausted — final report below.';
}

/**
 * Corrective message appended to the conversation when the PROMISE-STALL
 * guard fires. English, matching every other programmatic correction message
 * in this loop (see the malformed-action retry message below it) — this
 * message talks to the MODEL about its own missing action block; the
 * LANGUAGE rule (buildManagerCorePrompt) already tells it which locale to
 * answer the USER in, independently of this.
 */
// BUG 1a fix (dogfood 2026-08-05, real repro with DeepSeek as manager model,
// reproduced 3x): a weaker model kept responding in prose even after this
// nudge, because the ORIGINAL wording only described the required shape in
// English prose — it never showed one. Now includes a concrete, minimal,
// REAL example lifted straight from managerActionValidator.ts's own
// `archive_mission` validator (`requireString(a, 'missionId')` — the
// simplest non-trivial action shape in the whole map) so a model that
// doesn't reliably follow prose instructions still has a literal template to
// copy the syntax from. The honest-refusal escape hatch sentence is
// unchanged — this fix is about compliance, never about forcing an action
// that genuinely should not happen.
export const ANNOUNCEMENT_NUDGE_MESSAGE =
  'Your previous reply announced an action in prose (e.g. "Je supprime...", ' +
  '"I will run...", "Je lance le bot...") but emitted no <lazy_actions> block at all — nothing ' +
  'actually happened. Now either emit the corresponding <lazy_actions> block ' +
  'for real — exactly this shape, adapted to your own announced action, e.g.: ' +
  '<lazy_actions>[{"type":"archive_mission","missionId":"M12"}]</lazy_actions> ' +
  'or a LazyBot Solari run: ' +
  '<lazy_actions>[{"type":"run_lazybot","botId":"bot_...","task":"..."}]</lazy_actions> ' +
  'or a local code agent: ' +
  '<lazy_actions>[{"type":"launch_mission","task":"..."}]</lazy_actions> ' +
  '— or state explicitly and honestly why you are not acting. Do not ' +
  'repeat an announcement without doing one of these two things.';

/**
 * BUG 1b fix (dogfood 2026-08-05), scope narrowed by QUIET RECOVERY
 * (2026-08-07): the ONLY user-visible notice the PROMISE-STALL guard ever
 * shows now (see the responseText assembly at the end of runManagerTurn) —
 * a "corrective retry was requested" notice used to precede this
 * unconditionally whenever a nudge fired, even when the retry (or LAYER 1
 * salvage, or the LAYER 2 repair call) went on to recover real actions; the
 * founder saw 8+ such messages in one conversation, each one flagging a
 * "problem" already fixed by the time it was read. This notice alone now
 * carries the FULL signal: shown ONLY when the nudge fired AND the
 * post-nudge reply still produced zero validated actions AND that reply is
 * not itself a clarifying question (isClarifyingQuestion) — never on an
 * honest "I'm not doing X because Y" refusal read as a question, and never
 * on any path (direct, salvaged, or repaired) that ends with real actions.
 * Picks French/English from the same per-turn `locale` signal
 * buildManagerDynamicContext's localeBlock already reads
 * (ManagerContext.locale) — defaults to English for every other locale
 * rather than guessing a translation for it.
 */
function buildAnnouncementNudgeFailureNotice(locale: string | undefined): string {
  return locale?.toLowerCase().startsWith('fr')
    ? "[système] Aucune action exécutable n'a été émise — rien n'a été fait. Reformule ta demande, ou utilise les boutons « Stoppe tout » et « Nettoyer » qui agissent directement."
    : '[system] No executable action was emitted — nothing was done. Rephrase your request, or use the "Stop all" / "Clean up" buttons which act directly.';
}

// ── LAYER 2 — action-extraction repair call (2026-08-07) ────────────────
//
// BUG (founder-reported, real repro ~10x one night with DeepSeek as the
// manager model): the ANNOUNCEMENT_NUDGE_MESSAGE retry above is ONE
// corrective attempt — real dogfood shows a weaker model still answers in
// prose roughly 60% of the time even after being shown the exact
// <lazy_actions> shape to copy. buildAnnouncementNudgeFailureNotice above is
// the honest outcome for that case — truthful, but useless: the user's
// original request still never executes. This is a FORMAT-compliance
// weakness (the model already decided WHAT to do — it says so in plain
// language — it just doesn't reliably wrap it in the required JSON
// envelope), not a case where the model declined to act. Rather than a THIRD
// attempt at getting the SAME model to follow the convention in normal
// conversation (which already failed twice), this makes ONE short,
// narrowly-scoped completion whose ONLY job is translating the already-
// announced prose into the machine-actionable block.

/**
 * Compact action catalog for the repair call below — deliberately NOT
 * buildManagerCorePrompt's full "### Action Types" section (~112k chars of
 * doctrine, worked examples, and cross-references): the repair call is a
 * short, constrained completion whose only job is emitting a valid
 * <lazy_actions> array, so it only needs type names + required fields.
 * Names are drawn from KNOWN_ACTION_TYPES (managerActionValidator.ts) so
 * this can never silently drift out of sync with what validateManagerAction
 * actually accepts — a type missing from this list would still just fail
 * validation again on the repair call's own output, never a crash. Required-
 * field hints are a hand-maintained SUBSET covering the actions most likely
 * to be the target of an announced-but-unexecuted intention; a type with no
 * hint below still appears by name only.
 */
const ACTION_REQUIRED_FIELDS_HINT: Readonly<Record<string, string>> = {
  info: '{"message":"..."}',
  launch_mission: '{"task":"..."}',
  create_draft: '{"task":"..."}',
  launch_best_of_n: '{"task":"...","n":3}',
  create_loop: '{"task":"..."}',
  pause_loop: '{"loopId":"M12"}',
  delete_loop: '{"loopId":"M12"}',
  stop_mission: '{"missionId":"M12"}',
  stop_all: '{}',
  retry_mission: '{"missionId":"M12"}',
  delete_mission: '{"missionId":"M12"}',
  archive_mission: '{"missionId":"M12"}',
  clone_mission: '{"missionId":"M12"}',
  query_mission: '{"missionId":"M12"}',
  get_agent_output: '{"missionId":"M12"}',
  quote_mission: '{"task":"..."}',
  revert_mission: '{"missionId":"M12"}',
  reassign_agent: '{"missionId":"M12","model":"opus"}',
  answer_question: '{"missionId":"M12","answer":"..."}',
  approve_mission: '{"missionId":"M12"}',
  reject_mission: '{"missionId":"M12","feedback":"..."}',
  brain_query: '{"query":"..."}',
  brain_query_css: '{"selector":"..."}',
  brain_neighbours: '{"id":"..."}',
  web_search: '{"query":"..."}',
  web_fetch: '{"url":"..."}',
  scan_project: '{}',
  list_agents: '{}',
  list_missions: '{}',
  chain_agents: '{"target":{...}}',
  focus_canvas: '{"ref":"mission:M12"}',
  clear_canvas: '{"scope":"..."}',
  open_project: '{"path":"..."}',
  create_project: '{"path":"..."}',
  set_budget: '{"limitUsd":5}',
  // LazyBots (A3) — one-line schemas, same format as every other entry above.
  create_lazybot: '{"name":"bot-name","systemPrompt":"...","profileIds":["prof_..."],"routines":[{"name":"...","schedule":"0 9 * * 1-5","task":"...","enabled":true}],"avatar":"...","budgetCapUsd":5}',
  update_lazybot: '{"botId":"bot_...","patch":{"profileIds":["prof_..."],"routines":[...],"avatar":"...","budgetCapUsd":5}}',
  run_lazybot: '{"botId":"bot_...","task":"..."}',
  stop_lazybot: '{"botId":"bot_..."}',
  list_lazybots: '{}',
};

/** Builds the "type — required fields" excerpt from KNOWN_ACTION_TYPES +
 *  ACTION_REQUIRED_FIELDS_HINT above. See ACTION_REQUIRED_FIELDS_HINT's own
 *  doc comment for why this stays in sync with the real validator map. */
function buildCompactActionCatalog(): string {
  return KNOWN_ACTION_TYPES.map((type) => {
    const hint = ACTION_REQUIRED_FIELDS_HINT[type];
    return hint ? `- ${type} ${hint}` : `- ${type}`;
  }).join('\n');
}

/** System prompt for the Layer 2 repair call — exact wording per the fix's
 *  spec, plus the compact catalog excerpt above. Never the full core prompt. */
function buildActionExtractionRepairSystemPrompt(lazyBots: readonly LazyBotSummary[] | undefined): string {
  // LazyBot ids (2026-09-02): run_lazybot/stop_lazybot need a REAL "bot_..."
  // id that the announced prose never spells out ("Je lance SolariTest sur
  // example.com") — without this excerpt the repair call could only ever
  // invent an id or give up. Same rendering the main prompt uses.
  const botsHint = lazyBots && lazyBots.length > 0
    ? `\n\nKnown LazyBots (Solari cloud bots — use these EXACT ids as "botId"; a bot named in the text maps to its id here):\n${formatLazyBotsContext(lazyBots)}`
    : '';
  return (
    'You convert assistant intentions into a machine-actionable block. Output ONLY a ' +
    '<lazy_actions>[...]</lazy_actions> block translating the concrete actions the text ' +
    'announces, using ONLY action types that exist in the catalog excerpt below. No prose. ' +
    'If no concrete executable action is announced, output <lazy_actions>[]</lazy_actions>.\n\n' +
    `Action catalog (type — required fields):\n${buildCompactActionCatalog()}${botsHint}`
  );
}

/** The repair call's single user turn: the model's own announced prose,
 *  preceded by the user's request when one is available — the "task" field
 *  of a run_lazybot/launch_mission is the USER's ask, which the announcement
 *  alone often paraphrases away ("Je lance le bot" says nothing about
 *  example.com). */
function buildActionExtractionRepairUserContent(announcedText: string, userRequest: string | undefined): string {
  const request = typeof userRequest === 'string' ? userRequest.trim() : '';
  if (request.length === 0) return announcedText;
  return `User request:\n${request.slice(0, 4000)}\n\nAssistant reply (announced intentions to translate):\n${announcedText}`;
}

async function attemptActionExtractionRepair(
  announcedText: string,
  mode: ProviderMode,
  model: string,
  signal: AbortSignal | undefined,
  onChunk: (() => void) | undefined,
  hints: { lazyBots?: readonly LazyBotSummary[]; userRequest?: string } = {},
): Promise<ManagerAction[]> {
  const repairMessages: ManagerMessage[] = [
    {
      id: createMessageId(),
      role: 'user',
      content: buildActionExtractionRepairUserContent(announcedText, hints.userRequest),
      timestamp: new Date().toISOString(),
    },
  ];
  try {
    const rawRepair = await streamManagerCompletion({
      mode,
      model,
      system: buildActionExtractionRepairSystemPrompt(hints.lazyBots),
      appendRecallTeaching: false,
      apiMessages: repairMessages,
      signal,
      onChunk,
    });
    return parseManagerActions(rawRepair);
  } catch (err) {
    // Never silently swallowed — same dev-visible-warning convention as
    // parseManagerActions' own dropped-action warning above. The USER-facing
    // outcome is still the existing honest failure notice (see the
    // nudgeFailed/repairRecovered handling at the call site); this is purely
    // for developers diagnosing why a repair attempt did not recover.
    console.warn(`[attemptActionExtractionRepair] repair call failed: ${String(err)}`);
    return [];
  }
}

/**
 * Beyond this many actual LLM completions already spent in the main retry
 * loop, the Layer 2 repair call is skipped entirely rather than adding a 4th
 * — respects the same cost-conscious spirit as `maxTurns` itself (see
 * runManagerTurn's own budget doc comments below): the ordinary nudge
 * scenario (1 initial call + 1 nudge retry = 2) still affords the repair
 * call as a 3rd.
 *
 * Bug 2b fix (LazyManager QA, 2026-08-07, "contradictory outcome" repro):
 * this used to be 2, which meant a turn that ALSO burned a per-field
 * validation retry BEFORE ever reaching the announcement nudge (a fully
 * ordinary sequence — turn0 malformed action gets a validation retry, turn1
 * still emits nothing usable and trips the nudge, turn2 is the nudge retry
 * itself = 3 calls) skipped the repair call entirely, at EXACTLY the point
 * where the model's own uncorrected prose ("I'll stop and permanently
 * delete M72") was left standing next to the honest "nothing was done"
 * notice — the reported contradiction. Raised to 3 (== the default
 * `maxTurns`) so this ordinary within-budget sequence still gets the repair
 * attempt instead of silently downgrading to the notice-only outcome; a
 * turn with a HIGHER `maxTurns` than 3 can still exhaust this budget before
 * its last retry, same intentional backstop as before, just no longer
 * tripped by the common 3-call path.
 */
const MAX_LLM_CALLS_BEFORE_REPAIR_SKIPPED = 6;

/** Run a single manager turn: send conversation + context, get response + actions.
 *  When the LLM emits actions that fail structural validation, up to `maxTurns`
 *  retry calls are made with a correction message appended so the model can
 *  fix and re-emit the <lazy_actions> block. PROMISE-STALL guard (see the
 *  section above): when the user clearly asked for an action
 *  (detectUserActionRequest) but a reply emits ZERO actions and is not
 *  itself a clarifying question (isClarifyingQuestion), ONE additional retry
 *  is spent forcing the model to act for real or explain itself — never a
 *  second nudge in the same call, so a model that keeps refusing to act still
 *  converges to an honest final answer within the existing `maxTurns` budget. */
export async function runManagerTurn(opts: ManagerTurnOptions): Promise<ManagerTurnResult> {
  const { messages, context, model, signal, engineOverride, maxTurns = 3, onChunk, onPartial } = opts;

  // REMOVED (2026-07-28 perf/architecture audit — founder call): this used to
  // run an UNCONDITIONAL ambient brain.recall(lastUserMsg.content) here on
  // EVERY manager turn, before the model ever asked for anything, keyed off
  // the raw last user message (not a distilled topic — worse recall than the
  // explicit action below gets). Measured cost on a realistic brain (5488
  // notes): a typical natural-language turn (3-15 tokens) routes to
  // L2_L3_HYBRID (see engine/src/retrieval/router.ts's pickLevel) via a
  // route(..., hydrateNote:true) call, which unconditionally re-reads +
  // JSON.parses the full backlinks.json on every call (engine/src/graph/
  // backlinks.ts's loadBacklinks — measured ~44MB / ~1.6s cold on this brain,
  // no in-memory cache) PLUS the L3 embedding path — real, non-trivial
  // latency and CPU paid on literally every reply, including "ok"/"merci"/
  // one-word turns.
  //
  // The manager already has an equivalent, STRICTLY BETTER mechanism: the
  // Brain-First Doctrine below mandates brain_query/brain_query_css/
  // brain_neighbours explicitly, with a model-extracted topic query (not the
  // raw sentence) and a grounded follow-up turn that tells the model to cite
  // and answer from real results (buildManagerDynamicContext's
  // brainQueryBlock/structuralQueryBlock) — the ambient block above had no
  // such framing at all, so its content was easy to ignore, which matches
  // the QA observation that the manager routinely said the brain "had
  // nothing relevant" turn after turn. Paying for a full engine search on
  // every turn to produce a block the model wasn't reliably using is pure
  // waste, and on any turn where the model ALSO emitted brain_query itself
  // it meant paying for the search TWICE. See buildManagerCorePrompt's
  // "## Memory" section for the explicit "no ambient recall — call it
  // yourself" doctrine line this removal required.
  //
  // ManagerContext.brainRecall stays as a pass-through field (existing tests/
  // callers can still supply it directly) — `context` is passed through
  // unmodified below, so it renders only if a caller explicitly sets it.

  // Prompt-caching wave (chantier 2 — stop retransmitting the ~73k-char
  // static core every turn): built as two separate pieces instead of via
  // buildManagerSystemPrompt's single-string convenience wrapper, so the
  // managed branch below can hand the STATIC `core` to streamManagedAgentTurn
  // as a cache_control-eligible block, never re-sent verbatim through
  // buildManagerSystemPrompt's flattening. `system` is reconstructed here
  // exactly as buildManagerSystemPrompt would (core + '\n\n' + dynamic) —
  // still used as-is by the claude-code/codex branches, which have no
  // block-level caching mechanism of their own.
  const lastUserMessageContentEarly = String(
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
  );
  const contextForTurn = await enrichManagerContextForTurn(context, lastUserMessageContentEarly, {
    federated: maybeFederatedRecallForManager,
  });
  const core = buildManagerCorePrompt({
    compact: shouldUseCompactManagerCore(model, lastUserMessageContentEarly),
  });
  const dynamicContext = buildManagerDynamicContext(contextForTurn);
  const system = `${core}\n\n${dynamicContext}`;

  const compacted = compactTranscriptWithMeta(
    messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
  );
  const apiMessages: ManagerMessage[] = compacted.messages;

  // PROMISE-STALL guard (generalized, night 2) — the user's OWN request for
  // this turn, read ONCE here from `messages` (the unmutated original
  // argument) rather than re-derived inside the retry loop below: unlike
  // `apiMessages`, `messages` is never appended to by the retry machinery
  // (ANNOUNCEMENT_NUDGE_MESSAGE / malformed-action corrections), so this
  // always reflects what the user actually asked, never a synthetic
  // follow-up message. See detectUserActionRequest's own doc comment.
  //
  // Prod crash fix (2026-08-05): a grounded/continuation turn can carry NO
  // user-role message at all (.find returns undefined), and even a FOUND
  // message's `.content` is not guaranteed to be a real string at runtime
  // despite ManagerMessage's static type (e.g. a synthetic/malformed
  // message built elsewhere). String(... ?? '') coerces either case to a
  // safe empty/plain string instead of leaking `undefined` (or a non-string)
  // into detectUserActionRequest/isClarifyingQuestion below — those two are
  // now defensive on their own too (defense in depth), but the fallback
  // belongs here, at the point where the value is actually produced.
  const lastUserMessageContent = String(
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
  );

  // Phase 1: multi-turn retry loop with validation
  let rawResponse = '';
  let actions: ManagerAction[] = [];
  // PROMISE-STALL guard state (see the section above runManagerTurn): at
  // most ONE corrective nudge per call — never two in a row, even across
  // several zero-action turns, so a model that keeps refusing to act still
  // converges to an honest final answer instead of burning the whole
  // maxTurns budget meant for malformed-action correction on repeated nudges.
  let announcementNudged = false;
  // LAYER 2 budget tracking (see MAX_LLM_CALLS_BEFORE_REPAIR_SKIPPED's own
  // doc comment): counts every real LLM completion made in the loop below,
  // and remembers the LAST resolved routing mode so the repair call (issued
  // AFTER this loop, if at all) can reuse the exact same engine/model path
  // instead of re-deriving it.
  let llmCallCount = 0;
  let lastResolvedMode: ProviderMode | undefined;

  for (let turn = 0; turn < maxTurns; turn++) {
    // No reset needed: streamManagerCompletion() below assigns rawResponse
    // unconditionally on entry, and the catch rethrows out of the loop.
    try {
      // NOTE (BUG-6, plan conflict — deliberately NOT applied): a prior
      // remediation attempt proposed branching on classifyMissionModel(model)
      // here so an explicitly-selected native id always routes to
      // streamClaudeCodeTurn, regardless of the global provider mode. That
      // directly reverts the F1 regression fix below (toManagedModelId) and
      // the six dedicated tests guarding it ("managed mode normalizes a
      // native-id model selection to a valid OpenRouter id — the 'Modèle non
      // supporté' bug this fixes", etc.): those establish that a native id or
      // bare tier word picked while mode is 'managed'/'pro' MUST still
      // normalize and route to managed — the exact scenario BUG-6 assumed was
      // broken is actually already handled by design. Branching on the MODEL
      // STRING'S FORMAT stays reverted (unchanged) to avoid reintroducing
      // "ManagedUnavailableError: Modèle non supporté".
      //
      // engineOverride below is a DIFFERENT, narrower lever — a MODE-level
      // override the caller passes explicitly (agentsStore.tsx's sendManagerMessage
      // preflight, STACK fix), never derived by inspecting `model`'s format.
      // It only ever fires for the one case that preflight already proved safe
      // (managed/pro mode, empty Pro wallet, native CLI ready) and leaves every
      // other turn's mode resolution — including every BUG-6-guarded scenario
      // above, none of which pass engineOverride — byte-for-byte unchanged.
      const mode = resolveManagerTurnMode(getProviderMode(), engineOverride, nativeEngineMode());
      lastResolvedMode = mode;
      llmCallCount++;
      // Mode dispatch (claude-code / codex / live-key / managed-Pro) lives in
      // streamManagerCompletion — extracted so the LAYER 2 repair call below
      // this loop can reuse the exact same engine/model routing for its own
      // short completion. `cacheableSystem` here is the prompt-caching split
      // (chantier 2 — see `core`/`dynamicContext` above): `core` is the
      // manager's static prompt, `dynamic` is everything else in the flat
      // `system` string (per-turn context + RECALL_TEACHING) — `core +
      // dynamic` reconstructs `system` exactly, see resolveProxySystemField
      // (managedProvider.ts) for when this is actually honored as a
      // cache_control block versus flattened back to the identical string.
      rawResponse = await streamManagerCompletion({
        mode,
        model,
        system,
        cacheableSystem: { core, dynamic: `\n\n${dynamicContext}\n\n${RECALL_TEACHING}` },
        apiMessages,
        signal,
        onChunk,
        // Live UI only on the first planning completion. Nudge / validation
        // retries would otherwise flash the previous reply + the correction
        // in the bubble; the caller's placeholder stays on the last preview
        // until the final sanitized text lands.
        onPartial: firstTurnPartial(turn, onPartial),
      });
    } catch (err) {
      throw new Error(`LazyManager error: ${String(err)}`, { cause: err });
    }

    actions = stampOmittedBrainQuerySession(
      parseManagerActions(rawResponse),
      context.conversationId,
    );

    // Check whether any raw actions failed validation.
    const rawActions = parseRawActionsArray(rawResponse);
    if (rawActions.length === 0) {
      // PROMISE-STALL guard (generalized, night 2): zero actions is not
      // automatically a clean "informational answer, nothing to do" turn —
      // the USER may have clearly asked for an action
      // (detectUserActionRequest) that the reply silently never performed,
      // regardless of how (or whether) the reply narrates what it's doing
      // (see the PROMISE-STALL section above runManagerTurn). Checked ONLY
      // here — exactly the branch that used to break unconditionally — so a
      // legitimate zero-action reply to a non-action user message (plain
      // info/answer_question prose) is never touched. The one carve-out:
      // isClarifyingQuestion — a reply that is itself asking the user
      // something back is never nudged, even after a clear action request.
      const displayTextSoFar = sanitizeManagerDisplayText(rawResponse);
      if (shouldNudgeZeroActions({
        announcementNudged,
        turn,
        maxTurns,
        userAskedForAction: detectUserActionRequest(lastUserMessageContent),
        isClarifying: isClarifyingQuestion(displayTextSoFar),
        isSubstantialInfo: isSubstantialInformationalReply(displayTextSoFar),
      })) {
        announcementNudged = true;
        // Bug 2a fix: distinguish "no <lazy_actions> tag at all" from "tag
        // opened but its JSON could not be parsed/salvaged" — the latter
        // gets the SPECIFIC reason (see describeLazyActionsParseFailure's
        // own doc comment) instead of the generic announcement-only nudge,
        // so a model that already tried to comply gets told exactly what
        // was wrong with its own JSON rather than a reminder that doesn't
        // even acknowledge the block existed.
        const parseFailureReason = describeLazyActionsParseFailure(rawResponse);
        console.warn(formatZeroActionNudgeLog(turn + 1, parseFailureReason, displayTextSoFar.slice(0, 160)));
        appendTurnRetryMessages(
          apiMessages,
          rawResponse,
          zeroActionNudgeUserContent(parseFailureReason, ANNOUNCEMENT_NUDGE_MESSAGE),
          createMessageId,
        );
        continue;
      }
      // No actions produced (and no nudge applicable, or already used this
      // call) — break and return.
      break;
    }

    const invalidReasons = collectInvalidActionReasons(rawActions);
    if (invalidReasons.length === 0) {
      // All actions valid — break and return.
      break;
    }

    // Some actions failed validation — append correction context and retry
    // (unless this was the last allowed turn).
    if (shouldRetryInvalidActions(turn, maxTurns)) {
      appendTurnRetryMessages(
        apiMessages,
        rawResponse,
        `The following actions failed validation and were dropped. Please re-emit the <lazy_actions> block with corrected actions:\n\n${invalidReasons.join('\n')}`,
        createMessageId,
      );
    }
  }

  // sanitizeManagerDisplayText (not the narrower stripActionBlock): the
  // single choke point for B13 — strips both the manager's <lazy_actions>
  // block AND any leaked native tool-call XML, so every consumer of
  // responseText (sendManagerMessage's chat bubbles, AnalysisDesk's result
  // overlay, "Plan de rattrapage") is sanitized for free.
  const baseResponseText = sanitizeManagerDisplayText(rawResponse);
  // BUG 1b fix, scope narrowed by QUIET RECOVERY (2026-08-07): true ONLY for
  // a genuine failure — the nudge fired but STILL produced zero validated
  // actions on its retry, and that retry is not itself a clarifying
  // question. This is now the SOLE gate for showing any notice at all (see
  // the responseText assembly at the end of runManagerTurn) — every other
  // outcome (ordinary success, a nudge that recovered real actions, LAYER 1
  // salvage, or the LAYER 2 repair call) stays silent. Computed from the
  // FINAL turn's own actions/text (whichever turn the loop above actually
  // broke on), same values already returned below.
  const nudgeFailed = nudgeFailedOutcome(
    announcementNudged,
    actions.length,
    isClarifyingQuestion(baseResponseText),
  );

  // LAYER 2 — action-extraction repair call (see its own doc comment above,
  // "LAYER 2 — action-extraction repair call" section): only when the nudge
  // ITSELF failed (nudgeFailed already proves detectUserActionRequest was
  // true and the reply is not a clarifying question — see nudgeFailed's own
  // definition just above) AND the call has not already spent its
  // completion budget. Exactly one attempt — this is a single `if`, never a
  // loop, so "at most once per runManagerTurn invocation" holds structurally.
  let finalActions = actions;
  let repairRecovered = false;
  const repairMode = eligibleRepairMode(
    nudgeFailed,
    llmCallCount,
    MAX_LLM_CALLS_BEFORE_REPAIR_SKIPPED,
    lastResolvedMode,
  );
  if (repairMode) {
    const repaired = await attemptActionExtractionRepair(
      baseResponseText,
      repairMode,
      model,
      signal,
      onChunk,
      { lazyBots: context.lazyBots, userRequest: lastUserMessageContent },
    );
    const applied = applyRepairedActions(actions, repaired);
    finalActions = applied.actions;
    repairRecovered = applied.recovered;
  }

  // LAYER 3 — deterministic LazyBot fallback (see managerLazyBotFallback.ts's
  // own header): no model call at all. Only when LAYER 1 + LAYER 2 both
  // failed on a turn where the USER asked to run a saved bot by name — the
  // one action they asked for is reconstructed with the bot's real id, and
  // the reply says so explicitly (fallbackNotice) instead of the generic
  // "nothing was done" notice. The action still goes through the ordinary
  // action gate downstream, exactly like a model-emitted run_lazybot.
  let lazyBotFallbackNotice: string | undefined;
  if (nudgeFailed && !repairRecovered) {
    const reconstructed = detectDeterministicManagerAction(
      lastUserMessageContent,
      baseResponseText,
      context.lazyBots,
    );
    if (reconstructed) {
      finalActions = [reconstructed];
      repairRecovered = true;
      lazyBotFallbackNotice = formatDeterministicFallbackNotice(context.locale, reconstructed);
      console.warn(
        `[managerEngine] LAYER 3: model emitted no action after nudge + repair — reconstructed ` +
        `${reconstructed.type} from the user's request.`,
      );
    }
  }

  // QUIET RECOVERY (2026-08-07, founder-reported chat noise): every nudge/
  // salvage/repair recovery used to prepend a "[système] La réponse
  // précédente annonçait..." notice to responseText even when the retry (or
  // LAYER 1 salvage, or the LAYER 2 repair call) fully recovered real
  // actions — the founder saw 8+ such messages in a single conversation,
  // every one of them describing a "problem" that had already been silently
  // fixed by the time the user read it. New policy: responseText carries NO
  // system notice at all when actions were ultimately obtained, by ANY
  // route (an ordinary first-pass reply, a nudge retry that produced real
  // actions, LAYER 1 salvage on either call, or the LAYER 2 repair call).
  // The ONLY case that still shows a notice is a TRUE failure — nudgeFailed
  // is already exactly that gate (nudge fired, the retry still produced
  // zero validated actions, and that reply is not itself a clarifying
  // question) — AND the repair call, if attempted, did not recover
  // anything either (!repairRecovered). console.warn diagnostics above (the
  // nudge-issued and repair-call-failed warnings) are untouched — this is
  // about the USER-visible transcript only; developers still see every
  // retry in the console regardless of outcome.
  // Bug 2b fix (LazyManager QA, 2026-08-07, "contradictory outcome" repro):
  // this used to APPEND baseResponseText after the failure notice, then
  // (this same fix) DROPPED it instead — baseResponseText, in that branch,
  // was always the model's own prose ANNOUNCING an action it never performed
  // ("I'll stop and permanently delete M72..."), and showing "nothing was
  // done" right next to that announcement read as two messages disagreeing
  // about whether anything happened.
  //
  // REVERSED (2026-08-15, founder repro): that reasoning assumed
  // baseResponseText is always an unexecuted announcement, but nudgeFailed
  // only proves "the guard THOUGHT an action was requested and none came
  // out" — it says nothing about what the text actually contains. Real
  // repro: "Réponds uniquement par OK." got detectUserActionRequest's
  // false-positive (see NON_VERB_MESSAGE_STARTERS' own 2026-08-15 fix note —
  // narrowed here, not removed, so a genuine unactioned request is still
  // caught), the model honestly answered "OK", and this branch DISCARDED
  // that real answer in favor of "[system] nothing was done" — the exact
  // "announces failure over a success" pattern this whole guard exists to
  // prevent. Dropping the text was never actually required to avoid the
  // 2026-08-07 contradiction either: prepending the notice (not appending)
  // already makes the ORDER read as "here's the honest status, here's what
  // the model said" rather than the reverse, and a genuinely empty reply
  // (nothing exploitable to show) still degrades to the notice alone. New
  // policy, matching the founder's explicit instruction: the failure notice
  // is shown ONLY for a true failure (nudgeFailed && !repairRecovered, same
  // gate as before) and, whenever the model's own text is non-empty, stands
  // ALONGSIDE it rather than replacing it — never silently discarding a real
  // reply just because the PROMISE-STALL guard also fired on the same turn.
  const responseText = lazyBotFallbackNotice
    ? (baseResponseText.trim().length > 0 ? `${lazyBotFallbackNotice}\n\n${baseResponseText}` : lazyBotFallbackNotice)
    : assembleManagerTurnResponseText(
        baseResponseText,
        showNudgeFailureNotice(nudgeFailed, repairRecovered),
        buildAnnouncementNudgeFailureNotice(context.locale),
      );

  scheduleManagerTurnCapture({
    conversationId: contextForTurn.conversationId,
    messages,
    responseText,
  });

  return {
    responseText,
    actions: stampOmittedBrainQuerySession(finalActions, contextForTurn.conversationId),
    rawResponse,
    announcementNudged,
    compacted: compacted.meta.foldedTurns > 0 ? compacted.meta : undefined,
  };
}

/** Extract the raw parsed JSON array from a <lazy_actions> block WITHOUT
 *  validation — used by runManagerTurn's retry loop to detect whether any
 *  actions were dropped by parseManagerActions so it can ask the LLM to
 *  correct them on the next attempt. Tolerant like parseManagerActions
 *  (unclosed block / trailing prose — see parseLazyActionsJson). */
function parseRawActionsArray(text: string): unknown[] {
  return parseLazyActionsJson(text);
}

// ── Grounded mission detail ──────────────────────────────────────────
// Implementation lives in formatMissionDetail.ts (extracted 2026-08-28:
// cyclomatic complexity 18). Re-exported here so existing imports from
// managerEngine keep working.

// ── Context gathering ──────────────────────────────────────────────

/** Gather all context the manager needs: agents + missions + brain + fleet. */
export async function gatherManagerContext(
  agents: StoredAgent[],
  missions: Mission[],
  autonomy?: import('./types.js').AutonomyConfig,
): Promise<ManagerContext> {
  return {
    agents,
    missions,
    fleetContext: buildFleetContext(),
    otherProjectsDigest: buildOtherProjectsDigest(missions.map((m) => m.id)),
    brainDrivenContext: buildTemplateOrchestratorContext(),
    autonomyContext: formatAutonomyContext(autonomy),
    lessonsContext: buildLessonsContext(),
  };
}

/** Create a unique message id. */
export function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
