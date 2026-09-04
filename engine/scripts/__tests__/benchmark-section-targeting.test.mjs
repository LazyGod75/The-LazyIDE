/**
 * Tests for extractCompactNoteText section-targeting logic in run-benchmark.mjs.
 *
 * These tests validate the fairness fix: keyword queries only include non-tldr
 * sections (body, children) when those sections contain a query keyword.
 * Structural queries (no keywords) include all sections unconditionally.
 */

import { describe, it, assert } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Minimal reimplementation of extractPlainText and extractCompactNoteText
 * to test the section-targeting logic in isolation (functions are not exported).
 */
function extractPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractCompactNoteText(filename, content, keywords) {
  const typeMatch = content.match(/data-cerveau-type="([^"]*)"/);
  const nodeType = typeMatch ? typeMatch[1] : '';
  const created = (content.match(/data-cerveau-created="([^"]*)"/) || ['', ''])[1];
  const date = created ? created.slice(0, 10) : '';
  const tags = (content.match(/data-cerveau-tags="([^"]*)"/) || ['', ''])[1];
  const tagList = tags
    ? tags.split(/[\s,]+/).filter(Boolean).slice(0, 4).join(', ')
    : '';
  const idShort = filename.replace(/\.html$/, '').slice(0, 40);

  const tldrMatch = content.match(/<section[^>]*data-section="tldr"[^>]*>([\s\S]*?)<\/section>/);
  const tldr = tldrMatch ? extractPlainText(tldrMatch[1]) : '';

  function sectionMatchesQuery(sectionText) {
    if (!keywords || keywords.length === 0) return true;
    const lower = sectionText.toLowerCase();
    return keywords.some((kw) => lower.includes(kw.toLowerCase()));
  }

  let body = '';
  if (nodeType === 'concept' || nodeType === 'concept-neuron') {
    const bodyMatch = content.match(/<section[^>]*data-section="body"[^>]*>([\s\S]*?)<\/section>/);
    if (bodyMatch) {
      const bodyText = extractPlainText(bodyMatch[1]);
      if (sectionMatchesQuery(bodyText)) {
        body = bodyText;
      }
    }
  }

  let children = '';
  if (nodeType === 'aggregate-neuron') {
    const childrenMatch = content.match(
      /<section[^>]*data-section="children"[^>]*>([\s\S]*?)<\/section>/,
    );
    if (childrenMatch) {
      const childrenText = extractPlainText(childrenMatch[1]).slice(0, 300);
      if (sectionMatchesQuery(childrenText)) {
        children = childrenText;
      }
    }
  }

  const header = `· ${nodeType} ${date} #${idShort}${tagList ? ` (${tagList})` : ''}`;
  const parts = [header];
  if (tldr) parts.push(`  ${tldr}`);
  if (body && body !== tldr) parts.push(`  ${body.slice(0, 400)}`);
  if (children) parts.push(`  ${children}`);

  return parts.join('\n');
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONCEPT_HTML = `
<article data-cerveau-type="concept" data-cerveau-created="2026-05-01T10:00:00Z"
         data-cerveau-tags="auth bug">
  <section data-section="tldr"><p>Auth bug: session tokens expire prematurely.</p></section>
  <section data-section="body"><p>Root cause: missing refresh logic in auth middleware. Auth token not refreshed.</p></section>
</article>`;

const AGGREGATE_HTML = `
<article data-cerveau-type="aggregate-neuron" data-cerveau-created="2026-05-02T10:00:00Z"
         data-cerveau-tags="acme architecture">
  <section data-section="tldr"><p>Acme app components overview.</p></section>
  <section data-section="children"><p>Contents: components [module] screens [module] stripe [module]</p></section>
</article>`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('extractCompactNoteText — tldr always included', () => {
  it('always includes tldr regardless of keywords', () => {
    const out = extractCompactNoteText('concept-auth-bug.html', CONCEPT_HTML, ['stripe']);
    assert.ok(out.includes('Auth bug: session tokens expire prematurely'));
  });

  it('includes tldr when no keywords provided', () => {
    const out = extractCompactNoteText('concept-auth-bug.html', CONCEPT_HTML, undefined);
    assert.ok(out.includes('Auth bug: session tokens expire prematurely'));
  });
});

describe('extractCompactNoteText — keyword-targeted section inclusion (concept body)', () => {
  it('includes body when it matches query keywords', () => {
    const out = extractCompactNoteText('concept-auth-bug.html', CONCEPT_HTML, ['auth', 'token']);
    assert.ok(out.includes('Root cause'));
  });

  it('excludes body when it does not match query keywords', () => {
    // "stripe" and "payment" are not in the body text
    const out = extractCompactNoteText('concept-auth-bug.html', CONCEPT_HTML, ['stripe', 'payment']);
    assert.ok(!out.includes('Root cause'));
  });

  it('includes body unconditionally when no keywords provided (structural query)', () => {
    const out = extractCompactNoteText('concept-auth-bug.html', CONCEPT_HTML, undefined);
    assert.ok(out.includes('Root cause'));
  });

  it('includes body when keyword list is empty (structural query)', () => {
    const out = extractCompactNoteText('concept-auth-bug.html', CONCEPT_HTML, []);
    assert.ok(out.includes('Root cause'));
  });

  it('keyword matching is case-insensitive', () => {
    const out = extractCompactNoteText('concept-auth-bug.html', CONCEPT_HTML, ['AUTH']);
    assert.ok(out.includes('Root cause'));
  });
});

describe('extractCompactNoteText — keyword-targeted section inclusion (aggregate children)', () => {
  it('includes children when it matches query keywords', () => {
    const out = extractCompactNoteText('aggregate-acme.html', AGGREGATE_HTML, ['stripe', 'acme']);
    assert.ok(out.includes('stripe'));
  });

  it('excludes children when it does not match query keywords', () => {
    // "adminpanel" is not in the children text (which contains: components, screens, stripe)
    const out = extractCompactNoteText('aggregate-acme.html', AGGREGATE_HTML, ['adminpanel']);
    // "stripe" appears only in the children section, not in the tldr
    assert.ok(!out.includes('stripe [module]'));
    // "screens" appears only in the children section, not in the tldr
    assert.ok(!out.includes('screens'));
  });

  it('includes children unconditionally when no keywords provided (structural query)', () => {
    const out = extractCompactNoteText('aggregate-acme.html', AGGREGATE_HTML, undefined);
    assert.ok(out.includes('stripe'));
    assert.ok(out.includes('components'));
  });
});

describe('extractCompactNoteText — token reduction from section targeting', () => {
  it('produces fewer tokens when unrelated keywords exclude body section', () => {
    const withRelevantKws = extractCompactNoteText(
      'concept-auth-bug.html',
      CONCEPT_HTML,
      ['auth', 'token'],
    );
    const withIrrelevantKws = extractCompactNoteText(
      'concept-auth-bug.html',
      CONCEPT_HTML,
      ['stripe', 'payment'],
    );
    assert.ok(
      withIrrelevantKws.length < withRelevantKws.length,
      `Expected irrelevant-keywords output (${withIrrelevantKws.length}) to be shorter than relevant-keywords (${withRelevantKws.length})`,
    );
  });

  it('includes header in all cases (no empty output for matched neurons)', () => {
    const out = extractCompactNoteText(
      'concept-auth-bug.html',
      CONCEPT_HTML,
      ['stripe'], // no match in body, but tldr always included
    );
    assert.ok(out.includes('· concept'));
  });
});
