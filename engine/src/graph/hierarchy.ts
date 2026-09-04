import type { NoteFile } from '../store/reader.js';
import { normalizeCwd } from '../util/cwd-normalizer.js';

export interface HierarchyNode {
  id: string;
  level: number;
  segment: string;
  parent: string | null;
  children: string[];
  noteIds: string[];
  conversationCount: number;
}

export interface HierarchyTree {
  root: HierarchyNode;
  byId: Map<string, HierarchyNode>;
  projects: string[];
  totalNodes: number;
}

const ROOT_ID = '_root';

function extractCwd(html: string): string | null {
  const m = html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
  return m?.[1] ?? null;
}

function makeNode(
  id: string,
  level: number,
  segment: string,
  parent: string | null,
): HierarchyNode {
  return {
    id,
    level,
    segment,
    parent,
    children: [],
    noteIds: [],
    conversationCount: 0,
  };
}

function ensureNode(
  byId: Map<string, HierarchyNode>,
  id: string,
  level: number,
  segment: string,
  parent: string | null,
): HierarchyNode {
  const existing = byId.get(id);
  if (existing) return existing;
  const node = makeNode(id, level, segment, parent);
  byId.set(id, node);
  return node;
}

function buildAncestors(byId: Map<string, HierarchyNode>, segments: string[]): void {
  // Ensure every prefix node exists and children links are wired up.
  for (let depth = 1; depth <= segments.length; depth++) {
    const id = segments.slice(0, depth).join('/');
    const segment = segments[depth - 1];
    const parentId = depth === 1 ? ROOT_ID : segments.slice(0, depth - 1).join('/');
    const level = depth; // root=0, project=1, module=2, feature=3+

    ensureNode(byId, id, level, segment, parentId);

    const parent = byId.get(parentId);
    if (parent && !parent.children.includes(id)) {
      parent.children = [...parent.children, id];
    }
  }
}

/**
 * Builds the project hierarchy tree from all conversation notes.
 * Each note is attached to the MOST SPECIFIC matching node (longest path).
 */
export function extractHierarchy(notes: NoteFile[]): HierarchyTree {
  const byId = new Map<string, HierarchyNode>();

  // Create root
  const root = makeNode(ROOT_ID, 0, '_root', null);
  byId.set(ROOT_ID, root);

  for (const note of notes) {
    const rawCwd = extractCwd(note.html);
    if (!rawCwd) continue;

    const normalized = normalizeCwd(rawCwd);
    if (!normalized) continue;

    const { segments } = normalized;
    if (segments.length === 0) continue;

    // Ensure all ancestor nodes exist
    buildAncestors(byId, segments);

    // Attach note to the most specific node (leaf of this note's path)
    const leafId = segments.join('/');
    const leafNode = byId.get(leafId);
    if (!leafNode) continue;

    const noteId = note.id || note.path;
    if (noteId && !leafNode.noteIds.includes(noteId)) {
      leafNode.noteIds = [...leafNode.noteIds, noteId];
    }
  }

  // Wire root children (level-1 project nodes)
  for (const [id, node] of byId) {
    if (id === ROOT_ID) continue;
    if (node.level === 1 && !root.children.includes(id)) {
      root.children = [...root.children, id];
    }
  }

  // Compute conversationCount = own noteIds + all descendant noteIds
  function countConversations(nodeId: string): number {
    const node = byId.get(nodeId);
    if (!node) return 0;
    const ownCount = node.noteIds.length;
    const childCount = node.children.reduce((sum, cid) => sum + countConversations(cid), 0);
    return ownCount + childCount;
  }

  for (const [, node] of byId) {
    node.conversationCount = countConversations(node.id);
  }

  const projects = root.children.slice();
  const totalNodes = byId.size;

  return { root, byId, projects, totalNodes };
}
