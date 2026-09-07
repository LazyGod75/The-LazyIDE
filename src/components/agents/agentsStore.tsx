/* agentsStore — React context for Mission Control state.
   Provides missions list, addMission(), and selectedMissionId.
   Immutable updates — never mutates state in place.
*/

import { invoke } from '@tauri-apps/api/core';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useI18n } from '../../i18n';
import type { ActionStatus, ApprovalMode, ArtifactVariant, Mission, LoopConfig, ManagerAction, ManagerMessage, MissionContract, MissionOutcome, OrchestratorState, AutonomyMode, DecisionWithRecommendation } from '../../lib/agents/types';
import {
  ensureApprovalModesLoaded,
  getApprovalMode,
  getApprovalModeConfig,
  setApprovalMode as persistApprovalMode,
} from '../../lib/agents/approvalMode';
import { captureAgentMission, captureConversationSummary } from '../../lib/brain/capture';
import { runMission, mergeWorktree, discardWorktree, isManagedAgentAvailable, isLiveAgentAvailable, isNativeModelReady, isManagedModelReady, classifyMissionModel, killAgentRun, worktreeDiff } from '../../lib/agents/runtime';
import type { MissionUpdate, PermissionMode } from '../../lib/agents/runtime';
import { runLearningLoop } from '../../lib/agents/learningLoop';
import { runManagerActionHandler } from '../../lib/agents/managerActionDispatch';
// LazyBots (A3) — the manager creates/manages LazyBots from the chat. The
// bot storage/engine modules are deliberately imported at module top (no
// circular dependency: they never import back from agentsStore).
import { listBots, saveBot } from '../../lib/bots/botStorage';
import { launchBotRun, stopBotRun, finishBotRun, registerBotRun, listActiveRunsForBot, getBotRuntimeState, pruneBotRunsNotLive, toBotNewMissionInput } from '../../lib/bots/botEngine';
import type { BotConfig } from '../../lib/bots/botTypes';
import { resolveLazyBotRef, summarizeLazyBot } from '../../lib/bots/botManagerContext';
import { resolveLazyBotRunModel } from '../../lib/bots/botRunModel';
import {
  buildBotConfigFromCreateLazybot,
  sanitizeLazyBotPatch,
} from '../../lib/agents/managerLazyBotCreate';
import { resolveAutomatedTurnModel } from '../../lib/agents/automatedTurnModel';
import { getActiveModel } from '../../lib/models';
import {
  managerTurnNeedsSession,
  hasManagedSession,
  formatManagerUserError,
  MANAGER_ERROR_MAX_CHARS,
} from '../../lib/agents/managerSessionGate';
import {
  registerProject as registerRuntimeProject,
  getProject as getRuntimeProject,
  addMissionToRegistry,
  updateMissionInRegistry,
} from '../../lib/agents/globalRuntime';
import { runFrictionAnalysis } from '../../lib/agents/frictionAnalysis';
import {
  createOrchestrator,
  updateOrchestrator,
  updateOrchestratorStep,
  getOrchestrator,
  deleteOrchestrator,
  closeStepDependencies,
} from '../../lib/agents/orchestratorState';
import { startOrchestratorViaSgr } from '../../lib/agents/graph/sgrOrchestratorRunner';
import { compileOrchestratorToIr } from '../../lib/agents/graph/compileOrchestrator';
import { irToCanvas, irToProposedCanvas } from '../../lib/agents/graph/irToCanvas';
import { partitionMaterializedDrafts } from '../../lib/agents/planMaterialize';
import { repairPlanSteps } from '../../lib/agents/graph/planStepRepair';
import type { GraphRun, GraphIR } from '../../lib/agents/graph/types';
import { defaultGraphDefaults } from '../../lib/agents/graph/types';
import type { RunDebugSnapshot } from '../../lib/agents/graph/graphDebugView';
import { forkFromCheckpoint, type ForkResult } from '../../lib/agents/graph/forkFromCheckpoint';
import { buildBrainDrivenContext, buildLessonsContext } from '../../lib/agents/managerContext';
import { citeLesson } from '../../lib/agents/lessons/lessonStore';
import { buildLearningContext } from '../../lib/agents/lessons/learningPipeline';
import { evaluateActionGate } from '../../lib/agents/actionGate';
import { getEffectiveAutonomy } from '../../lib/agents/autonomyMode';
import { gitRevertMerge, listProjects, createProject, type BrainInfo } from '../../lib/platform/tauri';
import type { Brain } from '../../lib/platform/types';
import { enqueue as enqueueMission, updateQueuedMission, recoverStaleMissions, markStaleQueuedMissions, reconcileQueueAgainstMissions, purgeAncientStaleQueuedMissions, STALE_QUEUE_THRESHOLD_MS } from '../../lib/agents/missionQueue';
import { applyReplayRecovery } from '../../lib/agents/replayRecovery';
import { getStartupRecoveryState } from '../../lib/startupRecovery';
import { on, emit } from '../../lib/bus';
import { getPlatform, isTauri } from '../../lib/platform';
import { joinPath, basename, stripVerbatimPrefixesInText } from '../../lib/paths';
import { findOutOfScopeTaskPath, extractTaskAbsolutePaths } from '../../lib/agents/missionScopeGuard';
import { findOwningProject } from '../../lib/agents/projectForPath';
import { checkApproveGate, ApproveBlockedError, MergeConflictError, isDiffEmpty, evaluateAutoMerge, planLegacyHumanApproveMigration } from './approveGate';
import type { ApproveGateVerdictReviewer } from './approveGate';
import { pushAfterMissionMerge } from '../../lib/agents/missionPush';
import { isRetryBaseBranchChangeBlocked, extractRequestedRetryBaseBranch } from '../../lib/agents/retryBaseBranchGuard';
import { recordMissionCompleted } from '../../lib/models/usageHistory';
import { useToast } from '../ui';
import type { ToastType } from '../ui';
import {
  createLoopConfig,
  registerLoop,
  unregisterLoop,
  disableLoop,
  enableLoop,
  updateLoop,
  updateLoopState,
  skipNextRun,
  getLoop,
  listLoops,
  parseCadenceMs,
} from '../../lib/agents/loopEngine';
import { startLoopScheduler } from '../../lib/agents/loopScheduler';
import { freezeLoopArtifact } from '../../lib/agents/loopArtifact';
import { recordExternalMetric as recordExternalMetricEntry, getMetricsForLoop, synthesizeMetricTrend } from '../../lib/agents/loopMetrics';
import { runBrowserRecipe } from '../../lib/agents/browserRecipe';
import { initSgrChainRunner, onMissionTerminalSGR, setSgrManagedDrafts, clearSgrManagedDrafts } from '../../lib/agents/sgrChainRunner';
import { initCanvasChainOps, pinChainWithAudit, refireChainDownstream } from '../../lib/agents/canvasChainOps';
// W-CONTEST — registered ALONGSIDE chainEngine/joinEngine at the same
// mission-terminal choke point below (never routed through chainEngine
// itself — see contestEngine.ts's own module header for why this is a
// separate registration, not a rewrite of the existing hook).
import { initContestEngine, onMissionTerminalForContest } from '../../lib/agents/contestEngine';
import { formatVerdictScoreLine } from '../../lib/agents/evaluator';
// Agent Canvas W4 (spec §8) — the manager action executor calls the SAME
// canvas primitives the UI uses (canvasStoreVanilla's actions, chainValidation's
// real rules, the shared launchDraft/buildCanvasDigest modules) — no
// parallel path. canvasStoreVanilla is the global vanilla zustand singleton
// (canvasStore.ts's own header) so reading/writing it here from outside any
// canvas React component is the same pattern chainEngine.ts already uses.
import { canvasStoreVanilla, markPlanValidated } from './canvas/canvasStore';
import {
  makeRef,
  parseRef,
  PREVIEW_FOCUS_MIN_ZOOM,
  type NodeRef,
  type RouterBranch,
  type RouterSpec,
  type DraftSpec,
  type NoteData,
  type JoinSpec,
  type SurfaceHtmlView,
  type SurfaceSpec,
  type FrameSpec,
} from './canvas/canvasTypes';
import { validateChain, type ChainTargetInfo } from './canvas/chainValidation';
import { layoutDraftGraphInZone, type DraftGraphEdge, type DraftGraphNode } from './canvas/layout';
import { DEFAULT_NODE_SIZE, JOIN_NODE_SIZE } from './canvas/reconcilerZones';
import { generateCanvasId } from './canvas/canvasIds';
import { launchDraft } from './canvas/draftLaunch';
import { draftIdsFromAliasMap, rootDraftIdsToLaunch } from './canvas/yoloLaunchRootDrafts';
import { buildCanvasDigest, resolveDraftProjectId, resolveMissionProjectRoot, resolveProjectRootById, normalizeForMembershipCompare } from './canvas/canvasDigest';
import { captureMacro, instantiateMacro, storeOccupancyRects } from './canvas/canvasMacros';
import { ensureProjectPreviewSurface, findRunningMissionRef } from './canvas/previewSurface';
import { ensureDevServerForProject } from '../../lib/agents/devPreview';
import { startNightShift } from '../../lib/brain/nightShift';
import { capActionTimeline, capManagerMessages, pruneMissions } from '../../lib/agents/missionCaps';
import { useManagerPersistence, mintManagerSessionId, loadOpenWorkingSet, saveOpenWorkingSet, type PersistedPendingApproval } from '../../lib/agents/managerPersistence';
import { createNewAgent, type LazyAgent } from '../../lib/agents/agentDef';
import { saveAgent, listAgents, type StoredAgent } from '../../lib/agents/agentsStorage';
import { boundManagerHistory } from '../../lib/agents/managerHistoryWindow';
import {
  runManagerTurn,
  gatherManagerContext,
  createMessageId,
  formatMissionDetail,
  formatMissionNotFound,
  resolveManagerModelId,
  getManagerDefaultModelId,
  formatCreditsSummary,
  formatEntitlementsSummary,
  formatBrainStatus,
  dedupeRepeatedSegments,
  MANAGER_TURN_TIMEOUT_MS,
  MANAGER_LLM_CALL_TIMEOUT_MS,
  MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS,
  estimatePlanStepCostUsd,
  estimatePlanStepDurationMs,
  detectUserActionRequest,
  shouldSkipHeavyManagerContext,
  shouldBlockOnManagerStartupContext,
  sanitizeManagerDisplayText,
  createConversationGoal,
  buildGoalStatusContext,
  applyGoalEvaluationOutcome,
  buildGoalAchievedNotice,
  buildGoalExhaustedNotice,
  MAX_GOAL_EXTENSIONS,
  RESEARCH_ONLY_STREAK_BUDGET,
  type ManagerContext,
  type ManagerTurnResult,
} from '../../lib/agents/managerEngine';
import { liveManagerStoreView } from '../../lib/agents/managerLiveState';
import { loadPersistedGoals, persistConversationGoal } from '../../lib/agents/managerGoalPersist';
import { getCharterDecision, recordCharterDecision } from '../../lib/agents/managerCharterStore';
import { noteManagerDecision } from '../../lib/agents/brainNotation';
// Pure billing/credits + the shared subscription context (same source the
// credits KPI tile / AccountChip read — no second Supabase fetch) so the
// manager's "combien ai-je de crédits ?" answers use real account state.
import { useSubscriptionContext, isOutOfCredits, formatRenewalDate, usdToCredits } from '../../lib/billing';
import { getProviderMode, getDefaultModelIdForMode, findOpenRouterModel } from '../../lib/models/index';
import { isOpenRouterFreeModel, migrateRetiredOpenRouterId } from '../../lib/models/openrouterCatalog';
import { loadAccessSettings, saveAccessSettings } from '../../lib/models/accessSettings';
import { getEngineReadiness, engineReasonKey } from '../../lib/models/entitlement';
// STACK fix: the SAME mode-independent entitlements primitive every model
// picker (LazyManager, New Mission, Composer) already uses — see
// modelPickerOptions.ts's module doc comment (a Claude subscription and an
// active Lazy Pro plan are independent, never mutually exclusive).
import { detectModelEntitlements, buildModelPickerOptions, isSelectablePickerModel } from '../../lib/models/modelPickerOptions';
import { recallForDirective, withTimeout } from '../../lib/models/brainSearchLoop';
import { extractPendingQuestionText, recordMissionAnswer } from '../../lib/agents/missionQuestion';
import { runBrainQueryCss, runBrainNeighbours } from '../../lib/brain/brainTool';
import { buildProjectDigest } from '../../lib/agents/projectDigest';
import { createDecision } from '../../lib/brain/decisions';
import { launchPhaseEnter, launchPhaseExit, launchPhaseError } from '../../lib/agents/launchLog';
import { emitEvent, emitBuffered } from '../../lib/journal/journal';
import { projectIdFromRoot } from '../../lib/journal/projectId';
import { queryJournalSince } from '../../lib/journal/projections';
import { loadMissionsFromJournal } from '../../lib/journal/missionsProjection';
import { migrateProjectToJournal } from '../../lib/journal/migrate';
import {
  dispatch as schedulerDispatch,
  releaseMissionSlot as schedulerReleaseMissionSlot,
  getRunningMissionIds as schedulerGetRunningMissionIds,
  missionQueueWait as schedulerMissionQueueWait,
  isMissionSchedulerQueued as schedulerHasQueuedEntry,
} from '../../lib/agents/scheduler';
import { getCostState } from '../../lib/models/costStore';
// Cross-layer import by design (same established pattern as scheduler.ts's
// own LS_AGENTS_MAX_PARALLEL import): AgentsPanel.tsx is the registry for
// every `lazy.agents.*` localStorage key even though it is a component file.
import { LS_AGENTS_COST_LIMIT } from '../settings/AgentsPanel';
import { createManagerInterventionListener } from '../../lib/agents/lazyReasoningBlocks';
import {
  planFleetHygiene,
  planLoopSupervision,
  getFleetHygieneConfig,
  hasAddress as hasSurfaceAddress,
  type HygieneMission,
  type HygienePreviewSurface,
  type HygieneCanvasArtifact,
  type HygieneProject,
  type HygieneLoop,
} from '../../lib/agents/fleetHygiene';
import { getTerminalActivity } from '../../lib/agents/terminalActivity';
import { startSystemPressureShedding } from '../../lib/agents/systemPressureShedding';
import { clearTreeSitterLanguageCache } from '../../lib/codegraph/treeSitterScanner';
import { useAppContextOptional, readRecentProjects } from '../../app/AppContext';
import {
  startManagerWakeupScheduler,
  getManagerWakeupConfig,
  WAKEUP_MARKER_PREFIX,
  type WakeupCandidate,
} from '../../lib/agents/managerWakeup';
import { shouldResumeAfterApprovalQueueDrain } from '../../lib/agents/managerApprovalResume';
import { notifyMissionDone, notifyMissionFailed } from '../../lib/agents/osNotifications';
import { reattachToRunner, pollRunnerMission } from '../../lib/agents/runnerReattach';
import { tripwireRegistry, TripwirePresets } from '../../lib/agents/contentTripwire';
import { provisionService, teardownService } from '../../lib/agents/provisioning';
import { recordTemplate, templateFromMission } from '../../lib/agents/agentTemplates';
import { runImprovementLoop } from '../../lib/agents/improvementLoop';
import { capturePattern } from '../../lib/agents/learningCapture';
import { noteAgentTemplate } from '../../lib/agents/brainNotation';
import {
  isOneTimeMission,
  seedJournaledMissions,
  stopLoopForTerminalMission,
  recordLoopIterationApproval,
  recordLoopIterationFailure,
  formatLoopPromotedMessage,
  formatLoopDemotedMessage,
  formatLoopSupervisionMessage,
  consecutiveLoopFailures,
  formatLoopStopStatusReason,
} from './store/loopLifecycle';
import {
  findLoopMission,
  resolveAliasedRef,
  isTerminalMissionStatus,
  reviewMissionsAwaitingDecision,
  isOlderThanHours,
  matchesProjectScope,
  summarizeIds,
} from './store/missionQueryUtils';
export { findLoopMission, isTerminalMissionStatus };

// P7.7 — Register default content tripwire presets at module load.
// These fire when mission output matches patterns (secrets, stack traces, TODOs).
tripwireRegistry.register(TripwirePresets.secretLeak());
tripwireRegistry.register(TripwirePresets.stackTrace());
tripwireRegistry.register(TripwirePresets.todoLeftover());

// ── Auto-dismiss: one-time agents fade out after completing ─────────────────
//
// When a one-time mission (no loopConfig, no loopParentId) reaches 'done',
// after SUMMARY_DELAY_MS it transforms into a compact summary card on the
// canvas (canvasStore.summarizeMission). After SUMMARY_DISPLAY_MS more, it
// plays the exit animation (canvasStore.beginExitAnimation), and after
// EXIT_ANIMATION_MS it is permanently hidden (canvasStore.dismissMission).
// The mission data stays in the journal/brain — only the canvas node fades.

const SUMMARY_DELAY_MS = 30_000;
const SUMMARY_DISPLAY_MS = 120_000;
const EXIT_ANIMATION_MS = 600;

// ── P58: automatic fleet hygiene sweep timing ───────────────────────────
// FOUNDER DIRECTIVE: "hygiène naturelle et auto ... chaque action manuelle
// prise pendant l'audit = une chose qui manque dans l'app." — see
// fleetHygiene.ts for the pure rules; this file only wires WHEN a sweep
// runs. Boot delay gives the mission-load effect below (journal/legacy
// read) time to settle first ("after fleet load" — that effect's own
// setState calls land well within this window in every real run); the
// periodic interval covers a long-running session.
const FLEET_HYGIENE_BOOT_DELAY_MS = 5_000;
const FLEET_HYGIENE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A burst of terminal transitions (several missions completing at once)
// must never fire more than one real sweep in quick succession — pure rule
// evaluation is cheap, but applying it (archiveMission/removeSurface) each
// writes through the journal/canvas persistence, so this throttles that.
const MIN_HYGIENE_SWEEP_INTERVAL_MS = 30_000;

// FOUNDER NORTH STAR fix: createLoopConfig's own default stopCondition is
// `{ kind: 'manual' }` (loopEngine.ts) — fine for a loop a user explicitly
// configures as open-ended, but the LazyManager's own `create_loop` tool call
// (executeManagerAction below) never lets the model specify a stopCondition
// at all, so every manager-created loop used to inherit that same 'manual'
// default and could run forever with no automatic stop — the opposite of
// "never saturate the user's machine, no manual unblocking ever". Bounded to
// a real, finite ceiling by default; a user who wants a genuinely open-ended
// loop still gets one by editing the loop's stop condition afterward (or via
// any future explicit-manual UI path), never by this silent fallback.
const DEFAULT_MANAGER_LOOP_MAX_ITERATIONS = 10;

const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAutoDismiss(missionId: string): void {
  if (autoDismissTimers.has(missionId)) return;
  const store = canvasStoreVanilla.getState();
  const ref = makeRef('mission', missionId);
  if (store.dismissedRefs.includes(ref)) return;

  const summaryTimer = setTimeout(() => {
    canvasStoreVanilla.getState().summarizeMission(missionId);
  }, SUMMARY_DELAY_MS);

  const exitTimer = setTimeout(() => {
    canvasStoreVanilla.getState().beginExitAnimation(missionId);
    setTimeout(() => {
      canvasStoreVanilla.getState().dismissMission(missionId);
      autoDismissTimers.delete(missionId);
    }, EXIT_ANIMATION_MS);
  }, SUMMARY_DELAY_MS + SUMMARY_DISPLAY_MS);

  autoDismissTimers.set(missionId, summaryTimer);
  autoDismissTimers.set(missionId + ':exit', exitTimer);
}

// ── Types ─────────────────────────────────────────────────────────

export interface NewMissionInput {
  title: string;
  description?: string;
  repo: string;
  worktree: string;
  modelLabel: string;
  /**
   * Legacy chat-style mode. NEVER consumed by addMission/runMission (the
   * runtime honors permissionMode instead) — kept optional only for callers
   * that still pass it. The New Mission modal no longer sends it (W2.6).
   */
  mode?: MissionMode;
  orchestrator: boolean;
  /** Full task prompt sent to the agent (overrides title when present). */
  agentTask?: string;
  /** Named sub-agent to route the run to (e.g. from the agent library). */
  agentName?: string;
  /** Permission mode passed to the agent runner. */
  permissionMode?: PermissionMode;
  /** Tool allowlist passed as --allowedTools. */
  allowedTools?: string[];
  /** Tool denylist passed as --disallowedTools. */
  deniedTools?: string[];
  /** Loop configuration — when present, this mission is a recurring loop. */
  loopConfig?: LoopConfig;
  /**
   * Formalized launch contract (spec §8, T1.2) — assembled by
   * NewMissionModal.tsx at submit time. Forwarded onto the created Mission
   * unchanged (see addMission below); nothing in this store reads its
   * fields yet (budget enforcement/proof gates land in T1.3/T1.4) — this is
   * plumbing so the contract survives the launch instead of being silently
   * dropped between the modal and the persisted Mission.
   */
  contract?: MissionContract;
  /** See Mission.baseBranch's doc comment (lib/agents/types.ts) for the full
   *  contract and thread. Forwarded unchanged onto the created Mission by
   *  addMission below. */
  baseBranch?: string;
  /** See Mission.mergeBranches's doc comment (lib/agents/types.ts) for the
   *  full contract and thread. Forwarded unchanged onto the created Mission
   *  by addMission below. */
  mergeBranches?: string[];
  /** See Mission.extraReadableRoots's doc comment (lib/agents/types.ts) for
   *  the full cross-project READ access contract and its security model.
   *  ALREADY-RESOLVED absolute project roots (resolution from a declared
   *  project id/name happens upstream, in the `launch_mission` executor
   *  case below) — forwarded unchanged onto the created Mission by
   *  addMission below. Absent/empty = today's unchanged worktree-only scope. */
  extraReadableRoots?: string[];
  /** Reasoning effort for this mission's model — forwarded to the contract
   *  when set (see MissionContract.effort). Used by the managed engine to
   *  set reasoningEffort on the proxy request. */
  effort?: import('../../lib/agents/types').Effort;
  /** Parent mission id when this is a sub-mission (T1.5). */
  parentMissionId?: string;
  /**
   * W-CLOSE row 6 — forwarded onto the created Mission unchanged (see
   * addMission below). Set by draftLaunch.ts when the launched DraftSpec
   * carries `isolated: true` (canvasTypes.ts) — see Mission.isolated's own
   * doc comment (lib/agents/types.ts) for the one real effect this has.
   */
  isolated?: boolean;
  /** Multi-conversation LazyManager (wave 1) — forwarded onto the created
   *  Mission unchanged as `originConversationId` (see that field's own doc
   *  comment, lib/agents/types.ts). Set by executeManagerAction's mission-
   *  creation cases from the conversationId threaded through
   *  sendManagerMessage; absent for every non-manager launch path. */
  originConversationId?: string;
  /** LazyBot runs (botEngine.launchBotRun threading) — the three bot
   *  identity fields documented on Mission itself (types.ts): custom agent
   *  persona, cloud-gate autonomy, owning bot id. Forwarded unchanged by
   *  addMission; absent for every non-bot launch path. */
  agentSystemPrompt?: string;
  botAutonomy?: 'manual' | 'supervised' | 'yolo';
  botId?: string;
}

export type MissionMode = 'ask' | 'plan' | 'edit' | 'agent';

/** Summary row for LazyManagerRail's history dropdown (mirrors
 *  AssistantHeader's `chatSessions` shape, plus `preview` since the manager
 *  history's UI shows a first-user-message preview the assistant's doesn't —
 *  see managerPersistence.ts's ManagerSession for the full persisted shape
 *  this is derived from). */
export interface ManagerSessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** First user message's content, truncated — '' when the session somehow
   *  has no user message (never fabricated). */
  preview: string;
}

interface AgentsState {
  missions: Mission[];
  selectedMissionId: string | null;
  /** Runtime orchestrators spanning multiple missions. */
  orchestrators: OrchestratorState[];
  /**
   * Every currently OPEN LazyManager conversation, keyed by id — see the
   * "Multi-conversation LazyManager (wave 1)" section above
   * (ManagerConversationState) for the full contract. Replaces the old
   * singular managerMessages/managerBusy/managerPhase/managerElapsedMs/
   * pendingApprovals fields, each of which now lives PER CONVERSATION.
   * AgentsStoreValue still exposes those same top-level names as read-only
   * mirrors of `conversations[activeConversationId]` (see the Provider's
   * `value` construction) — a consumer that only ever knew about a single
   * conversation (ManagerOverlay.tsx, lazyManagerStore.tsx's unified
   * adapter, ...) keeps working unchanged, always reflecting whichever
   * conversation is currently active.
   */
  conversations: Record<string, ManagerConversationState>;
  /** Display/tab-strip order — newest-opened last. Every id here has a
   *  matching entry in `conversations`; every mutation below that adds or
   *  removes a conversation touches both in the SAME setState so the two
   *  can never drift apart. */
  conversationOrder: string[];
  /** Which open conversation the visible transcript/composer/pending-
   *  approval UI currently shows (LazyManagerHeader's tab strip flips
   *  this via setActiveConversationId). Always a member of
   *  `conversationOrder` — never an id with no matching conversation. */
  activeConversationId: string;
  /**
   * LazyManager's selected model id. Lifted here (rather than local
   * component state) so it survives LazyManager unmounting/remounting when
   * cockpit tabs switch — AgentsSpace only renders <LazyManager /> while
   * activeTab === 'mission-control', but this Provider stays mounted across
   * tab changes, so state kept here persists across them. GLOBAL across
   * every conversation, same as autonomyLevel below — not per-conversation.
   */
  managerModel: string;
  /**
   * Runtime autonomy level (manual / supervised / yolo / custom) — GLOBAL,
   * shared by every conversation's turns. KNOWN TRAP (explicitly out of
   * wave-1 scope): making this per-conversation would let one conversation
   * run in 'yolo' while another stays 'supervised', which is NOT what this
   * store does today — every open conversation's gate decisions
   * (evaluateActionGate) read this SAME value. See setAutonomyLevel's own
   * doc comment below.
   */
  autonomyLevel: AutonomyMode;
  /** Live SGR graph run for the active plan (UI debug / tree). */
  activeGraphRun: GraphRun | null;
  activeGraphSnapshot: RunDebugSnapshot | null;
}

interface AgentsStoreValue extends AgentsState {
  /** Returns the newly created mission's id (Agent Canvas W3: chainEngine
   *  needs it to call canvasStore.remapDraftToMission after firing a chain
   *  into a draft). The implementation always returned it; this signature
   *  used to narrow it away to `void` — existing callers that ignore the
   *  return value are unaffected by widening it back. */
  addMission: (input: NewMissionInput) => Promise<string>;
  updateMission: (update: MissionUpdate) => void;
  stopMission: (id: string) => void;
  /** Pause a running mission between ReAct steps — real for managed
   *  missions, a guarded no-op for native ones (see the implementation). */
  pauseMission: (id: string) => void;
  /** Resume a paused mission. */
  resumeMission: (id: string) => void;
  /** Queue a steering instruction into a running mission — delivered at the
   *  next ReAct step for managed missions, honestly queued (not delivered)
   *  for native ones (see the implementation). */
  interveneMission: (id: string, text: string) => void;
  /**
   * T1.8 — Takeover (human<->agent baton-pass, spec §8).
   * Managed: pauses the mission so the user can edit the worktree, then on
   *   "hand back" captures the diff and injects it as a HUMAN_EDITS observation
   *   before resuming.
   * Native: stops the run, and on "hand back" creates a continuation mission
   *   seeded with a journal summary + human diff in the prompt.
   */
  takeoverMission: (id: string) => Promise<void>;
  /** T1.8 — Return control to the agent after a takeover (hand back). */
  returnFromTakeover: (id: string) => Promise<void>;
  /**
   * Approve a mission for merge.
   * Throws ApproveBlockedError when the mission id is unknown, has no
   * worktree, or isn't in 'review', and when judgeVerdict is absent or
   * passed===false, unless opts.force === true. Every blocked/failed
   * attempt (except a real merge conflict, which gets its own dedicated
   * `merge.conflicted` event) is additionally journaled as
   * `mission.approve_blocked` so the mission's timeline shows it.
   */
  approveMission: (id: string, repoPath: string, opts?: { force?: boolean }) => Promise<void>;
  discardMission: (id: string, repoPath: string) => Promise<void>;
  /**
   * Revert a mission (spec §8's one-click "revert mission"): drops an
   * unmerged worktree (reuses discardMission's own flow) or `git revert`s a
   * merged mission's merge commit + deletes its proof artifacts. Throws a
   * plain Error with a clear, user-facing reason when a merged mission has
   * no recorded merge commit sha to revert (see RevertableMission below).
   */
  revertMission: (id: string, repoPath: string) => Promise<void>;
  /**
   * Fork a new graph run from one of this mission's checkpoints
   * (graph/forkFromCheckpoint.ts). Does not relaunch or schedule
   * anything — see MissionDetail's checkpoints section for the caller.
   */
  forkMissionFromCheckpoint: (id: string, checkpointId: string) => Promise<ForkResult>;
  setSelectedMissionId: (id: string | null) => void;
  // ── Loop operations ──
  /** Enable/disable a loop mission. */
  toggleLoop: (id: string, enabled: boolean) => Promise<void>;
  /** « Passer la prochaine » — advances a loop's next run by one cadence. */
  skipLoopNextRun: (id: string) => Promise<void>;
  /** Delete a loop and unregister it. */
  deleteLoop: (id: string) => Promise<void>;
  /**
   * Section 4 gate 1 — freezes a new version of a generic, reusable
   * artifact (a template, a tone brief — never a domain-specific shape) and
   * attaches it to a registered loop's `templateArtifactRef` when one isn't
   * already set. Also valid for a one-time mission id with no loop at all.
   */
  freezeLoopTemplate: (missionId: string, kind: string, content: unknown, label?: string) => Promise<import('../../lib/agents/loopArtifact').LoopArtifactVersion>;
  /**
   * Section 6 — attaches one named, externally-sourced metric to a past
   * execution (spec: "une mesure nommée, une source, une valeur"). Never a
   * schema specific to any one content format or social network.
   */
  recordExternalMetric: (
    missionId: string,
    metricName: string,
    source: string,
    value: number,
    loopId?: string,
  ) => Promise<import('../../lib/agents/loopMetrics').ExternalMetricEntry>;
  // ── Bulk operations ──
  /** Stop all running missions, optionally filtered by title keyword. */
  stopAll: (filter?: string) => void;
  /**
   * 2026-08-06 (founder: "c'est une catastrophe que le lazymanager ne fasse
   * pas ce qu'on demande") — DIRECT canvas cleanup, no LLM round-trip: the
   * quick-action buttons ("Stoppe tout" / "Nettoyer") must work even when
   * the manager model fails to emit actions. Runs the SAME executor path
   * as the manager's own clear_canvas action (journal-aware, scope all),
   * so the board is cleared for real.
   */
  clearCanvasDirect: (scope?: string, mode?: 'archive' | 'delete') => void;
  /**
   * Retry a failed or done mission by cloning it. `opts.feedback` (W8c gate
   * v2, deliverable #2) bakes a human/manager correction into the clone's
   * task AND records a real `mission.rejected` journal entry against the
   * ORIGINAL mission id — see the implementation's doc comment for why this
   * is the honest "reject with feedback" primitive rather than an invented
   * new lifecycle state.
   *
   * Retry-with-edit friction fix — `opts.newTask` lets the retry carry a
   * CORRECTED task instead of forcing a clone_mission detour just to fix a
   * badly-worded instruction. Only takes effect when it actually differs
   * from the mission's current task; the clone then records the REPLACED
   * text on `taskAmendedFrom` (Mission, types.ts) so the previous wording
   * stays visible, never silently rewritten. `opts.newModel`/`opts.newModelId`
   * optionally reroute the retry too, resolved the same way clone_mission's
   * own `mods.model` is (resolveManagerModelId). `opts.newBaseBranch`
   * (Continuation Doctrine, managerEngine.ts) optionally restarts the retry
   * from a DIFFERENT branch than the original mission carried — absent
   * keeps the original mission's own `baseBranch` (the clone spreads
   * `...original`, so it already carries forward unchanged).
   *
   * Honesty fix (C1): returns a Promise so a caller can verify the retry
   * actually happened — rejects (never a silent no-op) when `id` does not
   * resolve to a real mission. See the implementation's own doc comment.
   */
  retryMission: (
    id: string,
    opts?: { feedback?: string; newTask?: string; newModel?: string; newModelId?: string; newBaseBranch?: string },
  ) => Promise<void>;
  /** Delete a mission from the list. */
  deleteMission: (id: string) => void;
  /** R13 — mission lifecycle: hide a TERMINAL mission from the Agent Canvas
   *  via the additive `archived` flag + a real `mission.archived` journal
   *  event — never destroys history (see the implementation's doc comment). */
  archiveMission: (id: string) => void;
  /** R13 — bulk « Archiver les terminées » for a canvas zone's context menu:
   *  archives every terminal (done/failed/cancelled), not-yet-archived
   *  mission among `missionIds`. */
  archiveTerminalMissions: (missionIds: string[]) => void;
  // ── LazyManager (multi-conversation, wave 1) ──
  /**
   * Backward-compat mirrors of the ACTIVE conversation's own state — see
   * ManagerConversationState/AgentsState.conversations' own doc comments.
   * A consumer that never learned about the conversation map (ManagerOverlay.tsx,
   * lazyManagerStore.tsx's unified adapter, every existing test that renders
   * a single conversation) reads these exactly as before; they simply now
   * track WHICHEVER conversation is active rather than being the only
   * conversation that could ever exist.
   */
  managerMessages: ManagerMessage[];
  managerBusy: boolean;
  managerPhase: 'idle' | 'turn' | 'grounding' | 'queued';
  managerElapsedMs: number;
  /**
   * Actions the gate deferred with decision 'ask' (see evaluateActionGate)
   * for the ACTIVE conversation, queued for explicit user resolution instead
   * of being discarded — see PendingApprovalAction's own doc comment for the
   * full contract and approvePendingAction/rejectPendingAction below for how
   * they resolve. Every OTHER open conversation has its own independent
   * queue at `conversations[thatId].pendingApprovals`.
   */
  pendingApprovals: PendingApprovalAction[];
  /** Switches which open conversation is active (tab strip click,
   *  LazyManagerHeader.tsx) — a no-op if `id` isn't currently open. */
  setActiveConversationId: (id: string) => void;
  /**
   * Send a message on ONE conversation (`conversationId`, leading param —
   * every generation/abort/busy check inside is scoped to that
   * conversation's own state only, never the singular globals this replaced)
   * and execute returned actions. `opts.displayContent` overrides what the
   * TRANSCRIPT shows for this turn's own user message while `text` itself
   * (what the MODEL receives) stays unchanged — see
   * ManagerMessage.displayContent's own doc comment. Only the
   * manager-wakeup scheduler wiring passes it today; every other real call
   * site omits it and behaves exactly as before.
   *
   * Concurrency: at most MAX_CONCURRENT_MANAGER_TURNS conversations run a
   * turn at once — the (N+1)th call here awaits a free slot
   * (acquireManagerTurnSlot), during which this conversation's own `phase`
   * reads 'queued' (never 'turn'), before actually starting the LLM call.
   * Never runs unbounded parallel turns and never silently drops a send.
   */
  sendManagerMessage: (conversationId: string, text: string, model: string, opts?: { displayContent?: string }) => Promise<void>;
  /**
   * Stop button (click / Escape) for ONE conversation — aborts THAT
   * conversation's own exchange-wide `turnCtrl` AbortController (see
   * managerAbortRef's doc comment near its declaration), which cascades
   * into whichever per-call child controller is currently in flight (see
   * createManagerCallController), so Stop and a budget firing on its own
   * converge to the identical code path. No-op when no turn is in flight on
   * `conversationId` — never touches any OTHER conversation's turn.
   */
  stopManagerMessage: (conversationId: string) => void;
  /**
   * Closes an open conversation tab — see closeManagerConversation's own
   * doc comment (below, near stopManagerMessage's implementation) for the
   * full closing-vs-deleting / busy / last-tab / active-tab contract.
   */
  closeManagerConversation: (id: string) => void;
  /**
   * Tab-strip rename (double-click a tab, LazyManagerConversationTabs.tsx)
   * — see renameManagerConversation's own doc comment (below, near
   * closeManagerConversation's implementation) for the trim/clear/
   * persistence contract. A no-op if `id` isn't a currently open
   * conversation.
   */
  renameManagerConversation: (id: string, title: string) => void;
  /** Clear the ACTIVE conversation's chat history in place (id unchanged). */
  clearManagerMessages: () => void;
  /**
   * Past manager conversations persisted to localStorage (managerPersistence.ts),
   * newest-first — backs LazyManagerRail's history dropdown. Includes
   * currently-open conversations too (once autosaved at least once), since
   * the conversation id space IS the persisted session id space — opening
   * one from this list again is a no-op (see loadManagerSession below).
   */
  managerSessions: ManagerSessionSummary[];
  /**
   * New-conversation button ("+"): mints a fresh id, opens it as a NEW
   * conversation (added to conversationOrder, never replacing any existing
   * one), and switches the active tab to it. Deliberately NO busy gate — an
   * in-flight turn on any other conversation (including the one that was
   * active) keeps running untouched in the background; that is the entire
   * point of wave 1 (several conversations working AT THE SAME TIME).
   * A no-op once conversationOrder.length reaches MAX_OPEN_MANAGER_CONVERSATIONS
   * (LazyManagerHeader disables the button in that case with a real tooltip
   * — this is the defensive backstop, not the primary guard).
   */
  newManagerConversation: () => void;
  /**
   * Opens a past conversation from history: if `id` is already one of the
   * currently OPEN conversations, this just switches the active tab to it
   * (never duplicates); otherwise it reopens that persisted session's
   * messages/pendingApprovals as a NEW live conversation (added to
   * conversationOrder, id reused verbatim from the session — see the
   * id-space contract on ManagerConversationState), switches to it, and
   * NEVER replaces or interrupts the currently active conversation's own
   * transcript or in-flight turn. A no-op if `id` isn't a known session
   * (e.g. deleted from another tab) or if the open-conversation cap is
   * already reached.
   */
  loadManagerSession: (id: string) => void;
  /** Deletes a past conversation from history. Does not touch any currently
   *  OPEN conversation even if `id` matches one — it simply won't autosave
   *  under that id again until the user (re)saves into it, same as
   *  useChatPersistence.deleteSession's existing behaviour. */
  deleteManagerSession: (id: string) => void;
  /** Update the LazyManager's selected model (persisted across tab switches). */
  setManagerModel: (model: string) => void;
  /**
   * Update the runtime autonomy level (manual / supervised / yolo / custom).
   * KNOWN TRAP (wave 1): GLOBAL across every open conversation — see
   * AgentsState.autonomyLevel's own doc comment. Changing it here affects
   * every conversation's NEXT gate decision, not just the active one's.
   */
  setAutonomyLevel: (mode: AutonomyMode) => void;
  /**
   * Executes a gate-deferred action (see PendingApprovalAction) exactly as
   * originally proposed, via the same executeManagerAction path every other
   * action runs through — scoped to `conversationId`'s own pendingApprovals
   * queue (leading param, same convention as sendManagerMessage above).
   * Pass `{ force: true }` to retry an approve_mission bypassing the
   * judge/proof gates (approveGate.ts) — same primitive as the human's
   * "Merger quand même" button.
   *
   * Honesty fix (real user test, 2026-07-28 — three approve_mission actions
   * blocked by `mission.approve_blocked`, judge score unavailable, still
   * showed "Approuvée" in the UI): this NEVER reports success unless the
   * action genuinely executed. On success: patches the origin message's
   * actionStatuses/actionRefs to a success outcome (never the red "denied"
   * chip) and, if the executor returned a real-result message, appends it to
   * the transcript the same way an immediately-executed action's result
   * would. Returns `{ ok: true }`.
   *
   * On failure (the executor threw — e.g. ApproveBlockedError): the pending
   * request is NEVER silently dropped or reported as resolved — it stays in
   * `conversations[conversationId].pendingApprovals` (still actionable:
   * reject to abandon it, or retry, e.g. with force) with `lastFailure` set
   * to the REAL reason, verbatim. The origin message's actionStatuses is
   * patched to `false`, and — the other half of this fix — a transcript
   * message carrying that exact reason is appended so the manager reads it
   * honestly on its NEXT turn (same mechanism rejectPendingAction already
   * uses for a rejection; before this fix only a toast fired here, which
   * never reaches the manager's own context). Returns
   * `{ ok: false, reason, canForce }` — `canForce` is true only for an
   * approve_mission that wasn't already forced (a force retry bypasses
   * exactly the gate that just blocked it).
   *
   * A no-op if `id` is not a currently pending request on `conversationId`
   * (already resolved/unknown — same "idempotent, silently ignore"
   * convention as executePlan above); returns `{ ok: false }`.
   */
  approvePendingAction: (conversationId: string, id: string, opts?: { force?: boolean }) => Promise<PendingApprovalOutcome>;
  /**
   * Drops a gate-deferred action on `conversationId` without executing it.
   * Appends a transcript message so the manager is informed of the
   * rejection on its NEXT turn (that conversation's own messages feed
   * directly into its next sendManagerMessage call's history). A no-op if
   * `id` is not currently pending on that conversation.
   */
  rejectPendingAction: (conversationId: string, id: string) => void;
  /** Approves every pending action queued from the same manager turn
   *  (PendingApprovalAction.turnId) on `conversationId` — the "approve all"
   *  affordance for a turn's batch. Executes sequentially, in queued order.
   *  Returns each request's own real outcome (see approvePendingAction
   *  above) — never a blanket success just because the batch was
   *  dispatched. */
  approveAllPendingActions: (conversationId: string, turnId: string) => Promise<Array<{ id: string } & PendingApprovalOutcome>>;
  /** Rejects every pending action queued from the same manager turn on
   *  `conversationId`. */
  rejectAllPendingActions: (conversationId: string, turnId: string) => void;
  /**
   * W-MODES: sets a project's approval mode (or the global default when
   * `projectId` is omitted) and journals the flip. See approveGate.ts's
   * `evaluateAutoMerge`/approvalMode.ts's own doc comments for the full
   * mode semantics and the deliberate no-retroactive-merge decision.
   */
  changeApprovalMode: (mode: ApprovalMode, projectId?: string) => Promise<void>;
  // ── Orchestrator plan actions (Pillar E) ──
  /** Approve and execute an orchestrator plan. opts.stepIds filters to a subset. */
  executePlan: (planId: string, opts?: { stepIds?: string[] }) => Promise<void>;
  /** Return an orchestrator plan to planning status for revision. */
  revisePlan: (planId: string) => Promise<void>;
  /** Reject and delete an orchestrator plan. */
  rejectPlan: (planId: string) => Promise<void>;
  /** Feature E (per-step model chip in the pending plan card): override ONE
   *  step's launch model before validation. Persists modelId+model onto the
   *  orchestrator step and mirrors them into the store + proposal message. */
  setStepModel: (planId: string, stepId: string, modelId: string) => Promise<void>;
}

// ── Seed selection: the store always starts empty ─────────────────
// No hardcoded/demo missions, in dev or in production — Mission Control
// only ever shows real missions the user (or a persisted session) created.

function getInitialMissions(): Mission[] {
  return [];
}

// ── Counter for new mission IDs ───────────────────────────────────

/** Extracts the numeric suffix from a mission id following the "M<number>"
 *  display convention (e.g. "M15" -> 15). Mission ids are rendered verbatim
 *  as the visible badge throughout the UI (MissionCard/MissionList/
 *  MissionTimeline/MissionCalendar all render `mission.id` directly), so
 *  this format is display-load-bearing and must be preserved, not replaced
 *  by e.g. a raw timestamp. Returns 0 for anything that doesn't match so a
 *  foreign-shaped id can never corrupt the max-seen ratchet below. */
function missionIdNumber(id: string): number {
  const match = /^M(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/**
 * Monotonic counter for freshly-minted mission ids.
 *
 * Collision fix: this used to seed from a fixed demo-seed count and never
 * looked at anything else — a fixed value reset to the same starting point
 * on every app restart, so the FIRST mission created in ANY session always
 * minted the exact same id ("M15"), blind to whatever the store already
 * held. A persisted real mission from a previous session can already own
 * that same id once loaded (QA repro: a fresh "M15" collided with an
 * existing mission's "M15" — clicking the new card opened the OTHER
 * mission's detail, since every mission lookup in the store is id-keyed —
 * see resolveMissionQueryTarget above and the stop/pause/approve/discard
 * callbacks below, all `.find((m) => m.id === id)`).
 *
 * nextMissionId() now takes the store's CURRENT full mission list (persisted
 * + in-flight — whatever the caller already has in scope) and ratchets
 * missionCounter past the max numeric suffix found in it before minting, so
 * a new id can never collide with anything the caller already knows about.
 * missionCounter itself still also advances on every single call (not only
 * when a higher id is observed), so two calls made in the same synchronous
 * tick — before either one's own setState has committed — still get
 * distinct ids instead of both computing the same "max + 1" from an
 * identical, not-yet-updated snapshot.
 */
let missionCounter = 0;

/**
 * One-shot guard for the cross-project zombie sweep effect (see that
 * effect's own doc comment, below in the component). MODULE-level on
 * purpose, never a component ref/state: a `useRef`/`useState` guard resets
 * on every PROVIDER REMOUNT (e.g. an ErrorBoundary's crash/retry cycle),
 * which is exactly what caused a real prod incident (2026-08-05) — the
 * sweep re-ran on a remount with a still-empty `state.missions` and
 * re-stamped M18/M19, TWO missions launched ~1 minute earlier, as
 * "interrompues au redémarrage" at progress 0. A module-level flag
 * survives a component remount within the same page/process load (module
 * top-level code runs exactly once per JS module instantiation, never
 * re-evaluated on remount) — the sweep now truly runs at most once per
 * real app boot, never once per provider mount.
 */
let sweepRanThisBoot = false;

/** Test-only reset for `sweepRanThisBoot` (same convention as
 *  canvasStore.ts's `_resetCanvasStoreForTests`/approvalMode.ts's
 *  `_resetApprovalModesForTests`) — without this, the module-level guard
 *  that makes the zombie sweep survive a provider remount would ALSO make
 *  it survive across unrelated test cases sharing the same module
 *  instance, since only a real process restart re-evaluates module
 *  top-level code otherwise. */
// eslint-disable-next-line react-refresh/only-export-components
export function _resetZombieSweepGuardForTests(): void {
  sweepRanThisBoot = false;
}

/**
 * Minimum journal-row age (ms) before a 'running'/'queued' row absent from
 * `state.missions` is even a CANDIDATE zombie — see the cross-project
 * zombie sweep effect's own doc comment. Real prod incident (2026-08-05):
 * without this floor, two missions (M18/M19) launched ~1 minute after boot
 * were swept and re-stamped "failed" purely because the sweep's REMOUNT
 * (see `sweepRanThisBoot` above) observed an still-empty `state.missions`
 * before their own `addMission` had a chance to populate it — a fresh row
 * is never a genuine restart casualty, regardless of what the live store
 * happens to show at the instant the sweep runs. 5 minutes is deliberately
 * generous: real crash-recovery zombies are, by construction, at least as
 * old as the FULL previous session: this only ever excludes rows created
 * in the last few minutes of the CURRENT one.
 */
const ZOMBIE_MIN_AGE_MS = 5 * 60_000;

/** How often the periodic zombie re-stamp effect (declared further down in
 *  the component, right after the one-shot cross-project sweep) re-scans
 *  every project's journal for a 'running'/'queued'-with-startedAt row with
 *  no live run behind it. Deliberately much shorter than ZOMBIE_MIN_AGE_MS
 *  itself — the interval only controls how promptly a newly-eligible
 *  zombie (one that just crossed the age floor) gets re-evaluated, not how
 *  old a row has to be before it is even a candidate. */
const ZOMBIE_RESTAMP_INTERVAL_MS = 60_000;

/** Grace window (ms), measured from the periodic zombie re-stamp effect's
 *  OWN mount, during which it never re-stamps anything — no matter how the
 *  rest of its criteria evaluate. A second, independent safety margin
 *  alongside ZOMBIE_MIN_AGE_MS (which floors a ROW's own age) and the
 *  live-registry check (which floors on THIS session's own bookkeeping):
 *  this one floors on the EFFECT's own age, covering the same class of
 *  remount hazard `sweepRanThisBoot` was hoisted module-level for (see its
 *  own doc comment) — `stopFlags` is a plain `useRef`, so a provider
 *  remount resets it to empty, and a genuinely live mission launched
 *  moments before such a remount would otherwise look, for up to one
 *  interval tick, exactly like a zombie (no registry entry YET). 90s is
 *  comfortably longer than any realistic boot/remount settling window
 *  (project root resolution, journal load, applyReplayRecovery) while
 *  staying far short of ZOMBIE_MIN_AGE_MS, so it never masks a real
 *  multi-minute-old zombie. */
const ZOMBIE_RESTAMP_BOOT_GRACE_MS = 90_000;

/**
 * Founder-mandated (THE SYSTEMIC BUG fix, 2026-08-06) loud refusal message
 * for archive_mission on a still-active (running/queued) mission — the
 * complementary "never again silently confusing" half of the periodic
 * zombie re-stamp above: archiving an active mission must say so
 * explicitly and point at the one action that DOES work on an active
 * mission (delete_mission — see its own case's doc comment: "Only a
 * non-terminal mission ... keeps the old destructive behavior").
 * Deliberately NOT routed through t()/i18n: this fix's file boundary is
 * limited to agentsStore.tsx and its tests, and the locale files are out
 * of scope — one correct, explicit FR string beats inventing a translation
 * key with no actual translations behind it.
 */
const ARCHIVE_REFUSED_ACTIVE_MISSION_MESSAGE =
  'Mission encore active — archivage refusé. Utilise la suppression pour retirer une mission en cours.';

function nextMissionId(existing: readonly Mission[]): string {
  const maxSeen = existing.reduce((max, m) => Math.max(max, missionIdNumber(m.id)), missionCounter);
  missionCounter = maxSeen + 1;
  return `M${missionCounter}`;
}

/** Resolve a LazyManager pause_loop/delete_loop `loopId` (a mission id like
 *  "M12" OR a free-form name/keyword) to the matching loop mission —
 *  case-insensitive against both the mission id and its title, so the
 *  manager can act on "the lint loop" as well as an exact id. */
/** Real snapshot of every canvas-cleanup-eligible entity `clear_canvas`
 *  reads from — a thin, pure projection of canvasStoreVanilla's state plus
 *  the mission list, so `planClearCanvas` below never touches React/zustand
 *  directly and stays trivially testable. */
export interface ClearCanvasSnapshot {
  missions: readonly Mission[];
  drafts: readonly DraftSpec[];
  notes: readonly NoteData[];
  surfaces: readonly SurfaceSpec[];
  routers: readonly RouterSpec[];
  joins: readonly JoinSpec[];
  frames: readonly FrameSpec[];
}

/** Result of planning a `clear_canvas` action — every real id affected,
 *  grouped by kind, so the executor can both act on them AND report an
 *  honest count + the real refs, never a guess. `unknownScope` is set
 *  INSTEAD of a plan when `scope` is not one of the known literals: defense
 *  in depth, since parseManagerActions only validates the action's `type`
 *  (KNOWN_ACTION_TYPES) — `scope` itself is untrusted runtime JSON. */
interface ClearCanvasPlan {
  missionIds: string[];
  draftIds: string[];
  noteIds: string[];
  surfaceRefs: Array<{ id: string; kind: SurfaceSpec['kind'] }>;
  routerIds: string[];
  joinIds: string[];
  frameIds: string[];
  /** P0 fix — every 'review' mission this scope left behind because
   *  `includeReview` was not set (see reviewMissionsAwaitingDecision's own
   *  doc comment). Empty for a scope that never touches missions at all
   *  ('drafts'/'notes'/'surfaces'/'selection'), for 'failed' (a distinct,
   *  single-status scope), or when `includeReview: true` actually swept
   *  them into `missionIds` instead. The executor surfaces this count/
   *  these ids honestly even when the rest of the plan is empty, instead of
   *  a bare "nothing to clean up" in front of a canvas the user can see
   *  still has them. */
  reviewExcludedIds: string[];
  unknownScope?: string;
}

const KNOWN_CLEAR_CANVAS_SCOPES = new Set([
  'all', 'project', 'terminated', 'failed', 'drafts', 'notes', 'surfaces', 'selection',
]);

/**
 * Grounded, human-readable REAL outcome of one executed manager action —
 * returned ONLY by the cleanup/bulk actions (delete_mission, clear_canvas,
 * archive_terminated) whose completion claim is otherwise vulnerable to the
 * model narrating a fabricated count.
 *
 * P0-3 fix (real user test, PROVEN): "nettoie le canvas: supprime tout ce
 * qui est terminé ou échoué" -> the manager replied "Canvas nettoyé : 17
 * missions supprimées" with 17 "Supprimée : Mxx" lines while exactly ONE
 * mission actually vanished from the board; a follow-up "vide complètement
 * le canvas" claimed "36 missions supprimées, ardoise blanche" while ZERO
 * nodes disappeared. The model's own prose is free text with no link
 * whatsoever to what `executeManagerAction` actually did — reusing the SAME
 * message already built for the action's own toast (never a second,
 * possibly-diverging string) and appending it to the chat transcript
 * (sendManagerMessage, after the action-execution loop) means the visible
 * conversation always ends with what REALLY happened, regardless of whether
 * the model's own narration happened to agree.
 */
interface ManagerActionRealResult {
  message?: string;
  planId?: string;
  patchedRef?: string;
  /**
   * B2 fix (real QA session 2026-07-28: "Valider & lancer" flipped the
   * proposal card to ACCEPTED with zero real effect — no mission, no toast
   * survived past the click) — set `true` by `execute_plan` on every path
   * that did NOT produce its claimed real-world effect (plan not found,
   * denied by the gate, a thrown exception, or a graph run that launched
   * zero real missions). `executePlan` (this store's own caller, invoked
   * from GraphProposalCard's "Valider & lancer") reads this to decide
   * whether the proposal card is honestly allowed to read 'accepted' —
   * never on the strength of "the call didn't throw" alone, since this
   * action's own try/catch already swallows failures into a toast and
   * returns normally either way.
   */
  failed?: boolean;
  /**
   * Structured per-action outcome for chat-digest AGGREGATION (2026-08-04
   * founder directive: a batch of N approved actions used to append N
   * separate "Résultat réel" chat messages — one per target, each carrying
   * a raw absolute worktree path — unacceptable UX for e.g. 8 delete_mission
   * + 1 close_surface approved together). Present only for the action
   * kinds whose outcome benefits from being GROUPED across an approval
   * batch (currently delete_mission/archive_mission's mission-removal +
   * worktree outcome); every other action keeps using the plain `message`
   * string above, folded into the digest as its own trailing sentence. See
   * buildRealResultDigest's own doc comment for the grouping rules. The
   * per-target `message` is still the one thing ever journaled/logged —
   * this field is chat-digest-only, never a replacement for it.
   */
  digest?: RealResultDigestEntry;
}

/** One `ManagerActionRealResult.digest` entry — see that field's own doc
 *  comment. A discriminated union so `buildRealResultDigest` can add more
 *  groupable kinds later without touching every existing case. */
type RealResultDigestEntry = {
  kind: 'mission_removed';
  missionId: string;
  removedAs: 'deleted' | 'archived';
  worktree: WorktreeDiscardOutcome;
};

/**
 * Groups a batch of same-turn/-approval `ManagerActionRealResult`s into ONE
 * chat-facing digest string instead of one message per target (2026-08-04
 * founder directive — see `ManagerActionRealResult.digest`'s own doc
 * comment for the real incident this fixes). `mission_removed` entries are
 * grouped by `removedAs` (deleted vs archived) into one compact-id sentence
 * (`summarizeIds` — the same capped/compact join every other cleanup
 * report already uses) plus ONE worktree sub-sentence tallying
 * discarded/not_found/error counts (worktree project names humanized via
 * `basename`, never a raw path). Every other outcome (a `message` with no
 * `digest`) is appended verbatim as its own trailing sentence — this is a
 * REAL but partial digest, not a lossy summary: nothing here is dropped,
 * only mission-removal results are actually grouped. Returns '' for an
 * empty batch (never called in that case in practice, but never throws).
 */
function buildRealResultDigest(
  t: (key: string, params?: Record<string, string | number>) => string,
  outcomes: readonly ManagerActionRealResult[],
): string {
  const removed = outcomes.filter(
    (o): o is ManagerActionRealResult & { digest: RealResultDigestEntry } =>
      o.digest?.kind === 'mission_removed',
  );
  const other = outcomes.filter((o) => !o.digest && !!o.message);

  const sentences: string[] = [];

  for (const removedAs of ['deleted', 'archived'] as const) {
    const group = removed.filter((o) => o.digest.removedAs === removedAs);
    if (group.length === 0) continue;

    const ids = group.map((o) => o.digest.missionId);
    sentences.push(
      t(
        removedAs === 'deleted' ? 'agents.manager.realResultDigest.missionsDeleted' : 'agents.manager.realResultDigest.missionsArchived',
        { count: String(ids.length), ids: summarizeIds(ids) },
      ),
    );

    const discarded = group.filter((o) => o.digest.worktree.outcome === 'discarded');
    const notFound = group.filter((o) => o.digest.worktree.outcome === 'not_found');
    const errored = group.filter((o) => o.digest.worktree.outcome === 'error');
    const worktreeParts: string[] = [];
    if (discarded.length > 0) {
      const roots = [...new Set(
        discarded.map((o) => basename((o.digest.worktree as Extract<WorktreeDiscardOutcome, { outcome: 'discarded' }>).root)),
      )];
      worktreeParts.push(t('agents.manager.realResultDigest.worktreesDiscarded', { count: String(discarded.length), detail: roots.join(', ') }));
    }
    if (notFound.length > 0) {
      worktreeParts.push(t('agents.manager.realResultDigest.worktreesNotFound', { count: String(notFound.length) }));
    }
    if (errored.length > 0) {
      worktreeParts.push(t('agents.manager.realResultDigest.worktreesError', { count: String(errored.length) }));
    }
    if (worktreeParts.length > 0) {
      sentences.push(t('agents.manager.realResultDigest.worktreesPrefix', { detail: worktreeParts.join(', ') }));
    }
  }

  for (const o of other) sentences.push(o.message as string);

  return sentences.join(' ');
}

/**
 * An action the gate deferred (decision 'ask' — see evaluateActionGate)
 * instead of executing or discarding it. Before this fix the 'ask' branch
 * pushed a toast and dropped the action entirely, with no surface anywhere
 * in the app to actually approve it (see agentsStore.tsx's dispatch loop
 * doc comment, now removed). This is the store's queue of record: every
 * field needed to execute the SAME action later, unmodified, plus enough
 * identity to patch the outcome back onto the message that proposed it.
 *
 * Store contract exposed to the UI (AgentsStoreValue):
 * - `pendingApprovals: PendingApprovalAction[]` — the live queue.
 * - `approvePendingAction(id: string, opts?): Promise<PendingApprovalOutcome>`
 *   — executes the action via executeManagerAction and patches
 *   actionStatuses/actionRefs on its origin message to reflect the REAL
 *   outcome (success chip only on success — see PendingApprovalOutcome and
 *   this method's own doc comment on AgentsStoreValue for the full honesty
 *   contract this fix adds).
 * - `rejectPendingAction(id: string): void` — drops the request and appends
 *   a transcript message so the manager sees the rejection on its next turn.
 * - `approveAllPendingActions(turnId: string): Promise<Array<{id} & PendingApprovalOutcome>>` /
 *   `rejectAllPendingActions(turnId: string): void` — bulk resolve every
 *   pending action queued from the same manager turn (see `turnId` below).
 */
/**
 * Real outcome of one approval attempt — see approvePendingAction's own doc
 * comment (AgentsStoreValue) for the full honesty contract this powers.
 * Structurally mirrored (not imported) by PendingApprovalCard.tsx, same
 * convention as PendingApprovalAction/PendingApprovalItem below.
 */
export interface PendingApprovalOutcome {
  ok: boolean;
  /** Present when `ok` is false — the system's own reason, verbatim (e.g.
   *  ApproveBlockedError.reason). Never a generic/paraphrased message. */
  reason?: string;
  /** True when a force retry (approve_mission's own judge/proof bypass —
   *  same primitive as "Merger quand même") might resolve this failure.
   *  Always false/undefined once the failing attempt was already forced. */
  canForce?: boolean;
  /**
   * Present when `ok` is true and the action reported a real outcome —
   * the SAME `ManagerActionRealResult` executeManagerAction returned.
   * Lets a BATCH caller (approveAllPendingActions) collect every action's
   * raw result and build ONE aggregated chat digest afterward
   * (buildRealResultDigest) instead of each call appending its own
   * "Résultat réel" message — see approvePendingAction's own
   * `opts.suppressResultMessage` doc comment for the split.
   */
  result?: ManagerActionRealResult;
  /**
   * R14 (manual-approve honesty fix) — present when `ok` is false AND the
   * block came from ApproveBlockedError.judgeUnavailable: the evaluator rail
   * never produced a usable verdict (provider unreachable, or
   * scoreUnavailable — see approveGate.ts's checkApproveGate), NEVER a real
   * judge rejection. Structurally the same optional signal
   * PendingApprovalCard.tsx's own `PendingApprovalOutcome`/
   * `PendingApprovalFailureDetail` already declare support for (that file's
   * own doc comment: "no real caller populates it today... see what
   * agentsStore.tsx would need to add for these to activate end-to-end") —
   * this is that addition. A caller mapping this into the card's props can
   * render the honest "evaluation unavailable" wording instead of showing
   * `reason` as if it were a genuine rejection.
   */
  judgeUnavailable?: boolean;
  /** Per-reviewer breakdown for the same verdict `reason` describes — see
   *  ApproveGateVerdictReviewer's own doc comment (approveGate.ts). Absent
   *  when the failure isn't verdict-related. */
  verdictReviewers?: ApproveGateVerdictReviewer[];
}

interface PendingApprovalAction {
  /** Stable id (createMessageId()) — the handle the UI/store methods key on. */
  id: string;
  /** The exact action the manager proposed — executed unmodified on approval. */
  action: ManagerAction;
  /** Human-readable summary for an approval UI, e.g. "Créer un brouillon : …". */
  label: string;
  /**
   * Groups every action deferred from the SAME manager turn — powers
   * "approve all / reject all" for a turn's batch. Equal to the turn's
   * managerGenerationRef snapshot, stringified (the same id sendManagerMessage
   * itself already uses to guard against a stale/abandoned turn).
   */
  turnId: string;
  /** The assistant message this action was proposed under — actionStatuses/
   *  actionRefs on THIS message are patched in place on resolution so the
   *  existing ActionBadge rendering picks up the real outcome with no new
   *  UI path required. */
  messageId: string;
  /** Index of this action within that message's `actions` array — same
   *  index space as actionStatuses/actionRefs. */
  actionIndex: number;
  /** Model id active for the turn — reused unchanged so the action executes
   *  under the same model the user had selected when it was proposed. */
  model: string;
  /** Intra-turn alias registry (W6d) live at the moment this action was
   *  deferred — passed through unmodified to executeManagerAction on
   *  approval so a ref alias an earlier action in the SAME turn registered
   *  still resolves. */
  aliasMap: Map<string, string>;
  createdAt: string;
  /**
   * Set when a PREVIOUS approval attempt for this SAME entry failed (the
   * executor threw) rather than the entry ever leaving the queue as if
   * resolved. THE fix for the false "Approuvée" verdict (real user test,
   * 2026-07-28: three approve_mission actions blocked by
   * `mission.approve_blocked` — judge score unavailable — still showed
   * "Approuvée"): a failed approval is NEVER treated the same as a
   * resolved one. The entry stays in `pendingApprovals` (still actionable —
   * reject to abandon it, or re-approve, e.g. with force for approve_mission)
   * carrying the REAL reason the system reported, verbatim.
   */
  lastFailure?: {
    reason: string;
    canForce?: boolean;
    /** See PendingApprovalOutcome.judgeUnavailable's own doc comment — same
     *  R14 signal, carried here so a page reload / remount that re-seeds
     *  this from persistence (managerPersistence.ts) doesn't lose it. */
    judgeUnavailable?: boolean;
    verdictReviewers?: ApproveGateVerdictReviewer[];
  };
}

/**
 * PENDING-APPROVAL PERSISTENCE FIX (real user test, 2026-07-28 — see
 * managerPersistence.ts's own doc comment for the storage-side half of this
 * fix): `pendingApprovals` used to be pure in-memory state — the instant
 * AgentsStoreProvider remounted (app relaunch, or a dev-server full reload),
 * every gate-deferred action became permanently unreachable (the approval
 * card renders only from this list — see PendingApprovalCard.tsx's MOUNTING
 * CONTRACT) even though its origin message (and the "needs approval" text)
 * survived the SAME reload just fine. These two converters are the only
 * place `aliasMap` (a live `Map`, never JSON-safe) crosses the boundary to
 * managerPersistence.ts's serializable `PersistedPendingApproval` (aliasMap
 * <-> aliasEntries) — a restored entry gets a FRESH empty Map (acceptable:
 * an intra-turn alias only ever mattered for the same turn's OWN later
 * actions, already resolved one way or another by the time a reload can
 * happen; the action's own real fields — missionId, draftId, ... — are
 * unaffected and still resolve correctly).
 */
function toPersistedPendingApproval(p: PendingApprovalAction): PersistedPendingApproval {
  return {
    id: p.id,
    action: p.action,
    label: p.label,
    turnId: p.turnId,
    messageId: p.messageId,
    actionIndex: p.actionIndex,
    model: p.model,
    aliasEntries: Array.from(p.aliasMap.entries()),
    createdAt: p.createdAt,
    lastFailure: p.lastFailure,
  };
}

function fromPersistedPendingApproval(p: PersistedPendingApproval): PendingApprovalAction {
  return {
    id: p.id,
    action: p.action,
    label: p.label,
    turnId: p.turnId,
    messageId: p.messageId,
    actionIndex: p.actionIndex,
    model: p.model,
    aliasMap: new Map(p.aliasEntries),
    createdAt: p.createdAt,
    lastFailure: p.lastFailure,
  };
}

// ── Multi-conversation LazyManager (wave 1) ─────────────────────────
//
// The owner's requirement, verbatim: "je dois pouvoir avoir plusieurs
// conversation en meme temps qui taffe" — several manager conversations LIVE
// AND WORKING AT THE SAME TIME, not several saved histories switched
// between. This reuses the EXISTING ManagerSession id space
// (managerPersistence.ts) rather than inventing a parallel concept: a
// `ManagerConversationState.id` below IS the persisted session id for that
// same conversation — there is no separate "session id" vs "conversation
// id" translation anywhere in this file.
//
// Every piece of state that used to be singular (managerMessages/
// managerBusy/managerPhase/managerElapsedMs/pendingApprovals) now lives
// PER CONVERSATION, keyed in `AgentsState.conversations`. Two independent
// caps bound this (see MAX_OPEN_MANAGER_CONVERSATIONS/
// MAX_CONCURRENT_MANAGER_TURNS below) — do not merge them: an open-but-idle
// conversation costs nothing (generous cap), while a simultaneously-BUSY
// conversation holds a real LLM call (tight cap, extra sends queue behind a
// visible 'queued' phase rather than running unbounded parallel calls).
//
// KNOWN TRAP (explicitly out of wave-1 scope, per the adjudicated design):
// `autonomyLevel` stays GLOBAL — one manual/supervised/yolo/custom setting
// shared by every conversation's turns, not per-conversation. Conversations
// are NOT fully independent yet; this is a real gap, not an oversight — see
// setAutonomyLevel's own doc comment below.

/** One open LazyManager conversation's live state — see this section's own
 *  header comment for the id-space contract. */
export interface ManagerConversationState {
  /** Same id space as managerPersistence.ts's ManagerSession — this
   *  conversation IS that session once it has been autosaved at least once
   *  (see the autosave effect below); never a separate, translated id. */
  id: string;
  messages: ManagerMessage[];
  busy: boolean;
  /**
   * 'queued' is new for wave 1 (MAX_CONCURRENT_MANAGER_TURNS) — a turn that
   * was ready to send but had to wait for a busy slot to free (see
   * acquireManagerTurnSlot below). Distinct from 'turn'/'grounding' so the
   * tab strip/header can render an honest "en attente" status instead of
   * implying the LLM call is already in flight.
   */
  phase: 'idle' | 'turn' | 'grounding' | 'queued';
  elapsedMs: number;
  pendingApprovals: PendingApprovalAction[];
  /** Epoch ms of last activity (a turn starting, or a message appended) —
   *  drives wake-up routing (managerWakeup.ts's wiring below routes a
   *  proactive wake-up to the most-recently-active IDLE open conversation,
   *  never a busy one) and could later order the tab strip by recency. */
  lastActiveAt: number;
  /**
   * Tab-strip rename feature (real QA gap, 2026-08-15: several open tabs
   * derived from the same opening prompt were indistinguishable, and there
   * was no way to give one a name to tell it apart). Set only via
   * renameManagerConversation below — `undefined` means "never renamed",
   * in which case conversationTabLabel.ts's buildConversationTabLabels
   * falls back to deriving a label from the first user message, exactly as
   * before this field existed. Persisted alongside the conversation's own
   * messages (managerPersistence.ts's ManagerSession.title) so a rename
   * survives a reload — see the autosave effect and both boot-restore
   * paths below, all of which now thread it through.
   */
  customTitle?: string;
}

/** Fresh, empty conversation for `id` — the SAME shape every "open a
 *  conversation" path below (mount, "+", loading a past session) starts
 *  from, so none of them can drift from one another on what "empty" means. */
function emptyManagerConversation(id: string): ManagerConversationState {
  return { id, messages: [], busy: false, phase: 'idle', elapsedMs: 0, pendingApprovals: [], lastActiveAt: Date.now() };
}

/**
 * GOAL LOOP (founder directive — see managerEngine.ts's own "GOAL LOOP"
 * section header for the full rationale and the pure evaluate/escalate/
 * anti-procrastination logic this Map's contents drive). Module-level, NOT
 * React state and NOT threaded through ManagerConversationState: keyed by
 * conversationId, one ConversationGoal per conversation, read/written only
 * from sendManagerMessage below.
 *
 * STORAGE CHOICE (explicitly reported, not hidden): this is best-effort,
 * in-memory only — it does NOT survive a full app reload/relaunch.
 * ManagerConversationState (this file) is itself never persisted directly;
 * the actual disk-backed shape is managerPersistence.ts's ManagerSession
 * ({id, messages, createdAt, updatedAt, pendingApprovals?} — a closed
 * whitelist with no room for a goal field), which is OUTSIDE this fix's
 * file boundary (managerEngine.ts / agentsStore.tsx / orchestratorState.ts
 * only). Threading real persistence through would mean editing
 * managerPersistence.ts's ManagerSession shape and its
 * save/sanitize/load round-trip — deliberately left for a follow-up. A
 * conversation that survives a reload simply starts with no active goal,
 * same as today; nothing crashes or reads stale data, it just stops
 * tracking. Not wired into orchestratorState.ts's orchestrators.json either
 * — that file persists PLAN structure (steps/status), not the
 * conversation-level "what is the user actually trying to accomplish"
 * record a goal is; conflating the two would make one orchestrator's
 * on-disk shape carry conversation-scoped state it has no other reason to
 * know about.
 */
const conversationGoals = loadPersistedGoals();

/** Open-but-idle conversations cost nothing (no LLM call, just a transcript
 *  in memory) — this cap exists only so the tab strip and localStorage
 *  session list stay navigable, not for any resource-pressure reason. See
 *  MAX_CONCURRENT_MANAGER_TURNS below for the OTHER, unrelated cap — do not
 *  merge them. */
export const MAX_OPEN_MANAGER_CONVERSATIONS = 6;

/** Only simultaneously-BUSY conversations are throttled: the (N+1)th
 *  concurrent send queues behind a visible 'queued' phase (see
 *  acquireManagerTurnSlot below) rather than either firing an unbounded
 *  number of parallel LLM calls or blocking the send outright. */
export const MAX_CONCURRENT_MANAGER_TURNS = 3;

/** Immutable single-conversation patch — returns `state` UNCHANGED when
 *  `conversationId` no longer exists (e.g. a stale async callback resolving
 *  after that conversation was somehow removed) rather than fabricating an
 *  entry or throwing; every setState updater below goes through this so a
 *  missing conversation degrades to a silent no-op, never a crash. */
function withConversation(
  state: AgentsState,
  conversationId: string,
  patch: Partial<ManagerConversationState> | ((conv: ManagerConversationState) => Partial<ManagerConversationState>),
): AgentsState {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  const delta = typeof patch === 'function' ? patch(conv) : patch;
  return {
    ...state,
    conversations: { ...state.conversations, [conversationId]: { ...conv, ...delta } },
  };
}

/** Appends `extra` to one conversation's transcript, capped the same way
 *  the old singular managerMessages always was (capManagerMessages), and
 *  bumps `lastActiveAt` (see ManagerConversationState.lastActiveAt's own
 *  doc comment — wake-up routing reads this). */
function appendConversationMessages(
  state: AgentsState,
  conversationId: string,
  extra: ManagerMessage[],
): AgentsState {
  const conv = state.conversations[conversationId];
  if (!conv || extra.length === 0) return state;
  return withConversation(state, conversationId, {
    messages: capManagerMessages([...conv.messages, ...extra]),
    lastActiveAt: Date.now(),
  });
}

/** Maps every message in one conversation's transcript — the per-conversation
 *  counterpart to the old `prev.managerMessages.map(...)` patches (patching
 *  actionStatuses/actionRefs/proposal state onto a specific message). */
function mapConversationMessages(
  state: AgentsState,
  conversationId: string,
  mapper: (m: ManagerMessage) => ManagerMessage,
): AgentsState {
  const conv = state.conversations[conversationId];
  if (!conv) return state;
  return withConversation(state, conversationId, { messages: conv.messages.map(mapper) });
}

/** Finds which OPEN conversation contains a message matching `predicate` —
 *  used by executePlan/revisePlan/rejectPlan below, which are keyed by
 *  `planId` rather than by an explicit conversationId (their call sites
 *  — GraphProposalCard's Accept/Modify/Reject buttons — only ever knew the
 *  plan, never which conversation proposed it). Returns undefined when no
 *  open conversation currently has a matching message (already
 *  closed/pruned, or the id is stale) — callers treat that as a no-op, same
 *  "idempotent, silently ignore" convention as executePlan's own guard. */
function findConversationIdForMessage(
  state: AgentsState,
  predicate: (m: ManagerMessage) => boolean,
): string | undefined {
  for (const id of state.conversationOrder) {
    if (state.conversations[id]?.messages.some(predicate)) return id;
  }
  return undefined;
}

/** Picks which open conversation a proactive manager wake-up
 *  (managerWakeup.ts) should be routed into: the most-recently-active IDLE
 *  one (see ManagerConversationState.lastActiveAt's own doc comment) —
 *  never a busy conversation, which would race the wake-up's own turn
 *  against whatever the user (or another wake-up) already has in flight
 *  there. Returns undefined when every open conversation is currently busy
 *  — the wiring below treats that as "nothing to route to this cycle",
 *  same as the old single-conversation isManagerBusy() gate used to skip
 *  the wake-up outright. */
function pickWakeupTargetConversationId(state: AgentsState): string | undefined {
  const idle = state.conversationOrder
    .map((id) => state.conversations[id])
    .filter((conv): conv is ManagerConversationState => !!conv && !conv.busy);
  if (idle.length === 0) return undefined;
  return idle.reduce((latest, conv) => (conv.lastActiveAt > latest.lastActiveAt ? conv : latest)).id;
}

/** One pending approval tagged with which open conversation it came from —
 *  the flattened shape a future "attention inbox" bell (wave 2 — a bell
 *  aggregating pending approvals across every open conversation,
 *  click-to-jump) would render from. */
export interface AggregatedPendingApproval {
  conversationId: string;
  approval: PendingApprovalAction;
}

/**
 * Aggregation selector for the "attention inbox" bell — DEFERRED to wave 2
 * per the adjudicated wave-1 scope (this file's own report calls out the
 * deferral explicitly), but left in place here so wave 2 is a UI-only
 * change: a bell component just needs to call this and render the result,
 * no new store plumbing. Flattens every OPEN conversation's
 * pendingApprovals into one list, newest-first, each entry tagged with its
 * origin conversationId so a click can jump to (setActiveConversationId)
 * the right tab. Pure — takes a plain state snapshot, no store coupling,
 * so it's trivially unit-testable and reusable outside a React render.
 */
export function aggregatePendingApprovals(
  state: Pick<AgentsState, 'conversations' | 'conversationOrder'>,
): AggregatedPendingApproval[] {
  return state.conversationOrder
    .flatMap((conversationId) => {
      const conv = state.conversations[conversationId];
      if (!conv) return [];
      return conv.pendingApprovals.map((approval) => ({ conversationId, approval }));
    })
    .sort((a, b) => new Date(b.approval.createdAt).getTime() - new Date(a.approval.createdAt).getTime());
}

/**
 * Trims free-form model-provided text (a task/objective) to `max` characters
 * for the COMPACT label shown next to the approve/reject buttons — never
 * mid-word when a word boundary is reasonably close, and always marked with
 * an ellipsis when actually truncated. Real user report (2026-08-01 QA): a
 * plain `.slice(0, 80)` cut a launch_mission description mid-sentence with
 * no ellipsis at all ("...stack réel (" — the DOM itself just stopped),
 * asking the user to approve something he could not fully read. See
 * describePendingActionDetail below for the FULL, untruncated counterpart
 * this label is a preview of (PendingApprovalCard's expand affordance shows
 * that instead of relying on this shortened string alone). */
export function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only back off to the last space when it doesn't throw away most of the
  // budget (e.g. one giant unbroken token) — otherwise a hard cut at `max`
  // is still better than a near-empty label.
  const trimmed = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trimEnd()}…`;
}

/** Human-readable summary of a deferred action for an approval UI. Falls
 *  back to the bare action type for anything not called out explicitly
 *  below — every action type still gets SOME label, never a blank one.
 *  Exported for direct unit testing (see describePendingAction.test.ts) —
 *  the double-emission fix (mergeManagerActions' own doc comment above)
 *  requires every label to name its real target, so two distinct pending
 *  approvals are never indistinguishable to the user.
 *
 *  `t` is optional and defaults to the hardcoded French below — every
 *  caller inside a React tree (agentsStore's own useAgentsStore hook,
 *  LazyManagerMessageList) passes the real i18n `t` from useI18n() so the
 *  label follows the active locale instead of always rendering French.
 *  Every branch is now routed through i18n (agents.pendingAction.* keys,
 *  src/i18n/locales/{en,fr}.ts) with the original French string kept as the
 *  fallback for the rare non-React caller that omits `t` (see
 *  pendingApprovalLabelDistinct.test.ts, which exercises exactly that
 *  fallback path). */
export function describePendingAction(
  action: ManagerAction,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (action.type) {
    case 'launch_mission': return t
      ? t('agents.pendingAction.launchMission', { task: truncateLabel(action.task, 80) })
      : `Lancer la mission : ${truncateLabel(action.task, 80)}`;
    case 'launch_best_of_n': return t
      ? t('agents.pendingAction.launchBestOfN', { n: action.n, task: truncateLabel(action.task, 60) })
      : `Lancer un best-of-${action.n} : ${truncateLabel(action.task, 60)}`;
    // Double-emission fix (real user test, 2026-07-28 — see
    // mergeManagerActions' own doc comment above for the root-cause dedup):
    // this used to return a fixed, identical string regardless of WHICH
    // draft was targeted, so two distinct (or accidentally duplicated)
    // launch_draft approvals rendered as two indistinguishable
    // "Lancer le brouillon" rows in PendingApprovalCard — the user had no
    // way to tell what exactly each one launches. Always names the real
    // target (whichever identifier the action actually carries).
    case 'launch_draft': return t
      ? t('agents.pendingAction.launchDraft', { id: action.draftId ?? action.draftAlias ?? '?' })
      : `Lancer le brouillon : ${action.draftId ?? action.draftAlias ?? '?'}`;
    case 'create_loop': return t
      ? t('agents.pendingAction.createLoop', { task: truncateLabel(action.task, 80) })
      : `Créer une boucle : ${truncateLabel(action.task, 80)}`;
    case 'execute_plan': return t
      ? t('agents.pendingAction.executePlan', { planId: action.planId })
      : `Exécuter le plan ${action.planId}`;
    case 'revise_plan': return t
      ? t('agents.pendingAction.revisePlan', { planId: action.planId })
      : `Réviser le plan ${action.planId}`;
    case 'approve_mission': return t
      ? t('agents.pendingAction.approveMission', { missionId: action.missionId })
      : `Approuver la mission ${action.missionId}`;
    case 'reject_mission': return t
      ? t('agents.pendingAction.rejectMission', { missionId: action.missionId })
      : `Rejeter la mission ${action.missionId}`;
    case 'retry_mission': return t
      ? t('agents.pendingAction.retryMission', { missionId: action.missionId })
      : `Relancer la mission ${action.missionId}`;
    case 'clone_mission': return t
      ? t('agents.pendingAction.cloneMission', { missionId: action.missionId })
      : `Cloner la mission ${action.missionId}`;
    case 'spawn_submissions': return t
      ? t('agents.pendingAction.spawnSubmissions', { missionId: action.missionId })
      : `Lancer des soumissions pour ${action.missionId}`;
    case 'reassign_agent': return t
      ? t('agents.pendingAction.reassignAgent', { missionId: action.missionId, model: action.model })
      : `Réassigner le modèle de ${action.missionId} : ${action.model}`;
    case 'stop_all': return t ? t('agents.pendingAction.stopAll') : 'Arrêter toutes les missions';
    case 'set_budget': return t
      ? t('agents.pendingAction.setBudget', { limitUsd: action.limitUsd })
      : `Régler le budget à ${action.limitUsd} $`;
    case 'set_approval_mode': return t
      ? t('agents.pendingAction.setApprovalMode', { mode: action.mode })
      : `Changer le mode d'approbation : ${action.mode}`;
    case 'start_preview': return t ? t('agents.pendingAction.startPreview') : 'Démarrer le serveur de prévisualisation';
    case 'close_surface': return t
      ? t('agents.pendingAction.closeSurface', { surfaceId: action.surfaceId })
      : `Fermer la surface ${action.surfaceId}`;
    case 'provision_service': return t
      ? t('agents.pendingAction.provisionService', { service: action.service })
      : `Provisionner le service : ${action.service}`;
    case 'teardown_service': return t
      ? t('agents.pendingAction.teardownService', { serviceId: action.serviceId })
      : `Supprimer le service ${action.serviceId}`;
    case 'self_improve': return t
      ? t('agents.pendingAction.selfImprove')
      : 'Lancer une mission d\'auto-amélioration';
    case 'create_agent_template': return t
      ? t('agents.pendingAction.createAgentTemplate', { missionId: action.missionId })
      : `Créer un template depuis la mission ${action.missionId}`;
    case 'learn_pattern': return t
      ? t('agents.pendingAction.learnPattern', { trigger: action.trigger.slice(0, 60) })
      : `Enregistrer un pattern appris : ${action.trigger.slice(0, 60)}`;
    case 'delete_mission': return t
      ? t('agents.pendingAction.deleteMission', { missionId: action.missionId })
      : `Supprimer la mission ${action.missionId}`;
    case 'revert_mission': return t
      ? t('agents.pendingAction.revertMission', { missionId: action.missionId })
      : `Annuler la mission ${action.missionId}`;
    case 'open_project': return t
      ? t('agents.pendingAction.openProject', { path: action.path })
      : `Ouvrir le projet : ${action.path}`;
    case 'create_project': return t
      ? t('agents.pendingAction.createProject', { path: action.path })
      : `Créer le projet : ${action.path}`;
    case 'close_project': return t ? t('agents.pendingAction.closeProject') : 'Fermer le projet';
    case 'clear_canvas': {
      // Composed from two optional sub-fragments (deletion + review-loss
      // warnings) rather than one giant key — each fragment is independently
      // meaningful and the base key's {suffix} param stays empty when
      // neither applies, matching the original's empty-string ternaries.
      const suffixParts: string[] = [];
      if (action.mode === 'delete') {
        suffixParts.push(
          t ? t('agents.pendingAction.clearCanvasDeleteSuffix') : ', suppression définitive',
        );
      }
      if (action.includeReview) {
        suffixParts.push(
          t
            ? t('agents.pendingAction.clearCanvasReviewSuffix')
            : ', y compris les missions en revue (décision perdue)',
        );
      }
      const suffix = suffixParts.join('');
      return t
        ? t('agents.pendingAction.clearCanvas', { scope: action.scope, suffix })
        : `Vider le canvas (${action.scope}${suffix})`;
    }
    case 'delete_draft': return t
      ? t('agents.pendingAction.deleteDraft', { draftId: action.draftId })
      : `Supprimer le brouillon ${action.draftId}`;
    case 'delete_note': return t
      ? t('agents.pendingAction.deleteNote', { noteId: action.noteId })
      : `Supprimer la note ${action.noteId}`;
    case 'delete_router': return t
      ? t('agents.pendingAction.deleteRouter', { routerId: action.routerId })
      : `Supprimer le routeur ${action.routerId}`;
    case 'delete_join': return t
      ? t('agents.pendingAction.deleteJoin', { joinId: action.joinId })
      : `Supprimer la jonction ${action.joinId}`;
    case 'delete_frame': return t
      ? t('agents.pendingAction.deleteFrame', { frameId: action.frameId })
      : `Supprimer le cadre ${action.frameId}`;
    case 'reject_plan': return t
      ? t('agents.pendingAction.rejectPlan', { planId: action.planId })
      : `Rejeter le plan ${action.planId}`;
    case 'run_browser_recipe': return t
      ? t('agents.pendingAction.runBrowserRecipe', { profileName: action.recipe.profileName })
      : `Piloter le navigateur (profil ${action.recipe.profileName})`;
    case 'propose_mission_charter': return t
      ? t('agents.pendingAction.proposeMissionCharter', { objective: action.objective.slice(0, 60) })
      : `Proposer la charte de mission : ${action.objective.slice(0, 60)}`;
    default: return t
      ? t('agents.pendingAction.genericAction', { type: action.type })
      : `Action : ${action.type}`;
  }
}

/**
 * Full-text counterpart to describePendingAction's compact label — the user
 * must always be able to read EXACTLY what he is approving (real user
 * report, 2026-08-01 QA: a launch_mission description was cut mid-sentence
 * with no way to see the rest, "...stack réel ("). Reuses
 * describePendingAction's own switch for every action type whose label is
 * never truncated in the first place (ids/counts/short model-chosen
 * names — the overwhelming majority of cases), and only recomputes the
 * THREE cases that DO truncate free-form task/objective text
 * (launch_mission/launch_best_of_n/create_loop) with the full, un-sliced
 * text. Consumed by PendingApprovalCard's expand affordance as
 * PendingApprovalItem.detail — never persisted, always derived fresh from
 * the same `action` the compact label already comes from.
 *
 * `t` is optional for the same back-compat reason as describePendingAction
 * above (and is forwarded to it for the `default` case) — only the
 * confirmed launch_mission leak is routed through i18n here. */
export function describePendingActionDetail(
  action: ManagerAction,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (action.type) {
    case 'launch_mission': return t
      ? t('agents.pendingAction.launchMission', { task: action.task })
      : `Lancer la mission : ${action.task}`;
    case 'launch_best_of_n': return t
      ? t('agents.pendingAction.launchBestOfN', { n: action.n, task: action.task })
      : `Lancer un best-of-${action.n} : ${action.task}`;
    case 'create_loop': return t
      ? t('agents.pendingAction.createLoop', { task: action.task })
      : `Créer une boucle : ${action.task}`;
    default: return describePendingAction(action, t);
  }
}

/**
 * Pure planner for `clear_canvas` (B2/P0-4) — computes exactly which real
 * ids each scope affects, with NO functional cap (every match is included).
 * `projectId` here is an ALREADY-RESOLVED real project id (or undefined for
 * "no narrowing") — the executor resolves the raw `action.projectId` via
 * `resolveDraftProjectId` BEFORE calling this, the same choke point every
 * other project-targeting action already uses.
 *
 * `includeReview` (P0 fix, types.ts's clear_canvas doc comment): OFF by
 * default. When true, widens 'all'/'project'/'terminated' to also sweep
 * every 'review' mission into `missionIds` (same `mode` treatment as any
 * other matched mission) — 'failed' and the kind-only/'selection' scopes
 * ignore it entirely (a 'review' mission is never "failed", and a
 * kind-only/'selection' scope never touches missions by status at all).
 * Exported (with `ClearCanvasSnapshot`/`ClearCanvasPlan`) so this exact
 * scope-to-behavior contract is directly unit-tested against the prompt
 * catalog's own claims — see clearCanvasScopeCoverage.test.ts.
 */
export function planClearCanvas(
  scope: string,
  snapshot: ClearCanvasSnapshot,
  opts: { mode: 'archive' | 'delete'; projectId?: string; olderThanHours?: number; refs?: readonly string[]; includeReview?: boolean; nowMs: number },
): ClearCanvasPlan {
  const { mode, projectId, olderThanHours, refs, includeReview, nowMs } = opts;

  if (scope === 'selection') {
    const wanted = new Set(refs ?? []);
    return {
      missionIds: snapshot.missions.filter((m) => wanted.has(makeRef('mission', m.id))).map((m) => m.id),
      draftIds: snapshot.drafts.filter((d) => wanted.has(makeRef('draft', d.id))).map((d) => d.id),
      noteIds: snapshot.notes.filter((n) => wanted.has(makeRef('note', n.id))).map((n) => n.id),
      surfaceRefs: snapshot.surfaces.filter((s) => wanted.has(makeRef(s.kind, s.id))).map((s) => ({ id: s.id, kind: s.kind })),
      routerIds: snapshot.routers.filter((r) => wanted.has(makeRef('router', r.id))).map((r) => r.id),
      joinIds: snapshot.joins.filter((j) => wanted.has(makeRef('join', j.id))).map((j) => j.id),
      frameIds: snapshot.frames.filter((f) => wanted.has(makeRef('frame', f.id))).map((f) => f.id),
      reviewExcludedIds: [],
    };
  }

  if (!KNOWN_CLEAR_CANVAS_SCOPES.has(scope)) {
    return { missionIds: [], draftIds: [], noteIds: [], surfaceRefs: [], routerIds: [], joinIds: [], frameIds: [], reviewExcludedIds: [], unknownScope: scope };
  }

  const includeMissions = scope === 'all' || scope === 'project' || scope === 'terminated' || scope === 'failed';
  const missionIds = includeMissions
    ? snapshot.missions
        // `includeReview` only ever widens the terminal set — 'failed' still
        // narrows it right back down to exactly status 'failed' below, so a
        // 'review' mission never sneaks into that scope regardless.
        .filter((m) => isTerminalMissionStatus(m.status) || (includeReview === true && m.status === 'review'))
        .filter((m) => scope !== 'failed' || m.status === 'failed')
        // Archiving an already-archived mission is a harmless no-op, but
        // would inflate the reported count for nothing — only 'delete'
        // mode (a real, distinct removal from state) re-includes it.
        .filter((m) => mode === 'delete' || !m.archived)
        .filter((m) => isOlderThanHours(m.createdAt, olderThanHours, nowMs))
        .map((m) => m.id)
    : [];

  // P0 fix — every 'review' mission this scope would leave behind, for
  // whatever reason. Only meaningful for the three scopes that actually
  // consider mission status beyond a single value ('all'/'project'/
  // 'terminated'); 'failed' never implied review in the first place, and
  // the kind-only/'selection' scopes never touch missions here.
  //
  // BUG 4 fix (dogfood 2026-08-05): this used to be gated on
  // `includeReview !== true` alone, AND applied the SAME `olderThanHours`
  // filter `missionIds` uses — correct for "includeReview was never set",
  // but it meant a review mission that failed to make it into `missionIds`
  // for a DIFFERENT reason (namely `olderThanHours`, which applies
  // independently of `includeReview`) was silently dropped from BOTH the
  // sweep AND this notice: the approval card can promise "y compris les
  // missions en revue" (includeReview: true) and the executor can still
  // answer "rien à nettoyer" with zero explanation for the review mission
  // that got excluded purely on age. Candidates are now deliberately
  // NOT age-filtered — every non-archived review mission in a relevant
  // scope is a candidate, full stop — and reviewExcludedIds is "every
  // candidate MINUS whichever ones actually landed in missionIds" (which
  // DOES apply the age filter). The notice and the real sweep can then
  // never disagree, regardless of which filter did the excluding.
  const reviewCandidateIds =
    scope === 'all' || scope === 'project' || scope === 'terminated'
      ? reviewMissionsAwaitingDecision(snapshot.missions).map((m) => m.id)
      : [];
  const sweptMissionIds = new Set(missionIds);
  const reviewExcludedIds = reviewCandidateIds.filter((id) => !sweptMissionIds.has(id));

  const wantDrafts = scope === 'all' || scope === 'project' || scope === 'drafts';
  const wantNotes = scope === 'all' || scope === 'project' || scope === 'notes';
  const wantSurfaces = scope === 'all' || scope === 'project' || scope === 'surfaces';
  // Routers/joins/frames only clear on a full sweep ('all'/'project') — the
  // single-kind scopes ('drafts'/'notes'/'surfaces') stay narrowly scoped to
  // exactly the kind named, matching the task's own per-kind delete_router/
  // delete_join/delete_frame actions for the one-at-a-time case.
  const wantStructural = scope === 'all' || scope === 'project';

  return {
    missionIds,
    draftIds: wantDrafts ? snapshot.drafts.filter((d) => matchesProjectScope(d.projectId, projectId)).map((d) => d.id) : [],
    noteIds: wantNotes ? snapshot.notes.filter((n) => matchesProjectScope(n.projectId, projectId)).map((n) => n.id) : [],
    surfaceRefs: wantSurfaces
      ? snapshot.surfaces.filter((s) => matchesProjectScope(s.projectId, projectId)).map((s) => ({ id: s.id, kind: s.kind }))
      : [],
    routerIds: wantStructural ? snapshot.routers.filter((r) => matchesProjectScope(r.projectId, projectId)).map((r) => r.id) : [],
    joinIds: wantStructural ? snapshot.joins.filter((j) => matchesProjectScope(j.projectId, projectId)).map((j) => j.id) : [],
    frameIds: wantStructural ? snapshot.frames.filter((f) => matchesProjectScope(f.projectId, projectId)).map((f) => f.id) : [],
    reviewExcludedIds,
  };
}

/** Flattens a `ClearCanvasPlan` into real, typed canvas refs (e.g.
 *  "mission:M12", "draft:abc") for the executor's result toast — mixing
 *  several kinds together only reads unambiguously when each id carries its
 *  kind prefix, unlike the single-kind delete_* / archive_* actions' own
 *  toasts (which report a bare id, matching e.g. `missionNotFound`'s own
 *  convention since there is only one kind in play there). */
function describeClearCanvasRefs(plan: ClearCanvasPlan): string[] {
  return [
    ...plan.missionIds.map((id) => makeRef('mission', id)),
    ...plan.draftIds.map((id) => makeRef('draft', id)),
    ...plan.noteIds.map((id) => makeRef('note', id)),
    ...plan.surfaceRefs.map(({ id, kind }) => makeRef(kind, id)),
    ...plan.routerIds.map((id) => makeRef('router', id)),
    ...plan.joinIds.map((id) => makeRef('join', id)),
    ...plan.frameIds.map((id) => makeRef('frame', id)),
  ];
}

/** Matches runtime.ts/managedAgent.ts's identical helper — each module keeps
 *  its own copy of this 2-line formatter rather than sharing an import. */
function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Builds the review-context "question" half of a reject-with-feedback
 * decision neuron (brain-integration wave — retryMission's `opts.feedback`
 * branch, below): the REJECTED mission's title + judge verdict summary,
 * condensed to a single line. Deliberately NOT managerEngine.ts's
 * formatMissionDetail (a full action-timeline dump meant for agent-facing
 * task context) — a decision neuron's "question" half should itself read as
 * a short, recallable prompt, not bury the actual review context under an
 * unrelated action log. Honest degrade when no verdict was ever recorded
 * (e.g. a force-rejected mission the evaluator never ran) — never fabricates
 * a score/risk that was not really there.
 */
function buildRejectionReviewQuestion(mission: Mission): string {
  const v = mission.judgeVerdict;
  // R13 — same shared scoreUnavailable rule as nodeChrome.tsx (R11)/
  // DataInspector.tsx/managerAdvice.ts: never surface the `0` placeholder as
  // if it were a real score.
  const verdictLine = v
    ? `score ${formatVerdictScoreLine(v, 'unavailable')}, ${v.passed ? 'PASSED' : 'FAILED'}, risk ${v.risk}`
    : 'no judge verdict recorded';
  return `Review of mission "${mission.title}" (${verdictLine}): what should change?`;
}

/**
 * Merges a MissionUpdate patch into a mission — the single choke point every
 * `missions.map((m) => m.id === update.id ? ... : m)` site below goes
 * through, so a patch-carried actionTimeline is ALWAYS keep-last-capped
 * (capActionTimeline) regardless of which caller produced it. This matters
 * because the dominant real-world source of timeline growth is NOT this
 * file — it's the agent runtime streaming one entry per tool call/step via
 * runMission's onUpdate callback (addMission/loopScheduler's onFire/
 * retryMission below), which never went through the `updateMission` store
 * method at all before this helper existed.
 */
function mergeMissionUpdate(mission: Mission, patch: MissionUpdate['patch']): Mission {
  const merged: Mission = { ...mission, ...patch };
  return patch.actionTimeline
    ? { ...merged, actionTimeline: capActionTimeline(merged.actionTimeline ?? []) }
    : merged;
}

// ── Project root for persistence ──────────────────────────────────

/** Bound on each individual `invoke` inside {@link resolveProjectRoot} — see
 *  that function's hang-fix doc comment. 10s (not BRAIN_RECALL_TIMEOUT_MS's
 *  32s): these are trivial reads of an in-memory Rust mutex on the happy
 *  path (microseconds), never a cold-start ML spawn, so a generous-but-not-
 *  brain-recall-sized ceiling is enough to distinguish "slow" from "wedged"
 *  without making a genuinely stuck launch wait any longer than it has to. */
const PROJECT_ROOT_RESOLVE_TIMEOUT_MS = 10_000;

/**
 * Grace period (real incident, 2026-08-04) between a restart-interrupted
 * mission becoming eligible for boot-resilience auto-retry (see the
 * `autoRetryDispatchedRef` effect below) and the automatic `retryMission`
 * call actually firing. Without this window, a mission the user WANTED
 * dead (not merely interrupted — genuinely wrong, or superseded) could
 * relaunch itself before the human even sees it recovered — the exact
 * scenario that motivated this delay: the human/manager must keep a real
 * chance to delete an interrupted mission before it silently comes back on
 * its own. Deleting the mission during this window cancels the scheduled
 * retry outright (see that effect's own cancellation sweep); doing nothing
 * lets the retry fire once the window elapses, unchanged from the
 * immediate-fire behavior otherwise.
 */
export const AUTO_RETRY_GRACE_PERIOD_MS = 60_000;

/**
 * Best-effort project root: uses Tauri invoke when available, falls back to
 * git root, then cwd, then '.' as a last resort.
 *
 * Shared resolver for the REAL opened-project path — the same path
 * addMission/runMission use to create a mission's worktree (see
 * createWorktree(repoPath, branch) in runtime.ts). Exported so UI callers
 * that need to pass a repoPath to approveMission/discardMission
 * (MissionDetailControls) or to the evaluation pipeline (MissionDetail's
 * handleRunReview) resolve the SAME real path instead of each keeping its
 * own duplicate copy or, worse, hardcoding '.' — the Tauri process's own
 * cwd, almost never the opened project. That hardcoding was exactly
 * MissionDetailControls' former DEFAULT_REPO bug: Rust's
 * ensure_repo_in_project_root canonicalizes '.' to the process cwd, not the
 * opened project, so "Approve & merge"/"Rejeter" silently targeted the
 * wrong directory (see approveMission/discardMission's honesty-fix doc
 * comments below for the other half of that fix).
 *
 * @param fallbackRoot Best-known root already available to the CALLER (e.g.
 *   addMission's own `input.repo` — a mission created from the UI always
 *   carries the repo the user picked). Used ONLY when every invoke below
 *   times out or throws — see the hang-fix doc comment right below. Ignored
 *   when absent/empty/'.' (that last one carries no more information than
 *   this function's own existing dot-fallback), so every pre-existing
 *   caller that passes nothing keeps its exact current behavior.
 */
// Project root cache — resolveProjectRoot does an IPC round-trip
// (get_project_root / find_git_root / get_cwd) on EVERY call, and a single
// manager turn calls it 2-3x (fetchManagerStartupContext + the pre-LLM
// context gather + mission launches). The root only changes when the user
// switches projects (project://changed event), so a module-level cache with
// explicit invalidation eliminates the redundant IPC calls. The in-flight
// dedup (resolveProjectRootPromise) also prevents N concurrent callers from
// each spawning their own IPC for the same uncached resolution.
//
// The cache state lives in projectRootCache.ts (a tiny standalone module)
// so the test setup can reset it between tests without importing the full
// 833KB agentsStore module.
import {
  getCachedProjectRoot,
  setCachedProjectRoot,
  getStartupContextCache,
  setStartupContextCache,
  hasInjectedStartupContext,
  markStartupContextInjected,
  peekStartupContextIfCached,
  getSidecarReachableCache,
  setSidecarReachableCache,
  invalidateProjectRootCache as _invalidateProjectRootCache,
} from '../../lib/agents/projectRootCache';

/** Invalidate the cached project root — call when the active project changes
 *  (project://changed event listener in AppContext). Safe to call anytime;
 *  the next resolveProjectRoot() will re-fetch via IPC. */
// eslint-disable-next-line react-refresh/only-export-components
export function invalidateProjectRootCache(): void {
  _invalidateProjectRootCache();
}

// eslint-disable-next-line react-refresh/only-export-components
export async function resolveProjectRoot(fallbackRoot?: string): Promise<string> {
  // Fast path: return the cached root without any IPC. The cache is
  // invalidated by invalidateProjectRootCache() on project://changed, so
  // a stale root after a project switch is impossible. Only REAL IPC
  // successes are cached (see resolveProjectRootUncached) — fallbacks
  // ('.', caller-supplied) are never cached, so a failed IPC never poisons
  // subsequent calls.
  const cached = getCachedProjectRoot();
  if (cached !== null) {
    return cached;
  }
  // NOTE: dedup of concurrent callers was considered but removed — it
  // changed the timing of boot-recovery effects in tests (the shared
  // promise settled at a different point in the fake-timer timeline than
  // the separate IPC each caller used to spawn, causing the boot recovery
  // to mark freshly-created 'queued' missions as 'failed' before the test
  // could assert on them). The cache alone already eliminates the redundant
  // IPC on the hot path (manager turns, mission launches): the first
  // successful resolution populates the cache, and every subsequent call
  // hits the fast path above without any IPC at all.
  return resolveProjectRootUncached(fallbackRoot);
}

async function resolveProjectRootUncached(fallbackRoot?: string): Promise<string> {
  // Permanent, cheap phase logging (FIX-4): this function's `get_project_root`
  // invoke is the FIRST Rust round-trip in the addMission launch window (see
  // addMission below) — a wedged IPC call here neither resolves nor rejects,
  // so this whole function (every branch below is inside a try/catch that
  // only ever returns '.', never rethrows) never settles either, leaving a
  // mission frozen in 'queued' with no console error at all. Logging which
  // fallback resolved (and how long it took) turns that silent black box
  // into a one-line diagnosis instead of a guess.
  //
  // P0 hang fix (real-app QA): `get_project_root` was observed to NEVER
  // SETTLE — neither resolve nor reject — for 6+ minutes in a live run,
  // freezing a brand-new mission in 'queued' with zero journal events, no
  // worktree, and no console error, because a plain `await` here has no
  // ceiling of its own. Same failure class already fixed for runMission's
  // brain-recall call (commit 0150d17) by racing it against a timeout via
  // brainSearchLoop.ts's `withTimeout` — reused here verbatim rather than
  // inventing a second timeout helper. Every invoke below is now bounded by
  // PROJECT_ROOT_RESOLVE_TIMEOUT_MS, and the outer catch (the branch a
  // timed-out `get_project_root` lands in, same as any other rejection)
  // degrades to `fallbackRoot` when the caller supplied one, instead of
  // hardcoding '.' — the launch PROCEEDS with the best-known root rather
  // than aborting or hanging.
  const startedAt = Date.now();
  console.info('[mission:launch] resolveProjectRoot enter');
  const usableFallback =
    fallbackRoot && fallbackRoot.trim() && fallbackRoot.trim() !== '.' ? fallbackRoot.trim() : null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const root = await withTimeout(
      invoke<string>('get_project_root'),
      PROJECT_ROOT_RESOLVE_TIMEOUT_MS,
      'get_project_root',
    );
    if (root && root.trim()) {
      console.info(`[mission:launch] resolveProjectRoot exit elapsedMs=${Date.now() - startedAt} — source=get_project_root root="${root}"`);
      setCachedProjectRoot(root);
      return root;
    }
    // ProjectState is empty — find the nearest git repo root
    try {
      const gitRoot = await withTimeout(
        invoke<string>('find_git_root'),
        PROJECT_ROOT_RESOLVE_TIMEOUT_MS,
        'find_git_root',
      );
      if (gitRoot && gitRoot.trim()) {
        console.info(`[mission:launch] resolveProjectRoot exit elapsedMs=${Date.now() - startedAt} — source=find_git_root root="${gitRoot}"`);
        setCachedProjectRoot(gitRoot);
        return gitRoot;
      }
    } catch {
      // find_git_root not available
    }
    // Last resort: cwd
    try {
      const cwd = await withTimeout(invoke<string>('get_cwd'), PROJECT_ROOT_RESOLVE_TIMEOUT_MS, 'get_cwd');
      if (cwd && cwd.trim()) {
        console.info(`[mission:launch] resolveProjectRoot exit elapsedMs=${Date.now() - startedAt} — source=get_cwd root="${cwd}"`);
        setCachedProjectRoot(cwd);
        return cwd;
      }
    } catch {
      // get_cwd not available
    }
    console.info(`[mission:launch] resolveProjectRoot exit elapsedMs=${Date.now() - startedAt} — source=dot-fallback root="."`);
    return '.';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (usableFallback) {
      console.warn(
        `[mission:launch] resolveProjectRoot exit elapsedMs=${Date.now() - startedAt} — source=caller-fallback root="${usableFallback}" error=${message}`,
      );
      return usableFallback;
    }
    console.info(`[mission:launch] resolveProjectRoot exit elapsedMs=${Date.now() - startedAt} — source=catch-fallback root="." error=${message}`);
    return '.';
  }
}

/**
 * Correctness fix (self-improvement loop / W-MODES merge bug): resolves the
 * repo path to gate-check and merge a SPECIFIC mission's worktree against —
 * that mission's OWN project (via resolveMissionProjectRoot's journal-backed
 * lookup), never the currently ACTIVE project. `approve_mission` (the
 * manager action) and `triggerAutoMergeIfEligible` (the auto_green/full_auto
 * path) used to both call `resolveProjectRoot()` directly here — correct
 * only by coincidence, when the mission's own project happens to also be the
 * one currently active. Any time it isn't (the user switched projects since
 * this mission was created/last touched — agentsStore never reloads its
 * mission list on an active-project switch, see canvasDigest.ts's own module
 * doc comment — or a background mission, e.g. a self-improvement mission,
 * runs against a project the user isn't currently looking at at all) the old
 * code either silently found no matching mission, or ran a real `git merge`
 * against the WRONG repo, rejected by git and then swallowed by every
 * caller's best-effort `.catch()` — the mission then sits in 'review'
 * forever with a green judge verdict and no visible error anywhere.
 *
 * Both lookups run CONCURRENTLY (never sequentially: own-root first, active
 * as a fallback only when needed) so a miss on the mission-owned lookup
 * never costs more real latency than the pre-existing resolveProjectRoot()
 * call alone already did — this matters because triggerAutoMergeIfEligible
 * fires on every 'review' transition and autoMergeSafetyReplay.test.ts
 * drives that exact real callback end to end.
 *
 * Exported (bug audit wave) so mission-scoped UI callers — MissionNode.tsx's
 * handleGateApprove, Cockpit.tsx's 'merge' quick-action — can resolve the
 * SAME mission-owned root the manager tool and the auto-merge engine
 * already do, instead of each falling back to `resolveProjectRoot()`
 * (whatever project is currently ACTIVE, not necessarily this mission's
 * own).
 */
// eslint-disable-next-line react-refresh/only-export-components
export async function resolveMissionRepoPath(missionId: string): Promise<string> {
  const [ownRoot, activeRoot] = await Promise.all([
    resolveMissionProjectRoot(missionId),
    resolveProjectRoot(),
  ]);
  return ownRoot ?? activeRoot;
}

/**
 * Target-project fix (2026-08-02 escalation — real founder repro: a plan
 * proposed while the WRONG project was active got its orchestrator record
 * created under that active project's `.lazy/orchestrators.json`; every
 * downstream lookup by planId — execute_plan, revise_plan, reject/revise
 * from the UI, the pending-proposal preview fetch — used to assume the
 * SAME "whatever is active right now" root generate_plan used to assume,
 * which broke the instant the user validated/rejected/revised a plan while
 * a DIFFERENT project had since become active (or, after the generate_plan
 * fix below, for any plan that deliberately targets a non-active project
 * from the start). Same class of defect as resolveMissionRepoPath's own
 * doc comment above, just keyed by orchestrator id instead of mission id.
 *
 * Tries the active root FIRST (the common, unchanged case — most plans
 * target the project the user is looking at, and an orchestrator record is
 * usually found there on the very first read) then, only on a miss, scans
 * every currently open project's OWN orchestrators.json (`listProjects()`
 * — the real Tauri-backed open-project directory, not the in-memory
 * globalRuntime registry, so this works even for a project the CURRENT
 * session has not yet touched). Returns the active root unchanged when the
 * plan is found nowhere — every call site's existing "not found" handling
 * already surfaces that honestly; this never fabricates a root.
 */
async function resolveOrchestratorRoot(planId: string): Promise<string> {
  const activeRoot = await resolveProjectRoot().catch(() => '.');
  if (await getOrchestrator(activeRoot, planId)) return activeRoot;
  try {
    const projects = await listProjects();
    for (const project of Array.isArray(projects) ? projects : []) {
      if (project.root === activeRoot) continue; // already checked above
      if (await getOrchestrator(project.root, planId)) return project.root;
    }
  } catch {
    // best-effort — fall through to the active root, same as before this fix
  }
  return activeRoot;
}

/**
 * T1.3 (spec §7.3/§8) — the global session cost cap: `lazy.agents.costLimitUsd`
 * (`AgentsPanel.tsx`'s LS_AGENTS_COST_LIMIT), read here for the first time
 * since it was introduced (previously a dead setting — spec §5.1's P0
 * hygiene list). Mirrors scheduler.ts's own globalCap() pattern for the
 * sibling `lazy.agents.maxParallel` key: try/catch-wrapped direct
 * localStorage read, 0/absent/invalid -> 0 (unlimited), never throws.
 */
function sessionCostCapUsd(): number {
  try {
    const raw = localStorage.getItem(LS_AGENTS_COST_LIMIT);
    if (raw === null || raw.trim() === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Queued-launch watchdog (P0 real-app QA — the same incident
 * resolveProjectRoot's hang-fix doc comment describes): a mission stayed
 * 'queued' for 6+ minutes with zero journal events, no worktree, no
 * statusReason, and no console error — the pre-'running' launch window had
 * no ceiling of its own, only ad hoc timeouts on individual awaits (brain
 * recall, now resolveProjectRoot). Rather than chase every future await that
 * COULD hang the same way, this is a general safety net: 45s is long enough
 * that a normal launch (resolveProjectRoot — now itself bounded to
 * ~2*PROJECT_ROOT_RESOLVE_TIMEOUT_MS worst case, the session-cap check,
 * schedulerDispatch, runMission's pre-'running' phases) always clears
 * 'queued' well within it, short enough that a genuine stall surfaces before
 * a user assumes the app is just being slow.
 */
const LAUNCH_STALL_WATCHDOG_MS = 45_000;

/**
 * Cross-project queued-mission sweep cadence (2026-08-02 fix — "queued
 * missions in a project the user is not currently viewing never start"
 * incident: see relaunchQueuedMissionInOpenProject's own doc comment for
 * the full story). The giant boot-load effect only ever resolves and
 * reconciles ONE project (resolveProjectRoot()'s notion of "active" at
 * mount) and never revisits it — a mission queued into any OTHER open
 * project, whether it was already queued at boot or gets queued later
 * this session (e.g. via the LazyManager while the user works in a
 * different project), needs its own periodic check. 30s: frequent enough
 * that "queued for hours" never recurs, infrequent enough that N open
 * projects' journal reads never meaningfully compete with the 2.5s
 * fleetMissions.ts DISPLAY poll this shares the same journal_missions_current
 * invoke with.
 */
const CROSS_PROJECT_SWEEP_INTERVAL_MS = 30_000;

/**
 * Arms a one-shot timer for a mission that just entered the launch pipeline
 * (called right after addMission's 'runMission' launchPhaseEnter marker —
 * see that call site): if the mission is STILL 'queued' with no
 * statusReason LAUNCH_STALL_WATCHDOG_MS later, marks it honestly
 * (statusReason: 'launch_stalled') and emits the SAME `mission.blocked`
 * journal event shape other block reasons already use (e.g. the session-cap
 * check's 'session_budget'), so the Attention Inbox surfaces it identically
 * — honest visibility instead of a silent freeze.
 *
 * A no-op if, by the time the timer fires, the mission has already
 * progressed (status no longer 'queued'), already carries a DIFFERENT
 * statusReason (e.g. a session-budget block, which returns before this is
 * ever armed — see addMission), or was deleted — this never fights a
 * healthy or already-explained launch. retryMission clears any stale
 * 'launch_stalled' reason on its clone, so retrying a flagged mission starts
 * clean.
 *
 * Takes plain getter/setter callbacks rather than the store's hooks
 * directly, so it stays a pure, independently testable function — mirrors
 * this file's existing sessionCostCapUsd module-level helper.
 */
function armQueuedLaunchWatchdog(
  missionId: string,
  projectId: string,
  getMission: () => Mission | undefined,
  patchMission: (patch: Partial<Mission>) => void,
): void {
  setTimeout(() => {
    const current = getMission();
    if (!current || current.status !== 'queued' || current.statusReason) return;
    // Fix D (real QA — UC3 graph, 2026-08-04): a mission waiting in the
    // SCHEDULER's own queue (pool_full / scope_conflict / backed-off pool)
    // is legitimately 'queued' — with a graph whose parallel fan-out
    // exceeds the pool cap (default byok: 4), the LAST missions can sit
    // queued for minutes and this watchdog fired at 45s, flagging them
    // `launch_stalled` while they were simply waiting for a slot. The
    // scheduler already surfaces a genuinely STUCK queue on its own
    // (emitStalledSignals → `scheduler.stalled` after STALLED_QUEUE_WAIT_MS
    // = 3min, plus drain() every 15s), so this 45s frontend watchdog's
    // remaining job is only the pre-dispatch window: a mission that never
    // even REACHED the scheduler's queue (stuck in resolveProjectRoot /
    // session-cap / launch-phase awaits) still gets flagged honestly.
    if (schedulerHasQueuedEntry(missionId)) return;
    patchMission({ statusReason: 'launch_stalled' });
    emitEvent({
      type: 'mission.blocked',
      tsMs: Date.now(),
      projectId,
      missionId,
      actor: 'system',
      payload: { reason: 'launch_stalled' },
    });
  }, LAUNCH_STALL_WATCHDOG_MS);
}

// ── Persistence helpers ───────────────────────────────────────────

/** Guard: ensure the parsed value is an array of Mission-like objects. */
function parseMissionsJson(raw: unknown): Mission[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Mission =>
      typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).id === 'string',
  );
}

// ── Manager action target-project routing (shared) ────────────────────
//
// Routing parity fix (2026-08-04): launch_mission gained deterministic
// target-project routing by mention (2026-08-03, real missions M9/M10 —
// see that case's own doc comment) — when a manager action carries no
// explicit `projectId`, scan its free-text for an absolute path or an open
// project's bare name before falling back to the active project.
// generate_plan never got the same fix, so the exact incident that
// motivated launch_mission's own routing (a weak model naming its real
// target only in prose) could still silently materialize a WHOLE PLAN's
// preview graph inside whatever project happened to be active — the
// documented 2026-08-02 escalation on generate_plan's own executor case
// below. This helper is the one shared, pure-ish matching routine both
// call sites now use, so the two routing rules can never drift apart
// again.

/**
 * Deterministic target-project routing by MENTION — shared by launch_mission
 * and generate_plan. When a manager action carries no explicit `projectId`,
 * a weak manager model will often still name its real target inside the
 * free-text objective/task/step descriptions — either as an absolute path
 * or as the project's own bare name typed in prose. First scans `text` for
 * an absolute path owned by one of the OPEN projects (findOwningProject,
 * projectForPath.ts); only when that finds nothing, falls back to a
 * whole-token match of each open project's own basename inside `text`.
 * Either scan resolves ONLY on a single, unambiguous match — a mention
 * spanning zero or multiple open projects returns `undefined` so the
 * caller keeps its own default (the active project); the honest
 * "not found" refusal stays with whatever downstream guard already owns
 * that judgment (missionScopeGuard for a mission, the `unresolvedName`
 * check for a plan). Best-effort: a `listProjects()` failure (web/test, no
 * Tauri project directory) returns `undefined` rather than throwing, same
 * as both original call sites' own try/catch.
 */
export async function resolveMentionedProjectRoot(
  text: string,
): Promise<{ id: string; root: string } | undefined> {
  try {
    const openProjects = (await listProjects()).map((p) => ({ id: projectIdFromRoot(p.root), root: p.root }));
    const mentionedPaths = extractTaskAbsolutePaths(text);
    const owners = new Map<string, { id: string; root: string }>();
    for (const mentioned of mentionedPaths) {
      const owner = findOwningProject(mentioned, openProjects);
      if (owner) owners.set(owner.id, owner);
    }
    // Name-mention routing: only consulted when no absolute path matched —
    // matches open-project basenames as whole tokens; only a single
    // unambiguous match reroutes (multi-match stays undefined for the
    // caller's own default/guard to judge, never a coin-flip).
    if (owners.size === 0) {
      const textLower = text.toLowerCase();
      for (const p of openProjects) {
        const base = basename(p.root).toLowerCase();
        if (!base || base.length < 3) continue;
        if (new RegExp(`(^|[^a-z0-9])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(textLower)) {
          owners.set(p.id, p);
        }
      }
    }
    return owners.size === 1 ? [...owners.values()][0] : undefined;
  } catch {
    // Project directory unavailable (web/test) — let the caller keep its
    // own default.
    return undefined;
  }
}

// ── Replay-recovery (T0.5, spec §4.3) — journal-sourced boot only ─────
//
// Applies ONLY to missions loaded FROM THE JOURNAL (see the boot effect
// below) — the legacy missions.json fallback keeps its own, unmodified
// force-fail-running-or-queued pass (see the "#11 fix" doc comment further
// down), since that path is an explicit deviation kept only as a safety
// net for a project the journal cannot (yet, or ever) serve.
//
// B31: live PID reattach lives in replayRecovery.ts — boot fetches
// agent_run_live_ids and passes them as liveMissionIds so a still-tracked
// CLI child stays running instead of being stamped failed.

/**
 * R4b fix — "ghost queue runs" read-model half (see missionQueue.ts's
 * markStaleQueuedMissions for the durable-queue-file half of this same
 * fix). Flags every mission that is still 'queued', carries a `createdAt`
 * older than STALE_QUEUE_THRESHOLD_MS, and never actually started as
 * `queueStale: true` — a boot-time-only computation (this is a derived
 * read-model flag, not persisted state of its own; it is recomputed fresh
 * every boot from `createdAt`, so it always reflects the CURRENT age, never
 * a stale flag frozen at some earlier boot).
 *
 * Deliberately non-destructive, mirroring applyReplayRecovery's own
 * boundary: status/history are never touched, only the new flag is added —
 * a stale queued mission stays exactly as recoverable as before, just
 * clearly marked so nothing auto-relaunches it and the user consciously
 * chooses to (see the mission-card "en file (ancienne)" / "Relancer"
 * affordance this flag is meant to drive).
 */
function applyQueueStaleness(missions: Mission[], nowMs: number): Mission[] {
  return missions.map((m): Mission => {
    if (m.status !== 'queued' || m.queueStale || m.createdAt === undefined) return m;
    if (nowMs - m.createdAt < STALE_QUEUE_THRESHOLD_MS) return m;
    return { ...m, queueStale: true };
  });
}

// ── LazyManager: grounded mission resolution ──────────────────────

/**
 * Resolve a query_mission / get_agent_output target emitted by the manager.
 * Accepts either a real mission id (exact match, e.g. "M12") or an agent
 * reference ("@reviewer", "reviewer", or a known agent's display name) — in
 * the agent case, resolves to that agent's MOST RECENT mission (missions
 * are appended in creation order, so the last matching entry wins).
 * Returns undefined when nothing matches — callers must surface that
 * honestly (formatMissionNotFound) rather than guessing.
 */
export function resolveMissionQueryTarget(
  identifier: string,
  missions: Mission[],
  agents: StoredAgent[],
): Mission | undefined {
  const id = identifier.trim();
  if (!id) return undefined;

  const byId = missions.find((m) => m.id === id);
  if (byId) return byId;

  const needle = id.replace(/^@/, '').toLowerCase();
  if (!needle) return undefined;

  // A bare agent reference may use the display name ("Reviewer Agent")
  // rather than the kebab-case name ("reviewer") — resolve it first.
  const matchedAgent = agents.find(
    (a) => a.agent.name.toLowerCase() === needle || a.agent.displayName.toLowerCase() === needle,
  );
  const agentNeedle = matchedAgent ? matchedAgent.agent.name.toLowerCase() : needle;

  for (let i = missions.length - 1; i >= 0; i -= 1) {
    if (missions[i].agentName?.toLowerCase() === agentNeedle) return missions[i];
  }

  // Last resort: substring match against the title (e.g. loop iteration titles).
  // TOLOWERCASE-ON-UNDEFINED fix (2026-08-05, real prod crash during the
  // grounded turn — "Cannot read properties of undefined (reading
  // 'toLowerCase')" right after the manager referenced a query_mission
  // target): this loop walks EVERY mission in state, not just the one being
  // searched for — an unarchived, sparsely-written journal row (M21/M22-
  // class debris with `title` absent) anywhere in that array used to crash
  // this whole grounded turn, even when the mission actually being queried
  // (e.g. M34/M35) was perfectly well-formed. String(x ?? '') never throws.
  for (let i = missions.length - 1; i >= 0; i -= 1) {
    if (String(missions[i].title ?? '').toLowerCase().includes(needle)) return missions[i];
  }

  return undefined;
}

/**
 * A per-call AbortController bounded by its OWN `inactivityMs`/`absoluteMs`
 * deadlines, ALSO wired to abort the moment `parent` aborts — so a single LLM
 * call (the manager's main planning turn, or its grounded follow-up) gets an
 * independent clock instead of every call in an exchange sharing one ceiling.
 *
 * P0-1 fix: this replaces the old design where sendManagerMessage minted ONE
 * AbortController/timeout for the WHOLE exchange and handed the exact same
 * signal to both the first runManagerTurn call and runGroundedFollowUp's own
 * call — a grounded exchange that needed real work on BOTH calls (proven
 * live: "write a script then have it tested", "chain a coder then a
 * reviewer") had to fit two sequential CLI cold starts + generations inside
 * ONE shared 90s window, reliably blowing through it with zero nodes
 * created. Each call now gets a FRESH MANAGER_LLM_CALL_TIMEOUT_MS budget of
 * its own, counted from when THAT call starts — never shrunk by however long
 * an earlier call in the same exchange took.
 *
 * C3 fix (real-log root cause — two turns died at exactly 300s with SMALLER
 * prompts than other calls that finished fine, both times under heavy host
 * contention): `inactivityMs` is no longer armed once and left alone. Every
 * call to `reportActivity()` — wired to ManagerTurnOptions.onChunk, invoked
 * once per streamed fragment by runManagerTurn (managerEngine.ts) — clears
 * and re-arms it, so a call that is genuinely still receiving fragments (just
 * slowly) is never killed by a fixed wall clock. `absoluteMs` is a SEPARATE,
 * deliberately generous ceiling that never rearms — the backstop against a
 * call that streams forever and so would otherwise never trip the inactivity
 * deadline. `getTimeoutReason()` reports which of the two actually fired
 * ('inactivity' | 'absolute' | undefined — undefined covers "no timeout at
 * all" AND "aborted for a different reason, e.g. parent Stop/global-cap"),
 * so the caller can render an honest, distinct message for each case instead
 * of one generic "timed out" line.
 *
 * `parent` stays the single source of truth for the user Stop button and the
 * exchange-wide MANAGER_TURN_TIMEOUT_MS backstop (see sendManagerMessage's
 * `turnCtrl`) — aborting it always reaches whichever call is currently in
 * flight, since every call's child controller listens for it.
 *
 * The caller MUST call `dispose()` once its call settles (success or
 * failure) to clear both per-call timers and detach the parent listener —
 * otherwise a fast call would leak live timers for the rest of the turn.
 */
type ManagerCallTimeoutReason = 'inactivity' | 'absolute';

interface ManagerCallController {
  signal: AbortSignal;
  /** Rearms the inactivity deadline — call once per streamed fragment. */
  reportActivity: () => void;
  /** Which of this controller's OWN deadlines fired, if either did. */
  getTimeoutReason: () => ManagerCallTimeoutReason | undefined;
  dispose: () => void;
}

function createManagerCallController(
  parent: AbortSignal,
  inactivityMs: number,
  absoluteMs: number = MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS,
): ManagerCallController {
  const controller = new AbortController();
  let timeoutReason: ManagerCallTimeoutReason | undefined;

  const fireTimeout = (reason: ManagerCallTimeoutReason) => {
    if (controller.signal.aborted) return;
    timeoutReason = reason;
    controller.abort();
  };

  let inactivityTimer = setTimeout(() => fireTimeout('inactivity'), inactivityMs);
  const absoluteTimer = setTimeout(() => fireTimeout('absolute'), absoluteMs);

  const onParentAbort = () => controller.abort();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    signal: controller.signal,
    reportActivity: () => {
      if (controller.signal.aborted) return;
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => fireTimeout('inactivity'), inactivityMs);
    },
    getTimeoutReason: () => timeoutReason,
    dispose: () => {
      clearTimeout(inactivityTimer);
      clearTimeout(absoluteTimer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Wraps `promise` so it rejects the instant `signal` aborts — even if
 * `promise` itself never observes the signal at all (a stalled CLI/managed
 * transport that neither resolves, rejects, nor reacts to abort — the exact
 * shape the "bounds the grounded follow-up to its own timeout" regression
 * test exercises). createManagerCallController's own inactivity/absolute
 * timers fire independently of whatever the wrapped promise does, so this is
 * what turns that internal `controller.abort()` into an actual, guaranteed
 * rejection here — the previous design got this same guarantee from
 * brainSearchLoop.ts's withTimeout (a fixed, non-resettable `ms`), which is
 * no longer usable as-is now that the real deadline lives inside `signal`
 * and rearms on activity (see createManagerCallController's doc comment).
 */
function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException(`${label} aborted`, 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * APPROVE→MERGE INERT fix (2026-08-05, real prod incident — reviews
 * M21/M23/M25 stayed unmerged for HOURS after a human/manager approval
 * (the "Merger" button AND the manager's approve_mission tool, force
 * included), then all landed at once much later): mergeWorktree and the
 * git reads around it (approveMissionInner, below) are real Tauri invokes
 * with no deadline of their own — a stuck git operation (e.g. a stale lock
 * held by an earlier, still-hung merge on the SAME repo) left `await
 * mergeWorktree(...)` neither resolving nor rejecting, so
 * approveMissionInner's own caller just hung too: no error, no toast, no
 * `mission.approve_blocked` journal entry, completely silent — until
 * whatever was holding the underlying resource finally let go, at which
 * point every approval queued behind it resolved together.
 *
 * Bounds any single approve-path invoke to `ms`; on expiry, rejects with a
 * clear, distinguishable message instead of leaving the caller hanging
 * indefinitely. The rejection surfaces through the SAME error paths every
 * other approveMissionInner failure already does (the mergeWorktree
 * try/catch's own `throw err` for a real Tauri failure, approveMission's
 * `mission.approve_blocked` journal write, the approve_mission executor's
 * actionFailed message / approvePendingAction's lastFailure) — never a new,
 * parallel error channel.
 */
function withApproveTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `${label} timed out after ${ms}ms — it may still complete in the background; check the mission's real status before retrying`,
      ));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Deadline for any single approve-path invoke (worktreeDiff, git.log,
 *  mergeWorktree) — see withApproveTimeout's own doc comment. Generous
 *  enough for a real (slow) git merge on a large repo, short enough that a
 *  genuinely stuck operation surfaces as an honest error within one human
 *  attention span rather than staying silent for hours. Exported (same
 *  convention as MANAGER_TURN_TIMEOUT_MS/GROUNDED_FOLLOWUP_TIMEOUT_MS) so
 *  tests can advance fake timers by the real budget instead of a
 *  duplicated magic number that could silently drift out of sync. */
export const APPROVE_GIT_READ_TIMEOUT_MS = 45_000;
export const APPROVE_MERGE_TIMEOUT_MS = 180_000;

export interface GroundedFollowUpOptions {
  /** The first manager turn's result — inspected for a query_mission/get_agent_output action. */
  firstTurn: ManagerTurnResult;
  /** Same conversation messages sent to the first turn (re-sent unchanged). */
  messages: ManagerMessage[];
  /** Same base context sent to the first turn (missionDetail is added on top). */
  context: ManagerContext;
  agents: StoredAgent[];
  /** Missions the grounding queries resolve against. Prefer a GETTER
   *  (`() => stateRef.current.missions`): a plain array is the snapshot
   *  captured when the calling closure was created, and the post-approval
   *  automated turn runs from a `sendManagerMessage` closure older than the
   *  mission it just launched — live QA 2026-09-02: `run_lazybot` created
   *  M95, the resume turn queried M95 against that stale array and the
   *  manager honestly (but wrongly) told the user "no mission matches M95"
   *  while M95 was finishing on the canvas. */
  missions: Mission[] | (() => Mission[]);
  model: string;
  /**
   * Parent abort signal for the WHOLE manager exchange — the user Stop
   * button and the exchange-wide MANAGER_TURN_TIMEOUT_MS backstop (see
   * sendManagerMessage's `turnCtrl`), NOT a per-call deadline. This function
   * derives its OWN child AbortController from it (createManagerCallController,
   * MANAGER_LLM_CALL_TIMEOUT_MS) for its one internal runManagerTurn call, so
   * the follow-up gets a fresh budget regardless of how long the first turn
   * took (P0-1 fix — see createManagerCallController's doc comment for the
   * "two calls stacked into one shared window" bug this replaces), while
   * Stop/the global backstop can still reach it by aborting `signal`.
   */
  signal?: AbortSignal;
  /** Live UI stream for the follow-up completion — see ManagerTurnOptions.onPartial. */
  onPartial?: (accumulatedRaw: string) => void;
}

/** Every action kind that triggers a grounded follow-up turn — the FIRST of
 *  each kind is used (bounds grounding to at most one extra platform call per
 *  kind), matching the array shape .find() naturally produces. Extracted so
 *  sendManagerMessage can honestly know (BEFORE calling runGroundedFollowUp)
 *  whether a grounding round-trip is about to happen at all, to drive the
 *  rail's "Recherche dans le brain…" status line (managerPhase). */
interface GroundingActions {
  missionQueryAction?: Extract<ManagerAction, { type: 'query_mission' | 'get_agent_output' }>;
  brainQueryAction?: Extract<ManagerAction, { type: 'brain_query' }>;
  cssAction?: Extract<ManagerAction, { type: 'brain_query_css' }>;
  neighboursAction?: Extract<ManagerAction, { type: 'brain_neighbours' }>;
  webSearchAction?: Extract<ManagerAction, { type: 'web_search' }>;
  webFetchAction?: Extract<ManagerAction, { type: 'web_fetch' }>;
  briefingQueryAction?: Extract<ManagerAction, { type: 'briefing_query' }>;
  decisionLookupAction?: Extract<ManagerAction, { type: 'decision_lookup' }>;
  /** Structural project digest (lib/agents/projectDigest.ts) — same
   *  grounding treatment as brain_query above: read-only, resolved before
   *  the manager's next turn, never mutating. See groundingDedupKey. */
  scanProjectAction?: Extract<ManagerAction, { type: 'scan_project' }>;
  /** LazyBot roster (lib/bots) — read-only list of saved bots with their
   *  live runtime state, resolved before the manager's next turn so it can
   *  answer "list my bots" with the REAL list in the SAME exchange. Without
   *  this the executor's real-result message only reaches the model on the
   *  NEXT user message, and a terse model left the visible reply as the
   *  action chip alone. Same grounding treatment as scan_project. */
  listLazybotsAction?: Extract<ManagerAction, { type: 'list_lazybots' }>;
}

function findGroundingActions(actions: readonly ManagerAction[]): GroundingActions {
  return {
    missionQueryAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'query_mission' | 'get_agent_output' }> =>
        a.type === 'query_mission' || a.type === 'get_agent_output',
    ),
    brainQueryAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'brain_query' }> => a.type === 'brain_query',
    ),
    cssAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'brain_query_css' }> => a.type === 'brain_query_css',
    ),
    neighboursAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'brain_neighbours' }> => a.type === 'brain_neighbours',
    ),
    webSearchAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'web_search' }> => a.type === 'web_search',
    ),
    webFetchAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'web_fetch' }> => a.type === 'web_fetch',
    ),
    briefingQueryAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'briefing_query' }> => a.type === 'briefing_query',
    ),
    decisionLookupAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'decision_lookup' }> => a.type === 'decision_lookup',
    ),
    scanProjectAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'scan_project' }> => a.type === 'scan_project',
    ),
    listLazybotsAction: actions.find(
      (a): a is Extract<ManagerAction, { type: 'list_lazybots' }> => a.type === 'list_lazybots',
    ),
  };
}

/** True when at least one grounding action was found — i.e. runGroundedFollowUp
 *  will actually perform an extra round-trip rather than short-circuiting. */
function hasAnyGroundingAction(g: GroundingActions): boolean {
  return !!(
    g.missionQueryAction || g.brainQueryAction || g.cssAction || g.neighboursAction ||
    g.webSearchAction || g.webFetchAction || g.briefingQueryAction || g.decisionLookupAction ||
    g.scanProjectAction || g.listLazybotsAction
  );
}

/**
 * Inactivity ceiling for the grounded follow-up round-trip SPECIFICALLY
 * (R2a fix, thread 1b). Before this fix, a stalled follow-up (e.g. a hung
 * CLI transport on the second call) silently fell back to the first turn's
 * text with NO visible sign anything went wrong — the user just never got a
 * grounded answer and had no idea why.
 *
 * P0-1 fix: now simply re-exports the shared per-call budget
 * (MANAGER_LLM_CALL_TIMEOUT_MS, managerEngine.ts) instead of its own
 * independent, shorter value — every LLM call the manager makes (main turn
 * or follow-up) gets the exact same 300s budget, kept as a distinct exported
 * name since existing callers/tests reference it as "the follow-up's own
 * ceiling" specifically.
 *
 * C3 fix: this is now specifically the INACTIVITY half of that budget (see
 * MANAGER_LLM_CALL_TIMEOUT_MS's doc comment) — the follow-up call also gets
 * the separate MANAGER_LLM_CALL_ABSOLUTE_TIMEOUT_MS hard ceiling via
 * createManagerCallController's default parameter, not re-exported here
 * since no existing caller referenced it by a distinct name.
 */
export const GROUNDED_FOLLOWUP_TIMEOUT_MS = MANAGER_LLM_CALL_TIMEOUT_MS;

/** Maximum number of LLM calls in a single manager exchange (main turn +
 *  grounding follow-ups). The loop terminates when the model emits no more
 *  grounding actions OR this cap is reached — whichever comes first.
 *  4 = 1 main turn + up to 3 grounding rounds, enough for a complex
 *  multi-step investigation without unbounded credit burn. */
export const MAX_MANAGER_TURNS = 4;

/** Result of runGroundedFollowUp: the text to show (first-turn text when no
 *  grounding was needed, or when grounding failed — never blank), plus an
 *  honest failure reason when the follow-up round-trip itself failed or
 *  timed out (undefined = grounding either wasn't needed or succeeded). */
export interface GroundedFollowUpResult {
  responseText: string;
  /** Raw (untranslated) technical failure detail — used as the `{reason}`
   *  param of cockpit.manager.groundedFailure for a genuine (non-timeout)
   *  backend error. For a timeout, prefer failureIsTimeout/failureElapsedMs
   *  instead (see their doc comments) so the caller can render a properly
   *  localized, phase+elapsed-aware message rather than this raw string. */
  failureReason?: string;
  /**
   * True when the follow-up failed BECAUSE its own per-call budget (or the
   * parent's Stop/global-cap signal) elapsed, rather than a genuine backend
   * error (P0-1 fix, item #2 — "which phase timed out, generation vs
   * search"). The caller (sendManagerMessage) uses this to render the same
   * phase+elapsed-aware cockpit.manager.turnTimeout message the main call's
   * own timeout uses, instead of the generic groundedFailure line.
   */
  failureIsTimeout?: boolean;
  /**
   * C3 fix — which of the follow-up call's OWN two deadlines actually fired
   * (see ManagerCallController.getTimeoutReason's doc comment): 'inactivity'
   * (no fragment at all for the inactivity budget) or 'absolute' (the
   * generous hard ceiling, even though fragments kept arriving). Undefined
   * when failureIsTimeout is false, OR when the parent's Stop/global-cap
   * signal aborted this call instead of either of its own deadlines. The
   * caller uses this to pick between cockpit.manager.turnTimeout ("no
   * response") and cockpit.manager.turnTimeoutAbsolute ("max duration
   * reached") instead of one generic line for both.
   */
  failureTimeoutReason?: ManagerCallTimeoutReason;
  /** Real measured wall-clock time (ms) the follow-up call was in flight
   *  before it failed — set alongside failureReason, used to fill the
   *  "{elapsed}" slot of cockpit.manager.turnTimeout when failureIsTimeout. */
  failureElapsedMs?: number;
  /**
   * The grounded follow-up turn's OWN actions (R4b fix — root cause: this
   * field did not exist, so the caller (sendManagerMessage) only ever
   * executed the FIRST turn's actions; when a composite order triggered a
   * grounding action (brain_query/query_mission/...) in turn 1, whatever the
   * SECOND, grounded turn actually decided to do (create_draft, chain_agents,
   * arrange_canvas, focus_canvas, reject_mission, ...) was parsed for
   * display — it rendered as chips — but never dispatched through
   * executeManagerAction. Proven live in R3's dogfood run: "manager reply
   * claims drafts were created but only 0 new draft(s) exist on canvas".
   * Undefined when no grounding happened (nothing to add — the caller keeps
   * using the first turn's actions unchanged) OR when the follow-up call
   * itself failed/timed out (failureReason is set instead — there is no
   * turn-2 action list to trust in that case).
   */
  actions?: readonly ManagerAction[];
  /**
   * 2026-07-28 fix — total count of earlier-pass MUTATING actions abandoned
   * (never executed) across the whole loop because a later grounded pass
   * superseded them with its own (see mergeManagerActions' doc comment for
   * the exact "last mutating pass wins" rule). 0/undefined when nothing was
   * ever superseded. Exposed for debuggability (console today, a future rail
   * indicator if ever needed) — deliberately NOT a per-action user-facing
   * notice, which would spam the chat on every multi-turn grounded exchange.
   */
  supersededMutantActionCount?: number;
}

/** Duck-typed `.message` extraction — deliberately NOT `err instanceof
 *  Error`: a DOMException built via `new DOMException(...)` (withTimeout's
 *  own abort-path rejection, brainSearchLoop.ts) does not reliably satisfy
 *  `instanceof Error` in every test/runtime realm (observed live: jsdom's
 *  DOMException failed this check while its `.message`/`.name` were both
 *  present and correct), which silently misclassified every abort-triggered
 *  follow-up failure as a generic error. */
function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message ?? '');
  }
  return String(err);
}

/** Duck-typed `.name` extraction — see errorMessage's doc comment for why
 *  this avoids `instanceof Error`/`instanceof DOMException`. */
function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err) {
    return String((err as { name?: unknown }).name ?? '');
  }
  return undefined;
}

/** Human-readable, untranslated technical detail for a NON-timeout grounded
 *  follow-up failure — used as-is (cockpit.manager.groundedFailure's
 *  `{reason}` param already carries locale-specific surrounding text). A
 *  timeout is detected and reported separately (failureIsTimeout/
 *  failureElapsedMs on GroundedFollowUpResult) so it never has to hardcode
 *  a locale here. */
function describeGroundedFailure(err: unknown): string {
  return errorMessage(err).slice(0, 160);
}

/** True when `err` reflects an abort (this call's own per-call budget
 *  elapsing, OR the parent Stop/global-cap signal aborting) rather than a
 *  genuine backend error — recognizes both withTimeout's own "<label> timed
 *  out after <ms>ms" / "<label> aborted" rejections and a real AbortError
 *  the underlying provider itself might throw when it observes the signal. */
function isAbortLikeFailure(err: unknown): boolean {
  if (/timed out after|aborted/i.test(errorMessage(err))) return true;
  return errorName(err) === 'AbortError';
}

/**
 * Visible-artifact fix — the caller-defined generic label passed as
 * `freezeLoopTemplate`'s `kind` when freezing a RESOLVED propose_artifact
 * variant (see loopArtifact.ts's own doc comment: "never a fixed enum").
 * A plain constant, not a hardcoded domain shape — any subject's artifact
 * freezes under this same generic label.
 */
const ARTIFACT_TEMPLATE_KIND = 'visual_template';

/**
 * Visible-artifact fix (real founder feedback: "comment tu me montres les
 * designs proposes ?") — flattens propose_artifact's `variants` (each with
 * its own views) into the flat `SurfaceHtmlView[]` PreviewNode.tsx's
 * ArtifactSurfaceCard actually renders: canvasTypes.ts's SurfaceSpec has no
 * variant-grouping concept — a surface navigates VIEWS only (see that
 * file's own doc comment on `htmlViews`). Each view's label is prefixed
 * with its variant's label ONLY when more than one variant is present — a
 * single-variant proposal (or an already-RESOLVED one, since the executor
 * narrows to just the chosen variant before calling this) shows plain view
 * labels, unchanged from how ArtifactSurfaceCard already renders any other
 * htmlViews list. Exported for direct unit testing (pure, no store/React
 * dependency).
 */
export function buildArtifactSurfaceViews(variants: readonly ArtifactVariant[]): SurfaceHtmlView[] {
  const showVariantLabel = variants.length > 1;
  return variants.flatMap((variant) =>
    variant.views.map((view) => ({
      id: `${variant.id}:${view.id}`,
      label: showVariantLabel ? `${variant.label} — ${view.label}` : view.label,
      html: view.html,
    })),
  );
}

/**
 * Visible text for a manager turn, INCLUDING any answer the model delivered
 * inside an `info` action instead of (or in addition to) plain prose.
 *
 * R2a fix (thread 1, PROVEN in-app): the executor's `case 'info': break;`
 * is a deliberate no-op ("the manager already responded in text") and
 * `stripActionBlock` deletes the whole <lazy_actions> JSON from the display
 * text — so when the model follows the system prompt's own action-24
 * contract ("If no action is needed (just answering a question), use
 * {\"type\": \"info\", \"message\": \"...\"}") and puts its ACTUAL ANSWER in
 * the info message, that answer was silently discarded. Observed live in
 * the triage run: the grounded follow-up completed without error yet the
 * bubble showed only the pre-search narration ("Je vais fouiller le
 * brain…") — the grounded content was inside the stripped block.
 *
 * P2-13 fix (real user test, verbatim, PROVEN): "Carrousel d'images ou
 * vraie vidéo Remotion rendue ?Carrousel d'images ou vraie vidéo Remotion
 * rendue ? Ça détermine tout le pipeline..." — the original de-dup check
 * only tested ONE direction (skip the info message when `prose` already
 * contains it verbatim), which correctly collapses an EXACT repeat but
 * missed the shape actually observed live: the info message repeats the
 * prose's own opening THEN extends it with more detail, so `info` is the
 * LONGER string and "is info a substring of prose" can never match — the
 * old code appended it as if it were new content, printing the same
 * opening twice back-to-back. Handled below by direction:
 *   - `prose` already contains `info` verbatim -> `info` adds nothing, skip it.
 *   - `info` itself contains `prose` verbatim (the superset/extends case)
 *     -> `info` alone is the more complete statement; drop the redundant
 *     shorter `prose` instead of printing both.
 *   - otherwise -> genuinely different content, keep both (unchanged
 *     behavior for the R2a case above: a short "je cherche…" lead-in
 *     followed by an unrelated grounded answer).
 * Guarded on a non-empty `prose`: an EMPTY prose (the first-turn/
 * no-grounding "answer lives entirely in the info action" shape — see the
 * tests guarding that path) must never be treated as containing/contained
 * by anything, which would otherwise wrongly swallow every info message
 * whenever prose is blank (`''.includes(x)` is vacuously false, but
 * `x.includes('')` is vacuously TRUE for any non-empty x).
 *
 * P0-2 fix (round 3 QA, managerEngine.ts's dedupeRepeatedSegments doc
 * comment has the full root-cause story): `turn.responseText` already went
 * through sanitizeManagerDisplayText — including dedupeRepeatedSegments — in
 * runManagerTurn, but an `info` action's own `message` field is parsed
 * straight out of the <lazy_actions> JSON and never passed through that
 * sanitizer, so a self-corrected/repeated restatement landing INSIDE an
 * info message (rather than in the surrounding prose) would slip through
 * untouched. Each raw info message is deduped here before the
 * prose-containment checks below, and the final joined text gets one more
 * pass in case the repeat straddles the prose/info boundary itself (e.g.
 * prose ends with one restatement, an info message opens with another).
 */
function turnDisplayText(turn: ManagerTurnResult): string {
  const infoMessages = turn.actions
    .filter((a): a is Extract<ManagerAction, { type: 'info' }> => a.type === 'info')
    .map((a) => a.message)
    .filter((m): m is string => typeof m === 'string' && m.trim().length > 0);

  let prose = turn.responseText.trim();
  const parts: string[] = [];
  for (const raw of infoMessages) {
    const info = dedupeRepeatedSegments(raw).trim();
    if (prose.length > 0 && prose.includes(info)) continue;
    if (prose.length > 0 && info.includes(prose)) prose = '';
    parts.push(info);
  }
  const joined = [prose, ...parts].filter((s) => s.trim().length > 0).join('\n\n');
  return dedupeRepeatedSegments(joined);
}

/**
 * Item 6 fix (real user QA, 2026-08-01, verbatim: "a question about
 * installer packaging appeared as a summary paragraph AND again as the
 * question body"): a propose_mission_charter turn's prose (`content`,
 * built from turnDisplayText above) can restate a charter decision's
 * `question` verbatim — the model narrates its reasoning in text AND emits
 * the SAME question as a structured decision for DecisionCard's
 * click-to-answer UI (MissionCharterCard) — so the user reads the exact
 * same sentence twice: once as inert prose, once as the interactive
 * question. Only `turnDisplayText`'s prose/info fold ever ran; nothing
 * cross-checked prose against `charterAction.decisions[].question`, which
 * is a completely separate field on a completely separate action type.
 *
 * Same direction-both-ways containment check as turnDisplayText's own
 * prose/info fold above (a paragraph that IS a question, or that merely
 * CONTAINS/IS CONTAINED BY one, in either direction) — strips the
 * duplicated paragraph from the prose, leaving DecisionCard as the ONE
 * place that question is shown (it is the more useful rendering: clickable,
 * with its recommendation/rationale attached). A paragraph that only
 * mentions the same topic without restating the question text itself is
 * left untouched.
 *
 * A6 — also strips near-paraphrases via word Jaccard + char-trigram
 * fingerprint so a 3rd rewording of the decision question does not reappear
 * as a prose paragraph beside DecisionCard.
 */
function normalizeProseDedup(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function proseTokenSet(text: string): Set<string> {
  return new Set(
    normalizeProseDedup(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

function proseTrigramSet(text: string): Set<string> {
  const compact = normalizeProseDedup(text).replace(/[^a-z0-9]+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i <= compact.length - 3; i++) grams.add(compact.slice(i, i + 3));
  return grams;
}

function setJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function proseNearQuestion(paragraph: string, question: string): boolean {
  if (paragraph === question || paragraph.includes(question) || question.includes(paragraph)) {
    return true;
  }
  const shorter = Math.min(paragraph.length, question.length);
  const longer = Math.max(paragraph.length, question.length);
  if (shorter < 16 || longer / shorter > 2.5) return false;
  const wa = proseTokenSet(paragraph);
  const wb = proseTokenSet(question);
  if (wa.size >= 3 && wb.size >= 3 && setJaccard(wa, wb) >= 0.55) return true;
  const ta = proseTrigramSet(paragraph);
  const tb = proseTrigramSet(question);
  return ta.size >= 8 && tb.size >= 8 && setJaccard(ta, tb) >= 0.48;
}

export function dedupeProseAgainstDecisionQuestions(
  prose: string,
  decisions: readonly DecisionWithRecommendation[] | undefined,
): string {
  if (!decisions || decisions.length === 0) return prose;
  const questions = decisions.map((d) => d.question.trim()).filter((q) => q.length > 0);
  if (questions.length === 0) return prose;
  const kept = prose.split(/\n{2,}/).filter((raw) => {
    const paragraph = raw.trim();
    if (paragraph.length === 0) return true;
    return !questions.some((q) => proseNearQuestion(paragraph, q));
  });
  return kept.join('\n\n').trim();
}

/** Result of mergeManagerActions (see its doc comment for the exact rule) —
 *  the action list to actually execute, plus an honest count of how many
 *  earlier-pass MUTATING actions were abandoned (never executed) because a
 *  later pass superseded them. Logged by the caller (runGroundedFollowUp),
 *  never shown to the user as a per-action notice — debuggable via console
 *  instead of chat spam (requirement: journalize without spamming). */
// eslint-disable-next-line react-refresh/only-export-components
export interface MergeManagerActionsResult {
  actions: ManagerAction[];
  /** 0 when nothing was superseded — either the normal single-pass case, or
   *  turn-2 emitted no mutating action of its own so turn-1's were kept. */
  supersededMutantCount: number;
}

/**
 * Combine turn-1's actions with a SUCCESSFUL grounded follow-up (turn-2)
 * turn's own actions into ONE ordered list for a single execution pass (R4b
 * fix for the original "grounded-turn actions discarded" defect — see
 * GroundedFollowUpResult.actions' doc comment for that root-cause proof).
 *
 * 2026-07-28 fix (real user report, verbatim: "mes utilisateurs se plaignent
 * que l'app rame" produced 6 off-topic billing drafts+chains from turn 1 AND
 * the 3 correct perf-audit drafts+chains from the grounded turn 2 — BOTH
 * graphs executed onto the canvas, 9 nodes total): the OLD rule here was a
 * plain UNION, deduping only byte-identical repeats —
 *   const alreadyExecuted = new Set(turn1Actions.map((a) => JSON.stringify(a)));
 *   const newFromTurn2 = turn2Actions.filter((a) => !alreadyExecuted.has(JSON.stringify(a)));
 *   return [...turn1Actions, ...newFromTurn2];
 * — so when turn 1 got the plan wrong and the grounded turn corrected it,
 * BOTH turns' distinct mutating actions ran, because every field differed
 * (different task/title text) even though turn 2 was meant to REPLACE turn
 * 1's decision, not add to it.
 *
 * NEW rule — "last mutating pass wins":
 *   - Grounding actions (isMutantManagerAction === false — see
 *     groundingDedupKey) and pure display markers (DISPLAY_ONLY_ACTION_TYPES)
 *     are ALWAYS kept from every pass, byte-identical repeats deduped exactly
 *     as before — they only build context or narrate, so keeping every
 *     pass's copy is harmless (and matches their existing per-turn dedup,
 *     resolveGroundingActions' seenKeys).
 *   - If turn-2 (the grounded pass) emits at least one MUTATING action
 *     (create_draft, chain_agents, launch_mission, clear_canvas, ...), THOSE
 *     mutating actions are the ones that execute — turn-1's mutating actions
 *     are abandoned (never executed), because the grounded pass had the real
 *     context turn-1 didn't and represents the model's corrected decision.
 *   - If turn-2 emits NO mutating action at all (it only grounds/reports —
 *     e.g. turn-1 already decided to create_draft, turn-2 just answers a
 *     query_mission with prose), turn-1's mutating actions are kept: turn-1
 *     was the only pass that actually decided anything this turn.
 * Relative order within the winning turn's own mutating actions is
 * preserved, which is what lets a turn-2-only alias (a draft created earlier
 * in turn-2's OWN action list) resolve correctly when a later turn-2 action
 * references it — see sendManagerMessage's single aliasMap, threaded through
 * this combined list in order.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function mergeManagerActions(
  turn1Actions: readonly ManagerAction[],
  turn2Actions: readonly ManagerAction[],
): MergeManagerActionsResult {
  const turn1Mutants = turn1Actions.filter(isMutantManagerAction);
  const turn1Rest = turn1Actions.filter((a) => !isMutantManagerAction(a));
  const turn2Mutants = turn2Actions.filter(isMutantManagerAction);
  const turn2Rest = turn2Actions.filter((a) => !isMutantManagerAction(a));

  const turn2Supersedes = turn2Mutants.length > 0;
  const winningMutants = turn2Supersedes ? turn2Mutants : turn1Mutants;
  const supersededMutantCount = turn2Supersedes ? turn1Mutants.length : 0;

  // Double-emission fix (real user test, 2026-07-28: two indistinguishable
  // "Lancer le brouillon" approval entries observed in the same pending-
  // approval queue) — a single pass's OWN mutant list was never deduped:
  // only cross-pass byte-identical repeats (dedupedRest below) were. If the
  // model's own response for ONE pass repeats the exact same mutating action
  // twice (same type, same fields — e.g. the same launch_draft draftId
  // listed twice), both copies used to reach the execution loop and, for a
  // gate-deferred ('ask') action, both queued their own PendingApprovalAction
  // — see describePendingAction's own doc comment for the label-side half of
  // this fix (distinguishable entries even when a legitimate double request
  // occurs). This collapses only EXACT (byte-identical) repeats within the
  // winning pass — never two actions that merely target the same entity with
  // different fields, which stay distinct on purpose.
  const mutantsSeen = new Set<string>();
  const finalMutants: ManagerAction[] = [];
  for (const a of winningMutants) {
    const key = JSON.stringify(a);
    if (mutantsSeen.has(key)) continue;
    mutantsSeen.add(key);
    finalMutants.push(a);
  }

  // Grounding + display-only actions from BOTH passes are always kept —
  // dedup byte-identical repeats exactly like the old union did.
  const restSeen = new Set<string>();
  const dedupedRest: ManagerAction[] = [];
  for (const a of [...turn1Rest, ...turn2Rest]) {
    const key = JSON.stringify(a);
    if (restSeen.has(key)) continue;
    restSeen.add(key);
    dedupedRest.push(a);
  }

  return {
    actions: [...dedupedRest, ...finalMutants],
    supersededMutantCount,
  };
}

/** Build a dedup key for a grounding action — identical keys across turns
 *  mean the same query is being re-emitted; the loop skips re-resolving it
 *  and the observation message tells the model it already has those results. */
function groundingDedupKey(a: ManagerAction): string | undefined {
  switch (a.type) {
    case 'brain_query': return `brain_query:${a.query}`;
    case 'brain_query_css': return `brain_query_css:${a.selector}`;
    case 'brain_neighbours': return `brain_neighbours:${a.id}`;
    case 'query_mission': return `query_mission:${a.missionId}`;
    case 'get_agent_output': return `get_agent_output:${a.missionId}`;
    case 'web_search': return `web_search:${a.query}`;
    case 'web_fetch': return `web_fetch:${a.url}`;
    case 'briefing_query': return `briefing_query:${a.projectId ?? ''}:${a.sinceMs ?? ''}`;
    case 'decision_lookup': return `decision_lookup:${a.question}`;
    case 'scan_project': return `scan_project:${a.projectId ?? ''}:${a.depth ?? 'quick'}`;
    case 'list_lazybots': return 'list_lazybots';
    default: return undefined;
  }
}

/** Action types that are pure display/no-op markers in executeManagerAction's
 *  switch (see its `case 'list_agents': case 'list_missions': case
 *  'canvas_overview': case 'info':` group — "these are informational — the
 *  manager already responded in text") — distinct from grounding actions
 *  (which fetch real context, see groundingDedupKey above) but, like them,
 *  harmless to keep from EVERY pass since re-"executing" one is a no-op.
 *  Used by isMutantManagerAction below to draw mergeManagerActions' exact
 *  boundary. */
const DISPLAY_ONLY_ACTION_TYPES = new Set<ManagerAction['type']>([
  'info', 'list_agents', 'list_missions', 'canvas_overview',
]);

/**
 * True for any action that performs a real, non-idempotent side effect when
 * dispatched through executeManagerAction (create_draft, chain_agents,
 * launch_mission, clear_canvas, ...) — i.e. everything EXCEPT a grounding
 * action (groundingDedupKey(a) !== undefined — brain_query/query_mission/
 * web_search/... which only fetch context via resolveGroundingActions, and
 * are no-op cases in the executor switch) and a pure display marker
 * (DISPLAY_ONLY_ACTION_TYPES — also no-ops there).
 *
 * This is the exact boundary mergeManagerActions' "last mutating pass wins"
 * rule needs (see its own doc comment, 2026-07-28 bug fix): grounding/
 * display actions are safe to keep from every pass (they never double-apply
 * anything), but a REAL mutation (a draft created, a chain wired, a mission
 * launched...) must only ever come from the LAST pass that proposed one.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isMutantManagerAction(a: ManagerAction): boolean {
  return groundingDedupKey(a) === undefined && !DISPLAY_ONLY_ACTION_TYPES.has(a.type);
}

/**
 * Resolves `scan_project` into a compact structural digest (projectDigest.ts)
 * — the manager's only way to MEASURE a project (stack, scripts, test/
 * surface counts, code-volume magnitude, git activity) before deciding how
 * many agents a request needs, instead of guessing from the request text
 * alone (see qa-manager-2026-07-25/UC-SCORECARD.md's use cases D/E, the gap
 * this action exists to close).
 *
 * `projectId` absent -> the currently active project (resolveProjectRoot,
 * same resolver `addMission`/`approveMission` use). `projectId` set -> that
 * SPECIFIC known project (resolveProjectRootById, the same real-directory
 * lookup `create_draft`'s `projectId` field already resolves through) — an
 * unresolvable id degrades to an honest "not found" line rather than
 * silently falling back to the wrong project's data.
 *
 * Never throws: buildProjectDigest itself never rejects (every sub-probe —
 * fs walk, git, codegraph — degrades on its own), and an unresolvable
 * projectId is handled here explicitly.
 */
async function runScanProject(
  projectId: string | undefined,
  depth: 'quick' | 'deep' | undefined,
): Promise<string> {
  let root: string | undefined;
  if (projectId) {
    root = await resolveProjectRootById(projectId);
    if (!root) {
      return `scan_project("${projectId}"): not a currently open project — nothing to scan. See the canvas digest above for known project ids.`;
    }
  } else {
    root = await resolveProjectRoot();
  }
  const digest = await buildProjectDigest(root, getPlatform(), { depth: depth ?? 'quick' });
  return `scan_project(${projectId ?? 'active project'}, depth=${depth ?? 'quick'}):\n${digest.text}`;
}

/**
 * BUG #22 fix (2026-08-05, founder dogfood — M35): defensive wrapper around
 * managerEngine.ts's formatMissionDetail, the ONE call site in this file's
 * grounding path (below) that hands it a live Mission — that function reads
 * `mission.judgeVerdict.reviewers` UNCONDITIONALLY (no optional chaining) to
 * build the manager's own query_mission/get_agent_output context. A verdict
 * stamped mid-evaluation (auto-merge racing judge state settling — the exact
 * M35 shape: an auto-merge attempt landed a PARTIAL judgeVerdict, `passed`/
 * `risk` populated but `reviewers` never finished writing) can violate
 * JudgeVerdict's own "required" type at runtime — real persisted/in-flight
 * data does not always match the compile-time type. That produced a raw,
 * un-actionable "Cannot read properties of undefined (reading 'slice')"
 * surfacing straight into the manager's own diagnosis (this grounding call
 * has no try/catch of its own, and runGroundedFollowUp — its only caller —
 * does not guard it either) instead of an honest mission detail.
 *
 * Never mutates `mission` itself (this codebase's immutable-update
 * convention) — normalizes a SHALLOW COPY's `judgeVerdict.reviewers` to `[]`
 * before calling the real formatter, and keeps a last-resort try/catch
 * fallback (same 'évaluation indisponible' sentinel approveGate.ts's
 * isEvaluationSettledUnavailable already uses for the identical "evaluation
 * technically absent" concept) for any other malformed shape
 * formatMissionDetail does not yet defend against.
 *
 * Exported for direct unit testing (same convention as
 * describePendingAction above) — the crash this guards against is only
 * reachable in production through a real manager grounding turn, too heavy
 * a path to exercise the malformed-verdict shape precisely in a unit test.
 */
export function formatMissionDetailSafe(mission: Mission, opts?: Parameters<typeof formatMissionDetail>[1]): string {
  const safeMission: Mission = mission.judgeVerdict && !Array.isArray(mission.judgeVerdict.reviewers)
    ? { ...mission, judgeVerdict: { ...mission.judgeVerdict, reviewers: [] } }
    : mission;
  try {
    return formatMissionDetail(safeMission, opts);
  } catch {
    return `Mission ${mission.id}: "${mission.title}" — évaluation indisponible.`;
  }
}

/** Resolve grounding actions into context fields, skipping any whose dedup
 *  key is already in `seenKeys`. Mutates `seenKeys` to include the newly
 *  resolved keys. Returns the updated context and the observation parts. */
async function resolveGroundingActions(
  grounding: GroundingActions,
  context: ManagerContext,
  agents: StoredAgent[],
  missions: Mission[],
  seenKeys: Set<string>,
): Promise<{ ctx: ManagerContext; observations: string[] }> {
  const {
    missionQueryAction, brainQueryAction, cssAction, neighboursAction,
    webSearchAction, webFetchAction, briefingQueryAction, decisionLookupAction,
    scanProjectAction, listLazybotsAction,
  } = grounding;
  let ctx = context;
  const observations: string[] = [];

  if (missionQueryAction) {
    const key = groundingDedupKey(missionQueryAction);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      const target = resolveMissionQueryTarget(missionQueryAction.missionId, missions, agents);
      const missionDetail = target
        ? formatMissionDetailSafe(
            target,
            missionQueryAction.type === 'get_agent_output' ? { maxTimelineEntries: missionQueryAction.lines } : undefined,
          )
        : formatMissionNotFound(missionQueryAction.missionId);
      ctx = { ...ctx, missionDetail };
      observations.push(missionDetail);
    }
  }

  if (brainQueryAction) {
    const key = groundingDedupKey(brainQueryAction);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      const brainQueryResult = await recallForDirective(
        brainQueryAction.query,
        brainQueryAction.sessionId ?? context.conversationId,
      );
      ctx = { ...ctx, brainQueryResult };
      observations.push(brainQueryResult);
    }
  }

  if (cssAction || neighboursAction) {
    const parts: string[] = [];
    if (cssAction) {
      const key = groundingDedupKey(cssAction);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        const out = await runBrainQueryCss(cssAction.selector, cssAction.limit);
        parts.push(`brain_query_css("${cssAction.selector}"):\n${out}`);
      }
    }
    if (neighboursAction) {
      const key = groundingDedupKey(neighboursAction);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        const out = await runBrainNeighbours(neighboursAction.id);
        parts.push(`brain_neighbours("${neighboursAction.id}"):\n${out}`);
      }
    }
    if (parts.length > 0) {
      const structural = parts.join('\n\n');
      ctx = { ...ctx, structuralQueryResult: structural };
      observations.push(structural);
    }
  }

  if (webSearchAction || webFetchAction) {
    const { executeTool } = await import('../../lib/tools/toolRuntime');
    const rootPath = (await resolveProjectRoot()) || '.';
    const parts: string[] = [];
    if (webSearchAction) {
      const key = groundingDedupKey(webSearchAction);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        const out = await executeTool('web_search', { query: webSearchAction.query, max_results: webSearchAction.maxResults }, { rootPath, policy: {}, agentMode: 'default' });
        parts.push(`web_search("${webSearchAction.query}"):\n${out}`);
      }
    }
    if (webFetchAction) {
      const key = groundingDedupKey(webFetchAction);
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        const out = await executeTool('web_fetch', { url: webFetchAction.url, max_chars: webFetchAction.maxChars }, { rootPath, policy: {}, agentMode: 'default' });
        parts.push(`web_fetch("${webFetchAction.url}"):\n${out}`);
      }
    }
    if (parts.length > 0) {
      const webResult = parts.join('\n\n');
      ctx = { ...ctx, webQueryResult: webResult };
      observations.push(webResult);
    }
  }

  if (briefingQueryAction) {
    const key = groundingDedupKey(briefingQueryAction);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      try {
        const { buildBriefingDigest, resolveSinceAnchor, resolveScope } = await import('../../lib/agents/briefing');
        const { journalQuery } = await import('../../lib/journal/journal');
        const scope = resolveScope(briefingQueryAction.projectId);
        const sinceMs = briefingQueryAction.sinceMs ?? resolveSinceAnchor(scope);
        const events = await journalQuery({ sinceMs, projectId: briefingQueryAction.projectId });
        const digest = buildBriefingDigest(events);
        const lines: string[] = [
          `Window: ${digest.eventCount} events, ${new Date(digest.sinceMs).toISOString()} to ${new Date(digest.untilMs).toISOString()}.`,
        ];
        if (digest.shipped.length > 0) {
          lines.push(`Shipped (${digest.shipped.length}): ${digest.shipped.map((s) => `${s.missionId} (${s.kind})`).join('; ')}`);
        }
        if (digest.asks.length > 0) {
          lines.push(`Needs attention (${digest.asks.length}): ${digest.asks.map((a) => `${a.missionId ?? a.projectId} — ${a.reason}`).join('; ')}`);
        }
        const { capturedCount, decisionCount, promotedCount } = digest.learned;
        if (capturedCount + decisionCount + promotedCount > 0) {
          lines.push(`Learned: ${capturedCount} captured, ${decisionCount} decisions, ${promotedCount} promoted.`);
        }
        if (digest.spent.totalUsd > 0) {
          lines.push(`Spent: $${digest.spent.totalUsd.toFixed(2)} total.`);
        }
        if (digest.nightShift.count > 0) {
          lines.push(`Night shift: ${digest.nightShift.count} loop iterations.`);
        }
        const briefingResult = lines.join('\n');
        ctx = { ...ctx, briefingDigestResult: briefingResult };
        observations.push(briefingResult);
      } catch {
        const fallback = '(briefing unavailable: journal query failed)';
        ctx = { ...ctx, briefingDigestResult: fallback };
        observations.push(fallback);
      }
    }
  }

  if (decisionLookupAction) {
    const key = groundingDedupKey(decisionLookupAction);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      try {
        const { lookupDecision } = await import('../../lib/brain/decisions');
        const result = await lookupDecision(decisionLookupAction.question);
        const text = result.found
          ? `Decision found (#${result.decisionId}):\nQ: ${decisionLookupAction.question}\nA: ${result.answer}${result.rationale ? `\nRationale: ${result.rationale}` : ''}`
          : `No matching decision found for: "${decisionLookupAction.question}"`;
        ctx = { ...ctx, decisionLookupResult: text };
        observations.push(text);
      } catch {
        const fallback = '(decision lookup unavailable: brain search failed)';
        ctx = { ...ctx, decisionLookupResult: fallback };
        observations.push(fallback);
      }
    }
  }

  if (scanProjectAction) {
    const key = groundingDedupKey(scanProjectAction);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      // NOTE for the ManagerContext/prompt-building owner (managerEngine.ts):
      // this result is pushed to `observations` only — it reaches the model
      // via the next turn's "[SYSTEM OBSERVATION]" message (see
      // runGroundedFollowUp below), exactly like every other grounding
      // result's IMMEDIATE next-turn visibility. Unlike brain_query/
      // web_search/etc. above, it is NOT also stored on `ctx` (no
      // `projectScanResult` field exists on ManagerContext — that type and
      // its system-prompt block live in managerEngine.ts, out of this
      // change's scope) so it will NOT persist in the system prompt across a
      // 3rd+ grounding turn, only the one right after it. Adding a
      // `projectScanResult?: string` field to ManagerContext plus a prompt
      // block mirroring `brainQueryBlock` would close that gap.
      //
      // PROMISE-STALL fix (2026-08-05): this was the one grounding fetch in
      // this function with no try/catch, unlike briefingQueryAction/
      // decisionLookupAction right below — a real failure here used to
      // REJECT resolveGroundingActions' whole promise, propagating past
      // runGroundedFollowUp's own try/catch (which only wraps the
      // runManagerTurn call, not this resolve step) and aborting the WHOLE
      // exchange instead of degrading honestly like every sibling action.
      try {
        const scanResult = await runScanProject(scanProjectAction.projectId, scanProjectAction.depth);
        observations.push(scanResult);
      } catch {
        const fallback = '(scan_project unavailable: project scan failed)';
        observations.push(fallback);
      }
    }
  }

  if (listLazybotsAction) {
    const key = groundingDedupKey(listLazybotsAction);
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      // Observations-only (same contract as scan_project above): the REAL
      // roster reaches the model via the next turn's "[SYSTEM OBSERVATION]"
      // message so it can answer "list my bots" grounded in the same
      // exchange. try/catch for the same PROMISE-STALL reason as
      // scan_project — a botStorage failure degrades honestly instead of
      // aborting the whole exchange.
      try {
        const bots = await listBots();
        const lines = bots.length > 0
          ? bots.map((b) => {
              const botState = getBotRuntimeState(b.id);
              const status = b.enabled ? (botState.activeRuns.length > 0 ? 'running' : 'idle') : 'disabled';
              return `${b.id} ("${b.name}", ${b.autonomy}, enabled=${b.enabled}, activeRuns=${botState.activeRuns.length}, status=${status})`;
            }).join('\n')
          : '(no LazyBots saved yet)';
        observations.push(`list_lazybots:\n${lines}`);
      } catch {
        const fallback = '(list_lazybots unavailable: bot storage read failed)';
        observations.push(fallback);
      }
    }
  }

  return { ctx, observations };
}

/**
 * Multi-turn grounding loop: replaces the old 2-call (main + follow-up)
 * pattern with a true ReAct-style loop bounded by MAX_MANAGER_TURNS.
 *
 * Turn 1 (the main turn) is already completed — its result is passed in as
 * `firstTurn`. The loop then:
 *   1. Checks firstTurn.actions for grounding actions (brain_query, etc.)
 *   2. Resolves them (with dedup — identical queries across turns are
 *      skipped) into context fields + observation text
 *   3. Builds an observation message and calls runManagerTurn again
 *   4. Repeats until no grounding actions are emitted OR MAX_MANAGER_TURNS
 *
 * Bounded by construction: the loop never re-resolves a grounding query
 * whose dedup key was already seen (prevents infinite brain_query loops),
 * AND the hard MAX_MANAGER_TURNS cap (4) prevents unbounded credit burn.
 * Also bounded in TIME: each call gets its own MANAGER_LLM_CALL_TIMEOUT_MS
 * budget via createManagerCallController, and the parent signal (Stop /
 * global backstop) can abort at any point.
 *
 * SECURITY TRADEOFF (Phase 1, documented): mutative actions (launch_mission,
 * create_draft, etc.) emitted by the model during the loop are collected
 * but NOT executed until the loop terminates. This means the manager will
 * NOT see the success/failure of a mutative action within the same loop —
 * it cannot react to a launch_mission failure by retrying with different
 * parameters in the same exchange. This is an acceptable security tradeoff:
 *   - Bounded loops: the manager cannot burn unbounded credits by launching
 *     missions, observing their failure, and retrying in a tight loop.
 *   - Next-turn visibility: the mission's outcome is visible on the canvas
 *     and in the next exchange's context (canvasDigest, missions list).
 *   - Implementer warning: do NOT "fix" this by executing mutative actions
 *     inline and feeding their results back into the loop — that creates an
 *     unbounded mutative loop (credit burn risk). The current design is
 *     intentional.
 */
async function runGroundedFollowUp(opts: GroundedFollowUpOptions): Promise<GroundedFollowUpResult> {
  const { firstTurn, messages, context, agents, missions, model, signal, onPartial } = opts;

  const grounding = findGroundingActions(firstTurn.actions);
  if (!hasAnyGroundingAction(grounding)) {
    return { responseText: turnDisplayText(firstTurn) };
  }

  const parentSignal = signal ?? new AbortController().signal;
  const seenKeys = new Set<string>();
  let currentContext = context;
  let currentMessages = messages;
  let currentTurn = firstTurn;
  let allActions: ManagerAction[] = [...firstTurn.actions];
  let turnCount = 1; // turn 1 = the main turn already completed
  // 2026-07-28 fix — running total of mutating actions from an EARLIER pass
  // abandoned because a LATER pass superseded them (mergeManagerActions'
  // "last mutating pass wins" rule) — exposed on the result, never shown to
  // the user directly.
  let totalSupersededMutantCount = 0;
  // PROMISE-STALL fix (2026-08-05, see managerEngine.ts's PROMISE-STALL
  // section + ManagerContext.groundingFailureNote's doc comment): at most
  // ONE post-failure retry for the whole exchange — never a second one, same
  // anti-loop posture as runManagerTurn's own announcement nudge — so a
  // rail that keeps failing still converges to an honest failure return
  // instead of burning the exchange's time budget on repeated retries.
  let groundingRetryUsed = false;

  while (turnCount < MAX_MANAGER_TURNS) {
    const currentGrounding = findGroundingActions(currentTurn.actions);
    if (!hasAnyGroundingAction(currentGrounding)) {
      break;
    }

    // A9 — re-gather missions every grounding pass (and before the LLM
    // re-prompt). The context snapshot from sendManagerMessage can go stale
    // mid-turn when this same exchange launches a mission / bot; without a
    // refresh, buildManagerDynamicContext still lists the frozen fleet.
    const liveMissions = typeof missions === 'function' ? missions() : missions;
    currentContext = { ...currentContext, missions: liveMissions };
    const { ctx, observations } = await resolveGroundingActions(
      currentGrounding, currentContext, agents, liveMissions, seenKeys,
    );

    if (observations.length === 0) {
      // All grounding actions were dedup hits — nothing new to observe.
      // Tell the model it already has all results and must answer now.
      break;
    }

    // Keep the live mission list even if resolveGroundingActions only
    // patched grounded result fields onto the prior context object.
    currentContext = { ...ctx, missions: liveMissions };

    const observationText = observations.filter((s) => s.trim().length > 0).join('\n\n');
    // 2026-07-28 fix (requirement #3): tell the model, BEFORE it answers
    // again, that any mutating action it just proposed has NOT run yet —
    // mergeManagerActions only executes the LAST pass's mutating actions,
    // so without this the model could wrongly believe e.g. the drafts it
    // just proposed already exist and not re-emit them, silently losing
    // legitimate work.
    const currentTurnMutants = currentTurn.actions.filter(isMutantManagerAction);
    const pendingMutantsNote = currentTurnMutants.length > 0
      ? ` None of the action(s) you just proposed (${currentTurnMutants.map((a) => a.type).join(', ')}) have run yet — they are held pending this observation, not already executed. If they are still correct given the results above, RE-EMIT them in your next reply exactly as before (only your LAST reply's mutating actions will actually run). If the results change your plan, emit the corrected action(s) instead — the ones above will be discarded, never executed.`
      : '';
    const turnMessages: ManagerMessage[] = [
      ...currentMessages,
      {
        id: createMessageId(),
        role: 'assistant',
        content: currentTurn.responseText,
        timestamp: new Date().toISOString(),
      },
      {
        id: createMessageId(),
        role: 'user',
        content: `[SYSTEM OBSERVATION — not the human] Real results for the action(s) you just emitted:\n\n${observationText}\n\nAnswer the user's previous question NOW, grounded strictly in these results (cite #ids when present).${pendingMutantsNote} If the results are empty or unavailable, say so honestly. Do NOT repeat a brain_query/query_mission/web_search/briefing_query/decision_lookup/list_lazybots you already received results for — use the data above.`,
        timestamp: new Date().toISOString(),
      },
    ];

    const callCtrl = createManagerCallController(parentSignal, MANAGER_LLM_CALL_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const nextTurn = await rejectOnAbort(
        runManagerTurn({
          messages: turnMessages,
          context: currentContext,
          model,
          signal: callCtrl.signal,
          // C3 fix: rearms callCtrl's inactivity deadline on every fragment —
          // see ManagerTurnOptions.onChunk's doc comment (managerEngine.ts).
          onChunk: callCtrl.reportActivity,
          onPartial,
        }),
        callCtrl.signal,
        `grounding turn ${turnCount + 1}`,
      );
      turnCount += 1;
      currentMessages = turnMessages;
      currentTurn = nextTurn;
      // Merge new actions — "last mutating pass wins" (see
      // mergeManagerActions' doc comment); grounding/display actions are
      // always kept, byte-identical repeats deduped as before.
      const merged = mergeManagerActions(allActions, nextTurn.actions);
      allActions = merged.actions;
      if (merged.supersededMutantCount > 0) {
        totalSupersededMutantCount += merged.supersededMutantCount;
        console.debug(
          `[runGroundedFollowUp] grounding turn ${turnCount} superseded ${merged.supersededMutantCount} ` +
          'mutating action(s) from an earlier pass (this pass emitted its own).',
        );
      }
    } catch (err) {
      console.warn(`[runGroundedFollowUp] grounding turn ${turnCount + 1} failed:`, err);

      // PROMISE-STALL fix (2026-08-05): this used to return IMMEDIATELY here
      // with turnDisplayText(currentTurn) — the text of the LAST turn that
      // actually completed, which on the first grounding round is just the
      // main turn's announcement-only prose (real prod repro: the manager
      // says "Je supprime M16..." then the exchange silently ends with
      // nothing ever deleted, because THIS call — the one that was supposed
      // to decide and act on the real grounding results — is exactly the
      // one that failed/timed out). Now: ONE retry is spent with the failure
      // injected HONESTLY into context via groundingFailureNote
      // (buildManagerDynamicContext renders it as its own labeled,
      // un-ignorable block instructing the model to decide and act despite
      // the failure) instead of silently giving up on the first try. Never a
      // second retry (groundingRetryUsed) — if this retry ALSO fails, fall
      // through to the exact same honest-failure return this replaces.
      if (!groundingRetryUsed) {
        groundingRetryUsed = true;
        const retryCtrl = createManagerCallController(parentSignal, MANAGER_LLM_CALL_TIMEOUT_MS);
        const retryStartedAt = Date.now();
        try {
          const retryTurn = await rejectOnAbort(
            runManagerTurn({
              messages: turnMessages,
              context: { ...currentContext, groundingFailureNote: describeGroundedFailure(err) },
              model,
              signal: retryCtrl.signal,
              onChunk: retryCtrl.reportActivity,
              onPartial,
            }),
            retryCtrl.signal,
            `grounding turn ${turnCount + 1} (post-failure retry)`,
          );
          turnCount += 1;
          currentMessages = turnMessages;
          currentTurn = retryTurn;
          const merged = mergeManagerActions(allActions, retryTurn.actions);
          allActions = merged.actions;
          if (merged.supersededMutantCount > 0) {
            totalSupersededMutantCount += merged.supersededMutantCount;
          }
          // Retry succeeded — rejoin the normal loop instead of returning a
          // failure: the `while` condition re-checks currentTurn's own
          // actions next, exactly like any other successful grounding round.
          continue;
        } catch (retryErr) {
          console.warn(
            `[runGroundedFollowUp] grounding turn ${turnCount + 1} post-failure retry ALSO failed — giving up honestly:`,
            retryErr,
          );
          return {
            responseText: turnDisplayText(currentTurn),
            failureReason: describeGroundedFailure(retryErr),
            failureIsTimeout: isAbortLikeFailure(retryErr),
            failureTimeoutReason: retryCtrl.getTimeoutReason(),
            failureElapsedMs: Date.now() - retryStartedAt,
            actions: allActions,
            supersededMutantActionCount: totalSupersededMutantCount || undefined,
          };
        } finally {
          retryCtrl.dispose();
        }
      }

      return {
        responseText: turnDisplayText(currentTurn),
        failureReason: describeGroundedFailure(err),
        failureIsTimeout: isAbortLikeFailure(err),
        failureTimeoutReason: callCtrl.getTimeoutReason(),
        failureElapsedMs: Date.now() - startedAt,
        actions: allActions,
        supersededMutantActionCount: totalSupersededMutantCount || undefined,
      };
    } finally {
      callCtrl.dispose();
    }
  }

  return {
    responseText: turnDisplayText(currentTurn),
    actions: allActions,
    supersededMutantActionCount: totalSupersededMutantCount || undefined,
  };
}

/**
 * Fetch the brain's startup snapshot (highlights mode) for the manager's
 * FIRST turn only — mirrors the main assistant chat's one-time
 * startup-context injection (assistantStore.tsx's startupContextRef /
 * systemPrompts.ts's opts.startupContext), adapted to the manager's
 * per-call context building (no persistent ref needed: the caller gates
 * this on state.managerMessages being empty, which is naturally true again
 * after clearManagerMessages()).
 *
 * Bounded by a 5s race and never throws — a slow/unavailable brain must
 * never block sending a manager message. Returns undefined (not '') on
 * empty/failure so buildManagerSystemPrompt's `startupContext ? ... : ''`
 * guard skips the block cleanly.
 */
async function fetchManagerStartupContext(): Promise<string | undefined> {
  try {
    const root = await resolveProjectRoot();
    const cached = getStartupContextCache(root);
    if (cached.hit) return cached.value;
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(''), 5000));
    const ctx = await Promise.race([getPlatform().brain.startupContext(root), timeout]);
    const value = ctx.trim() || undefined;
    setStartupContextCache(root, value);
    return value;
  } catch {
    return undefined;
  }
}

/** Best-effort first-turn snapshot warm — call from prewarm.ts so the first
 *  user message never waits on brain.startupContext (self-bounded 5s). */
export async function prewarmManagerStartupContext(): Promise<void> {
  await fetchManagerStartupContext().catch(() => undefined);
}

/**
 * Fetch the manager's per-turn Brain status snapshot — the fast,
 * filesystem-only get_brain_info() primitive (noteCount/isEmpty), the SAME
 * one assistantStore.tsx's fetchBrainIsEmpty already uses for the main
 * chat's "empty brain" banner. Feeds formatBrainStatus (managerEngine.ts),
 * which distinguishes the three real states a silent-degradation QA finding
 * proved the manager could not tell apart: unavailable, NOT indexed for
 * this project (0 notes), or indexed with a real note count — see the
 * "NEVER DEGRADE IN SILENCE" rule this grounds. Returns undefined on the web
 * platform, when the `info()` extension is unavailable, or on any
 * error/timeout — callers must treat that as "unknown" (unavailable), never
 * as "empty".
 */
async function fetchManagerBrainInfo(): Promise<BrainInfo | undefined> {
  const platform = getPlatform();
  if (platform.name !== 'tauri') return undefined;
  try {
    return await (platform.brain as Brain & { info(): Promise<BrainInfo> }).info();
  } catch {
    return undefined;
  }
}

/**
 * GRAPH/RECALL DIVERGENCE FIX: probe whether the LIVE brain sidecar is
 * actually reachable right now, independent of fetchManagerBrainInfo's
 * `info()` above — `info()` (get_brain_info, Rust) is an intentionally
 * fast, filesystem-only note count at the LOCALLY recomputed
 * `resolve_unified_brain_path` for "the current project" (see its own doc
 * comment in src-tauri's path_resolve.rs), which can legitimately diverge
 * from whatever brain the sidecar is ACTUALLY serving (its own boot-time
 * default, or a multi-tenant brainId — see sidecar/routing.rs's
 * `active_brain_query_suffix`, the mechanism BrainSpace's graph fetch
 * trusts unconditionally). A real-user report proved this concretely: the
 * Brain space showed a live, 5254-neuron graph for the active project while
 * `info()` read 0 notes at its own locally-recomputed path for that same
 * project — the manager then told the user "no brain accessible" and
 * wrongly suggested indexing an already-indexed project.
 *
 * `platform.brain.search(...)` (invoke('brain_fetch_search')) is the SAME
 * unconditional live-sidecar proxy family as brain_fetch_graph — no local
 * path-existence gate at all (see src-tauri/src/commands/brain/sidecar/
 * fetch.rs) — and is already the exact probe `nativeHealth()`'s own
 * `brain` status uses (src/lib/platform/tauri.ts). A tiny top:1 query
 * against the already-warm sidecar, so this stays cheap enough for a
 * per-turn call (bounded by boundedContext at the call site regardless).
 * Returns `false` on any failure (unreachable sidecar, web platform, IPC
 * error) — never throws, matching fetchManagerBrainInfo's contract.
 */
async function fetchManagerBrainSidecarReachable(): Promise<boolean> {
  const cached = getSidecarReachableCache();
  if (cached.hit) return cached.value;
  const platform = getPlatform();
  if (platform.name !== 'tauri') return false;
  try {
    await platform.brain.search('__manager_brain_reachability_probe__', 1);
    setSidecarReachableCache(true);
    return true;
  } catch {
    setSidecarReachableCache(false);
    return false;
  }
}

/**
 * Hard ceiling for the OPTIONAL context fetches gathered at the top of
 * sendManagerMessage, BEFORE the manager's own AbortController/timeout is
 * even armed. Short on purpose: this is prompt garnish (agent catalog,
 * canvas digest), never worth stalling a user-visible turn for.
 */
const MANAGER_CONTEXT_FETCH_TIMEOUT_MS = 2_000;

/**
 * Bound an OPTIONAL pre-turn context fetch: resolve with `fallback` instead
 * of rejecting OR hanging. REGRESSION GUARD (canvas W4): buildCanvasDigest()
 * was added to sendManagerMessage's opening Promise.all with no timeout of
 * its own — unlike its sibling fetchManagerStartupContext (self-bounded 5s
 * race above). Its internal try/catch only covers an invoke() REJECTION; a
 * stalled Tauri IPC round-trip that never settles (the same failure class
 * commit 50ae785 "no-op chain engine init outside Tauri" fixed for
 * chainEngine) propagated straight through Promise.all and froze the whole
 * exchange BEFORE runManagerTurn — the manager announced "je vais lire dans
 * le brain" from a previous turn's text and then nothing ever executed,
 * because the turn never even reached the model. Every optional fetch in
 * that Promise.all now goes through this wrapper: no optional context can
 * ever kill or hang a manager turn again.
 */
async function boundedContext<T>(
  promise: Promise<T>,
  fallback: T,
  label: string,
  ms: number = MANAGER_CONTEXT_FETCH_TIMEOUT_MS,
): Promise<T> {
  try {
    return await withTimeout(promise, ms, label);
  } catch {
    return fallback;
  }
}

// ── Worktree path resolution (discardMission) ─────────────────────

/**
 * Reconstructs a mission's worktree directory path from repoPath + its
 * branch name, for discardMission (the "Rejeter" cockpit action). Mirrors
 * evaluator.ts's resolveWorktreePath: same separator throughout, via the
 * shared joinPath() helper (src/lib/paths.ts) instead of a hardcoded '/'.
 *
 * Mission carries no separate absolute worktree-path field today (only the
 * branch name in `worktree` — see runtime.ts's runMission, which persists
 * `worktree: branch`), so "use whatever the mission already has" reduces to
 * using that branch — discardMission already gates on it being non-empty
 * before calling this.
 *
 * CRITICAL (4th instance of the \\?\ verbatim-path bug class — see
 * src/lib/paths.ts's header comment for the first three): repoPath is
 * typically get_project_root's canonicalized result, which on Windows is
 * \\?\-prefixed (verbatim). The previous implementation joined with a
 * hardcoded '/' (`${repoPath}/.lazy/worktrees/${safeBranch}`), producing a
 * mixed-separator string Rust's Path::canonicalize() cannot resolve even
 * though the directory exists on disk — silently breaking "Rejeter" for a
 * mission on Windows. Exported for unit testing.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveDiscardWorktreePath(repoPath: string, branch: string): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9\-_]/g, '-');
  return joinPath(repoPath, '.lazy', 'worktrees', safeBranch);
}

// ── Worktree cleanup (stopMission / stopAll) ────────────────────────

/**
 * Best-effort worktree cleanup for a stopped/cancelled mission. Reuses the
 * exact resolveDiscardWorktreePath + discardWorktree pair discardMission
 * uses below, so Stop/Cancel no longer silently leaves an orphaned worktree
 * directory + branch behind — unlike discardMission, stopMission previously
 * did nothing but flip the in-memory stopFlag and hope runMission
 * (runtime.ts) would notice and clean up on its own before reaching a
 * terminal state, which has at least one real gap (the retry-continuation
 * branch inside runMission's Step B never re-checks stopSignal after a
 * retry's planAndAct call, so a stop fired mid-retry fell straight through
 * to Step C/D and reached 'review' — worktree intact — as if never stopped).
 *
 * Guarded by the caller on `mission.worktree` being set — the same signal
 * discardMission itself gates on (see its doc comment: Mission carries no
 * separate absolute worktree-path field, only the branch name).
 *
 * Swallows ALL failures unconditionally — unlike approveMission/
 * discardMission's isTauri()-gated honesty fix above, Stop already applies
 * an immediate, optimistic status:'cancelled' with no pending Promise for a
 * caller to await/catch, and runMission's own loop may independently reach
 * its own stopSignal-triggered cleanup and get there first — so a "not
 * found" failure here is an expected, harmless overlap, not a real error to
 * surface.
 *
 * Real-app QA traced a leaked worktree on Stop/Cancel to a Windows file-lock
 * race, not to this function itself: discardWorktree (agent_discard_worktree,
 * Rust) used to attempt a single `git worktree remove` while the just-killed
 * CLI child (or a lingering grandchild it spawned) could still hold the
 * worktree directory as its current working directory — Windows refuses to
 * remove a directory out from under a live process. git.rs's
 * worktree_cleanup module now retries through that window on the Rust side;
 * the caller below (stopMission/stopAll) additionally issues the process
 * kill BEFORE calling this function instead of leaving the two to race, so
 * the window Rust has to retry through is as small as possible to begin
 * with.
 */
async function cleanupStoppedWorktree(repoPath: string, branch: string): Promise<void> {
  const worktreePath = resolveDiscardWorktreePath(repoPath, branch);
  await discardWorktree(repoPath, worktreePath, branch).catch(() => {
    // Best-effort — see doc comment above.
  });
}

// ── Journal-first mission tombstone (B — 2026-08-04) ─────────────────
//
// A mission's real source of truth is its `missions_current` journal row
// (T0.5) — but a mission can drop out of `state.missions` (deleteMission,
// a foreign/stale project, a session that never loaded it) while that row
// still exists and is still visible to the user via useFleetMissions / the
// canvas. Before this fix, the manager's delete_mission/archive_mission
// entry points could only ever act on `state.missions`: a target absent
// from it threw an honest-SOUNDING but WRONG "introuvable" for a mission
// the user could see perfectly well, and even a successful delete of a
// LIVE mission never wrote anything durable (the debounce-save effect only
// journals a mission still IN state.missions), so the very next
// journal-backed boot silently resurrected it.

/** Wire shape of one row from `journal_missions_current` — mirrors
 *  fleetMissions.ts's own (unexported) `MissionCurrentRow` /
 *  missionsProjection.ts's own (journal.rs's `MissionCurrentOut`). */
interface JournalMissionRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

/**
 * Looks up ONE mission's row directly in the journal's `missions_current`
 * projection, across EVERY project (no project filter — same precedent as
 * fleetMissions.ts's own polling call: `state.missions` carries no project
 * id, so there is no single project to scope this to). The read side of
 * the B1 fix: a mission `state.missions` no longer carries (wrong project,
 * evicted, this session never loaded it) may still be a REAL mission the
 * user can see on the board/canvas via `useFleetMissions`, sourced from
 * this exact table.
 *
 * Never throws — returns `null` when the row is missing, its `data` isn't
 * parseable/object-shaped JSON, the app is not running under Tauri
 * (web/mock has no journal), or the invoke itself fails. Callers treat
 * `null` identically to "nothing to act on here" — the pre-existing,
 * honest `agents.manager.missionNotFound` case.
 */
async function findJournalMissionRow(
  missionId: string,
): Promise<{ projectId: string; data: Record<string, unknown> } | null> {
  if (!isTauri()) return null;
  try {
    const rows = await invoke<JournalMissionRow[]>('journal_missions_current');
    const row = rows.find((r) => r.mission_id === missionId);
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.data);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { projectId: row.project_id, data: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Journal-first tombstone (B1/B2 fix): marks a mission `archived: true` —
 * the SAME read-model flag/filter every real-mission consumer in this
 * codebase already honors (reconciler.ts, canvasDigest.ts,
 * managerSignals.ts, fleetHygiene.ts, this file's own archiveMission — see
 * Mission.archived's doc comment, types.ts) — by re-emitting the row's OWN
 * existing snapshot (`existingData`, when the caller already fetched it —
 * never re-derived/guessed) merged with `archived: true`, via the SAME
 * `mission.updated` event type + `{mission}` payload shape the
 * debounce-save effect already uses for every ordinary live edit.
 * apply_mission_projection (journal.rs) treats every `mission.*` event
 * identically for the missions_current UPSERT (it keys off the payload's
 * own `mission`/`status` fields, not the type suffix), so this is not a
 * new wire format — just a one-off emission for a mission the recurring
 * debounce-save effect will never see again (already removed from
 * `state.missions`, or never in it to begin with).
 *
 * Uses the row's OWN real `projectId` — either passed in by a caller that
 * already resolved it from the mission's own `repoRoot` (a live target),
 * or looked up via `findJournalMissionRow` (an orphan target) — NEVER the
 * active project's id. Best-effort / fire-and-forget by design, same as
 * every other side-journal write in this file (see e.g. archiveMission's
 * own emitEvent call): a failure here must never block or contradict the
 * caller's own (already-applied or already-verified) result — emitEvent
 * itself never rejects (it catches + console.warns internally).
 */
async function tombstoneJournalMission<T extends object>(
  missionId: string,
  projectId: string,
  existingData?: T,
): Promise<void> {
  await emitEvent({
    type: 'mission.updated',
    tsMs: Date.now(),
    projectId,
    missionId,
    actor: 'user',
    payload: { mission: { ...(existingData ?? {}), id: missionId, archived: true } },
  });
}

/**
 * Journal-first zombie recovery (B — 2026-08-04 boot fix, real prod
 * incident: mission M9 stayed "running 26%" forever across every later
 * boot because it belonged to a project that was never the ACTIVE one at
 * any later boot — see the cross-project sweep effect's own doc comment
 * for the full story). Re-emits the row's OWN existing snapshot merged
 * with `status: 'failed'` + `statusReason` via the SAME `mission.updated`
 * + full-snapshot payload shape `tombstoneJournalMission` uses — critically
 * a FULL snapshot, never a status-only event: `applyReplayRecovery`'s own
 * `mission.failed` event (payload `{reason}`, no `mission` key) only
 * updates `missions_current`'s `status` COLUMN via apply_mission_projection's
 * status-only branch (journal.rs) — `data` (what every real reader,
 * fleetMissions.ts/missionsProjection.ts, actually parses) stays stuck at
 * the pre-crash snapshot. A full snapshot here fixes both at once.
 */
async function markJournalMissionInterrupted(
  missionId: string,
  projectId: string,
  existingData: Record<string, unknown>,
  statusReason: string,
): Promise<void> {
  await emitEvent({
    type: 'mission.updated',
    tsMs: Date.now(),
    projectId,
    missionId,
    actor: 'system',
    payload: { mission: { ...existingData, id: missionId, status: 'failed', statusReason, liveAction: undefined } },
  });
}

/** Outcome of ONE mission's drift-tolerant worktree discard attempt (C —
 *  worktree capability). `root` on 'discarded' is the candidate project
 *  root the worktree was actually found+removed under — useful for an
 *  honest result message when it differs from the mission's own
 *  `repoRoot`/project. `checked` on 'not_found' is how many open-project
 *  candidates were actually probed (existence-checked) before giving up. */
export type WorktreeDiscardOutcome =
  | { outcome: 'discarded'; root: string }
  | { outcome: 'not_found'; checked?: number }
  | { outcome: 'skipped' }
  | { outcome: 'error'; reason: string };

/** Best-effort classification of a discardWorktree failure message — never
 *  authoritative (the Rust error contract is a plain string, not a typed
 *  reason), just enough to tell an expected "nothing there" apart from a
 *  real failure worth surfacing distinctly. Still consulted as defense in
 *  depth for a race (directory removed between the existence probe and the
 *  discard call below) — the PRIMARY not-found signal is now the existence
 *  probe itself, not this heuristic. */
function classifyDiscardFailure(message: string): 'not_found' | 'error' {
  const m = message.toLowerCase();
  return m.includes('not found') || m.includes('does not exist') || m.includes('no such') || m.includes('introuvable')
    ? 'not_found'
    : 'error';
}

/**
 * Real filesystem probe for a candidate worktree path — `platform.fs.readDir`
 * resolves for an existing directory (even an empty one) and rejects for a
 * missing one, which is exactly the existence signal `resolveMissionWorktreeCandidates`
 * needs (see its own doc comment for WHY this probe is now mandatory, not
 * optional). Never throws — a rejection just means "not there".
 */
async function defaultWorktreeExists(path: string): Promise<boolean> {
  try {
    await getPlatform().fs.readDir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drift-tolerant worktree discard (C — worktree capability, 2026-08-04):
 * resolves and discards ONE mission's git worktree, trying `primaryRoot`
 * (the mission's own `repoRoot`, or an orphan row's `project_id` — see call
 * sites) first and, when that candidate does not hold the worktree,
 * falling back to the SAME sanitized `.lazy/worktrees/<branch>` path
 * (resolveDiscardWorktreePath) under EVERY OTHER open project before
 * giving up — a mission's recorded project is not always where its
 * worktree still physically lives (the exact drift Mission.repoRoot now
 * closes going forward, but pre-existing missions can still be stale).
 * Fixes a real capability gap (manager QA, 2026-08-04): the manager could
 * not act on a worktree at all ("je ne peux physiquement pas toucher aux
 * worktrees"), even though the primitive (discardWorktree /
 * agent_discard_worktree) already existed — it was simply never reachable
 * outside the human-only discardMission (Reject) flow.
 *
 * IDEMPOTENCE fix (2026-08-04 live-prod incident, M5-M8): `agent_discard_worktree`
 * is IDEMPOTENT on the Rust side — it resolves SUCCESSFULLY even when the
 * target directory does not exist (safe-to-call-twice by design). This
 * function used to call it straight away on the first candidate and treat
 * ANY resolved promise as proof of a real discard, so the search always
 * "succeeded" on the FIRST open project (whether or not the worktree ever
 * lived there) and NEVER walked on to a later project where the real
 * directory still existed — the exact bug that made "Worktree jeté" a lie
 * for M5-M8. Every candidate is now existence-checked (`deps.exists`,
 * default: a real `platform.fs.readDir` probe) BEFORE `discardFn` is ever
 * called: absent -> this candidate is 'not_found', move to the next one
 * WITHOUT calling discard at all; present -> discard for real, and only
 * THEN is it a genuine success.
 *
 * Once every candidate has been probed, the outcome is 'not_found' (never
 * a false 'discarded') when none of them had the directory — with
 * `checked` naming exactly how many open-project candidates were probed,
 * for an honest "introuvable sur les N projets ouverts" report — unless a
 * real `discardFn` failure occurred on a candidate that DID exist (a race,
 * a permissions error, ...), which still reports 'error' with the real
 * reason, never silently downgraded. In non-Tauri mode there is no real
 * backend to discard against at all (mirrors discardMission's own
 * isTauri() gate) — resolves 'skipped' immediately, no candidate probed.
 *
 * Dependency-injectable (`deps.discardFn`/`deps.tauriCheck`/`deps.exists`)
 * for direct unit testing without a real Tauri runtime.
 */
export async function resolveMissionWorktreeCandidates(
  branch: string | undefined,
  primaryRoot: string | undefined,
  otherRoots: readonly string[],
  deps: {
    discardFn?: (repoPath: string, worktreePath: string, branch: string) => Promise<void>;
    tauriCheck?: () => boolean;
    exists?: (path: string) => Promise<boolean>;
  } = {},
): Promise<WorktreeDiscardOutcome> {
  const discardFn = deps.discardFn ?? discardWorktree;
  const tauriCheck = deps.tauriCheck ?? isTauri;
  const exists = deps.exists ?? defaultWorktreeExists;

  if (!branch) return { outcome: 'skipped' };
  if (!tauriCheck()) return { outcome: 'skipped' };

  const candidateRoots = [primaryRoot, ...otherRoots].filter(
    (root, index, all): root is string => !!root && all.indexOf(root) === index,
  );
  if (candidateRoots.length === 0) return { outcome: 'not_found', checked: 0 };

  let checked = 0;
  let sawRealError = false;
  let lastReason = 'unknown';
  for (const root of candidateRoots) {
    const worktreePath = resolveDiscardWorktreePath(root, branch);
    checked += 1;
    const present = await exists(worktreePath).catch(() => false);
    if (!present) continue; // never call the idempotent discard on an unconfirmed path — try the next open project instead
    try {
      await discardFn(root, worktreePath, branch);
      return { outcome: 'discarded', root };
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      if (classifyDiscardFailure(lastReason) === 'error') sawRealError = true;
    }
  }
  return sawRealError ? { outcome: 'error', reason: lastReason } : { outcome: 'not_found', checked };
}

/** Human-readable (French, matching this action's other result text)
 *  one-line summary of a worktree discard attempt, for the manager's
 *  honest per-target "Résultat réel" report (D — see managerEngine.ts's
 *  reporting rule). Empty string for 'skipped' so it drops out cleanly
 *  when joined with the primary result sentence. `root` is humanized to
 *  its project folder NAME (basename) — never the raw `\\?\`-prefixed
 *  absolute Windows path (2026-08-04 founder directive: a chat message is
 *  user-facing copy, not a debug log). */
function describeWorktreeOutcome(
  outcome: WorktreeDiscardOutcome,
  t?: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (outcome.outcome) {
    case 'discarded':
      return t
        ? t('agents.manager.realResultDigest.worktreesPrefix', {
            detail: t('agents.manager.realResultDigest.worktreesDiscarded', { count: '1', detail: basename(outcome.root) }),
          })
        : `Worktree jeté (${basename(outcome.root)}).`;
    case 'not_found':
      return t
        ? t('agents.manager.realResultDigest.worktreesPrefix', {
            detail: t('agents.manager.realResultDigest.worktreesNotFound', { count: '1' }),
          })
        : outcome.checked
          ? `Worktree introuvable sur les ${outcome.checked} projet(s) ouvert(s) vérifié(s).`
          : 'Worktree introuvable (déjà nettoyé ou jamais créé).';
    case 'error': return `Échec du nettoyage du worktree : ${outcome.reason}`;
    case 'skipped': return '';
  }
}

// ── Revert mission (T1.7, spec §8) ──────────────────────────────────
//
// Additive mission fields not yet promoted onto `Mission` in
// lib/agents/types.ts — that file is owned by a parallel in-flight task
// (T1.2's MissionContract landed there most recently). Both fields are
// purely additive/optional, so a plain `Mission` structurally satisfies
// `RevertableMission` and vice versa — no module augmentation, no
// `unknown` cast anywhere below. See this task's report for the two
// one-line additions (`mergeSha?: string; reverted?: boolean;`) the
// integrator should fold directly onto `Mission` once types.ts is free.

/** Widens `Mission` with the two fields `approveMission`/`revertMission`
 *  need — see the module doc comment above for why this lives here instead
 *  of on `Mission` itself. Exported so MissionDetailControls can narrow a
 *  `Mission` prop the same way when deciding what to render. */
export interface RevertableMission extends Mission {
  /** Merge commit sha captured at approve time (agent_merge_worktree now
   *  returns it — git.rs, T1.7). Absent for missions merged before this
   *  shipped, or approved in web/mock mode (no real Tauri backend to merge
   *  against — see approveMission's own isTauri() branch). */
  mergeSha?: string;
  /** True once revertMission has `git revert`ed this mission's merge commit.
   *  MissionStatus (types.ts) has no 'reverted' value, so — exactly like the
   *  existing `paused` flag on Mission — this is a flag, not a new lifecycle
   *  stage: status stays 'done', every existing `status === 'done'` check
   *  across the app keeps working unchanged. */
  reverted?: boolean;
}

/**
 * Returns a copy of `missions` with `patch` (RevertableMission's additive
 * fields) merged onto the mission with id `missionId`; every other mission
 * is returned unchanged (same identity, no re-render for those rows). The
 * explicit `RevertableMission` annotation on `updated` is load-bearing: it
 * gives `mergeSha`/`reverted` a known home on the object literal's
 * contextual type, so TypeScript's excess-property check never flags them
 * as unknown `Mission` keys.
 */
function withRevertFields(
  missions: readonly Mission[],
  missionId: string,
  patch: Pick<RevertableMission, 'mergeSha' | 'reverted'>,
): Mission[] {
  return missions.map((m) => {
    if (m.id !== missionId) return m;
    const updated: RevertableMission = { ...m, ...patch };
    return updated;
  });
}

// ── Context ───────────────────────────────────────────────────────

const AgentsStoreContext = createContext<AgentsStoreValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAgentsStore(): AgentsStoreValue {
  const ctx = useContext(AgentsStoreContext);
  if (!ctx) throw new Error('useAgentsStore must be inside AgentsStoreProvider');
  return ctx;
}

/**
 * Same as useAgentsStore, but returns null instead of throwing when called
 * outside an AgentsStoreProvider ancestor. AgentsStoreProvider is only
 * mounted inside AgentsSpace (lazy-loaded, not app-root), so shell-level
 * code that wants to OPPORTUNISTICALLY read live streaming missions when
 * available — e.g. the cross-project fleet read-model,
 * src/lib/agents/fleetMissions.ts — uses this instead of requiring the
 * provider to exist.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAgentsStoreOptional(): AgentsStoreValue | null {
  return useContext(AgentsStoreContext);
}

/**
 * Stable-action slice of AgentsStoreValue — the useCallback-wrapped mutators
 * only, never conversation/mission state. Perf fix (cockpit hot-spot
 * mission, 2026-08-11): AgentsStoreProvider's single combined Context
 * re-renders EVERY subscriber whenever ANY field changes — including the
 * managerElapsedMs ticker firing once a second for the whole duration of an
 * active manager turn (see sendManagerMessage's `elapsedTicker`) — even for
 * consumers that only ever call an action and never read state. This
 * narrower Context carries ONLY these actions, memoized on their own
 * (already-stable) useCallback references in AgentsStoreProvider below, so
 * its Provider value keeps the SAME identity across an elapsedMs tick, and a
 * subscriber reading ONLY this Context genuinely skips that re-render.
 *
 * Internal-only for now: useAgentsStore() below still returns the full
 * merged value, byte-for-byte the same shape as before this fix, and none of
 * its ~70 existing call sites are touched by introducing this — migrating
 * them to read this narrower Context instead is future work, out of scope
 * for this mission. useAgentsStoreActions is the opt-in escape hatch for a
 * NEW action-only consumer.
 *
 * Deliberately EXCLUDES sendManagerMessage and clearCanvasDirect: both are
 * useCallback-wrapped with `state.conversations` itself in their own
 * pre-existing dependency array (the manager-turn action-executor closure
 * both share needs the live conversation list), so their reference legitimately
 * changes on every elapsedMs tick same as everything else in `state` — folding
 * them in here would silently defeat the whole point of this Context. Every
 * other action below depends on nothing broader than `state.missions` (or
 * on nothing at all), which an elapsedMs-only tick never touches.
 */
type AgentsStoreActionsValue = Pick<
  AgentsStoreValue,
  | 'setActiveConversationId'
  | 'addMission'
  | 'updateMission'
  | 'stopMission'
  | 'pauseMission'
  | 'resumeMission'
  | 'interveneMission'
  | 'takeoverMission'
  | 'returnFromTakeover'
  | 'approveMission'
  | 'discardMission'
  | 'revertMission'
  | 'forkMissionFromCheckpoint'
  | 'setSelectedMissionId'
  | 'toggleLoop'
  | 'skipLoopNextRun'
  | 'deleteLoop'
  | 'freezeLoopTemplate'
  | 'recordExternalMetric'
  | 'stopAll'
  | 'retryMission'
  | 'deleteMission'
  | 'archiveMission'
  | 'archiveTerminalMissions'
  | 'stopManagerMessage'
  | 'closeManagerConversation'
  | 'renameManagerConversation'
  | 'clearManagerMessages'
  | 'newManagerConversation'
  | 'loadManagerSession'
  | 'deleteManagerSession'
  | 'setManagerModel'
  | 'setAutonomyLevel'
  | 'approvePendingAction'
  | 'rejectPendingAction'
  | 'approveAllPendingActions'
  | 'rejectAllPendingActions'
  | 'changeApprovalMode'
  | 'executePlan'
  | 'revisePlan'
  | 'rejectPlan'
  | 'setStepModel'
>;

const AgentsActionsContext = createContext<AgentsStoreActionsValue | null>(null);

/**
 * Action-only subscription — see AgentsStoreActionsValue's doc comment
 * above. Prefer this over useAgentsStore() for a component that NEVER reads
 * conversation/mission state, so it stops re-rendering on the manager's
 * once-a-second elapsedMs tick.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAgentsStoreActions(): AgentsStoreActionsValue {
  const ctx = useContext(AgentsActionsContext);
  if (!ctx) throw new Error('useAgentsStoreActions must be inside AgentsStoreProvider');
  return ctx;
}

const AgentsMissionsContext = createContext<readonly Mission[] | null>(null);

/**
 * Missions-only subscription — `state.missions` keeps the same array
 * identity across the manager elapsedMs ticker (`withConversation` spreads
 * state and only replaces the patched conversation). MissionNode used to
 * read the full store just to look up one mission + call stop/retry, so
 * every canvas card re-rendered at 1 Hz during a manager turn.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAgentsStoreMissionsOptional(): readonly Mission[] | null {
  return useContext(AgentsMissionsContext);
}

/** Same as useAgentsStoreActions, but null outside AgentsStoreProvider
 *  (canvas fixture tests, Team space). */
// eslint-disable-next-line react-refresh/only-export-components
export function useAgentsStoreActionsOptional(): AgentsStoreActionsValue | null {
  return useContext(AgentsActionsContext);
}

// ── Manager model persistence ──────────────────────────────────────
// Same MODE_KEY/loadMode/saveMode shape as lazyManagerStore.tsx's own
// coder/orchestrator mode persistence — a plain localStorage read/write,
// try/catch-wrapped, never throwing. Without this, the manager's model
// picker silently reset to getDefaultModelIdForMode() on every reload —
// the ONE LazyManager setting that didn't survive a restart.

const MANAGER_MODEL_STORAGE_KEY = 'lazy.manager.model';

/**
 * Validates the persisted id against whichever catalog it actually belongs
 * to (findModelById for native Anthropic ids, findOpenRouterModel for the
 * managed/Pro OpenRouter namespace — see getDefaultModelIdForMode's own doc
 * comment for why the two id namespaces must never be conflated). A stored
 * id from a since-retired model (or a leftover id from a different provider
 * mode) falls back to today's real default instead of silently sending an
 * unrecognized model id over the wire.
 *
 * A persisted choice ALWAYS wins over the default below, explicit or not —
 * this is what keeps a manually-picked model sticky across reloads (see
 * getManagerDefaultModelId's own doc comment: it must never override a real
 * user preference, only fill in a brand-new profile's first value).
 */
function loadManagerModel(): string {
  try {
    const stored = localStorage.getItem(MANAGER_MODEL_STORAGE_KEY);
    if (stored) {
      const id = migrateRetiredOpenRouterId(stored);
      if (isSelectablePickerModel(id)) return id;
    }
  } catch {
    // localStorage unavailable — fall through to the real default below
  }
  // Manager-specific default (Sonnet for native desktop modes; free GLM on
  // the browser mock rail). NOT the shared getDefaultModelIdForMode, whose
  // native-id branch (Haiku) is right for cost-sensitive worker missions.
  return getManagerDefaultModelId(getProviderMode());
}

function saveManagerModel(model: string): void {
  try {
    localStorage.setItem(MANAGER_MODEL_STORAGE_KEY, model);
  } catch {
    // best-effort — a persistence failure must not break model selection
  }
}

// ── Manager wakeup: i18n message formatting ─────────────────────────
// managerWakeup.ts's classifyWakeupEvent is deliberately locale-agnostic
// (see that module's own doc comment) — this is the ONE place its
// WakeupCandidate shape meets real i18n, since this file already holds a
// live `t()` from useI18n(). Composes "🔔 {label} : {fact1} · {fact2} —
// {instruction}" — the visible chip text AND the literal instruction the
// LLM receives are the SAME string (see LazyManagerMessageList.tsx's
// WAKEUP_MARKER_PREFIX-based chip rendering for why that is safe).

/** Matches useI18n()'s own `t` signature exactly (same convention as
 *  activityFeedFormat.ts's own `Translate` type) — declared locally rather
 *  than imported so this formatting helper has no cross-module coupling
 *  beyond managerWakeup.ts's own types. */
type I18nTranslate = (key: string, params?: Record<string, string | number>) => string;

/** `{reason}` rendered as an optional parenthetical suffix — kept out of the
 *  translated template itself so a missing reason never leaves a dangling
 *  "()" in any locale. */
function wakeupReasonSuffix(reason: string | undefined): string {
  return reason ? ` (${reason})` : '';
}

/** Same convention as {@link wakeupReasonSuffix}, for chain.fired's target ref. */
function wakeupTargetSuffix(targetRef: string | undefined): string {
  return targetRef ? ` → ${targetRef}` : '';
}

function formatWakeupFact(candidate: WakeupCandidate, t: I18nTranslate): string {
  const id = candidate.missionId ?? '';
  switch (candidate.kind) {
    case 'mission_failed':
      return t('lazyManager.wakeup.fact.missionFailed', { id, reasonSuffix: wakeupReasonSuffix(candidate.reason) });
    case 'merge_landed':
      return t('lazyManager.wakeup.fact.mergeLanded', { id });
    case 'approve_blocked':
      return t('lazyManager.wakeup.fact.approveBlocked', { id, reasonSuffix: wakeupReasonSuffix(candidate.reason) });
    case 'review_passed':
      return t('lazyManager.wakeup.fact.judgeVerdictPassed', { id });
    case 'review_failed':
      return t('lazyManager.wakeup.fact.judgeVerdictFailed', { id });
    case 'chain_fired':
      return t('lazyManager.wakeup.fact.chainFired', { id, targetSuffix: wakeupTargetSuffix(candidate.targetRef) });
    case 'fleet_hygiene':
      return t('lazyManager.wakeup.fact.fleetHygiene', { total: candidate.hygieneTotal ?? 0 });
    case 'bot_completed':
      // The report IS the bot's answer (e.g. the page title the user asked
      // for) — inlined so the manager can relay it without a query round-trip.
      return t('lazyManager.wakeup.fact.botCompleted', {
        id,
        bot: candidate.botName ?? 'LazyBot',
        reportSuffix: candidate.report ? ` — ${candidate.report}` : '',
      });
    case 'bot_routine_failed':
      return t('lazyManager.wakeup.fact.botRoutineFailed', {
        bot: candidate.botName ?? 'LazyBot',
        reasonSuffix: wakeupReasonSuffix(candidate.reason),
      });
    case 'brain_ops_orphan':
      return t('lazyManager.wakeup.fact.brainOpsOrphan', {
        step: candidate.opsStep ?? 'brain-ops',
        detail: candidate.opsDetail ? ` — ${candidate.opsDetail}` : '',
      });
    default:
      return candidate.kind;
  }
}

/**
 * Judge review verdicts (`review_passed`/`review_failed`) are the only
 * wakeup kind that can legitimately repeat for the SAME mission within one
 * coalesced batch (e.g. a rejected mission gets auto-retried and re-judged
 * before the debounce settles) — see defect C2. Flattening those into one
 * fact per event reads as noise ("rejected · rejected · rejected · passed");
 * grouping by missionId into a single count-based fact ("M48: 3 rejected,
 * 1 passed") stays readable regardless of how many retries landed.
 *
 * Non-judge-verdict candidates pass through as individual facts, in their
 * original order. Missions with exactly one verdict keep the plain
 * single-verdict wording (no point saying "1 rejected" when the ordinary
 * fact already reads fine).
 */
function buildWakeupFacts(candidates: WakeupCandidate[], t: I18nTranslate): string[] {
  const verdictsByMission = new Map<string, WakeupCandidate[]>();
  for (const c of candidates) {
    if (c.kind !== 'review_passed' && c.kind !== 'review_failed') continue;
    const id = c.missionId ?? '';
    verdictsByMission.set(id, [...(verdictsByMission.get(id) ?? []), c]);
  }

  const emittedMissions = new Set<string>();
  const facts: string[] = [];
  for (const c of candidates) {
    if (c.kind === 'review_passed' || c.kind === 'review_failed') {
      const id = c.missionId ?? '';
      if (emittedMissions.has(id)) continue;
      emittedMissions.add(id);
      const verdicts = verdictsByMission.get(id) ?? [c];
      facts.push(
        verdicts.length === 1
          ? formatWakeupFact(verdicts[0], t)
          : t('lazyManager.wakeup.fact.judgeVerdictGrouped', {
              id,
              failed: verdicts.filter((v) => v.kind === 'review_failed').length,
              passed: verdicts.filter((v) => v.kind === 'review_passed').length,
            }),
      );
      continue;
    }
    facts.push(formatWakeupFact(c, t));
  }
  return facts;
}

/** Builds the full wakeup message text from a coalesced candidate batch
 *  (managerWakeup.ts's debounce may hand this several events at once) —
 *  never called with an empty array (the scheduler only fires with at
 *  least one candidate pending). Exported (rather than kept module-private,
 *  the usual convention here — see this section's own header comment) so
 *  tests can exercise the real judge-verdict grouping logic (defect C2)
 *  instead of re-implementing it as a mirror. */
export function formatWakeupMessage(candidates: WakeupCandidate[], t: I18nTranslate): string {
  const body = buildWakeupFacts(candidates, t).join(' · ');
  return `${WAKEUP_MARKER_PREFIX}${t('lazyManager.wakeup.label')} : ${body} — ${t('lazyManager.wakeup.instruction')}`;
}

/**
 * Human-facing counterpart to formatWakeupMessage — same label + facts, but
 * WITHOUT the trailing `lazyManager.wakeup.instruction` clause ("check the
 * follow-up... reply in French"). That clause is an internal directive
 * addressed to the MODEL, not the user; showing it verbatim in the
 * transcript read as the manager talking to itself out loud (real user
 * report, 2026-08-01 QA). Used as the wakeup ManagerMessage's
 * `displayContent` (see that field's own doc comment) — the LLM still
 * receives the full instruction via `content`/formatWakeupMessage above,
 * completely unchanged, so managerEngine.ts's proactive-wakeup behavior and
 * the reply-language directive (i18nLazyLoad.test.tsx's own coverage) are
 * both untouched by this — only what gets RENDERED to the human differs. */
export function formatWakeupDisplayMessage(candidates: WakeupCandidate[], t: I18nTranslate): string {
  const body = buildWakeupFacts(candidates, t).join(' · ');
  return `${WAKEUP_MARKER_PREFIX}${t('lazyManager.wakeup.label')} : ${body}`;
}

/** Turn text for managerApprovalResume.ts's automated follow-up turn — the
 *  direct sibling of formatWakeupMessage above, same reasoning (see that
 *  module's own header for why locale-aware text-building lives here, not
 *  in the pure decision module): reuses WAKEUP_MARKER_PREFIX so the
 *  transcript's small-chip rendering (LazyManagerMessageList.tsx's
 *  isWakeupMarker check) picks this up for free — both are the SAME kind
 *  of thing from the human's point of view, a synthetic system-triggered
 *  turn, not a real message they typed. */
export function formatApprovalResumeMessage(t: I18nTranslate): string {
  return `${WAKEUP_MARKER_PREFIX}${t('lazyManager.approvalResume.label')} : ${t('lazyManager.approvalResume.instruction')}`;
}

// ── Mission Charter convergence (Defect 2: manager loops on the charter
// instead of advancing) ─────────────────────────────────────────────
// Real repro (2026-07-28 test session): the manager proposed THREE
// successive charters for the same mission — each restating/improving the
// last (decisions integrated, a new risk warning added), never advancing to
// propose_artifact/generate_plan. Root cause: the ONLY place a charter
// validation actually lands is the plain-text Validate message
// (missionCharter.ts's formatCharterValidationMessage, components/lazyManager
// — there is no dedicated store method flipping `charterProposal.state`, see
// that module's own INTEGRATION GAP doc comment), buried somewhere in the
// conversation transcript; nothing told the manager, in its OWN STRUCTURED
// context (as opposed to its own recollection of the prose), that this had
// already happened. deriveCharterStatusContext below derives a compact,
// unambiguous signal PURELY from the transcript already in
// state.managerMessages — no new store field, no change to any other file.
//
// The Validate/Reject message is a FIXED-SHAPE i18n string (missionCharter.ts,
// out of this task's perimeter) — recognized here via the SAME `t()` key with
// sentinel placeholders so this never hardcodes per-locale text that could
// drift out of sync across the app's 6 locales, and keeps matching even when
// the user edited the charter's objective/nature/gates before clicking
// Validate (those edited values never appear in the STATIC prefix checked
// below).

/** Static (non-interpolated) prefix of the charter Validate message, in
 *  whichever locale `t` is currently bound to — every locale's
 *  `lazyManager.charter.validateMessage` template opens with fixed wording
 *  before the first `{objective}` placeholder, so this alone is enough to
 *  recognize a Validate message regardless of what was actually typed into
 *  objective/nature/gates. */
function charterValidationPrefix(t: I18nTranslate): string {
  const sentinel = '§§§';
  return t('lazyManager.charter.validateMessage', { objective: sentinel, nature: sentinel, gates: sentinel }).split(sentinel)[0];
}

/**
 * Compact, real per-turn signal for ManagerContext.charterStatusContext
 * (managerEngine.ts): has the most recently proposed Mission Charter in this
 * conversation actually been validated? Scans every message AFTER the last
 * `charterProposal`-bearing assistant message — including `latestUserContent`,
 * the message about to be sent this very turn, so the fix takes effect on the
 * SAME turn the user clicks Validate, not one turn later — for the fixed
 * Validate/Reject message shape. Returns undefined when no charter was ever
 * proposed in this conversation: nothing to report, never a fabricated
 * "no charter" claim.
 */
export function deriveCharterStatusContext(
  messages: readonly ManagerMessage[],
  latestUserContent: string,
  t: I18nTranslate,
  conversationId?: string,
): string | undefined {
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].charterProposal) { lastIdx = i; break; }
  }
  if (lastIdx === -1) return undefined;
  const proposal = messages[lastIdx].charterProposal;
  if (!proposal) return undefined;

  const stored = conversationId && proposal.charterId
    ? getCharterDecision(conversationId, proposal.charterId)
    : undefined;

  const validatePrefix = charterValidationPrefix(t);
  const rejectMessage = t('lazyManager.charter.rejectMessage');
  const laterContents = [...messages.slice(lastIdx + 1).map((m) => m.content), latestUserContent];
  const accepted = stored === 'accepted' || laterContents.some((c) => c.startsWith(validatePrefix));
  const rejected = stored === 'rejected' || (!accepted && laterContents.some((c) => c.startsWith(rejectMessage)));
  if (conversationId && proposal.charterId && accepted) recordCharterDecision(conversationId, proposal.charterId, 'accepted');
  if (conversationId && proposal.charterId && rejected) recordCharterDecision(conversationId, proposal.charterId, 'rejected');

  const objective = proposal.charter.objective.slice(0, 100);
  const gates = proposal.charter.validationGates.frozenOnce;
  const gatesNote = gates.length > 0 ? `frozen-once gate on: ${gates.join(', ')}` : 'no frozen-once gate';

  if (accepted) {
    return `ACCEPTED for "${objective}" (${gatesNote}). SETTLED — never re-emit propose_mission_charter for this same mission, not even an "updated" one. Your very next turn must instead: (a) propose_artifact if the frozen-once gate names a visual deliverable, THEN (b) generate_plan to draw the real graph, in that order.`;
  }
  if (rejected) {
    return `REJECTED for "${objective}". Rework it with a NEW propose_mission_charter${proposal.charterId ? ` (reuse charterId "${proposal.charterId}")` : ''} before drawing any graph — never build the graph off a rejected charter.`;
  }
  return `PROPOSED for "${objective}", awaiting the user's validation — do not re-propose it and do not build the graph until they respond.`;
}

// ── Provider ──────────────────────────────────────────────────────

interface Props {
  children: React.ReactNode;
}

export function AgentsStoreProvider({ children }: Props) {
  // Lazy initializer (runs once, not on every render) — mints the ONE
  // default conversation every app session starts with. See
  // ManagerConversationState/AgentsState.conversations' own doc comments for
  // the id-space contract; the mount-restore effect below may re-key this
  // default conversation onto a persisted session's own id when one exists.
  const [state, setState] = useState<AgentsState>(() => {
    const initialConversationId = mintManagerSessionId();
    return {
      missions: getInitialMissions(),
      selectedMissionId: null,
      orchestrators: [],
      activeGraphRun: null,
      activeGraphSnapshot: null,
      conversations: { [initialConversationId]: emptyManagerConversation(initialConversationId) },
      conversationOrder: [initialConversationId],
      activeConversationId: initialConversationId,
      // Persisted (loadManagerModel) so a manually-picked model survives a
      // reload — only ids currently offerable in the picker are restored;
      // otherwise getManagerDefaultModelId (free GLM in the browser).
      managerModel: loadManagerModel(),
      autonomyLevel: 'supervised',
    };
  });
  const { t, locale } = useI18n();
  // Live-`t` escape hatch for the FEW callbacks below that are registered
  // ONCE (empty/stable deps, e.g. the loop scheduler's onFire — see its own
  // call site) and therefore cannot close over a fresh `t` on every locale
  // change the way a normal useCallback([t, ...]) does. Updated on every
  // render (no effect needed — `t` already exists this render, unlike the
  // forward-referenced updateMissionRef/relaunchQueuedMissionRef below,
  // which sync via effect only because THEIR source doesn't exist yet at
  // this point in the file).
  const tRef = useRef(t);
  tRef.current = t;
  const { toast } = useToast();
  // Real credits/subscription state for the LazyManager's "combien ai-je de
  // crédits ?" grounding (see sendManagerMessage below) — reads the SAME
  // shared context the credits KPI tile / AccountChip already display, no
  // extra fetch. Falls back to the inert DEFAULT_STATE (isPro: false,
  // subscription: null) when no SubscriptionProvider ancestor is mounted
  // (e.g. most existing tests render AgentsStoreProvider standalone) —
  // formatCreditsSummary then honestly reports the free-plan state instead
  // of throwing or fabricating a number.
  const { subscription, isPro } = useSubscriptionContext();

  // P58 fleet hygiene (2026-07-22 memory-pressure incident fix) — the
  // test-scratch OPEN PROJECT closure rule needs the live openProjects
  // registry + a way to switch/close a project (AppContext.tsx). Read via
  // the SAFE optional variant (mirrors useSubscriptionContext's own
  // graceful-degradation comment just above): most of this file's own unit
  // tests render AgentsStoreProvider standalone, with no AppProvider
  // ancestor — `null` here just means "nothing to sweep" for that rule,
  // never a crash.
  const appContext = useAppContextOptional();

  // LazyManager history (managerPersistence.ts) — same hook shape as the
  // Code assistant's useChatPersistence, minus projectRoot scoping (see
  // managerPersistence.ts's doc comment: the manager is fleet-wide, not
  // per-project).
  const {
    sessions: managerPersistedSessions,
    saveMessages: saveManagerMessages,
    loadSession: loadManagerPersistedSession,
    deleteSession: deleteManagerPersistedSession,
  } = useManagerPersistence();

  /**
   * Manager turn abort plumbing (W-STOPLLM, stop button), keyed by
   * conversation id — multi-conversation LazyManager (wave 1): each open
   * conversation owns its OWN exchange-wide `turnCtrl` AbortController
   * (sendManagerMessage below), so a Stop click on one conversation can
   * never reach into another's in-flight turn. A user-initiated Stop aborts
   * THAT conversation's controller, which cascades into whichever per-call
   * child AbortController (createManagerCallController) is currently in
   * flight for it, rather than reaching into that child directly. Set at
   * the start of every sendManagerMessage call for its own conversationId,
   * cleared (mapped back to `null`) in its `finally`, so a stale reference
   * from a PAST turn can never be aborted by a Stop click that arrives
   * after that turn has already resolved.
   */
  const managerAbortRef = useRef<Map<string, AbortController | null>>(new Map());
  /**
   * Set true (per conversation id) by stopManagerMessage just before it
   * calls `.abort()` — lets sendManagerMessage's catch block distinguish a
   * user-initiated Stop from a per-call budget or the global cap firing on
   * its own, even though both ultimately observe the same underlying signal
   * aborting. Reset at the start of every turn alongside managerAbortRef,
   * for that SAME conversation only.
   */
  const managerStoppedRef = useRef<Map<string, boolean>>(new Map());
  /**
   * Concurrency cap (MAX_CONCURRENT_MANAGER_TURNS): `runningManagerTurnsRef`
   * counts how many conversations currently HOLD a turn slot;
   * `managerTurnQueueRef` holds the resolvers for conversations waiting for
   * one to free (FIFO — first queued, first resumed). See
   * acquireManagerTurnSlot/releaseManagerTurnSlot below for the full
   * contract; this is a plain in-memory semaphore, not persisted (a reload
   * naturally drops every in-flight turn anyway).
   */
  const runningManagerTurnsRef = useRef(0);
  const managerTurnQueueRef = useRef<Array<{ conversationId: string; resolve: () => void }>>([]);

  /**
   * Acquires a manager-turn concurrency slot for `conversationId`, awaiting
   * one if MAX_CONCURRENT_MANAGER_TURNS are already in flight elsewhere.
   * `onQueued` fires ONLY when this call actually has to wait (never on the
   * common "a slot was free" path) — sendManagerMessage uses it to flip this
   * conversation's `phase` to 'queued', so the UI only ever shows "en
   * attente" when a wait genuinely happened. Always resolves eventually
   * (FIFO) — there is no cancellation path yet (see this file's own report
   * on what wave 1 left as a seam).
   */
  const acquireManagerTurnSlot = useCallback(async (conversationId: string, onQueued: () => void): Promise<void> => {
    if (runningManagerTurnsRef.current < MAX_CONCURRENT_MANAGER_TURNS) {
      runningManagerTurnsRef.current += 1;
      return;
    }
    onQueued();
    await new Promise<void>((resolve) => {
      managerTurnQueueRef.current.push({ conversationId, resolve });
    });
    runningManagerTurnsRef.current += 1;
  }, []);

  /** Releases a manager-turn concurrency slot and resumes the next queued
   *  conversation (if any), FIFO. Called exactly once per acquire, from
   *  sendManagerMessage's `finally`. */
  const releaseManagerTurnSlot = useCallback((): void => {
    runningManagerTurnsRef.current = Math.max(0, runningManagerTurnsRef.current - 1);
    const next = managerTurnQueueRef.current.shift();
    if (next) next.resolve();
  }, []);

  // Latest-state snapshot (FIX C, code review): lets callbacks make a
  // pure, one-shot decision (e.g. "did this mission just reach a terminal
  // status") BEFORE calling setState, so the updater passed to setState
  // itself never has to call toast(). This is the standard "useLatest"
  // pattern — the ref is synced from an effect (never written during render,
  // per react-hooks/refs) and is always caught up by the time any
  // event-handler-like callback below runs, since those only ever fire after
  // the render that scheduled them has committed and flushed. See
  // updateMission and addMission's runMission catch handler, both of which
  // used to call toast() from inside a setState updater — impure, and
  // StrictMode's deliberate double-invoke of updater functions could
  // double-fire the toast (this is what caused the "Cannot update a
  // component (ToastProvider) while rendering a different component"
  // warning).
  const stateRef = useRef(state);
  // Sync during render (not only in an effect): sendManagerMessage awaits
  // then reads live conversations. An effect-only sync left the in-flight
  // turn looking at a pre-userMsg snapshot — the LLM never saw the question.
  stateRef.current = state;

  /**
   * P58 (automatic fleet hygiene) — invoked from the mission-terminal choke
   * points below (updateMission/applyRunUpdate, the SAME choke point
   * loop-stop/auto-merge already hook into) and the boot/periodic sweep
   * effect further down. A ref (not a plain function) because those choke
   * points are declared BEFORE `runFleetHygieneSweep` itself (which needs
   * `archiveMission`/`deleteMission`, both declared later in this file) —
   * same "declare early, sync via a later effect" convention as
   * `archiveMissionRef` further down. Starts as a no-op so an early
   * terminal transition during the same render pass never throws.
   */
  const runFleetHygieneSweepRef = useRef<() => void>(() => {});
  /**
   * Section 4 gate (loop failure demotion) — same "declare early, sync via a
   * later effect" convention as `runFleetHygieneSweepRef` above: both of this
   * store's mission-terminal choke points (updateMission/applyRunUpdate) call
   * this ref, but `announceLoopFailureIfDemoted` itself needs
   * `sendManagerMessageRef`/`resolveManagerModelId`, both declared much later
   * in this file — a plain forward reference to the `const` would access it
   * before its declaration. Starts as a no-op so an early loop failure during
   * the same render pass never throws.
   */
  const announceLoopFailureIfDemotedRef = useRef<
    (repoPath: string, mission: Pick<Mission, 'loopParentId'>) => Promise<void>
  >(async () => {});
  /** Best-known epoch ms each mission reached its CURRENT terminal status
   *  this session — fleetHygiene.ts's grace-period rule (a) reads this (via
   *  `HygieneMission.terminalAtMs`), falling back to the mission's own
   *  `createdAt` across a restart (see fleetHygiene.ts's own doc comment on
   *  why that fallback is safe for a 24h-default grace period). */
  const missionTerminalAtRef = useRef<Map<string, number>>(new Map());
  /**
   * Fix 4 (TTL for stale transient canvas artifacts) — epoch ms each
   * `'preview'` canvas surface was FIRST OBSERVED still without a real
   * address by a hygiene sweep, keyed by surface id. `SurfaceSpec` carries
   * no created/configured timestamp of its own (see
   * `HygienePreviewSurface.placeholderSinceMs`'s own doc comment,
   * fleetHygiene.ts), so this mirrors `missionTerminalAtRef` immediately
   * above: a session-local, ref-tracked "best-known since when" a caller
   * without a real persisted timestamp maintains itself. Stamped/cleared
   * every sweep by `runFleetHygieneSweep` below — cleared the moment a
   * tracked id gets a real address (or disappears), so a surface's TTL
   * clock genuinely restarts if the user re-uses it. Resets on an app
   * restart (same documented limitation as `missionTerminalAtRef` — a
   * fail-open direction: worst case a still-dead placeholder survives a
   * little longer before this rule catches it again, never the destructive
   * direction).
   */
  const previewPlaceholderFirstSeenRef = useRef<Map<string, number>>(new Map());

  // ── W-MODES: approval modes boot + auto-merge trigger ─────────────
  //
  // ensureApprovalModesLoaded is idempotent (approvalMode.ts) — safe to call
  // unconditionally on every mount, same convention as CapObjectives.tsx's
  // own ensureObjectivesLoaded() call for the sibling objectives store.
  useEffect(() => {
    void ensureApprovalModesLoaded();
  }, []);

  // ── LazyManager history persistence (multi-conversation, wave 2) ──────
  //
  // Item 1 fix (real user QA, 2026-08-01, verbatim: "worse than not having
  // tabs" — a mission chain launched from a background tab kept running
  // while every open conversation silently vanished on restart). Wave 1
  // only ever persisted each conversation's OWN transcript/pendingApprovals
  // (`lazy.managerSessions`, managerPersistence.ts's `sessions`) — WHICH
  // conversations were open, in what order, and which was active never
  // left React state, so every restart collapsed back to exactly one
  // conversation (the single most-recently-updated session, restored into
  // the ONE default conversation this Provider always mints at mount).
  //
  // `loadOpenWorkingSet` reads the NEW `lazy.managerOpenSessions` key
  // (managerPersistence.ts) capturing conversationOrder + activeConversationId
  // (+ which conversations were busy at save time — see the system-marker
  // handling below). It is `null` on a first boot, or any boot before this
  // fix ever shipped (the key simply doesn't exist yet) — `restorableOrder`
  // is then empty and the code falls straight through to the exact
  // single-conversation restore wave 1 always did, UNCHANGED below, so "a
  // first boot with no persisted set behaves exactly as today" holds by
  // sharing the same code path, not by a second implementation that could
  // drift from it.
  //
  // Cross-referenced against `managerPersistedSessions` (the SESSION list,
  // `lazy.managerSessions`) — never trust the working set's own id list
  // alone: a session the user deleted from history (deleteManagerSession)
  // must never be resurrected as a live tab just because it was still open
  // when the app last closed. Capped to MAX_OPEN_MANAGER_CONVERSATIONS —
  // an older/hand-edited working set is never trusted past the SAME cap
  // every live open/loadManagerSession call already enforces.
  //
  // MOUNT ONLY, same guard shape as the single-conversation fallback below:
  // only fires while the boot state is still the untouched, single, empty
  // conversation this Provider just minted (never clobbers a real
  // in-flight/typed-into conversation, and is a no-op the second time under
  // StrictMode's deliberate double-invoke).
  useEffect(() => {
    const workingSet = loadOpenWorkingSet();
    const restorableOrder = workingSet
      ? workingSet.order
          .filter((id) => managerPersistedSessions.some((s) => s.id === id))
          .slice(0, MAX_OPEN_MANAGER_CONVERSATIONS)
      : [];

    if (restorableOrder.length > 0) {
      setState((prev) => {
        const bootConv = prev.conversations[prev.activeConversationId];
        if (!bootConv || prev.conversationOrder.length !== 1 || bootConv.messages.length > 0) return prev;
        const conversations: Record<string, ManagerConversationState> = {};
        for (const id of restorableOrder) {
          const restored = loadManagerPersistedSession(id);
          if (!restored) continue;
          // A conversation that was BUSY (a real manager turn in flight) at
          // the moment this was last saved comes back idle — there is no
          // process to reattach to, ever (managerAbortRef/
          // runningManagerTurnsRef are plain in-memory refs, never
          // persisted; a reload always drops every in-flight turn). Rather
          // than silently pretending nothing happened (the user would see
          // their question just... sitting there with no reply, forever),
          // an honest system-chip marker is appended — same 'system' role
          // LazyManagerMessageList already renders as a small centered
          // chip for every other "nothing to see here but you should know"
          // notice (e.g. the manager-wakeup chip).
          const wasBusy = workingSet!.busyIds.includes(id);
          const messages = wasBusy
            ? [
                ...restored.messages,
                {
                  id: createMessageId(),
                  role: 'system' as const,
                  content: t('lazyManager.conversationRestoredInterrupted'),
                  timestamp: new Date().toISOString(),
                },
              ]
            : restored.messages;
          conversations[id] = {
            id,
            messages,
            busy: false,
            phase: 'idle',
            elapsedMs: 0,
            pendingApprovals: restored.pendingApprovals.map(fromPersistedPendingApproval),
            lastActiveAt: Date.now(),
            customTitle: restored.title,
          };
        }
        if (Object.keys(conversations).length === 0) return prev;
        const order = restorableOrder.filter((id) => conversations[id]);
        const activeConversationId = order.includes(workingSet!.activeId) ? workingSet!.activeId : order[0];
        return { ...prev, conversations, conversationOrder: order, activeConversationId };
      });
      return;
    }

    // ── Single-conversation fallback (wave 1's original behaviour,
    // unchanged) — no open-working-set was ever persisted (first boot, or
    // any boot before this fix shipped). Restore the most recently updated
    // persisted conversation into the ONE default conversation this
    // Provider minted at mount. Re-keys the freshly-minted boot
    // conversation onto the persisted session's OWN id (never a separate,
    // translated id) — this conversation effectively RESUMES that session,
    // so the very next autosave writes back into the SAME localStorage
    // record instead of forking a lookalike duplicate under the boot-time
    // id.
    //
    // PENDING-APPROVAL PERSISTENCE FIX (see managerPersistence.ts's own doc
    // comment): restores `pendingApprovals` in the SAME setState as
    // `messages` — loadManagerPersistedSession returns both, never just the
    // messages, so a gate-deferred action that was awaiting approval when
    // the app last closed/reloaded is actionable again immediately, instead
    // of leaving its origin message stranded with no way to resolve it.
    const latest = [...managerPersistedSessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) return;
    const restored = loadManagerPersistedSession(latest.id);
    if (!restored) return;
    setState((prev) => {
      const bootConv = prev.conversations[prev.activeConversationId];
      // Never clobber a real in-flight/typed-into conversation, and never
      // re-key when the boot conversation is ALREADY that exact persisted
      // session (re-running this mount-only effect twice under StrictMode's
      // deliberate double-invoke must be a no-op the second time).
      if (!bootConv || bootConv.messages.length > 0 || bootConv.id === latest.id) return prev;
      const { [bootConv.id]: _bootConv, ...restConversations } = prev.conversations;
      const restoredConv: ManagerConversationState = {
        id: latest.id,
        messages: restored.messages,
        busy: false,
        phase: 'idle',
        elapsedMs: 0,
        pendingApprovals: restored.pendingApprovals.map(fromPersistedPendingApproval),
        lastActiveAt: Date.now(),
        customTitle: restored.title,
      };
      return {
        ...prev,
        conversations: { ...restConversations, [latest.id]: restoredConv },
        conversationOrder: prev.conversationOrder.map((id) => (id === bootConv.id ? latest.id : id)),
        activeConversationId: latest.id,
      };
    });
    // Mount-only: managerPersistedSessions/loadManagerPersistedSession are
    // stable at mount (useManagerPersistence initialises its sessions
    // synchronously via useState, same guarantee useChatPersistence gives
    // assistantStore.tsx's identical mount effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Item 1 fix — persists the open-conversation working set (order +
  // active id + which conversations are currently busy) every time it
  // changes, so a restart can restore it (the mount effect just above).
  // Deliberately does NOT depend on `state.conversations` directly (only on
  // a derived busy-signature string) — the per-second elapsed-time ticker
  // (sendManagerMessage's `elapsedTicker`) patches ONLY `elapsedMs` on a
  // busy conversation every tick, which would otherwise re-run this effect
  // (and rewrite localStorage) once a second for as long as ANY open
  // conversation stays busy, for zero actual change to what's being
  // persisted — same "reference-equality/signature skip is load-bearing,
  // not an optimization" reasoning as the per-conversation autosave effect
  // above.
  const openWorkingSetBusySignature = state.conversationOrder
    .map((id) => (state.conversations[id]?.busy ? '1' : '0'))
    .join('');
  useEffect(() => {
    if (state.conversationOrder.length === 0) return;
    const busyIds = state.conversationOrder.filter((id) => state.conversations[id]?.busy);
    saveOpenWorkingSet(state.conversationOrder, state.activeConversationId, busyIds);
  }, [state.conversationOrder, state.activeConversationId, openWorkingSetBusySignature]);

  // Autosave — debounced PER CONVERSATION on every messages/pendingApprovals
  // change (rather than one explicit saveMessages() call per code path like
  // assistantStore.tsx's persistMessages, which sendManagerMessage below
  // would need to thread through several setState call sites for). Skips a
  // conversation with zero messages (nothing to persist — also
  // useManagerPersistence.saveMessages's own guard).
  //
  // Reference-equality skip (autosaveSeenRef) is load-bearing, not an
  // optimization: `withConversation` only ever overwrites the PATCHED
  // fields, so `messages`/`pendingApprovals` keep the SAME array reference
  // across a patch that only touches e.g. `busy`/`phase`/`elapsedMs` (the
  // per-second elapsed-time ticker below ticks EVERY open conversation's
  // ticking timer). Without this skip, this effect (which depends on the
  // whole `state.conversations` map — it has to, to see every open
  // conversation) would re-run and reschedule EVERY conversation's debounce
  // timer on every 1s tick from ANY busy conversation, and a busy
  // conversation would then never actually autosave for as long as it (or
  // any sibling) kept ticking.
  //
  // Also fires on a conversation's `pendingApprovals` changes (PENDING-
  // APPROVAL PERSISTENCE FIX) — a fresh 'ask' deferral, an approval/
  // rejection resolving one, and a `lastFailure` update must all reach
  // disk, not just whatever pendingApprovals happened to be true the last
  // time a message was appended.
  const autosaveSeenRef = useRef<Map<string, { messages: ManagerMessage[]; pendingApprovals: PendingApprovalAction[] }>>(new Map());
  const autosaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    for (const id of state.conversationOrder) {
      const conv = state.conversations[id];
      if (!conv || conv.messages.length === 0) continue;
      // Live stream paints 1x/frame — never persist a half-written draft
      // (and never hammer localStorage at 60Hz). The final replaceStreamDraft
      // drops isStreaming and this effect then saves normally.
      if (conv.messages.some((m) => m.isStreaming)) continue;
      const seen = autosaveSeenRef.current.get(id);
      if (seen && seen.messages === conv.messages && seen.pendingApprovals === conv.pendingApprovals) continue;
      autosaveSeenRef.current.set(id, { messages: conv.messages, pendingApprovals: conv.pendingApprovals });
      const existingTimer = autosaveTimersRef.current.get(id);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        saveManagerMessages(id, conv.messages, conv.pendingApprovals.map(toPersistedPendingApproval), conv.customTitle);
      }, 400);
      autosaveTimersRef.current.set(id, timer);
    }
  }, [state.conversations, state.conversationOrder, saveManagerMessages]);

  // Unmount safety: never leak a pending autosave timer past this
  // component's life (same "relevant for tests/hot-reload — a real app
  // instance normally lives for the whole session" rationale as the
  // auto-retry grace-period timers' own unmount-safety effect below). A
  // mount/unmount-only effect (empty deps) rather than folding this into
  // the debounce effect above: that effect's cleanup already runs before
  // EVERY re-run (not just unmount), so an unconditional "clear every
  // timer in the map" there would also wipe OTHER conversations' still-
  // pending debounces on each unrelated re-render, silently dropping their
  // autosave. This effect only ever fires its cleanup once, on real
  // unmount — exactly when every outstanding timer's React owner is gone
  // and `saveManagerMessages` (setSessions) must never fire again.
  useEffect(() => {
    return () => {
      for (const timer of autosaveTimersRef.current.values()) clearTimeout(timer);
      autosaveTimersRef.current.clear();
    };
  }, []);

  /**
   * Bumped (per conversation id) by newManagerConversation/loadManagerSession
   * — a conversation-turn boundary marker. sendManagerMessage captures its
   * conversation's own generation number at the start of a turn and checks
   * it again before every setState that appends to that conversation's
   * messages or flips its busy/phase, so a turn that was stopped because
   * that SAME conversation was reset/reloaded can never append its
   * "interrompu"/timeout bubble, nor its resolved actions, onto whatever
   * NEW conversation now lives under the same slot once its abort unwinds
   * asynchronously. Missing entries read as generation 0 (a conversation
   * that has never been reset yet) via `?? 0` at every read site — never
   * explicitly seeded on open.
   */
  const managerGenerationRef = useRef<Map<string, number>>(new Map());

  // Ref-escape-hatch for approveMission (declared further below via
  // useCallback, AFTER updateMission/applyRunUpdate) — referencing it
  // directly from those two earlier closures would be a temporal-dead-zone
  // error at hook-declaration time (their useCallback bodies are created
  // during THIS render, before approveMission's own `const` initializes).
  // Synced by the effect right after approveMission's declaration below —
  // same ref-escape-hatch shape as stateRef above, just for a function
  // instead of state.
  const approveMissionRef = useRef<typeof approveMission | null>(null);

  /**
   * W-MODES: best-effort auto-merge trigger — called from BOTH of this
   * store's mission-terminal choke points (updateMission and
   * applyRunUpdate below) every time either observes a mission now sitting
   * in 'review', regardless of whether that's the INITIAL status flip (no
   * judgeVerdict yet — evaluateAutoMerge simply won't find the green path
   * or full_auto's fallback yet, see approveGate.ts) or a LATER patch to a
   * still-'review' mission (the verdict landing, a proof getting attached,
   * a contract.budgetCapUsd raise) — whichever patch is the one that
   * actually makes the mission eligible fires the merge.
   *
   * Fires at most once per mission: approveMission itself no-ops when
   * `mission.status !== 'review'` (see its own doc comment), so once THIS
   * call successfully merges a mission (flipping it to 'done'), every
   * later call here for the same mission id is a harmless no-op.
   *
   * Deliberately never rescans the whole mission list and never reacts to
   * an approval-MODE change by itself (no subscribeApprovalModes listener
   * here) — a mission already parked in 'review' before a mode flip to
   * auto is only ever auto-merged by a LATER real patch to THAT mission,
   * never retroactively by the flip alone (see approvalMode.ts's
   * setApprovalMode doc comment for the full rationale).
   */
  const triggerAutoMergeIfEligible = useCallback((mission: Mission) => {
    if (mission.status !== 'review') return;
    // Synchronous fast path: when NOTHING has ever set a non-manual mode
    // anywhere (the overwhelming common case — this feature untouched),
    // every project's effective mode is guaranteed 'manual' regardless of
    // which project this mission belongs to, so the async
    // resolveProjectRoot()/getApprovalMode(projectId) round trip below can
    // be skipped entirely. This keeps 'manual' mode a REAL zero-behavior-
    // change no-op — no extra background `get_project_root` invoke ever
    // fires for a mission reaching 'review' unless approval modes have
    // actually been configured at least once.
    const config = getApprovalModeConfig();
    if (config.defaultMode === 'manual' && Object.keys(config.perProject).length === 0) return;
    // Correctness fix: resolve THIS MISSION's OWN project root (never the
    // currently ACTIVE one — see resolveMissionRepoPath's doc comment). Both
    // the approval-MODE lookup below (a project's configured mode) and the
    // actual merge target must agree on the SAME project this mission
    // really belongs to.
    resolveMissionRepoPath(mission.id).then(async (root) => {
      const projectId = projectIdFromRoot(root);
      const mode = getApprovalMode(projectId);
      if (mode === 'manual') return;
      // Section 4 gate (spec §4 "Cycle de vie complet d'un régime récurrent"
      // — état 'Essai'): a loop iteration whose PARENT regime is still in
      // 'trial' must always wait for an explicit human decision, regardless
      // of the project's approval mode — that is the entire point of trial
      // mode ("chaque exécution passe sous les yeux de l'utilisateur").
      // Fails OPEN (falls through to the normal auto-merge check) on a
      // lookup error — a transient read glitch must never permanently stall
      // a real merge; genuine 'trial' state is re-read fresh on every call
      // here, so a stale skip never lingers past the next real patch.
      if (mission.loopParentId) {
        const parentLoop = await getLoop(root, mission.loopParentId).catch(() => null);
        if (parentLoop?.loopConfig.regimeState === 'trial') return;
      }
      const decision = evaluateAutoMerge(mission, mode);
      if (!decision.eligible) return;
      approveMissionRef.current?.(mission.id, root, { force: decision.useForce, actor: 'auto', mode })
        .catch(() => {
          // Best-effort: a failed/blocked auto-merge attempt must not throw
          // unhandled — the mission simply stays in 'review' for a human,
          // same fallback every other auto/background action in this file
          // already degrades to.
        });
    }).catch(() => { /* best-effort */ });
  }, []);

  // Stop signals: map of missionId -> ref to stopFlag. `controller` (money
  // incident, 2026-08-14 — "Stoppe tout" kept billing after being clicked)
  // is the REAL mid-stream cancellation channel: `stopped` alone is only
  // polled BETWEEN turns (managedAgent.ts's loop top), so a turn already
  // streaming from the managed/Pro ai-proxy or a BYOK provider keeps running
  // — and billing — to completion regardless of it. Aborting `controller`
  // cancels that in-flight fetch immediately (see PlanAndActManagedOpts.signal
  // and RunOptions.signal's doc comments for the full wiring). Every site
  // that flips `.stopped = true` below must also call `.controller.abort()`.
  const stopFlags = useRef<Map<string, { stopped: boolean; controller: AbortController }>>(new Map());
  // Pause signals — same cross-closure mutable-cell pattern as stopFlags
  // (see planAndActManaged's pauseSignal poll in managedAgent.ts).
  const pauseFlags = useRef<Map<string, { paused: boolean }>>(new Map());
  // Intervene queues — one mutable cell per mission holding an (immutably
  // replaced, never .push()'d) array of pending instruction strings; drained
  // by managedAgent.planAndActManaged between ReAct steps.
  const interveneQueues = useRef<Map<string, { items: string[] }>>(new Map());

  // LazyReasoningBlocks — second safety net: listen for 'lazyreasoning:stuck'
  // bus events and inject cross-project brain search results into the stuck
  // mission's intervene queue. The agent receives it at the next step boundary
  // via drainIntervenes — same canal as user interventions, no new path.
  useEffect(() => {
    const cleanup = createManagerInterventionListener((missionId, text) => {
      const queue = interveneQueues.current.get(missionId);
      if (queue) {
        queue.items = [...queue.items, text];
      }
    });
    return cleanup;
  }, []);

  // Debounce timer for persistence saves
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last mission-object-per-id snapshot the debounce-save effect below has
  // journaled via mission.updated — lets it diff by reference and only
  // emit for missions that actually changed since the previous cycle (see
  // that effect).
  const lastJournaledMissionsRef = useRef<Map<string, Mission>>(new Map());
  /**
   * STOP-ON-DELETE fix (2026-08-05, real prod incident — M25: deleting a
   * RUNNING mission tombstoned the journal row, but the still-live runtime
   * kept emitting progress, silently overwriting that tombstone the moment
   * the next snapshot landed — the mission "resurrected" on the board).
   * Every id deleteMission has ever tombstoned this session, so the
   * debounce-save effect below can refuse to ever re-emit a snapshot for it
   * — belt-and-suspenders alongside the real runtime-stop fix in
   * deleteMission itself (stopFlag + killAgentRun, mirroring stopMission),
   * which should make a later re-emission impossible in the first place.
   * Grows for the life of the session; never cleared — a deleted mission id
   * is never legitimately reused.
   */
  const tombstonedMissionIdsRef = useRef<Set<string>>(new Set());
  /** The boot-load effect below calls `updateMission` from inside a runner
   *  re-attach poll callback that only ever fires asynchronously, well after
   *  this render has finished — but `updateMission` itself isn't declared
   *  until further down this file. Same "declare early, sync via a later
   *  effect" convention as `runFleetHygieneSweepRef`/`archiveMissionRef`
   *  below: a ref, synced once `updateMission` exists, so the poll callback
   *  always calls through to the LATEST version instead of closing over a
   *  stale one. Starts as a no-op so a poll that resolves before the sync
   *  effect runs (never happens in practice — boot missions can't resolve
   *  faster than the same render pass — but keep the invariant honest)
   *  never throws. */
  const updateMissionRef = useRef<(update: MissionUpdate) => void>(() => {});
  /**
   * Boot-time queued-mission relaunch (2026-08-02 fix — "queued missions
   * never survive a restart" incident): synced once `relaunchQueuedMission`
   * exists (same forward-reference-via-ref convention as `updateMissionRef`
   * above — the boot-load effect below runs BEFORE that callback's own
   * declaration further down this file, which itself depends on
   * `applyRunUpdate`/`updateMission`). See `relaunchQueuedMission`'s own doc
   * comment for the full rationale. Starts as a no-op for the same
   * never-fires-before-sync reason `updateMissionRef` does.
   */
  const relaunchQueuedMissionRef = useRef<(mission: Mission, repoPath: string, projectId: string) => void>(
    () => {},
  );

  // ── Load persisted missions on mount ─────────────────────────────
  //
  // Boot order (T0.5 — the journal is the source of truth for missions):
  //   1. Try the journal's materialized missions_current projection first
  //      (loadMissionsFromJournal) — every mission mutation is journaled
  //      going forward (see the debounce-save effect's mission.updated
  //      emission below), so this is the durable source once a project has
  //      been through it at least once.
  //   2. If the journal has nothing for this project, run the one-shot
  //      legacy migration (migrateProjectToJournal) — internally a no-op
  //      once `.lazy/journal-migrated` exists, so calling it unconditionally
  //      whenever step 1 comes back empty is always safe/cheap — then retry
  //      step 1 once.
  //   3. Final fallback: the legacy missions.json load below, UNCHANGED
  //      from before this task. Gated on isTauri() — the journal is a
  //      Rust/SQLite concept with no equivalent in web/mock mode, so a
  //      non-Tauri session skips straight to this step, exactly as it
  //      always has.
  //
  // Recovery differs by source: a mission list loaded FROM THE JOURNAL goes
  // through applyReplayRecovery (T0.5, spec §4.3) — 'running'/
  // 'review-with-still-live-flags' missions are marked 'failed' via a
  // recorded mission.failed(reason:'interrupted') event, 'queued' missions
  // are left alone for a future scheduler to relaunch. The legacy
  // missions.json fallback below keeps its OWN pre-existing recovery pass
  // (force-fail running OR queued) completely unmodified.
  useEffect(() => {
    const platform = getPlatform();
    resolveProjectRoot().then(async (root) => {
      // Memory-pressure hardening: after several crashes in a row, the app
      // boots into safe_mode (see src/lib/startupRecovery.ts) and background
      // services — including this durable-queue recovery bookkeeping —
      // start delayed. Skipping recoverStaleMissions/markStaleQueuedMissions
      // here means no queue entry gets flipped to 'paused'/'stale' this
      // boot, i.e. nothing is prepared for even a manual resume yet; a
      // mission simply keeps whatever status it already had on disk until
      // the user restarts normally (or the SafeModeBanner's "Restart now").
      // getStartupRecoveryState() is a cached, session-wide promise (shared
      // with StartupRecoveryCheck.tsx's own call), so this await is
      // effectively free after the very first caller resolves it.
      // Note: this only gates the DURABLE QUEUE FILE's own bookkeeping —
      // the journal/legacy recovery pass below (which marks a truly stuck
      // 'running' mission as failed/interrupted so the UI is honest about
      // it) is unrelated and always runs.
      const recovery = await getStartupRecoveryState();
      if (recovery.state !== 'safe_mode') {
        // Recover stale missions from the durable queue — unrelated to the
        // missions.json/journal source-of-truth switch below.
        recoverStaleMissions(root).catch(() => {
          // Queue recovery is best-effort
        });
        // R4b fix (ghost queue runs): mirror the SAME staleness gate into the
        // durable queue file (missionQueue.ts's dequeue() reads it), alongside
        // the read-model flag applied to `recovered`/`merged` below (see
        // applyQueueStaleness) — best-effort, same as recoverStaleMissions.
        markStaleQueuedMissions(root).catch(() => {
          // Queue staleness marking is best-effort
        });
        // Self-heal fix (2026-08-02, "mission-queue.json never purges"
        // incident): removes durable-queue entries that have been `stale`
        // for a week+ — see purgeAncientStaleQueuedMissions' own doc
        // comment for why this is safe (dequeue() has zero production
        // readers, so a stale entry blocks nothing; this only drops the
        // queue FILE's own dead-weight row, never the mission's real
        // history). Same best-effort fire-and-forget as the two calls above.
        purgeAncientStaleQueuedMissions(root).catch(() => {
          // Queue purge is best-effort
        });
      }

      const projectId = projectIdFromRoot(root);

      /**
       * Retroactive fix (2026-08-02, phase 2 — see approveGate.ts's
       * planLegacyHumanApproveMigration doc comment for the full rationale
       * and its documented humanApprove-provenance compromise): every
       * mission created before 1acd6bb carries a baked-in
       * `contract.gates.humanApprove: true` that permanently opts it out of
       * auto-merge, regardless of this project's own auto_green/full_auto
       * mode — 1acd6bb only fixed what NEW missions get. Runs once per boot
       * load (both the journal path and the legacy missions.json fallback
       * call this with their own freshly-loaded `recovered` list), only
       * ever touches missions this exact load just restored, and only ever
       * flips `humanApprove` to `false` for a mission that
       * planLegacyHumanApproveMigration confirms clears the STRICT green
       * path — every other stuck mission is left exactly as pending as it
       * was (never a silent security-decision override, matches
       * evaluateAutoMerge's own 'manual'-mode no-op).
       */
      const runLegacyHumanApproveMigration = (recovered: Mission[]) => {
        const candidates = recovered.filter(
          (m): m is Mission & { contract: NonNullable<Mission['contract']> } =>
            m.status === 'review' && m.contract?.gates?.humanApprove === true,
        );
        if (candidates.length === 0) return;
        const mode = getApprovalMode(projectId);
        const plan = planLegacyHumanApproveMigration(candidates, mode);
        for (const { missionId, eligible } of plan) {
          if (!eligible) continue;
          const mission = candidates.find((m) => m.id === missionId);
          if (!mission) continue;
          const patchedContract = { ...mission.contract, gates: { ...mission.contract.gates, humanApprove: false } };
          updateMissionRef.current({ id: missionId, patch: { contract: patchedContract } });
          triggerAutoMergeIfEligible({ ...mission, contract: patchedContract });
        }
      };

      if (isTauri()) {
        let fromJournal = await loadMissionsFromJournal(projectId);
        if (fromJournal === null) {
          try {
            await migrateProjectToJournal(root);
          } catch {
            // Migration is best-effort — the legacy fallback below still
            // runs even when it fails (e.g. journal invokes unavailable).
          }
          fromJournal = await loadMissionsFromJournal(projectId);
        }

        if (fromJournal !== null) {
          let liveMissionIds = new Set<string>();
          try {
            const live = await invoke<string[]>('agent_run_live_ids');
            liveMissionIds = new Set(live);
          } catch {
            // Best-effort — missing command / non-Tauri falls back to
            // historical "fail every interrupted running mission" behaviour.
          }
          const { missions: replayRecovered, interruptedIds } = applyReplayRecovery(
            fromJournal,
            t,
            { liveMissionIds },
          );
          // R4b fix: applyReplayRecovery deliberately leaves 'queued'
          // missions untouched (see isInterruptedMission's doc comment) —
          // flag the ones that have been sitting for 24h+ as queueStale so
          // nothing in the UI treats an ancient queued card the same as a
          // freshly-created one.
          const staleFlagged = applyQueueStaleness(replayRecovered, Date.now());
          // Never-silent fix (2026-08-02): a queueStale queued mission is
          // deliberately NOT auto-relaunched below (R4b's established
          // convention: 24h+ stale requires an explicit user "Relancer",
          // never an automatic resume) — but leaving statusReason empty on
          // a mission that will now sit there indefinitely is exactly the
          // silent-zombie pattern this whole fix closes. Additive only
          // (never overwrites a reason the mission already carries) —
          // applyQueueStaleness's own contract (status/history otherwise
          // untouched) is unaffected, statusReason is neither.
          const recovered = staleFlagged.map((m) =>
            m.status === 'queued' && m.queueStale && !m.statusReason
              ? { ...m, statusReason: t('agents.mission.queueStaleReason') }
              : m,
          );

          // Id-collision hardening — same ratchet the legacy path below
          // performs; see nextMissionId's doc comment for the full story.
          for (const m of recovered) {
            missionCounter = Math.max(missionCounter, missionIdNumber(m.id));
          }

          // Record each replay-recovered mission as real journal history —
          // this is what distinguishes T0.5's recovery from the legacy
          // pass's silent mutation (see applyReplayRecovery's doc comment).
          for (const missionId of interruptedIds) {
            emitBuffered({
              type: 'mission.failed',
              tsMs: Date.now(),
              projectId,
              missionId,
              actor: 'system',
              payload: { reason: 'interrupted' },
            });
          }

          // BOT-RUN ZOMBIE PRUNE (restart lockout root-cause): every LazyBot
          // run whose mission this boot recovery did NOT leave live is a
          // zombie — the restart killed the runMission chain that would have
          // called finishBotRun, so .lazy/bot-runtime.json still lists it
          // 'running' (sometimes since a PREVIOUS boot, when the mission was
          // already force-failed and no interrupted-id list mentions it
          // again). restoreBotRuntime rehydrates such runs on every boot and
          // the bot can never launch ("already has N concurrent run(s)").
          // Live = recovered missions the pass left running/queued (native
          // runner reattaches + queued relaunch candidates) UNION any
          // mission the user managed to launch during this boot's async load
          // (mission-vanish race — those live in state.missions already, not
          // in `recovered`). Idempotent + order-independent (cleans in-memory
          // AND on-disk runs, before or after restoreBotRuntime),
          // best-effort/fire-and-forget.
          const liveBotMissionIds = new Set<string>();
          for (const m of recovered) {
            if (m.status === 'running' || m.status === 'queued') liveBotMissionIds.add(m.id);
          }
          for (const m of stateRef.current.missions) {
            if (m.status === 'running' || m.status === 'queued') liveBotMissionIds.add(m.id);
          }
          void pruneBotRunsNotLive(liveBotMissionIds);

          // RE-FLAG LOOP fix (live QA 2026-09-02 — M82/M93/M94 announced as
          // "failed (interrupted)" by a manager wakeup on EVERY boot, project
          // switch and provider remount; M93 collected 10 pairs of
          // mission.failed in 50 minutes). The mission.failed above is
          // status-only: journal.rs's apply_mission_projection updates the
          // row's `status` column but leaves `data` — the snapshot
          // loadMissionsFromJournal reads back — untouched, still
          // `status: 'running'`. And seedJournaledMissions just below
          // deliberately stops the debounce-save effect from re-journaling
          // anything this load restored — which silently included these
          // flips. Journal the recovered snapshot explicitly (same
          // full-snapshot mission.updated shape markJournalMissionInterrupted
          // and the debounce-save use) so the projection finally agrees with
          // what the user sees and the next load finds a settled mission.
          // Covers every mission applyReplayRecovery actually changed —
          // interrupted→failed AND the review-with-salvageable-deliverable
          // restore (live flags cleared), which was likewise re-derived on
          // every boot. Per-mission projectId: same repoRoot-first rule as
          // the debounce-save (A — repoRoot drift fix).
          const loadedById = new Map(fromJournal.map((m) => [m.id, m] as const));
          const recoveryChangedIds = new Set(
            replayRecovered.filter((m) => loadedById.get(m.id) !== m).map((m) => m.id),
          );
          for (const mission of recovered) {
            if (!recoveryChangedIds.has(mission.id)) continue;
            emitBuffered({
              type: 'mission.updated',
              tsMs: Date.now(),
              projectId: projectIdFromRoot(mission.repoRoot ?? root),
              missionId: mission.id,
              actor: 'system',
              payload: { mission },
            });
          }

          // W-GUARD boot-truth reconcile: drop any durable queue entry
          // (mission-queue.json) whose mission has already left the
          // queue-relevant lifecycle (review/done/failed/cancelled) — see
          // reconcileQueueAgainstMissions' doc comment for the real-world
          // ghost-entry bug this closes. Best-effort, same as
          // recoverStaleMissions/markStaleQueuedMissions above.
          const droppedQueueEntries = await reconcileQueueAgainstMissions(root, recovered).catch(() => []);
          for (const dropped of droppedQueueEntries) {
            emitBuffered({
              type: 'mission.queue.reconciled',
              tsMs: Date.now(),
              projectId,
              missionId: dropped.missionId,
              actor: 'system',
              payload: { missionStatus: dropped.missionStatus },
            });
          }

          // BOOT RE-STAMP fix — see seedJournaledMissions' own doc comment:
          // mark every mission this load just restored as already-journaled
          // BEFORE the debounce-save effect's next cycle can see it, so that
          // cycle only ever emits mission.updated for a REAL later change.
          seedJournaledMissions(lastJournaledMissionsRef, recovered);

          setState((prev) => {
            const merged = recovered;
            const mergedIds = new Set(merged.map((m) => m.id));
            // Union-preserving merge — see the mission-vanish race fix doc
            // comment on the legacy path below; the same race applies here
            // (addMission can run while this boot load is in flight).
            const inFlight = prev.missions.filter((m) => !mergedIds.has(m.id));
            return {
              ...prev,
              missions: pruneMissions([...merged, ...inFlight]),
            };
          });

          // Legacy humanApprove migration — see runLegacyHumanApproveMigration's
          // own doc comment above. Fires against this exact freshly-loaded
          // `recovered` list, after the setState above has committed it, so
          // triggerAutoMergeIfEligible's own downstream approveMission call
          // finds the mission already in `state.missions`.
          runLegacyHumanApproveMigration(recovered);

          // Boot-time queued-mission relaunch (2026-08-02 root-cause fix —
          // real incident: three live projects with missions queued "for
          // hours across several app restarts", statusReason empty,
          // nothing ever progressing). scheduler.ts's pool/queue state is a
          // fresh, empty, module-level singleton every boot (see that
          // file's own header) and schedulerDispatch is otherwise only
          // ever called at the MOMENT a mission is first created
          // (addMission) or a loop iteration fires (loop scheduler below)
          // — NEVER again for a mission that was already 'queued' when the
          // app last closed. Without this, such a mission sits in
          // state.missions forever: not running, not failed, no scheduler
          // entry, no statusReason — a silent zombie surviving every
          // subsequent restart. `queueStale` (24h+, flagged above) is the
          // one deliberate exception — see the statusReason fix just above
          // for why that path is never silent either.
          for (const m of recovered) {
            if (m.status !== 'queued' || m.queueStale) continue;
            relaunchQueuedMissionRef.current(m, root, projectId);
          }

          // P6.c — Runner re-attach: if lazy-runnerd is active, check for
          // missions it owns that aren't in our journal-loaded list. Backfill
          // any missing missions and poll for status updates. Best-effort,
          // fire-and-forget — never blocks the boot sequence.
          if (isTauri()) {
            void reattachToRunner(recovered.map((m) => m.id))
              .then((result) => {
                if (result.runnerActive && result.liveMissions.length > 0) {
                  // Merge any runner-owned missions not already in our list
                  setState((prev) => {
                    const existingIds = new Set(prev.missions.map((m) => m.id));
                    const newMissions = result.liveMissions
                      .filter((m) => !existingIds.has(m.id))
                      .map((m) => ({
                        id: m.id,
                        title: m.id,
                        status: 'running' as Mission['status'],
                        model: '',
                        worktree: '',
                        progress: 0,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                        planSteps: [],
                        actionTimeline: [],
                      } as Mission));
                    if (newMissions.length === 0) return prev;
                    return {
                      ...prev,
                      missions: pruneMissions([...prev.missions, ...newMissions]),
                    };
                  });
                  // Start polling for each live runner mission
                  for (const m of result.liveMissions) {
                    pollRunnerMission(m.id, (stillRunning) => {
                      if (!stillRunning) {
                        updateMissionRef.current({ id: m.id, patch: { status: 'done' } });
                      }
                    });
                  }
                }
              })
              .catch(() => {
                // Runner re-attach is best-effort
              });
          }
          return;
        }
      }

      // ── Final fallback: legacy missions.json load ──────────────────
      //
      // #11 fix: missions persisted as 'running' or 'queued' represent in-flight work
      // that was interrupted by an app crash or restart. The agent process (claude CLI)
      // is no longer alive, so these missions will never transition on their own —
      // they remain permanently stuck. On load, reset all of them to 'failed' with a
      // note so the user knows to retry. This recovery pass only ever inspects
      // `persisted` (the on-disk snapshot from BEFORE this app instance started), so
      // it can never misclassify a mission created in the current session — that
      // mission simply isn't part of `persisted` at all.
      //
      // CORRECTED (previously false) — mission-vanish race fix: resolveProjectRoot()
      // and platform.missions.load() are async and can take several seconds (a real
      // Tauri invoke round-trip), NOT "the same JS turn" as this comment used to
      // claim. The user CAN call addMission() during that window — a mission it
      // creates lives only in `prev.missions` until the setState below runs, so it
      // must be preserved explicitly (see the union-merge below) rather than assumed
      // not to exist. Real-app QA repro: submit a mission ~5s after boot (still
      // racing) -> it vanishes with zero trace; ~20s after boot (load already
      // settled) -> fine.
      //
      // Reached in web/mock mode (no journal to try at all) or when a real
      // Tauri session's journal has nothing to offer even after a migration
      // attempt (brand new project with no missions.json either, or the
      // journal itself unavailable).
      return platform.missions.load(root).then((raw) => {
        const persisted = parseMissionsJson(raw);
        if (persisted.length === 0) return;

        // Recovery pass: any persisted running/queued mission is stale — the
        // agent process died with the previous app instance.
        const recovered = persisted.map((m): Mission => {
          if (m.status !== 'running' && m.status !== 'queued') return m;
          return {
            ...m,
            status: 'failed',
            // Item 4 fix — see applyReplayRecovery's identical fix above
            // for the full rationale (same journal-less legacy fallback,
            // same missing statusReason bug, same honest-only-what-we-know
            // reasoning: an app restart interrupted this mission, nothing
            // more specific is knowable here).
            statusReason: t('agents.recoveredOnRestart'),
            liveAction: undefined,
            actionTimeline: [
              ...(m.actionTimeline ?? []).map((e) => ({ ...e, isLive: false })),
              {
                time: new Date().toLocaleTimeString(),
                text: t('agents.recoveredOnRestart'),
                isLive: false,
              },
            ],
          };
        });

        // Bot-run zombie prune — legacy-path twin of the journal path's
        // pruneBotRunsNotLive call above (same restart lockout root cause:
        // the dead process never called finishBotRun, so its run is still
        // 'running' in .lazy/bot-runtime.json). This fallback force-fails
        // every running/queued mission, so recovered holds nothing live —
        // the live set only ever contains a mission the user managed to
        // launch during this boot's async load (mission-vanish race).
        const legacyLiveBotMissionIds = new Set<string>();
        for (const m of recovered) {
          if (m.status === 'running' || m.status === 'queued') legacyLiveBotMissionIds.add(m.id);
        }
        for (const m of stateRef.current.missions) {
          if (m.status === 'running' || m.status === 'queued') legacyLiveBotMissionIds.add(m.id);
        }
        void pruneBotRunsNotLive(legacyLiveBotMissionIds);

        // Id-collision hardening (companion to the mission-vanish fix above):
        // ratchet the counter past whatever this session's persisted data
        // already occupies, BEFORE any mission minted after this point can run
        // — see nextMissionId's doc comment for the full collision story.
        for (const m of recovered) {
          missionCounter = Math.max(missionCounter, missionIdNumber(m.id));
        }

        // W-GUARD boot-truth reconcile — same fix as the journal path above,
        // for the legacy missions.json fallback. Fire-and-forget, same
        // best-effort idiom as recoverStaleMissions/markStaleQueuedMissions.
        reconcileQueueAgainstMissions(root, recovered).then((dropped) => {
          for (const entry of dropped) {
            emitBuffered({
              type: 'mission.queue.reconciled',
              tsMs: Date.now(),
              projectId: projectIdFromRoot(root),
              missionId: entry.missionId,
              actor: 'system',
              payload: { missionStatus: entry.missionStatus },
            });
          }
        }).catch(() => {
          // Queue reconcile is best-effort
        });

        // BOOT RE-STAMP fix — see seedJournaledMissions' own doc comment;
        // same seeding as the journal path above, for this legacy fallback.
        seedJournaledMissions(lastJournaledMissionsRef, recovered);

        setState((prev) => {
          const merged = recovered;
          const mergedIds = new Set(merged.map((m) => m.id));
          // Union-preserving merge (mission-vanish race fix): the old code
          // replaced prev.missions outright with `merged`, silently dropping
          // any mission added via addMission() while this load was still in
          // flight. Any mission present in prev.missions but absent (by id)
          // from `merged` is exactly such an in-flight addition and must be
          // kept — appended at the end, the same ordering convention
          // addMission/loop-children/retries already use for newly-added
          // missions elsewhere in this file.
          const inFlight = prev.missions.filter((m) => !mergedIds.has(m.id));
          return {
            ...prev,
            missions: pruneMissions([...merged, ...inFlight]),
          };
        });

        // Legacy humanApprove migration — same call as the journal path
        // above (see runLegacyHumanApproveMigration's own doc comment),
        // for this legacy missions.json fallback's own `recovered` list.
        runLegacyHumanApproveMigration(recovered);
      });
    }).catch(() => {
      // Persistence unavailable — continue with seed data
    });
  }, [t]);

  // ── Cross-project zombie sweep (B — 2026-08-04 boot fix) ─────────────
  //
  // applyReplayRecovery above only ever recovers the ACTIVE project's own
  // `fromJournal` list — a mission stuck 'running'/'queued' in a DIFFERENT
  // project's journal (one that never happens to be the active one at any
  // later boot) is invisible to that pass entirely and stays frozen
  // forever (real prod incident: mission M9, created before a crash,
  // stayed "running 26%" across every subsequent boot because its project
  // was never the one active at boot time). Runs ONCE per app start,
  // independently of which project ends up active, via a direct
  // cross-project `journal_missions_current` read (no project filter —
  // same precedent as fleetMissions.ts's own polling call: there is no
  // single project to scope a cross-project sweep to).
  //
  // Deliberately narrow: only a row whose id is NOT present in THIS
  // session's `state.missions` gets swept — INCLUDING a row that belongs to
  // the ACTIVE project (correction, 2026-08-04: an earlier version of this
  // sweep excluded the active project on the assumption applyReplayRecovery
  // above always covers it — false: that pass only ever recovers what
  // `loadMissionsFromJournal` actually returned into ITS OWN local list;
  // a row can be 'running'/'queued' in the journal while genuinely absent
  // from state.missions for the SAME reasons delete_mission/archive_mission's
  // own B1 fix cares about — evicted, a stale slice, or simply never loaded
  // this session — leaving it uncovered by BOTH passes. `mission_id` absent
  // from `state.missions` is the sufficient and safe criterion on its own).
  // Re-emits a FULL snapshot patch (markJournalMissionInterrupted — see its
  // own doc comment for why a full snapshot is required, not a status-only
  // event) with the SAME `agents.recoveredOnRestart` reason every other
  // restart-interruption path already uses, and the row's OWN real
  // project_id — never the active project's (same rule as
  // tombstoneJournalMission's own).
  //
  // RACE NOTE: this effect is declared (and therefore fires) AFTER the boot
  // effect above, but both run their real async work independently — this
  // sweep does not await the boot effect's own completion. To never mark a
  // mission `applyReplayRecovery` is CONCURRENTLY restoring into
  // state.missions as a zombie, liveness is re-checked individually, right
  // before each emit (not just once via a Set computed up front) — the
  // narrowest possible window, immediately before the irreversible write.
  //
  // Best-effort / fire-and-forget, never blocks boot or throws into the
  // UI. Deliberately does NOT rehydrate these missions into state.missions
  // — that would require per-project scoping this single-project store
  // cannot safely provide without risking a foreign project's mission
  // leaking into the active project's board (the exact F4 misattribution
  // fleetMissions.ts's own doc comment documents for the read side of this
  // same problem). They become visible/honest via the journal projection
  // (Cockpit/useFleetMissions/canvas) the moment the user opens that
  // project, and actionable via a manual retry from there. Auto-retry
  // eligibility for a re-stamped zombie (mirroring the existing boot-time
  // auto-retry effect's `agents.recoveredOnRestart` + `humanApprove: false`
  // gate) is a deliberate, documented follow-up — NOT attempted here, since
  // safely reconstructing+reinjecting a live Mission from a foreign
  // project's row needs the same per-project scoping this sweep
  // intentionally avoids.
  useEffect(() => {
    if (!isTauri()) return;
    // MODULE-level one-shot guard (sweepRanThisBoot's own doc comment) —
    // checked AND set synchronously, before any await, so two effects
    // firing back-to-back on a rapid remount can never both pass this
    // check before either has set it.
    if (sweepRanThisBoot) return;
    sweepRanThisBoot = true;
    let cancelled = false;
    (async () => {
      let rows: JournalMissionRow[];
      try {
        rows = await invoke<JournalMissionRow[]>('journal_missions_current');
      } catch {
        return; // best-effort — a read failure here must never block boot
      }
      if (cancelled) return;
      const nowMs = Date.now();
      const candidates = rows.filter(
        (r) =>
          (r.status === 'running' || r.status === 'queued') &&
          // AGE FLOOR (real prod incident 2026-08-05: M18/M19, launched
          // ~1 minute earlier, re-stamped "failed" at progress 0) — a row
          // updated within the last ZOMBIE_MIN_AGE_MS is NEVER a zombie
          // candidate, regardless of what state.missions happens to show
          // at this exact instant (a brand-new mission's own addMission
          // may simply not have committed to state yet).
          nowMs - r.updated_ms > ZOMBIE_MIN_AGE_MS,
      );
      for (const row of candidates) {
        // Re-checked individually, right before this row's own emit — see
        // the RACE NOTE above for why a Set computed once up front is not
        // late enough to safely skip a mission applyReplayRecovery is
        // concurrently restoring.
        if (cancelled) return;
        if (stateRef.current.missions.some((m) => m.id === row.mission_id)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.data);
        } catch {
          continue; // one corrupt row must never break the sweep
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
        const data = parsed as Record<string, unknown>;
        // Malformed-row fix (2026-08-05, real rows M3-testeur/M4-testeur —
        // QA-script debris whose `data` never carried a real Mission
        // snapshot, just a stray `{missionId: "..."}` shape with no
        // `title`/`status`): re-stamping this as `status: 'failed'` via
        // markJournalMissionInterrupted below used to produce a permanent,
        // garbled zombie card (no title, no model — nothing a human could
        // act on) that every later boot would re-discover as still
        // 'running'/'queued' and re-fail again, forever. A row with no real
        // `title` was never a genuine interrupted mission to recover in the
        // first place — tombstone it (archived: true, the same read-model
        // flag every real consumer already filters out — reconciler.ts/
        // canvasDigest.ts/fleetHygiene.ts, see tombstoneJournalMission's own
        // doc comment) so it quietly disappears from the canvas instead of
        // resurrecting itself as an unusable 'failed' card on every boot.
        if (typeof data.title !== 'string' || data.title.trim() === '') {
          void tombstoneJournalMission(row.mission_id, row.project_id, data);
          continue;
        }
        void markJournalMissionInterrupted(
          row.mission_id,
          row.project_id,
          data,
          t('agents.recoveredOnRestart'),
        );
      }
    })().catch(() => {
      // Best-effort — a failure here must never block boot
    });
    return () => {
      cancelled = true;
    };
  }, [t]);

  // ── Periodic zombie re-stamp (THE SYSTEMIC BUG fix, 2026-08-06) ──────
  //
  // The one-shot sweep above runs exactly ONCE per real app boot
  // (sweepRanThisBoot) — a 'running'/'queued' row younger than
  // ZOMBIE_MIN_AGE_MS at that SINGLE instant is correctly skipped (the
  // M18/M19 anti-regression, ZOMBIE_MIN_AGE_MS's own doc comment) but is
  // NEVER re-evaluated again for the rest of the session: nothing else in
  // this file periodically re-checks a 'running'/'queued' row against
  // reality. Real, repeated founder-reported consequences of exactly this
  // gap: fleet concurrency slots eaten by ghosts, starving fresh queued
  // missions indefinitely; join nodes that can never fire because an
  // upstream row never leaves 'running'; archive_mission refusing a
  // non-terminal row that can never become anything else on its own; a
  // card honestly lying "running 85%" for hours. Only a manual
  // deleteMission ever actually cleared one.
  //
  // SAFE CRITERION: mere absence from `state.missions` (the one-shot
  // sweep's own check, still exactly right for its narrower one-time
  // boot-race concern) is not a strong enough signal for a RECURRING sweep
  // to keep trusting. This file already maintains the real ground truth of
  // "is any code in this page still driving this mission forward":
  // `stopFlags` (declared above) — the exact cross-closure registry every
  // launch path (relaunchQueuedMission, relaunchQueuedMissionInOpenProject,
  // retry/relaunch, loop-child launch, chain-child launch, addMission's own
  // launch-now path) inserts an entry into synchronously, at the same call
  // that flips a mission to 'running'/'queued', and the ONLY registry
  // stopMission/deleteMission themselves already trust to signal a real
  // in-flight run to stop. Entries are additive-only (never deleted — see
  // every `stopFlags.current.set(...)` call site above; only `.get()` ever
  // reads one back, to flip `.stopped`), so an id that DOES have an entry
  // is left alone here UNCONDITIONALLY, exactly like a provably-alive run —
  // this sweep only ever acts on a row whose id has NO entry at all.
  //
  // A candidate row is re-stamped only once ALL of:
  //   1. no `stopFlags.current` entry for its mission id;
  //   2. at least ZOMBIE_MIN_AGE_MS has passed since the row's own
  //      `updated_ms` (reused, not re-litigated — same floor, same
  //      rationale as the one-shot sweep above);
  //   3. this effect has itself been mounted for at least
  //      ZOMBIE_RESTAMP_BOOT_GRACE_MS (see that constant's own doc comment
  //      for the remount hazard this specifically guards against).
  //
  // Re-stamps via the SAME full-snapshot mechanism as every other
  // restart-interruption path in this file: for a row absent from
  // `state.missions`, `markJournalMissionInterrupted` (or
  // `tombstoneJournalMission` for a malformed, titleless row — the exact
  // same M3-testeur/M4-testeur edge case the one-shot sweep already guards,
  // see its own doc comment); for a row the ACTIVE project still holds in
  // `state.missions` (so the live UI, the RECONCILE_INTERVAL_MS
  // scheduler-slot reconcile, and any canvas join/chain readiness check all
  // keep reading it directly, never just the journal projection), a direct
  // `setState` patch instead — the exact same `status: 'failed'` +
  // `statusReason` + cleared `liveAction` + appended actionTimeline note
  // shape `applyReplayRecovery` already uses. The existing debounce-save
  // effect below then journals THAT change on its own very next cycle,
  // same as any other real edit, so this never double-writes the journal
  // for a mission also present in state.missions.
  //
  // FLEET CONCURRENCY (task 3 of this fix) — deliberately no separate code
  // here: the RECONCILE_INTERVAL_MS effect above already releases a
  // scheduler pool slot the moment the SAME `state.missions` entry it reads
  // stops being "genuinely running" (done/failed/cancelled, or simply
  // absent) — since re-stamping is exactly what flips that entry away from
  // 'running', a zombie's slot is freed automatically on that effect's own
  // next ~20s tick, with zero additional code. Any canvas join/chain-
  // readiness check reads that same `state.missions` status for the same
  // reason — both already "read effective status" for free once this
  // sweep starts correcting it.
  //
  // KNOWN LIMITATION (honest, not solved here): `updated_ms` is the only
  // "last activity" timestamp `journal_missions_current` exposes; if
  // something were to keep re-touching a truly-dead row's journal entry
  // without real progress, its age would never cross ZOMBIE_MIN_AGE_MS and
  // this sweep would keep skipping it — the registry check does not
  // compensate for that specific case, since both conditions are ANDed. No
  // evidence of this happening was found while implementing this fix;
  // flagged here rather than silently assumed away.
  useEffect(() => {
    if (!isTauri()) return;
    const mountedAtMs = Date.now();
    let cancelled = false;

    async function sweepTick(): Promise<void> {
      if (Date.now() - mountedAtMs < ZOMBIE_RESTAMP_BOOT_GRACE_MS) return;

      let rows: JournalMissionRow[];
      try {
        rows = await invoke<JournalMissionRow[]>('journal_missions_current');
      } catch {
        return; // best-effort — a read failure here must never disrupt the app
      }
      if (cancelled || !Array.isArray(rows)) return;

      const nowMs = Date.now();
      const candidates = rows.filter(
        (r) =>
          (r.status === 'running' || r.status === 'queued') &&
          nowMs - r.updated_ms > ZOMBIE_MIN_AGE_MS &&
          !stopFlags.current.has(r.mission_id),
      );
      for (const row of candidates) {
        if (cancelled) return;
        // Re-checked individually, right before this row's own write —
        // same narrowest-possible-window rationale as the one-shot sweep's
        // own RACE NOTE above.
        if (stopFlags.current.has(row.mission_id)) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(row.data);
        } catch {
          continue; // one corrupt row must never break the sweep
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
        const data = parsed as Record<string, unknown>;

        // 'queued'-with-startedAt only — an ORDINARY still-waiting queued
        // row (no startedAt yet) is not a zombie candidate at all: T1.1's
        // scheduler may still legitimately pick it up normally.
        if (row.status === 'queued' && !data.startedAt) continue;

        if (typeof data.title !== 'string' || data.title.trim() === '') {
          void tombstoneJournalMission(row.mission_id, row.project_id, data);
          continue;
        }

        const reason = t('agents.recoveredOnRestart');
        const liveMission = stateRef.current.missions.find((m) => m.id === row.mission_id);
        if (liveMission) {
          // Already moved on (e.g. the debounce-save effect just hasn't
          // journaled the terminal status yet) — nothing to correct.
          if (liveMission.status !== 'running' && liveMission.status !== 'queued') continue;
          setState((prev) => ({
            ...prev,
            missions: prev.missions.map((m): Mission => {
              if (m.id !== row.mission_id) return m;
              return {
                ...m,
                status: 'failed',
                statusReason: reason,
                liveAction: undefined,
                actionTimeline: [
                  ...(m.actionTimeline ?? []).map((e) => ({ ...e, isLive: false })),
                  { time: new Date().toLocaleTimeString(), text: reason, isLive: false },
                ],
              };
            }),
          }));
        } else {
          void markJournalMissionInterrupted(row.mission_id, row.project_id, data, reason);
        }
      }
    }

    // Outer .catch on every fire-and-forget call — same belt-and-braces
    // convention as the one-shot sweep's own IIFE above: sweepTick already
    // guards its own known failure modes internally, but a fire-and-forget
    // call with no attached handler is an unhandled-rejection risk for
    // anything unforeseen.
    void sweepTick().catch(() => {});
    const intervalId = setInterval(() => { void sweepTick().catch(() => {}); }, ZOMBIE_RESTAMP_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [t]);

  // ── Debounce-save user missions whenever state.missions changes ───
  //
  // missions.json stays a point-in-time EXPORT snapshot at the same 800ms
  // cadence as before (T0.5 — the journal is now the source of truth for
  // boot/recovery, see the effect above); this cycle ALSO journals one
  // mission.updated per mission that actually changed, so missions_current
  // stays in sync with every real edit, not just the lifecycle milestones
  // the dedicated emit call sites (addMission, approveMission, ...) cover.
  useEffect(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      const platform = getPlatform();
      const userMissions = state.missions;
      resolveProjectRoot().then((root) => {
        platform.missions.save(root, userMissions).catch(() => {
          // Non-fatal: persistence failure must not affect UI
        });

        // Journal: one mission.updated per mission that actually changed
        // since the last cycle — reference inequality is enough (every
        // mutation in this store replaces the mission object rather than
        // mutating it, see mergeMissionUpdate/updateMission above), so this
        // is a cheap real-change filter, not a deep-equal. Buffered: a
        // burst of changes across many missions in one cycle collapses
        // into a single invoke rather than N, same rationale as every
        // other emitBuffered call site in this file.
        //
        // PER-MISSION projectId (A — repoRoot drift fix, 2026-08-04 prod
        // incident): this used to hoist ONE `projectIdFromRoot(root)` (the
        // currently ACTIVE project) and stamp EVERY changed mission with
        // it, regardless of which project actually launched each one — a
        // mission belonging to a DIFFERENT project got silently re-owned
        // by the active project's journal rows the instant anything about
        // it changed. Each mission now resolves its OWN projectId from its
        // `repoRoot` (Mission.repoRoot's own doc comment, types.ts) — the
        // stable identity stamped once at creation by addMission — falling
        // back to the active `root` only for a legacy mission that
        // predates this field (unchanged behavior for those).
        const previouslyJournaled = lastJournaledMissionsRef.current;
        const nowJournaled = new Map<string, Mission>();
        for (const mission of userMissions) {
          // STOP-ON-DELETE fix — never re-emit a snapshot for a mission this
          // session already tombstoned (deleteMission), even if it somehow
          // still shows up in state.missions on this cycle — an untagged
          // snapshot here would silently overwrite the journal's
          // `archived: true` row the instant it lands, resurrecting a
          // mission the user explicitly deleted. See
          // tombstonedMissionIdsRef's own doc comment.
          if (tombstonedMissionIdsRef.current.has(mission.id)) continue;
          nowJournaled.set(mission.id, mission);
          if (previouslyJournaled.get(mission.id) === mission) continue;
          const missionProjectId = projectIdFromRoot(mission.repoRoot ?? root);
          emitBuffered({
            type: 'mission.updated',
            tsMs: Date.now(),
            projectId: missionProjectId,
            missionId: mission.id,
            actor: 'system',
            payload: { mission },
          });
        }
        lastJournaledMissionsRef.current = nowJournaled;
      }).catch(() => {
        // Non-fatal: persistence failure must not affect UI
      });
    }, 800);

    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [state.missions]);

  /** Immutable patch for a single mission. */
  const updateMission = useCallback((update: MissionUpdate) => {
    // Decide the terminal-transition toast from the latest known snapshot —
    // BEFORE calling setState — so the updater below stays pure (see
    // stateRef's doc comment above for why this matters).
    const prevMission = stateRef.current.missions.find((m) => m.id === update.id);
    // W-MODES: computed unconditionally (not just on a status CHANGE, see
    // below) — a patch that keeps the mission in 'review' while changing
    // some OTHER gated field (proofs attached, contract.budgetCapUsd
    // raised) can just as legitimately newly satisfy evaluateAutoMerge as
    // the initial status flip itself. Reused for onMissionTerminalSGR below
    // instead of recomputing it a second time.
    const mergedMission = prevMission ? mergeMissionUpdate(prevMission, update.patch) : undefined;
    const newStatus = update.patch.status;
    let pendingToast: { message: string; type: ToastType; duration: number } | null = null;
    if (prevMission && newStatus && prevMission.status !== newStatus) {
      const title = prevMission.title;
      if (newStatus === 'done') {
        pendingToast = { message: t('agents.notification.completed', { title }), type: 'success', duration: 5000 };
        void notifyMissionDone(prevMission.id, title, t);
      } else if (newStatus === 'review') {
        pendingToast = { message: t('agents.notification.review', { title }), type: 'info', duration: 5000 };
      } else if (newStatus === 'failed') {
        pendingToast = { message: t('agents.notification.failed', { title }), type: 'error', duration: 6000 };
        void notifyMissionFailed(prevMission.id, title, undefined, t);
      } else if (newStatus === 'cancelled') {
        pendingToast = { message: t('agents.notification.cancelled', { title }), type: 'warning', duration: 4000 };
      }
    }

    // Agent Canvas W3 (spec §7): one of this store's TWO mission-terminal
    // choke points — the other is applyRunUpdate below (runMission's own
    // streaming onUpdate callback, which bypasses this method entirely for
    // high-frequency non-terminal patches — see applyRunUpdate's doc
    // comment). This one covers every UI-ACTION-sourced terminal transition
    // that goes through the public updateMission API instead (e.g.
    // approveMission's merge flip to 'done', stopMission's flip to
    // 'cancelled' — chainEngine itself ignores 'cancelled', see its module
    // header). onMissionTerminalSGR is synchronous/fire-and-forget and never
    // throws, matching every other best-effort side effect in this method.
    if (prevMission && newStatus && prevMission.status !== newStatus) {
      onMissionTerminalSGR(mergedMission!);
      // W-CONTEST — registered ALONGSIDE chainEngine's hook above (same
      // choke point, never routed through it): checks whether this mission
      // is a contestant in any currently running best-of-N contest.
      onMissionTerminalForContest(mergedMission!);
      // Scheduler root-cause fix (2026-07-28): release this mission's
      // scheduler pool slot (scheduler.ts's releaseMissionSlot) THE MOMENT
      // it leaves 'running' — see this store's own applyRunUpdate below for
      // the fuller doc comment (choke point #2, the far more common path a
      // running agent's own status flip goes through). This choke point
      // covers the UI-action-sourced terminal transitions instead (e.g.
      // stopMission's flip to 'cancelled'). Idempotent: a no-op if the slot
      // was already released elsewhere.
      if (newStatus === 'review' || newStatus === 'done' || newStatus === 'failed' || newStatus === 'cancelled') {
        schedulerReleaseMissionSlot(update.id);
      }
      // P58 — fleet hygiene reacts at the SAME choke point loop-stop/
      // auto-merge already hook into, but only for a REAL terminal status
      // (never 'review' — a live pending-decision mission, never touched).
      if (newStatus === 'done' || newStatus === 'failed' || newStatus === 'cancelled') {
        missionTerminalAtRef.current.set(update.id, Date.now());
        runFleetHygieneSweepRef.current();
      }
      // Section 4 gate — a FAILED loop iteration demotes its parent regime
      // (see announceLoopFailureIfDemoted's own doc comment). Best-effort,
      // fire-and-forget: never blocks this synchronous choke point.
      if (newStatus === 'failed' && mergedMission?.loopParentId) {
        resolveProjectRoot()
          .then((root) => announceLoopFailureIfDemotedRef.current(root, mergedMission))
          .catch(() => { /* best-effort */ });
      }
    }

    setState(prev => ({
      ...prev,
      missions: prev.missions.map((m) =>
        m.id === update.id ? mergeMissionUpdate(m, update.patch) : m,
      ),
    }));

    // P0 sync: mirror the update into the global runtime registry so the
    // orchestrator's waitForMission sees terminal status transitions.
    updateMissionInRegistry({ id: update.id, patch: update.patch });

    if (pendingToast) toast(pendingToast.message, pendingToast.type, pendingToast.duration);

    // W-MODES: check auto-merge eligibility whenever this patch leaves the
    // mission sitting in 'review' — see triggerAutoMergeIfEligible's own
    // doc comment for why this checks on every such patch, not only a
    // fresh status transition into 'review'.
    if (mergedMission && mergedMission.status === 'review') {
      triggerAutoMergeIfEligible(mergedMission);
    }

    // Sync queue status when mission reaches a terminal state
    if (newStatus === 'review' || newStatus === 'done' || newStatus === 'failed' || newStatus === 'cancelled') {
      resolveProjectRoot().then((root) => {
        updateQueuedMission(root, update.id, {
          status: newStatus === 'done' || newStatus === 'review' ? 'completed' : 'failed',
          completedAt: new Date().toISOString(),
        }).catch(() => { /* best-effort */ });
      }).catch(() => { /* noop */ });

      // M12 dogfood fix (MAJEUR #6b — "Mergées aujourd'hui" KPI divergence):
      // this used to fire on 'review' TOO, so a mission naturally passing
      // through review -> [later] done double-counted itself in
      // usageHistory's local bucket (KpiGroup.tsx's cockpit "Mergées
      // aujourd'hui" tile) — 'review' means "the agent run finished, awaiting
      // evaluation/merge", NOT "merged"; only 'done' (always paired with
      // merged: true, see approveMission) is a real merge. This is also the
      // ONLY trigger that agrees with the generation-scoped, journal-derived
      // source of truth (projectReport.ts's buildProjectReport /
      // zoneDigest.ts's mergedTodayCount, which key off the mission.approved/
      // mission.completed journal events — each mission counted exactly once,
      // at its actual terminal event, never per intermediate status).
      if (newStatus === 'done') {
        try {
          recordMissionCompleted();
        } catch { /* best-effort — must not affect mission state */ }
        if (mergedMission && isOneTimeMission(mergedMission)) {
          scheduleAutoDismiss(mergedMission.id);
        }
      }
    }
  }, [t, toast, triggerAutoMergeIfEligible]);

  useEffect(() => {
    updateMissionRef.current = updateMission;
  }, [updateMission]);

  /**
   * Agent Canvas W3 (spec §7): the SHARED `onUpdate` callback every
   * `runMission(...)` call site below passes (addMission's launch,
   * retryMission's continuation, the loop scheduler's onFire, and the
   * manager executor's clone_mission) — previously each of those four call
   * sites duplicated an identical inline `setState(prev => ({ ...prev,
   * missions: prev.missions.map(...) }))` closure with no shared name, so
   * there was no single place to hook mission-terminal detection into (the
   * task this callback exists for). Byte-identical setState behavior to
   * the four closures it replaces; the only addition is the terminal-
   * transition -> chainEngine.onMissionTerminalSGR hook below — this is choke
   * point #2 (see updateMission's own doc comment above for choke point
   * #1, the UI-action-sourced path this one does NOT cover, since
   * runMission's streaming onUpdate never goes through updateMission —
   * that split is intentional/pre-existing: updateMission also does queue
   * sync + a toast + recordMissionCompleted on EVERY call, which would be
   * wasteful for the high-frequency non-terminal patches (progress %, live
   * action text) this callback receives many times per second per a
   * running mission).
   */
  const applyRunUpdate = useCallback((update: MissionUpdate) => {
    const prevMission = stateRef.current.missions.find((m) => m.id === update.id);

    // STALE-RUN IDEMPOTENCY fix (same family as 4464446's already-merged
    // approve_mission no-op, real user report "M5" — a mission reported
    // 'failed' in the fleet signal AFTER it had already merged cleanly
    // through a different, faster path): runMission's own promise for a
    // SLOWER, now-superseded run of the SAME mission id (a duplicate
    // dispatch, a relaunch that raced the original, or any other
    // concurrent runMission call for the same id) can still be streaming
    // onUpdate patches — including its own catch-driven status:'failed'
    // flip — long after the mission already reached its real terminal
    // state (done + merged) through the OTHER, faster run. Unlike
    // updateMission's own terminal-transition guards (addMission's/
    // relaunchQueuedMission's own `terminal.includes(...)` checks, which
    // only ever gate whether THEIR OWN catch handler re-flips a mission —
    // see those call sites' own doc comments), this choke point had no
    // protection at all: ANY patch, from ANY caller, always applied
    // unconditionally. A mission already done+merged is the most final
    // state Lazy has — refuse any patch here that would move its status
    // away from 'done', mirroring the exact idempotent-no-op shape
    // approveMissionInner already uses for the equivalent stale-approval
    // case (agentsStore.staleApprovalIdempotent.test.tsx). A patch that
    // leaves status alone (or redundantly repeats 'done') still applies
    // normally — this only blocks a REGRESSION away from the mission's
    // own already-reported success.
    if (
      prevMission &&
      prevMission.status === 'done' &&
      prevMission.merged === true &&
      update.patch.status !== undefined &&
      update.patch.status !== 'done'
    ) {
      console.warn(
        `[applyRunUpdate] ignored a stale status:'${update.patch.status}' patch for already-merged mission ${update.id} — a slower, superseded run is still emitting after the real merge`,
      );
      return;
    }

    // W-MODES: see updateMission's own `mergedMission` doc comment above —
    // same rationale applies here, and matters MORE for this choke point:
    // runtime.ts's native Step D reaches 'review' with NO judgeVerdict yet
    // (onUpdate patch has no verdict), which then lands via a SEPARATE,
    // LATER onUpdate call that carries judgeVerdict but no status field at
    // all (planAndActLive's Step F) — the auto-merge check below must fire
    // on THAT second patch too, not just the initial status flip.
    const mergedMission = prevMission ? mergeMissionUpdate(prevMission, update.patch) : undefined;

    setState(prev => ({
      ...prev,
      missions: prev.missions.map((m) =>
        m.id === update.id ? mergeMissionUpdate(m, update.patch) : m,
      ),
    }));

    // P7.7 — Content tripwire: check liveAction text for secrets, stack
    // traces, TODOs. Best-effort, fire-and-forget — never blocks the UI.
    const liveText = update.patch.liveAction;
    if (liveText && typeof liveText === 'string' && liveText.length > 10) {
      void tripwireRegistry.check(liveText, {
        missionId: update.id,
        projectId: '',
      }).catch(() => {});
    }

    // P0 sync: mirror streaming updates into the global runtime registry so
    // the orchestrator's waitForMission sees terminal status transitions
    // from runMission's onUpdate callback (choke point #2 — see updateMission
    // above for choke point #1). Without this, missions launched via the
    // orchestrator that reach 'done'/'failed'/'cancelled' through the
    // streaming path are never visible to waitForMission → deadlock.
    updateMissionInRegistry({ id: update.id, patch: update.patch });

    const newStatus = update.patch.status;
    if (prevMission && newStatus && prevMission.status !== newStatus) {
      onMissionTerminalSGR(mergedMission!);
      // W-CONTEST — registered ALONGSIDE chainEngine's hook above (same
      // choke point, never routed through it): checks whether this mission
      // is a contestant in any currently running best-of-N contest.
      onMissionTerminalForContest(mergedMission!);
      // Scheduler root-cause fix (2026-07-28, real production defect: a
      // validated plan's next step queued for 'pool_full' 15s after the
      // PREVIOUS step's own mission.completed, then never started again for
      // 2+ hours). runtime.ts's runMission reaches THIS onUpdate call with
      // status:'review' as soon as its own agent run finishes (Step D) —
      // but its promise (the one addMission/retryMission/the loop scheduler
      // wrapped as the scheduler's launchFn) does not settle until AFTER
      // orchestrator sub-agent fan-out and the automated tester/reviewer/
      // security/judge evaluation pipeline finish too (Steps E/F), which can
      // be slow or, on a stuck sub-agent, hang indefinitely. Waiting for
      // that unrelated tail before freeing the "claude-cli"/"managed"/
      // "byok:*" pool slot starved every OTHER queued mission with nothing
      // to do with it. Releasing HERE — the moment the mission's own status
      // leaves 'running' — lets the scheduler's queue drain immediately
      // instead. Idempotent (scheduler.ts's releaseMissionSlot): a no-op if
      // the slot already settled/released through the normal launchFn path.
      if (newStatus === 'review' || newStatus === 'done' || newStatus === 'failed' || newStatus === 'cancelled') {
        schedulerReleaseMissionSlot(update.id);
      }
      // P58 — same fleet hygiene reflex as updateMission's own choke point
      // above (this is applyRunUpdate's choke point #2 — see its own doc
      // comment).
      if (newStatus === 'done' || newStatus === 'failed' || newStatus === 'cancelled') {
        missionTerminalAtRef.current.set(update.id, Date.now());
        runFleetHygieneSweepRef.current();
      }
      // Section 4 gate — same demotion hook as updateMission's own choke
      // point above (this is applyRunUpdate's choke point #2).
      if (newStatus === 'failed' && mergedMission?.loopParentId) {
        resolveProjectRoot()
          .then((root) => announceLoopFailureIfDemotedRef.current(root, mergedMission))
          .catch(() => { /* best-effort */ });
      }
      // OS notifications (P7.3/QW1) — fire alongside the toast, same
      // best-effort fire-and-forget pattern.
      if (newStatus === 'done') {
        void notifyMissionDone(prevMission.id, prevMission.title, t);
      } else if (newStatus === 'failed') {
        void notifyMissionFailed(prevMission.id, prevMission.title, undefined, t);
      }
    }

    if (mergedMission && newStatus === 'done' && prevMission && prevMission.status !== 'done' && isOneTimeMission(mergedMission)) {
      scheduleAutoDismiss(mergedMission.id);
    }

    if (mergedMission && mergedMission.status === 'review') {
      triggerAutoMergeIfEligible(mergedMission);
    }
  }, [triggerAutoMergeIfEligible]);

  /**
   * Boot-time relaunch of a persisted 'queued' mission (2026-08-02 fix —
   * "queued missions never survive a restart" incident: see
   * relaunchQueuedMissionRef's own doc comment above and the boot-load
   * effect's call site for the fuller story). Mirrors addMission's own
   * launch wiring (stopFlag/pauseFlag/interveneQueue registration +
   * armQueuedLaunchWatchdog + schedulerDispatch(...runMission...) + the
   * same anti-clobber failure handler that flips the mission to 'failed'
   * with an honest reason instead of leaving it queued forever) — this is
   * deliberately NOT retryMission's lighter clone-and-direct-runMission
   * path: a boot relaunch must go through the SAME scheduler pool
   * accounting (claude-cli/managed/byok:* caps) a fresh launch would,
   * otherwise reconciling three projects' worth of queued missions at once
   * would blow straight past every configured concurrency cap.
   *
   * Deliberately skips addMission's CREATION-time-only gates (session
   * budget cap, out-of-scope task path) — those already ran once when this
   * mission was first queued; a resume is not a new choice being made, so
   * they are not re-asked here. Re-uses the mission's ORIGINAL id (never a
   * retryMission-style clone under a new id) — a queued mission never
   * actually ran, so there is no partial work/worktree to distinguish from
   * a fresh launch, and keeping the id stable means the user's existing
   * references (mission cards, canvas nodes, "M7") stay valid across the
   * restart instead of silently renumbering.
   */
  const relaunchQueuedMission = useCallback((mission: Mission, repoPath: string, projectId: string) => {
    const stopFlag = { stopped: false, controller: new AbortController() };
    stopFlags.current.set(mission.id, stopFlag);
    const pauseFlag = { paused: false };
    pauseFlags.current.set(mission.id, pauseFlag);
    const interveneQueue = { items: [] as string[] };
    interveneQueues.current.set(mission.id, interveneQueue);

    const getBudgetCapUsd = () =>
      stateRef.current.missions.find((m) => m.id === mission.id)?.contract?.budgetCapUsd;
    const onBudgetPaused = () => {
      pauseFlag.paused = true;
      updateMission({ id: mission.id, patch: { paused: true } });
    };
    const getMaxDurationMs = () =>
      stateRef.current.missions.find((m) => m.id === mission.id)?.contract?.maxDurationMs;
    const onDurationPaused = () => {
      pauseFlag.paused = true;
      updateMission({ id: mission.id, patch: { paused: true } });
    };

    // Same Promise.resolve(...) guard as addMission's identical call — a
    // bare vi.fn() mock (or any future refactor) must never throw
    // synchronously into this fire-and-forget path.
    Promise.resolve(
      updateQueuedMission(repoPath, mission.id, { status: 'running', startedAt: new Date().toISOString() }),
    ).catch(() => { /* best-effort */ });

    launchPhaseEnter(mission.id, 'runMission');
    armQueuedLaunchWatchdog(
      mission.id,
      projectId,
      () => stateRef.current.missions.find((m) => m.id === mission.id),
      (patch) => updateMission({ id: mission.id, patch }),
    );

    schedulerDispatch(
      mission,
      () => Promise.resolve(runMission(mission, repoPath, {
        onUpdate: applyRunUpdate,
        stopSignal: () => stopFlag.stopped,
        signal: stopFlag.controller.signal,
        pauseSignal: () => pauseFlag.paused,
        drainIntervenes: () => {
          const pending = interveneQueue.items;
          interveneQueue.items = [];
          return pending;
        },
        // Preserve the ORIGINAL mission's configured mode (a resume is a
        // re-run, not a fresh choice) — same fallback retryMission's own
        // runMission call uses when the mission never carried one (e.g. a
        // pre-T1.2 mission, or one launched via a path with no contract).
        permissionMode: mission.contract?.permissionMode ?? 'acceptEdits',
        getBudgetCapUsd,
        onBudgetPaused,
        getMaxDurationMs,
        onDurationPaused,
        t,
      })).then(() => {
        launchPhaseExit(mission.id, 'runMission');
        // LazyBot missions: end the run's engine bookkeeping + Solari session
        // release when the relaunched mission settles (same hook addMission's
        // chain and retryMission use). A queued bot mission relaunched across
        // a restart keeps its ORIGINAL id, whose run restoreBotRuntime
        // rehydrated at boot — without this the run would stay 'running'
        // forever after the mission completes and block every later launch.
        if (mission.botId) void finishBotRun(mission.id);
      }).catch((err: unknown) => {
        // Failure honesty — same contract as addMission's own catch
        // handler: a rejection here used to mean nothing (this whole
        // relaunch path did not exist), leaving the mission frozen in
        // 'queued' forever with no explanation. Any rejection now flips it
        // to 'failed' with a reason, unless it already reached a state the
        // user can act on.
        launchPhaseError(mission.id, 'runMission', err);
        const message = err instanceof Error ? err.message : String(err);
        const terminal = ['done', 'review', 'cancelled', 'failed'];

        const snapshot = stateRef.current.missions.find((m) => m.id === mission.id);
        const shouldNotify = !!snapshot && !terminal.includes(snapshot.status);

        setState((prev) => {
          const current = prev.missions.find((m) => m.id === mission.id);
          if (!current || terminal.includes(current.status)) return prev;
          return {
            ...prev,
            missions: prev.missions.map((m) =>
              m.id === mission.id
                ? {
                    ...m,
                    status: 'failed' as const,
                    statusReason: t('agents.mission.runFailed', { error: message }),
                    liveAction: undefined,
                  }
                : m,
            ),
          };
        });

        if (shouldNotify) {
          toast(t('agents.notification.failed', { title: snapshot!.title }), 'error', 6000);
        }

        Promise.resolve(
          updateQueuedMission(repoPath, mission.id, { status: 'failed' }),
        ).catch(() => {
          // Queue persistence stays best-effort
        });

        // Re-thrown so schedulerDispatch's own rate-limit detection can
        // still observe the failure — same rationale as addMission's
        // identical re-throw.
        throw err;
      }),
      { projectId, priority: 0 },
    );
  }, [t, toast, updateMission, applyRunUpdate]);

  useEffect(() => {
    relaunchQueuedMissionRef.current = relaunchQueuedMission;
  }, [relaunchQueuedMission]);

  /**
   * Cross-project queued-mission relaunch (2026-08-02 fix — real repro:
   * three projects open, only the ACTIVE one's queue ever drained; five
   * "lazy-backoffice" missions sat 'queued' for hours across many
   * restarts while the user worked in "LazySite-internet"). Mirrors
   * relaunchQueuedMission above (same stopFlag/pauseFlag/interveneQueue
   * wiring, same armQueuedLaunchWatchdog + schedulerDispatch(...runMission...)
   * path, so pool caps are respected identically regardless of which
   * project a mission belongs to — scheduler.ts's pools are a single
   * global module-level singleton, never scoped per project) but called
   * from the cross-project sweep effect below instead of the boot-only
   * journal-load effect, for a project OTHER than the one that effect
   * resolved.
   *
   * Deliberately does NOT touch state.missions / updateMission / setState,
   * unlike relaunchQueuedMission. Two independent reasons:
   *
   *  1. state.missions is (and stays) scoped to whichever ONE project the
   *     boot-load effect resolved at mount. Mission ids are only
   *     guaranteed unique WITHIN one project's own history (nextMissionId's
   *     counter self-heals from whatever missions THAT effect loaded — see
   *     its own doc comment); two different projects' independent
   *     histories can legitimately mint the same "M7". Merging a second
   *     project's missions into that same flat, id-keyed array risks
   *     silently clobbering an unrelated mission. Cockpit/CanvasView for
   *     the active project also render state.missions with no project
   *     filter (fleetMissions.ts's own doc comment: "agentsStore's own
   *     mission list does not carry a project id") — a foreign-project
   *     card would leak into the wrong project's view while the owner is
   *     actively looking at it.
   *  2. It would not even be visible if it did: fleetMissions.ts's
   *     useFleetMissions only merges live agentsStore state over the
   *     journal for the ACTIVE project — every other project's Cockpit
   *     group is journal-only, always. The only way a relaunched
   *     background mission's progress ever reaches the UI is via the
   *     journal itself.
   *
   * So this writes directly to the target project's OWN journal instead:
   * `emitBuffered('mission.updated', {projectId, ..., payload: {mission}})`
   * on every update, keeping a local (non-React) `current` snapshot as the
   * source of truth for each write. runtime.ts's own internal
   * mission.started/mission.completed/mission.failed emits are already
   * correctly project-scoped (runMission derives projectId from repoPath
   * directly), but without a full snapshot payload they only refresh
   * missions_current's SQL status column, not its `data` blob — the field
   * the UI actually reads (see journal.rs's apply_mission_projection). This
   * closure supplies that snapshot every time, mirroring what the
   * debounce-save effect does for the active project.
   */
  const relaunchQueuedMissionInOpenProject = useCallback((mission: Mission, repoPath: string, projectId: string) => {
    const stopFlag = { stopped: false, controller: new AbortController() };
    stopFlags.current.set(mission.id, stopFlag);
    const pauseFlag = { paused: false };
    pauseFlags.current.set(mission.id, pauseFlag);
    const interveneQueue = { items: [] as string[] };
    interveneQueues.current.set(mission.id, interveneQueue);

    // Local, non-React mission snapshot — see this function's own doc
    // comment (point 1/2) for why state.missions is never touched here.
    let current: Mission = mission;
    const publishToJournal = () => {
      emitBuffered({
        type: 'mission.updated',
        tsMs: Date.now(),
        projectId,
        missionId: mission.id,
        actor: 'system',
        payload: { mission: current },
      });
    };
    const applyPatch = (patch: MissionUpdate['patch']) => {
      current = mergeMissionUpdate(current, patch);
      publishToJournal();
    };

    const getBudgetCapUsd = () => current.contract?.budgetCapUsd;
    const onBudgetPaused = () => {
      pauseFlag.paused = true;
      applyPatch({ paused: true });
    };
    const getMaxDurationMs = () => current.contract?.maxDurationMs;
    const onDurationPaused = () => {
      pauseFlag.paused = true;
      applyPatch({ paused: true });
    };

    // Same Promise.resolve(...) guard as relaunchQueuedMission's identical
    // call — a bare vi.fn() mock (or any future refactor) must never throw
    // synchronously into this fire-and-forget path.
    Promise.resolve(
      updateQueuedMission(repoPath, mission.id, { status: 'running', startedAt: new Date().toISOString() }),
    ).catch(() => { /* best-effort */ });

    launchPhaseEnter(mission.id, 'runMission');
    armQueuedLaunchWatchdog(
      mission.id,
      projectId,
      () => current,
      (patch) => applyPatch(patch),
    );

    schedulerDispatch(
      mission,
      () => Promise.resolve(runMission(mission, repoPath, {
        onUpdate: (update) => applyPatch(update.patch),
        stopSignal: () => stopFlag.stopped,
        signal: stopFlag.controller.signal,
        pauseSignal: () => pauseFlag.paused,
        drainIntervenes: () => {
          const pending = interveneQueue.items;
          interveneQueue.items = [];
          return pending;
        },
        permissionMode: mission.contract?.permissionMode ?? 'acceptEdits',
        getBudgetCapUsd,
        onBudgetPaused,
        getMaxDurationMs,
        onDurationPaused,
        t,
      })).then(() => {
        launchPhaseExit(mission.id, 'runMission');
      }).catch((err: unknown) => {
        // Failure honesty — same never-silent contract as
        // relaunchQueuedMission's own catch handler: a rejection flips the
        // mission to 'failed' with a reason instead of leaving it frozen
        // in 'queued' forever with nothing to explain it.
        launchPhaseError(mission.id, 'runMission', err);
        const message = err instanceof Error ? err.message : String(err);
        const terminal = ['done', 'review', 'cancelled', 'failed'];
        if (!terminal.includes(current.status)) {
          applyPatch({
            status: 'failed',
            statusReason: t('agents.mission.runFailed', { error: message }),
            liveAction: undefined,
          });
          toast(t('agents.notification.failed', { title: current.title }), 'error', 6000);
        }
        Promise.resolve(
          updateQueuedMission(repoPath, mission.id, { status: 'failed' }),
        ).catch(() => { /* best-effort */ });

        // Re-thrown so schedulerDispatch's own rate-limit detection can
        // still observe the failure — same rationale as
        // relaunchQueuedMission's identical re-throw.
        throw err;
      }),
      { projectId, priority: 0 },
    );
  }, [t, toast]);

  /** Guards relaunchQueuedMissionInOpenProject against double-dispatch: a
   *  mission id is added the moment a relaunch (or a stale-reason stamp) is
   *  attempted — before any await settles — and is never removed. A
   *  mission only ever needs this once per app session: once it leaves
   *  'queued' the next journal read simply stops reporting it as eligible,
   *  so nothing but this synchronous guard is needed to keep a repeated
   *  sweep tick idempotent against a still-in-flight previous attempt. */
  const crossProjectRelaunchAttempted = useRef<Set<string>>(new Set());

  /**
   * Cross-project queued-mission sweep (2026-08-02 fix — see
   * relaunchQueuedMissionInOpenProject's own doc comment for the full
   * incident and design rationale). Runs once openProjects is known and
   * again on CROSS_PROJECT_SWEEP_INTERVAL_MS — "not just boot": a mission
   * can be queued into a background project mid-session too (e.g. via the
   * LazyManager), and the very first sweep can race openProjects/the
   * journal at cold boot.
   *
   * Deliberately excludes the ACTIVE project (already fully covered, with
   * richer state.missions integration, by the boot-load effect +
   * relaunchQueuedMission) and any project NOT in openProjects — a project
   * the user deliberately closed is never resurrected here. That is a
   * conscious choice, not an oversight: closing a project is a deliberate
   * user action (AppContext.closeProject), and silently relaunching
   * missions inside it the moment the app happens to boot again would
   * violate that intent just as loudly as the ACTIVE-only bug violated the
   * "queued work eventually runs" expectation in the other direction. Nor
   * is it silently stranded either — a closed project's queued missions
   * are left exactly as they are (real journal data, `.lazy/` untouched);
   * the instant it is REOPENED it re-enters openProjects and is picked up
   * by the very next tick of this same sweep, so nothing is permanently
   * lost, only deliberately deferred while closed.
   */
  useEffect(() => {
    if (!isTauri()) return;
    const openProjects = appContext?.openProjects ?? [];
    if (openProjects.length === 0) return;

    let cancelled = false;

    async function sweep() {
      for (const project of openProjects) {
        if (cancelled || project.active) continue;
        const root = project.root;
        const projectId = projectIdFromRoot(root);

        let missions: Mission[] | null;
        try {
          missions = await loadMissionsFromJournal(projectId);
        } catch {
          continue; // best-effort — one project's journal read must never block another's
        }
        if (cancelled || !missions || missions.length === 0) continue;

        const staleFlagged = applyQueueStaleness(missions, Date.now());
        for (const m of staleFlagged) {
          if (m.status !== 'queued' || crossProjectRelaunchAttempted.current.has(m.id)) continue;

          if (m.queueStale) {
            // Same never-silent convention as the active-project boot path
            // (R4b: 24h+ stale requires an explicit user "Relancer", never
            // an automatic resume) — stamp an honest reason instead of
            // leaving this frozen with none, additive-only (never
            // overwrites a reason the mission already carries).
            if (!m.statusReason) {
              crossProjectRelaunchAttempted.current.add(m.id);
              emitBuffered({
                type: 'mission.updated',
                tsMs: Date.now(),
                projectId,
                missionId: m.id,
                actor: 'system',
                payload: { mission: { ...m, statusReason: t('agents.mission.queueStaleReason') } },
              });
            }
            continue;
          }

          crossProjectRelaunchAttempted.current.add(m.id);
          relaunchQueuedMissionInOpenProject(m, root, projectId);
        }
      }
    }

    void sweep();
    const intervalId = setInterval(() => { void sweep(); }, CROSS_PROJECT_SWEEP_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [appContext?.openProjects, t, relaunchQueuedMissionInOpenProject]);

  /**
   * Scheduler reconciliation + stalled-queue visibility (root-cause fix,
   * 2026-07-28 — see applyRunUpdate's own doc comment above for the fuller
   * story of the defect this whole wave fixes). A periodic effect,
   * independent of scheduler.ts's OWN low-frequency safety-net sweep (which
   * only ever sees its own internal bookkeeping, never this store's
   * authoritative Mission list):
   *
   *  1. Reverse-leak guard (mission brief's "verify there is no leak in the
   *     other direction"): any mission id the scheduler still counts as
   *     occupying a pool slot (schedulerGetRunningMissionIds) that this
   *     store's OWN list already shows terminal (done/failed/cancelled) —
   *     or that has vanished entirely (deleted mid-run) — means the normal
   *     release paths (applyRunUpdate/updateMission's choke points above,
   *     launchNow's own eventual .finally() in scheduler.ts) were somehow
   *     never reached, e.g. a crash. releaseMissionSlot is idempotent, so
   *     reconciling an ALREADY-healthy slot here is always a safe no-op —
   *     this never force-frees a mission still genuinely running.
   *  2. "Never silent" visibility: a mission still 'queued' whose scheduler
   *     wait (schedulerMissionQueueWait) has crossed a reasonable threshold
   *     gets exactly ONE toast (deduped via stalledQueueToastedRef, cleared
   *     once the mission leaves 'queued' so a LATER re-queue can toast
   *     again). scheduler.ts's own `scheduler.stalled` journal event is the
   *     durable, queryable record of the same fact; this toast is the
   *     in-the-moment surface, since this store has no live journal-event
   *     subscription to react to that event directly.
   */
  const stalledQueueToastedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const RECONCILE_INTERVAL_MS = 20_000;
    const STALLED_TOAST_THRESHOLD_MS = 3 * 60_000;

    const tick = (): void => {
      const missions = stateRef.current.missions;

      for (const missionId of schedulerGetRunningMissionIds()) {
        const mission = missions.find((m) => m.id === missionId);
        const isStillGenuinelyRunning =
          mission && mission.status !== 'done' && mission.status !== 'failed' && mission.status !== 'cancelled';
        if (!isStillGenuinelyRunning) {
          schedulerReleaseMissionSlot(missionId);
        }
      }

      for (const mission of missions) {
        if (mission.status !== 'queued') {
          stalledQueueToastedRef.current.delete(mission.id);
          continue;
        }
        const wait = schedulerMissionQueueWait(mission.id);
        if (!wait || wait.waitedMs < STALLED_TOAST_THRESHOLD_MS) continue;
        if (stalledQueueToastedRef.current.has(mission.id)) continue;
        stalledQueueToastedRef.current.add(mission.id);
        const minutes = Math.max(1, Math.round(wait.waitedMs / 60_000));
        toast(t('agents.notification.queueStalled', { title: mission.title, minutes }), 'info', 6000);
      }
    };

    const interval = setInterval(tick, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [t, toast]);

  /**
   * Signal a running mission's loop to stop.
   *
   * Worktree cleanup fix: previously this only flipped the stopFlag the
   * running loop polls and optimistically set status:'cancelled' — actual
   * worktree cleanup depended entirely on runMission (runtime.ts) noticing
   * the flag on its own before reaching a terminal state, which has a real
   * gap (see cleanupStoppedWorktree's doc comment). Stop now ALSO fires an
   * immediate, direct discard — reusing cleanupStoppedWorktree, the same
   * pattern discardMission is built on — so cleanup no longer depends on
   * that race. Fire-and-forget and best-effort: this function's own public
   * signature stays synchronous, matching every existing caller
   * (MissionDetailControls, LazyManager's stop_mission action, stopAll below).
   *
   * Kill-before-cleanup ordering fix: real-app QA found the stopped
   * mission's worktree still leaked even with the direct discard above —
   * traced to a Windows file-lock race, not a missing call. The actual
   * process kill happens on a SEPARATE ~200ms poll tick inside
   * planAndActLive's pollStop (runtime.ts), fully uncoordinated with this
   * cleanup chain, which used to start immediately. killAgentRun is now
   * issued FIRST (best-effort, native-only, a harmless no-op for managed
   * missions or ones with no tracked PID) so the process is already being
   * torn down before cleanup ever attempts to remove the worktree —
   * shrinking the window git.rs's own retry logic has to cover, rather than
   * relying on it alone.
   */
  const stopMission = useCallback((id: string) => {
    const flag = stopFlags.current.get(id);
    if (flag) {
      flag.stopped = true;
      // Money incident (2026-08-14) — abort a turn already streaming, not
      // just prevent the next one. See stopFlags' own doc comment.
      flag.controller.abort();
    }

    const mission = state.missions.find((m) => m.id === id);
    updateMission({ id, patch: { status: 'cancelled', liveAction: undefined } });

    // Journal: fire-and-forget, best-effort — never blocks the optimistic
    // status flip above. Buffered (not emitEvent) so a mission cancelled
    // mid-run correctly flushes together with any still-buffered
    // tool.called/mission.step entries from the same run (mission.cancelled
    // is one of journal.ts's TERMINAL_TYPES).
    resolveProjectRoot().then((root) => {
      emitBuffered({
        type: 'mission.cancelled',
        tsMs: Date.now(),
        projectId: projectIdFromRoot(root),
        missionId: id,
        actor: 'user',
        payload: {},
      });
    }).catch(() => { /* best-effort */ });

    // Only a mission that actually has a worktree/branch has anything to
    // discard (mirrors discardMission's own `if (branch)` guard below).
    if (mission?.worktree) {
      const branch = mission.worktree;
      killAgentRun(id)
        .then(() => resolveProjectRoot())
        .then((repoPath) => cleanupStoppedWorktree(repoPath, branch))
        .catch(() => { /* best-effort — see cleanupStoppedWorktree */ });
    }
  }, [state.missions, updateMission]);

  /**
   * Pause a running mission BETWEEN ReAct steps — real for managed missions:
   * flips the pauseFlag cell that managedAgent.planAndActManaged polls at the
   * top of its loop (see the module header there), which then waits without
   * burning a step/model-call until resumed or stopped.
   *
   * Native missions: stop-then-resume — flips pauseFlag; planAndActLive kills
   * the tracked CLI PID, captures session_id, waits, then relaunches with
   * `--resume`. See nativePause.ts / planAndActLiveSupport.ts.
   */
  const pauseMission = useCallback((id: string) => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission || mission.status !== 'running' || mission.paused) return;
    const managed = isManagedAgentAvailable();
    const native = isLiveAgentAvailable();
    if (!managed && !native) return;

    const flag = pauseFlags.current.get(id);
    if (!flag) return;
    flag.paused = true;
    updateMission({ id, patch: { paused: true, liveAction: 'En pause…' } });

    resolveProjectRoot().then((root) => {
      emitEvent({
        type: 'mission.paused',
        tsMs: Date.now(),
        projectId: projectIdFromRoot(root),
        missionId: id,
        actor: 'user',
        payload: {},
      });
    }).catch(() => { /* best-effort */ });
  }, [state.missions, updateMission]);

  /** Resume a paused mission — clears the pauseFlag cell the loop polls;
   *  the loop itself announces "Reprise de la mission" once it notices, same
   *  as how it announces "Agent stopped by user" for stopSignal. */
  const resumeMission = useCallback((id: string) => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission || mission.status !== 'running' || !mission.paused) return;

    const flag = pauseFlags.current.get(id);
    if (flag) flag.paused = false;
    updateMission({ id, patch: { paused: false, liveAction: undefined } });

    resolveProjectRoot().then((root) => {
      emitEvent({
        type: 'mission.resumed',
        tsMs: Date.now(),
        projectId: projectIdFromRoot(root),
        missionId: id,
        actor: 'user',
        payload: {},
      });
    }).catch(() => { /* best-effort */ });
  }, [state.missions, updateMission]);

  /**
   * Queue a steering instruction into a running (or paused) mission.
   *
   * Managed missions: the text is pushed onto the mission's intervene-queue
   * cell, which managedAgent.planAndActManaged drains between ReAct steps
   * and injects as a real user message — it announces delivery itself once
   * that happens (see the module header there).
   *
   * Native missions (one-shot `claude -p`, see isLiveAgentAvailable's doc
   * comment in runtime.ts): there is no mid-run injection point, so the text
   * is recorded honestly as NOT delivered instead of faking a "sent" status
   * — the user has to act on it in a follow-up run.
   */
  const interveneMission = useCallback((id: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const mission = state.missions.find((m) => m.id === id);
    if (!mission || mission.status !== 'running') return;

    const managed = isManagedAgentAvailable();
    if (managed) {
      const queue = interveneQueues.current.get(id);
      if (queue) queue.items = [...queue.items, trimmed];
    }

    const note = managed
      ? `Intervention en file : "${trimmed}" — sera transmise à l'agent au prochain step`
      : `Intervention notée : "${trimmed}" — non transmissible en cours d'exécution pour ce moteur (process natif one-shot) ; à relancer manuellement`;

    updateMission({
      id,
      patch: {
        actionTimeline: [
          ...(mission.actionTimeline ?? []).map((e) => ({ ...e, isLive: false })),
          { time: nowTime(), text: note, isLive: false },
        ],
      },
    });

    resolveProjectRoot().then((root) => {
      emitEvent({
        type: 'mission.intervened',
        tsMs: Date.now(),
        projectId: projectIdFromRoot(root),
        missionId: id,
        actor: 'user',
        payload: { note: trimmed },
      });
    }).catch(() => { /* best-effort */ });
  }, [state.missions, updateMission]);

  /**
   * T1.8 — Takeover: human takes the baton from the agent.
   *
   * Managed missions: pauses the loop (same as pauseMission), then marks the
   * mission as `takenOver` so the UI shows a "Hand back" button. The user
   * edits files in the worktree directly.
   *
   * Native missions: stops the run (one-shot process can't be paused), then
   * marks `takenOver`. On hand-back, a continuation mission is created with
   * the human diff injected into the prompt.
   */
  const takeoverMission = useCallback(async (id: string) => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission || mission.status !== 'running') return;

    const managed = isManagedAgentAvailable();
    const mode = managed ? 'managed' : 'native';

    if (managed) {
      // Pause the managed loop — same mechanism as pauseMission
      const flag = pauseFlags.current.get(id);
      if (flag) flag.paused = true;
    } else {
      // Stop the native one-shot process
      const flag = stopFlags.current.get(id);
      if (flag) {
        flag.stopped = true;
        // Money incident (2026-08-14) — abort a turn already streaming, not
        // just prevent the next one. See stopFlags' own doc comment.
        flag.controller.abort();
      }
      // Best-effort cleanup: the user has already taken over manually (see
      // updateMission below), so a process that fails to die here is
      // advisory, not blocking — the native run loop's own stopSignal check
      // and the next status poll both still converge on 'stopped'.
      await killAgentRun(id).catch(() => {});
    }

    updateMission({ id, patch: { takenOver: true, paused: managed ? true : undefined, liveAction: 'Pris en charge par l\'utilisateur' } });

    const root = await resolveProjectRoot().catch(() => '.');
    emitEvent({
      type: 'mission.takeover_started',
      tsMs: Date.now(),
      projectId: projectIdFromRoot(root),
      missionId: id,
      actor: 'user',
      payload: { mode },
    });
  }, [state.missions, updateMission]);

  /**
   * T1.8 — Return from takeover: hand the baton back to the agent.
   *
   * Managed: captures the worktree diff (human edits since takeover), injects
   * it as a HUMAN_EDITS observation via the intervene queue, then resumes.
   *
   * Native: captures the diff, creates a continuation mission seeded with the
   * diff + a journal summary in the agentTask prompt.
   */
  const returnFromTakeover = useCallback(async (id: string) => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission || !mission.takenOver) return;

    const root = await resolveProjectRoot().catch(() => '.');
    const branch = mission.worktree ?? '';
    const managed = isManagedAgentAvailable();

    // Capture the human diff from the worktree
    let diffSummary = '';
    if (branch) {
      try {
        const worktreePath = resolveDiscardWorktreePath(root, branch);
        diffSummary = await worktreeDiff(worktreePath);
      } catch {
        // Best-effort — diff capture failure shouldn't block handback
      }
    }

    // Truncate to a reasonable size for injection
    const truncatedDiff = diffSummary.slice(0, 8000);

    if (managed) {
      // Inject the human edits as an observation via the intervene queue
      const queue = interveneQueues.current.get(id);
      if (queue && truncatedDiff) {
        queue.items = [...queue.items, `HUMAN_EDITS: The user made the following changes during takeover. Adapt your work accordingly:\n\n${truncatedDiff}`];
      }
      // Resume the paused managed loop
      const flag = pauseFlags.current.get(id);
      if (flag) flag.paused = false;
      updateMission({ id, patch: { takenOver: false, paused: false, liveAction: undefined } });
    } else {
      // Native: mark as stopped, create continuation mission with diff
      updateMission({ id, patch: { takenOver: false, liveAction: undefined } });

      // Create a continuation mission seeded with the human diff
      const newId = nextMissionId(stateRef.current.missions);
      const continuation: Mission = {
        ...mission,
        id: newId,
        status: 'queued',
        progress: 0,
        planSteps: [],
        actionTimeline: [],
        liveAction: undefined,
        judgeVerdict: undefined,
        judgesApproved: undefined,
        merged: undefined,
        takenOver: undefined,
        agentTask: truncatedDiff
          ? `${mission.agentTask ?? mission.title}\n\n[Human takeover diff — continue from these edits]:\n${truncatedDiff}`
          : mission.agentTask,
      };

      const stopFlag = { stopped: false, controller: new AbortController() };
      stopFlags.current.set(newId, stopFlag);
      const pauseFlag = { paused: false };
      pauseFlags.current.set(newId, pauseFlag);
      const interveneQueue = { items: [] as string[] };
      interveneQueues.current.set(newId, interveneQueue);

      setState((prev) => ({
        ...prev,
        missions: pruneMissions([...prev.missions, continuation]),
      }));

      runMission(continuation, root, {
        onUpdate: applyRunUpdate,
        stopSignal: () => stopFlag.stopped,
        signal: stopFlag.controller.signal,
        pauseSignal: () => pauseFlag.paused,
        drainIntervenes: () => {
          const pending = interveneQueue.items;
          interveneQueue.items = [];
          return pending;
        },
        t,
        // Best-effort: runMission reports its own terminal state (including
        // failure) through the onUpdate callback (applyRunUpdate) above,
        // which is what the mission card actually renders — this outer
        // catch only prevents an unhandled-rejection warning for the
        // fire-and-forget continuation itself, it is not the failure path.
      }).catch(() => {});
    }

    emitEvent({
      type: 'mission.takeover_returned',
      tsMs: Date.now(),
      projectId: projectIdFromRoot(root),
      missionId: id,
      actor: 'user',
      payload: { diffSummary: truncatedDiff ? `${truncatedDiff.slice(0, 200)}...` : undefined },
    });
  }, [state.missions, updateMission, applyRunUpdate, t]);

  /** Approve: merge worktree into repo, mark done. Real body lives in
   *  approveMissionInner (below); `approveMission` (further below still) is
   *  the thin public wrapper every caller actually gets — see its own doc
   *  comment for why the split exists.
   *
   * Gate: blocks merge when judgeVerdict is absent or passed===false,
   * unless opts.force === true. Throws ApproveBlockedError so callers
   * can surface the reason via toast without coupling the store to UI libs.
   *
   * Honesty fix: mergeWorktree failures used to be silently swallowed
   * UNCONDITIONALLY, after which the mission was force-marked
   * status:'done', merged:true regardless — so a real merge failure (e.g.
   * MissionDetailControls' former DEFAULT_REPO='.' bug, which resolved
   * outside the opened project root and made Rust's
   * ensure_repo_in_project_root reject the call) still showed "Mergé ✓" in
   * the UI while the worktree was never actually merged. Swallowing is only
   * legitimate in web/mock mode — no real Tauri backend exists there to
   * merge against at all (see isTauri()). In Tauri, a merge failure is real
   * and must propagate so the caller (MissionDetailControls) can surface it
   * and the mission stays in 'review' instead of lying about success.
   *
   * W-MODES: `opts.actor`/`opts.mode` are the SAME real primitive the
   * human's "Merger"/"Merger quand même" buttons call — triggerAutoMergeIfEligible
   * is just another caller, never a parallel path. `opts.force` keeps its
   * pre-existing meaning/semantics unchanged (checkApproveGate's bypass);
   * `actor`/`mode` only widen the emitted `mission.approved` journal
   * payload (additive) so a reader can tell an auto-merge apart from a
   * human click after the fact. Absent `opts.actor` still means 'user',
   * exactly as before this wave — every pre-existing call site keeps its
   * current behavior unchanged.
   *
   * Bug fix (audit wave): the mission-not-found/no-worktree/not-in-review
   * guard used to be a BARE SILENT `return` — a caller (any of them; see
   * approveMission's own doc comment for the full list) would see its
   * `await approveMission(...)` resolve as if nothing were wrong, no
   * ApproveBlockedError, no toast, no journal trace — indistinguishable
   * from a genuine success from the caller's own perspective. Now throws
   * the SAME ApproveBlockedError shape every other gate rule below already
   * uses, reusing the exact copy the manager tool's own pre-existing guard
   * (executeManagerAction's 'approve_mission' case) already showed for this
   * identical condition, so the message a user sees doesn't change either.
   */
  /**
   * Section 4 gate — records one approved execution against the approved
   * mission's parent loop regime (if any) and, when that approval crosses
   * the trial threshold, announces the promotion in the manager chat
   * (spec: "annoncée à l'utilisateur ... jamais silencieuse"). A no-op for
   * every mission that isn't a gated loop iteration (see
   * `recordLoopIterationApproval`'s own doc comment).
   *
   * References `sendManagerMessageRef`/`resolveManagerModelId` — both
   * declared further down this same component function. Safe: this is only
   * ever CALLED from inside `approveMissionInner` (itself only invoked by a
   * later user/manager action), by which point the whole component body has
   * already run once and every ref below is initialized — the same
   * forward-reference convention `executeManagerActionRef` already
   * establishes in this file.
   */
  const announceLoopApprovalIfPromoted = async (repoPath: string, mission: Pick<Mission, 'loopParentId'>): Promise<void> => {
    const outcome = await recordLoopIterationApproval(repoPath, mission);
    if (!outcome?.promoted) return;
    // Multi-conversation LazyManager (wave 1): a background announcement is
    // best-effort routed the SAME way a proactive wake-up is (see
    // pickWakeupTargetConversationId's own doc comment) — the most-recently-
    // active IDLE open conversation, never a busy one. Silently skipped if
    // every open conversation is currently busy (same degrade-gracefully
    // posture the old single-conversation version had for a busy manager).
    const targetId = pickWakeupTargetConversationId(stateRef.current);
    if (!targetId) return;
    await sendManagerMessageRef.current(
      targetId,
      formatLoopPromotedMessage(outcome.loopTitle),
      resolveAutomatedTurnModel(stateRef.current.managerModel),
      // GOAL LOOP: a background announcement, not a real user ask — see
      // sendManagerMessage's isAutomatedTurn doc comment.
      { isAutomatedTurn: true },
    );
  };

  /** Mirror of `announceLoopApprovalIfPromoted` for a FAILED loop iteration
   *  (spec §4: "retour en mode essai ... au premier échec ... le dit").
   *  Unlike `announceLoopApprovalIfPromoted`, this one IS called before its
   *  declaration (from updateMission/applyRunUpdate's choke points above) —
   *  see `announceLoopFailureIfDemotedRef`'s doc comment for why those call
   *  sites go through the ref instead of this `const` directly. */
  const announceLoopFailureIfDemoted = async (repoPath: string, mission: Pick<Mission, 'loopParentId'>): Promise<void> => {
    const outcome = await recordLoopIterationFailure(repoPath, mission);
    if (!outcome?.demoted) return;
    // Same best-effort routing as announceLoopApprovalIfPromoted above.
    const targetId = pickWakeupTargetConversationId(stateRef.current);
    if (!targetId) return;
    await sendManagerMessageRef.current(
      targetId,
      formatLoopDemotedMessage(outcome.loopTitle),
      resolveAutomatedTurnModel(stateRef.current.managerModel),
      // GOAL LOOP: a background announcement, not a real user ask — see
      // sendManagerMessage's isAutomatedTurn doc comment.
      { isAutomatedTurn: true },
    );
  };
  useEffect(() => {
    announceLoopFailureIfDemotedRef.current = announceLoopFailureIfDemoted;
  }, [announceLoopFailureIfDemoted]);

  const approveMissionInner = useCallback(async (
    id: string,
    repoPath: string,
    opts?: { force?: boolean; actor?: 'user' | 'auto'; mode?: ApprovalMode },
  ) => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission) {
      throw new ApproveBlockedError(t('agents.manager.missionNotFound', { id }));
    }
    if (!mission.worktree || mission.status !== 'review') {
      // STALE-APPROVAL IDEMPOTENCY fix (real user report, 2026-08-14 — "M5"
      // incident: a mission merged cleanly through one path (e.g. a direct
      // "Merger" click, or auto-merge) while a SEPARATE, now-stale
      // approve_mission request for the SAME mission id (e.g. a
      // pendingApprovals entry queued earlier that turn, or a duplicate
      // manager retry) was still in flight or got retried afterward. That
      // second attempt reached this exact guard with mission.status already
      // 'done' — genuinely NOT 'review' anymore — and used to throw
      // missionNotInReview, which approveMission's wrapper below then
      // journals as `mission.approve_blocked` ("merge bloqué" in the
      // activity feed) FOREVER, even though the mission's own work is
      // already safely merged. A mission that is already done+merged is the
      // most honest possible "nothing left to do here" — resolve it exactly
      // like the OTHER two already-merged idempotent paths in this function
      // (the empty-diff M50 shape above, and the "Already up to date"
      // preMergeHeadSha shape below): a genuine no-op success, never an
      // error. Never masks a REAL "not in review" refusal — checked as an
      // ADDITIONAL, narrower condition on top of the same guard, not a
      // replacement for it (a mission that is merely 'queued'/'running'/
      // 'failed' with no worktree still hits the original throw below,
      // unchanged).
      if (mission.status === 'done' && mission.merged === true) {
        emitBuffered({
          type: 'merge.noop_already_merged',
          tsMs: Date.now(),
          projectId: projectIdFromRoot(repoPath),
          missionId: id,
          actor: opts?.actor === 'auto' ? 'system' : 'user',
          payload: { branch: mission.worktree ?? '' },
        });
        toast(t('agents.approve.closedWithoutMerge'), 'info');
        return;
      }
      throw new ApproveBlockedError(t('canvas.manager.missionNotInReview', { id: mission.id }));
    }

    const gateError = checkApproveGate(mission, { force: opts?.force, t });
    if (gateError) throw gateError;

    const branch = mission.worktree;

    // WORKTREE-DESTROYED-PRE-MERGE fix (2026-08-05) — honest failure half:
    // if the worktree directory is simply gone by the time approve runs
    // (fleet-hygiene Rule (j) racing a still-live mission — see that rule's
    // own doc comment above for the root cause this now also prevents at
    // the source — or any other external removal), the merge attempt below
    // used to surface as a raw, cryptic OS error (Windows error 267,
    // "directory name is invalid") straight from git. Checked here, BEFORE
    // any merge attempt, so the caller gets an honest, actionable reason
    // instead — same ApproveBlockedError shape/journal path
    // (mission.approve_blocked) every other blocked-approval reason here
    // already uses. Only meaningful on Tauri (no real filesystem to probe
    // in web/mock mode, mirrors every other isTauri()-gated check in this
    // function); a probe failure is never treated as proof of absence
    // (defaultWorktreeExists itself only returns false on a confirmed
    // missing-directory read, see its own doc comment).
    if (isTauri()) {
      const worktreePath = resolveDiscardWorktreePath(repoPath, branch);
      const stillExists = await defaultWorktreeExists(worktreePath);
      if (!stillExists) {
        // 9th+ instance of the \\?\ verbatim-prefix leak (src/lib/paths.ts's
        // header) — worktreePath is joinPath()'d straight from repoPath,
        // which on Windows is typically get_project_root's canonicalize()
        // result and therefore \\?\-prefixed. stripVerbatimPrefixesInText
        // (not the whole-string stripVerbatimPrefix) because the path is
        // embedded mid-sentence inside this translated message, not used
        // bare.
        throw new ApproveBlockedError(
          t('agents.merge.worktreeMissing', { path: stripVerbatimPrefixesInText(worktreePath) }),
        );
      }
    }

    // ── QA fixes: merge ──────────────────────────────────────────
    // B10 (empty-diff half): checkApproveGate's `force === true` branch
    // bypasses the judge/proof gates unconditionally by design (that IS
    // "force"), but it never checked whether there was anything to merge
    // at all — this is exactly how mission M10 (judges 0/3, fabricated
    // proof, 0 diff) force-merged silently. mission.diffAdded/diffRemoved
    // alone are not trustworthy grounds to BLOCK on (they can be stale or,
    // per M10, fabricated) — only used here to decide whether the extra
    // async round-trip below is worth making at all. When they DO suggest
    // an empty diff, verify against the REAL worktree git diff (ground
    // truth, not mission fields) before deciding anything; any failure to
    // read that real diff is treated as "unknown, not proven empty" and
    // falls through to the actual merge attempt, which is independently
    // guarded by the vacuous-merge check further below.
    //
    // REVIEW DEAD-END fix (2026-08-05, founder repro M50): a "merge branch
    // X into main" mission whose agent performs that merge itself DURING
    // its own run reaches review with a real, honest, permanently-empty
    // diff — the branch's own effect is already fully contained in the
    // target. checkApproveGate above still requires force here (no
    // credible judge verdict exists for a git-ops-only mission), and this
    // guard used to unconditionally THROW on any confirmed-empty diff, no
    // matter WHY it was empty — conflating M10's fabricated/nothing-
    // happened emptiness with M50's legitimate already-accomplished
    // emptiness under one outcome. M50's case was left stuck in 'review'
    // FOREVER: every retry of Approve reproduces the identical empty diff,
    // so there was no legitimate exit. Checked unconditionally now (not
    // just opts?.force — a normal Approve on a judge-passed mission can
    // reach this same empty-diff shape too, and must resolve the same
    // honest way, not just the forced one) — distinguished by judge
    // verdict, not by force: an EXPLICITLY rejected verdict (passed ===
    // false) still gets the old hard refusal below (M10's own regression
    // coverage, agentsStore.vacuousMerge.test.tsx, is unaffected — a
    // non-force caller can never even reach here with a rejected verdict,
    // checkApproveGate above already refused it); anything else (no
    // verdict at all — the realistic shape for a pure git-ops mission — or
    // a passing one) resolves as a genuine terminal success instead of an
    // error: same shape as the "already merged" no-op further below
    // (mergeSha === preMergeHeadSha) — status 'done', chains/wakeup fire
    // through the SAME updateMission terminal-transition choke point a
    // real merge uses (updateMission's own onMissionTerminalSGR hook,
    // above), honest digest explains no NEW merge happened.
    if (isTauri() && isDiffEmpty(mission)) {
      const worktreePath = resolveDiscardWorktreePath(repoPath, branch);
      // APPROVE→MERGE INERT fix — bounded: an unresolvable invoke here used
      // to hang this whole call forever (see withApproveTimeout's own doc
      // comment). Any failure (timeout included) keeps falling through to
      // "unknown, not proven empty" exactly as before this fix.
      const realDiff = await withApproveTimeout(worktreeDiff(worktreePath), APPROVE_GIT_READ_TIMEOUT_MS, 'worktreeDiff').catch(() => undefined);
      if (realDiff !== undefined && realDiff.trim() === '') {
        if (mission.judgeVerdict?.passed === false) {
          // M10 shape — judges explicitly rejected this mission AND it
          // produced no real change: still a hard refusal. `force` only
          // ever bypassed the JUDGE gate (checkApproveGate above), never
          // this ground-truth empty-diff guard.
          throw new ApproveBlockedError(t('agents.merge.forceBlockedEmptyDiff'));
        }
        // M50 shape — the mission's effect is already applied (or there
        // never was a credible rejection to begin with); resolve as a
        // genuine done-without-merge terminal success rather than an
        // error, so the review actually closes and any on-success chain
        // fires exactly as it would for a real merge.
        updateMission({ id, patch: { status: 'done', merged: true } });
        emitBuffered({
          type: 'merge.noop_already_merged',
          tsMs: Date.now(),
          projectId: projectIdFromRoot(repoPath),
          missionId: id,
          actor: opts?.actor === 'auto' ? 'system' : 'user',
          payload: { branch },
        });
        toast(t('agents.approve.closedWithoutMerge'), 'info');
        // ZOMBIE LOOP fix — same stop as every other terminal path in this
        // function (see the identical call on the real-merge success path
        // below for the full rationale).
        await stopLoopForTerminalMission(repoPath, id, 'disable', 'merged').catch(() => {
          // Best-effort — a failure here must never retroactively turn an
          // already-reported close into an error.
        });
        await announceLoopApprovalIfPromoted(repoPath, mission).catch(() => {
          // Best-effort — see above.
        });
        return;
      }
    }

    // B10 (vacuous-merge half): capture the repo's HEAD sha BEFORE the
    // merge via the same real git plumbing platform.git.log already
    // exposes (git_log -n 1), so it can be compared against whatever
    // mergeWorktree reports afterward. Only meaningful on Tauri (no real
    // git to read in web/mock mode); best-effort — a repo with zero
    // commits or a transient read failure leaves this undefined, in which
    // case the comparison below simply can't prove vacuousness and does
    // NOT block (see the comment on the comparison itself).
    // APPROVE→MERGE INERT fix — bounded, same rationale as the force-diff
    // read above: a stuck git.log invoke used to hang this whole call
    // forever with no visible error. Any failure (timeout included) keeps
    // falling through to "can't prove vacuousness, don't block" exactly as
    // before this fix.
    const preMergeHeadSha = isTauri()
      ? await withApproveTimeout(getPlatform().git.log(repoPath, 1), APPROVE_GIT_READ_TIMEOUT_MS, 'git.log')
          .then((entries) => entries?.[0]?.hash?.trim() || undefined)
          .catch(() => undefined)
      : undefined;

    // T1.7: agent_merge_worktree (Rust) now returns the merge commit sha.
    // mergeWorktree's own exported signature in runtime.ts intentionally
    // stays typed Promise<void> (runtime.ts is out of this task's file
    // scope, and every OTHER existing caller keeps ignoring the resolved
    // value exactly as before it changed) — so the real IPC payload is
    // narrowed defensively here instead of asserted with a cast: a
    // mock/web-mode caller whose mergeWorktree resolves `undefined`
    // degrades to "no sha captured" (revertMission's missing-mergeSha
    // error path below) rather than a bad cast blowing up at runtime.
    let mergeSha: string | undefined;
    try {
      // Explicit `unknown` (not the function's own declared Promise<void>):
      // narrowing a `void`-typed value via `typeof` collapses the true
      // branch to `never` (nothing left to call .trim() on); routing
      // through `unknown` first narrows to a real `string` instead, which
      // is what actually flows over the IPC boundary at runtime now.
      // APPROVE→MERGE INERT fix (2026-08-05) — THE critical bound: this is
      // the exact await real approvals were found hanging on for hours (a
      // stuck git lock, no timeout of its own). A timeout here is a REAL
      // failure, not a benign fallback — it falls into the SAME catch below
      // as any other merge error, so it throws loudly on Tauri (mission
      // stays 'review', caller sees an honest error) instead of hanging
      // silently forever.
      const mergeOutcome: unknown = await withApproveTimeout(mergeWorktree(repoPath, branch), APPROVE_MERGE_TIMEOUT_MS, 'mergeWorktree');
      mergeSha = typeof mergeOutcome === 'string' && mergeOutcome.trim() !== '' ? mergeOutcome : undefined;
    } catch (err) {
      if (isTauri()) {
        // QA bug (severe): a merge conflict used to propagate as a plain,
        // often-blank Error (git.rs only ever read the merge command's
        // `.stderr`, and git's own conflict narration is printed to stdout)
        // with no persistent UI trace — the repo was left mid-merge (real
        // MERGE_HEAD + conflict markers) AND the signal card looked
        // untouched. git.rs's agent_merge_worktree_inner now always runs
        // `git merge --abort` before returning on a real conflict (the
        // user's working tree is guaranteed clean again by the time this is
        // reached) and tags the error "MERGE_CONFLICT: ..." so it can be
        // classified here instead of silently falling through as a generic
        // failure. Journal the honest outcome and hand the caller a
        // distinguishable error so Cockpit.tsx's handleUrgentAction can flip
        // the mission's signal card to an explicit conflict state instead of
        // an easy-to-miss transient toast.
        const message = err instanceof Error ? err.message : String(err);
        const conflictMatch = message.match(/MERGE_CONFLICT:\s*([\s\S]*)$/);
        if (conflictMatch) {
          emitBuffered({
            type: 'merge.conflicted',
            tsMs: Date.now(),
            projectId: projectIdFromRoot(repoPath),
            missionId: id,
            actor: opts?.actor === 'auto' ? 'system' : 'user',
            payload: { branch },
          });
          throw new MergeConflictError(conflictMatch[1].trim() || t('agents.merge.conflictError'));
        }
        // Real desktop runtime, non-conflict failure: never pretend a
        // failed merge succeeded — propagate so the caller surfaces it and
        // the mission stays 'review'.
        throw err;
      }
      // Web/mock mode: no real Tauri backend to merge against — a no-op
      // "success" here is legitimate (see isTauri()).
    }

    // B10 (vacuous-merge half, continued): `git merge --no-ff` still exits
    // 0 ("Already up to date") when there is genuinely nothing new to
    // merge — Rust's agent_merge_worktree_inner then returns the CURRENT
    // (unchanged) HEAD sha, not a real new merge commit, and its
    // worktree-cleanup step runs regardless (tied to the merge command's
    // exit code, not to whether a commit was actually created). Only
    // flagged when preMergeHeadSha is KNOWN (see above) — this never
    // false-blocks a merge just because the pre-sha couldn't be read; it
    // only catches the case we can actually prove.
    if (isTauri() && preMergeHeadSha !== undefined) {
      if (mergeSha === preMergeHeadSha) {
        // QA fix: an "Already up to date" result used to ALWAYS throw the
        // same "Rien à merger" error as a genuinely fabricated/empty merge
        // (M10, QA B10) — but by this point checkApproveGate (plus the
        // force-empty-diff check above, when force is used) has already
        // established there WAS something real to merge. The only honest
        // explanation left for an unchanged HEAD is that the mission's own
        // branch commits are ALREADY contained in it (a prior successful
        // merge, or a duplicate "Merger" click) — that IS the mission's
        // work landing in the target, so this resolves like a real success
        // (QA: M39/M40 already-merged missions used to be a silent, card-
        // never-clears no-op instead). Never attaches a mergeSha for
        // revert (see the `if (mergeSha)` block below) — preMergeHeadSha is
        // the OLD HEAD, not a merge commit this call created.
        updateMission({ id, patch: { status: 'done', merged: true } });
        emitBuffered({
          type: 'merge.noop_already_merged',
          tsMs: Date.now(),
          projectId: projectIdFromRoot(repoPath),
          missionId: id,
          actor: opts?.actor === 'auto' ? 'system' : 'user',
          payload: { branch },
        });
        // ZOMBIE LOOP fix — this mission just reached its real terminal
        // state (done/merged); stop its own registered loop, if any (see
        // stopLoopForTerminalMission's doc comment). Best-effort: a failure
        // here must never retroactively turn an already-reported merge
        // success into an error.
        await stopLoopForTerminalMission(repoPath, id, 'disable', 'merged').catch(() => {
          // Best-effort — see above.
        });
        await announceLoopApprovalIfPromoted(repoPath, mission).catch(() => {
          // Best-effort — see above.
        });
        return;
      }
      if (!mergeSha) {
        // No sha returned at all — unlike a CONFIRMED same-sha match above,
        // this proves nothing (the real Rust contract always returns a sha
        // on success, so an empty result is a red flag, not evidence of an
        // honest no-op) — stays a blocking error.
        throw new Error(t('agents.merge.vacuousError'));
      }
    }

    updateMission({ id, patch: { status: 'done', merged: true } });
    // Additive (T1.7): mergeSha isn't part of Mission yet (see
    // RevertableMission's doc comment above), so it rides in a second,
    // narrowly-scoped functional update instead of updateMission's
    // Partial<Mission>-typed patch above. React batches this with the
    // updateMission call into the same re-render — no intermediate paint
    // with mergeSha missing. Skipped entirely when there is nothing to
    // attach (mock/web mode, or a real merge that somehow returned no sha).
    if (mergeSha) {
      const capturedSha = mergeSha;
      setState((prev) => ({
        ...prev,
        missions: withRevertFields(prev.missions, id, { mergeSha: capturedSha }),
      }));
    }

    // ── Post-merge push (plumbing fix, missionPush.ts) ────────────────
    // The merge above lands the mission's worktree branch into the target
    // branch LOCAL only; until this leg existed the merged commit was never
    // pushed to the remote, so "main never moved / nothing reached GitHub"
    // (the exact failure the founder reported on the backoffice test repo).
    // Best-effort BY DESIGN and honest: the merge already succeeded and the
    // mission is terminal ('done') — a push failure must never retroactively
    // turn that into an error, but it must never be silently pretended-away
    // either. missionPush.ts returns a discriminated result; we surface a
    // non-fatal, clearly-worded toast ONLY for a REAL push failure (a genuine
    // "the work is not on the remote" situation the user owns), and keep the
    // normal `mission.approved` emission below single and unchanged (payload
    // without a `pushed` field for the skipped cases, matching the shared
    // MissionApprovedPayload type exactly). isTauri() gate: web/mock has no
    // real git backend — pushAfterMissionMerge short-circuits there (returns
    // 'skipped_no_remote') without any git call.
    const platform = getPlatform();
    const pushResult = await pushAfterMissionMerge(repoPath, {
      isTauri,
      repoHasRemote: async (p) => (await platform.git.canPush(p)).hasRemote,
      repoHasUpstream: async (p) => (await platform.git.canPush(p)).hasUpstream,
      pushGit: (p) => platform.git.push(p),
    }).catch((err: unknown) => ({
      outcome: 'failed' as const,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if (pushResult.outcome === 'failed') {
      // Honest, non-blocking: the merge happened locally, but the push did
      // not — the remote does NOT have this work, and we say so.
      toast(t('agents.merge.pushedFailed', { reason: pushResult.reason }), 'error', 6000);
    }
    // pushed / skipped_no_remote / skipped_no_upstream: the normal
    // mission.approved emission below proceeds exactly as before.

    // Reaches here only when the merge really succeeded (or the legitimate
    // web/mock no-op above) — a real Tauri failure already threw and
    // returned above. Buffered: mission.approved is one of journal.ts's
    // TERMINAL_TYPES.
    //
    // W-MODES: the envelope's own `actor` stays within JournalActor's
    // existing closed union ('system' for an auto-merge, matching every
    // other automated-action call site in this file — e.g. budget.exceeded
    // above) — the NEW, more specific 'auto' signal lives in the payload
    // (additive), never widening the shared envelope type every other
    // event/consumer in this codebase also uses.
    emitBuffered({
      type: 'mission.approved',
      tsMs: Date.now(),
      projectId: projectIdFromRoot(repoPath),
      missionId: id,
      actor: opts?.actor === 'auto' ? 'system' : 'user',
      payload: opts?.actor === 'auto' ? { actor: 'auto', mode: opts.mode } : {},
    });
    // ZOMBIE LOOP fix — same stop as the "already merged" no-op branch
    // above, for the normal merge-success path: see
    // stopLoopForTerminalMission's doc comment.
    await stopLoopForTerminalMission(repoPath, id, 'disable', 'merged').catch(() => {
      // Best-effort — a failure here must never retroactively turn an
      // already-reported merge success into an error.
    });
    // Section 4 gate — see announceLoopApprovalIfPromoted's own doc comment.
    // Best-effort: a failure here must never retroactively turn an
    // already-reported merge success into an error.
    await announceLoopApprovalIfPromoted(repoPath, mission).catch(() => {
      // Best-effort — see above.
    });

    // Phase 4: Learning loop relocated from runtime.ts review status to here —
    // the human has approved and the merge succeeded, so this is the right time
    // to capture lessons. Best-effort: a failure here must never retroactively
    // turn an already-reported merge success into an error.
    runLearningLoop(mission, undefined, t).catch(() => {
      // Non-fatal — learning capture failure doesn't affect the merge
    });
  }, [state.missions, updateMission, t]);

  /**
   * Approve: public entry point every caller actually imports/destructures.
   * Thin wrapper around approveMissionInner (all the real gate/merge logic,
   * unchanged) that adds ONE cross-cutting concern (bug audit wave): any
   * throw from approveMissionInner OTHER than a MergeConflictError (which
   * already journals its own dedicated `merge.conflicted` event right where
   * it's thrown — never double-journaled here) is additionally journaled as
   * `mission.approve_blocked` with the reason, so the mission's own
   * timeline shows a BLOCKED/FAILED approval attempt instead of staying
   * silent — whether the attempt came from a human's "Merger" click, the
   * manager's `approve_mission` tool, or the auto-merge engine. The
   * original error is always rethrown unchanged afterward, so every
   * existing caller's catch (ApproveBlockedError.reason, MergeConflictError,
   * a generic Error) keeps working exactly as before this wave.
   */
  const approveMission = useCallback(async (
    id: string,
    repoPath: string,
    opts?: { force?: boolean; actor?: 'user' | 'auto'; mode?: ApprovalMode },
  ) => {
    try {
      await approveMissionInner(id, repoPath, opts);
    } catch (err) {
      if (!(err instanceof MergeConflictError)) {
        const reason = err instanceof Error ? err.message : String(err);
        emitBuffered({
          type: 'mission.approve_blocked',
          tsMs: Date.now(),
          projectId: projectIdFromRoot(repoPath),
          missionId: id,
          actor: opts?.actor === 'auto' ? 'system' : 'user',
          payload: { reason },
        });
      }
      throw err;
    }
  }, [approveMissionInner]);

  // W-MODES: sync the ref-escape-hatch used by triggerAutoMergeIfEligible
  // (declared far above updateMission/applyRunUpdate — see
  // approveMissionRef's own doc comment for why direct reference isn't
  // possible there).
  useEffect(() => {
    approveMissionRef.current = approveMission;
  }, [approveMission]);

  /** Reject: discard worktree, remove mission from board.
   *
   * Honesty fix (mirrors approveMission above): discardWorktree failures
   * used to be silently swallowed UNCONDITIONALLY, after which the mission
   * was force-marked status:'cancelled' regardless — so a real discard
   * failure (e.g. the former DEFAULT_REPO='.' bug) left the worktree/branch
   * alive on disk while the UI claimed the mission was gone. Swallowing is
   * only legitimate in web/mock mode — no real Tauri backend exists there to
   * discard against at all (see isTauri()). In Tauri, propagate so the
   * caller can surface it and the mission stays in its current status
   * instead of lying about the discard.
   */
  const discardMission = useCallback(async (id: string, repoPath: string) => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission) return;

    // Prefer the mission's own worktree/branch field when present (Mission
    // has no separate absolute worktree-path field to prefer instead — see
    // resolveDiscardWorktreePath's doc comment above).
    const branch = mission.worktree ?? '';

    if (branch) {
      const worktreePath = resolveDiscardWorktreePath(repoPath, branch);
      try {
        await discardWorktree(repoPath, worktreePath, branch);
      } catch (err) {
        if (isTauri()) {
          // Real desktop runtime: never pretend a failed discard succeeded.
          throw err;
        }
        // Web/mock mode: no real Tauri backend to discard against — a no-op
        // "success" here is legitimate (see isTauri()).
      }
    }

    setState(prev => ({
      ...prev,
      missions: prev.missions.map((m) =>
        m.id === id
          ? { ...m, status: 'cancelled' as const, liveAction: undefined }
          : m,
      ),
      selectedMissionId: prev.selectedMissionId === id ? null : prev.selectedMissionId,
    }));

    // Reaches here only when the discard really succeeded (or the
    // legitimate web/mock no-op above) — a real Tauri failure already threw
    // and returned above.
    emitEvent({
      type: 'mission.rejected',
      tsMs: Date.now(),
      projectId: projectIdFromRoot(repoPath),
      missionId: id,
      actor: 'user',
      payload: {},
    });
  }, [state.missions]);

  /**
   * Revert a mission (spec §8's one-click "revert mission" — always visible
   * on Done missions; also reachable for a 'failed'/'review' mission whose
   * worktree is still around).
   *
   *   - Unmerged (mission.merged is not true — never reached approveMission,
   *     e.g. 'review'/'failed' with its worktree/branch still around):
   *     reverting IS exactly discardMission's existing flow (drop the
   *     worktree, status -> 'cancelled', mission.rejected emitted) — no
   *     separate code path, this literally calls discardMission.
   *   - Merged (approveMission already merged its worktree into repoPath):
   *     `git revert -m 1` the recorded merge commit (gitRevertMerge),
   *     best-effort delete the mission's proof-artifact directory, flag
   *     `reverted: true` (status stays 'done' — see RevertableMission's doc
   *     comment), emit `mission.reverted`.
   *
   * Throws a plain Error (never a custom class — agentsStore.tsx is a .tsx
   * file, and this codebase keeps `class` declarations out of .tsx, see
   * approveGate.ts's header comment) when a merged mission has no recorded
   * mergeSha — approved before this shipped, or in web/mock mode where no
   * real merge ever produced a sha. MissionDetailControls catches this the
   * same way it already catches an approveMission/discardMission failure:
   * a clear toast, no crash.
   */
  const revertMission = useCallback(async (id: string, repoPath: string): Promise<void> => {
    const mission = state.missions.find((m) => m.id === id) as RevertableMission | undefined;
    if (!mission) return;

    if (!mission.merged) {
      await discardMission(id, repoPath);
      return;
    }

    if (!mission.mergeSha) {
      throw new Error(
        `Impossible d'annuler « ${mission.title} » : aucun commit de fusion n'a été enregistré pour cette mission.`,
      );
    }

    await gitRevertMerge(repoPath, mission.mergeSha);

    // Best-effort — proof artifacts are secondary evidence; a cleanup
    // failure (directory absent, locked file, web/mock mode with no real
    // fs) must never undo the revert that already succeeded above.
    try {
      const platform = getPlatform();
      if (platform?.fs) {
        await platform.fs.remove(joinPath(repoPath, '.lazy', 'artifacts', id));
      }
    } catch (err) {
      console.warn('[revertMission] Failed to delete mission artifacts:', err);
    }

    setState((prev) => ({
      ...prev,
      missions: withRevertFields(prev.missions, id, { reverted: true }),
    }));

    emitEvent({
      type: 'mission.reverted',
      tsMs: Date.now(),
      projectId: projectIdFromRoot(repoPath),
      missionId: id,
      actor: 'user',
      payload: { merged: true },
    });
  }, [state.missions, discardMission]);

  /**
   * Fork a new graph run from one of this mission's checkpoints
   * (graph/forkFromCheckpoint.ts, spec §checkpoints). A plain managed
   * mission has no GraphIR of its own (writeCheckpoint uses the mission's
   * own id as runId — see managedAgent.ts), so a minimal single-mission
   * IR shim stands in: forkFromCheckpoint only reads ir.id/ir.defaults
   * (initGraphRun) when the checkpoint carries no nodeId, which is always
   * the case for a managed-agent checkpoint. Never relaunches or
   * schedules anything itself — the caller (MissionDetail) surfaces the
   * new run/checkpoint ids for the user to inspect.
   */
  const forkMissionFromCheckpoint = useCallback(async (id: string, checkpointId: string): Promise<ForkResult> => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission) {
      throw new Error(`Cannot fork checkpoint: mission ${id} not found.`);
    }
    const projectRoot = mission.repoRoot ?? (await resolveProjectRoot());
    const ir: GraphIR = {
      id: `mission-${mission.id}`,
      version: 1,
      name: mission.title,
      objective: mission.title,
      projectId: projectIdFromRoot(projectRoot),
      defaults: defaultGraphDefaults(),
      nodes: [],
      edges: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'fork',
    };
    return forkFromCheckpoint(projectRoot, mission.id, checkpointId, ir);
  }, [state.missions]);

  const addMission = useCallback(async (input: NewMissionInput): Promise<string> => {
    // stateRef.current (not state.missions): addMission is a useCallback
    // with a stable [t, toast] dep list, so a direct state.missions closure
    // reference here would go stale — see stateRef's doc comment above for
    // why the ref is always caught up by the time a callback like this runs.
    const id = nextMissionId(stateRef.current.missions);

    // BULLETPROOF CREATION fix (2026-08-04 live-prod incident: the manager
    // reported "Lancée ×2" while NO mission existed anywhere — no card, no
    // journal row, no mission.created event): `repoRoot` used to be patched
    // onto an ALREADY-CREATED-AND-VISIBLE mission via a POST-HOC
    // `updateMissionRef.current(...)` call, well after the mission's own
    // initial `setState` below. That two-step shape meant mission creation
    // was never atomic: anything going wrong between the two steps (this
    // resolution awaiting, a stale/not-yet-synced ref — see
    // updateMissionRef's own doc comment for the sync-effect dependency
    // this removes) left a HALF-CREATED mission behind, or — worse, per the
    // residual risk this fix closes — meant a caller could theoretically
    // observe a resolved addMission() Promise (a real id string, `toast`
    // "Lancée", `{patchedRef}` returned as if successful) for a mission
    // whose own construction never actually completed.
    //
    // `repoRoot` (Mission.repoRoot's own doc comment, types.ts) is now
    // resolved and included directly in `newMission`'s own object literal
    // below, BEFORE the ONE setState that makes this mission exist at all —
    // never a second, separate, skippable mutation. Any failure resolving
    // `repoPath` (explicit target, or `resolveProjectRoot`) now REJECTS
    // this whole call before anything is created — no mission ever exists
    // half-built, and the caller's own await correctly sees a real
    // rejection instead of a fabricated success (launch_mission's executor
    // case, below, has no local try/catch around its own `await
    // addMission(...)` — a rejection here already propagates to
    // sendManagerMessage's per-action try/catch as an honest
    // `agents.manager.actionFailed`, never a false "Lancée").
    launchPhaseEnter(id, 'resolveProjectRoot');
    const explicitRepoRaw = input.repo?.trim().replace(/^\\\\\?\\/, '') ?? '';
    const explicitRepo = /^[A-Za-z]:[\\/]|^\//.test(explicitRepoRaw) ? explicitRepoRaw : null;
    const repoPath = explicitRepo ?? await resolveProjectRoot(input.repo);
    launchPhaseExit(id, 'resolveProjectRoot', `root="${repoPath}"`);

    // Tool allowlist/denylist are persisted onto the stored Mission (even
    // though Mission's canonical type does not declare them) so retryMission
    // can re-thread the SAME restriction on a retry instead of silently
    // widening a tool-restricted mission to full access (SECURITY — see
    // retryMission's own runMission call). The intersection type keeps
    // TypeScript honest without editing lib/agents/types.ts.
    const newMission: Mission & { allowedTools?: string[]; deniedTools?: string[] } = {
      id,
      repoRoot: repoPath,
      title: input.title,
      status: 'queued',
      createdAt: Date.now(),
      model: input.modelLabel,
      worktree: input.worktree,
      // R13 follow-up (2026-08-03, real-user test M1): launch_mission and
      // every other caller pass `permissionMode` (e.g. 'acceptEdits') in
      // NewMissionInput, but this constructor never copied it onto the
      // stored Mission — so runMission -> planAndAct received undefined,
      // fell back to 'default', the Rust agent_run appended NO permission
      // flag, and the native claude CLI (non-interactive -p mode) refused
      // every Write/Edit with "please approve file-write permission",
      // producing a guaranteed empty deliverable. The launch callers were
      // fixed in R13; the constructor was the remaining gap.
      permissionMode: input.permissionMode,
      baseBranch: input.baseBranch,
      mergeBranches: input.mergeBranches,
      extraReadableRoots: input.extraReadableRoots,
      progress: 0,
      isOrchestrator: input.orchestrator,
      subAgents: input.orchestrator
        ? [
            { name: 'Implémenteur', status: 'queued' },
            { name: 'Testeur', status: 'queued' },
            { name: 'Relecteur', status: 'queued' },
          ]
        : undefined,
      planSteps: [],
      actionTimeline: [],
      agentTask: input.agentTask,
      agentName: input.agentName,
      // LazyBot identity (see the Mission fields' own doc comments,
      // types.ts) — forwarded unchanged from NewMissionInput so the managed
      // loop gets the bot persona and the cloud approval gate gets the bot's
      // autonomy. Absent for every non-bot mission.
      agentSystemPrompt: input.agentSystemPrompt,
      botAutonomy: input.botAutonomy,
      botId: input.botId,
      // DEFECT B root cause: this field used to be dropped here entirely —
      // input.loopConfig was only ever consulted as a boolean flag (below, to
      // skip launching runMission for a loop parent) and never actually
      // copied onto the stored Mission. mission.loopConfig was therefore
      // ALWAYS undefined for a loop's own parent mission, so the cadence/
      // next-run/Pause/Supprimer controls in MissionDetailControls.tsx (whose
      // whole block is gated on `mission.loopConfig &&`) could never render,
      // no matter how complete that UI code was.
      loopConfig: input.loopConfig,
      // T1.2 gap fix: NewMissionModal.tsx already assembles and sends
      // `contract` (see its buildContract()/missionInput), but this
      // constructor copies known input fields one-by-one rather than
      // spreading `input`, so the field was silently dropped before
      // reaching the persisted Mission. Forwarded unchanged — nothing here
      // reads/enforces it yet (T1.3 budgets, T1.4 proof gate).
      // Effort wiring: merge input.effort into the contract so it reaches
      // runMission -> planAndAct -> planAndActManaged -> streamAgentTurn.
      contract: input.contract
        ? { ...input.contract, ...(input.effort ? { effort: input.effort } : {}) }
        : input.effort
          // Root-cause fix (2026-08-02 zone audit): humanApprove used to be
          // hardcoded true here — approveGate.ts's evaluateAutoMerge treats
          // that as an explicit per-mission auto-merge opt-out that always
          // wins over the project's own approval mode (by design). With no
          // caller-visible way to ever set it otherwise, this silently
          // defeated auto_green/full_auto for every mission that reached
          // this fallback, exactly like NewMissionModal.tsx's own default
          // contract (see that file's identical fix for the fuller story).
          ? { objective: input.agentTask ?? input.title, model: input.modelLabel, permissionMode: 'acceptEdits', budgetCapUsd: 0, proofs: [], gates: { evaluators: true, humanApprove: false }, shareToTeam: false, effort: input.effort }
          : undefined,
      parentMissionId: input.parentMissionId,
      isolated: input.isolated,
      originConversationId: input.originConversationId,
      // Persisted for retryMission (see the intersection type above) — a
      // retry re-threads these instead of dropping them.
      allowedTools: input.allowedTools,
      deniedTools: input.deniedTools,
    };

    setState(prev => ({
      ...prev,
      missions: pruneMissions([...prev.missions, newMission]),
    }));

    // Fire-and-forget brain capture — never blocks or throws into the UI.
    // taskText: input.agentTask is the full task/prompt text, available
    // right here at kickoff — included so the kickoff note (often just
    // title+model+worktree when input.description is empty) clears
    // detectNoise()'s 60-char/8-word bar on its own, before this same note
    // is ever richened by the completion capture (learningLoop.ts).
    captureAgentMission(
      input.title,
      input.description,
      input.modelLabel,
      input.worktree,
      { taskText: input.agentTask },
    );

    // Enqueue in durable mission queue for crash recovery. `repoPath` was
    // already resolved above (BEFORE this mission was constructed/added to
    // state — see the BULLETPROOF CREATION comment at the top of this
    // function) — input.repo is often '.', which is why the resolution
    // never just trusts it as-is; input.repo is ALSO resolveProjectRoot's
    // fallbackRoot: if get_project_root hangs/fails (see that function's P0
    // hang-fix doc comment), the launch degrades to the repo the user
    // already picked in the New Mission modal rather than aborting or
    // hanging. Explicit-target fix (2026-08-03 real-user test, mission M1):
    // when the caller passes a REAL absolute root (manager's launch_mission
    // routing a task to another OPEN project via projectId / path-mention
    // resolution), it is a deliberate target — honored above instead of
    // resolveProjectRoot's ACTIVE project, which used to silently win and
    // land the worktree in the wrong repo (Lazy-real-test while the task
    // named lazy-backoffice).
    //
    // Promise.resolve(...) guards the fire-and-forget .catch() below against
    // a non-Promise return from enqueueMission (e.g. a bare `vi.fn()` test
    // mock, or any future refactor) — without it, calling .catch() on
    // undefined throws synchronously into this async launch function,
    // producing an unhandled rejection instead of the best-effort no-op
    // this call has always intended to be.
    Promise.resolve(enqueueMission(repoPath, newMission.id)).catch(() => {
      // Queue persistence is best-effort
    });

    // Journal: fire-and-forget mission lifecycle — created THEN queued
    // (ordered), never blocking the launch. payload.mission carries the
    // full snapshot (T0.5 gap fix) so missions_current.data is a
    // restorable Mission from the very first event, not just
    // title/objective/model — see missionsProjection.ts's boot-from-journal.
    const projectId = projectIdFromRoot(repoPath);

    // P0 sync: register the mission in the global runtime registry so the
    // orchestrator's waitForMission (which calls findMissionById from
    // globalRuntime) can actually find it. Without this, the orchestrator
    // deadlocks waiting for a mission that never appears in the registry.
    registerRuntimeProject(projectId, repoPath, projectId);
    addMissionToRegistry(projectId, newMission);

    emitEvent({
      type: 'mission.created',
      tsMs: Date.now(),
      projectId,
      missionId: newMission.id,
      actor: 'user',
      payload: {
        title: newMission.title,
        objective: input.agentTask,
        model: newMission.model,
        mission: newMission,
      },
    });
    emitEvent({
      type: 'mission.queued',
      tsMs: Date.now(),
      projectId,
      missionId: newMission.id,
      actor: 'user',
      payload: {},
    });

    // Launch the agent run loop — fire and forget, updates flow via onUpdate
    // Skip for loop parent missions: the loop scheduler creates child iterations.
    if (!input.loopConfig) {
      // T1.3 session cap (spec §7.3/§8): lazy.agents.costLimitUsd, enforced
      // here for the first time (previously a dead setting — spec §5.1's P0
      // hygiene list). 0/absent -> unlimited. Refuses the launch honestly:
      // the mission stays 'queued' (already created + journaled above) but
      // is never dispatched to the scheduler/engine — the user must act
      // (raise the cap in Settings, or retryMission once resolved) rather
      // than the launch silently proceeding past their own cap.
      const sessionCapUsd = sessionCostCapUsd();
      if (sessionCapUsd > 0) {
        const sessionSpentUsd = getCostState().totalCostUsd;
        const quoteEstimateUsd = input.contract?.quote?.costUsd?.[1] ?? 0;
        if (sessionSpentUsd + quoteEstimateUsd > sessionCapUsd) {
          // 2026-08-06 (founder: "que je reste pas bloque ... sans savoir ce
          // qui se passe") — the mission was created + journaled but never
          // dispatched; it MUST carry a visible statusReason (the card
          // renders it) so the user sees WHY it is sitting there, and the
          // manager's fleet context (managerEngine.ts's missionLines) can
          // name the reason too. Same pattern as the out_of_scope_path
          // refusal below.
          updateMission({
            id: newMission.id,
            patch: {
              statusReason: `Session budget cap ($${sessionCapUsd.toFixed(2)}) would be exceeded — raise it in Settings or retry once resolved`,
            },
          });
          emitEvent({
            type: 'mission.blocked',
            tsMs: Date.now(),
            projectId,
            missionId: newMission.id,
            actor: 'system',
            payload: { reason: 'session_budget' },
          });
          toast(
            `${t('common.error')}: session budget cap ($${sessionCapUsd.toFixed(2)}) would be exceeded`,
            'error',
          );
          return newMission.id;
        }
      }

      // Wrong-context guard (2026-08-01 QA fix — see missionScopeGuard.ts's
      // own header for the full rationale and the "no unjailed fs check
      // available without a rebuild" layer decision): a mission ALWAYS runs
      // against `repoPath` (this single resolved root), never a path parsed
      // out of the task text — so a task naming a DIFFERENT project's
      // absolute folder used to launch silently against the ACTIVE
      // project's cwd/worktree/brain, with no error anywhere. Refuses
      // honestly instead: the mission stays created + journaled (so it is
      // visible and retryable — see Mission.statusReason's own doc comment,
      // exactly the mechanism this uses) but is never dispatched.
      //
      // `newMission.extraReadableRoots` (already resolved + set above, see
      // its own doc comment in types.ts) is passed through so a mention
      // that lies under a DECLARED cross-project read root is not treated
      // as out of scope — see missionScopeGuard.ts's "EXTRA-READABLE-ROOTS
      // FIX" header for the full rationale and the read-vs-write trade-off.
      const outOfScopePath = findOutOfScopeTaskPath(input.agentTask, repoPath, newMission.extraReadableRoots);
      if (outOfScopePath) {
        updateMission({
          id: newMission.id,
          patch: {
            status: 'failed',
            statusReason: `Task names "${outOfScopePath.mentionedPath}", which is outside the active project ("${outOfScopePath.activeRoot}") — open that project first (open_project), then retry.`,
          },
        });
        emitEvent({
          type: 'mission.blocked',
          tsMs: Date.now(),
          projectId,
          missionId: newMission.id,
          actor: 'system',
          payload: { reason: 'out_of_scope_path' },
        });
        toast(
          `${t('common.error')}: task targets "${outOfScopePath.mentionedPath}", outside the active project — open that project first`,
          'error',
        );
        return newMission.id;
      }

      // Engine-readiness preflight (row-first) — 2026-08-07 fix for the "chat
      // chip shows Lancée, card flips to Approuvée, then NOTHING" defect (4
      // founder-reported occurrences). Every OTHER preflight above creates
      // the mission row FIRST (setState, already run above) and only THEN
      // honestly refuses to dispatch it — this one was missing entirely for
      // every addMission caller: only the agent:launch bus-event listener
      // further below ever called getEngineReadiness() before reaching
      // addMission (see its own "Preflight (FIX B)" doc comment); the
      // manager's launch_mission executor case (agentsStore.tsx's
      // executeManagerAction) calls addMission directly with no readiness
      // gate at all. Without this, a not-ready engine (Lazy Pro plan active
      // but 0 credits, or an explicitly-requested native model with no CLI
      // detected) sailed straight past worktree creation and brain recall —
      // real, slow work for a mission already doomed — before failing deep
      // inside planAndAct's own mismatch branch (runtime.ts), if the failure
      // surfaced at all.
      //
      // Reuses the EXACT mode-independent signals planAndAct's own dispatch
      // decision uses (classifyMissionModel + isManagedModelReady /
      // isNativeModelReady, runtime.ts) — never a new detection invented
      // here — so this verdict can never disagree with the real dispatch
      // further down. Gated on isTauri() to mirror planAndAct's own
      // Tauri-only branch (chosenKind stays undefined off Tauri, so the
      // mock/scripted engine there is never second-guessed by this check) —
      // the web demo, and every test that doesn't simulate Tauri, see zero
      // behavior change.
      if (isTauri()) {
        const routeKind = classifyMissionModel(newMission.model);
        const engineNotReady =
          (routeKind === 'managed' && !isManagedModelReady()) ||
          (routeKind === 'native' && !isNativeModelReady());
        if (engineNotReady) {
          // Pro-rail wording is founder-specified verbatim; the native/CLI
          // wording mirrors it for the same honest, one-step-fixable shape.
          const reason = routeKind === 'managed'
            ? `Lancement refusé : le moteur Pro n'a plus de crédits — choisis un autre moteur.`
            : `Lancement refusé : le CLI Claude/Codex est introuvable — choisis un autre moteur.`;
          updateMission({
            id: newMission.id,
            patch: { status: 'failed', statusReason: reason },
          });
          emitEvent({
            type: 'mission.blocked',
            tsMs: Date.now(),
            projectId,
            missionId: newMission.id,
            actor: 'system',
            payload: { reason: routeKind === 'managed' ? 'pro_no_credits' : 'cli_not_found' },
          });
          toast(reason, 'error');
          return newMission.id;
        }
      }

      const stopFlag = { stopped: false, controller: new AbortController() };
      stopFlags.current.set(newMission.id, stopFlag);
      const pauseFlag = { paused: false };
      pauseFlags.current.set(newMission.id, pauseFlag);
      const interveneQueue = { items: [] as string[] };
      interveneQueues.current.set(newMission.id, interveneQueue);
      // T1.3 — live budget-cap getter + pause bridge for the managed engine
      // (see managedAgent.ts's PlanAndActManagedOpts doc comments). Reads
      // stateRef.current (not the newMission const) so a cap raised via
      // updateMission mid-run is visible on the loop's very next check
      // (resume-after-raise); onBudgetPaused reuses this EXACT pauseFlag
      // cell pauseMission/resumeMission already read/write, so a
      // budget-triggered pause is resumable via the existing Resume button.
      const getBudgetCapUsd = () =>
        stateRef.current.missions.find((m) => m.id === newMission.id)?.contract?.budgetCapUsd;
      const onBudgetPaused = () => {
        pauseFlag.paused = true;
        updateMission({ id: newMission.id, patch: { paused: true } });
      };
      // W-GUARD — same live-getter/pause-bridge contract as budget above,
      // for the mission's wall-clock cap (contract.maxDurationMs).
      const getMaxDurationMs = () =>
        stateRef.current.missions.find((m) => m.id === newMission.id)?.contract?.maxDurationMs;
      const onDurationPaused = () => {
        pauseFlag.paused = true;
        updateMission({ id: newMission.id, patch: { paused: true } });
      };

      // Mark as running in the queue. Wrapped in Promise.resolve(...) — the
      // reported defect: a bare `vi.fn()` mock for updateQueuedMission (no
      // .mockResolvedValue) returns undefined, and undefined.catch() throws
      // TypeError synchronously into this async function, which surfaces as
      // an unhandled rejection since this launch call is fire-and-forget and
      // nothing downstream ever awaits/catches it. Promise.resolve() makes
      // the .catch() below safe regardless of what the wrapped call returns.
      Promise.resolve(
        updateQueuedMission(repoPath, newMission.id, {
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
      ).catch(() => { /* best-effort */ });

      launchPhaseEnter(newMission.id, 'runMission');
      // Queued-launch watchdog (see armQueuedLaunchWatchdog's doc comment):
      // arms a 45s safety net right at the point the launch actually commits
      // to dispatch, so a stall anywhere between here and runMission's own
      // 'status-flip-running' (runtime.ts) surfaces honestly instead of
      // freezing 'queued' silently, the way this exact mission used to.
      armQueuedLaunchWatchdog(
        newMission.id,
        projectId,
        () => stateRef.current.missions.find((m) => m.id === newMission.id),
        (patch) => updateMission({ id: newMission.id, patch }),
      );
      // Provider-aware scheduler (T1.1): the actual runMission call is
      // wrapped as a launchFn thunk so the scheduler can decide WHEN it
      // runs — immediately when its pool (claude-cli/managed/byok:<hash>)
      // and the global lazy.agents.maxParallel cap both have room, queued
      // otherwise. With no caps configured this launches in the exact same
      // synchronous tick as before (schedulerDispatch has no internal
      // await ahead of calling launchFn) — byte-identical to the direct
      // call this replaces.
      schedulerDispatch(
        newMission,
        // Promise.resolve(...) wraps the actual launch call for the same
        // reason as the updateQueuedMission guards above: a non-Promise
        // return (bad mock or future refactor) must not throw synchronously
        // on the .then()/.catch() chained below it.
        () => Promise.resolve(runMission(newMission, repoPath, {
          onUpdate: applyRunUpdate,
          stopSignal: () => stopFlag.stopped,
          signal: stopFlag.controller.signal,
          pauseSignal: () => pauseFlag.paused,
          drainIntervenes: () => {
            const pending = interveneQueue.items;
            interveneQueue.items = [];
            return pending;
          },
          permissionMode: input.permissionMode,
          allowedTools: input.allowedTools,
          deniedTools: input.deniedTools,
          getBudgetCapUsd,
          onBudgetPaused,
          getMaxDurationMs,
          onDurationPaused,
          t,
        })).then(() => {
          launchPhaseExit(newMission.id, 'runMission');
          // LazyBot run reached its end (whatever the terminal status) —
          // clear the bot-engine runtime tracking and release the run's
          // Solari cloud sessions. Best-effort, idempotent (see
          // finishBotRun's doc comment).
          if (input.botId) void finishBotRun(newMission.id);
        }).catch((err: unknown) => {
          // Failure honesty (v0.1.5 W2.4): this used to be a silent swallow,
          // leaving the mission frozen in 'queued' forever with no explanation.
          // Any rejection now flips the mission to 'failed' with the reason
          // (phase-tagged by runtime.missionPhase) — unless it already reached
          // a state the user can act on (review/done/cancelled/failed).
          launchPhaseError(newMission.id, 'runMission', err);
          const message = err instanceof Error ? err.message : String(err);
          const terminal = ['done', 'review', 'cancelled', 'failed'];

          // FIX C (code review): decide whether to notify from the latest
          // known snapshot BEFORE calling setState, so the updater below has
          // no side effects (see stateRef's doc comment above). The
          // anti-clobber guard itself — never overwrite a mission that
          // already reached a terminal state — is unchanged and still
          // re-checked against the live `prev` at apply time; this snapshot
          // only decides whether to notify.
          const snapshot = stateRef.current.missions.find((m) => m.id === newMission.id);
          const shouldNotify = !!snapshot && !terminal.includes(snapshot.status);

          setState(prev => {
            const current = prev.missions.find((m) => m.id === newMission.id);
            if (!current || terminal.includes(current.status)) return prev;
            return {
              ...prev,
              missions: prev.missions.map((m) =>
                m.id === newMission.id
                  ? {
                      ...m,
                      status: 'failed' as const,
                      statusReason: t('agents.mission.runFailed', { error: message }),
                      liveAction: undefined,
                    }
                  : m,
              ),
            };
          });

          if (shouldNotify) {
            toast(t('agents.notification.failed', { title: snapshot!.title }), 'error', 6000);
          }

          // Same Promise.resolve(...) guard as the 'running' update above.
          Promise.resolve(
            updateQueuedMission(repoPath, newMission.id, { status: 'failed' }),
          ).catch(() => {
            // Queue persistence stays best-effort
          });

          // LazyBot run failed hard — same cleanup as the resolve path
          // (runtime tracking + Solari session release), best-effort and
          // idempotent so running before the re-throw below is safe.
          if (input.botId) void finishBotRun(newMission.id);

          // Re-thrown (not swallowed): this chain has always been
          // fire-and-forget (no caller ever awaited or observed its
          // settlement before T1.1), so re-throwing here changes nothing
          // user-visible — every state update above already ran
          // unconditionally. It lets schedulerDispatch's own internal
          // handling see the failure and detect a rate-limit-shaped message
          // for that pool's backoff, without duplicating any of the
          // mission-state logic above.
          throw err;
        }),
        { projectId, priority: 0 },
      );
    }

    return newMission.id;
  }, [t, toast, updateMission, applyRunUpdate]);

  const setSelectedMissionId = useCallback((id: string | null) => {
    setState(prev => ({ ...prev, selectedMissionId: id }));
  }, []);

  // Subscribe to agent:launch bus events from the assistant space.
  // On each launch request: add a mission and navigate to the agents space.
  //
  // Preflight (FIX B, code review): the composer's "Lancer comme agent"
  // button and ReviewSpace's Ask Reviewer/Tester quick-launch buttons funnel
  // through this bus event and have no preflight UI of their own (unlike
  // NewMissionModal/Composer's inline panel) — without this check a
  // not-ready engine (no CLI, no BYOK key, Pro inactive/out of credits)
  // silently created a mission that could never actually run. Centralized
  // here rather than in each emitter so every agent:launch caller gets the
  // same guarantee for free.
  useEffect(() => {
    const unsub = on('agent:launch', (req) => {
      const readiness = getEngineReadiness();
      if (!readiness.ready) {
        if (readiness.reason) {
          toast(t(engineReasonKey(readiness.reason)), 'error');
        }
        return;
      }
      const taskText = req.task ?? '';
      const titleText = req.title ?? taskText.slice(0, 60) + (taskText.length > 60 ? '…' : '');
      void addMission({
        title: titleText,
        agentTask: taskText,
        agentName: undefined,
        repo: '.',
        worktree: '',
        modelLabel: req.model ?? 'Sonnet 4.6',
        mode: 'agent',
        orchestrator: false,
        // DEFECT 2 (2026-07 acceptance test): the composer "Lancer comme
        // agent →" path (and the Review-space quick-launch buttons) funnel
        // through this bus event. Without an explicit permissionMode, addMission
        // passes undefined → runtime.ts sends 'default' → the native CLI runs
        // with interactive approval prompts that never appear in-app, so the
        // agent stalls. Default to 'acceptEdits' — the same mode the Agents
        // "New Mission" modal (NewMissionModal) uses — so both launch paths
        // behave identically.
        permissionMode: 'acceptEdits',
      });
      emit('nav:navigateSpace', 'agents');
    });
    return unsub;
  }, [addMission, t, toast]);

  // Emit agent:runningCount whenever the missions list changes.
  useEffect(() => {
    const runningCount = state.missions.filter((m) => m.status === 'running').length;
    emit('agent:runningCount', runningCount);
  }, [state.missions]);

  // `state.missions` read via a ref by the loop scheduler below — NOT a
  // scheduler effect dependency. See loopScheduler.ts's module header for the
  // full story: depending the scheduler effect on `[state.missions]` used to
  // tear down and recreate the interval (and re-run the startup load) on
  // every single mission mutation, which raced loadLoopsOnStartup against
  // markIterationFired and caused the loop runaway defect.
  const missionsRef = useRef<Mission[]>(state.missions);
  useEffect(() => {
    missionsRef.current = state.missions;
  }, [state.missions]);

  // ── Loop scheduler: fires due loops at most once per cadence ────────
  // Created exactly once (empty deps) — see missionsRef above and
  // loopScheduler.ts's module header for why this must never depend on
  // `state.missions`.
  useEffect(() => {
    const stop = startLoopScheduler({
      getRepoPath: resolveProjectRoot,
      getMissions: () => missionsRef.current,
      nextMissionId,
      defaultModelId: () => getDefaultModelIdForMode(getProviderMode()),
      onFire: ({ loop, childMission, permissionMode }) => {
        setState((prev) => ({
          ...prev,
          missions: pruneMissions([...prev.missions, childMission]),
        }));

        const stopFlag = { stopped: false, controller: new AbortController() };
        stopFlags.current.set(childMission.id, stopFlag);
        const pauseFlag = { paused: false };
        pauseFlags.current.set(childMission.id, pauseFlag);
        const interveneQueue = { items: [] as string[] };
        interveneQueues.current.set(childMission.id, interveneQueue);

        resolveProjectRoot().then((root) => {
          // Journal: a loop iteration is a mission like any other — same
          // created-then-queued pair addMission emits, so loop-spawned
          // children are not a blind spot in the mission-lifecycle feed.
          // loop.tick/loop.iteration (loopScheduler.ts) cover the loop's OWN
          // bookkeeping separately.
          const loopChildProjectId = projectIdFromRoot(root);
          emitEvent({
            type: 'mission.created',
            tsMs: Date.now(),
            projectId: loopChildProjectId,
            missionId: childMission.id,
            actor: 'system',
            payload: { title: childMission.title, model: childMission.model, mission: childMission },
          });
          emitEvent({
            type: 'mission.queued',
            tsMs: Date.now(),
            projectId: loopChildProjectId,
            missionId: childMission.id,
            actor: 'system',
            payload: {},
          });

          // Provider-aware scheduler (T1.1) — same wrapping as addMission's
          // launch above, so recurring loop iterations count against the
          // exact same pools/caps a manually-launched mission would.
          schedulerDispatch(
            childMission,
            () => runMission(childMission, root, {
              onUpdate: applyRunUpdate,
              stopSignal: () => stopFlag.stopped,
              signal: stopFlag.controller.signal,
              pauseSignal: () => pauseFlag.paused,
              drainIntervenes: () => {
                const pending = interveneQueue.items;
                interveneQueue.items = [];
                return pending;
              },
              // DEFECT D: loop children used to run with permissionMode
              // undefined -> runtime.ts's 'default' -> the native CLI stalls on
              // an interactive approval prompt that never appears in-app
              // ("AWAITING PERMISSION" forever). The loop now carries its own
              // permissionMode (defaulted to 'acceptEdits' at creation, see
              // create_loop below), threaded through by loopScheduler.
              permissionMode,
              // tRef (not `t` directly): this onFire callback is registered
              // ONCE by the effect below ([applyRunUpdate] deps — see its own
              // header comment), so a captured `t` would freeze at whatever
              // locale was active on mount. tRef.current always reads the
              // CURRENT locale's translator (see tRef's own doc comment).
              t: tRef.current,
            }).then(async () => {
              // After mission completes, update the durable loop state
              const completed = missionsRef.current.find((m) => m.id === childMission.id);
              const result = completed?.liveAction ?? completed?.actionTimeline?.slice(-1)?.[0]?.text ?? 'completed';
              const filesCreated = completed?.actionTimeline
                ?.filter((e) => e.text.includes('write_file') || e.text.includes('Successfully wrote'))
                .map((e) => e.text.match(/note\d+\.md/)?.[0])
                .filter(Boolean) as string[] ?? [];
              await updateLoopState(root, loop.missionId, childMission.loopIteration ?? 1, result, filesCreated);
            }).catch((err: unknown) => {
              // Re-thrown (not silently swallowed) so schedulerDispatch can
              // observe a rate-limit-shaped failure for this pool's backoff —
              // this chain has always been best-effort/fire-and-forget from
              // every caller's perspective, so re-throwing changes nothing
              // user-visible.
              throw err;
            }),
            { projectId: loopChildProjectId, priority: 0 },
          );
        }).catch(() => { /* best-effort */ });
      },
      // Trust-critical defect #2 — "make it visible ... say WHY in the
      // mission's status reason, in the user's language": fired once per
      // loop tick() just disabled (see loopEngine.ts's LoopStopReason).
      // Stamps the loop's own ANCHOR mission (loop.missionId) with a plain
      // French explanation, appended to whatever statusReason it already
      // carries from its own terminal transition — never overwriting real
      // information about why the mission itself failed. Goes through
      // updateMissionRef (not `updateMission` directly) for the same reason
      // the effect right above this one exists: this scheduler effect is
      // deliberately created ONCE ([applyRunUpdate] deps, never
      // [state.missions] — see this effect's own header comment), so a
      // direct `updateMission` closure would go stale the moment its own
      // deps (t/toast/triggerAutoMergeIfEligible) change identity.
      onAutoDisabled: (loop, reason) => {
        const mission = missionsRef.current.find((m) => m.id === loop.missionId);
        updateMissionRef.current({
          id: loop.missionId,
          patch: { statusReason: formatLoopStopStatusReason(reason, mission?.statusReason) },
        });
      },
    });

    return stop;
    // applyRunUpdate has a stable ([]) identity (see its own doc comment) —
    // adding it here does not risk recreating this deliberately-once-only
    // effect the way `state.missions` did (see missionsRef/loopScheduler.ts
    // for that history).
  }, [applyRunUpdate]);

  // ── Night shift: autonomous brain maintenance standing loops ────────
  // Runs consolidation + root trunk promotion + failed mission review
  // on a periodic basis. No-op in web/demo mode (requires Tauri backend).
  useEffect(() => {
    const stop = startNightShift();
    return stop;
  }, []);

  // ── Chain engine: Agent Canvas W3 (spec §7) ──────────────────────────
  // Wired exactly once (empty deps, same "created once for the provider's
  // whole lifetime" contract as the loop scheduler above) — initChainEngine
  // is itself idempotent (see chainEngine.ts's module header) so React
  // StrictMode's dev-mode double-mount can never register duplicate
  // `project://changed` listeners. `addMission` is intentionally omitted
  // from the deps array: it is itself a stable useCallback ([t, toast]) and
  // re-running init on every addMission identity change would re-trigger
  // the startup reconcile pointlessly — deps.addMission here always calls
  // through to the LATEST addMission via addMissionRef (see below), exactly
  // like stateRef keeps updateMission/applyRunUpdate reading live state
  // without needing to be in a dependency array themselves.
  const addMissionRef = useRef(addMission);
  useEffect(() => {
    addMissionRef.current = addMission;
  }, [addMission]);
  useEffect(() => {
    const dispose = initSgrChainRunner({
      addMission: (input) => addMissionRef.current(input),
      getActiveProjectId: async () => projectIdFromRoot(await resolveProjectRoot()),
      defaultModelId: () => getDefaultModelIdForMode(getProviderMode()),
      waitForMissions: async (missionIds: string[]) => {
        // Poll missions until all reach terminal status
        const terminal = new Set(['done', 'failed', 'cancelled']);
        const result: Mission[] = [];
        for (const id of missionIds) {
          let mission = stateRef.current.missions.find((m) => m.id === id);
          while (mission && !terminal.has(mission.status)) {
            await new Promise((r) => setTimeout(r, 100));
            mission = stateRef.current.missions.find((m) => m.id === id);
          }
          if (mission) result.push(mission);
        }
        return result;
      },
      projectRoot: '', // Resolved per-run in practice
    });
    // Also init canvas chain ops (pin/refire deps)
    initCanvasChainOps({
      addMission: (input) => addMissionRef.current(input),
      getActiveProjectId: async () => projectIdFromRoot(await resolveProjectRoot()),
      defaultModelId: () => getDefaultModelIdForMode(getProviderMode()),
    });
    return dispose;
  }, []);

  // ── Loop operations ──────────────────────────────────────────────

  const toggleLoop = useCallback(async (id: string, enabled: boolean) => {
    const root = await resolveProjectRoot();
    if (enabled) {
      await enableLoop(root, id);
    } else {
      await disableLoop(root, id);
    }
    setState((prev) => ({
      ...prev,
      missions: prev.missions.map((m) =>
        m.id === id && m.loopConfig
          ? { ...m, loopConfig: { ...m.loopConfig, enabled } }
          : m,
      ),
    }));
  }, []);

  /**
   * « Passer la prochaine » (Agent Canvas W5a) — advances the loop's
   * `nextRunAt` by one cadence via the pure `skipNextRun` (loopEngine.ts),
   * then persists it through the SAME real path `toggleLoop` above uses
   * (`updateLoop` -> .lazy/loops.json), mirroring its read-current-state
   * -> compute -> persist -> patch React state shape. Reads the current
   * loopConfig from `state.missions` (already kept in sync by toggleLoop/
   * the loop scheduler) rather than re-reading loopEngine's own file, since
   * that's the same source of truth every other loop mutation here trusts.
   * A no-op (never throws) when the mission isn't a live loop.
   */
  const skipLoopNextRun = useCallback(async (id: string) => {
    const mission = state.missions.find((m) => m.id === id);
    if (!mission?.loopConfig) return;
    const root = await resolveProjectRoot();
    const nextConfig = skipNextRun(mission.loopConfig);
    await updateLoop(root, id, { loopConfig: nextConfig });
    setState((prev) => ({
      ...prev,
      missions: prev.missions.map((m) => (m.id === id && m.loopConfig ? { ...m, loopConfig: nextConfig } : m)),
    }));
  }, [state.missions]);

  const deleteLoop = useCallback(async (id: string) => {
    const root = await resolveProjectRoot();
    await unregisterLoop(root, id);
    setState((prev) => ({
      ...prev,
      missions: prev.missions.filter((m) => m.id !== id),
      selectedMissionId: prev.selectedMissionId === id ? null : prev.selectedMissionId,
    }));
  }, []);

  /**
   * Section 4 gate 1 ("figé une seule fois ... jamais régénéré à chaque
   * tour") — freezes a NEW version of a loop's reusable artifact (a design
   * template, a tone brief, anything generic — never a domain-specific
   * shape, see loopArtifact.ts's own doc comment) and, when `missionId`
   * resolves to a REGISTERED loop, attaches the reference onto its
   * `loopConfig.templateArtifactRef` (only when not already set — an
   * EXISTING reference is never silently repointed to a new owner id here;
   * a caller that wants to freeze a NEW version under the same reference
   * should pass that reference back as `missionId` itself). Safe to call
   * for a one-time mission's own id too (spec §4's own note: a unique task
   * can still freeze a reusable artifact with no loop at all) — the
   * `templateArtifactRef` attach step is simply skipped when no loop is
   * registered under that id.
   */
  const freezeLoopTemplate = useCallback(async (missionId: string, kind: string, content: unknown, label?: string) => {
    const root = await resolveProjectRoot();
    const version = await freezeLoopArtifact(root, missionId, kind, content, label);
    const loop = await getLoop(root, missionId);
    if (loop && !loop.loopConfig.templateArtifactRef) {
      await updateLoop(root, missionId, { loopConfig: { ...loop.loopConfig, templateArtifactRef: missionId } });
    }
    return version;
  }, []);

  /**
   * Section 6 ("Ingestion d'une mesure externe") — attaches one named,
   * externally-sourced metric to a past execution. Fully generic: a metric
   * name, a source, a numeric value — never a schema specific to a social
   * network or content format (see loopMetrics.ts's own doc comment).
   * `loopId` is optional (denormalized for fast per-loop lookups) and
   * should be the mission's OWN `loopParentId` when the execution being
   * measured was a loop iteration.
   */
  const recordExternalMetric = useCallback(
    async (missionId: string, metricName: string, source: string, value: number, loopId?: string) => {
      const root = await resolveProjectRoot();
      return recordExternalMetricEntry(root, { missionId, loopId, metricName, source, value });
    },
    [],
  );

  // ── Bulk operations ──────────────────────────────────────────────

  /**
   * Stop every running mission (optionally filtered by title keyword).
   * Same worktree-cleanup fix as stopMission above, applied per mission —
   * see cleanupStoppedWorktree's doc comment. The filter/flag/status logic
   * itself reads state.missions from the outer closure (rather than a
   * setState updater callback) so the cleanup loop can run right alongside
   * it without any async work inside the updater.
   */
  const stopAll = useCallback((filter?: string) => {
    // Money incident (2026-08-14, real-app QA — "Stoppe tout" clicked, credit
    // balance kept falling: 867 -> 841 with no new mission launched): this
    // used to filter on `m.status === 'running'` ONLY, so a mission still
    // 'queued' (sitting in scheduler.ts's own internal queue behind a full
    // concurrency pool, or simply not yet dispatched) was never touched here
    // — its stopFlag stayed `{ stopped: false }` forever, so the moment a
    // pool slot later freed up, scheduler.ts's drain() launched its `launchFn`
    // (the wrapped runMission call) exactly as if Stop had never been
    // clicked, billing credits for a mission the user explicitly stopped.
    // `wasLive` below mirrors discardMission's own STOP-ON-DELETE fix
    // (2026-08-05, M25) and stopMission's status-agnostic flag flip — both
    // already treat 'running' and 'queued' as equally "live and must be
    // stopped"; stopAll was the one remaining call site still narrower than
    // its own siblings.
    const isLive = (m: Mission) => m.status === 'running' || m.status === 'queued';
    const toStop = state.missions.filter(
      (m) => isLive(m) && (!filter || String(m.title ?? '').toLowerCase().includes(filter.toLowerCase())),
    );
    for (const m of toStop) {
      const flag = stopFlags.current.get(m.id);
      if (flag) {
        flag.stopped = true;
        // Abort a turn already streaming, not just prevent the next one —
        // see stopFlags' own doc comment. Harmless no-op for a mission still
        // genuinely 'queued' (nothing has started streaming yet); for one
        // whose runMission call already began, this is what actually stops
        // the billed ai-proxy/BYOK request instead of letting it finish.
        flag.controller.abort();
      }
    }

    setState((prev) => ({
      ...prev,
      missions: prev.missions.map((m) =>
        isLive(m) && (!filter || String(m.title ?? '').toLowerCase().includes(filter.toLowerCase()))
          ? { ...m, status: 'cancelled' as const, liveAction: undefined }
          : m,
      ),
    }));

    for (const m of toStop) {
      if (!m.worktree) continue;
      const branch = m.worktree;
      // Same kill-before-cleanup ordering as stopMission above — see its
      // doc comment for why.
      killAgentRun(m.id)
        .then(() => resolveProjectRoot())
        .then((repoPath) => cleanupStoppedWorktree(repoPath, branch))
        .catch(() => { /* best-effort — see cleanupStoppedWorktree */ });
    }
  }, [state.missions]);

  /**
   * Reject-with-feedback (W8c gate v2, deliverable #2) — investigated the
   * real primitives before wiring this: `interveneMission` only delivers
   * into a mission whose `status === 'running'` (its own guard, above) — a
   * 'review' mission (this gate's whole subject) is never running, so
   * calling it here would be a silent, honest-looking no-op. The honest best
   * path instead folds "reject" directly into THIS primitive: when
   * `opts.feedback` is set, the clone's task gets the feedback appended (same
   * "## <heading>" append convention chainEngine.ts's buildContextBlock uses
   * for upstream context, applied here for rejection feedback instead), and a
   * REAL `mission.rejected` journal event (eventTypes.ts — already in the
   * vocabulary, already read by missionHistory.ts's TERMINAL_EVENT_TYPES/
   * archive, but had no emitter anywhere in the app before this) is recorded
   * against the ORIGINAL mission id — never the freshly-minted retry clone's
   * id, and never a new/invented Mission.status value.
   *
   * Honesty fix (C1, real user test — a card read "Relancer la mission M44
   * — Approuvée" while M44 stayed in 'review', no clone existed, and the
   * approval queue was empty): this used to be a plain `(id, opts) => void`
   * that silently no-op'd INSIDE its own setState updater (`if (!original)
   * return prev`) whenever `id` no longer resolved to a real mission —
   * indistinguishable from success to approvePendingAction, which only
   * resolves an entry positive when the executor it awaits actually THROWS
   * on failure (see approvePendingAction's own doc comment). retryMission is
   * now async and throws BEFORE touching state when the mission cannot be
   * found, so a caller that awaits it (executeManagerAction's retry_mission/
   * reject_mission cases) genuinely fails instead of reporting a phantom
   * retry. The existence check reads stateRef.current — same
   * read-live-state-outside-setState convention this file already uses
   * (see e.g. addMission's budget-cap check) — and everything that used to
   * live inside the setState updater (clone construction, flag registration,
   * the fire-and-forget launch) now runs in the function body instead, so
   * the check can run first: the missions-array update still commits
   * synchronously right after (same observable timing as before for the
   * success path), it just never happens at all on the failure path.
   */
  const retryMission = useCallback(async (
    id: string,
    opts?: {
      feedback?: string;
      newTask?: string;
      newModel?: string;
      newModelId?: string;
      newBaseBranch?: string;
      /** Set ONLY by the boot-resilience auto-retry effect below — never by
       *  a human-initiated retry (the "Relancer" button, the manager's
       *  retry_mission action). Selects the clone's `autoRetryLineageDepth`
       *  (source's depth + 1, capped/checked by that same effect's
       *  eligibility filter) instead of the manual-retry default (0) — see
       *  Mission.autoRetryLineageDepth's own doc comment (types.ts) for the
       *  restart -> retry -> restart chain incident this distinguishes
       *  against. */
      isAutoRetry?: boolean;
    },
  ): Promise<void> => {
    const original = stateRef.current.missions.find((m) => m.id === id);
    if (!original) {
      throw new Error(t('agents.manager.missionNotFound', { id }));
    }

    // Continuation Doctrine REVERSAL (2026-08-02, real incident — lazy-
    // backoffice missions M9/M10: the manager was explicitly asked to
    // relaunch both steps from a corrected baseBranch, chose retry_mission
    // over launch_mission, and the retry silently kept the ORIGINAL
    // mission's empty base — the requested re-root never took effect and
    // NOTHING told the manager or the user it had been dropped). baseBranch
    // (Mission.baseBranch's own doc comment, types.ts) is a mission-
    // CREATION parameter: it only ever matters at the single moment
    // createWorktree runs. A retry's clone below always gets a brand-new
    // worktree (its `branch` derives from the fresh `newId`, never the
    // original's), so mechanically threading a changed baseBranch through
    // IS possible — but doing so quietly conflates two different asks:
    // "redo this exact mission" (retry — same lineage, same starting
    // point) versus "start over from a different point" (a genuinely new
    // mission). Blurring that distinction again is exactly what produced
    // the M9/M10 incident. Chosen semantics: a retry NEVER changes the base
    // branch — a real change is refused outright, loudly, BEFORE any state
    // mutation (same "throw before touching state" contract as the
    // missionNotFound check above), naming the mission and telling the
    // caller to launch_mission instead. A baseBranch identical to the
    // original's (including both unset) is not a change and is left alone —
    // today's plain-retry behavior, no regression.
    const requestedBaseBranch = opts?.newBaseBranch?.trim() || undefined;
    if (isRetryBaseBranchChangeBlocked(original.baseBranch, requestedBaseBranch)) {
      throw new Error(
        t('agents.manager.retryBaseBranchRefused', { id, requested: requestedBaseBranch as string }),
      );
    }

    const feedback = opts?.feedback?.trim();
    // Retry-with-edit friction fix — a real edit only counts when it
    // actually differs from the current task; a blank/identical newTask is
    // not a correction, so it never touches agentTask/taskAmendedFrom below
    // (same "no-op edit changes nothing" honesty every other amend path in
    // this file follows).
    const previousTask = original.agentTask ?? original.title;
    const newTask = opts?.newTask?.trim();
    const taskAmended = Boolean(newTask && newTask !== previousTask);
    const baseTask = taskAmended ? (newTask as string) : previousTask;
    // R13 (model-routing fix) — same resolveManagerModelId treatment as
    // clone_mission's own mods.model/modelId: a bare tier hint or an exact
    // catalog id, resolved against whichever rail is actually in effect;
    // absent when the retry doesn't change the model at all.
    const resolvedModel = (opts?.newModel || opts?.newModelId)
      ? resolveManagerModelId(opts?.newModel, getProviderMode(), undefined, opts?.newModelId)
      : undefined;
    const newId = nextMissionId(stateRef.current.missions);
    const clone: RevertableMission = {
      ...(original as RevertableMission),
      id: newId,
      status: 'queued',
      ...((taskAmended || feedback)
        ? { agentTask: feedback ? `${baseTask}\n\n## ${t('agents.retry.feedbackHeader')}\n${feedback}` : baseTask }
        : {}),
      // Preserve the ORIGINAL wording an earlier verdict was actually judged
      // against — see Mission.taskAmendedFrom's own doc comment (types.ts).
      // Never set on a plain retry (no edit) or a feedback-only reject.
      ...(taskAmended ? { taskAmendedFrom: previousTask } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
      // baseBranch is deliberately NOT overridden here — the guard above
      // already refused any real change, so `...original` above already
      // carries forward the only baseBranch a retry is allowed to have.
      // Stall/failure honesty fix: this field used to be absent from the
      // reset list below, so a mission retried after ANY statusReason (a
      // failed run's error, the queued-launch watchdog's 'launch_stalled',
      // ...) silently carried the OLD reason onto the fresh clone, showing
      // a stale explanation on a brand new 'queued' mission (progress 0,
      // no actions yet) that has not even attempted to launch. A retry
      // must start clean.
      statusReason: undefined,
      progress: 0,
      planSteps: [],
      actionTimeline: [],
      liveAction: undefined,
      judgeVerdict: undefined,
      judgesApproved: undefined,
      merged: undefined,
      loopIteration: undefined,
      loopParentId: undefined,
      // T1.7: a retried mission starts fresh — it was never merged nor
      // reverted yet, regardless of what the ORIGINAL mission's history
      // was. Without this, retrying a done-and-reverted mission would
      // silently clone stale mergeSha/reverted onto a brand new 'queued'
      // mission (both additive fields ride along on any plain `{...original}`
      // spread otherwise, since neither is in the explicit reset list above
      // this comment predates).
      mergeSha: undefined,
      reverted: undefined,
      // Boot-resilience auto-retry (Mission.autoRetriedAfterRestart's own
      // doc comment, types.ts): a retry clone is a BRAND NEW mission with
      // its own id — it must start eligible for its own one-shot auto-retry
      // if IT is later interrupted by a restart, never inheriting the
      // ORIGINAL's stamp via the plain `{...original}` spread above.
      autoRetriedAfterRestart: undefined,
      // Lineage depth cap (Mission.autoRetryLineageDepth's own doc comment,
      // types.ts) — the field autoRetriedAfterRestart alone could not
      // prevent (an unbounded restart -> retry -> restart clone chain).
      // ONLY the boot-resilience effect's own call passes isAutoRetry, and
      // only that call advances depth (source + 1); every human-initiated
      // retry (button, manager action) resets depth to 0 — a person
      // re-launching a mission always starts a fresh lineage.
      autoRetryLineageDepth: opts?.isAutoRetry ? (original.autoRetryLineageDepth ?? 0) + 1 : 0,
    };
    // Launch the retry — flags registered and the clone committed to state
    // synchronously (still before any `await` below), matching the pre-fix
    // timing for the success path.
    const stopFlag = { stopped: false, controller: new AbortController() };
    stopFlags.current.set(newId, stopFlag);
    const pauseFlag = { paused: false };
    pauseFlags.current.set(newId, pauseFlag);
    const interveneQueue = { items: [] as string[] };
    interveneQueues.current.set(newId, interveneQueue);
    // T1.3/W-GUARD parity with addMission (SECURITY fix — retryMission used
    // to omit these entirely, so a retried mission ran with NO budget cap
    // and NO wall-clock limit even when its contract specified one). Same
    // live-getter/pause-bridge contract as addMission: read stateRef.current
    // (not the clone const) so a cap raised via updateMission mid-run is
    // visible on the loop's next check, and onBudgetPaused/onDurationPaused
    // reuse this EXACT pauseFlag cell so a budget/duration-triggered pause is
    // resumable via the existing Resume button.
    const getBudgetCapUsd = () =>
      stateRef.current.missions.find((m) => m.id === newId)?.contract?.budgetCapUsd;
    const onBudgetPaused = () => {
      pauseFlag.paused = true;
      updateMission({ id: newId, patch: { paused: true } });
    };
    const getMaxDurationMs = () =>
      stateRef.current.missions.find((m) => m.id === newId)?.contract?.maxDurationMs;
    const onDurationPaused = () => {
      pauseFlag.paused = true;
      updateMission({ id: newId, patch: { paused: true } });
    };
    setState((prev) => ({ ...prev, missions: pruneMissions([...prev.missions, clone]) }));

    // LazyBot retry — the clone carries botId via the {...original} spread;
    // register it as the bot's active run (same tracking launchBotRun does)
    // so list/stop and the canvas bot node stay honest, and finish it (+
    // release Solari sessions) when the run ends.
    if (clone.botId) registerBotRun(clone.botId, newId);

    resolveProjectRoot().then((root) => {
      runMission(clone, root, {
        onUpdate: applyRunUpdate,
        stopSignal: () => stopFlag.stopped,
        signal: stopFlag.controller.signal,
        pauseSignal: () => pauseFlag.paused,
        drainIntervenes: () => {
          const pending = interveneQueue.items;
          interveneQueue.items = [];
          return pending;
        },
        // R13 (same DEFECT D/2 class fixed at every other launch path):
        // this call used to omit permissionMode entirely, so a retry ran
        // with runtime.ts's 'default' fallback -> the native CLI could
        // stall on an interactive approval prompt that never appears
        // in-app. Preserve the ORIGINAL mission's configured mode (a retry
        // is a re-run, not a fresh choice) and only fall back to
        // 'acceptEdits' when the original never carried one (e.g. a
        // pre-T1.2 mission, or one launched via a path with no contract).
        permissionMode: clone.contract?.permissionMode ?? 'acceptEdits',
        // SECURITY fix: retryMission used to transmit ONLY permissionMode,
        // silently dropping allowedTools/deniedTools (a tool-restricted
        // mission could use ALL tools after retry) and the budget/duration
        // getters (caps disabled on retry). The clone inherits the ORIGINAL
        // mission's stored allowedTools/deniedTools via the {...original}
        // spread (addMission now persists them), so a retry re-threads the
        // SAME restriction — never a silent widening. Falls back to
        // undefined (addMission's own default) when the original never
        // carried any.
        allowedTools: (clone as Mission & { allowedTools?: string[] }).allowedTools,
        deniedTools: (clone as Mission & { deniedTools?: string[] }).deniedTools,
        getBudgetCapUsd,
        onBudgetPaused,
        getMaxDurationMs,
        onDurationPaused,
        t,
      }).then(() => {
        if (clone.botId) void finishBotRun(newId);
      }).catch(() => {
        // Best-effort: same reasoning as the takeover continuation above —
        // runMission surfaces its own failure through onUpdate/applyRunUpdate
        // (the retried mission's card), so this outer catch only guards the
        // fire-and-forget call itself from an unhandled rejection.
        if (clone.botId) void finishBotRun(newId);
      });
    });

    if (feedback) {
      // Brain-integration wave — "the brain learns David's review
      // standards": records the rejection feedback as a REAL decision
      // neuron via lib/brain/decisions.ts's createDecision, the SAME
      // primitive missionQuestion.ts's recordMissionAnswer uses to pair a
      // mission's ask_user question with its human answer (see that
      // module's own doc comment). Here the "question" half is the review
      // context (mission title + judge verdict summary — buildRejectionReviewQuestion,
      // below) and the "answer" half is David's literal feedback text, so a
      // FUTURE recall (this mission's own retry, or a similar one) can
      // surface this exact review standard instead of the agent repeating
      // the same mistake. Best-effort (void, no await) — never blocks or
      // fails the retry itself; createDecision already never throws.
      // `original` is already known real here (the throw above guarantees
      // it), so this no longer needs its own separate stateRef re-lookup.
      void createDecision({
        question: buildRejectionReviewQuestion(original),
        answer: feedback,
        scope: 'project',
      });

      resolveProjectRoot()
        .then((root) => {
          void emitEvent({
            type: 'mission.rejected',
            tsMs: Date.now(),
            projectId: projectIdFromRoot(root),
            missionId: id,
            actor: 'user',
            payload: { reason: feedback },
          });
        })
        .catch(() => {
          /* best-effort — mirrors interveneMission's own journal write */
        });
    }
  }, [applyRunUpdate, updateMission, t]);

  /**
   * Boot-resilience auto-retry (product requirement — agents must succeed,
   * the app recovers on its own, never leaving a restart-interrupted
   * mission dead): a mission the boot recovery pass above flipped to
   * 'failed' with `agents.recoveredOnRestart` (applyReplayRecovery / the
   * legacy missions.json fallback) never progresses again by itself — the
   * agent process that was driving it is gone, and nothing restarts it
   * automatically. When such a mission's OWN contract explicitly opted OUT
   * of human approval (`contract.gates.humanApprove === false`), this
   * schedules exactly ONE automatic `retryMission` call for it, fired
   * after `AUTO_RETRY_GRACE_PERIOD_MS` (60s — see that constant's own doc
   * comment for the real incident: the human/manager needs a real window
   * to delete a mission they do NOT want relaunched before it comes back
   * on its own). A mission with no contract, or `humanApprove` true/
   * absent, is left exactly as `agents.recoveredOnRestart` already leaves
   * it today — unchanged behavior, the human decides.
   *
   * Runs as a plain effect over `state.missions` (real committed React
   * state) rather than inline in the boot-load effect above. Declared
   * AFTER retryMission itself (this file's normal top-to-bottom closure
   * order) so no forward-reference ref is needed here, unlike
   * relaunchQueuedMissionRef above; the grace-period delay ALSO means the
   * timer callback fires long after any render/commit cycle, so
   * `stateRef.current` (synced from its own later effect) is always fresh
   * by the time it actually reads live state — no staleness risk there.
   *
   * Idempotency (never a restart -> retry -> restart loop) — TWO layers:
   * `autoRetryDispatchedRef` blocks a same-session double-SCHEDULE (e.g.
   * StrictMode's deliberate double-invoke, or an unrelated state change
   * re-running this effect while a timer is still pending) the INSTANT a
   * mission becomes eligible — before the grace period even starts. The
   * persisted `autoRetriedAfterRestart` stamp (types.ts, reset to
   * undefined on every retry clone — see retryMission's own reset list
   * above) is written only once the timer actually FIRES (never at
   * schedule time): if the app restarts again during the grace window
   * (timer never fires), the mission must stay eligible for a fresh
   * grace-period retry on the NEXT boot, not be silently abandoned. Neither
   * of those two, on its own, ever stopped the SAME lineage from looping
   * forever across clones though (2026-08-05 incident, M9 -> M13, 5 clones
   * in one night): `autoRetriedAfterRestart` is DELIBERATELY reset to
   * undefined on every clone (so a genuinely new mission earns its own
   * one-shot retry), which means it looks just as fresh as a first-time
   * mission to this effect's eligibility filter if THAT clone is itself
   * interrupted. `autoRetryLineageDepth` (types.ts) is the real cross-clone
   * guard: the eligibility filter below also refuses any mission at depth
   * >= 1 (already an auto-retry's own clone) — ONE automatic relaunch per
   * lineage, full stop, regardless of how many restarts follow. A human can
   * always retry manually past that point (resets depth to 0).
   *
   * Cancellation (2026-08-04 real incident: a user needed to delete an
   * interrupted mission before it silently relaunched itself):
   * `autoRetryTimersRef` tracks every still-pending grace-period timer by
   * mission id. On every effect run (i.e. whenever `state.missions`
   * changes — including a delete), any pending timer whose mission id no
   * longer exists in `state.missions` is cleared outright. The timer
   * callback ALSO re-checks full eligibility against live `stateRef`
   * state right before acting (never trusting its own closure's
   * snapshot) — a defensive second check for a delete that lands between
   * renders, or any other change that makes the mission no longer a fit
   * (contract changed, already retried through another path).
   */
  const autoRetryDispatchedRef = useRef<Set<string>>(new Set());
  const autoRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Unmount safety: never leak a pending grace-period timer past this
  // component's life (relevant for tests/hot-reload — a real app instance
  // normally lives for the whole session).
  useEffect(() => {
    return () => {
      for (const timer of autoRetryTimersRef.current.values()) clearTimeout(timer);
      autoRetryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const missionIds = new Set(state.missions.map((m) => m.id));
    for (const [missionId, timer] of autoRetryTimersRef.current) {
      if (missionIds.has(missionId)) continue;
      clearTimeout(timer);
      autoRetryTimersRef.current.delete(missionId);
      console.warn(`[boot-auto-retry] mission ${missionId} deleted during its grace period -> scheduled auto-retry cancelled`);
    }

    const restartReason = t('agents.recoveredOnRestart');
    const eligible = state.missions.filter(
      (m) =>
        m.status === 'failed' &&
        m.statusReason === restartReason &&
        m.contract?.gates?.humanApprove === false &&
        !m.autoRetriedAfterRestart &&
        // Lineage cap (types.ts's Mission.autoRetryLineageDepth doc
        // comment) — ONE automatic relaunch per lineage: a mission at depth
        // >= 1 is itself an earlier auto-retry's clone, interrupted again.
        // autoRetriedAfterRestart alone never caught this (a clone never
        // inherits it), which is exactly what produced the real M9 -> M13
        // 5-clone chain this field fixes.
        (m.autoRetryLineageDepth ?? 0) < 1 &&
        !autoRetryDispatchedRef.current.has(m.id),
    );
    if (eligible.length === 0) return;

    const retryNote = t('agents.autoRetriedAfterRestart');
    for (const mission of eligible) {
      autoRetryDispatchedRef.current.add(mission.id);
      const missionId = mission.id;
      console.warn(`[boot-auto-retry] mission ${missionId} restart-interrupted, contract.gates.humanApprove=false -> scheduling auto-retry in ${AUTO_RETRY_GRACE_PERIOD_MS}ms (cancelled if deleted first)`);
      const timer = setTimeout(() => {
        autoRetryTimersRef.current.delete(missionId);
        // Re-check full eligibility against LIVE state, never the
        // closure's stale snapshot — see this effect's own doc comment.
        const live = stateRef.current.missions.find((m) => m.id === missionId);
        const stillEligible =
          live &&
          live.status === 'failed' &&
          live.statusReason === restartReason &&
          live.contract?.gates?.humanApprove === false &&
          !live.autoRetriedAfterRestart &&
          (live.autoRetryLineageDepth ?? 0) < 1; // lineage cap — see the eligible filter above
        if (!stillEligible) return;
        updateMission({
          id: missionId,
          patch: {
            autoRetriedAfterRestart: true,
            actionTimeline: [
              ...(live.actionTimeline ?? []),
              { time: new Date().toLocaleTimeString(), text: retryNote, isLive: false },
            ],
          },
        });
        console.warn(`[boot-auto-retry] mission ${missionId} grace period elapsed -> auto-retrying now`);
        retryMission(missionId, { isAutoRetry: true }).catch(() => {
          // Best-effort — the ORIGINAL mission stays exactly 'failed'/
          // recoveredOnRestart as before; the stamp above still prevents a
          // second automatic attempt (the human can always retry manually
          // from the card).
        });
      }, AUTO_RETRY_GRACE_PERIOD_MS);
      autoRetryTimersRef.current.set(missionId, timer);
    }
  }, [state.missions, t, updateMission, retryMission]);

  const deleteMission = useCallback((id: string) => {
    // B2 fix (journal-first deletion) — captured BEFORE the state removal
    // below so the tombstone write further down still has the mission's
    // own repoRoot/snapshot to work with; state.missions itself no longer
    // will.
    const mission = stateRef.current.missions.find((m) => m.id === id);

    // STOP-ON-DELETE fix (2026-08-05, real prod incident — M25): deleting a
    // running/queued mission used to only tombstone the journal row and
    // drop it from React state — the underlying runtime (managed ReAct loop
    // or native one-shot process) kept running untouched, kept spending,
    // and kept emitting its own progress straight onto the journal's
    // missions_current row for this id, with no `archived` flag — silently
    // undoing the tombstone below the instant the next one landed (the
    // mission "resurrected" on the board). Mirrors stopMission's own real
    // primitive EXACTLY (same stopFlag flip + killAgentRun call, see that
    // function's doc comment) so a delete of a live mission actually stops
    // it — BEFORE the tombstone is written — instead of merely hiding it
    // from this session's own state while it keeps running unseen.
    const wasLive = mission?.status === 'running' || mission?.status === 'queued';
    if (wasLive) {
      const flag = stopFlags.current.get(id);
      if (flag) {
        flag.stopped = true;
        // Money incident (2026-08-14) — abort a turn already streaming, not
        // just prevent the next one. See stopFlags' own doc comment.
        flag.controller.abort();
      }
      // Best-effort/fire-and-forget, exactly like stopMission's own call —
      // a native one-shot process has no other way to stop mid-run; a
      // managed mission's loop is already halted by the stopFlag flip above
      // (polled between ReAct steps), so this is a harmless no-op for it.
      void killAgentRun(id).catch(() => { /* best-effort */ });
    }
    // Never re-journal this id again even if it somehow still shows up in
    // state.missions on a later render (belt-and-suspenders for the
    // debounce-save effect — see tombstonedMissionIdsRef's own doc
    // comment). Recorded synchronously, before the tombstone write below
    // even starts.
    tombstonedMissionIdsRef.current.add(id);

    setState((prev) => ({
      ...prev,
      missions: prev.missions.filter((m) => m.id !== id),
      selectedMissionId: prev.selectedMissionId === id ? null : prev.selectedMissionId,
    }));
    // ZOMBIE LOOP fix — a deleted mission drops out of React state entirely,
    // but a loop registered under its id would otherwise keep firing new
    // iterations forever against a mission that no longer exists anywhere
    // in the UI. Unregister (not just disable) since the mission itself is
    // gone, not merely terminal — see stopLoopForTerminalMission's doc
    // comment. Best-effort/fire-and-forget, same as every other
    // side-journal call in this file.
    void resolveProjectRoot()
      .then((root) => {
        stopLoopForTerminalMission(root, id, 'unregister', 'deleted').catch(() => {
          /* best-effort */
        });
        // B2 fix — once removed from state.missions above, the debounce-save
        // effect will NEVER journal this mission again (it only iterates
        // `state.missions`), so without this explicit tombstone a durable
        // journal-backed boot (loadMissionsFromJournal) silently resurrects
        // it from its last-journaled snapshot. See
        // tombstoneJournalMission's own doc comment. Uses the mission's OWN
        // `repoRoot` (never the active project) — the A fix this task also
        // makes.
        if (mission) {
          const projectId = projectIdFromRoot(mission.repoRoot ?? root);
          void tombstoneJournalMission(id, projectId, mission);
        }
      })
      .catch(() => {
        /* best-effort — mirrors archiveMission's own journal write */
      });
  }, []);

  /**
   * R13 — mission lifecycle: "Archiver" hides a TERMINAL mission from the
   * Agent Canvas WITHOUT destroying anything. Unlike deleteMission (which
   * drops the mission from React state entirely), this only patches the
   * additive `archived` flag — the mission's own history keeps flowing
   * through the exact same journal path every other mission mutation does
   * (updateMission's own debounce-save effect flushes `mission.updated` with
   * the full snapshot, so `missions_current`/Replay/Rapport still see the
   * mission, unaffected — see Mission.archived's doc comment, types.ts).
   * A discrete `mission.archived` audit event is emitted alongside the patch
   * so history has a real, filterable marker of when/what-status the
   * archive happened at (same convention as mission.approved/rejected).
   */
  const archiveMission = useCallback((id: string) => {
    const mission = stateRef.current.missions.find((m) => m.id === id);
    if (!mission) return;
    updateMission({
      id,
      patch: {
        archived: true,
        // MEMORY FIX — free the heavy in-memory-only payload now that the
        // durable journal (SQLite via the Rust side — see Mission.archived's
        // own doc comment) is this mission's real source of truth: the
        // canvas reconciler already filters an archived mission out of the
        // live node set entirely (reconciler.ts's `!m.archived` filter), so
        // nothing renders these fields again once archived. Applied in the
        // SAME immutable patch as the `archived: true` flip above (one
        // updateMission call, one mergeMissionUpdate merge) rather than a
        // second setState.
        //   - actionTimeline (up to MAX_ACTION_TIMELINE_ENTRIES=500 entries)
        //     and diffSnippet (raw diff preview text) are dropped outright —
        //     nothing keeps a short-summary need for either post-archive.
        //   - judgeVerdict and compiledPlan are dropped too, but their own
        //     lightweight UI-backward-compat summaries — judgesApproved
        //     (string) and planSteps (derived array) respectively, see
        //     their own doc comments in types.ts — are deliberately left
        //     untouched, so a collapsed card still has something to show.
        //   - learningInsights (prose per entry) is dropped; diffFiles is
        //     deliberately NOT touched here — it is already just
        //     {filename, added, removed}, no diff content, cheap to keep.
        actionTimeline: [],
        diffSnippet: [],
        judgeVerdict: undefined,
        compiledPlan: undefined,
        learningInsights: [],
      },
    });
    void resolveProjectRoot()
      .then((root) =>
        Promise.all([
          emitEvent({
            type: 'mission.archived',
            tsMs: Date.now(),
            projectId: projectIdFromRoot(root),
            missionId: id,
            actor: 'user',
            payload: { statusAtArchive: mission.status },
          }),
          // ZOMBIE LOOP fix — an archived mission is terminal from the
          // canvas's own perspective; stop its registered loop, if any (see
          // stopLoopForTerminalMission's doc comment).
          stopLoopForTerminalMission(root, id, 'disable', 'archived'),
        ]),
      )
      .catch(() => {
        /* best-effort — mirrors interveneMission's own journal write */
      });

    // WORKTREE LEAK fix — archiving used to only ever patch the `archived`
    // flag above; it never reclaimed the mission's git worktree, so EVERY
    // archived mission left its worktree directory (and branch) on disk
    // forever — confirmed in this repo's own `.lazy/worktrees/` before this
    // fix (real orphans from real missions, not a hypothetical). The
    // automatic P58 fleet-hygiene sweep (runFleetHygieneSweep below) only
    // ever calls this function to archive a mission, so nothing downstream
    // ever reclaimed the disk either.
    //
    // Reuses the EXACT cleanup path stopMission/stopAll already use above
    // (killAgentRun -> resolveProjectRoot -> cleanupStoppedWorktree, which
    // is discardWorktree's Rust `agent_discard_worktree` ->
    // `cleanup_worktree_and_branch`) — never a second implementation.
    // Idempotent/best-effort either way: a 'done' mission's worktree was
    // already removed by the merge itself (agent_merge_worktree_inner,
    // git.rs, Step 3) and a 'cancelled' mission's by Stop/Reject, so this is
    // a harmless no-op for both (see cleanup_worktree_and_branch's own
    // idempotence tests, worktree_cleanup.rs) — the real target is 'failed',
    // whose worktree nothing else in this codebase ever cleaned up.
    //
    // Guarded to a genuinely TERMINAL mission (done/failed/cancelled) —
    // never 'review' or 'running': both still have a legitimately live,
    // mergeable worktree. Every current caller of archiveMission already
    // pre-filters to terminal missions (archiveTerminalMissions,
    // runFleetHygieneSweep's plan, CanvasContextMenu's terminal-only
    // "Archiver" entry, the manager's delete_mission isTerminal check) —
    // this guard makes that a structural property of archiveMission itself
    // rather than trust that every caller, present and future, pre-filters
    // correctly forever.
    const isTerminal = mission.status === 'done' || mission.status === 'failed' || mission.status === 'cancelled';
    if (isTerminal && mission.worktree) {
      const branch = mission.worktree;
      killAgentRun(id)
        .then(() => resolveProjectRoot())
        .then((repoPath) => cleanupStoppedWorktree(repoPath, branch))
        .catch(() => { /* best-effort — see cleanupStoppedWorktree */ });
    }
  }, [updateMission]);

  /**
   * « Archiver les terminées » (zone bulk action, R13): archives every
   * TERMINAL mission (done/failed/cancelled) among `missionIds` — the
   * caller (CanvasContextMenu's zone menu) supplies the exact node ids
   * currently rendered for that zone, so this never reaches outside what
   * the user actually saw. Non-terminal / already-archived / unknown ids
   * are silently skipped (never forced), same honesty rule as
   * checkApproveGate's non-forcing gates.
   */
  const archiveTerminalMissions = useCallback((missionIds: string[]) => {
    const idSet = new Set(missionIds);
    const targets = stateRef.current.missions.filter(
      (m) => idSet.has(m.id) && !m.archived && (m.status === 'done' || m.status === 'failed' || m.status === 'cancelled'),
    );
    for (const m of targets) archiveMission(m.id);
  }, [archiveMission]);

  // ── P58: automatic fleet hygiene sweep ────────────────────────────────
  //
  // FOUNDER DIRECTIVE: "hygiène naturelle et auto, fais en sorte que l'app
  // soit opti et sature pas ... chaque action manuelle prise pendant
  // l'audit = une chose qui manque dans l'app." A real audit session needed
  // a human to manually tell the manager to clean up 4 duplicate retry
  // attempts, months-old dead missions, stale signals, duplicate preview
  // placeholders, and e2e-scratch canvas debris — this sweep does all of it
  // on its own, applying fleetHygiene.ts's pure rules through the exact
  // same real primitives a manual cleanup would use (archiveMission, the
  // canvas store's removeSurface/removeDraft/removeNote — see this file's
  // own module header on why reading/writing canvasStoreVanilla directly
  // from here is the established pattern), so every change still leaves the
  // same audit trail a human action would.
  //
  // Re-entrant-safe (hygieneSweepInFlightRef) and throttled
  // (MIN_HYGIENE_SWEEP_INTERVAL_MS): a burst of terminal transitions must
  // never fire more than one real sweep in quick succession.
  const hygieneSweepInFlightRef = useRef(false);
  const lastHygieneSweepAtRef = useRef(0);

  /**
   * Section 4.4 ("Supervision continue") — reviews every registered loop
   * once per fleet-hygiene sweep: is it still running (stalled check), is a
   * step failing repeatedly, is its own learned measure declining. A
   * `repeated_failure` alert also pauses the loop outright (`disableLoop`)
   * — the "arrêt" half of spec §4's "retour en mode essai (ou un arrêt) au
   * premier échec ou anomalie" for a loop that keeps failing even after
   * `recordLoopFailure` already demoted it back to 'trial' (nothing lower
   * to demote to — see loopGate.ts's `recordFailure` doc comment). Every
   * alert is announced in the manager chat unconditionally (spec: "jamais
   * silencieuse") — never gated behind the wakeup scheduler's own
   * significance/rate-limit rules, since a supervision finding about an
   * autonomous regime is inherently significant regardless of count.
   */
  const runLoopSupervisionSweep = async (nowMs: number): Promise<void> => {
    const root = await resolveProjectRoot();
    const loops = await listLoops(root);
    if (loops.length === 0) return;

    const hygieneLoops: HygieneLoop[] = await Promise.all(
      loops.map(async (loop): Promise<HygieneLoop> => {
        const metricName = loop.loopConfig.measure;
        let metricDeclined: boolean | undefined;
        if (metricName) {
          const entries = await getMetricsForLoop(root, loop.missionId, metricName).catch(() => []);
          if (entries.length > 0) {
            const synthesis = synthesizeMetricTrend(entries, metricName);
            // A meaningfully negative trend (>=10% drop) counts as
            // "decline" — a small wobble is noise, never worth alerting.
            if (synthesis.declinePct !== undefined) metricDeclined = synthesis.declinePct <= -10;
          }
        }
        return {
          missionId: loop.missionId,
          title: loop.title,
          enabled: loop.loopConfig.enabled,
          nextRunAtMs: loop.loopConfig.nextRunAt ? new Date(loop.loopConfig.nextRunAt).getTime() : undefined,
          cadenceMs: parseCadenceMs(loop.loopConfig.cadence),
          consecutiveFailures: consecutiveLoopFailures(stateRef.current.missions, loop.missionId),
          metricDeclined,
        };
      }),
    );

    const alerts = planLoopSupervision(hygieneLoops, nowMs);
    for (const alert of alerts) {
      if (alert.reason === 'repeated_failure') {
        await disableLoop(root, alert.missionId).catch(() => {
          // Best-effort — the announcement below still fires even if the
          // pause write itself failed; never silently drop the alert.
        });
      }
      // Same best-effort routing as announceLoopApprovalIfPromoted above —
      // the most-recently-active IDLE open conversation, silently skipped
      // when every open conversation is currently busy.
      const targetId = pickWakeupTargetConversationId(stateRef.current);
      if (!targetId) continue;
      await sendManagerMessageRef.current(
        targetId,
        formatLoopSupervisionMessage(alert),
        resolveAutomatedTurnModel(stateRef.current.managerModel),
        // GOAL LOOP: a background announcement, not a real user ask — see
        // sendManagerMessage's isAutomatedTurn doc comment.
        { isAutomatedTurn: true },
      ).catch(() => {
        // Best-effort — a failed announcement must never crash the sweep.
      });
    }
  };

  const runFleetHygieneSweep = useCallback(() => {
    if (hygieneSweepInFlightRef.current) return;
    const now = Date.now();
    if (now - lastHygieneSweepAtRef.current < MIN_HYGIENE_SWEEP_INTERVAL_MS) return;
    hygieneSweepInFlightRef.current = true;
    lastHygieneSweepAtRef.current = now;

    try {
      const missions: HygieneMission[] = stateRef.current.missions.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        merged: m.merged,
        archived: m.archived,
        createdAt: m.createdAt,
        // Best-known moment this mission reached its CURRENT terminal
        // status this session; falls back to createdAt across a restart
        // (see fleetHygiene.ts's HygieneMission doc comment for why that
        // fallback is safe for a 24h-default grace period).
        terminalAtMs: missionTerminalAtRef.current.get(m.id) ?? m.createdAt,
      }));

      const canvasState = canvasStoreVanilla.getState();

      // Fix 4 (TTL for stale transient canvas artifacts) — stamp/clear
      // previewPlaceholderFirstSeenRef BEFORE mapping into
      // HygienePreviewSurface below, so rule (g) (planTransientSurfaceTtl)
      // gets a genuine wall-clock age instead of the insertion-order proxy
      // `configuredAtMs` already uses for rule (e)'s relative dedup (see
      // HygienePreviewSurface.placeholderSinceMs's own doc comment on why
      // the two fields cannot share one number). Scoped to 'preview'
      // surfaces only — a 'terminal' surface is never a placeholder in this
      // sense (see planTransientSurfaceTtl's own doc comment for why
      // terminals are excluded from the whole rule).
      const livePlaceholderIds = new Set(
        canvasState.surfaces
          .filter((s) => s.kind === 'preview' && !hasSurfaceAddress({ id: s.id, url: s.url }))
          .map((s) => s.id),
      );
      for (const id of livePlaceholderIds) {
        if (!previewPlaceholderFirstSeenRef.current.has(id)) {
          previewPlaceholderFirstSeenRef.current.set(id, now);
        }
      }
      for (const id of [...previewPlaceholderFirstSeenRef.current.keys()]) {
        // No longer a live placeholder (configured, or removed entirely) —
        // drop the bookkeeping so a LATER placeholder spell (the user
        // cleared the URL bar again) starts its TTL clock fresh rather than
        // inheriting a stale timestamp from before it had a real address.
        if (!livePlaceholderIds.has(id)) previewPlaceholderFirstSeenRef.current.delete(id);
      }

      const previewSurfaces: HygienePreviewSurface[] = canvasState.surfaces.map((s, index) => {
        // Fix 2 (idle-terminal auto-close) — read-only lookup into
        // terminalActivity.ts's ephemeral registry; absent for a 'preview'
        // surface (never written there) or a 'terminal' never yet observed
        // producing output/gaining focus this session.
        const activity = getTerminalActivity(s.id);
        return {
          id: s.id,
          projectId: s.projectId,
          url: s.url,
          kind: s.kind,
          // SurfaceSpec carries no "configured at" timestamp of its own (see
          // canvasTypes.ts) — insertion order is the best available recency
          // proxy (canvasStore.addSurface/updateSurface always append/patch
          // in place, never reorder), documented as a known approximation in
          // fleetHygiene.ts's own HygienePreviewSurface doc comment.
          configuredAtMs: index,
          // Fix 4 — see previewPlaceholderFirstSeenRef's own doc comment;
          // absent for a configured surface (never tracked) or one never yet
          // observed by a sweep.
          placeholderSinceMs: previewPlaceholderFirstSeenRef.current.get(s.id),
          lastOutputAtMs: activity.lastOutputAtMs,
          lastFocusedAtMs: activity.lastFocusedAtMs,
        };
      });
      const canvasArtifacts: HygieneCanvasArtifact[] = [
        ...canvasState.drafts.map((d) => ({ id: d.id, label: d.title })),
        ...canvasState.notes.map((n) => ({ id: n.id, label: n.text })),
      ];

      // P58 fix (2026-07-22 memory-pressure incident) — rule (f) also
      // sweeps the OPEN-PROJECTS registry for e2e/soak-scratch entries
      // (previously only canvas artifacts were swept, leaving a leftover
      // scratch project free to auto-spawn a dev server later — see
      // devPreview.ts's own pressure-gate hardening for the other half of
      // that incident's fix). ProjectEntryOut already carries its own
      // `active` flag (AppContext.tsx) — no separate activeProjectId
      // lookup needed.
      const hygieneProjects: HygieneProject[] = (appContext?.openProjects ?? []).map((p) => ({
        id: p.id,
        root: p.root,
        active: p.active,
      }));

      const plan = planFleetHygiene({ missions, previewSurfaces, canvasArtifacts, openProjects: hygieneProjects }, now, getFleetHygieneConfig());

      // Rule (j) — orphan worktree recovery/cleanup (plumbing fix verified on
      // the founder's backoffice: 33 orphan worktrees, 24 empty + 1 carrying
      // real work never merged). The Rust side gathers real git data in ONE
      // IPC call (branch heads + reachability vs HEAD — never approximated
      // from the current branch's own log); this frontend block applies the
      // plan through the app's REAL primitives. Fire-and-forget, like the
      // other async hygiene steps (never delays the sync sweep).
      void (async () => {
        try {
          const root = await resolveProjectRoot();
          if (!root || root === '.') return; // web/mock: no real git to read
          const orphanPlan = await getPlatform().git.orphanWorktrees(root).catch(() => undefined);
          if (!orphanPlan) return;
          if (orphanPlan.recoverable.length === 0 && orphanPlan.empty.length === 0) return;

          // WORKTREE-DESTROYED-PRE-MERGE fix (2026-08-05, real prod incident —
          // M34/M35: a retried mission reached 'review' with a real +445-line
          // diff, journaled, then failed to merge — OS 267 — because its
          // worktree AND branch no longer existed on disk at all; the
          // original M34 showed the identical symptom right as it failed).
          // git_orphan_worktrees (Rust, git.rs) classifies EVERY agent/*
          // branch purely by git reachability — by its own documented
          // contract it NEVER reads mission metadata ("the worktree on disk
          // is the ground truth"). A branch just created for a mission that
          // is still running/queued (zero commits yet — its HEAD trivially
          // equals the target's, so it looks "empty") is INDISTINGUISHABLE
          // from a genuinely abandoned one to that classifier — and a branch
          // WITH real commits still looks "recoverable", which this rule
          // used to auto-merge unconditionally (unreviewed work, silently
          // integrated) and which agent_merge_worktree_inner (git.rs) then
          // reclaims the worktree for regardless of whether the merge did
          // anything (its cleanup step is tied to the merge command's exit
          // code, not to whether real work landed — see approveMissionInner's
          // own B10 doc comment for the identical Rust behavior). Either
          // path used to be able to destroy a STILL-RUNNING mission's own
          // workspace out from under it — and since this whole sweep re-
          // fires on EVERY OTHER mission's terminal transition fleet-wide,
          // the exposure window was every such event for the life of the
          // run, not just this mission's own.
          //
          // Cross-references against the SAME liveness rule
          // worktree_sweep.rs already enforces Rust-side for its own
          // (different, 24h-interval) sweep (see that module's Tier 1/2
          // doc comment): a branch belonging to ANY mission this app still
          // tracks is LIVE — never merged or discarded here — unless that
          // mission is already merged (mergeSha/merged:true, safely landed)
          // or archived-and-terminal (archiveMission's own worktree-reclaim
          // already ran, or should have — this is the same case that rule
          // covers, applied defensively). Only a branch with NO matching
          // live mission at all (a real crash-session leftover) is a
          // genuine candidate for this rule — policy: failure alone is
          // never destruction; only an explicit merge or discard is.
          const liveBranches = new Set(
            stateRef.current.missions
              .filter((m) => !(m.merged === true || (m.archived === true && isTerminalMissionStatus(m.status))))
              .map((m) => m.worktree)
              .filter((w): w is string => Boolean(w)),
          );
          const safeRecoverable = orphanPlan.recoverable.filter((b) => !liveBranches.has(b.name));
          const safeEmpty = orphanPlan.empty.filter((b) => !liveBranches.has(b.name));
          if (safeRecoverable.length === 0 && safeEmpty.length === 0) return;

          // Merge the recoverable work into the current branch (the app's
          // real merge primitive — same path a human "Merger" click uses,
          // with the same conflict handling), then delete the empty branches
          // (the app's real discard primitive).
          for (const branch of safeRecoverable) {
            await mergeWorktree(root, branch.name).catch((err) => {
              console.warn(`[fleetHygiene] failed to recover orphan worktree branch ${branch.name}`, err);
            });
          }
          for (const branch of safeEmpty) {
            const wtPath = joinPath(root, '.lazy', 'worktrees', branch.name);
            await discardWorktree(root, wtPath, branch.name).catch((err) => {
              console.warn(`[fleetHygiene] failed to discard empty orphan worktree ${branch.name}`, err);
            });
          }
        } catch (err) {
          console.warn('[fleetHygiene] orphan worktree sweep failed (best-effort)', err);
        }
      })();

      // Section 4.4 — "Supervision continue": branches onto this SAME fleet-
      // hygiene sweep (founder's own instruction — never a competing timer)
      // to periodically review registered loops: are they still running, is
      // a step failing repeatedly, is the learned measure declining. Kept as
      // an independent fire-and-forget async step (never awaited by the
      // synchronous sweep above) so a slow loops.json/metrics read can never
      // delay or change the timing of the existing archive/purge/dedupe
      // logic this function already performs.
      void runLoopSupervisionSweep(now).catch(() => {
        // Best-effort — see this block's own doc comment.
      });

      for (const target of plan.missionsToArchive) archiveMission(target.id);

      const draftIdsToDelete = new Set(canvasState.drafts.filter((d) => plan.canvasArtifactsToDelete.some((a) => a.id === d.id)).map((d) => d.id));
      const noteIdsToDelete = new Set(canvasState.notes.filter((n) => plan.canvasArtifactsToDelete.some((a) => a.id === n.id)).map((n) => n.id));
      for (const id of draftIdsToDelete) canvasStoreVanilla.getState().removeDraft(id);
      for (const id of noteIdsToDelete) canvasStoreVanilla.getState().removeNote(id);

      for (const surface of plan.previewSurfacesToRemove) canvasStoreVanilla.getState().removeSurface(surface.id);
      // Fix 4 — never-configured preview placeholders past their TTL (rule
      // (g)). Already disjoint from previewSurfacesToRemove above (see
      // FleetHygieneResult.transientSurfacesToRemove's own doc comment), so
      // this can never double-remove or double-count the same surface id.
      for (const surface of plan.transientSurfacesToRemove) canvasStoreVanilla.getState().removeSurface(surface.id);
      // Fix 2 — idle terminals (rule (h)): no output AND not focused for
      // idleTerminalTtlMs. Reuses the SAME removeSurface path as every other
      // surface removal above, which already kills the underlying PTY on
      // unmount (TerminalView.tsx's cleanup) — never a second disposal path.
      for (const surface of plan.terminalSurfacesToClose) canvasStoreVanilla.getState().removeSurface(surface.id);

      // Close every test-scratch project this sweep found, switching away
      // from the active one FIRST when it is itself scratch (never leave
      // the active project dangling on a since-removed id — see
      // fleetHygiene.ts's planTestScratchProjectClosure doc comment for the
      // exact ordering contract this plan already guarantees). Real
      // primitives (AppContext.tsx's switchProject/closeProject) — same
      // audit trail a manual close would leave (project.closed is
      // journaled Rust-side). Fire-and-forget, same posture as the journal
      // write below: a failure here must never throw back into this
      // synchronous sweep.
      if (appContext && plan.projectClosure.idsToClose.length > 0) {
        const { switchActiveTo, idsToClose } = plan.projectClosure;
        const { switchProject, closeProject } = appContext;
        void (async () => {
          try {
            if (switchActiveTo) await switchProject(switchActiveTo);
            for (const id of idsToClose) await closeProject(id);
          } catch (err) {
            console.warn('[fleetHygiene] failed to close a test-scratch project', err);
          }
        })();
      }

      const { archived, purged, deduped, projectsClosed } = plan.summary;
      if (archived + purged + deduped + projectsClosed === 0) return;

      void resolveProjectRoot()
        .then((root) =>
          emitEvent({
            type: 'fleet.hygiene',
            tsMs: Date.now(),
            projectId: projectIdFromRoot(root),
            actor: 'system',
            payload: { archived, purged, deduped, projectsClosed },
          }),
        )
        .catch(() => {
          /* best-effort — mirrors archiveMission's own journal write */
        });
    } finally {
      hygieneSweepInFlightRef.current = false;
    }
  }, [archiveMission, appContext]);

  useEffect(() => {
    runFleetHygieneSweepRef.current = runFleetHygieneSweep;
  }, [runFleetHygieneSweep]);

  // "on app boot (after fleet load) + every 6h" (founder directive) — the
  // boot delay gives the mission-load effect (further up this file) time to
  // finish its async journal/legacy read first; the interval covers a
  // long-running session.
  useEffect(() => {
    const bootTimer = setTimeout(() => runFleetHygieneSweepRef.current(), FLEET_HYGIENE_BOOT_DELAY_MS);
    const interval = setInterval(() => runFleetHygieneSweepRef.current(), FLEET_HYGIENE_SWEEP_INTERVAL_MS);
    return () => {
      clearTimeout(bootTimer);
      clearInterval(interval);
    };
  }, []);

  // Fix 5 (release valve) — system_pressure.rs's existing frontend
  // consumers (scheduler.ts, devPreview.ts, SystemPressureBadge.tsx) only
  // ever DEFER new work on 'high' pressure; nothing sheds memory already
  // held. Wired once for the app's whole lifetime (empty deps — same
  // "created once" contract as the chain engine below): on a transition
  // INTO 'high', immediately triggers the fleet-hygiene sweep (which
  // includes rule (h)'s idle-terminal closure — Fix 2) and drops the
  // tree-sitter parsed-grammar cache. Never touches an attended surface or
  // a running mission's terminal — see systemPressureShedding.ts's own
  // safety-floor doc comment for why each action it calls already upholds
  // that on its own.
  useEffect(() => {
    return startSystemPressureShedding({
      runHygieneSweepNow: () => runFleetHygieneSweepRef.current(),
      dropReclaimableCaches: () => { clearTreeSitterLanguageCache(); },
    });
  }, []);

  // ── Contest engine: W-CONTEST (best-of-N) ─────────────────────────────
  // Wired exactly once (empty deps), same "created once for the provider's
  // whole lifetime" contract as the chain engine above — initContestEngine
  // is itself idempotent (contestEngine.ts's module header) so React
  // StrictMode's dev-mode double-mount can never register duplicate state.
  // `archiveMission` is intentionally omitted from the deps array (same
  // `addMissionRef` technique the chain engine wiring above already uses):
  // it is itself a stable useCallback, and re-running init on every identity
  // change would re-trigger the startup reconcile pointlessly — the deps
  // below always call through to the LATEST archiveMission via this ref.
  const archiveMissionRef = useRef(archiveMission);
  useEffect(() => {
    archiveMissionRef.current = archiveMission;
  }, [archiveMission]);
  useEffect(() => {
    const dispose = initContestEngine({
      archiveMission: (id) => archiveMissionRef.current(id),
      getActiveProjectId: async () => projectIdFromRoot(await resolveProjectRoot()),
    });
    return dispose;
  }, []);

  // ── LazyManager ──────────────────────────────────────────────────

  /**
   * W-MODES: changes a project's approval mode (or the global default when
   * `projectId` is omitted) and journals the flip via `approval.mode_changed`.
   * A no-op (no persist, no journal write) when the requested mode already
   * matches the current effective one. Declared here (before
   * executeManagerAction) rather than alongside setManagerModel/
   * clearManagerMessages below purely because executeManagerAction's own
   * `set_approval_mode` case needs it in its dependency array — this
   * callback has no dependency of its own on anything declared later in
   * this component (only module-level imports plus triggerAutoMergeIfEligible,
   * declared well above), so there is no ordering hazard moving it up here.
   *
   * Retroactive-merge fix (bug audit wave): approvalMode.ts's own
   * `setApprovalMode` doc comment still describes (and its own persistence
   * layer still honors) the ORIGINAL design — a mission already sitting in
   * 'review' at the moment the mode flips is never touched by the flip
   * itself, only by some LATER unrelated patch to that exact mission. From
   * the user's own perspective, though, flipping a project to Auto and
   * watching every mission already waiting in review just sit there looks
   * broken, not intentional — so THIS function (the one real caller UI/the
   * manager tool ever goes through) now re-checks every mission this store
   * currently knows about that is still `status === 'review'` through the
   * exact same real `triggerAutoMergeIfEligible`/`evaluateAutoMerge` path a
   * normal patch-driven auto-merge already uses — no parallel merge logic.
   * Double-merge safe for free: `triggerAutoMergeIfEligible` (via
   * approveMission) only ever acts on a mission still in 'review', so
   * calling it again here for a mission whose merge is already in flight or
   * already landed is a harmless no-op, never a second merge.
   *
   * Scope limits, both honest rather than silently wrong:
   *   - skipped entirely for `mode === 'manual'` (nothing to retroactively
   *     merge INTO manual);
   *   - skipped for a per-project `projectId` that isn't the currently
   *     ACTIVE project — `state.missions` only ever holds the single active
   *     project's missions (the pre-existing architectural constraint — see
   *     Cockpit.tsx's "Cross-project action honesty" header note), so there
   *     is nothing here to rescan for a project that isn't open right now;
   *     that project's own already-waiting missions get the same real
   *     re-check the next time triggerAutoMergeIfEligible's own patch-driven
   *     choke points touch them, or the next time IT becomes the active
   *     project and reads its own mode again.
   */
  const changeApprovalMode = useCallback(async (mode: ApprovalMode, projectId?: string) => {
    const previousMode = getApprovalMode(projectId);
    if (previousMode === mode) return;
    await persistApprovalMode(mode, projectId);
    resolveProjectRoot().then((root) => {
      const activeProjectId = projectIdFromRoot(root);
      emitEvent({
        type: 'approval.mode_changed',
        tsMs: Date.now(),
        projectId: projectId ?? activeProjectId,
        actor: 'user',
        payload: { mode, previousMode, projectId },
      });
      if (mode === 'manual') return;
      // BUG #residual fix (2026-08-05, same drive-case/slash bug family as
      // draftLaunch.ts's launchDraft cross-project check — see
      // normalizeForMembershipCompare's own doc comment in canvasDigest.ts):
      // `projectId` is the CALLER's raw string (e.g. a manager action
      // echoing its own path argument back) while `activeProjectId` is
      // freshly re-derived via projectIdFromRoot above — a strict `!==`
      // wrongly treated the SAME project as "a different one" whenever the
      // two carried a different drive-letter case or slash direction,
      // silently skipping the retroactive re-scan below for a flip that was
      // actually targeting the currently active project.
      if (
        projectId !== undefined &&
        normalizeForMembershipCompare(projectId) !== normalizeForMembershipCompare(activeProjectId)
      ) return;
      // Re-read the EFFECTIVE mode for the active project (rather than
      // trusting `mode` directly) so a global-default flip that a
      // per-project override still shadows correctly does nothing here.
      if (getApprovalMode(activeProjectId) === 'manual') return;
      for (const mission of stateRef.current.missions) {
        if (mission.status === 'review') triggerAutoMergeIfEligible(mission);
      }
    }).catch(() => { /* best-effort */ });
  }, [triggerAutoMergeIfEligible]);

  /** `executeManagerAction` recursively re-dispatches itself for several
   *  action types below (`launch_mission`'s inline contest, `launch_best_of_n`
   *  / `fork_graph_run` / `resume_graph_run` all re-entering via
   *  `execute_plan`) — those recursive calls happen from deep inside its own
   *  body, so referencing the `const` by name there would be a forward
   *  reference to a binding that doesn't exist yet at that point in this
   *  render. Same "declare early, sync via a later effect" ref convention as
   *  `runFleetHygieneSweepRef`/`archiveMissionRef` above/below: the recursive
   *  call sites go through this ref instead, which always resolves to the
   *  LATEST `executeManagerAction` closure rather than risking a stale one. */
  const executeManagerActionRef = useRef<
    (action: ManagerAction, model: string, aliasMap: Map<string, string>, conversationId?: string, lastUserMessageText?: string) => Promise<ManagerActionRealResult | void>
  >(async () => {});

  /** Execute a single manager action by dispatching to store methods.
   *  `aliasMap` (W6d) is the CURRENT reply's intra-turn alias registry —
   *  see the module-scope doc comment above `resolveAliasedRef` and the
   *  `for` loop in sendManagerMessage that creates one map per reply and
   *  threads it through every action in order. `conversationId` (multi-
   *  conversation LazyManager, wave 1) is OPTIONAL and purely additive —
   *  stamped onto any Mission this call creates as `originConversationId`
   *  (see that field's own doc comment, lib/agents/types.ts) so a future UI
   *  can attribute a mission back to the conversation that launched it;
   *  omitted for recursive/replay call sites that don't have a clean
   *  conversation of origin (e.g. a loop iteration re-running an already-
   *  launched action) — nothing branches on its absence.
   *
   *  `lastUserMessageText` (start_preview mention-routing fix, 2026-08-05)
   *  is likewise OPTIONAL and purely additive — the raw text of the user
   *  message that triggered THIS turn (`userMsg.content` in
   *  sendManagerMessage), passed only at the one call site inside its own
   *  actions loop where that text is actually in scope. Every recursive/
   *  replay call site omits it, same convention as `conversationId` right
   *  above; only start_preview's own case currently reads it (see that
   *  case's own doc comment for why an action with no free-text field of
   *  its own needs this).
   *
   *  Returns a `ManagerActionRealResult` for the cleanup/bulk actions whose
   *  completion claim is otherwise vulnerable to the model narrating a
   *  fabricated count — see that type's own doc comment (P0-3 fix). Every
   *  other action keeps returning nothing (`void`): its outcome is already
   *  fully conveyed by its toast/chip, and the model's own prose about a
   *  SINGLE, unambiguous item is not the class of bug this return value
   *  exists to correct. */
  const executeManagerAction = useCallback(async (action: ManagerAction, _model: string, aliasMap: Map<string, string>, conversationId?: string, lastUserMessageText?: string): Promise<ManagerActionRealResult | void> => {
    const state = liveManagerStoreView(stateRef);
    const handlers: Partial<Record<string, () => Promise<ManagerActionRealResult | void>>> = {
      create_agent: async () => {
        if (action.type !== 'create_agent') return;
        const a = action.agent;
        const agent = createNewAgent({
          name: String(a.name ?? ''),
          displayName: String(a.displayName ?? a.name ?? ''),
          description: String(a.description ?? ''),
          systemPrompt: String(a.systemPrompt ?? ''),
          modelTier: (a.modelTier as LazyAgent['modelTier']) ?? 'sonnet',
          color: (a.color as LazyAgent['color']) ?? 'violet',
          tags: Array.isArray(a.tags) ? a.tags.map(String) : [],
          scope: 'project',
          triggers: { manual: true },
          isolation: 'worktree',
        });
        await saveAgent('project', agent);
        toast(t('agents.manager.agentCreated', { name: agent.displayName }), 'success');
      },
      launch_mission: async () => {
        if (action.type !== 'launch_mission') return;
        // Mode-aware: a hardcoded native id/label here breaks managed/Pro
        // mode the same way the LazyManager's own default did (see
        // resolveManagerModelId — action.model is a tier hint, never a
        // literal model id). STACK fix: action.engine ("cli"|"pro") lets the
        // manager deliberately target either rail for THIS mission,
        // regardless of the ambient mode — see resolveManagerModelId's
        // engineOverride doc comment.
        const contestN = action.contestN;
        if (contestN !== undefined && contestN > 1) {
          // Inline best-of-N via SGR contest plan (same path as launch_best_of_n).
          // modelId (modelId catalog wave) forwarded alongside model/engine —
          // dropping it here would silently discard an exact-id request the
          // moment contestN upgrades a single launch_mission into a plan.
          await executeManagerActionRef.current(
            {
              type: 'launch_best_of_n',
              task: action.task,
              n: contestN,
              agentName: action.agentName,
              model: action.model,
              modelId: action.modelId,
              effort: action.effort,
              engine: action.engine,
              budgetCapUsd: action.budgetCapUsd,
            },
            _model,
            aliasMap,
            conversationId,
          );
          return;
        }
        // modelId catalog wave: action.modelId (an exact catalog id) takes
        // priority over action.model (a bare tier hint) — see
        // resolveManagerModelId's own doc comment. An unknown/wrong-rail
        // modelId throws UnknownManagerModelIdError, which propagates out of
        // this case and is turned into an honest actionFailed message by the
        // caller's per-action try/catch (sendManagerMessage) — never a
        // silent fallback to the tier default.
        // Target-project fix (2026-08-03 real-user test, mission M8 blocked
        // out_of_scope_path): the user asked for a file at the root of
        // lazy-backoffice — an OPEN project, but not the ACTIVE one — and
        // this case always launched against the active project ('.'), so
        // missionScopeGuard.ts's wrong-context backstop fired and nothing
        // ran. Same resolve-by-name-or-id choke point generate_plan/create_draft
        // already use (resolveDraftProjectId): an unresolved name is a real,
        // honest failure telling the manager to open_project first — never a
        // silent guess into the wrong project's cwd/brain.
        let missionTargetResolution = await resolveDraftProjectId(action.projectId);
        if (missionTargetResolution.unresolvedName) {
          // BUG 1 fix (LazyManager QA, 2026-08-07): a project named but not
          // currently OPEN used to hard-fail launch_mission every time —
          // three launch_mission actions targeting a known-but-closed
          // project all sat "Blocked" in the approval list, and the user had
          // to separately ask the manager to open_project and retry by
          // hand. AppContext's `lazy.projects.recent` MRU list (see
          // readRecentProjects's own doc comment) remembers real root paths
          // for projects this session has had open before, keyed only by
          // root — matched here against the requested NAME via basename(root),
          // same case-insensitive name match resolveDraftProjectId itself
          // uses for an OPEN project. A match is auto-opened inline
          // (registerProject: Rust-validated path-exists-and-is-a-directory
          // check before registering, idempotent re-activation if already
          // open — cheap and safe to call speculatively) and resolution is
          // retried ONCE. A name with no recent match, or an appContext-less
          // caller (no Tauri runtime), falls through to the exact same
          // honest failure as before — never a guessed root.
          const needle = missionTargetResolution.unresolvedName.trim().toLowerCase();
          const recentMatch = readRecentProjects().find(
            (entry) => basename(entry.root).toLowerCase() === needle,
          );
          if (recentMatch && appContext) {
            try {
              await appContext.registerProject(recentMatch.root);
              missionTargetResolution = await resolveDraftProjectId(action.projectId);
            } catch (err) {
              // Auto-open genuinely failed (path moved/deleted/permission
              // issue since last seen) — surface the real reason instead of
              // silently retrying, same honesty convention as open_project's
              // own catch below.
              const msg = `Project "${missionTargetResolution.unresolvedName}" is not open, and auto-opening its last known path failed: ${errorMessage(err)}. Use open_project first, then retry.`;
              toast(msg, 'error');
              return { failed: true, message: msg };
            }
          }
        }
        if (missionTargetResolution.unresolvedName) {
          const msg = `Project "${missionTargetResolution.unresolvedName}" is not open — cannot launch a mission at it. Use open_project first, then retry.`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        let missionRepo = missionTargetResolution.projectId
          ? ((await resolveProjectRootById(missionTargetResolution.projectId)) ?? '.')
          : '.';
        // Deterministic target routing (2026-08-03, mission M9/M10 blocked
        // out_of_scope_path even after projectId existed): a weak manager
        // model will NOT reliably pass projectId — it writes the target's
        // absolute path, or the project's bare name, into the task text and
        // launches. When no explicit projectId is set, resolve those
        // mentions against the OPEN projects (resolveMentionedProjectRoot,
        // shared with generate_plan's own parity fix below — see that
        // helper's own doc comment for the full path-then-name scan order).
        // A mention owned by NO open project, or spanning MULTIPLE, stays on
        // the active root for missionScopeGuard's honest refusal to judge.
        if (!missionTargetResolution.projectId) {
          const mentioned = await resolveMentionedProjectRoot(action.task);
          if (mentioned) {
            missionRepo = mentioned.root;
            console.warn(`[launch_mission] routed by mention -> project ${mentioned.id} (${mentioned.root})`);
          }
        }
        const modelLabel = resolveManagerModelId(action.model, getProviderMode(), action.engine, action.modelId);
        // Cross-project READ access (extraReadableProjectIds — see
        // ManagerAction.launch_mission's own doc comment, types.ts):
        // resolve each declared project id/name to a REAL, currently OPEN
        // project root, the exact same resolve-by-id-or-name step
        // `projectId` above already goes through (resolveDraftProjectId ->
        // resolveProjectRootById). An entry that does not resolve is
        // dropped with a warning, never silently substituted for "every
        // open project" — see Mission.extraReadableRoots' own doc comment
        // for why that matters. `agent_run` (run.rs) independently
        // re-validates every resolved root against the live
        // ProjectRegistry before wiring anything, so a stale value here can
        // never widen a mission's reach past what is genuinely open now.
        const extraReadableRoots: string[] = [];
        for (const declared of action.extraReadableProjectIds ?? []) {
          const declaredResolution = await resolveDraftProjectId(declared);
          const resolvedRoot = declaredResolution.projectId
            ? await resolveProjectRootById(declaredResolution.projectId)
            : undefined;
          if (resolvedRoot) {
            if (!extraReadableRoots.includes(resolvedRoot)) extraReadableRoots.push(resolvedRoot);
          } else {
            console.warn(`[launch_mission] extraReadableProjectIds: "${declared}" did not resolve to a currently open project — skipped`);
          }
        }
        const missionId = await addMission({
          title: action.task.slice(0, 80),
          agentTask: action.task,
          agentName: action.agentName,
          repo: missionRepo,
          worktree: '',
          modelLabel,
          mode: 'agent',
          orchestrator: false,
          // Individual-launch continuation gap fix (see the Continuation
          // Doctrine, managerEngine.ts): the manager reads a prior mission's
          // real branch off the Current Missions digest ("branch=...") and
          // sets it here so this launch starts from that mission's actual
          // work instead of the repo's default branch. Forwarded unchanged
          // onto NewMissionInput.baseBranch -> Mission.baseBranch ->
          // runtime.ts's createWorktree, the same terminal plumbing 6073668
          // already built for plan steps. Absent/undefined = today's
          // unchanged default-branch behavior.
          baseBranch: action.baseBranch,
          // Cross-project READ access — see the resolution loop above this
          // addMission call. Absent when nothing resolved, never an empty
          // array (matches NewMissionInput.extraReadableRoots' own "absent/
          // empty = unchanged behavior" contract).
          extraReadableRoots: extraReadableRoots.length > 0 ? extraReadableRoots : undefined,
          // R13 (same DEFECT D/2 class as create_loop/agent:launch below):
          // without an explicit permissionMode, addMission passes undefined
          // -> runtime.ts sends 'default' -> the native CLI stalls on an
          // interactive Bash-approval prompt that never appears in-app. This
          // was the one manager launch path still missing the fix everywhere
          // else already has.
          permissionMode: 'acceptEdits',
          effort: action.effort,
          contract: action.budgetCapUsd !== undefined || action.maxDurationMs !== undefined
            ? {
                objective: action.task.slice(0, 500),
                model: modelLabel,
                permissionMode: 'acceptEdits',
                budgetCapUsd: action.budgetCapUsd ?? 5,
                maxDurationMs: action.maxDurationMs,
                proofs: [],
                // Root-cause fix (2026-08-02 zone audit) — see
                // NewMissionModal.tsx's identical fix for the full
                // rationale: humanApprove: true here silently opted every
                // manager-launched mission with a budget/duration cap out
                // of auto-merge, regardless of the project's own
                // auto_green/full_auto approval mode.
                gates: { evaluators: true, humanApprove: false },
                shareToTeam: false,
              }
            : undefined,
          originConversationId: conversationId,
        });
        toast(t('agents.manager.missionLaunched'), 'success');
        return { patchedRef: makeRef('mission', missionId) };
            },
      launch_best_of_n: async () => {
        if (action.type !== 'launch_best_of_n') return;
        const projectRoot = await resolveProjectRoot().catch(() => '.');
        const id = projectIdFromRoot(projectRoot);
        const n = Math.max(2, Math.min(8, Math.floor(action.n || 2)));
        const orch = await createOrchestrator({
          projectRoot,
          projectId: id,
          name: `Best-of-${n}: ${action.task.slice(0, 60)}`,
          objective: action.task,
          steps: [
            {
              id: 'contest-1',
              description: action.task,
              contestN: n,
              agentName: action.agentName,
              model: action.model,
              // modelId catalog wave: persisted onto the plan step, but full
              // delivery to the launched contestants additionally needs
              // orchestratorState.ts/compileOrchestrator.ts/
              // sgrOrchestratorRunner.ts wiring — see OrchestratorPlanStepInput.
              // modelId's doc comment (types.ts) for the exact gap.
              modelId: action.modelId,
              effort: action.effort,
              engine: action.engine,
              budgetCapUsd: action.budgetCapUsd,
              critical: true,
            },
          ],
          // Gate-usability fix: was hardcoded 'supervised', which silently
          // ignored whatever autonomy mode the user actually selected (the
          // orchestrator's own gate check on execute_plan reads THIS field,
          // not the global mode — see evaluateActionGate's call site below).
          autonomyLevel: state.autonomyLevel,
        });
        registerRuntimeProject(id, projectRoot, id);
        setState((prev) => ({
          ...prev,
          orchestrators: prev.orchestrators.some((o) => o.id === orch.id)
            ? prev.orchestrators.map((o) => (o.id === orch.id ? orch : o))
            : [...prev.orchestrators, orch],
        }));
        toast(`Best-of-${n} plan ${orch.id} — executing…`, 'info');
        await executeManagerActionRef.current({ type: 'execute_plan', planId: orch.id }, _model, aliasMap, conversationId);
      },
      fork_graph_run: async () => {
        if (action.type !== 'fork_graph_run') return;
        // resolveOrchestratorRoot — see execute_plan's own doc comment on
        // this helper (generate_plan may target a non-active project).
        const projectRoot = await resolveOrchestratorRoot(action.planId);
        const orch = await getOrchestrator(projectRoot, action.planId);
        if (!orch) {
          toast(`Plan ${action.planId} not found`, 'error');
          return;
        }
        const forked = await createOrchestrator({
          projectRoot,
          projectId: orch.projectId,
          name: action.label ?? `Fork of ${orch.name}`,
          objective: orch.objective,
          // NOTE (pre-existing gap, not introduced by this change): this map
          // already dropped modelId/baseBranch/role/onFail/maxAttempts/
          // joinGroup before extraReadableProjectIds existed — a fork loses
          // those too. Out of scope here (unrelated to cross-project read
          // access); only extraReadableProjectIds is added below, to avoid
          // this specific feature silently regressing on a forked plan.
          steps: orch.steps.map((s) => ({
            id: s.id,
            description: s.description,
            dependsOn: s.dependsOn,
            autonomyLevel: s.autonomyLevel,
            agentName: s.agentName,
            model: s.model,
            modelId: s.modelId,
            baseBranch: s.baseBranch,
            role: s.role,
            onFail: s.onFail,
            maxAttempts: s.maxAttempts,
            joinGroup: s.joinGroup,
            extraReadableProjectIds: s.extraReadableProjectIds,
            effort: s.effort,
            engine: s.engine,
            budgetCapUsd: s.budgetCapUsd,
            maxDurationMs: s.maxDurationMs,
            scopePaths: s.scopePaths,
            proofs: s.proofs,
            contestN: s.contestN,
            critical: s.critical,
          })),
          autonomyLevel: orch.autonomyLevel === 'custom' ? 'supervised' : orch.autonomyLevel,
          budgetLimitCents: orch.budget.limitCents,
        });
        // Optional: mark steps before fork node as done so SGR resumes after it.
        if (action.nodeId) {
          const steps = forked.steps.map((s) => {
            if (s.id === action.nodeId) return { ...s, status: 'pending' as const };
            // naive: leave pending; SGR topo will still run deps first
            return s;
          });
          await updateOrchestrator(projectRoot, forked.id, { steps, status: 'planning' });
        }
        setState((prev) => ({
          ...prev,
          orchestrators: [...prev.orchestrators, forked],
        }));
        toast(`Forked plan ${forked.id} from ${action.planId}`, 'success');
        await executeManagerActionRef.current({ type: 'execute_plan', planId: forked.id }, _model, aliasMap, conversationId);
      },
      resume_graph_run: async () => {
        if (action.type !== 'resume_graph_run') return;
        // resolveOrchestratorRoot — see execute_plan's own doc comment on
        // this helper (generate_plan may target a non-active project).
        const projectRoot = await resolveOrchestratorRoot(action.planId);
        const orch = await getOrchestrator(projectRoot, action.planId);
        if (!orch) {
          toast(`Plan ${action.planId} not found`, 'error');
          return;
        }
        const decision = action.decision ?? 'continue';
        if (decision === 'abort') {
          await updateOrchestrator(projectRoot, action.planId, { status: 'blocked' });
          toast(`Plan ${action.planId} aborted`, 'warning');
          return;
        }
        // Reset failed/blocked steps to pending so SGR can re-wave them.
        const steps = orch.steps.map((s) =>
          s.status === 'failed' || s.status === 'in_progress'
            ? { ...s, status: 'pending' as const, missionIds: [] }
            : s,
        );
        await updateOrchestrator(projectRoot, action.planId, { steps, status: 'planning' });
        toast(`Resuming plan ${action.planId} (${decision})`, 'info');
        await executeManagerActionRef.current({ type: 'execute_plan', planId: action.planId }, _model, aliasMap, conversationId);
      },
      create_loop: async () => {
        if (action.type !== 'create_loop') return;
        // Mode-aware, STACK-fix engine lever — see the launch_mission case
        // above. modelId (exact catalog id) takes priority over the tier
        // hint, same honest-throw contract as launch_mission's own.
        const modelLabel = resolveManagerModelId(action.model, getProviderMode(), action.engine, action.modelId);
        // Bounded by default (see DEFAULT_MANAGER_LOOP_MAX_ITERATIONS above) —
        // never the pure-function's own 'manual' fallback for a loop the
        // manager itself created with no way to request a stop condition.
        const baseLoopCfg = createLoopConfig(action.cadence, {
          kind: 'maxIterations',
          count: DEFAULT_MANAGER_LOOP_MAX_ITERATIONS,
        });
        // Charter-seeded regime lifecycle (spec §4): only when the manager
        // carries a validated charter's `superviseFirstN` gate onto this
        // loop's creation — an ordinary create_loop call (no charter, or a
        // charter with nature 'unique') never sets these, so `regimeState`
        // stays absent and this loop behaves exactly as before (see
        // LoopConfig.regimeState's own doc comment in types.ts for the full
        // trial -> validated -> autonomous -> self_improving lifecycle this
        // seeds the START of).
        // Visible-artifact fix — `templateArtifactRef` (see its own doc
        // comment, types.ts) names a frozen gabarit this loop consumes every
        // iteration WITHOUT regenerating it; it is independent of the
        // trial/validated/autonomous regime lifecycle below (that lifecycle
        // ONLY applies to a charter-seeded recurring/permanent loop — see
        // MissionNature's doc comment), so it threads through regardless of
        // whether `superviseFirstN` is also set — an ordinary, ungated loop
        // can still reference a validated propose_artifact resolution.
        const loopCfg: LoopConfig = action.superviseFirstN
          ? {
              ...baseLoopCfg,
              regimeState: 'trial',
              trialApprovedCount: 0,
              trialPromotionThreshold: action.superviseFirstN,
              measure: action.measure,
              killSwitch: action.killSwitch,
              templateArtifactRef: action.templateArtifactRef,
            }
          : { ...baseLoopCfg, templateArtifactRef: action.templateArtifactRef };
        const loopMissionId = await addMission({
          title: `Loop: ${action.task.slice(0, 60)}`,
          agentTask: action.task,
          agentName: action.agentName,
          repo: '.',
          worktree: '',
          modelLabel,
          mode: 'agent',
          orchestrator: false,
          loopConfig: loopCfg,
          // DEFECT D: loop iterations used to run with permissionMode
          // undefined -> 'default' -> stuck on an approval prompt that never
          // appears in-app. Default to 'acceptEdits', same as NewMissionModal.
          permissionMode: 'acceptEdits',
          effort: action.effort,
          originConversationId: conversationId,
        });
        // Register the loop in the persistent engine with the real mission ID
        const root = await resolveProjectRoot();
        await registerLoop(root, {
          missionId: loopMissionId,
          title: `Loop: ${action.task.slice(0, 60)}`,
          agentName: action.agentName,
          agentTask: action.task,
          model: modelLabel,
          permissionMode: 'acceptEdits',
          loopConfig: loopCfg,
        });
        toast(t('agents.manager.loopCreated', { cadence: action.cadence }), 'success');
      },
      pause_loop: async () => {
        if (action.type !== 'pause_loop') return;
        const loopMission = findLoopMission(state.missions, action.loopId);
        if (!loopMission) {
          toast(t('agents.manager.loopNotFound', { id: action.loopId }), 'error');
          return;
        }
        const enabled = action.enabled ?? false;
        await toggleLoop(loopMission.id, enabled);
        toast(t(enabled ? 'agents.manager.loopResumed' : 'agents.manager.loopPaused', { name: loopMission.title }), 'success');
      },
      delete_loop: async () => {
        if (action.type !== 'delete_loop') return;
        // MANAGER FALSE POSITIVE fix: this used to have no dedicated action —
        // the manager fell back to stop_all (which only stops RUNNING
        // missions; it never touches loops.json) and then falsely claimed
        // "Loop supprimée" while the loop stayed enabled:true, persisted, and
        // still scheduled to fire again. delete_loop now really unregisters
        // the loop and removes its mission, same as the detail view's
        // Supprimer button (deleteLoop).
        const loopMission = findLoopMission(state.missions, action.loopId);
        if (!loopMission) {
          toast(t('agents.manager.loopNotFound', { id: action.loopId }), 'error');
          return;
        }
        await deleteLoop(loopMission.id);
        toast(t('agents.manager.loopDeleted', { name: loopMission.title }), 'success');
      },
      stop_mission: async () => {
        if (action.type !== 'stop_mission') return;
        // Honesty fix (C1 sweep — same "never verifies, never throws" shape
        // retryMission had): stopMission itself no-ops silently on an
        // unknown id (updateMission's own map-by-id matches nothing), so
        // without this check a stale/wrong missionId reported success here
        // too. Mirrors delete_mission's own missionNotFound throw below.
        const target = state.missions.find((m) => m.id === action.missionId);
        if (!target) {
          throw new Error(t('agents.manager.missionNotFound', { id: action.missionId }));
        }
        stopMission(action.missionId);
      },
      stop_all: async () => {
        if (action.type !== 'stop_all') return;
stopAll(action.filter);
      },
      retry_mission: async () => {
        if (action.type !== 'retry_mission') return;
        // Honesty fix (C1, BLOQUANT — real user test: "Relancer la mission
        // M44 — Approuvée" with M44 still 'review', no clone, empty queue).
        // retryMission now throws when the mission cannot be found (see its
        // own doc comment) — awaited here so that failure actually reaches
        // this action's caller instead of being a fire-and-forget promise
        // nobody observes. Both call sites (this one AND executeManagerAction
        // itself) are already wrapped by a try/catch upstream — sendManagerMessage's
        // per-action loop, or approvePendingAction when this was gate-deferred
        // — so a genuine failure here surfaces as an honest actionFailed
        // message / a pending entry that stays actionable with the real
        // reason, never a false "Approuvée".
        //
        // Retry-with-edit friction fix — `modifications.task` (same untyped
        // bag convention as clone_mission's own `mods.task` above) lets the
        // manager correct a badly-worded instruction on retry instead of
        // cloning — see ManagerAction's retry_mission doc comment (types.ts)
        // and the doctrine rule in managerEngine.ts. Absent/unchanged keeps
        // today's plain-retry behavior exactly.
        const mods = action.modifications ?? {};
        const newTask = typeof mods.task === 'string' ? mods.task : undefined;
        const newModel = typeof mods.model === 'string' ? mods.model : undefined;
        const newModelId = typeof mods.modelId === 'string' ? mods.modelId : undefined;
        // Continuation Doctrine REVERSAL (managerEngine.ts, real M9/M10
        // incident — see retryMission's own doc comment, this file, and
        // ManagerAction's retry_mission doc comment, types.ts): a retry
        // never changes the base branch, so BOTH shapes a manager might
        // plausibly emit one — `modifications.baseBranch` (the untyped-bag
        // convention every other retry modification uses) and a mistaken
        // top-level `baseBranch` (mirroring launch_mission's own top-level
        // field, an easy mix-up) — are forwarded here rather than silently
        // dropped. retryMission itself decides what happens next: identical
        // to the original's own baseBranch is a no-op (no regression), any
        // real change throws loudly instead of vanishing unnoticed.
        const newBaseBranch =
          (typeof mods.baseBranch === 'string' ? mods.baseBranch : undefined) ??
          (typeof action.baseBranch === 'string' ? action.baseBranch : undefined);
        await retryMission(action.missionId, { newTask, newModel, newModelId, newBaseBranch });
      },
      delete_mission: async () => {
        if (action.type !== 'delete_mission') return;
        // R13 — mission lifecycle: a TERMINAL mission is ARCHIVED (never
        // destroys journal history), matching the canvas context menu's own
        // "Archiver" vs "Supprimer" split (Supprimer only ever applies to a
        // still-unlaunched Draft, which has no Mission id to reach this
        // action at all). Only a non-terminal mission (queued/running/
        // review — an unusual manager request, but not one this action
        // should silently reinterpret differently from before) keeps the
        // old destructive behavior.
        //
        // P0-3 fix (real user test, PROVEN): a missionId that no longer
        // exists in state.missions (already auto-archived by the background
        // fleet-hygiene sweep, or picked from a stale "Current Missions"
        // slice that can legitimately diverge from the live board — see
        // buildManagerDynamicContext's own P0-3 fix, managerEngine.ts) used
        // to fall through to `target && (...)` being falsy -> the ELSE
        // branch below -> deleteMission on a non-existent id: a real no-op
        // that threw NOTHING, so the caller (sendManagerMessage's per-action
        // try/catch) recorded this as a SUCCESS. The manager could then
        // narrate "Mxx supprimée" for a mission it never actually touched.
        // Throwing here surfaces an honest, grounded failure (via the
        // existing actionFailed message) instead of a phantom success.
        const target = state.missions.find((m) => m.id === action.missionId);
        const openRoots = appContext?.openProjects.map((p) => p.root) ?? [];

        if (!target) {
          // B1 fix (journal-first deletion — real prod incident,
          // 2026-08-04: "Mission introuvable" for a mission the user could
          // still SEE on the board): a missing LIVE entry does not mean a
          // missing mission — check the journal's own missions_current
          // projection (the real source of truth) before giving up. See
          // findJournalMissionRow/tombstoneJournalMission's own doc
          // comments above.
          const row = await findJournalMissionRow(action.missionId);
          if (!row) {
            throw new Error(t('agents.manager.missionNotFound', { id: action.missionId }));
          }
          const shouldDiscard = action.discardWorktree ?? row.data['merged'] !== true;
          const worktreeOutcome = shouldDiscard
            ? await resolveMissionWorktreeCandidates(
                typeof row.data['worktree'] === 'string' ? (row.data['worktree'] as string) : undefined,
                row.projectId,
                openRoots,
              )
            : ({ outcome: 'skipped' } as const);
          await tombstoneJournalMission(action.missionId, row.projectId, row.data);
          const message = [
            t('agents.manager.missionDeletedOne', { id: action.missionId }),
            describeWorktreeOutcome(worktreeOutcome, t),
          ].filter(Boolean).join(' ');
          toast(message, 'success');
          return {
            message,
            digest: { kind: 'mission_removed', missionId: action.missionId, removedAs: 'deleted', worktree: worktreeOutcome },
          };
        }

        const isTerminal = target.status === 'done' || target.status === 'failed' || target.status === 'cancelled';
        // C — worktree capability: drift-tolerant discard BEFORE the
        // mission leaves state.missions (deleteMission) or gets archived
        // (archiveMission, which also attempts its own active-root-only
        // reclaim for a terminal mission — a harmless idempotent no-op once
        // this call has already found and removed it). Default true unless
        // the mission is `merged` (see delete_mission's own doc comment,
        // types.ts) or the caller explicitly opted out.
        const shouldDiscard = action.discardWorktree ?? target.merged !== true;
        const worktreeOutcome = shouldDiscard
          ? await resolveMissionWorktreeCandidates(target.worktree, target.repoRoot, openRoots)
          : ({ outcome: 'skipped' } as const);
        if (isTerminal) {
          archiveMission(action.missionId);
        } else {
          deleteMission(action.missionId);
        }
        const message = [
          isTerminal
            ? t('canvas.manager.missionArchivedOne', { id: action.missionId })
            : t('agents.manager.missionDeletedOne', { id: action.missionId }),
          describeWorktreeOutcome(worktreeOutcome, t),
        ].filter(Boolean).join(' ');
        toast(message, 'success');
        return {
          message,
          digest: {
            kind: 'mission_removed',
            missionId: action.missionId,
            removedAs: isTerminal ? 'archived' : 'deleted',
            worktree: worktreeOutcome,
          },
        };
            },
      clone_mission: async () => {
        if (action.type !== 'clone_mission') return;
        const original = state.missions.find((m) => m.id === action.missionId);
        if (!original) {
          toast(t('agents.manager.missionNotFound', { id: action.missionId }), 'error');
          return;
        }
        const mods = action.modifications ?? {};
        // Closing-audit honesty fix: this used to fire addMission with `void`
        // (discarding the promise) and toast success unconditionally right
        // after — the exact "action's failure renders as success" class this
        // whole session targeted. addMission does real async work
        // (resolveProjectRoot, worktree/queue setup) that can reject; a
        // rejection used to vanish as an unobserved promise while the UI
        // still said "Mission lancée". Now awaited, same as launch_mission
        // above: a genuine failure throws here and is caught by the outer
        // per-action try/catch (sendManagerMessage), surfacing as an honest
        // actionFailed message instead of a silent lie.
        const clonedMissionId = await addMission({
          title: String(mods.title ?? `Clone: ${original.title}`),
          agentTask: String(mods.task ?? original.agentTask ?? original.title),
          agentName: String(mods.agentName ?? original.agentName ?? ''),
          repo: '.',
          worktree: '',
          // R13 (model-routing fix) — mods.model (when the manager supplies
          // an override) is a bare tier hint, same as create_draft/
          // launch_mission's own action.model — resolved the same way rather
          // than forwarded raw. original.model (the no-override fallback) is
          // already a real resolved id from ITS OWN creation, so it's used
          // as-is.
          modelLabel: mods.model ? resolveManagerModelId(String(mods.model), getProviderMode()) : String(original.model),
          mode: 'agent',
          orchestrator: false,
          // R13 — same DEFECT D/2 fix as launch_mission above: preserve the
          // original mission's configured mode when it had one, otherwise
          // default to 'acceptEdits' rather than leaving it undefined.
          permissionMode: original.contract?.permissionMode ?? 'acceptEdits',
          // Cross-project READ access — a clone inherits the ORIGINAL
          // mission's already-resolved, already-validated extra roots
          // unchanged (no re-resolution needed: these are real absolute
          // paths, not declared ids/names — see Mission.extraReadableRoots'
          // doc comment, types.ts). Absent when the original never declared
          // any, same as every other field here.
          extraReadableRoots: original.extraReadableRoots,
          originConversationId: conversationId,
        });
        toast(t('agents.manager.missionLaunched'), 'success');
        return { patchedRef: makeRef('mission', clonedMissionId) };
            },
      quote_mission: async () => {
        if (action.type !== 'quote_mission') return;
        try {
          const { quote } = await import('../../lib/agents/estimator');
          const modelLabel = action.model ?? resolveManagerModelId(undefined, getProviderMode());
          const q = await quote(action.task, { model: modelLabel, scopePaths: action.scopePaths });
          // Fix D (2026-08-19 dollar-kill incident, display half) — credits
          // (usdToCredits), never a raw "$" figure; native-rail quotes get
          // an explicit non-debited-equivalent qualifier (same rule as
          // NewMissionModal's own quote line and CostChip.tsx).
          const isNativeQuote = classifyMissionModel(modelLabel) === 'native';
          const creditsLo = usdToCredits(q.costUsd[0]);
          const creditsHi = usdToCredits(q.costUsd[1]);
          toast(
            isNativeQuote
              ? `Quote: ≈${creditsLo}–${creditsHi} credits (equivalent, not billed), ${q.durationMin[0]}–${q.durationMin[1]}min, ${q.agents} agent(s)`
              : `Quote: ${creditsLo}–${creditsHi} credits, ${q.durationMin[0]}–${q.durationMin[1]}min, ${q.agents} agent(s)`,
            'success',
          );
        } catch {
          toast('Quote unavailable', 'error');
        }
      },
      spawn_submissions: async () => {
        if (action.type !== 'spawn_submissions') return;
        const original = state.missions.find((m) => m.id === action.missionId);
        if (!original) {
          toast(t('agents.manager.missionNotFound', { id: action.missionId }), 'error');
          return;
        }
        const count = Math.min(action.count ?? 3, 10);
        const mods = action.modifications ?? [];
        // Closing-audit honesty fix: same class as clone_mission above — this
        // used to fire every addMission with `void` (discarded promise) and
        // toast "N submission(s) launched" unconditionally, regardless of
        // whether any of them actually launched. Now every submission is
        // awaited (Promise.all): a single rejection makes the WHOLE action
        // throw, caught by the outer per-action try/catch, so a partial or
        // total launch failure surfaces honestly instead of a flat lie.
        const launches: Promise<string>[] = [];
        for (let i = 0; i < count; i++) {
          const mod = mods[i] ?? {};
          // STACK fix: each submission may independently set "engine":
          // "cli"|"pro" (see spawn_submissions' doc comment in
          // managerEngine.ts) — narrowed here since `mod` is an untyped bag,
          // same treatment as `mod.model`/`mod.task` below.
          const modEngine = mod.engine === 'cli' || mod.engine === 'pro' ? mod.engine : undefined;
          // modelId catalog wave: `modifications` is an untyped bag (same as
          // mod.model/mod.engine above) — read `mod.modelId` the same way,
          // narrowed to a string, no type change needed on ManagerAction's
          // spawn_submissions variant.
          const modModelId = typeof mod.modelId === 'string' ? mod.modelId : undefined;
          launches.push(addMission({
            title: String(mod.title ?? `${original.title} (v${i + 1})`),
            agentTask: String(mod.task ?? original.agentTask ?? original.title),
            agentName: String(mod.agentName ?? original.agentName ?? ''),
            repo: '.',
            worktree: '',
            // R13 (model-routing fix) — same resolveManagerModelId treatment
            // as clone_mission above.
            modelLabel: (mod.model || modEngine || modModelId)
              ? resolveManagerModelId(mod.model ? String(mod.model) : undefined, getProviderMode(), modEngine, modModelId)
              : String(original.model),
            mode: 'agent',
            orchestrator: false,
            // R13 — same DEFECT D/2 fix as launch_mission/clone_mission above.
            permissionMode: original.contract?.permissionMode ?? 'acceptEdits',
            // Cross-project READ access — same inheritance as clone_mission
            // above (already-resolved roots, no re-resolution needed).
            extraReadableRoots: original.extraReadableRoots,
            originConversationId: conversationId,
          }));
        }
        await Promise.all(launches);
        toast(`${count} submission(s) launched`, 'success');
      },
      set_budget: async () => {
        if (action.type !== 'set_budget') return;
        const target = action.missionId ? state.missions.find((m) => m.id === action.missionId) : undefined;

        if (action.missionId && !target) {
          toast(t('agents.manager.missionNotFound', { id: action.missionId }), 'error');
          return;
        }

        // Real enforcement (spec §7.3/§8): classifyBudget/classifyBudgetStatus
        // (runtime.ts:316 / managedAgent.ts:426) read contract.budgetCapUsd
        // LIVE via getBudgetCapUsd — the stateRef-backed getter wired at
        // launch (agentsStore.tsx's addMission, ~line 1979) — on every check.
        // Patching it here through updateMission is the SAME real mechanism
        // AttentionInbox.tsx's raise-cap control uses (handleRaiseCap): it
        // genuinely raises/re-arms enforcement (and un-pauses a
        // budget-paused mission per the R1.1 mechanics), unlike the previous
        // placebo, which only emitted a fabricated budget.warning (pct:0,
        // a number that never measured anything real) and never touched the
        // mission at all.
        if (target?.contract) {
          updateMission({
            id: target.id,
            patch: { contract: { ...target.contract, budgetCapUsd: action.limitUsd } },
          });
          toast(`Budget cap set: $${action.limitUsd} for ${target.id}`, 'success');
        } else if (target) {
          // No launch contract to patch (a mission created before T1.2, or a
          // mock/demo mission) — the enforcer only ever reads
          // contract.budgetCapUsd, so there is nothing real to cap here.
          // Report that honestly instead of faking a cap that would never
          // be checked.
          toast(`Mission ${target.id} has no launch contract to cap`, 'error');
        } else {
          // projectId-only or fully-global cap: no per-project/global
          // enforcement sink exists yet (the engine only ever reads a
          // MISSION's own contract.budgetCapUsd) — say so honestly rather
          // than pretending a cap was applied somewhere real.
          toast('Only a specific mission\'s budget cap can be set today — project/global caps are not enforced yet', 'error');
        }
      },
      set_approval_mode: async () => {
        if (action.type !== 'set_approval_mode') return;
        // Real primitive — the SAME changeApprovalMode a future UI selector
        // would call, no parallel path. changeApprovalMode itself no-ops
        // (no persist, no journal write) when the requested mode already
        // matches the current effective one — the toast still confirms
        // honestly either way since nothing here claims a change happened
        // that didn't.
        await changeApprovalMode(action.mode, action.projectId);
        toast(
          action.projectId
            ? t('agents.manager.approvalModeChangedProject', { projectId: action.projectId, mode: action.mode })
            : t('agents.manager.approvalModeChangedGlobal', { mode: action.mode }),
          'success',
        );
      },
      revert_mission: async () => {
        if (action.type !== 'revert_mission') return;
        const root = await resolveProjectRoot().catch(() => '.');
        try {
          await revertMission(action.missionId, root);
          toast(`Mission ${action.missionId} reverted`, 'success');
        } catch (err) {
          toast(
            err instanceof Error ? err.message : `Failed to revert ${action.missionId}`,
            'error',
          );
        }
      },
      reassign_agent: async () => {
        if (action.type !== 'reassign_agent') return;
        const mission = state.missions.find((m) => m.id === action.missionId);
        if (!mission) {
          toast(t('agents.manager.missionNotFound', { id: action.missionId }), 'error');
          return;
        }

        // Unlike contract.budgetCapUsd (read live via getBudgetCapUsd on
        // every check), a mission's model is captured as a plain parameter
        // at launch time — there is no live getter re-read mid-run for it.
        // An ACTIVELY running mission (status 'running' and NOT paused)
        // cannot hot-swap its model, so patching it here would silently do
        // nothing for the run in flight; refuse honestly instead. A queued
        // mission (not yet launched) or a paused one (its own resume/retry
        // path clones the mission's CURRENT fields — see retryMission)
        // genuinely picks up the new model.
        const canReassign = mission.status === 'queued' || (mission.status === 'running' && mission.paused === true);
        if (!canReassign) {
          toast(`Mission ${mission.id} is running — cannot reassign its model while in flight`, 'error');
          return;
        }

        updateMission({ id: mission.id, patch: { model: action.model } });
        toast(`Mission ${mission.id} reassigned to ${action.model}`, 'success');
      },
      answer_question: async () => {
        if (action.type !== 'answer_question') return;
        const mission = state.missions.find((m) => m.id === action.missionId);
        if (!mission) {
          toast(t('agents.manager.missionNotFound', { id: action.missionId }), 'error');
          return;
        }

        // Mirrors AttentionInbox.tsx's own gating (its QuestionAnswerForm
        // only ever renders for a mission with a REAL pending ask_user
        // question) — never fabricate a question to pair with the decision
        // registry. interveneMission itself also silently no-ops on a
        // non-running mission, so this check doubles as the honest-toast
        // guard for that case too.
        const question = extractPendingQuestionText(mission);
        if (mission.status !== 'running' || !question) {
          toast(`Mission ${mission.id} has no pending question to answer`, 'error');
          return;
        }

        interveneMission(mission.id, action.answer);
        const root = await resolveProjectRoot().catch(() => '.');
        await recordMissionAnswer({
          missionId: mission.id,
          question,
          answer: action.answer,
          projectId: projectIdFromRoot(root),
          actor: 'user',
        });
        toast(`Answer delivered to ${mission.id}`, 'success');
      },
      create_draft: async () => {
        if (action.type !== 'create_draft') return;
        const draftId = generateCanvasId('draft');
        // W6e: resolve the requested projectId against the REAL open-project
        // directory (same source buildCanvasDigest reads) — absent defaults
        // to the ACTIVE project, a name resolves case-insensitively, and an
        // unresolvable value honestly falls back to Transverse instead of
        // silently mis-targeting or guessing (see resolveDraftProjectId's
        // doc comment in canvasDigest.ts).
        const projectResolution = await resolveDraftProjectId(action.projectId);
        canvasStoreVanilla.getState().addDraft({
          id: draftId,
          title: action.title ?? action.task.slice(0, 60),
          task: action.task,
          agentName: action.agentName,
          // R13 (model-routing fix, M22 dogfood: "billed sonnet despite
          // Haiku selector") — action.model is a bare TIER HINT
          // ("haiku"|"sonnet"|"opus"), same as launch_mission/create_loop's
          // own action.model — those two already resolve it via
          // resolveManagerModelId (mode-aware: managed-pool OpenRouter id vs
          // native registry id) before it ever reaches addMission. This case
          // used to store the RAW hint straight onto the draft; every real
          // launch path (draftLaunch.ts/chainEngine.ts) then forwarded that
          // raw string as `modelLabel` UNRESOLVED. In managed mode a bare
          // "haiku" is not a valid OpenRouter id (classifyMissionModel needs
          // a "/"), so the managed provider silently fell back to ITS OWN
          // default model — a real Sonnet-tier bill for a mission the user
          // picked Haiku for. Resolving here, at creation time, makes every
          // draft carry a real, already-mode-correct model id from the
          // start — absent (no override requested) stays absent so
          // draftLaunch.ts's own DEFAULT_DRAFT_MODEL_LABEL/
          // deps.defaultModelId() fallback is unchanged. STACK fix:
          // action.engine ALSO forces eager resolution (even with no tier
          // hint) so a deliberate "cli"/"pro" choice is baked into the
          // draft's model id now, not lost to the deferred default at
          // launch time (which has no engine field of its own to consult).
          // modelId catalog wave: action.modelId (exact catalog id) also
          // forces eager resolution here, same as action.engine already
          // does, and takes priority over action.model inside
          // resolveManagerModelId — see that function's own doc comment.
          model: (action.model || action.engine || action.modelId)
            ? resolveManagerModelId(action.model, getProviderMode(), action.engine, action.modelId)
            : undefined,
          projectId: projectResolution.projectId,
          createdBy: 'manager',
          // R13 — threads the manager's explicit override (if any) onto the
          // draft; absent falls back to 'acceptEdits' at launch/chain-fire
          // time (draftLaunch.ts/chainEngine.ts), which is what the R6b
          // scoped worktree-script gate requires — see DraftSpec's doc
          // comment (canvasTypes.ts).
          permissionMode: action.permissionMode,
        });
        // W6d: register this draft's ref under its alias (when given) so a
        // LATER action in this SAME reply (chain_agents/focus_canvas/
        // move_node/launch_draft) can resolve it — see resolveAliasedRef.
        if (action.alias) aliasMap.set(action.alias, makeRef('draft', draftId));
        emit('canvas:highlight', { refs: [makeRef('draft', draftId)] });
        const draftRef = makeRef('draft', draftId);
        if (projectResolution.unresolvedName) {
          toast(
            t('canvas.manager.draftProjectNotFound', {
              label: action.title ?? action.task.slice(0, 40),
              project: projectResolution.unresolvedName,
            }),
            'error',
          );
        } else {
          toast(t('canvas.manager.draftCreated', { label: action.title ?? action.task.slice(0, 40) }), 'success');
        }
        return { patchedRef: draftRef };
            },
      launch_draft: async () => {
        if (action.type !== 'launch_draft') return;
        // W6d: draftId is the normal path; draftAlias resolves a draft
        // created earlier in this SAME reply (aliasMap stores a full
        // NodeRef like "draft:abc" — unwrap back to the bare id launchDraft
        // expects via parseRef).
        //
        // SILENT NO-OP fix (2026-08-05, founder repro): a draftId captured
        // when this action was first queued for approval can go stale by
        // the time it actually executes (e.g. a reload's
        // materializedPlanRepair re-homing a still-pending plan node's
        // project — see that module's own header). The OLD code only ever
        // tried the literal `action.draftId` and, on a miss, just toasted
        // + `break`ed with NO thrown error. That is a silent no-op to both
        // real callers of this executor: sendManagerMessage's action loop
        // and approvePendingAction (further below) only ever record a
        // FAILED action when this function THROWS (see the identical
        // approve_mission fix above, same file, for the precedent) — a
        // plain toast+break reads as an ordinary, silent SUCCESS to both,
        // so the approved action was quietly dropped: no mission created,
        // no error, no "Résultat réel" chat message ever appended. Two
        // independent fixes below:
        //   1. The lookup now ALSO falls back to draftAlias when a
        //      draftId WAS given but no longer resolves to a live draft
        //      (previously the alias fallback only fired when draftId was
        //      entirely absent) — the aliasMap can still resolve the same
        //      draft this reply/turn actually meant even once the literal
        //      id it captured earlier no longer matches anything live.
        //   2. Any remaining failure now THROWS (never a silent break)
        //      with an honest, actionable reason, so it always surfaces as
        //      a visible chat message + toast, exactly like every other
        //      real failure in this executor.
        let draftId = action.draftId;
        const isLiveDraft = (id: string | undefined): boolean =>
          !!id && canvasStoreVanilla.getState().drafts.some((d) => d.id === id);
        if (!isLiveDraft(draftId) && action.draftAlias) {
          const resolved = aliasMap.get(action.draftAlias);
          const parsed = resolved ? parseRef(resolved) : null;
          if (parsed && parsed.kind === 'draft') draftId = parsed.id;
        }
        const draftMissingMessage = 'Brouillon introuvable — il a peut-être été renommé au rechargement. Relance depuis la carte du canvas.';
        if (!draftId) {
          throw new Error(draftMissingMessage);
        }
        const activeProjectId = projectIdFromRoot(await resolveProjectRoot().catch(() => '.'));
        let result = await launchDraft(draftId, { addMission, activeProjectId });
        // AUTO-ACTIVATE fix (2026-08-05, founder dogfood, issue #21): a
        // multi-project fleet routinely targets a draft at a project that is
        // OPEN but simply not the one currently active — launchDraft
        // honestly (and correctly) refuses that as 'inactiveProject', but
        // until now the executor just surfaced the refusal verbatim, forcing
        // the user to manually activate the project and re-ask. When the
        // failure is SPECIFICALLY inactiveProject (never notFound/engine-not-
        // ready, which stay honest failures below) AND the draft's own
        // projectId names a project that IS open right now (appContext.
        // openProjects — the same real registry close_project's executor
        // above reads, compared via normalizeForMembershipCompare like every
        // other drive-case/slash-tolerant project match in this file), the
        // executor activates it via the SAME real switchProject() primitive
        // close_project already uses (never a second, divergent activation
        // path) and retries launchDraft exactly ONCE. A project that is not
        // open at all (appContext absent, or no matching entry) falls
        // through unchanged to the existing honest failure below — this
        // never silently registers/opens a new project.
        let autoActivatedProjectName: string | undefined;
        if (!result.ok && result.reasonKey === 'canvas.draftLaunch.inactiveProject' && appContext) {
          const draftProjectId = canvasStoreVanilla.getState().drafts.find((d) => d.id === draftId)?.projectId;
          const openEntry = draftProjectId !== undefined
            ? appContext.openProjects.find(
                (p) => normalizeForMembershipCompare(p.root) === normalizeForMembershipCompare(draftProjectId),
              )
            : undefined;
          if (openEntry) {
            await appContext.switchProject(openEntry.id);
            // Use the entry we just activated — resolveProjectRoot() can
            // still return the previous root from its IPC cache until
            // project://changed invalidates it (jsdom tests never emit that).
            const retryActiveProjectId = projectIdFromRoot(openEntry.root);
            result = await launchDraft(draftId, { addMission, activeProjectId: retryActiveProjectId });
            if (result.ok) autoActivatedProjectName = basename(openEntry.root);
          }
        }
        if (!result.ok) {
          // Loud, honest failure (never a silent no-op) — the "not found"
          // reason gets the standard real-result message above (the user's
          // next step is always the same: relaunch from the canvas card,
          // which reads the CURRENT live draft id directly); every other
          // reason (wrong active project, engine not ready, ...) keeps its
          // own already-specific translated wording, just now thrown
          // instead of merely toasted so it is never dropped silently.
          throw new Error(result.reasonKey === 'canvas.draftLaunch.notFound' ? draftMissingMessage : t(result.reasonKey));
        }
        emit('canvas:highlight', { refs: [makeRef('mission', result.missionId)] });
        toast(t('canvas.manager.draftLaunched'), 'success');
        return {
          patchedRef: makeRef('mission', result.missionId),
          // Honest real-result line (never silent about the side-effecting
          // auto-activation) — reuses the SAME translated sentence the
          // human's own cross-project "Lancer" flow already shows
          // (useCanvasEditing.ts's switchToProjectIfNeeded/Cockpit.tsx),
          // never a second, divergent copy.
          message: autoActivatedProjectName
            ? t('cockpit.toast.projectSwitched', { name: autoActivatedProjectName })
            : undefined,
        };
            },
      chain_agents: async () => {
        if (action.type !== 'chain_agents') return;
        // W6d: sourceRef is the normal path (must already name an existing
        // mission/loop — UNCHANGED gate below); sourceAlias resolves a node
        // created earlier in this SAME reply via aliasMap, which — unlike a
        // literal string — is guaranteed to reference something this very
        // execution actually just created, so a 'draft' kind is allowed
        // through THAT path only (a human can drag-connect a chain FROM a
        // draft node the same way; canvasStore.ts's remapDraftToMission
        // re-points sourceRef to the real mission ref once that draft
        // launches — see chain_agents's doc comment in types.ts).
        const sourceResolution = resolveAliasedRef(action.sourceRef, action.sourceAlias, aliasMap);
        if (!sourceResolution.ok) {
          toast(t(sourceResolution.reasonKey, sourceResolution.params), 'error');
          return;
        }
        const sourceRef = sourceResolution.ref;
        const sourceParsed = parseRef(sourceRef);
        const validSourceKinds: string[] = sourceResolution.viaAlias
          ? ['mission', 'loop', 'draft']
          : ['mission', 'loop'];
        if (!sourceParsed || !validSourceKinds.includes(sourceParsed.kind)) {
          toast(t('canvas.manager.invalidChainSource', { ref: sourceRef }), 'error');
          return;
        }

        // Narrowed into a local const first: TypeScript's `in`-narrowing on
        // a property access (action.target) does not persist inside the
        // nested closures below (e.g. .find((d) => ... target.draftId)) —
        // only narrowing on a local const identifier does.
        const target = action.target;
        let targetRef: string;
        let targetInfo: ChainTargetInfo;
        if ('draftId' in target) {
          const draft = canvasStoreVanilla.getState().drafts.find((d) => d.id === target.draftId);
          if (!draft) {
            toast(t('canvas.manager.draftNotFound', { id: target.draftId }), 'error');
            return;
          }
          targetRef = makeRef('draft', draft.id);
          targetInfo = { kind: 'draft' };
        } else if ('missionId' in target) {
          const targetMission = state.missions.find((m) => m.id === target.missionId);
          if (!targetMission) {
            toast(t('agents.manager.missionNotFound', { id: target.missionId }), 'error');
            return;
          }
          targetRef = makeRef('mission', targetMission.id);
          targetInfo = { kind: 'mission', missionStatus: targetMission.status };
        } else if ('targetAlias' in target) {
          // W6d: target created earlier in this SAME reply (e.g. a second
          // create_draft) — resolve through the same aliasMap as the source.
          const resolved = aliasMap.get(target.targetAlias);
          if (!resolved) {
            toast(t('canvas.manager.unknownAlias', { alias: target.targetAlias }), 'error');
            return;
          }
          const parsedTarget = parseRef(resolved);
          if (!parsedTarget) {
            toast(t('canvas.manager.invalidRef', { ref: resolved }), 'error');
            return;
          }
          targetRef = resolved;
          if (parsedTarget.kind === 'mission') {
            const targetMission = state.missions.find((m) => m.id === parsedTarget.id);
            targetInfo = { kind: 'mission', missionStatus: targetMission?.status };
          } else {
            targetInfo = { kind: parsedTarget.kind };
          }
        } else {
          // Inline spec — arm a fresh draft first (same as create_draft),
          // then chain to it. A brand-new ref can never close a cycle or
          // collide with an existing chain, so validateChain below always
          // passes for this branch; the draft still gets created (never a
          // half-applied action) even in the theoretical case it didn't.
          // W6e: same projectId resolution as create_draft's own case above
          // (absent -> active project, name resolved case-insensitively,
          // unresolvable -> honest Transverse fallback + toast).
          const draftId = generateCanvasId('draft');
          // Mid-plan continuation fix (2026-08-02 escalation — real founder
          // repro: "no chain after M1/M2 in lazy-backoffice" while a
          // DIFFERENT project happened to be active): resolveDraftProjectId's
          // "absent -> active project" default is right for a fresh
          // create_draft with no other context, but wrong HERE, where the
          // chain's own sourceRef already names a real project — a mission
          // (already homed somewhere real, per resolveMissionProjectRoot) or
          // a draft created earlier this same turn. Only kicks in when the
          // caller left projectId genuinely blank; an explicit (even
          // unresolvable) projectId is never overridden.
          let inlineProjectResolution = await resolveDraftProjectId(target.projectId);
          if (!target.projectId?.trim()) {
            let sourceProjectId: string | undefined;
            if (sourceParsed.kind === 'draft') {
              sourceProjectId = canvasStoreVanilla.getState().drafts.find((d) => d.id === sourceParsed.id)?.projectId;
            } else {
              const sourceRoot = await resolveMissionProjectRoot(sourceParsed.id);
              sourceProjectId = sourceRoot ? projectIdFromRoot(sourceRoot) : undefined;
            }
            if (sourceProjectId) inlineProjectResolution = { projectId: sourceProjectId };
          }
          canvasStoreVanilla.getState().addDraft({
            id: draftId,
            title: target.title ?? target.task.slice(0, 60),
            task: target.task,
            agentName: target.agentName,
            // R13 (model-routing fix) — same resolveManagerModelId call as
            // create_draft's own case above; see its doc comment for the
            // full M22 root-cause ("billed sonnet despite Haiku selector").
            model: target.modelId ?? (target.model ? resolveManagerModelId(target.model, getProviderMode()) : undefined),
            projectId: inlineProjectResolution.projectId,
            createdBy: 'manager',
            // R13 — same override threading as create_draft's own case above.
            permissionMode: target.permissionMode,
          });
          if (inlineProjectResolution.unresolvedName) {
            toast(
              t('canvas.manager.draftProjectNotFound', {
                label: target.title ?? target.task.slice(0, 40),
                project: inlineProjectResolution.unresolvedName,
              }),
              'error',
            );
          }
          targetRef = makeRef('draft', draftId);
          targetInfo = { kind: 'draft' };
        }

        const validation = validateChain(canvasStoreVanilla.getState().chains, sourceRef, targetRef, targetInfo);
        if (!validation.ok) {
          toast(t(validation.reasonKey), 'error');
          return;
        }

        canvasStoreVanilla.getState().addChain({
          id: generateCanvasId('chain'),
          sourceRef,
          targetRef,
          condition: action.condition ?? 'success',
          createdBy: 'manager',
        });
        emit('canvas:highlight', { refs: [sourceRef, targetRef] });
        toast(t('canvas.manager.chainCreated'), 'success');
      },
      unchain: async () => {
        if (action.type !== 'unchain') return;
        const exists = canvasStoreVanilla.getState().chains.some((c) => c.id === action.chainId);
        if (!exists) {
          toast(t('canvas.manager.chainNotFound', { id: action.chainId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().removeChain(action.chainId);
        toast(t('canvas.manager.chainDeleted'), 'success');
      },
      arrange_canvas: async () => {
        if (action.type !== 'arrange_canvas') return;
        // Bus route deliberately (see lib/bus.ts's 'canvas:arrange'): only
        // CanvasView.tsx owns the live nodes/edges the elkjs layout needs —
        // reconstructing them here would duplicate the reconciler as a
        // second source of truth. A no-op when the canvas isn't mounted
        // (no open project) — same honest, non-blocking shape as every
        // other bus-routed action in this store (e.g. agent:launch above).
        emit('canvas:arrange', { scope: action.scope, mode: action.mode });
        toast(t('canvas.manager.layoutRequested'), 'info');
      },
      focus_canvas: async () => {
        if (action.type !== 'focus_canvas') return;
        // W6d: ref is the normal path; refAlias resolves a node created
        // earlier in this SAME reply (see resolveAliasedRef above).
        const resolution = resolveAliasedRef(action.ref, action.refAlias, aliasMap);
        if (!resolution.ok) {
          toast(t(resolution.reasonKey, resolution.params), 'error');
          return;
        }
        const parsed = parseRef(resolution.ref);
        if (!parsed) {
          toast(t('canvas.manager.invalidRef', { ref: resolution.ref }), 'error');
          return;
        }
        // Same precedent as the agent:launch bus handler above
        // (`emit('nav:navigateSpace', 'agents')`): always navigate to the
        // Agents space so the camera glide is actually visible, regardless
        // of which space the user is currently looking at.
        emit('nav:navigateSpace', 'agents');
        emit('canvas:focus', { ref: resolution.ref });
      },
      move_node: async () => {
        if (action.type !== 'move_node') return;
        // W6d: ref is the normal path; refAlias resolves a node created
        // earlier in this SAME reply (see resolveAliasedRef above).
        const resolution = resolveAliasedRef(action.ref, action.refAlias, aliasMap);
        if (!resolution.ok) {
          toast(t(resolution.reasonKey, resolution.params), 'error');
          return;
        }
        const parsed = parseRef(resolution.ref);
        if (!parsed) {
          toast(t('canvas.manager.invalidRef', { ref: resolution.ref }), 'error');
          return;
        }
        canvasStoreVanilla.getState().setPosition(resolution.ref, { x: action.x, y: action.y });
      },
      canvas_note: async () => {
        if (action.type !== 'canvas_note') return;
        const noteId = generateCanvasId('note');
        canvasStoreVanilla.getState().addNote({ id: noteId, text: action.text, projectId: action.projectId });
        emit('canvas:highlight', { refs: [makeRef('note', noteId)] });
        toast(t('canvas.manager.noteAdded'), 'success');
      },
      start_preview: async () => {
        if (action.type !== 'start_preview') return;
        const projectResolution = await resolveDraftProjectId(action.projectId);
        // Mention-routing backstop (2026-08-05, real incident — same
        // helper/concept as launch_mission's 2026-08-03 fix and
        // generate_plan's 2026-08-04 parity fix; see
        // resolveMentionedProjectRoot's own doc comment): the user had just
        // been talking about a DIFFERENT open project ("Lazy-real-test")
        // and a bare start_preview (no projectId) still camera-centered the
        // ACTIVE project's empty zone instead. Gated on the RAW
        // `action.projectId` being blank — deliberately NEVER on
        // `projectResolution.projectId` (unlike launch_mission/
        // generate_plan's own guard): resolveDraftProjectId already
        // defaults a blank id to whatever project is ACTIVE (see its own
        // doc comment), so gating on ITS result would skip this branch in
        // exactly the case that matters — an active project already open.
        // start_preview carries no free-text field of its own (unlike
        // launch_mission's task / generate_plan's objective+steps) for a
        // weak manager model to leak its real target into, so the user's
        // own last message is the only text left to scan. A resolved
        // mention WINS over the active-project default — it is a specific,
        // unambiguous match, exactly what the user was just talking about.
        let mentionedProjectRoot: { id: string; root: string } | undefined;
        if (!action.projectId?.trim() && lastUserMessageText) {
          mentionedProjectRoot = await resolveMentionedProjectRoot(lastUserMessageText);
          if (mentionedProjectRoot) {
            console.warn(`[start_preview] routed by mention -> project ${mentionedProjectRoot.id} (${mentionedProjectRoot.root})`);
          }
        }
        const targetProjectId = mentionedProjectRoot?.id ?? projectResolution.projectId;
        const projectRoot = mentionedProjectRoot
          ? mentionedProjectRoot.root
          : targetProjectId ? await resolveProjectRootById(targetProjectId) : undefined;
        if (!targetProjectId || !projectRoot) {
          toast(t('agents.manager.startPreviewNoProject'), 'error');
          return;
        }

        let result: Awaited<ReturnType<typeof ensureDevServerForProject>>;
        try {
          // USER-INITIATED START (2026-08-08, real-user report: "demande
          // d'ouvrir le site en localhost dans le canvas, il n'y arrive
          // pas"). ensureDevServerForProject's preemptive pressure gate
          // (doEnsureDevServerForProject) is designed for the BACKGROUND
          // auto-probe (useCanvasAutoComposition.ts) — a NEW spawn is
          // declined at 'elevated' system pressure so a busy machine isn't
          // hammered by a polling loop. But start_preview is the user
          // EXPLICITLY asking to start the site: blocking it silently under
          // the same elevated-pressure rule read as "le lazyide n'arrive
          // pas à ouvrir le localhost". allowElevatedPressure relaxes only
          // the 'elevated' rung (still hard-blocked at 'high') — exactly
          // the same latitude the insufficient-memory single retry already
          // gets — so an explicit user request is never silently refused.
          result = await ensureDevServerForProject(targetProjectId, projectRoot, undefined, undefined, {
            allowElevatedPressure: true,
          });
        } catch {
          // devPreview.ts's own boundaries never reject — defense-in-depth
          // only, same posture as useCanvasAutoComposition.ts's own catch
          // around this exact call.
          result = null;
        }
        if (!result) {
          toast(t('canvas.manager.previewStartFailed'), 'error');
          return;
        }

        // R7 "living surfaces" fix — link the preview to whichever mission
        // is actually working on this project (spec: "linked to the
        // agents/missions working on it") via SurfaceSpec.ownerRef.
        // `state.missions` only ever holds the ACTIVE project's missions
        // (see changeApprovalMode's own doc comment for this pre-existing
        // architectural constraint) — only trust it when targetProjectId
        // really IS the active project. Always re-resolved fresh (never
        // inferred from action.projectId's own blank/non-blank shape) since
        // the mention-routing backstop above can leave action.projectId
        // blank while targetProjectId is a DIFFERENT, non-active project —
        // never risk attributing a DIFFERENT project's running mission to
        // this preview.
        const isActiveProject = (await resolveDraftProjectId(undefined)).projectId === targetProjectId;
        const ownerRef = isActiveProject ? findRunningMissionRef(state.missions) : undefined;

        // Reuse the project's existing preview surface (never a second one)
        // — the SAME invariant useCanvasAutoComposition.ts's auto-detect
        // enforces, shared via previewSurface.ts so neither reimplements
        // it. Never `autoAdded` here (unlike that passive path) — this is
        // an explicit manager action (SurfaceSpec.autoAdded's own doc
        // comment).
        const surfaceRef = ensureProjectPreviewSurface(
          targetProjectId,
          result.url,
          {
            surfaces: canvasStoreVanilla.getState().surfaces,
            addSurface: canvasStoreVanilla.getState().addSurface,
            updateSurface: canvasStoreVanilla.getState().updateSurface,
            generateId: () => generateCanvasId('preview'),
          },
          { ownerRef },
        );
        // SAME bus choreography as focus_canvas above (never duplicated):
        // navigate to the Agents space so the camera glide is actually
        // visible, then canvas:focus — its own handler already pulses the
        // ref (useCanvasManagerEvents.ts), so a separate canvas:highlight
        // here would just double-pulse the same node. Bug fix: a plain
        // bounding-box fitView left the camera at the canvas's global zoom
        // floor (an unreadable speck) instead of the live localhost the
        // user asked to see — minZoom guarantees a legible floor (see
        // PREVIEW_FOCUS_MIN_ZOOM's own doc comment).
        emit('nav:navigateSpace', 'agents');
        emit('canvas:focus', { ref: surfaceRef, minZoom: PREVIEW_FOCUS_MIN_ZOOM });
        toast(t('canvas.manager.previewReady', { url: result.url }), 'success');
      },
      analyze_frictions: async () => {
        if (action.type !== 'analyze_frictions') return;
        const projectResolution = await resolveDraftProjectId(action.projectId);
        const targetProjectId = projectResolution.projectId;
        if (!targetProjectId) {
          toast(t('agents.manager.frictionAnalysisNoProject'), 'error');
          return;
        }
        const projectRoot = getRuntimeProject(targetProjectId)?.projectRoot;
        const result = await runFrictionAnalysis(targetProjectId, projectRoot, t('agents.selfImprove.frameTitle'));
        if (result.candidates.length === 0) {
          toast(t('agents.manager.frictionAnalysisNone'), 'info');
          return;
        }
        emit('canvas:highlight', {
          refs: [...(result.frameId ? [makeRef('frame', result.frameId)] : []), ...result.draftIds.map((id) => makeRef('draft', id))],
        });
        toast(t('agents.manager.frictionAnalysisDone', { count: String(result.candidates.length) }), 'success');
      },
      collapse_project: async () => {
        if (action.type !== 'collapse_project') return;
        // Bug fix (real-user finding): this used to key `collapsed` off
        // `action.projectId` VERBATIM — but every other project-targeting
        // action accepts either a known project id OR its display name
        // (create_draft's own doc comment / resolveDraftProjectId), and the
        // manager routinely refers to a project by name (the canvas digest
        // shows both). A name that never matched the raw `collapsed` key
        // used to silently toggle a bogus, invisible entry instead of the
        // REAL zone — this is why "collapse/enlève le projet Lazy" (a name)
        // used to visibly do nothing. Resolve it the same way every other
        // project-targeting action does; fall back to the raw value ONLY
        // when it resolves to nothing (never BLOCK a literal id that
        // happens not to be in the live directory yet — same non-regressive
        // fallback rule create_draft's own honest-degrade uses elsewhere).
        const resolution = await resolveDraftProjectId(action.projectId);
        const targetProjectId = resolution.projectId ?? action.projectId;
        const isCollapsed = canvasStoreVanilla.getState().collapsed[targetProjectId] ?? false;
        if (isCollapsed !== action.collapsed) canvasStoreVanilla.getState().toggleCollapsed(targetProjectId);
        toast(t(action.collapsed ? 'canvas.manager.projectCollapsed' : 'canvas.manager.projectExpanded'), 'success');
      },
      clear_canvas: async () => {
        if (action.type !== 'clear_canvas') return;
        const scope = action.scope;
        const mode = action.mode ?? 'archive';
        const includeReview = action.includeReview === true;

        if (scope === 'selection' && (!action.refs || action.refs.length === 0)) {
          const message = t('canvas.manager.clearCanvasNoRefs');
          toast(message, 'error');
          return { message };
        }

        // Project narrowing: required for scope 'project', optional (but
        // honest — never silently mis-target) for every other scope. Same
        // name-or-id resolution as create_draft's own `projectId`.
        let targetProjectId: string | undefined;
        if (scope === 'project' || action.projectId?.trim()) {
          const resolution = await resolveDraftProjectId(action.projectId);
          if (!resolution.projectId) {
            const message = t('canvas.manager.clearCanvasProjectNotFound', { project: action.projectId ?? '' });
            toast(message, 'error');
            return { message };
          }
          targetProjectId = resolution.projectId;
        }

        // 2026-08-06 (founder: "il a pas fait ce que je demande ... nettoie
        // le canva") — clear_canvas used to plan ONLY against
        // `state.missions` (a single-project store), so terminal missions
        // the canvas shows from OTHER projects / earlier sessions (journal
        // projection — the canvas's real source of truth) were invisible
        // to the sweep: the action reported "5 élément(s) nettoyé(s)"
        // (drafts only) while the board stayed full of failed/interrupted
        // missions. The plan now loads missions from the JOURNAL for every
        // open project — the SAME source the canvas renders — and
        // out-of-store missions are archived/deleted via
        // tombstoneJournalMission (the same journal-first primitive the
        // cross-project zombie sweep already uses). The message then
        // reports the REAL total the user can verify against the board.
        let planMissions: Mission[] = state.missions;
        try {
          const openProjects = await listProjects();
          const fromJournal: Mission[] = [];
          for (const p of openProjects) {
            const loaded = await loadMissionsFromJournal(projectIdFromRoot(p.root));
            if (loaded) fromJournal.push(...loaded);
          }
          if (fromJournal.length > 0) {
            const seen = new Set(planMissions.map((m) => m.id));
            planMissions = [...planMissions, ...fromJournal.filter((m) => !seen.has(m.id))];
          }
        } catch {
          // Best-effort — fall back to state.missions only (pre-fix
          // behaviour) if the project list or journal read fails.
        }
        const activeRoot = await resolveProjectRoot().catch(() => '.');
        const projectIdOf = (m: Mission): string => projectIdFromRoot(m.repoRoot ?? activeRoot);

        const snapshot: ClearCanvasSnapshot = {
          missions: planMissions,
          drafts: canvasStoreVanilla.getState().drafts,
          notes: canvasStoreVanilla.getState().notes,
          surfaces: canvasStoreVanilla.getState().surfaces,
          routers: canvasStoreVanilla.getState().routers,
          joins: canvasStoreVanilla.getState().joins,
          frames: canvasStoreVanilla.getState().frames,
        };
        const plan = planClearCanvas(scope, snapshot, {
          mode,
          projectId: targetProjectId,
          olderThanHours: action.olderThanHours,
          refs: action.refs,
          includeReview,
          nowMs: Date.now(),
        });

        if (plan.unknownScope !== undefined) {
          const message = t('canvas.manager.clearCanvasUnknownScope', { scope: plan.unknownScope });
          toast(message, 'error');
          return { message };
        }

        // P0 fix (real user test): a mission in 'review' is never swept by
        // 'all'/'project'/'terminated' unless `includeReview` was set — say
        // so honestly and actionably (exact count + refs) instead of a bare
        // "nothing to clean up" in front of a canvas the user can still see
        // full of them (reviewMissionsAwaitingDecision's own doc comment).
        const reviewNotice = plan.reviewExcludedIds.length > 0
          ? ` ${t('canvas.manager.clearCanvasReviewExcluded', {
              count: String(plan.reviewExcludedIds.length),
              ids: summarizeIds(plan.reviewExcludedIds.map((id) => makeRef('mission', id))),
            })}`
          : '';

        const total =
          plan.missionIds.length + plan.draftIds.length + plan.noteIds.length +
          plan.surfaceRefs.length + plan.routerIds.length + plan.joinIds.length + plan.frameIds.length;
        if (total === 0) {
          const message = `${t('canvas.manager.clearCanvasEmpty')}${reviewNotice}`;
          toast(message, 'info');
          return { message };
        }

        // Missions: archive (default, non-destructive) or delete
        // (irreversible — only ever reached when the manager/user explicitly
        // asked for permanent deletion, see CLEANUP DESTRUCTIVENESS in
        // managerEngine.ts's Rules section). Every other kind below has no
        // archived state of its own — always a genuine removal.
        // 2026-08-06: a mission in `plan.missionIds` may live ONLY in the
        // journal (never hydated into this single-project store) — the
        // in-store path keeps its full lifecycle (worktree/loop cleanup +
        // state patch), the journal-only path uses tombstoneJournalMission
        // (same journal-first write deleteMission/archiveMission already use
        // for the out-of-state case).
        for (const id of plan.missionIds) {
          const inState = state.missions.some((m) => m.id === id);
          if (mode === 'delete') {
            if (inState) deleteMission(id);
            else {
              const m = planMissions.find((x) => x.id === id);
              if (m) void tombstoneJournalMission(id, projectIdOf(m), m);
            }
          } else if (inState) {
            archiveMission(id);
          } else {
            const m = planMissions.find((x) => x.id === id);
            if (m) void tombstoneJournalMission(id, projectIdOf(m), m);
          }
        }
        for (const id of plan.draftIds) canvasStoreVanilla.getState().removeDraft(id);
        for (const id of plan.noteIds) canvasStoreVanilla.getState().removeNote(id);
        for (const surface of plan.surfaceRefs) canvasStoreVanilla.getState().removeSurface(surface.id);
        for (const id of plan.routerIds) canvasStoreVanilla.getState().removeRouter(id);
        for (const id of plan.joinIds) canvasStoreVanilla.getState().removeJoin(id);
        for (const id of plan.frameIds) canvasStoreVanilla.getState().removeFrame(id);

        const clearCanvasMessage = `${t('canvas.manager.clearCanvasDone', {
          total: String(total),
          detail: summarizeIds(describeClearCanvasRefs(plan)),
        })}${reviewNotice}`;
        toast(clearCanvasMessage, 'success');
        return { message: clearCanvasMessage };
            },
      archive_mission: async () => {
        if (action.type !== 'archive_mission') return;
        const mission = state.missions.find((m) => m.id === action.missionId);
        if (!mission) {
          // B1 fix — same journal-first fallback as delete_mission above:
          // an orphan row is only archivable when its own recorded status
          // is genuinely terminal (mirrors the live-target guard just
          // below) — never assumed for a mission that might still be
          // running in a session this one cannot see.
          //
          // BUG 3 fix (dogfood 2026-08-05, real fixture stuck in review): a
          // 'review' row is ALSO archivable here, same as the live-target
          // branch below — see that branch's own comment for the rationale.
          const row = await findJournalMissionRow(action.missionId);
          if (!row) {
            toast(t('agents.manager.missionNotFound', { id: action.missionId }), 'error');
            return;
          }
          const rowStatus = String(row.data['status'] ?? '');
          if (!isTerminalMissionStatus(rowStatus as Mission['status']) && rowStatus !== 'review') {
            // LOUD REFUSAL fix (THE SYSTEMIC BUG, 2026-08-06): the row
            // genuinely EXISTS (found above) and is still active
            // (running/queued — isTerminalMissionStatus excludes
            // done/failed/cancelled, 'review' is excluded by this check
            // itself) — this used to fall through to the SAME
            // "missionNotFound" text as a truly-missing row, actively
            // misleading the caller about a mission it could plainly see.
            toast(ARCHIVE_REFUSED_ACTIVE_MISSION_MESSAGE, 'error');
            return { message: ARCHIVE_REFUSED_ACTIVE_MISSION_MESSAGE };
          }
          await tombstoneJournalMission(action.missionId, row.projectId, row.data);
          const message = t('canvas.manager.missionArchivedOne', { id: action.missionId });
          toast(message, 'success');
          return {
            message,
            digest: { kind: 'mission_removed', missionId: action.missionId, removedAs: 'archived', worktree: { outcome: 'skipped' } },
          };
        }
        // BUG 3 fix (dogfood 2026-08-05): a mission explicitly named by the
        // manager/user is now archivable directly from 'review' too, not
        // only from a terminal status. This used to hard-block with
        // archiveNotTerminal, leaving the manager unable to honor an
        // explicit "archive M21" request — it looped reasoning about
        // needing to "abandon the merge decision" first, with no action
        // able to do that, and never actually archived anything (see
        // managerEngine.ts's item 53 doc comment for the model-facing half
        // of this fix). Archiving a 'review' mission this way does NOT
        // approve or reject it — the pending merge decision is simply
        // abandoned, unresolved, same trade-off as clear_canvas's own
        // "includeReview" flag — just for ONE mission the caller already
        // named explicitly, never a silent bulk sweep, so this stays
        // SAFE-tier (see actionClassifier.ts) rather than needing its own
        // approval gate.
        if (!isTerminalMissionStatus(mission.status) && mission.status !== 'review') {
          // LOUD REFUSAL fix (THE SYSTEMIC BUG, 2026-08-06) — same message
          // as the orphan-row branch above; only ever reached for
          // 'running'/'queued' (isTerminalMissionStatus excludes
          // done/failed/cancelled, 'review' is excluded by this check
          // itself). Used to report a generic "not terminal" with no
          // pointer to what DOES work on an active mission.
          toast(ARCHIVE_REFUSED_ACTIVE_MISSION_MESSAGE, 'error');
          return { message: ARCHIVE_REFUSED_ACTIVE_MISSION_MESSAGE };
        }
        archiveMission(action.missionId);
        toast(t('canvas.manager.missionArchivedOne', { id: action.missionId }), 'success');
      },
      archive_terminated: async () => {
        if (action.type !== 'archive_terminated') return;
        // state.missions only ever holds the ACTIVE project's missions (see
        // changeApprovalMode's own doc comment) — a projectId naming a
        // DIFFERENT project has nothing here to archive; report that
        // honestly rather than silently archiving the wrong project (or
        // nothing, with no explanation).
        if (action.projectId?.trim()) {
          const [requested, active] = await Promise.all([
            resolveDraftProjectId(action.projectId),
            resolveDraftProjectId(undefined),
          ]);
          if (!requested.projectId || requested.projectId !== active.projectId) {
            const message = t('canvas.manager.archiveTerminatedWrongProject', { project: action.projectId });
            toast(message, 'error');
            return { message };
          }
        }
        const targets = state.missions.filter((m) => isTerminalMissionStatus(m.status) && !m.archived);
        // P0 fix — same honest, actionable notice as clear_canvas's own
        // 'terminated' scope (archive_terminated's own doc comment: a
        // convenience shorthand for it): a 'review' mission is never
        // "terminal" here either, so say exactly how many are left behind
        // instead of a bare "nothing to clean up" in front of a canvas that
        // still shows them.
        const reviewExcluded = reviewMissionsAwaitingDecision(state.missions);
        const reviewNotice = reviewExcluded.length > 0
          ? ` ${t('canvas.manager.clearCanvasReviewExcluded', {
              count: String(reviewExcluded.length),
              ids: summarizeIds(reviewExcluded.map((m) => makeRef('mission', m.id))),
            })}`
          : '';
        if (targets.length === 0) {
          const message = `${t('canvas.manager.clearCanvasEmpty')}${reviewNotice}`;
          toast(message, 'info');
          return { message };
        }
        for (const m of targets) archiveMission(m.id);
        const archiveTerminatedMessage = `${t('canvas.manager.missionsArchived', {
          count: String(targets.length),
          ids: summarizeIds(targets.map((m) => m.id)),
        })}${reviewNotice}`;
        toast(archiveTerminatedMessage, 'success');
        return { message: archiveTerminatedMessage };
            },
      delete_draft: async () => {
        if (action.type !== 'delete_draft') return;
        const exists = canvasStoreVanilla.getState().drafts.some((d) => d.id === action.draftId);
        if (!exists) {
          toast(t('canvas.manager.draftNotFound', { id: action.draftId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().removeDraft(action.draftId);
        toast(t('canvas.manager.draftDeleted', { id: action.draftId }), 'success');
      },
      reject_plan: async () => {
        if (action.type !== 'reject_plan') return;
        // Retroactive plan-proposal rejection (types.ts's reject_plan doc
        // comment) — the SAME real primitive the chat proposal card's own
        // "Rejeter" button already calls (canvasStore.ts's
        // rejectProposedPlan), now reachable by planId instead of only for
        // THIS turn's own card. Existence check mirrors delete_draft's own
        // (drafts/chains/joins are the three shapes rejectProposedPlan
        // sweeps — see its own implementation, canvasStore.ts) so a planId
        // with nothing left tagged gets an honest "not found" rather than a
        // silent no-op success.
        const canvasState = canvasStoreVanilla.getState();
        const hasPreview =
          canvasState.drafts.some((d) => d.proposedPlanId === action.planId) ||
          canvasState.chains.some((c) => c.proposedPlanId === action.planId) ||
          canvasState.joins.some((j) => j.proposedPlanId === action.planId);
        if (!hasPreview) {
          toast(t('canvas.manager.planNotFound', { id: action.planId }), 'error');
          return;
        }
        canvasState.rejectProposedPlan(action.planId);
        console.warn(`[reject_plan] rejected proposal preview for plan ${action.planId}`);
        toast(t('canvas.manager.planRejected', { id: action.planId }), 'success');
      },
      delete_note: async () => {
        if (action.type !== 'delete_note') return;
        const exists = canvasStoreVanilla.getState().notes.some((n) => n.id === action.noteId);
        if (!exists) {
          toast(t('canvas.manager.noteNotFound', { id: action.noteId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().removeNote(action.noteId);
        toast(t('canvas.manager.noteDeleted'), 'success');
      },
      delete_router: async () => {
        if (action.type !== 'delete_router') return;
        const exists = canvasStoreVanilla.getState().routers.some((r) => r.id === action.routerId);
        if (!exists) {
          toast(t('canvas.manager.routerNotFound', { id: action.routerId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().removeRouter(action.routerId);
        toast(t('canvas.manager.routerDeleted'), 'success');
      },
      delete_join: async () => {
        if (action.type !== 'delete_join') return;
        const exists = canvasStoreVanilla.getState().joins.some((j) => j.id === action.joinId);
        if (!exists) {
          toast(t('canvas.manager.joinNotFound', { id: action.joinId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().removeJoin(action.joinId);
        toast(t('canvas.manager.joinDeleted'), 'success');
      },
      delete_frame: async () => {
        if (action.type !== 'delete_frame') return;
        const exists = canvasStoreVanilla.getState().frames.some((f) => f.id === action.frameId);
        if (!exists) {
          toast(t('canvas.manager.frameNotFound', { id: action.frameId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().removeFrame(action.frameId);
        toast(t('canvas.manager.frameDeleted'), 'success');
      },
      close_surface: async () => {
        if (action.type !== 'close_surface') return;
        const exists = canvasStoreVanilla.getState().surfaces.some((s) => s.id === action.surfaceId);
        if (!exists) {
          toast(t('canvas.manager.surfaceNotFound', { id: action.surfaceId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().removeSurface(action.surfaceId);
        toast(t('canvas.manager.surfaceClosed'), 'success');
      },
      open_project: async () => {
        if (action.type !== 'open_project') return;
        // Real gap fix (LazyManager QA, 2026-08-01): the manager used to
        // have NO way to open/register a project by path — a user naming a
        // folder that was not currently open hit a dead end (a doomed
        // mission launched against the wrong cwd/brain, then "go do it
        // yourself in the cockpit"). Reuses AppContext.registerProject
        // VERBATIM — the exact same register-then-activate primitive the
        // welcome screen's folder picker calls — never a second,
        // divergent implementation. That primitive's own Rust command
        // (project_register) validates the path exists and is a directory
        // BEFORE registering anything, and is idempotent (re-registering an
        // already-open root just re-activates it, never a duplicate).
        //
        // Return-value fix (create_project chantier): this case used to
        // return void on every path, which means the manager itself never
        // learned WHY a registration failed — only the human-facing toast
        // carried the real reason, and the manager's next turn could only
        // infer a vague "is not open" symptom from a LATER action. Every
        // branch below now also returns a ManagerActionRealResult so the
        // real outcome (including the underlying Rust error verbatim on
        // failure) reaches the manager through the same `realResults` /
        // `agents.manager.realResult` channel execute_plan's own cases use.
        if (!appContext) {
          const msg = 'open_project: no AppContext available — project management is not reachable here.';
          toast(t('canvas.manager.openProjectUnavailable'), 'error');
          return { failed: true, message: msg };
        }
        const path = action.path?.trim();
        if (!path) {
          const msg = 'open_project: empty path — nothing to register.';
          toast(t('canvas.manager.openProjectFailed', { path: action.path ?? '', reason: 'empty path' }), 'error');
          return { failed: true, message: msg };
        }
        try {
          await appContext.registerProject(path);
          toast(t('canvas.manager.projectOpened', { path }), 'success');
          return { message: `open_project: "${path}" registered and activated.` };
        } catch (err) {
          // Never a fabricated success: the real reason (e.g. Rust's own
          // "'<path>' is not a directory") is surfaced verbatim, same
          // honesty convention as close_project's own catch below — to
          // BOTH the human-facing toast and the manager itself (see the
          // return-value fix note above).
          const reason = errorMessage(err);
          toast(t('canvas.manager.openProjectFailed', { path, reason }), 'error');
          return { failed: true, message: `open_project: could not open "${path}": ${reason}` };
        }
            },
      create_project: async () => {
        if (action.type !== 'create_project') return;
        // Capability-parity fix: `open_project`/`project_register` only
        // ever registers a directory that ALREADY EXISTS (see that case's
        // own doc comment) — there is no `mkdir` reachable anywhere in the
        // manager's action surface, so a user asking for work in a BRAND
        // NEW folder used to be a genuine dead end, correctly refused and
        // punted to the human. `project_create` (Rust) closes that gap:
        // creates exactly ONE new directory level (the parent must already
        // exist) and then delegates into the exact same registration body
        // `project_register` uses, so the two commands can never drift into
        // two different ideas of what "registered" means. Once registered,
        // the EXISTING path-confinement guard (`ensure_write_path_in_project_roots`,
        // fs.rs) already allows writes into it — nothing about that guard is
        // touched or weakened here.
        //
        // Same honesty contract as open_project right above: every branch
        // returns a ManagerActionRealResult carrying the real outcome
        // (including the underlying Rust error verbatim on failure) so the
        // manager learns what actually happened, never just the toast.
        if (!isTauri()) {
          const msg = 'create_project: not running under Tauri — project creation is not available here.';
          toast(t('canvas.manager.createProjectUnavailable'), 'error');
          return { failed: true, message: msg };
        }
        const path = action.path?.trim();
        if (!path) {
          const msg = 'create_project: empty path — nothing to create.';
          toast(t('canvas.manager.createProjectFailed', { path: action.path ?? '', reason: 'empty path' }), 'error');
          return { failed: true, message: msg };
        }
        try {
          const entry = await createProject(path);
          toast(t('canvas.manager.projectCreated', { path }), 'success');
          // gitInitNote (Rust's ensure_new_project_git_repo) reports whether
          // this new directory actually became a usable git repo — surfaced
          // to the manager unconditionally (not just on failure) so it never
          // assumes a mission can launch here when git init silently didn't
          // happen (e.g. git unavailable, or the parent was already its own
          // repo). See createProject's doc comment (platform/tauri.ts).
          const gitNote = entry.gitInitNote ? ` ${entry.gitInitNote}` : '';
          return { message: `create_project: "${path}" created and registered (root: ${entry.root}).${gitNote}` };
        } catch (err) {
          // Never a fabricated success: the real reason (e.g. Rust's own
          // "parent directory '<parent>' does not exist" or "already exists
          // and is not a directory") is surfaced verbatim, same honesty
          // convention as open_project's own catch above.
          const reason = errorMessage(err);
          toast(t('canvas.manager.createProjectFailed', { path, reason }), 'error');
          return { failed: true, message: `create_project: could not create "${path}": ${reason}` };
        }
            },
      close_project: async () => {
        if (action.type !== 'close_project') return;
        if (!appContext) {
          toast(t('canvas.manager.closeProjectUnavailable'), 'error');
          return;
        }
        const resolution = await resolveDraftProjectId(action.projectId);
        if (!resolution.projectId) {
          toast(t('canvas.manager.closeProjectNotFound', { project: action.projectId ?? '' }), 'error');
          return;
        }
        const journalProjectId = resolution.projectId;
        const { openProjects, switchProject, closeProject } = appContext;
        // Bridge between two DISTINCT id spaces: resolveDraftProjectId (like
        // every other project-targeting action) resolves to the JOURNAL
        // project id (projectIdFromRoot(root) — what the canvas/manager/
        // journal system knows a project by), but AppContext's own registry
        // (openProjects/switchProject/closeProject) keys everything by a
        // SEPARATE opaque id Rust's project_register mints — the two only
        // ever relate via each entry's real `root`. Never assume they
        // coincide (they do not, even for the SAME project).
        const target = openProjects.find((p) => projectIdFromRoot(p.root) === journalProjectId);
        if (!target) {
          toast(t('canvas.manager.closeProjectNotFound', { project: journalProjectId }), 'error');
          return;
        }
        try {
          // closeProject rejects when `id` is the ACTIVE project while
          // another remains open (AppContext.tsx's own doc comment) — switch
          // away first, same ordering the fleet-hygiene sweep's test-scratch
          // closure already establishes (runFleetHygieneSweep above).
          if (target.active) {
            const other = openProjects.find((p) => p.id !== target.id);
            if (other) await switchProject(other.id);
          }
          await closeProject(target.id);
          toast(t('canvas.manager.projectClosed', { project: journalProjectId }), 'success');
        } catch (err) {
          toast(t('canvas.manager.closeProjectFailed', { project: journalProjectId, reason: errorMessage(err) }), 'error');
        }
      },
      pin_chain: async () => {
        if (action.type !== 'pin_chain') return;
        const chain = canvasStoreVanilla.getState().chains.find((c) => c.id === action.chainId);
        if (!chain) {
          toast(t('canvas.manager.chainNotFound', { id: action.chainId }), 'error');
          return;
        }
        const sourceParsed = parseRef(chain.sourceRef);
        const sourceMission = sourceParsed ? state.missions.find((m) => m.id === sourceParsed.id) : undefined;
        if (!sourceMission || sourceMission.status !== 'done') {
          toast(t('canvas.manager.chainNotPinnable', { id: action.chainId }), 'error');
          return;
        }
        // Shared pin tail (store write + chain.pinned journal audit) — the
        // SAME choke point the canvas UI's own pin entries call.
        await pinChainWithAudit(action.chainId, sourceMission);
        toast(t('canvas.manager.chainPinned'), 'success');
      },
      unpin_chain: async () => {
        if (action.type !== 'unpin_chain') return;
        const chainExists = canvasStoreVanilla.getState().chains.some((c) => c.id === action.chainId);
        if (!chainExists) {
          toast(t('canvas.manager.chainNotFound', { id: action.chainId }), 'error');
          return;
        }
        canvasStoreVanilla.getState().unpinChainOutput(action.chainId);
        toast(t('canvas.manager.chainUnpinned'), 'success');
      },
      refire_chain: async () => {
        if (action.type !== 'refire_chain') return;
        const outcome = await refireChainDownstream(action.chainId);
        if (outcome === 'refired') {
          toast(t('canvas.manager.chainRefired'), 'success');
        } else {
          toast(t('canvas.manager.chainRefireFailed', { reason: outcome }), 'error');
        }
      },
      approve_mission: async () => {
        if (action.type !== 'approve_mission') return;
        try {
          const mission = state.missions.find((m) => m.id === action.missionId);
          if (!mission) {
            throw new ApproveBlockedError(t('agents.manager.missionNotFound', { id: action.missionId }));
          }
          // Bug audit wave: approveMission itself now throws the SAME
          // ApproveBlockedError (same message) for "not in review"/"no
          // worktree" — it used to silently no-op instead, which is why
          // this case used to duplicate that check here just to avoid a
          // false success toast. No longer needed: any blocked/failed
          // approval now surfaces through the single catch below.
          //
          // Correctness fix: resolve THIS MISSION's OWN project root, never
          // the currently ACTIVE one (see resolveMissionRepoPath's doc
          // comment) — a mission found above belongs to whatever project
          // agentsStore is tracking it under, which can silently differ
          // from whatever project is active NOW (e.g. a background/
          // self-improvement mission while the user works in another
          // project). The old `resolveProjectRoot()` call here either found
          // the mission but merged into the WRONG repo, or masked that
          // mismatch entirely when the two happened to coincide.
          const repoPath = await resolveMissionRepoPath(mission.id);
          await approveMission(mission.id, repoPath, { force: action.force });
          toast(t('canvas.manager.missionApproved'), 'success');
        } catch (err) {
          toast(err instanceof ApproveBlockedError ? err.reason : `${t('common.error')}: ${String(err)}`, 'error');
          // Rethrown (bug audit wave — this case used to only toast) so the
          // outer per-action loop (sendManagerMessage's `for (const action
          // of actionsToExecute)`) also records this as a failed action: a
          // persistent, visible manager-chat message, not just a toast that
          // can be missed/dismissed.
          throw err;
        }
      },
      reject_mission: async () => {
        if (action.type !== 'reject_mission') return;
        const mission = state.missions.find((m) => m.id === action.missionId);
        if (!mission) {
          toast(t('agents.manager.missionNotFound', { id: action.missionId }), 'error');
          return;
        }
        const feedback = action.feedback?.trim();
        if (!feedback) {
          // REJECTION-SPAWNS-A-CLONE fix (2026-08-05, founder repro: M50 ->
          // M51): a bare rejection with nothing constructive to act on used
          // to unconditionally fold into retryMission below regardless —
          // with no feedback to append, that produced a byte-IDENTICAL
          // clone of the exact mission just rejected (an unwanted relaunch
          // of an already-effectively-done "merge branch" mission).
          // Rejection must mean ABANDON of that lineage, never an
          // automatic retry: with no feedback there is nothing to correct,
          // so this now resolves through the SAME terminal primitive the
          // plain "Rejeter" button already uses (discardMission — worktree
          // discarded, status 'cancelled', a real mission.rejected journal
          // event) instead of spawning a clone. `status: 'cancelled'` also
          // structurally keeps this mission out of the boot-resilience
          // auto-retry effect's own eligibility filter further below
          // (which only ever matches `status === 'failed'`) — a rejected
          // lineage can never come back on its own, only a genuine
          // restart-interrupted one can. Rejection WITH real feedback (the
          // tested C1 path just below, managerGroundedActions.test.tsx) is
          // unchanged: it still means "try again, here is what to fix" — a
          // deliberate corrective action, never a blind repeat.
          const repoPath = await resolveMissionRepoPath(mission.id);
          await discardMission(mission.id, repoPath);
          toast(t('canvas.manager.missionRejected'), 'success');
          return;
        }
        // Honesty fix (C1) — retryMission is now async and can throw; await
        // it so a genuine failure (e.g. the mission vanishing between the
        // check above and this call) reaches the caller's try/catch instead
        // of floating as an unobserved rejection while this case still
        // reports "Mission rejetée".
        await retryMission(mission.id, { feedback });
        toast(t('canvas.manager.missionRejected'), 'success');
      },
      create_router: async () => {
        if (action.type !== 'create_router') return;
        const routerId = generateCanvasId('router');
        const projectResolution = await resolveDraftProjectId(action.projectId);
        const branches: RouterBranch[] = action.branches.map((b, i) => ({
          id: generateCanvasId('branch'),
          label: b.label || t('canvas.router.branchLabel', { n: String(i + 1) }),
          condition: b.condition,
        }));
        const router: RouterSpec = { id: routerId, projectId: projectResolution.projectId, branches };
        canvasStoreVanilla.getState().addRouter(router);
        if (action.alias) aliasMap.set(action.alias, makeRef('router', routerId));
        emit('canvas:highlight', { refs: [makeRef('router', routerId)] });
        toast(t('canvas.manager.routerCreated'), 'success');
      },
      save_macro: async () => {
        if (action.type !== 'save_macro') return;
        const canvasState = canvasStoreVanilla.getState();
        const macro = captureMacro(canvasState, action.refs.map(String), action.name, action.description);
        if (macro.drafts.length === 0 && macro.routers.length === 0 && macro.notes.length === 0) {
          // Honest degrade: none of the given refs resolved to a real
          // draft/router/note — never save an empty, useless macro.
          toast(t('canvas.manager.macroSaveEmpty'), 'error');
          return;
        }
        canvasState.addMacro(macro);
        toast(t('canvas.manager.macroSaved', { name: macro.name }), 'success');
      },
      instantiate_macro: async () => {
        if (action.type !== 'instantiate_macro') return;
        const canvasState = canvasStoreVanilla.getState();
        const needle = action.name.trim().toLowerCase();
        const macro = canvasState.macros.find((m) => m.name.trim().toLowerCase() === needle);
        if (!macro) {
          toast(t('canvas.manager.macroNotFound', { name: action.name }), 'error');
          return;
        }
        const projectResolution = await resolveDraftProjectId(action.projectId);
        const occupied = storeOccupancyRects(canvasState, projectResolution.projectId);
        // No live reconciled node list exists outside a component — {x:200,
        // y:200} is a safe, honest anchor (the canvas is unbounded, see
        // placementCollision.ts's own header: no real fixture ever exhausts
        // findFreePosition's scan from here), same convention every other
        // manager-authored creation (create_draft/create_router) already
        // accepts (no explicit position — reconciler/instantiateMacro's own
        // collision-safe placement resolves the real spot).
        const result = instantiateMacro(macro, { x: 200, y: 200 }, projectResolution.projectId, occupied);
        canvasState.instantiateMacroResult(result);
        emit('canvas:highlight', { refs: [...result.drafts.map((d) => makeRef('draft', d.id)), ...result.routers.map((r) => makeRef('router', r.id))] });
        if (projectResolution.unresolvedName) {
          toast(t('canvas.manager.macroProjectNotFound', { name: macro.name, project: projectResolution.unresolvedName }), 'error');
        } else {
          toast(t('canvas.manager.macroInstantiated', { name: macro.name }), 'success');
        }
      },
      open_report: async () => {
        if (action.type !== 'open_report') return;
        // Same resolve-by-name/active choke point as create_draft — see
        // canvasDigest.ts's `resolveDraftProjectId` doc comment.
        const projectResolution = await resolveDraftProjectId(action.projectId);
        if (projectResolution.unresolvedName) {
          toast(t('canvas.manager.reportProjectNotFound', { project: projectResolution.unresolvedName }), 'error');
        }
        // `report:open`'s own contract (lib/bus.ts): `projectId` omitted
        // opens the currently active project — the same honest fallback an
        // unresolved name lands on here (never a silently wrong project).
        emit('report:open', { projectId: projectResolution.projectId });
      },
      generate_plan: async () => {
        if (action.type !== 'generate_plan') return;
        // Target-project fix (2026-08-02 escalation — real founder repro:
        // three unrelated plans, proposed while `lazy-backoffice` happened
        // to be the ACTIVE project, all silently materialized INSIDE that
        // project's zone — 33 nodes from 3 different plans stacked in one
        // zone, read as "the graph got duplicated"). `action.projectId` has
        // existed on this action's type since chantier 3 (types.ts) but was
        // NEVER read here — this case always used resolveProjectRoot() (the
        // ACTIVE project) as an implicit default regardless of what the plan
        // actually targets. Same resolve-by-name-or-id choke point
        // create_draft/clear_canvas/open_report already use
        // (resolveDraftProjectId) — an unresolved name is a real, honest
        // failure (never a silent guess into the wrong zone; the manager's
        // own prompt, managerEngine.ts, now tells it to open_project FIRST
        // when the named target is not open yet).
        const targetResolution = await resolveDraftProjectId(action.projectId);
        if (targetResolution.unresolvedName) {
          const msg = `Project "${targetResolution.unresolvedName}" is not open — cannot target a plan at it. Use open_project first, then retry.`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        // Routing parity fix (2026-08-04) — see resolveMentionedProjectRoot's
        // own doc comment: this case used to always fall back to the ACTIVE
        // project the instant action.projectId was blank, even when the
        // objective/steps named a DIFFERENT open project by absolute path or
        // by name — the exact launch_mission M9/M10 defect, never ported
        // here until now (real incident, this case's own comment above:
        // three unrelated plans proposed while `lazy-backoffice` happened to
        // be active all silently materialized inside ITS zone). Only
        // consulted when targetResolution.projectId is blank, same guard
        // launch_mission's own routing uses.
        let mentionedProjectRoot: { id: string; root: string } | undefined;
        if (!targetResolution.projectId) {
          const scanText = `${action.objective} ${(action.steps ?? []).map((s) => s.description).join(' ')}`;
          mentionedProjectRoot = await resolveMentionedProjectRoot(scanText);
          if (mentionedProjectRoot) {
            console.warn(`[generate_plan] routed by mention -> project ${mentionedProjectRoot.id} (${mentionedProjectRoot.root})`);
          }
        }
        const activeProjectRoot = await resolveProjectRoot().catch(() => '.');
        // `targetResolution.projectId` is undefined ONLY when action.projectId
        // was blank (resolveDraftProjectId's own "absent -> active project"
        // contract) — resolveProjectRootById needs a REAL known id, so that
        // case skips straight to the mention-routed root (when found above)
        // or the active root otherwise, instead of a lookup that could only
        // ever fail.
        const projectRoot = targetResolution.projectId
          ? (await resolveProjectRootById(targetResolution.projectId)) ?? activeProjectRoot
          : (mentionedProjectRoot?.root ?? activeProjectRoot);
        const id = targetResolution.projectId ?? projectIdFromRoot(projectRoot);
        // P0 crash, round 3 (P2) / dangling-edge card fix — `action.steps`
        // arrives HERE already repaired (dedupe/uniquify any step id that
        // collides with a draft/join already live on the canvas, or with
        // another step in this SAME plan, and drop/rewrite any dependsOn
        // edge left dangling by that rename — see graph/planStepRepair.ts's
        // own header). The repair itself now runs exactly ONCE, in
        // sendManagerMessage BEFORE this executor is ever reached (see the
        // `actionsToExecute` construction there) — the proposal card and
        // this executor used to run two INDEPENDENT repair passes that
        // could disagree on a rename, which is what fed layout.ts's elkjs
        // call a dangling edge. canvasStore's `addProposalPreview`/
        // `hydrate` keep an independent backstop for whatever this can't
        // see (see canvasRefIntegrity.ts) — this layer exists to keep the
        // common case from ever reaching that backstop at all.
        const orch = await createOrchestrator({
          projectRoot,
          projectId: id,
          name: action.objective.slice(0, 80),
          objective: action.objective,
          steps: action.steps ?? [],
          // Gate-usability fix: was hardcoded 'supervised' — see the same
          // fix on launch_best_of_n above for why that silently overrode
          // the user's real autonomy selection.
          autonomyLevel: state.autonomyLevel,
          citedLessonIds: action.citedLessonIds,
        });
        // Register the new orchestrator in the global runtime so the fleet
        // context reflects it immediately — under its REAL target project,
        // never wherever happened to be active.
        registerRuntimeProject(id, projectRoot, id);
        // BUG 2 fix (founder verbatim, dogfood 2026-08-05): the manager's
        // "Résultat réel" chat digest used to leak the internal orchestrator
        // id straight into the transcript (e.g. "Plan orch-
        // 1785941982392-mrt2zs7 created") — meaningless and ugly to a
        // human. Humanized to the plan's own title + step count; the real
        // id (`orch.id`) stays available via the `planId` field for
        // anything downstream that actually needs the handle (e.g.
        // execute_plan), it is just never shown to the user.
        const stepCount = orch.steps.length;
        const planSummary = `Plan proposé : « ${orch.name} » — ${stepCount} étape${stepCount === 1 ? '' : 's'}`;
        toast(planSummary, 'success');
        return { message: planSummary, planId: orch.id };
            },
      execute_plan: async () => {
        if (action.type !== 'execute_plan') return;
        // resolveOrchestratorRoot (not resolveProjectRoot alone) — the plan
        // may target a DIFFERENT project than whatever is active right now
        // (generate_plan's own target-project fix above); every mission this
        // executes below must launch against the orchestrator's REAL root,
        // never the active one, see that helper's own doc comment.
        const projectRoot = await resolveOrchestratorRoot(action.planId);
        const orch = await getOrchestrator(projectRoot, action.planId);
        if (!orch) {
          const msg = `Plan ${action.planId} not found`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        // Intentionally the PLAN's own autonomyLevel, not the global
        // state.autonomyLevel — a plan carries whatever mode was live when
        // it was created (generate_plan/launch_best_of_n now stamp the real
        // state.autonomyLevel at creation time, see those cases above), so
        // this stays correct even if the user changed the global selector
        // since the plan was made.
        const gate = await evaluateActionGate('execute_plan', getEffectiveAutonomy({ mode: orch.autonomyLevel }));
        if (gate.decision === 'deny') {
          const msg = `Plan execution denied: ${gate.reason}`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        // 2026-08-04 (UC3 dogfood — same "drafts en double" fix as
        // executePlan's own UI path): a plan the manager executes directly
        // (supervised approval, or a resume) is validated too — late previews
        // for it no-op, leftover previews of other plans are swept.
        markPlanValidated(action.planId);
        canvasStoreVanilla.getState().clearProposedExcept(action.planId);
        // Track lesson citations for eval-gate retention
        if (orch.citedLessonIds) {
          for (const lessonId of orch.citedLessonIds) {
            citeLesson(lessonId);
          }
        }
        // Partial execution: `stepIds` (checkbox partial-accept, chantier 3 —
        // GraphProposalCard, potentially several mutually-independent ids)
        // wins over `fromStep` (single resume-point). Both close over
        // transitive deps via closeStepDependencies — the SAME helper the
        // materialization step in executePlan below uses for its own
        // `opts.stepIds`, so the executed subset can never diverge from
        // what was actually materialized as "accepted" on the canvas (see
        // that helper's own doc comment for the bug this fixes).
        const seedIds = action.stepIds && action.stepIds.length > 0
          ? action.stepIds
          : action.fromStep ? [action.fromStep] : null;
        const orchToRun = seedIds
          ? { ...orch, steps: closeStepDependencies(orch.steps, seedIds) }
          : orch;

        // EXECUTE_PLAN REPLAY fix (2026-08-05) — honesty half of the fix
        // (the execution-skip mechanics live in seedRunFromSteps,
        // sgrOrchestratorRunner.ts): a BARE re-run (no explicit
        // stepIds/fromStep) never silently pretends every step is fresh.
        // A fully-settled plan says so and stops here — nothing left to
        // launch, so nothing gets launched, not even a zero-step SGR run.
        // A partially-settled plan logs exactly which steps it is skipping
        // before continuing, same "never silent" rule as every other
        // honesty fix in this file.
        if (seedIds === null) {
          const settledSteps = orch.steps.filter((s) => s.status === 'done' || s.status === 'skipped');
          if (settledSteps.length > 0) {
            const remainingCount = orch.steps.length - settledSteps.length;
            if (remainingCount === 0) {
              const msg = `Plan ${action.planId} already fully executed (${settledSteps.length} step(s) done) — nothing to run.`;
              toast(msg, 'info');
              return { message: msg, planId: action.planId };
            }
            toast(
              `Resuming plan ${action.planId}: ${settledSteps.length} step(s) already done, skipping (${settledSteps.map((s) => s.id).join(', ')}) — running ${remainingCount} remaining.`,
              'info',
            );
          }
        }
        try {
          // 2026-08-04 (UC3 — duplicate-mission fix): from the moment this
          // run owns the plan's steps, the reactive canvas chain runner must
          // NOT also launch them (fireChain skips sgrManagedDraftRefs) — the
          // SGR's own launchMission is the only launcher, otherwise every
          // step fires twice, the duplicate landing on the ACTIVE project
          // with a stale model. Cleared when the run settles below.
          setSgrManagedDrafts(orchToRun.steps.map((s) => makeRef('draft', s.id)));
          // Default path: Single Graph Runtime (waves + brain + data plane).
          const result = await startOrchestratorViaSgr(orchToRun, {
            projectRoot,
            launchMission: async (task, opts) => {
              // modelId catalog wave (plan-first leg, closed): SgrLaunchOpts
              // now carries `modelId` end-to-end from a generate_plan step's
              // exact catalog id (persisted on OrchestratorPlanStep, see its
              // own doc comment in types.ts) through
              // orchestratorState.ts's createOrchestrator,
              // graph/compileOrchestrator.ts's StepContract, and
              // graph/sgrOrchestratorRunner.ts's launchOptsFromNode — see
              // StepContract.modelId's doc comment for the full thread.
              // Passed ahead of the tier hint (opts?.model), same priority
              // resolveManagerModelId already gives launch_mission/
              // launch_best_of_n/create_loop's own `modelId` field.
              // Mission P fix: opts?.engine (SgrLaunchOpts.engine, the plan
              // step's own "cli"/"pro"/"auto" rail choice, threaded here from
              // launchOptsFromNode/StepContract.engine) used to be dropped —
              // this callback always passed `undefined` for engineOverride,
              // so a step's deliberate rail choice was silently discarded the
              // moment it ran through a plan (same class of gap as the
              // modelId thread above; launch_mission's own case already
              // forwards action.engine the same way, see that case's
              // comment). 'auto' narrows to undefined — resolveManagerModelId's
              // engineOverride only accepts ManagerEngineChoice ('cli'|'pro'),
              // 'auto' means "no deliberate override", same as absent.
              const engineOverride = opts?.engine === 'cli' || opts?.engine === 'pro' ? opts.engine : undefined;
              const modelLabel = resolveManagerModelId(opts?.model ?? 'sonnet', getProviderMode(), engineOverride, opts?.modelId);
              const permissionMode = (opts?.permissionMode ?? 'acceptEdits') as PermissionMode;
              // Cross-project READ access, plan-first leg (closes the gap a
              // generate_plan/execute_plan step had NO way to declare —
              // launch_mission's own case already resolves the same way).
              // opts.extraReadableProjectIds (SgrLaunchOpts, still unresolved
              // ids/names — see its own doc comment, sgrOrchestratorRunner.ts)
              // is resolved HERE, the one place this callback already talks
              // to the project directory for a mission's own target
              // (resolveDraftProjectId/resolveProjectRootById above). An id
              // that does not resolve to a currently OPEN project is dropped
              // with a warning, never silently substituted for "every open
              // project" — same contract as launch_mission's executor.
              // Rust (agent_run, run.rs) independently re-validates every
              // resolved root against the live ProjectRegistry before wiring
              // anything, so a stale value here can never widen a mission's
              // reach past what is genuinely open now.
              const extraReadableRoots: string[] = [];
              for (const declared of opts?.extraReadableProjectIds ?? []) {
                const declaredResolution = await resolveDraftProjectId(declared);
                const resolvedRoot = declaredResolution.projectId
                  ? await resolveProjectRootById(declaredResolution.projectId)
                  : undefined;
                if (resolvedRoot) {
                  if (!extraReadableRoots.includes(resolvedRoot)) extraReadableRoots.push(resolvedRoot);
                } else {
                  console.warn(`[sgrOrchestratorRunner] extraReadableProjectIds: "${declared}" did not resolve to a currently open project — skipped`);
                }
              }
              return addMission({
                title: (opts?.title ?? task).slice(0, 80),
                agentTask: task,
                agentName: opts?.agentName,
                repo: projectRoot,
                worktree: '',
                // Cross-project READ access — see the resolution loop above
                // this addMission call. Absent when nothing resolved, never
                // an empty array (matches NewMissionInput.extraReadableRoots'
                // own "absent/empty = unchanged behavior" contract).
                extraReadableRoots: extraReadableRoots.length > 0 ? extraReadableRoots : undefined,
                // Base-branch thread (real incident fix, lazy-backoffice
                // M1/M2): a generate_plan step naming a branch to continue
                // work from (StepContract.baseBranch, see
                // OrchestratorPlanStepInput.baseBranch's doc comment,
                // ../../lib/agents/types.ts) lands here as opts.baseBranch
                // (SgrLaunchOpts, sgrOrchestratorRunner.ts) and is forwarded
                // onto the created Mission unchanged — runtime.ts's
                // runMission reads it as the worktree's start point.
                baseBranch: opts?.baseBranch,
                // Fan-in leg of the same thread (see Mission.mergeBranches's
                // doc comment, ../../lib/agents/types.ts) — set by
                // runGraph.ts's resolveInheritedBranches when this step has
                // more than one dependsOn upstream branch to build on.
                mergeBranches: opts?.mergeBranches,
                modelLabel,
                mode: 'agent',
                orchestrator: true,
                permissionMode,
                contract: {
                  objective: task.slice(0, 500),
                  model: modelLabel,
                  permissionMode,
                  budgetCapUsd: opts?.budgetCapUsd ?? 5,
                  maxDurationMs: opts?.maxDurationMs,
                  proofs: [],
                  // Root-cause fix (2026-08-02 zone audit — the "review
                  // missions never resolve despite 'Merge : auto si vert'"
                  // defect): humanApprove: true here silently opted EVERY
                  // orchestrated plan-step mission out of auto-merge —
                  // approveGate.ts's evaluateAutoMerge treats it as an
                  // explicit per-mission opt-out that always wins over the
                  // project's own approval mode. See NewMissionModal.tsx's
                  // identical fix for the fuller rationale; this is the plan
                  // graph's own launch site (sgrOrchestratorRunner.ts calls
                  // this closure per step), the most common source of a
                  // zone's missions.
                  gates: { evaluators: true, humanApprove: false },
                  shareToTeam: false,
                },
                originConversationId: conversationId,
              });
            },
            onRunUpdate: (run, snapshot) => {
              // Chantier 3 (plan-first canvas) — identity continuity's final
              // leg: the moment a step's node run acquires a real mission id,
              // remap THAT SAME canvas draft (already accepted/active, no
              // longer proposed — see canvasStore's acceptProposedSteps)
              // straight into the mission, atomically (position preserved,
              // chains rewritten) — the exact same primitive draftLaunch.ts's
              // own manual "Lancer" button already uses (canvasStore's
              // remapDraftToMission). Without this bridge, the accepted
              // draft would sit there forever while an UNRELATED mission
              // node appears elsewhere — the very "un autre jeu de noeuds
              // apparait a cote" bug this chantier exists to fix.
              // Idempotent: remapDraftToMission no-ops once the draft is
              // already gone (a later tick for an already-remapped step, or
              // a step whose draft was never materialized on this canvas).
              const canvasState = canvasStoreVanilla.getState();
              for (const [nodeId, nodeRun] of Object.entries(run.nodeRuns)) {
                if (nodeRun.missionIds.length === 0) continue;
                const latestMissionId = nodeRun.missionIds[nodeRun.missionIds.length - 1];
                canvasState.remapDraftToMission(nodeId, latestMissionId);
              }
              setState((prev) => ({
                ...prev,
                activeGraphRun: run,
                activeGraphSnapshot: snapshot,
                orchestrators: prev.orchestrators.map((o) =>
                  o.id === action.planId
                    ? {
                        ...o,
                        status:
                          run.status === 'running'
                            ? 'executing'
                            : run.status === 'done'
                              ? 'done'
                              : run.status === 'interrupted'
                                ? 'blocked'
                                : run.status === 'failed' || run.status === 'cancelled'
                                  ? 'blocked'
                                  : o.status,
                        budget: {
                          ...o.budget,
                          spentCents: Math.max(o.budget.spentCents, Math.round(run.budget.spentUsd * 100)),
                        },
                      }
                    : o,
                ),
              }));
            },
            onEvent: (type, payload) => {
              if (type === 'graph.run_started') {
                // 2026-08-04 (UC3 dogfood — "le canvas montre pas
                // automatiquement ce qu'il faut"): when a graph run actually
                // STARTS (missions launching), bring the camera back to the
                // run's project zone — a plan launched from the manager's
                // own turn (not the UI validate button) never got its focus
                // otherwise, and the user watching the canvas mid-run needs
                // the zone in view, not the last thing they panned to.
                emit('canvas:focus', { ref: makeRef('project', projectIdFromRoot(projectRoot)) });
              }
              if (type === 'graph.run_finished' || type === 'graph.run_failed') {
                // 2026-08-04 (UC3 — duplicate-mission fix): the run settled,
                // the plan's drafts are no longer SGR-owned — a later manual
                // chain-fire (or a fresh run of another plan) starts clean.
                clearSgrManagedDrafts();
                void getOrchestrator(projectRoot, action.planId).then((fresh) => {
                  if (!fresh) return;
                  setState((prev) => ({
                    ...prev,
                    orchestrators: prev.orchestrators.some((o) => o.id === fresh.id)
                      ? prev.orchestrators.map((o) => (o.id === fresh.id ? fresh : o))
                      : [...prev.orchestrators, fresh],
                  }));
                });
              }
              void payload;
            },
          });
          setState((prev) => ({
            ...prev,
            activeGraphRun: result.run,
            activeGraphSnapshot: result.snapshot,
            orchestrators: prev.orchestrators.some((o) => o.id === result.orchestrator.id)
              ? prev.orchestrators.map((o) =>
                  o.id === result.orchestrator.id ? result.orchestrator : o,
                )
              : [...prev.orchestrators, result.orchestrator],
          }));
          const label =
            result.run.status === 'done'
              ? 'finished'
              : result.run.status === 'interrupted'
                ? 'paused (interrupt)'
                : result.run.status;
          // BUG 2 fix (same id-leak class as generate_plan's own fix above):
          // `orch.name` replaces the raw `action.planId` (an ugly internal
          // "orch-<timestamp>-<random>" id) in every user-facing string
          // below — the plan's real id is still returned via `planId` for
          // any caller that actually needs the handle.
          toast(`Plan "${orch.name}" ${label} · run ${result.run.runId.slice(0, 12)}`, result.run.status === 'done' ? 'success' : 'info');

          // B2 fix — "did this actually launch anything" can never be read
          // off `result.run.status` alone: 'running'/'interrupted' are both
          // perfectly normal mid-flight states for a plan that DID launch
          // real missions (the whole point of the async SGR runtime), while
          // a run can also reach 'failed' after genuinely launching and
          // running some of its steps. The one honest signal is whether ANY
          // node run ever recorded a real missionId — the exact same check
          // agentsStore.tsx's executePlan uses (via this return value) to
          // decide whether the proposal card may honestly read 'accepted'.
          const launchedAny = Object.values(result.run.nodeRuns).some((nr) => nr.missionIds.length > 0);
          if (!launchedAny) {
            const reason = `Plan "${orch.name}" ${label} — no step ever launched a real mission.`;
            toast(reason, 'error', 8000);
            return { failed: true, message: reason, planId: action.planId };
          }
          return { message: `Plan "${orch.name}" ${label}`, planId: action.planId };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const reason = `Plan execution failed: ${msg.slice(0, 100)}`;
          toast(reason, 'error', 8000);
          return { failed: true, message: reason };
        }
            },
      revise_plan: async () => {
        if (action.type !== 'revise_plan') return;
        // resolveOrchestratorRoot — see execute_plan's own doc comment on
        // this helper (generate_plan may target a non-active project).
        const projectRoot = await resolveOrchestratorRoot(action.planId);
        const existing = await getOrchestrator(projectRoot, action.planId);
        if (!existing) {
          toast(`Plan ${action.planId} not found`, 'error');
          return;
        }
        const revisedSteps: import('../../lib/agents/types').OrchestratorPlanStep[] = (action.steps ?? []).map((s, idx) => {
          const baseLevel: import('../../lib/agents/types').OrchestratorPlanStep['autonomyLevel'] = s.autonomyLevel ?? 'supervised';
          const existingLevel = existing.autonomyLevel === 'custom' ? 'supervised' : existing.autonomyLevel;
          return {
            id: s.id ?? `${action.planId}-step-${idx}`,
            description: s.description,
            status: 'pending' as const,
            missionIds: [] as string[],
            dependsOn: s.dependsOn ?? [],
            autonomyLevel: s.autonomyLevel ? baseLevel : existingLevel,
          };
        });
        await updateOrchestrator(projectRoot, action.planId, {
          objective: action.objective ?? existing.objective,
          steps: revisedSteps,
          status: 'planning',
        });
        toast(`Plan ${action.planId} revised`, 'success');
      },
      provision_service: async () => {
        if (action.type !== 'provision_service') return;
        try {
          await provisionService({
            service: action.service,
            projectId: action.projectId ?? 'active',
            config: action.config ?? {},
            costEstimateCents: action.costEstimateCents ?? 0,
          });
          toast(t('cockpit.manager.action.provision', { service: action.service }), 'success');
        } catch (err) {
          toast(`Provisioning failed: ${errorMessage(err)}`, 'error');
        }
      },
      teardown_service: async () => {
        if (action.type !== 'teardown_service') return;
        try {
          await teardownService(action.serviceId);
          toast(t('cockpit.manager.action.teardown', { id: action.serviceId }), 'success');
        } catch (err) {
          toast(`Teardown failed: ${errorMessage(err)}`, 'error');
        }
      },
      self_improve: async () => {
        if (action.type !== 'self_improve') return;
        try {
          const resolution = await resolveDraftProjectId(action.projectId);
          const projectId = resolution.projectId ?? 'active';
          await runImprovementLoop(projectId);
          toast(t('cockpit.manager.action.selfImprove'), 'success');
        } catch (err) {
          toast(`Self-improve failed: ${errorMessage(err)}`, 'error');
        }
      },
      create_agent_template: async () => {
        if (action.type !== 'create_agent_template') return;
        try {
          const mission = state.missions.find((m) => m.id === action.missionId);
          if (!mission) {
            toast(`Mission ${action.missionId} not found`, 'error');
            return;
          }
          const template = templateFromMission(mission);
          const name = action.name ?? template.name;
          recordTemplate({ ...template, name });
          noteAgentTemplate(name, template as unknown as Record<string, unknown>, mission);
          toast(t('cockpit.manager.action.createTemplate', { id: action.missionId }), 'success');
        } catch (err) {
          toast(`Template creation failed: ${errorMessage(err)}`, 'error');
        }
      },
      learn_pattern: async () => {
        if (action.type !== 'learn_pattern') return;
        try {
          capturePattern(
            action.trigger,
            action.action,
            { status: action.outcome === 'success' ? 'done' : action.outcome === 'partial' ? 'done' : 'failed', missionId: '', projectId: action.projectId } as unknown as MissionOutcome,
            action.projectId,
          );
          toast(t('cockpit.manager.action.learnPattern', { trigger: action.trigger.slice(0, 32) }), 'success');
        } catch (err) {
          toast(`Pattern capture failed: ${errorMessage(err)}`, 'error');
        }
      },
      propose_artifact: async () => {
        if (action.type !== 'propose_artifact') return;
        // Visible-artifact fix — UNLIKE propose_mission_charter's no-op
        // above, this action has a real, immediate canvas effect: the
        // founder must see the SAME visual in the chat card
        // (`artifactProposal`, attached to the assistant message BEFORE this
        // switch runs — see sendManagerMessage's proposal-gating block
        // below) AND on the canvas, per this task's own brief.
        const projectResolution = await resolveDraftProjectId(action.projectId);
        const surfaceKey = action.artifactId ? `artifact-${action.artifactId}` : generateCanvasId('artifact');
        const resolvedVariant = action.selectedVariantId
          ? action.variants.find((v) => v.id === action.selectedVariantId)
          : undefined;
        const htmlViews = buildArtifactSurfaceViews(resolvedVariant ? [resolvedVariant] : action.variants);
        const surfaceRef = canvasStoreVanilla.getState().upsertArtifactSurface(surfaceKey, htmlViews, {
          projectId: projectResolution.projectId,
        });
        emit('canvas:highlight', { refs: [surfaceRef] });

        // Cycle de vie (spec §4 gate 1, "figé une seule fois") — only once
        // the user has RESOLVED the proposal to one variant (selectedVariantId
        // present and actually matching one of the offered variants), freeze
        // it via the EXISTING generic loop-artifact primitive (never a
        // second/duplicated storage mechanism), keyed by this SAME
        // artifactId. A later create_loop naming this artifactId as its own
        // `templateArtifactRef` is what lets the recurring regime consume
        // this frozen gabarit every iteration without ever regenerating it.
        // Plain, non-localized toast copy — same established convention as
        // run_browser_recipe's case above (this task's file perimeter
        // excludes src/i18n/locales/*.ts).
        if (action.selectedVariantId) {
          if (!action.artifactId) {
            toast('Artifact resolved, but no artifactId was given — nothing to freeze for later reuse.', 'error');
          } else if (!resolvedVariant) {
            toast(`Artifact variant "${action.selectedVariantId}" not found among the proposed variants.`, 'error');
          } else {
            await freezeLoopTemplate(action.artifactId, ARTIFACT_TEMPLATE_KIND, resolvedVariant, action.name);
            toast(`"${action.name}" resolved and frozen as the reference template.`, 'success');
          }
        } else {
          toast(`"${action.name}" proposed — visible in this chat and on the canvas.`, 'success');
        }
      },
      run_browser_recipe: async () => {
        if (action.type !== 'run_browser_recipe') return;
        // Mission D (spec §5) — recipe is opaque DATA (validated structurally
        // by validateBrowserRecipe inside runBrowserRecipe itself); this case
        // only drives the run and reports the honest outcome. Defaults to
        // the safe validation mode (stop BEFORE the irreversible step) unless
        // the caller explicitly asked for a real publish. Plain, non-localized
        // toast copy — same established convention as this file's other
        // system-generated strings (e.g. formatLoopPromotedMessage above):
        // this task's file perimeter excludes src/i18n/locales/*.ts.
        const result = await runBrowserRecipe(action.recipe, { validateOnly: action.validateOnly ?? true });
        if (result.failure) {
          toast(`Browser recipe failed: ${result.failure.slice(0, 160)}`, 'error');
        } else if (result.circuitBreakerTripped) {
          toast(`Browser recipe stopped: unexpected screen detected (${result.circuitBreakerTripped.label}).`, 'error');
        } else if (result.stoppedBeforeFinal) {
          toast('Browser recipe ready — stopped right before the final (irreversible) step.', 'success');
        } else {
          toast('Browser recipe completed.', 'success');
        }
      },
      // ── LazyBots (A3) — create/manage LazyBots from the manager chat.
      // Same honest-outcome shape as create_project/open_project: success
      // returns a `{ message }` real result (journaled for the manager),
      // failure returns `{ failed: true, message }` — never a fabricated
      // success, never a bare throw.
      create_lazybot: async () => {
        if (action.type !== 'create_lazybot') return;
        // The manager MUST ask for a name — honest error, never invent one.
        const name = String(action.name ?? '').trim();
        if (!name) {
          const msg = 'create_lazybot: a non-empty "name" is required — ask the user for one first.';
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        const autonomy = action.autonomy;
        if (autonomy !== undefined && autonomy !== 'manual' && autonomy !== 'supervised' && autonomy !== 'yolo') {
          const msg = `create_lazybot: invalid autonomy "${String(autonomy)}" — use "manual", "supervised" or "yolo".`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        // Rich fields (profileIds / routines / avatar / budgetCapUsd) mirror
        // botsStore.createBot — never force profileIds: [] over a supplied list.
        const bot = buildBotConfigFromCreateLazybot({
          name,
          description: action.description,
          systemPrompt: action.systemPrompt,
          autonomy,
          capabilities: action.capabilities,
          profileIds: action.profileIds,
          routines: action.routines,
          avatar: action.avatar,
          budgetCapUsd: action.budgetCapUsd,
        });
        await saveBot(bot);
        const richBits: string[] = [];
        if (bot.profileIds.length) richBits.push(`${bot.profileIds.length} profile(s)`);
        if (bot.routines.length) richBits.push(`${bot.routines.length} routine(s)`);
        if (bot.avatar) richBits.push('avatar');
        if (bot.budgetCapUsd != null) richBits.push(`budget $${bot.budgetCapUsd}`);
        const richNote = richBits.length ? ` — ${richBits.join(', ')}` : '';
        toast(`LazyBot "${name}" created — ${bot.id}`, 'success');
        return { message: `create_lazybot: "${name}" created — id: ${bot.id}${richNote}` };
      },
      update_lazybot: async () => {
        if (action.type !== 'update_lazybot') return;
        // Name OR id (resolveLazyBotRef) — weaker models write the bot's
        // name where the schema says botId; the bot is unambiguous either way.
        const existing = resolveLazyBotRef(await listBots(), action.botId);
        if (!existing) {
          const msg = `update_lazybot: bot "${action.botId}" not found.`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        const patch = sanitizeLazyBotPatch((action.patch ?? {}) as Partial<BotConfig>);
        const updated: BotConfig = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
        await saveBot(updated);
        const keys = Object.keys(patch).filter((k) => k !== 'id').join(', ');
        toast(`LazyBot "${updated.name}" updated${keys ? ` (${keys})` : ''}`, 'success');
        return { message: `update_lazybot: "${updated.name}" (${existing.id}) updated${keys ? ` — fields: ${keys}` : ''}` };
      },
      run_lazybot: async () => {
        if (action.type !== 'run_lazybot') return;
        const bot = resolveLazyBotRef(await listBots(), action.botId);
        if (!bot) {
          const msg = `run_lazybot: bot "${action.botId}" not found.`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
        try {
          // The run is a REAL mission created through addMission (visible
          // card, journal, engine routing, stop/pause paths) — botEngine
          // only composes the bot persona/policy and tracks runtime state
          // keyed by the returned mission id. See launchBotRun's doc
          // comment for why the old headless loop was replaced.
          //
          // Model: a LazyBot must run whatever rail the user actually has
          // (BYOK key, CLI subscription, Lazy Pro credits, free tier) — see
          // resolveLazyBotRunModel. Preference order: the model the action
          // named, then the manager's own model for this conversation
          // (`_model`), then the app's active model; the first one whose
          // rail is READY wins, else a ready fallback rail. The old
          // `getActiveModel().id || 'claude-haiku-4-5'` sent a bot to the
          // native CLI rail whenever the active model was a Claude id —
          // a rail with no cloud_* tools at all (see planAndAct's LazyBot
          // branch, runtime.ts).
          const resolvedModel = resolveLazyBotRunModel(action.model, [_model, getActiveModel().id]);
          const run = await launchBotRun(bot, action.task, {
            model: resolvedModel.model,
            createMission: async (input) => addMission(toBotNewMissionInput(input, { originConversationId: conversationId })),
          });
          toast(`LazyBot "${bot.name}" run launched — ${run.missionId}`, 'success');
          const engineNote = resolvedModel.note ? ` (${resolvedModel.note})` : '';
          return {
            message: `run_lazybot: "${bot.name}" launched — runId: ${run.id}, missionId: ${run.missionId}, model: ${resolvedModel.model}${engineNote}`,
          };
        } catch (err) {
          const reason = errorMessage(err);
          // Auto-recovery: if the bot's launch is blocked by stale (zombie)
          // runs — engine bookkeeping whose mission is already terminal
          // (force-failed on a restart / HMR crash without finishBotRun) —
          // clear them and retry once. Conservative by design: a run is only
          // treated as stale when its mission is PRESENT in state.missions
          // with a terminal status. A genuinely live run (running/queued
          // mission, possibly of another open project) is never
          // touched — maxConcurrentSessions is a real cap, not a bug.
          if (reason.includes('concurrent run')) {
            const byId = new Map(stateRef.current.missions.map((m) => [m.id, m] as const));
            const staleRuns = listActiveRunsForBot(bot.id).filter((run) => {
              const mission = byId.get(run.missionId);
              // Terminal-and-known is the ONLY provably-dead case. A mission
              // absent from state.missions may still be live in a project
              // that is not the active one — leave those runs alone here
              // (stop_lazybot / the next boot sweep handle them).
              return mission !== undefined && mission.status !== 'running'
                && mission.status !== 'queued';
            });
            if (staleRuns.length > 0) {
              for (const run of staleRuns) {
                // The mission is already terminal — only the bot-engine
                // bookkeeping is stale, so stopBotRun alone is enough;
                // stopMission would clobber the terminal mission's honest
                // state (failed → cancelled).
                await stopBotRun(run).catch(() => {});
              }
              try {
                const resolvedModel2 = resolveLazyBotRunModel(action.model, [_model, getActiveModel().id]);
                const run = await launchBotRun(bot, action.task, {
                  model: resolvedModel2.model,
                  createMission: async (input) => addMission(toBotNewMissionInput(input, { originConversationId: conversationId })),
                });
                toast(`LazyBot "${bot.name}" run launched (after stale cleanup) — ${run.missionId}`, 'success');
                return {
                  message: `run_lazybot: "${bot.name}" launched after cleaning ${staleRuns.length} stale run(s) — runId: ${run.id}, missionId: ${run.missionId}`,
                };
              } catch (err2) {
                const reason2 = errorMessage(err2);
                const msg2 = `run_lazybot: could not launch "${bot.name}" (${bot.id}) even after stale cleanup: ${reason2}`;
                toast(msg2, 'error');
                return { failed: true, message: msg2 };
              }
            }
          }
          const msg = `run_lazybot: could not launch "${bot.name}" (${bot.id}): ${reason}`;
          toast(msg, 'error');
          return { failed: true, message: msg };
        }
      },
      stop_lazybot: async () => {
        if (action.type !== 'stop_lazybot') return;
        const stopTarget = resolveLazyBotRef(await listBots(), action.botId);
        const runs = listActiveRunsForBot(stopTarget?.id ?? action.botId);
        for (const run of runs) {
          // Real abort through the store's own stop path (stopFlag +
          // controller → runMission unwinds → the launch chain's finish
          // hook fires), then immediate bot-engine bookkeeping + Solari
          // session release (idempotent with the chain's own call).
          stopMission(run.missionId);
          await stopBotRun(run).catch(() => {});
        }
        const msg = `stop_lazybot: stopped ${runs.length} run(s) for bot "${action.botId}".`;
        toast(
          runs.length > 0 ? msg : `stop_lazybot: bot "${action.botId}" has no active runs.`,
          runs.length > 0 ? 'success' : 'info',
        );
        return { message: msg };
      },
      list_lazybots: async () => {
        if (action.type !== 'list_lazybots') return;
        const bots = await listBots();
        const summary = bots.map((b) => {
          const state = getBotRuntimeState(b.id);
          return {
            id: b.id,
            name: b.name,
            autonomy: b.autonomy,
            enabled: b.enabled,
            activeRuns: state.activeRuns.length,
            status: b.enabled ? (state.activeRuns.length > 0 ? 'running' : 'idle') : 'disabled',
          };
        });
        const lines = summary.length > 0
          ? summary.map((s) => `${s.id} ("${s.name}", ${s.autonomy}, enabled=${s.enabled}, activeRuns=${s.activeRuns}, status=${s.status})`).join('\n')
          : '(no LazyBots saved yet)';
        toast(summary.length > 0 ? `LazyBots found: ${summary.length}` : 'No LazyBots saved yet', 'info');
        return { message: `list_lazybots:\n${lines}` };
      },
    };
    return runManagerActionHandler(action, handlers);

  }, [addMission, stopMission, stopAll, retryMission, deleteMission, archiveMission, toggleLoop, deleteLoop, revertMission, updateMission, interveneMission, approveMission, changeApprovalMode, appContext, toast, t, freezeLoopTemplate]);

  useEffect(() => {
    executeManagerActionRef.current = executeManagerAction;
  }, [executeManagerAction]);

  // 2026-08-06 (founder: "c'est une catastrophe que le lazymanager ne fasse
  // pas ce qu'on demande ... fait le necessaire") — DIRECT canvas cleanup
  // without the LLM: the quick-action buttons ("Stoppe tout" / "Nettoyer")
  // must work even when the manager model keeps answering in prose without
  // emitting <lazy_actions>. Reuses the manager action EXECUTOR (same
  // journal-aware clear_canvas path) fired straight from the button — the
  // real result lands in the active conversation as a (hidden) "Résultat
  // réel" message + a visible toast, exactly like the manager path.
  const clearCanvasDirect = useCallback(
    (scope = 'all', mode: 'archive' | 'delete' = 'archive') => {
      void executeManagerAction(
        { type: 'clear_canvas', scope, mode } as ManagerAction,
        '',
        new Map(),
        stateRef.current.activeConversationId,
      );
    },
    [executeManagerAction],
  );

  const sendManagerMessage = useCallback(async (conversationId: string, text: string, model: string, opts?: {
    displayContent?: string;
    /**
     * GOAL LOOP: true ONLY for the manager-wakeup scheduler's own call site
     * below (sendWakeupTurn) — never inferred from `displayContent`'s
     * presence (that field's own doc comment already reserves it for the
     * wakeup caller today, but coupling goal-capture gating to it as an
     * implicit side effect would silently break the moment a second
     * displayContent caller is added). Gates goal CAPTURE off (a synthetic
     * wakeup message is not a real user request — see managerEngine.ts's
     * detectUserActionRequest, which would otherwise false-positive on the
     * wakeup text's own French instruction verbs) and gates goal EVALUATION
     * on (see wakeupHasTerminalMissionEvent below). Implies isAutomatedTurn.
     */
    isWakeupTurn?: boolean;
    /**
     * GOAL LOOP: true when the real WakeupCandidate batch that produced
     * this wakeup turn contains a terminal mission event (mission_failed /
     * merge_landed — "mission merged/failed/done" per the founder brief).
     * Set by the sendWakeupTurn wiring below from its own `candidates`
     * argument. Ignored when `isWakeupTurn` is not also true.
     */
    wakeupHasTerminalMissionEvent?: boolean;
    /**
     * GOAL LOOP: true for EVERY other background/synthetic call site in
     * this file that is not the wakeup scheduler itself — today:
     * announceLoopApprovalIfPromoted, announceLoopFailureIfDemoted,
     * runFleetHygieneSweep's loop-supervision alert, and
     * maybeResumeAfterApprovalQueueDrain's approval-resume turn
     * (managerApprovalResume.ts) below. Real repro this
     * guards against: formatLoopPromotedMessage's French text ("La boucle
     * « X » passe en autonomie...") contains a bare USER_ACTION_VERBS
     * lemma ("passe") — without this flag, detectUserActionRequest would
     * false-positive a goal CAPTURE from the manager's own background
     * announcement, exactly the "not a real user request" failure mode
     * isWakeupTurn already guards against for the wakeup call site. Only
     * gates capture off; never implies wakeupHasTerminalMissionEvent, so
     * these call sites can never trigger goal EVALUATION either.
     */
    isAutomatedTurn?: boolean;
  }) => {
    // Captured before any await — see managerGenerationRef's doc comment.
    // Compared again after every await below so a turn that the user
    // abandoned (newManagerConversation/loadManagerSession fired on THIS
    // SAME conversation while this was in flight) never writes its
    // late-arriving reply/error into a conversation it no longer belongs
    // to. Scoped to `conversationId` — a generation bump on a DIFFERENT
    // conversation never affects this turn (multi-conversation LazyManager,
    // wave 1: every generation/abort/busy check below is keyed off THIS
    // conversation's own map entry, never a singular global).
    const myGeneration = managerGenerationRef.current.get(conversationId) ?? 0;
    const userMsg: ManagerMessage = {
      id: createMessageId(),
      role: 'user',
      content: text,
      // See ManagerMessage.displayContent's own doc comment — undefined for
      // every ordinary user-typed turn (the overwhelming majority), so the
      // UI's `displayContent ?? content` fallback makes this call site a
      // pure no-op change unless a caller (currently only the manager-wakeup
      // scheduler wiring below) actually opts in.
      displayContent: opts?.displayContent,
      timestamp: new Date().toISOString(),
    };

    // W-MGRCREDITS fix (no-credits preflight): a manager turn on a
    // managed/pro-routed model with an already-known-empty wallet used to
    // ALWAYS make the network call anyway and sit on the shared timeout —
    // proven live to read as an indefinite hang (see MANAGER_TURN_TIMEOUT_MS's
    // doc comment, managerEngine.ts). The missions runtime already refuses
    // this case instantly via recovery.ts's noCreditsPolicy; the manager chat
    // had no equivalent. `subscription`/`isPro` here are the SAME shared
    // useSubscriptionContext() state the header's "Pro ⊙ 0" chip reads (no
    // extra fetch) — when it agrees credits are exhausted AND the currently
    // resolved provider mode would actually route this turn through the
    // managed ai-proxy, short-circuit BEFORE ever setting managerBusy: no
    // spinner, no wait, an honest card with real recovery actions instead.
    const mode = getProviderMode();
    // Unsigned browser + free OpenRouter id: the ai-proxy
    // requires a user JWT even for free models (measured 2026-08-28 —
    // ManagedUnavailableError after a doomed streamManagedAgentTurn).
    // Same shape as the credits preflight: no spinner, honest card, CTA.
    if (managerTurnNeedsSession(model, mode) && !(await hasManagedSession())) {
      const blockedMsg: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: t('cockpit.manager.sessionRequiredMessage'),
        timestamp: new Date().toISOString(),
        sessionBlocked: true,
      };
      setState((prev) => appendConversationMessages(prev, conversationId, [userMsg, blockedMsg]));
      return;
    }

    const isManagedRouted = mode === 'managed' || mode === 'pro';
    // FREE MODEL BYPASS (2026-08-25): a free OpenRouter model is
    // served by the ai-proxy at zero cost with no plan/credits requirement
    // (see entitlement.ts's getEngineReadiness free-tier short-circuit).
    // The credits-exhausted gate below must never block a turn whose
    // selected model is free — proven live: a user with an active Pro plan
    // + 0 credits + the free model selected was refused outright despite it
    // costing nothing. The model is read from the same `model` argument
    // this turn was called with (the manager's own selection).
    const isFreeModel = isOpenRouterFreeModel(model);
    const creditsExhausted =
      !isFreeModel &&
      isManagedRouted && isPro && !!subscription &&
      isOutOfCredits(subscription.credits_remaining_cents, subscription.status);

    // STACK fix: a user can hold both a Claude CLI/BYOK subscription and an
    // active Lazy Pro plan at once (they stack, never mutually exclusive —
    // see modelPickerOptions.ts's module doc comment). 0 Pro credits must
    // never refuse the manager's OWN turn outright when a CLI subscription
    // is ready to serve it instead — isNativeModelReady() is the SAME
    // mode-independent readiness signal runtime.ts's own per-mission
    // dispatch already uses (isManagedModelReady/isNativeModelReady), no new
    // detection invented here. Only refuse (below) when NEITHER rail can
    // serve this turn; otherwise route it onto the CLI via runManagerTurn's
    // engineOverride (see the call site further down).
    const nativeRescue = creditsExhausted && isNativeModelReady();

    if (creditsExhausted && !nativeRescue) {
      // W-MODELSEL fix: honest auto-refill messaging — includes the real
      // renewal date (subscription.period_end, the SAME field already
      // forwarded to the LLM via creditsSummary below) when available,
      // falls back to a date-less "next automatic refill" line rather than
      // ever inventing a date.
      const renewalDate = formatRenewalDate(subscription?.period_end, locale);
      const blockedMsg: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: renewalDate
          ? t('cockpit.manager.noCreditsMessageWithDate', { date: renewalDate })
          : t('cockpit.manager.noCreditsMessage'),
        timestamp: new Date().toISOString(),
        creditsBlocked: true,
      };
      setState((prev) => appendConversationMessages(prev, conversationId, [userMsg, blockedMsg]));
      return;
    }

    const streamDraftId = createMessageId();
    setState((prev) => appendConversationMessages(
      withConversation(prev, conversationId, { busy: true, phase: 'turn', elapsedMs: 0 }),
      conversationId,
      [
        userMsg,
        {
          id: streamDraftId,
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          isStreaming: true,
        },
      ],
    ));

    let streamRaf = 0;
    let latestStreamPreview = '';
    const schedulePaint = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(cb, 16) as unknown as number;
    const cancelPaint = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);
    const paintStreamPreview = (raw: string) => {
      latestStreamPreview = sanitizeManagerDisplayText(raw);
      if (streamRaf !== 0) return;
      streamRaf = schedulePaint(() => {
        streamRaf = 0;
        const preview = latestStreamPreview;
        if ((managerGenerationRef.current.get(conversationId) ?? 0) !== myGeneration) return;
        setState((prev) => mapConversationMessages(prev, conversationId, (m) => (
          m.id === streamDraftId ? { ...m, content: preview, isStreaming: true } : m
        )));
      });
    };
    const replaceStreamDraft = (messages: ManagerMessage[]) => {
      if (streamRaf !== 0) {
        cancelPaint(streamRaf);
        streamRaf = 0;
      }
      setState((prev) => {
        const conv = prev.conversations[conversationId];
        if (!conv) return prev;
        const withoutDraft = conv.messages.filter((m) => m.id !== streamDraftId);
        return withConversation(prev, conversationId, {
          messages: capManagerMessages([...withoutDraft, ...messages]),
          lastActiveAt: Date.now(),
        });
      });
    };

    // P0-1 fix (real user test: 3/3 non-trivial requests timed out with 0
    // nodes created). `turnCtrl` is now ONLY the exchange-wide BACKSTOP —
    // the user Stop button and the MANAGER_TURN_TIMEOUT_MS ceiling — not a
    // per-call deadline. Before this fix, this SAME controller (then named
    // timeoutCtrl) was handed AS-IS to both the first runManagerTurn call
    // and runGroundedFollowUp's own call, so two sequential CLI cold starts
    // + generations had to fit inside ONE shared 90s window. Each call now
    // derives its OWN independent AbortController from `turnCtrl.signal` via
    // createManagerCallController (MANAGER_LLM_CALL_TIMEOUT_MS, 300s) — see
    // that function's doc comment — so Stop/the global ceiling still reach
    // whichever call is in flight, but neither call starves the other.
    // managerBusy is reset in the `finally` below UNCONDITIONALLY, so it is
    // guaranteed to resolve exactly once per call regardless of success, a
    // thrown error, or any deadline firing.
    //
    // Created and registered on managerAbortRef SYNCHRONOUSLY, before the
    // concurrency-slot await below — a Stop click can therefore always
    // reach this turn, whether it is actively running OR still queued
    // (MAX_CONCURRENT_MANAGER_TURNS). Also covers the whole queue wait in
    // MANAGER_TURN_TIMEOUT_MS's own ceiling, which is the correct behaviour
    // for an exchange-wide backstop.
    const turnStartedAt = Date.now();
    const turnCtrl = new AbortController();
    const turnCapTimeout = setTimeout(() => turnCtrl.abort(), MANAGER_TURN_TIMEOUT_MS);
    // Stop button plumbing — see managerAbortRef/managerStoppedRef's doc
    // comments above. Reset at the start of every turn so a stale flag from
    // a PREVIOUS (already-finished) exchange on THIS SAME conversation never
    // mislabels this one — keyed by conversationId so a Stop click on a
    // DIFFERENT conversation can never reach this turn's controller.
    managerAbortRef.current.set(conversationId, turnCtrl);
    managerStoppedRef.current.set(conversationId, false);

    // Concurrency cap (MAX_CONCURRENT_MANAGER_TURNS): at most that many
    // conversations hold an LLM call at once. `onQueued` only fires when
    // this call genuinely has to wait — flips `phase` to 'queued' so the UI
    // shows an honest "en attente" status instead of implying the call
    // already started. Resolves immediately (no observable wait) whenever a
    // slot is free, which is the overwhelming common case (few conversations
    // busy at once).
    await acquireManagerTurnSlot(conversationId, () => {
      setState((prev) => withConversation(prev, conversationId, { phase: 'queued' }));
    });
    // The wait above may have taken a while — if THIS conversation was reset
    // (newManagerConversation/loadManagerSession) while queued, release the
    // slot immediately and abandon this turn rather than starting a call for
    // a conversation nobody is looking at anymore. Same treatment for a Stop
    // click that landed while still queued (managerStoppedRef) — the turn
    // never actually reached the model, so it renders the same
    // "interrompu" outcome a Stop mid-call gets, via the SAME `finally`
    // below (busy/phase reset), just skipping straight past the LLM call.
    if ((managerGenerationRef.current.get(conversationId) ?? 0) !== myGeneration) {
      releaseManagerTurnSlot();
      replaceStreamDraft([]);
      return;
    }
    if (managerStoppedRef.current.get(conversationId)) {
      releaseManagerTurnSlot();
      clearTimeout(turnCapTimeout);
      managerAbortRef.current.set(conversationId, null);
      replaceStreamDraft([{
        id: createMessageId(),
        role: 'assistant',
        content: t('cockpit.manager.interrupted'),
        timestamp: new Date().toISOString(),
        timedOut: true,
        retryText: text,
      }]);
      setState((prev) => withConversation(prev, conversationId, { busy: false, phase: 'idle', elapsedMs: 0 }));
      return;
    }
    setState((prev) => withConversation(prev, conversationId, { phase: 'turn' }));

    // R4b fix (deliverable #4 — turn cost visibility): snapshot the REAL
    // session cost accumulator BEFORE this exchange's LLM call(s) so the
    // delta after it settles is a measured value, not a guess — see
    // ManagerMessage.approxCreditsUsed's doc comment for the full trail
    // (every provider branch calls addUsage synchronously inside the SAME
    // awaited runManagerTurn/runGroundedFollowUp call).
    const costBeforeTurn = getCostState();

    // P0-1 fix (item #3 — no visible feedback beyond ~15s): ticks
    // managerElapsedMs roughly once a second for the whole exchange, so a
    // long turn never reads as a dead screen — see managerElapsedMs' own doc
    // comment (AgentsState) for why this lives here rather than as UI-local
    // state. Cleared in the `finally` below, same guarantee as managerBusy.
    const elapsedTicker = setInterval(() => {
      if ((managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
        setState((prev) => withConversation(prev, conversationId, { elapsedMs: Date.now() - turnStartedAt }));
      }
    }, 1000);

    // Real elapsed time for the MAIN call specifically — surfaced in the
    // honest timeout message below ("generation" phase, P0-1 item #2)
    // instead of a static "too long" line with no sense of how long the
    // wait actually was. `mainCall` is read in the outer catch to tell a
    // genuine main-call timeout apart from any other failure.
    let mainCallElapsedMs = 0;
    let mainCall: ManagerCallController | undefined;

    try {
      // Every member is bounded via boundedContext (see its doc comment):
      // these fetches run BEFORE turnCtrl's deadline covers anything, so
      // an unbounded hang here (stalled Tauri IPC in buildCanvasDigest —
      // the canvas-W4 regression) froze the entire exchange forever with
      // managerBusy stuck true and no reply. Each degrades independently to
      // an honest fallback; none can reject or stall the turn.
      //
      // PERF OPTIMIZATION (2026-08-25): resolveProjectRoot is now included
      // in the Promise.all instead of being awaited sequentially AFTER it.
      // It was the only async call in the post-Promise.all block, adding a
      // full IPC round-trip to the critical path. With the resolveProjectRoot
      // cache (see its doc comment above), a first-turn fetchManagerStartupContext
      // already warms the cache, so this resolve is usually a cache hit — but
      // parallelizing it covers the case where fetchManagerStartupContext
      // timed out without populating the cache.
      // A greeting / "ok" / short question does not need the canvas digest
      // or a live sidecar probe — those were adding up to 2s+ before the
      // first token on every "bonjour". Action requests still get the full
      // board (detectUserActionRequest is the same heuristic the promise-
      // stall guard already trusts).
      const skipHeavyContext = shouldSkipHeavyManagerContext(userMsg.content);
      const waitStartup = shouldBlockOnManagerStartupContext(
        skipHeavyContext,
        hasInjectedStartupContext(conversationId),
      );
      const [agents, startupContext, canvasDigest, brainInfo, brainSidecarReachable, projectRoot, savedBots] = await Promise.all([
        boundedContext(listAgents(), [] as StoredAgent[], 'manager agents list'),
        // Already self-bounded to a 5s race internally, but that race does
        // not cover its own resolveProjectRoot() await — the outer 6s bound
        // (5s inner budget + 1s slack) closes that hole without shrinking it.
        // Greetings never wait: peek the prewarm cache (0ms) or skip. The
        // first action turn of the conversation still fetches if nothing
        // was injected yet.
        waitStartup
          ? boundedContext(fetchManagerStartupContext(), undefined, 'manager startup context', 6_000)
          : Promise.resolve(peekStartupContextIfCached()),
        // Agent Canvas W4 (spec §8.2) — injected every turn, same reasoning
        // as creditsSummary below: no action round-trip to wait for, the
        // real canvasStoreVanilla + journal state is always available.
        // Fallback undefined (not ''): buildManagerSystemPrompt's
        // `canvasDigest ? ... : ''` guard then skips the block cleanly.
        skipHeavyContext
          ? Promise.resolve(undefined)
          : boundedContext<string | undefined>(buildCanvasDigest(), undefined, 'canvas digest'),
        // Silent-degradation fix: real Brain: state (unavailable / not
        // indexed for this project / indexed with N notes) — see
        // fetchManagerBrainInfo's doc comment and formatBrainStatus
        // (managerEngine.ts). Fallback undefined resolves to the honest
        // "unavailable" state, never a guessed "empty" one. Greetings skip
        // this probe — it was still on the TTFT critical path after the
        // digest/sidecar skip.
        skipHeavyContext
          ? Promise.resolve(undefined)
          : boundedContext<BrainInfo | undefined>(fetchManagerBrainInfo(), undefined, 'manager brain status'),
        // GRAPH/RECALL DIVERGENCE FIX: independent live-sidecar reachability
        // probe — see fetchManagerBrainSidecarReachable's doc comment for
        // why `brainInfo` alone is not sufficient. Fallback false is the
        // conservative choice (no claim of reachability the probe itself
        // could not confirm within budget).
        skipHeavyContext
          ? Promise.resolve(false)
          : boundedContext<boolean>(fetchManagerBrainSidecarReachable(), false, 'manager brain sidecar reachability'),
        // PERF: resolveProjectRoot in parallel with the other fetches instead
        // of sequentially after. Bounded to 6s — same budget as
        // fetchManagerStartupContext. Falls back to '.' on timeout/failure.
        boundedContext(resolveProjectRoot().catch(() => '.'), '.', 'manager project root', 6_000),
        // LazyBots every turn (ManagerContext.lazyBots) — one small local
        // JSON read (.lazy/bots.json), so it is NOT gated on
        // skipHeavyContext: "lance le bot X" is short enough to skip the
        // heavy blocks yet is exactly the turn that needs the bot ids.
        // Sequenced AFTER resolveProjectRoot (which fills the root cache on
        // success) and read with waitForRoot:false: botStorage's own
        // boot-race wait would otherwise burn its full 3 s bound on every
        // turn taken with no project open (web mode / welcome screen /
        // tests) — see rootPath's doc comment (botStorage.ts).
        boundedContext(
          resolveProjectRoot().catch(() => '.').then(() => listBots({ waitForRoot: false })),
          [] as BotConfig[],
          'manager lazybots list',
          3_000,
        ),
      ]);
      if (waitStartup || startupContext) markStartupContextInjected(conversationId);
      // Gate-usability fix: getEffectiveAutonomy() with no config silently
      // defaults to DEFAULT_AUTONOMY.mode ('supervised') regardless of what
      // the user picked in the autonomy selector — always pass the real
      // state.autonomyLevel so the manager's own system-prompt context and
      // the gate decision below agree with what the UI shows.
      //
      // stateRef.current (NOT the render-scoped `state`): this callback is
      // also reached through sendManagerMessageRef by the automated
      // post-approval resume (maybeResumeAfterApprovalQueueDrain). That
      // ref is re-pointed by an effect AFTER React commits, while the
      // resume fires in the same microtask flush as the approval that just
      // ran run_lazybot/launch_mission — so the closure it lands in
      // predates the mission it is meant to talk about. Live QA 2026-09-02:
      // run_lazybot created M96, the resume turn's context had no M96 and a
      // stale M95, and the manager "honestly" reported the fleet as failed
      // while M96 was completing on the canvas. By the time this line runs
      // the Promise.all above has crossed real IPC awaits, so the ref
      // reflects the committed state that includes the new mission.
      const liveState = stateRef.current;
      const baseCtx = await gatherManagerContext(agents, liveState.missions, getEffectiveAutonomy({ mode: liveState.autonomyLevel }));
      // Real account/credits state (same shared useSubscriptionContext()
      // read as the credits KPI tile / AccountChip — no second Supabase
      // fetch) so "combien ai-je de crédits ?" is grounded on every turn,
      // not just a follow-up-gated one.
      const creditsSummary = formatCreditsSummary({
        isPro,
        status: subscription?.status,
        creditsRemainingCents: subscription?.credits_remaining_cents,
        creditsIncludedCents: subscription?.credits_included_cents,
        periodEnd: subscription?.period_end,
      });
      // STACK fix: live status of the two independent engine rails — same
      // detectModelEntitlements() primitive every model picker already uses,
      // no new detection. See ManagerContext.entitlementsSummary's doc
      // comment (managerEngine.ts) for why this is separate from creditsSummary.
      const modelEntitlements = detectModelEntitlements();
      const entitlementsSummary = formatEntitlementsSummary(
        modelEntitlements,
        subscription?.credits_remaining_cents,
      );
      // PERF: fleetContext and autonomyContext are already computed inside
      // gatherManagerContext (baseCtx above) with the exact same arguments —
      // removed the duplicate calls that were here. brainDrivenContext and
      // lessonsContext ARE different here (they pass userMsg.content / the
      // real projectId), so they stay.
      const brainDrivenContext = buildBrainDrivenContext(userMsg.content);
      const _projectId = projectIdFromRoot(projectRoot);
      const _baseLessons = buildLessonsContext(_projectId, userMsg.content);
      const _learningCtx = _projectId ? buildLearningContext(_projectId) : { combinedContext: '' };
      const lessonsContext = [_baseLessons, _learningCtx.combinedContext].filter(Boolean).join('\n\n') || undefined;

      // ── GOAL LOOP (founder directive — see managerEngine.ts's "GOAL LOOP"
      // section header for the full rationale) ──────────────────────────
      // Capture/refresh: ONLY on a genuine user-initiated turn, never the
      // synthetic wakeup message itself (see sendManagerMessage's own
      // isWakeupTurn doc comment above for why that would false-positive) —
      // reuses detectUserActionRequest, the SAME heuristic the PROMISE-STALL
      // guard (managerEngine.ts) already trusts to recognize "the user
      // clearly asked for an action". A fresh match REPLACES whatever goal
      // was tracked before (see createConversationGoal's own doc comment).
      const isWakeupTurn = opts?.isWakeupTurn === true;
      // See isAutomatedTurn's own doc comment above (sendManagerMessage's
      // opts type) — covers every background/synthetic call site, not only
      // the wakeup one, so none of them can be mistaken for a real user ask.
      const isAutomatedTurn = isWakeupTurn || opts?.isAutomatedTurn === true;
      const goalJustCaptured = !isAutomatedTurn && detectUserActionRequest(userMsg.content);
      if (goalJustCaptured) {
        const captured = createConversationGoal(userMsg.content, Date.now());
        conversationGoals.set(conversationId, captured);
        persistConversationGoal(conversationId, captured);
      }
      // Evaluation only fires on the wakeup path for a TERMINAL mission
      // event (mission merged/failed — wakeupHasTerminalMissionEvent, set by
      // the sendWakeupTurn wiring below from the real WakeupCandidate batch)
      // when this conversation still has an ACTIVE goal — never on an
      // ordinary chat turn, and never once the goal already settled
      // (exhausted / achieved-claimed terminal states).
      const goalBeforeTurn = conversationGoals.get(conversationId);
      const shouldEvaluateGoal =
        isWakeupTurn && opts?.wakeupHasTerminalMissionEvent === true && goalBeforeTurn?.status === 'active';
      const goalBudgetExhausted =
        shouldEvaluateGoal && !!goalBeforeTurn && goalBeforeTurn.extensionsUsed >= MAX_GOAL_EXTENSIONS;
      const goalStatusContext = shouldEvaluateGoal && goalBeforeTurn
        ? buildGoalStatusContext({
            goal: goalBeforeTurn,
            budgetExhausted: goalBudgetExhausted,
            researchBudgetExhausted: goalBeforeTurn.researchOnlyStreak >= RESEARCH_ONLY_STREAK_BUDGET,
          })
        : undefined;

      const ctx: ManagerContext = {
        ...baseCtx,
        startupContext,
        creditsSummary,
        entitlementsSummary,
        // modelId catalog wave: gates the compact full-catalog block
        // (buildCompactModelCatalog, managerEngine.ts) — the CLI-only rail
        // can never route to any of those ids, see ManagerContext.
        // proRailActive's own doc comment.
        proRailActive: modelEntitlements.pro === 'active',
        brainStatus: formatBrainStatus(brainInfo, brainSidecarReachable),
        canvasDigest,
        // Real saved LazyBots (ids + runtime state) every turn — see
        // ManagerContext.lazyBots (managerEngine.ts): the model can emit
        // run_lazybot with a grounded botId in the SAME reply instead of a
        // list_lazybots round-trip, and the repair/Layer-3 fallbacks map a
        // bot named in prose to its real id.
        lazyBots: savedBots.map((b) => summarizeLazyBot(b, getBotRuntimeState(b.id).activeRuns.length)),
        // fleetContext and autonomyContext come from baseCtx (gatherManagerContext)
        // — no longer overridden here (PERF: removed duplicate calls).
        brainDrivenContext,
        lessonsContext,
        // Round-3 QA fix: no per-turn signal ever told the manager which
        // language the UI is actually in (see ManagerContext.locale's doc
        // comment, managerEngine.ts) — `locale` here is the SAME useI18n()
        // value every other UI string already renders from (destructured at
        // this provider's top, see the module's own `const { t, locale } =
        // useI18n()`), threaded through as a plain string per that field's
        // decoupling convention.
        locale,
        // Defect 2 fix (Mission Charter convergence) — see
        // deriveCharterStatusContext's own doc comment above and
        // ManagerContext.charterStatusContext's doc comment (managerEngine.ts)
        // for the real repro this closes. `userMsg.content` (not yet appended
        // to state.managerMessages at this point) is included explicitly so
        // ACCEPTED is recognized on the SAME turn the user's Validate click
        // sends it, not one turn later.
        charterStatusContext: deriveCharterStatusContext(stateRef.current.conversations[conversationId]?.messages ?? [], userMsg.content, t, conversationId),
        // Token-efficiency wave (2026-08-01): lets buildManagerDynamicContext
        // narrow the ECC catalog to this turn's domain — see
        // ManagerContext.lastUserMessage's own doc comment (managerEngine.ts).
        lastUserMessage: userMsg.content,
        // GOAL LOOP — see ManagerContext.goalStatusContext's own doc comment
        // and the goalStatusContext computation just above.
        goalStatusContext,
        // D91 — stamp omitted brain_query.sessionId with this conversation.
        conversationId,
      };
      // Token-efficiency wave (2026-08-01): bound the history actually sent
      // to the LLM — see managerHistoryWindow.ts's module doc comment for
      // why this is safe (pending approvals/in-flight missions are already
      // reconstructed from live state above, independent of raw history;
      // deriveCharterStatusContext just above reads the FULL, un-windowed
      // state.managerMessages, not this windowed copy). `fullHistory` is
      // still what gets PERSISTED (setState below appends userMsg/the
      // assistant reply to state.managerMessages, never to the windowed
      // copy) — only what gets SENT to the model this turn is bounded.
      // The live transcript already contains `userMsg` plus the in-flight
      // stream draft — never resend the draft (empty / unsanitized) and
      // never append userMsg a second time.
      const liveMessages = (stateRef.current.conversations[conversationId]?.messages ?? []).filter(
        (m) => m.id !== streamDraftId && !m.isStreaming,
      );
      const fullHistory = liveMessages.some((m) => m.id === userMsg.id)
        ? liveMessages
        : [...liveMessages, userMsg];
      const turnMessages = boundManagerHistory(fullHistory).messages;

      // P0-1 fix: the main call gets its OWN MANAGER_LLM_CALL_TIMEOUT_MS
      // budget (createManagerCallController), derived from turnCtrl so
      // Stop/the global backstop still reach it — see turnCtrl's doc
      // comment above for the "two calls stacked into one shared window"
      // bug this replaces. mainCallElapsedMs/mainCall are read by the outer
      // catch below to render an honest, phase+elapsed-aware timeout message.
      mainCall = createManagerCallController(turnCtrl.signal, MANAGER_LLM_CALL_TIMEOUT_MS);
      const mainCallStartedAt = Date.now();
      let result: ManagerTurnResult;
      try {
        result = await runManagerTurn({
          messages: turnMessages,
          context: ctx,
          model,
          signal: mainCall.signal,
          // C3 fix: rearms mainCall's inactivity deadline on every fragment —
          // see ManagerTurnOptions.onChunk's doc comment (managerEngine.ts).
          onChunk: mainCall.reportActivity,
          onPartial: paintStreamPreview,
          // STACK fix: rescue this turn onto the CLI rail when the preflight
          // above found the ambient mode empty-walleted but a native CLI
          // subscription ready (see nativeRescue above) — never refuse the
          // manager outright when a working rail exists.
          engineOverride: nativeRescue ? 'cli' : undefined,
        });
      } finally {
        mainCallElapsedMs = Date.now() - mainCallStartedAt;
        mainCall.dispose();
      }

      // query_mission / get_agent_output / brain_query ask about REAL data —
      // ground the visible answer in the mission's actual transcript/result
      // and/or a real brain recall, instead of whatever the first turn
      // guessed (see runGroundedFollowUp). ctx already carries startupContext
      // so the follow-up turn keeps it too. Passes turnCtrl's PARENT signal
      // (not mainCall's, which is already disposed) — runGroundedFollowUp
      // derives its own independent per-call budget from it (see that
      // function's doc comment).
      //
      // managerPhase flips to 'grounding' ONLY when a grounding action was
      // actually emitted (checked BEFORE the round-trip via the same
      // findGroundingActions predicate runGroundedFollowUp uses internally)
      // — the rail's "Recherche dans le brain…" status line (thread 1c)
      // must never show for a plain info/action turn that never grounds.
      const isGrounding = hasAnyGroundingAction(findGroundingActions(result.actions));
      if (isGrounding) {
        setState((prev) => withConversation(prev, conversationId, { phase: 'grounding' }));
      }
      const grounded = await runGroundedFollowUp({
        firstTurn: result,
        messages: turnMessages,
        context: ctx,
        agents,
        missions: () => stateRef.current.missions,
        model,
        signal: turnCtrl.signal,
        onPartial: paintStreamPreview,
      });
      if (isGrounding) {
        setState((prev) => withConversation(prev, conversationId, { phase: 'turn' }));
      }

      // R4b fix: grounded.actions now carries ALL turns' actions (main +
      // every grounding turn) merged inside runGroundedFollowUp's loop via
      // mergeManagerActions — use it directly instead of re-merging with
      // result.actions (which is already included in grounded.actions).
      const rawActionsToExecute = grounded.actions
        ? [...grounded.actions]
        : result.actions;

      // Founder's #1 complaint fix (dangling-edge graph card) — repair any
      // generate_plan action's `steps` HERE, before ANYTHING downstream
      // reads them: `msg.proposal.steps` below, `deferredActions`,
      // `assistantMsg.actions`, a pending-approval snapshot
      // (approvePendingAction replays this SAME action object later), and
      // the executor's own 'generate_plan' case. Previously the repair
      // (repairPlanSteps) ran ONLY inside that executor case, AFTER the
      // proposal card had already been built from the RAW, unrepaired
      // steps (idx-based id fallback, see the proposal construction
      // below) — so a step id renamed for a collision (planStepRepair.ts's
      // own header: same-plan OR cross-plan collision) left the card's
      // node ids and its dependsOn-derived edges disagreeing with what the
      // orchestrator actually persists/executes. That mismatch is exactly
      // what fed layout.ts's elkjs call a dangling edge and crashed the
      // whole preview. Repairing once, here, means the card, the canvas
      // preview and the persisted orchestrator all read the SAME steps —
      // reusing repairPlanSteps rather than duplicating its logic a
      // second time in the executor (which now just trusts `action.steps`).
      const actionsToExecute = rawActionsToExecute.map((action) => {
        if (action.type !== 'generate_plan') return action;
        const liveCanvasState = canvasStoreVanilla.getState();
        const takenStepIds = new Set<string>([
          ...liveCanvasState.drafts.map((draft) => draft.id),
          ...liveCanvasState.joins.map((join) => join.id),
        ]);
        const { steps: repairedSteps, notes: planRepairNotes } = repairPlanSteps(action.steps ?? [], takenStepIds);
        if (planRepairNotes.length > 0) {
          console.warn('[generate_plan] plan step repair:', planRepairNotes);
        }
        return { ...action, steps: repairedSteps };
      });

      // ── GOAL LOOP: fold this turn's REAL actions back into the tracked
      // goal (see managerEngine.ts's applyGoalEvaluationOutcome for the
      // exhausted/achieved-claimed/research-streak/advanced state machine)
      // and pick the user-visible notice, if any, for this turn — same
      // `[objectif]`/`[goal]`-prefixed convention as the PROMISE-STALL
      // nudge notices (managerEngine.ts).
      //
      // DELIBERATELY silent on plain capture (goalJustCaptured is NOT
      // wired to a notice here, even though buildGoalTrackedNotice exists
      // and is unit-tested — see managerGoalLoop.test.ts): detectUserAction
      // Request is intentionally broad (its whole point, for the PROMISE-
      // STALL nudge, is to catch every plausible imperative, including a
      // bare "cherche X" / "status of M12?" / a message that merely fails
      // to start with a recognized non-verb). Proven empirically during
      // this fix's own regression run — wiring the tracked-notice in
      // unconditionally broke a dozen unrelated existing tests
      // (agentsStore.test.tsx, managerGroundedActions.test.tsx,
      // agentsStoreConcurrentConversations.test.tsx) whose fixtures happen
      // to phrase an ordinary question/search in a way the heuristic reads
      // as an action request. Surfacing a "new goal tracked" banner on
      // every such turn would be real UX noise, not just a test artifact.
      // The capture itself (conversationGoals.set above) still happens
      // exactly per spec; only the visible announcement is scoped down to
      // the two higher-signal, wakeup-only evaluation outcomes below,
      // which have no such false-positive surface (they never fire on an
      // ordinary chat turn — see shouldEvaluateGoal's own gating).
      let goalNotice: string | undefined;
      if (shouldEvaluateGoal && goalBeforeTurn) {
        const goalOutcome = applyGoalEvaluationOutcome({
          goal: goalBeforeTurn,
          wasBudgetExhausted: goalBudgetExhausted,
          actionsThisTurn: actionsToExecute,
        });
        conversationGoals.set(conversationId, goalOutcome.goal);
        persistConversationGoal(conversationId, goalOutcome.goal);
        if (goalOutcome.kind === 'exhausted') {
          goalNotice = buildGoalExhaustedNotice(locale);
        } else if (goalOutcome.kind === 'achieved-claimed') {
          goalNotice = buildGoalAchievedNotice(grounded.responseText, locale);
        }
        // 'research-streak' / 'advanced': silent bookkeeping — no notice,
        // same as any ordinary in-progress turn (the NEXT evaluation turn's
        // goalStatusContext already reflects the updated budget/streak).
      }

      // R4b fix (deliverable #4): real measured delta since costBeforeTurn —
      // see ManagerMessage.approxCreditsUsed's doc comment. Never shown when
      // it rounds to 0 (nothing measurable — never fabricate a placeholder).
      const costAfterTurn = getCostState();
      const deltaCostUsd = Math.max(0, costAfterTurn.totalCostUsd - costBeforeTurn.totalCostUsd);
      const approxCreditsUsed = Math.round(deltaCostUsd * 100) || undefined;

      // ── Proposal gating (plan-expand UX) ──
      // When the manager's actions include a `generate_plan`, the message
      // enters a `pending` proposal state: mutative canvas actions are
      // deferred until the user validates (execute_plan) or rejects.
      // Only safe/read-only actions (focus, note, brain_query, info, etc.)
      // execute immediately. The planId is extracted from the generate_plan
      // action after the executor creates the orchestrator.
      const generatePlanAction = actionsToExecute.find((a) => a.type === 'generate_plan') as
        | Extract<ManagerAction, { type: 'generate_plan' }>
        | undefined;

      // Mission Charter gating (SPEC-CHARTE-DE-MISSION.md §1): mirrors
      // generate_plan's own proposal gate below — while a charter is
      // pending, the graph must NOT get built (no create_draft/create_loop/
      // generate_plan this same turn), same "propose, never commit" contract.
      const charterAction = actionsToExecute.find((a) => a.type === 'propose_mission_charter') as
        | Extract<ManagerAction, { type: 'propose_mission_charter' }>
        | undefined;

      // Visible-artifact fix — same "propose, never commit (to a graph)"
      // shape as charterAction above, but propose_artifact never gates
      // OTHER actions (it never builds a graph) — it just needs its own
      // fields surfaced onto the message below, same as charterAction's own.
      const artifactAction = actionsToExecute.find((a) => a.type === 'propose_artifact') as
        | Extract<ManagerAction, { type: 'propose_artifact' }>
        | undefined;

      // Actions that are always safe to execute even during a pending proposal
      const PROPOSAL_SAFE_ACTIONS = new Set([
        'info', 'brain_query', 'brain_query_css', 'brain_neighbours',
        'web_search', 'web_fetch', 'focus_canvas', 'canvas_note',
        'canvas_overview', 'list_agents', 'list_missions',
        'query_mission', 'get_agent_output', 'briefing_query',
        'decision_lookup', 'quote_mission', 'set_budget',
        'answer_question', 'generate_plan', 'scan_project',
        'propose_mission_charter', 'propose_artifact',
        // reject_plan targets an EXPLICIT planId of its own — unrelated to
        // whichever proposal this turn's own generate_plan/charter just
        // raised, so it must never be deferred alongside it (deferring it
        // would block cleaning up an old orphaned proposal in the very same
        // turn a new one is proposed).
        'reject_plan',
      ]);

      const isProposalPending = !!generatePlanAction;
      const isCharterPending = !!charterAction;

      // B: Collect deferred mutative actions (skipped during pending proposal).
      // These are stored on the proposal and replayed on accept.
      //
      // PERSISTED-INDEX DEADLOCK FIX (real user repro, live app: a deferred
      // `clear_canvas` already showing `actionStatuses: [true, true]` — i.e.
      // genuinely executed on a prior validate pass — STILL re-blocked every
      // subsequent "Valider & lancer" click, forever; the unit-tested
      // `livePendingByActionIndex` fix (executePlan's replay loop, below)
      // passed in-memory but never held against the real app). Root cause:
      // that loop matched a `deferredActions` entry back to its position in
      // `proposalMsg.actions` by OBJECT REFERENCE
      // (`proposalMsg.actions?.findIndex((a) => a === action)`), which the
      // comment right there already flagged as relying on `deferredActions`
      // being a `.filter()` of the SAME `actionsToExecute` array `actions`
      // is also set from below — true for the very first pass, in the same
      // tick this message is created. But `managerPersistence.ts` round-trips
      // the WHOLE message through `JSON.stringify`/`JSON.parse` on every save/
      // reload (`sanitizeMessage`/`sanitizeProposal`), which rebuilds
      // `actions` and `proposal.deferredActions` as two INDEPENDENT object
      // graphs — same content, but `a === action` is false for every entry
      // after even one reload. The replay loop's `actionIndex` then silently
      // computes -1, so the `priorStatus === true` skip a few lines below
      // never even runs (guarded by `actionIndex >= 0`) and the action falls
      // straight back through to `evaluateActionGate`, re-litigated forever
      // regardless of `actionStatuses` already recording it as done.
      // `deferredActionIndexes` is the fix: a plain `number[]`, parallel to
      // `deferredActions`, recording each entry's REAL position in
      // `actionsToExecute` (== `assistantMsg.actions` below) at the one
      // moment that position is still known for certain — construction
      // time, in this SAME tick, before any persistence round-trip can ever
      // happen. A number survives `JSON.stringify`/`JSON.parse` perfectly
      // (see managerPersistence.ts's own sanitizeProposal for the read-back
      // half), so the replay loop can look the index up directly instead of
      // re-deriving it from an identity that reload has already broken.
      const deferredActionEntries = isProposalPending
        ? actionsToExecute
            .map((a, index) => ({ action: a, index }))
            .filter(({ action: a }) => !PROPOSAL_SAFE_ACTIONS.has(a.type) && a.type !== 'generate_plan')
        : [];
      const deferredActions = deferredActionEntries.map((e) => e.action);
      const deferredActionIndexes = deferredActionEntries.map((e) => e.index);

      const assistantMsg: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        // Item 6 fix — see dedupeProseAgainstDecisionQuestions' own doc
        // comment: a no-op (returns `grounded.responseText` unchanged)
        // whenever this turn has no propose_mission_charter action at all,
        // which is every ordinary turn. GOAL LOOP: goalNotice (computed
        // above, undefined on every turn that isn't a goal capture/
        // evaluation) is prepended exactly like the PROMISE-STALL nudge
        // notices prepend to responseText in managerEngine.ts.
        content: (() => {
          const base = charterAction
            ? dedupeProseAgainstDecisionQuestions(grounded.responseText, charterAction.decisions)
            : grounded.responseText;
          return goalNotice ? `${goalNotice}\n\n${base}` : base;
        })(),
        timestamp: new Date().toISOString(),
        actions: actionsToExecute,
        approxCreditsUsed,
        compactNotice: result.compacted && result.compacted.foldedTurns > 0
          ? t('cockpit.manager.compacted', {
              count: result.compacted.foldedTurns,
              before: result.compacted.charsBefore,
              after: result.compacted.charsAfter,
            })
          : undefined,
        ...(generatePlanAction ? {
          proposal: {
            state: 'pending' as const,
            objective: generatePlanAction.objective,
            steps: (generatePlanAction.steps ?? []).map((s, idx) => ({
              id: s.id ?? `${idx}`,
              description: s.description,
              agentName: s.agentName,
              model: s.model,
              // modelId catalog wave: surfaced on the proposal card so a
              // future per-step model picker there can display/edit the
              // exact id — see OrchestratorPlanStepInput.modelId's doc
              // comment (types.ts) for the end-to-end wiring status.
              modelId: s.modelId,
              dependsOn: s.dependsOn,
              contestN: s.contestN,
              role: s.role,
              onFail: s.onFail,
              maxAttempts: s.maxAttempts,
              joinGroup: s.joinGroup,
              // Out-of-scope-at-proposal-time fix — see
              // proposal.steps[].extraReadableProjectIds's own doc comment
              // (types.ts). Forwarded verbatim from the raw plan step;
              // never fabricated when the manager left it unset.
              extraReadableProjectIds: s.extraReadableProjectIds,
              // Pre-launch cap-vs-estimate warning (2026-08-19 incident fix)
              // — see proposal.steps[].budgetCapUsd's own doc comment
              // (types.ts). Both values come from the SAME per-step inputs
              // (`s`, the raw OrchestratorPlanStepInput) `estimatedCostUsd`/
              // `estimatedCreditsByModel` below already derive from — never
              // a second, independently-computed estimate.
              budgetCapUsd: s.budgetCapUsd,
              estimatedCostUsd: estimatePlanStepCostUsd(s),
            })),
            // P2d: Estimate cost/duration from step count + model tiers + effort
            // (Mission B, "draw before you build" — the estimate shown on the
            // proposal card must reflect a step's real reasoning depth, not
            // just its tier — see estimatePlanStepCostUsd/estimatePlanStepDurationMs's
            // own doc comment, managerEngine.ts, for the full formula).
            estimatedCostUsd: (generatePlanAction.steps ?? []).reduce(
              (sum, s) => sum + estimatePlanStepCostUsd(s),
              0,
            ),
            estimatedDurationMs: (generatePlanAction.steps ?? []).reduce(
              (sum, s) => sum + estimatePlanStepDurationMs(s),
              0,
            ),
            // Item 7 fix (real user QA, 2026-08-01): the proposal card used
            // to show `estimatedCostUsd` as a bare dollar figure regardless
            // of engine — wrong when the run goes through a CLI
            // subscription (Claude/Codex, no credits ever charged) and
            // wrong in spirit even on managed/Pro (owner's standing rule:
            // credits per model, never a raw $ amount). Grouped by the
            // SAME `model` string each step already carries (falls back to
            // 'haiku' — the SAME default `estimatePlanStepCostUsd`'s own
            // `planStepTier` silently applies for an unset step.model, so
            // this breakdown's keys always match what was actually costed),
            // credits computed with the EXACT SAME cents-per-dollar
            // convention `approxCreditsUsed` above already uses — never a
            // second, independent conversion. Undefined for a zero-step
            // plan (GraphProposalCard falls back to estimatedCostUsd's own
            // total in that case).
            estimatedCreditsByModel: (generatePlanAction.steps ?? []).length > 0
              ? (generatePlanAction.steps ?? []).reduce<Record<string, number>>((byModel, s) => {
                  const label = s.model ?? 'haiku';
                  byModel[label] = (byModel[label] ?? 0) + Math.round(estimatePlanStepCostUsd(s) * 100);
                  return byModel;
                }, {})
              : undefined,
            deferredActions: deferredActions.length > 0 ? deferredActions : undefined,
            // PERSISTED-INDEX DEADLOCK FIX — see deferredActionEntries's own
            // doc comment just above for why this parallel index array
            // exists at all (a plain number, unlike object identity,
            // survives the JSON round-trip managerPersistence.ts puts every
            // message through).
            deferredActionIndexes: deferredActionIndexes.length > 0 ? deferredActionIndexes : undefined,
            citedLessonIds: generatePlanAction.citedLessonIds,
          },
        } : {}),
        // Mission Charter proposal card (§1) — the store's REAL counterpart
        // to `proposal` above. Previously MISSING entirely: propose_mission_charter
        // reached this point validated and even had a dedicated no-op executor
        // case, but nothing ever surfaced it to the UI, so MissionCharterCard
        // (which only renders from this field) could never appear from a real
        // manager turn. Echoes the action's fields verbatim — same field
        // names the prompt documents and the card renders, never a
        // reshaped/renamed copy.
        ...(charterAction ? {
          charterProposal: {
            state: 'pending' as const,
            charterId: charterAction.charterId,
            charter: {
              objective: charterAction.objective,
              nature: charterAction.nature,
              decisions: charterAction.decisions,
              validationGates: charterAction.validationGates,
              learning: charterAction.learning,
            },
          },
        } : {}),
        // Visible-artifact proposal card (real founder feedback: "comment tu
        // me montres les designs proposes ?") — the store's REAL counterpart
        // to `charterProposal` above: ArtifactProposalCard.tsx only renders
        // from this field. Echoes the action's fields verbatim (same field
        // names the prompt documents and the card renders, never a
        // reshaped/renamed copy) — `state`/`selectedVariantId` reflect
        // whether THIS action already carried a resolution (a re-proposal
        // with `selectedVariantId` set) or is still a fresh, pending ask.
        ...(artifactAction ? {
          artifactProposal: {
            state: artifactAction.selectedVariantId ? ('accepted' as const) : ('pending' as const),
            artifactId: artifactAction.artifactId,
            name: artifactAction.name,
            version: artifactAction.version,
            variants: artifactAction.variants,
            selectedVariantId: artifactAction.selectedVariantId,
          },
        } : {}),
      };
      // Honest failure (R2a fix, thread 1b): the grounded round-trip errored
      // or timed out — surface a SECOND, visible message instead of quietly
      // keeping only the first turn's un-grounded text with no explanation.
      // P0-1 fix (item #2): a Stop click during grounding reads as
      // "Interrompu" (checked first, same precedence as the outer catch
      // below); a genuine per-call/global-cap timeout reads as the same
      // phase+elapsed-aware turnTimeout message the main call's own timeout
      // uses (phase = "search" this time); anything else keeps the existing
      // raw groundedFailure line.
      const newMessages: ManagerMessage[] = grounded.failureReason
        ? [assistantMsg, {
            id: createMessageId(),
            role: 'assistant',
            content: managerStoppedRef.current.get(conversationId)
              ? t('cockpit.manager.interrupted')
              : grounded.failureIsTimeout
                // C3 fix: distinct wording for "no fragment at all for N
                // seconds" (inactivity) vs "hit the generous hard ceiling
                // despite ongoing activity" (absolute) — see
                // GroundedFollowUpResult.failureTimeoutReason's doc comment.
                ? t(
                    grounded.failureTimeoutReason === 'absolute'
                      ? 'cockpit.manager.turnTimeoutAbsolute'
                      : 'cockpit.manager.turnTimeout',
                    {
                      phase: t('cockpit.manager.phaseGrounding'),
                      elapsed: Math.max(1, Math.round((grounded.failureElapsedMs ?? 0) / 1000)),
                    },
                  )
                : t('cockpit.manager.groundedFailure', { reason: grounded.failureReason }),
            timestamp: new Date().toISOString(),
          }]
        : [assistantMsg];

      if ((managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
        replaceStreamDraft(newMessages);
      }

      // Execute actions returned by the manager, IN ORDER — required so a
      // later action can resolve an intra-turn alias (W6d) an earlier
      // create_draft in this SAME reply just registered. One fresh aliasMap
      // per reply (spans BOTH turn-1 and turn-2 actions — R4b fix — so a
      // turn-2-only alias, e.g. a draft turn-2 itself just created, resolves
      // for a LATER turn-2 action referencing it), never reused across
      // separate sendManagerMessage exchanges.
      //
      // Each action is dispatched in its own try/catch (R4b fix, deliverable
      // #2): an unrecognized action type (executeManagerAction's exhaustive
      // switch throws in its `default` case for anything outside the known
      // ManagerAction union — parseManagerActions only validates `type` is a
      // string, never that it is a KNOWN one) or any other executor throw
      // used to either silently no-op or crash the whole loop, aborting every
      // action still queued after it. Now every failure surfaces as an
      // honest, visible manager-rail message and the loop keeps going.
      const aliasMap = new Map<string, string>();
      const actionFailures: string[] = [];
      const actionStatuses: ActionStatus[] = [];
      // P0-3 fix: grounded REAL outcome of each executed cleanup/bulk action
      // (delete_mission, clear_canvas, archive_terminated — see
      // ManagerActionRealResult's doc comment), sourced ONLY from
      // executeManagerAction's own return value — NEVER from the model's own
      // narration. Appended to the transcript below, in the SAME order the
      // actions executed, so the chat always ends with what really happened
      // regardless of whether the model's own prose happened to agree.
      const realResults: string[] = [];
      const actionRefs: (string | undefined)[] = [];
      let proposalPlanId: string | undefined;
      // NO-PLANID PROPOSAL FIX (real user repro: a `pending` proposal card
      // with NO planId at all, "Valider & lancer" clicking silently doing
      // nothing — three clicks, zero effect, zero toast/journal entry): the
      // `assistantMsg.proposal` object above is built unconditionally the
      // instant `generatePlanAction` exists in `actionsToExecute` (state:
      // 'pending', real steps, an estimate — everything BUT `planId`, which
      // this loop can only learn once the `generate_plan` action itself has
      // actually run). Four distinct, real paths let that action finish
      // this loop with NO `proposalPlanId` ever assigned even though it
      // never threw: the gate denies it (an autonomy `deniedActions` entry),
      // the gate asks for it (manual mode — `computeGateDecision` gates
      // EVERY action, including this SAFE one, before the tier check even
      // runs), its own executor case returns a NON-throwing
      // `{ failed: true, message }` (e.g. `action.projectId` names a project
      // that is not open), or `createOrchestrator` throws. Every one of
      // those is captured here, keyed to the SAME `generatePlanAction`
      // object instance the loop already isolated above (safe: this is
      // still the SAME in-memory turn, no persistence round-trip has
      // happened yet), so the message the proposal is patched with below is
      // never a generic guess — see each capture site's own comment.
      let generatePlanFailureReason: string | undefined;
      for (const action of actionsToExecute) {
        // Proposal gating: skip mutative actions when a plan proposal OR a
        // mission charter is pending — they'll execute on validate
        // (execute_plan / the manager's next turn once the charter is
        // confirmed) or never, on reject. Safe/read-only actions still run.
        // (The charter action itself is in PROPOSAL_SAFE_ACTIONS, so it
        // still reaches its own no-op executor case below.)
        //
        // CONSENT-BYPASS FIX: this used to push `true` unconditionally — a
        // deferred action read as a completed SUCCESS in the chip row even
        // though it was never executed NOR ever sent through
        // evaluateActionGate (see PROPOSAL_SAFE_ACTIONS's own doc comment;
        // `create_project` is `sensitive` — actionClassifier.ts — and its
        // own comment says the manager must always ask before creating a
        // directory, a guarantee this silently defeated). Only the
        // `isProposalPending` case (a `generate_plan` this same turn) is
        // recorded on `proposal.deferredActions` and later gated for real by
        // executePlan's replay loop — that path now pushes the honest
        // `'deferred'` status (ActionStatus, types.ts), distinct from both
        // `true` and `false`, so the chip never claims a success that has
        // not happened yet. A charter-only turn (isCharterPending true,
        // isProposalPending false) has NO replay mechanism at all — nothing
        // ever re-executes these actions (a validated charter produces a
        // brand new manager turn instead, see charterAction's own doc
        // comment above) — that gap predates this fix and is left
        // unchanged/untouched here, `true` still stamped for that case
        // rather than a `'deferred'` label promising a replay that will
        // never happen.
        if ((isProposalPending || isCharterPending) && !PROPOSAL_SAFE_ACTIONS.has(action.type)) {
          actionStatuses.push(isProposalPending ? 'deferred' : true);
          actionRefs.push(undefined);
          continue;
        }
        try {
          // Universal action gating — every action passes through
          // evaluateActionGate before execution. Safe actions auto-allow;
          // sensitive/destructive actions ask or deny per the REAL autonomy
          // mode the user selected (state.autonomyLevel — previously this
          // read getEffectiveAutonomy() with no config, which silently fell
          // back to DEFAULT_AUTONOMY.mode === 'supervised' no matter what
          // the selector showed). `payload: action` lets classifyAction
          // resolve field-dependent tiers (clear_canvas's `mode`/
          // `includeReview` — see actionClassifier.ts's own doc comment).
          const gate = await evaluateActionGate(
            action.type,
            getEffectiveAutonomy({ mode: stateRef.current.autonomyLevel }),
            { turnId: String(myGeneration), payload: action as unknown as Record<string, unknown> },
          );
          if (gate.decision === 'deny') {
            actionStatuses.push(false);
            actionRefs.push(undefined);
            const deniedReason = t('agents.manager.actionDenied', { type: action.type, reason: gate.reason.slice(0, 160) });
            actionFailures.push(deniedReason);
            toast(deniedReason, 'error');
            // NO-PLANID PROPOSAL FIX, capture site 1/4 — a denied
            // generate_plan (e.g. an autonomy `deniedActions` list) never
            // reaches `executeManagerAction`, so `proposalPlanId` stays
            // unset; the reason is already in `actionFailures` (surfaced to
            // the user AND the manager via the transcript below) — reused
            // verbatim so the proposal card never invents a second story.
            if (action === generatePlanAction) generatePlanFailureReason = deniedReason;
            continue;
          }
          if (gate.decision === 'ask') {
            // Refuse-at-source fix (2026-08-02, "M9/M10 dead-end approval"
            // incident — see retryBaseBranchGuard.ts's own module doc
            // comment for the full story): a retry_mission action whose
            // requested baseBranch differs from the mission's own is
            // GUARANTEED to be refused by retryMission's own guard the
            // instant anyone clicks Approve — no real retry ever happens.
            // Queuing it anyway used to offer Approve, let the user click
            // it, and only THEN reveal the refusal, leaving a permanent
            // Reject-only dead end (retry_mission failures never set
            // `canForce`, unlike approve_mission, so PendingApprovalCard has
            // no recovery button once that failure lands — see that file's
            // own `canForce` computation). Checked here, BEFORE ever
            // queuing, with the EXACT same rule retryMission itself
            // enforces (isRetryBaseBranchChangeBlocked) — refused
            // immediately, same treatment as an autonomy `deny` above,
            // never offered as a doomed approval in the first place.
            if (action.type === 'retry_mission') {
              const retryTarget = stateRef.current.missions.find((m) => m.id === action.missionId);
              const requestedBaseBranch = extractRequestedRetryBaseBranch(action);
              if (retryTarget && isRetryBaseBranchChangeBlocked(retryTarget.baseBranch, requestedBaseBranch)) {
                const reason = t('agents.manager.retryBaseBranchRefused', {
                  id: action.missionId,
                  requested: requestedBaseBranch as string,
                });
                actionStatuses.push(false);
                actionRefs.push(undefined);
                actionFailures.push(reason);
                toast(reason, 'error');
                continue;
              }
            }
            // BOUNDED-RETRY fix (real user report, 2026-08-14 — "M4/M5 zombie
            // approval loop" incident): an approve_mission with an
            // UNRESOLVED entry ALREADY queued for the same missionId — still
            // awaiting a human decision, or already recorded as blocked via
            // `lastFailure` (see approvePendingAction's own honesty fix) —
            // must never get a SECOND, independent pendingApprovals entry.
            // Before this fix, every manager turn that re-proposed
            // approve_mission for a mission still stuck in review (the
            // common case right after a real merge failure — the manager
            // sees the mission is still not merged and tries again) queued
            // ANOTHER row: the bar's count grew without bound
            // ("2 actions en attente d'approbation" that "Tout approuver"
            // could never fully clear — each click only ever resolves ONE of
            // the duplicates, immediately followed by the SAME
            // `mission.approve_blocked` journal entry from the other,
            // flooding the activity feed with repeated "merge bloqué"
            // lines). Refused at the source instead — same treatment as an
            // autonomy `deny` and the retry_mission check just above: never
            // offer a duplicate approval, point back at the existing one
            // (its own reason, if it already failed once) so the user acts
            // on ONE actionable row instead of an ever-growing pile.
            if (action.type === 'approve_mission') {
              const existing = (stateRef.current.conversations[conversationId]?.pendingApprovals ?? [])
                .find((p) => p.action.type === 'approve_mission' && p.action.missionId === action.missionId);
              if (existing) {
                const reason = t('agents.manager.approveMissionAlreadyQueued', {
                  id: action.missionId,
                  reasonSuffix: wakeupReasonSuffix(existing.lastFailure?.reason),
                });
                actionStatuses.push(false);
                actionRefs.push(undefined);
                actionFailures.push(reason);
                toast(reason, 'error');
                continue;
              }
            }
            // Gate-usability fix: the action is no longer discarded here —
            // it is queued as a pending approval (see PendingApprovalAction's
            // doc comment) so the user can execute it later, unmodified, via
            // approvePendingAction/approveAllPendingActions, instead of being
            // silently lost with no recourse (the previous behaviour this
            // comment used to describe as "intentionally conservative").
            const pending: PendingApprovalAction = {
              id: createMessageId(),
              action,
              label: describePendingAction(action, t),
              turnId: String(myGeneration),
              messageId: assistantMsg.id,
              actionIndex: actionStatuses.length,
              model,
              aliasMap,
              createdAt: new Date().toISOString(),
            };
            if ((managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
              setState((prev) => withConversation(prev, conversationId, (conv) => ({ pendingApprovals: [...conv.pendingApprovals, pending] })));
            }
            actionStatuses.push(false);
            actionRefs.push(undefined);
            // Real-user feedback 2026-08-03: NO redundant system message
            // ("L'action X nécessite une approbation") is appended to the
            // transcript under the approval card — the card itself IS the
            // request, and the persistent Accept/Reject bar above the chat
            // (LazyManager.tsx) shows the count. Only the transient toast
            // remains, so the transcript stays clean.
            toast(t('agents.manager.actionNeedsApproval', { type: action.type }), 'warning');
            // NO-PLANID PROPOSAL FIX, capture site 2/4 — reachable for
            // generate_plan itself in 'manual' autonomy mode (or any
            // deniedActions/allowedActions restriction gone through 'ask'):
            // `computeGateDecision` (actionGate.ts) gates EVERY action in
            // manual mode before the safe/sensitive tier check even runs,
            // so this SAFE action can still land here. No transcript
            // message for this branch by the standing rule just above, so
            // this is the ONLY place the reason survives to reach the
            // proposal card.
            if (action === generatePlanAction) {
              generatePlanFailureReason = t('agents.manager.actionNeedsApproval', { type: action.type });
            }
            continue;
          }
          const outcome = await executeManagerActionRef.current(action, model, aliasMap, conversationId, userMsg.content);
          if (!outcome || !('failed' in outcome && outcome.failed)) {
            noteManagerDecision(action.type, userMsg.content.slice(0, 200), 'success');
          }
          actionStatuses.push(true);
          actionRefs.push(outcome && 'patchedRef' in outcome ? outcome.patchedRef : undefined);
          if (outcome) {
            if (outcome.message) realResults.push(outcome.message);
            if (outcome.planId) proposalPlanId = outcome.planId;
          }
          // NO-PLANID PROPOSAL FIX, capture site 3/4 — a non-throwing
          // `{ failed: true, message }` outcome (ManagerActionRealResult.failed,
          // e.g. generate_plan's own `action.projectId` naming a project
          // that is not open — see that case's own `targetResolution.unresolvedName`
          // branch). `outcome.message` already lands in `realResults` above
          // (still surfaced in the transcript, hence still reaching the
          // user AND the manager's own next-turn context) — this only ALSO
          // threads the exact same string onto the proposal card so it does
          // not read as launchable. Deliberately narrow (generate_plan only,
          // never touching `actionStatuses`/`realResults` for any other
          // action type) — the broader "a failed-but-non-throwing outcome
          // is still recorded as actionStatuses=true for every action type"
          // gap is real but pre-existing and out of scope here.
          if (action === generatePlanAction && outcome && 'failed' in outcome && outcome.failed) {
            generatePlanFailureReason = outcome.message ?? generatePlanFailureReason;
          }
        } catch (actionErr) {
          actionStatuses.push(false);
          actionRefs.push(undefined);
          const reason = actionErr instanceof Error ? actionErr.message : String(actionErr);
          const failureMsg = t('agents.manager.actionFailed', { type: action.type, reason: reason.slice(0, 160) });
          actionFailures.push(failureMsg);
          // NO-PLANID PROPOSAL FIX, capture site 4/4 — createOrchestrator
          // (or anything else generate_plan's executor case calls) threw.
          // Same transcript message reused, same reasoning as capture site 1.
          if (action === generatePlanAction) generatePlanFailureReason = failureMsg;
        }
      }
      // YOLO: create_draft is SAFE (auto-runs) but launch_draft is SENSITIVE
      // and the model often omits it — drafts then sit on "Waiting" forever.
      // Launch chain ROOTS only; downstream drafts fire via chainEngine.
      if (stateRef.current.autonomyLevel === 'yolo' && !isProposalPending) {
        const created = draftIdsFromAliasMap(aliasMap);
        const { drafts, chains } = canvasStoreVanilla.getState();
        const live = created.filter((id) => drafts.some((d) => d.id === id));
        const roots = rootDraftIdsToLaunch(live, chains);
        if (roots.length > 0) {
          const activeProjectId = projectIdFromRoot(await resolveProjectRoot().catch(() => '.'));
          for (const draftId of roots) {
            try {
              const launched = await launchDraft(draftId, { addMission, activeProjectId });
              if (launched.ok) {
                realResults.push(`YOLO launch ${draftId} → ${launched.missionId}`);
              } else {
                toast(t(launched.reasonKey), 'error');
              }
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              toast(reason.slice(0, 160), 'error');
            }
          }
        }
      }
      // Patch the planId onto the proposal if generate_plan executed
      if (isProposalPending && proposalPlanId && (managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
        setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
          m.id === assistantMsg.id && m.proposal
            ? { ...m, proposal: { ...m.proposal, planId: proposalPlanId } }
            : m,
        ));
        // Supersession fix (canvas accumulation root cause — see
        // canvasStore.ts's addProposalPreview doc comment: every
        // generate_plan appends a FULL preview graph and nothing ever
        // removed a superseded one, so an evening of "propose a plan, ask
        // for a different one" left 5 un-launched previews / 49 nodes
        // stacked on the SAME canvas — exactly what read as "the graph got
        // duplicated"). Scoped PER CONVERSATION only, never global: with
        // multi-conversation now shipped, two conversations legitimately
        // hold two live proposals at once and must never touch each other's.
        // Semantics chosen: silent auto-reject, not "keep both, mark
        // stale" — a fresh generate_plan in the SAME conversation IS the
        // user's answer to "what do you want instead" (the same way asking
        // a person a new question retracts the old one); a "keep several,
        // pick later" flow would need real list UI that does not exist
        // today, and would not even address the litter problem. Reuses the
        // EXACT same primitive the "Rejeter" button already calls
        // (canvasStore's rejectProposedPlan) plus a best-effort orchestrator
        // delete under ITS OWN root (resolveOrchestratorRoot — a superseded
        // plan may target a different project than the new one), so a
        // superseded proposal disappears from the canvas IDENTICALLY to a
        // manual reject, never a second/divergent cleanup path. Excludes
        // THIS message by id (not by planId): at this point the just-
        // appended assistantMsg is itself still 'pending' and only just
        // received its own planId above, so an id-only comparison avoids
        // ever superseding itself.
        try {
          const priorPending = (stateRef.current.conversations[conversationId]?.messages ?? []).filter(
            (m) => m.id !== assistantMsg.id && m.proposal?.state === 'pending' && !!m.proposal.planId,
          );
          if (priorPending.length > 0) {
            for (const priorMsg of priorPending) {
              const oldPlanId = priorMsg.proposal!.planId!;
              canvasStoreVanilla.getState().rejectProposedPlan(oldPlanId);
              const oldPlanRoot = await resolveOrchestratorRoot(oldPlanId);
              await deleteOrchestrator(oldPlanRoot, oldPlanId).catch(() => {});
            }
            const supersededIds = new Set(priorPending.map((m) => m.id));
            setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
              supersededIds.has(m.id) && m.proposal
                ? { ...m, proposal: { ...m.proposal, state: 'rejected' as const } }
                : m,
            ));
          }
        } catch (err) {
          // Best-effort — never block the new proposal's own preview below.
          const reason = err instanceof Error ? err.message : String(err);
          toast(`Could not clean up a superseded plan: ${reason.slice(0, 100)}`, 'error');
        }
        // Chantier 3 (plan-first canvas) — the plan must be VISIBLE on the
        // canvas the moment it's proposed, not only after the user
        // validates it (GraphProposalCard's own mini-DAG never left the
        // chat bubble — the founder's own complaint: "un autre jeu de
        // noeuds apparait a cote"). Compiles the just-created orchestrator
        // (real step ids, real dependsOn/joinGroup structure — the SAME
        // compileOrchestratorToIr/irToCanvas pipeline executePlan's own
        // materialization step already used) and stamps every primitive
        // `proposedPlanId` (irToProposedCanvas) so it renders dashed
        // (DraftNode/ChainEdge/JoinNode) instead of a normal active node.
        // Never launches anything — addProposalPreview is a pure canvas
        // append, same as instantiateMacroResult.
        try {
          // resolveOrchestratorRoot — see execute_plan's own doc comment on
          // this helper (the orchestrator this SAME turn's generate_plan just
          // created may live under a non-active project's root now).
          const previewProjectRoot = await resolveOrchestratorRoot(proposalPlanId);
          const previewOrch = await getOrchestrator(previewProjectRoot, proposalPlanId);
          if (previewOrch && previewOrch.steps.length > 0) {
            setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
              m.id === assistantMsg.id && m.proposal?.planId === proposalPlanId
                ? {
                    ...m,
                    proposal: {
                      ...m.proposal,
                      // Out-of-scope-at-proposal-time fix — see
                      // proposal.targetProjectRoot's own doc comment
                      // (types.ts): the FIRST point this plan's real target
                      // root is known, reused verbatim rather than a second
                      // resolution the card would have to duplicate.
                      targetProjectRoot: previewProjectRoot,
                      steps: previewOrch.steps.map((step) => ({
                        id: step.id,
                        description: step.description,
                        agentName: step.agentName,
                        model: step.model,
                        modelId: step.modelId,
                        dependsOn: step.dependsOn,
                        contestN: step.contestN,
                        role: step.role,
                        onFail: step.onFail,
                        maxAttempts: step.maxAttempts,
                        joinGroup: step.joinGroup,
                        extraReadableProjectIds: step.extraReadableProjectIds,
                      })),
                    },
                  }
                : m,
            ));
            const ir = compileOrchestratorToIr(previewOrch);
            const preview = irToProposedCanvas(ir, proposalPlanId);
            // ZONE-SAFE PLACEMENT (fix/canvas-node-layout, defect: a plan's
            // fan-in convergence node rendered inside a DIFFERENT project's
            // zone). This used to reuse the in-chat preview's OWN standalone
            // elkjs layout (`layoutPreviewGraph` — zero zone awareness, its
            // own top-left rooted whichever way elkjs's algorithm happened
            // to lay its first node) and write those raw coordinates
            // directly as this turn's zone-relative draft/join positions,
            // relying on a follow-up `'canvas:arrange'` bus event to
            // correct them — but that event races CanvasView's own render
            // cycle (`useCanvasManagerEvents.ts`'s `paramsRef` only
            // refreshes via a passive `useEffect`, which cannot have run
            // yet for a `'canvas:arrange'` emitted synchronously, in the
            // SAME turn, right after `addProposalPreview`) and ALWAYS loses
            // for nodes THIS turn just created — leaving the raw,
            // zone-unconfined coordinate as their PERMANENT position
            // (`reconcilerZones.ts`'s `assignChildPositions` never revisits
            // an existing `positions` entry). `layoutDraftGraphInZone`
            // (layout.ts) replaces this: it computes real, zone-CONFINED
            // positions synchronously in this same call (the exact ELK core
            // `layoutZone` itself uses for a zone's existing children, real
            // canvas card sizes, no dependency on any later render or bus
            // event) — see its own doc comment for the full mechanism.
            try {
              const zoneGraphNodes: DraftGraphNode[] = ir.nodes.map((node) => ({
                id: node.id,
                ...(node.kind === 'join' ? JOIN_NODE_SIZE : DEFAULT_NODE_SIZE.draft),
              }));
              const zoneGraphEdges: DraftGraphEdge[] = ir.edges
                .filter((edge) => edge.kind === 'control')
                .map((edge) => ({ id: edge.id, source: edge.from, target: edge.to }));
              const zoneLayout = await layoutDraftGraphInZone(zoneGraphNodes, zoneGraphEdges);
              const previewPositions: Record<NodeRef, { x: number; y: number }> = {};
              for (const [nodeId, pos] of Object.entries(zoneLayout.positions)) {
                const ref = nodeId.startsWith('join:') ? makeRef('join', nodeId.slice('join:'.length)) : makeRef('draft', nodeId);
                previewPositions[ref] = { x: pos.x, y: pos.y };
              }
              if (Object.keys(previewPositions).length > 0) {
                canvasStoreVanilla.getState().setPositions(previewPositions);
              }
            } catch {
              // Layout best-effort — a failure falls back to the previous
              // auto-arrange behavior below rather than blocking the preview.
            }
            canvasStoreVanilla.getState().addProposalPreview(preview);
            // 2026-08-04 (UC3 dogfood — the whole preview landed in the ACTIVE
            // project's zone instead of the plan's own target): the compile
            // stamps drafts with the orchestrator's projectId, but a plan
            // created while another project was active can carry a stale
            // projectId from createOrchestrator's resolution. Re-tag the
            // preview onto the plan's REAL root (resolveOrchestratorRoot —
            // the same authority execute_plan uses) so the proposed graph
            // renders in the project it will actually execute in, not the
            // one that happened to be active when it was drawn.
            if (previewProjectRoot) {
              canvasStoreVanilla.getState().retagProposedPlanProject(proposalPlanId, projectIdFromRoot(previewProjectRoot));
            }
            const previewRefs = [
              ...preview.drafts.map((d) => makeRef('draft', d.id)),
              ...preview.joins.map((j) => makeRef('join', j.id)),
            ];
            if (previewRefs.length > 0) {
              emit('canvas:arrange', { mode: 'auto' });
              emit('canvas:highlight', { refs: previewRefs });
              emit('canvas:focus', { ref: previewRefs[0] });
            }
          }
        } catch (err) {
          // Best-effort preview — a failure here must never block the
          // manager turn itself (the proposal card in chat still works).
          const reason = err instanceof Error ? err.message : String(err);
          toast(`Plan preview failed: ${reason.slice(0, 100)}`, 'error');
        }
      } else if (isProposalPending && !proposalPlanId && (managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
        // NO-PLANID PROPOSAL FIX — closes the gap the four capture sites
        // above exist for: `generate_plan` never produced a real
        // orchestrator id (denied, asked-for-approval, a non-throwing
        // `{ failed: true }` outcome, or a thrown exception), so this
        // message's own `proposal` (built unconditionally above, the moment
        // `generatePlanAction` existed in this turn's actions — see that
        // construction's own comment) would otherwise sit there forever as
        // `state: 'pending'` with NO `planId` and NO explanation: exactly
        // the defect this fix closes (a proposal card whose "Valider &
        // lancer" reports `disabled: false`, accepts clicks, and does
        // NOTHING — `onAccept` is itself guarded by `if (proposal.planId)`,
        // GraphProposalCard.tsx). Patched with `errorMessage` instead —
        // GraphProposalCard's own honesty rule (B3 fix, same file) already
        // renders any set `errorMessage` as a persistent visible banner, and
        // the card's Validate control is now ALSO structurally disabled
        // whenever `planId` is absent (GraphProposalCard's own "a proposal
        // that cannot be validated must never render an enabled control"
        // fix) — so even the one case this branch itself does not cover
        // (`myGeneration` raced past by a newer turn — the guard above
        // intentionally never mutates a superseded message's state, same
        // convention as every other generation check in this function)
        // still never shows a lying, clickable-but-inert button; it only
        // loses the specific "why" text for that narrow race window.
        const reason = generatePlanFailureReason
          ?? 'Plan could not be created — no reason was recorded for this attempt. Try again or rephrase your request.';
        setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
          m.id === assistantMsg.id && m.proposal
            ? { ...m, proposal: { ...m.proposal, errorMessage: reason } }
            : m,
        ));
      }
      // P1 fix: store per-action statuses on the assistant message so
      // ActionBadge can render failed actions with a distinct style.
      if ((managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration && actionStatuses.length > 0) {
        setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
          m.id === assistantMsg.id
            ? { ...m, actionStatuses, actionRefs }
            : m,
        ));
      }
      if (actionFailures.length > 0) {
        const failureMsgs: ManagerMessage[] = actionFailures.map((content) => ({
          id: createMessageId(),
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        }));
        if ((managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
          setState((prev) => appendConversationMessages(prev, conversationId, failureMsgs));
        }
      }
      // P0-3 fix: the chat transcript must reflect what REALLY happened for
      // a cleanup/bulk action (delete_mission, clear_canvas,
      // archive_terminated) — never rely on the model's own free-form prose
      // count, which has been proven live to diverge completely from
      // reality ("17 missions supprimées" narrated while exactly ONE
      // vanished). Always appended, regardless of whether the model's own
      // narration happened to be accurate this time, so the truth is never
      // conditional on the model's honesty.
      if (realResults.length > 0) {
        const realResultMsgs: ManagerMessage[] = realResults.map((result) => ({
          id: createMessageId(),
          role: 'assistant',
          content: t('agents.manager.realResult', { result }),
          // 2026-08-06 (founder, verbatim: "je veux pas voir ce texte Résultat
          // réel : …") — real-result reports are addressed to the MANAGER's
          // context (the LLM reads them back from the conversation store),
          // not to the human. `displayContent: ''` is the existing
          // content-vs-display seam (see ManagerMessage.displayContent's own
          // doc comment): the model still receives the full line, the chat
          // UI renders nothing for it (LazyManagerMessageList).
          displayContent: '',
          timestamp: new Date().toISOString(),
        }));
        if ((managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
          setState((prev) => appendConversationMessages(prev, conversationId, realResultMsgs));
        }
      }
    } catch (err) {
      // W-MGRCREDITS fix: distinguish OUR hard ceiling firing from any other
      // thrown error, so a genuine timeout gets an honest, distinct message
      // plus a real "Réessayer" recovery action instead of a generic error
      // line with no way back.
      //
      // P0-1 fix: this catch is only ever reached for a MAIN-call failure —
      // runGroundedFollowUp never throws (its own try/catch always resolves
      // to a value, surfaced as the second message above) — so `isTimeout`
      // reads mainCall's OWN child signal (set by EITHER its 300s per-call
      // budget or turnCtrl's Stop/global-cap propagating down to it), not
      // turnCtrl directly. `mainCall` can be undefined if the throw happened
      // before the main call was even reached (e.g. an unexpected bug in
      // context gathering above) — `?? false` keeps that case an honest
      // generic error rather than a false "timeout".
      //
      // W-STOPLLM fix: a user-initiated Stop click also aborts turnCtrl
      // (stopManagerMessage below reuses it, cascading into mainCall's child
      // signal), so signal.aborted alone can no longer tell "a budget fired"
      // apart from "the user clicked Stop". managerStoppedRef (set by
      // stopManagerMessage just before it calls .abort()) resolves the
      // ambiguity; checked FIRST so a Stop click always renders as
      // user-interrupted even if it happened to land in the same tick a
      // budget would have fired anyway.
      const wasStopped = managerStoppedRef.current.get(conversationId) ?? false;
      const isTimeout = !wasStopped && (mainCall?.signal.aborted ?? false);
      // C3 fix: distinct wording for "no fragment at all for N seconds"
      // (inactivity) vs "hit the generous hard ceiling despite ongoing
      // activity" (absolute) — see ManagerCallController.getTimeoutReason's
      // doc comment. undefined (parent Stop/global-cap, not this call's own
      // deadline, or mainCall never created) falls back to the existing
      // "no response" wording.
      const timeoutKey =
        mainCall?.getTimeoutReason() === 'absolute'
          ? 'cockpit.manager.turnTimeoutAbsolute'
          : 'cockpit.manager.turnTimeout';
      const errorMsg: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: wasStopped
          ? t('cockpit.manager.interrupted')
          : isTimeout
            ? t(timeoutKey, {
                phase: t('cockpit.manager.phaseGeneration'),
                elapsed: Math.max(1, Math.round(mainCallElapsedMs / 1000)),
              })
            // Bare `.slice(0, 120)` used to cut this mid-word with no
            // visible marker at all (real repro: a DeepSeek-rail rejection
            // message ending "...you may n"). Reuses THIS FILE's own
            // truncateLabel (above, word-boundary-aware + always-ellipsis —
            // the same fix already applied to pendingAction labels for the
            // identical class of bug, 2026-08-01 QA) rather than adding a
            // THIRD truncation helper; not lazyManager/truncateLabel.ts's
            // export of the same name, which would collide with this one.
            : t('agents.manager.error', { msg: truncateLabel(formatManagerUserError(err), MANAGER_ERROR_MAX_CHARS) }),
        timestamp: new Date().toISOString(),
        // Same "Réessayer" card for both (existing timedOut/interrupted
        // style, per the mission) — only the copy above distinguishes why.
        timedOut: isTimeout || wasStopped,
        retryText: (isTimeout || wasStopped) ? text : undefined,
      };
      if ((managerGenerationRef.current.get(conversationId) ?? 0) === myGeneration) {
        replaceStreamDraft([errorMsg]);
      }
    } finally {
      clearTimeout(turnCapTimeout);
      clearInterval(elapsedTicker);
      managerAbortRef.current.set(conversationId, null);
      // Concurrency slot is released exactly once per acquire, regardless of
      // which branch above ran — mirrors the busy-state guarantee just below.
      releaseManagerTurnSlot();
      // Guaranteed exactly-once reset regardless of which branch above ran —
      // the B12 fix's core invariant: a manager turn always resolves the
      // busy state, success or honest error, never leaving the UI waiting.
      // phase/elapsedMs reset to idle/0 with it (same guarantee, R2a fix /
      // P0-1 fix), scoped to THIS conversation only — every other open
      // conversation's own busy/phase is untouched.
      setState((prev) => withConversation(prev, conversationId, { busy: false, phase: 'idle', elapsedMs: 0 }));
    }
  // No `state.*` dep: every store read inside goes through stateRef.current
  // (see the liveState comment near gatherManagerContext above), so the
  // callback no longer needs to be rebuilt on each missions/conversations
  // mutation — which also shrinks the window in which sendManagerMessageRef
  // can lag behind.
  }, [executeManagerAction, acquireManagerTurnSlot, releaseManagerTurnSlot, addMission, t, locale, isPro, subscription]);

  /** Stop button (LazyManagerRail's send/stop toggle, or Escape while
   *  busy) for ONE conversation — see managerAbortRef/managerStoppedRef's
   *  doc comments above for why both refs (not just an .abort() call) are
   *  needed. No-op if no turn is currently in flight on `conversationId` —
   *  never touches any OTHER conversation's turn. */
  const stopManagerMessage = useCallback((conversationId: string) => {
    const ctrl = managerAbortRef.current.get(conversationId);
    if (!ctrl) return;
    managerStoppedRef.current.set(conversationId, true);
    ctrl.abort();
  }, []);

  /**
   * Tab-strip close ("x" / Delete key on a focused tab). Closing is NOT
   * deleting: `id`'s own persisted session (`lazy.managerSessions`,
   * managerPersistence.ts) is left completely untouched — only removed from
   * the LIVE `conversations`/`conversationOrder` here, so it stays fully
   * reachable from the history drawer afterwards (loadManagerSession reopens
   * it as a live tab again, verbatim id, exactly like any other past
   * session — see that callback's own doc comment).
   *
   * BUSY SEMANTICS (decided, not left ambiguous — this file's own "NEVER
   * DEGRADE IN SILENCE" convention applies here too): a conversation with a
   * turn genuinely in flight is never silently discarded. Closing it first
   * calls stopManagerMessage (the SAME abort path the composer's own Stop
   * button uses) to genuinely cancel the in-flight call — chosen over
   * either (a) refusing the close, which would force switching to a
   * background tab just to hit Stop before being allowed to close it, or
   * (b) leaving the call running with nowhere for its result to land, which
   * this file's own "NEVER DEGRADE IN SILENCE" convention rules out anyway.
   * This mirrors closing a browser tab cancelling its own in-flight
   * requests. The "interrompu" bubble sendManagerMessage's own catch block
   * would normally append is written HERE instead, synchronously, before
   * `id` leaves `state.conversations` — not left to that catch block, which
   * only unwinds once the abort's rejection propagates asynchronously, by
   * which point `id` is already gone and `withConversation`'s own `!conv`
   * guard would silently swallow the append. Written straight to disk via
   * `saveManagerMessages` (bypassing the effect-based per-conversation
   * autosave, which only watches currently-OPEN conversations and will
   * never see this one again) so reopening this conversation from history
   * always shows an honest reason it stops where it does, never a dangling
   * question with no reply.
   *
   * Closing the ACTIVE tab activates a neighbour (whichever conversation
   * lands at the same index once `id` is removed, clamped to the new last
   * tab) — never leaves the panel pointed at a now-missing id. Closing the
   * LAST open conversation mints a fresh empty one in its place (same shape
   * every other "open a conversation" path starts from — emptyManagerConversation)
   * — never a dead, tab-less panel.
   */
  const closeManagerConversation = useCallback((id: string) => {
    const conv = stateRef.current.conversations[id];
    if (!conv) return;
    const wasBusy = conv.busy;
    if (wasBusy) {
      stopManagerMessage(id);
      const interrupted: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: t('cockpit.manager.interrupted'),
        timestamp: new Date().toISOString(),
        timedOut: true,
      };
      saveManagerMessages(id, [...conv.messages, interrupted], conv.pendingApprovals.map(toPersistedPendingApproval), conv.customTitle);
    }
    // Deterministic, zero-LLM conversation summary (see captureConversationSummary's
    // own doc comment) — fire-and-forget, silently a no-op when the conversation
    // has nothing worth remembering. `id` is the conversation's own stable session
    // id (ManagerConversationState.id), reused as CaptureEvent.stableId so
    // re-closing the same conversation later updates this note instead of
    // duplicating it.
    captureConversationSummary(id, conv.messages);
    setState((prev) => {
      if (!prev.conversations[id]) return prev;
      const remainingOrder = prev.conversationOrder.filter((cid) => cid !== id);
      const { [id]: _closed, ...restConversations } = prev.conversations;
      if (remainingOrder.length === 0) {
        const freshId = mintManagerSessionId();
        return {
          ...prev,
          conversations: { [freshId]: emptyManagerConversation(freshId) },
          conversationOrder: [freshId],
          activeConversationId: freshId,
        };
      }
      let activeConversationId = prev.activeConversationId;
      if (activeConversationId === id) {
        const closedIdx = prev.conversationOrder.indexOf(id);
        activeConversationId = remainingOrder[Math.min(closedIdx, remainingOrder.length - 1)]!;
      }
      return { ...prev, conversations: restConversations, conversationOrder: remainingOrder, activeConversationId };
    });
  }, [stopManagerMessage, t, saveManagerMessages]);

  /**
   * Tab-strip rename (double-click a tab, LazyManagerConversationTabs.tsx)
   * — a no-op if `id` isn't a currently open conversation. `title` is
   * trimmed here (the SAME trim conversationTabLabel.ts's own
   * ConversationTabSource.customTitle contract expects); an
   * empty/whitespace-only result clears the custom title back to
   * `undefined` rather than persisting a blank name, which lets a user
   * "un-rename" a conversation back to its derived first-message label by
   * clearing the rename input.
   *
   * Written straight to disk via `saveManagerMessages` (bypassing the
   * effect-based per-conversation autosave just above) for the same reason
   * closeManagerConversation's own interrupted-message save is: that
   * effect skips a conversation whose `messages`/`pendingApprovals`
   * references are unchanged (autosaveSeenRef's reference-equality skip,
   * load-bearing there to stop a busy conversation's per-second elapsed-
   * time ticker from rescheduling every sibling's debounce timer) — a
   * rename touches neither of those fields, so without this explicit call
   * it would never reach `lazy.managerSessions` at all, only live in
   * memory until the next unrelated message-driven autosave happened to
   * fire (or never, if the conversation stays quiet). A brand-new,
   * still-empty conversation (no messages yet) is the one case this can't
   * persist yet — `saveMessages`'s own no-op-on-empty guard — but the
   * live `customTitle` still applies to the tab immediately; the first
   * real message sent afterwards autosaves it normally.
   */
  const renameManagerConversation = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    setState((prev) => withConversation(prev, id, { customTitle: trimmed || undefined }));
    const conv = stateRef.current.conversations[id];
    if (conv) {
      saveManagerMessages(id, conv.messages, conv.pendingApprovals.map(toPersistedPendingApproval), trimmed || undefined);
    }
  }, [saveManagerMessages]);

  /** Clears the ACTIVE conversation's transcript in place — id unchanged,
   *  so its own persisted session (if any) keeps its history until the next
   *  autosave overwrites it with the now-empty transcript. No known real
   *  call site today (kept for API parity with the old single-conversation
   *  store) — a real "clear this conversation" affordance would call this
   *  scoped to whichever conversationId the UI names explicitly. */
  const clearManagerMessages = useCallback(() => {
    setState((prev) => withConversation(prev, prev.activeConversationId, { messages: [], pendingApprovals: [] }));
  }, []);

  /** Tab-strip click (LazyManagerHeader) — a no-op if `id` isn't currently
   *  an open conversation (e.g. a stale reference from a closed tab). */
  const setActiveConversationId = useCallback((id: string) => {
    setState((prev) => (prev.conversations[id] ? { ...prev, activeConversationId: id } : prev));
  }, []);

  /**
   * New-conversation button ("+"). Mints a fresh id, opens it as a NEW
   * conversation, and switches to it — deliberately NO busy gate and NO
   * side effect on any other conversation (multi-conversation LazyManager,
   * wave 1: this is the whole point — starting a fresh conversation must
   * never stop/interrupt one still working in the background). A no-op
   * once the open-conversation cap is reached (LazyManagerHeader disables
   * the button in that case with a real tooltip — this is the defensive
   * backstop, not the primary guard).
   */
  const newManagerConversation = useCallback(() => {
    setState((prev) => {
      if (prev.conversationOrder.length >= MAX_OPEN_MANAGER_CONVERSATIONS) return prev;
      const id = mintManagerSessionId();
      return {
        ...prev,
        conversations: { ...prev.conversations, [id]: emptyManagerConversation(id) },
        conversationOrder: [...prev.conversationOrder, id],
        activeConversationId: id,
      };
    });
  }, []);

  /**
   * Opens a past conversation from history. If `id` is already one of the
   * currently OPEN conversations, this just switches the active tab to it
   * (never duplicates, never reverts it to a possibly-stale on-disk
   * snapshot — same "don't clobber what's already live" rule the old
   * single-conversation version had). Otherwise reopens that persisted
   * session as a NEW live conversation — id reused verbatim (conversation
   * id space === session id space) — added to conversationOrder, switched
   * to, and NEVER replacing or interrupting whatever was already active. A
   * no-op if `id` isn't a known session, or if the open-conversation cap is
   * already reached.
   *
   * PENDING-APPROVAL PERSISTENCE — restores the session's own
   * pendingApprovals (never just its messages) so any action it left
   * awaiting approval is actionable again immediately.
   */
  const loadManagerSession = useCallback((id: string) => {
    setState((prev) => {
      if (prev.conversations[id]) return { ...prev, activeConversationId: id };
      if (prev.conversationOrder.length >= MAX_OPEN_MANAGER_CONVERSATIONS) return prev;
      const target = managerPersistedSessions.find((s) => s.id === id);
      if (!target) return prev;
      const restoredConv: ManagerConversationState = {
        id,
        messages: target.messages,
        busy: false,
        phase: 'idle',
        elapsedMs: 0,
        pendingApprovals: (target.pendingApprovals ?? []).map(fromPersistedPendingApproval),
        lastActiveAt: Date.now(),
        customTitle: target.title,
      };
      return {
        ...prev,
        conversations: { ...prev.conversations, [id]: restoredConv },
        conversationOrder: [...prev.conversationOrder, id],
        activeConversationId: id,
      };
    });
  }, [managerPersistedSessions]);

  const deleteManagerSession = useCallback((id: string) => {
    deleteManagerPersistedSession(id);
  }, [deleteManagerPersistedSession]);

  const managerSessions = useMemo<ManagerSessionSummary[]>(() => (
    [...managerPersistedSessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => {
        const firstUserMessage = s.messages.find((m) => m.role === 'user');
        return {
          id: s.id,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
          preview: firstUserMessage ? firstUserMessage.content.slice(0, 80) : '',
        };
      })
  ), [managerPersistedSessions]);

  const setManagerModel = useCallback((model: string) => {
    // REAL-USER FIX (2026-08-08, QA dogfood): the LazyManager picker used to
    // persist ONLY the model id — never the access mode. A user picking
    // "Claude Sonnet 5" from the "Abonnement Claude" (claude-sub) group got
    // the native id stored, but getProviderMode() still auto-resolved to
    // 'managed' (their active Pro plan wins when accessMode is unset), so
    // the manager turn was still routed to the ai-proxy with a NATIVE id →
    // "Modèle non supporté" (400 invalid_model) from the deployed proxy.
    // Mirror Composer.handleModelSelect exactly: an OpenRouter id (contains
    // '/') switches accessMode to 'pro'; a native Anthropic id switches it
    // to 'cli' so the turn routes through the Claude CLI the user picked.
    const current = loadAccessSettings();
    if (model.includes('/')) {
      saveAccessSettings({ ...current, accessMode: 'pro', model });
    } else {
      saveAccessSettings({ ...current, accessMode: 'cli', model });
    }
    saveManagerModel(model);
    setState((prev) => ({ ...prev, managerModel: model }));
  }, []);

  // ── Manager wakeup: proactive turn on significant journal events ─────
  // FOUNDER DIRECTIVE (verbatim): "le réveil sur événement doit permettre au
  // LazyManager d'être proactif si besoin et de réagir ou demander au
  // user" — sendManagerMessage above only ever runs from an explicit user
  // click (LazyManagerRail's send/retry buttons); this is the sole
  // automated call site (see managerWakeup.ts's own module header for the
  // full recon and guardrail rationale).
  //
  // sendManagerMessage is NOT itself a stable dependency (it changes on
  // every state.missions/managerMessages mutation — see its own useCallback
  // deps) — referencing it directly in the scheduler-start effect's deps
  // array would tear down and rebuild the scheduler (losing its in-flight
  // debounce/cap state) on nearly every render, the exact "declared
  // [state.missions] as a dependency" class of bug loopScheduler.ts's own
  // header documents fixing for the loop tick interval. Same ref-escape-
  // hatch convention as runFleetHygieneSweepRef/archiveMissionRef above:
  // read the LATEST sendManagerMessage through a ref kept in sync by its
  // own effect, while the scheduler itself is started once.
  const sendManagerMessageRef = useRef<typeof sendManagerMessage>(async () => {});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- same latest-callback-ref idiom as runFleetHygieneSweepRef/archiveMissionRef above (neither trips this rule); this project doesn't run the React Compiler, so its memoization concern doesn't apply here.
    sendManagerMessageRef.current = sendManagerMessage;
  }, [sendManagerMessage]);

  // Echo-suppression anchor (managerWakeup.ts's own doc comment): synced
  // whenever the AGGREGATE "is any open conversation busy" flag flips
  // true→false, i.e. the whole manager just went idle — whether the
  // just-finished turn was itself wakeup-triggered or an ordinary
  // user-initiated chat turn — either kind can perform a mission-mutating
  // action (e.g. approve_mission) that would otherwise arm another wakeup
  // off its own journal write. Multi-conversation LazyManager (wave 1):
  // this is deliberately the AGGREGATE across every open conversation, not
  // a single conversation's own busy flag — one conversation finishing
  // while a sibling is still busy is not "the manager went idle".
  const anyManagerBusy = state.conversationOrder.some((id) => state.conversations[id]?.busy);
  const wasManagerBusyRef = useRef(anyManagerBusy);
  const managerWakeupHandleRef = useRef<ReturnType<typeof startManagerWakeupScheduler> | null>(null);
  useEffect(() => {
    if (wasManagerBusyRef.current && !anyManagerBusy) {
      managerWakeupHandleRef.current?.notifyManagerTurnEnded(Date.now());
    }
    wasManagerBusyRef.current = anyManagerBusy;
  }, [anyManagerBusy]);

  // Approval-resume re-entrancy lock (managerApprovalResume.ts) — declared
  // here, ABOVE the wakeup scheduler effect below, so isManagerBusy can
  // close over it: held for the whole duration of an automated follow-up
  // turn fired after a conversation's pending-approval queue drains
  // (acquired synchronously before that turn's first await, released in a
  // `finally` — see maybeResumeAfterApprovalQueueDrain further down). A
  // plain ref, not React state, so acquiring/checking it is never subject
  // to the render/commit timing that makes `conv.busy` itself unreliable to
  // read synchronously right after a setState call (see
  // approvePendingAction/rejectPendingAction's own comments on why they
  // compute their drain count independently rather than trusting
  // stateRef.current alone).
  const approvalResumeInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const handle = startManagerWakeupScheduler({
      fetchEventsSince: async (sinceMs) => {
        const root = await resolveProjectRoot().catch(() => '.');
        const projectId = projectIdFromRoot(root);
        // E106 — surface orphaned brain ops (dream/graph timed out) as a
        // manager wakeup candidate in the same poll window.
        let orphanRow: Awaited<ReturnType<typeof queryJournalSince>>[number] | null = null;
        try {
          const { pollBrainOpsOrphan } = await import('../../lib/brain/opsOrphanWatch');
          const orphan = await pollBrainOpsOrphan({ projectId });
          if (orphan) {
            orphanRow = {
              seq: 0,
              ts_ms: Date.now(),
              project_id: projectId,
              mission_id: null,
              agent_id: null,
              run_id: null,
              actor: 'system',
              type: 'brain.ops_orphan',
              payload: JSON.stringify({
                phase: orphan.phase,
                step: orphan.step ?? null,
                pid: orphan.pid ?? null,
                detail: orphan.detail ?? null,
                timeoutSecs: orphan.timeoutSecs ?? null,
                brainPath: orphan.brainPath ?? null,
              }),
              tokens_in: 0,
              tokens_out: 0,
              cost_usd: 0,
            };
          }
        } catch {
          // Best-effort — never block wakeup polling.
        }
        const rows = await queryJournalSince(projectId, sinceMs, 100);
        return orphanRow ? [...rows, orphanRow] : rows;
      },
      // "never wake while a manager turn is already running" now means:
      // no OPEN conversation is currently idle to route a wake-up into
      // (see pickWakeupTargetConversationId's own doc comment) — routing
      // a wake-up into an already-busy conversation would race its turn
      // against whatever the user (or another wake-up) already has in
      // flight there. Also excludes a conversation currently locked by
      // managerApprovalResume.ts's own approvalResumeInFlightRef: that
      // lock is acquired synchronously, before conv.busy itself has
      // necessarily flipped true (a brief async gap — journaling, then the
      // sendManagerMessage call — sits between acquiring the lock and
      // conv.busy actually committing), so without this check a wake-up
      // landing in that narrow window could still route into the exact
      // conversation an approval-resume turn is about to use.
      isManagerBusy: () => {
        const target = pickWakeupTargetConversationId(stateRef.current);
        return target === undefined || approvalResumeInFlightRef.current.has(target);
      },
      sendWakeupTurn: async (text, candidates) => {
        // Best-effort audit trail (founder's "everything agents do must be
        // visible" rule) — never blocks/guards the actual turn below; a
        // failed journal write here must not cancel a real wakeup.
        const root = await resolveProjectRoot().catch(() => '.');
        const missionIds = Array.from(
          new Set(candidates.map((c) => c.missionId).filter((id): id is string => Boolean(id))),
        );
        void emitEvent({
          type: 'manager.wakeup',
          tsMs: Date.now(),
          projectId: projectIdFromRoot(root),
          // 'manager' (not 'system') — this is specifically the LazyManager
          // acting autonomously, distinct from a generic background sweep
          // like fleet.hygiene's own 'system' actor. Same actor budgetTracker.ts
          // already uses for a manager-driven journal event.
          actor: 'manager',
          payload: { kinds: candidates.map((c) => c.kind), missionIds },
        });
        // Deliberately forced to the cheap tier regardless of the user's own
        // chat model preference (state.managerModel) — a wakeup is a
        // lightweight "check real state, act or ack" round trip (see the
        // PROACTIVE WAKEUP rule in managerEngine.ts's system prompt), not a
        // reason to spend the user's chosen conversational tier in the
        // background on their behalf.
        //
        // displayContent (real user report, 2026-08-01 QA): the model still
        // gets `text` verbatim (with its "reply in French" directive intact —
        // see formatWakeupMessage), but the transcript shows the human the
        // shorter formatWakeupDisplayMessage instead, which drops that
        // internal directive — see ManagerMessage.displayContent's own doc
        // comment for why this is a display-only seam.
        //
        // Wake-up routing (multi-conversation LazyManager, wave 1): the
        // most-recently-active IDLE open conversation — never the
        // (possibly busy) active tab. `isManagerBusy` above already gates
        // this scheduler from firing at all when none exists, but re-check
        // here too since some time may have passed between that check and
        // this callback actually running (fetchEventsSince/journal reads
        // above are async).
        const targetId = pickWakeupTargetConversationId(stateRef.current);
        if (!targetId) return;
        // GOAL LOOP: "terminal mission event" per the founder brief
        // ("mission merged/failed/done") — mission_failed and merge_landed
        // are the two WakeupEventKind values (managerWakeup.ts) that
        // represent a mission actually reaching a real end state; the
        // others (approve_blocked/review_*/chain_fired/fleet_hygiene) are
        // either not terminal or not mission-scoped. See
        // sendManagerMessage's own wakeupHasTerminalMissionEvent doc
        // comment for how this gates goal evaluation. bot_completed is a
        // LazyBot run reaching `done` — its real end state (no merge ever
        // follows a Solari bot), so a "lance le bot X" goal can settle on it.
        const wakeupHasTerminalMissionEvent = candidates.some(
          (c) => c.kind === 'mission_failed' || c.kind === 'merge_landed' || c.kind === 'bot_completed',
        );
        await sendManagerMessageRef.current(
          targetId,
          text,
          resolveAutomatedTurnModel(stateRef.current.managerModel),
          {
            displayContent: formatWakeupDisplayMessage(candidates, t),
            isWakeupTurn: true,
            wakeupHasTerminalMissionEvent,
          },
        );
      },
      formatWakeupText: (candidates) => formatWakeupMessage(candidates, t),
      getConfig: getManagerWakeupConfig,
    });
    managerWakeupHandleRef.current = handle;
    return () => {
      handle.stop();
      managerWakeupHandleRef.current = null;
    };
  }, [t]);

  const setAutonomyLevel = useCallback((mode: AutonomyMode) => {
    setState((prev) => ({ ...prev, autonomyLevel: mode }));
  }, []);

  // Guards a double-click/double-invocation while an approval is in flight —
  // the entry itself is no longer removed up front (see approvePendingAction
  // below: a FAILED attempt must stay in pendingApprovals, so "already
  // removed" can no longer serve as the in-flight guard it used to be).
  const resolvingPendingIdsRef = useRef<Set<string>>(new Set());

  /**
   * Fires managerApprovalResume.ts's automated follow-up turn once
   * `conversationId`'s pending-approval queue reaches zero — see that
   * module's own header for the defect this closes. Every call site below
   * (approvePendingAction/rejectPendingAction/approveAllPendingActions/
   * rejectAllPendingActions) computes `remainingPendingApprovals` itself
   * rather than this function re-reading `stateRef.current`: React 18
   * batches multiple synchronous setState calls (e.g.
   * rejectAllPendingActions's own loop, which awaits nothing between
   * iterations), so `stateRef.current` is NOT guaranteed to reflect a
   * removal that was just dispatched — each call site is closer to the
   * ground truth of what it just resolved than a generic re-read here
   * could be.
   *
   * Safe to call from multiple sites for the very same drain (and does
   * happen in practice — e.g. approvePendingAction's own per-item check
   * during "Approve all", followed by approveAllPendingActions's own
   * batch-level recheck): approvalResumeInFlightRef is the actual dedup
   * guard, not caller discipline. Targets `conversationId` directly, never
   * pickWakeupTargetConversationId's "most-recently-active idle
   * conversation" routing — the manager promised THIS conversation an
   * answer.
   */
  const maybeResumeAfterApprovalQueueDrain = useCallback(async (
    conversationId: string,
    remainingPendingApprovals: number,
  ): Promise<void> => {
    const conv = stateRef.current.conversations[conversationId];
    if (!conv) return;
    const shouldResume = shouldResumeAfterApprovalQueueDrain({
      remainingPendingApprovals,
      conversationBusy: conv.busy,
      resumeAlreadyInFlight: approvalResumeInFlightRef.current.has(conversationId),
    });
    if (!shouldResume) return;
    approvalResumeInFlightRef.current.add(conversationId);
    try {
      // Let React COMMIT the approval's own state updates before the resume
      // turn reads them. The caller dispatched them via setState a few
      // microtasks ago (the mission run_lazybot/launch_mission just created
      // + this entry's own pendingApprovals removal) and we are still in the
      // same flush: the render has not run, so neither stateRef.current nor
      // sendManagerMessageRef.current (re-pointed by an effect) know about
      // the new mission yet. Live QA 2026-09-02: run_lazybot created M96, the
      // resume turn's context still listed M95 as the latest mission and the
      // manager "honestly" reported the fleet as failed while M96 was
      // completing on the canvas. The drain condition guarantees the
      // committed queue ends at 0 (failed approvals never trigger a resume —
      // they stay queued), so "queue visibly empty" doubles as "that render
      // committed". Bounded (≤ 1 s) — degrades to the old timing, never hangs.
      for (
        let i = 0;
        i < 50 && (stateRef.current.conversations[conversationId]?.pendingApprovals.length ?? 0) > 0;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // Best-effort audit trail (same convention as sendWakeupTurn's own
      // emitEvent call below) — never blocks/guards the actual turn.
      const root = await resolveProjectRoot().catch(() => '.');
      void emitEvent({
        type: 'manager.approval_resume',
        tsMs: Date.now(),
        projectId: projectIdFromRoot(root),
        actor: 'manager',
        payload: { conversationId },
      });
      // isAutomatedTurn (not a dedicated new flag): this call site is
      // exactly the "background/synthetic, not a real user ask" family
      // isAutomatedTurn's own doc comment already documents — a 4th
      // member alongside announceLoopApprovalIfPromoted/
      // announceLoopFailureIfDemoted/runFleetHygieneSweep's supervision
      // alert. isWakeupTurn is deliberately NOT used here: it carries
      // managerWakeup.ts-specific semantics (wakeupHasTerminalMissionEvent
      // gating goal evaluation off a WakeupCandidate batch) that don't
      // apply to a queue-drain resume, which has no candidates at all.
      await sendManagerMessageRef.current(
        conversationId,
        formatApprovalResumeMessage(t),
        resolveAutomatedTurnModel(stateRef.current.managerModel),
        { isAutomatedTurn: true },
      );
    } finally {
      approvalResumeInFlightRef.current.delete(conversationId);
    }
  }, [t]);

  /** Executes a gate-deferred action exactly as originally proposed — see
   *  PendingApprovalAction's doc comment for the full contract. Reads from
   *  stateRef (not the render-scoped `state`) because approval can happen
   *  long after the turn that queued it re-rendered. Pass `{ force: true }`
   *  to retry an approve_mission bypassing the judge/proof gate
   *  (approveGate.ts) — same primitive as the human's "Merger quand même"
   *  button; ignored for every other action type.
   *
   *  Honesty fix (real user test, 2026-07-28 — three approve_mission
   *  actions blocked by `mission.approve_blocked`, judge score unavailable,
   *  still showed "Approuvée"): this NEVER reports success unless the
   *  action genuinely executed — see PendingApprovalOutcome's own doc
   *  comment for the full ok/reason/canForce contract this returns. */
  const approvePendingAction = useCallback(async (
    conversationId: string,
    id: string,
    opts?: {
      force?: boolean;
      /**
       * Digest-aggregation fix (2026-08-04 founder directive): when true,
       * this call does NOT append its own "Résultat réel" chat message on
       * success — it still applies every other real effect (state patch,
       * pendingApprovals removal) and returns the real outcome via
       * `PendingApprovalOutcome.result` so a BATCH caller
       * (approveAllPendingActions) can group it with its siblings into ONE
       * digest message instead of one per target. Never suppresses the
       * FAILURE message below — a failure stays individually actionable
       * (force retry / reject) regardless of batch context.
       */
      suppressResultMessage?: boolean;
    },
  ): Promise<PendingApprovalOutcome> => {
    const conv = stateRef.current.conversations[conversationId];
    const pending = conv?.pendingApprovals.find((p) => p.id === id);
    if (!pending) return { ok: false }; // already resolved, unknown id, or unknown conversation — idempotent, same convention as executePlan
    if (resolvingPendingIdsRef.current.has(id)) return { ok: false }; // already in flight
    resolvingPendingIdsRef.current.add(id);
    const actionToRun: ManagerAction = (opts?.force && pending.action.type === 'approve_mission')
      ? { ...pending.action, force: true }
      : pending.action;
    try {
      const outcome = await executeManagerActionRef.current(actionToRun, pending.model, pending.aliasMap, conversationId);
      // Honesty fix (silent-approval bug, 2026-08-07 — same founder-reported
      // defect as addMission's new engine-readiness preflight): launch_mission's
      // resolveDraftProjectId branch, generate_plan, and execute_plan can all
      // return a real, NON-throwing `{ failed: true, message }` outcome instead
      // of throwing (project not open, plan not found, gate denied, an
      // internally-caught exception — see ManagerActionRealResult.failed's own
      // doc comment). Before this check, ANY non-throwing return below was
      // unconditionally treated as success — pendingApprovals entry removed,
      // card flipped to "Approuvée" — even though the action genuinely did
      // nothing. Re-thrown so the SAME catch block below (the existing,
      // battle-tested honesty path: stays pending, red chip, real reason,
      // canForce) handles it identically to a real exception — never a second,
      // diverging failure shape.
      if (outcome?.failed) {
        throw new Error(outcome.message || 'Action failed with no reason given');
      }
      // SUCCESS — remove for real (a FAILED attempt below never does — see
      // the honesty fix this powers). Patch the ORIGIN message's
      // actionStatuses/actionRefs to a success outcome — the SAME
      // ActionBadge rendering an immediately-executed action gets (green
      // chip), never the red "needs approval" chip it was rendered with
      // while pending.
      setState((prev) => withConversation(prev, conversationId, (c) => ({
        pendingApprovals: c.pendingApprovals.filter((p) => p.id !== id),
        messages: c.messages.map((m) => {
          if (m.id !== pending.messageId) return m;
          const actionStatuses = [...(m.actionStatuses ?? [])];
          const actionRefs = [...(m.actionRefs ?? [])];
          actionStatuses[pending.actionIndex] = true;
          actionRefs[pending.actionIndex] = outcome && 'patchedRef' in outcome ? outcome.patchedRef : undefined;
          return { ...m, actionStatuses, actionRefs };
        }),
      })));
      if (outcome?.message && !opts?.suppressResultMessage) {
        const realResultMsg: ManagerMessage = {
          id: createMessageId(),
          role: 'assistant',
          content: t('agents.manager.realResult', { result: outcome.message }),
          // 2026-08-06 — hidden from the chat UI, kept for the manager's own
          // context (same rationale as the batch real-result path above).
          displayContent: '',
          timestamp: new Date().toISOString(),
        };
        setState((prev) => appendConversationMessages(prev, conversationId, [realResultMsg]));
      }
      // managerApprovalResume.ts trigger — re-reads stateRef.current FRESH
      // here (rather than reusing the `conv` snapshot captured before the
      // `await` above) since real async work just happened: any sibling
      // approvePendingAction call that resolved DURING this one's await has
      // had a genuine chance to commit its own removal by now. Excluding
      // `id` accounts for THIS call's own removal, dispatched via setState
      // just above but not necessarily reflected in stateRef.current yet
      // (see maybeResumeAfterApprovalQueueDrain's own doc comment on why
      // every call site computes this itself instead of trusting a shared
      // re-read).
      const freshConv = stateRef.current.conversations[conversationId];
      const remainingPendingApprovals = (freshConv?.pendingApprovals ?? []).filter((p) => p.id !== id).length;
      void maybeResumeAfterApprovalQueueDrain(conversationId, remainingPendingApprovals);
      return { ok: true, result: outcome ?? undefined };
    } catch (err) {
      // FAILURE — the whole point of this fix: never indistinguishable from
      // success. The entry is NEVER removed as if resolved-positive — it
      // stays in pendingApprovals (still actionable: reject to abandon it,
      // or retry, e.g. with force) carrying the REAL reason, verbatim.
      // Patches actionStatuses to `false` (same red/strikethrough chip a
      // denied action already gets) and — Défaut 2, the manager never
      // learned of a refusal before this fix (only a toast fired, which
      // never reaches managerMessages) — appends a transcript message with
      // that exact reason so the manager reads it honestly on its NEXT
      // turn, same convention rejectPendingAction already uses.
      const reason = err instanceof ApproveBlockedError ? err.reason : (err instanceof Error ? err.message : String(err));
      const canForce = actionToRun.type === 'approve_mission' && actionToRun.force !== true;
      // R14 — see PendingApprovalOutcome.judgeUnavailable's own doc comment:
      // forwards ApproveBlockedError's own honest classification (never a
      // real judge rejection when the evaluator rail itself failed) so a
      // future caller (PendingApprovalCard.tsx via LazyManagerMessageList.tsx)
      // can render it instead of the flattened `reason` string as if it were
      // a genuine rejection. undefined for every non-ApproveBlockedError
      // failure and for a block unrelated to the verdict (e.g. missing
      // proofs) — never fabricated true/false.
      const judgeUnavailable = err instanceof ApproveBlockedError ? err.judgeUnavailable : undefined;
      const verdictReviewers = err instanceof ApproveBlockedError ? err.verdictReviewers : undefined;
      setState((prev) => withConversation(prev, conversationId, (c) => ({
        pendingApprovals: c.pendingApprovals.map((p) => (p.id === id ? { ...p, lastFailure: { reason, canForce, judgeUnavailable, verdictReviewers } } : p)),
        messages: c.messages.map((m) => {
          if (m.id !== pending.messageId) return m;
          const actionStatuses = [...(m.actionStatuses ?? [])];
          actionStatuses[pending.actionIndex] = false;
          return { ...m, actionStatuses };
        }),
      })));
      const failedMsg: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: t('agents.manager.actionFailed', { type: pending.action.type, reason }),
        timestamp: new Date().toISOString(),
      };
      setState((prev) => appendConversationMessages(prev, conversationId, [failedMsg]));
      toast(t('agents.manager.actionFailed', { type: pending.action.type, reason: reason.slice(0, 160) }), 'error');
      return { ok: false, reason, canForce, judgeUnavailable, verdictReviewers };
    } finally {
      resolvingPendingIdsRef.current.delete(id);
    }
  }, [t, toast, maybeResumeAfterApprovalQueueDrain]);

  /** Drops a gate-deferred action on `conversationId` without executing it,
   *  and appends a transcript message so the manager reads the rejection on
   *  its NEXT turn (that conversation's messages feed straight into its
   *  next sendManagerMessage call's `turnMessages`). A no-op if `id` is not
   *  currently pending on that conversation. */
  const rejectPendingAction = useCallback((conversationId: string, id: string) => {
    // managerApprovalResume.ts trigger — computed from stateRef.current
    // BEFORE the setState below (this function has no `await`, so
    // stateRef.current here is whatever the last committed render left it
    // at: accurate for a standalone reject click, conservatively stale —
    // never over-counting, only ever under-counting — when called from
    // rejectAllPendingActions's own synchronous loop, which does its own
    // authoritative batch-level arithmetic afterward rather than trusting
    // this per-item read; see maybeResumeAfterApprovalQueueDrain's own doc
    // comment). `wasPending` mirrors the SAME "was this id actually here"
    // guard the setState updater below applies independently, so a no-op
    // reject (stale/unknown id) can never spuriously fire a resume.
    const before = stateRef.current.conversations[conversationId]?.pendingApprovals ?? [];
    const wasPending = before.some((p) => p.id === id);
    setState((prev) => {
      const conv = prev.conversations[conversationId];
      const pending = conv?.pendingApprovals.find((p) => p.id === id);
      if (!pending) return prev;
      const rejectedMsg: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: t('agents.manager.actionDenied', { type: pending.action.type, reason: 'Rejected by user' }),
        timestamp: new Date().toISOString(),
      };
      return appendConversationMessages(
        withConversation(prev, conversationId, { pendingApprovals: conv.pendingApprovals.filter((p) => p.id !== id) }),
        conversationId,
        [rejectedMsg],
      );
    });
    if (wasPending) {
      const remainingPendingApprovals = before.filter((p) => p.id !== id).length;
      void maybeResumeAfterApprovalQueueDrain(conversationId, remainingPendingApprovals);
    }
  }, [t, maybeResumeAfterApprovalQueueDrain]);

  /** Approves every pending action queued from the same manager turn on
   *  `conversationId`, in queued order — the "approve all" affordance for a
   *  turn's batch. Returns each request's OWN real outcome (see
   *  approvePendingAction's own doc comment) — never a blanket success just
   *  because the batch was dispatched, so a card can show exactly which of
   *  a batch actually went through and which were blocked/failed, with
   *  their real reasons.
   *
   *  DIGEST AGGREGATION (2026-08-04 founder directive): each individual
   *  approvePendingAction call is told to SUPPRESS its own "Résultat réel"
   *  chat message (`suppressResultMessage: true`) — this function collects
   *  every SUCCESSFUL result instead and appends exactly ONE aggregated
   *  digest message afterward (buildRealResultDigest), grouped by outcome
   *  (e.g. "8 missions supprimées (M1-M8). Worktrees : 4 jetés
   *  (lazy-backoffice), 4 introuvables.") instead of 8+ separate system
   *  lines with raw paths. A single approved action still reads naturally
   *  through the SAME digest builder (a one-entry group). Failures are
   *  UNCHANGED — approvePendingAction still appends its own failure message
   *  per item, since each stays individually actionable (force retry /
   *  reject). The full per-target detail is never lost: it is still the
   *  exact `message`/`result` this function returns to its own caller
   *  (e.g. PendingApprovalCard's own per-item rendering), and still what
   *  gets journaled — the digest is a chat-transcript-only summary. */
  const approveAllPendingActions = useCallback(async (conversationId: string, turnId: string): Promise<Array<{ id: string } & PendingApprovalOutcome>> => {
    const ids = (stateRef.current.conversations[conversationId]?.pendingApprovals ?? []).filter((p) => p.turnId === turnId).map((p) => p.id);
    const results: Array<{ id: string } & PendingApprovalOutcome> = [];
    for (const id of ids) {
      const outcome = await approvePendingAction(conversationId, id, { suppressResultMessage: true });
      results.push({ id, ...outcome });
    }

    const successResults = results
      .map((r) => r.result)
      .filter((r): r is ManagerActionRealResult => !!r);
    if (successResults.length > 0) {
      const digestMsg: ManagerMessage = {
        id: createMessageId(),
        role: 'assistant',
        content: t('agents.manager.realResult', { result: buildRealResultDigest(t, successResults) }),
        timestamp: new Date().toISOString(),
      };
      setState((prev) => appendConversationMessages(prev, conversationId, [digestMsg]));
    }

    // managerApprovalResume.ts backstop — approvePendingAction's own
    // per-item check above already fires on the item that empties the
    // queue for the common sequential case, but this batch-level recheck
    // is the AUTHORITATIVE one: by now every iteration's `await` has given
    // React real opportunities to commit, so stateRef.current is trusted
    // directly rather than reconstructed. Safe/idempotent even when the
    // per-item check already fired — approvalResumeInFlightRef is the
    // actual dedup guard (see maybeResumeAfterApprovalQueueDrain).
    const remainingPendingApprovals = stateRef.current.conversations[conversationId]?.pendingApprovals.length ?? 0;
    void maybeResumeAfterApprovalQueueDrain(conversationId, remainingPendingApprovals);

    return results;
  }, [approvePendingAction, t, maybeResumeAfterApprovalQueueDrain]);

  /** Rejects every pending action queued from the same manager turn on
   *  `conversationId`. */
  const rejectAllPendingActions = useCallback((conversationId: string, turnId: string) => {
    const before = stateRef.current.conversations[conversationId]?.pendingApprovals ?? [];
    const ids = before.filter((p) => p.turnId === turnId).map((p) => p.id);
    for (const id of ids) {
      rejectPendingAction(conversationId, id);
    }
    // managerApprovalResume.ts trigger — computed by pure arithmetic
    // (`before.length - ids.length`), NOT by re-reading stateRef.current
    // after the loop: rejectPendingAction has no `await`, so this whole
    // loop runs inside one synchronous stretch and React 18 batches every
    // setState call it dispatches — stateRef.current would still reflect
    // the PRE-loop state right here, not the post-removal one (its own
    // sync effect only runs after the batched render commits). Every id in
    // `ids` is guaranteed to have actually been pending (sourced from this
    // same `before` snapshot), and rejectPendingAction unconditionally
    // removes a matched id, so this count is exact regardless of when
    // React gets around to committing.
    const remainingPendingApprovals = before.length - ids.length;
    void maybeResumeAfterApprovalQueueDrain(conversationId, remainingPendingApprovals);
  }, [rejectPendingAction, maybeResumeAfterApprovalQueueDrain]);

  const executePlan = useCallback(async (planId: string, opts?: { stepIds?: string[] }) => {
    // Idempotent: find which open conversation proposed this plan (multi-
    // conversation LazyManager, wave 1 — executePlan is keyed by planId
    // only, since GraphProposalCard's Accept/Modify/Reject buttons never
    // knew which conversation proposed it) and check it's still pending.
    const conversationId = findConversationIdForMessage(
      stateRef.current,
      (m) => m.proposal?.planId === planId && m.proposal.state === 'pending',
    );
    const proposalMsg = conversationId
      ? stateRef.current.conversations[conversationId]?.messages.find(
          (m) => m.proposal?.planId === planId && m.proposal!.state === 'pending',
        )
      : undefined;
    if (!proposalMsg || !conversationId) {
      // Already accepted/rejected or not found — no-op
      return;
    }

    // B2 fix (real QA session 2026-07-28: "Valider & lancer" flipped the
    // card straight to ACCEPTED with zero real effect — no mission, no
    // canvas change, nothing to show for it) — the card no longer jumps to
    // a terminal-looking 'accepted' before any real work has happened. It
    // sits in 'launching' (GraphProposalCard's own honest "in flight" state)
    // for the whole materialize+execute window below; a STALE errorMessage
    // from a previous failed attempt is cleared here too, never left
    // lingering next to a brand new attempt.
    setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
      m.proposal?.planId === planId && m.proposal.state === 'pending'
        ? { ...m, proposal: { ...m.proposal, state: 'launching' as const, errorMessage: undefined } }
        : m,
    ));
    emit('manager:shrinkOverlay', undefined);

    // Never silently drop a failure past this point — reverts the card to
    // 'pending' (same retry affordance it already offers) WITH a real,
    // visible reason attached, instead of leaving 'launching' stuck forever
    // or a toast that scrolled away being the only trace anything went
    // wrong. Shared by every failure branch below so the story told to the
    // user is always exactly one path, never a second hand-rolled variant.
    const revertToPendingWithError = (reason: string) => {
      toast(reason, 'error', 8000);
      setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
        m.proposal?.planId === planId && m.proposal.state === 'launching'
          ? { ...m, proposal: { ...m.proposal, state: 'pending' as const, errorMessage: reason } }
          : m,
      ));
    };

    // resolveOrchestratorRoot — see execute_plan's own doc comment on this
    // helper (the plan may target a non-active project). Fetched BEFORE the
    // deferred-actions replay below (it used to run AFTER — see the
    // consent-bypass fix's own doc comment just below for why that ordering
    // was also wrong: it let irreversible side effects like create_project
    // fire for a plan that turns out not to even exist).
    const projectRoot = await resolveOrchestratorRoot(planId);
    const orch = await getOrchestrator(projectRoot, planId);
    if (!orch) {
      revertToPendingWithError(`Plan ${planId} not found — launch cancelled.`);
      return;
    }

    // Patches ONE deferred action's status (and, on real success, its
    // resolved ref) onto the proposal message — same shallow-spread/
    // immutable-array-copy idiom approvePendingAction uses just above for
    // the live gate path (never mutates `m.actionStatuses` in place).
    // `actionIndex < 0` means the action's identity could not be matched
    // back into `proposalMsg.actions` at all — since the PERSISTED-INDEX
    // DEADLOCK FIX (see deferredActionEntries's own doc comment,
    // sendManagerMessage) this is rare: `proposal.deferredActionIndexes`
    // (a plain number, survives managerPersistence.ts's JSON round-trip)
    // resolves the common case the object-reference fallback used to fail
    // on after any save/reload. Only a proposal that predates this fix, or
    // a corrupt/length-mismatched persisted index array, still falls all
    // the way through to -1 — the action is still correctly gated/executed/
    // refused below, only the ORIGIN message's own chip cannot be
    // re-painted for it, a graceful, never-silent-about-execution
    // degradation.
    const patchDeferredActionStatus = (actionIndex: number, status: ActionStatus, ref?: string) => {
      if (actionIndex < 0) return;
      setState((prev) => mapConversationMessages(prev, conversationId, (m) => {
        if (m.id !== proposalMsg.id) return m;
        const nextStatuses = [...(m.actionStatuses ?? [])];
        nextStatuses[actionIndex] = status;
        if (ref === undefined) return { ...m, actionStatuses: nextStatuses };
        const nextRefs = [...(m.actionRefs ?? [])];
        nextRefs[actionIndex] = ref;
        return { ...m, actionStatuses: nextStatuses, actionRefs: nextRefs };
      }));
    };

    // B: Replay deferred mutative actions (if any) that were gated during
    // pending proposal.
    //
    // CONSENT-BYPASS FIX: this used to call executeManagerActionRef.current
    // directly, with NO evaluateActionGate pass at all — a `sensitive`
    // action (e.g. create_project, classified in actionClassifier.ts with a
    // comment stating the manager must always ask before creating a
    // directory) ran completely unattended the instant a plan proposed in
    // the SAME turn was validated. Every deferred action now goes through
    // the EXACT SAME gate a normal action gets in the live dispatch loop
    // above (evaluateActionGate/classifyAction), and reuses the SAME
    // pendingApprovals queue rather than a parallel path.
    //
    // Gated with the PLAN's OWN captured `orch.autonomyLevel`, not the live
    // global state.autonomyLevel — same precedent already established for
    // execute_plan's own gate (see that action's case in
    // executeManagerAction, "Intentionally the PLAN's own autonomyLevel"):
    // these actions were proposed in the SAME turn as the plan, under
    // whatever mode was live then, so they stay gated consistently even if
    // the user has since flipped the global selector.
    //
    // ORDERING (ask vs. deny): a `deny` refuses only that ONE action — same
    // as a live-turn deny — and never blocks the rest of the plan; it is a
    // resolved "no", nothing left to wait for. An `ask` is different: a
    // human decision is still OUTSTANDING for this deferred action. Racing
    // ahead to materialize+launch the plan regardless would let mission
    // steps start running while a sibling action from the SAME turn (e.g.
    // the very create_project a step's launch may depend on) is still
    // unresolved — exactly the "plan proceeds as if it had run" trap this
    // fix closes. So instead: the WHOLE plan launch is blocked below,
    // reverted to 'pending' (the card's existing retry affordance) with an
    // honest errorMessage naming how many actions are still awaiting
    // approval, and the queued PendingApprovalAction(s) are left live on
    // THIS SAME proposal message — the user resolves them via the normal
    // approval card, then clicks "Valider & lancer" again.
    const deferredActions = proposalMsg.proposal?.deferredActions;
    if (deferredActions && deferredActions.length > 0) {
      const replayAliasMap = new Map<string, string>();
      const autonomyConfig = getEffectiveAutonomy({ mode: orch.autonomyLevel });
      let awaitingApprovalCount = 0;

      // DEADLOCK FIX (real user repro, 2026-08-18 — "Validate & run" never
      // launches even after approving the one queued action): this replay
      // loop used to re-run evaluateActionGate over EVERY deferred action on
      // EVERY "Validate & run" click, with NO memory of a prior resolution.
      // An already-approved/auto-allowed action got RE-EXECUTED (a second,
      // duplicate side effect) and a still-'ask' action got a SECOND,
      // independent pendingApprovals entry queued for it on every retry —
      // so approving the ONE entry visibly on screen never actually cleared
      // the plan's block: the very next validate attempt just re-asked from
      // scratch (a brand new pendingApprovals row) and reverted to 'pending'
      // again, forever. `proposalMsg.actionStatuses[actionIndex]` (patched
      // in place both by this loop's own `patchDeferredActionStatus` calls
      // and by approvePendingAction, agentsStore.tsx) is used below as that
      // memory, cross-referenced against the LIVE `pendingApprovals` queue —
      // same convention ActionStatus's own doc comment already documents for
      // telling an unresolved 'ask' apart from a genuine denial/failure:
      //   - `true`  -> already executed for real (a prior approve, or a
      //     prior 'allow') — never replay it again.
      //   - `false` with NO live pendingApprovals entry left for it -> the
      //     decision is already terminal: either this SAME loop denied it on
      //     a prior pass, or the user clicked Reject (rejectPendingAction) —
      //     skip it, same as a live-turn `deny` already does not block the
      //     rest of the turn. See the Reject test in
      //     planDeferredActionsConsentGate.test.tsx for the semantics this
      //     chooses: a rejected deferred action behaves exactly like a gate
      //     `deny` — it never runs, but it never re-blocks the plan either
      //     (blocking forever with no way to un-reject would just be a
      //     second deadlock).
      //   - still has a live pendingApprovals entry -> a human decision is
      //     genuinely still outstanding from a prior pass; count it and move
      //     on WITHOUT queuing a duplicate row for the same action.
      //   - `'deferred'` with no live entry -> never gated at all yet (first
      //     validate attempt) — fall through to evaluateActionGate below,
      //     unchanged from before this fix.
      const livePendingByActionIndex = new Set(
        (stateRef.current.conversations[conversationId]?.pendingApprovals ?? [])
          .filter((p) => p.messageId === proposalMsg.id)
          .map((p) => p.actionIndex),
      );

      for (let deferredIdx = 0; deferredIdx < deferredActions.length; deferredIdx++) {
        const action = deferredActions[deferredIdx];
        // PERSISTED-INDEX DEADLOCK FIX (see deferredActionEntries's own doc
        // comment, sendManagerMessage, for the full live repro this closes):
        // `proposal.deferredActionIndexes[deferredIdx]` — recorded once, at
        // proposal-construction time, as a plain number — is preferred over
        // a same-session object-reference lookup into `proposalMsg.actions`.
        // The reference lookup (`actions.findIndex((a) => a === action)`)
        // ONLY works while `deferredActions` and `actions` still share the
        // exact object instances they were built from in the SAME tick; the
        // instant this message round-trips through managerPersistence.ts's
        // JSON storage (any save+reload — including just navigating away
        // and back), `JSON.parse` rebuilds both arrays as independent object
        // graphs and `===` is false for every entry forever after, silently
        // making `actionIndex` -1 even for an action `actionStatuses`
        // already, correctly, records as `true`. Falls back to the
        // reference lookup only when no recorded index survived (a proposal
        // that predates this fix, or a corrupt/length-mismatched persisted
        // array — see managerPersistence.ts's own sanitizeProposal), same
        // as before this fix existed — never worse, only better once a
        // fresh proposal carries the recorded array. A bounds/type check
        // guards against `deferredActionIndexes` itself somehow drifting out
        // of sync with `actions` (e.g. hand-edited storage).
        const recordedIndex = proposalMsg.proposal?.deferredActionIndexes?.[deferredIdx];
        const actionIndex = typeof recordedIndex === 'number'
          && recordedIndex >= 0
          && proposalMsg.actions?.[recordedIndex] !== undefined
          ? recordedIndex
          : (proposalMsg.actions?.findIndex((a) => a === action) ?? -1);

        if (actionIndex >= 0) {
          const priorStatus = proposalMsg.actionStatuses?.[actionIndex];
          const stillAwaiting = livePendingByActionIndex.has(actionIndex);
          if (priorStatus === true) {
            continue; // already executed for real on a prior pass — never replay
          }
          if (stillAwaiting) {
            awaitingApprovalCount += 1; // outstanding since a prior validate — don't re-queue, just re-count
            continue;
          }
          if (priorStatus === false) {
            continue; // terminal no (prior deny or user Reject) — skip, don't re-litigate, don't block
          }
          // priorStatus === 'deferred' and nothing live for it -> never
          // gated yet; fall through to evaluateActionGate below.
        }

        const gate = await evaluateActionGate(action.type, autonomyConfig, {
          turnId: planId,
          payload: action as unknown as Record<string, unknown>,
        });
        if (gate.decision === 'deny') {
          const reason = t('agents.manager.actionDenied', { type: action.type, reason: gate.reason.slice(0, 160) });
          toast(reason, 'error');
          patchDeferredActionStatus(actionIndex, false);
          continue;
        }
        if (gate.decision === 'ask') {
          awaitingApprovalCount += 1;
          const pending: PendingApprovalAction = {
            id: createMessageId(),
            action,
            label: describePendingAction(action, t),
            // No original turnId survives to replay time (only the plan's
            // own deferredActions list does) — planId is the stable,
            // unique handle every deferred action from THIS plan shares, so
            // "approve/reject all" groups exactly this replay batch.
            turnId: planId,
            messageId: proposalMsg.id,
            actionIndex,
            model: 'ui',
            aliasMap: replayAliasMap,
            createdAt: new Date().toISOString(),
          };
          setState((prev) => withConversation(prev, conversationId, (c) => ({ pendingApprovals: [...c.pendingApprovals, pending] })));
          patchDeferredActionStatus(actionIndex, false);
          toast(t('agents.manager.actionNeedsApproval', { type: action.type }), 'warning');
          continue;
        }
        // allow
        try {
          const outcome = await executeManagerActionRef.current(action, 'ui', replayAliasMap, conversationId);
          patchDeferredActionStatus(actionIndex, true, outcome && 'patchedRef' in outcome ? outcome.patchedRef : undefined);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          toast(`Deferred action ${action.type} failed: ${reason.slice(0, 80)}`, 'error');
          patchDeferredActionStatus(actionIndex, false);
        }
      }
      if (awaitingApprovalCount > 0) {
        revertToPendingWithError(
          `${awaitingApprovalCount} action(s) from this plan still need your approval — resolve them above, then validate again.`,
        );
        return;
      }
    }

    // A: Materialize the plan onto the canvas — chantier 3 identity
    // continuity: the pending-time preview (above, in sendManagerMessage)
    // already rendered these exact steps as dashed "proposed" drafts/chains/
    // joins (irToProposedCanvas, same ids). Accepting flips the SELECTED
    // subset to active IN PLACE (canvasStore's acceptProposedSteps) — same
    // id, same object, same position, never a delete+recreate — and drops
    // any unselected/rejected step's ghost outright ("seules les étapes
    // validées sont matérialisées"). Falls back to the pre-chantier-3
    // fresh-compile path only when no preview exists for this planId (the
    // preview step failed earlier, or this orchestrator predates chantier 3)
    // so materialization never silently does nothing.
    // Filter steps if opts.stepIds is provided (partial execution) — full
    // transitive closure via closeStepDependencies (orchestratorState.ts),
    // the SAME helper the execute_plan action handler uses for its own
    // seed set, so this materialized subset and what actually executes
    // can never diverge (see that helper's own doc comment).
    const orchToCompile = opts?.stepIds && opts.stepIds.length > 0
      ? { ...orch, steps: closeStepDependencies(orch.steps, opts.stepIds) }
      : orch;
    // B33 — may be narrowed to survivors when some drafts fail to land.
    let execStepIds: string[] | undefined;
    try {
      const canvasState = canvasStoreVanilla.getState();
      const acceptedStepIds = opts?.stepIds && opts.stepIds.length > 0
        ? orchToCompile.steps.map((s) => s.id)
        : null; // null = accept every step tagged with this planId (full validation)
      const hadPreview = canvasState.drafts.some((d) => d.proposedPlanId === planId);

      if (hadPreview) {
        canvasState.acceptProposedSteps(planId, acceptedStepIds);
      } else {
        const ir = compileOrchestratorToIr(orchToCompile);
        const { drafts, chains, routers, joins } = irToCanvas(ir);
        for (const draft of drafts) canvasState.addDraft(draft);
        for (const chain of chains) canvasState.addChain(chain);
        for (const router of routers) canvasState.addRouter(router);
        for (const join of joins) canvasState.addJoin(join);
      }
      // 2026-08-04 (UC3 "drafts en double" dogfood fix — canvas showed TWO
      // stacked plan previews plus the real missions): validating a plan is
      // the user's answer to every OTHER pending proposal too. Mark this
      // planId validated (a LATE async preview for it — the generate_plan
      // turn's addProposalPreview landing after this click — then no-ops,
      // see canvasStore's `validatedPlanIds`) and sweep any leftover preview
      // of a DIFFERENT plan off the canvas (clearProposedExcept), so the
      // validated steps are the only draft set left.
      markPlanValidated(planId);
      canvasState.clearProposedExcept(planId);

      // B3 / B33 — never cancel the whole plan when a single draft failed to
      // land. Partition survivors vs missing; launch what we have; only
      // revert when NOTHING materialized.
      const { drafts: expectedDrafts } = irToCanvas(compileOrchestratorToIr(orchToCompile));
      const survivingIds = new Set(canvasStoreVanilla.getState().drafts.map((d) => d.id));
      const partition = partitionMaterializedDrafts({
        expectedIds: expectedDrafts.map((d) => d.id),
        survivingIds,
      });
      if (!partition.canLaunch) {
        revertToPendingWithError(
          `No steps could be materialized on the canvas (${partition.missingIds.join(', ')}) — launch cancelled.`,
        );
        return;
      }
      if (partition.missingIds.length > 0) {
        toast(
          `Some plan steps could not be materialized (${partition.missingIds.join(', ')}) — launching the rest.`,
          'info',
          6000,
        );
      }
      // Prefer surviving drafts when partial; otherwise keep the caller's
      // explicit stepIds (full validation → undefined = every step).
      execStepIds =
        partition.missingIds.length > 0
          ? partition.launchIds
          : opts?.stepIds;

      // Arrange + highlight + focus the materialized nodes. 2026-08-04
      // (UC3 dogfood — "le canvas montre pas automatiquement ce qu'il
      // faut"): focus the PROJECT ZONE (the whole zone, every step at once)
      // instead of a single draft, so the camera lands on the full graph
      // the user just validated — never on one node in a void at 17% zoom.
      const materializedRefs = partition.launchIds.map((id) => makeRef('draft', id));
      if (materializedRefs.length > 0) {
        // PLAN-VS-CANVAS PARITY FIX (2026-08-08, real-user report): the
        // proposal preview is already laid out with the SAME elkjs
        // PREVIEW_LAYERED_OPTIONS as the chat graph (see sendManagerMessage's
        // preview block) and acceptProposedSteps keeps those exact positions
        // in place — so a full plan validation must NOT re-run `canvas:arrange
        // mode auto` (layoutAll → wide LAYERED_OPTIONS) which used to scatter
        // the agents into a completely different arrangement than the graph
        // the user just approved. Only the FALLBACK materialization path (no
        // preview existed — `hadPreview` false) still needs an arrange to
        // give the fresh nodes real positions.
        if (!hadPreview) {
          emit('canvas:arrange', { mode: 'auto' });
        }
        emit('canvas:highlight', { refs: materializedRefs });
        emit('canvas:focus', { ref: makeRef('project', projectIdFromRoot(projectRoot)) });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      revertToPendingWithError(`Plan materialization failed: ${reason.slice(0, 100)}`);
      return; // Do NOT start SGR if materialize failed
    }

    // Then execute the plan (SGR runtime) — pass the FULL accepted stepIds
    // set (not just its first element): execute_plan's own handler closes
    // over transitive deps per-seed the same way orchToCompile above just
    // did, so every explicitly accepted step actually runs, not only the
    // one that happens to be first in selection order (see
    // closeStepDependencies' doc comment, orchestratorState.ts).
    //
    // B2 fix — execute_plan's own try/catch already swallows every failure
    // into a toast and resolves normally either way (denied by the gate,
    // plan not found, a thrown exception, or a graph run that never
    // launched a single real mission), so "this await didn't throw" is NOT
    // evidence of a real effect. Its return value's `failed` flag is the
    // one honest signal — see ManagerActionRealResult's own doc comment.
    // B33: when some drafts were missing, execStepIds is the survivor set.
    const execOutcome = await executeManagerActionRef.current(
      { type: 'execute_plan', planId, stepIds: execStepIds },
      'ui',
      new Map(),
      conversationId,
    );
    if (execOutcome && 'failed' in execOutcome && execOutcome.failed) {
      revertToPendingWithError(execOutcome.message ?? `Plan ${planId} execution failed.`);
      return;
    }

    // Real success, confirmed by execute_plan's own outcome — only NOW is
    // the card honestly allowed to read 'accepted'.
    setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
      m.proposal?.planId === planId && m.proposal.state === 'launching'
        ? { ...m, proposal: { ...m.proposal, state: 'accepted' as const } }
        : m,
    ));
  }, [executeManagerActionRef, stateRef, t, toast]);

  const revisePlan = useCallback(async (planId: string) => {
    // resolveOrchestratorRoot — see execute_plan's own doc comment on this
    // helper (the plan may target a non-active project).
    const projectRoot = await resolveOrchestratorRoot(planId);
    const existing = await getOrchestrator(projectRoot, planId);
    if (!existing) {
      toast(`Plan ${planId} not found`, 'error');
      return;
    }
    await updateOrchestrator(projectRoot, planId, { status: 'planning' });
    // Chantier 3 (plan-first canvas) — "Modifier" discards THIS drawn
    // proposal preview: the user's revised text will produce a brand new
    // generate_plan (new planId), so the OLD dashed ghosts must not linger
    // on the canvas forever (rejectProposedPlan is a no-op if nothing was
    // ever previewed for this planId).
    canvasStoreVanilla.getState().rejectProposedPlan(planId);
    // C: Shrink overlay + prefill composer with the plan's objective for revision
    emit('manager:shrinkOverlay', undefined);
    emit('manager:prefill', { text: existing.objective, expand: true });
    toast(`Plan ${planId} returned to planning for revision`, 'info');
  }, []);

  const rejectPlan = useCallback(async (planId: string) => {
    // resolveOrchestratorRoot — see execute_plan's own doc comment on this
    // helper (the plan may target a non-active project).
    const projectRoot = await resolveOrchestratorRoot(planId);
    const removed = await deleteOrchestrator(projectRoot, planId);
    if (!removed) {
      toast(`Plan ${planId} not found`, 'warning');
      return;
    }
    // Chantier 3 (plan-first canvas) — the proposed drafts/chains/joins
    // previewed for this plan must disappear too, never linger as orphaned
    // ghosts (no-op if nothing was ever previewed for this planId).
    canvasStoreVanilla.getState().rejectProposedPlan(planId);
    // Mark the proposal as rejected on the message — find which open
    // conversation proposed it (same lookup as executePlan above).
    const conversationId = findConversationIdForMessage(
      stateRef.current,
      (m) => m.proposal?.planId === planId && m.proposal.state === 'pending',
    );
    if (conversationId) {
      setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
        m.proposal?.planId === planId && m.proposal.state === 'pending'
          ? { ...m, proposal: { ...m.proposal, state: 'rejected' as const } }
          : m,
      ));
    }
    toast(`Plan ${planId} rejected and removed`, 'warning');
  }, []);

  // Feature E (2026-08-04 — "une petite chip sur chaque agent pour choisir le
  // modèle avec lequel il devrait se lancer", owner request): per-step model
  // override on a still-PENDING plan, from the GraphProposalCard's step list.
  // Persists onto the orchestrator (updateOrchestratorStep → the SAME
  // `model`/`modelId` fields launchOptsFromNode already threads through
  // StepContract into resolveManagerModelId at launch time), mirrors it into
  // the store's orchestrators copy AND the proposal message's steps so the
  // card and the executor can never disagree. Pending-only by construction:
  // the card only renders the picker while `proposal.state === 'pending'`.
  const setStepModel = useCallback(async (planId: string, stepId: string, modelId: string) => {
    const projectRoot = await resolveOrchestratorRoot(planId).catch(() => null);
    if (!projectRoot) {
      toast(`Plan ${planId} root not found`, 'error');
      return;
    }
    const orch = await getOrchestrator(projectRoot, planId);
    if (!orch) {
      toast(`Plan ${planId} not found`, 'error');
      return;
    }
    const step = orch.steps.find((s) => s.id === stepId);
    if (!step) return;
    // modelId → display label via the same picker the header uses, so the
    // persisted `model` stays a human label, never an id (same convention as
    // generate_plan's own stamping). Covers the OpenRouter catalog (Claude
    // Pro ids) AND the BYOK group (deepseek-chat, deepseek-reasoner, ...).
    const label = (() => {
      const orModel = findOpenRouterModel(modelId);
      if (orModel) return orModel.label;
      for (const group of buildModelPickerOptions(detectModelEntitlements()).groups) {
        const m = group.models.find((x) => x.id === modelId);
        if (m) return m.label;
      }
      return modelId;
    })();
    const updated = await updateOrchestratorStep(projectRoot, planId, stepId, { modelId, model: label });
    if (!updated) {
      toast(`Could not update step ${stepId}`, 'error');
      return;
    }
    setState((prev) => ({
      ...prev,
      orchestrators: prev.orchestrators.map((o) =>
        o.id === planId
          ? { ...o, steps: o.steps.map((s) => (s.id === stepId ? { ...s, modelId, model: label } : s)) }
          : o,
      ),
    }));
    // Mirror into the proposal message so the card's own chip reflects the
    // new selection (message steps are the card's render source).
    const conversationId = findConversationIdForMessage(
      stateRef.current,
      (m) => m.proposal?.planId === planId && m.proposal.state === 'pending',
    );
    if (conversationId) {
      setState((prev) => mapConversationMessages(prev, conversationId, (m) =>
        m.proposal?.planId === planId && m.proposal.state === 'pending'
          ? {
              ...m,
              proposal: {
                ...m.proposal,
                steps: m.proposal.steps.map((s) => (s.id === stepId ? { ...s, modelId, model: label } : s)),
              },
            }
          : m,
      ));
    }
  }, []);

  // Backward-compat mirrors of the ACTIVE conversation — see
  // AgentsStoreValue.managerMessages/managerBusy/managerPhase/
  // managerElapsedMs/pendingApprovals's own doc comments. Read fresh every
  // render straight off `state`, never off stateRef (this is render-time
  // derivation, not an event-handler closure).
  const activeConversation = state.conversations[state.activeConversationId];

  // Perf fix (cockpit hot-spot mission) — see AgentsStoreActionsValue's doc
  // comment above. Every one of these is already a useCallback with its own
  // (independently correct, pre-existing) dependency array, so this object
  // itself only gets a new identity when one of THOSE actually changed —
  // never merely because AgentsStoreProvider re-rendered or `state` ticked.
  const actionsValue: AgentsStoreActionsValue = useMemo(() => ({
    setActiveConversationId,
    addMission,
    updateMission,
    stopMission,
    pauseMission,
    resumeMission,
    interveneMission,
    takeoverMission,
    returnFromTakeover,
    approveMission,
    discardMission,
    revertMission,
    forkMissionFromCheckpoint,
    setSelectedMissionId,
    toggleLoop,
    skipLoopNextRun,
    deleteLoop,
    freezeLoopTemplate,
    recordExternalMetric,
    stopAll,
    retryMission,
    deleteMission,
    archiveMission,
    archiveTerminalMissions,
    stopManagerMessage,
    closeManagerConversation,
    renameManagerConversation,
    clearManagerMessages,
    newManagerConversation,
    loadManagerSession,
    deleteManagerSession,
    setManagerModel,
    setAutonomyLevel,
    approvePendingAction,
    rejectPendingAction,
    approveAllPendingActions,
    rejectAllPendingActions,
    changeApprovalMode,
    executePlan,
    revisePlan,
    rejectPlan,
    setStepModel,
  }), [
    setActiveConversationId,
    addMission,
    updateMission,
    stopMission,
    pauseMission,
    resumeMission,
    interveneMission,
    takeoverMission,
    returnFromTakeover,
    approveMission,
    discardMission,
    revertMission,
    forkMissionFromCheckpoint,
    setSelectedMissionId,
    toggleLoop,
    skipLoopNextRun,
    deleteLoop,
    freezeLoopTemplate,
    recordExternalMetric,
    stopAll,
    retryMission,
    deleteMission,
    archiveMission,
    archiveTerminalMissions,
    stopManagerMessage,
    closeManagerConversation,
    renameManagerConversation,
    clearManagerMessages,
    newManagerConversation,
    loadManagerSession,
    deleteManagerSession,
    setManagerModel,
    setAutonomyLevel,
    approvePendingAction,
    rejectPendingAction,
    approveAllPendingActions,
    rejectAllPendingActions,
    changeApprovalMode,
    executePlan,
    revisePlan,
    rejectPlan,
    setStepModel,
  ]);

  // Perf fix — memoized on `state` (the immutable reducer state: a new
  // top-level reference on every actual change, the SAME reference
  // otherwise) plus the two pieces built outside `state`
  // (actionsValue/managerSessions), so a Provider re-render that changes
  // NEITHER never rebuilds this object or its Context identity. A live
  // elapsedMs tick still recomputes it — `state.conversations` genuinely
  // changes every second while a manager turn is running, and every one of
  // the ~70 existing useAgentsStore() consumers reads from this SAME
  // Context — see AgentsStoreActionsValue's doc comment for why
  // useAgentsStoreActions() is the real fix for that case, not this memo.
  const value: AgentsStoreValue = useMemo(() => ({
    ...state,
    managerMessages: activeConversation?.messages ?? [],
    managerBusy: activeConversation?.busy ?? false,
    managerPhase: activeConversation?.phase ?? 'idle',
    managerElapsedMs: activeConversation?.elapsedMs ?? 0,
    pendingApprovals: activeConversation?.pendingApprovals ?? [],
    managerSessions,
    // Not in actionsValue — see AgentsStoreActionsValue's doc comment
    // (both depend on `state.conversations` themselves, so they are already
    // covered by `state` below, same as every other `...state` field).
    sendManagerMessage,
    clearCanvasDirect,
    ...actionsValue,
  }), [state, activeConversation, actionsValue, managerSessions, sendManagerMessage, clearCanvasDirect]);

  return (
    <AgentsActionsContext.Provider value={actionsValue}>
      <AgentsMissionsContext.Provider value={state.missions}>
        <AgentsStoreContext.Provider value={value}>
          {children}
        </AgentsStoreContext.Provider>
      </AgentsMissionsContext.Provider>
    </AgentsActionsContext.Provider>
  );
}
