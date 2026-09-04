/**
 * nl-structural.ts — NL-to-structural query resolver.
 *
 * Attempts to resolve a natural-language query via SQL tag/type lookup.
 * Returns empty array if no structural match is possible or if the matched
 * tags are too high-frequency to produce relevant results without FTS scoring.
 *
 * Extracted from router.ts for size reduction.
 */

import { allDistinctTags, getTagNoteCount, notesByTagOrType } from '../indexer/fts.js';
import type { ResolvedHit } from './router-types.js';

/**
 * Maximum note count for a tag to be considered "selective" enough for the
 * structural shortcut.
 */
const STRUCTURAL_TAG_MAX_NOTES = 50;

/**
 * Maximum number of meaningful tokens in a query for the structural shortcut
 * to apply.
 */
const STRUCTURAL_MAX_QUERY_TOKENS = 2;

const TYPE_MAP: Record<string, string> = {
  decision: 'decision',
  decisions: 'decision',
  décision: 'decision',
  décisions: 'decision',
  episodic: 'episodic',
  reference: 'reference',
  références: 'reference',
  procedural: 'procedural',
  procedure: 'procedural',
  procédure: 'procedural',
};

const TAG_BLOCKLIST = new Set(['bug', 'test', 'fix', 'config', 'docs', 'next']);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
  'all',
  'my',
  'me',
  'i',
  'we',
  'our',
  'us',
  'show',
  'list',
  'find',
  'get',
  'give',
  'tell',
  'about',
  'notes',
  'tagged',
]);

/**
 * Attempt to resolve a natural-language query via structural tag/type lookup.
 * Returns empty array if no structural match is possible or if the matched
 * tags are too high-frequency to produce relevant results without FTS scoring.
 */
export function tryNlToStructural(
  query: string,
  topK: number,
  _sourcePrefix?: string,
): ResolvedHit[] {
  const lower = query.toLowerCase();

  const KNOWN_TAGS = allDistinctTags().filter((t) => !TAG_BLOCKLIST.has(t));

  // Detect type mention
  let matchedType: string | undefined;
  for (const [keyword, type] of Object.entries(TYPE_MAP)) {
    if (lower.includes(keyword)) {
      matchedType = type;
      break;
    }
  }

  // Detect tag mentions (must be a word boundary match).
  const matchedTags: string[] = [];
  for (const tag of KNOWN_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(query)) {
      matchedTags.push(tag);
    }
  }

  if (matchedTags.length === 0 && !matchedType) return [];

  const isComplex = /\b(why|how|explain|compare|difference|versus|vs)\b/i.test(lower);
  if (isComplex && !matchedType) return [];

  // Selectivity gate (tag-only paths, not type-based)
  if (!passesSelectivityGate(query, matchedTags, matchedType)) return [];

  const results = notesByTagOrType({
    tag: matchedTags[0],
    type: matchedType,
    limit: topK * 2,
    includeExpired: false,
  });

  if (results.length === 0) return [];

  return scoreAndSlice(results, matchedTags, topK);
}

function passesSelectivityGate(
  query: string,
  matchedTags: string[],
  matchedType: string | undefined,
): boolean {
  if (matchedTags.length === 0 || matchedType) return true;

  const meaningfulTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  if (meaningfulTokens.length > STRUCTURAL_MAX_QUERY_TOKENS) return false;

  for (const tag of matchedTags) {
    if (getTagNoteCount(tag) >= STRUCTURAL_TAG_MAX_NOTES) return false;
  }
  return true;
}

function scoreAndSlice(
  results: ReturnType<typeof notesByTagOrType>,
  matchedTags: string[],
  topK: number,
): ResolvedHit[] {
  const scored = results.map((n) => {
    const noteTags = (n.tags ?? '').toLowerCase();
    let tagScore = 0;
    for (const tag of matchedTags) {
      if (noteTags.includes(tag)) tagScore++;
    }
    return { note: n, tagScore };
  });

  scored.sort((a, b) => {
    if (b.tagScore !== a.tagScore) return b.tagScore - a.tagScore;
    return (b.note.importance ?? 0) - (a.note.importance ?? 0);
  });

  return scored.slice(0, topK).map(({ note }) => ({
    id: note.id,
    path: note.path,
    score: 1.0,
    level: 'L1' as const,
    snippet: (note.title ?? '').slice(0, 280),
  }));
}
