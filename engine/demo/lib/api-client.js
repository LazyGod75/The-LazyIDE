// examples/brain-ui/lib/api-client.js
// Unified API layer for the brain-ui SPA.
//
// Detects static mode at module load time via the lazybrain-static meta tag
// injected by the site generator into index.html. In static mode, all calls
// are served from pre-computed data/ files by static-source.js. In live mode,
// behaviour is unchanged: every method calls the /_api/* server routes.
//
// Both modes expose identical function signatures and return shapes so that
// no component ever needs to branch on the mode.

import * as staticSource from './static-source.js';

// ---------------------------------------------------------------------------
// Static mode detection (CONTRACT: meta tag injected by site generator)
// ---------------------------------------------------------------------------

/**
 * True when the SPA is running as a static site (no live /_api server).
 * Detected once at module load via the lazybrain-static meta tag.
 * @type {boolean}
 */
export const IS_STATIC = (
  typeof document !== 'undefined' &&
  document.querySelector('meta[name="lazybrain-static"]')?.content === 'true'
) === true;

const BASE = '';

// ---------------------------------------------------------------------------
// Notes list
// ---------------------------------------------------------------------------

/**
 * Fetch all notes (manifest in static mode, /_api/notes in live mode).
 * @returns {Promise<Array<object>>}
 */
export async function fetchNotes() {
  if (IS_STATIC) return staticSource.fetchNotes();
  const res = await fetch(`${BASE}/_api/notes`);
  if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Note HTML body
// ---------------------------------------------------------------------------

/**
 * Fetch any note's HTML by its ID, resolved server-side across all stores.
 * Uses /_api/note/:id which searches indexed notes + knowledge-nodes.
 * @param {string} id — note ID (e.g. "aggregate-acme-root", "file-src-app-ts")
 * @returns {Promise<string>}
 */
export async function fetchNote(id) {
  if (IS_STATIC) return staticSource.fetchNote(id);
  const res = await fetch(`${BASE}/_api/note/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch note ${id}: ${res.status}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Sidebar tree
// ---------------------------------------------------------------------------

/**
 * Fetch the code-first folder tree for the sidebar.
 * Returns { projects: [ { id, label, noteId, type, children: [...] } ] }
 * @returns {Promise<{projects: Array}>}
 */
export async function fetchTree() {
  if (IS_STATIC) return staticSource.fetchTree();
  const res = await fetch(`${BASE}/_api/tree`);
  if (!res.ok) throw new Error(`Failed to fetch tree: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Per-note supplementary data
// ---------------------------------------------------------------------------

/**
 * Fetch backlinks for a note.
 * @param {string} id
 * @returns {Promise<object|Array>}
 */
export async function fetchBacklinks(id) {
  if (IS_STATIC) return staticSource.fetchBacklinks(id);
  const res = await fetch(`${BASE}/_api/notes/${id}/backlinks`);
  if (!res.ok) return [];
  return res.json();
}

/**
 * Fetch graph neighbors for a note.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function fetchNeighbors(id) {
  if (IS_STATIC) return staticSource.fetchNeighbors(id);
  const res = await fetch(`${BASE}/_api/notes/${id}/neighbors`);
  if (!res.ok) return { inbound: [], outbound: [] };
  return res.json();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search notes.
 * In static mode: client-side ranked search over data/search-index.json.
 * In live mode: /_api/search.
 * @param {string} query
 * @param {number} top
 * @returns {Promise<object>}
 */
export async function searchNotes(query, top = 10) {
  if (IS_STATIC) return staticSource.searchNotes(query, top);
  const res = await fetch(`${BASE}/_api/search?q=${encodeURIComponent(query)}&top=${top}`);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/**
 * Fetch the full graph payload { nodes, edges }.
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
export async function fetchGraph() {
  if (IS_STATIC) return staticSource.fetchGraph();
  const res = await fetch(`${BASE}/_api/graph`);
  if (!res.ok) throw new Error(`Graph failed: ${res.status}`);
  return res.json();
}

/**
 * Fetch the slim layout-only payload for fast graph rendering.
 * Shape: { nodes:[{id,x,y,c,d,t,l?}], edges:[[si,ti],...], clusters:[...], hasPositions:bool }
 * Significantly smaller than the full graph.json — no text/snippets included.
 * @returns {Promise<{nodes:Array, edges:Array, clusters:Array, hasPositions:boolean}>}
 */
export async function fetchGraphLayout() {
  if (IS_STATIC) return staticSource.fetchGraphLayout();
  const res = await fetch(`${BASE}/_api/graph-layout.json`);
  if (!res.ok) throw new Error(`Graph layout failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Topic / synthesis
// ---------------------------------------------------------------------------

/**
 * Fetch topic stats.
 * @param {string} topicPath
 * @returns {Promise<object|null>}
 */
export async function fetchTopicStats(topicPath) {
  if (IS_STATIC) return staticSource.fetchTopicStats(topicPath);
  const res = await fetch(`${BASE}/_api/topics/${encodeURIComponent(topicPath)}`);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Fetch topic synthesis HTML.
 * @param {string} topic
 * @returns {Promise<string|null>}
 */
export async function fetchSynthesis(topic) {
  if (IS_STATIC) return staticSource.fetchSynthesis(topic);
  const res = await fetch(`${BASE}/_api/synthesis/${encodeURIComponent(topic)}`);
  if (!res.ok) return null;
  return res.text();
}

/**
 * Fetch the brain-index synthesis HTML.
 * @returns {Promise<string|null>}
 */
export async function fetchBrainIndex() {
  if (IS_STATIC) return staticSource.fetchBrainIndex();
  const res = await fetch(`${BASE}/_api/synthesis/index`);
  if (!res.ok) return null;
  return res.text();
}

// ---------------------------------------------------------------------------
// Path / href resolution
// ---------------------------------------------------------------------------

/**
 * Fetch a note's raw HTML by its file path relative to brain root.
 * Used for file-neuron, aggregate-neuron, concept neurons.
 * @param {string} notePath — e.g. "notes/2026-05/file-xxx.html"
 * @returns {Promise<string|null>}
 */
export async function fetchNoteByPath(notePath) {
  if (IS_STATIC) return staticSource.fetchNoteByPath(notePath);
  const res = await fetch(`${BASE}/${notePath}`);
  if (!res.ok) return null;
  return res.text();
}

/**
 * Resolve a legacy href like "file:<relative-path>" to a note ID.
 * The server looks up the note by the data-code-file attribute match.
 * @param {string} href — e.g. "file:docs/archive/legacy-dashboard/charts.js"
 * @returns {Promise<{id: string, path: string}|null>}
 */
export async function resolveHref(href) {
  if (IS_STATIC) return staticSource.resolveHref(href);
  const res = await fetch(`${BASE}/_api/resolve?href=${encodeURIComponent(href)}`);
  if (!res.ok) return null;
  return res.json();
}
