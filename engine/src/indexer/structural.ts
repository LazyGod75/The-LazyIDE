import { parseHTML } from 'linkedom';
import { stripTags } from '../retrieval/strip.js';
import { slug } from '../store/paths.js';
import { getLogger } from '../util/logger.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { countAllNotes, listAllNoteIds, notesByTagOrType } from './note-read.js';
import {
  type NoteFile,
  diskPathsForSlugs,
  distinctNoteIdSlugsCached,
  readAllNotes,
  readNote,
} from '../store/reader.js';

export interface StructuralHit {
  noteId: string;
  notePath: string;
  fragment: string; // HTML of the matched element
  text: string; // stripped text of the matched element
  attribute?: string; // when extracting a specific attribute
}

export interface StructuralQueryOptions {
  attribute?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// SQL pushdown — narrow the candidate note set via the SQLite `notes` index
// (idx_notes_type / notesByTagOrType, see note-read.ts) BEFORE reading and
// parsing any note HTML, instead of readAllNotes()'ing the whole corpus and
// filtering with linkedom after the fact.
//
// Measured root cause (audit, synthetic 2000-note fixture): readAllNotes()
// alone — the readFileSync of every note's HTML — took ~1.48s regardless of
// how selective the CSS selector was, because the old code read every note
// BEFORE the selector ever ran. Tag/type selectivity therefore had zero
// effect on cost. Routing through the index means we only readNote() the
// notes that can possibly match.
//
// Only a narrow, syntactically-recognized selector shape gets the fast path:
// an (optionally tag-qualified) attribute selector on `data-cerveau-type`
// (exact match, `=`) or `data-cerveau-tags` (word match, `~=`) as the FIRST
// compound selector, with no top-level comma (selector list). Both map
// 1:1 onto notesByTagOrType()'s WHERE clause (`type = @type` /
// `(' '||tags||' ') LIKE '% @tag %'`). Anything else — including selectors
// that merely CONTAIN one of these attributes deeper in a descendant chain,
// unquoted values, escaped quotes, `*=`/`^=`/`$=` operators, or a selector
// list — does NOT match the recognizer and silently falls back to the full
// scan. That is deliberate: correctness comes first, so the fast path only
// ever fires when the mapping to the SQL WHERE clause is unambiguous.
// ---------------------------------------------------------------------------

const ROOT_TAG = '(?:article|section|memory-batch)';
const TYPE_PUSHDOWN_RE = new RegExp(`^${ROOT_TAG}?\\[data-cerveau-type\\s*=\\s*(["'])([^"']*)\\1\\]`);
// Tolerates an optional trailing case-insensitivity flag ( i / I ) — see
// withTagCaseInsensitivity() below, which is what actually puts that flag
// there. data-cerveau-type is deliberately NOT given the same treatment: the
// owner's real brain has exactly 10 distinct `data-cerveau-type` values, all
// machine-generated (decision, file-neuron, ...) with zero case fragmentation
// (measured — see structural.test.ts's "type values are clean" note), so
// case-insensitivity would add matching cost/risk for a problem that does not
// exist in the data. Tags, by contrast, are free-text and 396 note-tag
// attachments in that same brain sit on a non-dominant case variant.
const TAGS_PUSHDOWN_RE = new RegExp(
  `^${ROOT_TAG}?\\[data-cerveau-tags\\s*~=\\s*(["'])([^"']*)\\1(?:\\s+[iIsS])?\\]`,
);

// ---------------------------------------------------------------------------
// Case-insensitive tag matching
//
// Root cause (measured on the owner's real brain via
// C:/Users/user/AppData/Local/Temp/.../tagfrag.cjs): 392 distinct tag
// strings collapse to 382 canonical concepts, with 396 note-tag attachments
// sitting on a non-dominant case variant (`lazy`:128 vs `Lazy`:429, etc.).
// `article[data-cerveau-tags~="Lazy"]` and `~="lazy"` returned DIFFERENT hit
// counts (307 vs 58) against the same brain — a selector typed in the
// "wrong" case silently loses the majority of matches.
//
// Where the case-sensitivity actually lives: SQLite's LIKE operator is
// ASCII-case-insensitive BY DEFAULT (no COLLATE NOCASE needed — verified
// against a real brain: `tags LIKE '% Lazy %'` / `'% lazy %'` / `'% LAZY %'`
// all returned the identical row count, 441, with no PRAGMA
// case_sensitive_like set anywhere in this codebase — see note-read.ts's
// notesByTagOrType() doc comment). So the SQL pushdown's own WHERE clause was
// NEVER the culprit; it already returns a case-insensitive SUPERSET of
// candidates for either case. The actual case-sensitive step was the final
// CSS match (querySelectorAll) that both the fast path and the full scan run
// against each candidate's parsed HTML in matchSelectorInNotes() — that step
// used the selector text verbatim, and CSS attribute selectors are
// case-sensitive by default.
//
// Fix: rewrite `[data-cerveau-tags~="X"]` (any occurrence, not just the
// pushdown-eligible leading one) to `[data-cerveau-tags~="X" i]` — linkedom's
// css-select (verified empirically, not assumed) DOES support the standard
// CSS `i` attribute-selector flag, and applies it to the WHOLE space-
// separated word for `~=`, not as a substring match: on a fixture where one
// note is tagged "Lazy", one "LAZY", and one "lazybrain", `~="lazy" i`
// matches only the first two — "lazybrain" is correctly excluded. This
// rewrite happens ONCE, at the very top of structuralQuery() /
// structuralQueryFullScanForTests(), before validation, before the pushdown
// recognizer, and before the CSS match — so both code paths operate on the
// byte-identical (already case-insensitive) selector string. That is what
// keeps fast path and full scan in exact parity: there is no second place
// where case-sensitivity could independently drift.
//
// No normalized/lowercased tags column was added to the index. The existing
// pushdown WHERE clause (`(' '||tags||' ') LIKE @tagPattern`, a leading-'%'
// LIKE) can never use a B-tree index in SQLite regardless of column
// casing — `idx_notes_type` only covers `type`, and a leading-wildcard LIKE
// forces a full table scan of `notes` either way (confirmed via EXPLAIN QUERY
// PLAN: `SCAN notes`). A normalized column would add a schema migration,
// a backfill of the whole corpus, and a second column to keep in sync on
// every write — for zero query-plan benefit, since the scan cost is already
// dominated by reading the `notes` table's rows, not by string comparison.
// ---------------------------------------------------------------------------

const TAGS_CI_ATTR_RE = /\[data-cerveau-tags\s*~=\s*(["'])([^"']*)\1(\s+[iIsS])?\]/g;

/**
 * Rewrite every `[data-cerveau-tags~="X"]` occurrence in `selector` to add
 * the CSS case-insensitivity flag ( i ), unless the caller already wrote an
 * explicit flag (including `s`, the explicit case-SENSITIVE opt-out) — an
 * explicit flag is always left untouched. data-cerveau-type attribute
 * selectors are never touched (see the design note above).
 */
export function withTagCaseInsensitivity(selector: string): string {
  return selector.replace(TAGS_CI_ATTR_RE, (match, quote: string, value: string, flag?: string) => {
    if (flag) return match; // caller already specified a flag — respect it verbatim
    return `[data-cerveau-tags~=${quote}${value}${quote} i]`;
  });
}

interface PushdownFilter {
  kind: 'type' | 'tag';
  value: string;
}

/**
 * Detect whether `selector`'s leading compound selector is an exact
 * `data-cerveau-type` or word-match `data-cerveau-tags` attribute check that
 * can be pushed down to SQL. Returns null (→ full scan) for anything not
 * unambiguously recognized, including selector lists (top-level comma) since
 * pushing down on one branch of an OR would wrongly exclude matches from the
 * other branches.
 *
 * Callers must pass the selector through withTagCaseInsensitivity() first
 * (structuralQuery() / structuralQueryFullScanForTests() both do this
 * unconditionally) — TAGS_PUSHDOWN_RE tolerates the resulting trailing flag.
 */
export function extractPushdownFilter(selector: string): PushdownFilter | null {
  const trimmed = selector.trim();
  if (hasTopLevelComma(trimmed)) return null;
  const typeMatch = trimmed.match(TYPE_PUSHDOWN_RE);
  if (typeMatch) return { kind: 'type', value: typeMatch[2] };
  const tagsMatch = trimmed.match(TAGS_PUSHDOWN_RE);
  if (tagsMatch) return { kind: 'tag', value: tagsMatch[2] };
  return null;
}

function hasTopLevelComma(selector: string): boolean {
  // Blank out quoted string contents first so a comma inside an attribute
  // value (e.g. [data-x="a,b"]) is never mistaken for a selector-list comma.
  const withoutQuotedStrings = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  return withoutQuotedStrings.includes(',');
}

/**
 * Set once the untrustworthy-index warning has been printed to stderr this
 * process, so a brain that stays mismatched doesn't flood the log with a
 * warning on every single structural query — mirrors reranker.ts's
 * `fallbackWarned` dedup pattern. Telemetry ('index_untrustworthy') is still
 * logged on every occurrence — see logTelemetry call below.
 */
let untrustworthyWarned = false;

/**
 * A candidate set is only trusted when every distinct note id represented on
 * disk (notes/ + batches/) has a matching row in the SQLite `notes` table.
 *
 * This is NOT a raw file-count comparison (that was the original, now-fixed
 * design — see distinctNoteIdSlugsCached()'s doc comment in store/reader.ts
 * for the full root cause). A mature brain accumulates orphaned duplicate
 * note files: notePath() partitions by the note's OWN `data-cerveau-created`
 * timestamp, and several regenerated note types (topic-overview, brain-index,
 * concept-*, aggregate-*, file-neuron) stamp that timestamp with "now" on
 * every regeneration instead of preserving the original. Once the calendar
 * month rolls over between two regenerations of the same id, the previous
 * file is silently left behind — a raw file count can NEVER equal the
 * indexed row count on such a brain (id is a SQL PRIMARY KEY, so there is
 * always exactly one row per id, while the same id can have many stale
 * files), which used to leave the fast path permanently disabled.
 *
 * The fix: compare the SET of distinct on-disk id slugs (deduped by
 * filename — see distinctNoteIdSlugsCached()) against the SET of indexed
 * ids (slugified the same way notePath() slugifies before naming a file).
 * The index is trusted iff every on-disk id has a matching row — i.e. disk
 * is a subset of the index. A stale duplicate's slug is already covered by
 * whichever file IS indexed for that id, so it does not break trust. Ghost
 * rows (indexed id with no file left on disk) are deliberately NOT checked
 * in the other direction: they cannot cause the fast path to miss a match
 * (lazyReadNotes() already skips a row whose file no longer exists), so
 * flagging them here would only produce spurious distrust on a brain where
 * notes were legitimately deleted.
 *
 * This does not catch a note edited in place without re-indexing (same id
 * set, stale content) — every normal write path (capture/store/compress/
 * index-update/etc.) calls indexNote() on write, so that case should not
 * occur in practice; if it does, it is a genuine indexing bug outside this
 * function's scope, not something an id-set check can detect.
 *
 * A mismatch is not just a perf detail — it silently converts every
 * structural query into an O(corpus) full scan, forever, until someone
 * happens to notice and repair the index. That is the same "quality
 * degradation that looks identical to success" shape as reranker.ts's
 * identity-ranking fallback, so it gets the same treatment: a one-time
 * stderr warning naming the exact counts and the repair command, plus a
 * telemetry event on every occurrence for anyone auditing retrieval health
 * after the fact (see TelemetryEvent's 'index_untrustworthy' variant).
 */
export interface IndexTrustResult {
  trustworthy: boolean;
  /**
   * On-disk id slugs with no matching row in the SQLite index. Empty when
   * `trustworthy` is true. `null` means the check itself failed (DB error) —
   * in that case we genuinely don't know what's missing, so the caller MUST
   * fall back to a full scan rather than attempting the hybrid path with an
   * (incorrectly) empty missing set. Exposed (not just the boolean) so
   * structuralQuery() can read exactly the missing notes directly instead of
   * re-scanning the whole corpus when the index is merely stale, not broken
   * — see the "hybrid fallback" comment on structuralQuery() below.
   */
  missingSlugs: ReadonlySet<string> | null;
}

/**
 * PERF NOTE (2026-08 audit): every step in this function is cheap — measured
 * on the owner's real ~9930-file / ~7800-row brain: countAllNotes() ~8ms,
 * listAllNoteIds()+slug() ~15ms, distinctNoteIdSlugsCached() ~1-25ms
 * (mtime-gated — near-zero once warm), the Set diff ~1ms. Total: under
 * 100ms, cold. This function is NOT the ~5s the audit set out to explain —
 * see structuralQuery()'s module doc for where that time actually goes.
 */
function checkIndexTrust(): IndexTrustResult {
  try {
    const indexedCount = countAllNotes();
    // The real on-disk filename is slug() applied to the raw content id via
    // TWO call sites — writer.ts's writeNote() slugifies the id extracted
    // from the HTML once, then notePath() (store/paths.ts) slugifies its
    // `id` argument again internally — but a single slug(id) call here is
    // enough: slug() is proven idempotent (slug(slug(x)) === slug(x) for
    // every input, including ids long enough to hit the 80-char truncation —
    // see store/paths.ts's slug() doc comment and __tests__/paths.test.ts,
    // which checks this against every distinct id in a real, mature brain).
    // Before that fix, slug() was NOT idempotent for ids where truncation
    // landed mid-hyphen, so comparing against a single application here
    // could flag a perfectly-indexed note as a disk/index mismatch forever —
    // an artificial floor under the fast path, the same shape of bug this
    // whole function exists to fix. Kept as a double application would now
    // be redundant, not merely safe.
    const indexedSlugs = new Set(listAllNoteIds().map((id) => slug(id)));
    // distinctNoteIdSlugsCached(), not a raw recursive count: the mtime-gated
    // per-month cache (store/reader.ts) makes this cheap to call on every
    // structural query in a long-lived process (`serve`) instead of a full
    // recursive readdir every time — see that function's doc comment for the
    // (narrow, measured) staleness caveat and why it doesn't matter for
    // either real caller of this function.
    const diskSlugs = distinctNoteIdSlugsCached();

    const missingSlugs = new Set<string>();
    for (const s of diskSlugs) {
      if (!indexedSlugs.has(s)) missingSlugs.add(s);
    }
    if (missingSlugs.size === 0) return { trustworthy: true, missingSlugs: new Set() };

    if (!untrustworthyWarned) {
      getLogger().warn(
        { indexed: indexedCount, onDisk: diskSlugs.size, missing: missingSlugs.size },
        'lazybrain: SQLite note index does not match notes on disk — structural queries are ' +
          'falling back to a full scan (slower, but complete) instead of the indexed fast path. ' +
          "Run `lazybrain reindex --missing` to repair.",
      );
      untrustworthyWarned = true;
    }
    logTelemetry({
      event: 'index_untrustworthy',
      ts: nowIso(),
      indexed_notes: indexedCount,
      disk_notes: diskSlugs.size,
      missing: missingSlugs.size,
    });
    return { trustworthy: false, missingSlugs };
  } catch {
    // Unknown state: cannot prove trust, and cannot enumerate what's missing
    // either — `missingSlugs: null` tells the caller to fall back to a
    // genuine full scan in this case (see structuralQuery() below), same as
    // the pre-existing behavior.
    return { trustworthy: false, missingSlugs: null };
  }
}

/** Test-only: reset the untrustworthy-index one-time warning dedup flag. */
export function resetIndexTrustworthyWarningForTests(): void {
  untrustworthyWarned = false;
}

/** Fetch every note matching the pushdown filter, path-only candidate set. */
function candidatePathsForPushdown(filter: PushdownFilter): string[] {
  // No result-count cap here (deliberately large limit): we need every
  // matching note as a CANDIDATE, because the CSS selector may still filter
  // some out (e.g. a `:not(...)` clause) — early-exit against the caller's
  // element-level `limit` happens in matchSelectorInNotes() below, one
  // readNote() at a time, so a common tag with a tiny limit still only reads
  // as many notes as it takes to satisfy the limit, not the whole match set.
  const rows = notesByTagOrType({
    type: filter.kind === 'type' ? filter.value : undefined,
    tag: filter.kind === 'tag' ? filter.value : undefined,
    includeExpired: true, // parity with the full scan, which never filters by valid_until
    limit: Number.MAX_SAFE_INTEGER,
  });
  return rows.map((r) => r.path);
}

/** Lazily readNote() each candidate path, one at a time, skipping files the index references but that no longer exist on disk. */
function* lazyReadNotes(paths: readonly string[]): Generator<NoteFile> {
  for (const path of paths) {
    try {
      yield readNote(path);
    } catch {
      continue; // stale index entry: file was deleted/moved after last index
    }
  }
}

/**
 * Run `selector` against `notes`, stopping as soon as `limit` elements have
 * matched. Shared by both the SQL-pushdown fast path and the full-scan
 * fallback so their matching semantics never drift apart.
 *
 * Deliberately NOT a `for...of` loop: that protocol always pulls the NEXT
 * value from the iterator before running the loop body, so with a lazy
 * generator (lazyReadNotes()) it would readNote() one candidate past the
 * limit on every call — silently defeating the "stop reading once the limit
 * is satisfied" guarantee the no-full-scan tests assert on. Pulling
 * manually via `iterator.next()` and checking the limit FIRST avoids that
 * one-ahead read.
 */
function matchSelectorInNotes(
  selector: string,
  notes: Iterable<NoteFile>,
  limit: number,
  attribute: string | undefined,
): StructuralHit[] {
  const out: StructuralHit[] = [];
  const iterator = notes[Symbol.iterator]();
  while (out.length < limit) {
    const next = iterator.next();
    if (next.done) break;
    const note = next.value;
    let document: ReturnType<typeof parseHTML>['document'];
    try {
      ({ document } = parseHTML(`<!doctype html><body>${note.html}</body>`));
    } catch {
      continue; // skip malformed notes silently
    }

    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      // This should not happen after the upfront validation, but guard anyway.
      continue;
    }

    for (const el of matches) {
      if (out.length >= limit) break;
      const fragment = el.outerHTML;
      const text = stripTags(fragment);
      const attr = attribute ? (el.getAttribute(attribute) ?? '') : undefined;
      out.push({
        noteId: note.id,
        notePath: note.path,
        fragment,
        text,
        attribute: attr,
      });
    }
  }
  return out;
}

/**
 * Run a CSS selector across the entire brain.
 * L1 query: deterministic. Attribute/tag-scoped selectors that map onto the
 * SQLite `notes` index (see extractPushdownFilter above) only read+parse the
 * matching candidates; everything else falls back to a full scan of every
 * note, same as before.
 *
 * Hybrid fallback (2026-08 perf audit): a naive "index untrustworthy → full
 * scan" fallback is CORRECT but pays for the whole corpus even when only a
 * handful of notes are actually missing from the index. Measured on the
 * owner's real ~9930-file brain: readAllNotes() alone (raw file I/O, no
 * parsing yet) took ~5.6s, which is where the previously-reported ~5s
 * "fixed overhead" on every structural query actually came from — NOT
 * checkIndexTrust() itself (measured under 100ms cold, near-zero warm; see
 * its doc comment). The trust check already enumerates exactly which on-disk
 * slugs are missing from the index (missingSlugs), so instead of discarding
 * that and re-scanning everything, we read ONLY those files directly and
 * union them with the normal SQL-pushdown candidates. Every on-disk note is
 * covered by exactly one of the two sources — "indexed" and "missing" are a
 * strict partition of the disk set by construction (checkIndexTrust()'s
 * `missingSlugs` is precisely "on-disk slug with no index row") — so this is
 * as complete as the full scan, at a cost proportional to the actual drift
 * instead of the corpus size. Only checkIndexTrust()'s DB-error case (
 * `missingSlugs: null`, genuinely unknown state) still falls back to the
 * real full scan, since there is nothing safe to enumerate in that case.
 *
 * The selector is applied per-note (each note is its own document).
 * Cross-note selectors are not supported (use href for cross-references).
 *
 * @throws {Error} "Invalid CSS selector: <selector> — <reason>" when the
 *   selector is syntactically invalid (unparseable by linkedom). Callers
 *   must distinguish this from a valid-but-empty result (returns []).
 */
export function structuralQuery(
  selector: string,
  opts: StructuralQueryOptions = {},
): StructuralHit[] {
  // Case-insensitive tag matching, applied ONCE up front — see
  // withTagCaseInsensitivity()'s doc comment above for why this single
  // rewrite point is what keeps the fast path and the full scan in exact
  // parity for case variants. Every downstream step (validation, the
  // pushdown recognizer, and the actual CSS match) sees the same string.
  const normalized = withTagCaseInsensitivity(selector);

  // Validate the selector upfront against a minimal document so we can
  // distinguish "invalid selector" (hard error, exit 1) from "valid selector,
  // zero matches" (empty result, exit 0).
  validateSelector(normalized);

  const limit = opts.limit ?? 100;

  const filter = extractPushdownFilter(normalized);
  if (filter) {
    const trust = checkIndexTrust();

    // candidatePathsForPushdown() itself hits the same SQLite DB — deliberately
    // NOT called for the `missingSlugs === null` (DB error) case below: if
    // checkIndexTrust() already failed to reach the DB, a second SQL query
    // here would just throw too, defeating the graceful full-scan fallback.
    if (trust.trustworthy) {
      const indexedPaths = candidatePathsForPushdown(filter);
      return matchSelectorInNotes(normalized, lazyReadNotes(indexedPaths), limit, opts.attribute);
    }

    if (trust.missingSlugs !== null) {
      // Hybrid fallback — see module doc above: SQL-pushdown candidates
      // (everything the index DOES know about) plus a direct read of the
      // notes the index is missing (everything it doesn't). Disjoint by
      // construction, so no note is read twice and none is skipped.
      const indexedPaths = candidatePathsForPushdown(filter);
      const missingPaths = diskPathsForSlugs(trust.missingSlugs);
      return matchSelectorInNotes(
        normalized,
        lazyReadNotes([...indexedPaths, ...missingPaths]),
        limit,
        opts.attribute,
      );
    }
    // Unknown state (DB error) — cannot safely enumerate what's missing, so
    // fall through to the genuine full scan below.
  }

  return matchSelectorInNotes(normalized, readAllNotes(), limit, opts.attribute);
}

/**
 * Test-only: always run the full-scan path (readAllNotes() over every note),
 * bypassing the SQL-pushdown recognizer entirely. Used by structural.test.ts
 * as the known-correct baseline to assert the fast path returns exactly the
 * same result SET for pushdown-eligible selectors — i.e. that the fix never
 * changes what a query returns, only how fast it gets there.
 */
export function structuralQueryFullScanForTests(
  selector: string,
  opts: StructuralQueryOptions = {},
): StructuralHit[] {
  // Same upfront normalization as structuralQuery() — this baseline must
  // apply case-insensitivity too, or it would no longer be a valid parity
  // baseline for case-variant selectors (see withTagCaseInsensitivity()).
  const normalized = withTagCaseInsensitivity(selector);
  validateSelector(normalized);
  return matchSelectorInNotes(normalized, readAllNotes(), opts.limit ?? 100, opts.attribute);
}

/**
 * Validate a CSS selector by running it against an empty document.
 * Throws with a descriptive message if linkedom rejects it.
 */
function validateSelector(selector: string): void {
  try {
    const { document } = parseHTML('<!doctype html><body></body>');
    document.querySelectorAll(selector);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid CSS selector: ${selector} — ${reason}`, { cause: err });
  }
}
