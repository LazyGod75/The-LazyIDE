#!/usr/bin/env node
/**
 * bench/token-economy/report.mjs — aggregates results/raw/*.json into:
 *   - accuracy-vs-tokens curve (one point per variant: accuracy, mean
 *     injected tokens, n)
 *   - tokens-per-correct-answer, but ONLY for variants clearing
 *     CORRECTNESS_FLOOR (default 0.8) — so "fewer tokens" cannot win by
 *     being wrong more often.
 *   - per-question breakdown (which variant got which question right)
 *
 * Reads every file under results/raw/ that matches the given question ids
 * (or all of them) — does not re-run anything.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RAW_DIR = join(HERE, 'results', 'raw');
const CORRECTNESS_FLOOR = Number(process.env.TOKEN_ECON_FLOOR ?? 0.8);

function loadRawResults() {
  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(readFileSync(join(RAW_DIR, f), 'utf-8')));
}

function summarize(records) {
  const byVariant = new Map();
  for (const r of records) {
    if (!byVariant.has(r.variantId)) byVariant.set(r.variantId, []);
    byVariant.get(r.variantId).push(r);
  }

  const curve = [];
  for (const [variantId, rows] of byVariant) {
    const n = rows.length;
    const correct = rows.filter((r) => r.correct === true).length;
    const accuracy = n > 0 ? correct / n : 0;
    const meanTokens = rows.reduce((s, r) => s + (r.injectedTokens ?? 0), 0) / n;
    const totalTokens = rows.reduce((s, r) => s + (r.injectedTokens ?? 0), 0);
    const configId = rows[0].configId;
    const budget = rows[0].budget;
    curve.push({ variantId, configId, budget, n, correct, accuracy, meanInjectedTokens: Math.round(meanTokens) });
  }
  curve.sort((a, b) => a.configId.localeCompare(b.configId) || (a.budget ?? 0) - (b.budget ?? 0));

  const tokensPerCorrect = curve
    .filter((c) => c.accuracy >= CORRECTNESS_FLOOR && c.correct > 0)
    .map((c) => {
      const rows = byVariant.get(c.variantId);
      const totalTokens = rows.reduce((s, r) => s + (r.injectedTokens ?? 0), 0);
      return {
        variantId: c.variantId,
        accuracy: c.accuracy,
        correct: c.correct,
        n: c.n,
        totalInjectedTokens: totalTokens,
        tokensPerCorrectAnswer: Math.round(totalTokens / c.correct),
      };
    })
    .sort((a, b) => a.tokensPerCorrectAnswer - b.tokensPerCorrectAnswer);

  const perQuestion = {};
  for (const r of records) {
    if (!perQuestion[r.questionId]) perQuestion[r.questionId] = { category: r.category, variants: {} };
    perQuestion[r.questionId].variants[r.variantId] = {
      correct: r.correct,
      tokens: r.injectedTokens,
      error: r.error ?? null,
    };
  }

  const byCategoryAccuracy = {};
  for (const cat of ['structural', 'behavioral']) {
    const rows = records.filter((r) => r.category === cat);
    const byV = new Map();
    for (const r of rows) {
      if (!byV.has(r.variantId)) byV.set(r.variantId, []);
      byV.get(r.variantId).push(r);
    }
    byCategoryAccuracy[cat] = [...byV.entries()].map(([variantId, rs]) => ({
      variantId,
      n: rs.length,
      accuracy: rs.filter((r) => r.correct === true).length / rs.length,
    }));
  }

  return {
    generatedAt: new Date().toISOString(),
    correctnessFloor: CORRECTNESS_FLOOR,
    recordCount: records.length,
    accuracyVsTokensCurve: curve,
    tokensPerCorrectAnswer: tokensPerCorrect,
    tokensPerCorrectAnswer_note:
      'Only variants with accuracy >= correctnessFloor are ranked here — a config cannot win by being wrong more often.',
    byCategoryAccuracy,
    perQuestion,
  };
}

function main() {
  const records = loadRawResults();
  if (records.length === 0) {
    console.error('No raw results found under results/raw/. Run run.mjs first.');
    process.exit(1);
  }
  const summary = summarize(records);
  writeFileSync(join(HERE, 'results', 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\nAccuracy-vs-tokens curve (${records.length} raw records):\n`);
  for (const c of summary.accuracyVsTokensCurve) {
    console.log(
      `  ${c.variantId.padEnd(22)} n=${c.n}  correct=${c.correct}/${c.n}  acc=${(c.accuracy * 100).toFixed(0)}%  meanInjectedTokens=${c.meanInjectedTokens}`,
    );
  }
  console.log(`\nTokens-per-correct-answer (only variants with accuracy >= ${CORRECTNESS_FLOOR * 100}%):\n`);
  if (summary.tokensPerCorrectAnswer.length === 0) {
    console.log('  (none cleared the correctness floor)');
  }
  for (const t of summary.tokensPerCorrectAnswer) {
    console.log(
      `  ${t.variantId.padEnd(22)} acc=${(t.accuracy * 100).toFixed(0)}%  tokensPerCorrect=${t.tokensPerCorrectAnswer}`,
    );
  }
  console.log(`\nWritten to results/summary.json`);
}

main();
