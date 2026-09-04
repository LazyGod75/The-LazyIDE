/* scene.ts — builds/retints the Brain Canvas render Scene from adapted
   graph data. Pure with respect to its inputs (data, paletteId): the same
   pair always produces the same node positions, hero assignment and
   colors, regardless of what was rendered before or which other nodes are
   currently filtered in/out (see layout.ts and brainAdapter's
   clusterLayoutSlot for why that stability matters).
*/

import type { AdaptedBrainData } from '../../../lib/brain/brainAdapter';
import { clusterLayoutSlot, resolveClusterColors } from '../../../lib/brain/brainAdapter';
import type { PaletteId } from './palettes';
import { hashString } from './dateBucketing';
import { clusterCenter, nodePosition } from './layout';
import { buildPulses } from './pulses';
import { buildMotes } from './ambientField';
import { MAX_HERO_NODES } from './draw';
import type { ClusterAggregate, RenderEdge, RenderNode, Scene } from './types';

const FALLBACK_COLOR = '#888888';

function computeBreathePhase(id: string): number {
  return ((hashString(id) % 1000) / 1000) * Math.PI * 2;
}

/**
 * Builds a fresh render Scene from adapted graph data + the active
 * palette. Call this when the node/edge set changes (new data, filters
 * toggled, live refresh) — for a palette-only change use `applyPalette`
 * instead, which re-tints in place without relaying out positions.
 */
export function buildScene(data: AdaptedBrainData, paletteId: PaletteId): Scene {
  const clusters = Array.from(new Set(data.nodes.map((n) => n.cluster))).sort();
  const clusterColors = resolveClusterColors(paletteId, clusters);

  // Top-N by importance get full bloom rendering; the long tail still
  // renders (cheap dot) and stays clickable — see MAX_HERO_NODES in draw.ts.
  const byImportance = [...data.nodes].sort((a, b) => b.val - a.val || a.id.localeCompare(b.id));
  const heroIds = new Set(byImportance.slice(0, MAX_HERO_NODES).map((n) => n.id));

  const nodes: RenderNode[] = data.nodes.map((n) => {
    const { index, total } = clusterLayoutSlot(n.cluster);
    const center = clusterCenter(index, total);
    const pos = nodePosition(n.id, center);
    return {
      id: n.id,
      title: n.name,
      cluster: n.cluster,
      importance: n.val,
      dateIdx: n.dateIdx,
      color: clusterColors[n.cluster] ?? FALLBACK_COLOR,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      isHero: heroIds.has(n.id),
      breathePhase: computeBreathePhase(n.id),
      source: n,
      // per-frame mutable projection state — populated by the render loop
      sx: 0,
      sy: 0,
      z2: 0,
      persp: 0,
      fade: 0,
      r: 0,
      visible: true,
      reveal: 1,
      fire: 0,
    };
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges: RenderEdge[] = [];
  for (const link of data.links) {
    const a = nodeById.get(link.source);
    const b = nodeById.get(link.target);
    if (a && b) edges.push({ a, b });
  }

  const clusterAggregates = new Map<string, ClusterAggregate>();
  for (const cluster of clusters) {
    clusterAggregates.set(cluster, {
      clusterId: cluster,
      color: clusterColors[cluster] ?? FALLBACK_COLOR,
      sumX: 0,
      count: 0,
      topY: Infinity,
    });
  }

  return {
    nodes,
    order: nodes.slice(),
    edges,
    nodeById,
    pulses: buildPulses(edges.length),
    motes: buildMotes(),
    clusterAggregates,
  };
}

/** Re-tints an existing scene's nodes + cluster aggregates in place — no relayout, no scene rebuild. */
export function applyPalette(scene: Scene, paletteId: PaletteId): void {
  const clusters = Array.from(scene.clusterAggregates.keys());
  const colors = resolveClusterColors(paletteId, clusters);
  for (const node of scene.nodes) {
    node.color = colors[node.cluster] ?? node.color;
  }
  for (const agg of scene.clusterAggregates.values()) {
    agg.color = colors[agg.clusterId] ?? agg.color;
  }
}
