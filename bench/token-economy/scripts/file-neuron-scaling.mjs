#!/usr/bin/env node
/**
 * bench/token-economy/scripts/file-neuron-scaling.mjs
 *
 * Answers a narrower question than the full token-economy harness (run.mjs):
 * NOT "which retrieval config answers more questions per token" but "does a
 * bare file-neuron cost more or fewer tokens than the source file it
 * describes, and how does that ratio move as the source file grows?"
 *
 * This was written to check a specific claim: that file-neurons cost MORE
 * than their source for small files (measured on one 24-line hand-built
 * fixture: 305 source tokens vs 465/838 neuron tokens, ratio 1.52x/2.75x)
 * but that the ratio "inverts for larger files" — a hypothesis that had
 * NOT been checked against a real size distribution before this script.
 *
 * METHOD
 *   1. Deterministic size-stratified sample: every *.ts/*.tsx file under
 *      engine/src/ and src/ (excluding tests, __screenshots__, and
 *      src/i18n/locales/* — flat translation tables, not code) is bucketed
 *      by line count into 5 buckets (<50, 50-200, 200-500, 500-1000,
 *      1000+). Within each bucket, files are sorted by repo-relative path
 *      and 5 are picked at even quantile indices — idx(k) = floor(k*L/5)
 *      for k=0..4 — so the sample spans the whole bucket instead of
 *      clustering in one directory, with zero manual cherry-picking.
 *   2. The sampled files are copied (preserving their repo-relative path)
 *      into an isolated staging directory under the given --out root, then
 *      code-scanned with the REAL production CLI
 *      (`lazybrain graph --cwd <staging> --skip-clusters --pretty`, i.e.
 *      the actual engine/src/graph/code-scanner.ts +
 *      engine/src/annotator/blocks/composers/file-neuron.ts) into an
 *      isolated fixture brain — never David's real brain.
 *   3. Token counts use estimateTokenCount(), copied byte-for-byte from
 *      engine/src/util/tokenize.ts / bench/token-economy/lib/tokenize.mjs,
 *      so numbers stay comparable with LazyBrain's other token claims.
 *      Two neuron measurements are reported:
 *        - "HTML" tokens: the full composed <article> as stored on disk.
 *        - "stripped" tokens: tag-stripped body text, i.e. what the real
 *          retrieval path (engine/src/retrieval/strip.ts) actually injects
 *          into an LLM's context when a full note is read.
 *   4. A least-squares linear fit (tokens = a + b*lines) is computed for
 *      source tokens and for each neuron metric, giving a fixed cost (a)
 *      and a variable, per-line cost (b). The break-even line count is
 *      where the neuron fit crosses the source fit.
 *
 * CAVEAT (real, not smoothed over): sampled files are scanned in isolation
 * (copied into a staging dir without their real neighbours), so inbound
 * import edges never resolve and the infobox "Inbound" row / "Used by"
 * section are always 0/absent. This matches how the existing token-economy
 * fixture brain is built too (one `graph --cwd` call per corpusDir, each
 * directory scanned independently) — it is a pre-existing property of
 * per-directory scanning, not something this script introduces. The
 * "Imports & Exports" section is unaffected: it comes from parsing the
 * file's own AST, not from resolved graph edges.
 *
 * Usage:
 *   cd engine && npm run build            # if dist/ is stale
 *   node bench/token-economy/scripts/file-neuron-scaling.mjs --out <scratchDir>
 *
 * Writes <out>/sample-manifest.json and <out>/scaling-report.json, and
 * prints the table + regression + break-even to stdout.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');
const ENGINE_DIR = join(REPO_ROOT, 'engine');
const LAZYBRAIN_CLI = join(ENGINE_DIR, 'dist', 'bin', 'lazybrain.js');

const SOURCE_ROOTS = ['engine/src', 'src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__pycache__', '__screenshots__']);
const CODE_EXT = new Set(['.ts', '.tsx']);
const MAX_FILE_SIZE = 100_000; // mirror code-scanner.ts's own cap
const SAMPLE_PER_BUCKET = 5;

const BUCKETS = [
  { name: 'very-small(<50)', min: 0, max: 50 },
  { name: 'small(50-200)', min: 50, max: 200 },
  { name: 'medium(200-500)', min: 200, max: 500 },
  { name: 'large(500-1000)', min: 500, max: 1000 },
  { name: 'very-large(1000+)', min: 1000, max: Infinity },
];

function estimateTokenCount(text) {
  if (!text) return 0;
  const nonAlpha = text.replace(/[a-zA-Z0-9\s]/g, '').length;
  const ratio = text.length > 0 ? nonAlpha / text.length : 0;
  const tokensPerChar = ratio > 0.3 ? 0.33 : 0.25;
  return Math.ceil(text.length * tokensPerChar);
}

function stripTags(fragment) {
  return fragment
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(h[1-6]|p|div|section|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function walk(absDir, out) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__') continue;
      walk(abs, out);
    } else if (e.isFile() && CODE_EXT.has(extname(e.name))) {
      if (/\.(test|spec)\.tsx?$/.test(e.name)) continue;
      out.push(abs);
    }
  }
}

function buildSample() {
  const allAbs = [];
  for (const r of SOURCE_ROOTS) walk(join(REPO_ROOT, r), allAbs);

  const files = allAbs
    .map((abs) => {
      const relPath = relative(REPO_ROOT, abs).split('\\').join('/');
      let lines = 0;
      let bytes = 0;
      try {
        bytes = statSync(abs).size;
        lines = readFileSync(abs, 'utf-8').split('\n').length;
      } catch {
        /* unreadable — excluded below by lines === 0 */
      }
      return { abs, relPath, lines, bytes };
    })
    .filter((f) => f.lines > 0 && f.bytes <= MAX_FILE_SIZE)
    .filter((f) => !f.relPath.startsWith('src/i18n/locales/'));

  const sample = [];
  const populationSizes = {};
  for (const bucket of BUCKETS) {
    const inBucket = files.filter((f) => f.lines >= bucket.min && f.lines < bucket.max);
    populationSizes[bucket.name] = inBucket.length;
    const sorted = [...inBucket].sort((a, b) => a.relPath.localeCompare(b.relPath));
    const L = sorted.length;
    const pickedIdx = new Set();
    for (let k = 0; k < SAMPLE_PER_BUCKET && L > 0; k++) {
      pickedIdx.add(Math.min(L - 1, Math.floor((k * L) / SAMPLE_PER_BUCKET)));
    }
    for (const idx of pickedIdx) sample.push({ bucket: bucket.name, ...sorted[idx] });
  }
  return { populationSizes, sample };
}

function linreg(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const b = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const a = (sumY - b * sumX) / n;
  return { a, b };
}

function breakEvenLines(neuronFit, sourceFit) {
  const denom = sourceFit.b - neuronFit.b;
  if (denom === 0) return null;
  return (neuronFit.a - sourceFit.a) / denom;
}

function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  if (!outDir) {
    console.error('Usage: node file-neuron-scaling.mjs --out <scratchDir>');
    process.exit(1);
  }
  if (!existsSync(LAZYBRAIN_CLI)) {
    console.error(`Missing built CLI at ${LAZYBRAIN_CLI} — run "npm run build" in engine/ first.`);
    process.exit(1);
  }
  if (/Lazy-Brain/i.test(outDir) || /\.lazybrain$/i.test(outDir)) {
    console.error(`Refusing target "${outDir}" — looks like it could be a real brain path.`);
    process.exit(1);
  }

  const { populationSizes, sample } = buildSample();
  console.error('Population sizes:', populationSizes);
  console.error(`Sampled ${sample.length} files (${SAMPLE_PER_BUCKET} per bucket, even-quantile pick).`);

  const stagingDir = join(outDir, 'staging');
  const brainDir = join(outDir, 'brain');
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(brainDir, { recursive: true });

  for (const s of sample) {
    const dest = join(stagingDir, s.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(s.abs, dest);
  }

  execFileSync(
    process.execPath,
    [LAZYBRAIN_CLI, 'graph', '--cwd', stagingDir, '--skip-clusters', '--pretty'],
    { env: { ...process.env, LAZYBRAIN_BRAIN_PATH: brainDir }, cwd: ENGINE_DIR, stdio: 'inherit' },
  );

  // Load composed file-neurons by data-code-file.
  const notesRoot = join(brainDir, 'notes');
  const byCodeFile = new Map();
  for (const month of readdirSync(notesRoot)) {
    const monthDir = join(notesRoot, month);
    for (const f of readdirSync(monthDir).filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(join(monthDir, f), 'utf-8');
      if (!html.includes('data-cerveau-type="file-neuron"')) continue;
      const attr = (name) => (html.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1] ?? null;
      const codeFile = attr('data-code-file');
      if (codeFile) byCodeFile.set(codeFile, html);
    }
  }

  const rows = [];
  for (const s of sample) {
    const html = byCodeFile.get(s.relPath);
    if (!html) {
      console.error(`MISSING neuron for ${s.relPath}`);
      continue;
    }
    const sourceTokens = estimateTokenCount(readFileSync(s.abs, 'utf-8'));
    const articleMatch = html.match(/<article[^>]*>[\s\S]*<\/article>/i);
    const neuronHtmlTokens = estimateTokenCount(articleMatch ? articleMatch[0] : html);
    const bodyMatch = html.match(/<article[^>]*>([\s\S]*)<\/article>/i);
    const neuronStrippedTokens = estimateTokenCount(stripTags(bodyMatch ? bodyMatch[1] : html));
    rows.push({
      bucket: s.bucket,
      relPath: s.relPath,
      lines: s.lines,
      sourceTokens,
      neuronHtmlTokens,
      ratioHtml: +(neuronHtmlTokens / sourceTokens).toFixed(3),
      neuronStrippedTokens,
      ratioStripped: +(neuronStrippedTokens / sourceTokens).toFixed(3),
    });
  }
  rows.sort((a, b) => a.lines - b.lines);

  console.log(
    '\nbucket\tlines\trelPath\tsourceTok\tneuronHtmlTok\tratioHtml\tneuronStrippedTok\tratioStripped',
  );
  for (const r of rows) {
    console.log(
      `${r.bucket}\t${r.lines}\t${r.relPath}\t${r.sourceTokens}\t${r.neuronHtmlTokens}\t${r.ratioHtml}\t${r.neuronStrippedTokens}\t${r.ratioStripped}`,
    );
  }

  const srcFit = linreg(rows.map((r) => ({ x: r.lines, y: r.sourceTokens })));
  const htmlFit = linreg(rows.map((r) => ({ x: r.lines, y: r.neuronHtmlTokens })));
  const strippedFit = linreg(rows.map((r) => ({ x: r.lines, y: r.neuronStrippedTokens })));
  const beHtml = breakEvenLines(htmlFit, srcFit);
  const beStripped = breakEvenLines(strippedFit, srcFit);

  console.log('\n--- Linear fits: tokens = a + b*lines ---');
  console.log('source           :', srcFit);
  console.log('neuron (HTML)    :', htmlFit, '  break-even (lines):', beHtml);
  console.log('neuron (stripped):', strippedFit, '  break-even (lines):', beStripped);

  writeFileSync(join(outDir, 'sample-manifest.json'), JSON.stringify({ populationSizes, sample }, null, 2));
  writeFileSync(
    join(outDir, 'scaling-report.json'),
    JSON.stringify({ rows, srcFit, htmlFit, strippedFit, breakEvenHtmlLines: beHtml, breakEvenStrippedLines: beStripped }, null, 2),
  );
  console.log(`\nWritten ${join(outDir, 'scaling-report.json')}`);
}

main();
