/**
 * Builds data/search-index.json for client-side full-text search.
 *
 * Each entry contains stripped plain text so the SPA can run substring /
 * keyword matching without a server. Blocked / secret notes are excluded.
 */
import { parseHTML } from 'linkedom';
import type { IndexedNote } from '../indexer/fts.js';
import type { AcceptedNote } from './manifest.js';
import type { SearchIndexEntry } from './types.js';

/**
 * Extract stripped plain text from a scrubbed HTML body.
 * Collapses whitespace and strips all tags.
 */
function stripToText(html: string): string {
  if (!html) return '';
  try {
    const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
    // Use querySelector('body') — linkedom's document.body property may differ
    const body = document.querySelector('body');
    return ((body ?? document.documentElement)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * Build an FTS-ready plain text from both indexed metadata and scrubbed body.
 * Priority: title + tags + topic prefix (for faceted filtering) + body text.
 */
function buildSearchText(indexed: IndexedNote, cleanedHtml: string): string {
  const parts: string[] = [];

  if (indexed.title) parts.push(indexed.title);
  if (indexed.tags) parts.push(indexed.tags);
  if (indexed.topic) parts.push(indexed.topic.replace(/\//g, ' '));

  const bodyText = stripToText(cleanedHtml);
  if (bodyText) parts.push(bodyText);

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildSearchIndex(accepted: ReadonlyArray<AcceptedNote>): SearchIndexEntry[] {
  return accepted.map(({ indexed, cleaned }) => ({
    id: indexed.id,
    title: indexed.title,
    type: indexed.type,
    tags: indexed.tags ?? '',
    topic: indexed.topic ?? null,
    created: indexed.created ?? null,
    text: buildSearchText(indexed, cleaned),
  }));
}
