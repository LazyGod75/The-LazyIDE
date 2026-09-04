/* loopGate.ts — Generic three-tier validation gate lifecycle for recurring
   loops (spec §4 "Portes de validation sur les boucles" + "Cycle de vie
   complet d'un régime récurrent"). Pure, no I/O.

   Operates directly on the CANONICAL regime fields already declared on
   `LoopConfig` (lib/agents/types.ts — added by the manager-engine task that
   owns `propose_mission_charter`/`MissionCharter`): `regimeState`,
   `trialApprovedCount`, `trialPromotionThreshold`. This module does not
   invent a parallel state shape — it is the one place that computes how
   those exact fields transition, so loopEngine.ts's persistence layer and
   any future charter-authoring caller share a single source of truth.

   Deliberately domain-agnostic: nothing here knows about carousels,
   Instagram, or any content format — a "regime" is just a recurring loop
   moving through trial -> validated -> autonomous (-> self_improving),
   gated by an approval counter and reversible on the first real failure.
   Reserved strictly for recurring/permanent natures by CONSTRUCTION, not by
   a runtime "nature" check: `regimeState` is only ever set on a loop that a
   charter with nature 'recurring'/'permanent' created (see LoopConfig's own
   doc comment in types.ts) — a one-time task's LoopConfig simply never has
   it, so `recordApproval`/`recordFailure` below have no path to promote one
   (see their own `regimeState !== 'trial'` guard).
*/

import type { LoopConfig } from './types.js';

export type LoopRegimeState = NonNullable<LoopConfig['regimeState']>;

/** The subset of `LoopConfig` this module reads — a real `LoopConfig`
 *  satisfies this by structural typing. */
export type GatedLoopConfig = Pick<LoopConfig, 'regimeState' | 'trialApprovedCount' | 'trialPromotionThreshold'>;

export interface ApprovalOutcome {
  /** Fields to merge onto the loop's `LoopConfig` (immutable — never mutates
   *  the input; `{}` means "nothing changed"). */
  patch: Partial<LoopConfig>;
  /** True exactly on the approval that crosses the threshold — the caller
   *  MUST announce this to the user (spec: "annoncée ... jamais
   *  silencieuse"), never apply it quietly. */
  promoted: boolean;
}

/**
 * Records one approved execution (spec §4: "compteur d'exécutions
 * approuvées"). Only `regimeState === 'trial'` accumulates/promotes — any
 * other state (including absent, i.e. no gated regime at all) is a pure
 * no-op (`{ patch: {}, promoted: false }`), which is also the structural
 * guarantee behind "no promotion for a single task": a one-time mission's
 * loop (if it even has one) never carries `regimeState`.
 */
export function recordApproval(config: GatedLoopConfig): ApprovalOutcome {
  if (config.regimeState !== 'trial') return { patch: {}, promoted: false };
  const threshold = config.trialPromotionThreshold ?? 1;
  const approvedCount = (config.trialApprovedCount ?? 0) + 1;
  if (approvedCount >= threshold) {
    return { patch: { regimeState: 'validated', trialApprovedCount: approvedCount }, promoted: true };
  }
  return { patch: { trialApprovedCount: approvedCount }, promoted: false };
}

export interface FailureOutcome {
  patch: Partial<LoopConfig>;
  /** True when this failure sent an already-promoted regime back to
   *  'trial' — announce it (spec: "le dit"), never silently. */
  demoted: boolean;
}

/**
 * Records a failed/anomalous execution (spec §4: "retour en mode essai ...
 * au premier échec ou anomalie"). Demotes 'validated'/'autonomous'/
 * 'self_improving' straight back to 'trial' with the approval counter reset
 * to 0 (same `trialPromotionThreshold`, so a re-promotion needs the SAME
 * number of fresh approvals, not a partial credit). A failure while already
 * 'trial' (or with no regime at all) has nowhere lower to go and is a
 * no-op here — whether REPEATED trial failures should stop the loop
 * outright is a fleet-level supervision decision (see fleetHygiene.ts's
 * `planLoopSupervision`), not this per-event function's job.
 */
export function recordFailure(config: GatedLoopConfig): FailureOutcome {
  if (!config.regimeState || config.regimeState === 'trial') return { patch: {}, demoted: false };
  return { patch: { regimeState: 'trial', trialApprovedCount: 0 }, demoted: true };
}
