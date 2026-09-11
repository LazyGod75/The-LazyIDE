/**
 * note-helpers.ts — Tag caches, topic helpers, Wikipedia-layer functions,
 *                   structural field boost, and timeline queries.
 *
 * All helpers operate on the read path (no writes) except recordAccess variants
 * (which live in note-read.ts). The tag cache is module-level state — one
 * invalidation per process, 60s TTL.
 */

import { getDb } from './db.js';
import type { IndexedNote, StructuralBoostHit } from './note-types.js';

// ---------------------------------------------------------------------------
// Tag cache
// ---------------------------------------------------------------------------

const TAG_CACHE_TTL = 60_000;

/**
 * Return all distinct tags used across active notes.
 * Cached for 60 seconds to avoid repeated SQL on hot paths.
 */
let _tagCache: { tags: string[]; ts: number } | null = null;

export function allDistinctTags(): string[] {
  const now = Date.now();
  if (_tagCache && now - _tagCache.ts < TAG_CACHE_TTL) return _tagCache.tags;

  const db = getDb();
  const rows = db
    .prepare(`
    SELECT DISTINCT tags FROM notes
    WHERE (valid_until IS NULL OR valid_until = '')
      AND tags IS NOT NULL AND tags != ''
  `)
    .all() as Array<{ tags: string }>;

  const tagSet = new Set<string>();
  for (const row of rows) {
    for (const tag of row.tags.split(/\s+/).filter(Boolean)) {
      tagSet.add(tag.toLowerCase());
    }
  }

  const tags = [...tagSet].sort();
  _tagCache = { tags, ts: now };
  return tags;
}

/**
 * Return the number of active notes carrying the given tag.
 * Used by the retrieval router to determine whether a tag-based structural
 * lookup is selective enough to be trusted as a shortcut.
 *
 * Counts notes where the space-separated tags column contains the exact tag
 * as a whole word. Cached for 60 seconds alongside the tag list.
 */
let _tagCountCache: { counts: Map<string, number>; ts: number } | null = null;

export function getTagNoteCount(tag: string): number {
  const now = Date.now();
  if (_tagCountCache && now - _tagCountCache.ts < TAG_CACHE_TTL) {
    return _tagCountCache.counts.get(tag.toLowerCase()) ?? 0;
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT tags FROM notes
       WHERE (valid_until IS NULL OR valid_until = '')
         AND tags IS NOT NULL AND tags != ''`,
    )
    .all() as Array<{ tags: string }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const t of row.tags.split(/\s+/).filter(Boolean)) {
      const key = t.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  _tagCountCache = { counts, ts: now };
  return counts.get(tag.toLowerCase()) ?? 0;
}

// ---------------------------------------------------------------------------
// Wikipedia layer helpers — used by inject-context highlights
// ---------------------------------------------------------------------------

/**
 * Top concept tokens across all active notes, sorted by frequency.
 * Returns up to `limit` entries with their note counts.
 */
export function topConcepts(limit: number): Array<{ concept: string; count: number }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT concepts FROM notes WHERE (valid_until IS NULL OR valid_until = '') AND concepts IS NOT NULL AND concepts != ''`,
    )
    .all() as Array<{ concepts: string }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const c of row.concepts.split(',').filter(Boolean)) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([concept, count]) => ({ concept, count }));
}

/**
 * Active decision notes: type='decision', valid_until empty, created within daysBack days.
 * Sorted by importance DESC.
 */
export function activeDecisions(daysBack: number, limit: number): IndexedNote[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT * FROM notes
       WHERE type = 'decision'
         AND (valid_until IS NULL OR valid_until = '')
         AND created >= ?
       ORDER BY COALESCE(importance, 0) DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as IndexedNote[];
}

export interface RecentChange {
  id: string;
  kind: 'replaced' | 'invalidated';
  targetId?: string;
  created: string;
}

/**
 * Notes with valid_until set in last daysBack days (invalidated),
 * OR notes whose replaces is non-empty created in last daysBack days (replacements).
 */
export function recentChanges(daysBack: number): RecentChange[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  const out: RecentChange[] = [];

  // Invalidated
  const invalidated = db
    .prepare(
      `SELECT id, created, valid_until FROM notes WHERE valid_until IS NOT NULL AND valid_until != '' AND valid_until >= ?`,
    )
    .all(cutoff) as Array<{ id: string; created: string; valid_until: string }>;
  for (const r of invalidated) {
    out.push({ id: r.id, kind: 'invalidated', created: r.created });
  }

  // Replacements
  const replaced = db
    .prepare(
      `SELECT id, created, replaces FROM notes WHERE replaces IS NOT NULL AND replaces != '' AND created >= ?`,
    )
    .all(cutoff) as Array<{ id: string; created: string; replaces: string }>;
  for (const r of replaced) {
    const targetId = r.replaces.split(',')[0];
    out.push({ id: r.id, kind: 'replaced', targetId, created: r.created });
  }

  // Sort by created desc
  out.sort((a, b) => b.created.localeCompare(a.created));
  return out.slice(0, 10);
}

/**
 * Normalize a filesystem path for cwd matching: backslash → forward slash,
 * lower-cased, no trailing slash. Applied to both the caller's raw `cwd` and
 * the stored `source`/`id`/`path` column values before comparison.
 */
function normalizeForCwdMatch(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * True when `field` contains `cwd` as a genuine path segment — not merely as
 * a substring prefix of a sibling project's name (e.g. cwd "…/lazy" must NOT
 * match a field containing "…/lazybrain" or "…/lazysite-internet", both real
 * sibling top-level project buckets in a shared multi-project brain that
 * happen to start with the same five letters). Mirrors the boundary rule
 * already fixed for topic matching by sections.ts's topicBelongsToProject
 * (same bug class, same real ~7000-note shared brain — a bare
 * `field.includes(cwd)` previously undercounted to zero via a separator
 * mismatch and, once that was fixed naively, over-counted via this exact
 * prefix trap).
 */
function containsCwdSegment(field: string, cwd: string): boolean {
  const idx = field.indexOf(cwd);
  if (idx === -1) return false;
  const after = field.charAt(idx + cwd.length);
  return after === '' || after === '/';
}

/**
 * Count notes and active decisions for a given cwd, plus top tags.
 *
 * `source` holds "code-scanner:<root>" for code notes and "session:<id>" for
 * conversation notes — both contain the project path. `id` and `path` also
 * carry the project path for broader coverage.
 *
 * Two matching bugs fixed here (2026-08-16, measured against a real
 * ~6000-note shared brain): (1) the raw `LIKE '%' || cwd || '%'` compared an
 * un-normalized cwd against backslash-separated stored paths on Windows —
 * `cwd` arrives forward-slashed (e.g. from inject-context's `--cwd` flag)
 * while `source` stores `code-scanner:C:\Users\...\Lazy`, so the match was
 * ALWAYS empty for every real Windows project, silently falling back to
 * `notesForCwdCountFallback`'s brain-wide, LIMIT-300-capped scan — a
 * meaningless number (exactly the LIMIT, whenever the brain has more than
 * 300 active notes) reported as if it were this project's count. (2) a naive
 * substring fix without a path-boundary check would then let cwd "…/lazy"
 * match sibling buckets "…/lazybrain" etc. — see containsCwdSegment.
 *
 * The SQL `LIKE` below is a cheap pre-filter (case/separator-insensitive via
 * `REPLACE`/`LOWER`) to avoid a full table scan; `containsCwdSegment` then
 * applies the exact boundary check in JS. No LIMIT is applied — a project's
 * own note count must be exact, not truncated (unlike the deliberately
 * capped last-resort fallback below).
 */
export function notesForCwdCount(cwd: string): {
  count: number;
  activeDecisions: number;
  topTags: string[];
} {
  const db = getDb();
  const normalizedCwd = normalizeForCwdMatch(cwd);
  if (!normalizedCwd) return notesForCwdCountFallback(db);

  const escaped = `%${normalizedCwd}%`;
  const rawRows = db
    .prepare(
      `SELECT type, tags, source, id, path FROM notes
       WHERE REPLACE(LOWER(source), '\\', '/') LIKE ?
          OR REPLACE(LOWER(id), '\\', '/') LIKE ?
          OR REPLACE(LOWER(path), '\\', '/') LIKE ?`,
    )
    .all(escaped, escaped, escaped) as Array<{
    type: string | null;
    tags: string | null;
    source: string | null;
    id: string;
    path: string;
  }>;

  const notes = rawRows.filter(
    (r) =>
      containsCwdSegment(normalizeForCwdMatch(r.source ?? ''), normalizedCwd) ||
      containsCwdSegment(normalizeForCwdMatch(r.id ?? ''), normalizedCwd) ||
      containsCwdSegment(normalizeForCwdMatch(r.path ?? ''), normalizedCwd),
  );

  // Fall back to full scan when cwd not found in any column
  if (notes.length === 0) {
    return notesForCwdCountFallback(db);
  }

  return buildCwdCountResult(notes);
}

function notesForCwdCountFallback(db: ReturnType<typeof getDb>): {
  count: number;
  activeDecisions: number;
  topTags: string[];
} {
  const all = db
    .prepare(`SELECT type, tags FROM notes WHERE valid_until IS NULL OR valid_until = '' LIMIT 300`)
    .all() as Array<{ type: string | null; tags: string | null }>;
  const counts = new Map<string, number>();
  let decisions = 0;
  for (const n of all) {
    if (n.type === 'decision') decisions++;
    for (const t of (n.tags ?? '').split(/\s+/).filter(Boolean)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const topTags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  return { count: all.length, activeDecisions: decisions, topTags };
}

function buildCwdCountResult(notes: Array<{ type: string | null; tags: string | null }>): {
  count: number;
  activeDecisions: number;
  topTags: string[];
} {
  const tagCounts = new Map<string, number>();
  let decisions = 0;
  for (const n of notes) {
    if (n.type === 'decision') decisions++;
    for (const t of (n.tags ?? '').split(/\s+/).filter(Boolean)) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  return { count: notes.length, activeDecisions: decisions, topTags };
}

// ---------------------------------------------------------------------------
// Note vocabulary census — inject-context highlights [TAGS] block
// ---------------------------------------------------------------------------

export interface VocabularyCount {
  value: string;
  count: number;
}

export interface NoteVocabulary {
  types: VocabularyCount[];
  tags: VocabularyCount[];
}

/**
 * Cheap census of the note `type`s and `tags` ACTUALLY present in the brain,
 * with real population counts. Feeds inject-context highlights mode's
 * `[TAGS]` block (sections.ts's buildTagVocabularyBlock) — the vocabulary
 * the model can target with brain_query_css (data-cerveau-type="…" /
 * data-cerveau-tags~="…") instead of guessing at values that may not exist.
 * NEVER hardcoded: entirely derived from the SQLite index at call time, so a
 * brain's real type/tag set (which varies per brain — e.g. this repo's own
 * brain carries file-neuron/topic-overview/concept/aggregate-neuron/learning
 * alongside the five original decision/episodic/reference/semantic/
 * procedural types) is always what gets reported.
 *
 * A single `SELECT type, tags FROM notes` (optionally topic-scoped) reads
 * only the two indexed TEXT columns — never note HTML — so this stays cheap
 * even against a multi-thousand-note brain, the same "SQL pushdown, not a
 * full corpus read" principle structural.ts applies to tag/type-scoped
 * queries (see that module's doc comment).
 *
 * @param topicSlug When given, scopes to notes whose `topic` column is
 *   exactly `topicSlug` or starts with `topicSlug/`, case-insensitively
 *   (mirrors inject-context/sections.ts's topicBelongsToProject matching).
 *   Omit for a brain-wide census.
 * @param tagLimit Max tag entries returned, most-frequent first (types are
 *   capped much higher since the type vocabulary is small by construction —
 *   never observed above a couple dozen even on a large shared brain).
 */
export function noteVocabularyCensus(topicSlug?: string, tagLimit = 12): NoteVocabulary {
  const db = getDb();
  const where = [`(valid_until IS NULL OR valid_until = '')`];
  const params: string[] = [];
  if (topicSlug) {
    where.push('(LOWER(topic) = ? OR LOWER(topic) LIKE ?)');
    params.push(topicSlug.toLowerCase(), `${topicSlug.toLowerCase()}/%`);
  }
  const rows = db
    .prepare(`SELECT type, tags FROM notes WHERE ${where.join(' AND ')}`)
    .all(...params) as Array<{ type: string | null; tags: string | null }>;

  const typeCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.type) typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1);
    for (const tag of (row.tags ?? '').split(/\s+/).filter(Boolean)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const toSorted = (counts: Map<string, number>, limit: number): VocabularyCount[] =>
    [...mergeCaseVariants(counts).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, count]) => ({ value, count }));

  return {
    types: toSorted(typeCounts, 24),
    tags: toSorted(tagCounts, tagLimit),
  };
}

/**
 * Merge case-variant duplicates of the same value (e.g. "Lazy" and "lazy")
 * into a single entry: the DOMINANT case form (the variant with the highest
 * individual count; ties keep the first-seen form) with the COMBINED count
 * across all variants.
 *
 * Real-brain motivation (2026-08-16): CSS attribute selectors
 * (`data-cerveau-tags~="…"`) are case-sensitive, but tag values are free text
 * written at capture time with no case normalization, so the same concept
 * regularly splits into two vocabulary entries — observed on the owner's
 * brain as `Trading:518`/`trading:100`, `Lazy:429`/`lazy:128`,
 * `LazyBrain:340`/`lazybrain:89`, `LazySite-internet:154`/
 * `lazysite-internet:68` (10 concepts split, 396 attachments stranded on the
 * minority-case variant). A model that copies the lower-count variant from
 * this vocabulary block into a `brain_query_css` selector silently misses
 * most of the matching notes. Merging here — once, at the source of the
 * `[TAGS]` block's data — fixes every caller without touching the
 * case-sensitive matching layer itself (`structural.ts`/`note-read.ts`,
 * out of scope for this fix and being made case-insensitive separately).
 */
function mergeCaseVariants(counts: Map<string, number>): Map<string, number> {
  const grouped = new Map<string, Map<string, number>>();
  for (const [value, count] of counts) {
    const key = value.toLowerCase();
    const variants = grouped.get(key) ?? new Map<string, number>();
    variants.set(value, (variants.get(value) ?? 0) + count);
    grouped.set(key, variants);
  }

  const merged = new Map<string, number>();
  for (const variants of grouped.values()) {
    let dominant = '';
    let dominantCount = -1;
    let total = 0;
    for (const [variant, count] of variants) {
      total += count;
      if (count > dominantCount) {
        dominant = variant;
        dominantCount = count;
      }
    }
    merged.set(dominant, total);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Structural field boost — Item 2
// ---------------------------------------------------------------------------

const STRUCTURAL_EXACT_BOOST = 1.5;

/**
 * Post-process BM25 / cosine hits by boosting notes whose structural fields
 * (`data-cerveau-topic`, `data-code-file`, or module-level tags) contain an
 * exact word-boundary match for any token in the query.
 *
 * Boost factor: STRUCTURAL_EXACT_BOOST (1.5×). Multiplicative, so a note
 * that already ranks high gets an even larger absolute lift.
 *
 * No hardcoded terms — the match is purely token ↔ field-segment comparison.
 *
 * @param hits   Array of hits with scores and structural fields.
 * @param query  Raw user query string.
 * @returns New array sorted descending by boosted score.
 */
export function applyStructuralFieldBoost<T extends StructuralBoostHit>(
  hits: T[],
  query: string,
): T[] {
  if (hits.length === 0) return hits;

  // Extract non-trivial tokens from the query (≥ 2 chars, no pure stop-words)
  const STOP = new Set([
    'a',
    'an',
    'and',
    'as',
    'at',
    'be',
    'by',
    'do',
    'for',
    'from',
    'how',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'the',
    'to',
    'up',
    'we',
  ]);
  const queryTokens = query
    .toLowerCase()
    .split(/[\s/.,;:?!()[\]{}"'`\\]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));

  if (queryTokens.length === 0) return hits;

  const boosted = hits.map((h) => {
    const structuralSegments = buildStructuralSegments(h);
    const hasStructuralMatch = queryTokens.some((t) => structuralSegments.has(t));
    if (!hasStructuralMatch) return h;
    return { ...h, score: h.score * STRUCTURAL_EXACT_BOOST };
  });

  return [...boosted].sort((a, b) => b.score - a.score);
}

function buildStructuralSegments(h: StructuralBoostHit): Set<string> {
  const segments = new Set<string>();
  // topic: "myproject/auth/oauth" → ["myproject", "auth", "oauth"]
  for (const seg of (h.topic ?? '')
    .toLowerCase()
    .split(/[\s/._-]+/)
    .filter(Boolean)) {
    segments.add(seg);
  }
  // codeFile: "src/retrieval/router.ts" → ["src", "retrieval", "router", "ts"]
  for (const seg of (h.codeFile ?? '')
    .toLowerCase()
    .split(/[\s/._-]+/)
    .filter(Boolean)) {
    segments.add(seg);
  }
  // tags: "code typescript myproject" → ["code", "typescript", "myproject"]
  for (const seg of (h.tags ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
    segments.add(seg);
  }
  return segments;
}
