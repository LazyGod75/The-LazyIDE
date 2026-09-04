// examples/brain-ui/components/search-view.js
// Search results with filter controls (type, project/topic, date) and highlighted snippets.
// Filters degrade gracefully: any dimension with no data is hidden automatically.
// No inline event handlers — addEventListener + event delegation throughout.

import { searchNotes } from '../lib/api-client.js';
import { escapeHtml, formatDate } from './shared.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Render search results into container.
 * @param {Element} container
 * @param {{ query: string, notes: Array }} data
 */
export async function renderSearch(container, { query, notes }) {
  if (!query || query.trim() === '') {
    renderEmptyPrompt(container);
    return;
  }

  container.innerHTML = '<div class="loading">Searching&hellip;</div>';

  const rawResults = await resolveSearch(query, notes);

  // Build filter state from actual result data
  const filterState = buildInitialFilterState(rawResults);

  render(container, query, rawResults, filterState);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render or re-render the full search view: header + filters + results.
 * Called on initial load and on every filter change.
 * @param {Element} container
 * @param {string} query
 * @param {Array} rawResults
 * @param {{ type: string, project: string, date: string }} filterState
 */
function render(container, query, rawResults, filterState) {
  const filtered = applyFilters(rawResults, filterState);

  const breadcrumb = buildBreadcrumb(query);
  const header = buildHeader(query, filtered.length, rawResults.length);
  const filters = buildFilters(rawResults, filterState);
  const results = buildResults(filtered, query);

  container.innerHTML = breadcrumb + header + filters + results;

  wireSpaLinks(container);
  wireFilterControls(container, query, rawResults, filterState);
  wireResultList(container);
}

function renderEmptyPrompt(container) {
  container.innerHTML = `<div class="empty-state search-empty-prompt">
    <h2>Search the brain</h2>
    <p>Full-text search across all notes, decisions, and code neurons.</p>
    <div class="search-example-queries" aria-label="Example searches">
      <span class="search-example-label">Try:</span>
      <button class="search-example-btn" type="button" data-query="decision">decision</button>
      <button class="search-example-btn" type="button" data-query="auth">auth</button>
      <button class="search-example-btn" type="button" data-query="stripe">stripe</button>
    </div>
    <p class="empty-hint">
      Tip: press <kbd>/</kbd> to focus the search bar, or <kbd>Ctrl+K</kbd> to open the command palette.
    </p>
  </div>`;

  // Wire example query buttons
  for (const btn of container.querySelectorAll('.search-example-btn')) {
    btn.addEventListener('click', () => {
      const q = btn.dataset.query;
      const input = document.getElementById('search-input');
      if (input) {
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Breadcrumb + header
// ---------------------------------------------------------------------------

function buildBreadcrumb(query) {
  return `<nav aria-label="breadcrumb">
    <ol class="breadcrumb">
      <li><a href="#/" data-spa-href="#/">LazyBrain</a></li>
      <li><strong>Search: ${escapeHtml(query)}</strong></li>
    </ol>
  </nav>`;
}

function buildHeader(query, filteredCount, totalCount) {
  const countText =
    filteredCount === totalCount
      ? `${filteredCount} result${filteredCount !== 1 ? 's' : ''}`
      : `${filteredCount} of ${totalCount} result${totalCount !== 1 ? 's' : ''} (filtered)`;

  return `<div class="search-header">
    <h1 class="search-query-title">
      Results for <em>${escapeHtml(query)}</em>
    </h1>
    <p class="search-count">${escapeHtml(countText)}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Filter controls
// ---------------------------------------------------------------------------

/**
 * Derive the initial filter state (all = "any" = no active filter).
 * @param {Array} results
 * @returns {{ type: string, project: string, date: string }}
 */
function buildInitialFilterState(results) {
  return { type: '', project: '', date: '' };
}

/**
 * Collect unique values for each filterable dimension from the result set.
 * Returns null for dimensions that have no useful variation (all same / only one value).
 * @param {Array} results
 * @returns {{ types: string[]|null, projects: string[]|null, hasDates: boolean }}
 */
function collectFilterOptions(results) {
  const typeSet = new Set();
  const projectSet = new Set();
  let hasDates = false;

  for (const r of results) {
    if (r.type) typeSet.add(r.type);

    const project = (r.topic || '').split('/')[0];
    if (project) projectSet.add(project);

    if (r.created) hasDates = true;
  }

  return {
    types: typeSet.size > 1 ? [...typeSet].sort() : null,
    projects: projectSet.size > 1 ? [...projectSet].sort() : null,
    hasDates,
  };
}

/**
 * Build the filter bar HTML. Hides any dimension with no meaningful variation.
 * @param {Array} rawResults
 * @param {{ type: string, project: string, date: string }} filterState
 * @returns {string}
 */
function buildFilters(rawResults, filterState) {
  const opts = collectFilterOptions(rawResults);

  const hasAnyFilter = opts.types || opts.projects || opts.hasDates;
  if (!hasAnyFilter) return '';

  const parts = [];

  if (opts.types) {
    const options = ['', ...opts.types]
      .map((t) => {
        const sel = t === filterState.type ? ' selected' : '';
        const label = t || 'All types';
        return `<option value="${escapeHtml(t)}"${sel}>${escapeHtml(label)}</option>`;
      })
      .join('');
    parts.push(`<label class="filter-label" for="filter-type">Type
      <select id="filter-type" class="filter-select" data-filter="type"
              aria-label="Filter by note type">
        ${options}
      </select>
    </label>`);
  }

  if (opts.projects) {
    const options = ['', ...opts.projects]
      .map((p) => {
        const sel = p === filterState.project ? ' selected' : '';
        const label = p || 'All projects';
        return `<option value="${escapeHtml(p)}"${sel}>${escapeHtml(label)}</option>`;
      })
      .join('');
    parts.push(`<label class="filter-label" for="filter-project">Project
      <select id="filter-project" class="filter-select" data-filter="project"
              aria-label="Filter by project">
        ${options}
      </select>
    </label>`);
  }

  if (opts.hasDates) {
    const dateOptions = buildDateOptions(filterState.date);
    parts.push(`<label class="filter-label" for="filter-date">Date
      <select id="filter-date" class="filter-select" data-filter="date"
              aria-label="Filter by date">
        ${dateOptions}
      </select>
    </label>`);
  }

  if (parts.length === 0) return '';

  const activeCount = [filterState.type, filterState.project, filterState.date].filter(
    Boolean,
  ).length;

  const clearBtn =
    activeCount > 0
      ? `<button class="filter-clear" type="button" data-filter-action="clear"
               aria-label="Clear all filters">
        Clear filters
       </button>`
      : '';

  return `<div class="search-filters" role="search" aria-label="Search filters">
    ${parts.join('')}
    ${clearBtn}
  </div>`;
}

/**
 * Build date-range filter <option> elements.
 * @param {string} current — currently selected value
 * @returns {string}
 */
function buildDateOptions(current) {
  const options = [
    { value: '', label: 'Any time' },
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
    { value: '90d', label: 'Last 90 days' },
    { value: '1y', label: 'Last year' },
  ];
  return options
    .map(({ value, label }) => {
      const sel = value === current ? ' selected' : '';
      return `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(label)}</option>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

/**
 * Apply filter state to raw results and return a filtered copy.
 * @param {Array} results
 * @param {{ type: string, project: string, date: string }} state
 * @returns {Array}
 */
function applyFilters(results, state) {
  let out = results;

  if (state.type) {
    out = out.filter((r) => r.type === state.type);
  }

  if (state.project) {
    out = out.filter((r) => {
      const project = (r.topic || '').split('/')[0];
      return project === state.project;
    });
  }

  if (state.date) {
    const cutoff = dateCutoff(state.date);
    if (cutoff) {
      out = out.filter((r) => r.created && new Date(r.created) >= cutoff);
    }
  }

  return out;
}

/**
 * Compute the Date cutoff for a date-range filter value.
 * @param {string} value — e.g. "7d", "30d", "90d", "1y"
 * @returns {Date|null}
 */
function dateCutoff(value) {
  const now = new Date();
  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };
  const d = days[value];
  if (!d) return null;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - d);
  return cutoff;
}

// ---------------------------------------------------------------------------
// Results list
// ---------------------------------------------------------------------------

function buildResults(filtered, query) {
  if (filtered.length === 0) {
    return `<div class="empty-state search-empty">
      <p>No notes match the current filters.</p>
      <p class="empty-hint">Try adjusting the filters or searching for a different term.</p>
    </div>`;
  }

  const items = filtered.map((note) => renderResultItem(note, query)).join('');
  return `<ul class="note-list search-results" data-search-list>${items}</ul>`;
}

/**
 * Render a single search result item.
 * Snippet is displayed prominently with query terms highlighted.
 * @param {object} note
 * @param {string} query
 * @returns {string}
 */
function renderResultItem(note, query) {
  const typeClass = (note.type || '').toLowerCase();
  const typeLabel = escapeHtml((note.type || '?').slice(0, 3).toUpperCase());

  const routingBadge = note.routing_level
    ? `<span class="routing-level">L${escapeHtml(String(note.routing_level))}</span>`
    : '';

  const scoreBadge =
    note.score != null
      ? `<span class="search-score">${escapeHtml(note.score.toFixed(2))}</span>`
      : '';

  const topicPill = note.topic
    ? `<span class="activity-topic">${escapeHtml(note.topic)}</span>`
    : '';

  const datePill = note.created
    ? `<span class="note-date">${escapeHtml(formatDate(note.created))}</span>`
    : '';

  const titleHtml = highlightTerms(note.title || note.id, query);

  // Snippet: shown with query terms marked and full text visible
  const snippetHtml = buildSnippet(note.snippet, query);

  const tagsPill = note.tags ? buildTagsPills(note.tags) : '';

  const decisionStatus = note.decision_status
    ? `<span class="decision-status decision-status--${escapeHtml(note.decision_status.toLowerCase())}">${escapeHtml(note.decision_status)}</span>`
    : '';

  return `<li class="search-result-item"
              data-note-href="#/wiki/${escapeHtml(note.id)}"
              role="button"
              tabindex="0"
              aria-label="Open: ${escapeHtml(note.title || note.id)}">
    <div class="search-result-header">
      <span class="type-badge ${escapeHtml(typeClass)}">${typeLabel}</span>
      <span class="search-result-title">${titleHtml}</span>
      ${routingBadge}
      ${scoreBadge}
      ${decisionStatus}
    </div>
    <div class="search-result-meta">
      ${topicPill}
      ${datePill}
      ${tagsPill}
    </div>
    ${snippetHtml}
  </li>`;
}

/**
 * Build a snippet block from the snippet field.
 * If snippet is absent or empty, renders nothing.
 * Query terms inside the snippet text are highlighted with <mark>.
 * @param {string|undefined} snippet
 * @param {string} query
 * @returns {string}
 */
function buildSnippet(snippet, query) {
  if (!snippet || snippet.trim() === '') return '';

  // Truncate very long snippets for readability
  const MAX_CHARS = 280;
  const display =
    snippet.length > MAX_CHARS ? snippet.slice(0, MAX_CHARS).trimEnd() + '…' : snippet;

  const highlighted = highlightTerms(display, query);

  return `<div class="search-result-snippet" aria-label="Excerpt">${highlighted}</div>`;
}

/**
 * Build tag pills from a tags field (string or array).
 * @param {string|string[]} tags
 * @returns {string}
 */
function buildTagsPills(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags)
        .split(/[,\s]+/)
        .filter(Boolean);

  if (list.length === 0) return '';

  return list
    .slice(0, 5)
    .map((tag) => `<span class="tag-pill">${escapeHtml(tag)}</span>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Text highlighting
// ---------------------------------------------------------------------------

/**
 * Escape text and highlight query terms with <mark>.
 * Safe: text is HTML-escaped before regex substitution.
 * @param {string} text
 * @param {string} query
 * @returns {string}
 */
function highlightTerms(text, query) {
  if (!text) return '';
  const safe = escapeHtml(String(text));
  if (!query) return safe;

  // Split query into individual terms and highlight each
  const terms = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (terms.length === 0) return safe;

  const pattern = new RegExp(`(${terms.join('|')})`, 'gi');
  // Replace on the already-escaped string — mark tags are trusted
  return safe.replace(pattern, '<mark>$1</mark>');
}

// ---------------------------------------------------------------------------
// Search resolution
// ---------------------------------------------------------------------------

/**
 * Perform a search via the API, falling back to local note matching.
 * @param {string} query
 * @param {Array} allNotes
 * @returns {Promise<Array>}
 */
async function resolveSearch(query, allNotes) {
  try {
    const data = await searchNotes(query, 30);
    const results = data?.results ?? [];
    if (Array.isArray(results) && results.length > 0) {
      return results.map((r) => {
        const full = allNotes.find((n) => n.id === r.id) ?? {};
        return {
          id: r.id,
          title: full.title || r.id,
          type: full.type ?? r.type,
          topic: full.topic,
          created: full.created,
          tags: full.tags,
          decision_status: full.decision_status,
          routing_level: data.level,
          score: r.score,
          snippet: r.snippet || '',
        };
      });
    }
  } catch (_) {
    // Fall through to local search
  }

  // Local fallback: filter by title / tags / type / topic
  const q = query.toLowerCase();
  return allNotes
    .filter((n) => {
      const text = [n.title, n.tags, n.type, n.topic].filter(Boolean).join(' ').toLowerCase();
      return text.includes(q);
    })
    .sort((a, b) => {
      const aTitle = (a.title || '').toLowerCase().includes(q) ? 1 : 0;
      const bTitle = (b.title || '').toLowerCase().includes(q) ? 1 : 0;
      return bTitle - aTitle;
    })
    .slice(0, 30)
    .map((n) => ({ ...n, snippet: '' }));
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

/**
 * Wire [data-spa-href] links inside container.
 * @param {Element} container
 */
function wireSpaLinks(container) {
  for (const a of container.querySelectorAll('a[data-spa-href]')) {
    if (a.dataset.clickBound) continue;
    a.dataset.clickBound = '1';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = a.dataset.spaHref;
    });
  }
}

/**
 * Wire filter <select> change events and the "Clear filters" button.
 * Re-renders results without a new API call on every change.
 * @param {Element} container
 * @param {string} query
 * @param {Array} rawResults
 * @param {{ type: string, project: string, date: string }} filterState
 */
function wireFilterControls(container, query, rawResults, filterState) {
  const filterBar = container.querySelector('.search-filters');
  if (!filterBar) return;

  // Delegate all select changes via the filter bar
  filterBar.addEventListener('change', (e) => {
    const select = e.target.closest('[data-filter]');
    if (!select) return;

    const key = select.dataset.filter;
    const value = select.value;

    // Build new filter state immutably
    const nextState = { ...filterState, [key]: value };

    // Replace filterState reference for subsequent events
    Object.assign(filterState, nextState);

    // Re-render in place
    render(container, query, rawResults, nextState);
  });

  // "Clear filters" button via event delegation
  filterBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter-action="clear"]');
    if (!btn) return;

    const clearedState = { type: '', project: '', date: '' };
    Object.assign(filterState, clearedState);
    render(container, query, rawResults, clearedState);
  });
}

/**
 * Wire click and keyboard navigation for search result items.
 * Uses event delegation on the list container.
 * @param {Element} container
 */
function wireResultList(container) {
  const list = container.querySelector('[data-search-list]');
  if (!list) return;

  list.addEventListener('click', (e) => {
    const item = e.target.closest('[data-note-href]');
    if (!item) return;
    location.hash = item.dataset.noteHref;
  });

  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('[data-note-href]');
    if (!item) return;
    e.preventDefault();
    location.hash = item.dataset.noteHref;
  });
}
