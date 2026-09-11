import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadBacklinks } from '../../graph/backlinks.js';
import { loadGlobalGraph } from '../../graph/global-graph.js';
import { loadKnowledgeGraph } from '../../graph/knowledge-graph.js';
import type { BrainKnowledgeGraph } from '../../graph/knowledge-graph.js';
import { countAllNotesReadonly, listGraphNotesReadonly } from '../../indexer/fts.js';
import { getLogger } from '../../util/logger.js';
import { sendJsonCached } from '../cache.js';
import { CSP_API, sendError } from '../security.js';

// ---------------------------------------------------------------------------
// Slim layout payload type
// Sent to the home panel + graph.html. Contains only what the renderer needs:
//   nodes: [{id, x, y, c(cluster idx), d(degree), t(type char), l(label — hubs only)}]
//   edges: [[sourceIdx, targetIdx], ...]  — integer indices into nodes array
//   clusters: [label, ...] — cluster idx → label string
// ---------------------------------------------------------------------------

export interface SlimNode {
  id: string;
  x: number;
  y: number;
  /** cluster index into the clusters array */
  c: number;
  /** degree */
  d: number;
  /** type: 'n'=note, 'f'=file-neuron, 'a'=aggregate-neuron, 'c'=concept */
  t: string;
  /** label — only present for hub nodes (top-degree) */
  l?: string;
}

export interface SlimLayoutPayload {
  nodes: SlimNode[];
  /** Each edge is [sourceIdx, targetIdx] using integer indices into nodes array */
  edges: [number, number][];
  /** cluster label indexed by cluster-index (c field) */
  clusters: string[];
  /** true = positions are precomputed; false = fallback radial placement */
  hasPositions: boolean;
}

// ---------------------------------------------------------------------------
// Shared helper: build nodes + edges from notes index + backlinks
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  title: string;
  type: string | null;
  topic: string | null;
  importance: number;
  /** Precomputed x position from layout engine (undefined if graph not yet built). */
  x?: number;
  /** Precomputed y position from layout engine (undefined if graph not yet built). */
  y?: number;
  /** Precomputed degree (in + out edges). */
  degree?: number;
  /** Top-level cluster label (first topic segment). */
  cluster?: string;
  /**
   * Note creation timestamp (ISO-ish string), straight from the `notes`
   * table's `created` column — already loaded in memory by listAllReadonly
   * below for every note, just not previously copied onto the graph node.
   * Powers the Brain Canvas time-travel scrubber (see
   * src/components/brain/canvas/dateBucketing.ts on the frontend): without
   * this field the bulk graph payload carried no per-node date, so
   * time-travel fell back to a hash-based pseudo-chronology.
   */
  created?: string | null;
}

interface GraphEdge {
  from: string;
  to: string;
  type: string;
  auto: boolean;
}

interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function buildGraphPayload(): GraphPayload {
  // Projected read — only the 6 note columns this payload copies onto a
  // GraphNode. SELECT * here cost ~617 ms and ~8.8 MB on a real 3,123-note
  // brain for fields the payload never uses; the slim projection is ~16 ms.
  const allNotes = listGraphNotesReadonly();
  const backlinksIdx = loadBacklinks();

  // Attempt to load precomputed positions from the knowledge graph cache
  const knowledgeGraph = loadKnowledgeGraph();
  const posMap = new Map<string, { x: number; y: number; degree: number; cluster: string }>();
  if (knowledgeGraph) {
    for (const n of knowledgeGraph.nodes) {
      if (n.x !== undefined && n.y !== undefined) {
        posMap.set(n.id, {
          x: n.x,
          y: n.y,
          degree: n.degree ?? 0,
          cluster: n.cluster,
        });
      }
    }
  }

  const nodes: GraphNode[] = allNotes.map((n) => {
    const pos = posMap.get(n.id);
    return {
      id: n.id,
      title: n.title,
      type: n.type,
      topic: n.topic || null,
      importance: n.importance || 0.5,
      created: n.created ?? null,
      ...(pos ? { x: pos.x, y: pos.y, degree: pos.degree, cluster: pos.cluster } : {}),
    };
  });

  // Prefer edges from brain-graph.json (includes structural edges) when available.
  // Fall back to raw backlinks for backward compatibility when graph hasn't been built yet.
  const edges: GraphEdge[] = [];
  if (knowledgeGraph && knowledgeGraph.edges.length > 0) {
    for (const edge of knowledgeGraph.edges) {
      edges.push({
        from: edge.source,
        to: edge.target,
        type: edge.type,
        auto: edge.confidence !== 'extracted',
      });
    }
  } else if (backlinksIdx) {
    for (const outgoingEdges of Object.values(backlinksIdx.outgoing)) {
      for (const edge of outgoingEdges) {
        edges.push({
          from: edge.from,
          to: edge.to,
          type: edge.type,
          auto: edge.auto,
        });
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Persisted graph loader helpers for graph-layout.json endpoint
// ---------------------------------------------------------------------------

/**
 * Minimum fraction of nodes that must have positions for the layout
 * to be treated as "positioned" (hasPositions=true). Nodes below this
 * threshold trigger the full radial fallback; nodes above it get
 * deterministic cluster-centroid placement for the unpositioned minority.
 */
const PARTIAL_POSITIONS_THRESHOLD = 0.6;

/** Seeded LCG PRNG (Park-Miller) — deterministic, no Math.random. */
function makeLcgPrng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return (): number => {
    s = Math.imul(s, 48271) % 2_147_483_647;
    return (s - 1) / 2_147_483_646;
  };
}

/**
 * Place unpositioned nodes near their cluster centroid using a seeded ring.
 * Mutates only the nodes that have no position yet (x === 0 && y === 0).
 *
 * @param nodes - slim nodes array (x/y already set for positioned nodes)
 * @param clusterCentroids - map from cluster-index to {x, y} centroid
 */
function placeUnpositionedNodes(
  nodes: SlimNode[],
  clusterCentroids: Map<number, { x: number; y: number }>,
): void {
  // Collect unpositioned nodes per cluster
  const byCluster = new Map<number, SlimNode[]>();
  for (const n of nodes) {
    if (n.x === 0 && n.y === 0) {
      const arr = byCluster.get(n.c) ?? [];
      arr.push(n);
      byCluster.set(n.c, arr);
    }
  }

  if (byCluster.size === 0) return;

  // Fallback centroid for nodes with no cluster (c=0, no positioned neighbours)
  const originCentroid = { x: 0, y: 0 };
  const RING_RADIUS = 60; // small ring around cluster centroid
  const ORIGIN_RING = 80; // slightly larger ring near origin for orphans

  const prng = makeLcgPrng(0xab1234ef);

  for (const [cIdx, unposNodes] of byCluster) {
    const centroid = clusterCentroids.get(cIdx) ?? originCentroid;
    const radius = cIdx === 0 && !clusterCentroids.has(0) ? ORIGIN_RING : RING_RADIUS;
    const count = unposNodes.length;

    for (let i = 0; i < count; i++) {
      const angle = (i / Math.max(count, 1)) * 2 * Math.PI;
      const jitter = (prng() - 0.5) * radius * 0.4;
      unposNodes[i].x = centroid.x + Math.cos(angle) * (radius + jitter);
      unposNodes[i].y = centroid.y + Math.sin(angle) * (radius + jitter);
    }
  }
}

/**
 * Compute cluster centroids from nodes that already have real positions.
 * A "real" position is anything where the node came from brain-graph.json
 * (i.e. x !== 0 || y !== 0, but also handles the edge case of x=0,y=0
 * being a valid layout position for a single hub at origin — we use the
 * persisted-flag tracking instead of the zero sentinel).
 */
function computeClusterCentroids(
  nodes: SlimNode[],
  positionedIds: Set<string>,
): Map<number, { x: number; y: number }> {
  const sums = new Map<number, { sx: number; sy: number; count: number }>();

  for (const n of nodes) {
    if (!positionedIds.has(n.id)) continue;
    const entry = sums.get(n.c) ?? { sx: 0, sy: 0, count: 0 };
    entry.sx += n.x;
    entry.sy += n.y;
    entry.count += 1;
    sums.set(n.c, entry);
  }

  const centroids = new Map<number, { x: number; y: number }>();
  for (const [cIdx, { sx, sy, count }] of sums) {
    if (count > 0) {
      centroids.set(cIdx, { x: sx / count, y: sy / count });
    }
  }
  return centroids;
}

/**
 * Build a slim layout payload directly from a persisted BrainKnowledgeGraph.
 *
 * This is the primary path for GET /_api/graph-layout.json:
 *   - Nodes come from brain-graph.json (already have x, y, degree, cluster).
 *   - Edges come from brain-graph.json (structural + backlinks, ~9 000+).
 *   - Positions: if >= 60% of nodes have real coords → hasPositions=true.
 *     Unpositioned nodes (added after last `graph` run) get deterministic
 *     cluster-centroid placement.
 *
 * The "generatedAt" / "nodeCountAtBuild" fields are informational. The
 * caller can compare them against the live note count to detect staleness,
 * but NEVER recomputes the layout live (too slow).
 */
export function buildSlimLayoutFromPersistedGraph(
  graph: BrainKnowledgeGraph,
  liveNoteCount?: number,
): SlimLayoutPayload & { generatedAt: string; nodeCountAtBuild: number } {
  const log = getLogger();

  // Warn (debug-level) if the live brain has grown significantly since last graph run
  if (
    liveNoteCount !== undefined &&
    liveNoteCount > graph.stats.nodes * 1.2 &&
    graph.stats.nodes > 0
  ) {
    log.debug(
      { liveNoteCount, graphNodeCount: graph.stats.nodes },
      'Brain has grown significantly since last graph run — consider re-running: lazybrain graph',
    );
  }

  const clusterToIdx = new Map<string, number>();
  const clusters: string[] = [];

  const getClusterIdx = (label: string): number => {
    if (clusterToIdx.has(label)) return clusterToIdx.get(label)!;
    const idx = clusters.length;
    clusters.push(label);
    clusterToIdx.set(label, idx);
    return idx;
  };

  // Derive visual cluster from topic (first segment), same logic as buildSlimLayout.
  const nodeClusterLabel = (n: { topic: string; cluster: string }): string => {
    if (n.topic && n.topic !== 'unknown') return n.topic.split('/')[0].toLowerCase();
    return '_default';
  };

  // Build slim nodes from persisted graph nodes
  const HUB_COUNT_SLIM = 20;
  const sortedByDegree = [...graph.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  const hubIds = new Set(sortedByDegree.slice(0, HUB_COUNT_SLIM).map((n) => n.id));

  const positionedIds = new Set<string>();
  const slimNodes: SlimNode[] = [];
  const nodeIdToIdx = new Map<string, number>();

  for (const n of graph.nodes) {
    const idx = slimNodes.length;
    nodeIdToIdx.set(n.id, idx);
    const clusterLabel = nodeClusterLabel(n);
    const cIdx = getClusterIdx(clusterLabel);

    const hasCoords = typeof n.x === 'number' && typeof n.y === 'number';
    if (hasCoords) positionedIds.add(n.id);

    const sn: SlimNode = {
      id: n.id,
      x: hasCoords ? (n.x as number) : 0,
      y: hasCoords ? (n.y as number) : 0,
      c: cIdx,
      d: n.degree ?? 0,
      t:
        n.type === 'file-neuron'
          ? 'f'
          : n.type === 'aggregate-neuron'
            ? 'a'
            : n.type === 'concept'
              ? 'c'
              : 'n',
    };

    if (hubIds.has(n.id)) {
      sn.l = n.title.slice(0, 22);
    }

    slimNodes.push(sn);
  }

  // Determine hasPositions based on fraction of positioned nodes
  const positionedCount = positionedIds.size;
  const totalCount = slimNodes.length;
  const positionedFraction = totalCount > 0 ? positionedCount / totalCount : 0;
  const hasPositions = positionedFraction >= PARTIAL_POSITIONS_THRESHOLD;

  // For partial-positions case: place unpositioned nodes near their cluster centroid
  if (hasPositions && positionedCount < totalCount) {
    const centroids = computeClusterCentroids(slimNodes, positionedIds);
    placeUnpositionedNodes(slimNodes, centroids);
  }

  // Build slim edges from persisted graph edges
  const slimEdges: [number, number][] = [];
  for (const e of graph.edges) {
    const si = nodeIdToIdx.get(e.source);
    const ti = nodeIdToIdx.get(e.target);
    if (si !== undefined && ti !== undefined) {
      slimEdges.push([si, ti]);
    }
  }

  return {
    nodes: slimNodes,
    edges: slimEdges,
    clusters,
    hasPositions,
    generatedAt: graph.generated,
    nodeCountAtBuild: graph.stats.nodes,
  };
}

// ---------------------------------------------------------------------------
// BFS subgraph extraction
//
// Given a root node id and a max depth, returns the set of nodes reachable
// within `depth` hops (following both outgoing and incoming edges) plus all
// edges whose both endpoints are in the reachable set.
// ---------------------------------------------------------------------------

function bfsSubgraph(payload: GraphPayload, rootId: string, depth: number): GraphPayload {
  const effectiveDepth = depth < 0 ? 0 : depth;

  // Build adjacency: id → set of neighbour ids (undirected for BFS)
  const adjacency = new Map<string, Set<string>>();
  for (const edge of payload.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const visited = new Set<string>([rootId]);
  let frontier = new Set<string>([rootId]);

  for (let d = 0; d < effectiveDepth; d++) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      for (const neighbour of adjacency.get(nodeId) ?? []) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          next.add(neighbour);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  const nodes = payload.nodes.filter((n) => visited.has(n.id));
  const edges = payload.edges.filter((e) => visited.has(e.from) && visited.has(e.to));
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// GET /_api/graph  AND  GET /_api/graph.json  (shared handler)
//
// Optional query params:
//   ?root=<id>    — BFS root node id
//   ?depth=<n>    — BFS depth (default 2, min 0)
//
// Backward-compat: when no params are given, returns the full graph as before.
// ---------------------------------------------------------------------------

export function handleGraph(req: IncomingMessage, res: ServerResponse, routeLabel: string): void {
  const log = getLogger();
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rootParam = url.searchParams.get('root');
    const depthParam = url.searchParams.get('depth');

    const payload = buildGraphPayload();

    let result: GraphPayload;
    if (rootParam) {
      const depth = depthParam !== null ? Math.max(0, Number.parseInt(depthParam, 10) || 0) : 2;
      result = bfsSubgraph(payload, rootParam, depth);
    } else {
      result = payload;
    }

    sendJsonCached(req, res, 200, result, { csp: CSP_API }).catch((err) => {
      log.error({ err }, `Compression error in ${routeLabel}`);
    });
  } catch (err) {
    log.error({ err }, `API error in ${routeLabel}`);
    sendError(res, 500, 'Failed to load graph data');
  }
}

// ---------------------------------------------------------------------------
// Build slim layout payload from a full graph payload
// ---------------------------------------------------------------------------

const HUB_COUNT_SLIM = 20; // top-N hubs that get labels in the slim payload

export function buildSlimLayout(payload: GraphPayload): SlimLayoutPayload {
  // Build cluster index
  const clusterToIdx = new Map<string, number>();
  const clusters: string[] = [];

  const getClusterIdx = (label: string): number => {
    if (clusterToIdx.has(label)) return clusterToIdx.get(label)!;
    const idx = clusters.length;
    clusters.push(label);
    clusterToIdx.set(label, idx);
    return idx;
  };

  // Derive visual cluster from the topic path only (first segment).
  // The brain-graph cluster field may carry node-type values ("shell", "note", "concept")
  // rather than topic-based groups — those are not meaningful visual clusters for the renderer.
  // We always derive the visual cluster from topic; nodes without a topic go to '_default'.
  const nodeCluster = (n: GraphNode): string => {
    if (n.topic) return n.topic.split('/')[0].toLowerCase();
    return '_default';
  };

  // Detect if positions are precomputed
  const hasPositions = payload.nodes.some((n) => n.x !== undefined && n.y !== undefined);

  // Determine hubs by degree (top HUB_COUNT_SLIM)
  const sortedByDegree = [...payload.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
  const hubIds = new Set(sortedByDegree.slice(0, HUB_COUNT_SLIM).map((n) => n.id));

  // Build slim node list (positions filled in later if absent)
  const nodeIdToIdx = new Map<string, number>();
  const slimNodes: SlimNode[] = [];

  for (const n of payload.nodes) {
    const idx = slimNodes.length;
    nodeIdToIdx.set(n.id, idx);
    const clusterLabel = nodeCluster(n);
    const cIdx = getClusterIdx(clusterLabel);

    const sn: SlimNode = {
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      c: cIdx,
      d: n.degree ?? 0,
      t:
        n.type === 'file-neuron'
          ? 'f'
          : n.type === 'aggregate-neuron'
            ? 'a'
            : n.type === 'concept'
              ? 'c'
              : 'n',
    };

    if (hubIds.has(n.id)) {
      sn.l = n.title.slice(0, 22);
    }

    slimNodes.push(sn);
  }

  // Build slim edge list as integer index pairs
  const slimEdges: [number, number][] = [];
  for (const e of payload.edges) {
    const si = nodeIdToIdx.get(e.from);
    const ti = nodeIdToIdx.get(e.to);
    if (si !== undefined && ti !== undefined) {
      slimEdges.push([si, ti]);
    }
  }

  return { nodes: slimNodes, edges: slimEdges, clusters, hasPositions };
}

// ---------------------------------------------------------------------------
// GET /_api/graph-layout.json — slim layout-only payload
//
// Primary path: load brain-graph.json (written by `lazybrain graph`).
//   - Serves structural + backlink edges (~9 000+) and precomputed positions.
//   - hasPositions=true when >= 60% of nodes are positioned.
//   - Unpositioned nodes (added after last graph run) get cluster-centroid
//     placement so the render stays clustered.
//
// Fallback path (brain-graph.json absent, i.e. user never ran `graph`):
//   - Falls back to backlinks-only with hasPositions=false.
//   - Client will use the radial fallback layout.
// ---------------------------------------------------------------------------

export function handleGraphLayout(req: IncomingMessage, res: ServerResponse): void {
  const log = getLogger();
  try {
    const persistedGraph = loadKnowledgeGraph();

    if (persistedGraph) {
      // Fast path: serve from brain-graph.json — full structural graph + positions.
      // The staleness check only needs the live note COUNT — not a single row —
      // so use the ~0 ms COUNT instead of materializing every note.
      const slim = buildSlimLayoutFromPersistedGraph(persistedGraph, countAllNotesReadonly());
      sendJsonCached(req, res, 200, slim, { csp: CSP_API }).catch((err) => {
        log.error({ err }, 'Compression error in /_api/graph-layout.json');
      });
    } else {
      // Fallback path: no brain-graph.json → backlinks only, no positions
      const payload = buildGraphPayload();
      const slim = buildSlimLayout(payload);
      sendJsonCached(req, res, 200, slim, { csp: CSP_API }).catch((err) => {
        log.error({ err }, 'Compression error in /_api/graph-layout.json (fallback)');
      });
    }
  } catch (err) {
    log.error({ err }, 'API error in /_api/graph-layout.json');
    sendError(res, 500, 'Failed to build slim graph layout');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/global-graph
// ---------------------------------------------------------------------------

export function handleGlobalGraph(req: IncomingMessage, res: ServerResponse): void {
  const log = getLogger();
  try {
    const globalGraph = loadGlobalGraph();
    if (!globalGraph) {
      sendError(res, 404, 'Global graph not available. Run: lazybrain graph');
      return;
    }
    sendJsonCached(req, res, 200, globalGraph, { csp: CSP_API }).catch((err) => {
      log.error({ err }, 'Compression error in /_api/global-graph');
    });
  } catch (err) {
    log.error({ err }, 'API error in /_api/global-graph');
    sendError(res, 500, 'Failed to load global graph');
  }
}
