import { describe, expect, it } from 'vitest';
import { buildEmbedText } from '../embed-index.js';

describe('buildEmbedText', () => {
  it('puts distilled fields ahead of body so truncation cannot drop them', () => {
    const text = buildEmbedText({
      title: 'Auth strategy',
      tldr: 'PKCE flow for mobile',
      questions: 'why pkce|how refresh rotates',
      aliases: 'pkce,oauth mobile',
      concepts: 'db:postgres-prod,lib:react',
      tags: 'auth security',
      text: 'X'.repeat(5000),
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Auth strategy');
    expect(lines[1]).toBe('PKCE flow for mobile');
    expect(lines[2]).toBe('why pkce; how refresh rotates');
    expect(lines[3]).toBe('pkce,oauth mobile');
    expect(lines[4]).toBe('db:postgres-prod lib:react');
    expect(lines[5]).toBe('auth security');
    // Body still present, bounded under the budget after the head.
    expect(text.length).toBeLessThanOrEqual(1800 + 512);
  });

  it('falls back to section_tldr when tldr column is empty', () => {
    const text = buildEmbedText({ title: 'T', section_tldr: 'section one-liner' });
    expect(text).toContain('section one-liner');
  });

  it('keeps a minimum body floor even when the distilled head is long', () => {
    const text = buildEmbedText({
      title: 'T'.repeat(1500),
      tldr: 'L'.repeat(600),
      text: 'BODY-CONTENT',
    });
    expect(text).toContain('BODY-CONTENT');
  });

  it('changes output when distilled fields change (hash invalidates cache)', () => {
    const base = { title: 'T', text: 'same body' };
    const a = buildEmbedText(base);
    const b = buildEmbedText({ ...base, questions: 'why is the sky blue' });
    expect(a).not.toBe(b);
  });
});
