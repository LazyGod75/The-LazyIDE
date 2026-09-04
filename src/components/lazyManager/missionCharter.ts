/* missionCharter — UI-local helpers for the Mission Charter surface
   (SPEC-CHARTE-DE-MISSION.md, Mission C): formatting for the interim
   plain-text wiring, and deriving a displayable regime status from a
   mission's real loop config.

   The actual data shapes — `MissionCharter`, `MissionNature`,
   `DecisionWithRecommendation`, `ValidationGates`, `LearningAndKillSwitch`,
   `ManagerMessage.charterProposal`, and the recurring-regime lifecycle
   fields on `LoopConfig` (`regimeState`/`trialApprovedCount`/
   `trialPromotionThreshold`) — already exist in lib/agents/types.ts (added
   by the manager-engine task that owns the `propose_mission_charter`
   action; out of this task's locked perimeter, src/components/lazyManager/**
   + src/i18n/locales/*.ts only). This module re-exports them and adds only
   what that module doesn't define: a UI-friendly `RegimeStatus` view and
   the message-formatting helpers below.

   INTEGRATION GAP (documented, not fixed here): agentsStore.tsx has no
   dedicated accept/reject/answer methods yet for `charterProposal`
   (unlike `proposal`'s executePlan/rejectPlan/revisePlan). Until a future
   task adds them, LazyManager.tsx wires MissionCharterCard's callbacks
   through the plain `store.send(text)` primitive, formatted by the
   helpers below — see that file's wiring site for the full note. */

import type {
  DecisionWithRecommendation,
  LearningAndKillSwitch,
  LoopConfig,
  ManagerMessage,
  MissionCharter,
  MissionNature,
  ValidationGates,
} from '../../lib/agents/types';

export type {
  DecisionWithRecommendation,
  LearningAndKillSwitch,
  MissionCharter,
  MissionNature,
  ValidationGates,
};

/** The full charter-proposal envelope a message carries — mirrors
 *  `ManagerMessage.proposal`'s own state machine. */
export type CharterProposal = NonNullable<ManagerMessage['charterProposal']>;

// ── Regime lifecycle (LoopConfig.regimeState) ─────────────────────

export type RegimeState = NonNullable<LoopConfig['regimeState']>;

export interface RegimeStatus {
  id: string;
  label: string;
  state: RegimeState;
  /** Meaningful while state === 'trial'. */
  trialApproved: number;
  trialThreshold: number;
}

/** Builds a displayable RegimeStatus from a mission's real loop config —
 *  returns null when the mission isn't charter-governed (absent
 *  `regimeState`: a pre-charter loop, or a one-off task — MissionNature's
 *  own doc comment in lib/agents/types.ts), so callers can filter with
 *  `.filter(Boolean)` and never fabricate a status. */
export function regimeStatusFromMission(mission: { id: string; title: string; loopConfig?: LoopConfig }): RegimeStatus | null {
  const state = mission.loopConfig?.regimeState;
  if (!state) return null;
  return {
    id: mission.id,
    label: mission.title,
    state,
    trialApproved: mission.loopConfig?.trialApprovedCount ?? 0,
    trialThreshold: mission.loopConfig?.trialPromotionThreshold ?? 0,
  };
}

// ── Plain-language message formatting (interim send-as-text wiring) ──

type T = (key: string, params?: Record<string, string | number>) => string;

function natureLabel(nature: MissionCharter['nature'], t: T): string {
  const base = t(`lazyManager.charter.nature.${nature.kind}`);
  return nature.kind === 'recurring' && nature.cadence
    ? t('lazyManager.charter.nature.withCadence', { nature: base, cadence: nature.cadence })
    : base;
}

/**
 * Compact plain-language recap of a (possibly locally-edited) charter, sent
 * as the user's turn on Validate — see this module's INTEGRATION GAP doc
 * comment for why this goes through `store.send(text)` rather than a
 * dedicated store method. Kept short (one line per block) to respect the
 * "efficience token" constraint.
 *
 * `answeredDecisions` (index → the exact answer text, preset option or
 * free-text) restates every charter decision and what it was answered —
 * real repro this fixes: clicking a DecisionCard option sends that answer
 * as its OWN earlier turn (store.send(option), see LazyManager.tsx's
 * handleAnswerDecision), but the Validate message used to carry only
 * objective/nature/gates — no trace of which decisions were already
 * settled. The manager then had no way to distinguish "already answered"
 * from "never asked" and re-proposed a new charter re-asking the same
 * question right after the user validated. A decision with no recorded
 * answer is stated as such explicitly (never silently omitted), so the
 * manager can fall back to its own recommendation instead of guessing.
 */
export function formatCharterValidationMessage(
  charter: MissionCharter,
  answeredDecisions: Record<number, string>,
  t: T,
): string {
  const gates: string[] = [];
  if (charter.validationGates.frozenOnce.length > 0) gates.push(t('lazyManager.charter.gates.frozenOnceShort'));
  if (charter.validationGates.superviseFirstN) {
    gates.push(t('lazyManager.charter.gates.supervisedShort', { count: charter.validationGates.superviseFirstN }));
  }
  const gatesText = gates.length > 0 ? gates.join(', ') : t('lazyManager.charter.gates.noneShort');
  const base = t('lazyManager.charter.validateMessage', {
    objective: charter.objective,
    nature: natureLabel(charter.nature, t),
    gates: gatesText,
  });
  return base + formatDecisionsRecap(charter.decisions, answeredDecisions, t);
}

/** See formatCharterValidationMessage's doc comment above for the real
 *  repro this closes. Appended rather than interpolated into
 *  validateMessage's own template so every locale's existing
 *  {objective}/{nature}/{gates} string stays untouched when there are no
 *  decisions to recap (empty string, common case for a charter with no
 *  decisions block). */
function formatDecisionsRecap(
  decisions: readonly DecisionWithRecommendation[],
  answeredDecisions: Record<number, string>,
  t: T,
): string {
  if (decisions.length === 0) return '';
  const lines = decisions.map((decision, i) => {
    const answer = answeredDecisions[i];
    return answer
      ? t('lazyManager.charter.decisionAnswered', { question: decision.question, answer })
      : t('lazyManager.charter.decisionUnanswered', { question: decision.question });
  });
  return ' ' + t('lazyManager.charter.decisionsRecapPrefix') + lines.join(' ; ');
}

export function formatCharterRejectMessage(t: T): string {
  return t('lazyManager.charter.rejectMessage');
}

export function formatRegimeRevertMessage(regime: RegimeStatus, t: T): string {
  return t('lazyManager.regime.revertMessage', { label: regime.label });
}

export function formatRegimeStopMessage(regime: RegimeStatus, t: T): string {
  return t('lazyManager.regime.stopMessage', { label: regime.label });
}
