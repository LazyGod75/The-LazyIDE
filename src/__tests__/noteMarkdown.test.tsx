import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderNoteMarkdown } from '../components/agents/canvas/nodes/noteMarkdown';

function renderMd(text: string) {
  return render(<div data-testid="root">{renderNoteMarkdown(text)}</div>);
}

describe('renderNoteMarkdown', () => {
  it('renders **bold** as <strong>', () => {
    const { getByTestId } = renderMd('this is **important**');
    const strong = getByTestId('root').querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe('important');
  });

  it('renders *italic* as <em>', () => {
    const { getByTestId } = renderMd('this is *nice*');
    const em = getByTestId('root').querySelector('em');
    expect(em?.textContent).toBe('nice');
  });

  it('renders _italic_ as <em> too', () => {
    const { getByTestId } = renderMd('this is _nice_');
    const em = getByTestId('root').querySelector('em');
    expect(em?.textContent).toBe('nice');
  });

  it('renders [text](url) as a link with the exact href', () => {
    const { getByTestId } = renderMd('see [the docs](https://example.com/x)');
    const a = getByTestId('root').querySelector('a');
    expect(a?.textContent).toBe('the docs');
    expect(a?.getAttribute('href')).toBe('https://example.com/x');
  });

  it('groups consecutive "- " lines into one <ul>', () => {
    const { getByTestId } = renderMd('- one\n- two\n- three');
    const root = getByTestId('root');
    const uls = root.querySelectorAll('ul');
    expect(uls).toHaveLength(1);
    expect(uls[0].querySelectorAll('li')).toHaveLength(3);
    expect(uls[0].textContent).toContain('one');
    expect(uls[0].textContent).toContain('three');
  });

  it('sets an explicit inline list-style (Tailwind Preflight resets <ul> to list-style: none app-wide)', () => {
    const { getByTestId } = renderMd('- one\n- two');
    const ul = getByTestId('root').querySelector('ul');
    expect(ul?.getAttribute('style')).toContain('list-style: disc');
  });

  it('supports "* " as an alternate bullet marker', () => {
    const { getByTestId } = renderMd('* alpha\n* beta');
    const ul = getByTestId('root').querySelector('ul');
    expect(ul?.querySelectorAll('li')).toHaveLength(2);
  });

  it('splits into two separate lists when a non-list line breaks the run', () => {
    const { getByTestId } = renderMd('- one\n- two\nsome text\n- three');
    const uls = getByTestId('root').querySelectorAll('ul');
    expect(uls).toHaveLength(2);
    expect(uls[0].querySelectorAll('li')).toHaveLength(2);
    expect(uls[1].querySelectorAll('li')).toHaveLength(1);
  });

  it('renders plain text with no markdown constructs verbatim', () => {
    const { getByTestId } = render(<div data-testid="root2">{renderNoteMarkdown('just a plain note')}</div>);
    expect(getByTestId('root2').textContent).toBe('just a plain note');
  });

  it('never throws on unsupported constructs (headings, code fences)', () => {
    expect(() => renderMd('# Heading\n```code```\n> quote')).not.toThrow();
  });

  it('renders an empty string without throwing', () => {
    expect(() => renderMd('')).not.toThrow();
  });

  it('combines bold and a link on the same line', () => {
    const { getByTestId } = renderMd('**note**: see [link](https://x.test)');
    const root = getByTestId('root');
    expect(root.querySelector('strong')?.textContent).toBe('note');
    expect(root.querySelector('a')?.textContent).toBe('link');
  });

  it('renders each non-list line as its own block (line breaks preserved)', () => {
    const { getByTestId } = renderMd('line one\nline two');
    const root = getByTestId('root');
    expect(root.children).toHaveLength(2);
    expect(root.children[0].textContent).toBe('line one');
    expect(root.children[1].textContent).toBe('line two');
  });
});
