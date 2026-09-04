import { describe, expect, it } from 'vitest';
import { aggregateTopicStats, groupNotesByTopic, isStale } from '../synthesize.js';

describe('groupNotesByTopic', () => {
  it('groups notes by the first segment of data-cerveau-topic', () => {
    const notes = [
      {
        html: '<article data-cerveau-topic="tradelab/ml" data-cerveau-type="decision" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test" id="a"></article>',
        path: 'a.html',
        id: 'a',
        sizeBytes: 100,
        mtimeMs: 1000,
      },
      {
        html: '<article data-cerveau-topic="tradelab/risk" data-cerveau-type="semantic" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test" id="b"></article>',
        path: 'b.html',
        id: 'b',
        sizeBytes: 100,
        mtimeMs: 2000,
      },
      {
        html: '<article data-cerveau-topic="acme/website" data-cerveau-type="feature" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test" id="c"></article>',
        path: 'c.html',
        id: 'c',
        sizeBytes: 100,
        mtimeMs: 3000,
      },
    ];
    const groups = groupNotesByTopic(notes);
    expect(groups.get('tradelab')).toHaveLength(2);
    expect(groups.get('acme')).toHaveLength(1);
  });

  it('excludes synthesis pages from grouping', () => {
    const notes = [
      {
        html: '<article data-cerveau-topic="tradelab" data-cerveau-type="topic-overview" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test" id="synth"></article>',
        path: 's.html',
        id: 'synth',
        sizeBytes: 100,
        mtimeMs: 1000,
      },
      {
        html: '<article data-cerveau-topic="tradelab/ml" data-cerveau-type="decision" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test" id="a"></article>',
        path: 'a.html',
        id: 'a',
        sizeBytes: 100,
        mtimeMs: 2000,
      },
    ];
    const groups = groupNotesByTopic(notes);
    expect(groups.get('tradelab')).toHaveLength(1);
    expect(groups.get('tradelab')![0].id).toBe('a');
  });
});

describe('aggregateTopicStats', () => {
  it('computes correct stats', () => {
    const notes = [
      {
        html: '<article data-cerveau-type="decision" data-cerveau-importance="0.90" data-cerveau-created="2026-01-01T00:00:00Z" data-cerveau-tags="tradelab" data-cerveau-version="0.2.0" data-cerveau-source="test" id="a"></article>',
        path: 'a.html',
        id: 'a',
        sizeBytes: 100,
        mtimeMs: 1000,
      },
      {
        html: '<article data-cerveau-type="semantic" data-cerveau-importance="0.70" data-cerveau-created="2026-03-15T00:00:00Z" data-cerveau-tags="tradelab" data-cerveau-version="0.2.0" data-cerveau-source="test" id="b"></article>',
        path: 'b.html',
        id: 'b',
        sizeBytes: 200,
        mtimeMs: 2000,
      },
    ];
    const stats = aggregateTopicStats(notes);
    expect(stats.noteCount).toBe(2);
    expect(stats.typeBreakdown).toEqual({ decision: 1, semantic: 1 });
    expect(stats.avgImportance).toBeCloseTo(0.8);
    expect(stats.dateRange[0]).toBe('2026-01-01T00:00:00Z');
    expect(stats.dateRange[1]).toBe('2026-03-15T00:00:00Z');
  });
});

describe('isStale', () => {
  it('returns true when no synthesis exists', () => {
    expect(isStale(null, 1000)).toBe(true);
  });

  it('returns false when synthesis is newer than latest note', () => {
    const synthHtml =
      '<article data-cerveau-synthesized-at="2026-05-26T12:00:00Z" id="s"></article>';
    const latestNoteMtime = new Date('2026-05-26T10:00:00Z').getTime();
    expect(isStale(synthHtml, latestNoteMtime)).toBe(false);
  });

  it('returns true when a note is newer than synthesis', () => {
    const synthHtml =
      '<article data-cerveau-synthesized-at="2026-05-26T10:00:00Z" id="s"></article>';
    const latestNoteMtime = new Date('2026-05-26T12:00:00Z').getTime();
    expect(isStale(synthHtml, latestNoteMtime)).toBe(true);
  });
});

/**
 * Regression: note-chips must use the actual article id, not a sub-topic name.
 *
 * Before the fix, if a note HTML had a <section id="nutrition"> before the
 * <article id="uuid">, reader.ts idFromHtml() would extract "nutrition" instead
 * of the UUID, causing note-chip links to point to #/note/nutrition.
 *
 * The fix restricts idFromHtml() to only match <article> tags, never <section>.
 */
describe('groupNotesByTopic — note id extraction regression', () => {
  it('uses article id, not section id, when section appears before article', () => {
    // Simulate a note whose HTML has a <section id="nutrition"> BEFORE the <article id="uuid">
    const noteWithSectionFirst = {
      // Note: readNote() would call idFromHtml which searches for first article|section id.
      // With the bug: id would be 'nutrition' (from the section).
      // With the fix: id must be 'uuid-acme-nutrition' (from the article).
      html: '<section id="nutrition"><p>intro</p></section><article id="uuid-acme-nutrition" data-cerveau-topic="acme/nutrition" data-cerveau-type="reference" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test"><h2>Nutrition Engine</h2></article>',
      path: 'uuid-acme-nutrition.html',
      // reader.ts must extract this from <article>, not from <section>
      id: 'uuid-acme-nutrition',
      sizeBytes: 200,
      mtimeMs: 1000,
    };

    const groups = groupNotesByTopic([noteWithSectionFirst]);
    const acmeNotes = groups.get('acme');
    expect(acmeNotes).toHaveLength(1);
    // The note id in the group must be the article id
    expect(acmeNotes![0].id).toBe('uuid-acme-nutrition');
    // The id must NOT be the sub-topic name 'nutrition'
    expect(acmeNotes![0].id).not.toBe('nutrition');
  });

  it('correctly uses uuid article ids in grouped notes', () => {
    const notes = [
      {
        html: '<article id="4d767534-85a7-4dbb-8559-22b212e320de" data-cerveau-topic="acme/nutrition" data-cerveau-type="reference" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test"><h2>Nutrition Engine</h2></article>',
        path: '4d767534-85a7-4dbb-8559-22b212e320de.html',
        id: '4d767534-85a7-4dbb-8559-22b212e320de',
        sizeBytes: 200,
        mtimeMs: 1000,
      },
      {
        html: '<article id="800fadb0-9137-40e2-8697-e1edc2942dd0" data-cerveau-topic="acme/mobile" data-cerveau-type="concept" data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test"><h2>Mobile Architecture</h2></article>',
        path: '800fadb0-9137-40e2-8697-e1edc2942dd0.html',
        id: '800fadb0-9137-40e2-8697-e1edc2942dd0',
        sizeBytes: 200,
        mtimeMs: 1000,
      },
    ];

    const groups = groupNotesByTopic(notes);
    const acmeNotes = groups.get('acme') ?? [];
    const ids = acmeNotes.map((n) => n.id);

    // IDs must be full UUIDs, never short sub-topic names like 'nutrition' or 'mobile'
    expect(ids).toContain('4d767534-85a7-4dbb-8559-22b212e320de');
    expect(ids).toContain('800fadb0-9137-40e2-8697-e1edc2942dd0');
    expect(ids).not.toContain('nutrition');
    expect(ids).not.toContain('mobile');
  });
});
