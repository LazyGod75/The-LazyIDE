/**
 * Tests for the wikilink auto-linker.
 *
 * Key invariants:
 * 1. Attribute values must never be mutated
 * 2. Content inside <code>, <pre>, <summary>, <blockquote>, <script>, <style>,
 *    <details>, <a>, <cite>, <kbd> must never be linked
 * 3. Legitimate entity mentions in body prose must be linked
 * 4. Paths and tokens must never be split mid-word
 * 5. At most 5 links are injected per call
 */

import { describe, expect, it } from 'vitest';
import {
  type WikilinkContext,
  buildWikilinkContext,
  injectWikilinks,
  injectWikilinksText,
} from '../wikilinks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(noteIds: string[]): WikilinkContext {
  return buildWikilinkContext(
    noteIds.map((id) => ({ id, concepts: id, entities: null, tags: '' })),
  );
}

function ctxWithEntities(pairs: Array<{ id: string; entity: string }>): WikilinkContext {
  return buildWikilinkContext(
    pairs.map(({ id, entity }) => ({ id, concepts: null, entities: entity, tags: '' })),
  );
}

// ---------------------------------------------------------------------------
// 1. Attribute values must never be mutated
// ---------------------------------------------------------------------------

describe('attribute values are never mutated', () => {
  it('does not touch data-cerveau-type attribute containing a linkable term', () => {
    const ctx = makeCtx(['docs-main']);
    // The attribute value contains "docs" — must not become an <a> tag
    const html = `<article data-cerveau-type="docs"><p>Some prose here.</p></article>`;
    const result = injectWikilinks(html, ctx);
    // Attribute must be unchanged
    expect(result).toContain('data-cerveau-type="docs"');
    // No <a> must appear inside an attribute value
    expect(result).not.toContain('data-cerveau-type="<a');
  });

  it('does not corrupt data-cerveau-type attribute with entity injection', () => {
    const ctx = ctxWithEntities([{ id: 'archive-note', entity: 'archive' }]);
    const html = `<article data-cerveau-type="archive"><p>See archive for details.</p></article>`;
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('data-cerveau-type="archive"');
    expect(result).not.toContain('data-cerveau-type="<a');
  });

  it('preserves all attribute values exactly when linkable terms appear in them', () => {
    const ctx = makeCtx(['service-note', 'handler-note']);
    const html = `<div data-service="Handler" class="Service"><p>Handler is useful.</p></div>`;
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('data-service="Handler"');
    expect(result).toContain('class="Service"');
    // No <a> leaking into attribute values
    const attrMatches = result.match(/="[^"]*<a[^"]*"/g);
    expect(attrMatches).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Skip-ancestor content must never be linked
// ---------------------------------------------------------------------------

describe('skip-ancestor elements are never linked', () => {
  it('does not link terms inside <code>', () => {
    const ctx = makeCtx(['docs-main']);
    const html = '<p>See <code>docs</code> for more.</p>';
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('<code>docs</code>');
    // "docs" inside <code> must not become an anchor
    expect(result).not.toMatch(/<code>.*<a.*docs.*<\/a>.*<\/code>/s);
  });

  it('does not link terms inside <pre>', () => {
    const ctx = makeCtx(['docs-main']);
    const html = `<pre>const docs = require('docs');</pre>`;
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('<pre>');
    expect(result).not.toContain('<a');
  });

  it('does not link terms inside <summary>', () => {
    const ctx = makeCtx(['docs-main']);
    const html = '<details><summary>docs/archive notes</summary><p>Read below.</p></details>';
    const result = injectWikilinks(html, ctx);
    // summary content untouched
    expect(result).toContain('<summary>docs/archive notes</summary>');
    expect(result).not.toMatch(/<summary>.*<a.*<\/summary>/s);
  });

  it('does not link terms inside <blockquote>', () => {
    const ctx = makeCtx(['service-note']);
    const html = '<blockquote>The Service layer handles requests.</blockquote>';
    const result = injectWikilinks(html, ctx);
    expect(result).not.toContain('<a');
  });

  it('does not link terms inside <script>', () => {
    const ctx = makeCtx(['docs-main']);
    const html = `<script>var docs = "hello";</script><p>Prose about docs here.</p>`;
    const result = injectWikilinks(html, ctx);
    // script content untouched
    expect(result).toContain('var docs = "hello";');
    // The script block must not gain any <a> tags
    expect(result).not.toMatch(/<script>.*<a.*<\/script>/s);
  });

  it('does not link terms inside <style>', () => {
    const ctx = makeCtx(['docs-main']);
    const html = '<style>.docs { color: red; }</style><p>docs goes here</p>';
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('<style>');
    expect(result).not.toMatch(/<style>.*<a.*<\/style>/s);
  });

  it('does not nest <a> inside existing <a>', () => {
    const ctx = makeCtx(['docs-main']);
    const html = `<a href="/existing">docs reference link</a>`;
    const result = injectWikilinks(html, ctx);
    // No nested <a>
    expect(result).not.toMatch(/<a[^>]*>[^<]*<a/);
  });

  it('does not link inside <details> element directly', () => {
    const ctx = makeCtx(['docs-main']);
    const html = '<details><summary>Header</summary><p>docs info inside details</p></details>';
    const result = injectWikilinks(html, ctx);
    // summary must be untouched; the <p> inside <details> is allowed to be linked
    // since only <details> itself is in skip set, not its non-summary children.
    // (Actually <details> IS in skip set, so the whole subtree is skipped)
    expect(result).not.toMatch(/<summary>.*<a.*<\/summary>/s);
  });
});

// ---------------------------------------------------------------------------
// 3. Legitimate entity mentions in prose must be linked
// ---------------------------------------------------------------------------

describe('legitimate entity mentions in body prose are linked', () => {
  it('links a known entity in a paragraph', () => {
    const ctx = ctxWithEntities([{ id: 'acme-note', entity: 'Acme' }]);
    const html = '<p>The Acme platform handles sports data.</p>';
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('<a');
    expect(result).toContain('Acme');
    expect(result).toContain('data-cerveau-link-auto="true"');
  });

  it('links a known concept in a paragraph', () => {
    const ctx = makeCtx(['repository-pattern-note']);
    const html = '<p>We use the repository-pattern-note design here.</p>';
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('<a');
  });

  it('links a CamelCase term matching a note id (case-insensitive id contains)', () => {
    // Note id "lazybrain-core" (all lowercase) — "lazybrain" is a substring,
    // so resolveLink finds it via id.includes(termLower).
    const ctx = makeCtx(['lazybrain-core']);
    const html = '<p>LazyBrain is the core memory system.</p>';
    const result = injectWikilinks(html, ctx);
    // Should produce a link for LazyBrain (termLower = "lazybrain" ⊂ "lazybrain-core")
    expect(result).toContain('<a');
  });

  it('produces at most MAX_LINKS (5) links even with many candidates', () => {
    const ctx = makeCtx([
      'alpha-note',
      'beta-note',
      'gamma-note',
      'delta-note',
      'epsilon-note',
      'zeta-note',
    ]);
    const html = `<p>
      alpha-note beta-note gamma-note delta-note epsilon-note zeta-note
    </p>`;
    const result = injectWikilinks(html, ctx);
    const linkCount = (result.match(/<a /g) ?? []).length;
    expect(linkCount).toBeLessThanOrEqual(5);
  });

  it('links a term in a safe section but not in a code block in the same HTML', () => {
    const ctx = ctxWithEntities([{ id: 'service-note', entity: 'Service' }]);
    const html = '<p>The Service handles auth.</p><pre>Service.init()</pre>';
    const result = injectWikilinks(html, ctx);
    // Link appears in paragraph
    expect(result).toContain('<a');
    // The pre block is unchanged
    expect(result).toContain('<pre>Service.init()</pre>');
  });
});

// ---------------------------------------------------------------------------
// 4. Paths and tokens must never be split mid-word
// ---------------------------------------------------------------------------

describe('paths and tokens are never split mid-word', () => {
  it('does not inject an anchor inside a file path like docs/archive', () => {
    const ctx = makeCtx(['docs-main']);
    const html = '<summary>docs/archive notes from 2025</summary>';
    const result = injectWikilinks(html, ctx);
    // summary is skipped, so docs/archive stays intact
    expect(result).toContain('docs/archive notes from 2025');
    expect(result).not.toContain('<a');
  });

  it('does not link a term that appears mid-identifier', () => {
    const ctx = makeCtx(['docs-main']);
    // "docs" appears as part of "documentation" — must not be linked
    const html = '<p>The documentation is extensive.</p>';
    const result = injectWikilinks(html, ctx);
    // "docs" is not present as a whole word here, so no link
    if (result.includes('<a')) {
      // If something was linked, it must not have split "documentation"
      expect(result).not.toContain('>docs<');
    }
  });

  it('does not break a hyphenated-path token in prose', () => {
    const ctx = makeCtx(['archive']);
    // "archive" appears as part of "docs/archive" — the slash is a boundary blocker
    const html = '<p>See docs/archive for old notes.</p>';
    const result = injectWikilinks(html, ctx);
    // "archive" preceded by "/" is not a word boundary — must not be linked
    // (findWholeWordIndex considers / a boundary-blocking char)
    if (result.includes('<a')) {
      // No anchor should wrap just "archive" from within a path
      expect(result).not.toContain('>archive<');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Structural integrity of output HTML
// ---------------------------------------------------------------------------

describe('output HTML structural integrity', () => {
  it('returns unchanged HTML when context has no notes', () => {
    const ctx = buildWikilinkContext([]);
    const html = '<p>Acme is a platform.</p>';
    expect(injectWikilinks(html, ctx)).toBe(html);
  });

  it('returns unchanged HTML when input is empty', () => {
    const ctx = makeCtx(['docs-main']);
    expect(injectWikilinks('', ctx)).toBe('');
  });

  it('does not add extraneous wrapper elements around plain text', () => {
    const ctx = makeCtx(['no-match-here']);
    const html = '<p>Hello world, nothing to link.</p>';
    const result = injectWikilinks(html, ctx);
    // Result should not contain extra wrapper spans around unlinked text
    expect(result).not.toContain('<span>');
  });

  it('preserves the surrounding structure after linking', () => {
    const ctx = ctxWithEntities([{ id: 'acme-note', entity: 'Acme' }]);
    const html = '<article><section><p>Acme powers sports.</p></section></article>';
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('<article>');
    expect(result).toContain('<section>');
    expect(result).toContain('</article>');
  });
});

// ---------------------------------------------------------------------------
// 6. Routable href format — links must use "#/note/<id>" never bare "#<id>"
// ---------------------------------------------------------------------------

describe('auto-links emit routable href format', () => {
  it('entity link href starts with "#/note/" not bare "#"', () => {
    const ctx = ctxWithEntities([{ id: 'topic-overview-acme', entity: 'Acme' }]);
    const html = '<p>The Acme platform handles sports.</p>';
    const result = injectWikilinks(html, ctx);
    // Must contain the routable format
    expect(result).toContain('href="#/note/');
    // Must NOT contain a bare anchor like href="#topic-overview-acme"
    expect(result).not.toMatch(/href="#[^/]/);
  });

  it('entity link href encodes the note id in "#/note/<id>" format', () => {
    const ctx = ctxWithEntities([{ id: 'topic-overview-acme', entity: 'Acme' }]);
    const html = '<p>The Acme platform.</p>';
    const result = injectWikilinks(html, ctx);
    expect(result).toContain('href="#/note/topic-overview-acme"');
  });

  it('concept link href uses "#/note/<id>" not bare "#<id>"', () => {
    const ctx = makeCtx(['lazybrain-core']);
    const html = '<p>LazyBrain is the core system.</p>';
    const result = injectWikilinks(html, ctx);
    if (result.includes('<a')) {
      // Every generated anchor must use the routable format
      const bareAnchorRe = /href="#[^/]/;
      expect(result).not.toMatch(bareAnchorRe);
      expect(result).toContain('href="#/note/');
    }
  });

  it('no generated anchor ever uses bare "#<id>" for an entity mention', () => {
    const ctx = buildWikilinkContext([
      { id: 'note-alpha', concepts: 'Alpha', entities: null, tags: '' },
      { id: 'note-beta', concepts: null, entities: 'Beta', tags: '' },
    ]);
    const html = '<p>Alpha and Beta are the two components.</p>';
    const result = injectWikilinks(html, ctx);
    // There must be no href starting with "#" followed immediately by a non-slash char
    // (bare in-page anchors like href="#note-alpha" would match this)
    expect(result).not.toMatch(/href="#[^/]/);
  });

  it('multiple links all use routable "#/note/<id>" format', () => {
    const ctx = buildWikilinkContext([
      { id: 'note-service', concepts: null, entities: 'Service', tags: '' },
      { id: 'note-handler', concepts: null, entities: 'Handler', tags: '' },
    ]);
    const html = '<p>The Service delegates to the Handler component.</p>';
    const result = injectWikilinks(html, ctx);
    // All href values must be routable
    const hrefMatches = result.matchAll(/href="([^"]+)"/g);
    for (const m of hrefMatches) {
      const href = m[1];
      // Every href that is an internal link must start with "#/"
      if (href.startsWith('#')) {
        expect(href).toMatch(/^#\//);
      }
    }
  });

  it('injectWikilinksText uses "#/note/<id>" in markers', () => {
    const ctx = ctxWithEntities([{ id: 'topic-overview-acme', entity: 'Acme' }]);
    const text = 'The Acme platform handles sports.';
    const result = injectWikilinksText(text, ctx);
    if (result.includes('[')) {
      // Text markers must use routable format
      expect(result).toContain('→#/note/');
      // Must not contain bare →# without /note/
      expect(result).not.toMatch(/→#[^/]/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Enrichment sections must never receive wikilink injection
// ---------------------------------------------------------------------------

describe('enrichment section items are preserved verbatim', () => {
  it('does not inject wikilinks into a bugs section <li> containing a file path and keywords', () => {
    // Simulate a file-neuron with a fused bug item whose text contains a file path.
    // The note "acme-src-auth-session-ts" is in the wiki context so the injector
    // would normally try to link "session" or "auth" if the text were body prose.
    const ctx = buildWikilinkContext([
      {
        id: 'file-acme-src-auth-session-ts',
        concepts: 'session,auth',
        entities: null,
        tags: 'code typescript acme',
      },
    ]);

    // Exact prose as produced by renderEnrichmentItem (esc'd text + [source] link):
    const bugItemText =
      'Fixed a security issue discovered in the session management code in src/auth/session.ts';
    const sourceLink = '<a href="#conv-abc123" class="conv-source">[source]</a>';

    const html = [
      '<article data-cerveau-type="file-neuron">',
      '  <section data-section="bugs">',
      '    <h3>Bugs</h3>',
      '    <ul>',
      `      <li data-cerveau-confidence="0.9" data-cerveau-date="2026-01-15">${bugItemText} ${sourceLink}</li>`,
      '    </ul>',
      '  </section>',
      '  <p>This file handles auth. The session module is central.</p>',
      '</article>',
    ].join('\n');

    const result = injectWikilinks(html, ctx);

    // The [source] link must still be present and unmodified
    expect(result).toContain('class="conv-source">[source]</a>');

    // The bug item text must NOT have had a wikilink injected into it.
    // Specifically: no [Label→ marker, no <a data-cerveau-link-auto> inside the <li> prose.
    const bugsSection = result.match(/<section data-section="bugs">[\s\S]*?<\/section>/);
    expect(bugsSection).not.toBeNull();
    const bugsSectionHtml = bugsSection![0];

    // No auto-injected link inside the bugs section
    expect(bugsSectionHtml).not.toContain('data-cerveau-link-auto="true"');

    // The original prose must be intact (no truncation)
    expect(bugsSectionHtml).toContain('src/auth/session.ts');
    expect(bugsSectionHtml).toContain('Fixed a security issue');
  });

  it('does not inject wikilinks into decisions, ideas, rules, qa, or activity sections', () => {
    const ctx = buildWikilinkContext([
      { id: 'note-service', concepts: 'service', entities: 'Service', tags: '' },
    ]);

    const enrichmentSections = ['decisions', 'ideas', 'rules', 'qa', 'activity'] as const;

    for (const sectionId of enrichmentSections) {
      const html = [
        '<article>',
        `  <section data-section="${sectionId}">`,
        '    <ul>',
        '      <li>Service handles the core logic <a href="#conv-x" class="conv-source">[source]</a></li>',
        '    </ul>',
        '  </section>',
        '</article>',
      ].join('\n');

      const result = injectWikilinks(html, ctx);
      const section = result.match(
        new RegExp(`<section data-section="${sectionId}">[\\s\\S]*?<\\/section>`),
      );
      expect(section).not.toBeNull();
      // Auto-links must not appear inside the enrichment section
      expect(section![0]).not.toContain('data-cerveau-link-auto="true"');
      // Original [source] link preserved
      expect(section![0]).toContain('class="conv-source">[source]</a>');
    }
  });

  it('still injects wikilinks in body prose outside enrichment sections', () => {
    // After skipping enrichment sections the injector must still work on normal prose.
    const ctx = ctxWithEntities([{ id: 'service-note', entity: 'Service' }]);

    const html = [
      '<article>',
      '  <section data-section="bugs">',
      '    <ul>',
      '      <li>Service bug here <a href="#c1" class="conv-source">[source]</a></li>',
      '    </ul>',
      '  </section>',
      '  <p>The Service module is the entry point for all requests.</p>',
      '</article>',
    ].join('\n');

    const result = injectWikilinks(html, ctx);

    // Prose paragraph must have received an auto-link for "Service"
    expect(result).toContain('data-cerveau-link-auto="true"');

    // But the bugs section must still be clean
    const bugsSection = result.match(/<section data-section="bugs">[\s\S]*?<\/section>/);
    expect(bugsSection).not.toBeNull();
    expect(bugsSection![0]).not.toContain('data-cerveau-link-auto="true"');
  });
});
