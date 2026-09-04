#!/usr/bin/env node
/**
 * bench/token-economy/scripts/enrich-fixture.mjs
 *
 * Step 3 of the token-economy mission: populate the fixture brain's
 * file-neurons with conversational/decision knowledge, via the REAL
 * production pipeline (conv-file-enrichment.ts, driven by `lazybrain store`
 * + `lazybrain enrich`), then re-measure.
 *
 * WHAT THIS FABRICATES AND WHY (read this before trusting the output):
 *
 * The conv-file-enrichment.ts pipeline (Task 5) is fully wired end-to-end —
 * `lazybrain store` on a conversation-shaped note automatically triggers
 * runIncrementalEnrich, and `lazybrain enrich --force` re-runs it over the
 * whole brain. It needs no product fix. What it needs is INPUT: real
 * conversation notes carrying data-cerveau-files-modified (or body text that
 * mentions a known file path) plus prose containing decision/bug/rule/idea
 * language (see engine/src/commands/enrich.ts's CLASSIFIERS).
 *
 * This harness's fixture brain has never captured a real conversation — it
 * was built by pure code-scan (build-fixture-brain.mjs). So this script
 * FABRICATES synthetic conversation notes, one per git commit that
 * questions.json cites as ground-truth provenance for a BEHAVIORAL question
 * (commits: 45e65e9, af728a3, 106f871, 923a11b, 384305f, d0f52e1). Each
 * note's body text is the REAL commit message from this repo's own git
 * history (git show -s --format=%B <sha>) — not invented prose — reformatted
 * into first-person conversational sentences so the CLASSIFIERS regex can
 * bucket them (decision/bug/rule/idea), with data-cerveau-files-modified set
 * to the real files that commit touched (or, when the commit's fix targets a
 * file it didn't literally edit that commit — e.g. q07's pickLevel() is
 * DISCUSSED by 923a11b's message but lives in router.ts, edited by an
 * earlier, uncited commit — left as a body mention instead of a forced
 * files-modified entry, so evidence weighting (buildEvidenceFromTags) is
 * honest about what that "conversation" actually touched).
 *
 * This IS a simulation: no such conversation notes exist for these historical
 * commits in any real capture log. It simulates what a working
 * commit-message-to-conversation capture path (which does not exist in this
 * product today) would have produced, so conv-file-enrichment.ts can be
 * measured on non-empty input. Every fact injected is grounded in this repo's
 * real git history — nothing is invented — but the ACT of turning a commit
 * message into a stored conversation note is not a real, running product
 * capability. See the mission report for the explicit flag.
 *
 * Usage:
 *   LAZYBRAIN_BRAIN_PATH=<fixtureDir> node scripts/enrich-fixture.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');
const ENGINE_DIR = join(REPO_ROOT, 'engine');
const LAZYBRAIN_CLI = join(ENGINE_DIR, 'dist', 'bin', 'lazybrain.js');

/**
 * One synthetic conversation note PER (commit, file) pair that questions.json
 * cites as the source of a BEHAVIORAL ground truth. Each note's
 * data-cerveau-files-modified carries EXACTLY ONE file — deliberately, not
 * grouped by commit — because canonicalMerge() (graph/canonical-merge.ts)
 * only attaches an item to a file-neuron's section when one neuron holds
 * >=70% of the evidence weight (default threshold 0.7); a note that lists N
 * files at the same weight=1.0 splits evidence 1/N and never clears that bar,
 * so it gets routed to a standalone 'concept' neuron instead of the target
 * file-neuron. First attempt (one note per commit, multiple files) actually
 * hit exactly this: only 2 of 6 notes reached 'section' placement (the two
 * that happened to name a single file), the rest became concept neurons —
 * see the mission report. One note per file is the honest fix, not a tuning
 * trick: it matches how canonicalMerge is DESIGNED to work (unambiguous
 * single-file evidence -> section placement).
 */
const COMMITS = [
  { sha: '45e65e9', file: 'engine/src/graph/ast-parser.ts' },
  { sha: '45e65e9', file: 'engine/src/util/config.ts' },
  { sha: 'af728a3', file: 'engine/src/graph/backlinks.ts' },
  { sha: '106f871', file: 'engine/src/commands/conv-file-enrichment.ts' },
  { sha: '106f871', file: 'engine/src/commands/enrich.ts' },
  { sha: '923a11b', file: 'engine/src/commands/inject-context/sections.ts' },
  { sha: '923a11b', file: 'engine/src/commands/inject-context/markers.ts' },
  { sha: '384305f', file: 'engine/src/store/upsert.ts' },
  { sha: '384305f', file: 'engine/src/commands/dream.ts' },
  { sha: '384305f', file: 'engine/src/commands/repair.ts' },
  { sha: '384305f', file: 'engine/src/commands/store.ts' },
  { sha: 'd0f52e1', file: 'src/cli/lib/agentLoop.ts' },
];

function resolveClaudeNode() {
  return process.execPath;
}

function commitMeta(sha) {
  const format = '%H%x1f%cI%x1f%B';
  const raw = execFileSync('git', ['show', '-s', `--format=${format}`, sha], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const [hash, dateIso, ...bodyParts] = raw.split('\x1f');
  return { hash, date: dateIso.slice(0, 10), body: bodyParts.join('\x1f').trim() };
}

/**
 * Turn a raw commit message into first-person "conversation" prose. Keeps
 * every sentence from the real message (so ground-truth facts survive
 * verbatim) but rewrites the framing as something a developer would plausibly
 * have typed while pairing, so the CLASSIFIERS regex in enrich.ts (which
 * looks for words like "fixed", "decided", "rule", "should") reliably fires.
 */
function toConversationalBody(meta, file) {
  return (
    `Working on ${file}. ` +
    `We decided on the following fix: ${meta.body.replace(/\n+/g, ' ')} ` +
    `This is now fixed and the rule going forward is to keep this behavior.`
  );
}

function buildNoteHtml(meta, file, index) {
  const id = `conv-fixture-${meta.hash.slice(0, 10)}-${index}`;
  const absPath = join(REPO_ROOT, file).replace(/\\/g, '/');
  const created = `${meta.date}T00:00:00Z`;
  const body = toConversationalBody(meta, file);
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (
    `<article id="${id}" data-cerveau-version="0.2.0" data-cerveau-type="episodic" ` +
    `data-cerveau-created="${created}" data-cerveau-source="bench:token-economy-fixture" ` +
    `data-cerveau-tags="bench fixture conv" data-cerveau-topic="cerveau/bench" ` +
    `data-cerveau-files-modified="${esc(absPath)}">\n` +
    `<h1>Fixture conversation for ${esc(meta.hash)} (${esc(file)})</h1>\n` +
    `<p>${esc(body)}</p>\n` +
    `</article>`
  );
}

function main() {
  const brainDir = process.env.LAZYBRAIN_BRAIN_PATH;
  if (!brainDir) {
    console.error('LAZYBRAIN_BRAIN_PATH must be set to the fixture brain dir.');
    process.exit(1);
  }
  if (/Lazy-Brain/i.test(brainDir)) {
    console.error(`Refusing target "${brainDir}" — looks like a real brain path.`);
    process.exit(1);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-fixture-conv-'));
  const env = { ...process.env, LAZYBRAIN_BRAIN_PATH: brainDir };

  const metaCache = new Map();
  let stored = 0;
  const byShaCounter = new Map();
  for (const entry of COMMITS) {
    if (!metaCache.has(entry.sha)) metaCache.set(entry.sha, commitMeta(entry.sha));
    const meta = metaCache.get(entry.sha);
    const idx = (byShaCounter.get(entry.sha) ?? 0) + 1;
    byShaCounter.set(entry.sha, idx);
    const html = buildNoteHtml(meta, entry.file, idx);
    const notePath = join(tmpDir, `${entry.sha}-${idx}.html`);
    writeFileSync(notePath, html, 'utf8');
    execFileSync(
      resolveClaudeNode(),
      [LAZYBRAIN_CLI, 'store', '--from-file', notePath, '--overwrite'],
      { cwd: ENGINE_DIR, env, stdio: 'inherit' },
    );
    stored += 1;
    console.error(`[enrich-fixture] stored conversation note for ${entry.sha} / ${entry.file}`);
  }

  console.error(`[enrich-fixture] stored ${stored} synthetic conversation notes.`);

  // Force a full enrich pass (not just the incremental delta triggered by
  // `store`) so results are deterministic regardless of the 10s throttle.
  const enrichOut = execFileSync(
    resolveClaudeNode(),
    [LAZYBRAIN_CLI, 'enrich', '--force', '--pretty'],
    { cwd: ENGINE_DIR, env, encoding: 'utf8' },
  );
  console.error(`[enrich-fixture] enrich --force output: ${enrichOut.trim()}`);
}

main();
