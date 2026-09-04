#!/usr/bin/env node
/**
 * bench/token-economy/scripts/test-dry-run.mjs
 *
 * Regression test for the dry-run defect: a previous agent ran
 * `run.mjs --dry-run` and it overwrote 7 committed files under
 * results/raw/ with null-answer records, because the per-record
 * writeFileSync in run.mjs's main loop used to run unconditionally
 * regardless of --dry-run.
 *
 * This test proves `--dry-run` is now side-effect-free: it snapshots every
 * file under results/ (path -> content) before running `run.mjs --ids
 * q05 --dry-run --configs lazy_targeted` (q05/lazy_targeted chosen because
 * it is cheap to build and requires no `claude` CLI call), then asserts the
 * snapshot is byte-identical after the dry run, and that no new files were
 * created.
 *
 * q05 is deliberately NOT one of the 6 pilot question ids (q01, q03, q06,
 * q10, q13, q20) — this test targets a question with no existing raw file
 * at all, so it also proves dry-run does not CREATE a new results/raw/*.json
 * that shouldn't exist yet.
 *
 * Usage: node scripts/test-dry-run.mjs
 * Exits 0 and prints "PASS" on success, exits 1 and prints a diff on failure.
 *
 * Requires LAZYBRAIN_FIXTURE_BRAIN to be set to a valid fixture brain (same
 * requirement as run.mjs) since building the lazy_targeted context reads it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const RESULTS_DIR = join(HERE, 'results');
const RUN_MJS = join(HERE, 'run.mjs');

function snapshot(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
        files.set(abs, { hash, mtimeMs: statSync(abs).mtimeMs });
      }
    }
  };
  walk(dir);
  return files;
}

function main() {
  if (!process.env.LAZYBRAIN_FIXTURE_BRAIN) {
    console.error(
      'SKIP: LAZYBRAIN_FIXTURE_BRAIN is not set. Set it to a fixture brain built by ' +
        'scripts/build-fixture-brain.mjs to run this test (see README-FIXTURE.txt).',
    );
    process.exit(0);
  }

  const before = snapshot(RESULTS_DIR);

  execFileSync(
    process.execPath,
    [RUN_MJS, '--ids', 'q05', '--configs', 'lazy_targeted', '--dry-run'],
    { cwd: HERE, stdio: 'pipe', env: process.env },
  );

  const after = snapshot(RESULTS_DIR);

  const problems = [];

  for (const [path, beforeMeta] of before) {
    const afterMeta = after.get(path);
    if (!afterMeta) {
      problems.push(`DELETED during dry-run: ${path}`);
    } else if (afterMeta.hash !== beforeMeta.hash) {
      problems.push(`MODIFIED during dry-run: ${path}`);
    }
  }

  for (const path of after.keys()) {
    if (!before.has(path)) {
      problems.push(`CREATED during dry-run: ${path}`);
    }
  }

  if (problems.length > 0) {
    console.error('FAIL: --dry-run wrote to disk:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  console.log(`PASS: --dry-run touched 0 of ${before.size} files under results/`);
}

main();
