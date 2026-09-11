import { describe, expect, it } from 'vitest';
import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron';
import type { CodeNode } from '../src/graph/code-scanner';
import {
  stripNote,
  stripNoteToPrompt,
  stripSection,
  stripSections,
  stripTags,
} from '../src/retrieval/strip';

describe('stripTags', () => {
  it('strips simple tags', () => {
    expect(stripTags('<p>hello <b>world</b></p>')).toBe('hello world');
  });

  it('preserves paragraph breaks', () => {
    expect(stripTags('<p>a</p><p>b</p>')).toContain('a');
    expect(stripTags('<p>a</p><p>b</p>')).toContain('b');
    expect(stripTags('<p>a</p><p>b</p>').includes('\n')).toBe(true);
  });

  it('formats list items as dashes', () => {
    const out = stripTags('<ul><li>one</li><li>two</li></ul>');
    expect(out).toContain('- one');
    expect(out).toContain('- two');
  });

  it('preserves external link URLs', () => {
    const out = stripTags('<a href="https://example.com">click</a>');
    expect(out).toContain('click');
    expect(out).toContain('https://example.com');
  });

  it('formats internal anchor hrefs as wikilink notation', () => {
    const out = stripTags('<a href="#section">jump</a>');
    expect(out).toBe('[jump→#section]');
  });

  it('removes script and style', () => {
    expect(stripTags('<p>ok</p><script>alert(1)</script>')).toBe('ok');
    expect(stripTags('<p>ok</p><style>body{color:red}</style>')).toBe('ok');
  });

  it('handles empty input', () => {
    expect(stripTags('')).toBe('');
  });

  it('collapses excess whitespace', () => {
    expect(stripTags('<p>a   b\t\tc</p>')).toBe('a b c');
  });
});

describe('stripNote', () => {
  const sample = `
    <article id="auth-1"
             data-cerveau-version="0.1.0"
             data-cerveau-created="2026-05-20T10:15:00Z"
             data-cerveau-type="decision"
             data-cerveau-source="session:abc#42"
             data-cerveau-importance="0.9"
             data-cerveau-tags="auth oauth security">
      <h2>Migration OAuth2</h2>
      <p data-cerveau-fact data-cerveau-confidence="1">Décision: passage à OAuth2 PKCE.</p>
      <p data-cerveau-fact data-cerveau-confidence="0.8" data-cerveau-extracted-by="llm:claude-opus-4-7">
        Motif: audit Q2.
      </p>
      <a href="../audit.html" data-cerveau-link-type="cites" data-cerveau-link-strength="0.9">audit</a>
    </article>`;

  it('extracts id', () => {
    expect(stripNote(sample).id).toBe('auth-1');
  });

  it('extracts type and source', () => {
    const n = stripNote(sample);
    expect(n.type).toBe('decision');
    expect(n.source).toBe('session:abc#42');
  });

  it('extracts tags', () => {
    expect(stripNote(sample).tags).toEqual(['auth', 'oauth', 'security']);
  });

  it('extracts facts with confidence', () => {
    const facts = stripNote(sample).facts;
    expect(facts.length).toBe(2);
    expect(facts[0].confidence).toBe(1);
    expect(facts[1].confidence).toBe(0.8);
    expect(facts[1].extractor).toBe('llm:claude-opus-4-7');
  });

  it('extracts links with type', () => {
    const links = stripNote(sample).links;
    expect(links.length).toBe(1);
    expect(links[0].type).toBe('cites');
    expect(links[0].strength).toBe(0.9);
  });

  it('extracts importance', () => {
    expect(stripNote(sample).importance).toBe(0.9);
  });
});

describe('stripNoteToPrompt — token efficiency', () => {
  it('produces compact representation', () => {
    const sample = `
      <article id="x" data-cerveau-version="0.1.0"
               data-cerveau-created="2026-05-20" data-cerveau-source="s:1"
               data-cerveau-type="decision" data-cerveau-tags="a b">
        <p data-cerveau-fact>fact one</p>
        <p data-cerveau-fact>fact two</p>
      </article>`;
    const out = stripNoteToPrompt(stripNote(sample));
    // Compact format uses single-letter type codes (D=decision) for density.
    expect(out).toMatch(/^D /);
    expect(out).toContain('#x');
    expect(out).toContain('a, b');
    expect(out).toContain('fact one');
    expect(out).toContain('fact two');
    expect(out.length).toBeLessThan(300);
  });

  it('surfaces graph relations when present (B5)', () => {
    const sample = `
      <article id="y" data-cerveau-version="0.1.0"
               data-cerveau-created="2026-05-22" data-cerveau-source="s:2"
               data-cerveau-type="decision" data-cerveau-tags="db"
               data-cerveau-replaces="postgres-prod"
               data-cerveau-causes="ops overhead too high"
               data-cerveau-triples="sqlite|replaces|postgres-prod"
               data-cerveau-entities="db:sqlite,db:postgres-prod">
        <p data-cerveau-fact>switched cache to SQLite</p>
      </article>`;
    const out = stripNoteToPrompt(stripNote(sample));
    expect(out).toContain('↺postgres-prod');
    expect(out).toContain('∵ops overhead');
    expect(out).toContain('◦sqlite|replaces|postgres-prod');
    expect(out).toContain('⊕db:sqlite');
  });
});

describe('Wikipedia layer — strip behaviour', () => {
  it('formats internal wikilink as [term→#id]', () => {
    const out = stripTags('<a href="#repo-spec" data-cerveau-link-type="see-also">Repository</a>');
    expect(out).toBe('[Repository→#repo-spec]');
  });

  it('formats red-link as [term?]', () => {
    const out = stripTags('<a data-red-link="Repository">Repository</a>');
    expect(out).toBe('[Repository?]');
  });

  it('emits section header for named sections', () => {
    const out = stripTags('<section data-section="context"><p>detail</p></section>');
    expect(out).toContain('[context]');
    expect(out).toContain('detail');
  });

  it('does not emit header for summary/facts sections', () => {
    const out = stripTags('<section data-section="summary"><p>fact one</p></section>');
    expect(out).not.toContain('[summary]');
    expect(out).toContain('fact one');
  });

  it('flattens infobox dl to key: value pairs', () => {
    const out = stripTags(
      '<aside class="infobox"><dl><dt>Type</dt><dd>decision</dd><dt>Tags</dt><dd>auth</dd></dl></aside>',
    );
    expect(out).toContain('Type: decision');
    expect(out).toContain('Tags: auth');
  });

  it('emits see-also as compact line', () => {
    const out = stripTags(
      '<section data-section="see-also"><nav class="see-also">See also: <a href="#note1">note1</a>, <a href="#note2">note2</a></nav></section>',
    );
    expect(out).toContain('See also:');
    expect(out).toContain('#note1');
    expect(out).toContain('#note2');
  });

  it('emits categories from footer nav', () => {
    const out = stripTags(
      '<footer><nav class="categories">Categories: <a href="#cat-decision">decision</a> · <a href="#cat-auth">auth</a></nav></footer>',
    );
    expect(out).toContain('Categories:');
    expect(out).toContain('decision');
    expect(out).toContain('auth');
  });

  it('stripNote extracts infobox from Wikipedia template', () => {
    const html = `
      <article id="wiki-1"
               data-cerveau-version="0.2.0"
               data-cerveau-created="2026-05-24T10:00:00Z"
               data-cerveau-type="decision"
               data-cerveau-source="session:abc"
               data-cerveau-importance="0.9"
               data-cerveau-tags="frontend css">
        <header>
          <h2>Tailwind migration</h2>
          <aside class="infobox">
            <dl>
              <dt>Type</dt><dd>decision</dd>
              <dt>Tags</dt><dd>frontend, css</dd>
            </dl>
          </aside>
        </header>
        <section data-section="summary">
          <p data-cerveau-fact data-cerveau-confidence="0.9" data-cerveau-kind="decision">Switched to Tailwind v4.</p>
        </section>
        <section data-section="see-also">
          <nav class="see-also">See also: <a href="#tailwind-v3">tailwind-v3</a></nav>
        </section>
        <footer>
          <nav class="categories">Categories: <a href="#cat-decision">decision</a></nav>
        </footer>
      </article>`;
    const n = stripNote(html);
    expect(n.infobox?.Type).toBe('decision');
    expect(n.seeAlso).toContain('tailwind-v3');
    expect(n.categories).toContain('decision');
  });

  it('stripNoteToPrompt surfaces see-also and wikilinks', () => {
    const html = `
      <article id="z" data-cerveau-version="0.2.0"
               data-cerveau-created="2026-05-24" data-cerveau-source="s:1"
               data-cerveau-type="decision" data-cerveau-tags="db">
        <section data-section="summary">
          <p data-cerveau-fact>use Repository pattern</p>
        </section>
        <section data-section="see-also">
          <nav class="see-also">See also: <a href="#repo-spec">repo-spec</a></nav>
        </section>
        <footer>
          <nav class="categories">Categories: <a href="#cat-db">db</a></nav>
        </footer>
      </article>`;
    const out = stripNoteToPrompt(stripNote(html));
    expect(out).toContain('See also: #repo-spec');
  });
});

describe('stripSection — selective section stripping', () => {
  const html = `
    <article data-cerveau-type="decision" data-cerveau-tags="auth database">
      <section data-section="tldr">
        <p>We use OAuth2 PKCE via Supabase Auth instead of custom JWT.</p>
      </section>
      <section data-section="reasoning">
        <p>Custom JWT means maintenance burden: token rotation, no SSO, manual RBAC.</p>
        <p>Supabase Auth handles all of this out of the box.</p>
      </section>
      <aside role="doc-warning">Do not store tokens in localStorage — use httpOnly cookies.</aside>
      <aside role="doc-tip">Enable RLS policies before going to production.</aside>
      <nav class="topic-tree">
        <a href="#auth-sessions">sessions</a>
        <a href="#auth-rbac">RBAC</a>
      </nav>
      <table data-cerveau-schema="comparison">
        <tr><th>Option</th><th>Chosen</th></tr>
        <tr><td>JWT custom</td><td>No</td></tr>
        <tr><td>Supabase Auth</td><td>Yes</td></tr>
      </table>
    </article>
  `;

  it('strips section by data-section attribute', () => {
    const tldr = stripSection(html, 'section[data-section="tldr"]');
    expect(tldr).toContain('We use OAuth2 PKCE');
    expect(tldr).toContain('Supabase Auth');
    expect(tldr).not.toContain('token rotation');
  });

  it('strips warning aside by role attribute', () => {
    const warning = stripSection(html, 'aside[role="doc-warning"]');
    expect(warning).toContain('Do not store tokens');
    expect(warning).toContain('httpOnly cookies');
    expect(warning).not.toContain('RLS policies');
  });

  it('strips reasoning section', () => {
    const reasoning = stripSection(html, 'section[data-section="reasoning"]');
    expect(reasoning).toContain('Custom JWT');
    expect(reasoning).toContain('maintenance burden');
    expect(reasoning).toContain('Supabase Auth handles all');
    expect(reasoning).not.toContain('OAuth2 PKCE via Supabase');
  });

  it('strips multiple matching elements (nav links)', () => {
    const links = stripSection(html, 'nav.topic-tree a');
    expect(links).toContain('sessions');
    expect(links).toContain('RBAC');
  });

  it('falls back to tldr section for nonexistent selector', () => {
    // Wave-3: stripSection now falls back to tldr/summary/lead when selector
    // matches nothing in a non-empty note, so a real hit is never silently dropped.
    const result = stripSection(html, 'section[data-section="nonexistent"]');
    expect(result).toContain('OAuth2 PKCE via Supabase Auth');
  });

  it('falls back to tldr section for invalid selector', () => {
    // Wave-3: same fallback applies when the CSS selector is syntactically invalid.
    const result = stripSection(html, 'section[data-section=');
    expect(result).toContain('OAuth2 PKCE via Supabase Auth');
  });

  it('returns empty string for empty html', () => {
    const result = stripSection('', 'p');
    expect(result).toBe('');
  });

  it('returns empty string for empty selector', () => {
    const result = stripSection(html, '');
    expect(result).toBe('');
  });
});

describe('stripSections — batch section stripping', () => {
  const html = `
    <article data-cerveau-type="decision" data-cerveau-tags="auth database">
      <section data-section="tldr">
        <p>We use OAuth2 PKCE via Supabase Auth instead of custom JWT.</p>
      </section>
      <section data-section="reasoning">
        <p>Custom JWT means maintenance burden: token rotation, no SSO, manual RBAC.</p>
        <p>Supabase Auth handles all of this out of the box.</p>
      </section>
      <aside role="doc-warning">Do not store tokens in localStorage — use httpOnly cookies.</aside>
      <aside role="doc-tip">Enable RLS policies before going to production.</aside>
      <nav class="topic-tree">
        <a href="#auth-sessions">sessions</a>
        <a href="#auth-rbac">RBAC</a>
      </nav>
      <table data-cerveau-schema="comparison">
        <tr><th>Option</th><th>Chosen</th></tr>
        <tr><td>JWT custom</td><td>No</td></tr>
        <tr><td>Supabase Auth</td><td>Yes</td></tr>
      </table>
    </article>
  `;

  it('returns map of selectors to stripped text', () => {
    const result = stripSections(html, [
      'section[data-section="tldr"]',
      'aside[role="doc-warning"]',
    ]);
    expect(result['section[data-section="tldr"]']).toContain('We use OAuth2 PKCE');
    expect(result['aside[role="doc-warning"]']).toContain('Do not store tokens');
  });

  it('includes nonexistent selectors as empty strings', () => {
    const result = stripSections(html, [
      'section[data-section="tldr"]',
      'section[data-section="nonexistent"]',
    ]);
    expect(result['section[data-section="tldr"]']).toContain('We use OAuth2 PKCE');
    expect(result['section[data-section="nonexistent"]']).toBe('');
  });

  it('handles invalid selectors gracefully', () => {
    const result = stripSections(html, ['section[data-section="tldr"]', 'section[data-section=']);
    expect(result['section[data-section="tldr"]']).toContain('We use OAuth2 PKCE');
    expect(result['section[data-section=']).toBe('');
  });

  it('returns empty object for empty selectors array', () => {
    const result = stripSections(html, []);
    expect(result).toEqual({});
  });

  it('returns empty object for empty html', () => {
    const result = stripSections('', ['section']);
    expect(result).toEqual({});
  });

  it('strips multiple sections efficiently in single parse', () => {
    const result = stripSections(html, [
      'section[data-section="tldr"]',
      'section[data-section="reasoning"]',
      'aside[role="doc-warning"]',
      'nav.topic-tree a',
    ]);
    expect(Object.keys(result)).toHaveLength(4);
    expect(result['section[data-section="tldr"]']).toContain('OAuth2 PKCE');
    expect(result['section[data-section="reasoning"]']).toContain('Custom JWT');
    expect(result['aside[role="doc-warning"]']).toContain('Do not store tokens');
    expect(result['nav.topic-tree a']).toContain('sessions');
    expect(result['nav.topic-tree a']).toContain('RBAC');
  });
});

// ---------------------------------------------------------------------------
// Defect 1: stripNoteToPrompt must prefer authored knowledge over a blind
// document-order head-slice for file-neurons (which never carry
// [data-cerveau-fact] elements — facts are a capture-note-only construct).
// ---------------------------------------------------------------------------

describe('stripNoteToPrompt — file-neuron enrichment survives the 240-char budget', () => {
  // A file with enough imports/exports/functions that architecture+children
  // alone exceed 240 characters, exactly the real-world shape that starved
  // the old head-slice fallback (see file-neuron.ts's part order: breadcrumb
  // -> infobox -> tldr -> architecture -> children -> decisions/bugs/rules).
  const BUSY_NODE: CodeNode = {
    id: 'file:src/graph/ast-parser.ts',
    title: 'src/graph/ast-parser.ts',
    type: 'file',
    filePath: 'src/graph/ast-parser.ts',
    projectRoot: '/lazy-engine',
    language: 'typescript',
    lineCount: 420,
    imports: [
      './code-scanner',
      './backlinks',
      '../util/config',
      '../util/logger',
      '../commands/enrich',
      'web-tree-sitter',
    ],
    exports: ['parseAst', 'AstParser', 'AstNode', 'resetParserCache', 'disposeParser'],
    astFunctions: [
      {
        name: 'parseAst',
        startLine: 10,
        endLine: 60,
        params: ['source', 'language'],
        isExported: true,
      },
      { name: 'resetParserCache', startLine: 62, endLine: 70, params: [], isExported: true },
      { name: 'disposeParser', startLine: 72, endLine: 80, params: ['handle'], isExported: true },
    ],
    astClasses: [{ name: 'AstParser', methods: ['parse', 'dispose', 'reset'], isExported: true }],
  };

  function buildBusyNeuronWithDecision(decisionText: string): string {
    return composeFileNeuron(BUSY_NODE, 3, {
      decisions: [
        {
          text: decisionText,
          confidence: 0.9,
          date: '2026-08-01',
          sourceConvLink: '#conv-fixture-1',
        },
      ],
    });
  }

  it('the chrome alone (breadcrumb+infobox+tldr+architecture+children) already exceeds the 240-char budget for this fixture', () => {
    // Sanity check on the fixture itself: this is what proves the bug was
    // real, not an artifact of a too-small test file.
    const html = buildBusyNeuronWithDecision('We call tree.delete() to free the stale handle.');
    const note = stripNote(html);
    expect(note.facts).toHaveLength(0); // file-neurons never carry [data-cerveau-fact]
    // The blind head-slice a naive .text.slice(0, 240) would have produced
    // never reaches the decisions section — verify that premise directly.
    const blindHeadSlice = note.text.split('\n').join(' ').slice(0, 240);
    expect(blindHeadSlice).not.toContain('tree.delete');
  });

  it('BEFORE-fix behaviour reproduced directly: a blind head-slice of note.text drops the decision entirely', () => {
    const decisionText =
      'We decided to call tree.delete() inside a finally block so the AST parse memory leak cannot recur even on error.';
    const html = buildBusyNeuronWithDecision(decisionText);
    const note = stripNote(html);
    const blindHeadSlice = note.text.split('\n').join(' ').slice(0, 240);
    // This is verbatim what the OLD stripNoteToPrompt fallback emitted.
    expect(blindHeadSlice).not.toContain('tree.delete');
    expect(blindHeadSlice).not.toContain('finally');
  });

  it('AFTER-fix: stripNoteToPrompt surfaces the decision text, not just breadcrumb/infobox/architecture chrome', () => {
    const decisionText =
      'We decided to call tree.delete() inside a finally block so the AST parse memory leak cannot recur even on error.';
    const html = buildBusyNeuronWithDecision(decisionText);
    const note = stripNote(html);
    const prompt = stripNoteToPrompt(note);
    expect(prompt).toContain('tree.delete()');
  });

  it('stays compact: the enrichment-preferring fallback is still capped near the 240-char budget, not a full dump', () => {
    const longDecision = 'We decided to do X because Y. '.repeat(30); // ~930 chars
    const html = buildBusyNeuronWithDecision(longDecision);
    const note = stripNote(html);
    expect(note.leadText).toBeDefined();
    expect(note.leadText!.length).toBeLessThanOrEqual(240);
  });

  it('falls back to tldr (not raw chrome) when there is no enrichment at all', () => {
    const html = composeFileNeuron(BUSY_NODE, 3); // no enrichment argument
    const note = stripNote(html);
    expect(note.facts).toHaveLength(0);
    // tldr mentions function/class counts for this fixture.
    expect(note.leadText).toMatch(/function|class/);
  });

  it('does not regress notes that DO have [data-cerveau-fact] elements — facts still win', () => {
    const html = `
      <article id="note-1" data-cerveau-type="semantic" data-cerveau-created="2026-01-01T00:00:00Z">
        <details open><p data-cerveau-fact data-cerveau-confidence="0.9">The real fact.</p></details>
      </article>`;
    const note = stripNote(html);
    expect(note.facts).toHaveLength(1);
    const prompt = stripNoteToPrompt(note);
    expect(prompt).toContain('The real fact.');
  });

  it('prioritises decisions over a later bugs section when both are present', () => {
    const html = composeFileNeuron(BUSY_NODE, 3, {
      decisions: [
        {
          text: 'DECISION_MARKER: use a WeakMap for the parser cache.',
          confidence: 0.9,
          date: '2026-08-01',
          sourceConvLink: '#conv-1',
        },
      ],
      bugs: [
        {
          text: 'BUG_MARKER: leaked handles under concurrent scans.',
          confidence: 0.8,
          date: '2026-08-02',
          sourceConvLink: '#conv-2',
        },
      ],
    });
    const note = stripNote(html);
    // Both are short enough to fit the 240-char budget together, but the
    // decisions section must appear first in leadText (priority order).
    expect(note.leadText).toBeDefined();
    const decisionIdx = note.leadText!.indexOf('DECISION_MARKER');
    const bugIdx = note.leadText!.indexOf('BUG_MARKER');
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    expect(bugIdx).toBeGreaterThan(decisionIdx);
  });
});
