/**
 * Comparator: LazyBrain vs two real baselines:
 * 1. Raw HTML storage (what would be injected without stripping)
 * 2. Full transcript injection (what claude-mem does: raw MEMORY.md files)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { route } from '../src/retrieval/router.js';
import { stripNoteToPrompt } from '../src/retrieval/strip.js';
import { readNote } from '../src/store/reader.js';

interface ComparisonRow {
  query: string;
  lazy_tokens: number;
  raw_html_tokens: number;
  ratio_vs_html: number;
  transcript_tokens?: number;
  ratio_vs_transcript?: number;
  lazy_hits: number;
}

interface ComparatorResult {
  rows: ComparisonRow[];
  totals: {
    lazy_tokens: number;
    raw_html_tokens: number;
    ratio_vs_html: number;
    transcript_tokens?: number;
    ratio_vs_transcript?: number;
  };
}

const DEFAULT_QUERIES = [
  'auth oauth',
  'rate limit',
  'database migration',
  'recent decision about testing',
  'what is our deploy workflow',
  'memory architecture',
  'error handling pattern',
  'why did we pick this tool',
];

function tokensFromText(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Returns the raw HTML token count for a given note path.
 * This measures what would be injected WITHOUT stripping.
 */
function measureRawHtmlTokens(notePath: string): number {
  try {
    const note = readNote(notePath);
    return tokensFromText(note.html);
  } catch {
    return 0;
  }
}

/**
 * Extracts the session ID from the `data-cerveau-source` attribute,
 * then looks up the corresponding JSONL file in ~/.claude/projects/{id}
 * and returns its total token count. Returns undefined if file not found.
 */
function measureTranscriptTokens(notePath: string): number | undefined {
  try {
    const note = readNote(notePath);
    // Parse data-cerveau-source from HTML
    const m = note.html.match(/data-cerveau-source=["']([^"']+)["']/);
    if (!m) return undefined;

    const source = m[1];
    // Format: "session:sample#003" or "session:<id>"
    const match = source.match(/session:([^#]+)/);
    if (!match) return undefined;

    const sessionId = match[1];
    // Search for the JSONL file in ~/.claude/projects/{id}
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (!homeDir) return undefined;

    const projectsDir = resolve(homeDir, '.claude', 'projects');

    // Try to find the .jsonl file by examining files in projectsDir
    // and its immediate subdirectories
    const candidates: string[] = [
      resolve(projectsDir, `${sessionId}.jsonl`),
    ];

    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPath = resolve(projectsDir, entry.name, `${sessionId}.jsonl`);
          candidates.push(subPath);
        }
      }
    } catch {
      // Directory may not exist, skip
    }

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const content = readFileSync(candidate, 'utf8');
        return tokensFromText(content);
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export async function runComparator(queries: string[]): Promise<ComparatorResult> {
  const rows: ComparisonRow[] = [];
  for (const query of queries) {
    try {
      // Get raw search results with paths using router directly
      const routeResult = await route({
        query,
        topK: 5,
        level: 'auto',
        hydrateNote: true,
      });
      const hits = routeResult.hits;

      // Get stripped output for token count
      const strippedParts = hits
        .map((h) => (h.note ? stripNoteToPrompt(h.note) : h.snippet ?? h.id))
        .filter(Boolean);
      const strippedOutput = strippedParts.join('\n\n');
      const lazyTokens = tokensFromText(strippedOutput);

      // Measure raw HTML and transcript tokens for each hit
      let totalRawHtmlTokens = 0;
      let totalTranscriptTokens = 0;
      let transcriptHitsCount = 0;

      for (const hit of hits) {
        if (hit.path) {
          const htmlTokens = measureRawHtmlTokens(hit.path);
          totalRawHtmlTokens += htmlTokens;

          const transcriptTokens = measureTranscriptTokens(hit.path);
          if (transcriptTokens !== undefined) {
            totalTranscriptTokens += transcriptTokens;
            transcriptHitsCount++;
          }
        }
      }

      rows.push({
        query,
        lazy_tokens: lazyTokens,
        raw_html_tokens: totalRawHtmlTokens,
        ratio_vs_html: totalRawHtmlTokens === 0 ? 0 : lazyTokens / totalRawHtmlTokens,
        ...(transcriptHitsCount > 0 && {
          transcript_tokens: totalTranscriptTokens,
          ratio_vs_transcript: totalTranscriptTokens === 0 ? 0 : lazyTokens / totalTranscriptTokens,
        }),
        lazy_hits: hits.length,
      });
    } catch {
      rows.push({
        query,
        lazy_tokens: 0,
        raw_html_tokens: 0,
        ratio_vs_html: 0,
        lazy_hits: 0,
      });
    }
  }

  const sumLazy = rows.reduce((s, r) => s + r.lazy_tokens, 0);
  const sumRawHtml = rows.reduce((s, r) => s + r.raw_html_tokens, 0);
  const sumTranscript = rows.reduce((s, r) => s + (r.transcript_tokens ?? 0), 0);
  const hasTranscriptData = rows.some((r) => r.transcript_tokens !== undefined);

  return {
    rows,
    totals: {
      lazy_tokens: sumLazy,
      raw_html_tokens: sumRawHtml,
      ratio_vs_html: sumRawHtml === 0 ? 0 : sumLazy / sumRawHtml,
      ...(hasTranscriptData && {
        transcript_tokens: sumTranscript,
        ratio_vs_transcript: sumTranscript === 0 ? 0 : sumLazy / sumTranscript,
      }),
    },
  };
}

// Main CLI entry point: run when called directly with Node/tsx
async function main() {
  let queriesFile: string | null = null;
  let pretty = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--queries-file') queriesFile = process.argv[++i] ?? null;
    else if (process.argv[i] === '--pretty') pretty = true;
  }
  let queries = DEFAULT_QUERIES;
  if (queriesFile) {
    if (!existsSync(queriesFile)) {
      process.stderr.write(`queries file not found: ${queriesFile}\n`);
      process.exit(1);
    }
    queries = JSON.parse(readFileSync(queriesFile, 'utf8')) as string[];
  }

  try {
    const r = await runComparator(queries);

    if (pretty) {
      const lines: string[] = [
        'Comparator (LazyBrain vs Raw HTML + Full Transcript)',
        '─'.repeat(90),
      ];

      // Header
      lines.push(
        '  Query'.padEnd(32) +
        'Lazy   '.padStart(8) +
        'HTML   '.padStart(8) +
        'Ratio  '.padStart(8) +
        'Transcript'.padStart(12),
      );
      lines.push('─'.repeat(90));

      // Rows
      for (const row of r.rows) {
        const transcriptPart = row.transcript_tokens
          ? `${row.ratio_vs_transcript?.toFixed(2)}x`.padStart(12)
          : '─'.padStart(12);

        lines.push(
          `  ${row.query.slice(0, 30).padEnd(28)}` +
          `${row.lazy_tokens.toString().padStart(6)}t ` +
          `${row.raw_html_tokens.toString().padStart(6)}t ` +
          `${row.ratio_vs_html.toFixed(2)}x`.padStart(8) +
          transcriptPart,
        );
      }

      lines.push('─'.repeat(90));

      // Totals
      const transcriptSavings = r.totals.transcript_tokens
        ? `  vs transcript: saves ${Math.round((1 - r.totals.ratio_vs_transcript!) * 100)}%`
        : '';

      lines.push(
        `Totals: ` +
        `lazy=${r.totals.lazy_tokens}t  ` +
        `html=${r.totals.raw_html_tokens}t  ` +
        `ratio=${r.totals.ratio_vs_html.toFixed(2)}x`,
      );
      const savings = `→ LazyBrain saves ~${Math.round((1 - r.totals.ratio_vs_html) * 100)}% tokens vs raw HTML`;
      if (transcriptSavings) {
        lines.push(savings);
        lines.push(transcriptSavings);
      } else {
        lines.push(savings);
      }

      process.stdout.write(lines.join('\n') + '\n');
    } else {
      process.stdout.write(JSON.stringify(r) + '\n');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`comparator failed: ${msg}\n`);
    process.exit(1);
  }
}

// Check if running as main module
if (import.meta.url.startsWith('file://')) {
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith('comparator.ts') || argv1.endsWith('comparator.js'))) {
    main().catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
}
