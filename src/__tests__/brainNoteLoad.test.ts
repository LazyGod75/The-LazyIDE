import { describe, it, expect } from 'vitest';
import { extractWikiBodyFromHtml, wikiEdgeLinks, loadWikiNote } from '../lib/brain/brainNoteLoad';

describe('wikiEdgeLinks', () => {
  const names = new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]);
  const links = [
    { source: 'a', target: 'b', type: 'relates' },
    { source: 'c', target: 'a', type: 'mentions' },
  ];

  it('builds outgoing and incoming labels, capped at 12', () => {
    expect(wikiEdgeLinks('a', links, names)).toEqual([
      { label: 'relates →', target: 'Beta' },
      { label: '← mentions', target: 'Gamma' },
    ]);
  });
});

describe('extractWikiBodyFromHtml', () => {
  it('prefers tldr over summary and strips tags', () => {
    const html = '<section data-section="tldr"><p>Hello &amp; world</p></section>';
    expect(extractWikiBodyFromHtml(html, 'fallback')).toBe('Hello & world…');
  });

  it('returns the fallback when no tldr/summary section exists', () => {
    expect(extractWikiBodyFromHtml('<article></article>', 'fallback')).toBe('fallback');
  });
});

describe('loadWikiNote', () => {
  it('loads web note-meta + html into a wiki payload', async () => {
    const payload = await loadWikiNote({
      nodeId: 'n1',
      isTauri: false,
      t: (key) => key,
      links: [],
      nodes: [{ id: 'n1', name: 'One' }],
      note: async () => { throw new Error('unused'); },
      noteHtml: async () => '',
      fetchWebMeta: async () => new Response(JSON.stringify({
        id: 'n1', title: 'One', type: 'decision', topic: 'brain',
        tags: '', importance: 0.5, created: null,
      }), { status: 200 }),
      fetchWebHtml: async () => new Response(
        '<section data-section="summary">Body text</section>',
        { status: 200 },
      ),
    });
    expect(payload?.title).toBe('One');
    expect(payload?.body).toBe('Body text…');
  });
});
