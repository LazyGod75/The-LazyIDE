/* actionClassifier.ts — Explicit action classification for universal gating.
 *
 * Phase 2 of the orchestration overhaul: every manager action passes through
 * evaluateActionGate before execution. This module provides the definitive
 * classification of all manager action types into three tiers:
 *
 * - SAFE: read-only / display-only actions, plus REVERSIBLE canvas and
 *   plan-authoring operations (create_draft, chain_agents, generate_plan,
 *   ...) — the manager's actual day-to-day work. Auto-allowed in every
 *   autonomy mode except manual.
 * - SENSITIVE: actions that consume budget or touch real running execution
 *   (launch a mission, execute a plan, approve/reject a mission). Require
 *   approval in supervised/manual mode; auto-allowed in YOLO.
 * - DESTRUCTIVE: irreversible actions (delete_mission, close_project,
 *   clear_canvas in 'delete' mode). Require approval even in YOLO mode.
 *
 * Gate-usability fix (2026-07-28): the previous classification put ordinary
 * canvas-authoring actions (create_draft, chain_agents, generate_plan,
 * move_node, ...) in SENSITIVE, which meant the manager's own core
 * workflow — draft a node, chain two agents, sketch a plan — asked for
 * approval on every single step, with no surface to actually approve from
 * (see evaluateActionGate's 'ask' branch, previously a dead end). Reclassified
 * so only actions that spend money or touch real execution require approval;
 * reversible canvas/plan-authoring moves to SAFE.
 *
 * This is the single source of truth for classification — autonomyMode.ts's
 * SAFE_ACTIONS and SENSITIVE_ACTIONS sets are kept for backward compatibility
 * but this module is what the universal gate path consults.
 */

/** Read-only / display-only actions, plus reversible canvas and
 *  plan-authoring operations — never destroy anything and are trivial to
 *  undo. Auto-allowed in every autonomy mode except manual. */
export const SAFE_ACTIONS = new Set<string>([
  // Read-only / display-only.
  'brain_query',
  'brain_query_css',
  'brain_neighbours',
  'web_search',
  'web_fetch',
  'focus_canvas',
  'canvas_note',
  'canvas_overview',
  'answer_question',
  'info',
  'list_agents',
  'list_missions',
  'query_mission',
  'get_agent_output',
  'briefing_query',
  'decision_lookup',
  'scan_project',
  'quote_mission',
  'arrange_canvas',
  'analyze_frictions',
  'open_report',
  // Reversible canvas / plan-authoring — the manager's core day-to-day work.
  'create_draft',
  'chain_agents',
  'unchain',
  'generate_plan',
  'move_node',
  'create_router',
  'collapse_project',
  'create_agent',
  'save_macro',
  'instantiate_macro',
  'archive_mission',
  'archive_terminated',
  'pin_chain',
  'unpin_chain',
  'refire_chain',
  // Mission Charter proposal — a validation card the user reviews block by
  // block, exactly as reversible/no-op-until-accepted as generate_plan's own
  // proposal (see propose_mission_charter's doc comment, types.ts).
  'propose_mission_charter',
  // Visible-artifact proposal — it PROPOSES a visual deliverable (a chat
  // card + a canvas preview surface), it never destroys anything: rejecting
  // it removes nothing real, and even resolving it to one variant only
  // freezes a versioned artifact (loopArtifact.ts) — no mission launch, no
  // deletion. Same "reversible, no approval needed" tier as
  // propose_mission_charter above (types.ts's propose_artifact doc comment).
  'propose_artifact',
  // LazyBots (A3) — create/update/list persist only a local bot config file
  // (.lazy/bots.json), fully reversible via the same actions, exactly like
  // create_agent above. list_lazybots is read-only.
  'create_lazybot',
  'update_lazybot',
  'list_lazybots',
]);

/** Mutative actions that consume budget or touch real running execution.
 *  Reversible in principle (retry, stop, reassign) but not free to undo.
 *  Require approval in supervised/manual mode; auto-allowed in YOLO. */
export const SENSITIVE_ACTIONS = new Set<string>([
  'launch_mission',
  'launch_best_of_n',
  'fork_graph_run',
  'resume_graph_run',
  'create_loop',
  'pause_loop',
  'delete_loop',
  'stop_mission',
  'stop_all',
  'retry_mission',
  'clone_mission',
  'spawn_submissions',
  'reassign_agent',
  'launch_draft',
  'approve_mission',
  'reject_mission',
  'execute_plan',
  'revise_plan',
  'set_approval_mode',
  'set_budget',
  'start_preview',
  // Opens (registers + activates) a new project — mutates workspace state
  // exactly like a project close does, but is reversible (close_project
  // undoes it), so it sits at the same tier as launch_mission rather than
  // close_project's destructive tier.
  'open_project',
  // Creates a NEW directory on disk and registers it — same reversibility
  // argument as open_project (close_project undoes the registration; the
  // created directory itself is a normal filesystem object, not a special
  // irreversible state), but never auto-approved by mistake: the manager
  // must always ask before creating something that did not exist before.
  'create_project',
  'close_surface',
  'provision_service',
  'teardown_service',
  'self_improve',
  'create_agent_template',
  'learn_pattern',
  // Mission D — drives a REAL browser session (fills forms, clicks
  // non-final buttons) even though `validateOnly` keeps the actual publish
  // step from firing — touches real execution, same tier as start_preview.
  'run_browser_recipe',
  // LazyBots (A3) — run_lazybot launches a real managed mission (spends
  // budget, touches real execution) like launch_mission; stop_lazybot halts
  // running execution like stop_mission.
  'run_lazybot',
  'stop_lazybot',
]);

/** Irreversible actions — require confirmation even in YOLO mode.
 *  `clear_canvas` is deliberately NOT a member: its tier depends on its
 *  `mode` field ('archive' vs 'delete') AND its `includeReview` field and is
 *  resolved by classifyAction's special case below, never by set
 *  membership — see that function's doc comment. */
export const DESTRUCTIVE_ACTIONS = new Set<string>([
  'delete_mission',
  'revert_mission',
  'close_project',
  'deploy',
  'delete_draft',
  'delete_note',
  'delete_router',
  'delete_join',
  'delete_frame',
  // reject_plan (types.ts) never touches real files — it is the same
  // canvas-only preview cleanup as delete_draft (removes drafts/chains/
  // joins tagged with a planId), just addressable retroactively by the
  // manager instead of only via the chat card's "Rejeter" button. Same
  // tier as delete_draft: non-destructive to real work, still requires
  // approval even in YOLO mode because it discards a pending proposal the
  // human may still have wanted to review.
  'reject_plan',
]);

export type ActionTier = 'safe' | 'sensitive' | 'destructive' | 'unknown';

/**
 * Classify an action type into its gating tier.
 *
 * `payload` carries the action's own fields (everything but `type`) for the
 * one classifier that varies by field: `clear_canvas`'s `mode` decides
 * sensitive vs destructive — 'archive' (the default the executor itself
 * falls back to, see agentsStore.tsx's clear_canvas case) is fully
 * reversible via archiveMission/canvas restore, while 'delete' is a genuine
 * permanent removal. `includeReview: true` (P0 fix, types.ts's clear_canvas
 * doc comment) ALWAYS wins to 'destructive' regardless of `mode` — sweeping
 * a 'review' mission (awaiting a human approve/reject decision) into either
 * archive or delete abandons that pending decision unresolved, which is a
 * decision-destroying outcome even when the mission's own history survives.
 * Every other action type classifies from `actionType` alone; `payload` is
 * ignored for them.
 */
export function classifyAction(actionType: string, payload?: Record<string, unknown>): ActionTier {
  if (actionType === 'clear_canvas') {
    if (payload?.includeReview === true) return 'destructive';
    return payload?.mode === 'delete' ? 'destructive' : 'sensitive';
  }
  if (SAFE_ACTIONS.has(actionType)) return 'safe';
  if (DESTRUCTIVE_ACTIONS.has(actionType)) return 'destructive';
  if (SENSITIVE_ACTIONS.has(actionType)) return 'sensitive';
  return 'unknown';
}

export function isSafeAction(actionType: string): boolean {
  return SAFE_ACTIONS.has(actionType);
}

export function isSensitiveAction(actionType: string): boolean {
  return SENSITIVE_ACTIONS.has(actionType);
}

export function isDestructiveAction(actionType: string): boolean {
  return DESTRUCTIVE_ACTIONS.has(actionType);
}
