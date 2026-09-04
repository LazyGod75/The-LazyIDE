/* canvasTypes.ts — shared contract for the Agent Canvas (W0, spec §4/§6/§7).

   Everything downstream (W1a reconciler/store/persistence, W1b node/edge
   components, W1c CanvasView shell, W2+ interactions) imports ONLY from
   this file plus the existing read-model modules (`lib/agents/types.ts`,
   `lib/agents/fleetMissions.ts`, `lib/agents/fleetStage.ts`) — see the
   plan's file-ownership map: this file is frozen after W0, extensions
   require orchestrator sign-off.

   Ownership boundary (spec §3, normative): mission/agent FACTS always come
   from the existing read-models (`FleetMission`, `FleetProject`, `Mission`,
   `LoopConfig`). This module only adds the CANVAS-owned shapes layered on
   top — node data views, node-ref ids, chains, drafts, notes, prefs, and
   the versioned persistence file schemas. Node data interfaces embed the
   read-model fact (e.g. `mission: FleetMission`) rather than duplicating
   its fields, so a fact never has two owners.
*/

import type { FleetMission } from '../../../lib/agents/fleetMissions';
import type { ApprovalMode, LoopConfig, MissionStatus } from '../../../lib/agents/types';
import type { BotConfig } from '../../../lib/bots/botTypes';

// ── Node kinds & refs (spec §6) ─────────────────────────────────────

/** The node kinds the canvas renders (spec §4.2, §6). `iteration` is a W8a
 *  addition (loop expand-in-place, Dify-inspired UX reimplemented): a
 *  READ-ONLY mini card projecting one loop iteration while its parent loop
 *  is expanded — never a chain target (chainValidation.ts's fallthrough
 *  already rejects any non-draft/mission kind), never persisted as its own
 *  fact, never draggable (reconciler emits it `draggable: false`). */
export type CanvasNodeKind =
  | 'project'
  | 'mission'
  | 'loop'
  | 'schedule'
  | 'draft'
  | 'note'
  | 'iteration'
  | 'router'
  | 'join'
  | 'terminal'
  | 'preview'
  | 'bot'
  | 'botVm'
  | 'frame';

const CANVAS_NODE_KINDS: readonly CanvasNodeKind[] = [
  'project',
  'mission',
  'loop',
  'schedule',
  'draft',
  'note',
  'iteration',
  'router',
  'join',
  'terminal',
  'preview',
  'bot',
  'botVm',
  'frame',
];

function isCanvasNodeKind(value: string): value is CanvasNodeKind {
  return (CANVAS_NODE_KINDS as readonly string[]).includes(value);
}

/**
 * Stable, typed React Flow node id shaped `${kind}:${id}` (spec §6 —
 * "Node ids are stable and typed": `project:<projectId>`,
 * `mission:<missionId>`, `loop:<missionId>`, `sched:<scheduleId>`,
 * `draft:<uuid>`, `note:<uuid>`). Always built/parsed via `makeRef`/
 * `parseRef` — never string-concatenated ad hoc — so the `:` separator
 * convention lives in exactly one place.
 */
export type NodeRef = string;

/** Builds a stable {@link NodeRef} for a given node kind + underlying id. */
export function makeRef(kind: CanvasNodeKind, id: string): NodeRef {
  return `${kind}:${id}`;
}

/**
 * Parses a {@link NodeRef} back into its kind/id. Returns `null` on
 * anything malformed (empty id, unknown kind, missing separator) instead
 * of throwing — callers handle untrusted refs (persisted layout/chain
 * files, manager-authored actions, a mission that vanished from the
 * journal) and must degrade gracefully rather than crash the canvas on a
 * stale or corrupt id.
 */
export function parseRef(ref: NodeRef): { kind: CanvasNodeKind; id: string } | null {
  const sep = ref.indexOf(':');
  if (sep <= 0 || sep === ref.length - 1) return null;
  const kind = ref.slice(0, sep);
  const id = ref.slice(sep + 1);
  if (!isCanvasNodeKind(kind)) return null;
  return { kind, id };
}

// ── Per-kind node data (spec §4.1–§4.3) ──────────────────────────────

/** Live running/attention counts shown on a project zone's header badge. */
export interface ProjectNodeCounts {
  running: number;
  urgent: number;
  review: number;
  failed: number;
  /** fix/canvas-legibility — done/merged count, so the unified aggregate
   *  chip (ZoneAggregateSummary) can show a complete picture (running /
   *  failed / review / done) instead of silently dropping the "finished
   *  work" signal a zone otherwise has no aggregate-tier representation
   *  for. */
  done: number;
  total: number;
}

/** Data payload for a `project:<projectId>` group node (spec §4.1). */
export interface ProjectNodeData {
  projectId: string;
  root: string;
  name: string;
  /** Deterministic per-project color — see {@link projectColor}. */
  color: string;
  collapsed: boolean;
  /** Whether this is `AppContext.activeProjectId` — drives the honest
   *  cross-project switch prompt on actions targeting this zone. */
  isActive: boolean;
  counts: ProjectNodeCounts;
  /** True when the zone has at least one rendered child (mission/loop/
   *  schedule/draft/note — the SAME set reconciler.ts's `collectZoneChildren`
   *  produces, post hideMerged/loop-folding). Drives the empty-zone ghost
   *  hint (spec §5 "empty zone -> ghost hint « Déposez un agent ici »",
   *  W5a deliverable #4b) — never a fake placeholder node. */
  hasChildren: boolean;
  /** Mirrors `CanvasPrefs.laneMode` (W6b geometry fix wave, spec §4.3
   *  CRITICAL 4) — ProjectGroupNode needs this to render its lane guides
   *  (column headers + separators) purely from node data, the same way
   *  every other per-zone visual already reads from `ProjectNodeData`
   *  rather than a separate store subscription. Optional (not a `prefs`
   *  duplication concern: reconciler.ts is the ONLY writer, always sets it
   *  from the live `ctx.prefs.laneMode` it already receives) so every
   *  pre-existing literal `ProjectNodeData` fixture across the test suite
   *  stays valid without an update. */
  laneMode?: boolean;
  /**
   * W-MODES-ui — this zone's EFFECTIVE merge-approval mode, mirrored
   * verbatim from `FleetProject.approvalMode` (fleetMissions.ts's
   * `getApprovalMode`, own override or the global default) via
   * reconciler.ts's `zoneInputs` mapping and reconcilerZones.ts's
   * `buildProjectNode` — never re-derived here. Optional/additive: the
   * synthetic Transverse zone has no real project id to look up (reconciler.ts
   * never sets it there), and every pre-existing `ProjectNodeData` fixture in
   * the test suite stays valid unchanged, same convention as `laneMode`
   * above. Drives ProjectGroupNode.tsx's zone-header mode badge.
   */
  approvalMode?: ApprovalMode;
  /**
   * feat/always-visible-agents (additive) — this zone's per-mission roster
   * for the low-zoom/collapsed "dot strip" (ZoneMissionDots.tsx): David's
   * own 17%-zoom screenshot showed a zone reduced to nothing but aggregate
   * counts ("1 en cours / 2 en revue") with ZERO individual missions
   * visible. Below the chip zoom tier (and on a collapsed zone at ANY
   * zoom), individual mission cards/chips are hidden or reduced to counts —
   * this array is the pure per-mission projection rendered instead, one dot
   * per real fleet mission (reconcilerZones.ts's `zoneMissionDots`, same
   * source list `counts` above is derived from). Absent on any
   * pre-existing `ProjectNodeData` fixture, same "presence overrides the
   * default" convention as `laneMode`/`approvalMode` above — renders no dot
   * strip.
   */
  missions?: ZoneMissionDot[];
}

/**
 * One dot in a project zone's mission-roster strip (see
 * {@link ProjectNodeData.missions}'s own doc comment). Deliberately the raw
 * status fields (`status`/`paused`), never a derived `NodeLiveness` —
 * canvasTypes.ts stays leaf-level/React-free (see this module's own
 * header), so the liveness bucket is derived by the rendering component via
 * chrome/nodeChrome.tsx's `deriveMissionLiveness`, same as every other
 * consumer of a raw mission status in this codebase.
 */
export interface ZoneMissionDot {
  missionId: string;
  /** The node this dot focuses on click — `mission:<id>` or `loop:<id>` (a
   *  mission with a `loopConfig` renders as a loop node, not a mission node
   *  — see reconcilerZones.ts's `missionToChildCandidate`). */
  ref: NodeRef;
  title: string;
  status: MissionStatus;
  paused: boolean;
}

/** LazyBot runtime status shown on the canvas node. */
export type BotNodeStatus = 'idle' | 'working' | 'waiting' | 'done' | 'failed';

/**
 * Data payload for a `bot:<botId>` LazyBot node. Embeds the persisted
 * `BotConfig` plus canvas-only live view fields (status halo, active run
 * count, last visible action) — never re-derives or shadows a BotConfig
 * field.
 */
export interface BotNodeData extends Record<string, unknown> {
  bot: BotConfig;
  status: BotNodeStatus;
  /** Number of active mission runs (botEngine runtime state). */
  activeRuns: number;
  /** Mission ids of the bot's active runs — lets the node resolve pending
   *  approvals inline (approvalGate keys by missionId). */
  activeRunIds?: string[];
  /** Most recent visible action/observation, if any. */
  lastAction?: string;
}

/**
 * Data payload for a `botVm:<botId>` canvas window node — the bot's connected
 * live VM/browser view, tethered to its `bot:<botId>` node by a hierarchy edge
 * (the same visual contract as local agents' connected live windows). Only
 * rendered while the bot's VM window is open (▶ VM toggle on the bot node).
 */
export interface BotVmNodeData extends Record<string, unknown> {
  /** The owning bot's id (also the node ref id suffix). */
  botId: string;
  /** Owning bot's display name (header title). */
  botName: string;
  /** Owning bot's runtime status (halo on the header dot). */
  status: BotNodeStatus;
  /** Canvas footprint; the window is user-resizable via NodeResizer. */
  width: number;
  height: number;
}

/**
 * Data payload for a `mission:<missionId>` one-shot mission node (spec
 * §4.2). Embeds the real read-model fact (`mission`) plus canvas-only view
 * fields — never re-derives or shadows a `FleetMission` field.
 */
export interface MissionNodeData {
  mission: FleetMission;
  projectId: string;
  isActiveProject: boolean;
  /** 1-based fleet-wide urgent rank (cockpitHelpers.rankUrgentMissions),
   *  absent when the mission isn't in the urgent set. */
  urgentRank?: number;
  /** True when this mission is in the cockpit's forceApproveIds set (a
   *  rejected verdict the human chose to merge anyway) — flips the node's
   *  quick action from "merge" to "merge anyway". */
  forceApprove?: boolean;
  /**
   * W8a deliverable #2 (additive, orchestrator subtree fold, spec
   * "React Flow Pro expand/collapse pattern, reimplemented"): direct
   * sub-mission count via `parentMissionId` hierarchy links, present only
   * when > 0 (i.e. this mission IS an orchestrator with sub-missions).
   * Drives MissionNode's fold chevron + "N sous-missions" badge. Absent for
   * every non-orchestrator mission — every existing literal
   * `MissionNodeData` fixture stays valid untouched.
   */
  subMissionCount?: number;
  /** Worst (most severe) status among this orchestrator's direct
   *  sub-missions — drives the folded badge's status-color dot. Only
   *  meaningful alongside {@link subMissionCount}. */
  worstSubMissionStatus?: MissionStatus;
}

/** One stacked iteration chip on a {@link LoopNodeData} card (spec §4.2 —
 *  "the loop node stacks the last 3 iterations as mini-chips"). */
export interface LoopIterationChip {
  id: string;
  status: MissionStatus;
  iteration: number;
}

/** Data payload for a `loop:<missionId>` node — a mission whose
 *  `loopConfig` is set (spec §4.2). */
export interface LoopNodeData {
  mission: FleetMission;
  projectId: string;
  isActiveProject: boolean;
  loopConfig: LoopConfig;
  /** Last iterations (most recent first), capped at 3 by the caller — a
   *  "+N" overflow badge covers the rest. */
  recentIterations: LoopIterationChip[];
}

/** Data payload for a `sched:<scheduleId>` node — an agent-template cron
 *  trigger (Rust scheduler), visually distinct from {@link LoopNodeData}
 *  (spec §4.2 — different recurrence engines, never merged). */
export interface ScheduleNodeData {
  scheduleId: string;
  agentName: string;
  cron: string;
  /** Human-readable label, e.g. `scheduleUtils.formatCron(cron)`. */
  cronLabel: string;
  /** Epoch ms of the next scheduled run, when computable. */
  nextRunMs?: number;
  enabled: boolean;
  /** Absent for a cross-project / Transverse-zone schedule. */
  projectId?: string;
}

/**
 * An armed-but-not-launched mission spec (spec §4.2 "Draft" node). Also the
 * persisted unit in {@link ChainsFileV1} — a draft can be a chain's target
 * before it exists as a real mission.
 */
export interface DraftSpec {
  id: string;
  title: string;
  task: string;
  agentName?: string;
  model?: string;
  /** Absent when dropped in the Transverse zone. */
  projectId?: string;
  createdBy: 'user' | 'manager' | 'assistant';
  /**
   * Explicit launch autonomy for this draft (R13 — chain-permission
   * inheritance fix). Absent means "no override" — every real launch path
   * (draftLaunch.ts's `launchDraft`, chainEngine.ts's `attemptFire`/
   * `refireChainDownstream`) falls back to `'acceptEdits'` so the R6b scoped
   * worktree-script gate (src-tauri/src/commands/shell.rs) always qualifies
   * by default. Set explicitly when a draft genuinely needs a different mode
   * (e.g. a read-only 'plan' preview draft) — mirrors MissionContract's own
   * `permissionMode` literal union (lib/agents/types.ts) rather than
   * importing runtime.ts's `PermissionMode` (would create a module cycle:
   * runtime.ts already imports from lib/agents/types.ts, and this file must
   * stay leaf-level per its own header).
   */
  permissionMode?: 'plan' | 'acceptEdits' | 'full';
  /**
   * W-CLOSE row 6 (canvas scorecard "single-node re-run in isolation",
   * Langflow/Dify parity gap) — when true, launching this draft (via
   * draftLaunch.ts's `launchDraft`, the one real launch choke point every UI/
   * manager path already goes through) produces a mission with
   * `Mission.isolated = true`, which chainEngine.ts's `onMissionTerminal`
   * checks to skip firing any outgoing chain for that mission's completion.
   * Set only by the canvas context menu's « Relancer en isolation » entry
   * (CanvasContextMenu.tsx's `duplicateAsDraft`); absent for every normal
   * draft (clone-as-draft, macro instantiation, manual creation).
   */
  isolated?: boolean;
  /**
   * Fork-from-replay provenance (v1 — "rewind-and-fork" market-gap fix, the
   * scorecard's residual #1: LangGraph Studio has checkpoint rewind-and-fork,
   * our Replay was scrub-only until now). Set ONLY by
   * lib/agents/forkFromReplay.ts's `buildForkDraft`, when this draft was
   * materialized from a mission node selected while scrubbing Replay history
   * (ReplayBar.tsx's « Relancer depuis ce point »/`canvas.replay.forkFromHere`
   * entry) — never for a draft created any other way.
   *
   * HONEST SEMANTICS (see forkFromReplay.ts's module header for the full
   * rationale): `atMs` is the replay playhead instant the fork was taken
   * FROM — this is a fork of the mission's task + a journal-derived context
   * brief as of that instant, never a resurrected process/conversation state
   * (impossible for a one-shot native run, and gone the moment a managed run
   * exits either way). Absent for every draft created any other way.
   */
  forkOf?: { missionId: string; atMs: number };
  /**
   * Chantier 3 (plan-first canvas) — present ONLY while this draft is one
   * step of a manager-proposed plan graph the user has not yet validated
   * (canvas/proposalPreview.ts's `buildProposalPreview`). Drives DraftNode's
   * dashed "proposed" visual (distinct from the existing ghost-card look
   * every draft already has — a proposed step is EVEN MORE tentative: it
   * has not been decided at all, let alone armed for launch) and gates its
   * launch/edit affordances. Cleared (never re-stamped) the instant the
   * step is validated — canvasStore's `acceptProposedSteps` flips this SAME
   * DraftSpec (same `id`, same object identity elsewhere) back to a normal
   * ready draft, which is the whole point of this field: the proposed and
   * materialized node are the ONE node, never a delete+recreate pair (see
   * that action's own doc comment for the full identity-continuity story).
   * Absent for every draft created any other way (manual, chain-launched,
   * macro-instantiated, forked) — same "presence overrides the default"
   * convention as every other optional DraftSpec field.
   */
  proposedPlanId?: string;
}

/** A text-only sticky note (spec §5 "Annotations", n8n parity). */
export interface NoteData {
  id: string;
  text: string;
  projectId?: string;
}

/**
 * W8a (additive) — data payload for an `iteration:<missionId>` read-only
 * mini node: one of an EXPANDED loop's last-3 iterations rendered as a real
 * small child node under the loop (loop expand-in-place). Pure projection
 * of the same journal facts LoopIterationChip already carries plus the
 * iteration mission's title — never a second source of truth.
 */
export interface IterationNodeData {
  /** The iteration's own real mission id — clicking opens its MissionDetail
   *  via the same onOpenIteration handler the loop's chips use. */
  missionId: string;
  title: string;
  status: MissionStatus;
  iteration: number;
  /** The owning loop's mission id (for tests/debug — the node's parentId is
   *  the ZONE, not the loop; the visual link is a hierarchy edge). */
  loopMissionId: string;
}

// ── Router node (W8c, Activepieces-inspired N-way branch — reimplemented) ──
//
// A router is a small diamond node with N ORDERED, labeled outgoing
// branches: a chain fires INTO the router (`router:<routerId>`), and each
// branch is its own chain SOURCE (`router:<routerId>:<branchId>` — a single
// `makeRef('router', \`${routerId}:${branchId}\`)` call; `parseRef` never
// splits past its first `:`, so the whole "routerId:branchId" string rides
// as one opaque `id`, and `parseRouterBranchRef` below is the one place that
// re-splits it back apart). chainEngine.ts resolves branches AT FIRE TIME,
// in `branches` array order, first match wins — see chainEngine.ts's
// `resolveRouterBranch`.

/** One ordered branch condition, checked against the UPSTREAM chain's fired
 *  mission (spec: "match on upstream terminal outcome + optional keyword
 *  match on output text"). `contains` matches case-insensitively against the
 *  same real output text `buildContextBlock`/`formatMissionDetail` already
 *  derive (never a second, fabricated summary). `default` always matches —
 *  conventionally the LAST branch, but resolution only relies on array
 *  order, never on a branch's `kind`. */
export type RouterBranchCondition =
  | { kind: 'outcome'; value: 'success' | 'fail' }
  | { kind: 'contains'; value: string }
  | { kind: 'default' };

/** One labeled, ordered output of a {@link RouterSpec}. */
export interface RouterBranch {
  id: string;
  label: string;
  condition: RouterBranchCondition;
}

/**
 * A persisted router node (v1: 2-4 branches — the palette/context-menu
 * creation UI enforces the count; this type itself does not cap it, so a
 * hand-edited chains.json with more branches still loads and renders rather
 * than being rejected outright). Optional `projectId` — absent places it in
 * the Transverse zone, same convention as {@link DraftSpec}/{@link NoteData}.
 */
export interface RouterSpec {
  id: string;
  projectId?: string;
  branches: RouterBranch[];
}

/** Data payload for a `router:<routerId>` diamond node — pure projection of
 *  its persisted {@link RouterSpec}, same "node data embeds the fact
 *  verbatim" rule every other node kind in this file follows. */
export interface RouterNodeData {
  routerId: string;
  projectId?: string;
  branches: RouterBranch[];
}

/**
 * Splits a router branch {@link NodeRef}'s `id` half back into its router id
 * + branch id — the one place that understands the "routerId:branchId"
 * compound encoding `makeRef('router', ...)` callers use for a branch-level
 * source ref. Returns `null` for a router ref with no branch suffix (a chain
 * pointing AT the router itself, e.g. an incoming chain's targetRef, never a
 * branch source) — callers distinguish "router as target" from "router
 * branch as source" by whether this returns non-null.
 */
export function parseRouterBranchRef(ref: NodeRef): { routerId: string; branchId: string } | null {
  const parsed = parseRef(ref);
  if (!parsed || parsed.kind !== 'router') return null;
  const sep = parsed.id.indexOf(':');
  if (sep <= 0 || sep === parsed.id.length - 1) return null;
  return { routerId: parsed.id.slice(0, sep), branchId: parsed.id.slice(sep + 1) };
}

// ── Join node (fan-in / all-of, W-JOIN — the router's mirror image) ────────
//
// A router is one incoming edge fanning OUT to N ordered branches; a join is
// the reverse: N incoming sources fanning IN to one outgoing chain, which
// only fires once EVERY source reaches a terminal state matching `mode`.
// `sourceRefs` is the join's own persisted fan-in list (its counterpart to
// {@link RouterSpec.branches}) — populated by canvasStore's `addChain`
// choke point the same moment a normal `source -> join:<id>` chain is
// created (see that action's doc comment), so wiring a source into a join
// uses the EXACT SAME drag-connect UX every other chain target already has;
// no bespoke "pick a source" UI was built for this wave.
//
// Arrival state (which sources have already reached a matching terminal
// status) is NEVER persisted on the join itself — see joinEngine.ts's module
// header for why: it is recomputed on every check from each source's live
// status (mission.status, or a loop's latest completed iteration), exactly
// mirroring chainEngine.ts's `reconcileChains` philosophy ("no separate
// ledger that can desync"). The join's OWN outgoing chain(s) still get
// exactly-once behavior for free by reusing `Chain.lastFiredAtMs` unchanged
// (joinEngine.ts feeds `attemptFire` the LAST-arriving source's own real
// terminal timestamp as the effective timestamp, which is naturally
// idempotent against that field with zero new bookkeeping).

/** When a join is satisfied (spec): `all_success` requires every source to
 *  reach 'done'; `all_settled` requires every source to reach EITHER 'done'
 *  or 'failed' (any terminal outcome). A 'cancelled' source never satisfies
 *  either mode — same "cancelled never feeds a chain" rule chainEngine.ts's
 *  module header already establishes for a single-source chain; a join
 *  waiting on a cancelled source simply never fires, exactly like a normal
 *  chain sourced from that same mission never would. */
export type JoinMode = 'all_success' | 'all_settled';

/**
 * A persisted join (fan-in) node. `sourceRefs` supports `mission:<id>` and
 * `loop:<id>` refs — the same two kinds chainEngine.ts's `onMissionTerminal`/
 * `reconcileChains` already natively resolve a terminal status for (a
 * router-branch or another join as one of THIS join's own sources is not
 * resolved this wave — joinEngine.ts's `resolveSourceEntry` treats an
 * unsupported ref kind as permanently 'pending' rather than guessing; see
 * that module's header). Optional `projectId` — absent places it in the
 * Transverse zone, same convention as {@link RouterSpec}/{@link DraftSpec}.
 */
export interface JoinSpec {
  id: string;
  projectId?: string;
  name?: string;
  sourceRefs: NodeRef[];
  mode: JoinMode;
  /** Chantier 3 (plan-first canvas) — same convention as
   *  {@link DraftSpec.proposedPlanId}: present only while this fan-in join
   *  was synthesized from a still-pending plan proposal's `joinGroup`. */
  proposedPlanId?: string;
}

/** Minimum sourceRefs a join needs to be meaningful (spec: "fan-in ... ≥2
 *  sources"). A join below this count is a legal, incomplete-but-not-
 *  corrupt persisted state (e.g. right after creation, before the second
 *  source is wired) — `joinValidation`'s `validateJoinSourceCount` is the
 *  one place this is enforced as a hard UI rule; the engine itself also
 *  refuses to fire below this count (joinEngine.ts) as defense-in-depth. */
export const MIN_JOIN_SOURCES = 2;

/** Per-source UI arrival state (never persisted — see this section's own
 *  header). `'satisfied'` means this ONE source already matches the join's
 *  mode; the join as a whole fires only once every source reads
 *  `'satisfied'`. */
export type JoinArrivalStatus = 'satisfied' | 'pending';

/** One source row, pre-resolved for display (title + status) so
 *  JoinNode.tsx never needs its own store/mission lookup — same "node data
 *  embeds the fact verbatim" rule every other node kind in this file
 *  follows. `title` falls back to the bare ref when the underlying
 *  mission/loop can no longer be resolved (e.g. an archived/vanished
 *  mission) rather than omitting the row — a join must always show ALL of
 *  its configured sources, resolvable or not. */
export interface JoinSourceView {
  ref: NodeRef;
  title: string;
  status: JoinArrivalStatus;
}

/** Data payload for a `join:<joinId>` node — pure projection of its
 *  persisted {@link JoinSpec} plus the live-derived {@link JoinSourceView}
 *  list (see this section's header on why arrival is never persisted). */
export interface JoinNodeData {
  joinId: string;
  projectId?: string;
  name?: string;
  mode: JoinMode;
  sources: JoinSourceView[];
  /** Chantier 3 (plan-first canvas) — mirrors {@link JoinSpec.proposedPlanId}
   *  verbatim (reconcilerZones.ts's `collectZoneChildren`, never re-derived). */
  proposedPlanId?: string;
}

// ── Living surfaces (fix/canvas-ux R7, "living surfaces") ────────────────
//
// A terminal or preview node — fully canvas-owned (no read-model fact behind
// it, same convention as {@link DraftSpec}/{@link NoteData}/{@link RouterSpec}:
// the node's `data` IS this spec verbatim, never a second shadow shape).

/** The two kinds of "living surface" node (spec: "watch the agent work" —
 *  October.dev's terminals-and-previews-on-the-canvas idea, reimplemented). */
export type SurfaceKind = 'terminal' | 'preview';

/**
 * A persisted surface node. `ownerRef` is the mission/zone this surface was
 * created FROM (spec §4 "what talks to what") — when present, reconciler.ts
 * draws a thin dotted surface-edge from the owner to this node (reuses
 * HierarchyEdge's own quiet visual, see reconcilerEdges.ts's
 * `buildSurfaceEdges`). Absent when created from the palette/pane menu with
 * no owning mission (a standalone terminal/preview). `width`/`height` are the
 * user's NodeResizer-resized footprint — absent falls back to the kind's
 * default size (reconcilerZones.ts's `DEFAULT_NODE_SIZE`), same "presence
 * overrides the default" convention {@link CanvasPrefs.expandedLoops} etc.
 * already use for optional per-node facts.
 */
export interface SurfaceSpec {
  id: string;
  kind: SurfaceKind;
  /** Absent when dropped in the Transverse zone — same convention as
   *  DraftSpec/NoteData/RouterSpec. */
  projectId?: string;
  /** 'terminal' only — the PTY's working directory (verbatim; TerminalNode.tsx
   *  strips the Windows `\\?\` verbatim prefix at the SAME call site
   *  TerminalView.tsx already does for every other terminal surface). */
  cwd?: string;
  /**
   * 'preview' only — restricted to `http://localhost:*` at creation/edit time
   * (enforced by PreviewNode.tsx's URL bar, not by this type — a hand-edited
   * layout.json is still HONORED here, but the iframe itself refuses to
   * navigate a non-localhost URL at render time, see that component's own
   * header for the security note).
   */
  url?: string;
  ownerRef?: NodeRef;
  /**
   * Mission B (proof window, additive) — the multi-owner generalization of
   * `ownerRef` above: present when MORE THAN ONE mission/loop contributed to
   * this surface (e.g. a browser-recipe proof surface accumulating runs from
   * several missions that drove the same recipe/profile over time) — see
   * reconcilerEdges.ts's `buildSurfaceEdges`, which draws one tether edge per
   * entry here. When both `ownerRefs` and `ownerRef` are absent this is a
   * standalone surface with no owner tether, same as before this field
   * existed. When present, `buildSurfaceEdges` reads ONLY this array (never
   * merges it with `ownerRef`) — callers that upsert into an existing
   * multi-owner surface are responsible for including every ref that should
   * still be tethered (canvasStore.ts's `upsertBrowserProofSurface` does this
   * by unioning with whatever was already there). A single-owner surface
   * (every surface kind that existed before this field) keeps using the
   * plain `ownerRef` — this is additive, not a replacement.
   */
  ownerRefs?: NodeRef[];
  width?: number;
  height?: number;
  /**
   * W-UX3 core deliverable 3a — true when THIS surface was added
   * automatically (useCanvasAutoComposition.ts's dev-server auto-detect),
   * never by an explicit user/manager action. Lets the auto-composition
   * hook tell "the user closed my auto-added preview" (record the
   * dismissal pref so it never re-adds one for this project) apart from
   * "a manually-added preview happened to disappear" (never touches the
   * pref in that case). Absent/false for every existing surface.
   */
  autoAdded?: boolean;
  /**
   * W-UX3 core deliverable 3c — bumped (to `Date.now()`) by
   * `requestSurfaceRefresh` whenever a mission completes in this surface's
   * zone, so PreviewNode.tsx's reachability-probe effect (which already
   * re-arms on its OWN local `refreshNonce` for the manual refresh button)
   * also re-arms from a STORE-driven signal — "the site updates before
   * your eyes" without the user ever touching the refresh button
   * themselves. Absent/unchanged is a pure no-op (no existing surface is
   * affected by this field simply existing).
   */
  refreshRequestedAtMs?: number;
  /**
   * P-SEARCH (founder directive, verbatim: "la recherche web doit ouvrir
   * une fenêtre liée à l'agent qui demande la recherche et on voit la
   * recherche") — present ONLY on a surface that is actually the visible
   * results panel for an agent's `web_search` tool calls, never on a real
   * localhost preview. This is the ONE discriminator nodes/index.ts's
   * `preview` node-type entry (`PreviewSlotNode`, SearchNode.tsx) reads to
   * render SearchNode.tsx instead of PreviewNode.tsx.
   *
   * WHY THIS PIGGY-BACKS ON `kind: 'preview'` INSTEAD OF ITS OWN
   * SurfaceKind/CanvasNodeKind VALUE (a deliberate compromise, not an
   * oversight): reconcilerZones.ts's `DEFAULT_NODE_SIZE`/`ChildKind`/
   * `effectiveChildSize` are exhaustively keyed over `CanvasNodeKind`, and
   * that file is out of scope this wave (frozen alongside ProjectGroupNode/
   * geometry/layout for a concurrent title-band fix) — adding a new node
   * kind there would require editing it. Reusing the existing 'preview'
   * zone-child slot instead buys ALL of its generic machinery for free with
   * ZERO changes to those frozen files: grid placement next to the owning
   * mission, collision avoidance, collapse-hiding, persisted position/size,
   * and the dotted `ownerRef` surface-edge (reconcilerEdges.ts's
   * `buildSurfaceEdges`, already kind-agnostic). Any call site elsewhere
   * that treats `kind === 'preview'` as "a real localhost preview exists"
   * (useCanvasAutoComposition.ts's dev-server auto-detect) must additionally
   * check `!searchSurface` — see that file's own comments at each such site.
   *
   * One surface per MISSION (`id` is always `search:<missionId>`,
   * `ownerRef` always `makeRef('mission', missionId)`) — a second search by
   * the same mission updates this SAME surface (canvasStore.ts's
   * `reportWebSearch`) rather than spawning a new one.
   */
  searchSurface?: SearchSurfaceState;
  /**
   * Visible-artifact fix (real founder feedback, verbatim: "comment tu me
   * montres les designs proposes ?" — a proposed visual artifact, e.g. a
   * template/mockup, used to render as a plain text card; the user would
   * validate a design they had never actually seen). Local, agent-generated
   * content to render in place of a live `url` — same 'preview' zone-child
   * slot, same reasoning as `searchSurface` above (reuse the existing node's
   * generic canvas machinery rather than adding a new CanvasNodeKind).
   *
   * At least one entry when present — never assumed to be exactly one (no
   * fixed view/page/screen count is ever assumed anywhere this type is
   * read). `activeViewId` (optional) selects which one PreviewNode shows;
   * absent or stale (an id no longer present in `htmlViews`) falls back to
   * the first entry. GENERIC BY CONSTRUCTION: nothing here names a content
   * format or use case — `html` is opaque agent-supplied markup, rendered
   * strictly isolated (see PreviewNode.tsx's own header for the sandbox
   * posture), never executed or interpreted by this app itself.
   *
   * Mutually exclusive with `url` in practice (a surface is either a live
   * dev-server preview or a rendered local artifact) but the type does not
   * enforce it — PreviewNode simply prefers `htmlViews` when both are
   * present.
   */
  htmlViews?: SurfaceHtmlView[];
  activeViewId?: string;
}

/** One view (page/screen/variant — no fixed meaning assumed) of a local
 *  artifact rendered by a `preview` surface — see
 *  {@link SurfaceSpec.htmlViews}'s own doc comment. */
export interface SurfaceHtmlView {
  id: string;
  /** Plain-language, agent-supplied label (e.g. "Page 1") — never assumed
   *  to be a number or a fixed sequence name. */
  label: string;
  /** Full standalone HTML document (or fragment), rendered verbatim inside
   *  a fully-locked-down sandboxed iframe — see PreviewNode.tsx's header. */
  html: string;
}

/** One web-search result row, exactly as returned by the Rust `web_search`
 *  command (src-tauri/src/commands/web.rs's `WebSearchResultItem`) — never
 *  re-derived or re-shaped, so what the agent read is exactly what the
 *  human sees on the canvas. */
export interface WebSearchResultView {
  title: string;
  url: string;
  snippet: string;
}

/** One completed `web_search` tool call, as pushed onto a
 *  {@link SearchSurfaceState}'s history stack. `atMs` is the call's
 *  completion time (canvasStore.ts's `reportWebSearch`, same "store writes
 *  its own timestamp" convention as `DraftVersion.ts`). */
export interface SearchHistoryEntry {
  query: string;
  results: WebSearchResultView[];
  atMs: number;
}

/** Max history entries a single search surface keeps (newest first, oldest
 *  dropped) — a generous window without growing layout.json unbounded for
 *  a long-running agent that searches repeatedly. */
export const SEARCH_HISTORY_CAP = 5;

/**
 * Mission B (proof window, additive) — max {@link SurfaceHtmlView} entries a
 * single browser-recipe proof surface keeps (oldest run dropped first, same
 * "cap the array, never let it grow unbounded" convention as
 * `SEARCH_HISTORY_CAP` above). Each run's OWN weight is separately bounded by
 * `browserRecipeProof.ts`'s `BROWSER_PROOF_INLINE_SCREENSHOT_CAP` (inline
 * screenshots per run) — this cap bounds the ORTHOGONAL dimension: how many
 * past runs of the same recipe/profile accumulate as navigable views on one
 * surface before the oldest is dropped entirely.
 */
export const BROWSER_PROOF_RUN_CAP = 5;

/**
 * Live state for a search-results surface (see {@link SurfaceSpec.searchSurface}).
 * `pendingQuery` is present ONLY while a `web_search` call for this mission
 * is still in flight (toolRuntime.ts emits a 'searching' bus event the
 * instant the call starts, before awaiting the Rust command) — cleared the
 * moment it settles, successfully or not, whether or not that produced a
 * new history entry. This is what makes the search genuinely LIVE on the
 * canvas ("on voit la recherche"), not just its finished result.
 */
export interface SearchSurfaceState {
  /** The mission's agent persona name, for the surface's header label. */
  agentName?: string;
  pendingQuery?: string;
  /** Newest-first, capped at {@link SEARCH_HISTORY_CAP}. */
  history: SearchHistoryEntry[];
}

// ── Canvas Groups / frames (n8n parity — W-CLOSE row 2) ────────────────
//
// A frame is a PURELY VISUAL grouping rectangle — distinct from a project
// zone (structural, drives layout/collapse/live rollups, canvasStore's
// ProjectNodeData) and from a macro (a reusable saved TEMPLATE, never a
// live canvas fixture). Honest v1 scope, matching n8n's own "Canvas Groups"
// idea (Ctrl+G, purely visual, distinct from structural sub-workflows): a
// frame never parents/reflows anything — nodes visually "inside" it are NOT
// its children in any data sense (no parentId link, no cascade on
// move/delete), it is rendered BEHIND every other node (reconcilerZones.ts's
// `buildFrameNodes` sets a negative zIndex) purely as a background tint +
// title, and moving/resizing it never moves/resizes whatever visually sits
// on top. This is a documented v1 limitation, not an oversight — see
// docs/superpowers/specs/2026-07-16-canvas-scorecard.md's row 2 entry.

/** A persisted, purely-visual grouping frame. `width`/`height` are the
 *  user's NodeResizer-resized footprint (or the creation-time default) —
 *  same "presence overrides the default" convention as {@link SurfaceSpec}.
 *  Absent `projectId` places it in the Transverse zone, same convention as
 *  every other canvas-owned fact in this file. */
export interface FrameSpec {
  id: string;
  projectId?: string;
  title: string;
  width: number;
  height: number;
}

// ── Contest (best-of-N, W-CONTEST — Cursor "run N agents, auto-pick best"
// parity) ────────────────────────────────────────────────────────────────
//
// A contest launches N ISOLATED clones of one draft template side by side
// (each contestant gets `DraftSpec.isolated: true` -> `Mission.isolated`,
// the SAME flag W-CLOSE row 6 already established for "Relancer en
// isolation" — chainEngine.ts's `onMissionTerminal`/`attemptFire` already
// skip firing any outgoing chain for an isolated mission, so a contestant
// can never trigger downstream automation on its own). Once every
// contestant reaches a terminal status, contestEngine.ts ranks them and
// keeps only the winner in the normal review flow untouched — every loser
// is auto-archived via the existing R13 archive path (agentsStore.tsx's
// archiveMission).
//
// Arrival state (which contestants have already terminated) is NEVER
// persisted here — same "no separate ledger" philosophy as JoinSpec's own
// header above: contestEngine.ts's reconcile recomputes "are all terminal
// yet?" purely from each contestant's live mission status on every check,
// mirroring chainEngine.ts's reconcileChains / joinEngine.ts's arrival
// derivation exactly. `status`/`winnerId` are the one bit of real completion
// bookkeeping this type persists (mirrors Chain.lastFiredAtMs: a small,
// necessary field the engine writes once, never a second source of truth
// for "is this contestant done").

export type ContestStatus = 'running' | 'completed';

/** One contestant's final standing (contestEngine.ts's `rankContestants`
 *  output, also `contest.completed`'s journal payload — eventTypes.ts's
 *  `ContestCompletedPayload` inlines this same shape rather than importing
 *  it, matching that module's own established convention). `score`/`costUsd`
 *  absent when the contestant carries no real number for that field — never
 *  a fabricated 0, same honesty convention as JudgeVerdict.scoreUnavailable. */
export interface ContestRankingEntry {
  missionId: string;
  score?: number;
  costUsd?: number;
}

/**
 * A persisted best-of-N contest. `missionIds` are the N contestant missions,
 * set once at launch (CanvasContextMenu's "Lancer en concours", which clones
 * `draftTemplateId` N times with `isolated: true` before launching each
 * through the normal draft-launch path — draftLaunch.ts's `launchDraft`, so
 * the scheduler's pool caps govern concurrency exactly like any other
 * launch). `winnerId` is absent while `status === 'running'`, and ALSO
 * absent on a `'completed'` contest that ended with no eligible winner
 * (module header's honest no-winner case: nobody produced a real passing
 * judge score AND nobody even reached 'done') — never a fabricated pick.
 */
export interface ContestSpec {
  id: string;
  draftTemplateId: string;
  missionIds: string[];
  status: ContestStatus;
  createdAtMs: number;
  winnerId?: string;
}

// ── Chains (spec §7) ──────────────────────────────────────────────────

/** When a chain fires relative to its source mission's terminal status. */
export type ChainCondition = 'success' | 'fail' | 'always';

/**
 * A directed handoff edge: when `sourceRef` reaches a terminal status
 * matching `condition`, `targetRef` (a draft or queued mission) launches
 * with the source's output injected as context (spec §7).
 */
export interface Chain {
  id: string;
  sourceRef: NodeRef;
  targetRef: NodeRef;
  condition: ChainCondition;
  createdBy: 'user' | 'manager';
  /** True for a chain the user/manager turned off without deleting —
   *  kept for edge history/audit, never fires while disabled. */
  disabled?: boolean;
  /**
   * chainEngine.ts (W3, spec §7) high-water mark: epoch ms of the source
   * completion this chain last consumed — NOT merely a "last fired at"
   * display timestamp. The engine only reacts to a source completion whose
   * effective timestamp is strictly greater than this value, then advances
   * it to that completion's timestamp BEFORE doing any async launch work
   * (same ordering fix as loopScheduler.ts's markIterationFired-before-spawn
   * — see chainEngine.ts's module header for the full exactly-once design).
   * Optional so existing/legacy persisted chains.json files stay valid
   * (ChainsFileV1's schema itself is unchanged — this is the one field this
   * wave was granted to add to Chain). Also drives reconciler.ts's
   * `firing` edge flag (spec §6): true for ~4s after this timestamp.
   */
  lastFiredAtMs?: number;
  /**
   * W8c (additive) — Langflow/n8n "pin output" reimplemented: a FROZEN
   * snapshot of the source's real output (the same text
   * `chainEngine.buildContextBlock` derives), captured once the source
   * reaches a terminal-success state, so this chain's firing injects THIS
   * frozen text instead of re-reading the source's live output. Pinning is
   * per-CHAIN (not per-node) deliberately — the spec's framing is "what
   * downstream receives", which is a property of the EDGE, not the source
   * node (the same source can have one pinned and one live outgoing chain).
   * Absent = normal live behavior (buildContextBlock re-read at every real
   * fire, unchanged from before this field existed).
   */
  pinnedContext?: { text: string; pinnedAtMs: number; sourceTitle: string };
  /** Chantier 3 (plan-first canvas) — same convention as
   *  {@link DraftSpec.proposedPlanId}: present only while this chain is part
   *  of a still-pending plan proposal (a dependsOn edge between two proposed
   *  steps, or a step->join fan-in edge). Cleared on validation, dropped
   *  entirely on rejection — see canvasStore's `acceptProposedSteps`/
   *  `rejectProposedPlan`. */
  proposedPlanId?: string;
}

// ── Macros (group macros, Langflow parity — reimplemented) ────────────
//
// A macro is a saved, reusable COMPOSITE of the PENDING-ONLY subgraph
// (drafts/routers/notes — missions are live fleet state and are never
// captured, per the multi-select rule) plus the chains directly wiring
// them together. Instantiating a macro always mints brand-new ids for
// every captured node (never reuses the template's own original ids,
// which would collide with the SAME macro instantiated a second time) and
// remaps every internal chain's endpoints onto those new ids — see
// canvasMacros.ts's `captureMacro`/`instantiateMacro`, the two pure
// functions that own this transform (used identically by the UI palette
// path and the manager's save_macro/instantiate_macro actions).

/** A saved, named composite of drafts/routers/notes + their internal
 *  chains + relative layout — persisted in {@link ChainsFileV1} (additive)
 *  alongside the live drafts/routers/chains it was captured from. */
export interface MacroSpec {
  id: string;
  name: string;
  description?: string;
  /** Captured specs at their ORIGINAL capture-time ids — instantiateMacro
   *  remaps to fresh ids on every use; the template itself never changes. */
  drafts: DraftSpec[];
  routers: RouterSpec[];
  notes: NoteData[];
  /** Chains whose BOTH endpoints resolve inside the captured set (a router
   *  branch source ref counts via its routerId half — see
   *  parseRouterBranchRef) — a chain reaching outside the selection is
   *  never captured (it would dangle on instantiate, pointing at a node
   *  that doesn't exist in the fresh copy). */
  chains: Chain[];
  /** Keyed by the ORIGINAL capture-time {@link NodeRef}, normalized so the
   *  selection's own bounding-box top-left corner reads as `{x:0,y:0}` —
   *  never an absolute canvas coordinate (instantiating the same macro
   *  twice reproduces the relative LAYOUT, never the original absolute
   *  spot). Absent for a captured node whose position was never set. */
  positions: Record<NodeRef, { x: number; y: number }>;
  createdAtMs: number;
}

// ── Draft version history (Activepieces parity — reimplemented) ───────
//
// Every draft EDIT (quick-create modal save in 'edit' mode, or a future
// manager-authored update — both funnel through canvasStore's single
// `updateDraft` choke point) appends an immutable snapshot — snapshots are
// NEVER rewritten or reordered, only capped by age (oldest dropped first).
// Restoring an old version applies its fields back through that SAME
// `updateDraft` path, which itself appends a fresh snapshot — so
// "restore" reads as "the draft is now this old version again", never a
// destructive rewind that erases what came after it.

/** One immutable point-in-time snapshot of a draft's editable fields. */
export interface DraftVersion {
  ts: number;
  title: string;
  task: string;
  model?: string;
  agentName?: string;
}

/** Cap on how many snapshots one draft keeps (oldest dropped first) — a
 *  generous window for a single draft's edit history without growing
 *  chains.json unbounded for a draft edited hundreds of times. */
export const DRAFT_VERSION_CAP = 20;

// ── Prefs (spec §4.3, §5) ─────────────────────────────────────────────

/** Canvas-wide UI preferences, persisted alongside layout. */
export interface CanvasPrefs {
  /** Lane mode (spec §4.3): nodes magnetize into 5 stage lanes per zone. */
  laneMode: boolean;
  /** Snap-to-grid while dragging. */
  snap: boolean;
  /** Filter out auto-faded merged nodes (spec §4.4). */
  hideMerged: boolean;
  minimap: boolean;
  /**
   * W8a (additive, OPTIONAL so every persisted prefs object and literal
   * fixture written before this field stays valid): smart chain-edge
   * routing — cross-zone chain edges detour around project zone rects
   * instead of cutting through them (see edges/smartEdgePath.ts). Default
   * ON: consumers must treat `undefined` as enabled (`!== false`), which is
   * also how a legacy layout.json that predates the field behaves.
   */
  smartEdges?: boolean;
  /**
   * W8a (additive): orchestrator subtree fold state, keyed by the
   * orchestrator's mission id (true = folded — sub-missions hidden,
   * reconciler.ts filters them and reroutes their chain edges onto the
   * orchestrator). Lives INSIDE prefs deliberately: prefs already flows
   * end-to-end (CanvasView subscription -> useCanvasFlowGraph memo dep ->
   * reconcile input -> CanvasLayoutFileV1.prefs autosave/hydrate, whose
   * validator tolerates unknown extra keys), so the fold state is live and
   * persisted V1-compatibly without widening any other contract. Absent =
   * nothing folded.
   */
  foldedOrchestrators?: Record<string, boolean>;
  /** W8a (additive): loop expand-in-place state, keyed by the loop's
   *  mission id (true = expanded — last-3 iterations render as read-only
   *  mini child nodes). Same prefs-resident rationale as
   *  {@link CanvasPrefs.foldedOrchestrators}. Absent = all collapsed. */
  expandedLoops?: Record<string, boolean>;
  /**
   * R11 (additive, OPTIONAL so every persisted prefs object/fixture written
   * before this field stays valid) — the plain-wheel scroll behavior:
   * `'zoom'` (default) makes a bare mouse-wheel/trackpad scroll ZOOM the
   * canvas (David's own explicit expectation — he tried the wheel and
   * expected zoom, not pan); `'scroll'` restores R1b's earlier trackpad-
   * first scheme (plain scroll PANS, ctrl+wheel/pinch zooms) for anyone who
   * prefers that. CanvasView.tsx reads this to swap its `<ReactFlow>`
   * zoomOnScroll/panOnScroll prop pair; CanvasToolbar's overflow-menu toggle
   * is the one writer. Absent (legacy persisted prefs) reads as `'zoom'`,
   * the new default — never `'scroll'`, since that was never the
   * intentional user choice, just this field not existing yet.
   */
  wheelMode?: 'zoom' | 'scroll';
}

export const DEFAULT_CANVAS_PREFS: CanvasPrefs = {
  laneMode: false,
  snap: true,
  hideMerged: false,
  minimap: true,
  smartEdges: true,
  wheelMode: 'zoom',
};

/**
 * fix/canvas-navigation — sanitizes `wheelMode` at the hydration boundary
 * (canvasStore.ts's `hydrate()`, the ONLY writer besides the toolbar toggle
 * itself). `isCanvasPrefs` (canvasPersistence.ts) never validated this
 * field's VALUE (only that a `prefs` object exists with the older boolean
 * fields) — so a persisted layout.json carrying any `wheelMode` other than
 * exactly `'zoom'`/`'scroll'` (a stale value from a future schema change, a
 * hand-edited file, anything) used to pass straight through, and
 * CanvasView.tsx's old `prefs.wheelMode ?? 'zoom'` only guarded against
 * `null`/`undefined` — any OTHER garbage value made both
 * `zoomOnScroll`/`panOnScroll` evaluate to `false` simultaneously (neither
 * matches `'zoom'` nor `'scroll'`), a dead scroll-wheel. Never trust
 * persisted/external data un-narrowed (see rules/common/coding-style.md's
 * "validate at system boundaries") — this collapses anything that isn't
 * literally `'scroll'` to the safe, current default (`'zoom'`), same
 * discipline as every other `isXxx`/parse guard in canvasPersistence.ts.
 */
export function sanitizeCanvasPrefs(prefs: CanvasPrefs | undefined): CanvasPrefs {
  if (!prefs) return DEFAULT_CANVAS_PREFS;
  return { ...prefs, wheelMode: prefs.wheelMode === 'scroll' ? 'scroll' : 'zoom' };
}

// ── Semantic zoom thresholds (spec §4.5) ───────────────────────────────

/**
 * W-UX3 three-tier fleet view (David's own 10% screenshot: "colored dots
 * visible but ANONYMOUS"): below this zoom, individual dots USED TO hide
 * entirely (chrome/canvas.css's `[data-canvas-tier='aggregate']` rule) and
 * each project zone rendered a constant-screen-size SUMMARY CHIP instead.
 *
 * W-CARDS: no semantic zoom (founder standing decision, restated verbatim
 * after an earlier wave violated it again: "certaines fenêtres ne sont pas
 * visibles comme si ça s'adapte encore au zoom alors que je t'ai dit de ne
 * pas le faire" — zoom must NEVER hide or replace content; only a
 * project's title gets a protected reserved zone, nothing else). Forced to
 * `0` rather than deleting the tier machinery built around it
 * (`useIsAggregateZoom`/chrome/useZoomLevel.ts, ZoneAggregateSummary.tsx,
 * the `[data-canvas-tier='aggregate']` CSS rule below, the aggregate-zoom
 * camera re-center in CanvasLodBroadcaster.tsx) — a live zoom is never
 * negative, so `zoom < ZOOM_AGGREGATE` is now permanently `false`
 * everywhere it's read: the summary chip never mounts (its code stays,
 * unit-tested directly via its own props, just unreachable through a live
 * viewport), the CSS rule never hides a note/router/schedule/iteration/
 * terminal/preview/frame node or an edge, and the camera never
 * auto-recenters.
 * Kept as a live constant (rather than hardcoding `false`/`'normal'` at
 * each of those call sites) so a future reversal is a one-line change, and
 * every one of those files' own doc comments describing the OLD
 * aggregate-tier design stays accurate history instead of needing a
 * rewrite.
 */
export const ZOOM_AGGREGATE = 0;

/**
 * Below this zoom level, mission nodes render as CONSTANT-SIZE billboard
 * chips (status glyph + type glyph + truncated title — never a bare
 * anonymous dot, spec: "Looking at the cockpit at ANY zoom level you must
 * understand what is happening"). Renamed from `ZOOM_DOT` (0.45 -> 0.55,
 * locked threshold decision): widens the readable-chip band so the compact
 * tier kicks in a little later, giving the chip tier more room before
 * cards take over.
 */
export const ZOOM_CHIP = 0.55;

/** Below this zoom level (and at/above {@link ZOOM_CHIP}), nodes render as
 *  compact cards; at/above it, full cards with live action + quick actions
 *  (spec §4.5). */
export const ZOOM_COMPACT = 0.85;

/**
 * Bug fix (start_preview): readable-zoom floor for a `canvas:focus` onto a
 * preview node. PreviewNode.tsx's own LOD collapses to a small
 * non-interactive chip below {@link ZOOM_COMPACT} — a plain bounding-box
 * `fitView` can land under that threshold (the node isn't measured yet at
 * focus time, or simply doesn't need much space to "fit"), so `start_preview`
 * ("montre le site") could show the camera moving without the live iframe
 * ever becoming legible. Comfortably above ZOOM_COMPACT, and under
 * useCanvasManagerEvents.ts's own focus `maxZoom` (1.1) so the two never
 * conflict. Passed as 'canvas:focus'`s optional `minZoom` (see bus.ts).
 */
export const PREVIEW_FOCUS_MIN_ZOOM = 1;

// ── Persistence schemas (versioned, spec §6/§7) ────────────────────────

/**
 * `canvas/layout.json` — geometry + prefs only, never mission facts (D3
 * ownership rule). Keyed by {@link NodeRef} so ids stay stable across a
 * draft→mission remap (the position is preserved, only the map key
 * changes upstream in the reconciler).
 */
export interface CanvasLayoutFileV1 {
  version: 1;
  positions: Record<NodeRef, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
  /** Keyed by project zone id (not a full NodeRef) for readability. */
  collapsed: Record<string, boolean>;
  prefs: CanvasPrefs;
  notes: NoteData[];
  /**
   * Team canvas sharing (additive, optional): epoch ms of the last save.
   * Written when the canvas is mirrored into a team repo; used by the
   * merge (canvasShare.ts + teams_git.rs) to decide which snapshot is
   * newer per field. Absent on local-only files → treated as 0.
   */
  savedAtMs?: number;
  /** R7 (additive, optional — V1-compatible): persisted terminal/preview
   *  surface nodes (canvasStore's `surfaces` slice). Absent on every
   *  layout.json written before this field existed, which hydrates as "no
   *  surfaces" (canvasStore.ts's `hydrate()` defaults it to `[]`) — same
   *  convention as {@link ChainsFileV1.routers}. Lives alongside `notes`
   *  (not in ChainsFileV1) because a surface, like a note, is pure canvas
   *  furniture with no fleet/chain semantics of its own. */
  surfaces?: SurfaceSpec[];
  /**
   * R7 (additive, optional): live-panel expand state for mission nodes,
   * keyed by NodeRef. Presence = expanded, and the stored `{width,height}`
   * is the user's NodeResizer-resized footprint (defaulting to the panel's
   * initial size on first expand). Absent = every mission renders as its
   * normal card. Same "presence overrides the default" convention as
   * `SurfaceSpec.width`/`height` above.
   */
  expandedPanels?: Record<NodeRef, { width: number; height: number }>;
  /** W-CLOSE row 2 (additive, optional — V1-compatible): persisted frame
   *  nodes (canvasStore's `frames` slice). Absent on every layout.json
   *  written before this field existed, which hydrates as "no frames"
   *  (canvasStore.ts's `hydrate()` defaults it to `[]`) — same convention as
   *  {@link CanvasLayoutFileV1.surfaces}. Lives alongside `notes`/`surfaces`
   *  (not ChainsFileV1) — a frame, like a note or surface, is pure canvas
   *  furniture with no fleet/chain semantics of its own. */
  frames?: FrameSpec[];
  /**
   * W-DISMISS (additive, optional — V1-compatible): mission ids the user
   * explicitly removed from the live canvas via the context menu's
   * "Retirer du canvas" / "Masquer" entry (CanvasContextMenu.tsx), recorded
   * as {@link NodeRef}s minted with `makeRef('mission', missionId)` — always
   * the `mission:` kind regardless of whether the mission currently renders
   * as a plain mission or a loop node (a mission's loop-ness doesn't change
   * its identity), so a dismissal survives that render-kind distinction.
   * Absent on every layout.json written before this field existed, which
   * hydrates as "nothing dismissed" (canvasStore.ts's `hydrate()` defaults
   * it to `[]`), same convention as `frames` above. Dismissal is permanent
   * for that mission id — deliberately no "un-dismiss" action exists yet
   * (see canvasStore.ts's `dismissMission` doc comment); never touches the
   * underlying Mission record, only hides it from THIS live canvas exactly
   * like `Mission.archived` does (reconciler.ts filters both alongside each
   * other), so the agent itself is unaffected — a running/queued mission
   * keeps running after being dismissed.
   */
  dismissedRefs?: NodeRef[];
}

/** `canvas/chains.json` — global file keyed by no single project (chains
 *  may cross projects, spec §7). */
export interface ChainsFileV1 {
  version: 1;
  chains: Chain[];
  drafts: DraftSpec[];
  /**
   * Team canvas sharing (additive, optional): epoch ms of the last save
   * (see CanvasLayoutFileV1.savedAtMs).
   */
  savedAtMs?: number;
  /** W8c (additive, optional — V1-compatible): persisted router nodes. Absent
   *  on every chains.json written before this field existed, which hydrates
   *  as "no routers" (canvasStore.ts's hydrate() defaults it to `[]`). */
  routers?: RouterSpec[];
  /** W-JOIN (additive, optional — V1-compatible): persisted join (fan-in)
   *  nodes. Absent on every chains.json written before this field existed,
   *  which hydrates as "no joins" (canvasStore.ts's hydrate() defaults it to
   *  `[]`), same convention as `routers` above. */
  joins?: JoinSpec[];
  /** Group macros (additive, optional — V1-compatible): saved composite
   *  templates (see {@link MacroSpec}'s own doc comment). Absent on every
   *  chains.json written before this field existed, which hydrates as "no
   *  macros" (canvasStore.ts's hydrate() defaults it to `[]`). */
  macros?: MacroSpec[];
  /** Draft version history (additive, optional — V1-compatible), keyed by
   *  draftId (see {@link DraftVersion}'s own doc comment). Absent on every
   *  chains.json written before this field existed, which hydrates as "no
   *  history yet for any draft" (canvasStore.ts's hydrate() defaults it to
   *  `{}`). */
  draftVersions?: Record<string, DraftVersion[]>;
  /** W-CONTEST (additive, optional — V1-compatible): persisted best-of-N
   *  contests (see {@link ContestSpec}'s own doc comment). Absent on every
   *  chains.json written before this field existed, which hydrates as "no
   *  contests" (canvasStore.ts's hydrate() defaults it to `[]`), same
   *  convention as `joins` above. */
  contests?: ContestSpec[];
}

// ── Project color (spec §4.1) ──────────────────────────────────────────

const PROJECT_COLOR_SATURATION = 65;
const PROJECT_COLOR_LIGHTNESS = 62;

/**
 * Deterministic djb2-ish string hash → unsigned 32-bit int. Not
 * cryptographic — only needs to be stable and well-distributed across
 * project ids for {@link projectColor}.
 */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * Deterministic project → color mapping (spec §4.1 "deterministic project
 * color (hash of projectId → hue)"). Fixed saturation/lightness tuned to
 * read clearly against the app's dark theme (`--color-bg: #0E0E14`,
 * `--color-panel: #14141C` — see `src/styles/design-system.css`); only the
 * hue varies per project. Same projectId always yields the same color
 * within a session and across restarts (no Math.random, no Date.now).
 */
export function projectColor(projectId: string): string {
  const hue = hashString(projectId) % 360;
  return `hsl(${hue}, ${PROJECT_COLOR_SATURATION}%, ${PROJECT_COLOR_LIGHTNESS}%)`;
}
