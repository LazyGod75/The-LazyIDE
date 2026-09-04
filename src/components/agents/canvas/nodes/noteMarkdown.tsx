/* noteMarkdown.tsx — W-BYO nit (a), n8n parity ("Sticky Notes" support
   Markdown). Tiny, dependency-free Markdown-to-JSX renderer for NoteNode's
   read-only display.

   No Markdown RENDERING library exists in this repo's dependencies — only
   `@codemirror/lang-markdown` (a syntax-highlighting GRAMMAR for an editor,
   package.json — not a renderer) — and the supported surface here is
   deliberately small: n8n's own sticky-note formatting is bold/italic/
   lists/links too, not full CommonMark. A hand-rolled renderer for exactly
   those four inline/block rules is the honest "tiny" implementation the
   task asked for, rather than pulling in a Markdown dependency for a
   sticky note.

   Supported: **bold**, *italic* / _italic_, [text](url) links, "- "/"* "
   bullet lists (one level, no nesting). Anything else (headings, code
   fences, tables, blockquotes, nested lists) renders as plain text —
   never throws, never mangles input that isn't using these constructs.
   Only used at the 'full' zoom level's read (non-editing) view — the
   'compact'/'dot' zoom tiers and the edit-mode textarea show the raw text
   verbatim (a zoomed-out one-line preview / a textarea are not the right
   place for rich rendering).
*/

import type { ReactNode } from 'react';

const INLINE_TOKEN = /(\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|\[([^\]]+)\]\(([^)\s]+)\))/g;

/** Parses ONE line's inline markdown (bold/italic/links) into a ReactNode
 *  array. Never recurses into nested emphasis — n8n's own note formatting
 *  doesn't either, and CommonMark's nesting rules are exactly the
 *  complexity a "tiny" renderer is meant to skip. */
function renderInline(line: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  INLINE_TOKEN.lastIndex = 0;
  while ((match = INLINE_TOKEN.exec(line)) !== null) {
    if (match.index > lastIndex) parts.push(line.slice(lastIndex, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[2] !== undefined) {
      parts.push(<strong key={key}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      parts.push(<em key={key}>{match[3]}</em>);
    } else if (match[4] !== undefined) {
      parts.push(<em key={key}>{match[4]}</em>);
    } else if (match[5] !== undefined && match[6] !== undefined) {
      parts.push(
        <a
          key={key}
          href={match[6]}
          target="_blank"
          rel="noreferrer"
          className="nodrag"
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          {match[5]}
        </a>,
      );
    }
    lastIndex = INLINE_TOKEN.lastIndex;
  }
  if (lastIndex < line.length) parts.push(line.slice(lastIndex));
  return parts;
}

function isBulletLine(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function bulletContent(line: string): string {
  return line.replace(/^\s*[-*]\s+/, '');
}

/**
 * Renders a note's plain-text body as lightweight Markdown: consecutive
 * bullet lines become one `<ul>`, everything else is one `<div>` per line
 * (never `<p>`, so line spacing matches the note's pre-existing
 * `whiteSpace: 'pre-wrap'` plain-text look) with inline bold/italic/link
 * runs resolved. An empty line renders a non-breaking space so it still
 * takes up a visual row (matches `pre-wrap`'s handling of blank lines).
 */
export function renderNoteMarkdown(text: string): ReactNode {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let listBuffer: string[] = [];
  let blockKey = 0;

  function flushList(): void {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    blocks.push(
      // Tailwind's Preflight base layer resets every `<ul>`/`<li>` to
      // `list-style: none` app-wide — an inline `listStyle` here is the fix
      // (inline style specificity always wins over that element-selector
      // base rule), otherwise a note's bullet list silently renders with no
      // markers at all, indistinguishable from plain paragraphs.
      <ul key={`list-${blockKey++}`} style={{ margin: '2px 0', paddingLeft: 16, listStyle: 'disc' }}>
        {items.map((item, i) => (
          <li key={i} style={{ display: 'list-item' }}>{renderInline(item, `li-${blockKey}-${i}`)}</li>
        ))}
      </ul>,
    );
    listBuffer = [];
  }

  for (const line of lines) {
    if (isBulletLine(line)) {
      listBuffer.push(bulletContent(line));
      continue;
    }
    flushList();
    blocks.push(
      <div key={`line-${blockKey++}`}>{line.length > 0 ? renderInline(line, `ln-${blockKey}`) : ' '}</div>,
    );
  }
  flushList();

  return blocks;
}
