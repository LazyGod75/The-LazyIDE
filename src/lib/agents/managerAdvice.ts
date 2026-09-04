/* managerAdvice.ts — D13 graft (a): pure helpers for the "Avis du manager"
   card. Decision logic (when to offer advice, what prompt to send, how to
   read the model's answer back out) lives here, unit-testable without
   mounting a component or making a real LLM call; the React wiring
   (MissionManagerAdvice.tsx) calls these and then calls the REAL
   managerEngine.runManagerTurn directly — same pattern as the cockpit's
   AnalysisDesk.tsx (D7), which never touches LazyManager's own chat state.
*/

import type { Mission } from './types.js';
import { extractPendingQuestionText } from './missionQuestion.js';
import { formatMissionDetail } from './managerEngine.js';
import { formatVerdictScoreLine } from './evaluator.js';
import { isJudgeRejected } from '../../components/agents/approveGate.js';

const ALTERNATE_PLAN_MARKER = /plan alternatif\s*:/i;

/**
 * True for a failed mission, a 'review' mission the judge actually
 * REJECTED (QA B15 — see approveGate.ts's isJudgeRejected doc comment: a
 * rejected verdict leaves status 'review', it never produces 'failed', so
 * this case was silently unreachable before), or a running mission with a
 * real pending ask_user question (missionQuestion.ts's
 * extractPendingQuestionText) — the situations D13's graft (a) targets.
 * This codebase has no 'blocked' MissionStatus value (see types.ts) —
 * AttentionInbox.tsx classifies the running+pending-question case as
 * 'blocked'/'question' from the same signal.
 */
export function shouldOfferManagerAdvice(mission: Mission): boolean {
  if (mission.status === 'failed') return true;
  if (isJudgeRejected(mission)) return true;
  if (mission.status === 'running') return extractPendingQuestionText(mission) !== null;
  return false;
}

/**
 * Builds the single user-turn prompt sent to runManagerTurn, grounded in the
 * mission's REAL data via formatMissionDetail — the exact same helper
 * query_mission/get_agent_output use to ground the manager's chat answers —
 * so this never guesses at the mission's state. Asks for a short diagnosis
 * plus an actionable "Plan alternatif :" line the caller can parse back out
 * (see extractAlternatePlan below).
 */
export function buildManagerAdvicePrompt(mission: Mission): string {
  const detail = formatMissionDetail(mission);
  const pendingQuestion = extractPendingQuestionText(mission);

  // R14 (this task) — isJudgeRejected(mission) is a TRIAGE signal ("this
  // 'review' mission needs a human decision"), true for BOTH a genuine judge
  // rejection AND an evaluator-rail failure (JudgeVerdict.scoreUnavailable —
  // see evaluator.ts's own doc comment). The two are NOT the same situation
  // to describe to the manager LLM: claiming "rejetée par le juge" when no
  // judge ever actually produced a verdict is the exact live dishonesty this
  // task fixes elsewhere (approveGate.ts's checkApproveGate) — the manager's
  // own advice prompt must not re-introduce it on a path checkApproveGate
  // never touches.
  const judgeGenuinelyRejected = isJudgeRejected(mission) && mission.judgeVerdict?.scoreUnavailable !== true;
  const evaluationUnavailable = isJudgeRejected(mission) && mission.judgeVerdict?.scoreUnavailable === true;
  const situation = mission.status === 'failed'
    ? `La mission "${mission.title}" (${mission.id}) a échoué.`
    : judgeGenuinelyRejected
      ? // R13 — same shared scoreUnavailable rule as nodeChrome.tsx (R11):
        // a rejected mission whose judge never produced a real score (e.g.
        // an evaluator-infra failure, DEFECT 1) must never surface a
        // fabricated "score 0/100" in the manager's own advice prompt.
        // scoreUnavailable is excluded from this branch entirely now (see
        // evaluationUnavailable below), so formatVerdictScoreLine here is
        // guaranteed a real score.
        `La mission "${mission.title}" (${mission.id}) a été rejetée par le juge (${formatVerdictScoreLine(mission.judgeVerdict!)}) et attend une décision humaine.`
      : evaluationUnavailable
        ? `La mission "${mission.title}" (${mission.id}) attend une décision humaine : l'évaluation n'a pas pu être menée à bien (aucun juge n'a produit de score) — ce n'est PAS un rejet du juge, seulement une évaluation indisponible.`
        : `La mission "${mission.title}" (${mission.id}) est en cours et attend une décision humaine${pendingQuestion ? ` : "${pendingQuestion}"` : ''}.`;

  return [
    situation,
    '',
    'Voici son état réel :',
    detail,
    '',
    'Donne un diagnostic court (2-4 lignes) de la situation, puis une recommandation actionnable.',
    'Termine ta réponse par une ligne commençant exactement par "Plan alternatif :" suivie des instructions à transmettre telles quelles à l’agent (une seule phrase, impérative, prête à l’emploi).',
  ].join('\n');
}

/**
 * Extracts the actionable alternate-plan instruction from the manager's
 * response text (see buildManagerAdvicePrompt's "Plan alternatif :"
 * contract). Falls back to the full trimmed response when the model didn't
 * follow the marker convention — never returns an empty string when the
 * response itself has content.
 */
export function extractAlternatePlan(responseText: string): string {
  const trimmed = responseText.trim();
  const match = trimmed.match(ALTERNATE_PLAN_MARKER);
  if (!match || match.index === undefined) return trimmed;
  const afterMarker = trimmed.slice(match.index + match[0].length).trim();
  return afterMarker || trimmed;
}

/**
 * Builds a failed mission's new task text — its original task/title with the
 * manager's alternate plan appended — so retryMission's clone (which copies
 * agentTask verbatim, see agentsStore.tsx's retryMission) actually carries
 * the guidance into the retried run. Callers apply this via updateMission
 * BEFORE calling retryMission (see MissionManagerAdvice.tsx) — no new store
 * method needed, both are existing exported primitives.
 */
export function buildRetryTaskWithRecommendation(mission: Mission, recommendation: string): string {
  const baseTask = mission.agentTask ?? mission.title;
  return `${baseTask}\n\nConsigne du manager (suite à un échec précédent) : ${recommendation}`;
}
