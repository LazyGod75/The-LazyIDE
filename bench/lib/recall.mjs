/**
 * bench/lib/recall.mjs
 * Memory recall benchmark engine.
 *
 * Two modes:
 *   1. fixture  — pure in-process, fully deterministic (default)
 *   2. live     — calls `lazybrain search` CLI (opt-in via BENCH_LIVE=1)
 *
 * Metrics produced:
 *   - precision@k  : fraction of top-k results that are expected
 *   - recall@k     : fraction of expected results found in top-k
 *   - latencyMs    : wall-clock time for the search
 *   - tokenSavings : estimated tokens saved (injected context chars vs full-doc baseline)
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dir, '../fixtures/memory-recall.json');

// Approximate tokens from character count (rough GPT/Claude heuristic: 4 chars per token)
function charsToTokens(chars) {
  return Math.ceil(chars / 4);
}

function bodyLength(node) {
  return (node.body ?? '').length + (node.title ?? '').length + (node.tags ?? []).join(' ').length;
}

/**
 * TF-IDF + cosine similarity scorer.
 * Downweights terms that appear in many nodes (low IDF),
 * upweights distinctive terms. Weighted fields: title (3x), tags (2x), body (1x).
 * Returns ranked list of { id, score } for a query string.
 */
function tokenize(text) {
  return text.toLowerCase().split(/[\s,.\-;:!?'"`/]+/).filter(Boolean);
}

function buildTfIdfModel(index) {
  const N = index.length;
  const docTokens = index.map((node) => {
    const titleTokens = tokenize(node.title ?? '');
    const topicTokens = tokenize(node.topic ?? '');
    const tagTokens = tokenize((node.tags ?? []).join(' '));
    const bodyTokens = tokenize(node.body ?? '');
    // Weighted token bag: title x3, tags x2, topic x2, body x1
    return [
      ...titleTokens, ...titleTokens, ...titleTokens,
      ...tagTokens, ...tagTokens,
      ...topicTokens, ...topicTokens,
      ...bodyTokens,
    ];
  });

  // Document frequency per term
  const df = new Map();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // IDF: log(N / df). Terms in all docs get ~0, unique terms get high weight.
  const idf = new Map();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N + 1) / (freq + 1)) + 1); // +1 smoothing
  }

  // TF-IDF vectors per document
  const docVectors = docTokens.map((tokens) => {
    const tf = new Map();
    for (const term of tokens) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }
    const vec = new Map();
    let norm = 0;
    for (const [term, freq] of tf) {
      const weight = freq * (idf.get(term) ?? 0);
      vec.set(term, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    // Normalize
    for (const [term, weight] of vec) {
      vec.set(term, weight / norm);
    }
    return vec;
  });

  return { docVectors, idf, N };
}

function cosineSim(queryVec, docVec) {
  let dot = 0;
  for (const [term, qWeight] of queryVec) {
    const dWeight = docVec.get(term);
    if (dWeight !== undefined) {
      dot += qWeight * dWeight;
    }
  }
  return dot;
}

function fixtureSearch(query, index, topK, model) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const { idf } = model;

  // Build query TF-IDF vector
  const queryTf = new Map();
  for (const term of terms) {
    queryTf.set(term, (queryTf.get(term) ?? 0) + 1);
  }
  const queryVec = new Map();
  let queryNorm = 0;
  for (const [term, freq] of queryTf) {
    const weight = freq * (idf.get(term) ?? 0);
    queryVec.set(term, weight);
    queryNorm += weight * weight;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;
  for (const [term, weight] of queryVec) {
    queryVec.set(term, weight / queryNorm);
  }

  const scored = index.map((node, i) => ({
    id: node.id,
    score: cosineSim(queryVec, model.docVectors[i]),
  }));

  return scored
    .filter((s) => s.score > 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Live-mode: calls lazybrain CLI.
 * Returns array of { id } from parsed output (best-effort).
 */
function liveSearch(query, topK) {
  const cmd = `lazybrain search "${query.replace(/"/g, '\\"')}" --json`;
  const raw = execSync(cmd, { timeout: 10_000, encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  const results = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
  return results.slice(0, topK).map((r) => ({ id: r.id ?? r.nodeId ?? r.node_id ?? '' }));
}

/**
 * Compute precision@k and recall@k.
 */
function computeMetrics(resultIds, expectedIds) {
  const resultSet = new Set(resultIds);
  const expectedSet = new Set(expectedIds);

  const hits = resultIds.filter((id) => expectedSet.has(id)).length;
  const precisionAtK = resultIds.length > 0 ? hits / resultIds.length : 0;
  const recallAtK = expectedIds.length > 0 ? hits / expectedIds.length : 0;

  // MRR: 1/rank of first relevant result (0 if none)
  let reciprocalRank = 0;
  for (let i = 0; i < resultIds.length; i++) {
    if (expectedSet.has(resultIds[i])) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  // precision@1: is the top result relevant?
  const precisionAt1 = resultIds.length > 0 && expectedSet.has(resultIds[0]) ? 1 : 0;

  return { precisionAtK, recallAtK, hits, reciprocalRank, precisionAt1 };
}

/**
 * Estimate token savings for this query result set.
 *
 * Baseline: inject the entire corpus into context (all docs concatenated).
 * Actual: inject only the top-k retrieved docs.
 * Savings = baseline tokens - actual tokens.
 */
function estimateTokenSavings(retrievedNodes, allNodes) {
  const baselineChars = allNodes.reduce((sum, n) => sum + bodyLength(n), 0);
  const injectedChars = retrievedNodes.reduce((sum, n) => sum + bodyLength(n), 0);
  const baselineTokens = charsToTokens(baselineChars);
  const injectedTokens = charsToTokens(injectedChars);
  return {
    baselineTokens,
    injectedTokens,
    savedTokens: Math.max(0, baselineTokens - injectedTokens),
    savingsPercent: baselineTokens > 0
      ? Math.round(((baselineTokens - injectedTokens) / baselineTokens) * 100)
      : 0,
  };
}

/**
 * Run the full recall benchmark.
 * @param {object} opts
 * @param {boolean} opts.live    - use real CLI (default false)
 * @param {number}  opts.topK   - k for precision/recall (default 3)
 * @returns {RecallBenchResult}
 */
export async function runRecallBench({ live = false, topK = 3 } = {}) {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const { index, queries } = fixture;

  const mode = live ? 'live' : 'fixture';
  const queryResults = [];
  let cliAvailable = true;

  if (live) {
    try {
      execSync('lazybrain --version', { timeout: 5_000, stdio: 'pipe' });
    } catch {
      cliAvailable = false;
    }
  }

  const effectiveLive = live && cliAvailable;
  const tfidfModel = buildTfIdfModel(index);

  for (const q of queries) {
    const t0 = Date.now();

    let ranked;
    if (effectiveLive) {
      try {
        ranked = liveSearch(q.query, topK);
      } catch {
        ranked = fixtureSearch(q.query, index, topK, tfidfModel);
      }
    } else {
      ranked = fixtureSearch(q.query, index, topK, tfidfModel);
    }

    const latencyMs = Date.now() - t0;
    const resultIds = ranked.map((r) => r.id);
    const metrics = computeMetrics(resultIds, q.expectedIds);

    // Get the actual node objects for token saving estimation
    const nodeById = Object.fromEntries(index.map((n) => [n.id, n]));
    const retrievedNodes = resultIds.map((id) => nodeById[id]).filter(Boolean);
    const tokenSavings = estimateTokenSavings(retrievedNodes, index);

    queryResults.push({
      query: q.query,
      expectedIds: q.expectedIds,
      resultIds,
      latencyMs,
      ...metrics,
      ...tokenSavings,
    });
  }

  const avgPrecision = queryResults.reduce((s, r) => s + r.precisionAtK, 0) / queryResults.length;
  const avgRecall = queryResults.reduce((s, r) => s + r.recallAtK, 0) / queryResults.length;
  const avgLatencyMs = queryResults.reduce((s, r) => s + r.latencyMs, 0) / queryResults.length;
  const totalSavedTokens = queryResults.reduce((s, r) => s + r.savedTokens, 0);
  const avgSavingsPercent = queryResults.reduce((s, r) => s + r.savingsPercent, 0) / queryResults.length;
  const avgMRR = queryResults.reduce((s, r) => s + r.reciprocalRank, 0) / queryResults.length;
  const avgPrecisionAt1 = queryResults.reduce((s, r) => s + r.precisionAt1, 0) / queryResults.length;

  return {
    bench: 'memory-recall',
    mode: effectiveLive ? 'live' : mode,
    cliAvailable,
    topK,
    queryCount: queryResults.length,
    avgPrecisionAtK: round2(avgPrecision),
    avgRecallAtK: round2(avgRecall),
    avgPrecisionAt1: round2(avgPrecisionAt1),
    avgMRR: round2(avgMRR),
    avgLatencyMs: round2(avgLatencyMs),
    totalSavedTokens,
    avgSavingsPercent: Math.round(avgSavingsPercent),
    queries: queryResults.map((r) => ({
      ...r,
      precisionAtK: round2(r.precisionAtK),
      recallAtK: round2(r.recallAtK),
      savingsPercent: Math.round(r.savingsPercent),
    })),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
