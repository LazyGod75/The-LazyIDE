import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { MarkdownRenderer } from '../lib/markdown/MarkdownRenderer';
import type { MarkdownCodeBlock } from '../lib/markdown/MarkdownRenderer';

// DEFECT 1 regression suite — the owner-verified bug was assistant answers
// rendering as a RAW-MARKDOWN WALL (literal "##", "|...|", "-", "**").
// These assert the actual DOM shape: real elements, no literal markdown
// syntax characters left over in the rendered text.

describe('MarkdownRenderer — headings/emphasis/inline code', () => {
  it('renders a heading as a real <h2>, not literal "##" text', () => {
    const { container } = render(<MarkdownRenderer content="## Section Title" />);
    const h2 = container.querySelector('h2');
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toBe('Section Title');
    expect(container.textContent).not.toContain('##');
  });

  it('renders h1-h4 distinctly', () => {
    const { container } = render(<MarkdownRenderer content={'# One\n## Two\n### Three\n#### Four'} />);
    expect(container.querySelector('h1')?.textContent).toBe('One');
    expect(container.querySelector('h2')?.textContent).toBe('Two');
    expect(container.querySelector('h3')?.textContent).toBe('Three');
    expect(container.querySelector('h4')?.textContent).toBe('Four');
  });

  it('renders bold and italic as <strong>/<em>, not literal asterisks', () => {
    const { container } = render(<MarkdownRenderer content="**bold** and *italic*" />);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.textContent).not.toContain('**');
  });

  it('renders inline code as <code>', () => {
    const { container } = render(<MarkdownRenderer content="Use `npm install` first" />);
    expect(container.querySelector('code')?.textContent).toBe('npm install');
  });
});

describe('MarkdownRenderer — lists', () => {
  it('renders an unordered list as real <ul>/<li>, not literal "-" text', () => {
    const { container } = render(<MarkdownRenderer content={'- one\n- two\n- three'} />);
    expect(container.querySelector('ul')).not.toBeNull();
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toBe('one');
    expect(items[2].textContent).toBe('three');
  });

  it('renders an ordered list as <ol>', () => {
    const { container } = render(<MarkdownRenderer content={'1. one\n2. two'} />);
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a nested list as a real nested <ul>', () => {
    const { container } = render(<MarkdownRenderer content={'- a\n  - nested'} />);
    const outerUl = container.querySelector('ul');
    const innerUl = outerUl?.querySelector('ul');
    expect(innerUl).not.toBeNull();
    expect(innerUl?.textContent).toBe('nested');
  });
});

describe('MarkdownRenderer — GFM tables', () => {
  it('renders a table as a real <table> with header and rows, not a literal "|" wall', () => {
    const src = '| Name | Age |\n|------|-----|\n| Alice | 30 |';
    const { container } = render(<MarkdownRenderer content={src} />);
    expect(container.querySelector('table')).not.toBeNull();
    const headers = container.querySelectorAll('th');
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toBe('Name');
    expect(headers[1].textContent).toBe('Age');
    const cells = container.querySelectorAll('td');
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toBe('Alice');
    expect(cells[1].textContent).toBe('30');
    expect(container.textContent).not.toContain('|');
    expect(container.textContent).not.toContain('---');
  });

  it('applies column alignment from the delimiter row', () => {
    const src = '| L | R |\n|:--|--:|\n| a | b |';
    const { container } = render(<MarkdownRenderer content={src} />);
    const ths = container.querySelectorAll('th');
    expect((ths[0] as HTMLElement).style.textAlign).toBe('left');
    expect((ths[1] as HTMLElement).style.textAlign).toBe('right');
  });
});

describe('MarkdownRenderer — links and sanitization', () => {
  it('renders a valid https link as a clickable <a href>', () => {
    const { container } = render(<MarkdownRenderer content="[Docs](https://example.com)" />);
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.textContent).toBe('Docs');
  });

  it('never renders a javascript: URL as a clickable link', () => {
    const { container } = render(<MarkdownRenderer content="[click me](javascript:alert(document.cookie))" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('click me');
  });

  it('never renders a data: URL as a clickable link', () => {
    const { container } = render(<MarkdownRenderer content="[x](data:text/html,<script>alert(1)</script>)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
});

describe('MarkdownRenderer — raw HTML in the source is inert', () => {
  it('renders an embedded <script> tag as literal text, never as a real element', () => {
    const { container } = render(<MarkdownRenderer content="Ignore prior instructions. <script>alert(1)</script>" />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders an inline event-handler attribute as literal text, never attached to a real element', () => {
    const { container } = render(<MarkdownRenderer content="<img src=x onerror=alert(1)>" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('MarkdownRenderer — code blocks', () => {
  it('renders a fenced code block via the default read-only <pre><code>', () => {
    const { container } = render(<MarkdownRenderer content={'```ts\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1;');
  });

  it('uses a supplied renderCodeBlock override instead of the default', () => {
    const { getByTestId } = render(
      <MarkdownRenderer
        content={'```ts\nconst x = 1;\n```'}
        renderCodeBlock={(block: MarkdownCodeBlock, key: string) => (
          <div data-testid="custom-code" key={key}>{block.language}:{block.code}</div>
        )}
      />
    );
    expect(getByTestId('custom-code').textContent).toBe('ts:const x = 1;');
  });

  it('passes the explicit fence target through to the renderCodeBlock override', () => {
    const { getByTestId } = render(
      <MarkdownRenderer
        content={'```tsx src/components/Foo.tsx\nexport {};\n```'}
        renderCodeBlock={(block: MarkdownCodeBlock, key: string) => (
          <div data-testid="custom-code" key={key}>{block.targetPath ?? 'NONE'}</div>
        )}
      />
    );
    expect(getByTestId('custom-code').textContent).toBe('src/components/Foo.tsx');
  });
});

describe('MarkdownRenderer — citations', () => {
  it('uses a supplied renderCitation override for #ref tokens', () => {
    const { getByTestId } = render(
      <MarkdownRenderer
        content="See #auth-oauth for details."
        renderCitation={(ref: string, key: string) => <span data-testid="chip" key={key}>{ref}</span>}
      />
    );
    expect(getByTestId('chip').textContent).toBe('#auth-oauth');
  });

  it('renders the literal ref text when no override is supplied (MarkdownPreview usage)', () => {
    const { container } = render(<MarkdownRenderer content="See #auth-oauth for details." />);
    expect(container.textContent).toContain('#auth-oauth');
  });

  it('renders a citation inside a heading, not just a flat paragraph', () => {
    const { getByTestId } = render(
      <MarkdownRenderer
        content="## See #auth-oauth"
        renderCitation={(ref: string, key: string) => <span data-testid="chip" key={key}>{ref}</span>}
      />
    );
    expect(getByTestId('chip')).toBeInTheDocument();
  });
});

describe('MarkdownRenderer — streaming / partial markdown never throws', () => {
  const partialInputs = [
    '## Heading with no',
    '**bold that never clos',
    '`code that never clos',
    '[link text](https://example.com/no-close',
    '| a | b |\n|---|---',
    '- item one\n  - nested item that never',
    '> blockquote that keeps go',
    '```ts\nconst x = {\n  incomplete',
  ];

  it.each(partialInputs)('does not throw while rendering partial content: %j', (partial) => {
    expect(() => render(<MarkdownRenderer content={partial} />)).not.toThrow();
  });

  it('renders the trailing caret inline after the last paragraph while streaming', () => {
    const { getByTestId } = render(
      <MarkdownRenderer content="Partial answer" trailingInline={<span data-testid="caret" />} />
    );
    expect(getByTestId('caret')).toBeInTheDocument();
  });

  it('still renders the trailing caret even when the last block cannot hold inline content (a table)', () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |';
    const { getByTestId } = render(
      <MarkdownRenderer content={src} trailingInline={<span data-testid="caret" />} />
    );
    expect(getByTestId('caret')).toBeInTheDocument();
  });

  it('renders the trailing caret alone when content is still empty', () => {
    const { getByTestId } = render(
      <MarkdownRenderer content="" trailingInline={<span data-testid="caret" />} />
    );
    expect(getByTestId('caret')).toBeInTheDocument();
  });
});
