/* missionQuestion.ts — shared helpers for the mission ask_user question ->
   human/manager answer flow (spec §6).

   Extracted from AttentionInbox.tsx so the LazyManager's answer_question
   action (agentsStore.tsx) reuses the EXACT same real flow instead of
   re-implementing it:
     1. Detect a mission's pending ask_user question from its REAL
        actionTimeline (extractPendingQuestionText) — never fabricated.
     2. Record a human/manager answer as a decision neuron + mission.answered
        journal event (recordMissionAnswer) — the same pairing
        AttentionInbox.tsx's handleAnswer already performed inline.

   Callers are responsible for actually DELIVERING the answer to the running
   mission (interveneMission) before calling recordMissionAnswer — that is a
   store-bound callback (agentsStore.tsx) not reachable from this
   dependency-free module, so it stays at each call site.
*/

import type { Mission } from './types.js';
import { createDecision } from '../brain/decisions.js';
import { emitEvent } from '../journal/journal.js';

/** The literal ask_user tool observation text (see toolRuntime.ts's
 *  'ask_user' case and managedAgent.ts's onAction call, which prefixes
 *  EVERY tool observation with "Observation: " before slicing to 120
 *  chars) — the real, already-shipped signal a mission is genuinely
 *  blocked on a human answer. */
const ASK_USER_MARKER = 'Observation: Question for user: ';

/**
 * W-COST (quick-reply wave) — sentinel toolRuntime.ts's 'ask_user' case
 * appends AFTER the question text, followed by a JSON string array, when the
 * agent supplied `options` on the tool call (toolRegistry.ts's ask_user
 * schema already asks the model for "2-4 options when possible" — this is
 * the wiring that lets those options actually survive to the UI instead of
 * being silently dropped). Deliberately NOT valid inside a normal question
 * sentence, so a plain question with no options is never mistaken for one.
 */
const OPTIONS_MARKER = '\n<<<OPTIONS>>>';

/**
 * Extract a pending ask_user question from a mission's real actionTimeline,
 * if its LAST entry is one. Truncated to whatever managedAgent.ts's
 * `Observation: ${observation.slice(0, 120)}` left of the original question
 * — genuinely sourced, just possibly cut short. Never fabricates: returns
 * null whenever the mission's last timeline entry is not an open question.
 * Strips the `OPTIONS_MARKER` suffix (and everything after it) when present,
 * so the returned text is always the plain question — never leaks the
 * encoded options blob into a UI surface expecting prose (mission.pendingQuestion,
 * MissionNode's live-action line, etc.). See `extractPendingQuestionOptions`
 * for the sibling extractor that reads that same suffix back out.
 */
export function extractPendingQuestionText(mission: Mission): string | null {
  const timeline = mission.actionTimeline;
  if (!timeline || timeline.length === 0) return null;
  const last = timeline[timeline.length - 1];
  const idx = last.text.indexOf(ASK_USER_MARKER);
  if (idx === -1) return null;
  const rest = last.text.slice(idx + ASK_USER_MARKER.length);
  const optionsIdx = rest.indexOf(OPTIONS_MARKER);
  const question = (optionsIdx === -1 ? rest : rest.slice(0, optionsIdx)).trim();
  return question.length > 0 ? question : null;
}

/**
 * Extract structured quick-reply options from a mission's pending ask_user
 * question, when the agent actually supplied any — see `OPTIONS_MARKER`'s
 * doc comment for the encoding. Returns null (never []) when there is no
 * pending question at all, or the question carries no parseable options:
 * an absent/malformed options blob degrades to the existing free-text-only
 * answer flow rather than throwing or fabricating choices the agent never
 * offered.
 */
export function extractPendingQuestionOptions(mission: Mission): string[] | null {
  const timeline = mission.actionTimeline;
  if (!timeline || timeline.length === 0) return null;
  const last = timeline[timeline.length - 1];
  const idx = last.text.indexOf(ASK_USER_MARKER);
  if (idx === -1) return null;
  const rest = last.text.slice(idx + ASK_USER_MARKER.length);
  const optionsIdx = rest.indexOf(OPTIONS_MARKER);
  if (optionsIdx === -1) return null;
  try {
    const parsed: unknown = JSON.parse(rest.slice(optionsIdx + OPTIONS_MARKER.length));
    if (!Array.isArray(parsed)) return null;
    const options = parsed.filter((o): o is string => typeof o === 'string' && o.trim().length > 0);
    return options.length > 0 ? options : null;
  } catch {
    return null;
  }
}

export interface RecordMissionAnswerInput {
  missionId: string;
  question: string;
  answer: string;
  projectId: string;
  actor: 'user' | 'system';
}

/**
 * Persist a human/manager answer to a mission's question as a decision
 * neuron + mission.answered event — the shared tail of the real answer flow
 * used by both AttentionInbox.tsx's inline answer form and the
 * LazyManager's answer_question action (agentsStore.tsx). Callers must
 * deliver the answer to the mission itself (interveneMission) BEFORE
 * calling this — this only records the outcome (decision registry +
 * journal), mirroring AttentionInbox.tsx's handleAnswer exactly.
 */
export async function recordMissionAnswer(input: RecordMissionAnswerInput): Promise<string | null> {
  const decisionId = await createDecision({ question: input.question, answer: input.answer, scope: 'project' });
  await emitEvent({
    type: 'mission.answered',
    tsMs: Date.now(),
    projectId: input.projectId,
    missionId: input.missionId,
    actor: input.actor,
    payload: { answer: input.answer, decisionId: decisionId ?? undefined },
  });
  return decisionId;
}
