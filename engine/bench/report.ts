import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../src/util/config.js';
import { runComparator } from './comparator.js';
import { runLatency } from './latency.js';
import { runStructuralRecall } from './structural-recall.js';
import { runTokensPerSession } from './tokens-per-session.js';

const DEFAULT_QUERIES = [
  'article[data-cerveau-type="decision"]',
  'auth',
  'rate limit',
  'memory architecture',
  'what is our deploy workflow',
];

interface ReportPaths {
  dir: string;
  file: string;
}

function ensureReportDir(): ReportPaths {
  const cfg = getConfig();
  const dir = join(cfg.cachePath, 'reports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  return { dir, file: join(dir, `report-${date}.md`) };
}

export async function runReport(windowHours: number): Promise<string> {
  const recall = runStructuralRecall(windowHours);
  const tokens = runTokensPerSession(windowHours);
  const latency = await runLatency(DEFAULT_QUERIES, 1);
  const compare = await runComparator(DEFAULT_QUERIES);

  const md = `# LazyBrain — bench report

**Generated:** ${new Date().toISOString()}
**Window:** ${windowHours} hours

## 1. Structural recall (★ killer metric)

- **Total queries:** ${recall.total_queries}
- **L1 hits:** ${recall.l1_count}
- **Recall rate:** ${recall.structural_recall_rate_pct}%
- **Target:** ≥ 30%

### Distribution by level

| Level | Count |
|-------|------:|
${Object.entries(recall.by_level)
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join('\n')}

## 2. Tokens per session

| Metric | Inject | Capture |
|--------|-------:|--------:|
| n | ${tokens.inject.n} | ${tokens.capture.n} |
| avg | ${tokens.inject.avg} | in:${tokens.capture.avg_in} / out:${tokens.capture.avg_out} |
| p50 | ${tokens.inject.p50} | — |
| p95 | ${tokens.inject.p95} | — |
| min | ${tokens.inject.min} | — |
| max | ${tokens.inject.max} | — |
| strip ratio | — | ${tokens.capture.avg_strip_ratio.toFixed(2)} |

**Target inject p50:** ≤ 3000 tokens.

## 3. Latency by router level

| Level | n | avg (ms) | p50 (ms) | p95 (ms) |
|-------|--:|---------:|---------:|---------:|
${Object.entries(latency.by_level)
  .map(([k, s]) => `| ${k} | ${s.count} | ${s.avg} | ${s.p50} | ${s.p95} |`)
  .join('\n')}

**Targets:** L1 ≤ 10 ms · L2 ≤ 30 ms · L3 ≤ 150 ms · L4 ≤ 200 ms.

## 4. Comparator vs baseline (placeholder — claude-mem real integration TBD)

${compare.rows.length === 0
    ? 'No data.'
    : ['| Query | LazyBrain tokens | Baseline tokens | Ratio |',
       '|-------|-----------------:|----------------:|------:|',
       ...compare.rows.map(
         (r) => `| ${r.query.slice(0, 40)} | ${r.lazy_tokens} | ${r.raw_html_tokens} | ${r.ratio_vs_html.toFixed(2)} |`,
       ),
       '',
       `**Totals** — LazyBrain: ${compare.totals.lazy_tokens} · raw HTML: ${compare.totals.raw_html_tokens} · ratio: ${compare.totals.ratio_vs_html.toFixed(2)}`,
      ].join('\n')}

> Measured against real HTML note sizes and session transcripts.

## Decision summary

- Structural recall ${recall.structural_recall_rate_pct >= 30 ? 'OK' : 'BELOW TARGET'}
- Inject tokens ${tokens.inject.p50 <= 3000 ? 'OK' : 'OVER BUDGET'}
- L1 latency ${latency.by_level.L1 && latency.by_level.L1.p50 <= 10 ? 'OK' : 'BELOW TARGET'}
`;

  const { file } = ensureReportDir();
  writeFileSync(file, md, 'utf8');
  return file;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  let windowHours = 24;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--window-hours') {
      windowHours = parseInt(process.argv[++i] ?? '24', 10);
    }
  }
  runReport(windowHours)
    .then((path) => {
      process.stdout.write(`Report: ${path}\n`);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`report failed: ${msg}\n`);
      process.exit(1);
    });
}
