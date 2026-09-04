import { describe, it, expect } from 'vitest';
import { sanitizeWikiHtml } from '../components/brain/wikiHtml';

describe('sanitizeWikiHtml — dangerous content stripping', () => {
  it('removes script/style/iframe/object/embed/link/meta/base/form tags', () => {
    const html = `<div><script>alert(1)</script><p>ok</p><iframe src="x"></iframe></div>`;
    const out = sanitizeWikiHtml(html);
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('ok');
  });

  it('strips on* event-handler attributes and javascript:/data: URLs', () => {
    const html = `<a href="javascript:alert(1)" onclick="alert(2)">link</a>`;
    const out = sanitizeWikiHtml(html);
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('javascript:');
  });
});

describe('sanitizeWikiHtml — dedupeLeadSentence (brain-index "This brain This brain" fix)', () => {
  it('strips the duplicate leading "This brain" from the engine brain-index lead paragraph', () => {
    const html =
      '<section data-section="lead"><p><b>This brain</b> This brain covers 11 main topics: Cerveau, Testing. It contains 2612 notes.</p></section>';
    const out = sanitizeWikiHtml(html);
    expect(out).toContain('<b>This brain</b> covers 11 main topics');
    expect(out).not.toMatch(/This brain\s*This brain/);
  });

  it('leaves an already-clean lead paragraph untouched', () => {
    const html =
      '<section data-section="lead"><p><b>This brain</b> is a browser demo.</p></section>';
    const out = sanitizeWikiHtml(html);
    expect(out).toContain('<b>This brain</b> is a browser demo.');
  });

  it('does nothing when there is no lead section at all', () => {
    const html = '<article><h1>Title</h1><p>Some other text.</p></article>';
    expect(sanitizeWikiHtml(html)).toContain('Some other text.');
  });
});
