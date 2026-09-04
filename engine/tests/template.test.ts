import { describe, expect, it } from 'vitest';
import { emitWikipediaNote } from '../src/annotator/template.js';
import { stripNote, stripTags } from '../src/retrieval/strip.js';

describe('emitWikipediaNote — ARIA & JSON-LD', () => {
  const sampleInput = {
    id: 'test-001',
    title: 'ORM Migration',
    type: 'decision',
    created: '2026-05-23T10:00:00Z',
    source: 'session:test',
    tier: 'working' as const,
    importance: 0.95,
    tags: ['database', 'refactor'],
    facts: [
      { text: 'Switched ORM', confidence: 1, kind: 'decision' },
      { text: 'Reason: stability', confidence: 0.9, kind: 'rationale' },
      { text: 'Tests pass', confidence: 0.95, kind: 'verification' },
    ],
    relations: {
      replaces: ['old-001'],
      entities: ['lib:prisma', 'lib:kysely'],
    },
    validForDays: null,
    meanConfidence: 0.95,
  };

  it('emits aria-current="page" when note replaces others and not expired', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('aria-current="page"');
  });

  it('emits aria-expanded="true" on primary fact <details open>', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('<details open data-primary aria-expanded="true">');
  });

  it('emits aria-expanded="false" on secondary fact <details>', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('<details aria-expanded="false">');
  });

  it('assigns fact IDs for aria-describedby linking', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('id="fact-0"');
    expect(html).toContain('id="fact-1"');
    expect(html).toContain('id="fact-2"');
  });

  it('emits JSON-LD script with TechArticle type', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type": "TechArticle"');
    expect(html).toContain('"@id": "memory://test-001"');
    expect(html).toContain('"name": "ORM Migration"');
  });

  it('includes entities in JSON-LD about field', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('"about":');
    expect(html).toContain('memory://lib:prisma');
    expect(html).toContain('memory://lib:kysely');
  });

  it('includes replaces as supersedes in JSON-LD', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('"supersedes":');
    expect(html).toContain('memory://old-001');
  });

  it('strips JSON-LD from text output', () => {
    const html = emitWikipediaNote(sampleInput);
    const stripped = stripTags(html);
    expect(stripped).not.toContain('@type');
    expect(stripped).not.toContain('TechArticle');
    expect(stripped).not.toContain('application/ld+json');
  });

  it('preserves facts in stripped output', () => {
    const html = emitWikipediaNote(sampleInput);
    const stripped = stripTags(html);
    expect(stripped).toContain('Switched ORM');
    expect(stripped).toContain('Reason: stability');
    expect(stripped).toContain('Tests pass');
  });

  it('stripNote extracts all facts correctly', () => {
    const html = emitWikipediaNote(sampleInput);
    const note = stripNote(html);
    expect(note.facts.length).toBe(3);
    expect(note.facts[0].text).toBe('Switched ORM');
    expect(note.facts[1].text).toBe('Reason: stability');
    expect(note.facts[2].text).toBe('Tests pass');
  });

  it('does not emit aria-current when note expires (validForDays set)', () => {
    const withExpiry = { ...sampleInput, validForDays: 30 };
    const html = emitWikipediaNote(withExpiry);
    expect(html).not.toContain('aria-current="page"');
  });

  it('does not emit aria-current when note has no replaces', () => {
    const noReplaces = { ...sampleInput, relations: { entities: ['lib:test'] } };
    const html = emitWikipediaNote(noReplaces);
    expect(html).not.toContain('aria-current="page"');
  });

  it('full HTML structure contains all semantic markers', () => {
    const html = emitWikipediaNote(sampleInput);
    // Verify the complete structure
    expect(html).toContain('<article id="test-001"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<details open data-primary aria-expanded="true">');
    expect(html).toContain('<details aria-expanded="false">');
    expect(html).toContain('id="fact-0"');
    expect(html).toContain('id="fact-1"');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('@type');
    expect(html).toContain('TechArticle');
    // Verify facts are in the output
    expect(html).toContain('Switched ORM');
    expect(html).toContain('Reason: stability');
    // Verify infobox
    expect(html).toContain('<aside class="infobox">');
    // Verify glossary
    expect(html).toContain('<aside class="glossary">');
  });
});
