/* parseMarkdown — block-level markdown parser: source text -> BlockNode[].

   Covers, deliberately: ATX headings (h1-h6), fenced code blocks, ordered/
   unordered lists (recursively nested via indentation), GFM tables
   (incl. column alignment), blockquotes, horizontal rules, and paragraphs
   (delegating inline runs to parseInline.ts). This is NOT full CommonMark —
   documented simplifications below are intentional, scoped to what the
   app's two markdown surfaces (assistant chat, .md file preview) need.

   Streaming safety: model output can arrive mid-token (partial markdown),
   and is only semi-trusted (may carry prompt-injected content from files or
   brain notes). Every loop here is bounded by the input's own length and
   degrades unterminated constructs (an open fence/list/blockquote at EOF)
   into a best-effort block instead of failing — see MarkdownRenderer.tsx
   for the top-level try/catch that is the last line of defense on top of
   this. MAX_DEPTH guards against pathological/adversarial nesting (e.g.
   thousands of ">" chars) turning into runaway recursion.

   Documented simplifications (acceptable for this feature set):
   - No Setext headings ("Text\n---") — a lone "---"/"***"/"___" line is
     always an <hr>, which is the more common intent in LLM chat output.
   - No 4-space-indent code blocks — only fenced (```) code blocks.
   - List nesting is indentation-relative, not CommonMark's exact
     column-alignment algorithm — matches how models actually indent
     (consistently, by 2 or 4 spaces) without chasing every edge case. */

import type { BlockNode, ListItemNode, TableAlign } from './types.js';
import { tokenizeLine, parseInlineText } from './parseInline.js';
import { parseFenceInfo } from './parseFenceInfo.js';

const MAX_DEPTH = 40;

// ── Line-level helpers ──────────────────────────────────────────────

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function leadingSpaces(line: string): number {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
}

function isFenceClose(line: string, fenceChar: string, minLen: number): boolean {
  const t = line.trim();
  if (t.length < minLen) return false;
  for (const c of t) {
    if (c !== fenceChar) return false;
  }
  return true;
}

function isHr(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, '');
  if (compact.length < 3) return false;
  const c = compact[0];
  if (c !== '-' && c !== '*' && c !== '_') return false;
  for (const ch of compact) {
    if (ch !== c) return false;
  }
  return true;
}

function parseHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  if (!m) return null;
  const level = m[1].length as 1 | 2 | 3 | 4 | 5 | 6;
  const text = m[2].replace(/\s+#+\s*$/, '').trim();
  return { level, text };
}

interface ListMarkerMatch {
  indent: number;
  ordered: boolean;
  start?: number;
  contentIndent: number;
  text: string;
}

function matchListMarker(line: string): ListMarkerMatch | null {
  const m = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(line);
  if (!m) return null;
  const [, leading, marker, gap, text] = m;
  const ordered = marker !== '-' && marker !== '*' && marker !== '+';
  return {
    indent: leading.length,
    ordered,
    start: ordered ? parseInt(marker, 10) : undefined,
    contentIndent: leading.length + marker.length + gap.length,
    text,
  };
}

function startsNewBlock(line: string): boolean {
  if (isBlank(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^(`{3,}|~{3,})/.test(line)) return true;
  if (isHr(line)) return true;
  if (/^>\s?/.test(line)) return true;
  if (matchListMarker(line) !== null) return true;
  if (line.trim().startsWith('|')) return true;
  return false;
}

// ── Table helpers ────────────────────────────────────────────────────

function looksLikeTableRow(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.includes('|');
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for (let k = 0; k < t.length; k += 1) {
    if (t[k] === '\\' && t[k + 1] === '|') {
      current += '|';
      k += 1;
      continue;
    }
    if (t[k] === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += t[k];
  }
  cells.push(current.trim());
  return cells;
}

function isTableDelimiterRow(line: string): boolean {
  const t = line.trim();
  if (!t || !t.includes('-')) return false;
  const cells = splitTableRow(t);
  // A bare "---" (one cell, no literal pipe anywhere) is an <hr>, not a
  // degenerate one-column table — avoids misreading "discussing the `|`
  // operator" followed by an unrelated "---" divider as a table.
  if (cells.length < 2 && !t.includes('|')) return false;
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

function cellAlign(delim: string): TableAlign {
  const left = delim.startsWith(':');
  const right = delim.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function normalizeRow(row: string[], colCount: number): string[] {
  const copy = row.slice(0, colCount);
  while (copy.length < colCount) copy.push('');
  return copy;
}

// ── List parsing (recursive, indentation-relative nesting) ─────────

function parseList(lines: string[], start: number, depth: number): { block: BlockNode; next: number } {
  const first = matchListMarker(lines[start]);
  /* istanbul ignore next -- only called when matchListMarker already matched at `start` */
  if (!first) return { block: { type: 'list', ordered: false, items: [] }, next: start + 1 };

  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items: ListItemNode[] = [];
  let i = start;

  while (i < lines.length) {
    const m = matchListMarker(lines[i]);
    if (!m || m.indent !== baseIndent || m.ordered !== ordered) break;

    const itemLines: string[] = [m.text];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (isBlank(line)) {
        const next = lines[j + 1];
        if (next !== undefined && leadingSpaces(next) > baseIndent) {
          itemLines.push('');
          j += 1;
          continue;
        }
        break;
      }
      if (leadingSpaces(line) > baseIndent) {
        itemLines.push(line.slice(Math.min(leadingSpaces(line), m.contentIndent)));
        j += 1;
        continue;
      }
      break;
    }

    items.push({ children: parseBlockLines(itemLines, depth + 1) });
    i = j;
  }

  return { block: { type: 'list', ordered, start: first.start, items }, next: i };
}

// ── Main block loop ──────────────────────────────────────────────────

function parseBlockLines(lines: string[], depth: number = 0): BlockNode[] {
  if (depth > MAX_DEPTH) {
    // Pathological/adversarial nesting — stop recursing and render what's
    // left as one literal paragraph rather than degrading performance.
    return lines.length ? [{ type: 'paragraph', children: parseInlineText(lines.join('\n')) }] : [];
  }

  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i += 1; continue; }

    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const fenceChars = fenceMatch[1];
      const info = fenceMatch[2];
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j], fenceChars[0], fenceChars.length)) {
        codeLines.push(lines[j]);
        j += 1;
      }
      if (j < lines.length) j += 1; // consume the closing fence line, if any arrived
      const { language, targetPath } = parseFenceInfo(info);
      blocks.push({ type: 'code', language, targetPath, value: codeLines.join('\n') });
      i = j;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, children: tokenizeLine(heading.text) });
      i += 1;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        quoteLines.push(lines[j].replace(/^>\s?/, ''));
        j += 1;
      }
      blocks.push({ type: 'blockquote', children: parseBlockLines(quoteLines, depth + 1) });
      i = j;
      continue;
    }

    if (looksLikeTableRow(line) && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map(cellAlign);
      const colCount = headerCells.length;
      let j = i + 2;
      const rawRows: string[][] = [];
      while (j < lines.length && !isBlank(lines[j]) && looksLikeTableRow(lines[j])) {
        rawRows.push(splitTableRow(lines[j]));
        j += 1;
      }
      blocks.push({
        type: 'table',
        align,
        header: headerCells.map(c => parseInlineText(c)),
        rows: rawRows.map(r => normalizeRow(r, colCount).map(c => parseInlineText(c))),
      });
      i = j;
      continue;
    }

    if (matchListMarker(line)) {
      const { block, next } = parseList(lines, i, depth);
      blocks.push(block);
      i = next;
      continue;
    }

    // Paragraph — greedily consume contiguous lines that don't start a new block.
    const paraLines: string[] = [line];
    let j = i + 1;
    while (j < lines.length && !startsNewBlock(lines[j])) {
      paraLines.push(lines[j]);
      j += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInlineText(paraLines.join('\n')) });
    i = j;
  }

  return blocks;
}

export function parseMarkdown(source: string): BlockNode[] {
  const normalized = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return parseBlockLines(normalized.split('\n'), 0);
}
