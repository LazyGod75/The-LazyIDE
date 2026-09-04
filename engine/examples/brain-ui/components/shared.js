// examples/brain-ui/components/shared.js
// Shared utilities used by multiple view components.

/**
 * Sanitize HTML: remove script/iframe/embed/object tags and on* event attributes.
 * @param {string} htmlString
 * @returns {string}
 */
export function sanitizeHtml(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  const dangerous = doc.querySelectorAll('script, iframe, embed, object');
  for (const el of dangerous) {
    el.remove();
  }

  const allElements = doc.querySelectorAll('*');
  for (const el of allElements) {
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i];
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
    }
  }

  return doc.documentElement.innerHTML;
}

/**
 * Escape a string for safe insertion into HTML text nodes.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Format a date string as a human-readable relative label.
 * @param {string} dateStr
 * @returns {string}
 */
export function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1d ago';
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return dateStr.slice(0, 10);
}

/**
 * Convert internal wiki-style anchor links (#uuid) to SPA note routes (#/note/uuid).
 * Already-correct SPA routes (#/note/..., #/topic, #/topic/sub) are left unchanged.
 * @param {string} htmlString
 * @returns {string}
 */
export function convertInternalLinks(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  const candidates = doc.querySelectorAll('a[href^="#"], a[data-cerveau-link-auto]');
  for (const link of candidates) {
    const href = link.getAttribute('href');
    if (!href) continue;

    if (href.startsWith('#/')) {
      // Already a valid SPA route — keep as-is, just add wiki-link class for styling
      if (!link.classList.contains('note-chip') && !link.classList.contains('section-link')) {
        link.classList.add('wiki-link');
      }
    } else if (href.startsWith('#')) {
      const targetId = href.slice(1);
      // Long IDs are assumed to be note references
      if (targetId.length > 8) {
        link.setAttribute('href', '#/note/' + targetId);
        link.classList.add('wiki-link');
      }
      // Short ids (#mobile, #general) are in-page anchors — leave unchanged
    }
  }

  return doc.documentElement.innerHTML;
}

/**
 * Enrich rendered HTML content with inline styles for semantic elements:
 * abbr tooltips, kbd keyboard styling, samp code output, aside icons,
 * and clickable data[value] tech terms.
 * @param {Element} container
 */
export function enrichHtmlContent(container) {
  for (const abbr of container.querySelectorAll('abbr')) {
    if (abbr.getAttribute('title')) {
      abbr.style.borderBottom = '1px dotted #ccc';
      abbr.style.cursor = 'help';
    }
  }

  for (const kbd of container.querySelectorAll('kbd')) {
    kbd.style.display = 'inline-block';
    kbd.style.padding = '2px 6px';
    kbd.style.background = '#f0f0f0';
    kbd.style.border = '1px solid #ccc';
    kbd.style.borderRadius = '3px';
    kbd.style.fontFamily = 'monospace';
    kbd.style.fontSize = '12px';
    kbd.style.boxShadow = 'inset 0 -2px 0 rgba(0,0,0,0.1)';
  }

  for (const samp of container.querySelectorAll('samp')) {
    samp.style.display = 'block';
    samp.style.background = '#f5f5f5';
    samp.style.border = '1px solid #e0e0e0';
    samp.style.borderRadius = '4px';
    samp.style.padding = '10px';
    samp.style.margin = '8px 0';
    samp.style.fontFamily = 'monospace';
    samp.style.fontSize = '12px';
    samp.style.lineHeight = '1.4';
    samp.style.overflowX = 'auto';
  }

  for (const aside of container.querySelectorAll('aside[role="doc-warning"], aside[role="doc-tip"]')) {
    const icon = aside.getAttribute('role') === 'doc-warning' ? '⚠️' : '💡';
    if (!aside.innerHTML.startsWith(icon)) {
      aside.innerHTML = `${icon} ${aside.innerHTML}`;
    }
  }

  // Make data[value] tech terms clickable — navigate to search
  for (const dataEl of container.querySelectorAll('data[value]')) {
    const term = dataEl.getAttribute('value');
    if (!term) continue;
    dataEl.style.cursor = 'pointer';
    dataEl.setAttribute('title', `Search for "${term}"`);
    // Avoid double-binding if enrichHtmlContent is called multiple times
    if (!dataEl.dataset.clickBound) {
      dataEl.dataset.clickBound = '1';
      dataEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        location.hash = '#/search/' + encodeURIComponent(term);
      });
    }
  }
}

/**
 * Attach click-handler navigation to wiki links inside a container.
 * Handles:
 *   - #/note/<id>        → note view
 *   - #/<topic>          → topic view
 *   - #/<topic>/<sub>    → sub-topic view
 *   - #<uuid>            → legacy note link (converted to #/note/<uuid>)
 *   - TOC anchor links   → smooth scroll to section
 * @param {Element} container
 */
export function attachWikiLinkHandlers(container) {
  const links = container.querySelectorAll(
    'a.wiki-link, a.note-chip, a.section-link, a[data-cerveau-link-auto]'
  );

  for (const link of links) {
    if (link.dataset.clickBound) continue;
    link.dataset.clickBound = '1';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const href = link.getAttribute('href');
      if (!href) return;

      if (href.startsWith('#/')) {
        // Already a SPA route (#/note/..., #/acme, #/acme/mobile, ...)
        location.hash = href;
      } else if (href.startsWith('#')) {
        const targetId = href.slice(1);
        // Long IDs are note references; short slugs are anchor scroll targets
        if (targetId.length > 8) {
          location.hash = '#/note/' + targetId;
        } else {
          // In-page section anchor: smooth scroll
          const target = document.getElementById(targetId);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      }
    });
  }

  // Catch-all for ANY <a href="#/..."> SPA route not yet handled by class selectors
  container.querySelectorAll('a[href^="#/"]').forEach(a => {
    if (a.dataset.clickBound) return;
    a.dataset.clickBound = '1';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = a.getAttribute('href');
    });
  });

  // Also handle plain TOC anchor links (href="#mobile" etc.) that aren't wiki-link
  const tocLinks = container.querySelectorAll('nav.toc a[href^="#"]:not(.wiki-link)');
  for (const link of tocLinks) {
    if (link.dataset.clickBound) continue;
    link.dataset.clickBound = '1';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const href = link.getAttribute('href');
      if (!href) return;
      const targetId = href.slice(1);
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
}

/**
 * Activate sticky TOC with IntersectionObserver to highlight active section.
 * Also syncs active state to the cloned TOC in the #meta panel.
 * Call after the wiki article is injected into the DOM.
 * @param {Element} container
 */
export function activateStickyToc(container) {
  const toc = container.querySelector('nav.toc');
  if (!toc) return;

  const sections = container.querySelectorAll('section[id], h2[id], h3[id]');
  if (sections.length === 0) return;

  const tocLinks = toc.querySelectorAll('a[href^="#"]');
  if (tocLinks.length === 0) return;

  // Also track the cloned TOC in the #meta panel (injected by syncMetaSidebar)
  function getMetaTocLinks() {
    const metaPanel = document.getElementById('meta');
    if (!metaPanel) return [];
    return Array.from(metaPanel.querySelectorAll('nav.toc a[href^="#"]'));
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          // Update article-internal TOC
          for (const link of tocLinks) {
            const linkId = link.getAttribute('href')?.slice(1);
            link.classList.toggle('toc-active', linkId === id);
          }
          // Update #meta TOC clone
          for (const link of getMetaTocLinks()) {
            const linkId = link.getAttribute('href')?.slice(1);
            link.classList.toggle('toc-active', linkId === id);
          }
        }
      }
    },
    { rootMargin: '-10% 0px -80% 0px', threshold: 0 }
  );

  for (const section of sections) {
    observer.observe(section);
  }
}

/**
 * Generate a nested table of contents from h2/h3/h4 headings in an element.
 * Returns an HTML string or null if there are no headings.
 * Also adds hover-anchor links to each heading for direct linking.
 * @param {Element} articleElement
 * @returns {string|null}
 */
export function generateTOC(articleElement) {
  const headings = articleElement.querySelectorAll('h2, h3, h4');
  if (headings.length === 0) return null;

  const items = [];
  for (const heading of headings) {
    const level = parseInt(heading.tagName[1], 10);
    const text = heading.textContent.trim();
    const id = heading.getAttribute('id') || text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    heading.setAttribute('id', id);
    // Add anchor icon that appears on hover (CSS-driven)
    if (!heading.querySelector('.heading-anchor')) {
      const anchor = document.createElement('a');
      anchor.className = 'heading-anchor';
      anchor.href = '#' + id;
      anchor.setAttribute('aria-label', 'Link to this section');
      anchor.textContent = '#';
      heading.appendChild(anchor);
    }
    items.push({ level, text, id });
  }

  if (items.length === 0) return null;

  // Use <nav class="toc"> so syncMetaSidebar can find it via nav.toc selector
  let html = '<nav class="toc" aria-label="Contents"><h2>Contents</h2><ol>';
  let prevLevel = 2;

  for (const item of items) {
    if (item.level > prevLevel) {
      for (let i = 0; i < item.level - prevLevel; i++) html += '<ol>';
    } else if (item.level < prevLevel) {
      for (let i = 0; i < prevLevel - item.level; i++) html += '</ol>';
    }

    const levelClass = item.level === 2 ? 'toc-h2' : item.level === 3 ? 'toc-h3' : 'toc-h4';
    html += `<li class="${levelClass}"><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`;
    prevLevel = item.level;
  }

  for (let i = 2; i < prevLevel; i++) html += '</ol>';
  html += '</ol></nav>';
  return html;
}
