import { describe, expect, it } from 'vitest';
import { renderDataTable } from '../data-table.js';
import { renderLeadSection } from '../lead-section.js';
import { renderSeeAlso } from '../see-also.js';
import { renderToc } from '../toc.js';

describe('lead-section', () => {
  it('renders lead with bold subject', () => {
    const html = renderLeadSection({
      subject: 'Tradebot Bot',
      description: 'A live tradelab bot for MetaTrader 5 with risk management.',
    });
    expect(html).toContain('data-section="lead"');
    expect(html).toContain('<b>Tradebot Bot</b>');
    expect(html).toContain('A live tradelab bot');
  });
  it('returns empty for empty description', () => {
    expect(renderLeadSection({ subject: '', description: '' })).toBe('');
  });
});

describe('toc', () => {
  it('renders hierarchical TOC with levels', () => {
    const html = renderToc({
      entries: [
        { level: 1, id: 'overview', text: 'Overview' },
        { level: 2, id: 'architecture', text: 'Architecture' },
        { level: 1, id: 'notes', text: 'Notes' },
      ],
    });
    expect(html).toContain('<nav class="toc" role="navigation"');
    expect(html).toContain('aria-label="Table of contents"');
    expect(html).toContain('toclevel-1');
    expect(html).toContain('toclevel-2');
    expect(html).toContain('href="#overview"');
    expect(html).toContain('<span class="toctext">Overview</span>');
  });
  it('returns empty for no entries', () => {
    expect(renderToc({ entries: [] })).toBe('');
  });
});

describe('data-table', () => {
  it('renders wikitable with caption and headers', () => {
    const html = renderDataTable({
      caption: 'Notes in Tradelab',
      headers: ['Title', 'Date', 'Type', 'Importance'],
      rows: [
        ['Tradebot Architecture', '2026-05-01', 'architecture', '0.90'],
        ['Risk Model', '2026-05-10', 'decision', '0.85'],
      ],
      sortable: true,
    });
    expect(html).toContain('<table class="wikitable sortable">');
    expect(html).toContain('<caption>Notes in Tradelab</caption>');
    expect(html).toContain('<th scope="col">Title</th>');
    expect(html).toContain('<td>Tradebot Architecture</td>');
  });
  it('renders without sortable class when false', () => {
    const html = renderDataTable({
      caption: 'Test',
      headers: ['A'],
      rows: [['1']],
      sortable: false,
    });
    expect(html).toContain('<table class="wikitable">');
    expect(html).not.toContain('sortable');
  });
  it('returns empty for no rows', () => {
    expect(renderDataTable({ caption: 'Empty', headers: ['A'], rows: [], sortable: false })).toBe(
      '',
    );
  });
});

describe('see-also', () => {
  it('renders see-also section with links', () => {
    const html = renderSeeAlso({
      links: [
        { id: 'abc-123', title: 'Related Topic' },
        { id: 'def-456', title: 'Another Topic' },
      ],
    });
    expect(html).toContain('data-section="see-also"');
    expect(html).toContain('<h2>See also</h2>');
    expect(html).toContain('href="#/abc-123"');
    expect(html).toContain('Related Topic');
  });
  it('returns empty for no links', () => {
    expect(renderSeeAlso({ links: [] })).toBe('');
  });
});
