/**
 * lib/tokenize.mjs — token estimator.
 *
 * Deliberately mirrors engine/src/util/tokenize.ts's estimateTokenCount()
 * byte-for-byte (same heuristic: 0.25 tokens/char for prose, 0.33 for
 * code-heavy text where >30% of characters are non-alphanumeric). This is
 * the SAME estimator LazyBrain's own "1.7x fewer tokens" figure is computed
 * with, so using it here keeps the token-economy comparison apples-to-apples
 * with LazyBrain's existing claims instead of introducing a second, silently
 * different yardstick.
 *
 * It is still an estimate, not a real BPE tokenizer — see report.mjs for the
 * secondary usage.input_tokens cross-check taken from the real `claude -p`
 * call, which reflects actual Claude tokenization of the full prompt.
 */

export function estimateTokenCount(text) {
  if (!text) return 0;
  const nonAlpha = text.replace(/[a-zA-Z0-9\s]/g, '').length;
  const ratio = text.length > 0 ? nonAlpha / text.length : 0;
  const tokensPerChar = ratio > 0.3 ? 0.33 : 0.25;
  return Math.ceil(text.length * tokensPerChar);
}
