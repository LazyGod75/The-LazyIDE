/* joinEngine.ts — fan-in (all-of) join firing.

   ── Wiring status (updated 2026-08-12 — regression 3.1 of
   REGRESSIONS-CHAINES.md) ─────────────────────────────────────────────────
   LIVE path: wired from sgrChainRunner.ts's `fireDownstream` (the current
   mission-terminal choke point — chainEngine.ts's own terminal callback is
   a Phase 5 compat re-export of that same function, see its header). A
   join's outgoing chain gets fired through sgrChainRunner.ts's `fireChain`
   (injected here as `attemptFireFn`, never imported — see below), so it
   gets every one of that path's guarantees (cascade-depth guard, SGR
   ownership anti-double-launch, cross-project deferral, pin) unchanged.
   STARTUP/RESTART reconcile: wired — sgrChainRunner.ts's `reconcileChains()`
   calls `reconcileJoins` against the journal snapshot. Exactly-once on
   re-entry is `fireChain`'s `shouldSkipAlreadyFired` guard (effectiveMs
   <= lastFiredAtMs). Join fires stamp the LAST source's `updatedMs`, so a
   second reconcile of the same completions is a no-op.

   ── Dependency direction (no circular import) ───────────────────────────
   sgrChainRunner.ts imports `reconcileJoins` from this module at runtime.
   This module NEVER imports anything runtime from sgrChainRunner.ts (or
   chainEngine.ts) back — the two functions it needs (`attemptFireFn`,
   `fetchAllJournalMissions`) are passed in as plain parameters by the
   caller, exactly the same "inject what can't be imported directly"
   pattern chainEngine.ts's own `ChainEngineDeps` already documents for the
   identical reason (a real cycle would otherwise exist). `Promise<unknown>`
   is used for attemptFireFn's return type since this module never inspects
   the caller's own fire-outcome type — it only awaits.

   ── No arrivals ledger (replay-safety) ──────────────────────────────────
   A join's "has source X arrived" state is NEVER persisted — it is
   recomputed on every check from each sourceRef's CURRENT terminal status
   (mission.status, or a loop's latest completed iteration), mirroring
   chainEngine.ts's `reconcileChains` philosophy exactly: restart-safe
   because there is nothing bespoke to desync. The join's OWN exactly-once
   guarantee is designed to reuse `Chain.lastFiredAtMs` on its OUTGOING
   chain(s) — see `checkAndFireJoin`'s doc comment for why always feeding it
   the LAST-arriving source's own real terminal timestamp (never
   `Date.now()`) is meant to make this naturally idempotent with zero new
   persisted state: a re-check after the join already fired would recompute
   the exact same timestamp, for an `effectiveMs <= chain.lastFiredAtMs`
   guard on the fire path (`shouldSkipAlreadyFired` in chainFireOnce.ts,
   consulted at the top of `fireChain`). Live path stays exactly-once for a
   narrower reason too: `fireDownstream` runs once per REAL mission-terminal
   transition. Reconcile re-derives the same completions; the stamp guard
   is what keeps that restart-safe.

   ── Context-passing honesty ──────────────────────────────────────────────
   `attemptFire`/`buildContextBlock` are shaped around ONE source Mission.
   Rather than fake an N-way transcript merge, a join fire picks ONE
   representative mission — the most-recently-terminal SUCCESSFUL source,
   or (only reachable under 'all_settled') the most-recently-terminal source
   of any outcome when none succeeded — as the injected context/condition-
   check input, and records every source's mission id in the fired chain's
   `chain.fired` journal event payload (`allSourceMissionIds`) so the full
   fan-in stays auditable even though only one transcript is actually
   injected as task context. A documented trade-off, not a bug: merging N
   transcripts into one coherent context block within this wave's time-box
   would be guesswork this codebase's "never fabricate" convention rejects.

   ── Scope note ───────────────────────────────────────────────────────────
   `JoinSpec.sourceRefs` resolves `mission:<id>` and `loop:<id>` refs — the
   same two kinds chainEngine.ts's own `onMissionTerminal`/`reconcileChains`
   natively resolve a terminal status for. A router-branch or another join
   as one of THIS join's own sources is not resolved this wave (no natural
   "terminal status" attaches to those refs without additional cascading
   logic this time-box does not cover) — `resolveSourceEntry` treats an
   unsupported ref kind as permanently 'pending' rather than guessing or
   crashing; chainValidation.ts's `validateJoinSources` still allows wiring
   one structurally (join-into-join IS a supported chain, just not as a
   join's OWN sourceRefs entry) — a documented, honest limitation.
   An `isolated` source mission (W-CLOSE row 6) never satisfies a join,
   exactly like it never fires a normal chain — permanently 'pending',
   consistent with chainEngine.ts's own isolated-mission gate.
*/

import type { Mission, MissionStatus } from './types.js';
import { canvasStoreVanilla } from '../../components/agents/canvas/canvasStore.js';
import { makeRef, parseRef, type JoinMode, type JoinSpec, type NodeRef } from '../../components/agents/canvas/canvasTypes.js';

/** Wire shape chainEngine.ts's `fetchAllJournalMissions` already returns —
 *  declared independently here (rather than imported) to keep this module's
 *  import graph acyclic (see module header); structurally identical, so
 *  chainEngine.ts's own return value is assignable here with no cast. */
export interface MissionEntry {
  mission: Mission;
  updatedMs: number;
}

type AttemptFireFn = (
  chainId: string,
  sourceMission: Mission,
  effectiveMs: number,
  joinContext?: { allSourceMissionIds: string[] },
) => Promise<unknown>;

/**
 * A source is satisfied for `mode` purely from its CURRENT status — no
 * timestamp involved (the caller derives the fire timestamp separately from
 * WHICH entry ends up representative, see {@link checkAndFireJoin}). Shared
 * by both the engine's fire-check and the reconciler's arrival-dot
 * rendering (`computeJoinArrivalStatuses`) so the two never drift.
 */
export function isJoinSourceSatisfied(mode: JoinMode, status: MissionStatus | undefined): boolean {
  if (status === 'done') return true;
  if (mode === 'all_settled' && status === 'failed') return true;
  return false;
}

/** Pure, UI-facing: per-source arrival dots for JoinNode.tsx (via the
 *  reconciler, which supplies `statusOf` from LIVE FleetMission data — see
 *  reconcilerZones.ts's `buildJoinSources`). Never used for the actual fire
 *  decision (that always goes through {@link checkAndFireJoin}'s journal-
 *  sourced `MissionEntry` data, which additionally needs each source's
 *  Mission object + terminal timestamp, not just a status). */
export function computeJoinArrivalStatuses(
  sourceRefs: readonly NodeRef[],
  mode: JoinMode,
  statusOf: (ref: NodeRef) => MissionStatus | undefined,
): Record<NodeRef, 'satisfied' | 'pending'> {
  const out: Record<NodeRef, 'satisfied' | 'pending'> = {};
  for (const ref of sourceRefs) {
    out[ref] = isJoinSourceSatisfied(mode, statusOf(ref)) ? 'satisfied' : 'pending';
  }
  return out;
}

/** Resolves one join sourceRef down to its terminal `MissionEntry`, or
 *  `undefined` when not (yet, or ever) terminal — see module header's
 *  scope note for the mission/loop-only support and the isolated-mission
 *  exclusion. A `loop:<id>` ref resolves to its MOST RECENT completed
 *  iteration (highest `loopIteration`), mirroring chainEngine.ts's
 *  `reconcileChains` per-iteration collection, narrowed to "latest" since a
 *  join has no per-iteration firing concept of its own — it only cares
 *  about the loop's current standing. */
function resolveSourceEntry(ref: NodeRef, missions: readonly MissionEntry[]): MissionEntry | undefined {
  const parsed = parseRef(ref);
  if (!parsed) return undefined;

  if (parsed.kind === 'mission') {
    const entry = missions.find((m) => m.mission.id === parsed.id);
    if (!entry || entry.mission.isolated) return undefined;
    if (entry.mission.status !== 'done' && entry.mission.status !== 'failed') return undefined;
    return entry;
  }

  if (parsed.kind === 'loop') {
    const iterations = missions
      .filter(
        (m) =>
          m.mission.loopParentId === parsed.id &&
          !m.mission.isolated &&
          (m.mission.status === 'done' || m.mission.status === 'failed'),
      )
      .sort((a, b) => (b.mission.loopIteration ?? 0) - (a.mission.loopIteration ?? 0));
    return iterations[0];
  }

  return undefined; // router-branch / join / other — out of scope this wave (module header)
}

/**
 * Checks one join's fan-in against `missions` (a fresh mission snapshot —
 * either the live path's freshly-fetched journal read, or reconcileChains'
 * already-fetched pass) and fires its outgoing chain(s) exactly once when
 * every sourceRef is satisfied. A join below {@link MIN_JOIN_SOURCES} (an
 * incomplete, not-yet-fully-wired join) can never be satisfied —
 * `Array.every` on an under-length array would otherwise vacuously pass, so
 * this is an explicit guard, not an incidental one.
 *
 * The fire's effective timestamp is the LAST-arriving source's own real
 * terminal timestamp (`representative.updatedMs`), never `Date.now()` — see
 * module header: this makes a join fire naturally idempotent against
 * `Chain.lastFiredAtMs` with no new persisted state, because recomputing
 * this same check after the join already fired always reproduces the exact
 * same timestamp.
 */
export async function checkAndFireJoin(join: JoinSpec, missions: readonly MissionEntry[], attemptFireFn: AttemptFireFn): Promise<void> {
  if (join.sourceRefs.length < 2) return;

  const resolved = join.sourceRefs.map((ref) => resolveSourceEntry(ref, missions));
  const allSatisfied = resolved.every((entry) => isJoinSourceSatisfied(join.mode, entry?.mission.status));
  if (!allSatisfied) return;

  const resolvedEntries = resolved.filter((entry): entry is MissionEntry => entry !== undefined);
  const successEntries = resolvedEntries.filter((entry) => entry.mission.status === 'done');
  const pool = successEntries.length > 0 ? successEntries : resolvedEntries;
  const representative = pool.reduce((latest, current) => (current.updatedMs > latest.updatedMs ? current : latest));

  const joinSourceRef = makeRef('join', join.id);
  const outgoingChains = canvasStoreVanilla.getState().chains.filter((c) => c.sourceRef === joinSourceRef && !c.disabled);
  if (outgoingChains.length === 0) return;

  const allSourceMissionIds = resolvedEntries.map((entry) => entry.mission.id);
  for (const chain of outgoingChains) {
    await attemptFireFn(chain.id, representative.mission, representative.updatedMs, { allSourceMissionIds });
  }
}

/**
 * Runs {@link checkAndFireJoin} over every given join, swallowing (and
 * logging) a per-join failure so one bad join can never block the others —
 * same isolation discipline as chainEngine.ts's own per-chain loops. The
 * ONE entry point both of chainEngine.ts's callers use: `onMissionTerminal`
 * passes just the joins referencing the mission that changed (a cheap
 * pre-filter it can do itself against canvasStore, no journal read needed
 * unless a join actually cares); `reconcileChains` passes every join, since
 * a full reconcile re-derives everything from scratch anyway.
 */
export async function reconcileJoins(joins: readonly JoinSpec[], missions: readonly MissionEntry[], attemptFireFn: AttemptFireFn): Promise<void> {
  for (const join of joins) {
    try {
      await checkAndFireJoin(join, missions, attemptFireFn);
    } catch (err: unknown) {
      console.warn(`[joinEngine] checking join ${join.id} failed:`, err);
    }
  }
}
