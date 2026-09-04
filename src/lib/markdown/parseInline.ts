/* parseInline — inline-level markdown tokenizer: turns a run of text into
   InlineNode[] (bold/italic/inline-code/links/citations/plain text).

   Design notes:
   - Never throws. Every branch either fully matches a construct and jumps
     past it, or falls through as one literal character and advances by 1 —
     so truncated/unterminated delimiters (the normal case mid-stream, e.g.
     "**bold" with no closing "**" yet because the rest hasn't arrived)
     degrade to plain text instead of erroring. See MarkdownRenderer.tsx for
     the belt-and-suspenders top-level try/catch on top of this.
   - Recursive calls (bold/italic/link-text content) always operate on a
     strict substring of the input, so recursion terminates.
   - No HTML is ever built here — everything becomes a typed InlineNode
     rendered as real React elements/text by MarkdownRenderer, so raw HTML
     in the model's output (script tags, event handlers, etc.) is inert by
     construction: it is only ever placed in a React text node, never
     interpreted as markup. */

import type { InlineNode } from './types.js';
import { sanitizeHref } from './sanitizeHref.js';

const CITATION_RE = /^#[\w-]+/;

function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return /[\s([{]/.test(ch);
}

function isAlphanumeric(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/** Finds the ')' matching the '(' at `openIdx`, tracking nested parens so a
 *  link destination containing its own parens (URL or otherwise) is not
 *  truncated at the first, innermost ')'. Returns -1 if unterminated
 *  (truncated mid-stream) — callers fall through to literal text. */
function findMatchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let k = openIdx; k < text.length; k += 1) {
    if (text[k] === '(') depth += 1;
    else if (text[k] === ')') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Tokenizes a SINGLE line (no raw '\n' inside `text` — see parseInlineText
 *  for multi-line joining) into a flat run of InlineNode. */
export function tokenizeLine(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const n = text.length;
  let i = 0;
  let start = 0;

  function flush(end: number): void {
    if (end > start) nodes.push({ type: 'text', value: text.slice(start, end) });
  }

  while (i < n) {
    const ch = text[i];

    // Inline code span: `code` (N backticks as delimiter, so a literal
    // backtick can appear inside via a longer fence, e.g. ``a`b``).
    if (ch === '`') {
      const tickRun = /^`+/.exec(text.slice(i));
      const fence = tickRun ? tickRun[0] : '`';
      const closeIdx = text.indexOf(fence, i + fence.length);
      if (closeIdx !== -1) {
        flush(i);
        nodes.push({ type: 'code', value: text.slice(i + fence.length, closeIdx).trim() });
        i = closeIdx + fence.length;
        start = i;
        continue;
      }
      i += 1;
      continue;
    }

    // Bold **text**/__text__ and italic *text*/_text_.
    if (ch === '*' || ch === '_') {
      // Underscore never opens emphasis intraword (e.g. "my_variable_name"
      // must stay literal) — matches CommonMark's underscore flanking rule.
      if (ch === '_' && isAlphanumeric(text[i - 1])) {
        i += 1;
        continue;
      }
      const double = text[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      const searchFrom = i + marker.length;
      const closeIdx = text.indexOf(marker, searchFrom);
      if (closeIdx !== -1 && closeIdx > searchFrom) {
        flush(i);
        const inner = text.slice(searchFrom, closeIdx);
        nodes.push({ type: double ? 'strong' : 'em', children: tokenizeLine(inner) });
        i = closeIdx + marker.length;
        start = i;
        continue;
      }
      // No valid closing marker (yet) — literal character, keep scanning.
      i += 1;
      continue;
    }

    // Link: [text](href)
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        // Depth-aware search: a real-world URL destination can itself
        // contain parens (e.g. Wikipedia's ".../wiki/Foo_(bar)"), so a
        // naive indexOf(')') would stop at the FIRST one and truncate the
        // href — findMatchingParen tracks nesting to find the true close.
        const closeParen = findMatchingParen(text, closeBracket + 1);
        if (closeParen !== -1) {
          flush(i);
          const linkText = text.slice(i + 1, closeBracket);
          const hrefRaw = text.slice(closeBracket + 2, closeParen);
          const children = tokenizeLine(linkText);
          const safeHref = sanitizeHref(hrefRaw);
          if (safeHref) {
            nodes.push({ type: 'link', href: safeHref, children });
          } else {
            // Unsafe/invalid scheme (javascript:, data:, ...) — degrade to
            // plain text: keep the readable label, drop the dangerous target.
            nodes.push(...children);
          }
          i = closeParen + 1;
          start = i;
          continue;
        }
      }
      i += 1;
      continue;
    }

    // Brain citation ref: #node-id — must sit at a word boundary so it
    // never fires mid-word (e.g. a URL fragment or "C#" mentioned in text).
    if (ch === '#') {
      const m = CITATION_RE.exec(text.slice(i));
      if (m && isBoundary(text[i - 1])) {
        flush(i);
        nodes.push({ type: 'citation', ref: m[0] });
        i += m[0].length;
        start = i;
        continue;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  flush(n);
  return nodes;
}

/**
 * Public entry point: joins multi-line inline text (a paragraph, a list
 * item, a table cell...) into one inline run, honoring CommonMark line-break
 * rules — a line ending in two-plus spaces or a backslash becomes a hard
 * `<br/>`; any other line boundary is a soft break that collapses to a
 * single space (so plain multi-line prose reads as one wrapped paragraph
 * instead of visually running words together with no separator at all).
 */
export function parseInlineText(raw: string): InlineNode[] {
  const lines = raw.split('\n');
  const nodes: InlineNode[] = [];

  lines.forEach((line, idx) => {
    const isLast = idx === lines.length - 1;
    if (isLast) {
      nodes.push(...tokenizeLine(line));
      return;
    }
    const hardBreak = / {2,}$/.test(line) || /\\$/.test(line);
    const cleaned = line.replace(/ {2,}$/, '').replace(/\\$/, '');
    nodes.push(...tokenizeLine(cleaned));
    nodes.push(hardBreak ? { type: 'break' } : { type: 'text', value: ' ' });
  });

  return nodes;
}
