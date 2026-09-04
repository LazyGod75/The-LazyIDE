import { describe, expect, it } from 'vitest';
import type {
  InCategories,
  InDataTable,
  InInfobox,
  InJsonLd,
  InLeadSection,
  InSeeAlso,
  InToc,
} from '../types.js';

describe('block types', () => {
  it('InInfobox has required fields', () => {
    const input: InInfobox = {
      rows: [{ label: 'Type', value: 'decision' }],
    };
    expect(input.rows).toHaveLength(1);
    expect(input.rows[0].label).toBe('Type');
  });

  it('InLeadSection has required fields', () => {
    const input: InLeadSection = {
      subject: 'Tradebot Bot',
      description: 'A live tradelab bot for MT5.',
    };
    expect(input.subject).toBe('Tradebot Bot');
  });

  it('InDataTable has required fields', () => {
    const input: InDataTable = {
      caption: 'Notes in topic',
      headers: ['Title', 'Date', 'Type'],
      rows: [['Note 1', '2026-01-01', 'decision']],
      sortable: true,
    };
    expect(input.headers).toHaveLength(3);
  });

  it('InSeeAlso has required fields', () => {
    const input: InSeeAlso = {
      links: [{ id: 'abc-123', title: 'Related note' }],
    };
    expect(input.links).toHaveLength(1);
  });

  it('InCategories has required fields', () => {
    const input: InCategories = { tags: ['tradelab', 'ml'] };
    expect(input.tags).toHaveLength(2);
  });

  it('InToc has required fields', () => {
    const input: InToc = {
      entries: [
        { level: 1, id: 'overview', text: 'Overview' },
        { level: 2, id: 'details', text: 'Details' },
      ],
    };
    expect(input.entries).toHaveLength(2);
  });

  it('InJsonLd has required fields', () => {
    const input: InJsonLd = {
      title: 'My Note',
      type: 'decision',
      dateCreated: '2026-01-01',
      tags: ['tradelab'],
    };
    expect(input.title).toBe('My Note');
  });
});
