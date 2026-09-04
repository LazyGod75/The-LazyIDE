/* managerTurnBudget.ts — honest, measurable cost breakdown of one LazyManager
   turn (token-efficiency audit, 2026-08-01).

   Before this module, the ~73k-char static core, the per-turn dynamic
   context, and the (previously unbounded) conversation history all shipped
   to the LLM with no per-component visibility anywhere — the only cost
   signal in the product was managerTurnCost.test.tsx's approxCreditsUsed,
   which is a POST-HOC dollar figure derived from the provider's real usage
   AFTER the call, with no breakdown of what was actually sent. There was no
   way to answer "how many of these chars are the static core vs the
   conversation history vs this turn's dynamic state" without hand-counting.

   measureManagerTurnBudget answers exactly that, from the same strings/
   messages runManagerTurn already builds (managerEngine.ts) — a pure,
   synchronous char count, no network call, no LLM round-trip. Token counts
   are an HONEST ESTIMATE (chars / 4, the same rough conversion this
   codebase already uses elsewhere — see managedProvider.ts's chars/4
   worst-case cost estimate, ai-proxy/index.ts's analogous comment), never
   presented as an exact tokenizer count: this module's own field names say
   `estimatedTokens`, not `tokens`, and its doc comments repeat this so a
   future caller cannot silently start treating it as exact.
*/

import type { ManagerMessage } from './types.js';

/** Rough chars-per-token conversion — matches the SAME estimate already
 *  used elsewhere in this codebase (managedProvider.ts's proxy cost
 *  estimate, ai-proxy/index.ts) rather than inventing a new one. Real
 *  tokenization varies by model/tokenizer; this is a deliberately coarse,
 *  consistently-applied approximation, good enough to compare BEFORE/AFTER
 *  a change (both sides use the same conversion, so the relative delta is
 *  trustworthy even though the absolute number is not exact). */
const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface ManagerTurnBudget {
  /** chars in the static core (managerEngine.ts's buildManagerCorePrompt —
   *  identical every turn, the cache_control-eligible prefix). */
  coreChars: number;
  /** chars in the per-turn dynamic context (buildManagerDynamicContext —
   *  agents/missions/canvas/credits/ECC catalog/etc). */
  dynamicChars: number;
  /** chars in the conversation history actually being sent this turn
   *  (after any windowing — see managerHistoryWindow.ts). Sums every
   *  message's `content`, matching what actually gets serialized into the
   *  `messages` array sent to the provider. */
  historyChars: number;
  /** chars in any grounded tool-result text injected on a follow-up turn
   *  (brain_query/web_search/query_mission results, etc — see
   *  runGroundedFollowUp, agentsStore.tsx). 0 on a plain first turn. */
  toolResultChars: number;
  /** Sum of the four fields above — the real total char count shipped to
   *  the LLM this turn (system + messages combined). */
  totalChars: number;
  /** totalChars / CHARS_PER_TOKEN_ESTIMATE, rounded — an ESTIMATE, not a
   *  real tokenizer count. See this module's header for why. */
  estimatedTokens: number;
}

export interface ManagerTurnBudgetInput {
  /** buildManagerCorePrompt()'s output. */
  core: string;
  /** buildManagerDynamicContext(ctx)'s output. */
  dynamic: string;
  /** The messages actually being sent this turn (post-windowing). */
  messages: readonly ManagerMessage[];
  /** Grounded tool-result text injected this turn, if any (see
   *  ManagerTurnBudget.toolResultChars). */
  toolResultText?: string;
}

/**
 * Measure the real char/estimated-token cost of one manager turn from its
 * already-built pieces. Pure and synchronous — safe to call in a test or
 * (optionally) a dev-only logging hook without any network cost of its
 * own. See this module's header for the coreChars/dynamicChars/
 * historyChars/toolResultChars breakdown's purpose.
 */
export function measureManagerTurnBudget(input: ManagerTurnBudgetInput): ManagerTurnBudget {
  const coreChars = input.core.length;
  const dynamicChars = input.dynamic.length;
  const historyChars = input.messages.reduce((sum, m) => sum + m.content.length, 0);
  const toolResultChars = input.toolResultText?.length ?? 0;
  const totalChars = coreChars + dynamicChars + historyChars + toolResultChars;
  return {
    coreChars,
    dynamicChars,
    historyChars,
    toolResultChars,
    totalChars,
    estimatedTokens: Math.round(totalChars / CHARS_PER_TOKEN_ESTIMATE),
  };
}
