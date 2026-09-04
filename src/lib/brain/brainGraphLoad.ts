/* brainGraphLoad — fetch + adapt the 3D vault graph.
   Extracted from BrainSpace so the space's loadGraphData callback stays a
   thin cancel/commit wrapper (complexity ~3) instead of a nested web /
   Tauri / HTTP-fallback tree. Each helper below is kept under the
   complexity/max-lines ratchet in eslint.config.js. */

import { buildDateAxis } from '../../components/brain/canvas/dateBucketing';
import type { AdaptedBrainData } from './brainAdapter';
import { getRealBrainData } from './brainAdapter';
import { withTimeout } from './withTimeout';
import { firstNonNull } from './firstNonNull';
import { getBrainConnection } from '../platform/tauri';
import type { BrainGraphData } from '../platform/types';

type TFunc = (key: string, params?: Record<string, string | number>) => string;

export type BrainGraphScope = 'project' | 'all';
export type BrainGraphStatus = 'live';

export type BrainGraphLoadOk = {
  ok: true;
  adapted: AdaptedBrainData;
  status: BrainGraphStatus;
};
export type BrainGraphLoadFail = { ok: false };
export type BrainGraphLoadResult = BrainGraphLoadOk | BrainGraphLoadFail;

export interface BrainGraphPlatform {
  brain: {
    graph: () => Promise<BrainGraphData>;
    graphAll: () => Promise<BrainGraphData>;
  };
}

export interface BrainGraphLoadOpts {
  isTauri: boolean;
  scope: BrainGraphScope;
  platform: BrainGraphPlatform;
  t?: TFunc;
  sidecarTimeoutMs: number;
  fetchWebGraph?: () => Promise<Response>;
  getConnection?: () => Promise<{ port: number; token: string }>;
  fetchSidecarGraph?: (port: number, token: string) => Promise<Response>;
}

interface RawSidecarNode {
  id: string;
  title: string;
  type: string | null;
  topic: string | null;
  importance: number;
  cluster?: string;
  created?: string | null;
}

interface RawSidecarEdge {
  from: string;
  to: string;
  type: string;
}

export function emptyAdaptedBrain(): AdaptedBrainData {
  return {
    nodes: [],
    links: [],
    clusterColor: {},
    clusterColorHex: {},
    clusterCenter: {},
    clusterStats: {},
    dateAxis: buildDateAxis([]),
  };
}

export function deriveClusterFromId(id: string): string {
  for (const prefix of ['editor', 'agents', 'brain', 'tauri', 'models']) {
    if (id.includes(prefix)) return prefix;
  }
  return 'unknown';
}

function clusterFromTopicOrId(node: RawSidecarNode): string {
  if (node.topic) return node.topic.split('/')[0].toLowerCase();
  return deriveClusterFromId(node.id);
}

/** Map the sidecar `/_api/graph` JSON (from/to edges) to BrainGraphData.
    `preferExplicitCluster` matches the historic web path, which honours a
    payload `cluster` field when present; the Tauri HTTP fallback always
    derived cluster from topic/id. */
export function mapSidecarGraphPayload(
  raw: { nodes: RawSidecarNode[]; edges: RawSidecarEdge[] },
  preferExplicitCluster: boolean,
): BrainGraphData {
  return {
    nodes: raw.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type ?? 'concept',
      cluster: preferExplicitCluster
        ? (n.cluster ?? clusterFromTopicOrId(n))
        : clusterFromTopicOrId(n),
      importance: n.importance ?? 0.5,
      created: n.created ?? null,
    })),
    edges: raw.edges.map((e) => ({
      source: e.from,
      target: e.to,
      type: e.type,
    })),
  };
}

function ok(adapted: AdaptedBrainData, status: BrainGraphStatus): BrainGraphLoadOk {
  return { ok: true, adapted, status };
}

async function parseSidecarResponse(
  res: Response,
  preferExplicitCluster: boolean,
): Promise<BrainGraphData> {
  if (!res.ok) throw new Error(`graph status ${res.status}`);
  const raw = await res.json() as { nodes: RawSidecarNode[]; edges: RawSidecarEdge[] };
  return mapSidecarGraphPayload(raw, preferExplicitCluster);
}

async function loadWebBrainGraph(opts: BrainGraphLoadOpts): Promise<BrainGraphLoadResult> {
  const fetchGraph = opts.fetchWebGraph ?? (() => fetch('/_api/graph'));
  try {
    const graphData = await parseSidecarResponse(await fetchGraph(), true);
    return ok(getRealBrainData(graphData, opts.t), 'live');
  } catch (err) {
    console.warn('[BrainSpace] /_api/graph fetch failed, trying platform.brain.graph():', err);
  }
  try {
    const graphData = await opts.platform.brain.graph();
    return ok(getRealBrainData(graphData, opts.t), 'live');
  } catch (err) {
    console.warn('[BrainSpace] platform.brain.graph() also failed:', err);
  }
  return { ok: false };
}

async function loadTauriHttpFallback(opts: BrainGraphLoadOpts): Promise<BrainGraphData | null> {
  const getConnection = opts.getConnection ?? getBrainConnection;
  const fetchSidecar = opts.fetchSidecarGraph ?? ((port, token) =>
    fetch(`http://127.0.0.1:${port}/_api/graph`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
  try {
    const { port, token } = await getConnection();
    const res = await withTimeout(
      fetchSidecar(port, token),
      opts.sidecarTimeoutMs,
      'sidecar /_api/graph fetch',
    );
    return await parseSidecarResponse(res, false);
  } catch {
    return null;
  }
}

async function invokeTauriGraph(opts: BrainGraphLoadOpts): Promise<BrainGraphData | null> {
  try {
    const graphPromise = opts.scope === 'all'
      ? opts.platform.brain.graphAll()
      : opts.platform.brain.graph();
    const label = opts.scope === 'all' ? 'brain.graphAll()' : 'brain.graph()';
    return await withTimeout(graphPromise, opts.sidecarTimeoutMs, label);
  } catch {
    return null;
  }
}

async function loadTauriBrainGraph(opts: BrainGraphLoadOpts): Promise<BrainGraphLoadResult> {
  const invokeJob = invokeTauriGraph(opts);
  if (opts.scope !== 'project') {
    const graphData = await invokeJob;
    if (!graphData) return { ok: false };
    return ok(getRealBrainData(graphData, opts.t), 'live');
  }
  // Race invoke vs HTTP: a hanging IPC must not block a live sidecar
  // (measured Tauri QA: sidecar ready on :37990 while the overlay still
  // said "Connecting…" for the full sequential timeout).
  const graphData = await firstNonNull([invokeJob, loadTauriHttpFallback(opts)]);
  if (!graphData) return { ok: false };
  return ok(getRealBrainData(graphData, opts.t), 'live');
}

export async function loadAdaptedBrainGraph(opts: BrainGraphLoadOpts): Promise<BrainGraphLoadResult> {
  if (!opts.isTauri) return loadWebBrainGraph(opts);
  return loadTauriBrainGraph(opts);
}
