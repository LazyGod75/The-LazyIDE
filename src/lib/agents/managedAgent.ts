/* managedAgent — Managed (Pro tier) autonomous agent loop.

   ReAct loop (inspired by Claude Code's agentic loop): compose task + brain
   context, stream a turn (streamManagedAgentTurn), parse THOUGHT/ACTION/ARGS,
   execute the named tool (read_file/write_file/edit_file, read_dir, glob,
   grep_file, run_command, run_tests, brain_query, brain_record), feed the
   observation back and repeat. Stops on ACTION: FINAL, MAX_STEPS, or
   MAX_CONSECUTIVE_FAILURES consecutive errored steps (escalation — V4).

   SoA enhancements: R1 windowed read_file/grep_file; R6 Reflexion buffer
   (Shinn 2023); R7 context handoff at ~96K tokens; R8 PRM step verifier
   (SWE-PRM); R11 tool policy in the system prompt; V4 consecutive-failure
   escalation (counter resets on success; hitting the cap stops the mission
   with a clear escalation observation instead of burning the rest of
   MAX_STEPS); V5 identical-call dedup — repeating an IDENTICAL read-only
   tool call (same tool + same args) is not re-executed a 2nd time; the
   model gets a nudge observation instead, so a stuck loop (e.g. re-reading
   the same file every turn) burns one wasted step instead of MAX_STEPS.
   Mirrors assistantToolLoop.ts's searchedQueries dedup for the assistant
   chat surface. See ./managedAgentDedup.ts for which tools qualify.
   V7 (2026-08-14, M6 incident) — a parse failure is the one failure mode
   that costs 2 full model calls per attempt (original turn + the in-step
   "please re-emit" format retry), so it fast-tracks straight to the
   MAX_CONSECUTIVE_FAILURES cap the moment the SAME unparseable shape
   repeats, instead of always burning the full 3-attempt/6-call budget; see
   parseReActAction's own doc comments for the parser-side half of this fix
   (sanitizeJsonStringControlChars + the ARGS-anchored balanced-brace
   rescan), which eliminates the actual root cause for the common case
   (unescaped newlines in a multi-line write_file/edit_file `content`).

   Pro/managed parity with the native (claude-code/codex) loop: per-agent
   persona, permission/tool policy (checkToolPolicy — 'plan' is read-only,
   deniedTools/allowedTools mirror --disallowedTools/--allowedTools — plus
   toolPermissions.ts's allow/ask/exclude rules layered on top via
   checkToolExecution), and onMetrics in the native loop's AgentMetrics
   shape. Persona + tool-policy composition lives in ./managedAgentPolicy.ts
   and ./managedToolPermissions.ts (imported here, file-size cohesion).

   Model routing: this loop is invoked ONLY once runtime.ts's planAndAct has
   already confirmed the mission's chosen model belongs to the managed
   catalog AND that Pro is ready (see planAndAct's routing-by-model
   dispatch) — every turn here (streamAgentTurn) therefore ALWAYS stays on
   the managed ai-proxy path. It must never re-derive routing from
   getProviderMode() and divert back to the native claude-code CLI mid-loop:
   that used to happen here (a stale `if (getProviderMode() ===
   'claude-code')` branch calling a claude-only toNativeClaudeModel +
   streamClaudeCodeTurn), which was harmless only while mission dispatch was
   itself mode-based (planAndActManaged was never reached while
   mode==='claude-code' — see isManagedAgentAvailable in runtime.ts). Now
   that dispatch is model-based, a mission CAN legitimately run here while
   accessMode is 'cli' (a user entitled to both a Claude subscription and
   Pro who picked a managed model for THIS mission) — reviving that branch
   would silently reroute every turn back to native and mangle a non-Claude
   OpenRouter id (e.g. 'openai/gpt-5.5') through toNativeClaudeModel, which
   only recognizes the opus/sonnet/haiku substrings and passes anything else
   through UNCHANGED into the claude CLI's `model` field. The remaining
   toManagedOpenRouterModel normalization is a defensive backstop only (maps
   a bare tier/native id, if one ever leaks in, to a real catalog id) — a
   real OpenRouter id for ANY provider (anthropic/openai/google/x-ai/
   deepseek/meta-llama) already matches findOpenRouterModel and passes
   through unmangled.

   Pause / Intervene (real here, polled once per step alongside stopSignal):
   pauseSignal() true -> wait (PAUSE_POLL_MS poll, stopSignal still honored),
   no new step/model call until resumed or stopped. drainIntervenes() pops
   queued user text (agentsStore.interveneMission) and injects it as real
   user message(s) before the next turn. Both default to a no-op, like
   permissionMode/allowedTools/deniedTools on this opts type.

   Real vs estimated metrics (billing trust): onMetrics used to always report
   ceil(chars/4) estimates because the ai-proxy stream carried no usage
   metadata. It now appends a final real-usage marker after settlement (see
   managedProvider.ts's streamManagedAgentTurn/onUsage and ai-proxy's
   settleAndRecord); addTurnTokens prefers that real usage per-turn and falls
   back to the estimate only when absent (older ai-proxy deployment, or the
   claude-code/native backend below which never reports it). AgentMetrics.
   tokensSource reflects which one was actually used across the whole
   mission: 'real' (every accounted turn had it), 'estimated' (none did —
   the pre-existing behavior), or 'mixed'.

   Journal instrumentation (T0.4, spec §4.2): this loop emits mission.step
   (per iteration, plus dedicated marker:'reflexion'/marker:'prm' entries),
   tool.called (name/files/durationMs, real executions only — a deduped V5
   nudge is not a call), spend.tokens (source 'real'/'estimated' per
   addTurnTokens's existing preference), agent.handoff at the R7 context
   handoff, and mission.completed/failed alongside the existing emitMetrics
   call sites (FINAL, V4 escalation, MAX_STEPS exhaustion). All emitted via
   emitBuffered (never throws, never blocks the loop — see journal.ts).
   projectId is derived inline from worktreePath (deriveProjectId below) as
   a placeholder for the real ProjectRegistry id (T0.7) — a later
   integration pass unifies this with the rest of the journal emitters.
*/

import type { PlanStep, ActionEvent, ProofArtifact, ProofRequirement } from '../agents/types.js';
import type { AgentMetrics, PermissionMode, TFunc } from './runtime.js';
import { emitBuffered } from '../journal/journal.js';
import { buildProofArtifact, storeProofText } from './proofs.js';
import { estimateTokens } from '../brain/context.js';
import { estimateMessagesTokens } from './managedAgentPure.js';
export { parseReflectBlock, estimateMessagesTokens, shouldHandoff, parsePrmVerdict } from './managedAgentPure.js';
import { streamManagedAgentTurn } from '../models/managedProvider.js';
import type { RealUsage } from '../models/managedProvider.js';
import { findOpenRouterModel, OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL_ID } from '../models/openrouterCatalog.js';
import { stripVerbatimPrefix } from '../paths.js';
import {
  AGENT_SYSTEM_PROMPT,
} from './managedAgentPolicy.js';
import type { ToolPolicy } from './managedAgentPolicy.js';
import { resolveManagedAgentMode } from './managedToolPermissions.js';
import type { AgentPermissionMode } from './managedToolPermissions.js';
import { boundMissionHistory } from './missionHistoryWindow.js';
import { TraceBuffer } from './toolTraces.js';
import { executeTool as executeToolShared, type ToolExecutionContext } from '../tools/toolRuntime.js';
import { type ToolCallRecord } from './loopGuard.js';
import { type MissionCapIo } from './managedAgentCaps.js';
import { prepareManagedMission } from './managedAgentPrepare.js';
import { agentErrorEvent } from './agentError.js';
import { formatCompiledPlanGuide } from './stageContract.js';
import { collectManagedTurnText, failManagedMaxSteps, runManagedTurn } from './managedAgentTurn.js';
import { runManagedAction } from './managedAgentAction.js';
import { applyManagedLoopStep } from './managedAgentLoop.js';
export { parseReActAction, extractBalancedJsonObject, sanitizeJsonStringControlChars } from './managedAgentParse.js';
import { type AgentStepRecord } from './stuckDetector.js';

/** Managed-loop step cap — 100 (raised from 60 on 2026-08-05): DeepSeek verbose verification loops need the headroom. */
const MAX_STEPS = 100;
const CHEAP_MODEL = 'deepseek/deepseek-v4-flash';
const PRM_MAX = 2;
/** V4 — consecutive-failure escalation cap (see planAndActManaged). */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Poll interval while paused — see planAndActManaged's pause-wait loop. */
const PAUSE_POLL_MS = 250;
/** V6 — proof-of-work completion gate cap (see the FINAL handler in
 *  planAndActManaged): how many times ACTION: FINAL may be bounced back for
 *  missing required proof kind(s) before it is let through anyway. Bounded
 *  so a mission that genuinely cannot produce a required kind still
 *  terminates instead of looping — checkApproveGate's "Merger quand même"
 *  override remains the final escape hatch either way. */
const MAX_PROOF_NUDGES = 2;
/**
 * Structural loop-safety guard (2026-08-05 incident: two BYOK DeepSeek
 * missions froze the app's main thread for over an hour during their
 * verification phase — run_command/run_shell probes failing/timing out,
 * then find_tool "browser_open", then nothing; no JS synchronous busy-loop
 * was found in this file, toolRuntime.ts, sgrChainRunner.ts, or
 * lazyReasoningBlocks/* despite a full review — every loop there already
 * awaits a real setTimeout-based delay or an async iterator. This constant
 * exists as insurance ANYWAY, independent of and layered ON TOP OF every
 * existing per-cause bound below (MAX_STEPS, MAX_CONSECUTIVE_FAILURES,
 * MAX_PROOF_NUDGES): the main for-loop below counts EVERY pass through its
 * body — including a `continue`d one — and bails out with an honest
 * mission failure ('iteration_cap_exceeded') once this is exceeded,
 * regardless of which specific bound a FUTURE change might accidentally
 * remove, widen, or bypass. 200 is comfortably above today's real worst
 * case (~110: MAX_STEPS=100 plus a handful of consecutive-failure/proof-nudge
 * continues before one of those caps itself fires first) — this must never
 * fire under today's code, only once some future regression breaks one of
 * the other caps. Paired with a mandatory per-iteration yield (see the loop
 * below) so even a fully synchronous future bug still hands control back to
 * the event loop every pass instead of starving it. */
const MAX_LOOP_ITERATIONS = 200;

export interface PlanAndActManagedOpts {
  missionId: string;
  missionTitle: string;
  missionTask?: string;
  /** Named agent to route this run through; resolved via listAgents() unless agentSystemPrompt is provided directly (see resolveAgentPersona). */
  agentName?: string;
  /** Pre-resolved persona — used as-is when set (skips the listAgents() round-trip). */
  agentDisplayName?: string;
  agentSystemPrompt?: string;
  worktreePath: string;
  steps: PlanStep[];
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onAction: (event: ActionEvent) => void;
  onProgress: (pct: number) => void;
  onMetrics?: (metrics: AgentMetrics) => void;
  /** Called once, right before onMetrics, with the mission's terminal
   *  outcome — lets the caller (runMission via planAndAct) distinguish a
   *  managed-loop failure (max_steps_exhausted, consecutive_failures,
   *  no_credits) from a successful completion, which onMetrics alone cannot
   *  convey. Without this, runMission falls through to the review/completed
   *  path even when the managed loop emitted mission.failed, producing both
   *  mission.failed AND mission.completed journal events for the same run. */
  onOutcome?: (outcome: MissionOutcome) => void;
  stopSignal: () => boolean;
  /**
   * Real cancellation channel for the CURRENTLY IN-FLIGHT model call — unlike
   * stopSignal (only polled BETWEEN turns, at the top of this loop's `for`),
   * an AbortSignal aborts the underlying fetch to the ai-proxy (managed/Pro
   * rail, managedProvider.ts) or the BYOK provider's own raw streamer mid-
   * request. Wired all the way through streamAgentTurn -> streamManagedAgentTurn
   * / opts.streamTurn below. Money incident (2026-08-14, "Stoppe tout" kept
   * billing after being clicked): stopSignal alone can never stop a turn that
   * has already started streaming — it can only prevent the NEXT one. Optional
   * (not required) so every existing low-level test/caller that never
   * constructs an AbortController keeps compiling and behaving unchanged;
   * agentsStore.tsx's stopMission/stopAll now always provide one (see
   * stopFlags' `controller` field there).
   */
  signal?: AbortSignal;
  /** Parallel to stopSignal — real pause (module header). Default: never paused. */
  pauseSignal?: () => boolean;
  /** Drains queued user interventions once per step (module header). Default: nothing queued. */
  drainIntervenes?: () => string[];
  model: string;
  /** BYOK wave: optional per-turn streamer overriding streamManagedAgentTurn
   *  (the ai-proxy rail). When provided, the full ReAct loop below runs
   *  against the user's own BYOK provider (DeepSeek, OpenRouter, ...) with
   *  the model id passed through UNMANGLED — see
   *  resolveByokAgentTurnStreamer (byokProviders.ts). */
  streamTurn?: (opts: {
    messages: Array<{ role: string; content: string }>;
    system: string;
    model: string;
    signal?: AbortSignal;
    cacheableSystem?: { core: string; dynamic: string };
    maxTokens?: number;
  }) => AsyncIterable<string>;
  /** 'plan' blocks write/exec tools (write_file, edit_file, run_command, run_tests, brain_record) — enforced in executeTool. */
  permissionMode?: PermissionMode;
  /** Non-empty: only these tool names may execute. */
  allowedTools?: string[];
  /** Always blocked, regardless of allowedTools. */
  deniedTools?: string[];
  /** toolPermissions.ts mode axis (independent of permissionMode above) —
   *  auto-derived from permissionMode when omitted; see
   *  managedToolPermissions.resolveManagedAgentMode for the mapping. */
  permissionAgentMode?: AgentPermissionMode;
  /** Stable project root (NOT worktreePath) — see proofs.ts's header for
   *  why proof artifacts must survive worktree deletion/merge. Falls back
   *  to worktreePath when absent (degraded: artifacts may be lost if the
   *  worktree is later discarded) rather than failing attach_proof outright. */
  projectRoot?: string;
  /** Soft ReAct guide from compilePlan stages — injected into the system
   *  prompt; the loop remains ReAct, not a hard stage runner (B38). */
  compiledPlan?: import('./stageContract.js').CompiledPlan;
  /** Mission.contract.proofs (spec §8, T1.4) — when non-empty, appends a
   *  reminder to the system prompt and documents the attach_proof action
   *  (see buildProofPolicyBlock below). */
  proofRequirements?: ProofRequirement[];
  /** Called with the FULL accumulated proof list every time attach_proof
   *  executes (not just the newest one) — mirrors onMetrics's accumulator
   *  pattern so the caller (runtime.ts's runMission) can forward it
   *  straight into Mission.proofs via onUpdate without tracking any state
   *  of its own. See runtime.ts's planAndActLive for the native-loop
   *  equivalent (called once, at the end, instead of once per attachment). */
  onProofsAttached?: (proofs: ProofArtifact[]) => void;
  /** P3.2 — Called after each checkpoint is written. */
  onCheckpoint?: (checkpointId: string, turn: number) => void;
  /**
   * T1.3 (spec §7.3/§8) — live getter for the mission's budget cap. A
   * GETTER (not a frozen number) so raising contract.budgetCapUsd via
   * updateMission while THIS run is paused (resume-after-raise) is visible
   * on the very next step-boundary check below, same contract as
   * pauseSignal/stopSignal. 0/undefined -> unlimited (default: unlimited).
   */
  getBudgetCapUsd?: () => number | undefined;
  /**
   * Called ONCE when this run pauses itself at >=90% spend — real callers
   * (runtime.ts's runMission, forwarding agentsStore.tsx's implementation)
   * flip the SAME pauseFlags cell pauseMission/resumeMission use, so the
   * mission is resumable via the existing Resume button with no extra
   * state to reconcile. Default: no-op (tests / low-level callers).
   */
  onBudgetPaused?: () => void;
  /**
   * Called ONCE when this run stops itself at >=100% spend — lets
   * runMission skip its retry-evaluation branch and go straight to a
   * 'failed' status with reason 'budget_exceeded' (a hard stop must never
   * be silently retried — spec §11's "non-bypassable except by explicit
   * user action"). Default: no-op.
   */
  onBudgetExceeded?: () => void;
  /**
   * W-GUARD (mission wall-clock cap) — live getter for the mission's
   * maxDurationMs. Same GETTER contract as getBudgetCapUsd above (a cap
   * raised via updateMission while paused takes effect on the very next
   * step-boundary check). 0/undefined -> unlimited (default: unlimited).
   */
  getMaxDurationMs?: () => number | undefined;
  /**
   * Called ONCE when this run pauses itself at >=90% elapsed wall-clock —
   * mirrors onBudgetPaused exactly (same pauseFlags cell, same Resume
   * path). Default: no-op (tests / low-level callers).
   */
  onDurationPaused?: () => void;
  /**
   * Called ONCE when this run stops itself at >=100% elapsed wall-clock —
   * mirrors onBudgetExceeded exactly (runMission skips retry-evaluation,
   * goes straight to 'failed' with an honest timeout reason). Default: no-op.
   */
  onDurationExceeded?: () => void;
  /** Reasoning effort forwarded to the managed proxy when the model supports
   *  it. Sourced from MissionContract.effort (set by NewMissionModal or the
   *  LazyManager's launch_mission/create_loop action). */
  reasoningEffort?: import('../models/openrouterCatalog.js').ReasoningEffort;
  /** Optional i18n translate function — see {@link TFunc}'s doc comment
   *  (runtime.ts). Threaded through this loop's own action-feed strings
   *  (agents.managedAgent.* keys) the same way runtime.ts threads it
   *  through its own agents.runtime.* strings: every string still falls
   *  back to its ORIGINAL hardcoded French when `t` is absent (tests,
   *  low-level callers), so omitting it is never a behavior change. The
   *  "Erreur agent:" prefix itself, stopForDefinitiveProviderError's
   *  PROVIDER_ERROR_MESSAGE, and 'évaluation indisponible' stay EXCLUDED —
   *  see runtime.ts's TFunc doc comment for why they are cross-file
   *  control-flow sentinels. stopForNoCredits's NO_CREDITS_MESSAGE is now
   *  translated (2026-08 i18n pass) — see its own doc comment for how
   *  runtime.ts's no_credits detection was hardened to a typed reason code
   *  so a translated message can no longer be misclassified as retryable. */
  t?: TFunc;
  /** Autonomy mode for the cloud approval gate — only relevant when cloud_*
   *  tools are used. 'manual' gates every non-readonly cloud action;
   *  'supervised' uses class/rules (default); 'yolo' gates only credentials.
   *  Threaded into ToolExecutionContext for executeTool's gate wiring.
   *  See src/lib/bots/botEngine.ts and src/lib/agents/approval/approvalGate.ts. */
  autonomy?: 'manual' | 'supervised' | 'yolo';
  /** Launch prelude depth (managedAgentPrepare.ts). 'full' (default, local
   *  code agents): brain recall, repo startup context, harness rules, coding
   *  skill injection, learned tool overlays. 'lean': persona + policy + task
   *  only. 'bot' (LazyBots, D93): like lean plus bot-scoped topical recall
   *  for `botId` — no harness / no repo brain. */
  prelude?: 'full' | 'lean' | 'bot';
  /** LazyBot id — required when prelude === 'bot'. */
  botId?: string;
  /** Optional project id — forwarded to journal events. */
  projectId?: string;
}

// Proof-of-work reminder (buildProofPolicyBlock) lives in managedAgentPrepare.ts.

// R6/R7/R8 helpers (parseReflectBlock, estimateMessagesTokens, shouldHandoff,
// parsePrmVerdict) live in managedAgentPure.ts — re-exported above.

// V5 identical-call dedup (DEDUPE_ELIGIBLE_TOOLS, canonicalizeToolArgs,
// dedupKeyFor, dedupNudgeObservation) moved to ./managedAgentDedup.ts —
// same file-size-cohesion rationale as managedAgentPolicy.ts.

// Persona + tool policy moved to ./managedAgentPolicy.ts (imported above).

// ── Internal helpers ──────────────────────────────────────────────

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Used by the pause-wait poll below — never burns a step while paused. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Journal projectId placeholder (T0.4 — see this file's header): strips the
 *  Windows verbatim (\\?\) prefix from the raw worktree/root path so the
 *  same project consistently maps to one id regardless of whether the path
 *  arrived canonicalized. Not the real ProjectRegistry id (T0.7, sha1 of the
 *  normalized root, computed Rust-side) — a later integration pass unifies
 *  every journal emitter onto that once it lands. */
function deriveProjectId(rootPath: string): string {
  return stripVerbatimPrefix(rootPath);
}

function resolveProofsRoot(projectRoot: string | undefined, worktreePath: string): string {
  if (projectRoot) return projectRoot;
  return worktreePath;
}

/** Maps any model label/tier/native-id to a valid OpenRouter id for the
 *  ai-proxy (managedProvider.ts forwards `model` as-is and rejects anything
 *  else). Reuses OPENROUTER_MODELS (never hardcoded) — a defensive backstop
 *  for when Mission.model doesn't already carry a valid id (see
 *  models/index.ts's getDefaultModelIdForMode). */
export function toManagedOpenRouterModel(model: string): string {
  // Already a valid OpenRouter id — pass through unchanged.
  if (findOpenRouterModel(model)) return model;

  const lower = model.toLowerCase();
  const anthropicModelId = (needle: string): string | undefined =>
    OPENROUTER_MODELS.find(
      (m) => m.provider === 'Anthropic' && m.id.toLowerCase().includes(needle),
    )?.id;

  if (lower.includes('opus')) return anthropicModelId('opus') ?? DEFAULT_OPENROUTER_MODEL_ID;
  if (lower.includes('sonnet')) return anthropicModelId('sonnet') ?? DEFAULT_OPENROUTER_MODEL_ID;
  if (lower.includes('haiku')) return anthropicModelId('haiku') ?? DEFAULT_OPENROUTER_MODEL_ID;

  // Unrecognized label/id with no catalog match — fall back to the catalog
  // default rather than forwarding an id the proxy will reject.
  return DEFAULT_OPENROUTER_MODEL_ID;
}

/** Streams one turn via the managed (OpenRouter/ai-proxy) backend — see this
 *  file's header ("Model routing") for why this must NEVER branch on
 *  getProviderMode() / divert to the native CLI: this loop only ever runs
 *  once runtime.ts has already committed to the managed engine for this
 *  mission. */
async function* streamAgentTurn(opts: {
  messages: Array<{ role: string; content: string }>;
  system: string;
  model: string;
  signal?: AbortSignal;
  /** Reasoning effort forwarded to the managed proxy. */
  reasoningEffort?: import('../models/openrouterCatalog.js').ReasoningEffort;
  /** Real-usage callback, populated from the ai-proxy's post-settlement marker. */
  onUsage?: (usage: RealUsage) => void;
  /** Forwarded to managedProvider.ts so its post-settlement corrective
   *  spend.tokens event (T0.4) carries the right journal identity. */
  missionId?: string;
  projectId?: string;
  /** BYOK wave: overrides the ai-proxy rail with the user's own BYOK
   *  provider streamer (see resolveByokAgentTurnStreamer). */
  streamTurn?: PlanAndActManagedOpts['streamTurn'];
}): AsyncIterable<string> {
  // Defensive model normalization (see toManagedOpenRouterModel) — a real
  // OpenRouter id for ANY provider passes through unmangled. BYOK wave: when
  // a streamTurn override is provided (mission routed to the user's own
  // BYOK provider), the model id goes through UNMANGLED — DeepSeek catalog
  // ids must never be rewritten to OpenRouter-style ids.
  if (opts.streamTurn) {
    yield* opts.streamTurn({ ...opts, model: opts.model });
    return;
  }
  yield* streamManagedAgentTurn({ ...opts, model: toManagedOpenRouterModel(opts.model) });
}

// resolvePath moved to toolRuntime.ts — re-exported here for tests that import it.
export { resolvePath } from '../tools/toolRuntime.js';

// stripVerbatimPrefix — strips a leading \\?\ or \\?\UNC\ (Windows
// extended-length / "verbatim") prefix before a path reaches the
// `read_file` Tauri command; no-op otherwise. worktreePath arrives
// \\?\-prefixed (Rust std::fs::canonicalize()); `read_file` rejects that
// prefix while `write_file` accepts it, hence this is applied ONLY to
// read_file call sites below.
//
// Imported from ../paths (the shared, tested helper — see its header
// comment for the bug history) rather than kept as a local copy, and
// re-exported here so this file keeps its existing public export
// (managedAgent.test.ts imports stripVerbatimPrefix from this module).
export { stripVerbatimPrefix };

/** Estimates USD cost from the OpenRouter catalog's per-model pricing (priceIn/priceOut, USD per 1M tokens); returns 0 (honest "not derivable") when the model isn't in the catalog or is free. */
function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const entry = findOpenRouterModel(model);
  if (!entry || entry.isFree) return 0;
  return (inputTokens / 1_000_000) * entry.priceIn + (outputTokens / 1_000_000) * entry.priceOut;
}

// ── Tool executor (delegates to shared runtime) ───────────────────
//
// executeTool was extracted to src/lib/tools/toolRuntime.ts so all AI
// surfaces (assistant, manager, agents) share one implementation.
// This wrapper preserves the original call signature for the agent loop.

async function executeTool(
  action: string,
  args: Record<string, unknown>,
  worktreePath: string,
  policy: ToolPolicy = {},
  agentMode: AgentPermissionMode = 'default',
  // P-SEARCH (additive) — real mission identity, forwarded ONLY so
  // toolRuntime.ts's web_search case can emit the canvas-visible
  // 'canvas:webSearchResult' bus event + 'agent.web_search' journal event
  // (ToolExecutionContext's own doc comment). Never read by policy
  // enforcement.
  missionId?: string,
  agentName?: string,
  projectId?: string,
  // Cloud approval gate — threaded from planAndActManaged's opts so the
  // gate inside executeToolShared knows the autonomy mode and can abort
  // a pending approval when the mission's AbortSignal fires.
  autonomy?: 'manual' | 'supervised' | 'yolo',
  abortSignal?: AbortSignal,
): Promise<string> {
  const ctx: ToolExecutionContext = {
    rootPath: worktreePath,
    policy,
    agentMode,
    missionId,
    agentName,
    projectId,
    autonomy,
    abortSignal,
  };
  return executeToolShared(action, args, ctx);
}

// ── Legacy switch body removed — see toolRuntime.ts ────────────────

/** Outcome passed to emitMetrics (T0.4) — decides which journal event
 *  (mission.completed vs mission.failed) accompanies the existing
 *  onMetrics callback. */
type MissionOutcome = { type: 'completed' } | { type: 'failed'; reason: string };

// ── Main loop ─────────────────────────────────────────────────────

export async function planAndActManaged(opts: PlanAndActManagedOpts): Promise<void> {
  const {
    missionId,
    missionTitle,
    missionTask,
    agentName,
    agentDisplayName,
    agentSystemPrompt,
    worktreePath,
    onStep,
    onAction,
    onProgress,
    onMetrics,
    onOutcome,
    stopSignal,
    signal,
    pauseSignal = () => false,
    drainIntervenes = () => [],
    model,
    permissionMode,
    allowedTools,
    deniedTools,
    permissionAgentMode,
    projectRoot,
    proofRequirements,
    onProofsAttached,
    onCheckpoint,
    getBudgetCapUsd = () => undefined,
    onBudgetPaused,
    onBudgetExceeded,
    getMaxDurationMs = () => undefined,
    onDurationPaused,
    onDurationExceeded,
    reasoningEffort,
    streamTurn,
    t,
    autonomy,
    prelude,
    botId,
  } = opts;

  const policy: ToolPolicy = { permissionMode, allowedTools, deniedTools };
  const agentMode = resolveManagedAgentMode(permissionAgentMode, permissionMode);
  // Placeholder projectId (see this file's header) — normalizes the raw
  // worktree path the same way stripVerbatimPrefix already does for
  // read_file below, so the same project doesn't fork into two journal ids
  // depending on whether a path arrived Windows-verbatim-prefixed.
  const projectId = deriveProjectId(worktreePath);
  // Proof artifacts (spec §8, T1.4) must survive worktree deletion/merge —
  // see PlanAndActManagedOpts.projectRoot's doc comment for the fallback
  // rationale.
  const proofsRoot = resolveProofsRoot(projectRoot, worktreePath);
  let attachedProofs: ProofArtifact[] = [];
  let proofFileCounter = 0;

  /**
   * Handles ACTION: attach_proof — validates args via proofs.ts's
   * buildProofArtifact (shared with runtime.ts's native transcript parser),
   * persisting captured output (test_run/command_output) via storeProofText
   * first since buildProofArtifact itself never touches disk. Returns the
   * ReAct observation text; never throws (a storage failure becomes an
   * ERROR: observation, same convention as executeTool's own failures).
   */
  const handleAttachProof = async (args: Record<string, unknown>): Promise<string> => {
    const kind = String(args.kind ?? '');
    try {
      let outputPath: string | undefined;
      if (kind === 'test_run' || kind === 'command_output') {
        proofFileCounter += 1;
        outputPath = await storeProofText(
          proofsRoot,
          missionId,
          `${kind}-${proofFileCounter}.txt`,
          typeof args.content === 'string' ? args.content : '',
        );
      }

      const artifact = buildProofArtifact({
        kind,
        path: args.path,
        label: args.label,
        command: args.command,
        exitCode: args.exitCode,
        before: args.before,
        after: args.after,
        content: args.content,
        outputPath,
      });

      if (!artifact) {
        return `ERROR: attach_proof received invalid or incomplete args for kind "${kind}".`;
      }

      attachedProofs = [...attachedProofs, artifact];
      emitBuffered({
        tsMs: Date.now(),
        projectId,
        missionId,
        actor: 'agent',
        type: 'mission.proof_attached',
        payload: artifact,
      });
      onProofsAttached?.(attachedProofs);

      return `Proof attached: ${kind}`;
    } catch (err) {
      return `ERROR: attach_proof failed to store artifact: ${String(err)}`;
    }
  };

  // onMetrics accounting for the Observability panel. Real settled usage
  // (from the ai-proxy's post-settlement marker — see module header) is
  // preferred per-turn via addTurnTokens's realUsage param; ceil(chars/4)
  // estimation remains the fallback when it's absent (older ai-proxy
  // deployment, or the claude-code/native backend). sawReal/sawEstimated
  // track which source(s) actually contributed, for AgentMetrics.tokensSource.
  const startTime = Date.now();
  let inputTokensAccum = 0;
  let outputTokensAccum = 0;
  let costUsdAccum = 0;
  let toolCallCount = 0;
  let sawReal = false;
  let sawEstimated = false;
  /** T1.3 — dedupes budget.warning to exactly once per mission run (spec:
   *  "once per mission"), even across a cap raise + resume. Checked
   *  alongside costUsdAccum at each step boundary below. */
  let budgetWarned = false;
  /** W-GUARD — dedupes duration.warning to exactly once per mission run,
   *  same convention as budgetWarned above. */
  let durationWarned = false;

  /** Accumulates token + cost for one model turn — reassigns the closed-over
   *  scalar counters, consistent with the loop's immutable-update style
   *  elsewhere. Prefers realUsage (real settled usage for this exact turn)
   *  when provided; falls back to the ceil(chars/4) estimate otherwise. */
  const addTurnTokens = (
    systemPrompt: string,
    promptMessages: Array<{ role: string; content: string }>,
    responseText: string,
    turnModel: string,
    realUsage?: RealUsage,
  ): void => {
    if (realUsage) {
      inputTokensAccum += realUsage.inputTokens;
      outputTokensAccum += realUsage.outputTokens;
      costUsdAccum += realUsage.costUsd;
      sawReal = true;
      emitBuffered({
        tsMs: Date.now(),
        projectId,
        missionId,
        actor: 'agent',
        type: 'spend.tokens',
        payload: {
          tokensIn: realUsage.inputTokens,
          tokensOut: realUsage.outputTokens,
          costUsd: realUsage.costUsd,
          source: 'real',
        },
      });
      return;
    }
    const inTok = estimateMessagesTokens(promptMessages) + estimateTokens(systemPrompt);
    const outTok = estimateTokens(responseText);
    const costUsd = estimateCostUsd(turnModel, inTok, outTok);
    inputTokensAccum += inTok;
    outputTokensAccum += outTok;
    costUsdAccum += costUsd;
    sawEstimated = true;
    emitBuffered({
      tsMs: Date.now(),
      projectId,
      missionId,
      actor: 'agent',
      type: 'spend.tokens',
      payload: { tokensIn: inTok, tokensOut: outTok, costUsd, source: 'estimated' },
    });
  };

  /** Emits onMetrics (duration/tokens/cost/tool-calls/tokensSource) once, in
   *  the native loop's shape — shared by the FINAL, escalation, and
   *  MAX_STEPS termination points below. Also emits the matching journal
   *  mission.completed/mission.failed event (T0.4) — unconditionally,
   *  unlike onMetrics, since the journal must reflect the mission outcome
   *  regardless of whether a UI callback happens to be wired for this run. */
  const emitMetrics = (outcome: MissionOutcome): void => {
    const durationMs = Date.now() - startTime;
    if (onOutcome) onOutcome(outcome);
    if (onMetrics) {
      onMetrics({
        durationMs,
        inputTokens: inputTokensAccum,
        outputTokens: outputTokensAccum,
        costUsd: costUsdAccum,
        toolCount: toolCallCount,
        tokensSource: sawReal && sawEstimated ? 'mixed' : sawReal ? 'real' : 'estimated',
      });
    }
    if (outcome.type === 'completed') {
      emitBuffered({
        tsMs: Date.now(),
        projectId,
        missionId,
        actor: 'agent',
        type: 'mission.completed',
        payload: { durationMs, costUsd: costUsdAccum },
      });
    } else {
      emitBuffered({
        tsMs: Date.now(),
        projectId,
        missionId,
        actor: 'agent',
        type: 'mission.failed',
        payload: { reason: outcome.reason },
      });
    }
  };

  /** Streams one turn (tokens via addTurnTokens), swallowing errors and
   *  resolving to whatever text was collected so far (never throws). Used for
   *  the format retry and Reflexion/PRM/handoff turns — not the main turn. */
  const runTurn = async (
    turnMessages: Array<{ role: string; content: string }>,
    system: string,
    turnModel: string,
  ): Promise<string> => {
    let text = '';
    let realUsage: RealUsage | undefined;
    try {
      for await (const chunk of streamAgentTurn({
        messages: turnMessages,
        system,
        model: turnModel,
        signal,
        reasoningEffort,
        onUsage: (usage) => { realUsage = usage; },
        missionId,
        projectId,
        streamTurn,
      })) {
        text += chunk;
      }
      addTurnTokens(system, turnMessages, text, turnModel, realUsage);
    } catch {
      // Silent — best-effort turn, never aborts the main loop
    }
    return text;
  };

  /** V4 — stops the mission once MAX_CONSECUTIVE_FAILURES consecutive errored steps
   *  accumulate (instead of burning the rest of MAX_STEPS); mirrors the MAX_STEPS branch's observability. */
  const escalateAndStop = (): void => {
    onAction({
      time: nowTime(),
      text: t
        ? t('agents.managedAgent.escalation', { count: MAX_CONSECUTIVE_FAILURES })
        : `Escalade: ${MAX_CONSECUTIVE_FAILURES} échecs consécutifs — arrêt, intervention requise`,
      isLive: false,
    });
    onStep(4, 'done', `escalade · ${nowTime()}`);
    onProgress(100);
    emitMetrics({ type: 'failed', reason: 'consecutive_failures' });
  };

  /** Stuck detector (task #4, stuckDetector.ts) — aborts the mission on
   *  either pattern (repeated-identical-failure or repeated-action-
   *  observation) instead of grinding to MAX_CONSECUTIVE_FAILURES or
   *  MAX_STEPS. Mirrors escalateAndStop's shape; the `reason` on the
   *  emitted mission.failed event is prefixed `stuck_` so it's
   *  distinguishable from the coarser consecutive_failures/max_steps_exhausted
   *  outcomes in the journal/Observability panel. */
  const stopForStuckPattern = (reason: string, detail: string): void => {
    onAction({
      time: nowTime(),
      text: t
        ? t('agents.managedAgent.stuckDetected', { detail })
        : `Boucle bloquée détectée (${detail}) — arrêt, intervention requise`,
      isLive: false,
    });
    onStep(4, 'done', `bloqué · ${nowTime()}`);
    onProgress(100);
    emitMetrics({ type: 'failed', reason: `stuck_${reason}` });
  };

  /** BUG-1 — a `no_credits` ManagedUnavailableError is NOT transient: retrying
   *  hammers the same wall (managedAgent.ts's own retry loop AND, previously,
   *  recovery.ts's evaluateRecovery on top). Stop after exactly one attempt
   *  with a clear action message instead of burning consecutiveFailures.
   *  Emits via agentErrorEvent (kind=error + i18n prefix) so detection is
   *  locale-independent; runMission prefers managedOutcome.failed.reason. */
  const stopForNoCredits = (): void => {
    const message = t
      ? t('agents.managedAgent.noCreditsMessage')
      : 'Crédits Pro épuisés — recharge ou bascule sur ton abonnement CLI dans Réglages > Modèles.';
    onAction(agentErrorEvent(nowTime(), message, t));
    onStep(4, 'done', `crédits épuisés · ${nowTime()}`);
    onProgress(100);
    emitMetrics({ type: 'failed', reason: 'no_credits' });
  };

  /** 2026-08-05 DeepSeek 402 incident — mirrors stopForNoCredits above
   *  exactly, for a BYOK provider DEFINITIVE error (401/402/403/404) instead
   *  of a managed/Pro no_credits one. Same agentErrorEvent convention. */
  const PROVIDER_ERROR_MESSAGE =
    'Clé du fournisseur inutilisable (solde épuisé ou accès refusé) — mission arrêtée';

  const stopForDefinitiveProviderError = (providerId: string, shortReason: string): void => {
    onAction(
      agentErrorEvent(
        nowTime(),
        `${PROVIDER_ERROR_MESSAGE} (${providerId}: ${shortReason})`,
        t,
      ),
    );
    onStep(4, 'done', `clé fournisseur invalide · ${nowTime()}`);
    onProgress(100);
    emitMetrics({ type: 'failed', reason: 'provider_definitive_error' });
  };

  /* eslint-disable prefer-const -- effectiveSystemPrompt and lrSystemPrompt are reassigned below */
  let {
    coreTask,
    fullTaskPrompt,
    effectiveSystemPrompt,
    lrSystemPrompt,
    steeringPipeline,
  } = await prepareManagedMission({
    missionId,
    missionTitle,
    missionTask,
    agentName,
    agentDisplayName,
    agentSystemPrompt,
    worktreePath,
    projectId,
    model,
    policy,
    proofRequirements,
    prelude,
    botId,
  });
  /* eslint-enable prefer-const */

  // B38 — soft stage guide for ReAct (not a hard stage runner).
  const planGuide = opts.compiledPlan ? formatCompiledPlanGuide(opts.compiledPlan) : '';
  if (planGuide) {
    effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${planGuide}`;
    lrSystemPrompt = `${lrSystemPrompt}\n\n${planGuide}`;
  }

  onStep(0, 'in_progress');
  onAction({ time: nowTime(), text: `Managed agent starting (${model})…`, isLive: true });
  onProgress(5);

  const initialUserMessage: { role: string; content: string } = { role: 'user', content: fullTaskPrompt };

  let messages: Array<{ role: string; content: string }> = [initialUserMessage];
  let reflections: string[] = [];
  let prmInvocations = 0;
  let consecutiveFailures = 0; // V4 — reset on any successful step
  // 2026-08-14 (M6 incident) — signature of the most recent UNPARSEABLE
  // response (after the in-step format retry ALSO failed), used to detect
  // "the model is producing the exact same broken shape again" so that case
  // can escalate immediately instead of waiting out the full
  // MAX_CONSECUTIVE_FAILURES cap. A parse failure already costs 2 full
  // model calls per attempt (the original turn + the format-retry nudge) —
  // double every other failure mode's cost per attempt — so a THIRD
  // identical, guaranteed-to-fail attempt is pure waste, not a legitimate
  // extra chance. A DIFFERENT failure each time (the model is still
  // groping toward a valid response) still gets the full 3 tries — see the
  // parse-failure branch below for exactly how this is used.
  let lastUnparseableSignature: string | null = null;
  let proofNudges = 0; // V6 — bounded FINAL-bounce count, see MAX_PROOF_NUDGES
  let loopIterationCount = 0; // structural guard — see MAX_LOOP_ITERATIONS
  // V5 — "toolName:canonicalArgs" -> the step (1-based) it first actually
  // ran at. Only tools in DEDUPE_ELIGIBLE_TOOLS are tracked here.
  const executedCallsAtStep = new Map<string, number>();

  // Loop-stall guard (loopGuard.ts): full history of tool calls, used to nudge
  // the agent when it makes no file-modifying progress for many steps. Additive
  // — only appends a corrective note to the observation when genuinely stalled.
  const toolCallHistory: ToolCallRecord[] = [];

  // Stuck detector (task #4, stuckDetector.ts) — rolling history of
  // {action, args, observation, isError}, checked every step; unlike the
  // NUDGE above, a detected pattern ABORTS the mission (see
  // stopForStuckPattern) rather than just appending a corrective note.
  const stepHistory: AgentStepRecord[] = [];

  // Trace buffer for tool learning (Trace-Free+ runtime layer).
  const traceBuffer = new TraceBuffer();

  const capIo: MissionCapIo = {
    projectId,
    missionId,
    t,
    pauseSignal,
    stopSignal,
    pausePollMs: PAUSE_POLL_MS,
    onAction,
    onStep,
    onProgress,
    emitMetrics,
    nowTime,
    delay,
  };

  onStep(1, 'in_progress');
  onProgress(15);

  const aftermathIo = {
    projectId,
    missionId,
    model,
    cheapModel: CHEAP_MODEL,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    nowTime,
    onAction,
    runTurn,
    escalateAndStop,
    stopForStuckPattern,
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    loopIterationCount += 1;
    let lastTurnUsage: RealUsage | undefined;
    const next = await applyManagedLoopStep({
      state: {
        messages,
        reflections,
        consecutiveFailures,
        lastUnparseableSignature,
        proofNudges,
        prmInvocations,
        toolCallCount,
      },
      loopIterationCount,
      maxLoopIterations: MAX_LOOP_ITERATIONS,
      capIo,
      t,
      drainIntervenes,
      runTurn: (state) => runManagedTurn({
        messages: state.messages,
        reflections: state.reflections,
        boundHistory: boundMissionHistory,
        collectTurn: async (working) => {
          lastTurnUsage = undefined;
          return collectManagedTurnText(streamAgentTurn({
            messages: working,
            system: lrSystemPrompt,
            model,
            signal,
            reasoningEffort,
            onUsage: (usage) => { lastTurnUsage = usage; },
            missionId,
            projectId,
            streamTurn,
          }));
        },
        addTurnTokens: (working, turnText) => {
          addTurnTokens(lrSystemPrompt, working, turnText, model, lastTurnUsage);
        },
        consecutiveFailures: state.consecutiveFailures,
        lastUnparseableSignature: state.lastUnparseableSignature,
        maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        turnError: {
          consecutiveFailures: state.consecutiveFailures,
          maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
          nowTime,
          onAction,
          stopForNoCredits,
          stopForDefinitiveProviderError,
          escalateAndStop,
          t,
        },
        checkpoint: {
          projectRoot,
          onCheckpoint,
          missionId,
          messages: state.messages,
          step,
          costUsd: costUsdAccum,
          proofCount: attachedProofs.length,
        },
        steering: {
          pipeline: steeringPipeline,
          step,
          coreTask,
          projectId,
          missionId,
          model,
          nowTime,
          onAction,
        },
        capIo,
        getBudget: () => ({
          costUsd: costUsdAccum,
          capUsd: getBudgetCapUsd(),
          warned: budgetWarned,
          markWarned: () => { budgetWarned = true; },
          onExceeded: onBudgetExceeded,
          onPaused: onBudgetPaused,
        }),
        getDuration: () => ({
          elapsedMs: Date.now() - startTime,
          capMs: getMaxDurationMs(),
          warned: durationWarned,
          markWarned: () => { durationWarned = true; },
          onExceeded: onDurationExceeded,
          onPaused: onDurationPaused,
        }),
        retryParse: (working, cleaned) => runTurn(
          [
            ...working,
            { role: 'assistant', content: cleaned },
            { role: 'user', content: 'Please re-emit just the ACTION and ARGS lines in the exact format:\nACTION: <action>\nARGS: <json>' },
          ],
          effectiveSystemPrompt,
          model,
        ),
        step,
        t,
        nowTime,
        onAction,
        escalateAndStop,
      }),
      runAction: (turn, state) => runManagedAction({
        action: turn.action,
        args: turn.args,
        cleaned: turn.cleaned,
        messages: turn.messages,
        reflections: state.reflections,
        consecutiveFailures: state.consecutiveFailures,
        proofNudges: state.proofNudges,
        prmInvocations: state.prmInvocations,
        prmMax: PRM_MAX,
        toolCallCount: state.toolCallCount,
        step,
        maxSteps: MAX_STEPS,
        maxProofNudges: MAX_PROOF_NUDGES,
        maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        proofRequirements,
        attachedProofs,
        executedCallsAtStep,
        worktreePath,
        policy,
        agentMode,
        missionId,
        missionTitle,
        agentName,
        projectId,
        coreTask,
        model,
        t,
        nowTime,
        onAction,
        onStep,
        onProgress,
        emitMetrics,
        attachProof: handleAttachProof,
        execute: (action: string, args: Record<string, unknown>, wtp: string, pol: ToolPolicy, am: AgentPermissionMode, mid?: string, an?: string, pid?: string) =>
          executeTool(action, args, wtp, pol, am, mid, an, pid, autonomy, signal),
        traceBuffer,
        pipeline: steeringPipeline,
        toolCallHistory,
        stepHistory,
        aftermathIo,
        initialUserMessage,
      }),
    });
    if (next === 'stop') return;
    messages = next.messages;
    reflections = next.reflections;
    consecutiveFailures = next.consecutiveFailures;
    lastUnparseableSignature = next.lastUnparseableSignature;
    proofNudges = next.proofNudges;
    prmInvocations = next.prmInvocations;
    toolCallCount = next.toolCallCount;
  }

  await failManagedMaxSteps({
    maxSteps: MAX_STEPS,
    processTraces: () => traceBuffer.processAtMissionEnd(),
    nowTime,
    onAction,
    onStep,
    onProgress,
    emitMetrics,
  });
}
