import { describe, expect, it } from 'vitest';
import { renderAntipatterns } from '../antipatterns.js';
import { renderCategories } from '../categories.js';
import { renderCounterfactuals } from '../counterfactuals.js';
import { renderErrors } from '../errors.js';
import { renderFactsSection } from '../facts-section.js';
import { renderGlossary } from '../glossary.js';
import { renderInfobox } from '../infobox.js';
import { renderJsonLd } from '../json-ld.js';
import { renderMetaHead } from '../meta-head.js';
import { renderOutcome } from '../outcome.js';
import { extractQaPatterns, renderQaSection } from '../qa-section.js';
import { renderReferences } from '../references.js';
import { renderToolTrace } from '../tool-trace.js';

describe('infobox', () => {
  it('renders dl with rows', () => {
    const html = renderInfobox({ rows: [{ label: 'Type', value: 'decision' }] });
    expect(html).toContain('<aside class="infobox">');
    expect(html).toContain('<dt>Type</dt>');
    expect(html).toContain('<dd>decision</dd>');
    expect(html).toContain('</aside>');
  });
  it('returns empty string for no rows', () => {
    expect(renderInfobox({ rows: [] })).toBe('');
  });
  it('escapes special chars in label and value', () => {
    const html = renderInfobox({ rows: [{ label: '<b>', value: '"val"' }] });
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&quot;val&quot;');
  });
});

describe('glossary', () => {
  it('renders glossary aside with entities', () => {
    const html = renderGlossary({
      entities: ['Tradebot: a tradelab bot', 'SENTINEL: backtest system'],
    });
    expect(html).toContain('<aside class="glossary">');
    expect(html).toContain('<dfn');
    expect(html).toContain('Tradebot');
  });
  it('returns empty for fewer than 2 entities', () => {
    expect(renderGlossary({ entities: ['single'] })).toBe('');
  });
  it('returns empty for empty entities', () => {
    expect(renderGlossary({ entities: [] })).toBe('');
  });
  it('caps at 8 entities', () => {
    const entities = Array.from({ length: 12 }, (_, i) => `type:entity-${i}`);
    const html = renderGlossary({ entities });
    const matches = html.match(/<dfn/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(8);
  });
  it('splits entity key on first colon', () => {
    const html = renderGlossary({ entities: ['bot:Tradebot', 'system:SENTINEL'] });
    expect(html).toContain('id="Tradebot"');
    expect(html).toContain('<dd>bot</dd>');
  });
});

describe('qa-section', () => {
  it('renders qa section with pairs', () => {
    const html = renderQaSection({
      pairs: [{ question: 'Why use TypeScript?', answer: 'Type safety reduces bugs.' }],
    });
    expect(html).toContain('<section data-section="qa">');
    expect(html).toContain('Why use TypeScript?');
    expect(html).toContain('Type safety reduces bugs.');
  });
  it('returns empty for no pairs', () => {
    expect(renderQaSection({ pairs: [] })).toBe('');
  });
  it('caps at 5 pairs', () => {
    const pairs = Array.from({ length: 8 }, (_, i) => ({
      question: `Q${i}?`,
      answer: `A${i}`,
    }));
    const html = renderQaSection({ pairs });
    const matches = html.match(/<details/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(5);
  });
  it('extractQaPatterns detects why/how/what/when', () => {
    const facts = [
      { text: 'Use immutability why it matters', confidence: 0.9, kind: 'decision' },
      { text: 'how to setup the project', confidence: 0.8, kind: 'decision' },
      { text: 'what the pipeline does', confidence: 0.7, kind: 'decision' },
    ];
    const pairs = extractQaPatterns(facts);
    expect(pairs.length).toBeGreaterThan(0);
  });
  it('extractQaPatterns handles French patterns', () => {
    const facts = [
      { text: 'pourquoi utiliser HTML first', confidence: 0.9, kind: 'decision' },
      { text: 'comment configurer le projet', confidence: 0.8, kind: 'decision' },
    ];
    const pairs = extractQaPatterns(facts);
    expect(pairs.length).toBe(2);
    expect(pairs[0][0]).toContain('Pourquoi');
  });
});

describe('tool-trace', () => {
  it('renders tool trace section with matching facts', () => {
    const html = renderToolTrace({
      facts: [
        { text: 'pytest run: Output: PASSED 10 tests', confidence: 0.9, kind: 'observation' },
      ],
      tool: 'pytest',
    });
    expect(html).toContain('<section data-section="tool_trace">');
    expect(html).toContain('pytest');
  });
  it('returns empty when no matching facts and no tool', () => {
    const html = renderToolTrace({
      facts: [{ text: 'simple fact with no tool match', confidence: 0.8, kind: 'decision' }],
    });
    expect(html).toBe('');
  });
  it('renders fallback message when tool set but no traces', () => {
    const html = renderToolTrace({
      facts: [],
      tool: 'docker',
    });
    expect(html).toContain('docker');
    expect(html).toContain('run recorded');
  });
});

describe('errors', () => {
  it('renders error section for error-kind facts', () => {
    const html = renderErrors({
      facts: [{ text: 'TypeError: Cannot read property of null', confidence: 0.9, kind: 'error' }],
    });
    expect(html).toContain('<section data-section="errors">');
    expect(html).toContain('data-error=');
    expect(html).toContain('Error:');
  });
  it('detects errors by keyword in text', () => {
    const html = renderErrors({
      facts: [{ text: 'Build failed with exit code 1', confidence: 0.8, kind: 'observation' }],
    });
    expect(html).toContain('<section data-section="errors">');
  });
  it('returns empty when no errors', () => {
    const html = renderErrors({
      facts: [{ text: 'Everything worked fine', confidence: 0.9, kind: 'decision' }],
    });
    expect(html).toBe('');
  });
  it('caps at 5 errors', () => {
    const facts = Array.from({ length: 8 }, (_, i) => ({
      text: `Error ${i}: failed`,
      confidence: 0.9,
      kind: 'error',
    }));
    const html = renderErrors({ facts });
    const matches = html.match(/<details/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(5);
  });
});

describe('outcome', () => {
  it('renders outcome section with replaces list', () => {
    const html = renderOutcome({ replaces: ['note-abc-123', 'note-def-456'] });
    expect(html).toContain('role="doc-note"');
    expect(html).toContain('data-section="outcome"');
    expect(html).toContain('supersedes');
    expect(html).toContain('note-abc-123');
  });
  it('returns empty for empty replaces', () => {
    expect(renderOutcome({ replaces: [] })).toBe('');
  });
  it('returns empty for undefined replaces', () => {
    expect(renderOutcome({})).toBe('');
  });
});

describe('counterfactuals', () => {
  it('renders counterfactual section for matching facts', () => {
    const html = renderCounterfactuals({
      facts: [
        { text: 'We tried using Redis but it did not scale', confidence: 0.8, kind: 'decision' },
      ],
    });
    expect(html).toContain('role="doc-note"');
    expect(html).toContain('data-section="counterfactuals"');
    expect(html).toContain('Considered but rejected');
  });
  it('detects "alternative" keyword', () => {
    const html = renderCounterfactuals({
      facts: [{ text: 'alternative approach was considered', confidence: 0.8, kind: 'decision' }],
    });
    expect(html).toContain('data-section="counterfactuals"');
  });
  it('returns empty when no counterfactuals', () => {
    const html = renderCounterfactuals({
      facts: [{ text: 'This was the final and only approach', confidence: 0.9, kind: 'decision' }],
    });
    expect(html).toBe('');
  });
  it('caps at 3 items', () => {
    const facts = Array.from({ length: 6 }, (_, i) => ({
      text: `We tried approach ${i} but it didn't work`,
      confidence: 0.8,
      kind: 'decision',
    }));
    const html = renderCounterfactuals({ facts });
    const matches = html.match(/<p role=/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(3);
  });
});

describe('antipatterns', () => {
  it('renders antipattern section for matching facts', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: "Don't use synchronous file reads in hot paths",
          confidence: 0.9,
          kind: 'decision',
        },
      ],
    });
    expect(html).toContain('role="doc-warning"');
    expect(html).toContain('data-section="antipatterns"');
    expect(html).toContain('Anti-patterns');
  });
  it('detects error-kind facts with a failure verb (quality gate: must have causal token)', () => {
    // "Crash occurred" is only 14 chars with no failure verb — quality gate rejects it.
    // Use a fact that passes: >= 20 chars, >= 4 words, contains a failure verb.
    const html = renderAntipatterns({
      facts: [
        {
          text: 'Build failed because esbuild banner conflicted with shebang',
          confidence: 0.8,
          kind: 'error',
        },
      ],
    });
    expect(html).toContain('data-section="antipatterns"');
  });
  it('returns empty when no antipatterns', () => {
    const html = renderAntipatterns({
      facts: [{ text: 'This is a normal fact', confidence: 0.9, kind: 'decision' }],
    });
    expect(html).toBe('');
  });
});

describe('references', () => {
  it('renders references section with files', () => {
    const html = renderReferences({
      filesModified: ['/src/annotator/template.ts'],
      filesRead: ['/src/annotator/types.ts'],
    });
    expect(html).toContain('<section data-section="references">');
    expect(html).toContain('<data value=');
    expect(html).toContain('template.ts');
    expect(html).toContain('types.ts');
  });
  it('returns empty for no files', () => {
    expect(renderReferences({})).toBe('');
    expect(renderReferences({ filesModified: [], filesRead: [] })).toBe('');
  });
  it('uses basename as display text', () => {
    const html = renderReferences({ filesModified: ['/long/path/to/file.ts'] });
    expect(html).toContain('>file.ts<');
  });
});

describe('categories', () => {
  it('renders footer with category links', () => {
    const html = renderCategories({ tags: ['tradelab', 'ml', 'live'] });
    expect(html).toContain('<footer>');
    expect(html).toContain('class="categories"');
    expect(html).toContain('tradelab');
  });
  it('returns empty for no tags', () => {
    expect(renderCategories({ tags: [] })).toBe('');
  });
  it('deduplicates tags', () => {
    const html = renderCategories({ tags: ['tradelab', 'tradelab', 'ml'] });
    const links = html.match(/href="#\/search\//g) ?? [];
    expect(links.length).toBe(2);
  });
  it('escapes special chars in tags', () => {
    const html = renderCategories({ tags: ['<script>', '"tag"'] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('json-ld', () => {
  it('renders valid JSON-LD script', () => {
    const html = renderJsonLd({
      title: 'Test Note',
      type: 'decision',
      dateCreated: '2026-01-01',
      tags: ['tradelab'],
    });
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type"');
    const jsonMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    expect(jsonMatch).toBeTruthy();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed['@type']).toBe('TechArticle');
  });
  it('includes dateCreated and keywords', () => {
    const html = renderJsonLd({
      title: 'Test',
      type: 'decision',
      dateCreated: '2026-05-25',
      tags: ['tag1', 'tag2'],
    });
    const jsonMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.dateCreated).toBe('2026-05-25');
    expect(parsed.keywords).toBe('tag1,tag2');
  });
  it('includes optional description when provided', () => {
    const html = renderJsonLd({
      title: 'Test',
      type: 'decision',
      dateCreated: '2026-01-01',
      tags: [],
      description: 'A test description',
    });
    const jsonMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed.description).toBe('A test description');
  });
});

describe('meta-head', () => {
  it('renders meta tags', () => {
    const html = renderMetaHead({
      answers: 'Q: What? A: This.',
      aliases: 'alias1, alias2',
      commitRef: 'abc123',
      backlinkCount: 5,
    });
    expect(html).toContain('<meta name="answers"');
    expect(html).toContain('<meta name="aliases"');
    expect(html).toContain('<meta name="commit-ref"');
    expect(html).toContain('<meta name="backlinks"');
  });
  it('omits absent fields', () => {
    const html = renderMetaHead({ answers: '', aliases: '' });
    expect(html).toBe('');
  });
  it('omits backlinks when 0', () => {
    const html = renderMetaHead({ answers: 'something', aliases: '', backlinkCount: 0 });
    expect(html).not.toContain('backlinks');
  });
  it('escapes content', () => {
    const html = renderMetaHead({ answers: '"quoted"', aliases: '' });
    expect(html).toContain('&quot;quoted&quot;');
  });
});

describe('facts-section', () => {
  it('renders tldr, summary, and facts sections', () => {
    const html = renderFactsSection({
      facts: [
        { text: 'First fact is the primary one', confidence: 0.95, kind: 'decision' },
        { text: 'Second fact for context', confidence: 0.8, kind: 'observation' },
      ],
      tldr: 'Brief summary here',
    });
    expect(html).toContain('data-section="tldr"');
    expect(html).toContain('data-section="summary"');
    expect(html).toContain('data-section="facts"');
    expect(html).toContain('Brief summary here');
    expect(html).toContain('First fact is the primary one');
    expect(html).toContain('Second fact for context');
  });
  it('renders only tldr when single fact', () => {
    const html = renderFactsSection({
      facts: [{ text: 'Only fact', confidence: 0.9, kind: 'decision' }],
    });
    expect(html).toContain('data-section="tldr"');
    expect(html).toContain('data-section="summary"');
    expect(html).not.toContain('data-section="facts"');
  });
  it('returns empty string for no facts', () => {
    expect(renderFactsSection({ facts: [] })).toBe('');
  });
  it('uses provided tldr over first fact text', () => {
    const html = renderFactsSection({
      facts: [{ text: 'First fact text', confidence: 0.9, kind: 'decision' }],
      tldr: 'Custom TLDR',
    });
    expect(html).toContain('Custom TLDR');
  });
  it('includes confidence and kind data attributes', () => {
    const html = renderFactsSection({
      facts: [
        { text: 'Fact with metadata', confidence: 0.75, kind: 'observation', extractor: 'llm' },
      ],
    });
    expect(html).toContain('data-cerveau-confidence="0.75"');
    expect(html).toContain('data-cerveau-kind="observation"');
    expect(html).toContain('data-cerveau-extracted-by="llm"');
  });
});
