/* contestEngine.ts — best-of-N contest runtime ("Concours", W-CONTEST:
   Cursor's "run N agents on one problem, auto-pick best" parity — our own
   primitives already cover the rest: isolated draft clones, judge verdicts,
   the archive path, scheduler pool caps).

   Module-singleton service, same DI shape as chainEngine.ts/joinEngine.ts:
   `initContestEngine(deps)` is called once from agentsStore.tsx's provider
   mount (idempotent — a second call while already initialized is a no-op
   that returns the SAME dispose function, same React StrictMode double-
   mount safety as chainEngine.ts's `initChainEngine`). Contest FACTS live in
   canvasStore's vanilla store (`canvasStoreVanilla`, imported directly —
   this module is not a React consumer, same convention as chainEngine.ts/
   joinEngine.ts). `archiveMission` cannot be imported directly (it is an
   agentsStore.tsx useCallback closing over component state, exactly like
   chainEngine.ts's `addMission` dep) — injected via {@link ContestEngineDeps}.

   ── Registration, not a rewrite (do not fight chainEngine/joinEngine) ────
   This module registers ALONGSIDE chainEngine.ts/joinEngine.ts at
   agentsStore.tsx's existing mission-terminal choke point — it does NOT
   hook into chainEngine.ts itself (chainEngine never imports this module,
   and this module never asks chainEngine to call into it). The only
   cross-import is a ONE-WAY read of chainEngine.ts's already-exported
   `fetchAllJournalMissions` (the same real, journal-sourced mission
   snapshot reconcileChains/reconcileJoins already trust) — never a cycle,
   since chainEngine.ts has no runtime import back into this module.

   ── No arrivals ledger (restart-safety) ──────────────────────────────────
   Exactly like joinEngine.ts's fan-in arrival state, "which contestants have
   already terminated" is NEVER persisted here — {@link reconcileContests}
   recomputes "are all contestants terminal yet?" purely from each
   contestant's CURRENT mission status on every check (fresh from the
   journal via `fetchAllJournalMissions`), so a completion that happened
   while the app was closed is discovered the exact same way on the next
   boot as it would have been live. `ContestSpec.status`/`winnerId` are the
   one bit of real completion bookkeeping this module ever writes — a small,
   necessary field (mirrors Chain.lastFiredAtMs), never a second source of
   truth for "is this contestant done".

   ── Ranking honesty contract ──────────────────────────────────────────────
   A contestant with a REAL passing judge score (judgeVerdict.passed === true
   AND judgeVerdict.scoreUnavailable !== true) always outranks every
   contestant without one — never the reverse, matching this codebase's
   established "never fabricate/never rank a placeholder above a real
   number" convention (JudgeVerdict.scoreUnavailable's own doc comment,
   lib/agents/types.ts). Only once NO contestant has a real passing score
   does ranking fall back to "most recent success" (status 'done', any
   verdict or none); if nobody even succeeded, the contest ends with NO
   winner — every contestant stays visible, nothing merges, and
   `contest.completed`'s journal payload records that honestly (absent
   `winnerId`, never a fabricated pick).
*/

import type { Mission, MissionStatus } from './types.js';
import { canvasStoreVanilla } from '../../components/agents/canvas/canvasStore.js';
import { saveCanvasChainsGlobal } from '../../components/agents/canvas/canvasPersistence.js';
import type { ContestRankingEntry, ContestSpec } from '../../components/agents/canvas/canvasTypes.js';
import { fetchAllJournalMissions } from './chainEngine.js';
import { emitEvent } from '../journal/journal.js';
import { isTauri } from '../platform/index.js';

/** Wire shape chainEngine.ts's `fetchAllJournalMissions` already returns —
 *  declared independently here (rather than imported) to keep this module's
 *  import graph acyclic, same convention joinEngine.ts's own identical
 *  `MissionEntry` copy already establishes (see that module's header):
 *  structurally identical, so chainEngine.ts's own return value is
 *  assignable here with no cast. */
export interface MissionEntry {
  mission: Mission;
  updatedMs: number;
}

// ── Deps (injected — see module header for why) ──────────────────────

export interface ContestEngineDeps {
  /** agentsStore.archiveMission — hides a TERMINAL mission from the Agent
   *  Canvas via the existing R13 archive path (mission.archived journal
   *  event + the `archived` flag), reused unchanged for a contest's losers.
   *  A closure over AgentsStoreProvider's component state, so it must be
   *  injected rather than imported (same reasoning as chainEngine.ts's
   *  `addMission`). */
  archiveMission: (missionId: string) => void;
  /** Resolves the ACTIVE project's id right now — same
   *  `async () => projectIdFromRoot(await resolveProjectRoot())` wiring
   *  chainEngine.ts's `getActiveProjectId` dep uses, for the SAME reason
   *  (a plain lib module has no React/AppContext access of its own). Only
   *  consulted for `contest.completed`'s journal envelope. */
  getActiveProjectId: () => Promise<string | null>;
}

// ── Module singleton state ────────────────────────────────────────────

let currentDeps: ContestEngineDeps | null = null;
let activeDispose: (() => void) | null = null;

/**
 * Wires the contest engine: runs a one-time startup reconcile (recovers a
 * contest whose contestants all terminated while the app was closed).
 * Idempotent — a second call while already initialized returns the SAME
 * dispose function without re-running the reconcile (React StrictMode
 * double-mount safety, mirrors chainEngine.ts's `initChainEngine`).
 *
 * No-op outside Tauri (same `isTauri()` guard as `initChainEngine`) —
 * `journal_missions_current` IPC has no web backend, so unguarded init would
 * fire real invoke() calls (and their console.warn failure paths) on every
 * page load of the public web demo for no benefit.
 */
export function initContestEngine(deps: ContestEngineDeps): () => void {
  if (!isTauri()) return () => {};
  if (activeDispose) return activeDispose;
  currentDeps = deps;

  void reconcileContests().catch((err: unknown) => {
    console.warn('[contestEngine] startup reconcile failed:', err);
  });

  activeDispose = () => {
    currentDeps = null;
    activeDispose = null;
  };
  return activeDispose;
}

/** Test-only: clears the module singleton between tests, mirrors
 *  chainEngine.ts's `_resetChainEngineForTests`. Does NOT touch
 *  canvasStoreVanilla itself — callers reset that separately. */
export function _resetContestEngineForTests(): void {
  currentDeps = null;
  activeDispose = null;
}

// ── Terminal-status classification ────────────────────────────────────

/** A contestant "counts" toward contest completion once it reaches ANY
 *  terminal status — done/failed/cancelled (same terminal set
 *  agentsStore.tsx's `archiveTerminalMissions` already uses for "eligible to
 *  archive"). Broader than chainEngine.ts's fire conditions (done/failed
 *  only) deliberately: a contestant the user manually stopped must still
 *  let the contest resolve rather than hang forever waiting on it. */
function isContestTerminal(status: MissionStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

// ── Live path: agentsStore's single mission-terminal choke point ─────

/**
 * Called by agentsStore.tsx at the SAME mission-terminal choke point that
 * already notifies chainEngine.ts/joinEngine.ts (registered alongside, see
 * module header) — never throws, all async work is internally caught and
 * logged. A no-op before `initContestEngine` has run, for a mission not
 * terminal yet, or when `mission.id` isn't a contestant in any currently
 * `'running'` contest.
 */
export function onMissionTerminalForContest(mission: Mission): void {
  if (!currentDeps) return;
  if (!isContestTerminal(mission.status)) return;

  const relevant = canvasStoreVanilla
    .getState()
    .contests.filter((contest) => contest.status === 'running' && contest.missionIds.includes(mission.id));
  if (relevant.length === 0) return;

  void (async () => {
    try {
      const missions = await fetchAllJournalMissions();
      for (const contest of relevant) {
        try {
          await checkAndCompleteContest(contest, missions);
        } catch (err: unknown) {
          console.warn(`[contestEngine] checking contest ${contest.id} failed:`, err);
        }
      }
    } catch (err: unknown) {
      console.warn('[contestEngine] fetching missions for contest check failed:', err);
    }
  })();
}

// ── Startup reconcile ──────────────────────────────────────────────────

/**
 * Re-derives every `'running'` contest's completion purely from the
 * journal's current mission snapshot — see module header's "no arrivals
 * ledger" section. Exported directly for tests; the live path
 * ({@link onMissionTerminalForContest}) is a targeted subset of this same
 * check.
 */
export async function reconcileContests(): Promise<void> {
  if (!currentDeps) return;
  const running = canvasStoreVanilla.getState().contests.filter((contest) => contest.status === 'running');
  if (running.length === 0) return;

  const missions = await fetchAllJournalMissions();
  for (const contest of running) {
    try {
      await checkAndCompleteContest(contest, missions);
    } catch (err: unknown) {
      console.warn(`[contestEngine] reconcile contest ${contest.id} failed:`, err);
    }
  }
}

// ── Core completion decision ───────────────────────────────────────────

async function checkAndCompleteContest(contest: ContestSpec, missions: readonly MissionEntry[]): Promise<void> {
  if (contest.status !== 'running') return;
  if (contest.missionIds.length === 0) return; // nothing to rank — never a fabricated completion

  const entries: MissionEntry[] = [];
  for (const missionId of contest.missionIds) {
    const found = missions.find((entry) => entry.mission.id === missionId);
    if (!found) return; // a contestant not yet visible in this snapshot — not ready to check
    entries.push(found);
  }
  if (!entries.every((entry) => isContestTerminal(entry.mission.status))) return;

  const { ranking, winnerId } = rankContestants(entries);
  await completeContest(contest, ranking, winnerId);
}

/** A real, honest score — `undefined` when the verdict is absent or itself
 *  flagged `scoreUnavailable` (never the `0` placeholder that field's own
 *  doc comment warns against displaying/ranking on). */
function realScoreValue(mission: Mission): number | undefined {
  const verdict = mission.judgeVerdict;
  if (!verdict || verdict.scoreUnavailable) return undefined;
  return verdict.score;
}

function costOf(entry: MissionEntry): number {
  return entry.mission.agentMetrics?.costUsd ?? Number.POSITIVE_INFINITY;
}

function durationOf(entry: MissionEntry): number {
  return entry.mission.agentMetrics?.durationMs ?? Number.POSITIVE_INFINITY;
}

function toRankingEntry(entry: MissionEntry): ContestRankingEntry {
  return { missionId: entry.mission.id, score: realScoreValue(entry.mission), costUsd: entry.mission.agentMetrics?.costUsd };
}

export interface ContestRankResult {
  ranking: ContestRankingEntry[];
  winnerId: string | undefined;
}

/**
 * Pure ranking over a contest's now-all-terminal contestants (the caller
 * checks that first — see {@link checkAndCompleteContest}). See module
 * header's "ranking honesty contract" for the full rule; independently
 * tested with mocked {@link MissionEntry} fixtures.
 */
export function rankContestants(entries: readonly MissionEntry[]): ContestRankResult {
  const winnerEligible = entries.filter((entry) => entry.mission.judgeVerdict?.passed === true && realScoreValue(entry.mission) !== undefined);

  if (winnerEligible.length > 0) {
    const ranked = [...winnerEligible].sort((a, b) => {
      const scoreDiff = realScoreValue(b.mission)! - realScoreValue(a.mission)!;
      if (scoreDiff !== 0) return scoreDiff; // higher score first
      const costDiff = costOf(a) - costOf(b);
      if (costDiff !== 0) return costDiff; // then lower cost
      return durationOf(a) - durationOf(b); // then shorter duration
    });
    const eligibleIds = new Set(ranked.map((entry) => entry.mission.id));
    const rest = entries.filter((entry) => !eligibleIds.has(entry.mission.id)).sort((a, b) => b.updatedMs - a.updatedMs);
    return { ranking: [...ranked, ...rest].map(toRankingEntry), winnerId: ranked[0]!.mission.id };
  }

  // No contestant carries a real passing score — fall back to "most recent
  // success" (status 'done', any verdict or none at all).
  const successes = entries.filter((entry) => entry.mission.status === 'done').sort((a, b) => b.updatedMs - a.updatedMs);
  const successIds = new Set(successes.map((entry) => entry.mission.id));
  const rest = entries.filter((entry) => !successIds.has(entry.mission.id)).sort((a, b) => b.updatedMs - a.updatedMs);
  // Honest no-winner case: nobody succeeded at all -> winnerId stays
  // undefined, every contestant remains in `ranking` (still visible, see
  // module header), never a fabricated pick.
  return { ranking: [...successes, ...rest].map(toRankingEntry), winnerId: successes[0]?.mission.id };
}

/**
 * Applies a contest's verdict: archives every non-winner contestant via the
 * existing R13 archive path (winner, if any, is left completely untouched in
 * the normal review flow), flips the contest to `'completed'` + `winnerId`,
 * saves immediately (bypassing the 500ms autosave debounce, same
 * `saveCanvasChainsGlobal` bypass chainEngine.ts's own `consume()` uses for
 * its exactly-once bookkeeping), and emits `contest.completed` with the full
 * ranking so every contestant's standing — winner or not — stays auditable
 * (same "record the full fan-in, not just what fired" convention
 * joinEngine.ts's checkAndFireJoin doc comment already establishes for
 * `allSourceMissionIds`). This IS the "note in their record" for a loser:
 * rather than inventing a new per-mission annotation field, the shared
 * `contest.completed` journal row is the honest, auditable explanation of
 * why each loser was archived (it lost THIS contest, to THIS winner, at THIS
 * score) — Replay/history can join on `contestId`/`missionId` to surface it.
 */
async function completeContest(contest: ContestSpec, ranking: ContestRankingEntry[], winnerId: string | undefined): Promise<void> {
  const deps = currentDeps;
  if (!deps) return;

  for (const entry of ranking) {
    if (entry.missionId === winnerId) continue; // the winner stays untouched in the normal review flow
    deps.archiveMission(entry.missionId);
  }

  // OS notification for contest completion (P7.3)
  if (winnerId) {
    void import('./osNotifications.js').then(({ notifyContestCompleted }) =>
      notifyContestCompleted(winnerId, contest.draftTemplateId),
    ).catch(() => {});
  }

  canvasStoreVanilla.getState().completeContest(contest.id, winnerId);
  const state = canvasStoreVanilla.getState();
  void saveCanvasChainsGlobal({
    version: 1,
    chains: state.chains,
    drafts: state.drafts,
    routers: state.routers,
    joins: state.joins,
    macros: state.macros,
    draftVersions: state.draftVersions,
    contests: state.contests,
  });

  const projectId = (await deps.getActiveProjectId().catch(() => null)) ?? '';
  void emitEvent({
    type: 'contest.completed',
    tsMs: Date.now(),
    projectId,
    actor: 'system',
    payload: { contestId: contest.id, winnerId, ranking },
  });
}
