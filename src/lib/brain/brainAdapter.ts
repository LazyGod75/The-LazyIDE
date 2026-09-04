/* brainAdapter.ts — maps BrainGraphData to the shape BrainGraph3D +
   BrainWiki expect (BrainNode / BrainLink / cluster config).

   Product path: getRealBrainData(platform.brain.graph()).
   getMockBrainData() remains a test fixture only (brainAdapter.test,
   mapBrainForceGraph.test) — never served as the user's vault.
*/

import type { BrainGraphData, BrainGraphNode, BrainNoteMeta } from '../platform/types.js';
import type {
  BrainNode,
  BrainLink,
  ClusterId,
  NodeType,
  WikiPayload,
} from '../mock/brain.js';
import {
  NODES as MOCK_NODES,
  LINKS as MOCK_LINKS,
  CLUSTER_COLOR,
  CLUSTER_COLOR_HEX,
  CLUSTER_CENTER,
  CLUSTER_STATS,
  WIKI_DATA,
} from '../mock/brain.js';
import { assignDateBuckets, buildDateAxis, hashString } from '../../components/brain/canvas/dateBucketing.js';
import type { DateAxis } from '../../components/brain/canvas/dateBucketing.js';
import { PALETTES, type PaletteId } from '../../components/brain/canvas/palettes.js';
import { basenameOf, looksLikeFsPath } from './projectId.js';

export type { DateAxis };

export type { PaletteId };

/** Matches useI18n()'s own `t` signature. Optional on every function below
 *  that accepts it — when omitted, those functions fall back to the exact
 *  hardcoded French they always returned (kept for brainAdapter.test.ts,
 *  which asserts those literal strings and is not itself locale-aware).
 *  Real callers (BrainSpace.tsx, WikiTab.tsx) pass the live `t` so the
 *  returned text follows the active locale instead of always being
 *  French. */
type TFunc = (key: string, params?: Record<string, string | number>) => string;

// ── Real cluster palette (IDE clusters) ───────────────────────────
//
// When running under Tauri the real topics are: editor, agents, brain, tauri, models, unknown
// We map these to the same CSS colors / hex values used by Three.js.

const REAL_CLUSTER_COLOR: Record<string, string> = {
  editor:  '#9B7CFF', // violet (same as Auth in mock)
  agents:  '#4FC3F7', // cyan   (same as Paiement)
  brain:   '#66E27A', // green  (same as Tests)
  tauri:   '#FFC76B', // amber  (same as Infra)
  models:  '#FF7BB0', // pink   (same as UI)
  topical: '#F472B6', // rose — topical space (data-cerveau-space=topical)
  unknown: '#888888',
};

const REAL_CLUSTER_COLOR_HEX: Record<string, number> = {
  editor:  0x9B7CFF,
  agents:  0x4FC3F7,
  brain:   0x66E27A,
  tauri:   0xFFC76B,
  models:  0xFF7BB0,
  topical: 0xF472B6,
  unknown: 0x888888,
};

const REAL_CLUSTER_CENTER: Record<string, { x: number; y: number; z: number }> = {
  editor:  { x: -260, y:  90, z:  60  },
  agents:  { x:  220, y: 120, z: -100 },
  brain:   { x:   30, y: -200, z: 160 },
  tauri:   { x: -130, y: -130, z: -210 },
  models:  { x:  260, y:  -50, z:  140 },
  topical: { x:    0, y:  200, z:   80 },
  unknown: { x:    0, y:    0, z:    0 },
};

const REAL_CLUSTER_STATS: Record<string, string> = {
  editor:  'cluster editor',
  agents:  'cluster agents',
  brain:   'cluster brain',
  tauri:   'cluster tauri',
  models:  'cluster models',
  topical: 'topical notes (data-cerveau-space=topical)',
  unknown: 'cluster unknown',
};

// ── Palette-aware cluster colors (Brain Canvas) ───────────────────
//
// REAL_CLUSTER_COLOR above is exactly the "Spectre" (default) palette.
// The 3 additional palettes (hologramme/neon/aurore, see canvas/palettes.ts
// for their exact swatch arrays) reuse the same 5 semantic slots — one per
// real IDE cluster (editor/agents/brain/tauri/models), which line up
// index-for-index with the legacy mock clusters (Auth/Paiement/Tests/
// Infra/UI). `topical`/`unknown` stay constant across every palette (same
// rose/grey BrainWiki already hardcodes for its own, unrelated, cluster
// color chip) so they remain recognizable regardless of the active palette.

const REAL_CLUSTER_ORDER = ['editor', 'agents', 'brain', 'tauri', 'models', 'topical', 'unknown'] as const;
const MOCK_CLUSTER_ORDER = ['Auth', 'Paiement', 'Tests', 'Infra', 'UI'] as const;
/** Maps 1:1 onto each palette's 5-color array — editor/Auth share slot 0, agents/Paiement slot 1, etc. */
const PALETTE_SLOT_ORDER = ['editor', 'agents', 'brain', 'tauri', 'models'] as const;
const TOPICAL_COLOR = '#F472B6';
const UNKNOWN_COLOR = '#888888';
/**
 * Fixed ring size for cluster names outside the known real/mock sets —
 * keeps their layout angle stable regardless of which other clusters are
 * currently loaded. Real brains that have scanned several external
 * projects (see AddProjectToBrainWizard) can easily carry a few dozen such
 * "unknown" cluster ids — one per scanned project root — so this needs
 * more headroom than the original demo-era value of 12: at 12 slots,
 * anything past ~8-10 distinct fallback clusters starts colliding into the
 * same ring position (birthday-paradox territory), piling their nodes AND
 * their labels on top of each other on screen. 32 pushes that collision
 * point out much further while keeping the same "stable regardless of
 * which other clusters are loaded" guarantee (still a pure function of the
 * cluster id alone).
 */
const FALLBACK_LAYOUT_SLOTS = 32;

function paletteSlotIndex(clusterId: string): number {
  const paletteIdx = (PALETTE_SLOT_ORDER as readonly string[]).indexOf(clusterId);
  if (paletteIdx >= 0) return paletteIdx;
  return (MOCK_CLUSTER_ORDER as readonly string[]).indexOf(clusterId);
}

/**
 * Resolves every given cluster id to a color from the active palette.
 * Identical output to REAL_CLUSTER_COLOR/CLUSTER_COLOR when paletteId is
 * 'spectre' (the default) — this is purely additive, no existing consumer
 * of those constants is affected.
 */
export function resolveClusterColors(paletteId: PaletteId, clusters: readonly string[]): Record<string, string> {
  const swatches = PALETTES[paletteId].colors;
  const out: Record<string, string> = {};
  let fallbackCounter = 0;
  for (const cluster of clusters) {
    if (cluster === 'topical') { out[cluster] = TOPICAL_COLOR; continue; }
    if (cluster === 'unknown') { out[cluster] = UNKNOWN_COLOR; continue; }
    const slot = paletteSlotIndex(cluster);
    if (slot >= 0) { out[cluster] = swatches[slot % swatches.length]; continue; }
    out[cluster] = swatches[fallbackCounter % swatches.length];
    fallbackCounter += 1;
  }
  return out;
}

/**
 * Stable (index, total) layout slot for a cluster's position on the Brain
 * Canvas's cluster circle (see canvas/layout.ts's clusterCenter). Real and
 * mock clusters each get their own evenly-spaced ring; unrecognized names
 * fall back to a stable hash-based slot. Crucially this never depends on
 * *which other clusters are currently present* (e.g. after a type/cluster
 * filter toggle) — only on the cluster's own name — so filtering never
 * reshuffles cluster positions on screen.
 */
export function clusterLayoutSlot(clusterId: string): { index: number; total: number } {
  const realIdx = (REAL_CLUSTER_ORDER as readonly string[]).indexOf(clusterId);
  if (realIdx >= 0) return { index: realIdx, total: REAL_CLUSTER_ORDER.length };
  const mockIdx = (MOCK_CLUSTER_ORDER as readonly string[]).indexOf(clusterId);
  if (mockIdx >= 0) return { index: mockIdx, total: MOCK_CLUSTER_ORDER.length };
  return { index: hashString(clusterId) % FALLBACK_LAYOUT_SLOTS, total: FALLBACK_LAYOUT_SLOTS };
}

/**
 * Human-readable label for a cluster id, for anywhere the UI shows a
 * cluster to a person (canvas cluster labels, the left-rail filter chips
 * and legend — see BrainControls.tsx and canvas/draw.ts).
 *
 * Known real/mock clusters (editor/agents/brain/tauri/models/topical/
 * unknown, and the legacy mock Auth/Paiement/... set) are already short,
 * semantic names and pass through unchanged. Anything else may be a raw
 * absolute filesystem path: a project added via "Add project to brain"
 * (AddProjectToBrainWizard) carries its project root as the cluster id, so
 * without this the UI would render something like
 * `C:\Users\david\projects\debounce` verbatim (and, in the canvas label,
 * uppercased on top of that) — unreadable, and it leaks the user's full
 * directory tree for no benefit. This returns just the last path segment
 * (the project folder's own name) instead.
 *
 * In practice `getRealBrainData` below already canonicalizes every node's
 * cluster id to this same basename before this function ever sees it (see
 * `canonicalizeClusterId`), so this is mostly a defensive no-op for real
 * data now — it stays exported/used because other cluster-id sources
 * (WikiTab's makeNode, the mock dataset) do not go through that adapter.
 */
export function clusterDisplayLabel(clusterId: string): string {
  return basenameOf(clusterId);
}

/**
 * Canonicalizes a raw cluster id so the SAME project never produces two
 * distinct cluster ids depending on how it was indexed — e.g. a project
 * seen both as the short name "lazy-backoffice" (from a topic tag) and as
 * its full path "C:\Users\...\lazy-backoffice" (from "Add project to
 * brain") used to appear as two separate, visually-identical filter chips
 * and legend entries (see BrainControls.tsx — both `displayClusters` and
 * the legend map over `clusters`, i.e. Object.keys(clusterStats), with no
 * de-dup). Applying this BEFORE building clusterSet/clusterStats/node.cluster
 * in getRealBrainData merges the two representations into one cluster from
 * the start, so node counts, colors, layout, and filter chips are all
 * unified rather than being fixed up cosmetically after the fact.
 */
function canonicalizeClusterId(raw: string): string {
  if (raw === 'topical' || raw === 'unknown') return raw;
  return looksLikeFsPath(raw) ? basenameOf(raw) : raw;
}

// ── Adapted graph types ────────────────────────────────────────────

/** Extended BrainNode that may use string ids (for real data). */
export interface AdaptedNode {
  /** String id (numeric ids for mock, slug ids for real). */
  id: string;
  name: string;
  type: NodeType;
  cluster: string;
  val: number;
  /** Time-travel bucket (0-7) — see canvas/dateBucketing.ts for how it's derived. */
  dateIdx: number;
  /** Present when the node comes from a multi-brain merged graph. */
  sourceProject?: string;
  /** True when the note was tagged with data-cerveau-space='topical'. */
  isTopical?: boolean;
  /** Topic slug from data-cerveau-topic (if present). */
  topic?: string;
  /** ISO-ish creation timestamp from the source graph payload (if present). */
  created?: string | null;
}

export interface AdaptedLink {
  source: string;
  target: string;
  type: string;
}

export interface AdaptedBrainData {
  nodes: AdaptedNode[];
  links: AdaptedLink[];
  clusterColor: Record<string, string>;
  clusterColorHex: Record<string, number>;
  clusterCenter: Record<string, { x: number; y: number; z: number }>;
  clusterStats: Record<string, string>;
  /** Real-date context for the time-travel scrubber — see canvas/dateBucketing.ts's buildDateAxis. */
  dateAxis: DateAxis;
}

// ── Mock data adapter ──────────────────────────────────────────────

export function getMockBrainData(): AdaptedBrainData {
  // Mock nodes carry no timestamp — assignDateBuckets falls back to a
  // stable per-id hash, spreading the demo dataset deterministically
  // across all 8 time-travel buckets (see canvas/dateBucketing.ts).
  const dateInputs = MOCK_NODES.map((n) => ({ id: String(n.id) }));
  const dateBuckets = assignDateBuckets(dateInputs);
  return {
    nodes: MOCK_NODES.map((n: BrainNode) => ({
      id: String(n.id),
      name: n.name,
      type: n.type,
      cluster: n.cluster,
      val: n.val,
      dateIdx: dateBuckets.get(String(n.id)) ?? 0,
    })),
    links: MOCK_LINKS.map((l: BrainLink) => ({
      source: String(l.source),
      target: String(l.target),
      type: l.type,
    })),
    clusterColor:    CLUSTER_COLOR as Record<string, string>,
    clusterColorHex: CLUSTER_COLOR_HEX as Record<string, number>,
    clusterCenter:   CLUSTER_CENTER as Record<string, { x: number; y: number; z: number }>,
    clusterStats:    CLUSTER_STATS as Record<string, string>,
    // hasRealDates: false — the demo's 8-bucket spread stays hash-based,
    // exactly as before; the TimelineScrubber shows generic slice labels.
    dateAxis: buildDateAxis(dateInputs),
  };
}

// ── Real data adapter ──────────────────────────────────────────────

function importanceToVal(importance: number): number {
  // Map 0–1 importance to 1–10 val scale
  return Math.max(1, Math.min(10, Math.round(importance * 10)));
}

function mapNodeType(raw: string): NodeType {
  const valid: NodeType[] = ['decision', 'bug', 'file', 'concept', 'module'];
  if (valid.includes(raw as NodeType)) return raw as NodeType;
  return 'concept';
}

/** Resolves a graph node's canonical visual cluster id — topical notes get
    their own cluster, everything else falls back through canonicalizeClusterId
    so a project seen under two raw representations (short name vs full
    path) always lands in the same cluster. */
function nodeClusterId(n: Pick<BrainGraphNode, 'space' | 'cluster'>): string {
  if (n.space === 'topical') return 'topical';
  return canonicalizeClusterId(n.cluster || 'unknown');
}

export function getRealBrainData(data: BrainGraphData, t?: TFunc): AdaptedBrainData {
  // Collect all unique cluster labels (topical space gets its own visual cluster)
  const clusterSet = new Set<string>();
  for (const n of data.nodes) {
    clusterSet.add(nodeClusterId(n));
  }

  // The bulk graph endpoint (BrainGraphNode) now carries each note's real
  // `created` timestamp (engine/src/server/routes/graph.ts) — nodes with a
  // parseable one are bucketed by true chronology; assignDateBuckets still
  // falls back to a stable per-id hash for the rest (older cached payloads,
  // notes with no recorded date) — see canvas/dateBucketing.ts.
  const dateInputs = data.nodes.map((n) => ({ id: n.id, createdAt: n.created }));
  const dateBuckets = assignDateBuckets(dateInputs);
  const dateAxis = buildDateAxis(dateInputs);

  const nodes: AdaptedNode[] = data.nodes.map((n: BrainGraphNode) => ({
    id: n.id,
    name: n.title,
    type: mapNodeType(n.type),
    // Topical notes land in their own visual cluster for easy distinction
    cluster: nodeClusterId(n),
    val: importanceToVal(n.importance),
    dateIdx: dateBuckets.get(n.id) ?? 0,
    ...(n.sourceProject !== undefined ? { sourceProject: n.sourceProject } : {}),
    ...(n.space === 'topical' ? { isTopical: true } : {}),
    ...(n.topic !== undefined ? { topic: n.topic } : {}),
    ...(n.created !== undefined ? { created: n.created } : {}),
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));
  const links: AdaptedLink[] = data.edges
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
    }));

  // Build per-cluster config (use known colors for known clusters, fallback for others)
  const clusterColor: Record<string, string> = {};
  const clusterColorHex: Record<string, number> = {};
  const clusterCenter: Record<string, { x: number; y: number; z: number }> = {};
  const clusterStats: Record<string, string> = {};

  const clusterCounts = new Map<string, number>();
  for (const n of nodes) {
    clusterCounts.set(n.cluster, (clusterCounts.get(n.cluster) ?? 0) + 1);
  }

  for (const cluster of clusterSet) {
    clusterColor[cluster]    = REAL_CLUSTER_COLOR[cluster]    ?? REAL_CLUSTER_COLOR.unknown;
    clusterColorHex[cluster] = REAL_CLUSTER_COLOR_HEX[cluster] ?? REAL_CLUSTER_COLOR_HEX.unknown;
    clusterCenter[cluster]   = REAL_CLUSTER_CENTER[cluster]   ?? REAL_CLUSTER_CENTER.unknown;
    const count = clusterCounts.get(cluster) ?? 0;
    clusterStats[cluster]    = REAL_CLUSTER_STATS[cluster]
      ? (t ? t('brain.wiki.neuronsWithStat', { count, stat: REAL_CLUSTER_STATS[cluster] }) : `${count} neurones · ${REAL_CLUSTER_STATS[cluster]}`)
      : (t ? t('brain.wiki.neuronsInCluster', { count }) : `${count} neurones dans ce cluster`);
  }

  return { nodes, links, clusterColor, clusterColorHex, clusterCenter, clusterStats, dateAxis };
}

// ── Wiki payload builder for real notes ───────────────────────────

export function buildWikiPayloadFromMeta(meta: BrainNoteMeta, t?: TFunc): WikiPayload {
  const tags = meta.tags
    ? meta.tags.split(/\s+/).filter(Boolean).map((t) => `#${t.replace(/^#/, '')}`)
    : [`#${meta.topic ?? 'misc'}`];

  // WIKI METADATA MISMATCH FIX: reuse the SAME mapped type used for the
  // `type` field below (the pill BrainWiki renders) so the body text never
  // contradicts the pill — previously this interpolated the RAW meta.type
  // (e.g. "episodic"), which could show "concept" on the pill but
  // "episodic" in the body for the exact same node.
  //
  // Also: label meta.topic as "topic", not "cluster" — BrainWiki's cluster
  // box always renders the node's REAL graph cluster (AdaptedNode.cluster,
  // derived separately via deriveCluster()/getRealBrainData in this same
  // file), a different field this function has no access to (it only
  // receives BrainNoteMeta, fetched independently from
  // /_api/note-meta/:id). Calling meta.topic "cluster" here made the body
  // text assert a cluster value that could — and did — visibly disagree
  // with the cluster box shown right below it for the same node.
  const displayType = mapNodeType(meta.type);

  return {
    title: meta.title,
    type: displayType,
    status: 'active',
    meta: `${meta.topic ?? 'brain'} · ${meta.created ? meta.created.slice(0, 10) : '2026'}`,
    tags,
    body: meta.topic
      ? (t ? t('brain.wiki.neuronBody', { type: displayType, topic: meta.topic }) : `Neurone de type ${displayType} · topic ${meta.topic}.`)
      : (t ? t('brain.wiki.neuronBodyNoTopic', { type: displayType }) : `Neurone de type ${displayType}.`),
    links: [],
    files: [],
    validity: meta.created
      ? (t ? t('brain.wiki.createdActive', { date: meta.created.slice(0, 10) }) : `Créé le ${meta.created.slice(0, 10)} · actif`)
      : (t ? t('brain.wiki.active') : 'Actif'),
    cluster: (meta.topic ?? 'unknown') as ClusterId,
    // Contradiction-detection signal — surfaced by BrainWiki as a warning
    // linking to the note(s) this one contradicts. Defaults keep older
    // engine responses (no such fields) rendering exactly as before.
    conflictWith: meta.conflictWith ?? [],
    saliencyKind: meta.saliencyKind ?? null,
    ...(meta.created ? { when: meta.created.slice(0, 10) } : {}),
  };
}

// ── Re-export mock accessors for wiki fallback ────────────────────

export { WIKI_DATA };
