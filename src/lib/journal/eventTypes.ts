/* eventTypes.ts — typed contracts for the event journal (spec §4.2 vocabulary).

   Single shared definition for every event the frontend can emit to the
   journal. Rust treats `payload` as opaque JSON (spec §4.2) — these types
   exist purely for the TypeScript side (emit call sites + this module's own
   serialization) so a caller can never construct an event with a payload
   shape that doesn't match its `type`.

   Reuses `ReviewerRole` from ../agents/types (single source of truth for the
   tester/reviewer/security/judge roles — the existing evaluator pipeline
   this journal's gate.* events describe) instead of redeclaring it here.
*/

import type { ApprovalMode, ReviewerRole } from '../agents/types.js';

// ── Actor ─────────────────────────────────────────────────────────

export type JournalActor = 'user' | 'agent' | 'manager' | 'system';

// ── Common envelope (every event carries these) ──────────────────

interface JournalEventBase {
  tsMs: number;
  projectId: string;
  missionId?: string;
  agentId?: string;
  runId?: string;
  actor: JournalActor;
}

/** Binds a literal `type` and its matching `payload` shape onto the common envelope. */
type Evt<T extends string, P> = JournalEventBase & { type: T; payload: P };

// ── project.* ──────────────────────────────────────────────────────

export interface ProjectRegisteredPayload {
  root: string;
  brainId?: string;
}
export interface ProjectOpenedPayload {
  root: string;
}
export interface ProjectClosedPayload {
  root: string;
}

// ── mission.* ────────────────────────────────────────────────────────

export interface MissionCreatedPayload {
  title: string;
  objective?: string;
  model?: string;
  /**
   * Full Mission snapshot (T0.5 gap fix) — lets `missions_current.data`
   * (Rust's apply_mission_projection, journal.rs) store a restorable
   * Mission on creation instead of just title/objective/model, which is
   * what makes booting the mission list FROM THE JOURNAL possible (see
   * src/lib/journal/missionsProjection.ts). Optional/`unknown` because
   * Rust treats every payload as opaque JSON (spec §4.2) — this field only
   * exists to keep TS emit call sites honest about what they send.
   */
  mission?: unknown;
  /** Set by the one-shot legacy migration (src/lib/journal/migrate.ts) on
   *  a synthetic mission.created replayed from missions.json/mission-queue.json
   *  — absent (not merely false) on a mission created live through the UI. */
  imported?: boolean;
}

/**
 * Full-snapshot refresh (T0.5): emitted whenever a mission's stored shape
 * changes (see agentsStore.tsx's debounce-save effect) so
 * `missions_current` always reflects the latest Mission object, not just
 * whatever mission.created captured at creation time.
 */
export interface MissionUpdatedPayload {
  mission: unknown;
}
/** Mirrors MissionContract.quote (spec §8). */
export interface MissionQuotedPayload {
  costUsd: [number, number];
  durationMin: [number, number];
  agents: number;
}
export interface MissionQueuedPayload {
  position?: number;
}
export interface MissionStartedPayload {
  model: string;
  effort?: string;
}
export interface MissionStepPayload {
  text: string;
  /** Managed-loop step markers — see managedAgent.ts's Reflexion/PRM instrumentation (T0.4). */
  marker?: 'reflexion' | 'prm';
}
export interface MissionBlockedPayload {
  reason: string;
}
export interface MissionQuestionPayload {
  question: string;
}
export interface MissionAnsweredPayload {
  answer: string;
  /** Set when a Decision neuron was created or reused to answer (spec §6). */
  decisionId?: string;
}
export interface MissionPausedPayload {
  reason?: string;
}
export interface MissionResumedPayload {
  note?: string;
}
export interface MissionIntervenedPayload {
  note?: string;
}
/** spec §8 Takeover — human<->agent baton-pass. */
export interface MissionTakeoverStartedPayload {
  mode: 'managed' | 'native';
}
export interface MissionTakeoverReturnedPayload {
  diffSummary?: string;
}
export interface MissionReviewRequestedPayload {
  proofCount: number;
}
/** Mirrors spec §8's ProofArtifact union (kind discriminates the extra fields, kept
 *  optional here since payload is stored as opaque JSON — Rust never branches on it). */
export interface MissionProofAttachedPayload {
  kind: 'screenshot' | 'test_run' | 'e2e_recording' | 'command_output' | 'behavior_diff';
  path?: string;
  label?: string;
  command?: string;
  exitCode?: number;
  outputPath?: string;
  before?: string;
  after?: string;
}
export interface MissionApprovedPayload {
  approvedBy?: string;
  /**
   * W-MODES (per-project approval modes) — 'auto' when this approval was
   * fired by the auto-merge engine (agentsStore.tsx's
   * `triggerAutoMergeIfEligible`) rather than a human's "Merger" click.
   * Absent — never a fabricated 'user' — for every pre-existing call site
   * and every human-initiated approval, matching this codebase's "absent,
   * never a fabricated default" honesty convention (see e.g. JudgeVerdict.
   * scoreUnavailable's own doc comment for the same pattern).
   */
  actor?: 'user' | 'auto';
  /** The approval mode active at merge time — only ever set alongside
   *  `actor: 'auto'` (lets a reader such as projectReport.ts's
   *  CompletedMissionReport or Replay distinguish auto_green from
   *  full_auto without re-deriving it from project config history, which
   *  may have since changed). Absent when `actor` is absent/'user'. */
  mode?: ApprovalMode;
}
export interface MissionRejectedPayload {
  reason?: string;
}
/**
 * A "Merger" attempt (human click, manager `approve_mission` tool, or the
 * auto-merge engine) that did NOT result in a merge — the gate blocked it
 * (ApproveBlockedError: missing/rejected verdict, missing proofs, mission
 * not found/not in review) or the real git merge itself failed for a
 * non-conflict reason (a genuine conflict gets its own dedicated
 * `merge.conflicted` event instead — never double-journaled here). Lets the
 * mission's own timeline show the attempt honestly instead of staying
 * silent (agentsStore.tsx's approveMission).
 */
export interface MissionApproveBlockedPayload {
  reason: string;
}
export interface MissionCompletedPayload {
  durationMs?: number;
  costUsd?: number;
}
export interface MissionFailedPayload {
  reason: string;
}
/**
 * Real incident (2026-08-19, overnight run loss) — a distinct, additive
 * audit-trail row alongside (never replacing) the mission.failed row a
 * quota-exhaustion failure ALSO always emits (see runtime.ts's runMission,
 * same convention as scheduler.queued alongside mission.queued —
 * SchedulerQueuedPayload's own doc comment). Lets Replay/history tell "hit
 * the CLI's own subscription/session quota wall" apart from an ordinary
 * agent failure without re-parsing `reason`'s free text. `reason` mirrors
 * the mission's own honest statusReason at the moment this fired (see
 * quotaExhaustion.ts's formatQuotaExhaustionReason) — never a fabricated
 * "see agent logs" pointer. `resetAtMs` absent means the CLI's own message
 * carried no parseable reset time, not that the quota never resets.
 */
export interface MissionQuotaExhaustedPayload {
  reason: string;
  resetAtMs?: number;
}
export interface MissionCancelledPayload {
  reason?: string;
}
export interface MissionRevertedPayload {
  /** Whether the merge commit had to be `git revert`ed vs. just dropping an unmerged worktree (spec §8). */
  merged: boolean;
}
/**
 * R13 — mission lifecycle: a TERMINAL mission (done/failed/cancelled) was
 * hidden from the Agent Canvas via the "Archiver" context-menu action.
 * Purely additive/honest: never deletes anything — the mission's own
 * `mission.updated` snapshot flush (agentsStore.tsx's debounce-save effect)
 * still carries `archived: true` in `missions_current`, and this discrete
 * event exists alongside it only so Replay/history has a real, filterable
 * marker of WHEN/by-whom the archive happened (same audit-trail convention
 * as mission.approved/mission.rejected), never a client-only toggle with no
 * journal trace. `statusAtArchive` records the mission's status at archive
 * time for the same reason (a `mission.archived` row alone, without it,
 * would not let a later reader distinguish "archived a done mission" from
 * "archived a failed one" without re-joining against missions_current).
 */
export interface MissionArchivedPayload {
  statusAtArchive: string;
}

/**
 * W-GUARD boot-truth reconcile: a durable mission-queue.json entry was
 * dropped because its mission had already left the queue-relevant lifecycle
 * (review/done/failed/cancelled) — the queue's own enqueue() record was
 * simply never cleaned up when the mission moved on. Mirrors
 * markStaleQueuedMissions' own audit-trail convention (missionQueue.ts).
 * Never destructive to the mission itself — only the stale queue record is
 * removed, from `.lazy/mission-queue.json`.
 */
export interface MissionQueueReconciledPayload {
  /** The mission's real status at reconcile time — why this entry was dropped. */
  missionStatus: string;
}

// ── agent.* ──────────────────────────────────────────────────────────

export interface AgentSpawnedPayload {
  agentIdentity: string;
  template?: string;
  parentMissionId?: string;
  depth?: number;
}
export interface AgentMessagePayload {
  from: string;
  to: string;
  text: string;
}
export interface AgentHandoffPayload {
  from: string;
  to: string;
  contextTokens?: number;
}
export interface AgentDelegatedPayload {
  parentMissionId: string;
  childMissionId: string;
  /** Delegation depth cap is 2 (spec §7.2) — this is the sub-mission's depth, not the cap. */
  depth: number;
}
/**
 * P-SEARCH (founder directive: "on voit la recherche") — emitted by
 * toolRuntime.ts's `web_search` tool case, ONLY when the call carries
 * mission identity (never for the assistant/codeur chat). One event per
 * completed call, successful or not — a zero-result search is still real
 * search activity worth a ticker line. `resultCount` is the honest count
 * DuckDuckGo returned (never the requested max_results). This is pure
 * durable history (activityFeedFormat.ts's ticker + Replay/audit) — the
 * LIVE canvas SearchNode surface is driven separately by the
 * 'canvas:webSearchResult' bus event (lib/bus.ts), never by re-reading
 * this journal event.
 */
export interface WebSearchPayload {
  query: string;
  resultCount: number;
}

// ── tool.* ───────────────────────────────────────────────────────────

export interface ToolCalledPayload {
  name: string;
  files?: string[];
  durationMs?: number;
}

/**
 * Lazy tool-loading budget telemetry (toolRegistryLazy.ts's
 * getToolPromptBudget) — emitted once per mission start (managedAgent.ts),
 * NOT per turn: the tool-definitions block is composed once at mission
 * start and reused via prompt caching for every ReAct step (see
 * managedAgent.ts's module header), so the saving is constant for the whole
 * mission, not a per-turn number. Measures ONLY the tool-definitions block
 * (core full defs + non-core index), never the whole system prompt — an
 * honest before/after: tokensApproxFull is what buildToolSignatures() used
 * to inline for every tool (the pre-lazy-loading behavior), tokensApproxLazy
 * is what this mission's actual core+index split produced.
 */
export interface ToolsContextPayload {
  /** Which AI surface this budget was computed for ('mission'|'codeur'|'manager' — toolRegistryLazy.ts's ToolSurface). */
  surface: string;
  totalTools: number;
  /** Tools shown in full this run (surface's coreFor set + suggestTools' preload hits). */
  coreCount: number;
  /** Tools shown as a one-line index hint only (fetchable via find_tool). */
  indexCount: number;
  tokensApproxFull: number;
  tokensApproxLazy: number;
  /** Rounded percent reduction in the tool-definitions block size. */
  savingsPct: number;
}

// ── spend.* ──────────────────────────────────────────────────────────

export interface SpendTokensPayload {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** 'estimated' -> 'settled' transition for managed-engine usage correction (T0.4). */
  source: 'real' | 'estimated' | 'settled';
  /** Prompt-cache READ tokens (M12 dogfood fix, undercount honesty) — see
   *  AgentMetrics.cacheReadInputTokens's doc comment (types.ts). Undefined
   *  when the backend never reported the field, never a fabricated 0. */
  cacheReadInputTokens?: number;
}

// ── budget.* ─────────────────────────────────────────────────────────

export interface BudgetWarningPayload {
  /** Percent of budgetCapUsd consumed at the time of the warning (e.g. 90). */
  pct: number;
  capUsd: number;
}
export interface BudgetExceededPayload {
  capUsd: number;
  spentUsd: number;
}

// ── duration.* (W-GUARD, wall-clock cap enforcement) ──────────────────
// Mirrors budget.*'s naming/shape exactly — see MissionContract.maxDurationMs
// (agents/types.ts) for the field this classifies against.

export interface DurationWarningPayload {
  /** Percent of maxDurationMs elapsed at the time of the warning (e.g. 90). */
  pct: number;
  capMs: number;
}
export interface DurationExceededPayload {
  capMs: number;
  elapsedMs: number;
}

// ── gate.* ───────────────────────────────────────────────────────────

export interface GatePassedPayload {
  role: ReviewerRole;
  score?: number;
}
export interface GateFailedPayload {
  role: ReviewerRole;
  reason?: string;
}

// ── brain.* ──────────────────────────────────────────────────────────

export interface BrainRecalledPayload {
  query: string;
  nodeIds: string[];
  /** Present for cross-project transfer hits (spec §5.3). */
  sourceProject?: string;
}
export interface BrainCapturedPayload {
  neuronId: string;
  kind: string;
}
/** Emitted when a capture gives up after exhausting every retry (see
 *  captureQueue.ts's announceGiveUp) — the durable, queryable counterpart to
 *  the ephemeral onCaptureGiveUp() toast, so a lost note is never silent
 *  even when no UI happened to be mounted to catch the toast. `missionId`
 *  lives on the shared envelope (JournalEventBase), not here, matching every
 *  other mission-scoped event in this file. */
export interface BrainCaptureFailedPayload {
  /** The CaptureEvent.kind that failed to persist (see platform/types.ts). */
  kind: string;
}
export interface BrainPromotedPayload {
  neuronId: string;
  scope: 'project' | 'org';
}
export interface BrainDecisionCreatedPayload {
  question: string;
  answer: string;
}
export interface BrainDecisionHitPayload {
  decisionId: string;
  question: string;
}

/** E106 — long-running brain ops orphaned / timed out (ops-status.json). */
export interface BrainOpsOrphanPayload {
  phase: string;
  step: string | null;
  pid: number | null;
  detail: string;
  timeoutSecs: number | null;
  brainPath: string | null;
}

// ── loop.* ───────────────────────────────────────────────────────────

export interface LoopTickPayload {
  iteration: number;
}
export interface LoopIterationPayload {
  summary?: string;
}

/**
 * ZOMBIE LOOP fix — emitted whenever a registered loop is disabled or
 * unregistered as a direct consequence of its OWN tracked mission reaching a
 * terminal state, so the loop's history shows a real, filterable marker of
 * when/why scheduling stopped (same convention as mission.approved/archived).
 *
 *   - 'merged'/'archived'/'deleted': the mission-terminal choke point itself
 *     (agentsStore.tsx's approveMission/archiveMission/deleteMission) caught
 *     it directly.
 *   - 'stale_registry': loopEngine.ts's tick() caught an enabled loop whose
 *     mission had ALREADY gone terminal — a registry a build predating this
 *     fix left behind, or a race, never the normal path.
 */
export interface LoopStoppedPayload {
  /**
   * 'mission_failed' | 'hard_iteration_cap' | 'repeated_failures' —
   * trust-critical defect #2's runaway-impossible guards (loopEngine.ts's
   * tick(), see its own LoopStopReason doc comment for what each one
   * means). Added alongside the pre-existing four reasons — never replacing
   * them, so every existing consumer keyed on 'stale_registry' etc. keeps
   * matching unchanged.
   */
  reason: 'merged' | 'archived' | 'deleted' | 'stale_registry' | 'mission_failed' | 'hard_iteration_cap' | 'repeated_failures';
}

// ── scheduler.* ────────────────────────────────────────────────────────

/**
 * Emitted by the provider-aware scheduler (src/lib/agents/scheduler.ts, T1.1)
 * when a mission is queued because its pool — or the global
 * `lazy.agents.maxParallel` cap — has no free slot right now (reason
 * 'pool_full'), OR because its predicted file scope overlaps a currently
 * running mission's own scope (reason 'scope_conflict', T1.6, spec §7.2 —
 * see src/lib/agents/preflight.ts's checkConflicts). Additive context
 * alongside, never a replacement for, the `mission.queued` lifecycle event
 * agentsStore.tsx already emits at mission creation (see its doc comment
 * there): this event fires ONLY when the scheduler itself defers a launch,
 * not on every mission.
 */
export interface SchedulerQueuedPayload {
  reason: 'pool_full' | 'scope_conflict' | 'budget_blocked';
  /** Pool id — 'claude-cli', 'managed', or 'byok:<8-char-hash>' (see
   *  scheduler.ts's resolveProvider). */
  pool: string;
  /** Missions now waiting in this pool's queue, including this one. */
  depth: number;
  /** Present only when reason is 'scope_conflict': ids of the currently
   *  running missions this one's predicted scope overlaps (checkConflicts's
   *  conflictsWith). Absent for 'pool_full', which has no such notion. */
  conflictsWith?: string[];
}

/**
 * FOUNDER NORTH STAR ("machine never saturated, adaptation always TOLD, not
 * silent"): emitted by scheduler.ts's pressure watch the first time the
 * shared systemPressure.ts signal trips into a throttling level ('elevated'
 * halves the effective global cap, 'high' admits no new launches at all) —
 * never re-emitted for every subsequent tick at the SAME level, only when
 * the level first becomes non-'normal' or escalates further. Purely
 * informational/audit-trail — the actual admission decision lives in
 * scheduler.ts's canLaunch, not here.
 */
export interface SchedulerThrottledPayload {
  level: 'elevated' | 'high';
}

/**
 * FOUNDER NORTH STAR ("never silent") — root-cause fix (2026-07-28: a
 * validated plan's next step queued for 'pool_full' and never started
 * again for 2+ hours with zero signal anywhere). Emitted by scheduler.ts's
 * periodic safety-net sweep the first time a still-queued entry's wait
 * crosses STALLED_QUEUE_WAIT_MS — never re-emitted for the same still-queued
 * entry (see scheduler.ts's `_stalledEmitted`), so this is a one-shot alert
 * per stall, not a repeating tick. A LATER re-queue of the same mission id
 * (e.g. after a user retry) can signal again fresh once drain() clears the
 * guard.
 */
export interface SchedulerStalledPayload {
  reason: 'pool_full' | 'scope_conflict' | 'budget_blocked';
  /** Pool id — 'claude-cli', 'managed', or 'byok:<8-char-hash>' (see
   *  scheduler.ts's resolveProvider). */
  pool: string;
  /** How long this entry has been waiting, in ms, at the moment this event
   *  fired (always >= STALLED_QUEUE_WAIT_MS). */
  waitedMs: number;
}

// ── teams.* ──────────────────────────────────────────────────────────

export interface TeamsSyncedPayload {
  direction: 'push' | 'pull';
  commits?: number;
}
export interface TeamsPushPayload {
  commit: string;
}
export interface TeamsPullPayload {
  commit: string;
}
export interface TeamsConflictResolvedPayload {
  neuronId: string;
  strategy: string;
}

// ── chain.* (Agent Canvas W3, spec §7) ────────────────────────────────
//
// Per-firing audit trail for chainEngine.ts. `targetRef`/`projectId` are
// carried on every payload (not just derivable from the envelope's own
// missionId/projectId) because a chain firing inherently spans TWO
// coordinates — the source mission's own project (envelope.projectId,
// envelope.missionId) and the TARGET's ref/project, which may differ
// (cross-project chains, spec §7 "Cross-project honesty").

export interface ChainFiredPayload {
  chainId: string;
  /**
   * W8c (additive widening — was required, now optional): absent for a
   * "Relancer l'aval" pin replay (chainEngine.ts's `refireChainDownstream`),
   * which fires a chain's target from a FROZEN pinned snapshot with no new
   * source-mission run behind it. Every pre-W8c emit call site still
   * supplies it, so this is backward-compatible — a reader that expects the
   * field just sees it present, as before.
   */
  sourceMissionId?: string;
  targetRef: string;
  /** The target's project id (the newly-launched mission's project — always
   *  the active project, since a cross-project fire never actually launches
   *  here; see chain.pending_cross_project for that case instead). */
  projectId: string;
  /** W8c (additive) — true when this firing replayed a pinned snapshot
   *  (`refireChainDownstream`) rather than reacting to a live/reconciled
   *  source completion. Absent (not merely false) for every normal fire. */
  replayedFromPin?: boolean;
}
export interface ChainPendingCrossProjectPayload {
  chainId: string;
  sourceMissionId: string;
  targetRef: string;
  /** The target draft's project id — NOT the active project (that's the
   *  whole reason this fired as "pending" instead of chain.fired). */
  projectId: string;
}
export interface ChainResumedPayload {
  chainId: string;
  sourceMissionId: string;
  targetRef: string;
  projectId: string;
}

/** W8c (additive) — pin-output audit trail (canvasStore's `pinChainOutput`
 *  action, deliverable #1). Emitted once per pin, keyed to the SOURCE
 *  mission whose output was frozen. */
export interface ChainPinnedPayload {
  chainId: string;
  sourceMissionId: string;
  targetRef: string;
  projectId: string;
  sourceTitle: string;
}

// ── contest.* (W-CONTEST, best-of-N — Cursor "run N, auto-pick best"
// parity) ────────────────────────────────────────────────────────────────

/** One contestant's final standing — mirrors canvasTypes.ts's
 *  ContestRankingEntry shape, declared independently here rather than
 *  imported (same established convention every other payload in this file
 *  already follows: Rust treats `payload` as opaque JSON, and this module
 *  never imports from components/agents/canvas). `score`/`costUsd` absent
 *  when the contestant carries no real number for that field — never a
 *  fabricated 0, same honesty convention as JudgeVerdict.scoreUnavailable. */
export interface ContestRankingEntryPayload {
  missionId: string;
  score?: number;
  costUsd?: number;
}

/**
 * W-CONTEST — best-of-N contest completion audit trail
 * (contestEngine.ts's `completeContest`). `winnerId` absent covers BOTH "a
 * real judge-passing score never appeared AND nobody even reached done" —
 * the documented honest no-winner case (canvasTypes.ts's ContestSpec doc
 * comment): every contestant stays visible, nothing merges. Never a
 * fabricated pick. `ranking` carries every contestant's real score/cost so
 * the full standings stay auditable even though only the winner (if any) is
 * named by id.
 */
export interface ContestCompletedPayload {
  contestId: string;
  winnerId?: string;
  ranking: ContestRankingEntryPayload[];
}

// ── merge.* (Merger button honesty — abort-on-conflict / honest outcomes,
// see agentsStore.tsx's approveMission and git.rs's agent_merge_worktree_inner) ──

/**
 * A "Merger" click's real `git merge` left a conflict — git.rs's
 * agent_merge_worktree_inner always runs `git merge --abort` before
 * returning, so the target repo's working tree is guaranteed clean again by
 * the time a reader sees this event. Exists purely as the honest, persistent
 * record that a conflict happened — it is what drives the signal card's
 * conflict state (never a fake retry path, "Diff" only).
 */
export interface MergeConflictedPayload {
  branch: string;
}
/**
 * A "Merger" click's `git merge` reported "Already up to date" — the
 * mission's own branch commits are already contained in the target's HEAD
 * (a prior merge, or a duplicate click), so this resolves as an honest
 * no-op success (mission marked done/merged) instead of a fabricated
 * "nothing to merge" error (QA: M39/M40 already-merged missions).
 */
export interface MergeNoopAlreadyMergedPayload {
  branch: string;
}

// ── fleet.* (P58 — automatic fleet hygiene) ───────────────────────────

/**
 * One sweep's honest summary (src/lib/agents/fleetHygiene.ts's
 * `planFleetHygiene`, applied by agentsStore.tsx's `runFleetHygieneSweep`)
 * — emitted ONLY when at least one count is > 0 (a sweep that changed
 * nothing journals nothing, same "never silent, never noisy" convention as
 * `SchedulerThrottledPayload` above), so the activity ticker's "Hygiène : N
 * missions archivées" line (activityFeedFormat.ts) only ever appears when
 * something real happened. `missionId` on the shared envelope is always
 * absent here — a sweep is fleet-wide, never scoped to one mission.
 */
export interface FleetHygienePayload {
  /** Missions auto-archived this sweep (grace-period done/merged, a
   *  grace-period cancelled mission, a failed mission superseded by a newer
   *  retry, or a stale failed mission with no retry — see fleetHygiene.ts's
   *  `ArchiveReason`). */
  archived: number;
  /** Stale signals resolved/purged, e2e/soak-scratch canvas artifacts
   *  deleted, and never-configured preview placeholders past their TTL
   *  (Fix 4) — all real removals this sweep, never a soft archive. */
  purged: number;
  /** Duplicate preview surfaces removed this sweep (kept exactly one per
   *  project — see fleetHygiene.ts's `dedupePreviewSurfaces`). */
  deduped: number;
  /** 2026-07-22 memory-pressure incident fix — e2e/soak-scratch entries
   *  closed from the OPEN-PROJECTS registry this sweep (see
   *  fleetHygiene.ts's `planTestScratchProjectClosure`). A leftover scratch
   *  project left open could otherwise auto-spawn a dev server later
   *  (devPreview.ts) into a cwd that no longer matters. */
  projectsClosed: number;
}

// ── spawn.* (2026-07-22 memory-pressure incident) ─────────────────────

/**
 * FOUNDER NORTH STAR ("adaptation must be TOLD, not silent" — same posture
 * as `SchedulerThrottledPayload` above): devPreview.ts's auto dev-server
 * spawn hit an OS-level "not enough memory to create this process" failure
 * (Windows `os error 8` / POSIX ENOMEM — see terminal.rs's own typed error
 * prefix) and deferred exactly ONE retry rather than let the raw OS error
 * surface as an unowned dialog or silently vanish. Emitted every time this
 * happens (not deduped across repeats — each is a genuinely new failure at
 * a new moment), so it is visible in the activity ticker.
 */
export interface SpawnDeferredPayload {
  reason: 'insufficient_memory';
  /** How long until the single scheduled retry fires. */
  retryInMs: number;
}

// ── approval.* (W-MODES) ─────────────────────────────────────────────

/**
 * Audit trail for an approval-mode flip (agentsStore.tsx's
 * `changeApprovalMode`). Purely additive/informational — never itself
 * triggers a merge: flipping a project (or the global default) to an auto
 * mode never retroactively re-evaluates missions already sitting in
 * 'review' (see approvalMode.ts's `setApprovalMode` doc comment); this
 * event exists so Replay/history has a real, filterable record of WHEN the
 * flip happened and what it changed FROM, the same audit-trail convention
 * as mission.approved/mission.rejected.
 */
export interface ApprovalModeChangedPayload {
  mode: ApprovalMode;
  previousMode: ApprovalMode;
  /** The project this mode change scopes to, or absent for a change to the
   *  GLOBAL default — mirrors objectivesStore.ts's Objective.projectId
   *  null-means-unlinked convention (absent here, rather than null, since
   *  payload fields are already optional/JSON — see this file's header). */
  projectId?: string;
}

// ── app.* (in-place WebView2 crash recovery) ─────────────────────────

/**
 * Emitted by the Rust side (lib.rs's `recover_webview_in_place_or_restart` /
 * `emit_recovery_journal_event`) whenever a crashed WebView2 process was
 * recovered — never silently, per the founder directive that a crash must
 * never cost anything and never show a corpse. `actor: 'system'`,
 * `projectId: 'unknown'` (same convention as `scheduler.throttled` above —
 * a genuinely machine-level event, not scoped to any one project).
 *
 * Written directly to the journal from Rust (not via a TS `emitEvent` call
 * site — there is no live frontend to call from at the exact moment a
 * WebView2 process just failed), which is also why this is one of two
 * payloads in this file with no corresponding TS `emitEvent` call site to
 * point to — see `FrontendErrorPayload` below for the other.
 */
export interface AppRecoveredPayload {
  /** 'in_place': the crashed window was destroyed and recreated without
   *  restarting the process — every sidecar/PTY/mission child survived.
   *  'restart': in-place recreation failed twice in a row, so the whole
   *  app process was restarted instead (the conservative fallback). */
  mode: 'in_place' | 'restart';
}

// ── frontend.* (crash-reporter ingest — see src/lib/crashReporter.ts) ──

/**
 * Written by the Rust `journal_frontend_error` command (journal.rs) as an
 * `emit_system_event` system row — `actor: 'system'`, `projectId: 'unknown'`
 * (same convention as `AppRecoveredPayload` above) — every time
 * crashReporter.ts's `deliver()` calls `invoke('journal_frontend_error', ...)`
 * for an accepted (deduped, rate-limited) `window.onerror` /
 * `unhandledrejection` / React-error-boundary capture.
 *
 * Included here as a MEMBER of `JournalEventInput` purely for documentation
 * and exhaustiveness — the same "no TS emit call site, still a real
 * first-class event type" status `AppRecoveredPayload` has, and precisely
 * why activityFeedFormat.test.ts's exhaustive `feed.eventType.*` coverage
 * check must derive its type list from `JournalEventType` (this union)
 * rather than the wire-level `emitEvent()` call sites: no TS code ever
 * constructs an `Evt<'frontend.error', ...>` value, but the Rust side emits
 * real rows of this exact shape, and the activity ticker (FluxFooter) must
 * still render a real human label for them, not a raw dotted string.
 */
export interface FrontendErrorPayload {
  /** Always 'error' today (crashReporter.ts's CrashRecord.level) — string,
   *  not a literal union, since Rust's `journal_frontend_error` command
   *  accepts any String and forwards it verbatim (spec §4.2: Rust treats
   *  `payload` as opaque JSON). */
  level: string;
  /** Capped at 2000 bytes server-side (journal.rs's MESSAGE_CAP_BYTES). */
  message: string;
  /** Capped at 8000 bytes server-side (journal.rs's STACK_CAP_BYTES); absent
   *  when the captured error had no stack. */
  stack?: string;
  /** crashReporter.ts's CrashSource: 'window.onerror' | 'unhandledrejection'
   *  | `react-boundary:${string}`. */
  source: string;
}

// ── manager.* (proactive wakeup — see src/lib/agents/managerWakeup.ts) ──

/**
 * Audit trail for a PROACTIVE manager turn: the wakeup scheduler
 * (managerWakeup.ts) observed one or more significant events for the
 * active project (a mission reaching done/failed, a merge landing, an
 * approve_blocked, a review verdict, a chain firing, or a big fleet.hygiene
 * sweep) and started a manager turn on its own, with no user prompt.
 * Emitted ONLY when a turn actually starts — never for a candidate that
 * was debounced away mid-window, cap-throttled, or echo-suppressed (see
 * that module's own doc comment) — so this event's mere presence already
 * means "the manager spoke up on its own about this", and it doubles as a
 * real, filterable line in the activity ticker (founder's "everything
 * agents do must be visible" rule) alongside every other automated action
 * (fleet.hygiene, approval.mode_changed, mission.archived).
 */
export interface ManagerWakeupPayload {
  /** Real WakeupEventKind literals (managerWakeup.ts) coalesced into this
   *  one turn — never fabricated, always the scheduler's own classification
   *  of real journal rows from this same poll window. */
  kinds: string[];
  /** Real mission ids involved, deduped, in the order they were observed. */
  missionIds: string[];
}

/**
 * Audit trail for an AUTOMATED manager turn fired once a conversation's
 * pending-approval queue fully drains (managerApprovalResume.ts —
 * agentsStore.tsx's approvePendingAction/rejectPendingAction/
 * approveAllPendingActions/rejectAllPendingActions wiring). Distinct from
 * `manager.wakeup`: this is never journal-event-driven or debounced, always
 * targets the SAME conversation the approval belonged to, and fires exactly
 * once per drain (see managerApprovalResume.ts's own header for the full
 * defect this closes).
 */
export interface ManagerApprovalResumePayload {
  /** The conversation whose pending-approval queue just drained. */
  conversationId: string;
}

// ── lazybot.* (Solari LazyBot runs — see src/lib/bots/runLazyBotMission.ts) ──

/**
 * Emitted by runLazyBotMission.ts the moment a LazyBot run reaches `done`
 * (in addition to the generic `mission.completed` planAndActManaged emits).
 *
 * Why a dedicated event: managerWakeup.ts deliberately ignores
 * `mission.completed` because, for a local agent, the pipeline's own judge
 * verdict (gate.passed/gate.failed role=judge) always follows and is the
 * real "something to tell the user" moment. A LazyBot is a Solari cloud
 * computer — no worktree, no diff, no judge — so nothing ever followed and
 * the manager was never woken up: live QA 2026-09-02, the user asked the
 * manager to have a bot read example.com's title, the bot finished with the
 * title in its report, and the conversation never heard about it. This
 * event carries the bot's own final report so the wakeup can relay it.
 */
export interface LazyBotCompletedPayload {
  /** The saved LazyBot's id (Mission.botId) — absent for a one-off run. */
  botId?: string;
  /** Display name of the bot (Mission.agentName ?? title). */
  botName: string;
  /** The bot's final report, trimmed to the same 200 chars the mission
   *  timeline shows — the actual answer the user asked the bot for. */
  report?: string;
  /** Origin manager conversation — emit the REAL id the run was launched
   *  from so wakeup lands in the right thread (never the currently-active
   *  tab). Absent for a run started outside the manager. */
  conversationId?: string;
}

/**
 * C76 — cron routine launch/tick failure. Surfaced to the activity feed and
 * manager wakeup so a failed scheduled bot is not console-only.
 */
export interface LazyBotRoutineFailedPayload {
  botId?: string;
  botName: string;
  routineId?: string;
  routineName?: string;
  error: string;
}

// ── The discriminated union (spec §4.2, full vocabulary) ────────────

export type JournalEventInput =
  | Evt<'project.registered', ProjectRegisteredPayload>
  | Evt<'project.opened', ProjectOpenedPayload>
  | Evt<'project.closed', ProjectClosedPayload>
  | Evt<'mission.created', MissionCreatedPayload>
  | Evt<'mission.updated', MissionUpdatedPayload>
  | Evt<'mission.quoted', MissionQuotedPayload>
  | Evt<'mission.queued', MissionQueuedPayload>
  | Evt<'mission.started', MissionStartedPayload>
  | Evt<'mission.step', MissionStepPayload>
  | Evt<'mission.blocked', MissionBlockedPayload>
  | Evt<'mission.question', MissionQuestionPayload>
  | Evt<'mission.answered', MissionAnsweredPayload>
  | Evt<'mission.paused', MissionPausedPayload>
  | Evt<'mission.resumed', MissionResumedPayload>
  | Evt<'mission.intervened', MissionIntervenedPayload>
  | Evt<'mission.takeover_started', MissionTakeoverStartedPayload>
  | Evt<'mission.takeover_returned', MissionTakeoverReturnedPayload>
  | Evt<'mission.review_requested', MissionReviewRequestedPayload>
  | Evt<'mission.proof_attached', MissionProofAttachedPayload>
  | Evt<'mission.approved', MissionApprovedPayload>
  | Evt<'mission.approve_blocked', MissionApproveBlockedPayload>
  | Evt<'mission.rejected', MissionRejectedPayload>
  | Evt<'mission.completed', MissionCompletedPayload>
  | Evt<'mission.failed', MissionFailedPayload>
  | Evt<'mission.quota_exhausted', MissionQuotaExhaustedPayload>
  | Evt<'mission.cancelled', MissionCancelledPayload>
  | Evt<'mission.reverted', MissionRevertedPayload>
  | Evt<'mission.archived', MissionArchivedPayload>
  | Evt<'mission.queue.reconciled', MissionQueueReconciledPayload>
  | Evt<'agent.spawned', AgentSpawnedPayload>
  | Evt<'agent.message', AgentMessagePayload>
  | Evt<'agent.handoff', AgentHandoffPayload>
  | Evt<'agent.delegated', AgentDelegatedPayload>
  | Evt<'agent.web_search', WebSearchPayload>
  | Evt<'tool.called', ToolCalledPayload>
  | Evt<'tools.context', ToolsContextPayload>
  | Evt<'spend.tokens', SpendTokensPayload>
  | Evt<'budget.warning', BudgetWarningPayload>
  | Evt<'budget.exceeded', BudgetExceededPayload>
  | Evt<'duration.warning', DurationWarningPayload>
  | Evt<'duration.exceeded', DurationExceededPayload>
  | Evt<'gate.passed', GatePassedPayload>
  | Evt<'gate.failed', GateFailedPayload>
  | Evt<'brain.recalled', BrainRecalledPayload>
  | Evt<'brain.captured', BrainCapturedPayload>
  | Evt<'brain.capture_failed', BrainCaptureFailedPayload>
  | Evt<'brain.promoted', BrainPromotedPayload>
  | Evt<'brain.decision_created', BrainDecisionCreatedPayload>
  | Evt<'brain.decision_hit', BrainDecisionHitPayload>
  | Evt<'brain.ops_orphan', BrainOpsOrphanPayload>
  | Evt<'loop.tick', LoopTickPayload>
  | Evt<'loop.iteration', LoopIterationPayload>
  | Evt<'loop.stopped', LoopStoppedPayload>
  | Evt<'scheduler.queued', SchedulerQueuedPayload>
  | Evt<'scheduler.throttled', SchedulerThrottledPayload>
  | Evt<'scheduler.stalled', SchedulerStalledPayload>
  | Evt<'teams.synced', TeamsSyncedPayload>
  | Evt<'teams.push', TeamsPushPayload>
  | Evt<'teams.pull', TeamsPullPayload>
  | Evt<'teams.conflict_resolved', TeamsConflictResolvedPayload>
  | Evt<'chain.fired', ChainFiredPayload>
  | Evt<'chain.pending_cross_project', ChainPendingCrossProjectPayload>
  | Evt<'chain.resumed', ChainResumedPayload>
  | Evt<'chain.pinned', ChainPinnedPayload>
  | Evt<'contest.completed', ContestCompletedPayload>
  | Evt<'approval.mode_changed', ApprovalModeChangedPayload>
  | Evt<'merge.conflicted', MergeConflictedPayload>
  | Evt<'merge.noop_already_merged', MergeNoopAlreadyMergedPayload>
  | Evt<'fleet.hygiene', FleetHygienePayload>
  | Evt<'manager.wakeup', ManagerWakeupPayload>
  | Evt<'manager.approval_resume', ManagerApprovalResumePayload>
  | Evt<'lazybot.completed', LazyBotCompletedPayload>
  | Evt<'lazybot.routine_failed', LazyBotRoutineFailedPayload>
  | Evt<'spawn.deferred', SpawnDeferredPayload>
  | Evt<'app.recovered', AppRecoveredPayload>
  | Evt<'agent.message_read', AgentMessageReadPayload>
  | Evt<'frontend.error', FrontendErrorPayload>;

/** P7.2 — Message read receipt for agent mailbox. */
export interface AgentMessageReadPayload {
  messageId: string;
  missionId: string;
}

/** Every valid `type` literal, derived from the union above (single source of truth). */
export type JournalEventType = JournalEventInput['type'];

// ── Wire contracts (client <-> Rust) ─────────────────────────────────

/**
 * Shape sent to `journal_emit` / `journal_emit_batch`. Matches the `events`
 * SQLite table columns (spec §4.1) exactly — the Rust side deserializes
 * these field names as-is (snake_case), unlike a command's own top-level
 * argument names, which Tauri auto-converts from JS camelCase.
 */
export interface JournalEventWireRow {
  ts_ms: number;
  project_id: string;
  mission_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  actor: JournalActor;
  type: JournalEventType;
  payload: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/** A row as returned by `journal_query_events` — the same shape as the `events` table. */
export interface JournalEventRow {
  seq: number;
  ts_ms: number;
  project_id: string;
  mission_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  actor: JournalActor;
  type: JournalEventType;
  /** Raw JSON text — callers `JSON.parse` it themselves (Rust never inspects payload contents). */
  payload: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/** Alias kept for the implementation plan's named contract ("Produces: ... type JournalEvent"). */
export type JournalEvent = JournalEventRow;

/** Filter accepted by `journalQuery` (wraps `journal_query_events`). */
export interface JournalQueryFilter {
  projectId?: string;
  missionId?: string;
  types?: string[];
  sinceSeq?: number;
  sinceMs?: number;
  limit?: number;
}
