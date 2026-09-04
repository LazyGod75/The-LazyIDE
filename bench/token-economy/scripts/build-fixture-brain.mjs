#!/usr/bin/env node
/**
 * bench/token-economy/scripts/build-fixture-brain.mjs
 *
 * Builds the isolated, throwaway LazyBrain fixture the harness measures
 * config (b)/(c) against, by running the REAL production CLI
 * (`lazybrain graph --cwd <dir>`, i.e. the actual code-scanner +
 * file-neuron composer) once per corpusDir in questions.json.
 *
 * SAFETY: writes only under the path given as argv[2] (or
 * LAZYBRAIN_FIXTURE_BRAIN). Never touches David's real brain — the target
 * directory is created fresh and LAZYBRAIN_BRAIN_PATH is always set
 * explicitly for the child process, so brain discovery never falls through
 * to a real brain.
 *
 * Also records wall-clock indexing cost (this repo's version of the
 * "construction cost" the design brief asks to report separately) — code
 * scanning is pure AST parsing, zero LLM calls, zero $ cost, which is
 * LazyBrain's actual defence against GraphRAG's ~$33k-per-5GB-corpus LLM
 * extraction bill. That defence is only credible if this number is real,
 * so it's measured here, not asserted.
 *
 * Usage:
 *   node scripts/build-fixture-brain.mjs <targetBrainDir>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');
const ENGINE_DIR = join(REPO_ROOT, 'engine');
const LAZYBRAIN_CLI = join(ENGINE_DIR, 'dist', 'bin', 'lazybrain.js');

function main() {
  const targetDir = process.argv[2] ?? process.env.LAZYBRAIN_FIXTURE_BRAIN;
  if (!targetDir) {
    console.error('Usage: node scripts/build-fixture-brain.mjs <targetBrainDir>');
    process.exit(1);
  }
  if (!existsSync(LAZYBRAIN_CLI)) {
    console.error(`Missing built CLI at ${LAZYBRAIN_CLI} — run "npm run build" in engine/ first.`);
    process.exit(1);
  }
  // Refuse anything that looks like it could be a real brain location.
  if (/Lazy-Brain/i.test(targetDir) || /\.lazybrain$/i.test(targetDir)) {
    console.error(`Refusing target "${targetDir}" — looks like it could be a real brain path.`);
    process.exit(1);
  }

  const qsetPath = join(HERE, 'questions.json');
  const qset = JSON.parse(readFileSync(qsetPath, 'utf-8'));

  mkdirSync(targetDir, { recursive: true });

  const timings = [];
  const t0 = Date.now();
  for (const dir of qset.corpusDirs) {
    const absDir = join(REPO_ROOT, dir);
    const start = Date.now();
    execFileSync(
      process.execPath,
      [LAZYBRAIN_CLI, 'graph', '--cwd', absDir, '--skip-clusters', '--pretty'],
      { env: { ...process.env, LAZYBRAIN_BRAIN_PATH: targetDir }, cwd: ENGINE_DIR, stdio: 'inherit' },
    );
    const ms = Date.now() - start;
    timings.push({ dir, ms });
    console.error(`[fixture] scanned ${dir} in ${ms}ms`);
  }
  const totalMs = Date.now() - t0;

  const report = {
    builtAt: new Date().toISOString(),
    targetDir,
    corpusDirs: qset.corpusDirs,
    totalMs,
    perDirTimings: timings,
    llmCallsUsed: 0,
    dollarCost: 0,
    note:
      'Structural code-scan only (AST parsing via web-tree-sitter, no LLM extraction). ' +
      'This is the number to compare against GraphRAG-style LLM-extraction indexing cost.',
  };
  writeFileSync(join(targetDir, '_fixture-build-report.json'), JSON.stringify(report, null, 2));
  console.error(`[fixture] done in ${totalMs}ms, 0 LLM calls, $0. Report: ${targetDir}/_fixture-build-report.json`);
}

main();
