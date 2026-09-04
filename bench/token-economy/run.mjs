#!/usr/bin/env node
/**
 * bench/token-economy/run.mjs — the token-economy benchmark harness.
 *
 * Measures tokens-injected-per-correctly-answered-question across four
 * retrieval configurations, holding the question set, answering model, and
 * prompt template fixed (see README-FIXTURE.txt for the full design and how
 * to reproduce the fixture brain).
 *
 * Usage:
 *   node run.mjs --ids q01,q03,q06 --configs lazy_targeted,grep_read
 *   node run.mjs --all                       # full 24-question run
 *   node run.mjs --ids q01 --dry-run          # build contexts, skip the LLM call
 *
 * Requires LAZYBRAIN_FIXTURE_BRAIN set to the isolated fixture brain (never
 * David's real brain — see lib/lazyFixture.mjs, which throws if unset).
 *
 * Writes one raw JSON result per (question, config) under results/raw/.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { run as runLazyTargeted } from './lib/configs/lazyTargeted.mjs';
import { run as runLazyFullSubtree } from './lib/configs/lazyFullSubtree.mjs';
import { run as runFlatRag } from './lib/configs/flatRag.mjs';
import { run as runGrepRead } from './lib/configs/grepRead.mjs';
import { run as runLazyProductSearch } from './lib/configs/lazyProductSearch.mjs';
import { callAnswerModel, ANSWER_MODEL } from './lib/answerModel.mjs';
import { gradeKeywordMatch } from './lib/grader.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const QUESTIONS_PATH = join(HERE, 'questions.json');
const RESULTS_RAW_DIR = join(HERE, 'results', 'raw');

const CONFIGS = {
  lazy_targeted: { fn: runLazyTargeted, budgets: [null] },
  lazy_full_subtree: { fn: runLazyFullSubtree, budgets: [null] },
  flat_rag: { fn: runFlatRag, budgets: [800, 3000] },
  grep_read: { fn: runGrepRead, budgets: [1500, 6000] },
  // lazy_search: the REAL product retrieval path (search --strip --top N,
  // the actual L1-L4 router + stripNoteToPrompt) — added because
  // lazy_targeted/lazy_full_subtree are benchmark-authored simulations (see
  // lib/configs/lazyProductSearch.mjs's header). Shells out to the real CLI
  // per question, so it is slower than the other configs (~10s/call).
  lazy_search: { fn: runLazyProductSearch, budgets: [5] },
};

function parseArgs(argv) {
  const args = { ids: null, configs: null, all: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--ids') args.ids = argv[++i].split(',');
    else if (a === '--configs') args.configs = argv[++i].split(',');
  }
  return args;
}

function runOneConfig(configId, budget, question, corpusDirs) {
  const { fn } = CONFIGS[configId];
  const built = budget === null ? fn(question, corpusDirs) : fn(question, corpusDirs, budget);
  const variantId = budget === null ? configId : `${configId}_${budget}`;
  return { variantId, budget, ...built };
}

function main() {
  const args = parseArgs(process.argv);
  const qset = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf-8'));
  const corpusDirs = qset.corpusDirs;

  let questions = qset.questions;
  if (args.ids) questions = questions.filter((q) => args.ids.includes(q.id));
  if (!args.all && !args.ids) {
    console.error('Refusing to run: pass --ids q01,q02,... or --all.');
    process.exit(1);
  }

  let configIds = args.configs ?? Object.keys(CONFIGS);
  for (const c of configIds) {
    if (!CONFIGS[c]) {
      console.error(`Unknown config "${c}". Known: ${Object.keys(CONFIGS).join(', ')}`);
      process.exit(1);
    }
  }

  // Guarded too: mkdirSync is idempotent when the dir already exists (the
  // normal case), but a dry-run should not even attempt disk writes.
  if (!args.dryRun) {
    mkdirSync(RESULTS_RAW_DIR, { recursive: true });
  }

  let claudeVersion = 'unknown';
  try {
    claudeVersion = execSync('claude --version', { encoding: 'utf8' }).trim();
  } catch {
    /* best-effort */
  }

  const runMeta = {
    startedAt: new Date().toISOString(),
    answerModel: ANSWER_MODEL,
    claudeVersion,
    questionIds: questions.map((q) => q.id),
    configIds,
    dryRun: args.dryRun,
  };
  console.error(`[run] ${questions.length} questions x configs=${configIds.join(',')} model=${ANSWER_MODEL}`);

  const results = [];
  for (const question of questions) {
    for (const configId of configIds) {
      for (const budget of CONFIGS[configId].budgets) {
        // Building the context can itself throw (e.g. a question's lazyTarget
        // file falls outside every declared corpusDir — a real data gap found
        // for q18/q19, both targeting engine/src/cli/register-core.ts, which
        // no corpusDir covers). This used to be unguarded: one bad
        // (question, config) pair crashed the whole batch and silently lost
        // every record not yet written to disk. Recording it as a failed
        // variant (tokens=0, correct=false, error set) instead lets the rest
        // of the run complete — a partial-but-honest run beats a crash.
        const variantIdFallback = budget === null ? configId : `${configId}_${budget}`;
        let built;
        try {
          built = runOneConfig(configId, budget, question, corpusDirs);
        } catch (err) {
          const record = {
            questionId: question.id,
            category: question.category,
            variantId: variantIdFallback,
            configId,
            budget,
            injectedTokens: 0,
            configMeta: null,
            answer: null,
            correct: false,
            error: `context-build failed: ${err instanceof Error ? err.message : String(err)}`,
          };
          results.push(record);
          if (!args.dryRun) {
            const outPath = join(RESULTS_RAW_DIR, `${question.id}__${variantIdFallback}.json`);
            writeFileSync(outPath, JSON.stringify(record, null, 2));
          }
          console.error(
            `[run] ${args.dryRun ? '(dry-run, not written) ' : ''}${question.id} / ${variantIdFallback} CONTEXT-BUILD-FAILED: ${record.error}`,
          );
          continue;
        }
        const record = {
          questionId: question.id,
          category: question.category,
          variantId: built.variantId,
          configId,
          budget,
          injectedTokens: built.tokenCount,
          configMeta: built.meta,
        };

        if (args.dryRun) {
          record.answer = null;
          record.correct = null;
        } else {
          try {
            const t0 = Date.now();
            const { text, usage } = callAnswerModel(built.contextText, question.question);
            record.latencyMs = Date.now() - t0;
            record.answer = text;
            record.usage = usage;
            const grade = gradeKeywordMatch(text, question.groundTruth);
            record.correct = grade.correct;
            record.grade = grade;
          } catch (err) {
            record.error = err instanceof Error ? err.message : String(err);
            record.correct = false;
          }
        }

        results.push(record);
        const outPath = join(RESULTS_RAW_DIR, `${question.id}__${built.variantId}.json`);
        // --dry-run must be provably side-effect-free: it exists to let a
        // caller inspect built contexts/token counts without spending a
        // `claude -p` call OR touching disk. A prior run of `--dry-run`
        // clobbered 7 committed baseline files under results/raw/ with
        // null-answer records because this write used to be unconditional —
        // guard it so dry-run never writes to results/raw/ (see
        // scripts/test-dry-run.mjs for the regression test).
        if (!args.dryRun) {
          writeFileSync(outPath, JSON.stringify(record, null, 2));
        }
        console.error(
          `[run] ${args.dryRun ? '(dry-run, not written) ' : ''}${question.id} / ${built.variantId} tokens=${built.tokenCount} correct=${record.correct}`,
        );
      }
    }
  }

  runMeta.finishedAt = new Date().toISOString();
  runMeta.resultCount = results.length;
  // Same dry-run guard as above: last-run-meta.json is also disk state, so a
  // provably-side-effect-free dry-run must not touch it either.
  if (!args.dryRun) {
    writeFileSync(join(HERE, 'results', 'last-run-meta.json'), JSON.stringify(runMeta, null, 2));
    console.error(`[run] done. ${results.length} records written to ${RESULTS_RAW_DIR}`);
  } else {
    console.error(`[run] dry-run done. ${results.length} records built, nothing written to disk.`);
  }
}

main();
