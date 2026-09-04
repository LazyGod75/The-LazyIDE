#!/usr/bin/env node
/**
 * coverage-real-fixture.mjs — NO LLM.
 *
 * Reads the REAL regenerated fixture brain from LAZYBRAIN_FIXTURE_BRAIN,
 * queries the CSS symbol excerpt (#fn- / #bind- / #cls- / tldr) for each question,
 * and measures exact groundTruth.requiredTerms coverage + token economy.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSymbolAnchorText, extractFullNoteText, extractTldr, findFileNeuron } from '../lib/lazyFixture.mjs';
import { estimateTokenCount } from '../lib/tokenize.mjs';
import { resolveCorpusDir } from '../lib/corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUESTIONS = JSON.parse(readFileSync(join(HERE, '..', 'questions.json'), 'utf8'));

function hasTerm(hay, term) {
  return Boolean(hay) && hay.toLowerCase().includes(String(term).toLowerCase());
}

function layer(text, terms) {
  const hits = terms.map((t) => hasTerm(text, t));
  const ok = hits.filter(Boolean).length;
  return {
    tokens: estimateTokenCount(text || ''),
    all: terms.length > 0 && ok === terms.length,
    ratio: terms.length ? ok / terms.length : 0,
    missing: terms.filter((t) => !hasTerm(text, t)),
  };
}

function main() {
  const corpusDirs = QUESTIONS.corpusDirs;
  const rows = [];

  for (const q of QUESTIONS.questions) {
    const { file, symbol } = q.lazyTarget;
    const corpusDir = resolveCorpusDir(file, corpusDirs);
    const note = corpusDir ? findFileNeuron(corpusDir, file) : null;
    const terms = q.groundTruth.requiredTerms;

    let leaf = '';
    let leafKind = 'missing';
    let fullNote = '';

    if (note) {
      fullNote = extractFullNoteText(note.html);
      const anchorText = symbol ? extractSymbolAnchorText(note.html, symbol) : null;
      if (anchorText) {
        leaf = anchorText;
        leafKind = 'symbol-anchor';
      } else {
        leaf = extractTldr(note.html);
        leafKind = 'tldr-fallback';
      }
    }

    const cssStats = layer(leaf, terms);
    const fullStats = layer(fullNote, terms);

    rows.push({
      id: q.id,
      category: q.category,
      file,
      symbol: symbol || '(none)',
      leafKind,
      css: cssStats,
      fullNeuron: fullStats,
    });
  }

  const n = rows.length;
  const structural = rows.filter((r) => r.category === 'structural');
  const behavioral = rows.filter((r) => r.category === 'behavioral');

  const summary = {
    css_targeted_leaf: {
      full: rows.filter((r) => r.css.all).length,
      ceil: +(rows.filter((r) => r.css.all).length / n).toFixed(4),
      struct: +(structural.filter((r) => r.css.all).length / structural.length).toFixed(4),
      behav: +(behavioral.filter((r) => r.css.all).length / behavioral.length).toFixed(4),
      meanTokens: Math.round(rows.reduce((s, r) => s + r.css.tokens, 0) / n),
      meanRecall: +(rows.reduce((s, r) => s + r.css.ratio, 0) / n).toFixed(4),
    },
    full_neuron_subtree: {
      full: rows.filter((r) => r.fullNeuron.all).length,
      ceil: +(rows.filter((r) => r.fullNeuron.all).length / n).toFixed(4),
      meanTokens: Math.round(rows.reduce((s, r) => s + r.fullNeuron.tokens, 0) / n),
      meanRecall: +(rows.reduce((s, r) => s + r.fullNeuron.ratio, 0) / n).toFixed(4),
    },
  };

  const outPath = join(HERE, '..', 'results', 'coverage-real-fixture.json');
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));

  console.log('\n======================================================');
  console.log('REAL REGENERATED FIXTURE BRAIN MEASUREMENT (24 QUESTIONS)');
  console.log('======================================================\n');
  const s = summary.css_targeted_leaf;
  console.log(
    `CSS Targeted Leaf (#fn-/#bind-):  full=${s.full}/${n}  ceil=${(s.ceil * 100).toFixed(0)}%  struct=${(s.struct * 100).toFixed(0)}%  behav=${(s.behav * 100).toFixed(0)}%  meanTokens=${s.meanTokens}  meanRecall=${(s.meanRecall * 100).toFixed(0)}%`,
  );
  const fn = summary.full_neuron_subtree;
  console.log(
    `Full File-Neuron Note:          full=${fn.full}/${n}  ceil=${(fn.ceil * 100).toFixed(0)}%  meanTokens=${fn.meanTokens}  meanRecall=${(fn.meanRecall * 100).toFixed(0)}%`,
  );
  console.log('\nPer-question detail:');
  for (const r of rows) {
    console.log(
      `${r.id} ${r.category.padEnd(11)} ${r.symbol.padEnd(26)} kind=${r.leafKind.padEnd(14)} all=${String(r.css.all).padEnd(5)} tok=${String(r.css.tokens).padStart(4)} miss=${r.css.missing.join('|') || '-'}`,
    );
  }
  console.log('\nWrote report to:', outPath);
}

main();
