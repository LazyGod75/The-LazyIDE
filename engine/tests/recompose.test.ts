/**
 * recompose.test.ts — tests for recomposeFileNeuronEnrichment.
 *
 * Covers:
 *   1. Patches sections from items without rescanning code.
 *   2. Two authors, same file → two <li> with different author-id.
 *   3. Dedup by itemId — two items with same itemId → only one <li>.
 *   4. Items sorted by date descending.
 *   5. Existing structure (breadcrumb, infobox) preserved.
 */

import { describe, it, expect } from 'vitest';
import { recomposeFileNeuronEnrichment, type AuthoredItem } from '../src/annotator/blocks/composers/recompose.js';

function makeItem(overrides: Partial<AuthoredItem> & { kind: string; text: string; date: string }): AuthoredItem {
  return {
    confidence: 0.8,
    sourceConvLink: '#conv-test',
    ...overrides,
  };
}

const FIXTURE_HTML = `<article data-cerveau-type="file-neuron" id="file-src-index-ts">
  <nav class="breadcrumb"><a href="#root">root</a> / <a href="#src">src</a></nav>
  <aside class="infobox" data-cerveau-infobox="true"><p>File info</p></aside>
  <section data-section="bugs">
    <h3>Bugs</h3>
    <ul><li data-cerveau-date="2026-01-01" data-cerveau-confidence="0.5">Old bug</li></ul>
  </section>
  <section data-section="see-also">
    <h3>See also</h3>
    <ul><li><a href="#other">Other file</a></li></ul>
  </section>
</article>`;

describe('recomposeFileNeuronEnrichment', () => {
  it('patches sections from items without rescanning code (replaces existing section content)', () => {
    const items = [
      makeItem({ kind: 'bug', text: 'New bug found', date: '2026-03-01', itemId: 'bug-1' }),
    ];

    const result = recomposeFileNeuronEnrichment(FIXTURE_HTML, items);

    expect(result).toContain('New bug found');
    expect(result).not.toContain('Old bug');
    expect(result).toContain('data-section="bugs"');
  });

  it('two authors, same file → two <li> with different author-id', () => {
    const items = [
      makeItem({ kind: 'bug', text: 'Alice bug', date: '2026-03-01', authorId: 'user-a', author: 'alice', itemId: 'bug-a' }),
      makeItem({ kind: 'bug', text: 'Bob bug', date: '2026-03-02', authorId: 'user-b', author: 'bob', itemId: 'bug-b' }),
    ];

    const result = recomposeFileNeuronEnrichment(FIXTURE_HTML, items);

    const liMatches = result.match(/<li[^>]*data-cerveau-author-id="user-[ab]"[^>]*>/g);
    expect(liMatches).toHaveLength(2);
    expect(result).toContain('data-cerveau-author-id="user-a"');
    expect(result).toContain('data-cerveau-author-id="user-b"');
  });

  it('dedup by itemId — two items with same itemId → only one <li>', () => {
    const items = [
      makeItem({ kind: 'bug', text: 'First capture', date: '2026-03-01', itemId: 'bug-dup', authorId: 'user-a' }),
      makeItem({ kind: 'bug', text: 'Duplicate capture', date: '2026-03-02', itemId: 'bug-dup', authorId: 'user-b' }),
    ];

    const result = recomposeFileNeuronEnrichment(FIXTURE_HTML, items);

    const liMatches = result.match(/<li[^>]*>/g);
    const bugLis = liMatches?.filter((li) => li.includes('data-cerveau-item-id="bug-dup"')) ?? [];
    expect(bugLis).toHaveLength(1);
    // sortByDateDesc runs before dedup, so the newer item wins.
    expect(result).toContain('Duplicate capture');
  });

  it('items sorted by date descending', () => {
    const items = [
      makeItem({ kind: 'bug', text: 'Older', date: '2026-01-01', itemId: 'bug-old' }),
      makeItem({ kind: 'bug', text: 'Newer', date: '2026-06-01', itemId: 'bug-new' }),
      makeItem({ kind: 'bug', text: 'Middle', date: '2026-03-01', itemId: 'bug-mid' }),
    ];

    const result = recomposeFileNeuronEnrichment(FIXTURE_HTML, items);

    const idxNewer = result.indexOf('Newer');
    const idxMiddle = result.indexOf('Middle');
    const idxOlder = result.indexOf('Older');
    expect(idxNewer).toBeLessThan(idxMiddle);
    expect(idxMiddle).toBeLessThan(idxOlder);
  });

  it('existing structure (breadcrumb, infobox) preserved', () => {
    const items = [
      makeItem({ kind: 'bug', text: 'A bug', date: '2026-03-01', itemId: 'bug-x' }),
    ];

    const result = recomposeFileNeuronEnrichment(FIXTURE_HTML, items);

    expect(result).toContain('class="breadcrumb"');
    expect(result).toContain('data-cerveau-infobox="true"');
    expect(result).toContain('File info');
    expect(result).toContain('data-section="see-also"');
  });

  it('returns the original HTML unchanged when no file-neuron article is present', () => {
    const html = '<div><p>Not a file neuron</p></div>';
    const result = recomposeFileNeuronEnrichment(html, []);
    expect(result).toBe(html);
  });
});
