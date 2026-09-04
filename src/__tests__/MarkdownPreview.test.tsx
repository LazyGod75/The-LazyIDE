import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { MarkdownPreview } from '../components/editor/MarkdownPreview';

// Smoke coverage for the editor's .md file preview now that it shares
// MarkdownRenderer with the assistant chat (see MarkdownPreview.tsx) —
// full parsing/rendering correctness is covered by parseMarkdown.test.ts
// and MarkdownRenderer.test.tsx.

describe('MarkdownPreview', () => {
  it('shows the filename header', () => {
    const { getByText } = render(<MarkdownPreview content="# Hello" filename="README.md" />);
    expect(getByText(/README\.md/)).toBeInTheDocument();
  });

  it('renders a heading as a real element, not literal "#" text', () => {
    const { container } = render(<MarkdownPreview content="## Section" filename="notes.md" />);
    expect(container.querySelector('h2')?.textContent).toBe('Section');
  });

  it('renders a GFM table as a real <table>', () => {
    const src = '| A | B |\n|---|---|\n| 1 | 2 |';
    const { container } = render(<MarkdownPreview content={src} filename="notes.md" />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('never renders a javascript: link as clickable', () => {
    const { container } = render(
      <MarkdownPreview content="[bad](javascript:alert(1))" filename="notes.md" />
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('has no Apply/Copy chrome on code blocks — read-only file preview, no chat context', () => {
    const { container, queryByText } = render(
      <MarkdownPreview content={'```ts\nconst x = 1;\n```'} filename="notes.md" />
    );
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1;');
    expect(queryByText('Apply')).toBeNull();
  });
});
