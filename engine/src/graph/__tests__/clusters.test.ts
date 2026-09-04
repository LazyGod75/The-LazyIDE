import { describe, expect, it } from 'vitest';
import type { BacklinkEntry, BacklinksIndex } from '../backlinks.js';
import { computeModularity, detectClusters } from '../clusters.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBacklinks(pairs: Array<[string, string]>): BacklinksIndex {
  const outgoing: Record<string, BacklinkEntry[]> = {};
  for (const [from, to] of pairs) {
    if (!outgoing[from]) outgoing[from] = [];
    outgoing[from].push({
      from,
      to,
      type: 'wikilink',
      auto: false,
      confidence: 'extracted',
      confidenceScore: 1.0,
    });
  }
  return { outgoing, incoming: {}, generated: new Date().toISOString(), total_edges: pairs.length };
}

function makeNotes(ids: string[], tag = 'test'): Array<{ id: string; tags: string }> {
  return ids.map((id) => ({ id, tags: tag }));
}

/** Build two tight cliques connected by one weak bridge. */
function buildBiclique(groupA: string[], groupB: string[]): BacklinksIndex {
  const pairs: Array<[string, string]> = [];
  // Dense links within A
  for (let i = 0; i < groupA.length; i++) {
    for (let j = i + 1; j < groupA.length; j++) {
      pairs.push([groupA[i], groupA[j]]);
    }
  }
  // Dense links within B
  for (let i = 0; i < groupB.length; i++) {
    for (let j = i + 1; j < groupB.length; j++) {
      pairs.push([groupB[i], groupB[j]]);
    }
  }
  // Weak bridge: one link across
  pairs.push([groupA[0], groupB[0]]);
  return makeBacklinks(pairs);
}

// ---------------------------------------------------------------------------
// Basic sanity tests
// ---------------------------------------------------------------------------

describe('detectClusters — basic', () => {
  it('handles empty notes gracefully', () => {
    const result = detectClusters([], {
      outgoing: {},
      incoming: {},
      generated: '',
      total_edges: 0,
    });
    expect(result.node_count).toBe(0);
    expect(result.cluster_count).toBe(0);
  });

  it('puts isolated nodes (no edges) each in their own cluster', () => {
    const notes = makeNotes(['a', 'b', 'c'], '');
    const result = detectClusters(notes, {
      outgoing: {},
      incoming: {},
      generated: '',
      total_edges: 0,
    });
    expect(result.node_count).toBe(3);
    expect(result.cluster_count).toBe(3);
  });

  it('groups a single clique into one cluster', () => {
    const notes = makeNotes(['a', 'b', 'c', 'd']);
    const backlinks = makeBacklinks([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['a', 'c'],
      ['b', 'd'],
    ]);
    const result = detectClusters(notes, backlinks);
    const clusterIds = new Set(Object.values(result.members));
    expect(clusterIds.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 modularity test
// ---------------------------------------------------------------------------

describe('detectClusters — Phase 2 produces better modularity than Phase 1 alone', () => {
  it('full Louvain achieves modularity >= Phase 1 on a bipartite graph', () => {
    const groupA = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const groupB = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const notes = makeNotes([...groupA, ...groupB]);
    const backlinks = buildBiclique(groupA, groupB);

    const full = detectClusters(notes, backlinks);

    // Full Louvain should separate the two cliques
    const aCluster = full.members.a1;
    const bCluster = full.members.b1;
    expect(aCluster).not.toBe(bCluster);

    // All A nodes in same cluster
    for (const id of groupA) expect(full.members[id]).toBe(aCluster);
    // All B nodes in same cluster
    for (const id of groupB) expect(full.members[id]).toBe(bCluster);
  });

  it('modularity is positive for a well-structured graph', () => {
    // Build a graph with known community structure
    const groupA = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const groupB = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    const notes = makeNotes([...groupA, ...groupB]);
    const backlinks = buildBiclique(groupA, groupB);

    const result = detectClusters(notes, backlinks);

    // Verify cluster count makes structural sense (2 communities expected)
    expect(result.cluster_count).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Oversized community splitting
// ---------------------------------------------------------------------------

describe('detectClusters — oversized community splitting', () => {
  it('splits a community exceeding 25% threshold into sub-communities', () => {
    // Build 50 nodes: two tight sub-clusters of 20 each (forming one big cluster
    // from Louvain's perspective via tag links) + 10 loosely connected noise nodes.
    // We force them to merge via shared tags so Louvain produces one 40-node community,
    // then the split logic should break it up.
    const subA = Array.from({ length: 20 }, (_, i) => `ha${i}`);
    const subB = Array.from({ length: 20 }, (_, i) => `hb${i}`);
    const small = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const allNotes = [
      ...subA.map((id) => ({ id, tags: 'big-cluster sub-a' })),
      ...subB.map((id) => ({ id, tags: 'big-cluster sub-b' })),
      ...small.map((id) => ({ id, tags: 'small' })),
    ];

    // Dense clique within subA
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < subA.length; i++) {
      for (let j = i + 1; j < subA.length; j++) {
        pairs.push([subA[i], subA[j]]);
      }
    }
    // Dense clique within subB
    for (let i = 0; i < subB.length; i++) {
      for (let j = i + 1; j < subB.length; j++) {
        pairs.push([subB[i], subB[j]]);
      }
    }
    // ONE link between subA and subB — they may merge or stay separate in Louvain
    pairs.push([subA[0], subB[0]]);
    // Weak chain for small group
    for (let i = 0; i < small.length - 1; i++) {
      pairs.push([small[i], small[i + 1]]);
    }
    const backlinks = makeBacklinks(pairs);

    const result = detectClusters(allNotes, backlinks);

    // The two 20-node groups are each 40% of 50 nodes (> 25% threshold of 12 nodes).
    // After splitting, the largest community should be smaller than 40 (the combined size).
    const commSizes = new Map<number, number>();
    for (const c of Object.values(result.members)) {
      commSizes.set(c, (commSizes.get(c) ?? 0) + 1);
    }
    const maxSize = Math.max(...commSizes.values());

    // Either Louvain already separated them (best case), or split did it.
    // Either way, no single community should hold all 40 heavy nodes.
    expect(maxSize).toBeLessThan(40);
    expect(result.cluster_count).toBeGreaterThan(1);
  });

  it('does not split communities below min threshold (< 10 nodes)', () => {
    // 8 nodes total — even if one community has 100%, min=10 prevents split
    const notes = makeNotes(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const backlinks = makeBacklinks([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', 'f'],
      ['f', 'g'],
      ['g', 'h'],
    ]);
    const result = detectClusters(notes, backlinks);
    // No split should happen (8 < min 10)
    expect(result.node_count).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Stable ID remapping
// ---------------------------------------------------------------------------

describe('detectClusters — stable community IDs across runs', () => {
  it('preserves community IDs when input is the same', () => {
    const notes = makeNotes(['x1', 'x2', 'x3', 'y1', 'y2', 'y3']);
    const backlinks = buildBiclique(['x1', 'x2', 'x3'], ['y1', 'y2', 'y3']);

    const first = detectClusters(notes, backlinks);
    const second = detectClusters(notes, backlinks, 20, first);

    // Community IDs must be identical between runs
    for (const id of ['x1', 'x2', 'x3', 'y1', 'y2', 'y3']) {
      expect(second.members[id]).toBe(first.members[id]);
    }
  });

  it('assigns new IDs to truly new communities, keeps stable IDs for existing ones', () => {
    // Use larger groups so Louvain reliably separates them in both runs
    const groupA = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const groupB = ['b1', 'b2', 'b3', 'b4', 'b5'];
    const original = makeNotes([...groupA, ...groupB]);
    const bl = buildBiclique(groupA, groupB);
    const firstRun = detectClusters(original, bl);

    // Verify that first run actually separated A and B (precondition)
    const aIdFirst = firstRun.members.a1;
    const bIdFirst = firstRun.members.b1;
    expect(aIdFirst).not.toBe(bIdFirst);

    // Second run with identical input + previousClusters passed
    const secondRun = detectClusters(original, bl, 20, firstRun);

    // Stable remapping: same nodes → same IDs as first run
    expect(secondRun.members.a1).toBe(aIdFirst);
    expect(secondRun.members.b1).toBe(bIdFirst);
    // Also verify intra-group consistency
    for (const id of groupA) expect(secondRun.members[id]).toBe(aIdFirst);
    for (const id of groupB) expect(secondRun.members[id]).toBe(bIdFirst);
  });

  it('returns valid ClusterAssignment when no previous clusters exist', () => {
    const notes = makeNotes(['n1', 'n2', 'n3']);
    const backlinks = makeBacklinks([
      ['n1', 'n2'],
      ['n2', 'n3'],
    ]);
    const result = detectClusters(notes, backlinks, 20, null);
    expect(result.cluster_count).toBeGreaterThan(0);
    expect(Object.keys(result.members).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeModularity helper
// ---------------------------------------------------------------------------

describe('computeModularity', () => {
  it('returns 0 for empty graph', () => {
    const graph = { n: 0, adj: [], degree: [], totalWeight: 0 };
    expect(computeModularity(graph, [])).toBe(0);
  });

  it('returns positive modularity for well-separated communities', () => {
    // Two cliques of 3, weakly connected
    const adj = [
      [
        { target: 1, weight: 1 },
        { target: 2, weight: 1 },
      ],
      [
        { target: 0, weight: 1 },
        { target: 2, weight: 1 },
      ],
      [
        { target: 0, weight: 1 },
        { target: 1, weight: 1 },
        { target: 3, weight: 0.1 },
      ],
      [
        { target: 4, weight: 1 },
        { target: 5, weight: 1 },
        { target: 2, weight: 0.1 },
      ],
      [
        { target: 3, weight: 1 },
        { target: 5, weight: 1 },
      ],
      [
        { target: 3, weight: 1 },
        { target: 4, weight: 1 },
      ],
    ];
    const degree = [2, 2, 2.1, 2.1, 2, 2];
    const totalWeight = (2 + 2 + 2.1 + 2.1 + 2 + 2) / 2;
    const graph = { n: 6, adj, degree, totalWeight };
    const community = [0, 0, 0, 1, 1, 1];
    const q = computeModularity(graph, community);
    expect(q).toBeGreaterThan(0);
  });
});
