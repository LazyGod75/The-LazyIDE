/* canvasProposalCleanup.ts — hydrate-time migration for stale/mis-homed
   plan-proposal previews.

   Root cause this repairs (real founder state, 2026-08-01/02): a
   `generate_plan` proposal that is never launched nor rejected used to
   survive on the canvas FOREVER, across app restarts — nothing ever swept
   it. Separately, a plan proposed while the WRONG project happened to be
   active materialized its whole preview graph INSIDE that project's zone
   (see agentsStore.tsx's `generate_plan` case for the forward fix). Live
   repro: 49 stale draft nodes from 5 un-launched proposals, 3 of them
   stacked inside a single zone that did not target them at all — read by
   the founder as "the graph got duplicated".

   This module ONLY ever touches nodes still carrying `proposedPlanId` —
   canvasStore's `acceptProposedSteps` clears that stamp the instant a step
   is accepted (see its own doc comment), so a node still tagged is BY
   CONSTRUCTION never a real, launched mission. Nothing here can ever touch
   a launched mission, a chain between real missions, or anything else
   already materialized.

   ── INCIDENT (2026-08-02): the FIRST version of `inferReHomeTarget`
   matched on a bare project BASENAME ("does the objective mention the
   word 'site'/'LazySite-internet'?"). Deployed live, it swept 33+16
   drafts — INCLUDING an already-correctly-homed 11-node plan — into a
   project literally named `Lazy`, because every objective in this
   product naturally contains the word "Lazy" ("finir le backoffice de
   Lazy", "améliorer le site vitrine de Lazy") and there is an open
   project with that exact name. A false re-home is WORSE than the
   accumulation it was meant to fix — a preview that LOOKS re-homed but
   is not the real target would launch missions against the wrong repo.
   Two fixes, both load-bearing:
     1. `inferReHomeTarget` no longer matches on a project NAME at all —
        only on the target's real, absolute ROOT PATH appearing verbatim
        in the objective/name text (see that function's own doc comment).
        A product name can never collide with a filesystem path.
     2. Re-home is OFF BY DEFAULT (`CleanupStaleProposalsDeps.enableReHome`,
        defaults to `false` when omitted) — the real production wiring
        (useCanvasHydration.ts's `makeProposalCleanupDeps`) does not set
        it. The two-tier staleness cleanup below (missing/advanced
        orchestrator) is unaffected and stays fully active.
   The already-mis-relocated orchestrators from that incident were NOT
   auto-reverted: this module never recorded a `movedFrom` field, so
   there is no reliable signal to distinguish "moved by the bug" from
   "always lived here" — guessing a second time to undo a guess is the
   same mistake twice. They are left for the founder to reject
   ("Rejeter", proven working) and re-ask, which now lands correctly
   (generate_plan's own target-project fix).

   Two-tier staleness criterion (SAFE — silence/ambiguity never deletes):
     - `getOrchestrator` returns nothing for the planId -> the orchestrator
       record itself is gone -> definitely stale -> preview removed
       (`rejectProposedPlan` — the exact primitive the "Rejeter" button
       already uses).
     - the orchestrator EXISTS but its `status` is no longer 'planning' ->
       it already moved on (executing/done/blocked) WITHOUT ever properly
       clearing this preview's `proposedPlanId` stamp (acceptProposedSteps
       never ran for it) -> the preview fell out of sync with the real plan
       and is stale ghost data, same treatment as the missing-orchestrator
       case.
     - orchestrator EXISTS and is still 'planning' -> a real, still-pending
       proposal (possibly resumed after a restart — chat history and
       orchestrators.json both persist) -> LEFT ALONE, UNLESS:
         (a) the STALE-PROPOSAL sweep below fires (age or same-project
             duplicate), or
         (b) re-home is explicitly enabled (`enableReHome: true`, opt-in
             only — see the INCIDENT note above) AND `inferReHomeTarget`
             finds an absolute-path match (module header on that
             function) — the preview is then moved into its real
             project's zone (`retagProposedPlanProject` + relocating the
             underlying orchestrator record so a later execute_plan runs
             against the correct repo too), never silently left
             half-correct.
     - the proposal's CURRENT projectId cannot be resolved to an open
       project's root at all (not open this session) -> UNKNOWN, never
       guessed away -> LEFT ALONE (the caller re-runs this whenever the
       open-project list changes, so it still gets cleaned once
       resolvable).

   ── STALE-PROPOSAL SWEEP (2026-08-04 — real founder state: 21 orphaned
   drafts from plans re-proposed several times, each generate_plan call
   minting a BRAND NEW orchestrator/planId rather than updating the last
   one, all still 'planning' forever with no manager-side way to clear any
   of them — see types.ts's `reject_plan` action, the retroactive manual
   counterpart of this same cleanup). Two ADDITIONAL, UNCONDITIONAL
   criteria — never gated by `enableReHome`, exactly like the two-tier
   staleness above, applied to whatever is STILL 'planning' after it:
     - AGE: the orchestrator's own `createdAt` is older than
       `STALE_PROPOSAL_AGE_MS` (24h) -> genuinely abandoned, never
       launched nor rejected in a full day -> preview removed
       (`rejectProposedPlan`), reason `'proposal-stale'`.
     - DUPLICATE: among whatever survives the age sweep, more than one
       still-'planning' proposal targets the SAME projectId -> only the
       single MOST RECENTLY CREATED one is kept; every older sibling is
       removed, reason `'proposal-superseded'`. A projectId with only one
       live proposal is never touched by this rule — it is a
       "re-proposed several times" rule, never a "one plan per project,
       period" rule.
   Both criteria read `createdAt` only (never `updatedAt`) — a proposal
   that was genuinely revised (`revise_plan`) while still 'planning' is a
   rarer case this module does not attempt to distinguish from "created
   long ago, never touched again"; see `isProposalAgeStale`'s own doc
   comment for why `createdAt` is still the safer, simpler signal.
*/

import { deleteOrchestrator, getOrchestrator, saveOrchestratorState } from '../../../lib/agents/orchestratorState';
import type { OrchestratorState } from '../../../lib/agents/types';
import type { CanvasFacts } from './canvasStore';

// ── Grouping (pure) ──────────────────────────────────────────────────

export interface StaleProposalGroup {
  planId: string;
  /** The projectId currently stamped on this group's own drafts/joins —
   *  '' when unresolvable (e.g. a routers/joins-only plan with no tagged
   *  draft to read a projectId from). An empty projectId is NEVER treated
   *  as a real, matchable id — see `cleanupStaleProposedPreviews`. */
  projectId: string;
}

/** Every distinct `proposedPlanId` currently tagged on the canvas, paired
 *  with the projectId stamped on ITS OWN drafts/joins (irToProposedCanvas
 *  stamps every primitive with the same `ir.projectId` — see that module's
 *  own header — so any one of them is enough to resolve the group; a
 *  tagged draft is preferred, same "drafts are the common case" convention
 *  irToCanvas.ts's own `joinSourceRefs` comment uses). Chains carry no
 *  `projectId` of their own (canvasTypes.ts's Chain) so they are never
 *  consulted here. */
export function collectProposedPlanGroups(
  state: Pick<CanvasFacts, 'drafts' | 'joins'>,
): StaleProposalGroup[] {
  const byPlanId = new Map<string, string>();
  const consider = (planId: string | undefined, projectId: string | undefined): void => {
    if (!planId) return;
    const existing = byPlanId.get(planId);
    if (existing === undefined) {
      byPlanId.set(planId, projectId ?? '');
    } else if (!existing && projectId) {
      byPlanId.set(planId, projectId);
    }
  };
  for (const draft of state.drafts) consider(draft.proposedPlanId, draft.projectId);
  for (const join of state.joins) consider(join.proposedPlanId, join.projectId);
  return Array.from(byPlanId.entries()).map(([planId, projectId]) => ({ planId, projectId }));
}

// ── Re-home matching (pure) ──────────────────────────────────────────

export interface OpenProjectRef {
  /** `projectIdFromRoot(root)` — the same id space DraftSpec.projectId
   *  lives in. */
  projectId: string;
  root: string;
  /** `basename(root)` — display/logging ONLY (console.warn output below).
   *  NEVER consulted for matching — see the INCIDENT note in this module's
   *  own header on why a bare product/project NAME is unsafe to match on
   *  (it collides with the product's own name, which appears in nearly
   *  every objective by construction). */
  name: string;
}

/** A path segment short enough that requiring it alone (with no further
 *  context) would still risk an accidental substring hit inside ordinary
 *  prose — e.g. a one- or two-letter drive-relative root. Real project
 *  roots are always longer than this in practice; this is a floor, not a
 *  tuned threshold. */
const MIN_PATH_MATCH_LENGTH = 6;

/** Lowercases and collapses path separators to `/` (Windows `\` and POSIX
 *  `/` both normalize to the same string), so a root path and the SAME
 *  path typed with different slashes/case inside free-text prose still
 *  compare equal — this is the ONLY normalization applied; no fuzzy
 *  matching, no partial-segment matching. */
function normalizePathForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

/** Characters that can be part of a contiguous path/word token (the
 *  normalized text is already lowercase and slash-normalized — see
 *  `normalizePathForMatch` — so this only needs to cover what a path
 *  segment or an ordinary word can contain). Anything OUTSIDE this set
 *  (whitespace, punctuation, or the string's own start/end) is a valid
 *  boundary — including `/` itself, which is deliberately NOT in this
 *  set. */
const PATH_TOKEN_CHAR = /[a-z0-9_.:-]/;

function isPathBoundary(char: string | undefined): boolean {
  return char === undefined || !PATH_TOKEN_CHAR.test(char);
}

/**
 * True when `needlePath` appears inside `haystack` as a COMPLETE token —
 * bounded on BOTH sides by a real boundary (whitespace/punctuation/`/`/
 * start-or-end of string), never as a prefix or suffix of a LONGER
 * contiguous path/word run. Plain substring matching alone is NOT enough:
 * a project root ending in a short segment (e.g. ".../cerveau/Lazy") is a
 * literal string-PREFIX of a DIFFERENT, longer sibling folder
 * (".../cerveau/LazySite-internet") — `"...lazy".includes(...)` would
 * false-positive on that exact pairing, the same class of mistake as the
 * original incident's bare-name match, just one layer down. Boundary-
 * checking closes that gap without reintroducing any name-based matching:
 * the needle itself is still always a full absolute path.
 */
function containsPathSegment(haystack: string, needlePath: string): boolean {
  let fromIndex = 0;
  for (;;) {
    const idx = haystack.indexOf(needlePath, fromIndex);
    if (idx === -1) return false;
    const before = idx === 0 ? undefined : haystack[idx - 1];
    const afterIdx = idx + needlePath.length;
    const after = afterIdx >= haystack.length ? undefined : haystack[afterIdx];
    if (isPathBoundary(before) && isPathBoundary(after)) return true;
    fromIndex = idx + 1;
  }
}

/**
 * Re-home signal, POST-INCIDENT (module header's INCIDENT note) — matches
 * ONLY an absolute filesystem path, never a bare project/product name. An
 * objective's text must contain, verbatim (after `normalizePathForMatch`),
 * the OTHER project's real root path — e.g.
 * "C:\Users\user\Documents\cerveau\LazySite-internet" typed or pasted
 * into the objective, not the word "site" or the product name "Lazy". A
 * plan's objective naming a project only by its short name or by the
 * product it belongs to produces NO signal at all under this rule — that
 * is intentional and expected to be the common (non-matching) case; see
 * the module header for why a false positive here is strictly worse than
 * leaving a mis-homed-but-inert preview alone. `MIN_PATH_MATCH_LENGTH`
 * additionally refuses a root path too short to rule out an accidental
 * substring collision. Ambiguous (more than one candidate) or absent
 * returns `undefined` — the caller leaves the preview exactly where it is.
 */
export function inferReHomeTarget(
  orch: Pick<OrchestratorState, 'name' | 'objective' | 'projectId'>,
  openProjects: readonly OpenProjectRef[],
): OpenProjectRef | undefined {
  const text = normalizePathForMatch(`${orch.name} ${orch.objective}`);
  const containsRoot = (root: string): boolean => {
    const needle = normalizePathForMatch(root);
    return needle.length >= MIN_PATH_MATCH_LENGTH && needle.includes('/') && containsPathSegment(text, needle);
  };
  const currentStillMatches = openProjects.some((p) => p.projectId === orch.projectId && containsRoot(p.root));
  if (currentStillMatches) return undefined; // the CURRENT project's own path is itself present — never override a real self-mention
  const candidates = openProjects.filter((p) => p.projectId !== orch.projectId && containsRoot(p.root));
  return candidates.length === 1 ? candidates[0] : undefined;
}

// ── Stale-proposal sweep (pure) — age + same-project duplicate ────────

/** 24h — a 'planning' proposal older than this, by its own `createdAt`,
 *  was never launched nor rejected in a full day: the same "definitely
 *  stale, never left to accumulate forever" treatment as the missing/
 *  advanced tiers above, just keyed on age instead of orchestrator status.
 *  Not tied to missionQueue.ts's STALE_QUEUE_THRESHOLD_MS (a different
 *  concept — an unstarted queued MISSION, not a plan PROPOSAL preview) even
 *  though both happen to use the same 24h window; kept as its own constant
 *  so the two can diverge independently later. */
const STALE_PROPOSAL_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * True when a still-'planning' orchestrator has sat untouched since its own
 * creation for longer than `STALE_PROPOSAL_AGE_MS`. Reads `createdAt` only
 * (never `updatedAt`): a proposal created long ago but genuinely revised
 * more recently is a rarer case this module does not try to distinguish —
 * treating a revised-but-old proposal as fresh would require trusting
 * `updatedAt` to only ever change on a REAL human-meaningful revision,
 * which nothing in this codebase currently guarantees (e.g. an internal
 * housekeeping write could bump it without the founder ever having looked
 * at the proposal again). `createdAt`-only is the safer, simpler signal,
 * consistent with `queueStale`'s own identical choice (Mission.queueStale's
 * doc comment, types.ts). Pure/testable via the injected `nowMs`.
 */
function isProposalAgeStale(orch: Pick<OrchestratorState, 'createdAt'>, nowMs: number): boolean {
  return nowMs - orch.createdAt > STALE_PROPOSAL_AGE_MS;
}

/**
 * Among still-'planning' proposals that already survived the age sweep,
 * finds every projectId targeted by MORE THAN ONE of them — the
 * "re-proposed several times" case (module header: 21 orphaned drafts from
 * a plan asked for repeatedly, each generate_plan call minting a brand-new
 * orchestrator rather than updating the last one) — and returns the
 * planIds of every entry EXCEPT the single most-recently-created one per
 * projectId. Ties (identical `createdAt`) are broken by keeping whichever
 * entry appears FIRST in `entries` — stable and deterministic, same "never
 * a coin-flip on ambiguity" convention `inferReHomeTarget` uses elsewhere
 * in this file. A projectId targeted by only one still-live proposal is
 * never touched — this is a DUPLICATE rule, not a "one plan per project"
 * rule.
 */
function selectSupersededDuplicatePlanIds(
  entries: readonly { planId: string; projectId: string; createdAt: number }[],
): Set<string> {
  const byProject = new Map<string, { planId: string; projectId: string; createdAt: number }[]>();
  for (const entry of entries) {
    const list = byProject.get(entry.projectId);
    if (list) list.push(entry);
    else byProject.set(entry.projectId, [entry]);
  }
  const superseded = new Set<string>();
  for (const list of byProject.values()) {
    if (list.length < 2) continue;
    // Stable sort: entries with equal createdAt keep their relative
    // `entries` order, so index 0 after sorting is deterministically
    // "most recent, first-encountered on a tie" — never a coin-flip.
    const [, ...rest] = [...list].sort((a, b) => b.createdAt - a.createdAt);
    for (const entry of rest) superseded.add(entry.planId);
  }
  return superseded;
}

// ── Orchestration (async, dependency-injected — testable without Tauri) ──

export type ProposalCleanupReason =
  | 'orchestrator-missing'
  | 'orchestrator-advanced'
  | 'rehomed'
  // Stale-proposal sweep (module header) — 'proposal-stale': older than
  // STALE_PROPOSAL_AGE_MS by its own createdAt. 'proposal-superseded': a
  // MORE RECENT still-'planning' proposal targets the same projectId.
  | 'proposal-stale'
  | 'proposal-superseded';

export interface CleanupStaleProposalsDeps {
  /** Current canvas facts — read FRESH at call time (never cached), so a
   *  caller can safely invoke this repeatedly (a late-registering project,
   *  a later hydrate). */
  getCanvasState: () => Pick<CanvasFacts, 'drafts' | 'joins'>;
  rejectProposedPlan: (planId: string) => void;
  retagProposedPlanProject: (planId: string, projectId: string) => void;
  /** Every currently OPEN project (real backend truth — e.g.
   *  `listProjects()`/`project_list`, never the in-session-only
   *  globalRuntime registry, so this works even for a project this
   *  session has not yet touched). */
  listOpenProjects: () => Promise<OpenProjectRef[]>;
  getOrchestrator: (root: string, planId: string) => Promise<OrchestratorState | undefined>;
  /** Only called for the 'rehomed' case, and only after
   *  `getOrchestrator`/re-home matching already confirmed a safe,
   *  unambiguous target — see `cleanupStaleProposedPreviews`'s own guard
   *  (still-'planning', zero child missions, no existing record at the
   *  target). */
  relocateOrchestrator: (fromRoot: string, toRoot: string, orch: OrchestratorState, newProjectId: string) => Promise<void>;
  /**
   * Opt-in gate for the re-home path — defaults to `false` (OFF) when
   * omitted. See this module's own INCIDENT note (header) for why: the
   * real production wiring (useCanvasHydration.ts) does not set this, so
   * re-home never runs automatically today, regardless of how strict
   * `inferReHomeTarget`'s matching is. The two-tier staleness cleanup
   * (missing/advanced orchestrator) is NEVER gated by this flag — it stays
   * fully active either way.
   */
  enableReHome?: boolean;
}

export interface CleanupStaleProposalsResult {
  cleaned: Array<{ planId: string; projectId: string; reason: ProposalCleanupReason; newProjectId?: string }>;
}

/**
 * Runs the staleness + re-home checks (module header) over every proposal
 * group currently on the canvas. Idempotent and safe to call repeatedly —
 * a group with nothing left tagged on the canvas is simply absent from
 * the next call's `collectProposedPlanGroups`.
 *
 * `nowMs` (default `Date.now()`) drives the stale-proposal AGE check only —
 * injectable so tests can pin a deterministic "now" without faking the
 * system clock; every production call site omits it and gets the real
 * clock, unchanged from before this parameter existed.
 */
export async function cleanupStaleProposedPreviews(
  deps: CleanupStaleProposalsDeps,
  nowMs: number = Date.now(),
): Promise<CleanupStaleProposalsResult> {
  const groups = collectProposedPlanGroups(deps.getCanvasState());
  if (groups.length === 0) return { cleaned: [] };

  const openProjects = await deps.listOpenProjects().catch(() => [] as OpenProjectRef[]);
  const rootByProjectId = new Map(openProjects.map((p) => [p.projectId, p.root] as const));
  const cleaned: CleanupStaleProposalsResult['cleaned'] = [];

  // ── Pass 1: two-tier staleness (missing / advanced) — unchanged ───────
  const stillPlanning: Array<{ group: StaleProposalGroup; root: string; orch: OrchestratorState }> = [];

  for (const group of groups) {
    if (!group.projectId) continue; // unresolvable — never guessed away
    const root = rootByProjectId.get(group.projectId);
    if (!root) continue; // this group's project is not open this session — try again later

    let orch: OrchestratorState | undefined;
    try {
      orch = await deps.getOrchestrator(root, group.planId);
    } catch {
      continue; // a read failure is NOT evidence of absence — never delete on an error
    }

    if (!orch) {
      deps.rejectProposedPlan(group.planId);
      cleaned.push({ planId: group.planId, projectId: group.projectId, reason: 'orchestrator-missing' });
      continue;
    }

    if (orch.status !== 'planning') {
      deps.rejectProposedPlan(group.planId);
      cleaned.push({ planId: group.planId, projectId: group.projectId, reason: 'orchestrator-advanced' });
      continue;
    }

    stillPlanning.push({ group, root, orch });
  }

  // ── Pass 2: stale-proposal sweep (age, then same-project duplicate) —
  // unconditional, never gated by enableReHome, see module header. ────────
  const superseded = new Set<string>();

  for (const entry of stillPlanning) {
    if (!isProposalAgeStale(entry.orch, nowMs)) continue;
    deps.rejectProposedPlan(entry.group.planId);
    cleaned.push({ planId: entry.group.planId, projectId: entry.group.projectId, reason: 'proposal-stale' });
    superseded.add(entry.group.planId);
  }

  const ageSurvivors = stillPlanning.filter((entry) => !superseded.has(entry.group.planId));
  const duplicateIds = selectSupersededDuplicatePlanIds(
    ageSurvivors.map((entry) => ({
      planId: entry.group.planId,
      projectId: entry.group.projectId,
      createdAt: entry.orch.createdAt,
    })),
  );
  for (const entry of ageSurvivors) {
    if (!duplicateIds.has(entry.group.planId)) continue;
    deps.rejectProposedPlan(entry.group.planId);
    cleaned.push({ planId: entry.group.planId, projectId: entry.group.projectId, reason: 'proposal-superseded' });
    superseded.add(entry.group.planId);
  }

  // ── Pass 3: re-home candidate (opt-in) — only for whatever survived
  // BOTH sweeps above; a proposal about to be purged for being stale/
  // duplicate is never worth re-homing first. ───────────────────────────
  for (const entry of stillPlanning) {
    if (superseded.has(entry.group.planId)) continue;
    if (!deps.enableReHome || entry.orch.childMissionIds.length !== 0) continue;
    const target = inferReHomeTarget(entry.orch, openProjects);
    if (!target || target.projectId === entry.group.projectId) continue;
    try {
      await deps.relocateOrchestrator(entry.root, target.root, entry.orch, target.projectId);
      deps.retagProposedPlanProject(entry.group.planId, target.projectId);
      cleaned.push({
        planId: entry.group.planId,
        projectId: entry.group.projectId,
        reason: 'rehomed',
        newProjectId: target.projectId,
      });
    } catch {
      // best-effort — leave the preview exactly where it was, never a
      // half-moved (canvas retagged but orchestrator record untouched, or
      // vice versa) state.
    }
  }

  if (cleaned.length > 0) {
    console.warn('[canvasProposalCleanup] cleaned stale/mis-homed proposal preview(s):', cleaned);
  }
  return { cleaned };
}

// ── Real orchestrator relocation (thin wrapper over existing primitives) ──

/**
 * Moves an existing, still-'planning' orchestrator record from one
 * project's `orchestrators.json` to another's, preserving id/steps/history
 * verbatim except for `projectId` (patched to the new root's real id).
 * Refuses (throws) rather than overwrite when the target already has a
 * record with this id — never silently clobbers real data. `deleteOrchestrator`
 * on the OLD root only runs after the new root's write has succeeded, so a
 * failure never leaves the plan existing nowhere.
 */
export async function relocateOrchestratorRecord(
  fromRoot: string,
  toRoot: string,
  orch: OrchestratorState,
  newProjectId: string,
): Promise<void> {
  const alreadyAtTarget = await getOrchestrator(toRoot, orch.id);
  if (alreadyAtTarget) throw new Error(`relocateOrchestratorRecord: ${orch.id} already exists at target root`);
  await saveOrchestratorState(toRoot, { ...orch, projectId: newProjectId });
  await deleteOrchestrator(fromRoot, orch.id);
}
