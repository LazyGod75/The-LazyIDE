import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../util/config.js';
import type { BacklinksIndex } from './backlinks.js';

export interface ClusterAssignment {
  node_count: number;
  cluster_count: number;
  // id → cluster index
  members: Record<string, number>;
  // cluster index → top tags / label
  labels: Record<number, string>;
  generated: string;
}

const CLUSTERS_FILENAME = 'clusters.json';

// ---------------------------------------------------------------------------
// Internal graph types for Louvain
// ---------------------------------------------------------------------------

interface Edge {
  target: number;
  weight: number;
}

interface LouvainGraph {
  n: number;
  adj: Edge[][];
  degree: number[];
  totalWeight: number;
}

// ---------------------------------------------------------------------------
// Louvain Phase 1: local greedy moves
// Returns new community[] array. Mutates sumTot/sumIn in place.
// ---------------------------------------------------------------------------

function louvainPhase1(
  graph: LouvainGraph,
  community: number[],
  sumTot: Float64Array,
  sumIn: Float64Array,
  maxIters: number,
): boolean {
  const { n, adj, degree } = graph;
  const m = graph.totalWeight;
  let improved = false;
  let iter = 0;
  let changed = true;

  while (changed && iter < maxIters) {
    changed = false;
    iter++;

    // Deterministic shuffle seeded by iteration
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const seed = (iter * 1103515245 + i + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }

    for (const i of order) {
      const currentComm = community[i];
      const ki = degree[i];

      // Compute k_i_in for each neighbouring community
      const neighborComms = new Map<number, number>();
      for (const edge of adj[i]) {
        const nc = community[edge.target];
        neighborComms.set(nc, (neighborComms.get(nc) ?? 0) + edge.weight);
      }

      const kiInCurrent = neighborComms.get(currentComm) ?? 0;

      // Remove node from current community
      sumTot[currentComm] -= ki;
      sumIn[currentComm] -= 2 * kiInCurrent;

      // Find best community (highest modularity gain)
      let bestComm = currentComm;
      let bestDeltaQ = 0;

      for (const [comm, kiIn] of neighborComms) {
        const deltaQ = kiIn / m - (sumTot[comm] * ki) / (2 * m * m);
        if (deltaQ > bestDeltaQ) {
          bestDeltaQ = deltaQ;
          bestComm = comm;
        }
      }

      // Place node in best community
      community[i] = bestComm;
      const kiInBest = neighborComms.get(bestComm) ?? 0;
      sumTot[bestComm] += ki;
      sumIn[bestComm] += 2 * kiInBest;

      if (bestComm !== currentComm) {
        changed = true;
        improved = true;
      }
    }
  }

  return improved;
}

// ---------------------------------------------------------------------------
// Build super-graph for Phase 2: each community → one super-node
// ---------------------------------------------------------------------------

function buildSuperGraph(
  graph: LouvainGraph,
  community: number[],
  numCommunities: number,
): LouvainGraph {
  const { n, adj, degree } = graph;

  // super-node degrees and inter-community edge weights
  const superDegree = new Array<number>(numCommunities).fill(0);
  const edgeMap = new Map<string, number>(); // "c1:c2" → weight

  for (let i = 0; i < n; i++) {
    const ci = community[i];
    superDegree[ci] += degree[i];

    for (const edge of adj[i]) {
      const cj = community[edge.target];
      if (ci === cj) continue;
      const key = ci < cj ? `${ci}:${cj}` : `${cj}:${ci}`;
      edgeMap.set(key, (edgeMap.get(key) ?? 0) + edge.weight);
    }
  }

  const superAdj: Edge[][] = Array.from({ length: numCommunities }, () => []);
  let superTotalWeight = 0;

  for (const [key, w] of edgeMap) {
    const [a, b] = key.split(':').map(Number);
    superAdj[a].push({ target: b, weight: w });
    superAdj[b].push({ target: a, weight: w });
    superTotalWeight += w;
  }

  return {
    n: numCommunities,
    adj: superAdj,
    degree: superDegree,
    totalWeight: superTotalWeight > 0 ? superTotalWeight : graph.totalWeight,
  };
}

// ---------------------------------------------------------------------------
// Compact community[] labels to 0..k-1, returns { remap, count }
// ---------------------------------------------------------------------------

function compactCommunities(
  community: number[],
  n: number,
): { remap: Map<number, number>; count: number } {
  const remap = new Map<number, number>();
  let next = 0;
  for (let i = 0; i < n; i++) {
    const c = community[i];
    if (!remap.has(c)) remap.set(c, next++);
  }
  return { remap, count: next };
}

// ---------------------------------------------------------------------------
// Full Louvain: Phase 1 + Phase 2 (super-graph) iterations
// Returns community[] array indexed by original node index.
// ---------------------------------------------------------------------------

function runFullLouvain(graph: LouvainGraph, maxIters: number): number[] {
  const { n } = graph;

  // Initial: each node in own community
  let community = Array.from({ length: n }, (_, i) => i);
  let sumTot = new Float64Array(n);
  let sumIn = new Float64Array(n);
  for (let i = 0; i < n; i++) sumTot[i] = graph.degree[i];

  // Track how original nodes map to super-nodes across phases
  // nodeToSuper[i] = which super-node node i belongs to (after each Phase 2 aggregation)
  let originalToSuper: number[] = Array.from({ length: n }, (_, i) => i);

  let currentGraph = graph;
  let globalIter = 0;

  while (globalIter < 10) {
    globalIter++;

    // Phase 1 on current graph
    louvainPhase1(currentGraph, community, sumTot, sumIn, maxIters);

    // Compact communities
    const { remap, count } = compactCommunities(community, currentGraph.n);

    // Apply remap
    for (let i = 0; i < currentGraph.n; i++) {
      community[i] = remap.get(community[i]) ?? 0;
    }

    // Update originalToSuper: map each original node to its new super-node
    const prevToNew = community.slice();
    originalToSuper = originalToSuper.map((s) => prevToNew[s]);

    // If no improvement (each node still in its own community or count unchanged)
    if (count === currentGraph.n) break;

    // Phase 2: build super-graph
    const superGraph = buildSuperGraph(currentGraph, community, count);

    // Prepare community/sumTot/sumIn for super-graph Phase 1
    community = Array.from({ length: count }, (_, i) => i);
    sumTot = new Float64Array(count);
    sumIn = new Float64Array(count);
    for (let i = 0; i < count; i++) sumTot[i] = superGraph.degree[i];

    currentGraph = superGraph;

    if (currentGraph.totalWeight === 0) break;
  }

  return originalToSuper;
}

// ---------------------------------------------------------------------------
// Split oversized communities (> 25% of total nodes, min 10 nodes)
// Uses recursive Louvain on the subgraph.
// ---------------------------------------------------------------------------

function splitOversizedCommunities(
  communities: number[],
  graph: LouvainGraph,
  totalNodes: number,
  maxIters: number,
): number[] {
  const threshold = Math.max(10, Math.floor(totalNodes * 0.25));

  // Count members per community
  const communityMembers = new Map<number, number[]>();
  for (let i = 0; i < totalNodes; i++) {
    const c = communities[i];
    const arr = communityMembers.get(c) ?? [];
    arr.push(i);
    communityMembers.set(c, arr);
  }

  const result = communities.slice();
  let nextClusterId = Math.max(...communities) + 1;

  for (const [comm, members] of communityMembers) {
    if (members.length <= threshold) continue;

    // Build subgraph for this community
    const localIndex = new Map<number, number>(members.map((n, i) => [n, i]));
    const subN = members.length;
    const subAdj: Edge[][] = Array.from({ length: subN }, () => []);
    const subDegree = new Array<number>(subN).fill(0);
    let subTotalWeight = 0;

    for (const orig of members) {
      const li = localIndex.get(orig)!;
      for (const edge of graph.adj[orig]) {
        const lj = localIndex.get(edge.target);
        if (lj === undefined) continue; // cross-community edge, skip
        subAdj[li].push({ target: lj, weight: edge.weight });
        subDegree[li] += edge.weight;
        subTotalWeight += edge.weight;
      }
    }

    if (subTotalWeight === 0) continue; // no internal edges, can't split

    const subGraph: LouvainGraph = {
      n: subN,
      adj: subAdj,
      degree: subDegree,
      totalWeight: subTotalWeight,
    };

    const subCommunities = runFullLouvain(subGraph, maxIters);
    const { remap, count } = compactCommunities(subCommunities, subN);

    if (count <= 1) continue; // couldn't split further

    // Map sub-community 0 → keep original comm id, rest → new ids
    const subCommToGlobal = new Map<number, number>();
    for (const [rawSub, compactSub] of remap) {
      if (compactSub === 0) {
        subCommToGlobal.set(rawSub, comm);
      } else {
        subCommToGlobal.set(rawSub, nextClusterId++);
      }
    }

    for (let li = 0; li < subN; li++) {
      const orig = members[li];
      result[orig] = subCommToGlobal.get(subCommunities[li]) ?? comm;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stable community ID remapping across runs
// Matches new communities to old by overlap (Jaccard-like intersection count).
// ---------------------------------------------------------------------------

function stableIdRemap(
  ids: string[],
  newCommunities: number[],
  previous: ClusterAssignment | null,
): number[] {
  if (!previous || Object.keys(previous.members).length === 0) {
    return newCommunities;
  }

  // Build sets: newComm → Set<id>
  const newToIds = new Map<number, Set<string>>();
  for (let i = 0; i < ids.length; i++) {
    const c = newCommunities[i];
    const s = newToIds.get(c) ?? new Set<string>();
    s.add(ids[i]);
    newToIds.set(c, s);
  }

  // Build sets: oldComm → Set<id>
  const oldToIds = new Map<number, Set<string>>();
  for (const [id, c] of Object.entries(previous.members)) {
    const s = oldToIds.get(c) ?? new Set<string>();
    s.add(id);
    oldToIds.set(c, s);
  }

  // Greedy matching: for each new community, find old community with max overlap
  const usedOldIds = new Set<number>();
  const newToStable = new Map<number, number>();
  let nextFreeId = Math.max(...Array.from(oldToIds.keys()), -1) + 1;

  // Sort new communities by size desc for greedy priority
  const sortedNew = [...newToIds.keys()].sort(
    (a, b) => (newToIds.get(b)?.size ?? 0) - (newToIds.get(a)?.size ?? 0),
  );

  for (const newComm of sortedNew) {
    const newSet = newToIds.get(newComm)!;
    let bestOld = -1;
    let bestOverlap = 0;

    for (const [oldComm, oldSet] of oldToIds) {
      if (usedOldIds.has(oldComm)) continue;
      let overlap = 0;
      for (const id of newSet) {
        if (oldSet.has(id)) overlap++;
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestOld = oldComm;
      }
    }

    if (bestOld >= 0 && bestOverlap > 0) {
      newToStable.set(newComm, bestOld);
      usedOldIds.add(bestOld);
    } else {
      newToStable.set(newComm, nextFreeId++);
    }
  }

  // Compact to 0..k-1 preserving stable mapping
  const stableIds = newCommunities.map((c) => newToStable.get(c) ?? c);

  // Re-compact so IDs are 0-based consecutive (stable relative order)
  const seen = new Map<number, number>();
  let idx = 0;
  const compact = stableIds.map((c) => {
    if (!seen.has(c)) seen.set(c, idx++);
    return seen.get(c)!;
  });

  return compact;
}

// ---------------------------------------------------------------------------
// Compute modularity Q for a community assignment
// ---------------------------------------------------------------------------

export function computeModularity(graph: LouvainGraph, community: number[]): number {
  const m = graph.totalWeight;
  if (m === 0) return 0;
  let q = 0;
  for (let i = 0; i < graph.n; i++) {
    for (const edge of graph.adj[i]) {
      if (community[i] === community[edge.target]) {
        q += edge.weight - (graph.degree[i] * graph.degree[edge.target]) / (2 * m);
      }
    }
  }
  return q / (2 * m);
}

/**
 * Louvain community detection (pure TypeScript, no external deps).
 * Maximises modularity Q = (1/2m) * sum_ij [ A_ij - k_i*k_j/(2m) ] * delta(c_i, c_j)
 *
 * Full Louvain with:
 * - Phase 1: local greedy moves (deterministic shuffle seeded by iteration)
 * - Phase 2: super-graph aggregation, iterated until no improvement
 * - Oversized community splitting (> 25% of total nodes, min 10)
 * - Stable community ID remapping against previous clusters.json
 *
 * Edges: backlinks weight 1.0, shared-tag soft links weight 0.3 (capped at 40x40 per tag).
 */
export function detectClusters(
  notes: Array<{ id: string; tags: string; topic?: string }>,
  backlinks: BacklinksIndex,
  maxIters = 20,
  previousClusters: ClusterAssignment | null = null,
): ClusterAssignment {
  const ids = notes.map((n) => n.id);
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;

  // Build weighted adjacency list
  const adj: Edge[][] = Array.from({ length: n }, () => []);
  const degree: number[] = new Array(n).fill(0);
  let totalWeight = 0;

  // Add backlink edges (bidirectional, weight 1.0)
  for (const edges of Object.values(backlinks.outgoing ?? {})) {
    for (const e of edges) {
      const from = idIndex.get(e.from);
      const to = idIndex.get(e.to);
      if (from === undefined || to === undefined || from === to) continue;
      adj[from].push({ target: to, weight: 1.0 });
      adj[to].push({ target: from, weight: 1.0 });
      degree[from] += 1.0;
      degree[to] += 1.0;
      totalWeight += 1.0;
    }
  }

  // Add tag soft links (weight 0.3)
  const tagBuckets = new Map<string, number[]>();
  for (const note of notes) {
    const idx = idIndex.get(note.id);
    if (idx === undefined) continue;
    for (const t of (note.tags ?? '').split(/\s+/).filter(Boolean)) {
      (tagBuckets.get(t) ?? tagBuckets.set(t, []).get(t)!).push(idx);
    }
  }
  for (const bucket of tagBuckets.values()) {
    const cap = Math.min(bucket.length, 40);
    for (let i = 0; i < cap; i++) {
      for (let j = i + 1; j < cap; j++) {
        adj[bucket[i]].push({ target: bucket[j], weight: 0.3 });
        adj[bucket[j]].push({ target: bucket[i], weight: 0.3 });
        degree[bucket[i]] += 0.3;
        degree[bucket[j]] += 0.3;
        totalWeight += 0.3;
      }
    }
  }

  if (totalWeight === 0) {
    // No edges at all — each node in its own cluster
    const members: Record<string, number> = {};
    ids.forEach((id, i) => {
      members[id] = i;
    });
    const labels: Record<number, string> = {};
    ids.forEach((_, i) => {
      labels[i] = `cluster-${i}`;
    });
    return {
      node_count: n,
      cluster_count: n,
      members,
      labels,
      generated: new Date().toISOString(),
    };
  }

  const graph: LouvainGraph = { n, adj, degree, totalWeight };

  // Full Louvain (Phase 1 + Phase 2 iterations)
  let communities = runFullLouvain(graph, maxIters);

  // Split oversized communities
  communities = splitOversizedCommunities(communities, graph, n, maxIters);

  // Stable ID remapping against previous run
  communities = stableIdRemap(ids, communities, previousClusters);

  // Compact to 0..k-1
  const finalRemap = new Map<number, number>();
  let nextId = 0;
  for (let i = 0; i < n; i++) {
    const c = communities[i];
    if (!finalRemap.has(c)) finalRemap.set(c, nextId++);
  }

  const members: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    members[ids[i]] = finalRemap.get(communities[i]) ?? 0;
  }

  // Build per-cluster tag, topic, and id-segment frequency for labeling
  const tagFreqByCluster = new Map<number, Map<string, number>>();
  const topicFreqByCluster = new Map<number, Map<string, number>>();
  const idsByCluster = new Map<number, string[]>();

  for (const note of notes) {
    const cluster = members[note.id];
    if (cluster === undefined) continue;

    // Tag frequency
    const tagFreq = tagFreqByCluster.get(cluster) ?? new Map<string, number>();
    for (const t of (note.tags ?? '').split(/\s+/).filter(Boolean)) {
      tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
    tagFreqByCluster.set(cluster, tagFreq);

    // Topic frequency: prefer explicit topic field, then slash-separated path, then hyphen segments
    const rawTopic = note.topic ?? note.id;
    const topicSeg = deriveTopicSegment(rawTopic);
    const topicFreq = topicFreqByCluster.get(cluster) ?? new Map<string, number>();
    topicFreq.set(topicSeg, (topicFreq.get(topicSeg) ?? 0) + 1);
    topicFreqByCluster.set(cluster, topicFreq);

    // Collect IDs for common-prefix extraction
    const clusterIds = idsByCluster.get(cluster) ?? [];
    clusterIds.push(note.id);
    idsByCluster.set(cluster, clusterIds);
  }

  // Global tag distribution to identify overly generic tags
  const globalTagCount = new Map<string, number>();
  for (const note of notes) {
    for (const t of (note.tags ?? '').split(/\s+/).filter(Boolean)) {
      globalTagCount.set(t, (globalTagCount.get(t) ?? 0) + 1);
    }
  }

  const labels: Record<number, string> = {};
  const usedLabels = new Set<string>();

  for (let c = 0; c < nextId; c++) {
    const tagFreq = tagFreqByCluster.get(c);
    const topicFreq = topicFreqByCluster.get(c);
    const clusterIds = idsByCluster.get(c) ?? [];

    const sortedTags = tagFreq ? [...tagFreq.entries()].sort((a, b) => b[1] - a[1]) : [];
    const sortedTopics = topicFreq ? [...topicFreq.entries()].sort((a, b) => b[1] - a[1]) : [];

    // Try to find the best tag label, skipping overly generic ones
    const bestTag = pickBestTag(sortedTags, globalTagCount, notes.length);

    if (bestTag !== null) {
      const { tag, isGeneric } = bestTag;
      const topicDisambiguator = sortedTopics[0]?.[0] ?? commonIdPrefix(clusterIds);

      if (isGeneric && topicDisambiguator) {
        // Combine generic tag with a topic disambiguator: "llm/acme"
        const combined = `${topicDisambiguator}/${tag}`;
        labels[c] = resolveLabel(combined, usedLabels, c);
      } else {
        labels[c] = resolveLabel(tag, usedLabels, c);
      }
    } else {
      // No usable tags at all — derive from IDs
      const idDerived = sortedTopics[0]?.[0] ?? commonIdPrefix(clusterIds);
      labels[c] = resolveLabel(idDerived || `cluster-${c}`, usedLabels, c);
    }

    usedLabels.add(labels[c]);
  }

  return {
    node_count: n,
    cluster_count: nextId,
    members,
    labels,
    generated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Labeling helpers
// ---------------------------------------------------------------------------

/**
 * Extract the most meaningful topic segment from a raw string.
 * Prefers slash-separated paths (e.g. "acme/auth" → "auth"),
 * then falls back to the two longest hyphen-separated segments.
 */
function deriveTopicSegment(raw: string): string {
  const slashParts = raw.split('/').filter(Boolean);
  if (slashParts.length >= 2) {
    // Use the last two segments joined: "acme/auth"
    return slashParts.slice(-2).join('/');
  }
  if (slashParts.length === 1) {
    // Single path part — try to get meaningful hyphen segments
    const hyphenParts = slashParts[0].split('-').filter(Boolean);
    if (hyphenParts.length >= 2) {
      return hyphenParts.slice(0, 2).join('-');
    }
    return slashParts[0];
  }
  return raw || 'misc';
}

/**
 * Find the most common prefix among a list of note IDs.
 * Splits each ID on '-' and '/', finds segments shared by the majority.
 * Returns a 1-2 segment prefix string, or empty string if nothing useful.
 */
function commonIdPrefix(ids: string[]): string {
  if (ids.length === 0) return '';

  // Count how often each segment appears across all IDs
  const segCount = new Map<string, number>();
  for (const id of ids) {
    const segments = id.split(/[-/]/).filter((s) => s.length > 2); // skip short noise
    const seen = new Set<string>();
    for (const seg of segments) {
      if (!seen.has(seg)) {
        segCount.set(seg, (segCount.get(seg) ?? 0) + 1);
        seen.add(seg);
      }
    }
  }

  // Keep segments present in >40% of cluster IDs
  const threshold = Math.max(1, ids.length * 0.4);
  const dominant = [...segCount.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([seg]) => seg);

  if (dominant.length === 0) return '';
  // Return up to 2 dominant segments joined with '-'
  return dominant.slice(0, 2).join('-');
}

/**
 * Pick the best tag from a sorted frequency list.
 * Returns { tag, isGeneric } where isGeneric means global ratio > 0.6,
 * or null if no usable tag exists.
 */
function pickBestTag(
  sortedTags: Array<[string, number]>,
  globalTagCount: Map<string, number>,
  totalNotes: number,
): { tag: string; isGeneric: boolean } | null {
  if (sortedTags.length === 0) return null;

  // Try tags in order of cluster frequency; prefer non-generic ones
  for (const [tag] of sortedTags) {
    const ratio = (globalTagCount.get(tag) ?? 0) / totalNotes;
    if (ratio <= 0.6) {
      return { tag, isGeneric: false };
    }
  }

  // All tags are generic — return the most frequent one marked as generic
  return { tag: sortedTags[0][0], isGeneric: true };
}

/**
 * Ensure uniqueness of a candidate label.
 * If already used, appends the cluster index as a suffix.
 */
function resolveLabel(candidate: string, usedLabels: Set<string>, clusterIndex: number): string {
  if (!usedLabels.has(candidate)) return candidate;
  const suffixed = `${candidate}-${clusterIndex}`;
  if (!usedLabels.has(suffixed)) return suffixed;
  // Last resort: always unique
  return `${candidate}-c${clusterIndex}`;
}

export function saveClusters(c: ClusterAssignment): string {
  const cfg = getConfig();
  if (!existsSync(cfg.cachePath)) mkdirSync(cfg.cachePath, { recursive: true });
  const path = join(cfg.cachePath, CLUSTERS_FILENAME);
  writeFileSync(path, JSON.stringify(c, null, 2), 'utf8');
  return path;
}

export function loadClusters(): ClusterAssignment | null {
  const cfg = getConfig();
  const path = join(cfg.cachePath, CLUSTERS_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClusterAssignment;
  } catch {
    return null;
  }
}
