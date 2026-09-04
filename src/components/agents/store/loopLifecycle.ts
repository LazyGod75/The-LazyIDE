/* Loop lifecycle helpers extracted from agentsStore.tsx (mechanical move,
   no behavior change). Pure/async free functions with no closure over
   Provider state or module-level mutable variables. */

import type { Mission } from '../../../lib/agents/types';
import {
  getLoop,
  disableLoop,
  unregisterLoop,
  recordLoopApproval,
  recordLoopFailure,
  type LoopStopReason,
} from '../../../lib/agents/loopEngine';
import { emitBuffered } from '../../../lib/journal/journal';
import { projectIdFromRoot } from '../../../lib/journal/projectId';
import { WAKEUP_MARKER_PREFIX } from '../../../lib/agents/managerWakeup';
import type { LoopSupervisionAlert } from '../../../lib/agents/fleetHygiene';

export function isOneTimeMission(mission: { loopConfig?: unknown; loopParentId?: string }): boolean {
  return mission.loopConfig == null && mission.loopParentId == null;
}

/**
 * BOOT RE-STAMP fix: seeds `lastJournaledMissionsRef` (the debounce-save
 * effect's own "already journaled this exact object" memory, below) from a
 * just-hydrated boot mission list, WITHOUT emitting anything.
 *
 * Root cause this closes: that ref used to start life as an empty Map on
 * every app boot. The debounce-save effect treats "not in the map (or a
 * different object reference)" as "changed since last cycle, journal it" —
 * so the very FIRST reconcile after hydration saw every pre-existing mission
 * as unseen and re-emitted a real `mission.updated` journal write for all of
 * them, stamped with the CURRENT `Date.now()` — a permanent, honestly-wrong
 * "every mission updated at boot time" entry baked into the events table
 * (the "every row shows the same frozen boot timestamp" ticker symptom).
 *
 * Calling this right after a boot load's `setState` marks every mission that
 * load just restored as "already journaled" — the debounce-save effect can
 * then only ever emit for a REAL later change (reference inequality, same
 * rule it already used), never for the act of booting itself.
 */
export function seedJournaledMissions(
  ref: { current: Map<string, Mission> },
  missions: readonly Mission[],
): void {
  ref.current = new Map(missions.map((m) => [m.id, m] as const));
}

/**
 * ZOMBIE LOOP fix — a mission-terminal transition (merge/archive/delete)
 * used to never touch loops.json at all: only toggleLoop/deleteLoop
 * (explicit loop-detail actions) ever called disableLoop/unregisterLoop, so
 * a loop mission that got merged, archived, or deleted through any OTHER
 * path kept firing new iterations indefinitely against a mission that no
 * longer meaningfully exists — the opposite of "never saturate the user's
 * machine, no manual unblocking ever".
 *
 * Called from approveMission's merge success paths, archiveMission, and
 * deleteMission below. `getLoop` is the same registry lookup
 * toggleLoop/deleteLoop already trust as "is this really a loop?" — a no-op
 * (never journals) for the overwhelming majority of missions that were never
 * registered as one.
 */
export async function stopLoopForTerminalMission(
  repoPath: string,
  missionId: string,
  action: 'disable' | 'unregister',
  reason: 'merged' | 'archived' | 'deleted',
): Promise<void> {
  const loop = await getLoop(repoPath, missionId);
  if (!loop) return;
  if (action === 'disable') {
    await disableLoop(repoPath, missionId);
  } else {
    await unregisterLoop(repoPath, missionId);
  }
  emitBuffered({
    type: 'loop.stopped',
    tsMs: Date.now(),
    projectId: projectIdFromRoot(repoPath),
    missionId,
    actor: 'system',
    payload: { reason },
  });
}

/**
 * Section 4 gate — when an ITERATION mission of a gated loop
 * (`mission.loopParentId` set) is approved, records one approved execution
 * against the PARENT loop's own regime (loopEngine.ts's
 * `recordLoopApproval`, which itself only ever acts on the canonical
 * `LoopConfig.regimeState` fields — see that module's doc comment). A no-op
 * (`null`) for every mission that isn't a loop iteration, and for a parent
 * loop that never opted into the gated regime at all — this is also the
 * structural guarantee behind "no promotion for a single task": a one-time
 * mission has no `loopParentId` in the first place.
 */
export async function recordLoopIterationApproval(
  repoPath: string,
  mission: Pick<Mission, 'loopParentId'>,
): Promise<{ loopMissionId: string; loopTitle: string; promoted: boolean } | null> {
  if (!mission.loopParentId) return null;
  const outcome = await recordLoopApproval(repoPath, mission.loopParentId);
  if (!outcome) return null;
  return { loopMissionId: mission.loopParentId, loopTitle: outcome.loop.title, promoted: outcome.promoted };
}

/**
 * Mirror of `recordLoopIterationApproval` for a FAILED iteration (spec §4:
 * "retour en mode essai ... au premier échec"). Same no-op contract.
 */
export async function recordLoopIterationFailure(
  repoPath: string,
  mission: Pick<Mission, 'loopParentId'>,
): Promise<{ loopMissionId: string; loopTitle: string; demoted: boolean } | null> {
  if (!mission.loopParentId) return null;
  const outcome = await recordLoopFailure(repoPath, mission.loopParentId);
  if (!outcome) return null;
  return { loopMissionId: mission.loopParentId, loopTitle: outcome.loop.title, demoted: outcome.demoted };
}

/** Plain, non-localized system-chat announcements for the two loop-regime
 *  transitions that must NEVER stay silent (spec §4: "annoncée ... jamais
 *  silencieuse" / "le dit"). Kept out of the i18n catalog deliberately (this
 *  task's own file perimeter excludes src/i18n/locales/*.ts) — same
 *  established convention as this file's other plain-string system copy
 *  (e.g. `loop.stopped`'s reason enum, never localized either). */
export function formatLoopPromotedMessage(loopTitle: string): string {
  return `${WAKEUP_MARKER_PREFIX}La boucle « ${loopTitle} » passe en autonomie : le seuil de validations a été atteint.`;
}

export function formatLoopDemotedMessage(loopTitle: string): string {
  return `${WAKEUP_MARKER_PREFIX}La boucle « ${loopTitle} » repasse en mode essai suite à un échec — je resurveille les prochaines exécutions.`;
}

/** Section 4.4 supervision announcement — one line per alert kind, always
 *  sent (spec: "intervenir ou alerter", never silent). */
export function formatLoopSupervisionMessage(alert: LoopSupervisionAlert): string {
  switch (alert.reason) {
    case 'repeated_failure':
      return `${WAKEUP_MARKER_PREFIX}La boucle « ${alert.title} » a échoué plusieurs fois de suite (${alert.detail}) — je la mets en pause en attendant ta décision.`;
    case 'metric_decline':
      return `${WAKEUP_MARKER_PREFIX}La mesure apprise de la boucle « ${alert.title} » est en baisse — à surveiller.`;
    case 'stalled':
    default:
      return `${WAKEUP_MARKER_PREFIX}La boucle « ${alert.title} » semble à l'arrêt (${alert.detail}) — je vérifie.`;
  }
}

/** Computes the current consecutive-failure streak for a loop's own
 *  iteration missions (most recent iteration first) — the real signal
 *  fleetHygiene.ts's `planLoopSupervision` needs for `repeated_failure`. A
 *  non-failed iteration anywhere in the streak resets the count to 0 from
 *  that point outward (only the TRAILING run of failures counts). */
export function consecutiveLoopFailures(missions: readonly Mission[], loopMissionId: string): number {
  const iterations = missions
    .filter((m): m is Mission & { loopIteration: number } => m.loopParentId === loopMissionId && typeof m.loopIteration === 'number')
    .sort((a, b) => b.loopIteration - a.loopIteration);
  let count = 0;
  for (const m of iterations) {
    if (m.status !== 'failed') break;
    count += 1;
  }
  return count;
}

/**
 * Trust-critical defect #2 — "make it visible: when a loop stops because it
 * hit a guard, say WHY in the mission's status reason, in the user's
 * language." Plain French text (same un-i18n'd "system copy" convention as
 * formatLoopPromotedMessage/formatLoopDemotedMessage/
 * formatLoopSupervisionMessage above — see their own doc comment for why),
 * appended to (not replacing) any statusReason the anchor mission already
 * carries from its own terminal transition — a loop guard tripping is
 * additional information about the LOOP, never a replacement for whatever
 * already explained the mission's own outcome.
 */
export function formatLoopStopStatusReason(reason: LoopStopReason, previous: string | undefined): string {
  const explanation = (() => {
    switch (reason) {
      case 'mission_failed':
        return "Boucle arrêtée automatiquement : la mission suivie a échoué — relancer la même itération n'aurait rien changé.";
      case 'hard_iteration_cap':
        return 'Boucle arrêtée automatiquement : plafond d\'itérations atteint.';
      case 'repeated_failures':
        return 'Boucle arrêtée automatiquement : plusieurs itérations ont échoué de suite.';
      case 'stale_registry':
      default:
        return 'Boucle arrêtée automatiquement : la mission suivie est déjà terminée.';
    }
  })();
  return previous ? `${previous} — ${explanation}` : explanation;
}
