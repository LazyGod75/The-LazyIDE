import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type IndexedNote, listAll } from '../indexer/fts.js';
import { getConfig } from '../util/config.js';
import { analyzeGraph } from './analysis.js';
import type { GraphAnalysis } from './analysis.js';
import type { BacklinkEntry, BacklinksIndex } from './backlinks.js';
import type { ClusterAssignment } from './clusters.js';
import { findDuplicates } from './dedup.js';
import type { DedupResult } from './dedup.js';
import { computeLayout } from './layout.js';
import type { PageRankResult } from './pagerank.js';
import { buildStructuralEdges } from './structural-edges.js';

export interface BrainNode {
  id: string;
  title: string;
  type: string;
  topic: string;
  topicPath: string;
  tags: string[];
  importance: number;
  tldr: string;
  pagerank: number;
  cluster: string;
  validUntil?: string;
  /** Precomputed 2-D layout position (set after layout pass). */
  x?: number;
  y?: number;
  /** Precomputed degree (in + out). Set after edge construction. */
  degree?: number;
}

export interface BrainEdge {
  source: string;
  target: string;
  type: string;
  strength: number;
  confidence: 'extracted' | 'inferred' | 'ambiguous';
  confidenceScore: number;
}

export interface BrainCluster {
  id: string;
  label: string;
  nodeIds: string[];
  nodeCount: number;
  internalEdges: number;
  externalEdges: number;
  connectedClusters: string[];
}

export interface BrainHub {
  id: string;
  title: string;
  topic: string;
  inbound: number;
  outbound: number;
  pagerank: number;
}

export interface BrainLayer {
  id: string;
  name: string;
  description: string;
  nodeIds: string[];
  nodeCount: number;
}

export interface BrainTourStep {
  order: number;
  title: string;
  noteId: string;
  description: string;
  topic: string;
}

export interface TopicTreeNode {
  name: string;
  path: string;
  noteCount: number;
  children: TopicTreeNode[];
  hubIds: string[];
}

export interface BrainKnowledgeGraph {
  version: string;
  generated: string;
  stats: {
    nodes: number;
    edges: number;
    clusters: number;
    hubs: number;
    avgImportance: number;
    topTypes: Record<string, number>;
    topTopics: Record<string, number>;
  };
  nodes: BrainNode[];
  edges: BrainEdge[];
  clusters: BrainCluster[];
  hubs: BrainHub[];
  layers: BrainLayer[];
  tour: BrainTourStep[];
  topicTree: TopicTreeNode[];
  analysis?: GraphAnalysis;
  duplicates?: DedupResult;
}

const GRAPH_FILENAME = 'brain-graph.json';
const HUB_COUNT = 20;

function firstTopicSegment(topic: string | null | undefined): string {
  if (!topic) return 'unknown';
  const seg = topic.split('/')[0].trim();
  return seg || 'unknown';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildNode(
  note: IndexedNote,
  pagerankScores: Record<string, number>,
  clusters: ClusterAssignment,
): BrainNode {
  const clusterIndex = clusters.members[note.id];
  const clusterLabel =
    clusterIndex !== undefined
      ? (clusters.labels[clusterIndex] ?? `cluster-${clusterIndex}`)
      : 'unknown';

  const tldrRaw = note.tldr ?? note.section_tldr ?? note.section_summary ?? note.title;

  return {
    id: note.id,
    title: note.title,
    type: note.type ?? 'unknown',
    topic: firstTopicSegment(note.topic),
    topicPath: note.topic ?? 'unknown',
    tags: (note.tags ?? '').split(/\s+/).filter(Boolean),
    importance: note.importance ?? 0,
    tldr: stripHtml(tldrRaw).slice(0, 200),
    pagerank: pagerankScores[note.id] ?? 0,
    cluster: clusterLabel,
    validUntil: note.valid_until ?? undefined,
  };
}

function buildEdgesFromBacklinks(backlinks: BacklinksIndex, nodeIds: Set<string>): BrainEdge[] {
  const seen = new Set<string>();
  const edges: BrainEdge[] = [];

  for (const entries of Object.values(backlinks.outgoing ?? {})) {
    for (const entry of entries) {
      if (!nodeIds.has(entry.from) || !nodeIds.has(entry.to)) continue;
      const key = `${entry.from}::${entry.to}::${entry.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: entry.from,
        target: entry.to,
        type: entry.type,
        strength: entry.auto ? 0.5 : 1.0,
        confidence: entry.confidence,
        confidenceScore: entry.confidenceScore,
      });
    }
  }

  return edges;
}

function buildClusters(nodes: BrainNode[], edges: BrainEdge[]): BrainCluster[] {
  const clusterMap = new Map<string, string[]>();
  for (const node of nodes) {
    const existing = clusterMap.get(node.cluster) ?? [];
    clusterMap.set(node.cluster, [...existing, node.id]);
  }

  const nodeToCluster = new Map<string, string>(nodes.map((n) => [n.id, n.cluster]));

  return Array.from(clusterMap.entries()).map(([label, nodeIds]) => {
    const nodeSet = new Set(nodeIds);
    let internalEdges = 0;
    let externalEdges = 0;
    const connectedSet = new Set<string>();

    for (const edge of edges) {
      const srcInCluster = nodeSet.has(edge.source);
      const tgtInCluster = nodeSet.has(edge.target);

      if (srcInCluster && tgtInCluster) {
        internalEdges += 1;
      } else if (srcInCluster || tgtInCluster) {
        externalEdges += 1;
        const otherId = srcInCluster ? edge.target : edge.source;
        const otherCluster = nodeToCluster.get(otherId);
        if (otherCluster && otherCluster !== label) {
          connectedSet.add(otherCluster);
        }
      }
    }

    return {
      id: label,
      label,
      nodeIds,
      nodeCount: nodeIds.length,
      internalEdges,
      externalEdges,
      connectedClusters: Array.from(connectedSet),
    };
  });
}

function buildHubs(nodes: BrainNode[], edges: BrainEdge[]): BrainHub[] {
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();

  for (const edge of edges) {
    outbound.set(edge.source, (outbound.get(edge.source) ?? 0) + 1);
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return nodes
    .map((node) => ({
      id: node.id,
      title: node.title,
      topic: node.topic,
      inbound: inbound.get(node.id) ?? 0,
      outbound: outbound.get(node.id) ?? 0,
      pagerank: node.pagerank,
    }))
    .sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound))
    .slice(0, HUB_COUNT)
    .filter(() => nodeMap.size > 0);
}

function buildStats(
  nodes: BrainNode[],
  edges: BrainEdge[],
  clusters: BrainCluster[],
  hubs: BrainHub[],
): BrainKnowledgeGraph['stats'] {
  const totalImportance = nodes.reduce((sum, n) => sum + n.importance, 0);
  const avgImportance = nodes.length > 0 ? totalImportance / nodes.length : 0;

  const topTypes: Record<string, number> = {};
  for (const node of nodes) {
    topTypes[node.type] = (topTypes[node.type] ?? 0) + 1;
  }

  const topTopics: Record<string, number> = {};
  for (const node of nodes) {
    topTopics[node.topic] = (topTopics[node.topic] ?? 0) + 1;
  }

  return {
    nodes: nodes.length,
    edges: edges.length,
    clusters: clusters.length,
    hubs: hubs.length,
    avgImportance,
    topTypes,
    topTopics,
  };
}

const LAYER_DESCRIPTIONS: Record<string, string> = {
  decision: 'Technical and strategic decisions with reasoning and outcomes',
  episodic: 'Bug reports, incidents, and debugging sessions',
  semantic: 'Conceptual knowledge, definitions, and explanations',
  procedural: 'Step-by-step processes, workflows, and how-tos',
  reference: 'Configuration, documentation, and reference material',
  'topic-overview': 'Synthesized wiki pages covering entire topics',
  'brain-index': 'Global brain navigation index',
  'project-summary': 'Project-level summaries and metadata',
};

const MAX_TOUR_STEPS = 15;
const MAX_TOUR_HUBS = 5;
const MAX_TOUR_DECISIONS = 3;

function buildLayers(nodes: BrainNode[]): BrainLayer[] {
  const layerMap = new Map<string, string[]>();
  for (const node of nodes) {
    const existing = layerMap.get(node.type) ?? [];
    layerMap.set(node.type, [...existing, node.id]);
  }

  return Array.from(layerMap.entries()).map(([type, nodeIds]) => ({
    id: type,
    name: type.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: LAYER_DESCRIPTIONS[type] ?? `Notes of type ${type}`,
    nodeIds,
    nodeCount: nodeIds.length,
  }));
}

function buildTour(
  nodes: BrainNode[],
  hubs: BrainHub[],
  clusters: BrainCluster[],
): BrainTourStep[] {
  const steps: BrainTourStep[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const brainIndex = nodes.find((n) => n.type === 'brain-index');
  if (brainIndex) {
    steps.push({
      order: steps.length + 1,
      title: brainIndex.title,
      noteId: brainIndex.id,
      description: 'Start here for a global overview',
      topic: brainIndex.topic,
    });
  }

  const addedTopics = new Set<string>();
  for (const cluster of clusters) {
    if (steps.length >= MAX_TOUR_STEPS) break;
    const overview = nodes.find((n) => n.type === 'topic-overview' && n.cluster === cluster.id);
    if (overview && !addedTopics.has(overview.topic)) {
      addedTopics.add(overview.topic);
      steps.push({
        order: steps.length + 1,
        title: overview.title,
        noteId: overview.id,
        description: `Overview of ${overview.topic}`,
        topic: overview.topic,
      });
    }
  }

  const addedIds = new Set(steps.map((s) => s.noteId));
  for (const hub of hubs.slice(0, MAX_TOUR_HUBS)) {
    if (steps.length >= MAX_TOUR_STEPS) break;
    if (addedIds.has(hub.id)) continue;
    addedIds.add(hub.id);
    const connections = hub.inbound + hub.outbound;
    steps.push({
      order: steps.length + 1,
      title: hub.title,
      noteId: hub.id,
      description: `Key node: ${hub.title} — connects ${connections} topics`,
      topic: hub.topic,
    });
  }

  const decisions = nodes
    .filter((n) => n.type === 'decision')
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MAX_TOUR_DECISIONS);

  for (const decision of decisions) {
    if (steps.length >= MAX_TOUR_STEPS) break;
    if (addedIds.has(decision.id)) continue;
    addedIds.add(decision.id);
    const node = nodeMap.get(decision.id);
    steps.push({
      order: steps.length + 1,
      title: decision.title,
      noteId: decision.id,
      description: `Critical decision: ${decision.title}`,
      topic: node?.topic ?? decision.topic,
    });
  }

  return steps;
}

function collectHubIdsForPath(hubs: BrainHub[], path: string, nodes: BrainNode[]): string[] {
  const nodeIdsUnderPath = new Set(
    nodes
      .filter((n) => n.topicPath === path || n.topicPath.startsWith(`${path}/`))
      .map((n) => n.id),
  );
  return hubs.filter((h) => nodeIdsUnderPath.has(h.id)).map((h) => h.id);
}

function insertIntoTree(
  root: Map<string, TopicTreeNode>,
  segments: string[],
  fullPath: string,
): void {
  if (segments.length === 0) return;
  const [head, ...rest] = segments;
  const currentPath = fullPath
    .split('/')
    .slice(0, fullPath.split('/').length - rest.length)
    .join('/');

  if (!root.has(head)) {
    root.set(head, { name: head, path: currentPath, noteCount: 0, children: [], hubIds: [] });
  }
  if (rest.length > 0) {
    const childMap = new Map(root.get(head)!.children.map((c) => [c.name, c]));
    insertIntoTree(childMap, rest, fullPath);
    root.get(head)!.children = Array.from(childMap.values());
  }
}

function countNotesInTree(node: TopicTreeNode, nodes: BrainNode[]): TopicTreeNode {
  const noteCount = nodes.filter(
    (n) => n.topicPath === node.path || n.topicPath.startsWith(`${node.path}/`),
  ).length;
  const children = node.children.map((c) => countNotesInTree(c, nodes));
  return { ...node, noteCount, children };
}

export function buildTopicTree(graph: BrainKnowledgeGraph): TopicTreeNode[] {
  const rootMap = new Map<string, TopicTreeNode>();

  for (const node of graph.nodes) {
    const path = node.topicPath === 'unknown' ? 'unknown' : node.topicPath;
    const segments = path.split('/').filter(Boolean);
    if (segments.length > 0) {
      insertIntoTree(rootMap, segments, path);
    }
  }

  return Array.from(rootMap.values())
    .map((root) => countNotesInTree(root, graph.nodes))
    .map((root) => ({
      ...root,
      hubIds: collectHubIdsForPath(graph.hubs, root.path, graph.nodes),
      children: root.children.map((child) => ({
        ...child,
        hubIds: collectHubIdsForPath(graph.hubs, child.path, graph.nodes),
        children: child.children.map((grandchild) => ({
          ...grandchild,
          hubIds: collectHubIdsForPath(graph.hubs, grandchild.path, graph.nodes),
        })),
      })),
    }));
}

export function buildKnowledgeGraph(
  notes: IndexedNote[],
  backlinks: BacklinksIndex,
  clusters: ClusterAssignment,
  pagerank: PageRankResult,
): BrainKnowledgeGraph {
  const now = new Date();
  const activeNotes = notes.filter((n) => {
    if (!n.valid_until) return true;
    const until = new Date(n.valid_until);
    return Number.isNaN(until.getTime()) || until > now;
  });

  const nodes = activeNotes.map((n) => buildNode(n, pagerank.scores, clusters));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const backlinkEdges = buildEdgesFromBacklinks(backlinks, nodeIds);

  // Build structural edges (hierarchy, shared-entity, same-file, temporal)
  const structuralResult = buildStructuralEdges({ notes: activeNotes, nodes }, backlinkEdges);
  // Merge: deduplicate by source+target+type across both sets
  const edgeSeen = new Set<string>();
  const mergedEdges: BrainEdge[] = [];
  for (const e of [...backlinkEdges, ...structuralResult.edges]) {
    const key = `${e.source}::${e.target}::${e.type}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    mergedEdges.push(e);
  }
  const edges = mergedEdges;

  // Precompute degree per node
  const degreeMap = new Map<string, number>();
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  }
  const nodesWithDegree: BrainNode[] = nodes.map((n) => ({
    ...n,
    degree: degreeMap.get(n.id) ?? 0,
  }));

  // Compute deterministic 2-D layout (now benefits from richer edge set)
  const layoutNodes = nodesWithDegree.map((n) => ({
    id: n.id,
    cluster: n.cluster,
    degree: n.degree ?? 0,
  }));
  const layoutEdges = edges.map((e) => ({ source: e.source, target: e.target }));
  const { positions } = computeLayout(layoutNodes, layoutEdges);

  const nodesWithLayout: BrainNode[] = nodesWithDegree.map((n) => {
    const pos = positions.get(n.id);
    return pos ? { ...n, x: pos.x, y: pos.y } : n;
  });

  const clusterObjects = buildClusters(nodesWithLayout, edges);
  const hubs = buildHubs(nodesWithLayout, edges);
  const stats = buildStats(nodesWithLayout, edges, clusterObjects, hubs);
  const layers = buildLayers(nodesWithLayout);
  const tour = buildTour(nodesWithLayout, hubs, clusterObjects);

  const partialGraph: BrainKnowledgeGraph = {
    version: '1.0.0',
    generated: now.toISOString(),
    stats,
    nodes: nodesWithLayout,
    edges,
    clusters: clusterObjects,
    hubs,
    layers,
    tour,
    topicTree: [],
  };

  const withTopicTree = { ...partialGraph, topicTree: buildTopicTree(partialGraph) };
  const withAnalysis = { ...withTopicTree, analysis: analyzeGraph(withTopicTree) };
  const duplicates = findDuplicates(activeNotes);
  return { ...withAnalysis, duplicates };
}

function rebuildStatsForSubset(
  nodes: BrainNode[],
  edges: BrainEdge[],
  clusters: BrainCluster[],
  hubs: BrainHub[],
): BrainKnowledgeGraph['stats'] {
  return buildStats(nodes, edges, clusters, hubs);
}

export function extractSubGraph(
  graph: BrainKnowledgeGraph,
  topic: string,
  opts?: { matchPrefix?: boolean },
): BrainKnowledgeGraph {
  const matchPrefix = opts?.matchPrefix ?? false;
  const coreNodes = matchPrefix
    ? graph.nodes.filter((n) => n.topicPath === topic || n.topicPath.startsWith(`${topic}/`))
    : graph.nodes.filter((n) => n.topic === topic);
  const coreIds = new Set(coreNodes.map((n) => n.id));

  const crossEdges: BrainEdge[] = [];
  const internalEdges: BrainEdge[] = [];
  const externalIds = new Set<string>();

  for (const edge of graph.edges) {
    const srcIn = coreIds.has(edge.source);
    const tgtIn = coreIds.has(edge.target);
    if (srcIn && tgtIn) {
      internalEdges.push(edge);
    } else if (srcIn || tgtIn) {
      crossEdges.push({ ...edge, type: `cross-project:${edge.type}` });
      externalIds.add(srcIn ? edge.target : edge.source);
    }
  }

  const externalNodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const externalNodes: BrainNode[] = Array.from(externalIds)
    .map((id) => externalNodeMap.get(id))
    .filter((n): n is BrainNode => n !== undefined)
    .map((n) => ({
      id: n.id,
      title: n.title,
      topic: n.topic,
      topicPath: n.topicPath,
      type: 'external',
      tags: [],
      importance: 0,
      tldr: '',
      pagerank: n.pagerank,
      cluster: n.cluster,
    }));

  const allNodes = [...coreNodes, ...externalNodes];
  const allEdges = [...internalEdges, ...crossEdges];
  const allIds = new Set(allNodes.map((n) => n.id));
  const safeEdges = allEdges.filter((e) => allIds.has(e.source) && allIds.has(e.target));

  const subClusters = buildClusters(allNodes, safeEdges);
  const subHubs = buildHubs(allNodes, safeEdges);
  const stats = rebuildStatsForSubset(allNodes, safeEdges, subClusters, subHubs);
  const layers = buildLayers(allNodes);
  const tour = buildTour(allNodes, subHubs, subClusters);

  const subGraph: BrainKnowledgeGraph = {
    version: graph.version,
    generated: new Date().toISOString(),
    stats,
    nodes: allNodes,
    edges: safeEdges,
    clusters: subClusters,
    hubs: subHubs,
    layers,
    tour,
    topicTree: [],
  };

  return { ...subGraph, topicTree: buildTopicTree(subGraph) };
}

/**
 * In-process cache for loadKnowledgeGraph(), invalidated by mtime+size —
 * the exact same pattern as backlinks.ts's cachedBacklinks (see its header
 * for the measured rationale: a 44 MB-class JSON re-read+re-parse per call
 * on hot paths). Callers only ever READ the returned object (graph.ts's
 * payload builders, inject-context's topicTree read, site.ts's posMap), so
 * sharing one parsed instance is safe.
 */
let cachedGraph: {
  path: string;
  mtimeMs: number;
  size: number;
  value: BrainKnowledgeGraph;
} | null = null;

export function saveKnowledgeGraph(graph: BrainKnowledgeGraph): string {
  const cfg = getConfig();
  if (!existsSync(cfg.cachePath)) mkdirSync(cfg.cachePath, { recursive: true });
  const path = join(cfg.cachePath, GRAPH_FILENAME);
  writeFileSync(path, JSON.stringify(graph, null, 2), 'utf8');
  // Seed the cache with what we just wrote — a save-then-load flow (common
  // right after `lazybrain graph`) is served from memory instead of
  // re-parsing the file we just serialized.
  try {
    const stats = statSync(path);
    cachedGraph = { path, mtimeMs: stats.mtimeMs, size: stats.size, value: graph };
  } catch {
    cachedGraph = null;
  }
  return path;
}

export function loadKnowledgeGraph(): BrainKnowledgeGraph | null {
  const cfg = getConfig();
  const path = join(cfg.cachePath, GRAPH_FILENAME);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return null;
  }
  if (
    cachedGraph &&
    cachedGraph.path === path &&
    cachedGraph.mtimeMs === stats.mtimeMs &&
    cachedGraph.size === stats.size
  ) {
    return cachedGraph.value;
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as BrainKnowledgeGraph;
    if (!data.version || !data.nodes || !data.edges) return null;
    cachedGraph = { path, mtimeMs: stats.mtimeMs, size: stats.size, value: data };
    return data;
  } catch {
    cachedGraph = null;
    return null;
  }
}

/** Test-only: reset the in-process graph cache between tests. */
export function resetKnowledgeGraphCacheForTests(): void {
  cachedGraph = null;
}

export function buildKnowledgeGraphFromIndex(
  backlinks: BacklinksIndex,
  clusters: ClusterAssignment,
  pagerank: PageRankResult,
): BrainKnowledgeGraph {
  const notes = listAll({ includeExpired: false });
  return buildKnowledgeGraph(notes, backlinks, clusters, pagerank);
}

export function edgesForNote(
  graph: BrainKnowledgeGraph,
  noteId: string,
): { outgoing: BrainEdge[]; incoming: BrainEdge[] } {
  const outgoing = graph.edges.filter((e) => e.source === noteId);
  const incoming = graph.edges.filter((e) => e.target === noteId);
  return { outgoing, incoming };
}

export function neighbourIds(graph: BrainKnowledgeGraph, noteId: string): string[] {
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source === noteId) seen.add(edge.target);
    if (edge.target === noteId) seen.add(edge.source);
  }
  return Array.from(seen);
}

export function clusterForNote(
  graph: BrainKnowledgeGraph,
  noteId: string,
): BrainCluster | undefined {
  const node = graph.nodes.find((n) => n.id === noteId);
  if (!node) return undefined;
  return graph.clusters.find((c) => c.id === node.cluster);
}

// Re-export BacklinkEntry so callers building edges externally don't need to
// import from backlinks.ts directly.
export type { BacklinkEntry };
