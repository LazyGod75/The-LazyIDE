import type { BacklinksIndex } from './backlinks.js';
import type { BrainKnowledgeGraph, BrainNode } from './knowledge-graph.js';

// ---------------------------------------------------------------------------
// Backlinks topology summary (used by inject-context, graph command, etc.)
// ---------------------------------------------------------------------------

/**
 * Build a one-line graph topology summary for injection into LLM context.
 * Returns: "[GRAPH] N nodes, M edges. Top hubs: #x(12), #y(8), #z(5)."
 * Returns empty string when no backlinks data is available.
 */
export function buildGraphTopologySummary(backlinks: BacklinksIndex | null): string {
  if (!backlinks || backlinks.total_edges === 0) return '';

  const nodeSet = new Set<string>([
    ...Object.keys(backlinks.outgoing),
    ...Object.keys(backlinks.incoming),
  ]);

  // Rank hubs by inbound edge count
  const hubRanked = [...Object.entries(backlinks.incoming)]
    .map(([id, edges]) => ({ id, count: edges.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .filter((h) => h.count >= 2);

  const hubStr = hubRanked.map((h) => `#${h.id}(${h.count})`).join(', ');
  const hubPart = hubStr ? `. Top hubs: ${hubStr}` : '';
  return `[GRAPH] ${nodeSet.size} nodes, ${backlinks.total_edges} edges${hubPart}.`;
}

// ---------------------------------------------------------------------------
// God Nodes
// ---------------------------------------------------------------------------

export interface GodNode {
  id: string;
  title: string;
  totalDegree: number;
  inbound: number;
  outbound: number;
  topic: string;
}

export function findGodNodes(graph: BrainKnowledgeGraph, topN = 10): GodNode[] {
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();

  for (const edge of graph.edges) {
    outbound.set(edge.source, (outbound.get(edge.source) ?? 0) + 1);
    inbound.set(edge.target, (inbound.get(edge.target) ?? 0) + 1);
  }

  return graph.nodes
    .filter((n) => n.type !== 'brain-index')
    .map((n) => {
      const inn = inbound.get(n.id) ?? 0;
      const out = outbound.get(n.id) ?? 0;
      return {
        id: n.id,
        title: n.title,
        totalDegree: inn + out,
        inbound: inn,
        outbound: out,
        topic: n.topic,
      };
    })
    .sort((a, b) => b.totalDegree - a.totalDegree)
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Bridge Nodes
// ---------------------------------------------------------------------------

export interface BridgeNode {
  id: string;
  title: string;
  clustersConnected: string[];
  crossClusterEdges: number;
  betweennessCentrality: number;
}

export function findBridgeNodes(graph: BrainKnowledgeGraph, topN = 10): BridgeNode[] {
  const nodeCluster = new Map<string, string>(graph.nodes.map((n) => [n.id, n.cluster]));

  // For each node, collect all unique cluster-pairs it bridges.
  const bridgeMap = new Map<string, { clusters: Set<string>; crossEdges: number }>();

  for (const node of graph.nodes) {
    bridgeMap.set(node.id, { clusters: new Set(), crossEdges: 0 });
  }

  for (const edge of graph.edges) {
    const srcCluster = nodeCluster.get(edge.source);
    const tgtCluster = nodeCluster.get(edge.target);

    if (!srcCluster || !tgtCluster || srcCluster === tgtCluster) continue;

    // Both endpoints bridge these two clusters.
    const srcEntry = bridgeMap.get(edge.source);
    const tgtEntry = bridgeMap.get(edge.target);

    if (srcEntry) {
      srcEntry.clusters.add(tgtCluster);
      srcEntry.crossEdges += 1;
    }
    if (tgtEntry) {
      tgtEntry.clusters.add(srcCluster);
      tgtEntry.crossEdges += 1;
    }
  }

  const totalEdges = graph.edges.length || 1;

  return graph.nodes
    .map((n) => {
      const entry = bridgeMap.get(n.id) ?? { clusters: new Set<string>(), crossEdges: 0 };
      const clusterPairs = entry.clusters.size;
      // Approximation: betweenness proportional to unique cluster pairs bridged,
      // normalised by total edges.
      const betweennessCentrality = (entry.crossEdges * clusterPairs) / totalEdges;
      return {
        id: n.id,
        title: n.title,
        clustersConnected: Array.from(entry.clusters),
        crossClusterEdges: entry.crossEdges,
        betweennessCentrality,
      };
    })
    .filter((n) => n.clustersConnected.length > 0)
    .sort((a, b) => b.betweennessCentrality - a.betweennessCentrality)
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Surprising Connections
// ---------------------------------------------------------------------------

export interface SurprisingEdge {
  source: string;
  target: string;
  type: string;
  score: number;
  reason: string;
}

export function findSurprisingConnections(graph: BrainKnowledgeGraph, topN = 10): SurprisingEdge[] {
  const nodeMap = new Map<string, BrainNode>(graph.nodes.map((n) => [n.id, n]));

  // Degree map for low-degree endpoint bonus.
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  return graph.edges
    .map((edge): SurprisingEdge => {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);

      let score = 0;
      const reasons: string[] = [];

      if (src && tgt) {
        if (src.cluster !== tgt.cluster) {
          score += 2;
          reasons.push(`cross-cluster (${src.cluster} ↔ ${tgt.cluster})`);
        }
        if (src.topic !== tgt.topic) {
          score += 2;
          reasons.push(`cross-topic (${src.topic} ↔ ${tgt.topic})`);
        }
      }

      if (edge.confidence === 'ambiguous') {
        score += 3;
        reasons.push('ambiguous confidence');
      } else if (edge.confidence === 'inferred') {
        score += 1;
        reasons.push('inferred confidence');
      }

      const srcDegree = degree.get(edge.source) ?? 0;
      const tgtDegree = degree.get(edge.target) ?? 0;
      if (srcDegree <= 3 && tgtDegree <= 3) {
        score += 1;
        reasons.push('low-degree endpoints');
      }

      return {
        source: edge.source,
        target: edge.target,
        type: edge.type,
        score,
        reason: reasons.join(', ') || 'none',
      };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

// ---------------------------------------------------------------------------
// Cluster Quality Metrics
// ---------------------------------------------------------------------------

export interface ClusterQuality {
  clusterId: string;
  label: string;
  cohesion: number;
  separation: number;
  modularity: number;
  nodeCount: number;
}

export function assessClusterQuality(graph: BrainKnowledgeGraph): ClusterQuality[] {
  const totalEdges = graph.edges.length || 1;

  return graph.clusters.map((cluster) => {
    const n = cluster.nodeCount;
    const possibleInternal = n > 1 ? (n * (n - 1)) / 2 : 1;
    const cohesion = cluster.internalEdges / possibleInternal;

    const totalEdgesForCluster = cluster.internalEdges + cluster.externalEdges;
    const separation =
      totalEdgesForCluster > 0 ? 1 - cluster.externalEdges / totalEdgesForCluster : 1;

    // Simple modularity contribution: fraction of internal edges minus
    // expected fraction based on cluster size.
    const expectedFraction = (n / (graph.nodes.length || 1)) ** 2;
    const actualFraction = cluster.internalEdges / totalEdges;
    const modularity = actualFraction - expectedFraction;

    return {
      clusterId: cluster.id,
      label: cluster.label,
      cohesion,
      separation,
      modularity,
      nodeCount: n,
    };
  });
}

// ---------------------------------------------------------------------------
// Suggested Questions
// ---------------------------------------------------------------------------

export interface SuggestedQuestion {
  question: string;
  relatedNodeIds: string[];
  reason: string;
}

export function generateQuestions(graph: BrainKnowledgeGraph): SuggestedQuestion[] {
  const questions: SuggestedQuestion[] = [];

  // Bridge node questions.
  const bridges = findBridgeNodes(graph, 5);
  for (const bridge of bridges) {
    if (bridge.clustersConnected.length >= 2) {
      const [topicA, topicB] = bridge.clustersConnected;
      questions.push({
        question: `How does "${bridge.title}" connect the "${topicA}" and "${topicB}" clusters?`,
        relatedNodeIds: [bridge.id],
        reason: `Bridge node connecting ${bridge.clustersConnected.length} clusters`,
      });
    }
  }

  // God node questions.
  const godNodes = findGodNodes(graph, 5);
  for (const god of godNodes) {
    questions.push({
      question: `What role does "${god.title}" play across the codebase?`,
      relatedNodeIds: [god.id],
      reason: `High-degree node (${god.totalDegree} connections)`,
    });
  }

  // Isolated node questions.
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const isolated = graph.nodes
    .filter((n) => (degree.get(n.id) ?? 0) <= 1 && n.type !== 'brain-index')
    .slice(0, 5);

  for (const node of isolated) {
    questions.push({
      question: `Is "${node.title}" properly integrated? It has very few connections.`,
      relatedNodeIds: [node.id],
      reason: 'Isolated node with degree ≤ 1',
    });
  }

  // Weak cluster questions.
  const clusterQuality = assessClusterQuality(graph);
  const weakClusters = clusterQuality
    .filter((c) => c.cohesion < 0.1 && c.nodeCount > 2)
    .sort((a, b) => a.cohesion - b.cohesion)
    .slice(0, 3);

  for (const wc of weakClusters) {
    const clusterObj = graph.clusters.find((c) => c.id === wc.clusterId);
    questions.push({
      question: `Should cluster "${wc.label}" be split or merged? It has low internal cohesion (${wc.cohesion.toFixed(2)}).`,
      relatedNodeIds: clusterObj?.nodeIds.slice(0, 5) ?? [],
      reason: `Weak cluster cohesion (${wc.cohesion.toFixed(2)})`,
    });
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Orphan Nodes
// ---------------------------------------------------------------------------

export interface OrphanNode {
  id: string;
  title: string;
}

export function findOrphanNodes(graph: BrainKnowledgeGraph): OrphanNode[] {
  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  return graph.nodes.filter((n) => !connected.has(n.id)).map((n) => ({ id: n.id, title: n.title }));
}

// ---------------------------------------------------------------------------
// Edge type distribution
// ---------------------------------------------------------------------------

export function buildEdgeTypeDistribution(graph: BrainKnowledgeGraph): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const edge of graph.edges) {
    dist[edge.type] = (dist[edge.type] ?? 0) + 1;
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Confidence distribution
// ---------------------------------------------------------------------------

export function buildConfidenceDistribution(graph: BrainKnowledgeGraph): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const edge of graph.edges) {
    dist[edge.confidence] = (dist[edge.confidence] ?? 0) + 1;
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Aggregated analysis runner
// ---------------------------------------------------------------------------

export interface GraphAnalysis {
  godNodes: GodNode[];
  bridgeNodes: BridgeNode[];
  surprisingEdges: SurprisingEdge[];
  clusterQuality: ClusterQuality[];
  suggestedQuestions: SuggestedQuestion[];
  orphanNodes: OrphanNode[];
  edgeTypeDistribution: Record<string, number>;
  confidenceDistribution: Record<string, number>;
}

export function analyzeGraph(graph: BrainKnowledgeGraph): GraphAnalysis {
  return {
    godNodes: findGodNodes(graph),
    bridgeNodes: findBridgeNodes(graph),
    surprisingEdges: findSurprisingConnections(graph),
    clusterQuality: assessClusterQuality(graph),
    suggestedQuestions: generateQuestions(graph),
    orphanNodes: findOrphanNodes(graph),
    edgeTypeDistribution: buildEdgeTypeDistribution(graph),
    confidenceDistribution: buildConfidenceDistribution(graph),
  };
}
