/* layout.ts — per-node 3D position layout for the Brain Canvas.

   Ported from the design handoff prototype's neuron builder: cluster
   centers sit on a unit circle (XZ plane, radius 0.95) with a small Y
   jitter, and each node scatters +/-0.425 around its cluster center on all
   three axes.

   One deliberate deviation from the prototype: the prototype seeds a
   single incrementing PRNG while iterating its (static, demo-only) neuron
   list in a fixed order, so a node's position depends on how many nodes
   were built before it. Real app data is dynamic -- type/cluster filters
   remove and restore nodes, live refresh adds/removes notes, search
   reloads the graph -- so positions must be a pure function of the node's
   OWN id instead, or every filter toggle would visibly reshuffle the whole
   graph. Positions here are seeded per-id (via hashString), keeping the
   same distribution "recipe" (circle placement, scatter widths) but stable
   regardless of which other nodes are currently present.
*/

import { hashString } from './dateBucketing';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const CLUSTER_RADIUS = 0.95;
const CLUSTER_Y_JITTER = 0.7; // full width, matches prototype's (rnd()-0.5)*0.7
const SCATTER_WIDTH = 0.85; // full width, matches prototype's (rnd()-0.5)*0.85

/**
 * Deterministic pseudo-random generator, seeded from a 32-bit integer.
 * Same LCG constants as the design handoff prototype (Numerical Recipes
 * LCG) so the visual "grain" of the layout matches — just reseeded per-id
 * instead of driven by a single shared/incrementing counter.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Cluster center on the unit circle, indexed by the cluster's position among all clusters. */
export function clusterCenter(clusterIndex: number, clusterCount: number): Vec3 {
  const safeCount = Math.max(1, clusterCount);
  const angle = (clusterIndex / safeCount) * Math.PI * 2;
  const rng = createRng(hashString(`cluster:${clusterIndex}:${safeCount}`));
  return {
    x: Math.cos(angle) * CLUSTER_RADIUS,
    z: Math.sin(angle) * CLUSTER_RADIUS,
    y: (rng() - 0.5) * CLUSTER_Y_JITTER,
  };
}

/** Node position, scattered around its cluster center. Pure function of (nodeId, center). */
export function nodePosition(nodeId: string, center: Vec3): Vec3 {
  const rng = createRng(hashString(nodeId));
  return {
    x: center.x + (rng() - 0.5) * SCATTER_WIDTH,
    y: center.y + (rng() - 0.5) * SCATTER_WIDTH,
    z: center.z + (rng() - 0.5) * SCATTER_WIDTH,
  };
}
