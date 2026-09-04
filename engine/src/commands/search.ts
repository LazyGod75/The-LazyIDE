import { isMultiQueryEnabled, routeWithRRF } from '../retrieval/multi-query.js';
import { route } from '../retrieval/router.js';
import type { ResolvedHit } from '../retrieval/router.js';
import { stripNoteToPrompt } from '../retrieval/strip.js';
import { assertBrainExists } from '../util/brain-guard.js';

export interface SearchCliOptions {
  query: string;
  top?: number;
  mode?: 'l1' | 'l2' | 'l3' | 'l4' | 'auto';
  strip?: boolean;
  pretty?: boolean;
  json?: boolean;
  diversity?: number;
  includeExpired?: boolean;
  type?: string;
  tag?: string;
  cwd?: string;
  pageRankWeight?: number;
  sourcePrefix?: string;
}

export async function runSearch(opts: SearchCliOptions): Promise<string> {
  // BRAIN-NOT-FOUND guard: fail early with a clear message rather than
  // returning "[L2] 0 hits" which is indistinguishable from a real empty search.
  assertBrainExists();

  const routeInput = {
    query: opts.query,
    topK: opts.top ?? 5,
    level:
      opts.mode && opts.mode.toLowerCase() !== 'auto'
        ? (opts.mode.toUpperCase() as 'L1' | 'L2' | 'L3' | 'L4')
        : ('auto' as const),
    diversityLambda: opts.diversity,
    includeExpired: opts.includeExpired,
    type: opts.type,
    tag: opts.tag,
    cwd: opts.cwd ?? process.env.LAZYBRAIN_CWD ?? process.cwd(),
    pageRankWeight: opts.pageRankWeight,
    sourcePrefix: opts.sourcePrefix,
    hydrateNote: true,
  };
  // Q4: when multi-query is enabled, run paraphrases in parallel and fuse with RRF.
  const result = (await isMultiQueryEnabled())
    ? await routeWithRRF(routeInput)
    : await route(routeInput);

  if (opts.strip) {
    // E2 — when no hits, print a clear placeholder rather than empty stdout.
    if (result.hits.length === 0) {
      return `[No results for: ${opts.query}]`;
    }
    return result.hits
      .map((h) => (h.note ? stripNoteToPrompt(h.note) : (h.snippet ?? h.id)))
      .join('\n\n');
  }

  if (opts.pretty) {
    const lines = [
      `[${result.levelUsed}] ${result.hits.length} hits in ${result.totalMs}ms\n`,
      ...result.hits.map(formatPretty),
    ];
    return lines.join('\n');
  }

  return JSON.stringify(
    {
      level: result.levelUsed,
      total_ms: result.totalMs,
      hits: result.hits.map((h) => ({
        id: h.id,
        path: h.path,
        score: h.score,
        level: h.level,
        note: h.note,
      })),
    },
    null,
    2,
  );
}

function formatPretty(h: ResolvedHit): string {
  const head = `  • ${h.id}  score=${h.score.toFixed(3)}  [${h.level}]`;
  const body = h.note?.facts.length
    ? h.note.facts
        .slice(0, 2)
        .map((f) => `      - ${f.text}`)
        .join('\n')
    : `      ${(h.snippet ?? '').slice(0, 160)}`;
  return `${head}\n${body}`;
}
