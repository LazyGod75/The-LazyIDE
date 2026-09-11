/**
 * structural.test.ts — SQL-pushdown correctness + no-full-scan regression
 * tests for structuralQuery(). See structural.ts's module doc for the
 * design: extractPushdownFilter() recognizes a narrow, unambiguous selector
 * shape ([data-cerveau-type="X"] / [data-cerveau-tags~="X"]) and routes it
 * through notesByTagOrType() (the SQLite `notes` index) instead of
 * readAllNotes()'ing the whole corpus. indexIsTrustworthy() gates the fast
 * path off whenever the index row count doesn't match the on-disk file
 * count, so an unindexed/partially-indexed brain always falls back to the
 * full scan rather than silently dropping matches.
 *
 * Coverage:
 *  1. extractPushdownFilter — which selector shapes get the fast path.
 *  2. Correctness parity — fast path returns the exact same result SET as
 *     structuralQueryFullScanForTests() (the known-correct baseline), for
 *     both a rare and a common attribute value, including compound
 *     selectors (:not(...)) and a selector-list (comma) that must NOT be
 *     pushed down.
 *  3. Freshness gate — an unindexed note on disk is still found (falls back
 *     to full scan) rather than silently missed.
 *  4. No-full-scan — the fast path's readNote() call count scales with the
 *     MATCHING set (and, under a tight limit, with the limit), never with
 *     total corpus size. This is the direct, non-mocked proof requested by
 *     the audit: tag selectivity must visibly affect cost.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';
import { extractPushdownFilter, withTagCaseInsensitivity } from '../structural.js';

let tmpDir: string;
let brainDir: string;
let notesPath: string;
let cachePath: string;

function noteHtml(id: string, type: string, tags: string, extra = ''): string {
  return (
    `<article id="${id}" data-cerveau-type="${type}" data-cerveau-tags="${tags}" ` +
    `data-cerveau-created="2026-01-01T00:00:00Z">${extra}<h1>${id}</h1><p>Body text for ${id}.</p></article>`
  );
}

function writeNoteFile(id: string, html: string): string {
  const fp = join(notesPath, `${id}.html`);
  writeFileSync(fp, html, 'utf-8');
  return fp;
}

async function writeAndIndex(id: string, type: string, tags: string, extra = ''): Promise<void> {
  const { indexNote } = await import('../fts.js');
  const { readNote } = await import('../../store/reader.js');
  const fp = writeNoteFile(id, noteHtml(id, type, tags, extra));
  indexNote(readNote(fp));
}

function sortedIds(hits: Array<{ noteId: string }>): string[] {
  return hits.map((h) => h.noteId).sort();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-structural-test-'));
  brainDir = join(tmpDir, 'brain');
  notesPath = join(brainDir, 'notes');
  cachePath = join(tmpDir, 'cache');
  mkdirSync(notesPath, { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  resetConfigForTests();
});

afterEach(async () => {
  const { closeDb } = await import('../fts.js');
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 1. extractPushdownFilter — selector-shape recognizer
// ---------------------------------------------------------------------------

describe('extractPushdownFilter — recognized vs. fallback selector shapes', () => {
  it('recognizes a bare data-cerveau-type attribute selector', () => {
    expect(extractPushdownFilter('[data-cerveau-type="decision"]')).toEqual({
      kind: 'type',
      value: 'decision',
    });
  });

  it('recognizes a tag-qualified data-cerveau-type selector', () => {
    expect(extractPushdownFilter('article[data-cerveau-type="bug"]')).toEqual({
      kind: 'type',
      value: 'bug',
    });
    expect(extractPushdownFilter('section[data-cerveau-type="reference"]')).toEqual({
      kind: 'type',
      value: 'reference',
    });
    expect(extractPushdownFilter('memory-batch[data-cerveau-type="batch"]')).toEqual({
      kind: 'type',
      value: 'batch',
    });
  });

  it('recognizes a data-cerveau-tags word-match (~=) selector', () => {
    expect(extractPushdownFilter('[data-cerveau-tags~="auth"]')).toEqual({
      kind: 'tag',
      value: 'auth',
    });
  });

  it('recognizes a compound selector where the type check is the leading condition', () => {
    // The real-world example from structural_query.rs's doc comment: type is
    // a necessary AND condition, so pushing down on it is safe even though
    // :not(...) narrows the result further at the DOM-verification stage.
    expect(
      extractPushdownFilter(
        'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])',
      ),
    ).toEqual({ kind: 'type', value: 'decision' });
  });

  it('recognizes a descendant-combinator selector when the type check leads', () => {
    expect(extractPushdownFilter('article[data-cerveau-type="decision"] .fact')).toEqual({
      kind: 'type',
      value: 'decision',
    });
  });

  it('falls back (null) for a selector list (top-level comma) — OR semantics cannot be pushed down', () => {
    expect(
      extractPushdownFilter('[data-cerveau-type="bug"], [data-cerveau-type="feature"]'),
    ).toBeNull();
  });

  it('falls back (null) for an exact (=) match on data-cerveau-tags — different semantics than ~=', () => {
    // tags="bug urgent" satisfies ~="bug" but NOT ="bug"; pushing this down
    // via notesByTagOrType's word-match would silently change the result.
    expect(extractPushdownFilter('[data-cerveau-tags="bug"]')).toBeNull();
  });

  it('falls back (null) for substring/prefix/suffix operators', () => {
    expect(extractPushdownFilter('[data-cerveau-type*="bug"]')).toBeNull();
    expect(extractPushdownFilter('[data-cerveau-type^="bu"]')).toBeNull();
    expect(extractPushdownFilter('[data-cerveau-type$="ug"]')).toBeNull();
  });

  it('falls back (null) for an unrelated/unindexed attribute selector', () => {
    expect(extractPushdownFilter('aside[role="doc-warning"]')).toBeNull();
    expect(extractPushdownFilter('data[value*="src/auth"]')).toBeNull();
  });

  it('falls back (null) when the type/tags attribute is not the leading compound', () => {
    expect(extractPushdownFilter('.fact [data-cerveau-type="decision"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1b. withTagCaseInsensitivity — the selector rewrite that makes tag
// matching case-insensitive on BOTH code paths (see structural.ts's design
// note above extractPushdownFilter for the full rationale).
// ---------------------------------------------------------------------------

describe('withTagCaseInsensitivity — selector rewrite', () => {
  it('adds the i flag to a bare data-cerveau-tags ~= selector', () => {
    expect(withTagCaseInsensitivity('[data-cerveau-tags~="Lazy"]')).toBe(
      '[data-cerveau-tags~="Lazy" i]',
    );
  });

  it('adds the i flag to a tag-qualified selector, leaving the tag name untouched', () => {
    expect(withTagCaseInsensitivity('article[data-cerveau-tags~="Lazy"]')).toBe(
      'article[data-cerveau-tags~="Lazy" i]',
    );
  });

  it('rewrites every occurrence in a compound/descendant/selector-list selector', () => {
    expect(
      withTagCaseInsensitivity('.foo [data-cerveau-tags~="a"] h1, .bar[data-cerveau-tags~="b"]'),
    ).toBe('.foo [data-cerveau-tags~="a" i] h1, .bar[data-cerveau-tags~="b" i]');
  });

  it('is idempotent — an already-flagged selector is left byte-identical', () => {
    expect(withTagCaseInsensitivity('article[data-cerveau-tags~="Lazy" i]')).toBe(
      'article[data-cerveau-tags~="Lazy" i]',
    );
  });

  it('respects an explicit case-SENSITIVE (s) opt-out instead of overriding it', () => {
    expect(withTagCaseInsensitivity('article[data-cerveau-tags~="Lazy" s]')).toBe(
      'article[data-cerveau-tags~="Lazy" s]',
    );
  });

  it('never touches data-cerveau-type, or an exact (=) match on data-cerveau-tags', () => {
    expect(withTagCaseInsensitivity('article[data-cerveau-type="bug"]')).toBe(
      'article[data-cerveau-type="bug"]',
    );
    expect(withTagCaseInsensitivity('article[data-cerveau-tags="Lazy"]')).toBe(
      'article[data-cerveau-tags="Lazy"]',
    );
  });

  it('extractPushdownFilter still recognizes the rewritten (flagged) selector shape', () => {
    const rewritten = withTagCaseInsensitivity('[data-cerveau-tags~="Lazy"]');
    expect(extractPushdownFilter(rewritten)).toEqual({ kind: 'tag', value: 'Lazy' });
  });
});

// ---------------------------------------------------------------------------
// 2. Correctness parity — fast path vs. the known-correct full-scan baseline
// ---------------------------------------------------------------------------

describe('structuralQuery — SQL-pushdown result parity with the full scan', () => {
  beforeEach(async () => {
    // 5 "bug" notes (rare), 20 "note" notes (common), one with valid_until
    // set so :not([data-cerveau-valid-until]) has something to exclude, and
    // one malformed note to exercise the shared malformed-note skip path.
    for (let i = 0; i < 5; i++) {
      await writeAndIndex(`bug-${i}`, 'bug', 'urgent triage');
    }
    for (let i = 0; i < 20; i++) {
      await writeAndIndex(`note-${i}`, 'note', 'misc');
    }
    await writeAndIndex('decision-active', 'decision', 'arch', '');
    // A second decision, written directly with valid_until set, so
    // :not([data-cerveau-valid-until]) has something to exclude.
    const { indexNote } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    const expiredHtml =
      '<article id="decision-expired-2" data-cerveau-type="decision" data-cerveau-tags="arch" ' +
      'data-cerveau-valid-until="2026-01-01T00:00:00Z"><h1>decision-expired-2</h1><p>Body.</p></article>';
    const fp = writeNoteFile('decision-expired-2', expiredHtml);
    indexNote(readNote(fp));
  });

  it('rare-type selector: fast path returns the same note-id set as full scan', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const fast = structuralQuery('[data-cerveau-type="bug"]', { limit: 200 });
    const slow = structuralQueryFullScanForTests('[data-cerveau-type="bug"]', { limit: 200 });
    expect(sortedIds(fast)).toEqual(sortedIds(slow));
    expect(fast).toHaveLength(5);
  });

  it('common-type selector with a tight limit: fast path returns a valid subset matching full-scan semantics', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const fast = structuralQuery('[data-cerveau-type="note"]', { limit: 5 });
    const slow = structuralQueryFullScanForTests('[data-cerveau-type="note"]', { limit: 5 });
    expect(fast).toHaveLength(5);
    expect(slow).toHaveLength(5);
    // Every fast-path hit must be a genuine "note"-type note (a member of
    // the full unbounded match set), even though limit truncation means the
    // exact 5 chosen may differ in order from the full scan's disk-walk order.
    const fullMatchIds = new Set(
      sortedIds(structuralQueryFullScanForTests('[data-cerveau-type="note"]', { limit: 1000 })),
    );
    for (const hit of fast) {
      expect(fullMatchIds.has(hit.noteId)).toBe(true);
    }
  });

  it('tag word-match (~=) selector: fast path parity with full scan', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const fast = structuralQuery('[data-cerveau-tags~="urgent"]', { limit: 200 });
    const slow = structuralQueryFullScanForTests('[data-cerveau-tags~="urgent"]', { limit: 200 });
    expect(sortedIds(fast)).toEqual(sortedIds(slow));
    expect(fast).toHaveLength(5); // only the bug-* notes carry "urgent"
  });

  it('compound selector with :not(...): fast path still applies the full DOM filter, not just the type prefilter', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const selector = 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])';
    const fast = structuralQuery(selector, { limit: 200 });
    const slow = structuralQueryFullScanForTests(selector, { limit: 200 });
    expect(sortedIds(fast)).toEqual(sortedIds(slow));
    // 2 decisions total, 1 has valid_until set — only 1 should survive :not(...).
    expect(fast).toHaveLength(1);
    expect(fast[0].noteId).toBe('decision-active');
  });

  it('selector list (comma) is never pushed down and still returns the union of both branches', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const selector = '[data-cerveau-type="bug"], [data-cerveau-type="decision"]';
    const fast = structuralQuery(selector, { limit: 200 });
    const slow = structuralQueryFullScanForTests(selector, { limit: 200 });
    expect(sortedIds(fast)).toEqual(sortedIds(slow));
    expect(fast).toHaveLength(7); // 5 bug + 2 decision
  });

  it('valid-but-zero-match pushdown selector returns an empty array, not an error', async () => {
    const { structuralQuery } = await import('../structural.js');
    expect(structuralQuery('[data-cerveau-type="nonexistent-type"]')).toEqual([]);
  });

  it('attribute-extraction option behaves identically on both paths', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const opts = { limit: 200, attribute: 'data-cerveau-type' };
    const fast = structuralQuery('[data-cerveau-type="bug"]', opts);
    const slow = structuralQueryFullScanForTests('[data-cerveau-type="bug"]', opts);
    expect(fast.every((h) => h.attribute === 'bug')).toBe(true);
    expect(sortedIds(fast)).toEqual(sortedIds(slow));
  });
});

// ---------------------------------------------------------------------------
// 2b. Case-insensitive tag matching — the actual defect this suite exists
// to fix. Fixture mirrors the shape measured on the owner's real brain: a
// tag fragmented across "Lazy" (majority) and "lazy" (minority), plus a
// "lazybrain" tag that must NEVER match (word-boundary, not substring).
// ---------------------------------------------------------------------------

describe('structuralQuery — case-insensitive tag matching (~=)', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i++) {
      await writeAndIndex(`upper-${i}`, 'note', 'Lazy misc');
    }
    for (let i = 0; i < 2; i++) {
      await writeAndIndex(`lower-${i}`, 'note', 'lazy misc');
    }
    // Word-boundary trap: contains "lazy" as a PREFIX of a longer word, not
    // as a standalone tag — must never match `~="lazy"` in either case.
    await writeAndIndex('substring-trap', 'note', 'lazybrain misc');
  });

  it('a lowercase selector finds both the "Lazy" and "lazy" notes (the union)', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const fast = structuralQuery('[data-cerveau-tags~="lazy"]', { limit: 200 });
    const slow = structuralQueryFullScanForTests('[data-cerveau-tags~="lazy"]', { limit: 200 });
    expect(sortedIds(fast)).toEqual(sortedIds(slow));
    expect(fast).toHaveLength(7); // 5 "Lazy" + 2 "lazy", "lazybrain" excluded
    expect(sortedIds(fast)).not.toContain('substring-trap');
  });

  it('an uppercase-first selector returns the SAME union, not just its own case', async () => {
    const { structuralQuery, structuralQueryFullScanForTests } = await import('../structural.js');
    const fast = structuralQuery('[data-cerveau-tags~="Lazy"]', { limit: 200 });
    const slow = structuralQueryFullScanForTests('[data-cerveau-tags~="Lazy"]', { limit: 200 });
    expect(sortedIds(fast)).toEqual(sortedIds(slow));
    expect(fast).toHaveLength(7);
  });

  it('a fully-uppercase selector also returns the same union — 3-way parity', async () => {
    const { structuralQuery } = await import('../structural.js');
    const viaLower = structuralQuery('[data-cerveau-tags~="lazy"]', { limit: 200 });
    const viaUpper = structuralQuery('[data-cerveau-tags~="Lazy"]', { limit: 200 });
    const viaAllCaps = structuralQuery('[data-cerveau-tags~="LAZY"]', { limit: 200 });
    expect(sortedIds(viaLower)).toEqual(sortedIds(viaUpper));
    expect(sortedIds(viaUpper)).toEqual(sortedIds(viaAllCaps));
  });

  it('the fast path is actually used (candidate reads scale with the matching set, not the corpus)', async () => {
    await writeAndIndex('unrelated', 'note', 'other');
    const { structuralQuery } = await import('../structural.js');
    const { getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    resetReadNoteCallCountForTests();
    const hits = structuralQuery('[data-cerveau-tags~="lazy"]', { limit: 200 });
    expect(hits).toHaveLength(7);
    // SQLite LIKE's default ASCII case-insensitivity means the SQL candidate
    // set is already the union (7) for either case of the query — the read
    // count must reflect that, not the full 9-note corpus (7 lazy-ish + trap
    // + unrelated).
    expect(getReadNoteCallCountForTests()).toBe(7);
  });

  it('an exact (=) match on data-cerveau-tags stays case-sensitive — different, unpushdowned semantics', async () => {
    const { structuralQuery } = await import('../structural.js');
    // Exact full-string match is deliberately out of scope for this fix
    // (extractPushdownFilter already excludes `=` from the fast path — see
    // "falls back for exact match" above): matching case returns the 5
    // "Lazy misc" notes, a differently-cased query returns nothing.
    const matching = structuralQuery('[data-cerveau-tags="Lazy misc"]', { limit: 200 });
    expect(sortedIds(matching)).toEqual(['upper-0', 'upper-1', 'upper-2', 'upper-3', 'upper-4']);
    expect(structuralQuery('[data-cerveau-tags="LAZY MISC"]', { limit: 200 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Freshness gate — unindexed notes must never be silently dropped
// ---------------------------------------------------------------------------

describe('structuralQuery — freshness gate falls back when the index is incomplete', () => {
  it('finds a note written directly to disk without ever being indexed', async () => {
    // No indexNote() call at all — countAllNotes() stays 0 while a file
    // exists on disk, so indexIsTrustworthy() must refuse the fast path.
    writeNoteFile('never-indexed', noteHtml('never-indexed', 'bug', 'urgent'));
    const { structuralQuery } = await import('../structural.js');
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });
    expect(hits.map((h) => h.noteId)).toContain('never-indexed');
  });

  it('finds a newly-added note that was written after the index was already partially built', async () => {
    await writeAndIndex('indexed-1', 'bug', 'urgent');
    // Second note dropped directly on disk, bypassing indexNote() — this is
    // exactly the "index missing a file" case indexIsTrustworthy() guards.
    writeNoteFile('unindexed-2', noteHtml('unindexed-2', 'bug', 'urgent'));
    const { structuralQuery } = await import('../structural.js');
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });
    const ids = hits.map((h) => h.noteId);
    expect(ids).toContain('indexed-1');
    expect(ids).toContain('unindexed-2');
  });

  it('once every note is indexed, the freshness gate allows the fast path again', async () => {
    await writeAndIndex('a', 'bug', 'urgent');
    await writeAndIndex('b', 'bug', 'urgent');
    const { structuralQuery } = await import('../structural.js');
    const { getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    resetReadNoteCallCountForTests();
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });
    expect(hits).toHaveLength(2);
    // Fully indexed 2-note corpus, both match — fast path reads exactly the
    // 2 candidates, proving the gate isn't permanently stuck in fallback.
    expect(getReadNoteCallCountForTests()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3b. Stale-duplicate regression — the exact defect the audit found: a raw
// file count can NEVER equal the indexed row count on a brain with
// regenerated notes, permanently disabling the fast path. See
// distinctNoteIdSlugsCached()'s doc comment in store/reader.ts.
// ---------------------------------------------------------------------------

describe('structuralQuery — stale duplicate note files never break the trust check', () => {
  function writeInMonth(month: string, id: string, html: string): string {
    const dir = join(notesPath, month);
    mkdirSync(dir, { recursive: true });
    const fp = join(dir, `${id}.html`);
    writeFileSync(fp, html, 'utf-8');
    return fp;
  }

  it('an orphaned prior-month copy of a regenerated note does NOT disable the fast path', async () => {
    // Simulate regeneration: "regen-1" was first written in 2026-06, then
    // regenerated in 2026-07 with a fresh data-cerveau-created (the real
    // root cause — see synthesize.ts/graph.ts composers always stamping
    // "now"). Only the NEW copy is indexed; the OLD copy is left orphaned on
    // disk, sharing the same id/filename slug.
    const oldPath = writeInMonth('2026-06', 'regen-1', noteHtml('regen-1', 'bug', 'urgent'));
    const newPath = writeInMonth(
      '2026-07',
      'regen-1',
      noteHtml('regen-1', 'bug', 'urgent', '<meta name="regenerated" content="2026-07">'),
    );
    const { indexNote } = await import('../fts.js');
    const { readNote, getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    indexNote(readNote(newPath));

    // A second, fully-clean note (no stale duplicate) to prove the pushdown
    // candidate set is still exactly right.
    await writeAndIndex('clean-1', 'bug', 'urgent');

    resetReadNoteCallCountForTests();
    const { structuralQuery } = await import('../structural.js');
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });

    expect(hits.map((h) => h.noteId).sort()).toEqual(['clean-1', 'regen-1']);
    // Fast path proof: reads exactly the 2 CANDIDATE rows (regen-1's current
    // path + clean-1) — never the orphaned old-month duplicate. A full-scan
    // fallback (the old, broken behavior) would read 3 files, not 2, because
    // it walks the whole corpus including the orphan.
    expect(getReadNoteCallCountForTests()).toBe(2);
    expect(oldPath).not.toBe(newPath); // sanity: genuinely two files on disk
  });
});

// ---------------------------------------------------------------------------
// 3c. slug() truncation edge case — regression for the double-slug workaround
// this trust check used to need. See store/paths.ts's slug() doc comment:
// slug() is now proven idempotent, so indexIsTrustworthy() compares a single
// slug(id) application against the on-disk filename. Before that fix, an id
// long enough to truncate mid-hyphen at the 80-char boundary made a single
// application diverge from the real (double-applied) on-disk filename,
// which would have permanently disabled the fast path for that note.
// ---------------------------------------------------------------------------

describe('structuralQuery — trust check survives the slug() truncation edge case', () => {
  it('an id that truncates mid-hyphen at 80 chars still matches disk to index (fast path stays trusted)', async () => {
    // Sanitizes to well over 80 chars with a hyphen run landing exactly on
    // the truncation boundary — the shape that used to require comparing
    // against slug(slug(id)) here instead of a single slug(id).
    const rawId = `file-${'a'.repeat(75)}---${'b'.repeat(20)}`;
    const { slug } = await import('../../store/paths.js');
    const onDiskStem = slug(rawId); // exactly what writer.ts would name the file
    const fp = writeNoteFile(onDiskStem, noteHtml(rawId, 'bug', 'urgent'));

    const { indexNote } = await import('../fts.js');
    const { readNote, getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    indexNote(readNote(fp));

    resetReadNoteCallCountForTests();
    const { structuralQuery } = await import('../structural.js');
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 50 });

    expect(hits.map((h) => h.noteId)).toEqual([rawId]);
    // Fast path proof: exactly 1 candidate read. A full-scan fallback (what
    // the old double-slug mismatch would have forced) would still find the
    // note, but this call-count assertion is what actually distinguishes
    // "trusted fast path" from "silently fell back".
    expect(getReadNoteCallCountForTests()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. No-full-scan — read count scales with matches, not corpus size
// ---------------------------------------------------------------------------

describe('structuralQuery — the SQL-pushdown path does not read the whole corpus', () => {
  const TOTAL = 300;
  const RARE_COUNT = 12;

  beforeEach(async () => {
    const { indexNote } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    for (let i = 0; i < TOTAL; i++) {
      const type = i < RARE_COUNT ? 'bug' : 'note';
      const fp = writeNoteFile(`n-${i}`, noteHtml(`n-${i}`, type, 'x'));
      indexNote(readNote(fp));
    }
  }, 20000);

  it('rare-type query reads only the matching notes, not the full 300-note corpus', async () => {
    const { structuralQuery } = await import('../structural.js');
    const { getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    resetReadNoteCallCountForTests();
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 200 });
    expect(hits).toHaveLength(RARE_COUNT);
    const reads = getReadNoteCallCountForTests();
    expect(reads).toBe(RARE_COUNT);
    expect(reads).toBeLessThan(TOTAL);
  }, 20000);

  it('common-type query with a tight limit stops reading once the limit is satisfied', async () => {
    const { structuralQuery } = await import('../structural.js');
    const { getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    resetReadNoteCallCountForTests();
    const hits = structuralQuery('[data-cerveau-type="note"]', { limit: 5 });
    expect(hits).toHaveLength(5);
    const reads = getReadNoteCallCountForTests();
    // Early-exit against the element-level limit: reads a handful of
    // candidates, never the ~288 "note"-type notes in the corpus.
    expect(reads).toBe(5);
    expect(reads).toBeLessThan(TOTAL);
  }, 20000);

  it('a non-pushdown-eligible selector still runs the full scan (baseline unaffected)', async () => {
    const { structuralQuery } = await import('../structural.js');
    const { getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    resetReadNoteCallCountForTests();
    const hits = structuralQuery('article h1', { limit: 1000 });
    expect(hits).toHaveLength(TOTAL);
    expect(getReadNoteCallCountForTests()).toBe(TOTAL);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 4b. Hybrid fallback — a STALE (untrustworthy) index still reads only the
// candidates + the drift, never the whole corpus. This is the actual perf
// fix from the 2026-08 audit: readAllNotes()'ing the whole corpus on ANY
// staleness (even a single orphaned note) was measured to cost ~5.6s on the
// owner's real ~9930-note brain, dwarfing the trust check itself (<100ms).
// See structuralQuery()'s module doc in structural.ts for the full writeup.
// ---------------------------------------------------------------------------

describe('structuralQuery — a stale index reads only the drift, not the whole corpus', () => {
  const TOTAL = 300;
  const RARE_COUNT = 12;
  const ORPHAN_COUNT = 3; // written to disk but never indexed — the actual drift

  beforeEach(async () => {
    const { indexNote } = await import('../fts.js');
    const { readNote } = await import('../../store/reader.js');
    for (let i = 0; i < TOTAL; i++) {
      const type = i < RARE_COUNT ? 'bug' : 'note';
      const fp = writeNoteFile(`n-${i}`, noteHtml(`n-${i}`, type, 'x'));
      indexNote(readNote(fp));
    }
    // Orphans: on disk, matching the rare type, but deliberately never
    // indexed — this is what makes checkIndexTrust() report untrustworthy.
    for (let i = 0; i < ORPHAN_COUNT; i++) {
      writeNoteFile(`orphan-${i}`, noteHtml(`orphan-${i}`, 'bug', 'x'));
    }
  }, 20000);

  it('finds every match (indexed + orphaned) while reading far fewer notes than the full corpus', async () => {
    const { structuralQuery } = await import('../structural.js');
    const { getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    resetReadNoteCallCountForTests();
    const hits = structuralQuery('[data-cerveau-type="bug"]', { limit: 200 });
    const ids = hits.map((h) => h.noteId).sort();
    const expected = [
      ...Array.from({ length: RARE_COUNT }, (_, i) => `n-${i}`),
      ...Array.from({ length: ORPHAN_COUNT }, (_, i) => `orphan-${i}`),
    ].sort();
    expect(ids).toEqual(expected);

    const reads = getReadNoteCallCountForTests();
    // Hybrid cost: the RARE_COUNT indexed "bug" candidates + the
    // ORPHAN_COUNT un-indexed files — never the "note"-type notes, and
    // never the (TOTAL - RARE_COUNT) common-type corpus a full scan would
    // have paid for.
    expect(reads).toBe(RARE_COUNT + ORPHAN_COUNT);
    expect(reads).toBeLessThan(TOTAL);
  }, 20000);

  it('a common-type query under a stale index also stays proportional to candidates + drift', async () => {
    const { structuralQuery } = await import('../structural.js');
    const { getReadNoteCallCountForTests, resetReadNoteCallCountForTests } = await import(
      '../../store/reader.js'
    );
    resetReadNoteCallCountForTests();
    // "note" is the common type (TOTAL - RARE_COUNT of them); the 3 orphans
    // are "bug"-typed so they never match this selector, but they are still
    // MISSING from the index, so the trust check still reports stale and
    // the hybrid path still has to read them directly to rule them out.
    const hits = structuralQuery('[data-cerveau-type="note"]', { limit: 1000 });
    expect(hits).toHaveLength(TOTAL - RARE_COUNT);
    const reads = getReadNoteCallCountForTests();
    // (TOTAL - RARE_COUNT) "note" candidates from SQL + ORPHAN_COUNT direct
    // reads to check the un-indexed files — still short of a full corpus
    // walk plus duplicated reads, and strictly bounded (no double-reading).
    expect(reads).toBe(TOTAL - RARE_COUNT + ORPHAN_COUNT);
  }, 20000);
});
