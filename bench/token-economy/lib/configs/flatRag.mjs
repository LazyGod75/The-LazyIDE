/**
 * Config (a) — flat chunked RAG over the raw repo (no LazyBrain structure at
 * all): fixed-size line windows, ranked by keyword/BM25-lite overlap with
 * the question, greedily packed into a token budget.
 *
 * Deliberately simple/generic (no embeddings, no LLM) — the point of this
 * baseline is "chunk raw source and keyword-rank it", the thing an
 * off-the-shelf RAG pipeline would do without any codebase-aware structure.
 */

import { listCorpusFiles, readFileSafe } from '../corpus.mjs';
import { estimateTokenCount } from '../tokenize.mjs';

const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'what', 'which',
  'does', 'did', 'was', 'were', 'this', 'that', 'for', 'on', 'by', 'with',
  'how', 'when', 'why', 'its', 'be', 'at', 'as', 'from', 'now', 'after',
]);

function tokenizeQuery(text) {
  const raw = text.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? [];
  return raw.filter((t) => !STOPWORDS.has(t));
}

function chunkFile(relPath, text) {
  const lines = text.split('\n');
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const body = lines.slice(start, end).join('\n');
    if (body.trim().length === 0) continue;
    chunks.push({ relPath, startLine: start + 1, endLine: end, body });
    if (end >= lines.length) break;
  }
  return chunks;
}

function scoreChunk(chunk, queryTokens) {
  const lower = chunk.body.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    const occurrences = lower.split(tok).length - 1;
    score += occurrences;
  }
  return score;
}

export const CONFIG_ID = 'flat_rag';

/**
 * @param {number} tokenBudget max tokens of chunk content to inject.
 */
export function run(question, corpusDirs, tokenBudget = 1500) {
  const files = listCorpusFiles(corpusDirs);
  const queryTokens = tokenizeQuery(question.question);

  const allChunks = [];
  for (const f of files) {
    const text = readFileSafe(f.absPath);
    if (!text) continue;
    for (const c of chunkFile(f.relPath, text)) allChunks.push(c);
  }

  const scored = allChunks
    .map((c) => ({ ...c, score: scoreChunk(c, queryTokens) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let tokensUsed = 0;
  for (const c of scored) {
    const chunkText = `--- ${c.relPath}:${c.startLine}-${c.endLine} ---\n${c.body}`;
    const t = estimateTokenCount(chunkText);
    if (tokensUsed + t > tokenBudget && picked.length > 0) continue;
    picked.push(chunkText);
    tokensUsed += t;
    if (tokensUsed >= tokenBudget) break;
  }

  const contextText = picked.join('\n\n');
  return {
    configId: CONFIG_ID,
    contextText,
    tokenCount: estimateTokenCount(contextText),
    meta: { tokenBudget, chunksConsidered: allChunks.length, chunksPicked: picked.length, queryTokens },
  };
}
