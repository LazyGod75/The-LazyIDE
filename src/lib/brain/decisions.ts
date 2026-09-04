/* decisions.ts — Decision registry with auto-answer (spec §6).

   When a mission asks a question (mission.question event), we first search
   the brain for an existing decision neuron that matches. If found
   (similarity ≥ 0.75), the decision's answer is returned automatically — no
   human inbox round-trip.

   When a human answers a question (via the Attention Inbox's answer flow —
   see AttentionInbox.tsx), we capture the Q/A pair as a typed `decision`
   neuron so future similar questions are auto-answered.

   Caller wiring (T3.2 fix): the question-detection + pre-answer lookup lives
   in AttentionInbox.tsx's refresh cycle, which calls lookupDecision on the
   REAL blocked-agent question text extracted from a running mission's
   actionTimeline (the `ask_user` tool's observation — see toolRuntime.ts's
   'ask_user' case). This module used to also be invoked from
   managerEngine.ts's runManagerTurn on every user chat message, which was
   wrong (a decision registry answers questions a MISSION asked, not
   arbitrary chat) and has been removed there — see managerEngine.ts's doc
   comment at the removal site.

   Events emitted:
   - brain.decision_created: when a new decision neuron is captured
   - brain.decision_hit: when an existing decision auto-answers a question
*/

import { getPlatform } from '../platform/index.js';
import type { CaptureEvent } from '../platform/types.js';
import { emitBuffered } from '../journal/journal.js';

const DECISION_SIMILARITY_THRESHOLD = 0.75;

export interface DecisionLookupResult {
  found: boolean;
  answer?: string;
  decisionId?: string;
  rationale?: string;
}

/**
 * Search the project brain for a decision neuron matching the question.
   Uses semantic search (brain.recall) and checks for decision-type hits
   with score ≥ threshold.
*/
export async function lookupDecision(question: string): Promise<DecisionLookupResult> {
  const trimmed = question.trim();
  if (!trimmed) return { found: false };

  try {
    const recall = await getPlatform().brain.recallScoped(trimmed, 'current');
    if (!recall.nodes || recall.nodes.length === 0) return { found: false };

    // Look for decision-type neurons above the similarity threshold
    for (const node of recall.nodes) {
      if (node.score >= DECISION_SIMILARITY_THRESHOLD) {
        // The snippet contains the answer text from the decision neuron
        const answer = node.snippet || '';
        if (answer) {
          emitBuffered({
            tsMs: Date.now(),
            projectId: 'current',
            actor: 'system',
            type: 'brain.decision_hit',
            payload: {
              decisionId: node.id,
              question: trimmed,
            },
          });
          return {
            found: true,
            answer,
            decisionId: node.id,
          };
        }
      }
    }

    return { found: false };
  } catch {
    return { found: false };
  }
}

export interface CreateDecisionInput {
  question: string;
  answer: string;
  rationale?: string;
  /**
   * Whether this decision stays local to the current project brain
   * ('project', the default — a Q/A pair is usually contextual to one
   * codebase) or is eligible for later team/org promotion ('org', consumed
   * by T3.3/T4.5's consolidation pipeline — not implemented yet). Recorded
   * as a `scope:<value>` tag on the captured neuron so that later pipeline
   * can filter without needing a schema change here.
   */
  scope?: 'project' | 'org';
}

/**
 * Capture a Q/A pair as a decision neuron in the project brain.
   Called when a human answers a mission question via the Attention Inbox.
*/
export async function createDecision(input: CreateDecisionInput): Promise<string | null> {
  const trimmedQ = input.question.trim();
  const trimmedA = input.answer.trim();
  if (!trimmedQ || !trimmedA) return null;

  const scope = input.scope ?? 'project';
  const title = trimmedQ.slice(0, 80);
  const textParts = [
    `Q: ${trimmedQ.slice(0, 400)}`,
    `A: ${trimmedA.slice(0, 600)}`,
  ];
  if (input.rationale) textParts.push(`Rationale: ${input.rationale.slice(0, 300)}`);

  const event: CaptureEvent = {
    kind: 'decision',
    title,
    text: textParts.join('\n\n'),
    tags: ['decision', 'auto-registry', `scope:${scope}`],
    source: 'lazy-ide:decision-registry',
  };

  try {
    const result = await getPlatform().brain.capture(event);
    const neuronId = result?.id ?? null;

    emitBuffered({
      tsMs: Date.now(),
      projectId: 'current',
      actor: 'user',
      type: 'brain.decision_created',
      payload: {
        question: trimmedQ,
        answer: trimmedA,
      },
    });

    return neuronId;
  } catch {
    return null;
  }
}

/**
 * Try to auto-answer a question. If a matching decision is found,
   return the answer. Otherwise return null (question should be
   surfaced to the human inbox).
*/
export async function tryAutoAnswer(question: string): Promise<string | null> {
  const result = await lookupDecision(question);
  if (result.found && result.answer) {
    return result.answer;
  }
  return null;
}
