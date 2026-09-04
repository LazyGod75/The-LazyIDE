/**
 * Config (d) — raw grep + read of the codebase: extract salient
 * identifier-like terms from the question, grep the corpus for literal
 * (case-insensitive) matches, read the top-hit files WHOLE (verbatim, no
 * chunking, no ranking beyond "which files matched the most"), truncating
 * only if the token budget is exceeded.
 *
 * This models what an agent with only grep+read tools (no RAG index, no
 * brain) would actually do: search for the words in the question, then read
 * entire files that come up.
 */

import { listCorpusFiles, readFileSafe } from '../corpus.mjs';
import { estimateTokenCount } from '../tokenize.mjs';

/**
 * Extract identifier-like salient terms from a question: camelCase /
 * PascalCase words, SCREAMING_SNAKE_CASE constants, and backtick/quoted
 * spans — the kind of thing a developer would literally grep for.
 */
export function extractSalientTerms(question) {
  const terms = new Set();
  const backtickOrQuoted = question.match(/`([^`]+)`|'([^']{3,})'/g) ?? [];
  for (const m of backtickOrQuoted) {
    const clean = m.replace(/[`']/g, '').trim();
    if (clean) terms.add(clean.split(/[\s(),]/)[0]);
  }
  const identifierLike = question.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  for (const id of identifierLike) {
    const isCamel = /[a-z][A-Z]/.test(id) && id.length >= 4;
    const isPascal = /^[A-Z][a-z]+[A-Z]/.test(id);
    const isScreaming = /^[A-Z][A-Z0-9_]{3,}$/.test(id) && id.includes('_');
    const isDotted = id.includes('.');
    if (isCamel || isPascal || isScreaming || isDotted) terms.add(id);
  }
  return [...terms];
}

export const CONFIG_ID = 'grep_read';

/**
 * @param {number} tokenBudget max tokens of file content to inject.
 */
export function run(question, corpusDirs, tokenBudget = 4000) {
  const terms = extractSalientTerms(question.question);
  const files = listCorpusFiles(corpusDirs);

  const hits = [];
  for (const f of files) {
    const text = readFileSafe(f.absPath);
    if (!text) continue;
    const lower = text.toLowerCase();
    let hitCount = 0;
    for (const term of terms) {
      const t = term.toLowerCase();
      if (t.length < 3) continue;
      hitCount += lower.split(t).length - 1;
    }
    if (hitCount > 0) hits.push({ relPath: f.relPath, absPath: f.absPath, hitCount, text });
  }
  hits.sort((a, b) => b.hitCount - a.hitCount);

  const picked = [];
  let tokensUsed = 0;
  for (const h of hits) {
    const full = `--- ${h.relPath} (grep hits: ${h.hitCount}) ---\n${h.text}`;
    const t = estimateTokenCount(full);
    if (tokensUsed >= tokenBudget) break;
    if (tokensUsed + t > tokenBudget) {
      // Truncate the last file to fit the remaining budget rather than
      // dropping it — a grep+read agent would at least skim what fits.
      const remainingChars = Math.max(0, Math.floor((tokenBudget - tokensUsed) / 0.33));
      picked.push(`${full.slice(0, remainingChars)}\n... [truncated]`);
      tokensUsed = tokenBudget;
      break;
    }
    picked.push(full);
    tokensUsed += t;
  }

  const contextText = picked.join('\n\n');
  return {
    configId: CONFIG_ID,
    contextText,
    tokenCount: estimateTokenCount(contextText),
    meta: { tokenBudget, terms, filesMatched: hits.length, filesPicked: picked.length },
  };
}
