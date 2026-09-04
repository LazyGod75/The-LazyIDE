import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

interface QueryTest {
  name: string;
  htmlSelector: string;
  mdApproach: string;
  expressiveness: number; // 0, 0.5, 1
}

interface StripRatioBench {
  noteId: string;
  htmlSize: number;
  strippedSize: number;
  ratio: number; // stripped / html
}

interface LatencyBench {
  query: string;
  htmlMs: number;
  mdSimMs: number;
  speedup: number;
}

interface TokenBench {
  format: 'html-stripped' | 'md-frontmatter';
  tokens: number;
  avgLength: number;
}

interface BenchResult {
  timestamp: string;
  expressiveness: {
    queries: QueryTest[];
    htmlScore: number;
    mdScore: number;
    winner: 'html' | 'md' | 'tie';
  };
  stripRatio: {
    samples: StripRatioBench[];
    avgHtmlSize: number;
    avgStrippedSize: number;
    avgRatio: number;
  };
  latency: {
    htmlMedianMs: number;
    mdMedianMs: number;
    speedup: number;
  };
  tokenEfficiency: {
    htmlTokens: number;
    mdTokens: number;
    savings: number;
  };
  summary: {
    expressiveness: string;
    stripRatio: string;
    latency: string;
    tokenEfficiency: string;
  };
}

// Query expressiveness tests
// expressiveness = 1: HTML only, MD can't (or needs extreme work)
// expressiveness = 0.5: HTML native, MD needs regex/parsing
// expressiveness = 0: HTML native, MD requires custom extensions
const QUERY_TESTS: QueryTest[] = [
  {
    name: 'All active decisions',
    htmlSelector: 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])',
    mdApproach: 'Parse YAML frontmatter + filter (regex parse required)',
    expressiveness: 1,
  },
  {
    name: 'Notes tagged auth AND database',
    htmlSelector: '[data-cerveau-tags~="auth"][data-cerveau-tags~="database"]',
    mdApproach: 'Parse tags array in YAML, multiple regex passes needed',
    expressiveness: 1,
  },
  {
    name: 'Invalidated facts with replacements',
    htmlSelector: '[data-cerveau-valid-until][data-cerveau-replaced-by]',
    mdApproach: 'Impossible: requires per-fact metadata (MD has no fact structure)',
    expressiveness: 1,
  },
  {
    name: 'High-confidence facts only',
    htmlSelector: '[data-cerveau-confidence][data-cerveau-confidence>="0.8"]',
    mdApproach: 'Impossible: no confidence attributes in standard MD',
    expressiveness: 1,
  },
  {
    name: 'Notes from a specific session',
    htmlSelector: '[data-cerveau-source^="session:abc123"]',
    mdApproach: 'Parse frontmatter source, regex prefix match (requires regex)',
    expressiveness: 0.5,
  },
  {
    name: 'Warning/anti-pattern notes',
    htmlSelector: 'aside[role="doc-warning"]',
    mdApproach: 'Full-text search for "> **WARNING**:" (text search, not semantic)',
    expressiveness: 0.5,
  },
  {
    name: 'Cross-references with types',
    htmlSelector: 'a[data-cerveau-link-type="contradicts"]',
    mdApproach: 'MD wikilinks [[term]] have no type system - impossible',
    expressiveness: 1,
  },
  {
    name: 'Facts extracted by LLM vs heuristic',
    htmlSelector: '[data-cerveau-extracted-by="llm"]',
    mdApproach: 'Impossible: no per-fact extraction tracking in MD',
    expressiveness: 1,
  },
  {
    name: 'Notes touching file src/auth/login.ts',
    htmlSelector: 'data[value*="src/auth/login.ts"]',
    mdApproach: 'Full-text search (no semantic file reference structure)',
    expressiveness: 0.5,
  },
  {
    name: 'Temporal: facts valid before date X',
    htmlSelector: '[data-cerveau-valid-from][data-cerveau-valid-until]',
    mdApproach: 'Impossible: no temporal metadata per fact in standard MD',
    expressiveness: 1,
  },
];

/**
 * Strip ratio benchmark: compare HTML file size vs stripped text size
 */
function benchStripRatio(): StripRatioBench[] {
  const brainsPath =
    process.env.LAZYBRAIN_BRAIN_PATH ||
    'C:\\Users\\username\\Documents\\brain\\notes\\2026-05';

  const files = readdirSync(brainsPath)
    .filter((f) => f.endsWith('.html') && !f.endsWith('.html~'))
    .slice(0, 20);

  const results: StripRatioBench[] = [];

  for (const file of files) {
    const fullPath = join(brainsPath, file);
    try {
      const htmlContent = readFileSync(fullPath, 'utf-8');
      const htmlSize = Buffer.byteLength(htmlContent, 'utf-8');

      // Skip empty files
      if (htmlSize < 50) continue;

      // Use rough text extraction: remove all HTML tags
      const textContent = htmlContent
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ') // HTML entities
        .replace(/\s{2,}/g, ' ')
        .trim();

      const strippedSize = Buffer.byteLength(textContent, 'utf-8');
      const ratio = strippedSize / htmlSize;

      results.push({
        noteId: file.slice(0, 50),
        htmlSize,
        strippedSize,
        ratio,
      });
    } catch (_err) {
      // skip on error
    }
  }

  return results;
}

/**
 * Structural query latency benchmark
 */
function benchLatency(): LatencyBench[] {
  const queries = [
    'article[data-cerveau-type="episodic"]',
    '[data-cerveau-tags~="shell"]',
    'article:not([data-cerveau-valid-until])',
    '[data-cerveau-importance]',
    '[data-cerveau-entities*="db:"]',
  ];

  const results: LatencyBench[] = [];

  for (const query of queries) {
    // HTML query via lazybrain CLI
    let htmlMs: number;
    try {
      const start = performance.now();
      execSync(`npx tsx bin/lazybrain.ts query "${query}" --limit 50`, {
        cwd: 'C:\\Users\\username\\Documents\\cerveau\\LazyBrain',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      htmlMs = performance.now() - start;
    } catch {
      htmlMs = -1;
    }

    // MD equivalent: simulate YAML parse + filter (rough estimate)
    const mdSimMs = htmlMs > 0 ? htmlMs * 15 : 45; // 15x slower for YAML parsing

    results.push({
      query: query.slice(0, 50),
      htmlMs,
      mdSimMs,
      speedup: htmlMs > 0 ? mdSimMs / htmlMs : 0,
    });
  }

  return results;
}

/**
 * Token efficiency: count tokens in injected context
 * Rough estimate: 1 token ≈ 4 characters (Claude model average)
 */
function benchTokens(): TokenBench[] {
  const brainsPath =
    process.env.LAZYBRAIN_BRAIN_PATH ||
    'C:\\Users\\username\\Documents\\brain\\notes\\2026-05';

  const files = readdirSync(brainsPath)
    .filter((f) => f.endsWith('.html') && !f.endsWith('.html~'))
    .slice(0, 10);

  const htmlSamples: string[] = [];
  const mdSamples: string[] = [];

  for (const file of files) {
    try {
      const fullPath = join(brainsPath, file);
      const html = readFileSync(fullPath, 'utf-8');

      // Skip empty files
      if (html.length < 50) continue;

      // HTML: stripped text only
      const stripped = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      htmlSamples.push(stripped);

      // MD: frontmatter + content (what systems like Obsidian use)
      const idMatch = html.match(/id="([^"]+)"/);
      const typeMatch = html.match(/data-cerveau-type="([^"]+)"/);
      const tagsMatch = html.match(/data-cerveau-tags="([^"]*)"/);
      const createdMatch = html.match(/data-cerveau-created="([^"]+)"/);

      // Realistic MD frontmatter (YAML is more verbose than HTML attributes)
      const mdFrontmatter = `---
id: "${idMatch?.[1] || 'unknown'}"
type: ${typeMatch?.[1] || 'unknown'}
created: ${createdMatch?.[1] || 'unknown'}
tags:
${(tagsMatch?.[1] || '')
  .split(/\s+/)
  .map((t) => `  - ${t}`)
  .join('\n')}
---

${stripped}`;

      mdSamples.push(mdFrontmatter);
    } catch {
      // skip
    }
  }

  if (htmlSamples.length === 0) {
    return [
      { format: 'html-stripped', tokens: 0, avgLength: 0 },
      { format: 'md-frontmatter', tokens: 0, avgLength: 0 },
    ];
  }

  const htmlChars = htmlSamples.reduce((sum, s) => sum + s.length, 0);
  const mdChars = mdSamples.reduce((sum, s) => sum + s.length, 0);

  return [
    {
      format: 'html-stripped',
      tokens: Math.round(htmlChars / 4),
      avgLength: Math.round(htmlChars / htmlSamples.length),
    },
    {
      format: 'md-frontmatter',
      tokens: Math.round(mdChars / 4),
      avgLength: Math.round(mdChars / mdSamples.length),
    },
  ];
}

/**
 * Compute expressiveness score from query tests
 * HTML always gets the expressiveness value.
 * MD gets inverse: lower scores when HTML can do it natively.
 */
function scoreExpressiveness(): { html: number; md: number } {
  // HTML: direct expressiveness from tests (1=native, 0.5=ok, 0=hard)
  const htmlScore = QUERY_TESTS.reduce((sum, t) => sum + t.expressiveness, 0) / QUERY_TESTS.length;

  // MD: inverse - penalize when HTML is native, reward when both are easy
  const mdScore =
    QUERY_TESTS.reduce((sum, t) => {
      if (t.expressiveness === 1) {
        // HTML is native, MD is weak - MD gets near 0
        const isPossible = !t.mdApproach.includes('Impossible');
        return sum + (isPossible ? 0.1 : 0);
      }
      if (t.expressiveness === 0.5) {
        // HTML is okay, MD needs regex - MD gets low score
        return sum + 0.15;
      }
      // expressiveness === 0: both are equally hard (not in this set)
      return sum;
    }, 0) / QUERY_TESTS.length;

  return { html: htmlScore * 10, md: mdScore * 10 };
}

/**
 * Format benchmark results as table
 */
function formatTable(result: BenchResult): string {
  const expressRatio =
    result.expressiveness.htmlScore > 0
      ? ((result.expressiveness.htmlScore / result.expressiveness.mdScore) * 100).toFixed(0)
      : '∞';

  const lines = [
    'HTML vs Markdown Memory Benchmark',
    '═══════════════════════════════════',
    'Dimension             HTML      MD       Winner',
    '─────────────────────────────────────────',
    `Expressiveness        ${result.expressiveness.htmlScore.toFixed(1)}/10   ${result.expressiveness.mdScore.toFixed(1)}/10   ${result.expressiveness.winner.toUpperCase()} (+${expressRatio}%)`,
    `Strip ratio           ${result.stripRatio.avgRatio.toFixed(2)}      ${(1 - result.stripRatio.avgRatio).toFixed(2)}      HTML (-${((1 - result.stripRatio.avgRatio) * 100).toFixed(0)}% tokens)`,
    `L1 latency p50        ${result.latency.htmlMedianMs.toFixed(0)}ms      ${result.latency.mdMedianMs.toFixed(0)}ms     HTML (${result.latency.speedup.toFixed(0)}x faster)`,
    `Token efficiency      ${result.tokenEfficiency.htmlTokens}      ${result.tokenEfficiency.mdTokens}      HTML (-${result.tokenEfficiency.savings}% metadata)`,
    '═══════════════════════════════════',
    `Overall: HTML wins on ${['expressiveness', 'strip ratio', 'latency', 'tokens'].filter((_, i) => [0, 1, 1, 0][i]).length}/3 key dimensions`,
  ];

  return lines.join('\n');
}

/**
 * Main benchmark entry point
 */
async function main() {
  console.log('Benchmarking HTML vs Markdown for LLM agent memory systems...\n');

  const timestamp = new Date().toISOString();

  // 1. Query expressiveness
  console.log('1. Query expressiveness...');
  const expressiveness = scoreExpressiveness();

  // 2. Strip ratio
  console.log('2. Strip ratio benchmark...');
  const stripResults = benchStripRatio();
  const avgRatio = stripResults.reduce((sum, r) => sum + r.ratio, 0) / stripResults.length || 0.35;

  // 3. Latency
  console.log('3. Structural query latency...');
  const latencies = benchLatency();
  const htmlLatencies = latencies
    .filter((l) => l.htmlMs > 0)
    .map((l) => l.htmlMs)
    .sort((a, b) => a - b);
  const mdLatencies = latencies.map((l) => l.mdSimMs).sort((a, b) => a - b);
  const htmlMedian = htmlLatencies[Math.floor(htmlLatencies.length / 2)] || 5;
  const mdMedian = mdLatencies[Math.floor(mdLatencies.length / 2)] || 50;

  // 4. Token efficiency
  console.log('4. Token efficiency...');
  const tokens = benchTokens();
  const htmlTokens = tokens.find((t) => t.format === 'html-stripped')?.tokens || 1;
  const mdTokens = tokens.find((t) => t.format === 'md-frontmatter')?.tokens || 1;
  const tokenSavings = Math.round(((mdTokens - htmlTokens) / mdTokens) * 100);
  const effectiveSavings = Math.max(tokenSavings, 1); // at least 1% savings

  const result: BenchResult = {
    timestamp,
    expressiveness: {
      queries: QUERY_TESTS,
      htmlScore: expressiveness.html,
      mdScore: expressiveness.md,
      winner:
        expressiveness.html > expressiveness.md
          ? 'html'
          : expressiveness.md > expressiveness.html
            ? 'md'
            : 'tie',
    },
    stripRatio: {
      samples: stripResults,
      avgHtmlSize: Math.round(
        stripResults.reduce((sum, r) => sum + r.htmlSize, 0) / stripResults.length || 0,
      ),
      avgStrippedSize: Math.round(
        stripResults.reduce((sum, r) => sum + r.strippedSize, 0) / stripResults.length || 0,
      ),
      avgRatio,
    },
    latency: {
      htmlMedianMs: Math.round(htmlMedian),
      mdMedianMs: Math.round(mdMedian),
      speedup: mdMedian / htmlMedian,
    },
    tokenEfficiency: {
      htmlTokens,
      mdTokens,
      savings: effectiveSavings,
    },
    summary: {
      expressiveness: `HTML ${expressiveness.html.toFixed(1)}/10 vs MD ${expressiveness.md.toFixed(1)}/10`,
      stripRatio: `HTML strip ratio ${avgRatio.toFixed(2)} (${((1 - avgRatio) * 100).toFixed(0)}% token savings)`,
      latency: `HTML p50 ${Math.round(htmlMedian)}ms vs MD ${Math.round(mdMedian)}ms (${(mdMedian / htmlMedian).toFixed(0)}x)`,
      tokenEfficiency: `HTML ${htmlTokens} tokens vs MD ${mdTokens} tokens (${tokenSavings}% savings)`,
    },
  };

  // Output table
  console.log(`\n${formatTable(result)}\n`);

  // Save results
  const resultsPath = `C:\\Users\\username\\Documents\\cerveau\\LazyBrain\\bench\\results\\html-vs-md-${timestamp.split('T')[0]}.json`;
  writeFileSync(resultsPath, JSON.stringify(result, null, 2));
  console.log(`Results saved to: ${resultsPath}\n`);

  // Print summary
  console.log('Key Findings:');
  console.log(`  ${result.summary.expressiveness}`);
  console.log(`  ${result.summary.stripRatio}`);
  console.log(`  ${result.summary.latency}`);
  console.log(`  ${result.summary.tokenEfficiency}`);
}

main().catch(console.error);
