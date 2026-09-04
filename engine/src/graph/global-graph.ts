/**
 * Global cross-project graph builder.
 * Identifies edges that span project boundaries:
 * - Shared entities (libs, tables, APIs used in multiple projects)
 * - Cross-references (one project's note mentions another project's topic)
 * - Code import boundaries (project A imports from project B if both share code paths)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../util/config.js';
import type { HierarchyTree } from './hierarchy.js';
import type { BrainEdge, BrainKnowledgeGraph, BrainNode } from './knowledge-graph.js';

export interface CrossProjectEdge {
  source: string; // source node id (with project prefix)
  target: string; // target node id (with project prefix)
  sourceProject: string;
  targetProject: string;
  type: 'shares-entity' | 'cross-references' | 'shared-code' | 'co-mentioned';
  confidence: 'extracted' | 'inferred' | 'ambiguous';
  evidence: string; // why this edge exists
}

export interface SharedEntity {
  name: string;
  type: string;
  projects: string[];
}

export interface ProjectPair {
  projectA: string;
  projectB: string;
  edgeCount: number;
}

export interface GlobalGraph {
  version: '1.0.0';
  generated: string;
  projects: string[];
  crossEdges: CrossProjectEdge[];
  sharedEntities: SharedEntity[];
  stats: {
    totalProjects: number;
    totalCrossEdges: number;
    densestPair: ProjectPair;
  };
}

const GLOBAL_GRAPH_FILENAME = 'global-graph.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectOf(node: BrainNode): string {
  return node.topic ?? node.topicPath.split('/')[0] ?? 'unknown';
}

/**
 * Group nodes by their top-level project segment.
 */
function groupByProject(nodes: BrainNode[]): Map<string, BrainNode[]> {
  const groups = new Map<string, BrainNode[]>();
  for (const node of nodes) {
    const project = projectOf(node);
    const existing = groups.get(project) ?? [];
    groups.set(project, [...existing, node]);
  }
  return groups;
}

/**
 * Extract a normalized entity key from a node's tags and title.
 * Used to detect shared entities across projects.
 */
function entityKeysOf(node: BrainNode): string[] {
  const keys: string[] = [];

  // Tags are space-separated
  const tags = node.tags.filter((t) => t.length >= 3);
  keys.push(...tags);

  // Significant words in the title (>= 4 chars, not stop words)
  const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'have', 'will', 'been', 'also']);
  const titleWords = node.title
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  keys.push(...titleWords);

  return [...new Set(keys)];
}

/**
 * Find entities (tags/concepts) shared across multiple projects.
 */
function findSharedEntities(nodesByProject: Map<string, BrainNode[]>): SharedEntity[] {
  // entity -> set of projects that contain it
  const entityToProjects = new Map<string, Set<string>>();
  const entityTypes = new Map<string, string>();

  for (const [project, nodes] of nodesByProject) {
    for (const node of nodes) {
      const keys = entityKeysOf(node);
      for (const key of keys) {
        const existing = entityToProjects.get(key) ?? new Set<string>();
        existing.add(project);
        entityToProjects.set(key, existing);

        // Derive a rough entity type from the node type
        if (!entityTypes.has(key)) {
          entityTypes.set(key, node.type === 'decision' ? 'decision' : 'concept');
        }
      }
    }
  }

  const shared: SharedEntity[] = [];
  for (const [name, projects] of entityToProjects) {
    if (projects.size >= 2) {
      shared.push({
        name,
        type: entityTypes.get(name) ?? 'concept',
        projects: Array.from(projects).sort(),
      });
    }
  }

  return shared.sort((a, b) => b.projects.length - a.projects.length);
}

/**
 * Build cross-project edges from existing graph edges.
 * An edge is "cross-project" when source and target belong to different projects.
 */
function buildCrossEdgesFromGraph(
  edges: BrainEdge[],
  nodeMap: Map<string, BrainNode>,
): CrossProjectEdge[] {
  const crossEdges: CrossProjectEdge[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    if (!srcNode || !tgtNode) continue;

    const srcProject = projectOf(srcNode);
    const tgtProject = projectOf(tgtNode);

    if (srcProject === tgtProject) continue;

    const key = `${edge.source}::${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);

    crossEdges.push({
      source: edge.source,
      target: edge.target,
      sourceProject: srcProject,
      targetProject: tgtProject,
      type: 'cross-references',
      confidence: edge.confidence,
      evidence: `Direct edge of type '${edge.type}' in brain graph (strength=${edge.strength.toFixed(2)})`,
    });
  }

  return crossEdges;
}

/**
 * Build cross-project edges from shared entities.
 * If project A and project B both mention entity X, create a co-mentioned edge
 * between the highest-importance nodes of each project that use that entity.
 */
function buildCoMentionedEdges(
  sharedEntities: SharedEntity[],
  nodesByProject: Map<string, BrainNode[]>,
): CrossProjectEdge[] {
  const edges: CrossProjectEdge[] = [];
  const seen = new Set<string>();

  for (const entity of sharedEntities) {
    const projects = entity.projects;
    // Only create edges between pairs of projects
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const projectA = projects[i];
        const projectB = projects[j];

        const nodesA = nodesByProject.get(projectA) ?? [];
        const nodesB = nodesByProject.get(projectB) ?? [];

        // Find the most important node in each project mentioning the entity
        const nodeA = nodesA
          .filter((n) => entityKeysOf(n).includes(entity.name))
          .sort((a, b) => b.importance - a.importance)[0];
        const nodeB = nodesB
          .filter((n) => entityKeysOf(n).includes(entity.name))
          .sort((a, b) => b.importance - a.importance)[0];

        if (!nodeA || !nodeB) continue;

        const key = `${nodeA.id}::${nodeB.id}::co-mentioned`;
        const reverseKey = `${nodeB.id}::${nodeA.id}::co-mentioned`;
        if (seen.has(key) || seen.has(reverseKey)) continue;
        seen.add(key);

        edges.push({
          source: nodeA.id,
          target: nodeB.id,
          sourceProject: projectA,
          targetProject: projectB,
          type: 'co-mentioned',
          confidence: 'inferred',
          evidence: `Both projects mention entity '${entity.name}'`,
        });
      }
    }
  }

  return edges;
}

/**
 * Build cross-project edges from hierarchy tree (shared code paths).
 * If two projects share a common ancestor path segment, they may share code.
 */
function buildSharedCodeEdges(
  hierarchy: HierarchyTree,
  nodesByProject: Map<string, BrainNode[]>,
): CrossProjectEdge[] {
  const edges: CrossProjectEdge[] = [];
  const seen = new Set<string>();

  // Look for nodes in different projects that share module-level segments
  const projects = Array.from(nodesByProject.keys());
  const projectModules = new Map<string, Set<string>>();

  for (const project of projects) {
    const modules = new Set<string>();
    // Collect sub-segments from the hierarchy for this project
    for (const [id, node] of hierarchy.byId) {
      if (node.level >= 2 && id.startsWith(`${project}/`)) {
        modules.add(node.segment.toLowerCase());
      }
    }
    projectModules.set(project, modules);
  }

  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const projectA = projects[i];
      const projectB = projects[j];
      const modulesA = projectModules.get(projectA) ?? new Set();
      const modulesB = projectModules.get(projectB) ?? new Set();

      const sharedModules = [...modulesA].filter((m) => modulesB.has(m));
      if (sharedModules.length === 0) continue;

      // Pick representative nodes from each project
      const nodesA = nodesByProject.get(projectA) ?? [];
      const nodesB = nodesByProject.get(projectB) ?? [];
      const nodeA = nodesA.sort((a, b) => b.pagerank - a.pagerank)[0];
      const nodeB = nodesB.sort((a, b) => b.pagerank - a.pagerank)[0];

      if (!nodeA || !nodeB) continue;

      const key = `${projectA}::${projectB}::shared-code`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        source: nodeA.id,
        target: nodeB.id,
        sourceProject: projectA,
        targetProject: projectB,
        type: 'shared-code',
        confidence: 'inferred',
        evidence: `Shared module segments: ${sharedModules.slice(0, 3).join(', ')}`,
      });
    }
  }

  return edges;
}

/**
 * Compute the densest project pair (most cross-edges between them).
 */
function computeDensestPair(crossEdges: CrossProjectEdge[], projects: string[]): ProjectPair {
  const pairCounts = new Map<string, number>();

  for (const edge of crossEdges) {
    const pair = [edge.sourceProject, edge.targetProject].sort().join('::');
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }

  if (pairCounts.size === 0) {
    const [projectA = 'unknown', projectB = 'unknown'] = projects;
    return { projectA, projectB, edgeCount: 0 };
  }

  const [densestPairKey, edgeCount] = [...pairCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const [projectA, projectB] = densestPairKey.split('::');
  return { projectA: projectA ?? 'unknown', projectB: projectB ?? 'unknown', edgeCount };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildGlobalGraph(
  graph: BrainKnowledgeGraph,
  hierarchy: HierarchyTree,
): GlobalGraph {
  const nodesByProject = groupByProject(graph.nodes);
  const projects = Array.from(nodesByProject.keys()).sort();
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // 1. Direct cross-project edges from the existing graph
  const directCrossEdges = buildCrossEdgesFromGraph(graph.edges, nodeMap);

  // 2. Shared entities across projects
  const sharedEntities = findSharedEntities(nodesByProject);

  // 3. Co-mentioned edges (entities shared between projects)
  const coMentionedEdges = buildCoMentionedEdges(sharedEntities, nodesByProject);

  // 4. Shared-code edges from hierarchy
  const sharedCodeEdges = buildSharedCodeEdges(hierarchy, nodesByProject);

  // Merge all cross-edges, deduplicating by source+target+type
  const seen = new Set<string>();
  const allCrossEdges: CrossProjectEdge[] = [];

  for (const edge of [...directCrossEdges, ...coMentionedEdges, ...sharedCodeEdges]) {
    const key = `${edge.source}::${edge.target}::${edge.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      allCrossEdges.push(edge);
    }
  }

  const densestPair = computeDensestPair(allCrossEdges, projects);

  return {
    version: '1.0.0',
    generated: new Date().toISOString(),
    projects,
    crossEdges: allCrossEdges,
    sharedEntities,
    stats: {
      totalProjects: projects.length,
      totalCrossEdges: allCrossEdges.length,
      densestPair,
    },
  };
}

export function saveGlobalGraph(g: GlobalGraph): string {
  const cfg = getConfig();
  if (!existsSync(cfg.cachePath)) mkdirSync(cfg.cachePath, { recursive: true });
  const path = join(cfg.cachePath, GLOBAL_GRAPH_FILENAME);
  writeFileSync(path, JSON.stringify(g, null, 2), 'utf8');
  return path;
}

export function loadGlobalGraph(): GlobalGraph | null {
  const cfg = getConfig();
  const path = join(cfg.cachePath, GLOBAL_GRAPH_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as GlobalGraph;
    if (!data.version || !data.projects || !data.crossEdges) return null;
    return data;
  } catch {
    return null;
  }
}
