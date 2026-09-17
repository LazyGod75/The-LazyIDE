/* jevAskRunner.ts — shared executor behind the manager's `ask_jev`
   grounding action AND the managed-agent `ask_jev` tool. One place owns
   the model-facing contract → wire-format mapping and the result
   formatting, so both surfaces behave identically.

   Never throws: every failure mode returns a formatted "(ask_jev
   unavailable: …)" string — the same honest-degradation convention as
   the other grounding lanes (briefing, decision_lookup, scan_project).
*/

import { jevAsk, JevError } from './jevClient.js';
import { isJevModeOn } from './jevMode.js';
import { emitJevJudgment } from './jevJournal.js';
import type { JevQuestion, JevResponse } from './jevTypes.js';

/** Public question shape the manager action / tool schema exposes. */
export interface AskJevQuestion {
  id: string;
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  /** choice: option ids; score: index-ordered level descriptions. */
  options?: string[];
}

const ASK_JEV_TIMEOUT_MS = 5_000;
const MAX_ASK_JEV_QUESTIONS = 12;
const MAX_STATE_CHARS = 8_000;

function toWireQuestions(list: readonly AskJevQuestion[]): Record<string, JevQuestion> {
  const out: Record<string, JevQuestion> = {};
  for (const q of list) {
    if (q.type === 'choice') {
      out[q.id] = {
        type: 'choice',
        instructions: q.instructions,
        criteria: Object.fromEntries((q.options ?? []).map((o) => [o, o])),
      };
    } else if (q.type === 'score') {
      out[q.id] = { type: 'score', instructions: q.instructions, criteria: q.options ?? [] };
    } else {
      out[q.id] = { type: 'noul', instructions: q.instructions };
    }
  }
  return out;
}

function normalizeState(state: unknown): unknown {
  if (state === undefined || state === null) return {};
  if (typeof state === 'string') {
    return { context: state.slice(0, MAX_STATE_CHARS) };
  }
  // Objects pass through as structured state — but an agent can emit an
  // unbounded blob that overflows the shared ~32k-token request budget
  // (422). Cap the serialized size; an over-limit state degrades to a
  // truncated context string rather than failing the whole judgment.
  try {
    const json = JSON.stringify(state);
    if (json.length > MAX_STATE_CHARS) {
      return { context: `${json.slice(0, MAX_STATE_CHARS)}…[truncated]` };
    }
  } catch {
    return { context: String(state).slice(0, MAX_STATE_CHARS) };
  }
  return state;
}

/** Compact, model-readable rendering of Jev's typed answers. */
export function formatJevAnswers(res: JevResponse): string {
  const lines: string[] = [];
  for (const [id, a] of Object.entries(res.answers)) {
    if (a.type === 'noul') {
      lines.push(`- ${id}: noul ${a.noul.toFixed(2)} (P(yes))`);
    } else if (a.type === 'choice') {
      const probs = a.probabilities
        ? ` | probs: ${Object.entries(a.probabilities).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ')}`
        : '';
      lines.push(`- ${id}: choice "${a.choice}" (confidence ${a.confidence?.toFixed(2) ?? '?'})${probs}`);
    } else {
      const probs = a.probabilities
        ? ` | probs: ${Object.entries(a.probabilities).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ')}`
        : '';
      lines.push(`- ${id}: score ${a.score} (confidence ${a.confidence?.toFixed(2) ?? '?'})${probs}`);
    }
  }
  return lines.join('\n');
}

export interface RunAskJevOpts {
  subject: string;
  projectId?: string;
  missionId?: string;
  timeoutMs?: number;
}

/**
 * Run one ask_jev judgment. Returns a formatted result string for the
 * model to consume — including on failure, where the string states
 * plainly that Jev is unavailable (never a thrown error, never a fake
 * answer).
 */
export async function runAskJev(
  state: unknown,
  questions: readonly AskJevQuestion[] | undefined,
  opts: RunAskJevOpts,
): Promise<string> {
  if (!isJevModeOn()) {
    return '(ask_jev unavailable: Jev mode is off or no TypeSafe key is configured — proceed without it)';
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return '(ask_jev rejected: "questions" must be a non-empty array)';
  }
  if (questions.length > MAX_ASK_JEV_QUESTIONS) {
    return `(ask_jev rejected: too many questions (${questions.length} > ${MAX_ASK_JEV_QUESTIONS}))`;
  }
  for (const q of questions) {
    if (!q || typeof q !== 'object' || typeof q.id !== 'string' || !q.id) {
      return '(ask_jev rejected: every question needs a non-empty string "id")';
    }
    if (q.type !== 'noul' && q.type !== 'choice' && q.type !== 'score') {
      return `(ask_jev rejected: question "${q.id}" has unknown type)`;
    }
    if (typeof q.instructions !== 'string' || !q.instructions) {
      return `(ask_jev rejected: question "${q.id}" needs string "instructions")`;
    }
    if ((q.type === 'choice' || q.type === 'score')
        && (!Array.isArray(q.options) || q.options.length < 2)) {
      return `(ask_jev rejected: question "${q.id}" (${q.type}) needs ≥2 "options")`;
    }
  }

  try {
    const t0 = Date.now();
    const res = await jevAsk(normalizeState(state), toWireQuestions(questions), {
      timeoutMs: opts.timeoutMs ?? ASK_JEV_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - t0;
    emitJevJudgment(res, latencyMs, {
      subject: opts.subject,
      projectId: opts.projectId,
      missionId: opts.missionId,
      applied: true,
    });
    return `Jev answered (${res.model}, ${Math.round(latencyMs)}ms):\n${formatJevAnswers(res)}`;
  } catch (err) {
    const why = err instanceof JevError ? err.message : 'request failed';
    return `(ask_jev unavailable: ${why} — proceed without it)`;
  }
}
