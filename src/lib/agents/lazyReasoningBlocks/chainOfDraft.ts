/* lazyReasoningBlocks/chainOfDraft.ts — Chain-of-Draft reasoning directive.
   Appends a concise reasoning directive to the system prompt, asking the
   agent to produce ≤5-word intermediate reasoning steps instead of verbose
   chain-of-thought.

   Inspired by ReasonBlocks' Chain-of-Draft, adapted for Lazy's ReAct loop.
   The directive is appended to the system prompt as a [LAZYREASONING] block.
*/

export const CHAIN_OF_DRAFT_DIRECTIVE = `[LAZYREASONING] Reasoning style: Chain-of-Draft. Keep each intermediate reasoning step to at most 5 words. Be concise and direct. Do not write verbose explanations between THOUGHT and ACTION.`;

export function buildChainOfDraftBlock(): string {
  return CHAIN_OF_DRAFT_DIRECTIVE;
}
