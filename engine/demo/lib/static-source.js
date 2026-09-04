// examples/brain-ui/lib/static-source.js
// Static-mode data source: serves all API calls from pre-computed data/ files.
// Used when the SPA is served as a static site (no live /_api server).
// All public functions mirror the api-client.js signatures exactly.

// ---------------------------------------------------------------------------
// Manifest cache
// ---------------------------------------------------------------------------

/** @type {Array<object>|null} */
let _manifest = null;

/** @type {Map<string, object>|null} */
let _manifestById = null;

/**
 * Fetch and cache the manifest array (data/notes.json).
 * @returns {Promise<Array<object>>}
 */
async function loadManifest() {
  if (_manifest !== null) return _manifest;

  try {
    const res = await fetch('data/notes.json');
    if (!res.ok) {
      _manifest = [];
      _manifestById = new Map();
      return _manifest;
    }
    const data = await res.json();
    _manifest = Array.isArray(data) ? data : [];
    _manifestById = new Map(_manifest.map((entry) => [entry.id, entry]));
    return _manifest;
  } catch {
    _manifest = [];
    _manifestById = new Map();
    return _manifest;
  }
}

/**
 * Get a manifest entry by note ID (requires manifest already loaded).
 * @param {string} id
 * @returns {object|null}
 */
function getManifestEntry(id) {
  if (!_manifestById) return null;
  return _manifestById.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Search-index cache
// ---------------------------------------------------------------------------

/** @type {Array<object>|null} */
let _searchIndex = null;

/**
 * Fetch and cache the search index (data/search-index.json).
 * @returns {Promise<Array<object>>}
 */
async function loadSearchIndex() {
  if (_searchIndex !== null) return _searchIndex;

  try {
    const res = await fetch('data/search-index.json');
    if (!res.ok) {
      _searchIndex = [];
      return _searchIndex;
    }
    const data = await res.json();
    _searchIndex = Array.isArray(data) ? data : [];
    return _searchIndex;
  } catch {
    _searchIndex = [];
    return _searchIndex;
  }
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a data/ file by its manifest-relative path.
 * @param {string} relativePath — e.g. "notes/my-note.html"
 * @returns {Promise<Response|null>}
 */
async function fetchDataFile(relativePath) {
  try {
    const res = await fetch(`data/${relativePath}`);
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — signatures match api-client.js exactly
// ---------------------------------------------------------------------------

/**
 * Return the full notes manifest (mirrors GET /_api/notes).
 * Returns an array of manifest entries; each entry already contains
 * id, title, type, tags, topic, created, importance, snippet.
 * @returns {Promise<Array<object>>}
 */
export async function fetchNotes() {
  return loadManifest();
}

/**
 * Fetch a note's scrubbed HTML body by ID (mirrors GET /_api/note/:id).
 * Resolves the per-note HTML path via the manifest.
 * @param {string} id
 * @returns {Promise<string>}
 */
export async function fetchNote(id) {
  await loadManifest();
  const entry = getManifestEntry(id);
  if (!entry || !entry.html) {
    throw new Error(`Note not found in static manifest: ${id}`);
  }
  const res = await fetchDataFile(entry.html);
  if (!res) {
    throw new Error(`Static note HTML not found: ${entry.html}`);
  }
  return res.text();
}

/**
 * Fetch the sidebar project tree (mirrors GET /_api/tree).
 * @returns {Promise<{projects: Array}>}
 */
export async function fetchTree() {
  try {
    const res = await fetch('data/tree.json');
    if (!res.ok) return { projects: [] };
    return res.json();
  } catch {
    return { projects: [] };
  }
}

/**
 * Fetch backlinks for a note (mirrors GET /_api/notes/:id/backlinks).
 * Returns { noteId, total, backlinks: [...] } on success, [] on failure.
 * @param {string} id
 * @returns {Promise<object|Array>}
 */
export async function fetchBacklinks(id) {
  await loadManifest();
  const entry = getManifestEntry(id);
  if (!entry || !entry.backlinks) return [];

  const res = await fetchDataFile(entry.backlinks);
  if (!res) return [];

  try {
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Fetch graph neighbors for a note (mirrors GET /_api/notes/:id/neighbors).
 * Returns { noteId, inbound: { count, notes }, outbound: { count, notes } }.
 * mini-graph.js expects data.inbound and data.outbound as arrays of { id, type }.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function fetchNeighbors(id) {
  const empty = { inbound: [], outbound: [] };

  await loadManifest();
  const entry = getManifestEntry(id);
  if (!entry || !entry.neighbors) return empty;

  const res = await fetchDataFile(entry.neighbors);
  if (!res) return empty;

  try {
    const data = await res.json();
    // Normalise: mini-graph expects arrays of { id, type };
    // the contract shape is { inbound: { count, notes }, outbound: { count, notes } }.
    const inbound = Array.isArray(data.inbound)
      ? data.inbound
      : (data.inbound?.notes ?? []);
    const outbound = Array.isArray(data.outbound)
      ? data.outbound
      : (data.outbound?.notes ?? []);
    return { inbound, outbound };
  } catch {
    return empty;
  }
}

/**
 * Client-side full-text search over the pre-computed search index.
 * Mirrors the shape expected by search-view.js resolveSearch():
 *   { results: Array<{ id, score, snippet }>, level: 'static' }
 * Each result is ranked by number of token matches in title/text/tags/topic.
 * @param {string} query
 * @param {number} top
 * @returns {Promise<{ results: Array<object>, level: string }>}
 */
export async function searchNotes(query, top = 10) {
  if (!query || query.trim() === '') {
    return { results: [], level: 'static' };
  }

  const index = await loadSearchIndex();
  const tokens = tokenize(query);

  if (tokens.length === 0) return { results: [], level: 'static' };

  const scored = index.map((entry) => {
    const score = scoreEntry(entry, tokens);
    return { entry, score };
  });

  const matches = scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  const results = matches.map(({ entry, score }) => ({
    id: entry.id,
    score,
    snippet: buildSearchSnippet(entry.text || '', tokens),
  }));

  return { results, level: 'static' };
}

/**
 * Fetch the full graph payload (mirrors GET /_api/graph).
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
export async function fetchGraph() {
  try {
    const res = await fetch('data/graph.json');
    if (!res.ok) throw new Error(`Graph fetch failed: ${res.status}`);
    return res.json();
  } catch (err) {
    throw new Error(`Graph failed: ${err.message}`);
  }
}

/**
 * Fetch the slim layout-only payload (mirrors GET /_api/graph-layout.json).
 * @returns {Promise<{nodes:Array, edges:Array, clusters:Array, hasPositions:boolean}>}
 */
export async function fetchGraphLayout() {
  try {
    const res = await fetch('data/graph-layout.json');
    if (!res.ok) throw new Error(`Graph layout fetch failed: ${res.status}`);
    return res.json();
  } catch (err) {
    throw new Error(`Graph layout failed: ${err.message}`);
  }
}

/**
 * Fetch topic stats (mirrors GET /_api/topics/:path).
 * In static mode, this falls back to synthesising stats from the manifest
 * for the requested topic path. Returns null if no notes found.
 * @param {string} topicPath
 * @returns {Promise<object|null>}
 */
export async function fetchTopicStats(topicPath) {
  const manifest = await loadManifest();
  const prefix = topicPath.replace(/\/$/, '');
  const notes = manifest.filter((n) => {
    const topic = n.topic || '';
    return topic === prefix || topic.startsWith(prefix + '/');
  });
  if (notes.length === 0) return null;

  return {
    topic: topicPath,
    total: notes.length,
    types: countByField(notes, 'type'),
  };
}

/**
 * Fetch topic synthesis HTML (mirrors GET /_api/synthesis/:topic).
 * File name follows the generator convention: data/synthesis-<safe-topic>.html
 * @param {string} topic
 * @returns {Promise<string|null>}
 */
export async function fetchSynthesis(topic) {
  const safeTopicName = topic.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60);
  try {
    const res = await fetch(`data/synthesis-${safeTopicName}.html`);
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch the brain-index synthesis HTML (mirrors GET /_api/synthesis/index).
 * @returns {Promise<string|null>}
 */
export async function fetchBrainIndex() {
  try {
    const res = await fetch('data/synthesis-index.html');
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

/**
 * Fetch a note HTML by its path relative to the site root.
 * In static mode, the manifest is the authoritative path resolver; fall back
 * to a direct fetch of the path for backward compatibility.
 * @param {string} notePath
 * @returns {Promise<string|null>}
 */
export async function fetchNoteByPath(notePath) {
  try {
    const res = await fetch(notePath);
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

/**
 * Resolve a legacy href like "file:<relative-path>" to a note ID.
 * In static mode, resolved client-side against the manifest.
 * @param {string} href
 * @returns {Promise<{id: string, path: string}|null>}
 */
export async function resolveHref(href) {
  const manifest = await loadManifest();

  if (href.startsWith('file:')) {
    const filePath = href.slice('file:'.length).replace(/\\/g, '/');
    // Match against note path field in the manifest
    const found = manifest.find((n) => {
      const notePath = (n.path || '').replace(/\\/g, '/');
      return notePath.endsWith(filePath) || notePath === filePath;
    });
    if (found) return { id: found.id, path: found.path };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Search helpers (private)
// ---------------------------------------------------------------------------

/**
 * Split a query string into lowercase tokens (min 2 chars).
 * @param {string} query
 * @returns {string[]}
 */
function tokenize(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ''))
    .filter((t) => t.length >= 2);
}

/**
 * Score a search-index entry against a set of query tokens.
 * Title matches are weighted 3x, tags 2x, topic 1.5x, body 1x.
 * @param {object} entry — { id, title, type, tags, topic, text }
 * @param {string[]} tokens
 * @returns {number}
 */
function scoreEntry(entry, tokens) {
  const title = (entry.title || '').toLowerCase();
  const tags = (entry.tags || '').toLowerCase();
  const topic = (entry.topic || '').toLowerCase();
  const text = (entry.text || '').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 3;
    if (tags.includes(token)) score += 2;
    if (topic.includes(token)) score += 1.5;
    if (text.includes(token)) score += 1;
  }
  return score;
}

/**
 * Extract a short text snippet around the first token match in the body text.
 * @param {string} text
 * @param {string[]} tokens
 * @returns {string}
 */
function buildSearchSnippet(text, tokens) {
  if (!text) return '';

  const lower = text.toLowerCase();
  let matchPos = -1;

  for (const token of tokens) {
    const pos = lower.indexOf(token);
    if (pos !== -1 && (matchPos === -1 || pos < matchPos)) {
      matchPos = pos;
    }
  }

  const CONTEXT = 80;
  const MAX = 200;
  const start = matchPos === -1 ? 0 : Math.max(0, matchPos - CONTEXT);
  const raw = text.slice(start, start + MAX).replace(/\s+/g, ' ').trim();
  return start > 0 ? '…' + raw : raw;
}

/**
 * Count occurrences of each unique value for a field across an array.
 * @param {Array<object>} arr
 * @param {string} field
 * @returns {Record<string, number>}
 */
function countByField(arr, field) {
  const counts = {};
  for (const item of arr) {
    const val = item[field] ?? 'unknown';
    counts[val] = (counts[val] ?? 0) + 1;
  }
  return counts;
}
