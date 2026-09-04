/* lazyReasoningBlocks/tokenSaving.ts — Token-saving middleware.
   Compresses tool outputs and generates early-exit nudges to reduce
   token consumption during agent runs.

   - compressToolOutput: truncates verbose tool outputs with a summary
   - shouldEarlyExit: detects when the agent should stop (task likely done)
   - buildEarlyExitNudge: generates a nudge to finalize

   Inspired by ReasonBlocks' TokenSavingMiddleware, adapted for Lazy's
   tool execution pipeline.
*/

// ── Types ─────────────────────────────────────────────────────────

export interface TokenSavingConfig {
  maxToolOutputChars: number;
  compressionThreshold: number;
  earlyExitStepsThreshold: number;
  earlyExitIdleSteps: number;
}

export const DEFAULT_TOKEN_SAVING_CONFIG: TokenSavingConfig = {
  maxToolOutputChars: 4000,
  compressionThreshold: 2000,
  earlyExitStepsThreshold: 8,
  earlyExitIdleSteps: 3,
};

// ── Tool output compression ───────────────────────────────────────

/**
 * Compress a tool output string if it exceeds the compression threshold.
 * Keeps the first and last portions, replacing the middle with a summary.
 */
export function compressToolOutput(
  output: string,
  config: TokenSavingConfig = DEFAULT_TOKEN_SAVING_CONFIG,
): string {
  if (output.length <= config.maxToolOutputChars) return output;

  const keepChars = Math.floor(config.maxToolOutputChars / 2);
  const head = output.slice(0, keepChars);
  const tail = output.slice(-keepChars);
  const omitted = output.length - config.maxToolOutputChars;
  return `${head}\n\n[... ${omitted} chars omitted by LazyReasoningBlocks token-saving ...]\n\n${tail}`;
}

// ── Early-exit detection ──────────────────────────────────────────

export interface EarlyExitContext {
  step: number;
  recentActions: string[];
  hasFinalAction: boolean;
  consecutiveIdleSteps: number;
  taskCompleted: boolean;
}

export function shouldEarlyExit(ctx: EarlyExitContext, config: TokenSavingConfig = DEFAULT_TOKEN_SAVING_CONFIG): boolean {
  // Already finalized
  if (ctx.hasFinalAction) return false;

  // Enough steps with no recent productive actions
  if (ctx.step >= config.earlyExitStepsThreshold && ctx.consecutiveIdleSteps >= config.earlyExitIdleSteps) {
    return true;
  }

  // Task marked as completed but agent hasn't called FINAL
  if (ctx.taskCompleted && ctx.step >= 3) {
    return true;
  }

  return false;
}

export function buildEarlyExitNudge(): string {
  return 'The task appears complete. If you have verified your changes, call ACTION: FINAL to conclude. Do not continue making unnecessary tool calls.';
}
