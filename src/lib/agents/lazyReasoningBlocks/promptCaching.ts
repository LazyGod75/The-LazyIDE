/* lazyReasoningBlocks/promptCaching.ts — Prompt caching marker (RETIRED).

   withPromptCaching used to append a literal "[CACHE_BREAKPOINT]" text
   marker to a mission's per-step system prompt, on the claim that "the
   managed provider (managedProvider.ts) will parse this and add the actual
   cache_control block" — that claim was never true: managedProvider.ts (nor
   anything else in the codebase) ever reads or strips "[CACHE_BREAKPOINT]".
   The marker was sent to the LLM as ordinary visible text on every single
   mission step (steering.ts's applyPromptCaching -> managedAgent.ts's
   lrSystemPrompt -> streamAgentTurn's `system`), costing tokens and prompt
   clarity for zero actual caching benefit — dead code masquerading as a
   working feature (chantier 2 integration audit, 2026-07-28).

   The REAL, working prompt-cache split lives in managedProvider.ts's
   `cacheableSystem` (core/dynamic two-block `cache_control: ephemeral`
   wiring, wired for LazyManager's own turn via managerEngine.ts's
   runManagerTurn) — see resolveProxySystemField/buildCacheableSystemBlocks
   there. That mechanism does not (yet) extend to a mission's per-step
   worker system prompt, which is a single flat string with no core/dynamic
   split to hand it — this module is kept (same exported signatures) as the
   place a real block-based wiring for missions would go, rather than
   deleted outright, but it is a no-op today: appending an inert marker only
   the model would ever see, and nothing would ever consume, is strictly
   worse than doing nothing.
*/

// ── Types ─────────────────────────────────────────────────────────

export interface CacheControlBlock {
  type: 'cache_control';
  cache_type: 'ephemeral';
}

export interface CacheableMessage {
  role: 'system';
  content: string;
  cache_control?: CacheControlBlock;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Check if a model ID is an Anthropic model that supports prompt caching.
 */
export function isCachingSupportedModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('claude') || lower.includes('anthropic') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku');
}

/**
 * NO-OP today — see this module's header for why. Kept as a distinct,
 * stable-signature function (rather than removed) so a real, working
 * cache_control wiring for a mission's per-step prompt can be added here
 * later without touching either call site (steering.ts's
 * SteeringPipeline.applyPromptCaching, managedAgent.ts's lrSystemPrompt).
 */
export function withPromptCaching(systemPrompt: string, _model: string): string {
  return systemPrompt;
}

/**
 * Always false now that withPromptCaching no longer appends the retired
 * "[CACHE_BREAKPOINT]" marker (see this module's header) — still does a
 * literal substring check, so it would still recognize the marker in text
 * that genuinely contains it (e.g. a pre-existing persisted prompt), it
 * just never gets produced by this module anymore.
 */
export function hasCacheBreakpoint(systemPrompt: string): boolean {
  return systemPrompt.includes('[CACHE_BREAKPOINT]');
}
