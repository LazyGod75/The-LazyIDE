/**
 * Tests for strip.ts — focusing on the stripSection fallback behaviour
 * introduced to prevent empty output for real search hits.
 */

import { describe, expect, it } from 'vitest';
import { stripNote, stripSection, stripSections } from '../strip.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal article HTML with configurable sections
// ---------------------------------------------------------------------------

function makeArticle(opts: {
  tldr?: string;
  summary?: string;
  body?: string;
  extraSection?: string;
}): string {
  const parts: string[] = [];
  if (opts.tldr) {
    parts.push(`<section data-section="tldr"><p>${opts.tldr}</p></section>`);
  }
  if (opts.summary) {
    parts.push(
      `<section data-section="summary"><details open><p>${opts.summary}</p></details></section>`,
    );
  }
  if (opts.body) {
    parts.push(`<section data-section="body"><p>${opts.body}</p></section>`);
  }
  if (opts.extraSection) {
    parts.push(opts.extraSection);
  }
  return `<article id="test-note" data-cerveau-version="0.2.0" data-cerveau-type="reference">\n${parts.join('\n')}\n</article>`;
}

// ---------------------------------------------------------------------------
// Existing behaviour: selector that matches should still return correct text
// ---------------------------------------------------------------------------

describe('stripSection — selector matches', () => {
  it('returns matched section text when selector hits', () => {
    const html = makeArticle({ tldr: 'Stripe is the payment provider.', body: 'Details here.' });
    const result = stripSection(html, 'section[data-section="tldr"]');
    expect(result).toContain('Stripe is the payment provider');
    expect(result).not.toContain('Details here');
  });

  it('returns multiple matches concatenated', () => {
    const html = `<article>
      <section data-section="facts"><p>Fact A.</p></section>
      <section data-section="facts"><p>Fact B.</p></section>
    </article>`;
    const result = stripSection(html, 'section[data-section="facts"]');
    expect(result).toContain('Fact A');
    expect(result).toContain('Fact B');
  });
});

// ---------------------------------------------------------------------------
// Task 1: fallback when selector matches nothing — never return empty for a real hit
// ---------------------------------------------------------------------------

describe('stripSection — fallback when selector matches nothing', () => {
  it('falls back to tldr when requested section is absent', () => {
    const html = makeArticle({
      tldr: 'Stripe integration uses idempotency keys.',
    });
    // Request a section that does not exist in this note
    const result = stripSection(html, 'section[data-section="reasoning"]');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Stripe integration');
  });

  it('falls back to summary when tldr is absent and requested section is absent', () => {
    const html = makeArticle({
      summary: 'This note discusses the payment flow in detail.',
    });
    const result = stripSection(html, 'aside[role="doc-warning"]');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('payment flow');
  });

  it('falls back to lead text when both tldr and summary are absent', () => {
    const html = makeArticle({
      body: 'The webhook handler validates signatures before processing.',
    });
    const result = stripSection(html, 'section[data-section="nonexistent"]');
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('webhook handler');
  });

  it('returns empty string for truly empty HTML', () => {
    const result = stripSection('', 'section[data-section="tldr"]');
    expect(result).toBe('');
  });

  it('returns empty string for blank note with no text content', () => {
    const html = '<article id="empty"></article>';
    const result = stripSection(html, 'section[data-section="reasoning"]');
    expect(result).toBe('');
  });

  it('prefers tldr fallback over summary when both are present', () => {
    const html = makeArticle({
      tldr: 'Short TLDR sentence.',
      summary: 'Longer summary paragraph with more detail.',
    });
    const result = stripSection(html, 'section[data-section="nonexistent"]');
    expect(result).toContain('Short TLDR sentence');
  });

  it('returns original match (not fallback) when selector does match', () => {
    const html = makeArticle({
      tldr: 'TLDR content.',
      body: 'Body content that we actually want.',
    });
    const result = stripSection(html, 'section[data-section="body"]');
    expect(result).toContain('Body content that we actually want');
    expect(result).not.toContain('TLDR content');
  });

  it('handles invalid selector gracefully and falls back', () => {
    const html = makeArticle({ tldr: 'Valid TLDR content here.' });
    // '[[invalid]]' is not valid CSS — should fall back instead of throwing
    const result = stripSection(html, '[[invalid-selector');
    expect(result).toContain('Valid TLDR content here');
  });
});

// ---------------------------------------------------------------------------
// stripSections still works correctly (batch variant)
// ---------------------------------------------------------------------------

describe('stripSections — batch variant unchanged', () => {
  it('returns map of selector to text', () => {
    const html = makeArticle({
      tldr: 'Quick summary.',
      body: 'Longer body text.',
    });
    const result = stripSections(html, [
      'section[data-section="tldr"]',
      'section[data-section="body"]',
    ]);
    expect(result['section[data-section="tldr"]']).toContain('Quick summary');
    expect(result['section[data-section="body"]']).toContain('Longer body text');
  });
});

// ---------------------------------------------------------------------------
// stripNote structural smoke test
// ---------------------------------------------------------------------------

describe('stripNote', () => {
  it('extracts id, type and facts from a structured article', () => {
    const html = `<article id="note-abc" data-cerveau-version="0.2.0" data-cerveau-type="decision" data-cerveau-tags="auth security">
      <p data-cerveau-fact data-cerveau-confidence="0.9">Use JWT tokens for auth.</p>
    </article>`;
    const note = stripNote(html);
    expect(note.id).toBe('note-abc');
    expect(note.type).toBe('decision');
    expect(note.tags).toContain('auth');
    expect(note.facts[0].confidence).toBe(0.9);
  });
});
