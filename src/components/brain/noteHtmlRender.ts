/* noteHtmlRender.ts — utilities for rendering full note HTML in the Wiki tab.

   Ported from LazyBrain brain-ui's wiki-view.js / shared.js:
   - sanitizeNoteHtml: strips dangerous tags/attrs (reuses sanitizeWikiHtml)
   - rewriteNoteLinks: rewrites #/wiki/<id>, #/note/<id>, #/file:<path>, and
     #<id-with-colon> links so they stay inside the Wiki view instead of
     navigating away. Adds `wiki-link` class for styling.
   - generateNoteToc: builds a <nav class="toc"> from h2/h3 headings.
*/

import { sanitizeWikiHtml } from './wikiHtml';

export { sanitizeWikiHtml as sanitizeNoteHtml };

/**
 * Rewrite internal links in the note HTML for in-view SPA navigation.
 * Rules (ported from brain-ui wiki-view.js rewriteLinks):
 *   #/wiki/<id>              → already correct, keep
 *   #/note/<id>              → rewrite to #/wiki/<id>
 *   #/file:<path>            → keep as-is (WikiPage intercepts → editor:openFile)
 *   #<id> (contains colon)   → rewrite to #/wiki/<id> (neuron reference)
 *   #fn-* / #cls-*           → in-page anchors, keep
 *   #/<topic>                → already a topic route, keep
 *
 * Returns the rewritten HTML string.
 */
export function rewriteNoteLinks(html: string): string {
  if (typeof DOMParser === 'undefined') return html;

  const doc = new DOMParser().parseFromString(html, 'text/html');

  const links = doc.querySelectorAll('a[href]');
  for (const link of Array.from(links)) {
    const href = link.getAttribute('href');
    if (!href) continue;

    // Already the canonical route
    if (href.startsWith('#/wiki/')) {
      link.classList.add('wiki-link');
      continue;
    }

    // In-page anchor for fn- / cls- (function/class section anchors)
    if (href.startsWith('#fn-') || href.startsWith('#cls-')) continue;

    // Legacy #/note/<id> — rewrite to #/wiki/<id>
    if (href.startsWith('#/note/')) {
      const rawId = decodeURIComponent(href.slice('#/note/'.length));
      link.setAttribute('href', `#/wiki/${encodeURIComponent(rawId)}`);
      link.classList.add('wiki-link');
      continue;
    }

    // #/file:<path> — keep as-is, WikiPage will intercept and emit editor:openFile
    if (href.startsWith('#/file:')) {
      link.classList.add('wiki-link');
      link.setAttribute('data-file-path', href.slice('#/file:'.length));
      continue;
    }

    // #/<topic> — already a topic route
    if (href.startsWith('#/')) {
      link.classList.add('wiki-link');
      continue;
    }

    // Generic href starting with # and containing a colon — likely a neuron reference
    if (href.startsWith('#') && href.includes(':')) {
      const rawId = href.slice(1);
      link.setAttribute('href', `#/wiki/${encodeURIComponent(rawId)}`);
      link.classList.add('wiki-link');
      continue;
    }
  }

  return doc.body.innerHTML;
}

/**
 * Generate a table of contents from h2/h3 headings in the note HTML.
 * Returns an HTML string with <nav class="toc"> or null if < 2 headings.
 * Ported from brain-ui shared.js generateTOC.
 */
export function generateNoteToc(html: string): string | null {
  if (typeof DOMParser === 'undefined') return null;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const headings = doc.querySelectorAll('h2, h3');
  if (headings.length < 2) return null;

  const items: { level: number; text: string; id: string }[] = [];
  for (const heading of Array.from(headings)) {
    const level = parseInt(heading.tagName[1], 10);
    const text = heading.textContent?.trim() ?? '';
    if (!text) continue;
    const id = heading.getAttribute('id') || text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    heading.setAttribute('id', id);
    items.push({ level, text, id });
  }

  if (items.length < 2) return null;

  let tocHtml = '<nav class="toc" aria-label="Contents"><h2>Contents</h2><ol>';
  let prevLevel = 2;
  for (const item of items) {
    if (item.level > prevLevel) {
      for (let i = 0; i < item.level - prevLevel; i++) tocHtml += '<ol>';
    } else if (item.level < prevLevel) {
      for (let i = 0; i < prevLevel - item.level; i++) tocHtml += '</ol>';
    }
    const levelClass = item.level === 2 ? 'toc-h2' : 'toc-h3';
    tocHtml += `<li class="${levelClass}"><a href="#${item.id}">${item.text}</a></li>`;
    prevLevel = item.level;
  }
  for (let i = 2; i < prevLevel; i++) tocHtml += '</ol>';
  tocHtml += '</ol></nav>';

  // Return the TOC HTML plus the modified body (with IDs set on headings)
  return `<div class="wiki-toc-wrap">${tocHtml}</div>${doc.body.innerHTML}`;
}
