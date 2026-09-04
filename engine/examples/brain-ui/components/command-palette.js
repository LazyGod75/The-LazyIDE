// examples/brain-ui/components/command-palette.js
// Accessible command palette overlay (Ctrl+K / Cmd+K).
// - Type to filter notes (from the app's loaded notes list).
// - Static command entries: Home, Browse, Stats, Timeline, Graph.
// - Arrow-key navigation + Enter to select.
// - Trap focus while open; close on Esc or backdrop click.
// - No inline on* handlers; uses addEventListener + data-* attributes.
// - Dynamic content always goes through escapeHtml to prevent XSS.

import { escapeHtml } from './shared.js';
import { searchNotes } from '../lib/api-client.js';

/** @type {Array<{title:string,id:string,type:string}>} */
let notesCache = [];

/** Index of the currently highlighted result row (-1 = none). */
let activeIndex = -1;

/** Current debounce timer handle. */
let debounceTimer = null;

/** Whether the palette DOM is currently mounted and visible. */
let isOpen = false;

// ---------------------------------------------------------------------------
// Static command entries
// ---------------------------------------------------------------------------

/** @type {Array<{label:string,route:string,icon:string,kind:'command'}>} */
const STATIC_COMMANDS = [
  { label: 'Home',     route: '#/',         icon: '⌂', kind: 'command' },
  { label: 'Browse',   route: '#/browse',   icon: '☰', kind: 'command' },
  { label: 'Stats',    route: '#/stats',    icon: '◎', kind: 'command' },
  { label: 'Timeline', route: '#/timeline', icon: '⧖', kind: 'command' },
  { label: 'Graph',    route: 'graph.html', icon: '⬡', kind: 'command' },
];

// ---------------------------------------------------------------------------
// DOM references (set once on mount)
// ---------------------------------------------------------------------------

/** @type {HTMLElement|null} */
let backdropEl = null;

/** @type {HTMLElement|null} */
let paletteEl = null;

/** @type {HTMLInputElement|null} */
let inputEl = null;

/** @type {HTMLElement|null} */
let listEl = null;

/** @type {HTMLElement|null} */
let statusEl = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the array of result items from a query string.
 * Static commands always appear at the top when the query is empty;
 * when a query is present, only matching notes are shown (API search)
 * plus static commands whose label matches.
 * @param {string} query
 * @returns {Promise<Array>}
 */
async function buildResults(query) {
  const q = query.trim().toLowerCase();

  if (!q) {
    // Show static commands + first 8 notes alphabetically
    const topNotes = [...notesCache]
      .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id))
      .slice(0, 8)
      .map(n => ({ kind: 'note', label: n.title || n.id, id: n.id, type: n.type || '' }));

    return [
      ...STATIC_COMMANDS,
      ...topNotes,
    ];
  }

  // Filter static commands by label
  const matchedCommands = STATIC_COMMANDS.filter(cmd =>
    cmd.label.toLowerCase().includes(q)
  );

  // Search notes via API (falls back to client-side filter if fetch fails)
  let matchedNotes = [];
  try {
    const response = await searchNotes(query.trim(), 12);
    const hits = Array.isArray(response) ? response : (response?.results ?? []);
    matchedNotes = hits.map(n => ({
      kind: 'note',
      label: n.title || n.id,
      id: n.id,
      type: n.type || '',
    }));
  } catch {
    // Fallback: client-side filter on the cached list
    matchedNotes = notesCache
      .filter(n => (n.title || n.id).toLowerCase().includes(q))
      .slice(0, 12)
      .map(n => ({ kind: 'note', label: n.title || n.id, id: n.id, type: n.type || '' }));
  }

  return [...matchedCommands, ...matchedNotes];
}

/**
 * Render result items into the list element.
 * Uses data-* attributes for all interaction; no inline handlers.
 * @param {Array} results
 */
function renderResults(results) {
  if (!listEl || !statusEl) return;

  activeIndex = -1;

  if (results.length === 0) {
    listEl.innerHTML = `<li class="cp-empty" role="option" aria-selected="false">
      No results — try a different term or browse all notes.
    </li>`;
    statusEl.textContent = 'No results found.';
    return;
  }

  listEl.innerHTML = results.map((item, i) => {
    const label = escapeHtml(item.label);
    const kind = item.kind === 'command' ? 'cp-item-command' : 'cp-item-note';
    const badge = item.kind === 'note' && item.type
      ? `<span class="cp-badge">${escapeHtml(item.type.slice(0, 3).toUpperCase())}</span>`
      : '';
    const icon = item.kind === 'command'
      ? `<span class="cp-icon" aria-hidden="true">${escapeHtml(item.icon || '')}</span>`
      : '';

    return `<li
      class="cp-item ${kind}"
      role="option"
      aria-selected="false"
      data-cp-index="${i}"
      data-cp-kind="${escapeHtml(item.kind)}"
      data-cp-route="${escapeHtml(item.kind === 'command' ? item.route : `#/wiki/${encodeURIComponent(item.id)}`)}"
    >${icon}${badge}<span class="cp-label">${label}</span></li>`;
  }).join('');

  statusEl.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}.`;
}

/**
 * Navigate to the given route, closing the palette first.
 * @param {string} route
 */
function navigateTo(route) {
  close();
  if (route.startsWith('#')) {
    location.hash = route;
  } else {
    location.href = route;
  }
}

/**
 * Move the active highlight by `delta` (-1 or +1).
 * Wraps around. Updates aria-selected and scrolls item into view.
 * @param {number} delta
 */
function moveActive(delta) {
  if (!listEl) return;
  const items = listEl.querySelectorAll('.cp-item[data-cp-index]');
  if (items.length === 0) return;

  // Clear previous
  if (activeIndex >= 0 && activeIndex < items.length) {
    items[activeIndex].classList.remove('cp-active');
    items[activeIndex].setAttribute('aria-selected', 'false');
  }

  activeIndex = (activeIndex + delta + items.length) % items.length;

  items[activeIndex].classList.add('cp-active');
  items[activeIndex].setAttribute('aria-selected', 'true');
  items[activeIndex].scrollIntoView({ block: 'nearest' });

  // Update aria-activedescendant on the input
  if (inputEl) {
    inputEl.setAttribute('aria-activedescendant', `cp-item-${activeIndex}`);
    items[activeIndex].id = `cp-item-${activeIndex}`;
  }
}

/**
 * Activate the currently highlighted item (or the first item if none highlighted).
 */
function activateSelected() {
  if (!listEl) return;
  const items = listEl.querySelectorAll('.cp-item[data-cp-route]');
  if (items.length === 0) return;

  const target = activeIndex >= 0 && activeIndex < items.length
    ? items[activeIndex]
    : items[0];

  const route = target.dataset.cpRoute;
  if (route) navigateTo(route);
}

// ---------------------------------------------------------------------------
// Input handler
// ---------------------------------------------------------------------------

/**
 * Handle input changes in the search box with debouncing.
 */
async function handleInput() {
  if (!inputEl || !listEl) return;
  const q = inputEl.value;

  clearTimeout(debounceTimer);

  // Show loading placeholder instantly
  listEl.innerHTML = '<li class="cp-empty" role="option" aria-selected="false">Searching…</li>';
  if (statusEl) statusEl.textContent = 'Searching…';

  debounceTimer = setTimeout(async () => {
    try {
      const results = await buildResults(q);
      renderResults(results);
    } catch (err) {
      if (listEl) {
        listEl.innerHTML = `<li class="cp-empty" role="option" aria-selected="false">
          Error: ${escapeHtml(err.message)}
        </li>`;
      }
    }
  }, 180);
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

/**
 * Open the command palette overlay.
 * Idempotent — safe to call when already open.
 */
async function open() {
  if (isOpen) {
    inputEl?.focus();
    return;
  }
  isOpen = true;

  // Build DOM
  backdropEl = document.createElement('div');
  backdropEl.id = 'cp-backdrop';
  backdropEl.setAttribute('aria-hidden', 'true');

  paletteEl = document.createElement('div');
  paletteEl.id = 'cp-palette';
  paletteEl.setAttribute('role', 'dialog');
  paletteEl.setAttribute('aria-modal', 'true');
  paletteEl.setAttribute('aria-label', 'Command palette');

  inputEl = document.createElement('input');
  inputEl.type = 'search';
  inputEl.id = 'cp-input';
  inputEl.setAttribute('autocomplete', 'off');
  inputEl.setAttribute('autocorrect', 'off');
  inputEl.setAttribute('spellcheck', 'false');
  inputEl.setAttribute('placeholder', 'Search notes or jump to…');
  inputEl.setAttribute('aria-label', 'Command palette search');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-controls', 'cp-list');
  inputEl.setAttribute('aria-haspopup', 'listbox');

  statusEl = document.createElement('div');
  statusEl.id = 'cp-status';
  statusEl.className = 'sr-only';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.setAttribute('aria-atomic', 'true');

  listEl = document.createElement('ul');
  listEl.id = 'cp-list';
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Results');

  const inputWrap = document.createElement('div');
  inputWrap.className = 'cp-input-wrap';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'cp-search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.textContent = '⌕';
  const hint = document.createElement('kbd');
  hint.className = 'cp-kbd-hint';
  hint.textContent = 'esc';
  inputWrap.appendChild(searchIcon);
  inputWrap.appendChild(inputEl);
  inputWrap.appendChild(hint);

  paletteEl.appendChild(inputWrap);
  paletteEl.appendChild(statusEl);
  paletteEl.appendChild(listEl);

  document.body.appendChild(backdropEl);
  document.body.appendChild(paletteEl);
  document.body.setAttribute('data-cp-open', 'true');

  // Render default results
  const results = await buildResults('');
  renderResults(results);

  // Wire event listeners
  inputEl.addEventListener('input', handleInput);

  inputEl.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Enter':
        e.preventDefault();
        activateSelected();
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      default:
        break;
    }
  });

  // Focus trap: Tab/Shift+Tab keeps focus inside the palette
  paletteEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // Only focusable element inside is the input; just prevent escaping
    e.preventDefault();
    inputEl?.focus();
  });

  // Click delegation on the list
  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('[data-cp-route]');
    if (!item) return;
    navigateTo(item.dataset.cpRoute);
  });

  // Backdrop click closes
  backdropEl.addEventListener('click', () => close());

  // Focus input
  requestAnimationFrame(() => inputEl?.focus());
}

/**
 * Close the command palette and restore DOM to pre-open state.
 * Idempotent — safe to call when already closed.
 */
function close() {
  if (!isOpen) return;
  isOpen = false;
  activeIndex = -1;
  clearTimeout(debounceTimer);

  backdropEl?.remove();
  paletteEl?.remove();
  backdropEl = null;
  paletteEl = null;
  inputEl = null;
  listEl = null;
  statusEl = null;

  document.body.removeAttribute('data-cp-open');
}

/**
 * Toggle the palette open/close.
 */
function toggle() {
  if (isOpen) {
    close();
  } else {
    open();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the command palette.
 * - Registers the global Ctrl+K / Cmd+K keyboard shortcut.
 * - Stores a reference to the app's notes list for client-side fallback.
 * @param {{ notes: Array }} options
 */
export function initCommandPalette({ notes }) {
  notesCache = notes;

  document.addEventListener('keydown', (e) => {
    // Ctrl+K (Windows/Linux) or Cmd+K (Mac)
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      toggle();
    }
    // Close on Escape even when focus is elsewhere
    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      close();
    }
  });
}

/**
 * Update the notes cache (call when the notes list changes after init).
 * @param {Array} notes
 */
export function updateCommandPaletteNotes(notes) {
  notesCache = notes;
}
