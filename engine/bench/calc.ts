/**
 * CALC — Causal / Anaphoric / Lateral / Counterfactual memory benchmark.
 *
 * LOCOMO tests Q&A on conversational dialogue. CALC tests the four dimensions
 * markdown-flat memory systems lose but HTML attributes preserve:
 *
 *   C — Causal:        "Why did we X?" → checks `data-cerveau-causes`
 *   A — Anaphoric:     "What is the current X?" → checks `data-cerveau-state`
 *                      and `valid_until` (filters out superseded facts)
 *   L — Lateral:       "What else uses Y?" → checks `data-cerveau-entities`
 *                      cross-note traversal
 *   C — Counterfactual: "What did we use before X?" → checks
 *                      `data-cerveau-replaces` + `supersedes` bidirectional links
 *
 * Each test fixture is a triple { ingest[], question, expected_ids[] }. We
 * store the ingest set, run the question through `/search`, and check whether
 * the expected note ids appear in the top-K hits.
 *
 * Runs against the same daemon as LOCOMO; tags everything `bench:calc:*` so
 * we can purge with `lazybrain compress --purge-source bench:calc`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CalcFixture {
  id: string;
  category: 'causal' | 'anaphoric' | 'lateral' | 'counterfactual';
  ingest: Array<{ session: string; text: string }>;
  question: string;
  /**
   * Snippets that MUST appear in the text of a top-K hit to count as a match.
   * Each snippet is checked case-insensitively against `hit.note.text`.
   * Use distinctive substrings from each expected ingest text.
   */
  expectedSnippets: string[];
  notes?: string;
}

const FIXTURES: CalcFixture[] = [
  // ─── CAUSAL ────────────────────────────────────────────────────────────
  {
    id: 'causal-postgres-switch',
    category: 'causal',
    ingest: [
      { session: 'pg-1', text: 'We switched from Postgres to SQLite because Postgres required too much ops overhead and our brain is single-user.' },
      { session: 'pg-2', text: 'SQLite uses single-file storage. No daemon needed.' },
      { session: 'pg-3', text: 'Caroline went to the gym yesterday and lifted heavy.' },
    ],
    question: 'Why did we switch to SQLite?',
    expectedSnippets: ['ops overhead'],
    notes: 'Should retrieve the causal note (pg-1) over the SQLite-feature note (pg-2) and unrelated (pg-3).',
  },
  {
    id: 'causal-haiku-extractor',
    category: 'causal',
    ingest: [
      { session: 'ext-1', text: 'Decision: enable Haiku batch extractor because regex misses paraphrased facts.' },
      { session: 'ext-2', text: 'Tip: the regex extractor uses pattern matching on "because" and "due to".' },
      { session: 'ext-3', text: 'Build passes after the latest TypeScript upgrade.' },
    ],
    question: 'Why did we enable the Haiku extractor?',
    expectedSnippets: ['misses paraphrased'],
  },
  {
    id: 'causal-cache-bust',
    category: 'causal',
    ingest: [
      { session: 'cache-1', text: 'The daemon LRU cache was invalidated because /capture writes new notes and brain mtime changes.' },
      { session: 'cache-2', text: 'Cache size is 64 entries with 60s TTL.' },
    ],
    question: 'Why does the cache invalidate on capture?',
    expectedSnippets: ['brain mtime changes'],
  },

  // ─── ANAPHORIC (current state) ─────────────────────────────────────────
  {
    id: 'anaphoric-current-db',
    category: 'anaphoric',
    ingest: [
      { session: 'db-old', text: 'We use Postgres for the cache layer.' },
      { session: 'db-new', text: 'We switched from Postgres to SQLite because SQLite is single-file.' },
      { session: 'db-other', text: 'For analytics we still rely on BigQuery.' },
    ],
    question: 'What database do we use for the cache?',
    expectedSnippets: ['switched from Postgres to SQLite'],
    notes: 'Multiple notes mention DBs; the current-state answer should beat the legacy one.',
  },
  {
    id: 'anaphoric-current-extractor',
    category: 'anaphoric',
    ingest: [
      { session: 'ext-old', text: 'The extractor was OpenAI gpt-4o-mini in v0.1.' },
      { session: 'ext-cur', text: 'In v0.3 we switched to Anthropic Haiku for the batch extractor.' },
    ],
    question: 'Which LLM does the extractor use?',
    expectedSnippets: ['Anthropic Haiku'],
  },

  // ─── LATERAL (entity co-occurrence) ────────────────────────────────────
  {
    id: 'lateral-react-mentions',
    category: 'lateral',
    ingest: [
      { session: 'react-1', text: 'The UI dashboard is built with React and Tailwind CSS.' },
      { session: 'react-2', text: 'React Server Components are used for the marketing pages.' },
      { session: 'react-3', text: 'The Python backend handles ML inference.' },
      { session: 'react-4', text: 'We picked React over Vue because the team had prior experience.' },
    ],
    question: 'What components use React?',
    expectedSnippets: ['UI dashboard', 'Server Components', 'picked React over Vue'],
    notes: 'Lateral query — wants ALL notes mentioning React entity.',
  },
  {
    id: 'lateral-postgres-mentions',
    category: 'lateral',
    ingest: [
      { session: 'pg-mig', text: 'Migration script runs against Postgres prod.' },
      { session: 'pg-perf', text: 'Postgres connection pool was too small.' },
      { session: 'sq-1', text: 'SQLite handles the local cache.' },
    ],
    question: 'Where is Postgres used?',
    expectedSnippets: ['Migration script', 'connection pool'],
  },

  // ─── COUNTERFACTUAL (what before X?) ───────────────────────────────────
  {
    id: 'cf-before-sqlite',
    category: 'counterfactual',
    ingest: [
      { session: 'cf-1', text: 'We switched from Postgres to SQLite because of ops overhead.' },
      { session: 'cf-2', text: 'SQLite is now the cache backend.' },
    ],
    question: 'What did we use before SQLite?',
    expectedSnippets: ['switched from Postgres to SQLite'],
    notes: 'Counterfactual — testing data-cerveau-replaces traversal.',
  },
  {
    id: 'cf-before-haiku',
    category: 'counterfactual',
    ingest: [
      { session: 'cf-llm-1', text: 'We replaced gpt-4o-mini with Claude Haiku for fact extraction.' },
      { session: 'cf-llm-2', text: 'Haiku is faster and cheaper per token.' },
    ],
    question: 'What was the extractor before Haiku?',
    expectedSnippets: ['gpt-4o-mini'],
  },
];

interface CalcOptions {
  daemonUrl: string;
  topK: number;
  outputDir: string;
}

interface CalcCellResult {
  fixtureId: string;
  category: CalcFixture['category'];
  question: string;
  hitIds: string[];
  expectedIds: string[];
  matched: number;
  recall: number; // fraction of expected found in hits
  precisionAtK: number; // fraction of top-K hits that were expected
  latencyMs: number;
}

function parseArgs(argv: string[]): CalcOptions {
  const opts: CalcOptions = {
    daemonUrl: process.env.LAZYBRAIN_DAEMON_URL ?? 'http://127.0.0.1:37788',
    topK: 5,
    outputDir: 'bench/results',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') opts.topK = parseInt(argv[++i] ?? '5', 10);
    else if (a === '--out') opts.outputDir = argv[++i] ?? opts.outputDir;
    else if (a === '--daemon') opts.daemonUrl = argv[++i] ?? opts.daemonUrl;
  }
  return opts;
}

async function storeFixture(f: CalcFixture, daemonUrl: string): Promise<void> {
  for (const i of f.ingest) {
    const taggedSession = `bench:calc:${f.id}:${i.session}`;
    await fetch(`${daemonUrl}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: i.text, session: taggedSession, async: false }),
    });
  }
}

interface Hit { id: string; score: number; note?: { text?: string } }

async function searchOne(query: string, topK: number, daemonUrl: string): Promise<{
  hits: Hit[];
  latencyMs: number;
}> {
  const start = Date.now();
  try {
    const resp = await fetch(`${daemonUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, top: topK, strip: false }),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) return { hits: [], latencyMs };
    const text = await resp.text();
    const parsed = JSON.parse(text) as { hits?: Hit[] };
    return { hits: parsed.hits ?? [], latencyMs };
  } catch {
    return { hits: [], latencyMs: Date.now() - start };
  }
}

function scoreFixture(
  fixture: CalcFixture,
  hits: Hit[],
  latencyMs: number,
  topK: number,
): CalcCellResult {
  const expected = fixture.expectedSnippets.map((s) => s.toLowerCase());
  const matchedSnippets = new Set<string>();
  let precisionHits = 0;
  for (const hit of hits.slice(0, topK)) {
    const hayId = hit.id.toLowerCase();
    const hayText = (hit.note?.text ?? '').toLowerCase();
    let isExpected = false;
    for (const snip of expected) {
      if (hayId.includes(snip) || hayText.includes(snip)) {
        matchedSnippets.add(snip);
        isExpected = true;
      }
    }
    if (isExpected) precisionHits += 1;
  }
  return {
    fixtureId: fixture.id,
    category: fixture.category,
    question: fixture.question,
    hitIds: hits.slice(0, topK).map((h) => h.id),
    expectedIds: fixture.expectedSnippets,
    matched: matchedSnippets.size,
    recall: matchedSnippets.size / Math.max(1, expected.length),
    precisionAtK: precisionHits / Math.max(1, Math.min(topK, hits.length)),
    latencyMs,
  };
}

interface CategorySummary {
  count: number;
  meanRecall: number;
  meanPrecision: number;
  meanLatencyMs: number;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Daemon check
  try {
    const h = await fetch(`${opts.daemonUrl}/health`);
    if (!h.ok) throw new Error('daemon not healthy');
  } catch {
    console.error(`Daemon not reachable at ${opts.daemonUrl}. Start with:\n  lazybrain daemon start --foreground --port 37788`);
    process.exit(1);
  }

  console.log(`CALC benchmark — ${FIXTURES.length} fixtures, top-${opts.topK}`);
  console.log('Ingesting fixtures…');
  for (const f of FIXTURES) {
    await storeFixture(f, opts.daemonUrl);
  }

  const results: CalcCellResult[] = [];
  for (const f of FIXTURES) {
    const search = await searchOne(f.question, opts.topK, opts.daemonUrl);
    results.push(scoreFixture(f, search.hits, search.latencyMs, opts.topK));
  }

  // Per-category roll-up
  const byCat = new Map<string, CalcCellResult[]>();
  for (const r of results) {
    const arr = byCat.get(r.category) ?? [];
    arr.push(r);
    byCat.set(r.category, arr);
  }
  const summary: Record<string, CategorySummary> = {};
  for (const [cat, rows] of byCat) {
    const meanRecall = rows.reduce((s, r) => s + r.recall, 0) / rows.length;
    const meanPrecision = rows.reduce((s, r) => s + r.precisionAtK, 0) / rows.length;
    const meanLatencyMs = rows.reduce((s, r) => s + r.latencyMs, 0) / rows.length;
    summary[cat] = {
      count: rows.length,
      meanRecall: Math.round(meanRecall * 1000) / 1000,
      meanPrecision: Math.round(meanPrecision * 1000) / 1000,
      meanLatencyMs: Math.round(meanLatencyMs),
    };
  }
  const overall = {
    fixtures: results.length,
    overallRecall: Math.round(
      results.reduce((s, r) => s + r.recall, 0) / results.length * 1000,
    ) / 1000,
    overallPrecision: Math.round(
      results.reduce((s, r) => s + r.precisionAtK, 0) / results.length * 1000,
    ) / 1000,
    p50LatencyMs: results.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(results.length * 0.5)] ?? 0,
    p95LatencyMs: results.map((r) => r.latencyMs).sort((a, b) => a - b)[Math.floor(results.length * 0.95)] ?? 0,
    perCategory: summary,
    injectMode: process.env.LAZYBRAIN_INJECT_MODE ?? 'highlights',
    haiku: process.env.LAZYBRAIN_EXTRACTOR === 'claude' || process.env.LAZYBRAIN_EXTRACTOR === 'haiku',
    entitiesDisabled: process.env.LAZYBRAIN_DISABLE_ENTITIES === '1',
    finishedAt: new Date().toISOString(),
  };

  if (!existsSync(opts.outputDir)) mkdirSync(opts.outputDir, { recursive: true });
  const outPath = join(opts.outputDir, `calc-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ overall, results }, null, 2), 'utf8');

  console.log('\n=== CALC results ===');
  console.log(`  Fixtures:        ${overall.fixtures}`);
  console.log(`  Overall recall:  ${(overall.overallRecall * 100).toFixed(1)}%`);
  console.log(`  Overall prec@K:  ${(overall.overallPrecision * 100).toFixed(1)}%`);
  console.log(`  Latency p50/p95: ${overall.p50LatencyMs} / ${overall.p95LatencyMs} ms`);
  console.log(`  Per-category:    ${JSON.stringify(summary, null, 2)}`);
  console.log(`\nFull report → ${outPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
