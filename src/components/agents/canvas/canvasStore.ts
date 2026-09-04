/* canvasStore.ts — zustand v5 + zundo temporal store (W1a, plan §W1a).

   Owns ONLY canvas geometry + the UI-authored facts layered on top of the
   real read-models (spec §3 data ownership rule, canvasTypes.ts's header):
   node positions, viewport, collapsed project zones, prefs, drafts, chains,
   notes. NEVER a second source of truth for mission state — the reconciler
   (reconciler.ts) is the only place FleetMission/FleetProject facts meet
   this store's geometry.

   This is the FIRST zustand store in the repo (spec §12: "zustand ...
   canvas-scoped only — repo stays hand-rolled Context elsewhere") — no
   existing local convention to mirror beyond zundo's own docs
   (node_modules/zundo/README.md).

   Undo/redo (Ctrl+Z / Ctrl+Shift+Z, spec §5) covers ONLY user edits:
   positions, drafts, chains, notes, collapsed. `viewport` (pan/zoom) and
   `hydrate()` (loading persisted state at startup/project switch) are
   EXCLUDED from history:
     - viewport is excluded via zundo's `partialize` (it is simply not part
       of the tracked slice) combined with an `equality` check — panning/
       zooming alone never changes the tracked slice, so no history entry
       is pushed for it (see the "Prevent unchanged states from getting
       stored in history" recipe in zundo's README).
     - hydrate() additionally wraps its `set()` call in
       `temporal.pause()`/`resume()` — even though it DOES change the
       tracked slice (loading fresh positions/drafts/chains/notes), it must
       never itself become an undoable step (undoing right after a hydrate
       would revert to the pre-hydrate default state, which is never what
       the user means by "undo").

   Exports both the vanilla store (`canvasStoreVanilla` — for non-React
   callers: canvasPersistence.ts's autosave subscriber, W4's manager
   executor, tests) and React hooks (`useCanvasStore`, `useCanvasTemporal`)
   per the plan's W1a deliverable.
*/

import { createStore, useStore } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { temporal, type TemporalState } from 'zundo';
import {
  makeRef,
  parseRef,
  DEFAULT_CANVAS_PREFS,
  DRAFT_VERSION_CAP,
  sanitizeCanvasPrefs,
  type CanvasLayoutFileV1,
  type CanvasPrefs,
  type Chain,
  type ChainCondition,
  type ChainsFileV1,
  type ContestSpec,
  type DraftSpec,
  type DraftVersion,
  type FrameSpec,
  type JoinSpec,
  type MacroSpec,
  type NodeRef,
  type NoteData,
  type RouterBranch,
  type RouterSpec,
  type SearchSurfaceState,
  type SurfaceHtmlView,
  type SurfaceSpec,
  type WebSearchResultView,
  MIN_JOIN_SOURCES,
  SEARCH_HISTORY_CAP,
  BROWSER_PROOF_RUN_CAP,
} from './canvasTypes';
import { clearTerminalActivity } from '../../../lib/agents/terminalActivity';
import { ensureUniqueCanvasRefs, sanitizeCanvasPositions } from './canvasRefIntegrity';
import { emitLocalCanvasNote } from '../../../lib/collab/canvasOpBridge';

// ── State shape ────────────────────────────────────────────────────

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/**
 * REAL-APP FIX (2026-08-04, UC3 dogfood — "drafts en double"): plan ids that
 * have been VALIDATED (execute_plan / executePlan) in this session. A
 * proposal preview that lands on the canvas AFTER its plan was already
 * validated must not materialize — the race observed live: the manager's
 * generate_plan turn returned, the user clicked "Valider & lancer"
 * immediately, execute_plan materialized the real steps via irToCanvas, and
 * THEN the async addProposalPreview call landed, stamping a SECOND set of
 * draft nodes with `proposedPlanId` on top of the already-running missions
 * (the canvas read as "un autre jeu de noeuds apparait a cote"). Marking a
 * plan id validated at accept time makes any late preview a no-op.
 * Module-level (survives remounts, same precedent as useCanvasFlowGraph's
 * `seenCanvasNodeIds`); reset by _resetCanvasStoreForTests.
 */
let validatedPlanIds = new Set<string>();

/** Records `planId` as validated — see `validatedPlanIds`'s doc comment.
 *  Called by executePlan on EVERY validation path (acceptProposedSteps AND
 *  the irToCanvas fallback), so a late preview for this plan no-ops. */
export function markPlanValidated(planId: string): void {
  validatedPlanIds.add(planId);
}

/** True once `planId` has been validated this session. */
export function isPlanValidated(planId: string): boolean {
  return validatedPlanIds.has(planId);
}

export interface CanvasFacts {
  positions: Record<NodeRef, { x: number; y: number }>;
  viewport: CanvasViewport;
  /** Keyed by project zone id (not a full NodeRef) — mirrors
   *  CanvasLayoutFileV1.collapsed. */
  collapsed: Record<string, boolean>;
  /** Includes W8a's fold/expand records (`prefs.foldedOrchestrators` /
   *  `prefs.expandedLoops`) — prefs-RESIDENT deliberately (see the
   *  CanvasPrefs doc comments): prefs already flows CanvasView ->
   *  useCanvasFlowGraph memo dep -> reconcile input, and already
   *  round-trips wholesale through CanvasLayoutFileV1.prefs, so the fold
   *  state is live AND persisted V1-compatibly with zero contract
   *  widening elsewhere. */
  prefs: CanvasPrefs;
  drafts: DraftSpec[];
  chains: Chain[];
  notes: NoteData[];
  /** W8c (additive) — persisted router nodes (ChainsFileV1.routers).
   *  `subscribeCanvasAutosave` (canvasPersistence.ts) includes this field in
   *  the object it debounce-saves (W9 fix — previously flagged as a gap: a
   *  router add/edit that never went through chainEngine.ts's own
   *  `saveCanvasChainsGlobal` call, which DOES include it, was not
   *  guaranteed to survive an app restart), so a router created via the
   *  palette/context-menu now round-trips exactly like chains/drafts. */
  routers: RouterSpec[];
  /** W-JOIN (additive) — persisted join (fan-in) nodes (ChainsFileV1.joins).
   *  `subscribeCanvasAutosave` (canvasPersistence.ts) and chainEngine.ts's
   *  `consume()` both include this field in the object they save, same
   *  "must ride along in every save path" rule `routers` already needed
   *  (see that field's own comment). */
  joins: JoinSpec[];
  /** R7 (additive) — persisted terminal/preview surface nodes
   *  (CanvasLayoutFileV1.surfaces). Lives alongside `notes` (layout.json),
   *  not `routers`/`chains` (chains.json) — a surface has no chain/fleet
   *  semantics, it's canvas furniture exactly like a note. */
  surfaces: SurfaceSpec[];
  /** R7 (additive) — live-panel expand state for mission nodes, keyed by
   *  NodeRef (see CanvasLayoutFileV1.expandedPanels's doc comment). */
  expandedPanels: Record<NodeRef, { width: number; height: number }>;
  /** W-CLOSE row 2 (additive) — purely-visual grouping frames (n8n "Canvas
   *  Groups" parity, canvasTypes.ts's FrameSpec doc comment). */
  frames: FrameSpec[];
  /** Group macros (additive) — saved composite templates (ChainsFileV1.macros's
   *  own doc comment / canvasTypes.ts's MacroSpec). */
  macros: MacroSpec[];
  /** Draft version history (additive), keyed by draftId — appended to by
   *  `updateDraft` (the single choke point every edit path already goes
   *  through), never written any other way (ChainsFileV1.draftVersions's
   *  own doc comment / canvasTypes.ts's DraftVersion). */
  draftVersions: Record<string, DraftVersion[]>;
  /** W-CONTEST (additive) — persisted best-of-N contests
   *  (ChainsFileV1.contests's own doc comment / canvasTypes.ts's
   *  ContestSpec). `subscribeCanvasAutosave` (canvasPersistence.ts) and
   *  contestEngine.ts's own immediate-save both include this field, same
   *  "must ride along in every save path" rule `joins` already needed (see
   *  that field's own comment above). */
  contests: ContestSpec[];
  /**
   * R10 (persisted-position declutter, additive) — refs the user actively
   * dragged THIS session (this app run) — deliberately NOT part of the
   * undo/redo tracked slice (ephemeral UI-session state, not canvas
   * content — see `partializeCanvasState`) and NOT persisted to any file.
   * Consulted by the reconciler (reconciler.ts's `sessionDraggedRefs` input)
   * so a drag this session is never auto-nudged by the pinned x pinned
   * declutter pass (reconcilerZones.ts's `declutterPinnedChildren`), even
   * when another pinned sibling reads as more "recent". Reset on `hydrate()`
   * — a fresh load of persisted state starts a fresh session, same as every
   * other per-session-only piece of UI state.
   */
  sessionDraggedRefs: ReadonlySet<NodeRef>;
  /**
   * W-DISMISS (additive) — mission ids explicitly removed from the live
   * canvas (CanvasLayoutFileV1.dismissedRefs's own doc comment covers the
   * `mission:`-kind-always convention). A plain array (not a `Set`, unlike
   * `sessionDraggedRefs`) because THIS field — unlike that session-only
   * one — round-trips through `stableStringify`/JSON persistence, where a
   * `Set` has no own enumerable keys and would silently compare/serialize
   * as empty (see this file's own `trackedStateEqual` doc comment).
   */
  dismissedRefs: NodeRef[];
  /**
   * Auto-summary (additive) — one-time missions that reached 'done' and
   * have been automatically transformed into a compact summary card on
   * the canvas. The mission node stays visible but renders as a small
   * "tâche terminée" summary instead of the full card. Not persisted —
   * purely session-level UI state (a mission that was already dismissed
   * last session stays dismissed via `dismissedRefs`).
   */
  summarizingRefs: NodeRef[];
  /**
   * Auto-dismiss animation (additive) — one-time missions whose summary
   * display period has elapsed and are now playing the exit animation
   * before being moved to `dismissedRefs`. The reconciler still shows
   * these nodes (so the CSS animation can play), but `useCanvasFlowGraph`
   * applies the `canvas-fade-exit` class to trigger the fade-out. After
   * the animation duration, the caller moves the ref to `dismissedRefs`.
   * Not persisted — ephemeral session state.
   */
  exitingRefs: NodeRef[];
}

export interface CanvasActions {
  setPosition: (ref: NodeRef, pos: { x: number; y: number }) => void;
  /**
   * Batch position update (multi-select drag, auto-layout apply) — merges
   * `patch` into `positions` in one atomic set() / one history entry.
   *
   * fix(canvas): value-equality no-op (see {@link isPositionsPatchNoop}) —
   * when every entry in `patch` already exactly matches what's stored, this
   * returns the SAME state object instead of spread-merging a new one.
   * This is the convergence point for a whole class of render loop: ANY
   * effect that derives a "corrective" position patch from `positions`
   * itself (reconciler.ts's `declutteredPositions`, persisted back by
   * useCanvasFlowGraph.ts's R10 effect, is the real case that exposed this)
   * would otherwise loop forever even when the correction never actually
   * changes — a value-identical spread merge still allocates a NEW
   * `positions` object, whose changed IDENTITY alone re-triggers the memo
   * that derived the patch, which calls `setPositions` again, forever. No
   * call site needs to change: a genuinely different patch still applies
   * exactly as before.
   */
  setPositions: (patch: Record<NodeRef, { x: number; y: number }>) => void;
  setViewport: (viewport: CanvasViewport) => void;
  toggleCollapsed: (projectId: string) => void;
  /** W8a deliverable #2 — toggles one orchestrator mission's fold state
   *  (`prefs.foldedOrchestrators[missionId]`). */
  toggleFoldOrchestrator: (missionId: string) => void;
  /** W8a deliverable #2 — toggles one loop mission's expand-in-place state
   *  (`prefs.expandedLoops[missionId]`). */
  toggleExpandLoop: (missionId: string) => void;
  /**
   * W-DISMISS — records `makeRef('mission', missionId)` into
   * `dismissedRefs` (deduped, no-op if already present) so
   * reconciler.ts's mission filter (alongside `!m.archived`) hides it from
   * every future reconcile. Called by CanvasContextMenu.tsx's per-mission
   * "Retirer du canvas" (terminal missions) / "Masquer (l'agent continue)"
   * (running/queued) entries. Deliberately PERMANENT for that mission id —
   * no `undismissMission` counterpart exists (kept simple/predictable per
   * the task's own instruction): a dismissed mission never auto-resurfaces,
   * even if it later changes status. Never touches the underlying Mission
   * record (agentsStore.tsx) — a running/queued mission keeps running,
   * this only hides its canvas node, same "additive and reversible in the
   * data, only cosmetic on the live board" honesty rule as
   * `Mission.archived` (reconciler.ts's own doc comment on that filter).
   */
  dismissMission: (missionId: string) => void;
  /**
   * Auto-summary — marks a mission as being in summary mode. The node
   * stays on the canvas but renders as a compact summary card. Idempotent.
   */
  summarizeMission: (missionId: string) => void;
  /**
   * Auto-dismiss animation — marks a mission as exiting (playing the
   * fade-out animation). The node stays visible until the caller moves
   * it to `dismissedRefs` after the animation completes. Idempotent.
   */
  beginExitAnimation: (missionId: string) => void;
  setPrefs: (patch: Partial<CanvasPrefs>) => void;
  addDraft: (draft: DraftSpec) => void;
  /**
   * Merges `patch` onto the draft, THEN appends an immutable snapshot of
   * the resulting fields onto `draftVersions[id]` (capped at
   * {@link DRAFT_VERSION_CAP}, oldest dropped first) — the SINGLE choke
   * point every draft edit goes through (quick-create modal save, and any
   * future manager-authored update), so version history is automatic
   * regardless of which caller edits the draft. No-op for an unknown id
   * (neither the draft nor its version history changes).
   */
  updateDraft: (id: string, patch: Partial<Omit<DraftSpec, 'id'>>) => void;
  /** Removes a draft AND its version history (no orphaned history for a
   *  draft that no longer exists). */
  removeDraft: (id: string) => void;
  /**
   * Re-applies an OLD snapshot's fields as a NEW edit (via `updateDraft`,
   * see its own doc comment) — the restored state becomes a fresh, newest
   * entry in the SAME history, never a rewrite/truncation of what came
   * after it. No-op for an unknown draftId or an unknown `ts`.
   */
  restoreDraftVersion: (draftId: string, ts: number) => void;
  /**
   * Appends `chain` — AND, when `chain.targetRef` resolves to a
   * `join:<id>` (W-JOIN), also appends `chain.sourceRef` onto that join's
   * `JoinSpec.sourceRefs` (deduped, no-op if already present). This is the
   * ONE choke point that keeps a join's fan-in list in sync with however
   * many "wire this source into the join" chains the user has drag-
   * connected — the SAME generic connect-a-chain UX every other target
   * (draft/router/queued mission) already uses, with zero bespoke "pick a
   * join source" UI needed. A join whose target join id no longer exists
   * degrades to "just add the chain" (never throws, never half-applies).
   */
  addChain: (chain: Chain) => void;
  removeChain: (id: string) => void;
  setChainCondition: (id: string, condition: ChainCondition) => void;
  setChainDisabled: (id: string, disabled: boolean) => void;
  /**
   * chainEngine.ts (W3) calls this immediately after firing a chain, to
   * advance its `lastFiredAtMs` high-water mark (see canvasTypes.ts's
   * `Chain.lastFiredAtMs` doc comment for the exactly-once design this
   * feeds). A no-op for an unknown chainId.
   *
   * Deliberately EXCLUDED from undo/redo history — same technique
   * `hydrate()` uses (see this file's module header): `chains` IS part of
   * the zundo-tracked slice, so a plain `set()` here would otherwise push a
   * history entry, and the user pressing Ctrl+Z right after an autonomous
   * chain firing must never "undo" the engine's own bookkeeping (that is
   * not a user edit, exactly like loading persisted state on hydrate is
   * not). Wrapped in temporal.pause()/resume() rather than routed through
   * `partialize` (which is how `viewport`/`prefs` are excluded) because
   * `lastFiredAtMs` lives INSIDE the tracked `chains` array, not in a
   * separate untracked top-level field.
   */
  markChainFired: (chainId: string, atMs: number) => void;
  /**
   * W8c (pin output, deliverable #1) — captures a frozen snapshot of the
   * chain's source output onto `Chain.pinnedContext`. A normal TRACKED user
   * edit (undo/redo applies, same as setChainCondition/setChainDisabled) —
   * unlike `markChainFired`, pinning is a deliberate user/manager action, not
   * engine bookkeeping. No-op for an unknown chainId.
   */
  pinChainOutput: (chainId: string, pinned: { text: string; pinnedAtMs: number; sourceTitle: string }) => void;
  /** W8c — clears `Chain.pinnedContext`, reverting the chain to live
   *  (re-read-at-fire-time) context injection. No-op for an unknown chainId
   *  or an already-unpinned chain. */
  unpinChainOutput: (chainId: string) => void;
  addNote: (note: NoteData) => void;
  updateNote: (id: string, patch: Partial<Omit<NoteData, 'id'>>) => void;
  removeNote: (id: string) => void;
  /**
   * Atomically remaps a launched draft to its real mission id (spec §6:
   * "Draft launched: draft:<uuid> remaps to mission:<id> atomically,
   * position preserved, outgoing/incoming chains rewritten"). A single
   * set() call — one history entry, positions/chains/drafts stay in sync,
   * never a window where a chain points at a ref that resolves to nothing.
   * No-op (but still a no-op set(), see body) when draftId is unknown.
   */
  remapDraftToMission: (draftId: string, missionId: string) => void;
  /**
   * Chantier 3 (plan-first canvas) — atomically appends a manager-proposed
   * plan's drafts/chains/joins (already stamped `proposedPlanId` by
   * `irToProposedCanvas`, graph/irToCanvas.ts) onto the live canvas — the
   * SAME additive discipline as {@link CanvasActions.instantiateMacroResult}
   * (one set() call). Calling this AGAIN for the same `planId` (a plan
   * EXTENSION — the manager adding more steps to an already-accepted graph)
   * simply appends more proposed nodes alongside whatever is already there;
   * this action never de-dupes or replaces by id, so a caller must mint
   * fresh ids for a genuinely new step (the same rule every other additive
   * canvas primitive already follows).
   */
  addProposalPreview: (preview: { drafts: DraftSpec[]; chains: Chain[]; joins: JoinSpec[] }) => void;
  /**
   * Chantier 3 — validates a pending plan proposal's steps. This is the
   * identity-continuity choke point (the task's own "most important point":
   * "c'est là que la confiance se casse aujourd'hui"): it never re-adds or
   * re-creates a node — it finds every draft/chain/join already on the
   * canvas tagged `proposedPlanId === planId` (added earlier by {@link
   * CanvasActions.addProposalPreview}) and, for each ACCEPTED step (`id` in
   * `acceptedStepIds`, or every step when `acceptedStepIds` is `null` — a
   * full accept), clears its `proposedPlanId` in place (same object identity
   * elsewhere, same NodeRef, same position — only the dashed "proposed"
   * style turns off). Any step NOT accepted (unchecked in the partial-
   * validation UI, or simply not part of this plan) is REMOVED entirely —
   * "seules les étapes validées sont matérialisées" — along with any
   * `proposedPlanId`-tagged chain/join that would otherwise dangle onto a
   * removed draft (a join losing sources below {@link MIN_JOIN_SOURCES} is
   * dropped too, same honesty rule joinValidation.ts's own floor enforces
   * elsewhere). A validated chain/join whose OTHER endpoint is a normal
   * (non-proposed, already-materialized) node — the plan-extension case —
   * is left exactly as-is, since it was never tagged with this planId to
   * begin with.
   */
  acceptProposedSteps: (planId: string, acceptedStepIds: readonly string[] | null) => void;
  /**
   * Chantier 3 — discards an entire pending (or superseded, see "Modifier")
   * plan proposal: every draft/chain/join tagged `proposedPlanId === planId`
   * is removed outright, never left as an orphaned ghost. No-op for a
   * planId with nothing currently tagged (already resolved, or never
   * previewed).
   */
  rejectProposedPlan: (planId: string) => void;
  /**
   * 2026-08-04 (UC3 "drafts en double" dogfood fix) — validation-time sweep:
   * drops EVERY draft/chain/join still tagged `proposedPlanId !== planId`
   * (a different plan's leftover preview), keeping only non-proposed items
   * and the validated plan's own. Backstop for the case where a superseded
   * proposal's preview never got cleaned by the per-conversation supersession
   * (generate_plan re-emissions in the same turn, planId not yet attached to
   * the earlier message when the new plan arrived). Validating one plan IS
   * the user's answer to every other pending proposal; leftovers would only
   * re-create the stacked-duplicate canvas.
   */
  clearProposedExcept: (planId: string) => void;
  /**
   * Migration-only primitive (canvasProposalCleanup.ts's hydrate-time
   * re-home step, 2026-08-02 escalation) — re-stamps `projectId` on every
   * draft/join tagged `proposedPlanId === planId` (chains carry no
   * `projectId` of their own — see canvasTypes.ts's Chain — nothing to
   * touch there) so a preview that was materialized into the WRONG
   * project's zone (generate_plan's own "active project" default bug, now
   * fixed forward — see agentsStore.tsx's `generate_plan` case) visually
   * moves into its REAL target zone instead of being deleted outright.
   * Positions are left untouched — the caller emits `canvas:arrange`
   * afterwards to re-lay the moved nodes out, same as addProposalPreview's
   * own callers already do. No-op for a planId with nothing currently
   * tagged.
   */
  retagProposedPlanProject: (planId: string, projectId: string) => void;
  /**
   * Replaces the tracked facts wholesale from persisted files (or defaults
   * when a file is absent/corrupt — canvasPersistence.ts already resolved
   * that). Never itself an undo step — see module header.
   */
  hydrate: (layout: CanvasLayoutFileV1 | null, chainsFile: ChainsFileV1 | null) => void;
  // ── Group macros (additive) ────────────────────────────────────────
  addMacro: (macro: MacroSpec) => void;
  removeMacro: (id: string) => void;
  /** Renames/re-describes a saved macro in place — never touches its
   *  captured content (drafts/routers/notes/chains/positions). No-op for
   *  an unknown id. */
  renameMacro: (id: string, patch: { name?: string; description?: string }) => void;
  /**
   * Atomically merges a macro instantiation's freshly-minted drafts/
   * routers/notes/chains/positions into the live canvas — ONE set() call,
   * ONE history entry, same "never a window where a chain points at
   * nothing" discipline as {@link CanvasActions.remapDraftToMission}. The
   * result is expected to already carry brand-new ids (canvasMacros.ts's
   * `instantiateMacro` mints them) — this action never re-derives or
   * validates that itself, it only appends.
   */
  instantiateMacroResult: (result: {
    drafts: DraftSpec[];
    routers: RouterSpec[];
    notes: NoteData[];
    chains: Chain[];
    positions: Record<NodeRef, { x: number; y: number }>;
  }) => void;
  /**
   * W-CLOSE row 4 (canvas export/import, "flow-as-code" v1) — same atomic
   * "one set() call, one history entry, never a window where a chain points
   * at nothing" discipline as {@link CanvasActions.instantiateMacroResult},
   * plus macros (canvasExportImport.ts's `remapImportedCanvas` output/
   * envelope both carry a `macros` array `instantiateMacroResult` never
   * needed to). Macro ids are imported VERBATIM (see that module's own doc
   * comment on why) — a re-import of the exact same file therefore appends
   * a duplicate-id macro entry rather than de-duping; documented, not a
   * silent bug.
   */
  mergeImportedCanvas: (result: {
    drafts: DraftSpec[];
    routers: RouterSpec[];
    joins: JoinSpec[];
    notes: NoteData[];
    chains: Chain[];
    macros: MacroSpec[];
    frames: FrameSpec[];
    contests: ContestSpec[];
    positions: Record<NodeRef, { x: number; y: number }>;
  }) => void;
  // ── Router node (W8c deliverable #3) ──────────────────────────────
  addRouter: (router: RouterSpec) => void;
  removeRouter: (id: string) => void;
  /** Replaces a router's whole branches array immutably (add/remove/relabel/
   *  reorder a branch all go through this single setter — same "replace the
   *  array, never mutate an element" convention as every other array field
   *  in this store). No-op for an unknown router id. */
  setRouterBranches: (id: string, branches: RouterBranch[]) => void;
  // ── Join node (W-JOIN, additive) — fan-in / all-of. `updateJoin` covers
  //    name/mode/sourceRefs together (JoinSpec has no nested array needing
  //    its own atomic setter the way RouterBranch's reorder/relabel does —
  //    it is a flat patch, same convention as `updateNote`/`updateFrame`
  //    below). ──────────────────────────────────────────────────────────
  addJoin: (join: JoinSpec) => void;
  removeJoin: (id: string) => void;
  /** Replaces `patch`'s fields on the join immutably. No-op for an unknown
   *  join id. */
  updateJoin: (id: string, patch: Partial<Omit<JoinSpec, 'id'>>) => void;
  // ── Living surfaces (R7, additive) — same add/update/remove shape as
  //    drafts/notes above. ──────────────────────────────────────────────
  addSurface: (surface: SurfaceSpec) => void;
  updateSurface: (id: string, patch: Partial<Omit<SurfaceSpec, 'id'>>) => void;
  removeSurface: (id: string) => void;
  /**
   * P-SEARCH — upserts the ONE search-results surface for `missionId`
   * (deterministic id `search:<missionId>`, see SurfaceSpec.searchSurface's
   * own doc comment), driven by toolRuntime.ts's 'canvas:webSearchResult'
   * bus event (useCanvasWebSearchSurfaces.ts is the one subscriber). Three
   * phases: `'searching'` sets the live `pendingQuery` (no history change),
   * `'done'` clears it and pushes a fresh {@link SearchHistoryEntry} onto the
   * front of `history` (capped at SEARCH_HISTORY_CAP), `'error'` just clears
   * `pendingQuery` (an errored call is not itself a shareable result — the
   * model's own "ERROR: ..." observation already covers it for the agent;
   * the surface simply drops back to whatever history already existed).
   */
  reportWebSearch: (event: {
    missionId: string;
    agentName?: string;
    projectId?: string;
    query: string;
    status: 'searching' | 'done' | 'error';
    results: WebSearchResultView[];
  }) => void;
  /**
   * Visible-artifact fix (propose_artifact action, agentsStore.tsx) —
   * upserts the ONE preview surface for `id` (a deterministic key the
   * caller computes, e.g. `artifact-<artifactId>`, same "reuse the SAME
   * surface across repeated calls" convention as `reportWebSearch` above,
   * just with the id computed by the caller instead of this method itself)
   * with the given HTML views (SurfaceSpec.htmlViews — see that field's own
   * doc comment). A second call for the SAME `id` (e.g. once the user has
   * resolved the proposal to one variant) UPDATES this same surface in
   * place rather than creating a second node. Returns the surface's real
   * NodeRef (`preview:<id>`) so the caller can focus/highlight it, same
   * convention as previewSurface.ts's `ensureProjectPreviewSurface`.
   */
  upsertArtifactSurface: (id: string, htmlViews: SurfaceHtmlView[], opts?: { projectId?: string }) => NodeRef;
  /**
   * Mission B (proof window, founder directive: "une fenêtre liée aux
   * agents concernés où tu rangerais les screens") — upserts the ONE proof
   * surface for `id` (a deterministic key, see
   * lib/agents/browserRecipeProof.ts's `browserProofSurfaceId`), APPENDING
   * `view` to its accumulated run history (capped at BROWSER_PROOF_RUN_CAP,
   * oldest dropped first) rather than replacing it — unlike
   * `upsertArtifactSurface` (whose caller always supplies the FULL views
   * list itself, e.g. a resolved design's final set of pages), each call
   * here represents exactly ONE recipe execution that should join the same
   * surface's navigable history, not replace what came before. `activeViewId`
   * always jumps to the newly-appended run (the most recent execution is
   * what the founder wants to see first). `ownerRefs` is UNIONED with
   * whatever the surface already carries (never replaced) — the whole point
   * of the multi-owner extension (SurfaceSpec.ownerRefs's own doc comment):
   * a second mission running the same recipe/profile adds itself to the
   * roster of agents this proof surface is tethered to, it never evicts the
   * first. Returns the surface's real NodeRef, same convention as
   * `upsertArtifactSurface`.
   */
  upsertBrowserProofSurface: (
    id: string,
    view: SurfaceHtmlView,
    opts: { ownerRefs: NodeRef[]; projectId?: string },
  ) => NodeRef;
  // ── Frames (W-CLOSE row 2, additive) — same add/update/remove shape as
  //    surfaces above. ────────────────────────────────────────────────
  addFrame: (frame: FrameSpec) => void;
  updateFrame: (id: string, patch: Partial<Omit<FrameSpec, 'id'>>) => void;
  removeFrame: (id: string) => void;
  /**
   * R7 — live-panel expand toggle/resize for a mission node. `dims: null`
   * collapses (removes the entry, reverting to the normal card); a non-null
   * `dims` both expands AND records the panel's current footprint (the
   * chevron/double-click call passes the panel's default size; NodeResizer's
   * onResizeEnd calls this again with the user's new size while staying
   * expanded).
   */
  setExpandedPanel: (ref: NodeRef, dims: { width: number; height: number } | null) => void;
  // ── Contest (W-CONTEST, additive) — best-of-N launch, same add/remove
  //    shape as joins/routers above. ────────────────────────────────────
  addContest: (contest: ContestSpec) => void;
  removeContest: (id: string) => void;
  /**
   * contestEngine.ts calls this once every contestant in `id`'s fan-in has
   * reached a terminal status (see canvasTypes.ts's ContestSpec doc
   * comment) — sets `status` to 'completed' plus the chosen `winnerId`
   * (absent = the honest no-winner case). Deliberately EXCLUDED from
   * undo/redo history, same `temporal.pause()/resume()` technique as
   * `markChainFired` above: this is engine bookkeeping, not a user edit —
   * Ctrl+Z right after an autonomous contest completion must never "undo"
   * the engine's own judging. No-op for an unknown contest id.
   */
  completeContest: (id: string, winnerId: string | undefined) => void;
  /**
   * R10 — marks `ref` as actively dragged by the user THIS session. Additive
   * only (a ref, once marked, stays marked for the rest of the session —
   * there is no `unmarkSessionDragged`, matching the task's "additive"
   * requirement): a node the user drags more than once this session should
   * stay protected the whole time, not just during its most recent drag.
   * Called once a drag's FINAL position is committed
   * (useCanvasFlowGraph.ts's onNodesChange), the same moment `setPositions`
   * commits that drag's position.
   */
  markSessionDragged: (ref: NodeRef) => void;
}

/**
 * fix(canvas) round 2 — NaN-safe coordinate equality. Plain `!==` treats
 * `NaN !== NaN` as `true` (JS's own footgun), which would make
 * {@link isPositionsPatchNoop} return `false` FOREVER for a ref whose
 * coordinate is (or ever becomes) `NaN` — even when every recomputation
 * yields the exact same `NaN`, defeating both this function's own
 * no-op detection and, transitively, `setPositions`'s Object.is bail-out
 * (round-1 fix, see {@link CanvasActions.setPositions}'s doc comment): a
 * "value-identical" NaN patch would keep allocating a new `positions`
 * object and notifying subscribers, reintroducing the exact render loop
 * round 1 closed for every OTHER coordinate value. `a === b` still covers
 * every ordinary numeric case (including `-0 === 0`, deliberately kept
 * equal here — a declutter/migration pass computing `-0` on one pass and
 * `0` on the next must still read as "unchanged", not a real move).
 */
function coordEqual(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/**
 * fix(canvas) — true when applying `patch` on top of `current` would not
 * change a single stored `{x,y}` (every ref in `patch` already has an
 * identical value; an empty `patch` is vacuously a no-op too). Shared by
 * `setPositions` (the real guard — see its own doc comment on
 * {@link CanvasActions.setPositions}) and useCanvasFlowGraph.ts's
 * declutter-persist effect (a cheaper early-out that skips calling the
 * action at all for the common "declutter recomputed the exact same
 * correction again" case — see that effect's own comment).
 */
export function isPositionsPatchNoop(
  current: Readonly<Record<NodeRef, { x: number; y: number }>>,
  patch: Readonly<Record<NodeRef, { x: number; y: number }>>,
): boolean {
  for (const ref in patch) {
    const next = patch[ref]!;
    const prev = current[ref];
    if (prev === undefined || !coordEqual(prev.x, next.x) || !coordEqual(prev.y, next.y)) return false;
  }
  return true;
}

export type CanvasState = CanvasFacts & CanvasActions;

/** The slice zundo actually tracks in undo/redo history — everything in
 *  {@link CanvasFacts} except `viewport` and `prefs` (neither is a "user
 *  edit" in the undo/redo sense: viewport is camera state, prefs are
 *  sticky UI toggles, not canvas content). */
export type CanvasTrackedState = Pick<
  CanvasFacts,
  | 'positions'
  | 'drafts'
  | 'chains'
  | 'notes'
  | 'collapsed'
  | 'routers'
  | 'joins'
  | 'surfaces'
  | 'expandedPanels'
  | 'macros'
  | 'draftVersions'
  | 'frames'
  | 'contests'
  | 'dismissedRefs'
>;

function partializeCanvasState(state: CanvasState): CanvasTrackedState {
  return {
    positions: state.positions,
    drafts: state.drafts,
    chains: state.chains,
    notes: state.notes,
    collapsed: state.collapsed,
    routers: state.routers,
    joins: state.joins,
    surfaces: state.surfaces,
    expandedPanels: state.expandedPanels,
    macros: state.macros,
    draftVersions: state.draftVersions,
    frames: state.frames,
    contests: state.contests,
    dismissedRefs: state.dismissedRefs,
  };
}

// ── Deep equality for the tracked slice ──────────────────────────────
//
// No deep-equal dependency exists in package.json (checked — not adding one
// is a hard boundary: W1a may not touch package.json), so this is a small
// self-contained structural comparator over the tracked slice, which is
// always JSON-plain data (positions/drafts/chains/notes/collapsed all
// round-trip through CanvasLayoutFileV1/ChainsFileV1 — see canvasTypes.ts).
// Canonicalizes object key order before comparing so insertion-order
// differences (e.g. re-adding a removed draft) never cause a false
// "changed" positive.

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function trackedStateEqual(pastState: CanvasTrackedState, currentState: CanvasTrackedState): boolean {
  return stableStringify(pastState) === stableStringify(currentState);
}

// ── Store ──────────────────────────────────────────────────────────

const INITIAL_FACTS: CanvasFacts = {
  positions: {},
  viewport: DEFAULT_CANVAS_VIEWPORT,
  collapsed: {},
  prefs: DEFAULT_CANVAS_PREFS,
  drafts: [],
  chains: [],
  notes: [],
  routers: [],
  joins: [],
  surfaces: [],
  expandedPanels: {},
  macros: [],
  draftVersions: {},
  frames: [],
  contests: [],
  sessionDraggedRefs: new Set(),
  dismissedRefs: [],
  summarizingRefs: [],
  exitingRefs: [],
};

/** History depth cap — generous for a canvas session, bounded so an
 *  unattended long-running session's undo stack cannot grow unbounded. */
const HISTORY_LIMIT = 200;

export const canvasStoreVanilla = createStore<CanvasState>()(
  temporal(
    (set, get) => ({
      ...INITIAL_FACTS,

      setPosition: (ref, pos) => {
        set((state) => ({ positions: { ...state.positions, [ref]: pos } }));
      },

      setPositions: (patch) => {
        // See CanvasActions.setPositions' own doc comment — a value-identical
        // patch returns `state` verbatim (zustand's documented bail-out:
        // `Object.is(nextState, state)` skips both the merge AND notifying
        // subscribers), never a freshly-allocated `positions` object.
        set((state) => (isPositionsPatchNoop(state.positions, patch) ? state : { positions: { ...state.positions, ...patch } }));
      },

      setViewport: (viewport) => {
        set({ viewport });
      },

      toggleCollapsed: (projectId) => {
        set((state) => ({
          collapsed: { ...state.collapsed, [projectId]: !state.collapsed[projectId] },
        }));
      },

      toggleFoldOrchestrator: (missionId) => {
        set((state) => ({
          prefs: {
            ...state.prefs,
            foldedOrchestrators: {
              ...state.prefs.foldedOrchestrators,
              [missionId]: !state.prefs.foldedOrchestrators?.[missionId],
            },
          },
        }));
      },

      toggleExpandLoop: (missionId) => {
        set((state) => ({
          prefs: {
            ...state.prefs,
            expandedLoops: {
              ...state.prefs.expandedLoops,
              [missionId]: !state.prefs.expandedLoops?.[missionId],
            },
          },
        }));
      },

      dismissMission: (missionId) => {
        const ref = makeRef('mission', missionId);
        set((state) => (state.dismissedRefs.includes(ref) ? state : { dismissedRefs: [...state.dismissedRefs, ref] }));
      },

      summarizeMission: (missionId) => {
        const ref = makeRef('mission', missionId);
        set((state) => (state.summarizingRefs.includes(ref) ? state : { summarizingRefs: [...state.summarizingRefs, ref] }));
      },

      beginExitAnimation: (missionId) => {
        const ref = makeRef('mission', missionId);
        set((state) => (state.exitingRefs.includes(ref) ? state : { exitingRefs: [...state.exitingRefs, ref] }));
      },

      setPrefs: (patch) => {
        set((state) => ({ prefs: { ...state.prefs, ...patch } }));
      },

      addDraft: (draft) => {
        set((state) => ({ drafts: [...state.drafts, draft] }));
      },

      updateDraft: (id, patch) => {
        set((state) => {
          const current = state.drafts.find((draft) => draft.id === id);
          if (!current) return {}; // unknown id — no-op, never a fabricated version
          const updated: DraftSpec = { ...current, ...patch };
          const existingVersions = state.draftVersions[id] ?? [];
          // `ts` doubles as this version's unique key (React list key in
          // CanvasDraftVersionsPanel.tsx, lookup key in restoreDraftVersion)
          // — two edits within the SAME millisecond (real, observed: rapid
          // synchronous updateDraft calls, e.g. a fixture seeding 3 versions
          // back-to-back) would otherwise collide on a plain `Date.now()`.
          // Clamping to strictly-greater-than-the-last-version's `ts`
          // guarantees uniqueness while staying a real epoch-ms value in the
          // normal (human-paced editing) case.
          const lastTs = existingVersions.length > 0 ? existingVersions[existingVersions.length - 1]!.ts : 0;
          const snapshot: DraftVersion = {
            ts: Math.max(Date.now(), lastTs + 1),
            title: updated.title,
            task: updated.task,
            model: updated.model,
            agentName: updated.agentName,
          };
          const nextVersions = [...existingVersions, snapshot];
          const cappedVersions =
            nextVersions.length > DRAFT_VERSION_CAP ? nextVersions.slice(nextVersions.length - DRAFT_VERSION_CAP) : nextVersions;
          return {
            drafts: state.drafts.map((draft) => (draft.id === id ? updated : draft)),
            draftVersions: { ...state.draftVersions, [id]: cappedVersions },
          };
        });
      },

      restoreDraftVersion: (draftId, ts) => {
        const version = get().draftVersions[draftId]?.find((v) => v.ts === ts);
        if (!version) return; // unknown draft/version — no fabricated restore
        // Re-applies via updateDraft (above) — appends a FRESH snapshot,
        // never rewrites/truncates the existing history (see this action's
        // own doc comment on CanvasActions).
        get().updateDraft(draftId, {
          title: version.title,
          task: version.task,
          model: version.model,
          agentName: version.agentName,
        });
      },

      removeDraft: (id) => {
        set((state) => {
          const { [id]: _removedVersions, ...restVersions } = state.draftVersions;
          return { drafts: state.drafts.filter((draft) => draft.id !== id), draftVersions: restVersions };
        });
      },

      addChain: (chain) => {
        set((state) => {
          const target = parseRef(chain.targetRef);
          if (target?.kind !== 'join') return { chains: [...state.chains, chain] };
          // See CanvasActions.addChain's doc comment — keep the target
          // join's fan-in list in sync with this newly-wired source.
          const joins = state.joins.map((join) =>
            join.id === target.id && !join.sourceRefs.includes(chain.sourceRef)
              ? { ...join, sourceRefs: [...join.sourceRefs, chain.sourceRef] }
              : join,
          );
          return { chains: [...state.chains, chain], joins };
        });
      },

      removeChain: (id) => {
        set((state) => ({ chains: state.chains.filter((chain) => chain.id !== id) }));
      },

      setChainCondition: (id, condition) => {
        set((state) => ({
          chains: state.chains.map((chain) => (chain.id === id ? { ...chain, condition } : chain)),
        }));
      },

      setChainDisabled: (id, disabled) => {
        set((state) => ({
          chains: state.chains.map((chain) => (chain.id === id ? { ...chain, disabled } : chain)),
        }));
      },

      pinChainOutput: (chainId, pinned) => {
        set((state) => ({
          chains: state.chains.map((chain) => (chain.id === chainId ? { ...chain, pinnedContext: pinned } : chain)),
        }));
      },

      unpinChainOutput: (chainId) => {
        set((state) => ({
          chains: state.chains.map((chain) => {
            if (chain.id !== chainId) return chain;
            const { pinnedContext: _pinnedContext, ...rest } = chain;
            return rest;
          }),
        }));
      },

      addMacro: (macro) => {
        set((state) => ({ macros: [...state.macros, macro] }));
      },

      removeMacro: (id) => {
        set((state) => ({ macros: state.macros.filter((macro) => macro.id !== id) }));
      },

      renameMacro: (id, patch) => {
        set((state) => ({
          macros: state.macros.map((macro) => (macro.id === id ? { ...macro, ...patch } : macro)),
        }));
      },

      instantiateMacroResult: (result) => {
        set((state) => ({
          drafts: [...state.drafts, ...result.drafts],
          routers: [...state.routers, ...result.routers],
          notes: [...state.notes, ...result.notes],
          chains: [...state.chains, ...result.chains],
          positions: { ...state.positions, ...result.positions },
        }));
      },

      mergeImportedCanvas: (result) => {
        set((state) => ({
          drafts: [...state.drafts, ...result.drafts],
          routers: [...state.routers, ...result.routers],
          joins: [...state.joins, ...result.joins],
          notes: [...state.notes, ...result.notes],
          chains: [...state.chains, ...result.chains],
          macros: [...state.macros, ...result.macros],
          frames: [...state.frames, ...result.frames],
          contests: [...state.contests, ...result.contests],
          positions: { ...state.positions, ...result.positions },
        }));
      },

      addRouter: (router) => {
        set((state) => ({ routers: [...state.routers, router] }));
      },

      removeRouter: (id) => {
        set((state) => ({ routers: state.routers.filter((router) => router.id !== id) }));
      },

      setRouterBranches: (id, branches) => {
        set((state) => ({
          routers: state.routers.map((router) => (router.id === id ? { ...router, branches } : router)),
        }));
      },

      addJoin: (join) => {
        set((state) => ({ joins: [...state.joins, join] }));
      },

      removeJoin: (id) => {
        set((state) => ({ joins: state.joins.filter((join) => join.id !== id) }));
      },

      updateJoin: (id, patch) => {
        set((state) => ({
          joins: state.joins.map((join) => (join.id === id ? { ...join, ...patch } : join)),
        }));
      },

      addSurface: (surface) => {
        set((state) => ({ surfaces: [...state.surfaces, surface] }));
      },

      updateSurface: (id, patch) => {
        set((state) => ({
          surfaces: state.surfaces.map((surface) => (surface.id === id ? { ...surface, ...patch } : surface)),
        }));
      },

      removeSurface: (id) => {
        // Fix 2 (idle-terminal auto-close) — every surface removal path
        // (manual close button, fleet-hygiene sweep) already funnels through
        // this one action; drop any tracked activity here too so
        // terminalActivity.ts's registry never outlives the surfaces it
        // describes (see that module's own doc comment).
        clearTerminalActivity(id);
        set((state) => ({ surfaces: state.surfaces.filter((surface) => surface.id !== id) }));
      },

      reportWebSearch: ({ missionId, agentName, projectId, query, status, results }) => {
        const id = `search:${missionId}`;
        set((state) => {
          const existing = state.surfaces.find((surface) => surface.id === id);
          const prevSearch = existing?.searchSurface;
          const resolvedAgentName = agentName ?? prevSearch?.agentName;
          const prevHistory = prevSearch?.history ?? [];

          const nextSearch: SearchSurfaceState =
            status === 'done'
              ? {
                  agentName: resolvedAgentName,
                  pendingQuery: undefined,
                  history: [{ query, results, atMs: Date.now() }, ...prevHistory].slice(0, SEARCH_HISTORY_CAP),
                }
              : status === 'searching'
                ? { agentName: resolvedAgentName, pendingQuery: query, history: prevHistory }
                : { agentName: resolvedAgentName, pendingQuery: undefined, history: prevHistory };

          if (existing) {
            return {
              surfaces: state.surfaces.map((surface) =>
                surface.id === id ? { ...surface, searchSurface: nextSearch } : surface,
              ),
            };
          }
          const surface: SurfaceSpec = {
            id,
            kind: 'preview',
            projectId,
            ownerRef: makeRef('mission', missionId),
            searchSurface: nextSearch,
          };
          return { surfaces: [...state.surfaces, surface] };
        });
      },

      upsertArtifactSurface: (id, htmlViews, opts) => {
        set((state) => {
          const existing = state.surfaces.find((surface) => surface.id === id);
          if (existing) {
            return {
              surfaces: state.surfaces.map((surface) => (surface.id === id ? { ...surface, htmlViews } : surface)),
            };
          }
          const surface: SurfaceSpec = { id, kind: 'preview', projectId: opts?.projectId, htmlViews };
          return { surfaces: [...state.surfaces, surface] };
        });
        return makeRef('preview', id);
      },

      upsertBrowserProofSurface: (id, view, opts) => {
        set((state) => {
          const existing = state.surfaces.find((surface) => surface.id === id);
          const existingOwners = existing?.ownerRefs ?? (existing?.ownerRef ? [existing.ownerRef] : []);
          const nextOwnerRefs = Array.from(new Set([...existingOwners, ...opts.ownerRefs]));

          if (existing) {
            const nextViews = [...(existing.htmlViews ?? []), view].slice(-BROWSER_PROOF_RUN_CAP);
            return {
              surfaces: state.surfaces.map((surface) =>
                surface.id === id
                  ? { ...surface, htmlViews: nextViews, activeViewId: view.id, ownerRefs: nextOwnerRefs }
                  : surface,
              ),
            };
          }
          const surface: SurfaceSpec = {
            id,
            kind: 'preview',
            projectId: opts.projectId,
            htmlViews: [view],
            activeViewId: view.id,
            ownerRefs: nextOwnerRefs,
          };
          return { surfaces: [...state.surfaces, surface] };
        });
        return makeRef('preview', id);
      },

      addFrame: (frame) => {
        set((state) => ({ frames: [...state.frames, frame] }));
      },

      updateFrame: (id, patch) => {
        set((state) => ({
          frames: state.frames.map((frame) => (frame.id === id ? { ...frame, ...patch } : frame)),
        }));
      },

      removeFrame: (id) => {
        set((state) => ({ frames: state.frames.filter((frame) => frame.id !== id) }));
      },

      addContest: (contest) => {
        set((state) => ({ contests: [...state.contests, contest] }));
      },

      removeContest: (id) => {
        set((state) => ({ contests: state.contests.filter((contest) => contest.id !== id) }));
      },

      completeContest: (id, winnerId) => {
        // pause()/resume() — see CanvasActions.completeContest's doc comment
        // above for why this must never become an undo step.
        canvasStoreVanilla.temporal.getState().pause();
        try {
          set((state) => ({
            contests: state.contests.map((contest) =>
              contest.id === id ? { ...contest, status: 'completed', winnerId } : contest,
            ),
          }));
        } finally {
          canvasStoreVanilla.temporal.getState().resume();
        }
      },

      setExpandedPanel: (ref, dims) => {
        set((state) => {
          if (dims === null) {
            const { [ref]: _removed, ...rest } = state.expandedPanels;
            return { expandedPanels: rest };
          }
          return { expandedPanels: { ...state.expandedPanels, [ref]: dims } };
        });
      },

      markSessionDragged: (ref) => {
        set((state) => {
          if (state.sessionDraggedRefs.has(ref)) return state; // already marked — no-op
          return { sessionDraggedRefs: new Set(state.sessionDraggedRefs).add(ref) };
        });
      },

      addNote: (note) => {
        set((state) => ({ notes: [...state.notes, note] }));
        emitLocalCanvasNote(note.id, { text: note.text, projectId: note.projectId });
      },

      updateNote: (id, patch) => {
        set((state) => ({
          notes: state.notes.map((note) => (note.id === id ? { ...note, ...patch } : note)),
        }));
        const next = get().notes.find((n) => n.id === id);
        if (next) emitLocalCanvasNote(id, { text: next.text, projectId: next.projectId });
      },

      removeNote: (id) => {
        set((state) => ({ notes: state.notes.filter((note) => note.id !== id) }));
      },

      remapDraftToMission: (draftId, missionId) => {
        const state = get();
        const draftExists = state.drafts.some((draft) => draft.id === draftId);
        if (!draftExists) return; // unknown draftId — no-op, never half-apply

        const draftRef = makeRef('draft', draftId);
        const missionNodeRef = makeRef('mission', missionId);

        set((current) => {
          const { [draftRef]: draftPosition, ...restPositions } = current.positions;
          const nextPositions =
            draftPosition !== undefined ? { ...restPositions, [missionNodeRef]: draftPosition } : current.positions;

          const nextChains = current.chains.map((chain) => {
            if (chain.sourceRef !== draftRef && chain.targetRef !== draftRef) return chain;
            return {
              ...chain,
              sourceRef: chain.sourceRef === draftRef ? missionNodeRef : chain.sourceRef,
              targetRef: chain.targetRef === draftRef ? missionNodeRef : chain.targetRef,
            };
          });

          const { [draftId]: _removedVersions, ...restDraftVersions } = current.draftVersions;

          return {
            positions: nextPositions,
            chains: nextChains,
            drafts: current.drafts.filter((draft) => draft.id !== draftId),
            draftVersions: restDraftVersions,
          };
        });
      },

      addProposalPreview: (preview) => {
        set((state) => {
          const previewPlanIds = new Set(
            [
              ...preview.drafts.map((draft) => draft.proposedPlanId),
              ...preview.chains.map((chain) => chain.proposedPlanId),
              ...preview.joins.map((join) => join.proposedPlanId),
            ].filter((planId): planId is string => planId !== undefined),
          );
          // Late-preview guard (2026-08-04 UC3 race — see `validatedPlanIds`
          // doc comment): a preview for an ALREADY-validated plan must never
          // land on the canvas. No-op the whole add.
          if (previewPlanIds.size > 0 && [...previewPlanIds].every((id) => isPlanValidated(id))) {
            return state;
          }
          const planIds = new Set([...previewPlanIds]);
          const replacesPreview = (planId: string | undefined) => planId !== undefined && planIds.has(planId);
          const mergedDrafts = [...state.drafts.filter((draft) => !replacesPreview(draft.proposedPlanId)), ...preview.drafts];
          const mergedChains = [...state.chains.filter((chain) => !replacesPreview(chain.proposedPlanId)), ...preview.chains];
          const mergedJoins = [...state.joins.filter((join) => !replacesPreview(join.proposedPlanId)), ...preview.joins];

          // P0 crash, round 3 — dedupe at materialization (canvasRefIntegrity.ts's
          // own doc comment for the full mechanism): `repairPlanSteps`
          // (graph/planStepRepair.ts) already stops the realistic case
          // upstream, at generate_plan time, but THIS is the one place every
          // preview actually lands on the live canvas — the backstop that
          // makes "two nodes share a ref" impossible by construction rather
          // than merely unlikely, regardless of what produced the collision.
          // `mergedDrafts`/`mergedJoins` list EXISTING items first (see their
          // construction above), so a collision always renames the NEWLY
          // arriving preview item, never something already materialized.
          const deduped = ensureUniqueCanvasRefs({ drafts: mergedDrafts, joins: mergedJoins, chains: mergedChains });
          if (deduped.renamed.size > 0) {
            console.warn('[canvasStore] addProposalPreview: renamed colliding ref(s) to keep every node addressable:', Object.fromEntries(deduped.renamed));
          }
          return { drafts: deduped.drafts, chains: deduped.chains, joins: deduped.joins };
        });
      },

      clearProposedExcept: (planId) => {
        set((state) => {
          const keep = (id: string | undefined) => id === undefined || id === planId;
          const nextDrafts = state.drafts.filter((d) => keep(d.proposedPlanId));
          const nextChains = state.chains.filter((c) => keep(c.proposedPlanId));
          const nextJoins = state.joins.filter((j) => keep(j.proposedPlanId));
          if (
            nextDrafts.length === state.drafts.length &&
            nextChains.length === state.chains.length &&
            nextJoins.length === state.joins.length
          ) {
            return state;
          }
          return { drafts: nextDrafts, chains: nextChains, joins: nextJoins };
        });
      },

      acceptProposedSteps: (planId, acceptedStepIds) => {
        set((state) => {
          const accepted = acceptedStepIds ? new Set(acceptedStepIds) : null;
          const isAccepted = (id: string) => accepted === null || accepted.has(id);

          // Pass 1: drafts — accepted ones lose the `proposedPlanId` stamp
          // (SAME id, same object elsewhere — never removed then re-added);
          // rejected/unselected ones are dropped outright.
          const nextDrafts: DraftSpec[] = [];
          for (const draft of state.drafts) {
            if (draft.proposedPlanId !== planId) {
              nextDrafts.push(draft);
              continue;
            }
            if (isAccepted(draft.id)) {
              const { proposedPlanId: _drop, ...rest } = draft;
              nextDrafts.push(rest);
            }
            // else: not accepted — dropped, never materialized
          }
          const survivingDraftIds = new Set(nextDrafts.map((d) => d.id));
          const draftGone = (ref: NodeRef): boolean => {
            const parsed = parseRef(ref);
            return parsed?.kind === 'draft' && !survivingDraftIds.has(parsed.id);
          };

          // Pass 2: chains tagged with this plan — dropped if either
          // endpoint no longer exists (a dangling edge onto a rejected
          // step), otherwise materialized (stamp cleared) alongside its
          // now-active draft.
          const nextChains: Chain[] = [];
          for (const chain of state.chains) {
            if (chain.proposedPlanId !== planId) {
              nextChains.push(chain);
              continue;
            }
            if (draftGone(chain.sourceRef) || draftGone(chain.targetRef)) continue;
            const { proposedPlanId: _drop, ...rest } = chain;
            nextChains.push(rest);
          }

          // Pass 3: joins tagged with this plan — same dangling-source drop,
          // plus the MIN_JOIN_SOURCES floor (joinValidation.ts's own rule):
          // a join that would end up with too few real sources is no longer
          // a meaningful fan-in and is dropped rather than kept half-wired.
          const nextJoins: JoinSpec[] = [];
          for (const join of state.joins) {
            if (join.proposedPlanId !== planId) {
              nextJoins.push(join);
              continue;
            }
            const survivingSources = join.sourceRefs.filter((ref) => !draftGone(ref));
            if (survivingSources.length < MIN_JOIN_SOURCES) continue;
            const { proposedPlanId: _drop, ...rest } = join;
            nextJoins.push({ ...rest, sourceRefs: survivingSources });
          }

          return { drafts: nextDrafts, chains: nextChains, joins: nextJoins };
        });
        // 2026-08-04 (UC3 "drafts en double"): from the moment a plan is
        // accepted, any LATE preview for it (the generate_plan turn's async
        // addProposalPreview landing after the user already clicked
        // "Valider & lancer") is a no-op — see `validatedPlanIds`'s doc
        // comment.
        markPlanValidated(planId);
      },

      rejectProposedPlan: (planId) => {
        set((state) => ({
          drafts: state.drafts.filter((d) => d.proposedPlanId !== planId),
          chains: state.chains.filter((c) => c.proposedPlanId !== planId),
          joins: state.joins.filter((j) => j.proposedPlanId !== planId),
        }));
      },

      retagProposedPlanProject: (planId, projectId) => {
        set((state) => ({
          drafts: state.drafts.map((draft) =>
            draft.proposedPlanId === planId ? { ...draft, projectId } : draft,
          ),
          joins: state.joins.map((join) =>
            join.proposedPlanId === planId ? { ...join, projectId } : join,
          ),
        }));
      },

      markChainFired: (chainId, atMs) => {
        // pause()/resume() — see the CanvasActions.markChainFired doc
        // comment above for why this must never become an undo step.
        canvasStoreVanilla.temporal.getState().pause();
        try {
          set((state) => ({
            chains: state.chains.map((chain) =>
              chain.id === chainId ? { ...chain, lastFiredAtMs: atMs } : chain,
            ),
          }));
        } finally {
          canvasStoreVanilla.temporal.getState().resume();
        }
      },

      hydrate: (layout, chainsFile) => {
        canvasStoreVanilla.temporal.getState().pause();
        try {
          set((state) => {
            const proposedDrafts = state.drafts.filter((draft) => draft.proposedPlanId !== undefined);
            const proposedChains = state.chains.filter((chain) => chain.proposedPlanId !== undefined);
            const proposedJoins = state.joins.filter((join) => join.proposedPlanId !== undefined);
            const proposalRefs = new Set<NodeRef>([
              ...proposedDrafts.map((draft) => makeRef('draft', draft.id)),
              ...proposedJoins.map((join) => makeRef('join', join.id)),
            ]);
            const proposalPositions = Object.fromEntries(
              Object.entries(state.positions).filter(([ref]) => proposalRefs.has(ref as NodeRef)),
            ) as Record<NodeRef, { x: number; y: number }>;
            const mergeProposed = <T extends { id: string }>(persisted: readonly T[], proposed: readonly T[]) => [
              ...persisted.filter((item) => !proposed.some((preview) => preview.id === item.id)),
              ...proposed,
            ];

            // P0 crash, round 3 (P3 — repair the user's already-corrupted
            // state) — this SAME hydrate is the one boot-time choke point
            // for BOTH a persisted chains.json written before this fix
            // existed (which may already carry two drafts/joins sharing an
            // id, exactly this bug's mechanism — canvasRefIntegrity.ts's own
            // header) and a fresh session's carried-over proposed items.
            // `ensureUniqueCanvasRefs` runs over the FULLY merged result so
            // either source of a collision is caught the same way, and
            // rewrites chain/join refs to match — never a silent data loss,
            // only a rename (logged below).
            const mergedChains = mergeProposed(chainsFile?.chains ?? [], proposedChains);
            const mergedDrafts = mergeProposed(chainsFile?.drafts ?? [], proposedDrafts);
            const mergedJoins = mergeProposed(chainsFile?.joins ?? [], proposedJoins);
            const deduped = ensureUniqueCanvasRefs({ drafts: mergedDrafts, joins: mergedJoins, chains: mergedChains });
            if (deduped.renamed.size > 0) {
              console.warn('[canvasStore] hydrate: repaired colliding ref(s) found in persisted/carried-over canvas state:', Object.fromEntries(deduped.renamed));
            }

            // P3 — an absurd/out-of-bounds persisted position (this exact
            // bug's unbounded declutter drift can leave one at x≈337,000)
            // is dropped, never invented a replacement for: the normal
            // auto-placement path re-derives a sane, VISIBLE spot for that
            // ref on the very next reconcile (see MAX_SANE_CANVAS_COORD's
            // own doc comment).
            const { positions: sanePositions, droppedRefs } = sanitizeCanvasPositions({ ...(layout?.positions ?? {}), ...proposalPositions });
            if (droppedRefs.length > 0) {
              console.warn('[canvasStore] hydrate: dropped out-of-bounds persisted position(s), will be re-placed on next reconcile:', droppedRefs);
            }

            return {
            positions: sanePositions,
            viewport: layout?.viewport ?? DEFAULT_CANVAS_VIEWPORT,
            collapsed: layout?.collapsed ?? {},
            // Wholesale — the W8a fold/expand records ride INSIDE prefs
            // (isCanvasPrefs tolerates the extra keys, so a legacy prefs
            // object simply hydrates without them = nothing folded).
            // fix/canvas-navigation — `sanitizeCanvasPrefs` narrows
            // `wheelMode` to exactly 'zoom'/'scroll' here at the hydration
            // boundary (never trust a persisted field un-narrowed, see its
            // own doc comment in canvasTypes.ts) instead of passing
            // `layout.prefs` through raw.
            prefs: sanitizeCanvasPrefs(layout?.prefs),
            notes: layout?.notes ?? [],
            // R7 (additive): absent on every layout.json written before this
            // field existed — hydrates as "no surfaces"/"nothing expanded",
            // same convention as every other additive field in this action.
            surfaces: layout?.surfaces ?? [],
            expandedPanels: layout?.expandedPanels ?? {},
            // W-CLOSE row 2 (additive): absent on every layout.json written
            // before this field existed — hydrates as "no frames", same
            // convention as `surfaces` above.
            frames: layout?.frames ?? [],
            // W-DISMISS (additive): absent on every layout.json written
            // before this field existed — hydrates as "nothing dismissed",
            // same convention as `frames` above.
            dismissedRefs: layout?.dismissedRefs ?? [],
            summarizingRefs: [],
            exitingRefs: [],
            chains: deduped.chains,
            drafts: deduped.drafts,
            // W8c (additive): absent on every chains.json written before this
            // field existed — hydrates as "no routers", same convention as
            // every other additive field in this action.
            routers: chainsFile?.routers ?? [],
            // W-JOIN (additive): absent on every chains.json written before
            // this field existed — hydrates as "no joins", same convention
            // as `routers` above.
            joins: deduped.joins,
            // Group macros + draft version history (additive) — absent on
            // every chains.json written before these fields existed,
            // hydrates as "no saved macros"/"no history yet".
            macros: chainsFile?.macros ?? [],
            draftVersions: chainsFile?.draftVersions ?? {},
            // W-CONTEST (additive): absent on every chains.json written
            // before this field existed — hydrates as "no contests", same
            // convention as `joins` above.
            contests: chainsFile?.contests ?? [],
            // R10 (additive) — a fresh hydrate starts a fresh session: any
            // ref marked session-dragged before this load belonged to
            // whatever was loaded previously (or nothing at all, on first
            // boot) and no longer means anything.
            sessionDraggedRefs: new Set(),
            };
          });
        } finally {
          canvasStoreVanilla.temporal.getState().resume();
        }
      },
    }),
    {
      partialize: partializeCanvasState,
      equality: trackedStateEqual,
      limit: HISTORY_LIMIT,
    },
  ),
);

// ── React hooks ────────────────────────────────────────────────────

export function useCanvasStore<T>(selector: (state: CanvasState) => T): T {
  return useStore(canvasStoreVanilla, selector);
}

/**
 * Reactive access to zundo's temporal store (undo/redo/pastStates/
 * futureStates) — see zundo's README "For reactive changes to member
 * properties of the temporal object" recipe. Uses
 * `useStoreWithEqualityFn` (zustand/traditional) so callers can pass a
 * custom equality function (e.g. to only re-render when `pastStates.length`
 * changes, not on every push) instead of the default reference equality.
 */
export function useCanvasTemporal<T>(
  selector: (state: TemporalState<CanvasTrackedState>) => T,
  equalityFn?: (a: T, b: T) => boolean,
): T {
  return useStoreWithEqualityFn(canvasStoreVanilla.temporal, selector, equalityFn);
}

// ── Test-only reset ────────────────────────────────────────────────
//
// Mirrors costStore.ts's resetCost() / objectivesStore.ts's
// _resetObjectivesForTests() convention.

export function _resetCanvasStoreForTests(): void {
  // Merge (replace=false, the default) — a full replace would also wipe
  // out the action functions, which are not part of INITIAL_FACTS.
  canvasStoreVanilla.setState({ ...INITIAL_FACTS });
  canvasStoreVanilla.temporal.getState().clear();
  validatedPlanIds = new Set<string>();
}
