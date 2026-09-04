/* sgrChainRunner.ts — Phase 5: SGR-based chain execution, replacing
   chainEngine.ts's reactive fire-per-chain logic.

   When a mission reaches a terminal status, this module:
   1. Finds matching downstream chains (condition × status)
   2. For each matching chain, resolves the target draft
   3. Builds a CONTEXTE AMONT block from the source mission
   4. Launches the target draft with the context block appended
   5. Emits chain.fired audit event
   6. Marks the chain as fired (lastFiredAtMs)

   Router-targeted chains resolve the branch at fire time using
   resolveRouterBranch from canvasChainOps.

   Join-targeted chains check if all source missions are terminal before
   firing the join's downstream target.

   This module is a module-singleton service (same shape as the old
   chainEngine): initSgrChainRunner(deps) is called ONCE from
   agentsStore.tsx's provider mount.
*/

import { listen } from '@tauri-apps/api/event';
import type { Mission } from './types.js';
import type { NewMissionInput } from '../../components/agents/agentsStore.js';
import { canvasStoreVanilla } from '../../components/agents/canvas/canvasStore.js';
import { makeRef, parseRef, type Chain, type DraftSpec, type NodeRef } from '../../components/agents/canvas/canvasTypes.js';
import { buildContextBlock, computeCascadeDepth, resolveRouterBranch, MAX_CASCADE_DEPTH } from './canvasChainOps.js';
import { emitEvent } from '../journal/journal.js';
import { emit } from '../bus.js';
import { fetchAllJournalMissions, type JournalMissionEntry } from './journalMissions.js';
import { reconcileJoins } from './joinEngine.js';
import { shouldSkipAlreadyFired } from './chainFireOnce.js';

// ── Deps (injected) ────────────────────────────────────────────────

export interface SgrChainRunnerDeps {
  /** Launch a mission for a downstream draft. */
  addMission: (input: NewMissionInput) => Promise<string>;
  /** Resolve the active project's id. */
  getActiveProjectId: () => Promise<string | null>;
  /** Fallback model id. */
  defaultModelId: () => string;
  /** Wait for missions to reach terminal status. */
  waitForMissions: (missionIds: string[], signal?: AbortSignal) => Promise<Mission[]>;
  /** Project root for brain operations. */
  projectRoot: string;
}

let currentDeps: SgrChainRunnerDeps | null = null;
let activeDispose: (() => void) | null = null;

/**
 * 2026-08-04 (UC3 dogfood — M4/M5/M6 launched TWICE: once by the SGR run and
 * once by this chain runner, the second time against the ACTIVE project with
 * a stale model, then failed by the missionScopeGuard): the drafts a plan
 * materialized are executed by the plan's OWN graph run (startOrchestratorViaSgr
 * → runGraph). Their canvas chains must NOT also fire reactively here — that
 * is the double-execution that produced the duplicate missions. While a plan
 * run is live, this set holds every draft ref the run owns; fireChain skips
 * them (the run's launchMission is the only launcher). Cleared when the run
 * settles (graph.run_finished / graph.run_failed).
 */
let sgrManagedDraftRefs = new Set<string>();

/** Session-only anti-spam dedupe for the cross-project "chain ready"
 *  toast (restored 2026-08-12 — regression 3.6 of REGRESSIONS-CHAINES.md,
 *  mirrors the old chainEngine.ts's `announcedPendingChainIds`). Cleared on
 *  process restart (nothing persisted) and by the test reset below — a
 *  chain re-announces once per fresh app session, not once forever. */
const announcedPendingChainIds = new Set<string>();

/** `project://changed` unsubscribe, set once `initSgrChainRunner` attaches
 *  the reconcile-on-project-switch listener (mirrors the old
 *  chainEngine.ts's `unlisten`). */
let projectChangedUnlisten: (() => void) | null = null;

/** Marks `refs` (draft refs, `draft:<stepId>`) as owned by a live SGR plan
 *  run — the reactive chain runner must not fire them (see the set's own
 *  doc comment). Caller: agentsStore's execute_plan handler, right after
 *  startOrchestratorViaSgr. */
export function setSgrManagedDrafts(refs: Iterable<string>): void {
  sgrManagedDraftRefs = new Set(refs);
}

/** Drops the SGR-owned set once the plan run settled — a LATER manual
 *  chain-fire (user re-arms a chain by hand) must be allowed again. */
export function clearSgrManagedDrafts(): void {
  sgrManagedDraftRefs = new Set();
}

/** Test-only reset — mirrors _resetSgrChainRunnerForTests. */
export function _resetSgrManagedDraftsForTests(): void {
  sgrManagedDraftRefs = new Set();
}

/** Wire the SGR chain runner. Idempotent — a second call while already
 *  initialized returns the SAME dispose function (React StrictMode safety).
 *
 * Also runs a ONE-TIME startup reconcile (restored 2026-08-12 — regression
 * 3.3/3.4/3.6 of REGRESSIONS-CHAINES.md: `reconcileChains()` was a
 * permanent no-op, so a chain/loop-iteration/join whose source completed
 * while the app was closed was lost silently and forever) and subscribes
 * to `project://changed` so a cross-project-pending chain auto-resumes the
 * moment the user switches into its target project — see
 * RECONCILE-DESIGN.md for the full model. Both `fetchAllJournalMissions`
 * (journalMissions.ts) and this module's own `listen()` call degrade to a
 * harmless no-op outside Tauri (no `isTauri()` gate needed HERE — unlike
 * the pre-migration `initChainEngine`, this function must keep working
 * without Tauri: sgrChainRunner.test.ts's init/reset lifecycle coverage
 * never enables it, exercising the SAME module agentsStore.tsx wires
 * unconditionally). */
export function initSgrChainRunner(deps: SgrChainRunnerDeps): () => void {
  if (activeDispose) return activeDispose;
  currentDeps = deps;

  void reconcileChains().catch((err: unknown) => {
    console.warn('[sgrChainRunner] startup reconcile failed:', err);
  });

  let disposed = false;
  Promise.resolve(
    listen<string>('project://changed', (event) => {
      void reconcileChains().catch((err: unknown) => {
        console.warn('[sgrChainRunner] reconcile-on-project-switch failed:', err);
      });
      void event; // payload (new root) not needed — reconcileChains rescans everything
    }),
  )
    .then((fn) => {
      if (disposed) {
        fn?.(); // dispose() already ran before the listener attached
      } else {
        projectChangedUnlisten = fn ?? null;
      }
    })
    .catch(() => {
      // Non-Tauri platform, or the event API is unavailable — the live
      // path (onMissionTerminalSGR) and the startup reconcile above still
      // work; only the resume-on-project-switch affordance is lost.
    });

  activeDispose = () => {
    disposed = true;
    currentDeps = null;
    if (projectChangedUnlisten) {
      projectChangedUnlisten();
      projectChangedUnlisten = null;
    }
    activeDispose = null;
  };
  return activeDispose;
}

/** Test-only: clears the module singleton between tests. */
export function _resetSgrChainRunnerForTests(): void {
  currentDeps = null;
  activeDispose = null;
  projectChangedUnlisten = null;
  announcedPendingChainIds.clear();
}

// ── Live path: called from agentsStore's mission-terminal choke point ──

/**
 * Called by agentsStore.tsx the moment a mission's status transition is
 * OBSERVED. Fire-and-forget: never throws, all async work is internally
 * caught and logged. A no-op before initSgrChainRunner has run or for a
 * 'cancelled' mission.
 */
export function onMissionTerminalSGR(mission: Mission): void {
  if (!currentDeps) return;
  if (mission.status !== 'done' && mission.status !== 'failed') return;
  if (mission.isolated) return; // Isolated missions never fire downstream

  void (async () => {
    try {
      await fireDownstream(mission);
    } catch (err: unknown) {
      console.warn('[sgrChainRunner] downstream execution failed:', err);
    }
  })();
}

async function fireDownstream(mission: Mission): Promise<void> {
  const deps = currentDeps;
  if (!deps) return;

  const { chains, drafts, joins } = canvasStoreVanilla.getState();
  const activeProjectId = await deps.getActiveProjectId().catch(() => null);
  // Computed ONCE per real mission-terminal transition, reused for every
  // chain this batch touches (mirrors the pre-migration chainEngine.ts's
  // identical `const effectiveMs = Date.now();` in its own onMissionTerminal
  // — see RECONCILE-DESIGN.md's "live vs reconcile timestamp" invariant).
  const effectiveMs = Date.now();

  // Source refs this mission can trigger
  const sourceRefs = new Set<NodeRef>([`mission:${mission.id}`]);
  if (mission.loopParentId) sourceRefs.add(`loop:${mission.loopParentId}`);

  // Find matching chains: not disabled, source matches, condition matches
  const matchingChains = chains.filter((c) => {
    if (c.disabled) return false;
    if (!sourceRefs.has(c.sourceRef)) return false;
    if (c.condition === 'success' && mission.status !== 'done') return false;
    if (c.condition === 'fail' && mission.status !== 'failed') return false;
    return true;
  });

  for (const chain of matchingChains) {
    await fireChain(chain, mission, drafts, activeProjectId, deps, effectiveMs);
  }

  // Join fan-in (restored 2026-08-12 — regression 3.1 of
  // REGRESSIONS-CHAINES.md): mirrors the old chainEngine.ts's
  // onMissionTerminal cheap pre-filter — only joins that reference THIS
  // mission/loop as one of their sourceRefs are worth a journal read below.
  // joinEngine.ts's checkAndFireJoin recomputes fan-in satisfaction fresh
  // from `missions` every call (no arrivals ledger), so it only actually
  // fires once the LAST source of a join reaches terminal — natural
  // exactly-once given this function runs once per real mission-terminal
  // transition (see onMissionTerminalSGR's own doc comment).
  const relevantJoins = joins.filter((j) => j.sourceRefs.some((ref) => sourceRefs.has(ref)));
  if (relevantJoins.length === 0) return;

  try {
    const missions = await fetchAllJournalMissions();
    await reconcileJoins(relevantJoins, missions, makeJoinAttemptFireFn(drafts, activeProjectId, deps));
  } catch (err: unknown) {
    console.warn('[sgrChainRunner] join check failed:', err);
  }
}

/**
 * Adapter satisfying joinEngine.ts's `AttemptFireFn` contract. joinEngine.ts
 * only knows the outgoing chain's id (not a live `Chain` object), so this
 * re-reads it fresh from the store — same "re-read by id" rationale the old
 * chainEngine.ts's `attemptFire` documented — then delegates to the SAME
 * `fireChain` every other trigger path uses, so a join-reached draft gets
 * IDENTICAL guards to a directly-chained one: cascade depth, SGR ownership
 * (`sgrManagedDraftRefs` — see that set's own doc comment on the 2026-08-04
 * double-launch incident this must never reopen), cross-project deferral,
 * and pinned-context honoring. A vanished chain id is a silent no-op —
 * mirrors `fireChain`'s own "target vanished" honesty for other paths.
 */
function makeJoinAttemptFireFn(
  drafts: ReturnType<typeof canvasStoreVanilla.getState>['drafts'],
  activeProjectId: string | null,
  deps: SgrChainRunnerDeps,
): (
  chainId: string,
  sourceMission: Mission,
  effectiveMs: number,
  joinContext?: { allSourceMissionIds: string[] },
) => Promise<void> {
  return async (chainId, sourceMission, effectiveMs, joinContext) => {
    const chain = canvasStoreVanilla.getState().chains.find((c) => c.id === chainId);
    if (!chain || chain.disabled) return;
    await fireChain(chain, sourceMission, drafts, activeProjectId, deps, effectiveMs, joinContext);
  };
}

async function fireChain(
  chain: Chain,
  sourceMission: Mission,
  drafts: ReturnType<typeof canvasStoreVanilla.getState>['drafts'],
  activeProjectId: string | null,
  deps: SgrChainRunnerDeps,
  // The fire's mark timestamp: `Date.now()` for a live-path call
  // (fireDownstream computes it once per batch), or the completion's own
  // journal `updatedMs` for a reconcile-driven call — see
  // RECONCILE-DESIGN.md's idempotence section for why this distinction
  // matters (a reconcile mark must never exceed what the NEXT reconcile
  // pass will see as that same completion's own timestamp).
  effectiveMs: number,
  // Set only when this fire is a join's outgoing chain (via
  // makeJoinAttemptFireFn) — `sourceMission` is then the join's chosen
  // REPRESENTATIVE source (joinEngine.ts's checkAndFireJoin doc comment
  // explains the choice) and `joinContext.allSourceMissionIds` is recorded
  // on the emitted `chain.fired` event so the full fan-in stays auditable
  // even though only the representative's transcript is actually injected
  // as context. Every direct (non-join) caller omits this — unchanged
  // behavior for every other fire path.
  joinContext?: { allSourceMissionIds: string[] },
): Promise<void> {
  // Join reconcile re-enters fireChain with the same source timestamps.
  // Without this guard, a second reconcile would launch the target again
  // (joinEngine.ts used to document this as a restart hole vs pause/resume
  // pause/resume). Live path uses Date.now() which is always later than a
  // prior stamp, so a new completion still fires.
  if (shouldSkipAlreadyFired(chain.lastFiredAtMs, effectiveMs)) return;

  // Cascade guard (mirrors the old chainEngine.ts's attemptFire, restored
  // 2026-08-12 — the SGR migration dropped the call site while leaving
  // computeCascadeDepth/MAX_CASCADE_DEPTH intact in canvasChainOps.ts). A
  // chain whose computed depth exceeds MAX_CASCADE_DEPTH is consumed (never
  // retried against this same completion) but never fired.
  const depth = computeCascadeDepth(canvasStoreVanilla.getState().chains, chain.id);
  if (depth > MAX_CASCADE_DEPTH) {
    console.warn(`[sgrChainRunner] chain ${chain.id} exceeds max cascade depth (${MAX_CASCADE_DEPTH}) — skipped`);
    canvasStoreVanilla.getState().markChainFired(chain.id, effectiveMs);
    return;
  }

  const target = parseRef(chain.targetRef);
  if (!target) return;

  // Router-targeted chains (restored 2026-08-12 — regression 3.2 of
  // REGRESSIONS-CHAINES.md): resolve the winning branch right now against
  // THIS completion, then cascade into that branch's own outgoing chain(s)
  // via a recursive fireChain call — mirrors the old chainEngine.ts's
  // attemptFire `target.kind === 'router'` case exactly. The router node
  // itself never launches anything directly.
  if (target.kind === 'router') {
    await fireRouterChain(chain, target.id, sourceMission, drafts, activeProjectId, deps, effectiveMs);
    return;
  }

  // Resolve the target: only direct draft targets are handled here.
  if (target.kind !== 'draft') return;

  const draftId = target.id;

  const draft = drafts.find((d) => d.id === draftId);
  if (!draft) {
    // Target vanished — consumed so it is never retried forever against
    // nothing (restored 2026-08-12, regression 3.3 of REGRESSIONS-
    // CHAINES.md: mirrors the old chainEngine.ts's attemptFire, which
    // consumed EVERY terminal branch except the deliberately-unconsumed
    // cross-project defer below).
    canvasStoreVanilla.getState().markChainFired(chain.id, effectiveMs);
    return;
  }

  // SGR ownership (2026-08-04 UC3 — duplicate-mission fix): a draft the
  // plan's own graph run executes must not ALSO be fired reactively here;
  // the run's launchMission is its only launcher (see sgrManagedDraftRefs's
  // doc comment). Skip silently, WITHOUT consuming — the run itself is
  // responsible for this draft, not this path.
  if (sgrManagedDraftRefs.has(chain.targetRef)) return;

  // Cross-project honesty: don't fire if draft belongs to a different
  // project — announce it instead (restored 2026-08-12, regression 3.6 of
  // REGRESSIONS-CHAINES.md) and deliberately do NOT consume: staying
  // behind lastFiredAtMs is what makes this re-checkable (and therefore
  // auto-resumable) by the next `reconcileChains()` pass — see
  // RECONCILE-DESIGN.md.
  if (draft.projectId !== undefined && draft.projectId !== activeProjectId) {
    announcePendingCrossProject(chain, sourceMission, draft);
    return;
  }

  // Build context block from the source mission — a pinned chain injects
  // the FROZEN snapshot captured at pin time instead of the live source
  // output (restored 2026-08-12; mirrors refireChainDownstream's own
  // pinnedContext handling in canvasChainOps.ts, which this reactive path
  // had stopped honoring). Absent pinnedContext -> unchanged live behavior.
  const contextBlock = chain.pinnedContext ? chain.pinnedContext.text : buildContextBlock(sourceMission);
  const agentTask = `${draft.task}${contextBlock}`;

  const missionId = await deps.addMission({
    title: draft.title,
    agentTask,
    agentName: draft.agentName,
    repo: '.',
    worktree: '',
    modelLabel: draft.model ?? deps.defaultModelId(),
    mode: 'agent',
    orchestrator: false,
    permissionMode: draft.permissionMode ?? 'acceptEdits',
  });

  // Remap the draft to the new mission id
  canvasStoreVanilla.getState().remapDraftToMission(draftId, missionId);

  // Mark chain as fired (lastFiredAtMs for exactly-once semantics)
  canvasStoreVanilla.getState().markChainFired(chain.id, effectiveMs);

  const projectId = activeProjectId ?? draft.projectId ?? '';
  void emitEvent({
    type: 'chain.fired',
    tsMs: Date.now(),
    projectId,
    missionId,
    actor: 'system',
    payload: {
      chainId: chain.id,
      sourceMissionId: sourceMission.id,
      targetRef: chain.targetRef,
      projectId,
      ...(joinContext ? { allSourceMissionIds: joinContext.allSourceMissionIds } : {}),
    },
  });
}

/**
 * Announces a cross-project-pending chain (restored 2026-08-12 — regression
 * 3.6 of REGRESSIONS-CHAINES.md): a `chain.pending_cross_project` journal
 * event ALWAYS fires (audit trail — one per completion, even if the toast
 * itself is deduped), while the user-facing `chain:pendingCrossProject` bus
 * event (Cockpit.tsx's "Lancer" toast) is deduplicated per `chainId` for
 * the life of the process — a chain re-examined by every reconcile pass
 * until its target project becomes active must not re-toast every time.
 */
function announcePendingCrossProject(chain: Chain, sourceMission: Mission, draft: DraftSpec): void {
  const projectId = draft.projectId as string; // cross-project guard already narrowed this to defined
  void emitEvent({
    type: 'chain.pending_cross_project',
    tsMs: Date.now(),
    projectId,
    missionId: sourceMission.id,
    actor: 'system',
    payload: { chainId: chain.id, sourceMissionId: sourceMission.id, targetRef: chain.targetRef, projectId },
  });

  if (announcedPendingChainIds.has(chain.id)) return;
  announcedPendingChainIds.add(chain.id);
  emit('chain:pendingCrossProject', {
    chainId: chain.id,
    draftId: draft.id,
    projectId,
    sourceTitle: sourceMission.title,
  });
}

/**
 * Router-targeted chain resolution (restored 2026-08-12 — regression 3.2 of
 * REGRESSIONS-CHAINES.md). Mirrors the old chainEngine.ts's attemptFire
 * `target.kind === 'router'` case: resolve the router's branches IN ORDER
 * against `sourceMission`, mark the INTO-router chain fired either way (a
 * router with no matching branch, or a router removed from the canvas,
 * must never be retried forever against the same completion), then cascade
 * into the winning branch's own outgoing chain(s) via the SAME fireChain
 * entry point used for everything else — so cascade-depth, pin, SGR
 * ownership, and cross-project guards all apply identically to a
 * router-reached draft as to a directly-chained one.
 */
async function fireRouterChain(
  chain: Chain,
  routerId: string,
  sourceMission: Mission,
  drafts: ReturnType<typeof canvasStoreVanilla.getState>['drafts'],
  activeProjectId: string | null,
  deps: SgrChainRunnerDeps,
  effectiveMs: number,
): Promise<void> {
  const router = canvasStoreVanilla.getState().routers.find((r) => r.id === routerId);
  if (!router) {
    // Router vanished from the canvas — consume this completion honestly so
    // it is never left in a permanent "never examined" state.
    canvasStoreVanilla.getState().markChainFired(chain.id, effectiveMs);
    return;
  }

  const outputText = buildContextBlock(sourceMission);
  const matchedBranch = resolveRouterBranch(router.branches, sourceMission, outputText);

  // This completion is consumed by the into-router chain either way — a
  // router with no matching branch is not re-examined against the same
  // completion (mirrors the old attemptFire's unconditional `consume`).
  canvasStoreVanilla.getState().markChainFired(chain.id, effectiveMs);
  if (!matchedBranch) return;

  const branchSourceRef = makeRef('router', `${router.id}:${matchedBranch.id}`);
  const branchChains = canvasStoreVanilla
    .getState()
    .chains.filter((c) => c.sourceRef === branchSourceRef && !c.disabled);

  for (const branchChain of branchChains) {
    await fireChain(branchChain, sourceMission, drafts, activeProjectId, deps, effectiveMs);
  }
}

// ── Reconciliation: startup + project-switch catch-up ─────────────────

/**
 * Re-derives every chain's (and join's) firing state from the journal —
 * restores regressions 3.3/3.4/3.6 of REGRESSIONS-CHAINES.md (startup
 * catch-up for simple chains, loops, joins, and cross-project resume). See
 * RECONCILE-DESIGN.md for the full model/invariants. Called once from
 * `initSgrChainRunner` at mount and again on every `project://changed`
 * event — exported directly so tests (and a future manual "resync" action)
 * can trigger the same pass on demand.
 */
export async function reconcileChains(): Promise<void> {
  const deps = currentDeps;
  if (!deps) return;

  const entries = await fetchAllJournalMissions();
  if (entries.length === 0) return; // nothing terminal on record — nothing to catch up

  const activeProjectId = await deps.getActiveProjectId().catch(() => null);
  const { chains, drafts } = canvasStoreVanilla.getState();

  for (const chain of chains) {
    if (chain.disabled) continue;
    try {
      await reconcileOneChain(chain.id, entries, drafts, activeProjectId, deps);
    } catch (err: unknown) {
      console.warn(`[sgrChainRunner] reconcile: chain ${chain.id} failed:`, err);
    }
  }

  try {
    await reconcileJoins(
      canvasStoreVanilla.getState().joins,
      entries,
      makeJoinAttemptFireFn(canvasStoreVanilla.getState().drafts, activeProjectId, deps),
    );
  } catch (err: unknown) {
    console.warn('[sgrChainRunner] reconcile: join check failed:', err);
  }
}

/** Every terminal completion (journal-sourced) that could matter for this
 *  chain's OWN sourceRef, oldest first — a `loop:<id>` source yields every
 *  completed iteration (ascending `loopIteration`, mirrors the old
 *  chainEngine.ts's per-iteration reconcile collection); a `mission:<id>`
 *  source yields at most one. */
function resolveChainSourceCandidates(sourceRef: NodeRef, entries: readonly JournalMissionEntry[]): JournalMissionEntry[] {
  const parsed = parseRef(sourceRef);
  if (!parsed) return [];

  if (parsed.kind === 'mission') {
    const entry = entries.find((e) => e.mission.id === parsed.id);
    if (!entry) return [];
    if (entry.mission.status !== 'done' && entry.mission.status !== 'failed') return [];
    return [entry];
  }

  if (parsed.kind === 'loop') {
    return entries
      .filter(
        (e) =>
          e.mission.loopParentId === parsed.id && (e.mission.status === 'done' || e.mission.status === 'failed'),
      )
      .sort((a, b) => (a.mission.loopIteration ?? 0) - (b.mission.loopIteration ?? 0));
  }

  return []; // router-branch/join/other sourceRef kinds never occur (chainValidation.ts)
}

/**
 * Processes one chain's candidate completions in order, re-reading the
 * chain FRESH from the store before each candidate (a loop source firing
 * iteration N must see iteration N's own effect before deciding on N+1 —
 * same requirement the old chainEngine.ts's reconcileChains documented).
 * Isolated-mission and condition-mismatch completions are consumed here
 * (they will NEVER match this exact historical completion) — the live path
 * never needs this because `fireDownstream` already pre-filters both
 * before ever calling `fireChain`; reconcile has no such pre-filter, since
 * it processes every chain against every candidate itself.
 */
async function reconcileOneChain(
  chainId: string,
  entries: readonly JournalMissionEntry[],
  drafts: ReturnType<typeof canvasStoreVanilla.getState>['drafts'],
  activeProjectId: string | null,
  deps: SgrChainRunnerDeps,
): Promise<void> {
  const sourceRef = canvasStoreVanilla.getState().chains.find((c) => c.id === chainId)?.sourceRef;
  if (!sourceRef) return;

  const candidates = resolveChainSourceCandidates(sourceRef, entries);

  for (const entry of candidates) {
    const current = canvasStoreVanilla.getState().chains.find((c) => c.id === chainId);
    if (!current || current.disabled) return;
    if (current.lastFiredAtMs !== undefined && entry.updatedMs <= current.lastFiredAtMs) continue;

    // Isolated missions never fire downstream (W-CLOSE row 6, mirrors
    // onMissionTerminalSGR's own live-path gate) — consumed so a LATER
    // reconcile never re-examines the exact same completion.
    if (entry.mission.isolated) {
      canvasStoreVanilla.getState().markChainFired(current.id, entry.updatedMs);
      continue;
    }

    const conditionMatches =
      current.condition === 'always' ||
      (current.condition === 'success' && entry.mission.status === 'done') ||
      (current.condition === 'fail' && entry.mission.status === 'failed');
    if (!conditionMatches) {
      canvasStoreVanilla.getState().markChainFired(current.id, entry.updatedMs);
      continue;
    }

    await fireChain(current, entry.mission, drafts, activeProjectId, deps, entry.updatedMs);

    // A cross-project defer is the ONE fireChain outcome that deliberately
    // leaves lastFiredAtMs untouched (see fireChain's own doc comment) —
    // detected here by re-reading the chain fresh: stop processing further
    // candidates for THIS chain so a later iteration's context can never
    // overwrite an earlier one's still-pending handoff out of order
    // (mirrors the old chainEngine.ts's `deferred-cross-project` early
    // break).
    const after = canvasStoreVanilla.getState().chains.find((c) => c.id === chainId);
    if (after && after.lastFiredAtMs === undefined) return;
  }
}
