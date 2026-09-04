import { describe, expect, it } from 'vitest';
import { buildGlobalGraph } from '../global-graph.js';
import type { HierarchyNode, HierarchyTree } from '../hierarchy.js';
import type { BrainEdge, BrainKnowledgeGraph, BrainNode } from '../knowledge-graph.js';

// ---------------------------------------------------------------------------
// Synthetic data builders
// ---------------------------------------------------------------------------

function makeNode(id: string, topic: string, opts?: Partial<BrainNode>): BrainNode {
  return {
    id,
    title: opts?.title ?? id,
    type: opts?.type ?? 'semantic',
    topic,
    topicPath: topic,
    tags: opts?.tags ?? [],
    importance: opts?.importance ?? 0.5,
    tldr: '',
    pagerank: opts?.pagerank ?? 0.1,
    cluster: topic,
    validUntil: undefined,
    ...opts,
  };
}

function makeEdge(source: string, target: string, opts?: Partial<BrainEdge>): BrainEdge {
  return {
    source,
    target,
    type: opts?.type ?? 'references',
    strength: opts?.strength ?? 1.0,
    confidence: opts?.confidence ?? 'extracted',
    confidenceScore: opts?.confidenceScore ?? 0.9,
  };
}

function makeGraph(nodes: BrainNode[], edges: BrainEdge[]): BrainKnowledgeGraph {
  return {
    version: '1.0.0',
    generated: new Date().toISOString(),
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      clusters: 0,
      hubs: 0,
      avgImportance: 0.5,
      topTypes: {},
      topTopics: {},
    },
    nodes,
    edges,
    clusters: [],
    hubs: [],
    layers: [],
    tour: [],
    topicTree: [],
  };
}

function makeEmptyHierarchy(): HierarchyTree {
  const root: HierarchyNode = {
    id: '_root',
    level: 0,
    segment: '_root',
    parent: null,
    children: [],
    noteIds: [],
    conversationCount: 0,
  };
  return {
    root,
    byId: new Map([['_root', root]]),
    projects: [],
    totalNodes: 1,
  };
}

function makeHierarchy(projectModules: Record<string, string[]>): HierarchyTree {
  const byId = new Map<string, HierarchyNode>();
  const root: HierarchyNode = {
    id: '_root',
    level: 0,
    segment: '_root',
    parent: null,
    children: [],
    noteIds: [],
    conversationCount: 0,
  };
  byId.set('_root', root);

  const projects: string[] = [];

  for (const [project, modules] of Object.entries(projectModules)) {
    projects.push(project);

    const projectNode: HierarchyNode = {
      id: project,
      level: 1,
      segment: project,
      parent: '_root',
      children: modules.map((m) => `${project}/${m}`),
      noteIds: [],
      conversationCount: modules.length,
    };
    byId.set(project, projectNode);
    root.children.push(project);

    for (const module of modules) {
      const moduleId = `${project}/${module}`;
      const moduleNode: HierarchyNode = {
        id: moduleId,
        level: 2,
        segment: module,
        parent: project,
        children: [],
        noteIds: [],
        conversationCount: 1,
      };
      byId.set(moduleId, moduleNode);
    }
  }

  return {
    root,
    byId,
    projects,
    totalNodes: byId.size,
  };
}

// ---------------------------------------------------------------------------
// Tests: buildGlobalGraph
// ---------------------------------------------------------------------------

describe('buildGlobalGraph', () => {
  // ------------------------------------------------------------------
  // Basic structure
  // ------------------------------------------------------------------
  it('returns a valid GlobalGraph structure', () => {
    const graph = makeGraph([], []);
    const hierarchy = makeEmptyHierarchy();
    const result = buildGlobalGraph(graph, hierarchy);

    expect(result.version).toBe('1.0.0');
    expect(result.generated).toBeTruthy();
    expect(Array.isArray(result.projects)).toBe(true);
    expect(Array.isArray(result.crossEdges)).toBe(true);
    expect(Array.isArray(result.sharedEntities)).toBe(true);
    expect(result.stats).toBeDefined();
    expect(result.stats.totalProjects).toBe(0);
    expect(result.stats.totalCrossEdges).toBe(0);
  });

  // ------------------------------------------------------------------
  // Project extraction
  // ------------------------------------------------------------------
  it('extracts distinct project names from nodes', () => {
    const nodes = [makeNode('a1', 'acme'), makeNode('a2', 'acme'), makeNode('b1', 'tradelab')];
    const graph = makeGraph(nodes, []);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    expect(result.projects).toContain('acme');
    expect(result.projects).toContain('tradelab');
    expect(result.projects).toHaveLength(2);
  });

  // ------------------------------------------------------------------
  // Direct cross-project edges (from graph edges)
  // ------------------------------------------------------------------
  it('detects direct cross-project edges', () => {
    const nodes = [makeNode('a1', 'acme'), makeNode('b1', 'tradelab')];
    const edges = [makeEdge('a1', 'b1')];
    const graph = makeGraph(nodes, edges);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    const crossEdges = result.crossEdges.filter((e) => e.type === 'cross-references');
    expect(crossEdges).toHaveLength(1);
    expect(crossEdges[0].sourceProject).toBe('acme');
    expect(crossEdges[0].targetProject).toBe('tradelab');
  });

  it('does NOT create cross-edges for edges within the same project', () => {
    const nodes = [makeNode('a1', 'acme'), makeNode('a2', 'acme')];
    const edges = [makeEdge('a1', 'a2')];
    const graph = makeGraph(nodes, edges);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    const crossEdges = result.crossEdges.filter((e) => e.type === 'cross-references');
    expect(crossEdges).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Shared entity detection
  // ------------------------------------------------------------------
  it('detects shared entities from common tags', () => {
    const nodes = [
      makeNode('a1', 'acme', { tags: ['auth', 'jwt'] }),
      makeNode('b1', 'tradelab', { tags: ['auth', 'oauth'] }),
    ];
    const graph = makeGraph(nodes, []);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    const authEntity = result.sharedEntities.find((e) => e.name === 'auth');
    expect(authEntity).toBeDefined();
    expect(authEntity!.projects).toContain('acme');
    expect(authEntity!.projects).toContain('tradelab');
  });

  it('does NOT include entities found in only one project', () => {
    const nodes = [
      makeNode('a1', 'acme', { tags: ['acme-only'] }),
      makeNode('b1', 'tradelab', { tags: ['tradelab-only'] }),
    ];
    const graph = makeGraph(nodes, []);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    const exclusive = result.sharedEntities.filter(
      (e) => e.name === 'acme-only' || e.name === 'tradelab-only',
    );
    expect(exclusive).toHaveLength(0);
  });

  it('finds shared entities from node titles', () => {
    const nodes = [
      makeNode('a1', 'acme', { title: 'Authentication strategy for acme' }),
      makeNode('b1', 'tradelab', { title: 'Authentication layer in tradelab' }),
    ];
    const graph = makeGraph(nodes, []);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    // 'authentication' >= 4 chars should be picked from title words
    const authEntity = result.sharedEntities.find((e) => e.name === 'authentication');
    expect(authEntity).toBeDefined();
    expect(authEntity!.projects).toHaveLength(2);
  });

  // ------------------------------------------------------------------
  // Co-mentioned edges
  // ------------------------------------------------------------------
  it('creates co-mentioned edges for entities shared between projects', () => {
    const nodes = [
      makeNode('a1', 'acme', { tags: ['shared-lib'], importance: 0.8 }),
      makeNode('b1', 'tradelab', { tags: ['shared-lib'], importance: 0.7 }),
    ];
    const graph = makeGraph(nodes, []);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    const coMentioned = result.crossEdges.filter((e) => e.type === 'co-mentioned');
    expect(coMentioned.length).toBeGreaterThan(0);

    const edge = coMentioned[0];
    expect(edge.confidence).toBe('inferred');
    expect(edge.evidence).toContain('shared-lib');
  });

  // ------------------------------------------------------------------
  // Shared-code edges from hierarchy
  // ------------------------------------------------------------------
  it('creates shared-code edges when projects share module segments', () => {
    const nodes = [
      makeNode('a1', 'acme', { pagerank: 0.9 }),
      makeNode('b1', 'tradelab', { pagerank: 0.8 }),
    ];
    const graph = makeGraph(nodes, []);
    // Both projects have an 'auth' module
    const hierarchy = makeHierarchy({
      acme: ['auth', 'notifications'],
      tradelab: ['auth', 'orders'],
    });
    const result = buildGlobalGraph(graph, hierarchy);

    const sharedCode = result.crossEdges.filter((e) => e.type === 'shared-code');
    expect(sharedCode).toHaveLength(1);
    expect(sharedCode[0].evidence).toContain('auth');
    expect(sharedCode[0].confidence).toBe('inferred');
  });

  it('does NOT create shared-code edges when projects have no common modules', () => {
    const nodes = [
      makeNode('a1', 'acme', { pagerank: 0.9 }),
      makeNode('b1', 'tradelab', { pagerank: 0.8 }),
    ];
    const graph = makeGraph(nodes, []);
    const hierarchy = makeHierarchy({
      acme: ['ui', 'push'],
      tradelab: ['orders', 'portfolio'],
    });
    const result = buildGlobalGraph(graph, hierarchy);

    const sharedCode = result.crossEdges.filter((e) => e.type === 'shared-code');
    expect(sharedCode).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Stats: densest project pair
  // ------------------------------------------------------------------
  it('identifies the densest project pair', () => {
    const nodes = [
      makeNode('a1', 'acme'),
      makeNode('a2', 'acme'),
      makeNode('b1', 'tradelab'),
      makeNode('c1', 'marketing'),
    ];
    // Two edges acme <-> tradelab, one acme <-> marketing
    const edges = [makeEdge('a1', 'b1'), makeEdge('a2', 'b1'), makeEdge('a1', 'c1')];
    const graph = makeGraph(nodes, edges);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    const pair = result.stats.densestPair;
    const projects = [pair.projectA, pair.projectB].sort();
    expect(projects).toContain('acme');
    expect(projects).toContain('tradelab');
    expect(pair.edgeCount).toBeGreaterThanOrEqual(2);
  });

  // ------------------------------------------------------------------
  // Deduplication
  // ------------------------------------------------------------------
  it('deduplicates cross-edges with same source/target/type', () => {
    const nodes = [
      makeNode('a1', 'acme', { tags: ['jwt'] }),
      makeNode('b1', 'tradelab', { tags: ['jwt'] }),
    ];
    // Direct edge AND shared entity both pointing to same nodes
    const edges = [makeEdge('a1', 'b1')];
    const graph = makeGraph(nodes, edges);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    // No duplicates: same source+target+type should appear once
    const dedupSet = new Set(result.crossEdges.map((e) => `${e.source}::${e.target}::${e.type}`));
    expect(dedupSet.size).toBe(result.crossEdges.length);
  });

  // ------------------------------------------------------------------
  // Stats totals
  // ------------------------------------------------------------------
  it('stats.totalCrossEdges matches crossEdges.length', () => {
    const nodes = [
      makeNode('a1', 'acme', { tags: ['auth'] }),
      makeNode('b1', 'tradelab', { tags: ['auth'] }),
    ];
    const graph = makeGraph(nodes, [makeEdge('a1', 'b1')]);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    expect(result.stats.totalCrossEdges).toBe(result.crossEdges.length);
  });

  it('stats.totalProjects matches projects.length', () => {
    const nodes = [makeNode('a1', 'acme'), makeNode('b1', 'tradelab'), makeNode('c1', 'marketing')];
    const graph = makeGraph(nodes, []);
    const result = buildGlobalGraph(graph, makeEmptyHierarchy());

    expect(result.stats.totalProjects).toBe(result.projects.length);
    expect(result.stats.totalProjects).toBe(3);
  });
});
