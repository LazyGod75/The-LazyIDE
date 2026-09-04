/* tokenFormat.ts — B4: dedup of the "short token count" formatter.
   Three identical copies of this exact toFixed(1) formatting existed:
   BrainBanner.tsx's formatTokensSaved, cockpit/KpiGroup.tsx's
   formatTokensShort, and lib/agents/brainCitations.ts's formatTokenCount.
   Consolidated here — the shared home lives in lib/agents/ so both
   components/ (BrainBanner.tsx, KpiGroup.tsx) and lib/ (brainCitations.ts)
   call sites can import it without inverting the app's components -> lib
   dependency direction (see brainCitations.ts's former doc comment, which
   explained the duplication for exactly that reason).

   Deliberately NOT touching components/metrics/utils.ts's formatTokens or
   codegraph/tokenSavings.ts's own inline formatter — both have diverged
   from this shape and from each other, and harmonizing them is a product
   decision, not a mechanical dedup (see B4 mission scope).
*/

/**
 * Formats a token count as a short human-readable label: "500", "1.5k",
 * "2.4M". Rounds fractional inputs before falling through to the plain
 * `String()` branch (matches brainCitations.ts's former Math.round — a
 * no-op for the integer counts every current call site passes, kept for
 * safety since a fractional input is otherwise a plausible caller mistake).
 */
export function formatTokenCountShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
