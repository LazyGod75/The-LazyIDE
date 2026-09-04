/* missionOutput.ts — shared accessors for a mission's REAL input/output text
   (Agent Canvas W8b, DataInspector). New file rather than an edit to
   managerEngine.ts (whose private extractResultText this mirrors — that
   module is other-wave territory this wave may only import read-only, and
   its helper is not exported). Same honesty contract as formatMissionDetail:
   only fields actually present on the Mission object are ever reported —
   `null` (never a placeholder sentence) when a value does not exist.
*/

import type { Mission } from './types.js';

/**
 * The raw task/prompt that was actually sent to the agent:
 * `agentTask` (the full task prompt, overrides title when present — see
 * Mission.agentTask's doc comment in types.ts), else the contract's
 * objective (spec §8), else null. Deliberately NOT falling back to `title`:
 * the title is display copy, not necessarily what was sent, and the
 * inspector must never present it as the prompt when no real prompt field
 * exists.
 */
export function extractSentTask(mission: Mission): string | null {
  if (mission.agentTask && mission.agentTask.trim()) return mission.agentTask;
  if (mission.contract?.objective && mission.contract.objective.trim()) return mission.contract.objective;
  return null;
}

/**
 * True for an explicit "Résultat:"/"Result:" marker — the agent's OWN
 * stated final answer, written to the timeline at the end of its run.
 */
function isExplicitResultMarker(text: string): boolean {
  return /^(Résultat:|Result:)/.test(text);
}

/**
 * True for an `[eval]` progress line (runtime.ts's evaluation pipeline —
 * e.g. "[eval] Évaluation terminée — score: 85 — PASSÉ") appended to the
 * timeline AFTER the mission's own agent work finishes. A judge/evaluator
 * status message, never the agent's own summary.
 */
function isEvalAnnotation(text: string): boolean {
  return text.startsWith('[eval]');
}

/**
 * The mission's most representative final-output text — the SAME selection
 * order managerEngine.ts's private extractResultText applies for
 * query_mission/get_agent_output grounding, so the inspector and the
 * LazyManager never disagree about what a mission "produced":
 *   1. an explicit Résultat:/Result: marker, wherever it appears (the
 *      agent's own stated summary always wins, even over a LATER entry);
 *   2. else the latest timeline entry that is NOT an [eval] annotation —
 *      BUGFIX (M12 dogfood, MAJEUR #6c): `[eval]` lines used to be treated
 *      as an equally-valid "result marker" and, being appended by the
 *      evaluation pipeline AFTER the agent's real work, were almost always
 *      the MOST RECENT match — so "Sortie finale"/LazyManager grounding
 *      showed a judge status line ("[eval] Évaluation terminée — score:
 *      85…") instead of the agent's actual summary whenever no explicit
 *      Résultat:/Result: marker existed. `[eval]` lines are now never
 *      selected as the final output, in either the explicit-marker search
 *      or this fallback;
 *   3. else the in-flight liveAction;
 *   4. else null (caller renders an honest empty row) instead of that
 *      other module's prompt-facing '(no output recorded yet)' sentence.
 */
export function extractFinalOutput(mission: Mission): string | null {
  const timeline = mission.actionTimeline ?? [];
  const resultEntry = [...timeline].reverse().find((e) => isExplicitResultMarker(e.text));
  if (resultEntry) return resultEntry.text;
  const lastNonEval = [...timeline].reverse().find((e) => !isEvalAnnotation(e.text));
  if (lastNonEval) return lastNonEval.text;
  if (mission.liveAction) return mission.liveAction;
  return null;
}
