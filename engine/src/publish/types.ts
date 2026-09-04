/**
 * Shared types for the static site generator (publish --site).
 * All paths stored in the manifest are relative to the site root's data/ directory.
 */

/** Shape of a single entry in data/notes.json (the manifest array). */
export interface ManifestEntry {
  id: string;
  path: string; // original brain-relative path (informational)
  title: string;
  type: string | null;
  tags: string; // space-separated
  topic: string | null;
  created: string | null;
  importance: number;
  snippet: string; // plain-text excerpt (~160 chars)
  /** data/ -relative path to the scrubbed body HTML */
  html: string;
  /** data/ -relative path to the backlinks JSON */
  backlinks: string;
  /** data/ -relative path to the neighbors JSON */
  neighbors: string;
  /** data/ -relative path to the note-meta JSON */
  meta: string;
}

/** Shape of data/search-index.json entries. */
export interface SearchIndexEntry {
  id: string;
  title: string;
  type: string | null;
  tags: string;
  topic: string | null;
  created: string | null;
  text: string; // stripped plain text for client-side search
}

/** Shape of data/graph.json — mirrors /_api/graph. */
export interface GraphNode {
  id: string;
  title: string;
  type: string | null;
  topic: string | null;
  importance: number;
  /** Precomputed 2-D x position from layout engine. Present when lazybrain graph was run. */
  x?: number;
  /** Precomputed 2-D y position from layout engine. Present when lazybrain graph was run. */
  y?: number;
  /** Precomputed degree (in + out edges). */
  degree?: number;
  /** Top-level cluster label. */
  cluster?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  auto: boolean;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Shape of per-note backlinks JSON — mirrors /_api/notes/:id/backlinks. */
export interface BacklinksPayload {
  noteId: string;
  total: number;
  backlinks: Array<{
    from: string;
    type: string;
    surface: string | undefined;
    auto: boolean;
  }>;
}

/** Shape of per-note neighbors JSON — mirrors /_api/notes/:id/neighbors. */
export interface NeighborsPayload {
  noteId: string;
  inbound: {
    count: number;
    notes: Array<{ id: string; type: string }>;
  };
  outbound: {
    count: number;
    notes: Array<{ id: string; type: string }>;
  };
}

/** Shape of per-note meta JSON — mirrors /_api/note-meta/:id. */
export interface NoteMetaPayload {
  id: string;
  path: string;
  type: string | null;
  title: string;
  topic: string | null;
  tags: string;
  importance: number;
  created: string | null;
}

/** Final summary returned by the site generator. */
export interface SiteGenerationResult {
  outputDir: string;
  notesPublished: number;
  notesBlocked: number;
  blockedReasons: Array<{ id: string; reason: string }>;
  provenanceAttrsStripped: number;
  pathsScrubbed: number;
  sensitivePatternsDetected: string[];
}
