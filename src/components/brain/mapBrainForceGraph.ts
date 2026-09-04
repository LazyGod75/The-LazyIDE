/* Maps AdaptedBrainData onto a pinned 3d-force-graph payload.

   Canvas2D layout lives in unit space (~±1.5). WebGL camera distances are
   hundreds of units, so positions are scaled then pinned (fx/fy/fz) — the
   force sim is a no-op (cooldownTime 0) and filter toggles never reshuffle
   the vault. Cluster hubs are synthetic octahedrons: they must never be
   forwarded to onSelectNode (wiki / note-meta have no such ids).
*/

import type { AdaptedBrainData, AdaptedNode } from '../../lib/brain/brainAdapter';
import { clusterDisplayLabel, clusterLayoutSlot } from '../../lib/brain/brainAdapter';
import { clampZoom } from './canvas/projection';
import { clusterCenter } from './canvas/layout';
import { buildScene } from './canvas/scene';
import type { PaletteId } from './canvas/palettes';

export const LAYOUT_SCALE = 110;
/** Same high angle as the Night Signal demo — further back so arrival is a vault. */
export const VAULT = { x: 280, y: 760, z: 900 };
export const VAULT_ARRIVE = { x: 380, y: 980, z: 1160 };
/** Default Brain zoom: further out than 1 so the vault reads on first paint. */
export const DEFAULT_BRAIN_ZOOM = 0.55;
export const PARTICLE_NODE_CAP = 120;
export const HUB_ID_PREFIX = 'hub:';

export type ForceMass = 'hub' | 'core';
export type ForceRel = 'synapse' | 'spoke';

export interface ForceBody {
  id: string;
  name: string;
  cluster: string;
  kind: string;
  val: number;
  color: string;
  dateIdx: number;
  mass: ForceMass;
  fx: number;
  fy: number;
  fz: number;
  /** Present on core neurons only — forwarded to onSelectNode. */
  source?: AdaptedNode;
}

export interface ForceLink {
  source: string;
  target: string;
  rel: ForceRel;
}

export interface ForceGraphPayload {
  nodes: ForceBody[];
  links: ForceLink[];
}

export function hubId(cluster: string): string {
  return `${HUB_ID_PREFIX}${cluster}`;
}

export function isHubId(id: string): boolean {
  return id.startsWith(HUB_ID_PREFIX);
}

/** Camera position for a given zoom. At DEFAULT_BRAIN_ZOOM this is `base` unchanged. */
export function cameraForZoom(
  zoom: number,
  base: { x: number; y: number; z: number } = VAULT,
): { x: number; y: number; z: number } {
  const k = DEFAULT_BRAIN_ZOOM / clampZoom(zoom);
  return { x: base.x * k, y: base.y * k, z: base.z * k };
}

/** Inverse of cameraForZoom — maps an orbit camera position back to HUD zoom. */
export function zoomFromCamera(
  pos: { x: number; y: number; z: number },
  base: { x: number; y: number; z: number } = VAULT,
): number {
  const hyp = Math.hypot(pos.x, pos.y, pos.z);
  const baseHyp = Math.hypot(base.x, base.y, base.z) || 1;
  return clampZoom(DEFAULT_BRAIN_ZOOM / (hyp / baseHyp || 1));
}

export function forceGraphPayloadKey(data: AdaptedBrainData, paletteId: PaletteId): string {
  return [
    paletteId,
    data.nodes.map((n) => `${n.id}:${n.cluster}:${n.val}:${n.dateIdx}`).join(','),
    data.links.map((l) => `${l.source}->${l.target}`).join(','),
  ].join('\0');
}

export function mapAdaptedToForceGraph(
  data: AdaptedBrainData,
  paletteId: PaletteId,
): ForceGraphPayload {
  const scene = buildScene(data, paletteId);
  const nodes: ForceBody[] = scene.nodes.map((n) => ({
    id: n.id,
    name: n.title,
    cluster: n.cluster,
    kind: n.source.type,
    val: n.isHero ? 8 : Math.max(2, n.importance * 0.7),
    color: n.color,
    dateIdx: n.dateIdx,
    mass: 'core',
    fx: n.x * LAYOUT_SCALE,
    fy: n.y * LAYOUT_SCALE,
    fz: n.z * LAYOUT_SCALE,
    source: n.source,
  }));

  const clusters = Array.from(scene.clusterAggregates.keys());
  for (const cluster of clusters) {
    const { index, total } = clusterLayoutSlot(cluster);
    const center = clusterCenter(index, total);
    const sample = scene.nodes.find((n) => n.cluster === cluster);
    nodes.push({
      id: hubId(cluster),
      name: clusterDisplayLabel(cluster).toUpperCase(),
      cluster,
      kind: 'cluster',
      val: 12,
      color: sample?.color ?? scene.clusterAggregates.get(cluster)?.color ?? '#888888',
      dateIdx: 0,
      mass: 'hub',
      fx: center.x * LAYOUT_SCALE,
      fy: center.y * LAYOUT_SCALE,
      fz: center.z * LAYOUT_SCALE,
    });
  }

  const links: ForceLink[] = [];
  for (const edge of scene.edges) {
    links.push({ source: edge.a.id, target: edge.b.id, rel: 'synapse' });
  }
  for (const n of scene.nodes) {
    links.push({ source: n.id, target: hubId(n.cluster), rel: 'spoke' });
  }

  return { nodes, links };
}
