/* searchReplaceMatch.ts — matching cascade for SEARCH/REPLACE-style edits
   (edit_file/multi_edit's old_string -> new_string).

   2026-08-15 (M6 incident follow-up, task #2 of the harness hardening pass —
   see scratch/_harness-research.md): a bare `content.includes(oldStr)` check
   (the pre-existing editFile/multiEdit implementation) rejects an edit the
   instant the model's old_string differs from the real file by so much as
   one whitespace character — extremely common (the model re-types a snippet
   from memory/context with 2-space indent while the file uses tabs, or with
   a blank line collapsed). Other agents hit exactly this and ship a matching
   CASCADE in aider/coders/search_replace.py: exact -> whitespace/indent-
   normalized -> blank-line-stripped -> git 3-way -> fuzzy (diff-match-patch,
   threshold 0.1). This module implements the first three tiers (the task's
   documented minimum bar) — git 3-way and fuzzy diffing are out of scope for
   this pass.

   Deliberately simple: every tier locates the ORIGINAL span in `content` to
   replace, then splices in the replacement text VERBATIM (no attempt to
   re-indent the replacement to match a shifted indent level). The model's
   replacement was almost always written against context it just read via
   read_file (i.e. the REAL file's actual indentation), so verbatim splicing
   is correct in the common case and avoids a second class of subtle
   indentation bugs that a "smart" re-indent step could introduce.

   Pure, dependency-free, fully unit-tested (see __tests__/searchReplaceMatch.test.ts).
*/

export type MatchStrategy = 'exact' | 'indent-normalized' | 'blank-stripped';

export interface SearchMatch {
  /** Character offset into `content` where the match starts. */
  index: number;
  /** Length, in characters, of the ORIGINAL span being replaced. */
  length: number;
  strategy: MatchStrategy;
}

/** Strips leading whitespace from every line — tier 2 (indentation differs
 *  but the code itself is identical once dedented). */
function normalizeIndent(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^[ \t]+/, ''))
    .join('\n');
}

interface OffsetLine {
  text: string;
  /** Char offset of this line's first character in the original string. */
  start: number;
  /** Char offset just past this line's last character (before the `\n`). */
  end: number;
}

function linesWithOffsets(content: string): OffsetLine[] {
  const result: OffsetLine[] = [];
  let offset = 0;
  for (const text of content.split('\n')) {
    result.push({ text, start: offset, end: offset + text.length });
    offset += text.length + 1; // +1 for the '\n' separator consumed between lines
  }
  return result;
}

/** Slides a `search`-line-count window over `content`'s lines, applying
 *  `transform` to both sides before comparing — used for tiers 2 and 3
 *  above. Returns the ORIGINAL (untransformed) span's offset/length. */
function findByLineTransform(
  content: string,
  search: string,
  transform: (s: string) => string,
): { index: number; length: number } | null {
  const searchLineCount = search.split('\n').length;
  const transformedSearch = transform(search);
  if (!transformedSearch.trim()) return null; // never match on an empty/whitespace-only needle

  const contentLines = linesWithOffsets(content);
  for (let start = 0; start + searchLineCount <= contentLines.length; start++) {
    const windowText = contentLines
      .slice(start, start + searchLineCount)
      .map((l) => l.text)
      .join('\n');
    if (transform(windowText) === transformedSearch) {
      const first = contentLines[start];
      const last = contentLines[start + searchLineCount - 1];
      return { index: first.start, length: last.end - first.start };
    }
  }
  return null;
}

/**
 * Locates `search` inside `content`, cascading through progressively looser
 * tiers until one matches (or all fail). Returns the FIRST match found at
 * the tightest tier that succeeds — never the loosest possible match, so a
 * file with multiple candidates still prefers the most literal one.
 */
export function findSearchMatch(content: string, search: string): SearchMatch | null {
  if (!search) return null;

  const exactIndex = content.indexOf(search);
  if (exactIndex !== -1) {
    return { index: exactIndex, length: search.length, strategy: 'exact' };
  }

  const indentMatch = findByLineTransform(content, search, normalizeIndent);
  if (indentMatch) {
    return { ...indentMatch, strategy: 'indent-normalized' };
  }

  const blankMatch = findIgnoringBlankLines(content, search);
  if (blankMatch) {
    return { ...blankMatch, strategy: 'blank-stripped' };
  }

  return null;
}

/**
 * Tier 3 — locates `search` while ignoring blank/whitespace-only lines on
 * BOTH sides, tolerating a DIFFERENT blank-line COUNT between them (the
 * model omitted or added a blank line the real file does/doesn't have).
 * Deliberately NOT built on findByLineTransform above: that helper slides a
 * FIXED-size window (search's own line count) over content, which only
 * works when the transform preserves line count (true for
 * normalizeIndent, false for stripBlankLines whenever the blank-line
 * counts differ) — so this compares NON-BLANK lines directly instead of a
 * transformed joined string, and spans the match from the first to the
 * last matched non-blank content line, naturally absorbing any interior
 * blank lines into the replaced span either way.
 */
function findIgnoringBlankLines(content: string, search: string): { index: number; length: number } | null {
  const searchNonBlank = search.split('\n').filter((l) => l.trim() !== '');
  if (searchNonBlank.length === 0) return null;

  const contentNonBlank = linesWithOffsets(content).filter((l) => l.text.trim() !== '');

  for (let start = 0; start + searchNonBlank.length <= contentNonBlank.length; start++) {
    let allMatch = true;
    for (let j = 0; j < searchNonBlank.length; j++) {
      if (contentNonBlank[start + j].text !== searchNonBlank[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      const first = contentNonBlank[start];
      const last = contentNonBlank[start + searchNonBlank.length - 1];
      return { index: first.start, length: last.end - first.start };
    }
  }
  return null;
}

/**
 * Applies one search/replace via the cascade above. Returns null when no
 * tier matches (caller is responsible for building a rich "no match" error —
 * see files.ts's buildMismatchSnippet, which feeds the real file content
 * back to the model instead of just failing silently, per the task's
 * "on total failure, feed the error AND a snippet of the real file content
 * back to the model" requirement).
 */
export function applySearchReplace(
  content: string,
  search: string,
  replacement: string,
): { content: string; strategy: MatchStrategy } | null {
  const match = findSearchMatch(content, search);
  if (!match) return null;
  const updated = content.slice(0, match.index) + replacement + content.slice(match.index + match.length);
  return { content: updated, strategy: match.strategy };
}
