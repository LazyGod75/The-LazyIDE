/* jevJournal.ts — emit the `jev.judgment` journal event.

   One buffered event per Jev call site — the payload deliberately stores
   the compact answers summary, never the raw `state` (which may carry
   user text we don't want duplicated into the journal). Buffered, never
   awaited by callers, and emitBuffered itself never throws — a Jev call
   must never break a flow, and neither must its audit line.
*/

import { emitBuffered } from '../journal/journal.js';
import type { JevJudgmentPayload } from '../journal/eventTypes.js';
import type { JevResponse } from './jevTypes.js';

export interface JevJournalOpts {
  subject: JevJudgmentPayload['subject'];
  projectId?: string;
  missionId?: string;
  /** Did the judgment change the outcome (veto, disambiguation, rerank)? */
  applied?: boolean;
  /** Short human-readable detail for the activity feed. */
  note?: string;
}

export function emitJevJudgment(res: JevResponse, latencyMs: number, opts: JevJournalOpts): void {
  const answers: NonNullable<JevJudgmentPayload['answers']> = {};
  for (const [id, a] of Object.entries(res.answers)) {
    answers[id] = {
      noul: a.type === 'noul' ? a.noul : undefined,
      choice: a.type === 'choice' ? a.choice : undefined,
      score: a.type === 'score' ? a.score : undefined,
      confidence: 'confidence' in a ? a.confidence : undefined,
    };
  }
  emitBuffered({
    type: 'jev.judgment',
    tsMs: Date.now(),
    projectId: opts.projectId ?? '*',
    missionId: opts.missionId,
    actor: 'system',
    payload: {
      subject: opts.subject,
      model: res.model,
      latencyMs: Math.round(latencyMs),
      inputTokens: res.usage?.input_tokens,
      answers,
      applied: opts.applied,
      note: opts.note,
    },
  });
}
