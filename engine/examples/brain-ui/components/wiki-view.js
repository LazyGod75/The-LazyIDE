// examples/brain-ui/components/wiki-view.js
// Renders any code-first neuron (file-neuron, aggregate-neuron, concept) or generic note
// by fetching its raw HTML from the brain and injecting it into the wiki layout.

import { fetchBacklinks, fetchNote, fetchNoteByPath, resolveHref } from '../lib/api-client.js';
import { setWikiTitle } from './app-shell.js';
import { mountMiniGraph } from './mini-graph.js';
import {
  activateStickyToc,
  attachWikiLinkHandlers,
  convertInternalLinks,
  enrichHtmlContent,
  escapeHtml,
  generateTOC,
  sanitizeHtml,
} from './shared.js';

/**
 * Render a wiki article for any neuron type into the container.
 * Used for #/wiki/<id> routes.
 * @param {Element} container
 * @param {{ note: object|null, notes: Array }} data
 * @returns {Promise<void>}
 */
export async function renderWiki(container, { note, notes }) {
  if (!note) {
    container.innerHTML = `<div class="empty-state">
      <h2>Neuron not found</h2>
      <p>No neuron with this ID exists in this brain.</p>
      <p><a href="#/">Return home</a> or use <kbd>Ctrl+K</kbd> to search for something.</p>
    </div>`;
    return;
  }

  container.innerHTML = `<div class="loading loading--wiki" role="status" aria-live="polite">
    <span class="loading-spinner" aria-hidden="true"></span>
    Loading <em>${escapeHtml(note.title || note.id)}</em>&hellip;
  </div>`;

  try {
    // Prefer the canonical /_api/note/:id endpoint (resolves by ID across all stores).
    // Fall back to path-based fetch if the ID route fails (e.g. old knowledge-nodes).
    let rawHtml = null;
    try {
      rawHtml = await fetchNote(note.id);
    } catch {
      rawHtml = await fetchNoteByPath(note.path);
    }
    if (!rawHtml) {
      throw new Error(`Could not load note: ${note.id}`);
    }
    await renderWikiContent(container, note, rawHtml, notes);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">
      <h2>Failed to load neuron</h2>
      <p>${escapeHtml(err.message)}</p>
      <p><a href="#/">Return home</a> or <a href="javascript:location.reload()">retry</a>.</p>
    </div>`;
  }
}

/**
 * Parse and inject raw note HTML into the container, with breadcrumb and wiki layout.
 * Rewrites child/dependency links to use SPA routing.
 * @param {Element} container
 * @param {object} note
 * @param {string} rawHtml
 * @param {Array} allNotes
 * @returns {Promise<void>}
 */
async function renderWikiContent(container, note, rawHtml, allNotes) {
  const clean = sanitizeHtml(rawHtml);

  const parser = new DOMParser();
  const doc = parser.parseFromString(clean, 'text/html');
  const article = doc.querySelector('article') || doc.body;

  // Extract metadata from article attributes
  const noteType = article.getAttribute('data-cerveau-type') || note.type || '';
  const noteTitle = note.title || article.querySelector('h1')?.textContent?.trim() || note.id;
  const noteTopic = note.topic || article.getAttribute('data-cerveau-topic') || '';

  // Update document title once the real note title is known
  setWikiTitle(noteTitle);

  // Rewrite internal links to SPA routes before rendering
  rewriteLinks(article, allNotes);

  // Build breadcrumb from topic
  const breadcrumbHtml = buildBreadcrumb(noteTopic, noteTitle, note);

  // Build the type badge
  const typeCls = noteType.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const typeBadge = `<span class="type-badge ${typeCls} neuron-type-badge">${escapeHtml(noteType.toUpperCase())}</span>`;

  // Prepare article content
  const contentEl = document.createElement('div');
  contentEl.className = 'wiki-article neuron-article';
  contentEl.setAttribute('data-neuron-type', noteType);

  // Build metadata bar and inject it into the DOM
  const metaBar = buildMetaBar(article, note);
  const metaBarHtml = metaBar ? `<div class="wiki-meta-bar">${metaBar}</div>` : '';

  contentEl.innerHTML = `
    <div class="neuron-header">
      ${typeBadge}
      ${note.created ? `<span class="neuron-created">${escapeHtml(formatCreated(note.created))}</span>` : ''}
    </div>
    ${metaBarHtml}
    ${article.innerHTML}
  `;

  enrichHtmlContent(contentEl);

  // Generate TOC from headings if the article has enough sections.
  // generateTOC returns a <nav class="toc"> string that syncMetaSidebar can pick up.
  const headings = contentEl.querySelectorAll('h2, h3');
  if (headings.length >= 2) {
    const tocHtml = generateTOC(contentEl);
    if (tocHtml) {
      const tocEl = document.createElement('div');
      tocEl.className = 'wiki-toc-wrap';
      tocEl.innerHTML = tocHtml;
      contentEl.prepend(tocEl);
    }
  }

  container.innerHTML = breadcrumbHtml;
  container.appendChild(contentEl);

  attachWikiLinkHandlers(container);
  activateStickyToc(container);

  // Wire remaining SPA navigation in any href="#/<path>" links
  wireSpaLinks(container, allNotes);

  // Append backlinks panel before the mini-graph so the graph is last
  await loadAndRenderBacklinks(note.id, container, allNotes);

  // Embed local graph panel (lazy — built on intersection)
  mountMiniGraph(container, note);
}

/**
 * Rewrite all internal links in the article to use the unified #/wiki/<id> SPA route.
 * Rules:
 *   #/wiki/<id>              → already correct, keep
 *   #/note/<id>              → rewrite to #/wiki/<id> (unified route, never dead)
 *   #/file:<path>            → resolve file path → #/wiki/<resolved-id>
 *   #<id> (contains colon)   → try note-id match → #/wiki/<id>
 *   #fn-* / #cls-*           → in-page anchors, keep
 * @param {Element} article
 * @param {Array} allNotes
 */
function rewriteLinks(article, allNotes) {
  const links = article.querySelectorAll('a[href]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;

    // Already the canonical route
    if (href.startsWith('#/wiki/')) continue;

    // In-page anchor for fn- / cls- (function/class section anchors within a file-neuron)
    if (href.startsWith('#fn-') || href.startsWith('#cls-')) continue;

    // Legacy #/note/<id> — rewrite to #/wiki/<id> so the unified endpoint resolves it
    if (href.startsWith('#/note/')) {
      const rawId = decodeURIComponent(href.slice('#/note/'.length));
      link.setAttribute('href', `#/wiki/${encodeURIComponent(rawId)}`);
      link.classList.add('wiki-link');
      continue;
    }

    // Children links: #/file:<relative-path> — resolve to #/wiki/<file-neuron-id>
    if (href.startsWith('#/file:')) {
      const filePath = href.slice('#/file:'.length);
      const resolvedId = resolveFilePathToId(filePath, allNotes);
      if (resolvedId) {
        link.setAttribute('href', `#/wiki/${encodeURIComponent(resolvedId)}`);
        link.classList.add('wiki-link');
      }
      continue;
    }

    // Generic href starting with # and containing a colon — might be a neuron reference
    if (href.startsWith('#') && href.includes(':')) {
      const rawId = href.slice(1);
      const note = allNotes.find((n) => n.id === rawId);
      if (note) {
        link.setAttribute('href', `#/wiki/${encodeURIComponent(rawId)}`);
        link.classList.add('wiki-link');
      }
    }
  }
}

/**
 * Resolve a relative code file path to a note ID using the notes list.
 * @param {string} filePath — e.g. "docs/archive/legacy-dashboard/charts.js"
 * @param {Array} allNotes
 * @returns {string|null}
 */
function resolveFilePathToId(filePath, allNotes) {
  // Build slug from file path components
  const parts = filePath.replace(/\\/g, '/').split('/');
  const sluggedParts = parts.map((p) =>
    p
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, ''),
  );

  // Find file-neuron whose ID contains all slug parts
  const candidates = allNotes.filter((n) => n.type === 'file-neuron');
  const match = candidates.find((n) => {
    return sluggedParts.every((part) => part.length > 1 && n.id.includes(part));
  });
  return match?.id ?? null;
}

/**
 * Wire any remaining href="#/..." links not yet handled by shared.js attachWikiLinkHandlers.
 * Also handles links that point to aggregate-neuron or concept IDs.
 * @param {Element} container
 * @param {Array} allNotes
 */
function wireSpaLinks(container, allNotes) {
  const links = container.querySelectorAll('a[href^="#/wiki/"], a[href^="#/note/"]');
  for (const link of links) {
    if (link.dataset.clickBound) continue;
    link.dataset.clickBound = '1';
    link.classList.add('wiki-link');
    link.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = link.getAttribute('href');
    });
  }
}

/**
 * Build a breadcrumb for a neuron based on its topic + title.
 * @param {string} topic
 * @param {string} title
 * @param {object} note
 * @returns {string}
 */
function buildBreadcrumb(topic, title, note) {
  let items = `<li><a href="#/">LazyBrain</a></li>`;

  if (topic) {
    const parts = topic.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      items += `<li><a href="#/${path}">${escapeHtml(parts[i])}</a></li>`;
    }
  }

  items += `<li><strong>${escapeHtml(title)}</strong></li>`;
  return `<nav aria-label="breadcrumb"><ol class="breadcrumb">${items}</ol></nav>`;
}

/**
 * Build a metadata bar showing extra code neuron attributes.
 * Returns an HTML string (may be empty if no metadata found).
 * @param {Element} article
 * @param {object} note
 * @returns {string}
 */
function buildMetaBar(article, note) {
  const codeFile = article.getAttribute('data-code-file') || '';
  const language = article.getAttribute('data-code-language') || '';
  const lines = article.getAttribute('data-code-lines') || '';
  const exports = article.getAttribute('data-code-exports') || '';
  const importance = note.importance ? (note.importance * 100).toFixed(0) + '%' : '';

  const items = [];
  if (codeFile)
    items.push(
      `<span class="meta-item"><span class="meta-label">File:</span> <code>${escapeHtml(codeFile)}</code></span>`,
    );
  if (language)
    items.push(
      `<span class="meta-item"><span class="meta-label">Language:</span> ${escapeHtml(language)}</span>`,
    );
  if (lines)
    items.push(
      `<span class="meta-item"><span class="meta-label">Lines:</span> ${escapeHtml(lines)}</span>`,
    );
  if (exports)
    items.push(
      `<span class="meta-item"><span class="meta-label">Exports:</span> ${escapeHtml(exports)}</span>`,
    );
  if (importance)
    items.push(
      `<span class="meta-item"><span class="meta-label">Importance:</span> ${escapeHtml(importance)}</span>`,
    );

  if (items.length === 0) return '';
  return `<div class="metadata-bar code-meta-bar">${items.join('')}</div>`;
}

/**
 * Format a created ISO string as a short date.
 * @param {string} iso
 * @returns {string}
 */
function formatCreated(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/**
 * Fetch backlinks for a note and append a "Pages linking here" panel to the container.
 * @param {string} noteId
 * @param {Element} container
 * @param {Array} allNotes
 * @returns {Promise<void>}
 */
async function loadAndRenderBacklinks(noteId, container, allNotes) {
  try {
    const data = await fetchBacklinks(noteId);
    const backlinkItems = data.backlinks || data;

    if (!Array.isArray(backlinkItems) || backlinkItems.length === 0) {
      const emptyPanel = document.createElement('aside');
      emptyPanel.setAttribute('role', 'complementary');
      emptyPanel.className = 'backlinks-panel backlinks-panel--empty';
      emptyPanel.innerHTML = `
        <h3 class="backlinks-heading">
          <span class="backlinks-label">Referenced by</span>
          <span class="backlinks-count" aria-label="0 backlinks">0</span>
        </h3>
        <p class="backlinks-empty-msg">No other notes link here yet.</p>`;
      container.appendChild(emptyPanel);
      attachWikiLinkHandlers(container);
      return;
    }

    const unique = deduplicateBacklinks(backlinkItems, allNotes);

    const items = unique
      .map((bl) => {
        const safeId = encodeURIComponent(bl.id);
        return `<li class="backlinks-item">
        <a href="#/wiki/${safeId}" class="wiki-link backlinks-link">${escapeHtml(bl.title)}</a>
      </li>`;
      })
      .join('');

    const panel = document.createElement('aside');
    panel.setAttribute('role', 'complementary');
    panel.className = 'backlinks-panel';
    panel.innerHTML = `
      <h3 class="backlinks-heading">
        <span class="backlinks-label">Referenced by</span>
        <span class="backlinks-count" aria-label="${unique.length} backlinks">${unique.length}</span>
      </h3>
      <ul class="backlinks-list">${items}</ul>`;
    container.appendChild(panel);
  } catch (_) {
    // silently ignore backlink errors — non-critical UI element
  }

  attachWikiLinkHandlers(container);
}

/**
 * Deduplicate backlinks by source ID and resolve titles from the notes list.
 * @param {Array} items
 * @param {Array} allNotes
 * @returns {Array<{ id: string, title: string }>}
 */
function deduplicateBacklinks(items, allNotes) {
  const seen = new Set();
  const unique = [];

  for (const bl of items) {
    const fromId = bl.from || bl.id;
    if (fromId && !seen.has(fromId)) {
      seen.add(fromId);
      const source = allNotes.find((n) => n.id === fromId);
      unique.push({ id: fromId, title: source?.title || bl.surface || fromId });
    }
  }

  return unique;
}
