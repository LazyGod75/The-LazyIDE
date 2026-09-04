/* layout.ts — elkjs auto-layout for the Agent Canvas (W2b, spec §4.3 "Lane
   mode", §4.5, §5 "Auto-layout").

   Pure async functions ONLY: given a plain node/edge list (the exact same
   `CanvasReactFlowNode[]`/`CanvasReactFlowEdge[]` shapes reconciler.ts
   already produces, read-only) plus a target zone id, each function
   resolves to a `Record<NodeRef, {x,y}>` position PATCH. Applying it is
   always the CALLER's job via `canvasStore.setPositions` (this module never
   touches the store, never touches React Flow, never mutates its inputs) —
   matches every other pure geometry module in this directory
   (canvasPlacement.ts's own header).

   `elkjs/lib/elk.bundled.js` (not the plain `elkjs` root, which defers to a
   Web Worker via `elk-worker.js`) is imported deliberately: the bundled
   build runs the Java-ported layered-layout algorithm SYNCHRONOUSLY in the
   calling thread — this is also the only variant that works unmodified
   inside vitest's node test environment (no `Worker`/`workerFactory` wiring
   needed), confirmed by direct smoke test. `layoutZone`/`layoutAll`/
   `laneLayout` below (the full-canvas "Ranger"/Ctrl+L auto-arrange, an
   explicit user action the user already expects a brief compute pause for)
   keep this synchronous in-thread path unchanged.

   `layoutPreviewGraph` (the in-chat plan-preview graph, GraphProposalCard.tsx)
   is the ONE exception, and deliberately so — 2026-08 off-main-thread
   rewrite (founder's #1 complaint, live-diagnosed: a real 12+ step plan hit
   the preview's watchdog timeout while `system pressure changed: Normal ->
   Elevated` was logged at the exact same moment, and a trivial 2-node graph
   laid out in 17ms when idle — elkjs was never slow, it was STARVED for a
   turn on the one thread React rendering/mission streaming/canvas
   reconciliation were ALSO fighting over, and the moment a user asks for a
   complex plan is exactly the moment that thread is busiest). This one
   function now offloads the actual layout call to a dedicated, reused
   Worker (previewLayoutWorkerClient.ts + elkLayoutWorker.ts — see those
   modules' headers for the full worker-lifecycle/CSP/cache rationale)
   whenever `typeof Worker === 'function'` (always true in the shipped app
   and plain `vite` dev/preview; never true under Vitest/jsdom, confirmed by
   transformSandbox.test.ts's own header — this exact feature-detection
   idiom already ships in this repo). IMPORTANT: the worker path uses a
   DIFFERENT elkjs entry point than the synchronous fallback below —
   `elk.bundled.js` (this file's own `elk` instance) cannot run inside a
   real Worker at all (verified live: it throws `_Worker is not a
   constructor` — see elkLayoutWorker.ts's header for the exact root cause
   in elkjs's own source), so the worker path goes through
   `elkjs/lib/elk-api.js` + `elkjs/lib/elk-worker.min.js` instead — two
   files elkjs itself ships specifically for real-Worker use. Either an
   outright worker rejection OR its own short internal timeout
   (previewLayoutWorkerClient.ts's WORKER_LAYOUT_TIMEOUT_MS) falls back to
   this file's SAME synchronous `elk.bundled.js` call every other function
   here already uses — recovery that does not depend on the worker
   mechanism ever being fixed. A signature cache in front of both paths
   means an unchanged proposal graph across a re-render never re-enters
   either path at all.

   Sizing/spacing constants (ZONE_PADDING/ZONE_HEADER_HEIGHT/zoneSameRowPackGap/
   LANE_*) now come from geometry.ts (W6b geometry fix wave) instead of
   being duplicated locally — see that module's header for why: this file,
   reconciler.ts, and nodes/ProjectGroupNode.tsx all need to agree on the
   exact same pixel grid, and duplicating the VALUES "by convention" is
   exactly how they drifted out of sync in the first place.
*/

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { FleetStage } from '../../../lib/agents/fleetStage';
import { STAGE_ORDER } from './chrome/StageRail';
import { makeRef, type MissionNodeData, type NodeRef } from './canvasTypes';
import {
  computePreviewGraphSignature,
  getOrComputeCachedPreviewLayout,
  layoutPreviewGraphViaWorker,
} from './previewLayoutWorkerClient';
import {
  LANE_COLUMN_WIDTH,
  LANE_HEADER_STRIP_HEIGHT,
  LANE_ROW_HEIGHT,
  LANE_START_X,
  ZONE_TITLE_BAND_HEIGHT,
  ZONE_HEADER_HEIGHT,
  ZONE_PADDING,
  packColumnsForZoneCount,
  zoneRowPackGap,
  zoneSameRowPackGap,
} from './geometry';
import { TRANSVERSE_PROJECT_ID, type CanvasReactFlowEdge, type CanvasReactFlowNode } from './reconciler';

const elk = new ELK();

// Fallback only matters for a node the caller built without a real
// width/height (e.g. a fixture in a unit test) — every real node already
// carries its own real `width`/`height` from the reconciler by the time
// this runs.
const FALLBACK_NODE_SIZE = { width: 220, height: 120 };

function nodeSize(node: CanvasReactFlowNode): { width: number; height: number } {
  return { width: node.width ?? FALLBACK_NODE_SIZE.width, height: node.height ?? FALLBACK_NODE_SIZE.height };
}

function childrenOfZone(nodes: readonly CanvasReactFlowNode[], zoneRef: NodeRef): CanvasReactFlowNode[] {
  return nodes.filter((n) => n.parentId === zoneRef);
}

/** Chain + hierarchy edges strictly INSIDE one zone's child set — the only
 *  edges elkjs should treat as layout constraints (a chain crossing zones
 *  has no meaning as a same-zone layered-layout hint; it stays a plain
 *  bezier drawn between two independently-positioned zones). */
function edgesWithinZone(edges: readonly CanvasReactFlowEdge[], childIds: ReadonlySet<string>): ElkExtendedEdge[] {
  return edges
    .filter((e) => (e.type === 'chain' || e.type === 'hierarchy') && childIds.has(e.source) && childIds.has(e.target))
    .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }));
}

/**
 * R13 — « breathing room »: auto-layout used to tile cards edge-to-edge
 * (nodeNode 36px, betweenLayers 70px) with no empty pane left anywhere in a
 * dense zone, so a right-click ON EMPTY CANVAS (to reach the pane's own
 * context-menu entries) had nowhere left to land once a zone filled up.
 * Widened spacing (nodeNode 56px, betweenLayers 100px, plus two NEW axes elk
 * otherwise defaults near-zero: edgeNode so a chain edge doesn't hug the
 * next card, and componentComponent so an unconnected sub-graph within the
 * same zone — e.g. two independent draft chains — gets real air between
 * them) — combined with CanvasView.tsx's new post-arrange fit-view padding
 * (~15%, see POST_ARRANGE_FIT_VIEW_OPTIONS), this is the two-part fix: more
 * space BETWEEN cards, and more space AROUND the whole arranged result.
 */
const LAYERED_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '56',
  'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.spacing.edgeNode': '32',
  'elk.spacing.componentComponent': '80',
  // fix/canvas-title-float — same small top content-inset
  // reconcilerZones.ts's gridSlotPosition uses (ZONE_HEADER_HEIGHT +
  // ZONE_TITLE_BAND_HEIGHT = 36 + 0 = 36): the zone's own title now floats
  // ABOVE the frame (ProjectGroupNode.tsx), so an elkjs auto-arrange no
  // longer needs a big reserved gap at the top — just enough padding to
  // keep a child off the frame's own top border.
  'elk.padding': `[top=${ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT},left=${ZONE_PADDING},bottom=${ZONE_PADDING},right=${ZONE_PADDING}]`,
};

export interface PreviewLayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface PreviewLayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface PreviewGraphLayout {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
  /** Ids of edges dropped BEFORE this layout ran because their `source` or
   *  `target` did not match any node in the SAME call's `nodes` list — see
   *  `layoutPreviewGraph`'s own doc comment for why elkjs must never see
   *  one of these. Optional (not `[]`) so `buildFallbackLayout`
   *  (graphProposalGraph.ts, a plain BFS with no elkjs involved) doesn't
   *  need to fabricate a value it has no opinion on. Empty/absent on the
   *  overwhelmingly common well-formed-graph path. */
  droppedEdgeIds?: string[];
}

const PREVIEW_LAYERED_OPTIONS = {
  ...LAYERED_OPTIONS,
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '52',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.componentComponent': '44',
  'elk.padding': '[top=20,left=20,bottom=20,right=20]',
};

// Founder's #1 complaint (dangling-edge preview crash), stable log prefix a
// developer can grep for — see this function's own dangling-edge guard
// below and GraphProposalCard.tsx's own failure-reason logging, which
// deliberately reuses this SAME prefix convention.
const LAYOUT_LOG_PREFIX = '[layoutPreviewGraph]';

export async function layoutPreviewGraph(
  nodes: readonly PreviewLayoutNode[],
  edges: readonly PreviewLayoutEdge[],
): Promise<PreviewGraphLayout> {
  if (nodes.length === 0) return { positions: {}, width: 0, height: 0 };

  // Dangling-edge guard (founder's #1 complaint, proven live via CDP: a
  // real 12-step plan whose repair-renamed step id and its dependent
  // step's `dependsOn` had drifted apart fed elkjs an edge referencing a
  // node id absent from `children` — elkjs's bundled JSON importer throws
  // `JsonImportException: Referenced shape does not exist` for the ENTIRE
  // graph the instant that happens, degrading a whole 12-node plan to the
  // fallback view over ONE bad edge). A malformed edge must cost you that
  // edge, never the whole layout — dropped here, reported via
  // `droppedEdgeIds` (callers/tests can assert on it) AND a single
  // console.warn (never silent). agentsStore.tsx's `actionsToExecute`
  // repair fixes this at the SOURCE for the generate_plan path; this guard
  // is the backstop for every other caller and any future regression.
  const nodeIds = new Set(nodes.map((node) => node.id));
  const validEdges: PreviewLayoutEdge[] = [];
  const droppedEdgeIds: string[] = [];
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      validEdges.push(edge);
    } else {
      droppedEdgeIds.push(edge.id);
    }
  }
  if (droppedEdgeIds.length > 0) {
    console.warn(
      LAYOUT_LOG_PREFIX,
      `dropped ${droppedEdgeIds.length} edge(s) with a missing endpoint (not laid out):`,
      droppedEdgeIds,
    );
  }

  // Signature cache (2026-08 off-main-thread rewrite, this file's own
  // header) — keyed on validEdges (post dangling-edge filter): two calls
  // that differ only in a dangling edge which gets dropped either way
  // resolve to the identical geometry, so they deliberately share one
  // cache entry rather than fragmenting into near-duplicates.
  const signature = computePreviewGraphSignature(nodes, validEdges);
  const core = await getOrComputeCachedPreviewLayout(signature, async () => {
    const graph: ElkNode = {
      id: 'plan-preview',
      layoutOptions: PREVIEW_LAYERED_OPTIONS,
      children: nodes.map((node) => ({ id: node.id, width: node.width, height: node.height })),
      edges: validEdges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    };
    // Worker path in the real app (never blocks/is-blocked-by the main
    // thread); the exact same synchronous elk.bundled.js call every other
    // function in this file uses when no Worker exists (Vitest/jsdom) —
    // see this file's header for the feature-detection rationale. The
    // worker call is ALSO wrapped in its own bounded timeout
    // (WORKER_LAYOUT_TIMEOUT_MS, previewLayoutWorkerClient.ts) — on either
    // an outright rejection (a worker crash — reproduced live, see
    // elkLayoutWorker.ts's header — or a genuine elkjs error) or that
    // internal timeout, this falls back to the SAME synchronous computation
    // used when no Worker exists at all. This is what guarantees recovery
    // independently of the worker's own health (requirement from the
    // 2026-08-01 real-app verification): even a worker that is completely
    // broken still yields a real layout, just without the off-main-thread
    // benefit for that one call.
    const result = typeof Worker === 'function'
      ? await layoutPreviewGraphViaWorker(graph).catch(async (err: unknown) => {
          console.warn(
            LAYOUT_LOG_PREFIX,
            'worker layout failed or exceeded its internal timeout — falling back to the synchronous in-thread computation:',
            err instanceof Error ? err.message : String(err),
          );
          return elk.layout(graph);
        })
      : await elk.layout(graph);
    const positions: Record<string, { x: number; y: number }> = {};
    for (const node of result.children ?? []) {
      if (!node.id) continue;
      positions[node.id] = { x: node.x ?? 0, y: node.y ?? 0 };
    }
    return { positions, width: result.width ?? 0, height: result.height ?? 0 };
  });

  return {
    ...core,
    ...(droppedEdgeIds.length > 0 ? { droppedEdgeIds } : {}),
  };
}

/** Plain node/edge shape the zone-relative ELK core needs — deliberately
 *  NOT `CanvasReactFlowNode`/`CanvasReactFlowEdge`: {@link
 *  layoutDraftGraphInZone}'s whole point is running this same computation
 *  for nodes that do not exist as reconciled canvas nodes yet (see that
 *  function's own doc comment), so the core itself must not require that
 *  shape either — `layoutZone` below is just the thinnest possible adapter
 *  from the real (already-reconciled) node/edge shape onto this one. */
interface ZoneGraphNode {
  id: string;
  width: number;
  height: number;
}

interface ZoneGraphLayout {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/**
 * Shared zone-relative ELK core — `layoutZone` (existing canvas children)
 * and `layoutDraftGraphInZone` (a plan's freshly-materialized draft/join
 * nodes, BEFORE they exist as reconciled canvas nodes at all — see that
 * function's own doc comment) both resolve to this SAME call, so there is
 * exactly one place that owns "what does elkjs's layered algorithm,
 * configured with the real zone padding/spacing (`LAYERED_OPTIONS`), do
 * with a node/edge list" — never two independently-drifting copies of that
 * elk.layout() call.
 *
 * `LAYERED_OPTIONS`'s own `elk.padding` (top=ZONE_HEADER_HEIGHT+
 * ZONE_TITLE_BAND_HEIGHT, left/right/bottom=ZONE_PADDING) means elkjs
 * itself guarantees every returned position's x/y is >= that padding —
 * this is the actual containment mechanism (not a post-hoc clamp): a
 * caller writing a returned position straight into a zone-relative child
 * position (`extent: 'parent'`) can never place a node above/left of the
 * zone's own top-left content inset, and `result.width`/`result.height`
 * (elkjs's own computed bounding box, padding included) is exactly what a
 * caller should grow the zone's frame to — never a node escaping past a
 * fixed zone size, always the zone sized to fit the graph.
 */
async function layoutGraphWithinZone(
  nodes: readonly ZoneGraphNode[],
  edges: readonly ElkExtendedEdge[],
): Promise<ZoneGraphLayout> {
  if (nodes.length === 0) return { positions: {}, width: 0, height: 0 };
  const graph: ElkNode = {
    id: 'zone-graph',
    layoutOptions: LAYERED_OPTIONS,
    children: nodes.map((node) => ({ id: node.id, width: node.width, height: node.height })),
    // elkjs's own `ElkNode.edges` field is typed as a mutable array (its
    // JSON-import path never actually mutates the array it's handed), but
    // this function's own signature deliberately keeps `edges` `readonly`
    // (both callers below pass a freshly `.map()`-built array anyway) — a
    // shallow copy here satisfies elk-api's mutable type without granting
    // elk.layout() the ability to mutate either caller's own array.
    edges: [...edges],
  };
  const result = await elk.layout(graph);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const child of result.children ?? []) {
    if (!child.id) continue;
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  }
  return { positions, width: result.width ?? 0, height: result.height ?? 0 };
}

/**
 * Layered left-to-right layout of ONE zone's children (spec §5 "elkjs
 * layered layout per zone"), respecting chain/hierarchy edges as layout
 * constraints — a mission chained to a draft renders the draft one layer
 * to its right, a loop's iteration/hierarchy children render downstream of
 * their parent. `zoneId` is the raw project id (or {@link
 * TRANSVERSE_PROJECT_ID}), resolved here to the zone's NodeRef via {@link
 * makeRef} like every other canvas module. Returns positions relative to
 * the zone (React Flow child coordinates under `extent: 'parent'`), keyed
 * by each child's own NodeRef — an empty zone (or unknown zoneId) yields
 * `{}`, never a crash.
 */
export async function layoutZone(
  nodes: readonly CanvasReactFlowNode[],
  edges: readonly CanvasReactFlowEdge[],
  zoneId: string,
): Promise<Record<NodeRef, { x: number; y: number }>> {
  const zoneRef = makeRef('project', zoneId);
  const children = childrenOfZone(nodes, zoneRef);
  if (children.length === 0) return {};

  const childIds = new Set(children.map((c) => c.id));
  const { positions } = await layoutGraphWithinZone(
    children.map((child) => ({ id: child.id, ...nodeSize(child) })),
    edgesWithinZone(edges, childIds),
  );
  return positions;
}

export interface DraftGraphNode {
  id: string;
  width: number;
  height: number;
}

export interface DraftGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface DraftGraphLayout {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
  /** Same convention as `PreviewGraphLayout.droppedEdgeIds` — see that
   *  field's own doc comment. */
  droppedEdgeIds?: string[];
}

/**
 * Zone-SAFE layout for a plan's freshly-materialized draft/join nodes —
 * called directly from the plan-preview materialization path
 * (agentsStore.tsx's `sendManagerMessage`), in the SAME synchronous turn
 * the drafts/chains/joins are created, deliberately BEFORE they exist as
 * reconciled `CanvasReactFlowNode`s.
 *
 * FIXES (defect: "un noeud de plan atterrit dans la zone d'un AUTRE
 * projet", reproduced live via CDP on an 8-step plan with two parallel
 * branches + a fan-in convergence step): that call site used to reuse
 * `layoutPreviewGraph` (the in-CHAT preview's OWN standalone elkjs layout —
 * `PREVIEW_LAYERED_OPTIONS`, no zone padding, its own top-left rooted at
 * whatever elkjs's layered algorithm happens to put its first node, with NO
 * relationship to any zone's absolute canvas position) and wrote its raw
 * coordinates directly as this turn's zone-relative draft/join positions,
 * then emitted `'canvas:arrange'` hoping a REAL zone-aware `layoutZone`
 * pass would immediately correct them. That correction is racy and, for
 * this exact call site, ALWAYS loses: `useCanvasManagerEvents.ts`'s
 * `'canvas:arrange'` handler reads `paramsRef.current.runLayoutAll`, a
 * closure over CanvasView's live `nodes`/`edges` React state that is only
 * refreshed by a passive `useEffect` — which cannot have run yet when
 * `'canvas:arrange'` is emitted synchronously, in the same turn, right
 * after `addProposalPreview` — so `layoutAll`/`layoutZone` computes
 * against the PREVIOUS render's node list, one that does not yet contain
 * ANY node this plan just created. Its returned patch has zero entries for
 * them, and `reconcilerZones.ts`'s `assignChildPositions` treats any
 * existing `canvasStore.positions` entry as pinned forever (spec §6: "an
 * existing position is NEVER changed") — so the raw, zone-unconfined
 * preview-space coordinate silently becomes that node's PERMANENT
 * position. elkjs's layered "RIGHT" direction assigns each node an x
 * proportional to its rank (longest path from a source); the fan-in
 * convergence step's rank is `max(rank of every parent) + 1` — the
 * deepest, largest-x node in the whole plan — so it is also the one most
 * likely to have an x large enough to land past ITS OWN zone's right edge
 * and into whatever zone the canvas happens to have packed next door.
 * Every single-parent node in the same plan has a smaller rank/x and, by
 * the coincidence of that zone's own size, can still happen to fall inside
 * zone bounds — exactly the "only the fan-in node is in the wrong zone"
 * pattern this defect was reported with.
 *
 * This function replaces that whole mechanism: it computes REAL,
 * zone-relative positions synchronously, in the SAME call, via {@link
 * layoutGraphWithinZone} (the exact core `layoutZone` itself uses for a
 * zone's existing children) — never depends on `'canvas:arrange'`, a later
 * render, or any bus event to become correct. Every returned position is
 * guaranteed >= the zone's own top/left content inset (see
 * `layoutGraphWithinZone`'s own doc comment), and every node/join uses its
 * REAL canvas footprint (the caller passes `DEFAULT_NODE_SIZE`/
 * `JOIN_NODE_SIZE` from reconcilerZones.ts, not the much smaller in-chat
 * preview card size `layoutPreviewGraph` used) — the SAME sizes
 * `resolveCollisions`'s own no-overlap invariant assumes elsewhere in this
 * app, so cards can never overlap on the real canvas even though they
 * never overlap in the chat's smaller preview either.
 *
 * A back-edge (e.g. a reviewer step whose retry/self-heal path loops to an
 * earlier step) makes the graph genuinely cyclic — elkjs's layered
 * algorithm runs its own cycle-breaking phase before ranking (reversing
 * one edge internally, purely for layering purposes) and still returns a
 * normal, bounded position for every node; this function adds no special
 * handling for that case because none is needed, and `layout.test.ts`
 * proves it stays contained.
 *
 * Dangling-edge guard mirrors `layoutPreviewGraph`'s own (a repair-renamed
 * step id whose `dependsOn` drifted out of sync must cost that ONE edge,
 * never crash or degrade the whole plan's layout) — `droppedEdgeIds` only
 * present when non-empty, same convention as `PreviewGraphLayout`.
 */
export async function layoutDraftGraphInZone(
  nodes: readonly DraftGraphNode[],
  edges: readonly DraftGraphEdge[],
): Promise<DraftGraphLayout> {
  if (nodes.length === 0) return { positions: {}, width: 0, height: 0 };

  const nodeIds = new Set(nodes.map((node) => node.id));
  const validEdges: DraftGraphEdge[] = [];
  const droppedEdgeIds: string[] = [];
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      validEdges.push(edge);
    } else {
      droppedEdgeIds.push(edge.id);
    }
  }
  if (droppedEdgeIds.length > 0) {
    console.warn(
      LAYOUT_LOG_PREFIX,
      `dropped ${droppedEdgeIds.length} edge(s) with a missing endpoint (not laid out):`,
      droppedEdgeIds,
    );
  }

  const core = await layoutGraphWithinZone(
    nodes,
    validEdges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  );

  return {
    ...core,
    ...(droppedEdgeIds.length > 0 ? { droppedEdgeIds } : {}),
  };
}

/** Estimated on-canvas footprint of a laid-out zone (children bbox +
 *  padding) — used only to PACK zones in {@link layoutAll}'s grid. The
 *  reconciler independently recomputes the REAL rendered zone size from
 *  positions on its very next run (reconciler.ts's own
 *  `computeBoundingBox`), so this only needs to be a reasonable
 *  non-overlapping estimate for packing math, never pixel-perfect. */
function zoneFootprint(
  childPositions: Record<NodeRef, { x: number; y: number }>,
  children: readonly CanvasReactFlowNode[],
): { width: number; height: number } {
  if (children.length === 0) return { width: 320, height: 200 };
  let maxX = 0;
  let maxY = 0;
  for (const child of children) {
    const pos = childPositions[child.id] ?? { x: 0, y: 0 };
    const size = nodeSize(child);
    maxX = Math.max(maxX, pos.x + size.width);
    maxY = Math.max(maxY, pos.y + size.height);
  }
  return { width: maxX + ZONE_PADDING, height: maxY + ZONE_HEADER_HEIGHT };
}

function zoneProjectId(node: CanvasReactFlowNode): string {
  return (node.data as { projectId: string }).projectId;
}

/** See geometry.ts's `zoneSameRowPackGap` doc comment — this zone group
 *  node's own real display name (`ProjectNodeData.name`), the same field
 *  reconcilerZones.ts's `packAutoPlacedZones` reads off its own `ZoneInput`. */
function zoneDisplayName(node: CanvasReactFlowNode): string {
  return (node.data as { name: string }).name;
}

/**
 * Full-canvas auto-layout (spec §5 "Auto-layout: elkjs layered layout per
 * zone + zone packing"; toolbar's « Ranger » button + `Ctrl+L`): every zone
 * gets {@link layoutZone}'d independently, then the ZONES themselves are
 * packed into a grid (shelf packing, {@link MAX_ZONES_PER_ROW} columns,
 * padded). The Transverse zone ({@link TRANSVERSE_PROJECT_ID}) is always
 * placed LAST regardless of where it happens to appear in `nodes` (task's
 * explicit instruction) — a freshly-materialized Transverse zone should
 * never shove real projects into a later row just because of node-array
 * ordering. Returns ONE combined position patch: every zone's own
 * (absolute) position AND every child's (zone-relative) position, ready
 * for a single `canvasStore.setPositions` call — ranging the whole canvas
 * is one undo step, not N.
 */
export async function layoutAll(
  nodes: readonly CanvasReactFlowNode[],
  edges: readonly CanvasReactFlowEdge[],
): Promise<Record<NodeRef, { x: number; y: number }>> {
  const zoneNodes = nodes.filter((n) => n.type === 'project');
  const ordered = [
    ...zoneNodes.filter((n) => zoneProjectId(n) !== TRANSVERSE_PROJECT_ID),
    ...zoneNodes.filter((n) => zoneProjectId(n) === TRANSVERSE_PROJECT_ID),
  ];

  const positions: Record<NodeRef, { x: number; y: number }> = {};
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let column = 0;
  // scratch/_canvas-label-design.md §3.3.1 — viewport-aspect-aware column
  // count (geometry.ts's `packColumnsForZoneCount`), computed once against
  // the TOTAL zone count this "Ranger" pass repacks (every zone, pinned
  // included — unlike reconcilerZones.ts's auto-only pack) — was a flat 3.
  const maxZonesPerRow = packColumnsForZoneCount(ordered.length);

  for (const zoneNode of ordered) {
    const id = zoneProjectId(zoneNode);
    const zoneRef = makeRef('project', id);
    const childPositions = await layoutZone(nodes, edges, id);
    Object.assign(positions, childPositions);

    const footprint = zoneFootprint(childPositions, childrenOfZone(nodes, zoneRef));
    positions[zoneRef] = { x: cursorX, y: cursorY };

    rowHeight = Math.max(rowHeight, footprint.height);
    column += 1;
    if (column >= maxZonesPerRow) {
      column = 0;
      cursorX = 0;
      // fix/canvas-title-float — row-to-row (vertical) advance leaves room
      // for a zone's floating title (ProjectGroupNode.tsx's `canvas-zone-
      // header`, which sits ABOVE its own frame) so it never lands on the
      // row above's own bottom edge — see geometry.ts's `zoneRowPackGap`/
      // `ZONE_VERTICAL_GAP` doc comments for the worked math (now a small
      // flat gap, not an airtight-at-the-absolute-floor one, since
      // scratch/_canvas-label-design.md §3.2 bounded the LOD compensation
      // that used to make the worst case huge).
      //
      // fix/canvas-title-full-name / P2-16 / scratch/_canvas-label-design.md
      // §3.1+§3.3.1 — same-row (horizontal) spacing uses `zoneSameRowPackGap`
      // — now a small flat constant (geometry.ts's `ZONE_PACK_HORIZONTAL_GAP_
      // FLOW_PX`): the floating title's own `maxWidth: width` + `overflow:
      // hidden` containment (ProjectGroupNode.tsx, unchanged by this design)
      // already guarantees it can never paint past its own zone's edge, so
      // the same-row gap no longer needs to be sized against the title's
      // own worst-case reach at all — a plain visual breathing gap suffices.
      cursorY += rowHeight + zoneRowPackGap();
      rowHeight = 0;
    } else {
      cursorX += footprint.width + zoneSameRowPackGap(zoneDisplayName(zoneNode));
    }
  }

  return positions;
}

// ── Lane mode (spec §4.3 "Lane mode: inside each project zone, nodes
//    magnetize into 5 vertical stage lanes"). LANE_COLUMN_WIDTH/
//    LANE_ROW_HEIGHT/LANE_START_X come from geometry.ts (LANE_START_X
//    already bakes in the gutter width + gap) — the lane/gutter column
//    width MUST equal the placement grid's cell width (not an independent
//    guess): loop/schedule (gutter occupants) and mission/draft (lane
//    occupants) all render as the SAME full-card footprint (spec
//    CRITICAL 2), so a narrower lane would let a card overflow into its
//    neighbor (spec CRITICAL 4). ─────────────────────────────────────────

function laneIndexForStage(stage: FleetStage): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? 0 : index;
}

/**
 * Lane layout for ONE zone (spec §4.3): 5 vertical stage lanes in
 * PLAN/CODE/TEST/REVUE/MERGE order ({@link STAGE_ORDER}, the SAME order
 * StageRail's metro line uses — never a second ordering). Placement rules:
 *   - a `mission` lands in the lane matching its OWN `mission.stage`
 *     (`deriveFleetStage()`'s output, embedded verbatim — never re-derived
 *     here);
 *   - a `draft` always lands in the PLAN lane (spec: "drafts→PLAN lane" —
 *     an armed-but-unlaunched spec reads naturally as "not started yet");
 *   - `loop`/`schedule` nodes go to a LEFT GUTTER column, outside every
 *     lane (spec: "loops/schedules→left gutter column" — a pipeline stage
 *     is a one-shot-mission concept a recurring trigger doesn't have);
 *   - a `note` is left untouched: absent from the returned patch, so
 *     `canvasStore.setPositions` never moves it (annotations have no
 *     stage/lane opinion).
 * Within a lane/gutter, items stack vertically sorted by NodeRef for
 * deterministic output (same input -> same layout, every time — a real
 * property this task explicitly wants proven by a unit test).
 */
export async function laneLayout(
  nodes: readonly CanvasReactFlowNode[],
  zoneId: string,
): Promise<Record<NodeRef, { x: number; y: number }>> {
  const zoneRef = makeRef('project', zoneId);
  const children = childrenOfZone(nodes, zoneRef);

  const gutter: CanvasReactFlowNode[] = [];
  const lanes: CanvasReactFlowNode[][] = STAGE_ORDER.map(() => []);

  for (const child of children) {
    if (child.type === 'loop' || child.type === 'schedule') {
      gutter.push(child);
    } else if (child.type === 'mission') {
      const stage = (child.data as MissionNodeData).mission.stage;
      lanes[laneIndexForStage(stage)]!.push(child);
    } else if (child.type === 'draft') {
      lanes[0]!.push(child);
    }
    // 'note' (and any future kind): no lane opinion, position untouched.
  }

  const positions: Record<NodeRef, { x: number; y: number }> = {};
  // Row 0 starts BELOW both the zone's own small top content-inset
  // (ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT — fix/canvas-title-float
  // shrank this to 36 + 0 = 36, now that the zone's title floats ABOVE the
  // frame instead of living inside it, see geometry.ts's ZONE_TITLE_BAND_
  // HEIGHT doc comment) and the PLAN/CODE/TEST/REVUE/MERGE column-header
  // strip ProjectGroupNode.tsx renders in lane mode (LANE_HEADER_STRIP_
  // HEIGHT) — without the second offset, row 0's cards would render flush
  // against the zone's own top edge with no room for the lane labels above
  // them (spec CRITICAL 4). Uses CELL spacing (LANE_ROW_HEIGHT ===
  // geometry.ts's GRID_CELL_HEIGHT) so a stacked full card never overlaps
  // the next row.
  const rowStartY = ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT + LANE_HEADER_STRIP_HEIGHT;
  const stackColumn = (items: readonly CanvasReactFlowNode[], x: number): void => {
    items
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((item, row) => {
        positions[item.id] = { x, y: rowStartY + row * LANE_ROW_HEIGHT };
      });
  };

  stackColumn(gutter, ZONE_PADDING);
  lanes.forEach((laneItems, index) => stackColumn(laneItems, LANE_START_X + index * LANE_COLUMN_WIDTH));

  return positions;
}
