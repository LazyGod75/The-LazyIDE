import { existsSync, readFileSync } from 'node:fs';
import { route } from '../src/retrieval/router.js';

interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  avg: number;
  min: number;
  max: number;
}

interface LatencyResult {
  queries_total: number;
  by_level: Record<string, LatencyStats>;
  total_duration_ms: number;
}

const DEFAULT_QUERIES = [
  'article[data-cerveau-type="decision"]',
  '[data-cerveau-tags~="auth"]',
  'article[data-cerveau-valid-from^="2026"]',
  'auth',
  'oauth migration',
  'rate limit',
  'database schema',
  'bug fix',
  'what was the rationale behind moving to OAuth?',
  'how did we handle the rate limit issue last quarter?',
  'reasons we chose Postgres over SQLite',
  'tests that catch regressions',
  'recent decisions about security',
  'deployment workflow problems',
  'patterns for handling api errors',
  'memory architecture choices',
  'how does our auth flow handle expired tokens',
  'what is our current testing strategy for backend',
  'context window management approach',
  'what database tooling we picked',
];

function loadQueries(file: string | null): string[] {
  if (!file) return DEFAULT_QUERIES;
  if (!existsSync(file)) throw new Error(`Queries file not found: ${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(data)) throw new Error('Queries file must be a JSON array of strings');
  return data.filter((q): q is string => typeof q === 'string');
}

function stats(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { count: 0, p50: 0, p95: 0, avg: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, n) => s + n, 0);
  return {
    count: values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    avg: Math.round(sum / values.length),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export async function runLatency(
  queries: string[],
  warmup: number,
): Promise<LatencyResult> {
  // Warmup runs to load WASM models, FTS index, etc.
  for (let i = 0; i < Math.min(warmup, queries.length); i++) {
    try {
      await route({ query: queries[i] ?? '', topK: 5 });
    } catch {
      // swallow warmup errors
    }
  }

  const byLevel: Record<string, number[]> = { L1: [], L2: [], L3: [], L4: [] };
  const start = Date.now();
  for (const query of queries) {
    try {
      const r = await route({ query, topK: 5 });
      (byLevel[r.levelUsed] ??= []).push(r.totalMs);
    } catch {
      // swallow per-query errors
    }
  }
  const totalMs = Date.now() - start;

  const out: Record<string, LatencyStats> = {};
  for (const [level, arr] of Object.entries(byLevel)) {
    out[level] = stats(arr);
  }
  return {
    queries_total: queries.length,
    by_level: out,
    total_duration_ms: totalMs,
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  let queriesFile: string | null = null;
  let warmup = 2;
  let pretty = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--queries-file') {
      queriesFile = process.argv[++i] ?? null;
    } else if (process.argv[i] === '--warmup') {
      warmup = parseInt(process.argv[++i] ?? '2', 10);
    } else if (process.argv[i] === '--pretty') {
      pretty = true;
    }
  }
  runLatency(loadQueries(queriesFile), warmup)
    .then((r) => {
      if (pretty) {
        process.stdout.write(
          [
            `Latency (${r.queries_total} queries in ${r.total_duration_ms}ms)`,
            '─'.repeat(50),
            ...Object.entries(r.by_level).map(
              ([k, s]) =>
                `  ${k}: n=${s.count} avg=${s.avg}ms p50=${s.p50}ms p95=${s.p95}ms min=${s.min}ms max=${s.max}ms`,
            ),
          ].join('\n') + '\n',
        );
      } else {
        process.stdout.write(JSON.stringify(r) + '\n');
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`latency bench failed: ${msg}\n`);
      process.exit(1);
    });
}
