/**
 * Unit tests for the /_api/graph-layout.json endpoint logic.
 *
 * Tests:
 * 1. Fixture with brain-graph.json present + positions + structural edges
 *    → payload carries them, hasPositions=true, edge count matches.
 * 2. No brain-graph.json → backlinks fallback, hasPositions=false.
 * 3. 70% positioned, 30% new unpositioned → hasPositions=true and unpositioned
 *    nodes get cluster-centroid placements (no node left at 0,0 sentinel).
 * 4. Determinism: two calls to buildSlimLayoutFromPersistedGraph are identical.
 */

import { describe, expect, it } from 'vitest';
import type { BrainEdge, BrainKnowledgeGraph, BrainNode } from '../../graph/knowledge-graph.js';
import { buildSlimLayout, buildSlimLayoutFromPersistedGraph } from '../routes/graph.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  opts: {
    x?: number;
    y?: number;
    degree?: number;
    type?: string;
    topic?: string;
    cluster?: string;
  } = {},
): BrainNode {
  return {
    id,
    title: `Note ${id}`,
    type: opts.type ?? 'note',
    topic: opts.topic ?? 'project-a',
    topicPath: opts.topic ?? 'project-a',
    tags: [],
    importance: 0.5,
    tldr: '',
    pagerank: 0.1,
    cluster: opts.cluster ?? 'cluster-a',
    x: opts.x,
    y: opts.y,
    degree: opts.degree ?? 0,
  };
}

function makeEdge(source: string, target: string, type = 'mentions'): BrainEdge {
  return {
    source,
    target,
    type,
    strength: 0.8,
    confidence: 'extracted',
    confidenceScore: 1.0,
  };
}

function makeGraph(nodes: BrainNode[], edges: BrainEdge[]): BrainKnowledgeGraph {
  return {
    version: '1.0.0',
    generated: '2026-06-01T00:00:00Z',
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      clusters: 1,
      hubs: 1,
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

// ---------------------------------------------------------------------------
// Test 1: persisted graph with positions + structural edges
// ---------------------------------------------------------------------------

describe('buildSlimLayoutFromPersistedGraph — full positions + structural edges', () => {
  const nodes = [
    makeNode('n1', { x: 100, y: 200, degree: 5 }),
    makeNode('n2', { x: -50, y: 300, degree: 3 }),
    makeNode('n3', { x: 400, y: -100, degree: 7 }),
  ];
  const edges = [makeEdge('n1', 'n2'), makeEdge('n2', 'n3'), makeEdge('n1', 'n3')];
  const graph = makeGraph(nodes, edges);

  it('has hasPositions=true', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.hasPositions).toBe(true);
  });

  it('carries precomputed x/y positions from the persisted graph', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    const n1 = result.nodes.find((n) => n.id === 'n1');
    expect(n1?.x).toBe(100);
    expect(n1?.y).toBe(200);
    const n3 = result.nodes.find((n) => n.id === 'n3');
    expect(n3?.x).toBe(400);
    expect(n3?.y).toBe(-100);
  });

  it('edge count matches the fixture edges', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.edges.length).toBe(edges.length);
  });

  it('edges are integer index pairs within bounds', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    for (const [si, ti] of result.edges) {
      expect(si).toBeGreaterThanOrEqual(0);
      expect(si).toBeLessThan(result.nodes.length);
      expect(ti).toBeGreaterThanOrEqual(0);
      expect(ti).toBeLessThan(result.nodes.length);
    }
  });

  it('includes generatedAt and nodeCountAtBuild metadata', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.generatedAt).toBe('2026-06-01T00:00:00Z');
    expect(result.nodeCountAtBuild).toBe(3);
  });

  it('node count matches fixture', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.nodes.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 2: fallback — no brain-graph.json (buildSlimLayout with backlinks only)
// ---------------------------------------------------------------------------

describe('buildSlimLayout fallback — backlinks-only (no brain-graph.json)', () => {
  it('hasPositions=false when no nodes have coordinates', () => {
    // buildSlimLayout is the fallback path for the backlinks-only payload
    const payload = {
      nodes: [
        { id: 'b1', title: 'B1', type: 'note', topic: 'project-b', importance: 0.5 },
        { id: 'b2', title: 'B2', type: 'note', topic: 'project-b', importance: 0.5 },
      ],
      edges: [{ from: 'b1', to: 'b2', type: 'mentions', auto: false }],
    };
    const result = buildSlimLayout(payload);
    expect(result.hasPositions).toBe(false);
  });

  it('edge count matches backlinks-only payload', () => {
    const payload = {
      nodes: [
        { id: 'c1', title: 'C1', type: 'note', topic: 'p', importance: 0.5 },
        { id: 'c2', title: 'C2', type: 'note', topic: 'p', importance: 0.5 },
        { id: 'c3', title: 'C3', type: 'note', topic: 'p', importance: 0.5 },
      ],
      edges: [
        { from: 'c1', to: 'c2', type: 'mentions', auto: false },
        { from: 'c2', to: 'c3', type: 'mentions', auto: false },
      ],
    };
    const result = buildSlimLayout(payload);
    expect(result.edges.length).toBe(2);
  });

  it('returns nodes with x=0, y=0 (fallback positions)', () => {
    const payload = {
      nodes: [{ id: 'd1', title: 'D1', type: 'note', topic: 'p', importance: 0.5 }],
      edges: [],
    };
    const result = buildSlimLayout(payload);
    expect(result.nodes[0].x).toBe(0);
    expect(result.nodes[0].y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: partial positions — 70% positioned, 30% new unpositioned
// ---------------------------------------------------------------------------

describe('buildSlimLayoutFromPersistedGraph — partial positions (70/30 split)', () => {
  // 7 positioned nodes + 3 unpositioned = 70% threshold met
  const positionedNodes = [
    makeNode('p1', { x: 100, y: 200, degree: 4, topic: 'proj-a' }),
    makeNode('p2', { x: -80, y: 150, degree: 2, topic: 'proj-a' }),
    makeNode('p3', { x: 200, y: -50, degree: 6, topic: 'proj-a' }),
    makeNode('p4', { x: -200, y: -120, degree: 3, topic: 'proj-b' }),
    makeNode('p5', { x: 300, y: 100, degree: 5, topic: 'proj-b' }),
    makeNode('p6', { x: 50, y: 400, degree: 1, topic: 'proj-b' }),
    makeNode('p7', { x: -100, y: 300, degree: 2, topic: 'proj-a' }),
  ];
  // 3 unpositioned nodes (no x/y = added after last graph run)
  const unpositionedNodes = [
    makeNode('u1', { degree: 0, topic: 'proj-a' }),
    makeNode('u2', { degree: 0, topic: 'proj-a' }),
    makeNode('u3', { degree: 0, topic: 'proj-b' }),
  ];
  const allNodes = [...positionedNodes, ...unpositionedNodes];
  const edges = positionedNodes.map((n, i) =>
    makeEdge(n.id, positionedNodes[(i + 1) % positionedNodes.length].id),
  );
  const graph = makeGraph(allNodes, edges);

  it('hasPositions=true because >= 60% are positioned', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.hasPositions).toBe(true);
  });

  it('no unpositioned node remains at exactly (0, 0) sentinel', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    const unpositionedIds = new Set(['u1', 'u2', 'u3']);
    for (const n of result.nodes) {
      if (unpositionedIds.has(n.id)) {
        // After cluster-centroid placement, neither x nor y should be exactly 0
        // (the centroid itself may occasionally be near 0, so check at least
        //  one of x or y differs from the zero-sentinel pair)
        const atZeroSentinel = n.x === 0 && n.y === 0;
        expect(atZeroSentinel).toBe(false);
      }
    }
  });

  it('positioned nodes retain their original x/y from brain-graph.json', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    const p1 = result.nodes.find((n) => n.id === 'p1');
    expect(p1?.x).toBe(100);
    expect(p1?.y).toBe(200);
    const p4 = result.nodes.find((n) => n.id === 'p4');
    expect(p4?.x).toBe(-200);
    expect(p4?.y).toBe(-120);
  });

  it('total node count is 10 (7 positioned + 3 new)', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.nodes.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Test 4: determinism — two calls produce identical output
// ---------------------------------------------------------------------------

describe('buildSlimLayoutFromPersistedGraph — determinism', () => {
  const nodes = [
    makeNode('d1', { x: 50, y: 60, degree: 3, topic: 'grp' }),
    makeNode('d2', { x: -30, y: 90, degree: 1, topic: 'grp' }),
    // Unpositioned
    makeNode('d3', { degree: 0, topic: 'grp' }),
    makeNode('d4', { degree: 0, topic: 'grp' }),
  ];
  const edges = [makeEdge('d1', 'd2'), makeEdge('d2', 'd1')];
  const graph = makeGraph(nodes, edges);

  it('produces identical payload on two consecutive calls', () => {
    const result1 = buildSlimLayoutFromPersistedGraph(graph);
    const result2 = buildSlimLayoutFromPersistedGraph(graph);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  it('unpositioned node positions are identical across calls', () => {
    const result1 = buildSlimLayoutFromPersistedGraph(graph);
    const result2 = buildSlimLayoutFromPersistedGraph(graph);
    const d3a = result1.nodes.find((n) => n.id === 'd3');
    const d3b = result2.nodes.find((n) => n.id === 'd3');
    expect(d3a?.x).toBe(d3b?.x);
    expect(d3a?.y).toBe(d3b?.y);
  });
});

// ---------------------------------------------------------------------------
// Test 5: below threshold — 50% positioned should still yield hasPositions=false
// ---------------------------------------------------------------------------

describe('buildSlimLayoutFromPersistedGraph — below 60% threshold', () => {
  const nodes = [
    makeNode('t1', { x: 10, y: 20, degree: 1, topic: 'g' }),
    makeNode('t2', { x: -10, y: 30, degree: 1, topic: 'g' }),
    makeNode('t3', { degree: 0, topic: 'g' }),
    makeNode('t4', { degree: 0, topic: 'g' }),
  ];
  const edges: BrainEdge[] = [];
  const graph = makeGraph(nodes, edges);

  it('hasPositions=false when only 50% are positioned', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    // 2/4 = 50% < 60% threshold
    expect(result.hasPositions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: large structural edge count preserved
// ---------------------------------------------------------------------------

describe('buildSlimLayoutFromPersistedGraph — large edge set', () => {
  // Simulate a brain with many structural edges
  const nodeCount = 50;
  const nodes = Array.from({ length: nodeCount }, (_, i) =>
    makeNode(`sn${i}`, { x: i * 10, y: i * 5, degree: 2 }),
  );

  // ~150 structural edges (every node → next 3)
  const edges: BrainEdge[] = [];
  for (let i = 0; i < nodeCount; i++) {
    for (let j = 1; j <= 3; j++) {
      const target = (i + j) % nodeCount;
      edges.push(makeEdge(`sn${i}`, `sn${target}`, 'hierarchy'));
    }
  }
  const graph = makeGraph(nodes, edges);

  it('edge count in payload matches the full structural edge set', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.edges.length).toBe(edges.length);
  });

  it('hasPositions=true for 100% positioned graph', () => {
    const result = buildSlimLayoutFromPersistedGraph(graph);
    expect(result.hasPositions).toBe(true);
  });
});
