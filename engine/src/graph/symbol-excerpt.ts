/**
 * Cap a source-code excerpt so it stays CSS-selectable and cheap.
 *
 * Measured (bench/token-economy/scripts/coverage-layers.mjs +
 * coverage-proposed.mjs + coverage-caps.mjs, 2026-08-16, 24-question set):
 *   current file-neuron (signature only):  17% coverage ceiling
 *   JSDoc + head 30 / tail 20 of the body: 58% ceiling @ ~291 tokens
 *   linear first-40 of the body only:      42%  (misses `finally` / trail)
 *   file-header dump added on top:         +0 coverage, +~140 tokens
 *
 * Head+tail (not a linear prefix) is what recovers control-flow that lives
 * at the end of a function (`try { … } finally { tree.delete() }`). The
 * preceding JSDoc is what recovers "why" facts that never appear in the
 * signature. Dumping the file header did not buy a single extra question.
 */

export const EXCERPT_HEAD_LINES = 30;
export const EXCERPT_TAIL_LINES = 20;
export const JSDOC_MAX_LINES = 20;

export interface SymbolExcerpt {
  jsdoc: string;
  excerpt: string;
}

/**
 * Take a 1-based [startLine, endLine] slice of `source`, plus the nearest
 * preceding block comment (capped). Body is head+tail capped when longer
 * than HEAD+TAIL lines.
 */
export function excerptFromSource(
  source: string,
  startLine: number,
  endLine: number,
): SymbolExcerpt {
  if (!source || startLine < 1 || endLine < startLine) {
    return { jsdoc: '', excerpt: '' };
  }
  const lines = source.split('\n');
  const jsdoc = extractPrecedingJsdoc(lines, startLine);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  const body = lines.slice(from, to).join('\n');
  return { jsdoc, excerpt: capHeadTail(body, EXCERPT_HEAD_LINES, EXCERPT_TAIL_LINES) };
}

export function capHeadTail(text: string, head: number, tail: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= head + tail) return text;
  return [...lines.slice(0, head), '// …', ...lines.slice(-tail)].join('\n');
}

/**
 * Walk backwards from the line before `startLine` (1-based) through blank
 * lines and collect a single block comment (`/* … *\/`). Line comments are
 * skipped: the 24-q measurement showed JSDoc (not `//`) is what carries the
 * required terms, and pulling every `//` trail inflates tokens without
 * lifting the ceiling.
 */
export function extractPrecedingJsdoc(lines: readonly string[], startLine: number): string {
  let i = startLine - 2;
  while (i >= 0 && /^\s*$/.test(lines[i])) i--;
  if (i < 0 || !lines[i].includes('*/')) return '';
  const end = i;
  while (i >= 0 && !lines[i].includes('/*')) i--;
  if (i < 0) return '';
  const block = lines.slice(i, end + 1);
  if (block.length <= JSDOC_MAX_LINES) return block.join('\n');
  return block.slice(0, JSDOC_MAX_LINES).join('\n');
}

/** Attach jsdoc + excerpt onto any symbol that already has start/end lines. */
export function attachExcerpt<T extends { startLine: number; endLine: number }>(
  source: string,
  symbol: T,
): T & SymbolExcerpt {
  const { jsdoc, excerpt } = excerptFromSource(source, symbol.startLine, symbol.endLine);
  return { ...symbol, jsdoc, excerpt };
}
