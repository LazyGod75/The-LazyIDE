import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../lib/markdown/parseMarkdown';
import { tokenizeLine, parseInlineText } from '../lib/markdown/parseInline';
import type { InlineNode } from '../lib/markdown/types';

/** Flattens an inline-node run back to plain readable text — used to keep
 *  assertions about parsed content resilient to the exact node shape. */
function textOf(nodes: InlineNode[]): string {
  return nodes.map(n => {
    switch (n.type) {
      case 'text': return n.value;
      case 'code': return n.value;
      case 'citation': return n.ref;
      case 'break': return '\n';
      case 'strong': case 'em': case 'link': return textOf(n.children);
      default: return '';
    }
  }).join('');
}

describe('parseMarkdown — headings', () => {
  it('parses h1 through h6', () => {
    const blocks = parseMarkdown('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6');
    expect(blocks).toHaveLength(6);
    blocks.forEach((b, i) => {
      expect(b.type).toBe('heading');
      if (b.type === 'heading') {
        expect(b.level).toBe(i + 1);
        expect(textOf(b.children)).toBe(`H${i + 1}`);
      }
    });
  });

  it('strips an optional trailing closing-hash sequence', () => {
    const blocks = parseMarkdown('## Title ##');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2 });
    if (blocks[0].type === 'heading') expect(textOf(blocks[0].children)).toBe('Title');
  });

  it('does NOT treat a bare "#word" (no space) as a heading — falls through to a citation-eligible paragraph', () => {
    const blocks = parseMarkdown('#auth-oauth');
    expect(blocks[0].type).toBe('paragraph');
  });
});

describe('parseMarkdown — emphasis (bold/italic)', () => {
  it('tokenizes **bold**', () => {
    expect(tokenizeLine('**bold**')).toEqual([{ type: 'strong', children: [{ type: 'text', value: 'bold' }] }]);
  });

  it('tokenizes *italic*', () => {
    expect(tokenizeLine('*italic*')).toEqual([{ type: 'em', children: [{ type: 'text', value: 'italic' }] }]);
  });

  it('tokenizes __bold__ and _italic_', () => {
    expect(tokenizeLine('__bold__')).toEqual([{ type: 'strong', children: [{ type: 'text', value: 'bold' }] }]);
    expect(tokenizeLine('_italic_')).toEqual([{ type: 'em', children: [{ type: 'text', value: 'italic' }] }]);
  });

  it('does not mangle a snake_case identifier as emphasis', () => {
    expect(tokenizeLine('my_variable_name')).toEqual([{ type: 'text', value: 'my_variable_name' }]);
  });

  it('mixes bold, italic, and plain text in one line', () => {
    const nodes = tokenizeLine('**bold** and *italic* and plain');
    expect(textOf(nodes)).toBe('bold and italic and plain');
    expect(nodes.some(n => n.type === 'strong')).toBe(true);
    expect(nodes.some(n => n.type === 'em')).toBe(true);
  });

  it('degrades an unterminated "**bold" (mid-stream) to literal text instead of throwing', () => {
    expect(() => tokenizeLine('**bold text')).not.toThrow();
    expect(tokenizeLine('**bold text')).toEqual([{ type: 'text', value: '**bold text' }]);
  });
});

describe('parseMarkdown — inline code', () => {
  it('tokenizes `code` spans', () => {
    const nodes = tokenizeLine('Use `const x = 1` here');
    expect(nodes).toEqual([
      { type: 'text', value: 'Use ' },
      { type: 'code', value: 'const x = 1' },
      { type: 'text', value: ' here' },
    ]);
  });
});

describe('parseMarkdown — links', () => {
  it('parses a link with an https href', () => {
    const nodes = tokenizeLine('[Docs](https://example.com/path)');
    expect(nodes).toEqual([
      { type: 'link', href: 'https://example.com/path', children: [{ type: 'text', value: 'Docs' }] },
    ]);
  });

  it('degrades a javascript: link to plain text (keeps the label, drops the href)', () => {
    const nodes = tokenizeLine('[bad](javascript:evil)');
    expect(nodes).toEqual([{ type: 'text', value: 'bad' }]);
  });

  it('correctly balances a URL that itself contains parens (e.g. a Wikipedia-style path)', () => {
    const nodes = tokenizeLine('[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) after');
    expect(nodes[0]).toEqual({
      type: 'link',
      href: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      children: [{ type: 'text', value: 'wiki' }],
    });
    expect(textOf(nodes)).toBe('wiki after');
  });
});

describe('parseMarkdown — citations', () => {
  it('tokenizes a #ref citation at a word boundary', () => {
    const nodes = tokenizeLine('See #auth-oauth for details.');
    expect(nodes).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'citation', ref: '#auth-oauth' },
      { type: 'text', value: ' for details.' },
    ]);
  });
});

describe('parseMarkdown — fenced code blocks', () => {
  it('parses a fence with a language and no target', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n```');
    expect(blocks).toEqual([{ type: 'code', language: 'ts', value: 'const x = 1;' }]);
  });

  it('parses a fence with no info string as plaintext', () => {
    const blocks = parseMarkdown('```\nplain\n```');
    expect(blocks).toEqual([{ type: 'code', language: 'plaintext', value: 'plain' }]);
  });

  it('parses an explicit target from the fence info string', () => {
    const blocks = parseMarkdown('```tsx src/components/Foo.tsx\nconst x = 1;\n```');
    expect(blocks).toEqual([
      { type: 'code', language: 'tsx', targetPath: 'src/components/Foo.tsx', value: 'const x = 1;' },
    ]);
  });

  it('does NOT treat a line-highlight hint as a target path', () => {
    const blocks = parseMarkdown('```tsx {1,3}\nconst x = 1;\n```');
    expect(blocks[0]).toMatchObject({ type: 'code', language: 'tsx' });
    if (blocks[0].type === 'code') expect(blocks[0].targetPath).toBeUndefined();
  });

  it('never throws on an UNTERMINATED fence at EOF (mid-stream) and keeps everything gathered so far', () => {
    expect(() => parseMarkdown('```ts\nconst x = 1;\nconst y = 2;')).not.toThrow();
    const blocks = parseMarkdown('```ts\nconst x = 1;\nconst y = 2;');
    expect(blocks).toEqual([{ type: 'code', language: 'ts', value: 'const x = 1;\nconst y = 2;' }]);
  });
});

describe('parseMarkdown — lists', () => {
  it('parses a simple unordered list', () => {
    const blocks = parseMarkdown('- one\n- two\n- three');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: false });
    if (blocks[0].type === 'list') {
      expect(blocks[0].items).toHaveLength(3);
      expect(blocks[0].items.map(it => textOf((it.children[0] as { children: InlineNode[] }).children))).toEqual(['one', 'two', 'three']);
    }
  });

  it('parses "*" and "+" as unordered markers too', () => {
    expect(parseMarkdown('* one\n* two')[0]).toMatchObject({ type: 'list', ordered: false });
    expect(parseMarkdown('+ one\n+ two')[0]).toMatchObject({ type: 'list', ordered: false });
  });

  it('parses an ordered list and preserves a custom start number', () => {
    const blocks = parseMarkdown('3. third\n4. fourth');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    if (blocks[0].type === 'list') expect(blocks[0].items).toHaveLength(2);
  });

  it('nests a sub-list under its parent item via indentation', () => {
    const blocks = parseMarkdown('- a\n  - nested1\n  - nested2\n- b');
    expect(blocks[0].type).toBe('list');
    if (blocks[0].type !== 'list') return;
    expect(blocks[0].items).toHaveLength(2);

    const [itemA, itemB] = blocks[0].items;
    // item "a" has its own paragraph PLUS a nested list child.
    expect(itemA.children.some(c => c.type === 'list')).toBe(true);
    const nested = itemA.children.find(c => c.type === 'list');
    expect(nested).toMatchObject({ type: 'list', ordered: false });
    if (nested?.type === 'list') {
      expect(nested.items).toHaveLength(2);
      expect(textOf((nested.items[0].children[0] as { children: InlineNode[] }).children)).toBe('nested1');
      expect(textOf((nested.items[1].children[0] as { children: InlineNode[] }).children)).toBe('nested2');
    }
    // item "b" stays a simple tight item, no nested list.
    expect(itemB.children.some(c => c.type === 'list')).toBe(false);
  });

  it('a single "* item" line is a list, not a horizontal rule', () => {
    const blocks = parseMarkdown('* item one\n* item two');
    expect(blocks[0]).toMatchObject({ type: 'list' });
  });
});

describe('parseMarkdown — GFM tables', () => {
  it('parses a basic table into header + rows', () => {
    const src = '| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |';
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('table');
    if (blocks[0].type !== 'table') return;
    expect(blocks[0].header.map(textOf)).toEqual(['Name', 'Age']);
    expect(blocks[0].rows.map(r => r.map(textOf))).toEqual([
      ['Alice', '30'],
      ['Bob', '25'],
    ]);
    expect(blocks[0].align).toEqual([null, null]);
  });

  it('parses column alignment from the delimiter row', () => {
    const src = '| L | C | R |\n|:--|:-:|--:|\n| a | b | c |';
    const blocks = parseMarkdown(src);
    expect(blocks[0]).toMatchObject({ type: 'table', align: ['left', 'center', 'right'] });
  });

  it('never throws on a table with only a header row (delimiter not arrived yet, mid-stream)', () => {
    expect(() => parseMarkdown('| Col1 | Col2 |')).not.toThrow();
    // Cannot confirm it's a table without the delimiter row — renders as a
    // plain paragraph for now, and self-corrects once more text streams in.
    expect(parseMarkdown('| Col1 | Col2 |')[0].type).toBe('paragraph');
  });

  it('never throws on a truncated delimiter row (mid-stream)', () => {
    expect(() => parseMarkdown('| Col1 | Col2 |\n|--')).not.toThrow();
  });

  it('does NOT misread a paragraph mentioning `|` followed by an unrelated "---" divider as a table', () => {
    const blocks = parseMarkdown('Use the `|` operator.\n---\nMore text.');
    expect(blocks.map(b => b.type)).toEqual(['paragraph', 'hr', 'paragraph']);
  });
});

describe('parseMarkdown — blockquotes', () => {
  it('parses a single-line blockquote', () => {
    const blocks = parseMarkdown('> Quoted line');
    expect(blocks).toEqual([
      { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Quoted line' }] }] },
    ]);
  });

  it('joins multiple quoted lines into the blockquote', () => {
    const blocks = parseMarkdown('> Line one\n> Line two');
    expect(blocks[0].type).toBe('blockquote');
    if (blocks[0].type !== 'blockquote') return;
    expect(textOf((blocks[0].children[0] as { children: InlineNode[] }).children)).toBe('Line one Line two');
  });
});

describe('parseMarkdown — horizontal rules', () => {
  it.each(['---', '***', '___'])('parses "%s" as an hr', (hr) => {
    expect(parseMarkdown(hr)).toEqual([{ type: 'hr' }]);
  });
});

describe('parseMarkdown — paragraphs and line breaks', () => {
  it('joins a single "\\n" within a paragraph as a soft break (a space)', () => {
    const nodes = parseInlineText('line one\nline two');
    expect(textOf(nodes)).toBe('line one line two');
  });

  it('treats a line ending in two-plus spaces as a hard break', () => {
    const nodes = parseInlineText('line one  \nline two');
    expect(nodes.some(n => n.type === 'break')).toBe(true);
  });

  it('treats a line ending in a backslash as a hard break', () => {
    const nodes = parseInlineText('line one\\\nline two');
    expect(nodes.some(n => n.type === 'break')).toBe(true);
  });

  it('splits two blank-line-separated blocks into two paragraphs', () => {
    const blocks = parseMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(blocks).toHaveLength(2);
    expect(blocks.every(b => b.type === 'paragraph')).toBe(true);
  });
});

describe('parseMarkdown — adversarial / streaming-safety input', () => {
  it('never throws on pathologically deep blockquote nesting, and terminates promptly', () => {
    const src = `${'>'.repeat(1000)} deep`;
    const start = Date.now();
    expect(() => parseMarkdown(src)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('never throws on a large, mixed, deliberately messy document', () => {
    const src = [
      '# Heading',
      'para with `code` and **bold** and [link](https://x.com) and #cite-1',
      '',
      '```ts',
      'unterminated code fence...',
      '- list item with *unterminated emphasis',
      '  - nested **also unterminated',
      '| a | b',
      '|---',
    ].join('\n');
    expect(() => parseMarkdown(src)).not.toThrow();
  });

  it('handles an empty string', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
