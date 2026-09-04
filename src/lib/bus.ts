import type { Mission } from './agents/types.js';
import type { PendingApproval } from './agents/approval/approvalGate.js';

export type AgentLaunchRequest = {
  task: string;
  title?: string;
  model?: string;
  conversation?: { role: string; content: string }[];
};

export type EditApplyRequest = {
  proposedContent: string;
  path?: string;
  language?: string;
};

export type MultiEditApplyRequest = {
  files: Array<{
    path: string;
    proposedContent: string;
    language?: string;
  }>;
};

export type OpenFileRequest = {
  path: string;
  line?: number;
};

export type SelectionToChatRequest = {
  code: string;
  filename: string;
  language: string;
};

export type InlineEditRequest = {
  code: string;
  filename: string;
  language: string;
  instruction: string;
};

export type CursorPosition = {
  line: number;
  col: number;
};

/** Payload for 'nav:navigateSpace'. Plain string form (existing callers)
 *  just switches the active space. The object form additionally deep-links
 *  into a Settings sub-tab (e.g. `{ space: 'settings', tab: 'account' }`
 *  lands on Compte) — see AppContext.tsx's handler and AppShell.tsx's
 *  SpaceContent, which reads the resolved tab back out. QA fix (B5). */
export type NavigateSpacePayload = string | { space: string; tab?: string };

// ── QA fixes: merge (B14) ────────────────────────────────────────────
// Distinguishes the Cockpit urgent card's "Diff" action from "Logs" — both
// used to just call setSelectedMissionId(mission.id) with no further
// signal, so opening the mission drawer via either button landed on
// exactly the same view (see Cockpit.tsx's handleUrgentAction and
// MissionDetail.tsx's subscriber for the two ends of this wire).
// 'history' added by Agent Canvas W8b: MissionDetail's « Historique »
// section (canvas/history/RunHistoryDrawer.tsx) registers a scroll target
// the same way diff/logs do. Consumer side (MissionDetail.tsx's
// focusSection effect) is live; no producer emits it yet — the canvas 'H'
// shortcut / context-menu entry belongs to other waves' files (see the W8b
// handoff note).
export type MissionFocusSection = 'diff' | 'logs' | 'history';
export type MissionFocusRequest = {
  missionId: string;
  section: MissionFocusSection;
};

/**
 * Dead-click fix (real user report, 2026-08-14 — the manager rail's
 * fleet-signal "Diff" button "did nothing"): a mission the fleet signal
 * knows about (useFleetMissions' cross-project journal poll) can be absent
 * from agentsStore's own single-active-project `missions` list at the
 * instant the id is selected — see fleetMissions.ts's own doc comment on
 * the resulting lag. Rather than just waiting and eventually giving up,
 * Cockpit.tsx's handleUrgentAction now ALSO actively loads the real Mission
 * on demand from the exact same source the fleet signal came from
 * (loadMissionsFromJournal, keyed by the mission's own project) and, on
 * success, broadcasts it here so AgentsSpace.tsx (which owns
 * selectedMissionId/MissionDetailDrawer but has no notion of "other
 * projects") can render it immediately without needing a second click. A
 * failed/empty load never emits this — AgentsSpace.tsx's own grace-period
 * toast is the last-resort path for a mission that genuinely cannot be
 * loaded.
 */
export type MissionCrossProjectLoaded = {
  missionId: string;
  mission: Mission;
};

/** Payload for 'canvas:remote-sync' — a team pull merged remote canvas
 *  files into the local app-data canvas. Carries the merged snapshots so a
 *  live CanvasView can apply them immediately (lib/teams/canvasShare.ts). */
export type CanvasRemoteSyncBusPayload = {
  repoUrl: string;
  layout?: unknown;
  chains?: unknown;
};

export type BusEvents = {
  'nav:navigateSpace': NavigateSpacePayload;
  'nav:focusBrainNode': string;
  /** B1: opens the omnibar's AccountPopover — emitted by any clickable
   *  credits KPI tile (Team Solo view, Cockpit, Home) so they all share one
   *  entry point instead of duplicating popover logic. Defined here
   *  additively; the AccountChip owner wave wires the listener. */
  'nav:openAccountPopover': undefined;
  'agent:launch': AgentLaunchRequest;
  'agent:runningCount': number;
  /** Team canvas share (lib/teams/canvasShare.ts → live store): a pull
   *  merged remote canvas files; the payload carries the merged snapshots
   *  so CanvasLiveSync/CanvasView can apply positions immediately. */
  'canvas:remote-sync': CanvasRemoteSyncBusPayload;
  'editor:applyEdit': EditApplyRequest;
  'editor:applyMultiEdit': MultiEditApplyRequest;
  'editor:openFile': OpenFileRequest;
  'editor:selectionToChat': SelectionToChatRequest;
  'editor:inlineEdit': InlineEditRequest;
  'editor:cursor': CursorPosition;
  // ── QA fixes: code (B23) ──────────────────────────────────────────
  /** Palette "Nouveau fichier" / "Renommer" / "Formater le document" —
   *  handled by CenterEditor.tsx (already the sole owner of tabs/platform
   *  wiring for the active file, same pattern as editor:applyEdit above).
   *  No payload: each always targets the currently active tab (rename,
   *  format) or the active project root (new file) — there is no
   *  file-tree "selection" concept outside FileExplorer's own context
   *  menu, which already wires these three actions directly. */
  'editor:newFile': undefined;
  'editor:renameActiveFile': undefined;
  'editor:formatDocument': undefined;
  /** Real filesystem mutation completed outside FileExplorer's own tree
   *  state (e.g. the palette's editor:newFile/editor:renameActiveFile
   *  above) — tells FileExplorer to reload so the tree reflects it. */
  'fs:changed': undefined;
  /** B14: focus the Diff vs Logs section of the mission drawer. */
  'mission:focusSection': MissionFocusRequest;
  /** See MissionCrossProjectLoaded's own doc comment above. */
  'mission:crossProjectLoaded': MissionCrossProjectLoaded;
  /**
   * Agent Canvas W3 (spec §7 "Cross-project honesty"): chainEngine.ts fired
   * a chain whose target draft belongs to a currently-inactive project — no
   * silent background project switch happened. Cockpit.tsx listens and
   * shows a toast with a "Lancer" action that does the REAL switchProject()
   * (chainEngine itself then auto-resumes the launch once the active
   * project actually matches — see chainEngine.ts's module header).
   */
  'chain:pendingCrossProject': { chainId: string; draftId: string; projectId: string; sourceTitle: string };
  /**
   * Agent Canvas W4 (spec §8.2 choreography): LazyManager's `arrange_canvas`
   * action. Bus-routed deliberately — only CanvasView.tsx (via
   * useCanvasLayout) owns the LIVE nodes/edges elkjs needs; the executor
   * (agentsStore.tsx) never reconstructs them as a second reconcile. A
   * no-op when the canvas isn't mounted. `scope` narrows an "auto"
   * arrangement to one project's zone; ignored for "lanes"/"free" (lane
   * mode is a canvas-wide preference, same as the toolbar toggle).
   */
  'canvas:arrange': { scope?: string; mode?: 'auto' | 'lanes' | 'free' };
  /** 2026-08-09 — Cockpit command/construction mode changed from the canvas
   *  top toolbar (CanvasToolbar's `canvas-toolbar-cockpit-mode`). Emitted by
   *  the toolbar AND by Cockpit's own 'C' keyboard shortcut so both surfaces
   *  stay in sync; Cockpit.tsx applies it to its local cockpitMode state. */
  'cockpit:modeChange': { mode: 'command' | 'construction' };
  /**
   * Severity-1 usability-trap fix (2026-08-14, real user report): Command
   * mode's own inline grid has no way back to the canvas once the ONLY mode
   * toggle happened to live inside the canvas toolbar — which Command mode
   * itself unmounts. CockpitLeftRail.tsx's new always-present rail toggle is
   * the real, structural fix (reachable in BOTH modes); this event is the
   * complementary "take me home" gesture — TopNav.tsx emits it when the
   * user re-clicks the ALREADY-active Cockpit pill, and Cockpit.tsx resets
   * `cockpitMode` to its 'construction' default (same value
   * `useState`'s own initializer falls back to) — no payload, always resets
   * to the one default, never toggles/remembers a second value. */
  'cockpit:resetMode': undefined;
  /**
   * Agent Canvas W4 (spec §8.2 choreography): LazyManager's `focus_canvas`
   * action. CanvasView.tsx pans/zooms the camera onto `ref` (400ms glide)
   * and pulses it briefly (reuses the same highlight overlay
   * 'canvas:highlight' below drives).
   *
   * `minZoom` (optional, bug fix): a plain bounding-box `fitView` can land
   * the camera well below a legible zoom for a node whose real render size
   * isn't what the fit computed (e.g. a just-created node, or one with its
   * own zoom-gated compact/full tier like PreviewNode.tsx) — observed live
   * for `start_preview`, which fired this event but left the camera at the
   * canvas's global zoom floor, an unreadable speck. Set by a caller that
   * needs a guaranteed readable floor (see canvasTypes.ts's
   * PREVIEW_FOCUS_MIN_ZOOM); forwarded verbatim to fitView's own `minZoom`
   * option (useCanvasManagerEvents.ts). Omitted by every other emitter,
   * which keeps today's behavior (the canvas's own global minZoom floor).
   */
  'canvas:focus': { ref: string; minZoom?: number };
  /** Jump the canvas camera to a teammate's last reported pan/zoom. */
  'canvas:followViewport': { x: number; y: number; zoom?: number };
  /**
   * Agent Canvas W4 (spec §8.2 choreography): a brief highlight pulse on
   * one or more canvas refs — manager-initiated create_draft/chain_agents/
   * canvas_note mutations (and focus_canvas) emit this so the user SEES the
   * manager acting. CanvasView.tsx auto-clears the pulse after ~2.5s.
   */
  'canvas:highlight': { refs: string[] };
  /**
   * Agent Canvas W8e: opens the per-project « Rapport » page
   * (components/agents/report/ProjectReportPage.tsx) as an overlay over
   * AgentsSpace — a typed deep link so other surfaces (LazyManager's future
   * `open_report` action, a canvas zone-header link, a Bandeau KPI click)
   * can open it without importing AgentsSpace.tsx directly. `projectId`
   * omitted opens the currently active project. AgentsSpace.tsx is the sole
   * subscriber; no producer emits this yet outside its own trigger button.
   */
  'report:open': { projectId?: string };
  /**
   * Agent Canvas W8d (fleet time-travel Replay): fires whenever Replay mode
   * is entered/exited (canvas/replay/useReplayMode.ts's own enter()/exit()).
   * CanvasView.tsx already gates its OWN editing surfaces (toolbar buttons,
   * palette/context-menu/command-bar rendering, node drag/connect) directly
   * — this event is the additive escape hatch for engine-level owners this
   * wave could not touch (chainEngine.ts/managerEngine.ts, both W8c-owned):
   * a future wave may want chainEngine to pause auto-firing new chains, or
   * the manager executor to refuse canvas-mutating actions, while `active`
   * is true. No subscriber wired yet — flagged in the W8d handoff, same
   * "defined here additively, the owning wave wires the listener"
   * convention as `nav:openAccountPopover` above.
   */
  'canvas:replayActive': { active: boolean };
  /**
   * Defect #6 fix (living empty zones): ProjectGroupNode.tsx's zone-digest
   * « Lancer un agent » CTA, shown in a project's zone body once it has no
   * live missions left. Bus-routed for the SAME reason `canvas:arrange`
   * above is: only CanvasView.tsx (via useCanvasEditing's
   * `handlePaletteAddDraft` — the exact real handler the palette/
   * command-bar/quick-create modal already share) owns a working "create a
   * draft targeted at this project" primitive, and this fix's writable set
   * does not include that file. No subscriber wired yet — flagged in this
   * wave's report for the orchestrator stitch, same "defined here
   * additively, the owning wave wires the listener" convention as
   * `canvas:replayActive` above. The intended wiring: call
   * `editing.handlePaletteAddDraft({ title: '', task: '' }, projectId)` (a
   * blank draft, same as the command-bar's own blankDraftEntry) or open
   * CanvasQuickCreateModal pre-targeted at `projectId`.
   */
  'canvas:launchAgentForProject': { projectId: string };
  /**
   * BUG-1/BUG-3: a real charge just settled OR the no_credits wall was hit
   * (managedProvider.ts's notifyWalletMaybeStale, coalesced 5s) — the wallet
   * balance shown anywhere in the UI may be stale. Emitted once per 5s
   * window rather than once per mission in a parallel fleet, so a header
   * badge subscriber (AccountChip.tsx, wave B) refreshes without being
   * spammed. No subscriber wired in this wave — defined here additively,
   * same convention as canvas:launchAgentForProject above.
   */
  'billing:walletMaybeStale': undefined;
  /**
   * Orchestrator plan step is blocked (failed) and awaiting a user decision
   * (retry/revise/skip/abort). Emitted by orchestratorRunner's
   * askUserForBlockedStep; the UI shows a modal and emits
   * 'plan.step_user_decision' in response.
   */
  'plan.step_blocked': {
    planId: string;
    stepId: string;
    diagnoses: unknown[];
    awaitingUserDecision?: boolean;
  };
  /**
   * User's decision for a blocked orchestrator plan step. Emitted by the UI
   * in response to 'plan.step_blocked'; consumed by orchestratorRunner's
   * askUserForBlockedStep promise.
   */
  'plan.step_user_decision': {
    planId: string;
    stepId: string;
    decision: 'retry' | 'revise' | 'skip' | 'abort';
  };
  /**
   * Visual tool activity — emitted when an agent uses a "visual" tool
   * (browser_*, mcp_*, web_fetch, web_search) so the canvas can show
   * a real-time animation/notification. Not emitted for every tool
   * (file reads/writes, git, etc.) — only the ones with a visual
   * dimension the user would want to see.
   */
  'canvas:toolActivity': {
    missionId: string;
    toolName: string;
    label: string;
    icon: 'browser' | 'mcp' | 'web';
    detail?: string;
  };
  /**
   * P-SEARCH (founder directive, verbatim: "la recherche web doit ouvrir
   * une fenêtre liée à l'agent qui demande la recherche et on voit la
   * recherche") — emitted by toolRuntime.ts's `web_search` tool case
   * whenever the call carries mission identity (ToolExecutionContext.
   * missionId/projectId — present for real mission runs, absent for the
   * assistant/codeur chat, which has no mission/project of its own and so
   * never emits this). Two emissions per call: `'searching'` the instant
   * the call starts (before awaiting the Rust command — this is what makes
   * the query genuinely LIVE, "on voit la recherche"), then `'done'` (or
   * `'error'`) once it settles. Consumed by
   * canvas/hooks/useCanvasWebSearchSurfaces.ts, which upserts the owning
   * mission's SearchNode surface (canvasStore.ts's `reportWebSearch`).
   */
  'canvas:webSearchResult': {
    missionId: string;
    agentName?: string;
    projectId?: string;
    query: string;
    status: 'searching' | 'done' | 'error';
    results: Array<{ title: string; url: string; snippet: string }>;
  };
  /** Browser state change — emitted by browserController on every action
   *  (open, navigate, click, fill, screenshot, snapshot, close) so the
   *  canvas browser panel and any other consumer can show a persistent,
   *  real-time view of what the agent is doing in the browser. */
  'browser:stateChange': {
    isOpen: boolean;
    url: string;
    title: string;
    lastAction: string;
    lastActionDetail?: string;
    lastActionAt: number;
    screenshotDataUrl?: string;
    missionId?: string;
    sessionId?: string;
    botId?: string;
  };
  /** Emitted after the Solari API key is set, deleted, or changes — lets LazyBot UI
   *  surfaces (modal, palette, settings) unlock or lock without an app restart. */
  'solari:configuredChange': { configured: boolean };
  /** Approval-gate block — emitted by approvalGate.ts when a consequential
   *  cloud action is intercepted and a human verdict is required. The UI
   *  reads pending state via getPendingApproval/listPendingApprovals and
   *  settles it via resolveApproval. */
  'solari:approvalRequest': PendingApproval;
  /** Approval-gate resolution — emitted on every verdict for a previously
   *  blocked action, including the abort path (verdict 'cancelled'). The
   *  user-facing GateVerdict stays at its four values; 'cancelled' exists
   *  only on the event payload. */
  'solari:approvalResolved': {
    missionId: string;
    verdict: 'approve' | 'edit' | 'deny' | 'alwaysAllow' | 'cancelled';
    editedArgs?: Record<string, unknown>;
  };
  /** Inter-agent message — emitted when one agent sends a message to
   *  another (or broadcasts to all) via the swarm messaging bus. */
  'swarm:message': {
    fromMissionId: string;
    toMissionId: string | 'broadcast';
    message: string;
    timestamp: number;
  };
  /** File change notification — emitted when an agent modifies a file,
   *  so other agents working in the same workspace are aware of changes. */
  'swarm:fileChange': {
    missionId: string;
    filePath: string;
    action: 'write' | 'edit' | 'delete';
    timestamp: number;
  };
  /** LazyReasoningBlocks second safety net — emitted when an agent is stuck
   *  (FSM in SLOW/SKIP for 3+ consecutive steps AFTER self-steering already
   *  tried). The LazyManager listener catches this, does a cross-project brain
   *  search, and injects help via the existing interveneQueues canal. */
  'lazyreasoning:stuck': {
    missionId: string;
    fsmState: string;
    consecutiveHardSteps: number;
    failureType: string | null;
    task: string;
  };
  /**
   * 2026-07-22 memory-pressure incident — devPreview.ts's auto dev-server
   * spawn hit an OS-level "not enough memory to create this process"
   * failure (Windows `os error 8` / POSIX ENOMEM — see terminal.rs's own
   * typed error prefix) and deferred exactly ONE retry rather than let the
   * raw OS error surface as an unowned dialog. Bus-routed for the SAME
   * reason `chain:pendingCrossProject` above is: devPreview.ts is a
   * non-React module with no ToastProvider ancestor of its own to show a
   * toast through. useCanvasAutoComposition.ts (the sole caller of
   * `ensureDevServerForProject`) is the subscriber — it already runs inside
   * a real component tree with toast/i18n access.
   */
  'devPreview:spawnDeferredMemory': { projectId: string; retryInMs: number };
  /**
   * Preview lifecycle fix: devPreview.ts just stopped (explicit
   * `stopDevServer` call, or its own idle-timeout path) a dev server it was
   * managing for `projectId` — `url` is the exact `http://localhost:<port>`
   * it was serving. Before this fix the canvas preview surface for that
   * project was left polling a now-dead port forever (PreviewNode.tsx's own
   * backoff eventually gives up, but the stale "Serveur injoignable" card
   * itself never went away, even across app restarts). Bus-routed for the
   * SAME reason `devPreview:spawnDeferredMemory` above is: devPreview.ts is
   * a non-React module with no canvasStore access of its own.
   * useCanvasAutoComposition.ts (the sole caller of
   * `ensureDevServerForProject`/`noteProjectMissionActivity`) is the
   * subscriber — it removes the project's preview surface, but ONLY when
   * that surface is STILL pointed at this exact `url` (a user who
   * repointed the URL bar elsewhere after auto-creation owns that card now,
   * see previewSurface.ts's `ensureProjectPreviewSurface` reuse contract —
   * never yanked out from under them just because the originally-detected
   * port went away).
   */
  'devPreview:serverStopped': { projectId: string; url: string };
  /**
   * 2026-08-07 wrong-project-preview incident fix — devPreview.ts declined
   * to attach `projectId`'s preview to `port` because a server already
   * answers there but this module has no positive record it belongs to
   * THIS project (see devPreview.ts's own `doEnsureDevServerForProject` doc
   * comment for the real incident: a stale, unrelated project's Next.js dev
   * server got silently shown as this project's own "Live" preview).
   * `ownedByOtherProject` is true when the port is specifically confirmed
   * (persisted, or currently managed in this session) to belong to a
   * DIFFERENT project — false when it is merely unconfirmed either way
   * (never seen before). Bus-routed for the SAME reason
   * `devPreview:spawnDeferredMemory` above is — devPreview.ts has no
   * ToastProvider/i18n access of its own. useCanvasAutoComposition.ts (the
   * sole caller of `ensureDevServerForProject`) is the subscriber — it
   * shows a soft in-app notice instead of silently doing nothing, fired
   * once per decline TRANSITION (never once per ~4s polling tick).
   */
  'devPreview:portUnconfirmed': { projectId: string; port: number; ownedByOtherProject: boolean };
  /** Manager overlay expand/shrink — emitted by GraphProposalCard when a
   *  plan proposal is pending (expand) or resolved (shrink). ManagerOverlay
   *  listens and transitions its width state accordingly. */
  'manager:expandOverlay': undefined;
  'manager:shrinkOverlay': undefined;
  /** Manual manager-overlay width toggle (normal<->expanded) — emitted by
   *  Cockpit.tsx's 'E' keyboard shortcut (mirrors its existing bare 'C'
   *  cockpit-mode shortcut), so the shortcut and the header's own
   *  widen/narrow button (LazyManagerHeader -> ManagerOverlay) share the
   *  exact same manual-toggle code path without lifting widthState out of
   *  ManagerOverlay (Cockpit.tsx can't call it directly — the overlay is a
   *  sibling, not a child, of Cockpit's own component). */
  'manager:toggleOverlayWidth': undefined;
  /** Manager overlay width changed — emitted by ManagerOverlay whenever its
   *  widthState transitions, so FluxFooter can reserve the exact live width
   *  instead of a static worst-case constant. */
  'manager:overlayWidthChange': { width: number };
  /** Canvas context menu "Envoyer au Manager" — emits the canvas ref so the
   *  manager composer can prefill with context about that node. */
  'manager:sendToManager': { ref: string; label: string };
  /** Prefill the manager composer with text (e.g. from canvas context menu)
   *  and optionally expand the overlay if it's collapsed. */
  'manager:prefill': { text: string; expand?: boolean };
  /** Scheduler deferred a launch — manager wakeup should include the reason
   *  (scope_conflict / pool_full) without the scheduler importing managerEngine. */
  'scheduler:queued': {
    missionId: string;
    projectId: string;
    reason: 'pool_full' | 'scope_conflict';
    pool: string;
    depth: number;
    conflictsWith?: string[];
  };
  /** Durable queue flagged a still-queued mission as stale — manager policy, not auto-relaunch. */
  'scheduler:stale': { missionId: string; projectId?: string; waitedMs: number };
  /** Learning pipeline skipped a run because of cooldown — surface remaining ms. */
  'agent:learningCooldown': { projectId: string; remainingMs: number };
  /** Brain sidecar cache said reachable but a live probe failed (or TTL expired while down). */
  'agent:sidecarStale': { reachable: boolean };

  // ── Phase 6: Graph lifecycle events (SGR) ────────────────────────

  /** A graph run has started executing. Emitted by runGraph at the top of
   *  the wave loop, before any node is launched. */
  'graph.run_started': {
    runId: string;
    graphId: string;
    sourcePlanId?: string;
  };

  /** A node within the graph has started executing (attempt N). */
  'graph.node_started': {
    runId: string;
    nodeId: string;
    attempt: number;
    contest?: boolean;
    n?: number;
  };

  /** A node within the graph has finished (done, failed, skipped, contested). */
  'graph.node_finished': {
    runId: string;
    nodeId: string;
    status: 'done' | 'failed' | 'skipped';
    contestWinner?: string;
    costUsd?: number;
    durationMs?: number;
    errorMessage?: string;
  };

  /**
   * A join or loop node within the graph has finished — the join/loop-kind
   * counterpart of 'graph.node_finished' above, which only task/contest
   * nodes emit (see runGraph.ts's join/loop node handling, the only two
   * call sites). Was emitted via the untyped GraphExecutorDeps.emit(type:
   * string, ...) escape hatch (sgrOrchestratorRunner.ts's own emit wrapper
   * casts through `as keyof BusEvents`) without ever being declared here —
   * a real typing hole, now closed. No subscriber wired yet — defined here
   * additively, same "defined here additively, the owning wave wires the
   * listener" convention as 'canvas:replayActive' above.
   */
  'graph.node_done': {
    runId: string;
    nodeId: string;
    status: 'done' | 'failed';
  };

  /** The graph run completed successfully (all nodes done). */
  'graph.run_finished': {
    runId: string;
  };

  /** The graph run failed (a critical node failed and replan gave up). */
  'graph.run_failed': {
    runId: string;
    failedNode?: string;
    reason?: string;
  };

  /** The graph run was cancelled (user abort or signal). */
  'graph.run_cancelled': {
    runId: string;
  };

  /** The graph run exceeded its budget limit. */
  'graph.run_budget_exceeded': {
    runId: string;
    spent: number;
    limit?: number;
  };

  /** A replan was triggered for a failed node. */
  'graph.replan': {
    runId: string;
    nodeId: string;
    reason: string;
    action: 'retry' | 'abort' | 'skip';
    patch?: unknown;
  };

  /**
   * A replan attempt itself threw (deps.diagnose()/replanEngine() call
   * failed), distinct from 'graph.run_failed' (a replan that ran to
   * completion and decided to abort). Same untyped-escape-hatch typing hole
   * as 'graph.node_done' above, now closed. No subscriber wired yet.
   */
  'graph.replan_error': {
    runId: string;
    nodeId: string;
    error: string;
  };

  /** An interrupt node paused the run, awaiting a resume token. */
  'graph.interrupt': {
    runId: string;
    nodeId: string;
    reason?: string;
    payload?: unknown;
    resumeToken: string;
  };

  /** A service was successfully provisioned for a project. */
  'provisioning.provisioned': {
    service: string;
    projectId: string;
    endpoint?: string;
  };

  /** A provisioned service was torn down. */
  'provisioning.teardown': {
    service: string;
    projectId: string;
  };
  /** Collab mission handoff confirmation (MissionTransferAction). */
  'toast:info': { message: string };
  /** E106 — brain ops orphan (timed_out / stuck past budget). */
  'brain://ops': {
    phase: string;
    step: string | null;
    pid: number | null;
    detail: string;
    brainPath: string | null;
  };
  /** LazyBot → LazyManager human-intervention request (e.g. a login/2FA/
   *  captcha/takeover a running bot cannot complete itself). Emitted by
   *  lib/bots/botRequestIntervention.ts's `requestUserIntervention`; the
   *  LazyManager UI (LazyManagerHeader) subscribes and surfaces the
   *  outstanding request. The bot keeps running while the request is
   *  outstanding — the human answers by taking over the session, or asks the
   *  manager to stop the bot run. */
  'bot:intervention': { botId: string; reason: string; detail?: string; at: number };
  /** C76 — LazyBot cron routine failed to launch (scheduler catch). */
  'bot:routineFailed': {
    botId: string;
    botName: string;
    routineId: string;
    routineName: string;
    error: string;
    at: number;
  };
  /** LazyBot end-of-run learning record (botLearning.ts) — Brain LTM consumers. */
  'bot:learning': {
    space: 'bot';
    kind: 'lazybot_report';
    botId: string;
    botName?: string;
    missionId: string;
    task: string;
    report: string;
    at: string;
    cloudTools?: string[];
    conversationId?: string;
  };
  /** Emitted when the user opens a LazyBot's VM window (from its canvas node).
   *  BotVmHost subscribes and renders a floating VM window for that bot. */
  'bot:openVm': { botId: string; title?: string };
  /** LazyBot VM window toggled open/closed on the canvas (botVmWindows.ts). */
  'botVmWindows:changed': { botId: string; open: boolean };
  /** LazyBot roster persisted (create/update/delete/enable). The canvas and
   *  botsStore subscribe so a manager-created bot appears without a reload. */
  'lazybots:changed': { botId?: string };
  /** Emitted by projectRootCache.setCachedProjectRoot the first time the
   *  project root is resolved after boot, so listeners (useCanvasFlowGraph's
   *  bot loader) can reload without polling. */
  'projectRoot:resolved': { root: string };
};

type Handler<T> = (payload: T) => void;

// Vite dev mode can create multiple module instances of bus.ts when the same
// file is imported with different specifiers (e.g. '../bus.js' vs '../../bus').
// A module-level `handlers` object would then be split across instances —
// emit() from one instance would never reach on() handlers registered on
// another. Storing the registry on globalThis guarantees a single shared bus
// regardless of how many times the module is instantiated.
type HandlerRegistry = { [K in keyof BusEvents]?: Set<Handler<BusEvents[K]>> };
const GLOBAL_KEY = '__lazyBusHandlers';
function getHandlers(): HandlerRegistry {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = {};
  return g[GLOBAL_KEY] as HandlerRegistry;
}
const handlers = getHandlers();

// 2026-08 fifth verification pass (GraphProposalCard.tsx/ManagerOverlay.tsx
// own headers) — the manager overlay is SUPPOSED to auto-widen the instant
// a plan proposal arrives, but the founder measured it staying docked for
// one real proposal tonight despite the prior widthStateRef fix (verified
// by test) being in. Three candidate causes, none provable from reading the
// code alone: the expand event never fires for this path, it fires but
// something re-collapses right after, or a listener is simply missing at
// that moment. Same dev-only ring-buffer pattern as previewLayoutWorkerClient.ts's
// own `window.__lazyLayoutDebugLog` (that module's header explains the
// rationale in full) — traces every EMIT of the two overlay-width events,
// including the live listener count at the moment of emission (0 listeners
// is definitive proof of "nobody was there to hear it", vs. >0 meaning the
// signal reached a handler and something ELSE inside that handler decided
// not to act — see ManagerOverlay.tsx's own receipt-side trace for that
// half). Read live via:
//   copy(JSON.stringify(window.__lazyBusDebugLog ?? []))
const BUS_DEBUG_ENABLED = import.meta.env.DEV;
const BUS_DEBUG_LOG_MAX_ENTRIES = 100;
// Deliberately NOT every event — this bus carries high-frequency traffic
// (canvas:*, browser:stateChange, graph.node_*) a blanket trace would drown
// in; scoped to exactly the two events this investigation is about.
const BUS_TRACED_EVENT_TYPES: ReadonlySet<string> = new Set(['manager:expandOverlay', 'manager:shrinkOverlay']);

function pushBusDebugEntry(entry: Record<string, unknown>): void {
  const globalScope = globalThis as unknown as { __lazyBusDebugLog?: unknown[] };
  if (!Array.isArray(globalScope.__lazyBusDebugLog)) globalScope.__lazyBusDebugLog = [];
  const log = globalScope.__lazyBusDebugLog;
  log.push({ ...entry, at: Date.now() });
  if (log.length > BUS_DEBUG_LOG_MAX_ENTRIES) log.shift();
}

/** Exported so GraphProposalCard.tsx's own emit-side effect and
 *  ManagerOverlay.tsx's own receipt-side listeners can append to the SAME
 *  `window.__lazyBusDebugLog` ring buffer this module's own `emit` trace
 *  writes to — one chronologically-interleaved trace spanning "card decided
 *  to emit" -> "bus delivered to N listener(s)" -> "overlay received and
 *  decided X", instead of three disjoint logs a developer has to manually
 *  correlate by timestamp (same rationale as previewLayoutWorkerClient.ts's
 *  own `_debugLogPreviewLayout` export). */
export function _debugLogOverlayWidth(event: string, data: Record<string, unknown>): void {
  if (!BUS_DEBUG_ENABLED) return;
  console.debug('[bus:debug]', event, data);
  pushBusDebugEntry({ event, ...data });
}

export function emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void {
  const bucket = handlers[type] as Set<Handler<BusEvents[K]>> | undefined;
  if (BUS_TRACED_EVENT_TYPES.has(type)) {
    const listenerCount = bucket?.size ?? 0;
    if (BUS_DEBUG_ENABLED) console.debug('[bus:debug] emit', type, `listeners=${listenerCount}`);
    if (BUS_DEBUG_ENABLED) pushBusDebugEntry({ event: 'bus emit', type, listenerCount });
  }
  if (!bucket) return;
  for (const handler of bucket) {
    handler(payload);
  }
}

export function on<K extends keyof BusEvents>(
  type: K,
  handler: (p: BusEvents[K]) => void
): () => void {
  let bucket = handlers[type] as Set<Handler<BusEvents[K]>> | undefined;
  if (!bucket) {
    bucket = new Set();
    (handlers as Record<string, unknown>)[type] = bucket;
  }
  bucket.add(handler);
  return () => {
    bucket!.delete(handler);
  };
}
