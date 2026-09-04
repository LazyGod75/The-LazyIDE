/* registry.ts — Multi-repo global registry + repository groups (E).
   One registry per machine, stored in localStorage (web) or via Platform (Tauri).
   Tracks all indexed projects so the codegraph serves any project without re-config.
   Supports repository groups for cross-project analysis.
*/

import type { RepoEntry, RepoGroup, CodeGraph } from './types.js';
import { basename, normalizeForPathCompare } from '../paths.js';

// ── Registry storage ──────────────────────────────────────────────

const REGISTRY_KEY = 'lazy.codegraph.registry';
const GROUPS_KEY = 'lazy.codegraph.groups';

function loadRegistry(): RepoEntry[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RepoEntry[];
  } catch {
    return [];
  }
}

function saveRegistry(entries: RepoEntry[]): void {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(entries));
  } catch {
    // Storage quota or unavailable — in-memory only
  }
}

function loadGroups(): RepoGroup[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RepoGroup[];
  } catch {
    return [];
  }
}

function saveGroups(groups: RepoGroup[]): void {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
  } catch {
    // Storage unavailable
  }
}

// ── Registry operations ───────────────────────────────────────────

export function listRepos(): RepoEntry[] {
  return loadRegistry();
}

export function getRepo(name: string): RepoEntry | null {
  return loadRegistry().find(r => r.name === name) ?? null;
}

/**
 * B4: uses paths.ts's centralized normalizeForPathCompare (verbatim `\\?\`
 * prefix stripping, separator unification, case-insensitive NTFS compare)
 * instead of a local `path.replace(/\\/g, '/')` — that ad hoc comparison
 * never stripped a Windows verbatim prefix, so a repo registered with a
 * canonicalize()-produced verbatim path failed to match a plain lookup path
 * for the exact same directory. See paths.ts's header for the documented
 * history of this bug class.
 */
export function getRepoByPath(path: string): RepoEntry | null {
  const normalized = normalizeForPathCompare(path);
  return loadRegistry().find(r => normalizeForPathCompare(r.path) === normalized) ?? null;
}

export function registerRepo(graph: CodeGraph): RepoEntry {
  const entries = loadRegistry();
  const name = basename(graph.projectRoot);
  const existingIdx = entries.findIndex(
    r => normalizeForPathCompare(r.path) === normalizeForPathCompare(graph.projectRoot),
  );

  const entry: RepoEntry = {
    name,
    path: graph.projectRoot,
    indexedAt: graph.indexedAt,
    lastCommit: graph.lastCommit,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
  };

  if (existingIdx >= 0) {
    entries[existingIdx] = entry;
  } else {
    entries.push(entry);
  }

  saveRegistry(entries);
  return entry;
}

export function unregisterRepo(path: string): void {
  const normalized = normalizeForPathCompare(path);
  const entries = loadRegistry().filter(
    r => normalizeForPathCompare(r.path) !== normalized,
  );
  saveRegistry(entries);
}

// ── Repository groups (E2) ────────────────────────────────────────

export function listGroups(): RepoGroup[] {
  return loadGroups();
}

export function getGroup(name: string): RepoGroup | null {
  return loadGroups().find(g => g.name === name) ?? null;
}

export function createGroup(name: string): RepoGroup {
  const groups = loadGroups();
  if (groups.some(g => g.name === name)) {
    throw new Error(`Group "${name}" already exists`);
  }
  const group: RepoGroup = {
    name,
    members: [],
    createdAt: Date.now(),
  };
  groups.push(group);
  saveGroups(groups);
  return group;
}

export function addToGroup(
  groupName: string,
  memberPath: string,
  registryName: string,
): void {
  const groups = loadGroups();
  const group = groups.find(g => g.name === groupName);
  if (!group) throw new Error(`Group "${groupName}" not found`);

  // Check if already a member
  const exists = group.members.some(
    m => m.registryName === registryName,
  );
  if (!exists) {
    group.members.push({ path: memberPath, registryName });
    saveGroups(groups);
  }
}

export function removeFromGroup(groupName: string, memberPath: string): void {
  const groups = loadGroups();
  const group = groups.find(g => g.name === groupName);
  if (!group) return;
  group.members = group.members.filter(m => m.path !== memberPath);
  saveGroups(groups);
}

export function deleteGroup(name: string): void {
  const groups = loadGroups().filter(g => g.name !== name);
  saveGroups(groups);
}

// ── Group staleness (E2) ──────────────────────────────────────────

export interface GroupStaleness {
  groupName: string;
  members: Array<{
    name: string;
    path: string;
    isStale: boolean;
    lastCommit: string | null;
  }>;
  staleCount: number;
}

export function checkGroupStaleness(
  groupName: string,
  currentCommits: Map<string, string>,
): GroupStaleness {
  const group = getGroup(groupName);
  if (!group) {
    return { groupName, members: [], staleCount: 0 };
  }

  const entries = loadRegistry();
  const members = group.members.map(member => {
    const entry = entries.find(r => r.name === member.registryName);
    const currentCommit = currentCommits.get(member.path) ?? null;
    const isStale = !entry || entry.lastCommit !== currentCommit;
    return {
      name: member.registryName,
      path: member.path,
      isStale,
      lastCommit: entry?.lastCommit ?? null,
    };
  });

  return {
    groupName,
    members,
    staleCount: members.filter(m => m.isStale).length,
  };
}

// ── Cross-repo search (E2) ────────────────────────────────────────

export interface CrossRepoSearchResult {
  repoName: string;
  hits: Array<{ nodeName: string; filePath: string; kind: string }>;
}

export function searchAcrossRepos(
  graphs: Map<string, CodeGraph>,
  query: string,
  limit?: number,
): CrossRepoSearchResult[] {
  const results: CrossRepoSearchResult[] = [];
  const maxPerRepo = limit ?? 10;

  for (const [repoName, graph] of graphs) {
    const hits: CrossRepoSearchResult['hits'] = [];
    const lowerQuery = query.toLowerCase();

    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'folder') continue;
      if (node.name.toLowerCase().includes(lowerQuery)) {
        hits.push({ nodeName: node.name, filePath: node.filePath, kind: node.kind });
      }
      if (hits.length >= maxPerRepo) break;
    }

    if (hits.length > 0) {
      results.push({ repoName, hits });
    }
  }

  return results;
}
