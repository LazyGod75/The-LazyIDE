/* MarkdownRenderer — renders parsed markdown (see parseMarkdown.ts) as real
   React elements: headings, bold/italic, inline code, fenced code blocks,
   nested lists, GFM tables, blockquotes, hr, links, paragraphs.

   SAFETY: this never uses dangerouslySetInnerHTML. Every text token becomes
   a React text child, which React escapes by construction — raw HTML in
   the model's output (script tags, event handlers, ...) is inert, it is
   only ever displayed as literal text, never parsed as markup. Link hrefs
   are separately allowlisted by sanitizeHref.ts before a node is even built
   (see parseInline.ts), and MarkdownLink below never lets the WebView
   navigate natively (see its own comment).

   Single source of truth for BOTH markdown surfaces in the app:
   - MessageList.tsx's assistant answers: passes renderCodeBlock (reuses the
     chat CodeBlock component, with Apply-gating) and renderCitation
     (CitationChip, clickable brain refs).
   - MarkdownPreview.tsx's .md file preview: uses the defaults below (plain
     read-only code blocks, plain citation text) — it has no chat/apply
     context at all. */

import type React from 'react';
import type { ReactNode } from 'react';
import type { BlockNode, InlineNode, ListItemNode, TableAlign } from './types.js';
import { parseMarkdown } from './parseMarkdown.js';
import { openExternal } from '../platform/openExternal.js';
import {
  ROOT_STYLE, PARAGRAPH_STYLE, headingStyle, INLINE_CODE_STYLE, STRONG_STYLE,
  LINK_STYLE, HR_STYLE, BLOCKQUOTE_STYLE, UL_STYLE, OL_STYLE, LI_STYLE,
  NESTED_LIST_STYLE, TABLE_WRAP_STYLE, TABLE_STYLE, TR_ODD_STYLE, thStyle, tdStyle,
  PRE_STYLE, CODE_STYLE, FALLBACK_STYLE,
} from './markdownStyles.js';

export interface MarkdownCodeBlock {
  language: string;
  code: string;
  targetPath?: string;
}

export interface MarkdownRendererProps {
  content: string;
  /** Appended after the last text-bearing block — used for the streaming
   *  "typing" caret. Rendered inline when the last block can hold inline
   *  content (heading/paragraph/list/blockquote tail); otherwise appended
   *  as a trailing sibling so it is never silently dropped. */
  trailingInline?: ReactNode;
  /** Defaults to a plain, read-only <pre><code> block. */
  renderCodeBlock?: (block: MarkdownCodeBlock, key: string) => ReactNode;
  /** Defaults to the literal "#ref" text (no special chip/click behavior). */
  renderCitation?: (ref: string, key: string) => ReactNode;
}

interface RenderCtx {
  renderCodeBlock: (block: MarkdownCodeBlock, key: string) => ReactNode;
  renderCitation: (ref: string, key: string) => ReactNode;
}

const defaultRenderCodeBlock = (block: MarkdownCodeBlock, key: string): ReactNode => (
  <pre key={key} style={PRE_STYLE}>
    <code style={CODE_STYLE}>{block.code}</code>
  </pre>
);

const defaultRenderCitation = (ref: string, key: string): ReactNode => <span key={key}>{ref}</span>;

export function MarkdownRenderer({
  content,
  trailingInline,
  renderCodeBlock = defaultRenderCodeBlock,
  renderCitation = defaultRenderCitation,
}: MarkdownRendererProps) {
  let blocks: BlockNode[];
  try {
    blocks = parseMarkdown(content);
  } catch {
    // Should be unreachable — every parsing step is designed to degrade
    // gracefully instead of throwing (see parseMarkdown.ts/parseInline.ts).
    // Kept as the last line of defense: an edge case we didn't anticipate
    // must never crash the chat UI, so fall back to plain (still readable,
    // still safe — no dangerouslySetInnerHTML here either) text.
    return <div style={FALLBACK_STYLE}>{content}</div>;
  }

  const ctx: RenderCtx = { renderCodeBlock, renderCitation };
  const hasTrailing = trailingInline !== undefined;
  const canInlineTrailing = hasTrailing && lastLeafIsInline(blocks);

  return (
    <div style={ROOT_STYLE}>
      {blocks.map((block, i) =>
        renderBlock(block, `b${i}`, ctx, canInlineTrailing && i === blocks.length - 1 ? trailingInline : undefined))}
      {hasTrailing && !canInlineTrailing ? trailingInline : null}
    </div>
  );
}

// ── Trailing-caret placement ─────────────────────────────────────────

function lastLeafIsInline(blocks: BlockNode[]): boolean {
  if (blocks.length === 0) return false;
  const last = blocks[blocks.length - 1];
  if (last.type === 'heading' || last.type === 'paragraph') return true;
  if (last.type === 'blockquote') return lastLeafIsInline(last.children);
  if (last.type === 'list') {
    const lastItem = last.items[last.items.length - 1];
    return lastItem ? lastLeafIsInline(lastItem.children) : false;
  }
  return false; // code, table, hr have no inline tail to attach to
}

// ── Block rendering ───────────────────────────────────────────────────

function renderBlock(block: BlockNode, key: string, ctx: RenderCtx, trailing: ReactNode | undefined): ReactNode {
  switch (block.type) {
    case 'heading': {
      const level = block.level;
      const children = renderInline(block.children, ctx);
      switch (level) {
        case 1: return <h1 key={key} style={headingStyle(1)}>{children}{trailing}</h1>;
        case 2: return <h2 key={key} style={headingStyle(2)}>{children}{trailing}</h2>;
        case 3: return <h3 key={key} style={headingStyle(3)}>{children}{trailing}</h3>;
        case 4: return <h4 key={key} style={headingStyle(4)}>{children}{trailing}</h4>;
        case 5: return <h5 key={key} style={headingStyle(5)}>{children}{trailing}</h5>;
        default: return <h6 key={key} style={headingStyle(6)}>{children}{trailing}</h6>;
      }
    }
    case 'paragraph':
      return <p key={key} style={PARAGRAPH_STYLE}>{renderInline(block.children, ctx)}{trailing}</p>;
    case 'code':
      return ctx.renderCodeBlock({ language: block.language, code: block.value, targetPath: block.targetPath }, key);
    case 'hr':
      return <hr key={key} style={HR_STYLE} />;
    case 'blockquote':
      return (
        <blockquote key={key} style={BLOCKQUOTE_STYLE}>
          {renderBlockList(block.children, ctx, key, trailing)}
        </blockquote>
      );
    case 'list':
      return renderList(block.ordered, block.start, block.items, key, ctx, trailing);
    case 'table':
      return renderTable(block.align, block.header, block.rows, key, ctx);
    default:
      return null;
  }
}

function renderBlockList(blocks: BlockNode[], ctx: RenderCtx, keyPrefix: string, trailing: ReactNode | undefined): ReactNode {
  return blocks.map((b, i) =>
    renderBlock(b, `${keyPrefix}-${i}`, ctx, i === blocks.length - 1 ? trailing : undefined));
}

function renderList(
  ordered: boolean,
  start: number | undefined,
  items: ListItemNode[],
  key: string,
  ctx: RenderCtx,
  trailing: ReactNode | undefined,
): ReactNode {
  const startProp = ordered && start !== undefined && start !== 1 ? { start } : {};
  const children = items.map((item, i) => {
    const isLastItem = i === items.length - 1;
    const itemTrailing = isLastItem ? trailing : undefined;
    const itemKey = `${key}-${i}`;

    // Tight list item (single paragraph, the common case): render the
    // paragraph's inline content directly, no <p> margin inside the <li>.
    if (item.children.length === 1 && item.children[0].type === 'paragraph') {
      return (
        <li key={itemKey} style={LI_STYLE}>
          {renderInline(item.children[0].children, ctx)}
          {itemTrailing}
        </li>
      );
    }
    return (
      <li key={itemKey} style={LI_STYLE}>
        {renderBlockList(item.children, ctx, itemKey, itemTrailing)}
      </li>
    );
  });

  return ordered
    ? <ol key={key} style={{ ...OL_STYLE, ...NESTED_LIST_STYLE }} {...startProp}>{children}</ol>
    : <ul key={key} style={{ ...UL_STYLE, ...NESTED_LIST_STYLE }}>{children}</ul>;
}

function renderTable(
  align: TableAlign[],
  header: InlineNode[][],
  rows: InlineNode[][][],
  key: string,
  ctx: RenderCtx,
): ReactNode {
  return (
    <div key={key} style={TABLE_WRAP_STYLE}>
      <table style={TABLE_STYLE}>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={`${key}-h${i}`} style={thStyle(align[i] ?? null)}>
                {renderInline(cell, ctx)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={`${key}-r${ri}`} style={ri % 2 === 1 ? TR_ODD_STYLE : undefined}>
              {row.map((cell, ci) => (
                <td key={`${key}-r${ri}-c${ci}`} style={tdStyle(align[ci] ?? null)}>
                  {renderInline(cell, ctx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Inline rendering ────────────────────────────────────────────────

function renderInline(nodes: InlineNode[], ctx: RenderCtx): ReactNode[] {
  return nodes.map((node, i) => renderInlineNode(node, `i${i}`, ctx));
}

function renderInlineNode(node: InlineNode, key: string, ctx: RenderCtx): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'code':
      return <code key={key} style={INLINE_CODE_STYLE}>{node.value}</code>;
    case 'strong':
      return <strong key={key} style={STRONG_STYLE}>{renderInline(node.children, ctx)}</strong>;
    case 'em':
      return <em key={key}>{renderInline(node.children, ctx)}</em>;
    case 'link':
      return <MarkdownLink key={key} href={node.href}>{renderInline(node.children, ctx)}</MarkdownLink>;
    case 'citation':
      return ctx.renderCitation(node.ref, key);
    case 'break':
      return <br key={key} />;
    default:
      return null;
  }
}

function MarkdownLink({ href, children }: { href: string; children: ReactNode }) {
  function handleClick(e: React.MouseEvent) {
    // Never let the WebView navigate natively — for an http(s) target that
    // means "leave the app" (see openExternal.ts's doc comment on why that
    // silently breaks in the packaged build); for a scheme-less relative
    // target there is no in-app route to go to at all. Always prevent
    // default, then explicitly hand http(s) targets to the system browser.
    e.preventDefault();
    if (/^https?:/i.test(href)) {
      openExternal(href).catch(() => {});
    }
  }

  return (
    <a href={href} onClick={handleClick} style={LINK_STYLE} title={href}>
      {children}
    </a>
  );
}
