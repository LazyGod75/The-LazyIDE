/* Agent runtime — Phase 2: real Claude Code agents in worktrees.
   Phase-1 scripted loop is preserved as the fallback (mock/web mode).

   Mode selection:
     - Tauri runtime + claude CLI available → real agent via agent_run
     - Otherwise → scripted fallback (browser demo, CI, no CLI)

   Event flow for live mode:
     agent_run (Rust) → agent://step/{id} events → planAndAct live
     → worktree diff → mission.status = 'review'

   Per-mission model routing: planAndAct's PRIMARY dispatch is keyed off the
   mission's own CHOSEN model (Mission.model, see classifyMissionModel)
   rather than the single globally-resolved getProviderMode() — a managed/
   OpenRouter id (contains '/') routes to planAndActManaged, a native Claude
   id/label (no '/') routes to planAndActLive, each gated on that SPECIFIC
   engine's own readiness (isManagedModelReady / isNativeModelReady) rather
   than the mutually-exclusive accessMode. This is what lets a user entitled
   to BOTH a Claude subscription and an active LazyPro plan at once (see
   modelPickerOptions.ts) actually get the engine they picked for THIS
   mission — a mismatched pick (e.g. a managed model chosen while Pro is
   inactive/out of credits) fails the mission early with a clear reason
   instead of silently running on the wrong engine with a mangled model id.
   getProviderMode()-based routing (isManagedAgentAvailable/
   isLiveAgentAvailable) remains a FALLBACK for calls with no classifiable
   model (legacy/low-level callers — see planAndAct).

   Brain-everywhere (native claude missions): memory reaches the agent in TWO
   ways now, not just one.
     1. Start injection (this file, below): brain recall + startup context are
        fetched once and folded into the initial task prompt — a snapshot as
        of mission start.
     2. Mid-mission MCP tool (Rust side, src-tauri/src/lib.rs agent_run /
        build_brain_mcp_config): when a brain exists for this project,
        agent_run additionally launches the mission with
        `--mcp-config <generated file> --strict-mcp-config` registering a
        `brain_search` tool backed by brain-search-server.mjs, so the agent
        can search memory AGAIN at any point mid-mission — a new sub-task, an
        unfamiliar file, a past decision — instead of being stuck with the
        start-of-mission snapshot. This is additive and fails open: when the
        brain/LazyBrain CLI/MCP script can't be resolved, agent_run silently
        skips the wiring and the mission runs exactly as it did before.
*/

import { invoke } from '@tauri-apps/api/core';
import type { Mission, PlanStep, ActionEvent, ProofArtifact, ProofRequirement } from '../agents/types.js';
import {
  getProviderMode,
  hasManagedCreditsActive,
  getProPlanState,
  isCliBackendAvailable,
  type ProviderMode,
} from '../models/index.js';
import { getPlatform } from '../platform/index.js';
import type { GitFile } from '../platform/index.js';
import { isVerificationMission } from './evaluator.js';
import { parseDiffFiles } from './diffParse.js';
import { detectDiffCoverageGap, isDiffGenuinelyEmpty } from './reviewPreflight.js';
import { extractPendingQuestionText } from './missionQuestion.js';
import { SILENCE_WATCHDOG_THRESHOLD_MS, SILENCE_WATCHDOG_CEILING_MS, decideSilenceTimeout } from './silenceWatchdog.js';
import { createActivityWatchdog, type ActivityWatchdog } from '../models/activityWatchdog.js';
import { StreamTimeoutError } from '../models/streamTimeout.js';
import { captureOutcome } from './captureOutcome.js';
import { planAndActManaged } from './managedAgent.js';
import { loadAccessSettings } from '../models/accessSettings.js';
import { BYOK_PROVIDER_DEFS, hasByokKey, resolveByokAgentTurnStreamer } from '../models/byokProviders.js';
import { DEFAULT_OPENROUTER_MODEL_ID, isOpenRouterFreeModel } from '../models/openrouterCatalog.js';
import { isDevinModel } from '../models/devinCatalog.js';
import { createCliAgentTurnStreamer } from './cliAgentTurnStreamer.js';
import { emitEvent, emitBuffered } from '../journal/journal.js';
import { projectIdFromRoot } from '../journal/projectId.js';
import { normalizeRepoPathForGit } from '../paths.js';
import { usdToCredits } from '../billing/credits.js';
import { prepareAndAnnounceMissionLaunch } from './runMissionPrepare.js';
import { createMissionWorktree, mergeWorktree, discardWorktree } from './runMissionWorktree.js';
import { settleAfterAgentLoop, type AgentLoopRef } from './runMissionSettle.js';
import { resolveMissionCliRoute, missionBranchName } from './runMissionRoute.js';
import { finishMissionAfterAgentLoop } from './runMissionFinish.js';
import { withRunDefaults, runtimeLabel } from './runMissionOpts.js';
import { checkNativeBudget as applyNativeBudgetStatus } from './checkNativeBudget.js';
import { runPlanAndActLive, type PlanAndActLiveOpts } from './planAndActLiveSupport.js';
import { runPlanAndActScripted, type PlanAndActScriptedOpts } from './planAndActScripted.js';
import { runPlanAndActLiveViaRunner } from './planAndActLiveViaRunner.js';
import { gateAgentSession } from './agentSessionGate.js';
import { agentErrorEvent, isAgentErrorEvent } from './agentError.js';
export { mergeWorktree, discardWorktree };

// ── Types ─────────────────────────────────────────────────────────

export interface MissionUpdate {
  id: string;
  patch: Partial<Mission>;
}

/** i18n translate function shape — matches useI18n()'s own `t` exactly (see
 *  src/i18n/index.tsx). Optional everywhere it's threaded through this
 *  engine file (runMission/planAndAct/planAndActLive/planAndActScripted/
 *  planAndActLiveViaRunner) — this is non-React code with no hook access,
 *  so every caller with a React tree above it (agentsStore.tsx) passes its
 *  own useI18n().t down through runMission's opts; every string still
 *  falls back to its ORIGINAL hardcoded French when `t` is absent (tests,
 *  low-level callers), so omitting it is never a behavior change. A few
 *  strings are DELIBERATELY excluded from this treatment — see the
 *  "Erreur agent:" prefix convention documented at doneHandler/failAllSteps
 *  below: it is a cross-file control-flow sentinel (this file's own
 *  runMission onAction handlers, managedAgent.ts's stopForNoCredits/
 *  stopForDefinitiveProviderError, recovery.ts's noCreditsPolicy) and stays
 *  French pending a dedicated structural fix (e.g. a typed ActionEvent
 *  error flag) rather than being force-translated here. */
export type TFunc = (key: string, params?: Record<string, string | number>) => string;

/**
 * Agent permission modes.
 *   "plan"        → read-only, produce a plan (--permission-mode plan)
 *   "acceptEdits" → auto-accept file edits in isolated worktrees (safe default)
 *   "full"        → full bypass (--dangerously-skip-permissions), explicit user opt-in only
 */
export type PermissionMode = 'plan' | 'acceptEdits' | 'full';

export interface RunOptions {
  /** Called on every incremental update during the run. */
  onUpdate: (update: MissionUpdate) => void;
  /** Promise that resolves to true when the run should abort. */
  stopSignal?: () => boolean;
  /**
   * Real mid-stream cancellation channel — see PlanAndActManagedOpts.signal
   * (managedAgent.ts) for the full rationale. stopSignal alone only stops
   * the NEXT turn from starting; this aborts a turn already in flight
   * (managed/Pro rail and BYOK rails abort the HTTP turn; native CLI
   * tree-kills the tracked PID via agent_run_kill: SIGINT / taskkill
   * without /F, then force after a drain window). Forwarded to
   * planAndActManaged and to the native live loop. Scripted/web engines
   * still ignore it. Optional so callers without an AbortController keep
   * compiling and behaving unchanged.
   */
  signal?: AbortSignal;
  /** Parallel to stopSignal — real for managed missions (between ReAct steps)
   *  and native missions (stop-then-resume via agent_run_kill + `--resume`,
   *  see planAndActLiveSupport.ts). */
  pauseSignal?: () => boolean;
  /** Drains queued user interventions once per step — real for managed
   *  missions only. Native one-shot processes have no mid-run inject hook. */
  drainIntervenes?: () => string[];
  /** Permission mode to pass to the agent runner (default = 'acceptEdits'). */
  permissionMode?: PermissionMode;
  /** Tool allowlist passed as --allowedTools to claude CLI. */
  allowedTools?: string[];
  /** Tool denylist passed as --disallowedTools to claude CLI. */
  deniedTools?: string[];
  /**
   * Live getter for the mission's budget cap (T1.3, spec §7.3/§8) — a
   * GETTER (not a frozen number) so raising `contract.budgetCapUsd` via
   * updateMission mid-run (resume-after-raise) is visible on the managed
   * loop's very next step-boundary check, same contract as pauseSignal
   * above. Ignored by the native engine (see runMission's own doc comment
   * on why native reads mission.contract directly instead). Default:
   * unlimited (0/absent).
   */
  getBudgetCapUsd?: () => number | undefined;
  /**
   * Called ONCE by the managed engine when a run pauses itself at >=90%
   * spend (T1.3) — real implementations flip the SAME pauseFlags cell
   * pauseMission/resumeMission use, so the mission is resumable via the
   * existing Resume button with no extra state to reconcile. No effect on
   * native missions (one-shot, no mid-run pause hook — see
   * isLiveAgentAvailable's doc comment).
   */
  onBudgetPaused?: () => void;
  /**
   * W-GUARD — live getter for the mission's wall-clock cap (mirrors
   * getBudgetCapUsd above). Managed engine only — native enforces its own
   * hard cap via a real timer (armDurationExceededTimer below), since
   * elapsed time (unlike cost) is knowable in real time without any CLI
   * event. Default: unlimited (0/absent).
   */
  getMaxDurationMs?: () => number | undefined;
  /**
   * Called ONCE by the managed engine when a run pauses itself at >=90%
   * elapsed wall-clock (mirrors onBudgetPaused exactly — same pauseFlags
   * cell, same Resume path).
   */
  onDurationPaused?: () => void;
  /** Optional i18n translate function — see {@link TFunc}'s doc comment.
   *  Threaded through the whole engine so the mission action feed follows
   *  the caller's active locale instead of always rendering French. */
  t?: TFunc;
}

// ── Internal helpers ──────────────────────────────────────────────

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// NOTE: intentionally NOT imported from platform/index.ts's isTauri(), even
// though the check is identical. Many test files
// `vi.mock('../lib/platform', () => ({ getPlatform: ... }))` with a FULL
// (non-partial) mock that omits isTauri — importing it here made those
// mocks throw "No isTauri export is defined on the mock" the instant this
// module's evaluated code path called it. Kept local until that test-mock
// convention is addressed (see review report).
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when a live agent backend is available (Tauri + claude CLI or codex CLI).
 *  This is the NATIVE loop: real claude/codex CLI tool-use via agent_run,
 *  authentic permission-mode enforcement, and agent://step + onMetrics events.
 *
 *  Pause/Intervene honesty note: this loop runs agent_run -> a ONE-SHOT
 *  `claude -p` process per pass (stop = agent_run_kill, see planAndActLive's
 *  pollStop). True mid-call pause between tool calls is not available, but
 *  B22 stop-then-resume IS: pause kills the tracked PID, captures session_id
 *  from the done event, waits on pauseSignal, then relaunches with
 *  `--resume <session_id>`. Intervene still has no mid-run injection point.
 *  planAndActLive receives pauseSignal (not drainIntervenes) — the UI keeps
 *  Intervene honest for native missions. */
export function isLiveAgentAvailable(): boolean {
  if (!isTauriRuntime()) return false;
  const mode = getProviderMode();
  return mode === 'claude-code' || mode === 'codex';
}

/** P4.3 — True when a native mission can be resumed via session ID.
 *  Requires the claude CLI (codex has no --resume support).
 *  The mission must have a captured sessionId in its metrics. */
export function canResumeNative(missionMetrics?: { sessionId?: string }): boolean {
  if (!isTauriRuntime()) return false;
  return !!missionMetrics?.sessionId;
}

/** True when the managed agent (Pro tier) can run via the ai-proxy.
 *  Strictly 'managed' — claude-code/codex are native CLI tools and must
 *  always route to the live loop (see isLiveAgentAvailable / planAndActLive),
 *  never to the reimplemented ReAct loop in managedAgent.ts. claude-code used
 *  to also match here, which silently downgraded real CLI missions onto the
 *  managed loop instead of the native agent_run loop. */
export function isManagedAgentAvailable(): boolean {
  if (!isTauriRuntime()) return false;
  return getProviderMode() === 'managed';
}

// ── Per-mission model routing ──────────────────────────────────────
//
// isManagedAgentAvailable/isLiveAgentAvailable above answer "what is the
// CURRENT globally-resolved engine" — a single, mutually-exclusive
// getProviderMode() value. Real missions no longer dispatch off that alone
// (see planAndAct): they dispatch off the SPECIFIC model the user picked for
// THIS mission, so a user holding both a Claude subscription and an active
// LazyPro plan gets the engine they actually chose rather than whichever one
// accessMode happens to resolve to. The two helpers above remain in active
// use for: (a) planAndAct's fallback when a call carries no classifiable
// model, and (b) other call sites that genuinely want "the current engine"
// (pause/intervene gating in agentsStore.tsx, ReviewSpace, MissionDetail).

export type ModelRouteKind = 'managed' | 'native' | 'byok' | 'devin';

/** OpenRouter (managed) ids always carry a '/' (e.g. 'openai/gpt-5.5',
 *  'anthropic/claude-sonnet-5'); native Anthropic ids/labels never do
 *  (e.g. 'claude-sonnet-5', 'Claude Sonnet 5') — see registry.ts /
 *  openrouterCatalog.ts's own "never mix them" contract. Same convention
 *  already used by evaluator.ts's resolveManagedModel, modelPickerOptions.ts,
 *  and Composer.tsx's handleModelSelect. BYOK wave: a model id from a
 *  non-Anthropic BYOK provider catalog (deepseek-chat, deepseek-reasoner,
 *  grok-4, ...) routes to the BYOK ReAct loop when that provider's key is
 *  set — the user's own key, no CLI, no Pro credits. Returns undefined for
 *  an empty/absent model — callers fall back to mode-based routing. */
export function classifyMissionModel(model: string | undefined): ModelRouteKind | undefined {
  if (!model) return undefined;
  if (model.includes('/')) return 'managed';
  for (const def of BYOK_PROVIDER_DEFS) {
    if (def.id === 'anthropic') continue;
    if (def.models.some((m) => m.id === model) && hasByokKey(def.id)) return 'byok';
  }
  // Devin-catalog ids (swe-2-medium, ...) get their own route — the Devin
  // CLI can't run the native code-agent rail (planAndActLive is the claude
  // agent_run path), but it CAN serve as the managed loop's brain via
  // createCliAgentTurnStreamer — same pattern as the BYOK route.
  if (isDevinModel(model)) return 'devin';
  return 'native';
}

/** Mode-INDEPENDENT readiness for the MANAGED engine — true when credits are
 *  actively usable, OR the billing layer's first subscription fetch simply
 *  hasn't settled yet (getProPlanState() === 'unknown'). Mirrors
 *  entitlement.ts's proReadiness() optimistic cold-start handling so a real
 *  Pro user launching a mission in the first seconds after app start never
 *  sees a false "Pro inactive" rejection; only a SETTLED non-active plan (or
 *  a settled active plan with 0 credits) is not-ready. Unlike
 *  isManagedAgentAvailable(), this ignores accessMode entirely — it answers
 *  "is Pro itself usable", not "is Pro the CURRENTLY SELECTED engine". */
export function isManagedModelReady(): boolean {
  if (!isTauriRuntime()) return false;
  return hasManagedCreditsActive() || getProPlanState() === 'unknown';
}

/** Mode-INDEPENDENT readiness for the NATIVE engine — true when EITHER CLI
 *  backend (claude or codex; which one actually EXECUTES stays driven by
 *  providerMode/settings elsewhere, unchanged) is confirmed present, or
 *  detection simply hasn't finished yet (isCliBackendAvailable returns null
 *  during the startup window — same optimistic treatment as entitlement.ts's
 *  cliReadiness()). Only not-ready once BOTH are confirmed absent. Unlike
 *  isLiveAgentAvailable(), this ignores accessMode entirely. */
export function isNativeModelReady(): boolean {
  if (!isTauriRuntime()) return false;
  return isCliBackendAvailable('claude') !== false
    || isCliBackendAvailable('codex') !== false
    || isCliBackendAvailable('devin') !== false;
}

// ── Worktree Tauri bridge ─────────────────────────────────────────

export async function worktreeDiff(worktreePath: string): Promise<string> {
  return invoke<string>('agent_worktree_diff', { worktreePath: normalizeRepoPathForGit(worktreePath) });
}

/** True when `relPath` (forward-slash, as `git status` prints it) is Lazy's
 *  own worktree-management infrastructure rather than mission output —
 *  mirrors git.rs's `is_agent_infra_path`. The worktree carries no
 *  .gitignore (the root project's own ignore file is itself untracked, so a
 *  worktree checkout never includes it — see agent_merge_worktree_inner's
 *  doc comment), so a blind "stage everything dirty" would also stage
 *  `.lazybrain/`'s cache files (including a SQLite file the running app can
 *  hold open) and `.lazy/`'s own bookkeeping onto the mission branch. */
function isAgentInfraPath(relPath: string): boolean {
  return (
    relPath === '.lazy' ||
    relPath.startsWith('.lazy/') ||
    relPath === '.lazybrain' ||
    relPath.startsWith('.lazybrain/')
  );
}

/**
 * Deterministic safety net (M3 forensics): an implementer that writes real
 * files but never commits them inside its own worktree leaves them
 * untracked/modified. Nothing durably records that work as a commit, so a
 * later discard/checkout/crash can still lose it. Stages and commits
 * whatever is dirty (excluding Lazy's own infra paths, see
 * isAgentInfraPath) under a clearly-labelled harness message, so the
 * worktree's on-disk state is never silently lost after this point.
 *
 * MUST be called AFTER the mission diff (worktreeDiff) has already been
 * computed and captured into Step C's local variables, never before:
 * worktreeDiff's own mechanism (agent_worktree_diff_inner) is `git diff
 * HEAD` plus a manual untracked-file patch — committing first would leave
 * nothing uncommitted left to diff, so `git diff HEAD` would report an
 * EMPTY diff immediately after (the exact defect this function exists to
 * prevent, reintroduced one step earlier). Snapshotting only AFTER the
 * diff is already safely captured avoids that trap while still making the
 * worktree durable before Step F's evaluation runs.
 *
 * Never throws — best-effort. A no-op when nothing is dirty, so a mission
 * whose implementer already committed its own work is unaffected.
 */
async function snapshotDirtyWorktreeIfNeeded(worktreePath: string, files: GitFile[]): Promise<void> {
  const dirtyPaths = files.map((f) => f.path).filter((p) => !isAgentInfraPath(p));
  if (dirtyPaths.length === 0) return;

  try {
    await getPlatform().git.stage(worktreePath, dirtyPaths);
    await getPlatform().git.commit(
      worktreePath,
      'chore(agent): snapshot uncommitted deliverable before review',
    );
  } catch {
    // Best-effort: a staging/commit failure leaves the worktree exactly as
    // it was — the diff already captured above is unaffected either way,
    // so a mission is never blocked by this safety net failing.
  }
}

/** Result of {@link computeMissionDiff} — the exact shape Step C (below, in
 *  runMission) used to compute inline. */
interface ComputedMissionDiff {
  diffSnippet: string[];
  diffAdded: number;
  diffRemoved: number;
  diffFiles: Array<{ filename: string; added: number; removed: number }>;
  diffIncompleteFiles: string[];
  emptyDeliverable: boolean;
}

/**
 * Computes a mission's real worktree diff + "is there actually a
 * deliverable" verdict. Extracted (2026-08-19 budget-cap incident fix, Fix
 * A) from runMission's own Step C so the SAME logic can also run BEFORE a
 * budget/duration cap stop decides whether to discard the worktree
 * (settleCapExceeded below) — a cap crossing must never destroy a genuine
 * deliverable, exactly like the pre-existing stepCapFallthroughReason
 * salvage path already refuses to for a managed step-cap stop. Never
 * throws — every sub-step (worktreeDiff, git.status, the dirty-worktree
 * snapshot) is already individually defensive; see each call's own
 * doc comment for its specific fallback.
 */
async function computeMissionDiff(worktreePath: string, mission: Mission): Promise<ComputedMissionDiff> {
  let diffSnippet: string[] = [];
  let diffAdded = 0;
  let diffRemoved = 0;
  let diffFiles: Array<{ filename: string; added: number; removed: number }> = [];

  try {
    const rawDiff = await worktreeDiff(worktreePath);
    if (rawDiff) {
      const lines = rawDiff.split('\n').slice(0, 40);
      diffSnippet = lines;
      const parsed = parseDiffFiles(rawDiff);
      diffFiles = parsed;
      diffAdded = parsed.reduce((sum, f) => sum + f.added, 0);
      diffRemoved = parsed.reduce((sum, f) => sum + f.removed, 0);
    }
  } catch {
    // Worktree diff unavailable (web/mock mode) — empty diff, no fake file
    diffSnippet = [];
    diffFiles = [];
    diffAdded = 0;
    diffRemoved = 0;
  }

  // Trust-critical defect #1 (M53 forensics) — cross-check the worktree's
  // REAL git status against what the diff above actually attributes lines
  // to. See runMission's original Step C comment (git history) for the
  // full rationale; unchanged by this extraction.
  let diffIncompleteFiles: string[] = [];
  if (isTauriRuntime()) {
    try {
      const status = await getPlatform().git.status(worktreePath);
      diffIncompleteFiles = detectDiffCoverageGap(status.files, diffFiles);
      await snapshotDirtyWorktreeIfNeeded(worktreePath, status.files);
    } catch {
      diffIncompleteFiles = [];
    }
  }

  // Trust-critical defect #2 (M2 forensics) — see isDiffGenuinelyEmpty's own
  // doc comment; unchanged by this extraction.
  const emptyDeliverable =
    isDiffGenuinelyEmpty({ diffFiles, diffSnippet, diffAdded, diffRemoved }) &&
    !isVerificationMission({ ...mission, diffFiles, diffSnippet });

  return { diffSnippet, diffAdded, diffRemoved, diffFiles, diffIncompleteFiles, emptyDeliverable };
}

/**
 * mergeWorktree / discardWorktree live in runMissionWorktree.ts (path
 * normalization at the IPC boundary). Re-exported above so existing
 * callers (agentsStore.tsx, tests) keep importing from this module.
 */

/**
 * Best-effort kill of a native agent_run process by mission id. A no-op
 * (never invokes) outside Tauri, and a harmless no-op INSIDE Tauri too when
 * the mission was never native or has already finished — agent_run_kill
 * (Rust) simply skips any id it doesn't have a tracked PID for.
 *
 * Exported so agentsStore.tsx's stopMission/stopAll can issue the kill
 * BEFORE attempting worktree cleanup, instead of leaving the two to race
 * independently. Real-app QA traced a leaked worktree on Stop/Cancel back to
 * exactly that race: cleanup used to fire as soon as it was invoked, fully
 * uncoordinated with the actual process kill (which only happens on
 * planAndActLive's separate ~200ms `pollStop` tick in this same file) — so
 * cleanup could run while the just-stopped CLI child (or a lingering
 * grandchild it spawned via a shell tool call) still held the worktree
 * directory as its current working directory, which Windows refuses to
 * remove out from under a live process. Calling this first closes most of
 * that window; git.rs's worktree_cleanup module additionally retries
 * through whatever remains of it (Windows does not guarantee a handle is
 * released the instant a killed process's taskkill call returns).
 */
export async function killAgentRun(missionId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke('agent_run_kill', { id: missionId }).catch(() => {
    // Best-effort — see doc comment above.
  });
}

// ── Budget enforcement (T1.3, spec §7.3/§8) ────────────────────────

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

/**
 * Pure: classifies cumulative mission spend against `contract.budgetCapUsd`.
 * 0/absent/negative cap => 'ok' always (unlimited — spec §7.3's documented
 * default when a mission has no contract or the field was never touched).
 * >=90% -> 'warning' (pause + Inbox alert), >=100% -> 'exceeded' (hard stop,
 * non-bypassable except by explicitly raising the cap — spec §11).
 *
 * Exported for unit testing (budgets.test.ts) and reused by runMission's
 * native post-hoc check below. The managed loop (managedAgent.ts) keeps an
 * identical PRIVATE copy rather than importing this one, to avoid a
 * value-level circular import between the two engine modules (runtime.ts
 * already imports planAndActManaged FROM managedAgent.ts) — see that file's
 * classifyBudgetStatus for the mirrored implementation.
 */
export function classifyBudget(costUsd: number, capUsd: number | undefined): BudgetStatus {
  if (!capUsd || capUsd <= 0) return 'ok';
  const ratio = costUsd / capUsd;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= 0.9) return 'warning';
  return 'ok';
}

/**
 * Fix C (2026-08-19 incident) — builds the mission-stopped message from the
 * REAL measured spend and the REAL cap, with a COMPUTED percentage. Replaces
 * the previous literal "100% of the cap reached" wording, which was always
 * false whenever the true overshoot differed from exactly 100% (real
 * incident: five missions on a $5 cap stopped at $5.02–$13.69, i.e.
 * 100%–274% — every one reported as "100%"). Pure — exported for direct
 * unit testing.
 *
 * Fix D (2026-08-19 dollar-kill incident, display half): this function is
 * now ONLY ever reached for a rail where the cap crossing is real —
 * checkNativeBudget's `isNativeRail` branch (runtime.ts) short-circuits the
 * native/subscription rail before `budgetExceeded` is ever set, so this
 * only fires for the managed engine's own live enforcement (onBudgetExceeded)
 * or the BYOK rail (the user's own provider key — still real money, just not
 * Lazy's). Rendered in CREDITS via billing/credits.ts's usdToCredits (the
 * single "1 credit == 1 USD cent" conversion every other real-spend surface
 * in this app already uses — CostChip.tsx's real-spend branch, the Pro
 * balance), never a raw `$`/`€` figure — `spentUsd`/`capUsd` stay the
 * function's own parameter names (internal USD bookkeeping, unchanged) but
 * are converted before formatting.
 */
export function formatBudgetExceededMessage(
  spentUsd: number,
  capUsd: number,
  t?: TFunc,
): { text: string; reason: string } {
  const pct = capUsd > 0 ? Math.round((spentUsd / capUsd) * 100) : 0;
  const params = { spentCredits: usdToCredits(spentUsd), capCredits: usdToCredits(capUsd), pct };
  const text = t
    ? t('agents.runtime.budgetExceededStop', params)
    : `Mission arrêtée — ${params.spentCredits} crédits consommés sur un plafond de ${params.capCredits} crédits (${pct}%)`;
  const reason = t
    ? t('agents.runtime.budgetExceededReason', params)
    : `${text}.`;
  return { text, reason };
}

// ── Wall-clock cap enforcement (W-GUARD) ───────────────────────────

/**
 * Fix D (2026-08-19 dollar-kill incident, runaway-guard half) — the native
 * rail's own fallback wall-clock cap, applied by runMission ONLY when a
 * mission's contract sets no explicit `maxDurationMs` (types.ts's own doc
 * comment: absent/0/negative -> "unlimited" was an ACCEPTABLE default while
 * a native overshoot still hit the dollar kill in checkNativeBudget as a
 * backstop; now that that kill is gone for the native rail — see
 * checkNativeBudget's `isNativeRail` branch — an unset cap would leave a
 * native mission with NO bound at all).
 *
 * 2 hours: generous enough to never cut off a legitimate long-running
 * documentation/refactor mission (the incident's own missions ran minutes,
 * not hours), short enough to reclaim a genuinely stuck process (a looping
 * tool call with no natural exit). Expressed in wall-clock time — the ONLY
 * signal the native engine can react to mid-run without a live cost/turn
 * count (see armDurationExceededTimer's own doc comment) — never dollars.
 * Exported so the choice is directly assertable in tests rather than a
 * magic number duplicated at each call site. The managed engine is
 * untouched: it never reads this constant, only mission.contract.maxDurationMs
 * via its own live per-step getMaxDurationMs getter.
 */
export const NATIVE_DEFAULT_MAX_DURATION_MS = 2 * 60 * 60_000;

/**
 * Pure: classifies elapsed wall-clock against `contract.maxDurationMs`.
 * Mirrors classifyBudget EXACTLY (see that function's own doc comment) —
 * exported for direct unit testing and for parity with classifyBudget, even
 * though the native engine below enforces its cap via a real timer rather
 * than by calling this (elapsed time doesn't need a reactive check the way
 * post-hoc cost does). The managed engine (managedAgent.ts) keeps an
 * identical PRIVATE copy (classifyDurationStatus) for the same
 * avoid-a-circular-import reason as its classifyBudgetStatus.
 */
export function classifyDuration(elapsedMs: number, capMs: number | undefined): BudgetStatus {
  if (!capMs || capMs <= 0) return 'ok';
  const ratio = elapsedMs / capMs;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= 0.9) return 'warning';
  return 'ok';
}

/** Fix C twin for the wall-clock cap — see formatBudgetExceededMessage's own
 *  doc comment for the full rationale (same hardcoded-"100%" defect fixed
 *  the same way). `elapsedMs`/`capMs` are rendered in minutes, 1 decimal
 *  place. Pure — exported for direct unit testing. */
export function formatDurationExceededMessage(
  elapsedMs: number,
  capMs: number,
  t?: TFunc,
): { text: string; reason: string } {
  const pct = capMs > 0 ? Math.round((elapsedMs / capMs) * 100) : 0;
  const params = { elapsed: (elapsedMs / 60_000).toFixed(1), cap: (capMs / 60_000).toFixed(1), pct };
  const text = t
    ? t('agents.runtime.durationExceededStop', params)
    : `Mission arrêtée — ${params.elapsed}min écoulées sur un plafond de ${params.cap}min (${pct}%)`;
  const reason = t
    ? t('agents.runtime.durationExceededReason', params)
    : `${text}.`;
  return { text, reason };
}

/**
 * Arms the native engine's hard-stop timer for a mission's wall-clock cap
 * (MissionContract.maxDurationMs). Unlike budget enforcement — which for
 * native is necessarily post-hoc (cost is only known once the one-shot CLI
 * process has already exited, see checkNativeBudget's doc comment) —
 * elapsed time is knowable in real time with a plain timer, so this
 * PROACTIVELY fires `onExceeded` at the cap even if the mission has gone
 * silent (a single long tool call with no intervening onAction/onMetrics
 * tick would otherwise never trip a reactive check).
 *
 * undefined/0/negative `maxDurationMs` -> no timer armed (unlimited, no
 * behavior change) and `clear()` is a harmless no-op. The managed engine
 * never calls this — it enforces its own cap live, per ReAct step (see
 * managedAgent.ts), so runMission only arms this for the native branch.
 */
export function armDurationExceededTimer(
  maxDurationMs: number | undefined,
  onExceeded: () => void,
): { clear: () => void } {
  if (!maxDurationMs || maxDurationMs <= 0) return { clear: () => {} };
  const timer = setTimeout(onExceeded, maxDurationMs);
  return { clear: () => clearTimeout(timer) };
}

// ── Phase-2: real planAndAct via agent_run ─────────────────────────

/**
 * PHASE 2: Real agent loop.
 * Calls agent_run (Rust) which spawns claude in the worktree, then streams
 * structured step events back. We map those to mission timeline updates.
 */
export interface AgentMetrics {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCount: number;
  /**
   * Provenance of inputTokens/outputTokens/costUsd for a MANAGED
   * (managedAgent.ts) run — 'real' when every accounted turn received the
   * ai-proxy's post-settlement usage marker, 'estimated' when none did
   * (ceil(chars/4) fallback — e.g. an older ai-proxy deployment, or the
   * claude-code/native backend routed through the same loop), 'mixed' when
   * some turns had real usage and others fell back. Always undefined for
   * this file's OWN native planAndActLive below (Rust agent_run path) —
   * those numbers already come straight from the CLI, never estimated, so
   * the distinction doesn't apply.
   */
  tokensSource?: 'real' | 'estimated' | 'mixed';
  /**
   * Prompt-cache READ tokens (M12 dogfood fix, undercount honesty) — see
   * types.ts's AgentMetrics.cacheReadInputTokens (the Mission-snapshot
   * twin of this runtime-local interface) for the full rationale. undefined
   * when the backend never reported the field, never a fabricated 0.
   */
  cacheReadInputTokens?: number;
  /** P4.2 — claude CLI session ID for resume. undefined when not reported. */
  sessionId?: string;
}

async function planAndActLive(opts: PlanAndActLiveOpts): Promise<void> {
  return runPlanAndActLive(opts);
}

// ── Phase-1: scripted fallback ─────────────────────────────────────


/**
 * PHASE 1: Scripted plan-and-act function (fallback for mock/browser mode).
 * Executes a fixed sequence of steps with real file writes in the worktree.
 */
async function planAndActScripted(opts: PlanAndActScriptedOpts): Promise<void> {
  return runPlanAndActScripted(opts);
}

// ── No real engine available: explicit failure ─────────────────────
//
// 'pro' (selected but inactive), 'live-key' (BYOK Anthropic key — no agent
// loop wired up for it yet, only the chat assistant uses it directly), and
// desktop 'mock' (auto-detect found nothing) have no agent engine behind
// them. Previously these silently ran planAndActScripted, which fakes a
// successful run by writing a placeholder LAZY_AGENT_NOTES.md. That is only
// honest on the web/browser demo surface (no Tauri IPC backend exists there
// at all — see the final branch of planAndAct). On the desktop app it must
// fail the mission explicitly instead of pretending to have done the work.

/** Explanation for why no mission could run. Translated via `t` when
 *  supplied (2026-08 i18n pass) — falls back to the ORIGINAL hardcoded
 *  French otherwise, same optional-everywhere contract as the rest of this
 *  file (see TFunc's doc comment). Safe to translate freely: unlike
 *  NO_CREDITS_MESSAGE (managedAgent.ts), this text never feeds
 *  recovery.ts's keyword-matching policies (isEnvironmentalError/
 *  isTaskFailure/isNoCreditsError) in either language, so evaluateRecovery
 *  always falls through to the same defaultPolicy regardless of locale. */
function unavailableEngineMessage(mode: ProviderMode, t?: TFunc): string {
  return t
    ? t('agents.runtime.unavailableEngine', { mode })
    : `Backend indisponible : le mode "${mode}" n'est pas configuré pour exécuter des missions. Configure Claude Code ou Codex (CLI), ou active l'abonnement Pro, dans Réglages > Modèles.`;
}

/** Explanation for a mission whose CHOSEN model unambiguously belongs to one
 *  engine family (see classifyMissionModel) but that specific engine isn't
 *  usable right now — distinct from unavailableEngineMessage above (no
 *  engine configured AT ALL): here the user picked a valid model, but its
 *  entitlement/CLI is momentarily missing (Pro inactive/out of credits for a
 *  managed pick, no CLI detected for a native pick) — a precise,
 *  one-step-fixable mismatch. Translated via `t` — see
 *  unavailableEngineMessage's doc comment above for why this is safe
 *  (never matched by recovery.ts's keyword policies). */
function modelMismatchMessage(kind: ModelRouteKind, t?: TFunc): string {
  if (kind === 'managed') {
    return t
      ? t('agents.runtime.modelMismatchManaged')
      : "Modèle managé choisi mais LazyPro est inactif ou les crédits sont épuisés. Active LazyPro ou choisis un modèle de l'abonnement Claude dans Réglages > Modèles.";
  }
  if (kind === 'byok') {
    return t
      ? t('agents.runtime.modelMismatchByok')
      : "Modèle BYOK choisi mais aucune clé API n'est configurée pour ce provider. Ajoute ta clé dans Réglages > Modèles, puis clique « Utiliser ».";
  }
  if (kind === 'devin') {
    return t
      ? t('agents.runtime.modelMismatchDevin')
      : "Modèle Devin choisi mais le CLI Devin est introuvable ou non connecté. Installe/connecte Devin (devin auth login) ou choisis un autre modèle dans Réglages > Modèles.";
  }
  return t
    ? t('agents.runtime.modelMismatchNative')
    : 'Modèle Claude choisi mais le CLI Claude est introuvable. Installe/connecte Claude Code (CLI) ou choisis un modèle LazyPro dans Réglages > Modèles.';
}

/** Marks every plan step 'done' with an error marker and posts the failure
 *  text to the timeline — the shared terminal shape both planAndActUnavailable
 *  (no engine configured at all) and planAndActMismatch (chosen model's
 *  engine not ready) reduce to, so runMission's existing agentFailed →
 *  recovery → status:'failed' handling applies unchanged either way.
 *
 *  i18n: display text uses `agentErrorEvent` (localized prefix via `t`);
 *  detection keys off `ActionEvent.kind === 'error'` / `isAgentErrorEvent`
 *  so a translated prefix never breaks runMission recovery. */
function failAllSteps(
  message: string,
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void,
  onAction: (event: ActionEvent) => void,
  onProgress: (pct: number) => void,
  t?: TFunc,
): void {
  onAction(agentErrorEvent(nowTime(), message, t));
  onStep(0, 'done', `erreur · ${nowTime()}`);
  onStep(1, 'done', `erreur · ${nowTime()}`);
  onStep(2, 'done', `erreur · ${nowTime()}`);
  onStep(3, 'done', `erreur · ${nowTime()}`);
  onStep(4, 'done', `erreur · ${nowTime()}`);
  onProgress(100);
}

/**
 * No managed/live engine is wired up for this mode on the Tauri desktop
 * runtime. Marks every plan step as failed and reports through the same
 * "Erreur agent: …" timeline convention planAndActLive uses, so runMission's
 * existing agentFailed → recovery → status:'failed' handling applies
 * unchanged (worktree cleanup, retry policy, human-readable failure message).
 */
async function planAndActUnavailable(opts: {
  mode: ProviderMode;
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onAction: (event: ActionEvent) => void;
  onProgress: (pct: number) => void;
  t?: TFunc;
}): Promise<void> {
  failAllSteps(unavailableEngineMessage(opts.mode, opts.t), opts.onStep, opts.onAction, opts.onProgress, opts.t);
}

/**
 * The mission's CHOSEN model unambiguously identifies an engine family
 * (classifyMissionModel), but that specific engine (isManagedModelReady /
 * isNativeModelReady) is not usable right now. Deliberately a SEPARATE path
 * from planAndActUnavailable (no engine configured at all): the failure here
 * is a precise mismatch the user can resolve in one step (switch model, or
 * fix the engine), so it gets its own message instead of the generic one —
 * see modelMismatchMessage. Same terminal shape (failAllSteps).
 */
async function planAndActMismatch(opts: {
  kind: ModelRouteKind;
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onAction: (event: ActionEvent) => void;
  onProgress: (pct: number) => void;
  t?: TFunc;
}): Promise<void> {
  failAllSteps(modelMismatchMessage(opts.kind, opts.t), opts.onStep, opts.onAction, opts.onProgress, opts.t);
}

// ── planAndAct dispatcher ─────────────────────────────────────────

/**
 * Dispatcher: routes each mission by its CHOSEN MODEL first (see
 * classifyMissionModel), falling back to the active provider mode
 * (getProviderMode) only when the call carries no classifiable model.
 * Routing table:
 *
 *   model contains '/' (managed/OpenRouter id) + isManagedModelReady()
 *     -> planAndActManaged, model forwarded UNMANGLED (any provider —
 *        anthropic/openai/google/x-ai/deepseek/meta-llama)
 *   model contains '/' but managed NOT ready (Pro inactive/out of credits)
 *     -> planAndActMismatch — fails early with a clear reason, never
 *        silently falls back to native
 *   model has no '/' (native Claude id/label) + isNativeModelReady()
 *     -> planAndActLive (native agent_run loop)
 *   model has no '/' but no native CLI detected
 *     -> planAndActMismatch — fails early with a clear reason
 *   no classifiable model on this call (legacy/low-level callers) — falls
 *   back to the PREVIOUS mode-based routing, unchanged:
 *     'claude-code' | 'codex'        -> planAndActLive
 *     'managed'                      -> planAndActManaged
 *     'pro' | 'live-key' | 'mock'    -> planAndActUnavailable, IF running on
 *                                        the Tauri desktop runtime (no engine
 *                                        wired up — fail explicitly instead
 *                                        of faking success)
 *     any mode, non-Tauri runtime    -> planAndActScripted (web/browser demo
 *                                        only — no Tauri IPC backend exists
 *                                        there at all)
 */
export async function planAndAct(opts: {
  missionId: string;
  missionTitle: string;
  missionTask?: string;
  agentName?: string;
  worktreePath: string;
  steps: PlanStep[];
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onAction: (event: ActionEvent) => void;
  onProgress: (pct: number) => void;
  onMetrics?: (metrics: AgentMetrics) => void;
  /** Managed-loop terminal outcome — see PlanAndActManagedOpts.onOutcome.
   *  Forwarded to planAndActManaged via the spread; ignored by the native
   *  and scripted paths (which signal failure via onAction "Erreur agent:"). */
  onOutcome?: (outcome: { type: 'completed' } | { type: 'failed'; reason: string }) => void;
  stopSignal: () => boolean;
  /** Real mid-stream abort channel — see RunOptions.signal's doc comment.
   *  Forwarded to planAndActManaged and to the native live loop (kill). */
  signal?: AbortSignal;
  /** Real for managed (between ReAct steps) and native (stop-then-resume). */
  pauseSignal?: () => boolean;
  /** Real for the managed path only — see planAndActManaged/isLiveAgentAvailable. */
  drainIntervenes?: () => string[];
  /** Native pause captured a CLI session — store should mark Mission.paused. */
  onPaused?: (sessionId?: string) => void;
  /** Native resume after pause — store should clear Mission.paused. */
  onResumed?: () => void;
  /** Resume a prior native CLI session (`--resume`). */
  resumeSessionId?: string;
  tool?: string;
  model?: string;
  /** Soft ReAct stage guide — see PlanAndActManagedOpts.compiledPlan. */
  compiledPlan?: import('./stageContract.js').CompiledPlan;
  /**
   * The mission's raw chosen model (Mission.model, unmodified — see
   * runMission). Doubles as the routing-classification signal
   * (classifyMissionModel: an OpenRouter id always contains '/', a native
   * Claude id/label never does) AND, for a managed pick, the exact id
   * forwarded to the managed loop unmangled. Only falls back to the user's
   * saved OpenRouter preference / the catalog default in the mode-based
   * fallback branch below (no classifiable model on this call).
   */
  managedModel?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
  /** Cross-project READ access (see Mission.extraReadableRoots' doc comment,
   *  types.ts, for the full contract and security model). Forwarded from
   *  runMission's `mission.extraReadableRoots`; native-only — consumed by
   *  planAndActLive/planAndActLiveViaRunner (both append it to the
   *  agent_run request as `extraReadableRoots`); the managed branch ignores
   *  it (no native CLI process to grant `--add-dir` to). */
  extraReadableRoots?: string[];
  /** Journal envelope projectId — see runMission, which always sets this on
   *  every real mission run. Optional here (rather than required) only so
   *  the existing low-level dispatch tests (runtimeDispatch.test.ts,
   *  runtimeBrainMcp.test.ts, runtimeModelRouting.test.ts) that construct
   *  this opts shape directly, without a projectId, keep compiling
   *  unchanged — planAndActLive falls back to '' when absent. Forwarded
   *  unchanged to whichever engine loop this call dispatches to (native:
   *  consumed by planAndActLive's own emissions above; managed: passed
   *  through the `...opts` spread below for managedAgent.ts's own
   *  instrumentation, which declares no `projectId` field of its own but
   *  tolerates the extra property since it always arrives via a spread,
   *  never a fresh literal). */
  projectId?: string;
  /** Mission.contract.proofs (spec §8, T1.4) — forwarded unchanged to
   *  whichever engine loop this call dispatches to: native
   *  (planAndActLive appends a PROOF CONTRACT prompt section and parses it
   *  back out of the transcript) or managed (managedAgent.ts's
   *  PlanAndActManagedOpts — appends a system-prompt reminder and unlocks
   *  the attach_proof tool). Optional for the same low-level-test reason as
   *  projectId above. */
  proofRequirements?: ProofRequirement[];
  /** Stable project root (NOT worktreePath) — see proofs.ts's header for
   *  why proof artifacts must be stored here rather than in the mission's
   *  ephemeral worktree. runMission always provides this (its own
   *  `repoPath` parameter); optional here for the same low-level-test
   *  reason as projectId above. */
  projectRoot?: string;
  /** Called with the FULL accumulated ProofArtifact[] whenever a proof is
   *  attached — once at the end for native (planAndActLive), once per
   *  attach_proof tool call for managed (managedAgent.ts). See runMission,
   *  which forwards this straight into Mission.proofs via onUpdate. */
  onProofsAttached?: (proofs: ProofArtifact[]) => void;
  /** T1.3 — see RunOptions.getBudgetCapUsd. Forwarded unchanged to the
   *  managed branch via the `...opts` spread below; the native branch
   *  ignores it (runMission's own onMetrics wrapper handles native's
   *  post-hoc budget check directly from `mission.contract`, not via this
   *  live getter — see runMission's doc comment). */
  getBudgetCapUsd?: () => number | undefined;
  /** T1.3 — see RunOptions.onBudgetPaused. Forwarded to the managed branch
   *  only (native never calls it). */
  onBudgetPaused?: () => void;
  /**
   * T1.3 — called ONCE by the managed engine when a run stops itself at
   * >=100% spend, so runMission can skip its retry-evaluation branch
   * entirely and go straight to a 'failed' status with reason
   * 'budget_exceeded' (a hard stop must never be silently retried — spec
   * §11's "non-bypassable except by explicit user action"). Constructed by
   * runMission itself (not forwarded from a caller's RunOptions) — absent
   * from the public opts callers pass in.
   */
  onBudgetExceeded?: () => void;
  /** W-GUARD — see RunOptions.getMaxDurationMs. Forwarded unchanged to the
   *  managed branch via the `...opts` spread below; the native branch
   *  ignores it (runMission arms its own real timer instead — see
   *  armDurationExceededTimer's doc comment). */
  getMaxDurationMs?: () => number | undefined;
  /** W-GUARD — see RunOptions.onDurationPaused. Forwarded to the managed
   *  branch only (native never calls it). */
  onDurationPaused?: () => void;
  /**
   * W-GUARD — called ONCE by the managed engine when a run stops itself at
   * >=100% elapsed wall-clock, mirroring onBudgetExceeded exactly: lets
   * runMission skip its retry-evaluation branch and go straight to an
   * honest 'failed' status (a timeout must never be silently retried).
   * Constructed by runMission itself — absent from the public opts callers
   * pass in.
   */
  onDurationExceeded?: () => void;
  /** Reasoning effort forwarded to the managed engine (see
   *  PlanAndActManagedOpts). Ignored by the native engine. Sourced from
   *  MissionContract.effort in runMission. */
  reasoningEffort?: import('../models/openrouterCatalog.js').ReasoningEffort;
  /** See {@link TFunc}'s doc comment. Forwarded to whichever engine loop
   *  this call dispatches to (native: planAndActLive/planAndActLiveViaRunner;
   *  scripted: planAndActScripted; managed: planAndActManaged via the
   *  `...opts` spread below — managedAgent.ts's own agents.managedAgent.*
   *  action-feed strings now honor it too, same fallback-to-French contract
   *  as everywhere else `t` is threaded). */
  t?: TFunc;
  /** Custom agent persona (LazyBot runs — Mission.agentSystemPrompt, see
   *  types.ts). Forwarded to the managed loop via the `...opts` spread
   *  (planAndActManaged's agentSystemPrompt → resolveAgentPersona); ignored
   *  by the native and scripted paths. Absent = unchanged persona
   *  resolution (agentName or the default). */
  agentSystemPrompt?: string;
  /** Cloud approval-gate autonomy for a LazyBot run (Mission.botAutonomy) —
   *  forwarded to planAndActManaged's `autonomy` opt via the same spread;
   *  ignored by the other paths. Absent = the gate's own default. */
  autonomy?: 'manual' | 'supervised' | 'yolo';
}): Promise<void> {
  // Route by the mission's CHOSEN model FIRST — see this file's header and
  // classifyMissionModel's doc comment for why (a user can hold both a
  // Claude subscription and an active LazyPro plan at once). Gated on
  // isTauriRuntime() up front so a non-Tauri call (web/browser demo) always
  // falls through to the unchanged mode-based branch below, which already
  // resolves correctly to planAndActScripted there.
  const chosenKind = isTauriRuntime() ? classifyMissionModel(opts.managedModel) : undefined;
  if (chosenKind === 'managed') return dispatchChosenManaged(opts);
  if (chosenKind === 'byok') return dispatchChosenByok(opts);
  if (chosenKind === 'devin') return dispatchChosenDevin(opts);
  if (chosenKind === 'native') return dispatchChosenNative(opts);
  return dispatchModeFallback(opts);
}

type PlanAndActOpts = Parameters<typeof planAndAct>[0];

function runnerEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.LAZY_RUNNER === '1';
}

function mismatchArgs(opts: PlanAndActOpts, kind: ModelRouteKind) {
  return {
    kind,
    onStep: opts.onStep,
    onAction: opts.onAction,
    onProgress: opts.onProgress,
    t: opts.t,
  };
}

async function dispatchChosenManaged(opts: PlanAndActOpts): Promise<void> {
  // FREE tier bypass: a mission whose chosen model is a free OpenRouter
  // model (ox alpha) is ready even with no active Pro plan — the ai-proxy
  // serves free models to any authenticated user at zero cost (see
  // entitlement.ts's free short-circuit for the same contract at preflight).
  if (!isManagedModelReady() && !isOpenRouterFreeModel(opts.managedModel)) {
    return planAndActMismatch(mismatchArgs(opts, 'managed'));
  }
  // opts.managedModel is already a real, valid OpenRouter id (it came from
  // the combined model picker's managed catalog — see
  // modelPickerOptions.ts) — forwarded as-is, unmangled. Contrast the
  // mode-based fallback branch below, which only ever has a coarse tier
  // hint to work with and must fall back to a saved/default id instead.
  return planAndActManaged({
    ...opts,
    model: opts.managedModel!,
    pauseSignal: opts.pauseSignal ?? (() => false),
    drainIntervenes: opts.drainIntervenes ?? (() => []),
  });
}

async function dispatchChosenDevin(opts: PlanAndActOpts): Promise<void> {
  // Devin-catalog model: the mission runs Lazy's own ReAct loop
  // (planAndActManaged) with the Devin CLI as its brain — createCliAgentTurnStreamer
  // builds the ACP-backed turn streamer; undefined means the devin CLI
  // isn't installed on this box (precise mismatch, one-step fix).
  const streamTurn = createCliAgentTurnStreamer('devin');
  if (!streamTurn || isCliBackendAvailable('devin') === false) {
    return planAndActMismatch(mismatchArgs(opts, 'devin'));
  }
  return planAndActManaged({
    ...opts,
    model: opts.managedModel!,
    streamTurn,
    pauseSignal: opts.pauseSignal ?? (() => false),
    drainIntervenes: opts.drainIntervenes ?? (() => []),
  });
}

async function dispatchChosenByok(opts: PlanAndActOpts): Promise<void> {
  // BYOK wave: the mission's model is a BYOK catalog id (deepseek-chat,
  // ...) — run the full managed ReAct loop against the user's OWN provider
  // key, no CLI, no Pro credits. resolveByokAgentTurnStreamer returns
  // undefined when the provider's key is missing (classifyMissionModel
  // already required it, but double-check defensively).
  const streamTurn = resolveByokAgentTurnStreamer(opts.managedModel);
  if (!streamTurn) {
    return planAndActMismatch(mismatchArgs(opts, 'byok'));
  }
  return planAndActManaged({
    ...opts,
    model: opts.managedModel!,
    streamTurn,
    pauseSignal: opts.pauseSignal ?? (() => false),
    drainIntervenes: opts.drainIntervenes ?? (() => []),
  });
}

async function dispatchChosenNative(opts: PlanAndActOpts): Promise<void> {
  if (!isNativeModelReady()) {
    return planAndActMismatch(mismatchArgs(opts, 'native'));
  }
  const liveOpts = {
    ...opts,
    tool: opts.tool ?? 'claude',
    model: opts.model ?? 'haiku',
    abortSignal: opts.signal,
    pauseSignal: opts.pauseSignal ?? (() => false),
    onPaused: opts.onPaused,
    onResumed: opts.onResumed,
    resumeSessionId: opts.resumeSessionId,
  };
  // P6.a: When LAZY_RUNNER=1, route through the detached runner daemon
  // instead of the in-process agent_run Tauri command.
  if (runnerEnabled()) {
    return planAndActLiveViaRunner(liveOpts);
  }
  return planAndActLive(liveOpts);
}

async function dispatchModeFallback(opts: PlanAndActOpts): Promise<void> {
  // No classifiable model on this call (opts.managedModel absent/empty) —
  // legacy/low-level callers only; runMission always sets managedModel from
  // mission.model (a required field), so production mission runs reach one
  // of the chosen-kind branches. Falls back to the PREVIOUS mode-based
  // routing, unchanged, so this shape keeps behaving exactly as before.
  if (isManagedAgentAvailable()) {
    // isManagedAgentAvailable() is now strictly mode === 'managed' (claude-code
    // no longer matches it), so the per-mission OpenRouter id is always the
    // right fallback — no claude-code special case needed any more.
    const managedModel = opts.managedModel ?? (loadAccessSettings().model ?? DEFAULT_OPENROUTER_MODEL_ID);
    return planAndActManaged({
      ...opts,
      model: managedModel,
      pauseSignal: opts.pauseSignal ?? (() => false),
      drainIntervenes: opts.drainIntervenes ?? (() => []),
    });
  }
  return dispatchUnmanagedFallback(opts);
}

async function dispatchUnmanagedFallback(opts: PlanAndActOpts): Promise<void> {
  if (isLiveAgentAvailable()) {
    if (runnerEnabled()) {
      return planAndActLiveViaRunner({
        ...opts,
        tool: opts.tool ?? 'claude',
        model: opts.model ?? 'haiku',
        abortSignal: opts.signal,
      });
    }
    return planAndActLive({
      ...opts,
      tool: opts.tool ?? 'claude',
      model: opts.model ?? 'haiku',
      abortSignal: opts.signal,
    });
  }
  if (!isTauriRuntime()) {
    // Browser/web demo surface — no Tauri IPC backend exists here at all, so
    // the scripted placeholder loop is the intentional behavior (matches
    // models/index.ts: "Web demo path continues to use mockProvider").
    return planAndActScripted(opts);
  }
  // Desktop Tauri runtime with no real engine configured: 'pro' selected but
  // inactive, 'live-key' (BYOK key without a mission loop — BYOK missions
  // route by their CHOSEN model above; this branch only fires for a
  // mode-based fallback with no classifiable model), or 'mock'.
  return planAndActUnavailable({
    mode: getProviderMode(),
    onStep: opts.onStep,
    onAction: opts.onAction,
    onProgress: opts.onProgress,
    t: opts.t,
  });
}

// ── Main run entrypoint ───────────────────────────────────────────

/**
 * runMission — orchestrates a mission from queued through worktree, agent
 * loop, review, and terminal status. Extracted helpers live in
 * runMissionPrepare.ts (launch prelude), runMissionWorktree.ts (Step A),
 * runMissionSettle.ts (post-loop recovery), runMissionFinish.ts (C/E/F),
 * checkNativeBudget.ts (native/BYOK post-hoc spend), captureOutcome.ts
 * (learning snapshot), silenceWatchdog.ts (decideSilenceTimeout),
 * runMissionOpts.ts (RunOptions defaults + labels).
 *
 * Status lifecycle (explicit transitions):
 *   queued  (initial, set by addMission)
 *   → running   (Step A: worktree created, agent loop started)
 *   → running   (Step B: agent loop in progress, progress 0–100)
 *   → review    (Step D: diff computed, human approval required)
 *   → done      (approveMission: worktree merged)
 *   → cancelled (stopMission or discardMission)
 *   → failed    (agent error path)
 *
 *   running ⇄ Mission.paused=true/false (agentsStore.pauseMission/
 *     resumeMission) — a SUB-STATE of running, not a separate status value
 *     (see the `paused` field doc on Mission) — managed missions only.
 *
 * Permission wiring (opts.permissionMode / allowedTools / deniedTools):
 *   Passed through to agent_run req. Effective only in live mode (Tauri + claude CLI).
 *
 * @param mission  - The mission to run (must have id and title).
 * @param repoPath - The git repo root (used for worktree creation).
 * @param opts     - Callbacks, stop signal, and permission overrides.
 */
export async function runMission(
  mission: Mission,
  repoPath: string,
  opts: RunOptions,
): Promise<void> {
  // Agent ≠ LazyBot. A mission carrying `botId` is a Solari cloud-computer
  // run: it has its own runtime (runLazyBotMission.ts) and never enters the
  // local code-agent lifecycle below — no worktree/branch, no diff, no
  // review/merge, no automated evaluation, no `claude -p` process. Dynamic
  // import keeps this module's static graph (and every existing runtime
  // test mock) unchanged.
  if (mission.botId) {
    const { runLazyBotMission } = await import('../bots/runLazyBotMission.js');
    await runLazyBotMission(mission, repoPath, opts);
    return;
  }
  const {
    onUpdate: rawOnUpdate,
    stopSignal,
    signal,
    pauseSignal,
    drainIntervenes,
    permissionMode,
    allowedTools,
    deniedTools,
    getBudgetCapUsd,
    onBudgetPaused,
    getMaxDurationMs,
    onDurationPaused,
    t,
  } = withRunDefaults(opts);

  // ── Silence watchdog (armed further below, once currentTimeline exists —
  // see silenceWatchdog.ts's header) ─────────────────────────────────────
  // `onUpdate` is shadowed here so EVERY update this function sends —
  // action events, progress, steps, metrics, proofs — counts as activity
  // and pings the watchdog, the exact same basis the UI's own "agent
  // silent" heartbeat already uses (mission.updatedMs, bumped by every
  // journal write downstream of an onUpdate call). `silenceWatchdogHandle`
  // is undefined until Step B is about to start, so early calls (worktree
  // creation, pre-flight checks) are harmless no-ops via optional chaining.
  let silenceWatchdogHandle: ActivityWatchdog | undefined;
  const onUpdate = (update: MissionUpdate): void => {
    silenceWatchdogHandle?.ping();
    rawOnUpdate(update);
  };

  // Journal: single choke point for this run's projectId + wall-clock start
  // — covers native and managed missions alike (runMission is the shared
  // entry point for both engines; managedAgent.ts/T0.4 does not emit
  // mission.started/completed/failed itself).
  const projectId = projectIdFromRoot(repoPath);
  const missionStartedAt = Date.now();
  let finalMetrics: AgentMetrics | undefined;

  const {
    willRunManaged,
    isNativeRail,
    tool,
    model,
    managedModel,
    maxDurationMs,
    budgetCapUsd,
  } = resolveMissionCliRoute(mission, isTauriRuntime());
  let budgetExceeded = false;
  let budgetWarned = false;
  let durationExceeded = false;
  let durationTimer: { clear: () => void } = { clear: () => {} };
  const branch = missionBranchName(mission);

  const sessionGate = await gateAgentSession({
    model: mission.model ?? managedModel,
    mode: getProviderMode(),
    cliReady: isNativeModelReady(),
    proReady: isManagedModelReady(),
  });
  if (!sessionGate.ok) {
    const reason = t
      ? (() => {
          const translated = t(sessionGate.reasonKey);
          return translated !== sessionGate.reasonKey ? translated : sessionGate.reason;
        })()
      : sessionGate.reason;
    onUpdate({
      id: mission.id,
      patch: {
        status: 'failed',
        progress: 100,
        liveAction: undefined,
        statusReason: reason,
        actionTimeline: [{ time: nowTime(), text: reason, isLive: false }],
      },
    });
    emitBuffered({
      type: 'mission.failed',
      tsMs: Date.now(),
      projectId,
      missionId: mission.id,
      actor: 'agent',
      payload: { reason },
    });
    captureOutcome(mission, projectId, 'failed', missionStartedAt);
    return;
  }

  const { compiled, initialSteps, initialTimeline } = await prepareAndAnnounceMissionLaunch({
    mission,
    projectId,
    permissionMode,
    allowedTools,
    deniedTools,
    onUpdate,
    t,
  });

  // ── Step A: create worktree (runMissionWorktree.ts) ────────────
  // Track whether a real Tauri worktree was created so cleanup is only attempted
  // when there is actually something to discard (#22).
  const worktreePath = await createMissionWorktree({
    mission,
    repoPath,
    branch,
    projectId,
    initialTimeline,
    onUpdate,
    t,
  });
  if (!worktreePath) {
    captureOutcome(mission, projectId, 'failed', missionStartedAt);
    return;
  }

  // #22 fix: best-effort worktree cleanup helper for cancel and failure paths.
  const cleanupWorktree = async (): Promise<void> => {
    await discardWorktree(repoPath, worktreePath, branch).catch(() => {
      // Best-effort — cleanup errors must never block status updates
    });
  };

  if (stopSignal()) {
    // #22: discard the worktree on early cancel after creation
    await cleanupWorktree();
    onUpdate({ id: mission.id, patch: { status: 'cancelled', liveAction: runtimeLabel(t, 'agents.runtime.stopped', 'Stoppé') } });
    captureOutcome(mission, projectId, 'cancelled', missionStartedAt);
    return;
  }

  // Mutable local state for the loop (immutable updates sent via onUpdate)
  let currentSteps = initialSteps.map((s) => ({ ...s }));
  let currentTimeline: ActionEvent[] = [
    ...initialTimeline.map((e) => ({ ...e, isLive: false })),
    {
      time: nowTime(),
      text: runtimeLabel(t, 'agents.runtime.worktreeLabel', `Worktree : ${worktreePath}`, { path: worktreePath }),
      isLive: false,
    },
  ];
  let agentFailed = false;
  // Managed-loop failures (max_steps_exhausted, consecutive_failures,
  // no_credits) arrive via onOutcome — they don't set agentFailed because
  // the managed loop never emits "Erreur agent:" via onAction (that's the
  // native path's convention). Without this, runMission falls through to
  // the review/completed path even when the managed loop reported a
  // failure, producing both mission.failed AND mission.completed journal
  // events for the same run. The wrapper object defeats TS control-flow
  // narrowing (the assignment happens inside an async callback TS can't
  // track, so a bare `let` would be narrowed to `null` at the check site).
  const managedOutcome = { failed: null as { reason: string } | null };

  // ── Silence watchdog (real bug fix: a mission that goes silent mid-turn,
  // with no maxDurationMs cap set, used to hang forever — see
  // silenceWatchdog.ts's header for the full incident). Built on the
  // EXISTING silence primitive (createActivityWatchdog, lib/models/
  // activityWatchdog.ts — already used for the assistant chat path) rather
  // than a bespoke timer, with ceilingMs pushed way out (missions
  // legitimately run far longer than a chat turn — see
  // SILENCE_WATCHDOG_CEILING_MS's doc comment). Armed for BOTH engines
  // (native and managed alike): the total-duration timer above is
  // native-only and requires an explicit cap; this fires on pure silence,
  // by default, regardless of engine or cap.
  //
  // `missionSettled` flips true at every point this function stops caring
  // about the agent loop for this run (every early return below, plus the
  // unconditional durationTimer.clear() right before Step C) — checked
  // first in onTimeout so a watchdog that outlives the run (e.g. it fired
  // right as the mission finished normally) is a harmless no-op instead of
  // re-failing an already-settled mission.
  let missionSettled = false;
  let silenceStrikeCount = 0;
  let silenceFinal = false;

  // createActivityWatchdog fires onTimeout AT MOST ONCE per instance (it
  // self-disposes right before calling it — see its own fire()) — so
  // "give it one more window" (the retry decision below) needs a FRESH
  // instance, not a ping() on the one that just fired. armSilenceWatchdog
  // is what both the initial arm and every rearm call.
  const armSilenceWatchdog = (): void => {
    silenceWatchdogHandle = createActivityWatchdog({
      silenceMs: SILENCE_WATCHDOG_THRESHOLD_MS,
      ceilingMs: SILENCE_WATCHDOG_CEILING_MS,
      onTimeout: (_err: StreamTimeoutError) => {
        const result = decideSilenceTimeout({
          settled: missionSettled,
          final: silenceFinal,
          paused: pauseSignal(),
          awaitingHuman: extractPendingQuestionText({ actionTimeline: currentTimeline } as Mission) !== null,
          strikeCount: silenceStrikeCount,
          t,
        });
        silenceStrikeCount = result.strikeCount;
        if (result.action === 'noop') return;
        if (result.action === 'rearm') {
          armSilenceWatchdog();
          return;
        }
        if (result.action === 'waiting' && result.waitingText) {
          currentTimeline = [
            ...currentTimeline.map((e) => ({ ...e, isLive: false })),
            { time: nowTime(), text: result.waitingText, isLive: true },
          ];
          armSilenceWatchdog();
          onUpdate({
            id: mission.id,
            patch: { actionTimeline: [...currentTimeline], liveAction: result.waitingText },
          });
          return;
        }
        if (result.action !== 'stop' || !result.stopText || !result.stopReason) return;
        silenceFinal = true;
        currentTimeline = [
          ...currentTimeline.map((e) => ({ ...e, isLive: false })),
          { time: nowTime(), text: result.stopText, isLive: false },
        ];
        onUpdate({
          id: mission.id,
          patch: {
            status: 'failed',
            progress: 100,
            liveAction: undefined,
            statusReason: result.stopReason,
            actionTimeline: [...currentTimeline],
            worktree: branch,
          },
        });
        void killAgentRun(mission.id);
      },
    });
  };
  armSilenceWatchdog();

  // Fix D helper (2026-08-19 dollar-kill incident) — the native rail's own
  // non-terminal notice when its NOTIONAL cost crosses budgetCapUsd (either
  // the 90% warning band or the 100%+ "would have been exceeded" band —
  // native's onMetrics fires exactly ONCE, post-hoc, so at most one of these
  // fires per mission; `budgetWarned` just dedupes the theoretical case of
  // this being reachable twice). Expressed in CREDITS (usdToCredits — the
  // SAME cents-per-dollar conversion CostChip.tsx's real-spend branch uses,
  // now centralized in billing/credits.ts), explicitly worded as a
  // non-debited EQUIVALENT so it can never be misread as real spend — see
  // isNativeRail's own doc comment for why this rail gets no kill at all.
  const budgetCapCredits = budgetCapUsd ? usdToCredits(budgetCapUsd) : 0;
  const noteNativeBudgetEquivalent = (spentCredits: number, pct: number): void => {
    if (budgetWarned) return;
    budgetWarned = true;
    currentTimeline = [
      ...currentTimeline.map((e) => ({ ...e, isLive: false })),
      {
        time: nowTime(),
        text: t
          ? t('agents.runtime.budgetEquivalentNoticeNative', { credits: spentCredits, cap: budgetCapCredits, pct })
          : `Effort équivalent : ${spentCredits} crédits (non débités — abonnement Claude), ${pct}% du plafond informatif de ${budgetCapCredits} crédits ; mission non interrompue.`,
        isLive: false,
      },
    ];
    onUpdate({ id: mission.id, patch: { actionTimeline: [...currentTimeline] } });
  };

  // Native-only post-hoc budget check (T1.3) — see `willRunManaged`'s doc
  // comment above for why this never runs for a managed mission (which
  // self-enforces live, inside managedAgent.ts, via getBudgetCapUsd/
  // onBudgetPaused/onBudgetExceeded below instead). Native's agent_run is a
  // one-shot process with no mid-run cost signal — the ONLY cost figure
  // ever arrives here, in the SAME onMetrics callback that already reports
  // agentMetrics, after the run has already finished.
  //
  // Fix D (2026-08-19 dollar-kill incident): on the NATIVE rail specifically
  // (isNativeRail — real subscription CLI, costUsd is a notional API-price
  // equivalent, never real spend), crossing budgetCapUsd NEVER ends the
  // mission any more — no budgetExceeded flag, no killAgentRun call, no
  // 'budget.exceeded'/'budget.warning' journal event (those events mean
  // "enforced", and nothing was) — only the honest, non-terminal
  // noteNativeBudgetEquivalent FYI above. BYOK and the mode-based fallback
  // (real money, just not Lazy's) keep the ORIGINAL behavior below
  // unchanged: a >=90% crossing is reported as a timeline note (documented
  // asymmetry vs. the managed engine's real pause, same spirit as the Pause
  // button staying disabled for native/byok missions); a >=100% crossing
  // sets budgetExceeded (checked right after planAndAct resolves below) and
  // defensively kills the process (a no-op if it has already exited — see
  // killAgentRun's doc comment).
  const checkNativeBudget = (metrics: AgentMetrics): void => {
    if (willRunManaged) return;
    applyNativeBudgetStatus(classifyBudget(metrics.costUsd, budgetCapUsd), metrics.costUsd, {
      isNativeRail,
      budgetCapUsd,
      budgetExceeded,
      budgetWarned,
      onNativeEquivalent: noteNativeBudgetEquivalent,
      onExceeded: (spentUsd) => {
        budgetExceeded = true;
        emitBuffered({
          type: 'budget.exceeded',
          tsMs: Date.now(),
          projectId,
          missionId: mission.id,
          actor: 'system',
          payload: { capUsd: budgetCapUsd ?? 0, spentUsd },
        });
        void killAgentRun(mission.id);
      },
      onWarning: (pct) => {
        budgetWarned = true;
        emitEvent({
          type: 'budget.warning',
          tsMs: Date.now(),
          projectId,
          missionId: mission.id,
          actor: 'system',
          payload: { pct, capUsd: budgetCapUsd ?? 0 },
        });
        currentTimeline = [
          ...currentTimeline.map((e) => ({ ...e, isLive: false })),
          {
            time: nowTime(),
            text: t
              ? t('agents.runtime.budgetWarningNative', { pct })
              : `Avertissement budget : ${pct}% du plafond atteint (process natif déjà terminé — aucune pause possible pour ce moteur).`,
            isLive: false,
          },
        ];
        onUpdate({ id: mission.id, patch: { actionTimeline: [...currentTimeline] } });
      },
    });
  };

  // Arm the native wall-clock hard-stop timer (no-op for a managed mission
  // or an unset cap — see armDurationExceededTimer's doc comment). Spans
  // BOTH the initial attempt and any retry below (a single per-mission cap,
  // not reset per attempt) — cleared at every terminal branch past this
  // point so it never outlives the mission.
  if (!willRunManaged) {
    durationTimer = armDurationExceededTimer(maxDurationMs, () => {
      if (durationExceeded) return;
      durationExceeded = true;
      emitBuffered({
        type: 'duration.exceeded',
        tsMs: Date.now(),
        projectId,
        missionId: mission.id,
        actor: 'system',
        payload: { capMs: maxDurationMs ?? 0, elapsedMs: Date.now() - missionStartedAt },
      });
      void killAgentRun(mission.id);
    });
  }

  // Fix A/C (2026-08-19 budget-cap incident) — shared salvage/fail decision
  // for a budget or duration cap crossing, called from EITHER the initial
  // attempt or the retry attempt below (four call sites total: budget x2,
  // duration x2). Previously EVERY crossing short-circuited straight to
  // cleanupWorktree() + status 'failed' the instant it fired, discarding
  // whatever the agent had already written to the worktree even when it
  // held a genuine, salvageable deliverable — the exact defect the incident
  // report calls "work already written is destroyed" (forensics: a
  // budget-stopped mission's worktree held 18–21 files / 4000+ lines,
  // wiped). This mirrors the pre-existing stepCapFallthroughReason salvage
  // pattern in Step C below (built for an analogous 2026-08-05 incident,
  // managed step-cap exhaustion) but decides IMMEDIATELY here, before the
  // retry-evaluation machinery, since a budget/duration crossing must never
  // be retried (spec §11: "non-bypassable except by explicit user action" —
  // a retry would silently re-run the mission past the very cap that just
  // stopped it).
  //
  // `message` is built by the caller via formatBudgetExceededMessage /
  // formatDurationExceededMessage (Fix C) using the REAL spend/elapsed
  // figures known at the moment of the call (finalMetrics.costUsd for
  // budget, Date.now() - missionStartedAt for duration) — never a hardcoded
  // "100%".
  const settleCapExceeded = async (
    kind: 'budget_exceeded' | 'duration_exceeded',
    message: { text: string; reason: string },
  ): Promise<void> => {
    const { diffSnippet, diffAdded, diffRemoved, diffFiles, diffIncompleteFiles, emptyDeliverable } =
      await computeMissionDiff(worktreePath, mission);

    currentTimeline = [
      ...currentTimeline.map((e) => ({ ...e, isLive: false })),
      { time: nowTime(), text: message.text, isLive: false },
    ];

    if (emptyDeliverable) {
      // Nothing to salvage — fail exactly as before (same worktree discard,
      // same statusReason shape), just with the honest message.
      await cleanupWorktree();
      onUpdate({
        id: mission.id,
        patch: {
          status: 'failed',
          progress: 100,
          liveAction: undefined,
          statusReason: message.reason,
          actionTimeline: [...currentTimeline],
          worktree: branch,
        },
      });
      captureOutcome(mission, projectId, 'failed', missionStartedAt, finalMetrics, undefined, {
        category: kind,
        message: message.reason,
      });
      return;
    }

    // A genuine deliverable already sits in the worktree — preserve it
    // instead of discarding. No cleanupWorktree() call: the worktree and
    // its branch stay alive on disk. The mission lands in 'review', the
    // SAME state a normally-completed mission reaches (Step D below), so
    // the user can inspect and merge the work already paid for instead of
    // losing it. statusReason still carries the honest cap-exceeded
    // message so the review surface explains WHY the mission stopped early.
    onUpdate({
      id: mission.id,
      patch: {
        status: 'review',
        progress: 100,
        liveAction: undefined,
        statusReason: message.reason,
        diffSnippet,
        diffAdded,
        diffRemoved,
        diffFiles,
        diffIncompleteFiles,
        emptyDeliverable,
        actionTimeline: [...currentTimeline],
        worktree: branch,
        judgesApproved: undefined,
      },
    });
    emitBuffered({
      type: 'mission.completed',
      tsMs: Date.now(),
      projectId,
      missionId: mission.id,
      actor: 'agent',
      payload: { durationMs: Date.now() - missionStartedAt, costUsd: finalMetrics?.costUsd },
    });
    captureOutcome(
      mission,
      projectId,
      'review',
      missionStartedAt,
      finalMetrics,
      diffFiles.length > 0
        ? { filesChanged: diffFiles.length, linesAdded: diffAdded, linesRemoved: diffRemoved }
        : undefined,
      { category: kind, message: message.reason },
    );
  };

  // ── Step B: run the agent loop ────────────────────────────────
  const loopRef: AgentLoopRef = {
    get timeline() { return currentTimeline; },
    set timeline(v: ActionEvent[]) { currentTimeline = v; },
    get steps() { return currentSteps; },
    set steps(v: PlanStep[]) { currentSteps = v; },
    get agentFailed() { return agentFailed; },
    set agentFailed(v: boolean) { agentFailed = v; },
    get budgetExceeded() { return budgetExceeded; },
    set budgetExceeded(v: boolean) { budgetExceeded = v; },
    get durationExceeded() { return durationExceeded; },
    set durationExceeded(v: boolean) { durationExceeded = v; },
    get finalMetrics() { return finalMetrics; },
    set finalMetrics(v: AgentMetrics | undefined) { finalMetrics = v; },
    managedOutcome,
  };

  const runPass = async (): Promise<void> => {
    await planAndAct({
    missionId: mission.id,
    missionTitle: mission.title,
    // Use full agentTask as the prompt when provided (bus launches, library agents)
    missionTask: mission.agentTask,
    agentName: mission.agentName,
    // LazyBot runs — custom persona + cloud-gate autonomy (types.ts doc
    // comments). Absent for ordinary missions, so both spread through to
    // planAndActManaged as undefined and change nothing there.
    agentSystemPrompt: mission.agentSystemPrompt,
    autonomy: mission.botAutonomy,
    worktreePath,
    steps: currentSteps,
    tool,
    model,
    managedModel,
    reasoningEffort: mission.contract?.effort,
    permissionMode,
    allowedTools,
    deniedTools,
    compiledPlan: compiled,
    // Cross-project READ access — see Mission.extraReadableRoots' doc
    // comment (types.ts) for the full contract. The mission's OWN declared
    // value only; runMission never widens this to "every open project".
    extraReadableRoots: mission.extraReadableRoots,
    projectId,
    proofRequirements: mission.contract?.proofs,
    projectRoot: repoPath,
    t,
    getBudgetCapUsd,
    onBudgetPaused,
    onBudgetExceeded() {
      budgetExceeded = true;
    },
    getMaxDurationMs,
    onDurationPaused,
    onDurationExceeded() {
      durationExceeded = true;
    },
    onMetrics(metrics) {
      finalMetrics = metrics;
      onUpdate({
        id: mission.id,
        patch: { agentMetrics: metrics },
      });
      checkNativeBudget(metrics);
    },
    onOutcome(outcome) {
      if (outcome.type === 'failed') managedOutcome.failed = { reason: outcome.reason };
    },
    onStep(stepIdx, state, meta) {
      currentSteps = currentSteps.map((s, i) =>
        i === stepIdx ? { ...s, state, meta: meta ?? s.meta } : { ...s },
      );
      onUpdate({
        id: mission.id,
        patch: { planSteps: [...currentSteps] },
      });
    },
    onAction(event) {
      // Remove previous "isLive" entries, add new one
      currentTimeline = [
        ...currentTimeline.map((e) => ({ ...e, isLive: false as const })),
        { ...event, isLive: event.isLive ?? false },
      ];
      if (isAgentErrorEvent(event)) {
        agentFailed = true;
      }
      onUpdate({
        id: mission.id,
        patch: {
          actionTimeline: [...currentTimeline],
          liveAction: event.text,
        },
      });
    },
    onProgress(pct) {
      onUpdate({ id: mission.id, patch: { progress: pct } });
    },
    onProofsAttached(proofs) {
      onUpdate({ id: mission.id, patch: { proofs } });
    },
    onPaused(sessionId) {
      onUpdate({
        id: mission.id,
        patch: {
          paused: true,
          liveAction: runtimeLabel(t, 'agents.managedAgent.missionPaused', 'Mission en pause'),
          ...(sessionId ? {
            agentMetrics: {
              ...(finalMetrics ?? {
                durationMs: 0,
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                toolCount: 0,
              }),
              sessionId,
            },
          } : {}),
        },
      });
    },
    onResumed() {
      onUpdate({ id: mission.id, patch: { paused: false, liveAction: undefined } });
    },
    stopSignal,
    signal,
    pauseSignal,
    drainIntervenes,
  });
  };

  await runPass();

  const afterLoop = await settleAfterAgentLoop({
    mission,
    projectId,
    branch,
    compiled,
    missionStartedAt,
    budgetCapUsd,
    maxDurationMs,
    t,
    onUpdate,
    stopSignal,
    cleanupWorktree,
    settleCapExceeded,
    markSettled: () => {
      durationTimer.clear();
      missionSettled = true;
    },
    runPass,
    captureOutcome,
    formatBudget: (spent, cap) => formatBudgetExceededMessage(spent, cap, t),
    formatDuration: (elapsed, cap) => formatDurationExceededMessage(elapsed, cap, t),
    loop: loopRef,
  });
  await finishMissionAfterAgentLoop({
    afterLoop,
    mission,
    repoPath,
    worktreePath,
    projectId,
    branch,
    compiled,
    missionStartedAt,
    finalMetrics,
    timeline: currentTimeline,
    t,
    onUpdate,
    permissionMode,
    tool,
    model,
    captureOutcome,
    computeDiff: computeMissionDiff,
    markSettled: () => {
      durationTimer.clear();
      missionSettled = true;
    },
    cleanupWorktree,
  });
}

// ── P6.a: Runner-based live agent path (LAZY_RUNNER=1) ──────────────
//
// Thin HTTP-based equivalent of planAndActLive that talks to lazy-runnerd
// instead of using Tauri's invoke('agent_run') + listen('agent://step/...').
// When the runner daemon is enabled, mission execution survives UI crashes.
//
// For increment (a), this is scaffolding — the runner's POST /missions
// endpoint returns 501 until the spawn logic is extracted from agent.rs.
// The existing planAndActLive path remains the default (flag OFF).

async function planAndActLiveViaRunner(opts: PlanAndActLiveOpts): Promise<void> {
  return runPlanAndActLiveViaRunner(opts);
}
