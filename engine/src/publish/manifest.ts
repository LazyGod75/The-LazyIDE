/**
 * Builds the notes manifest (data/notes.json) and per-note resource paths.
 *
 * The manifest is the single source of truth the SPA uses to resolve all
 * per-note resources — no filename-encoding assumptions needed.
 */
import { parseHTML } from 'linkedom';
import type { BacklinksIndex } from '../graph/backlinks.js';
import type { IndexedNote } from '../indexer/fts.js';
import type {
  BacklinksPayload,
  ManifestEntry,
  NeighborsPayload,
  NoteMetaPayload,
} from './types.js';

// ---------------------------------------------------------------------------
// Slug helper — safe for file systems, unique per note id
// ---------------------------------------------------------------------------

function safeSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// Snippet extraction
// ---------------------------------------------------------------------------

/**
 * Extract a plain-text snippet from a scrubbed HTML body.
 * Takes the first 160 characters of visible text.
 */
function extractSnippet(html: string): string {
  if (!html) return '';
  try {
    const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
    // Use querySelector — linkedom's document.body property may differ from querySelector('body')
    const body = document.querySelector('body');
    const text = ((body ?? document.documentElement)?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 160);
  } catch {
    return html.replace(/<[^>]+>/g, '').slice(0, 160);
  }
}

// ---------------------------------------------------------------------------
// Per-note resource path builders
// ---------------------------------------------------------------------------

/** All data/ -relative paths for a given note id. */
export interface NoteResourcePaths {
  html: string; // e.g. "notes/my-note.html"
  backlinks: string; // e.g. "backlinks/my-note.json"
  neighbors: string; // e.g. "neighbors/my-note.json"
  meta: string; // e.g. "meta/my-note.json"
}

export function noteResourcePaths(id: string): NoteResourcePaths {
  const s = safeSlug(id);
  return {
    html: `notes/${s}.html`,
    backlinks: `backlinks/${s}.json`,
    neighbors: `neighbors/${s}.json`,
    meta: `meta/${s}.json`,
  };
}

// ---------------------------------------------------------------------------
// Normalise brain-relative path
// ---------------------------------------------------------------------------

function normPath(raw: string, brainRoot: string): string {
  return raw.replace(/\\/g, '/').replace(brainRoot.replace(/\\/g, '/'), '').replace(/^\//, '');
}

// ---------------------------------------------------------------------------
// Build the manifest array
// ---------------------------------------------------------------------------

export interface AcceptedNote {
  indexed: IndexedNote;
  cleaned: string;
  paths: NoteResourcePaths;
}

export function buildManifest(
  accepted: ReadonlyArray<AcceptedNote>,
  brainRoot: string,
): ManifestEntry[] {
  return accepted.map(({ indexed, cleaned, paths }) => {
    const snippet = extractSnippet(cleaned);
    return {
      id: indexed.id,
      path: normPath(indexed.path, brainRoot),
      title: indexed.title,
      type: indexed.type,
      tags: indexed.tags ?? '',
      topic: indexed.topic ?? null,
      created: indexed.created ?? null,
      importance: indexed.importance ?? 0.5,
      snippet,
      html: paths.html,
      backlinks: paths.backlinks,
      neighbors: paths.neighbors,
      meta: paths.meta,
    };
  });
}

// ---------------------------------------------------------------------------
// Per-note JSON resource builders
// ---------------------------------------------------------------------------

export function buildBacklinksJson(
  noteId: string,
  backlinksIndex: BacklinksIndex | null,
  inScopeIds?: ReadonlySet<string>,
): BacklinksPayload {
  const incoming = backlinksIndex?.incoming[noteId] ?? [];
  const scoped = inScopeIds ? incoming.filter((b) => inScopeIds.has(b.from)) : incoming;
  return {
    noteId,
    total: scoped.length,
    backlinks: scoped.map((b) => ({
      from: b.from,
      type: b.type,
      surface: b.surface,
      auto: b.auto,
    })),
  };
}

export function buildNeighborsJson(
  noteId: string,
  backlinksIndex: BacklinksIndex | null,
  inScopeIds?: ReadonlySet<string>,
): NeighborsPayload {
  const inbound = backlinksIndex?.incoming[noteId] ?? [];
  const outbound = backlinksIndex?.outgoing[noteId] ?? [];
  const scopedInbound = inScopeIds ? inbound.filter((b) => inScopeIds.has(b.from)) : inbound;
  const scopedOutbound = inScopeIds ? outbound.filter((b) => inScopeIds.has(b.to)) : outbound;
  return {
    noteId,
    inbound: {
      count: scopedInbound.length,
      notes: scopedInbound.map((b) => ({ id: b.from, type: b.type })),
    },
    outbound: {
      count: scopedOutbound.length,
      notes: scopedOutbound.map((b) => ({ id: b.to, type: b.type })),
    },
  };
}

export function buildMetaJson(indexed: IndexedNote, brainRoot: string): NoteMetaPayload {
  return {
    id: indexed.id,
    path: normPath(indexed.path, brainRoot),
    type: indexed.type,
    title: indexed.title,
    topic: indexed.topic ?? null,
    tags: indexed.tags ?? '',
    importance: indexed.importance ?? 0.5,
    created: indexed.created ?? null,
  };
}
