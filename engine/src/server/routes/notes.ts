import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadBacklinks } from '../../graph/backlinks.js';
import { listAllReadonly } from '../../indexer/fts.js';
import { knowledgeNodePath, slug } from '../../store/paths.js';
import { getLogger } from '../../util/logger.js';
import { sendJsonCached } from '../cache.js';
import { CSP_API, CSP_NOTE, mapDbError, sendError, sendJson } from '../security.js';
import type { RouteHandler } from '../types.js';

// ---------------------------------------------------------------------------
// Shared path normaliser for note paths returned to clients
// ---------------------------------------------------------------------------

function normPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, '');
}

/**
 * Parse the comma-separated `conflict_with` DB column into an array of note ids
 * (the notes this note contradicts). Empty/absent → []. Written by
 * graph/contradictions.ts, indexed by indexer/note-index.ts.
 */
function parseConflictWith(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// GET /_api/notes — list all notes (with optional pagination)
//
// Query params:
//   ?limit=N   — number of notes per page (integer >= 1)
//   ?offset=M  — zero-based start index (integer >= 0)
//
// Backward-compat: when neither param is present the full array is returned
// exactly as before. When params are provided the sliced array is returned
// and X-Total-Count carries the total before slicing.
// ---------------------------------------------------------------------------

export const handleNotes: RouteHandler = (req, res, url) => {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const mapped = allNotes.map((n) => ({
      id: n.id,
      path: normPath(n.path),
      title: n.title,
      type: n.type,
      tags: n.tags,
      topic: n.topic || null,
      created: n.created,
      importance: n.importance,
      // Contradiction-detection signal (graph/contradictions.ts) — surfaced so
      // the frontend wiki view can render a "contradicts a past decision"
      // warning without re-parsing note HTML.
      saliencyKind: n.saliency_kind ?? null,
      conflictWith: parseConflictWith(n.conflict_with),
    }));

    const rawLimit = url.searchParams.get('limit');
    const rawOffset = url.searchParams.get('offset');
    const hasPagination = rawLimit !== null || rawOffset !== null;

    let slice = mapped;
    let extra: Record<string, string> | undefined;

    if (hasPagination) {
      const limit = Math.max(1, Number.parseInt(rawLimit ?? '20', 10) || 20);
      const offset = Math.max(0, Number.parseInt(rawOffset ?? '0', 10) || 0);
      slice = mapped.slice(offset, offset + limit);
      extra = { 'x-total-count': String(mapped.length) };
    }

    sendJsonCached(req, res, 200, slice, { csp: CSP_API, extra }).catch((err) => {
      log.error({ err }, 'Compression error in /_api/notes');
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, 'API error in /_api/notes');
    sendError(res, 500, 'Index not ready');
  }
};

// ---------------------------------------------------------------------------
// GET /_api/notes/:id/backlinks
// ---------------------------------------------------------------------------

export function handleBacklinks(_req: IncomingMessage, res: ServerResponse, noteId: string): void {
  const log = getLogger();
  try {
    const idx = loadBacklinks();
    if (!idx) {
      sendError(res, 404, 'Backlinks index not available');
      return;
    }
    const incoming = idx.incoming[noteId] ?? [];
    sendJson(res, 200, {
      noteId,
      total: incoming.length,
      backlinks: incoming.map((b) => ({
        from: b.from,
        type: b.type,
        surface: b.surface,
        auto: b.auto,
      })),
    });
  } catch (err) {
    log.error({ err }, 'API error in /_api/notes/:id/backlinks');
    sendError(res, 500, 'Failed to load backlinks');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/notes/:id/neighbors
// ---------------------------------------------------------------------------

export function handleNeighbors(_req: IncomingMessage, res: ServerResponse, noteId: string): void {
  const log = getLogger();
  try {
    const idx = loadBacklinks();
    if (!idx) {
      sendError(res, 404, 'Backlinks index not available');
      return;
    }
    const inbound = idx.incoming[noteId] ?? [];
    const outbound = idx.outgoing[noteId] ?? [];
    sendJson(res, 200, {
      noteId,
      inbound: {
        count: inbound.length,
        notes: inbound.map((b) => ({ id: b.from, type: b.type })),
      },
      outbound: {
        count: outbound.length,
        notes: outbound.map((b) => ({ id: b.to, type: b.type })),
      },
    });
  } catch (err) {
    log.error({ err }, 'API error in /_api/notes/:id/neighbors');
    sendError(res, 500, 'Failed to load neighbors');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/note/:id — resolve any note by ID
// ---------------------------------------------------------------------------

export function handleNoteById(_req: IncomingMessage, res: ServerResponse, noteId: string): void {
  const log = getLogger();
  try {
    const allIndexed = listAllReadonly({ includeExpired: false });

    // 1. Exact match
    const indexed = allIndexed.find((n) => n.id === noteId);
    if (indexed && existsSync(indexed.path)) {
      const html = readFileSync(indexed.path, 'utf-8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP_NOTE,
      });
      res.end(html);
      return;
    }

    // 2. Slugged fallback
    const sluggedId = slug(noteId);
    const slugMatch = allIndexed.find((n) => n.id === sluggedId || slug(n.id) === sluggedId);
    if (slugMatch && existsSync(slugMatch.path)) {
      const html = readFileSync(slugMatch.path, 'utf-8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP_NOTE,
      });
      res.end(html);
      return;
    }

    sendError(res, 404, `Note not found: ${noteId}`);
  } catch (err) {
    log.error({ err }, 'API error in /_api/note/:id');
    sendError(res, 500, 'Failed to load note');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/node/:id — legacy alias for knowledge-nodes
// ---------------------------------------------------------------------------

export function handleNodeById(_req: IncomingMessage, res: ServerResponse, nodeId: string): void {
  const log = getLogger();
  try {
    const nodePath = knowledgeNodePath(slug(nodeId));
    if (!existsSync(nodePath)) {
      sendError(res, 404, `Knowledge node not found: ${nodeId}`);
      return;
    }
    const html = readFileSync(nodePath, 'utf-8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP_NOTE,
    });
    res.end(html);
  } catch (err) {
    log.error({ err }, 'API error in /_api/node/:id');
    sendError(res, 500, 'Failed to load knowledge node');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/note-meta/:id — note metadata lookup
// ---------------------------------------------------------------------------

export function handleNoteMeta(_req: IncomingMessage, res: ServerResponse, noteId: string): void {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const found = allNotes.find((n) => n.id === noteId);
    if (!found) {
      sendError(res, 404, `Note not found: ${noteId}`);
      return;
    }
    sendJson(res, 200, {
      id: found.id,
      path: normPath(found.path),
      type: found.type,
      title: found.title,
      topic: found.topic ?? null,
      tags: found.tags ?? '',
      importance: found.importance ?? 0.5,
      created: found.created ?? null,
      // Contradiction-detection signal (graph/contradictions.ts) — lets the
      // wiki note panel render a "contradicts a past decision" warning that
      // links to the conflicting note(s).
      saliencyKind: found.saliency_kind ?? null,
      conflictWith: parseConflictWith(found.conflict_with),
    });
  } catch (err) {
    log.error({ err }, 'API error in /_api/note-meta/:id');
    sendError(res, 500, 'Failed to look up note metadata');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/resolve?href=<href> — resolve legacy href to note
// ---------------------------------------------------------------------------

export const handleResolve: RouteHandler = (_req, res, url) => {
  const log = getLogger();
  try {
    const href = url.searchParams.get('href');
    if (!href) {
      sendError(res, 400, 'Missing href parameter');
      return;
    }
    const allNotes = listAllReadonly({ includeExpired: false });
    let found: (typeof allNotes)[0] | undefined;

    if (href.startsWith('file:')) {
      const codePath = href.slice('file:'.length).replace(/\\/g, '/');
      const sluggedPath = slug(codePath);
      found = allNotes.find(
        (n) =>
          n.type === 'file-neuron' && (n.id.endsWith(sluggedPath) || n.id.includes(sluggedPath)),
      );
      if (!found) {
        const parts = codePath.split('/').map((p) => slug(p));
        found = allNotes.find(
          (n) => n.type === 'file-neuron' && parts.every((p) => n.id.includes(p)),
        );
      }
    } else {
      const hrefSlug = slug(href);
      found = allNotes.find((n) => n.id === hrefSlug || slug(n.id) === hrefSlug);
    }

    if (!found) {
      sendError(res, 404, `No note found for href: ${href}`);
      return;
    }
    sendJson(res, 200, {
      id: found.id,
      path: normPath(found.path),
      type: found.type,
      title: found.title,
    });
  } catch (err) {
    log.error({ err }, 'API error in /_api/resolve');
    sendError(res, 500, 'Failed to resolve href');
  }
};
