// examples/brain-ui/components/topic-view.js
// Topic page: topic-overview synthesis + breadcrumb + subtopic grid + notes grouped by type.

import { escapeHtml, sanitizeHtml, convertInternalLinks, enrichHtmlContent, attachWikiLinkHandlers, activateStickyToc } from './shared.js';
import { fetchSynthesis } from '../lib/api-client.js';
import {
  getNotesUnder,
  buildSubtopicGrid,
  buildNotesByType,
  wireNoteLinks
} from './home-view.js';

/**
 * Render a topic directory page into container.
 * @param {Element} container
 * @param {{ pathParts: string[], tree: object }} data
 */
export async function renderTopic(container, { pathParts, tree }) {
  let node = tree;

  for (const part of pathParts) {
    if (!node.children.has(part)) {
      container.innerHTML = `<div class="empty-state">
        <h2>Not found</h2>
        <p>${escapeHtml(pathParts.join('/'))}</p>
      </div>`;
      return;
    }
    node = node.children.get(part);
  }

  const allNotes = getNotesUnder(tree, pathParts);
  const isLeaf = node.children.size === 0;
  const title = pathParts[pathParts.length - 1];
  const topicPath = pathParts.join('/');

  // Attempt to load topic-overview synthesis
  let synthHtml = null;
  try {
    synthHtml = await fetchSynthesis(topicPath);
  } catch (_err) {
    // Non-fatal: fall back to note list
  }

  if (synthHtml) {
    const clean = convertInternalLinks(sanitizeHtml(synthHtml));

    // Build breadcrumb + synthesis article as primary content
    const breadcrumbHtml = buildBreadcrumb(pathParts);
    const wrapper = document.createElement('div');
    wrapper.className = 'wiki-article synthesis-content';
    wrapper.innerHTML = clean;
    enrichHtmlContent(wrapper);

    container.innerHTML = breadcrumbHtml;
    container.appendChild(wrapper);
    attachWikiLinkHandlers(wrapper);
    activateStickyToc(wrapper);
  } else if (allNotes.length === 0 && node.children.size === 0) {
    // Empty topic: no notes, no subtopics, no synthesis
    let html = buildBreadcrumb(pathParts);
    html += buildEmptyTopicState(title);
    container.innerHTML = html;
  } else {
    // Fallback: original note list view
    let html = buildBreadcrumb(pathParts);
    html += `<h1>${escapeHtml(title)}</h1>`;
    html += buildTopicStats(allNotes, node);
    html += buildSubtopicGrid(pathParts, node, tree);
    html += buildNotesByType(node.notes, isLeaf, allNotes);
    container.innerHTML = html;
    wireNoteLinks(container);
  }
}

/**
 * Build an empty-topic state when there are no notes or subtopics yet.
 * @param {string} title
 * @returns {string}
 */
function buildEmptyTopicState(title) {
  return `<div class="empty-state">
    <h2>${escapeHtml(title)}</h2>
    <p>This topic has no notes yet.</p>
    <p>Start adding notes tagged with <strong>${escapeHtml(title)}</strong> to populate it,
       or run <code>lazybrain build</code> to extract knowledge from your codebase.</p>
  </div>`;
}

function buildBreadcrumb(pathParts) {
  let items = `<li><a href="#/">LazyBrain</a></li>`;

  for (let i = 0; i < pathParts.length; i++) {
    const path = pathParts.slice(0, i + 1).join('/');
    if (i === pathParts.length - 1) {
      items += `<li><strong>${escapeHtml(pathParts[i])}</strong></li>`;
    } else {
      items += `<li><a href="#/${path}">${escapeHtml(pathParts[i])}</a></li>`;
    }
  }

  return `<nav aria-label="breadcrumb"><ol class="breadcrumb">${items}</ol></nav>`;
}

function buildTopicStats(allNotes, node) {
  const decisions = allNotes.filter(n => n.type === 'decision').length;

  return `<div class="topic-stats">
    <div class="topic-stat-card"><div class="topic-stat-value">${allNotes.length}</div><div class="topic-stat-label">Total Notes</div></div>
    <div class="topic-stat-card"><div class="topic-stat-value">${decisions}</div><div class="topic-stat-label">Decisions</div></div>
    <div class="topic-stat-card"><div class="topic-stat-value">${node.children.size}</div><div class="topic-stat-label">Sub-topics</div></div>
  </div>`;
}
