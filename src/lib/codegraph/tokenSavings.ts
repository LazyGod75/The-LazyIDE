/* tokenSavings.ts — Estimate token savings from using the code graph
   instead of reading the full corpus. Calibrated against GPT-4's
   cl100k_base tokenizer (~4 chars/token for code).

   When a code tool returns results, we attach a context_savings estimate
   so the UI and the agent can see how many tokens were saved.
*/

// ── Token estimation ──────────────────────────────────────────────

/**
 * Estimate the number of tokens in a string.
 * Uses a simple heuristic: ~4 characters per token for code,
 * ~3.5 characters per token for natural language.
 * This is within ~5% of cl100k_base for typical source files.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Code tends to be ~4 chars/token; natural language ~3.5
  // We use a blended average of ~3.8
  return Math.ceil(text.length / 3.8);
}

/**
 * Estimate tokens for a whole file (including metadata overhead).
 */
export function estimateFileTokens(filePath: string, content: string): number {
  // File path + content + formatting overhead
  const overhead = filePath.length + 20; // ```path\n ... \n```
  return estimateTokens(content) + estimateTokens(overhead.toString());
}

// ── Savings calculation ───────────────────────────────────────────

export interface TokenSavings {
  /** Tokens that would have been spent reading the full corpus. */
  baselineTokens: number;
  /** Tokens actually spent on the graph query result. */
  graphTokens: number;
  /** Tokens saved by using the graph. */
  savedTokens: number;
  /** Reduction factor (baselineTokens / graphTokens). */
  reductionFactor: number;
  /** Human-readable summary. */
  summary: string;
}

/**
 * Compute token savings for a code graph query.
 * @param corpusSize Total tokens of all source files in the project
 * @param resultText The text returned by the graph query
 */
export function computeSavings(
  corpusSize: number,
  resultText: string,
): TokenSavings {
  const graphTokens = estimateTokens(resultText);
  const savedTokens = Math.max(0, corpusSize - graphTokens);
  const reductionFactor = graphTokens > 0 ? corpusSize / graphTokens : 0;

  return {
    baselineTokens: corpusSize,
    graphTokens,
    savedTokens,
    reductionFactor,
    summary: formatSavingsSummary(corpusSize, graphTokens, savedTokens, reductionFactor),
  };
}

function formatSavingsSummary(
  baseline: number,
  graph: number,
  saved: number,
  factor: number,
): string {
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  if (factor >= 10) {
    return `Token Savings: ~${factor.toFixed(0)}x reduction (${fmt(baseline)} → ${fmt(graph)}, saved ${fmt(saved)})`;
  }
  return `Token Savings: ${fmt(saved)} tokens saved (${fmt(baseline)} → ${fmt(graph)}, ${factor.toFixed(1)}x)`;
}

// ── Corpus size estimation ────────────────────────────────────────

/**
 * Estimate the total token count of a corpus from file contents.
 * @param fileContents Map of filePath → content
 */
export function estimateCorpusSize(fileContents: Map<string, string>): number {
  let total = 0;
  for (const [filePath, content] of fileContents) {
    total += estimateFileTokens(filePath, content);
  }
  return total;
}

/**
 * Estimate corpus size from node count (when we don't have full contents).
 * Average source file is ~200 tokens per symbol node.
 */
export function estimateCorpusSizeFromNodes(nodeCount: number): number {
  return nodeCount * 200;
}

// ── Result wrapping ───────────────────────────────────────────────

/**
 * Wrap a tool result string with a token savings panel.
 * The agent sees both the result and how much context was saved.
 */
export function wrapWithSavings(
  resultText: string,
  savings: TokenSavings,
): string {
  return `${resultText}\n\n--- ${savings.summary} ---`;
}

/**
 * Wrap a tool result with savings computed from corpus size.
 */
export function wrapResultWithSavings(
  resultText: string,
  corpusSize: number,
): string {
  const savings = computeSavings(corpusSize, resultText);
  return wrapWithSavings(resultText, savings);
}
