import { type IndexedNote, getNoteById, listAll, notesMentioningEntity } from '../indexer/fts.js';

export interface NeighboursCliOptions {
  id: string;
  depth?: number; // currently 1-hop only
  pretty?: boolean;
}

export interface NeighbourEdge {
  to: string;
  kind: 'replaces' | 'replaced-by' | 'supersedes' | 'shares-entity' | 'shares-cluster' | 'triple';
  via?: string;
}

/**
 * 1-hop graph neighbours for a note id. No LLM, no embeddings — pure attribute
 * lookups. Used by the LLM via the `lazybrain-recall` skill when it needs to
 * follow a chain ("what replaced X?", "what else uses Y?").
 */
export function runNeighbours(opts: NeighboursCliOptions): string {
  const id = opts.id.replace(/^#/, '');
  const note = getNoteById(id);
  if (!note) {
    return JSON.stringify({ status: 'noop', reason: `unknown id: ${id}` });
  }

  const edges = collectEdges(note);
  if (opts.pretty) {
    const lines = edges.map((e) => `  ${e.kind}${e.via ? ` (${e.via})` : ''} → ${e.to}`);
    return `${id}\n${lines.join('\n') || '  (no neighbours)'}`;
  }
  return JSON.stringify({ id, edges });
}

function collectEdges(note: IndexedNote): NeighbourEdge[] {
  const edges: NeighbourEdge[] = [];

  // Direct supersession
  for (const target of split(note.replaces)) {
    edges.push({ to: target, kind: 'replaces' });
  }
  for (const target of split(note.replaced_by)) {
    edges.push({ to: target, kind: 'replaced-by' });
  }
  for (const target of split(note.supersedes)) {
    edges.push({ to: target, kind: 'supersedes' });
  }

  // Triples — emit the object as the neighbour
  for (const t of split(note.triples, ';')) {
    const parts = t.split('|');
    if (parts.length === 3) {
      edges.push({ to: parts[2], kind: 'triple', via: parts[1] });
    }
  }

  // Entity co-occurrence — bounded scan
  const ents = split(note.entities);
  if (ents.length) {
    const seen = new Set<string>();
    for (const e of ents.slice(0, 3)) {
      for (const other of notesMentioningEntity(e, 5)) {
        if (other.id === note.id || seen.has(other.id)) continue;
        seen.add(other.id);
        edges.push({ to: other.id, kind: 'shares-entity', via: e });
      }
    }
  }

  // Cluster overlap fallback when we have few edges so far
  if (edges.length < 3 && note.tags) {
    const tagSet = new Set(note.tags.split(/\s+/).filter(Boolean));
    const peers = listAll({ includeExpired: false }).filter(
      (n) => n.id !== note.id && n.tags && shareAnyTag(n.tags, tagSet),
    );
    for (const p of peers.slice(0, 4)) {
      edges.push({ to: p.id, kind: 'shares-cluster' });
    }
  }

  return edges.slice(0, 12);
}

function split(s: string | null | undefined, sep = ','): string[] {
  if (!s) return [];
  return s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);
}

function shareAnyTag(tagsStr: string | null, set: Set<string>): boolean {
  if (!tagsStr) return false;
  for (const t of tagsStr.split(/\s+/)) {
    if (set.has(t)) return true;
  }
  return false;
}
