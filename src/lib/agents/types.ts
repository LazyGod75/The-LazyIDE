/* Shared agent/mission types — used by mock data, runtime, evaluator, and UI. */

/** Mission lifecycle status.
 *
 *  Terminal statuses (mission is permanently finished):
 *    - `done`   — completed successfully and merged
 *    - `failed` — completed with an error
 *    - `cancelled` — aborted by user or system
 *
 *  Paused statuses (mission is waiting for a decision, NOT terminal):
 *    - `review`      — work complete, awaiting human approval before merge
 *    - `interrupted` — paused by an external signal (not yet used in all paths)
 *    - `blocked`     — waiting on a dependency (not yet used in all paths)
 *
 *  Active statuses:
 *    - `queued`  — created but not yet started
 *    - `running` — currently executing
 */
export type MissionStatus = 'queued' | 'running' | 'review' | 'done' | 'failed' | 'cancelled';

// ── Judge / Reviewer verdict types (CONTRACT-D) ───────────────────

export type ReviewerRole = 'tester' | 'reviewer' | 'security' | 'judge';
export type VerdictOutcome = 'approve' | 'request_changes' | 'reject';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ReviewerVerdict {
  role: ReviewerRole;
  verdict: VerdictOutcome;
  summary: string;
  score?: number;
  /**
   * True when this sub-agent could NOT run because of an evaluator
   * INFRASTRUCTURE failure (agent_run rejected, the CLI/plan-mode blocked
   * execution, the test shell failed, the worktree path was invalid…), rather
   * than because it found a problem with the change. Such a verdict is a
   * NON-VOTE: "the evaluator could not run the tests" is not "the change is
   * bad", so aggregateVerdict must never treat it as a code rejection or let
   * it pull the score toward 0 (see DEFECT 1). The `verdict` field is still
   * populated (usually 'request_changes') for display/back-compat, but
   * `inconclusive` is what the scoring logic keys off.
   */
  inconclusive?: boolean;
}

export interface JudgeVerdict {
  score: number;
  passed: boolean;
  risk: RiskLevel;
  reviewers: ReviewerVerdict[];
  tests?: { passed: number; failed: number };
  createdAt: string;
  /**
   * R11 (judge-score honesty) — true when NEITHER the judge NOR any
   * conclusive reviewer produced a real, parsable numeric score (evaluator.ts's
   * `aggregateVerdict`/`evaluateScripted`) — the case that used to render as a
   * fabricated « Verdict 0/100 » on what could genuinely be a PASSING mission
   * (the judge's raw text failed to parse as JSON, but a crude keyword-scan
   * heuristic still detected "approve" in it). `score` still carries `0` in
   * this case (kept for every existing numeric consumer — loopEngine.ts's
   * `minScore` comparisons, managerAdvice.ts/learningLoop.ts's display text,
   * etc. — none of which are prepared for an absent number), but that `0` is
   * a PLACEHOLDER, not a real evaluation — never display it. The canvas
   * node's `VerdictChip` (chrome/nodeChrome.tsx) is the one place this flag
   * is honored today: it renders « Verdict — » instead of the score when
   * this is `true`. Absent (or `false`) means a real number is present,
   * either the judge's own parsed score or an honest average of the
   * conclusive reviewers' scores.
   */
  scoreUnavailable?: boolean;
}

export interface PlanStep {
  label: string;
  state: 'done' | 'in_progress' | 'todo';
  meta?: string;
}

export interface ActionEvent {
  time: string;
  text: string;
  isLive?: boolean;
  /** Locale-independent control-flow. `error` replaces matching the
   *  hardcoded "Erreur agent:" prefix. `pause` marks a native CLI
   *  stop-then-resume (worktree kept). */
  kind?: 'error' | 'pause' | 'info';
}

export interface DiffFile {
  filename: string;
  added: number;
  removed: number;
  inProgress?: boolean;
}

export interface BrainCitation {
  id: string;
  label: string;
}

export interface CostSegment {
  label: string;
  widthPct: number;
  color: string;
}

export interface SubAgent {
  name: string;
  status: 'running' | 'queued' | 'done' | 'failed';
}

export interface AgentMetrics {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCount: number;
  /**
   * Managed-loop only (see agents/runtime.ts's AgentMetrics and
   * managedAgent.ts's emitMetrics): whether inputTokens/outputTokens/costUsd
   * are real settled usage, a ceil(chars/4) estimate, or a mix of both
   * across the mission's turns. Undefined for native (Rust agent_run)
   * missions, whose numbers are always exact.
   */
  tokensSource?: 'real' | 'estimated' | 'mixed';
  /**
   * Prompt-cache READ tokens (M12 dogfood fix, undercount honesty): real
   * tokens the model read from Anthropic's prompt cache rather than freshly
   * processing — billed at a reduced rate, but not free, and previously
   * silently absent from `inputTokens` (observed: "22 input tokens for 22
   * tool calls" — a ReAct loop resending the same system prompt/tools every
   * turn is exactly the caching-heavy shape). Native-CLI only for now (see
   * agent.rs's parse_result_usage); undefined — never 0 — when the backend
   * never reported the field at all, so a UI consumer can tell "genuinely
   * zero cache reads this run" apart from "this backend doesn't surface the
   * metric" and label the field honestly either way (e.g. an "entrée (hors
   * cache)" caveat when undefined) instead of silently under-reporting.
   */
  cacheReadInputTokens?: number;
  /** P4.2 — claude CLI session ID for resume. undefined when not reported. */
  sessionId?: string;
}

export interface Mission {
  id: string;
  title: string;
  status: MissionStatus;
  /**
   * Permission mode this mission's agent runs with — forwarded unchanged
   * from NewMissionInput.permissionMode by addMission (R13 follow-up,
   * 2026-08-03): the constructor used to drop it, so runMission received
   * undefined, fell back to 'default', and the native claude CLI (in
   * non-interactive -p mode) refused every Write/Edit — producing a
   * guaranteed empty deliverable. Persisted so retries/relaunches reuse
   * the same mode.
   */
  permissionMode?: 'plan' | 'acceptEdits' | 'full';
  /**
   * Human-readable reason for the current status (v0.1.5 failure honesty).
   * Set when a mission flips to 'failed' outside the normal agent loop
   * (e.g. the pre-'running' window rejects: brain-recall / plan-compile /
   * start) so the card can explain WHY instead of freezing silently.
   */
  statusReason?: string;
  /**
   * Epoch ms when the mission was created (addMission). Drives the queued
   * card's "taking longer than expected" hint — no store writes involved.
   */
  createdAt?: number;
  /**
   * Stable identity of this mission's OWNING project — the resolved,
   * absolute repo root `addMission` launched it against (the same
   * `repoPath` it resolves via `resolveProjectRoot`/an explicit target),
   * stamped ONCE at creation and NEVER re-derived from whichever project
   * happens to be ACTIVE later.
   *
   * Fixes a real project_id drift (2026-08-04 prod incident, missions
   * drifting onto "Lazy-real-test"): the debounce-save journaling effect
   * (agentsStore.tsx) used to stamp EVERY changed mission with
   * `projectIdFromRoot(await resolveProjectRoot())` — the CURRENTLY active
   * project — computed ONCE per cycle and applied to the whole batch,
   * regardless of which project actually launched each mission. A mission
   * belonging to project A got silently re-owned by project B's journal
   * rows the moment the user switched the active project and anything
   * about mission A changed (even a live-status tick). That effect now
   * resolves `projectIdFromRoot(mission.repoRoot ?? <active-root-fallback>)`
   * PER MISSION inside its loop instead — see its own doc comment.
   *
   * Absent on a mission created before this field existed (or one whose
   * creation path could not resolve a root): such a mission keeps the OLD
   * active-project fallback behavior unchanged for journaling purposes —
   * never a fabricated backfill.
   */
  repoRoot?: string;
  model: string;
  worktree?: string;
  /**
   * Branch this mission's worktree must be created FROM, instead of the
   * default (current HEAD of the target repo). See
   * OrchestratorPlanStepInput.baseBranch's doc comment for the full
   * rationale and thread — this is the terminal field that thread lands
   * on before runtime.ts's runMission passes it to createWorktree.
   * Forwarded unchanged from NewMissionInput.baseBranch by addMission
   * (agentsStore.tsx). Absent/undefined = today's unchanged behaviour
   * (worktree branches off the repo's current HEAD).
   */
  baseBranch?: string;
  /**
   * Additional branches to merge INTO this mission's worktree, right after
   * it is created from `baseBranch` (dependency-inheritance fan-in — see
   * graph/runGraph.ts's `resolveInheritedBranches` for the full rationale).
   * Set when a plan step has more than one `dependsOn` upstream step: the
   * worktree starts from the FIRST resolved upstream branch (`baseBranch`)
   * and merges every OTHER upstream branch in via a real `git merge`
   * (agent_create_worktree_inner, src-tauri/src/commands/git.rs) — never a
   * silent "pick one, drop the rest". A merge conflict fails the mission
   * explicitly, naming the conflicting branch, before any agent work starts.
   * Absent/empty = today's unchanged single-ancestor worktree.
   */
  mergeBranches?: string[];
  /**
   * Cross-project READ access (confirmed gap, live run — see run.rs's
   * `agent_run` module doc comment): extra project roots this mission's
   * agent may READ from, beyond its own worktree. Before this field
   * existed, `Command::current_dir(&worktree_path)` (run.rs) was the ONLY
   * confinement a native mission got — no `--add-dir` was ever passed, so
   * a mission rooted at project B had literally no way to read project A's
   * source, even when the task said to. Absolute, already-resolved project
   * roots — NEVER a raw project id/name (that resolution happens upstream,
   * in the `launch_mission` executor, from ManagerAction.launch_mission's
   * `extraReadableProjectIds`; see that field's own doc comment for the
   * resolve-by-id-or-name step). Forwarded unchanged from
   * NewMissionInput.extraReadableRoots by addMission, then by runtime.ts's
   * runMission into `agent_run`'s request payload as `extraReadableRoots`
   * (camelCase — AgentRunRequest, protocol.rs).
   *
   * SECURITY: this is a DECLARATION, not a grant by itself — `agent_run`
   * (run.rs) independently re-validates every entry against the live
   * `ProjectRegistry` before wiring anything, and rejects the WHOLE mission
   * launch if any declared root is not a currently open project. A stale
   * or hand-edited value here can therefore never widen a mission's reach
   * past what is genuinely open right now. Each granted root gets a
   * `--add-dir` (READ, no prompts) paired with a generated `--settings`
   * file denying `Edit`/`Write` under it, so the read grant can never
   * become a write grant even under `acceptEdits` — see run.rs's
   * `extra_roots.rs` for the exact mechanism and its one known limitation
   * (an arbitrary subprocess the agent spawns is not constrained by this).
   * Absent/empty = today's unchanged worktree-only read/write scope.
   */
  extraReadableRoots?: string[];
  cost?: string;
  progress?: number;
  filesCount?: number;
  dependsOn?: string[];
  liveAction?: string;
  isOrchestrator?: boolean;
  subAgents?: SubAgent[];
  diffAdded?: number;
  diffRemoved?: number;
  judgesApproved?: string;
  merged?: boolean;
  /**
   * Merge commit sha captured at approve time (agent_merge_worktree).
   * Absent for missions merged before this shipped, or approved without a
   * real git backend. Needed so revert can `git revert` the merge commit.
   */
  mergeSha?: string;
  /**
   * True once revertMission has reverted this mission's merge commit.
   * Status stays 'done' — this is a flag, not a new lifecycle stage.
   */
  reverted?: boolean;
  /**
   * True while a RUNNING managed mission is paused between ReAct steps
   * (see agentsStore.pauseMission/resumeMission and
   * managedAgent.planAndActManaged's pauseSignal poll).
   * Deliberately a flag, NOT a new MissionStatus value — status stays
   * 'running' throughout a pause (pause is a sub-state of running, not a
   * new lifecycle stage), so every existing `status === 'running'` check
   * across the app (board/list/timeline/calendar columns) keeps working
   * unchanged. Native (one-shot `claude -p`) missions never set this — see
   * the engine guard in agentsStore.pauseMission.
   */
  paused?: boolean;
  planSteps?: PlanStep[];
  actionTimeline?: ActionEvent[];
  diffFiles?: DiffFile[];
  diffSnippet?: string[];
  /**
   * Trust-critical defect #1 (M53 forensics) — paths `reviewPreflight.ts`'s
   * detectDiffCoverageGap found in the worktree's real `git status` (real
   * content: untracked/added/modified) that are NOT reflected anywhere in
   * `diffFiles` above. Populated by runtime.ts's Step C right after the diff
   * is computed; when non-empty, evaluateMission (evaluator.ts) refuses to
   * run the normal judge pipeline against this mission and returns an
   * explicit "diff incomplete" verdict instead — never a confident verdict
   * built from a diff that silently excludes part of the agent's own
   * output. Absent/empty = the diff genuinely represents everything git
   * saw (the overwhelming common case).
   */
  diffIncompleteFiles?: string[];
  /**
   * Trust-critical defect #2 (M2 forensics, lazy-backoffice) — true when
   * runtime.ts's Step C found the mission's diff genuinely EMPTY (no
   * diffFiles, no diffSnippet, no diffAdded/diffRemoved — not merely
   * INCOMPLETE, see diffIncompleteFiles above, which is about a diff that
   * has SOME content but is missing files git can see) AND the mission does
   * not read as a diff-less verification/investigation task
   * (evaluator.ts's isVerificationMission — the one legitimate exception,
   * whose own contract expects a report/command-output, not code). When
   * true, evaluateMission (evaluator.ts) refuses to run the tester/reviewer/
   * security/judge pipeline and returns an explicit "nothing was delivered"
   * verdict instead. Real case: mission M2 ("Consolider la base de code…")
   * produced a worktree containing only the pre-existing README.md — zero
   * commits, diffFiles === [] — yet still collected a security "approve"
   * ("no code = no security risk, by construction") and a final judge
   * approval leaning on that vacuous approval as positive evidence (1/2
   * approve on a mission that did nothing). Absent/false = the diff has
   * real content, or this genuinely is a diff-less verification mission.
   */
  emptyDeliverable?: boolean;
  brainCitations?: BrainCitation[];
  tokensSaved?: string;
  totalCost?: string;
  totalTokens?: string;
  costSegments?: CostSegment[];
  calendarDay?: number;
  calendarDate?: number;
  ganttStart?: number;
  ganttWidth?: number;
  ganttSubAgentBars?: Array<{ start: number; width: number }>;
  duration?: string;
  /** Full task prompt to use as agent input (overrides title when present). */
  agentTask?: string;
  /**
   * Retry-with-edit friction fix — the task text this mission REPLACED when
   * retryMission's `opts.newTask` corrected a previous bad/ambiguous
   * instruction, instead of forcing a clone_mission detour just to fix
   * wording. Preserves the ORIGINAL wording an earlier verdict was actually
   * judged against — a retry must never silently erase what was already
   * run, even when the new text supersedes it. Absent = this mission's task
   * was never amended by a retry (the common case, including a plain retry
   * with no edit).
   */
  taskAmendedFrom?: string;
  /** Named sub-agent to route the run through (e.g. agent name from library). */
  agentName?: string;
  /**
   * Custom agent persona (LazyBot runs) — forwarded by runMission to the
   * managed loop's resolveAgentPersona (planAndActManaged's
   * agentSystemPrompt). Composed by botEngine.buildBotSystemPrompt from the
   * bot's own systemPrompt + policy/capability blocks. Absent for every
   * non-bot mission (the loop then resolves the persona from agentName or
   * its default, unchanged).
   */
  agentSystemPrompt?: string;
  /**
   * Cloud approval-gate autonomy for a LazyBot run (botEngine threading) —
   * 'manual' gates every non-readonly cloud action, 'supervised' uses the
   * class/rules (default), 'yolo' gates only credentials. Forwarded by
   * runMission to planAndActManaged's `autonomy` opt. Absent for non-bot
   * missions (the gate keeps its own default).
   */
  botAutonomy?: 'manual' | 'supervised' | 'yolo';
  /**
   * Set when this mission is a LazyBot run (botEngine.launchBotRun) — keys
   * the bot-engine runtime tracking (canvas bot-node working/waiting halo,
   * list_lazybots activeRuns, stop_lazybot) and the Solari session cleanup
   * hook in addMission's launch chain.
   */
  botId?: string;
  /**
   * Full evaluation verdict from the judge pipeline.
   * When present, judgesApproved is derived from it for backward-compatibility.
   */
  judgeVerdict?: JudgeVerdict;
  /**
   * Per-run observability metrics emitted by the Rust agent runner.
   * Only present after a live run (Tauri + claude CLI). Absent for mock/demo missions.
   */
  agentMetrics?: AgentMetrics;
  /**
   * Compiled workflow plan (stage contracts + graph).
   * Set by the plan compiler before execution begins.
   * When present, planSteps is derived from it for UI backward-compatibility.
   */
  compiledPlan?: import('./stageContract.js').CompiledPlan;
  /**
   * Learning insights generated by the post-completion learning loop.
   * Fed back to LazyBrain for continuous improvement.
   */
  learningInsights?: import('./learningLoop.js').LearningInsight[];
  /**
   * Whether the plan was adapted by brain context.
   * True when the plan compiler detected relevant brain patterns and modified the workflow.
   */
  brainAdapted?: boolean;
  /**
   * Parent mission id when this mission was spawned as a sub-mission by an
   * orchestrator (spec §7.2, T1.5). Absent for user-launched missions.
   * Sub-missions are real Missions in the store, linked by this field.
   */
  parentMissionId?: string;
  /** T1.8 — True when the user has taken over this mission (baton-pass). */
  takenOver?: boolean;
  // ── Loop engineering fields ───────────────────────────────────────
  /** Loop configuration when this mission is a recurring loop. */
  loopConfig?: LoopConfig;
  /** When this is a loop iteration, the parent loop mission id. */
  loopParentId?: string;
  /** Iteration number when this is a loop child (1-based). */
  loopIteration?: number;
  /**
   * Formalized launch contract (spec §8): objective, scope, budget, proof
   * requirements, gates, and team-sharing sign-off. Optional/additive —
   * missions created before T1.2 (and mock/demo missions) never set this.
   * See `MissionContract` below for the full shape.
   */
  contract?: MissionContract;
  /**
   * Proof-of-work evidence actually attached by the agent at runtime (spec
   * §8, T1.4) — the produced counterpart to `contract.proofs`'s requested
   * kinds. Populated incrementally via `runMission`'s `onUpdate` (native:
   * parsed once from the final transcript by `proofs.ts`'s
   * `parseProofBlocks`; managed: appended once per `attach_proof` tool
   * call — see managedAgent.ts). Checked against `contract.proofs` by
   * `proofs.ts`'s `hasRequiredProofs`/`missingProofKinds`, enforced as the
   * Done gate in `approveGate.ts`. See `ProofArtifact` below for the shape.
   */
  proofs?: ProofArtifact[];
  /**
   * R4b fix ("ghost queue runs" — stale queued missions auto-billing on a
   * later boot): true when this mission is still 'queued', was created more
   * than missionQueue.ts's STALE_QUEUE_THRESHOLD_MS (24h) ago, and never
   * actually started. Computed at boot (agentsStore.tsx's boot effect, from
   * `createdAt`) and mirrored into missionQueue.ts's own durable queue file
   * via markStaleQueuedMissions, which gates dequeue()'s auto-pickup.
   * Read-model only — never flips status or drops history; a card should
   * render this as "en file (ancienne)" with an explicit "Relancer"
   * affordance rather than auto-launching.
   */
  queueStale?: boolean;
  /**
   * Boot-resilience idempotency stamp (product requirement — "agents must
   * succeed, the app recovers on its own"): true once agentsStore.tsx's
   * boot-time auto-retry effect has fired exactly ONE automatic
   * `retryMission` call for this mission after it was flipped to 'failed'
   * with `agents.recoveredOnRestart` (applyReplayRecovery / the legacy
   * missions.json fallback — a mission an app restart interrupted
   * mid-run, whose contract explicitly opted OUT of human approval via
   * `contract.gates.humanApprove === false`). Checked BEFORE that effect
   * ever calls retryMission again for this same id — never a restart ->
   * retry -> restart loop, including across further app restarts, since
   * this is a real, persisted/journaled Mission field, not session-only
   * state. Absent/false = never auto-retried (the overwhelming common
   * case: no contract, humanApprove not explicitly false, or genuinely
   * never interrupted). Reset to `undefined` on every `retryMission` clone
   * (see that function's own "a retried mission starts fresh" fields) so
   * the NEW mission this stamp spawns is itself eligible for its own
   * one-shot auto-retry if IT is later interrupted by a restart — bounded
   * by `autoRetryLineageDepth` below, since this stamp ALONE turned out not
   * to be enough (see that field's own doc comment for the incident).
   */
  autoRetriedAfterRestart?: boolean;
  /**
   * Lineage-wide auto-retry cap (2026-08-05 incident: an auto-retried
   * mission's CLONE never inherited `autoRetriedAfterRestart` — by design,
   * so the clone could earn its own one-shot auto-retry if IT were later
   * interrupted — but that also meant a clone interrupted in turn looked
   * exactly as fresh as the original to the boot-resilience effect, and got
   * auto-retried again, whose own clone did too, etc.: an unbounded restart
   * -> retry -> restart chain, M9 -> M10 -> M11 -> M12 -> M13, 5 clones in
   * one night, all unattended-contract missions dying and relaunching on
   * every app boot). This field is the real fix: this mission's depth
   * within its auto-retry lineage — 0 (absent) for a mission that has never
   * been auto-retry-cloned. The clone `retryMission` creates when invoked
   * BY the boot-resilience effect carries `(source.autoRetryLineageDepth ??
   * 0) + 1`, never inherited verbatim via a plain `{...original}` spread.
   * The boot-resilience effect's eligibility check refuses to schedule an
   * auto-retry once depth >= 1: ONE automatic relaunch per lineage, full
   * stop — any further interruption needs a human to retry it (always
   * still available, and unlimited). A MANUAL retry (the "Relancer" button,
   * the manager's retry_mission action) resets depth back to 0 on its
   * clone — a human re-launching a mission always starts a fresh lineage,
   * regardless of how deep the mission they retried already was.
   */
  autoRetryLineageDepth?: number;
  /**
   * R13 — mission lifecycle: true when the user archived this TERMINAL
   * mission (done/failed/cancelled, or done+merged) from the canvas context
   * menu. Additive, read-model-only flag — never destroys journal history:
   * the mission's own journal rows/events are untouched, so Replay/Rapport/
   * history projections (which read the journal directly, not the canvas
   * reconciler's filtered node list) keep counting and displaying it exactly
   * as before. Only the Agent Canvas reconciler (reconciler.ts) filters an
   * archived mission out of the live node set. Set via the real
   * `mission.archived` journal event (agentsStore.tsx's archiveMission) —
   * never a client-only toggle.
   */
  archived?: boolean;
  /**
   * W-CLOSE row 6 (canvas scorecard "single-node re-run in isolation") —
   * true for a mission launched via the canvas context menu's « Relancer en
   * isolation » action. The ONE real behavioral effect: chainEngine.ts's
   * `onMissionTerminal` returns before scanning for any outgoing chain to
   * fire, regardless of how this mission terminates — the whole point of an
   * isolated re-run is a side-effect-free look at "what would THIS agent
   * produce", never a live automation trigger. Set once at launch
   * (agentsStore.addMission, from NewMissionInput.isolated — itself set by
   * DraftSpec.isolated on the cloned draft, canvasTypes.ts) and never
   * flipped afterward. Absent (the overwhelming common case) behaves exactly
   * as before this field existed.
   */
  isolated?: boolean;
  /**
   * Multi-conversation LazyManager (wave 1) — id of the ManagerConversationState
   * (agentsStore.tsx) whose turn created this mission via executeManagerAction.
   * Purely additive/read-model: nothing currently branches on it. Lets a
   * future UI (canvas attribution chips, wave 2) show which live conversation
   * a mission came from. Absent for missions launched outside the manager
   * (canvas "new mission" flows, loop iterations, etc).
   */
  originConversationId?: string;
}

// ── Loop engineering types ─────────────────────────────────────────

export type LoopCadence = '1m' | '5m' | '15m' | '1h' | '6h' | '1d' | (string & {});

export type LoopStopCondition =
  | { kind: 'manual' }
  | { kind: 'maxIterations'; count: number }
  | { kind: 'untilDate'; date: string }
  | { kind: 'untilPass'; minScore: number };

export interface LoopConfig {
  cadence: LoopCadence;
  stopCondition: LoopStopCondition;
  enabled: boolean;
  /** ISO timestamp of last iteration launch. */
  lastRunAt?: string;
  /** ISO timestamp of next scheduled iteration. */
  nextRunAt?: string;
  /** Total iterations launched so far. */
  iterationCount: number;
  /** IDs of child missions spawned by this loop. */
  iterationMissionIds: string[];
  /**
   * Recurring regime lifecycle (charte de mission, spec §4) — ONLY
   * meaningful when this loop's originating charter had nature.kind
   * 'recurring'|'permanent' (see MissionNature's doc comment: a one-off task
   * never promotes, so this stays absent for it). Absent overall = a
   * pre-charter loop, unaffected.
   * States: 'trial' (every iteration needs human approval — see
   * trialApprovedCount/trialPromotionThreshold below) -> 'validated' (the
   * user said it's good; the promotion must be announced explicitly, never
   * silent) -> 'autonomous' (the manager may itself pause/adjust/retry/alert
   * without waiting on the human, who always keeps the hand to resume,
   * correct, or demote it) -> 'self_improving' (adjusts its own choices —
   * subjects/formats/timing — from `measure`; any such change must stay
   * visible in the periodic report, never applied quietly).
   * A first failure/anomaly, or a drop in `measure`, demotes this back to
   * 'trial' (or stops the loop outright via `enabled: false`) — never
   * silently; the manager must say so.
   */
  regimeState?: 'trial' | 'validated' | 'autonomous' | 'self_improving';
  /** Executions approved so far while regimeState is 'trial' — the visible counter (spec §4). */
  trialApprovedCount?: number;
  /** Approved-run threshold promoting 'trial' -> 'validated' (announced, never silent). */
  trialPromotionThreshold?: number;
  /** Named metric driving self-improvement — carried from the originating charter's LearningAndKillSwitch.measure. */
  measure?: string;
  /** Condition demoting this regime to 'trial' or stopping it — carried from LearningAndKillSwitch.killSwitch. */
  killSwitch?: string;
  /**
   * Ref to the validated template/gabarit artifact this loop consumes each
   * run — a versioned artifact, NEVER regenerated per iteration (spec §4:
   * "le gabarit validé stocké comme artefact versionné que la boucle
   * consomme, et jamais régénéré à chaque tour"). Opaque string (e.g. a
   * canvas ref or proof artifact path) — this module does not own artifact
   * storage.
   */
  templateArtifactRef?: string;
}

export interface LoopIterationResult {
  missionId: string;
  iteration: number;
  launchedAt: string;
  status: MissionStatus;
  score?: number;
  passed?: boolean;
}

// ── Orchestrator & learning types (ultime) ─────────────────────────

export type AutonomyMode = 'manual' | 'supervised' | 'yolo' | 'custom';

export interface AutonomyConfig {
  mode: AutonomyMode;
  budgetLimit?: number; // max cents per mission/plan (YOLO)
  allowedActions?: string[];
  deniedActions?: string[];
  crossProjectPolicy?: 'ask' | 'auto';
  deletePolicy?: 'ask' | 'auto';
  deployPolicy?: 'ask' | 'auto';
}

/** Step description received from the LLM before an orchestrator is minted. */
export interface OrchestratorPlanStepInput {
  id?: string;
  description: string;
  dependsOn?: string[];
  autonomyLevel?: 'manual' | 'supervised' | 'yolo';
  /** Rich contract fields (P2.1) — mapped into StepContract by compileOrchestratorToIr. */
  agentName?: string;
  model?: string;
  effort?: Effort;
  engine?: 'cli' | 'pro' | 'auto';
  budgetCapUsd?: number;
  maxDurationMs?: number;
  scopePaths?: string[];
  proofs?: ProofRequirement[];
  contestN?: number;
  critical?: boolean;
  /** Topology template role — maps to PSE (Planner→Specialist→Evaluator→Fix) patterns. */
  role?: 'worker' | 'evaluator' | 'fixer' | 'reflector';
  /** What to do when this step fails. 'fix' launches a fixer mission, 'retry' re-runs, 'route' follows a router, 'block' stops the plan, 'skip' continues. */
  onFail?: 'retry' | 'fix' | 'route' | 'block' | 'skip';
  /** Max attempts for retry/fix cycles. Default 2, hard cap 5. */
  maxAttempts?: number;
  /** Parallel cohort — steps with the same joinGroup and no mutual deps run in parallel, joined by an implicit JoinNode. */
  joinGroup?: string;
  /**
   * Exact catalog id (see the modelId contract doc comment above
   * ManagerEngineChoice below) naming ONE model precisely instead of a
   * `model` tier hint — set when the user names a provider/model explicitly
   * for this step, or a proven lesson shows one model outperforming others
   * on this kind of step. Takes priority over `model` at resolution time
   * (resolveManagerModelId, managerEngine.ts).
   *
   * WIRING: createOrchestrator maps `s.modelId`; compileOrchestrator.ts
   * threads it into StepContract; launchOptsFromNode carries
   * `contract.modelId` to the SGR launchMission callback (agentsStore).
   */
  modelId?: string;
  /**
   * Branch this step's worktree must be created FROM, instead of the
   * default (current HEAD of the target repo — today's unchanged
   * behaviour when omitted). Set this when the work to continue already
   * lives on another local branch (e.g. "integrate the scaffold from
   * agent/M40-w1-a-scaffold-auth-admin") — never describe that intent in
   * the step's `description` prose alone and hope the agent finds it.
   *
   * Real incident this fixes: two missions (M1, M2, lazy-backoffice)
   * asked to "integrate branch X" in prose; the worktree was silently
   * created from `main` (empty in that repo), so both agents delivered a
   * worktree containing only README.md. `baseBranch` makes the start
   * point an explicit, structural field instead of something the agent
   * has to infer from text.
   *
   * Validated HONESTLY, never silently: agent_create_worktree_inner
   * (src-tauri/src/commands/git.rs) verifies this branch exists BEFORE
   * creating anything and FAILS the mission with a reason naming the
   * missing branch — it never falls back to HEAD/main.
   *
   * Threaded: this field -> orchestratorState.ts's createOrchestrator
   * (OrchestratorPlanStep.baseBranch below) -> compileOrchestrator.ts's
   * stepToNode (StepContract.baseBranch, graph/types.ts) ->
   * sgrOrchestratorRunner.ts's launchOptsFromNode (SgrLaunchOpts.baseBranch)
   * -> agentsStore.tsx's SGR launchMission callback (addMission's
   * NewMissionInput.baseBranch) -> Mission.baseBranch -> runtime.ts's
   * runMission, which passes it to createWorktree as the start point.
   */
  baseBranch?: string;
  /**
   * Cross-project READ access for this step — project ids/names (same
   * resolve-by-id-or-name convention as ManagerAction.launch_mission's
   * `extraReadableProjectIds`, whose doc comment carries the full contract
   * and the security model) whose roots the mission this step launches may
   * READ from, beyond its own worktree. Set when the step's task
   * genuinely targets another open project's source.
   *
   * WIRING NOTE (same partial-wiring shape as `modelId` above): this field
   * is stored on the plan (this input type and its persisted
   * OrchestratorPlanStep counterpart below), but end-to-end delivery to a
   * mission LAUNCHED VIA THE GRAPH additionally requires
   * orchestratorState.ts's createOrchestrator (map it onto the created
   * OrchestratorPlanStep), graph/compileOrchestrator.ts (thread it into the
   * compiled StepContract), and graph/sgrOrchestratorRunner.ts's
   * SgrLaunchOpts + launchOptsFromNode (carry it through to the
   * launchMission callback) — none of those three files are touched by
   * this change. The DIRECT `launch_mission` manager action (agentsStore.tsx,
   * not the graph/orchestrator path) is fully wired end to end today via
   * its own `extraReadableProjectIds` field.
   */
  extraReadableProjectIds?: string[];
}

/** Persisted step inside an orchestrator plan. */
export interface OrchestratorPlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  missionIds: string[];
  dependsOn: string[];
  autonomyLevel: 'manual' | 'supervised' | 'yolo';
  startedAt?: number;
  completedAt?: number;
  costCents?: number;
  /** Rich contract fields (P2.1) — optional, mapped from OrchestratorPlanStepInput. */
  agentName?: string;
  model?: string;
  /** See OrchestratorPlanStepInput.modelId's doc comment (same wiring-gap caveat). */
  modelId?: string;
  /** See OrchestratorPlanStepInput.baseBranch's doc comment for the full contract and thread. */
  baseBranch?: string;
  /** See OrchestratorPlanStepInput.extraReadableProjectIds's doc comment (same wiring-gap caveat for the graph/orchestrator path). */
  extraReadableProjectIds?: string[];
  effort?: Effort;
  engine?: 'cli' | 'pro' | 'auto';
  budgetCapUsd?: number;
  maxDurationMs?: number;
  scopePaths?: string[];
  proofs?: ProofRequirement[];
  contestN?: number;
  critical?: boolean;
  role?: 'worker' | 'evaluator' | 'fixer' | 'reflector';
  onFail?: 'retry' | 'fix' | 'route' | 'block' | 'skip';
  maxAttempts?: number;
  joinGroup?: string;
}

/** Persisted orchestrator state spanning multiple missions. */
export interface OrchestratorState {
  id: string;
  name: string;
  projectId: string;
  targetProjectIds: string[];
  objective: string;
  steps: OrchestratorPlanStep[];
  currentStep: number;
  status: 'planning' | 'executing' | 'supervising' | 'blocked' | 'done';
  budget: { spentCents: number; limitCents?: number };
  childMissionIds: string[];
  createdAt: number;
  updatedAt: number;
  autonomyLevel: AutonomyMode;
  /** Lesson ids cited by the manager when generating this plan (eval-gated retention tracking). */
  citedLessonIds?: string[];
}

/** Outcome of a completed mission, fed into the Brain for learning. */
export interface MissionOutcome {
  missionId: string;
  projectId: string;
  title: string;
  agentName?: string;
  model: string;
  status: MissionStatus;
  durationMs?: number;
  costCents?: number;
  errorCategory?: string;
  errorMessage?: string;
  diffStats?: { filesChanged: number; linesAdded: number; linesRemoved: number };
  testResults?: { passed: number; failed: number };
  userIntervention?: boolean;
  learningInsights?: string[];
  timestamp: number;
}

/** A learned decision pattern stored in the Brain. */
export interface DecisionPattern {
  id: string;
  trigger: string;
  action: string;
  outcome: 'success' | 'failure' | 'partial';
  confidence: number;
  occurrences: number;
  lastSeen: number;
  projectId?: string;
  agentName?: string;
}

// ── LazyManager types ──────────────────────────────────────────────

/**
 * One action's outcome for `ManagerMessage.actionStatuses` — see that
 * field's own doc comment for the full three-way contract (`true`/`false`/
 * `'deferred'`).
 */
export type ActionStatus = boolean | 'deferred';

export interface ManagerMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Human-facing counterpart to `content`, when it must differ from what the
   * MODEL received (e.g. a manager-wakeup turn: `content` carries the
   * internal directive the LLM needs — "check the follow-up... reply in
   * French" — but a real user should never see the manager talking to
   * itself; see managerWakeup.ts's WAKEUP_MARKER_PREFIX doc comment and
   * agentsStore.tsx's formatWakeupDisplayMessage). Undefined for every
   * ordinary message — the UI falls back to `content`, so this is a pure
   * additive seam with zero behavior change for the common case.
   */
  displayContent?: string;
  timestamp: string;
  /**
   * True while this assistant bubble is still receiving streamed tokens.
   * Never persisted (autosave / sanitizeMessage drop it). The coder chat
   * already has this; the orchestrator previously buffered the entire
   * completion and only painted once, which is why a 20s turn felt dead.
   */
  isStreaming?: boolean;
  /** Actions parsed from the assistant response. */
  actions?: ManagerAction[];
  /**
   * Real, measured credit cost of this assistant turn (R4b fix, deliverable
   * #4 — turn cost visibility, previously zero display). Derived in
   * agentsStore.tsx's sendManagerMessage from costStore.ts's REAL
   * token-usage delta (getCostState() snapshotted immediately before/after
   * the exchange — every provider branch (claude-code/codex/managed) calls
   * addUsage synchronously as part of the SAME awaited call, so the delta is
   * measured, not guessed), converted via the SAME cents-per-dollar
   * convention the rest of the app already uses for
   * `credits_remaining_cents` (see formatCreditsSummary/KpiGroup.tsx/
   * AccountChip.tsx — 1 credit == 1 US cent of spend).
   *
   * Approximate, not exact: costStore's own pricing constants are a flat
   * per-model fallback (Haiku rates) rather than the ai-proxy's real settled
   * cost for the actual model used on managed/Pro turns (that real
   * `costUsd` is captured internally by managedProvider.ts's RealUsage
   * parsing but never surfaced past addUsage's inputTokens/outputTokens
   * args) — good enough for a "roughly this much" trust signal, never
   * claimed as an exact invoice.
   * Undefined when no measurable usage rounds to at least 1 credit this
   * turn — NEVER a fabricated placeholder.
   */
  approxCreditsUsed?: number;
  /**
   * W-MGRCREDITS fix: set when this assistant message is the honest
   * "Pro credits exhausted" preflight card — sendManagerMessage
   * (agentsStore.tsx) detected 0 remaining credits on a managed/pro-routed
   * turn BEFORE making any network call and short-circuited instead of
   * awaiting a doomed request. LazyManagerRail's ManagerBubble renders
   * dedicated recharge / change-model actions for this message instead of
   * plain text only.
   */
  creditsBlocked?: boolean;
  /**
   * Unsigned web + free OpenRouter id: ai-proxy requires a JWT
   * (measured 2026-08-28). Preflight card with a Sign-in action — never a
   * nested ManagedUnavailableError after a doomed proxy call.
   */
  sessionBlocked?: boolean;
  /**
   * W-MGRCREDITS fix: set when this assistant message reports that the
   * manager turn hit MANAGER_TURN_TIMEOUT_MS's hard ceiling (managerEngine.ts)
   * rather than a generic backend error — ManagerBubble renders a
   * "Réessayer" action that resends `retryText` verbatim instead of a plain
   * error line with no recovery.
   */
  timedOut?: boolean;
  /** Original user text to resend when `timedOut` is true. */
  retryText?: string;
  /**
   * Claude Code-style compact notice: set when this turn's API transcript
   * folded older messages into verbatim excerpts. Undefined when compact
   * did not run. Never invented — counts come from compactTranscriptWithMeta.
   */
  compactNotice?: string;
  /**
   * P1 fix: per-action execution status, parallel to `actions`. Each entry
   * is `true` when the action executed successfully, `false` when it threw,
   * was denied by the gate, or was a no-op (e.g. mission not found) —
   * cross-referenced against `pendingApprovals` (see
   * LazyManagerMessageList.tsx's `isPending` check) to tell an unresolved
   * gate-deferred ('ask') action from a genuine denial/failure.
   *
   * CONSENT-BYPASS FIX: `'deferred'` is the THIRD status, for an action that
   * arrived in the SAME turn as a `generate_plan` — it was neither executed
   * nor sent through the approval gate at all yet, only recorded on
   * `proposal.deferredActions` (agentsStore.tsx's sendManagerMessage). It is
   * only gated for real when the user validates the plan (executePlan),
   * which then patches this same index to `true`/`false` (queuing a REAL
   * pendingApprovals entry when the gate says 'ask', same as any other
   * action). Distinct from both `true` and `false` so a still-pending
   * proposal's deferred action never renders as if it had already succeeded
   * — see executePlan's own doc comment for the full defect this closes.
   */
  actionStatuses?: ActionStatus[];
  /**
   * P0 #4 fix: resolved canvas refs for each action, parallel to `actions`.
   * Each entry is the real canvas ref (e.g. "draft:abc-123", "mission:M12")
   * the executor generated for that action, or undefined when the action
   * produced no ref. Lets the "Voir sur le canvas" chip focus the ACTUAL
   * node instead of falling back to a project zone guess.
   */
  actionRefs?: (string | undefined)[];
  /**
   * Plan proposal state — when the manager generates a `generate_plan` action,
   * the message carries a proposal card the user must validate before execution
   * proceeds. State transitions: 'pending' → 'launching' → 'accepted', or back
   * to 'pending' on failure (see `errorMessage`); 'pending' → 'rejected'.
   *
   * 'launching' fix (B2, real QA session 2026-07-28: clicking "Valider &
   * lancer" flipped the card straight to 'accepted' with no toast, no
   * mission, no canvas change — the card LIED about a real effect having
   * happened): a click no longer jumps straight to a terminal-looking
   * 'accepted' before any real work has even started. It sits in
   * 'launching' for the whole materialize+execute window (GraphProposalCard
   * renders this as an explicit "launching" state, never silently as
   * 'accepted') and only reaches 'accepted' once agentsStore.tsx's
   * executePlan KNOWS materialization produced every step's node AND
   * execution genuinely launched at least one real mission. Any failure
   * along the way (materialization exception, a step whose node never
   * actually landed on the canvas, or an execute_plan that launched zero
   * real missions) reverts to 'pending' — same retry affordance the card
   * already offers — WITH `errorMessage` set, never a silent revert and
   * never a false 'accepted' painted over a no-op.
   */
  proposal?: {
    state: 'pending' | 'launching' | 'accepted' | 'rejected';
    planId?: string;
    objective: string;
    /**
     * OUT-OF-SCOPE-AT-PROPOSAL-TIME FIX (2026-08-19): the real root a
     * mission launched from this plan will run against — the SAME root
     * `resolveOrchestratorRoot(planId)` resolves at actual launch time
     * (agentsStore.tsx's `execute_plan` case), threaded here the moment it
     * is first known (right after `generate_plan` creates the orchestrator,
     * alongside the `steps` preview patch below — see that call site's own
     * comment) so GraphProposalCard can reuse `findOutOfScopeTaskPath`
     * (missionScopeGuard.ts) — the SAME guard `addMission` already runs at
     * LAUNCH time — to flag a step whose task text names a path outside
     * this root BEFORE the user ever clicks "Valider & lancer", instead of
     * only discovering it one mission at a time, after every affected step
     * has already been created and marked 'failed'. Undefined until that
     * patch lands (a brief window right after the proposal first appears)
     * and for any proposal predating this fix — the card simply renders no
     * scope warning in that case, never a false one.
     */
    targetProjectRoot?: string;
    steps: Array<{
      id?: string;
      description: string;
      agentName?: string;
      model?: string;
      /** See OrchestratorPlanStepInput.modelId's doc comment — surfaced here
       *  so a future proposal-card model picker can display/edit the exact
       *  id a step will run on, not just its tier. */
      modelId?: string;
      dependsOn?: string[];
      contestN?: number;
      role?: 'worker' | 'evaluator' | 'fixer' | 'reflector';
      onFail?: 'retry' | 'fix' | 'route' | 'block' | 'skip';
      maxAttempts?: number;
      joinGroup?: string;
      /** See OrchestratorPlanStepInput.extraReadableProjectIds's doc
       *  comment for the full contract — surfaced here (previously dropped
       *  when this preview copy was built) so GraphProposalCard's
       *  out-of-scope check can tell a step that genuinely declared
       *  cross-project read access apart from one that named another
       *  project's path and forgot to. */
      extraReadableProjectIds?: string[];
      /** Per-step cost cap the launched mission's contract will carry (see
       *  OrchestratorPlanStepInput.budgetCapUsd) — undefined when the plan
       *  step never set one. Paired with `estimatedCostUsd` below so
       *  GraphProposalCard can warn, AT PROPOSAL TIME, when a step's own
       *  estimate already exceeds the cap that will be applied to it
       *  (2026-08-19 incident fix: a 6-step plan whose steps all carried a
       *  $5 cap — the manager prompt's own example value — silently ran
       *  five of them 100%-274% over budget; nothing said so before launch). */
      budgetCapUsd?: number;
      /** Per-step estimate (estimatePlanStepCostUsd, managerEngine.ts) —
       *  precomputed once at proposal-construction time (agentsStore.tsx),
       *  never recomputed in the card, same "one estimator, two
       *  presentations" rule the aggregate `estimatedCostUsd` below already
       *  follows. Compared against `budgetCapUsd` above to decide whether
       *  this step's warning renders. */
      estimatedCostUsd?: number;
    }>;
    estimatedCostUsd?: number;
    estimatedDurationMs?: number;
    /**
     * Credits-per-model breakdown for the estimate above (item 7 fix, real
     * user QA 2026-08-01: the card showed "~$21.30" while the header badge
     * read "Claude · abonnement" — the owner's standing rule is credits per
     * model, never a dollar figure, and an explicit "no credits charged"
     * statement whenever the run actually goes through a CLI subscription
     * rather than managed/Pro credits). Keyed by the SAME `model` string
     * each step already carries (`steps[].model`), value is the SAME
     * cents-per-dollar credits convention `ManagerMessage.approxCreditsUsed`
     * already uses (`Math.round(estimatedCostUsd * 100)`), summed per model
     * from `estimatePlanStepCostUsd` (managerEngine.ts) — the SAME
     * estimator `estimatedCostUsd` above is already derived from, never a
     * second/independent conversion. Undefined for a plan with zero steps
     * (nothing to break down) — GraphProposalCard falls back to the plain
     * `estimatedCostUsd`-derived total in that case.
     */
    estimatedCreditsByModel?: Record<string, number>;
    autonomyMode?: AutonomyMode;
    /** Mutative actions deferred during pending proposal — replayed on accept. */
    deferredActions?: ManagerAction[];
    /**
     * PERSISTED-INDEX DEADLOCK FIX: each entry is `deferredActions[i]`'s real
     * position in this SAME message's own `actions` array (== `actionStatuses`/
     * `actionRefs`'s index space too), recorded once at proposal-construction
     * time (agentsStore.tsx's sendManagerMessage). `executePlan`'s deferred-
     * action replay loop needs that position to read `actionStatuses[i]`
     * (has this ALREADY been decided on a prior validate pass?) and to patch
     * it back — `deferredActions` and `actions` start life as the SAME
     * object references (`deferredActions` is a `.filter()` of the array
     * `actions` is set from), so a same-session reference lookup
     * (`actions.findIndex((a) => a === entry)`) used to work. It silently
     * breaks the instant this message round-trips through
     * managerPersistence.ts's JSON storage: `JSON.parse` rebuilds `actions`
     * and `proposal.deferredActions` as two INDEPENDENT object graphs, so
     * `===` is false for every entry from then on and the replay loop could
     * never again find `actionStatuses[i]` for an already-decided action —
     * observed live as an already-executed deferred action (`actionStatuses`
     * genuinely `true`) re-blocking "Valider & lancer" forever. A plain
     * number, unlike object identity, survives that round-trip perfectly
     * (see managerPersistence.ts's sanitizeProposal), so the replay loop now
     * reads this array first and only falls back to the reference lookup for
     * a proposal that predates this fix. Undefined for a plan with no
     * deferred actions, same convention as `deferredActions` itself.
     */
    deferredActionIndexes?: number[];
    /** Lesson ids the manager cited when generating this plan. */
    citedLessonIds?: string[];
    /**
     * B2/B3 fix — set when a launch attempt reverted the proposal back to
     * 'pending' after failing: the real, honest reason materialization or
     * execution did not produce the plan's real effect (a caught exception's
     * message, a gate denial, or "N of M steps never launched a mission").
     * GraphProposalCard renders this as a persistent visible error banner
     * (never a transient toast the user can miss) whenever it is set, and it
     * is cleared the instant a fresh "Valider & lancer" attempt starts
     * (proposal.state flips to 'launching') — a stale error from a previous
     * attempt never lingers next to a brand new one in flight.
     */
    errorMessage?: string;
  };
  /**
   * Mission Charter proposal state — mirrors `proposal` above but for a
   * propose_mission_charter action: the user validates or modifies the
   * charter BLOCK BY BLOCK before any graph gets built for this work.
   * `blockStates` tracks per-block acceptance when the user accepts/edits
   * one block at a time instead of the whole charter at once — a block
   * absent from this map is still 'pending'. State transitions mirror
   * `proposal`'s own: 'pending' -> 'accepted' | 'rejected'; 'accepted' is
   * what allows the manager's NEXT turn to build the real graph
   * (generate_plan/create_draft) for this work, never before.
   */
  charterProposal?: {
    state: 'pending' | 'accepted' | 'rejected';
    charterId?: string;
    charter: MissionCharter;
    blockStates?: Partial<
      Record<'objective' | 'nature' | 'decisions' | 'validationGates' | 'learning', 'pending' | 'accepted' | 'modified'>
    >;
  };
  /**
   * Visible-artifact proposal state (real founder feedback, verbatim:
   * "comment tu me montres les designs proposes ?") — mirrors
   * `charterProposal` above but for a propose_artifact action: the founder
   * validates (or rejects) a VISUAL deliverable it can actually SEE, never a
   * text description of it. State transitions mirror `proposal`/
   * `charterProposal`'s own: 'pending' -> 'accepted' | 'rejected'.
   * ArtifactProposalCard.tsx (components/lazyManager/) renders straight
   * from this field; see `ArtifactProposal`'s own doc comment below for the
   * field-for-field mirror of that folder's UI-local
   * artifactProposal.ts module (same type names, deliberately not imported
   * — see this file's own "no components/** imports" rule stated on the
   * Agent Canvas action block below).
   */
  artifactProposal?: ArtifactProposal;
}

/**
 * Deliberate per-mission provider choice the manager can request — "cli"
 * targets the Claude CLI/BYOK subscription, "pro" targets the Lazy managed
 * (OpenRouter/ai-proxy) credits. The two rails are independent and can both
 * be active at once (a user may hold a Claude subscription AND an active
 * Lazy Pro plan simultaneously — see runtime.ts's classifyMissionModel doc
 * comment and modelPickerOptions.ts's module header). Resolved to a concrete
 * model id of the matching family by resolveManagerModelId (managerEngine.ts)
 * before the mission ever reaches runtime.ts's classifyMissionModel-based
 * dispatch. Omitted on an action means "keep today's mode-based default".
 */
export type ManagerEngineChoice = 'cli' | 'pro';

/**
 * Exact catalog id (openrouterCatalog.ts's `OpenRouterModel.id` on the Pro
 * rail, registry.ts's `ModelInfo.id` on the CLI rail) a model-carrying action
 * can name PRECISELY instead of (or alongside) a bare `model` tier hint
 * ("haiku"|"sonnet"|"opus"). Set this when the user names a provider/model
 * explicitly ("lance-le sur GPT-5.5", "utilise Gemini 3.5 Pro"), or when the
 * brain's own history shows one model consistently outperforming others on
 * this kind of step — ordinary delegation should keep using the tier hint.
 *
 * Resolved by resolveManagerModelId (managerEngine.ts), which checks
 * `modelId` BEFORE `model` and validates it against whichever rail
 * (native/CLI vs managed/Pro) is actually in effect for the action — an id
 * that does not belong to that rail's family throws
 * UnknownManagerModelIdError rather than silently substituting a default
 * (NEVER DEGRADE IN SILENCE). Present on launch_mission, launch_best_of_n,
 * create_loop, create_draft (all below), spawn_submissions' per-modification
 * bag (read as `mod.modelId` — untyped like `mod.model`/`mod.engine` already
 * are, no type change needed there), and OrchestratorPlanStepInput/
 * OrchestratorPlanStep for generate_plan steps (see that interface's own
 * doc comment for the additional out-of-perimeter wiring generate_plan still
 * needs). NOT yet present on chain_agents' inline draft spec (a candidate
 * for a future pass, kept out of this one to stay additive/minimal).
 *
 * FUTURE CANVAS MODEL PICKER CONTRACT: a per-node model selector should
 * write this SAME field name (`modelId`) onto whichever action created (or
 * is about to launch) that node, with an id copied VERBATIM from the
 * catalog — never a label or a derived string. The resolved id lands as-is
 * on Mission.model / the draft's own `model` field (DraftSpec, canvasTypes.ts)
 * exactly like a resolved tier hint does today — no new storage field
 * required on either.
 */
export type ManagerModelId = string;

// ── Mission Charter (charte de mission) ────────────────────────────
// Emitted via the propose_mission_charter action (managerEngine.ts) BEFORE
// any graph gets built for recurring/permanent work or work needing a
// validation gate — see that action's own doc comment for the full trigger
// rules, deliberately distinct from the graph-proposal node-count trigger
// and from trial-mode eligibility (LoopConfig.regimeState above). Validated
// or modified block-by-block by the user — same UX as the existing plan
// proposal card (ManagerMessage.proposal below).

/** A mission's nature — governs BOTH the validation-gate shape and whether
 *  the recurring regime lifecycle (LoopConfig.regimeState) applies at all:
 *  'unique' never promotes (no repetition to promote), 'recurring' and
 *  'permanent' are the only two natures that ever enter trial mode. */
export type MissionNature = 'unique' | 'recurring' | 'permanent';

/**
 * One decision the manager must TAKE A STANCE on, not just ask — the
 * difference from the ordinary structuring question (HARD RULE, Identity
 * section of managerEngine.ts's buildManagerCorePrompt): a recommendation
 * and its reason are mandatory, including when they contradict the user's
 * own request (e.g. a too-high publish cadence risks account flagging —
 * recommend a lower, irregular one and say why, never execute the risky ask
 * in silence).
 */
export interface DecisionWithRecommendation {
  question: string;
  options: string[];
  recommended: string;
  rationale: string;
}

/**
 * Three distinct validation tiers (figé une fois / surveillé N fois / libre
 * ensuite) — NOT the same axis as trial-mode promotion (LoopConfig above),
 * which only applies to a recurring/permanent nature. A 'unique' task can
 * still carry `frozenOnce` (e.g. a template it produces as a reusable
 * artifact) with no `superviseFirstN`/promotion at all, since there is no
 * repetition to promote (MissionNature's own doc comment).
 */
export interface ValidationGates {
  /** What gets fixed exactly once (e.g. "visual template", "format", "tone"). */
  frozenOnce: string[];
  /** How many of the first executions require explicit human approval before running free. Absent/0 = no supervised window. */
  superviseFirstN?: number;
}

/**
 * What measures the regime's own success and when it must stop itself —
 * without this block, the 'self_improving' regime state
 * (LoopConfig.regimeState) stays purely decorative (spec §6: "sans mesure
 * nommée dans la charte, l'axe auto-améliorant reste décoratif").
 */
export interface LearningAndKillSwitch {
  /** Named metric (e.g. "engagement rate") — never a generic "performance". */
  measure: string;
  /** Where the measure comes from (e.g. "external analytics ingestion"). */
  measureSource: string;
  /** What the measure is allowed to influence (e.g. "subjects, formats, timing"). */
  influences: string;
  /** Condition that demotes the regime to trial or stops it outright. */
  killSwitch: string;
}

/**
 * The full charter a propose_mission_charter action carries — five blocks,
 * and nothing else (spec: "elle contient cinq blocs et rien de plus").
 */
export interface MissionCharter {
  objective: string;
  nature: { kind: MissionNature; cadence?: LoopCadence };
  decisions: DecisionWithRecommendation[];
  validationGates: ValidationGates;
  learning: LearningAndKillSwitch;
}

// ── Artifact proposal (visible design preview) ──────────────────────
// Emitted via the propose_artifact action BEFORE a VISUAL deliverable (any
// subject — a template, a mockup, a rendered layout) is treated as ready:
// the founder must see the real thing, never a text description (real
// founder feedback, verbatim: "comment tu me montres les designs proposes
// ?"). Mirrors propose_mission_charter's own "propose, never commit"
// contract: attached to the assistant message as `ManagerMessage.artifactProposal`
// (`state: 'pending'`) for ArtifactProposalCard.tsx's chat card, AND
// materialized as a canvas preview surface (SurfaceSpec.htmlViews) with the
// SAME content — see agentsStore.tsx's propose_artifact executor case.
//
// GENERIC BY CONSTRUCTION (non-negotiable, per this task's own brief):
// nothing here names a content format, a network, or a fixed view/variant
// count — see components/lazyManager/artifactProposal.ts's own module
// header. The three interfaces below mirror that UI-local module's
// `ArtifactView`/`ArtifactVariant`/`ArtifactProposal` FIELD FOR FIELD
// (deliberately not imported — this shared low-level types module must
// never import from components/**, same rule the Agent Canvas action block
// below states for canvasTypes.ts) so a value built from one satisfies the
// other structurally, with zero reshaping at the read site.

/** One view (page/screen/variant — no fixed meaning assumed) of one variant
 *  of a proposed visual artifact. */
export interface ArtifactView {
  id: string;
  /** Plain-language, agent-supplied label (e.g. "Page 1") — never assumed
   *  to be a number or a fixed sequence name. */
  label: string;
  /** Full standalone HTML document (or fragment) — rendered verbatim inside
   *  a fully-locked-down sandboxed iframe, never executed/interpreted by
   *  this app (ArtifactProposalCard.tsx's/PreviewNode.tsx's own headers). */
  html: string;
  /** Optional intended pixel size — absent when the artifact carries no
   *  fixed canvas size. */
  width?: number;
  height?: number;
}

/** One alternative design (spec: "plusieurs propositions, dont une avec
 *  notre DA") — a variant's label is free-form/agent-supplied text, so "the
 *  one with our brand kit" is just a label, never a hardcoded concept this
 *  module knows about. */
export interface ArtifactVariant {
  id: string;
  label: string;
  /** At least one view — never assumed to be exactly one. */
  views: ArtifactView[];
}

/** The full artifact-proposal envelope carried by `ManagerMessage.artifactProposal`. */
export interface ArtifactProposal {
  state: 'pending' | 'accepted' | 'rejected';
  artifactId?: string;
  /** Plain-language name of the artifact (e.g. "Gabarit visuel"). */
  name: string;
  version?: string;
  /** At least one variant — a single-variant proposal is still valid. */
  variants: ArtifactVariant[];
  /** Set once the user picks a variant. */
  selectedVariantId?: string;
}

export type ManagerAction =
  | { type: 'create_agent'; agent: Record<string, unknown> }
  /**
   * `baseBranch` (see Mission.baseBranch's doc comment above for the full
   * contract) closes the individual-launch gap commit 98693e0 left open:
   * that fix only makes a graph STEP inherit its `dependsOn` predecessor's
   * branch inside runGraph.ts — a mission launched directly via this action
   * (the manager's normal one-shot path, a relaunch after failure, or
   * continuing a plan step by step outside a graph run) got no inheritance
   * at all and silently started from the repo's default branch. Threaded
   * unchanged onto NewMissionInput.baseBranch (agentsStore.tsx's
   * `launch_mission` case) -> Mission.baseBranch -> runtime.ts's
   * createWorktree, the same terminal plumbing 6073668 already built end to
   * end for plan steps — this is the missing entry point, not new plumbing.
   * See the Continuation Doctrine (managerEngine.ts) for when the manager
   * must set this.
   *
   * `extraReadableProjectIds` — cross-project READ access (see
   * Mission.extraReadableRoots' own doc comment for the full contract):
   * project ids or names (same resolution as `projectId` above —
   * resolveDraftProjectId, agentsStore.tsx) whose OWN roots this mission's
   * agent may READ from in addition to its own worktree, e.g. when the task
   * genuinely requires referencing another open project's source (the gap
   * this closes: a mission rooted at project B previously had NO way to
   * read project A's code at all, even when the task explicitly needed
   * it). Each id is resolved to a real, currently-open project root by the
   * `launch_mission` executor BEFORE reaching NewMissionInput/Mission — an
   * id that does not resolve to a currently open project is dropped, never
   * silently substituted for "every open project". The Rust side
   * (agent_run, run.rs) re-validates every resolved root against the live
   * ProjectRegistry independently before use — this field alone can never
   * widen a mission's reach beyond what is currently open, in either
   * layer. Set this ONLY when the step's task genuinely targets another
   * project's source, never as a default — see managerCorePrompt.ts.
   */
  | { type: 'launch_mission'; agentName?: string; task: string; model?: string; modelId?: ManagerModelId; effort?: Effort; engine?: ManagerEngineChoice; contestN?: number; budgetCapUsd?: number; maxDurationMs?: number; baseBranch?: string; projectId?: string; extraReadableProjectIds?: string[] }
  /** Best-of-N primary UX (Cursor parity) — launches N parallel contestants via SGR contest node.
   *  `modelId` (see ManagerModelId's doc comment) is threaded onto the SGR contest step alongside
   *  `model` so launch_mission's contestN>=2 forwarding path (agentsStore.tsx) never silently drops
   *  an exact-id request when it upgrades a single launch_mission into a best-of-N plan. */
  | { type: 'launch_best_of_n'; task: string; n: number; agentName?: string; model?: string; modelId?: ManagerModelId; effort?: Effort; engine?: ManagerEngineChoice; budgetCapUsd?: number }
  /** Resume a graph run from a checkpoint / interrupt token (rewind-and-fork path). */
  | { type: 'fork_graph_run'; planId: string; checkpointId?: string; nodeId?: string; label?: string }
  /** Answer a graph interrupt / blocked plan step. */
  | { type: 'resume_graph_run'; planId: string; decision?: 'retry' | 'revise' | 'skip' | 'abort' | 'continue' }
  /**
   * `superviseFirstN`/`measure`/`killSwitch`/`templateArtifactRef` seed the
   * recurring regime lifecycle (spec §4, LoopConfig.regimeState's own doc
   * comment) straight from a validated MissionCharter's `validationGates`/
   * `learning` blocks — set them when this loop is being created to execute
   * a charter whose nature is 'recurring'/'permanent' AND that carried a
   * `superviseFirstN` gate. Omitted (the pre-charter default): an ordinary
   * ungated loop, exactly today's behavior — `regimeState` stays absent, so
   * `recordLoopApproval`/`recordLoopFailure` (loopEngine.ts) remain no-ops
   * for it, which is also the structural guarantee that a one-time task
   * (never routed through create_loop at all) can never enter trial mode.
   */
  | {
      type: 'create_loop';
      agentName?: string;
      task: string;
      cadence: LoopCadence;
      model?: string;
      modelId?: ManagerModelId;
      effort?: Effort;
      engine?: ManagerEngineChoice;
      superviseFirstN?: number;
      measure?: string;
      killSwitch?: string;
      templateArtifactRef?: string;
    }
  | { type: 'pause_loop'; loopId: string; enabled?: boolean }
  | { type: 'delete_loop'; loopId: string }
  | { type: 'stop_mission'; missionId: string }
  | { type: 'stop_all'; filter?: string }
  /**
   * Retry-with-edit friction fix — `modifications.task` (read as a string,
   * same untyped-bag convention as clone_mission/spawn_submissions'
   * `modifications` above) lets a retry carry a CORRECTED task instead of
   * forcing a clone_mission detour just to fix a badly-worded instruction
   * that caused the failure. `modifications.model`/`modifications.modelId`
   * (same tier-hint-vs-exact-id convention as launch_mission) optionally
   * reroute the retry too. Prefer this over clone_mission whenever the
   * failure traces back to the instruction itself, not to genuinely new
   * scope — see the Continuation Doctrine in managerEngine.ts. Omitted
   * `modifications` (or an unchanged `task`) keeps today's plain-retry
   * behavior: same task, same model, same base branch (inherited from the
   * original mission), fresh run.
   *
   * `baseBranch` is REFUSED, always, never silently applied — this variant
   * declares it (top-level, matching launch_mission's own shape, AND inside
   * `modifications.baseBranch`, the untyped-bag shape) purely so a manager
   * mistake naming either one is CAUGHT and rejected loudly instead of
   * silently doing nothing. Reversal (2026-08-02, real incident — lazy-
   * backoffice M9/M10: asked to relaunch two steps from a corrected
   * baseBranch, the manager retried them instead of launching new missions,
   * and the retry silently kept each original's empty base — neither the
   * manager nor the user was ever told the requested base branch had been
   * dropped). baseBranch is a mission-CREATION parameter (Mission.baseBranch's
   * own doc comment, this file) — to re-root work that started from the
   * wrong place, launch_mission a NEW mission with the right base; retrying
   * never changes where a mission's worktree started from. See
   * agentsStore.tsx's retryMission for the actual refusal.
   */
  | { type: 'retry_mission'; missionId: string; modifications?: Record<string, unknown>; baseBranch?: string }
  /**
   * `discardWorktree` (worktree capability, 2026-08-04) — when true (the
   * default for a mission that is NOT `merged` — an already-merged
   * mission's worktree is normally already reclaimed by approveMission's
   * own merge flow, so the default there is false to avoid a redundant
   * attempt), the mission's git worktree/branch is ALSO discarded through
   * the same real `discardWorktree`/`agent_discard_worktree` primitive the
   * canvas "Rejeter" button already uses — drift-tolerant across every
   * open project (see agentsStore.tsx's `resolveMissionWorktreeCandidates`
   * doc comment) since a mission's recorded project is not always where its
   * worktree still physically lives. Fixes a real capability gap (manager
   * QA, 2026-08-04): the manager had no way to touch a worktree at all and
   * previously narrated "worktree jeté" without ever attempting it. Set
   * `false` explicitly to keep the worktree/branch on disk. Best-effort and
   * always honestly reported: the executor's result names, per mission,
   * whether the worktree was actually discarded, not found at any
   * candidate path, or errored — never a silent assumption either way.
   */
  | { type: 'delete_mission'; missionId: string; discardWorktree?: boolean }
  | { type: 'list_agents' }
  | { type: 'list_missions'; filter?: string }
  | { type: 'brain_query'; query: string; sessionId?: string }
  | { type: 'brain_query_css'; selector: string; limit?: number }
  | { type: 'brain_neighbours'; id: string }
  /**
   * Structural, read-only digest of a project's shape — stack, scripts,
   * test presence, top-level file/dir counts, rough surface/volume
   * magnitude, recent git activity (see lib/agents/projectDigest.ts's
   * `buildProjectDigest`). NEVER calls an LLM, NEVER launches a mission —
   * a grounding action exactly like brain_query/web_search (see
   * agentsStore.tsx's `groundingDedupKey`/`isMutantManagerAction`): the
   * manager uses it BEFORE sizing a plan (how many agents, how many
   * verification steps) instead of guessing from the request text alone.
   * `projectId` absent -> the currently active project; `depth` absent ->
   * 'quick' (bounded to ~900 chars — see BUDGETS in projectDigest.ts).
   */
  | { type: 'scan_project'; projectId?: string; depth?: 'quick' | 'deep' }
  | { type: 'web_search'; query: string; maxResults?: number }
  | { type: 'web_fetch'; url: string; maxChars?: number }
  | { type: 'query_mission'; missionId: string }
  | { type: 'get_agent_output'; missionId: string; lines?: number }
  | { type: 'clone_mission'; missionId: string; modifications?: Record<string, unknown> }
  | { type: 'quote_mission'; task: string; model?: string; scopePaths?: string[] }
  | { type: 'spawn_submissions'; missionId: string; count?: number; modifications?: Record<string, unknown>[] }
  | { type: 'set_budget'; missionId?: string; projectId?: string; limitUsd: number; period?: 'daily' | 'weekly' | 'monthly' | 'per_mission' }
  /** W-MODES: sets the merge-approval automation level — a project's own
   *  override (`projectId` given) or the global default (`projectId`
   *  omitted). See `ApprovalMode`'s own doc comment for the 3 levels. */
  | { type: 'set_approval_mode'; mode: ApprovalMode; projectId?: string }
  | { type: 'revert_mission'; missionId: string }
  | { type: 'briefing_query'; projectId?: string; sinceMs?: number }
  | { type: 'decision_lookup'; question: string }
  | { type: 'reassign_agent'; missionId: string; model: string }
  | { type: 'answer_question'; missionId: string; answer: string }
  // ── Agent Canvas (W4, spec §8.1) — LazyManager gets full canvas powers:
  // create/launch drafts, chain agents together, arrange/focus the board,
  // move nodes, drop sticky notes, collapse project zones. Additive only —
  // inserted before 'info' so 'info' stays the union's last, catch-all
  // variant (do not reorder the entries above this block).
  //
  // `sourceRef`/`targetRef`/`ref`/`chainId` are plain strings here (not the
  // canvas's own `NodeRef`/branded types) deliberately: this module
  // (lib/agents/types.ts) is a low-level shared types module imported by
  // mock data, runtime, and the evaluator — it must never import from
  // components/agents/canvas/canvasTypes.ts (that module imports FROM this
  // one, so the reverse import would be circular). The executor
  // (agentsStore.tsx) parses/validates these strings against the real
  // canvas contract (makeRef/parseRef/validateChain) before acting on them.
  /** Full digest of the live canvas (projects/nodes/chains/drafts) — a pure
   *  marker action, same as list_missions/list_agents: the digest is
   *  already injected into the system prompt every turn (see
   *  managerEngine.ts's buildManagerSystemPrompt canvasDigest block), so
   *  the executor has nothing further to do when this is emitted. */
  | { type: 'canvas_overview' }
  /** Arms a new Draft node on the canvas (not yet launched) — mirrors the
   *  palette/quick-create flow a human uses. `projectId` (W6e): absent
   *  targets the ACTIVE project (the one canvasDigest marks `[ACTIVE]`);
   *  a value is accepted either as a known project id or (case-insensitive)
   *  a known project name — an unresolvable value falls back to the
   *  Transverse zone with an honest toast rather than silently mis-targeting
   *  (see canvasDigest.ts's `resolveDraftProjectId`, the executor's single
   *  resolution choke point for both this action and chain_agents' inline
   *  target spec below).
   *
   *  `alias` (W6d, intra-turn chaining fix): an optional short label
   *  ('a', 'b', ...) the SAME manager reply can use to refer to THIS draft
   *  in a later action within the same `<lazy_actions>` array — chain_agents
   *  (`sourceAlias`/`target.targetAlias`), focus_canvas (`refAlias`),
   *  move_node (`refAlias`), launch_draft (`draftAlias`). Necessary because
   *  the real draft id is only generated when the executor actually runs
   *  this action (agentsStore.tsx's `generateCanvasId`) — the model cannot
   *  know it ahead of time, so without an alias it has no way to reference,
   *  in the SAME reply, a draft it is creating in that reply (see
   *  agentsStore.tsx's `aliasMap`/`resolveAliasedRef` for the resolution
   *  side). Purely a same-reply convenience — never persisted, never a
   *  substitute for a real ref once the reply has executed. */
  | {
      type: 'create_draft';
      projectId?: string;
      task: string;
      agentName?: string;
      model?: string;
      /** See ManagerModelId's doc comment — exact catalog id, priority over `model`. */
      modelId?: ManagerModelId;
      title?: string;
      alias?: string;
      /** Explicit launch autonomy for the armed draft (R13). Absent falls
       *  back to 'acceptEdits' at launch/chain-fire time (canvasTypes.ts's
       *  `DraftSpec.permissionMode` doc comment) — a verification-type draft
       *  (build/test/typecheck checks) never needs to set this; only pass it
       *  to request a stricter mode (e.g. 'plan' for a read-only preview). */
      permissionMode?: 'plan' | 'acceptEdits' | 'full';
      /** See ManagerEngineChoice — deliberate "cli"/"pro" rail for this draft,
       *  resolved to a concrete model id at creation time (same treatment as
       *  launch_mission/create_loop's own `engine`). */
      engine?: ManagerEngineChoice;
    }
  /** Launches an existing Draft into a real mission (the same real
   *  `addMission` primitive + cross-project honesty check every human
   *  "Lancer" click uses — see canvas/draftLaunch.ts's `launchDraft`).
   *
   *  `draftId` is the normal path (an existing draft from a prior turn).
   *  `draftAlias` (W6d) resolves a draft created earlier in THIS SAME reply
   *  via create_draft's `alias` — set exactly one of the two; when both are
   *  omitted, or `draftAlias` names an alias that was never registered
   *  (e.g. referenced before its create_draft ran), the executor reports an
   *  honest reason rather than silently no-op-ing. */
  | { type: 'launch_draft'; draftId?: string; draftAlias?: string }
  /** Creates a handoff edge: when the mission/loop at `sourceRef` reaches a
   *  terminal status matching `condition` (default 'success'), `target`
   *  launches with the source's output injected as context (spec §7). The
   *  target is either an EXISTING draft/mission ref, or an inline spec that
   *  the executor first arms as a fresh Draft (same as create_draft) before
   *  chaining to it. Rejected honestly (chainValidation.ts's real rules —
   *  no self-chain, no chain into a loop, no cycle, target must be a draft
   *  or a queued mission) rather than forced.
   *
   *  `sourceAlias`/`target.targetAlias` (W6d): same intra-turn alias
   *  convention as create_draft's `alias` — set ONE of `sourceRef`/
   *  `sourceAlias` (not both), and target is one of `{draftId}`,
   *  `{missionId}`, `{targetAlias}`, or the inline spec. A source resolved
   *  via `sourceAlias` may point at a just-created Draft (the executor
   *  allows this — a human can drag-connect a chain FROM a draft node the
   *  same way, see canvasStore.ts's `remapDraftToMission`, which re-points
   *  the chain to the real mission ref once that draft launches); a literal
   *  `sourceRef` string still must name an existing mission/loop, unchanged
   *  from before this wave. */
  | {
      type: 'chain_agents';
      sourceRef?: string;
      sourceAlias?: string;
      target:
        | { draftId: string }
        | { missionId: string }
        | { targetAlias: string }
        | {
            task: string;
            agentName?: string;
            model?: string;
            modelId?: string;
            projectId?: string;
            title?: string;
            /** Same override as create_draft's own `permissionMode` (R13) —
             *  the inline spec arms a fresh Draft exactly like create_draft
             *  does, so it carries the same optional field. */
            permissionMode?: 'plan' | 'acceptEdits' | 'full';
          };
      condition?: 'success' | 'fail' | 'always';
    }
  /** Removes a chain (the edge only — never touches the missions/drafts it
   *  connected). */
  | { type: 'unchain'; chainId: string }
  /** Auto-layouts the canvas (elkjs) or toggles lane mode — the same real
   *  primitives the toolbar's « Ranger »/lane-mode buttons call. `scope`
   *  narrows to one project's zone for 'auto'; lane mode itself is a
   *  canvas-wide preference (mirrors the toolbar toggle), so `scope` is
   *  advisory-only when `mode` is 'lanes'/'free'. */
  | { type: 'arrange_canvas'; scope?: string; mode?: 'auto' | 'lanes' | 'free' }
  /** Pans/zooms the camera onto a node or project zone with an animated
   *  glide + a brief highlight pulse (spec §8.2 choreography) — how the
   *  manager says "look here" instead of just describing it in text.
   *  `refAlias` (W6d) resolves a node created earlier in this same reply —
   *  set exactly one of `ref`/`refAlias`. */
  | { type: 'focus_canvas'; ref?: string; refAlias?: string }
  /** Repositions a node (geometry only — never a mission-lifecycle action).
   *  `refAlias` (W6d) resolves a node created earlier in this same reply —
   *  set exactly one of `ref`/`refAlias`. */
  | { type: 'move_node'; ref?: string; refAlias?: string; x: number; y: number }
  /** Drops a sticky note on the canvas — manager annotations (spec §8.1). */
  | { type: 'canvas_note'; text: string; projectId?: string }
  /** Collapses/expands a project zone into its compact chip form. */
  | { type: 'collapse_project'; projectId: string; collapsed: boolean }
  /** W-IMPROVE (additive, Pillar D5 v1) — runs the friction miner
   *  (frictionMiner.ts) for `projectId` (absent -> active project) and
   *  materializes its ranked pathology candidates as canvas drafts inside a
   *  dedicated frame (frictionAnalysis.ts's `runFrictionAnalysis`) — never
   *  auto-launches anything, the normal approval/launch flow still governs
   *  execution of any resulting draft. */
  | { type: 'analyze_frictions'; projectId?: string }
  // ── Agent Canvas W8c — pin output, approve/reject gate, router node ──
  // Executed through the SAME real primitives the canvas UI itself uses
  // (canvasStore's pinChainOutput/unpinChainOutput/addRouter, chainEngine's
  // refireChainDownstream, agentsStore's approveMission/retryMission) — no
  // parallel path, same as every other Agent Canvas action above.
  /** Pins a chain's source output (the mission must have already reached a
   *  terminal-success state — the executor reports honestly when it has
   *  not). See canvas/chainEngine.ts's `capturePinnedOutput`. */
  | { type: 'pin_chain'; chainId: string }
  /** Reverts a pinned chain to live (re-read-at-fire-time) context injection. */
  | { type: 'unpin_chain'; chainId: string }
  /** « Relancer l'aval » — re-fires a PINNED chain's target from its frozen
   *  snapshot, without re-running the source mission (chainEngine.ts's
   *  `refireChainDownstream`; draft targets only — see its doc comment). */
  | { type: 'refire_chain'; chainId: string }
  /** Approves a mission in 'review' for merge — the same real
   *  `approveMission` primitive the node's gate / MissionDetail's Approve
   *  button use. `force` bypasses the judge/proof gates (approveGate.ts),
   *  same semantics as the human's "Merger quand même". */
  | { type: 'approve_mission'; missionId: string; force?: boolean }
  /** Rejects a mission in 'review' with feedback: records a real
   *  `mission.rejected` journal entry against the ORIGINAL mission, then
   *  relaunches it (agentsStore.tsx's `retryMission`) with the feedback
   *  baked into the new mission's task — never a fabricated lifecycle
   *  state. */
  | { type: 'reject_mission'; missionId: string; feedback: string }
  /** Creates a new router node (2-4 ordered, labeled branches) — the same
   *  diamond node a human places from the palette/context-menu. `branches`
   *  mirrors canvasTypes.ts's `RouterBranch` (minus `id`, minted by the
   *  executor). `alias` (same intra-turn convention as create_draft) lets a
   *  LATER action in this same reply reference the router or one of its
   *  branches via a `chain_agents` target — see chain_agents' own alias doc
   *  comment; a router alias resolves to `router:<id>` (the whole node,
   *  valid as a chain_agents TARGET), never directly to a branch (branches
   *  have no alias of their own — reference a branch as a chain SOURCE via
   *  its real `router:<id>:<branchLabel-derived-id>` ref from a follow-up
   *  turn's canvas digest instead). */
  | {
      type: 'create_router';
      projectId?: string;
      // Inlined (not imported from canvasTypes.ts's RouterBranchCondition):
      // this module must never import from components/agents/canvas/
      // canvasTypes.ts — that module already imports FROM this one (see this
      // block's own opening comment), so the reverse import would be
      // circular. Structurally identical; the executor (agentsStore.tsx)
      // constructs the real canvasTypes.ts RouterBranch from these fields.
      branches: Array<{
        label: string;
        condition: { kind: 'outcome'; value: 'success' | 'fail' } | { kind: 'contains'; value: string } | { kind: 'default' };
      }>;
      alias?: string;
    }
  /** W9 (additive) — opens the per-project « Rapport » page
   *  (components/agents/report/ProjectReportPage.tsx) via the existing
   *  `report:open` bus event (lib/bus.ts — its own doc comment explicitly
   *  named this exact action as the wiring gap it was left for). `projectId`
   *  absent opens the ACTIVE project's report; a value is resolved the same
   *  way `create_draft`'s `projectId` is (known id, or case-insensitive
   *  name match — canvasDigest.ts's `resolveDraftProjectId`) — an
   *  unresolvable name falls back to the active project's report with an
   *  honest toast, never a silent wrong-project report. */
  | { type: 'open_report'; projectId?: string }
  // ── Group macros (canvas-parity-close, additive) — same real
  // canvasStore/canvasMacros.ts primitives the palette/context-menu UI
  // uses, no parallel path.
  /** Captures the pending-only subgraph (drafts/routers/notes — never
   *  missions) among `refs` into a new saved macro. `refs` are real canvas
   *  refs from the digest (e.g. "draft:abc-123", "router:xyz", "note:n1") —
   *  a ref that isn't a draft/router/note, or doesn't exist, is silently
   *  dropped from the capture (canvasMacros.ts's `captureMacro`); the
   *  executor reports honestly when NOTHING captureable was found rather
   *  than saving an empty macro. */
  | { type: 'save_macro'; name: string; description?: string; refs: string[] }
  /** Instantiates a fresh copy of a previously saved macro (looked up by
   *  NAME, case-insensitively — a macro has no stable id the manager could
   *  know ahead of time) at the target project's zone. `projectId` follows
   *  the SAME resolution rule as create_draft's own (absent -> active
   *  project; a value matches a known id or name; unresolvable falls back
   *  to Transverse with an honest note) — never a fabricated success when
   *  the named macro doesn't exist. */
  | { type: 'instantiate_macro'; name: string; projectId?: string }
  // ── Orchestrateur ultime (additive) ─────────────────────────────────
  /** Generates a multi-step plan to satisfy a user objective. */
  | { type: 'generate_plan'; objective: string; steps?: OrchestratorPlanStepInput[]; projectId?: string; citedLessonIds?: string[] }
  /** Executes an approved plan by planId. `fromStep` is a single resume
   *  point (its transitive dependency closure runs) — used by
   *  resume_graph_run-adjacent call sites that always seed from exactly one
   *  step. `stepIds` is the GraphProposalCard checkbox partial-accept case
   *  (chantier 3, plan-first canvas): potentially several, NOT necessarily
   *  mutually-dependent, explicitly accepted step ids — every one of them
   *  (plus each one's own transitive deps) must run, not just the first.
   *  When both are set, `stepIds` wins (a superset seed always subsumes a
   *  single one); `fromStep` alone keeps its original single-seed meaning
   *  unchanged. */
  | { type: 'execute_plan'; planId: string; fromStep?: string; stepIds?: string[] }
  /** Revises an existing plan before or during execution. */
  | { type: 'revise_plan'; planId: string; objective?: string; steps?: OrchestratorPlanStepInput[]; reason?: string }
  /**
   * Rejects a pending plan PROPOSAL by planId — the same real
   * `canvasStore.rejectProposedPlan` primitive the chat proposal card's own
   * "Rejeter" button already uses (canvasStore.ts): every draft/chain/join
   * still tagged `proposedPlanId === planId` is removed from the canvas
   * outright. That button can only reject the proposal from THIS turn's
   * own card — this action makes the same cleanup reachable RETROACTIVELY,
   * by planId, for an OLDER proposal that was re-asked for and left
   * orphaned at 'planning' (real incident: 21 such orphaned drafts
   * accumulated with no manager-side way to clear any of them — see
   * canvasProposalCleanup.ts's stale-proposal sweep for the automatic,
   * boot-time counterpart of this same cleanup). Never touches the
   * orchestrator's own persisted record (orchestrators.json) — a rejected
   * plan simply has no more live canvas preview; generate_plan/re-asking
   * mints a brand-new orchestrator and planId regardless.
   */
  | { type: 'reject_plan'; planId: string }
  /** W-DEVPREVIEW (additive) — starts (or reuses) the target project's dev
   *  server through the SAME safe, non-LLM pipeline
   *  useCanvasAutoComposition.ts's background auto-detect already drives
   *  (lib/agents/devPreview.ts: package.json `scripts.dev` only, never
   *  anything derived from mission/agent output), then ensures a preview
   *  node is on the canvas for it and focuses the camera. A canvas-only
   *  action like focus_canvas/arrange_canvas above — executes immediately,
   *  never through a launched mission, never gated on approval. `projectId`
   *  absent -> the ACTIVE project (same resolution rule as create_draft's
   *  own `projectId`). */
  | { type: 'start_preview'; projectId?: string }
  // ── Provisioning (Pillar C3) — provision infrastructure services for a project.
  /** Provisions a service (Supabase DB/Auth/Storage, API key) for a project.
   *  The action gate checks the autonomy mode before executing — provisioning
   *  is always sensitive (requires approval in supervised mode). */
  | { type: 'provision_service'; service: 'supabase-db' | 'supabase-auth' | 'supabase-storage' | 'api-key'; projectId?: string; config?: Record<string, unknown>; costEstimateCents?: number }
  /** Tears down a previously provisioned service, removing credentials. */
  | { type: 'teardown_service'; serviceId: string }
  // ── Canvas cleanup (B2/P0-4, additive) — real, unbounded manager power to
  // clean part or ALL of the canvas, through the SAME real primitives the
  // context menu/toolbar already use (canvasStore's removeDraft/removeChain/
  // removeRouter/removeJoin/removeSurface/removeFrame/removeNote,
  // agentsStore's archiveMission/deleteMission, AppContext's closeProject) —
  // no parallel path, no silent cap. Archiving (not deleting) is the DEFAULT
  // for anything with a real archived state (a mission) — a draft/note/
  // router/join/surface/frame has none (same asymmetry as delete_mission's
  // own doc comment: "Supprimer" only ever applies to a still-unlaunched
  // Draft), so those are always a genuine removal regardless of `mode`.
  /**
   * Bulk-clears part or ALL of the canvas in ONE action — the direct fix for
   * "vide complètement le canvas" / "nettoie les missions finies du projet
   * X" having no real action to reach for. `scope` picks WHAT to clear:
   *   - 'all': every draft/note/surface/router/join/frame across every
   *     project + Transverse, PLUS every terminal mission this store
   *     currently tracks (state.missions only ever holds the ACTIVE
   *     project's missions — see agentsStore.tsx's changeApprovalMode doc
   *     comment for this pre-existing architectural constraint).
   *   - 'project': same as 'all', narrowed to one project's zone
   *     (`projectId`, resolved by name-or-id the same way create_draft's own
   *     `projectId` is).
   *   - 'terminated' / 'failed': missions only (done/failed/cancelled, or
   *     just failed), optionally narrowed by `projectId`/`olderThanHours`.
   *     NEVER a mission in 'review' — see `includeReview` below, this is
   *     the exact gap a real user hit (P0 fix): a mission in 'review' is
   *     awaiting a human merge decision (approve/reject), not "finished" in
   *     any sense these two scopes mean, so it is deliberately left alone
   *     and the executor's own result honestly reports how many were left
   *     behind (see agentsStore.tsx's `reviewMissionsAwaitingDecision`)
   *     instead of silently reporting "nothing to clean up" in front of a
   *     canvas the user can see is still full.
   *   - 'drafts' / 'notes' / 'surfaces': that ONE canvas artifact kind only,
   *     optionally narrowed by `projectId`.
   *   - 'selection': exactly the refs named in `refs` (same explicit-list
   *     convention as save_macro's own `refs`) — the manager has no view
   *     into a live on-screen multi-select, so this targets whatever refs
   *     the user named or a prior digest showed, never a UI selection.
   * `mode` ('archive' | 'delete', default 'archive') only matters for
   * missions. `mode: 'delete'` on a mission is IRREVERSIBLE (journal history
   * is gone) — never emit it without the user explicitly asking for
   * permanent/definitive deletion (see the Rules section, managerEngine.ts).
   * `olderThanHours` narrows the MISSION side of a scope only
   * (Mission.createdAt) — a draft/note/router/join/surface/frame carries no
   * creation timestamp in this codebase, so it is honestly ignored (never
   * faked) for scopes that only touch those. No functional cap: every
   * matching item is cleared in this one action.
   *
   * `includeReview` (P0 fix — real user test: the manager promised to
   * archive review-status missions under 'terminated', the executor
   * silently excluded them, the user was left with "rien à nettoyer" in
   * front of 27 still-visible missions): an explicit, OFF-by-default opt-in
   * that widens 'all' / 'project' / 'terminated' to ALSO sweep every
   * 'review' mission into the SAME `mode` treatment as any other matched
   * mission — never for 'failed' (a distinct, single-status scope) or the
   * kind-only/'selection' scopes, where it is simply ignored. This is NOT a
   * merge decision: archiving (or deleting) a 'review' mission does not
   * approve or reject it — the pending human decision is just abandoned,
   * unresolved, and the mission disappears from the board either way. For
   * exactly that reason `includeReview: true` is ALWAYS classified
   * 'destructive' (see actionClassifier.ts's `classifyAction`), regardless
   * of `mode` — it requires approval even in full-auto, and the manager
   * MUST state, before emitting it, the exact count of review missions
   * about to lose their pending decision this way (never a vague "je
   * nettoie tout"). Prefer resolving them with approve_mission/reject_mission
   * (individually) or leaving them for the user's own review pass — reach
   * for `includeReview` only when the user explicitly accepts discarding
   * that pending decision (e.g. "archive aussi celles en revue, tant pis
   * pour la review").
   */
  | {
      type: 'clear_canvas';
      scope: 'all' | 'project' | 'terminated' | 'failed' | 'drafts' | 'notes' | 'surfaces' | 'selection';
      mode?: 'archive' | 'delete';
      projectId?: string;
      olderThanHours?: number;
      refs?: string[];
      includeReview?: boolean;
    }
  /** Archives ONE mission explicitly (never deletes) — the same real
   *  `archiveMission` primitive delete_mission already falls back to for a
   *  terminal mission, exposed directly so the manager can say "j'archive
   *  M12" truthfully instead of routing through the ambiguously-named
   *  delete_mission. Honest no-op (with a reason) for an unknown id or a
   *  mission that is not yet terminal (done/failed/cancelled) — archiving a
   *  still-live mission would silently wipe its running worktree/history. */
  | { type: 'archive_mission'; missionId: string }
  /** Bulk-archives every TERMINAL mission (done/failed/cancelled, not
   *  already archived) this store currently tracks — the same real
   *  `archiveMission` primitive the "Archiver les terminées" zone bulk
   *  action already uses, never a fabricated bulk delete. `projectId` is
   *  honored ONLY when it names the currently ACTIVE project (state.missions
   *  holds no other project's missions — same limitation as clear_canvas's
   *  'project' scope); omit it to archive every terminal mission in the
   *  active project. A convenience shorthand for `clear_canvas` with
   *  `scope: 'terminated'` / `mode: 'archive'` — use whichever reads more
   *  naturally in the moment. */
  | { type: 'archive_terminated'; projectId?: string }
  /** Permanently removes ONE not-yet-launched Draft node — the same real
   *  `removeDraft` primitive the context menu's "Supprimer" entry already
   *  uses. A draft has no archived state (see clear_canvas's own doc
   *  comment) — this is always a genuine delete. */
  | { type: 'delete_draft'; draftId: string }
  /** Permanently removes ONE sticky note. */
  | { type: 'delete_note'; noteId: string }
  /** Permanently removes ONE router node (never the missions/drafts it
   *  routed between). */
  | { type: 'delete_router'; routerId: string }
  /** Permanently removes ONE join (fan-in) node. */
  | { type: 'delete_join'; joinId: string }
  /** Permanently removes ONE purely-visual grouping frame — never its
   *  contained nodes (a frame is furniture, not ownership — see
   *  canvasTypes.ts's FrameSpec doc comment). */
  | { type: 'delete_frame'; frameId: string }
  /** Closes ONE terminal/preview surface node — the same real
   *  `removeSurface` primitive a manual close button already uses (also
   *  kills the underlying PTY for a terminal surface). */
  | { type: 'close_surface'; surfaceId: string }
  /**
   * Opens (registers, then activates) a folder as a project — the SAME real
   * `AppContext.registerProject` primitive the welcome screen / "Ouvrir un
   * dossier" cockpit button uses (folder-picker path resolves straight to
   * this). Closes a real feature gap (LazyManager QA, 2026-08-01): a user
   * asking the manager to work on a project at an absolute path that was
   * NOT currently open used to hit a dead end — the manager had no way to
   * open it itself and told the user to go do it by hand in the cockpit UI,
   * after already having wasted a mission launched against the WRONG
   * project's cwd/brain. `path` MUST be an absolute folder path; the Rust
   * `project_register` command validates it exists and is a directory
   * BEFORE registering anything (rejects otherwise with a clear reason —
   * this action never fabricates success). Idempotent: registering an
   * already-open root just re-activates it (same dedup-by-canonicalized-
   * root behavior `registerProject` always had) — never a duplicate entry.
   * Sensitive tier (actionClassifier.ts) — gated behind approval exactly
   * like `launch_mission`, since it mutates workspace state. See the
   * doctrine rule below: never launch a mission whose target path lies
   * outside the active project's root — open the project first.
   */
  | { type: 'open_project'; path: string }
  /**
   * Creates a brand-new directory on disk and registers it as a project —
   * the `project_create` Rust command (src-tauri/src/commands/brain/config/
   * project_registry.rs), which delegates into `project_register`'s own
   * registration body once the directory exists so the two commands can
   * never drift into two different ideas of what "registered" means. Closes
   * a gap `open_project` cannot fill: `open_project`'s `project_register`
   * only ever registers a directory that ALREADY EXISTS — a user asking the
   * manager to work in a brand-new folder used to be a dead end (no `mkdir`
   * reachable anywhere in the manager's action surface, just a message
   * asking the human to create it by hand). Use `open_project` for a folder
   * that already exists; use `create_project` only when it does not yet.
   * `path` MUST be an absolute path to the NEW folder; the PARENT directory
   * must already exist (creates exactly ONE directory level — a typo in
   * `path` can never spawn an unintended deep tree). Idempotent: a `path`
   * that already exists AS A DIRECTORY is just registered, never an error;
   * a `path` that exists as something else (a file) is rejected. Rejects
   * otherwise with the real reason — this action never fabricates success.
   * Sensitive tier (actionClassifier.ts) — gated behind approval exactly
   * like `open_project`, since it mutates the filesystem and the project
   * registry.
   */
  | { type: 'create_project'; path: string }
  /** Removes a project from the open-projects registry/canvas entirely — the
   *  SAME real `AppContext.closeProject` primitive the Projects rail's own
   *  close button uses (switches away first when it is the active project
   *  and another remains open, same ordering the fleet-hygiene sweep's
   *  test-scratch closure already establishes — agentsStore.tsx's
   *  `runFleetHygieneSweep`). Distinct from `collapse_project` (which only
   *  visually folds a project's zone — the project stays fully open): use
   *  this one when the user actually wants the project GONE from the
   *  canvas/registry. `projectId` resolves by name-or-id the same way
   *  create_draft's own does; absent defaults to the active project. */
  | { type: 'close_project'; projectId?: string }
  // ── Self-improvement & learning (Pillar B3/D) — the manager can trigger
  //  improvement loops, save reusable agent templates, and capture learned
  //  patterns into the Brain. These are sensitive actions (gated in
  //  supervised mode) because self_improve launches missions on the Lazy
  //  repo itself, and learn_pattern writes to the Brain.
  /** Triggers a self-improvement cycle on a project: observes recent
   *  outcomes, diagnoses failures, and generates fix missions. When
   *  projectId targets the Lazy repo itself, this is true self-improvement.
   *  In supervised mode, the gate asks for approval before launching. */
  | { type: 'self_improve'; projectId?: string; maxFixMissions?: number }
  /** Saves a reusable agent template from a successful mission so the
   *  manager can reuse it on future similar tasks across projects.
   *  The template is stored in the in-memory registry and noted in the Brain. */
  | { type: 'create_agent_template'; missionId: string; name?: string }
  /** Captures a learned decision pattern from recent outcomes and writes
   *  it to the Brain as a pattern neuron for future recall. */
  | { type: 'learn_pattern'; trigger: string; action: string; outcome: 'success' | 'failure' | 'partial'; confidence?: number; projectId?: string }
  /** Mission Charter proposal (spec: charte de mission) — emitted BEFORE
   *  building any graph for recurring/permanent work or work needing a
   *  validation gate. See MissionCharter's own doc comment for the 5 blocks
   *  and DecisionWithRecommendation's for why a decision must recommend, not
   *  just ask. `charterId` re-targets an existing pending charter (a
   *  block-level revision, same idiom as revise_plan's `planId`) instead of
   *  creating a new proposal card. */
  | {
      type: 'propose_mission_charter';
      charterId?: string;
      objective: string;
      nature: { kind: MissionNature; cadence?: LoopCadence };
      decisions: DecisionWithRecommendation[];
      validationGates: ValidationGates;
      learning: LearningAndKillSwitch;
    }
  /**
   * Visible-artifact fix (real founder feedback, verbatim: "comment tu me
   * montres les designs proposes ?") — proposes a VISUAL deliverable for
   * human validation BEFORE it becomes a recurring regime's frozen gabarit
   * (LoopConfig.templateArtifactRef). Mirrors propose_mission_charter's
   * "propose, never commit" contract: the executor attaches this verbatim
   * as `ManagerMessage.artifactProposal` (state 'pending') for the chat
   * card (ArtifactProposalCard.tsx), AND materializes/updates a canvas
   * preview surface (SurfaceSpec.htmlViews) with the SAME HTML views — the
   * founder must see the identical visual in both places, never a
   * text-only description of it (see the Rules section below for the
   * short prompt rule making this mandatory for any visual deliverable).
   *
   * `artifactId` (optional, model-supplied — same re-targeting idiom as
   * propose_mission_charter's `charterId`) names this proposal so a LATER
   * turn can resolve it: re-emit propose_artifact with the SAME artifactId
   * and `selectedVariantId` set once the user has picked one (see
   * ArtifactProposalCard.tsx's onSelectVariant -> the interim plain-text
   * relay documented in components/lazyManager/artifactProposal.ts, which
   * carries the EXACT chosen variant's label back to you as the user's own
   * next turn). Once resolved this way, the executor freezes the chosen
   * variant via the EXISTING generic loop-artifact primitive
   * (agentsStore.tsx's `freezeLoopTemplate`, lib/agents/loopArtifact.ts),
   * keyed by this SAME artifactId — never a second/duplicated storage
   * mechanism. Passing that SAME artifactId string as `templateArtifactRef`
   * on a later create_loop is what lets the recurring regime consume this
   * frozen gabarit every iteration without ever regenerating it (spec §4).
   * Omit `artifactId` only for a one-off, never-revisited proposal — there
   * is then nothing stable to key a later resolution or freeze against.
   */
  | {
      type: 'propose_artifact';
      artifactId?: string;
      /** Plain-language name of the artifact (e.g. "Gabarit visuel"). */
      name: string;
      version?: string;
      /** At least one variant — see ArtifactVariant's own doc comment.
       *  Propose SEVERAL when an aesthetic choice is genuinely in play
       *  (spec: "plusieurs propositions, dont une avec notre DA"). */
      variants: ArtifactVariant[];
      /** Present to RESOLVE a previously-proposed artifact (same
       *  artifactId) with the user's chosen variant id — absent on the
       *  initial, still-pending proposal. */
      selectedVariantId?: string;
      /** Same resolution rule as create_draft's own `projectId` (absent ->
       *  active project; a value matches a known id or name; unresolvable
       *  falls back to Transverse with an honest toast) — where the canvas
       *  preview surface lands. */
      projectId?: string;
    }
  /**
   * Mission D (spec §5) — drives a real, persistent-profile browser session
   * through a fully DATA-described recipe (see browserRecipe.ts's own module
   * doc comment): no site name, selector, or content format ever appears in
   * source, only in this action's `recipe` payload. `validateOnly` (default
   * true, mirrored from RunBrowserRecipeOptions) is the safety default: the
   * runner stops BEFORE the step flagged `irreversible` (spec's "s'arrêter
   * avant le clic final"), never actually publishing unless a caller
   * deliberately passes `false`. A guard match (unexpected screen) or a
   * failed step aborts the run immediately regardless of `validateOnly` —
   * see BrowserRecipeResult's own fields for what the executor reports back.
   */
  | { type: 'run_browser_recipe'; recipe: import('./browserRecipe.js').BrowserRecipe; validateOnly?: boolean }
  // ── LazyBots (A3) — the LazyManager creates/manages LazyBots from the
  // chat, and a running bot can ask the manager for human intervention
  // (login/2FA/takeover — see botRequestIntervention.ts). Additive only.
  /** Creates a new LazyBot: a persistent, named agent persona with its own
   *  system prompt and autonomy that runs managed missions (botEngine.ts).
   *  `name` is REQUIRED — the manager must ask the user for one and never
   *  invent it (the executor returns an honest error when it is missing).
   *  `capabilities` is optional and defaults per-field to
   *  DEFAULT_CAPABILITIES (browser true, desktop/sandbox false).
   *  Rich optional fields (`profileIds`, `routines`, `avatar`,
   *  `budgetCapUsd`) mirror botsStore.createBot — never force empty
   *  profileIds when the model supplied some. */
  | {
      type: 'create_lazybot';
      name: string;
      description?: string;
      systemPrompt: string;
      autonomy?: 'manual' | 'supervised' | 'yolo';
      capabilities?: { browser?: boolean; desktop?: boolean; sandbox?: boolean };
      profileIds?: string[];
      routines?: import('../bots/botTypes.js').BotRoutine[];
      avatar?: string;
      budgetCapUsd?: number;
    }
  /** Updates an existing LazyBot's configuration fields (patch merge —
   *  `patch` is a Partial<BotConfig>, including profileIds / routines /
   *  avatar / budgetCapUsd). Only works on a bot id that really exists;
   *  the executor reports an honest error otherwise. */
  | { type: 'update_lazybot'; botId: string; patch: Partial<import('../bots/botTypes.js').BotConfig> }
  /** Runs a LazyBot on a task: launches a managed bot mission
   *  (launchBotRun) rooted at the resolved project, on `model` or the active
   *  model. Returns the run id + mission id to the manager. */
  | { type: 'run_lazybot'; botId: string; task: string; model?: string }
  /** Stops every currently running run of a LazyBot (stopBotRun per active
   *  run via listActiveRunsForBot). */
  | { type: 'stop_lazybot'; botId: string }
  /** Lists all saved LazyBots with a coarse runtime summary
   *  ({ id, name, autonomy, enabled, activeRuns, status }). */
  | { type: 'list_lazybots' }
  | { type: 'info'; message: string };

// ── Mission contract (spec §8, T1.2) ───────────────────────────────
// Formalizes what a mission launch commits to: objective, scope, model +
// effort, permission mode, the pre-launch quote, budget cap, required
// proofs, gates, and team-sharing. See lib/agents/estimator.ts for how
// `quote`/`budgetCapUsd` defaults are computed, and NewMissionModal.tsx for
// where a contract is assembled from the launch form.
//
// Ownership note (parallel Wave-1 tasks touching this file): this block
// (Effort, ProofRequirement, GateConfig, MissionContract, Mission.contract)
// is T1.2's. `ProofArtifact` (the produced evidence, distinct from the
// ProofRequirement below) is T1.4's — defined separately. Neither task
// touches the ManagerAction union above (T2.8 owns it).

/**
 * Reasoning effort requested for the mission's model, when the underlying
 * model supports it. Mirrors lib/models/openrouterCatalog.ts's
 * ReasoningEffort ('low' | 'medium' | 'high') by design, kept as an
 * independent alias here so this shared low-level types module carries no
 * dependency on lib/models.
 */
export type Effort = 'low' | 'medium' | 'high' | 'max';

/**
 * One requirement a mission must satisfy before it can enter Done (spec
 * §8's proof-of-work gate). This is the REQUIREMENT the contract asks for,
 * not the produced evidence — compare to `ProofArtifact` (T1.4), which is
 * the artifact an agent actually attaches at runtime.
 */
export interface ProofRequirement {
  kind: 'screenshot' | 'test_run' | 'e2e_recording' | 'command_output' | 'behavior_diff';
  label?: string;
}

/**
 * Pre-human gate configuration (spec §8: "tester/reviewer/security/judge +
 * human approve"). `evaluators` toggles the existing automated evaluator
 * pipeline (evaluator.ts); `humanApprove` keeps the existing manual
 * approve/reject step (approveGate.ts) required before merge.
 */
export interface GateConfig {
  evaluators: boolean;
  humanApprove: boolean;
}

// ── Approval modes (W-MODES) ────────────────────────────────────────
/**
 * Per-project (+ global default) merge-approval automation level — Claude
 * Code's Plan/AcceptEdits/Auto permission-mode semantics, applied to mission
 * MERGES rather than file edits (see approvalMode.ts for persistence,
 * approveGate.ts's `evaluateAutoMerge` for the eligibility matrix, and
 * agentsStore.tsx's `triggerAutoMergeIfEligible` for the choke point).
 *
 *   - 'manual'     — today's behavior, unchanged: a human clicks Approve.
 *   - 'auto_green' — auto-merges a 'review' mission ONLY on the strict green
 *                    path: judgeVerdict.passed === true, no security-reviewer
 *                    rejection, and every contract.proofs kind satisfied
 *                    (hasRequiredProofs). Anything short of that (rejection,
 *                    inconclusive, missing proof) stops for a human exactly
 *                    like 'manual' does today.
 *   - 'full_auto'  — additionally auto-merges a genuinely INCONCLUSIVE
 *                    evaluation (judgeVerdict absent, or present with
 *                    scoreUnavailable === true) via approveMission's existing
 *                    `force` bypass. A HARD, non-overridable safety floor
 *                    still applies in every mode except 'manual': never a
 *                    security-reviewer 'reject', never a real conclusive
 *                    judge rejection (passed === false with a real score),
 *                    the mission's own contract.gates.humanApprove === true
 *                    always wins (explicit per-mission opt-out), and the
 *                    project's budget cap is still enforced. See
 *                    approveGate.ts's evaluateAutoMerge doc comment for the
 *                    exact rule order.
 */
export type ApprovalMode = 'manual' | 'auto_green' | 'full_auto';

/**
 * Mission launch contract (spec §8 — interface shape normative). Assembled
 * by NewMissionModal.tsx at submit time; `quote` comes from
 * lib/agents/estimator.ts's `quote()`, and `budgetCapUsd` defaults to
 * `estimator.defaultBudgetCapUsd(quote)` (3x the quote's cost upper bound).
 */
export interface MissionContract {
  objective: string;
  /** Pre-flight conflict detection + non-dev lanes (spec §7.2/§7.3). */
  scopePaths?: string[];
  model: string;
  effort?: Effort;
  permissionMode: 'plan' | 'acceptEdits' | 'full';
  quote?: { costUsd: [number, number]; durationMin: [number, number]; agents: number };
  budgetCapUsd: number;
  /**
   * Wall-clock cap in milliseconds for the whole mission run (W-GUARD).
   * Mirrors budgetCapUsd's semantics exactly: warn at >=90% elapsed, hard
   * stop at >=100% (see runtime.ts's `armDurationExceededTimer` for the
   * native engine and managedAgent.ts's per-step check for the managed
   * engine). Optional/absent/0/negative -> unlimited — every mission
   * created before this field existed keeps running exactly as before.
   */
  maxDurationMs?: number;
  /** Required to reach Done — enforced by T1.4's approveGate.ts. */
  proofs: ProofRequirement[];
  gates: GateConfig;
  /** Capture promotion toggle — mirrors the per-mission "do not share" flag (spec §6). */
  shareToTeam: boolean;
  /**
   * Delegation depth from the root user-launched mission (spec §7.2, T1.5).
   * 0 = user-launched, 1 = first delegation, 2 = second (max). Enforced by
   * the orchestrator path in runtime.ts — depth-3 spawns are rejected.
   */
  parentDepth?: number;
}

// ── Proof artifacts (spec §8, T1.4) ────────────────────────────────
// The evidence an agent actually attaches at runtime to satisfy the
// ProofRequirement kinds a MissionContract asks for — distinct from
// ProofRequirement above (that's the ASK; this is the PRODUCED evidence).
// Shape is normative (spec §8's `type ProofArtifact` — copied verbatim).
//
// Produced by two paths:
//   - Native (claude-code/codex, runtime.ts): the mission prompt appends a
//     PROOF CONTRACT section (see runtime.ts's buildProofContractBlock)
//     asking the agent to print fenced ```PROOF:<kind> blocks; parsed back
//     out of the final transcript by proofs.ts's parseProofBlocks.
//   - Managed (Pro tier, managedAgent.ts): a dedicated `attach_proof` tool
//     the ReAct loop can call directly, once per artifact.
//
// Stored under `<project>/.lazy/artifacts/<missionId>/` (gitignored) via
// proofs.ts's storeProofText — see that file for the Done-gate helpers
// (hasRequiredProofs/missingProofKinds) approveGate.ts enforces.
export type ProofArtifact =
  | { kind: 'screenshot'; path: string; label: string }
  | { kind: 'test_run'; command: string; exitCode: number; outputPath: string }
  | { kind: 'e2e_recording'; path: string }
  | { kind: 'command_output'; command: string; outputPath: string }
  | { kind: 'behavior_diff'; before: string; after: string };
