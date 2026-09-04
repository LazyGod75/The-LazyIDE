/* messageHistory — bounds the conversation history SENT to a model provider.

   The UI keeps showing the full conversation (assistantStore's state.messages
   is never trimmed) — this only caps the copy that goes out over the wire, so
   a long-running chat doesn't keep growing the request payload (token cost +
   memory) without limit on every turn, and on every ReAct round within a
   turn (assistantToolLoop.ts seeds its own working copy from the same
   already-capped array).

   The system prompt itself is NEVER part of this array — it is built
   separately by systemPrompts.ts and injected by each provider on top of
   whatever this returns.
*/

/** Maximum number of messages sent to a provider per request. */
export const MAX_SENT_MESSAGES = 40;

/**
 * Keeps at most `max` messages: the very first one (mirrors managedAgent.ts's
 * `[messages[0], ...messages.slice(1)]` convention for anchoring the
 * conversation's opening turn) plus the most recent `max - 1` entries — so a
 * long conversation never loses the original request/context entirely, only
 * the middle. A no-op (returns a shallow copy) when already within budget.
 */
export function capMessageHistory<T>(messages: readonly T[], max: number = MAX_SENT_MESSAGES): T[] {
  if (messages.length <= max) return [...messages];
  if (max <= 0) return [];
  if (max === 1) return [messages[0]];
  return [messages[0], ...messages.slice(-(max - 1))];
}
