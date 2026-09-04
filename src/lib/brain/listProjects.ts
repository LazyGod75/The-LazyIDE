import { getPlatform } from '../platform/index.js';
import { isTauri } from '../platform/index.js';
import type { BrainTreeNode } from '../platform/types.js';
import { basenameOf } from './projectId.js';

export interface BrainProject {
  /** Canonical (deduped) project id shown in the UI and used as the select value. */
  project: string;
  noteCount: number;
  /** Every raw slug this canonical project may appear under in engine data
      (the `data-cerveau-project` attribute) — always includes `project`
      itself. A project indexed both by its short name and by its full path
      root (e.g. via "Add project to brain") produces two different raw
      slugs for what is really one project; callers that filter by exact
      attribute match (see BrainFilters.tsx) must query every alias, not
      just the canonical one, or notes tagged under the other alias would
      silently drop out of the filter. */
  rawValues: string[];
}

function countLeafNotes(node: BrainTreeNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((sum, child) => sum + countLeafNotes(child), 0);
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface RawProjectEntry {
  rawSlug: string;
  /** Grouping key two raw slugs collapse onto when they're really the same
      project. MUST be derived from the raw, pre-slugify label/path (see
      `slugKey` below) — deriving it from an already-slugified `rawSlug`
      would be a no-op, since slugify has already turned every path
      separator into a hyphen by then, making a full-path slug
      indistinguishable from a short name. */
  canonicalKey: string;
  noteCount: number;
}

/** Slugifies the basename of a raw label/path — used both as a query value
    (via slugify alone, see call sites below) and, for canonicalKey, to
    collapse a full-path-derived slug and a short-name slug for the SAME
    project onto the same grouping key. */
function slugKey(label: string): string {
  return slugify(basenameOf(label));
}

/** Groups raw project entries that share the same canonicalKey into one
    BrainProject each, summing note counts and collecting every distinct raw
    slug as an alias. The shortest raw slug is used as the
    displayed/selected `project` value — it is the one least likely to be a
    raw-path slug and reads best in the UI. */
function mergeAliases(entries: RawProjectEntry[]): BrainProject[] {
  const groups = new Map<string, RawProjectEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.canonicalKey) ?? [];
    group.push(entry);
    groups.set(entry.canonicalKey, group);
  }
  return Array.from(groups.values()).map((group) => {
    const rawValues = Array.from(new Set(group.map((g) => g.rawSlug)));
    const project = [...rawValues].sort((a, b) => a.length - b.length)[0];
    return {
      project,
      noteCount: group.reduce((sum, g) => sum + g.noteCount, 0),
      rawValues,
    };
  });
}

async function listFromTree(): Promise<BrainProject[] | null> {
  try {
    const tree = await getPlatform().brain.tree();
    if (!tree.projects || tree.projects.length === 0) return null;
    return mergeAliases(
      tree.projects.map((p) => ({
        rawSlug: slugify(p.label),
        canonicalKey: slugKey(p.label),
        noteCount: countLeafNotes(p),
      })),
    );
  } catch {
    return null;
  }
}

async function listFromGraph(): Promise<BrainProject[]> {
  try {
    const graph = await getPlatform().brain.graphAll();
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      const key = node.sourceProject
        ? slugify(node.sourceProject.split(/[\\/]/).pop() ?? node.sourceProject)
        : node.cluster;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const entries = Array.from(counts.entries()).map(([rawSlug, noteCount]) => ({
      rawSlug,
      canonicalKey: slugKey(rawSlug),
      noteCount,
    }));
    return mergeAliases(entries);
  } catch {
    try {
      const graph = await getPlatform().brain.graph();
      const counts = new Map<string, number>();
      for (const node of graph.nodes) {
        counts.set(node.cluster, (counts.get(node.cluster) ?? 0) + 1);
      }
      const entries = Array.from(counts.entries()).map(([rawSlug, noteCount]) => ({
        rawSlug,
        canonicalKey: slugKey(rawSlug),
        noteCount,
      }));
      return mergeAliases(entries);
    } catch {
      return [];
    }
  }
}

export async function listBrainProjects(): Promise<BrainProject[]> {
  if (!isTauri()) return [];
  const fromTree = await listFromTree();
  if (fromTree && fromTree.length > 0) return fromTree;
  return listFromGraph();
}
