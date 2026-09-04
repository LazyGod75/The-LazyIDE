/* Brain Canvas — scene construction/retinting (canvas/scene.ts), the glue
   between adapted graph data, layout, and palettes.
*/

import { describe, it, expect } from 'vitest';
import { applyPalette, buildScene } from '../components/brain/canvas/scene';
import { MOTE_COUNT } from '../components/brain/canvas/ambientField';
import { PULSE_COUNT } from '../components/brain/canvas/pulses';
import { buildDateAxis } from '../components/brain/canvas/dateBucketing';
import type { AdaptedBrainData } from '../lib/brain/brainAdapter';

function makeData(): AdaptedBrainData {
  return {
    nodes: [
      { id: 'n1', name: 'Node 1', type: 'decision', cluster: 'editor', val: 9, dateIdx: 0 },
      { id: 'n2', name: 'Node 2', type: 'bug', cluster: 'editor', val: 3, dateIdx: 7 },
      { id: 'n3', name: 'Node 3', type: 'concept', cluster: 'agents', val: 5, dateIdx: 3 },
    ],
    links: [
      { source: 'n1', target: 'n2', type: 'uses' },
      { source: 'n1', target: 'missing-node', type: 'uses' },
    ],
    clusterColor: {},
    clusterColorHex: {},
    clusterCenter: {},
    clusterStats: {},
    // Not exercised by scene construction itself — buildDateAxis([]) gives
    // a valid empty DateAxis so this fixture satisfies AdaptedBrainData.
    dateAxis: buildDateAxis([]),
  };
}

describe('canvas/scene — buildScene', () => {
  it('creates one RenderNode per AdaptedNode, preserving core fields', () => {
    const data = makeData();
    const scene = buildScene(data, 'spectre');
    expect(scene.nodes).toHaveLength(3);
    const n1 = scene.nodeById.get('n1')!;
    expect(n1.title).toBe('Node 1');
    expect(n1.cluster).toBe('editor');
    expect(n1.importance).toBe(9);
    expect(n1.dateIdx).toBe(0);
    // `source` must be the exact original AdaptedNode reference — this is
    // what onSelectNode(node.source) passes back to callers, so it has to
    // be indistinguishable from the node they handed in via `data`.
    expect(n1.source).toBe(data.nodes[0]);
  });

  it('drops dangling links (endpoint not present in the node set) and resolves the rest to direct node references', () => {
    const scene = buildScene(makeData(), 'spectre');
    expect(scene.edges).toHaveLength(1);
    expect(scene.edges[0].a.id).toBe('n1');
    expect(scene.edges[0].b.id).toBe('n2');
  });

  it('resolves node colors from the active palette (spectre matches the legacy REAL_CLUSTER_COLOR values)', () => {
    const scene = buildScene(makeData(), 'spectre');
    expect(scene.nodeById.get('n1')!.color).toBe('#9B7CFF'); // editor
    expect(scene.nodeById.get('n3')!.color).toBe('#4FC3F7'); // agents
  });

  it('marks every node as hero when the node count is well under MAX_HERO_NODES', () => {
    const scene = buildScene(makeData(), 'spectre');
    expect(scene.nodes.every((n) => n.isHero)).toBe(true);
  });

  it('initializes one cluster aggregate per distinct cluster, reset for the first frame', () => {
    const scene = buildScene(makeData(), 'spectre');
    expect(scene.clusterAggregates.size).toBe(2); // editor, agents
    const editorAgg = scene.clusterAggregates.get('editor')!;
    expect(editorAgg.count).toBe(0);
    expect(editorAgg.topY).toBe(Infinity);
  });

  it('builds a full pulse pool (16) as soon as at least one edge resolves', () => {
    const scene = buildScene(makeData(), 'spectre');
    expect(scene.pulses).toHaveLength(PULSE_COUNT);
  });

  it('builds the fixed halo mote pool', () => {
    const scene = buildScene(makeData(), 'spectre');
    expect(scene.motes).toHaveLength(MOTE_COUNT);
  });

  it('is a pure function of (data, paletteId) — same inputs, same node positions', () => {
    const data = makeData();
    const a = buildScene(data, 'spectre');
    const b = buildScene(data, 'spectre');
    expect(a.nodeById.get('n1')!.x).toBe(b.nodeById.get('n1')!.x);
    expect(a.nodeById.get('n1')!.y).toBe(b.nodeById.get('n1')!.y);
    expect(a.nodeById.get('n1')!.z).toBe(b.nodeById.get('n1')!.z);
  });

  it('keeps a node position stable regardless of which OTHER nodes are present (filter-toggle stability)', () => {
    const full = makeData();
    const filtered: AdaptedBrainData = { ...full, nodes: full.nodes.slice(0, 2), links: [] }; // drop n3 (agents)

    const fullScene = buildScene(full, 'spectre');
    const filteredScene = buildScene(filtered, 'spectre');

    const n1Full = fullScene.nodeById.get('n1')!;
    const n1Filtered = filteredScene.nodeById.get('n1')!;
    expect(n1Filtered.x).toBe(n1Full.x);
    expect(n1Filtered.y).toBe(n1Full.y);
    expect(n1Filtered.z).toBe(n1Full.z);
  });
});

describe('canvas/scene — applyPalette', () => {
  it('retints nodes and cluster aggregates in place without moving anything', () => {
    const scene = buildScene(makeData(), 'spectre');
    const before = {
      x: scene.nodeById.get('n1')!.x,
      y: scene.nodeById.get('n1')!.y,
      z: scene.nodeById.get('n1')!.z,
      nodeCount: scene.nodes.length,
    };

    applyPalette(scene, 'hologramme');

    const n1 = scene.nodeById.get('n1')!;
    expect(n1.color).toBe('#6FD0FF'); // hologramme editor slot
    expect(n1.x).toBe(before.x);
    expect(n1.y).toBe(before.y);
    expect(n1.z).toBe(before.z);
    expect(scene.nodes.length).toBe(before.nodeCount);
    expect(scene.clusterAggregates.get('editor')!.color).toBe('#6FD0FF');
  });
});
